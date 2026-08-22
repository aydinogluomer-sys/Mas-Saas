import { describe, expect, it } from "vitest";
import {
  ALLOCATION_BASES, BASIS_LABEL, COST_KINDS, COST_KIND_LABEL, CYCLE_VERDICT_LABEL,
  allocate, allocationTotal, cashCycle, cycleVerdict, dpo, dso, profitability,
} from "./rules";
import { partProfitability } from "@/lib/production/rules";

describe("profitability follows the production/rules.ts template", () => {
  it("computes margin and rate when both sides are known", () => {
    const p = profitability(1000, 600);
    expect(p.margin).toBe(400);
    expect(p.marginRate).toBeCloseTo(0.4, 10);
    expect(p.confidence).toBe("estimated");
  });

  it("returns NULL margin when the cost is unknown — never 0", () => {
    // A margin of 0 would be indistinguishable from a genuine break-even.
    const p = profitability(1000, null);
    expect(p.margin).toBeNull();
    expect(p.marginRate).toBeNull();
    expect(p.confidence).toBe("needs_review");
  });

  it("returns NULL margin when the revenue is unknown", () => {
    expect(profitability(null, 600).margin).toBeNull();
    expect(profitability(null, 600).confidence).toBe("needs_review");
  });

  it("keeps a real negative margin on ZERO revenue but no rate", () => {
    // Spent money, sold nothing: the margin is a real number, only the percentage is undefined.
    const p = profitability(0, 600);
    expect(p.margin).toBe(-600);
    expect(p.marginRate).toBeNull();
    expect(p.confidence).toBe("estimated");
  });

  it("agrees with partProfitability on the same numbers", () => {
    // The template it was copied from: revenue 1000, cost 600 via one operation.
    const part = partProfitability(
      { code: null, name: "x", quantity: 1, tornaMinutesPerUnit: 60, frezeMinutesPerUnit: null, revenue: 1000 },
      10, null,
    );
    const mine = profitability(1000, part.estimatedTotalCost);
    expect(part.estimatedTotalCost).toBe(600);
    expect(mine.margin).toBe(part.estimatedMargin);
    expect(mine.marginRate).toBeCloseTo(part.marginRate!, 10);
  });

  it("computes in decimal, not float", () => {
    // 1000.10 − 1000.00 is exactly 0.10; float subtraction lands on 0.09999999999990905.
    expect(profitability("1000.10", "1000.00").margin).toBe(0.1);
  });
});

describe("allocate — the kuruş must not vanish", () => {
  const three = [
    { id: "a", label: "A", driver: 1 },
    { id: "b", label: "B", driver: 1 },
    { id: "c", label: "C", driver: 1 },
  ];

  it("splits exactly, with the remainder given to the largest share", () => {
    // 100,00 / 3 = 33,33 each and 33,33 × 3 = 99,99 — one kuruş has to land somewhere.
    const shares = allocate(100, three);
    expect(allocationTotal(shares)).toBe(100);
    expect(shares.map((s) => s.amount).sort((x, y) => y - x)[0]).toBe(33.34);
  });

  it("sums EXACTLY to the input across many awkward splits", () => {
    for (const total of [100, 0.01, 1, 999.99, 1234.56]) {
      for (const n of [3, 6, 7, 11]) {
        const targets = Array.from({ length: n }, (_, i) => ({
          id: `t${i}`, label: `T${i}`, driver: 1,
        }));
        expect(allocationTotal(allocate(total, targets))).toBe(total);
      }
    }
  });

  it("allocates proportionally to the driver", () => {
    const shares = allocate(1000, [
      { id: "big", label: "Big", driver: 3 },
      { id: "small", label: "Small", driver: 1 },
    ]);
    expect(shares.find((s) => s.id === "big")?.amount).toBe(750);
    expect(shares.find((s) => s.id === "small")?.amount).toBe(250);
  });

  it("is deterministic and independent of input order", () => {
    const a = allocate(100, three).map((s) => `${s.id}:${s.amount}`).join("|");
    const b = allocate(100, [...three].reverse()).map((s) => `${s.id}:${s.amount}`).join("|");
    expect(a).toBe(b);
  });

  it("breaks equal-driver ties by id, so the remainder lands predictably", () => {
    expect(allocate(100, three)[0].id).toBe("a");
  });

  it("returns nothing rather than dividing by zero", () => {
    expect(allocate(100, [{ id: "a", label: "A", driver: 0 }])).toEqual([]);
    expect(allocate(100, [])).toEqual([]);
  });

  it("returns nothing when the cost itself is unknown", () => {
    expect(allocate(null, three)).toEqual([]);
  });

  it("treats an unknown driver as zero contribution, not as a blocked allocation", () => {
    const shares = allocate(100, [
      { id: "a", label: "A", driver: null },
      { id: "b", label: "B", driver: 1 },
    ]);
    expect(shares.find((s) => s.id === "b")?.amount).toBe(100);
    expect(allocationTotal(shares)).toBe(100);
  });
});

describe("DSO / DPO", () => {
  it("computes days from a balance and an annual flow", () => {
    // 100.000 open against 365.000 annual sales = 1.000/day = 100 days.
    expect(dso(100000, 365000)).toBe(100);
    expect(dpo(50000, 365000)).toBe(50);
  });

  it("returns NULL on a zero denominator — never 0, never infinity", () => {
    // A DSO of 0 would read as "customers pay instantly"; the truth is "we have no sales history".
    expect(dso(100000, 0)).toBeNull();
    expect(dpo(100000, 0)).toBeNull();
  });

  it("returns NULL when either side is unknown", () => {
    expect(dso(null, 365000)).toBeNull();
    expect(dso(100000, null)).toBeNull();
  });

  it("returns 0 days for a zero balance, which IS measured", () => {
    expect(dso(0, 365000)).toBe(0);
  });
});

describe("cashCycle — DIO is unknown in this system and is not faked", () => {
  it("returns NULL CCC when DIO is unknown, with a named reason", () => {
    const c = cashCycle(60, null, 30);
    expect(c.cashConversionCycleDays).toBeNull();
    expect(c.unmeasurableReason).toBe("dio_unknown");
  });

  it("still offers the computable part, named for what it excludes", () => {
    // Treating DIO as 0 would shorten the cycle by exactly the days material is held, making
    // working capital look BETTER than reality.
    expect(cashCycle(60, null, 30).cycleExcludingInventory).toBe(30);
  });

  it("computes a real CCC when all three terms are known", () => {
    const c = cashCycle(60, 20, 30);
    expect(c.cashConversionCycleDays).toBe(50);
    expect(c.unmeasurableReason).toBeNull();
  });

  it("names which term was missing", () => {
    expect(cashCycle(null, 20, 30).unmeasurableReason).toBe("dso_unknown");
    expect(cashCycle(60, 20, null).unmeasurableReason).toBe("dpo_unknown");
  });

  it("leaves the excluding-inventory figure NULL when DSO or DPO is missing", () => {
    expect(cashCycle(null, 20, 30).cycleExcludingInventory).toBeNull();
    expect(cashCycle(60, 20, null).cycleExcludingInventory).toBeNull();
  });
});

describe("cycleVerdict", () => {
  it("bands the cycle deterministically, longer being worse", () => {
    expect(cycleVerdict(-5)).toBe("strong");
    expect(cycleVerdict(0)).toBe("strong");
    expect(cycleVerdict(45)).toBe("normal");
    expect(cycleVerdict(46)).toBe("stretched");
  });

  it("says unknown rather than guessing", () => {
    expect(cycleVerdict(null)).toBe("unknown");
    expect(CYCLE_VERDICT_LABEL.unknown.length).toBeGreaterThan(0);
  });
});

describe("registries", () => {
  it("covers the five cost kinds the plan names", () => {
    expect([...COST_KINDS]).toEqual(["common", "machine", "personnel", "energy", "project"]);
    for (const k of COST_KINDS) expect(COST_KIND_LABEL[k].length).toBeGreaterThan(0);
  });

  it("labels every allocation basis", () => {
    for (const b of ALLOCATION_BASES) expect(BASIS_LABEL[b].length).toBeGreaterThan(0);
  });
});
