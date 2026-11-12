"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  calculatePartProfitability,
  mapCapacitySheet,
  mapCostSheets,
  mapFinanceCostAllocations,
  mapMachineMinuteAllocations,
  mapMachineRoi,
  upsertCapacityModelManual,
  upsertCostModelManual,
  upsertMachineRoiManual,
} from "@/lib/production/engine";

function revalidateProduction(): void {
  revalidatePath("/production");
  revalidatePath("/production/capacity");
  revalidatePath("/production/costs");
  revalidatePath("/production/roi");
  revalidatePath("/production/profitability");
  revalidatePath("/finance/profitability");
}

function optNum(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function mapProductionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("capacity_models", "insert", "/production");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const cap = await mapCapacitySheet(pool, workbookId, session.id);
  const cost = await mapCostSheets(pool, workbookId, session.id);
  const prof = await calculatePartProfitability(pool);
  await mapMachineRoi(pool, workbookId, session.id);
  const minutes = await mapMachineMinuteAllocations(pool, workbookId, session.id);
  const finance = await mapFinanceCostAllocations(pool, workbookId, session.id);
  revalidateProduction();
  redirect(
    `/production?parts=${cap.partsCreated}&cost=${cost.created}&runs=${prof.runsCreated}&minutes=${minutes.created}&finance=${finance.created}`,
  );
}

export async function upsertCapacityParameterAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "capacity_models",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production");
  try {
    await upsertCapacityModelManual(
      getPool(),
      {
        name: String(formData.get("name") ?? "").trim(),
        scenarioType: String(formData.get("scenarioType") ?? "normal"),
        workDaysPerMonth: Number(formData.get("workDaysPerMonth") ?? 22),
        hoursPerDay: Number(formData.get("hoursPerDay") ?? 8),
        efficiencyRate: Number(formData.get("efficiencyRate") ?? 0.85),
        tornaRateTLPerMin: optNum(formData.get("tornaRateTLPerMin")),
        frezeRateTLPerMin: optNum(formData.get("frezeRateTLPerMin")),
        rateYear: optNum(formData.get("rateYear")),
        notes: String(formData.get("notes") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=kapasite-kaydedildi`);
}

export async function upsertCostModelItemAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "cost_models",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/costs"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/costs");
  try {
    await upsertCostModelManual(
      getPool(),
      {
        scenarioType: String(formData.get("scenarioType") ?? "normal"),
        costCategory: String(formData.get("costCategory") ?? "").trim(),
        description: String(formData.get("description") ?? "").trim() || undefined,
        monthlyAmount: Number(formData.get("monthlyAmount") ?? 0),
        staffCount: optNum(formData.get("staffCount")),
        monthlyWorkHours: optNum(formData.get("monthlyWorkHours")),
        efficiencyRate: optNum(formData.get("efficiencyRate")),
        notes: String(formData.get("notes") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=maliyet-kaydedildi`);
}

export async function upsertMachineRoiParameterAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "machine_assets",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/roi"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/roi");
  try {
    await upsertMachineRoiManual(
      getPool(),
      {
        name: String(formData.get("name") ?? "").trim(),
        machineCode: String(formData.get("machineCode") ?? "").trim() || undefined,
        purchaseDate: String(formData.get("purchaseDate") ?? "").trim() || null,
        purchaseCost: optNum(formData.get("purchaseCost")),
        monthlyRevenue: optNum(formData.get("monthlyRevenue")),
        monthlyOperatingCost: optNum(formData.get("monthlyOperatingCost")),
        annualMaintenanceCost: optNum(formData.get("annualMaintenanceCost")),
        utilizationRate: optNum(formData.get("utilizationRate")),
        usefulLifeMonths: optNum(formData.get("usefulLifeMonths")),
        snapshotYear: optNum(formData.get("snapshotYear")),
        annualRevenue: optNum(formData.get("annualRevenue")),
        annualCost: optNum(formData.get("annualCost")),
        notes: String(formData.get("notes") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=makine-kaydedildi`);
}
