import { describe, expect, it } from "vitest";
import {
  classifyWorkbookChange,
  decisionConfidenceLabel,
  decisionConfidenceScore,
  normalizeActionStatus,
  rankReviewSignals,
  reviewActionTitle,
  type ReviewSignal,
} from "./rules";

const rows: ReviewSignal[] = [
  { id: "1", issue_type: "unlabeled_amount", severity: "medium", status: "open", message: "x", sheet_name: "mayis", row_index: 5, created_at: "2026-07-03" },
  { id: "2", issue_type: "duplicate_check", severity: "high", status: "resolved", message: "x", sheet_name: "CEKLER", row_index: 7, created_at: "2026-07-01" },
  { id: "3", issue_type: "missing_due_day", severity: "critical", status: "open", message: "x", sheet_name: "odeme", row_index: null, created_at: "2026-07-02" },
  { id: "4", issue_type: "amount_alignment", severity: "high", status: "open", message: "x", sheet_name: "haziran", row_index: 12, created_at: "2026-07-01" },
];

describe("data-quality rules", () => {
  it("ranks open high-severity blockers first", () => {
    expect(rankReviewSignals(rows).map((r) => r.id)).toEqual(["3", "4", "2", "1"]);
  });

  it("builds compact review action titles", () => {
    expect(reviewActionTitle(rows[0])).toBe("unlabeled_amount - mayis / r5");
    expect(reviewActionTitle(rows[2])).toBe("missing_due_day - odeme");
  });

  it("normalizes only known action statuses", () => {
    expect(normalizeActionStatus("done")).toBe("done");
    expect(normalizeActionStatus("paid")).toBeNull();
  });

  it("scores decision confidence with bounded penalties", () => {
    expect(decisionConfidenceScore({
      openReviewCount: 0,
      highOpenCount: 0,
      reconciliationSignalCount: 0,
      missingAmountCount: 0,
      staleProductionRateCount: 0,
      externalPendingCount: 0,
    })).toBe(100);
    const risky = decisionConfidenceScore({
      openReviewCount: 4,
      highOpenCount: 2,
      reconciliationSignalCount: 1,
      missingAmountCount: 8,
      staleProductionRateCount: 1,
      externalPendingCount: 1,
    });
    expect(risky).toBeLessThan(80);
    expect(decisionConfidenceLabel(risky)).not.toBe("guvenli");
  });

  it("classifies workbook changes by operational impact", () => {
    expect(classifyWorkbookChange("temmuz 2026")).toEqual({ area: "nakit akis", impact: "critical" });
    expect(classifyWorkbookChange("ODEME TABLOSU")).toEqual({ area: "odeme", impact: "high" });
    expect(classifyWorkbookChange("makine roi")).toEqual({ area: "uretim", impact: "medium" });
    expect(classifyWorkbookChange("notlar")).toEqual({ area: "bilinmeyen", impact: "low" });
  });
});
