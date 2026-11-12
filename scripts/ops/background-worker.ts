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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { processPendingImportJobs, type ImportJobsCycleSummary } from "./process-import-jobs";
import { acquireSingleInstanceLock, DEFAULT_RUNTIME_DIR } from "./telegram-assistant-worker";

export const DEFAULT_BACKGROUND_LOCK_PATH = path.join(DEFAULT_RUNTIME_DIR, "background-worker.lock");
export const DEFAULT_BACKGROUND_STATE_PATH = path.join(DEFAULT_RUNTIME_DIR, "background-worker-state.json");
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface WorkerScheduleState {
  lastHourlySlot: string | null;
  lastDailyDate: string | null;
  updatedAt: string | null;
}

export async function readWorkerScheduleState(
  statePath = DEFAULT_BACKGROUND_STATE_PATH,
): Promise<WorkerScheduleState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WorkerScheduleState>;
    return {
      lastHourlySlot: typeof parsed.lastHourlySlot === "string" ? parsed.lastHourlySlot : null,
      lastDailyDate: typeof parsed.lastDailyDate === "string" ? parsed.lastDailyDate : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return { lastHourlySlot: null, lastDailyDate: null, updatedAt: null };
  }
}

export async function writeWorkerScheduleStateAtomic(
  statePath: string,
  state: WorkerScheduleState,
): Promise<void> {
  const resolved = path.resolve(statePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const tmpPath = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tmpPath, resolved);
}

export function istanbulHourSlot(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}`;
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
    }

    await client.query("commit");
    return {
      scanned: overdue.rowCount ?? 0,
      transitionedToLate,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function evaluateAutomatedControls(
  pool: Pool,
  actorId: string,
): Promise<{ controlsChecked: number; alertsRaisedOrUpdated: number }> {
  const { loadControlDashboard, raiseAlert } = await import("../../src/lib/controls/engine");
  const rows = await loadControlDashboard(pool);
  let alertsRaisedOrUpdated = 0;
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
    }
  }
  return {
    controlsChecked: rows.length,
    alertsRaisedOrUpdated,
  };
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
  const [{ reapStuckJobs, requeueDueFailures }, { dispatcher, registerBuiltInJobHandlers }] =
    await Promise.all([
      import("../../src/lib/jobs/queue"),
      import("../../src/lib/jobs/dispatcher"),
    ]);

  if (!dispatcher.hasHandler("report_generation")) {
    registerBuiltInJobHandlers(dispatcher);
  }

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
    return {
      ok: false,
      createdCount: 0,
      skippedCount: 0,
      revaluedCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MaintenanceSummary {
  hourlyRan: boolean;
  dailyRan: boolean;
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
  todayISO?: string;
  hourSlot?: string;
  force?: boolean;
  enableTcmbSync?: boolean;
}): Promise<MaintenanceSummary> {
  const { istanbulDateISO } = await import("../../src/lib/reports/rules");
  const statePath = deps.statePath ?? DEFAULT_BACKGROUND_STATE_PATH;
  const todayISO = deps.todayISO ?? istanbulDateISO();
  const hourSlot = deps.hourSlot ?? istanbulHourSlot();

  const state = await readWorkerScheduleState(statePath);
  const shouldRunHourly = Boolean(deps.force) || state.lastHourlySlot !== hourSlot;
  const shouldRunDaily = Boolean(deps.force) || state.lastDailyDate !== todayISO;

  if (!shouldRunHourly && !shouldRunDaily) {
    return { hourlyRan: false, dailyRan: false, todayISO, hourSlot };
  }

  const details: Record<string, unknown> = {};

  if (shouldRunHourly) {
    const [
      { sweepStaleStagedFiles },
      { dispatchPending, scheduleReminders },
      { validateContinuity },
      { loadOverviewSnapshot },
    ] = await Promise.all([
      import("../../src/lib/importers/v2/async-runner"),
      import("../../src/lib/reminders/engine"),
      import("../../src/lib/cashflow/engine"),
      import("../../src/lib/home/overview-snapshot"),
    ]);

    const swept = await sweepStaleStagedFiles(deps.pool);
    const remindersScheduled = await scheduleReminders(deps.pool, todayISO);
    const remindersDelivered = await dispatchPending(deps.pool, undefined, todayISO);
    await validateContinuity(deps.pool);
    await loadOverviewSnapshot(deps.pool, todayISO);
    const { enqueueDueSyncs } = await import("../../src/lib/integrations/engine");
    const parasutDue = await enqueueDueSyncs(deps.pool, deps.systemActorId, todayISO).catch(() => ({ enqueued: 0, skipped: 0 }));
    const managementLedgerSync = await syncManagementLedgerSafely(deps.pool, deps.systemActorId);

    details.hourly = {
      stagedSweptRemoved: swept.removed,
      remindersScheduled,
      remindersDelivered,
      integrationsIncrementalEnqueued: parasutDue.enqueued,
      managementLedgerSync,
    };
    state.lastHourlySlot = hourSlot;
  }

  if (shouldRunDaily) {
    const [
      { audit },
      { ensureWindow },
      { detectBrokenPromises },
      { generateDaily },
    ] = await Promise.all([
      import("../../src/lib/audit"),
      import("../../src/lib/radar/engine"),
      import("../../src/lib/collections/promises-engine"),
      import("../../src/lib/reports/engine"),
    ]);

    const windowRes = await ensureWindow(deps.pool, todayISO, deps.systemActorId, 24);
    const loanRollover = await rolloverOverdueLoanInstallments(deps.pool, todayISO, deps.systemActorId);
    const brokenPromises = await detectBrokenPromises(deps.pool, todayISO, deps.systemActorId);
    const controls = await evaluateAutomatedControls(deps.pool, deps.systemActorId);

    let fxSync: Record<string, unknown> = { enabled: false };
    const tcmbAuto = deps.enableTcmbSync ?? process.env.MAS_TCMB_AUTO_SYNC === "1";
    if (tcmbAuto) {
      const [{ importRates }, { tcmbProvider }] = await Promise.all([
        import("../../src/lib/fx/engine"),
        import("../../src/lib/fx/provider"),
      ]);
      const fx = await importRates(deps.pool, tcmbProvider(), todayISO, deps.systemActorId);
      fxSync = { enabled: true, ok: fx.ok, rateDate: fx.rateDate, inserted: fx.inserted, skipped: fx.skipped };
    }

    // Faz 52/54 kapalı çevrim: TCMB kur çekiminden hemen sonra (ve günlük rapor üretilmeden ÖNCE)
    // TDHP yönetim defterini senkronla ve provisional_fx -> posted kur değerlemesini uygula.
    const managementLedgerSync = await syncManagementLedgerSafely(deps.pool, deps.systemActorId);

    const existingDaily = await deps.pool.query<{ id: string }>(
      `select id from public.reports where report_type = 'daily' and period_start = $1::date limit 1`,
      [todayISO],
    );
    let dailyReportId: string | null = existingDaily.rows[0]?.id ?? null;
    let dailyReportCreated = false;
    if (!dailyReportId) {
      const created = await generateDaily(deps.pool, todayISO, deps.systemActorId);
      dailyReportId = created.id;
      dailyReportCreated = true;
    }

    // Faz 54 (F1): Her Pazartesi sabahı (veya o haftanın TRY baz çizgisi henüz dondurulmamışsa)
    // 13 haftalık doğrudan nakit tahmini anlık görüntüsünü otomatik dondur.
    let weekly13wSnapshotId: string | null = null;
    try {
      const { freezeWeekly13wSnapshot, mondayOfWeek } = await import(
        "../../src/lib/cashflow/rolling-13w-engine"
      );
      const weekMonday = mondayOfWeek(todayISO);
      const isMonday = todayISO === weekMonday;
      const existingSnap = await deps.pool.query<{ id: string; as_of_date?: string }>(
        `select id::text, to_char(as_of_date, 'YYYY-MM-DD') as as_of_date
           from public.forecast_snapshots_13w
          where snapshot_week_start = $1::date and currency = 'TRY'
          limit 1`,
        [weekMonday],
      );
      const hasExisting = (existingSnap.rowCount ?? existingSnap.rows.length) > 0;
      const staleMondaySnap =
        isMonday &&
        hasExisting &&
        typeof existingSnap.rows[0]?.as_of_date === "string" &&
        existingSnap.rows[0].as_of_date !== todayISO;
      if (!hasExisting || staleMondaySnap) {
        const snap = await freezeWeekly13wSnapshot(deps.pool, {
          asOfDate: todayISO,
          currency: "TRY",
          actor: null,
        });
        weekly13wSnapshotId = snap.snapshotId;
      } else {
        weekly13wSnapshotId = existingSnap.rows[0]?.id ?? null;
      }
    } catch {
      weekly13wSnapshotId = null;
    }

    const dailyStats = {
      todayISO,
      instancesCreated: windowRes.reduce((s, r) => s + r.created, 0),
      loanInstallmentsMarkedLate: loanRollover.transitionedToLate,
      promisesMarkedBroken: brokenPromises.markedBroken,
      controlsAlertsRaisedOrUpdated: controls.alertsRaisedOrUpdated,
      fxSync,
      managementLedgerSync,
      dailyReportId,
      dailyReportCreated,
      weekly13wSnapshotId,
      automated: true,
      actorLabel: "system:background-worker",
    };

    await audit(deps.pool, {
      actor: deps.systemActorId,
      action: "background_daily_maintenance",
      entityTable: "background_jobs",
      entityId: null,
      after: dailyStats,
    });

    details.daily = dailyStats;
    state.lastDailyDate = todayISO;
  }

  state.updatedAt = new Date().toISOString();
  await writeWorkerScheduleStateAtomic(statePath, state);

  return {
    hourlyRan: shouldRunHourly,
    dailyRan: shouldRunDaily,
    todayISO,
    hourSlot,
    details,
  };
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

        if (!skipMaintenance) {
          const maint = await runScheduledMaintenance({
            pool,
            systemActorId,
            force: forceMaintenance,
          });
          if (maint.hourlyRan || maint.dailyRan) {
            log.info("background_worker_maintenance", {
              hourlyRan: maint.hourlyRan,
              dailyRan: maint.dailyRan,
              todayISO: maint.todayISO,
              hourSlot: maint.hourSlot,
            });
          }
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
