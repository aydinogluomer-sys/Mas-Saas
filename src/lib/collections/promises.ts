// Faz 25 — promise-to-pay rules. Pure, deterministic, no database.
//
// The database is the authority on what a promise IS (migration 0059 holds the CHECK and the
// transition guard). This module is the authority on what the application may ASK for, and the
// two are deliberately written to the same allow-list so `phase25:verify` can prove they agree.
// A promise is never marked kept or broken here — these functions only decide what is true; the
// engine performs the write, audited.

import { decimal, type NumericInput } from "@/lib/money";

export const PROMISE_STATUSES = ["pending", "kept", "broken", "cancelled"] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];

/**
 * The four permitted moves, mirroring 0059's guard exactly.
 *
 * `broken -> kept` is the one worth pointing at: a late payment is the ORDINARY outcome of a
 * broken promise, not a rare correction. Leaving it out would freeze every customer who paid a
 * few days late at 'broken' forever, and every score built on this table would understate them
 * permanently.
 *
 * kept and cancelled are terminal. A further commitment is a NEW promise — which is also what
 * an honest score should count, rather than a settled row quietly reopening.
 */
export const PROMISE_TRANSITIONS: ReadonlyArray<readonly [PromiseStatus, PromiseStatus]> = [
  ["pending", "kept"],
  ["pending", "broken"],
  ["pending", "cancelled"],
  ["broken", "kept"],
] as const;

/** Whether the guard would allow this move. Same-status is a no-op, not a transition. */
export function canTransition(from: PromiseStatus, to: PromiseStatus): boolean {
  if (from === to) return true;
  return PROMISE_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * Is this promise broken as of `todayISO`?
 *
 * Strictly AFTER the promised date, never on it. A promise made for the 15th is not broken at
 * 09:00 on the 15th — the money still has the whole day to arrive, and a job that marked it
 * broken that morning would be recording a failure that had not happened yet. That single `<`
 * versus `<=` is the entire correctness of the detection job.
 */
export function isBroken(
  status: PromiseStatus,
  promisedDateISO: string,
  todayISO: string,
): boolean {
  if (status !== "pending") return false;
  return promisedDateISO < todayISO;
}

/** Days past the promised date; negative while it is still in the future. */
export function daysLate(promisedDateISO: string, todayISO: string): number {
  const ms = Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${promisedDateISO}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Kept ratio over RESOLVED promises only.
 *
 * Returns null when nothing has resolved, and that null is load-bearing: a customer who has
 * never made a promise is not a customer who breaks them. Collapsing this to 0 would penalise
 * every new counterparty for having no history — absence of evidence read as evidence.
 * `cancelled` is excluded because a withdrawn promise says nothing about whether they pay.
 */
export function keptRatio(keptCount: number, brokenCount: number): number | null {
  const resolved = keptCount + brokenCount;
  if (resolved <= 0) return null;
  return keptCount / resolved;
}

export type ScoreBand = "good" | "watch" | "risk" | "critical";

/** Band thresholds, mirroring `customer_collection_score` in migration 0061. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 85) return "good";
  if (score >= 60) return "watch";
  if (score >= 35) return "risk";
  return "critical";
}

export const BAND_LABEL: Record<ScoreBand, string> = {
  good: "iyi",
  watch: "izlenmeli",
  risk: "riskli",
  critical: "kritik",
};

/**
 * The named deduction rules, mirroring 0061. Kept here so the application can EXPLAIN a score
 * without re-deriving it, and so the gate can prove both halves use the same names.
 */
export const SCORE_REASON_LABEL: Record<string, string> = {
  gecikmis_fatura_yasi: "Gecikmiş fatura yaşı",
  suepheli_alacak: "Şüpheli alacak kaydı",
  tutulmayan_odeme_sozu: "Tutulmayan ödeme sözü",
  gec_odeme_aliskanligi: "Geç ödeme alışkanlığı",
};

/**
 * Operator-facing text for a promise that has come due.
 *
 * An unknown amount is written as "tutar belirtilmedi", never as 0,00 TL — the reminder exists
 * to prompt a human, and telling them a customer promised nothing when the truth is that nobody
 * wrote the figure down would send them into the call with the wrong question.
 */
export function promiseReminderMessage(input: {
  partyName: string;
  promisedAmount: NumericInput;
  currency: string;
  promisedDateISO: string;
  todayISO: string;
}): string {
  const late = daysLate(input.promisedDateISO, input.todayISO);
  const amount =
    input.promisedAmount == null || input.promisedAmount === ""
      ? "tutar belirtilmedi"
      : `${decimal(input.promisedAmount).toFixed(2)} ${input.currency}`;
  const when =
    late > 0 ? `${late} gün geçti` : late === 0 ? "bugün vadesi" : `${Math.abs(late)} gün kaldı`;
  return `Ödeme sözü — ${input.partyName}: ${amount}, söz verilen tarih ${input.promisedDateISO} (${when}).`;
}

/** Title for the action_item a broken promise raises. */
export function brokenPromiseTitle(partyName: string, promisedDateISO: string): string {
  return `Tutulmayan ödeme sözü — ${partyName} (${promisedDateISO})`;
}

/**
 * Severity for that action_item, from how late and how large the promise was.
 *
 * A null amount does NOT downgrade the severity: an unknown figure could be the largest exposure
 * on the list, so it is treated as significant rather than ignorable.
 */
export function brokenPromiseSeverity(
  lateDays: number,
  amount: NumericInput,
): "low" | "medium" | "high" | "critical" {
  const big = amount == null || amount === "" ? true : decimal(amount).gte(decimal(100000));
  if (lateDays >= 30) return "critical";
  if (lateDays >= 14) return big ? "critical" : "high";
  if (lateDays >= 7) return big ? "high" : "medium";
  return big ? "medium" : "low";
}
