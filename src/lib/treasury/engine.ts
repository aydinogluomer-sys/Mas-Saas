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
import { decimal, moneyOrNull, intOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import {
  bufferDaysFloor, effectiveFloor, liquidityHorizons, reconciliationVerdict,
  type DatedFlow, type LiquidityHorizonStatus, type NullableLiquidityHorizon, type ReconciliationStatus,
} from "./rules";

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

export async function loadUnknownOpeningAccountCount(
  pool: Pool,
): Promise<{ totalUnknown: number; byCurrency: Array<{ currency: string; count: number }> }> {
  try {
    const r = await pool.query<{ currency: string; n: number | string }>(
      `select currency, count(*)::int as n
       from public.cash_accounts
       where is_active and opening_balance is null
       group by currency
       order by currency`,
    );
    const byCurrency = r.rows.map((row) => ({
      currency: String(row.currency),
      count: Number(row.n ?? 0),
    }));
    const totalUnknown = byCurrency.reduce((sum, item) => sum + item.count, 0);
    return { totalUnknown, byCurrency };
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) {
      return { totalUnknown: 0, byCurrency: [] };
    }
    throw err;
  }
}

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
            derived_balance, movement_count, last_movement_date, stated_minus_derived,
            opening_known, movement_net
     from public.bank_cash_position
     where is_active
     order by currency, account_name`).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select cash_account_id, account_name, currency, bank_name, iban,
                stated_balance, blocked_balance, overdraft_limit, balance_as_of,
                derived_balance, movement_count, last_movement_date, stated_minus_derived,
                (derived_balance is not null) as opening_known, 0::numeric as movement_net
         from public.bank_cash_position
         where is_active
         order by currency, account_name`).catch((e2: unknown) => {
        if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
        throw e2;
      });
    }
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
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
    openingKnown: x.opening_known == null ? x.derived_balance != null : Boolean(x.opening_known),
    movementNet: moneyOrNull(x.movement_net) ?? 0,
  }));
}

export async function loadPositionSummary(pool: Pool) {
  const r = await pool.query(
    `select currency, account_count, total_derived_balance, total_stated_balance,
            total_blocked, total_overdraft_limit, available_now, available_with_overdraft,
            accounts_with_gap, unknown_opening_count, movements_only_total
     from public.treasury_position_summary order by currency`).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select currency, account_count, total_derived_balance, total_stated_balance,
                total_blocked, total_overdraft_limit, available_now, available_with_overdraft,
                accounts_with_gap, 0::int as unknown_opening_count, 0::numeric as movements_only_total
         from public.treasury_position_summary order by currency`).catch((e2: unknown) => {
        if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
        throw e2;
      });
    }
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  return r.rows.map((x) => {
    const unknownOpeningCount = Number(x.unknown_opening_count ?? 0);
    const movementDelta = moneyOrNull(x.movements_only_total) ?? 0;
    return {
      currency: x.currency,
      accountCount: Number(x.account_count),
      totalDerived: unknownOpeningCount > 0 ? null : moneyOrNull(x.total_derived_balance),
      totalStated: moneyOrNull(x.total_stated_balance),
      totalBlocked: moneyOrNull(x.total_blocked),
      totalOverdraftLimit: moneyOrNull(x.total_overdraft_limit),
      availableNow: unknownOpeningCount > 0 ? null : moneyOrNull(x.available_now),
      availableWithOverdraft: unknownOpeningCount > 0 ? null : moneyOrNull(x.available_with_overdraft),
      accountsWithGap: Number(x.accounts_with_gap),
      unknownOpeningCount,
      movementDelta,
      movementsOnlyTotal: movementDelta,
    };
  });
}

/**
 * Currencies that HAVE a floor: an active, account-wide min-cash policy. This is the `floors` CTE
 * of treasury_liquidity_gap (0063), same predicate, read on its own.
 *
 * Why a reader needs it: the view reports `coalesce(threshold_amount, 0)` as min_cash_floor, so
 * "no floor is configured for this currency" and "the floor is deliberately 0" (0062: zero is a
 * valid floor and the seeded default) arrive as the same number. For the shortfall column that is
 * harmless — below zero is below zero either way. A VERDICT against the floor ("Taban korunuyor")
 * is different: it must know whether there was a floor to judge against at all.
 */
export async function loadConfiguredFloorCurrencies(pool: Pool): Promise<ReadonlySet<string>> {
  const r = await pool.query(
    `select distinct currency from public.treasury_policies
     where policy_kind = 'min_cash' and is_active and cash_account_id is null`);
  return new Set(r.rows.map((x) => String(x.currency)));
}

export async function loadLiquidityGap(pool: Pool) {
  const r = await pool.query(
    `select horizon_days, currency, available_now, contracted_net_flow, expected_net_flow,
            projected_contracted, projected_expected, min_cash_floor, financing_need, breaches_floor,
            status, unknown_opening_count, movements_only_total, unknown_currency_count
     from public.treasury_liquidity_gap
     order by currency, horizon_days`).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select horizon_days, currency, available_now, contracted_net_flow, expected_net_flow,
                projected_contracted, projected_expected, min_cash_floor, financing_need, breaches_floor,
                null::text as status, 0::int as unknown_opening_count,
                0::numeric as movements_only_total, 0::int as unknown_currency_count
         from public.treasury_liquidity_gap
         order by currency, horizon_days`).catch((e2: unknown) => {
        if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
        throw e2;
      });
    }
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  return r.rows.map((x) => {
    const unknownOpeningCount = Number(x.unknown_opening_count ?? 0);
    const availableNow = unknownOpeningCount > 0 ? null : moneyOrNull(x.available_now);
    const breachesFloor = availableNow == null || x.breaches_floor == null
      ? null
      : Boolean(x.breaches_floor);
    const status: LiquidityHorizonStatus =
      (x.status as LiquidityHorizonStatus | undefined)
      ?? (availableNow == null ? "unknown_opening_balance" : breachesFloor ? "floor_breached" : "ok");
    return {
      horizonDays: Number(x.horizon_days),
      currency: x.currency,
      availableNow,
      contractedNetFlow: moneyOrNull(x.contracted_net_flow),
      expectedNetFlow: moneyOrNull(x.expected_net_flow),
      projectedContracted: availableNow == null ? null : moneyOrNull(x.projected_contracted),
      projectedExpected: availableNow == null ? null : moneyOrNull(x.projected_expected),
      minCashFloor: moneyOrNull(x.min_cash_floor),
      financingNeed: availableNow == null ? null : moneyOrNull(x.financing_need),
      breachesFloor,
      status,
      unknownOpeningCount,
      movementDelta: moneyOrNull(x.movements_only_total) ?? 0,
      unknownCurrencyCount: Number(x.unknown_currency_count ?? 0),
    };
  });
}

export interface ReconciliationRow {
  monthStart: string;
  currency: string;
  cashflowClosing: number | null;
  treasuryClosing: number | null;
  difference: number | null;
  status: ReconciliationStatus;
  unknownOpeningCount: number;
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
            cashflow_closing, treasury_closing, unknown_opening_count
     from public.treasury_cashflow_reconciliation
     order by month_start`).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select to_char(month_start,'YYYY-MM-DD') as month_start, currency,
                cashflow_closing, treasury_closing, 0::int as unknown_opening_count
         from public.treasury_cashflow_reconciliation
         order by month_start`).catch((e2: unknown) => {
        if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
        throw e2;
      });
    }
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  return r.rows.map((x) => {
    const cashflow = moneyOrNull(x.cashflow_closing);
    const treasury = moneyOrNull(x.treasury_closing);
    const unknownOpeningCount = Number(x.unknown_opening_count ?? 0);
    const verdict = reconciliationVerdict(cashflow, treasury, unknownOpeningCount === 0);
    return {
      monthStart: x.month_start,
      currency: x.currency,
      cashflowClosing: cashflow,
      treasuryClosing: treasury,
      difference: verdict.difference,
      status: verdict.status,
      unknownOpeningCount,
    };
  });
}

/**
 * Daily horizons computed in the application from the dated flows.
 *
 * Deliberately duplicated against `treasury_liquidity_gap`: the SQL answers the same question
 * for the dashboard's summary row, and this answers it from the raw flow rows. Two independent
 * computations over one set of facts is how the gate proves neither has drifted.
 *
 * FIN-03 (Faz 44): Never coerce a NULL `available_now` (`unknown_opening_count > 0`) to `0`.
 * When no active account exists for `currency` (`posRes.rowCount === 0`), opening is `0`; when
 * active accounts exist with unknown opening balance, `opening` stays `null` so projected
 * positions and financing need stay `null`.
 */
export async function loadLiquidityHorizons(
  pool: Pool, todayISO: string, currency = "TRY",
): Promise<NullableLiquidityHorizon[]> {
  const posRes = await pool.query(
    `select available_now, unknown_opening_count
     from public.treasury_position_summary where currency=$1`, [currency]).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select available_now, 0::int as unknown_opening_count
         from public.treasury_position_summary where currency=$1`, [currency]).catch((e2: unknown) => {
        if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
        throw e2;
      });
    }
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  const posRow = posRes.rows[0];
  const opening: number | null = posRes.rowCount === 0
    ? 0
    : Number(posRow?.unknown_opening_count ?? 0) > 0
      ? null
      : moneyOrNull(posRow?.available_now);

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
    // Average daily outflow over the trailing 90 CALENDAR days of real bank movement (Faz 46).
    // Dividing by active outflow days alone overstated the burn rate whenever payments were lumpy
    // (e.g. payroll + rent on 3 days of the quarter); dividing total 90-day outflow by fixed 90
    // calendar days yields the true daily calendar burn rate.
    const outRes = await pool.query(
      `select coalesce(abs(sum(bt.amount) filter (where bt.amount < 0)), 0) as total_out_90d
       from public.bank_transactions bt
       join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
       join public.cash_accounts ca on ca.id = ba.cash_account_id
       where bt.status <> 'ignored' and ca.currency = $1
         and bt.txn_date >= ($2::date - 90) and bt.txn_date < $2::date`,
      [currency, todayISO],
    );
    const totalOut90d = decimal(outRes.rows[0]?.total_out_90d ?? 0).abs();
    const avgDailyOut = totalOut90d.eq(0) ? 0 : totalOut90d.div(90).toString();
    bufferFloor = bufferDaysFloor(avgDailyOut, days);
  }
  return effectiveFloor(minCash, bufferFloor);
}
