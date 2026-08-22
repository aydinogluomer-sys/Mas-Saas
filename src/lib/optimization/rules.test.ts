import { describe, expect, it } from "vitest";
import {
  ACTION_KINDS, OBJECTIVES, RULE_CODES, RULE_LABEL,
  addDays, optimize, projectBalances, resultDigest,
  type OptimizationInput, type PaymentCandidate,
} from "./rules";

const pay = (
  id: string, dueDate: string, amount: number, hardDeadline = false, latestDate?: string,
): PaymentCandidate => ({ id, label: `P ${id}`, dueDate, amount, hardDeadline, latestDate });

const base: OptimizationInput = {
  objective: "max_liquidity_buffer",
  anchorDate: "2099-01-01",
  horizonDays: 10,
  openingCash: 1000,
  minCashFloor: 0,
  inflows: [],
  payments: [],
  facilities: [],
};

describe("projectBalances", () => {
  it("applies inflows and payments on their dates", () => {
    const s = projectBalances({
      anchorDate: "2099-01-01", horizonDays: 3, openingCash: 100,
      inflows: [{ date: "2099-01-02", amount: 50 }],
      payments: [{ dueDate: "2099-01-03", amount: 30 }],
    });
    expect(s.map((x) => x.balance)).toEqual([100, 150, 120]);
  });

  it("accumulates in decimal, not float", () => {
    const s = projectBalances({
      anchorDate: "2099-01-01", horizonDays: 1, openingCash: "0.10",
      inflows: [{ date: "2099-01-01", amount: 0.2 }], payments: [],
    });
    expect(s[0].balance).toBe(0.3);
  });
});

describe("the solver never proposes moving a hard deadline", () => {
  const input: OptimizationInput = {
    ...base,
    openingCash: 100,
    payments: [pay("a", "2099-01-02", 500, true)],
  };

  it("does not emit a defer_payment for a hard-deadline payment", () => {
    const r = optimize(input);
    const defers = r.recommendations.filter((x) => x.actionKind === "defer_payment");
    expect(defers).toHaveLength(0);
  });

  it("names WHY it could not be moved instead of staying silent", () => {
    const r = optimize(input);
    expect(r.recommendations.some((x) => x.rationaleCodes.includes("sert_vade_ertelenemez"))).toBe(true);
  });
});

describe("deferral", () => {
  const input: OptimizationInput = {
    ...base,
    openingCash: 100,
    minCashFloor: 0,
    payments: [pay("a", "2099-01-02", 500)],
    inflows: [{ date: "2099-01-05", amount: 900 }],
  };

  it("defers to the first date the payment is actually AFFORDABLE, not merely past the breach", () => {
    // Opening 100, payment 500 on 01-02, inflow 900 on 01-05, floor 0.
    // Moving it to 01-03 would leave the balance at -400 and fix nothing; 01-05 is the first day
    // the balance carries it above the floor. An earlier version of the solver moved payments one
    // day past the breach and a test caught that it changed the worst balance not at all.
    const r = optimize(input);
    const d = r.recommendations.find((x) => x.actionKind === "defer_payment");
    expect(d).toBeDefined();
    expect(d?.currentDate).toBe("2099-01-02");
    expect(d?.proposedDate).toBe("2099-01-05");
    expect(d?.rationaleCodes).toEqual(["nakit_tabani_ihlali", "ertelenebilir_odeme"]);
  });

  it("leaves the floor intact after the move it proposes", () => {
    const r = optimize(input);
    expect(r.worstBalanceAfter).toBeGreaterThanOrEqual(input.minCashFloor);
  });

  it("always moves a deferral LATER, never earlier", () => {
    const r = optimize(input);
    for (const rec of r.recommendations.filter((x) => x.actionKind === "defer_payment")) {
      expect(rec.proposedDate! > rec.currentDate!).toBe(true);
    }
  });

  it("respects a payment's latest allowed date", () => {
    const r = optimize({
      ...input,
      payments: [pay("a", "2099-01-02", 500, false, "2099-01-02")],
    });
    // The only candidate cannot move, so timing cannot fix it.
    expect(r.recommendations.filter((x) => x.actionKind === "defer_payment")).toHaveLength(0);
  });

  it("improves the projected worst balance when it defers", () => {
    const r = optimize(input);
    expect(r.worstBalanceBefore).toBeLessThan(0);
    expect(r.worstBalanceAfter).toBeGreaterThan(r.worstBalanceBefore);
  });
});

describe("facility drawing", () => {
  const input: OptimizationInput = {
    ...base,
    openingCash: 100,
    payments: [pay("a", "2099-01-02", 500, true)],
    facilities: [
      { id: "f-expensive", label: "Pahalı", available: 1000, interestRate: 0.6 },
      { id: "f-cheap", label: "Ucuz", available: 1000, interestRate: 0.4 },
    ],
  };

  it("draws on the CHEAPEST facility with headroom", () => {
    const r = optimize(input);
    const draw = r.recommendations.find((x) => x.actionKind === "draw_facility");
    expect(draw?.subjectId).toBe("f-cheap");
  });

  it("sorts an unknown rate LAST — an unknown price is not evidence of a good one", () => {
    const r = optimize({
      ...input,
      facilities: [
        { id: "f-unknown", label: "Bilinmiyor", available: 1000, interestRate: null },
        { id: "f-known", label: "Bilinen", available: 1000, interestRate: 0.9 },
      ],
    });
    expect(r.recommendations.find((x) => x.actionKind === "draw_facility")?.subjectId).toBe("f-known");
  });

  it("reports an unclosable gap instead of looking solved", () => {
    const r = optimize({
      ...input,
      facilities: [{ id: "f", label: "Küçük", available: 10, interestRate: 0.4 }],
    });
    expect(r.recommendations.some((x) => x.rationaleCodes.includes("limit_yetersiz"))).toBe(true);
  });

  it("never draws more than the available headroom", () => {
    const r = optimize({
      ...input,
      facilities: [{ id: "f", label: "Küçük", available: 10, interestRate: 0.4 }],
    });
    const draw = r.recommendations.find((x) => x.actionKind === "draw_facility");
    expect(draw?.amount).toBeLessThanOrEqual(10);
  });
});

describe("repayment when cash is idle", () => {
  it("suggests repaying only the amount that keeps the floor intact", () => {
    const r = optimize({
      ...base, openingCash: 5000, minCashFloor: 1000, drawnAmount: 10000,
    });
    const rep = r.recommendations.find((x) => x.actionKind === "repay_facility");
    expect(rep?.amount).toBe(4000);
    expect(rep?.rationaleCodes).toContain("fazla_nakit_geri_odeme");
  });

  it("suggests nothing when there is no drawn balance", () => {
    const r = optimize({ ...base, openingCash: 5000, minCashFloor: 1000 });
    expect(r.recommendations).toHaveLength(0);
  });

  it("never repays below the floor", () => {
    const r = optimize({ ...base, openingCash: 1000, minCashFloor: 1000, drawnAmount: 5000 });
    expect(r.recommendations.filter((x) => x.actionKind === "repay_facility")).toHaveLength(0);
  });
});

describe("determinism — the property the run digest depends on", () => {
  const input: OptimizationInput = {
    ...base,
    openingCash: 100,
    payments: [
      // Two payments with the SAME amount: only the id tiebreak can order them.
      pay("b-second", "2099-01-02", 300),
      pay("a-first", "2099-01-02", 300),
    ],
    inflows: [{ date: "2099-01-06", amount: 900 }],
  };

  it("produces byte-identical output across repeated runs", () => {
    const a = resultDigest(optimize(input));
    const b = resultDigest(optimize(input));
    expect(a).toBe(b);
  });

  it("does NOT depend on the order the inputs were given in", () => {
    // Without a total order in the comparator, reversing the input would reorder equal-amount
    // candidates and change the advice while every number still looked right.
    const reversed = { ...input, payments: [...input.payments].reverse() };
    expect(resultDigest(optimize(input))).toBe(resultDigest(optimize(reversed)));
  });

  it("breaks equal-amount ties by id, deterministically", () => {
    const r = optimize(input);
    const first = r.recommendations.find((x) => x.actionKind === "defer_payment");
    expect(first?.subjectId).toBe("a-first");
  });

  it("changes the digest when the advice actually changes", () => {
    const other = optimize({ ...input, openingCash: 100000 });
    expect(resultDigest(other)).not.toBe(resultDigest(optimize(input)));
  });
});

describe("every recommendation is explainable", () => {
  const inputs: OptimizationInput[] = [
    { ...base, openingCash: 100, payments: [pay("a", "2099-01-02", 500)], inflows: [{ date: "2099-01-05", amount: 900 }] },
    { ...base, openingCash: 100, payments: [pay("a", "2099-01-02", 500, true)], facilities: [{ id: "f", label: "F", available: 1000, interestRate: 0.4 }] },
    { ...base, openingCash: 5000, minCashFloor: 1000, drawnAmount: 10000 },
  ];

  it("names at least one rule on every recommendation", () => {
    for (const input of inputs) {
      for (const rec of optimize(input).recommendations) {
        expect(rec.rationaleCodes.length).toBeGreaterThan(0);
      }
    }
  });

  it("only cites rules that exist in the registry", () => {
    for (const input of inputs) {
      for (const rec of optimize(input).recommendations) {
        for (const code of rec.rationaleCodes) {
          expect(RULE_CODES).toContain(code);
          expect(RULE_LABEL[code].length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("only emits known action kinds and ranks them from 1 without gaps", () => {
    for (const input of inputs) {
      const recs = optimize(input).recommendations;
      recs.forEach((rec, i) => {
        expect(ACTION_KINDS).toContain(rec.actionKind);
        expect(rec.rank).toBe(i + 1);
      });
    }
  });

  it("writes a human sentence, not just codes", () => {
    const r = optimize(inputs[0]);
    expect(r.recommendations[0].rationaleNote.length).toBeGreaterThan(20);
  });
});

describe("registry sanity", () => {
  it("covers the three objectives the plan names", () => {
    expect([...OBJECTIVES]).toEqual(["min_financing_cost", "max_liquidity_buffer", "min_late_payment"]);
  });

  it("labels every rule code", () => {
    for (const c of RULE_CODES) expect(RULE_LABEL[c]).toBeDefined();
  });

  it("adds days across a month boundary", () => {
    expect(addDays("2099-01-30", 3)).toBe("2099-02-02");
  });
});
