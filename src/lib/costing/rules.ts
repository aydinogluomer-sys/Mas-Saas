// Faz 30 — costing, profitability and working-capital rules. Pure, deterministic, decimal.
//
// ═══ THE MARGIN SEMANTICS ARE TEMPLATED FROM production/rules.ts ═══
//
// `partProfitability` already decided how this codebase computes a margin, and this module follows
// it rather than inventing a second convention:
//   margin      = revenue − cost, NULL when EITHER side is unknown (never 0)
//   marginRate  = margin / revenue, NULL when revenue is 0 or unknown (never 0, never ∞)
//   a confidence flag records that an input was missing
// The reason is not tidiness: a margin showing 0 because the cost was never recorded is
// indistinguishable from a genuine break-even, and this codebase already decided unknown stays
// unknown.
//
// This module does NOT import @/lib/ai — the one-directional rule Faz 28 established and the gate
// re-proves with a negative control.

import { decimal, divOrNull, moneyOrNull, rateOrNull, type NumericInput } from "@/lib/money";

/* ── profitability ────────────────────────────────────────────────────────────────────── */

export type Confidence = "estimated" | "needs_review";

export interface Profitability {
  revenue: number | null;
  cost: number | null;
  margin: number | null;
  marginRate: number | null;
  confidence: Confidence;
}

/**
 * Revenue − cost, with the NULL discipline the production engine established.
 *
 * An explicit ZERO revenue is measured and kept; it simply yields a null margin RATE, because a
 * ratio against nothing is undefined rather than 0. That distinction matters on a cost centre
 * that spent money and sold nothing: the margin is a real negative number, and only the
 * percentage is unknowable.
 */
export function profitability(revenue: NumericInput, cost: NumericInput): Profitability {
  const rev = moneyOrNull(revenue);
  const cst = moneyOrNull(cost);
  const known = rev !== null && cst !== null;
  const margin = known ? Number(decimal(rev).minus(decimal(cst)).toFixed(2)) : null;
  const marginRate =
    margin !== null && rev !== null && rev !== 0 ? rateOrNull(divOrNull(margin, rev)) : null;
  return {
    revenue: rev,
    cost: cst,
    margin,
    marginRate,
    confidence: known ? "estimated" : "needs_review",
  };
}

/* ── allocation ───────────────────────────────────────────────────────────────────────── */

export const ALLOCATION_BASES = [
  "machine_minutes", "revenue_share", "direct_cost", "equal_split", "fixed_percent",
] as const;
export type AllocationBasis = (typeof ALLOCATION_BASES)[number];

export const COST_KINDS = ["common", "machine", "personnel", "energy", "project"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const BASIS_LABEL: Record<AllocationBasis, string> = {
  machine_minutes: "makine dakikası",
  revenue_share: "ciro payı",
  direct_cost: "doğrudan maliyet",
  equal_split: "eşit bölüşüm",
  fixed_percent: "sabit yüzde",
};

export const COST_KIND_LABEL: Record<CostKind, string> = {
  common: "ortak gider",
  machine: "makine",
  personnel: "personel",
  energy: "enerji",
  project: "proje",
};

export interface AllocationTarget {
  /** Stable identifier; also the deterministic tiebreak when driver values are equal. */
  id: string;
  label: string;
  /** The driver value for the chosen basis — minutes, revenue, direct cost, or a share. */
  driver: NumericInput;
}

export interface AllocationShare {
  id: string;
  label: string;
  driver: number;
  /** Fraction of the total this target receives, 0..1. */
  share: number;
  amount: number;
}

/**
 * Spread a cost across targets by a driver.
 *
 * THE KURUŞ PROBLEM, handled rather than ignored: splitting 100,00 three ways gives 33,33 each,
 * and 33,33 × 3 = 99,99. One kuruş has to go somewhere or the allocation silently loses money —
 * over a year of monthly overhead runs that is a real, unexplainable drift in every cost centre.
 * The remainder is therefore given to the LARGEST share (ties broken by id, so the choice is
 * reproducible), and `allocate` guarantees the parts sum EXACTLY to the input.
 *
 * A zero or negative total driver yields an empty allocation rather than dividing by zero — the
 * caller learns nothing could be allocated instead of receiving NaNs.
 */
export function allocate(totalCost: NumericInput, targets: AllocationTarget[]): AllocationShare[] {
  const total = moneyOrNull(totalCost);
  if (total === null || targets.length === 0) return [];

  const drivers = targets.map((t) => ({ ...t, driverValue: moneyOrNull(t.driver) ?? 0 }));
  let driverSum = decimal(0);
  for (const d of drivers) driverSum = driverSum.plus(decimal(d.driverValue));
  if (driverSum.lte(decimal(0))) return [];

  // Deterministic order: largest driver first, id as the total-order tiebreak so equal drivers
  // never depend on input order (the Faz 29 lesson about comparators).
  const ordered = [...drivers].sort(
    (a, b) => (b.driverValue - a.driverValue) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const shares: AllocationShare[] = ordered.map((d) => {
    const share = rateOrNull(divOrNull(d.driverValue, Number(driverSum.toString()))) ?? 0;
    const amount = Number(decimal(total).times(decimal(share)).toFixed(2));
    return { id: d.id, label: d.label, driver: d.driverValue, share, amount };
  });

  // Give the rounding remainder to the largest share, which is `shares[0]` by construction.
  let allocated = decimal(0);
  for (const s of shares) allocated = allocated.plus(decimal(s.amount));
  const remainder = Number(decimal(total).minus(allocated).toFixed(2));
  if (remainder !== 0 && shares.length > 0) {
    shares[0].amount = Number(decimal(shares[0].amount).plus(decimal(remainder)).toFixed(2));
  }
  return shares;
}

/** Sum of an allocation — exposed so a caller can assert the invariant cheaply. */
export function allocationTotal(shares: AllocationShare[]): number {
  let total = decimal(0);
  for (const s of shares) total = total.plus(decimal(s.amount));
  return Number(total.toFixed(2));
}

/* ── working capital ──────────────────────────────────────────────────────────────────── */

export const DAYS_IN_YEAR = 365;

/**
 * Days Sales Outstanding: open receivables ÷ average daily sales.
 *
 * NULL on a zero or unknown denominator, never 0 and never infinity. A DSO of 0 would read as
 * "customers pay instantly", which is the opposite of what "we have no sales history" means.
 */
export function dso(receivablesOpen: NumericInput, sales365: NumericInput): number | null {
  return perDay(receivablesOpen, sales365);
}

/** Days Payables Outstanding — the mirror of DSO. */
export function dpo(payablesOpen: NumericInput, purchases365: NumericInput): number | null {
  return perDay(payablesOpen, purchases365);
}

function perDay(balance: NumericInput, annualFlow: NumericInput): number | null {
  const bal = moneyOrNull(balance);
  const flow = moneyOrNull(annualFlow);
  if (bal === null || flow === null || flow === 0) return null;
  const perDayFlow = decimal(flow).div(decimal(DAYS_IN_YEAR));
  if (perDayFlow.eq(decimal(0))) return null;
  return Number(decimal(bal).div(perDayFlow).toFixed(1));
}

export interface CashCycle {
  dsoDays: number | null;
  dioDays: number | null;
  dpoDays: number | null;
  /** NULL whenever any term is unknown — see the note below. */
  cashConversionCycleDays: number | null;
  /** DSO − DPO. Always named for what it leaves out. */
  cycleExcludingInventory: number | null;
  unmeasurableReason: string | null;
}

/**
 * The cash conversion cycle: DSO + DIO − DPO.
 *
 * DIO IS ALWAYS UNKNOWN IN THIS SYSTEM, and that is measured rather than assumed: the schema has
 * no inventory at all — no stock table, no on-hand column, nothing recording goods held. So CCC
 * returns NULL with a reason.
 *
 * The tempting shortcut is to treat DIO as 0. That would shorten the cycle by exactly the number
 * of days this business holds material, making working capital look BETTER than reality — the
 * most dangerous direction for this particular metric to be wrong in. `cycleExcludingInventory`
 * is offered instead, named for precisely what it omits, so the computable part stays useful
 * without anything pretending to be CCC.
 */
export function cashCycle(
  dsoDays: number | null, dioDays: number | null, dpoDays: number | null,
): CashCycle {
  const excl =
    dsoDays === null || dpoDays === null
      ? null
      : Number(decimal(dsoDays).minus(decimal(dpoDays)).toFixed(1));

  if (dsoDays === null || dioDays === null || dpoDays === null) {
    return {
      dsoDays, dioDays, dpoDays,
      cashConversionCycleDays: null,
      cycleExcludingInventory: excl,
      unmeasurableReason:
        dioDays === null ? "dio_unknown" : dsoDays === null ? "dso_unknown" : "dpo_unknown",
    };
  }
  return {
    dsoDays, dioDays, dpoDays,
    cashConversionCycleDays: Number(
      decimal(dsoDays).plus(decimal(dioDays)).minus(decimal(dpoDays)).toFixed(1)),
    cycleExcludingInventory: excl,
    unmeasurableReason: null,
  };
}

/**
 * A plain-language reading of the working-capital position.
 *
 * Deterministic bands, no scoring model. Longer is worse: money spends more days tied up between
 * paying a supplier and being paid by a customer.
 */
export function cycleVerdict(cycleDays: number | null): "unknown" | "strong" | "normal" | "stretched" {
  if (cycleDays === null) return "unknown";
  if (cycleDays <= 0) return "strong";
  if (cycleDays <= 45) return "normal";
  return "stretched";
}

export const CYCLE_VERDICT_LABEL: Record<ReturnType<typeof cycleVerdict>, string> = {
  unknown: "hesaplanamıyor",
  strong: "güçlü",
  normal: "normal",
  stretched: "gergin",
};
