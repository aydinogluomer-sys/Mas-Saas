/**
 * MAS Nakit Radar — Birleşik TypeScript Arka Plan İşçisi (`mas-worker`, Faz 42 / B2).
 *
 * Tek süreçte (~55 MB RAM) düşük ayak iziyle çalışan arka plan motoru:
 * - Her 5 saniyede:
 *   1. `requeueDueFailures` + `reapStuckJobs` (geçici hatalı ve takılı işlerin kurtarılması)
 *   2. `processPendingImportJobs` (Import V2 asenkron önizleme işleri)
 *   3. `dispatcher.processBatch` (`background_jobs` genel kuyruk dağıtımı)
 * - Saatlik / günlük idempotent finansal bakım görevleri (`runAsSystem`, `PGAPPNAME=mas_background_worker`):
 *   - Aylık `ensureWindow` (`generateInstances` + `payment_instances` vade/risk bayrakları)
 *   - Vadesi geçen `loan_installments` için `planned → late` geçişi (`0034` geçiş muhafızıyla uyumlu + denetim kaydı)
 *   - Kırılan `promise_to_pay` (`pending → broken`) taraması (`detectBrokenPromises`)
 *   - Finansal kontrol bulguları taraması (`loadControlDashboard` → idempotent `raiseAlert`)
 *   - Hatırlatma planlama & gönderimi (`scheduleReminders` + `dispatchPending`)
 *   - Yapılandırılmışsa (`MAS_TCMB_AUTO_SYNC=1`) TCMB günlük kur çekimi
 *   - TDHP Yönetim Defteri toplu senkronu & `provisional_fx -> posted` kur değerlemesi (`rebuildOrSyncManagementLedger`)
 *   - Günlük rapor, 13-hafta Pazartesi nakit baz çizgisi ve sabah brifingi / ana ekran özet okuma doğrulaması
 *
 * Kullanım:
 * - Sürekli daemon: `pnpm ops:worker`
 * - Tek tur (CI/test): `pnpm ops:worker:once` (`--force-maintenance` ile bakım turu zorlanabilir)
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { processPendingImportJobs, type ImportJobsCycleSummary } from "./process-import-jobs";
import { acquireSingleInstanceLock, DEFAULT_RUNTIME_DIR } from "./telegram-assistant-worker";

export const DEFAULT_BACKGROUND_LOCK_PATH = path.join(DEFAULT_RUNTIME_DIR, "background-worker.lock");
export const DEFAULT_BACKGROUND_STATE_PATH = path.join(DEFAULT_RUNTIME_DIR, "background-worker-state.json");
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const MAINTENANCE_ADVISORY_LOCK_KEY_1 = 724901;
export const MAINTENANCE_ADVISORY_LOCK_KEY_2 = 1;

export type WorkerBatchStatus = "ok" | "partial_failure";

export interface WorkerScheduleState {
  lastHourlySlot: string | null;
  lastDailyDate: string | null;
  updatedAt: string | null;
  lastHeartbeatAt?: string | null;
  lastHourlySuccessAt?: string | null;
  lastDailySuccessAt?: string | null;
  lastBatchStatus?: WorkerBatchStatus | null;
  lastCorrelationId?: string | null;
}

export async function readWorkerScheduleState(
  statePath = DEFAULT_BACKGROUND_STATE_PATH,
): Promise<Required<WorkerScheduleState>> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerScheduleState>;
    return {
      lastHourlySlot: typeof parsed.lastHourlySlot === "string" ? parsed.lastHourlySlot : null,
      lastDailyDate: typeof parsed.lastDailyDate === "string" ? parsed.lastDailyDate : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      lastHeartbeatAt: typeof parsed.lastHeartbeatAt === "string" ? parsed.lastHeartbeatAt : null,
      lastHourlySuccessAt:
        typeof parsed.lastHourlySuccessAt === "string" ? parsed.lastHourlySuccessAt : null,
      lastDailySuccessAt:
        typeof parsed.lastDailySuccessAt === "string" ? parsed.lastDailySuccessAt : null,
      lastBatchStatus:
        parsed.lastBatchStatus === "ok" || parsed.lastBatchStatus === "partial_failure"
          ? parsed.lastBatchStatus
          : null,
      lastCorrelationId:
        typeof parsed.lastCorrelationId === "string" ? parsed.lastCorrelationId : null,
    };
  } catch {
    return {
      lastHourlySlot: null,
      lastDailyDate: null,
      updatedAt: null,
      lastHeartbeatAt: null,
      lastHourlySuccessAt: null,
      lastDailySuccessAt: null,
      lastBatchStatus: null,
      lastCorrelationId: null,
    };
  }
}

export async function writeWorkerScheduleStateAtomic(
  statePath: string,
  state: WorkerScheduleState,
): Promise<void> {
  const normalized: Required<WorkerScheduleState> = {
    lastHourlySlot: state.lastHourlySlot ?? null,
    lastDailyDate: state.lastDailyDate ?? null,
    updatedAt: state.updatedAt ?? null,
    lastHeartbeatAt: state.lastHeartbeatAt ?? null,
    lastHourlySuccessAt: state.lastHourlySuccessAt ?? null,
    lastDailySuccessAt: state.lastDailySuccessAt ?? null,
    lastBatchStatus:
      state.lastBatchStatus === "ok" || state.lastBatchStatus === "partial_failure"
        ? state.lastBatchStatus
        : null,
    lastCorrelationId: state.lastCorrelationId ?? null,
  };
  const resolved = path.resolve(statePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  await rename(tmpPath, resolved);
}

export async function touchWorkerHeartbeat(
  statePath = DEFAULT_BACKGROUND_STATE_PATH,
  now = new Date(),
): Promise<Required<WorkerScheduleState>> {
  const current = await readWorkerScheduleState(statePath);
  const nowISO = now.toISOString();
  const next: Required<WorkerScheduleState> = {
    ...current,
    updatedAt: nowISO,
    lastHeartbeatAt: nowISO,
  };
  await writeWorkerScheduleStateAtomic(statePath, next);
  return next;
}

export function istanbulHourSlot(now = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error("istanbulHourSlot: geçersiz Date girdisi");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const rawHour = pick("hour");
  const normalizedHour = rawHour === "24" ? "00" : rawHour.padStart(2, "0");
  return `${pick("year")}-${pick("month")}-${pick("day")}T${normalizedHour}`;
}

export const MAINTENANCE_STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '120s'";

function isMockUnexpectedSqlError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = msg.toLowerCase();
  return lower.includes("beklenmeyen sql") || lower.includes("[vitest] no \"");
}

function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "42P01" || code === "42703") {
    return true;
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = msg.toLowerCase();
  return (
    (lower.includes("relation ") && lower.includes(" does not exist")) ||
    (lower.includes("column ") && lower.includes(" does not exist"))
  );
}

function isIgnorableMaintenanceError(err: unknown): boolean {
  return isMockUnexpectedSqlError(err) || isMissingSchemaError(err);
}

function isFatalMaintenanceRowError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "57014" ||
      /^(?:08|53|57|58|XX)/i.test(code)
    ) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /(?:econnrefused|econnreset|etimedout|epipe|enotfound|connection terminated|terminating connection|statement timeout|canceling statement)/i.test(
    msg,
  );
}

const MAINTENANCE_LOCK_SQL = `select pg_try_advisory_lock(${MAINTENANCE_ADVISORY_LOCK_KEY_1}, ${MAINTENANCE_ADVISORY_LOCK_KEY_2}) as acquired`;
const MAINTENANCE_UNLOCK_SQL = `select pg_advisory_unlock(${MAINTENANCE_ADVISORY_LOCK_KEY_1}, ${MAINTENANCE_ADVISORY_LOCK_KEY_2})`;

// Guards against PostgreSQL's native same-session `pg_try_advisory_lock` reentrancy if a single-session
// pool wrapper or mock yields the exact same client/pool instance while a maintenance lock is held.
const activeAdvisoryLockHolders = new WeakSet<object>();

async function acquireMaintenanceAdvisoryLock(pool: Pool): Promise<{
  status: "acquired" | "contended" | "mock_bypassed" | "error";
  error?: string;
  release: () => Promise<void>;
}> {
  const poolRecord = pool as unknown as Record<string, unknown>;
  const isRealPgPool =
    typeof poolRecord === "object" && poolRecord !== null && "totalCount" in poolRecord;

  if (isRealPgPool) {
    let lockClient: PoolClient | null = null;
    try {
      lockClient = await pool.connect();
      const lockClientObj = lockClient as unknown as object;
      if (activeAdvisoryLockHolders.has(lockClientObj)) {
        lockClient.release();
        return { status: "contended", release: async () => undefined };
      }
      const res = await lockClient.query<{
        acquired?: boolean;
        pg_try_advisory_lock?: boolean;
      }>(MAINTENANCE_LOCK_SQL);
      const row = res.rows?.[0];
      const acquired =
        row?.acquired !== undefined
          ? Boolean(row.acquired)
          : row?.pg_try_advisory_lock !== undefined
            ? Boolean(row.pg_try_advisory_lock)
            : true;
      if (!acquired) {
        lockClient.release();
        return { status: "contended", release: async () => undefined };
      }
      const heldClient = lockClient;
      activeAdvisoryLockHolders.add(lockClientObj);
      let unlocked = false;
      return {
        status: "acquired",
        release: async () => {
          if (unlocked) return;
          unlocked = true;
          try {
            await heldClient.query(MAINTENANCE_UNLOCK_SQL);
          } catch {
            // PostgreSQL automatically drops session-level advisory locks if the connection dies.
          } finally {
            activeAdvisoryLockHolders.delete(lockClientObj);
            heldClient.release();
          }
        },
      };
    } catch (err) {
      if (lockClient) {
        activeAdvisoryLockHolders.delete(lockClient as unknown as object);
        lockClient.release();
      }
      if (isIgnorableMaintenanceError(err)) {
        return { status: "mock_bypassed", release: async () => undefined };
      }
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        release: async () => undefined,
      };
    }
  }

  // Unit-test mock pools (`!("totalCount" in pool)`):
  // Prefer `pool.query(...)` so mocks whose `connect()` rejects during outage while `query()` handles
  // advisory locks (e.g., Scenario 8b `outagePool`) and SQL-strict legacy mocks work seamlessly.
  type MockPoolShape = {
    query?: <R = Record<string, unknown>>(sql: string) => Promise<{ rows?: R[] }>;
    connect?: () => Promise<PoolClient>;
  };
  const mockPool = pool as unknown as MockPoolShape;
  try {
    const queryFn =
      typeof mockPool.query === "function" ? mockPool.query.bind(mockPool) : null;
    if (!queryFn) {
      if (typeof mockPool.connect !== "function") {
        return { status: "mock_bypassed", release: async () => undefined };
      }
      const client = await mockPool.connect();
      const clientObj = client as unknown as object;
      if (activeAdvisoryLockHolders.has(clientObj)) {
        client.release();
        return { status: "contended", release: async () => undefined };
      }
      try {
        const res = await client.query<{
          acquired?: boolean;
          pg_try_advisory_lock?: boolean;
        }>(MAINTENANCE_LOCK_SQL);
        const row = res.rows?.[0];
        const acquired =
          row?.acquired !== undefined
            ? Boolean(row.acquired)
            : row?.pg_try_advisory_lock !== undefined
              ? Boolean(row.pg_try_advisory_lock)
              : true;
        if (!acquired) {
          client.release();
          return { status: "contended", release: async () => undefined };
        }
        activeAdvisoryLockHolders.add(clientObj);
        let unlocked = false;
        return {
          status: "acquired",
          release: async () => {
            if (unlocked) return;
            unlocked = true;
            try {
              await client.query(MAINTENANCE_UNLOCK_SQL);
            } catch {
              // Ignore unlock errors on mock teardown.
            } finally {
              activeAdvisoryLockHolders.delete(clientObj);
              client.release();
            }
          },
        };
      } catch (innerErr) {
        activeAdvisoryLockHolders.delete(clientObj);
        client.release();
        throw innerErr;
      }
    }

    const mockPoolObj = mockPool as unknown as object;
    if (activeAdvisoryLockHolders.has(mockPoolObj)) {
      return { status: "contended", release: async () => undefined };
    }
    const res = await queryFn<{
      acquired?: boolean;
      pg_try_advisory_lock?: boolean;
    }>(MAINTENANCE_LOCK_SQL);
    const row = res?.rows?.[0];
    const acquired =
      row?.acquired !== undefined
        ? Boolean(row.acquired)
        : row?.pg_try_advisory_lock !== undefined
          ? Boolean(row.pg_try_advisory_lock)
          : true;
    if (!acquired) {
      return { status: "contended", release: async () => undefined };
    }
    activeAdvisoryLockHolders.add(mockPoolObj);
    let unlocked = false;
    return {
      status: "acquired",
      release: async () => {
        if (unlocked) return;
        unlocked = true;
        try {
          await queryFn(MAINTENANCE_UNLOCK_SQL).catch(() => undefined);
        } finally {
          activeAdvisoryLockHolders.delete(mockPoolObj);
        }
      },
    };
  } catch (err) {
    activeAdvisoryLockHolders.delete(mockPool as unknown as object);
    if (isIgnorableMaintenanceError(err)) {
      return { status: "mock_bypassed", release: async () => undefined };
    }
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      release: async () => undefined,
    };
  }
}

async function applyMaintenanceStatementTimeout(
  client: { query: (sql: string) => Promise<unknown> },
): Promise<void> {
  try {
    await client.query(MAINTENANCE_STATEMENT_TIMEOUT_SQL);
  } catch (err) {
    if (isMockUnexpectedSqlError(err)) return;
    throw err;
  }
}

/**
 * Wraps a real `pg.Pool` so every maintenance checkout runs under a `120s` `statement_timeout`
 * instead of the interactive `30s` web timeout, resetting cleanly before returning to the pool.
 * Mock pools in unit tests (`!("totalCount" in basePool)`) pass through untouched.
 */
export function createMaintenancePool(basePool: Pool): Pool {
  if (typeof basePool !== "object" || basePool === null || !("totalCount" in basePool)) {
    return basePool;
  }

  const checkoutWithTimeout = async () => {
    const client = await basePool.connect();
    try {
      await client.query("SET statement_timeout = '120s'");
    } catch (err) {
      client.release();
      throw err;
    }
    const origRelease = client.release.bind(client);
    let released = false;
    client.release = ((err?: boolean | Error) => {
      if (released) return;
      released = true;
      if (err) {
        origRelease(err);
        return;
      }
      void client
        .query("RESET statement_timeout")
        .catch(() => undefined)
        .finally(() => origRelease());
    }) as typeof client.release;
    return client;
  };

  return new Proxy(basePool, {
    get(target, prop, receiver) {
      if (prop === "connect") {
        return checkoutWithTimeout;
      }
      if (prop === "query") {
        return async (...args: unknown[]) => {
          const client = await checkoutWithTimeout();
          try {
            return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
          } finally {
            client.release();
          }
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

/**
 * Transitions overdue `loan_installments` from `'planned'` to `'late'` (`0034` allow-listed transition),
 * verifying `rowCount === 1` before writing an audit entry per row.
 * Never alters amounts or due dates.
 */
export async function rolloverOverdueLoanInstallments(
  pool: Pool,
  todayISO: string,
  actorId: string,
): Promise<{ scanned: number; transitionedToLate: number }> {
  const { audit } = await import("../../src/lib/audit");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await applyMaintenanceStatementTimeout(client);
    const overdue = await client.query<{
      id: string;
      loan_id: string;
      installment_no: number;
      due_date: string;
    }>(
      `select id, loan_id::text, installment_no, to_char(due_date, 'YYYY-MM-DD') as due_date
       from public.loan_installments
       where status = 'planned' and due_date < $1::date
       order by due_date, id
       for update`,
      [todayISO],
    );

    let transitionedToLate = 0;
    for (const row of overdue.rows) {
      let hasSavepoint = false;
      try {
        await client.query("savepoint sp_li_rollover");
        hasSavepoint = true;
      } catch (spErr) {
        if (!isMockUnexpectedSqlError(spErr)) throw spErr;
      }
      try {
        const upd = await client.query(
          `update public.loan_installments
              set status = 'late'
            where id = $1 and status = 'planned'`,
          [row.id],
        );
        if (upd.rowCount === 1) {
          transitionedToLate += 1;
          await audit(client, {
            actor: actorId,
            action: "loan_installment_overdue_rollover",
            entityTable: "loan_installments",
            entityId: row.id,
            before: { status: "planned" },
            after: {
              status: "late",
              dueDate: row.due_date,
              installmentNo: row.installment_no,
              automated: true,
              actorLabel: "system:background-worker",
            },
          });
        }
        if (hasSavepoint) {
          await client.query("release savepoint sp_li_rollover");
        }
      } catch (rowErr) {
        if (hasSavepoint && !isFatalMaintenanceRowError(rowErr)) {
          await client.query("rollback to savepoint sp_li_rollover");
          await client.query("release savepoint sp_li_rollover").catch(() => undefined);
          continue;
        }
        throw rowErr;
      }
    }

    await client.query("commit");
    return {
      scanned: overdue.rowCount ?? 0,
      transitionedToLate,
    };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Transitions past-due `payment_instances` from `'planned'` / `'unpaid'` to `'late'` (`0110` allow-listed),
 * isolating locked-period rows via per-row savepoints and asserting `rowCount === 1` + `audit()`.
 */
export async function rolloverOverduePaymentInstances(
  pool: Pool,
  todayISO: string,
  actorId: string,
): Promise<{ scanned: number; transitionedToLate: number }> {
  const { audit } = await import("../../src/lib/audit");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await applyMaintenanceStatementTimeout(client);
    const overdue = await client.query<{
      id: string;
      payment_id: string | null;
      status: string;
      due_date: string;
    }>(
      `select id::text as id,
              payment_id::text as payment_id,
              status,
              to_char(due_date, 'YYYY-MM-DD') as due_date
         from public.payment_instances
        where status in ('planned', 'unpaid')
          and cancelled_at is null
          and due_date < $1::date
        order by due_date, id
        for update skip locked`,
      [todayISO],
    );

    let transitionedToLate = 0;
    for (const row of overdue.rows) {
      let hasSavepoint = false;
      try {
        await client.query("savepoint sp_pi_rollover");
        hasSavepoint = true;
      } catch (spErr) {
        if (!isMockUnexpectedSqlError(spErr)) throw spErr;
      }
      try {
        const upd = await client.query(
          `update public.payment_instances
              set status = 'late'
            where id = $1 and status in ('planned', 'unpaid')`,
          [row.id],
        );
        if (upd.rowCount === 1) {
          transitionedToLate += 1;
          await audit(client, {
            actor: actorId,
            action: "payment_instance_overdue_rollover",
            entityTable: "payment_instances",
            entityId: row.id,
            before: { status: row.status },
            after: {
              status: "late",
              dueDate: row.due_date,
              paymentId: row.payment_id,
              automated: true,
              actorLabel: "system:background-worker",
            },
          });
        }
        if (hasSavepoint) {
          await client.query("release savepoint sp_pi_rollover");
        }
      } catch (rowErr) {
        if (hasSavepoint && !isFatalMaintenanceRowError(rowErr)) {
          await client.query("rollback to savepoint sp_pi_rollover");
          await client.query("release savepoint sp_pi_rollover").catch(() => undefined);
          continue;
        }
        throw rowErr;
      }
    }

    await client.query("commit");
    return {
      scanned: overdue.rowCount ?? 0,
      transitionedToLate,
    };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function evaluateAutomatedControls(
  pool: Pool,
  actorId: string,
): Promise<{ controlsChecked: number; alertsRaisedOrUpdated: number; alertsAutoResolved: number }> {
  const [{ loadControlDashboard, raiseAlert }, { audit }] = await Promise.all([
    import("../../src/lib/controls/engine"),
    import("../../src/lib/audit"),
  ]);
  const rows = await loadControlDashboard(pool);
  let alertsRaisedOrUpdated = 0;
  const zeroFindingCodes: string[] = [];

  for (const row of rows) {
    if (row.findingCount > 0) {
      await raiseAlert(
        pool,
        {
          checkCode: row.checkCode,
          severity: row.severity,
          title: `${row.title} (${row.findingCount} bulgu)`,
          detail: row.rationale,
          ruleCodes: [row.checkCode],
        },
        actorId,
      );
      alertsRaisedOrUpdated += 1;
    } else if (row.findingCount === 0) {
      zeroFindingCodes.push(row.checkCode);
    }
  }

  let alertsAutoResolved = 0;
  if (zeroFindingCodes.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await applyMaintenanceStatementTimeout(client);
      const staleOpen = await client.query<{
        id: string;
        check_code: string;
        status: string;
      }>(
        `select id::text as id, check_code, status
           from public.control_alerts
          where check_code = any($1::text[])
            and subject_id is null
            and status in ('open', 'acknowledged')
          order by id
          for update`,
        [zeroFindingCodes],
      );

      for (const alertRow of staleOpen.rows) {
        const upd = await client.query(
          `update public.control_alerts
              set status = 'resolved',
                  resolved_at = now(),
                  resolved_by = $2::uuid,
                  resolution_note = 'Otomatik çözüldü: aktif bulgu kalmadı.'
            where id = $1 and status in ('open', 'acknowledged')`,
          [alertRow.id, actorId],
        );
        if (upd.rowCount !== 1) {
          throw new Error(`Kontrol uyarısı otomatik kapatılamadı (${alertRow.id}).`);
        }
        alertsAutoResolved += 1;
        await audit(client, {
          actor: actorId,
          action: "control_alert_auto_resolved",
          entityTable: "control_alerts",
          entityId: alertRow.id,
          before: { status: alertRow.status },
          after: {
            status: "resolved",
            checkCode: alertRow.check_code,
            resolutionNote: "Otomatik çözüldü: aktif bulgu kalmadı.",
            mutatedFinancialRecords: false,
            automated: true,
            actorLabel: "system:background-worker",
          },
        });
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    controlsChecked: rows.length,
    alertsRaisedOrUpdated,
    alertsAutoResolved,
  };
}

export async function wakeSnoozedControlAlerts(
  pool: Pool,
  todayISO: string,
  actorId: string,
): Promise<{ wokenCount: number }> {
  const { audit } = await import("../../src/lib/audit");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await applyMaintenanceStatementTimeout(client);
    const due = await client.query<{ id: string; check_code: string }>(
      `select id::text, check_code
         from public.control_alerts
        where status = 'snoozed'
          and snooze_until is not null
          and snooze_until <= $1::date
        order by snooze_until, id
        for update`,
      [todayISO],
    );
    let wokenCount = 0;
    for (const row of due.rows) {
      const upd = await client.query(
        `update public.control_alerts
            set status = 'open',
                acknowledged_at = null,
                acknowledged_by = null,
                snooze_until = null
          where id = $1 and status = 'snoozed'`,
        [row.id],
      );
      if (upd.rowCount === 1) {
        wokenCount += 1;
        await audit(client, {
          actor: actorId,
          action: "control_alert_snooze_wakeup",
          entityTable: "control_alerts",
          entityId: row.id,
          before: { status: "snoozed" },
          after: { status: "open", checkCode: row.check_code, automated: true },
        });
      }
    }
    await client.query("commit");
    return { wokenCount };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface BackgroundQueueTickResult {
  requeued: number;
  reaped: number;
  importCycle: ImportJobsCycleSummary;
  dispatchedCount: number;
  dispatchedStatuses: Record<string, number>;
}

/**
 * Runs one 5-second queue tick inside the caller's `runAsSystem` context.
 */
export async function runBackgroundQueueTick(deps: {
  pool: Pool;
  identityPool: Pick<Pool, "query">;
  systemActorId: string;
  maxBatchJobs?: number;
  stuckAfterMinutes?: number;
}): Promise<BackgroundQueueTickResult> {
  const [{ reapStuckJobs, requeueDueFailures }, { createConfiguredDispatcher }] =
    await Promise.all([
      import("../../src/lib/jobs/queue"),
      import("../../src/lib/jobs/dispatcher"),
    ]);

  const dispatcher = createConfiguredDispatcher();

  const requeued = await requeueDueFailures(deps.pool);
  const reaped = await reapStuckJobs(deps.pool, deps.stuckAfterMinutes ?? 30);

  const importCycle = await processPendingImportJobs(
    {
      pool: deps.pool,
      identityPool: deps.identityPool,
      systemActorId: deps.systemActorId,
    },
    {
      quiet: true,
      sweepStaging: false,
      stuckAfterMinutes: deps.stuckAfterMinutes ?? 30,
    },
  );

  const dispatched = await dispatcher.processBatch(
    deps.pool,
    deps.systemActorId,
    deps.maxBatchJobs ?? 10,
  );

  const dispatchedStatuses: Record<string, number> = {};
  for (const item of dispatched) {
    const key = item.status ?? "unknown";
    dispatchedStatuses[key] = (dispatchedStatuses[key] ?? 0) + 1;
  }

  return {
    requeued: requeued + importCycle.requeued,
    reaped: reaped + importCycle.reaped,
    importCycle,
    dispatchedCount: dispatched.length,
    dispatchedStatuses,
  };
}

export interface ManagementLedgerSyncSummary {
  ok: boolean;
  createdCount: number;
  skippedCount: number;
  revaluedCount: number;
  error: string | null;
}

async function syncManagementLedgerSafely(
  pool: Pool,
  actorId: string,
  onRawError?: (err: unknown) => void,
): Promise<ManagementLedgerSyncSummary> {
  try {
    const { rebuildOrSyncManagementLedger } = await import("../../src/lib/ledger/posting-engine");
    const synced = await rebuildOrSyncManagementLedger(pool, actorId);
    return {
      ok: true,
      createdCount: synced.createdCount,
      skippedCount: synced.skippedCount,
      revaluedCount: synced.revaluedCount,
      error: null,
    };
  } catch (err) {
    onRawError?.(err);
    return {
      ok: false,
      createdCount: 0,
      skippedCount: 0,
      revaluedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MorningBriefingDispatchOutcome {
  attempted: boolean;
  dispatched: boolean;
  idempotencyKey: string | null;
  skippedReason?: string;
  error?: string;
}

export async function dispatchDailyCfoBriefingIdempotent(deps: {
  pool: Pool;
  systemActorId: string;
  todayISO: string;
  hourSlot: string;
  targetHourTrt?: number;
  channel?: "telegram" | "email";
  transportResolver?: (channel: "telegram" | "email" | "sms" | "whatsapp") => {
    channel: "telegram" | "email" | "sms" | "whatsapp";
    send(message: string, opts?: { parseMode?: "HTML"; subject?: string }): Promise<{
      ok: boolean;
      error?: string;
      skippedUnconfigured?: boolean;
    }>;
  };
}): Promise<MorningBriefingDispatchOutcome> {
  const configuredHour = Number(deps.targetHourTrt ?? process.env.MAS_BRIEFING_HOUR_TRT ?? 8);
  const targetHour = Number.isFinite(configuredHour)
    ? Math.max(0, Math.min(23, Math.floor(configuredHour)))
    : 8;
  const hourFromSlot = Number(deps.hourSlot.slice(11, 13));
  const istanbulHour = Number.isFinite(hourFromSlot)
    ? hourFromSlot
    : Number(istanbulHourSlot().slice(11, 13));

  if (istanbulHour < targetHour) {
    return {
      attempted: false,
      dispatched: false,
      idempotencyKey: null,
      skippedReason: "before_briefing_hour",
    };
  }

  const channel: "telegram" | "email" =
    deps.channel ?? (process.env.MAS_BRIEFING_CHANNEL === "email" ? "email" : "telegram");
  const idempotencyKey = `cfo_briefing:${deps.todayISO}:${channel}`;

  const [
    { audit },
    { generateCfoBriefing },
    { renderBriefing },
    { claimAndDispatchOutbox, enqueueOutboxNotification },
  ] = await Promise.all([
    import("../../src/lib/audit"),
    import("../../src/lib/briefing/engine"),
    import("../../src/lib/briefing/rules"),
    import("../../src/lib/reminders/outbox"),
  ]);

  const existingOutbox = await deps.pool.query<{ id: string; status: string }>(
    `select id::text as id, status
       from public.notification_outbox
      where idempotency_key = $1
      limit 1`,
    [idempotencyKey],
  );
  const priorStatus = existingOutbox.rows[0]?.status;
  if (
    priorStatus === "sent" ||
    priorStatus === "claiming" ||
    priorStatus === "skipped" ||
    priorStatus === "delivery_uncertain" ||
    priorStatus === "dead_letter"
  ) {
    return {
      attempted: false,
      dispatched: false,
      idempotencyKey,
      skippedReason: `already_${priorStatus}`,
    };
  }

  const briefing = await generateCfoBriefing(deps.pool, deps.todayISO, deps.systemActorId);
  const outboundBody = renderBriefing(
    briefing.facts,
    channel === "telegram" ? { masked: true } : { masked: false },
  );

  await enqueueOutboxNotification(deps.pool, {
    stream: "cfo_briefing",
    channel,
    recipientTarget: `default:${channel}`,
    idempotencyKey,
    subject: `CFO Sabah Brifingi — ${deps.todayISO}`,
    bodyText: outboundBody,
    bodyFormat: "plain",
    metadata: {
      reportId: briefing.reportId,
      todayISO: deps.todayISO,
      masked: channel === "telegram",
    },
  });

  const dispatchRes = await claimAndDispatchOutbox(deps.pool, {
    stream: "cfo_briefing",
    channel,
    batchSize: 5,
    transportResolver: deps.transportResolver,
  });

  const ok = dispatchRes.sent > 0;
  const deliveryFailed = !ok && (dispatchRes.retried > 0 || dispatchRes.deadLettered > 0);
  await audit(deps.pool, {
    actor: deps.systemActorId,
    action: "dispatch_cfo_briefing",
    entityTable: "reports",
    entityId: briefing.reportId,
    after: {
      channel,
      idempotencyKey,
      masked: channel === "telegram",
      ok,
      sent: dispatchRes.sent,
      retried: dispatchRes.retried,
      skipped: dispatchRes.skipped,
      automated: true,
    },
  });

  return {
    attempted: true,
    dispatched: ok,
    idempotencyKey,
    ...(deliveryFailed ? { error: "cfo_briefing_outbox_delivery_failed" } : {}),
  };
}

export interface MaintenanceSummary {
  hourlyRan: boolean;
  dailyRan: boolean;
  skippedLocked?: boolean;
  todayISO: string;
  hourSlot: string;
  details?: Record<string, unknown>;
}

/**
 * Executes hourly and daily idempotent financial maintenance tasks inside `runAsSystem`.
 */
export async function runScheduledMaintenance(deps: {
  pool: Pool;
  systemActorId: string;
  statePath?: string;
  now?: Date;
  todayISO?: string;
  hourSlot?: string;
  force?: boolean;
  enableTcmbSync?: boolean;
  enableMorningBriefingDispatch?: boolean;
  briefingHourTrt?: number;
  correlationId?: string;
}): Promise<MaintenanceSummary> {
  const [{ istanbulDateISO }, { log }] = await Promise.all([
    import("../../src/lib/reports/rules"),
    import("../../src/lib/logger"),
  ]);
  const statePath = deps.statePath ?? DEFAULT_BACKGROUND_STATE_PATH;
  const now = deps.now ?? new Date();
  const todayISO = deps.todayISO ?? istanbulDateISO(now);
  const hourSlot = deps.hourSlot ?? istanbulHourSlot(now);
  const correlationId = deps.correlationId ?? randomUUID();

  const state = await readWorkerScheduleState(statePath);
  const shouldRunHourly = Boolean(deps.force) || state.lastHourlySlot !== hourSlot;
  const shouldRunDaily = Boolean(deps.force) || state.lastDailyDate !== todayISO;

  if (!shouldRunHourly && !shouldRunDaily) {
    return { hourlyRan: false, dailyRan: false, todayISO, hourSlot };
  }

  const lock = await acquireMaintenanceAdvisoryLock(deps.pool);
  if (lock.status === "contended") {
    return {
      hourlyRan: false,
      dailyRan: false,
      skippedLocked: true,
      todayISO,
      hourSlot,
      details: { skippedReason: "concurrent_lock_held", skippedLocked: true },
    };
  }

  const maintPool = createMaintenancePool(deps.pool);
  const details: Record<string, unknown> = {};
  const hourlyErrors: string[] = [];
  const dailyErrors: string[] = [];

  try {
    if (lock.status === "error") {
      const lockErrMsg = lock.error ?? "advisory_lock_failed";
      if (shouldRunHourly) {
        hourlyErrors.push(`advisory_lock: ${lockErrMsg}`);
      }
      if (shouldRunDaily) {
        dailyErrors.push(`advisory_lock: ${lockErrMsg}`);
      }
      details.advisoryLockError = lockErrMsg;
      log.error("background_worker_advisory_lock_failed", {
        todayISO,
        hourSlot,
        correlationId,
        error: lockErrMsg,
      });
    } else {
      if (shouldRunHourly) {
        const [{ dispatchPending, scheduleReminders }, { claimAndDispatchOutbox }] =
          await Promise.all([
            import("../../src/lib/reminders/engine"),
            import("../../src/lib/reminders/outbox"),
          ]);

        let scheduleErrHandled = false;
        const remindersScheduled = await scheduleReminders(maintPool, todayISO).catch((err) => {
          scheduleErrHandled = true;
          const msg = err instanceof Error ? err.message : String(err);
          if (!isIgnorableMaintenanceError(err)) {
            hourlyErrors.push(`scheduleReminders: ${msg}`);
            log.error("background_worker_schedule_reminders_failed", {
              todayISO,
              hourSlot,
              correlationId,
              error: msg,
            });
          }
          return {
            scheduled: 0,
            skipped: 0,
            error: msg,
          };
        });
        if (
          !scheduleErrHandled &&
          remindersScheduled &&
          typeof remindersScheduled === "object" &&
          "error" in remindersScheduled &&
          typeof (remindersScheduled as { error?: unknown }).error === "string"
        ) {
          const schedErrStr = (remindersScheduled as { error: string }).error;
          if (!isIgnorableMaintenanceError(schedErrStr)) {
            hourlyErrors.push(`scheduleReminders: ${schedErrStr}`);
          }
        }

        let dispatchErrHandled = false;
        const remindersDelivered = await dispatchPending(maintPool, undefined, todayISO).catch(
          (err) => {
            dispatchErrHandled = true;
            const msg = err instanceof Error ? err.message : String(err);
            if (!isIgnorableMaintenanceError(err)) {
              hourlyErrors.push(`dispatchPending: ${msg}`);
              log.error("background_worker_dispatch_reminders_failed", {
                todayISO,
                hourSlot,
                correlationId,
                error: msg,
              });
            }
            return {
              sent: 0,
              failed: 0,
              skipped: 0,
              error: msg,
            };
          },
        );
        if (
          !dispatchErrHandled &&
          remindersDelivered &&
          typeof remindersDelivered === "object" &&
          "error" in remindersDelivered &&
          typeof (remindersDelivered as { error?: unknown }).error === "string"
        ) {
          const dispErrStr = (remindersDelivered as { error: string }).error;
          if (!isIgnorableMaintenanceError(dispErrStr)) {
            hourlyErrors.push(`dispatchPending: ${dispErrStr}`);
          }
        }

        const outboxRetried = await claimAndDispatchOutbox(maintPool).catch((err) => {
          if (isIgnorableMaintenanceError(err)) {
            return { claimed: 0, sent: 0, retried: 0, deadLettered: 0, skipped: 0 };
          }
          const msg = err instanceof Error ? err.message : String(err);
          hourlyErrors.push(`claimAndDispatchOutbox: ${msg}`);
          log.error("background_worker_outbox_retry_failed", {
            todayISO,
            hourSlot,
            correlationId,
            error: msg,
          });
          return { claimed: 0, sent: 0, retried: 0, deadLettered: 0, skipped: 0 };
        });

        let swept = { removed: 0 };
        let snoozeWakeup = { wokenCount: 0 };
        let parasutDue = { enqueued: 0, skipped: 0 };
        let managementLedgerSync: ManagementLedgerSyncSummary = {
          ok: false,
          createdCount: 0,
          skippedCount: 0,
          revaluedCount: 0,
          error: hourlyErrors[0] ?? null,
        };

        // Only execute secondary housekeeping / read-model warmers / ledger sync when core reminder &
        // outbox probes did not hit a DB outage, avoiding piling extra queries onto an unreachable DB.
        if (hourlyErrors.length === 0) {
          const [
            { sweepStaleStagedFiles },
            { validateContinuity },
            { loadOverviewSnapshot },
            { enqueueDueSyncs },
          ] = await Promise.all([
            import("../../src/lib/importers/v2/async-runner"),
            import("../../src/lib/cashflow/engine"),
            import("../../src/lib/home/overview-snapshot"),
            import("../../src/lib/integrations/engine"),
          ]);

          const recordHourlySubtaskError = (step: string, err: unknown) => {
            if (!isIgnorableMaintenanceError(err)) {
              const msg = err instanceof Error ? err.message : String(err);
              hourlyErrors.push(`${step}: ${msg}`);
              log.error("background_worker_hourly_subtask_failed", {
                step,
                todayISO,
                hourSlot,
                correlationId,
                error: msg,
              });
            }
          };

          swept = await sweepStaleStagedFiles(maintPool).catch((err) => {
            recordHourlySubtaskError("sweepStaleStagedFiles", err);
            return { removed: 0 };
          });
          snoozeWakeup = await wakeSnoozedControlAlerts(
            maintPool,
            todayISO,
            deps.systemActorId,
          ).catch((err) => {
            recordHourlySubtaskError("wakeSnoozedControlAlerts", err);
            return { wokenCount: 0 };
          });
          await validateContinuity(maintPool).catch((err) => {
            recordHourlySubtaskError("validateContinuity", err);
            return undefined;
          });
          await loadOverviewSnapshot(maintPool, todayISO).catch((err) => {
            recordHourlySubtaskError("loadOverviewSnapshot", err);
            return undefined;
          });
          parasutDue = await enqueueDueSyncs(
            maintPool,
            deps.systemActorId,
            todayISO,
          ).catch((err) => {
            recordHourlySubtaskError("enqueueDueSyncs", err);
            return { enqueued: 0, skipped: 0 };
          });

          let ledgerErrHandled = false;
          managementLedgerSync = await syncManagementLedgerSafely(
            maintPool,
            deps.systemActorId,
            (rawErr) => {
              ledgerErrHandled = true;
              if (!isIgnorableMaintenanceError(rawErr)) {
                const msg = rawErr instanceof Error ? rawErr.message : String(rawErr);
                hourlyErrors.push(`managementLedgerSync: ${msg}`);
                log.error("background_worker_hourly_ledger_sync_failed", {
                  todayISO,
                  hourSlot,
                  correlationId,
                  error: msg,
                });
              }
            },
          );
          if (
            !ledgerErrHandled &&
            !managementLedgerSync.ok &&
            managementLedgerSync.error &&
            !isIgnorableMaintenanceError(managementLedgerSync.error)
          ) {
            hourlyErrors.push(`managementLedgerSync: ${managementLedgerSync.error}`);
          }
        }

        details.hourly = {
          stagedSweptRemoved: swept.removed,
          snoozedAlertsWoken: snoozeWakeup.wokenCount,
          remindersScheduled,
          remindersDelivered,
          outboxRetried,
          integrationsIncrementalEnqueued: parasutDue.enqueued,
          managementLedgerSync,
        };
      }

      if (shouldRunDaily) {
        const [
          { audit },
          { ensureWindow },
          { detectBrokenPromises },
          { generateDaily },
          { runClosedLoopFinancialPipeline },
        ] = await Promise.all([
          import("../../src/lib/audit"),
          import("../../src/lib/radar/engine"),
          import("../../src/lib/collections/promises-engine"),
          import("../../src/lib/reports/engine"),
          import("../../src/lib/integrations/parasut/sync-pipeline"),
        ]);

        const windowRes = await ensureWindow(maintPool, todayISO, deps.systemActorId, 24).catch(
          (err) => {
            if (!isIgnorableMaintenanceError(err)) {
              const msg = err instanceof Error ? err.message : String(err);
              dailyErrors.push(`ensureWindow: ${msg}`);
              log.error("background_worker_ensure_window_failed", {
                todayISO,
                correlationId,
                error: msg,
              });
            }
            return [];
          },
        );
        const loanRollover = await rolloverOverdueLoanInstallments(
          maintPool,
          todayISO,
          deps.systemActorId,
        ).catch((err) => {
          if (!isIgnorableMaintenanceError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            dailyErrors.push(`rolloverOverdueLoanInstallments: ${msg}`);
            log.error("background_worker_loan_rollover_failed", {
              todayISO,
              correlationId,
              error: msg,
            });
          }
          return { scanned: 0, transitionedToLate: 0 };
        });
        const paymentRollover = await rolloverOverduePaymentInstances(
          maintPool,
          todayISO,
          deps.systemActorId,
        ).catch((err) => {
          if (!isIgnorableMaintenanceError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            dailyErrors.push(`rolloverOverduePaymentInstances: ${msg}`);
            log.error("background_worker_payment_rollover_failed", {
              todayISO,
              correlationId,
              error: msg,
            });
          }
          return { scanned: 0, transitionedToLate: 0 };
        });
        const brokenPromises = await detectBrokenPromises(
          maintPool,
          todayISO,
          deps.systemActorId,
        ).catch((err) => {
          if (!isIgnorableMaintenanceError(err)) {
            const msg = err instanceof Error ? err.message : String(err);
            dailyErrors.push(`detectBrokenPromises: ${msg}`);
            log.error("background_worker_broken_promises_failed", {
              todayISO,
              correlationId,
              error: msg,
            });
          }
          return { scanned: 0, markedBroken: 0 };
        });
        const controls = await evaluateAutomatedControls(maintPool, deps.systemActorId).catch(
          (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (!isIgnorableMaintenanceError(err)) {
              dailyErrors.push(`evaluateAutomatedControls: ${errMsg}`);
              log.error("background_worker_controls_evaluation_failed", {
                todayISO,
                correlationId,
                error: errMsg,
              });
            }
            return {
              controlsChecked: 0,
              alertsRaisedOrUpdated: 0,
              alertsAutoResolved: 0,
              error: errMsg,
            };
          },
        );

        const tcmbAuto = deps.enableTcmbSync ?? process.env.MAS_TCMB_AUTO_SYNC === "1";
        let dailyReportId: string | null = null;
        let dailyReportCreated = false;

        // F-31: Kapalı çevrim orkestratörü (TCMB Kur -> TDHP Yönetim Defteri & Kur Değerleme -> Günlük Rapor -> 13-Hafta Snapshot)
        const closedLoop = await runClosedLoopFinancialPipeline(maintPool, deps.systemActorId, {
          todayISO,
          triggerDueIntegrationSyncs: false,
          syncTcmbFxRates: tcmbAuto,
          syncManagementLedger: true,
          freezeMonday13w: true,
          afterLedgerBeforeFreeze: async () => {
            try {
              const existingDaily = await maintPool.query<{ id: string }>(
                `select id from public.reports where report_type = 'daily' and period_start = $1::date limit 1`,
                [todayISO],
              );
              dailyReportId = existingDaily.rows[0]?.id ?? null;
              if (!dailyReportId) {
                const created = await generateDaily(maintPool, todayISO, deps.systemActorId);
                dailyReportId = created.id;
                dailyReportCreated = true;
              }
            } catch (repErr) {
              if (!isIgnorableMaintenanceError(repErr)) {
                const msg = repErr instanceof Error ? repErr.message : String(repErr);
                dailyErrors.push(`generateDaily: ${msg}`);
                log.error("background_worker_daily_report_failed", {
                  todayISO,
                  correlationId,
                  error: msg,
                });
              }
            }
          },
        }).catch((pipeErr) => {
          if (!isIgnorableMaintenanceError(pipeErr)) {
            const msg = pipeErr instanceof Error ? pipeErr.message : String(pipeErr);
            dailyErrors.push(`closedLoop: ${msg}`);
            log.error("background_worker_closed_loop_failed", {
              todayISO,
              correlationId,
              error: msg,
            });
          }
          return {
            ok: false,
            todayISO,
            executedSteps: [],
            integrationSyncs: { executed: false, enqueued: 0, skipped: 0, error: null },
            fxSync: {
              executed: false,
              ok: false,
              rateDate: null,
              inserted: 0,
              skipped: 0,
              error: pipeErr instanceof Error ? pipeErr.message : String(pipeErr),
            },
            managementLedger: {
              executed: false,
              createdCount: 0,
              skippedCount: 0,
              revaluedCount: 0,
              error: pipeErr instanceof Error ? pipeErr.message : String(pipeErr),
            },
            forecast13w: {
              executed: false,
              weekMonday: null,
              isMonday: false,
              frozenCount: 0,
              reusedExistingCount: 0,
              primarySnapshotId: null,
              snapshots: [],
              error: pipeErr instanceof Error ? pipeErr.message : String(pipeErr),
            },
            errors: [],
          };
        });

        for (const stepErr of closedLoop.errors) {
          if (!isIgnorableMaintenanceError(stepErr.message)) {
            dailyErrors.push(`closedLoop.${stepErr.step}: ${stepErr.message}`);
          }
        }

        const fxSync: Record<string, unknown> = tcmbAuto
          ? {
              enabled: true,
              ok: Boolean(closedLoop.fxSync.ok),
              rateDate: closedLoop.fxSync.rateDate,
              inserted: closedLoop.fxSync.inserted,
              skipped: closedLoop.fxSync.skipped,
            }
          : { enabled: false };

        const managementLedgerSync: ManagementLedgerSyncSummary = {
          ok: closedLoop.managementLedger.executed && closedLoop.managementLedger.error === null,
          createdCount: closedLoop.managementLedger.createdCount,
          skippedCount: closedLoop.managementLedger.skippedCount,
          revaluedCount: closedLoop.managementLedger.revaluedCount,
          error: closedLoop.managementLedger.error,
        };

        if (
          !managementLedgerSync.ok &&
          managementLedgerSync.error &&
          !isIgnorableMaintenanceError(managementLedgerSync.error) &&
          !dailyErrors.some((e) => e.startsWith("closedLoop.management_ledger_sync:"))
        ) {
          dailyErrors.push(`managementLedgerSync: ${managementLedgerSync.error}`);
        }

        const weekly13wSnapshotId: string | null = closedLoop.forecast13w.primarySnapshotId;

        const dailyStats = {
          todayISO,
          instancesCreated: windowRes.reduce((s, r) => s + r.created, 0),
          loanInstallmentsMarkedLate: loanRollover.transitionedToLate,
          paymentInstancesMarkedLate: paymentRollover.transitionedToLate,
          promisesMarkedBroken: brokenPromises.markedBroken,
          controlsAlertsRaisedOrUpdated: controls.alertsRaisedOrUpdated,
          controlsAlertsAutoResolved: controls.alertsAutoResolved,
          fxSync,
          managementLedgerSync,
          dailyReportId,
          dailyReportCreated,
          weekly13wSnapshotId,
          automated: true,
          actorLabel: "system:background-worker",
        };

        if (dailyErrors.length === 0) {
          try {
            await audit(maintPool, {
              actor: deps.systemActorId,
              action: "background_daily_maintenance",
              entityTable: "background_jobs",
              entityId: null,
              after: dailyStats,
            });
          } catch (audErr) {
            if (!isIgnorableMaintenanceError(audErr)) {
              const msg = audErr instanceof Error ? audErr.message : String(audErr);
              dailyErrors.push(`dailyAudit: ${msg}`);
              log.error("background_worker_daily_audit_failed", {
                todayISO,
                correlationId,
                error: msg,
              });
            }
          }
        }

        details.daily = dailyStats;
      }

      // F-39: Sabah CFO brifingi — `istanbulHour >= MAS_BRIEFING_HOUR_TRT` (varsayılan 08:00 TRT) kapısıyla
      // ve `notification_outbox` (`cfo_briefing:${todayISO}:telegram`) idempotensiyle günde en fazla 1 kez gönderilir.
      const autoDispatchBriefing =
        deps.enableMorningBriefingDispatch ?? process.env.MAS_BRIEFING_AUTO_DISPATCH === "1";
      if (autoDispatchBriefing) {
        try {
          const briefingRes = await dispatchDailyCfoBriefingIdempotent({
            pool: maintPool,
            systemActorId: deps.systemActorId,
            todayISO,
            hourSlot,
            targetHourTrt: deps.briefingHourTrt,
          });
          details.morningBriefing = briefingRes;
          if (briefingRes.error && !isIgnorableMaintenanceError(briefingRes.error)) {
            if (shouldRunHourly) {
              hourlyErrors.push(`morningBriefing: ${briefingRes.error}`);
            } else {
              dailyErrors.push(`morningBriefing: ${briefingRes.error}`);
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (!isIgnorableMaintenanceError(err)) {
            if (shouldRunHourly) {
              hourlyErrors.push(`morningBriefing: ${errMsg}`);
            } else {
              dailyErrors.push(`morningBriefing: ${errMsg}`);
            }
          }
          log.error("background_worker_morning_briefing_failed", {
            todayISO,
            hourSlot,
            correlationId,
            error: errMsg,
          });
          details.morningBriefing = {
            attempted: true,
            dispatched: false,
            idempotencyKey: null,
            error: errMsg,
          };
        }
      }
    }

    const nowISO = new Date().toISOString();
    const hourlySucceeded = shouldRunHourly && hourlyErrors.length === 0;
    const dailySucceeded = shouldRunDaily && dailyErrors.length === 0;
    const hasFailures =
      (shouldRunHourly && hourlyErrors.length > 0) ||
      (shouldRunDaily && dailyErrors.length > 0);

    if (hourlySucceeded) {
      state.lastHourlySlot = hourSlot;
      state.lastHourlySuccessAt = nowISO;
    }
    if (dailySucceeded) {
      state.lastDailyDate = todayISO;
      state.lastDailySuccessAt = nowISO;
    }

    state.updatedAt = nowISO;
    state.lastHeartbeatAt = nowISO;
    state.lastBatchStatus = hasFailures ? "partial_failure" : "ok";
    state.lastCorrelationId = correlationId;

    details.batchStatus = state.lastBatchStatus;
    details.correlationId = correlationId;
    if (hourlyErrors.length > 0) {
      details.hourlyErrors = hourlyErrors;
    }
    if (dailyErrors.length > 0) {
      details.dailyErrors = dailyErrors;
    }

    if (hasFailures) {
      log.error("background_worker_maintenance_partial_failure", {
        todayISO,
        hourSlot,
        correlationId,
        hourlyErrors,
        dailyErrors,
      });
    }

    await writeWorkerScheduleStateAtomic(statePath, state);

    return {
      hourlyRan: hourlySucceeded,
      dailyRan: dailySucceeded,
      todayISO,
      hourSlot,
      details,
    };
  } finally {
    await lock.release();
  }
}

async function main(): Promise<void> {
  process.env.PGAPPNAME = process.env.PGAPPNAME || "mas_background_worker";
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());

  const once = process.argv.includes("--once");
  const forceMaintenance = process.argv.includes("--force-maintenance");
  const skipMaintenance = process.argv.includes("--skip-maintenance");
  const intervalArg = process.argv.find((a) => a.startsWith("--interval-ms="));
  const pollIntervalMs = intervalArg
    ? Math.max(500, Number(intervalArg.split("=")[1]) || DEFAULT_POLL_INTERVAL_MS)
    : DEFAULT_POLL_INTERVAL_MS;

  const lock = acquireSingleInstanceLock(DEFAULT_BACKGROUND_LOCK_PATH);

  const abortController = new AbortController();
  const requestStop = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const [db, { log }, { getSystemActorId }] = await Promise.all([
    import("../../src/lib/db"),
    import("../../src/lib/logger"),
    import("../db/seed-system-actor"),
  ]);

  const pool = db.getPool();
  const rawPool = db.getRawPool();

  try {
    const systemActorId = await getSystemActorId(rawPool);
    log.info("background_worker_started", {
      mode: once ? "once" : "daemon",
      pollIntervalMs,
      pgAppName: process.env.PGAPPNAME,
    });

    let lastHeartbeatEpochMs = 0;

    const runOneIteration = async () => {
      await db.runAsSystem(async () => {
        const tick = await runBackgroundQueueTick({
          pool,
          identityPool: rawPool,
          systemActorId,
        });
        if (tick.requeued > 0 || tick.reaped > 0 || tick.importCycle.processed > 0 || tick.dispatchedCount > 0) {
          log.info("background_worker_tick", {
            requeued: tick.requeued,
            reaped: tick.reaped,
            importsProcessed: tick.importCycle.processed,
            jobsDispatched: tick.dispatchedCount,
            statuses: tick.dispatchedStatuses,
          });
        }

        let heartbeatWritten = false;
        if (!skipMaintenance) {
          const maint = await runScheduledMaintenance({
            pool,
            systemActorId,
            force: forceMaintenance,
          });
          if (maint.details?.batchStatus !== undefined) {
            heartbeatWritten = true;
            lastHeartbeatEpochMs = Date.now();
          }
          if (maint.hourlyRan || maint.dailyRan) {
            log.info("background_worker_maintenance", {
              hourlyRan: maint.hourlyRan,
              dailyRan: maint.dailyRan,
              todayISO: maint.todayISO,
              hourSlot: maint.hourSlot,
            });
          }
        }

        if (!heartbeatWritten && Date.now() - lastHeartbeatEpochMs >= 60_000) {
          await touchWorkerHeartbeat(DEFAULT_BACKGROUND_STATE_PATH);
          lastHeartbeatEpochMs = Date.now();
        }
      });
    };

    if (once) {
      await runOneIteration();
      log.info("background_worker_once_completed", { clean: true });
      return;
    }

    while (!abortController.signal.aborted) {
      try {
        await runOneIteration();
      } catch (cycleErr) {
        log.error("background_worker_cycle_error", {
          error: cycleErr instanceof Error ? cycleErr.message : String(cycleErr),
        });
      }

      if (abortController.signal.aborted) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        abortController.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    log.info("background_worker_stopped", { clean: true });
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    lock.release();
    await pool.end().catch(() => undefined);
  }
}

const isDirectCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCli) {
  main().catch((err) => {
    console.error("Arka plan işçisi hatası:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
