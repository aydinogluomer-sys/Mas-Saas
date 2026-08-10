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
import { normalizeActionStatus, type DqSeverity } from "@/lib/data-quality/rules";
import { requireSession } from "@/lib/auth";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function severityFromForm(v: FormDataEntryValue | null): DqSeverity {
  const s = String(v ?? "medium");
  return SEVERITIES.includes(s as DqSeverity) ? (s as DqSeverity) : "medium";
}

function backTo(formData: FormData, fallback = "/data-quality") {
  const b = String(formData.get("backTo") ?? fallback);
  return b.startsWith("/") ? b : fallback;
}

export async function createActionFromReviewAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const reviewId = String(formData.get("reviewId") ?? "");
  if (reviewId) await createActionFromReview(getPool(), reviewId, session.id);
  const b = backTo(formData);
  revalidatePath("/data-quality");
  revalidatePath(b);
  redirect(b);
}

export async function createActionFromHomeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const title = String(formData.get("title") ?? "").trim();
  const sourceFactKey = String(formData.get("sourceFactKey") ?? "").trim();
  const sourceHref = String(formData.get("sourceHref") ?? "/");
  if (title && sourceFactKey) {
    await createActionFromHomeSignal(getPool(), {
      title,
      severity: severityFromForm(formData.get("severity")),
      sourceFactKey,
      sourceHref: sourceHref.startsWith("/") ? sourceHref : "/",
      note: String(formData.get("note") ?? "").trim() || null,
    }, session.id);
  }
  const b = backTo(formData, "/");
  revalidatePath("/data-quality");
  revalidatePath("/");
  redirect(b);
}

export async function createActionFromAiResponseAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const aiResponseId = String(formData.get("aiResponseId") ?? "");
  if (aiResponseId) await createActionFromAiResponse(getPool(), aiResponseId, session.id);
  const b = backTo(formData, "/ask");
  revalidatePath("/data-quality");
  revalidatePath("/ask");
  revalidatePath("/reports");
  redirect(b);
}

export async function createActionFromReportAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const reportId = String(formData.get("reportId") ?? "");
  if (reportId) await createActionFromReport(getPool(), reportId, session.id);
  const b = backTo(formData, "/reports");
  revalidatePath("/data-quality");
  revalidatePath("/reports");
  redirect(b);
}

export async function createManualActionAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  await createManualAction(getPool(), {
    title: String(formData.get("title") ?? ""),
    severity: severityFromForm(formData.get("severity")),
    owner: String(formData.get("owner") ?? "").trim() || null,
    dueDate: String(formData.get("dueDate") ?? "").trim() || null,
    note: String(formData.get("note") ?? "").trim() || null,
  }, session.id);
  const b = backTo(formData, "/insights/tasks");
  revalidatePath("/data/quality");
  revalidatePath("/insights/tasks");
  redirect(b);
}

export async function setActionStatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
