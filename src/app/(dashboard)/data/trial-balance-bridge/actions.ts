"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { importStatutoryMizan } from "@/lib/ledger/statutory-mizan-importer";
import {
  createActionFromReconciliationItem,
  reconcileTrialBalance,
} from "@/lib/ledger/trial-balance-bridge";
import { formObject } from "@/lib/validation";

const BASE = "/data/trial-balance-bridge";

function strField(v: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(v)) return (v[0] ?? fallback).trim();
  return (v ?? fallback).trim();
}

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  if (e instanceof Error && e.name === "ZodError") {
    redirect(`${BASE}?error=${encodeURIComponent(e.message.slice(0, 240))}`);
  }
  throw e;
}

export async function importAndReconcileMizanAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("statutory_trial_balances", "insert", BASE);
  const f = formObject(formData);
  const asOfDate = strField(f.asOfDate) || new Date().toISOString().slice(0, 10);
  const periodLabel = strField(f.periodLabel) || `${asOfDate.slice(0, 7)} Dönem Mizanı`;
  const sourceSoftware = strField(f.sourceSoftware, "Luca / Logo / Mikro");

  const fileEntry = formData.get("file");
  let buffer: Buffer | null = null;
  let originalFilename = "mizan.csv";

  if (fileEntry && typeof fileEntry === "object" && "arrayBuffer" in fileEntry) {
    const ab = await (fileEntry as File).arrayBuffer();
    if (ab.byteLength > 0) {
      buffer = Buffer.from(ab);
      originalFilename = (fileEntry as File).name || "mizan.xlsx";
    }
  }

  const rawText = strField(f.rawMizanText);
  if ((!buffer || buffer.length === 0) && rawText) {
    buffer = Buffer.from(rawText, "utf8");
    originalFilename = rawText.trim().startsWith("<") ? "mizan.xml" : "mizan.csv";
  }

  if (!buffer || buffer.length === 0) {
    redirect(
      `${BASE}?error=${encodeURIComponent("Lütfen bir Yasal Mizan dosyası (.xlsx / .csv / .xml) seçin veya mizan metnini yapıştırın.")}`,
    );
  }

  let runId = "";
  try {
    const imported = await importStatutoryMizan(
      getPool(),
      {
        asOfDate,
        periodLabel,
        sourceSoftware,
        originalFilename,
        buffer,
      },
      session.id,
    );
    const recon = await reconcileTrialBalance(getPool(), imported.trialBalanceId, session.id);
    runId = recon.runId;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?runId=${encodeURIComponent(runId)}&result=mizan-mutabakati-tamamlandi`);
}

export async function reconcileExistingMizanAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("trial_balance_reconciliation_runs", "insert", BASE);
  const f = formObject(formData);
  const trialBalanceId = strField(f.trialBalanceId);
  if (!trialBalanceId) {
    redirect(`${BASE}?error=${encodeURIComponent("Mizan kimliği gerekli.")}`);
  }

  let runId = "";
  try {
    const recon = await reconcileTrialBalance(getPool(), trialBalanceId, session.id);
    runId = recon.runId;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?runId=${encodeURIComponent(runId)}&result=mutabakat-yenilendi`);
}

export async function createReconciliationTaskAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", BASE);
  const f = formObject(formData);
  const itemId = strField(f.itemId);
  const runId = strField(f.runId);
  if (!itemId) {
    redirect(`${BASE}?error=${encodeURIComponent("Mutabakat satırı kimliği gerekli.")}`);
  }

  try {
    await createActionFromReconciliationItem(getPool(), itemId, session.id);
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(
    `${BASE}?${runId ? `runId=${encodeURIComponent(runId)}&` : ""}result=gorev-olusturuldu`,
  );
}

