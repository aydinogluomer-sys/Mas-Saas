// Payment radar domain rules (Phase 3). Pure & deterministic —
// sources: docs/calculation-rules.md + .claude/skills/mas-payment-risk-engine.

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function monthStartOf(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function addMonths(monthStartISO: string, delta: number): string {
  const [y, m] = monthStartISO.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

/** due_day 29–31 in shorter months → last day + short_month_adjustment flag. */
export function dueDateFor(
  monthStartISO: string,
  dueDay: number,
): { dueDate: string; shortMonthAdjusted: boolean } {
  const [y, m] = monthStartISO.split("-").map(Number);
  const dim = daysInMonth(y, m);
  const day = Math.min(dueDay, dim);
  return {
    dueDate: `${monthStartISO.slice(0, 8)}${String(day).padStart(2, "0")}`,
    shortMonthAdjusted: day !== dueDay,
  };
}

/* ── risk engine ── */

export interface RiskThresholds {
  large: number; // large_payment_threshold_try
  critical: number; // critical_payment_threshold_try
  clusterCount: number; // same_day_cluster_count
}

export interface RiskInputInstance {
  id: string;
  dueDate: string; // ISO
  amount: number | null;
  status: string; // 'unpaid' | 'paid' | ...
}

export type RiskReason =
  | "missing_amount"
  | "negative_amount"
  | "large_payment"
  | "critical_payment"
  | "same_day_cluster"
  | "overdue";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

const OPEN_STATUSES = new Set(["unpaid", "partial", "planned", "late"]);

export function isOpen(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * Risk ladder (deterministic, documented in calculation-rules.md):
 * critical_payment → critical; overdue → high;
 * large/cluster/negative → medium; missing_amount alone → low; else none.
 */
export function riskLevelOf(reasons: RiskReason[]): RiskLevel {
  if (reasons.includes("critical_payment")) return "critical";
  if (reasons.includes("overdue")) return "high";
  if (
    reasons.includes("large_payment") ||
    reasons.includes("same_day_cluster") ||
    reasons.includes("negative_amount")
  )
    return "medium";
  if (reasons.includes("missing_amount")) return "low";
  return "none";
}

export function computeRisk(
  instances: RiskInputInstance[],
  todayISO: string,
  t: RiskThresholds,
): Map<string, { reasons: RiskReason[]; level: RiskLevel }> {
  const openByDate = new Map<string, number>();
  for (const i of instances) {
    if (!isOpen(i.status)) continue;
    openByDate.set(i.dueDate, (openByDate.get(i.dueDate) ?? 0) + 1);
  }
  const out = new Map<string, { reasons: RiskReason[]; level: RiskLevel }>();
  for (const i of instances) {
    const reasons: RiskReason[] = [];
    if (isOpen(i.status)) {
      if (i.amount == null) reasons.push("missing_amount");
      else if (i.amount < 0) reasons.push("negative_amount");
      else {
        if (i.amount >= t.critical) reasons.push("critical_payment");
        else if (i.amount >= t.large) reasons.push("large_payment");
      }
      if ((openByDate.get(i.dueDate) ?? 0) >= t.clusterCount) reasons.push("same_day_cluster");
      if (i.dueDate < todayISO) reasons.push("overdue");
    }
    out.set(i.id, { reasons, level: riskLevelOf(reasons) });
  }
  return out;
}

/** Day-level flags for calendar/risk panels (calculation-rules thresholds). */
export function dayFlags(
  dayInstances: RiskInputInstance[],
  t: RiskThresholds,
): { cluster: boolean; large: boolean; critical: boolean; knownSum: number; count: number } {
  const open = dayInstances.filter((i) => isOpen(i.status));
  const knownSum = open.reduce((s, i) => s + (i.amount != null && i.amount > 0 ? i.amount : 0), 0);
  const anyCritical = open.some((i) => i.amount != null && i.amount >= t.critical);
  const anyLarge = open.some((i) => i.amount != null && i.amount >= t.large);
  return {
    count: open.length,
    knownSum,
    cluster: open.length >= t.clusterCount,
    large: anyLarge,
    critical: anyCritical || knownSum >= t.critical,
  };
}
