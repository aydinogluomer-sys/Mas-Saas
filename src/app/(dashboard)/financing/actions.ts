"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { mapAcceptedChecks, mapLoans } from "@/lib/financing/engine";

export async function mapFinancingAction(formData: FormData): Promise<void> {
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const c = await mapAcceptedChecks(pool, workbookId);
  const l = await mapLoans(pool, workbookId);
  revalidatePath("/financing");
  redirect(`/financing?checks=${c.created}&loans=${l.created}&installments=${l.installmentsCreated}`);
}
