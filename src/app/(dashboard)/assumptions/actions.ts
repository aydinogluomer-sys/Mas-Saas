"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createExternalAssumption, setExternalAssumptionReviewStatus } from "@/lib/external-assumptions/engine";
import { normalizeReviewStatus } from "@/lib/external-assumptions/rules";
import { getPool } from "@/lib/db";

function numFromForm(v: FormDataEntryValue | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function createExternalAssumptionAction(formData: FormData): Promise<void> {
  const valueNumeric = numFromForm(formData.get("valueNumeric"));
  const sourceKind = String(formData.get("sourceKind") ?? "manual");
  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();
  if (sourceKind === "internet" && !sourceUrl) redirect("/data/assumptions?error=internet-source-url-required");
  if (valueNumeric != null) {
    await createExternalAssumption(getPool(), {
      assumptionType: String(formData.get("assumptionType") ?? "other"),
      label: String(formData.get("label") ?? ""),
      periodStart: String(formData.get("periodStart") ?? "") || null,
      periodEnd: String(formData.get("periodEnd") ?? "") || null,
      valueNumeric,
      unit: String(formData.get("unit") ?? ""),
      currency: String(formData.get("currency") ?? "TRY"),
      sourceKind,
      sourceName: String(formData.get("sourceName") ?? ""),
      sourceUrl: sourceUrl || null,
      sourceDate: String(formData.get("sourceDate") ?? ""),
      notes: String(formData.get("notes") ?? "") || null,
    });
  }
  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
  redirect("/data/assumptions?result=created");
}

export async function setExternalAssumptionReviewStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const status = normalizeReviewStatus(String(formData.get("reviewStatus") ?? ""));
  if (id && status) await setExternalAssumptionReviewStatus(getPool(), id, status);
  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
  redirect("/data/assumptions?result=reviewed");
}
