// Faz 45 (C2) + M-22 — Veritabanı seviyesinde sert dönem kilidi (Hard Period Lock),
// bağımsız `public.accounting_periods` (0116) otoritesi + `public.cashflow_months` senkronizasyonu,
// kapanış öncesi ön-kontrol (evaluatePeriodCloseReadiness), dönem kilitleme (lockCashflowPeriod)
// ve zorunlu gerekçeli kilit açma (reopenCashflowPeriod).

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
  if (code === "P0001" && /period_locked/i.test(msg)) return true;
  if (code === undefined && /\bperiod_locked\s*:/i.test(msg)) return true;
  return false;
}

export function isPeriodLockTriggerError(err: unknown): boolean {
  if (isPgPeriodLockedError(err)) return true;
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown }).message ?? "");
  if (code === "42501" && /period_lock_requires_manager/i.test(msg)) return true;
  if (code === "23514" && /period_reopen_(reason_required|target_invalid)/i.test(msg)) return true;
  return false;
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

export function isHandledActionError(err: unknown): boolean {
  return (
    err instanceof DomainError ||
    isPeriodLockTriggerError(err) ||
    (err instanceof Error && err.name === "ZodError")
  );
}

export function toUserActionErrorMessage(
  err: unknown,
  fallback = "İşlem tamamlanamadı.",
): string {
  if (isPgPeriodLockedError(err) || isPeriodLockTriggerError(err)) {
    try {
      translatePeriodLockError(err);
    } catch (translated) {
      if (translated instanceof DomainError) return translated.message;
    }
  }
  if (err instanceof DomainError) {
    return err.message;
  }
  if (err instanceof Error && err.name === "ZodError") {
    return err.message.slice(0, 240);
  }
  return fallback;
}

export interface PeriodChecklistItem {
  code:
    | "unmatched_bank_txns"
    | "provisional_fx_entries"
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
  provisionalFxEntryCount: number;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YM_OR_YMD_RE = /^(\d{4})-(0[1-9]|1[0-2])(?:-01)?$/;

async function checkOptionalRelations(
  db: Pick<Pool, "query"> | Pick<PoolClient, "query">,
): Promise<{ hasAccountingPeriods: boolean; hasJournalEntries: boolean }> {
  const r = await db.query<{ ap: string | null; je: string | null }>(
    `select to_regclass('public.accounting_periods')::text as ap,
            to_regclass('public.management_journal_entries')::text as je`,
  );
  return {
    hasAccountingPeriods: Boolean(r.rows[0]?.ap),
    hasJournalEntries: Boolean(r.rows[0]?.je),
  };
}

export async function evaluatePeriodCloseReadiness(
  poolOrClient: Pool | PoolClient,
  monthIdOrYm: string,
): Promise<PeriodCloseReadiness> {
  const target = monthIdOrYm.trim();
  const { hasAccountingPeriods, hasJournalEntries } = await checkOptionalRelations(poolOrClient);

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
      where cm.id::text = $1
         or to_char(cm.month_start, 'YYYY-MM') = $1
         or to_char(cm.month_start, 'YYYY-MM-DD') = $1
      limit 1`,
    [target],
  );

  let apRow: {
    id: string;
    month_start: string;
    ym: string;
    status: string;
    locked_at: string | null;
    locked_by: string | null;
    locked_by_name: string | null;
    reopened_at: string | null;
    reopened_by: string | null;
    reopened_by_name: string | null;
    reopen_reason: string | null;
    lock_fingerprint: string | null;
  } | null = null;

  if (hasAccountingPeriods) {
    const lookupKey = mRes.rows[0]?.ym ?? target;
    const apRes = await poolOrClient.query<{
      id: string;
      month_start: string;
      ym: string;
      status: string;
      locked_at: string | null;
      locked_by: string | null;
      locked_by_name: string | null;
      reopened_at: string | null;
      reopened_by: string | null;
      reopened_by_name: string | null;
      reopen_reason: string | null;
      lock_fingerprint: string | null;
    }>(
      `select ap.id::text as id,
              to_char(ap.period_month, 'YYYY-MM-DD') as month_start,
              to_char(ap.period_month, 'YYYY-MM') as ym,
              ap.status,
              to_char(ap.locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at,
              ap.locked_by::text as locked_by,
              public.user_display_label(ap.locked_by) as locked_by_name,
              to_char(ap.reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as reopened_at,
              ap.reopened_by::text as reopened_by,
              public.user_display_label(ap.reopened_by) as reopened_by_name,
              ap.reopen_reason,
              ap.lock_fingerprint
         from public.accounting_periods ap
        where ap.id::text = $1
           or to_char(ap.period_month, 'YYYY-MM') = $2
           or to_char(ap.period_month, 'YYYY-MM-DD') = $2
        limit 1`,
      [target, lookupKey],
    );
    apRow = apRes.rows[0] ?? null;
  }

  const cmRow = mRes.rows[0] ?? null;
  const ymMatch = YM_OR_YMD_RE.exec(target);
  if (!cmRow && !apRow && !ymMatch) {
    throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
  }

  const resolvedYm = cmRow?.ym ?? apRow?.ym ?? `${ymMatch![1]}-${ymMatch![2]}`;
  const monthStart = `${resolvedYm}-01`;
  const nextMonthStart = addMonths(monthStart, 1);
  const prevMonthStart = addMonths(monthStart, -1);
  const cashflowMonthUuid = cmRow?.id ?? null;
  const sourceSheetUuid = cmRow?.source_sheet_id ?? null;

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
         where $3::uuid is not null
           and cl.cashflow_month_id = $3::uuid)::text as line_count,
       (select coalesce(sum(coalesce(cl.amount, 0)), 0)
          from public.cashflow_lines cl
         where $3::uuid is not null
           and cl.cashflow_month_id = $3::uuid)::text as line_sum,
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
    [monthStart, nextMonthStart, cashflowMonthUuid, sourceSheetUuid, prevMonthStart],
  );

  let provisionalFxEntryCount = 0;
  if (hasJournalEntries) {
    const pfxRes = await poolOrClient.query<{ cnt: number }>(
      `select count(*)::int as cnt
         from public.management_journal_entries
        where entry_date >= $1::date
          and entry_date < $2::date
          and status = 'provisional_fx'`,
      [monthStart, nextMonthStart],
    );
    provisionalFxEntryCount = Number(pfxRes.rows[0]?.cnt ?? 0);
  }

  const c = countsRes.rows[0];
  const unmatchedBankTxCount = Number(c.unmatched_bank_count);
  const draftInvoiceCount = Number(c.draft_invoice_count);
  const missingAmountPaymentCount = Number(c.missing_payment_count);
  const openMappingReviewCount = Number(c.open_review_count);

  const opening = cmRow ? moneyOrNull(cmRow.opening_balance) : null;
  const income = cmRow ? moneyOrNull(cmRow.projected_income) : null;
  const expense = cmRow ? moneyOrNull(cmRow.projected_expense) : null;
  const closing = cmRow ? moneyOrNull(cmRow.closing_balance) : null;
  const prevClosing = moneyOrNull(c.prev_closing);

  const identityValid = cmRow
    ? opening != null && income != null && expense != null && closing != null
      ? sub(sub(add(opening, income), expense), closing).abs().lte(decimal(1))
      : null
    : true;

  const previousContinuityGap =
    cmRow && opening != null && prevClosing != null
      ? sub(opening, prevClosing).abs().gt(decimal(1))
        ? sub(opening, prevClosing).toNumber()
        : 0
      : null;

  const computedFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ym: resolvedYm,
        opening: cmRow?.opening_balance ?? null,
        income: cmRow?.projected_income ?? null,
        expense: cmRow?.projected_expense ?? null,
        delta: cmRow?.monthly_delta ?? null,
        closing: cmRow?.closing_balance ?? null,
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
    cmRow != null &&
    (identityValid === null || (previousContinuityGap != null && Math.abs(previousContinuityGap) > 1));

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
        : continuityWarning && identityValid === null
          ? "Başlık bakiyelerinden biri bilinmiyor (NULL)."
          : continuityWarning && previousContinuityGap != null && Math.abs(previousContinuityGap) > 1
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
      code: "provisional_fx_entries",
      label: "Geçici kur (provisional FX) yevmiye fişleri",
      count: provisionalFxEntryCount,
      severity: provisionalFxEntryCount > 0 ? "warning" : "ok",
      detail:
        provisionalFxEntryCount > 0
          ? `${provisionalFxEntryCount} yevmiye fişi kesin TCMB kuru bekleyen geçici kur durumunda.`
          : "Geçici kurlu yevmiye fişi yok.",
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

  const effectiveStatus =
    apRow?.status === "locked" || cmRow?.status === "locked"
      ? "locked"
      : apRow?.status ?? cmRow?.status ?? "open";
  const primaryRow = apRow?.status === "locked" ? apRow : cmRow ?? apRow;

  return {
    monthId: cmRow?.id ?? apRow?.id ?? resolvedYm,
    monthStart,
    ym: resolvedYm,
    status: effectiveStatus,
    lockedAt: primaryRow?.locked_at ?? apRow?.locked_at ?? cmRow?.locked_at ?? null,
    lockedBy: primaryRow?.locked_by ?? apRow?.locked_by ?? cmRow?.locked_by ?? null,
    lockedByName: primaryRow?.locked_by_name ?? apRow?.locked_by_name ?? cmRow?.locked_by_name ?? null,
    reopenedAt: primaryRow?.reopened_at ?? apRow?.reopened_at ?? cmRow?.reopened_at ?? null,
    reopenedBy: primaryRow?.reopened_by ?? apRow?.reopened_by ?? cmRow?.reopened_by ?? null,
    reopenedByName:
      primaryRow?.reopened_by_name ?? apRow?.reopened_by_name ?? cmRow?.reopened_by_name ?? null,
    reopenReason: primaryRow?.reopen_reason ?? apRow?.reopen_reason ?? cmRow?.reopen_reason ?? null,
    lockFingerprint:
      primaryRow?.lock_fingerprint ?? apRow?.lock_fingerprint ?? cmRow?.lock_fingerprint ?? null,
    computedFingerprint,
    unmatchedBankTxCount,
    provisionalFxEntryCount,
    draftInvoiceCount,
    missingAmountPaymentCount,
    openMappingReviewCount,
    identityValid,
    previousContinuityGap,
    items,
    blockerCount,
    warningCount,
    readyToLock: effectiveStatus !== "locked" && blockerCount === 0,
  };
}

const periodIdentifierSchema = z
  .string()
  .trim()
  .refine((v) => UUID_RE.test(v) || YM_OR_YMD_RE.test(v), "Geçersiz dönem kimliği.");

export const lockPeriodSchema = z.object({
  monthId: periodIdentifierSchema,
  allowWarnings: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

export const reopenPeriodSchema = z.object({
  monthId: periodIdentifierSchema,
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
    const { hasAccountingPeriods } = await checkOptionalRelations(client);

    const cmRes = await client.query<{ id: string; ym: string; status: string }>(
      `select id::text as id,
              to_char(month_start, 'YYYY-MM') as ym,
              status
         from public.cashflow_months
        where id::text = $1
           or to_char(month_start, 'YYYY-MM') = $1
           or to_char(month_start, 'YYYY-MM-DD') = $1
        for update`,
      [input.monthId],
    );
    const cmRow = cmRes.rows[0] ?? null;

    let apRow: { id: string; ym: string; status: string } | null = null;
    if (hasAccountingPeriods) {
      const lookupYm = cmRow?.ym ?? input.monthId;
      const apRes = await client.query<{ id: string; ym: string; status: string }>(
        `select id::text as id,
                to_char(period_month, 'YYYY-MM') as ym,
                status
           from public.accounting_periods
          where id::text = $1
             or to_char(period_month, 'YYYY-MM') = $2
             or to_char(period_month, 'YYYY-MM-DD') = $2
          for update`,
        [input.monthId, lookupYm],
      );
      apRow = apRes.rows[0] ?? null;
    }

    const ymMatch = YM_OR_YMD_RE.exec(input.monthId);
    if (!cmRow && !apRow && (!hasAccountingPeriods || !ymMatch)) {
      throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
    }

    if (cmRow?.status === "locked" || apRow?.status === "locked") {
      throw new DomainError("CONFLICT", "Bu dönem zaten kilitli durumda.");
    }

    const resolvedYm = cmRow?.ym ?? apRow?.ym ?? `${ymMatch![1]}-${ymMatch![2]}`;
    const readiness = await evaluatePeriodCloseReadiness(
      client,
      cmRow?.id ?? apRow?.id ?? resolvedYm,
    );
    if (readiness.blockerCount > 0) {
      const reasons = readiness.items
        .filter((i) => i.severity === "blocker")
        .map((i) => i.detail)
        .join(" ");
      throw new DomainError("VALIDATION", `Dönem kapatma ön-kontrolü başarısız: ${reasons}`);
    }

    let lockedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let returnedId = cmRow?.id ?? apRow?.id ?? resolvedYm;

    if (cmRow) {
      const upd = await client.query<{ locked_at_iso: string }>(
        `update public.cashflow_months
            set status = 'locked',
                locked_at = now(),
                locked_by = $2,
                lock_fingerprint = $3,
                notes = coalesce($4, notes)
          where id = $1::uuid
          returning to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at_iso`,
        [cmRow.id, actor.id, readiness.computedFingerprint, input.notes ?? null],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("FORBIDDEN", "Dönem kilitleme işlemi yetki politikası tarafından reddedildi.");
      }
      lockedAtIso = upd.rows[0].locked_at_iso;
      returnedId = cmRow.id;

      await audit(client, {
        actor: actor.id,
        action: "lock_cashflow_period",
        entityTable: "cashflow_months",
        entityId: cmRow.id,
        before: { status: cmRow.status },
        after: {
          status: "locked",
          ym: readiness.ym,
          lockedAt: lockedAtIso,
          lockFingerprint: readiness.computedFingerprint,
          warningCount: readiness.warningCount,
          unmatchedBankTxCount: readiness.unmatchedBankTxCount,
        },
      });
    }

    if (hasAccountingPeriods) {
      const checklistPayload = JSON.stringify({
        items: readiness.items,
        blockerCount: readiness.blockerCount,
        warningCount: readiness.warningCount,
      });

      if (apRow) {
        const apUpd = await client.query<{ id: string; locked_at_iso: string }>(
          `update public.accounting_periods
              set status = 'locked',
                  locked_at = now(),
                  locked_by = $2,
                  lock_fingerprint = $3,
                  close_note = coalesce($4, close_note),
                  checklist_json = $5::jsonb,
                  updated_at = now()
            where id = $1::uuid
            returning id::text as id,
                      to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at_iso`,
          [apRow.id, actor.id, readiness.computedFingerprint, input.notes ?? null, checklistPayload],
        );
        if (apUpd.rowCount !== 1) {
          throw new DomainError("FORBIDDEN", "Muhasebe dönemi kilitleme yetkisi reddedildi.");
        }
        if (!cmRow) {
          lockedAtIso = apUpd.rows[0].locked_at_iso;
          returnedId = apUpd.rows[0].id;
        }
        await audit(client, {
          actor: actor.id,
          action: "lock_accounting_period",
          entityTable: "accounting_periods",
          entityId: apUpd.rows[0].id,
          before: { status: apRow.status },
          after: {
            status: "locked",
            ym: readiness.ym,
            lockedAt: apUpd.rows[0].locked_at_iso,
            lockFingerprint: readiness.computedFingerprint,
          },
        });
      } else {
        const apIns = await client.query<{ id: string; locked_at_iso: string }>(
          `insert into public.accounting_periods
             (legal_entity_id, period_month, status, checklist_json, close_note, locked_at, locked_by, lock_fingerprint)
           values (
             coalesce(public.current_legal_entity_id(), (select id from public.legal_entities where is_default = true limit 1)),
             $1::date,
             'locked',
             $2::jsonb,
             $3,
             now(),
             $4,
             $5
           )
           returning id::text as id,
                     to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at_iso`,
          [
            `${resolvedYm}-01`,
            checklistPayload,
            input.notes ?? null,
            actor.id,
            readiness.computedFingerprint,
          ],
        );
        if (apIns.rowCount !== 1) {
          throw new DomainError("FORBIDDEN", "Muhasebe dönemi oluşturulamadı.");
        }
        if (!cmRow) {
          lockedAtIso = apIns.rows[0].locked_at_iso;
          returnedId = apIns.rows[0].id;
        }
        await audit(client, {
          actor: actor.id,
          action: "lock_accounting_period",
          entityTable: "accounting_periods",
          entityId: apIns.rows[0].id,
          before: null,
          after: {
            status: "locked",
            ym: readiness.ym,
            lockedAt: apIns.rows[0].locked_at_iso,
            lockFingerprint: readiness.computedFingerprint,
          },
        });
      }
    }

    await client.query("commit");
    return {
      monthId: returnedId,
      ym: readiness.ym,
      lockedAt: lockedAtIso,
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
    const { hasAccountingPeriods } = await checkOptionalRelations(client);

    const before = await client.query<{
      id: string;
      ym: string;
      status: string;
      locked_at: string | null;
      lock_fingerprint: string | null;
    }>(
      `select id::text as id,
              to_char(month_start, 'YYYY-MM') as ym,
              status,
              to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at,
              lock_fingerprint
         from public.cashflow_months
        where id::text = $1
           or to_char(month_start, 'YYYY-MM') = $1
           or to_char(month_start, 'YYYY-MM-DD') = $1
        for update`,
      [input.monthId],
    );
    const cmRow = before.rows[0] ?? null;

    let apRow: {
      id: string;
      ym: string;
      status: string;
      locked_at: string | null;
      lock_fingerprint: string | null;
    } | null = null;
    if (hasAccountingPeriods) {
      const lookupYm = cmRow?.ym ?? input.monthId;
      const apRes = await client.query<{
        id: string;
        ym: string;
        status: string;
        locked_at: string | null;
        lock_fingerprint: string | null;
      }>(
        `select id::text as id,
                to_char(period_month, 'YYYY-MM') as ym,
                status,
                to_char(locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as locked_at,
                lock_fingerprint
           from public.accounting_periods
          where id::text = $1
             or to_char(period_month, 'YYYY-MM') = $2
             or to_char(period_month, 'YYYY-MM-DD') = $2
          for update`,
        [input.monthId, lookupYm],
      );
      apRow = apRes.rows[0] ?? null;
    }

    if (!cmRow && !apRow) {
      throw new DomainError("NOT_FOUND", "Nakit akış dönemi bulunamadı.");
    }
    if (cmRow?.status !== "locked" && apRow?.status !== "locked") {
      throw new DomainError("CONFLICT", "Yalnız kilitli durumdaki bir dönem yeniden açılabilir.");
    }

    const resolvedYm = cmRow?.ym ?? apRow!.ym;
    let reopenedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let returnedId = cmRow?.id ?? apRow!.id;

    if (cmRow?.status === "locked") {
      const upd = await client.query<{ reopened_at_iso: string }>(
        `update public.cashflow_months
            set status = 'reviewed',
                reopened_at = now(),
                reopened_by = $2,
                reopen_reason = $3
          where id = $1::uuid
          returning to_char(reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as reopened_at_iso`,
        [cmRow.id, actor.id, input.reason],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("FORBIDDEN", "Dönem kilidi açma işlemi yetki politikası tarafından reddedildi.");
      }
      reopenedAtIso = upd.rows[0].reopened_at_iso;
      returnedId = cmRow.id;

      await audit(client, {
        actor: actor.id,
        action: "reopen_cashflow_period",
        entityTable: "cashflow_months",
        entityId: cmRow.id,
        before: {
          status: "locked",
          lockedAt: cmRow.locked_at,
          lockFingerprint: cmRow.lock_fingerprint,
        },
        after: {
          status: "reviewed",
          ym: resolvedYm,
          reopenedAt: reopenedAtIso,
          reopenReason: input.reason,
        },
      });
    }

    if (apRow?.status === "locked") {
      const apUpd = await client.query<{ reopened_at_iso: string }>(
        `update public.accounting_periods
            set status = 'reviewed',
                reopened_at = now(),
                reopened_by = $2,
                reopen_reason = $3,
                updated_at = now()
          where id = $1::uuid
          returning to_char(reopened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as reopened_at_iso`,
        [apRow.id, actor.id, input.reason],
      );
      if (apUpd.rowCount !== 1) {
        throw new DomainError("FORBIDDEN", "Muhasebe dönemi kilidi açma yetkisi reddedildi.");
      }
      if (!cmRow) {
        reopenedAtIso = apUpd.rows[0].reopened_at_iso;
        returnedId = apRow.id;
      }

      await audit(client, {
        actor: actor.id,
        action: "reopen_accounting_period",
        entityTable: "accounting_periods",
        entityId: apRow.id,
        before: {
          status: "locked",
          lockedAt: apRow.locked_at,
          lockFingerprint: apRow.lock_fingerprint,
        },
        after: {
          status: "reviewed",
          ym: resolvedYm,
          reopenedAt: apUpd.rows[0].reopened_at_iso,
          reopenReason: input.reason,
        },
      });
    }

    await client.query("commit");
    return {
      monthId: returnedId,
      ym: resolvedYm,
      reopenedAt: reopenedAtIso,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    return translatePeriodLockError(err);
  } finally {
    client.release();
  }
}

export interface AccountingPeriodOverviewRow {
  periodId: string;
  ym: string;
  monthStart: string;
  status: "open" | "reviewed" | "locked";
  lockedAt: string | null;
  lockedByName: string | null;
  reopenReason: string | null;
  lockFingerprint: string | null;
  unmatchedBankTxCount: number;
  provisionalFxEntryCount: number;
  draftInvoiceCount: number;
  missingAmountPaymentCount: number;
  readyToLock: boolean;
}

export async function listAccountingPeriodsOverview(
  pool: Pool,
  todayISO: string,
): Promise<AccountingPeriodOverviewRow[]> {
  const { hasAccountingPeriods, hasJournalEntries } = await checkOptionalRelations(pool);
  const anchor = `${todayISO.slice(0, 7)}-01`;
  const startMonth = addMonths(anchor, -11);
  const endMonth = addMonths(anchor, 4);
  const endExclusive = addMonths(endMonth, 1);

  const [apRes, cmRes, btRes, invRes, piRes, jeRes] = await Promise.all([
    hasAccountingPeriods
      ? pool.query<{
          id: string;
          ym: string;
          status: string;
          locked_at: string | null;
          locked_by_name: string | null;
          reopen_reason: string | null;
          lock_fingerprint: string | null;
        }>(
          `select id::text as id,
                  to_char(period_month, 'YYYY-MM') as ym,
                  status,
                  to_char(locked_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as locked_at,
                  public.user_display_label(locked_by) as locked_by_name,
                  reopen_reason,
                  lock_fingerprint
             from public.accounting_periods
            where period_month >= $1::date and period_month <= $2::date`,
          [startMonth, endMonth],
        )
      : Promise.resolve({ rows: [] }),
    pool.query<{
      id: string;
      ym: string;
      status: string;
      locked_at: string | null;
      locked_by_name: string | null;
      reopen_reason: string | null;
      lock_fingerprint: string | null;
    }>(
      `select id::text as id,
              to_char(month_start, 'YYYY-MM') as ym,
              status,
              to_char(locked_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as locked_at,
              public.user_display_label(locked_by) as locked_by_name,
              reopen_reason,
              lock_fingerprint
         from public.cashflow_months
        where month_start >= $1::date and month_start <= $2::date`,
      [startMonth, endMonth],
    ),
    pool.query<{ ym: string; cnt: number }>(
      `select to_char(date_trunc('month', txn_date), 'YYYY-MM') as ym,
              count(*)::int as cnt
         from public.bank_transactions
        where txn_date >= $1::date and txn_date < $2::date
          and status = 'unmatched'
        group by 1`,
      [startMonth, endExclusive],
    ),
    pool.query<{ ym: string; cnt: number }>(
      `select to_char(date_trunc('month', issue_date), 'YYYY-MM') as ym,
              count(*)::int as cnt
         from public.invoices
        where issue_date >= $1::date and issue_date < $2::date
          and status = 'draft'
        group by 1`,
      [startMonth, endExclusive],
    ),
    pool.query<{ ym: string; cnt: number }>(
      `select to_char(date_trunc('month', pi.due_date), 'YYYY-MM') as ym,
              count(*)::int as cnt
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
        where pi.due_date >= $1::date and pi.due_date < $2::date
          and pi.status <> 'cancelled'
          and (p.id is null or (p.status = 'active' and p.archived_at is null))
          and (pi.amount is null or pi.amount_status = 'missing')
        group by 1`,
      [startMonth, endExclusive],
    ),
    hasJournalEntries
      ? pool.query<{ ym: string; cnt: number }>(
          `select to_char(date_trunc('month', entry_date), 'YYYY-MM') as ym,
                  count(*)::int as cnt
             from public.management_journal_entries
            where entry_date >= $1::date and entry_date < $2::date
              and status = 'provisional_fx'
            group by 1`,
          [startMonth, endExclusive],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const apMap = new Map(apRes.rows.map((r) => [r.ym, r]));
  const cmMap = new Map(cmRes.rows.map((r) => [r.ym, r]));
  const btMap = new Map(btRes.rows.map((r) => [r.ym, Number(r.cnt)]));
  const invMap = new Map(invRes.rows.map((r) => [r.ym, Number(r.cnt)]));
  const piMap = new Map(piRes.rows.map((r) => [r.ym, Number(r.cnt)]));
  const jeMap = new Map(jeRes.rows.map((r) => [r.ym, Number(r.cnt)]));

  const out: AccountingPeriodOverviewRow[] = [];
  for (let cur = endMonth, guard = 0; cur >= startMonth && guard < 24; cur = addMonths(cur, -1), guard++) {
    const ym = cur.slice(0, 7);
    const ap = apMap.get(ym);
    const cm = cmMap.get(ym);
    const status: AccountingPeriodOverviewRow["status"] =
      ap?.status === "locked" || cm?.status === "locked"
        ? "locked"
        : ap?.status === "reviewed" || cm?.status === "reviewed"
          ? "reviewed"
          : "open";
    const draftInvoiceCount = invMap.get(ym) ?? 0;
    const missingAmountPaymentCount = piMap.get(ym) ?? 0;
    const unmatchedBankTxCount = btMap.get(ym) ?? 0;
    const provisionalFxEntryCount = jeMap.get(ym) ?? 0;
    out.push({
      periodId: ap?.id ?? cm?.id ?? ym,
      ym,
      monthStart: cur,
      status,
      lockedAt: ap?.locked_at ?? cm?.locked_at ?? null,
      lockedByName: ap?.locked_by_name ?? cm?.locked_by_name ?? null,
      reopenReason: ap?.reopen_reason ?? cm?.reopen_reason ?? null,
      lockFingerprint: ap?.lock_fingerprint ?? cm?.lock_fingerprint ?? null,
      unmatchedBankTxCount,
      provisionalFxEntryCount,
      draftInvoiceCount,
      missingAmountPaymentCount,
      readyToLock: status !== "locked" && draftInvoiceCount === 0 && missingAmountPaymentCount === 0,
    });
  }

  return out;
}
