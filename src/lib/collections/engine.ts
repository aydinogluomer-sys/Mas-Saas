// Faz 23 — collections engine: risk read models and the manual bad-debt flag.
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
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { isReportingCurrency } from "@/lib/currency-policy";
import { parseOrThrow } from "@/lib/validation";
import {
  assessRisk, collectionProbability, expectedCollectionDate, scheduleWithinCash,
  type CollectionSignals, type PayableItem,
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

    await audit(client, {
      actor: actorId, action: "mark_bad_debt", entityTable: "invoices", entityId: input.invoiceId,
      before: { bad_debt_at: null, status: inv.status },
      after: {
        bad_debt: true, reason: input.reason,
        openAmount: (moneyOrNull(inv.gross_amount) ?? 0) - (moneyOrNull(inv.allocated_amount) ?? 0),
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

export interface ReceivableRisk {
  invoiceId: string;
  partyId: string;
  partyName: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  openAmount: number;
  /** PHASE 2.2 (#57): faturanın para birimi; TRY değilse toplam ve yoğunlaşma oranı dışında. */
  currency: string;
  daysOverdue: number | null;
  badDebtFlagged: boolean;
  badDebtReason: string | null;
  expectedDate: string | null;
  expectedBasis: string;
  probability: number;
  probabilityBand: string;
  probabilitySignals: string[];
  riskFlags: string[];
  severity: string;
  concentrationRatio: number | null;
}

/**
 * Open receivables with their deterministic risk assessment.
 *
 * The view supplies facts; the scoring happens here so every number arrives with the named
 * signals that produced it. Concentration is computed across the returned set rather than in
 * SQL, because it is a property of the portfolio rather than of any one row.
 */
export async function loadReceivableRisk(pool: Pool, todayISO: string, limit = 200): Promise<ReceivableRisk[]> {
  const r = await pool.query(
    `select invoice_id::text, party_id::text, party_name, invoice_no,
            to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            open_amount, days_overdue, bad_debt_flagged, bad_debt_reason,
            party_avg_days_to_settle, party_settled_count, party_late_ratio,
            party_invoice_count, partially_settled
     from public.receivable_collection_signals
     order by (days_overdue is null), days_overdue desc nulls last, open_amount desc
     limit $1`, [limit]);

  const rows = r.rows.map((x) => ({
    invoiceId: x.invoice_id as string,
    partyId: x.party_id as string,
    partyName: x.party_name as string,
    invoiceNo: x.invoice_no as string,
    signals: {
      dueDate: x.due_date, issueDate: x.issue_date,
      daysOverdue: intOrNull(x.days_overdue),
      openAmount: moneyOrNull(x.open_amount) ?? 0,
      badDebtFlagged: Boolean(x.bad_debt_flagged),
      partyAvgDaysToSettle: rateOrNull(x.party_avg_days_to_settle),
      partySettledCount: intOrNull(x.party_settled_count) ?? 0,
      partyLateRatio: rateOrNull(x.party_late_ratio),
      partyInvoiceCount: intOrNull(x.party_invoice_count) ?? 0,
      partiallySettled: Boolean(x.partially_settled),
    } satisfies CollectionSignals,
    badDebtReason: x.bad_debt_reason as string | null,
    currency: String(x.currency ?? ""),
  }));

  // Yoğunlaşma oranı yalnız TRY alacaklar içinde: USD faturanın TRY toplamda payı hesaplanamaz.
  const total = rows.filter((r2) => isReportingCurrency(r2.currency)).reduce((n, r2) => n + r2.signals.openAmount, 0);

  return rows.map((row) => {
    const ratio = total > 0 && isReportingCurrency(row.currency) ? row.signals.openAmount / total : null;
    const expected = expectedCollectionDate(row.signals, todayISO);
    const prob = collectionProbability(row.signals);
    const risk = assessRisk(row.signals, ratio);
    return {
      invoiceId: row.invoiceId, partyId: row.partyId, partyName: row.partyName,
      invoiceNo: row.invoiceNo, issueDate: row.signals.issueDate, dueDate: row.signals.dueDate,
      openAmount: row.signals.openAmount, currency: row.currency, daysOverdue: row.signals.daysOverdue,
      badDebtFlagged: row.signals.badDebtFlagged, badDebtReason: row.badDebtReason,
      expectedDate: expected.expectedDate, expectedBasis: expected.basis,
      probability: prob.probability, probabilityBand: prob.band, probabilitySignals: prob.signals,
      riskFlags: risk.flags, severity: risk.severity,
      concentrationRatio: ratio == null ? null : Math.round(ratio * 10000) / 10000,
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
  const r = await pool.query(
    `select kind, entity_id::text, to_char(due_date,'YYYY-MM-DD') as due_date, label, amount,
            party_name, flexibility_class, priority, overdue, days_overdue, priority_rank, currency
     from public.payment_priority_queue
     order by priority_rank, due_date limit $1`, [limit]);
  const items: PayableItem[] = r.rows.map((x) => ({
    kind: x.kind, entityId: x.entity_id, dueDate: x.due_date, label: x.label,
    amount: moneyOrNull(x.amount), flexibilityClass: x.flexibility_class,
    priorityRank: intOrNull(x.priority_rank) ?? 999,
    currency: x.currency == null ? null : String(x.currency),
  }));
  return scheduleWithinCash(items, availableCash);
}

export async function loadPaymentCalendar(pool: Pool, fromISO: string, toISO: string) {
  const r = await pool.query(
    `select to_char(due_date,'YYYY-MM-DD') as due_date, item_count, unknown_amount_count,
            known_total, critical_total, payment_instance_count, invoice_count,
            loan_installment_count, check_count, has_overdue, foreign_currency_count
     from public.payment_calendar_extended
     where due_date between $1::date and $2::date order by due_date`, [fromISO, toISO]);
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
  const r = await pool.query(
    `select party_id::text, party_name, open_receivable_count, open_receivable_amount,
            overdue_count, overdue_amount, bad_debt_count, bad_debt_amount,
            worst_days_overdue, avg_days_to_settle, late_ratio
     from public.counterparty_collection_profile
     order by overdue_amount desc, open_receivable_amount desc limit $1`, [limit]);
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
