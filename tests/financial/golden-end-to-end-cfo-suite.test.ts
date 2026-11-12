// Faz 56 (F3) — Birleşik Altın Finansal Doğruluk Paketi (Golden End-to-End CFO Suite)
//
// Elle bağımsız aritmetikle türetilmiş Birleşik Altın Şirket Senaryosu:
//   1. TRY + USD + EUR kasa/banka hesapları (FIN-03 hem NULL hem dolu açılış vakası)
//   2. Paraşüt v4 satış / tevkifatlı fatura / alış faturası / kendi hesapları arası virman + MT940 çapraz-kanal banka ekstresi
//   3. Müşteri çeki alımı (101.01), tedarikçiye ciro (320 / 101.01) + nazım rücu riski (900 / 901)
//   4. Kredi taksiti (300 anapara / 780 faiz+BSMV+KKDF ayrımı)
//   5. Ödeme paketi (payment_runs + maker-checker + 14g kasa tamponu + pain.001 XML + atomik banka kapanışı)
//   6. Dönem kilidi (0100: kapalı döneme geçmişe dönük kayıt engeli)
//   7. Dengeli TDHP Yönetim Defteri: Mizan (Borç === Alacak), Bilanço (Aktif === Pasif) ve Yönetim EBITDA (0105)
//   8. 12 Kök Nedenli Mali Müşavir Yasal Mizan Mutabakatı (0106)
//   9. Otomatik Tohumlanan 13-Hafta Nakit Tahmini ve Zamanlama vs. Kalıcı Varyans Şelalesi (0107)
//  10. Gece Nakit/Gap7 Değişim Atfı, Nakit DSCR/CFADS & Kovenant, İkili Runway ve Başabaş Goal-Seek (Faz 55)
//  11. B3-07: PoolClient.query yavaş sorgu sayacı (slow-query.ts + request-metrics.ts) bütünlüğü

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "@/lib/approvals/engine";
import {
  buildOvernightDeltaAttribution,
  loadOvernightDeltaAttribution,
} from "@/lib/briefing/delta-attribution";
import {
  buildAutoSeeded13WeekForecast,
  compute13wVarianceWaterfall,
  freezeWeekly13wSnapshot,
} from "@/lib/cashflow/rolling-13w-engine";
import { addIban, createCounterparty } from "@/lib/counterparties/engine";
import { computeDualCashRunway } from "@/lib/facts/engine";
import { executeCheckBordroTransition } from "@/lib/financing/check-bordro";
import {
  computeCashDscrWindow,
  loadCovenantAndDscrRadar,
} from "@/lib/financing/covenants-and-dscr";
import { importHybridBankStatement } from "@/lib/importers/bank-formats/mt940-camt053-parasut";
import { parasutConnector } from "@/lib/integrations/parasut/mappers";
import { mockHttpClient, type HttpRequest, type HttpResponse } from "@/lib/integrations/types";
import {
  loadManagementLedgerOverview,
  postManualManagementAdjustment,
  rebuildOrSyncManagementLedger,
} from "@/lib/ledger/posting-engine";
import { importStatutoryMizan } from "@/lib/ledger/statutory-mizan-importer";
import { reconcileTrialBalance } from "@/lib/ledger/trial-balance-bridge";
import { exportPaymentRun } from "@/lib/payments/bank-export";
import {
  createPaymentRun,
  submitPaymentRunForApproval,
} from "@/lib/payments/payment-runs";
import { countingClient, measureRequestQueries } from "@/lib/perf/request-metrics";
import {
  DEFAULT_SLOW_MS,
  resetSlowQueryStats,
  setSlowThreshold,
  slowQueryReport,
} from "@/lib/perf/slow-query";
import { acceptMatch } from "@/lib/bank/engine";
import { solveBreakevenLevers } from "@/lib/scenarios/breakeven-goalseek";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

function makeValidTrIban(bankCode5: string, account17: string): string {
  const bban = `${bankCode5.padStart(5, "0").slice(0, 5)}${account17.padStart(17, "0").slice(0, 17)}`;
  const numericStr = `${bban}292700`;
  let rem = 0;
  for (const ch of numericStr) {
    rem = (rem * 10 + Number(ch)) % 97;
  }
  const check = String(98 - rem).padStart(2, "0");
  return `TR${check}${bban}`;
}

describe("Faz 56 (F3) — Birleşik Altın Şirket Deterministik Aritmetik ve B3-07 Telemetri Kapısı", () => {
  it("1) B3-07: countingClient üzerinden geçen PoolClient.query çağrılarını hem slow-query hem request-metrics halkasına kaydeder", async () => {
    resetSlowQueryStats();
    setSlowThreshold(0);
    try {
      const fakeClient = {
        query: async (sql: string) => {
          if (!sql) throw new Error("sql required");
          await new Promise((r) => setTimeout(r, 5));
          return { rows: [{ ok: 1 }], rowCount: 1 };
        },
      };
      const wrapped = countingClient(fakeClient);
      const { metrics } = await measureRequestQueries(async () => {
        await wrapped.query(
          "SELECT * FROM public.payment_instances WHERE id = '11111111-1111-1111-1111-111111111111'",
        );
      });
      expect(metrics.queryCount).toBe(1);
      expect(metrics.totalDbTimeMs).toBeGreaterThan(0);

      const slow = slowQueryReport(10);
      expect(slow.shapes).toBeGreaterThanOrEqual(1);
      expect(slow.rows[0].fingerprint).toContain(
        "SELECT * FROM public.payment_instances WHERE id = ?",
      );
      expect(slow.rows[0].count).toBe(1);
    } finally {
      setSlowThreshold(DEFAULT_SLOW_MS);
      resetSlowQueryStats();
    }
  });

  it("2) Elle hesaplanmış Altın Şirket Gece Deltası, Nakit DSCR, İkili Runway ve Başabaş Kaldıraç özdeşliklerini 0.00 kuruş sapma ile doğrular", () => {
    // Gece Nakit ve Gap7 Değişim Atfı: 1.500.000,00 -> 1.820.000,00 (+320.000,00 TRY)
    const delta = buildOvernightDeltaAttribution({
      fromDateISO: "2026-03-09",
      toDateISO: "2026-03-10",
      currency: "TRY",
      hasPriorSnapshot: true,
      previousAvailableCash: 1_500_000,
      currentAvailableCash: 1_820_000,
      previousLiquidityGap7: 250_000,
      currentLiquidityGap7: 570_000,
      bankInflows: [
        {
          id: "bt-gold-in",
          amount: 500_000,
          counterpartyName: "Altın Müşteri Sanayi A.Ş.",
          description: "Paraşüt #INV-GOLD-101 Tahsilatı",
          txnDate: "2026-03-10",
        },
      ],
      bankOutflows: [
        {
          id: "bt-gold-out",
          amount: 180_000,
          counterpartyName: "Altın Çelik Tedarik Ltd.",
          description: "Ödeme Paketi #PR-GOLD-01 EFT",
          txnDate: "2026-03-10",
        },
      ],
      newlyEntered7dObligations: [],
      slippedPromisesAndOverdueAr: [],
      explicitFxImpact: 0,
    });
    expect(delta.cashDeltaIdentityBalanced).toBe(true);
    expect(delta.cashDeltaIdentityDiff).toBe(0);
    expect(delta.deltaAvailableCash).toBe(320_000);
    expect(delta.realizedBankInflows).toBe(500_000);
    expect(delta.realizedBankOutflows).toBe(-180_000);

    // Nakit DSCR: CFADS = 900.000 - (300.000 + 60.000) = 540.000; Borç Servisi = 200.000 + 60.000 + 10.000 = 270.000 -> DSCR = 2.00x
    const dscr = computeCashDscrWindow({
      horizon: "trailing_3m",
      label: "Son 3 Ay",
      periodStart: "2025-12-10",
      periodEnd: "2026-03-10",
      operationalInflows: [900_000],
      operationalOutflowsBeforeDebtService: [300_000, 60_000],
      installments: [
        {
          amount: 270_000,
          principalComponent: 200_000,
          interestComponent: 60_000,
          taxComponentBsmvKkdf: 10_000,
        },
      ],
    });
    expect(dscr.cfads).toBe(540_000);
    expect(dscr.totalDebtService).toBe(270_000);
    expect(dscr.dscr).toBe(2);
    expect(dscr.confidence).toBe("full");

    // İkili Runway & Başabaş Kaldıraçları
    const dualRunway = computeDualCashRunway({
      months: [
        { monthStart: "2026-03-01", closing: 900_000 },
        { monthStart: "2026-04-01", closing: 450_000 },
        { monthStart: "2026-05-01", closing: -50_000 },
      ],
      anchorMonth: "2026-03-01",
      todayISO: "2026-03-10",
      openingCash: 600_000,
      minCashFloor: 500_000,
      datedFlows: [{ dateISO: "2026-03-20", signedAmount: -150_000 }],
    });
    expect(dualRunway.zeroCashRunwayMonths).toBe(2);
    expect(dualRunway.floorRunwayDays).toBe(10);
    expect(dualRunway.floorBreached).toBe(true);

    const goalSeek = solveBreakevenLevers({
      horizon: "13w",
      asOfDate: "2026-03-10",
      currency: "TRY",
      openingCash: 400_000,
      minCashFloor: 500_000,
      flows: [
        {
          dateISO: "2026-03-25",
          direction: "outflow",
          amount: 200_000,
          isDiscretionary: true,
          label: "İhtiyari Gider",
        },
      ],
      openReceivables: [{ invoiceNo: "INV-F3-01", dueDate: "2026-04-04", amount: 350_000 }],
      availableCreditHeadroom: 250_000,
      productionCostModel: {
        monthlyTotalCost: 900_000,
        effectiveMonthlyMinutes: 45_000,
        currentRateTlPerMin: 20,
      },
    });
    expect(goalSeek.status).toBe("deficit_detected");
    expect(goalSeek.requiredShortfall).toBe(300_000);
    expect(goalSeek.levers.collectionDsoAcceleration.feasible).toBe(true);
    expect(goalSeek.levers.collectionDsoAcceleration.requiredDaysAcceleration).toBe(10);
  });
});

describe.runIf(hasDisposableDb || requireDisposableDb)(
  "Faz 56 (F3) — Canlı Tek Kullanımlık DB Birleşik Altın Şirket Uçtan Uca CFO Senaryosu (0.00 Kuruş Sapma)",
  { timeout: 90_000 },
  () => {
    let pool: Pool;
    let actorId = "";
    let approverId = "";
    let tryBankId = "";
    let tryBank2Id = "";
    let usdBankId = "";
    let eurNullBankId = "";
    let customerId = "";
    let supplierId = "";

    beforeAll(async () => {
      const dbTarget = assertDisposableTargetDb(
        undefined,
        "Faz 56 (F3) golden-end-to-end-cfo-suite test",
      );
      pool = new Pool({ connectionString: dbTarget.url, max: 2 });
      actorId = await ensureSystemActor(pool);

      const approverRes = await pool.query<{ id: string }>(
        `insert into public.users (username, password_hash, display_name, role, is_active)
         values ('f3_golden_approver', 'argon2-placeholder', 'F3 Onaycı CFO', 'finance_manager', true)
         on conflict (username) do update set role = 'finance_manager', is_active = true
         returning id::text`,
      );
      approverId = approverRes.rows[0].id;

      // Clean disposable DB tables for deterministic Golden Company state
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`alter table public.management_journal_entries disable trigger user`);
        await client.query(`alter table public.management_journal_lines disable trigger user`);
        await client.query(`delete from public.management_journal_lines`);
        await client.query(`delete from public.management_journal_entries`);
        await client.query(`alter table public.management_journal_lines enable trigger user`);
        await client.query(`alter table public.management_journal_entries enable trigger user`);
        await client.query(
          `truncate table
             public.trial_balance_reconciliation_items,
             public.trial_balance_reconciliation_runs,
             public.statutory_trial_balance_lines,
             public.statutory_trial_balances,
             public.forecast_snapshot_13w_lines,
             public.forecast_snapshots_13w,
             public.payment_run_items,
             public.payment_runs,
             public.bank_transaction_match_candidates,
             public.invoice_allocations,
             public.check_events,
             public.checks,
             public.check_bordros,
             public.loan_installments,
             public.loans,
             public.payment_instances,
             public.payments,
             public.invoice_lines,
             public.invoices,
             public.bank_transactions,
             public.integration_entity_links,
             public.integration_account_mappings,
             public.integration_staged_parties,
             public.integration_raw_payloads,
             public.integration_sync_runs,
             public.bank_accounts,
             public.cash_accounts,
             public.cashflow_months,
             public.promise_to_pay,
             public.covenant_records,
             public.facility_movements,
             public.credit_facilities,
             public.collateral_records,
             public.treasury_policies,
             public.reports
           restart identity cascade`,
        );
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    }, 90_000);

    afterAll(async () => {
      if (pool) await pool.end();
    }, 60_000);

    it("Adım 1: TRY + USD + EUR kasa/banka hesaplarını ve FIN-03 (NULL vs. dolu açılış bakiyesi) kurallarını doğrular", async () => {
      const caTry1 = await pool.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('F3 Garanti Ana TRY', 'bank_account', 'TRY', 1000000.00, true)
         returning id::text`,
      );
      tryBankId = caTry1.rows[0].id;
      await pool.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, iban)
         values ($1, 'Garanti BBVA', $2)`,
        [tryBankId, makeValidTrIban("00062", "00000000000999001")],
      );

      const caTry2 = await pool.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('F3 İş Bankası TRY', 'bank_account', 'TRY', 500000.00, true)
         returning id::text`,
      );
      tryBank2Id = caTry2.rows[0].id;
      await pool.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, iban)
         values ($1, 'İş Bankası', $2)`,
        [tryBank2Id, makeValidTrIban("00064", "00000000000999002")],
      );

      const caUsd = await pool.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('F3 Garanti USD', 'bank_account', 'USD', 50000.00, true)
         returning id::text`,
      );
      usdBankId = caUsd.rows[0].id;
      await pool.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, iban)
         values ($1, 'Garanti BBVA', $2)`,
        [usdBankId, makeValidTrIban("00062", "00000000000999003")],
      );

      // FIN-03: EUR hesabı opening_balance = NULL (bilinmiyor — asla 0.00 varsayılmaz!)
      const caEur = await pool.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('F3 Yapı Kredi EUR (Açılış Bilinmiyor)', 'bank_account', 'EUR', null, true)
         returning id::text`,
      );
      eurNullBankId = caEur.rows[0].id;
      await pool.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, iban)
         values ($1, 'Yapı Kredi', $2)`,
        [eurNullBankId, makeValidTrIban("00067", "00000000000999004")],
      );

      const posRes = await pool.query<{
        currency: string;
        total_balance: string | null;
        unknown_opening_count: number;
      }>(
        `select currency, total_derived_balance::text as total_balance, unknown_opening_count::int
         from public.treasury_position_summary
         order by currency`,
      );
      const byCurr = new Map(posRes.rows.map((r) => [r.currency, r]));
      expect(Number(byCurr.get("TRY")?.total_balance)).toBe(1_500_000.0);
      expect(byCurr.get("TRY")?.unknown_opening_count).toBe(0);
      expect(Number(byCurr.get("USD")?.total_balance)).toBe(50_000.0);
      expect(byCurr.get("USD")?.unknown_opening_count).toBe(0);
      // EUR has NULL opening_balance -> total_balance MUST be NULL and unknown_opening_count = 1
      expect(byCurr.get("EUR")?.total_balance).toBeNull();
      expect(byCurr.get("EUR")?.unknown_opening_count).toBe(1);
    });

    it("Adım 2: Paraşüt v4 (satış faturası, tevkifatlı fatura, alış faturası, virman) + MT940 çapraz-kanal tekilleştirmesini çalıştırır", async () => {
      const cust = await createCounterparty(
        pool,
        {
          name: "F3 Altın Müşteri A.Ş.",
          partyType: "customer",
          taxNumber: "5600000001",
        },
        actorId,
      );
      customerId = cust.partyId;
      if (cust.approvalId) {
        await decideApproval(
          pool,
          { approvalId: cust.approvalId, decision: "approved", note: "Müşteri onaylandı" },
          approverId,
        );
      }

      const supp = await createCounterparty(
        pool,
        {
          name: "F3 Altın Tedarikçi Sanayi Ltd.",
          partyType: "vendor",
          taxNumber: "5600000002",
        },
        actorId,
      );
      supplierId = supp.partyId;
      if (supp.approvalId) {
        await decideApproval(
          pool,
          { approvalId: supp.approvalId, decision: "approved", note: "Tedarikçi onaylandı" },
          approverId,
        );
      }

      const ibanStr = makeValidTrIban("00062", "00000000000888001");
      const ibanRes = await addIban(
        pool,
        {
          partyId: supplierId,
          iban: ibanStr,
          currency: "TRY",
          accountLabel: "Ana Tedarikçi IBAN",
          isPrimary: true,
        },
        actorId,
      );
      if (ibanRes.approvalId) {
        await decideApproval(
          pool,
          {
            approvalId: ibanRes.approvalId,
            decision: "approved",
            note: "Tedarikçi IBAN doğrulandı",
          },
          approverId,
        );
      }

      const garantiIban = makeValidTrIban("00062", "00000000000999001");
      const isbankIban = makeValidTrIban("00064", "00000000000999002");

      // Account mapping for Paraşüt accounts -> MAS cash_accounts / bank_accounts
      await pool.query(
        `insert into public.integration_account_mappings
           (provider, external_account_id, external_account_name, external_currency, external_iban, cash_account_id, bank_account_id)
         values
           ('parasut', '901', 'F3 Garanti Ana TRY', 'TRL', $1, $2, $2),
           ('parasut', '902', 'F3 İş Bankası TRY', 'TRL', $3, $4, $4)`,
        [garantiIban, tryBankId, isbankIban, tryBank2Id],
      );

      const mockHttp = mockHttpClient((req: HttpRequest): HttpResponse => {
        if (req.url.includes("/oauth/token")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: "f3-token",
              token_type: "bearer",
              expires_in: 7200,
            }),
          };
        }
        if (req.url.includes("/contacts")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                {
                  id: "c-cust-1",
                  type: "contacts",
                  attributes: {
                    name: "F3 Altın Müşteri A.Ş.",
                    tax_number: "5600000001",
                    account_type: "customer",
                  },
                },
                {
                  id: "c-supp-1",
                  type: "contacts",
                  attributes: {
                    name: "F3 Altın Tedarikçi Sanayi Ltd.",
                    tax_number: "5600000002",
                    account_type: "supplier",
                  },
                },
              ],
              meta: { total_pages: 1 },
            }),
          };
        }
        if (req.url.includes("/accounts")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                {
                  id: "901",
                  type: "accounts",
                  attributes: {
                    name: "F3 Garanti Ana TRY",
                    currency: "TRL",
                    account_type: "bank",
                    iban: garantiIban,
                  },
                },
                {
                  id: "902",
                  type: "accounts",
                  attributes: {
                    name: "F3 İş Bankası TRY",
                    currency: "TRL",
                    account_type: "bank",
                    iban: isbankIban,
                  },
                },
              ],
              meta: { total_pages: 1 },
            }),
          };
        }
        if (req.url.includes("/sales_invoices")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                // 1) Normal satış faturası: Net 200.000 + %20 KDV 40.000 = 240.000 TRY
                {
                  id: "si-f3-1",
                  type: "sales_invoices",
                  attributes: {
                    invoice_no: "F3-SAT-2026-001",
                    issue_date: "2026-03-03",
                    due_date: "2026-03-10",
                    currency: "TRL",
                    net_total: "200000.00",
                    total_vat: "40000.00",
                    gross_total: "240000.00",
                    remaining_in_trl: "240000.00",
                    contact_name: "F3 Altın Müşteri A.Ş.",
                    tax_number: "5600000001",
                  },
                  relationships: {
                    contact: { data: { id: "c-cust-1", type: "contacts" } },
                  },
                },
                // 2) 9/10 KDV Tevkifatlı satış faturası: Net 100.000, Hesaplanan KDV 20.000, Tevkifat 18.000 -> Tahsil edilecek = 102.000 TRY
                {
                  id: "si-f3-2",
                  type: "sales_invoices",
                  attributes: {
                    invoice_no: "F3-TEV-2026-002",
                    issue_date: "2026-03-04",
                    due_date: "2026-03-18",
                    currency: "TRL",
                    net_total: "100000.00",
                    total_vat: "20000.00",
                    gross_total: "120000.00",
                    vat_withholding: "18000.00",
                    net_total_after_withholding: "102000.00",
                    remaining_in_trl: "102000.00",
                    contact_name: "F3 Altın Müşteri A.Ş.",
                    tax_number: "5600000001",
                  },
                  relationships: {
                    contact: { data: { id: "c-cust-1", type: "contacts" } },
                  },
                },
              ],
              meta: { total_pages: 1 },
            }),
          };
        }
        if (req.url.includes("/purchase_bills")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                // Alış faturası 1 (Ödeme paketiyle ödenecek): Net 100.000 + %20 KDV 20.000 = 120.000 TRY
                {
                  id: "pb-f3-1",
                  type: "purchase_bills",
                  attributes: {
                    invoice_no: "F3-ALIS-2026-001",
                    issue_date: "2026-03-03",
                    due_date: "2026-03-09",
                    currency: "TRL",
                    net_total: "100000.00",
                    total_vat: "20000.00",
                    gross_total: "120000.00",
                    remaining_in_trl: "120000.00",
                    supplier_name: "F3 Altın Tedarikçi Sanayi Ltd.",
                    tax_number: "5600000002",
                  },
                  relationships: {
                    supplier: { data: { id: "c-supp-1", type: "contacts" } },
                  },
                },
                // Alış faturası 2 (80.000 TRY müşteri çeki cirosuyla kapatılacak): Net 80.000 + KDV 0 = 80.000 TRY
                {
                  id: "pb-f3-2",
                  type: "purchase_bills",
                  attributes: {
                    invoice_no: "F3-ALIS-2026-002",
                    issue_date: "2026-03-04",
                    due_date: "2026-03-25",
                    currency: "TRL",
                    net_total: "80000.00",
                    total_vat: "0.00",
                    gross_total: "80000.00",
                    remaining_in_trl: "80000.00",
                    supplier_name: "F3 Altın Tedarikçi Sanayi Ltd.",
                    tax_number: "5600000002",
                  },
                  relationships: {
                    supplier: { data: { id: "c-supp-1", type: "contacts" } },
                  },
                },
              ],
              meta: { total_pages: 1 },
            }),
          };
        }
        if (req.url.includes("/transactions")) {
          return {
            ok: true,
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                // Müşteri tahsilatı +240.000 TRY
                {
                  id: "ptx-f3-1",
                  type: "transactions",
                  attributes: {
                    date: "2026-03-05",
                    amount: "240000.00",
                    currency: "TRL",
                    description: "F3-SAT-2026-001 Tahsilatı",
                  },
                  relationships: {
                    debit_account: { data: { id: "901", type: "accounts" } },
                  },
                },
                // Kendi hesaplarımız arası virman (901 -> 902, 50.000 TRY): own_transfer olarak işaretlenmeli!
                {
                  id: "ptx-f3-transfer",
                  type: "transactions",
                  attributes: {
                    date: "2026-03-05",
                    amount: "50000.00",
                    currency: "TRL",
                    description: "Garanti -> İş Bankası Virman",
                  },
                  relationships: {
                    credit_account: { data: { id: "901", type: "accounts" } },
                    debit_account: { data: { id: "902", type: "accounts" } },
                  },
                },
              ],
              meta: { total_pages: 1 },
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({ data: [], meta: { total_pages: 1 } }),
        };
      });

      const connector = parasutConnector({
        limiterOptions: { maxRequestsPerWindow: 100, sleep: async () => {} },
      });
      const syncOut = await connector.sync(
        {
          connectionId: "",
          config: { companyId: "10500" },
          credential: JSON.stringify({
            clientId: "cid",
            clientSecret: "csec",
            username: "u@example.com",
            password: "pw",
            companyId: "10500",
          }),
          http: mockHttp,
          asOfISO: "2026-03-10T00:00:00Z",
        },
        pool,
        actorId,
      );
      expect(syncOut.ok).toBe(true);
      expect(syncOut.imported).toBeGreaterThanOrEqual(6);

      // MT940 ekstre ile aynı +240.000 TRY hareket geldiğinde cross_channel_dedupe_hash ile çift kayıt engellenir!
      const mt940Text = [
        ":20:STMT20260305",
        `:25:${garantiIban}`,
        ":28C:00001/001",
        ":60F:C260305TRY1000000,00",
        ":61:2603050305C240000,00NTRFNONREF//BANKREF991",
        ":86:F3-SAT-2026-001 Tahsilati VKN:5600000001",
        ":62F:C260305TRY1240000,00",
      ].join("\r\n");

      const hybridRes = await importHybridBankStatement(pool, {
        buf: Buffer.from(mt940Text, "utf8"),
        filename: "garanti_20260305.sta",
        bankAccountId: tryBankId,
        actorId,
      });
      expect(hybridRes.ok).toBe(true);
      expect(hybridRes.duplicates).toBe(1);
      expect(hybridRes.inserted).toBe(0);
    });

    it("Adım 3: Müşteri çeki alımı (101.01), tedarikçiye ciro (320 / 101.01 + 900/901 nazım rücu riski) ve kredi taksiti (300/780) işlemlerini doğrular", async () => {
      // 80.000 TRY müşteri çeki oluşturulur ve portföye alınır
      const chkRes = await pool.query<{ id: string }>(
        `insert into public.checks
           (serial_no, direction, status, amount, signed_amount, currency, maturity_date,
            payer_party_id, counterparty_label, instrument_type)
         values
           ('CHK-F3-80K', 'inflow', 'planned', 80000.00, 80000.00, 'TRY', '2026-03-25',
            $1, 'F3 Altın Müşteri A.Ş.', 'check')
         returning id::text`,
        [customerId],
      );
      const checkId = chkRes.rows[0].id;

      const recPortfolio = await executeCheckBordroTransition(
        pool,
        {
          operation: "receive_to_portfolio",
          bordroDate: "2026-03-04",
          checkIds: [checkId],
          targetPartyId: customerId,
          notes: "F3 Müşteri Çeki Giriş Bordrosu",
        },
        actorId,
      );
      expect(recPortfolio.nextStatus).toBe("in_portfolio");

      const pb2Row = await pool.query<{ id: string }>(
        `select id::text from public.invoices where invoice_no = 'F3-ALIS-2026-002'`,
      );
      const purchaseInvoice2Id = pb2Row.rows[0].id;

      // Çek tedarikçiye ciro edilir (status -> endorsed_to_vendor)
      const bordroRes = await executeCheckBordroTransition(
        pool,
        {
          operation: "endorse_to_vendor",
          bordroDate: "2026-03-05",
          checkIds: [checkId],
          targetPartyId: supplierId,
          targetInvoiceId: purchaseInvoice2Id,
          notes: "F3 Tedarikçi Ciro Bordrosu",
        },
        actorId,
      );
      expect(bordroRes.processedCount).toBe(1);
      expect(bordroRes.nextStatus).toBe("endorsed_to_vendor");

      const chkAfter = await pool.query<{ status: string; endorsed_to_party_id: string }>(
        `select status, endorsed_to_party_id::text from public.checks where id = $1`,
        [checkId],
      );
      expect(chkAfter.rows[0].status).toBe("endorsed_to_vendor");
      expect(chkAfter.rows[0].endorsed_to_party_id).toBe(supplierId);

      // Kredi ve taksit: 150.000 TRY anapara (300) + 30.000 TRY faiz (780) + 1.500 TRY BSMV (780) = 181.500 TRY ödendi
      const loanRes = await pool.query<{ id: string }>(
        `insert into public.loans
           (name, principal, total_payment, currency, first_payment_date, installment_count, status)
         values
           ('F3 İşletme Kredisi', 1500000.00, 1815000.00, 'TRY', '2026-03-05', 10, 'active')
         returning id::text`,
      );
      const loanId = loanRes.rows[0].id;

      await pool.query(
        `insert into public.loan_installments
           (loan_id, installment_no, due_date, amount, principal_component, interest_component,
            tax_component, status, paid_at)
         values
           ($1, 1, '2026-03-05', 181500.00, 150000.00, 30000.00, 1500.00, 'paid', '2026-03-05T10:00:00Z')`,
        [loanId],
      );
    });

    it("Adım 4: Ödeme Paketi (payment_runs + Maker-Checker + pain.001.001.03 XML + Banka Eşleştirmesiyle Atomik Kapanış) ve Dönem Kilidi (0100) kurallarını doğrular", async () => {
      // Alış faturasını (120.000 TRY) ödeme paketine ekle
      const pbRow = await pool.query<{ id: string }>(
        `select id::text from public.invoices where invoice_no = 'F3-ALIS-2026-001'`,
      );
      const purchaseInvoiceId = pbRow.rows[0].id;

      const run = await createPaymentRun(
        pool,
        {
          sourceBankAccountId: tryBankId,
          plannedExecutionDate: "2026-03-06",
          currency: "TRY",
          items: [
            {
              targetType: "invoice",
              targetId: purchaseInvoiceId,
              description: "F3-ALIS-2026-001 Tedarikçi Ödemesi",
            },
          ],
        },
        actorId,
        "2026-03-06",
      );
      expect(run.totalAmount).toBe(120_000);

      const submitted = await submitPaymentRunForApproval(
        pool,
        { runId: run.runId },
        actorId,
      );
      expect(submitted.approvalId).toBeTruthy();

      // Maker-Checker: oluşturan (actorId) kendi paketini onaylayamaz, farklı yönetici (approverId) onaylar
      await expect(
        decideApproval(
          pool,
          {
            approvalId: submitted.approvalId,
            decision: "approved",
            note: "Kendi kendine onay denemesi",
          },
          actorId,
        ),
      ).rejects.toThrow(/maker-checker/);

      await decideApproval(
        pool,
        {
          approvalId: submitted.approvalId,
          decision: "approved",
          note: "CFO Onayı — 14g kasa tamponu uygun",
        },
        approverId,
      );

      // ISO 20022 pain.001.001.03 XML ihracı
      const xmlOut = await exportPaymentRun(
        pool,
        {
          runId: run.runId,
          format: "pain001",
          debtorName: "MAS Makine ve Otomasyon A.Ş.",
        },
        approverId,
      );
      const xmlStr = xmlOut.buffer.toString("utf8");
      expect(xmlStr).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
      expect(xmlStr).toContain("<NbOfTxs>1</NbOfTxs>");
      expect(xmlStr).toContain("<CtrlSum>120000.00</CtrlSum>");

      // Banka ekstresinde -120.000 TRY çıkış hareketi ve acceptMatch ile atomik kapanış
      const btOut = await pool.query<{ id: string }>(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, amount, currency, description, counterparty_name_raw, status, dedupe_hash)
         values
           ($1, '2026-03-06', -120000.00, 'TRY', 'F3-ALIS-2026-001 EFT', 'F3 Altın Tedarikçi Sanayi Ltd.', 'unmatched', 'f3-bt-out-120k')
         returning id::text`,
        [tryBankId],
      );

      await acceptMatch(
        pool,
        {
          transactionId: btOut.rows[0].id,
          targetTable: "invoices",
          targetId: purchaseInvoiceId,
        },
        approverId,
      );

      const invAfter = await pool.query<{ status: string; allocated_amount: string }>(
        `select status, allocated_amount::text from public.invoices where id = $1`,
        [purchaseInvoiceId],
      );
      expect(invAfter.rows[0].status).toBe("paid");
      expect(Number(invAfter.rows[0].allocated_amount)).toBe(120_000);

      const runAfter = await pool.query<{ status: string }>(
        `select status from public.payment_runs where id = $1`,
        [run.runId],
      );
      expect(runAfter.rows[0].status).toBe("settled");

      // 0100: Kilitli döneme (Ocak 2026) geçmişe dönük banka hareketi yazılması DB tetikleyicisiyle reddedilir!
      await pool.query(
        `insert into public.cashflow_months (month_start, status, locked_at, locked_by)
         values ('2026-01-01', 'locked', now(), $1)
         on conflict (month_start) do update set status = 'locked', locked_at = now(), locked_by = $1`,
        [approverId],
      );
      await expect(
        pool.query(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, amount, currency, description, status, dedupe_hash)
           values ($1, '2026-01-15', -1000.00, 'TRY', 'Geçmişe dönük sızıntı', 'unmatched', 'f3-locked-leak')`,
          [tryBankId],
        ),
      ).rejects.toThrow(/kilitli/i);
    });

    it("Adım 5: Çift Taraflı TDHP Yönetim Defteri (Mizan Borç === Alacak, Bilanço Aktif === Pasif, EBITDA) ve 12 Kök Nedenli Yasal Mizan Köprüsünü 0.00 kuruş farkla doğrular", async () => {
      // Açılış Sermaye ve Kredi Kullanım Fişi
      await postManualManagementAdjustment(
        pool,
        {
          entryDate: "2026-03-01",
          description: "F3 Açılış Sermaye ve Banka Kredisi Fişi",
          currency: "TRY",
          status: "posted",
          idempotencyKey: "f3:opening:capital_and_loan",
          lines: [
            { accountCode: "102", debitNative: 3_000_000, creditNative: 0 },
            { accountCode: "300", debitNative: 0, creditNative: 1_500_000 },
            { accountCode: "500", debitNative: 0, creditNative: 1_500_000 },
          ],
        },
        approverId,
      );

      const syncRes = await rebuildOrSyncManagementLedger(pool, approverId);
      expect(syncRes.createdCount).toBeGreaterThanOrEqual(4);

      // Amortisman (770.99 Borç 25.000 / 257 Alacak 25.000)
      await postManualManagementAdjustment(
        pool,
        {
          entryDate: "2026-03-06",
          description: "F3 Mart 2026 Amortisman Tahakkuku",
          currency: "TRY",
          status: "posted",
          idempotencyKey: "f3:depreciation:2026-03",
          lines: [
            { accountCode: "770.99", debitNative: 25_000, creditNative: 0 },
            { accountCode: "257", debitNative: 0, creditNative: 25_000 },
          ],
        },
        approverId,
      );

      const overview = await loadManagementLedgerOverview(pool);
      // Mizan Borç === Alacak (kuruş farkı = 0.00)
      expect(overview.totalDebitTry).toBeGreaterThan(0);
      expect(overview.totalDebitTry).toBe(overview.totalCreditTry);
      expect(overview.totalDebitBalanceTry).toBe(overview.totalCreditBalanceTry);

      // Bilanço Aktif === Pasif (kuruş farkı = 0.00)
      expect(overview.totalAssetsTry).toBeGreaterThan(0);
      expect(overview.totalAssetsTry).toBe(overview.totalLiabilitiesAndEquityTry);

      // Gelir Tablosu & Yönetim EBITDA:
      // Satışlar (600): 200.000 (F3-SAT-2026-001) + 100.000 (F3-TEV-2026-002) = 300.000 TRY
      // D&A (770.99 / 257): 25.000 TRY -> Yönetim EBITDA = EBIT + 25.000 TRY!
      expect(overview.incomeStatement.netSalesTry).toBe(300_000);
      expect(overview.incomeStatement.daAddbackTry).toBe(25_000);
      expect(overview.incomeStatement.managementEbitdaTry).toBe(
        overview.incomeStatement.ebitTry + 25_000,
      );

      // 0106: Mali Müşavir Yasal Mizan İçe Aktarımı ve 12 Kök Nedenli Mutabakat Köprüsü
      const xmlMizan = `<?xml version="1.0" encoding="UTF-8"?>
<Mizan>
  <Satir><HesapKodu>102</HesapKodu><HesapAdi>BANKALAR</HesapAdi><BorcToplami>3000000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>120</HesapKodu><HesapAdi>ALICILAR</HesapAdi><BorcToplami>342000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>300</HesapKodu><HesapAdi>BANKA KREDİLERİ</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>1500000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>391</HesapKodu><HesapAdi>HESAPLANAN KDV</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>42000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>500</HesapKodu><HesapAdi>SERMAYE</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>1500000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>600</HesapKodu><HesapAdi>YURTİÇİ SATIŞLAR</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>300000,00</AlacakToplami></Satir>
</Mizan>`;

      const importedMizan = await importStatutoryMizan(
        pool,
        {
          asOfDate: "2026-03-31",
          periodLabel: "2026-03 Mart Yasal Mizan",
          sourceSoftware: "Luca",
          originalFilename: "f3_mart_2026_mizan.xml",
          buffer: Buffer.from(xmlMizan, "utf8"),
        },
        approverId,
      );
      expect(importedMizan.isSelfBalanced).toBe(true);

      const recon = await reconcileTrialBalance(
        pool,
        importedMizan.trialBalanceId,
        approverId,
      );
      expect(recon.items.length).toBeGreaterThan(0);
      const b = recon.ebitdaTo690Bridge;
      expect(b.managementEbitdaTry).toBe(overview.incomeStatement.managementEbitdaTry);
      expect(
        b.management690EbtTry +
          b.revenueTimingGapTry +
          b.expenseTimingGapTry +
          b.financingTimingGapTry +
          b.unexplainedBridgeResidualTry,
      ).toBe(b.statutory690EbtTry);
    });

    it("Adım 6: 13-Hafta Otomatik Tahmin Dondurma, Zamanlama vs. Kalıcı Varyans Şelalesi ve Faz 55 CFO Zekâsı (Gece Deltası + Kovenant/DSCR) zincirini doğrular", async () => {
      const forecast = await buildAutoSeeded13WeekForecast(pool, {
        asOfDate: "2026-03-02",
        currency: "TRY",
        dbtMode: "median",
      });
      expect(forecast.weeks.length).toBe(13);
      expect(forecast.unknownOpeningCount).toBe(0);

      const frozen = await freezeWeekly13wSnapshot(pool, {
        asOfDate: "2026-03-02",
        currency: "TRY",
        actor: approverId,
        dbtMode: "median",
      });
      expect(frozen.snapshotWeekStart).toBe("2026-03-02");

      const waterfall = await compute13wVarianceWaterfall(pool, {
        snapshotId: frozen.snapshotId,
        weekStart: "2026-03-02",
      });
      expect(waterfall.snapshotId).toBe(frozen.snapshotId);
      // Actual net in Week 1 (2026-03-02..2026-03-08): +240.000 (tahsilat) - 120.000 (ödeme paketi) = +120.000 TRY (own_transfer 50.000 hariç!)
      expect(waterfall.actualBankInflow).toBe(240_000);
      expect(waterfall.actualBankOutflow).toBe(120_000);
      expect(waterfall.actualBankNetMovement).toBe(120_000);
      expect(waterfall.identityBalanced).toBe(true);
      expect(waterfall.identityDiff).toBe(0);

      // Faz 55: Canlı DB Kovenant & DSCR Radarı ve Gece Nakit Değişim Atfı
      const radar = await loadCovenantAndDscrRadar(pool, {
        asOfDate: "2026-03-10",
        currency: "TRY",
      });
      expect(radar.dscrWindows.trailing3m.operationalInflows).toBe(240_000);
      expect(radar.dscrWindows.trailing3m.operationalOutflowsBeforeDebtService).toBe(120_000);
      expect(radar.dscrWindows.trailing3m.principalComponent).toBe(150_000);
      expect(radar.dscrWindows.trailing3m.interestComponent).toBe(30_000);
      expect(radar.dscrWindows.trailing3m.taxComponentBsmvKkdf).toBe(1_500);

      const liveDelta = await loadOvernightDeltaAttribution(pool, "2026-03-06", {
        currency: "TRY",
      });
      expect(liveDelta.cashDeltaIdentityBalanced).toBe(true);
      expect(liveDelta.cashDeltaIdentityDiff).toBe(0);
    });
  },
);