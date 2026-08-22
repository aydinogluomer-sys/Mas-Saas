"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { recordRate } from "@/lib/fx/engine";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/finance/fx";

/**
 * Record one observed rate by hand.
 *
 * This is the manual half of the TCMB integration. There is deliberately no "fetch now" button
 * wired to the live bulletin: the plan puts the automatic connection in Faz 37/38, and this
 * environment cannot reach tcmb.gov.tr, so a button that always failed would be worse than none.
 * `importRates` + `tcmbProvider` exist and are exercised by the gate, ready for that phase.
 */
export async function recordRateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
    // A refused rate is an answer the operator must read — most often "already recorded",
    // which an append-only table cannot resolve by overwriting.
    if (e instanceof DomainError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?result=rate_recorded`);
}
