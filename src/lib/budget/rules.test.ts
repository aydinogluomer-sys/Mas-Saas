import { describe, expect, it } from "vitest";
import {
  FORECAST_WEEKS, SOURCE_CONFIDENCE, SOURCE_KINDS, SOURCE_LABEL, VERDICT_LABEL,
  VERSION_STATUSES, VERSION_TRANSITIONS, accuracy, addDays, canTransition, variance,
  weekBuckets, weightedNet,
} from "./rules";

describe("version lifecycle mirrors the database guard", () => {
  it("allows exactly the three documented moves", () => {
    const allowed = new Set(VERSION_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    expect(allowed).toEqual(new Set(["draft>approved", "draft>superseded", "approved>superseded"]));
  });

  it("REFUSES approved -> draft", () => {
    // Reopening an approved line would silently rewrite a signed-off figure, and every variance
    // report built on it would change underneath its readers.
    expect(canTransition("approved", "draft")).toBe(false);
  });

  it("treats superseded as terminal", () => {
    for (const to of VERSION_STATUSES) {
      if (to !== "superseded") expect(canTransition("superseded", to), `superseded>${to}`).toBe(false);
    }
  });

  it("refuses exactly three of the six ordered pairs", () => {
    const allowed = new Set(VERSION_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    let refused = 0;
    for (const from of VERSION_STATUSES) {
      for (const to of VERSION_STATUSES) {
        if (from === to) continue;
        if (!allowed.has(`${from}>${to}`)) {
          expect(canTransition(from, to)).toBe(false);
          refused += 1;
        }
      }
    }
    expect(refused).toBe(3);
  });

  it("treats same-status as a no-op", () => {
    for (const s of VERSION_STATUSES) expect(canTransition(s, s)).toBe(true);
  });
});

describe("variance — direction decides the verdict", () => {
  it("calls overspending an expense budget over_budget", () => {
    const v = variance("expense", 1000, 1200);
    expect(v.varianceAmount).toBe(200);
    expect(v.verdict).toBe("over_budget");
  });

  it("calls the SAME positive variance on income a GOOD outcome", () => {
    // An unsigned "variance" would colour this red exactly like the expense case above.
    const v = variance("income", 1000, 1200);
    expect(v.varianceAmount).toBe(200);
    expect(v.verdict).toBe("on_or_above_target");
  });

  it("calls under-spending an expense budget within_budget", () => {
    expect(variance("expense", 1000, 800).verdict).toBe("within_budget");
  });

  it("calls missing income under_target", () => {
    expect(variance("income", 1000, 800).verdict).toBe("under_target");
  });

  it("returns NULL and not_measured when no actual exists — never zero", () => {
    const v = variance("expense", 1000, null);
    expect(v.actualAmount).toBeNull();
    expect(v.varianceAmount).toBeNull();
    expect(v.varianceRatio).toBeNull();
    expect(v.verdict).toBe("not_measured");
  });

  it("treats an explicit zero actual as measured, unlike a missing one", () => {
    const v = variance("expense", 1000, 0);
    expect(v.actualAmount).toBe(0);
    expect(v.varianceAmount).toBe(-1000);
    expect(v.verdict).toBe("within_budget");
  });

  it("returns a null ratio against a zero budget rather than dividing", () => {
    expect(variance("expense", 0, 500).varianceRatio).toBeNull();
    expect(variance("expense", 0, 500).varianceAmount).toBe(500);
  });

  it("computes in decimal, not float", () => {
    // 1000.10 - 1000.00 is exactly 0.10; float subtraction lands on 0.09999999999990905.
    expect(variance("expense", "1000.00", "1000.10").varianceAmount).toBe(0.1);
  });

  it("labels every verdict in Turkish", () => {
    for (const k of Object.keys(VERDICT_LABEL) as Array<keyof typeof VERDICT_LABEL>) {
      expect(VERDICT_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});

describe("source classification", () => {
  it("covers the five kinds the plan specifies", () => {
    expect([...SOURCE_KINDS]).toEqual([
      "contracted", "scheduled", "historical", "manual", "estimated",
    ]);
  });

  it("orders default confidence by how reliable the ORIGIN is", () => {
    expect(SOURCE_CONFIDENCE.contracted).toBeGreaterThan(SOURCE_CONFIDENCE.scheduled);
    expect(SOURCE_CONFIDENCE.scheduled).toBeGreaterThan(SOURCE_CONFIDENCE.historical);
    expect(SOURCE_CONFIDENCE.historical).toBeGreaterThan(SOURCE_CONFIDENCE.manual);
    expect(SOURCE_CONFIDENCE.manual).toBeGreaterThan(SOURCE_CONFIDENCE.estimated);
  });

  it("keeps every default inside 0..1", () => {
    for (const k of SOURCE_KINDS) {
      expect(SOURCE_CONFIDENCE[k]).toBeGreaterThan(0);
      expect(SOURCE_CONFIDENCE[k]).toBeLessThanOrEqual(1);
      expect(SOURCE_LABEL[k].length).toBeGreaterThan(0);
    }
  });
});

describe("weekBuckets — the 13-week horizon", () => {
  it("always produces exactly 13 contiguous weeks", () => {
    const w = weekBuckets("2099-01-05");
    expect(w).toHaveLength(FORECAST_WEEKS);
    expect(w[0].weekStart).toBe("2099-01-05");
    expect(w[0].weekEnd).toBe("2099-01-11");
    expect(w[12].weekEnd).toBe("2099-04-05");
  });

  it("leaves no gap or overlap between consecutive weeks", () => {
    const w = weekBuckets("2099-01-05");
    for (let i = 1; i < w.length; i += 1) {
      expect(w[i].weekStart).toBe(addDays(w[i - 1].weekEnd, 1));
    }
  });

  it("spans a month boundary correctly", () => {
    expect(addDays("2099-01-30", 3)).toBe("2099-02-02");
  });
});

describe("accuracy — exclusions that would otherwise flatter the number", () => {
  it("SKIPS unmeasured lines rather than scoring them perfect", () => {
    // Counting them would make a forecast look more accurate the less of it had been checked.
    const a = accuracy([
      { forecast: 100, actual: 110 },
      { forecast: 200, actual: null },
    ]);
    expect(a.measuredCount).toBe(1);
    expect(a.biasTotal).toBe(10);
  });

  it("excludes zero-forecast lines from MAPE and reports the count", () => {
    const a = accuracy([
      { forecast: 100, actual: 150 },
      { forecast: 0, actual: 50 },
    ]);
    expect(a.zeroForecastLines).toBe(1);
    expect(a.mape).toBe(0.5); // only the first line
    expect(a.measuredCount).toBe(2);
    expect(a.absoluteErrorTotal).toBe(100);
  });

  it("returns a null MAPE when nothing qualifies rather than 0", () => {
    const a = accuracy([{ forecast: 0, actual: 10 }]);
    expect(a.mape).toBeNull();
  });

  it("keeps bias signed so over- and under-forecasting do not cancel silently", () => {
    const a = accuracy([
      { forecast: 100, actual: 120 },
      { forecast: 100, actual: 80 },
    ]);
    expect(a.biasTotal).toBe(0);
    // Absolute error still shows the forecast was wrong twice.
    expect(a.absoluteErrorTotal).toBe(40);
  });

  it("uses the magnitude of a negative forecast for MAPE", () => {
    expect(accuracy([{ forecast: -100, actual: -150 }]).mape).toBe(0.5);
  });

  it("returns an empty result set honestly", () => {
    const a = accuracy([]);
    expect(a.measuredCount).toBe(0);
    expect(a.mape).toBeNull();
  });
});

describe("weightedNet", () => {
  it("signs outflows negative", () => {
    expect(weightedNet([
      { amount: 1000, direction: "inflow", confidence: 1 },
      { amount: 400, direction: "outflow", confidence: 1 },
    ])).toBe(600);
  });

  it("weights by confidence", () => {
    expect(weightedNet([{ amount: 1000, direction: "inflow", confidence: 0.5 }])).toBe(500);
  });

  it("gives an unscored line FULL weight rather than dropping it", () => {
    // A cash forecast that quietly omits money is worse than one that includes it at face value.
    expect(weightedNet([{ amount: 1000, direction: "inflow" }])).toBe(1000);
    expect(weightedNet([{ amount: 1000, direction: "inflow", confidence: null }])).toBe(1000);
  });

  it("ignores unknown amounts", () => {
    expect(weightedNet([
      { amount: null, direction: "inflow", confidence: 1 },
      { amount: 250, direction: "inflow", confidence: 1 },
    ])).toBe(250);
  });

  it("accumulates in decimal", () => {
    const lines = Array.from({ length: 300 }, () => ({
      amount: "0.01", direction: "inflow" as const, confidence: 1,
    }));
    expect(weightedNet(lines)).toBe(3);
  });
});
