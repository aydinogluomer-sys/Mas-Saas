"use server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import {
  markInstancePaid,
  markInstanceUnpaid,
  setInstanceAmount,
  mapAcceptedCandidates,
  cancelInstance,
} from "@/lib/radar/engine";
import { cancelActionSchema } from "@/lib/validation/financial";
import { DomainError } from "@/lib/domain-error";
import { redirect } from "next/navigation";

function backOf(formData: FormData): string {
  return String(formData.get("backTo") ?? "/radar");
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("paidAmount") ?? "").trim();
  const paidAmount = raw === "" ? null : Number(raw);
  if (!id || (raw !== "" && !Number.isFinite(paidAmount))) return;
  const backTo = backOf(formData);
  try {
    await markInstancePaid(getPool(), id, paidAmount);
  } catch (e) {
    // Known domain failures (not found, wrong source status) become a safe redirect message.
    // Anything else (unexpected DB/system errors) is never swallowed or rewritten — it
    // propagates so it surfaces as a real error instead of a misleading "handled" case.
    if (e instanceof DomainError) {
      redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(backTo);
}

export async function markUnpaidAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData);
  try {
    await markInstanceUnpaid(getPool(), id);
  } catch (e) {
    if (e instanceof DomainError) {
      redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(backTo);
}

export async function setAmountAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));
  if (!id || !Number.isFinite(amount)) return;
  const backTo = backOf(formData);
  try {
    await setInstanceAmount(getPool(), id, amount);
  } catch (e) {
    if (e instanceof DomainError) {
      redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(backTo);
}

export async function cancelInstanceAction(formData: FormData): Promise<void> {
  const backTo = backOf(formData);
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  await cancelInstance(getPool(), parsed.data.id, parsed.data.reason);
  revalidatePath(backTo);
}

export async function mapCandidatesAction(formData: FormData): Promise<void> {
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const r = await mapAcceptedCandidates(getPool(), workbookId);
  revalidatePath("/payments");
  redirect(`/payments?mapped=${r.created}&skipped=${r.skippedAlreadyMapped}&excluded=${r.excluded.length}`);
}
