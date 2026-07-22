"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { createAndRun, deleteScenarioRun, estimateOptimizationCandidates, type ScenarioType } from "@/lib/scenarios/engine";
import type { ScenarioAssumptions } from "@/lib/scenarios/rules";

function pctFromForm(v: FormDataEntryValue | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null; // form is in whole percent
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

  const pool = getPool();
  const { runId } = await createAndRun(pool, { name, scenarioType, assumptions });
  revalidatePath("/scenarios");
  redirect(`/scenarios/${runId}`);
}

export async function deleteScenarioRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId") ?? "");
  if (!runId) return;
  const pool = getPool();
  await deleteScenarioRun(pool, runId);
  revalidatePath("/scenarios");
  redirect("/scenarios");
}

export async function runOptimizationCandidateAction(formData: FormData): Promise<void> {
  const key = String(formData.get("candidateKey") ?? "");
  const pool = getPool();
  const candidate = (await estimateOptimizationCandidates(pool)).find((item) => item.key === key);
  if (!candidate) redirect("/scenarios/optimization?result=not-found");
  const { runId } = await createAndRun(pool, {
    name: `Optimizasyon: ${candidate.label}`,
    scenarioType: "combined_custom_scenario",
    assumptions: candidate.assumptions,
  });
  revalidatePath("/scenarios/optimization");
  revalidatePath("/scenarios/history");
  redirect(`/scenarios/${runId}`);
}
