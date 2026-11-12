// Phase 7 production engine. Maps kapasite → capacity_models + production_parts and
// maliyet-mastechnic(mesaili) → cost_models, then derives part profitability + ROI.
// ANALYTICS ONLY: writes only to production tables (+ audit); never touches payments,
// cashflow, checks, loans, reminders, or reports. Eligibility mirrors earlier phases
// (any open/rejected sheet review blocks); idempotent via source-scoped uniques.

import type { Pool, PoolClient } from "pg";
import {
  extractCapacity,
  extractCostModel,
  extractMachineRoi,
  type CapacityCandidate,
} from "@/lib/importers/extractors";
import type { CellVal, RowJson } from "@/lib/importers/row-utils";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import { decimal, divOrNull, money, moneyOrNull, mul, rate, rateOrNull } from "@/lib/money";
import { breakEvenTLPerMin, partProfitability } from "./rules";
import { isMissingSchemaError, sourceRevenue } from "./source-revenue";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseOrThrow } from "@/lib/validation";
import { z } from "zod";

async function sheetCellMap(client: PoolClient | Pool, sheetId: string): Promise<{ map: Record<string, CellVal>; idByRow: Map<number, string> }> {
  const rows = await client.query<{ id: string; row_index: number; row_json: RowJson }>(
    `select id, row_index, row_json from public.import_rows where sheet_id=$1 order by row_index`,
    [sheetId],
  );
  const map: Record<string, CellVal> = {};
  const idByRow = new Map<number, string>();
  for (const r of rows.rows) {
    idByRow.set(r.row_index, r.id);
    for (const [col, cell] of Object.entries(r.row_json)) map[`${col}${r.row_index}`] = cell;
  }
  return { map, idByRow };
}

async function sheetBlocked(client: PoolClient, sheetId: string): Promise<boolean> {
  const r = await client.query<{ n: number }>(
    `select count(*)::int n from public.mapping_reviews where sheet_id=$1 and status in ('open','rejected')`,
    [sheetId],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/* ── 1) kapasite → capacity_models + production_parts ── */

export interface CapacityMapResult {
  capacityCreated: number;
  capacitySkipped: number;
  partsCreated: number;
  excluded: Array<{ sheet: string; reason: string }>;
}

export async function mapCapacitySheet(pool: Pool, workbookId: string, actorId: string): Promise<CapacityMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets where workbook_id=$1 and detected_type='capacity'`,
      [workbookId],
    );
    const res: CapacityMapResult = { capacityCreated: 0, capacitySkipped: 0, partsCreated: 0, excluded: [] };

    for (const sheet of sheets.rows) {
      const { map, idByRow } = await sheetCellMap(client, sheet.id);
      const { capacity } = extractCapacity(map);
      if (await sheetBlocked(client, sheet.id)) {
        res.excluded.push({ sheet: sheet.sheet_name, reason: "açık/ret inceleme" });
        continue;
      }
      const isStale = capacity.rateYear != null && capacity.rateYear < new Date().getFullYear();
      const monthlyMinutes =
        capacity.minutesPerHour != null && capacity.hoursPerDay != null && capacity.workDaysPerMonth != null
          ? capacity.minutesPerHour * capacity.hoursPerDay * capacity.workDaysPerMonth
          : null;
      const ins = await client.query(
        `insert into public.capacity_models
           (name, scenario_type, monthly_hours, monthly_minutes, work_days_per_month, efficiency_rate,
            freze_rate_tl_per_min, torna_rate_tl_per_min, rate_year, is_stale_rate,
            theoretical_monthly_revenue, theoretical_total_revenue,
            source_workbook_id, source_sheet_id, notes)
         values ($1,'normal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         on conflict (source_sheet_id) where source_sheet_id is not null do nothing
         returning id`,
        [
          `Kapasite — ${sheet.sheet_name}`,
          capacity.hoursPerDay != null && capacity.workDaysPerMonth != null ? capacity.hoursPerDay * capacity.workDaysPerMonth : null,
          monthlyMinutes,
          capacity.workDaysPerMonth,
          capacity.efficiency,
          capacity.frezeRateTLPerMin,
          capacity.tornaRateTLPerMin,
          capacity.rateYear,
          isStale,
          capacity.theoreticalMonthlyRevenue,
          capacity.theoreticalTotalRevenue,
          workbookId,
          sheet.id,
          isStale ? `stale_rate: ${capacity.rateYear} tarifesi` : null,
        ],
      );
      if (ins.rowCount === 0) {
        res.capacitySkipped++;
        continue;
      }
      res.capacityCreated++;
      const capacityId: string = ins.rows[0].id;

      for (const part of capacity.parts) {
        const rowId = idByRow.get(part.rowIndex) ?? null;
        const p = await client.query(
          `insert into public.production_parts
             (part_code, part_name, quantity, torna_minutes, freze_minutes,
              source_workbook_id, source_sheet_id, source_row_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (source_row_id) where source_row_id is not null do nothing`,
          [part.code, part.name ?? part.code ?? "(isimsiz parça)", part.quantity,
           part.tornaMinutes, part.frezeMinutes, workbookId, sheet.id, rowId],
        );
        res.partsCreated += p.rowCount ?? 0;
      }
      await audit(client, {
        actor: actorId, action: "map_capacity", entityTable: "capacity_models", entityId: capacityId,
        after: { sheet: sheet.sheet_name, parts: capacity.parts.length, stale: isStale },
      });
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 2) maliyet sheets → cost_models ── */

export interface CostMapResult {
  created: number;
  skipped: number;
  reconciliationReviews: number;
  excluded: Array<{ sheet: string; reason: string }>;
}

export async function mapCostSheets(pool: Pool, workbookId: string, actorId: string): Promise<CostMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name, detected_type from public.source_sheets
       where workbook_id=$1 and detected_type in ('cost_model_normal','cost_model_overtime')
       order by detected_type`,
      [workbookId],
    );
    const res: CostMapResult = { created: 0, skipped: 0, reconciliationReviews: 0, excluded: [] };

    for (const sheet of sheets.rows) {
      const scenario: "normal" | "overtime" = sheet.detected_type === "cost_model_overtime" ? "overtime" : "normal";
      const { map } = await sheetCellMap(client, sheet.id);
      const { cost, issues } = extractCostModel(map, scenario);
      if (await sheetBlocked(client, sheet.id)) {
        res.excluded.push({ sheet: sheet.sheet_name, reason: "açık/ret inceleme" });
        continue;
      }
      // link to a capacity model if present (single-operator: the one capacity model)
      const cap = await client.query(`select id from public.capacity_models limit 1`);
      const capacityId: string | null = cap.rows[0]?.id ?? null;

      const breakEven = cost.breakEvenTLPerMin ?? breakEvenTLPerMin(cost.monthlyCost, cost.effectiveMonthlyMinutes);
      const ins = await client.query(
        `insert into public.cost_models
           (capacity_model_id, model_name, scenario_type,
            food_daily_cost, health_insurance_cost, machine_insurance_cost,
            total_fixed_cost, monthly_allocated_cost,
            break_even_tl_per_min, break_even_torna_tl_per_min, break_even_freze_tl_per_min,
            effective_monthly_minutes, akon_freze_tl_per_min, akon_torna_tl_per_min,
            source_workbook_id, source_sheet_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$10,$11,$12,$13,$14)
         on conflict (source_sheet_id) where source_sheet_id is not null do nothing
         returning id`,
        [
          capacityId, `Maliyet ${scenario} — ${sheet.sheet_name}`, scenario,
          cost.foodDailyCost, cost.healthInsuranceCost, cost.machineInsuranceCost,
          cost.monthlyCost, cost.monthlyCost, breakEven, cost.effectiveMonthlyMinutes,
          cost.akonFrezeTLPerMin, cost.akonTornaTLPerMin,
          workbookId, sheet.id,
        ],
      );
      if (ins.rowCount === 0) {
        res.skipped++;
        continue;
      }
      res.created++;
      const costId: string = ins.rows[0].id;

      // cost breakdown ledger (source-traced; idempotent per (model, block, label))
      const idByRow = new Map((await client.query<{ id: string; row_index: number }>(
        `select id, row_index from public.import_rows where sheet_id=$1`, [sheet.id],
      )).rows.map((r) => [r.row_index, r.id]));
      for (const b of cost.breakdown) {
        await client.query(
          `insert into public.cost_breakdown_lines
             (cost_model_id, block, label, amount, source_workbook_id, source_sheet_id, source_row_id)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (cost_model_id, block, label) do update
             set amount = excluded.amount,
                 source_workbook_id = coalesce(excluded.source_workbook_id, public.cost_breakdown_lines.source_workbook_id),
                 source_sheet_id = coalesce(excluded.source_sheet_id, public.cost_breakdown_lines.source_sheet_id),
                 source_row_id = coalesce(excluded.source_row_id, public.cost_breakdown_lines.source_row_id)
           where public.cost_breakdown_lines.amount is distinct from excluded.amount`,
          [costId, b.block, b.label, b.amount, workbookId, sheet.id, idByRow.get(b.rowIndex) ?? null],
        );
      }

      // reconciliation issues → review (source value wins; never adjusted)
      const reconIssues = issues.filter((i) => i.issue_type.includes("reconciliation"));
      for (const ri of reconIssues) {
        const r = await client.query(
          `insert into public.mapping_reviews (workbook_id, sheet_id, issue_type, severity, message)
           select $1,$2,$3,$4,$5
           where not exists (select 1 from public.mapping_reviews
             where sheet_id=$2 and issue_type=$3 and status='open')`,
          [workbookId, sheet.id, ri.issue_type, ri.severity, ri.message],
        );
        res.reconciliationReviews += r.rowCount ?? 0;
      }
      await audit(client, {
        actor: actorId, action: "map_cost_model", entityTable: "cost_models", entityId: costId,
        after: { scenario, sheet: sheet.sheet_name, breakEven },
      });
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 3) part profitability (idempotent per part × cost model) ── */

export interface ProfitabilityResult {
  runsCreated: number;
  needsReview: number;
}

export async function calculatePartProfitability(pool: Pool, costModelId?: string): Promise<ProfitabilityResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cm = await client.query(
      costModelId
        ? `select cm.id, cm.scenario_type, cm.break_even_tl_per_min as be,
                  cap.torna_rate_tl_per_min as torna, cap.freze_rate_tl_per_min as freze
           from public.cost_models cm left join public.capacity_models cap on cap.id=cm.capacity_model_id
           where cm.id=$1`
        : `select cm.id, cm.scenario_type, cm.break_even_tl_per_min as be,
                  cap.torna_rate_tl_per_min as torna, cap.freze_rate_tl_per_min as freze
           from public.cost_models cm left join public.capacity_models cap on cap.id=cm.capacity_model_id
           order by case when cm.scenario_type='normal' then 0 else 1 end, cm.created_at asc limit 1`,
      costModelId ? [costModelId] : [],
    );
    const res: ProfitabilityResult = { runsCreated: 0, needsReview: 0 };
    if (cm.rowCount === 0) {
      await client.query("commit");
      return res;
    }
    // TL-per-minute rates, decoded at RATE_DP rather than money scale: rounding a
    // break-even of 8.6153 TL/dk to 8.62 would move every part margin derived from it.
    const model = {
      ...cm.rows[0],
      be: rateOrNull(cm.rows[0].be), torna: rateOrNull(cm.rows[0].torna), freze: rateOrNull(cm.rows[0].freze),
    };
    // rate per operation: prefer capacity torna/freze rates; fall back to blended break-even
    const tornaRate = model.torna ?? model.be ?? null;
    const frezeRate = model.freze ?? model.be ?? null;

    const parts = await client.query<{
      id: string; part_code: string | null; part_name: string; quantity: number | null;
      torna_minutes: string | null; freze_minutes: string | null; unit_sale_price: string | null; currency: string | null;
    }>(`select id, part_code, part_name, quantity,
               torna_minutes, freze_minutes, unit_sale_price, currency from public.production_parts`);
    // Gelir kaynak satırda veya operatörün girdiği birim satış fiyatında yaşar:
    // Operatör `unit_sale_price` tanımladıysa (manuel parça veya fiyat güncellemesi) doğrudan
    // `unit_sale_price × quantity` kullanılır; aksi halde kaynak Excel satırından `sourceRevenue` okunur.
    for (const p of parts.rows) {
      const revRow = await client.query<{ row_json: unknown }>(
        `select ir.row_json
         from public.import_rows ir join public.production_parts pp on pp.source_row_id = ir.id
         where pp.id=$1`, [p.id],
      );
      const explicitUnitRevenue =
        p.unit_sale_price != null && p.quantity != null && (p.currency ?? "TRY") === "TRY"
          ? moneyOrNull(mul(p.unit_sale_price, p.quantity))
          : null;
      const prof = partProfitability(
        {
          code: p.part_code, name: p.part_name, quantity: p.quantity,
          tornaMinutesPerUnit: p.torna_minutes == null ? null : Number(p.torna_minutes),
          frezeMinutesPerUnit: p.freze_minutes == null ? null : Number(p.freze_minutes),
          revenue: explicitUnitRevenue ?? sourceRevenue(revRow.rows[0]?.row_json ?? null, p.quantity),
        },
        tornaRate, frezeRate,
      );
      const ins = await client.query(
        `insert into public.part_profitability_runs
           (part_id, cost_model_id, estimated_torna_cost, estimated_freze_cost, estimated_total_cost,
            estimated_revenue, estimated_margin, margin_rate, confidence, missing_operation_time)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (part_id, cost_model_id) do update
           set estimated_torna_cost = excluded.estimated_torna_cost,
               estimated_freze_cost = excluded.estimated_freze_cost,
               estimated_total_cost = excluded.estimated_total_cost,
               estimated_revenue = excluded.estimated_revenue,
               estimated_margin = excluded.estimated_margin,
               margin_rate = excluded.margin_rate,
               confidence = excluded.confidence,
               missing_operation_time = excluded.missing_operation_time
         where public.part_profitability_runs.estimated_torna_cost is distinct from excluded.estimated_torna_cost
            or public.part_profitability_runs.estimated_freze_cost is distinct from excluded.estimated_freze_cost
            or public.part_profitability_runs.estimated_total_cost is distinct from excluded.estimated_total_cost
            or public.part_profitability_runs.estimated_revenue is distinct from excluded.estimated_revenue
            or public.part_profitability_runs.estimated_margin is distinct from excluded.estimated_margin
            or public.part_profitability_runs.margin_rate is distinct from excluded.margin_rate
            or public.part_profitability_runs.confidence is distinct from excluded.confidence
            or public.part_profitability_runs.missing_operation_time is distinct from excluded.missing_operation_time`,
        [
          p.id, model.id, prof.estimatedTornaCost, prof.estimatedFrezeCost, prof.estimatedTotalCost,
          prof.estimatedRevenue, prof.estimatedMargin, prof.marginRate, prof.confidence, prof.missingOperationTime,
        ],
      );
      res.runsCreated += ins.rowCount ?? 0;
      if (prof.confidence === "needs_review") res.needsReview++;
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function recalculateActivePartProfitability(
  pool: Pool,
  preferredCostModelId?: string | null,
): Promise<ProfitabilityResult> {
  const activeModels = await pool
    .query<{ cost_model_id: string }>(
      `select distinct cost_model_id from public.part_profitability_runs where cost_model_id is not null`,
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [] as Array<{ cost_model_id: string }>, rowCount: 0 };
      throw err;
    });

  const modelIds = new Set<string>(activeModels.rows.map((r) => r.cost_model_id));
  if (preferredCostModelId && modelIds.size === 0) {
    modelIds.add(preferredCostModelId);
  }
  if (modelIds.size === 0) {
    return calculatePartProfitability(pool);
  }

  const total: ProfitabilityResult = { runsCreated: 0, needsReview: 0 };
  for (const id of modelIds) {
    const r = await calculatePartProfitability(pool, id);
    total.runsCreated += r.runsCreated;
    total.needsReview += r.needsReview;
  }
  return total;
}

/* ── 4b) map `tablo` → machine ROI + equipment cost (Phase 9C). Personal/family data
   is NEVER read; the personal_data_mixed review must be resolved first (human sign-off).
   ROI stays needs_review. ── */

export interface MachineRoiMapResult {
  purchaseCostsUpdated: number;
  perMachineSnapshots: number;
  aggregateSnapshot: boolean;
  excluded: Array<{ sheet: string; reason: string }>;
}

export async function mapMachineRoi(pool: Pool, workbookId: string, actorId: string): Promise<MachineRoiMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets where workbook_id=$1 and detected_type='machine_roi'`,
      [workbookId],
    );
    const res: MachineRoiMapResult = { purchaseCostsUpdated: 0, perMachineSnapshots: 0, aggregateSnapshot: false, excluded: [] };

    for (const sheet of sheets.rows) {
      const { map } = await sheetCellMap(client, sheet.id);
      const { roi } = extractMachineRoi(map);
      // eligibility: any open/rejected review (incl. personal_data_mixed) blocks until resolved
      const blocked = await client.query<{ n: number }>(
        `select count(*)::int n from public.mapping_reviews where sheet_id=$1 and status in ('open','rejected')`,
        [sheet.id],
      );
      if ((blocked.rows[0]?.n ?? 0) > 0) {
        res.excluded.push({ sheet: sheet.sheet_name, reason: "açık/ret inceleme (kişisel-veri onayı dâhil)" });
        continue;
      }

      const year = roi.year ?? new Date().getFullYear();
      for (const m of roi.machines) {
        const key = normalizeTr(m.name); // machine names are ASCII (awea/arion/sister/doosan)
        // update the matching seeded machine's purchase cost (never create silently)
        if (m.purchaseCost != null) {
          const u = await client.query(
            `update public.machine_assets set purchase_cost=$2 where lower(name)=$1`,
            [key, m.purchaseCost],
          );
          res.purchaseCostsUpdated += u.rowCount ?? 0;
        }
        // per-machine ROI snapshot (revenue = per-machine value); needs_review
        const mid = (await client.query<{ id: string }>(
          `select id from public.machine_assets where lower(name)=$1 limit 1`, [key],
        )).rows[0]?.id ?? null;
        if (mid) {
          const ins = await client.query(
            `insert into public.machine_roi_snapshots
               (machine_asset_id, snapshot_year, revenue, cost, remaining, tax, net_after_tax, confidence,
                source_workbook_id, source_sheet_id, notes)
             values ($1,$2,$3,null,$3,null,$3,'needs_review',$4,$5,$6)
             on conflict (machine_asset_id, snapshot_year) do nothing`,
            [mid, year, m.value, workbookId, sheet.id,
             `kullanım %${m.utilization ?? "?"} · alım maliyeti ${m.purchaseCost ?? "?"} · tablo (kişisel/şirket karışık, insan onayı gerekli)`],
          );
          res.perMachineSnapshots += ins.rowCount ?? 0;
        }
      }

      // aggregate P&L snapshot (machine_asset_id null): 2025 kazanç/maliyet/vergi/net
      if (roi.revenue != null || roi.netAfterTax != null) {
        const agg = await client.query(
          `insert into public.machine_roi_snapshots
             (machine_asset_id, snapshot_year, revenue, cost, remaining, tax, net_after_tax, confidence,
              source_workbook_id, source_sheet_id, notes)
           select null,$1,$2,$3,$4,$5,$6,'needs_review',$7,$8,$9
           where not exists (select 1 from public.machine_roi_snapshots
             where machine_asset_id is null and snapshot_year=$1 and source_sheet_id=$8)`,
          [year, roi.revenue, roi.cost, roi.remaining, roi.tax, roi.netAfterTax, workbookId, sheet.id,
           `${year} toplam P&L (tüm makineler) · tablo sekmesi kişisel/şirket karışık — insan onayı gerekli`],
        );
        if ((agg.rowCount ?? 0) > 0) res.aggregateSnapshot = true;
      }
      await audit(client, {
        actor: actorId, action: "map_machine_roi", entityTable: "machine_roi_snapshots", entityId: sheet.id,
        after: { sheet: sheet.sheet_name, machines: roi.machines.length, year, net: roi.netAfterTax },
      });
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 4c) Phase 9D: machine-minute utilization + finance-cost allocation.
   ANALYTICS ONLY: allocates capacity demand and loan finance cost pressure without
   mutating the source finance/cashflow/production facts. ── */

type OperationType = "torna" | "freze" | "total";

function utilizationFields(demand: number | null, available: number | null) {
  if (demand == null || available == null || available <= 0) {
    return { utilization: null, idle: null, over: null };
  }
  const gap = available - demand;
  return {
    utilization: demand / available,
    idle: gap > 0 ? gap : 0,
    over: gap < 0 ? Math.abs(gap) : 0,
  };
}

export interface MachineMinuteAllocationResult {
  created: number;
  skipped: number;
  excluded: Array<{ capacityModelId: string; reason: string }>;
}

export async function mapMachineMinuteAllocations(pool: Pool, workbookId: string, actorId: string): Promise<MachineMinuteAllocationResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const caps = await client.query<{
      id: string;
      source_sheet_id: string | null;
      monthly_minutes: number | null;
      efficiency: number | null;
    }>(
      `select id, source_sheet_id, monthly_minutes, efficiency_rate as efficiency
       from public.capacity_models
       where source_workbook_id=$1
       order by created_at`,
      [workbookId],
    );
    const res: MachineMinuteAllocationResult = { created: 0, skipped: 0, excluded: [] };

    const machineCounts = await client.query<{ machine_type: OperationType; n: number }>(
      `select machine_type, count(*)::int as n
       from public.machine_assets
       where machine_type in ('torna','freze')
       group by machine_type`,
    );
    // count(*)::int — int4 arrives as a JS number already, so no decimal decode is needed
    // here (and none is wanted: a machine count is a count, not a measurement).
    const countFor = (op: "torna" | "freze") =>
      Number(machineCounts.rows.find((x) => x.machine_type === op)?.n ?? 0);

    for (const cap of caps.rows) {
      if (!cap.source_sheet_id) {
        res.excluded.push({ capacityModelId: cap.id, reason: "kaynak kapasite sekmesi yok" });
        continue;
      }
      const demandRaw = (await client.query<{
        torna: string;
        freze: string;
      }>(
        `select
           coalesce(sum(coalesce(quantity,0) * coalesce(torna_minutes,0)),0) as torna,
           coalesce(sum(coalesce(quantity,0) * coalesce(freze_minutes,0)),0) as freze
         from public.production_parts
         where source_sheet_id=$1`,
        [cap.source_sheet_id],
      )).rows[0];
      // Minute demand is summed exactly by Postgres (quantity × per-unit minutes over every
      // part); rateOrNull keeps the fractional minutes that money scale would round away.
      const demandRow = { torna: rateOrNull(demandRaw.torna) ?? 0, freze: rateOrNull(demandRaw.freze) ?? 0 };
      const monthlyMinutes = rateOrNull(cap.monthly_minutes);
      const efficiency = rateOrNull(cap.efficiency);

      const baseAnnualPerMachine =
        monthlyMinutes != null && efficiency != null
          ? mul(mul(monthlyMinutes, 12), efficiency).toNumber()
          : null;
      const tornaCount = countFor("torna");
      const frezeCount = countFor("freze");
      const rows: Array<{ op: OperationType; machineCount: number; demand: number; available: number | null }> = [
        {
          op: "torna",
          machineCount: tornaCount,
          demand: demandRow.torna,
          available: baseAnnualPerMachine != null ? baseAnnualPerMachine * tornaCount : null,
        },
        {
          op: "freze",
          machineCount: frezeCount,
          demand: demandRow.freze,
          available: baseAnnualPerMachine != null ? baseAnnualPerMachine * frezeCount : null,
        },
      ];
      rows.push({
        op: "total",
        machineCount: tornaCount + frezeCount,
        demand: rows[0].demand + rows[1].demand,
        available: rows.every((r) => r.available != null) ? (rows[0].available ?? 0) + (rows[1].available ?? 0) : null,
      });

      for (const row of rows) {
        const m = utilizationFields(row.demand, row.available);
        const ins = await client.query(
          `insert into public.machine_minute_allocations
             (capacity_model_id, operation_type, machine_count, demand_minutes, available_minutes,
              utilization_rate, idle_minutes, over_capacity_minutes,
              source_workbook_id, source_sheet_id, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (capacity_model_id, operation_type) do update
             set machine_count = excluded.machine_count,
                 demand_minutes = excluded.demand_minutes,
                 available_minutes = excluded.available_minutes,
                 utilization_rate = excluded.utilization_rate,
                 idle_minutes = excluded.idle_minutes,
                 over_capacity_minutes = excluded.over_capacity_minutes
           where public.machine_minute_allocations.machine_count is distinct from excluded.machine_count
              or public.machine_minute_allocations.demand_minutes is distinct from excluded.demand_minutes
              or public.machine_minute_allocations.available_minutes is distinct from excluded.available_minutes
              or public.machine_minute_allocations.utilization_rate is distinct from excluded.utilization_rate
              or public.machine_minute_allocations.idle_minutes is distinct from excluded.idle_minutes
              or public.machine_minute_allocations.over_capacity_minutes is distinct from excluded.over_capacity_minutes`,
          [
            cap.id, row.op, row.machineCount, row.demand, row.available,
            m.utilization, m.idle, m.over, workbookId, cap.source_sheet_id,
            "analitik: kapasite aylık dakikası × 12 × verim × makine sayısı",
          ],
        );
        if ((ins.rowCount ?? 0) > 0) res.created++;
        else res.skipped++;
      }
      await audit(client, {
        actor: actorId, action: "map_machine_minutes", entityTable: "machine_minute_allocations", entityId: cap.id,
        after: { capacity_model_id: cap.id, torna: demandRow.torna, freze: demandRow.freze },
      });
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface FinanceCostAllocationResult {
  created: number;
  skipped: number;
  excluded: Array<{ loanId: string | null; reason: string }>;
}

export async function mapFinanceCostAllocations(pool: Pool, workbookId: string, actorId: string): Promise<FinanceCostAllocationResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const loans = await client.query<{
      id: string;
      name: string;
      total_finance_cost: number | null;
      source_sheet_id: string | null;
    }>(
      `select id, name, total_finance_cost, source_sheet_id
       from public.loans
       where source_workbook_id=$1 and total_finance_cost is not null
       order by created_at`,
      [workbookId],
    );
    const caps = await client.query<{ id: string }>(
      `select id from public.capacity_models where source_workbook_id=$1 order by created_at`,
      [workbookId],
    );
    const res: FinanceCostAllocationResult = { created: 0, skipped: 0, excluded: [] };
    if (caps.rowCount === 0) {
      for (const loan of loans.rows) res.excluded.push({ loanId: loan.id, reason: "kapasite modeli yok" });
      await client.query("commit");
      return res;
    }

    for (const loan of loans.rows) {
      for (const cap of caps.rows) {
        const minutes = await client.query<{
          operation_type: OperationType;
          machine_count: number | null;
          demand_minutes: number | null;
        }>(
          `select operation_type, machine_count::int as machine_count, demand_minutes
           from public.machine_minute_allocations
           where capacity_model_id=$1
           order by case operation_type when 'torna' then 1 when 'freze' then 2 else 3 end`,
          [cap.id],
        );
        if (minutes.rowCount === 0) {
          res.excluded.push({ loanId: loan.id, reason: "makine-dakika tahsisi yok" });
          continue;
        }
        // Faz 17: this whole block writes back into numeric columns, so it is real money
        // arithmetic rather than presentation. allocated = finance cost × demand share, and
        // the two per-unit figures divide it again — three chained operations that used to
        // run on float8 inputs and be stored as the authoritative allocation.
        const financeCost = moneyOrNull(loan.total_finance_cost);
        const demands = minutes.rows.map((r) => rateOrNull(r.demand_minutes));
        const totalRow = minutes.rows.findIndex((r) => r.operation_type === "total");
        const totalDemand =
          totalRow >= 0
            ? demands[totalRow]
            : demands.reduce<number>((acc, d) => acc + (d ?? 0), 0);
        for (const [index, row] of minutes.rows.entries()) {
          const demand = demands[index];
          const ratioDec =
            row.operation_type === "total"
              ? decimal(1)
              : totalDemand != null && totalDemand > 0 && demand != null
                ? divOrNull(demand, totalDemand)
                : null;
          const ratio = ratioDec == null ? null : rate(ratioDec.toString());
          const allocatedDec = financeCost != null && ratioDec != null ? mul(financeCost, ratioDec) : null;
          const allocated = allocatedDec == null ? null : money(allocatedDec.toString());
          const perMinuteDec =
            allocatedDec != null && demand != null && demand > 0 ? divOrNull(allocatedDec, demand) : null;
          const perMinute = perMinuteDec == null ? null : rate(perMinuteDec.toString());
          const perMachineDec =
            allocatedDec != null && row.machine_count != null && row.machine_count > 0
              ? divOrNull(allocatedDec, row.machine_count)
              : null;
          const perMachine = perMachineDec == null ? null : rate(perMachineDec.toString());
          const ins = await client.query(
            `insert into public.finance_cost_allocations
               (loan_id, capacity_model_id, operation_type, allocation_basis,
                machine_count, demand_minutes, allocation_ratio, total_finance_cost,
                allocated_finance_cost, finance_cost_per_minute, finance_cost_per_machine,
                source_workbook_id, source_sheet_id, notes)
             values ($1,$2,$3,'demand_minutes',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             on conflict (loan_id, capacity_model_id, operation_type, allocation_basis) do update
               set machine_count = excluded.machine_count,
                   demand_minutes = excluded.demand_minutes,
                   allocation_ratio = excluded.allocation_ratio,
                   total_finance_cost = excluded.total_finance_cost,
                   allocated_finance_cost = excluded.allocated_finance_cost,
                   finance_cost_per_minute = excluded.finance_cost_per_minute,
                   finance_cost_per_machine = excluded.finance_cost_per_machine
             where public.finance_cost_allocations.demand_minutes is distinct from excluded.demand_minutes
                or public.finance_cost_allocations.allocation_ratio is distinct from excluded.allocation_ratio
                or public.finance_cost_allocations.total_finance_cost is distinct from excluded.total_finance_cost
                or public.finance_cost_allocations.allocated_finance_cost is distinct from excluded.allocated_finance_cost
                or public.finance_cost_allocations.finance_cost_per_minute is distinct from excluded.finance_cost_per_minute
                or public.finance_cost_allocations.finance_cost_per_machine is distinct from excluded.finance_cost_per_machine`,
            [
              loan.id, cap.id, row.operation_type, row.machine_count, demand, ratio,
              financeCost, allocated, perMinute, perMachine,
              workbookId, loan.source_sheet_id,
              "analitik tahsis: kredi toplam finansman maliyeti × operasyon talep dakika payı",
            ],
          );
          if ((ins.rowCount ?? 0) > 0) res.created++;
          else res.skipped++;
        }
        await audit(client, {
          actor: actorId, action: "map_finance_cost_allocation", entityTable: "finance_cost_allocations",
          entityId: loan.id,
          after: { loan: loan.name, capacity_model_id: cap.id, total_finance_cost: loan.total_finance_cost },
        });
      }
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── loaders for UI ── */

// isStaleRate is selected and returned below (cm.is_stale_rate) but was missing from this
// declared shape, so callers could not read the flag the schema keeps precisely so a
// 2023-derived rate is never presented as a current one. Type-only correction: the query,
// the mapping and the returned values are unchanged.
export async function loadCapacityModels(pool: Pool | PoolClient): Promise<Array<CapacityCandidate & { id: string; name: string; monthlyMinutes: number | null; isStaleRate: boolean | null; sheetId: string | null; workbookId: string | null; partCount: number; missingPartCount: number }>> {
  const r = await pool.query(`
    select cm.id, cm.name, cm.efficiency_rate as efficiency,
           cm.freze_rate_tl_per_min as freze, cm.torna_rate_tl_per_min as torna,
           cm.rate_year, cm.is_stale_rate, cm.monthly_minutes,
           cm.theoretical_monthly_revenue as theo_month, cm.theoretical_total_revenue as theo_total,
           cm.work_days_per_month as work_days,
           cm.source_sheet_id, cm.source_workbook_id,
           (select count(*)::int from public.production_parts p where p.source_sheet_id=cm.source_sheet_id) as part_count,
           (select count(*)::int from public.production_parts p where p.source_sheet_id=cm.source_sheet_id and p.torna_minutes is null and p.freze_minutes is null) as missing_part_count
    from public.capacity_models cm order by cm.created_at`).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  return r.rows.map((x) => ({
    // Rates, minutes and work-days keep RATE precision; the two theoretical revenues are TL.
    id: x.id, name: x.name, efficiency: rateOrNull(x.efficiency),
    frezeRateTLPerMin: rateOrNull(x.freze), tornaRateTLPerMin: rateOrNull(x.torna), rateYear: x.rate_year,
    theoreticalTotalRevenue: moneyOrNull(x.theo_total), theoreticalMonthlyRevenue: moneyOrNull(x.theo_month),
    minutesPerHour: null, workDaysPerMonth: rateOrNull(x.work_days), hoursPerDay: null, parts: [],
    isStaleRate: x.is_stale_rate, monthlyMinutes: rateOrNull(x.monthly_minutes),
    sheetId: x.source_sheet_id, workbookId: x.source_workbook_id,
    partCount: x.part_count, missingPartCount: x.missing_part_count,
  })) as never;
}

export async function loadCostModels(pool: Pool): Promise<Array<{
  id: string; name: string; scenario: string; monthlyCost: number | null; breakEven: number | null;
  effectiveMinutes: number | null; akonFreze: number | null; akonTorna: number | null;
  sheetId: string | null; workbookId: string | null;
}>> {
  const r = await pool.query(`
    select id, model_name as name, scenario_type as scenario,
           total_fixed_cost as monthly_cost, break_even_tl_per_min as break_even,
           effective_monthly_minutes as eff_min,
           akon_freze_tl_per_min as akon_freze, akon_torna_tl_per_min as akon_torna,
           source_sheet_id, source_workbook_id
    from public.cost_models order by scenario_type`).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  return r.rows.map((x) => ({
    // breakEven / akon* are TL-per-minute, compared against each other by priceMargin() to
    // decide whether an operation is sold below cost — a threshold, so RATE precision matters.
    id: x.id, name: x.name, scenario: x.scenario,
    monthlyCost: moneyOrNull(x.monthly_cost), breakEven: rateOrNull(x.break_even),
    effectiveMinutes: rateOrNull(x.eff_min),
    akonFreze: rateOrNull(x.akon_freze), akonTorna: rateOrNull(x.akon_torna),
    sheetId: x.source_sheet_id, workbookId: x.source_workbook_id,
  }));
}

/** Fixed-cost + general/personnel breakdown lines for a cost model, grouped-friendly. */
export async function loadCostBreakdown(pool: Pool, costModelId: string) {
  try {
  const r = await pool.query(
    `select block, label, amount, ir.row_index
     from public.cost_breakdown_lines cbl
     left join public.import_rows ir on ir.id = cbl.source_row_id
     where cbl.cost_model_id = $1
     union all
     select 'kalem'::text as block,
            case when cmi.description is not null and btrim(cmi.description) <> ''
                 then cmi.cost_category || ' — ' || cmi.description
                 else cmi.cost_category end as label,
            cmi.monthly_amount as amount,
            ir2.row_index
     from public.cost_model_items cmi
     left join public.import_rows ir2 on ir2.id = cmi.source_row_id
     where cmi.cost_model_id = $1
     order by 1, 4 nulls last`,
    [costModelId],
  );
    return r.rows.map((x) => ({ ...x, amount: moneyOrNull(x.amount) })) as Array<{ block: string; label: string; amount: number | null; row_index: number | null }>;
  } catch (err: unknown) {
    if (!isMissingSchemaError(err)) throw err;
    const fb = await pool.query(
      `select block, label, amount, ir.row_index from public.cost_breakdown_lines cbl left join public.import_rows ir on ir.id = cbl.source_row_id where cbl.cost_model_id = $1 order by 1, 4 nulls last`,
      [costModelId],
    ).catch((e2: unknown) => {
      if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
      throw e2;
    });
    return fb.rows.map((x) => ({ ...x, amount: moneyOrNull(x.amount) })) as Array<{ block: string; label: string; amount: number | null; row_index: number | null }>;
  }
}

export async function loadPartProfitability(pool: Pool | PoolClient, limit = 100) {
  try {
  const r = await pool.query(
    `select pp.part_code, pp.part_name, pr.estimated_total_cost as cost,
            pr.estimated_revenue as revenue, pr.estimated_margin as margin,
            pr.margin_rate, pr.confidence, pr.missing_operation_time,
            pp.source_workbook_id, pp.source_sheet_id, ir.row_index
     from public.part_profitability_runs pr
     join public.production_parts pp on pp.id = pr.part_id
     left join public.import_rows ir on ir.id = pp.source_row_id
     order by pr.estimated_margin asc nulls last limit $1`,
    [limit],
  );
  // margin_rate is a ratio (RATE), the other three are TL. Ordering stays in SQL on the
  // exact numeric, so the "worst margin first" ranking is unchanged by the decode.
  return r.rows.map((x) => ({
    ...x,
    cost: moneyOrNull(x.cost), revenue: moneyOrNull(x.revenue),
    margin: moneyOrNull(x.margin), margin_rate: rateOrNull(x.margin_rate),
  })) as Array<{
    part_code: string | null; part_name: string; cost: number | null; revenue: number | null;
    margin: number | null; margin_rate: number | null; confidence: string; missing_operation_time: boolean;
    source_workbook_id: string | null; source_sheet_id: string | null; row_index: number | null;
  }>;
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

/** Total demanded operation minutes across mapped parts (qty × (torna+freze)).
 *  Matches source kapasite G5+H5 totals when all parts are captured. */
/** The sum is a YEARLY total: it comes from production_parts, i.e. the source workbook's
 * G5/H5 minute sums that I8 totals as the year's theoretical capacity (docs/import-mapping.md
 * §5). The field name says so because capacity_models.monthly_minutes is MONTHLY, and the two
 * were being subtracted and divided as if they shared a period (Bulgu #6). Naming the period
 * makes that mistake visible at the call site instead of only in the rendered number. */
export async function loadCapacityDemand(pool: Pool): Promise<{ demandMinutesPerYear: number; partCount: number }> {
  try {
  const r = await pool.query(
    `select coalesce(sum(coalesce(quantity,0) * (coalesce(torna_minutes,0) + coalesce(freze_minutes,0))),0) as demand,
            count(*)::int as n from public.production_parts`,
  );
    return { demandMinutesPerYear: rateOrNull(r.rows[0].demand) ?? 0, partCount: r.rows[0].n };
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return { demandMinutesPerYear: 0, partCount: 0 };
    throw err;
  }
}

/** Actual planned monthly income from the cashflow radar (avg projected income). */
export async function loadActualMonthlyIncome(pool: Pool): Promise<number | null> {
  try {
  const r = await pool.query(
    `select avg(projected_income) as avg_income from public.cashflow_months where projected_income is not null`,
  );
  // avg() over numeric returns a high-scale numeric; money scale is the right place to land
  // because this is compared against theoretical monthly revenue in TL.
    return moneyOrNull(r.rows[0]?.avg_income ?? null);
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function loadMachineMinuteAllocations(pool: Pool) {
  const r = await pool.query(
    `select mma.operation_type, mma.machine_count::int as machine_count,
            mma.demand_minutes,
            mma.available_minutes,
            mma.utilization_rate,
            mma.idle_minutes,
            mma.over_capacity_minutes,
            cm.name as capacity_model_name, mma.source_workbook_id, mma.source_sheet_id
     from public.machine_minute_allocations mma
     join public.capacity_models cm on cm.id = mma.capacity_model_id
     order by cm.created_at, case mma.operation_type when 'torna' then 1 when 'freze' then 2 else 3 end`,
  ).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  // Minutes and utilisation are measurements, not TL — all decode at RATE precision. The UI
  // renders utilization_rate as a percentage with one decimal, which is exactly the kind of
  // value a money-scale rounding would have flattened.
  return r.rows.map((x) => ({
    ...x,
    demand_minutes: rateOrNull(x.demand_minutes), available_minutes: rateOrNull(x.available_minutes),
    utilization_rate: rateOrNull(x.utilization_rate), idle_minutes: rateOrNull(x.idle_minutes),
    over_capacity_minutes: rateOrNull(x.over_capacity_minutes),
  })) as Array<{
    operation_type: string;
    machine_count: number | null;
    demand_minutes: number | null;
    available_minutes: number | null;
    utilization_rate: number | null;
    idle_minutes: number | null;
    over_capacity_minutes: number | null;
    capacity_model_name: string;
    source_workbook_id: string | null;
    source_sheet_id: string | null;
  }>;
}

export async function loadFinanceCostAllocations(pool: Pool) {
  const r = await pool.query(
    `select fca.operation_type, fca.machine_count::int as machine_count,
            fca.demand_minutes,
            fca.allocation_ratio,
            fca.total_finance_cost,
            fca.allocated_finance_cost,
            fca.finance_cost_per_minute,
            fca.finance_cost_per_machine,
            fca.allocation_basis, l.name as loan_name, cm.name as capacity_model_name,
            fca.source_workbook_id, fca.source_sheet_id
     from public.finance_cost_allocations fca
     join public.loans l on l.id = fca.loan_id
     left join public.capacity_models cm on cm.id = fca.capacity_model_id
     order by l.created_at, case fca.operation_type when 'torna' then 1 when 'freze' then 2 else 3 end`,
  ).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });
  // finance_cost_per_minute is rendered with toFixed(2) on the ROI page; decoding it at RATE
  // precision and letting formatMoney round half-up is what makes that digit agree with the
  // database instead of with a binary double.
  return r.rows.map((x) => ({
    ...x,
    demand_minutes: rateOrNull(x.demand_minutes), allocation_ratio: rateOrNull(x.allocation_ratio),
    total_finance_cost: moneyOrNull(x.total_finance_cost),
    allocated_finance_cost: moneyOrNull(x.allocated_finance_cost),
    finance_cost_per_minute: rateOrNull(x.finance_cost_per_minute),
    finance_cost_per_machine: moneyOrNull(x.finance_cost_per_machine),
  })) as Array<{
    operation_type: string;
    machine_count: number | null;
    demand_minutes: number | null;
    allocation_ratio: number | null;
    total_finance_cost: number | null;
    allocated_finance_cost: number | null;
    finance_cost_per_minute: number | null;
    finance_cost_per_machine: number | null;
    allocation_basis: string;
    loan_name: string;
    capacity_model_name: string | null;
    source_workbook_id: string | null;
    source_sheet_id: string | null;
  }>;
}

export async function loadMachineRoi(pool: Pool) {
  try {
  const r = await pool.query(
    `select ma.name, ma.purchase_cost,
            s.snapshot_year, s.revenue, s.cost,
            s.net_after_tax as net, s.confidence
     from public.machine_assets ma
     left join public.machine_roi_snapshots s on s.machine_asset_id = ma.id
     order by ma.name`,
  );
    return r.rows.map((x) => ({
      ...x,
      purchase_cost: moneyOrNull(x.purchase_cost), revenue: moneyOrNull(x.revenue),
      cost: moneyOrNull(x.cost), net: moneyOrNull(x.net),
    })) as Array<{ name: string; purchase_cost: number | null; snapshot_year: number | null; revenue: number | null; cost: number | null; net: number | null; confidence: string | null }>;
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

/** Aggregate P&L snapshot (all machines, machine_asset_id null) if mapped from `tablo`. */
export async function loadMachineRoiAggregate(pool: Pool) {
  try {
  const r = await pool.query(
    `select snapshot_year, revenue, cost,
            remaining, tax, net_after_tax as net, confidence
     from public.machine_roi_snapshots where machine_asset_id is null
     order by snapshot_year desc limit 1`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...row,
    revenue: moneyOrNull(row.revenue), cost: moneyOrNull(row.cost),
    remaining: moneyOrNull(row.remaining), tax: moneyOrNull(row.tax), net: moneyOrNull(row.net),
  } as { snapshot_year: number; revenue: number | null; cost: number | null; remaining: number | null; tax: number | null; net: number | null; confidence: string };
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}


/* ── 5) Faz 50 (D4): Manuel Kapasite, Sabit Maliyet Kalemi ve Makine ROI Yazma Yolu ── */

const manualCapacitySchema = z.object({
  name: z.string().trim().min(2, "Model adı en az 2 karakter olmalı").max(160),
  scenarioType: z.enum(["normal", "overtime", "custom"]).default("normal"),
  workDaysPerMonth: z.number().min(1).max(31),
  hoursPerDay: z.number().min(1).max(24),
  efficiencyRate: z.number().min(0.05).max(2),
  tornaRateTLPerMin: z.number().nonnegative().nullable().optional(),
  frezeRateTLPerMin: z.number().nonnegative().nullable().optional(),
  rateYear: z.number().int().min(2000).max(2100).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export async function upsertCapacityModelManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(manualCapacitySchema, raw, "Kapasite modeli");
  const effNorm = input.efficiencyRate > 2 ? input.efficiencyRate / 100 : input.efficiencyRate;
  const monthlyHoursDec = mul(input.workDaysPerMonth, input.hoursPerDay);
  const rawMinutesDec = mul(monthlyHoursDec, 60);
  const effMinutesDec = mul(rawMinutesDec, effNorm);
  const monthlyHours = rate(monthlyHoursDec.toString());
  const effectiveMinutes = rate(effMinutesDec.toString());
  const isStale = input.rateYear != null && input.rateYear < new Date().getFullYear();

  const torna = input.tornaRateTLPerMin ?? null;
  const freze = input.frezeRateTLPerMin ?? null;
  let theoreticalMonthlyRevenue: number | null = null;
  if (torna != null && freze != null) {
    const avgRate = divOrNull(decimal(torna).plus(freze), 2);
    theoreticalMonthlyRevenue = avgRate != null ? money(mul(effMinutesDec, avgRate).toString()) : null;
  } else if (torna != null) {
    theoreticalMonthlyRevenue = money(mul(effMinutesDec, torna).toString());
  } else if (freze != null) {
    theoreticalMonthlyRevenue = money(mul(effMinutesDec, freze).toString());
  }
  const theoreticalTotalRevenue =
    theoreticalMonthlyRevenue != null ? money(mul(theoreticalMonthlyRevenue, 12).toString()) : null;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.capacity_models
        where lower(name) = lower($1) and source_sheet_id is null
        limit 1`,
      [input.name],
    );
    let modelId: string;
    if ((existing.rowCount ?? 0) > 0) {
      modelId = existing.rows[0].id;
      await client.query(
        `update public.capacity_models
            set scenario_type = $2,
                monthly_hours = $3,
                monthly_minutes = $4,
                work_days_per_month = $5,
                efficiency_rate = $6,
                torna_rate_tl_per_min = $7,
                freze_rate_tl_per_min = $8,
                rate_year = $9,
                is_stale_rate = $10,
                theoretical_monthly_revenue = $11,
                theoretical_total_revenue = $12,
                notes = $13
          where id = $1`,
        [
          modelId,
          input.scenarioType,
          monthlyHours,
          effectiveMinutes,
          input.workDaysPerMonth,
          effNorm,
          torna,
          freze,
          input.rateYear ?? null,
          isStale,
          theoreticalMonthlyRevenue,
          theoreticalTotalRevenue,
          input.notes ?? null,
        ],
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into public.capacity_models
           (name, scenario_type, monthly_hours, monthly_minutes,
            work_days_per_month, efficiency_rate, torna_rate_tl_per_min, freze_rate_tl_per_min,
            rate_year, is_stale_rate, theoretical_monthly_revenue, theoretical_total_revenue, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         returning id`,
        [
          input.name,
          input.scenarioType,
          monthlyHours,
          effectiveMinutes,
          input.workDaysPerMonth,
          effNorm,
          torna,
          freze,
          input.rateYear ?? null,
          isStale,
          theoreticalMonthlyRevenue,
          theoreticalTotalRevenue,
          input.notes ?? null,
        ],
      );
      modelId = ins.rows[0].id;
    }

    const linkedCostModels = await client.query<{ id: string }>(
      `update public.cost_models
          set capacity_model_id = $1
        where capacity_model_id is null or capacity_model_id = $1
        returning id`,
      [modelId],
    );
    for (const cmRow of linkedCostModels.rows) {
      await recomputeCostModelRollup(client, cmRow.id);
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_capacity_model_manual",
      entityTable: "capacity_models",
      entityId: modelId,
      after: {
        name: input.name,
        scenario_type: input.scenarioType,
        monthly_minutes: effectiveMinutes,
        theoretical_monthly_revenue: theoreticalMonthlyRevenue,
      },
    });
    await client.query("commit");
    await recalculateActivePartProfitability(pool);
    return modelId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const manualCostItemSchema = z.object({
  scenarioType: z.enum(["normal", "overtime", "custom"]).default("normal"),
  costCategory: z.string().trim().min(1, "Maliyet kategorisi gerekli").max(160),
  description: z.string().trim().max(500).optional(),
  monthlyAmount: z.number().nonnegative("Aylık maliyet negatif olamaz"),
  staffCount: z.number().int().nonnegative().nullable().optional(),
  monthlyWorkHours: z.number().positive().nullable().optional(),
  efficiencyRate: z.number().min(0.05).max(2).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export async function recomputeCostModelRollup(client: PoolClient, costModelId: string): Promise<void> {
  const sumRes = await client.query<{
    items_total: string | null;
    lines_total: string | null;
    max_hours: string | null;
    avg_eff: string | null;
    cap_minutes: string | null;
  }>(
    `select
       (select sum(monthly_amount) from public.cost_model_items where cost_model_id = $1) as items_total,
       (select sum(amount) from public.cost_breakdown_lines where cost_model_id = $1) as lines_total,
       (select max(monthly_work_hours) from public.cost_model_items where cost_model_id = $1) as max_hours,
       (select avg(efficiency_rate) from public.cost_model_items where cost_model_id = $1 and efficiency_rate is not null) as avg_eff,
       (select cap.monthly_minutes
          from public.cost_models cm
          left join public.capacity_models cap on cap.id = cm.capacity_model_id
         where cm.id = $1) as cap_minutes`,
    [costModelId],
  );
  const row = sumRes.rows[0];
  const itemsTotal = moneyOrNull(row?.items_total ?? null);
  const linesTotal = moneyOrNull(row?.lines_total ?? null);
  const totalFixed =
    itemsTotal == null && linesTotal == null
      ? null
      : money(decimal(itemsTotal ?? 0).plus(linesTotal ?? 0).toString());

  const maxHours = rateOrNull(row?.max_hours ?? null);
  const avgEff = rateOrNull(row?.avg_eff ?? null);
  const capMinutes = rateOrNull(row?.cap_minutes ?? null);
  const derivedMinutes =
    maxHours != null
      ? rate(mul(mul(maxHours, 60), avgEff ?? 1).toString())
      : capMinutes;
  const breakEven = breakEvenTLPerMin(totalFixed, derivedMinutes);

  await client.query(
    `update public.cost_models
        set total_fixed_cost = $2,
            monthly_allocated_cost = $2,
            effective_monthly_minutes = coalesce($3, effective_monthly_minutes),
            break_even_tl_per_min = coalesce($4, break_even_tl_per_min),
            break_even_torna_tl_per_min = coalesce($4, break_even_torna_tl_per_min),
            break_even_freze_tl_per_min = coalesce($4, break_even_freze_tl_per_min)
      where id = $1`,
    [costModelId, totalFixed, derivedMinutes, breakEven],
  );
}

export async function upsertCostModelManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(manualCostItemSchema, raw, "Maliyet kalemi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const capRes = await client.query<{ id: string }>(
      `select id from public.capacity_models order by created_at desc limit 1`,
    );
    const capacityId = capRes.rows[0]?.id ?? null;

    const modelRes = await client.query<{ id: string }>(
      `select id from public.cost_models
        where scenario_type = $1 and source_sheet_id is null
        order by created_at asc limit 1`,
      [input.scenarioType],
    );
    let costModelId: string;
    if ((modelRes.rowCount ?? 0) > 0) {
      costModelId = modelRes.rows[0].id;
    } else {
      const insModel = await client.query<{ id: string }>(
        `insert into public.cost_models
           (capacity_model_id, model_name, scenario_type)
         values ($1, $2, $3)
         returning id`,
        [capacityId, `Maliyet Modeli (${input.scenarioType})`, input.scenarioType],
      );
      costModelId = insModel.rows[0].id;
    }

    const existingItem = await client.query<{ id: string }>(
      `select id from public.cost_model_items
        where cost_model_id = $1
          and lower(cost_category) = lower($2)
          and source_row_id is null
        limit 1`,
      [costModelId, input.costCategory],
    );
    let itemId: string;
    if ((existingItem.rowCount ?? 0) > 0) {
      itemId = existingItem.rows[0].id;
      await client.query(
        `update public.cost_model_items
            set description = $2,
                monthly_amount = $3,
                staff_count = $4,
                monthly_work_hours = $5,
                efficiency_rate = $6,
                notes = $7
          where id = $1`,
        [
          itemId,
          input.description ?? null,
          input.monthlyAmount,
          input.staffCount ?? null,
          input.monthlyWorkHours ?? null,
          input.efficiencyRate ?? null,
          input.notes ?? null,
        ],
      );
    } else {
      const insItem = await client.query<{ id: string }>(
        `insert into public.cost_model_items
           (cost_model_id, scenario_type, cost_category, description, monthly_amount,
            currency, staff_count, monthly_work_hours, efficiency_rate, notes, created_by)
         values ($1,$2,$3,$4,$5,'TRY',$6,$7,$8,$9,$10)
         returning id`,
        [
          costModelId,
          input.scenarioType,
          input.costCategory,
          input.description ?? null,
          input.monthlyAmount,
          input.staffCount ?? null,
          input.monthlyWorkHours ?? null,
          input.efficiencyRate ?? null,
          input.notes ?? null,
          actorId,
        ],
      );
      itemId = insItem.rows[0].id;
    }

    await recomputeCostModelRollup(client, costModelId);
    await audit(client, {
      actor: actorId,
      action: "upsert_cost_model_item_manual",
      entityTable: "cost_model_items",
      entityId: itemId,
      after: {
        cost_model_id: costModelId,
        scenario_type: input.scenarioType,
        cost_category: input.costCategory,
        monthly_amount: input.monthlyAmount,
      },
    });
    await client.query("commit");
    await recalculateActivePartProfitability(pool, costModelId);
    return itemId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const manualMachineRoiSchema = z.object({
  name: z.string().trim().min(1, "Makine adı gerekli").max(160),
  machineCode: z.string().trim().max(80).optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  purchaseCost: z.number().nonnegative().nullable().optional(),
  monthlyRevenue: z.number().nonnegative().nullable().optional(),
  monthlyOperatingCost: z.number().nonnegative().nullable().optional(),
  annualMaintenanceCost: z.number().nonnegative().nullable().optional(),
  utilizationRate: z.number().min(0).max(200).nullable().optional(),
  usefulLifeMonths: z.number().int().positive().nullable().optional(),
  snapshotYear: z.number().int().min(2000).max(2100).nullable().optional(),
  annualRevenue: z.number().nonnegative().nullable().optional(),
  annualCost: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export async function upsertMachineRoiManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(manualMachineRoiSchema, raw, "Makine ROI");
  const personalTokens = ["maaş", "maas", "kira", "market", "okul", "aile", "şahsi", "sahsi", "kişisel", "kisisel"];
  const lowerName = input.name.toLocaleLowerCase("tr-TR");
  if (personalTokens.some((tok) => lowerName.includes(tok))) {
    throw new DomainError("VALIDATION", `'${input.name}' makine ekonomisi dışında kişisel/aile gideri içeriyor.`);
  }
  const utilNorm =
    input.utilizationRate == null
      ? null
      : input.utilizationRate > 2
        ? Number(decimal(input.utilizationRate).div(100).toFixed(4))
        : input.utilizationRate;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ id: string }>(
      `select id from public.machine_assets where lower(name) = lower($1) limit 1`,
      [input.name],
    );
    let machineId: string;
    if ((existing.rowCount ?? 0) > 0) {
      machineId = existing.rows[0].id;
      await client.query(
        `update public.machine_assets
            set machine_code = coalesce($2, machine_code),
                purchase_date = coalesce($3::date, purchase_date),
                purchase_cost = coalesce($4, purchase_cost),
                monthly_revenue = coalesce($5, monthly_revenue),
                monthly_operating_cost = coalesce($6, monthly_operating_cost),
                annual_maintenance_cost = coalesce($7, annual_maintenance_cost),
                utilization_rate = coalesce($8, utilization_rate),
                useful_life_months = coalesce($9, useful_life_months),
                notes = coalesce($10, notes)
          where id = $1`,
        [
          machineId,
          input.machineCode ?? null,
          input.purchaseDate ?? null,
          input.purchaseCost ?? null,
          input.monthlyRevenue ?? null,
          input.monthlyOperatingCost ?? null,
          input.annualMaintenanceCost ?? null,
          utilNorm,
          input.usefulLifeMonths ?? null,
          input.notes ?? null,
        ],
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into public.machine_assets
           (name, machine_code, purchase_date, purchase_cost, currency,
            monthly_revenue, monthly_operating_cost, annual_maintenance_cost,
            utilization_rate, useful_life_months, is_active, notes)
         values ($1,$2,$3::date,$4,'TRY',$5,$6,$7,$8,$9,true,$10)
         returning id`,
        [
          input.name,
          input.machineCode ?? null,
          input.purchaseDate ?? null,
          input.purchaseCost ?? null,
          input.monthlyRevenue ?? null,
          input.monthlyOperatingCost ?? null,
          input.annualMaintenanceCost ?? null,
          utilNorm,
          input.usefulLifeMonths ?? null,
          input.notes ?? null,
        ],
      );
      machineId = ins.rows[0].id;
    }

    if (input.snapshotYear != null && (input.annualRevenue != null || input.annualCost != null)) {
      const remaining =
        input.annualRevenue != null && input.annualCost != null
          ? money(decimal(input.annualRevenue).minus(input.annualCost).toString())
          : null;
      await client.query(
        `insert into public.machine_roi_snapshots
           (machine_asset_id, snapshot_year, revenue, cost, remaining, net_after_tax, confidence, notes)
         values ($1, $2, $3, $4, $5, $5, 'reviewed', $6)
         on conflict (machine_asset_id, snapshot_year) do update
           set revenue = excluded.revenue,
               cost = excluded.cost,
               remaining = excluded.remaining,
               net_after_tax = excluded.net_after_tax,
               confidence = 'reviewed',
               notes = coalesce(excluded.notes, public.machine_roi_snapshots.notes)`,
        [
          machineId,
          input.snapshotYear,
          input.annualRevenue ?? null,
          input.annualCost ?? null,
          remaining,
          input.notes ?? null,
        ],
      );
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_machine_roi_manual",
      entityTable: "machine_assets",
      entityId: machineId,
      after: {
        name: input.name,
        purchase_cost: input.purchaseCost ?? null,
        snapshot_year: input.snapshotYear ?? null,
        annual_revenue: input.annualRevenue ?? null,
        annual_cost: input.annualCost ?? null,
      },
    });
    await client.query("commit");
    return machineId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 6) Wave 5B (F-49 + F-41): Tekil Parça, Tezgâh/Müşteri Dakika Tarifesi ve Katalog Ürünleri (products) ── */

export interface ProductionPartItem {
  id: string;
  partCode: string | null;
  partName: string;
  quantity: number | null;
  tornaMinutes: number | null;
  frezeMinutes: number | null;
  otherOperationMinutes: number | null;
  unitSalePrice: number | null;
  currency: string;
  notes: string | null;
  isManual: boolean;
}

export async function loadProductionParts(
  pool: Pool | PoolClient,
  limit = 200,
): Promise<ProductionPartItem[]> {
  try {
    const r = await pool.query<{
      id: string;
      part_code: string | null;
      part_name: string;
      quantity: number | null;
      torna_minutes: string | null;
      freze_minutes: string | null;
      other_operation_minutes: string | null;
      unit_sale_price: string | null;
      currency: string | null;
      notes: string | null;
      source_row_id: string | null;
    }>(
      `select id, part_code, part_name, quantity,
              torna_minutes, freze_minutes, other_operation_minutes,
              unit_sale_price, currency, notes, source_row_id
         from public.production_parts
        order by (source_row_id is null) desc, coalesce(part_code, part_name) asc
        limit $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      partCode: row.part_code,
      partName: row.part_name,
      quantity: row.quantity,
      tornaMinutes: rateOrNull(row.torna_minutes),
      frezeMinutes: rateOrNull(row.freze_minutes),
      otherOperationMinutes: rateOrNull(row.other_operation_minutes),
      unitSalePrice: moneyOrNull(row.unit_sale_price),
      currency: row.currency ?? "TRY",
      notes: row.notes,
      isManual: row.source_row_id == null,
    }));
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

export interface CatalogProductItem {
  id: string;
  code: string;
  name: string;
  unit: string | null;
  isActive: boolean;
  notes: string | null;
  updatedAt: string | null;
}

export async function loadCatalogProducts(
  pool: Pool | PoolClient,
  limit = 200,
): Promise<CatalogProductItem[]> {
  try {
    const r = await pool.query<{
      id: string;
      code: string;
      name: string;
      unit: string | null;
      is_active: boolean;
      notes: string | null;
      updated_at: string | null;
    }>(
      `select id, code, name, unit, is_active, notes,
              to_char(updated_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as updated_at
         from public.products
        order by is_active desc, code asc, name asc
        limit $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      unit: row.unit,
      isActive: Boolean(row.is_active),
      notes: row.notes,
      updatedAt: row.updated_at,
    }));
  } catch (err: unknown) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

const manualProductionPartSchema = z.object({
  id: z.string().uuid("Geçerli parça kimliği gerekli").nullable().optional(),
  partCode: z.string().trim().max(120).nullable().optional(),
  partName: z.string().trim().min(1, "Parça adı gerekli").max(200),
  quantity: z.number().int().positive("Üretim adedi pozitif tam sayı olmalı"),
  tornaMinutes: z.number().nonnegative("Torna dakikası negatif olamaz").nullable().optional(),
  frezeMinutes: z.number().nonnegative("Freze dakikası negatif olamaz").nullable().optional(),
  otherOperationMinutes: z.number().nonnegative("Diğer operasyon dakikası negatif olamaz").nullable().optional(),
  unitSalePrice: z.number().nonnegative("Birim satış fiyatı negatif olamaz").nullable().optional(),
  currency: z.string().trim().min(3).max(8).default("TRY"),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function upsertProductionPartManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(manualProductionPartSchema, raw, "Üretim parçası");
  const normalizedCode = input.partCode && input.partCode.trim() !== "" ? input.partCode.trim() : null;
  const normalizedCurrency = (input.currency || "TRY").trim().toUpperCase();

  const client = await pool.connect();
  let partId: string;
  try {
    await client.query("begin");
    if (input.id) {
      const upd = await client.query<{ id: string }>(
        `update public.production_parts
            set part_code = $2,
                part_name = $3,
                quantity = $4,
                torna_minutes = $5,
                freze_minutes = $6,
                other_operation_minutes = $7,
                unit_sale_price = $8,
                currency = $9,
                notes = $10
          where id = $1
          returning id`,
        [
          input.id,
          normalizedCode,
          input.partName,
          input.quantity,
          input.tornaMinutes ?? null,
          input.frezeMinutes ?? null,
          input.otherOperationMinutes ?? null,
          input.unitSalePrice ?? null,
          normalizedCurrency,
          input.notes ?? null,
        ],
      );
      if ((upd.rowCount ?? 0) === 0) {
        throw new DomainError("NOT_FOUND", "Güncellenecek üretim parçası bulunamadı.");
      }
      partId = upd.rows[0].id;
    } else {
      const matchRes = normalizedCode
        ? await client.query<{ id: string }>(
            `select id from public.production_parts
              where lower(part_code) = lower($1)
              order by (source_row_id is null) desc, created_at asc
              limit 1`,
            [normalizedCode],
          )
        : await client.query<{ id: string }>(
            `select id from public.production_parts
              where lower(part_name) = lower($1) and source_row_id is null
              order by created_at asc
              limit 1`,
            [input.partName],
          );

      if ((matchRes.rowCount ?? 0) > 0) {
        partId = matchRes.rows[0].id;
        await client.query(
          `update public.production_parts
              set part_code = coalesce($2, part_code),
                  part_name = $3,
                  quantity = $4,
                  torna_minutes = $5,
                  freze_minutes = $6,
                  other_operation_minutes = $7,
                  unit_sale_price = $8,
                  currency = $9,
                  notes = coalesce($10, notes)
            where id = $1`,
          [
            partId,
            normalizedCode,
            input.partName,
            input.quantity,
            input.tornaMinutes ?? null,
            input.frezeMinutes ?? null,
            input.otherOperationMinutes ?? null,
            input.unitSalePrice ?? null,
            normalizedCurrency,
            input.notes ?? null,
          ],
        );
      } else {
        const ins = await client.query<{ id: string }>(
          `insert into public.production_parts
             (part_code, part_name, quantity, torna_minutes, freze_minutes,
              other_operation_minutes, unit_sale_price, currency, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id`,
          [
            normalizedCode,
            input.partName,
            input.quantity,
            input.tornaMinutes ?? null,
            input.frezeMinutes ?? null,
            input.otherOperationMinutes ?? null,
            input.unitSalePrice ?? null,
            normalizedCurrency,
            input.notes ?? null,
          ],
        );
        partId = ins.rows[0].id;
      }
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_production_part_manual",
      entityTable: "production_parts",
      entityId: partId,
      after: {
        part_code: normalizedCode,
        part_name: input.partName,
        quantity: input.quantity,
        torna_minutes: input.tornaMinutes ?? null,
        freze_minutes: input.frezeMinutes ?? null,
        unit_sale_price: input.unitSalePrice ?? null,
        currency: normalizedCurrency,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }

  await recalculateActivePartProfitability(pool);
  return partId;
}

const manualOperationRatesSchema = z.object({
  scenarioType: z.enum(["normal", "overtime", "custom"]).default("normal"),
  tornaRateTLPerMin: z.number().nonnegative("Torna TL/dk negatif olamaz").nullable().optional(),
  frezeRateTLPerMin: z.number().nonnegative("Freze TL/dk negatif olamaz").nullable().optional(),
  akonTornaTLPerMin: z.number().nonnegative("Akon Torna TL/dk negatif olamaz").nullable().optional(),
  akonFrezeTLPerMin: z.number().nonnegative("Akon Freze TL/dk negatif olamaz").nullable().optional(),
  effectiveMonthlyMinutes: z.number().positive("Etkin aylık dakika pozitif olmalı").nullable().optional(),
  rateYear: z.number().int().min(2000).max(2100).nullable().optional(),
});

export async function upsertOperationRatesManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ costModelId: string; capacityModelId: string }> {
  const input = parseOrThrow(manualOperationRatesSchema, raw, "Tezgâh dakika tarifesi");
  const isStale = input.rateYear != null && input.rateYear < new Date().getFullYear();

  const client = await pool.connect();
  let costModelId: string;
  let capacityModelId: string;
  try {
    await client.query("begin");

    const cmRes = await client.query<{
      id: string;
      capacity_model_id: string | null;
      total_fixed_cost: string | null;
      effective_monthly_minutes: string | null;
    }>(
      `select id, capacity_model_id, total_fixed_cost, effective_monthly_minutes
         from public.cost_models
        where scenario_type = $1
        order by (source_sheet_id is null) asc, created_at asc
        limit 1`,
      [input.scenarioType],
    );

    const existingCapRes = await client.query<{ id: string }>(
      `select id from public.capacity_models
        order by case when id = $1 then 0 else 1 end, created_at asc
        limit 1`,
      [cmRes.rows[0]?.capacity_model_id ?? null],
    );

    if ((existingCapRes.rowCount ?? 0) > 0) {
      capacityModelId = existingCapRes.rows[0].id;
      await client.query(
        `update public.capacity_models
            set torna_rate_tl_per_min = coalesce($2, torna_rate_tl_per_min),
                freze_rate_tl_per_min = coalesce($3, freze_rate_tl_per_min),
                monthly_minutes = coalesce($4, monthly_minutes),
                rate_year = coalesce($5, rate_year),
                is_stale_rate = case when $5::int is not null then $6 else is_stale_rate end
          where id = $1`,
        [
          capacityModelId,
          input.tornaRateTLPerMin ?? null,
          input.frezeRateTLPerMin ?? null,
          input.effectiveMonthlyMinutes ?? null,
          input.rateYear ?? null,
          isStale,
        ],
      );
    } else {
      const insCap = await client.query<{ id: string }>(
        `insert into public.capacity_models
           (name, scenario_type, monthly_minutes, torna_rate_tl_per_min, freze_rate_tl_per_min, rate_year, is_stale_rate)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          `Kapasite Tarifesi (${input.scenarioType})`,
          input.scenarioType,
          input.effectiveMonthlyMinutes ?? null,
          input.tornaRateTLPerMin ?? null,
          input.frezeRateTLPerMin ?? null,
          input.rateYear ?? null,
          isStale,
        ],
      );
      capacityModelId = insCap.rows[0].id;
    }

    if ((cmRes.rowCount ?? 0) > 0) {
      costModelId = cmRes.rows[0].id;
      const totalFixed = moneyOrNull(cmRes.rows[0].total_fixed_cost);
      const effMin = input.effectiveMonthlyMinutes ?? rateOrNull(cmRes.rows[0].effective_monthly_minutes);
      const newBreakEven = breakEvenTLPerMin(totalFixed, effMin);
      await client.query(
        `update public.cost_models
            set capacity_model_id = coalesce(capacity_model_id, $2),
                akon_torna_tl_per_min = coalesce($3, akon_torna_tl_per_min),
                akon_freze_tl_per_min = coalesce($4, akon_freze_tl_per_min),
                effective_monthly_minutes = coalesce($5, effective_monthly_minutes),
                break_even_tl_per_min = coalesce($6, break_even_tl_per_min),
                break_even_torna_tl_per_min = coalesce($6, break_even_torna_tl_per_min),
                break_even_freze_tl_per_min = coalesce($6, break_even_freze_tl_per_min)
          where id = $1`,
        [
          costModelId,
          capacityModelId,
          input.akonTornaTLPerMin ?? null,
          input.akonFrezeTLPerMin ?? null,
          input.effectiveMonthlyMinutes ?? null,
          newBreakEven,
        ],
      );
    } else {
      const insCm = await client.query<{ id: string }>(
        `insert into public.cost_models
           (capacity_model_id, model_name, scenario_type, effective_monthly_minutes,
            akon_torna_tl_per_min, akon_freze_tl_per_min)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          capacityModelId,
          `Maliyet Modeli (${input.scenarioType})`,
          input.scenarioType,
          input.effectiveMonthlyMinutes ?? null,
          input.akonTornaTLPerMin ?? null,
          input.akonFrezeTLPerMin ?? null,
        ],
      );
      costModelId = insCm.rows[0].id;
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_operation_rates_manual",
      entityTable: "cost_models",
      entityId: costModelId,
      after: {
        capacity_model_id: capacityModelId,
        scenario_type: input.scenarioType,
        torna_rate_tl_per_min: input.tornaRateTLPerMin ?? null,
        freze_rate_tl_per_min: input.frezeRateTLPerMin ?? null,
        akon_torna_tl_per_min: input.akonTornaTLPerMin ?? null,
        akon_freze_tl_per_min: input.akonFrezeTLPerMin ?? null,
        effective_monthly_minutes: input.effectiveMonthlyMinutes ?? null,
        rate_year: input.rateYear ?? null,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }

  await recalculateActivePartProfitability(pool, costModelId);
  return { costModelId, capacityModelId };
}

const manualCatalogProductSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  code: z.string().trim().min(1, "Ürün kodu gerekli").max(80),
  name: z.string().trim().min(1, "Ürün adı gerekli").max(200),
  unit: z.string().trim().max(40).nullable().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function upsertCatalogProductManual(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(manualCatalogProductSchema, raw, "Katalog ürünü");
  const client = await pool.connect();
  try {
    await client.query("begin");
    let productId: string;
    if (input.id) {
      const upd = await client.query<{ id: string }>(
        `update public.products
            set code = $2,
                name = $3,
                unit = $4,
                is_active = $5,
                notes = $6,
                updated_at = now()
          where id = $1
          returning id`,
        [input.id, input.code, input.name, input.unit ?? null, input.isActive, input.notes ?? null],
      );
      if ((upd.rowCount ?? 0) === 0) {
        throw new DomainError("NOT_FOUND", "Güncellenecek katalog ürünü bulunamadı.");
      }
      productId = upd.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into public.products (code, name, unit, is_active, notes)
         values ($1, $2, $3, $4, $5)
         on conflict (code) do update
           set name = excluded.name,
               unit = excluded.unit,
               is_active = excluded.is_active,
               notes = excluded.notes,
               updated_at = now()
         returning id`,
        [input.code, input.name, input.unit ?? null, input.isActive, input.notes ?? null],
      );
      productId = ins.rows[0].id;
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_catalog_product",
      entityTable: "products",
      entityId: productId,
      after: {
        code: input.code,
        name: input.name,
        unit: input.unit ?? null,
        is_active: input.isActive,
      },
    });
    await client.query("commit");
    return productId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
