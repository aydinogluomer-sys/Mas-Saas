// Phase 8 + Faz 46 scenario engine. READ-ONLY over the baseline: reads cashflow_months (+ Phase-5
// debt service), applies the pure scenario overlay, and writes ONLY to scenario_* tables
// (+ audit_logs). It never mutates payments/instances/cashflow/checks/loans/reminders/
// reports/production. Every run stores its explicit assumptions and the baseline it used.

import type { Pool } from "pg";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadApprovedExternalAssumptions, type ExternalAssumption } from "@/lib/external-assumptions/engine";
import { debtServiceByMonth } from "@/lib/financing/rules";
import { loadMaturityItems } from "@/lib/financing/engine";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";
import type { CashMonth } from "@/lib/radar/rules";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  applyScenario as applyScenarioCore,
  buildScenarioInsights,
  compareScenarioToBaseline,
  scenarioConfidence,
  type DebtMonthLite,
  type ScenarioAdjustment,
  type ScenarioAssumptions,
  type ScenarioComparison,
  type ScenarioMonth,
} from "./rules";

export type ScenarioType =
  | "revenue_up_down_percent" | "expense_up_down_percent" | "customer_delay_days"
  | "debt_service_overlay" | "capacity_utilization_change" | "efficiency_change"
  | "combined_custom_scenario";

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase()
    .trim();
}

function slugKey(s: string): string {
  return norm(s).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "counterparty";
}

function addMonthsISO(monthStart: string, months: number): string {
  const [y, m] = monthStart.slice(0, 7).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function monthStart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

function matchesNeedle(needle: string | null | undefined, ...hay: Array<string | null | undefined>): boolean {
  const n = norm(needle ?? "");
  if (!n) return false;
  return hay.some((h) => norm(h ?? "").includes(n));
}

interface CashflowLineLite {
  monthStart: string;
  lineType: string;
  direction: string;
  label: string | null;
  partyName: string | null;
  amount: number;
}

export interface ScenarioExternalContext {
  id: string;
  assumptionType: string;
  label: string;
  value: number;
  unit: string;
  currency: string;
  sourceName: string;
  sourceDate: string;
  sourceHref: string;
  mappedField: keyof ScenarioAssumptions | "fxBenchmark" | null;
  mappedValue: number | null;
  mappingSummary: string;
}

function isRateLikeUnit(unit: string): boolean {
  const u = norm(unit);
  return (
    u === "%" ||
    u.includes("yuzde") ||
    u.includes("oran") ||
    u.includes("pct") ||
    u.includes("percent") ||
    u.includes("puan") ||
    u.includes("ratio")
  );
}

function normalizeRateValue(raw: number, unit: string, forceRateType = false): number {
  const u = norm(unit);
  const explicitPercent =
    u === "%" || u.includes("yuzde") || u.includes("pct") || u.includes("percent") || u.includes("puan");
  if (explicitPercent) {
    return Number(decimal(raw).div(100).toFixed(6));
  }
  if ((forceRateType || u.includes("oran") || u.includes("ratio")) && Math.abs(raw) > 1) {
    return Number(decimal(raw).div(100).toFixed(6));
  }
  return Number(decimal(raw).toFixed(6));
}

function describeExternalMapping(a: ExternalAssumption): {
  mappedField: keyof ScenarioAssumptions | "fxBenchmark" | null;
  mappedValue: number | null;
  mappingSummary: string;
} {
  switch (a.assumption_type) {
    case "inflation_rate": {
      const r = normalizeRateValue(a.value_numeric, a.unit, true);
      return {
        mappedField: "expensePct",
        mappedValue: r,
        mappingSummary: `Baz gider artışı (expensePct): %${(r * 100).toFixed(2)}`,
      };
    }
    case "personnel_cost":
    case "energy_cost": {
      if (isRateLikeUnit(a.unit)) {
        const r = normalizeRateValue(a.value_numeric, a.unit, true);
        return {
          mappedField: "expensePct",
          mappedValue: r,
          mappingSummary: `Baz maliyet baskısı (expensePct): %${(r * 100).toFixed(2)}`,
        };
      }
      return {
        mappedField: null,
        mappedValue: a.value_numeric,
        mappingSummary: `Referans maliyet girdisi (${a.value_numeric.toLocaleString("tr-TR")} ${a.unit})`,
      };
    }
    case "interest_rate":
    case "loan_rate": {
      const annual = normalizeRateValue(a.value_numeric, a.unit, true);
      const monthly = Number(decimal(annual).div(12).toFixed(6));
      return {
        mappedField: "factoringFeePct",
        mappedValue: monthly,
        mappingSummary: `Baz iskonto/faktoring oranı (factoringFeePct): %${(monthly * 100).toFixed(2)}/ay (yıllık %${(annual * 100).toFixed(2)})`,
      };
    }
    case "fx_rate": {
      if (isRateLikeUnit(a.unit)) {
        const r = normalizeRateValue(a.value_numeric, a.unit, true);
        return {
          mappedField: "expensePct",
          mappedValue: r,
          mappingSummary: `Kur değişim maliyet etkisi (expensePct): %${(r * 100).toFixed(2)}`,
        };
      }
      return {
        mappedField: "fxBenchmark",
        mappedValue: a.value_numeric,
        mappingSummary: `Onaylı baz döviz kuru (${a.currency}): ${a.value_numeric.toLocaleString("tr-TR")} ${a.unit}`,
      };
    }
    default: {
      const u = norm(a.unit);
      if (
        u === "ay" ||
        u === "month" ||
        u.includes("gun") ||
        u.includes("day") ||
        matchesNeedle("tahsilat", a.label) ||
        matchesNeedle("gecikme", a.label) ||
        matchesNeedle("vade", a.label)
      ) {
        const months =
          u.includes("gun") || u.includes("day")
            ? Math.max(0, Math.round(a.value_numeric / 30))
            : Math.max(0, Math.round(a.value_numeric));
        return {
          mappedField: "customerDelayMonths",
          mappedValue: months,
          mappingSummary: `Baz tahsilat vade kayması (customerDelayMonths): ${months} ay`,
        };
      }
      if (
        isRateLikeUnit(a.unit) &&
        (matchesNeedle("gelir", a.label) || matchesNeedle("satis", a.label) || matchesNeedle("ciro", a.label))
      ) {
        const r = normalizeRateValue(a.value_numeric, a.unit, true);
        return {
          mappedField: "revenuePct",
          mappedValue: r,
          mappingSummary: `Baz gelir değişimi (revenuePct): %${(r * 100).toFixed(2)}`,
        };
      }
      if (isRateLikeUnit(a.unit)) {
        const r = normalizeRateValue(a.value_numeric, a.unit, true);
        return {
          mappedField: "expensePct",
          mappedValue: r,
          mappingSummary: `Baz gider değişimi (expensePct): %${(r * 100).toFixed(2)}`,
        };
      }
      return {
        mappedField: null,
        mappedValue: a.value_numeric,
        mappingSummary: `Onaylı dış bağlam (${a.value_numeric.toLocaleString("tr-TR")} ${a.unit})`,
      };
    }
  }
}

export function resolveAssumptionsWithExternal(
  assumptions: ScenarioAssumptions,
  externalAssumptions: ExternalAssumption[],
  options?: { scenarioType?: ScenarioType; useExternalAssumptions?: boolean },
): {
  effectiveAssumptions: ScenarioAssumptions;
  appliedExternal: ScenarioExternalContext[];
} {
  if (options?.useExternalAssumptions === false || externalAssumptions.length === 0) {
    return { effectiveAssumptions: { ...assumptions }, appliedExternal: [] };
  }

  const scenarioType = options?.scenarioType ?? "combined_custom_scenario";
  const allowRevenueBase =
    scenarioType === "combined_custom_scenario" || scenarioType === "revenue_up_down_percent";
  const allowExpenseBase =
    scenarioType === "combined_custom_scenario" || scenarioType === "expense_up_down_percent";
  const allowDelayBase =
    scenarioType === "combined_custom_scenario" || scenarioType === "customer_delay_days";
  const allowFinancingBase = scenarioType === "combined_custom_scenario";

  const effective: ScenarioAssumptions = { ...assumptions };
  const applied: ScenarioExternalContext[] = [];

  // Prioritize inflation_rate over secondary cost pressure rates when resolving expensePct
  const prioritized = [...externalAssumptions].sort((a, b) => {
    const rank = (t: string) =>
      t === "inflation_rate"
        ? 0
        : t === "interest_rate"
          ? 1
          : t === "loan_rate"
            ? 2
            : t === "personnel_cost"
              ? 3
              : t === "energy_cost"
                ? 4
                : t === "fx_rate"
                  ? 5
                  : 6;
    return rank(a.assumption_type) - rank(b.assumption_type);
  });

  for (const ext of prioritized) {
    const ctx = toScenarioExternalContext(ext);
    if (ctx.mappedField === "expensePct" && ctx.mappedValue != null) {
      if (allowExpenseBase && effective.expensePct == null) {
        effective.expensePct = ctx.mappedValue;
        applied.push(ctx);
      }
    } else if (ctx.mappedField === "revenuePct" && ctx.mappedValue != null) {
      if (allowRevenueBase && effective.revenuePct == null) {
        effective.revenuePct = ctx.mappedValue;
        applied.push(ctx);
      }
    } else if (ctx.mappedField === "customerDelayMonths" && ctx.mappedValue != null) {
      if (allowDelayBase && effective.customerDelayMonths == null) {
        effective.customerDelayMonths = ctx.mappedValue;
        applied.push(ctx);
      }
    } else if (ctx.mappedField === "factoringFeePct" && ctx.mappedValue != null) {
      if (allowFinancingBase && effective.factoringFeePct == null) {
        effective.factoringFeePct = ctx.mappedValue;
        applied.push(ctx);
      }
    } else if (ctx.mappedField === "fxBenchmark") {
      applied.push(ctx);
    }
  }

  return { effectiveAssumptions: effective, appliedExternal: applied };
}

export function applyScenario(
  baseline: CashMonth[],
  assumptions: ScenarioAssumptions,
  debt: DebtMonthLite[] = [],
  adjustments: ScenarioAdjustment[] = [],
  externalAssumptions: ExternalAssumption[] = [],
): ScenarioMonth[] {
  const { effectiveAssumptions } = resolveAssumptionsWithExternal(assumptions, externalAssumptions);
  return applyScenarioCore(baseline, effectiveAssumptions, debt, adjustments);
}

async function loadCashflowLines(pool: Pool): Promise<CashflowLineLite[]> {
  const r = await pool.query(
    `select to_char(cm.month_start,'YYYY-MM-DD') as "monthStart",
            cl.line_type as "lineType", cl.direction, cl.label,
            p.name as "partyName", cl.amount
     from public.cashflow_lines cl
     join public.cashflow_months cm on cm.id=cl.cashflow_month_id
     left join public.parties p on p.id=cl.party_id
     where cl.amount is not null
     order by cm.month_start, cl.label`,
  );
  return r.rows.map((x) => ({ ...x, amount: moneyOrNull(x.amount) ?? 0 })) as CashflowLineLite[];
}

/**
 * Faz 46: Dynamically discover the largest supplier outflow label and largest customer inflow
 * label from actual cashflow lines (falling back to open TRY purchase/sales invoices) rather than
 * hardcoding tenant-specific company names.
 */
async function discoverTopCounterpartyLabels(
  pool: Pool,
  lines: CashflowLineLite[],
): Promise<{ topOutflowLabel: string | null; topIncomeLabel: string | null }> {
  const outflowTotals = new Map<string, ReturnType<typeof decimal>>();
  const incomeTotals = new Map<string, ReturnType<typeof decimal>>();

  for (const l of lines) {
    const label = (l.partyName ?? l.label ?? "").trim();
    if (!label) continue;
    const mag = decimal(l.amount).abs();
    if (mag.lte(0)) continue;
    if (l.direction === "outflow" || l.direction === "out") {
      outflowTotals.set(label, (outflowTotals.get(label) ?? decimal(0)).plus(mag));
    }
    if (l.lineType === "customer_income") {
      incomeTotals.set(label, (incomeTotals.get(label) ?? decimal(0)).plus(mag));
    }
  }

  const pickLargest = (totals: Map<string, ReturnType<typeof decimal>>): string | null => {
    let bestLabel: string | null = null;
    let bestAmount = decimal(0);
    for (const [label, total] of totals) {
      if (total.gt(bestAmount) || (total.eq(bestAmount) && bestLabel !== null && label < bestLabel)) {
        bestAmount = total;
        bestLabel = label;
      }
    }
    return bestLabel;
  };

  let topOutflowLabel = pickLargest(outflowTotals);
  let topIncomeLabel = pickLargest(incomeTotals);

  if (!topOutflowLabel) {
    const res = await pool.query<{ label: string }>(
      `select p.name as label
       from public.invoices inv
       join public.parties p on p.id = inv.party_id
       where inv.direction = 'purchase'
         and inv.status in ('open','partial')
         and inv.currency = 'TRY'
         and inv.gross_amount > inv.allocated_amount
       group by p.name
       order by sum(inv.gross_amount - inv.allocated_amount) desc, p.name asc
       limit 1`,
    );
    topOutflowLabel = res.rows[0]?.label?.trim() || null;
  }

  if (!topIncomeLabel) {
    const res = await pool.query<{ label: string }>(
      `select p.name as label
       from public.invoices inv
       join public.parties p on p.id = inv.party_id
       where inv.direction = 'sales'
         and inv.status in ('open','partial')
         and inv.currency = 'TRY'
         and inv.gross_amount > inv.allocated_amount
       group by p.name
       order by sum(inv.gross_amount - inv.allocated_amount) desc, p.name asc
       limit 1`,
    );
    topIncomeLabel = res.rows[0]?.label?.trim() || null;
  }

  return { topOutflowLabel, topIncomeLabel };
}

function buildScenarioAdjustmentsFromLines(lines: CashflowLineLite[], a: ScenarioAssumptions): ScenarioAdjustment[] {
  const adjustments: ScenarioAdjustment[] = [];

  const incomeDelay = Math.max(0, Math.round(a.targetIncomeDelayMonths ?? 0));
  if (incomeDelay > 0 && a.targetIncomeLabel) {
    for (const l of lines) {
      if (l.lineType !== "customer_income") continue;
      if (!matchesNeedle(a.targetIncomeLabel, l.label, l.partyName)) continue;
      const amount = money(decimal(l.amount).abs());
      adjustments.push({ monthStart: l.monthStart, incomeDelta: -amount, note: `delay income ${a.targetIncomeLabel}` });
      adjustments.push({ monthStart: addMonthsISO(l.monthStart, incomeDelay), incomeDelta: amount, note: `receive delayed income ${a.targetIncomeLabel}` });
    }
  }

  const outflowDelay = Math.max(0, Math.round(a.targetOutflowDelayMonths ?? 0));
  if (outflowDelay > 0 && a.targetOutflowLabel) {
    for (const l of lines) {
      if (l.direction !== "outflow" && l.direction !== "out") continue;
      if (!matchesNeedle(a.targetOutflowLabel, l.label, l.partyName)) continue;
      const amount = money(decimal(l.amount).abs());
      adjustments.push({ monthStart: l.monthStart, expenseDelta: -amount, note: `delay outflow ${a.targetOutflowLabel}` });
      adjustments.push({ monthStart: addMonthsISO(l.monthStart, outflowDelay), expenseDelta: amount, note: `pay delayed outflow ${a.targetOutflowLabel}` });
    }
  }

  const advanceMonth = monthStart(a.factoringAdvanceMonth);
  const feePct = Math.max(0, a.factoringFeePct ?? 0);
  if (advanceMonth && a.factoringIncomeLabel) {
    for (const l of lines) {
      if (l.lineType !== "customer_income") continue;
      if (l.monthStart <= advanceMonth) continue;
      if (!matchesNeedle(a.factoringIncomeLabel, l.label, l.partyName)) continue;
      const absAmt = decimal(l.amount).abs();
      const amount = money(absAmt);
      const fee = money(absAmt.times(decimal(feePct)));
      const netProceeds = money(absAmt.minus(decimal(fee)));
      adjustments.push({ monthStart: l.monthStart, incomeDelta: -amount, note: `factor income ${a.factoringIncomeLabel}` });
      adjustments.push({ monthStart: advanceMonth, incomeDelta: netProceeds, expenseDelta: fee, note: `factoring advance ${a.factoringIncomeLabel}` });
    }
  }

  return adjustments;
}

async function buildScenarioAdjustments(pool: Pool, a: ScenarioAssumptions): Promise<ScenarioAdjustment[]> {
  const lines = await loadCashflowLines(pool);
  return buildScenarioAdjustmentsFromLines(lines, a);
}

export interface OptimizationCandidate {
  key: string;
  label: string;
  assumptions: ScenarioAssumptions;
  finalCash: number | null;
  finalDelta: number | null;
  maxCashGap: number | null;
  baselineFirstNegative: string | null;
  firstNegative: string | null;
  confidence: "high" | "medium" | "low";
}

export async function estimateOptimizationCandidates(pool: Pool): Promise<OptimizationCandidate[]> {
  const baseline: CashMonth[] = await loadCashMonths(pool);
  if (baseline.length === 0) return [];

  const [items, lines, approvedExternal] = await Promise.all([
    loadMaturityItems(pool),
    loadCashflowLines(pool),
    loadApprovedExternalAssumptions(pool),
  ]);
  const debt = debtServiceByMonth(items).map((d) => ({ monthStart: d.monthStart, knownOutflow: d.knownOutflow }));
  const { topOutflowLabel, topIncomeLabel } = await discoverTopCounterpartyLabels(pool, lines);
  const resolvedFactoring = resolveAssumptionsWithExternal({}, approvedExternal);
  const defaultFactoringFeePct = resolvedFactoring.effectiveAssumptions.factoringFeePct ?? 0.04;

  const candidates: Array<{ key: string; label: string; assumptions: ScenarioAssumptions }> = [];
  if (topOutflowLabel) {
    candidates.push({
      key: `delay_${slugKey(topOutflowLabel)}_1m`,
      label: `Ödeme erteleme: ${topOutflowLabel} (1 ay)`,
      assumptions: { targetOutflowLabel: topOutflowLabel, targetOutflowDelayMonths: 1 },
    });
  }
  if (topIncomeLabel) {
    candidates.push({
      key: `factor_${slugKey(topIncomeLabel)}`,
      label: `Çek/faktoring: ${topIncomeLabel} tahsilatı öne çek`,
      assumptions: {
        factoringIncomeLabel: topIncomeLabel,
        factoringAdvanceMonth: baseline[0].monthStart.slice(0, 7),
        factoringFeePct: defaultFactoringFeePct,
      },
    });
  }
  candidates.push({
    key: "income_plus_10",
    label: "Gelir artışı: +%10",
    assumptions: { revenuePct: 0.1 },
  });
  candidates.push({
    key: "expense_efficiency_5",
    label: "Gider disiplini: -%5 işletme gideri",
    assumptions: { efficiencyPct: 0.05 },
  });
  if (topOutflowLabel && topIncomeLabel) {
    candidates.push({
      key: `combo_${slugKey(topOutflowLabel)}_${slugKey(topIncomeLabel)}`,
      label: `Kombinasyon: ${topOutflowLabel} ertele + ${topIncomeLabel} faktoring`,
      assumptions: {
        targetOutflowLabel: topOutflowLabel,
        targetOutflowDelayMonths: 1,
        factoringIncomeLabel: topIncomeLabel,
        factoringAdvanceMonth: baseline[0].monthStart.slice(0, 7),
        factoringFeePct: defaultFactoringFeePct,
      },
    });
  }

  const out: OptimizationCandidate[] = [];
  for (const c of candidates) {
    const { effectiveAssumptions } = resolveAssumptionsWithExternal(c.assumptions, approvedExternal);
    const adj = buildScenarioAdjustmentsFromLines(lines, effectiveAssumptions);
    const months = applyScenario(baseline, effectiveAssumptions, debt, adj);
    const cmp = compareScenarioToBaseline(months);
    out.push({
      key: c.key,
      label: c.label,
      assumptions: effectiveAssumptions,
      finalCash: cmp.scenarioFinalCash,
      finalDelta: cmp.finalDelta,
      maxCashGap: cmp.maxCashGap,
      baselineFirstNegative: cmp.baselineFirstNegative,
      firstNegative: cmp.scenarioFirstNegative,
      confidence: scenarioConfidence(cmp),
    });
  }

  return out.sort((a, b) => {
    const aGap = a.maxCashGap ?? Number.POSITIVE_INFINITY;
    const bGap = b.maxCashGap ?? Number.POSITIVE_INFINITY;
    if (aGap !== bGap) return aGap - bGap;
    const aFinal = a.finalCash ?? Number.NEGATIVE_INFINITY;
    const bFinal = b.finalCash ?? Number.NEGATIVE_INFINITY;
    return bFinal - aFinal;
  });
}

function toScenarioExternalContext(a: ExternalAssumption): ScenarioExternalContext {
  const mapping = describeExternalMapping(a);
  return {
    id: a.id,
    assumptionType: a.assumption_type,
    label: a.label,
    value: a.value_numeric,
    unit: a.unit,
    currency: a.currency,
    sourceName: a.source_name,
    sourceDate: a.source_date,
    sourceHref: "/data/assumptions",
    mappedField: mapping.mappedField,
    mappedValue: mapping.mappedValue,
    mappingSummary: mapping.mappingSummary,
  };
}

export interface ScenarioExternalBaseline {
  approved: ScenarioExternalContext[];
  defaultAssumptions: ScenarioAssumptions;
}

export async function loadScenarioExternalBaseline(pool: Pool): Promise<ScenarioExternalBaseline> {
  const approvedRaw = await loadApprovedExternalAssumptions(pool);
  const { effectiveAssumptions } = resolveAssumptionsWithExternal({}, approvedRaw);
  return {
    approved: approvedRaw.map(toScenarioExternalContext),
    defaultAssumptions: effectiveAssumptions,
  };
}

export async function createScenario(
  pool: Pool,
  input: { name: string; description?: string; scenarioType: ScenarioType; baselineLabel?: string; baselineMonthCount?: number },
  actorId: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.scenarios (name, description, scenario_type, baseline_label, baseline_month_count, created_by)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [input.name, input.description ?? null, input.scenarioType, input.baselineLabel ?? null, input.baselineMonthCount ?? null, actorId],
    );
    const id: string = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_scenario", entityTable: "scenario_runs", entityId: id,
      after: { name: input.name, type: input.scenarioType },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Disclosed assumption rows (explicit, never hidden) written per run. */
function assumptionRows(a: ScenarioAssumptions): Array<{ key: string; value: number | null; unit: string; description: string }> {
  const rows: Array<{ key: string; value: number | null; unit: string; description: string }> = [];
  if (a.revenuePct != null && a.revenuePct !== 0) rows.push({ key: "revenuePct", value: a.revenuePct, unit: "oran", description: "Gelir yüzde değişimi" });
  if (a.expensePct != null && a.expensePct !== 0) rows.push({ key: "expensePct", value: a.expensePct, unit: "oran", description: "Gider yüzde değişimi" });
  if (a.customerDelayMonths != null && a.customerDelayMonths !== 0) rows.push({ key: "customerDelayMonths", value: a.customerDelayMonths, unit: "ay", description: "Müşteri tahsilat gecikmesi" });
  if (a.capacityUtilizationPct != null && a.capacityUtilizationPct !== 0) rows.push({ key: "capacityUtilizationPct", value: a.capacityUtilizationPct, unit: "oran", description: "Kapasite kullanım değişimi (gelir vekili)" });
  if (a.efficiencyPct != null && a.efficiencyPct !== 0) rows.push({ key: "efficiencyPct", value: a.efficiencyPct, unit: "oran", description: "Verim değişimi (gider vekili)" });
  if (a.includeDebtService) rows.push({ key: "includeDebtService", value: 1, unit: "bayrak", description: "Borç-servisi (çek+taksit) gidere eklendi" });
  if (a.targetIncomeLabel && a.targetIncomeDelayMonths != null && a.targetIncomeDelayMonths !== 0)
    rows.push({ key: "targetIncomeDelayMonths", value: a.targetIncomeDelayMonths, unit: "ay", description: `Hedef gelir gecikmesi: ${a.targetIncomeLabel}` });
  if (a.targetOutflowLabel && a.targetOutflowDelayMonths != null && a.targetOutflowDelayMonths !== 0)
    rows.push({ key: "targetOutflowDelayMonths", value: a.targetOutflowDelayMonths, unit: "ay", description: `Hedef gider/odeme ertelemesi: ${a.targetOutflowLabel}` });
  if (a.factoringIncomeLabel && a.factoringAdvanceMonth)
    rows.push({ key: "factoringAdvanceMonth", value: null, unit: "ay", description: `Faktoring/iskonto advance: ${a.factoringIncomeLabel} -> ${a.factoringAdvanceMonth}` });
  if (a.factoringFeePct != null && a.factoringFeePct !== 0)
    rows.push({ key: "factoringFeePct", value: a.factoringFeePct, unit: "oran", description: "Faktoring/iskonto maliyeti" });
  return rows;
}

function externalContextRows(ctx: ScenarioExternalContext[]): Array<{ key: string; value: number | null; unit: string; description: string }> {
  return ctx.map((a) => ({
    key: `external:${a.assumptionType}`,
    value: a.value,
    unit: a.unit,
    description: `Dış varsayım: ${a.label} (${a.sourceName} / ${a.sourceDate})`,
  }));
}

const comparisonRows = (c: ScenarioComparison): Array<{ metric: string; base: number | null; scen: number | null; delta: number | null }> => [
  { metric: "final_cash", base: c.baselineFinalCash, scen: c.scenarioFinalCash, delta: c.finalDelta },
  { metric: "worst_balance", base: null, scen: c.worstBalance, delta: null },
  { metric: "max_cash_gap", base: null, scen: c.maxCashGap, delta: null },
  { metric: "minimum_financing_need", base: null, scen: c.maxCashGap, delta: null },
];

export interface RunResult {
  runId: string;
  comparison: ScenarioComparison;
  insights: string[];
}

export async function runScenario(
  pool: Pool,
  scenarioId: string,
  assumptions: ScenarioAssumptions,
  actorId: string,
  options?: { useExternalAssumptions?: boolean; scenarioType?: ScenarioType },
): Promise<RunResult> {
  // baseline is READ (never written)
  const baseline: CashMonth[] = await loadCashMonths(pool);
  const items = await loadMaturityItems(pool);
  const debt = debtServiceByMonth(items).map((d) => ({ monthStart: d.monthStart, knownOutflow: d.knownOutflow }));

  let resolvedScenarioType: ScenarioType = options?.scenarioType ?? "combined_custom_scenario";
  if (!options?.scenarioType) {
    const scenMeta = await pool
      .query<{ scenario_type: ScenarioType }>(
        `select scenario_type from public.scenarios where id = $1 limit 1`,
        [scenarioId],
      )
      .catch(() => ({ rows: [] as Array<{ scenario_type: ScenarioType }> }));
    if (scenMeta.rows[0]?.scenario_type) {
      resolvedScenarioType = scenMeta.rows[0].scenario_type;
    }
  }

  const approvedExternal = await loadApprovedExternalAssumptions(pool);
  const externalContext = approvedExternal.map(toScenarioExternalContext);
  const { effectiveAssumptions, appliedExternal } = resolveAssumptionsWithExternal(
    assumptions,
    approvedExternal,
    {
      scenarioType: resolvedScenarioType,
      useExternalAssumptions: options?.useExternalAssumptions ?? true,
    },
  );

  const adjustments = await buildScenarioAdjustments(pool, effectiveAssumptions);
  const storedAssumptions =
    externalContext.length > 0
      ? {
          ...effectiveAssumptions,
          explicitOverrides: assumptions,
          externalContext,
          appliedExternalKeys: appliedExternal.map((x) => x.assumptionType),
        }
      : effectiveAssumptions;

  const months = applyScenarioCore(baseline, effectiveAssumptions, debt, adjustments);
  const comparison = compareScenarioToBaseline(months);
  const confidence = scenarioConfidence(comparison);
  const insights = buildScenarioInsights(comparison, effectiveAssumptions);
  if (appliedExternal.length > 0) {
    insights.push(
      `Dış varsayım baz girdileri uygulandı (/data/assumptions): ${appliedExternal.map((a) => `${a.label} → ${a.mappingSummary}`).join("; ")}.`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const runIns = await client.query(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          baseline_first_negative, scenario_first_negative, worst_month, worst_balance,
          max_cash_gap, recovery_month, month_count, null_month_count, confidence, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [
        scenarioId, JSON.stringify(storedAssumptions),
        comparison.baselineFinalCash, comparison.scenarioFinalCash, comparison.finalDelta,
        comparison.baselineFirstNegative, comparison.scenarioFirstNegative,
        comparison.worstMonth, comparison.worstBalance, comparison.maxCashGap, comparison.recoveryMonth,
        comparison.monthCount, comparison.nullMonthCount, confidence,
        insights.join(" · "),
      ],
    );
    const runId: string = runIns.rows[0].id;

    for (const m of months) {
      await client.query(
        `insert into public.scenario_run_lines
           (run_id, month_start, baseline_income, scenario_income, baseline_expense, scenario_expense,
            baseline_closing, scenario_closing, delta)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (run_id, month_start) do nothing`,
        [runId, m.monthStart, m.baselineIncome, m.scenarioIncome, m.baselineExpense, m.scenarioExpense,
         m.baselineClosing, m.scenarioClosing, m.delta],
      );
    }
    for (const ar of [...assumptionRows(effectiveAssumptions), ...externalContextRows(externalContext)]) {
      await client.query(
        `insert into public.scenario_assumptions (run_id, key, value_numeric, unit, description)
         values ($1,$2,$3,$4,$5)`,
        [runId, ar.key, ar.value, ar.unit, ar.description],
      );
    }
    for (const cr of comparisonRows(comparison)) {
      await client.query(
        `insert into public.scenario_comparisons (run_id, metric, baseline_value, scenario_value, delta)
         values ($1,$2,$3,$4,$5) on conflict (run_id, metric) do nothing`,
        [runId, cr.metric, cr.base, cr.scen, cr.delta],
      );
    }
    await audit(client, {
      actor: actorId, action: "run_scenario", entityTable: "scenario_runs", entityId: runId,
      after: {
        scenarioId,
        assumptions: storedAssumptions,
        adjustmentCount: adjustments.length,
        externalContextCount: externalContext.length,
        appliedExternalCount: appliedExternal.length,
        finalDelta: comparison.finalDelta,
        confidence,
      },
    });
    await client.query("commit");
    return { runId, comparison, insights };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Convenience: create a scenario and run it in one call (UI path). */
export async function createAndRun(
  pool: Pool,
  input: {
    name: string;
    scenarioType: ScenarioType;
    assumptions: ScenarioAssumptions;
    useExternalAssumptions?: boolean;
  },
  actorId: string,
): Promise<RunResult & { scenarioId: string }> {
  const baseline = await loadCashMonths(pool);
  const first = baseline[0]?.monthStart?.slice(0, 7);
  const last = baseline[baseline.length - 1]?.monthStart?.slice(0, 7);
  const scenarioId = await createScenario(pool, {
    name: input.name, scenarioType: input.scenarioType,
    baselineLabel: baseline.length ? `nakit akış ${baseline.length} ay ${first}..${last}` : "baz veri yok",
    baselineMonthCount: baseline.length,
  }, actorId);
  const run = await runScenario(
    pool,
    scenarioId,
    input.assumptions,
    actorId,
    {
      scenarioType: input.scenarioType,
      useExternalAssumptions: input.useExternalAssumptions ?? true,
    },
  );
  return { scenarioId, ...run };
}

export async function compareScenarioToBaselineRun(pool: Pool, runId: string) {
  return (await pool.query(
    `select metric, baseline_value as base, scenario_value as scen, delta
     from public.scenario_comparisons where run_id=$1 order by metric`,
    [runId],
  )).rows.map((x) => ({
    metric: x.metric, base: moneyOrNull(x.base), scen: moneyOrNull(x.scen), delta: moneyOrNull(x.delta),
  }));
}

export async function loadScenarioRun(pool: Pool, runId: string) {
  const run = await pool.query(
    `select r.id, r.scenario_id, s.name, s.scenario_type, s.baseline_label,
            to_char(r.run_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as run_at,
            r.assumptions, r.baseline_final_cash as base_final, r.scenario_final_cash as scen_final,
            r.final_delta,
            to_char(r.baseline_first_negative,'YYYY-MM-DD') as base_first_neg,
            to_char(r.scenario_first_negative,'YYYY-MM-DD') as scen_first_neg,
            to_char(r.worst_month,'YYYY-MM-DD') as worst_month, r.worst_balance,
            r.max_cash_gap as max_gap, to_char(r.recovery_month,'YYYY-MM-DD') as recovery_month,
            r.month_count, r.null_month_count, r.confidence, r.notes
     from public.scenario_runs r join public.scenarios s on s.id=r.scenario_id where r.id=$1`,
    [runId],
  );
  if (run.rowCount === 0) return null;
  const lines = await pool.query(
    `select to_char(month_start,'YYYY-MM-DD') as month_start,
            baseline_income as base_inc, scenario_income as scen_inc,
            baseline_expense as base_exp, scenario_expense as scen_exp,
            baseline_closing as base_close, scenario_closing as scen_close, delta
     from public.scenario_run_lines where run_id=$1 order by month_start`,
    [runId],
  );
  const assumptions = await pool.query(
    `select key, value_numeric as value, unit, description from public.scenario_assumptions where run_id=$1`,
    [runId],
  );
  return {
    run: {
      ...run.rows[0],
      base_final: moneyOrNull(run.rows[0].base_final), scen_final: moneyOrNull(run.rows[0].scen_final),
      final_delta: moneyOrNull(run.rows[0].final_delta), worst_balance: moneyOrNull(run.rows[0].worst_balance),
      max_gap: moneyOrNull(run.rows[0].max_gap),
    },
    lines: lines.rows.map((x) => ({
      ...x,
      base_inc: moneyOrNull(x.base_inc), scen_inc: moneyOrNull(x.scen_inc),
      base_exp: moneyOrNull(x.base_exp), scen_exp: moneyOrNull(x.scen_exp),
      base_close: moneyOrNull(x.base_close), scen_close: moneyOrNull(x.scen_close),
      delta: moneyOrNull(x.delta),
    })),
    assumptions: assumptions.rows.map((x) => ({ ...x, value: rateOrNull(x.value) })),
  };
}

export async function listScenarioRuns(pool: Pool) {
  const r = await pool.query(
    `select r.id, s.name, s.scenario_type, r.final_delta, r.confidence,
            to_char(r.scenario_first_negative,'YYYY-MM-DD') as scen_first_neg,
            to_char(r.run_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as run_at
     from public.scenario_runs r join public.scenarios s on s.id=r.scenario_id
     where r.archived_at is null
     order by r.run_at desc limit 50`,
  );
  return r.rows.map((x) => ({ ...x, final_delta: moneyOrNull(x.final_delta) })) as Array<{ id: string; name: string; scenario_type: string; final_delta: number | null; confidence: string; scen_first_neg: string | null; run_at: string }>;
}

/** Safe: only removes scenario_* rows (cascade). Baseline is untouched. Audited. */
export async function deleteScenarioRun(pool: Pool, runId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const del = await client.query(`delete from public.scenario_runs where id=$1 returning id`, [runId]);
    if (del.rowCount !== 1) throw new DomainError("FORBIDDEN", "Bu senaryo silinemedi veya yetkiniz yok.");
    await audit(client, {
      actor: actorId, action: "delete_scenario_run", entityTable: "scenario_runs", entityId: runId,
      after: { deleted: true },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
