"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  acceptMatch, ignoreTransaction, importBankStatement, reconcileBankAccount,
  reconcileTransaction, rejectCandidate, runMatcher, upsertBankAccount,
} from "@/lib/bank/engine";

const BASE = "/finance/bank";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function saveBankAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_accounts", "insert", BASE);
  try {
    await upsertBankAccount(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=account-saved`);
}

export async function importStatementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "insert", BASE);
  const file = formData.get("statement");
  const accountId = String(formData.get("bankAccountId") ?? "");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Dosya seçilmedi.")}`);
  }
  if (!accountId) redirect(`${BASE}?error=${encodeURIComponent("Hesap seçilmedi.")}`);

  let summary = "";
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const r = await importBankStatement(getPool(), buf, file.name, accountId, session.id);
    if (!r.ok) redirect(`${BASE}?error=${encodeURIComponent(r.error ?? "İçe aktarma başarısız.")}`);
    summary = `${r.inserted} yeni · ${r.duplicates} yinelenen · ${r.skipped} atlanan` +
      (r.skippedReasons.length ? ` (${r.skippedReasons.join("; ")})` : "");
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
}

export async function runMatcherAction(): Promise<void> {
  const session = await requireActionPermission("bank_transaction_match_candidates", "insert", BASE);
  let summary = "";
  try {
    const r = await runMatcher(getPool(), session.id);
    summary = `${r.scanned} tarandı · ${r.suggested} öneri · ${r.candidates} aday`;
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
}

export async function acceptMatchAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await acceptMatch(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/collections");
  revalidatePath("/finance/invoices");
  revalidatePath("/payments");
  redirect(`${BASE}?result=eslestirildi-ve-kapatildi`);
}

export async function rejectCandidateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transaction_match_candidates", "update", BASE);
  try {
    await rejectCandidate(
      getPool(), formObject(formData), session.id,
      String(formData.get("reason") ?? "") || undefined,
    );
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=oneri-reddedildi`);
}

export async function ignoreTransactionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await ignoreTransaction(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=yok-sayildi`);
}

export async function reconcileAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await reconcileTransaction(getPool(), String(formData.get("transactionId") ?? ""), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=mutabakat-alindi`);
}

export async function reconcileAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  let count = 0;
  try {
    const res = await reconcileBankAccount(
      getPool(),
      String(formData.get("bankAccountId") ?? ""),
      session.id,
    );
    count = res.reconciledCount;
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(`${count} hareket mutabakata alındı`)}`);
}
