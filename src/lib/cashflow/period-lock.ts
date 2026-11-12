// Faz 45 (C2) — Veritabanı seviyesinde sert dönem kilidi (Hard Period Lock),
// kapanış öncesi ön-kontrol (evaluatePeriodCloseReadiness), dönem kilitleme
// (lockCashflowPeriod) ve zorunlu gerekçeli kilit açma (reopenCashflowPeriod).
//
// PostgreSQL `0100_hard_period_lock_enforcement.sql` tetikleyicileri tek nihai otoritedir;
// buradaki servis katmanı ön-kontrol listesini üretir, parmak izini (SHA-256) hesaplar,
// tam audit_logs izi bırakır ve PostgreSQL `period_locked` / `period_lock_requires_manager`
// istisnalarını kullanıcıya anlaşılır Türkçe DomainError mesajlarına çevirir.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { canManagePeriodLock, type AppRole } from "@/lib/authz/matrix";
import { DomainError } from "@/lib/domain-error";
import { add, decimal, moneyOrNull, sub } from "@/lib/money";
import { addMonths } from "@/lib/radar/rules";
import { parseOrThrow } from "@/lib/validation";

export const PERIOD_LOCKED_USER_MESSAGE =
  "Seçili dönem kilitli olduğu için işlem yapılamaz. Düzeltme için Finans Yöneticisi dönem kilidini gerekçeli olarak açmalıdır.";

export function isPgPeriodLockedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? "");
  return code === "P0001" && /period_locked/i.test(msg);
}

export function translatePeriodLockError(err: unknown): never {
  if (err instanceof DomainError) throw err;
  if (isPgPeriodLockedError(err)) {
    throw new DomainError("CONFLICT", PERIOD_LOCKED_USER_MESSAGE);
  }
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  const msg = err && typeof err === "object" ? String((err as { message?: unknown }).message ?? "") : "";
  if (code === "42501" && /period_lock_requires_manager/i.test(msg)) {
    throw new DomainError(
      "FORBIDDEN",
      "Dönem kilitleme ve kilit açma yetkisi yalnız Finans Yöneticisi veya Yöneticiye aittir.",
    );
  }
  if (code === "23514" && /period_reopen_reason_required/i.test(msg)) {
    throw new DomainError(
      "VALIDATION",
      "Dönem kilidini açmak için en az 10 karakterlik gerekçe zorunludur.",
    );
  }
  if (code === "23514" && /period_reopen_target_invalid/i.test(msg)) {
    throw new DomainError(
      "VALIDATION",
      "Kilitli dönem yalnız incelendi (reviewed) durumuna açılabilir.",
    );
  }
  throw err;
}

export interface PeriodChecklistItem {
  code:
    | "unmatched_bank_txns"
    | "draft_invoices"
    | "missing_amount_payments"
    | "identity_and_continuity"
    | "open_mapping_reviews";
  label: string;
  count: number;
  severity: "blocker" | "warning" | "ok";
  detail: string;
}

export interface PeriodCloseReadiness {
  monthId: string;
  monthStart: string;
  ym: string;
  status: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  lockFingerprint: string | null;
  computedFingerprint: string;
  unmatchedBankTxCount: number;
  draftInvoiceCount: number;
  missingAmountPaymentCount: number;
  openMappingReviewCount: number;
  identityValid: boolean | null;
  previousContinuityGap: number | null;
  items: PeriodChecklistItem[];
  blockerCount: number;
  warningCount: number;
  readyToLock: boolean;
}

export async function evaluatePeriodCloseReadiness(
  poolOrClient: Pool | PoolClient,
  monthIdOrYm: string,
): Promise<PeriodCloseReadiness> {
  const mRes = await poolOrClient.query<{
    id: string;
    month_start: string;
    ym: string;
    status: string;
    source_sheet_id: string | null;
    opening_balance: string | null;
    projected_income: string | null;
    projected_expense: string | null;
    monthly_delta: string | null;
    closing_balance: string | null;
    locked_at: string | null;
    locked_by: string | null;
    locked_by_name: string | null;
    reopened_at: string | null;
    reopened_by: string | null;
    reopened_by_name: string | null;
    reopen_reason: string | null;
    lock_fingerprint: string | null;
  }>(
    `select cm.id::text,
            to_char(cm.month_start, 'YYYY-MM-DD') as month_start,
            to_char(cm.month_start, 'YYYY-MM') as ym,
            cm.status,
            cm.source_sheet_id::text,
            cm.opening_balance::text,
            cm.projected_income::text,
            cm.projected_expense::text,
            cm.monthly_delta::text,
            cm.closing_balance::text,
            to_char(cm.locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at,
            cm.locked_by::text,
            public.user_display_label(cm.locked_by) as locked_by_name,
            to_char(cm.reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as reopened_at,
            cm.reopened_by::text,
            public.user_display_label(cm.reopened_by) as reopened_by_name,
            cm.reopen_reason,
            cm.lock_fingerprint
       from public.cashflow_months cm
      where cm.id::text = $1 or to_char(cm.month_start, 'YYYY-MM') = $1`,
    [monthIdOrYm],
  );

  if (mRes.rowCount === 0) {
    throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
  }

  const m = mRes.rows[0];
  const monthStart = m.month_start;
  const nextMonthStart = addMonths(monthStart, 1);
  const prevMonthStart = addMonths(monthStart, -1);

  const countsRes = await poolOrClient.query<{
    unmatched_bank_count: string;
    draft_invoice_count: string;
    missing_payment_count: string;
    open_review_count: string;
    line_count: string;
    line_sum: string;
    invoice_sum: string;
    bank_sum: string;
    prev_closing: string | null;
  }>(
    `select
       (select count(*)
          from public.bank_transactions bt
         where bt.txn_date >= $1::date and bt.txn_date < $2::date
           and bt.status = 'unmatched')::text as unmatched_bank_count,
       (select count(*)
          from public.invoices inv
         where inv.issue_date >= $1::date and inv.issue_date < $2::date
           and inv.status = 'draft')::text as draft_invoice_count,
       (select count(*)
          from public.payment_instances pi
          left join public.payments p on p.id = pi.payment_id
         where pi.due_date >= $1::date and pi.due_date < $2::date
           and pi.status <> 'cancelled'
           and (p.id is null or (p.status = 'active' and p.archived_at is null))
           and (pi.amount is null or pi.amount_status = 'missing'))::text as missing_payment_count,
       (select count(*)
          from public.mapping_reviews mr
         where $4::uuid is not null
           and mr.sheet_id = $4::uuid
           and mr.status in ('open', 'rejected'))::text as open_review_count,
       (select count(*)
          from public.cashflow_lines cl
         where cl.cashflow_month_id = $3::uuid)::text as line_count,
       (select coalesce(sum(coalesce(cl.amount, 0)), 0)
          from public.cashflow_lines cl
         where cl.cashflow_month_id = $3::uuid)::text as line_sum,
       (select coalesce(sum(inv.gross_amount), 0)
          from public.invoices inv
         where inv.issue_date >= $1::date and inv.issue_date < $2::date
           and inv.status <> 'cancelled')::text as invoice_sum,
       (select coalesce(sum(bt.amount), 0)
          from public.bank_transactions bt
         where bt.txn_date >= $1::date and bt.txn_date < $2::date
           and bt.status <> 'ignored')::text as bank_sum,
       (select prev.closing_balance::text
          from public.cashflow_months prev
         where prev.month_start = $5::date) as prev_closing`,
    [monthStart, nextMonthStart, m.id, m.source_sheet_id, prevMonthStart],
  );

  const c = countsRes.rows[0];
  const unmatchedBankTxCount = Number(c.unmatched_bank_count);
  const draftInvoiceCount = Number(c.draft_invoice_count);
  const missingAmountPaymentCount = Number(c.missing_payment_count);
  const openMappingReviewCount = Number(c.open_review_count);

  const opening = moneyOrNull(m.opening_balance);
  const income = moneyOrNull(m.projected_income);
  const expense = moneyOrNull(m.projected_expense);
  const closing = moneyOrNull(m.closing_balance);
  const prevClosing = moneyOrNull(c.prev_closing);

  const identityValid =
    opening != null && income != null && expense != null && closing != null
      ? sub(sub(add(opening, income), expense), closing).abs().lte(decimal(1))
      : null;

  const previousContinuityGap =
    opening != null && prevClosing != null
      ? sub(opening, prevClosing).abs().gt(decimal(1))
        ? sub(opening, prevClosing).toNumber()
        : 0
      : null;

  const computedFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ym: m.ym,
        opening: m.opening_balance,
        income: m.projected_income,
        expense: m.projected_expense,
        delta: m.monthly_delta,
        closing: m.closing_balance,
        lineCount: c.line_count,
        lineSum: c.line_sum,
        invoiceSum: c.invoice_sum,
        bankSum: c.bank_sum,
      }),
    )
    .digest("hex")
    .slice(0, 24);

  const continuityBlocker = identityValid === false;
  const continuityWarning =
    identityValid === null || (previousContinuityGap != null && Math.abs(previousContinuityGap) > 1);

  const items: PeriodChecklistItem[] = [
    {
      code: "draft_invoices",
      label: "Taslak / onaysız faturalar",
      count: draftInvoiceCount,
      severity: draftInvoiceCount > 0 ? "blocker" : "ok",
      detail:
        draftInvoiceCount > 0
          ? `${draftInvoiceCount} taslak fatura onaylanmadan veya iptal edilmeden dönem kapatılamaz.`
          : "Taslak fatura yok.",
    },
    {
      code: "missing_amount_payments",
      label: "Tutarı eksik ödeme kalemleri",
      count: missingAmountPaymentCount,
      severity: missingAmountPaymentCount > 0 ? "blocker" : "ok",
      detail:
        missingAmountPaymentCount > 0
          ? `${missingAmountPaymentCount} aktif ödeme kaleminin tutarı eksik.`
          : "Eksik tutarlı ödeme yok.",
    },
    {
      code: "identity_and_continuity",
      label: "Kasa denklemi ve devir sürekliliği",
      count: continuityBlocker || continuityWarning ? 1 : 0,
      severity: continuityBlocker ? "blocker" : continuityWarning ? "warning" : "ok",
      detail: continuityBlocker
        ? "Devir + gelir − gider = kasa özdeşliği uyuşmuyor."
        : identityValid === null
          ? "Başlık bakiyelerinden biri bilinmiyor (NULL)."
          : previousContinuityGap != null && Math.abs(previousContinuityGap) > 1
            ? `Önceki ay kapanışı ile devir arasında ${previousContinuityGap} TL fark var.`
            : "Kasa özdeşliği ve devir sürekliliği doğrulandı.",
    },
    {
      code: "unmatched_bank_txns",
      label: "Eşleşmemiş banka hareketleri",
      count: unmatchedBankTxCount,
      severity: unmatchedBankTxCount > 0 ? "warning" : "ok",
      detail:
        unmatchedBankTxCount > 0
          ? `${unmatchedBankTxCount} banka hareketi henüz fatura/ödeme ile eşleşmemiş.`
          : "Tüm banka hareketleri eşleşti.",
    },
    {
      code: "open_mapping_reviews",
      label: "Açık içe aktarım incelemeleri",
      count: openMappingReviewCount,
      severity: openMappingReviewCount > 0 ? "blocker" : "ok",
      detail:
        openMappingReviewCount > 0
          ? `${openMappingReviewCount} açık/reddedilmiş kaynak incelemesi bulunuyor.`
          : "Açık kaynak incelemesi yok.",
    },
  ];

  const blockerCount = items.filter((i) => i.severity === "blocker").length;
  const warningCount = items.filter((i) => i.severity === "warning").length;

  return {
    monthId: m.id,
    monthStart,
    ym: m.ym,
    status: m.status,
    lockedAt: m.locked_at,
    lockedBy: m.locked_by,
    lockedByName: m.locked_by_name,
    reopenedAt: m.reopened_at,
    reopenedBy: m.reopened_by,
    reopenedByName: m.reopened_by_name,
    reopenReason: m.reopen_reason,
    lockFingerprint: m.lock_fingerprint,
    computedFingerprint,
    unmatchedBankTxCount,
    draftInvoiceCount,
    missingAmountPaymentCount,
    openMappingReviewCount,
    identityValid,
    previousContinuityGap,
    items,
    blockerCount,
    warningCount,
    readyToLock: m.status !== "locked" && blockerCount === 0,
  };
}

export const lockPeriodSchema = z.object({
  monthId: z.uuid("Geçersiz dönem kimliği."),
  allowWarnings: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const reopenPeriodSchema = z.object({
  monthId: z.uuid("Geçersiz dönem kimliği."),
  reason: z
    .string()
    .trim()
    .min(10, "Dönem kilidini açmak için en az 10 karakterlik gerekçe zorunludur.")
    .max(500, "Kilit açma gerekçesi en fazla 500 karakter olabilir."),
});

export async function lockCashflowPeriod(
  pool: Pool,
  raw: unknown,
  actor: { id: string; role: AppRole },
): Promise<{ monthId: string; ym: string; lockedAt: string; lockFingerprint: string }> {
  if (!canManagePeriodLock(actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      "Dönem kilitleme yetkisi yalnız Finans Yöneticisi veya Yöneticiye aittir.",
    );
  }
  const input = parseOrThrow(lockPeriodSchema, raw, "Dönem kilitleme");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const lockRes = await client.query<{ id: string; status: string }>(
      `select id::text, status from public.cashflow_months where id = $1 for update`,
      [input.monthId],
    );
    if (lockRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
    }
    const beforeStatus = lockRes.rows[0].status;
    if (beforeStatus === "locked") {
      throw new DomainError("CONFLICT", "Bu dönem zaten kilitli durumda.");
    }

    const readiness = await evaluatePeriodCloseReadiness(client, input.monthId);
    if (readiness.blockerCount > 0) {
      const reasons = readiness.items
        .filter((i) => i.severity === "blocker")
        .map((i) => i.detail)
        .join(" ");
      throw new DomainError("VALIDATION", `Dönem kapatma ön-kontrolü başarısız: ${reasons}`);
    }

    const upd = await client.query<{ locked_at_iso: string }>(
      `update public.cashflow_months
          set status = 'locked',
              locked_at = now(),
              locked_by = $2,
              lock_fingerprint = $3,
              notes = coalesce($4, notes)
        where id = $1
        returning to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at_iso`,
      [input.monthId, actor.id, readiness.computedFingerprint, input.notes ?? null],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Dönem kilitleme işlemi yetki politikası tarafından reddedildi.");
    }

    await audit(client, {
      actor: actor.id,
      action: "lock_cashflow_period",
      entityTable: "cashflow_months",
      entityId: input.monthId,
      before: { status: beforeStatus },
      after: {
        status: "locked",
        ym: readiness.ym,
        lockedAt: upd.rows[0].locked_at_iso,
        lockFingerprint: readiness.computedFingerprint,
        warningCount: readiness.warningCount,
        unmatchedBankTxCount: readiness.unmatchedBankTxCount,
      },
    });

    await client.query("commit");
    return {
      monthId: input.monthId,
      ym: readiness.ym,
      lockedAt: upd.rows[0].locked_at_iso,
      lockFingerprint: readiness.computedFingerprint,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return translatePeriodLockError(err);
  } finally {
    client.release();
  }
}

export async function reopenCashflowPeriod(
  pool: Pool,
  raw: unknown,
  actor: { id: string; role: AppRole },
): Promise<{ monthId: string; ym: string; reopenedAt: string }> {
  if (!canManagePeriodLock(actor.role)) {
    throw new DomainError(
      "FORBIDDEN",
      "Dönem kilidi açma yetkisi yalnız Finans Yöneticisi veya Yöneticiye aittir.",
    );
  }
  const input = parseOrThrow(reopenPeriodSchema, raw, "Dönem kilidi açma");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      ym: string;
      status: string;
      locked_at: string | null;
      lock_fingerprint: string | null;
    }>(
      `select id::text,
              to_char(month_start, 'YYYY-MM') as ym,
              status,
              to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at,
              lock_fingerprint
         from public.cashflow_months
        where id = $1
        for update`,
      [input.monthId],
    );
    if (before.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
    }
    const row = before.rows[0];
    if (row.status !== "locked") {
      throw new DomainError("CONFLICT", "Yalnız kilitli durumdaki bir dönem yeniden açılabilir.");
    }

    const upd = await client.query<{ reopened_at_iso: string }>(
      `update public.cashflow_months
          set status = 'reviewed',
              reopened_at = now(),
              reopened_by = $2,
              reopen_reason = $3
        where id = $1
        returning to_char(reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as reopened_at_iso`,
      [input.monthId, actor.id, input.reason],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Dönem kilidi açma işlemi yetki politikası tarafından reddedildi.");
    }

    await audit(client, {
      actor: actor.id,
      action: "reopen_cashflow_period",
      entityTable: "cashflow_months",
      entityId: input.monthId,
      before: {
        status: "locked",
        lockedAt: row.locked_at,
        lockFingerprint: row.lock_fingerprint,
      },
      after: {
        status: "reviewed",
        ym: row.ym,
        reopenedAt: upd.rows[0].reopened_at_iso,
        reopenReason: input.reason,
      },
    });

    await client.query("commit");
    return {
      monthId: input.monthId,
      ym: row.ym,
      reopenedAt: upd.rows[0].reopened_at_iso,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return translatePeriodLockError(err);
  } finally {
    client.release();
  }
}

