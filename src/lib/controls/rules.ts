// Faz 31 — control and anomaly rules. Pure, deterministic, no database, no model.
//
// ═══ NO LLM IN THE CONTROL CHAIN ═══
//
// This module does not import @/lib/ai, and phase31:verify proves it with a negative control. The
// reason is not policy for its own sake: a control finding has to be reproducible by a second
// person running the same rules over the same rows. A severity that came out of a language model
// could not be defended to an auditor, and "the model thought it looked odd" is not a control.
//
// Every score below is arithmetic over named rules with fixed weights. There is no learned
// weighting, no distribution fitting, and no statistical library.

import { decimal, moneyOrNull, type NumericInput } from "@/lib/money";

/* ── alert lifecycle, mirroring migration 0076 ────────────────────────────────────────── */

export const ALERT_STATUSES = [
  "open", "acknowledged", "snoozed", "resolved", "false_positive",
] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/**
 * The eleven permitted moves, identical to 0076's guard.
 *
 * `snoozed -> open` is the one that must not be forgotten: a snooze EXPIRES. Leaving it out would
 * permanently silence every snoozed alert, which is precisely how an alerting system stops being
 * trusted.
 *
 * `false_positive` is a terminal outcome in its own right rather than a flavour of `resolved`.
 * Keeping them distinct is what makes a per-rule false-positive rate computable — the feedback
 * signal that tells you which control is crying wolf.
 */
export const ALERT_TRANSITIONS: ReadonlyArray<readonly [AlertStatus, AlertStatus]> = [
  ["open", "acknowledged"],
  ["open", "snoozed"],
  ["open", "resolved"],
  ["open", "false_positive"],
  ["acknowledged", "snoozed"],
  ["acknowledged", "resolved"],
  ["acknowledged", "false_positive"],
  ["snoozed", "open"],
  ["snoozed", "acknowledged"],
  ["snoozed", "resolved"],
  ["snoozed", "false_positive"],
] as const;

export function canTransition(from: AlertStatus, to: AlertStatus): boolean {
  if (from === to) return true;
  return ALERT_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export const ALERT_STATUS_LABEL: Record<AlertStatus, string> = {
  open: "açık",
  acknowledged: "görüldü",
  snoozed: "ertelendi",
  resolved: "çözüldü",
  false_positive: "yanlış alarm",
};

/* ── severity ─────────────────────────────────────────────────────────────────────────── */

export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  info: "bilgi", warning: "uyarı", critical: "kritik",
};

/** PASS when nothing was found; otherwise the control's own severity. */
export function controlState(severity: Severity, findingCount: number): "PASS" | "INFO" | "WARNING" | "CRITICAL" {
  if (findingCount === 0) return "PASS";
  return severity === "critical" ? "CRITICAL" : severity === "warning" ? "WARNING" : "INFO";
}

/* ── anomaly scoring ──────────────────────────────────────────────────────────────────── */

export const ANOMALY_RULES = [
  "round_number",
  "split_payment",
  "new_payee",
  "amount_vs_baseline",
  "unusual_record_hour",
  "approval_bypass",
  "iban_changed",
] as const;
export type AnomalyRule = (typeof ANOMALY_RULES)[number];

/**
 * Fixed weights, chosen by how strongly each signal indicates something worth a human look —
 * not learned, not tuned against outcomes.
 *
 * `approval_bypass` and `iban_changed` weigh heaviest because both describe a control being
 * circumvented rather than an unusual-looking number. `round_number` weighs least: plenty of
 * legitimate invoices are round.
 */
export const ANOMALY_WEIGHT: Record<AnomalyRule, number> = {
  approval_bypass: 0.40,
  iban_changed: 0.35,
  split_payment: 0.30,
  amount_vs_baseline: 0.20,
  new_payee: 0.15,
  unusual_record_hour: 0.10,
  round_number: 0.05,
};

export const ANOMALY_LABEL: Record<AnomalyRule, string> = {
  round_number: "Yuvarlak tutar",
  split_payment: "Bölünmüş ödeme",
  new_payee: "Yeni alıcı",
  amount_vs_baseline: "Geçmiş ortalamanın çok üstünde",
  unusual_record_hour: "Olağandışı kayıt saati",
  approval_bypass: "Onay atlanmış",
  iban_changed: "IBAN değişmiş",
};

export interface AnomalyAssessment {
  score: number;
  severity: Severity;
  rules: AnomalyRule[];
  /** Which rule contributed most — the headline reason. */
  primaryRule: AnomalyRule | null;
}

/**
 * Combine fired rules into one score.
 *
 * Weights are SUMMED and then clamped to 1, deliberately rather than averaged: three weak signals
 * together are more suspicious than any one of them, and averaging would dilute a stack of
 * findings into a smaller number than its largest single component — exactly backwards for a
 * detector whose job is to surface combinations.
 *
 * An empty rule set scores 0 and is `info`. It never produces an alert; a finding with no rule
 * behind it is not a finding.
 */
export function assessAnomaly(rules: AnomalyRule[]): AnomalyAssessment {
  const unique = [...new Set(rules)].sort();
  if (unique.length === 0) {
    return { score: 0, severity: "info", rules: [], primaryRule: null };
  }
  let total = decimal(0);
  for (const r of unique) total = total.plus(decimal(ANOMALY_WEIGHT[r]));
  const score = Math.min(1, Number(total.toFixed(4)));

  // Highest weight wins; the rule NAME breaks ties so the headline is reproducible.
  const primaryRule = [...unique].sort(
    (a, b) => (ANOMALY_WEIGHT[b] - ANOMALY_WEIGHT[a]) || (a < b ? -1 : a > b ? 1 : 0))[0];

  return { score, severity: severityForScore(score), rules: unique, primaryRule };
}

/** Fixed bands. Stated once so no screen invents its own colouring. */
export function severityForScore(score: number): Severity {
  if (score >= 0.5) return "critical";
  if (score >= 0.25) return "warning";
  return "info";
}

/* ── large / round-number helpers, used by both TS and the gate ───────────────────────── */

/**
 * Is this a suspiciously round large amount?
 *
 * Both conditions matter. Round SMALL numbers are ordinary (a 1.000 TL subscription); large
 * numbers that are not round are ordinary too. It is the combination that is worth a look.
 * Compared in decimal so a numeric string from pg is judged exactly.
 */
export function isRoundNumber(amount: NumericInput, minAmount = 10000, unit = 1000): boolean {
  const amt = moneyOrNull(amount);
  if (amt === null || amt < minAmount) return false;
  return decimal(amt).mod(decimal(unit)).eq(decimal(0));
}

/**
 * Do these same-day payments look like one payment split to stay under a threshold?
 *
 * Every part must be BELOW the threshold and the total AT OR ABOVE it. A single payment over the
 * threshold is not a split — it is just a large payment, which its own control already reports.
 */
export function isSplitPayment(amounts: NumericInput[], threshold: NumericInput): boolean {
  const limit = moneyOrNull(threshold);
  if (limit === null) return false;
  const values = amounts.map((a) => moneyOrNull(a)).filter((a): a is number => a !== null);
  if (values.length < 2) return false;
  if (values.some((v) => v >= limit)) return false;
  let total = decimal(0);
  for (const v of values) total = total.plus(decimal(v));
  return total.gte(decimal(limit));
}

/**
 * How many times the counterparty's own baseline this payment is.
 *
 * NULL when there is no usable baseline — a thin history is not evidence of normality, and
 * dividing by it would manufacture huge multiples from two data points. The caller decides the
 * minimum sample; this only refuses to divide by zero or by nothing.
 */
export function timesBaseline(amount: NumericInput, baselineAvg: NumericInput): number | null {
  const amt = moneyOrNull(amount);
  const avg = moneyOrNull(baselineAvg);
  if (amt === null || avg === null || avg <= 0) return null;
  return Number(decimal(amt).div(decimal(avg)).toFixed(2));
}

/* ── escalation ───────────────────────────────────────────────────────────────────────── */

/**
 * Is this alert due for escalation?
 *
 * Only OPEN alerts escalate. An acknowledged alert has been seen by a person — that is the whole
 * point of acknowledging — and a snoozed one was deliberately deferred. Escalating either would
 * punish the operator for responding.
 */
export function isEscalationDue(input: {
  status: AlertStatus;
  firstSeenAt: string;
  escalateAfterHours: number;
  nowISO: string;
}): boolean {
  if (input.status !== "open") return false;
  const ageMs = Date.parse(input.nowISO) - Date.parse(input.firstSeenAt);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= input.escalateAfterHours * 3_600_000;
}

/**
 * False-positive rate for one control.
 *
 * Counts only CLOSED alerts. Including open ones would make a control look accurate simply
 * because nobody had triaged it yet — the same "unmeasured is not perfect" trap Faz 28 avoided in
 * forecast accuracy. NULL when nothing has been closed, rather than 0.
 */
export function falsePositiveRate(resolvedCount: number, falsePositiveCount: number): number | null {
  const closed = resolvedCount + falsePositiveCount;
  if (closed <= 0) return null;
  return Number(decimal(falsePositiveCount).div(decimal(closed)).toFixed(4));
}
