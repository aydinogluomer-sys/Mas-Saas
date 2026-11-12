import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildOvernightDeltaAttribution,
  formatOvernightDeltaBridgeMd,
  loadOvernightDeltaAttribution,
  maskCounterpartyLabel,
} from "@/lib/briefing/delta-attribution";
import { renderBriefing } from "@/lib/briefing/rules";
import { computeDualCashRunway, computeForwardCashRunway } from "@/lib/facts/engine";
import {
  computeCashDscrWindow,
  evaluateCovenantThreshold,
  loadCovenantAndDscrRadar,
} from "@/lib/financing/covenants-and-dscr";
import {
  loadAndSolveBreakevenLevers,
  solveBreakevenLevers,
} from "@/lib/scenarios/breakeven-goalseek";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

let pool: Pool;

describe.runIf(hasDisposableDb || requireDisposableDb)(
  "Faz 55 (F2) — Gece Nakit/Gap7 Değişim Atfı, Kovenant & Nakit DSCR Erken Uyarı, İkili Runway ve Başabaş Goal-Seek",
  { timeout: 60_000 },
  () => {
  beforeAll(async () => {
    const dbTarget = assertDisposableTargetDb(
      undefined,
      "Faz 55 (F2) cfo-intelligence-f2 test",
    );
    pool = new Pool({ connectionString: dbTarget.url, max: 2 });
    await pool.query("SELECT 1");
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  }, 60_000);

  it("Test 1: Dünden Bugüne Nakit & 7 Günlük Likidite Açığı Değişim Atfı (5 bileşen + kuruşu kuruşuna özdeşlik + maskeleme)", async () => {
    // 1A. Saf motor: 5 bileşenli ayrıştırma ve Nakit Değişim Özdeşliği
    const pureDelta = buildOvernightDeltaAttribution({
      fromDateISO: "2026-03-09",
      toDateISO: "2026-03-10",
      currency: "TRY",
      hasPriorSnapshot: true,
      previousAvailableCash: 1_000_000,
      currentAvailableCash: 1_235_000, // +235.000 TL değişim (+350k giriş - 120k çıkış + 5k kur/düzeltme)
      previousLiquidityGap7: -50_000,
      currentLiquidityGap7: -95_000,
      bankInflows: [
        {
          id: "in-1",
          txnDate: "2026-03-10",
          amount: 350_000,
          description: "Müşteri Havale Tahsilatı",
          counterpartyName: "Anadolu Sanayi A.Ş.",
        },
      ],
      bankOutflows: [
        {
          id: "out-1",
          txnDate: "2026-03-10",
          amount: 120_000,
          description: "Tedarikçi EFT Ödemesi",
          counterpartyName: "Marmara Çelik Ltd.",
        },
      ],
      newlyEntered7dObligations: [
        {
          sourceTable: "payment_instances",
          sourceId: "pi-new-7d",
          dueDate: "2026-03-17",
          amount: 85_000,
          label: "SGK Prim Ödemesi",
          counterpartyName: "SGK",
        },
      ],
      slippedPromisesAndOverdueAr: [
        {
          sourceTable: "promise_to_pay",
          sourceId: "ptp-slip-1",
          dueDate: "2026-03-09",
          amount: 60_000,
          label: "Kırılan Tahsilat Sözü",
          counterpartyName: "Ege Plastik A.Ş.",
        },
      ],
    });

    expect(pureDelta.deltaAvailableCash).toBe(235_000);
    expect(pureDelta.deltaLiquidityGap7).toBe(-45_000);
    expect(pureDelta.realizedBankInflows).toBe(350_000);
    expect(pureDelta.realizedBankOutflows).toBe(-120_000);
    expect(pureDelta.newlyEntered7dObligations).toBe(85_000);
    expect(pureDelta.slippedPromisesAndOverdueAr).toBe(60_000);
    expect(pureDelta.fxAndAdjustmentImpact).toBe(5_000);
    expect(pureDelta.cashDeltaIdentityBalanced).toBe(true);
    expect(pureDelta.cashDeltaIdentityDiff).toBe(0);

    // Maskeleme doğrulaması (Telegram / kapalı devre)
    expect(maskCounterpartyLabel("Anadolu Sanayi A.Ş.")).toBe("An***");
    const unmaskedMd = formatOvernightDeltaBridgeMd(pureDelta, { masked: false });
    const maskedMd = formatOvernightDeltaBridgeMd(pureDelta, { masked: true });
    expect(unmaskedMd).toContain("+350.000,00 TL");
    expect(maskedMd).not.toContain("+350.000,00 TL");
    expect(maskedMd).toContain("+[MASKELİ TL]");

    // Brifing kuralları entegrasyonu (`renderBriefing`)
    const briefingMd = renderBriefing({
      todayISO: "2026-03-10",
      availableCash: 1_235_000,
      minCashFloor: 500_000,
      liquidityGap7: 95_000,
      liquidityGap30: 120_000,
      projectedContracted7: 1_140_000,
      todayOutflowKnown: 40_000,
      todayInflowKnown: 0,
      todayCount: 1,
      todayUnknownAmountCount: 0,
      todayForeignCurrencyCount: 0,
      overdueForeignCurrencyCount: 0,
      overdueCount: 1,
      overdueKnownOutflow: 60_000,
      criticalControls: [],
      openAlertCount: 0,
      newCriticalAlerts: [],
      promisesDueToday: 0,
      overduePromises: 1,
      dsoDays: 42,
      dpoDays: 35,
      cycleExcludingInventory: 7,
      overnightDelta: pureDelta,
    });
    expect(briefingMd).toContain("## Dünden Bugüne Nakit ve 7 Günlük Açık Değişim Köprüsü");
    expect(briefingMd).toContain("Gerçekleşen Banka Tahsilatları (+): +350.000,00 TL");

    // 1B. Veritabanı entegrasyonu (`loadOvernightDeltaAttribution`)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `TRUNCATE TABLE
           public.reports,
           public.bank_transactions,
           public.payment_instances,
           public.payments,
           public.invoices,
           public.promise_to_pay,
           public.checks,
           public.loan_installments,
           public.loans,
           public.parties,
           public.cash_accounts
         RESTART IDENTITY CASCADE`,
      );

      const accRes = await client.query<{ id: string }>(
        `INSERT INTO public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         VALUES ('F2 Ana Vadesiz TL', 'bank_account', 'TRY', 1230000.00, true)
         RETURNING id`,
      );
      const bankAccId = accRes.rows[0].id;
      await client.query(
        `INSERT INTO public.bank_accounts (cash_account_id, bank_name)
         VALUES ($1, 'Garanti BBVA')`,
        [bankAccId],
      );

      const partyRes = await client.query<{ id: string }>(
        `INSERT INTO public.parties (name, normalized_name, party_type, is_active)
         VALUES ('Delta Müşteri A.Ş.', 'delta musteri a.s.', 'customer', true),
                ('Delta Tedarik Ltd.', 'delta tedarik ltd.', 'vendor', true)
         RETURNING id`,
      );
      const custId = partyRes.rows[0].id;
      const vendId = partyRes.rows[1].id;

      // Dünkü cfo_briefing raporu (`2026-03-09`)
      await client.query(
        `INSERT INTO public.reports (report_type, period_start, period_end, body_md, meta)
         VALUES (
           'cfo_briefing',
           '2026-03-09',
           '2026-03-09',
           'CFO Sabah Brifingi — 2026-03-09',
           $1::jsonb
         )`,
        [JSON.stringify({ availableCash: 1_000_000, liquidityGap7: -50_000 })],
      );

      // Bugünkü (`2026-03-10`) gerçekleşen banka hareketleri + 1 adet own_transfer (hariç tutulmalı)
      await client.query(
        `INSERT INTO public.bank_transactions (
           bank_account_id, txn_date, amount, currency,
           description, counterparty_name_raw, status, transaction_kind, dedupe_hash
         )
         VALUES
           ($1, '2026-03-10', 350000.00, 'TRY', 'Fatura Tahsilatı', 'Delta Müşteri A.Ş.', 'unmatched', 'standard', 'f2-delta-in-1'),
           ($1, '2026-03-10', -120000.00, 'TRY', 'Hammadde Ödemesi', 'Delta Tedarik Ltd.', 'unmatched', 'standard', 'f2-delta-out-1'),
           ($1, '2026-03-10', -500000.00, 'TRY', 'İç Virman', 'Kendi Hesabımız', 'unmatched', 'own_transfer', 'f2-delta-virman-1')`,
        [bankAccId],
      );

      // Yeni 7 günlük pencereye giren ödeme (`2026-03-17`, yani `(2026-03-16, 2026-03-17]`)
      const payRes = await client.query<{ id: string }>(
        `INSERT INTO public.payments (name, provider_party_id, recurrence_type, due_day, priority, status, default_amount, currency)
         VALUES ('Mart Vergi Ödemesi', $1, 'monthly', 17, 'high', 'active', 85000.00, 'TRY')
         RETURNING id`,
        [vendId],
      );
      await client.query(
        `INSERT INTO public.payment_instances (payment_id, instance_month, due_date, amount, currency, status, direction)
         VALUES ($1, '2026-03-01', '2026-03-17', 85000.00, 'TRY', 'planned', 'outflow')`,
        [payRes.rows[0].id],
      );

      // Dün vadesi dolup tahsil edilmeyen söz (`2026-03-09`)
      await client.query(
        `INSERT INTO public.promise_to_pay (party_id, promised_date, promised_amount, currency, status, note)
         VALUES ($1, '2026-03-09', 60000.00, 'TRY', 'pending', 'Dün beklenen söz')`,
        [custId],
      );

      const dbDelta = await loadOvernightDeltaAttribution(client, "2026-03-10", {
        currency: "TRY",
        currentAvailableCash: 1_230_000,
        currentLiquidityGap7: -95_000,
      });

      expect(dbDelta.hasPriorSnapshot).toBe(true);
      expect(dbDelta.fromDateISO).toBe("2026-03-09");
      expect(dbDelta.realizedBankInflows).toBe(350_000);
      expect(dbDelta.realizedBankOutflows).toBe(-120_000); // 500k own_transfer dışlandı!
      expect(dbDelta.newlyEntered7dObligations).toBe(85_000);
      expect(dbDelta.slippedPromisesAndOverdueAr).toBe(60_000);
      expect(dbDelta.fxAndAdjustmentImpact).toBe(0);
      expect(dbDelta.cashDeltaIdentityBalanced).toBe(true);
      expect(dbDelta.cashDeltaIdentityDiff).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, 60_000);

  it("Test 2: Kovenant & Nakit DSCR / CFADS Erken Uyarı Radarı (3 pencere + sıfıra bölünme koruması + Faz 52 Yönetim EBITDA köprüsü)", async () => {
    // 2A. Saf DSCR hesabı ve sıfıra bölünme koruması
    const normalDscr = computeCashDscrWindow({
      horizon: "trailing_3m",
      label: "Son 3 Ay",
      periodStart: "2025-12-10",
      periodEnd: "2026-03-10",
      operationalInflows: [1_400_000],
      operationalOutflowsBeforeDebtService: [800_000, 100_000, 50_000],
      installments: [
        {
          amount: 300_000,
          principalComponent: 200_000,
          interestComponent: 80_000,
          taxComponentBsmvKkdf: 20_000,
        },
      ],
    });
    // CFADS = 1.400.000 - 950.000 = 450.000 TL
    // Borç Servisi = 200.000 + 80.000 + 20.000 = 300.000 TL => DSCR = 1.50x
    expect(normalDscr.cfads).toBe(450_000);
    expect(normalDscr.totalDebtService).toBe(300_000);
    expect(normalDscr.dscr).toBe(1.5);
    expect(normalDscr.confidence).toBe("full");

    // Sıfıra bölünme koruması (`totalDebtService === 0`)
    const zeroDebtDscr = computeCashDscrWindow({
      horizon: "forward_3m",
      label: "İleri 3 Ay",
      periodStart: "2026-03-11",
      periodEnd: "2026-06-10",
      operationalInflows: [500_000],
      operationalOutflowsBeforeDebtService: [300_000],
      installments: [],
    });
    expect(zeroDebtDscr.totalDebtService).toBe(0);
    expect(zeroDebtDscr.dscr).toBeNull();

    // Kısmi güven (`partial_confidence`) — bilinmeyen (`null`) akış bileşeni
    const partialDscr = computeCashDscrWindow({
      horizon: "forward_12m",
      label: "İleri 12 Ay",
      periodStart: "2026-03-11",
      periodEnd: "2027-03-10",
      operationalInflows: [900_000, null],
      operationalOutflowsBeforeDebtService: [400_000],
      installments: [
        {
          amount: 250_000,
          principalComponent: 200_000,
          interestComponent: 40_000,
          taxComponentBsmvKkdf: 10_000,
        },
      ],
    });
    expect(partialDscr.confidence).toBe("partial_confidence");
    expect(partialDscr.dscr).toBe(2);

    // 2B. Kovenant eşik ve %10 erken uyarı tamponu (`evaluateCovenantThreshold`)
    const covDscrCompliant = evaluateCovenantThreshold({
      comparison: ">=",
      thresholdValue: 1.2,
      measuredValue: 1.45,
      covenantType: "dscr",
    });
    expect(covDscrCompliant.state).toBe("compliant");

    const covDscrWarning = evaluateCovenantThreshold({
      comparison: ">=",
      thresholdValue: 1.2, // %10 tampon sınırı = 1.32
      measuredValue: 1.25,
      covenantType: "dscr",
    });
    expect(covDscrWarning.state).toBe("warning");

    const covLeverageWarning = evaluateCovenantThreshold({
      comparison: "<=",
      thresholdValue: 3.5, // %10 tampon sınırı = 3.15
      measuredValue: 3.25,
      covenantType: "ebitda_multiple",
    });
    expect(covLeverageWarning.state).toBe("warning");

    const covNegativeEbitdaBreach = evaluateCovenantThreshold({
      comparison: "<=",
      thresholdValue: 3.5,
      measuredValue: null,
      covenantType: "ebitda_multiple",
      managementEbitda: -100_000,
      netDebt: 2_000_000,
    });
    expect(covNegativeEbitdaBreach.state).toBe("breached");

    // 2C. Veritabanı entegrasyonu (`loadCovenantAndDscrRadar` + Faz 52 Yönetim EBITDA'sı)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `TRUNCATE TABLE
           public.covenant_records,
           public.facility_movements,
           public.credit_facilities,
           public.loan_installments,
           public.loans,
           public.management_journal_lines,
           public.management_journal_entries,
           public.bank_transactions,
           public.cashflow_months,
           public.cash_accounts
         RESTART IDENTITY CASCADE`,
      );

      // Kasa: açılış 200.000 TL + son 3 ay net banka akışı (+1.200.000 - 600.000 = +600.000) => available_now = 800.000 TL
      const accRes = await client.query<{ id: string }>(
        `INSERT INTO public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         VALUES ('F2 Hazine Banka TL', 'bank_account', 'TRY', 200000.00, true)
         RETURNING id`,
      );
      const bankAccId = accRes.rows[0].id;
      await client.query(
        `INSERT INTO public.bank_accounts (cash_account_id, bank_name)
         VALUES ($1, 'İş Bankası')`,
        [bankAccId],
      );

      // Kredi limiti: 3.000.000 TL limit, 1.000.000 TL kullanılmış (drawdown hareketi ile)
      const facRes = await client.query<{ id: string }>(
        `INSERT INTO public.credit_facilities (name, facility_type, currency, limit_amount, status)
         VALUES ('F2 Rotatif Kredi Limiti', 'revolving', 'TRY', 3000000.00, 'active')
         RETURNING id`,
      );
      const facId = facRes.rows[0].id;
      await client.query(
        `INSERT INTO public.facility_movements (facility_id, movement_type, movement_date, amount, currency)
         VALUES ($1, 'drawdown', '2026-01-15', 1000000.00, 'TRY')`,
        [facId],
      );

      // Taksitli kredi: 1.550.000 TL kalan anapara + gerçekleşen ve ileri vadeli taksitler
      const loanRes = await client.query<{ id: string }>(
        `INSERT INTO public.loans (name, currency, principal, status)
         VALUES ('F2 Yatırım Kredisi', 'TRY', 2000000.00, 'active')
         RETURNING id`,
      );
      const loanId = loanRes.rows[0].id;

      await client.query(
        `INSERT INTO public.loan_installments (
           loan_id, installment_no, due_date, amount,
           principal_component, interest_component, tax_component, status, paid_at
         )
         VALUES
           ($1, 1, '2026-02-15', 300000.00, 200000.00, 80000.00, 20000.00, 'paid', '2026-02-15T10:00:00Z'),
           ($1, 2, '2026-04-15', 300000.00, 200000.00, 80000.00, 20000.00, 'planned', null),
           ($1, 3, '2026-09-15', 1650000.00, 1350000.00, 250000.00, 50000.00, 'planned', null)`,
        [loanId],
      );

      // Son 3 ay banka nakit akışı: +1.200.000 giriş, -600.000 operasyonel çıkış
      await client.query(
        `INSERT INTO public.bank_transactions (
           bank_account_id, txn_date, amount, currency,
           description, status, transaction_kind, dedupe_hash
         )
         VALUES
           ($1, '2026-02-10', 1200000.00, 'TRY', 'Müşteri Tahsilatları', 'unmatched', 'standard', 'f2-dscr-in-1'),
           ($1, '2026-02-20', -600000.00, 'TRY', 'Tedarikçi Ödemeleri', 'unmatched', 'standard', 'f2-dscr-out-1')`,
        [bankAccId],
      );

      // Faz 52 Yönetim Defteri (`management_journal_entries` + `management_journal_lines`):
      // 600 Yurtiçi Satışlar = 2.500.000 alacak, 770 Genel Yönetim Giderleri = 900.000 borç, 257 Birikmiş Amortismanlar = 150.000 alacak
      // Faaliyet Kârı = 2.500.000 - 900.000 = 1.600.000 TL; + 257 Amortisman 150.000 TL => Yönetim EBITDA = 1.750.000 TL
      const accMapRes = await client.query<{ id: string; code: string }>(
        `SELECT id::text, code
           FROM public.management_accounts
          WHERE code IN ('102', '600', '770', '257')`,
      );
      const byCode = new Map(accMapRes.rows.map((r) => [r.code, r.id]));

      const jeRes = await client.query<{ id: string }>(
        `INSERT INTO public.management_journal_entries (
           entry_date, source_type, idempotency_key, status, description
         )
         VALUES ('2026-03-01', 'manual_adjustment', 'MJE-F2-EBITDA-01', 'posted', 'F2 Yönetim EBITDA Fişi')
         RETURNING id`,
      );
      const jeId = jeRes.rows[0].id;

      await client.query(
        `INSERT INTO public.management_journal_lines (
           entry_id, line_no, account_id, native_currency, debit_native, credit_native, debit_try, credit_try, line_memo
         )
         VALUES
           ($1, 1, $2, 'TRY', 1750000.00, 0.00, 1750000.00, 0.00, 'Banka tahsilat net'),
           ($1, 2, $3, 'TRY', 900000.00, 0.00, 900000.00, 0.00, 'Genel yönetim gideri ve amortisman'),
           ($1, 3, $4, 'TRY', 0.00, 2500000.00, 0.00, 2500000.00, 'Yurtiçi satışlar'),
           ($1, 4, $5, 'TRY', 0.00, 150000.00, 0.00, 150000.00, 'Birikmiş amortisman')`,
        [jeId, byCode.get("102"), byCode.get("770"), byCode.get("600"), byCode.get("257")],
      );

      // Kovenant kayıtları
      await client.query(
        `INSERT INTO public.covenant_records (
           facility_id, covenant_type, description, comparison, threshold_value, status
         )
         VALUES
           ($1, 'dscr', 'DSCR >= 1.25', 'gte', 1.25, 'active'),
           ($1, 'ebitda_multiple', 'Net Borç / EBITDA <= 1.05', 'lte', 1.05, 'active')`,
        [facId],
      );

      const radar = await loadCovenantAndDscrRadar(client, {
        asOfDate: "2026-03-10",
        currency: "TRY",
      });

      expect(radar.managementEbitda).toBe(1_750_000);
      // Brüt borç = 1.550.000 (kalan kredi anaparası) + 1.000.000 (rotatif kullanım) = 2.550.000 TL
      // Net borç = 2.550.000 - 800.000 (kasa) = 1.750.000 TL => Net Borç / EBITDA = 1.00x
      expect(radar.netDebt).toBe(1_750_000);
      expect(radar.netDebtToEbitda).toBe(1);

      // Son 3 ay DSCR = (1.200.000 - 600.000) / 300.000 = 2.00x
      expect(radar.dscrWindows.trailing3m.cfads).toBe(600_000);
      expect(radar.dscrWindows.trailing3m.totalDebtService).toBe(300_000);
      expect(radar.dscrWindows.trailing3m.dscr).toBe(2);

      // Net Borç / EBITDA = 1.00x, eşik <= 1.05x (%10 tampon sınırı = 0.945x) => warning!
      expect(radar.warningCount).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, 60_000);

  it("Test 3: İkili İleriye Dönük Nakit Ömrü (Dual Cash Runway — geçmiş negatif ayları yoksayma + 91g taban ve 36a sıfır kasa ayrımı)", () => {
    const months = [
      { monthStart: "2025-11-01", closing: -250_000 }, // geçmiş negatif (yoksayılmalı!)
      { monthStart: "2025-12-01", closing: -100_000 }, // geçmiş negatif (yoksayılmalı!)
      { monthStart: "2026-03-01", closing: 900_000 },
      { monthStart: "2026-04-01", closing: 600_000 },
      { monthStart: "2026-05-01", closing: 250_000 },
      { monthStart: "2026-06-01", closing: -50_000 }, // 3. ileri ayda sıfırın altına düşüyor
      { monthStart: "2026-07-01", closing: -200_000 },
    ];

    const dual = computeDualCashRunway({
      months,
      anchorMonth: "2026-03-01",
      todayISO: "2026-03-10",
      openingCash: 600_000,
      minCashFloor: 500_000,
      datedFlows: [
        { dateISO: "2026-03-12", signedAmount: -60_000 }, // bakiye 540.000 (>= 500.000)
        { dateISO: "2026-03-18", signedAmount: -70_000 }, // bakiye 470.000 (< 500.000 taban ihlali! 8. gün)
      ],
    });

    expect(dual.zeroCashRunwayMonths).toBe(3);
    expect(dual.firstForwardNegativeMonth).toBe("2026-06-01");
    expect(dual.floorRunwayDays).toBe(8);
    expect(dual.floorBreached).toBe(true);
    expect(dual.firstFloorBreachDate).toBe("2026-03-18");

    // Geriye dönük uyumlu `computeForwardCashRunway`
    const legacy = computeForwardCashRunway(months, "2026-03-01");
    expect(legacy.zeroCashRunwayMonths).toBe(3);
    expect(legacy.firstForwardNegativeMonth).toBe("2026-06-01");

    // Açılış nakdi bilinmiyorsa (`openingCash: null`) uydurma 0 yerine dürüst `null` döner
    const unknownOpeningDual = computeDualCashRunway({
      months,
      anchorMonth: "2026-03-01",
      todayISO: "2026-03-10",
      openingCash: null,
      minCashFloor: 500_000,
      datedFlows: [],
    });
    expect(unknownOpeningDual.floorRunwayDays).toBeNull();
  });

  it("Test 4: Deterministik Başabaş (Breakeven) Goal-Seek Çözücüsü (4 kaldıraç + yetersiz kredi limitinde zorunlu dürüst mesaj + DB entegrasyonu)", async () => {
    // 4A. Saf çözücü: 4 kaldıraç + yetersiz kredi limiti zorunlu mesajı (`implementation.md:915`)
    const solved = solveBreakevenLevers({
      horizon: "13w",
      asOfDate: "2026-03-10",
      currency: "TRY",
      openingCash: 400_000,
      minCashFloor: 500_000, // Başlangıçta bile 100k taban altında; ayrıca 2026-03-25'te -300k çıkış var
      flows: [
        {
          dateISO: "2026-03-20",
          direction: "outflow",
          amount: 200_000,
          isDiscretionary: true,
          label: "Pazarlama ve Danışmanlık Gideri",
        },
        {
          dateISO: "2026-03-25",
          direction: "outflow",
          amount: 300_000,
          isDiscretionary: false,
          label: "Zorunlu Vergi / Bordro",
        },
      ],
      // En kötü bakiye: 400k - 200k - 300k = -100k (`2026-03-25`).
      // Min kasa tabanı 500k olduğu için gereken toplam başabaş tamamlaması = 500k - (-100k) = 600.000 TL!
      openReceivables: [
        { invoiceNo: "INV-FUT-01", dueDate: "2026-04-04", amount: 250_000 }, // 10 gün öne çekilirse 2026-03-25'e yetişir
        { invoiceNo: "INV-FUT-02", dueDate: "2026-04-14", amount: 400_000 }, // 20 gün öne çekilirse 2026-03-25'e yetişir (toplam 650k >= 600k!)
      ],
      availableCreditHeadroom: 350_000, // 600.000 TL açığa karşı yalnız 350.000 TL limit boşluğu var (ek 250.000 TL gerekli!)
      productionCostModel: {
        monthlyTotalCost: 900_000,
        effectiveMonthlyMinutes: 45_000, // baz: 20 TL/dk
        currentRateTlPerMin: 20,
      },
    });

    expect(solved.status).toBe("deficit_detected");
    expect(solved.worstDate).toBe("2026-03-25");
    expect(solved.worstProjectedCash).toBe(-100_000);
    expect(solved.requiredShortfall).toBe(600_000);

    // ① Tahsilat DSO Hızlandırma: 20 gün öne çekildiğinde 250k + 400k = 650k >= 600k
    expect(solved.levers.collectionDsoAcceleration.feasible).toBe(true);
    expect(solved.levers.collectionDsoAcceleration.requiredDaysAcceleration).toBe(20);
    expect(solved.levers.collectionDsoAcceleration.acceleratedInflowAmount).toBe(650_000);

    // ② İhtiyari Gider Kesintisi: toplam ihtiyari havuz 200k < 600k => %100 kesilse bile 400k açık kalır
    expect(solved.levers.discretionaryExpenseCut.feasible).toBe(false);
    expect(solved.levers.discretionaryExpenseCut.requiredCutPct).toBe(100);
    expect(solved.levers.discretionaryExpenseCut.unfundedGapAfterFullCut).toBe(400_000);

    // ③ Rotatif Kredi Çekimi: 350k < 600k => zorunlu dürüst mesaj!
    expect(solved.levers.revolvingCreditDrawdown.feasible).toBe(false);
    expect(solved.levers.revolvingCreditDrawdown.additionalFinancingNeeded).toBe(250_000);
    expect(solved.levers.revolvingCreditDrawdown.summary).toBe(
      "Mevcut kredi limiti açığı tek başına kapatmaya yetmiyor; ek 250.000,00 TL finansman veya gider ertelemesi gerekli",
    );

    // ④ Üretim Dakika Başı Başabaş Maliyet: baz 20 TL/dk + (600.000 / 45.000 dk = 13.3333 TL/dk) = 33.3333 TL/dk
    expect(solved.levers.productionFloorRate.baseBreakevenTlPerMin).toBe(20);
    expect(solved.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin).toBe(33.3333);
    expect(solved.levers.productionFloorRate.requiredRateIncreaseTlPerMin).toBe(13.3333);

    // Üretim efektif dakika = 0 ise sıfıra bölünme koruması
    const zeroMins = solveBreakevenLevers({
      horizon: "14d",
      asOfDate: "2026-03-10",
      openingCash: 100_000,
      minCashFloor: 200_000,
      flows: [],
      openReceivables: [],
      availableCreditHeadroom: 500_000,
      productionCostModel: {
        monthlyTotalCost: 500_000,
        effectiveMonthlyMinutes: 0,
      },
    });
    expect(zeroMins.levers.productionFloorRate.baseBreakevenTlPerMin).toBeNull();
    expect(zeroMins.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin).toBeNull();

    // 4B. Veritabanı entegrasyonu (`loadAndSolveBreakevenLevers`)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `TRUNCATE TABLE
           public.cash_accounts,
           public.treasury_policies,
           public.facility_movements,
           public.credit_facilities,
           public.cost_models,
           public.invoices,
           public.payment_instances,
           public.payments,
           public.parties
         RESTART IDENTITY CASCADE`,
      );

      await client.query(
        `INSERT INTO public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         VALUES ('F2 GoalSeek Kasa', 'bank_account', 'TRY', 300000.00, true)`,
      );
      await client.query(
        `INSERT INTO public.treasury_policies (code, description, policy_kind, currency, threshold_amount, is_active)
         VALUES ('min_cash_try_f2', 'F2 Min Kasa Tabanı', 'min_cash', 'TRY', 200000.00, true)`,
      );
      const facRes = await client.query<{ id: string }>(
        `INSERT INTO public.credit_facilities (name, facility_type, currency, limit_amount, status)
         VALUES ('F2 GoalSeek Rotatif', 'revolving', 'TRY', 500000.00, 'active')
         RETURNING id`,
      );
      await client.query(
        `INSERT INTO public.facility_movements (facility_id, movement_type, movement_date, amount, currency)
         VALUES ($1, 'drawdown', '2026-02-01', 400000.00, 'TRY')`,
        [facRes.rows[0].id],
      );
      await client.query(
        `INSERT INTO public.cost_models (model_name, scenario_type, total_fixed_cost, effective_monthly_minutes, break_even_tl_per_min)
         VALUES ('F2 Üretim Modeli', 'normal', 1000000.00, 40000, 25.0000)`,
      );

      const pRes = await client.query<{ id: string }>(
        `INSERT INTO public.parties (name, normalized_name, party_type, is_active)
         VALUES ('GoalSeek Müşteri A.Ş.', 'goalseek musteri a.s.', 'customer', true),
                ('GoalSeek Tedarik Ltd.', 'goalseek tedarik ltd.', 'vendor', true)
         RETURNING id`,
      );
      const custId = pRes.rows[0].id;
      const vendId = pRes.rows[1].id;

      // 14 günlük ufuk içinde (`2026-03-15`) 250.000 TL çıkış => kasa 300k - 250k = 50k (< 200k min_cash => 150.000 TL açık!)
      const payRes = await client.query<{ id: string }>(
        `INSERT INTO public.payments (name, provider_party_id, recurrence_type, due_day, priority, status, default_amount, currency)
         VALUES ('F2 Zorunlu Ödeme', $1, 'monthly', 15, 'high', 'active', 250000.00, 'TRY')
         RETURNING id`,
        [vendId],
      );
      await client.query(
        `INSERT INTO public.payment_instances (payment_id, instance_month, due_date, amount, currency, status, direction)
         VALUES ($1, '2026-03-01', '2026-03-15', 250000.00, 'TRY', 'planned', 'outflow')`,
        [payRes.rows[0].id],
      );

      // Ufuk sonrasında (`2026-03-25`) 200.000 TL açık satış faturası (10 gün hızlandırılırsa 2026-03-15'e yetişir!)
      await client.query(
        `INSERT INTO public.invoices (
           invoice_no, direction, party_id, issue_date, due_date,
           net_amount, tax_amount, gross_amount, allocated_amount, currency, status
         )
         VALUES ('F2-GS-INV-01', 'sales', $1, '2026-02-25', '2026-03-25', 166666.67, 33333.33, 200000.00, 0.00, 'TRY', 'open')`,
        [custId],
      );

      const dbSolved = await loadAndSolveBreakevenLevers(client, {
        horizon: "14d",
        asOfDate: "2026-03-10",
        currency: "TRY",
      });

      expect(dbSolved.status).toBe("deficit_detected");
      expect(dbSolved.requiredShortfall).toBe(150_000);
      expect(dbSolved.levers.collectionDsoAcceleration.feasible).toBe(true);
      expect(dbSolved.levers.collectionDsoAcceleration.requiredDaysAcceleration).toBe(10);
      expect(dbSolved.levers.revolvingCreditDrawdown.feasible).toBe(false);
      expect(dbSolved.levers.revolvingCreditDrawdown.additionalFinancingNeeded).toBe(50_000);
      expect(dbSolved.levers.revolvingCreditDrawdown.summary).toContain(
        "Mevcut kredi limiti açığı tek başına kapatmaya yetmiyor; ek 50.000,00 TL finansman veya gider ertelemesi gerekli",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, 60_000);
});
