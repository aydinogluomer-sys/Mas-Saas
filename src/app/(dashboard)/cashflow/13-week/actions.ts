"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { createForecast, createForecastLine } from "@/lib/budget/engine";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { freezeWeekly13wSnapshot, mondayOfWeek } from "@/lib/cashflow/rolling-13w-engine";
import { getPool } from "@/lib/db";
import { formObject } from "@/lib/validation";

const BASE = "/cashflow/13-week";

function normalizeCurrency(raw: unknown): "TRY" | "USD" | "EUR" {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "TRY";
  if (s === "USD" || s === "EUR") return s;
  return "TRY";
}

function normalizeDbtMode(raw: unknown): "median" | "p75" {
  return raw === "p75" ? "p75" : "median";
}

function domainRedirect(e: unknown, currency: string): never {
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(
      `${BASE}?currency=${encodeURIComponent(currency)}&error=${encodeURIComponent(
        toUserActionErrorMessage(e, "13 haftalık nakit tahmini işlemi tamamlanamadı."),
      )}`,
    );
  }
  throw e;
}

export async function refreshAutoSeeded13WeekAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecast_snapshots_13w", "select", BASE);
  void session;
  const f = formObject(formData);
  const currency = normalizeCurrency(f.currency);
  const dbtMode = normalizeDbtMode(f.dbtMode);
  revalidatePath(BASE);
  revalidatePath("/cashflow/budget");
  redirect(`${BASE}?currency=${currency}&dbtMode=${dbtMode}&result=otomatik-yenilendi`);
}

export async function freeze13WeekSnapshotAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecast_snapshot_13w_lines", "delete", BASE);
  const f = formObject(formData);
  const currency = normalizeCurrency(f.currency);
  const dbtMode = normalizeDbtMode(f.dbtMode);
  const asOfDate =
    typeof f.asOfDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.asOfDate)
      ? f.asOfDate
      : new Date().toISOString().slice(0, 10);

  let snapshotId = "";
  try {
    const res = await freezeWeekly13wSnapshot(getPool(), {
      asOfDate,
      currency,
      actor: session.id,
      dbtMode,
    });
    snapshotId = res.snapshotId;
  } catch (e) {
    domainRedirect(e, currency);
  }
  revalidatePath(BASE);
  revalidatePath("/cashflow/budget");
  redirect(
    `${BASE}?currency=${currency}&dbtMode=${dbtMode}&snapshotId=${encodeURIComponent(snapshotId)}&result=anlik-goruntu-donduruldu`,
  );
}

export async function addManual13WeekOverrideAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecast_lines", "insert", BASE);
  const f = formObject(formData);
  const currency = normalizeCurrency(f.currency);
  const dbtMode = normalizeDbtMode(f.dbtMode);
  const weekStartRaw = typeof f.weekStart === "string" ? f.weekStart.trim() : "";
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(weekStartRaw)
    ? mondayOfWeek(weekStartRaw)
    : mondayOfWeek(new Date().toISOString().slice(0, 10));
  const weekEnd = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const direction = f.direction === "inflow" ? "inflow" : "outflow";
  const amount = Number(f.amount ?? 0);
  const notes = typeof f.notes === "string" ? f.notes.trim() : "";

  try {
    const pool = getPool();
    const existing = await pool.query<{ id: string }>(
      `select id::text
         from public.forecasts
        where is_active
          and horizon_kind = 'weekly_13'
          and currency = $1
        order by anchor_date desc, created_at desc
        limit 1`,
      [currency],
    );
    const forecastId =
      existing.rowCount && existing.rows[0]?.id
        ? existing.rows[0].id
        : await createForecast(
            pool,
            {
              name: `13 Haftalık Doğrudan Nakit Tahmini (${currency})`,
              horizonKind: "weekly_13",
              anchorDate: weekStart,
              currency,
              notes: "Faz 54 otomatik beslenen 13 haftalık tahmin konteyneri",
            },
            session.id,
          );

    await createForecastLine(
      pool,
      {
        forecastId,
        periodStart: weekStart,
        periodEnd: weekEnd,
        direction,
        amount,
        sourceKind: "manual",
        notes: notes || "Manuel CFO düzeltme satırı",
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e, currency);
  }

  revalidatePath(BASE);
  revalidatePath("/cashflow/budget");
  redirect(`${BASE}?currency=${currency}&dbtMode=${dbtMode}&result=manuel-satir-eklendi`);
}

