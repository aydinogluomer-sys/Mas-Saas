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
  recalculateActivePartProfitability,
  upsertCapacityModelManual,
  upsertCatalogProductManual,
  upsertCostModelManual,
  upsertMachineRoiManual,
  upsertOperationRatesManual,
  upsertProductionPartManual,
} from "@/lib/production/engine";
import { formObject, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

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

const partFormSchema = z.object({
  id: z.string().trim().optional(),
  partCode: z.string().trim().optional(),
  partName: z.string().trim().min(1, "Parça adı gerekli").max(200),
  quantity: z.coerce.number().int().positive("Adet en az 1 olmalı"),
  tornaMinutes: z.string().trim().optional(),
  frezeMinutes: z.string().trim().optional(),
  otherOperationMinutes: z.string().trim().optional(),
  unitSalePrice: z.string().trim().optional(),
  currency: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export async function upsertProductionPartAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "production_parts",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/costs"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/costs");
  try {
    const parsed = parseOrThrow(partFormSchema, formObject(formData), "Üretim parçası formu");
    await upsertProductionPartManual(
      getPool(),
      {
        id: parsed.id || null,
        partCode: parsed.partCode || null,
        partName: parsed.partName,
        quantity: parsed.quantity,
        tornaMinutes: optNum(parsed.tornaMinutes ?? null),
        frezeMinutes: optNum(parsed.frezeMinutes ?? null),
        otherOperationMinutes: optNum(parsed.otherOperationMinutes ?? null),
        unitSalePrice: optNum(parsed.unitSalePrice ?? null),
        currency: parsed.currency || "TRY",
        notes: parsed.notes || null,
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=parca-ve-karlilik-guncellendi`);
}

const operationRatesFormSchema = z.object({
  scenarioType: z.enum(["normal", "overtime", "custom"]).default("normal"),
  tornaRateTLPerMin: z.string().trim().optional(),
  frezeRateTLPerMin: z.string().trim().optional(),
  akonTornaTLPerMin: z.string().trim().optional(),
  akonFrezeTLPerMin: z.string().trim().optional(),
  effectiveMonthlyMinutes: z.string().trim().optional(),
  rateYear: z.string().trim().optional(),
});

export async function upsertOperationRatesAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "cost_models",
    "update",
    safeRedirectPath(formData.get("backTo"), "/production/costs"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/costs");
  try {
    const parsed = parseOrThrow(operationRatesFormSchema, formObject(formData), "Dakika tarifesi formu");
    await upsertOperationRatesManual(
      getPool(),
      {
        scenarioType: parsed.scenarioType,
        tornaRateTLPerMin: optNum(parsed.tornaRateTLPerMin ?? null),
        frezeRateTLPerMin: optNum(parsed.frezeRateTLPerMin ?? null),
        akonTornaTLPerMin: optNum(parsed.akonTornaTLPerMin ?? null),
        akonFrezeTLPerMin: optNum(parsed.akonFrezeTLPerMin ?? null),
        effectiveMonthlyMinutes: optNum(parsed.effectiveMonthlyMinutes ?? null),
        rateYear: optNum(parsed.rateYear ?? null),
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=tarife-ve-karlilik-guncellendi`);
}

const catalogProductFormSchema = z.object({
  id: z.string().trim().optional(),
  code: z.string().trim().min(1, "Ürün kodu gerekli").max(80),
  name: z.string().trim().min(1, "Ürün adı gerekli").max(200),
  unit: z.string().trim().optional(),
  isActive: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

export async function upsertCatalogProductAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "products",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/costs"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/costs");
  try {
    const parsed = parseOrThrow(catalogProductFormSchema, formObject(formData), "Katalog ürünü formu");
    await upsertCatalogProductManual(
      getPool(),
      {
        id: parsed.id || null,
        code: parsed.code,
        name: parsed.name,
        unit: parsed.unit || null,
        isActive: parsed.isActive !== "false",
        notes: parsed.notes || null,
      },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) redirect(`${back}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  revalidateProduction();
  redirect(`${back}?result=katalog-urunu-kaydedildi`);
}

export async function recalculateProfitabilityAction(formData: FormData): Promise<void> {
  await requireActionPermission(
    "part_profitability_runs",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/costs"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/costs");
  const res = await recalculateActivePartProfitability(getPool());
  revalidateProduction();
  redirect(`${back}?result=${encodeURIComponent(`Kârlılık yeniden hesaplandı (${res.runsCreated} satır güncellendi)`)}`);
}
