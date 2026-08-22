// Faz 28 — budget/forecast engine: audited writes and read models.
//
// Like ./rules.ts, this module deliberately has no path to @/lib/ai. The AI layer may read what
// this produces; nothing here asks a model anything. phase28:verify checks the import graph.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import {
  SOURCE_CONFIDENCE, accuracy, canTransition, variance,
  type SourceKind, type VersionStatus,
} from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const createBudgetLineSchema = z.object({
  budgetId: z.uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dönem başlangıcı YYYY-AA-GG olmalı"),
  direction: z.enum(["income", "expense"]),
  amount: z.number().nonnegative("Bütçe tutarı negatif olamaz"),
  currency: z.string().trim().length(3).default("TRY"),
  costCenterId: z.uuid().nullable().optional(),
  departmentId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const setLineVersionSchema = z.object({
  lineId: z.uuid(),
  status: z.enum(["approved", "superseded"]),
  supersededByLineId: z.uuid().nullable().optional(),
});

export const createForecastLineSchema = z.object({
  forecastId: z.uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["inflow", "outflow"]),
  amount: z.number(),
  sourceKind: z.enum(["contracted", "scheduled", "historical", "manual", "estimated"]),
  confidence: z.number().min(0).max(1).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const recordActualSchema = z.object({
  lineId: z.uuid(),
  actualAmount: z.number(),
});

/* ── budget writes ────────────────────────────────────────────────────────────────────── */

export async function createBudgetLine(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createBudgetLineSchema, raw, "Bütçe satırı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.budget_lines
         (budget_id, period_start, direction, amount, currency,
          cost_center_id, department_id, project_id, category_id, notes, created_by)
       values ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id`,
      [input.budgetId, input.periodStart, input.direction, input.amount, input.currency,
       input.costCenterId ?? null, input.departmentId ?? null, input.projectId ?? null,
       input.categoryId ?? null, input.notes ?? null, actorId]);
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_budget_line",
      entityTable: "budget_lines", entityId: id,
      after: {
        budgetId: input.budgetId, periodStart: input.periodStart, direction: input.direction,
        amount: input.amount, versionStatus: "draft", automated: false,
      },
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

/**
 * Move a budget or forecast line through its version lifecycle.
 *
 * The transition is checked here as well as by the trigger. Not redundancy for its own sake: the
 * guard raises a PostgreSQL exception that reaches the operator as a 500, whereas this produces a
 * sentence naming why. The guard stays the authority — if this check were ever wrong, the
 * database would still refuse.
 */
export async function setLineVersion(
  pool: Pool, table: "budget_lines" | "forecast_lines", raw: unknown, actorId: string,
): Promise<void> {
  const input = parseOrThrow(setLineVersionSchema, raw, "Versiyon değişikliği");
  // The table name is chosen from a two-value union, never from caller input, so it is safe to
  // interpolate — but it is still narrowed explicitly rather than trusted.
  const target = table === "budget_lines" ? "budget_lines" : "forecast_lines";

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, version_status from public.${target} where id=$1 for update`, [input.lineId]);
    if (before.rowCount === 0) throw new DomainError("Satır bulunamadı.");
    const current = before.rows[0].version_status as VersionStatus;

    if (current === input.status) throw new DomainError("Satır zaten bu durumda.");
    if (!canTransition(current, input.status)) {
      throw new DomainError(
        `Bu geçiş yapılamaz: ${current} → ${input.status}. ` +
        `Onaylanmış bir satır yeniden taslağa alınamaz; yerine yeni bir versiyon oluşturun.`);
    }

    if (input.status === "approved") {
      await client.query(
        `update public.${target} set version_status='approved', approved_at=now(), approved_by=$2
         where id=$1`, [input.lineId, actorId]);
    } else {
      await client.query(
        `update public.${target}
           set version_status='superseded', superseded_at=now(), superseded_by_line_id=$2
         where id=$1`, [input.lineId, input.supersededByLineId ?? null]);
    }

    await audit(client, {
      actor: actorId, action: `${target}_${input.status}`,
      entityTable: target, entityId: input.lineId,
      before: { versionStatus: current },
      after: { versionStatus: input.status, automated: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── forecast writes ──────────────────────────────────────────────────────────────────── */

export async function createForecastLine(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createForecastLineSchema, raw, "Tahmin satırı");
  if (input.periodEnd < input.periodStart) {
    throw new DomainError("Dönem sonu, dönem başlangıcından önce olamaz.");
  }
  // An unscored line takes the default for its source kind. The stored value is whatever was
  // actually used, so a later change to the defaults cannot silently rewrite past confidence.
  const confidence = input.confidence ?? SOURCE_CONFIDENCE[input.sourceKind as SourceKind];

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.forecast_lines
         (forecast_id, period_start, period_end, direction, amount, source_kind, confidence,
          notes, created_by)
       values ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9)
       returning id`,
      [input.forecastId, input.periodStart, input.periodEnd, input.direction, input.amount,
       input.sourceKind, confidence, input.notes ?? null, actorId]);
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_forecast_line",
      entityTable: "forecast_lines", entityId: id,
      after: {
        forecastId: input.forecastId, periodStart: input.periodStart, direction: input.direction,
        amount: input.amount, sourceKind: input.sourceKind, confidence, automated: false,
      },
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

/**
 * Record what actually happened for a forecast line.
 *
 * This is how forecast-vs-actual gets its second number. It does NOT touch the forecast amount —
 * revising a prediction after seeing the outcome would make every accuracy KPI meaningless, and
 * the version lifecycle exists precisely so a revision is a new line rather than an edit.
 */
export async function recordActual(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(recordActualSchema, raw, "Gerçekleşen tutar");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, amount, actual_amount from public.forecast_lines where id=$1 for update`,
      [input.lineId]);
    if (before.rowCount === 0) throw new DomainError("Tahmin satırı bulunamadı.");

    await client.query(
      `update public.forecast_lines set actual_amount=$2, actual_recorded_at=now() where id=$1`,
      [input.lineId, input.actualAmount]);

    await audit(client, {
      actor: actorId, action: "record_forecast_actual",
      entityTable: "forecast_lines", entityId: input.lineId,
      before: { actualAmount: moneyOrNull(before.rows[0].actual_amount) },
      after: {
        actualAmount: input.actualAmount,
        // Recorded explicitly: the forecast figure itself is never rewritten here.
        forecastAmountUnchanged: moneyOrNull(before.rows[0].amount), automated: false,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export async function loadBudgetVsActual(pool: Pool, budgetId?: string) {
  const res = await pool.query(
    `select budget_id, budget_name, fiscal_year, budget_line_id,
            to_char(period_start,'YYYY-MM-DD') as period_start, direction,
            cost_center_name, department_name, project_name, currency,
            budget_amount, actual_amount, variance_amount, variance_ratio, variance_verdict,
            department_scoped
     from public.budget_vs_actual
     where ($1::uuid is null or budget_id = $1)
     order by period_start, direction, cost_center_name nulls last`,
    [budgetId ?? null]);
  return res.rows.map((r) => ({
    budgetId: r.budget_id,
    budgetName: r.budget_name,
    fiscalYear: Number(r.fiscal_year),
    lineId: r.budget_line_id,
    periodStart: r.period_start,
    direction: r.direction as "income" | "expense",
    costCenterName: r.cost_center_name,
    departmentName: r.department_name,
    projectName: r.project_name,
    currency: r.currency,
    budgetAmount: moneyOrNull(r.budget_amount) ?? 0,
    actualAmount: moneyOrNull(r.actual_amount),
    varianceAmount: moneyOrNull(r.variance_amount),
    varianceRatio: rateOrNull(r.variance_ratio),
    verdict: r.variance_verdict as string,
    // Surfaced so a screen can explain WHY an actual is missing instead of showing a blank.
    departmentScoped: Boolean(r.department_scoped),
  }));
}

/**
 * Budget-vs-actual recomputed in the application from the same two raw figures.
 *
 * Two independent computations of one number, the pattern Faz 26/27 used: phase28:verify runs
 * both over identical fixtures and fails if they disagree.
 */
export async function loadVarianceRecomputed(pool: Pool, budgetId?: string) {
  const rows = await loadBudgetVsActual(pool, budgetId);
  return rows.map((r) => ({
    lineId: r.lineId,
    sql: { amount: r.varianceAmount, verdict: r.verdict },
    ts: variance(r.direction, r.budgetAmount, r.actualAmount),
  }));
}

export async function loadCashForecast13w(pool: Pool, forecastId?: string) {
  const res = await pool.query(
    `select forecast_id, forecast_name, week_no,
            to_char(week_start,'YYYY-MM-DD') as week_start,
            to_char(week_end,'YYYY-MM-DD') as week_end,
            currency, inflow, outflow, net_flow, net_flow_contracted,
            net_flow_confidence_weighted, line_count, estimated_line_count
     from public.cash_forecast_13w
     where ($1::uuid is null or forecast_id = $1)
     order by forecast_name, week_no`,
    [forecastId ?? null]);
  return res.rows.map((r) => ({
    forecastId: r.forecast_id,
    forecastName: r.forecast_name,
    weekNo: Number(r.week_no),
    weekStart: r.week_start,
    weekEnd: r.week_end,
    currency: r.currency,
    inflow: moneyOrNull(r.inflow) ?? 0,
    outflow: moneyOrNull(r.outflow) ?? 0,
    netFlow: moneyOrNull(r.net_flow) ?? 0,
    netFlowContracted: moneyOrNull(r.net_flow_contracted) ?? 0,
    netFlowConfidenceWeighted: moneyOrNull(r.net_flow_confidence_weighted) ?? 0,
    lineCount: Number(r.line_count),
    estimatedLineCount: Number(r.estimated_line_count),
  }));
}

export async function loadForecastAccuracy(pool: Pool) {
  const res = await pool.query(
    `select forecast_id, forecast_name, horizon_kind, source_kind, measured_line_count,
            forecast_total, actual_total, bias_total, absolute_error_total, mape,
            zero_forecast_lines
     from public.forecast_accuracy order by forecast_name, source_kind`);
  return res.rows.map((r) => ({
    forecastId: r.forecast_id,
    forecastName: r.forecast_name,
    horizonKind: r.horizon_kind,
    sourceKind: r.source_kind as SourceKind,
    measuredLineCount: Number(r.measured_line_count),
    forecastTotal: moneyOrNull(r.forecast_total),
    actualTotal: moneyOrNull(r.actual_total),
    biasTotal: moneyOrNull(r.bias_total),
    absoluteErrorTotal: moneyOrNull(r.absolute_error_total),
    mape: rateOrNull(r.mape),
    zeroForecastLines: intOrNull(r.zero_forecast_lines) ?? 0,
  }));
}

/** Accuracy recomputed in TypeScript from the raw line pairs — the agreement check's other half. */
export async function loadAccuracyRecomputed(pool: Pool, forecastId: string) {
  const res = await pool.query(
    `select amount, actual_amount from public.forecast_lines
     where forecast_id=$1 and actual_amount is not null
       and version_status in ('approved','superseded')`, [forecastId]);
  return accuracy(res.rows.map((r) => ({ forecast: r.amount, actual: r.actual_amount })));
}

export async function loadForecastCoverage(pool: Pool) {
  const res = await pool.query(
    `select forecast_id, forecast_name, line_count, measured_count, approved_count, draft_count,
            measured_ratio, contracted_count, estimated_count
     from public.forecast_coverage order by forecast_name`);
  return res.rows.map((r) => ({
    forecastId: r.forecast_id,
    forecastName: r.forecast_name,
    lineCount: Number(r.line_count),
    measuredCount: Number(r.measured_count),
    approvedCount: Number(r.approved_count),
    draftCount: Number(r.draft_count),
    measuredRatio: rateOrNull(r.measured_ratio),
    contractedCount: Number(r.contracted_count),
    estimatedCount: Number(r.estimated_count),
  }));
}
