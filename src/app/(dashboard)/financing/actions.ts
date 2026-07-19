"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { mapAcceptedChecks, mapLoans, cancelCheck, cancelLoanInstallment } from "@/lib/financing/engine";
import { cancelActionSchema } from "@/lib/validation/financial";

export async function mapFinancingAction(formData: FormData): Promise<void> {
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const c = await mapAcceptedChecks(pool, workbookId);
  const l = await mapLoans(pool, workbookId);
  revalidatePath("/financing");
  redirect(`/financing?checks=${c.created}&loans=${l.created}&installments=${l.installmentsCreated}`);
}

export async function cancelCheckAction(formData: FormData): Promise<void> {
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/financing?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  await cancelCheck(getPool(), parsed.data.id, parsed.data.reason);
  revalidatePath("/financing");
}

export async function cancelLoanInstallmentAction(formData: FormData): Promise<void> {
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/financing?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  await cancelLoanInstallment(getPool(), parsed.data.id, parsed.data.reason);
  revalidatePath("/financing");
}
