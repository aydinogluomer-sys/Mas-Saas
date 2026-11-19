"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { postBalancedJournalEntry } from "@/lib/ledger/posting-engine";
import { moneyOrNull } from "@/lib/money";
import { allocateBankTransaction } from "@/lib/receivables/engine";
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
    const fmtTag = r.format ? `[${r.format.toUpperCase()}] ` : "";
    summary = `${fmtTag}${r.inserted} yeni · ${r.duplicates} yinelenen · ${r.skipped} atlanan` +
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

/**
 * M-29: 1-to-N multi-invoice split allocation + optional 780 EFT/SWIFT fee write-off tolerance.
 */
export async function splitMatchBankTransactionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "update", BASE);
  const transactionId = String(formData.get("transactionId") ?? "").trim();
  const lines: { invoiceId: string; amount: number }[] = [];
  for (const idx of [1, 2, 3]) {
    const invId = String(formData.get(`invoiceId${idx}`) ?? "").trim();
    const amt = numOrNull(formData.get(`amount${idx}`));
    if (invId && amt != null && amt > 0) {
      lines.push({ invoiceId: invId, amount: Math.round(amt * 100) / 100 });
    }
  }
  const bankFeeAmount = Math.max(0, Math.round((numOrNull(formData.get("bankFeeAmount")) ?? 0) * 100) / 100);

  if (!transactionId || lines.length === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("En az bir açık fatura ve dağıtım tutarı seçilmelidir.")}`);
  }

  const pool = getPool();
  let summary = "";
  try {
    const res = await allocateBankTransaction(pool, { transactionId, lines }, session.id);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const txRow = await client.query<{
        amount: string;
        currency: string;
        txn_date: string;
        direction: string;
        status: string;
      }>(
        `select amount::text, currency, to_char(txn_date, 'YYYY-MM-DD') as txn_date, direction, status
           from public.bank_transactions
          where id = $1
          for update`,
        [transactionId],
      );
      if (txRow.rowCount === 1) {
        const tx = txRow.rows[0];
        const txnAbs = Math.abs(moneyOrNull(tx.amount) ?? 0);
        const sumRes = await client.query<{ total: string }>(
          `select coalesce(sum(allocated_amount), 0)::text as total
             from public.invoice_allocations
            where source_table = 'bank_transactions'
              and source_id = $1::uuid
              and reversed_at is null`,
          [transactionId],
        );
        const totalAllocated = moneyOrNull(sumRes.rows[0]?.total) ?? 0;

        if (totalAllocated >= txnAbs - 0.01 && !["matched", "reconciled"].includes(tx.status)) {
          const upd = await client.query(
            `update public.bank_transactions
                set status = 'matched',
                    matched_entity_table = 'invoices',
                    matched_entity_id = $2::uuid,
                    match_confidence = 1,
                    matched_at = now(),
                    settled_at = now(),
                    settled_by = $3::uuid
              where id = $1::uuid`,
            [transactionId, lines[0].invoiceId, session.id],
          );
          if (upd.rowCount === 1) {
            await audit(client, {
              actor: session.id,
              action: "split_match_bank_transaction",
              entityTable: "bank_transactions",
              entityId: transactionId,
              before: { status: tx.status },
              after: { status: "matched", lineCount: res.lineCount, allocated: totalAllocated, bankFeeAmount },
            });
          }
        }

        // Optional EFT/SWIFT fee write-off tolerance on primary invoice (780 <-> 120/320)
        if (bankFeeAmount > 0) {
          const primaryInvoiceId = lines[0].invoiceId;
          const feeAlloc = await client.query<{ id: string }>(
            `insert into public.invoice_allocations
               (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
             values ($1::uuid, 'manual', null, $2::numeric, $3::date, 'Banka EFT/SWIFT masraf farkı (780)', $4::uuid)
             returning id::text`,
            [primaryInvoiceId, bankFeeAmount, tx.txn_date, session.id],
          );
          if (feeAlloc.rowCount === 1) {
            await audit(client, {
              actor: session.id,
              action: "allocate_bank_fee_tolerance",
              entityTable: "invoice_allocations",
              entityId: feeAlloc.rows[0].id,
              after: { invoiceId: primaryInvoiceId, bankFeeAmount, transactionId },
            });
          }
          await client.query("savepoint bank_fee_je_sp");
          try {
            const arOrApCode = tx.direction === "inflow" ? "120" : "320";
            await postBalancedJournalEntry(
              client,
              {
                entryDate: tx.txn_date,
                description: `Banka tahsilat/ödeme masraf kesintisi farkı (${tx.currency})`,
                sourceType: "manual",
                sourceTable: "bank_transactions",
                sourceId: transactionId,
                lines:
                  tx.direction === "inflow"
                    ? [
                        { accountCode: "780", debit: bankFeeAmount, credit: 0, memo: "EFT/SWIFT kesinti gideri" },
                        { accountCode: arOrApCode, debit: 0, credit: bankFeeAmount, memo: "Cari masraf mahsubu" },
                      ]
                    : [
                        { accountCode: arOrApCode, debit: bankFeeAmount, credit: 0, memo: "Cari masraf farkı" },
                        { accountCode: "780", debit: 0, credit: bankFeeAmount, memo: "Masraf düzeltmesi" },
                      ],
              },
              session.id,
            );
            await client.query("release savepoint bank_fee_je_sp");
          } catch {
            await client.query("rollback to savepoint bank_fee_je_sp");
            await client.query("release savepoint bank_fee_je_sp");
          }
        }
      }
      await client.query("commit");
    } catch (innerErr) {
      await client.query("rollback").catch(() => {});
      throw innerErr;
    } finally {
      client.release();
    }

    summary = `${res.lineCount} faturaya toplam ${res.allocated.toFixed(2)} dağıtıldı` +
      (bankFeeAmount > 0 ? ` + ${bankFeeAmount.toFixed(2)} banka masraf farkı (780) kapatıldı` : "");
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=${encodeURIComponent(summary)}`);
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
