// Readiness/dependency health probe. Confirms PostgreSQL connectivity, least-privilege runtime role
// (`!rolsuper && !rolbypassrls`), schema migration parity (`get_schema_ledger_summary`), and
// optional background-worker heartbeat freshness + batch status visibility.
// Deliberately paired with `/ready` (pure process-liveness 200 probe):
// - `/ready`  -> process liveness ("is the Node process responsive?") -> always 200
// - `/health` -> dependency readiness ("is DB reachable, role safe, and schema aligned?") -> 200 or 503
// Faz 40 (A2) / Faz 62: Never leaks raw PG driver / network error messages or secrets in the body.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { NextResponse } from "next/server";
import { CORRELATION_HEADER, newCorrelationId } from "@/lib/correlation";
import * as dbModule from "@/lib/db";
import {
  checkSchemaParity,
  readExpectedSchemaManifest,
  type SchemaParityResult,
} from "@/lib/db/schema-parity";

export const dynamic = "force-dynamic";

const WORKER_HEARTBEAT_MAX_AGE_MS = 90 * 60 * 1000; // hourly maintenance slot + 30 min grace

interface WorkerHealthDiagnostics {
  workerHeartbeatFresh: boolean | null;
  lastBatchStatus: "ok" | "partial_failure" | null;
}

function resolveProbePool(): Pick<Pool, "query"> | null {
  const mod = dbModule as {
    getRawPool?: () => Pick<Pool, "query">;
    getPool?: () => Pick<Pool, "query">;
  };
  try {
    if (typeof mod.getRawPool === "function") {
      const raw = mod.getRawPool();
      if (raw && typeof raw.query === "function") return raw;
    }
  } catch {
    // Fallback to getPool when unit tests partially mock `@/lib/db` without `getRawPool`.
  }
  try {
    if (typeof mod.getPool === "function") {
      const pooled = mod.getPool();
      if (pooled && typeof pooled.query === "function") return pooled;
    }
  } catch {
    // Pool unavailable
  }
  return null;
}

async function readWorkerDiagnostics(): Promise<WorkerHealthDiagnostics> {
  const configuredPath = process.env.MAS_WORKER_STATE_PATH?.trim();
  const statePath =
    configuredPath && configuredPath.length > 0
      ? path.resolve(configuredPath)
      : path.join(process.cwd(), ".runtime", "background-worker-state.json");

  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as {
      lastHeartbeatAt?: unknown;
      updatedAt?: unknown;
      lastBatchStatus?: unknown;
    };

    const lastBatchStatus: "ok" | "partial_failure" | null =
      parsed.lastBatchStatus === "ok" || parsed.lastBatchStatus === "partial_failure"
        ? parsed.lastBatchStatus
        : null;

    const heartbeatCandidate =
      typeof parsed.lastHeartbeatAt === "string" && parsed.lastHeartbeatAt.trim() !== ""
        ? parsed.lastHeartbeatAt
        : typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() !== ""
          ? parsed.updatedAt
          : null;

    if (!heartbeatCandidate) {
      return { workerHeartbeatFresh: false, lastBatchStatus };
    }
    const heartbeatMs = Date.parse(heartbeatCandidate);
    if (Number.isNaN(heartbeatMs)) {
      return { workerHeartbeatFresh: false, lastBatchStatus };
    }
    return {
      workerHeartbeatFresh: Date.now() - heartbeatMs <= WORKER_HEARTBEAT_MAX_AGE_MS,
      lastBatchStatus,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { workerHeartbeatFresh: null, lastBatchStatus: null };
    }
    return { workerHeartbeatFresh: false, lastBatchStatus: null };
  }
}

export async function GET() {
  const startedAt = Date.now();
  const requestId = newCorrelationId();
  const probePool = resolveProbePool();

  let db: "up" | "down" = "down";
  let runtimeRoleSafe = false;

  const fallbackManifest = () => {
    const { expectedCount, expectedLatestVersion } = readExpectedSchemaManifest();
    const fallbackParity: SchemaParityResult = {
      aligned: false,
      expectedCount,
      expectedLatestVersion,
      actualCount: null,
      actualLatestVersion: null,
      checksumDigest: null,
      lastAppliedAt: null,
      error: null,
    };
    return fallbackParity;
  };

  const [roleOutcome, schemaParity, workerDiag] = await Promise.all([
    probePool
      ? probePool
          .query<{
            current_user: string;
            session_user: string;
            rolsuper: boolean | null;
            rolbypassrls: boolean | null;
          }>(
            `select current_user,
                    session_user,
                    r.rolsuper,
                    r.rolbypassrls
               from pg_roles r
              where r.rolname = session_user`,
          )
          .then((res) => ({ ok: true as const, row: res.rows?.[0] ?? null }))
          .catch(() => ({ ok: false as const, row: null }))
      : Promise.resolve({ ok: false as const, row: null }),
    probePool ? checkSchemaParity(probePool) : Promise.resolve(fallbackManifest()),
    readWorkerDiagnostics(),
  ]);

  if (roleOutcome.ok && roleOutcome.row) {
    db = "up";
    runtimeRoleSafe =
      roleOutcome.row.rolsuper === false &&
      roleOutcome.row.rolbypassrls === false;
  }

  const healthy = db === "up" && runtimeRoleSafe && schemaParity.aligned;

  const body = {
    status: healthy ? "ok" : "degraded",
    probe: "readiness",
    app: "up",
    db,
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
    checks: {
      db,
      runtimeRoleSafe,
      schemaParity: {
        aligned: schemaParity.aligned,
        expectedLatestVersion: schemaParity.expectedLatestVersion,
        actualLatestVersion: schemaParity.actualLatestVersion,
        actualCount: schemaParity.actualCount,
        expectedCount: schemaParity.expectedCount,
      },
      workerHeartbeatFresh: workerDiag.workerHeartbeatFresh,
      lastBatchStatus: workerDiag.lastBatchStatus,
    },
  };

  return NextResponse.json(body, {
    status: healthy ? 200 : 503,
    headers: {
      [CORRELATION_HEADER]: requestId,
      "Cache-Control": "no-store",
    },
  });
}
