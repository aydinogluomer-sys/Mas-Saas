// Faz 29 + Faz 46 — deterministic optimisation rules. Pure, no database, no model.
//
// ═══ WHAT THIS IS AND IS NOT ═══
//
// It is an explicit, rule-based heuristic solver. There is no LP/MIP library, no statistical
// optimiser, no learned weighting and no Python (Çözülen Karar #2). Every suggestion is produced
// by a named rule, carries that rule's name, and can be re-derived by hand from the inputs.
//
// It NEVER mutates anything. The functions here return PROPOSALS; acting on one is a human
// decision gated by Faz 24A's approval entity. CLAUDE.md forbids automation from altering due
// dates or amounts, and the way that rule is kept here is structural: these functions have no
// database access at all, so there is nothing they could write even by mistake.
//
// ═══ DETERMINISM IS A REQUIREMENT, NOT A HOPE ═══
//
// The same inputs must always produce byte-identical output, because the run stores a digest and
// the gate re-runs the optimiser to compare. That forces every sort to have a TOTAL order — every
// comparator below ends with an id tiebreak, so two candidates that are equal on every business
// key still have a fixed, reproducible order. A comparator that left ties unresolved would make
// the output depend on input order, which is exactly the Faz 23 lesson about ordering assertions.

import { decimal, moneyOrNull, type NumericInput } from "@/lib/money";

export const OBJECTIVES = ["min_financing_cost", "max_liquidity_buffer", "min_late_payment"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const ACTION_KINDS = [
  "defer_payment", "advance_payment", "draw_facility", "repay_facility", "hold_buffer",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Every rule this solver can cite. A recommendation must name at least one. */
export const RULE_CODES = [
  "nakit_tabani_ihlali",
  "ertelenebilir_odeme",
  "sert_vade_ertelenemez",
  "limit_cekimi_gerekli",
  "fazla_nakit_geri_odeme",
  "tampon_korunuyor",
  "limit_yetersiz",
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const RULE_LABEL: Record<RuleCode, string> = {
  nakit_tabani_ihlali: "Nakit tabanı ihlal ediliyor",
  ertelenebilir_odeme: "Ertelenebilir ödeme mevcut",
  sert_vade_ertelenemez: "Sert vadeli, ertelenemez",
  limit_cekimi_gerekli: "Kredi limiti çekimi gerekli",
  fazla_nakit_geri_odeme: "Fazla nakit — geri ödeme mümkün",
  tampon_korunuyor: "Tampon korunuyor",
  limit_yetersiz: "Kullanılabilir limit yetersiz",
};

export type OptimizationSubjectTable =
  | "payment_instances"
  | "invoices"
  | "checks"
  | "loan_installments"
  | "credit_facilities";

export interface PaymentCandidate {
  id: string;
  label: string;
  /** Scheduled date, ISO. */
  dueDate: string;
  amount: number;
  /**
   * A hard deadline cannot be deferred at any price — a cheque maturity, loan installment, or tax date.
   * The solver must never propose moving one, which is why this is an input and not a judgement the
   * solver makes.
   */
  hardDeadline: boolean;
  /** Latest date this may be moved to, when deferral is allowed at all. */
  latestDate?: string | null;
  /** Source table for polymorphic recommendation attribution (defaults to 'payment_instances'). */
  subjectTable?: Exclude<OptimizationSubjectTable, "credit_facilities">;
}

export interface FacilityHeadroom {
  id: string;
  label: string;
  available: number;
  /** Annual rate as a decimal (0.45 = 45%). Used only to order facilities, never to price. */
  interestRate: number | null;
}

export const UNKNOWN_OPENING_CASH_HALT_REASON =
  "Açılış bakiyesi bilinmeyen aktif hesap bulunduğu için optimizasyon simülasyonu durduruldu";

export interface OptimizationInput {
  objective: Objective;
  anchorDate: string;
  horizonDays: number;
  /** Null when active cash accounts have unknown opening balance (FIN-03). */
  openingCash: number | null;
  /** The configured floor from Faz 26's treasury policy. */
  minCashFloor: number;
  /** Dated inflows already expected, signed positive. */
  inflows: Array<{ date: string; amount: number }>;
  payments: PaymentCandidate[];
  facilities: FacilityHeadroom[];
  /** Currently drawn balance, for repayment suggestions. */
  drawnAmount?: number;
}

export interface Recommendation {
  rank: number;
  actionKind: ActionKind;
  subjectTable: string | null;
  subjectId: string | null;
  subjectLabel: string | null;
  currentDate: string | null;
  proposedDate: string | null;
  amount: number | null;
  expectedEffect: number;
  rationaleCodes: RuleCode[];
  rationaleNote: string;
  confidence: number;
}

export interface OptimizationResult {
  recommendations: Recommendation[];
  /** Projected minimum balance BEFORE any recommendation is acted on. */
  worstBalanceBefore: number;
  worstDateBefore: string | null;
  /** The same projection assuming every recommendation is taken. */
  worstBalanceAfter: number;
  breachDates: string[];
  /** Present when simulation halted due to unknown opening cash (FIN-03). */
  haltedReason?: string | null;
}

export function addDays(fromISO: string, days: number): string {
  const d = new Date(`${fromISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(v: NumericInput): number {
  return Number(decimal(moneyOrNull(v) ?? 0).toFixed(2));
}

function tiebreakId(aId: string, bId: string): number {
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Day-by-day balance projection over the horizon.
 *
 * Exposed because both the "before" and "after" pictures use it, and because a reader checking a
 * recommendation by hand needs the same series the solver saw.
 */
export function projectBalances(input: {
  anchorDate: string;
  horizonDays: number;
  openingCash: NumericInput;
  inflows: Array<{ date: string; amount: number }>;
  payments: Array<{ dueDate: string; amount: number }>;
}): Array<{ date: string; balance: number }> {
  const series: Array<{ date: string; balance: number }> = [];
  let balance = decimal(moneyOrNull(input.openingCash) ?? 0);

  for (let i = 0; i < input.horizonDays; i += 1) {
    const date = addDays(input.anchorDate, i);
    for (const f of input.inflows) {
      if (f.date === date) balance = balance.plus(decimal(f.amount));
    }
    for (const p of input.payments) {
      if (p.dueDate === date) balance = balance.minus(decimal(p.amount));
    }
    series.push({ date, balance: Number(balance.toFixed(2)) });
  }
  return series;
}

/**
 * The solver.
 *
 * FIN-03 (Faz 46): When `input.openingCash === null`, we refuse to run a fabricated `0`-cash
 * simulation and halt with `UNKNOWN_OPENING_CASH_HALT_REASON`.
 *
 * Objective-aware deterministic rule sets (Faz 46):
 *   - `max_liquidity_buffer`: Defer soft-deadline payments largest-first (fewest moves, highest
 *     cash cushion), then draw the cheapest facility with headroom for any remaining shortfall.
 *   - `min_financing_cost`: Defer soft-deadline payments smallest-first (zero interest cost, only
 *     moving the minimum supplier volume required to avoid borrowing), then draw the cheapest
 *     credit facility if deferrals cannot close the gap.
 *   - `min_late_payment`: Draw available credit facilities cheapest-first BEFORE deferring any
 *     supplier payments, so zero payments are paid late when credit headroom can bridge the trough.
 *
 * Every branch cites its rule. Nothing here prices interest or estimates probability — the
 * ordering of facilities by rate is the only place a rate is consulted, and only to choose
 * between two otherwise-equivalent options.
 */
export function optimize(input: OptimizationInput): OptimizationResult {
  if (input.openingCash === null) {
    return {
      recommendations: [],
      worstBalanceBefore: 0,
      worstDateBefore: null,
      worstBalanceAfter: 0,
      breachDates: [],
      haltedReason: UNKNOWN_OPENING_CASH_HALT_REASON,
    };
  }

  const openingCash = round2(input.openingCash);
  const floor = round2(input.minCashFloor);
  const before = projectBalances({
    anchorDate: input.anchorDate,
    horizonDays: input.horizonDays,
    openingCash,
    inflows: input.inflows,
    payments: input.payments,
  });

  const worstBefore = before.reduce(
    (acc, p) => (acc === null || p.balance < acc.balance ? p : acc),
    null as { date: string; balance: number } | null,
  );
  const breachDates = before.filter((p) => p.balance < floor).map((p) => p.date);

  const recommendations: Recommendation[] = [];
  // Working copies so the "after" projection reflects proposals without mutating input.
  const workingPayments = input.payments.map((p) => ({ ...p }));
  const workingInflows = input.inflows.map((f) => ({ ...f }));

  if (breachDates.length > 0) {
    const firstBreach = breachDates[0];
    const balanceAtBreach = before.find((p) => p.date === firstBreach)?.balance ?? 0;
    let gap = round2(decimal(floor).minus(decimal(balanceAtBreach)));

    const deferSoftPayments = (order: "largest_first" | "smallest_first") => {
      const deferrable = workingPayments
        .filter((p) => !p.hardDeadline && p.dueDate <= firstBreach)
        .sort((a, b) => {
          const cmp = order === "smallest_first"
            ? Number(decimal(a.amount).minus(decimal(b.amount)))
            : Number(decimal(b.amount).minus(decimal(a.amount)));
          return cmp || tiebreakId(a.id, b.id);
        });

      for (const p of deferrable) {
        if (gap <= 0) break;

        const without = projectBalances({
          anchorDate: input.anchorDate,
          horizonDays: input.horizonDays,
          openingCash,
          inflows: workingInflows,
          payments: workingPayments.filter((x) => x.id !== p.id),
        });
        const affordable = without.find(
          (d) => d.date > p.dueDate
            && decimal(d.balance).minus(decimal(p.amount)).gte(decimal(floor)),
        );
        if (!affordable) continue;
        const target = affordable.date;
        if (p.latestDate && target > p.latestDate) continue;

        recommendations.push({
          rank: recommendations.length + 1,
          actionKind: "defer_payment",
          subjectTable: p.subjectTable ?? "payment_instances",
          subjectId: p.id,
          subjectLabel: p.label,
          currentDate: p.dueDate,
          proposedDate: target,
          amount: round2(p.amount),
          expectedEffect: round2(p.amount),
          rationaleCodes: ["nakit_tabani_ihlali", "ertelenebilir_odeme"],
          rationaleNote:
            `${firstBreach} tarihinde bakiye tabanın ${gap.toFixed(2)} altında; ` +
            `bu ödeme ${target} tarihine ertelenirse taban korunur.`,
          confidence: 0.8,
        });
        gap = round2(decimal(gap).minus(decimal(p.amount)));
        p.dueDate = target;
      }
    };

    const drawCheapestFacilities = () => {
      if (gap <= 0) return;
      const byCost = [...input.facilities]
        .filter((f) => f.available > 0)
        .sort((a, b) => {
          const ar = a.interestRate ?? Number.POSITIVE_INFINITY;
          const br = b.interestRate ?? Number.POSITIVE_INFINITY;
          return (ar - br) || tiebreakId(a.id, b.id);
        });

      for (const f of byCost) {
        if (gap <= 0) break;
        const draw = Math.min(gap, f.available);
        recommendations.push({
          rank: recommendations.length + 1,
          actionKind: "draw_facility",
          subjectTable: "credit_facilities",
          subjectId: f.id,
          subjectLabel: f.label,
          currentDate: null,
          proposedDate: firstBreach,
          amount: round2(draw),
          expectedEffect: round2(draw),
          rationaleCodes: ["nakit_tabani_ihlali", "limit_cekimi_gerekli"],
          rationaleNote:
            `${firstBreach} tarihindeki ${gap.toFixed(2)} açık için en düşük maliyetli limitten çekim.`,
          confidence: 0.75,
        });
        workingInflows.push({ date: firstBreach, amount: round2(draw) });
        gap = round2(decimal(gap).minus(decimal(draw)));
      }
    };

    const reportBlockedHardDeadlines = () => {
      const blocked = workingPayments.filter((p) => p.hardDeadline && p.dueDate <= firstBreach);
      if (gap > 0 && blocked.length > 0) {
        const biggest = [...blocked].sort(
          (a, b) => Number(decimal(b.amount).minus(decimal(a.amount))) || tiebreakId(a.id, b.id),
        )[0];
        recommendations.push({
          rank: recommendations.length + 1,
          actionKind: "hold_buffer",
          subjectTable: biggest.subjectTable ?? "payment_instances",
          subjectId: biggest.id,
          subjectLabel: biggest.label,
          currentDate: biggest.dueDate,
          proposedDate: null,
          amount: round2(biggest.amount),
          expectedEffect: 0,
          rationaleCodes: ["sert_vade_ertelenemez"],
          rationaleNote: "Sert vadeli ödeme ertelenemez; açık finansmanla kapatılmalı.",
          confidence: 0.9,
        });
      }
    };

    if (input.objective === "min_late_payment") {
      // Draw available credit facilities first so supplier payments stay on time whenever headroom exists.
      drawCheapestFacilities();
      if (gap > 0) {
        deferSoftPayments("largest_first");
        reportBlockedHardDeadlines();
      }
    } else if (input.objective === "min_financing_cost") {
      // Zero-interest deferrals first (smallest sufficient volume), then cheapest facility draw.
      deferSoftPayments("smallest_first");
      reportBlockedHardDeadlines();
      drawCheapestFacilities();
    } else {
      // max_liquidity_buffer: largest soft deferrals first, then cheapest facility draw.
      deferSoftPayments("largest_first");
      reportBlockedHardDeadlines();
      drawCheapestFacilities();
    }

    if (gap > 0) {
      // Reported, never hidden: the solver could not close the gap.
      recommendations.push({
        rank: recommendations.length + 1,
        actionKind: "hold_buffer",
        subjectTable: null,
        subjectId: null,
        subjectLabel: null,
        currentDate: null,
        proposedDate: firstBreach,
        amount: round2(gap),
        expectedEffect: 0,
        rationaleCodes: ["limit_yetersiz"],
        rationaleNote:
          `Kalan ${gap.toFixed(2)} açık mevcut limitlerle kapatılamıyor — ek finansman gerekli.`,
        confidence: 0.9,
      });
    }
  } else if ((input.drawnAmount ?? 0) > 0) {
    // No breach anywhere in the horizon: money is sitting idle while a facility accrues interest.
    const minBalance = worstBefore?.balance ?? 0;
    const spare = round2(decimal(minBalance).minus(decimal(floor)));
    if (spare > 0) {
      const repay = Math.min(spare, input.drawnAmount ?? 0);
      recommendations.push({
        rank: 1,
        actionKind: "repay_facility",
        subjectTable: null,
        subjectId: null,
        subjectLabel: null,
        currentDate: null,
        proposedDate: input.anchorDate,
        amount: round2(repay),
        expectedEffect: round2(repay),
        rationaleCodes: ["fazla_nakit_geri_odeme", "tampon_korunuyor"],
        rationaleNote:
          `Ufuk boyunca en düşük bakiye tabanın ${spare.toFixed(2)} üzerinde; ` +
          `bu tutar geri ödenirse taban yine korunur.`,
        confidence: 0.7,
      });
    }
  }

  const after = projectBalances({
    anchorDate: input.anchorDate,
    horizonDays: input.horizonDays,
    openingCash,
    inflows: workingInflows,
    payments: workingPayments,
  });
  const worstAfter = after.reduce((m, p) => Math.min(m, p.balance), Number.POSITIVE_INFINITY);

  return {
    recommendations,
    worstBalanceBefore: worstBefore?.balance ?? 0,
    worstDateBefore: worstBefore?.date ?? null,
    worstBalanceAfter: Number.isFinite(worstAfter) ? worstAfter : 0,
    breachDates,
  };
}

/**
 * A stable fingerprint of a result.
 *
 * Used to prove determinism: the run stores this, and re-running the optimiser over the same
 * inputs must reproduce it exactly. Built from the fields that constitute the ADVICE — rank,
 * action, subject, dates, amount — so a cosmetic change to a note cannot mask a changed
 * recommendation, and a changed recommendation cannot hide behind an identical note.
 */
export function resultDigest(result: OptimizationResult): string {
  if (result.haltedReason) {
    return "halted:unknown_opening_balance";
  }
  return result.recommendations
    .map((r) => [
      r.rank, r.actionKind, r.subjectId ?? "-", r.currentDate ?? "-",
      r.proposedDate ?? "-", (r.amount ?? 0).toFixed(2), r.rationaleCodes.join("+"),
    ].join(":"))
    .join("|");
}
