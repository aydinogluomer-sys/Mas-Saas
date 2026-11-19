/**
 * Faz 54 (F1) — Auto-Seeded 13-Week Direct Rolling Cash Forecast &
 * Frozen Snapshot vs. Actual Variance Waterfall (`Timing Slip vs. Permanent Variance`).
 *
 * Key invariants:
 * 1. Zero "Today Cliff": open receivables use `expectedCollectionDateV2` (5-tier behavioral model);
 *    `overdue_unscheduled` receivables are NEVER dumped into Week 1 as fake inflows, and
 *    `doubtful_excluded` receivables are excluded from cash inflows.
 * 2. Faz 44 Deduplication Shield: an invoice already represented by an active check
 *    (`settled_by_check_id` or `checks.linked_invoice_id`) or active `payment_instances.linked_invoice_id`
 *    appears only once in the 13-week schedule.
 * 3. `FIN-03` Null-Safe Opening Balance: when `unknown_opening_count > 0` for the currency,
 *    `openingCash`, weekly `openingBalance`, `closingBalance`, `floorHeadroom`, and `breachesFloor`
 *    stay `null` (never coerced to `0`).
 * 4. Exact `Big` Waterfall Identity:
 *    `Forecast Net + Timing Slip + Permanent Inflow Variance + Permanent Outflow Variance === Actual Bank Net Movement`
 *    (`own_transfer` bank transactions are excluded).
 */

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { generateTrStatutoryObligations, type TrStatutoryObligation } from "@/lib/calendar/tr-tax-calendar";
import {
  expectedCollectionDateV2,
  type CollectionSignalsV2,
} from "@/lib/collections/rules";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, money, moneyOrNull, rateOrNull, round2 } from "@/lib/money";
import { gather, isPool as isPgPool, withPinnedRead } from "@/lib/pg-concurrency";
import { formatIssues } from "@/lib/validation";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type Forecast13wCategoryBucket =
  | "contracted_ar"
  | "behavioral_ar"
  | "scheduled_payment"
  | "open_ap"
  | "check_maturity"
  | "loan_installment"
  | "statutory_tax_sgk"
  | "manual_override";

export type Forecast13wSourceClassification =
  | "promised"
  | "behavioral_dbt"
  | "scheduled"
  | "statutory_tax"
  | "manual_override";

export interface Forecast13wSeededLine {
  weekIndex: number;
  weekStart: string;
  dueDate: string;
  direction: "inflow" | "outflow";
  categoryBucket: Forecast13wCategoryBucket;
  sourceClassification: Forecast13wSourceClassification;
  sourceEntityTable: string | null;
  sourceEntityId: string | null;
  partyId: string | null;
  partyName: string | null;
  label: string;
  amount: number;
}

export interface OverdueUnscheduledReceivableItem {
  invoiceId: string;
  invoiceNo: string;
  partyId: string | null;
  partyName: string;
  dueDate: string | null;
  daysOverdue: number | null;
  openAmount: number;
  currency: string;
}

export interface Forecast13wWeekBucket {
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  openingBalance: number | null;
  inflow: number;
  outflow: number;
  netFlow: number;
  closingBalance: number | null;
  minCashFloor: number | null;
  floorHeadroom: number | null;
  breachesFloor: boolean | null;
  inflowByCategory: Record<Forecast13wCategoryBucket, number>;
  outflowByCategory: Record<Forecast13wCategoryBucket, number>;
  lines: Forecast13wSeededLine[];
}

export interface AutoSeeded13WeekForecast {
  asOfDate: string;
  snapshotWeekStart: string;
  horizonEnd: string;
  currency: string;
  openingCash: number | null;
  unknownOpeningCount: number;
  minCashFloor: number | null;
  totalInflow: number;
  totalOutflow: number;
  totalNetFlow: number;
  endingCash: number | null;
  worstWeekStart: string | null;
  worstClosingBalance: number | null;
  firstFloorBreachWeekStart: string | null;
  overdueUnscheduledCount: number;
  overdueUnscheduledAmount: number;
  overdueUnscheduledItems: OverdueUnscheduledReceivableItem[];
  doubtfulExcludedCount: number;
  doubtfulExcludedAmount: number;
  vatCarryforward190Opening?: number;
  vatCarryforward190Applied?: number;
  posBatchInflowTotal?: number;
  corporateCardOutflowTotal?: number;
  payrollTaxAccrualOutflowTotal?: number;
  statutoryDeadlines: TrStatutoryObligation[];
  weeks: Forecast13wWeekBucket[];
}

export interface FreezeWeekly13wSnapshotResult {
  snapshotId: string;
  snapshotWeekStart: string;
  asOfDate: string;
  currency: string;
  openingCash: number | null;
  unknownOpeningCount: number;
  lineCount: number;
  totalInflow: number;
  totalOutflow: number;
  totalNetFlow: number;
}

export interface VarianceWaterfallLineDetail {
  kind: "matched_settled" | "timing_slip" | "permanent_cancelled" | "unplanned_bank_movement";
  direction: "inflow" | "outflow";
  label: string;
  sourceEntityTable: string | null;
  sourceEntityId: string | null;
  bankTransactionId: string | null;
  forecastSignedAmount: number;
  actualSignedAmount: number;
  timingSlipSignedAmount: number;
  permanentInflowVarianceSigned: number;
  permanentOutflowVarianceSigned: number;
  explanation: string;
}

export interface VarianceWaterfallResult {
  snapshotId: string;
  currency: string;
  weekIndex: number;
  weekStart: string;
  weekEnd: string;
  forecastInflow: number;
  forecastOutflow: number;
  forecastNet: number;
  actualBankInflow: number;
  actualBankOutflow: number;
  actualBankNetMovement: number;
  totalNetVariance: number;
  timingSlipAmount: number;
  permanentInflowVarianceAmount: number;
  permanentOutflowVarianceAmount: number;
  permanentVarianceAmount: number;
  identityBalanced: boolean;
  identityDiff: number;
  details: VarianceWaterfallLineDetail[];
}

export const CATEGORY_BUCKET_LABELS: Record<Forecast13wCategoryBucket, string> = {
  contracted_ar: "Sözleşmeli / Vadeli Alacak Tahsilatı",
  behavioral_ar: "Davranışsal (DBT) Alacak Tahsilatı",
  scheduled_payment: "Planlı Ödeme & Sabit Gider",
  open_ap: "Tedarikçi Faturası (Açık Borç)",
  check_maturity: "Çek / Senet Vadesi",
  loan_installment: "Kredi Anapara + Faiz Taksiti",
  statutory_tax_sgk: "Yasal Vergi / SGK Takvimi",
  manual_override: "Manuel CFO Tahmin Satırı",
};

const ALL_CATEGORIES: readonly Forecast13wCategoryBucket[] = [
  "contracted_ar",
  "behavioral_ar",
  "scheduled_payment",
  "open_ap",
  "check_maturity",
  "loan_installment",
  "statutory_tax_sgk",
  "manual_override",
] as const;

function emptyCategoryMap(): Record<Forecast13wCategoryBucket, number> {
  return {
    contracted_ar: 0,
    behavioral_ar: 0,
    scheduled_payment: 0,
    open_ap: 0,
    check_maturity: 0,
    loan_installment: 0,
    statutory_tax_sgk: 0,
    manual_override: 0,
  };
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Returns the ISO Monday (`YYYY-MM-DD`) on or before `isoDate`.
 */
export function mondayOfWeek(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new DomainError("VALIDATION", `Geçersiz tarih formatı: ${isoDate}`);
  }
  const dt = new Date(`${isoDate}T00:00:00Z`);
  const dow = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDaysISO(isoDate, offset);
}

function weekIndexForDate(dateISO: string, snapshotWeekStart: string): number | null {
  const diffDays = Math.floor(
    (Date.parse(`${dateISO}T00:00:00Z`) - Date.parse(`${snapshotWeekStart}T00:00:00Z`)) / 86_400_000,
  );
  if (diffDays < 0 || diffDays >= 91) return null;
  return Math.floor(diffDays / 7) + 1;
}

/**
 * Builds the 13-week direct rolling cash forecast from live operational obligations & receivables.
 */
export async function buildAutoSeeded13WeekForecast(
  client: Queryable,
  options: {
    asOfDate?: string;
    currency?: string;
    dbtMode?: "median" | "p75";
  } = {},
): Promise<AutoSeeded13WeekForecast> {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const currency = (options.currency ?? "TRY").trim().toUpperCase();
  const dbtMode = options.dbtMode ?? "median";

  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError("VALIDATION", `Geçersiz para birimi: ${currency}`);
  }
  if (isPgPool(client)) {
    return withPinnedRead(client, (pinned) => buildAutoSeeded13WeekForecast(pinned, options));
  }

  const snapshotWeekStart = mondayOfWeek(asOfDate);
  const horizonEnd = addDaysISO(snapshotWeekStart, 90); // 13 weeks * 7 - 1 = 90 days
  const statutoryDeadlines: TrStatutoryObligation[] =
    currency === "TRY" ? generateTrStatutoryObligations(snapshotWeekStart, horizonEnd) : [];

  type CheckMaturityRow = {
    id: string;
    maturity_date: string;
    direction: string;
    amount: string;
    counterparty_label: string | null;
    party_id: string | null;
    party_name: string | null;
  };
  type LoanInstallmentRow = {
    id: string;
    due_date: string;
    remaining_amount: string;
    loan_name: string;
    installment_no: number;
    party_id: string | null;
    party_name: string | null;
  };

  const regRes = await client
    .query<{
      has_mgmt: string | null;
      has_pta: string | null;
      has_pos: string | null;
      has_card: string | null;
    }>(
      `select
         to_regclass('public.management_accounts')::text as has_mgmt,
         to_regclass('public.payroll_tax_accruals')::text as has_pta,
         to_regclass('public.pos_settlement_batches')::text as has_pos,
         to_regclass('public.corporate_card_statements')::text as has_card`,
    )
    .catch(() => ({
      rows: [{ has_mgmt: null, has_pta: null, has_pos: null, has_card: null }],
    }));
  const regRow = regRes.rows[0] ?? {
    has_mgmt: null,
    has_pta: null,
    has_pos: null,
    has_card: null,
  };

  const [
    posRes,
    floorRes,
    arRes,
    ptpRes,
    piRes,
    apRes,
    checkRes,
    loanRes,
    vatByPeriodRes,
    manualRes,
    vat190Res,
    payrollTaxRes,
    posBatchRes,
    corpCardRes,
  ] = await gather(client, [
    // 1. Opening treasury cash position (FIN-03 null-safe)
    () =>
      client
        .query<{
          available_now: string | null;
          unknown_opening_count: number | string;
        }>(
          `select available_now, unknown_opening_count
             from public.treasury_position_summary
            where currency = $1`,
          [currency],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string })?.code;
          if (code === "42703") {
            return client.query<{
              available_now: string | null;
              unknown_opening_count: number | string;
            }>(
              `select available_now, 0::int as unknown_opening_count
                 from public.treasury_position_summary
                where currency = $1`,
              [currency],
            );
          }
          throw err;
        }),
    // 2. Minimum cash floor policy for currency
    () =>
      client.query<{ threshold_amount: string | null }>(
        `select threshold_amount
           from public.treasury_policies
          where policy_kind = 'min_cash'
            and is_active
            and cash_account_id is null
            and currency = $1
          limit 1`,
        [currency],
      ),
    // 3. Open Sales Invoices (behavioral V2 + Faz 44 deduplication shield)
    () =>
      client
        .query<{
          invoice_id: string;
          party_id: string | null;
          party_name: string | null;
          invoice_no: string;
          issue_date: string;
          due_date: string | null;
          open_amount: string;
          days_overdue: number | string | null;
          bad_debt_flagged: boolean;
          party_avg_days_to_settle: string | null;
          party_settled_count: number | string | null;
          party_late_ratio: string | null;
          party_invoice_count: number | string | null;
          partially_settled: boolean;
          active_promise_date: string | null;
          dbt_samples: Array<number | string | null> | null;
        }>(
          `with active_promises as (
             select
               p.invoice_id,
               p.party_id,
               to_char(min(p.promised_date), 'YYYY-MM-DD') as promised_date
             from public.promise_to_pay p
             where p.status = 'pending'
               and p.promised_date >= $1::date
               and p.currency = $2
             group by p.invoice_id, p.party_id
           ),
           party_dbt as (
             select
               s.party_id,
               array_agg(s.dbt_days order by s.dbt_days) as dbt_samples
             from (
               select
                 inv.party_id,
                 inv.id,
                 (max(a.allocated_on) - inv.due_date)::int as dbt_days
               from public.invoices inv
               join public.invoice_allocations a on a.invoice_id = inv.id and a.reversed_at is null
               where inv.direction = 'sales'
                 and inv.status in ('settled', 'paid')
                 and inv.due_date is not null
               group by inv.party_id, inv.id, inv.due_date
             ) s
             group by s.party_id
           )
           select
             rcs.invoice_id::text,
             rcs.party_id::text,
             rcs.party_name,
             rcs.invoice_no,
             to_char(rcs.issue_date, 'YYYY-MM-DD') as issue_date,
             to_char(rcs.due_date, 'YYYY-MM-DD') as due_date,
             rcs.open_amount,
             rcs.days_overdue,
             rcs.bad_debt_flagged,
             rcs.party_avg_days_to_settle,
             rcs.party_settled_count,
             rcs.party_late_ratio,
             rcs.party_invoice_count,
             rcs.partially_settled,
             coalesce(ap_inv.promised_date, ap_party.promised_date) as active_promise_date,
             pdbt.dbt_samples
           from public.receivable_collection_signals rcs
           join public.invoices v on v.id = rcs.invoice_id
           left join active_promises ap_inv on ap_inv.invoice_id = rcs.invoice_id
           left join (
             select party_id, min(promised_date) as promised_date
             from active_promises
             where invoice_id is null
             group by party_id
           ) ap_party on ap_party.party_id = rcs.party_id
           left join party_dbt pdbt on pdbt.party_id = rcs.party_id
           where rcs.currency = $2
             and rcs.open_amount > 0
             and not (
               v.settled_by_check_id is not null
               and exists (
                 select 1 from public.checks c0
                 where c0.id = v.settled_by_check_id
                   and c0.archived_at is null
                   and c0.status <> 'cancelled'
               )
             )
             and not exists (
               select 1
               from public.payment_instances pi2
               left join public.payments p2 on p2.id = pi2.payment_id
               where pi2.linked_invoice_id = v.id
                 and pi2.status <> 'cancelled'
                 and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
             )
             and not exists (
               select 1
               from public.checks c2
               where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = v.id
                 and c2.archived_at is null
                 and c2.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
                 and not exists (
                   select 1
                   from public.invoice_allocations ia
                   where ia.invoice_id = v.id
                     and ia.source_table = 'checks'
                     and ia.source_id = c2.id
                     and ia.reversed_at is null
                 )
             )
           order by rcs.due_date nulls last, rcs.invoice_id`,
          [asOfDate, currency],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string })?.code;
          if (code === "42P01" || code === "42703") {
            return client.query<{
              invoice_id: string;
              party_id: string | null;
              party_name: string | null;
              invoice_no: string;
              issue_date: string;
              due_date: string | null;
              open_amount: string;
              days_overdue: number | string | null;
              bad_debt_flagged: boolean;
              party_avg_days_to_settle: string | null;
              party_settled_count: number | string | null;
              party_late_ratio: string | null;
              party_invoice_count: number | string | null;
              partially_settled: boolean;
              active_promise_date: string | null;
              dbt_samples: Array<number | string | null> | null;
            }>(
              `select
                 rcs.invoice_id::text,
                 rcs.party_id::text,
                 rcs.party_name,
                 rcs.invoice_no,
                 to_char(rcs.issue_date, 'YYYY-MM-DD') as issue_date,
                 to_char(rcs.due_date, 'YYYY-MM-DD') as due_date,
                 rcs.open_amount,
                 rcs.days_overdue,
                 rcs.bad_debt_flagged,
                 rcs.party_avg_days_to_settle,
                 rcs.party_settled_count,
                 rcs.party_late_ratio,
                 rcs.party_invoice_count,
                 rcs.partially_settled,
                 null::text as active_promise_date,
                 null::int[] as dbt_samples
               from public.receivable_collection_signals rcs
               join public.invoices v on v.id = rcs.invoice_id
               where v.currency = $1
                 and rcs.open_amount > 0
               order by rcs.due_date nulls last, rcs.invoice_id`,
              [currency],
            );
          }
          throw err;
        }),
    // 4. Standalone promise_to_pay (not linked to a specific invoice)
    () =>
      client
        .query<{
          id: string;
          party_id: string | null;
          party_name: string | null;
          promised_date: string;
          promised_amount: string;
          notes: string | null;
        }>(
          `select
             pr.id::text,
             pr.party_id::text,
             pa.name as party_name,
             to_char(pr.promised_date, 'YYYY-MM-DD') as promised_date,
             pr.promised_amount,
             pr.note as notes
           from public.promise_to_pay pr
           left join public.parties pa on pa.id = pr.party_id
           where pr.status = 'pending'
             and pr.invoice_id is null
             and pr.currency = $1
             and pr.promised_date >= $2::date
             and pr.promised_date <= $3::date
             and pr.promised_amount > 0
           order by pr.promised_date, pr.id`,
          [currency, snapshotWeekStart, horizonEnd],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string })?.code;
          if (code === "42P01" || code === "42703") return { rows: [] };
          throw err;
        }),
    // 5. Scheduled payment_instances (outflow & inflow, excluding transfers)
    () =>
      client.query<{
        id: string;
        due_date: string;
        direction: string | null;
        remaining_amount: string;
        label: string;
        party_id: string | null;
        party_name: string | null;
      }>(
        `select
           pi.id::text,
           to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
           coalesce(pi.direction, 'outflow') as direction,
           greatest(
             0,
             case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end
           )::numeric(14,2) as remaining_amount,
           coalesce(p.name, '(Planlı Ödeme)') as label,
           p.provider_party_id::text as party_id,
           pa.name as party_name
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
         left join public.parties pa on pa.id = p.provider_party_id
         where pi.status in ('planned', 'unpaid', 'partial', 'late')
           and (p.id is null or (p.status = 'active' and p.archived_at is null))
           and coalesce(pi.direction, 'outflow') <> 'transfer'
           and pi.currency = $1
           and pi.due_date between $2::date and $3::date
           and pi.amount is not null
         order by pi.due_date, pi.id`,
        [currency, snapshotWeekStart, horizonEnd],
      ),
    // 6. Open Purchase Invoices (open_ap) with Faz 44 deduplication shield
    () =>
      client
        .query<{
          id: string;
          invoice_no: string;
          due_date: string;
          open_amount: string;
          party_id: string | null;
          party_name: string | null;
        }>(
          `select
             v.id::text,
             v.invoice_no,
             to_char(v.due_date, 'YYYY-MM-DD') as due_date,
             (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as open_amount,
             v.party_id::text,
             pa.name as party_name
           from public.invoices v
           left join public.parties pa on pa.id = v.party_id
           where v.direction = 'purchase'
             and v.status in ('open', 'partial')
             and v.currency = $1
             and v.due_date between $2::date and $3::date
             and v.gross_amount > coalesce(v.allocated_amount, 0)
             and not (
               v.settled_by_check_id is not null
               and exists (
                 select 1 from public.checks c0
                 where c0.id = v.settled_by_check_id
                   and c0.archived_at is null
                   and c0.status <> 'cancelled'
               )
             )
             and not exists (
               select 1
               from public.payment_instances pi2
               left join public.payments p2 on p2.id = pi2.payment_id
               where pi2.linked_invoice_id = v.id
                 and pi2.status <> 'cancelled'
                 and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
             )
             and not exists (
               select 1
               from public.checks c2
               where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = v.id
                 and c2.archived_at is null
                 and c2.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
                 and not exists (
                   select 1
                   from public.invoice_allocations ia
                   where ia.invoice_id = v.id
                     and ia.source_table = 'checks'
                     and ia.source_id = c2.id
                     and ia.reversed_at is null
                 )
             )
           order by v.due_date, v.id`,
          [currency, snapshotWeekStart, horizonEnd],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string })?.code;
          if (code === "42703") {
            return client.query<{
              id: string;
              invoice_no: string;
              due_date: string;
              open_amount: string;
              party_id: string | null;
              party_name: string | null;
            }>(
              `select
                 v.id::text,
                 v.invoice_no,
                 to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                 (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as open_amount,
                 v.party_id::text,
                 pa.name as party_name
               from public.invoices v
               left join public.parties pa on pa.id = v.party_id
               where v.direction = 'purchase'
                 and v.status in ('open', 'partial')
                 and v.currency = $1
                 and v.due_date between $2::date and $3::date
                 and v.gross_amount > coalesce(v.allocated_amount, 0)
               order by v.due_date, v.id`,
              [currency, snapshotWeekStart, horizonEnd],
            );
          }
          throw err;
        }),
    // 7. Checks & Promissory Notes (check_maturity)
    () =>
      client
        .query<CheckMaturityRow>(
          `select
             ch.id::text,
             to_char(ch.maturity_date, 'YYYY-MM-DD') as maturity_date,
             ch.direction,
             abs(ch.amount)::numeric(14,2) as amount,
             ch.counterparty_label,
             coalesce(ch.payee_party_id, ch.payer_party_id)::text as party_id,
             coalesce(pe.name, py.name, ch.counterparty_label) as party_name
           from public.checks ch
           left join public.parties pe on pe.id = ch.payee_party_id
           left join public.parties py on py.id = ch.payer_party_id
           where ch.archived_at is null
             and ch.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
             and ch.currency = $1
             and ch.maturity_date between $2::date and $3::date
             and ch.amount > 0
           order by ch.maturity_date, ch.id`,
          [currency, snapshotWeekStart, horizonEnd],
        )
        .then(
          (r): { rows: CheckMaturityRow[] } => ({ rows: r.rows }),
          async (err: unknown): Promise<{ rows: CheckMaturityRow[] }> => {
            const code = (err as { code?: string })?.code;
            if (code === "42703") {
              if (currency !== "TRY") return { rows: [] };
              const fallback = await client.query<CheckMaturityRow>(
                `select
                   ch.id::text,
                   to_char(ch.maturity_date, 'YYYY-MM-DD') as maturity_date,
                   ch.direction,
                   abs(ch.amount)::numeric(14,2) as amount,
                   ch.counterparty_label,
                   coalesce(ch.payee_party_id, ch.payer_party_id)::text as party_id,
                   coalesce(pe.name, py.name, ch.counterparty_label) as party_name
                 from public.checks ch
                 left join public.parties pe on pe.id = ch.payee_party_id
                 left join public.parties py on py.id = ch.payer_party_id
                 where ch.archived_at is null
                   and ch.status in ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')
                   and ch.maturity_date between $1::date and $2::date
                   and ch.amount > 0
                 order by ch.maturity_date, ch.id`,
                [snapshotWeekStart, horizonEnd],
              );
              return { rows: fallback.rows };
            }
            throw err;
          },
        ),
    // 8. Loan Installments (loan_installment)
    () =>
      client
        .query<LoanInstallmentRow>(
          `select
             li.id::text,
             to_char(li.due_date, 'YYYY-MM-DD') as due_date,
             greatest(
               0,
               case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end
             )::numeric(14,2) as remaining_amount,
             coalesce(l.name, 'Kredi') as loan_name,
             li.installment_no,
             l.lender_party_id::text as party_id,
             pa.name as party_name
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
           left join public.parties pa on pa.id = l.lender_party_id
           where l.archived_at is null
             and li.status in ('planned', 'unpaid', 'partial', 'late')
             and l.currency = $1
             and li.due_date between $2::date and $3::date
             and li.amount > 0
           order by li.due_date, li.id`,
          [currency, snapshotWeekStart, horizonEnd],
        )
        .then(
          (r): { rows: LoanInstallmentRow[] } => ({ rows: r.rows }),
          async (err: unknown): Promise<{ rows: LoanInstallmentRow[] }> => {
            const code = (err as { code?: string })?.code;
            if (code === "42703") {
              if (currency !== "TRY") return { rows: [] };
              const fallback = await client.query<LoanInstallmentRow>(
                `select
                   li.id::text,
                   to_char(li.due_date, 'YYYY-MM-DD') as due_date,
                   greatest(
                     0,
                     case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end
                   )::numeric(14,2) as remaining_amount,
                   coalesce(l.name, 'Kredi') as loan_name,
                   li.installment_no,
                   l.lender_party_id::text as party_id,
                   pa.name as party_name
                 from public.loan_installments li
                 join public.loans l on l.id = li.loan_id
                 left join public.parties pa on pa.id = l.lender_party_id
                 where l.archived_at is null
                   and li.status in ('planned', 'unpaid', 'partial', 'late')
                   and li.due_date between $1::date and $2::date
                   and li.amount > 0
                 order by li.due_date, li.id`,
                [snapshotWeekStart, horizonEnd],
              );
              return { rows: fallback.rows };
            }
            throw err;
          },
        ),
    // 9. Turkish Statutory Tax & SGK Calendar (TRY only)
    () =>
      currency === "TRY" && statutoryDeadlines.length > 0
        ? client
            .query<{
              tax_period: string;
              sales_vat: string;
              purchase_vat: string;
              withheld_vat: string;
            }>(
              `select
                 to_char(issue_date, 'YYYY-MM') as tax_period,
                 coalesce(
                   sum(coalesce(tax_amount, 0) - coalesce(vat_withholding_amount, 0))
                     filter (where direction = 'sales' and status <> 'cancelled'),
                   0
                 )::numeric(14,2) as sales_vat,
                 coalesce(
                   sum(coalesce(tax_amount, 0))
                     filter (where direction = 'purchase' and status <> 'cancelled'),
                   0
                 )::numeric(14,2) as purchase_vat,
                 coalesce(
                   sum(coalesce(vat_withholding_amount, 0))
                     filter (where direction = 'purchase' and status <> 'cancelled'),
                   0
                 )::numeric(14,2) as withheld_vat
               from public.invoices
               where currency = 'TRY'
               group by to_char(issue_date, 'YYYY-MM')`,
            )
            .catch((err: unknown) => {
              const code = (err as { code?: string })?.code;
              if (code === "42703") {
                return client.query<{
                  tax_period: string;
                  sales_vat: string;
                  purchase_vat: string;
                  withheld_vat: string;
                }>(
                  `select
                     to_char(issue_date, 'YYYY-MM') as tax_period,
                     coalesce(
                       sum(coalesce(tax_amount, 0))
                         filter (where direction = 'sales' and status <> 'cancelled'),
                       0
                     )::numeric(14,2) as sales_vat,
                     coalesce(
                       sum(coalesce(tax_amount, 0))
                         filter (where direction = 'purchase' and status <> 'cancelled'),
                       0
                     )::numeric(14,2) as purchase_vat,
                     0::numeric(14,2)::text as withheld_vat
                   from public.invoices
                   where currency = 'TRY'
                   group by to_char(issue_date, 'YYYY-MM')`,
                );
              }
              throw err;
            })
        : Promise.resolve({
            rows: [] as Array<{
              tax_period: string;
              sales_vat: string;
              purchase_vat: string;
              withheld_vat: string;
            }>,
          }),
    // 10. Manual Overrides from active weekly_13 forecasts (forecast_lines where source_kind = 'manual')
    () =>
      client.query<{
        id: string;
        period_start: string;
        direction: "inflow" | "outflow";
        amount: string;
        notes: string | null;
        forecast_name: string;
      }>(
        `select
           fl.id::text,
           to_char(fl.period_start, 'YYYY-MM-DD') as period_start,
           fl.direction,
           abs(fl.amount)::numeric(14,2) as amount,
           fl.notes,
           f.name as forecast_name
         from public.forecast_lines fl
         join public.forecasts f on f.id = fl.forecast_id
         where f.is_active
           and f.horizon_kind = 'weekly_13'
           and coalesce(fl.currency, f.currency, 'TRY') = $1
           and fl.version_status in ('draft', 'approved')
           and fl.source_kind = 'manual'
           and fl.period_start between $2::date and $3::date
           and abs(fl.amount) > 0
         order by fl.period_start, fl.id`,
        [currency, snapshotWeekStart, horizonEnd],
      ),
    // 11. TDHP 190 Devreden KDV carryforward balance (TRY only)
    () =>
      currency === "TRY" && regRow.has_mgmt
        ? client.query<{ vat_carry_190: string }>(
            `select greatest(0, coalesce(sum(coalesce(jl.debit_try, 0) - coalesce(jl.credit_try, 0)), 0))::numeric(14,2) as vat_carry_190
               from public.management_accounts ma
               join public.management_journal_lines jl on jl.account_id = ma.id
               join public.management_journal_entries je on je.id = jl.entry_id and je.status = 'posted'
              where ma.code = '190' or ma.code like '190.%'`,
          )
        : Promise.resolve({ rows: [{ vat_carry_190: "0.00" }] }),
    // 12. Open Payroll & Tax Accruals (0117 payroll_tax_accruals)
    () =>
      regRow.has_pta
        ? client.query<{
            id: string;
            period_ym: string;
            obligation_kind: string;
            due_date: string;
            open_amount: string;
            notes: string | null;
          }>(
            `select
               id::text,
               to_char(period_month, 'YYYY-MM') as period_ym,
               obligation_kind,
               to_char(due_date, 'YYYY-MM-DD') as due_date,
               greatest(0, accrued_amount - coalesce(paid_amount, 0))::numeric(14,2) as open_amount,
               notes
             from public.payroll_tax_accruals
             where is_paid = false
               and accrued_amount > coalesce(paid_amount, 0)
               and currency = $1
               and due_date between $2::date and $3::date
             order by due_date, id`,
            [currency, snapshotWeekStart, horizonEnd],
          )
        : Promise.resolve({
            rows: [] as Array<{
              id: string;
              period_ym: string;
              obligation_kind: string;
              due_date: string;
              open_amount: string;
              notes: string | null;
            }>,
          }),
    // 13. Unsettled POS Valor Batches (0117 pos_settlement_batches)
    () =>
      regRow.has_pos
        ? client.query<{
            id: string;
            pos_terminal_label: string;
            sale_date: string;
            expected_value_date: string;
            net_settlement_amount: string;
            account_name: string | null;
          }>(
            `select
               psb.id::text,
               psb.pos_terminal_label,
               to_char(psb.sale_date, 'YYYY-MM-DD') as sale_date,
               to_char(psb.expected_value_date, 'YYYY-MM-DD') as expected_value_date,
               psb.net_settlement_amount::numeric(14,2) as net_settlement_amount,
               ca.name as account_name
             from public.pos_settlement_batches psb
             left join public.cash_accounts ca on ca.id = psb.cash_account_id
             where psb.is_settled = false
               and psb.net_settlement_amount > 0
               and psb.currency = $1
               and psb.expected_value_date between $2::date and $3::date
             order by psb.expected_value_date, psb.id`,
            [currency, snapshotWeekStart, horizonEnd],
          )
        : Promise.resolve({
            rows: [] as Array<{
              id: string;
              pos_terminal_label: string;
              sale_date: string;
              expected_value_date: string;
              net_settlement_amount: string;
              account_name: string | null;
            }>,
          }),
    // 14. Unsettled Corporate Card Statements (0117 corporate_card_statements)
    () =>
      regRow.has_card
        ? client.query<{
            id: string;
            statement_ym: string;
            cutoff_date: string;
            due_date: string;
            remaining_amount: string;
            card_name: string | null;
          }>(
            `select
               ccs.id::text,
               to_char(ccs.statement_month, 'YYYY-MM') as statement_ym,
               to_char(ccs.cutoff_date, 'YYYY-MM-DD') as cutoff_date,
               to_char(ccs.due_date, 'YYYY-MM-DD') as due_date,
               greatest(0, ccs.statement_amount - coalesce(ccs.paid_amount, 0))::numeric(14,2) as remaining_amount,
               ca.name as card_name
             from public.corporate_card_statements ccs
             left join public.cash_accounts ca on ca.id = ccs.card_account_id
             where ccs.is_settled = false
               and ccs.statement_amount > coalesce(ccs.paid_amount, 0)
               and ccs.currency = $1
               and ccs.due_date between $2::date and $3::date
             order by ccs.due_date, ccs.id`,
            [currency, snapshotWeekStart, horizonEnd],
          )
        : Promise.resolve({
            rows: [] as Array<{
              id: string;
              statement_ym: string;
              cutoff_date: string;
              due_date: string;
              remaining_amount: string;
              card_name: string | null;
            }>,
          }),
  ]);

  const posRow = posRes.rows[0];
  const unknownOpeningCount = posRes.rowCount === 0 ? 0 : Number(posRow?.unknown_opening_count ?? 0);
  const openingCash: number | null =
    posRes.rowCount === 0
      ? 0
      : unknownOpeningCount > 0
        ? null
        : moneyOrNull(posRow?.available_now) ?? 0;

  const minCashFloor = floorRes.rowCount ? moneyOrNull(floorRes.rows[0]?.threshold_amount) : null;

  const seededLinesByWeek = new Map<number, Forecast13wSeededLine[]>();
  for (let w = 1; w <= 13; w += 1) {
    seededLinesByWeek.set(w, []);
  }

  const pushLine = (line: Omit<Forecast13wSeededLine, "weekIndex" | "weekStart">) => {
    const wIdx = weekIndexForDate(line.dueDate, snapshotWeekStart);
    if (wIdx === null) return;
    const wStart = addDaysISO(snapshotWeekStart, (wIdx - 1) * 7);
    seededLinesByWeek.get(wIdx)!.push({
      ...line,
      weekIndex: wIdx,
      weekStart: wStart,
      amount: money(decimal(line.amount).toString()),
    });
  };

  const overdueUnscheduledItems: OverdueUnscheduledReceivableItem[] = [];
  let overdueUnscheduledAmountDec = decimal(0);
  let doubtfulExcludedCount = 0;
  let doubtfulExcludedAmountDec = decimal(0);

  for (const r of arRes.rows) {
    const openAmt = moneyOrNull(r.open_amount) ?? 0;
    if (openAmt <= 0) continue;
    const rawSamples = Array.isArray(r.dbt_samples) ? r.dbt_samples : [];
    const partyDbtSamples = rawSamples
      .map((n) => intOrNull(n))
      .filter((n): n is number => n !== null);

    const signals: CollectionSignalsV2 = {
      dueDate: r.due_date,
      issueDate: r.issue_date,
      daysOverdue: intOrNull(r.days_overdue),
      openAmount: openAmt,
      badDebtFlagged: Boolean(r.bad_debt_flagged),
      partyAvgDaysToSettle: rateOrNull(r.party_avg_days_to_settle),
      partySettledCount: intOrNull(r.party_settled_count) ?? 0,
      partyLateRatio: rateOrNull(r.party_late_ratio),
      partyInvoiceCount: intOrNull(r.party_invoice_count) ?? 0,
      partiallySettled: Boolean(r.partially_settled),
      activePromiseDate: r.active_promise_date,
      partyDbtSamples,
    };

    const expected = expectedCollectionDateV2(signals, asOfDate, { mode: dbtMode });
    if (expected.bucket === "doubtful_excluded") {
      doubtfulExcludedCount += 1;
      doubtfulExcludedAmountDec = doubtfulExcludedAmountDec.plus(decimal(openAmt));
      continue;
    }
    if (expected.bucket === "overdue_unscheduled" || !expected.projectedDate) {
      overdueUnscheduledItems.push({
        invoiceId: r.invoice_id,
        invoiceNo: r.invoice_no,
        partyId: r.party_id,
        partyName: r.party_name ?? "(Müşteri)",
        dueDate: r.due_date,
        daysOverdue: intOrNull(r.days_overdue),
        openAmount: openAmt,
        currency,
      });
      overdueUnscheduledAmountDec = overdueUnscheduledAmountDec.plus(decimal(openAmt));
      continue;
    }

    const categoryBucket: Forecast13wCategoryBucket =
      expected.bucket === "behavioral_dbt" ? "behavioral_ar" : "contracted_ar";
    const sourceClassification: Forecast13wSourceClassification =
      expected.bucket === "promised"
        ? "promised"
        : expected.bucket === "behavioral_dbt"
          ? "behavioral_dbt"
          : "scheduled";

    pushLine({
      dueDate: expected.projectedDate,
      direction: "inflow",
      categoryBucket,
      sourceClassification,
      sourceEntityTable: "invoices",
      sourceEntityId: r.invoice_id,
      partyId: r.party_id,
      partyName: r.party_name,
      label: `Satış Faturası ${r.invoice_no} (${r.party_name ?? "Müşteri"})`,
      amount: openAmt,
    });
  }

  for (const ptp of ptpRes.rows) {
    const amt = moneyOrNull(ptp.promised_amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: ptp.promised_date,
      direction: "inflow",
      categoryBucket: "contracted_ar",
      sourceClassification: "promised",
      sourceEntityTable: "promise_to_pay",
      sourceEntityId: ptp.id,
      partyId: ptp.party_id,
      partyName: ptp.party_name,
      label: `Ödeme Sözü (${ptp.party_name ?? "Müşteri"})`,
      amount: amt,
    });
  }

  for (const pi of piRes.rows) {
    const amt = moneyOrNull(pi.remaining_amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: pi.due_date,
      direction: pi.direction === "inflow" ? "inflow" : "outflow",
      categoryBucket: "scheduled_payment",
      sourceClassification: "scheduled",
      sourceEntityTable: "payment_instances",
      sourceEntityId: pi.id,
      partyId: pi.party_id,
      partyName: pi.party_name,
      label: pi.party_name ? `${pi.label} (${pi.party_name})` : pi.label,
      amount: amt,
    });
  }

  for (const ap of apRes.rows) {
    const amt = moneyOrNull(ap.open_amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: ap.due_date,
      direction: "outflow",
      categoryBucket: "open_ap",
      sourceClassification: "scheduled",
      sourceEntityTable: "invoices",
      sourceEntityId: ap.id,
      partyId: ap.party_id,
      partyName: ap.party_name,
      label: `Alış Faturası ${ap.invoice_no} (${ap.party_name ?? "Tedarikçi"})`,
      amount: amt,
    });
  }

  for (const ch of checkRes.rows) {
    const amt = moneyOrNull(ch.amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: ch.maturity_date,
      direction: ch.direction === "inflow" ? "inflow" : "outflow",
      categoryBucket: "check_maturity",
      sourceClassification: "scheduled",
      sourceEntityTable: "checks",
      sourceEntityId: ch.id,
      partyId: ch.party_id,
      partyName: ch.party_name,
      label: `Çek/Senet Vadesi (${ch.party_name ?? "Muhatap"})`,
      amount: amt,
    });
  }

  for (const li of loanRes.rows) {
    const amt = moneyOrNull(li.remaining_amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: li.due_date,
      direction: "outflow",
      categoryBucket: "loan_installment",
      sourceClassification: "scheduled",
      sourceEntityTable: "loan_installments",
      sourceEntityId: li.id,
      partyId: li.party_id,
      partyName: li.party_name,
      label: `${li.loan_name} Taksit #${li.installment_no}`,
      amount: amt,
    });
  }

  let posBatchInflowDec = decimal(0);
  for (const pos of posBatchRes.rows) {
    const amt = moneyOrNull(pos.net_settlement_amount) ?? 0;
    if (amt <= 0) continue;
    posBatchInflowDec = posBatchInflowDec.plus(decimal(amt));
    pushLine({
      dueDate: pos.expected_value_date,
      direction: "inflow",
      categoryBucket: "contracted_ar",
      sourceClassification: "scheduled",
      sourceEntityTable: "pos_settlement_batches",
      sourceEntityId: pos.id,
      partyId: null,
      partyName: pos.account_name,
      label: pos.account_name
        ? `POS Valör Tahsilatı · ${pos.pos_terminal_label} (${pos.account_name})`
        : `POS Valör Tahsilatı · ${pos.pos_terminal_label}`,
      amount: amt,
    });
  }

  let corporateCardOutflowDec = decimal(0);
  for (const card of corpCardRes.rows) {
    const amt = moneyOrNull(card.remaining_amount) ?? 0;
    if (amt <= 0) continue;
    corporateCardOutflowDec = corporateCardOutflowDec.plus(decimal(amt));
    pushLine({
      dueDate: card.due_date,
      direction: "outflow",
      categoryBucket: "scheduled_payment",
      sourceClassification: "scheduled",
      sourceEntityTable: "corporate_card_statements",
      sourceEntityId: card.id,
      partyId: null,
      partyName: card.card_name,
      label: `Kurumsal Kart Ekstresi · ${card.card_name ?? "Kart"} (${card.statement_ym} · Kesim ${card.cutoff_date})`,
      amount: amt,
    });
  }

  const OBLIGATION_LABELS_TR: Record<string, string> = {
    NET_MAAS: "Personel Net Maaş Tahakkuku",
    MPHB_STOPAJ: "Muhtasar ve Prim Hizmet Beyannamesi (MPHB Stopaj)",
    SGK_4A: "4/A SGK İşçi + İşveren Prim Ödemesi",
    DAMGA_VERGISI: "Damga Vergisi Tahakkuku",
    KURUMLAR_GECICI_VERGI: "Kurumlar Geçici Vergi Tahakkuku",
  };
  let payrollTaxAccrualOutflowDec = decimal(0);
  for (const pta of payrollTaxRes.rows) {
    const amt = moneyOrNull(pta.open_amount) ?? 0;
    if (amt <= 0) continue;
    payrollTaxAccrualOutflowDec = payrollTaxAccrualOutflowDec.plus(decimal(amt));
    const kindLabel = OBLIGATION_LABELS_TR[pta.obligation_kind] ?? pta.obligation_kind;
    pushLine({
      dueDate: pta.due_date,
      direction: "outflow",
      categoryBucket: "statutory_tax_sgk",
      sourceClassification: "statutory_tax",
      sourceEntityTable: "payroll_tax_accruals",
      sourceEntityId: pta.id,
      partyId: null,
      partyName: pta.obligation_kind === "SGK_4A" ? "SGK" : pta.obligation_kind === "NET_MAAS" ? "Personel" : "GİB",
      label: pta.notes ? `${kindLabel} (${pta.period_ym}) · ${pta.notes}` : `${kindLabel} (${pta.period_ym})`,
      amount: amt,
    });
  }

  const vatCarry190Opening =
    currency === "TRY" ? money(decimal(vat190Res.rows[0]?.vat_carry_190 ?? 0).toString()) : 0;
  let vatCarry190AppliedDec = decimal(0);

  if (currency === "TRY" && statutoryDeadlines.length > 0) {
    const vatMap = new Map<string, { rawDiff: ReturnType<typeof decimal>; kdv2: number }>();
    for (const r of vatByPeriodRes.rows) {
      const salesVat = decimal(r.sales_vat ?? 0);
      const purchaseVat = decimal(r.purchase_vat ?? 0);
      const rawDiff = salesVat.minus(purchaseVat);
      const kdv2 = money(decimal(r.withheld_vat ?? 0).toString());
      vatMap.set(r.tax_period, { rawDiff, kdv2 });
    }

    let runningCarry190 = decimal(vatCarry190Opening);

    for (const ob of statutoryDeadlines) {
      const periodVat = vatMap.get(ob.taxPeriod);
      let taxAmount = 0;
      if (ob.code === "KDV_1" && periodVat) {
        if (periodVat.rawDiff.gt(0)) {
          const carryUsed = runningCarry190.gt(periodVat.rawDiff)
            ? periodVat.rawDiff
            : runningCarry190;
          const netPayableDec = periodVat.rawDiff.minus(carryUsed);
          runningCarry190 = runningCarry190.minus(carryUsed);
          vatCarry190AppliedDec = vatCarry190AppliedDec.plus(carryUsed);
          taxAmount = netPayableDec.gt(0) ? money(netPayableDec.toString()) : 0;
        } else if (periodVat.rawDiff.lt(0)) {
          runningCarry190 = runningCarry190.plus(periodVat.rawDiff.abs());
          taxAmount = 0;
        }
      } else if (ob.code === "KDV_2" && periodVat && periodVat.kdv2 > 0) {
        taxAmount = periodVat.kdv2;
      }
      if (taxAmount > 0) {
        pushLine({
          dueDate: ob.effectiveDueDate,
          direction: "outflow",
          categoryBucket: "statutory_tax_sgk",
          sourceClassification: "statutory_tax",
          sourceEntityTable: null,
          sourceEntityId: null,
          partyId: null,
          partyName: ob.authority,
          label: ob.label,
          amount: taxAmount,
        });
      }
    }
  }

  for (const m of manualRes.rows) {
    const amt = moneyOrNull(m.amount) ?? 0;
    if (amt <= 0) continue;
    pushLine({
      dueDate: m.period_start,
      direction: m.direction,
      categoryBucket: "manual_override",
      sourceClassification: "manual_override",
      sourceEntityTable: "forecast_lines",
      sourceEntityId: m.id,
      partyId: null,
      partyName: null,
      label: m.notes ? `${m.forecast_name}: ${m.notes}` : `${m.forecast_name} (Manuel Satır)`,
      amount: amt,
    });
  }

  // 11. Roll 13 weeks with Big decimal math
  const weeks: Forecast13wWeekBucket[] = [];
  let runningOpening = openingCash === null ? null : decimal(openingCash);
  let totalInflowDec = decimal(0);
  let totalOutflowDec = decimal(0);
  let worstWeekStart: string | null = null;
  let worstClosingDec: ReturnType<typeof decimal> | null = null;
  let firstFloorBreachWeekStart: string | null = null;

  for (let w = 1; w <= 13; w += 1) {
    const weekStart = addDaysISO(snapshotWeekStart, (w - 1) * 7);
    const weekEnd = addDaysISO(weekStart, 6);
    const lines = seededLinesByWeek.get(w) ?? [];

    const inflowByCat = emptyCategoryMap();
    const outflowByCat = emptyCategoryMap();
    let inflowDec = decimal(0);
    let outflowDec = decimal(0);

    for (const l of lines) {
      const amtDec = decimal(l.amount);
      if (l.direction === "inflow") {
        inflowDec = inflowDec.plus(amtDec);
        inflowByCat[l.categoryBucket] = money(
          decimal(inflowByCat[l.categoryBucket]).plus(amtDec).toString(),
        );
      } else {
        outflowDec = outflowDec.plus(amtDec);
        outflowByCat[l.categoryBucket] = money(
          decimal(outflowByCat[l.categoryBucket]).plus(amtDec).toString(),
        );
      }
    }

    const netDec = inflowDec.minus(outflowDec);
    totalInflowDec = totalInflowDec.plus(inflowDec);
    totalOutflowDec = totalOutflowDec.plus(outflowDec);

    const closingDec = runningOpening === null ? null : runningOpening.plus(netDec);
    const floorHeadroomDec =
      closingDec === null || minCashFloor === null ? null : closingDec.minus(decimal(minCashFloor));
    const breachesFloor =
      closingDec === null
        ? null
        : minCashFloor !== null
          ? closingDec.lt(decimal(minCashFloor))
          : closingDec.lt(0);

    if (closingDec !== null) {
      if (worstClosingDec === null || closingDec.lt(worstClosingDec)) {
        worstClosingDec = closingDec;
        worstWeekStart = weekStart;
      }
      if (breachesFloor && firstFloorBreachWeekStart === null) {
        firstFloorBreachWeekStart = weekStart;
      }
    }

    weeks.push({
      weekIndex: w,
      weekStart,
      weekEnd,
      openingBalance: runningOpening === null ? null : money(runningOpening.toString()),
      inflow: money(inflowDec.toString()),
      outflow: money(outflowDec.toString()),
      netFlow: money(netDec.toString()),
      closingBalance: closingDec === null ? null : money(closingDec.toString()),
      minCashFloor,
      floorHeadroom: floorHeadroomDec === null ? null : money(floorHeadroomDec.toString()),
      breachesFloor,
      inflowByCategory: inflowByCat,
      outflowByCategory: outflowByCat,
      lines,
    });

    runningOpening = closingDec;
  }

  const totalNetDec = totalInflowDec.minus(totalOutflowDec);

  return {
    asOfDate,
    snapshotWeekStart,
    horizonEnd,
    currency,
    openingCash,
    unknownOpeningCount,
    minCashFloor,
    totalInflow: money(totalInflowDec.toString()),
    totalOutflow: money(totalOutflowDec.toString()),
    totalNetFlow: money(totalNetDec.toString()),
    endingCash: runningOpening === null ? null : money(runningOpening.toString()),
    worstWeekStart,
    worstClosingBalance: worstClosingDec === null ? null : money(worstClosingDec.toString()),
    firstFloorBreachWeekStart,
    overdueUnscheduledCount: overdueUnscheduledItems.length,
    overdueUnscheduledAmount: money(overdueUnscheduledAmountDec.toString()),
    overdueUnscheduledItems,
    doubtfulExcludedCount,
    doubtfulExcludedAmount: money(doubtfulExcludedAmountDec.toString()),
    vatCarryforward190Opening: vatCarry190Opening,
    vatCarryforward190Applied: money(vatCarry190AppliedDec.toString()),
    posBatchInflowTotal: money(posBatchInflowDec.toString()),
    corporateCardOutflowTotal: money(corporateCardOutflowDec.toString()),
    payrollTaxAccrualOutflowTotal: money(payrollTaxAccrualOutflowDec.toString()),
    statutoryDeadlines,
    weeks,
  };
}

function isPool(p: Pool | PoolClient): p is Pool {
  return typeof (p as Pool).connect === "function" && typeof (p as PoolClient).release !== "function";
}

/**
 * Freezes the 13-week rolling cash forecast into `forecast_snapshots_13w` and
 * `forecast_snapshot_13w_lines` with entity-level lineage (`source_entity_table`, `source_entity_id`).
 */
export async function freezeWeekly13wSnapshot(
  poolOrClient: Pool | PoolClient,
  options: {
    asOfDate?: string;
    currency?: string;
    actor?: string | null;
    dbtMode?: "median" | "p75";
  } = {},
): Promise<FreezeWeekly13wSnapshotResult> {
  const runWithClient = async (client: PoolClient): Promise<FreezeWeekly13wSnapshotResult> => {
    let spSeq = 0;
    const savepointClient = {
      query: async (...args: Parameters<PoolClient["query"]>) => {
        const sp = `sp_13w_${++spSeq}`;
        await client.query(`savepoint ${sp}`);
        try {
          const out = await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
          await client.query(`release savepoint ${sp}`);
          return out;
        } catch (err) {
          await client.query(`rollback to savepoint ${sp}`).catch(() => {});
          await client.query(`release savepoint ${sp}`).catch(() => {});
          throw err;
        }
      },
    } as unknown as PoolClient;

    const forecast = await buildAutoSeeded13WeekForecast(savepointClient, {
      asOfDate: options.asOfDate,
      currency: options.currency,
      dbtMode: options.dbtMode,
    });

    const snapRes = await client.query<{ id: string }>(
      `insert into public.forecast_snapshots_13w (
         snapshot_week_start,
         as_of_date,
         currency,
         opening_cash,
         unknown_opening_count,
         frozen_by,
         frozen_at
       )
       values ($1::date, $2::date, $3, $4, $5, $6, now())
       on conflict (snapshot_week_start, currency) do update
         set as_of_date = excluded.as_of_date,
             opening_cash = excluded.opening_cash,
             unknown_opening_count = excluded.unknown_opening_count,
             frozen_by = coalesce(excluded.frozen_by, public.forecast_snapshots_13w.frozen_by),
             frozen_at = now()
       returning id`,
      [
        forecast.snapshotWeekStart,
        forecast.asOfDate,
        forecast.currency,
        forecast.openingCash,
        forecast.unknownOpeningCount,
        options.actor ?? null,
      ],
    );
    const snapshotId = snapRes.rows[0].id;

    await client.query(
      `delete from public.forecast_snapshot_13w_lines where snapshot_id = $1`,
      [snapshotId],
    );

    let lineCount = 0;
    for (const w of forecast.weeks) {
      for (const line of w.lines) {
        await client.query(
          `insert into public.forecast_snapshot_13w_lines (
             snapshot_id,
             week_index,
             week_start,
             direction,
             category_bucket,
             source_classification,
             source_entity_table,
             source_entity_id,
             party_id,
             label,
             amount
           )
           values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            snapshotId,
            w.weekIndex,
            w.weekStart,
            line.direction,
            line.categoryBucket,
            line.sourceClassification,
            line.sourceEntityTable,
            line.sourceEntityId,
            line.partyId,
            line.label,
            line.amount,
          ],
        );
        lineCount += 1;
      }
    }

    await audit(client, {
      actor: options.actor ?? "system",
      action: "freeze_forecast_13w_snapshot",
      entityTable: "forecast_snapshots_13w",
      entityId: snapshotId,
      after: {
        snapshotWeekStart: forecast.snapshotWeekStart,
        asOfDate: forecast.asOfDate,
        currency: forecast.currency,
        openingCash: forecast.openingCash,
        unknownOpeningCount: forecast.unknownOpeningCount,
        lineCount,
        totalInflow: forecast.totalInflow,
        totalOutflow: forecast.totalOutflow,
        totalNetFlow: forecast.totalNetFlow,
      },
    });

    return {
      snapshotId,
      snapshotWeekStart: forecast.snapshotWeekStart,
      asOfDate: forecast.asOfDate,
      currency: forecast.currency,
      openingCash: forecast.openingCash,
      unknownOpeningCount: forecast.unknownOpeningCount,
      lineCount,
      totalInflow: forecast.totalInflow,
      totalOutflow: forecast.totalOutflow,
      totalNetFlow: forecast.totalNetFlow,
    };
  };

  if (isPool(poolOrClient)) {
    const client = await poolOrClient.connect();
    try {
      await client.query("begin");
      const res = await runWithClient(client);
      await client.query("commit");
      return res;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  return runWithClient(poolOrClient);
}

/**
 * Computes the Timing-Slip vs. Permanent-Variance Waterfall for a frozen 13-week snapshot week.
 *
 * Guarantees exact `Big` arithmetic identity:
 *   `Forecast Net + Timing Slip + Permanent Inflow Variance + Permanent Outflow Variance === Actual Bank Net Movement`
 */
export async function compute13wVarianceWaterfall(
  client: Queryable,
  input: {
    snapshotId: string;
    weekStart: string;
  },
): Promise<VarianceWaterfallResult> {
  const snapRes = await client.query<{
    id: string;
    snapshot_week_start: string;
    currency: string;
  }>(
    `select id::text, to_char(snapshot_week_start, 'YYYY-MM-DD') as snapshot_week_start, currency
       from public.forecast_snapshots_13w
      where id = $1`,
    [input.snapshotId],
  );
  if (snapRes.rowCount === 0) {
    throw new DomainError("NOT_FOUND", "13 haftalık tahmin anlık görüntüsü bulunamadı.");
  }
  const snap = snapRes.rows[0];
  const weekStart = input.weekStart;
  const weekEnd = addDaysISO(weekStart, 6);
  const weekIndex = weekIndexForDate(weekStart, snap.snapshot_week_start) ?? 1;

  // 1. Frozen forecast lines for (snapshotId, weekStart)
  const linesRes = await client.query<{
    id: string;
    week_index: number;
    direction: "inflow" | "outflow";
    category_bucket: string;
    source_classification: string;
    source_entity_table: string | null;
    source_entity_id: string | null;
    party_id: string | null;
    label: string;
    amount: string;
  }>(
    `select
       id::text,
       week_index,
       direction,
       category_bucket,
       source_classification,
       source_entity_table,
       source_entity_id::text,
       party_id::text,
       label,
       amount
     from public.forecast_snapshot_13w_lines
     where snapshot_id = $1
       and week_start = $2::date
     order by direction desc, amount desc, id`,
    [input.snapshotId, weekStart],
  );

  // 2. Actual bank transactions in [weekStart, weekEnd] excluding 'own_transfer' and 'ignored'
  const bankRes = await client.query<{
    id: string;
    txn_date: string;
    amount: string;
    description: string | null;
    counterparty_name: string | null;
    matched_entity_table: string | null;
    matched_entity_id: string | null;
    settled_allocation_id: string | null;
    allocation_invoice_id: string | null;
    run_item_target_type: string | null;
    run_item_target_id: string | null;
  }>(
    `select
       bt.id::text,
       to_char(bt.txn_date, 'YYYY-MM-DD') as txn_date,
       bt.amount,
       bt.description,
       bt.counterparty_name_raw as counterparty_name,
       bt.matched_entity_table,
       bt.matched_entity_id::text,
       bt.settled_allocation_id::text,
       ia.invoice_id::text as allocation_invoice_id,
       pri.target_type as run_item_target_type,
       pri.target_id::text as run_item_target_id
     from public.bank_transactions bt
     left join public.invoice_allocations ia
       on ia.id = bt.settled_allocation_id
      and ia.reversed_at is null
     left join lateral (
       select p.target_type, p.target_id
         from public.payment_run_items p
        where p.settled_bank_tx_id = bt.id
        order by p.created_at asc
        limit 1
     ) pri on true
     where bt.txn_date between $1::date and $2::date
       and bt.currency = $3
       and bt.status <> 'ignored'
       and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
     order by bt.txn_date, bt.id`,
    [weekStart, weekEnd, snap.currency],
  );

  // Also fetch same-week invoice_allocations for invoices in frozen lines (in case settled_allocation_id was not populated on bt)
  const sameWeekAllocRes = await client.query<{
    invoice_id: string;
    allocated_amount: string;
  }>(
    `select
       ia.invoice_id::text,
       coalesce(sum(ia.allocated_amount), 0)::numeric(14,2) as allocated_amount
     from public.invoice_allocations ia
     where ia.reversed_at is null
       and ia.allocated_on between $1::date and $2::date
     group by ia.invoice_id`,
    [weekStart, weekEnd],
  );
  const sameWeekAllocByInvoice = new Map<string, number>(
    sameWeekAllocRes.rows.map((r) => [r.invoice_id, moneyOrNull(r.allocated_amount) ?? 0]),
  );

  const usedBankTxIds = new Set<string>();
  const matchedBankByLineId = new Map<string, { bankTxId: string; actualSigned: ReturnType<typeof decimal> }>();

  const targetTypeToTable = (t: string | null): string | null => {
    if (t === "invoice") return "invoices";
    if (t === "payment_instance") return "payment_instances";
    if (t === "check") return "checks";
    if (t === "loan_installment") return "loan_installments";
    return null;
  };

  // Pass 1: Direct FK / settlement links (matched_payment_instance_id, settled_allocation_id, payment_run_items)
  for (const line of linesRes.rows) {
    if (!line.source_entity_table || !line.source_entity_id) continue;
    for (const bt of bankRes.rows) {
      if (usedBankTxIds.has(bt.id)) continue;
      const btAmt = decimal(bt.amount ?? 0);
      const sameDir =
        (line.direction === "inflow" && btAmt.gt(0)) || (line.direction === "outflow" && btAmt.lt(0));
      if (!sameDir) continue;

      const directEntity =
        bt.matched_entity_table === line.source_entity_table &&
        bt.matched_entity_id === line.source_entity_id;
      const directInv =
        line.source_entity_table === "invoices" && bt.allocation_invoice_id === line.source_entity_id;
      const directRunItem =
        targetTypeToTable(bt.run_item_target_type) === line.source_entity_table &&
        bt.run_item_target_id === line.source_entity_id;

      if (directEntity || directInv || directRunItem) {
        usedBankTxIds.add(bt.id);
        matchedBankByLineId.set(line.id, { bankTxId: bt.id, actualSigned: btAmt });
        break;
      }
    }
  }

  // Pass 2: Same-week invoice allocation or explicit entity ID/reference mention in bank_transactions.description
  for (const line of linesRes.rows) {
    if (matchedBankByLineId.has(line.id)) continue;
    if (!line.source_entity_table || !line.source_entity_id) continue;

    const hasSameWeekAlloc =
      line.source_entity_table === "invoices" &&
      (sameWeekAllocByInvoice.get(line.source_entity_id) ?? 0) > 0;

    for (const bt of bankRes.rows) {
      if (usedBankTxIds.has(bt.id)) continue;
      const btAmt = decimal(bt.amount ?? 0);
      const sameDir =
        (line.direction === "inflow" && btAmt.gt(0)) || (line.direction === "outflow" && btAmt.lt(0));
      if (!sameDir) continue;

      const desc = `${bt.description ?? ""} ${bt.counterparty_name ?? ""}`.toLowerCase();
      const mentionsId = desc.includes(line.source_entity_id.toLowerCase());
      if (mentionsId || hasSameWeekAlloc) {
        usedBankTxIds.add(bt.id);
        matchedBankByLineId.set(line.id, { bankTxId: bt.id, actualSigned: btAmt });
        break;
      }
    }
  }

  // Helper to check if an unmatched frozen line's source entity is still open or settled in another week
  const isEntityTimingSlip = async (
    entityTable: string | null,
    entityId: string | null,
  ): Promise<{ isTimingSlip: boolean; reason: string }> => {
    if (!entityTable || !entityId) {
      return {
        isTimingSlip: false,
        reason: "Belge bağlantısız / manuel tahmin satırı gerçekleşmedi (kalıcı sapma)",
      };
    }

    if (entityTable === "invoices") {
      const r = await client.query<{
        status: string;
        bad_debt_at: string | null;
        latest_alloc_on: string | null;
      }>(
        `select
           i.status,
           i.bad_debt_at::text,
           (select to_char(max(ia.allocated_on), 'YYYY-MM-DD')
              from public.invoice_allocations ia
             where ia.invoice_id = i.id and ia.reversed_at is null) as latest_alloc_on
         from public.invoices i
         where i.id = $1`,
        [entityId],
      );
      if (r.rowCount === 0) {
        return { isTimingSlip: false, reason: "Kaynak fatura silinmiş (kalıcı sapma)" };
      }
      const inv = r.rows[0];
      if (inv.status === "cancelled" || inv.bad_debt_at !== null) {
        return {
          isTimingSlip: false,
          reason: inv.bad_debt_at
            ? "Fatura şüpheli alacak olarak işaretlendi (kalıcı sapma)"
            : "Fatura iptal edildi (kalıcı sapma)",
        };
      }
      if (inv.status === "open" || inv.status === "partial") {
        return {
          isTimingSlip: true,
          reason: "Fatura hâlâ açık; tahsilat/ödeme sonraki haftaya sarktı (zamanlama kayması)",
        };
      }
      return {
        isTimingSlip: true,
        reason: `Fatura farklı bir haftada (${inv.latest_alloc_on ?? "başka hafta"}) kapandı (zamanlama kayması)`,
      };
    }

    if (entityTable === "payment_instances") {
      const r = await client.query<{ status: string }>(
        `select status from public.payment_instances where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0 || r.rows[0].status === "cancelled") {
        return { isTimingSlip: false, reason: "Planlı ödeme iptal edildi (kalıcı sapma)" };
      }
      return {
        isTimingSlip: true,
        reason:
          r.rows[0].status === "paid"
            ? "Planlı ödeme farklı bir haftada ödendi (zamanlama kayması)"
            : "Planlı ödeme hâlâ açık / sonraki haftaya ertelendi (zamanlama kayması)",
      };
    }

    if (entityTable === "checks") {
      const r = await client.query<{ status: string }>(
        `select status from public.checks where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0 || r.rows[0].status === "cancelled" || r.rows[0].status === "bounced") {
        return {
          isTimingSlip: false,
          reason: "Çek/senet iptal edildi veya karşılıksız çıktı (kalıcı sapma)",
        };
      }
      return {
        isTimingSlip: true,
        reason: "Çek/senet hâlâ portföyde/tahsilde veya farklı haftada tahsil edildi (zamanlama kayması)",
      };
    }

    if (entityTable === "loan_installments") {
      const r = await client.query<{ status: string }>(
        `select status from public.loan_installments where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0 || r.rows[0].status === "cancelled") {
        return { isTimingSlip: false, reason: "Kredi taksiti iptal edildi (kalıcı sapma)" };
      }
      return {
        isTimingSlip: true,
        reason: "Kredi taksiti hâlâ açık veya farklı haftada ödendi (zamanlama kayması)",
      };
    }

    if (entityTable === "promise_to_pay") {
      const r = await client.query<{ status: string }>(
        `select status from public.promise_to_pay where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0 || r.rows[0].status === "cancelled" || r.rows[0].status === "broken") {
        return {
          isTimingSlip: true,
          reason: "Ödeme sözü kırıldı veya ertelendi; alacak hâlâ açık (zamanlama kayması)",
        };
      }
      return {
        isTimingSlip: true,
        reason: "Ödeme sözü hâlâ açık veya farklı haftada gerçekleşti (zamanlama kayması)",
      };
    }

    if (entityTable === "pos_settlement_batches") {
      const r = await client.query<{ is_settled: boolean }>(
        `select is_settled from public.pos_settlement_batches where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0) {
        return { isTimingSlip: false, reason: "POS valör partisi silinmiş (kalıcı sapma)" };
      }
      return {
        isTimingSlip: true,
        reason: r.rows[0].is_settled
          ? "POS valör partisi farklı bir haftada hesaba geçti (zamanlama kayması)"
          : "POS valör partisi henüz hesaba geçmedi; sonraki haftaya sarktı (zamanlama kayması)",
      };
    }

    if (entityTable === "corporate_card_statements") {
      const r = await client.query<{ is_settled: boolean }>(
        `select is_settled from public.corporate_card_statements where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0) {
        return { isTimingSlip: false, reason: "Kurumsal kart ekstresi silinmiş (kalıcı sapma)" };
      }
      return {
        isTimingSlip: true,
        reason: r.rows[0].is_settled
          ? "Kurumsal kart ekstresi farklı bir haftada ödendi (zamanlama kayması)"
          : "Kurumsal kart ekstresi hâlâ açık / sonraki haftaya sarktı (zamanlama kayması)",
      };
    }

    if (entityTable === "payroll_tax_accruals") {
      const r = await client.query<{ is_paid: boolean }>(
        `select is_paid from public.payroll_tax_accruals where id = $1`,
        [entityId],
      );
      if (r.rowCount === 0) {
        return { isTimingSlip: false, reason: "Vergi/SGK/bordro tahakkuk kaydı silinmiş (kalıcı sapma)" };
      }
      return {
        isTimingSlip: true,
        reason: r.rows[0].is_paid
          ? "Vergi/SGK/bordro tahakkuku farklı bir haftada ödendi (zamanlama kayması)"
          : "Vergi/SGK/bordro tahakkuku hâlâ açık / sonraki haftaya sarktı (zamanlama kayması)",
      };
    }

    return {
      isTimingSlip: false,
      reason: "Manuel tahmin satırı bu hafta gerçekleşmedi (kalıcı sapma)",
    };
  };

  let forecastInflowDec = decimal(0);
  let forecastOutflowDec = decimal(0);
  let timingSlipDec = decimal(0);
  let permInflowDec = decimal(0);
  let permOutflowDec = decimal(0);

  const details: VarianceWaterfallLineDetail[] = [];

  for (const line of linesRes.rows) {
    const amtDec = decimal(line.amount ?? 0);
    if (line.direction === "inflow") {
      forecastInflowDec = forecastInflowDec.plus(amtDec);
    } else {
      forecastOutflowDec = forecastOutflowDec.plus(amtDec);
    }
    const forecastSigned = line.direction === "inflow" ? amtDec : amtDec.times(-1);
    const matched = matchedBankByLineId.get(line.id);

    if (matched) {
      const diffSigned = matched.actualSigned.minus(forecastSigned);
      const permIn = line.direction === "inflow" ? diffSigned : decimal(0);
      const permOut = line.direction === "outflow" ? diffSigned : decimal(0);
      permInflowDec = permInflowDec.plus(permIn);
      permOutflowDec = permOutflowDec.plus(permOut);

      details.push({
        kind: "matched_settled",
        direction: line.direction,
        label: line.label,
        sourceEntityTable: line.source_entity_table,
        sourceEntityId: line.source_entity_id,
        bankTransactionId: matched.bankTxId,
        forecastSignedAmount: money(forecastSigned.toString()),
        actualSignedAmount: money(matched.actualSigned.toString()),
        timingSlipSignedAmount: 0,
        permanentInflowVarianceSigned: money(permIn.toString()),
        permanentOutflowVarianceSigned: money(permOut.toString()),
        explanation: diffSigned.eq(0)
          ? "Tahmin edilen tutarda zamanında gerçekleşti"
          : `Zamanında gerçekleşti ancak tutar farkı oluştu (${money(diffSigned.toString())} ${snap.currency})`,
      });
    } else {
      const verdict = await isEntityTimingSlip(line.source_entity_table, line.source_entity_id);
      const deltaSigned = forecastSigned.times(-1); // 0 - forecastSigned
      if (verdict.isTimingSlip) {
        timingSlipDec = timingSlipDec.plus(deltaSigned);
        details.push({
          kind: "timing_slip",
          direction: line.direction,
          label: line.label,
          sourceEntityTable: line.source_entity_table,
          sourceEntityId: line.source_entity_id,
          bankTransactionId: null,
          forecastSignedAmount: money(forecastSigned.toString()),
          actualSignedAmount: 0,
          timingSlipSignedAmount: money(deltaSigned.toString()),
          permanentInflowVarianceSigned: 0,
          permanentOutflowVarianceSigned: 0,
          explanation: verdict.reason,
        });
      } else {
        const permIn = line.direction === "inflow" ? deltaSigned : decimal(0);
        const permOut = line.direction === "outflow" ? deltaSigned : decimal(0);
        permInflowDec = permInflowDec.plus(permIn);
        permOutflowDec = permOutflowDec.plus(permOut);
        details.push({
          kind: "permanent_cancelled",
          direction: line.direction,
          label: line.label,
          sourceEntityTable: line.source_entity_table,
          sourceEntityId: line.source_entity_id,
          bankTransactionId: null,
          forecastSignedAmount: money(forecastSigned.toString()),
          actualSignedAmount: 0,
          timingSlipSignedAmount: 0,
          permanentInflowVarianceSigned: money(permIn.toString()),
          permanentOutflowVarianceSigned: money(permOut.toString()),
          explanation: verdict.reason,
        });
      }
    }
  }

  // Unmatched actual bank transactions in [weekStart, weekEnd] -> unplanned permanent variance
  let actualInflowDec = decimal(0);
  let actualOutflowDec = decimal(0);

  for (const bt of bankRes.rows) {
    const btSigned = decimal(bt.amount ?? 0);
    if (btSigned.gt(0)) {
      actualInflowDec = actualInflowDec.plus(btSigned);
    } else if (btSigned.lt(0)) {
      actualOutflowDec = actualOutflowDec.plus(btSigned.abs());
    }

    if (usedBankTxIds.has(bt.id)) continue;

    const dir: "inflow" | "outflow" = btSigned.gte(0) ? "inflow" : "outflow";
    const permIn = dir === "inflow" ? btSigned : decimal(0);
    const permOut = dir === "outflow" ? btSigned : decimal(0);
    permInflowDec = permInflowDec.plus(permIn);
    permOutflowDec = permOutflowDec.plus(permOut);

    details.push({
      kind: "unplanned_bank_movement",
      direction: dir,
      label: bt.description || bt.counterparty_name || "Plansız Banka Hareketi",
      sourceEntityTable: null,
      sourceEntityId: null,
      bankTransactionId: bt.id,
      forecastSignedAmount: 0,
      actualSignedAmount: money(btSigned.toString()),
      timingSlipSignedAmount: 0,
      permanentInflowVarianceSigned: money(permIn.toString()),
      permanentOutflowVarianceSigned: money(permOut.toString()),
      explanation:
        dir === "inflow"
          ? "Dondurulmuş tahminde yer almayan plansız banka girişi (kalıcı giriş sapması)"
          : "Dondurulmuş tahminde yer almayan plansız banka çıkışı (kalıcı çıkış sapması)",
    });
  }

  const forecastNetDec = forecastInflowDec.minus(forecastOutflowDec);
  const actualNetDec = actualInflowDec.minus(actualOutflowDec);
  const totalNetVarianceDec = actualNetDec.minus(forecastNetDec);
  const permTotalDec = permInflowDec.plus(permOutflowDec);

  // Verify exact waterfall identity:
  // Forecast Net + Timing Slip + Permanent Inflow Variance + Permanent Outflow Variance === Actual Bank Net Movement
  const reconstructedActualDec = forecastNetDec
    .plus(timingSlipDec)
    .plus(permInflowDec)
    .plus(permOutflowDec);
  const identityDiffDec = actualNetDec.minus(reconstructedActualDec);
  const identityBalanced = identityDiffDec.eq(0);

  return {
    snapshotId: input.snapshotId,
    currency: snap.currency,
    weekIndex,
    weekStart,
    weekEnd,
    forecastInflow: money(forecastInflowDec.toString()),
    forecastOutflow: money(forecastOutflowDec.toString()),
    forecastNet: money(forecastNetDec.toString()),
    actualBankInflow: money(actualInflowDec.toString()),
    actualBankOutflow: money(actualOutflowDec.toString()),
    actualBankNetMovement: money(actualNetDec.toString()),
    totalNetVariance: money(totalNetVarianceDec.toString()),
    timingSlipAmount: money(timingSlipDec.toString()),
    permanentInflowVarianceAmount: money(permInflowDec.toString()),
    permanentOutflowVarianceAmount: money(permOutflowDec.toString()),
    permanentVarianceAmount: money(permTotalDec.toString()),
    identityBalanced,
    identityDiff: money(identityDiffDec.toString()),
    details,
  };
}

/**
 * Lists frozen 13-week snapshots for the UI selector.
 */
export async function listFrozen13wSnapshots(
  client: Queryable,
  currency?: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    snapshotWeekStart: string;
    asOfDate: string;
    currency: string;
    openingCash: number | null;
    unknownOpeningCount: number;
    frozenAt: string;
    lineCount: number;
  }>
> {
  const res = await client.query<{
    id: string;
    snapshot_week_start: string;
    as_of_date: string;
    currency: string;
    opening_cash: string | null;
    unknown_opening_count: number;
    frozen_at: string;
    line_count: number;
  }>(
    `select
       fs.id::text,
       to_char(fs.snapshot_week_start, 'YYYY-MM-DD') as snapshot_week_start,
       to_char(fs.as_of_date, 'YYYY-MM-DD') as as_of_date,
       fs.currency,
       fs.opening_cash,
       fs.unknown_opening_count,
       fs.frozen_at::text,
       count(l.id)::int as line_count
     from public.forecast_snapshots_13w fs
     left join public.forecast_snapshot_13w_lines l on l.snapshot_id = fs.id
     where ($1::text is null or fs.currency = $1)
     group by fs.id
     order by fs.snapshot_week_start desc, fs.frozen_at desc
     limit $2`,
    [currency ?? null, limit],
  ).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42P01") return { rows: [] };
    throw err;
  });
  return res.rows.map((r) => ({
    id: r.id,
    snapshotWeekStart: r.snapshot_week_start,
    asOfDate: r.as_of_date,
    currency: r.currency,
    openingCash: moneyOrNull(r.opening_cash),
    unknownOpeningCount: Number(r.unknown_opening_count ?? 0),
    frozenAt: r.frozen_at,
    lineCount: Number(r.line_count ?? 0),
  }));
}

export interface UnconvertibleFxExposure {
  currency: string;
  openingCash: number | null;
  totalInflow: number;
  totalOutflow: number;
  unknownOpeningCount: number;
}

export interface Consolidated13WeekForecastResult {
  forecast: AutoSeeded13WeekForecast;
  fxRatesUsed: Record<string, { rate: number; rateDate: string }>;
  unconvertibleFx: UnconvertibleFxExposure[];
}

/**
 * Builds a Consolidated TRY-Equivalent 13-week rolling forecast across active currencies
 * using the latest `fx_rate_snapshots` (`quote_currency = 'TRY'`).
 * Foreign currencies without a valid TCMB/snapshot FX rate are NEVER coerced to 1:1;
 * they are excluded from the TRY rollup and surfaced explicitly in `unconvertibleFx`.
 */
export async function buildConsolidated13WeekForecast(
  client: Queryable,
  options: {
    asOfDate?: string;
    dbtMode?: "median" | "p75";
  } = {},
): Promise<Consolidated13WeekForecastResult> {
  if (isPgPool(client)) {
    return withPinnedRead(client, (pinned) => buildConsolidated13WeekForecast(pinned, options));
  }

  const [currenciesRes, fxRes] = await gather(client, [
    () =>
      client
        .query<{ currency: string }>(
          `select distinct currency
             from public.treasury_position_summary
            where currency is not null and currency ~ '^[A-Z]{3}$'`,
        )
        .catch(() => ({ rows: [] as Array<{ currency: string }> })),
    () =>
      client
        .query<{ base_currency: string; rate: string; rate_date: string }>(
          `select distinct on (base_currency)
             base_currency,
             rate::numeric(14,6)::text as rate,
             to_char(rate_date, 'YYYY-MM-DD') as rate_date
           from public.fx_rate_snapshots
           where quote_currency = 'TRY'
             and rate > 0
           order by base_currency, rate_date desc, fetched_at desc`,
        )
        .catch(() => ({
          rows: [] as Array<{ base_currency: string; rate: string; rate_date: string }>,
        })),
  ]);

  const currencySet = new Set<string>(["TRY", "USD", "EUR"]);
  for (const r of currenciesRes.rows) {
    if (r.currency) currencySet.add(r.currency.toUpperCase());
  }
  const currencies = ["TRY", ...Array.from(currencySet).filter((c) => c !== "TRY").sort()];

  const fxMap = new Map<string, { rateStr: string; rateNum: number; rateDate: string }>();
  for (const r of fxRes.rows) {
    const rateNum = rateOrNull(r.rate);
    if (rateNum !== null && rateNum > 0) {
      fxMap.set(r.base_currency.toUpperCase(), {
        rateStr: r.rate,
        rateNum,
        rateDate: r.rate_date,
      });
    }
  }

  const baseTry = await buildAutoSeeded13WeekForecast(client, {
    asOfDate: options.asOfDate,
    currency: "TRY",
    dbtMode: options.dbtMode,
  });

  const fxRatesUsed: Record<string, { rate: number; rateDate: string }> = {};
  const unconvertibleFx: UnconvertibleFxExposure[] = [];

  let unknownOpeningCount = baseTry.unknownOpeningCount;
  let openingCashDec: ReturnType<typeof decimal> | null =
    baseTry.openingCash === null ? null : decimal(baseTry.openingCash);
  const minCashFloor = baseTry.minCashFloor;

  const mergedLinesByWeek = new Map<number, Forecast13wSeededLine[]>();
  for (const w of baseTry.weeks) {
    mergedLinesByWeek.set(
      w.weekIndex,
      w.lines.map((l) => ({ ...l })),
    );
  }

  const overdueItems: OverdueUnscheduledReceivableItem[] = [...baseTry.overdueUnscheduledItems];
  let overdueAmountDec = decimal(baseTry.overdueUnscheduledAmount);
  let doubtfulCount = baseTry.doubtfulExcludedCount;
  let doubtfulAmountDec = decimal(baseTry.doubtfulExcludedAmount);
  let posInflowDec = decimal(baseTry.posBatchInflowTotal ?? 0);
  let cardOutflowDec = decimal(baseTry.corporateCardOutflowTotal ?? 0);
  let ptaOutflowDec = decimal(baseTry.payrollTaxAccrualOutflowTotal ?? 0);

  for (const cur of currencies) {
    if (cur === "TRY") continue;
    const fc = await buildAutoSeeded13WeekForecast(client, {
      asOfDate: options.asOfDate,
      currency: cur,
      dbtMode: options.dbtMode,
    });

    const hasExposure =
      (fc.openingCash !== null && fc.openingCash !== 0) ||
      fc.unknownOpeningCount > 0 ||
      fc.totalInflow > 0 ||
      fc.totalOutflow > 0 ||
      fc.overdueUnscheduledAmount > 0;

    if (!hasExposure) continue;

    const fx = fxMap.get(cur);
    if (!fx) {
      unconvertibleFx.push({
        currency: cur,
        openingCash: fc.openingCash,
        totalInflow: fc.totalInflow,
        totalOutflow: fc.totalOutflow,
        unknownOpeningCount: fc.unknownOpeningCount,
      });
      continue;
    }

    fxRatesUsed[cur] = { rate: fx.rateNum, rateDate: fx.rateDate };
    const rateDec = decimal(fx.rateStr);

    if (fc.unknownOpeningCount > 0 || fc.openingCash === null) {
      unknownOpeningCount += Math.max(1, fc.unknownOpeningCount);
      openingCashDec = null;
    } else if (openingCashDec !== null) {
      openingCashDec = openingCashDec.plus(decimal(fc.openingCash).times(rateDec));
    }

    for (const item of fc.overdueUnscheduledItems) {
      const convOpen = money(decimal(item.openAmount).times(rateDec).toString());
      overdueItems.push({
        ...item,
        invoiceNo: `${item.invoiceNo} [${cur}]`,
        openAmount: convOpen,
        currency: "TRY",
      });
      overdueAmountDec = overdueAmountDec.plus(decimal(convOpen));
    }

    doubtfulCount += fc.doubtfulExcludedCount;
    doubtfulAmountDec = doubtfulAmountDec.plus(decimal(fc.doubtfulExcludedAmount).times(rateDec));
    posInflowDec = posInflowDec.plus(decimal(fc.posBatchInflowTotal ?? 0).times(rateDec));
    cardOutflowDec = cardOutflowDec.plus(decimal(fc.corporateCardOutflowTotal ?? 0).times(rateDec));
    ptaOutflowDec = ptaOutflowDec.plus(decimal(fc.payrollTaxAccrualOutflowTotal ?? 0).times(rateDec));

    for (const w of fc.weeks) {
      const targetLines = mergedLinesByWeek.get(w.weekIndex) ?? [];
      for (const l of w.lines) {
        const convAmt = money(decimal(l.amount).times(rateDec).toString());
        if (convAmt <= 0) continue;
        targetLines.push({
          ...l,
          label: `${l.label} [${cur} @ ${fx.rateNum}]`,
          amount: convAmt,
        });
      }
      mergedLinesByWeek.set(w.weekIndex, targetLines);
    }
  }

  const openingCash: number | null =
    openingCashDec === null ? null : money(openingCashDec.toString());
  let runningOpening = openingCash === null ? null : decimal(openingCash);
  let totalInflowDec = decimal(0);
  let totalOutflowDec = decimal(0);
  let worstWeekStart: string | null = null;
  let worstClosingDec: ReturnType<typeof decimal> | null = null;
  let firstFloorBreachWeekStart: string | null = null;
  const weeks: Forecast13wWeekBucket[] = [];

  for (let w = 1; w <= 13; w += 1) {
    const weekStart = addDaysISO(baseTry.snapshotWeekStart, (w - 1) * 7);
    const weekEnd = addDaysISO(weekStart, 6);
    const lines = mergedLinesByWeek.get(w) ?? [];

    const inflowByCat = emptyCategoryMap();
    const outflowByCat = emptyCategoryMap();
    let inflowDec = decimal(0);
    let outflowDec = decimal(0);

    for (const l of lines) {
      const amtDec = decimal(l.amount);
      if (l.direction === "inflow") {
        inflowDec = inflowDec.plus(amtDec);
        inflowByCat[l.categoryBucket] = money(
          decimal(inflowByCat[l.categoryBucket]).plus(amtDec).toString(),
        );
      } else {
        outflowDec = outflowDec.plus(amtDec);
        outflowByCat[l.categoryBucket] = money(
          decimal(outflowByCat[l.categoryBucket]).plus(amtDec).toString(),
        );
      }
    }

    const netDec = inflowDec.minus(outflowDec);
    totalInflowDec = totalInflowDec.plus(inflowDec);
    totalOutflowDec = totalOutflowDec.plus(outflowDec);

    const closingDec = runningOpening === null ? null : runningOpening.plus(netDec);
    const floorHeadroomDec =
      closingDec === null || minCashFloor === null ? null : closingDec.minus(decimal(minCashFloor));
    const breachesFloor =
      closingDec === null
        ? null
        : minCashFloor !== null
          ? closingDec.lt(decimal(minCashFloor))
          : closingDec.lt(0);

    if (closingDec !== null) {
      if (worstClosingDec === null || closingDec.lt(worstClosingDec)) {
        worstClosingDec = closingDec;
        worstWeekStart = weekStart;
      }
      if (breachesFloor && firstFloorBreachWeekStart === null) {
        firstFloorBreachWeekStart = weekStart;
      }
    }

    weeks.push({
      weekIndex: w,
      weekStart,
      weekEnd,
      openingBalance: runningOpening === null ? null : money(runningOpening.toString()),
      inflow: money(inflowDec.toString()),
      outflow: money(outflowDec.toString()),
      netFlow: money(netDec.toString()),
      closingBalance: closingDec === null ? null : money(closingDec.toString()),
      minCashFloor,
      floorHeadroom: floorHeadroomDec === null ? null : money(floorHeadroomDec.toString()),
      breachesFloor,
      inflowByCategory: inflowByCat,
      outflowByCategory: outflowByCat,
      lines,
    });

    runningOpening = closingDec;
  }

  const totalNetDec = totalInflowDec.minus(totalOutflowDec);

  return {
    forecast: {
      asOfDate: baseTry.asOfDate,
      snapshotWeekStart: baseTry.snapshotWeekStart,
      horizonEnd: baseTry.horizonEnd,
      currency: "TRY",
      openingCash,
      unknownOpeningCount,
      minCashFloor,
      totalInflow: money(totalInflowDec.toString()),
      totalOutflow: money(totalOutflowDec.toString()),
      totalNetFlow: money(totalNetDec.toString()),
      endingCash: runningOpening === null ? null : money(runningOpening.toString()),
      worstWeekStart,
      worstClosingBalance: worstClosingDec === null ? null : money(worstClosingDec.toString()),
      firstFloorBreachWeekStart,
      overdueUnscheduledCount: overdueItems.length,
      overdueUnscheduledAmount: money(overdueAmountDec.toString()),
      overdueUnscheduledItems: overdueItems,
      doubtfulExcludedCount: doubtfulCount,
      doubtfulExcludedAmount: money(doubtfulAmountDec.toString()),
      vatCarryforward190Opening: baseTry.vatCarryforward190Opening ?? 0,
      vatCarryforward190Applied: baseTry.vatCarryforward190Applied ?? 0,
      posBatchInflowTotal: money(posInflowDec.toString()),
      corporateCardOutflowTotal: money(cardOutflowDec.toString()),
      payrollTaxAccrualOutflowTotal: money(ptaOutflowDec.toString()),
      statutoryDeadlines: baseTry.statutoryDeadlines,
      weeks,
    },
    fxRatesUsed,
    unconvertibleFx,
  };
}

/* ── Faz 60 (M-23): Audited CFO Operational Inputs for Tax/SGK, POS Valor & Card Statements ── */

export const recordPayrollTaxAccrualSchema = z.object({
  periodMonth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Dönem YYYY-AA biçiminde olmalı"),
  obligationKind: z.enum([
    "NET_MAAS",
    "MPHB_STOPAJ",
    "SGK_4A",
    "DAMGA_VERGISI",
    "KURUMLAR_GECICI_VERGI",
  ]),
  dueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Vade tarihi YYYY-AA-GG olmalı"),
  accruedAmount: z.coerce.number().positive("Tahakkuk tutarı 0'dan büyük olmalı"),
  paidAmount: z.coerce.number().min(0).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  notes: z.string().trim().max(500).optional(),
});

export const recordPosSettlementBatchSchema = z.object({
  cashAccountId: z.uuid("Geçerli bir kasa/banka hesabı seçilmelidir"),
  posTerminalLabel: z.string().trim().min(2, "POS terminal etiketi en az 2 karakter olmalı").max(120),
  saleDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Satış tarihi YYYY-AA-GG olmalı"),
  expectedValueDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Beklenen valör tarihi YYYY-AA-GG olmalı"),
  grossAmount: z.coerce.number().positive("Brüt POS satış tutarı 0'dan büyük olmalı"),
  commissionRatePct: z.coerce.number().min(0).max(100).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
});

export const recordCorporateCardStatementSchema = z.object({
  cardAccountId: z.uuid("Geçerli bir kurumsal kart/banka hesabı seçilmelidir"),
  payFromAccountId: z.uuid().nullable().optional(),
  statementMonth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Ekstre dönemi YYYY-AA biçiminde olmalı"),
  cutoffDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Hesap kesim tarihi YYYY-AA-GG olmalı"),
  dueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Son ödeme tarihi YYYY-AA-GG olmalı"),
  statementAmount: z.coerce.number().positive("Ekstre borcu 0'dan büyük olmalı"),
  minimumPaymentAmount: z.coerce.number().min(0).nullable().optional(),
  paidAmount: z.coerce.number().min(0).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
});

export async function recordPayrollTaxAccrual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string }> {
  const parsed = recordPayrollTaxAccrualSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(
      "VALIDATION",
      `Vergi/SGK/bordro tahakkuku geçersiz: ${formatIssues(parsed.error)}`,
    );
  }
  const input = parsed.data;
  const periodMonth = `${input.periodMonth.slice(0, 7)}-01`;
  const accruedStr = round2(decimal(input.accruedAmount));
  const paidStr = round2(decimal(input.paidAmount));
  const isPaid = decimal(paidStr).gte(decimal(accruedStr));

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.payroll_tax_accruals (
         period_month,
         obligation_kind,
         due_date,
         accrued_amount,
         paid_amount,
         currency,
         is_paid,
         notes,
         updated_at
       )
       values ($1::date, $2, $3::date, $4::numeric, $5::numeric, $6, $7, $8, now())
       on conflict (period_month, obligation_kind) do update
         set due_date = excluded.due_date,
             accrued_amount = excluded.accrued_amount,
             paid_amount = excluded.paid_amount,
             currency = excluded.currency,
             is_paid = excluded.is_paid,
             notes = excluded.notes,
             updated_at = now()
       returning id::text`,
      [
        periodMonth,
        input.obligationKind,
        input.dueDate,
        accruedStr,
        paidStr,
        input.currency,
        isPaid,
        input.notes ?? null,
      ],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Vergi/SGK/bordro tahakkuk kaydı yazılamadı.");
    }
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "upsert_payroll_tax_accrual",
      entityTable: "payroll_tax_accruals",
      entityId: id,
      after: {
        periodMonth,
        obligationKind: input.obligationKind,
        dueDate: input.dueDate,
        accruedAmount: money(accruedStr),
        paidAmount: money(paidStr),
        currency: input.currency,
        isPaid,
        automated: false,
      },
    });
    await client.query("commit");
    return { id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function recordPosSettlementBatch(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string }> {
  const parsed = recordPosSettlementBatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", `POS valör kaydı geçersiz: ${formatIssues(parsed.error)}`);
  }
  const input = parsed.data;
  if (input.expectedValueDate < input.saleDate) {
    throw new DomainError(
      "VALIDATION",
      "Beklenen POS valör tarihi satış tarihinden önce olamaz.",
    );
  }
  const rateFracDec = decimal(input.commissionRatePct).div(100);
  const grossDec = decimal(input.grossAmount);
  const commissionStr = round2(grossDec.times(rateFracDec));
  const netStr = round2(grossDec.minus(decimal(commissionStr)));
  const grossStr = round2(grossDec);
  const rateFracStr = rateFracDec.toFixed(4);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.pos_settlement_batches (
         cash_account_id,
         pos_terminal_label,
         sale_date,
         expected_value_date,
         gross_amount,
         commission_rate,
         commission_amount,
         net_settlement_amount,
         currency,
         is_settled
       )
       values ($1::uuid, $2, $3::date, $4::date, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, false)
       returning id::text`,
      [
        input.cashAccountId,
        input.posTerminalLabel,
        input.saleDate,
        input.expectedValueDate,
        grossStr,
        rateFracStr,
        commissionStr,
        netStr,
        input.currency,
      ],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("CONFLICT", "POS valör partisi kaydedilemedi.");
    }
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_pos_settlement_batch",
      entityTable: "pos_settlement_batches",
      entityId: id,
      after: {
        cashAccountId: input.cashAccountId,
        posTerminalLabel: input.posTerminalLabel,
        saleDate: input.saleDate,
        expectedValueDate: input.expectedValueDate,
        grossAmount: money(grossStr),
        commissionAmount: money(commissionStr),
        netSettlementAmount: money(netStr),
        currency: input.currency,
        automated: false,
      },
    });
    await client.query("commit");
    return { id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function recordCorporateCardStatement(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string }> {
  const parsed = recordCorporateCardStatementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(
      "VALIDATION",
      `Kurumsal kart ekstresi geçersiz: ${formatIssues(parsed.error)}`,
    );
  }
  const input = parsed.data;
  const statementMonth = `${input.statementMonth.slice(0, 7)}-01`;
  const stmtStr = round2(decimal(input.statementAmount));
  const minPayStr =
    input.minimumPaymentAmount != null ? round2(decimal(input.minimumPaymentAmount)) : null;
  const paidStr = round2(decimal(input.paidAmount));
  const isSettled = decimal(paidStr).gte(decimal(stmtStr));

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.corporate_card_statements (
         card_account_id,
         pay_from_account_id,
         statement_month,
         cutoff_date,
         due_date,
         statement_amount,
         minimum_payment_amount,
         paid_amount,
         currency,
         is_settled,
         updated_at
       )
       values ($1::uuid, $2::uuid, $3::date, $4::date, $5::date, $6::numeric, $7::numeric, $8::numeric, $9, $10, now())
       on conflict (card_account_id, statement_month) do update
         set pay_from_account_id = excluded.pay_from_account_id,
             cutoff_date = excluded.cutoff_date,
             due_date = excluded.due_date,
             statement_amount = excluded.statement_amount,
             minimum_payment_amount = excluded.minimum_payment_amount,
             paid_amount = excluded.paid_amount,
             currency = excluded.currency,
             is_settled = excluded.is_settled,
             updated_at = now()
       returning id::text`,
      [
        input.cardAccountId,
        input.payFromAccountId ?? null,
        statementMonth,
        input.cutoffDate,
        input.dueDate,
        stmtStr,
        minPayStr,
        paidStr,
        input.currency,
        isSettled,
      ],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Kurumsal kart ekstresi kaydedilemedi.");
    }
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "upsert_corporate_card_statement",
      entityTable: "corporate_card_statements",
      entityId: id,
      after: {
        cardAccountId: input.cardAccountId,
        statementMonth,
        cutoffDate: input.cutoffDate,
        dueDate: input.dueDate,
        statementAmount: money(stmtStr),
        paidAmount: money(paidStr),
        currency: input.currency,
        isSettled,
        automated: false,
      },
    });
    await client.query("commit");
    return { id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function load13wOperationalInputs(pool: Pool) {
  return withPinnedRead(pool, async (client) => {
    const reg = await client
      .query<{
        has_pta: string | null;
        has_pos: string | null;
        has_card: string | null;
      }>(
        `select
           to_regclass('public.payroll_tax_accruals')::text as has_pta,
           to_regclass('public.pos_settlement_batches')::text as has_pos,
           to_regclass('public.corporate_card_statements')::text as has_card`,
      )
      .catch(() => ({ rows: [{ has_pta: null, has_pos: null, has_card: null }] }));
    const r0 = reg.rows[0] ?? { has_pta: null, has_pos: null, has_card: null };

    const [acctRes, ptaRes, posRes, cardRes] = await gather(client, [
      () =>
        client
          .query<{ id: string; name: string; account_type: string; currency: string }>(
            `select id::text, name, account_type, currency
               from public.cash_accounts
              where is_active = true
              order by currency = 'TRY' desc, name asc`,
          )
          .catch(() => ({
            rows: [] as Array<{ id: string; name: string; account_type: string; currency: string }>,
          })),
      () =>
        r0.has_pta
          ? client.query<{
              id: string;
              period_ym: string;
              obligation_kind: string;
              due_date: string;
              accrued_amount: string;
              paid_amount: string;
              currency: string;
              is_paid: boolean;
              notes: string | null;
            }>(
              `select
                 id::text,
                 to_char(period_month, 'YYYY-MM') as period_ym,
                 obligation_kind,
                 to_char(due_date, 'YYYY-MM-DD') as due_date,
                 accrued_amount::text,
                 paid_amount::text,
                 currency,
                 is_paid,
                 notes
               from public.payroll_tax_accruals
               where is_paid = false
               order by due_date asc
               limit 20`,
            )
          : Promise.resolve({
              rows: [] as Array<{
                id: string;
                period_ym: string;
                obligation_kind: string;
                due_date: string;
                accrued_amount: string;
                paid_amount: string;
                currency: string;
                is_paid: boolean;
                notes: string | null;
              }>,
            }),
      () =>
        r0.has_pos
          ? client.query<{
              id: string;
              pos_terminal_label: string;
              sale_date: string;
              expected_value_date: string;
              gross_amount: string;
              commission_amount: string;
              net_settlement_amount: string;
              currency: string;
              account_name: string | null;
            }>(
              `select
                 psb.id::text,
                 psb.pos_terminal_label,
                 to_char(psb.sale_date, 'YYYY-MM-DD') as sale_date,
                 to_char(psb.expected_value_date, 'YYYY-MM-DD') as expected_value_date,
                 psb.gross_amount::text,
                 psb.commission_amount::text,
                 psb.net_settlement_amount::text,
                 psb.currency,
                 ca.name as account_name
               from public.pos_settlement_batches psb
               left join public.cash_accounts ca on ca.id = psb.cash_account_id
               where psb.is_settled = false
               order by psb.expected_value_date asc
               limit 20`,
            )
          : Promise.resolve({
              rows: [] as Array<{
                id: string;
                pos_terminal_label: string;
                sale_date: string;
                expected_value_date: string;
                gross_amount: string;
                commission_amount: string;
                net_settlement_amount: string;
                currency: string;
                account_name: string | null;
              }>,
            }),
      () =>
        r0.has_card
          ? client.query<{
              id: string;
              statement_ym: string;
              cutoff_date: string;
              due_date: string;
              statement_amount: string;
              paid_amount: string;
              currency: string;
              card_name: string | null;
            }>(
              `select
                 ccs.id::text,
                 to_char(ccs.statement_month, 'YYYY-MM') as statement_ym,
                 to_char(ccs.cutoff_date, 'YYYY-MM-DD') as cutoff_date,
                 to_char(ccs.due_date, 'YYYY-MM-DD') as due_date,
                 ccs.statement_amount::text,
                 ccs.paid_amount::text,
                 ccs.currency,
                 ca.name as card_name
               from public.corporate_card_statements ccs
               left join public.cash_accounts ca on ca.id = ccs.card_account_id
               where ccs.is_settled = false
               order by ccs.due_date asc
               limit 20`,
            )
          : Promise.resolve({
              rows: [] as Array<{
                id: string;
                statement_ym: string;
                cutoff_date: string;
                due_date: string;
                statement_amount: string;
                paid_amount: string;
                currency: string;
                card_name: string | null;
              }>,
            }),
    ]);

    return {
      accounts: acctRes.rows.map((a) => ({
        id: a.id,
        name: a.name,
        accountType: a.account_type,
        currency: a.currency,
      })),
      payrollTaxAccruals: ptaRes.rows.map((r) => ({
        id: r.id,
        periodYm: r.period_ym,
        obligationKind: r.obligation_kind,
        dueDate: r.due_date,
        accruedAmount: moneyOrNull(r.accrued_amount) ?? 0,
        paidAmount: moneyOrNull(r.paid_amount) ?? 0,
        currency: r.currency,
        notes: r.notes,
      })),
      posBatches: posRes.rows.map((r) => ({
        id: r.id,
        posTerminalLabel: r.pos_terminal_label,
        saleDate: r.sale_date,
        expectedValueDate: r.expected_value_date,
        grossAmount: moneyOrNull(r.gross_amount) ?? 0,
        commissionAmount: moneyOrNull(r.commission_amount) ?? 0,
        netSettlementAmount: moneyOrNull(r.net_settlement_amount) ?? 0,
        currency: r.currency,
        accountName: r.account_name,
      })),
      cardStatements: cardRes.rows.map((r) => ({
        id: r.id,
        statementYm: r.statement_ym,
        cutoffDate: r.cutoff_date,
        dueDate: r.due_date,
        statementAmount: moneyOrNull(r.statement_amount) ?? 0,
        paidAmount: moneyOrNull(r.paid_amount) ?? 0,
        currency: r.currency,
        cardName: r.card_name,
      })),
    };
  });
}

export { ALL_CATEGORIES };
