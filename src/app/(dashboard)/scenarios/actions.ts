"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeApprovedOptimizationRun } from "@/lib/approvals/engine";
import { getPool } from "@/lib/db";
import { createAndRun, deleteScenarioRun, estimateOptimizationCandidates, type ScenarioType } from "@/lib/scenarios/engine";
import { runUnifiedDynamicScenario } from "@/lib/scenarios/unified-engine";
import { requestOptimizationApproval, runOptimization } from "@/lib/optimization/engine";
import type { ScenarioAssumptions } from "@/lib/scenarios/rules";
import { requireActionPermission } from "@/lib/auth";

function pctFromForm(v: FormDataEntryValue | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
}
function numFromForm(v: FormDataEntryValue | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strFromForm(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

export async function runScenarioAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("scenario_runs", "insert", "/scenarios");
  const assumptions: ScenarioAssumptions = {
    revenuePct: pctFromForm(formData.get("revenuePct")),
    expensePct: pctFromForm(formData.get("expensePct")),
    customerDelayMonths: numFromForm(formData.get("customerDelayMonths")),
    targetIncomeLabel: strFromForm(formData.get("targetIncomeLabel")),
    targetIncomeDelayMonths: numFromForm(formData.get("targetIncomeDelayMonths")),
    targetOutflowLabel: strFromForm(formData.get("targetOutflowLabel")),
    targetOutflowDelayMonths: numFromForm(formData.get("targetOutflowDelayMonths")),
    factoringIncomeLabel: strFromForm(formData.get("factoringIncomeLabel")),
    factoringAdvanceMonth: strFromForm(formData.get("factoringAdvanceMonth")),
    factoringFeePct: pctFromForm(formData.get("factoringFeePct")),
    capacityUtilizationPct: pctFromForm(formData.get("capacityUtilizationPct")),
    efficiencyPct: pctFromForm(formData.get("efficiencyPct")),
    includeDebtService: formData.get("includeDebtService") === "on",
  };
  const name = String(formData.get("name") ?? "").trim() || "Adsız senaryo";
  const scenarioType = (String(formData.get("scenarioType") ?? "combined_custom_scenario")) as ScenarioType;
  const useExternalEntries = formData.getAll("useExternalAssumptions").map((v) => String(v));
  const useExternalAssumptions =
    useExternalEntries.length === 0
      ? true
      : useExternalEntries.includes("on") || useExternalEntries.includes("true");

  const pool = getPool();
  const { runId } = await createAndRun(
    pool,
    { name, scenarioType, assumptions, useExternalAssumptions },
    session.id,
  );
  revalidatePath("/scenarios");
  redirect(`/scenarios/${runId}`);
}

export async function deleteScenarioRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("scenario_runs", "delete", "/scenarios");
  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;
  const pool = getPool();
  await deleteScenarioRun(pool, runId, session.id);
  revalidatePath("/scenarios");
  redirect("/scenarios");
}

export async function runOptimizationCandidateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("scenario_runs", "insert", "/scenarios");
  const key = String(formData.get("candidateKey") ?? "");
  const pool = getPool();
  const candidate = (await estimateOptimizationCandidates(pool)).find((item) => item.key === key);
  if (!candidate) redirect("/scenarios/optimization?result=not-found");
  const { runId } = await createAndRun(pool, {
    name: `Optimizasyon: ${candidate.label}`,
    scenarioType: "combined_custom_scenario",
    assumptions: candidate.assumptions,
  }, session.id);
  revalidatePath("/scenarios/optimization");
  revalidatePath("/scenarios/history");
  redirect(`/scenarios/${runId}`);
}

export async function runUnifiedScenarioAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("scenario_runs", "insert", "/scenarios");
  const name = String(formData.get("name") ?? "").trim() || "13H Birleşik Dinamik Senaryo";
  const description = strFromForm(formData.get("description"));
  const fxShockPct = numFromForm(formData.get("fxShockPct")) ?? 0;
  const collectionDelayDays = Math.max(0, Math.round(numFromForm(formData.get("collectionDelayDays")) ?? 0));
  const paymentDelayDays = Math.max(0, Math.round(numFromForm(formData.get("paymentDelayDays")) ?? 0));
  const revenueDeltaPct = numFromForm(formData.get("revenueDeltaPct")) ?? 0;
  const passThroughPct = Math.max(0, numFromForm(formData.get("passThroughPct")) ?? 0);
  const expenseDeltaRaw = numFromForm(formData.get("expenseDeltaPct"));
  const minCashBufferRaw = numFromForm(formData.get("minCashBufferTry"));

  const autoDrawEntries = formData.getAll("autoDrawFacility").map((v) => String(v));
  const autoDrawFacility =
    autoDrawEntries.length === 0
      ? true
      : autoDrawEntries.includes("on") || autoDrawEntries.includes("true");

  const useExternalEntries = formData.getAll("useExternalAssumptions").map((v) => String(v));
  const useExternalAssumptions =
    useExternalEntries.length === 0
      ? true
      : useExternalEntries.includes("on") || useExternalEntries.includes("true");

  const { runId } = await runUnifiedDynamicScenario(
    getPool(),
    {
      name,
      description,
      fxShockPct,
      collectionDelayDays,
      paymentDelayDays,
      revenueDeltaPct,
      passThroughPct,
      expenseDeltaPct: expenseDeltaRaw ?? undefined,
      minCashBufferTry: minCashBufferRaw ?? undefined,
      autoDrawFacility,
      useExternalAssumptions,
    },
    session.id,
  );
  revalidatePath("/scenarios");
  revalidatePath("/scenarios/history");
  revalidatePath("/scenarios/compare");
  redirect(`/scenarios/${runId}`);
}

export async function runLiquidityOptimizationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("optimization_runs", "insert", "/scenarios/optimization");
  const name = String(formData.get("name") ?? "").trim() || "91 Günlük (13H) Likidite Çözücü";
  const objectiveRaw = String(formData.get("objective") ?? "max_liquidity_buffer");
  const objective =
    objectiveRaw === "min_financing_cost" || objectiveRaw === "min_late_payment"
      ? objectiveRaw
      : "max_liquidity_buffer";
  const anchorDate =
    String(formData.get("anchorDate") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const horizonDays = Math.min(365, Math.max(7, Number(formData.get("horizonDays") ?? 91) || 91));
  const currency = String(formData.get("currency") ?? "TRY").trim() || "TRY";

  await runOptimization(
    getPool(),
    { name, objective, anchorDate, horizonDays, currency },
    session.id,
  );
  revalidatePath("/scenarios/optimization");
}

export async function requestOptimizationApprovalAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("approvals", "insert", "/scenarios/optimization");
  const runId = String(formData.get("runId") ?? "").trim();
  if (runId) {
    await requestOptimizationApproval(getPool(), runId, session.id);
  }
  revalidatePath("/scenarios/optimization");
  revalidatePath("/data/approvals");
  redirect(`/scenarios/optimization?runId=${runId}`);
}

export async function executeOptimizationPlanAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("optimization_runs", "update", "/scenarios/optimization");
  const runId = String(formData.get("runId") ?? "").trim();
  if (runId) {
    await executeApprovedOptimizationRun(getPool(), { runId }, session.id);
  }
  revalidatePath("/scenarios/optimization");
  revalidatePath("/payments");
  revalidatePath("/cashflow");
  redirect(`/scenarios/optimization?runId=${runId}&executed=1`);
}
