"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { parseFilters } from "@/lib/ui/filters";
import { deleteView, MODULE_KEYS, type ModuleKey, saveView } from "@/lib/ui/saved-views";

function safeReturnPath(raw: FormDataEntryValue | null): string {
  const s = String(raw ?? "/").trim();
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  return s;
}

export async function saveCurrentViewAction(formData: FormData) {
  const user = await requireActionPermission("saved_views", "insert");
  const returnPath = safeReturnPath(formData.get("return_path"));
  const moduleKeyRaw = String(formData.get("module_key") ?? "payments");
  const moduleKey: ModuleKey = (MODULE_KEYS as readonly string[]).includes(moduleKeyRaw)
    ? (moduleKeyRaw as ModuleKey)
    : "payments";
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(returnPath);
  }
  const filters = parseFilters({
    dp: String(formData.get("dp") ?? "all") || "all",
    df: String(formData.get("df") ?? "") || undefined,
    dt: String(formData.get("dt") ?? "") || undefined,
    cur: String(formData.get("cur") ?? "") || undefined,
    q: String(formData.get("q") ?? "") || undefined,
  });
  const isShared = formData.get("is_shared") === "on";
  const isDefault = formData.get("is_default") === "on";

  await saveView(
    getPool(),
    {
      name,
      moduleKey,
      filters,
      isShared,
      isDefault,
    },
    user.id,
  );
  revalidatePath(returnPath.split("?")[0]);
  redirect(returnPath);
}

export async function deleteSavedViewAction(formData: FormData) {
  const user = await requireActionPermission("saved_views", "delete");
  const returnPath = safeReturnPath(formData.get("return_path"));
  const id = String(formData.get("view_id") ?? "").trim();
  if (id) {
    await deleteView(getPool(), id, user.id);
  }
  revalidatePath(returnPath.split("?")[0]);
  redirect(returnPath);
}

