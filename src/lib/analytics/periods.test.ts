import { describe, expect, it } from "vitest";
import { compoundGrowth, periodOverPeriod, rollingWindow, shiftMonth } from "./periods";

const days = (from: string, values: (number | null)[]) =>
  values.map((value, i) => ({
    key: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
    value,
  }));

describe("rollingWindow", () => {
  it("sums a trailing window", () => {
    const out = rollingWindow(days("2026-01-01", [1, 2, 3, 4, 5]), 7, "sum");
    expect(out[4].value).toBe(15);
    expect(out[2].value).toBe(6);
  });

  it("marks points whose window is not yet full instead of hiding them", () => {
    // The first 6 points of a 7-day window cover fewer than 7 days and are systematically lower;
    // drawing them like the rest invents a rising trend.
    const out = rollingWindow(days("2026-01-01", [1, 1, 1, 1, 1, 1, 1, 1]), 7, "sum");
    expect(out.slice(0, 6).every((p) => p.partial)).toBe(true);
    expect(out[6].partial).toBe(false);
    expect(out[7].partial).toBe(false);
  });

  it("treats unknown values as unknown, never as zero", () => {
    const out = rollingWindow(days("2026-01-01", [10, null, 20]), 7, "sum");
    expect(out[2].value).toBe(30);       // not 30 spread over 3 — the null is excluded
    expect(out[2].knownCount).toBe(2);
    expect(out[2].unknownCount).toBe(1);
  });

  it("returns null — not 0 — when the whole window is unknown", () => {
    const out = rollingWindow(days("2026-01-01", [null, null]), 7, "sum");
    expect(out[1].value).toBeNull();
    expect(out[1].unknownCount).toBe(2);
  });

  it("averages levels rather than summing them when asked", () => {
    const out = rollingWindow(days("2026-01-01", [10, 20, 30]), 7, "average");
    expect(out[2].value).toBe(20);
  });

  it("ignores non-day keys so a monthly series cannot be rolled by day", () => {
    expect(rollingWindow([{ key: "2026-01", value: 5 }], 7)).toEqual([]);
  });

  it("is order-independent — unsorted input gives the same answer", () => {
    const asc = days("2026-01-01", [1, 2, 3]);
    const shuffled = [asc[2], asc[0], asc[1]];
    expect(rollingWindow(shuffled, 7)).toEqual(rollingWindow(asc, 7));
  });
});

describe("shiftMonth", () => {
  it("crosses year boundaries in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-03", -12)).toBe("2025-03");
  });
});

describe("periodOverPeriod", () => {
  const series = [
    { key: "2025-11", value: 100 },
    { key: "2025-12", value: 150 },
    { key: "2026-01", value: 120 },
  ];

  it("computes month-over-month change", () => {
    const out = periodOverPeriod(series, "mom");
    const jan = out.find((r) => r.key === "2026-01");
    expect(jan?.previous).toBe(150);
    expect(jan?.delta).toBe(-30);
    expect(jan?.changeRatio).toBeCloseTo(-0.2, 6);
  });

  it("reports UNKNOWN rather than -100% when the previous period is missing", () => {
    // The trap: treating an absent period as zero turns "we have no data" into "revenue vanished".
    const out = periodOverPeriod(series, "yoy");
    const jan = out.find((r) => r.key === "2026-01");
    expect(jan?.changeRatio).toBeNull();
    expect(jan?.unmeasurableReason).toBe("previous_missing");
  });

  it("refuses to divide by a zero base", () => {
    const out = periodOverPeriod([{ key: "2026-01", value: 0 }, { key: "2026-02", value: 50 }], "mom");
    const feb = out.find((r) => r.key === "2026-02");
    expect(feb?.changeRatio).toBeNull();
    expect(feb?.unmeasurableReason).toBe("previous_zero");
  });

  it("looks the previous period up BY KEY, not by array position", () => {
    // With a gap, position-counting would compare March against December and call it "last month".
    const gapped = [{ key: "2025-12", value: 10 }, { key: "2026-03", value: 20 }];
    const out = periodOverPeriod(gapped, "mom");
    const march = out.find((r) => r.key === "2026-03");
    expect(march?.unmeasurableReason).toBe("previous_missing");
  });

  it("handles a negative base by magnitude", () => {
    const out = periodOverPeriod([{ key: "2026-01", value: -100 }, { key: "2026-02", value: -50 }], "mom");
    expect(out.find((r) => r.key === "2026-02")?.changeRatio).toBeCloseTo(0.5, 6);
  });

  it("marks a missing current value as unmeasurable", () => {
    const out = periodOverPeriod([{ key: "2026-01", value: 10 }, { key: "2026-02", value: null }], "mom");
    expect(out.find((r) => r.key === "2026-02")?.unmeasurableReason).toBe("current_missing");
  });
});

describe("compoundGrowth", () => {
  it("computes a monthly compound rate", () => {
    const out = compoundGrowth([{ key: "2026-01", value: 100 }, { key: "2026-03", value: 121 }]);
    expect(out.months).toBe(2);
    expect(out.ratePerMonth).toBeCloseTo(0.1, 6);
  });

  it("refuses a non-positive base instead of returning a number", () => {
    expect(compoundGrowth([{ key: "2026-01", value: 0 }, { key: "2026-02", value: 5 }]).ratePerMonth).toBeNull();
    expect(compoundGrowth([{ key: "2026-01", value: -5 }, { key: "2026-02", value: 5 }]).ratePerMonth).toBeNull();
  });

  it("needs two known points", () => {
    expect(compoundGrowth([{ key: "2026-01", value: 100 }]).ratePerMonth).toBeNull();
  });
});
