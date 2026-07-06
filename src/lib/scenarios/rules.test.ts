// Phase 8 scenario rules — required tests: baseline clone, revenue/expense %,
// customer delay (timing not amount), debt overlay, capacity/efficiency, comparison
// math (first negative / worst / max gap / recovery / final delta), null-never-zero,
// deterministic insights.

import { describe, expect, it } from "vitest";
import type { CashMonth } from "@/lib/radar/rules";
import {
  applyScenario,
  buildScenarioInsights,
  compareScenarioToBaseline,
  scenarioConfidence,
  type ScenarioAssumptions,
} from "./rules";

// baseline: opening 100k, income 100 expense 80 each → closing chain 120,140,160...
const baseline: CashMonth[] = [
  { monthStart: "2026-05-01", opening: 100000, income: 100000, expense: 80000, closing: 120000 },
  { monthStart: "2026-06-01", opening: 120000, income: 100000, expense: 80000, closing: 140000 },
  { monthStart: "2026-07-01", opening: 140000, income: 100000, expense: 80000, closing: 160000 },
];

describe("applyScenario — baseline clone (no assumptions) reproduces the chain", () => {
  it("identity: scenario closing == baseline closing", () => {
    const out = applyScenario(baseline, {});
    expect(out.map((m) => m.scenarioClosing)).toEqual([120000, 140000, 160000]);
    expect(out.every((m) => m.delta === 0)).toBe(true);
  });
});

describe("revenue/expense % adjustment re-chains closings", () => {
  it("revenue −20% cascades through the chain", () => {
    const out = applyScenario(baseline, { revenuePct: -0.2 });
    // income 80k, expense 80k → delta 0 each month → closing stays at opening
    expect(out.map((m) => m.scenarioIncome)).toEqual([80000, 80000, 80000]);
    expect(out.map((m) => m.scenarioClosing)).toEqual([100000, 100000, 100000]);
    expect(out[2].delta).toBe(-60000); // 100k vs 160k
  });
  it("expense +50% pushes cash down cumulatively", () => {
    const out = applyScenario(baseline, { expensePct: 0.5 });
    // expense 120k, income 100k → −20k/month → 80k, 60k, 40k
    expect(out.map((m) => m.scenarioClosing)).toEqual([80000, 60000, 40000]);
  });
});

describe("customer delay shifts timing, not amount", () => {
  it("delay 1 month moves income forward; total income preserved within horizon", () => {
    const out = applyScenario(baseline, { customerDelayMonths: 1 });
    // month0 income → month1, month1 → month2, month2 → falls off horizon
    expect(out[0].scenarioIncome).toBeNull(); // nothing lands in month0 (baseline known but delayed away)
    expect(out[1].scenarioIncome).toBe(100000);
    expect(out[2].scenarioIncome).toBe(100000);
    // amounts are the same 100k values, only shifted — never invented or zeroed
    expect(out[0].baselineIncome).toBe(100000); // baseline untouched
  });
});

describe("debt-service overlay adds to expense (read-only)", () => {
  it("includeDebtService adds monthly debt outflow to expense", () => {
    const out = applyScenario(baseline, { includeDebtService: true }, [
      { monthStart: "2026-06-01", knownOutflow: 30000 },
    ]);
    expect(out[0].scenarioExpense).toBe(80000);
    expect(out[1].scenarioExpense).toBe(110000); // 80k + 30k debt
    expect(out[1].scenarioClosing).toBe(110000); // 120k + 100k − 110k
  });
});

describe("capacity utilization + efficiency assumptions", () => {
  it("capacity +10% raises income; efficiency +10% lowers expense", () => {
    const out = applyScenario(baseline, { capacityUtilizationPct: 0.1, efficiencyPct: 0.1 });
    expect(out[0].scenarioIncome).toBeCloseTo(110000, 0);
    expect(out[0].scenarioExpense).toBeCloseTo(72000, 0); // 80k × 0.9
  });
});

describe("null stays null (unknown never scaled to 0)", () => {
  const withNull: CashMonth[] = [
    { monthStart: "2026-05-01", opening: 100000, income: null, expense: 80000, closing: null },
    { monthStart: "2026-06-01", opening: 100000, income: 100000, expense: 80000, closing: 120000 },
  ];
  it("unknown income → scenario income null, closing null, counted", () => {
    const out = applyScenario(withNull, { revenuePct: 0.5, expensePct: 0.5 });
    expect(out[0].scenarioIncome).toBeNull(); // unknown income never scaled
    expect(out[0].scenarioExpense).toBe(120000); // 80k × 1.5 (expensePct)
    expect(out[0].scenarioClosing).toBeNull();
    const c = compareScenarioToBaseline(out);
    expect(c.nullMonthCount).toBe(1);
    expect(scenarioConfidence(c)).toBe("low");
  });
});

describe("compareScenarioToBaseline — trough, gap, recovery, deltas", () => {
  const deficit: CashMonth[] = [
    { monthStart: "2026-05-01", opening: 100000, income: 50000, expense: 80000, closing: 70000 },
    { monthStart: "2026-06-01", opening: 70000, income: 20000, expense: 120000, closing: -30000 },
    { monthStart: "2026-07-01", opening: -30000, income: 20000, expense: 120000, closing: -130000 },
    { monthStart: "2026-08-01", opening: -130000, income: 300000, expense: 80000, closing: 90000 },
  ];
  it("finds first negative, worst month, max gap, recovery month", () => {
    const out = applyScenario(deficit, {});
    const c = compareScenarioToBaseline(out);
    expect(c.scenarioFirstNegative).toBe("2026-06-01");
    expect(c.worstMonth).toBe("2026-07-01");
    expect(c.worstBalance).toBe(-130000);
    expect(c.maxCashGap).toBe(130000); // deepest shortfall magnitude
    expect(c.recoveryMonth).toBe("2026-08-01"); // returns ≥0 after the negative run
    expect(c.baselineFinalCash).toBe(90000);
    expect(c.finalDelta).toBe(0);
  });
});

describe("buildScenarioInsights (deterministic, not AI)", () => {
  it("reports first-negative shift, final delta, debt overlay, low confidence", () => {
    const base: CashMonth[] = [
      { monthStart: "2026-05-01", opening: 100000, income: 100000, expense: 80000, closing: 120000 },
      { monthStart: "2026-06-01", opening: 120000, income: 100000, expense: 200000, closing: 20000 },
      { monthStart: "2026-07-01", opening: 20000, income: 100000, expense: 200000, closing: -80000 },
    ];
    const out = applyScenario(base, { expensePct: 0.3, includeDebtService: true }, [{ monthStart: "2026-06-01", knownOutflow: 50000 }]);
    const c = compareScenarioToBaseline(out);
    const insights = buildScenarioInsights(c, { expensePct: 0.3, includeDebtService: true });
    expect(insights.some((s) => /Final kasa baz senaryoya göre/.test(s))).toBe(true);
    expect(insights.some((s) => /Borç-servisi dahil edildiğinde/.test(s))).toBe(true);
    expect(insights.some((s) => /En büyük baskı ayı/.test(s))).toBe(true);
  });
  it("assumption-free near-identical scenario → single line", () => {
    const out = applyScenario(baseline, {});
    const c = compareScenarioToBaseline(out);
    const insights = buildScenarioInsights(c, {} as ScenarioAssumptions);
    expect(insights.some((s) => /neredeyse aynı/.test(s))).toBe(true);
  });
});
