import { describe, expect, it } from "vitest";
import { normalizeActionStatus, rankReviewSignals, reviewActionTitle, type ReviewSignal } from "./rules";

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
});
