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

export const WORK_CENTER_OPERATION_TYPES = [
  "torna",
  "freze",
  "taslama",
  "lazer",
  "kaynak",
  "montaj",
  "kalite",
  "fason",
  "diger",
] as const;

export type WorkCenterOperationType = (typeof WORK_CENTER_OPERATION_TYPES)[number];

export const OPERATION_TYPE_LABEL: Record<WorkCenterOperationType, string> = {
  torna: "CNC Torna",
  freze: "CNC Freze / İşleme Merkezi",
  taslama: "Taşlama",
  lazer: "Lazer Kesim",
  kaynak: "Kaynak & Birleştirme",
  montaj: "Montaj",
  kalite: "Kalite Kontrol / CMM",
  fason: "Fason Operasyon",
  diger: "Diğer Operasyon",
};

export interface WorkCenterRow {
  id: string;
  code: string;
  name: string;
  operationType: WorkCenterOperationType;
  machineCount: number;
  shiftsPerDay: number;
  shiftMinutes: number;
  workingDaysPerMonth: number;
  targetOeePct: number;
  hourlyPowerKw: number | null;
  standardRatePerMinTry: number | null;
  isActive: boolean;
  grossMonthlyMinutes: number;
  targetEffectiveMinutes: number;
  theoreticalMonthlyRevenueTry: number | null;
  estimatedMonthlyEnergyKwh: number | null;
}

export interface WorkCentersOverview {
  items: WorkCenterRow[];
  activeCount: number;
  totalMachineCount: number;
  totalGrossMonthlyMinutes: number;
  totalTargetEffectiveMinutes: number;
  totalTheoreticalMonthlyRevenueTry: number | null;
  totalMonthlyEnergyKwh: number;
}

export function computeWorkCenterCapacity(input: {
  machineCount: number;
  shiftsPerDay: number;
  shiftMinutes: number;
  workingDaysPerMonth: number;
  targetOeePct: number;
  hourlyPowerKw: number | null;
  standardRatePerMinTry: number | null;
}): {
  grossMonthlyMinutes: number;
  targetEffectiveMinutes: number;
  theoreticalMonthlyRevenueTry: number | null;
  estimatedMonthlyEnergyKwh: number | null;
} {
  const grossDec = decimal(input.machineCount)
    .times(decimal(input.shiftsPerDay))
    .times(decimal(input.shiftMinutes))
    .times(decimal(input.workingDaysPerMonth));
  const effDec = grossDec.times(decimal(input.targetOeePct)).div(100);
  const grossMonthlyMinutes = round2(grossDec);
  const targetEffectiveMinutes = round2(effDec);

  const theoreticalMonthlyRevenueTry =
    input.standardRatePerMinTry != null && input.standardRatePerMinTry >= 0
      ? round2(effDec.times(decimal(input.standardRatePerMinTry)))
      : null;

  const estimatedMonthlyEnergyKwh =
    input.hourlyPowerKw != null && input.hourlyPowerKw >= 0
      ? round2(effDec.div(60).times(decimal(input.hourlyPowerKw)))
      : null;

  return {
    grossMonthlyMinutes,
    targetEffectiveMinutes,
    theoreticalMonthlyRevenueTry,
    estimatedMonthlyEnergyKwh,
  };
}

export const workCenterUpsertSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  code: z.string().trim().min(1, "İstasyon kodu zorunlu").max(40),
  name: z.string().trim().min(1, "İstasyon adı zorunlu").max(160),
  operationType: z.enum(WORK_CENTER_OPERATION_TYPES),
  machineCount: z.coerce.number().positive("Makine adedi 0'dan büyük olmalı").max(500),
  shiftsPerDay: z.coerce.number().int().min(1, "Vardiya en az 1").max(3, "Vardiya en fazla 3"),
  shiftMinutes: z.coerce.number().int().min(60, "Vardiya süresi en az 60 dk").max(720, "Vardiya en fazla 720 dk"),
  workingDaysPerMonth: z.coerce.number().int().min(1, "Çalışma günü en az 1").max(31, "Çalışma günü en fazla 31"),
  targetOeePct: z.coerce.number().gt(0, "Hedef OEE > 0 olmalı").max(100, "Hedef OEE en fazla %100"),
  hourlyPowerKw: z.coerce.number().min(0).max(5000).optional().nullable(),
  standardRatePerMinTry: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

export async function loadWorkCenters(client: Queryable): Promise<WorkCentersOverview> {
  try {
    const res = await client.query<{
      id: string;
      code: string;
      name: string;
      operation_type: WorkCenterOperationType;
      machine_count: string;
      shifts_per_day: number;
      shift_minutes: number;
      working_days_per_month: number;
      target_oee_pct: string;
      hourly_power_kw: string | null;
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
         hourly_power_kw::text,
         standard_rate_per_min_try::text,
         is_active
       from public.work_centers
       order by is_active desc, code asc`,
    );

    const items: WorkCenterRow[] = (res.rows ?? []).map((r) => {
      const machineCount = num(r.machine_count);
      const shiftsPerDay = Number(r.shifts_per_day);
      const shiftMinutes = Number(r.shift_minutes);
      const workingDaysPerMonth = Number(r.working_days_per_month);
      const targetOeePct = num(r.target_oee_pct);
      const hourlyPowerKw = numOrNull(r.hourly_power_kw);
      const standardRatePerMinTry = numOrNull(r.standard_rate_per_min_try);
      const cap = computeWorkCenterCapacity({
        machineCount,
        shiftsPerDay,
        shiftMinutes,
        workingDaysPerMonth,
        targetOeePct,
        hourlyPowerKw,
        standardRatePerMinTry,
      });
      return {
        id: r.id,
        code: r.code,
        name: r.name,
        operationType: r.operation_type,
        machineCount,
        shiftsPerDay,
        shiftMinutes,
        workingDaysPerMonth,
        targetOeePct,
        hourlyPowerKw,
        standardRatePerMinTry,
        isActive: r.is_active,
        ...cap,
      };
    });

    const activeItems = items.filter((w) => w.isActive);
    const ratedItems = activeItems.filter((w) => w.theoreticalMonthlyRevenueTry != null);

    return {
      items,
      activeCount: activeItems.length,
      totalMachineCount: round2(sumDecimals(activeItems.map((w) => w.machineCount))),
      totalGrossMonthlyMinutes: round2(sumDecimals(activeItems.map((w) => w.grossMonthlyMinutes))),
      totalTargetEffectiveMinutes: round2(sumDecimals(activeItems.map((w) => w.targetEffectiveMinutes))),
      totalTheoreticalMonthlyRevenueTry:
        ratedItems.length > 0
          ? round2(sumDecimals(ratedItems.map((w) => w.theoreticalMonthlyRevenueTry ?? 0)))
          : null,
      totalMonthlyEnergyKwh: round2(
        sumDecimals(activeItems.map((w) => w.estimatedMonthlyEnergyKwh ?? 0)),
      ),
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return {
        items: [],
        activeCount: 0,
        totalMachineCount: 0,
        totalGrossMonthlyMinutes: 0,
        totalTargetEffectiveMinutes: 0,
        totalTheoreticalMonthlyRevenueTry: null,
        totalMonthlyEnergyKwh: 0,
      };
    }
    throw err;
  }
}

export async function upsertWorkCenter(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ id: string }> {
  const input = parseOrThrow(workCenterUpsertSchema, rawInput, "İş istasyonu formu");
  const normalizedCode = input.code.trim().toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (input.id) {
      const beforeRes = await client.query(
        `select id::text, code, name, operation_type, machine_count::text, shifts_per_day,
                shift_minutes, working_days_per_month, target_oee_pct::text,
                hourly_power_kw::text, standard_rate_per_min_try::text, is_active
           from public.work_centers
          where id = $1
          for update`,
        [input.id],
      );
      if (beforeRes.rowCount !== 1) {
        throw new DomainError("İş istasyonu bulunamadı.");
      }

      const upd = await client.query<{ id: string }>(
        `update public.work_centers
            set code = $2,
                name = $3,
                operation_type = $4,
                machine_count = $5,
                shifts_per_day = $6,
                shift_minutes = $7,
                working_days_per_month = $8,
                target_oee_pct = $9,
                hourly_power_kw = $10,
                standard_rate_per_min_try = $11,
                is_active = $12,
                updated_at = now()
          where id = $1
          returning id::text`,
        [
          input.id,
          normalizedCode,
          input.name,
          input.operationType,
          input.machineCount,
          input.shiftsPerDay,
          input.shiftMinutes,
          input.workingDaysPerMonth,
          input.targetOeePct,
          input.hourlyPowerKw ?? 0,
          input.standardRatePerMinTry ?? null,
          input.isActive,
        ],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("İş istasyonu güncellenemedi.");
      }

      await audit(client, {
        actor: actorId,
        action: "update_work_center",
        entityTable: "work_centers",
        entityId: upd.rows[0].id,
        before: beforeRes.rows[0],
        after: { ...input, code: normalizedCode },
      });

      await client.query("commit");
      return { id: upd.rows[0].id };
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.work_centers
         (code, name, operation_type, machine_count, shifts_per_day, shift_minutes,
          working_days_per_month, target_oee_pct, hourly_power_kw, standard_rate_per_min_try, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (code) do update
         set name = excluded.name,
             operation_type = excluded.operation_type,
             machine_count = excluded.machine_count,
             shifts_per_day = excluded.shifts_per_day,
             shift_minutes = excluded.shift_minutes,
             working_days_per_month = excluded.working_days_per_month,
             target_oee_pct = excluded.target_oee_pct,
             hourly_power_kw = excluded.hourly_power_kw,
             standard_rate_per_min_try = excluded.standard_rate_per_min_try,
             is_active = excluded.is_active,
             updated_at = now()
       returning id::text`,
      [
        normalizedCode,
        input.name,
        input.operationType,
        input.machineCount,
        input.shiftsPerDay,
        input.shiftMinutes,
        input.workingDaysPerMonth,
        input.targetOeePct,
        input.hourlyPowerKw ?? 0,
        input.standardRatePerMinTry ?? null,
        input.isActive,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("İş istasyonu kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_work_center",
      entityTable: "work_centers",
      entityId: ins.rows[0].id,
      after: { ...input, code: normalizedCode },
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

export async function setWorkCenterActive(
  pool: Pool,
  id: string,
  isActive: boolean,
  actorId: string | null,
): Promise<void> {
  const parsed = parseOrThrow(
    z.object({ id: z.string().uuid("Geçersiz istasyon ID"), isActive: z.boolean() }),
    { id, isActive },
    "İş istasyonu durum formu",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeRes = await client.query<{ is_active: boolean; code: string }>(
      `select is_active, code from public.work_centers where id = $1 for update`,
      [parsed.id],
    );
    if (beforeRes.rowCount !== 1) {
      throw new DomainError("İş istasyonu bulunamadı.");
    }
    const upd = await client.query(
      `update public.work_centers set is_active = $2, updated_at = now() where id = $1`,
      [parsed.id, parsed.isActive],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("İş istasyonu durumu güncellenemedi.");
    }
    await audit(client, {
      actor: actorId,
      action: parsed.isActive ? "activate_work_center" : "deactivate_work_center",
      entityTable: "work_centers",
      entityId: parsed.id,
      before: beforeRes.rows[0],
      after: { code: beforeRes.rows[0].code, is_active: parsed.isActive },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
