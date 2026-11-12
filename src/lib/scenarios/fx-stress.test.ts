import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import type { CovenantAndDscrRadar } from "@/lib/financing/covenants-and-dscr";
import {
  computeFxStressAndNaturalHedge,
  formatNativeFx,
  formatTcmbRate,
  FX_SHOCK_PCTS,
  loadFxStressOverlay,
} from "./fx-stress";

describe("SA-8 — TCMB Kur Şoku, Doğal Hedge ve Kovenant Kırılma Stres Motoru", () => {
  it("1) Orijinal döviz birimleri (USD, EUR, GBP) asla kendi aralarında toplanmaz; yalnız resmi TCMB kuruyla TL stres katmanında konsolide edilir", () => {
    const res = computeFxStressAndNaturalHedge({
      asOfDate: "2026-08-21",
      availableNowTry: "2500000.00",
      exposures: [
        {
          currency: "USD",
          cashBalance: "40000.00",
          openReceivables: "80000.00",
          portfolioCustomerChecks: "10000.00", // fxAssets = 130,000 USD
          openPayables: "50000.00",
          loanPrincipalAndInterestRemaining: "50000.00", // fxLiabilities = 100,000 USD -> +30,000 USD long
          tcmbBaseRate: "35.0000",
          tcmbRateDate: "2026-08-21",
        },
        {
          currency: "EUR",
          cashBalance: "10000.00",
          openReceivables: "15000.00", // fxAssets = 25,000 EUR
          openPayables: "45000.00",
          issuedChecks: "30000.00", // fxLiabilities = 75,000 EUR -> -50,000 EUR short
          tcmbBaseRate: "38.5000",
          tcmbRateDate: "2026-08-21",
        },
        {
          currency: "TRY",
          // TRY girdisi yabancı para sepetine asla sızmamalıdır
          cashBalance: "999999.00",
          openReceivables: "500000.00",
          tcmbBaseRate: "1.0000",
        },
      ],
    });

    expect(res.status).toBe("ok");
    expect(res.currencies.map((c) => c.currency)).toEqual(["USD", "EUR"]);

    // Çapraz para birimlerini orijinal birimde toplayan hiçbir uydurma alan yoktur
    expect("totalNativePosition" in (res as unknown as Record<string, unknown>)).toBe(false);
    expect("totalNativeAssets" in (res as unknown as Record<string, unknown>)).toBe(false);

    const usd = res.currencies.find((c) => c.currency === "USD")!;
    const eur = res.currencies.find((c) => c.currency === "EUR")!;

    // USD sepeti kendi orijinal biriminde korunur: +30,000 USD, doğal hedge = 1.30 (hedgeli)
    expect(usd.fxAssets).toBe(130_000);
    expect(usd.fxLiabilities).toBe(100_000);
    expect(usd.netNativePosition).toBe(30_000);
    expect(usd.naturalHedgeRatio).toBe(1.3);
    expect(usd.isNaturallyHedged).toBe(true);
    expect(usd.hedgeStatus).toBe("naturally_hedged");
    expect(usd.baseNetValueTry).toBe(1_050_000); // 30,000 * 35.00

    // EUR sepeti kendi orijinal biriminde korunur: -50,000 EUR, doğal hedge = 0.3333 (kısmi hedge)
    expect(eur.fxAssets).toBe(25_000);
    expect(eur.fxLiabilities).toBe(75_000);
    expect(eur.netNativePosition).toBe(-50_000);
    expect(eur.naturalHedgeRatio).toBe(0.3333);
    expect(eur.isNaturallyHedged).toBe(false);
    expect(eur.hedgeStatus).toBe("partial_hedge");
    expect(eur.baseNetValueTry).toBe(-1_925_000); // -50,000 * 38.50

    // Konsolide baz TL: +1,050,000 - 1,925,000 = -875,000.00 TL
    expect(res.consolidatedNetOpenTry).toBe(-875_000);

    // +%20 şokta konsolide kur farkı: -875,000 * 0.20 = -175,000.00 TL
    const band20 = res.shockBands.find((b) => b.shockPct === 20)!;
    expect(band20.netWorthShockDeltaTry).toBe(-175_000);
    expect(band20.postShockLiquidityBufferTry).toBe(2_325_000); // 2,500,000 - 175,000

    expect(formatNativeFx(usd.netNativePosition, "USD")).toBe("30.000,00 USD");
    expect(formatNativeFx(eur.netNativePosition, "EUR")).toBe("-50.000,00 EUR");
    expect(formatTcmbRate(38.5)).toBe("38,5000 TL");
  });

  it("2) Aktif EUR kredisinde resmi TCMB kuru eksikse ASLA 1.0 veya 0 ikame edilmez; missing_fx_rates ve null konsolide şok döner", () => {
    const res = computeFxStressAndNaturalHedge({
      asOfDate: "2026-08-21",
      availableNowTry: "1500000.00",
      exposures: [
        {
          currency: "USD",
          cashBalance: "20000.00",
          openPayables: "10000.00",
          tcmbBaseRate: "35.0000",
        },
        {
          currency: "EUR",
          cashBalance: "0.00",
          loanPrincipalAndInterestRemaining: "80000.00",
          next12mDebtServiceNative: "40000.00",
          tcmbBaseRate: null, // Resmi TCMB EUR kuru eksik!
        },
      ],
      dscrBaseline: {
        tryOperationalInflows: "6000000.00",
        tryOperationalOutflowsBeforeDebtService: "2000000.00",
        covenants: [
          {
            covenantId: "cov-dscr-1",
            subjectName: "EUR Yatırım Kredisi",
            covenantType: "min_dscr",
            comparison: ">=",
            thresholdValue: 1.25,
          },
        ],
      },
    });

    expect(res.status).toBe("missing_fx_rates");
    expect(res.missingFxCurrencies).toEqual(["EUR"]);
    expect(res.consolidatedNetOpenTry).toBeNull();
    expect(res.baseForward12mDscrWithSpotFx).toBeNull();

    const eur = res.currencies.find((c) => c.currency === "EUR")!;
    expect(eur.hasMissingRate).toBe(true);
    expect(eur.tcmbBaseRate).toBeNull();
    expect(eur.baseNetValueTry).toBeNull();
    expect(eur.netNativePosition).toBe(-80_000); // Orijinal birim dürüstçe görünür!
    expect(formatTcmbRate(eur.tcmbBaseRate)).toBe("TCMB kuru eksik");

    for (const band of res.shockBands) {
      expect(band.consolidatedShockDeltaTry).toBeNull();
      expect(band.netWorthShockDeltaTry).toBeNull();
      expect(band.postShockLiquidityBufferTry).toBeNull();
      expect(band.postShockForward12mDscr).toBeNull();
      expect(band.covenantBreachTriggered).toBe(false);
    }
  });

  it("3) FIN-03: Yabancı para kasa açılış bakiyesi bilinmiyorsa (null) ASLA 0'a zorlanmaz; hasUnknownCashOpening = true yayılır", () => {
    const res = computeFxStressAndNaturalHedge({
      asOfDate: "2026-08-21",
      availableNowTry: "900000.00",
      exposures: [
        {
          currency: "USD",
          cashBalance: null, // FIN-03: opening_balance IS NULL
          openReceivables: "25000.00",
          openPayables: "60000.00",
          tcmbBaseRate: "35.0000",
        },
      ],
    });

    expect(res.status).toBe("unknown_cash_opening");
    expect(res.hasUnknownCashOpening).toBe(true);
    expect(res.hasUnknownFxCashOpening).toBe(true);
    expect(res.hasUnknownTryCashOpening).toBe(false);
    expect(res.consolidatedNetOpenTry).toBeNull();

    const usd = res.currencies[0]!;
    expect(usd.hasUnknownCashOpening).toBe(true);
    expect(usd.cashBalance).toBeNull();
    expect(usd.fxAssets).toBeNull();
    expect(usd.fxInflowsAndCash).toBeNull();
    expect(usd.netNativePosition).toBeNull();
    expect(usd.naturalHedgeRatio).toBeNull();
    expect(usd.hedgeStatus).toBe("unknown_cash_opening");

    for (const band of res.shockBands) {
      expect(band.netWorthShockDeltaTry).toBeNull();
      expect(band.consolidatedShockDeltaTry).toBeNull();
      expect(band.postShockLiquidityBufferTry).toBeNull();
    }
  });

  it("4) Kısa -100.000 USD pozisyonu 35,00 TL/USD kurda tam -350k / -700k / -1.050k TL şok üretir ve şoklu DSCR min_dscr altına indiğinde kovenant ihlalini tetikler", () => {
    // CFADS = 8,000,000 - 3,000,000 = 5,000,000 TL
    // YP 12 ay borç servisi = 100,000 USD @ 35.00 = 3,500,000 TL (Spot DSCR = 5,000,000 / 3,500,000 = 1.4286x >= 1.25x -> compliant)
    // +%10 şok: borç servisi = 3,850,000 TL -> DSCR = 1.2987x >= 1.25x (warning, ihlal YOK)
    // +%20 şok: borç servisi = 4,200,000 TL -> DSCR = 1.1905x < 1.25x (BREACHED -> covenantBreachTriggered = true!)
    // +%30 şok: borç servisi = 4,550,000 TL -> DSCR = 1.0989x < 1.25x (BREACHED -> covenantBreachTriggered = true!)
    const res = computeFxStressAndNaturalHedge({
      asOfDate: "2026-08-21",
      availableNowTry: "1200000.00",
      exposures: [
        {
          currency: "USD",
          cashBalance: "0.00",
          openReceivables: "0.00",
          portfolioCustomerChecks: "0.00",
          openPayables: "0.00",
          loanPrincipalAndInterestRemaining: "100000.00",
          next12mDebtServiceNative: "100000.00",
          tcmbBaseRate: "35.00",
          tcmbRateDate: "2026-08-21",
        },
      ],
      dscrBaseline: {
        tryOperationalInflows: "8000000.00",
        tryOperationalOutflowsBeforeDebtService: "3000000.00",
        tryInstallments: [],
        tryLoanPrincipalRemaining: "0.00",
        tryFacilityDrawn: "0.00",
        managementEbitdaTry: "1500000.00",
        covenants: [
          {
            covenantId: "cov-min-dscr",
            subjectName: "USD İşletme Kredisi",
            covenantType: "min_dscr",
            comparison: ">=",
            thresholdValue: 1.25,
          },
          {
            covenantId: "cov-max-lev",
            subjectName: "USD İşletme Kredisi",
            covenantType: "max_net_debt_to_ebitda",
            comparison: "<=",
            thresholdValue: 1.9, // Spot Net Borç = 3.5M - 1.2M = 2.3M / 1.5M = 1.5333x; +%20 = (4.2M - 1.2M)/1.5M = 2.0000x > 1.9x -> BREACHED!
          },
        ],
      },
    });

    expect(res.shockBandsPct).toEqual(FX_SHOCK_PCTS);
    expect(res.status).toBe("ok");
    expect(res.consolidatedNetOpenTry).toBe(-3_500_000);
    expect(res.baseForward12mDscrWithSpotFx).toBe(1.4286);

    const [band10, band20, band30] = res.shockBands;

    // +%10 Şok Bandı
    expect(band10.shockPct).toBe(10);
    expect(band10.netWorthShockDeltaTry).toBe(-350_000.0);
    expect(band10.consolidatedShockDeltaTry).toBe(-350_000.0);
    expect(band10.postShockLiquidityBufferTry).toBe(850_000.0); // 1,200,000 - 350,000
    expect(band10.shockedFxNext12mDebtServiceTry).toBe(3_850_000.0);
    expect(band10.postShockForward12mDscr).toBe(1.2987);
    expect(band10.covenantBreachTriggered).toBe(false);

    // +%20 Şok Bandı — hem min_dscr (1.1905 < 1.25) hem max_net_debt_to_ebitda (2.0000 > 1.90) kırılır!
    expect(band20.shockPct).toBe(20);
    expect(band20.netWorthShockDeltaTry).toBe(-700_000.0);
    expect(band20.consolidatedShockDeltaTry).toBe(-700_000.0);
    expect(band20.postShockLiquidityBufferTry).toBe(500_000.0); // 1,200,000 - 700,000
    expect(band20.shockedFxNext12mDebtServiceTry).toBe(4_200_000.0);
    expect(band20.postShockForward12mDscr).toBe(1.1905);
    expect(band20.postShockNetDebtToEbitda).toBe(2);
    expect(band20.covenantBreachTriggered).toBe(true);
    expect(band20.newlyBreachedCovenantCount).toBe(2);

    // +%30 Şok Bandı
    expect(band30.shockPct).toBe(30);
    expect(band30.netWorthShockDeltaTry).toBe(-1_050_000.0);
    expect(band30.consolidatedShockDeltaTry).toBe(-1_050_000.0);
    expect(band30.postShockLiquidityBufferTry).toBe(150_000.0); // 1,200,000 - 1,050,000
    expect(band30.shockedFxNext12mDebtServiceTry).toBe(4_550_000.0);
    expect(band30.postShockForward12mDscr).toBe(1.0989);
    expect(band30.covenantBreachTriggered).toBe(true);
  });

  it("5) loadFxStressOverlay: sahte DB bağlantısı açmadan (in-memory mock Pool) tablo sorgularını, TCMB kurunu ve DSCR radarını dürüstçe birleştirir", async () => {
    const mockRadar: CovenantAndDscrRadar = {
      asOfDate: "2026-08-21",
      currency: "TRY",
      availableCash: 1_000_000,
      totalLoanPrincipalRemaining: 0,
      totalFacilityDrawn: 0,
      netDebt: -1_000_000,
      managementEbitda: 2_000_000,
      netDebtToEbitda: -0.5,
      dscrWindows: {
        trailing3m: {
          horizon: "trailing_3m",
          label: "Son 3 Ay",
          periodStart: "2026-05-23",
          periodEnd: "2026-08-21",
          currency: "TRY",
          operationalInflows: 1_500_000,
          operationalOutflowsBeforeDebtService: 800_000,
          cfads: 700_000,
          principalComponent: 0,
          interestComponent: 0,
          taxComponentBsmvKkdf: 0,
          totalDebtService: 0,
          dscr: null,
          confidence: "full",
          unknownComponentCount: 0,
        },
        forward3m: {
          horizon: "forward_3m",
          label: "Gelecek 3 Ay",
          periodStart: "2026-08-21",
          periodEnd: "2026-11-19",
          currency: "TRY",
          operationalInflows: 1_800_000,
          operationalOutflowsBeforeDebtService: 900_000,
          cfads: 900_000,
          principalComponent: 0,
          interestComponent: 0,
          taxComponentBsmvKkdf: 0,
          totalDebtService: 0,
          dscr: null,
          confidence: "full",
          unknownComponentCount: 0,
        },
        forward12m: {
          horizon: "forward_12m",
          label: "Gelecek 12 Ay",
          periodStart: "2026-08-21",
          periodEnd: "2027-08-21",
          currency: "TRY",
          operationalInflows: 7_500_000,
          operationalOutflowsBeforeDebtService: 3_000_000,
          cfads: 4_500_000,
          principalComponent: 0,
          interestComponent: 0,
          taxComponentBsmvKkdf: 0,
          totalDebtService: 0,
          dscr: null,
          confidence: "full",
          unknownComponentCount: 0,
        },
      },
      covenants: [
        {
          covenantId: "cov-1",
          subjectName: "USD Eximbank Kredisi",
          covenantType: "min_dscr",
          description: "Minimum DSCR 1.20x",
          comparison: ">=",
          thresholdValue: 1.2,
          measuredValue: null,
          state: "not_tested",
          headroomPct: null,
          explanation: "Ölçüm yok",
          metricSource: "test",
        },
      ],
      breachedCount: 0,
      warningCount: 0,
      compliantCount: 0,
    };

    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("from public.bank_cash_position")) {
          return {
            rowCount: 2,
            rows: [
              {
                currency: "TRY",
                account_count: 1,
                unknown_opening_count: 0,
                available_now: "1000000.00",
              },
              {
                currency: "USD",
                account_count: 1,
                unknown_opening_count: 0,
                available_now: "15000.00",
              },
            ],
          };
        }
        if (sql.includes("from public.invoices")) {
          return {
            rowCount: 2,
            rows: [
              { currency: "USD", direction: "sales", remaining_amount: "20000.00" },
              { currency: "USD", direction: "purchase", remaining_amount: "35000.00" },
            ],
          };
        }
        if (sql.includes("from public.payment_instances")) {
          return {
            rowCount: 1,
            rows: [{ currency: "USD", direction: "outflow", remaining_amount: "5000.00" }],
          };
        }
        if (sql.includes("from public.checks")) {
          return {
            rowCount: 2,
            rows: [
              { currency: "USD", direction: "inflow", total_amount: "5000.00" },
              { currency: "USD", direction: "outflow", total_amount: "10000.00" },
            ],
          };
        }
        if (sql.includes("from public.loan_installments")) {
          return {
            rowCount: 1,
            rows: [
              {
                currency: "USD",
                total_remaining: "90000.00",
                principal_remaining: "80000.00",
                next12m_service: "100000.00",
              },
            ],
          };
        }
        if (sql.includes("from public.credit_facility_utilization")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("from public.fx_latest_rates")) {
          return {
            rowCount: 1,
            rows: [
              {
                base_currency: "USD",
                quote_currency: "TRY",
                rate_date: "2026-08-21",
                rate: "35.0000",
                source: "tcmb",
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    } as unknown as Pool;

    const overlay = await loadFxStressOverlay(mockPool, {
      asOfDate: "2026-08-21",
      dscrRadar: mockRadar,
    });

    // USD Varlık = 15k (kasa) + 20k (satış faturası) + 5k (müşteri çeki) = 40,000 USD
    // USD Yükümlülük = (35k alış faturası + 5k ödeme) + 90k kredi + 10k keşide çek = 140,000 USD
    // Net = -100,000 USD @ 35.00 TL/USD
    expect(overlay.status).toBe("ok");
    expect(overlay.currencies).toHaveLength(1);
    expect(overlay.currencies[0]!.fxAssets).toBe(40_000);
    expect(overlay.currencies[0]!.fxLiabilities).toBe(140_000);
    expect(overlay.currencies[0]!.netNativePosition).toBe(-100_000);
    expect(overlay.consolidatedNetOpenTry).toBe(-3_500_000);

    // CFADS = 4,500,000 TL; Spot borç servisi = 3,500,000 TL -> DSCR = 1.2857x >= 1.20x (compliant)
    // +%10 borç servisi = 3,850,000 TL -> DSCR = 1.1688x < 1.20x (breached -> covenantBreachTriggered = true!)
    expect(overlay.baseForward12mDscrWithSpotFx).toBe(1.2857);
    expect(overlay.shockBands[0]!.netWorthShockDeltaTry).toBe(-350_000);
    expect(overlay.shockBands[0]!.postShockForward12mDscr).toBe(1.1688);
    expect(overlay.shockBands[0]!.covenantBreachTriggered).toBe(true);
  });

  it("6) Yabancı para açık pozisyon yoksa no_fx_exposure döner ve sahte eksik kur alarmı üretmez", () => {
    const res = computeFxStressAndNaturalHedge({
      asOfDate: "2026-08-21",
      availableNowTry: "500000.00",
      exposures: [
        {
          currency: "USD",
          cashBalance: "0.00",
          openReceivables: "0.00",
          openPayables: "0.00",
          tcmbBaseRate: null, // Pasif 0.00 bakiye için kur aranmaz
        },
      ],
    });

    expect(res.status).toBe("no_fx_exposure");
    expect(res.currencies).toEqual([]);
    expect(res.missingFxCurrencies).toEqual([]);
    expect(res.consolidatedNetOpenTry).toBe(0);
    expect(res.shockBands.map((b) => b.netWorthShockDeltaTry)).toEqual([0, 0, 0]);
  });
});
