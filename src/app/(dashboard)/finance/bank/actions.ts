"use server";

// Faz 20 — bank centre server actions.
//
// Every mutation goes through src/lib/bank/engine.ts, which parses input with a Zod schema and
// records through the canonical audit() inside the same transaction (Faz 18's rules). This file
// only translates form data into those calls and turns a DomainError into a message the page
// can show — anything else propagates, because an unexpected fault must not be flattened into
// a friendly sentence.
//
// NOTHING HERE MUTATES A FINANCIAL RECORD. Accepting a bank match reconciles the statement
// against the plan; it does not mark a payment paid or a check cleared. Those remain separate,
// separately audited acts (src/lib/radar/engine.ts, src/lib/financing/engine.ts).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  acceptMatch, ignoreTransaction, importBankStatement, reconcileTransaction,
  rejectCandidate, runMatcher, upsertBankAccount,
} from "@/lib/bank/engine";

const BASE = "/finance/bank";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function saveBankAccountAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await upsertBankAccount(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=account-saved`);
}

export async function importStatementAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
    // Duplicates and skipped rows are REPORTED, never hidden: a silent skip is how a real
    // transaction goes missing from a reconciliation.
    summary = `${r.inserted} yeni · ${r.duplicates} yinelenen · ${r.skipped} atlanan` +
      (r.skippedReasons.length ? ` (${r.skippedReasons.join("; ")})` : "");
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
}

export async function runMatcherAction(): Promise<void> {
  const session = await requireSession();
  let summary = "";
  try {
    const r = await runMatcher(getPool(), session.id);
    summary = `${r.scanned} tarandı · ${r.suggested} öneri · ${r.candidates} aday`;
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
}

export async function acceptMatchAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await acceptMatch(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=eslestirildi`);
}

export async function rejectCandidateAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
  const session = await requireSession();
  try {
    await ignoreTransaction(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=yok-sayildi`);
}

export async function reconcileAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await reconcileTransaction(getPool(), String(formData.get("transactionId") ?? ""), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=mutabakat-alindi`);
}
