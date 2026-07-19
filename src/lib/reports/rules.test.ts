// Phase 6A report rules — required tests (mas-report-writer skill):
// daily/weekly/monthly structure, Istanbul timezone boundary, null-never-zero,
// debt-service overlay pressure, AI commentary is prompt-only (no mutation directive).

import { describe, expect, it } from "vitest";
import {
  buildCommentaryPrompt,
  buildDailyReport,
  buildMonthlyReport,
  buildWeeklyReport,
  overlayDebtService,
  type ReportInstance,
  type ReportMaturity,
} from "./rules";

const inst = (over: Partial<ReportInstance>): ReportInstance => ({
  name: "X", dueDate: "2026-07-06", amount: 1000, status: "unpaid", riskLevel: "none", riskReasons: [], ...over,
});
const mat = (over: Partial<ReportMaturity>): ReportMaturity => ({
  label: "çek", dueDate: "2026-07-08", amount: 5000, direction: "outflow", kind: "check", ...over,
});

// istanbulDateISO's own tests moved to src/lib/time/istanbul.test.ts (implementation
// moved to src/lib/time/istanbul.ts; this file now only re-exports it).

describe("buildDailyReport", () => {
  const today = "2026-07-06";
  const input = {
    dueSoon: [
      inst({ name: "bugün-A", dueDate: "2026-07-06", amount: 120000, riskLevel: "critical" }),
      inst({ name: "bugün-B", dueDate: "2026-07-06", amount: null }), // missing amount
      inst({ name: "yarın", dueDate: "2026-07-07", amount: 30000 }),
      inst({ name: "6gün", dueDate: "2026-07-12", amount: 5000 }),
    ],
    overdue: [inst({ name: "geciken", dueDate: "2026-07-01", amount: 9000, status: "unpaid", riskLevel: "high" })],
    maturities: [mat({ dueDate: "2026-07-09", amount: 45000 })],
    criticalThreshold: 100000,
  };
  const r = buildDailyReport(input, today);

  it("splits today/tomorrow, sums known next-7, discloses missing (never 0)", () => {
    expect(r.dueToday.map((i) => i.name)).toEqual(["bugün-A", "bugün-B"]);
    expect(r.dueTomorrow.map((i) => i.name)).toEqual(["yarın"]);
    expect(r.next7KnownTotal).toBe(155000); // 120000+30000+5000; null excluded
    expect(r.next7MissingCount).toBe(1);
  });
  it("flags overdue + critical + surfaces checks", () => {
    expect(r.overdueCount).toBe(1);
    expect(r.overdueKnownTotal).toBe(9000);
    expect(r.criticalItems.map((i) => i.name)).toEqual(["bugün-A"]);
    expect(r.checksNext7).toHaveLength(1);
  });
  it("actions are decision-oriented and non-empty", () => {
    expect(r.actions.some((a) => /geciken/i.test(a))).toBe(true);
    expect(r.actions.some((a) => /tutar eksik/i.test(a))).toBe(true);
    expect(r.bodyMd).toContain("# Günlük Rapor — 2026-07-06");
    expect(r.bodyMd).toContain("TUTAR EKSİK"); // null rendered, not 0
  });
});

describe("buildWeeklyReport", () => {
  const r = buildWeeklyReport(
    {
      weekInstances: [
        inst({ name: "big", amount: 80000 }),
        inst({ name: "small", amount: 1000 }),
        inst({ name: "nolist", amount: null }),
      ],
      maturitiesWeek: [
        mat({ kind: "check", amount: 45000 }),
        mat({ kind: "loan_installment", amount: 71744, direction: "outflow", label: "kredi" }),
      ],
      installmentsMonth: [mat({ kind: "loan_installment", amount: 71744, label: "kredi" })],
      riskDays: [{ date: "2026-07-09", cluster: true, critical: false, large: true, knownSum: 190000, count: 3 }],
      largeThreshold: 50000,
    },
    "2026-07-06",
  );
  it("computes loads and largest, discloses missing", () => {
    expect(r.knownTotal).toBe(81000);
    expect(r.missingCount).toBe(1);
    expect(r.largest.map((i) => i.name)).toEqual(["big"]);
    expect(r.checkLoad).toBe(45000);
    expect(r.installmentLoadWeek).toBe(71744);
    expect(r.installmentLoadMonth).toBe(71744);
    expect(r.riskDays).toHaveLength(1);
    expect(r.to).toBe("2026-07-13");
  });
});

describe("buildMonthlyReport", () => {
  const r = buildMonthlyReport({
    monthStart: "2026-07-01",
    knownTotal: 500000, knownRemaining: 300000, paidKnown: 200000,
    missingCount: 4, totalCount: 19,
    topPayments: [inst({ name: "kira", amount: 35000, status: "paid" }), inst({ name: "kredi", amount: 190000 })],
    providerDist: [{ key: "Halk", amount: 250000 }],
    categoryDist: [{ key: "Kredi", amount: 300000 }],
    ownerDist: [{ key: "MAS", amount: 400000 }],
    checksInMonth: [mat({ amount: 100000 })],
    installmentsInMonth: [mat({ kind: "loan_installment", amount: 71744, label: "kredi" })],
    cashMonth: { opening: 100000, income: 1500000, expense: 1400000, closing: 200000 },
    dataQualityIssues: ["4 kalem tutar eksik"],
  });
  it("splits paid/unpaid and sums debt service (checks + installments)", () => {
    expect(r.paidUnpaidSplit).toEqual({ paid: 200000, remaining: 300000 });
    expect(r.debtServiceKnown).toBe(171744); // 100000 + 71744
    expect(r.bodyMd).toContain("# Aylık Rapor — 2026-07");
    expect(r.bodyMd).toContain("devir: 100.000 TL");
    expect(r.bodyMd).toContain("En büyük 10 ödeme");
  });
});

describe("overlayDebtService (borç-servisi × nakit-akış)", () => {
  const months = [
    { monthStart: "2026-07-01", closing: 200000 },
    { monthStart: "2026-08-01", closing: -50000 },
    { monthStart: "2026-09-01", closing: 500000 },
    { monthStart: "2026-10-01", closing: 100000 },
  ];
  const debt = [
    { monthStart: "2026-07-01", knownOutflow: 90000, count: 2, missingCount: 0 }, // >25% of 200k → watch
    { monthStart: "2026-08-01", knownOutflow: 71744, count: 1, missingCount: 0 }, // negative closing → high
    { monthStart: "2026-09-01", knownOutflow: 10000, count: 1, missingCount: 1 }, // <25% of 500k → watch (any debt)
    // 2026-10: no debt
  ];
  const rows = overlayDebtService(months, debt);
  it("pairs debt with closing and grades pressure; no-debt = none", () => {
    expect(rows.find((r) => r.monthStart === "2026-08-01")!.pressure).toBe("high");
    expect(rows.find((r) => r.monthStart === "2026-07-01")!.pressure).toBe("watch");
    expect(rows.find((r) => r.monthStart === "2026-09-01")!.pressure).toBe("watch");
    const oct = rows.find((r) => r.monthStart === "2026-10-01")!;
    expect(oct.pressure).toBe("none");
    expect(oct.debtOutflow).toBe(0);
    expect(oct.debtCount).toBe(0);
  });
  it("preserves month order and discloses missing debt amounts", () => {
    expect(rows.map((r) => r.monthStart)).toEqual([
      "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01",
    ]);
    expect(rows.find((r) => r.monthStart === "2026-09-01")!.debtMissingCount).toBe(1);
  });
});

describe("buildCommentaryPrompt (AI = commentary only)", () => {
  const p = buildCommentaryPrompt({
    scope: "daily", period: "2026-07-06",
    deterministicFacts: ["bugün 2 ödeme", "1 geciken kalem"],
  });
  it("is a prompt string forbidding mutation, carrying only given facts", () => {
    expect(p).toContain("hiçbir değeri değiştirme");
    expect(p).toContain("ödendi");
    expect(p).toContain("Kaynak-of-truth veritabanıdır");
    expect(p).toContain("- bugün 2 ödeme");
    expect(p).toContain("- 1 geciken kalem");
    // it must not embed any imperative to write/update the DB
    expect(p).not.toMatch(/update|insert|delete|mark.*paid.*now/i);
  });
});
