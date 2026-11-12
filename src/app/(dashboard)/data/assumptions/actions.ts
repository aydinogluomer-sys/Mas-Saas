"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createExternalAssumption, setExternalAssumptionReviewStatus } from "@/lib/external-assumptions/engine";
import { normalizeReviewStatus } from "@/lib/external-assumptions/rules";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";

function numFromForm(v: FormDataEntryValue | null): number | null {
  if (v == null || typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export async function createExternalAssumptionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("external_assumptions", "insert", "/data/assumptions");
  const valueNumeric = numFromForm(formData.get("valueNumeric"));
  const sourceKind = String(formData.get("sourceKind") ?? "manual");
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();
  if (sourceKind === "internet" && !sourceUrl) redirect("/data/assumptions?error=internet-source-url-required");
  if (valueNumeric == null) redirect("/data/assumptions?error=assumption-fields-required");

  const createdId = await createExternalAssumption(getPool(), {
    assumptionType: String(formData.get("assumptionType") ?? "other"),
    label: String(formData.get("label") ?? "").trim(),
    periodStart: String(formData.get("periodStart") ?? "").trim() || null,
    periodEnd: String(formData.get("periodEnd") ?? "").trim() || null,
    valueNumeric,
    unit: String(formData.get("unit") ?? "").trim(),
    currency: String(formData.get("currency") ?? "TRY").trim(),
    sourceKind,
    sourceName: String(formData.get("sourceName") ?? "").trim(),
    sourceUrl: sourceUrl || null,
    sourceDate: String(formData.get("sourceDate") ?? "").trim(),
    notes: String(formData.get("notes") ?? "").trim() || null,
  }, session.id);

  if (!createdId) redirect("/data/assumptions?error=assumption-fields-required");

  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
  redirect("/data/assumptions?result=created");
}

export async function setExternalAssumptionReviewStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("external_assumptions", "update", "/data/assumptions");
  const id = String(formData.get("id") ?? "").trim();
  const status = normalizeReviewStatus(String(formData.get("reviewStatus") ?? ""));
  if (!id || !status) redirect("/data/assumptions?error=assumption-review-invalid");
  await setExternalAssumptionReviewStatus(getPool(), id, status, session.id);
  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
  redirect("/data/assumptions?result=reviewed");
}

