// Ana Ekran cockpit rules — deterministic ranking + headline. No LLM, no math change.

import { describe, expect, it } from "vitest";
import { buildActions, pickHeadlineRisk, type CockpitFacts } from "./cockpit";

const base: CockpitFacts = {
  todayKnownOutflow: 0, todayCount: 0, todayMissing: 0,
  next7KnownOutflow: 0, next7Count: 0,
  overdueCount: 0, overdueKnownOutflow: 0,
  firstNegativeMonth: null, worstMonth: null, worstBalance: null,
  monthMissingCount: 0, topConcentration: null,
  debtPressureMonths: 0, failedReminders: 0, staleProductionRate: false,
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
      overdueCount: 2, overdueKnownOutflow: 90000,
      todayCount: 3, todayKnownOutflow: 50000,
      next7KnownOutflow: 200000,
      firstNegativeMonth: "2026-09-01",
      debtPressureMonths: 4,
      monthMissingCount: 6,
      topConcentration: { key: "Hpt", ratio: 0.79 },
      failedReminders: 1,
      staleProductionRate: true,
    });
    expect(a.length).toBe(5); // capped
    expect(a[0].key).toBe("overdue");
    expect(a[0].severity).toBe("critical");
    expect(a[0].href).toBe("/radar");
    expect(a[0].reason).toContain("Geciken");
    expect(a[0].impact).toContain("90.000 TL");
    expect(a[0].evidenceHref).toBe("/radar");
    // high-severity items precede medium/low
    const sev = a.map((x) => x.severity);
    expect(sev.indexOf("high")).toBeLessThan(sev.lastIndexOf("medium"));
    // stale_rate (low) is dropped by the cap when higher-severity actions exist
    expect(a.some((x) => x.key === "stale_rate")).toBe(false);
  });

  it("missing-amount action discloses count and never says 0", () => {
    const a = buildActions({ ...base, monthMissingCount: 44 });
    const m = a.find((x) => x.key === "missing")!;
    expect(m.label).toContain("44 kalemde tutar eksik");
    expect(m.label).toContain("asla 0");
    expect(m.reason).toContain("Eksik tutar");
    expect(m.evidenceHref).toBe("/data-quality");
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
