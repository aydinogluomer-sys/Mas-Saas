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
import { withPinnedRead } from "@/lib/pg-concurrency";
import { decideApproval, requestApprovalWithClient } from "@/lib/approvals/engine";
import {
  SOURCE_CONFIDENCE, accuracy, canTransition, variance,
  type SourceKind, type VersionStatus,
} from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const createBudgetSchema = z.object({
  name: z.string().trim().min(2, "Bütçe adı en az 2 karakter olmalı").max(160),
  fiscalYear: z.coerce.number().int().min(2000).max(2100),
  periodKind: z.enum(["monthly", "annual"]).default("monthly"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  notes: z.string().trim().max(1000).optional(),
});

export const createForecastSchema = z.object({
  name: z.string().trim().min(2, "Tahmin adı en az 2 karakter olmalı").max(160),
  horizonKind: z.enum(["weekly_13", "monthly_12", "custom"]).default("weekly_13"),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Başlangıç tarihi YYYY-AA-GG olmalı"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  notes: z.string().trim().max(1000).optional(),
});

export const approveBudgetVersionSchema = z.object({
  table: z.enum(["budget_lines", "forecast_lines"]).default("budget_lines"),
  lineId: z.uuid().optional(),
  budgetId: z.uuid().optional(),
  note: z.string().trim().max(500).optional(),
});

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

export async function createBudget(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createBudgetSchema, raw, "Bütçe");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.budgets (name, fiscal_year, period_kind, currency, notes, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [input.name, input.fiscalYear, input.periodKind, input.currency, input.notes ?? null, actorId],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_budget",
      entityTable: "budgets",
      entityId: id,
      after: {
        name: input.name,
        fiscalYear: input.fiscalYear,
        periodKind: input.periodKind,
        currency: input.currency,
        automated: false,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    if ((e as { code?: string })?.code === "23505") {
      throw new DomainError("CONFLICT", "Bu mali yıl için aynı adda bir bütçe zaten mevcut.");
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function createForecast(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createForecastSchema, raw, "Nakit tahmini");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.forecasts (name, horizon_kind, anchor_date, currency, notes, created_by)
       values ($1, $2, $3::date, $4, $5, $6)
       returning id`,
      [input.name, input.horizonKind, input.anchorDate, input.currency, input.notes ?? null, actorId],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_forecast",
      entityTable: "forecasts",
      entityId: id,
      after: {
        name: input.name,
        horizonKind: input.horizonKind,
        anchorDate: input.anchorDate,
        currency: input.currency,
        automated: false,
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


/**
 * Faz 48 / 50: Submit a draft budget or forecast line into the maker-checker approval queue.
 */
export async function requestPlanningLineApproval(
  pool: Pool,
  table: "budget_lines" | "forecast_lines",
  lineId: string,
  actorId: string,
  note?: string,
): Promise<{ approvalId: string }> {
  const target = table === "budget_lines" ? "budget_lines" : "forecast_lines";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const row =
      target === "budget_lines"
        ? await client.query<{
            id: string;
            version_status: string;
            amount: string;
            currency: string;
            period_start: string;
            direction: string;
          }>(
            `select id, version_status, amount, currency,
                    to_char(period_start,'YYYY-MM-DD') as period_start, direction
               from public.budget_lines where id=$1 for update`,
            [lineId],
          )
        : await client.query<{
            id: string;
            version_status: string;
            amount: string;
            currency: string;
            period_start: string;
            direction: string;
          }>(
            `select fl.id, fl.version_status, fl.amount, coalesce(f.currency, 'TRY') as currency,
                    to_char(fl.period_start,'YYYY-MM-DD') as period_start, fl.direction
               from public.forecast_lines fl
               left join public.forecasts f on f.id = fl.forecast_id
              where fl.id=$1 for update of fl`,
            [lineId],
          );
    if (row.rowCount === 0) throw new DomainError("NOT_FOUND", "Planlama satırı bulunamadı.");
    const r = row.rows[0];
    if (r.version_status !== "draft") {
      throw new DomainError("CONFLICT", `Yalnız 'draft' durumundaki satır onaya gönderilebilir (mevcut: '${r.version_status}').`);
    }
    const { approvalId } = await requestApprovalWithClient(
      client,
      {
        subjectTable: target,
        subjectId: lineId,
        subjectLabel: `${target === "budget_lines" ? "Bütçe" : "Tahmin"} satırı (${r.period_start} · ${r.direction})`,
        requestKind: "budget",
        ruleCode: "planning_line_maker_checker",
        amount: moneyOrNull(r.amount) ?? undefined,
        currency: r.currency,
        note,
      },
      actorId,
      { reuseOpen: true },
    );
    await client.query("commit");
    return { approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}


/**
 * Faz 50 (D4): Maker-checker aware approval of a single planning line (budget_lines / forecast_lines)
 * or all eligible draft lines of a budget container (`budgetId`).
 *
 * When an open approval round already exists in `public.approvals`, this closes that round via
 * `decideApproval` so `/data/approvals` and `/cashflow/budget` never drift apart.
 */
export async function approveBudgetVersion(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ approvedCount: number; skippedOwnDrafts: number }> {
  const input = parseOrThrow(approveBudgetVersionSchema, raw, "Bütçe versiyon onayı");
  const target = input.table === "forecast_lines" ? "forecast_lines" : "budget_lines";

  if (!input.lineId && !input.budgetId) {
    throw new DomainError("VALIDATION", "Onaylanacak satır (lineId) veya bütçe (budgetId) seçilmelidir.");
  }

  const approveSingleLine = async (lineId: string): Promise<"approved" | "skipped_own"> => {
    const checkRes = await pool.query<{
      id: string;
      version_status: string;
      created_by: string | null;
      open_approval_id: string | null;
    }>(
      `select l.id, l.version_status, l.created_by,
              (select a.id
                 from public.approvals a
                where a.subject_table = $2
                  and a.subject_id = l.id
                  and a.status in ('pending', 'reworked')
                order by a.round_no desc
                limit 1) as open_approval_id
         from public.${target} l
        where l.id = $1`,
      [lineId, target],
    );
    if (checkRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Planlama satırı bulunamadı.");
    }
    const row = checkRes.rows[0];
    if (row.version_status !== "draft") {
      throw new DomainError("CONFLICT", `Yalnız 'draft' durumundaki satır onaylanabilir (mevcut: '${row.version_status}').`);
    }
    if (row.created_by && row.created_by === actorId) {
      return "skipped_own";
    }
    if (row.open_approval_id) {
      await decideApproval(
        pool,
        { approvalId: row.open_approval_id, decision: "approved", note: input.note },
        actorId,
      );
    } else {
      await setLineVersion(pool, target, { lineId, status: "approved" }, actorId);
    }
    return "approved";
  };

  if (input.lineId) {
    const outcome = await approveSingleLine(input.lineId);
    if (outcome === "skipped_own") {
      throw new DomainError(
        "FORBIDDEN",
        "Kendi oluşturduğunuz bütçe/tahmin satırını onaylayamazsınız (maker ≠ checker).",
      );
    }
    return { approvedCount: 1, skippedOwnDrafts: 0 };
  }

  const drafts = await pool.query<{ id: string }>(
    `select id from public.budget_lines
      where budget_id = $1 and version_status = 'draft'
      order by period_start, created_at`,
    [input.budgetId!],
  );
  if (drafts.rowCount === 0) {
    throw new DomainError("CONFLICT", "Bu bütçede onay bekleyen taslak satır bulunmuyor.");
  }

  let approvedCount = 0;
  let skippedOwnDrafts = 0;
  for (const d of drafts.rows) {
    const outcome = await approveSingleLine(d.id);
    if (outcome === "approved") approvedCount += 1;
    else skippedOwnDrafts += 1;
  }
  if (approvedCount === 0 && skippedOwnDrafts > 0) {
    throw new DomainError(
      "FORBIDDEN",
      "Taslak satırların tamamı sizin tarafınızdan oluşturulmuş; maker ≠ checker kuralı gereği ikinci bir onaylayıcı gerekir.",
    );
  }
  return { approvedCount, skippedOwnDrafts };
}

export interface BudgetVarianceSummaryRow {
  budgetId: string;
  budgetName: string;
  fiscalYear: number;
  direction: "income" | "expense";
  currency: string;
  lineCount: number;
  budgetTotal: number;
  actualTotal: number | null;
  varianceTotal: number | null;
  overBudgetLines: number;
  notMeasuredLines: number;
  departmentLinesUnmeasurable: number;
}

export async function loadBudgetVarianceSummary(pool: Pool): Promise<BudgetVarianceSummaryRow[]> {
  const res = await pool.query(
    `select budget_id::text,
            budget_name,
            fiscal_year,
            direction,
            currency,
            line_count,
            budget_total,
            actual_total,
            variance_total,
            over_budget_lines,
            not_measured_lines,
            department_lines_unmeasurable
       from public.budget_variance_summary
      order by fiscal_year desc, budget_name, direction`,
  );
  return res.rows.map((r) => ({
    budgetId: r.budget_id as string,
    budgetName: r.budget_name as string,
    fiscalYear: Number(r.fiscal_year),
    direction: r.direction as "income" | "expense",
    currency: (r.currency as string) ?? "TRY",
    lineCount: intOrNull(r.line_count) ?? 0,
    budgetTotal: moneyOrNull(r.budget_total) ?? 0,
    actualTotal: moneyOrNull(r.actual_total),
    varianceTotal: moneyOrNull(r.variance_total),
    overBudgetLines: intOrNull(r.over_budget_lines) ?? 0,
    notMeasuredLines: intOrNull(r.not_measured_lines) ?? 0,
    departmentLinesUnmeasurable: intOrNull(r.department_lines_unmeasurable) ?? 0,
  }));
}

export async function loadBudgetsCatalog(pool: Pool) {
  return withPinnedRead(pool, loadBudgetsCatalogInner);
}

async function loadBudgetsCatalogInner(pool: Pool) {
  const [budgets, lines, forecasts, forecastLines, costCenters, departments, projects, categories] =
    await Promise.all([
      pool.query(
        `select b.id, b.name, b.fiscal_year, b.period_kind, b.currency, b.is_active,
                count(l.id)::int as total_lines,
                count(l.id) filter (where l.version_status = 'draft')::int as draft_lines,
                count(l.id) filter (where l.version_status = 'approved')::int as approved_lines
           from public.budgets b
           left join public.budget_lines l on l.budget_id = b.id
          group by b.id
          order by b.fiscal_year desc, b.name`,
      ),
      pool.query(
        `select l.id, l.budget_id, b.name as budget_name, b.fiscal_year,
                to_char(l.period_start, 'YYYY-MM-DD') as period_start,
                l.direction, l.amount, l.currency, l.version_no, l.version_status,
                l.created_by, l.notes,
                cc.name as cost_center_name,
                d.name as department_name,
                p.name as project_name,
                cat.name as category_name,
                (select a.status
                   from public.approvals a
                  where a.subject_table = 'budget_lines'
                    and a.subject_id = l.id
                  order by a.round_no desc
                  limit 1) as approval_queue_status
           from public.budget_lines l
           join public.budgets b on b.id = l.budget_id
           left join public.cost_centers cc on cc.id = l.cost_center_id
           left join public.departments d on d.id = l.department_id
           left join public.projects p on p.id = l.project_id
           left join public.categories cat on cat.id = l.category_id
          order by l.version_status = 'draft' desc, l.period_start desc, l.created_at desc
          limit 200`,
      ),
      pool.query(
        `select id, name, horizon_kind, to_char(anchor_date, 'YYYY-MM-DD') as anchor_date,
                currency, is_active
           from public.forecasts
          where is_active
          order by anchor_date desc, name`,
      ),
      pool.query(
        `select fl.id, fl.forecast_id, f.name as forecast_name,
                to_char(fl.period_start, 'YYYY-MM-DD') as period_start,
                to_char(fl.period_end, 'YYYY-MM-DD') as period_end,
                fl.direction, fl.amount, coalesce(fl.currency, f.currency, 'TRY') as currency,
                fl.source_kind, fl.confidence, fl.version_status, fl.created_by,
                fl.actual_amount,
                to_char(fl.actual_recorded_at, 'YYYY-MM-DD') as actual_recorded_at,
                (select a.status
                   from public.approvals a
                  where a.subject_table = 'forecast_lines'
                    and a.subject_id = fl.id
                  order by a.round_no desc
                  limit 1) as approval_queue_status
           from public.forecast_lines fl
           join public.forecasts f on f.id = fl.forecast_id
          order by fl.version_status = 'draft' desc, fl.period_start asc
          limit 120`,
      ),
      pool.query(`select id, code, name from public.cost_centers where is_active order by code`),
      pool.query(`select id, code, name from public.departments where is_active order by code`),
      pool.query(`select id, code, name from public.projects where is_active order by code`),
      pool.query(`select id, name from public.categories order by name`),
    ]);

  return {
    budgets: budgets.rows.map((b) => ({
      id: b.id as string,
      name: b.name as string,
      fiscalYear: Number(b.fiscal_year),
      periodKind: b.period_kind as "monthly" | "annual",
      currency: b.currency as string,
      isActive: Boolean(b.is_active),
      totalLines: Number(b.total_lines),
      draftLines: Number(b.draft_lines),
      approvedLines: Number(b.approved_lines),
    })),
    lines: lines.rows.map((l) => ({
      id: l.id as string,
      budgetId: l.budget_id as string,
      budgetName: l.budget_name as string,
      fiscalYear: Number(l.fiscal_year),
      periodStart: l.period_start as string,
      direction: l.direction as "income" | "expense",
      amount: moneyOrNull(l.amount) ?? 0,
      currency: l.currency as string,
      versionNo: Number(l.version_no),
      versionStatus: l.version_status as VersionStatus,
      createdBy: (l.created_by as string | null) ?? null,
      notes: (l.notes as string | null) ?? null,
      dimensionLabel:
        (l.department_name as string | null) ??
        (l.project_name as string | null) ??
        (l.cost_center_name as string | null) ??
        (l.category_name as string | null) ??
        "Şirket geneli",
      approvalQueueStatus: (l.approval_queue_status as string | null) ?? null,
    })),
    forecasts: forecasts.rows.map((f) => ({
      id: f.id as string,
      name: f.name as string,
      horizonKind: f.horizon_kind as string,
      anchorDate: f.anchor_date as string,
      currency: f.currency as string,
    })),
    forecastLines: forecastLines.rows.map((fl) => ({
      id: fl.id as string,
      forecastId: fl.forecast_id as string,
      forecastName: fl.forecast_name as string,
      periodStart: fl.period_start as string,
      periodEnd: fl.period_end as string,
      direction: fl.direction as "inflow" | "outflow",
      amount: moneyOrNull(fl.amount) ?? 0,
      actualAmount: moneyOrNull(fl.actual_amount),
      actualRecordedAt: (fl.actual_recorded_at as string | null) ?? null,
      currency: fl.currency as string,
      sourceKind: fl.source_kind as SourceKind,
      confidence: rateOrNull(fl.confidence),
      versionStatus: fl.version_status as VersionStatus,
      createdBy: (fl.created_by as string | null) ?? null,
      approvalQueueStatus: (fl.approval_queue_status as string | null) ?? null,
    })),
    costCenters: costCenters.rows as Array<{ id: string; code: string; name: string }>,
    departments: departments.rows as Array<{ id: string; code: string; name: string }>,
    projects: projects.rows as Array<{ id: string; code: string; name: string }>,
    categories: categories.rows as Array<{ id: string; name: string }>,
  };
}
