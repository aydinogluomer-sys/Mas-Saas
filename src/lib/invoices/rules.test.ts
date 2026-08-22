// Faz 21 — invoice rules tests.

import { describe, expect, it } from "vitest";
import { decimal } from "@/lib/money";

import {
  INVOICE_TRANSITIONS,
  ageingBucket,
  assessDuplicate,
  canTransition,
  computeLineTotals,
  invoiceDedupeKey,
  isEditable,
  isTerminal,
  normalizeInvoiceNo,
  remainingAmount,
  suggestStatusFromPayment,
  sumLineTotals,
  type InvoiceStatus,
} from "./rules";

/**
 * gross === net + tax, asserted in DECIMAL.
 *
 * The first version of these tests wrote `expect(t.grossAmount).toBe(t.netAmount + t.taxAmount)`
 * and failed on q=7 p=1.115: the code correctly produced 9.22 while the TEST computed
 * 7.81 + 1.41 = 9.219999999999999 in binary floating point. The test was using the very
 * arithmetic the code exists to avoid, and would have been "fixed" by breaking the code.
 * Migration 0044's CHECK is evaluated by Postgres in `numeric`, so the assertion has to be too.
 */
const expectGrossInvariant = (t: { netAmount: number; taxAmount: number; grossAmount: number }, label = "") => {
  expect(decimal(t.grossAmount).eq(decimal(t.netAmount).plus(decimal(t.taxAmount))), label).toBe(true);
};

const ALL: InvoiceStatus[] = ["draft", "open", "partial", "paid", "closed", "cancelled"];

describe("transition allow-list mirrors migration 0044", () => {
  it("allows every declared transition", () => {
    for (const [from, to] of INVOICE_TRANSITIONS) expect(canTransition(from, to)).toBe(true);
  });

  it("same-status is a no-op for EVERY value", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(true);
  });

  it("every status is reachable from draft — the property 0027 broke", () => {
    const reach = new Set<InvoiceStatus>(["draft"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [from, to] of INVOICE_TRANSITIONS) {
        if (reach.has(from) && !reach.has(to)) { reach.add(to); grew = true; }
      }
    }
    for (const s of ALL) expect(reach.has(s), `${s} ulaşılamaz`).toBe(true);
  });

  it("nothing may return to draft — an issued invoice cannot be un-issued", () => {
    for (const s of ALL) {
      if (s === "draft") continue;
      expect(canTransition(s, "draft")).toBe(false);
    }
  });

  it("cancelled is terminal", () => {
    expect(isTerminal("cancelled")).toBe(true);
    for (const s of ALL) if (s !== "cancelled") expect(canTransition("cancelled", s)).toBe(false);
  });

  it("closed reopens only via open, never straight to paid/partial/cancelled", () => {
    expect(canTransition("closed", "open")).toBe(true);
    for (const s of ["partial", "paid", "cancelled", "draft"] as InvoiceStatus[]) {
      expect(canTransition("closed", s)).toBe(false);
    }
  });

  it("nothing can be paid before it is issued", () => {
    for (const s of ["partial", "paid", "closed"] as InvoiceStatus[]) {
      expect(canTransition("draft", s)).toBe(false);
    }
  });

  it("only draft is editable", () => {
    expect(isEditable("draft")).toBe(true);
    for (const s of ALL) if (s !== "draft") expect(isEditable(s)).toBe(false);
  });
});

describe("suggestStatusFromPayment suggests, never decides the human calls", () => {
  it("nothing paid -> open", () => {
    expect(suggestStatusFromPayment("open", 120, 0)).toBe("open");
  });

  it("part paid -> partial", () => {
    expect(suggestStatusFromPayment("open", 120, 50)).toBe("partial");
  });

  it("fully paid -> paid", () => {
    expect(suggestStatusFromPayment("partial", 120, 120)).toBe("paid");
  });

  it("OVERpaid is still paid, not partial", () => {
    // 0044 deliberately allows paid_amount > gross; treating that as "still partial" would
    // be absurd.
    expect(suggestStatusFromPayment("partial", 120, 130)).toBe("paid");
  });

  it("stays silent about draft, closed and cancelled — those are human judgements", () => {
    expect(suggestStatusFromPayment("draft", 120, 0)).toBeNull();
    expect(suggestStatusFromPayment("closed", 120, 0)).toBeNull();
    expect(suggestStatusFromPayment("cancelled", 120, 0)).toBeNull();
  });

  it("uses decimal comparison, not float", () => {
    // 0.1 + 0.2 !== 0.3 in binary; a float comparison would call this partial.
    expect(suggestStatusFromPayment("open", 0.3, 0.1 + 0.2)).toBe("paid");
  });
});

describe("computeLineTotals keeps gross = net + tax exactly", () => {
  it("computes a plain %20 line", () => {
    expect(computeLineTotals({ quantity: 3, unitPrice: 100, taxRate: 0.2 }))
      .toEqual({ netAmount: 300, taxAmount: 60, grossAmount: 360 });
  });

  it("handles 4-decimal unit prices without breaking the invariant", () => {
    expectGrossInvariant(computeLineTotals({ quantity: 7, unitPrice: "12.3456", taxRate: 0.2 }));
  });

  it("gross is net+tax, NOT its own rounded product", () => {
    // Rounding gross independently can land a kuruş away and violate 0044's CHECK.
    for (const q of [1, 3, 7, 13]) {
      for (const p of ["0.005", "1.115", "12.3456", "99.995"]) {
        expectGrossInvariant(computeLineTotals({ quantity: q, unitPrice: p, taxRate: 0.18 }), `q=${q} p=${p}`);
      }
    }
  });

  it("a zero tax rate yields zero tax", () => {
    expect(computeLineTotals({ quantity: 2, unitPrice: 50, taxRate: 0 }))
      .toEqual({ netAmount: 100, taxAmount: 0, grossAmount: 100 });
  });
});

describe("sumLineTotals sums as decimals, rounds once", () => {
  it("200 lines of 33.33 do not drift", () => {
    const lines = Array.from({ length: 200 }, () => ({ netAmount: 33.33, taxAmount: 6.67, grossAmount: 40 }));
    const total = sumLineTotals(lines);
    expect(total.netAmount).toBe(6666);
    expect(total.taxAmount).toBe(1334);
    expect(total.grossAmount).toBe(8000);
  });

  it("the float version of the same sum DOES drift", () => {
    let f = 0;
    for (let i = 0; i < 200; i++) f += 33.33;
    expect(f).not.toBe(6666);
  });

  it("header gross equals net + tax after summing", () => {
    const lines = [
      computeLineTotals({ quantity: 3, unitPrice: "12.3456", taxRate: 0.2 }),
      computeLineTotals({ quantity: 1, unitPrice: "0.005", taxRate: 0.18 }),
      computeLineTotals({ quantity: 11, unitPrice: "99.995", taxRate: 0.1 }),
    ];
    expectGrossInvariant(sumLineTotals(lines));
  });

  it("an empty invoice sums to zero, not NaN", () => {
    expect(sumLineTotals([])).toEqual({ netAmount: 0, taxAmount: 0, grossAmount: 0 });
  });
});

describe("remainingAmount", () => {
  it("is gross minus paid", () => {
    expect(remainingAmount(120, 50)).toBe(70);
  });

  it("goes NEGATIVE on overpayment rather than clamping to zero", () => {
    expect(remainingAmount(120, 130)).toBe(-10);
  });

  it("is exact on values a float would fumble", () => {
    expect(remainingAmount(0.3, 0.1)).toBe(0.2);
  });
});

describe("normalizeInvoiceNo", () => {
  it("collapses the spellings suppliers actually use", () => {
    const a = normalizeInvoiceNo("FTR-2026-001");
    expect(normalizeInvoiceNo("ftr 2026 001")).toBe(a);
    expect(normalizeInvoiceNo("FTR2026001")).toBe(a);
    expect(normalizeInvoiceNo("FTR/2026/001")).toBe(a);
  });

  it("keeps genuinely different numbers apart", () => {
    expect(normalizeInvoiceNo("FTR-2026-001")).not.toBe(normalizeInvoiceNo("FTR-2026-002"));
  });
});

describe("invoiceDedupeKey", () => {
  it("is stable across amount spellings and number formatting", () => {
    const base = { partyId: "p1", invoiceNo: "FTR-2026-001", grossAmount: 120, issueDate: "2026-01-01" };
    expect(invoiceDedupeKey(base)).toBe(invoiceDedupeKey({ ...base, invoiceNo: "ftr 2026 001", grossAmount: "120.00" }));
  });

  it("separates different parties, amounts and dates", () => {
    const base = { partyId: "p1", invoiceNo: "A", grossAmount: 120, issueDate: "2026-01-01" };
    expect(invoiceDedupeKey(base)).not.toBe(invoiceDedupeKey({ ...base, partyId: "p2" }));
    expect(invoiceDedupeKey(base)).not.toBe(invoiceDedupeKey({ ...base, grossAmount: 121 }));
    expect(invoiceDedupeKey(base)).not.toBe(invoiceDedupeKey({ ...base, issueDate: "2026-01-02" }));
  });
});

describe("assessDuplicate — two signals, explainable", () => {
  const a = { invoiceNo: "FTR-2026-001", grossAmount: 1200, issueDate: "2026-03-01" };

  it("same number alone is enough to flag", () => {
    const r = assessDuplicate(a, { invoiceNo: "ftr 2026 001", grossAmount: 999, issueDate: "2026-09-09" });
    expect(r.isSuspect).toBe(true);
    expect(r.signals).toContain("same_number");
  });

  it("same amount AND same date flags", () => {
    const r = assessDuplicate(a, { invoiceNo: "OTHER-1", grossAmount: 1200, issueDate: "2026-03-01" });
    expect(r.isSuspect).toBe(true);
    expect(r.signals).toContain("same_amount_and_date");
  });

  it("same amount a few days apart is a near match", () => {
    const r = assessDuplicate(a, { invoiceNo: "OTHER-1", grossAmount: 1200, issueDate: "2026-03-05" });
    expect(r.signals).toContain("near_match");
  });

  it("same amount FAR apart is NOT a suspect", () => {
    // Two invoices from one supplier for the same round amount months apart is ordinary.
    const r = assessDuplicate(a, { invoiceNo: "OTHER-1", grossAmount: 1200, issueDate: "2026-09-01" });
    expect(r.isSuspect).toBe(false);
  });

  it("same date, different amount is NOT a suspect", () => {
    const r = assessDuplicate(a, { invoiceNo: "OTHER-1", grossAmount: 999, issueDate: "2026-03-01" });
    expect(r.isSuspect).toBe(false);
  });

  it("confidence never exceeds 1", () => {
    const r = assessDuplicate(a, { invoiceNo: "FTR-2026-001", grossAmount: 1200, issueDate: "2026-03-01" });
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.confidence).toBeGreaterThan(0.8);
  });
});

describe("ageingBucket must agree with view 0047", () => {
  it.each([
    [null, "tarihsiz"],
    ["2026-04-01", "vadesi gelmemiş"],
    ["2026-03-01", "vadesi gelmemiş"],
    ["2026-02-20", "1-30 gün"],
    ["2026-01-25", "31-60 gün"],
    ["2025-12-20", "61-90 gün"],
    ["2025-06-01", "90+ gün"],
  ])("due %s -> %s", (due, bucket) => {
    expect(ageingBucket(due, "2026-03-01")).toBe(bucket);
  });

  it("treats the due date itself as not yet overdue", () => {
    expect(ageingBucket("2026-03-01", "2026-03-01")).toBe("vadesi gelmemiş");
  });

  it("boundaries land in the lower bucket", () => {
    expect(ageingBucket("2026-01-30", "2026-03-01")).toBe("1-30 gün");   // exactly 30
    expect(ageingBucket("2026-01-29", "2026-03-01")).toBe("31-60 gün");  // 31
  });
});
