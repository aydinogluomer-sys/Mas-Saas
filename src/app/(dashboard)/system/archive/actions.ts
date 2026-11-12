"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { archiveRecord, restoreRecord } from "@/lib/archive/engine";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { DomainError } from "@/lib/domain-error";

export async function archiveRecordAction(formData: FormData) {
  const session = await requireActionPermission("payments", "delete", "/system/archive");
  const entity = String(formData.get("entity") ?? "");
  if (entity && !can(session.role, entity, "update")) {
    throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  const id = String(formData.get("id") ?? "");
  const back = safeRedirectPath(formData.get("backTo"), "/system/archive");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent("Arşivleme nedeni zorunlu.")}`);
  await archiveRecord(getPool(), entity, id, reason, session.id, session.displayName);
  revalidatePath(back);
  revalidatePath("/system/archive");
  redirect(back);
}

export async function restoreRecordAction(formData: FormData) {
  const session = await requireActionPermission("payments", "delete", "/system/archive");
  const entity = String(formData.get("entity") ?? "");
  if (entity && !can(session.role, entity, "update")) {
    throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  const id = String(formData.get("id") ?? "");
  const back = safeRedirectPath(formData.get("backTo"), "/system/archive");
  await restoreRecord(getPool(), entity, id, session.id);
  revalidatePath(back);
  revalidatePath("/system/archive");
  redirect(back);
}
