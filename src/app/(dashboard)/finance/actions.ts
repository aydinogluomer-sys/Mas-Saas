"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { DomainError } from "@/lib/domain-error";
import { audit } from "@/lib/audit";
import { decimal, money } from "@/lib/money";
import {
  CHECK_BORDRO_OPERATIONS,
  CHECK_STATUS_LABELS_TR,
  executeCheckBordroTransition,
  type CheckBordroOperation,
} from "@/lib/financing/check-bordro";
import {
  cancelCheck,
  cancelLoanInstallment,
  classifyUnknownCheck,
  mapAcceptedChecks,
  mapLoans,
  markCheckBounced,
  markCheckCleared,
  markInstallmentPaid,
} from "@/lib/financing/engine";
import { addMonthsPreservingAnchorDay } from "@/lib/financing/rules";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { cancelActionSchema } from "@/lib/validation/financial";

const number = (v: FormDataEntryValue | null) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const installmentCountSchema = z.number().int().min(1).max(360);
const ALLOWED_CURRENCIES = new Set(["TRY", "USD", "EUR", "GBP"]);

export async function createCheckAction(formData: FormData) {
  const session = await requireActionPermission("checks", "insert", "/finance");
  const date = String(formData.get("maturityDate") ?? "").trim();
  const rawAmount = number(formData.get("amount"));
  const amount = rawAmount == null ? null : money(Math.abs(rawAmount));
  const rawDirection = String(formData.get("direction") ?? "outflow");
  const direction =
    rawDirection === "inflow" || rawDirection === "outflow" ? rawDirection : "unknown";
  const rawInstrument = String(formData.get("instrumentType") ?? "check");
  const instrumentType = rawInstrument === "promissory_note" ? "promissory_note" : "check";
  const rawCurrency = String(formData.get("currency") ?? "TRY").trim().toUpperCase();
  const currency = ALLOWED_CURRENCIES.has(rawCurrency) ? rawCurrency : "TRY";
  if (!date) throw new DomainError("VALIDATION_ERROR", "Vade tarihi zorunlu.");
  const signed =
    amount == null
      ? null
      : direction === "outflow"
        ? money(decimal(amount).times(-1))
        : amount;
  const initialStatus =
    direction === "inflow"
      ? "in_portfolio"
      : direction === "outflow"
        ? "issued_to_vendor"
        : "planned";

  const pool = getPool();
  const client = await pool.connect();
  let createdId: string;
  try {
    await client.query("begin");
    const result = await client.query<{ id: string }>(
      `insert into public.checks
         (maturity_date, serial_no, counterparty_label, amount, signed_amount,
          currency, instrument_type, direction, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        date,
        String(formData.get("serial") ?? "").trim() || null,
        String(formData.get("counterparty") ?? "").trim() || null,
        amount,
        signed,
        currency,
        instrumentType,
        direction,
        initialStatus,
        String(formData.get("notes") ?? "").trim() || null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Çek/senet kaydı oluşturulamadı.");
    }
    createdId = result.rows[0].id;
    await client.query(
      `insert into public.check_events (check_id, event_type, event_note, created_by)
       values ($1, 'created', $2, $3)`,
      [
        createdId,
        `Manuel ${instrumentType === "promissory_note" ? "senet" : "çek"} kaydı (${initialStatus})`,
        session.id,
      ],
    );
    await audit(client, {
      actor: session.id,
      action: "create_check",
      entityTable: "checks",
      entityId: createdId,
      after: { date, amount, currency, instrumentType, direction, status: initialStatus },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (isPgPeriodLockedError(error) || isHandledActionError(error)) {
      errorRedirect("/finance/checks", toUserActionErrorMessage(error, "Çek/senet kaydı oluşturulamadı."));
    }
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/finance");
  revalidatePath("/finance/checks");
  redirect("/finance/checks");
}

export async function executeCheckBordroAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("check_bordros", "insert", "/finance/checks");
  const backTo = backOf(formData, "/finance/checks");
  const rawOperation = String(formData.get("operation") ?? "").trim();
  if (!(CHECK_BORDRO_OPERATIONS as readonly string[]).includes(rawOperation)) {
    errorRedirect(backTo, "Geçersiz çek/senet bordro işlemi.");
  }
  const checkIds = formData
    .getAll("checkIds")
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (checkIds.length === 0) {
    errorRedirect(backTo, "Bordro işlemi için en az bir çek veya senet seçmelisiniz.");
  }
  const bordroDate = String(formData.get("bordroDate") ?? "").trim() || undefined;
  const targetInvoiceId = String(formData.get("targetInvoiceId") ?? "").trim() || null;
  const targetBankAccountId = String(formData.get("targetBankAccountId") ?? "").trim() || null;
  const targetFacilityId = String(formData.get("targetFacilityId") ?? "").trim() || null;
  const rawLtv = number(formData.get("ltvRatio"));
  const notes = String(formData.get("notes") ?? "").trim() || null;

  let res;
  try {
    res = await executeCheckBordroTransition(
      getPool(),
      {
        operation: rawOperation as CheckBordroOperation,
        checkIds,
        bordroDate,
        targetInvoiceId,
        targetBankAccountId,
        targetFacilityId,
        ltvRatio: rawLtv ?? 0.8,
        notes,
      },
      session.id,
    );
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Bordro işlemi tamamlanamadı."));
    }
    throw e;
  }

  revalidatePath("/finance/checks");
  revalidateFinancialViews();
  const nextLabel = CHECK_STATUS_LABELS_TR[res.nextStatus] ?? res.nextStatus;
  redirect(
    `/finance/checks?flash=saved&result=${encodeURIComponent(
      `Bordro ${res.bordroNo} uygulandı (${res.processedCount} evrak → ${nextLabel}).`,
    )}`,
  );
}

export async function createLoanAction(formData: FormData) {
  const session = await requireActionPermission("loans", "insert", "/finance");
  const name = String(formData.get("name") ?? "").trim();
  const principal = number(formData.get("principal"));
  const rawCount = number(formData.get("installmentCount"));
  const installment = number(formData.get("installmentAmount"));
  const first = String(formData.get("firstPaymentDate") ?? "");
  if (!name || principal == null || rawCount == null || installment == null || !first) {
    throw new DomainError("VALIDATION_ERROR", "Kredi temel alanları zorunlu.");
  }
  const parsedCount = installmentCountSchema.safeParse(rawCount);
  if (!parsedCount.success) {
    throw new DomainError("VALIDATION_ERROR", "Taksit sayısı 1 ile 360 arasında tam sayı olmalı.");
  }
  const count = parsedCount.data;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const total = money(decimal(installment).times(decimal(count)));
    const financeCost = money(decimal(total).minus(decimal(principal)));
    const loan = await client.query(
      `insert into public.loans(name,principal,installment_count,first_payment_date,installment_amount,total_payment,total_finance_cost,status) values($1,$2,$3,$4,$5,$6,$7,'active') returning id`,
      [name, principal, count, first, installment, total, financeCost],
    );
    for (let i = 0; i < count; i++) {
      const { dueDate } = addMonthsPreservingAnchorDay(first, i);
      await client.query(
        `insert into public.loan_installments(loan_id,installment_no,due_date,amount,status) values($1,$2,$3,$4,'planned')`,
        [loan.rows[0].id, i + 1, dueDate, installment],
      );
    }
    await audit(client, {
      actor: session.id,
      action: "create_loan",
      entityTable: "loans",
      entityId: loan.rows[0].id,
      after: { name, principal, count },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (isPgPeriodLockedError(error) || isHandledActionError(error)) {
      errorRedirect("/finance/loans", toUserActionErrorMessage(error, "Kredi kaydı oluşturulamadı."));
    }
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/finance");
  redirect("/finance/loans");
}

function backOf(formData: FormData, fallback: string): string {
  return safeRedirectPath(formData.get("backTo"), fallback);
}
function errorRedirect(backTo: string, message: string): never {
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

export async function markCheckClearedAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckCleared(getPool(), id, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Çek tahsil işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markCheckBouncedAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckBounced(getPool(), id, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Karşılıksız çek işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markInstallmentPaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("loan_installments", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const raw = String(formData.get("paidAt") ?? "").trim();
  const backTo = backOf(formData, "/finance/loans");
  try {
    await markInstallmentPaid(getPool(), id, raw === "" ? null : raw, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Kredi taksiti ödeme işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function mapFinancingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "insert", "/finance");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  let checksCreated = 0;
  let loansCreated = 0;
  let installmentsCreated = 0;
  try {
    const c = await mapAcceptedChecks(pool, workbookId, session.id);
    const l = await mapLoans(pool, workbookId, session.id);
    checksCreated = c.created;
    loansCreated = l.created;
    installmentsCreated = l.installmentsCreated;
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance", toUserActionErrorMessage(e, "Finansman kayıtları eşleştirilemedi."));
    }
    throw e;
  }
  revalidatePath("/finance");
  redirect(`/finance?checks=${checksCreated}&loans=${loansCreated}&installments=${installmentsCreated}`);
}

export async function classifyUnknownCheckAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance/checks");
  const id = String(formData.get("id") ?? "").trim();
  const targetStatus = String(formData.get("targetStatus") ?? "").trim();
  const backTo = backOf(formData, "/finance/checks");
  if (!id || (targetStatus !== "in_portfolio" && targetStatus !== "issued_to_vendor")) {
    errorRedirect(backTo, "Çek sınıflandırması için geçerli hedef durum seçilmelidir.");
  }
  try {
    await classifyUnknownCheck(getPool(), id, targetStatus, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Çek sınıflandırma işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance/checks");
  revalidateFinancialViews();
}

export async function cancelCheckAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/finance/checks?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  try {
    await cancelCheck(getPool(), parsed.data.id, parsed.data.reason, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance/checks", toUserActionErrorMessage(e, "Çek iptal işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/checks");
}

export async function cancelLoanInstallmentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("loan_installments", "update", "/finance");
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/finance/loans?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  try {
    await cancelLoanInstallment(getPool(), parsed.data.id, parsed.data.reason, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance/loans", toUserActionErrorMessage(e, "Kredi taksiti iptal işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/loans");
}
