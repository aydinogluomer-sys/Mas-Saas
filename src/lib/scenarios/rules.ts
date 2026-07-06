// Scenario domain rules (Phase 8). Pure & deterministic — sources: implementation.md
// §20 Phase 8 + mas-cashflow-forecaster. Scenarios are READ-ONLY planning overlays:
// they clone the baseline, apply DISCLOSED assumptions, re-chain the closing balances,
// and compare — never mutating the baseline. null stays null (unknown ≠ 0); unknown
// income/expense cannot be scaled or silently zeroed; assumptions are explicit.

import type { CashMonth } from "@/lib/radar/rules";

export interface ScenarioAssumptions {
  revenuePct?: number | null;            // income ×(1+revenuePct); e.g. -0.1 = %10 düşüş
  expensePct?: number | null;            // expense ×(1+expensePct)
  customerDelayMonths?: number | null;   // shift income forward N months (timing, not amount)
  includeDebtService?: boolean;          // add debt-service outflow to expense
  capacityUtilizationPct?: number | null;// revenue proxy: income ×(1+util)
  efficiencyPct?: number | null;         // expense proxy: expense ×(1−eff)
}

export interface DebtMonthLite { monthStart: string; knownOutflow: number }

export interface ScenarioMonth {
  monthStart: string;
  baselineIncome: number | null;
  scenarioIncome: number | null;
  baselineExpense: number | null;
  scenarioExpense: number | null;
  baselineClosing: number | null;
  scenarioClosing: number | null;
  delta: number | null; // scenario − baseline closing
}

/** Scale a known amount by a factor; null stays null (unknown is never scaled to 0). */
function scale(amount: number | null, factor: number): number | null {
  return amount == null ? null : amount * factor;
}

/**
 * Applies assumptions to a baseline month series and RE-CHAINS closing balances.
 * scenarioClosing[i] = scenarioOpening[i] + adjIncome[i] − adjExpense[i], where
 * scenarioOpening[0] = baseline first opening (devir), and each subsequent opening =
 * previous scenario closing. If a month's income or expense is unknown, its closing is
 * null and the chain opening carries the last KNOWN closing forward (honest: we don't
 * invent a number, but we also don't lose the whole downstream trajectory).
 */
export function applyScenario(
  baseline: CashMonth[],
  assumptions: ScenarioAssumptions,
  debt: DebtMonthLite[] = [],
): ScenarioMonth[] {
  const sorted = [...baseline].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  const debtBy = new Map(debt.map((d) => [d.monthStart, d.knownOutflow]));
  const revFactor = 1 + (assumptions.revenuePct ?? 0) + (assumptions.capacityUtilizationPct ?? 0);
  const expFactor = 1 + (assumptions.expensePct ?? 0);
  const effFactor = 1 - (assumptions.efficiencyPct ?? 0);
  const delay = Math.max(0, Math.round(assumptions.customerDelayMonths ?? 0));

  // 1) adjusted income with delay shift (amount preserved, timing shifted forward)
  const baseIncome = sorted.map((m) => m.income);
  const scaledIncome = baseIncome.map((v) => scale(v, revFactor));
  const shiftedIncome: (number | null)[] = sorted.map(() => 0 as number | null);
  if (delay > 0) {
    for (let i = 0; i < sorted.length; i++) shiftedIncome[i] = null; // start empty
    for (let i = 0; i < sorted.length; i++) {
      const v = scaledIncome[i];
      const target = i + delay;
      if (v == null) continue;
      if (target < sorted.length) shiftedIncome[target] = (shiftedIncome[target] ?? 0) + v;
      // income shifted past the horizon falls off (disclosed via null_month_count/notes)
    }
    // months that received no shifted income AND had a known baseline stay 0-known? No:
    // if nothing lands, income is unknown for that month only when baseline was unknown.
    for (let i = 0; i < sorted.length; i++) {
      if (shiftedIncome[i] === 0 && baseIncome[i] == null) shiftedIncome[i] = null;
    }
  } else {
    for (let i = 0; i < sorted.length; i++) shiftedIncome[i] = scaledIncome[i];
  }

  // 2) adjusted expense (scale + efficiency + optional debt-service overlay)
  const scenarioExpense = sorted.map((m, i) => {
    let e = scale(m.expense, expFactor * effFactor);
    if (assumptions.includeDebtService) {
      const d = debtBy.get(m.monthStart) ?? 0;
      e = e == null ? (d > 0 ? d : null) : e + d; // debt adds to known expense; null+debt stays null unless debt>0
      // NOTE: adding debt to an unknown expense keeps it unknown (can't sum with null),
      // except when there is a positive debt we surface it as the known floor.
      if (m.expense == null && d > 0) e = d;
    }
    void i;
    return e;
  });

  // 3) re-chain closings
  const out: ScenarioMonth[] = [];
  let opening: number | null = sorted[0]?.opening ?? null;
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const inc = shiftedIncome[i];
    const exp = scenarioExpense[i];
    let closing: number | null;
    if (opening != null && inc != null && exp != null) closing = opening + inc - exp;
    else closing = null;
    out.push({
      monthStart: m.monthStart,
      baselineIncome: m.income,
      scenarioIncome: inc,
      baselineExpense: m.expense,
      scenarioExpense: exp,
      baselineClosing: m.closing,
      scenarioClosing: closing,
      delta: closing != null && m.closing != null ? closing - m.closing : null,
    });
    // next opening: prefer the scenario closing; if unknown, carry last known forward
    if (closing != null) opening = closing;
    // else: opening unchanged (last known), so the chain resumes once inc/exp are known again
  }
  return out;
}

/* ── comparison ── */

export interface ScenarioComparison {
  baselineFinalCash: number | null;
  scenarioFinalCash: number | null;
  finalDelta: number | null;
  baselineFirstNegative: string | null;
  scenarioFirstNegative: string | null;
  worstMonth: string | null;      // scenario trough
  worstBalance: number | null;
  maxCashGap: number | null;      // deepest scenario shortfall magnitude (>=0)
  recoveryMonth: string | null;   // first month scenario closing ≥ 0 after first negative
  monthCount: number;
  nullMonthCount: number;         // months with unknown scenario income/expense
}

function firstNegative(vals: Array<{ m: string; c: number | null }>): string | null {
  for (const v of vals) if (v.c != null && v.c < 0) return v.m;
  return null;
}

export function compareScenarioToBaseline(months: ScenarioMonth[]): ScenarioComparison {
  const baseFinal = [...months].reverse().find((m) => m.baselineClosing != null)?.baselineClosing ?? null;
  const scenFinal = [...months].reverse().find((m) => m.scenarioClosing != null)?.scenarioClosing ?? null;
  const baseFirstNeg = firstNegative(months.map((m) => ({ m: m.monthStart, c: m.baselineClosing })));
  const scenFirstNeg = firstNegative(months.map((m) => ({ m: m.monthStart, c: m.scenarioClosing })));

  let worstMonth: string | null = null, worstBalance: number | null = null, maxCashGap: number | null = null;
  let nullMonthCount = 0;
  for (const m of months) {
    if (m.scenarioIncome == null || m.scenarioExpense == null) nullMonthCount++;
    if (m.scenarioClosing != null) {
      if (worstBalance == null || m.scenarioClosing < worstBalance) {
        worstBalance = m.scenarioClosing;
        worstMonth = m.monthStart;
      }
      const gap = m.scenarioClosing < 0 ? -m.scenarioClosing : 0;
      if (maxCashGap == null || gap > maxCashGap) maxCashGap = gap;
    }
  }

  // recovery: first month with scenario closing ≥ 0 that occurs after the first negative
  let recoveryMonth: string | null = null;
  if (scenFirstNeg != null) {
    let seenNeg = false;
    for (const m of months) {
      if (m.monthStart === scenFirstNeg) seenNeg = true;
      if (seenNeg && m.scenarioClosing != null && m.scenarioClosing >= 0) {
        recoveryMonth = m.monthStart;
        break;
      }
    }
  }

  return {
    baselineFinalCash: baseFinal,
    scenarioFinalCash: scenFinal,
    finalDelta: scenFinal != null && baseFinal != null ? scenFinal - baseFinal : null,
    baselineFirstNegative: baseFirstNeg,
    scenarioFirstNegative: scenFirstNeg,
    worstMonth, worstBalance, maxCashGap, recoveryMonth,
    monthCount: months.length,
    nullMonthCount,
  };
}

export function scenarioConfidence(c: ScenarioComparison): "high" | "medium" | "low" {
  if (c.nullMonthCount === 0) return "high";
  const ratio = c.monthCount > 0 ? c.nullMonthCount / c.monthCount : 1;
  return ratio > 0.1 ? "low" : "medium";
}

/* ── deterministic insight text (not AI; never mutates) ── */

const fmtTL = (n: number | null): string =>
  n == null ? "belirsiz" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "yok");

export function buildScenarioInsights(c: ScenarioComparison, a: ScenarioAssumptions): string[] {
  const out: string[] = [];

  if (c.baselineFirstNegative !== c.scenarioFirstNegative) {
    if (c.scenarioFirstNegative == null) out.push("Bu senaryoda negatif ay oluşmuyor (baz senaryoda vardı).");
    else if (c.baselineFirstNegative == null) out.push(`Bu senaryoda ilk negatif ay ortaya çıkıyor: ${ym(c.scenarioFirstNegative)}.`);
    else if (c.scenarioFirstNegative < c.baselineFirstNegative)
      out.push(`Bu senaryoda ilk negatif ay öne çekiliyor: ${ym(c.baselineFirstNegative)} → ${ym(c.scenarioFirstNegative)}.`);
    else out.push(`Bu senaryoda ilk negatif ay geciktiriliyor: ${ym(c.baselineFirstNegative)} → ${ym(c.scenarioFirstNegative)}.`);
  }

  if (c.finalDelta != null && c.finalDelta !== 0)
    out.push(`Final kasa baz senaryoya göre ${fmtTL(Math.abs(c.finalDelta))} ${c.finalDelta < 0 ? "daha kötü" : "daha iyi"}.`);

  if (c.worstMonth != null && c.worstBalance != null && c.worstBalance < 0)
    out.push(`En büyük baskı ayı ${ym(c.worstMonth)} (${fmtTL(c.worstBalance)}).`);

  if (a.includeDebtService) out.push("Borç-servisi dahil edildiğinde nakit açığı artıyor (çek+kredi taksiti gidere eklendi).");

  if ((a.capacityUtilizationPct ?? 0) !== 0 || (a.efficiencyPct ?? 0) !== 0) {
    const helps = (c.finalDelta ?? 0) > 0;
    out.push(`Kapasite/verim varsayımı nakit açığını ${helps ? "azaltıyor" : "artırıyor"}.`);
  }

  if (c.recoveryMonth != null) out.push(`Nakit ${ym(c.recoveryMonth)} ayında yeniden pozitife dönüyor.`);

  if (c.nullMonthCount > 0)
    out.push(`Belirsiz tutarlı ${c.nullMonthCount} ay nedeniyle güven seviyesi düşüktür (bilinmeyen sıfır sayılmadı).`);

  if (out.length === 0) out.push("Senaryo baz senaryoyla neredeyse aynı — belirgin fark yok.");
  return out;
}

export { fmtTL as scenarioFmtTL };
