import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_LABEL, TREASURY_HORIZON_DAYS, addDays, bufferDaysFloor, daysBetween,
  effectiveFloor, liquidityHorizons, monthlyProjection, nextMonth, reconciliationVerdict,
  type DatedFlow,
} from "./rules";
import { buildProjection, type CashMonth } from "@/lib/radar/rules";

const flow = (flowDate: string, amountSigned: number, certainty: DatedFlow["certainty"] = "contracted"): DatedFlow =>
  ({ flowDate, amountSigned, certainty });

describe("date helpers", () => {
  it("adds days across a month boundary", () => {
    expect(addDays("2099-01-30", 3)).toBe("2099-02-02");
  });
  it("counts days between dates", () => {
    expect(daysBetween("2099-01-01", "2099-01-08")).toBe(7);
  });
  it("delegates month arithmetic to the Faz 5 rules", () => {
    expect(nextMonth("2099-01-01")).toBe("2099-02-01");
  });
});

describe("liquidityHorizons — the window boundary", () => {
  const base = {
    openingPosition: 1000,
    todayISO: "2099-03-01",
    flows: [
      flow("2099-03-01", -100),  // today: included
      flow("2099-03-07", -50),   // day 6: inside the 7-day window
      flow("2099-03-08", -25),   // day 7: OUTSIDE 7, inside 30
    ],
  };

  it("includes a flow dated today — money moving this morning is today's liquidity", () => {
    const [h7] = liquidityHorizons({ ...base, horizons: [7] });
    expect(h7.contractedNet).toBe(-150);
  });

  it("is half-open: a flow exactly N days out belongs to the NEXT horizon, never both", () => {
    const [h7, h30] = liquidityHorizons({ ...base, horizons: [7, 30] });
    expect(h7.contractedNet).toBe(-150);   // today + day 6
    expect(h30.contractedNet).toBe(-175);  // plus day 7
    // The day-7 row must not have been counted twice.
    expect(h30.contractedNet - h7.contractedNet).toBe(-25);
  });

  it("returns the three treasury horizons by default", () => {
    const rows = liquidityHorizons(base);
    expect(rows.map((r) => r.horizonDays)).toEqual([...TREASURY_HORIZON_DAYS]);
  });
});

describe("liquidityHorizons — contracted vs expected are never blended", () => {
  const rows = liquidityHorizons({
    openingPosition: 0,
    todayISO: "2099-03-01",
    horizons: [30],
    flows: [flow("2099-03-05", -1000), flow("2099-03-06", 400, "expected")],
  });

  it("keeps the conservative and optimistic projections separate", () => {
    expect(rows[0].contractedNet).toBe(-1000);
    expect(rows[0].expectedNet).toBe(-600);
    expect(rows[0].projectedContracted).toBe(-1000);
    expect(rows[0].projectedExpected).toBe(-600);
  });

  it("judges the floor on the CONTRACTED figure — a promise must not clear an alarm", () => {
    // Believing the promise would make this look like a smaller breach than it is.
    expect(rows[0].breachesFloor).toBe(true);
    expect(rows[0].financingNeed).toBe(1000);
  });
});

describe("financingNeed", () => {
  it("is zero, never negative, when the floor is cleared", () => {
    const [h] = liquidityHorizons({
      openingPosition: 5000, todayISO: "2099-03-01", horizons: [30],
      flows: [], minCashFloor: 1000,
    });
    expect(h.financingNeed).toBe(0);
    expect(h.breachesFloor).toBe(false);
  });

  it("is the exact shortfall when breached", () => {
    const [h] = liquidityHorizons({
      openingPosition: 500, todayISO: "2099-03-01", horizons: [30],
      flows: [flow("2099-03-02", -200)], minCashFloor: 1000,
    });
    expect(h.projectedContracted).toBe(300);
    expect(h.financingNeed).toBe(700);
  });

  it("treats a zero floor as a real floor, not as 'unset'", () => {
    const [h] = liquidityHorizons({
      openingPosition: 0, todayISO: "2099-03-01", horizons: [7],
      flows: [flow("2099-03-02", -1)], minCashFloor: 0,
    });
    expect(h.breachesFloor).toBe(true);
    expect(h.financingNeed).toBe(1);
  });
});

describe("money is summed in decimal, not float", () => {
  it("sums many kuruş amounts without drift", () => {
    // 300 rows of 0.01 is exactly 3.00; float accumulation lands on 3.0000000000000013.
    const flows = Array.from({ length: 300 }, () => flow("2099-03-02", 0.01));
    const [h] = liquidityHorizons({
      openingPosition: 0, todayISO: "2099-03-01", horizons: [30], flows,
    });
    expect(h.contractedNet).toBe(3);
  });

  it("keeps an exact opening position from a numeric string", () => {
    const [h] = liquidityHorizons({
      openingPosition: "99999.99", todayISO: "2099-03-01", horizons: [7], flows: [],
    });
    expect(h.openingPosition).toBe(99999.99);
  });
});

describe("bufferDaysFloor — null means 'cannot compute', not 'no buffer needed'", () => {
  it("is null when the policy is not configured", () => {
    expect(bufferDaysFloor(1000, null)).toBeNull();
    expect(bufferDaysFloor(1000, 0)).toBeNull();
  });

  it("is null when there is no outflow history", () => {
    // Defaulting to 0 here would read as "no buffer required", the more dangerous answer.
    expect(bufferDaysFloor(0, 30)).toBeNull();
    expect(bufferDaysFloor(null, 30)).toBeNull();
  });

  it("multiplies average daily outflow by the day count", () => {
    expect(bufferDaysFloor(1500, 30)).toBe(45000);
  });

  it("uses the magnitude of an outflow given as negative", () => {
    expect(bufferDaysFloor(-1500, 30)).toBe(45000);
  });
});

describe("effectiveFloor", () => {
  it("takes the higher of two active floors — both are minimums", () => {
    expect(effectiveFloor(10000, 45000)).toBe(45000);
    expect(effectiveFloor(90000, 45000)).toBe(90000);
  });

  it("falls back to whichever is configured", () => {
    expect(effectiveFloor(null, 45000)).toBe(45000);
    expect(effectiveFloor(10000, null)).toBe(10000);
  });

  it("is null when neither is configured — not zero", () => {
    expect(effectiveFloor(null, null)).toBeNull();
  });
});

describe("reconciliationVerdict — reports, never reconciles", () => {
  it("calls a match aligned", () => {
    expect(reconciliationVerdict(1000, 1000)).toEqual({ status: "aligned", difference: 0 });
  });

  it("tolerates a rounding kuruş, matching findContinuityIssues' 1 TL allowance", () => {
    expect(reconciliationVerdict(1000, 1000.99).status).toBe("aligned");
    expect(reconciliationVerdict(1000, 1001.01).status).toBe("divergent");
  });

  it("reports the signed difference rather than hiding it", () => {
    const v = reconciliationVerdict(1000, 1500);
    expect(v.status).toBe("divergent");
    expect(v.difference).toBe(500);
  });

  it("never silently substitutes one source for the other", () => {
    // A missing side is named, not filled in from the other.
    expect(reconciliationVerdict(null, 1500)).toEqual({ status: "cashflow_missing", difference: null });
    expect(reconciliationVerdict(1000, null)).toEqual({ status: "no_bank_movement", difference: null });
  });

  it("labels every status in Turkish", () => {
    for (const s of ["aligned", "divergent", "cashflow_missing", "no_bank_movement"] as const) {
      expect(RECONCILIATION_LABEL[s].length).toBeGreaterThan(0);
    }
  });
});

describe("this module EXTENDS the Faz 5 forecast rather than replacing it", () => {
  const months: CashMonth[] = [
    { monthStart: "2099-01-01", opening: 1000, income: 500, expense: 800, closing: 700 },
    { monthStart: "2099-02-01", opening: 700, income: 200, expense: 1200, closing: -300 },
  ];

  it("returns exactly what buildProjection returns — no forked implementation", () => {
    expect(monthlyProjection(months)).toEqual(buildProjection(months));
  });

  it("still finds the first negative month through the Faz 5 rule", () => {
    expect(monthlyProjection(months).firstNegativeMonth).toBe("2099-02-01");
  });
});
