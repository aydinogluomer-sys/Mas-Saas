"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import {
  calculatePartProfitability,
  mapCapacitySheet,
  mapCostSheets,
} from "@/lib/production/engine";

export async function mapProductionAction(formData: FormData): Promise<void> {
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const cap = await mapCapacitySheet(pool, workbookId);
  const cost = await mapCostSheets(pool, workbookId);
  const prof = await calculatePartProfitability(pool);
  revalidatePath("/production");
  redirect(`/production?parts=${cap.partsCreated}&cost=${cost.created}&runs=${prof.runsCreated}`);
}
