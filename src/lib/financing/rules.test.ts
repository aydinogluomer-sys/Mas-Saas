// Phase 5 financing rules — required tests (mas-loan-check-analyst skill):
// signed direction, week/month maturity grouping, loan total repayment,
// finance cost, schedule determinism. Idempotency is proven DB-level in phase5-verify.

import { describe, expect, it } from "vitest";
import {
  debtServiceByMonth,
  exposureBy,
  groupMaturities,
  isoWeekOf,
  maturityWindows,
  reconcileLoan,
  scheduleDueDates,
  signedToDirection,
  type MaturityItem,
} from "./rules";

describe("signedToDirection (calculation-rules §Checks)", () => {
  it("negative signed → outflow with |amount|", () => {
    expect(signedToDirection(-45000)).toEqual({ direction: "outflow", amount: 45000 });
  });
  it("positive signed → inflow", () => {
    expect(signedToDirection(100000)).toEqual({ direction: "inflow", amount: 100000 });
  });
  it("null stays null — never zero (financial safety rule)", () => {
    expect(signedToDirection(null)).toEqual({ direction: "unknown", amount: null });
  });
  it("explicit zero keeps 0 but sign carries no direction", () => {
    expect(signedToDirection(0)).toEqual({ direction: "unknown", amount: 0 });
  });
});

const item = (over: Partial<MaturityItem>): MaturityItem => ({
  id: "x",
  dueDate: "2026-07-10",
  amount: 1000,
  direction: "outflow",
  kind: "check",
  label: "test",
  ...over,
});

describe("isoWeekOf", () => {
  it("mid-year Monday", () => {
    expect(isoWeekOf("2026-07-06")).toEqual({
      key: "2026-W28",
      from: "2026-07-06",
      to: "2026-07-12",
    });
  });
  it("year boundary: Dec 30 2024 belongs to 2025-W01", () => {
    expect(isoWeekOf("2024-12-30").key).toBe("2025-W01");
  });
  it("Jan 1 on a Thursday starts W01 spanning previous year", () => {
    const w = isoWeekOf("2026-01-01");
    expect(w.key).toBe("2026-W01");
    expect(w.from).toBe("2025-12-29");
  });
});

describe("groupMaturities", () => {
  const items: MaturityItem[] = [
    item({ id: "a", dueDate: "2026-07-06", amount: 50000, direction: "outflow" }),
    item({ id: "b", dueDate: "2026-07-08", amount: 20000, direction: "inflow" }),
    item({ id: "c", dueDate: "2026-07-13", amount: null }), // next ISO week, unknown amount
    item({ id: "d", dueDate: "2026-08-01", amount: 30000, direction: "outflow", kind: "loan_installment" }),
    item({ id: "e", dueDate: "2026-07-09", amount: 5000, direction: "unknown" }),
  ];
  it("month buckets: sums split by direction; null counted, not summed", () => {
    const months = groupMaturities(items, "month");
    expect(months.map((m) => m.key)).toEqual(["2026-07", "2026-08"]);
    const jul = months[0];
    expect(jul.count).toBe(4);
    expect(jul.knownOutflow).toBe(50000);
    expect(jul.knownInflow).toBe(20000);
    expect(jul.missingCount).toBe(1); // c — never treated as 0
    expect(jul.unknownDirectionCount).toBe(1); // e
    expect(months[1].knownOutflow).toBe(30000);
  });
  it("week buckets split at ISO boundary (Sun/Mon)", () => {
    const weeks = groupMaturities(items, "week");
    expect(weeks.map((w) => w.key)).toEqual(["2026-W28", "2026-W29", "2026-W31"]);
    expect(weeks[0].count).toBe(3); // a,b,e
    expect(weeks[1].missingCount).toBe(1); // c
  });
});

describe("maturityWindows (7/14/30 forward-looking)", () => {
  const today = "2026-07-06";
  const items: MaturityItem[] = [
    item({ id: "today", dueDate: "2026-07-06", amount: 10 }),
    item({ id: "d6", dueDate: "2026-07-12", amount: 100 }),
    item({ id: "d13", dueDate: "2026-07-19", amount: 1000 }),
    item({ id: "d29", dueDate: "2026-08-04", amount: 10000 }),
    item({ id: "d30", dueDate: "2026-08-05", amount: 100000 }), // outside 30d
    item({ id: "overdue", dueDate: "2026-07-05", amount: 7 }), // overdue ≠ upcoming
    item({ id: "missing", dueDate: "2026-07-07", amount: null }),
  ];
  it("windows include today, exclude today+days and overdue; missing disclosed", () => {
    const [w7, w14, w30] = maturityWindows(items, today);
    expect(w7.count).toBe(3); // today, d6, missing
    expect(w7.knownOutflow).toBe(110);
    expect(w7.missingCount).toBe(1);
    expect(w14.knownOutflow).toBe(1110);
    expect(w30.knownOutflow).toBe(11110);
    expect(w30.count).toBe(5);
  });
});

describe("exposureBy (banka exposure, eşik 0.40)", () => {
  it("flags >40% share; unknown amounts excluded and disclosed", () => {
    const r = exposureBy([
      { key: "HALK", amount: 150000, direction: "outflow" },
      { key: "HALK", amount: 40000, direction: "inflow" },
      { key: "DENİZ", amount: 60000, direction: "outflow" },
      { key: null, amount: null, direction: "unknown" },
    ]);
    expect(r.knownTotal).toBe(250000);
    expect(r.unknownCount).toBe(1);
    expect(r.entries[0]).toMatchObject({ key: "HALK", outflowSum: 150000, inflowSum: 40000, flagged: true });
    expect(r.entries[1].flagged).toBe(false);
  });
});

describe("scheduleDueDates (derived; short-month clamp reuses dueDateFor)", () => {
  it("real loan anchor: 2024-10-18 ×48 → monthly day-18, last 2028-09-18", () => {
    const s = scheduleDueDates("2024-10-18", 48);
    expect(s).toHaveLength(48);
    expect(s[0]).toEqual({ no: 1, dueDate: "2024-10-18", shortMonthAdjusted: false });
    expect(s[1].dueDate).toBe("2024-11-18");
    expect(s[47].dueDate).toBe("2028-09-18");
    expect(s.every((x) => !x.shortMonthAdjusted)).toBe(true);
  });
  it("day-31 first payment clamps short months and flags them", () => {
    const s = scheduleDueDates("2025-01-31", 3);
    expect(s.map((x) => x.dueDate)).toEqual(["2025-01-31", "2025-02-28", "2025-03-31"]);
    expect(s[1].shortMonthAdjusted).toBe(true);
    expect(s[2].shortMonthAdjusted).toBe(false);
  });
  it("leap February clamps to 29", () => {
    const s = scheduleDueDates("2027-12-30", 3);
    expect(s.map((x) => x.dueDate)).toEqual(["2027-12-30", "2028-01-30", "2028-02-29"]);
    expect(s[2].shortMonthAdjusted).toBe(true);
  });
  it("deterministic: same input → same output (idempotent derivation)", () => {
    expect(scheduleDueDates("2024-10-18", 48)).toEqual(scheduleDueDates("2024-10-18", 48));
  });
});

describe("reconcileLoan (±1 TL; flags only — silent-fix ban)", () => {
  const real = {
    installmentSum: 3443717.579577506, // B12 = SUM(B14:B105)
    totalPayment: 3443717.579577507, // B10
    principal: 1500000, // B4
    financeCost: 1943717.579577507, // B11
  };
  it("real faiz hesaplama values reconcile", () => {
    expect(reconcileLoan(real)).toEqual({ ok: true, issues: [] });
  });
  it("Σtaksit sapması → installment_sum_mismatch with diff (input untouched)", () => {
    const input = { ...real, installmentSum: 3443000 };
    const r = reconcileLoan(input);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("installment_sum_mismatch");
    expect(r.issues[0].diff).toBeCloseTo(-717.58, 1);
    expect(input.installmentSum).toBe(3443000); // never adjusted
  });
  it("fark tutarsızlığı → finance_cost_mismatch", () => {
    const r = reconcileLoan({ ...real, financeCost: 1900000 });
    expect(r.issues.map((i) => i.code)).toEqual(["finance_cost_mismatch"]);
  });
  it("missing source totals → missing_totals (null is unknown, not 0)", () => {
    const r = reconcileLoan({ ...real, totalPayment: null });
    expect(r.issues.map((i) => i.code)).toEqual(["missing_totals"]);
  });
});

describe("debtServiceByMonth", () => {
  it("merges checks + installments into monthly load", () => {
    const months = debtServiceByMonth([
      item({ id: "c1", dueDate: "2026-09-05", amount: 45000 }),
      item({ id: "i1", dueDate: "2026-09-18", amount: 71744.12, kind: "loan_installment" }),
      item({ id: "c2", dueDate: "2026-10-01", amount: null }),
    ]);
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({
      monthStart: "2026-09-01",
      count: 2,
      knownOutflow: 116744.12,
      missingCount: 0,
    });
    expect(months[1].missingCount).toBe(1);
  });
});
