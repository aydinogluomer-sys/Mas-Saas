"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { safeRedirectPath } from "@/lib/security/redirect";
import {
  ACTIVE_BRANCH_COOKIE,
  ACTIVE_LEGAL_ENTITY_COOKIE,
  CONSOLIDATED_ENTITY_TOKEN,
  createBranch,
  createLegalEntity,
} from "./engine";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function switchActiveEntityAction(formData: FormData): Promise<void> {
  await requireSession();

  const entityRaw = String(formData.get("legalEntityId") ?? "").trim();
  const branchRaw = String(formData.get("branchId") ?? "").trim();
  const returnTo = safeRedirectPath(String(formData.get("returnTo") ?? "/"), "/");

  const jar = await cookies();
  const cookieOpts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 365 * 24 * 60 * 60,
  };

  if (!entityRaw || entityRaw === CONSOLIDATED_ENTITY_TOKEN) {
    jar.set(ACTIVE_LEGAL_ENTITY_COOKIE, CONSOLIDATED_ENTITY_TOKEN, cookieOpts);
    jar.delete(ACTIVE_BRANCH_COOKIE);
  } else if (UUID_RE.test(entityRaw)) {
    jar.set(ACTIVE_LEGAL_ENTITY_COOKIE, entityRaw, cookieOpts);
    if (UUID_RE.test(branchRaw)) {
      jar.set(ACTIVE_BRANCH_COOKIE, branchRaw, cookieOpts);
    } else {
      jar.delete(ACTIVE_BRANCH_COOKIE);
    }
  }

  revalidatePath("/", "layout");
  redirect(returnTo);
}

export async function createLegalEntityAction(formData: FormData): Promise<void> {
  const user = await requireActionPermission("legal_entities", "insert", "/system/features");
  await createLegalEntity(
    getPool(),
    {
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      taxIdVkn: String(formData.get("taxIdVkn") ?? "") || null,
      mersisNo: String(formData.get("mersisNo") ?? "") || null,
      taxOffice: String(formData.get("taxOffice") ?? "") || null,
      baseCurrency: String(formData.get("baseCurrency") ?? "TRY") || "TRY",
    },
    user.id,
  );
  revalidatePath("/", "layout");
  redirect(safeRedirectPath(String(formData.get("returnTo") ?? "/system/features"), "/system/features"));
}

export async function createBranchAction(formData: FormData): Promise<void> {
  const user = await requireActionPermission("branches", "insert", "/system/features");
  await createBranch(
    getPool(),
    {
      legalEntityId: String(formData.get("legalEntityId") ?? ""),
      code: String(formData.get("code") ?? ""),
      name: String(formData.get("name") ?? ""),
      city: String(formData.get("city") ?? "") || null,
      isHeadquarters: formData.get("isHeadquarters") === "on" || formData.get("isHeadquarters") === "true",
    },
    user.id,
  );
  revalidatePath("/", "layout");
  redirect(safeRedirectPath(String(formData.get("returnTo") ?? "/system/features"), "/system/features"));
}
