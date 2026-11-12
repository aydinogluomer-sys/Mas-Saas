"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { parseFilters } from "@/lib/ui/filters";
import {
  buildSavedViewHrefPreservingContext,
  defaultViewFor,
  deleteView,
  listSavedViews,
  MODULE_KEYS,
  type ModuleKey,
  saveView,
  touchSavedView,
} from "@/lib/ui/saved-views";
import { formObject, parseOrThrow } from "@/lib/validation";

function safeReturnPath(raw: FormDataEntryValue | string | null | undefined): string {
  const s = String(raw ?? "/").trim();
  if (!s.startsWith("/") || s.startsWith("//")) return "/";
  return s;
}

function parseContextJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const ApplySavedViewSchema = z.object({
  view_id: z.string().uuid("Geçerli görünüm kimliği gerekli"),
  module_key: z.enum(MODULE_KEYS).default("payments"),
  base_path: z.string().trim().min(1).default("/"),
  context_json: z.string().optional(),
});

const ApplyDefaultSavedViewSchema = z.object({
  module_key: z.enum(MODULE_KEYS).default("payments"),
  base_path: z.string().trim().min(1).default("/"),
  context_json: z.string().optional(),
});

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

export async function applySavedViewAction(formData: FormData): Promise<void> {
  const user = await requireSession();
  const parsed = parseOrThrow(ApplySavedViewSchema, formObject(formData), "Kayıtlı görünüm seçimi");
  const basePath = safeReturnPath(parsed.base_path);
  const contextParams = parseContextJson(parsed.context_json);
  const pool = getPool();

  const views = await listSavedViews(pool, parsed.module_key, user.id).catch(() => []);
  const selected = views.find((v) => v.id === parsed.view_id) ?? null;

  if (selected && user.role !== "viewer") {
    await touchSavedView(pool, selected.id, user.id);
  }

  redirect(buildSavedViewHrefPreservingContext(basePath, contextParams, selected?.filters ?? null));
}

export async function applyDefaultSavedViewAction(formData: FormData): Promise<void> {
  const user = await requireSession();
  const parsed = parseOrThrow(ApplyDefaultSavedViewSchema, formObject(formData), "Varsayılan görünüm seçimi");
  const basePath = safeReturnPath(parsed.base_path);
  const contextParams = parseContextJson(parsed.context_json);
  const pool = getPool();

  const def = await defaultViewFor(pool, parsed.module_key, user.id).catch(() => null);
  if (def && user.role !== "viewer") {
    await touchSavedView(pool, def.id, user.id);
  }

  redirect(buildSavedViewHrefPreservingContext(basePath, contextParams, def?.filters ?? null));
}

