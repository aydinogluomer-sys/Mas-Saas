// Phase 7 production rules — required tests (mas-cost-capacity-analyst skill):
// normal vs overtime, break-even TL/dk, missing operation time flag, part cost estimate,
// ROI needs_review default. Plus null-never-zero, capacity gap, revenue gap, insights.

import { describe, expect, it } from "vitest";
import {
  breakEvenTLPerMin,
  buildInsights,
  capacityGap,
  compareScenarios,
  effectiveMinutes,
  machineRoi,
  partProfitability,
  priceMargin,
  revenueGap,
  theoreticalRevenue,
  utilizationRate,
  type ScenarioModel,
} from "./rules";

describe("effectiveMinutes / breakEven (real kapasite+cost anchors)", () => {
  it("normal: 3.8 machines × 13200 dk × 0.8 = 40128 effective minutes", () => {
    expect(effectiveMinutes(3.8, 13200, 0.8)).toBeCloseTo(40128, 0);
  });
  it("break-even = monthly cost ÷ effective minutes (source G6 ≈ 26.18)", () => {
    expect(breakEvenTLPerMin(1050694.29, 40128)).toBeCloseTo(26.1836, 3);
  });
  it("null input stays null (never 0)", () => {
    expect(effectiveMinutes(null, 13200, 0.8)).toBeNull();
    expect(breakEvenTLPerMin(1050694, null)).toBeNull();
    expect(breakEvenTLPerMin(1050694, 0)).toBeNull();
  });
});

describe("utilization / capacityGap / theoreticalRevenue", () => {
  it("utilization = demand ÷ effective", () => {
    expect(utilizationRate(20064, 40128)).toBeCloseTo(0.5, 5);
    expect(utilizationRate(20064, 0)).toBeNull();
  });
  it("capacity gap = effective − demand (idle positive)", () => {
    expect(capacityGap(40128, 30000)).toBe(10128);
    expect(capacityGap(null, 30000)).toBeNull();
  });
  it("theoretical revenue = minutes × TL/dk", () => {
    expect(theoreticalRevenue(40128, 26.1836)).toBeCloseTo(1050695.5, 1);
  });
});

describe("compareScenarios (normal vs mesaili)", () => {
  const normal: ScenarioModel = { scenario: "normal", effMinutes: 40128, monthlyCost: 1050694, breakEvenTLPerMin: 26.18, efficiency: 0.8 };
  const overtime: ScenarioModel = { scenario: "overtime", effMinutes: 49248, monthlyCost: 1060785, breakEvenTLPerMin: 21.54, efficiency: 0.75 };
  it("real data: mesaili adds minutes, LOWER break-even ⇒ improves unit cost", () => {
    const c = compareScenarios(normal, overtime);
    expect(c.minutesDelta).toBeCloseTo(9120, 0);
    expect(c.costDelta).toBeCloseTo(10091, 0);
    expect(c.breakEvenDelta).toBeCloseTo(-4.64, 2);
    expect(c.verdict).toBe("mesaili_iyilestiriyor");
  });
  it("higher overtime break-even ⇒ worsens; unknown ⇒ belirsiz", () => {
    expect(compareScenarios(normal, { ...overtime, breakEvenTLPerMin: 30 }).verdict).toBe("mesaili_kotulestiriyor");
    expect(compareScenarios(normal, { ...overtime, breakEvenTLPerMin: null }).verdict).toBe("belirsiz");
  });
});

describe("partProfitability", () => {
  it("cost = minutes × per-op rate; margin = revenue − cost", () => {
    const p = partProfitability(
      { code: "ARS8349", name: "KV20", quantity: 600, tornaMinutesPerUnit: 11, frezeMinutesPerUnit: 8, revenue: 96614.4 },
      16, // torna TL/dk
      20.128, // freze TL/dk
    );
    expect(p.tornaTotalMinutes).toBe(6600);
    expect(p.frezeTotalMinutes).toBe(4800);
    expect(p.estimatedTornaCost).toBe(105600); // 6600 × 16
    expect(p.estimatedFrezeCost).toBeCloseTo(96614.4, 1); // 4800 × 20.128
    expect(p.estimatedTotalCost).toBeCloseTo(202214.4, 1);
    expect(p.estimatedMargin).toBeCloseTo(96614.4 - 202214.4, 1);
    expect(p.missingOperationTime).toBe(false);
    expect(p.confidence).toBe("estimated");
  });
  it("missing BOTH operation times → flagged + needs_review; null costs stay null", () => {
    const p = partProfitability(
      { code: "X", name: "no-op", quantity: 100, tornaMinutesPerUnit: null, frezeMinutesPerUnit: null, revenue: 5000 },
      16, 20.128,
    );
    expect(p.missingOperationTime).toBe(true);
    expect(p.confidence).toBe("needs_review");
    expect(p.estimatedTotalCost).toBeNull(); // never 0
    expect(p.estimatedMargin).toBeNull();
  });
  it("one operation present → partial cost, not flagged missing", () => {
    const p = partProfitability(
      { code: "Y", name: "freze-only", quantity: 300, tornaMinutesPerUnit: null, frezeMinutesPerUnit: 55, revenue: 332112 },
      16, 20.128,
    );
    expect(p.estimatedTornaCost).toBeNull();
    expect(p.estimatedFrezeCost).toBeCloseTo(300 * 55 * 20.128, 0);
    expect(p.missingOperationTime).toBe(false);
  });
});

describe("priceMargin (Akon TL/dk vs break-even — real numbers)", () => {
  it("normal freze price 27.5 barely clears break-even 26.18 (thin margin)", () => {
    const m = priceMargin(26.1836, 27.5);
    expect(m.margin).toBeCloseTo(1.3164, 3);
    expect(m.loss).toBe(false);
    expect(m.marginRate).toBeCloseTo(0.0479, 3);
  });
  it("normal torna price 21.88 below break-even 26.18 ⇒ LOSS flagged", () => {
    const m = priceMargin(26.1836, 21.88);
    expect(m.margin).toBeCloseTo(-4.3036, 3);
    expect(m.loss).toBe(true);
  });
  it("mesaili break-even 21.54 turns torna profitable", () => {
    expect(priceMargin(21.5397, 21.88).loss).toBe(false);
  });
  it("null side ⇒ null margin, never 0", () => {
    expect(priceMargin(null, 27.5).margin).toBeNull();
    expect(priceMargin(26.18, null).margin).toBeNull();
  });
});

describe("machineRoi (defaults needs_review)", () => {
  it("remaining = revenue − cost; net = remaining − tax; confidence needs_review", () => {
    const r = machineRoi({ revenue: 1000000, cost: 600000, tax: 80000 });
    expect(r.remaining).toBe(400000);
    expect(r.netAfterTax).toBe(320000);
    expect(r.confidence).toBe("needs_review");
  });
  it("null revenue/cost → null remaining (never 0)", () => {
    expect(machineRoi({ revenue: null, cost: 600000, tax: 0 }).remaining).toBeNull();
  });
});

describe("revenueGap (theoretical capacity vs actual cashflow income)", () => {
  it("flags when actual < 60% of theoretical", () => {
    const g = revenueGap(1547640, 800000);
    expect(g.gap).toBeCloseTo(747640, 0);
    expect(g.ratio).toBeCloseTo(0.517, 3);
    expect(g.flagged).toBe(true);
  });
  it("null side → no flag, null gap", () => {
    expect(revenueGap(null, 800000)).toEqual({ gap: null, ratio: null, flagged: false });
  });
});

describe("buildInsights (deterministic text, not AI)", () => {
  it("emits stale-rate, utilization gap, mesaili verdict, revenue gap, missing data", () => {
    const out = buildInsights({
      utilization: 0.5,
      comparison: compareScenarios(
        { scenario: "normal", effMinutes: 40128, monthlyCost: 1050694, breakEvenTLPerMin: 26.18, efficiency: 0.8 },
        { scenario: "overtime", effMinutes: 49248, monthlyCost: 1060785, breakEvenTLPerMin: 21.54, efficiency: 0.75 },
      ),
      revenueGapRatio: 0.5,
      isStaleRate: true,
      missingPartCount: 6,
      totalPartCount: 52,
    });
    expect(out.some((s) => /Kapasite kullanım açığı/.test(s))).toBe(true);
    expect(out.some((s) => /Mesaili model birim maliyeti azaltıyor/.test(s))).toBe(true);
    expect(out.some((s) => /Teorik gelir ile gerçekleşen/.test(s))).toBe(true);
    expect(out.some((s) => /Stale-rate/.test(s))).toBe(true);
    expect(out.some((s) => /6\/52/.test(s))).toBe(true);
  });
  it("no issues → single reassuring analytic line", () => {
    const out = buildInsights({ utilization: 0.9, comparison: null, revenueGapRatio: 0.9, isStaleRate: false, missingPartCount: 0, totalPartCount: 52 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/Belirgin.*uyarısı yok/);
  });
  it("utilization > 1 → over-capacity insight (real mix ≈ 2.49)", () => {
    const out = buildInsights({ utilization: 2.49, comparison: null, revenueGapRatio: 0.9, isStaleRate: false, missingPartCount: 0, totalPartCount: 68 });
    expect(out.some((s) => /Talep kapasiteyi aşıyor/.test(s))).toBe(true);
    expect(out.some((s) => /açığı yüksek/.test(s))).toBe(false);
  });
});
