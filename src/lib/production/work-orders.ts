import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, money, rate, rateOrNull, sumDecimal } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import type { Queryable } from "./fx-rates";

const round2 = money;
const num = (v: string | number | null | undefined) => (v == null || v === "" ? 0 : rate(v));
const numOrNull = rateOrNull;
const sumDecimals = sumDecimal;

export const WORK_ORDER_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrderStatus, string> = {
  planned: "Planlandı",
  in_progress: "Üretimde",
  completed: "Tamamlandı",
  cancelled: "İptal",
};

export interface WorkOrderRow {
  id: string;
  orderNo: string;
  partId: string | null;
  partCode: string | null;
  partName: string | null;
  bomId: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  operationType: string;
  partyId: string | null;
  partyName: string | null;
  plannedQty: number;
  goodQty: number;
  scrapQty: number;
  plannedMinutes: number;
  actualRunMinutes: number;
  downtimeMinutes: number;
  downtimeReason: string | null;
  status: WorkOrderStatus;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
  estimatedOrderRevenueTry: number | null;
}

export interface WorkCenterOeeRow {
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  operationType: string;
  targetOeePct: number;
  targetEffectiveMinutes: number;
  orderCount: number;
  completedCount: number;
  inProgressCount: number;
  scheduledPlannedMinutes: number;
  actualRunMinutes: number;
  downtimeMinutes: number;
  goodQty: number;
  scrapQty: number;
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
  capacityLoadPct: number | null;
  realizedWorkOrderRevenueTry: number;
  isBottleneck: boolean;
}

export interface PlantOeeSummary {
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
  totalOrders: number;
  activeOrCompletedOrders: number;
  totalPlannedMinutes: number;
  totalActualRunMinutes: number;
  totalDowntimeMinutes: number;
  totalGoodQty: number;
  totalScrapQty: number;
  totalRealizedWorkOrderRevenueTry: number;
  bottleneckWorkCenterCode: string | null;
  bottleneckReason: string | null;
}

export interface WorkOrdersOverview {
  orders: WorkOrderRow[];
  stationOee: WorkCenterOeeRow[];
  plantOee: PlantOeeSummary;
}

/**
 * Pure textbook OEE = Availability × Performance × Quality calculator using Big.js.
 * - Availability = actualRunMinutes / (actualRunMinutes + downtimeMinutes)
 *   (or (plannedMinutes - downtimeMinutes) / plannedMinutes when actualRunMinutes = 0 and downtime > 0)
 * - Performance = min(1, ((goodQty + scrapQty) * idealCycleMinPerUnit) / actualRunMinutes)
 *   where idealCycleMinPerUnit = plannedMinutes / plannedQty
 * - Quality = goodQty / (goodQty + scrapQty)
 */
export function computeSingleOrderOee(input: {
  plannedQty: number;
  goodQty: number;
  scrapQty: number;
  plannedMinutes: number;
  actualRunMinutes: number;
  downtimeMinutes: number;
  status: WorkOrderStatus;
}): {
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
} {
  if (input.status === "cancelled" || input.status === "planned") {
    return {
      availabilityPct: null,
      performancePct: null,
      qualityPct: null,
      oeePct: null,
    };
  }

  const runDec = decimal(Math.max(0, input.actualRunMinutes));
  const downDec = decimal(Math.max(0, input.downtimeMinutes));
  const totalScheduledDec = runDec.plus(downDec);
  const totalOutputDec = decimal(Math.max(0, input.goodQty)).plus(
    decimal(Math.max(0, input.scrapQty)),
  );

  if (runDec.lte(0) || totalScheduledDec.lte(0) || totalOutputDec.lte(0) || input.plannedQty <= 0) {
    return {
      availabilityPct:
        totalScheduledDec.gt(0)
          ? round2(runDec.div(totalScheduledDec).times(100))
          : null,
      performancePct: null,
      qualityPct:
        totalOutputDec.gt(0)
          ? round2(decimal(Math.max(0, input.goodQty)).div(totalOutputDec).times(100))
          : null,
      oeePct: null,
    };
  }

  const availRatioRaw = runDec.div(totalScheduledDec);
  const availRatio = availRatioRaw.gt(1) ? decimal(1) : availRatioRaw;

  const idealCycleDec = decimal(input.plannedMinutes).div(decimal(input.plannedQty));
  const idealRunForOutput = totalOutputDec.times(idealCycleDec);
  const perfRatioRaw = idealRunForOutput.div(runDec);
  const perfRatio = perfRatioRaw.gt(1) ? decimal(1) : perfRatioRaw;

  const qualRatioRaw = decimal(Math.max(0, input.goodQty)).div(totalOutputDec);
  const qualRatio = qualRatioRaw.gt(1) ? decimal(1) : qualRatioRaw;

  const oeeRatio = availRatio.times(perfRatio).times(qualRatio);

  return {
    availabilityPct: round2(availRatio.times(100)),
    performancePct: round2(perfRatio.times(100)),
    qualityPct: round2(qualRatio.times(100)),
    oeePct: round2(oeeRatio.times(100)),
  };
}

export function computeAggregateOee(
  orders: Array<{
    plannedQty: number;
    goodQty: number;
    scrapQty: number;
    plannedMinutes: number;
    actualRunMinutes: number;
    downtimeMinutes: number;
    status: WorkOrderStatus;
  }>,
): {
  availabilityPct: number | null;
  performancePct: number | null;
  qualityPct: number | null;
  oeePct: number | null;
} {
  const active = orders.filter(
    (o) =>
      (o.status === "completed" || o.status === "in_progress") &&
      o.actualRunMinutes > 0 &&
      o.goodQty + o.scrapQty > 0 &&
      o.plannedQty > 0,
  );
  if (active.length === 0) {
    return {
      availabilityPct: null,
      performancePct: null,
      qualityPct: null,
      oeePct: null,
    };
  }

  let sumRun = decimal(0);
  let sumDown = decimal(0);
  let sumIdealMinutes = decimal(0);
  let sumGood = decimal(0);
  let sumTotalQty = decimal(0);

  for (const o of active) {
    const run = decimal(Math.max(0, o.actualRunMinutes));
    const down = decimal(Math.max(0, o.downtimeMinutes));
    const good = decimal(Math.max(0, o.goodQty));
    const totalQ = good.plus(decimal(Math.max(0, o.scrapQty)));
    const idealCycle = decimal(o.plannedMinutes).div(decimal(o.plannedQty));
    sumRun = sumRun.plus(run);
    sumDown = sumDown.plus(down);
    sumIdealMinutes = sumIdealMinutes.plus(totalQ.times(idealCycle));
    sumGood = sumGood.plus(good);
    sumTotalQty = sumTotalQty.plus(totalQ);
  }

  const totalScheduled = sumRun.plus(sumDown);
  if (totalScheduled.lte(0) || sumRun.lte(0) || sumTotalQty.lte(0)) {
    return {
      availabilityPct: null,
      performancePct: null,
      qualityPct: null,
      oeePct: null,
    };
  }

  const availRaw = sumRun.div(totalScheduled);
  const avail = availRaw.gt(1) ? decimal(1) : availRaw;
  const perfRaw = sumIdealMinutes.div(sumRun);
  const perf = perfRaw.gt(1) ? decimal(1) : perfRaw;
  const qualRaw = sumGood.div(sumTotalQty);
  const qual = qualRaw.gt(1) ? decimal(1) : qualRaw;

  return {
    availabilityPct: round2(avail.times(100)),
    performancePct: round2(perf.times(100)),
    qualityPct: round2(qual.times(100)),
    oeePct: round2(avail.times(perf).times(qual).times(100)),
  };
}

export const workOrderCreateSchema = z.object({
  orderNo: z.string().trim().min(1, "İş emri numarası zorunlu").max(50),
  partId: z.string().uuid().optional().nullable(),
  bomId: z.string().uuid().optional().nullable(),
  workCenterId: z.string().uuid("Geçerli bir iş istasyonu seçin"),
  partyId: z.string().uuid().optional().nullable(),
  plannedQty: z.coerce.number().positive("Planlanan miktar > 0 olmalı"),
  plannedMinutes: z.coerce.number().positive("Planlanan süre (dk) > 0 olmalı"),
  dueDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Teslim tarihi YYYY-MM-DD olmalı")
    .optional()
    .nullable(),
});

export const workOrderTransitionSchema = z.object({
  workOrderId: z.string().uuid("Geçersiz iş emri ID"),
  nextStatus: z.enum(["in_progress", "completed", "cancelled"]),
  goodQty: z.coerce.number().min(0).optional().nullable(),
  scrapQty: z.coerce.number().min(0).optional().nullable(),
  actualRunMinutes: z.coerce.number().min(0).optional().nullable(),
  downtimeMinutes: z.coerce.number().min(0).optional().nullable(),
  downtimeReason: z.string().trim().max(300).optional().nullable(),
});

export async function loadWorkOrdersAndOee(client: Queryable): Promise<WorkOrdersOverview> {
  try {
    const [wcRes, woRes, spotRes] = await Promise.all([
      client.query<{
        id: string;
        code: string;
        name: string;
        operation_type: string;
        machine_count: string;
        shifts_per_day: number;
        shift_minutes: number;
        working_days_per_month: number;
        target_oee_pct: string;
        standard_rate_per_min_try: string | null;
        is_active: boolean;
      }>(
        `select
           id::text,
           code,
           name,
           operation_type,
           machine_count::text,
           shifts_per_day,
           shift_minutes,
           working_days_per_month,
           target_oee_pct::text,
           standard_rate_per_min_try::text,
           is_active
         from public.work_centers
         where is_active = true
         order by code asc`,
      ),
      client.query<{
        id: string;
        order_no: string;
        part_id: string | null;
        part_code: string | null;
        part_name: string | null;
        part_unit_price: string | null;
        part_currency: string | null;
        bom_id: string | null;
        work_center_id: string;
        work_center_code: string;
        work_center_name: string;
        operation_type: string;
        standard_rate_per_min_try: string | null;
        party_id: string | null;
        party_name: string | null;
        planned_qty: string;
        good_qty: string;
        scrap_qty: string;
        planned_minutes: string;
        actual_run_minutes: string;
        downtime_minutes: string;
        downtime_reason: string | null;
        status: WorkOrderStatus;
        due_date: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>(
        `select
           wo.id::text,
           wo.order_no,
           wo.part_id::text,
           pp.part_code,
           pp.part_name,
           pp.unit_sale_price::text as part_unit_price,
           pp.currency as part_currency,
           wo.bom_id::text,
           wo.work_center_id::text,
           wc.code as work_center_code,
           wc.name as work_center_name,
           wc.operation_type,
           wc.standard_rate_per_min_try::text,
           wo.party_id::text,
           pa.name as party_name,
           wo.planned_qty::text,
           wo.good_qty::text,
           wo.scrap_qty::text,
           wo.planned_minutes::text,
           wo.actual_run_minutes::text,
           wo.downtime_minutes::text,
           wo.downtime_reason,
           wo.status,
           to_char(wo.due_date, 'YYYY-MM-DD') as due_date,
           wo.started_at::text,
           wo.completed_at::text
         from public.work_orders wo
         join public.work_centers wc on wc.id = wo.work_center_id
         left join public.production_parts pp on pp.id = wo.part_id
         left join public.parties pa on pa.id = wo.party_id
         order by
           case wo.status
             when 'in_progress' then 1
             when 'planned' then 2
             when 'completed' then 3
             else 4
           end,
           wo.created_at desc
         limit 200`,
      ),
      client
        .query<{ base_currency: string; rate: string }>(
          `select distinct on (base_currency) base_currency, rate::text
             from public.fx_rate_snapshots
            where quote_currency = 'TRY' and rate > 0
            order by base_currency, rate_date desc, fetched_at desc`,
        )
        .catch(() => ({ rows: [] })),
    ]);

    const fxMap = new Map<string, number>([["TRY", 1]]);
    for (const r of spotRes.rows ?? []) {
      const val = numOrNull(r.rate);
      if (val != null && val > 0) {
        fxMap.set(String(r.base_currency).trim().toUpperCase(), val);
      }
    }

    const orders: WorkOrderRow[] = (woRes.rows ?? []).map((r) => {
      const plannedQty = num(r.planned_qty);
      const goodQty = num(r.good_qty);
      const scrapQty = num(r.scrap_qty);
      const plannedMinutes = num(r.planned_minutes);
      const actualRunMinutes = num(r.actual_run_minutes);
      const downtimeMinutes = num(r.downtime_minutes);
      const oee = computeSingleOrderOee({
        plannedQty,
        goodQty,
        scrapQty,
        plannedMinutes,
        actualRunMinutes,
        downtimeMinutes,
        status: r.status,
      });

      let estimatedOrderRevenueTry: number | null = null;
      const unitPrice = numOrNull(r.part_unit_price);
      const ccy = String(r.part_currency ?? "TRY").trim().toUpperCase();
      const fx = fxMap.get(ccy) ?? null;
      const effectiveQty = r.status === "completed" || r.status === "in_progress" ? goodQty : plannedQty;
      if (unitPrice != null && unitPrice > 0 && fx != null && effectiveQty > 0) {
        estimatedOrderRevenueTry = round2(
          decimal(effectiveQty).times(decimal(unitPrice)).times(decimal(fx)),
        );
      } else {
        const stdRate = numOrNull(r.standard_rate_per_min_try);
        const mins = actualRunMinutes > 0 ? actualRunMinutes : plannedMinutes;
        if (stdRate != null && stdRate > 0 && mins > 0 && r.status !== "cancelled") {
          estimatedOrderRevenueTry = round2(decimal(mins).times(decimal(stdRate)));
        }
      }

      return {
        id: r.id,
        orderNo: r.order_no,
        partId: r.part_id,
        partCode: r.part_code,
        partName: r.part_name,
        bomId: r.bom_id,
        workCenterId: r.work_center_id,
        workCenterCode: r.work_center_code,
        workCenterName: r.work_center_name,
        operationType: r.operation_type,
        partyId: r.party_id,
        partyName: r.party_name,
        plannedQty,
        goodQty,
        scrapQty,
        plannedMinutes,
        actualRunMinutes,
        downtimeMinutes,
        downtimeReason: r.downtime_reason,
        status: r.status,
        dueDate: r.due_date,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        ...oee,
        estimatedOrderRevenueTry,
      };
    });

    const stationOee: WorkCenterOeeRow[] = (wcRes.rows ?? []).map((wc) => {
      const targetOeePct = num(wc.target_oee_pct);
      const targetEffectiveMinutes = round2(
        decimal(num(wc.machine_count))
          .times(decimal(wc.shifts_per_day))
          .times(decimal(wc.shift_minutes))
          .times(decimal(wc.working_days_per_month))
          .times(decimal(targetOeePct))
          .div(100),
      );

      const wcOrders = orders.filter((o) => o.workCenterId === wc.id && o.status !== "cancelled");
      const agg = computeAggregateOee(wcOrders);
      const scheduledPlannedMinutes = round2(sumDecimals(wcOrders.map((o) => o.plannedMinutes)));
      const actualRunMinutes = round2(sumDecimals(wcOrders.map((o) => o.actualRunMinutes)));
      const downtimeMinutes = round2(sumDecimals(wcOrders.map((o) => o.downtimeMinutes)));
      const goodQty = round2(sumDecimals(wcOrders.map((o) => o.goodQty)));
      const scrapQty = round2(sumDecimals(wcOrders.map((o) => o.scrapQty)));
      const realizedWorkOrderRevenueTry = round2(
        sumDecimals(
          wcOrders
            .filter((o) => o.status === "completed" || o.status === "in_progress")
            .map((o) => o.estimatedOrderRevenueTry ?? 0),
        ),
      );
      const capacityLoadPct =
        targetEffectiveMinutes > 0
          ? round2(decimal(scheduledPlannedMinutes).div(decimal(targetEffectiveMinutes)).times(100))
          : null;

      return {
        workCenterId: wc.id,
        workCenterCode: wc.code,
        workCenterName: wc.name,
        operationType: wc.operation_type,
        targetOeePct,
        targetEffectiveMinutes,
        orderCount: wcOrders.length,
        completedCount: wcOrders.filter((o) => o.status === "completed").length,
        inProgressCount: wcOrders.filter((o) => o.status === "in_progress").length,
        scheduledPlannedMinutes,
        actualRunMinutes,
        downtimeMinutes,
        goodQty,
        scrapQty,
        ...agg,
        capacityLoadPct,
        realizedWorkOrderRevenueTry,
        isBottleneck: false,
      };
    });

    // Identify bottleneck station: highest capacityLoadPct (> 80%) or lowest OEE gap vs target
    let bottleneckIdx = -1;
    let bottleneckScore = -1;
    let bottleneckReason: string | null = null;
    stationOee.forEach((st, idx) => {
      if (st.orderCount === 0) return;
      const loadScore = st.capacityLoadPct ?? 0;
      const oeePenalty = st.oeePct != null ? Math.max(0, st.targetOeePct - st.oeePct) * 1.5 : 0;
      const score = loadScore + oeePenalty;
      if (score > bottleneckScore) {
        bottleneckScore = score;
        bottleneckIdx = idx;
      }
    });
    if (bottleneckIdx >= 0 && bottleneckScore > 0) {
      stationOee[bottleneckIdx].isBottleneck = true;
      const b = stationOee[bottleneckIdx];
      bottleneckReason =
        b.capacityLoadPct != null && b.capacityLoadPct > 85
          ? `%${b.capacityLoadPct.toFixed(1)} kapasite yükü`
          : b.oeePct != null
            ? `%${b.oeePct.toFixed(1)} gerçekleşen OEE (hedef %${b.targetOeePct.toFixed(1)})`
            : `%${(b.capacityLoadPct ?? 0).toFixed(1)} iş emri yükü`;
    }

    const nonCancelled = orders.filter((o) => o.status !== "cancelled");
    const plantAgg = computeAggregateOee(nonCancelled);
    const activeOrCompleted = nonCancelled.filter(
      (o) => o.status === "completed" || o.status === "in_progress",
    );

    return {
      orders,
      stationOee,
      plantOee: {
        ...plantAgg,
        totalOrders: nonCancelled.length,
        activeOrCompletedOrders: activeOrCompleted.length,
        totalPlannedMinutes: round2(sumDecimals(nonCancelled.map((o) => o.plannedMinutes))),
        totalActualRunMinutes: round2(sumDecimals(nonCancelled.map((o) => o.actualRunMinutes))),
        totalDowntimeMinutes: round2(sumDecimals(nonCancelled.map((o) => o.downtimeMinutes))),
        totalGoodQty: round2(sumDecimals(nonCancelled.map((o) => o.goodQty))),
        totalScrapQty: round2(sumDecimals(nonCancelled.map((o) => o.scrapQty))),
        totalRealizedWorkOrderRevenueTry: round2(
          sumDecimals(activeOrCompleted.map((o) => o.estimatedOrderRevenueTry ?? 0)),
        ),
        bottleneckWorkCenterCode: bottleneckIdx >= 0 ? stationOee[bottleneckIdx].workCenterCode : null,
        bottleneckReason,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return {
        orders: [],
        stationOee: [],
        plantOee: {
          availabilityPct: null,
          performancePct: null,
          qualityPct: null,
          oeePct: null,
          totalOrders: 0,
          activeOrCompletedOrders: 0,
          totalPlannedMinutes: 0,
          totalActualRunMinutes: 0,
          totalDowntimeMinutes: 0,
          totalGoodQty: 0,
          totalScrapQty: 0,
          totalRealizedWorkOrderRevenueTry: 0,
          bottleneckWorkCenterCode: null,
          bottleneckReason: null,
        },
      };
    }
    throw err;
  }
}

export async function createWorkOrder(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ id: string }> {
  const input = parseOrThrow(workOrderCreateSchema, rawInput, "İş emri oluşturma formu");
  const orderNo = input.orderNo.trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.work_orders
         (order_no, part_id, bom_id, work_center_id, party_id,
          planned_qty, planned_minutes, status, due_date, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'planned', $8::date, $9)
       returning id::text`,
      [
        orderNo,
        input.partId ?? null,
        input.bomId ?? null,
        input.workCenterId,
        input.partyId ?? null,
        input.plannedQty,
        input.plannedMinutes,
        input.dueDate ?? null,
        actorId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("İş emri oluşturulamadı.");
    }
    await audit(client, {
      actor: actorId,
      action: "create_work_order",
      entityTable: "work_orders",
      entityId: ins.rows[0].id,
      after: {
        orderNo,
        workCenterId: input.workCenterId,
        partId: input.partId ?? null,
        plannedQty: input.plannedQty,
        plannedMinutes: input.plannedMinutes,
        status: "planned",
      },
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

export async function transitionWorkOrderStatus(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<void> {
  const input = parseOrThrow(workOrderTransitionSchema, rawInput, "İş emri durum geçiş formu");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeRes = await client.query<{
      id: string;
      order_no: string;
      status: WorkOrderStatus;
      planned_qty: string;
      planned_minutes: string;
      good_qty: string;
      scrap_qty: string;
      actual_run_minutes: string;
      downtime_minutes: string;
      downtime_reason: string | null;
    }>(
      `select id::text, order_no, status, planned_qty::text, planned_minutes::text,
              good_qty::text, scrap_qty::text, actual_run_minutes::text,
              downtime_minutes::text, downtime_reason
         from public.work_orders
        where id = $1
        for update`,
      [input.workOrderId],
    );
    if (beforeRes.rowCount !== 1) {
      throw new DomainError("İş emri bulunamadı.");
    }
    const cur = beforeRes.rows[0];
    if (cur.status === "completed" || cur.status === "cancelled") {
      throw new DomainError(`${cur.order_no} iş emri kapanmış durumda (${cur.status}); değiştirilemez.`);
    }
    if (cur.status === "planned" && input.nextStatus === "completed") {
      // Respect DB trigger: planned -> in_progress -> completed.
      // Step through in_progress first when completing directly from UI convenience button!
      const stepStart = await client.query(
        `update public.work_orders
            set status = 'in_progress',
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where id = $1`,
        [input.workOrderId],
      );
      if (stepStart.rowCount !== 1) {
        throw new DomainError("İş emri üretime alınamadı.");
      }
    }

    const nextGoodQty =
      input.goodQty != null
        ? input.goodQty
        : input.nextStatus === "completed" && num(cur.good_qty) === 0
          ? num(cur.planned_qty)
          : num(cur.good_qty);
    const nextScrapQty = input.scrapQty != null ? input.scrapQty : num(cur.scrap_qty);
    const nextRunMins =
      input.actualRunMinutes != null
        ? input.actualRunMinutes
        : input.nextStatus === "completed" && num(cur.actual_run_minutes) === 0
          ? num(cur.planned_minutes)
          : num(cur.actual_run_minutes);
    const nextDownMins =
      input.downtimeMinutes != null ? input.downtimeMinutes : num(cur.downtime_minutes);
    const nextReason =
      input.downtimeReason !== undefined ? input.downtimeReason : cur.downtime_reason;

    const upd = await client.query(
      `update public.work_orders
          set status = $2,
              good_qty = $3,
              scrap_qty = $4,
              actual_run_minutes = $5,
              downtime_minutes = $6,
              downtime_reason = $7,
              started_at = case when $2 in ('in_progress', 'completed') then coalesce(started_at, now()) else started_at end,
              completed_at = case when $2 = 'completed' then now() else completed_at end,
              updated_at = now()
        where id = $1`,
      [
        input.workOrderId,
        input.nextStatus,
        nextGoodQty,
        nextScrapQty,
        nextRunMins,
        nextDownMins,
        nextReason,
      ],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("İş emri durumu güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: `work_order_${input.nextStatus}`,
      entityTable: "work_orders",
      entityId: input.workOrderId,
      before: cur,
      after: {
        order_no: cur.order_no,
        status: input.nextStatus,
        good_qty: nextGoodQty,
        scrap_qty: nextScrapQty,
        actual_run_minutes: nextRunMins,
        downtime_minutes: nextDownMins,
        downtime_reason: nextReason,
      },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
