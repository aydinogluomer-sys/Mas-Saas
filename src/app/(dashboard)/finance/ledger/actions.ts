"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { createManagementSubAccount } from "@/lib/ledger/accounts";
import {
  approveDraftManagementEntry,
  postManualManagementAdjustment,
  rebuildOrSyncManagementLedger,
  reverseManagementEntry,
} from "@/lib/ledger/posting-engine";
import { formObject } from "@/lib/validation";

const BASE = "/finance/ledger";

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
  const debitAccountCode = strField(f.debitAccountCode);
  const creditAccountCode = strField(f.creditAccountCode);
  const amount = Number(strField(f.amount, "0"));
  const currency = strField(f.currency, "TRY") || "TRY";
  const status = strField(f.status, "posted") === "draft" ? "draft" : "posted";

  if (!debitAccountCode || !creditAccountCode || !Number.isFinite(amount) || amount <= 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Borç hesabı, alacak hesabı ve pozitif tutar zorunludur.")}`);
  }

  try {
    await postManualManagementAdjustment(
      getPool(),
      {
        entryDate,
        description,
        currency,
        status,
        lines: [
          {
            accountCode: debitAccountCode,
            debitNative: amount,
            creditNative: 0,
            memo: description,
          },
          {
            accountCode: creditAccountCode,
            debitNative: 0,
            creditNative: amount,
            memo: description,
          },
        ],
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
