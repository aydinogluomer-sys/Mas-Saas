// Readiness/dependency health probe. Confirms PostgreSQL connectivity, least-privilege runtime role
// (`mas_radar_app`, `!rolsuper && !rolbypassrls`), schema migration parity (`get_schema_ledger_summary`),
// fail-closed `UNKNOWN` / `DEGRADED` telemetry state, and background-worker heartbeat/batch diagnostics.
// Deliberately paired with `/ready` (pure process-liveness 200 probe):
// - `/ready`  -> process liveness ("is the Node process responsive?") -> always 200
// - `/health` -> dependency readiness ("is DB reachable, role safe, and schema aligned?") -> 200 or 503
// Faz 40 (A2) / Faz 62 / V2 Hardening (RG-13): Never leaks raw PG driver / network error messages,
// role names, or secrets in the unauthenticated response body.
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
import {
  isUnreadableTelemetryValue,
  ledgerAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";

export const dynamic = "force-dynamic";

export type HealthTelemetryState = "OK" | "DEGRADED" | "UNKNOWN";

const WORKER_HEARTBEAT_MAX_AGE_MS = 90 * 60 * 1000; // hourly maintenance slot + 30 min grace

interface WorkerHealthDiagnostics {
  workerHeartbeatFresh: boolean | null;
  lastBatchStatus: "ok" | "partial_failure" | null;
  workerTelemetryState: HealthTelemetryState;
  corrupt: boolean;
}

function isConnectionLevelError(rawErr: string | null | undefined): boolean {
  if (!rawErr) return false;
  return /(?:econnrefused|econnreset|etimedout|epipe|enotfound|eai_again|connection terminated|terminating connection)/i.test(
    rawErr,
  );
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
    const candidate = JSON.parse(raw) as unknown;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return {
        workerHeartbeatFresh: false,
        lastBatchStatus: null,
        workerTelemetryState: "UNKNOWN",
        corrupt: true,
      };
    }

    const parsed = candidate as {
      lastHeartbeatAt?: unknown;
      updatedAt?: unknown;
      lastBatchStatus?: unknown;
    };

    const rawBatchStatus = parsed.lastBatchStatus;
    if (
      rawBatchStatus !== undefined &&
      rawBatchStatus !== null &&
      rawBatchStatus !== "ok" &&
      rawBatchStatus !== "partial_failure"
    ) {
      return {
        workerHeartbeatFresh: false,
        lastBatchStatus: null,
        workerTelemetryState: "UNKNOWN",
        corrupt: true,
      };
    }

    const lastBatchStatus: "ok" | "partial_failure" | null =
      rawBatchStatus === "ok" || rawBatchStatus === "partial_failure" ? rawBatchStatus : null;

    const rawHeartbeatField =
      parsed.lastHeartbeatAt !== undefined && parsed.lastHeartbeatAt !== null
        ? parsed.lastHeartbeatAt
        : parsed.updatedAt;

    if (rawHeartbeatField === undefined || rawHeartbeatField === null) {
      return {
        workerHeartbeatFresh: false,
        lastBatchStatus,
        workerTelemetryState: "UNKNOWN",
        corrupt: false,
      };
    }

    if (typeof rawHeartbeatField !== "string" || isUnreadableTelemetryValue(rawHeartbeatField)) {
      return {
        workerHeartbeatFresh: false,
        lastBatchStatus,
        workerTelemetryState: "UNKNOWN",
        corrupt: true,
      };
    }

    const heartbeatMs = Date.parse(rawHeartbeatField);
    if (Number.isNaN(heartbeatMs)) {
      return {
        workerHeartbeatFresh: false,
        lastBatchStatus,
        workerTelemetryState: "UNKNOWN",
        corrupt: true,
      };
    }

    const fresh = Date.now() - heartbeatMs <= WORKER_HEARTBEAT_MAX_AGE_MS;
    const workerTelemetryState: HealthTelemetryState =
      !fresh || lastBatchStatus === "partial_failure" ? "DEGRADED" : "OK";

    return {
      workerHeartbeatFresh: fresh,
      lastBatchStatus,
      workerTelemetryState,
      corrupt: false,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        workerHeartbeatFresh: null,
        lastBatchStatus: null,
        workerTelemetryState: "UNKNOWN",
        corrupt: false,
      };
    }
    return {
      workerHeartbeatFresh: false,
      lastBatchStatus: null,
      workerTelemetryState: "UNKNOWN",
      corrupt: true,
    };
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

  const schemaConnDown = isConnectionLevelError(schemaParity.error);

  if (roleOutcome.ok && roleOutcome.row && !schemaConnDown) {
    db = "up";
    runtimeRoleSafe =
      roleOutcome.row.rolsuper === false &&
      roleOutcome.row.rolbypassrls === false &&
      !runtimeIdentityAlert(roleOutcome.row.session_user) &&
      !runtimeIdentityAlert(roleOutcome.row.current_user);
  }

  const expectedLedgerLabel =
    schemaParity.expectedCount > 0 && schemaParity.expectedLatestVersion !== "?"
      ? `${schemaParity.expectedCount}/${schemaParity.expectedLatestVersion}`
      : "?";
  const actualLedgerLabel =
    schemaParity.actualCount !== null &&
    schemaParity.actualLatestVersion !== null &&
    !isUnreadableTelemetryValue(schemaParity.actualLatestVersion)
      ? `${schemaParity.actualCount}/${schemaParity.actualLatestVersion}`
      : "?";
  const schemaLedgerAlert = ledgerAlert(actualLedgerLabel, expectedLedgerLabel);

  const telemetryUnknown =
    db === "down" ||
    !roleOutcome.ok ||
    !roleOutcome.row ||
    schemaParity.actualCount === null ||
    schemaParity.expectedCount <= 0 ||
    isUnreadableTelemetryValue(actualLedgerLabel) ||
    isUnreadableTelemetryValue(expectedLedgerLabel) ||
    workerDiag.corrupt;

  const healthy =
    !telemetryUnknown &&
    db === "up" &&
    runtimeRoleSafe &&
    schemaParity.aligned &&
    !schemaLedgerAlert;

  const telemetryState: HealthTelemetryState = telemetryUnknown
    ? "UNKNOWN"
    : healthy
      ? "OK"
      : "DEGRADED";

  const body = {
    status: healthy ? "ok" : "degraded",
    telemetryState,
    probe: "readiness",
    app: "up",
    db,
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
    checks: {
      db,
      telemetryState,
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
      workerTelemetryState: workerDiag.workerTelemetryState,
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
