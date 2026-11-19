"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import {
  createActionFromHomeSignal,
  createActionFromAiResponse,
  createActionFromReport,
  createActionFromReview,
  createManualAction,
  setActionStatus,
} from "@/lib/data-quality/engine";
import { assignActionItemOwner, autoCloseSettledActionItems } from "@/lib/action-items/engine";
import { normalizeActionStatus, type DqSeverity } from "@/lib/data-quality/rules";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function severityFromForm(v: FormDataEntryValue | null): DqSeverity {
  const s = String(v ?? "medium");
  return SEVERITIES.includes(s as DqSeverity) ? (s as DqSeverity) : "medium";
}

function backTo(formData: FormData, fallback = "/data/quality") {
  return safeRedirectPath(formData.get("backTo"), fallback);
}

export async function createActionFromReviewAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", "/data/quality");
  const reviewId = String(formData.get("reviewId") ?? "");
  if (reviewId) await createActionFromReview(getPool(), reviewId, session.id);
  const b = backTo(formData);
  revalidatePath("/data/quality");
  revalidatePath(b);
  redirect(b);
}

export async function createActionFromHomeAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", "/data/quality");
  const title = String(formData.get("title") ?? "").trim();
  const sourceFactKey = String(formData.get("sourceFactKey") ?? "").trim();
  const sourceHref = safeRedirectPath(formData.get("sourceHref"), "/");
  if (title && sourceFactKey) {
    await createActionFromHomeSignal(getPool(), {
      title,
      severity: severityFromForm(formData.get("severity")),
      sourceFactKey,
      sourceHref,
      note: String(formData.get("note") ?? "").trim() || null,
    }, session.id);
  }
  const b = backTo(formData, "/");
  revalidatePath("/data/quality");
  revalidatePath("/");
  redirect(b);
}

export async function createActionFromAiResponseAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", "/data/quality");
  const aiResponseId = String(formData.get("aiResponseId") ?? "");
  if (aiResponseId) await createActionFromAiResponse(getPool(), aiResponseId, session.id);
  const b = backTo(formData, "/insights/ask");
  revalidatePath("/data/quality");
  revalidatePath("/insights/ask");
  revalidatePath("/insights/reports");
  redirect(b);
}

export async function createActionFromReportAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", "/data/quality");
  const reportId = String(formData.get("reportId") ?? "");
  if (reportId) await createActionFromReport(getPool(), reportId, session.id);
  const b = backTo(formData, "/insights/reports");
  revalidatePath("/data/quality");
  revalidatePath("/insights/reports");
  redirect(b);
}

export async function createManualActionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", "/data/quality");
  const ownerUserIdRaw = String(formData.get("ownerUserId") ?? "").trim();
  const autoCloseRaw = formData.get("autoCloseOnSettlement");
  await createManualAction(getPool(), {
    title: String(formData.get("title") ?? ""),
    severity: severityFromForm(formData.get("severity")),
    owner: String(formData.get("owner") ?? "").trim() || null,
    ownerUserId: ownerUserIdRaw || null,
    autoCloseOnSettlement: autoCloseRaw === null ? true : autoCloseRaw === "on" || autoCloseRaw === "true",
    dueDate: String(formData.get("dueDate") ?? "").trim() || null,
    note: String(formData.get("note") ?? "").trim() || null,
    relatedEntityTable: String(formData.get("relatedEntityTable") ?? "").trim() || null,
    relatedEntityId: String(formData.get("relatedEntityId") ?? "").trim() || null,
  }, session.id);
  const b = backTo(formData, "/insights/tasks");
  revalidatePath("/data/quality");
  revalidatePath("/insights/tasks");
  redirect(b);
}

export async function assignActionOwnerAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "update", "/insights/tasks");
  const actionId = String(formData.get("actionId") ?? "").trim();
  const ownerUserIdRaw = String(formData.get("ownerUserId") ?? "").trim();
  if (actionId) {
    await assignActionItemOwner(
      getPool(),
      { actionId, ownerUserId: ownerUserIdRaw || null },
      session.id,
    );
  }
  const b = backTo(formData, "/insights/tasks");
  revalidatePath("/data/quality");
  revalidatePath("/insights/tasks");
  redirect(b);
}

export async function autoCloseSettledActionsAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "update", "/insights/tasks");
  const res = await autoCloseSettledActionItems(getPool(), session.id);
  const b = backTo(formData, "/insights/tasks");
  revalidatePath("/data/quality");
  revalidatePath("/insights/tasks");
  revalidatePath("/");
  const sep = b.includes("?") ? "&" : "?";
  redirect(`${b}${sep}autoClosed=${res.closedCount}`);
}

export async function setActionStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "update", "/data/quality");
  const id = String(formData.get("id") ?? "");
  const status = normalizeActionStatus(String(formData.get("status") ?? ""));
  const completionNote = String(formData.get("completionNote") ?? "").trim() || null;
  if (id && status) await setActionStatus(getPool(), id, status, session.id, completionNote);
  const b = backTo(formData);
  revalidatePath("/data/quality");
  revalidatePath("/insights/tasks");
  revalidatePath("/");
  redirect(b);
}

