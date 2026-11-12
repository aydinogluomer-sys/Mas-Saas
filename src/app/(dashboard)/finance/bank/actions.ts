"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { formObject } from "@/lib/validation";
import {
  acceptMatch,
  ignoreTransaction,
  importBankStatement,
  manualMatchBankTransaction,
  reconcileBankAccount,
  reconcileTransaction,
  rejectCandidate,
  runMatcher,
  unignoreTransaction,
  unmatchTransaction,
  upsertBankAccount,
} from "@/lib/bank/engine";
import {
  ACCOUNT_KIND_INPUTS,
  upsertCashOrBankAccountWithOpeningBalance,
  type AccountKindInput,
} from "@/lib/treasury/engine";

const BASE = "/finance/bank";

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseAccountKind(raw: string): AccountKindInput | undefined {
  const trimmed = raw.trim();
  if ((ACCOUNT_KIND_INPUTS as readonly string[]).includes(trimmed)) {
    return trimmed as AccountKindInput;
  }
  return undefined;
}

function domainRedirect(e: unknown): never {
  if (isPgPeriodLockedError(e)) {
    revalidatePath(BASE);
    redirect(`${BASE}?error=${encodeURIComponent(PERIOD_LOCKED_USER_MESSAGE)}`);
  }
  try {
    translatePeriodLockError(e);
  } catch (translated) {
    if (translated instanceof DomainError) {
      revalidatePath(BASE);
      redirect(`${BASE}?error=${encodeURIComponent(translated.message)}`);
    }
    throw translated;
  }
}

export async function saveBankAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_accounts", "insert", BASE);
  try {
    await upsertBankAccount(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/treasury");
  redirect(`${BASE}?result=account-saved`);
}

/**
 * F-45 (FIN-03 + A3): Create or update a Kasa/Banka account with IBAN, opening_balance,
 * opening_balance_date, and automatic TDHP 500.99 management ledger opening entry directly
 * from Banka Merkezi.
 */
export async function upsertBankOrCashAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "cash_accounts",
    String(formData.get("cashAccountId") ?? "").trim() ? "update" : "insert",
    BASE,
  );
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || undefined;

  const name = String(formData.get("name") ?? "").trim() || undefined;
  const kind = parseAccountKind(String(formData.get("kind") ?? ""));
  const currency = String(formData.get("currency") ?? "").trim().toUpperCase() || undefined;
  const openingBalance = numOrNull(formData.get("openingBalance"));
  const openingBalanceDate = String(formData.get("openingBalanceDate") ?? "").trim() || undefined;
  const ibanRaw = formData.get("iban");
  const bankNameRaw = formData.get("bankName");
  const branchCodeRaw = formData.get("branchCode");
  const overdraftLimit = numOrNull(formData.get("overdraftLimit"));
  const hasActiveField = formData.has("hasIsActiveField");
  const isActive = hasActiveField ? String(formData.get("isActive") ?? "") === "on" : undefined;

  let summary = "";
  try {
    const res = await upsertCashOrBankAccountWithOpeningBalance(
      getPool(),
      {
        cashAccountId,
        name,
        kind,
        currency,
        openingBalance,
        openingBalanceDate,
        isActive,
        iban: ibanRaw != null ? String(ibanRaw) : undefined,
        bankName: bankNameRaw != null ? String(bankNameRaw) : undefined,
        branchCode: branchCodeRaw != null ? String(branchCodeRaw) : undefined,
        overdraftLimit: overdraftLimit ?? undefined,
      },
      session.id,
    );
    const ledgerSuffix = res.openingJournalEntryId
      ? " · 500.99 yönetim defteri açılış fişi işlendi"
      : "";
    summary = cashAccountId
      ? `Hesap / açılış bakiyesi güncellendi${ledgerSuffix}`
      : `Yeni kasa/banka hesabı oluşturuldu${ledgerSuffix}`;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance/treasury");
  revalidatePath("/finance/ledger");
  revalidatePath("/finance/collections");
  revalidatePath("/cashflow");
  revalidatePath("/");
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
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
    summary = `${r.scanned} tarandı · ${r.suggested} öneri · ${r.candidates} aday (±90 gün penceresi)`;
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
  revalidateFinancialViews();
  redirect(`${BASE}?result=eslestirildi-ve-kapatildi`);
}

export async function manualMatchAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await manualMatchBankTransaction(
      getPool(),
      {
        transactionId: String(formData.get("transactionId") ?? "").trim(),
        targetKey: String(formData.get("targetKey") ?? "").trim() || undefined,
        targetTable: String(formData.get("targetTable") ?? "").trim() || undefined,
        targetId: String(formData.get("targetId") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=manuel-eslestirildi-ve-kapatildi`);
}

export async function unmatchTransactionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await unmatchTransaction(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=eslestirme-ve-kapanis-geri-alindi`);
}

export async function unignoreTransactionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  try {
    await unignoreTransaction(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=yok-sayma-kaldirildi`);
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
