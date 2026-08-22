// Faz 23 — collection risk / scheduling rules tests.

import { describe, expect, it } from "vitest";
import {
  LATE_RATIO_THRESHOLD,
  PROBABILITY_ADJUSTMENTS,
  assessRisk,
  collectionProbability,
  expectedCollectionDate,
  knownPayableTotal,
  scheduleWithinCash,
  type CollectionSignals,
  type PayableItem,
} from "./rules";

const base: CollectionSignals = {
  dueDate: "2026-03-01",
  issueDate: "2026-02-01",
  daysOverdue: 0,
  openAmount: 1000,
  badDebtFlagged: false,
  partyAvgDaysToSettle: null,
  partySettledCount: 0,
  partyLateRatio: null,
  partyInvoiceCount: 0,
  partiallySettled: false,
};

describe("expectedCollectionDate — every answer names its basis", () => {
  it("uses counterparty history once there are at least 3 settled invoices", () => {
    const r = expectedCollectionDate(
      { ...base, partyAvgDaysToSettle: 45, partySettledCount: 5 }, "2026-02-05");
    expect(r.basis).toBe("party_history");
    expect(r.expectedDate).toBe("2026-03-18"); // issue 2026-02-01 + 45
  });

  it("REFUSES to forecast from one or two invoices — an average of one is an anecdote", () => {
    const r = expectedCollectionDate(
      { ...base, partyAvgDaysToSettle: 90, partySettledCount: 2 }, "2026-02-05");
    expect(r.basis).toBe("due_date");
    expect(r.expectedDate).toBe("2026-03-01");
  });

  it("falls back to the due date when there is no history", () => {
    expect(expectedCollectionDate(base, "2026-02-05").basis).toBe("due_date");
  });

  it("falls back to issue + 30 when there is no due date either, and SAYS so", () => {
    const r = expectedCollectionDate({ ...base, dueDate: null }, "2026-02-05");
    expect(r.basis).toBe("issue_date_fallback");
    expect(r.expectedDate).toBe("2026-03-03");
  });

  it("never returns a date in the past — that is an overdue notice, not an expectation", () => {
    const r = expectedCollectionDate(base, "2026-06-01");
    expect(r.expectedDate).toBe("2026-06-01");
    expect(r.daysFromToday).toBe(0);
  });

  it("reports days from today", () => {
    expect(expectedCollectionDate(base, "2026-02-01").daysFromToday).toBe(28);
  });
});

describe("collectionProbability — a number is never returned without its reasons", () => {
  it("always reports at least one signal", () => {
    expect(collectionProbability(base).signals.length).toBeGreaterThan(0);
  });

  it("a not-yet-due invoice from an unknown counterparty is high", () => {
    const r = collectionProbability(base);
    expect(r.signals).toContain("not_yet_due");
    expect(r.signals).toContain("no_party_history");
    expect(r.band).toBe("yüksek");
  });

  it("degrades monotonically with ageing", () => {
    const at = (d: number) => collectionProbability({ ...base, daysOverdue: d }).probability;
    expect(at(0)).toBeGreaterThan(at(5));
    expect(at(5)).toBeGreaterThan(at(20));
    expect(at(20)).toBeGreaterThan(at(45));
    expect(at(45)).toBeGreaterThan(at(120));
  });

  it("a bad-debt flag dominates but never reaches zero", () => {
    // Flagged debt does get recovered; 0 would tell the collections list to stop trying.
    const r = collectionProbability({ ...base, badDebtFlagged: true });
    expect(r.signals[0]).toBe("bad_debt_flagged");
    expect(r.probability).toBeGreaterThan(0);
    expect(r.band).toBe("çok düşük");
  });

  it("never exceeds 1 or falls below 0.01", () => {
    const best = collectionProbability({
      ...base, partiallySettled: true, partyLateRatio: 0, partyInvoiceCount: 10,
    });
    expect(best.probability).toBeLessThanOrEqual(1);
    const worst = collectionProbability({
      ...base, badDebtFlagged: true, daysOverdue: 400, partyLateRatio: 1, partyInvoiceCount: 10,
    });
    expect(worst.probability).toBeGreaterThanOrEqual(0.01);
  });

  it("counts a counterparty as 'pays late' only above the stated threshold", () => {
    const late = collectionProbability({
      ...base, partyLateRatio: LATE_RATIO_THRESHOLD + 0.01, partyInvoiceCount: 5 });
    const onTime = collectionProbability({
      ...base, partyLateRatio: LATE_RATIO_THRESHOLD - 0.01, partyInvoiceCount: 5 });
    expect(late.signals).toContain("party_pays_late");
    expect(onTime.signals).toContain("party_pays_on_time");
    expect(onTime.probability).toBeGreaterThan(late.probability);
  });

  it("treats thin history as unknown, not as good news", () => {
    const thin = collectionProbability({ ...base, partyLateRatio: 0, partyInvoiceCount: 2 });
    expect(thin.signals).toContain("no_party_history");
    expect(thin.signals).not.toContain("party_pays_on_time");
  });

  it("partial settlement raises it — the counterparty is engaging", () => {
    const plain = collectionProbability({ ...base, daysOverdue: 20 });
    const partial = collectionProbability({ ...base, daysOverdue: 20, partiallySettled: true });
    expect(partial.probability).toBeGreaterThan(plain.probability);
    expect(partial.signals).toContain("partially_settled");
  });

  it("every emitted signal exists in the published weight table", () => {
    for (const s of collectionProbability({ ...base, daysOverdue: 90, partiallySettled: true }).signals) {
      expect(PROBABILITY_ADJUSTMENTS).toHaveProperty(s);
    }
  });

  it("is deterministic — same input, same output", () => {
    const a = collectionProbability({ ...base, daysOverdue: 33 });
    const b = collectionProbability({ ...base, daysOverdue: 33 });
    expect(a).toEqual(b);
  });
});

describe("assessRisk", () => {
  it("is clean for a healthy invoice", () => {
    const r = assessRisk(base, 0.1);
    expect(r.flags).toEqual([]);
    expect(r.severity).toBe("yok");
  });

  it("flags overdue and escalates past 60 days", () => {
    expect(assessRisk({ ...base, daysOverdue: 5 }, 0).severity).toBe("izle");
    expect(assessRisk({ ...base, daysOverdue: 45 }, 0).severity).toBe("yüksek");
    const heavy = assessRisk({ ...base, daysOverdue: 90 }, 0);
    expect(heavy.flags).toContain("ağır_gecikme");
    expect(heavy.severity).toBe("kritik");
  });

  it("a bad-debt flag is always critical", () => {
    expect(assessRisk({ ...base, badDebtFlagged: true }, 0).severity).toBe("kritik");
  });

  it("uses the same 0.40 concentration threshold as the rest of the codebase", () => {
    expect(assessRisk(base, 0.41).flags).toContain("yoğunlaşma");
    expect(assessRisk(base, 0.39).flags).not.toContain("yoğunlaşma");
  });

  it("flags a stalled partial settlement distinctly from a plain overdue", () => {
    const stalled = assessRisk({ ...base, daysOverdue: 40, partiallySettled: true }, 0);
    expect(stalled.flags).toContain("kısmi_tahsilat_durdu");
    expect(assessRisk({ ...base, daysOverdue: 40 }, 0).flags).not.toContain("kısmi_tahsilat_durdu");
  });

  it("flags a missing due date", () => {
    expect(assessRisk({ ...base, dueDate: null }, 0).flags).toContain("tarihsiz_vade");
  });
});

describe("scheduleWithinCash — a proposal that hides nothing", () => {
  const items: PayableItem[] = [
    { kind: "check", entityId: "c1", dueDate: "2026-03-01", label: "Çek A", amount: 500, flexibilityClass: "critical", priorityRank: 0 },
    { kind: "invoice", entityId: "i1", dueDate: "2026-03-02", label: "Fatura B", amount: 400, flexibilityClass: "flexible", priorityRank: 100 },
    { kind: "invoice", entityId: "i2", dueDate: "2026-03-03", label: "Fatura C", amount: 300, flexibilityClass: "optional", priorityRank: 200 },
  ];

  it("orders by rank and marks where the cash runs out", () => {
    const s = scheduleWithinCash(items, 800);
    expect(s.items.map((i) => i.entityId)).toEqual(["c1", "i1", "i2"]);
    expect(s.items[0].covered).toBe(true);
    expect(s.items[1].covered).toBe(false);
    expect(s.firstUncoveredLabel).toBe("Fatura B");
  });

  it("never drops the items that do not fit", () => {
    // Hiding them would hide the actual problem.
    expect(scheduleWithinCash(items, 0).items).toHaveLength(3);
  });

  it("reports the shortfall", () => {
    expect(scheduleWithinCash(items, 800).shortfall).toBe(400);
    expect(scheduleWithinCash(items, 5000).shortfall).toBe(0);
  });

  it("an UNKNOWN amount is never summed as zero and is never 'covered'", () => {
    const withUnknown: PayableItem[] = [
      { ...items[0], amount: null },
      items[1],
    ];
    const s = scheduleWithinCash(withUnknown, 1000);
    expect(s.unknownCount).toBe(1);
    expect(s.items[0].covered).toBe(false);
    // the unknown item did not advance the running total
    expect(s.items[1].cumulative).toBe(400);
    expect(s.totalKnown).toBe(400);
  });

  it("marks non-critical items deferrable", () => {
    const s = scheduleWithinCash(items, 0);
    expect(s.items[0].deferrable).toBe(false);
    expect(s.items[1].deferrable).toBe(true);
  });

  it("accumulates exactly over many items", () => {
    const many: PayableItem[] = Array.from({ length: 300 }, (_, i) => ({
      kind: "invoice", entityId: `x${i}`, dueDate: "2026-03-01", label: `F${i}`,
      amount: 0.1, flexibilityClass: "flexible", priorityRank: 100,
    }));
    expect(scheduleWithinCash(many, 1000).totalKnown).toBe(30);
  });

  it("handles an empty list", () => {
    const s = scheduleWithinCash([], 100);
    expect(s.items).toEqual([]);
    expect(s.totalKnown).toBe(0);
    expect(s.firstUncoveredLabel).toBeNull();
  });
});

describe("knownPayableTotal", () => {
  it("skips unknown amounts rather than zeroing them", () => {
    expect(knownPayableTotal([
      { kind: "a", entityId: "1", dueDate: "2026-01-01", label: "x", amount: 10, flexibilityClass: "flexible", priorityRank: 1 },
      { kind: "a", entityId: "2", dueDate: "2026-01-01", label: "y", amount: null, flexibilityClass: "flexible", priorityRank: 1 },
      { kind: "a", entityId: "3", dueDate: "2026-01-01", label: "z", amount: 5.5, flexibilityClass: "flexible", priorityRank: 1 },
    ])).toBe(15.5);
  });
});
