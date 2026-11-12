"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  createReconciliationTask,
  signOffReconciliation,
} from "@/lib/reconciliation/signoffs";

const DEFAULT_BASE = "/data/reconciliation";

function safeReturnTo(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "/cashflow/controls" || s === "/data/reconciliation") return s;
  return DEFAULT_BASE;
}

function domainRedirect(e: unknown, base: string): never {
  if (e instanceof DomainError) {
    redirect(`${base}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function createReconciliationTaskAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "action_items",
    "insert",
    safeReturnTo(formData.get("returnTo")),
  );
  const f = formObject(formData);
  const base = safeReturnTo(f.returnTo);
  try {
    await createReconciliationTask(
      getPool(),
      {
        title: f.title,
        severity: f.severity || "high",
        relatedEntityTable: f.relatedEntityTable || null,
        relatedEntityId: f.relatedEntityId || null,
        note: f.note || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e, base);
  }
  revalidatePath(base);
  revalidatePath("/overview/actions");
  redirect(`${base}?result=gorev-olusturuldu`);
}

export async function signOffReconciliationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("reconciliation_signoffs", "insert", DEFAULT_BASE);
  const f = formObject(formData);
  try {
    await signOffReconciliation(
      getPool(),
      {
        periodMonth: f.periodMonth,
        scope: f.scope,
        status: f.status,
        openExceptionCount: f.openExceptionCount ? Number(f.openExceptionCount) : 0,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e, DEFAULT_BASE);
  }
  revalidatePath(DEFAULT_BASE);
  redirect(`${DEFAULT_BASE}?result=mutabakat-imzalandi`);
}
