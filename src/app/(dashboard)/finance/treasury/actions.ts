"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { updatePolicy } from "@/lib/treasury/engine";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/finance/treasury";

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Change a treasury floor.
 *
 * requireAdmin, matching the `config` access class the table carries in migration 0062 and in
 * the permission matrix. The database would refuse a non-admin write anyway; this makes the
 * refusal a redirect the operator understands instead of a query that quietly touches no rows.
 */
export async function updatePolicyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  try {
    await updatePolicy(getPool(), {
      code: String(formData.get("code") ?? ""),
      thresholdAmount: numOrNull(formData.get("thresholdAmount")),
      thresholdDays: numOrNull(formData.get("thresholdDays")),
      isActive: String(formData.get("isActive") ?? "") === "on",
      notes: String(formData.get("notes") ?? "").trim() || undefined,
    }, admin.id);
  } catch (e) {
    if (e instanceof DomainError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(PAGE);
  revalidatePath("/cashflow");
  redirect(`${PAGE}?result=policy_updated`);
}
