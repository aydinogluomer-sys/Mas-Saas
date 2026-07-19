"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { ensureWindow } from "@/lib/radar/engine";
import { archivePayment, updatePaymentAndReconcile } from "@/lib/payments/engine";
import { DomainError } from "@/lib/domain-error";
import { istanbulDateISO } from "@/lib/time/istanbul";

// No individual user identity exists in this app (src/lib/auth.ts is a single shared-password
// access gate, not per-user accounts) — this is an explicit placeholder, not a silent null.
const ARCHIVED_BY_LABEL = "mas-dashboard";

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
    status: String(formData.get("status") ?? "active"),
    category_id: opt(formData.get("category_id")),
    provider_party_id: opt(formData.get("provider_party_id")),
    owner_party_id: opt(formData.get("owner_party_id")),
    cash_account_id: opt(formData.get("cash_account_id")),
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
          direction, priority, status, category_id, provider_party_id, owner_party_id,
          cash_account_id, description)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [f.name, f.recurrence_type, f.due_day, f.due_date, f.default_amount, f.amount_confidence,
       f.direction, f.priority, f.status, f.category_id, f.provider_party_id, f.owner_party_id,
       f.cash_account_id, f.description],
    );
    id = res.rows[0].id;
    await client.query(
      `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
       values (null,'create_payment','payments',$1,null,$2)`,
      [id, JSON.stringify(f)],
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  await ensureWindow(pool, istanbulDateISO());
  revalidatePath("/payments");
  revalidatePath("/radar");
  redirect("/payments");
}

export async function updatePaymentAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const f = readForm(formData);
  const err = validate(f);
  if (err) redirect(`/payments/${id}/edit?error=${encodeURIComponent(err)}`);
  try {
    await updatePaymentAndReconcile(getPool(), id, f, istanbulDateISO());
  } catch (e) {
    // Known domain failures (not found) become a safe redirect message. Anything else
    // (unexpected DB/system errors) is never swallowed or rewritten — it propagates.
    if (e instanceof DomainError) {
      redirect(`/payments/${id}/edit?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath("/payments");
  revalidatePath("/radar");
  redirect("/payments");
}

export async function archivePaymentAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("archive_reason") ?? "").trim();
  if (!id) return;
  if (!reason) redirect(`/payments/${id}/edit?error=${encodeURIComponent("Arşivleme nedeni zorunlu.")}`);
  await archivePayment(getPool(), id, { reason, archivedByLabel: ARCHIVED_BY_LABEL }, istanbulDateISO());
  revalidatePath("/payments");
  redirect("/payments");
}
