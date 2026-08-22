// Faz 29 — optimisation engine: runs the deterministic solver and records its PROPOSALS.
//
// ═══ THE BASELINE IS READ, NEVER WRITTEN ═══
//
// This is the Faz 8/13 invariant, restated for a new run type. Everything this module reads —
// payment_instances, credit_facilities, treasury_policies, cashflow_months — it reads. The only
// tables it writes are optimization_runs, optimization_recommendations, audit_logs, and (via the
// Faz 24A engine) approvals. There is no code path here that updates a due date, an amount or a
// status on any financial record, and phase29:verify proves it by snapshotting a baseline
// scenario_run and every cashflow_months row, executing this engine, and comparing.
//
// ═══ APPROVAL CONNECTS, IT DOES NOT FORK ═══
//
// `requestOptimizationApproval` calls Faz 24A's requestApproval unchanged, with
// subject_table='optimization_runs' (migration 0072 added that value). No second review table, no
// status column on optimization_runs, no parallel decide/reject logic. The approval entity stays
// the single place that knows whether something is approved.
//
// This module does NOT import @/lib/ai — the same one-directional rule Faz 28 established, and
// the gate asserts it with a negative control.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { requestApproval } from "@/lib/approvals/engine";
import {
  optimize, resultDigest,
  type FacilityHeadroom, type OptimizationInput, type OptimizationResult, type PaymentCandidate,
} from "./rules";

export const runOptimizationSchema = z.object({
  name: z.string().trim().min(1, "Çalışma adı zorunlu"),
  objective: z.enum(["min_financing_cost", "max_liquidity_buffer", "min_late_payment"]),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG olmalı"),
  horizonDays: z.number().int().min(1).max(365).default(90),
  currency: z.string().trim().length(3).default("TRY"),
  scenarioRunId: z.uuid().nullable().optional(),
});

/**
 * Which payments the solver may consider moving.
 *
 * `hardDeadline` is derived from the record's own priority, not from anything the solver decides:
 * a `critical` instance is treated as immovable. That mapping is deliberately conservative — the
 * cost of wrongly proposing to defer something unmovable is an operator losing trust in every
 * later suggestion, which is far worse than one missed optimisation.
 */
async function loadPaymentCandidates(
  pool: Pool, anchorDate: string, horizonDays: number,
): Promise<PaymentCandidate[]> {
  const res = await pool.query(
    `select i.id, coalesce(p.name, '(kalem)') as label,
            to_char(i.due_date,'YYYY-MM-DD') as due_date,
            i.amount, p.priority, i.risk_level
     from public.payment_instances i
     left join public.payments p on p.id = i.payment_id
     where i.status in ('unpaid','partial')
       and i.amount is not null
       and i.due_date >= $1::date and i.due_date < ($1::date + $2::int)
     order by i.due_date, i.id`,
    [anchorDate, horizonDays]);
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    dueDate: r.due_date,
    amount: moneyOrNull(r.amount) ?? 0,
    // Immovable when EITHER the payment is marked critical or the instance itself carries
    // critical risk. `priority` lives on payments and `risk_level` on the instance — checked by
    // introspection, because an earlier version read a `priority` column off payment_instances
    // that does not exist there. Treating either signal as hard is the conservative reading:
    // wrongly proposing to defer something immovable costs the operator's trust in every later
    // suggestion, which is far more expensive than one missed optimisation.
    hardDeadline: r.priority === "critical" || r.risk_level === "critical",
    latestDate: null,
  }));
}

async function loadFacilityHeadroom(pool: Pool, currency: string): Promise<FacilityHeadroom[]> {
  const res = await pool.query(
    `select facility_id, facility_name, available_amount, interest_rate
     from public.credit_facility_utilization
     where status = 'active' and currency = $1 and available_amount > 0
     order by facility_id`, [currency]);
  return res.rows.map((r) => ({
    id: r.facility_id,
    label: r.facility_name,
    available: moneyOrNull(r.available_amount) ?? 0,
    interestRate: rateOrNull(r.interest_rate),
  }));
}

/**
 * Run the optimiser and persist what it proposed.
 *
 * The whole run is one transaction: a half-written recommendation set would be read as complete
 * advice, and a partial answer is worse than none when the subject is which bills to pay.
 */
export async function runOptimization(
  pool: Pool, raw: unknown, actorId: string,
): Promise<{ runId: string; result: OptimizationResult; digest: string }> {
  const input = parseOrThrow(runOptimizationSchema, raw, "Optimizasyon çalışması");

  // Opening position and floor come from Faz 26's treasury views — read, never recomputed here,
  // so the optimiser and the treasury screen cannot disagree about how much cash there is.
  const posRes = await pool.query(
    `select available_now from public.treasury_position_summary where currency = $1`,
    [input.currency]);
  const openingCash = moneyOrNull(posRes.rows[0]?.available_now) ?? 0;

  const floorRes = await pool.query(
    `select threshold_amount from public.treasury_policies
     where policy_kind = 'min_cash' and is_active and cash_account_id is null and currency = $1`,
    [input.currency]);
  const minCashFloor = moneyOrNull(floorRes.rows[0]?.threshold_amount) ?? 0;

  const inflowRes = await pool.query(
    `select to_char(flow_date,'YYYY-MM-DD') as flow_date, sum(amount_signed) as amount
     from public.liquidity_forecast_daily
     where currency = $1 and certainty = 'contracted' and amount_signed > 0
       and flow_date >= $2::date and flow_date < ($2::date + $3::int)
     group by flow_date order by flow_date`,
    [input.currency, input.anchorDate, input.horizonDays]);

  const solverInput: OptimizationInput = {
    objective: input.objective,
    anchorDate: input.anchorDate,
    horizonDays: input.horizonDays,
    openingCash,
    minCashFloor,
    inflows: inflowRes.rows.map((r) => ({ date: r.flow_date, amount: moneyOrNull(r.amount) ?? 0 })),
    payments: await loadPaymentCandidates(pool, input.anchorDate, input.horizonDays),
    facilities: await loadFacilityHeadroom(pool, input.currency),
    drawnAmount: 0,
  };

  const result = optimize(solverInput);
  const digest = resultDigest(result);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const runRes = await client.query(
      `insert into public.optimization_runs
         (name, objective, anchor_date, horizon_days, currency, constraints, scenario_run_id,
          result_digest, created_by)
       values ($1,$2,$3::date,$4,$5,$6::jsonb,$7,$8,$9)
       returning id`,
      [input.name, input.objective, input.anchorDate, input.horizonDays, input.currency,
       JSON.stringify({ openingCash, minCashFloor, paymentCount: solverInput.payments.length,
                        facilityCount: solverInput.facilities.length }),
       input.scenarioRunId ?? null, digest, actorId]);
    const runId = runRes.rows[0].id;

    for (const rec of result.recommendations) {
      await client.query(
        `insert into public.optimization_recommendations
           (run_id, rank, action_kind, subject_table, subject_id, subject_label,
            current_date_value, proposed_date, amount, currency, expected_effect,
            rationale_codes, rationale_note, confidence)
         values ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14)`,
        [runId, rec.rank, rec.actionKind, rec.subjectTable, rec.subjectId, rec.subjectLabel,
         rec.currentDate, rec.proposedDate, rec.amount, input.currency, rec.expectedEffect,
         rec.rationaleCodes, rec.rationaleNote, rec.confidence]);
    }

    await audit(client, {
      actor: actorId, action: "run_optimization",
      entityTable: "optimization_runs", entityId: runId,
      after: {
        objective: input.objective, anchorDate: input.anchorDate,
        recommendationCount: result.recommendations.length,
        worstBalanceBefore: result.worstBalanceBefore,
        worstBalanceAfter: result.worstBalanceAfter,
        digest,
        // Recorded explicitly: this run changed no financial record, only produced proposals.
        mutatedFinancialRecords: false, automated: true, proposalsOnly: true,
      },
    });
    await client.query("commit");
    return { runId, result, digest };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Send an optimisation run for approval, through Faz 24A's entity.
 *
 * Calls requestApproval unchanged. The run gains no status of its own — its approval state is
 * whatever `approvals` says, which is why `optimization_run_summary` joins it rather than storing
 * a copy.
 */
export async function requestOptimizationApproval(
  pool: Pool, runId: string, actorId: string,
): Promise<{ approvalId: string }> {
  const res = await pool.query(
    `select o.id, o.name, o.objective,
            coalesce(sum(r.expected_effect), 0) as total_effect,
            count(r.id) as rec_count
     from public.optimization_runs o
     left join public.optimization_recommendations r on r.run_id = o.id
     where o.id = $1
     group by o.id, o.name, o.objective`, [runId]);
  if (res.rowCount === 0) throw new DomainError("Optimizasyon çalışması bulunamadı.");
  const run = res.rows[0];
  if (Number(run.rec_count) === 0) {
    // Approving an empty recommendation set would be approving nothing while looking like a
    // decision was made.
    throw new DomainError("Bu çalışma hiç öneri üretmedi — onaya gönderilecek bir şey yok.");
  }

  return requestApproval(pool, {
    subjectTable: "optimization_runs",
    subjectId: runId,
    subjectLabel: `${run.name} (${run.objective})`,
    requestKind: "other",
    amount: moneyOrNull(run.total_effect) ?? undefined,
  }, actorId);
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export async function loadOptimizationRuns(pool: Pool, limit = 50) {
  const res = await pool.query(
    `select run_id, name, objective, to_char(anchor_date,'YYYY-MM-DD') as anchor_date,
            horizon_days, currency, recommendation_count, total_expected_effect,
            timing_actions, financing_actions, approval_status, approval_round, result_digest
     from public.optimization_run_summary
     order by anchor_date desc, name
     limit $1`, [limit]);
  return res.rows.map((r) => ({
    runId: r.run_id,
    name: r.name,
    objective: r.objective,
    anchorDate: r.anchor_date,
    horizonDays: Number(r.horizon_days),
    currency: r.currency,
    recommendationCount: Number(r.recommendation_count),
    totalExpectedEffect: moneyOrNull(r.total_expected_effect) ?? 0,
    timingActions: Number(r.timing_actions),
    financingActions: Number(r.financing_actions),
    // From `approvals`, never from a column on this table.
    approvalStatus: r.approval_status as string | null,
    approvalRound: r.approval_round == null ? null : Number(r.approval_round),
    resultDigest: r.result_digest as string | null,
  }));
}

export async function loadRecommendations(pool: Pool, runId: string) {
  const res = await pool.query(
    `select recommendation_id, rank, action_kind, subject_table, subject_label,
            to_char(current_date_value,'YYYY-MM-DD') as current_date_value,
            to_char(proposed_date,'YYYY-MM-DD') as proposed_date,
            shift_days, amount, currency, expected_effect, rationale_codes, rationale_note,
            confidence
     from public.optimization_recommendation_detail
     where run_id = $1 order by rank`, [runId]);
  return res.rows.map((r) => ({
    id: r.recommendation_id,
    rank: Number(r.rank),
    actionKind: r.action_kind as string,
    subjectTable: r.subject_table as string | null,
    subjectLabel: r.subject_label as string | null,
    currentDate: r.current_date_value as string | null,
    proposedDate: r.proposed_date as string | null,
    shiftDays: r.shift_days == null ? null : Number(r.shift_days),
    amount: moneyOrNull(r.amount),
    currency: r.currency,
    expectedEffect: moneyOrNull(r.expected_effect),
    rationaleCodes: (r.rationale_codes ?? []) as string[],
    rationaleNote: r.rationale_note as string | null,
    confidence: rateOrNull(r.confidence),
  }));
}

export async function loadScenarioComparisonMatrix(pool: Pool, limit = 200) {
  const res = await pool.query(
    `select scenario_id, scenario_name, scenario_type, run_id, run_at, confidence,
            metric, baseline_value, scenario_value, delta, delta_ratio, magnitude_rank
     from public.scenario_comparison_matrix
     order by metric, magnitude_rank
     limit $1`, [limit]);
  return res.rows.map((r) => ({
    scenarioId: r.scenario_id,
    scenarioName: r.scenario_name,
    scenarioType: r.scenario_type,
    runId: r.run_id,
    metric: r.metric as string,
    baselineValue: moneyOrNull(r.baseline_value),
    scenarioValue: moneyOrNull(r.scenario_value),
    delta: moneyOrNull(r.delta),
    deltaRatio: rateOrNull(r.delta_ratio),
    magnitudeRank: Number(r.magnitude_rank),
    confidence: r.confidence as string | null,
  }));
}
