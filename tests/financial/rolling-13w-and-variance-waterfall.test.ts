import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createForecast, createForecastLine } from "@/lib/budget/engine";
import {
  buildAutoSeeded13WeekForecast,
  compute13wVarianceWaterfall,
  freezeWeekly13wSnapshot,
  mondayOfWeek,
} from "@/lib/cashflow/rolling-13w-engine";
import { createCounterparty } from "@/lib/counterparties/engine";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

let pool: Pool;

describe.runIf(hasDisposableDb || requireDisposableDb)(
  "Faz 54 (F1) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Zamanlama vs. Kalıcı Varyans Şelalesi",
  { timeout: 60_000 },
  () => {
  let actorId = "";
  let customerAId = "";
  let customerBId = "";
  let supplierId = "";
  let bankCashAccountId = "";

  const asOfDate = "2026-03-02"; // Monday (ISO Week 1: 2026-03-02 .. 2026-03-08)

  beforeAll(async () => {
    const dbTarget = assertDisposableTargetDb(
      undefined,
      "Faz 54 (F1) rolling-13w-and-variance-waterfall test",
    );
    pool = new Pool({ connectionString: dbTarget.url, max: 2 });
    actorId = await ensureSystemActor(pool);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`update public.cash_accounts set opening_journal_entry_id = null where opening_journal_entry_id is not null`);
      await client.query(`alter table public.management_journal_entries disable trigger user`);
      await client.query(`alter table public.management_journal_lines disable trigger user`);
      await client.query(`delete from public.management_journal_lines`);
      await client.query(`delete from public.management_journal_entries`);
      await client.query(`alter table public.management_journal_lines enable trigger user`);
      await client.query(`alter table public.management_journal_entries enable trigger user`);
      await client.query(
        `truncate table
           public.forecast_snapshot_13w_lines,
           public.forecast_snapshots_13w,
           public.forecast_lines,
           public.forecasts,
           public.promise_to_pay,
           public.payment_run_items,
           public.payment_runs,
           public.bank_transaction_match_candidates,
           public.bank_transactions,
           public.invoice_allocations,
           public.invoice_lines,
           public.invoices,
           public.payment_instances,
           public.payments,
           public.check_events,
           public.checks,
           public.check_bordros,
           public.loan_installments,
           public.loans,
           public.integration_account_mappings,
           public.facility_movements,
           public.credit_facilities,
           public.bank_accounts,
           public.cash_accounts,
           public.treasury_policies
         restart identity cascade`,
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const custA = await createCounterparty(
      pool,
      {
        name: "F1 Müşteri Alfa A.Ş.",
        partyType: "customer",
        taxNumber: "5411111110",
      },
      actorId,
    );
    customerAId = custA.partyId;

    const custB = await createCounterparty(
      pool,
      {
        name: "F1 Davranışsal Müşteri Beta Ltd.",
        partyType: "customer",
        taxNumber: "5422222220",
      },
      actorId,
    );
    customerBId = custB.partyId;

    const supp = await createCounterparty(
      pool,
      {
        name: "F1 Tedarikçi Gama Sanayi A.Ş.",
        partyType: "vendor",
        taxNumber: "5433333330",
      },
      actorId,
    );
    supplierId = supp.partyId;
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  }, 60_000);

  it("1. FIN-03 null açılış bakiyesi yayılımını korur (unknown_opening_count > 0 iken 0 varsaymaz)", async () => {
    expect(mondayOfWeek("2026-03-04")).toBe("2026-03-02");
    expect(mondayOfWeek("2026-03-08")).toBe("2026-03-02");

    const client = await pool.connect();
    try {
      await client.query("begin");
      const caRes = await client.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('F1 Null Açılış Hesabı', 'bank_account', 'TRY', null, true)
         returning id::text`,
      );
      bankCashAccountId = caRes.rows[0].id;
      await client.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, iban)
         values ($1, 'Garanti BBVA', 'TR330006100519786457841326')`,
        [bankCashAccountId],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const forecastNull = await buildAutoSeeded13WeekForecast(pool, {
      asOfDate,
      currency: "TRY",
    });

    expect(forecastNull.unknownOpeningCount).toBe(1);
    expect(forecastNull.openingCash).toBeNull();
    expect(forecastNull.endingCash).toBeNull();
    expect(forecastNull.weeks).toHaveLength(13);
    for (const w of forecastNull.weeks) {
      expect(w.openingBalance).toBeNull();
      expect(w.closingBalance).toBeNull();
      expect(w.floorHeadroom).toBeNull();
      expect(w.breachesFloor).toBeNull();
    }
  });

  it("2. Otomatik tohumlama, Faz 44 çift sayım kalkanı, V2 DBT kaydırması ve Today-Cliff yasağını doğrular", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");

      // Set known opening balance = 500,000.00 TRY and min_cash policy floor = 400,000.00 TRY
      await client.query(
        `update public.cash_accounts set opening_balance = 500000.00 where id = $1`,
        [bankCashAccountId],
      );
      await client.query(
        `insert into public.treasury_policies (code, description, policy_kind, currency, threshold_amount, is_active)
         values ('min_cash_try_f1', 'F1 TRY Minimum Kasa Tabanı', 'min_cash', 'TRY', 400000.00, true)`,
      );

      // (a) Overdue unscheduled sales invoice (due 2026-02-10, 45,000 TL) -> MUST NOT enter Week 1!
      await client.query(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('sales', 'F1-OVERDUE-01', $1, '2025-12-10', '2026-02-10', 'TRY', 37500.00, 7500.00, 45000.00, 'open')`,
        [customerAId],
      );

      // (b) Bad-debt flagged sales invoice (due 2026-03-05, 18,000 TL) -> MUST be excluded!
      await client.query(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status, bad_debt_at, bad_debt_reason, bad_debt_by
         )
         values ('sales', 'F1-BADDEBT-01', $1, '2026-02-05', '2026-03-05', 'TRY', 15000.00, 3000.00, 18000.00, 'open', now(), 'İcra takibinde şüpheli alacak', $2)`,
        [customerAId, actorId],
      );

      // (c) Customer A promised sales invoice in Week 1 (promised 2026-03-05, 120,000 TL)
      const invPromisedRes = await client.query<{ id: string }>(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('sales', 'F1-AR-W1-PROMISED', $1, '2026-02-01', '2026-03-03', 'TRY', 100000.00, 20000.00, 120000.00, 'open')
         returning id::text`,
        [customerAId],
      );
      await client.query(
        `insert into public.promise_to_pay (party_id, invoice_id, promised_date, promised_amount, currency, status)
         values ($1, $2, '2026-03-05', 120000.00, 'TRY', 'pending')`,
        [customerAId, invPromisedRes.rows[0].id],
      );

      // (d) Customer B with 3 historical settled invoices (+7 days DBT) -> open invoice due 2026-03-04 (W1) shifts to 2026-03-11 (W2)!
      for (let i = 1; i <= 3; i += 1) {
        const histInv = await client.query<{ id: string }>(
          `insert into public.invoices (
             direction, invoice_no, party_id, issue_date, due_date, currency,
             net_amount, tax_amount, gross_amount, status
           )
           values ('sales', $1, $2, '2025-12-01', '2025-12-10', 'TRY', 10000.00, 2000.00, 12000.00, 'open')
           returning id::text`,
          [`F1-HIST-DBT-${i}`, customerBId],
        );
        await client.query(
          `insert into public.invoice_allocations (invoice_id, source_table, allocated_amount, allocated_on)
           values ($1, 'manual', 12000.00, '2025-12-17')`,
          [histInv.rows[0].id],
        );
      }
      await client.query(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('sales', 'F1-AR-DBT-SHIFT', $1, '2026-02-15', '2026-03-04', 'TRY', 75000.00, 15000.00, 90000.00, 'open')`,
        [customerBId],
      );

      // (e) Supplier purchase invoice #1 in Week 1 (due 2026-03-06, 50,000 TL) -> open_ap
      await client.query(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('purchase', 'F1-AP-W1-01', $1, '2026-02-15', '2026-03-06', 'TRY', 41666.67, 8333.33, 50000.00, 'open')`,
        [supplierId],
      );

      // (f) Supplier purchase invoice #2 (due 2026-03-06, 65,000 TL) ALREADY represented by an issued check maturing in Week 2 (2026-03-12)
      // Faz 44 deduplication shield: must NOT appear in Week 1 open_ap, only once in Week 2 check_maturity!
      const dedupApRes = await client.query<{ id: string }>(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('purchase', 'F1-AP-DEDUP-CHECK', $1, '2026-02-15', '2026-03-06', 'TRY', 54166.67, 10833.33, 65000.00, 'open')
         returning id::text`,
        [supplierId],
      );
      const checkRes = await client.query<{ id: string }>(
        `insert into public.checks (
           direction, status, amount, signed_amount, currency, maturity_date,
           payee_party_id, linked_invoice_id, settled_invoice_id, counterparty_label
         )
         values ('outflow', 'issued_to_vendor', 65000.00, -65000.00, 'TRY', '2026-03-12', $1, $2, $2, 'F1 Tedarikçi Gama')
         returning id::text`,
        [supplierId, dedupApRes.rows[0].id],
      );
      await client.query(
        `update public.invoices set settled_by_check_id = $1 where id = $2`,
        [checkRes.rows[0].id, dedupApRes.rows[0].id],
      );

      // (g) Planned rent payment_instance in Week 1 (due 2026-03-05, 30,000 TL)
      const payRes = await client.query<{ id: string }>(
        `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, status)
         values ('Fabrika Kira Ödemesi', 'monthly', 5, 30000.00, 'TRY', 'active')
         returning id::text`,
      );
      await client.query(
        `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, direction, status)
         values ($1, '2026-03-01', '2026-03-05', 30000.00, 'TRY', 'outflow', 'unpaid')`,
        [payRes.rows[0].id],
      );

      // (h) Loan installment in Week 2 (due 2026-03-13, 40,000 TL)
      const loanRes = await client.query<{ id: string }>(
        `insert into public.loans (
           name, currency, principal, total_payment, installment_count, first_payment_date, lender_party_id
         )
         values ('F1 İşletme Kredisi', 'TRY', 400000.00, 480000.00, 12, '2026-03-13', $1)
         returning id::text`,
        [supplierId],
      );
      await client.query(
        `insert into public.loan_installments (loan_id, installment_no, due_date, amount, principal_component, interest_component, status)
         values ($1, 1, '2026-03-13', 40000.00, 32000.00, 8000.00, 'planned')`,
        [loanRes.rows[0].id],
      );

      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    // Add a manual CFO override in Week 2 (2026-03-09 .. 2026-03-15) for -15,000 TL
    const fId = await createForecast(
      pool,
      {
        name: "F1 13H Tahmin",
        horizonKind: "weekly_13",
        anchorDate: "2026-03-02",
        currency: "TRY",
      },
      actorId,
    );
    await createForecastLine(
      pool,
      {
        forecastId: fId,
        periodStart: "2026-03-09",
        periodEnd: "2026-03-15",
        direction: "outflow",
        amount: 15000.0,
        sourceKind: "manual",
        notes: "F1 Manuel Fuar Katılım Gideri",
      },
      actorId,
    );

    const forecast = await buildAutoSeeded13WeekForecast(pool, {
      asOfDate,
      currency: "TRY",
      dbtMode: "median",
    });

    expect(forecast.openingCash).toBe(500000);
    expect(forecast.unknownOpeningCount).toBe(0);

    // Zero Today-Cliff & Bad-Debt exclusion checks
    expect(forecast.overdueUnscheduledCount).toBe(1);
    expect(forecast.overdueUnscheduledAmount).toBe(45000);
    expect(forecast.doubtfulExcludedCount).toBe(1);
    expect(forecast.doubtfulExcludedAmount).toBe(18000);

    // Week 1 (2026-03-02 .. 2026-03-08):
    // Inflow: +120,000 (Customer A promised invoice)
    // Outflow: -50,000 (Supplier AP #1) - 30,000 (Rent payment_instance) = -80,000
    // (Note: 65,000 deduplicated AP invoice is NOT in Week 1, and Customer B 90,000 shifted to Week 2 via +7d DBT!)
    const w1 = forecast.weeks[0];
    expect(w1.weekStart).toBe("2026-03-02");
    expect(w1.openingBalance).toBe(500000);
    expect(w1.inflow).toBe(120000);
    expect(w1.outflow).toBe(80000);
    expect(w1.netFlow).toBe(40000);
    expect(w1.closingBalance).toBe(540000);

    // Week 2 (2026-03-09 .. 2026-03-15):
    // Inflow: +90,000 (Customer B behavioral_ar shifted from 2026-03-04 + 7d = 2026-03-11)
    // Outflow: -65,000 (Check maturity) - 40,000 (Loan installment) - 15,000 (Manual override) = -120,000
    const w2 = forecast.weeks[1];
    expect(w2.weekStart).toBe("2026-03-09");
    expect(w2.openingBalance).toBe(540000);
    expect(w2.inflowByCategory.behavioral_ar).toBe(90000);
    expect(w2.outflowByCategory.check_maturity).toBe(65000);
    expect(w2.outflowByCategory.loan_installment).toBe(40000);
    expect(w2.outflowByCategory.manual_override).toBe(15000);
    expect(w2.inflow).toBe(90000);
    expect(w2.outflow).toBe(120000);
    expect(w2.netFlow).toBe(-30000);
    expect(w2.closingBalance).toBe(510000);

    // Week 5 (2026-03-30 .. 2026-04-05): February 2026 KDV-1 (2026-03-28 Saturday -> 2026-03-30 Monday VUK Md. 18)
    const w5 = forecast.weeks[4];
    expect(w5.weekStart).toBe("2026-03-30");
    expect(w5.outflowByCategory.statutory_tax_sgk).toBe(18833.34);
  }, 60_000);

  it("3. Haftalık anlık görüntüyü dondurur ve Zamanlama Kayması vs. Kalıcı Sapma şelale özdeşliğini (Big) doğrular", async () => {
    const frozen = await freezeWeekly13wSnapshot(pool, {
      asOfDate,
      currency: "TRY",
      actor: actorId,
      dbtMode: "median",
    });

    expect(frozen.snapshotWeekStart).toBe("2026-03-02");
    expect(frozen.openingCash).toBe(500000);
    expect(frozen.lineCount).toBeGreaterThanOrEqual(7);

    // Simulate actual Week 1 (2026-03-02 .. 2026-03-08) bank movements:
    // Frozen Week 1 had:
    //   - Inflow: +120,000 (F1-AR-W1-PROMISED) -> Customer A delays payment to next week (remains open => Timing Slip -120,000)
    //   - Outflow: -50,000 (F1-AP-W1-01) -> Paid in Week 1 with 2,500 early-payment discount (-47,500 actual => Permanent Outflow Variance +2,500)
    //   - Outflow: -30,000 (Fabrika Kira payment_instance) -> Deferred to Week 2 (remains unpaid => Timing Slip +30,000)
    // Plus unplanned Week 1 bank movements:
    //   - Unplanned scrap sale inflow: +8,000 (Permanent Inflow Variance +8,000)
    //   - Unplanned machine repair outflow: -12,000 (Permanent Outflow Variance -12,000)
    //   - Own transfer (`own_transfer`): -200,000 (MUST BE EXCLUDED from waterfall!)
    const client = await pool.connect();
    try {
      await client.query("begin");
      const apInvRes = await client.query<{ id: string }>(
        `select id::text from public.invoices where invoice_no = 'F1-AP-W1-01' limit 1`,
      );
      const apInvId = apInvRes.rows[0].id;

      // 1) Matched supplier payment (-47,500.00 TRY)
      const btApRes = await client.query<{ id: string }>(
        `insert into public.bank_transactions (
           bank_account_id, txn_date, amount, currency, description,
           status, matched_entity_table, matched_entity_id, transaction_kind, dedupe_hash
         )
         values ($1, '2026-03-06', -47500.00, 'TRY', 'F1-AP-W1-01 Tedarikçi Ödemesi (İskontolu)', 'matched', 'invoices', $2, 'standard', 'f1-bt-hash-01')
         returning id::text`,
        [bankCashAccountId, apInvId],
      );

      const allocRes = await client.query<{ id: string }>(
        `insert into public.invoice_allocations (invoice_id, source_table, source_id, allocated_amount, allocated_on)
         values ($1, 'bank_transactions', $2, 47500.00, '2026-03-06')
         returning id::text`,
        [apInvId, btApRes.rows[0].id],
      );

      await client.query(
        `update public.bank_transactions set settled_allocation_id = $1 where id = $2`,
        [allocRes.rows[0].id, btApRes.rows[0].id],
      );

      // 2) Unplanned inflow (+8,000.00 TRY)
      await client.query(
        `insert into public.bank_transactions (
           bank_account_id, txn_date, amount, currency, description, status, transaction_kind, dedupe_hash
         )
         values ($1, '2026-03-04', 8000.00, 'TRY', 'Plansız Hurda Satış Tahsilatı', 'unmatched', 'standard', 'f1-bt-hash-02')`,
        [bankCashAccountId],
      );

      // 3) Unplanned outflow (-12,000.00 TRY)
      await client.query(
        `insert into public.bank_transactions (
           bank_account_id, txn_date, amount, currency, description, status, transaction_kind, dedupe_hash
         )
         values ($1, '2026-03-05', -12000.00, 'TRY', 'Plansız CNC Acil Bakım Ödemesi', 'unmatched', 'standard', 'f1-bt-hash-03')`,
        [bankCashAccountId],
      );

      // 4) Inter-account transfer (`own_transfer`, -200,000.00 TRY) -> MUST be excluded!
      await client.query(
        `insert into public.bank_transactions (
           bank_account_id, txn_date, amount, currency, description, status, transaction_kind, dedupe_hash
         )
         values ($1, '2026-03-05', -200000.00, 'TRY', 'Kendi Hesaplarımız Arası Virman', 'unmatched', 'own_transfer', 'f1-bt-hash-04')`,
        [bankCashAccountId],
      );

      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const wf = await compute13wVarianceWaterfall(pool, {
      snapshotId: frozen.snapshotId,
      weekStart: "2026-03-02",
    });

    // Frozen Forecast Week 1: Inflow 120,000, Outflow 80,000 -> Forecast Net = +40,000
    expect(wf.forecastInflow).toBe(120000);
    expect(wf.forecastOutflow).toBe(80000);
    expect(wf.forecastNet).toBe(40000);

    // Actual Bank Week 1 (excluding own_transfer):
    // Inflow = +8,000; Outflow = 47,500 + 12,000 = 59,500 -> Actual Net = -51,500
    expect(wf.actualBankInflow).toBe(8000);
    expect(wf.actualBankOutflow).toBe(59500);
    expect(wf.actualBankNetMovement).toBe(-51500);

    // Total Net Variance = -51,500 - 40,000 = -91,500
    expect(wf.totalNetVariance).toBe(-91500);

    // Decomposition:
    // Timing Slip: -120,000 (Customer A open AR) + 30,000 (Deferred Rent) = -90,000
    // Permanent Inflow Variance: +8,000 (Unplanned scrap sale)
    // Permanent Outflow Variance: +2,500 (Discount on AP) - 12,000 (Unplanned repair) = -9,500
    // Permanent Total Variance: +8,000 - 9,500 = -1,500
    expect(wf.timingSlipAmount).toBe(-90000);
    expect(wf.permanentInflowVarianceAmount).toBe(8000);
    expect(wf.permanentOutflowVarianceAmount).toBe(-9500);
    expect(wf.permanentVarianceAmount).toBe(-1500);

    // Exact Waterfall Identity:
    // 40,000 + (-90,000) + 8,000 + (-9,500) === -51,500
    expect(
      wf.forecastNet +
        wf.timingSlipAmount +
        wf.permanentInflowVarianceAmount +
        wf.permanentOutflowVarianceAmount,
    ).toBe(wf.actualBankNetMovement);
    expect(wf.identityBalanced).toBe(true);
    expect(wf.identityDiff).toBe(0);
  });

  it("4. KDV_1/KDV_2 tevkifatı (vat_withholding_amount) ve ciro edilmiş çek (linked_invoice_id) çift sayım engeli çalışır", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Şubat 2026 alış faturası: 100.000 net + 20.000 KDV, 10.000 KDV tevkifatı -> KDV_2 çıkışı Mart 28 (2026-03-28) haftasında 10.000 TL
      await client.query(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, vat_withholding_amount, payable_amount, status
         )
         values ('purchase', 'F1-TEVKIFAT-01', $1, '2026-02-15', '2026-04-10', 'TRY',
                 100000.00, 20000.00, 120000.00, 10000.00, 110000.00, 'open')`,
        [supplierId],
      );

      // Şubat 2026 satış faturası: 300.000 net + 60.000 KDV -> KDV_1 = 60.000 - (20.000) = 40.000 TL
      const salesInvRes = await client.query<{ id: string }>(
        `insert into public.invoices (
           direction, invoice_no, party_id, issue_date, due_date, currency,
           net_amount, tax_amount, gross_amount, status
         )
         values ('sales', 'F1-LINKED-CHK-01', $1, '2026-02-20', '2026-03-18', 'TRY',
                 300000.00, 60000.00, 360000.00, 'open')
         returning id::text`,
        [customerAId],
      );
      const linkedSalesInvId = salesInvRes.rows[0].id;

      // Bu satış faturası yalnızca linked_invoice_id üzerinden portföydeki çekle kapatılmışsa AR'da ikinci kez sayılmamalı
      await client.query(
        `insert into public.checks (
           direction, serial_no, payer_party_id, maturity_date, amount, currency, status, linked_invoice_id
         )
         values ('inflow', 'CHK-F1-LINK-01', $1, '2026-03-18', 360000.00, 'TRY', 'in_portfolio', $2)`,
        [customerAId, linkedSalesInvId],
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const seeded = await buildAutoSeeded13WeekForecast(pool, { asOfDate: "2026-03-02" });
    const kdv2Items = seeded.weeks
      .flatMap((w) => w.lines)
      .filter((i) => i.sourceClassification === "statutory_tax" && i.label.includes("KDV-2"));
    expect(kdv2Items.reduce((s, i) => s + i.amount, 0)).toBe(10000);

    // F1-LINKED-CHK-01 faturası fatura alacağı olarak tekrar sayılmamalı (yalnız çekten gelmeli)
    const duplicateAr = seeded.weeks
      .flatMap((w) => w.lines)
      .filter((i) => i.sourceEntityTable === "invoices" && i.label.includes("F1-LINKED-CHK-01"));
    expect(duplicateAr).toHaveLength(0);
  });
});
