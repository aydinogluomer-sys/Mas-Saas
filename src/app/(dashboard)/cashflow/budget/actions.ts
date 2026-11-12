"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { canApprovePlanningLines } from "@/lib/authz/matrix";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { formObject } from "@/lib/validation";
import {
  approveBudgetVersion,
  createBudget,
  createBudgetLine,
  createForecast,
  createForecastLine,
  recordActual,
  requestPlanningLineApproval,
  setLineVersion,
} from "@/lib/budget/engine";

const BASE = "/cashflow/budget";

function domainRedirect(e: unknown): never {
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(
      `${BASE}?error=${encodeURIComponent(
        toUserActionErrorMessage(e, "Bütçe/tahmin işlemi tamamlanamadı."),
      )}`,
    );
  }
  if (e && typeof e === "object" && (e as { code?: unknown }).code === "42501") {
    const msg = String((e as { message?: unknown }).message ?? "Bu işlem için yetkiniz yok.");
    redirect(`${BASE}?error=${encodeURIComponent(msg.slice(0, 240))}`);
  }
  throw e;
}

function revalidateBudgetSurfaces(): void {
  revalidatePath(BASE);
  revalidatePath("/cashflow/controls");
  revalidatePath("/insights/analysis");
  revalidatePath("/insights/briefing");
  revalidatePath("/data/approvals");
}

export async function createBudgetAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("budgets", "insert", BASE);
  const f = formObject(formData);
  try {
    await createBudget(
      getPool(),
      {
        name: f.name,
        fiscalYear: Number(f.fiscalYear),
        periodKind: f.periodKind || "monthly",
        currency: f.currency || "TRY",
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=butce-olusturuldu`);
}

export async function addBudgetLineAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("budget_lines", "insert", BASE);
  const f = formObject(formData);
  try {
    await createBudgetLine(
      getPool(),
      {
        budgetId: f.budgetId,
        periodStart: f.periodStart,
        direction: f.direction,
        amount: Number(f.amount),
        currency: f.currency || "TRY",
        costCenterId: f.costCenterId || null,
        departmentId: f.departmentId || null,
        projectId: f.projectId || null,
        categoryId: f.categoryId || null,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=butce-satiri-eklendi`);
}

export async function submitBudgetForApprovalAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("approvals", "insert", BASE);
  const f = formObject(formData);
  const table = f.table === "forecast_lines" ? "forecast_lines" : "budget_lines";
  try {
    await requestPlanningLineApproval(
      getPool(),
      table,
      String(f.lineId ?? ""),
      session.id,
      f.note ? String(f.note) : undefined,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=onaya-gonderildi`);
}

export async function approveBudgetVersionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("budget_lines", "update", BASE);
  if (!canApprovePlanningLines(session.role)) {
    redirect(`${BASE}?error=${encodeURIComponent("Bütçe/tahmin onaylama yetkisi yalnız onaylayıcı ve üstü katmanlardadır.")}`);
  }
  const f = formObject(formData);
  const table = f.table === "forecast_lines" ? "forecast_lines" : "budget_lines";
  try {
    await approveBudgetVersion(
      getPool(),
      {
        table,
        lineId: f.lineId ? String(f.lineId) : undefined,
        budgetId: f.budgetId ? String(f.budgetId) : undefined,
        note: f.note ? String(f.note) : undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=versiyon-onaylandi`);
}

export async function createForecastAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecasts", "insert", BASE);
  const f = formObject(formData);
  try {
    await createForecast(
      getPool(),
      {
        name: f.name,
        horizonKind: f.horizonKind || "weekly_13",
        anchorDate: f.anchorDate,
        currency: f.currency || "TRY",
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=tahmin-olusturuldu`);
}

export async function createForecastLineAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecast_lines", "insert", BASE);
  const f = formObject(formData);
  try {
    await createForecastLine(
      getPool(),
      {
        forecastId: f.forecastId,
        periodStart: f.periodStart,
        periodEnd: f.periodEnd,
        direction: f.direction,
        amount: Number(f.amount),
        sourceKind: f.sourceKind || "manual",
        confidence: f.confidence ? Number(f.confidence) : undefined,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=tahmin-satiri-eklendi`);
}

export async function recordActualAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("forecast_lines", "update", BASE);
  const f = formObject(formData);
  try {
    await recordActual(
      getPool(),
      {
        lineId: String(f.lineId ?? ""),
        actualAmount: Number(f.actualAmount),
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=gerceklesen-kaydedildi`);
}

export async function setLineVersionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    String(formData.get("table") ?? "") === "forecast_lines" ? "forecast_lines" : "budget_lines",
    "update",
    BASE,
  );
  const f = formObject(formData);
  const table = f.table === "forecast_lines" ? "forecast_lines" : "budget_lines";
  const status = f.status === "approved" ? "approved" : "superseded";
  if (status === "approved" && !canApprovePlanningLines(session.role)) {
    redirect(
      `${BASE}?error=${encodeURIComponent(
        "Bütçe/tahmin onaylama yetkisi yalnız onaylayıcı ve üstü katmanlardadır.",
      )}`,
    );
  }
  try {
    await setLineVersion(
      getPool(),
      table,
      {
        lineId: String(f.lineId ?? ""),
        status,
        supersededByLineId: f.supersededByLineId ? String(f.supersededByLineId) : null,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateBudgetSurfaces();
  redirect(`${BASE}?result=${status === "approved" ? "versiyon-onaylandi" : "eski-versiyona-alindi"}`);
}

