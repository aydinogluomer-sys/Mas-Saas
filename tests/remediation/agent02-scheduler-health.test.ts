import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ||=
    "postgresql://unit_test_no_connect:x@127.0.0.1:5432/mas_radar_unit_dummy";
});

const mockProbePoolRef = vi.hoisted(() => ({
  current: null as Pick<Pool, "query"> | null,
}));

vi.mock("@/lib/db", () => ({
  getRawPool: vi.fn(() => mockProbePoolRef.current),
  getPool: vi.fn(() => mockProbePoolRef.current),
}));

import { readExpectedSchemaManifest } from "@/lib/db/schema-parity";
import { GET as getHealth } from "@/app/health/route";
import { GET as getReady } from "@/app/ready/route";
// Preload worker maintenance sub-modules during Vitest's module import phase so cold Vite transform
// on Windows never eats into the strict 5s per-test execution budget.
import "@/lib/audit";
import "@/lib/cashflow/engine";
import "@/lib/collections/promises-engine";
import "@/lib/controls/engine";
import "@/lib/home/overview-snapshot";
import "@/lib/importers/v2/async-runner";
import "@/lib/integrations/engine";
import "@/lib/integrations/parasut/sync-pipeline";
import "@/lib/ledger/posting-engine";
import "@/lib/radar/engine";
import "@/lib/reminders/engine";
import "@/lib/reminders/outbox";
import "@/lib/reports/engine";
import {
  MAINTENANCE_ADVISORY_LOCK_KEY_1,
  MAINTENANCE_ADVISORY_LOCK_KEY_2,
  readWorkerScheduleState,
  runScheduledMaintenance,
  writeWorkerScheduleStateAtomic,
} from "../../scripts/ops/background-worker";

const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  mockProbePoolRef.current = null;
  delete process.env.MAS_WORKER_STATE_PATH;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

type MaintenancePoolMode = "healthy" | "hourly_outage" | "daily_outage" | "lock_outage";

function createControllableMaintenancePool(initialMode: MaintenancePoolMode = "healthy") {
  let mode: MaintenancePoolMode = initialMode;
  let heldSessionId: number | null = null;
  let nextSessionId = 1;
  let workDelayMs = 0;
  let scheduleExecutions = 0;
  let dailyAuditExecutions = 0;
  const advisoryHistory: Array<{ op: "lock" | "unlock"; sessionId: number; acquired?: boolean }> =
    [];

  const makeConnRefused = () =>
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });

  const executeOnSession = async (sessionId: number, rawSql: string, params: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

    if (
      sql.startsWith("set statement_timeout") ||
      sql.startsWith("reset statement_timeout") ||
      sql.startsWith("set local statement_timeout") ||
      sql === "begin" ||
      sql === "commit" ||
      sql === "rollback" ||
      sql.startsWith("savepoint ") ||
      sql.startsWith("release savepoint ") ||
      sql.startsWith("rollback to savepoint ")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("pg_try_advisory_lock")) {
      expect(sql).toContain(
        `pg_try_advisory_lock(${MAINTENANCE_ADVISORY_LOCK_KEY_1}, ${MAINTENANCE_ADVISORY_LOCK_KEY_2})`,
      );
      if (mode === "lock_outage") {
        throw makeConnRefused();
      }
      if (heldSessionId !== null) {
        advisoryHistory.push({ op: "lock", sessionId, acquired: false });
        return { rows: [{ acquired: false, pg_try_advisory_lock: false }], rowCount: 1 };
      }
      heldSessionId = sessionId;
      advisoryHistory.push({ op: "lock", sessionId, acquired: true });
      return { rows: [{ acquired: true, pg_try_advisory_lock: true }], rowCount: 1 };
    }

    if (sql.includes("pg_advisory_unlock")) {
      expect(sql).toContain(
        `pg_advisory_unlock(${MAINTENANCE_ADVISORY_LOCK_KEY_1}, ${MAINTENANCE_ADVISORY_LOCK_KEY_2})`,
      );
      const unlockedSameSession = heldSessionId === sessionId;
      if (unlockedSameSession) {
        heldSessionId = null;
      }
      advisoryHistory.push({ op: "unlock", sessionId, acquired: unlockedSameSession });
      return { rows: [{ pg_advisory_unlock: unlockedSameSession }], rowCount: 1 };
    }

    if (workDelayMs > 0 && sql.includes("from public.reminders")) {
      await new Promise((resolve) => setTimeout(resolve, workDelayMs));
    }

    if (mode === "hourly_outage") {
      if (
        sql.includes("public.reminders") ||
        sql.includes("public.reminder_deliveries") ||
        sql.includes("public.notification_outbox")
      ) {
        throw makeConnRefused();
      }
    }

    if (mode === "daily_outage") {
      if (
        sql.includes("public.payments") ||
        sql.includes("public.loan_installments") ||
        sql.includes("public.payment_instances") ||
        sql.includes("public.promise_to_pay") ||
        sql.includes("public.control_dashboard") ||
        sql.includes("public.reports") ||
        sql.includes("public.forecast_snapshots_13w")
      ) {
        throw makeConnRefused();
      }
    }

    if (sql.includes("from public.reminders") && sql.startsWith("select")) {
      scheduleExecutions += 1;
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("from public.reports where report_type = 'daily'")) {
      const dateParam = String(params[0] ?? "2026-11-18");
      return { rows: [{ id: `rep-daily-${dateParam}` }], rowCount: 1 };
    }

    if (sql.includes("from public.forecast_snapshots_13w")) {
      const weekStart = String(params[0] ?? "2026-11-16");
      return {
        rows: [{ id: `snap-13w-${weekStart}`, as_of_date: "2026-11-18" }],
        rowCount: 1,
      };
    }

    if (sql.startsWith("insert into public.audit_logs")) {
      if (params[1] === "background_daily_maintenance") {
        dailyAuditExecutions += 1;
      }
      return { rows: [{ id: "audit-1" }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  // Includes `totalCount` so `background-worker.ts` exercises the real `pg.Pool` session-client
  // checkout path (`createMaintenancePool` + session-bound `lockClient`).
  const pool = {
    totalCount: 2,
    async connect() {
      const sessionId = nextSessionId++;
      return {
        async query(sql: string, params?: unknown[]) {
          return executeOnSession(sessionId, sql, params);
        },
        release() {
          // Real pg.Pool keeps backend session alive in pool; session lock must be explicitly unlocked.
        },
      };
    },
    async query(sql: string, params?: unknown[]) {
      const sessionId = nextSessionId++;
      return executeOnSession(sessionId, sql, params);
    },
  } as unknown as Pool;

  return {
    pool,
    setMode(next: MaintenancePoolMode) {
      mode = next;
    },
    setWorkDelayMs(ms: number) {
      workDelayMs = ms;
    },
    getHeldSessionId() {
      return heldSessionId;
    },
    getStats() {
      return {
        scheduleExecutions,
        dailyAuditExecutions,
        advisoryHistory: [...advisoryHistory],
      };
    },
  };
}

describe("AGENT 02 — Scheduler Reliability, PostgreSQL Advisory Lock & Probe Readiness", () => {
  it("reads legacy 3-field state safely and stamps full heartbeat + success metadata on healthy maintenance", async () => {
    const dir = createTempDir("mas-agent02-healthy-");
    const statePath = path.join(dir, "background-worker-state.json");

    // Legacy 3-field JSON without heartbeat/batch fields
    writeFileSync(
      statePath,
      JSON.stringify({
        lastHourlySlot: "2026-11-17T23",
        lastDailyDate: "2026-11-17",
        updatedAt: "2026-11-17T20:00:00.000Z",
      }),
      "utf8",
    );

    const legacyLoaded = await readWorkerScheduleState(statePath);
    expect(legacyLoaded).toEqual({
      lastHourlySlot: "2026-11-17T23",
      lastDailyDate: "2026-11-17",
      updatedAt: "2026-11-17T20:00:00.000Z",
      lastHeartbeatAt: null,
      lastHourlySuccessAt: null,
      lastDailySuccessAt: null,
      lastBatchStatus: null,
      lastCorrelationId: null,
    });

    const harness = createControllableMaintenancePool("healthy");
    const summary = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T09",
      correlationId: "corr-agent02-healthy-001",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(summary.hourlyRan).toBe(true);
    expect(summary.dailyRan).toBe(true);
    expect(summary.details?.batchStatus).toBe("ok");
    expect(harness.getHeldSessionId()).toBeNull();

    const saved = await readWorkerScheduleState(statePath);
    expect(saved.lastHourlySlot).toBe("2026-11-18T09");
    expect(saved.lastDailyDate).toBe("2026-11-18");
    expect(saved.lastBatchStatus).toBe("ok");
    expect(saved.lastCorrelationId).toBe("corr-agent02-healthy-001");
    expect(typeof saved.lastHeartbeatAt).toBe("string");
    expect(typeof saved.lastHourlySuccessAt).toBe("string");
    expect(typeof saved.lastDailySuccessAt).toBe("string");

    // Verify lock + unlock occurred on the exact same session client
    const { advisoryHistory } = harness.getStats();
    expect(advisoryHistory).toHaveLength(2);
    expect(advisoryHistory[0]).toEqual({ op: "lock", sessionId: 1, acquired: true });
    expect(advisoryHistory[1]).toEqual({ op: "unlock", sessionId: 1, acquired: true });

    // Re-running in the same hour/date without `force` is idempotent no-op
    const repeat = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T09",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });
    expect(repeat).toEqual({
      hourlyRan: false,
      dailyRan: false,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T09",
    });
  });

  it("leaves lastHourlySlot unchanged (partial_failure) on hourly ECONNREFUSED and recovers cleanly on next run", async () => {
    const dir = createTempDir("mas-agent02-hourly-outage-");
    const statePath = path.join(dir, "background-worker-state.json");

    await writeWorkerScheduleStateAtomic(statePath, {
      lastHourlySlot: "2026-11-18T13",
      lastDailyDate: "2026-11-18",
      updatedAt: "2026-11-18T10:00:00.000Z",
      lastHourlySuccessAt: "2026-11-18T10:00:00.000Z",
      lastDailySuccessAt: "2026-11-18T06:00:00.000Z",
      lastBatchStatus: "ok",
    });

    const harness = createControllableMaintenancePool("hourly_outage");

    const failedRun = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(failedRun.hourlyRan).toBe(false);
    expect(failedRun.dailyRan).toBe(false);
    expect(failedRun.details?.batchStatus).toBe("partial_failure");
    expect(harness.getHeldSessionId()).toBeNull();

    const afterFailure = await readWorkerScheduleState(statePath);
    expect(afterFailure.lastHourlySlot).toBe("2026-11-18T13");
    expect(afterFailure.lastHourlySuccessAt).toBe("2026-11-18T10:00:00.000Z");
    expect(afterFailure.lastBatchStatus).toBe("partial_failure");
    expect(typeof afterFailure.lastHeartbeatAt).toBe("string");

    // Restore DB: next run in the SAME hourSlot retries automatically and stamps 2026-11-18T14
    harness.setMode("healthy");
    const recoveredRun = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(recoveredRun.hourlyRan).toBe(true);
    expect(recoveredRun.details?.batchStatus).toBe("ok");

    const afterRecovery = await readWorkerScheduleState(statePath);
    expect(afterRecovery.lastHourlySlot).toBe("2026-11-18T14");
    expect(afterRecovery.lastBatchStatus).toBe("ok");
    expect(afterRecovery.lastHourlySuccessAt).not.toBe("2026-11-18T10:00:00.000Z");
  });

  it("leaves lastDailyDate unchanged (partial_failure) on daily or pre-lock ECONNREFUSED and recovers cleanly when DB returns", async () => {
    const dir = createTempDir("mas-agent02-daily-outage-");
    const statePath = path.join(dir, "background-worker-state.json");

    await writeWorkerScheduleStateAtomic(statePath, {
      lastHourlySlot: "2026-11-18T14",
      lastDailyDate: "2026-11-17",
      updatedAt: "2026-11-17T21:00:00.000Z",
      lastDailySuccessAt: "2026-11-17T21:00:00.000Z",
      lastBatchStatus: "ok",
    });

    const harness = createControllableMaintenancePool("daily_outage");

    // 1. Mid-batch daily DB outage
    const midOutage = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(midOutage.dailyRan).toBe(false);
    expect(midOutage.details?.batchStatus).toBe("partial_failure");

    const afterMidOutage = await readWorkerScheduleState(statePath);
    expect(afterMidOutage.lastDailyDate).toBe("2026-11-17");
    expect(afterMidOutage.lastDailySuccessAt).toBe("2026-11-17T21:00:00.000Z");
    expect(afterMidOutage.lastBatchStatus).toBe("partial_failure");

    // 2. Total DB connection outage before advisory lock
    harness.setMode("lock_outage");
    const preLockOutage = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(preLockOutage.dailyRan).toBe(false);
    expect(preLockOutage.details?.batchStatus).toBe("partial_failure");
    expect((await readWorkerScheduleState(statePath)).lastDailyDate).toBe("2026-11-17");

    // 3. DB restored -> retries daily maintenance for 2026-11-18 and succeeds
    harness.setMode("healthy");
    const recovered = await runScheduledMaintenance({
      pool: harness.pool,
      systemActorId: SYSTEM_ACTOR_ID,
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    });

    expect(recovered.dailyRan).toBe(true);
    expect(recovered.details?.batchStatus).toBe("ok");

    const afterRecovery = await readWorkerScheduleState(statePath);
    expect(afterRecovery.lastDailyDate).toBe("2026-11-18");
    expect(afterRecovery.lastBatchStatus).toBe("ok");
    expect(afterRecovery.lastDailySuccessAt).not.toBe("2026-11-17T21:00:00.000Z");
  });

  it("blocks concurrent runScheduledMaintenance via pg_try_advisory_lock without duplicating work or mutating contender statePath", async () => {
    const dir = createTempDir("mas-agent02-advisory-lock-");
    const leaderStatePath = path.join(dir, "leader-state.json");
    const contenderStatePath = path.join(dir, "contender-state.json");

    await writeWorkerScheduleStateAtomic(contenderStatePath, {
      lastHourlySlot: "2026-11-18T08",
      lastDailyDate: "2026-11-17",
      updatedAt: "2026-11-18T05:00:00.000Z",
      lastBatchStatus: "ok",
    });
    const contenderBefore = await readWorkerScheduleState(contenderStatePath);

    const harness = createControllableMaintenancePool("healthy");
    harness.setWorkDelayMs(50);

    const [leaderRes, contenderRes] = await Promise.all([
      runScheduledMaintenance({
        pool: harness.pool,
        systemActorId: SYSTEM_ACTOR_ID,
        statePath: leaderStatePath,
        todayISO: "2026-11-18",
        hourSlot: "2026-11-18T09",
        enableTcmbSync: false,
        enableMorningBriefingDispatch: false,
      }),
      new Promise<Awaited<ReturnType<typeof runScheduledMaintenance>>>((resolve, reject) => {
        setTimeout(() => {
          runScheduledMaintenance({
            pool: harness.pool,
            systemActorId: SYSTEM_ACTOR_ID,
            statePath: contenderStatePath,
            todayISO: "2026-11-18",
            hourSlot: "2026-11-18T09",
            enableTcmbSync: false,
            enableMorningBriefingDispatch: false,
          }).then(resolve, reject);
        }, 10);
      }),
    ]);

    expect(leaderRes.hourlyRan).toBe(true);
    expect(leaderRes.dailyRan).toBe(true);
    expect(contenderRes).toEqual({
      hourlyRan: false,
      dailyRan: false,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T09",
      details: { skippedReason: "concurrent_lock_held" },
    });

    // Maintenance executed strictly ONCE across both concurrent invocations
    const stats = harness.getStats();
    expect(stats.scheduleExecutions).toBe(1);
    expect(stats.dailyAuditExecutions).toBe(1);
    expect(harness.getHeldSessionId()).toBeNull();

    // Contender statePath was NOT mutated when skipped due to concurrent_lock_held
    const contenderAfter = await readWorkerScheduleState(contenderStatePath);
    expect(contenderAfter).toEqual(contenderBefore);
  });

  it("distinguishes /ready process liveness (200) from /health dependency readiness (200 vs 503 on DB outage, unsafe role, or schema drift) without leaking secrets", async () => {
    const dir = createTempDir("mas-agent02-health-");
    const statePath = path.join(dir, "background-worker-state.json");
    process.env.MAS_WORKER_STATE_PATH = statePath;

    const manifest = readExpectedSchemaManifest();
    expect(manifest.expectedCount).toBeGreaterThan(100);

    // 1. Healthy DB + least-privilege role + aligned schema + fresh worker heartbeat
    const nowISO = new Date().toISOString();
    await writeWorkerScheduleStateAtomic(statePath, {
      lastHourlySlot: "2026-11-18T14",
      lastDailyDate: "2026-11-18",
      updatedAt: nowISO,
      lastHeartbeatAt: nowISO,
      lastBatchStatus: "ok",
    });

    mockProbePoolRef.current = {
      query: (async (sql: string) => {
        if (sql.includes("from pg_roles")) {
          return {
            rows: [
              {
                current_user: "mas_radar_app",
                session_user: "mas_radar_app",
                rolsuper: false,
                rolbypassrls: false,
              },
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            {
              migration_count: manifest.expectedCount,
              latest_version: manifest.expectedLatestVersion,
              checksum_digest: "aligned-digest",
              last_applied_at: nowISO,
            },
          ],
          rowCount: 1,
        };
      }) as Pool["query"],
    };

    const readyResOk = await getReady(
      new Request("http://localhost/ready", { headers: { "x-request-id": "probe-ready-12345" } }),
    );
    expect(readyResOk.status).toBe(200);
    expect(readyResOk.headers.get("x-request-id")).toBe("probe-ready-12345");
    const readyBodyOk = await readyResOk.json();
    expect(readyBodyOk.status).toBe("ready");

    const healthResOk = await getHealth();
    expect(healthResOk.status).toBe(200);
    expect(healthResOk.headers.get("x-request-id")).toBeTruthy();
    const healthBodyOk = await healthResOk.json();
    expect(healthBodyOk.status).toBe("ok");
    expect(healthBodyOk.db).toBe("up");
    expect(healthBodyOk.checks.runtimeRoleSafe).toBe(true);
    expect(healthBodyOk.checks.schemaParity.aligned).toBe(true);
    expect(healthBodyOk.checks.workerHeartbeatFresh).toBe(true);
    expect(healthBodyOk.checks.lastBatchStatus).toBe("ok");

    // 2. DB outage with sensitive credentials in PG error -> /ready stays 200, /health returns 503 with zero secret leakage
    await writeWorkerScheduleStateAtomic(statePath, {
      lastHourlySlot: "2026-11-18T13",
      lastDailyDate: "2026-11-18",
      updatedAt: nowISO,
      lastHeartbeatAt: nowISO,
      lastBatchStatus: "partial_failure",
    });

    mockProbePoolRef.current = {
      query: (async () => {
        throw new Error(
          "connect ECONNREFUSED 127.0.0.1:5432 password=UltraSecretDbPass_998877!",
        );
      }) as Pool["query"],
    };

    const readyDuringOutage = await getReady(new Request("http://localhost/ready"));
    expect(readyDuringOutage.status).toBe(200);

    const healthDuringOutage = await getHealth();
    expect(healthDuringOutage.status).toBe(503);
    const outageJson = await healthDuringOutage.json();
    expect(outageJson.status).toBe("degraded");
    expect(outageJson.db).toBe("down");
    expect(outageJson.checks.lastBatchStatus).toBe("partial_failure");
    expect(JSON.stringify(outageJson)).not.toContain("UltraSecretDbPass_998877");
    expect(JSON.stringify(outageJson)).not.toContain("ECONNREFUSED");

    // 3. Schema drift (115/0115 vs expected manifest) -> /ready stays 200, /health returns 503
    mockProbePoolRef.current = {
      query: (async (sql: string) => {
        if (sql.includes("from pg_roles")) {
          return {
            rows: [
              {
                current_user: "mas_radar_app",
                session_user: "mas_radar_app",
                rolsuper: false,
                rolbypassrls: false,
              },
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            {
              migration_count: 115,
              latest_version: "0115",
              checksum_digest: "drifted-digest",
              last_applied_at: "2026-11-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      }) as Pool["query"],
    };

    const healthSchemaDrift = await getHealth();
    expect(healthSchemaDrift.status).toBe(503);
    const driftJson = await healthSchemaDrift.json();
    expect(driftJson.db).toBe("up");
    expect(driftJson.checks.runtimeRoleSafe).toBe(true);
    expect(driftJson.checks.schemaParity.aligned).toBe(false);
    expect(driftJson.checks.schemaParity.actualCount).toBe(115);
    expect(driftJson.checks.schemaParity.actualLatestVersion).toBe("0115");

    // 4. Unsafe runtime role (rolbypassrls = true) -> /health returns 503
    mockProbePoolRef.current = {
      query: (async (sql: string) => {
        if (sql.includes("from pg_roles")) {
          return {
            rows: [
              {
                current_user: "postgres",
                session_user: "postgres",
                rolsuper: true,
                rolbypassrls: true,
              },
            ],
            rowCount: 1,
          };
        }
        return {
          rows: [
            {
              migration_count: manifest.expectedCount,
              latest_version: manifest.expectedLatestVersion,
              checksum_digest: "aligned-digest",
              last_applied_at: nowISO,
            },
          ],
          rowCount: 1,
        };
      }) as Pool["query"],
    };

    const healthUnsafeRole = await getHealth();
    expect(healthUnsafeRole.status).toBe(503);
    const unsafeRoleJson = await healthUnsafeRole.json();
    expect(unsafeRoleJson.checks.runtimeRoleSafe).toBe(false);
  });
});
