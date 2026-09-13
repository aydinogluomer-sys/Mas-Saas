// Faz 22 — receivables rules tests.

import { describe, expect, it } from "vitest";
import { decimal } from "@/lib/money";
import {
  COLLECTION_BUCKETS,
  collectionBucket,
  computeDPO,
  computeDSO,
  openAmount,
  planAllocation,
  runningBalance,
  summarizeAgeing,
  wouldExceedCeiling,
  type AllocatableInvoice,
} from "./rules";

describe("collectionBucket — Faz 22's 1-7/8-30/31-60/60+ scheme", () => {
  it.each([
    [null, "tarihsiz"],
    ["2026-03-10", "vadesi gelmemiş"],
    ["2026-03-01", "vadesi gelmemiş"],
    ["2026-02-28", "1-7 gün"],
    ["2026-02-22", "1-7 gün"],
    ["2026-02-21", "8-30 gün"],
    ["2026-01-30", "8-30 gün"],
    ["2026-01-29", "31-60 gün"],
    ["2025-12-31", "31-60 gün"],
    ["2025-12-30", "60+ gün"],
  ])("due %s -> %s", (due, bucket) => {
    expect(collectionBucket(due, "2026-03-01")).toBe(bucket);
  });

  it("the due date itself is not yet overdue", () => {
    expect(collectionBucket("2026-03-01", "2026-03-01")).toBe("vadesi gelmemiş");
  });

  it("boundaries land in the lower bucket", () => {
    expect(collectionBucket("2026-02-22", "2026-03-01")).toBe("1-7 gün");   // exactly 7
    expect(collectionBucket("2026-01-30", "2026-03-01")).toBe("8-30 gün");  // exactly 30
    expect(collectionBucket("2025-12-31", "2026-03-01")).toBe("31-60 gün"); // exactly 60
  });

  it("differs from Faz 21's reporting ageing on purpose", () => {
    // 20 days late is "1-30 gün" in Faz 21's scheme but "8-30 gün" here — the first month is
    // split because the collection action differs within it.
    expect(collectionBucket("2026-02-09", "2026-03-01")).toBe("8-30 gün");
  });
});

describe("summarizeAgeing", () => {
  const rows = [
    { dueDate: "2026-02-28", openAmount: 100 },
    { dueDate: "2026-02-25", openAmount: 50 },
    { dueDate: "2025-01-01", openAmount: 1000 },
    { dueDate: null, openAmount: 7 },
  ];

  it("emits EVERY bucket, including empty ones", () => {
    const s = summarizeAgeing(rows, "2026-03-01");
    expect(s.map((x) => x.bucket)).toEqual([...COLLECTION_BUCKETS]);
    // an absent row and a zero row read very differently to someone scanning for problems
    expect(s.find((x) => x.bucket === "31-60 gün")).toEqual({ bucket: "31-60 gün", count: 0, amount: 0, foreignCount: 0 });
  });

  it("sums each bucket exactly", () => {
    const s = summarizeAgeing(rows, "2026-03-01");
    expect(s.find((x) => x.bucket === "1-7 gün")).toEqual({ bucket: "1-7 gün", count: 2, amount: 150, foreignCount: 0 });
    expect(s.find((x) => x.bucket === "60+ gün")).toEqual({ bucket: "60+ gün", count: 1, amount: 1000, foreignCount: 0 });
    expect(s.find((x) => x.bucket === "tarihsiz")).toEqual({ bucket: "tarihsiz", count: 1, amount: 7, foreignCount: 0 });
  });

  it("does not drift over many rows", () => {
    const many = Array.from({ length: 300 }, () => ({ dueDate: "2026-02-28", openAmount: 33.33 }));
    expect(summarizeAgeing(many, "2026-03-01").find((x) => x.bucket === "1-7 gün")!.amount).toBe(9999);
  });
});

describe("computeDSO / computeDPO", () => {
  it("computes the textbook ratio", () => {
    // 100.000 open against 1.200.000 annual sales ≈ 30,4 gün
    expect(computeDSO(100_000, 1_200_000, 365)).toBe(30.4);
  });

  it("returns NULL when there were no sales — not 0", () => {
    // 0 would claim "customers pay instantly" about a company that sold nothing.
    expect(computeDSO(100_000, 0, 365)).toBeNull();
    expect(computeDPO(50_000, 0, 365)).toBeNull();
  });

  it("returns null for a non-positive period", () => {
    expect(computeDSO(100, 100, 0)).toBeNull();
  });

  it("DPO mirrors DSO against purchases", () => {
    expect(computeDPO(100_000, 1_200_000, 365)).toBe(computeDSO(100_000, 1_200_000, 365));
  });

  it("is exact where float division would not be", () => {
    expect(computeDSO(0.3, 0.1, 90)).toBe(270);
  });
});

describe("planAllocation — a proposal, oldest due first", () => {
  const invoices: AllocatableInvoice[] = [
    { invoiceId: "b", openAmount: 300, dueDate: "2026-02-01", issueDate: "2026-01-01" },
    { invoiceId: "a", openAmount: 100, dueDate: "2026-01-01", issueDate: "2026-01-01" },
    { invoiceId: "c", openAmount: 500, dueDate: "2026-03-01", issueDate: "2026-01-01" },
  ];

  it("fills the oldest due first", () => {
    const p = planAllocation(350, invoices);
    expect(p.lines).toEqual([{ invoiceId: "a", amount: 100 }, { invoiceId: "b", amount: 250 }]);
    expect(p.allocated).toBe(350);
    expect(p.unallocated).toBe(0);
  });

  it("returns the remainder rather than forcing it onto the last invoice", () => {
    const p = planAllocation(1000, invoices);
    expect(p.allocated).toBe(900);
    expect(p.unallocated).toBe(100);
  });

  it("never proposes more than an invoice's open amount", () => {
    const p = planAllocation(10_000, invoices);
    for (const line of p.lines) {
      const inv = invoices.find((i) => i.invoiceId === line.invoiceId)!;
      expect(line.amount).toBeLessThanOrEqual(inv.openAmount);
    }
  });

  it("puts undated invoices last — no due date is no claim to urgency", () => {
    const withUndated = [...invoices, { invoiceId: "z", openAmount: 50, dueDate: null, issueDate: "2020-01-01" }];
    const p = planAllocation(10_000, withUndated);
    expect(p.lines[p.lines.length - 1].invoiceId).toBe("z");
  });

  it("skips fully-settled invoices", () => {
    const p = planAllocation(100, [{ invoiceId: "x", openAmount: 0, dueDate: "2026-01-01", issueDate: "2026-01-01" }]);
    expect(p.lines).toEqual([]);
    expect(p.unallocated).toBe(100);
  });

  it("does not drift across a dozen invoices", () => {
    const twelve: AllocatableInvoice[] = Array.from({ length: 12 }, (_, i) => ({
      invoiceId: `i${i}`, openAmount: 33.33, dueDate: `2026-01-${String(i + 1).padStart(2, "0")}`,
      issueDate: "2026-01-01",
    }));
    const p = planAllocation(399.96, twelve);
    expect(p.allocated).toBe(399.96);
    expect(p.unallocated).toBe(0);
    expect(decimal(p.allocated).eq(decimal(33.33).times(12))).toBe(true);
  });

  it("allocates nothing for a zero payment", () => {
    expect(planAllocation(0, invoices).lines).toEqual([]);
  });
});

describe("wouldExceedCeiling — courtesy check, never the only guard", () => {
  it("detects an over-allocation", () => {
    expect(wouldExceedCeiling(120, 100, 21)).toBe(true);
  });

  it("allows an exact fill", () => {
    expect(wouldExceedCeiling(120, 100, 20)).toBe(false);
  });

  it("is exact at the kuruş", () => {
    expect(wouldExceedCeiling(120, 119.99, 0.01)).toBe(false);
    expect(wouldExceedCeiling(120, 119.99, 0.02)).toBe(true);
  });

  it("uses decimal comparison, not float", () => {
    // 0.1 + 0.2 > 0.3 is TRUE in binary floats; it must not be here.
    expect(wouldExceedCeiling(0.3, 0.1, 0.2)).toBe(false);
  });
});

describe("openAmount", () => {
  it("is gross minus allocated", () => {
    expect(openAmount(120, 50)).toBe(70);
  });

  it("floors at zero", () => {
    expect(openAmount(120, 130)).toBe(0);
  });
});

describe("runningBalance", () => {
  it("accumulates debits and credits in order", () => {
    const r = runningBalance([
      { movementDate: "2026-01-01", debitAmount: 120, creditAmount: 0 },
      { movementDate: "2026-01-15", debitAmount: 0, creditAmount: 50 },
      { movementDate: "2026-02-01", debitAmount: 80, creditAmount: 0 },
    ]);
    expect(r.map((x) => x.balance)).toEqual([120, 70, 150]);
  });

  it("sorts by date before accumulating", () => {
    const r = runningBalance([
      { movementDate: "2026-02-01", debitAmount: 80, creditAmount: 0 },
      { movementDate: "2026-01-01", debitAmount: 120, creditAmount: 0 },
    ]);
    expect(r[0].movementDate).toBe("2026-01-01");
    expect(r[1].balance).toBe(200);
  });

  it("does not compound float error down the column", () => {
    const rows = Array.from({ length: 300 }, () => ({ movementDate: "2026-01-01", debitAmount: 0.1, creditAmount: 0 }));
    expect(runningBalance(rows)[299].balance).toBe(30);
  });

  it("handles an empty ledger", () => {
    expect(runningBalance([])).toEqual([]);
  });
});
