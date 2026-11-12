"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";
import { createPromise, detectBrokenPromises, resolvePromise } from "@/lib/collections/promises-engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/finance/promises";

function revalidateAll(): void {
  revalidatePath(PAGE);
  revalidatePath("/finance/collections");
  revalidatePath("/finance/receivables");
  revalidatePath("/insights");
}

function fail(e: unknown): never {
  if (e instanceof DomainError) {
    revalidateAll();
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function createPromiseAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "insert", PAGE);
  try {
    await createPromise(getPool(), {
      partyId: String(formData.get("partyId") ?? ""),
      invoiceId: String(formData.get("invoiceId") ?? "").trim() || null,
      promisedAmount: numOrNull(formData.get("promisedAmount")),
      currency: String(formData.get("currency") ?? "TRY"),
      promisedDate: String(formData.get("promisedDate") ?? ""),
      channel: String(formData.get("channel") ?? "phone"),
      note: String(formData.get("note") ?? "").trim() || undefined,
    }, session.id);
  } catch (e) { fail(e); }
  revalidateAll();
  redirect(`${PAGE}?result=created`);
}

export async function resolvePromiseAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "update", PAGE);
  try {
    await resolvePromise(getPool(), {
      promiseId: String(formData.get("promiseId") ?? ""),
      status: String(formData.get("status") ?? ""),
      note: String(formData.get("note") ?? "").trim() || undefined,
    }, session.id);
  } catch (e) { fail(e); }
  revalidateAll();
  redirect(`${PAGE}?result=resolved`);
}

export async function detectBrokenAction(): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "update", PAGE);
  const result = await detectBrokenPromises(getPool(), istanbulDateISO(), session.id);
  revalidateAll();
  redirect(`${PAGE}?result=detected&n=${result.markedBroken}`);
}
