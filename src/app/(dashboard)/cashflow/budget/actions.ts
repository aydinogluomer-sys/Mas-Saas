"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { canApprovePlanningLines } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  approveBudgetVersion,
  createBudget,
  createBudgetLine,
  createForecast,
  createForecastLine,
  requestPlanningLineApproval,
} from "@/lib/budget/engine";

const BASE = "/cashflow/budget";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

function revalidateBudgetSurfaces(): void {
  revalidatePath(BASE);
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

