import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, money, rate, rateOrNull, sumDecimal } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

const round2 = money;
const num = (v: string | number | null | undefined) => (v == null || v === "" ? 0 : rate(v));
const numOrNull = rateOrNull;
const sumDecimals = sumDecimal;
import {
  convertAmountToTry,
  loadLatestSpotRatesToTry,
  normalizeCurrency,
  type Queryable,
  type SpotRateMap,
} from "./fx-rates";

export const INVENTORY_ITEM_TYPES = [
  "raw_material",
  "semi_finished",
  "finished_good",
  "consumable",
] as const;
export type InventoryItemType = (typeof INVENTORY_ITEM_TYPES)[number];

export const TDHP_INVENTORY_ACCOUNTS = ["150", "151", "152", "153", "157"] as const;
export type TdhpInventoryAccount = (typeof TDHP_INVENTORY_ACCOUNTS)[number];

export const INVENTORY_MOVEMENT_TYPES = [
  "receipt",
  "production_issue",
  "production_output",
  "sale_issue",
  "scrap",
  "adjustment",
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

export const ITEM_TYPE_LABEL: Record<InventoryItemType, string> = {
  raw_material: "Hammadde & İlk Madde (150)",
  semi_finished: "Yarı Mamul — Üretim (151)",
  finished_good: "Mamul Stok (152)",
  consumable: "Sarf / Yardımcı Malzeme (150/157)",
};

export const MOVEMENT_TYPE_LABEL: Record<InventoryMovementType, string> = {
  receipt: "Mal Girişi / Satınalma (150+)",
  production_issue: "Üretime Sevk / Sarf (150->710)",
  production_output: "Üretimden Mamul Girişi (151/152+)",
  sale_issue: "Satış Sevkiyatı (152->620)",
  scrap: "Fire / Hurda Çıkışı",
  adjustment: "Sayım Farkı / Düzeltme",
};

export interface InventoryItemRow {
  id: string;
  sku: string;
  name: string;
  itemType: InventoryItemType;
  tdhpAccountCode: TdhpInventoryAccount;
  unit: string;
  currency: string;
  standardUnitCost: number;
  unitCostTry: number | null;
  fxRateUsed: number | null;
  missingFxRate: boolean;
  onHandQty: number;
  reorderPoint: number;
  leadTimeDays: number;
  linkedPartId: string | null;
  linkedPartCode: string | null;
  isActive: boolean;
  stockValueNative: number;
  stockValueTry: number | null;
  belowReorderPoint: boolean;
}

export interface InventoryMovementRow {
  id: string;
  itemId: string;
  sku: string;
  itemName: string;
  movementType: InventoryMovementType;
  qty: number;
  signedQtyDelta: number;
  unitCost: number;
  currency: string;
  fxRateToTry: number;
  valueTry: number;
  workOrderId: string | null;
  workOrderNo: string | null;
  occurredOn: string;
  notes: string | null;
}

export interface WorkingCapitalLiveSnapshot {
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cashConversionCycleDays: number | null;
  inventoryTry: number;
}

export interface InventoryOverview {
  items: InventoryItemRow[];
  recentMovements: InventoryMovementRow[];
  tdhp150RawTry: number;
  tdhp151WipTry: number;
  tdhp152FinishedTry: number;
  tdhpOtherTry: number;
  totalValuationTry: number;
  lowStockCount: number;
  missingFxItemCount: number;
  workingCapital: WorkingCapitalLiveSnapshot;
}

/**
 * Computes signed stock delta for a given movement type.
 * Directional movements always move in their canonical direction regardless of input sign;
 * `adjustment` preserves caller sign and rejects zero.
 */
export function computeSignedMovementDelta(
  movementType: InventoryMovementType,
  rawQty: number,
): number {
  if (!Number.isFinite(rawQty) || rawQty === 0) {
    throw new DomainError("Stok hareket miktarı sıfır olamaz.");
  }
  const absQty = decimal(rawQty).abs();
  switch (movementType) {
    case "receipt":
    case "production_output":
      return Number(absQty.round(4, 1).toFixed(4));
    case "production_issue":
    case "sale_issue":
    case "scrap":
      return Number(absQty.times(-1).round(4, 1).toFixed(4));
    case "adjustment":
      return Number(decimal(rawQty).round(4, 1).toFixed(4));
  }
}

export function valuateInventoryItems(
  rawItems: Array<{
    id: string;
    sku: string;
    name: string;
    itemType: InventoryItemType;
    tdhpAccountCode: TdhpInventoryAccount;
    unit: string;
    currency: string;
    standardUnitCost: number;
    onHandQty: number;
    reorderPoint: number;
    leadTimeDays: number;
    linkedPartId: string | null;
    linkedPartCode: string | null;
    isActive: boolean;
  }>,
  spotRates: SpotRateMap,
): {
  items: InventoryItemRow[];
  tdhp150RawTry: number;
  tdhp151WipTry: number;
  tdhp152FinishedTry: number;
  tdhpOtherTry: number;
  totalValuationTry: number;
  lowStockCount: number;
  missingFxItemCount: number;
} {
  const items: InventoryItemRow[] = rawItems.map((it) => {
    const stockValueNative = round2(decimal(it.onHandQty).times(decimal(it.standardUnitCost)));
    const unitConv = convertAmountToTry(it.standardUnitCost, it.currency, spotRates);
    const totalConv = convertAmountToTry(stockValueNative, it.currency, spotRates);
    const belowReorderPoint =
      it.isActive && it.reorderPoint > 0 && decimal(it.onHandQty).lte(decimal(it.reorderPoint));
    return {
      ...it,
      currency: normalizeCurrency(it.currency),
      unitCostTry: unitConv.amountTry,
      fxRateUsed: unitConv.fxRateUsed,
      missingFxRate: unitConv.missingFxRate,
      stockValueNative,
      stockValueTry: totalConv.amountTry,
      belowReorderPoint,
    };
  });

  const activeValued = items.filter((i) => i.isActive && i.onHandQty > 0 && i.stockValueTry != null);
  const tdhp150RawTry = round2(
    sumDecimals(activeValued.filter((i) => i.tdhpAccountCode === "150").map((i) => i.stockValueTry ?? 0)),
  );
  const tdhp151WipTry = round2(
    sumDecimals(activeValued.filter((i) => i.tdhpAccountCode === "151").map((i) => i.stockValueTry ?? 0)),
  );
  const tdhp152FinishedTry = round2(
    sumDecimals(activeValued.filter((i) => i.tdhpAccountCode === "152").map((i) => i.stockValueTry ?? 0)),
  );
  const tdhpOtherTry = round2(
    sumDecimals(
      activeValued
        .filter((i) => i.tdhpAccountCode !== "150" && i.tdhpAccountCode !== "151" && i.tdhpAccountCode !== "152")
        .map((i) => i.stockValueTry ?? 0),
    ),
  );
  const totalValuationTry = round2(
    sumDecimals([tdhp150RawTry, tdhp151WipTry, tdhp152FinishedTry, tdhpOtherTry]),
  );

  return {
    items,
    tdhp150RawTry,
    tdhp151WipTry,
    tdhp152FinishedTry,
    tdhpOtherTry,
    totalValuationTry,
    lowStockCount: items.filter((i) => i.belowReorderPoint).length,
    missingFxItemCount: items.filter((i) => i.isActive && i.missingFxRate).length,
  };
}

export const inventoryItemUpsertSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  sku: z.string().trim().min(1, "Stok kodu (SKU) zorunlu").max(60),
  name: z.string().trim().min(1, "Stok kalemi adı zorunlu").max(200),
  itemType: z.enum(INVENTORY_ITEM_TYPES),
  tdhpAccountCode: z.enum(TDHP_INVENTORY_ACCOUNTS).default("150"),
  unit: z.string().trim().min(1, "Birim zorunlu").max(20).default("adet"),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "3 harfli para birimi girin").default("TRY"),
  standardUnitCost: z.coerce.number().min(0, "Birim maliyet negatif olamaz"),
  onHandQty: z.coerce.number().min(0, "Açılış stok miktarı negatif olamaz").optional().default(0),
  reorderPoint: z.coerce.number().min(0, "Kritik stok eşiği negatif olamaz").optional().default(0),
  leadTimeDays: z.coerce.number().int().min(0).max(365).optional().default(7),
  linkedPartId: z.string().uuid().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

export const inventoryMovementCreateSchema = z.object({
  itemId: z.string().uuid("Geçerli bir stok kalemi seçin"),
  movementType: z.enum(INVENTORY_MOVEMENT_TYPES),
  qty: z.coerce.number().refine((v) => Number.isFinite(v) && v !== 0, "Miktar 0 olamaz"),
  unitCost: z.coerce.number().min(0, "Birim maliyet negatif olamaz").optional().nullable(),
  currency: z.string().trim().optional().nullable(),
  fxRateToTry: z.coerce.number().positive("Kur 0'dan büyük olmalı").optional().nullable(),
  workOrderId: z.string().uuid().optional().nullable(),
  occurredOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD olmalı")
    .optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function loadInventoryOverview(client: Queryable): Promise<InventoryOverview> {
  const spotRates = await loadLatestSpotRatesToTry(client);
  try {
    const [itemsRes, movRes, wcRes] = await Promise.all([
      client.query<{
        id: string;
        sku: string;
        name: string;
        item_type: InventoryItemType;
        tdhp_account_code: TdhpInventoryAccount;
        unit: string;
        currency: string;
        standard_unit_cost: string;
        on_hand_qty: string;
        reorder_point: string;
        lead_time_days: number;
        linked_part_id: string | null;
        linked_part_code: string | null;
        is_active: boolean;
      }>(
        `select
           i.id::text,
           i.sku,
           i.name,
           i.item_type,
           i.tdhp_account_code,
           i.unit,
           i.currency,
           i.standard_unit_cost::text,
           i.on_hand_qty::text,
           i.reorder_point::text,
           i.lead_time_days,
           i.linked_part_id::text,
           pp.part_code as linked_part_code,
           i.is_active
         from public.inventory_items i
         left join public.production_parts pp on pp.id = i.linked_part_id
         order by i.is_active desc, i.tdhp_account_code asc, i.sku asc`,
      ),
      client.query<{
        id: string;
        item_id: string;
        sku: string;
        item_name: string;
        movement_type: InventoryMovementType;
        qty: string;
        unit_cost: string;
        currency: string;
        fx_rate_to_try: string;
        work_order_id: string | null;
        work_order_no: string | null;
        occurred_on: string;
        notes: string | null;
      }>(
        `select
           m.id::text,
           m.item_id::text,
           i.sku,
           i.name as item_name,
           m.movement_type,
           m.qty::text,
           m.unit_cost::text,
           m.currency,
           m.fx_rate_to_try::text,
           m.work_order_id::text,
           wo.order_no as work_order_no,
           to_char(m.occurred_on, 'YYYY-MM-DD') as occurred_on,
           m.notes
         from public.inventory_movements m
         join public.inventory_items i on i.id = m.item_id
         left join public.work_orders wo on wo.id = m.work_order_id
         order by m.occurred_on desc, m.created_at desc
         limit 50`,
      ),
      client
        .query<{
          dso_days: string | null;
          dpo_days: string | null;
          dio_days: string | null;
          cash_conversion_cycle_days: string | null;
          inventory_try: string | null;
        }>(
          `select
             dso_days::text,
             dpo_days::text,
             dio_days::text,
             cash_conversion_cycle_days::text,
             inventory_try::text
           from public.working_capital_metrics
           limit 1`,
        )
        .catch(() => ({ rows: [] })),
    ]);

    const valuated = valuateInventoryItems(
      (itemsRes.rows ?? []).map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        itemType: r.item_type,
        tdhpAccountCode: r.tdhp_account_code,
        unit: r.unit,
        currency: r.currency,
        standardUnitCost: num(r.standard_unit_cost),
        onHandQty: num(r.on_hand_qty),
        reorderPoint: num(r.reorder_point),
        leadTimeDays: Number(r.lead_time_days),
        linkedPartId: r.linked_part_id,
        linkedPartCode: r.linked_part_code,
        isActive: r.is_active,
      })),
      spotRates,
    );

    const recentMovements: InventoryMovementRow[] = (movRes.rows ?? []).map((m) => {
      const qtyVal = num(m.qty);
      const signedQtyDelta = computeSignedMovementDelta(m.movement_type, qtyVal);
      const unitCost = num(m.unit_cost);
      const fxRateToTry = num(m.fx_rate_to_try);
      const valueTry = round2(
        decimal(Math.abs(signedQtyDelta)).times(decimal(unitCost)).times(decimal(fxRateToTry)),
      );
      return {
        id: m.id,
        itemId: m.item_id,
        sku: m.sku,
        itemName: m.item_name,
        movementType: m.movement_type,
        qty: qtyVal,
        signedQtyDelta,
        unitCost,
        currency: m.currency,
        fxRateToTry,
        valueTry,
        workOrderId: m.work_order_id,
        workOrderNo: m.work_order_no,
        occurredOn: m.occurred_on,
        notes: m.notes,
      };
    });

    const wcRow = wcRes.rows[0];
    return {
      ...valuated,
      recentMovements,
      workingCapital: {
        dsoDays: numOrNull(wcRow?.dso_days),
        dpoDays: numOrNull(wcRow?.dpo_days),
        dioDays: numOrNull(wcRow?.dio_days),
        cashConversionCycleDays: numOrNull(wcRow?.cash_conversion_cycle_days),
        inventoryTry: num(wcRow?.inventory_try),
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return {
        items: [],
        recentMovements: [],
        tdhp150RawTry: 0,
        tdhp151WipTry: 0,
        tdhp152FinishedTry: 0,
        tdhpOtherTry: 0,
        totalValuationTry: 0,
        lowStockCount: 0,
        missingFxItemCount: 0,
        workingCapital: {
          dsoDays: null,
          dpoDays: null,
          dioDays: null,
          cashConversionCycleDays: null,
          inventoryTry: 0,
        },
      };
    }
    throw err;
  }
}

export async function upsertInventoryItem(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ id: string }> {
  const input = parseOrThrow(inventoryItemUpsertSchema, rawInput, "Stok kartı formu");
  const sku = input.sku.trim().toUpperCase();
  const currency = normalizeCurrency(input.currency);

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (input.id) {
      const beforeRes = await client.query(
        `select id::text, sku, name, item_type, tdhp_account_code, unit, currency,
                standard_unit_cost::text, on_hand_qty::text, reorder_point::text,
                lead_time_days, linked_part_id::text, is_active
           from public.inventory_items
          where id = $1
          for update`,
        [input.id],
      );
      if (beforeRes.rowCount !== 1) {
        throw new DomainError("Stok kalemi bulunamadı.");
      }

      const upd = await client.query<{ id: string }>(
        `update public.inventory_items
            set sku = $2,
                name = $3,
                item_type = $4,
                tdhp_account_code = $5,
                unit = $6,
                currency = $7,
                standard_unit_cost = $8,
                reorder_point = $9,
                lead_time_days = $10,
                linked_part_id = $11,
                is_active = $12,
                updated_at = now()
          where id = $1
          returning id::text`,
        [
          input.id,
          sku,
          input.name,
          input.itemType,
          input.tdhpAccountCode,
          input.unit,
          currency,
          input.standardUnitCost,
          input.reorderPoint,
          input.leadTimeDays,
          input.linkedPartId ?? null,
          input.isActive,
        ],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("Stok kalemi güncellenemedi.");
      }

      await audit(client, {
        actor: actorId,
        action: "update_inventory_item",
        entityTable: "inventory_items",
        entityId: upd.rows[0].id,
        before: beforeRes.rows[0],
        after: { ...input, sku, currency },
      });

      await client.query("commit");
      return { id: upd.rows[0].id };
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.inventory_items
         (sku, name, item_type, tdhp_account_code, unit, currency, standard_unit_cost,
          on_hand_qty, reorder_point, lead_time_days, linked_part_id, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (sku) do update
         set name = excluded.name,
             item_type = excluded.item_type,
             tdhp_account_code = excluded.tdhp_account_code,
             unit = excluded.unit,
             currency = excluded.currency,
             standard_unit_cost = excluded.standard_unit_cost,
             reorder_point = excluded.reorder_point,
             lead_time_days = excluded.lead_time_days,
             linked_part_id = excluded.linked_part_id,
             is_active = excluded.is_active,
             updated_at = now()
       returning id::text`,
      [
        sku,
        input.name,
        input.itemType,
        input.tdhpAccountCode,
        input.unit,
        currency,
        input.standardUnitCost,
        input.onHandQty,
        input.reorderPoint,
        input.leadTimeDays,
        input.linkedPartId ?? null,
        input.isActive,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("Stok kalemi kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_inventory_item",
      entityTable: "inventory_items",
      entityId: ins.rows[0].id,
      after: { ...input, sku, currency },
    });

    await client.query("commit");
    return { id: ins.rows[0].id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function recordInventoryMovement(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ movementId: string; newOnHandQty: number }> {
  const input = parseOrThrow(inventoryMovementCreateSchema, rawInput, "Stok hareket formu");
  const signedDelta = computeSignedMovementDelta(input.movementType, input.qty);
  const occurredOn = input.occurredOn ?? new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const itemRes = await client.query<{
      id: string;
      sku: string;
      currency: string;
      standard_unit_cost: string;
      on_hand_qty: string;
    }>(
      `select id::text, sku, currency, standard_unit_cost::text, on_hand_qty::text
         from public.inventory_items
        where id = $1
        for update`,
      [input.itemId],
    );
    if (itemRes.rowCount !== 1) {
      throw new DomainError("Stok kalemi bulunamadı.");
    }
    const item = itemRes.rows[0];
    const currentOnHandDec = decimal(item.on_hand_qty);
    const nextOnHandDec = currentOnHandDec.plus(decimal(signedDelta));

    if (nextOnHandDec.lt(0)) {
      throw new DomainError(
        `${item.sku} için yetersiz stok bakiyesi (mevcut: ${currentOnHandDec.toFixed(2)}, çıkış: ${Math.abs(signedDelta)}).`,
      );
    }

    const currency = normalizeCurrency(input.currency ?? item.currency);
    const unitCost = input.unitCost != null ? input.unitCost : num(item.standard_unit_cost);

    let fxRateToTry = input.fxRateToTry ?? null;
    if (fxRateToTry == null) {
      if (currency === "TRY") {
        fxRateToTry = 1;
      } else {
        const rates = await loadLatestSpotRatesToTry(client);
        const spot = rates[currency]?.rate ?? null;
        if (spot == null || !(spot > 0)) {
          throw new DomainError(
            `${currency}/TRY için güncel TCMB kuru bulunamadı; lütfen işlem kurunu girin.`,
          );
        }
        fxRateToTry = spot;
      }
    }

    const persistedQty =
      input.movementType === "adjustment" ? signedDelta : Math.abs(signedDelta);

    const movIns = await client.query<{ id: string }>(
      `insert into public.inventory_movements
         (item_id, movement_type, qty, unit_cost, currency, fx_rate_to_try,
          work_order_id, occurred_on, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
       returning id::text`,
      [
        input.itemId,
        input.movementType,
        persistedQty,
        unitCost,
        currency,
        fxRateToTry,
        input.workOrderId ?? null,
        occurredOn,
        input.notes ?? null,
        actorId,
      ],
    );
    if (movIns.rowCount !== 1) {
      throw new DomainError("Stok hareketi kaydedilemedi.");
    }

    const nextOnHandQty = Number(nextOnHandDec.round(4, 1).toFixed(4));
    const itemUpd = await client.query(
      `update public.inventory_items
          set on_hand_qty = $2,
              updated_at = now()
        where id = $1`,
      [input.itemId, nextOnHandQty],
    );
    if (itemUpd.rowCount !== 1) {
      throw new DomainError("Stok bakiyesi güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "record_inventory_movement",
      entityTable: "inventory_movements",
      entityId: movIns.rows[0].id,
      after: {
        itemId: input.itemId,
        sku: item.sku,
        movementType: input.movementType,
        signedDelta,
        unitCost,
        currency,
        fxRateToTry,
        occurredOn,
      },
    });

    await audit(client, {
      actor: actorId,
      action: "update_inventory_on_hand",
      entityTable: "inventory_items",
      entityId: input.itemId,
      before: { sku: item.sku, on_hand_qty: num(item.on_hand_qty) },
      after: { sku: item.sku, on_hand_qty: nextOnHandQty },
    });

    await client.query("commit");
    return { movementId: movIns.rows[0].id, newOnHandQty: nextOnHandQty };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
