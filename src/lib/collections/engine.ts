// Faz 23 & Faz 46 (C3) — collections engine: risk read models and the manual bad-debt flag.
//
// THE ONE MUTATION IN THIS PHASE is `markBadDebt` / `clearBadDebt`. Everything else here reads.
// That is the whole shape of the phase: it computes opinions about collectability and puts them
// in front of a person, and the only thing it can write is what that person decided.
//
// CLAUDE.md: "Never allow AI to mark payments paid, delete records, change amounts, alter due
// dates, infer final truth from ambiguous rows, or mutate financial records without explicit
// user action." A bad-debt write-off is precisely that kind of final truth, so no score, rule
// or scheduled job in this codebase is wired to these functions — `phase23:verify` asserts that
// the bad-debt columns are written from nowhere else in src/.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, moneyOrNull, rateOrNull, type Decimal } from "@/lib/money";
import { isReportingCurrency } from "@/lib/currency-policy";
import { parseOrThrow } from "@/lib/validation";
import {
  assessRisk,
  collectionProbability,
  expectedCollectionDateV2,
  scheduleWithinCash,
  type CollectionBucketV2,
  type CollectionSignalsV2,
  type PayableItem,
} from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const markBadDebtSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(10, "Şüpheli alacak gerekçesi en az 10 karakter olmalı"),
});

export const clearBadDebtSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(5, "Kaldırma gerekçesi en az 5 karakter olmalı"),
});

/* ── the manual, audited flag ─────────────────────────────────────────────────────────── */

/**
 * Flag a receivable as doubtful.
 *
 * Deliberately demanding: a ten-character minimum on the reason is not bureaucracy, it is the
 * difference between "tahsil edilemez" and a sentence someone can act on six months later when
 * the customer calls back. The flag does NOT change the invoice's status — a flagged invoice is
 * still open and may still be collected (0051's note explains why that matters).
 */
export async function markBadDebt(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(markBadDebtSchema, raw, "Şüpheli alacak işareti");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, invoice_no, status, direction, gross_amount, allocated_amount,
              bad_debt_at, bad_debt_reason
       from public.invoices where id=$1 for update`, [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const inv = before.rows[0];

    if (inv.direction !== "sales") {
      throw new DomainError("Şüpheli alacak yalnız satış faturaları için işaretlenir.");
    }
    if (inv.status === "cancelled") {
      // 0051 enforces this too; refusing here turns the constraint into a sentence.
      throw new DomainError("İptal edilmiş faturada şüpheli alacak olmaz — ortada borç yok.");
    }
    if (inv.bad_debt_at) throw new DomainError("Bu fatura zaten şüpheli alacak olarak işaretli.");

    await client.query(
      `update public.invoices set bad_debt_at=now(), bad_debt_reason=$2, bad_debt_by=$3 where id=$1`,
      [input.invoiceId, input.reason, actorId]);

    const openAmt = decimal(moneyOrNull(inv.gross_amount) ?? 0)
      .minus(decimal(moneyOrNull(inv.allocated_amount) ?? 0));

    await audit(client, {
      actor: actorId, action: "mark_bad_debt", entityTable: "invoices", entityId: input.invoiceId,
      before: { bad_debt_at: null, status: inv.status },
      after: {
        bad_debt: true, reason: input.reason,
        openAmount: Number(openAmt.toFixed(2)),
        // Recorded explicitly: flagging does NOT close, cancel or delete the invoice, and no
        // automated rule produced this — a person did.
        status_unchanged: inv.status, automated: false,
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

/** Remove the flag — equally manual, equally audited. Recovery happens. */
export async function clearBadDebt(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(clearBadDebtSchema, raw, "Şüpheli alacak kaldırma");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, bad_debt_at, bad_debt_reason from public.invoices where id=$1 for update`,
      [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    if (!before.rows[0].bad_debt_at) throw new DomainError("Bu fatura şüpheli alacak olarak işaretli değil.");

    await client.query(
      `update public.invoices set bad_debt_at=null, bad_debt_reason=null, bad_debt_by=null where id=$1`,
      [input.invoiceId]);

    await audit(client, {
      actor: actorId, action: "clear_bad_debt", entityTable: "invoices", entityId: input.invoiceId,
      before: { bad_debt: true, reason: before.rows[0].bad_debt_reason },
      after: { bad_debt: false, reason: input.reason, automated: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

export interface ReceivableRisk {
  invoiceId: string;
  partyId: string;
  partyName: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  openAmount: number;
  /** Faz 46 (C3): faturanın para birimi (SELECT rcs.currency); TRY ve döviz yoğunlaşmaları ayrı hesaplanır. */
  currency: string;
  daysOverdue: number | null;
  badDebtFlagged: boolean;
  badDebtReason: string | null;
  expectedDate: string | null;
  expectedBasis: string;
  expectedBucket: CollectionBucketV2;
  probability: number;
  probabilityBand: string;
  probabilitySignals: string[];
  riskFlags: string[];
  severity: string;
  /** TRY portföyü içindeki yoğunlaşma payı (TRY dışı faturalarda null). */
  concentrationRatio: number | null;
  /** Faturanın kendi döviz sepeti (TRY, USD, EUR, GBP...) içindeki yoğunlaşma payı. */
  currencyConcentrationRatio: number | null;
}

/**
 * Open receivables with their deterministic risk assessment and V2 5-tier collection date.
 *
 * Faz 46 (C3):
 * - Selects `rcs.currency` so TRY `concentrationRatio` is computed accurately instead of returning null.
 * - Computes `currencyConcentrationRatio` per currency bucket without cross-currency mixing.
 * - Joins unbroken `promise_to_pay` (`status = 'pending' AND promised_date >= todayISO`) and historical
 *   settled DBT samples (`allocated_on - due_date`) to drive `expectedCollectionDateV2`.
 */
export async function loadReceivableRisk(
  pool: Pool,
  todayISO: string,
  limit = 200,
  options: { dbtMode?: "median" | "p75"; defaultLagDays?: number } = {},
): Promise<ReceivableRisk[]> {
  const r = await pool.query(
    `with active_promises as (
       select
         p.invoice_id,
         p.party_id,
         to_char(min(p.promised_date), 'YYYY-MM-DD') as promised_date
       from public.promise_to_pay p
       where p.status = 'pending' and p.promised_date >= $2::date
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
           and inv.status in ('paid', 'closed')
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
       rcs.bad_debt_reason,
       rcs.party_avg_days_to_settle,
       rcs.party_settled_count,
       rcs.party_late_ratio,
       rcs.party_invoice_count,
       rcs.partially_settled,
       rcs.currency,
       coalesce(ap_inv.promised_date, ap_party.promised_date) as active_promise_date,
       pdbt.dbt_samples
     from public.receivable_collection_signals rcs
     left join active_promises ap_inv
       on ap_inv.invoice_id = rcs.invoice_id
     left join (
       select party_id, min(promised_date) as promised_date
       from active_promises
       where invoice_id is null
       group by party_id
     ) ap_party
       on ap_party.party_id = rcs.party_id
     left join party_dbt pdbt
       on pdbt.party_id = rcs.party_id
     order by (rcs.days_overdue is null), rcs.days_overdue desc nulls last, rcs.open_amount desc
     limit $1`,
    [limit, todayISO],
  ).catch((err: unknown) => {
    if (isMissingSchemaError(err)) {
      return pool
        .query(
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
             rcs.bad_debt_reason,
             rcs.party_avg_days_to_settle,
             rcs.party_settled_count,
             rcs.party_late_ratio,
             rcs.party_invoice_count,
             rcs.partially_settled,
             coalesce(inv_c.currency, 'TRY') as currency,
             null::text as active_promise_date,
             null::int[] as dbt_samples
           from public.receivable_collection_signals rcs
           left join public.invoices inv_c on inv_c.id = rcs.invoice_id
           order by (rcs.days_overdue is null), rcs.days_overdue desc nulls last, rcs.open_amount desc
           limit $1`,
          [limit],
        )
        .catch((e2: unknown) => {
          if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
          throw e2;
        });
    }
    throw err;
  });

  const rows = r.rows.map((x) => {
    const rawSamples = Array.isArray(x.dbt_samples) ? x.dbt_samples : [];
    const partyDbtSamples = rawSamples
      .map((n: unknown) => intOrNull(n as string | number | null))
      .filter((n: number | null): n is number => n !== null);
    return {
      invoiceId: x.invoice_id as string,
      partyId: x.party_id as string,
      partyName: x.party_name as string,
      invoiceNo: x.invoice_no as string,
      signals: {
        dueDate: x.due_date,
        issueDate: x.issue_date,
        daysOverdue: intOrNull(x.days_overdue),
        openAmount: moneyOrNull(x.open_amount) ?? 0,
        badDebtFlagged: Boolean(x.bad_debt_flagged),
        partyAvgDaysToSettle: rateOrNull(x.party_avg_days_to_settle),
        partySettledCount: intOrNull(x.party_settled_count) ?? 0,
        partyLateRatio: rateOrNull(x.party_late_ratio),
        partyInvoiceCount: intOrNull(x.party_invoice_count) ?? 0,
        partiallySettled: Boolean(x.partially_settled),
        activePromiseDate: (x.active_promise_date as string | null) ?? null,
        partyDbtSamples,
      } satisfies CollectionSignalsV2,
      badDebtReason: x.bad_debt_reason as string | null,
      currency: String(x.currency ?? ""),
    };
  });

  // Per-currency decimal totals (zero cross-currency mixing).
  const totalsByCurrency = new Map<string, Decimal>();
  for (const row of rows) {
    if (!row.currency) continue;
    const prev = totalsByCurrency.get(row.currency) ?? decimal(0);
    totalsByCurrency.set(row.currency, prev.plus(decimal(row.signals.openAmount)));
  }
  const tryTotal = totalsByCurrency.get("TRY") ?? decimal(0);

  return rows.map((row) => {
    const currTotal = row.currency ? totalsByCurrency.get(row.currency) ?? decimal(0) : decimal(0);
    const currencyRatio = currTotal.gt(0)
      ? Number(decimal(row.signals.openAmount).div(currTotal).toFixed(4))
      : null;
    const tryRatio = tryTotal.gt(0) && isReportingCurrency(row.currency)
      ? Number(decimal(row.signals.openAmount).div(tryTotal).toFixed(4))
      : null;

    const expected = expectedCollectionDateV2(row.signals, todayISO, {
      mode: options.dbtMode ?? "median",
      defaultLagDays: options.defaultLagDays ?? 0,
    });
    const prob = collectionProbability(row.signals);
    // Risk assessment uses the invoice's own currency-bucket concentration so large USD/EUR
    // concentrations are flagged just as reliably as TRY concentrations.
    const risk = assessRisk(row.signals, tryRatio ?? currencyRatio);

    return {
      invoiceId: row.invoiceId,
      partyId: row.partyId,
      partyName: row.partyName,
      invoiceNo: row.invoiceNo,
      issueDate: row.signals.issueDate,
      dueDate: row.signals.dueDate,
      openAmount: row.signals.openAmount,
      currency: row.currency,
      daysOverdue: row.signals.daysOverdue,
      badDebtFlagged: row.signals.badDebtFlagged,
      badDebtReason: row.badDebtReason,
      expectedDate: expected.projectedDate,
      expectedBasis: expected.basis,
      expectedBucket: expected.bucket,
      probability: prob.probability,
      probabilityBand: prob.band,
      probabilitySignals: prob.signals,
      riskFlags: risk.flags,
      severity: risk.severity,
      concentrationRatio: tryRatio,
      currencyConcentrationRatio: currencyRatio,
    };
  });
}

/**
 * The payment queue, ordered and cut against available cash.
 *
 * `availableCash` comes from the caller (the cash-flow projection the radar already computes).
 * Passing it in rather than joining it here keeps the ordering a property of the obligations
 * and the cutoff a property of the moment.
 */
export async function loadPaymentSchedule(pool: Pool, availableCash: number, limit = 200) {
  const r = await pool
    .query(
      `select kind, entity_id::text, to_char(due_date,'YYYY-MM-DD') as due_date, label, amount,
              party_name, flexibility_class, priority, overdue, days_overdue, priority_rank, currency
       from public.payment_priority_queue
       order by priority_rank, due_date limit $1`,
      [limit],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query(
            `select kind, entity_id::text, to_char(due_date,'YYYY-MM-DD') as due_date, label, amount,
                    party_name, flexibility_class, priority, overdue, days_overdue, priority_rank,
                    null::text as currency
             from public.payment_priority_queue
             order by priority_rank, due_date limit $1`,
            [limit],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });
  const items: PayableItem[] = r.rows.map((x) => ({
    kind: x.kind, entityId: x.entity_id, dueDate: x.due_date, label: x.label,
    amount: moneyOrNull(x.amount), flexibilityClass: x.flexibility_class,
    priorityRank: intOrNull(x.priority_rank) ?? 999,
    currency: x.currency == null ? null : String(x.currency),
  }));
  return scheduleWithinCash(items, availableCash);
}

export async function loadPaymentCalendar(pool: Pool, fromISO: string, toISO: string) {
  const r = await pool
    .query(
      `select to_char(due_date,'YYYY-MM-DD') as due_date, item_count, unknown_amount_count,
              known_total, critical_total, payment_instance_count, invoice_count,
              loan_installment_count, check_count, has_overdue, foreign_currency_count
       from public.payment_calendar_extended
       where due_date between $1::date and $2::date order by due_date`,
      [fromISO, toISO],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query(
            `select to_char(due_date,'YYYY-MM-DD') as due_date, item_count, unknown_amount_count,
                    known_total, critical_total, payment_instance_count, invoice_count,
                    loan_installment_count, check_count, has_overdue, 0::int as foreign_currency_count
             from public.payment_calendar_extended
             where due_date between $1::date and $2::date order by due_date`,
            [fromISO, toISO],
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
    dueDate: x.due_date,
    itemCount: intOrNull(x.item_count) ?? 0,
    unknownAmountCount: intOrNull(x.unknown_amount_count) ?? 0,
    knownTotal: moneyOrNull(x.known_total) ?? 0,
    criticalTotal: moneyOrNull(x.critical_total) ?? 0,
    paymentInstanceCount: intOrNull(x.payment_instance_count) ?? 0,
    invoiceCount: intOrNull(x.invoice_count) ?? 0,
    loanInstallmentCount: intOrNull(x.loan_installment_count) ?? 0,
    checkCount: intOrNull(x.check_count) ?? 0,
    hasOverdue: Boolean(x.has_overdue),
    foreignCurrencyCount: intOrNull(x.foreign_currency_count) ?? 0,
  }));
}

export async function loadCollectionProfiles(pool: Pool, limit = 100) {
  const r = await pool
    .query(
      `select party_id::text, party_name, open_receivable_count, open_receivable_amount,
              overdue_count, overdue_amount, bad_debt_count, bad_debt_amount,
              worst_days_overdue, avg_days_to_settle, late_ratio
       from public.counterparty_collection_profile
       order by overdue_amount desc, open_receivable_amount desc limit $1`,
      [limit],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });
  return r.rows.map((x) => ({
    partyId: x.party_id, partyName: x.party_name,
    openCount: intOrNull(x.open_receivable_count) ?? 0,
    openAmount: moneyOrNull(x.open_receivable_amount) ?? 0,
    overdueCount: intOrNull(x.overdue_count) ?? 0,
    overdueAmount: moneyOrNull(x.overdue_amount) ?? 0,
    badDebtCount: intOrNull(x.bad_debt_count) ?? 0,
    badDebtAmount: moneyOrNull(x.bad_debt_amount) ?? 0,
    worstDaysOverdue: intOrNull(x.worst_days_overdue),
    avgDaysToSettle: rateOrNull(x.avg_days_to_settle),
    lateRatio: rateOrNull(x.late_ratio),
  }));
}
