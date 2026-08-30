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
import { audit } from "@/lib/audit";

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
           where cm.scenario_type='normal' limit 1`,
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
      torna_minutes: string | null; freze_minutes: string | null;
    }>(`select id, part_code, part_name, quantity,
               torna_minutes, freze_minutes from public.production_parts`);
    // revenue lives on the source row (kapasite col I); read it back per part
    for (const p of parts.rows) {
      const revRow = await client.query<{ rev: string | null }>(
        `select (row_json->'I'->>'v')::numeric as rev
         from public.import_rows ir join public.production_parts pp on pp.source_row_id = ir.id
         where pp.id=$1`, [p.id],
      );
      const prof = partProfitability(
        {
          code: p.part_code, name: p.part_name, quantity: p.quantity,
          tornaMinutesPerUnit: p.torna_minutes == null ? null : Number(p.torna_minutes),
          frezeMinutesPerUnit: p.freze_minutes == null ? null : Number(p.freze_minutes),
          revenue: moneyOrNull(revRow.rows[0]?.rev ?? null),
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
           on conflict (capacity_model_id, operation_type) do nothing`,
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
             on conflict (loan_id, capacity_model_id, operation_type, allocation_basis) do nothing`,
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
    from public.capacity_models cm order by cm.created_at`);
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
    from public.cost_models order by scenario_type`);
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
  const r = await pool.query(
    `select block, label, amount, ir.row_index
     from public.cost_breakdown_lines cbl
     left join public.import_rows ir on ir.id = cbl.source_row_id
     where cbl.cost_model_id = $1 order by block, ir.row_index nulls last`,
    [costModelId],
  );
  return r.rows.map((x) => ({ ...x, amount: moneyOrNull(x.amount) })) as Array<{ block: string; label: string; amount: number | null; row_index: number | null }>;
}

export async function loadPartProfitability(pool: Pool | PoolClient, limit = 100) {
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
}

/** Total demanded operation minutes across mapped parts (qty × (torna+freze)).
 *  Matches source kapasite G5+H5 totals when all parts are captured. */
/** The sum is a YEARLY total: it comes from production_parts, i.e. the source workbook's
 * G5/H5 minute sums that I8 totals as the year's theoretical capacity (docs/import-mapping.md
 * §5). The field name says so because capacity_models.monthly_minutes is MONTHLY, and the two
 * were being subtracted and divided as if they shared a period (Bulgu #6). Naming the period
 * makes that mistake visible at the call site instead of only in the rendered number. */
export async function loadCapacityDemand(pool: Pool): Promise<{ demandMinutesPerYear: number; partCount: number }> {
  const r = await pool.query(
    `select coalesce(sum(coalesce(quantity,0) * (coalesce(torna_minutes,0) + coalesce(freze_minutes,0))),0) as demand,
            count(*)::int as n from public.production_parts`,
  );
  return { demandMinutesPerYear: rateOrNull(r.rows[0].demand) ?? 0, partCount: r.rows[0].n };
}

/** Actual planned monthly income from the cashflow radar (avg projected income). */
export async function loadActualMonthlyIncome(pool: Pool): Promise<number | null> {
  const r = await pool.query(
    `select avg(projected_income) as avg_income from public.cashflow_months where projected_income is not null`,
  );
  // avg() over numeric returns a high-scale numeric; money scale is the right place to land
  // because this is compared against theoretical monthly revenue in TL.
  return moneyOrNull(r.rows[0]?.avg_income ?? null);
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
  );
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
  );
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
}

/** Aggregate P&L snapshot (all machines, machine_asset_id null) if mapped from `tablo`. */
export async function loadMachineRoiAggregate(pool: Pool) {
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
}
