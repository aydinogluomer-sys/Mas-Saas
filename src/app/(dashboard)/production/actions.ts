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
import {
  addBomLineAndUpsertHeader,
  createWorkOrder,
  deleteBomLine,
  recordInventoryMovement,
  setWorkCenterActive,
  simulateAndSaveCapexRoi,
  toggleCustomerRateCardActive,
  transitionWorkOrderStatus,
  upsertCustomerRateCard,
  upsertInventoryItem,
  upsertWorkCenter,
} from "@/lib/production/erp-lite";
import { formObject, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

function revalidateProduction(): void {
  revalidatePath("/production");
  revalidatePath("/production/capacity");
  revalidatePath("/production/costs");
  revalidatePath("/production/roi");
  revalidatePath("/production/profitability");
  revalidatePath("/finance/profitability");
  revalidatePath("/cashflow");
}

function optUuid(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
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

function appendFeedbackRedirect(back: string, key: "error" | "result", message: string): never {
  const sep = back.includes("?") ? "&" : "?";
  redirect(`${back}${sep}${key}=${encodeURIComponent(message)}`);
}

export async function upsertWorkCenterAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "work_centers",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=stations"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=stations");
  try {
    await upsertWorkCenter(
      getPool(),
      {
        id: optUuid(formData.get("id")),
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        operationType: String(formData.get("operationType") ?? "torna"),
        machineCount: Number(formData.get("machineCount") ?? 1),
        shiftsPerDay: Number(formData.get("shiftsPerDay") ?? 1),
        shiftMinutes: Number(formData.get("shiftMinutes") ?? 480),
        workingDaysPerMonth: Number(formData.get("workingDaysPerMonth") ?? 22),
        targetOeePct: Number(formData.get("targetOeePct") ?? 80),
        hourlyPowerKw: optNum(formData.get("hourlyPowerKw")),
        standardRatePerMinTry: optNum(formData.get("standardRatePerMinTry")),
        isActive: formData.get("isActive") !== "false",
      },
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "İş istasyonu kaydedildi");
}

export async function toggleWorkCenterActiveAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "work_centers",
    "update",
    safeRedirectPath(formData.get("backTo"), "/production?tab=stations"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=stations");
  try {
    await setWorkCenterActive(
      getPool(),
      String(formData.get("id") ?? ""),
      formData.get("isActive") === "true",
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "İstasyon durumu güncellendi");
}

export async function upsertInventoryItemAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "inventory_items",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=inventory"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=inventory");
  try {
    await upsertInventoryItem(
      getPool(),
      {
        id: optUuid(formData.get("id")),
        sku: String(formData.get("sku") ?? ""),
        name: String(formData.get("name") ?? ""),
        itemType: String(formData.get("itemType") ?? "raw_material"),
        tdhpAccountCode: String(formData.get("tdhpAccountCode") ?? "150"),
        unit: String(formData.get("unit") ?? "adet"),
        currency: String(formData.get("currency") ?? "TRY"),
        standardUnitCost: Number(formData.get("standardUnitCost") ?? 0),
        onHandQty: Number(formData.get("onHandQty") ?? 0),
        reorderPoint: Number(formData.get("reorderPoint") ?? 0),
        leadTimeDays: Number(formData.get("leadTimeDays") ?? 7),
        linkedPartId: optUuid(formData.get("linkedPartId")),
        isActive: formData.get("isActive") !== "false",
      },
      session.id,
    );
    await recalculateActivePartProfitability(getPool());
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "TDHP stok kartı kaydedildi");
}

export async function recordInventoryMovementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "inventory_movements",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=inventory"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=inventory");
  try {
    await recordInventoryMovement(
      getPool(),
      {
        itemId: String(formData.get("itemId") ?? ""),
        movementType: String(formData.get("movementType") ?? "receipt"),
        qty: Number(formData.get("qty") ?? 0),
        unitCost: optNum(formData.get("unitCost")),
        currency: String(formData.get("currency") ?? "").trim() || null,
        fxRateToTry: optNum(formData.get("fxRateToTry")),
        workOrderId: optUuid(formData.get("workOrderId")),
        occurredOn: String(formData.get("occurredOn") ?? "").trim() || undefined,
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "Stok hareketi işlendi; DIO & Nakit Döngüsü (CCC) güncellendi");
}

export async function addBomLineAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "bom_headers",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=bom"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=bom");
  const pool = getPool();
  try {
    await addBomLineAndUpsertHeader(
      pool,
      {
        partId: String(formData.get("partId") ?? ""),
        versionCode: String(formData.get("versionCode") ?? "V1"),
        batchSize: Number(formData.get("batchSize") ?? 1),
        subcontractCostPerUnit: Number(formData.get("subcontractCostPerUnit") ?? 0),
        subcontractCurrency: String(formData.get("subcontractCurrency") ?? "TRY"),
        notes: String(formData.get("notes") ?? "").trim() || null,
        rawMaterialItemId: optUuid(formData.get("rawMaterialItemId")),
        materialLabel: String(formData.get("materialLabel") ?? ""),
        qtyPerUnit: Number(formData.get("qtyPerUnit") ?? 1),
        scrapPct: Number(formData.get("scrapPct") ?? 0),
        unitCostOverride: optNum(formData.get("unitCostOverride")),
        currency: String(formData.get("currency") ?? "TRY"),
        workCenterId: optUuid(formData.get("workCenterId")),
        stdSetupMinutes: Number(formData.get("stdSetupMinutes") ?? 0),
        stdRunMinutes: Number(formData.get("stdRunMinutes") ?? 0),
      },
      session.id,
    );
    await recalculateActivePartProfitability(pool);
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "Ürün ağacı (BOM 710) satırı eklendi ve parça kârlılığı yenilendi");
}

export async function deleteBomLineAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "bom_lines",
    "delete",
    safeRedirectPath(formData.get("backTo"), "/production?tab=bom"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=bom");
  const pool = getPool();
  try {
    await deleteBomLine(pool, String(formData.get("lineId") ?? ""), session.id);
    await recalculateActivePartProfitability(pool);
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "BOM satırı silindi ve kârlılık yenilendi");
}

export async function createWorkOrderAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "work_orders",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=workorders"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=workorders");
  try {
    await createWorkOrder(
      getPool(),
      {
        orderNo: String(formData.get("orderNo") ?? ""),
        partId: optUuid(formData.get("partId")),
        bomId: optUuid(formData.get("bomId")),
        workCenterId: String(formData.get("workCenterId") ?? ""),
        partyId: optUuid(formData.get("partyId")),
        plannedQty: Number(formData.get("plannedQty") ?? 1),
        plannedMinutes: Number(formData.get("plannedMinutes") ?? 60),
        dueDate: String(formData.get("dueDate") ?? "").trim() || null,
      },
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "İş emri oluşturuldu");
}

export async function transitionWorkOrderStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "work_orders",
    "update",
    safeRedirectPath(formData.get("backTo"), "/production?tab=workorders"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=workorders");
  try {
    await transitionWorkOrderStatus(
      getPool(),
      {
        workOrderId: String(formData.get("workOrderId") ?? ""),
        nextStatus: String(formData.get("nextStatus") ?? "in_progress"),
        goodQty: optNum(formData.get("goodQty")),
        scrapQty: optNum(formData.get("scrapQty")),
        actualRunMinutes: optNum(formData.get("actualRunMinutes")),
        downtimeMinutes: optNum(formData.get("downtimeMinutes")),
        downtimeReason: String(formData.get("downtimeReason") ?? "").trim() || null,
      },
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "İş emri durumu ve canlı OEE güncellendi");
}

export async function upsertCustomerRateCardAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "customer_rate_cards",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production?tab=rates"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=rates");
  try {
    await upsertCustomerRateCard(
      getPool(),
      {
        id: optUuid(formData.get("id")),
        partyId: optUuid(formData.get("partyId")),
        customerLabel: String(formData.get("customerLabel") ?? ""),
        workCenterId: optUuid(formData.get("workCenterId")),
        operationType: String(formData.get("operationType") ?? "torna"),
        ratePerMinute: Number(formData.get("ratePerMinute") ?? 0),
        currency: String(formData.get("currency") ?? "TRY"),
        validFrom: String(formData.get("validFrom") ?? "").trim() || undefined,
        validTo: String(formData.get("validTo") ?? "").trim() || null,
        isActive: formData.get("isActive") !== "false",
      },
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "Müşteri tarife kartı kaydedildi");
}

export async function toggleCustomerRateCardAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "customer_rate_cards",
    "update",
    safeRedirectPath(formData.get("backTo"), "/production?tab=rates"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production?tab=rates");
  try {
    await toggleCustomerRateCardActive(
      getPool(),
      String(formData.get("id") ?? ""),
      formData.get("isActive") === "true",
      session.id,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
  revalidateProduction();
  appendFeedbackRedirect(back, "result", "Tarife kartı durumu güncellendi");
}

export async function simulateCapexRoiAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "machine_assets",
    "insert",
    safeRedirectPath(formData.get("backTo"), "/production/roi"),
  );
  const back = safeRedirectPath(formData.get("backTo"), "/production/roi");
  try {
    const out = await simulateAndSaveCapexRoi(
      getPool(),
      {
        machineName: String(formData.get("machineName") ?? ""),
        machineCode: String(formData.get("machineCode") ?? "").trim() || null,
        purchaseDate: String(formData.get("purchaseDate") ?? "").trim() || null,
        purchaseCostTry: Number(formData.get("purchaseCostTry") ?? 0),
        usefulLifeYears: Number(formData.get("usefulLifeYears") ?? 5),
        discountRatePct: Number(formData.get("discountRatePct") ?? 35),
        annualRevenueTry: Number(formData.get("annualRevenueTry") ?? 0),
        annualOperatingCostTry: Number(formData.get("annualOperatingCostTry") ?? 0),
        utilizationRate: optNum(formData.get("utilizationRate")),
        snapshotYear: optNum(formData.get("snapshotYear")),
        notes: String(formData.get("notes") ?? "").trim() || null,
      },
      session.id,
    );
    revalidateProduction();
    appendFeedbackRedirect(
      back,
      "result",
      `CAPEX fizibilite kaydedildi · NPV: ${out.feasibility.npvTry.toLocaleString("tr-TR")} TL · IRR: ${
        out.feasibility.irrPct != null ? `%${out.feasibility.irrPct.toFixed(2)}` : "—"
      }`,
    );
  } catch (err) {
    if (err instanceof DomainError) appendFeedbackRedirect(back, "error", err.message);
    throw err;
  }
}
