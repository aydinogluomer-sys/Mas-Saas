"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import {
  ensureWindow,
  markInstancePaid,
  markInstanceUnpaid,
  markInstancePartial,
  cancelInstance,
  setInstanceAmount,
  mapAcceptedCandidates,
} from "@/lib/radar/engine";
import { archivePayment, requestApprovalsForOpenPaymentInstances, updatePaymentAndReconcile } from "@/lib/payments/engine";
import { cancelActionSchema } from "@/lib/validation/financial";
import { DomainError } from "@/lib/domain-error";
import { istanbulDateISO } from "@/lib/time/istanbul";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import { audit } from "@/lib/audit";

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
  };
}

function validate(f: ReturnType<typeof readForm>): string | null {
  if (!f.name) return "Ad zorunlu.";
  if (f.recurrence_type === "monthly" && (f.due_day == null || f.due_day < 1 || f.due_day > 31))
    return "Aylık tekrar için 1-31 arası gün zorunlu.";
  if (f.due_day != null && (f.due_day < 1 || f.due_day > 31)) return "Gün 1-31 arası olmalı.";
  return null;
}

export async function createPaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "insert", "/payments");
  const f = readForm(formData);
  const err = validate(f);
  if (err) redirect(`/payments/new?error=${encodeURIComponent(err)}`);
  const pool = getPool();
  const client = await pool.connect();
  let id = "";
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.payments
         (name, recurrence_type, due_day, due_date, default_amount, amount_confidence,
          direction, priority, flexibility_class, status, category_id, provider_party_id, owner_party_id,
          cash_account_id, cost_center_id, project_id, department_id, description)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
      [f.name, f.recurrence_type, f.due_day, f.due_date, f.default_amount, f.amount_confidence,
       f.direction, f.priority, f.flexibility_class, f.status, f.category_id, f.provider_party_id, f.owner_party_id,
       f.cash_account_id, f.cost_center_id, f.project_id, f.department_id, f.description],
    );
    id = res.rows[0].id;
    await audit(client, {
      actor: session.id, action: "create_payment", entityTable: "payments", entityId: id,
      before: null, after: f,
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  const todayISO = istanbulDateISO();
  await ensureWindow(pool, todayISO, session.id);
  if (f.direction === "outflow" && f.default_amount != null) {
    await requestApprovalsForOpenPaymentInstances(pool, id, todayISO, session.id);
  }
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/");
  redirect("/payments/items");
}

export async function updatePaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const f = readForm(formData);
  const err = validate(f);
  if (err) redirect(`/payments/${id}/edit?error=${encodeURIComponent(err)}`);
  try {
    await updatePaymentAndReconcile(getPool(), id, f, istanbulDateISO(), session.id);
  } catch (e) {
    if (e instanceof DomainError) {
      redirect(`/payments/${id}/edit?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/");
  redirect("/payments/items");
}

export async function archivePaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("archive_reason") ?? "").trim();
  if (!id) return;
  if (!reason) redirect(`/payments/${id}/edit?error=${encodeURIComponent("Arşivleme nedeni zorunlu.")}`);
  await archivePayment(getPool(), id, { reason, archivedByLabel: session.displayName }, istanbulDateISO(), session.id);
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/");
  redirect("/payments/items");
}

function backOf(formData: FormData): string {
  return safeRedirectPath(formData.get("backTo"), "/payments");
}

function errorRedirect(backTo: string, message: string): never {
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("paidAmount") ?? "").trim();
  const paidAmount = raw === "" ? null : Number(raw);
  if (!id || (raw !== "" && !Number.isFinite(paidAmount))) return;
  const backTo = backOf(formData);
  try {
    await markInstancePaid(getPool(), id, paidAmount, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function markUnpaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData);
  try {
    await markInstanceUnpaid(getPool(), id, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/payments");
  revalidatePath("/");
}

export async function markPartialAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_instances", "update", "/payments");
  const id = String(formData.get("id") ?? "");
  const paid = Number(formData.get("paidAmount"));
  const backTo = backOf(formData);
  try {
    await markInstancePartial(getPool(), id, paid, session.id);
  } catch (e) {
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath("/payments");
  revalidatePath("/payments/history");
  revalidatePath("/");
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
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
  }
  revalidatePath("/payments");
  revalidatePath("/payments/history");
  revalidatePath("/");
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
    if (e instanceof DomainError) errorRedirect(backTo, e.message);
    throw e;
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
  const r = await mapAcceptedCandidates(pool, workbookId, session.id);
  await ensureWindow(pool, new Date().toISOString().slice(0, 10), session.id);
  revalidatePath("/payments");
  revalidatePath("/");
  redirect(`/payments?mapped=${r.created}&skipped=${r.skippedAlreadyMapped}&excluded=${r.excluded.length}`);
}
