export type DqSeverity = "critical" | "high" | "medium" | "low";
export type ActionStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

const SEVERITY_RANK: Record<DqSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_RANK: Record<string, number> = { open: 0, rejected: 1, accepted: 2, resolved: 3 };

export interface ReviewSignal {
  id: string;
  issue_type: string;
  severity: DqSeverity;
  status: string;
  message: string;
  sheet_name: string | null;
  row_index: number | null;
  created_at?: string | null;
}

export function rankReviewSignals<T extends ReviewSignal>(rows: T[], limit = 5): T[] {
  return [...rows]
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      const st = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (st !== 0) return st;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    })
    .slice(0, limit);
}

export function reviewActionTitle(r: ReviewSignal): string {
  const where = [r.sheet_name, r.row_index != null ? `r${r.row_index}` : null].filter(Boolean).join(" / ");
  return `${r.issue_type}${where ? ` - ${where}` : ""}`;
}

export function normalizeActionStatus(raw: string): ActionStatus | null {
  if (raw === "open" || raw === "in_progress" || raw === "blocked" || raw === "done" || raw === "cancelled") return raw;
  return null;
}
