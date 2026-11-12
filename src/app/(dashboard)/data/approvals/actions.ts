"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission, requireAdmin } from "@/lib/auth";
import {
  decideApproval,
  resubmitApproval,
  toggleApprovalRule,
  TRIGGER_KINDS,
  updateApprovalGovernanceSettings,
  upsertApprovalRule,
  type ApprovalTriggerKind,
} from "@/lib/approvals/engine";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";

const BASE = "/data/approvals";

function revalidateAll(): void {
  revalidatePath(BASE);
  revalidatePath("/data/reviews");
  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
  revalidatePath("/finance/collections");
  revalidatePath("/finance/invoices");
  revalidatePath("/payments/items");
}

function redirectWithApprovalError(e: unknown): never {
  if (e instanceof DomainError) {
    revalidateAll();
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function decideApprovalAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("approvals", "update", BASE);
  const approvalId = String(formData.get("approvalId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const justification = String(formData.get("justification") ?? "").trim();
  try {
    await decideApproval(
      getPool(),
      {
        approvalId,
        decision,
        note: note === "" ? undefined : note,
        justification: justification === "" ? (note === "" ? undefined : note) : justification,
      },
      session.id,
    );
  } catch (e) {
    redirectWithApprovalError(e);
  }
  revalidateAll();
  redirect(`${BASE}?result=${encodeURIComponent("Onay kararı kaydedildi.")}`);
}

export async function resubmitApprovalAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("approvals", "update", BASE);
  const approvalId = String(formData.get("approvalId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  try {
    await resubmitApproval(
      getPool(),
      {
        approvalId,
        note: note === "" ? undefined : note,
      },
      session.id,
    );
  } catch (e) {
    redirectWithApprovalError(e);
  }
  revalidateAll();
  redirect(`${BASE}?result=${encodeURIComponent("Kayıt yeniden onaya gönderildi.")}`);
}

export async function updateApprovalGovernanceAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const allowSingleOperatorSelfApproval =
    String(formData.get("allowSingleOperatorSelfApproval") ?? "") === "on";
  const minJustificationLengthRaw = String(formData.get("minJustificationLength") ?? "10").trim();
  const minJustificationLength = Number(minJustificationLengthRaw);
  try {
    await updateApprovalGovernanceSettings(
      getPool(),
      {
        allowSingleOperatorSelfApproval,
        minJustificationLength: Number.isFinite(minJustificationLength) ? minJustificationLength : 10,
      },
      admin.id,
    );
  } catch (e) {
    redirectWithApprovalError(e);
  }
  revalidateAll();
  redirect(`${BASE}?result=${encodeURIComponent("Tek operatör öz-onay politikası güncellendi.")}`);
}

function parseTriggerKind(raw: string): ApprovalTriggerKind {
  if ((TRIGGER_KINDS as readonly string[]).includes(raw)) {
    return raw as ApprovalTriggerKind;
  }
  return "amount_gte";
}

export async function upsertApprovalRuleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const ruleId = String(formData.get("ruleId") ?? "").trim() || undefined;
  const code = String(formData.get("code") ?? "").trim().toLowerCase();
  const description = String(formData.get("description") ?? "").trim();
  const triggerKind = parseTriggerKind(String(formData.get("triggerKind") ?? "amount_gte").trim());
  const thresholdStr = String(formData.get("thresholdAmount") ?? "").trim();
  const thresholdAmount =
    thresholdStr === "" ? null : Number.isFinite(Number(thresholdStr)) ? Number(thresholdStr) : null;
  const currency = String(formData.get("currency") ?? "TRY").trim().toUpperCase() || "TRY";
  const appliesRaw = String(formData.get("appliesTo") ?? "").trim();
  const appliesTo = appliesRaw
    ? appliesRaw
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const isActive = formData.has("hasIsActiveField")
    ? String(formData.get("isActive") ?? "") === "on"
    : true;

  try {
    await upsertApprovalRule(
      getPool(),
      {
        ruleId,
        code,
        description,
        triggerKind,
        thresholdAmount,
        currency,
        appliesTo,
        isActive,
      },
      admin.id,
    );
  } catch (e) {
    redirectWithApprovalError(e);
  }
  revalidateAll();
  redirect(`${BASE}?result=${encodeURIComponent("Onay kuralı kaydedildi.")}`);
}

export async function toggleApprovalRuleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const ruleId = String(formData.get("ruleId") ?? "").trim();
  const nextActive = String(formData.get("nextActive") ?? "") === "true";
  try {
    await toggleApprovalRule(getPool(), ruleId, nextActive, admin.id);
  } catch (e) {
    redirectWithApprovalError(e);
  }
  revalidateAll();
  redirect(`${BASE}?result=${encodeURIComponent("Onay kuralı durumu güncellendi.")}`);
}
