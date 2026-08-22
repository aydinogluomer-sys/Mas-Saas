// Faz 21 — invoice domain rules. Pure & deterministic, no DB, no IO.
//
// All money arithmetic goes through @/lib/money. That is not ceremony: an invoice total is the
// one number a counterparty will argue about, and Faz 17 exists because `+=` on floats drifts.
// Line totals are summed as decimals and rounded ONCE, so the header always equals the sum of
// its lines to the kuruş rather than to within a rounding error.

import { normalizeTr } from "@/lib/importers/workbook-parser";
import { decimal, money, mul, sumDecimal, type Decimal } from "@/lib/money";

/* ── status ───────────────────────────────────────────────────────────────────────────── */

export type InvoiceStatus = "draft" | "open" | "partial" | "paid" | "closed" | "cancelled";
export type InvoiceDirection = "sales" | "purchase";

/**
 * The allow-list, mirroring migration 0044's guard.
 *
 * Duplicated in TypeScript so the application can refuse an impossible transition with a
 * message an operator can act on, instead of surfacing a raw trigger exception. The database
 * remains the authority — this is a courtesy layer, and `phase21:verify` proves the two agree
 * by enumerating every pair against real rows.
 */
export const INVOICE_TRANSITIONS: ReadonlyArray<readonly [InvoiceStatus, InvoiceStatus]> = [
  ["draft", "open"], ["draft", "cancelled"],
  ["open", "partial"], ["open", "paid"], ["open", "closed"], ["open", "cancelled"],
  ["partial", "paid"], ["partial", "open"], ["partial", "closed"], ["partial", "cancelled"],
  ["paid", "partial"], ["paid", "open"], ["paid", "closed"],
  ["closed", "open"],
] as const;

const TRANSITION_SET = new Set(INVOICE_TRANSITIONS.map(([a, b]) => `${a}>${b}`));

/** Same-status is always a no-op, for every value (0044's guard short-circuits it too). */
export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return from === to || TRANSITION_SET.has(`${from}>${to}`);
}

/** Statuses in which an invoice's commercial content may still be edited. Only one. */
export function isEditable(status: InvoiceStatus): boolean {
  return status === "draft";
}

/** Terminal: no transition leads out. */
export function isTerminal(status: InvoiceStatus): boolean {
  return !INVOICE_TRANSITIONS.some(([from]) => from === status);
}

/**
 * What the status SHOULD be given how much has been settled — a suggestion, never applied
 * automatically.
 *
 * Deliberately does not decide 'closed' or 'cancelled': both are human judgements (a write-off,
 * a void) that no amount of arithmetic can infer. Returns null when the current status is one
 * the payment total has no opinion about.
 */
export function suggestStatusFromPayment(
  current: InvoiceStatus,
  grossAmount: number,
  paidAmount: number,
): InvoiceStatus | null {
  if (current === "draft" || current === "cancelled" || current === "closed") return null;
  const gross = decimal(grossAmount);
  const paid = decimal(paidAmount);
  if (paid.lte(0)) return "open";
  // gte, not eq: an overpayment still means fully paid. 0044 allows paid_amount > gross on
  // purpose, and treating that as "still partial" would be absurd.
  if (paid.gte(gross)) return "paid";
  return "partial";
}

/* ── line arithmetic ──────────────────────────────────────────────────────────────────── */

export interface LineInput {
  quantity: number | string;
  unitPrice: number | string;
  /** Fraction, not percent: 0.20 for %20 KDV. */
  taxRate: number | string;
}

export interface LineTotals {
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

/**
 * quantity × unitPrice, then tax on the net.
 *
 * Rounded to TL scale ONCE per component, and gross is computed as net + tax rather than as
 * its own rounded product — otherwise the three numbers can disagree by a kuruş and violate
 * 0044's `gross = net + tax` CHECK. That constraint is the reason this function exists rather
 * than the arithmetic being inlined at each call site.
 */
export function computeLineTotals(line: LineInput): LineTotals {
  const net = mul(line.quantity, line.unitPrice);
  const netRounded = net.round(2);
  const tax = netRounded.times(decimal(line.taxRate)).round(2);
  return {
    netAmount: money(netRounded.toString()),
    taxAmount: money(tax.toString()),
    grossAmount: money(netRounded.plus(tax).toString()),
  };
}

/**
 * Sum line totals into a header.
 *
 * Summed as decimals and rounded once — the pattern Faz 17 established. Summing already-rounded
 * numbers with `+=` is how a 200-line invoice ends up a few kuruş away from its own lines.
 */
export function sumLineTotals(lines: LineTotals[]): LineTotals {
  const net = sumDecimal(lines.map((l) => l.netAmount));
  const tax = sumDecimal(lines.map((l) => l.taxAmount));
  return {
    netAmount: money(net.toString()),
    taxAmount: money(tax.toString()),
    grossAmount: money(net.plus(tax).toString()),
  };
}

/** Remaining balance. Negative means overpaid, and is returned as such rather than clamped. */
export function remainingAmount(grossAmount: number, paidAmount: number): number {
  return money(decimal(grossAmount).minus(decimal(paidAmount)).toString());
}

/* ── duplicate detection ──────────────────────────────────────────────────────────────── */

/**
 * Normalized invoice number for comparison.
 *
 * Suppliers write the same number as "FTR-2026-001", "ftr 2026 001" and "FTR2026001". Stripping
 * separators and case makes those one value. The RAW number is always kept on the row — this is
 * only a comparison key, never a replacement.
 */
export function normalizeInvoiceNo(raw: string): string {
  return normalizeTr(raw).replace(/[\s\-_./\\]/g, "");
}

/**
 * Fingerprint for the duplicate heuristic: counterparty + number + amount + date.
 *
 * Not a uniqueness key. 0044 indexes this column WITHOUT a unique constraint on purpose — an
 * invoice duplicate is a human or supplier error whose two rows may differ in ways that matter,
 * unlike a re-imported bank statement line where collapsing is correct. See 0044's note.
 */
export function invoiceDedupeKey(input: {
  partyId: string;
  invoiceNo: string;
  grossAmount: number | string;
  issueDate: string;
}): string {
  return [
    input.partyId,
    normalizeInvoiceNo(input.invoiceNo),
    decimal(input.grossAmount).round(2).toFixed(2),
    input.issueDate,
  ].join("|");
}

export type DuplicateSignal = "same_number" | "same_amount_and_date" | "near_match";

export interface DuplicateAssessment {
  isSuspect: boolean;
  signals: DuplicateSignal[];
  /** 0..1, an explainable sum of named signals — not a learned score. */
  confidence: number;
}

/**
 * Compare two invoices of the same counterparty and direction.
 *
 * Same-number is by far the strongest signal and alone is enough to flag. Amount+date together
 * are enough; either alone is not, for the same reason Faz 20's matcher requires two signals —
 * two invoices from one supplier in one month for the same round amount is ordinary, and so is
 * two invoices on one day for different things.
 */
export function assessDuplicate(
  a: { invoiceNo: string; grossAmount: number; issueDate: string },
  b: { invoiceNo: string; grossAmount: number; issueDate: string },
  dateWindowDays = 7,
): DuplicateAssessment {
  const signals: DuplicateSignal[] = [];
  let confidence = 0;

  if (normalizeInvoiceNo(a.invoiceNo) === normalizeInvoiceNo(b.invoiceNo)) {
    signals.push("same_number");
    confidence += 0.8;
  }

  const sameAmount = decimal(a.grossAmount).eq(decimal(b.grossAmount));
  const gap = Math.abs(Date.parse(`${a.issueDate}T00:00:00Z`) - Date.parse(`${b.issueDate}T00:00:00Z`)) / 86400000;
  if (sameAmount && gap <= dateWindowDays) {
    signals.push(gap === 0 ? "same_amount_and_date" : "near_match");
    confidence += gap === 0 ? 0.6 : 0.4;
  }

  confidence = Math.min(1, Math.round(confidence * 10000) / 10000);
  return { isSuspect: signals.length > 0, signals, confidence };
}

/* ── ageing ───────────────────────────────────────────────────────────────────────────── */

export type AgeingBucket = "tarihsiz" | "vadesi gelmemiş" | "1-30 gün" | "31-60 gün" | "61-90 gün" | "90+ gün";

/**
 * Must return the same bucket as 0047's `invoice_open_items` view.
 *
 * Two implementations of one rule is a drift risk, and it is accepted here for a reason: the
 * view buckets rows the database already has, while this function buckets a projection the UI
 * is holding. `phase21:verify` compares the two against the same data so they cannot diverge
 * unnoticed.
 */
export function ageingBucket(dueDate: string | null, todayISO: string): AgeingBucket {
  if (!dueDate) return "tarihsiz";
  const days = Math.floor(
    (Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000,
  );
  if (days <= 0) return "vadesi gelmemiş";
  if (days <= 30) return "1-30 gün";
  if (days <= 60) return "31-60 gün";
  if (days <= 90) return "61-90 gün";
  return "90+ gün";
}

export type { Decimal };
