"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";
import { recordRate } from "@/lib/fx/engine";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/finance/fx";

export async function recordRateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("fx_rate_snapshots", "insert", PAGE);
  const rate = Number(formData.get("rate"));
  try {
    await recordRate(getPool(), {
      baseCurrency: String(formData.get("baseCurrency") ?? "").trim().toUpperCase(),
      quoteCurrency: "TRY",
      rateDate: String(formData.get("rateDate") ?? ""),
      rate: Number.isFinite(rate) ? rate : 0,
      source: String(formData.get("source") ?? "manual"),
      sourceRef: "elle girildi",
    }, session.id);
  } catch (e) {
    if (e instanceof DomainError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?result=rate_recorded`);
}
