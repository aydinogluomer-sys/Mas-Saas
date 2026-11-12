// Faz 29 + Faz 46 — optimisation engine: runs the deterministic solver and records its PROPOSALS.
//
// ═══ THE BASELINE IS READ, NEVER WRITTEN ═══
//
// This is the Faz 8/13 invariant, restated for a new run type. Everything this module reads —
// payment_instances, checks, loan_installments, invoices, credit_facilities, treasury_policies,
// cashflow_months — it reads. The only tables it writes are optimization_runs,
// optimization_recommendations, audit_logs, and (via the Faz 24A engine) approvals.
//
// ═══ APPROVAL CONNECTS, IT DOES NOT FORK ═══
//
// `requestOptimizationApproval` calls Faz 24A's requestApproval unchanged, with
// subject_table='optimization_runs' (migration 0072 added that value). No second review table, no
// status column on optimization_runs, no parallel decide/reject logic.
//
// This module does NOT import @/lib/ai — the same one-directional rule Faz 28 established.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { requestApproval } from "@/lib/approvals/engine";
import { resolveFloor } from "@/lib/treasury/engine";
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
 * Faz 46: Load all dated outflow obligations in `currency` across:
 *   1. `payment_instances` (`unpaid`/`partial`, `outflow`, `currency = $3`)
 *   2. `checks` (`planned`/`unknown`, `outflow`, `currency = $3`, immovable legal maturity)
 *   3. `loan_installments` (`planned`/`unpaid`/`partial`/`late`, `l.currency = $3`, immovable contractual maturity)
 *   4. Unlinked open `purchase` `invoices` (`open`/`partial`, `gross_amount > allocated_amount`, `currency = $3`)
 */
async function loadPaymentCandidates(
  pool: Pool, anchorDate: string, horizonDays: number, currency: string,
): Promise<PaymentCandidate[]> {
  let res;
  try {
    res = await pool.query(
      `select id, label, due_date, amount, hard_deadline, subject_table
       from (
         select i.id,
                coalesce(p.name, '(kalem)') as label,
                to_char(i.due_date,'YYYY-MM-DD') as due_date,
                (i.amount - coalesce(i.paid_amount, 0)) as amount,
                (p.priority = 'critical' or i.risk_level = 'critical') as hard_deadline,
                'payment_instances'::text as subject_table
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
         where i.status in ('unpaid','partial')
           and coalesce(i.direction, p.direction, 'outflow') = 'outflow'
           and i.currency = $3
           and i.amount is not null
           and (i.amount - coalesce(i.paid_amount, 0)) > 0
           and i.due_date >= $1::date and i.due_date < ($1::date + $2::int)

         union all

         select c.id,
                coalesce(pe.name, c.counterparty_label, 'Çek ' || coalesce(c.serial_no, '')) as label,
                to_char(c.maturity_date,'YYYY-MM-DD') as due_date,
                c.amount,
                true as hard_deadline,
                'checks'::text as subject_table
         from public.checks c
         left join public.parties pe on pe.id = c.payee_party_id
         where c.status in ('planned','unknown')
           and c.archived_at is null
           and c.direction = 'outflow'
           and c.currency = $3
           and c.amount is not null
           and c.amount > 0
           and c.maturity_date >= $1::date and c.maturity_date < ($1::date + $2::int)

         union all

         select li.id,
                coalesce(l.name, 'Kredi taksiti') || ' #' || coalesce(li.installment_no::text, '?') as label,
                to_char(li.due_date,'YYYY-MM-DD') as due_date,
                li.amount,
                true as hard_deadline,
                'loan_installments'::text as subject_table
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         where li.status in ('planned','unpaid','partial','late')
           and l.archived_at is null
           and l.currency = $3
           and li.amount is not null
           and li.amount > 0
           and li.due_date >= $1::date and li.due_date < ($1::date + $2::int)

         union all

         select inv.id,
                coalesce(pa.name, 'Alım faturası') || coalesce(' #' || inv.invoice_no, '') as label,
                to_char(coalesce(inv.due_date, inv.issue_date),'YYYY-MM-DD') as due_date,
                (inv.gross_amount - coalesce(inv.allocated_amount, 0)) as amount,
                false as hard_deadline,
                'invoices'::text as subject_table
         from public.invoices inv
         left join public.parties pa on pa.id = inv.party_id
         where inv.direction = 'purchase'
           and inv.status in ('open','partial')
           and inv.currency = $3
           and inv.gross_amount is not null
           and inv.gross_amount > coalesce(inv.allocated_amount, 0)
           and not (
             inv.settled_by_check_id is not null
             and exists (
               select 1 from public.checks c0
               where c0.id = inv.settled_by_check_id
                 and c0.archived_at is null
                 and c0.status <> 'cancelled'
             )
           )
           and not exists (
             select 1
             from public.payment_instances pi2
             left join public.payments p2 on p2.id = pi2.payment_id
             where pi2.linked_invoice_id = inv.id
               and pi2.status <> 'cancelled'
               and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
           )
           and not exists (
             select 1
             from public.checks c2
             where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = inv.id
               and c2.archived_at is null
               and c2.status <> 'cancelled'
           )
           and coalesce(inv.due_date, inv.issue_date) >= $1::date
           and coalesce(inv.due_date, inv.issue_date) < ($1::date + $2::int)
       ) candidates
       order by due_date, id`,
      [anchorDate, horizonDays, currency],
    );
  } catch (err) {
    if ((err as { code?: string })?.code !== "42703") throw err;
    res = await pool.query(
      `select i.id,
              coalesce(p.name, '(kalem)') as label,
              to_char(i.due_date,'YYYY-MM-DD') as due_date,
              (i.amount - coalesce(i.paid_amount, 0)) as amount,
              (p.priority = 'critical' or i.risk_level = 'critical') as hard_deadline,
              'payment_instances'::text as subject_table
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
       where i.status in ('unpaid','partial')
         and i.currency = $3
         and i.amount is not null
         and (i.amount - coalesce(i.paid_amount, 0)) > 0
         and i.due_date >= $1::date and i.due_date < ($1::date + $2::int)
       order by i.due_date, i.id`,
      [anchorDate, horizonDays, currency],
    );
  }
  return res.rows.map((r) => ({
    id: r.id,
    label: r.label,
    dueDate: r.due_date,
    amount: moneyOrNull(r.amount) ?? 0,
    hardDeadline: Boolean(r.hard_deadline),
    latestDate: null,
    subjectTable: r.subject_table as PaymentCandidate["subjectTable"],
  }));
}

async function loadFacilityState(
  pool: Pool,
  currency: string,
): Promise<{ facilities: FacilityHeadroom[]; drawnAmount: number }> {
  const [headroomRes, drawnRes] = await Promise.all([
    pool.query(
      `select facility_id, facility_name, available_amount, interest_rate
       from public.credit_facility_utilization
       where status = 'active' and currency = $1 and available_amount > 0
       order by facility_id`,
      [currency],
    ),
    pool.query(
      `select coalesce(sum(drawn_amount), 0) as total_drawn
       from public.credit_facility_utilization
       where status = 'active' and currency = $1`,
      [currency],
    ),
  ]);
  return {
    facilities: headroomRes.rows.map((r) => ({
      id: r.facility_id,
      label: r.facility_name,
      available: moneyOrNull(r.available_amount) ?? 0,
      interestRate: rateOrNull(r.interest_rate),
    })),
    drawnAmount: Math.max(0, moneyOrNull(drawnRes.rows[0]?.total_drawn) ?? 0),
  };
}

/**
 * Run the optimiser and persist what it proposed.
 *
 * FIN-03 (Faz 46): When active cash accounts exist for `currency` with unknown opening balance
 * (`unknown_opening_count > 0` or `available_now IS NULL`), `openingCash` stays `null` and
 * `optimize()` halts cleanly with `haltedReason` instead of fabricating a `0`-cash simulation.
 */
export async function runOptimization(
  pool: Pool, raw: unknown, actorId: string,
): Promise<{ runId: string; result: OptimizationResult; digest: string; warning?: string | null }> {
  const input = parseOrThrow(runOptimizationSchema, raw, "Optimizasyon çalışması");

  let posRes;
  try {
    posRes = await pool.query(
      `select available_now, unknown_opening_count
       from public.treasury_position_summary where currency = $1`,
      [input.currency],
    );
  } catch (err) {
    if ((err as { code?: string })?.code !== "42703") throw err;
    posRes = await pool.query(
      `select available_now, 0::int as unknown_opening_count
       from public.treasury_position_summary where currency = $1`,
      [input.currency],
    );
  }
  const posRow = posRes.rows[0];
  const openingCash: number | null = posRes.rowCount === 0
    ? 0
    : Number(posRow?.unknown_opening_count ?? 0) > 0 || posRow?.available_now == null
      ? null
      : moneyOrNull(posRow.available_now);

  const minCashFloor = (await resolveFloor(pool, input.currency, input.anchorDate)) ?? 0;

  const inflowRes = await pool.query(
    `select to_char(flow_date,'YYYY-MM-DD') as flow_date, sum(amount_signed) as amount
     from public.liquidity_forecast_daily
     where currency = $1 and certainty = 'contracted' and amount_signed > 0
       and flow_date >= $2::date and flow_date < ($2::date + $3::int)
     group by flow_date order by flow_date`,
    [input.currency, input.anchorDate, input.horizonDays],
  );

  const [payments, facilityState] = await Promise.all([
    loadPaymentCandidates(pool, input.anchorDate, input.horizonDays, input.currency),
    loadFacilityState(pool, input.currency),
  ]);

  const solverInput: OptimizationInput = {
    objective: input.objective,
    anchorDate: input.anchorDate,
    horizonDays: input.horizonDays,
    openingCash,
    minCashFloor,
    inflows: inflowRes.rows.map((r) => ({ date: r.flow_date, amount: moneyOrNull(r.amount) ?? 0 })),
    payments,
    facilities: facilityState.facilities,
    drawnAmount: facilityState.drawnAmount,
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
      [
        input.name,
        input.objective,
        input.anchorDate,
        input.horizonDays,
        input.currency,
        JSON.stringify({
          openingCash,
          minCashFloor,
          drawnAmount: facilityState.drawnAmount,
          paymentCount: solverInput.payments.length,
          facilityCount: solverInput.facilities.length,
          haltedReason: result.haltedReason ?? null,
        }),
        input.scenarioRunId ?? null,
        digest,
        actorId,
      ],
    );
    const runId = runRes.rows[0].id;

    for (const rec of result.recommendations) {
      await client.query(
        `insert into public.optimization_recommendations
           (run_id, rank, action_kind, subject_table, subject_id, subject_label,
            current_date_value, proposed_date, amount, currency, expected_effect,
            rationale_codes, rationale_note, confidence)
         values ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14)`,
        [
          runId, rec.rank, rec.actionKind, rec.subjectTable, rec.subjectId, rec.subjectLabel,
          rec.currentDate, rec.proposedDate, rec.amount, input.currency, rec.expectedEffect,
          rec.rationaleCodes, rec.rationaleNote, rec.confidence,
        ],
      );
    }

    await audit(client, {
      actor: actorId, action: "run_optimization",
      entityTable: "optimization_runs", entityId: runId,
      after: {
        objective: input.objective, anchorDate: input.anchorDate,
        recommendationCount: result.recommendations.length,
        worstBalanceBefore: result.worstBalanceBefore,
        worstBalanceAfter: result.worstBalanceAfter,
        haltedReason: result.haltedReason ?? null,
        digest,
        mutatedFinancialRecords: false, automated: true, proposalsOnly: true,
      },
    });
    await client.query("commit");
    return { runId, result, digest, warning: result.haltedReason ?? null };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Send an optimisation run for approval, through Faz 24A's entity.
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
