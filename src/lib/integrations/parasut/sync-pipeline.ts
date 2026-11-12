// Faz 51 / Faz 52 / Faz 54 — Kapalı Çevrim Günlük Otomasyon Hattı
// (Paraşüt v4 + Hibrit Banka -> TCMB Kur -> TDHP Yönetim Defteri & Kur Değerleme -> 13-Hafta Nakit Tahmini).
//
// Bu orkestratör ağa doğrudan çıkmaz, process.env okumaz ve tüm adımları deterministik,
// idempotent ve hata-izole biçimde sırayla yürütür.

import type { Pool } from "pg";
import {
  freezeWeekly13wSnapshot,
  mondayOfWeek,
  type FreezeWeekly13wSnapshotResult,
} from "@/lib/cashflow/rolling-13w-engine";
import { DomainError } from "@/lib/domain-error";
import { importRates } from "@/lib/fx/engine";
import { providerFor } from "@/lib/fx/provider";
import { enqueueDueSyncs } from "@/lib/integrations/engine";
import { rebuildOrSyncManagementLedger } from "@/lib/ledger/posting-engine";

export type ClosedLoopStepName =
  | "enqueue_due_syncs"
  | "tcmb_fx_sync"
  | "management_ledger_sync"
  | "freeze_13w_snapshot";

export interface ClosedLoopPipelineDeps {
  enqueueDueSyncs?: (
    pool: Pool,
    actorId: string | null,
    asOfISO?: string,
  ) => Promise<{ enqueued: number; skipped: number }>;
  importTcmbRates?: (
    pool: Pool,
    asOfISO: string,
    actorId: string,
  ) => Promise<{
    ok: boolean;
    rateDate: string | null;
    inserted: number;
    skipped: number;
    error?: string;
  }>;
  rebuildOrSyncManagementLedger?: (
    pool: Pool,
    actorId: string | null,
  ) => Promise<{
    createdCount: number;
    skippedCount: number;
    revaluedCount: number;
  }>;
  mondayOfWeek?: (isoDate: string) => string;
  freezeWeekly13wSnapshot?: (
    pool: Pool,
    options: {
      asOfDate?: string;
      currency?: string;
      actor?: string | null;
    },
  ) => Promise<FreezeWeekly13wSnapshotResult>;
}

export interface ClosedLoopPipelineOptions {
  todayISO: string;
  triggerDueIntegrationSyncs?: boolean;
  syncTcmbFxRates?: boolean;
  syncManagementLedger?: boolean;
  freezeMonday13w?: boolean;
  forceRefreeze13w?: boolean;
  currenciesFor13w?: readonly string[];
  strict?: boolean;
  deps?: ClosedLoopPipelineDeps;
}

export interface ClosedLoopSnapshotItem {
  currency: string;
  snapshotId: string | null;
  frozen: boolean;
  reason: "monday_schedule" | "missing_week_baseline" | "already_frozen";
}

export interface ClosedLoopPipelineSummary {
  ok: boolean;
  todayISO: string;
  executedSteps: ClosedLoopStepName[];
  integrationSyncs: {
    executed: boolean;
    enqueued: number;
    skipped: number;
    error: string | null;
  };
  fxSync: {
    executed: boolean;
    ok: boolean | null;
    rateDate: string | null;
    inserted: number;
    skipped: number;
    error: string | null;
  };
  managementLedger: {
    executed: boolean;
    createdCount: number;
    skippedCount: number;
    revaluedCount: number;
    error: string | null;
  };
  forecast13w: {
    executed: boolean;
    weekMonday: string | null;
    isMonday: boolean;
    frozenCount: number;
    reusedExistingCount: number;
    primarySnapshotId: string | null;
    snapshots: ClosedLoopSnapshotItem[];
    error: string | null;
  };
  errors: Array<{ step: ClosedLoopStepName; message: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeCurrencyList(raw: readonly string[] | undefined): string[] {
  const source = raw && raw.length > 0 ? raw : ["TRY"];
  const normalized: string[] = [];
  for (const item of source) {
    const clean = item.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(clean)) {
      throw new DomainError("VALIDATION", `Geçersiz 13-hafta para birimi kodu: ${item}`);
    }
    if (!normalized.includes(clean)) {
      normalized.push(clean);
    }
  }
  return normalized;
}

/**
 * Runs the idempotent closed-loop financial automation pipeline:
 *   1. Enqueues overdue integration syncs (Paraşüt v4 / Bank API / e-Fatura / TCMB)
 *   2. Optionally fetches TCMB FX bulletin rates before ledger valuation (`syncTcmbFxRates === true`)
 *   3. Syncs operational invoices, hybrid bank transactions, check bordros, and paid loan installments
 *      into TDHP `management_journal_entries`, immediately revaluing `provisional_fx` -> `posted`
 *   4. Freezes the weekly 13-week direct cash forecast baseline on Mondays (or when the current week's
 *      baseline snapshot is missing), without duplicating snapshots on repeated Monday runs
 */
export async function runClosedLoopFinancialPipeline(
  pool: Pool,
  actorId: string,
  options: ClosedLoopPipelineOptions,
): Promise<ClosedLoopPipelineSummary> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.todayISO)) {
    throw new DomainError(
      "VALIDATION",
      `Geçersiz tarih biçimi (YYYY-MM-DD bekleniyor): ${options.todayISO}`,
    );
  }

  const currencies = normalizeCurrencyList(options.currenciesFor13w);
  const strict = Boolean(options.strict);
  const deps = options.deps ?? {};

  const enqueueFn = deps.enqueueDueSyncs ?? enqueueDueSyncs;
  const importTcmbFn =
    deps.importTcmbRates ??
    (async (p: Pool, asOfISO: string, actor: string) =>
      importRates(p, providerFor("tcmb"), asOfISO, actor));
  const syncLedgerFn = deps.rebuildOrSyncManagementLedger ?? rebuildOrSyncManagementLedger;
  const mondayFn = deps.mondayOfWeek ?? mondayOfWeek;
  const freeze13wFn = deps.freezeWeekly13wSnapshot ?? freezeWeekly13wSnapshot;

  const executedSteps: ClosedLoopStepName[] = [];
  const errors: Array<{ step: ClosedLoopStepName; message: string }> = [];

  const summary: ClosedLoopPipelineSummary = {
    ok: true,
    todayISO: options.todayISO,
    executedSteps,
    integrationSyncs: {
      executed: false,
      enqueued: 0,
      skipped: 0,
      error: null,
    },
    fxSync: {
      executed: false,
      ok: null,
      rateDate: null,
      inserted: 0,
      skipped: 0,
      error: null,
    },
    managementLedger: {
      executed: false,
      createdCount: 0,
      skippedCount: 0,
      revaluedCount: 0,
      error: null,
    },
    forecast13w: {
      executed: false,
      weekMonday: null,
      isMonday: false,
      frozenCount: 0,
      reusedExistingCount: 0,
      primarySnapshotId: null,
      snapshots: [],
      error: null,
    },
    errors,
  };

  // Step 1: Due Integration Sync Enqueue
  if (options.triggerDueIntegrationSyncs !== false) {
    try {
      const res = await enqueueFn(pool, actorId, options.todayISO);
      executedSteps.push("enqueue_due_syncs");
      summary.integrationSyncs = {
        executed: true,
        enqueued: res.enqueued,
        skipped: res.skipped,
        error: null,
      };
    } catch (err) {
      if (strict) throw err;
      const msg = errorMessage(err);
      summary.integrationSyncs = {
        executed: false,
        enqueued: 0,
        skipped: 0,
        error: msg,
      };
      errors.push({ step: "enqueue_due_syncs", message: msg });
    }
  }

  // Optional Step 1b: TCMB FX Rate Sync (always executed BEFORE management ledger revaluation)
  if (options.syncTcmbFxRates === true) {
    try {
      const fx = await importTcmbFn(pool, options.todayISO, actorId);
      executedSteps.push("tcmb_fx_sync");
      summary.fxSync = {
        executed: true,
        ok: fx.ok,
        rateDate: fx.rateDate,
        inserted: fx.inserted,
        skipped: fx.skipped,
        error: fx.ok ? null : (fx.error ?? "TCMB kur çekimi tamamlanamadı"),
      };
      if (!fx.ok) {
        const msg = fx.error ?? "TCMB kur çekimi tamamlanamadı";
        if (strict) {
          throw new Error(msg);
        }
        errors.push({ step: "tcmb_fx_sync", message: msg });
      }
    } catch (err) {
      if (strict) throw err;
      const msg = errorMessage(err);
      summary.fxSync = {
        executed: false,
        ok: false,
        rateDate: null,
        inserted: 0,
        skipped: 0,
        error: msg,
      };
      errors.push({ step: "tcmb_fx_sync", message: msg });
    }
  }

  // Step 2: TDHP Management Ledger Sync & Provisional FX Revaluation
  if (options.syncManagementLedger !== false) {
    try {
      const ledger = await syncLedgerFn(pool, actorId);
      executedSteps.push("management_ledger_sync");
      summary.managementLedger = {
        executed: true,
        createdCount: ledger.createdCount,
        skippedCount: ledger.skippedCount,
        revaluedCount: ledger.revaluedCount,
        error: null,
      };
    } catch (err) {
      if (strict) throw err;
      const msg = errorMessage(err);
      summary.managementLedger = {
        executed: false,
        createdCount: 0,
        skippedCount: 0,
        revaluedCount: 0,
        error: msg,
      };
      errors.push({ step: "management_ledger_sync", message: msg });
    }
  }

  // Step 3: Weekly 13-Week Direct Cash Forecast Snapshot Freeze (Monday or missing baseline)
  if (options.freezeMonday13w !== false) {
    const weekMonday = mondayFn(options.todayISO);
    const isMonday = options.todayISO === weekMonday;
    summary.forecast13w.weekMonday = weekMonday;
    summary.forecast13w.isMonday = isMonday;

    try {
      const snapshots: ClosedLoopSnapshotItem[] = [];
      let frozenCount = 0;
      let reusedExistingCount = 0;

      for (const currency of currencies) {
        const existingSnap = await pool.query<{ id: string; as_of_date?: string }>(
          `select id::text as id, to_char(as_of_date, 'YYYY-MM-DD') as as_of_date
             from public.forecast_snapshots_13w
            where snapshot_week_start = $1::date and currency = $2
            limit 1`,
          [weekMonday, currency],
        );

        const existingRow = existingSnap.rows[0];
        const hasExisting = (existingSnap.rowCount ?? existingSnap.rows.length) > 0;
        const staleMondaySnapshot =
          isMonday &&
          hasExisting &&
          typeof existingRow?.as_of_date === "string" &&
          existingRow.as_of_date !== options.todayISO;

        const shouldFreeze =
          Boolean(options.forceRefreeze13w) || !hasExisting || staleMondaySnapshot;

        if (shouldFreeze) {
          const snap = await freeze13wFn(pool, {
            asOfDate: options.todayISO,
            currency,
            actor: actorId || null,
          });
          frozenCount += 1;
          snapshots.push({
            currency,
            snapshotId: snap.snapshotId,
            frozen: true,
            reason: isMonday ? "monday_schedule" : "missing_week_baseline",
          });
        } else {
          reusedExistingCount += 1;
          snapshots.push({
            currency,
            snapshotId: existingRow?.id ?? null,
            frozen: false,
            reason: "already_frozen",
          });
        }
      }

      executedSteps.push("freeze_13w_snapshot");
      summary.forecast13w = {
        executed: true,
        weekMonday,
        isMonday,
        frozenCount,
        reusedExistingCount,
        primarySnapshotId: snapshots[0]?.snapshotId ?? null,
        snapshots,
        error: null,
      };
    } catch (err) {
      if (strict) throw err;
      const msg = errorMessage(err);
      summary.forecast13w = {
        executed: false,
        weekMonday,
        isMonday,
        frozenCount: 0,
        reusedExistingCount: 0,
        primarySnapshotId: null,
        snapshots: [],
        error: msg,
      };
      errors.push({ step: "freeze_13w_snapshot", message: msg });
    }
  }

  summary.ok = errors.length === 0;
  return summary;
}
