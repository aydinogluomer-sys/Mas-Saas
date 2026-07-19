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
  paidAmount?: number | null;
}

export type RiskReason =
  | "missing_amount"
  | "negative_amount"
  | "large_payment"
  | "critical_payment"
  | "same_day_cluster"
  | "overdue"
  | "overpaid";

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
    reasons.includes("negative_amount") ||
    reasons.includes("overpaid")
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
    // paid/partial only — amount unknown or negative is not comparable, never flagged as overpaid
    if (
      (i.status === "paid" || i.status === "partial") &&
      i.amount != null &&
      i.paidAmount != null &&
      i.amount >= 0 &&
      i.paidAmount > i.amount
    ) {
      reasons.push("overpaid");
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

/* ═══════════ Phase 4 — cashflow rules (pure) ═══════════ */

export interface CashMonth {
  monthStart: string; // YYYY-MM-01
  opening: number | null;
  income: number | null;
  expense: number | null;
  closing: number | null;
}

export interface ContinuityBreak {
  prevMonth: string;
  nextMonth: string;
  prevClosing: number | null;
  nextOpening: number | null;
  diff: number | null; // null when either side unknown
}

/** Flags breaks & gaps. NEVER mutates values (rule: flag, don't fix). */
export function findContinuityIssues(months: CashMonth[]): {
  breaks: ContinuityBreak[];
  gaps: Array<{ afterMonth: string; expected: string }>;
} {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  const breaks: ContinuityBreak[] = [];
  const gaps: Array<{ afterMonth: string; expected: string }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const expected = addMonths(a.monthStart, 1);
    if (b.monthStart !== expected) {
      gaps.push({ afterMonth: a.monthStart, expected });
      continue; // chain comparison only meaningful for consecutive months
    }
    if (a.closing == null || b.opening == null) {
      breaks.push({
        prevMonth: a.monthStart, nextMonth: b.monthStart,
        prevClosing: a.closing, nextOpening: b.opening, diff: null,
      });
    } else if (Math.abs(a.closing - b.opening) > 1) {
      breaks.push({
        prevMonth: a.monthStart, nextMonth: b.monthStart,
        prevClosing: a.closing, nextOpening: b.opening,
        diff: b.opening - a.closing,
      });
    }
  }
  return { breaks, gaps };
}

export interface Projection {
  series: Array<{ monthStart: string; closing: number | null; delta: number | null }>;
  firstNegativeMonth: string | null;
  worstMonth: string | null;
  worstBalance: number | null;
  longestNegativeRun: { length: number; from: string | null };
}

export function buildProjection(months: CashMonth[], negativeThreshold = 0): Projection {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  let firstNegativeMonth: string | null = null;
  let worstMonth: string | null = null;
  let worstBalance: number | null = null;
  let run = 0, best = 0, runFrom: string | null = null, bestFrom: string | null = null;
  const series = sorted.map((m) => {
    const delta = m.income != null && m.expense != null ? m.income - m.expense : null;
    if (m.closing != null) {
      if (m.closing < negativeThreshold && firstNegativeMonth == null) firstNegativeMonth = m.monthStart;
      if (worstBalance == null || m.closing < worstBalance) {
        worstBalance = m.closing;
        worstMonth = m.monthStart;
      }
      if (m.closing < 0) {
        if (run === 0) runFrom = m.monthStart;
        run++;
        if (run > best) { best = run; bestFrom = runFrom; }
      } else run = 0;
    } else run = 0; // unknown breaks a negative run (honest: can't claim continuity)
    return { monthStart: m.monthStart, closing: m.closing, delta };
  });
  return { series, firstNegativeMonth, worstMonth, worstBalance, longestNegativeRun: { length: best, from: bestFrom } };
}

export interface HorizonCard {
  horizonMonths: number;
  fromMonth: string;
  toMonth: string; // last month with data inside horizon
  endClosing: number | null;
  minClosing: number | null;
  minMonth: string | null;
  knownIncome: number;
  knownExpense: number;
  missingCount: number; // months lacking income or expense inside window
  firstNegativeInside: string | null;
  truncated: boolean; // data ends before horizon
}

export function horizonCards(
  months: CashMonth[],
  anchorMonthStart: string,
  horizons: number[] = [3, 6, 12, 24, 36],
): HorizonCard[] {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  const startIdx = sorted.findIndex((m) => m.monthStart >= anchorMonthStart);
  const from = startIdx === -1 ? sorted[0]?.monthStart : sorted[startIdx].monthStart;
  return horizons.map((h) => {
    const endExclusive = addMonths(from, h);
    const win = sorted.filter((m) => m.monthStart >= from && m.monthStart < endExclusive);
    let minClosing: number | null = null, minMonth: string | null = null, firstNeg: string | null = null;
    let knownIncome = 0, knownExpense = 0, missingCount = 0;
    for (const m of win) {
      if (m.income == null || m.expense == null) missingCount++;
      if (m.income != null) knownIncome += m.income;
      if (m.expense != null) knownExpense += m.expense;
      if (m.closing != null) {
        if (m.closing < 0 && firstNeg == null) firstNeg = m.monthStart;
        if (minClosing == null || m.closing < minClosing) { minClosing = m.closing; minMonth = m.monthStart; }
      }
    }
    const last = win[win.length - 1];
    return {
      horizonMonths: h, fromMonth: from, toMonth: last?.monthStart ?? from,
      endClosing: last?.closing ?? null, minClosing, minMonth,
      knownIncome, knownExpense, missingCount,
      firstNegativeInside: firstNeg,
      truncated: win.length < h,
    };
  });
}

export interface ConcentrationEntry { key: string; sum: number; ratio: number; flagged: boolean }
export function concentration(
  items: Array<{ key: string | null; amount: number | null }>,
  flagRatio = 0.4,
): { entries: ConcentrationEntry[]; knownTotal: number; unknownCount: number } {
  const sums = new Map<string, number>();
  let knownTotal = 0, unknownCount = 0;
  for (const it of items) {
    if (it.amount == null) { unknownCount++; continue; }
    const v = Math.max(it.amount, 0);
    if (v === 0) continue;
    knownTotal += v;
    const k = it.key ?? "(atanmadı)";
    sums.set(k, (sums.get(k) ?? 0) + v);
  }
  const entries = [...sums.entries()]
    .map(([key, sum]) => ({ key, sum, ratio: knownTotal > 0 ? sum / knownTotal : 0, flagged: false }))
    .sort((a, b) => b.sum - a.sum)
    .map((e) => ({ ...e, flagged: e.ratio > flagRatio }));
  return { entries, knownTotal, unknownCount };
}
