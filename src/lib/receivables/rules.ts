// Faz 22 — receivables / payables domain rules. Pure & deterministic, no DB, no IO.
//
// All money arithmetic goes through @/lib/money. The allocation helpers below are the ones that
// most need it: splitting a payment across invoices is repeated subtraction, and doing that in
// floats is how a 12-invoice settlement ends up a kuruş short and leaves a phantom open item.

import { decimal, money, sumDecimal, type Decimal } from "@/lib/money";

/* ── ageing ───────────────────────────────────────────────────────────────────────────── */

export type CollectionBucket =
  | "tarihsiz" | "vadesi gelmemiş" | "1-7 gün" | "8-30 gün" | "31-60 gün" | "60+ gün";

/** The buckets in report order. Exported so a UI cannot invent its own ordering. */
export const COLLECTION_BUCKETS: readonly CollectionBucket[] = [
  "vadesi gelmemiş", "1-7 gün", "8-30 gün", "31-60 gün", "60+ gün", "tarihsiz",
] as const;

/**
 * Faz 22's collection-urgency ageing — 1-7 / 8-30 / 31-60 / 60+.
 *
 * DELIBERATELY DIFFERENT from Faz 21's `ageingBucket` (1-30/31-60/61-90/90+), and the two are
 * both kept because they answer different questions. Faz 21's is conventional AR *reporting*
 * ageing. This one splits the first month, because whether a customer is three days or three
 * weeks late changes what you do this morning, and it stops subdividing past 60 because by then
 * the action is the same regardless.
 *
 * Must return the same bucket as view `receivables_open` in migration 0050 for every input;
 * `phase22:verify` compares the two implementations against the same rows so they cannot drift.
 */
export function collectionBucket(dueDate: string | null, todayISO: string): CollectionBucket {
  if (!dueDate) return "tarihsiz";
  const days = Math.floor(
    (Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000,
  );
  if (days <= 0) return "vadesi gelmemiş";
  if (days <= 7) return "1-7 gün";
  if (days <= 30) return "8-30 gün";
  if (days <= 60) return "31-60 gün";
  return "60+ gün";
}

export interface AgeingRow {
  dueDate: string | null;
  openAmount: number;
}

export interface AgeingSummary {
  bucket: CollectionBucket;
  count: number;
  amount: number;
}

/**
 * Group open items into buckets.
 *
 * Every bucket is present in the output even when empty, so a report cannot silently omit
 * "60+ gün" simply because today there is nothing in it — an absent row and a zero row read
 * very differently to someone scanning for problems.
 */
export function summarizeAgeing(rows: AgeingRow[], todayISO: string): AgeingSummary[] {
  const byBucket = new Map<CollectionBucket, AgeingRow[]>();
  for (const b of COLLECTION_BUCKETS) byBucket.set(b, []);
  for (const r of rows) byBucket.get(collectionBucket(r.dueDate, todayISO))!.push(r);
  return COLLECTION_BUCKETS.map((bucket) => {
    const items = byBucket.get(bucket)!;
    return { bucket, count: items.length, amount: money(sumDecimal(items.map((i) => i.openAmount)).toString()) };
  });
}

/* ── DSO / DPO ────────────────────────────────────────────────────────────────────────── */

/**
 * Days Sales Outstanding.
 *
 *     DSO = (open receivables / credit sales in period) × period days
 *
 * Returns null rather than a number when there were no sales in the period. That is not
 * defensiveness: DSO with a zero denominator is undefined, and reporting it as 0 would say
 * "customers pay instantly" about a company that sold nothing — the most flattering possible
 * reading of the worst possible quarter. The same distinction money.ts's ratioOrNull draws.
 */
export function computeDSO(openReceivables: number, salesInPeriod: number, periodDays: number): number | null {
  if (periodDays <= 0) return null;
  const sales = decimal(salesInPeriod);
  if (sales.lte(0)) return null;
  return Number(decimal(openReceivables).div(sales).times(periodDays).round(1).toString());
}

/** Days Payables Outstanding — the same formula against purchases. */
export function computeDPO(openPayables: number, purchasesInPeriod: number, periodDays: number): number | null {
  if (periodDays <= 0) return null;
  const purchases = decimal(purchasesInPeriod);
  if (purchases.lte(0)) return null;
  return Number(decimal(openPayables).div(purchases).times(periodDays).round(1).toString());
}

/* ── allocation planning ──────────────────────────────────────────────────────────────── */

export interface AllocatableInvoice {
  invoiceId: string;
  /** gross − already allocated. Never negative; 0048 caps allocations at the invoice total. */
  openAmount: number;
  dueDate: string | null;
  issueDate: string;
}

export interface AllocationPlanLine {
  invoiceId: string;
  amount: number;
}

export interface AllocationPlan {
  lines: AllocationPlanLine[];
  allocated: number;
  /** Money left over after every candidate invoice is full. Never silently absorbed. */
  unallocated: number;
}

/**
 * Propose how to spread a settlement across open invoices, oldest due first.
 *
 * A PROPOSAL. Nothing here writes anything, and the engine requires an operator to confirm —
 * allocating money to the wrong invoice is exactly as wrong as not allocating it, and FIFO is a
 * convention rather than a fact about which invoice the counterparty intended to pay.
 *
 * The remainder is returned as `unallocated` instead of being forced onto the last invoice.
 * 0048 would refuse an over-allocation anyway, but surfacing it here means the operator sees
 * "10 TL left over" rather than a database error they have to decode.
 *
 * Arithmetic is decimal throughout: repeated subtraction across a dozen invoices is precisely
 * where float drift produces a 0.01 phantom balance.
 */
export function planAllocation(amount: number, invoices: AllocatableInvoice[]): AllocationPlan {
  let remaining = decimal(amount);
  const lines: AllocationPlanLine[] = [];

  const ordered = [...invoices]
    .filter((i) => decimal(i.openAmount).gt(0))
    .sort((a, b) => {
      // Undated invoices go last: without a due date there is no claim to urgency.
      if (a.dueDate === null && b.dueDate === null) return a.issueDate.localeCompare(b.issueDate);
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate);
    });

  for (const inv of ordered) {
    if (remaining.lte(0)) break;
    const open = decimal(inv.openAmount);
    const take = remaining.gte(open) ? open : remaining;
    lines.push({ invoiceId: inv.invoiceId, amount: money(take.toString()) });
    remaining = remaining.minus(take);
  }

  const allocated = sumDecimal(lines.map((l) => l.amount));
  return {
    lines,
    allocated: money(allocated.toString()),
    unallocated: money(decimal(amount).minus(allocated).toString()),
  };
}

/**
 * Would this allocation breach the invoice ceiling?
 *
 * A courtesy check so the UI can refuse before the database has to. Migration 0048's trigger
 * remains the authority — an application-level check is exactly what implementation.md §18 says
 * is NOT sufficient, so this must never be the only thing standing between a user and an
 * over-allocation.
 */
export function wouldExceedCeiling(
  grossAmount: number,
  alreadyAllocated: number,
  newAmount: number,
): boolean {
  return decimal(alreadyAllocated).plus(decimal(newAmount)).gt(decimal(grossAmount));
}

/** gross − allocated, floored at zero (0048 guarantees it cannot go below). */
export function openAmount(grossAmount: number, allocatedAmount: number): number {
  const open = decimal(grossAmount).minus(decimal(allocatedAmount));
  return money((open.lt(0) ? decimal(0) : open).toString());
}

/* ── current account ──────────────────────────────────────────────────────────────────── */

export interface LedgerMovement {
  movementDate: string;
  debitAmount: number;
  creditAmount: number;
}

/**
 * Running balance over a counterparty's movements, oldest first.
 *
 * Accumulated as a decimal and rounded once per step. A running balance is the single worst
 * place for float drift because the error compounds down the column and every later row
 * inherits it.
 */
export function runningBalance(movements: LedgerMovement[]): Array<LedgerMovement & { balance: number }> {
  let balance = decimal(0);
  return [...movements]
    .sort((a, b) => a.movementDate.localeCompare(b.movementDate))
    .map((m) => {
      balance = balance.plus(decimal(m.debitAmount)).minus(decimal(m.creditAmount));
      return { ...m, balance: money(balance.toString()) };
    });
}

export type { Decimal };
