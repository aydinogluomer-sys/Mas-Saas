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

export interface BomLineCalcInput {
  id?: string;
  lineNo: number;
  rawMaterialItemId: string | null;
  materialLabel: string;
  qtyPerUnit: number;
  scrapPct: number;
  unitCostOverride: number | null;
  itemStandardUnitCost: number | null;
  currency: string;
  workCenterId: string | null;
  workCenterCode?: string | null;
  stdSetupMinutes: number;
  stdRunMinutes: number;
}

export interface BomHeaderCalcInput {
  id: string;
  partId: string;
  partCode: string | null;
  partName: string;
  versionCode: string;
  batchSize: number;
  subcontractCostPerUnit: number;
  subcontractCurrency: string;
  isActive: boolean;
  notes: string | null;
  lines: BomLineCalcInput[];
}

export interface BomLineCostDetail extends BomLineCalcInput {
  grossQtyPerUnit: number;
  effectiveUnitCostNative: number | null;
  lineMaterialCostTry: number | null;
  fxRateUsed: number | null;
  missingFxRate: boolean;
  effectiveMinutesPerUnit: number;
}

export interface BomCostSummary extends Omit<BomHeaderCalcInput, "lines"> {
  lines: BomLineCostDetail[];
  directMaterial710PerUnitTry: number | null;
  subcontractPerUnitTry: number | null;
  totalBom710PerUnitTry: number | null;
  fxSensitivePerUnitTry: number;
  totalStdMinutesPerUnit: number;
  missingCostOrFx: boolean;
}

/**
 * Computes unit TDHP 710 direct material + subcontract cost from BOM lines,
 * incorporating scrap percentage (`qty_per_unit * (1 + scrap_pct / 100)`) and TCMB FX rates.
 */
export function computeBomCostSummary(
  header: BomHeaderCalcInput,
  spotRates: SpotRateMap,
): BomCostSummary {
  const safeBatch = header.batchSize > 0 ? header.batchSize : 1;
  let missingCostOrFx = false;
  let fxSensitiveDec = decimal(0);

  const lines: BomLineCostDetail[] = header.lines.map((line) => {
    const scrapFactor = decimal(1).plus(decimal(line.scrapPct).div(100));
    const grossQtyDec = decimal(line.qtyPerUnit).times(scrapFactor);
    const grossQtyPerUnit = Number(grossQtyDec.round(6, 1).toFixed(6));

    const effectiveUnitCostNative =
      line.unitCostOverride != null ? line.unitCostOverride : line.itemStandardUnitCost;

    const ccy = normalizeCurrency(line.currency);
    let lineMaterialCostTry: number | null = null;
    let fxRateUsed: number | null = ccy === "TRY" ? 1 : spotRates[ccy]?.rate ?? null;
    let missingFxRate = false;

    if (effectiveUnitCostNative == null) {
      missingCostOrFx = true;
    } else {
      const nativeLineCost = grossQtyDec.times(decimal(effectiveUnitCostNative));
      const conv = convertAmountToTry(
        Number(nativeLineCost.round(6, 1).toFixed(6)),
        ccy,
        spotRates,
      );
      lineMaterialCostTry = conv.amountTry;
      fxRateUsed = conv.fxRateUsed;
      missingFxRate = conv.missingFxRate;
      if (conv.missingFxRate || conv.amountTry == null) {
        missingCostOrFx = true;
      } else if (ccy !== "TRY") {
        fxSensitiveDec = fxSensitiveDec.plus(decimal(conv.amountTry));
      }
    }

    const effectiveMinutesPerUnit = Number(
      decimal(line.stdSetupMinutes)
        .div(decimal(safeBatch))
        .plus(decimal(line.stdRunMinutes))
        .round(4, 1)
        .toFixed(4),
    );

    return {
      ...line,
      currency: ccy,
      grossQtyPerUnit,
      effectiveUnitCostNative,
      lineMaterialCostTry,
      fxRateUsed,
      missingFxRate,
      effectiveMinutesPerUnit,
    };
  });

  const subCcy = normalizeCurrency(header.subcontractCurrency);
  let subcontractPerUnitTry: number | null = 0;
  if (header.subcontractCostPerUnit > 0) {
    const subConv = convertAmountToTry(header.subcontractCostPerUnit, subCcy, spotRates);
    if (subConv.missingFxRate || subConv.amountTry == null) {
      subcontractPerUnitTry = null;
      missingCostOrFx = true;
    } else {
      subcontractPerUnitTry = subConv.amountTry;
      if (subCcy !== "TRY") {
        fxSensitiveDec = fxSensitiveDec.plus(decimal(subConv.amountTry));
      }
    }
  }

  const directMaterial710PerUnitTry = missingCostOrFx
    ? null
    : round2(sumDecimals(lines.map((l) => l.lineMaterialCostTry ?? 0)));

  const totalBom710PerUnitTry =
    directMaterial710PerUnitTry == null || subcontractPerUnitTry == null
      ? null
      : round2(decimal(directMaterial710PerUnitTry).plus(decimal(subcontractPerUnitTry)));

  const totalStdMinutesPerUnit = Number(
    sumDecimals(lines.map((l) => l.effectiveMinutesPerUnit))
      .round(4, 1)
      .toFixed(4),
  );

  return {
    id: header.id,
    partId: header.partId,
    partCode: header.partCode,
    partName: header.partName,
    versionCode: header.versionCode,
    batchSize: safeBatch,
    subcontractCostPerUnit: header.subcontractCostPerUnit,
    subcontractCurrency: subCcy,
    isActive: header.isActive,
    notes: header.notes,
    lines,
    directMaterial710PerUnitTry,
    subcontractPerUnitTry,
    totalBom710PerUnitTry,
    fxSensitivePerUnitTry: round2(fxSensitiveDec),
    totalStdMinutesPerUnit,
    missingCostOrFx,
  };
}

export const bomHeaderWithLineSchema = z.object({
  partId: z.string().uuid("Geçerli bir üretim parçası seçin"),
  versionCode: z.string().trim().min(1).max(30).default("V1"),
  batchSize: z.coerce.number().positive("Parti büyüklüğü > 0 olmalı").default(1),
  subcontractCostPerUnit: z.coerce.number().min(0).default(0),
  subcontractCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).default("TRY"),
  notes: z.string().trim().max(400).optional().nullable(),
  rawMaterialItemId: z.string().uuid().optional().nullable(),
  materialLabel: z.string().trim().min(1, "Malzeme/operasyon açıklaması zorunlu").max(180),
  qtyPerUnit: z.coerce.number().positive("Birim sarf miktarı > 0 olmalı"),
  scrapPct: z.coerce.number().min(0, "Fire % negatif olamaz").lt(100, "Fire % 100'den küçük olmalı").default(0),
  unitCostOverride: z.coerce.number().min(0).optional().nullable(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).default("TRY"),
  workCenterId: z.string().uuid().optional().nullable(),
  stdSetupMinutes: z.coerce.number().min(0).default(0),
  stdRunMinutes: z.coerce.number().min(0).default(0),
});

export async function loadBomSummaries(client: Queryable): Promise<{
  boms: BomCostSummary[];
  byPartId: Record<string, BomCostSummary>;
}> {
  const spotRates = await loadLatestSpotRatesToTry(client);
  try {
    const [hdrRes, lineRes] = await Promise.all([
      client.query<{
        id: string;
        part_id: string;
        part_code: string | null;
        part_name: string;
        version_code: string;
        batch_size: string;
        subcontract_cost_per_unit: string;
        subcontract_currency: string;
        is_active: boolean;
        notes: string | null;
      }>(
        `select
           bh.id::text,
           bh.part_id::text,
           pp.part_code,
           pp.part_name,
           bh.version_code,
           bh.batch_size::text,
           bh.subcontract_cost_per_unit::text,
           bh.subcontract_currency,
           bh.is_active,
           bh.notes
         from public.bom_headers bh
         join public.production_parts pp on pp.id = bh.part_id
         order by bh.is_active desc, pp.part_code nulls last, bh.updated_at desc`,
      ),
      client.query<{
        id: string;
        bom_id: string;
        line_no: number;
        raw_material_item_id: string | null;
        material_label: string;
        qty_per_unit: string;
        scrap_pct: string;
        unit_cost_override: string | null;
        item_standard_cost: string | null;
        item_currency: string | null;
        currency: string;
        work_center_id: string | null;
        work_center_code: string | null;
        std_setup_minutes: string;
        std_run_minutes: string;
      }>(
        `select
           bl.id::text,
           bl.bom_id::text,
           bl.line_no,
           bl.raw_material_item_id::text,
           bl.material_label,
           bl.qty_per_unit::text,
           bl.scrap_pct::text,
           bl.unit_cost_override::text,
           ii.standard_unit_cost::text as item_standard_cost,
           ii.currency as item_currency,
           bl.currency,
           bl.work_center_id::text,
           wc.code as work_center_code,
           bl.std_setup_minutes::text,
           bl.std_run_minutes::text
         from public.bom_lines bl
         left join public.inventory_items ii on ii.id = bl.raw_material_item_id
         left join public.work_centers wc on wc.id = bl.work_center_id
         order by bl.bom_id, bl.line_no asc`,
      ),
    ]);

    const linesByBom = new Map<string, BomLineCalcInput[]>();
    for (const r of lineRes.rows ?? []) {
      const list = linesByBom.get(r.bom_id) ?? [];
      const effectiveCurrency =
        r.unit_cost_override != null
          ? r.currency
          : r.item_currency ?? r.currency;
      list.push({
        id: r.id,
        lineNo: Number(r.line_no),
        rawMaterialItemId: r.raw_material_item_id,
        materialLabel: r.material_label,
        qtyPerUnit: num(r.qty_per_unit),
        scrapPct: num(r.scrap_pct),
        unitCostOverride: numOrNull(r.unit_cost_override),
        itemStandardUnitCost: numOrNull(r.item_standard_cost),
        currency: effectiveCurrency,
        workCenterId: r.work_center_id,
        workCenterCode: r.work_center_code,
        stdSetupMinutes: num(r.std_setup_minutes),
        stdRunMinutes: num(r.std_run_minutes),
      });
      linesByBom.set(r.bom_id, list);
    }

    const boms: BomCostSummary[] = (hdrRes.rows ?? []).map((h) =>
      computeBomCostSummary(
        {
          id: h.id,
          partId: h.part_id,
          partCode: h.part_code,
          partName: h.part_name,
          versionCode: h.version_code,
          batchSize: num(h.batch_size),
          subcontractCostPerUnit: num(h.subcontract_cost_per_unit),
          subcontractCurrency: h.subcontract_currency,
          isActive: h.is_active,
          notes: h.notes,
          lines: linesByBom.get(h.id) ?? [],
        },
        spotRates,
      ),
    );

    const byPartId: Record<string, BomCostSummary> = {};
    for (const b of boms) {
      if (b.isActive && !byPartId[b.partId]) {
        byPartId[b.partId] = b;
      }
    }
    return { boms, byPartId };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return { boms: [], byPartId: {} };
    }
    throw err;
  }
}

export async function addBomLineAndUpsertHeader(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ bomId: string; lineId: string }> {
  const input = parseOrThrow(bomHeaderWithLineSchema, rawInput, "Ürün ağacı (BOM) formu");
  const versionCode = input.versionCode.trim().toUpperCase();
  const subCurrency = normalizeCurrency(input.subcontractCurrency);
  const lineCurrency = normalizeCurrency(input.currency);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const hdrIns = await client.query<{ id: string }>(
      `insert into public.bom_headers
         (part_id, version_code, batch_size, subcontract_cost_per_unit, subcontract_currency, is_active, notes)
       values ($1, $2, $3, $4, $5, true, $6)
       on conflict (part_id, version_code) do update
         set batch_size = excluded.batch_size,
             subcontract_cost_per_unit = excluded.subcontract_cost_per_unit,
             subcontract_currency = excluded.subcontract_currency,
             is_active = true,
             notes = coalesce(excluded.notes, public.bom_headers.notes),
             updated_at = now()
       returning id::text`,
      [
        input.partId,
        versionCode,
        input.batchSize,
        input.subcontractCostPerUnit,
        subCurrency,
        input.notes ?? null,
      ],
    );
    if (hdrIns.rowCount !== 1) {
      throw new DomainError("BOM başlığı kaydedilemedi.");
    }
    const bomId = hdrIns.rows[0].id;

    const nextNoRes = await client.query<{ next_no: number }>(
      `select coalesce(max(line_no), 0) + 1 as next_no
         from public.bom_lines
        where bom_id = $1`,
      [bomId],
    );
    const nextNo = Number(nextNoRes.rows[0]?.next_no ?? 1);

    const lineIns = await client.query<{ id: string }>(
      `insert into public.bom_lines
         (bom_id, line_no, raw_material_item_id, material_label, qty_per_unit, scrap_pct,
          unit_cost_override, currency, work_center_id, std_setup_minutes, std_run_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id::text`,
      [
        bomId,
        nextNo,
        input.rawMaterialItemId ?? null,
        input.materialLabel,
        input.qtyPerUnit,
        input.scrapPct,
        input.unitCostOverride ?? null,
        lineCurrency,
        input.workCenterId ?? null,
        input.stdSetupMinutes,
        input.stdRunMinutes,
      ],
    );
    if (lineIns.rowCount !== 1) {
      throw new DomainError("BOM kalemi kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_bom_header",
      entityTable: "bom_headers",
      entityId: bomId,
      after: {
        partId: input.partId,
        versionCode,
        batchSize: input.batchSize,
        subcontractCostPerUnit: input.subcontractCostPerUnit,
        subcontractCurrency: subCurrency,
      },
    });

    await audit(client, {
      actor: actorId,
      action: "create_bom_line",
      entityTable: "bom_lines",
      entityId: lineIns.rows[0].id,
      after: {
        bomId,
        lineNo: nextNo,
        materialLabel: input.materialLabel,
        qtyPerUnit: input.qtyPerUnit,
        scrapPct: input.scrapPct,
        currency: lineCurrency,
      },
    });

    await client.query("commit");
    return { bomId, lineId: lineIns.rows[0].id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteBomLine(
  pool: Pool,
  lineId: string,
  actorId: string | null,
): Promise<void> {
  const parsed = parseOrThrow(
    z.object({ lineId: z.string().uuid("Geçersiz reçete satırı ID") }),
    { lineId },
    "BOM satırı silme formu",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeRes = await client.query(
      `select id::text, bom_id::text, line_no, material_label, qty_per_unit::text, scrap_pct::text
         from public.bom_lines
        where id = $1
        for update`,
      [parsed.lineId],
    );
    if (beforeRes.rowCount !== 1) {
      throw new DomainError("BOM satırı bulunamadı.");
    }
    const del = await client.query(`delete from public.bom_lines where id = $1`, [parsed.lineId]);
    if (del.rowCount !== 1) {
      throw new DomainError("BOM satırı silinemedi.");
    }
    await audit(client, {
      actor: actorId,
      action: "delete_bom_line",
      entityTable: "bom_lines",
      entityId: parsed.lineId,
      before: beforeRes.rows[0],
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
