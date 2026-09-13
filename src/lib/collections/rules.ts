// Faz 23 — collection risk and payment prioritisation. Pure & deterministic, no DB, no IO.
//
// EXPLICITLY NOT A MODEL. implementation.md asks for "deterministik sezgi (ML değil)", and the
// reason is not squeamishness about statistics: a finance operator deciding whether to chase a
// customer needs an answer to "why", and the only kind of scorer that can answer it is a table
// of named rules with fixed weights. Every function here returns the names of the signals that
// fired alongside its number, and `phase23:verify` asserts that a verdict never arrives without
// them.
//
// NOTHING HERE MARKS ANYTHING. These functions produce opinions. Writing a bad-debt flag is a
// separate, audited operator action (`markBadDebt`), and no score anywhere is wired to it —
// CLAUDE.md reserves that judgement for a human, and migration 0051 says the same in SQL.

import { decimal, money, rate } from "@/lib/money";
import { isReportingCurrency, sumKnownReporting } from "@/lib/currency-policy";

/* ── expected collection date ─────────────────────────────────────────────────────────── */

export interface CollectionSignals {
  dueDate: string | null;
  issueDate: string;
  daysOverdue: number | null;
  openAmount: number;
  badDebtFlagged: boolean;
  /** Observed average days from issue to settlement for this counterparty. null = no history. */
  partyAvgDaysToSettle: number | null;
  partySettledCount: number;
  /** Observed share of this counterparty's settled invoices that were late. null = no history. */
  partyLateRatio: number | null;
  partyInvoiceCount: number;
  partiallySettled: boolean;
}

export interface ExpectedCollection {
  expectedDate: string | null;
  /** Which rule produced the date — never a bare number. */
  basis: "party_history" | "due_date" | "issue_date_fallback" | "unknown";
  /** Days from today; negative means the estimate is already in the past. */
  daysFromToday: number | null;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
}

/**
 * When this invoice is realistically expected to be collected.
 *
 * Rule order, first match wins:
 *   1. The counterparty has settled at least 3 invoices → issue date + their observed average.
 *      Three is a deliberate floor: an average over one invoice is an anecdote, and dressing it
 *      up as a forecast is exactly the false confidence this phase is supposed to avoid.
 *   2. There is a due date → the due date. The counterparty's own promise is the next best
 *      evidence available.
 *   3. Neither → issue date + 30 as a stated convention, labelled as a fallback so a reader
 *      knows it is not evidence.
 *
 * The result is never earlier than today for an unpaid invoice: an "expected" date in the past
 * is not an expectation, it is an overdue notice, and clamping keeps the column meaning one
 * thing. `basis` always says which rule fired.
 */
export function expectedCollectionDate(s: CollectionSignals, todayISO: string): ExpectedCollection {
  let expected: string | null = null;
  let basis: ExpectedCollection["basis"] = "unknown";

  if (s.partyAvgDaysToSettle != null && s.partySettledCount >= 3) {
    expected = addDays(s.issueDate, Math.round(s.partyAvgDaysToSettle));
    basis = "party_history";
  } else if (s.dueDate) {
    expected = s.dueDate;
    basis = "due_date";
  } else {
    expected = addDays(s.issueDate, 30);
    basis = "issue_date_fallback";
  }

  if (expected < todayISO) expected = todayISO;
  return { expectedDate: expected, basis, daysFromToday: daysBetween(todayISO, expected) };
}

/* ── collection probability ───────────────────────────────────────────────────────────── */

export type ProbabilitySignal =
  | "bad_debt_flagged" | "not_yet_due" | "overdue_1_7" | "overdue_8_30" | "overdue_31_60"
  | "overdue_60_plus" | "party_pays_late" | "party_pays_on_time" | "partially_settled"
  | "no_party_history";

export interface CollectionProbability {
  /** 0..1, rounded to 2 decimals. */
  probability: number;
  /** Every signal that moved the number, in the order applied. Never empty. */
  signals: ProbabilitySignal[];
  band: "yüksek" | "orta" | "düşük" | "çok düşük";
}

/**
 * The rule table. Order is the specification — a bad-debt flag short-circuits everything below
 * it, and the ageing rules are mutually exclusive by construction.
 *
 * The weights are starting points, not measurements, and they are named constants so that
 * changing one is a visible, reviewable diff rather than a tweak buried in an expression.
 */
export const PROBABILITY_BASE = 0.95;
export const PROBABILITY_ADJUSTMENTS: Record<ProbabilitySignal, number> = {
  // A human has said this is probably uncollectable. Not zero: flagged debt does get recovered,
  // and a hard zero would tell the collections list to stop trying.
  bad_debt_flagged: -0.85,
  not_yet_due: 0,
  overdue_1_7: -0.05,
  overdue_8_30: -0.15,
  overdue_31_60: -0.3,
  overdue_60_plus: -0.5,
  // Observed behaviour, applied on top of ageing.
  party_pays_late: -0.1,
  party_pays_on_time: +0.05,
  // Money already arrived against this invoice — the counterparty is engaging.
  partially_settled: +0.1,
  // Absence of history lowers confidence slightly rather than being treated as good news.
  no_party_history: -0.05,
};

/** Above this share of late settlements a counterparty counts as "pays late". */
export const LATE_RATIO_THRESHOLD = 0.4;

/**
 * Deterministic collection probability.
 *
 * Returns the signals that produced it, always. A number without its reasons is not actionable
 * — the operator cannot tell whether 0.45 means "this customer is slow" or "we flagged it last
 * week", and those call for opposite responses.
 */
export function collectionProbability(s: CollectionSignals): CollectionProbability {
  const signals: ProbabilitySignal[] = [];
  let p = decimal(PROBABILITY_BASE);

  const apply = (sig: ProbabilitySignal) => {
    signals.push(sig);
    p = p.plus(decimal(PROBABILITY_ADJUSTMENTS[sig]));
  };

  if (s.badDebtFlagged) apply("bad_debt_flagged");

  const overdue = s.daysOverdue ?? 0;
  if (overdue <= 0) apply("not_yet_due");
  else if (overdue <= 7) apply("overdue_1_7");
  else if (overdue <= 30) apply("overdue_8_30");
  else if (overdue <= 60) apply("overdue_31_60");
  else apply("overdue_60_plus");

  if (s.partyLateRatio == null || s.partyInvoiceCount < 3) apply("no_party_history");
  else if (s.partyLateRatio > LATE_RATIO_THRESHOLD) apply("party_pays_late");
  else apply("party_pays_on_time");

  if (s.partiallySettled) apply("partially_settled");

  // Clamp to a probability. A floor of 0.01 rather than 0: as long as the debt exists, so does
  // some chance of collecting it, and 0 would read as "written off" — which is a decision only
  // a person makes.
  const clamped = p.lt(0.01) ? decimal(0.01) : p.gt(1) ? decimal(1) : p;
  const probability = rate(clamped.round(2).toString());

  return {
    probability,
    signals,
    band: probability >= 0.8 ? "yüksek" : probability >= 0.5 ? "orta" : probability >= 0.2 ? "düşük" : "çok düşük",
  };
}

/* ── risk flags ───────────────────────────────────────────────────────────────────────── */

export type RiskFlag =
  | "vadesi_geçmiş" | "ağır_gecikme" | "şüpheli_alacak" | "yoğunlaşma" | "kısmi_tahsilat_durdu"
  | "geçmişi_kötü" | "tarihsiz_vade";

export interface RiskAssessment {
  flags: RiskFlag[];
  severity: "yok" | "izle" | "yüksek" | "kritik";
}

/**
 * Flags an operator should see, computed from facts only.
 *
 * `concentrationRatio` is this invoice's share of all open receivables — passed in rather than
 * derived here, because it depends on the whole portfolio and this function must stay pure.
 * The 0.40 threshold is the same one the rest of the codebase already uses for concentration
 * (radar/rules.ts, financing/rules.ts), rather than a second number meaning almost the same.
 */
export function assessRisk(s: CollectionSignals, concentrationRatio: number | null): RiskAssessment {
  const flags: RiskFlag[] = [];
  const overdue = s.daysOverdue ?? 0;

  if (s.badDebtFlagged) flags.push("şüpheli_alacak");
  if (overdue > 0) flags.push("vadesi_geçmiş");
  if (overdue > 60) flags.push("ağır_gecikme");
  if (s.dueDate == null) flags.push("tarihsiz_vade");
  if (concentrationRatio != null && concentrationRatio > 0.4) flags.push("yoğunlaşma");
  if (s.partyLateRatio != null && s.partyInvoiceCount >= 3 && s.partyLateRatio > LATE_RATIO_THRESHOLD) {
    flags.push("geçmişi_kötü");
  }
  // Partial settlement that then stalled past the due date reads differently from a plain
  // overdue invoice: the counterparty engaged and then stopped.
  if (s.partiallySettled && overdue > 30) flags.push("kısmi_tahsilat_durdu");

  const severity: RiskAssessment["severity"] =
    s.badDebtFlagged || overdue > 60 ? "kritik"
      : overdue > 30 || flags.includes("yoğunlaşma") ? "yüksek"
      : overdue > 0 || flags.includes("geçmişi_kötü") ? "izle"
      : "yok";

  return { flags, severity };
}

/* ── cash-aware payment scheduling ────────────────────────────────────────────────────── */

export interface PayableItem {
  kind: string;
  entityId: string;
  dueDate: string;
  label: string;
  /** null = unknown, which is NOT zero. */
  amount: number | null;
  flexibilityClass: string;
  priorityRank: number;
  /** PHASE 2.2 (#57): `null` = bilinmiyor; TRY-dışı kalem TRY nakitle KARŞILANAMAZ — sıralanır, toplanmaz. */
  currency?: string | null;
}

export interface ScheduledPayable extends PayableItem {
  /** Running total of KNOWN amounts up to and including this item. */
  cumulative: number;
  /** Does the projected cash still cover it once everything above is paid? */
  covered: boolean;
  deferrable: boolean;
}

export interface PaymentSchedule {
  items: ScheduledPayable[];
  totalKnown: number;
  unknownCount: number;
  /** TRY-dışı ya da para birimi bilinmeyen kalemler — kümülatife girmedi, "karşılandı" denmedi. */
  foreignCount: number;
  coveredCount: number;
  shortfall: number;
  /** The first item the cash runs out on — the number a CFO actually wants. */
  firstUncoveredLabel: string | null;
}

/**
 * Order payables by the view's deterministic rank and mark where the money runs out.
 *
 * A PROPOSAL, and deliberately not an instruction. Nothing here writes, nothing is skipped, and
 * an uncovered item is marked rather than dropped: the list is what an operator negotiates
 * with, and hiding the items that do not fit would hide the actual problem.
 *
 * Items with an unknown amount are ORDERED but never counted toward the cumulative total —
 * summing them as zero would make the cash look further than it goes, which is the single most
 * dangerous rounding this application could do. They are counted separately and disclosed.
 */
export function scheduleWithinCash(items: PayableItem[], availableCash: number): PaymentSchedule {
  const ordered = [...items].sort(
    (a, b) => a.priorityRank - b.priorityRank || a.dueDate.localeCompare(b.dueDate),
  );

  let cumulative = decimal(0);
  let unknownCount = 0;
  let foreignCount = 0;
  let coveredCount = 0;
  let firstUncoveredLabel: string | null = null;
  const cash = decimal(availableCash);

  const scheduled: ScheduledPayable[] = ordered.map((item) => {
    if (item.amount == null) {
      unknownCount++;
      return {
        ...item,
        cumulative: money(cumulative.toString()),
        // An unknown amount cannot be declared covered; claiming otherwise is how an
        // unpriced obligation quietly becomes a surprise.
        covered: false,
        deferrable: item.flexibilityClass !== "critical",
      };
    }
    // PHASE 2.2: `availableCash` TRY'dir. TRY-dışı (ya da para birimi bilinmeyen) kalem bu nakitle
    // ne karşılanır ne de kümülatife eklenir — aksi hâlde 1.000 USD, 1.000 TRY gibi düşerdi.
    if ("currency" in item && item.currency !== undefined && !isReportingCurrency(item.currency)) {
      foreignCount++;
      return {
        ...item,
        cumulative: money(cumulative.toString()),
        covered: false,
        deferrable: item.flexibilityClass !== "critical",
      };
    }
    cumulative = cumulative.plus(decimal(item.amount));
    const covered = cumulative.lte(cash);
    if (covered) coveredCount++;
    else if (firstUncoveredLabel === null) firstUncoveredLabel = item.label;
    return {
      ...item,
      cumulative: money(cumulative.toString()),
      covered,
      deferrable: item.flexibilityClass !== "critical",
    };
  });

  const totalKnown = money(cumulative.toString());
  const shortfallDec = cumulative.minus(cash);
  return {
    items: scheduled,
    totalKnown,
    unknownCount,
    foreignCount,
    coveredCount,
    shortfall: money((shortfallDec.gt(0) ? shortfallDec : decimal(0)).toString()),
    firstUncoveredLabel,
  };
}

/** Total known TRY exposure of a set of payables; unknowns are skipped, never zeroed; TRY-dışı toplanmaz. */
export function knownPayableTotal(items: PayableItem[]): number {
  return sumKnownReporting(items, (i) => i.amount).total;
}
