"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import {
  calculatePartProfitability,
  mapFinanceCostAllocations,
  mapCapacitySheet,
  mapCostSheets,
  mapMachineRoi,
  mapMachineMinuteAllocations,
} from "@/lib/production/engine";
import { requireSession } from "@/lib/auth";

export async function mapProductionAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const cap = await mapCapacitySheet(pool, workbookId, session.id);
  const cost = await mapCostSheets(pool, workbookId, session.id);
  const prof = await calculatePartProfitability(pool);
  // machine ROI is blocked until the personal_data_mixed review is resolved (human sign-off);
  // running it here is safe — it no-ops while blocked and maps once the review is cleared.
  await mapMachineRoi(pool, workbookId, session.id);
  const minutes = await mapMachineMinuteAllocations(pool, workbookId, session.id);
  const finance = await mapFinanceCostAllocations(pool, workbookId, session.id);
  revalidatePath("/production");
  redirect(`/production?parts=${cap.partsCreated}&cost=${cost.created}&runs=${prof.runsCreated}&minutes=${minutes.created}&finance=${finance.created}`);
}
