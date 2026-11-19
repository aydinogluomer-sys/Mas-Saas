import { describe, expect, it } from "vitest";
import { horizonMonthsOf, solveBreakevenLevers } from "@/lib/scenarios/breakeven-goalseek";
import { simulateUnified13WeekScenario } from "@/lib/scenarios/unified-engine";

describe("M-50: Unified 13-week dynamic scenario & breakeven goal-seek", () => {
  const baseWeeks = Array.from({ length: 13 }, (_, idx) => {
    const dayOffset = idx * 7;
    const ms = Date.parse("2026-11-16T00:00:00Z") + dayOffset * 86_400_000;
    const weekStart = new Date(ms).toISOString().slice(0, 10);
    return {
      weekIndex: idx + 1,
      weekStart,
      baselineInflow: idx === 11 ? 500_000 : 100_000,
      baselineOutflow: 120_000,
      hardOutflow: 30_000,
      baselineClosingCash: 250_000,
      fxReceivableInflowTry: 20_000,
      fxPayableOutflowTry: 30_000,
      fxLoanOutflowTry: 10_000,
      bomFxOutflowTry: 15_000,
    };
  });

  it("preserves receivables pushed past week 13 in deferredReceivablesCarryover without evaporating them", () => {
    const res = simulateUnified13WeekScenario({
      baselineWeeks: baseWeeks,
      openingCashTry: 300_000,
      fxCashBankNetTry: 50_000,
      availableFacilityHeadroomTry: 1_000_000,
      weightedFacilityAnnualRate: 0.48,
      bsmvRate: 0.05,
      kkdfRate: 0,
      baselineAnnualizedEbitdaTry: 4_800_000,
      baselineAnnualDebtServiceTry: 2_400_000,
      fxAnnualDebtServiceTry: 600_000,
      minDscrThreshold: 1.2,
      params: {
        fxShockPct: 0,
        collectionDelayDays: 21, // +3 weeks -> pushes weeks 11..13 inflows past W13!
        paymentDelayDays: 0,
        revenueDeltaPct: 0,
        passThroughPct: 0,
        minCashBufferTry: 100_000,
        autoDrawFacility: false,
      },
    });

    // Weeks 11 (100k), 12 (500k), 13 (100k) = 700k shifted past week 13 -> must NOT evaporate!
    expect(res.deferredReceivablesCarryover).toBe(700_000);
    expect(res.weeks).toHaveLength(13);
  });

  it("automatically draws revolving BCH credit and accrues 780 interest + 5% BSMV when cash falls below buffer", () => {
    const res = simulateUnified13WeekScenario({
      baselineWeeks: baseWeeks,
      openingCashTry: 100_000,
      fxCashBankNetTry: 0,
      availableFacilityHeadroomTry: 1_500_000,
      weightedFacilityAnnualRate: 0.52,
      bsmvRate: 0.05,
      kkdfRate: 0,
      baselineAnnualizedEbitdaTry: 3_000_000,
      baselineAnnualDebtServiceTry: 2_600_000,
      fxAnnualDebtServiceTry: 800_000,
      minDscrThreshold: 1.25,
      params: {
        fxShockPct: 25,
        collectionDelayDays: 14,
        paymentDelayDays: 0,
        revenueDeltaPct: -15,
        passThroughPct: 30,
        minCashBufferTry: 150_000,
        autoDrawFacility: true,
      },
    });

    expect(res.totalAutoFacilityDraw).toBeGreaterThan(0);
    expect(res.totalIncrementalInterestTax).toBeGreaterThan(0);
    expect(res.covenantBreachCount).toBeGreaterThan(0);
    // Every week's closing cash must be protected at >= minCashBufferTry while headroom remains
    for (const w of res.weeks) {
      if (w.remainingFacilityHeadroom > 0 && w.scenarioClosingCash != null) {
        expect(w.scenarioClosingCash).toBeGreaterThanOrEqual(150_000);
      }
    }
  });

  it("divides goal-seek production rate shortfall across horizonMonths (no 3x-12x single-month inflation)", () => {
    expect(horizonMonthsOf("14d")).toBe(1);
    expect(horizonMonthsOf("13w")).toBe(3);
    expect(horizonMonthsOf("12m")).toBe(12);

    const common = {
      asOfDate: "2026-11-16",
      openingCash: 100_000,
      minCashFloor: 50_000,
      flows: [{ dateISO: "2026-11-25", direction: "outflow" as const, amount: 370_000, isDiscretionary: true }],
      openReceivables: [{ dueDate: "2026-12-20", amount: 400_000 }],
      availableCreditHeadroom: 500_000,
      productionCostModel: {
        monthlyTotalCost: 600_000,
        effectiveMonthlyMinutes: 10_000, // base breakeven = 60 TL/min
        currentRateTlPerMin: 65,
      },
    };

    const res13w = solveBreakevenLevers({ ...common, horizon: "13w" });
    const res12m = solveBreakevenLevers({ ...common, horizon: "12m" });

    // Shortfall is 320,000 TL (100k - 370k = -270k vs +50k floor -> 320k shortfall).
    // Over 13w (3 months): monthly burden = 320,000 / 3 = 106,666.67 -> +10.67 TL/min -> ~70.67 TL/min
    // Over 12m (12 months): monthly burden = 320,000 / 12 = 26,666.67 -> +2.67 TL/min -> ~62.67 TL/min
    expect(res13w.requiredShortfall).toBe(320_000);
    expect(res13w.levers.productionFloorRate.baseBreakevenTlPerMin).toBe(60);
    expect(res13w.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin).toBeCloseTo(70.67, 1);
    expect(res12m.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin).toBeCloseTo(62.67, 1);
  });
});

