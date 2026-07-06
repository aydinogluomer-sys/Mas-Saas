// Phase 6B reminder rules — required tests (mas-reminder-engine skill):
// eligibility (offset/status/threshold/active), scheduledFor math, message fields,
// null-amount-never-excluded. Duplicate prevention + failed logging are DB/engine
// level, proven in phase6b-verify.

import { describe, expect, it } from "vitest";
import {
  buildReminderMessage,
  eligibleDeliveries,
  isEligible,
  scheduledForDate,
  thresholdPasses,
  type ReminderRule,
  type ReminderTarget,
} from "./rules";

const rule = (over: Partial<ReminderRule>): ReminderRule => ({
  id: "r", name: "test", targetKind: "payment_instance", offsetDays: 3,
  channel: "telegram", minAmount: null, isActive: true, ...over,
});
const target = (over: Partial<ReminderTarget>): ReminderTarget => ({
  entityTable: "payment_instances", entityId: "t", name: "KİRA",
  dueDate: "2026-07-10", amount: 35000, status: "unpaid",
  owner: "MAS", provider: "Halk", riskReasons: [], ...over,
});

describe("scheduledForDate", () => {
  it("offset N fires N days before due; -1 fires day after due (overdue)", () => {
    expect(scheduledForDate("2026-07-10", 7)).toBe("2026-07-03");
    expect(scheduledForDate("2026-07-10", 3)).toBe("2026-07-07");
    expect(scheduledForDate("2026-07-10", 1)).toBe("2026-07-09");
    expect(scheduledForDate("2026-07-10", 0)).toBe("2026-07-10");
    expect(scheduledForDate("2026-07-10", -1)).toBe("2026-07-11");
  });
});

describe("thresholdPasses (null never excluded — unknown could be large)", () => {
  it("no threshold → always passes", () => expect(thresholdPasses(null, 10)).toBe(true));
  it("known below threshold → filtered", () => expect(thresholdPasses(50000, 35000)).toBe(false));
  it("known at/above → passes", () => expect(thresholdPasses(50000, 50000)).toBe(true));
  it("unknown amount with threshold → still passes", () => expect(thresholdPasses(50000, null)).toBe(true));
});

describe("isEligible", () => {
  const today = "2026-07-07"; // 3 days before due 2026-07-10
  it("fires when scheduled date matches today, status open, rule active", () => {
    expect(isEligible(rule({ offsetDays: 3 }), target({}), today)).toBe(true);
  });
  it("wrong offset → not today → skip", () => {
    expect(isEligible(rule({ offsetDays: 7 }), target({}), today)).toBe(false);
  });
  it("paid/cancelled → skip (only unpaid/partial)", () => {
    expect(isEligible(rule({}), target({ status: "paid" }), today)).toBe(false);
    expect(isEligible(rule({}), target({ status: "partial" }), today)).toBe(true);
  });
  it("inactive rule → skip", () => {
    expect(isEligible(rule({ isActive: false }), target({}), today)).toBe(false);
  });
  it("known amount below min_amount → skip; unknown amount → still eligible", () => {
    expect(isEligible(rule({ minAmount: 50000 }), target({ amount: 35000 }), today)).toBe(false);
    expect(isEligible(rule({ minAmount: 50000 }), target({ amount: null }), today)).toBe(true);
  });
  it("target_kind mismatch → skip", () => {
    expect(isEligible(rule({ targetKind: "check" }), target({}), today)).toBe(false);
  });
});

describe("eligibleDeliveries (rule × target cross, only firing today)", () => {
  const today = "2026-07-09"; // 1 day before due
  const rules = [rule({ id: "r1", offsetDays: 1 }), rule({ id: "r7", offsetDays: 7 })];
  const targets = [
    target({ entityId: "a", dueDate: "2026-07-10" }), // r1 fires
    target({ entityId: "b", dueDate: "2026-07-16", status: "paid" }), // r7 would fire but paid
  ];
  const out = eligibleDeliveries(rules, targets, today);
  it("emits only the firing, open pairs with today as scheduledFor", () => {
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "r1", entityId: "a", scheduledFor: today });
    expect(out[0].message).toContain("Yarın ödeme");
  });
});

describe("buildReminderMessage (all required fields)", () => {
  it("includes name, due, amount, status, owner, provider, risk", () => {
    const m = buildReminderMessage(
      rule({ offsetDays: 0 }),
      target({ amount: 190000, riskReasons: ["critical_payment"], status: "unpaid" }),
    );
    expect(m).toContain("Bugün ödeme");
    expect(m).toContain("KİRA · 2026-07-10");
    expect(m).toContain("190.000 TL");
    expect(m).toContain("durum: unpaid");
    expect(m).toContain("sahip: MAS");
    expect(m).toContain("sağlayıcı: Halk");
    expect(m).toContain("risk: critical_payment");
  });
  it("null amount → 'tutar eksik', never 0", () => {
    const m = buildReminderMessage(rule({}), target({ amount: null }));
    expect(m).toContain("tutar: tutar eksik");
    expect(m).not.toMatch(/tutar: 0/);
  });
});
