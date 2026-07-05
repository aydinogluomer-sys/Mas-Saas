"use server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import {
  markInstancePaid,
  markInstanceUnpaid,
  setInstanceAmount,
  mapAcceptedCandidates,
} from "@/lib/radar/engine";
import { redirect } from "next/navigation";

function backOf(formData: FormData): string {
  return String(formData.get("backTo") ?? "/radar");
}

export async function markPaidAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const raw = String(formData.get("paidAmount") ?? "").trim();
  const paidAmount = raw === "" ? null : Number(raw);
  if (!id || (raw !== "" && !Number.isFinite(paidAmount))) return;
  await markInstancePaid(getPool(), id, paidAmount);
  revalidatePath(backOf(formData));
}

export async function markUnpaidAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  await markInstanceUnpaid(getPool(), id);
  revalidatePath(backOf(formData));
}

export async function setAmountAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const amount = Number(String(formData.get("amount") ?? ""));
  if (!id || !Number.isFinite(amount)) return;
  await setInstanceAmount(getPool(), id, amount);
  revalidatePath(backOf(formData));
}

export async function mapCandidatesAction(formData: FormData): Promise<void> {
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const r = await mapAcceptedCandidates(getPool(), workbookId);
  revalidatePath("/payments");
  redirect(`/payments?mapped=${r.created}&skipped=${r.skippedAlreadyMapped}&excluded=${r.excluded.length}`);
}
