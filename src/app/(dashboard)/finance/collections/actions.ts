"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import { clearBadDebt, markBadDebt } from "@/lib/collections/engine";
import { formatMoney } from "@/lib/money-format";
import {
  cancelPaymentRun,
  createPaymentRun,
  PAYMENT_RUN_TARGET_TYPES,
  submitPaymentRunForApproval,
  type PaymentRunTargetType,
} from "@/lib/payments/payment-runs";
import { istanbulDateISO } from "@/lib/reports/rules";

const BASE = "/finance/collections";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function markBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await markBadDebt(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=supheli-alacak-isaretlendi`);
}

export async function clearBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await clearBadDebt(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=isaret-kaldirildi`);
}

function isPaymentRunTargetType(v: string): v is PaymentRunTargetType {
  return (PAYMENT_RUN_TARGET_TYPES as readonly string[]).includes(v);
}

export async function createPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "insert", BASE);
  const sourceBankAccountId = String(formData.get("sourceBankAccountId") ?? "").trim();
  const plannedExecutionDate = String(formData.get("plannedExecutionDate") ?? "").trim();
  const currency = String(formData.get("currency") ?? "TRY").trim().toUpperCase() || "TRY";
  const notes = String(formData.get("notes") ?? "").trim();
  const rawTargets = formData.getAll("selectedTargets").map((x) => String(x));

  const items: Array<{ targetType: PaymentRunTargetType; targetId: string }> = [];
  for (const token of rawTargets) {
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    const tType = token.slice(0, idx);
    const tId = token.slice(idx + 1);
    if (isPaymentRunTargetType(tType) && tId) {
      items.push({ targetType: tType, targetId: tId });
    }
  }

  if (items.length === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Ödeme paketi için en az bir uygun borç/ödeme kalemi seçin.")}`);
  }

  let summary = "";
  try {
    const res = await createPaymentRun(
      getPool(),
      {
        sourceBankAccountId,
        plannedExecutionDate,
        currency,
        notes: notes || undefined,
        items,
      },
      session.id,
      istanbulDateISO(),
    );
    const min14Label =
      res.simulation.projected14dMinCash == null
        ? "14g min kasa: bilinmiyor"
        : `14g min kasa: ${formatMoney(res.simulation.projected14dMinCash, currency)}`;
    const floorWarn = res.simulation.breachesCashFloor ? " [ASGARİ KASA TAMPONU AŞILDI]" : "";
    summary = `${res.runCode} oluşturuldu (${res.itemCount} kalem · ${formatMoney(res.totalAmount, currency)} · ${min14Label})${floorWarn}`;
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
}

export async function submitPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "update", BASE);
  try {
    await submitPaymentRunForApproval(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/data/approvals");
  redirect(`${BASE}?result=${encodeURIComponent("Ödeme paketi maker-checker onayına gönderildi.")}`);
}

export async function cancelPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "update", BASE);
  try {
    await cancelPaymentRun(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/data/approvals");
  redirect(`${BASE}?result=${encodeURIComponent("Ödeme paketi iptal edildi ve kalemler serbest bırakıldı.")}`);
}
