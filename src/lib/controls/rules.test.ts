import { describe, expect, it } from "vitest";
import {
  ALERT_STATUSES, ALERT_STATUS_LABEL, ALERT_TRANSITIONS, ANOMALY_LABEL, ANOMALY_RULES,
  ANOMALY_WEIGHT, SEVERITIES, SEVERITY_LABEL,
  assessAnomaly, canTransition, controlState, falsePositiveRate, isEscalationDue,
  isRoundNumber, isSplitPayment, severityForScore, timesBaseline,
} from "./rules";

describe("alert lifecycle mirrors the database guard", () => {
  it("allows exactly the eleven documented moves", () => {
    expect(ALERT_TRANSITIONS).toHaveLength(11);
  });

  it("lets a SNOOZE EXPIRE back to open", () => {
    // Without this every snoozed alert is silenced forever — how an alerting system stops being
    // trusted.
    expect(canTransition("snoozed", "open")).toBe(true);
  });

  it("treats resolved and false_positive as terminal", () => {
    for (const to of ALERT_STATUSES) {
      if (to !== "resolved") expect(canTransition("resolved", to), `resolved>${to}`).toBe(false);
      if (to !== "false_positive") expect(canTransition("false_positive", to)).toBe(false);
    }
  });

  it("refuses exactly nine of the twenty ordered pairs", () => {
    const allowed = new Set(ALERT_TRANSITIONS.map(([f, t]) => `${f}>${t}`));
    let refused = 0;
    for (const from of ALERT_STATUSES) {
      for (const to of ALERT_STATUSES) {
        if (from === to) continue;
        if (!allowed.has(`${from}>${to}`)) {
          expect(canTransition(from, to)).toBe(false);
          refused += 1;
        }
      }
    }
    expect(refused).toBe(9);
  });

  it("treats same-status as a no-op", () => {
    for (const s of ALERT_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it("labels every status and severity", () => {
    for (const s of ALERT_STATUSES) expect(ALERT_STATUS_LABEL[s].length).toBeGreaterThan(0);
    for (const s of SEVERITIES) expect(SEVERITY_LABEL[s].length).toBeGreaterThan(0);
  });
});

describe("controlState", () => {
  it("is PASS when nothing was found, whatever the severity", () => {
    expect(controlState("critical", 0)).toBe("PASS");
    expect(controlState("info", 0)).toBe("PASS");
  });

  it("uses the control's own severity once something is found", () => {
    expect(controlState("critical", 1)).toBe("CRITICAL");
    expect(controlState("warning", 3)).toBe("WARNING");
    expect(controlState("info", 2)).toBe("INFO");
  });
});

describe("assessAnomaly — weights SUM, they do not average", () => {
  it("scores a single rule at its own weight", () => {
    expect(assessAnomaly(["round_number"]).score).toBe(ANOMALY_WEIGHT.round_number);
  });

  it("makes three weak signals TOGETHER more suspicious than any one alone", () => {
    // Averaging would dilute a stack of findings below its largest component — backwards for a
    // detector whose job is surfacing combinations.
    const stacked = assessAnomaly(["round_number", "new_payee", "unusual_record_hour"]);
    expect(stacked.score).toBeGreaterThan(ANOMALY_WEIGHT.new_payee);
    expect(stacked.score).toBeCloseTo(0.30, 10);
  });

  it("clamps at 1 rather than exceeding it", () => {
    expect(assessAnomaly([...ANOMALY_RULES]).score).toBe(1);
  });

  it("names the heaviest rule as the headline", () => {
    expect(assessAnomaly(["round_number", "approval_bypass"]).primaryRule).toBe("approval_bypass");
  });

  it("is order-independent and de-duplicates", () => {
    const a = assessAnomaly(["new_payee", "round_number", "new_payee"]);
    const b = assessAnomaly(["round_number", "new_payee"]);
    expect(a.score).toBe(b.score);
    expect(a.rules).toEqual(b.rules);
  });

  it("produces nothing for an empty rule set — a finding with no rule is not a finding", () => {
    const none = assessAnomaly([]);
    expect(none.score).toBe(0);
    expect(none.primaryRule).toBeNull();
    expect(none.rules).toEqual([]);
  });

  it("weighs control circumvention above odd-looking numbers", () => {
    expect(ANOMALY_WEIGHT.approval_bypass).toBeGreaterThan(ANOMALY_WEIGHT.amount_vs_baseline);
    expect(ANOMALY_WEIGHT.iban_changed).toBeGreaterThan(ANOMALY_WEIGHT.round_number);
  });

  it("labels every rule", () => {
    for (const r of ANOMALY_RULES) expect(ANOMALY_LABEL[r].length).toBeGreaterThan(0);
  });
});

describe("severityForScore", () => {
  it("bands deterministically", () => {
    expect(severityForScore(0.5)).toBe("critical");
    expect(severityForScore(0.49)).toBe("warning");
    expect(severityForScore(0.25)).toBe("warning");
    expect(severityForScore(0.24)).toBe("info");
    expect(severityForScore(0)).toBe("info");
  });
});

describe("isRoundNumber — both conditions matter", () => {
  it("flags a large round amount", () => {
    expect(isRoundNumber(50000)).toBe(true);
  });

  it("does NOT flag a small round amount", () => {
    // A 1.000 TL subscription is ordinary.
    expect(isRoundNumber(1000)).toBe(false);
  });

  it("does NOT flag a large non-round amount", () => {
    expect(isRoundNumber(50500)).toBe(false);
  });

  it("judges a numeric STRING exactly, without a float ever existing", () => {
    expect(isRoundNumber("50000.00")).toBe(true);
    expect(isRoundNumber("50000.01")).toBe(false);
  });

  it("treats an unknown amount as not-a-finding", () => {
    expect(isRoundNumber(null)).toBe(false);
  });
});

describe("isSplitPayment", () => {
  it("flags parts that individually duck the threshold but together clear it", () => {
    expect(isSplitPayment([60000, 60000], 100000)).toBe(true);
  });

  it("does NOT flag when a single part already exceeds the threshold", () => {
    // That is just a large payment, which its own control reports.
    expect(isSplitPayment([120000, 10000], 100000)).toBe(false);
  });

  it("does NOT flag when the total stays below the threshold", () => {
    expect(isSplitPayment([10000, 20000], 100000)).toBe(false);
  });

  it("needs at least two parts", () => {
    expect(isSplitPayment([90000], 100000)).toBe(false);
  });

  it("sums in decimal", () => {
    expect(isSplitPayment(["50000.00", "50000.00"], 100000)).toBe(true);
    expect(isSplitPayment(["49999.99", "50000.00"], 100000)).toBe(false);
  });
});

describe("timesBaseline", () => {
  it("reports the multiple", () => {
    expect(timesBaseline(30000, 10000)).toBe(3);
  });

  it("returns NULL rather than dividing by a zero or missing baseline", () => {
    // A thin history is not evidence of normality.
    expect(timesBaseline(30000, 0)).toBeNull();
    expect(timesBaseline(30000, null)).toBeNull();
  });
});

describe("isEscalationDue — only OPEN alerts escalate", () => {
  const base = { firstSeenAt: "2099-01-01T00:00:00Z", escalateAfterHours: 1, nowISO: "2099-01-01T02:00:00Z" };

  it("escalates an open alert past its window", () => {
    expect(isEscalationDue({ ...base, status: "open" })).toBe(true);
  });

  it("does NOT escalate an acknowledged alert", () => {
    // A person has already seen it — that is what acknowledging means.
    expect(isEscalationDue({ ...base, status: "acknowledged" })).toBe(false);
  });

  it("does NOT escalate a snoozed alert", () => {
    expect(isEscalationDue({ ...base, status: "snoozed" })).toBe(false);
  });

  it("does not escalate before the window elapses", () => {
    expect(isEscalationDue({
      ...base, status: "open", nowISO: "2099-01-01T00:30:00Z",
    })).toBe(false);
  });

  it("escalates exactly AT the window boundary", () => {
    expect(isEscalationDue({
      ...base, status: "open", nowISO: "2099-01-01T01:00:00Z",
    })).toBe(true);
  });
});

describe("falsePositiveRate — counts only CLOSED alerts", () => {
  it("is null when nothing has been triaged yet, not 0", () => {
    // 0 would make an untriaged control look perfectly accurate.
    expect(falsePositiveRate(0, 0)).toBeNull();
  });

  it("computes the share of closed alerts that were false alarms", () => {
    expect(falsePositiveRate(3, 1)).toBe(0.25);
    expect(falsePositiveRate(0, 4)).toBe(1);
    expect(falsePositiveRate(4, 0)).toBe(0);
  });
});
