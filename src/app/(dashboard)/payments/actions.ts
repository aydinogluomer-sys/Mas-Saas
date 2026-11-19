"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import {
  archivePaymentWithCascade,
  cancelInstance,
  createPayment,
  ensureWindow,
  linkPaymentInstanceToInvoice,
  mapAcceptedCandidates,
  markInstancePaid,
  markInstancePartial,
  markInstanceUnpaid,
  setInstanceAmount,
  updatePaymentWithCascade,
} from "@/lib/radar/engine";
import { requestApprovalsForOpenPaymentInstances } from "@/lib/payments/engine";
import {
  createPaymentRun,
  submitPaymentRunForApproval,
  type PaymentRunTargetType,
} from "@/lib/payments/payment-runs";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { cancelActionSchema } from "@/lib/validation/financial";
import { DomainError } from "@/lib/domain-error";
import { istanbulDateISO } from "@/lib/time/istanbul";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";

const num = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const opt = (v: FormDataEntryValue | null): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

function readForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    recurrence_type: String(formData.get("recurrence_type") ?? "monthly"),
    due_day: num(formData.get("due_day")),
    due_date: opt(formData.get("due_date")),
    default_amount: num(formData.get("default_amount")), // empty stays NULL, never 0
    currency: (opt(formData.get("currency")) ?? "TRY").toUpperCase(),
    amount_confidence: String(formData.get("amount_confidence") ?? "known"),
    direction: String(formData.get("direction") ?? "outflow"),
    priority: String(formData.get("priority") ?? "normal"),
    flexibility_class: opt(formData.get("flexibility_class")),
    status: String(formData.get("status") ?? "active"),
    category_id: opt(formData.get("category_id")),
    provider_party_id: opt(formData.get("provider_party_id")),
    owner_party_id: opt(formData.get("owner_party_id")),
    cash_account_id: opt(formData.get("cash_account_id")),
    cost_center_id: opt(formData.get("cost_center_id")),
    project_id: opt(formData.get("project_id")),
    department_id: opt(formData.get("department_id")),
    description: opt(formData.get("description")),
    iban: opt(formData.get("iban")),
    tdhp_expense_code: opt(formData.get("tdhp_expense_code")),
    auto_match_vkn: opt(formData.get("auto_match_vkn")),
  };
}

function validate(f: ReturnType<typeof readForm>): string | null {
  if (!f.name) return "Ad zorunlu.";
  if (f.recurrence_type === "monthly" && (f.due_day == null || f.due_day < 1 || f.due_day > 31)) {
    return "Aylık tekrar için 1-31 arası gün zorunlu.";
  }
  if (f.recurrence_type === "one_off" && !f.due_date && f.due_day == null) {
    return "Tek seferlik ödeme için vade tarihi zorunlu.";
  }
  if (f.due_day != null && (f.due_day < 1 || f.due_day > 31)) return "Gün 1-31 arası olmalı.";
  if (!["TRY", "USD", "EUR", "GBP"].includes(f.currency)) return "Geçersiz döviz kodu.";
  return null;
}

function errorRedirect(backTo: string, message: string): never {
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

function handleCaughtPaymentError(e: unknown, backTo: string): never {
  if (isPgPeriodLockedError(e)) {
    errorRedirect(backTo, PERIOD_LOCKED_USER_MESSAGE);
  }
  try {
    translatePeriodLockError(e);
  } catch (translated) {
    if (translated instanceof DomainError) {
      errorRedirect(backTo, translated.message);
    }
    throw translated;
  }
}

export async function createPaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "insert", "/payments");
  const f = readForm(formData);
  const err = validate(f);
  if (err) redirect(`/payments/new?error=${encodeURIComponent(err)}`);
  const todayISO = istanbulDateISO();
  try {
    await createPayment(getPool(), f, todayISO, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, "/payments/new");
  }
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/payments/calendar");
  revalidatePath("/cashflow");
  revalidatePath("/");
  redirect("/payments/items");
}

export async function updatePaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const f = readForm(formData);
  const err = validate(f);
  if (err) redirect(`/payments/${id}/edit?error=${encodeURIComponent(err)}`);
  const todayISO = istanbulDateISO();
  const pool = getPool();
  try {
    await updatePaymentWithCascade(pool, id, f, todayISO, session.id);
    await requestApprovalsForOpenPaymentInstances(pool, id, todayISO, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, `/payments/${id}/edit`);
  }
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/payments/calendar");
  revalidatePath("/cashflow");
  revalidatePath("/");
  redirect("/payments/items");
}

export async function archivePaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("archive_reason") ?? "").trim();
  if (!id) return;
  if (!reason) redirect(`/payments/${id}/edit?error=${encodeURIComponent("Arşivleme nedeni zorunlu.")}`);
  try {
    await archivePaymentWithCascade(
      getPool(),
      id,
      { reason, archivedByLabel: session.displayName },
      istanbulDateISO(),
      session.id,
    );
  } catch (e) {
    handleCaughtPaymentError(e, `/payments/${id}/edit`);
  }
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/payments/calendar");
  revalidatePath("/");
  redirect("/payments/items");
}

import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";

function backOf(formData: FormData): string {
  return safeRedirectPath(formData.get("backTo"), "/payments");
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("paidAmount") ?? "").trim();
  const paidAmount = raw === "" ? null : Number(raw);
  const cashAccountId = opt(formData.get("cashAccountId"));
  if (!id || (raw !== "" && !Number.isFinite(paidAmount))) return;
  const backTo = backOf(formData);
  try {
    await markInstancePaid(getPool(), id, paidAmount, session.id, { cashAccountId });
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath(backTo);
  revalidateFinancialViews();
}

export async function markUnpaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData);
  try {
    await markInstanceUnpaid(getPool(), id, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath(backTo);
  revalidateFinancialViews();
}

export async function markPartialAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const paid = Number(formData.get("paidAmount"));
  const cashAccountId = opt(formData.get("cashAccountId"));
  const backTo = backOf(formData);
  try {
    await markInstancePartial(getPool(), id, paid, session.id, { cashAccountId });
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath("/payments/history");
  revalidateFinancialViews();
  redirect(backTo);
}

export async function linkInvoiceToInstanceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  const invoiceId = opt(formData.get("invoiceId"));
  const backTo = backOf(formData);
  if (!instanceId) return;
  try {
    await linkPaymentInstanceToInvoice(getPool(), {
      instanceId,
      invoiceId,
      actor: session.id,
    });
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath(backTo);
  revalidatePath("/payments");
  revalidatePath("/cashflow/13-week");
  revalidateFinancialViews();
}

export async function createQuickPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "insert", "/payments");
  const backTo = backOf(formData);
  const sourceBankAccountId = String(formData.get("sourceBankAccountId") ?? "").trim();
  const plannedExecutionDate = String(formData.get("plannedExecutionDate") ?? istanbulDateISO()).trim();
  const currency = (opt(formData.get("currency")) ?? "TRY").toUpperCase();
  const notes = opt(formData.get("notes")) ?? undefined;
  const rawTargets = formData.getAll("selectedTarget").map((v) => String(v).trim()).filter(Boolean);
  if (!sourceBankAccountId || rawTargets.length === 0) {
    errorRedirect(backTo, "Kaynak banka hesabı ve en az bir ödeme kalemi seçilmelidir.");
  }
  const items = rawTargets.map((token) => {
    const [targetType, targetId] = token.split(":");
    return {
      targetType: targetType as PaymentRunTargetType,
      targetId,
    };
  });
  try {
    await createPaymentRun(
      getPool(),
      { sourceBankAccountId, plannedExecutionDate, currency, notes, items },
      session.id,
      istanbulDateISO(),
    );
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath("/payments");
  revalidatePath("/bank");
  revalidateFinancialViews();
  redirect(backTo);
}

export async function submitPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "update", "/payments");
  const backTo = backOf(formData);
  const runId = String(formData.get("runId") ?? "").trim();
  const note = opt(formData.get("note")) ?? undefined;
  if (!runId) return;
  try {
    await submitPaymentRunForApproval(getPool(), { runId, note }, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath("/payments");
  revalidatePath("/approvals");
  redirect(backTo);
}

export async function cancelInstanceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const backTo = backOf(formData);
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) errorRedirect(backTo, "İptal için geçerli bir neden gerekli.");
  try {
    await cancelInstance(getPool(), parsed.data.id, parsed.data.reason, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath("/payments/history");
  revalidateFinancialViews();
  redirect(backTo);
}

export async function setAmountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));
  if (!id || !Number.isFinite(amount)) return;
  const backTo = backOf(formData);
  try {
    await setInstanceAmount(getPool(), id, amount, session.id);
  } catch (e) {
    handleCaughtPaymentError(e, backTo);
  }
  revalidatePath(backTo);
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function mapCandidatesAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "insert", "/payments");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  try {
    const r = await mapAcceptedCandidates(pool, workbookId, session.id);
    await ensureWindow(pool, istanbulDateISO(), session.id);
    revalidatePath("/payments");
    revalidatePath("/");
    redirect(`/payments?mapped=${r.created}&skipped=${r.skippedAlreadyMapped}&excluded=${r.excluded.length}`);
  } catch (e) {
    handleCaughtPaymentError(e, "/payments");
  }
}
