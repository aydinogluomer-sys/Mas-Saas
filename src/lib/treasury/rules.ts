// Faz 26 — treasury/liquidity rules. Pure, deterministic, no database.
//
// THIS EXTENDS THE FAZ 5 FORECAST, IT DOES NOT REPLACE IT.
//
// The plan is explicit that a parallel forecast engine must not be invented, so the monthly
// primitives are IMPORTED from @/lib/radar/rules rather than reimplemented here — `buildProjection`
// still answers "when does the balance first go negative across months", and this module adds the
// short-horizon question treasury actually asks: "will I clear my floor in the next 7, 30 and 90
// DAYS". Same obligations, same rules about unknown values, different window.
//
// The division is deliberate and worth stating, because the temptation was to write a second
// projection that happened to take days:
//   radar/rules.ts   months, from cashflow_months — the reviewed workbook projection.
//   this file        days,   from dated obligations — what is actually scheduled to move.
// Where they overlap they must agree, and `reconciliationVerdict` below is how a disagreement is
// reported rather than smoothed over.

import { addMonths, buildProjection, type CashMonth, type Projection } from "@/lib/radar/rules";
import { decimal, type NumericInput } from "@/lib/money";

/** The three treasury horizons. Days, not months — that is the whole point of this module. */
export const TREASURY_HORIZON_DAYS = [7, 30, 90] as const;
export type TreasuryHorizon = (typeof TREASURY_HORIZON_DAYS)[number];

export interface DatedFlow {
  /** ISO date the money is scheduled to move. */
  flowDate: string;
  /** Signed: positive is money in, negative is money out. */
  amountSigned: number;
  /** 'contracted' is an obligation; 'expected' is someone's stated intention (a promise). */
  certainty: "contracted" | "expected";
}

export type LiquidityHorizonStatus = "unknown_opening_balance" | "floor_breached" | "ok";

export interface LiquidityHorizon {
  horizonDays: TreasuryHorizon;
  fromDate: string;
  toDate: string;
  openingPosition: number;
  contractedNet: number;
  expectedNet: number;
  /** Position counting only obligations at horizon close — the conservative end-of-window figure. */
  projectedContracted: number;
  /** Lowest cumulative daily contracted balance anywhere inside [fromDate, toDate). */
  minIntraHorizonBalance?: number;
  /** Earliest ISO date within [fromDate, toDate) where minIntraHorizonBalance occurs. */
  worstDayISO?: string | null;
  /** Position also believing the promises — the optimistic answer. */
  projectedExpected: number;
  minCashFloor: number;
  /** Positive when the floor is breached at any day inside the horizon; zero otherwise. Never negative. */
  financingNeed: number;
  breachesFloor: boolean;
  flowCount: number;
  status?: Exclude<LiquidityHorizonStatus, "unknown_opening_balance">;
}

export interface NullableLiquidityHorizon {
  horizonDays: TreasuryHorizon;
  fromDate: string;
  toDate: string;
  openingPosition: number | null;
  contractedNet: number;
  expectedNet: number;
  /** Position counting only obligations — null when opening balance is unknown (FIN-03). */
  projectedContracted: number | null;
  /** Lowest cumulative daily contracted balance inside [fromDate, toDate) — null when opening is unknown. */
  minIntraHorizonBalance?: number | null;
  /** Earliest ISO date inside [fromDate, toDate) where minIntraHorizonBalance occurs. */
  worstDayISO?: string | null;
  /** Position also believing the promises — null when opening balance is unknown (FIN-03). */
  projectedExpected: number | null;
  minCashFloor: number;
  /** Positive when the floor is breached; null when opening balance is unknown (FIN-03). */
  financingNeed: number | null;
  breachesFloor: boolean | null;
  flowCount: number;
  status: LiquidityHorizonStatus;
}

/** Days between two ISO dates. */
export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round(
    (Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000,
  );
}

/** ISO date `days` after `fromISO`. */
export function addDays(fromISO: string, days: number): string {
  const d = new Date(`${fromISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the 7/30/90-day liquidity picture.
 *
 * The window is [today, today + N) — half-open, so a flow dated exactly N days out belongs to the
 * NEXT horizon rather than being counted twice. A flow dated today IS included: money moving this
 * morning is part of today's liquidity.
 *
 * Two projections are always returned rather than one blended figure. A treasurer deciding
 * whether to draw on an overdraft needs to know whether the comfortable number depends on
 * customers keeping their promises, and a single number cannot say that.
 *
 * FIN-03 (Faz 44): When `openingPosition` is null/empty ("unknown opening balance"), we preserve
 * `null` for `openingPosition`, `projectedContracted`, `projectedExpected`, `financingNeed`, and
 * `breachesFloor` (`status: "unknown_opening_balance"`) while still returning exact `contractedNet`
 * and `expectedNet` movement deltas.
 */
export function liquidityHorizons(input: {
  openingPosition: number | string;
  flows: DatedFlow[];
  todayISO: string;
  minCashFloor?: NumericInput;
  horizons?: readonly TreasuryHorizon[];
}): LiquidityHorizon[];
export function liquidityHorizons(input: {
  openingPosition: NumericInput;
  flows: DatedFlow[];
  todayISO: string;
  minCashFloor?: NumericInput;
  horizons?: readonly TreasuryHorizon[];
}): NullableLiquidityHorizon[];
export function liquidityHorizons(input: {
  openingPosition: NumericInput;
  flows: DatedFlow[];
  todayISO: string;
  minCashFloor?: NumericInput;
  horizons?: readonly TreasuryHorizon[];
}): Array<LiquidityHorizon | NullableLiquidityHorizon> {
  const openingKnown = input.openingPosition !== null
    && input.openingPosition !== undefined
    && input.openingPosition !== "";
  const opening = openingKnown ? Number(decimal(input.openingPosition).toFixed(2)) : null;
  const floor = Number(decimal(input.minCashFloor ?? 0).toFixed(2));
  const horizons = input.horizons ?? TREASURY_HORIZON_DAYS;

  return horizons.map((h) => {
    const toDate = addDays(input.todayISO, h);
    const inWindow = input.flows.filter(
      (f) => f.flowDate >= input.todayISO && f.flowDate < toDate,
    );
    const contractedNet = sum(inWindow.filter((f) => f.certainty === "contracted"));
    const expectedNet = sum(inWindow);

    if (opening === null) {
      return {
        horizonDays: h,
        fromDate: input.todayISO,
        toDate,
        openingPosition: null,
        contractedNet,
        expectedNet,
        projectedContracted: null,
        minIntraHorizonBalance: null,
        worstDayISO: null,
        projectedExpected: null,
        minCashFloor: floor,
        financingNeed: null,
        breachesFloor: null,
        flowCount: inWindow.length,
        status: "unknown_opening_balance",
      };
    }

    const contractedInWindow = inWindow.filter((f) => f.certainty === "contracted");
    const dailyContractedDelta = new Map<string, ReturnType<typeof decimal>>();
    for (const f of contractedInWindow) {
      const prev = dailyContractedDelta.get(f.flowDate) ?? decimal(0);
      dailyContractedDelta.set(f.flowDate, prev.plus(decimal(f.amountSigned)));
    }

    let running = decimal(opening);
    let minRunning: ReturnType<typeof decimal> | null = null;
    let worstDayISO: string | null = null;
    for (let dayOffset = 0; dayOffset < h; dayOffset += 1) {
      const dayISO = addDays(input.todayISO, dayOffset);
      const delta = dailyContractedDelta.get(dayISO);
      if (delta) running = running.plus(delta);
      if (minRunning === null || running.lt(minRunning)) {
        minRunning = running;
        worstDayISO = dayISO;
      }
    }

    const projectedContracted = Number(decimal(opening).plus(decimal(contractedNet)).toFixed(2));
    const projectedExpected = Number(decimal(opening).plus(decimal(expectedNet)).toFixed(2));
    const minIntraHorizonBalance = minRunning !== null
      ? Number(minRunning.toFixed(2))
      : projectedContracted;
    const breachesFloor = minIntraHorizonBalance < floor;
    const shortfall = Number(decimal(floor).minus(decimal(minIntraHorizonBalance)).toFixed(2));
    return {
      horizonDays: h,
      fromDate: input.todayISO,
      toDate,
      openingPosition: opening,
      contractedNet,
      expectedNet,
      projectedContracted,
      minIntraHorizonBalance,
      worstDayISO,
      projectedExpected,
      minCashFloor: floor,
      financingNeed: Math.max(0, shortfall),
      breachesFloor,
      flowCount: inWindow.length,
      status: breachesFloor ? "floor_breached" : "ok",
    };
  });
}

function sum(flows: DatedFlow[]): number {
  // Decimal accumulation: these are money amounts and a 90-day window can hold hundreds of rows,
  // which is exactly where float addition starts to drift (Faz 17/21).
  let total = decimal(0);
  for (const f of flows) total = total.plus(decimal(f.amountSigned));
  return Number(total.toFixed(2));
}
function round2(n: number): number {
  return Number(decimal(n).toFixed(2));
}

/**
 * The floor implied by a buffer-days policy: hold N days of average outflow.
 *
 * Returns null when there is no outflow history, and that null matters — defaulting to 0 would
 * silently turn "we cannot compute a buffer yet" into "no buffer is required", which is the more
 * dangerous of the two readings.
 */
export function bufferDaysFloor(
  averageDailyOutflow: NumericInput,
  bufferDays: number | null,
): number | null {
  if (bufferDays == null || bufferDays <= 0) return null;
  if (averageDailyOutflow == null || averageDailyOutflow === "") return null;
  const avg = decimal(averageDailyOutflow).abs();
  if (avg.eq(decimal(0))) return null;
  return Number(avg.times(decimal(bufferDays)).toFixed(2));
}

/**
 * Which floor actually applies when both policies are active.
 *
 * The HIGHER of the two, because they are both minimums and satisfying only the lower one would
 * leave the other breached. Either being null means "not configured", not "zero".
 */
export function effectiveFloor(minCash: number | null, bufferFloor: number | null): number | null {
  if (minCash == null && bufferFloor == null) return null;
  if (minCash == null) return bufferFloor;
  if (bufferFloor == null) return minCash;
  return Math.max(minCash, bufferFloor);
}

export type ReconciliationStatus =
  | "aligned"
  | "divergent"
  | "cashflow_missing"
  | "no_bank_movement"
  | "incomplete_opening_balance";

/**
 * Compare the treasury-derived month close against cashflow_months' reviewed closing balance.
 *
 * MIRRORS THE SQL IN 0063 / 0099 — the same labels and the same 1,00 TL tolerance. Duplicated on
 * purpose so the application can explain a divergence without re-querying, and
 * `phase26:verify` executes both against the same fixtures to prove they still agree.
 *
 * FIN-03 (0099): When any active TRY bank account has `opening_balance IS NULL` (`openingKnown === false`),
 * comparing running movements without an opening anchor against `cashflow_months.closing_balance`
 * produces a false P0 `'divergent'` alarm; we return `'incomplete_opening_balance'` with `null` difference.
 *
 * It reports; it never reconciles. The two figures come from different sources (a reviewed
 * workbook projection versus imported bank movements) and a difference is frequently legitimate —
 * a month whose statement has not been imported differs by the entire month. Silently preferring
 * one, averaging them, or "correcting" either would be inferring final truth from ambiguous rows,
 * which CLAUDE.md forbids outright.
 *
 * The tolerance is 1,00 TL and matches `findContinuityIssues`' existing rounding allowance, so
 * treasury does not invent a second definition of "close enough".
 */
export function reconciliationVerdict(
  cashflowClosing: number | null,
  treasuryClosing: number | null,
  openingKnown = true,
): { status: ReconciliationStatus; difference: number | null } {
  if (cashflowClosing == null) return { status: "cashflow_missing", difference: null };
  if (!openingKnown) return { status: "incomplete_opening_balance", difference: null };
  if (treasuryClosing == null) return { status: "no_bank_movement", difference: null };
  const difference = round2(treasuryClosing - cashflowClosing);
  return {
    status: Math.abs(difference) <= 1 ? "aligned" : "divergent",
    difference,
  };
}

/**
 * The monthly projection, unchanged, re-exported through treasury.
 *
 * Not a wrapper that adds behaviour — a deliberate seam. Treasury screens need the monthly view
 * next to the daily one, and importing it here rather than reimplementing it is what keeps the
 * promise that this phase extends Faz 5 instead of forking it.
 */
export function monthlyProjection(months: CashMonth[], negativeThreshold = 0): Projection {
  return buildProjection(months, negativeThreshold);
}

/** Month key helper, taken from the Faz 5 rules rather than rewritten. */
export function nextMonth(monthStartISO: string): string {
  return addMonths(monthStartISO, 1);
}

export const RECONCILIATION_LABEL: Record<ReconciliationStatus, string> = {
  aligned: "uyumlu",
  divergent: "SAPMA VAR",
  cashflow_missing: "nakit akış verisi yok",
  no_bank_movement: "banka hareketi yok",
  incomplete_opening_balance: "açılış bakiyesi eksik",
};
