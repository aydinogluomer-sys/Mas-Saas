// Faz 51 / Faz 52 / Faz 54 — Kapalı Çevrim Günlük Otomasyon Hattı Birim & Entegrasyon Testleri
// (Paraşüt + Hibrit Banka -> TCMB Kur -> TDHP Yönetim Defteri & Kur Değerleme -> 13-Hafta Nakit Tahmini).
//
// Sıfır canlı PostgreSQL ve sıfır dış ağ çağrısı: tüm senaryolar bellek-içi SQL durum makinesi
// ve bağımlılık enjeksiyonu ile deterministik olarak doğrulanır.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface InMemoryInvoice {
  id: string;
  direction: "sales" | "purchase";
  invoice_no: string;
  party_id: string | null;
  department_id: string | null;
  issue_date: string;
  currency: string;
  net_amount: string | null;
  tax_amount: string | null;
  gross_amount: string;
  withholding_amount: string | null;
  vat_withholding_amount: string | null;
  payable_amount: string | null;
  status: "open" | "partial" | "paid";
  spender_employee_name: string | null;
}

interface InMemoryBankTransaction {
  id: string;
  txn_date: string;
  amount: string;
  currency: string;
  description: string | null;
  transaction_kind: "standard" | "own_transfer" | "bank_fee" | "tax_payment" | "payroll";
}

interface InMemoryJournalEntry {
  id: string;
  entry_no: number;
  entry_date: string;
  source_type: string;
  source_id: string | null;
  idempotency_key: string;
  status: "draft" | "provisional_fx" | "posted" | "reversed";
  needs_tax_split_review: boolean;
  description: string;
}

interface InMemoryJournalLine {
  id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  native_currency: string;
  debit_native: string;
  credit_native: string;
  fx_rate: string | null;
  debit_try: string | null;
  credit_try: string | null;
}

interface InMemoryFxRate {
  base_currency: string;
  quote_currency: string;
  rate_date: string;
  rate: string;
}

interface InMemorySnapshot13w {
  id: string;
  snapshot_week_start: string;
  as_of_date: string;
  currency: string;
}

interface InMemoryAuditRow {
  action: string;
  entityTable: string;
  entityId: string | null;
  after: unknown;
}

interface InMemoryFinancialState {
  failLedgerSchema?: boolean;
  timeline: string[];
  invoices: InMemoryInvoice[];
  bankTransactions: InMemoryBankTransaction[];
  journalEntries: InMemoryJournalEntry[];
  journalLines: InMemoryJournalLine[];
  fxRates: InMemoryFxRate[];
  snapshots13w: InMemorySnapshot13w[];
  dailyReports: Array<{ id: string; period_start: string }>;
  auditLogs: InMemoryAuditRow[];
}

let activeState: InMemoryFinancialState | null = null;

vi.mock("@/lib/importers/v2/async-runner", () => ({
  sweepStaleStagedFiles: vi.fn(async () => {
    activeState?.timeline.push("sweepStaleStagedFiles");
    return { removed: 0 };
  }),
}));

vi.mock("@/lib/reminders/engine", () => ({
  scheduleReminders: vi.fn(async () => {
    activeState?.timeline.push("scheduleReminders");
    return 2;
  }),
  dispatchPending: vi.fn(async () => {
    activeState?.timeline.push("dispatchPending");
    return 2;
  }),
}));

vi.mock("@/lib/cashflow/engine", () => ({
  validateContinuity: vi.fn(async () => {
    activeState?.timeline.push("validateContinuity");
  }),
}));

vi.mock("@/lib/home/overview-snapshot", () => ({
  loadOverviewSnapshot: vi.fn(async () => {
    activeState?.timeline.push("loadOverviewSnapshot");
    return {};
  }),
}));

vi.mock("@/lib/integrations/engine", () => ({
  enqueueDueSyncs: vi.fn(async () => {
    activeState?.timeline.push("enqueueDueSyncs");
    return { enqueued: 1, skipped: 0 };
  }),
}));

vi.mock("@/lib/radar/engine", () => ({
  ensureWindow: vi.fn(async () => {
    activeState?.timeline.push("ensureWindow");
    return [{ created: 3 }];
  }),
}));

vi.mock("@/lib/collections/promises-engine", () => ({
  detectBrokenPromises: vi.fn(async () => {
    activeState?.timeline.push("detectBrokenPromises");
    return { markedBroken: 1 };
  }),
}));

vi.mock("@/lib/controls/engine", () => ({
  loadControlDashboard: vi.fn(async () => {
    activeState?.timeline.push("loadControlDashboard");
    return [];
  }),
  raiseAlert: vi.fn(async () => undefined),
}));

vi.mock("@/lib/fx/provider", () => ({
  tcmbProvider: vi.fn(() => ({ name: "mock-tcmb" })),
  providerFor: vi.fn(() => ({ name: "mock-tcmb" })),
}));

vi.mock("@/lib/fx/engine", () => ({
  importRates: vi.fn(async (_pool: unknown, _provider: unknown, todayISO: string) => {
    activeState?.timeline.push("importRates");
    activeState?.fxRates.push({
      base_currency: "USD",
      quote_currency: "TRY",
      rate_date: todayISO,
      rate: "42.5000",
    });
    return {
      ok: true,
      rateDate: todayISO,
      inserted: 1,
      skipped: 0,
    };
  }),
}));

vi.mock("@/lib/reports/engine", () => ({
  generateDaily: vi.fn(async (_pool: unknown, todayISO: string) => {
    activeState?.timeline.push("generateDaily");
    const reportId = `rep-${todayISO}`;
    activeState?.dailyReports.push({ id: reportId, period_start: todayISO });
    return { id: reportId };
  }),
}));

vi.mock("@/lib/cashflow/rolling-13w-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cashflow/rolling-13w-engine")>();
  return {
    ...actual,
    freezeWeekly13wSnapshot: vi.fn(
      async (
        _pool: unknown,
        opts: { asOfDate?: string; currency?: string; actor?: string | null } = {},
      ) => {
        const asOfDate = opts.asOfDate ?? "2026-11-09";
        const currency = (opts.currency ?? "TRY").toUpperCase();
        const snapshotWeekStart = actual.mondayOfWeek(asOfDate);
        activeState?.timeline.push(`freezeWeekly13wSnapshot:${currency}:${snapshotWeekStart}`);

        const snapshotId = `snap-${snapshotWeekStart}-${currency}`;
        if (activeState) {
          const existingIdx = activeState.snapshots13w.findIndex(
            (s) => s.snapshot_week_start === snapshotWeekStart && s.currency === currency,
          );
          const row: InMemorySnapshot13w = {
            id: snapshotId,
            snapshot_week_start: snapshotWeekStart,
            as_of_date: asOfDate,
            currency,
          };
          if (existingIdx >= 0) {
            activeState.snapshots13w[existingIdx] = row;
          } else {
            activeState.snapshots13w.push(row);
          }
        }

        return {
          snapshotId,
          snapshotWeekStart,
          asOfDate,
          currency,
          openingCash: 150000,
          unknownOpeningCount: 0,
          lineCount: 6,
          totalInflow: 85000,
          totalOutflow: 32000,
          totalNetFlow: 53000,
        };
      },
    ),
  };
});

import { freezeWeekly13wSnapshot } from "@/lib/cashflow/rolling-13w-engine";
import { runClosedLoopFinancialPipeline } from "@/lib/integrations/parasut/sync-pipeline";
import { rebuildOrSyncManagementLedger } from "@/lib/ledger/posting-engine";
import { runScheduledMaintenance } from "../../scripts/ops/background-worker";

function createInMemoryFinancialPool(state: InMemoryFinancialState): Pool {
  let seq = 1;

  const executeQuery = async (sqlRaw: string, values: unknown[] = []) => {
    const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();

    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [], rowCount: 0 };
    }

    if (
      state.failLedgerSchema &&
      (sql.includes("public.management_journal_entries") ||
        sql.includes("public.management_accounts") ||
        (sql.includes("from public.invoices i") && sql.includes("public.cashflow_months")))
    ) {
      const err = Object.assign(
        new Error('relation "public.management_journal_entries" does not exist'),
        { code: "42P01" },
      );
      throw err;
    }

    // 1. Audit writer
    if (sql.startsWith("insert into public.audit_logs")) {
      const action = String(values[1] ?? "");
      const entityTable = String(values[2] ?? "");
      const entityId = (values[3] as string | null) ?? null;
      const afterRaw = values[5];
      let parsedAfter: unknown = null;
      if (typeof afterRaw === "string") {
        try {
          parsedAfter = JSON.parse(afterRaw);
        } catch {
          parsedAfter = afterRaw;
        }
      }
      state.auditLogs.push({ action, entityTable, entityId, after: parsedAfter });
      state.timeline.push(`audit:${action}`);
      return { rows: [{ id: `aud-${seq++}` }], rowCount: 1 };
    }

    // 2. Overdue loan installment rollover check in background-worker
    if (sql.includes("from public.loan_installments") && sql.includes("status = 'planned'")) {
      return { rows: [], rowCount: 0 };
    }

    // 3. Bulk ledger sync list queries
    if (sql.includes("select i.id::text from public.invoices i")) {
      state.timeline.push("ledger:scan_invoices");
      const rows = state.invoices.map((i) => ({ id: i.id }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("from public.invoices where id = $1")) {
      const id = String(values[0] ?? "");
      const found = state.invoices.find((i) => i.id === id);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (sql.includes("select bt.id::text from public.bank_transactions bt")) {
      const rows = state.bankTransactions.map((t) => ({ id: t.id }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("from public.bank_transactions where id = $1")) {
      const id = String(values[0] ?? "");
      const found = state.bankTransactions.find((t) => t.id === id);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (sql.includes("select cb.id::text from public.check_bordros cb")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("select li.id::text from public.loan_installments li")) {
      return { rows: [], rowCount: 0 };
    }

    // 4. Management accounts lookup
    if (sql.includes("from public.management_accounts where code = $1")) {
      const code = String(values[0] ?? "");
      return { rows: [{ id: `acc-${code}` }], rowCount: 1 };
    }

    // 5. FX rate snapshot lookup (on or before entry_date)
    if (sql.includes("from public.fx_rate_snapshots")) {
      const baseCurrency = String(values[0] ?? "").toUpperCase();
      const entryDate = String(values[1] ?? "");
      const matching = state.fxRates
        .filter(
          (r) =>
            r.base_currency === baseCurrency &&
            r.quote_currency === "TRY" &&
            r.rate_date <= entryDate,
        )
        .sort((a, b) => b.rate_date.localeCompare(a.rate_date));
      return {
        rows: matching[0] ? [{ rate: matching[0].rate }] : [],
        rowCount: matching[0] ? 1 : 0,
      };
    }

    // 6. Journal entry idempotency lookup
    if (
      sql.includes("from public.management_journal_entries") &&
      sql.includes("where idempotency_key = $1")
    ) {
      const key = String(values[0] ?? "");
      const existing = state.journalEntries.find((e) => e.idempotency_key === key);
      return {
        rows: existing
          ? [
              {
                id: existing.id,
                entry_no: String(existing.entry_no),
                status: existing.status,
                needs_tax_split_review: existing.needs_tax_split_review,
              },
            ]
          : [],
        rowCount: existing ? 1 : 0,
      };
    }

    // 7. Insert management journal entry
    if (sql.startsWith("insert into public.management_journal_entries")) {
      const entryNo = state.journalEntries.length + 1;
      const entry: InMemoryJournalEntry = {
        id: `je-${entryNo}`,
        entry_no: entryNo,
        entry_date: String(values[0] ?? ""),
        source_type: String(values[1] ?? ""),
        source_id: (values[2] as string | null) ?? null,
        idempotency_key: String(values[3] ?? ""),
        status: values[4] as InMemoryJournalEntry["status"],
        needs_tax_split_review: Boolean(values[5]),
        description: String(values[6] ?? ""),
      };
      state.journalEntries.push(entry);
      return {
        rows: [{ id: entry.id, entry_no: String(entry.entry_no), status: entry.status }],
        rowCount: 1,
      };
    }

    // 8. Insert management journal line
    if (sql.startsWith("insert into public.management_journal_lines")) {
      const line: InMemoryJournalLine = {
        id: `jl-${state.journalLines.length + 1}`,
        entry_id: String(values[0] ?? ""),
        line_no: Number(values[1] ?? 1),
        account_id: String(values[2] ?? ""),
        native_currency: String(values[7] ?? "TRY"),
        debit_native: String(values[8] ?? "0.00"),
        credit_native: String(values[9] ?? "0.00"),
        fx_rate: values[10] == null ? null : String(values[10]),
        debit_try: values[11] == null ? null : String(values[11]),
        credit_try: values[12] == null ? null : String(values[12]),
      };
      state.journalLines.push(line);
      return { rows: [], rowCount: 1 };
    }

    // 9. Select provisional_fx entries for revaluation
    if (
      sql.includes("from public.management_journal_entries") &&
      sql.includes("where status = 'provisional_fx'")
    ) {
      const rows = state.journalEntries
        .filter((e) => e.status === "provisional_fx")
        .map((e) => ({ id: e.id, entry_date: e.entry_date }));
      return { rows, rowCount: rows.length };
    }

    // 10. Select journal lines for provisional_fx entry
    if (sql.includes("from public.management_journal_lines where entry_id = $1")) {
      const entryId = String(values[0] ?? "");
      const rows = state.journalLines
        .filter((l) => l.entry_id === entryId)
        .sort((a, b) => a.line_no - b.line_no)
        .map((l) => ({
          id: l.id,
          native_currency: l.native_currency,
          debit_native: l.debit_native,
          credit_native: l.credit_native,
        }));
      return { rows, rowCount: rows.length };
    }

    // 11. Update journal line TRY valuation
    if (sql.startsWith("update public.management_journal_lines")) {
      const lineId = String(values[0] ?? "");
      const target = state.journalLines.find((l) => l.id === lineId);
      if (target) {
        target.fx_rate = String(values[1]);
        target.debit_try = String(values[2]);
        target.credit_try = String(values[3]);
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }

    // 12. Transition journal entry provisional_fx -> posted
    if (
      sql.startsWith("update public.management_journal_entries") &&
      sql.includes("set status = 'posted'")
    ) {
      const entryId = String(values[0] ?? "");
      const target = state.journalEntries.find((e) => e.id === entryId);
      if (target) {
        target.status = "posted";
        state.timeline.push(`revalued:${entryId}->posted`);
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }

    // 13. Daily report existence check
    if (sql.includes("from public.reports where report_type = 'daily'")) {
      const periodStart = String(values[0] ?? "");
      const found = state.dailyReports.find((r) => r.period_start === periodStart);
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
    }

    // 14. 13-week snapshot existence check
    if (sql.includes("from public.forecast_snapshots_13w")) {
      const weekStart = String(values[0] ?? "");
      const currency = values[1] ? String(values[1]).toUpperCase() : "TRY";
      const found = state.snapshots13w.find(
        (s) => s.snapshot_week_start === weekStart && s.currency === currency,
      );
      return {
        rows: found ? [{ id: found.id, as_of_date: found.as_of_date }] : [],
        rowCount: found ? 1 : 0,
      };
    }

    throw new Error(`Beklenmeyen SQL sorgusu (mock): ${sqlRaw}`);
  };

  const fakeClient = {
    query: executeQuery,
    release: () => undefined,
  };

  return {
    connect: async () => fakeClient,
    query: executeQuery,
  } as unknown as Pool;
}

function createInitialState(): InMemoryFinancialState {
  return {
    timeline: [],
    invoices: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        direction: "sales",
        invoice_no: "GIB2026000001051",
        party_id: "22222222-2222-4222-8222-222222222222",
        department_id: null,
        issue_date: "2026-11-09",
        currency: "USD",
        net_amount: "1000.00",
        tax_amount: "200.00",
        gross_amount: "1200.00",
        withholding_amount: null,
        vat_withholding_amount: null,
        payable_amount: "1200.00",
        status: "open",
        spender_employee_name: null,
      },
    ],
    bankTransactions: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        txn_date: "2026-11-09",
        amount: "-45.00",
        currency: "TRY",
        description: "EFT / Havale Masrafı",
        transaction_kind: "bank_fee",
      },
    ],
    journalEntries: [],
    journalLines: [],
    fxRates: [],
    snapshots13w: [],
    dailyReports: [],
    auditLogs: [],
  };
}

describe("Kapalı Çevrim Günlük Otomasyon Hattı (Paraşüt + Banka + TDHP Defter + 13-Hafta)", () => {
  const actorId = "99999999-9999-4999-8999-999999999999";
  let tempDir = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    activeState = createInitialState();
    tempDir = await mkdtemp(path.join(os.tmpdir(), "mas-closed-loop-"));
  });

  afterEach(async () => {
    activeState = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("sıralama garantisi ve Pazartesi idempotentliği: TCMB kur -> TDHP defter (provisional_fx -> posted) -> 13-hafta dondurma sırasıyla çalışır ve aynı Pazartesi ikinci koşuda kayıt çoğaltmaz", async () => {
    const state = activeState!;
    const pool = createInMemoryFinancialPool(state);

    // Adım 0: Sabah TCMB kuru henüz gelmeden saatlik senkron USD faturayı provisional_fx olarak kaydeder
    const preFxSync = await rebuildOrSyncManagementLedger(pool, actorId);
    expect(preFxSync).toEqual({
      createdCount: 2, // 1 USD fatura (provisional_fx) + 1 TRY banka masrafı (posted)
      skippedCount: 0,
      revaluedCount: 0,
    });
    const usdEntryBefore = state.journalEntries.find((e) => e.source_type === "invoice");
    expect(usdEntryBefore?.status).toBe("provisional_fx");
    expect(
      state.journalLines
        .filter((l) => l.entry_id === usdEntryBefore?.id)
        .every((l) => l.debit_try === null && l.credit_try === null),
    ).toBe(true);

    state.timeline.length = 0;

    // Adım 1: 2026-11-09 Pazartesi 1. Kapalı Çevrim Koşusu (TCMB kur çekimi AÇIK)
    const firstMondayRun = await runClosedLoopFinancialPipeline(pool, actorId, {
      todayISO: "2026-11-09", // Pazartesi
      syncTcmbFxRates: true,
    });

    expect(firstMondayRun.ok).toBe(true);
    expect(firstMondayRun.executedSteps).toEqual([
      "enqueue_due_syncs",
      "tcmb_fx_sync",
      "management_ledger_sync",
      "freeze_13w_snapshot",
    ]);

    // Kesin sıralama kanıtı: importRates -> provisional_fx değerleme -> freezeWeekly13wSnapshot
    const fxIdx = state.timeline.indexOf("importRates");
    const revalueIdx = state.timeline.findIndex((t) => t.startsWith("revalued:"));
    const freezeIdx = state.timeline.findIndex((t) =>
      t.startsWith("freezeWeekly13wSnapshot:TRY:2026-11-09"),
    );
    expect(fxIdx).toBeGreaterThanOrEqual(0);
    expect(revalueIdx).toBeGreaterThan(fxIdx);
    expect(freezeIdx).toBeGreaterThan(revalueIdx);

    // USD provisional_fx fiş 42.50 kuruyla 'posted' durumuna geçmiş ve TRY tutarları hesaplanmış olmalı
    expect(firstMondayRun.managementLedger).toEqual({
      executed: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 1,
      error: null,
    });
    expect(usdEntryBefore?.status).toBe("posted");
    const usdLinesAfter = state.journalLines.filter((l) => l.entry_id === usdEntryBefore?.id);
    expect(usdLinesAfter.map((l) => ({ d: l.debit_try, c: l.credit_try }))).toEqual([
      { d: "51000.00", c: "0.00" }, // 120 Alıcılar: 1200 * 42.50
      { d: "0.00", c: "42500.00" }, // 600 Satışlar: 1000 * 42.50
      { d: "0.00", c: "8500.00" }, // 391 Hesaplanan KDV: 200 * 42.50
    ]);

    expect(firstMondayRun.forecast13w).toMatchObject({
      executed: true,
      weekMonday: "2026-11-09",
      isMonday: true,
      frozenCount: 1,
      reusedExistingCount: 0,
      primarySnapshotId: "snap-2026-11-09-TRY",
    });
    expect(state.snapshots13w).toHaveLength(1);
    expect(state.journalEntries).toHaveLength(2);

    // Adım 2: Aynı Pazartesi (2026-11-09) 2. kez çalıştırıldığında ne yevmiye fişi ne de 13w snapshot çoğalır!
    const secondMondayRun = await runClosedLoopFinancialPipeline(pool, actorId, {
      todayISO: "2026-11-09",
      syncTcmbFxRates: false,
    });

    expect(secondMondayRun.ok).toBe(true);
    expect(secondMondayRun.managementLedger).toEqual({
      executed: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 0,
      error: null,
    });
    expect(secondMondayRun.forecast13w).toMatchObject({
      executed: true,
      weekMonday: "2026-11-09",
      isMonday: true,
      frozenCount: 0,
      reusedExistingCount: 1,
      primarySnapshotId: "snap-2026-11-09-TRY",
    });
    expect(secondMondayRun.forecast13w.snapshots[0]?.reason).toBe("already_frozen");
    expect(vi.mocked(freezeWeekly13wSnapshot)).toHaveBeenCalledTimes(1);
    expect(state.snapshots13w).toHaveLength(1);
    expect(state.journalEntries).toHaveLength(2);
  });

  it("hafta ortasında (Çarşamba) o haftanın TRY baz çizgisi eksikse otomatik dondurur, mevcutsa yeniden dondurmaz", async () => {
    const state = activeState!;
    const pool = createInMemoryFinancialPool(state);

    // Çarşamba 2026-11-18 — Pazartesi (2026-11-16) baz çizgisi henüz yok -> missing_week_baseline olarak dondurmalı
    const wedRun = await runClosedLoopFinancialPipeline(pool, actorId, {
      todayISO: "2026-11-18",
      triggerDueIntegrationSyncs: false,
    });

    expect(wedRun.ok).toBe(true);
    expect(wedRun.forecast13w.weekMonday).toBe("2026-11-16");
    expect(wedRun.forecast13w.isMonday).toBe(false);
    expect(wedRun.forecast13w.frozenCount).toBe(1);
    expect(wedRun.forecast13w.snapshots[0]).toEqual({
      currency: "TRY",
      snapshotId: "snap-2026-11-16-TRY",
      frozen: true,
      reason: "missing_week_baseline",
    });

    // Perşembe 2026-11-19 — aynı haftanın baz çizgisi artık var -> already_frozen ile atlamalı
    const thuRun = await runClosedLoopFinancialPipeline(pool, actorId, {
      todayISO: "2026-11-19",
      triggerDueIntegrationSyncs: false,
    });

    expect(thuRun.ok).toBe(true);
    expect(thuRun.forecast13w.frozenCount).toBe(0);
    expect(thuRun.forecast13w.reusedExistingCount).toBe(1);
    expect(thuRun.forecast13w.snapshots[0]).toEqual({
      currency: "TRY",
      snapshotId: "snap-2026-11-16-TRY",
      frozen: false,
      reason: "already_frozen",
    });
  });

  it("background-worker runScheduledMaintenance: saatlik ve günlük bakımda managementLedgerSync metriklerini kaydeder ve günlük rapordan ÖNCE kur değerlemesini çalıştırır", async () => {
    const state = activeState!;
    const pool = createInMemoryFinancialPool(state);
    const statePath = path.join(tempDir, "worker-state.json");

    // 1. Önce yalnız saatlik bakım çalışsın (günlük daha önce çalışmış gibi simüle etmek için önce tam tur yerine saatlik/günlük birlikte veya sırayla kontrol edelim):
    // İlk olarak TCMB kuru kapalıyken saatlik + günlük tur (Pazar 2026-11-08): USD fatura provisional_fx olarak deftere işlenir
    const sundayMaint = await runScheduledMaintenance({
      pool,
      systemActorId: actorId,
      statePath,
      todayISO: "2026-11-08",
      hourSlot: "2026-11-08T23",
      enableTcmbSync: false,
    });

    expect(sundayMaint.hourlyRan).toBe(true);
    expect(sundayMaint.dailyRan).toBe(true);
    const sundayHourly = sundayMaint.details?.hourly as Record<string, unknown>;
    const sundayDaily = sundayMaint.details?.daily as Record<string, unknown>;

    // Saatlik tur ilk çalıştığı için 2 fişi (1 USD provisional_fx + 1 TRY posted) oluşturdu
    expect(sundayHourly.managementLedgerSync).toEqual({
      ok: true,
      createdCount: 2,
      skippedCount: 0,
      revaluedCount: 0,
      error: null,
    });
    // Günlük tur aynı süreçte hemen ardından çalıştığında mükerrer kayıt açmadan ikisini de atladı
    expect(sundayDaily.managementLedgerSync).toEqual({
      ok: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 0,
      error: null,
    });

    expect(state.journalEntries.find((e) => e.source_type === "invoice")?.status).toBe(
      "provisional_fx",
    );

    state.timeline.length = 0;

    // 2. Pazartesi 2026-11-09 sabahı TCMB kur çekimi AÇIK olarak bakım turu çalışır:
    // Saatlik turda henüz kur yok (revaluedCount: 0), günlük turda importRates -> rebuildOrSyncManagementLedger (revaluedCount: 1) -> generateDaily -> freezeWeekly13wSnapshot!
    const mondayMaint = await runScheduledMaintenance({
      pool,
      systemActorId: actorId,
      statePath,
      todayISO: "2026-11-09",
      hourSlot: "2026-11-09T09",
      enableTcmbSync: true,
    });

    expect(mondayMaint.hourlyRan).toBe(true);
    expect(mondayMaint.dailyRan).toBe(true);

    const mondayHourly = mondayMaint.details?.hourly as Record<string, unknown>;
    const mondayDaily = mondayMaint.details?.daily as Record<string, unknown>;

    expect(mondayHourly.managementLedgerSync).toEqual({
      ok: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 0,
      error: null,
    });
    expect(mondayDaily.managementLedgerSync).toEqual({
      ok: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 1,
      error: null,
    });
    expect(mondayDaily.weekly13wSnapshotId).toBe("snap-2026-11-09-TRY");

    // Günlük tur içindeki kesin sıra: importRates -> revalued:je-1->posted -> generateDaily -> freezeWeekly13wSnapshot -> audit:background_daily_maintenance
    const importRatesIdx = state.timeline.indexOf("importRates");
    const revaluedIdx = state.timeline.indexOf("revalued:je-1->posted");
    const generateDailyIdx = state.timeline.indexOf("generateDaily");
    const freezeIdx = state.timeline.indexOf("freezeWeekly13wSnapshot:TRY:2026-11-09");
    const dailyAuditIdx = state.timeline.indexOf("audit:background_daily_maintenance");

    expect(importRatesIdx).toBeGreaterThanOrEqual(0);
    expect(revaluedIdx).toBeGreaterThan(importRatesIdx);
    expect(generateDailyIdx).toBeGreaterThan(revaluedIdx);
    expect(freezeIdx).toBeGreaterThan(generateDailyIdx);
    expect(dailyAuditIdx).toBeGreaterThan(freezeIdx);

    // Denetim izi de Pazartesi bakımının managementLedgerSync sayacını taşımalı
    const maintAudits = state.auditLogs.filter((a) => a.action === "background_daily_maintenance");
    expect(maintAudits).toHaveLength(2);
    expect((maintAudits[1]?.after as Record<string, unknown>)?.managementLedgerSync).toEqual({
      ok: true,
      createdCount: 0,
      skippedCount: 2,
      revaluedCount: 1,
      error: null,
    });
  });

  it("0105 öncesi eksik şema (42P01) durumunda işçiyi ve kapalı çevrim hattını çökertmeden hatayı izole eder; strict=true iken fırlatır", async () => {
    const state = activeState!;
    state.failLedgerSchema = true;
    const pool = createInMemoryFinancialPool(state);
    const statePath = path.join(tempDir, "legacy-state.json");

    const isolated = await runClosedLoopFinancialPipeline(pool, actorId, {
      todayISO: "2026-11-09",
    });
    expect(isolated.ok).toBe(false);
    expect(isolated.managementLedger.executed).toBe(false);
    expect(isolated.managementLedger.error).toContain("management_journal_entries");
    expect(isolated.forecast13w.executed).toBe(true);
    expect(isolated.forecast13w.frozenCount).toBe(1);

    await expect(
      runClosedLoopFinancialPipeline(pool, actorId, {
        todayISO: "2026-11-09",
        strict: true,
      }),
    ).rejects.toThrow(/management_journal_entries/);

    const maint = await runScheduledMaintenance({
      pool,
      systemActorId: actorId,
      statePath,
      todayISO: "2026-11-09",
      hourSlot: "2026-11-09T10",
      enableTcmbSync: false,
    });
    expect(maint.hourlyRan).toBe(true);
    expect(maint.dailyRan).toBe(true);
    const daily = maint.details?.daily as Record<string, unknown>;
    expect(daily.dailyReportCreated).toBe(true);
    expect(daily.managementLedgerSync).toMatchObject({
      ok: false,
      createdCount: 0,
      skippedCount: 0,
      revaluedCount: 0,
    });
  });
});
