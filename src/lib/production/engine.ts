// Phase 7 production engine. Maps kapasite → capacity_models + production_parts and
// maliyet-mastechnic(mesaili) → cost_models, then derives part profitability + ROI.
// ANALYTICS ONLY: writes only to production tables (+ audit); never touches payments,
// cashflow, checks, loans, reminders, or reports. Eligibility mirrors earlier phases
// (any open/rejected sheet review blocks); idempotent via source-scoped uniques.

import type { Pool, PoolClient } from "pg";
import {
  extractCapacity,
  extractCostModel,
  type CapacityCandidate,
} from "@/lib/importers/extractors";
import type { CellVal, RowJson } from "@/lib/importers/row-utils";
import { breakEvenTLPerMin, machineRoi, partProfitability } from "./rules";

async function audit(client: PoolClient, action: string, entityTable: string, entityId: string | null, after: unknown): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,$2,$3,null,$4)`,
    [action, entityTable, entityId, JSON.stringify(after ?? null)],
  );
}

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

export async function mapCapacitySheet(pool: Pool, workbookId: string): Promise<CapacityMapResult> {
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
      await audit(client, "map_capacity", "capacity_models", capacityId, {
        sheet: sheet.sheet_name, parts: capacity.parts.length, stale: isStale,
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

export async function mapCostSheets(pool: Pool, workbookId: string): Promise<CostMapResult> {
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
           on conflict (cost_model_id, block, label) do nothing`,
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
      await audit(client, "map_cost_model", "cost_models", costId, { scenario, sheet: sheet.sheet_name, breakEven });
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
        ? `select cm.id, cm.scenario_type, cm.break_even_tl_per_min::float8 as be,
                  cap.torna_rate_tl_per_min::float8 as torna, cap.freze_rate_tl_per_min::float8 as freze
           from public.cost_models cm left join public.capacity_models cap on cap.id=cm.capacity_model_id
           where cm.id=$1`
        : `select cm.id, cm.scenario_type, cm.break_even_tl_per_min::float8 as be,
                  cap.torna_rate_tl_per_min::float8 as torna, cap.freze_rate_tl_per_min::float8 as freze
           from public.cost_models cm left join public.capacity_models cap on cap.id=cm.capacity_model_id
           where cm.scenario_type='normal' limit 1`,
      costModelId ? [costModelId] : [],
    );
    const res: ProfitabilityResult = { runsCreated: 0, needsReview: 0 };
    if (cm.rowCount === 0) {
      await client.query("commit");
      return res;
    }
    const model = cm.rows[0];
    // rate per operation: prefer capacity torna/freze rates; fall back to blended break-even
    const tornaRate = model.torna ?? model.be ?? null;
    const frezeRate = model.freze ?? model.be ?? null;

    const parts = await client.query<{
      id: string; part_code: string | null; part_name: string; quantity: number | null;
      torna_minutes: string | null; freze_minutes: string | null;
    }>(`select id, part_code, part_name, quantity,
               torna_minutes, freze_minutes from public.production_parts`);
    // revenue lives on the source row (kapasite col I); read it back per part
    for (const p of parts.rows) {
      const revRow = await client.query<{ rev: number | null }>(
        `select (row_json->'I'->>'v')::float8 as rev
         from public.import_rows ir join public.production_parts pp on pp.source_row_id = ir.id
         where pp.id=$1`, [p.id],
      );
      const prof = partProfitability(
        {
          code: p.part_code, name: p.part_name, quantity: p.quantity,
          tornaMinutesPerUnit: p.torna_minutes == null ? null : Number(p.torna_minutes),
          frezeMinutesPerUnit: p.freze_minutes == null ? null : Number(p.freze_minutes),
          revenue: revRow.rows[0]?.rev ?? null,
        },
        tornaRate, frezeRate,
      );
      const ins = await client.query(
        `insert into public.part_profitability_runs
           (part_id, cost_model_id, estimated_torna_cost, estimated_freze_cost, estimated_total_cost,
            estimated_revenue, estimated_margin, margin_rate, confidence, missing_operation_time)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (part_id, cost_model_id) do nothing`,
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

/* ── 4) machine ROI snapshots (always needs_review) ── */

export async function calculateMachineRoiSnapshot(
  pool: Pool,
  input: { machineAssetId: string; year: number; revenue: number | null; cost: number | null; tax: number | null; sourceWorkbookId?: string; sourceSheetId?: string },
): Promise<{ created: boolean }> {
  const roi = machineRoi(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.machine_roi_snapshots
         (machine_asset_id, snapshot_year, revenue, cost, remaining, tax, net_after_tax, confidence,
          source_workbook_id, source_sheet_id, notes)
       values ($1,$2,$3,$4,$5,$6,$7,'needs_review',$8,$9,$10)
       on conflict (machine_asset_id, snapshot_year) do nothing
       returning id`,
      [input.machineAssetId, input.year, input.revenue, input.cost, roi.remaining, input.tax, roi.netAfterTax,
       input.sourceWorkbookId ?? null, input.sourceSheetId ?? null,
       "İncelenmeden güvenilir sayılmaz (tablo sekmesi kişisel/şirket karışık)"],
    );
    await client.query("commit");
    return { created: (ins.rowCount ?? 0) > 0 };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── loaders for UI ── */

export async function loadCapacityModels(pool: Pool): Promise<Array<CapacityCandidate & { id: string; name: string; sheetId: string | null; workbookId: string | null; partCount: number; missingPartCount: number }>> {
  const r = await pool.query(`
    select cm.id, cm.name, cm.efficiency_rate::float8 as efficiency,
           cm.freze_rate_tl_per_min::float8 as freze, cm.torna_rate_tl_per_min::float8 as torna,
           cm.rate_year, cm.is_stale_rate, cm.monthly_minutes::float8 as monthly_minutes,
           cm.theoretical_monthly_revenue::float8 as theo_month, cm.theoretical_total_revenue::float8 as theo_total,
           cm.work_days_per_month::float8 as work_days,
           cm.source_sheet_id, cm.source_workbook_id,
           (select count(*)::int from public.production_parts p where p.source_sheet_id=cm.source_sheet_id) as part_count,
           (select count(*)::int from public.production_parts p where p.source_sheet_id=cm.source_sheet_id and p.torna_minutes is null and p.freze_minutes is null) as missing_part_count
    from public.capacity_models cm order by cm.created_at`);
  return r.rows.map((x) => ({
    id: x.id, name: x.name, efficiency: x.efficiency,
    frezeRateTLPerMin: x.freze, tornaRateTLPerMin: x.torna, rateYear: x.rate_year,
    theoreticalTotalRevenue: x.theo_total, theoreticalMonthlyRevenue: x.theo_month,
    minutesPerHour: null, workDaysPerMonth: x.work_days, hoursPerDay: null, parts: [],
    isStaleRate: x.is_stale_rate, monthlyMinutes: x.monthly_minutes,
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
           total_fixed_cost::float8 as monthly_cost, break_even_tl_per_min::float8 as break_even,
           effective_monthly_minutes::float8 as eff_min,
           akon_freze_tl_per_min::float8 as akon_freze, akon_torna_tl_per_min::float8 as akon_torna,
           source_sheet_id, source_workbook_id
    from public.cost_models order by scenario_type`);
  return r.rows.map((x) => ({
    id: x.id, name: x.name, scenario: x.scenario, monthlyCost: x.monthly_cost, breakEven: x.break_even,
    effectiveMinutes: x.eff_min, akonFreze: x.akon_freze, akonTorna: x.akon_torna,
    sheetId: x.source_sheet_id, workbookId: x.source_workbook_id,
  }));
}

/** Fixed-cost + general/personnel breakdown lines for a cost model, grouped-friendly. */
export async function loadCostBreakdown(pool: Pool, costModelId: string) {
  const r = await pool.query(
    `select block, label, amount::float8 as amount, ir.row_index
     from public.cost_breakdown_lines cbl
     left join public.import_rows ir on ir.id = cbl.source_row_id
     where cbl.cost_model_id = $1 order by block, ir.row_index nulls last`,
    [costModelId],
  );
  return r.rows as Array<{ block: string; label: string; amount: number | null; row_index: number | null }>;
}

export async function loadPartProfitability(pool: Pool, limit = 100) {
  const r = await pool.query(
    `select pp.part_code, pp.part_name, pr.estimated_total_cost::float8 as cost,
            pr.estimated_revenue::float8 as revenue, pr.estimated_margin::float8 as margin,
            pr.margin_rate::float8 as margin_rate, pr.confidence, pr.missing_operation_time,
            pp.source_workbook_id, pp.source_sheet_id, ir.row_index
     from public.part_profitability_runs pr
     join public.production_parts pp on pp.id = pr.part_id
     left join public.import_rows ir on ir.id = pp.source_row_id
     order by pr.estimated_margin asc nulls last limit $1`,
    [limit],
  );
  return r.rows as Array<{
    part_code: string | null; part_name: string; cost: number | null; revenue: number | null;
    margin: number | null; margin_rate: number | null; confidence: string; missing_operation_time: boolean;
    source_workbook_id: string | null; source_sheet_id: string | null; row_index: number | null;
  }>;
}

/** Total demanded operation minutes across mapped parts (qty × (torna+freze)).
 *  Matches source kapasite G5+H5 totals when all parts are captured. */
export async function loadCapacityDemand(pool: Pool): Promise<{ demandMinutes: number; partCount: number }> {
  const r = await pool.query(
    `select coalesce(sum(coalesce(quantity,0) * (coalesce(torna_minutes,0) + coalesce(freze_minutes,0))),0)::float8 as demand,
            count(*)::int as n from public.production_parts`,
  );
  return { demandMinutes: r.rows[0].demand, partCount: r.rows[0].n };
}

/** Actual planned monthly income from the cashflow radar (avg projected income). */
export async function loadActualMonthlyIncome(pool: Pool): Promise<number | null> {
  const r = await pool.query(
    `select avg(projected_income)::float8 as avg_income from public.cashflow_months where projected_income is not null`,
  );
  return r.rows[0]?.avg_income ?? null;
}

export async function loadMachineRoi(pool: Pool) {
  const r = await pool.query(
    `select ma.name, s.snapshot_year, s.revenue::float8 as revenue, s.cost::float8 as cost,
            s.net_after_tax::float8 as net, s.confidence
     from public.machine_assets ma
     left join public.machine_roi_snapshots s on s.machine_asset_id = ma.id
     order by ma.name`,
  );
  return r.rows as Array<{ name: string; snapshot_year: number | null; revenue: number | null; cost: number | null; net: number | null; confidence: string | null }>;
}
