"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { mapCashflowMonths, validateContinuity, writeSnapshots } from "@/lib/cashflow/engine";
import { requireSession } from "@/lib/auth";

export async function mapCashflowAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const r = await mapCashflowMonths(pool, workbookId, session.id);
  await validateContinuity(pool); // flags only, never fixes
  await writeSnapshots(pool, new Date().toISOString().slice(0, 10));
  revalidatePath("/cashflow");
  redirect(`/cashflow?months=${r.monthsCreated}&lines=${r.linesCreated}`);
}
