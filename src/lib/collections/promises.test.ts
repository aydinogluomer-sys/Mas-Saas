import { describe, expect, it } from "vitest";
import {
  BAND_LABEL, PROMISE_STATUSES, PROMISE_TRANSITIONS, SCORE_REASON_LABEL,
  brokenPromiseSeverity, brokenPromiseTitle, canTransition, daysLate, isBroken, keptRatio,
  promiseReminderMessage, scoreBand, type PromiseStatus,
} from "./promises";

describe("isBroken — the boundary is the whole job", () => {
  it("is NOT broken on the promised day itself", () => {
    // The money has the rest of the day to arrive. A job that marked this broken at 09:00 would
    // be recording a failure that has not happened.
    expect(isBroken("pending", "2099-03-15", "2099-03-15")).toBe(false);
  });

  it("is broken the day after", () => {
    expect(isBroken("pending", "2099-03-15", "2099-03-16")).toBe(true);
  });

  it("is not broken while still in the future", () => {
    expect(isBroken("pending", "2099-03-15", "2099-03-01")).toBe(false);
  });

  it("never re-breaks a promise that is already resolved", () => {
    for (const status of ["kept", "broken", "cancelled"] as const) {
      expect(isBroken(status, "2099-03-15", "2099-12-31")).toBe(false);
    }
  });
});

describe("daysLate", () => {
  it("is zero on the day, positive after, negative before", () => {
    expect(daysLate("2099-03-15", "2099-03-15")).toBe(0);
    expect(daysLate("2099-03-15", "2099-03-18")).toBe(3);
    expect(daysLate("2099-03-15", "2099-03-10")).toBe(-5);
  });

  it("counts across a month boundary correctly", () => {
    expect(daysLate("2099-01-30", "2099-02-02")).toBe(3);
  });
});

describe("canTransition mirrors the database guard", () => {
  it("allows exactly the four documented moves", () => {
    const allowed = new Set(PROMISE_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    expect(allowed).toEqual(new Set(["pending>kept", "pending>broken", "pending>cancelled", "broken>kept"]));
  });

  it("allows a late payment to rescue a broken promise", () => {
    // Paying late is the ordinary outcome of a broken promise, not a rare correction.
    expect(canTransition("broken", "kept")).toBe(true);
  });

  it("treats kept and cancelled as terminal", () => {
    for (const to of PROMISE_STATUSES) {
      if (to !== "kept") expect(canTransition("kept", to), `kept>${to}`).toBe(false);
      if (to !== "cancelled") expect(canTransition("cancelled", to), `cancelled>${to}`).toBe(false);
    }
  });

  it("refuses to reopen a broken promise as pending", () => {
    expect(canTransition("broken", "pending")).toBe(false);
    expect(canTransition("broken", "cancelled")).toBe(false);
  });

  it("treats same-status as a no-op rather than a transition", () => {
    for (const s of PROMISE_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it("refuses every pair outside the allow-list", () => {
    const allowed = new Set(PROMISE_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    let refused = 0;
    for (const from of PROMISE_STATUSES) {
      for (const to of PROMISE_STATUSES) {
        if (from === to) continue;
        if (!allowed.has(`${from}>${to}`)) {
          expect(canTransition(from as PromiseStatus, to as PromiseStatus)).toBe(false);
          refused += 1;
        }
      }
    }
    // 4 statuses => 12 ordered pairs, 4 allowed, so 8 must be refused.
    expect(refused).toBe(8);
  });
});

describe("keptRatio", () => {
  it("is null when nothing has resolved — no history is not bad history", () => {
    expect(keptRatio(0, 0)).toBeNull();
  });

  it("ignores cancelled promises by construction (they are never passed in)", () => {
    expect(keptRatio(3, 1)).toBeCloseTo(0.75, 10);
  });

  it("is 0 when every resolved promise broke, which is different from null", () => {
    expect(keptRatio(0, 4)).toBe(0);
  });

  it("is 1 when every promise was kept", () => {
    expect(keptRatio(5, 0)).toBe(1);
  });
});

describe("scoreBand", () => {
  it("uses the same thresholds as the SQL view", () => {
    expect(scoreBand(100)).toBe("good");
    expect(scoreBand(85)).toBe("good");
    expect(scoreBand(84)).toBe("watch");
    expect(scoreBand(60)).toBe("watch");
    expect(scoreBand(59)).toBe("risk");
    expect(scoreBand(35)).toBe("risk");
    expect(scoreBand(34)).toBe("critical");
    expect(scoreBand(0)).toBe("critical");
  });

  it("labels every band in Turkish", () => {
    for (const band of ["good", "watch", "risk", "critical"] as const) {
      expect(BAND_LABEL[band].length).toBeGreaterThan(0);
    }
  });

  it("names every deduction rule the view can emit", () => {
    for (const key of ["gecikmis_fatura_yasi", "suepheli_alacak", "tutulmayan_odeme_sozu", "gec_odeme_aliskanligi"]) {
      expect(SCORE_REASON_LABEL[key]).toBeDefined();
    }
  });
});

describe("brokenPromiseSeverity — an unknown amount is not a small one", () => {
  it("treats a null amount as significant", () => {
    // Could be the largest exposure on the list; downgrading it would hide the biggest problem.
    expect(brokenPromiseSeverity(1, null)).toBe("medium");
    expect(brokenPromiseSeverity(8, null)).toBe("high");
  });

  it("escalates with lateness regardless of size", () => {
    expect(brokenPromiseSeverity(30, 1)).toBe("critical");
    expect(brokenPromiseSeverity(30, null)).toBe("critical");
  });

  it("separates large from small below the 30-day mark", () => {
    expect(brokenPromiseSeverity(8, 5000)).toBe("medium");
    expect(brokenPromiseSeverity(8, 500000)).toBe("high");
  });

  it("compares the threshold in decimal, not float", () => {
    // Exactly 100.000,00 counts as large; a kuruş under does not.
    expect(brokenPromiseSeverity(8, "100000.00")).toBe("high");
    expect(brokenPromiseSeverity(8, "99999.99")).toBe("medium");
  });
});

describe("promiseReminderMessage", () => {
  it("says the amount was not stated rather than claiming zero", () => {
    const msg = promiseReminderMessage({
      partyName: "ACME", promisedAmount: null, currency: "TRY",
      promisedDateISO: "2099-03-15", todayISO: "2099-03-15",
    });
    expect(msg).toContain("tutar belirtilmedi");
    expect(msg).not.toContain("0.00");
  });

  it("reports a known amount exactly, from a numeric string", () => {
    const msg = promiseReminderMessage({
      partyName: "ACME", promisedAmount: "12345.60", currency: "TRY",
      promisedDateISO: "2099-03-15", todayISO: "2099-03-14",
    });
    expect(msg).toContain("12345.60 TRY");
    expect(msg).toContain("1 gün kaldı");
  });

  it("distinguishes due-today from overdue", () => {
    const today = promiseReminderMessage({
      partyName: "A", promisedAmount: 1, currency: "TRY",
      promisedDateISO: "2099-03-15", todayISO: "2099-03-15",
    });
    const late = promiseReminderMessage({
      partyName: "A", promisedAmount: 1, currency: "TRY",
      promisedDateISO: "2099-03-15", todayISO: "2099-03-20",
    });
    expect(today).toContain("bugün vadesi");
    expect(late).toContain("5 gün geçti");
  });

  it("puts the counterparty in the action item title", () => {
    expect(brokenPromiseTitle("ACME", "2099-03-15")).toContain("ACME");
    expect(brokenPromiseTitle("ACME", "2099-03-15")).toContain("2099-03-15");
  });
});
