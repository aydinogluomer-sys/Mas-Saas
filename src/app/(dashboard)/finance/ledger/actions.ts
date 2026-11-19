"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { createManagementSubAccount } from "@/lib/ledger/accounts";
import {
  reverseIntercompanyEliminationRun,
  runIntercompanyElimination,
} from "@/lib/ledger/intercompany-elimination";
import {
  approveDraftManagementEntry,
  discardDraftManagementEntry,
  postManualManagementAdjustment,
  rebuildOrSyncManagementLedger,
  revalueProvisionalFxEntries,
  reverseManagementEntry,
} from "@/lib/ledger/posting-engine";
import { postPeriodClosing } from "@/lib/ledger/reports";
import { formObject } from "@/lib/validation";

const BASE = "/finance/ledger";

function redirectWithFlash(kind: "result" | "error", message: string): never {
  redirect(`${BASE}?${kind}=${encodeURIComponent(message)}`);
}

function strField(v: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(v)) return (v[0] ?? fallback).trim();
  return (v ?? fallback).trim();
}

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(
      `${BASE}?error=${encodeURIComponent(
        toUserActionErrorMessage(e, "Yönetim defteri işlemi tamamlanamadı."),
      )}`,
    );
  }
  throw e;
}

export async function syncManagementLedgerAction(): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "insert", BASE);
  try {
    await rebuildOrSyncManagementLedger(getPool(), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=defter-senkronlandi`);
}

export async function revalueProvisionalFxAction(): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "update", BASE);
  let revaluedCount = 0;
  try {
    const out = await revalueProvisionalFxEntries(getPool(), session.id);
    revaluedCount = out.revaluedCount;
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(`kur-degerlendi-${revaluedCount}`)}`);
}

export async function postPeriodClosingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "insert", BASE);
  const f = formObject(formData);
  const fromDate = strField(f.fromDate);
  const toDate = strField(f.toDate);
  const entryDate = strField(f.entryDate) || toDate;
  if (!fromDate || !toDate) {
    redirect(`${BASE}?error=${encodeURIComponent("Kapanış dönemi başlangıç ve bitiş tarihi zorunludur.")}`);
  }
  let netResult = 0;
  try {
    const out = await postPeriodClosing(
      getPool(),
      { fromDate, toDate, entryDate },
      session.id,
    );
    netResult = out.netResultTry;
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/finance");
  revalidatePath("/insights/briefing");
  redirect(
    `${BASE}?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}&result=${encodeURIComponent(
      `donem-sonu-kapanisi-tamamlandi (${netResult.toFixed(2)} TRY)`,
    )}`,
  );
}

export async function discardDraftEntryAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "delete", BASE);
  const f = formObject(formData);
  const entryId = strField(f.entryId);
  if (!entryId) {
    redirect(`${BASE}?error=${encodeURIComponent("Silinecek taslak fiş kimliği gerekli.")}`);
  }
  try {
    await discardDraftManagementEntry(getPool(), entryId, session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=taslak-fis-silindi`);
}

export async function createManagementSubAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_accounts", "insert", BASE);
  const f = formObject(formData);
  try {
    await createManagementSubAccount(
      getPool(),
      {
        code: strField(f.code),
        name: strField(f.name),
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=alt-hesap-acildi`);
}

export async function postManualAdjustmentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "insert", BASE);
  const f = formObject(formData);
  const entryDate = strField(f.entryDate) || new Date().toISOString().slice(0, 10);
  const description = strField(f.description);
  const currency = strField(f.currency, "TRY") || "TRY";
  const status = strField(f.status, "posted") === "draft" ? "draft" : "posted";

  const multiAccounts = formData.getAll("lineAccountCode").map((v) => String(v).trim());
  const multiDebits = formData.getAll("lineDebit").map((v) => Number(String(v).trim() || "0"));
  const multiCredits = formData.getAll("lineCredit").map((v) => Number(String(v).trim() || "0"));
  const multiCostCenters = formData.getAll("lineCostCenterId").map((v) => String(v).trim() || null);
  const multiMemos = formData.getAll("lineMemo").map((v) => String(v).trim());

  let lines: Array<{
    accountCode: string;
    debitNative: number;
    creditNative: number;
    costCenterId?: string | null;
    memo?: string | null;
  }> = [];

  if (multiAccounts.length >= 2) {
    for (let i = 0; i < multiAccounts.length; i++) {
      const code = multiAccounts[i];
      const deb = Number.isFinite(multiDebits[i]) ? Math.max(0, multiDebits[i]) : 0;
      const cred = Number.isFinite(multiCredits[i]) ? Math.max(0, multiCredits[i]) : 0;
      if (!code || (deb === 0 && cred === 0)) continue;
      lines.push({
        accountCode: code,
        debitNative: deb,
        creditNative: cred,
        costCenterId: multiCostCenters[i] || null,
        memo: multiMemos[i] || description,
      });
    }
  } else {
    const debitAccountCode = strField(f.debitAccountCode);
    const creditAccountCode = strField(f.creditAccountCode);
    const amount = Number(strField(f.amount, "0"));
    const costCenterId = strField(f.costCenterId) || null;
    if (!debitAccountCode || !creditAccountCode || !Number.isFinite(amount) || amount <= 0) {
      redirect(`${BASE}?error=${encodeURIComponent("Borç hesabı, alacak hesabı ve pozitif tutar zorunludur.")}`);
    }
    lines = [
      {
        accountCode: debitAccountCode,
        debitNative: amount,
        creditNative: 0,
        costCenterId,
        memo: description,
      },
      {
        accountCode: creditAccountCode,
        debitNative: 0,
        creditNative: amount,
        costCenterId,
        memo: description,
      },
    ];
  }

  if (lines.length < 2) {
    redirect(`${BASE}?error=${encodeURIComponent("En az 2 dolu borç/alacak satırı girilmelidir.")}`);
  }

  try {
    await postManualManagementAdjustment(
      getPool(),
      {
        entryDate,
        description,
        currency,
        status,
        lines,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=manuel-fis-kaydedildi`);
}

export async function approveDraftEntryAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "update", BASE);
  const f = formObject(formData);
  const entryId = strField(f.entryId);
  if (!entryId) {
    redirect(`${BASE}?error=${encodeURIComponent("Fiş kimliği gerekli.")}`);
  }
  try {
    await approveDraftManagementEntry(getPool(), entryId, session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=taslak-fis-onaylandi`);
}

export async function reverseEntryAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "delete", BASE);
  const f = formObject(formData);
  const entryId = strField(f.entryId);
  const reason = strField(f.reason, "Dönem içi yönetim düzeltmesi (storno)");
  if (!entryId) {
    redirect(`${BASE}?error=${encodeURIComponent("Ters kayıt yapılacak fiş kimliği gerekli.")}`);
  }
  try {
    await reverseManagementEntry(getPool(), entryId, reason, session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=ters-kayit-olusturuldu`);
}

const runIntercompanySchema = z.object({
  periodCode: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Dönem kodu YYYY-AA formatında olmalıdır."),
  notes: z.string().trim().max(500).optional(),
});

export async function runIntercompanyEliminationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (!can(session.role, "intercompany_elimination_runs", "insert")) {
    redirectWithFlash("error", "Grup içi eliminasyon çalıştırma yetkiniz yok.");
  }
  const f = formObject(formData);
  const parsed = runIntercompanySchema.safeParse({
    periodCode: strField(f.periodCode),
    notes: strField(f.notes) || undefined,
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Geçersiz grup içi eliminasyon dönemi.",
    );
  }

  const [yearStr, monthStr] = parsed.data.periodCode.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const periodStart = `${yearStr}-${monthStr}-01`;
  const periodEnd = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`;

  let matchedPairCount = 0;
  try {
    const out = await runIntercompanyElimination(getPool(), {
      periodStart,
      periodEnd,
      actorId: session.id,
      notes: parsed.data.notes ?? `${parsed.data.periodCode} konsolidasyon eliminasyonu`,
      status: "posted",
    });
    matchedPairCount = out.run.matchedPairCount;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance");
  redirectWithFlash(
    "result",
    `grup-ici-eliminasyon-tamamlandi (${parsed.data.periodCode}, ${matchedPairCount} cift)`,
  );
}

const reverseIntercompanySchema = z.object({
  runId: z.string().trim().uuid("Geçerli bir eliminasyon çalıştırma kimliği gereklidir."),
  reason: z.string().trim().min(1, "Ters kayıt (iptal) gerekçesi zorunludur.").max(400),
});

export async function reverseIntercompanyEliminationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (!can(session.role, "intercompany_elimination_runs", "update")) {
    redirectWithFlash("error", "Grup içi eliminasyon ters kayıt yetkiniz yok.");
  }
  const f = formObject(formData);
  const parsed = reverseIntercompanySchema.safeParse({
    runId: strField(f.runId),
    reason: strField(f.reason),
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Geçersiz ters kayıt parametreleri.",
    );
  }

  try {
    await reverseIntercompanyEliminationRun(
      getPool(),
      parsed.data.runId,
      session.id,
      parsed.data.reason,
    );
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance");
  redirectWithFlash("result", "grup-ici-eliminasyon-ters-kayit-uygulandi");
}
