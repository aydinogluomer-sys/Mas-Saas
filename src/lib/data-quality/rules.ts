export type DqSeverity = "critical" | "high" | "medium" | "low";
export type ActionStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type WorkbookChangeImpact = "critical" | "high" | "medium" | "low";

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

export interface DecisionConfidenceInput {
  openReviewCount: number;
  highOpenCount: number;
  reconciliationSignalCount: number;
  missingAmountCount: number;
  staleProductionRateCount: number;
  externalPendingCount: number;
}

export function decisionConfidenceScore(input: DecisionConfidenceInput): number {
  const penalty =
    input.highOpenCount * 14 +
    Math.max(0, input.openReviewCount - input.highOpenCount) * 3 +
    input.reconciliationSignalCount * 10 +
    Math.min(input.missingAmountCount, 20) * 2 +
    input.staleProductionRateCount * 5 +
    input.externalPendingCount * 4;
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function decisionConfidenceLabel(score: number): "guvenli" | "kontrollu" | "riskli" {
  if (score >= 80) return "guvenli";
  if (score >= 55) return "kontrollu";
  return "riskli";
}

export function classifyWorkbookChange(sheetName: string): { area: string; impact: WorkbookChangeImpact } {
  const s = sheetName.toLowerCase();
  if (s.includes("nakit") || s.includes("cash") || /^\d{4}-\d{2}/.test(s) || /(ocak|subat|şubat|mart|nisan|mayis|mayıs|haziran|temmuz|agustos|ağustos|eylul|eylül|ekim|kasim|kasım|aralik|aralık)/.test(s))
    return { area: "nakit akis", impact: "critical" };
  if (s.includes("odeme") || s.includes("ödeme") || s.includes("payment"))
    return { area: "odeme", impact: "high" };
  if (s.includes("cek") || s.includes("çek") || s.includes("kredi") || s.includes("faiz"))
    return { area: "finansman", impact: "high" };
  if (s.includes("kapasite") || s.includes("maliyet") || s.includes("roi") || s.includes("makine"))
    return { area: "uretim", impact: "medium" };
  if (s.includes("dashboard") || s.includes("rehber") || s.includes("ozet") || s.includes("özet"))
    return { area: "excel ozet", impact: "medium" };
  return { area: "bilinmeyen", impact: "low" };
}
