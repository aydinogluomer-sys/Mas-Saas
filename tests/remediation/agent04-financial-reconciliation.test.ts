import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadHybridCashMonths } from "@/lib/cashflow/live-hybrid";
import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { loadCanonicalKpis } from "@/lib/metrics/canonical-kpis";
import { round2, sumMoney } from "@/lib/money";
import {
  distribution,
  mapInstanceRow,
  missingAmountInstances,
  monthInstances,
  monthSummary,
  overdueOpen,
  type DistributionBy,
} from "@/lib/radar/queries";
import { loadFourWaySubledgerHealth } from "@/lib/reconciliation/four-way-health";
import { readEnvLocal } from "../../scripts/db/app-url";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

interface FinancialTableDigest {
  pi_count: number;
  pi_amount_sum: string;
  pi_paid_sum: string;
  payments_count: number;
  checks_count: number;
  checks_amount_sum: string;
  li_count: number;
  li_amount_sum: string;
  ca_count: number;
  bt_count: number;
}

function resolveOwnerReadOnlyUrl(): string {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    // Fallback to process.env when .env.local is absent.
  }
  const url =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    fileEnv.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    fileEnv.DATABASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error("MIGRATION_DATABASE_URL / DATABASE_URL tanımlı değil.");
  }
  return url;
}

async function captureFinancialDigest(pool: Pool): Promise<FinancialTableDigest> {
  const res = await pool.query<FinancialTableDigest>(`
    select
      (select count(*)::int from public.payment_instances) as pi_count,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_amount_sum,
      (select coalesce(sum(paid_amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_paid_sum,
      (select count(*)::int from public.payments) as payments_count,
      (select count(*)::int from public.checks) as checks_count,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.checks) as checks_amount_sum,
      (select count(*)::int from public.loan_installments) as li_count,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.loan_installments) as li_amount_sum,
      (select count(*)::int from public.cash_accounts) as ca_count,
      (select count(*)::int from public.bank_transactions) as bt_count
  `);
  return res.rows[0]!;
}

interface SyntheticLedgerRow {
  amount: number | null;
  paid_amount: number | null;
  status: string;
  cancelled_at: string | null;
  direction: string;
  currency: string;
}

function createMonthSummaryMockPool(rows: SyntheticLedgerRow[], omitOverpaymentColumn = false): Pool {
  return {
    async query(sql: string) {
      const normalized = sql.toLowerCase();
      expect(normalized).toContain("status <> 'cancelled'");
      expect(normalized).toContain("cancelled_at is null");
      expect(normalized).toContain("cancelled_known_total");
      expect(normalized).toContain("overpayment_adjustment_try");

      const activeOutflow = rows.filter(
        (r) =>
          r.status !== "cancelled" &&
          r.cancelled_at === null &&
          (r.direction || "outflow") === "outflow",
      );
      const activeKnownTry = activeOutflow.filter(
        (r) => r.amount !== null && r.currency === "TRY",
      );
      const cancelledOutflow = rows.filter(
        (r) =>
          (r.status === "cancelled" || r.cancelled_at !== null) &&
          (r.direction || "outflow") === "outflow",
      );

      const knownTotal = sumMoney(activeKnownTry.map((r) => r.amount));
      const knownRemaining = sumMoney(
        activeKnownTry
          .filter((r) => ["unpaid", "partial", "planned", "late"].includes(r.status))
          .map((r) => Math.max(round2((r.amount ?? 0) - (r.paid_amount ?? 0)), 0)),
      );
      const paidKnown = sumMoney(
        activeKnownTry.map((r) => {
          if (r.status === "paid") return r.paid_amount ?? r.amount ?? 0;
          if (r.status === "partial") return r.paid_amount ?? 0;
          return 0;
        }),
      );
      const settlementAdjustmentTry = sumMoney(
        activeKnownTry
          .filter((r) => r.status === "paid")
          .map((r) => Math.max(round2((r.amount ?? 0) - (r.paid_amount ?? r.amount ?? 0)), 0)),
      );
      const overpaymentAdjustmentTry = sumMoney(
        activeKnownTry
          .filter((r) => r.status === "paid" || r.status === "partial")
          .map((r) => Math.max(round2((r.paid_amount ?? 0) - (r.amount ?? 0)), 0)),
      );
      const cancelledKnownTotal = sumMoney(
        cancelledOutflow
          .filter((r) => r.amount !== null && r.currency === "TRY")
          .map((r) => r.amount),
      );

      const record: Record<string, unknown> = {
        known_total: knownTotal.toFixed(2),
        known_remaining: knownRemaining.toFixed(2),
        paid_known: paidKnown.toFixed(2),
        missing_count: activeOutflow.filter((r) => r.amount === null).length,
        foreign_count: activeOutflow.filter((r) => r.currency !== "TRY").length,
        total_count: activeOutflow.length,
        cancelled_count: cancelledOutflow.length,
        cancelled_known_total: cancelledKnownTotal.toFixed(2),
        settlement_adjustment_try: settlementAdjustmentTry.toFixed(2),
      };
      if (!omitOverpaymentColumn) {
        record.overpayment_adjustment_try = overpaymentAdjustmentTry.toFixed(2);
      }

      return { rows: [record], rowCount: 1 };
    },
  } as unknown as Pool;
}

function hasLiveDbConfig(): boolean {
  if (process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()) return true;
  try {
    const envLocal = readEnvLocal();
    return Boolean(envLocal.MIGRATION_DATABASE_URL?.trim() || envLocal.DATABASE_URL?.trim());
  } catch {
    return false;
  }
}

describe.skipIf(!hasLiveDbConfig())("Agent 04 — Financial Ledger, Reconciliation & Data Integrity Verification", () => {
  let ownerReadOnlyPool: Pool;
  let preTestDigest: FinancialTableDigest;

  beforeAll(async () => {
    ownerReadOnlyPool = new Pool({
      connectionString: resolveOwnerReadOnlyUrl(),
      max: 1,
      connectionTimeoutMillis: 30_000,
      options: "-c default_transaction_read_only=on",
    });
    const roRes = await ownerReadOnlyPool.query<{ transaction_read_only: string }>(
      "SHOW transaction_read_only",
    );
    expect(roRes.rows[0]?.transaction_read_only).toBe("on");
    preTestDigest = await captureFinancialDigest(ownerReadOnlyPool);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (ownerReadOnlyPool) {
      const postTestDigest = await captureFinancialDigest(ownerReadOnlyPool);
      expect(postTestDigest).toEqual(preTestDigest);
      await ownerReadOnlyPool.end();
    }
  });

  it("1. enforces Contract A & mapInstanceRow invariants: null never coerced to 0, partial/paid/discount/overpaid/cancelled decoded deterministically", () => {
    // Missing/unknown amount stays strictly null across original, paid, and remaining
    const missingMapped = mapInstanceRow({
      id: "pi-null-1",
      payment_id: "p-1",
      name: "MAS ELEKTRİK",
      due_date: "2026-11-03",
      amount: null,
      amount_status: "missing",
      status: "unpaid",
      paid_amount: null,
      risk_level: "low",
      risk_reasons: ["missing_amount"],
      note: null,
      currency: "TRY",
    });
    expect(missingMapped.amount).toBeNull();
    expect(missingMapped.paid_amount).toBeNull();
    expect(missingMapped.original_amount).toBeNull();
    expect(missingMapped.remaining_amount).toBeNull();
    expect(missingMapped.overpayment_amount).toBe(0);

    // Partial payment synthetic (30,000 original / 10,000 paid -> 20,000 remaining)
    const partial20k = mapInstanceRow({
      id: "pi-part-20k",
      payment_id: "p-2",
      name: "VAKIF KREDİ 2",
      due_date: "2026-11-10",
      amount: "30000.00",
      amount_status: "known",
      status: "partial",
      paid_amount: "10000.00",
      risk_level: "high",
      risk_reasons: ["overdue"],
      note: null,
      currency: "TRY",
    });
    expect(partial20k.amount).toBe(30_000);
    expect(partial20k.original_amount).toBe(30_000);
    expect(partial20k.paid_amount).toBe(10_000);
    expect(partial20k.remaining_amount).toBe(20_000);
    expect(partial20k.overpayment_amount).toBe(0);

    // Partial payment live mirror (30,000 original / 12,000 paid -> 18,000 remaining)
    const partial18k = mapInstanceRow({
      id: "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
      payment_id: "239bd2b1-35c0-4581-b0d1-b446fc220355",
      name: "VAKIF KREDİ 2",
      due_date: "2026-07-23",
      amount: "30000.00",
      amount_status: "known",
      status: "partial",
      paid_amount: "12000.00",
      risk_level: "high",
      risk_reasons: ["overdue"],
      note: null,
      currency: "TRY",
    });
    expect(partial18k.amount).toBe(30_000);
    expect(partial18k.original_amount).toBe(30_000);
    expect(partial18k.paid_amount).toBe(12_000);
    expect(partial18k.remaining_amount).toBe(18_000);
    expect(partial18k.overpayment_amount).toBe(0);

    // Cancelled row (30,000 original -> 0 remaining)
    const cancelledRow = mapInstanceRow({
      id: "23fcaf63-de67-4dc6-88f0-a69416a8dd56",
      payment_id: "239bd2b1-35c0-4581-b0d1-b446fc220355",
      name: "VAKIF KREDİ 2",
      due_date: "2026-11-23",
      amount: "30000.00",
      amount_status: "known",
      status: "cancelled",
      cancelled_at: "2026-07-22T08:02:07.815Z",
      paid_amount: null,
      risk_level: "none",
      risk_reasons: [],
      note: null,
      currency: "TRY",
    });
    expect(cancelledRow.original_amount).toBe(30_000);
    expect(cancelledRow.remaining_amount).toBe(0);
    expect(cancelledRow.overpayment_amount).toBe(0);

    // Paid with settlement discount (50,000 original / 47,500 paid -> 0 remaining, 0 overpayment)
    const discountedRow = mapInstanceRow({
      id: "pi-disc-1",
      payment_id: "p-3",
      name: "İskontolu Tedarikçi Ödemesi",
      due_date: "2026-11-15",
      amount: "50000.00",
      amount_status: "known",
      status: "paid",
      paid_amount: "47500.00",
      risk_level: "none",
      risk_reasons: [],
      note: null,
      currency: "TRY",
    });
    expect(discountedRow.original_amount).toBe(50_000);
    expect(discountedRow.paid_amount).toBe(47_500);
    expect(discountedRow.remaining_amount).toBe(0);
    expect(discountedRow.overpayment_amount).toBe(0);

    // Paid with overpayment (40,000 original / 41,250.55 paid -> 0 remaining, 1,250.55 overpayment)
    const overpaidRow = mapInstanceRow({
      id: "pi-over-1",
      payment_id: "p-4",
      name: "Fazla Ödenen Fatura",
      due_date: "2026-11-16",
      amount: "40000.00",
      amount_status: "known",
      status: "paid",
      paid_amount: "41250.55",
      risk_level: "medium",
      risk_reasons: ["overpaid"],
      note: null,
      currency: "TRY",
    });
    expect(overpaidRow.original_amount).toBe(40_000);
    expect(overpaidRow.paid_amount).toBe(41_250.55);
    expect(overpaidRow.remaining_amount).toBe(0);
    expect(overpaidRow.overpayment_amount).toBe(1_250.55);

    const directContract = computeObligationAmounts({
      originalAmount: 40_000,
      paidAmount: 41_250.55,
      status: "paid",
    });
    expect(directContract.overpaymentAmount).toBe(1_250.55);
  });

  it("2. guarantees kuruş-exact monthSummary reconciliation identity across unpaid, partial, discount, overpayment, cancelled, null, foreign, and inflow rows", async () => {
    const mixedRows: SyntheticLedgerRow[] = [
      // Active unpaid: 100,000.00
      { amount: 100_000, paid_amount: null, status: "unpaid", cancelled_at: null, direction: "outflow", currency: "TRY" },
      // Active partial: 30,000.00 original, 10,000.00 paid, 20,000.00 remaining
      { amount: 30_000, paid_amount: 10_000, status: "partial", cancelled_at: null, direction: "outflow", currency: "TRY" },
      // Active paid with settlement discount: 50,000.00 original, 47,500.00 paid -> 2,500.00 discount
      { amount: 50_000, paid_amount: 47_500, status: "paid", cancelled_at: null, direction: "outflow", currency: "TRY" },
      // Active paid with overpayment: 40,000.00 original, 41,250.55 paid -> 1,250.55 overpayment
      { amount: 40_000, paid_amount: 41_250.55, status: "paid", cancelled_at: null, direction: "outflow", currency: "TRY" },
      // Cancelled outflow: 30,000.00 excluded from active total, disclosed in cancelledKnownTotal
      { amount: 30_000, paid_amount: null, status: "cancelled", cancelled_at: "2026-07-22T08:02:07.815Z", direction: "outflow", currency: "TRY" },
      // Missing amount: null never coerced to 0, increments missing_count
      { amount: null, paid_amount: null, status: "unpaid", cancelled_at: null, direction: "outflow", currency: "TRY" },
      // Foreign currency: USD excluded from TRY sums, increments foreign_count
      { amount: 1_500, paid_amount: null, status: "planned", cancelled_at: null, direction: "outflow", currency: "USD" },
      // Inflow: excluded from outflow summary entirely
      { amount: 25_000, paid_amount: null, status: "planned", cancelled_at: null, direction: "inflow", currency: "TRY" },
    ];

    const summary = await monthSummary(createMonthSummaryMockPool(mixedRows), "2026-11-01");
    expect(summary.known_total).toBe(220_000);
    expect(summary.paid_known).toBe(98_750.55);
    expect(summary.known_remaining).toBe(120_000);
    expect(summary.settlementAdjustmentTry).toBe(2_500);
    expect(summary.overpaymentAdjustmentTry).toBe(1_250.55);
    expect(summary.unexplainedGapTry).toBe(0);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.cancelledKnownTotal).toBe(30_000);
    expect(summary.missing_count).toBe(1);
    expect(summary.foreign_count).toBe(1);
    expect(summary.total_count).toBe(6);

    // Backward-compatibility check when a legacy mock pool omits overpayment_adjustment_try
    const legacyMockSummary = await monthSummary(
      createMonthSummaryMockPool(
        [
          { amount: 522_500, paid_amount: 0, status: "unpaid", cancelled_at: null, direction: "outflow", currency: "TRY" },
          { amount: 30_000, paid_amount: null, status: "cancelled", cancelled_at: "2026-11-05T10:00:00Z", direction: "outflow", currency: "TRY" },
        ],
        true,
      ),
      "2026-11-01",
    );
    expect(legacyMockSummary.overpaymentAdjustmentTry).toBe(0);
    expect(legacyMockSummary.unexplainedGapTry).toBe(0);
    expect(legacyMockSummary.known_total).toBe(522_500);
    expect(legacyMockSummary.cancelledKnownTotal).toBe(30_000);
  });

  it("3. reproduces live mas_radar_dev monthly reconciliation (I-009: 2026-06 through 2026-12 unexplainedGapTry === 0) and distribution parity", async () => {
    const targetMonths = [
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
      "2026-11-01",
      "2026-12-01",
    ];

    const summaries = new Map<string, Awaited<ReturnType<typeof monthSummary>>>();
    for (const m of targetMonths) {
      const s = await monthSummary(ownerReadOnlyPool, m);
      summaries.set(m, s);
      expect(s.unexplainedGapTry).toBe(0);
      expect(
        round2(
          s.known_total +
            s.overpaymentAdjustmentTry -
            (s.paid_known + s.known_remaining + s.settlementAdjustmentTry),
        ),
      ).toBe(0);
    }

    // 2026-06: 490,000 active known TRY (155,000 paid + 335,000 remaining) + 1 cancelled row (50,000 TRY)
    const jun = summaries.get("2026-06-01")!;
    expect(jun.known_total).toBe(490_000);
    expect(jun.paid_known).toBe(155_000);
    expect(jun.known_remaining).toBe(335_000);
    expect(jun.cancelledCount).toBe(1);
    expect(jun.cancelledKnownTotal).toBe(50_000);
    expect(jun.missing_count).toBe(11);
    expect(jun.total_count).toBe(17);

    // 2026-07: 540,000 active known TRY (12,000 partial paid on VAKIF KREDİ 2 + 528,000 remaining)
    const jul = summaries.get("2026-07-01")!;
    expect(jul.known_total).toBe(540_000);
    expect(jul.paid_known).toBe(12_000);
    expect(jul.known_remaining).toBe(528_000);
    expect(jul.cancelledCount).toBe(0);
    expect(jul.cancelledKnownTotal).toBe(0);
    expect(jul.missing_count).toBe(11);
    expect(jul.total_count).toBe(18);

    // 2026-11 (I-009): 510,000 active known TRY + 11 missing + 1 cancelled VAKIF KREDİ 2 (30,000 TRY)
    const nov = summaries.get("2026-11-01")!;
    expect(nov.known_total).toBe(510_000);
    expect(nov.paid_known).toBe(0);
    expect(nov.known_remaining).toBe(510_000);
    expect(nov.cancelledCount).toBe(1);
    expect(nov.cancelledKnownTotal).toBe(30_000);
    expect(nov.missing_count).toBe(11);
    expect(nov.total_count).toBe(17);

    const novActive = await monthInstances(ownerReadOnlyPool, "2026-11-01");
    expect(novActive).toHaveLength(17);
    expect(novActive.some((r) => r.id.startsWith("23fcaf63"))).toBe(false);

    const novMissing = await missingAmountInstances(ownerReadOnlyPool, "2026-11-01");
    expect(novMissing).toHaveLength(11);
    expect(novMissing.every((r) => r.amount === null && r.remaining_amount === null)).toBe(true);

    // Verify distribution(pool, monthStartISO, by) across provider/category/owner matches monthSummary with zero join multiplication
    const dimensions: DistributionBy[] = ["provider", "category", "owner"];
    for (const m of ["2026-06-01", "2026-07-01", "2026-11-01"]) {
      const s = summaries.get(m)!;
      for (const dim of dimensions) {
        const dist = await distribution(ownerReadOnlyPool, m, dim);
        expect(sumMoney(dist.map((d) => d.amount))).toBe(s.known_total);
        expect(sumMoney(dist.map((d) => d.remainingAmount))).toBe(s.known_remaining);
        expect(sumMoney(dist.map((d) => d.paidAmount))).toBe(s.paid_known);
      }
    }

    await expect(
      distribution(ownerReadOnlyPool, "2026-11-01", "invalid_dim" as unknown as DistributionBy),
    ).rejects.toThrow(TypeError);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("4. reproduces live VAKIF KREDİ 2 partial payment (I-012) and overdue exposure breakdown as of 2026-11-14 (92 items) vs 2026-11-18 (93 items)", async () => {
    const overdueNov14 = await overdueOpen(ownerReadOnlyPool, "2026-11-14");
    const overdueNov18 = await overdueOpen(ownerReadOnlyPool, "2026-11-18");

    expect(overdueNov14).toHaveLength(92);
    expect(new Set(overdueNov14.map((r) => r.id)).size).toBe(92);

    expect(overdueNov18).toHaveLength(93);
    expect(new Set(overdueNov18.map((r) => r.id)).size).toBe(93);

    // Confirm VAKIF KREDİ 2 partial row 0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d
    const vakifPartial = overdueNov14.find(
      (r) => r.id === "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
    );
    expect(vakifPartial).toBeDefined();
    expect(vakifPartial!.name).toBe("VAKIF KREDİ 2");
    expect(vakifPartial!.due_date).toBe("2026-07-23");
    expect(vakifPartial!.status).toBe("partial");
    expect(vakifPartial!.amount).toBe(30_000);
    expect(vakifPartial!.original_amount).toBe(30_000);
    expect(vakifPartial!.paid_amount).toBe(12_000);
    expect(vakifPartial!.remaining_amount).toBe(18_000);
    expect(vakifPartial!.overpayment_amount).toBe(0);

    // Confirm missing amounts stay strictly null (61 items) and original vs paid vs remaining reconcile to 12,000 TRY partial payment
    const missing14 = overdueNov14.filter((r) => r.amount === null);
    expect(missing14).toHaveLength(61);
    expect(missing14.every((r) => r.original_amount === null && r.remaining_amount === null)).toBe(true);

    const originalSum14 = sumMoney(overdueNov14.map((r) => r.original_amount ?? null));
    const paidSum14 = sumMoney(overdueNov14.map((r) => r.paid_amount ?? null));
    const remainingSum14 = sumMoney(overdueNov14.map((r) => r.remaining_amount ?? null));
    expect(originalSum14).toBe(2_560_000);
    expect(paidSum14).toBe(12_000);
    expect(remainingSum14).toBe(2_548_000);

    const originalSum18 = sumMoney(overdueNov18.map((r) => r.original_amount ?? null));
    const paidSum18 = sumMoney(overdueNov18.map((r) => r.paid_amount ?? null));
    const remainingSum18 = sumMoney(overdueNov18.map((r) => r.remaining_amount ?? null));
    expect(originalSum18).toBe(2_750_000);
    expect(paidSum18).toBe(12_000);
    expect(remainingSum18).toBe(2_738_000);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("5. verifies zero SQL join multiplication, distinct recurring (payment_id, instance_month) identities, Çağdaş check preservation (I-011), and FIN-03 null opening balances (I-010)", async () => {
    const joinAndIdentityRes = await ownerReadOnlyPool.query<{
      raw_pi_count: number;
      joined_pi_count: number;
      distinct_id_count: number;
      template_backed_count: number;
      distinct_payment_month_pairs: number;
    }>(`
      select
        (select count(*)::int from public.payment_instances) as raw_pi_count,
        (select count(*)::int
           from public.payment_instances i
           left join public.payments p on p.id = i.payment_id
           left join public.categories c on c.id = p.category_id
           left join public.parties pr on pr.id = p.provider_party_id
           left join public.parties ow on ow.id = p.owner_party_id) as joined_pi_count,
        (select count(distinct id)::int from public.payment_instances) as distinct_id_count,
        (select count(*)::int from public.payment_instances where payment_id is not null) as template_backed_count,
        (select count(distinct (payment_id, instance_month))::int
           from public.payment_instances
          where payment_id is not null) as distinct_payment_month_pairs
    `);

    const ji = joinAndIdentityRes.rows[0]!;
    expect(ji.raw_pi_count).toBe(536);
    expect(ji.joined_pi_count).toBe(ji.raw_pi_count);
    expect(ji.distinct_id_count).toBe(ji.raw_pi_count);
    expect(ji.distinct_payment_month_pairs).toBe(ji.template_backed_count);

    // I-011: Çağdaş checks preserved intact (3 × 2026-08-31 active + 1 × 2026-10-31 archived) and surfaced in control_duplicate_checks
    const cagdasChecks = await ownerReadOnlyPool.query<{
      id: string;
      maturity_date: string;
      amount: string;
      archived_at: string | null;
    }>(`
      select id,
             to_char(maturity_date, 'YYYY-MM-DD') as maturity_date,
             amount::numeric(14,2)::text as amount,
             archived_at::text as archived_at
        from public.checks
       where counterparty_label ilike '%çağdaş%'
          or counterparty_label ilike '%cagdas%'
       order by maturity_date, id
    `);
    expect(cagdasChecks.rows).toHaveLength(4);
    const aug31Checks = cagdasChecks.rows.filter((c) => c.maturity_date === "2026-08-31");
    const oct31Checks = cagdasChecks.rows.filter((c) => c.maturity_date === "2026-10-31");
    expect(aug31Checks).toHaveLength(3);
    expect(aug31Checks.every((c) => c.amount === "100000.00" && c.archived_at === null)).toBe(true);
    expect(oct31Checks).toHaveLength(1);
    expect(oct31Checks[0]!.amount).toBe("100000.00");
    expect(oct31Checks[0]!.archived_at).not.toBeNull();

    const dupControlRes = await ownerReadOnlyPool.query<{ check_id: string }>(`
      select check_id
        from public.control_duplicate_checks
       where counterparty_label ilike '%çağdaş%'
    `);
    expect(dupControlRes.rowCount).toBeGreaterThanOrEqual(2);

    // I-010 (FIN-03): 6 active cash_accounts with opening_balance IS NULL & 0 bank_transactions -> bank_102 unknown_opening_balance (subledgerTry === null)
    const fin03Res = await ownerReadOnlyPool.query<{
      active_accounts: number;
      null_opening_accounts: number;
      bank_tx_count: number;
      forecast_months_count: number;
    }>(`
      select
        (select count(*)::int from public.cash_accounts where is_active = true and archived_at is null) as active_accounts,
        (select count(*) filter (where opening_balance is null)::int from public.cash_accounts where is_active = true and archived_at is null) as null_opening_accounts,
        (select count(*)::int from public.bank_transactions) as bank_tx_count,
        (select count(*)::int from public.cashflow_months) as forecast_months_count
    `);
    expect(fin03Res.rows[0]).toEqual({
      active_accounts: 6,
      null_opening_accounts: 6,
      bank_tx_count: 0,
      forecast_months_count: 35,
    });

    const fourWay = await loadFourWaySubledgerHealth(ownerReadOnlyPool);
    const bankPillar = fourWay.pillars.find((p) => p.key === "bank_102");
    expect(bankPillar).toBeDefined();
    expect(bankPillar!.status).toBe("unknown_opening_balance");
    expect(bankPillar!.subledgerTry).toBeNull();
    expect(bankPillar!.unknownOpeningCount).toBe(6);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("6. enforces V2 F-03 & F-14 on live mas_radar_dev: loadCanonicalKpis and loadHybridCashMonths keep cash null (PARTIAL_MISSING_OPENING) with 0 schema drift", async () => {
    const kpiSnapshot = await loadCanonicalKpis(ownerReadOnlyPool, "2026-11-18", {
      failOnSchemaDrift: true,
    });
    expect(kpiSnapshot.treasuryCash.availableNowTry).toBeNull();
    expect(kpiSnapshot.treasuryCash.accountCountTry).toBe(6);
    expect(kpiSnapshot.treasuryCash.unknownOpeningCountTry).toBe(6);
    expect(kpiSnapshot.treasuryCash.unknownCashAccountCount).toBe(6);
    expect(kpiSnapshot.treasuryCash.cashSourceStatus).toBe("PARTIAL_MISSING_OPENING");
    expect(kpiSnapshot.treasuryCash.legacyUnverified).toBe(false);
    expect(kpiSnapshot.cashSourceStatus).toBe("PARTIAL_MISSING_OPENING");

    const hybrid = await loadHybridCashMonths(ownerReadOnlyPool, "2026-11-18", {
      failOnSchemaDrift: true,
    });
    expect(hybrid.sourceStatus).toBe("PARTIAL_MISSING_OPENING");
    expect(hybrid.schemaIncompatibleSources).toEqual([]);
    expect(hybrid.openingBalance).toBeNull();
    expect(hybrid.hasUnknownOpeningBalances).toBe(true);
    expect(hybrid.unknownOpeningCount).toBe(6);
    expect(hybrid.epistemicBasis).toBe("UNKNOWN");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
