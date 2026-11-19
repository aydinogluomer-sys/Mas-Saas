"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission, requireSession, safeRedirectPath } from "@/lib/auth";
import { addEntityComment } from "@/lib/collaboration/comments";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";

const LOCALE_COOKIE = "mas_locale";

const setLocaleFormSchema = z.object({
  locale: z.enum(["tr", "en"]),
  returnTo: z.string().optional(),
});

const addCommentFormSchema = z.object({
  entityTable: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,64}$/, "Geçersiz hedef tablo adı."),
  entityId: z.string().trim().min(1, "Hedef kayıt kimliği zorunlu.").max(120),
  body: z
    .string()
    .trim()
    .min(1, "Yorum metni boş olamaz.")
    .max(4000, "Yorum metni en fazla 4000 karakter olabilir."),
  returnTo: z.string().optional(),
});

function cleanReturnUrl(rawReturnTo: string | undefined, fallback = "/"): {
  safeHref: string;
  pathnameOnly: string;
} {
  const safeHref = safeRedirectPath(rawReturnTo ?? fallback, fallback);
  const [pathnameOnly] = safeHref.split("?");
  return { safeHref, pathnameOnly: pathnameOnly || "/" };
}

function appendQueryParam(href: string, key: string, value: string): string {
  const [basePath, existingQuery] = href.split("?");
  const params = new URLSearchParams(existingQuery ?? "");
  params.delete("commentError");
  params.delete("commentSaved");
  params.set(key, value);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export async function setExecutiveLocaleAction(formData: FormData): Promise<void> {
  await requireSession();
  const parsed = setLocaleFormSchema.safeParse({
    locale: String(formData.get("locale") ?? "tr").trim().toLowerCase(),
    returnTo: String(formData.get("returnTo") ?? "/"),
  });

  const nextLocale = parsed.success ? parsed.data.locale : "tr";
  const { safeHref } = cleanReturnUrl(
    parsed.success ? parsed.data.returnTo : String(formData.get("returnTo") ?? "/"),
  );

  const jar = await cookies();
  jar.set(LOCALE_COOKIE, nextLocale, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
  redirect(safeHref);
}

export async function addEntityCommentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("entity_comments", "insert", "/");
  const rawReturnTo = String(formData.get("returnTo") ?? "/");
  const { safeHref, pathnameOnly } = cleanReturnUrl(rawReturnTo, "/");

  const parsed = addCommentFormSchema.safeParse({
    entityTable: String(
      formData.get("entityTable") ?? formData.get("entityType") ?? "",
    ),
    entityId: String(formData.get("entityId") ?? ""),
    body: String(formData.get("body") ?? ""),
    returnTo: safeHref,
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Geçersiz yorum verisi.";
    redirect(appendQueryParam(safeHref, "commentError", msg));
  }

  try {
    await addEntityComment(getPool(), {
      entityTable: parsed.data.entityTable,
      entityId: parsed.data.entityId,
      body: parsed.data.body,
      actorId: session.id,
    });
  } catch (err) {
    if (err instanceof DomainError) {
      redirect(appendQueryParam(safeHref, "commentError", err.message));
    }
    throw err;
  }

  revalidatePath(pathnameOnly);
  revalidatePath("/", "layout");
  redirect(appendQueryParam(safeHref, "commentSaved", "1"));
}

