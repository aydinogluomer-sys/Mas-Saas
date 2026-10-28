// Faz 27 — credit facility rules. Pure, decimal, no database.
//
// The database is the authority on what a facility IS (migration 0064 holds the CHECK and the
// transition guard). This mirrors the same allow-list so the application can refuse a move with a
// sentence instead of a PostgreSQL exception, and `phase27:verify` executes both against real
// rows to prove they still agree.

import { decimal, moneyOrNull, ratioOrNull, type NumericInput } from "@/lib/money";

export const FACILITY_STATUSES = ["active", "suspended", "expired", "closed"] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

export const FACILITY_TYPES = [
  "revolving", "overdraft", "spot", "guarantee_letter", "letter_of_credit", "other",
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

/**
 * The eight permitted moves, identical to 0064's guard.
 *
 * Two are worth naming because leaving either out looks harmless and is not:
 *   suspended -> expired  a frozen facility still ages; without this every suspended line is
 *                         stranded once its term passes.
 *   expired   -> active   renewal. Banks renew annual limits routinely, and forcing a new row
 *                         instead would detach the facility from its own drawdown history.
 */
export const FACILITY_TRANSITIONS: ReadonlyArray<readonly [FacilityStatus, FacilityStatus]> = [
  ["active", "suspended"],
  ["active", "expired"],
  ["active", "closed"],
  ["suspended", "active"],
  ["suspended", "expired"],
  ["suspended", "closed"],
  ["expired", "active"],
  ["expired", "closed"],
] as const;

export function canTransition(from: FacilityStatus, to: FacilityStatus): boolean {
  if (from === to) return true;
  return FACILITY_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export interface FacilityUtilization {
  limitAmount: number;
  drawnAmount: number;
  availableAmount: number;
  /** null when the limit is zero — a ratio against nothing is undefined, not 0. */
  utilizationRatio: number | null;
  overLimit: boolean;
  /** PHASE 2.2 (#34): facility para biriminden farklı hareketler — kullanıma girmedi. */
  foreignMovementCount: number;
}

/**
 * Limit, drawn, available — computed, never stored.
 *
 * `available` is floored at zero and `overLimit` reports the breach separately. A negative
 * headroom propagating into a treasury total would silently reduce the group's available
 * liquidity by the size of someone's overdraft, which is the opposite of what an over-limit
 * facility means.
 */
export type FacilityMovement = NumericInput | { amount: NumericInput; currency?: string | null };

/**
 * PHASE 2.2 (#34): hareket bir para birimi taşıyorsa facility'nin para birimiyle eşleşmeli;
 * eşleşmeyen hareket kullanıma girmez ve `foreignMovementCount` ile sayılır (0094
 * `credit_facility_utilization.foreign_drawdown_count` ile aynı kural). Düz sayı geçen çağıran
 * (eski imza) yapısal olarak facility para biriminde sayılır.
 */
export function utilization(
  limit: NumericInput, movements: FacilityMovement[], facilityCurrency = "TRY",
): FacilityUtilization {
  const limitAmount = moneyOrNull(limit) ?? 0;
  let drawn = decimal(0);
  let foreignMovementCount = 0;
  for (const m of movements) {
    const isObj = typeof m === "object" && m !== null && "amount" in m;
    const cur = isObj ? (m as { currency?: string | null }).currency : undefined;
    if (cur !== undefined && cur !== facilityCurrency) { foreignMovementCount++; continue; }
    const v = moneyOrNull(isObj ? (m as { amount: NumericInput }).amount : (m as NumericInput));
    if (v !== null) drawn = drawn.plus(decimal(v));
  }
  const drawnAmount = Number(drawn.toFixed(2));
  const rawAvailable = Number(decimal(limitAmount).minus(drawn).toFixed(2));
  return {
    limitAmount,
    drawnAmount,
    availableAmount: Math.max(0, rawAvailable),
    utilizationRatio: limitAmount === 0 ? null : ratioOrNull(drawnAmount, limitAmount),
    overLimit: drawnAmount > limitAmount,
    foreignMovementCount,
  };
}

/** Signed movement value: a drawdown consumes limit, a repayment returns it. */
export function signedMovement(movementType: "drawdown" | "repayment", amount: NumericInput): number {
  const v = moneyOrNull(amount) ?? 0;
  return movementType === "drawdown" ? v : -v;
}

export const MATURITY_BUCKETS = [30, 90, 180, 365] as const;
export type MaturityBucket = (typeof MATURITY_BUCKETS)[number];

/** Which ladder bucket a date falls into; null when beyond a year or already past. */
export function maturityBucket(dueDateISO: string, todayISO: string): MaturityBucket | null {
  const days = Math.round(
    (Date.parse(`${dueDateISO}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return null;           // already due — belongs to overdue reporting, not a ladder
  if (days < 30) return 30;
  if (days < 90) return 90;
  if (days < 180) return 180;
  if (days < 365) return 365;
  return null;                          // beyond the ladder's horizon
}

/**
 * Cash exposure in a ladder bucket.
 *
 * Instalments plus only the DRAWN part of expiring facilities. Adding the whole limit would
 * overstate the outflow by every unused lira — an unused limit that expires costs nothing, it
 * simply stops being available.
 */
export function bucketExposure(installmentDue: NumericInput, facilityDrawnExpiring: NumericInput): number {
  const a = moneyOrNull(installmentDue) ?? 0;
  const b = moneyOrNull(facilityDrawnExpiring) ?? 0;
  return Number(decimal(a).plus(decimal(b)).toFixed(2));
}

export const FACILITY_STATUS_LABEL: Record<FacilityStatus, string> = {
  active: "aktif",
  suspended: "donduruldu",
  expired: "vadesi doldu",
  closed: "kapatıldı",
};

export const FACILITY_TYPE_LABEL: Record<FacilityType, string> = {
  revolving: "rotatif",
  overdraft: "KMH",
  spot: "spot",
  guarantee_letter: "teminat mektubu",
  letter_of_credit: "akreditif",
  other: "diğer",
};
