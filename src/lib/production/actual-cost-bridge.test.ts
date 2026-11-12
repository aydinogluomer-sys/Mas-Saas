import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  computeActualCostBridge,
  fmtSignedPct,
  fmtSignedTlPerMin,
  fmtTlPerMin,
  loadActualCostBridge,
  type CostModelBridgeInput,
  type MonthlyLedger7xxRow,
  type PartBridgeInput,
} from "./actual-cost-bridge";

const BASE_NORMAL_MODEL: CostModelBridgeInput = {
  id: "cm-normal",
  name: "2026 Normal Atölye",
  scenario: "normal",
  monthlyCost: 261800,
  breakEven: 26.18,
  effectiveMinutes: 10000,
  akonFreze: 27.5,
  akonTorna: 31.0,
};

const BASE_OVERTIME_MODEL: CostModelBridgeInput = {
  id: "cm-overtime",
  name: "2026 Mesaili Atölye",
  scenario: "overtime",
  monthlyCost: 312000,
  breakEven: 24.96,
  effectiveMinutes: 12500,
  akonFreze: 27.5,
  akonTorna: 31.0,
};

describe("computeActualCostBridge — BLANK ≠ ZERO ve sınır kuralları", () => {
  it("0 posted 7xx ayı olduğunda insufficient_ledger_actuals döner; hiçbir actual TL/dk alanı 0 olmaz", () => {
    const res = computeActualCostBridge({
      monthlyLedger7xx: [],
      costModels: [BASE_NORMAL_MODEL, BASE_OVERTIME_MODEL],
    });

    expect(res.status).toBe("insufficient_ledger_actuals");
    expect(res.monthCount).toBe(0);
    expect(res.actualBreakEvenTlPerMin).toBeNull();
    expect(res.actualCashBreakEvenTlPerMin).toBeNull();
    expect(res.actualFullBreakEvenTlPerMin).toBeNull();
    expect(res.avgMonthlyOperating7xxExclDaTry).toBeNull();
    expect(res.avgMonthlyFull7xxInclDaTry).toBeNull();
    expect(res.avgMonthlyFinancing780Try).toBeNull();
    expect(res.rateDriftTlPerMin).toBeNull();
    expect(res.rateDriftPct).toBeNull();

    for (const m of res.models) {
      expect(m.modelStatus).toBe("insufficient_ledger_actuals");
      expect(m.actualCashBreakEvenTlPerMin).toBeNull();
      expect(m.actualFullBreakEvenTlPerMin).toBeNull();
      expect(m.actualBreakEvenTlPerMin).toBeNull();
      expect(m.financing780TlPerMin).toBeNull();
      expect(m.rateDriftTlPerMin).toBeNull();
      expect(m.rateDriftPct).toBeNull();
      expect(m.hasHiddenRateErosion).toBe(false);
    }

    expect(fmtTlPerMin(res.actualBreakEvenTlPerMin)).toBe("—");
    expect(fmtSignedTlPerMin(res.rateDriftTlPerMin)).toBe("—");
    expect(fmtSignedPct(res.rateDriftPct)).toBe("—");
  });

  it("postedEntryCount = 0 olan taslak/iptal ayları yok sayar ve 0,00 TL/dk üretmez", () => {
    const res = computeActualCostBridge({
      monthlyLedger7xx: [
        {
          periodMonth: "2026-03-01",
          production710_730Try: 0,
          opex760_770ExclDaTry: 0,
          depreciationDaTry: 0,
          financing780Try: 0,
          postedEntryCount: 0,
        },
      ],
      costModels: [BASE_NORMAL_MODEL],
    });

    expect(res.status).toBe("insufficient_ledger_actuals");
    expect(res.actualBreakEvenTlPerMin).toBeNull();
  });

  it("yalnız 780 finansman gideri olup 710–770 faaliyet gideri 0 olan defterde 0,00 TL/dk başabaş uydurmaz", () => {
    const res = computeActualCostBridge({
      monthlyLedger7xx: [
        {
          periodMonth: "2026-03-01",
          production710_730Try: 0,
          opex760_770ExclDaTry: 0,
          depreciationDaTry: 0,
          financing780Try: 14500,
          postedEntryCount: 2,
        },
      ],
      costModels: [BASE_NORMAL_MODEL],
    });

    expect(res.status).toBe("insufficient_ledger_actuals");
    expect(res.actualBreakEvenTlPerMin).toBeNull();
    expect(res.actualFullBreakEvenTlPerMin).toBeNull();
    expect(res.avgMonthlyFinancing780Try).toBe(14500);
  });

  it("effectiveMinutes null, 0 veya negatif olduğunda NaN/Infinity üretmez; unknown_effective_minutes döner", () => {
    const ledger: MonthlyLedger7xxRow[] = [
      {
        periodMonth: "2026-03-01",
        production710_730Try: 190000,
        opex760_770ExclDaTry: 72000,
        depreciationDaTry: 32000,
        financing780Try: 15000,
        postedEntryCount: 12,
      },
    ];

    const res = computeActualCostBridge({
      monthlyLedger7xx: ledger,
      costModels: [
        { ...BASE_NORMAL_MODEL, id: "m-null", effectiveMinutes: null },
        { ...BASE_NORMAL_MODEL, id: "m-zero", effectiveMinutes: 0 },
        { ...BASE_NORMAL_MODEL, id: "m-neg", effectiveMinutes: -500 },
      ],
    });

    expect(res.status).toBe("unknown_effective_minutes");
    expect(res.avgMonthlyOperating7xxExclDaTry).toBe(262000);
    expect(res.avgMonthlyFull7xxInclDaTry).toBe(294000);
    expect(res.actualBreakEvenTlPerMin).toBeNull();
    expect(res.actualCashBreakEvenTlPerMin).toBeNull();
    expect(res.actualFullBreakEvenTlPerMin).toBeNull();

    for (const m of res.models) {
      expect(m.modelStatus).toBe("unknown_effective_minutes");
      expect(m.actualCashBreakEvenTlPerMin).toBeNull();
      expect(m.actualFullBreakEvenTlPerMin).toBeNull();
      expect(m.rateDriftTlPerMin).toBeNull();
      expect(m.rateDriftPct).toBeNull();
    }
  });

  it("bookBreakEven 0 veya null olduğunda rateDriftPct null kalır (sıfıra bölme hatası vermez)", () => {
    const ledger: MonthlyLedger7xxRow[] = [
      {
        periodMonth: "2026-03-01",
        production710_730Try: 200000,
        opex760_770ExclDaTry: 62000,
        depreciationDaTry: 32000,
        financing780Try: 10000,
        postedEntryCount: 8,
      },
    ];

    const res = computeActualCostBridge({
      monthlyLedger7xx: ledger,
      costModels: [
        { ...BASE_NORMAL_MODEL, id: "m-zero-be", breakEven: 0 },
        { ...BASE_NORMAL_MODEL, id: "m-null-be", breakEven: null },
      ],
    });

    expect(res.status).toBe("ready");
    expect(res.models[0].actualFullBreakEvenTlPerMin).toBe(29.4);
    expect(res.models[0].rateDriftTlPerMin).toBe(29.4);
    expect(res.models[0].rateDriftPct).toBeNull();

    expect(res.models[1].actualFullBreakEvenTlPerMin).toBe(29.4);
    expect(res.models[1].rateDriftTlPerMin).toBeNull();
    expect(res.models[1].rateDriftPct).toBeNull();
  });
});

describe("computeActualCostBridge — Big.js kuruş hassasiyeti ve gizli marj erimesi", () => {
  const THREE_MONTH_LEDGER: MonthlyLedger7xxRow[] = [
    // Eski 4. ay (lookbackMonths=3 penceresinin dışında kalmalı)
    {
      periodMonth: "2025-12-01",
      production710_730Try: 500000,
      opex760_770ExclDaTry: 200000,
      depreciationDaTry: 90000,
      financing780Try: 50000,
      postedEntryCount: 20,
    },
    {
      periodMonth: "2026-01-01",
      production710_730Try: 185420.1,
      opex760_770ExclDaTry: 74580.2,
      depreciationDaTry: 32000.0,
      financing780Try: 18500.4,
      postedEntryCount: 14,
    },
    {
      periodMonth: "2026-02-01",
      production710_730Try: 192110.2,
      opex760_770ExclDaTry: 69890.1,
      depreciationDaTry: 32000.0,
      financing780Try: 17950.1,
      postedEntryCount: 16,
    },
    {
      periodMonth: "2026-03-01",
      production710_730Try: 198469.7,
      opex760_770ExclDaTry: 65529.7,
      depreciationDaTry: 32000.0,
      financing780Try: 19049.5,
      postedEntryCount: 15,
    },
  ];

  it("son 3 posted 7xx ayını cogs + opex + da_addback olarak Big.js ile tam hesaplar; 780'i ayrı tutar", () => {
    // 3-ay toplamları:
    //   production (710-730): 185420.10 + 192110.20 + 198469.70 = 576000.00 -> ort. 192000.00
    //   opex excl DA (760-770): 74580.20 + 69890.10 + 65529.70 = 210000.00 -> ort. 70000.00
    //   operating excl DA: 262000.00 -> 10000 dk için 26.20 TL/dk
    //   D&A (770.99): 32000.00 -> tam 7xx = 294000.00 -> 10000 dk için 29.40 TL/dk
    //   financing (780): 18500.40 + 17950.10 + 19049.50 = 55500.00 -> ort. 18500.00 (1.85 TL/dk ayrı)
    const res = computeActualCostBridge({
      monthlyLedger7xx: THREE_MONTH_LEDGER,
      costModels: [BASE_NORMAL_MODEL, BASE_OVERTIME_MODEL],
      lookbackMonths: 3,
    });

    expect(res.status).toBe("ready");
    expect(res.monthCount).toBe(3);
    expect(res.includedMonths.map((m) => m.periodMonth)).toEqual([
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
    expect(res.totalPosted7xxEntries).toBe(45);

    expect(res.avgMonthlyProduction710_730Try).toBe(192000);
    expect(res.avgMonthlyOpex760_770ExclDaTry).toBe(70000);
    expect(res.avgMonthlyOperating7xxExclDaTry).toBe(262000);
    expect(res.avgMonthlyDepreciationDaTry).toBe(32000);
    expect(res.avgMonthlyFull7xxInclDaTry).toBe(294000);
    expect(res.avgMonthlyFinancing780Try).toBe(18500);

    expect(res.bookBreakEvenTlPerMin).toBe(26.18);
    expect(res.actualCashBreakEvenTlPerMin).toBe(26.2);
    expect(res.actualFullBreakEvenTlPerMin).toBe(29.4);
    expect(res.actualBreakEvenTlPerMin).toBe(29.4);
    expect(res.rateDriftTlPerMin).toBe(3.22); // 29.40 - 26.18 = 3.22 (sıfır float kayması)
    expect(res.rateDriftPct).toBe(12.3); // (3.22 / 26.18) * 100 = 12.2994... -> 12.30

    const normal = res.models.find((m) => m.scenario === "normal")!;
    expect(normal.financing780TlPerMin).toBe(1.85);
    expect(normal.cashRateDriftTlPerMin).toBe(0.02);

    const overtime = res.models.find((m) => m.scenario === "overtime")!;
    // 262000 / 12500 = 20.96; 294000 / 12500 = 23.52
    expect(overtime.actualCashBreakEvenTlPerMin).toBe(20.96);
    expect(overtime.actualFullBreakEvenTlPerMin).toBe(23.52);
    expect(overtime.rateDriftTlPerMin).toBe(-1.44); // 23.52 - 24.96
  });

  it("Akon/parça fiyatı (27,50 TL/dk) kitabi başabaşı (26,18 TL/dk) geçip fiili 7xx başabaşı (29,40 TL/dk) altında kaldığında hiddenMarginErosion yakalar", () => {
    const parts: PartBridgeInput[] = [
      {
        id: "p-eroding-1",
        code: "MT-101",
        name: "Hidrolik Gövde Burcu",
        quantity: 10,
        tornaMinutesPerUnit: 6,
        frezeMinutesPerUnit: 4, // toplam 100 dk
        revenue: 2750, // 27.50 TL/dk: kitabi +132 TL kâr, fiili -190 TL zarar
      },
      {
        id: "p-eroding-2",
        code: "MT-102",
        name: "Flanş Adaptörü",
        quantity: 20,
        tornaMinutesPerUnit: 10,
        frezeMinutesPerUnit: null, // toplam 200 dk
        revenue: 5600, // 28.00 TL/dk: kitabi +364 TL kâr, fiili -280 TL zarar
      },
      {
        id: "p-healthy",
        code: "MT-200",
        name: "Yüksek Marjlı Mil",
        quantity: 5,
        tornaMinutesPerUnit: 10,
        frezeMinutesPerUnit: 10, // toplam 100 dk
        revenue: 3400, // 34.00 TL/dk: hem kitabi hem fiili kârlı
      },
      {
        id: "p-already-loss",
        code: "MT-300",
        name: "Eski Tarife Pul",
        quantity: 10,
        tornaMinutesPerUnit: 5,
        frezeMinutesPerUnit: null, // toplam 50 dk
        revenue: 1200, // 24.00 TL/dk: kitabi de zararda (-109 TL), gizli değil açık zarar
      },
      {
        id: "p-missing-time",
        code: "MT-404",
        name: "Süresiz Parça",
        quantity: 10,
        tornaMinutesPerUnit: null,
        frezeMinutesPerUnit: null,
        revenue: 1500,
      },
    ];

    const res = computeActualCostBridge({
      monthlyLedger7xx: THREE_MONTH_LEDGER,
      costModels: [BASE_NORMAL_MODEL],
      parts,
    });

    const normal = res.models[0];
    // Akon Freze = 27.50 TL/dk vs Kitabi 26.18 (+1.32) vs Fiili Tam 29.40 (-1.90) => GİZLİ ERİME!
    expect(normal.akonFrezeComparison.priceTlPerMin).toBe(27.5);
    expect(normal.akonFrezeComparison.bookMarginTlPerMin).toBe(1.32); // IEEE-754'te 1.3200000000000003 olurdu!
    expect(normal.akonFrezeComparison.bookLoss).toBe(false);
    expect(normal.akonFrezeComparison.actualFullMarginTlPerMin).toBe(-1.9); // IEEE-754'te -1.8999999999999986 olurdu!
    expect(normal.akonFrezeComparison.actualFullLoss).toBe(true);
    expect(normal.akonFrezeComparison.hiddenMarginErosion).toBe(true);

    // Akon Torna = 31.00 TL/dk > 29.40 TL/dk => hâlâ pozitif (+1.60 TL/dk)
    expect(normal.akonTornaComparison.bookMarginTlPerMin).toBe(4.82);
    expect(normal.akonTornaComparison.actualFullMarginTlPerMin).toBe(1.6);
    expect(normal.akonTornaComparison.hiddenMarginErosion).toBe(false);
    expect(normal.hasHiddenRateErosion).toBe(true);
    expect(res.hiddenErosionRateCount).toBe(1);

    // Parça erimesi özeti
    expect(res.evaluatedPartCount).toBe(4);
    expect(res.unmeasurablePartCount).toBe(1);
    expect(res.bookProfitablePartCount).toBe(3); // MT-101, MT-102, MT-200
    expect(res.actualLossPartCount).toBe(3); // MT-101, MT-102, MT-300
    expect(res.hiddenErosionPartCount).toBe(2); // Yalnız MT-102 (-280) ve MT-101 (-190) kârdan zarara döndü!
    expect(res.hiddenErosionTotalLossTry).toBe(-470);

    // En derin fiili zarardan başlayarak sıralanmalı
    expect(res.hiddenErosionParts.map((p) => p.partCode)).toEqual(["MT-102", "MT-101"]);
    expect(res.hiddenErosionParts[0]).toMatchObject({
      partCode: "MT-102",
      impliedPriceTlPerMin: 28,
      bookCostTry: 5236,
      bookMarginTry: 364,
      actualFullCostTry: 5880,
      actualFullMarginTry: -280,
      marginDeltaTry: -644,
      hiddenMarginErosion: true,
    });
    expect(res.hiddenErosionParts[1]).toMatchObject({
      partCode: "MT-101",
      impliedPriceTlPerMin: 27.5,
      bookCostTry: 2618,
      bookMarginTry: 132,
      actualFullCostTry: 2940,
      actualFullMarginTry: -190,
      marginDeltaTry: -322,
      hiddenMarginErosion: true,
    });
  });

  it("3'e tam bölünmeyen tekrarlı ondalık 7xx tutarlarında PostgreSQL half-up yuvarlamasıyla birebir uyuşur", () => {
    // Toplam full 7xx = 100000.00 / 3 ay = 33333.333333... -> 33333.33 TL/ay
    // 1000 dk için (100000 / 3) / 1000 = 33.333333... -> 33.33 TL/dk
    const res = computeActualCostBridge({
      monthlyLedger7xx: [
        {
          periodMonth: "2026-01-01",
          production710_730Try: 20000,
          opex760_770ExclDaTry: 10000,
          depreciationDaTry: 3333.34,
          financing780Try: 0,
          postedEntryCount: 3,
        },
        {
          periodMonth: "2026-02-01",
          production710_730Try: 20000,
          opex760_770ExclDaTry: 10000,
          depreciationDaTry: 3333.33,
          financing780Try: 0,
          postedEntryCount: 3,
        },
        {
          periodMonth: "2026-03-01",
          production710_730Try: 20000,
          opex760_770ExclDaTry: 10000,
          depreciationDaTry: 3333.33,
          financing780Try: 0,
          postedEntryCount: 3,
        },
      ],
      costModels: [
        {
          id: "cm-1",
          name: "Hassas Test",
          scenario: "normal",
          monthlyCost: 30000,
          breakEven: 30,
          effectiveMinutes: 1000,
          akonFreze: null,
          akonTorna: null,
        },
      ],
    });

    expect(res.avgMonthlyFull7xxInclDaTry).toBe(33333.33);
    expect(res.actualFullBreakEvenTlPerMin).toBe(33.33);
    expect(res.rateDriftTlPerMin).toBe(3.33);
  });
});

describe("loadActualCostBridge — sahte (mock) Pool entegrasyon testi", () => {
  it("0105 yönetim defteri, cost_models ve production_parts sorgularını birleştirip gizli erimeyi döner", async () => {
    const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from public.management_journal_entries")) {
        expect(params).toEqual(["2026-03-31", 3]);
        return {
          rows: [
            {
              period_month: "2026-03-01",
              production_710_730_try: "192000.00",
              opex_760_770_excl_da_try: "70000.00",
              depreciation_da_try: "32000.00",
              financing_780_try: "18500.00",
              posted_entry_count: 15,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.cost_models")) {
        return {
          rows: [
            {
              id: "cm-normal",
              name: "Normal Model",
              scenario: "normal",
              monthly_cost: "261800.00",
              break_even: "26.1800",
              eff_min: "10000",
              akon_freze: "27.5000",
              akon_torna: "31.0000",
              source_sheet_id: null,
              source_workbook_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.capacity_models")) {
        return {
          rows: [
            {
              id: "cap-1",
              name: "Kapasite 2023",
              efficiency: "0.85",
              freze: "27.50",
              torna: "31.00",
              rate_year: 2023,
              is_stale_rate: true,
              monthly_minutes: "10000",
              theo_month: "275000.00",
              theo_total: "3300000.00",
              work_days: "22",
              source_sheet_id: null,
              source_workbook_id: null,
              part_count: 1,
              missing_part_count: 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.part_profitability_runs")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.production_parts")) {
        return {
          rows: [
            {
              id: "part-1",
              part_code: "AK-01",
              part_name: "Akon Bağlantı Gövdesi",
              quantity: 10,
              torna_minutes: "5",
              freze_minutes: "5",
              unit_sale_price: "275.00",
              currency: "TRY",
              row_json: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const fakePool = { query: queryMock } as unknown as Pool;
    const res = await loadActualCostBridge(fakePool, {
      asOfDate: "2026-03-31",
      lookbackMonths: 3,
    });

    expect(res.status).toBe("ready");
    expect(res.bookBreakEvenTlPerMin).toBe(26.18);
    expect(res.actualCashBreakEvenTlPerMin).toBe(26.2);
    expect(res.actualFullBreakEvenTlPerMin).toBe(29.4);
    expect(res.rateDriftTlPerMin).toBe(3.22);
    expect(res.hiddenErosionRateCount).toBe(1);
    expect(res.hiddenErosionPartCount).toBe(1);
    expect(res.hiddenErosionParts[0]?.partCode).toBe("AK-01");
    expect(res.isStaleCapacityRate).toBe(true);
  });

  it("0105 öncesi eksik şema (42P01) durumunda çökmeden insufficient_ledger_actuals döner", async () => {
    const missingTableErr = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const fakePool = {
      query: vi.fn().mockRejectedValue(missingTableErr),
    } as unknown as Pool;

    const res = await loadActualCostBridge(fakePool);
    expect(res.status).toBe("insufficient_ledger_actuals");
    expect(res.actualBreakEvenTlPerMin).toBeNull();
    expect(res.models).toEqual([]);
    expect(res.hiddenErosionParts).toEqual([]);
  });
});
