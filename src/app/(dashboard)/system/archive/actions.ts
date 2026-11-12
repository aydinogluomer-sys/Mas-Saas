"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { archiveRecord, restoreRecord } from "@/lib/archive/engine";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { DomainError } from "@/lib/domain-error";

function appendQuery(base: string, params: Record<string, string>): string {
  const sep = base.includes("?") ? "&" : "?";
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}${sep}${qs}`;
}

export async function archiveRecordAction(formData: FormData) {
  const session = await requireActionPermission("payments", "delete", "/system/archive");
  const entity = String(formData.get("entity") ?? "");
  const back = safeRedirectPath(formData.get("backTo"), "/system/archive");
  if (entity && !can(session.role, entity, "update")) {
    redirect(appendQuery(back, { error: "Bu işlem için yetkiniz yok." }));
  }
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    redirect(appendQuery(back, { error: "Arşivleme nedeni zorunlu." }));
  }
  try {
    await archiveRecord(getPool(), entity, id, reason, session.id, session.displayName);
  } catch (err) {
    const msg = err instanceof DomainError ? err.message : "Kayıt arşivlenemedi.";
    redirect(appendQuery(back, { error: msg }));
  }
  revalidatePath(back);
  revalidatePath("/system/archive");
  redirect(appendQuery(back, { flash: "archived", nonce: String(Date.now()) }));
}

export async function restoreRecordAction(formData: FormData) {
  const session = await requireActionPermission("payments", "delete", "/system/archive");
  const entity = String(formData.get("entity") ?? "");
  const back = safeRedirectPath(formData.get("backTo"), "/system/archive");
  if (entity && !can(session.role, entity, "update")) {
    redirect(appendQuery(back, { error: "Bu işlem için yetkiniz yok." }));
  }
  if (session.role !== "admin" && session.role !== "finance_manager") {
    redirect(
      appendQuery(back, {
        error: "Arşivden geri yükleme işlemi yalnız admin veya finans müdürü tarafından yapılabilir.",
      }),
    );
  }
  const id = String(formData.get("id") ?? "");
  try {
    await restoreRecord(getPool(), entity, id, session.id);
  } catch (err) {
    const msg = err instanceof DomainError ? err.message : "Kayıt arşivden geri yüklenemedi.";
    redirect(appendQuery(back, { error: msg }));
  }
  revalidatePath(back);
  revalidatePath("/system/archive");
  redirect(appendQuery(back, { flash: "restored", nonce: String(Date.now()) }));
}
