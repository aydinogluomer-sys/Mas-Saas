import { describe, expect, it } from "vitest";
import {
  ageingDistribution, cashBridge, formatMetric, paretoConcentration,
  varianceDecomposition, workingCapitalDecomposition,
} from "./analyses";

describe("varianceDecomposition", () => {
  it("ranks lines by the magnitude of their variance", () => {
    const out = varianceDecomposition([
      { key: "a", label: "A", budget: 100, actual: 110 },
      { key: "b", label: "B", budget: 100, actual: 40 },
      { key: "c", label: "C", budget: 100, actual: 100 },
    ]);
    expect(out.rows[0].key).toBe("b");       // −60 is the biggest movement
    expect(out.rows[0].direction).toBe("under_budget");
    expect(out.rows[1].direction).toBe("over_budget");
    expect(out.rows[2].direction).toBe("on_budget");
  });

  it("EXCLUDES lines with unknown budget or actual and counts them", () => {
    // A missing actual read as 0 would report the most flattering possible underspend.
    const out = varianceDecomposition([
      { key: "a", label: "A", budget: 100, actual: null },
      { key: "b", label: "B", budget: 100, actual: 150 },
    ]);
    expect(out.rows).toHaveLength(1);
    expect(out.unknownCount).toBe(1);
  });

  it("is unmeasurable when nothing has both sides", () => {
    const out = varianceDecomposition([{ key: "a", label: "A", budget: null, actual: null }]);
    expect(out.unmeasurableReason).not.toBeNull();
    expect(out.rows).toHaveLength(0);
  });

  it("breaks ties by key so output never depends on input order", () => {
    const a = varianceDecomposition([
      { key: "z", label: "Z", budget: 0, actual: 10 },
      { key: "a", label: "A", budget: 0, actual: 10 },
    ]);
    const b = varianceDecomposition([
      { key: "a", label: "A", budget: 0, actual: 10 },
      { key: "z", label: "Z", budget: 0, actual: 10 },
    ]);
    expect(a.rows.map((r) => r.key)).toEqual(b.rows.map((r) => r.key));
  });
});

describe("paretoConcentration", () => {
  it("marks the smallest group reaching the threshold", () => {
    const out = paretoConcentration([
      { key: "a", label: "A", value: 80 },
      { key: "b", label: "B", value: 10 },
      { key: "c", label: "C", value: 10 },
    ], 0.8);
    expect(out.summary?.vitalFewCount).toBe(1);
    expect(out.rows[0].inVitalFew).toBe(true);
    expect(out.rows[1].inVitalFew).toBe(false);
    expect(out.rows[0].cumulativeShare).toBeCloseTo(0.8, 6);
  });

  it("accumulates shares to exactly 1", () => {
    const out = paretoConcentration([
      { key: "a", label: "A", value: 30 },
      { key: "b", label: "B", value: 45 },
      { key: "c", label: "C", value: 25 },
    ]);
    expect(out.rows[out.rows.length - 1].cumulativeShare).toBeCloseTo(1, 9);
  });

  it("REFUSES negative values instead of producing nonsense shares", () => {
    // With −100 and +100 the total is zero and every share is infinite.
    const out = paretoConcentration([
      { key: "a", label: "A", value: -100 },
      { key: "b", label: "B", value: 100 },
    ]);
    expect(out.unmeasurableReason).toContain("Negatif");
    expect(out.summary).toBeNull();
  });

  it("counts unknown values without letting them into the total", () => {
    const out = paretoConcentration([
      { key: "a", label: "A", value: 100 },
      { key: "b", label: "B", value: null },
    ]);
    expect(out.unknownCount).toBe(1);
    expect(out.summary?.total).toBe(100);
  });
});

describe("workingCapitalDecomposition", () => {
  it("always reports DIO as unmeasurable rather than omitting it", () => {
    const out = workingCapitalDecomposition({ dsoDays: 60, dpoDays: 40 });
    const dio = out.rows.find((r) => r.key === "dio_days");
    expect(dio?.days).toBeNull();
    expect(dio?.unmeasurableReason).toContain("Envanter");
    // Omitting DIO would let DSO − DPO be read as the full cash conversion cycle.
    expect(out.complete).toBe(false);
  });

  it("signs the components so the cycle direction is explicit", () => {
    const out = workingCapitalDecomposition({ dsoDays: 60, dpoDays: 40 });
    expect(out.rows.find((r) => r.key === "dso_days")?.sign).toBe(1);
    expect(out.rows.find((r) => r.key === "dpo_days")?.sign).toBe(-1);
    expect(out.cycleDays).toBe(20);
  });

  it("returns a null cycle when either side is unknown", () => {
    expect(workingCapitalDecomposition({ dsoDays: null, dpoDays: 40 }).cycleDays).toBeNull();
    expect(workingCapitalDecomposition({ dsoDays: 60, dpoDays: null }).cycleDays).toBeNull();
  });
});

describe("cashBridge", () => {
  it("builds start, movements and a computed end", () => {
    const out = cashBridge({
      startLabel: "Açılış", startValue: 1000,
      endLabel: "Kapanış", reportedEndValue: 1200,
      movements: [
        { key: "in", label: "Gelir", value: 500 },
        { key: "out", label: "Gider", value: -300 },
      ],
    });
    expect(out.computedEnd).toBe(1200);
    expect(out.reconciles).toBe(true);
    expect(out.rows[0].kind).toBe("start");
    expect(out.rows[out.rows.length - 1].kind).toBe("end");
    expect(out.rows[1].runningTotal).toBe(1500);
  });

  it("reports a reconciliation FAILURE rather than drawing a bridge that does not add up", () => {
    const out = cashBridge({
      startLabel: "Açılış", startValue: 1000,
      endLabel: "Kapanış", reportedEndValue: 999,
      movements: [{ key: "in", label: "Gelir", value: 500 }],
    });
    expect(out.reconciles).toBe(false);
    expect(out.difference).toBe(-501);
  });

  it("returns null reconciliation when no end value was reported", () => {
    const out = cashBridge({
      startLabel: "A", startValue: 0, endLabel: "B", reportedEndValue: null,
      movements: [{ key: "m", label: "M", value: 10 }],
    });
    expect(out.reconciles).toBeNull();
  });

  it("excludes unknown movements and counts them", () => {
    const out = cashBridge({
      startLabel: "A", startValue: 100, endLabel: "B", reportedEndValue: null,
      movements: [{ key: "m", label: "M", value: null }, { key: "n", label: "N", value: 50 }],
    });
    expect(out.unknownCount).toBe(1);
    expect(out.computedEnd).toBe(150);
  });

  it("does not fail reconciliation over a floating-point tail", () => {
    const out = cashBridge({
      startLabel: "A", startValue: 0.1, endLabel: "B", reportedEndValue: 0.3,
      movements: [{ key: "m", label: "M", value: 0.2 }],
    });
    expect(out.reconciles).toBe(true);
  });

  it("an UNKNOWN start makes the bridge unmeasurable — it is not anchored at 0 (Wave 0, R10)", () => {
    // Anchored at 0, this bridge would end at 500, compare it with the reported 1500 and print a
    // fabricated "HAYIR, 1.000 TL fark" — a difference the ledger does not have.
    const out = cashBridge({
      startLabel: "2026-05 açılış", startValue: null, endLabel: "B", reportedEndValue: 1500,
      movements: [{ key: "in", label: "Gelir", value: 500 }, { key: "out", label: "Gider", value: null }],
    });
    expect(out.rows).toEqual([]);
    expect(out.computedEnd).toBeNull();
    expect(out.reconciles).toBeNull();
    expect(out.difference).toBeNull();
    expect(out.unmeasurableReason).toContain("2026-05 açılış bilinmiyor");
    expect(out.unknownCount).toBe(1);
  });

  it("no start and no movements is 'no data', not a 0 → 0 bridge", () => {
    const out = cashBridge({
      startLabel: "A", startValue: null, endLabel: "B", reportedEndValue: null, movements: [],
    });
    expect(out.rows).toEqual([]);
    expect(out.computedEnd).toBeNull();
    expect(out.unmeasurableReason).toBe("Köprü için veri yok.");
  });

  it("an explicit 0 start is a real anchor (zero is not unknown)", () => {
    const out = cashBridge({
      startLabel: "A", startValue: 0, endLabel: "B", reportedEndValue: 10,
      movements: [{ key: "m", label: "M", value: 10 }],
    });
    expect(out.unmeasurableReason).toBeNull();
    expect(out.computedEnd).toBe(10);
    expect(out.reconciles).toBe(true);
  });
});

describe("ageingDistribution", () => {
  const asOf = "2026-03-31";

  it("buckets by how overdue an item is", () => {
    const out = ageingDistribution([
      { dueDate: "2026-04-30", amount: 100 },  // not yet due
      { dueDate: "2026-03-15", amount: 200 },  // 16 days
      { dueDate: "2026-01-31", amount: 300 },  // 59 days
      { dueDate: "2025-06-01", amount: 400 },  // 90+
    ], asOf);
    const by = Object.fromEntries(out.rows.map((r) => [r.bucketKey, r.amount]));
    expect(by.current).toBe(100);
    expect(by.d1_30).toBe(200);
    expect(by.d31_60).toBe(300);
    expect(by.d90_plus).toBe(400);
  });

  it("EXCLUDES items with no due date rather than calling them current", () => {
    // Assuming a missing due date means "not yet due" is the optimistic reading of missing data.
    const out = ageingDistribution([
      { dueDate: null, amount: 500 },
      { dueDate: "2026-03-15", amount: 100 },
    ], asOf);
    expect(out.unknownCount).toBe(1);
    expect(out.rows.find((r) => r.bucketKey === "current")?.amount).toBe(0);
  });

  it("shares add to 1 when there is any amount", () => {
    const out = ageingDistribution([
      { dueDate: "2026-03-15", amount: 100 },
      { dueDate: "2025-06-01", amount: 300 },
    ], asOf);
    expect(out.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 9);
  });

  it("is unmeasurable with no usable items", () => {
    expect(ageingDistribution([{ dueDate: null, amount: null }], asOf).unmeasurableReason).not.toBeNull();
  });
});

describe("formatMetric", () => {
  it("renders unknown as a dash, never as zero", () => {
    expect(formatMetric(null, "currency")).toBe("—");
    expect(formatMetric(null, "days")).toBe("—");
    expect(formatMetric(0, "currency")).not.toBe("—");
  });

  it("formats each unit distinctly", () => {
    expect(formatMetric(0.15, "percent")).toContain("%");
    expect(formatMetric(42, "days")).toContain("gün");
    expect(formatMetric(1000, "currency")).toContain("TL");
  });
});
