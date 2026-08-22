import { describe, expect, it } from "vitest";
import {
  FACILITY_STATUSES, FACILITY_STATUS_LABEL, FACILITY_TRANSITIONS, FACILITY_TYPES,
  FACILITY_TYPE_LABEL, MATURITY_BUCKETS, bucketExposure, canTransition, maturityBucket,
  signedMovement, utilization,
} from "./facilities";

describe("facility transitions mirror the database guard", () => {
  it("allows exactly the eight documented moves", () => {
    const allowed = new Set(FACILITY_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    expect(allowed).toEqual(new Set([
      "active>suspended", "active>expired", "active>closed",
      "suspended>active", "suspended>expired", "suspended>closed",
      "expired>active", "expired>closed",
    ]));
  });

  it("lets a suspended facility still age into expiry", () => {
    // Without this every frozen line is stranded as 'suspended' once its term passes.
    expect(canTransition("suspended", "expired")).toBe(true);
  });

  it("allows renewal of an expired facility", () => {
    // Forcing a new row instead would detach the facility from its own drawdown history.
    expect(canTransition("expired", "active")).toBe(true);
  });

  it("treats closed as terminal", () => {
    for (const to of FACILITY_STATUSES) {
      if (to !== "closed") expect(canTransition("closed", to), `closed>${to}`).toBe(false);
    }
  });

  it("refuses to freeze something that already lapsed", () => {
    expect(canTransition("expired", "suspended")).toBe(false);
  });

  it("refuses exactly four of the twelve ordered pairs", () => {
    const allowed = new Set(FACILITY_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    let refused = 0;
    for (const from of FACILITY_STATUSES) {
      for (const to of FACILITY_STATUSES) {
        if (from === to) continue;
        if (!allowed.has(`${from}>${to}`)) {
          expect(canTransition(from, to)).toBe(false);
          refused += 1;
        }
      }
    }
    expect(refused).toBe(4);
  });

  it("treats same-status as a no-op, not a transition", () => {
    for (const s of FACILITY_STATUSES) expect(canTransition(s, s)).toBe(true);
  });
});

describe("utilization", () => {
  it("computes drawn and available from movements", () => {
    const u = utilization(1_000_000, [500_000, -200_000]);
    expect(u.drawnAmount).toBe(300_000);
    expect(u.availableAmount).toBe(700_000);
    expect(u.overLimit).toBe(false);
  });

  it("floors available at zero and reports the breach separately", () => {
    // A negative headroom flowing into a treasury total would reduce group liquidity by the size
    // of somebody's overdraft — the opposite of what over-limit means.
    const u = utilization(100_000, [130_000]);
    expect(u.availableAmount).toBe(0);
    expect(u.overLimit).toBe(true);
    expect(u.drawnAmount).toBe(130_000);
  });

  it("returns a null ratio against a zero limit rather than dividing", () => {
    expect(utilization(0, [0]).utilizationRatio).toBeNull();
  });

  it("reports a fully unused facility as zero drawn, full available", () => {
    const u = utilization(250_000, []);
    expect(u.drawnAmount).toBe(0);
    expect(u.availableAmount).toBe(250_000);
    expect(u.utilizationRatio).toBe(0);
  });

  it("sums many movements in decimal without drift", () => {
    const moves = Array.from({ length: 300 }, () => "0.01");
    expect(utilization(100, moves).drawnAmount).toBe(3);
  });
});

describe("signedMovement", () => {
  it("makes a drawdown consume limit and a repayment return it", () => {
    expect(signedMovement("drawdown", 1000)).toBe(1000);
    expect(signedMovement("repayment", 1000)).toBe(-1000);
  });

  it("never depends on the caller typing a minus sign", () => {
    expect(signedMovement("repayment", "1000.00")).toBe(-1000);
  });
});

describe("maturityBucket", () => {
  it("covers the four ladder buckets the plan specifies", () => {
    expect([...MATURITY_BUCKETS]).toEqual([30, 90, 180, 365]);
  });

  it("places dates in the right bucket at the boundaries", () => {
    expect(maturityBucket("2099-01-01", "2099-01-01")).toBe(30);   // today
    expect(maturityBucket("2099-01-30", "2099-01-01")).toBe(30);   // day 29
    expect(maturityBucket("2099-01-31", "2099-01-01")).toBe(90);   // day 30 -> next bucket
    expect(maturityBucket("2099-04-01", "2099-01-01")).toBe(180);  // day 90
    expect(maturityBucket("2099-06-30", "2099-01-01")).toBe(365);  // day 180
  });

  it("returns null for an already-due date — that is overdue reporting, not a ladder", () => {
    expect(maturityBucket("2098-12-31", "2099-01-01")).toBeNull();
  });

  it("returns null beyond a year", () => {
    expect(maturityBucket("2100-06-01", "2099-01-01")).toBeNull();
  });
});

describe("bucketExposure — unused limit is not an outflow", () => {
  it("adds instalments to only the DRAWN part of expiring facilities", () => {
    // A limit that expires unused costs nothing; it simply stops being available.
    expect(bucketExposure(50_000, 20_000)).toBe(70_000);
  });

  it("treats unknown components as zero contribution, not as unknown totals", () => {
    expect(bucketExposure(50_000, null)).toBe(50_000);
  });
});

describe("labels", () => {
  it("names every status and type in Turkish", () => {
    for (const s of FACILITY_STATUSES) expect(FACILITY_STATUS_LABEL[s].length).toBeGreaterThan(0);
    for (const t of FACILITY_TYPES) expect(FACILITY_TYPE_LABEL[t].length).toBeGreaterThan(0);
  });
});
