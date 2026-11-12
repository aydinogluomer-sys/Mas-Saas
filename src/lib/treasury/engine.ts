// Faz 26 — treasury engine: liquidity read models and the policy threshold an operator owns.
//
// Almost everything here reads. The only mutation is the cash-buffer policy, which is
// configuration rather than a financial record: changing a floor changes which warnings appear,
// never a balance, an amount or a due date. It is still audited, because "who lowered the floor
// the week before we ran out of cash" is exactly the question an audit trail exists to answer.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { translatePeriodLockError } from "@/lib/cashflow/period-lock";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import {
  postJournalEntryWithClient,
  reverseManagementEntryWithClient,
} from "@/lib/ledger/posting-engine";
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

/* ── F-45: FIN-03 Kasa/Banka + IBAN + 500.99 Yönetim Defteri Açılış CRUD ─────────────── */

export const ACCOUNT_KIND_INPUTS = [
  "cash",
  "bank",
  "pos",
  "credit_line",
  "bank_account",
  "credit_card",
  "loan",
  "check_account",
  "other",
] as const;

export type AccountKindInput = (typeof ACCOUNT_KIND_INPUTS)[number];

export type CashAccountDbType =
  | "cash"
  | "bank_account"
  | "credit_card"
  | "loan"
  | "check_account"
  | "other"
  | "unknown";

export function mapKindToCashAccountType(kind: AccountKindInput): CashAccountDbType {
  switch (kind) {
    case "cash":
      return "cash";
    case "bank":
    case "bank_account":
      return "bank_account";
    case "pos":
    case "other":
      return "other";
    case "credit_line":
    case "credit_card":
      return "credit_card";
    case "loan":
      return "loan";
    case "check_account":
      return "check_account";
  }
}

function cleanOptionalText(val: string | null | undefined): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed === "" ? null : trimmed;
}

export const upsertCashOrBankAccountSchema = z.object({
  cashAccountId: z.uuid().optional(),
  name: z.string().trim().min(1, "Hesap adı zorunludur").max(160).optional(),
  kind: z.enum(ACCOUNT_KIND_INPUTS).optional(),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Geçerli 3 harfli döviz kodu girin (ör. TRY, USD, EUR)")
    .optional(),
  openingBalance: z.number().finite("Açılış bakiyesi geçerli bir sayı olmalıdır").nullable().optional(),
  openingBalanceDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Açılış tarihi YYYY-AA-GG biçiminde olmalıdır")
    .optional(),
  isActive: z.boolean().optional(),
  iban: z.string().trim().max(42).nullable().optional(),
  bankName: z.string().trim().max(160).nullable().optional(),
  branchCode: z.string().trim().max(40).nullable().optional(),
  branchName: z.string().trim().max(160).nullable().optional(),
  accountNumber: z.string().trim().max(64).nullable().optional(),
  swiftBic: z.string().trim().max(20).nullable().optional(),
  overdraftLimit: z.number().min(0, "KMH limiti negatif olamaz").nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type UpsertCashOrBankAccountInput = z.infer<typeof upsertCashOrBankAccountSchema>;

export interface UpsertCashOrBankAccountResult {
  cashAccountId: string;
  accountType: CashAccountDbType;
  currency: string;
  openingBalance: number | null;
  openingBalanceDate: string;
  openingJournalEntryId: string | null;
  ibanNormalized: string | null;
}

export async function upsertCashOrBankAccountWithClient(
  client: PoolClient,
  raw: unknown,
  actorId: string,
): Promise<UpsertCashOrBankAccountResult> {
  const input = parseOrThrow(upsertCashOrBankAccountSchema, raw, "Kasa / banka hesabı");

  let validatedIban: string | null | undefined = undefined;
  if (input.iban !== undefined) {
    const cleaned = cleanOptionalText(input.iban);
    if (cleaned === null) {
      validatedIban = null;
    } else {
      const normalized = normalizeIban(cleaned);
      if (normalized.length < 10) {
        throw new DomainError("VALIDATION", "IBAN en az 10 karakter olmalıdır.");
      }
      if (isTurkishIban(normalized) && !isValidIbanChecksum(normalized)) {
        throw new DomainError(
          "VALIDATION",
          "Girilen TR IBAN numarası geçersiz (26 karakter ve MOD-97 kontrol basamağı doğrulanamadı).",
        );
      }
      validatedIban = normalized;
    }
  }

  const todayFallback = new Date().toISOString().slice(0, 10);

  let cashAccountId: string;
  let effectiveName: string;
  let effectiveAccountType: CashAccountDbType;
  let effectiveCurrency: string;
  let effectiveOpeningBalance: number | null;
  let effectiveOpeningBalanceDate: string;
  let effectiveIsActive: boolean;
  let prevRow: {
    id: string;
    name: string;
    account_type: CashAccountDbType;
    currency: string;
    opening_balance: string | number | null;
    opening_balance_date: string | null;
    opening_journal_entry_id: string | null;
    is_active: boolean;
  } | null = null;

  if (input.cashAccountId) {
    const existingRes = await client.query<{
      id: string;
      name: string;
      account_type: CashAccountDbType;
      currency: string;
      opening_balance: string | number | null;
      opening_balance_date: string | null;
      opening_journal_entry_id: string | null;
      is_active: boolean;
    }>(
      `select id::text, name, account_type, currency,
              opening_balance,
              to_char(opening_balance_date, 'YYYY-MM-DD') as opening_balance_date,
              opening_journal_entry_id::text as opening_journal_entry_id,
              is_active
         from public.cash_accounts
        where id = $1
        for update`,
      [input.cashAccountId],
    );
    if (existingRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Güncellenecek kasa/banka hesabı bulunamadı.");
    }
    prevRow = existingRes.rows[0];
    cashAccountId = prevRow.id;
    effectiveName = input.name ?? prevRow.name;
    effectiveAccountType = input.kind ? mapKindToCashAccountType(input.kind) : prevRow.account_type;
    effectiveCurrency = input.currency ?? prevRow.currency;

    if (effectiveCurrency !== prevRow.currency) {
      const txCnt = await client.query<{ cnt: number }>(
        `select count(*)::int as cnt from public.bank_transactions where bank_account_id = $1`,
        [cashAccountId],
      );
      if ((txCnt.rows[0]?.cnt ?? 0) > 0) {
        throw new DomainError(
          "CONFLICT",
          "Banka hareketi bulunan bir hesabın para birimi değiştirilemez.",
        );
      }
    }

    effectiveOpeningBalance =
      input.openingBalance !== undefined
        ? input.openingBalance === null
          ? null
          : Number(decimal(input.openingBalance).round(2).toFixed(2))
        : moneyOrNull(prevRow.opening_balance);
    effectiveOpeningBalanceDate =
      input.openingBalanceDate ?? prevRow.opening_balance_date ?? todayFallback;
    effectiveIsActive = input.isActive ?? Boolean(prevRow.is_active);

    try {
      const updRes = await client.query(
        `update public.cash_accounts
            set name = $2,
                account_type = $3,
                currency = $4,
                opening_balance = $5::numeric,
                opening_balance_date = $6::date,
                is_active = $7,
                notes = coalesce($8, notes)
          where id = $1`,
        [
          cashAccountId,
          effectiveName,
          effectiveAccountType,
          effectiveCurrency,
          effectiveOpeningBalance,
          effectiveOpeningBalanceDate,
          effectiveIsActive,
          input.notes !== undefined ? cleanOptionalText(input.notes) : null,
        ],
      );
      if (updRes.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Kasa/banka hesabı güncellenemedi.");
      }
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "23505") {
        throw new DomainError("CONFLICT", "Bu isimde bir kasa/banka hesabı zaten kayıtlı.");
      }
      throw err;
    }
  } else {
    if (!input.name) {
      throw new DomainError("VALIDATION", "Yeni kasa/banka hesabı için hesap adı zorunludur.");
    }
    effectiveName = input.name;
    effectiveAccountType = mapKindToCashAccountType(input.kind ?? "bank");
    effectiveCurrency = input.currency ?? "TRY";
    effectiveOpeningBalance =
      input.openingBalance == null
        ? null
        : Number(decimal(input.openingBalance).round(2).toFixed(2));
    effectiveOpeningBalanceDate = input.openingBalanceDate ?? todayFallback;
    effectiveIsActive = input.isActive ?? true;

    try {
      const insRes = await client.query<{ id: string }>(
        `insert into public.cash_accounts
           (name, account_type, currency, opening_balance, opening_balance_date, is_active, notes)
         values ($1, $2, $3, $4::numeric, $5::date, $6, $7)
         returning id::text as id`,
        [
          effectiveName,
          effectiveAccountType,
          effectiveCurrency,
          effectiveOpeningBalance,
          effectiveOpeningBalanceDate,
          effectiveIsActive,
          cleanOptionalText(input.notes),
        ],
      );
      cashAccountId = insRes.rows[0].id;
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "23505") {
        throw new DomainError("CONFLICT", "Bu isimde bir kasa/banka hesabı zaten kayıtlı.");
      }
      throw err;
    }
  }

  // Upsert linked `public.bank_accounts` sidecar when account is bank/credit or bank fields supplied
  const hasBankInputs =
    effectiveAccountType === "bank_account" ||
    validatedIban !== undefined ||
    input.bankName !== undefined ||
    input.branchCode !== undefined ||
    input.branchName !== undefined ||
    input.accountNumber !== undefined ||
    input.swiftBic !== undefined ||
    input.overdraftLimit !== undefined;

  let finalIbanNormalized: string | null = null;
  if (hasBankInputs) {
    const prevBank = await client.query<{
      cash_account_id: string;
      iban: string | null;
      iban_normalized: string | null;
      bank_name: string | null;
      branch_code: string | null;
      branch_name: string | null;
      account_number: string | null;
      swift_bic: string | null;
      overdraft_limit: string | number | null;
    }>(
      `select cash_account_id::text, iban, iban_normalized, bank_name,
              branch_code, branch_name, account_number, swift_bic, overdraft_limit
         from public.bank_accounts
        where cash_account_id = $1
        for update`,
      [cashAccountId],
    );
    const pb = prevBank.rows[0] ?? null;

    if (effectiveAccountType === "bank_account" || pb !== null || validatedIban != null || cleanOptionalText(input.bankName) != null) {
      const nextIban = validatedIban !== undefined ? validatedIban : (pb?.iban ?? null);
      const nextBankName =
        input.bankName !== undefined ? cleanOptionalText(input.bankName) : (pb?.bank_name ?? null);
      const nextBranchCode =
        input.branchCode !== undefined ? cleanOptionalText(input.branchCode) : (pb?.branch_code ?? null);
      const nextBranchName =
        input.branchName !== undefined ? cleanOptionalText(input.branchName) : (pb?.branch_name ?? null);
      const nextAcctNo =
        input.accountNumber !== undefined ? cleanOptionalText(input.accountNumber) : (pb?.account_number ?? null);
      const nextSwift =
        input.swiftBic !== undefined ? cleanOptionalText(input.swiftBic) : (pb?.swift_bic ?? null);
      const nextOverdraft =
        input.overdraftLimit !== undefined
          ? input.overdraftLimit
          : moneyOrNull(pb?.overdraft_limit);

      try {
        const upBank = await client.query<{ iban_normalized: string | null }>(
          `insert into public.bank_accounts
             (cash_account_id, iban, bank_name, branch_code, branch_name, account_number, swift_bic, overdraft_limit)
           values ($1, $2, $3, $4, $5, $6, $7, $8::numeric)
           on conflict (cash_account_id) do update set
             iban = excluded.iban,
             bank_name = excluded.bank_name,
             branch_code = excluded.branch_code,
             branch_name = excluded.branch_name,
             account_number = excluded.account_number,
             swift_bic = excluded.swift_bic,
             overdraft_limit = excluded.overdraft_limit
           returning iban_normalized`,
          [
            cashAccountId,
            nextIban,
            nextBankName,
            nextBranchCode,
            nextBranchName,
            nextAcctNo,
            nextSwift,
            nextOverdraft,
          ],
        );
        finalIbanNormalized = upBank.rows[0]?.iban_normalized ?? nextIban;
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === "23505") {
          throw new DomainError("CONFLICT", "Bu IBAN başka bir banka hesabında kayıtlı.");
        }
        throw err;
      }
    }
  }

  // Dual-Layer Management Ledger Opening Entry (A3 / TDHP 500.99)
  const oldJournalId = prevRow?.opening_journal_entry_id ?? null;
  const prevBalDec =
    prevRow?.opening_balance == null ? null : decimal(prevRow.opening_balance).round(2);
  const newBalDec =
    effectiveOpeningBalance == null ? null : decimal(effectiveOpeningBalance).round(2);
  const hasNonZeroOpening = newBalDec !== null && !newBalDec.eq(0);
  const assetAccountCode = effectiveAccountType === "cash" ? "100" : "102";
  const prevAssetCode = prevRow?.account_type === "cash" ? "100" : "102";

  let finalJournalEntryId: string | null = oldJournalId;
  let mustPostOpeningEntry = hasNonZeroOpening && oldJournalId === null;

  if (oldJournalId !== null) {
    const oldEntryRes = await client.query<{
      id: string;
      status: string;
      entry_date: string;
    }>(
      `select id::text, status, to_char(entry_date, 'YYYY-MM-DD') as entry_date
         from public.management_journal_entries
        where id = $1
        for update`,
      [oldJournalId],
    );
    const oldEntry = oldEntryRes.rows[0] ?? null;

    const amountChanged =
      prevBalDec === null || newBalDec === null || !prevBalDec.eq(newBalDec);
    const dateChanged = (prevRow?.opening_balance_date ?? null) !== effectiveOpeningBalanceDate;
    const currencyChanged = (prevRow?.currency ?? null) !== effectiveCurrency;
    const assetClassChanged = prevAssetCode !== assetAccountCode;
    const oldMissingOrReversed = !oldEntry || oldEntry.status === "reversed";

    const needsCleanup =
      !hasNonZeroOpening ||
      amountChanged ||
      dateChanged ||
      currencyChanged ||
      assetClassChanged ||
      oldMissingOrReversed;

    if (needsCleanup) {
      await client.query(
        `update public.cash_accounts set opening_journal_entry_id = null where id = $1`,
        [cashAccountId],
      );
      finalJournalEntryId = null;

      if (oldEntry) {
        if (oldEntry.status === "posted") {
          await reverseManagementEntryWithClient(
            client,
            oldJournalId,
            `Açılış bakiyesi güncellendi (${effectiveName})`,
            actorId,
            effectiveOpeningBalanceDate,
          );
        } else if (oldEntry.status === "provisional_fx" || oldEntry.status === "draft") {
          await client.query(
            `delete from public.management_journal_entries where id = $1`,
            [oldJournalId],
          );
        }
      }
      mustPostOpeningEntry = hasNonZeroOpening;
    }
  }

  if (mustPostOpeningEntry && newBalDec !== null) {
    const absAmount = Number(newBalDec.abs().toFixed(2));
    const lines = newBalDec.gt(0)
      ? [
          {
            accountCode: assetAccountCode,
            debitNative: absAmount,
            memo: `Açılış bakiyesi (${effectiveName})`,
          },
          {
            accountCode: "500.99",
            creditNative: absAmount,
            memo: `Açılış bilançosu denkleştirme (${effectiveName})`,
          },
        ]
      : [
          {
            accountCode: "500.99",
            debitNative: absAmount,
            memo: `Kredili hesap açılış denkleştirme (${effectiveName})`,
          },
          {
            accountCode: assetAccountCode,
            creditNative: absAmount,
            memo: `Açılış bakiyesi (${effectiveName})`,
          },
        ];

    const posted = await postJournalEntryWithClient(
      client,
      {
        entryDate: effectiveOpeningBalanceDate,
        sourceType: "manual_adjustment",
        sourceId: cashAccountId,
        idempotencyKey: `opening_balance:${cashAccountId}`,
        currency: effectiveCurrency,
        description: `Açılış bakiyesi (${effectiveName})`,
        lines,
      },
      actorId,
    );

    await client.query(
      `update public.cash_accounts set opening_journal_entry_id = $2 where id = $1`,
      [cashAccountId, posted.entryId],
    );
    finalJournalEntryId = posted.entryId;
  }

  await audit(client, {
    actor: actorId,
    action: prevRow ? "update_cash_or_bank_account" : "create_cash_or_bank_account",
    entityTable: "cash_accounts",
    entityId: cashAccountId,
    before: prevRow
      ? {
          name: prevRow.name,
          accountType: prevRow.account_type,
          currency: prevRow.currency,
          openingBalance: moneyOrNull(prevRow.opening_balance),
          openingBalanceDate: prevRow.opening_balance_date,
          openingJournalEntryId: prevRow.opening_journal_entry_id,
          isActive: prevRow.is_active,
        }
      : null,
    after: {
      name: effectiveName,
      accountType: effectiveAccountType,
      currency: effectiveCurrency,
      openingBalance: effectiveOpeningBalance,
      openingBalanceDate: effectiveOpeningBalanceDate,
      openingJournalEntryId: finalJournalEntryId,
      ibanNormalized: finalIbanNormalized,
      isActive: effectiveIsActive,
    },
  });

  return {
    cashAccountId,
    accountType: effectiveAccountType,
    currency: effectiveCurrency,
    openingBalance: effectiveOpeningBalance,
    openingBalanceDate: effectiveOpeningBalanceDate,
    openingJournalEntryId: finalJournalEntryId,
    ibanNormalized: finalIbanNormalized,
  };
}

export async function upsertCashOrBankAccountWithOpeningBalance(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<UpsertCashOrBankAccountResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await upsertCashOrBankAccountWithClient(client, raw, actorId);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    translatePeriodLockError(e);
  } finally {
    client.release();
  }
}

export interface EditableCashOrBankAccount {
  id: string;
  name: string;
  accountType: CashAccountDbType;
  currency: string;
  openingBalance: number | null;
  openingBalanceDate: string | null;
  openingJournalEntryId: string | null;
  isActive: boolean;
  hasBankProfile: boolean;
  iban: string | null;
  ibanNormalized: string | null;
  bankName: string | null;
  branchCode: string | null;
  overdraftLimit: number | null;
}

export async function loadEditableCashAndBankAccounts(
  pool: Pick<Pool, "query">,
): Promise<EditableCashOrBankAccount[]> {
  const r = await pool
    .query<{
      id: string;
      name: string;
      account_type: CashAccountDbType;
      currency: string;
      opening_balance: string | number | null;
      opening_balance_date: string | null;
      opening_journal_entry_id: string | null;
      is_active: boolean;
      has_bank_profile: boolean;
      iban: string | null;
      iban_normalized: string | null;
      bank_name: string | null;
      branch_code: string | null;
      overdraft_limit: string | number | null;
    }>(
      `select ca.id::text,
              ca.name,
              ca.account_type,
              ca.currency,
              ca.opening_balance,
              to_char(ca.opening_balance_date, 'YYYY-MM-DD') as opening_balance_date,
              ca.opening_journal_entry_id::text as opening_journal_entry_id,
              ca.is_active,
              (ba.cash_account_id is not null) as has_bank_profile,
              ba.iban,
              ba.iban_normalized,
              ba.bank_name,
              ba.branch_code,
              ba.overdraft_limit
         from public.cash_accounts ca
         left join public.bank_accounts ba on ba.cash_account_id = ca.id
        order by ca.is_active desc, ca.currency asc, ca.name asc`,
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query(
            `select ca.id::text,
                    ca.name,
                    ca.account_type,
                    ca.currency,
                    ca.opening_balance,
                    null::text as opening_balance_date,
                    null::text as opening_journal_entry_id,
                    ca.is_active,
                    (ba.cash_account_id is not null) as has_bank_profile,
                    ba.iban,
                    ba.iban_normalized,
                    ba.bank_name,
                    ba.branch_code,
                    ba.overdraft_limit
               from public.cash_accounts ca
               left join public.bank_accounts ba on ba.cash_account_id = ca.id
              order by ca.is_active desc, ca.currency asc, ca.name asc`,
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    accountType: x.account_type,
    currency: x.currency,
    openingBalance: moneyOrNull(x.opening_balance),
    openingBalanceDate: x.opening_balance_date ?? null,
    openingJournalEntryId: x.opening_journal_entry_id ?? null,
    isActive: Boolean(x.is_active),
    hasBankProfile: Boolean(x.has_bank_profile),
    iban: x.iban ?? null,
    ibanNormalized: x.iban_normalized ?? null,
    bankName: x.bank_name ?? null,
    branchCode: x.branch_code ?? null,
    overdraftLimit: moneyOrNull(x.overdraft_limit),
  }));
}

/* ── F-43: Günlük Nakit Hareket Özeti (public.daily_cash_movement) ───────────────────── */

export interface DailyCashMovementRow {
  txnDate: string;
  currency: string;
  inflow: number;
  outflow: number;
  netMovement: number;
  movementCount: number;
  runningNet: number;
  foreignTxnCount: number;
}

export async function loadDailyCashMovements(
  pool: Pick<Pool, "query">,
  limit = 30,
): Promise<DailyCashMovementRow[]> {
  const r = await pool
    .query<{
      txn_date: string;
      currency: string;
      inflow: string | number | null;
      outflow: string | number | null;
      net_movement: string | number | null;
      movement_count: string | number | null;
      running_net: string | number | null;
      foreign_txn_count: string | number | null;
    }>(
      `select to_char(txn_date, 'YYYY-MM-DD') as txn_date,
              currency,
              inflow,
              outflow,
              net_movement,
              movement_count,
              running_net,
              foreign_txn_count
         from public.daily_cash_movement
        order by txn_date desc, currency asc
        limit $1`,
      [limit],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  return r.rows.map((x) => ({
    txnDate: x.txn_date,
    currency: x.currency,
    inflow: moneyOrNull(x.inflow) ?? 0,
    outflow: moneyOrNull(x.outflow) ?? 0,
    netMovement: moneyOrNull(x.net_movement) ?? 0,
    movementCount: intOrNull(x.movement_count) ?? 0,
    runningNet: moneyOrNull(x.running_net) ?? 0,
    foreignTxnCount: intOrNull(x.foreign_txn_count) ?? 0,
  }));
}
