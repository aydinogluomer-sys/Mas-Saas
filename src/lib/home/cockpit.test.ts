// Ana Ekran cockpit rules — deterministic ranking + headline + 11 CFO Executive Cards.

import { describe, expect, it } from "vitest";
import {
  buildActions,
  buildExecutiveCockpitCards,
  closingTrend,
  pickHeadlineRisk,
  type CockpitFacts,
  type ExecutiveCockpitInput,
} from "./cockpit";

const base: CockpitFacts = {
  todayKnownOutflow: 0,
  todayCount: 0,
  todayMissing: 0,
  next7KnownOutflow: 0,
  next7Count: 0,
  overdueCount: 0,
  overdueKnownOutflow: 0,
  firstNegativeMonth: null,
  worstMonth: null,
  worstBalance: null,
  monthMissingCount: 0,
  topConcentration: null,
  debtPressureMonths: 0,
  failedReminders: 0,
  staleProductionRate: false,
};

describe("buildActions", () => {
  it("empty facts → single routine line (never fabricates advice)", () => {
    const a = buildActions(base);
    expect(a).toHaveLength(1);
    expect(a[0].key).toBe("routine");
  });

  it("overdue ranks critical and first; caps at 5", () => {
    const a = buildActions({
      ...base,
      overdueCount: 2,
      overdueKnownOutflow: 90000,
      todayCount: 3,
      todayKnownOutflow: 50000,
      next7KnownOutflow: 200000,
      firstNegativeMonth: "2026-09-01",
      debtPressureMonths: 4,
      monthMissingCount: 6,
      topConcentration: { key: "Hpt", ratio: 0.79 },
      failedReminders: 1,
      staleProductionRate: true,
    });
    expect(a.length).toBe(5);
    expect(a[0].key).toBe("overdue");
    expect(a[0].severity).toBe("critical");
    expect(a[0].href).toBe("/payments");
    expect(a[0].reason).toContain("Geciken");
    expect(a[0].impact).toContain("90.000 TL");
    expect(a[0].evidenceHref).toBe("/payments");
    const sev = a.map((x) => x.severity);
    expect(sev.indexOf("high")).toBeLessThan(sev.lastIndexOf("medium"));
    expect(a.some((x) => x.key === "stale_rate")).toBe(false);
  });

  it("missing-amount action discloses count and never says 0", () => {
    const a = buildActions({ ...base, monthMissingCount: 44 });
    const m = a.find((x) => x.key === "missing")!;
    expect(m.label).toContain("44 kalemde tutar eksik");
    expect(m.label).toContain("asla 0");
    expect(m.reason).toContain("Eksik tutar");
    expect(m.evidenceHref).toBe("/data/quality");
  });

  it("concentration only fires above 40%", () => {
    expect(buildActions({ ...base, topConcentration: { key: "Hpt", ratio: 0.3 } }).some((x) => x.key === "concentration")).toBe(false);
    expect(buildActions({ ...base, topConcentration: { key: "Hpt", ratio: 0.79 } }).some((x) => x.key === "concentration")).toBe(true);
  });
});

describe("pickHeadlineRisk", () => {
  it("overdue dominates", () => {
    expect(pickHeadlineRisk({ ...base, overdueCount: 2, firstNegativeMonth: "2026-09-01" }).tone).toBe("neg");
    expect(pickHeadlineRisk({ ...base, overdueCount: 2 }).text).toContain("geciken");
  });
  it("first negative when no overdue", () => {
    const h = pickHeadlineRisk({ ...base, firstNegativeMonth: "2026-09-01", worstMonth: "2029-03-01", worstBalance: -3064608 });
    expect(h.text).toContain("2026-09");
    expect(h.tone).toBe("neg");
  });
  it("calm state → positive", () => {
    expect(pickHeadlineRisk(base).tone).toBe("pos");
  });
});

describe("closingTrend — 12 aylık kasa eğilimi (Wave 0, R10)", () => {
  it("leaves an unknown closing OUT of the series and counts it — never draws it as 0", () => {
    const t = closingTrend([{ closing: 100 }, { closing: null }, { closing: -50 }]);
    expect(t.values).toEqual([100, -50]);
    expect(t.values).not.toContain(0);
    expect(t.unknownCount).toBe(1);
  });

  it("keeps an explicit 0 closing (zero is a value, not unknown)", () => {
    const t = closingTrend([{ closing: 0 }, { closing: 10 }]);
    expect(t.values).toEqual([0, 10]);
    expect(t.unknownCount).toBe(0);
  });

  it("looks only at the first `limit` months and counts unknowns inside that window", () => {
    const months = Array.from({ length: 14 }, (_, i) => ({ closing: i === 13 ? null : i }));
    const t = closingTrend(months);
    expect(t.values).toHaveLength(12);
    expect(t.unknownCount).toBe(0);
    expect(closingTrend(months, 14).unknownCount).toBe(1);
  });

  it("an all-unknown window is an empty series, not a flat zero line", () => {
    expect(closingTrend([{ closing: null }, { closing: null }])).toEqual({ values: [], unknownCount: 2 });
  });
});

describe("buildExecutiveCockpitCards — 11 CFO Executive Pulse Cards (M-12)", () => {
  const sampleInput: ExecutiveCockpitInput = {
    asOf: "2026-11-01",
    freeCashConsolidatedTry: 2_450_000,
    freeCashTryOnly: 1_800_000,
    fxCashTryEquivalent: 650_000,
    unknownOpeningCount: 0,
    activeAccountCount: 4,
    minCash13wTry: 420_000,
    minCash13wDate: "2026-12-18",
    netFlow13wTry: -2_030_000,
    receivablesOpenTry: 3_100_000,
    payablesOpenTry: 1_900_000,
    dsoDays: 46.5,
    dpoDays: 38.2,
    dioDays: null,
    cccDays: null,
    cycleExclInventoryDays: 8.3,
    overdueReceivablesTry: 275_000,
    overdueReceivablesCount: 3,
    checkPortfolioInflowTry: 850_000,
    checkCollateralTry: 120_000,
    checkIssuedOutflowTry: 540_000,
    checkEndorsedRiskTry: 210_000,
    checkBouncedCount: 0,
    fxNetOpenTry: -480_000,
    fxShock20LossTry: -96_000,
    fxRateSummary: "USD 34,83 · EUR 37,90",
    facilityAvailableTry: 1_500_000,
    facilityLimitTry: 2_500_000,
    covenantActiveCount: 2,
    covenantBreachedCount: 0,
    budgetOverCount: 1,
    budgetNetVarianceTry: 42_000,
    budgetMeasuredCount: 8,
    pendingApprovalsCount: 2,
    unmatchedBankTxCount: 5,
    criticalControlAlertCount: 0,
    openMappingReviewCount: 1,
  };

  it("renders all 11 canonical CFO cards with source-proof items and never fabricates DIO as 0", () => {
    const cards = buildExecutiveCockpitCards(sampleInput);
    expect(cards).toHaveLength(11);
    expect(cards.map((c) => c.title)).toEqual([
      "Net Likidite",
      "13H Nakit Ufku",
      "DSO / Tahsilat Hızı",
      "DPO / Ödeme Vadesi",
      "DIO & Nakit Döngüsü (CCC)",
      "Vadesi Geçmiş Alacak",
      "Çek/Senet Portföy & Ciro Riski",
      "Döviz Açık Pozisyonu",
      "Kredi & Kovenant Boşluğu",
      "Bütçe Sapması",
      "Onay & Mutabakat İstisnaları",
    ]);

    const cccCard = cards.find((c) => c.key === "dio_ccc")!;
    expect(cccCard.sublabel).toContain("stok kartı bekleniyor");
    expect(cccCard.proofItems.length).toBeGreaterThan(0);

    const breached = buildExecutiveCockpitCards({
      ...sampleInput,
      covenantBreachedCount: 1,
      freeCashConsolidatedTry: null,
      unknownOpeningCount: 2,
    });
    expect(breached.find((c) => c.key === "net_liquidity")!.value).toBe("—");
    expect(breached.find((c) => c.key === "credit_covenant_headroom")!.tone).toBe("neg");
  });
});
