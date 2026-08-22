// Faz 26 — treasury engine: liquidity read models and the policy threshold an operator owns.
//
// Almost everything here reads. The only mutation is the cash-buffer policy, which is
// configuration rather than a financial record: changing a floor changes which warnings appear,
// never a balance, an amount or a due date. It is still audited, because "who lowered the floor
// the week before we ran out of cash" is exactly the question an audit trail exists to answer.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, intOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import {
  bufferDaysFloor, effectiveFloor, liquidityHorizons, reconciliationVerdict,
  type DatedFlow, type LiquidityHorizon, type ReconciliationStatus,
} from "./rules";

/* ── policy configuration ─────────────────────────────────────────────────────────────── */

export const updatePolicySchema = z.object({
  code: z.string().trim().min(1),
  thresholdAmount: z.number().min(0).nullable().optional(),
  thresholdDays: z.number().int().positive().nullable().optional(),
  isActive: z.boolean(),
  notes: z.string().trim().max(500).optional(),
});

export interface TreasuryPolicy {
  id: string;
  code: string;
  description: string;
  policyKind: "min_cash" | "buffer_days";
  currency: string;
  thresholdAmount: number | null;
  thresholdDays: number | null;
  isActive: boolean;
}

export async function loadPolicies(pool: Pool): Promise<TreasuryPolicy[]> {
  const r = await pool.query(
    `select id, code, description, policy_kind, currency, threshold_amount, threshold_days, is_active
     from public.treasury_policies order by policy_kind, currency, code`);
  return r.rows.map((x) => ({
    id: x.id, code: x.code, description: x.description, policyKind: x.policy_kind,
    currency: x.currency, thresholdAmount: moneyOrNull(x.threshold_amount),
    thresholdDays: intOrNull(x.threshold_days), isActive: Boolean(x.is_active),
  }));
}

/**
 * Change a threshold or switch a policy on/off.
 *
 * The kind is NOT editable and neither is the currency: those decide which column the scope
 * CHECK requires, and letting a form flip them would turn a constraint violation into the
 * operator's problem. A different kind is a different policy row.
 */
export async function updatePolicy(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(updatePolicySchema, raw, "Hazine politikası");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, code, policy_kind, threshold_amount, threshold_days, is_active
       from public.treasury_policies where code=$1 for update`, [input.code]);
    if (before.rowCount === 0) throw new DomainError("Hazine politikası bulunamadı.");
    const row = before.rows[0];

    // Enforce the same scope rule the CHECK does, but as a sentence rather than a 500.
    if (row.policy_kind === "min_cash" && input.thresholdAmount == null) {
      throw new DomainError("Asgari kasa politikası için tutar zorunlu.");
    }
    if (row.policy_kind === "buffer_days" && input.thresholdDays == null) {
      throw new DomainError("Nakit tamponu politikası için gün sayısı zorunlu.");
    }

    await client.query(
      `update public.treasury_policies
         set threshold_amount = case when policy_kind='min_cash' then $2 else null end,
             threshold_days   = case when policy_kind='buffer_days' then $3 else null end,
             is_active = $4,
             notes = coalesce($5, notes)
       where code = $1`,
      [input.code, input.thresholdAmount ?? null, input.thresholdDays ?? null,
       input.isActive, input.notes ?? null]);

    await audit(client, {
      actor: actorId, action: "update_treasury_policy",
      entityTable: "treasury_policies", entityId: row.id,
      before: {
        thresholdAmount: moneyOrNull(row.threshold_amount),
        thresholdDays: intOrNull(row.threshold_days),
        isActive: row.is_active,
      },
      after: {
        thresholdAmount: input.thresholdAmount ?? null,
        thresholdDays: input.thresholdDays ?? null,
        isActive: input.isActive,
        // Recorded explicitly: a policy change alters which alerts fire, never a balance.
        changesFinancialRecord: false, automated: false,
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

export async function loadCashPositions(pool: Pool) {
  const r = await pool.query(
    `select cash_account_id, account_name, currency, bank_name, iban,
            stated_balance, blocked_balance, overdraft_limit, balance_as_of,
            derived_balance, movement_count, last_movement_date, stated_minus_derived
     from public.bank_cash_position
     where is_active
     order by currency, account_name`);
  return r.rows.map((x) => ({
    cashAccountId: x.cash_account_id,
    accountName: x.account_name,
    currency: x.currency,
    bankName: x.bank_name,
    iban: x.iban,
    statedBalance: moneyOrNull(x.stated_balance),
    blockedBalance: moneyOrNull(x.blocked_balance),
    overdraftLimit: moneyOrNull(x.overdraft_limit),
    derivedBalance: moneyOrNull(x.derived_balance),
    movementCount: Number(x.movement_count),
    lastMovementDate: x.last_movement_date ? String(x.last_movement_date).slice(0, 10) : null,
    // Kept as its own field rather than folded into one "balance": the gap is information.
    statedMinusDerived: moneyOrNull(x.stated_minus_derived),
  }));
}

export async function loadPositionSummary(pool: Pool) {
  const r = await pool.query(
    `select currency, account_count, total_derived_balance, total_stated_balance,
            total_blocked, total_overdraft_limit, available_now, available_with_overdraft,
            accounts_with_gap
     from public.treasury_position_summary order by currency`);
  return r.rows.map((x) => ({
    currency: x.currency,
    accountCount: Number(x.account_count),
    totalDerived: moneyOrNull(x.total_derived_balance),
    totalStated: moneyOrNull(x.total_stated_balance),
    totalBlocked: moneyOrNull(x.total_blocked),
    totalOverdraftLimit: moneyOrNull(x.total_overdraft_limit),
    availableNow: moneyOrNull(x.available_now),
    availableWithOverdraft: moneyOrNull(x.available_with_overdraft),
    accountsWithGap: Number(x.accounts_with_gap),
  }));
}

export async function loadLiquidityGap(pool: Pool) {
  const r = await pool.query(
    `select horizon_days, currency, available_now, contracted_net_flow, expected_net_flow,
            projected_contracted, projected_expected, min_cash_floor, financing_need, breaches_floor
     from public.treasury_liquidity_gap
     order by currency, horizon_days`);
  return r.rows.map((x) => ({
    horizonDays: Number(x.horizon_days),
    currency: x.currency,
    availableNow: moneyOrNull(x.available_now),
    contractedNetFlow: moneyOrNull(x.contracted_net_flow),
    expectedNetFlow: moneyOrNull(x.expected_net_flow),
    projectedContracted: moneyOrNull(x.projected_contracted),
    projectedExpected: moneyOrNull(x.projected_expected),
    minCashFloor: moneyOrNull(x.min_cash_floor),
    financingNeed: moneyOrNull(x.financing_need),
    breachesFloor: Boolean(x.breaches_floor),
  }));
}

export interface ReconciliationRow {
  monthStart: string;
  currency: string;
  cashflowClosing: number | null;
  treasuryClosing: number | null;
  difference: number | null;
  status: ReconciliationStatus;
}

/**
 * The consistency read model.
 *
 * The SQL already computes a verdict; this recomputes it from the two raw figures with
 * `reconciliationVerdict` and RETURNS THE APPLICATION'S ANSWER. If the two ever disagreed, the
 * gate would catch it — that is the point of computing it twice from one source of numbers.
 */
export async function loadReconciliation(pool: Pool): Promise<ReconciliationRow[]> {
  const r = await pool.query(
    `select to_char(month_start,'YYYY-MM-DD') as month_start, currency,
            cashflow_closing, treasury_closing
     from public.treasury_cashflow_reconciliation
     order by month_start`);
  return r.rows.map((x) => {
    const cashflow = moneyOrNull(x.cashflow_closing);
    const treasury = moneyOrNull(x.treasury_closing);
    const verdict = reconciliationVerdict(cashflow, treasury);
    return {
      monthStart: x.month_start,
      currency: x.currency,
      cashflowClosing: cashflow,
      treasuryClosing: treasury,
      difference: verdict.difference,
      status: verdict.status,
    };
  });
}

/**
 * Daily horizons computed in the application from the dated flows.
 *
 * Deliberately duplicated against `treasury_liquidity_gap`: the SQL answers the same question
 * for the dashboard's summary row, and this answers it from the raw flow rows. Two independent
 * computations over one set of facts is how the gate proves neither has drifted.
 */
export async function loadLiquidityHorizons(
  pool: Pool, todayISO: string, currency = "TRY",
): Promise<LiquidityHorizon[]> {
  const posRes = await pool.query(
    `select available_now from public.treasury_position_summary where currency=$1`, [currency]);
  const opening = moneyOrNull(posRes.rows[0]?.available_now) ?? 0;

  const flowRes = await pool.query(
    `select to_char(flow_date,'YYYY-MM-DD') as flow_date, amount_signed, certainty
     from public.liquidity_forecast_daily
     where currency=$1 and flow_date >= $2::date and flow_date < ($2::date + 90)`,
    [currency, todayISO]);
  const flows: DatedFlow[] = flowRes.rows.map((x) => ({
    flowDate: x.flow_date,
    amountSigned: moneyOrNull(x.amount_signed) ?? 0,
    certainty: x.certainty === "expected" ? "expected" : "contracted",
  }));

  const floor = await resolveFloor(pool, currency, todayISO);
  return liquidityHorizons({ openingPosition: opening, flows, todayISO, minCashFloor: floor ?? 0 });
}

/**
 * The floor actually in force: the configured min-cash amount, the buffer-days equivalent, or
 * the higher of the two when both are active.
 */
export async function resolveFloor(
  pool: Pool, currency: string, todayISO: string,
): Promise<number | null> {
  const policies = await pool.query(
    `select policy_kind, threshold_amount, threshold_days
     from public.treasury_policies
     where is_active and currency=$1 and cash_account_id is null`, [currency]);

  const minCash = moneyOrNull(
    policies.rows.find((p) => p.policy_kind === "min_cash")?.threshold_amount);
  const days = intOrNull(
    policies.rows.find((p) => p.policy_kind === "buffer_days")?.threshold_days);

  let bufferFloor: number | null = null;
  if (days != null) {
    // Average daily outflow over the trailing 90 days of real bank movement. Trailing actuals,
    // not the forecast — a buffer is sized on what this business actually spends.
    const avg = await pool.query(
      `select coalesce(avg(daily_out), 0) as avg_out from (
         select bt.txn_date, abs(sum(bt.amount) filter (where bt.amount < 0)) as daily_out
         from public.bank_transactions bt
         join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
         join public.cash_accounts ca on ca.id = ba.cash_account_id
         where bt.status <> 'ignored' and ca.currency = $1
           and bt.txn_date >= ($2::date - 90) and bt.txn_date < $2::date
         group by bt.txn_date
       ) d where daily_out is not null`, [currency, todayISO]);
    bufferFloor = bufferDaysFloor(avg.rows[0]?.avg_out, days);
  }
  return effectiveFloor(minCash, bufferFloor);
}
