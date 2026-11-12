"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission, requireAdmin } from "@/lib/auth";
import { isPgPeriodLockedError, PERIOD_LOCKED_USER_MESSAGE, translatePeriodLockError } from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  ACCOUNT_KIND_INPUTS,
  updatePolicy,
  upsertCashOrBankAccountWithOpeningBalance,
  type AccountKindInput,
} from "@/lib/treasury/engine";

const PAGE = "/finance/treasury";

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function redirectWithTreasuryError(e: unknown): never {
  if (isPgPeriodLockedError(e)) {
    revalidatePath(PAGE);
    redirect(`${PAGE}?error=${encodeURIComponent(PERIOD_LOCKED_USER_MESSAGE)}`);
  }
  try {
    translatePeriodLockError(e);
  } catch (translated) {
    if (translated instanceof DomainError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?error=${encodeURIComponent(translated.message)}`);
    }
    throw translated;
  }
}

/**
 * Change a treasury floor.
 *
 * requireAdmin, matching the `config` access class the table carries in migration 0062 and in
 * the permission matrix.
 */
export async function updatePolicyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  try {
    await updatePolicy(
      getPool(),
      {
        code: String(formData.get("code") ?? ""),
        thresholdAmount: numOrNull(formData.get("thresholdAmount")),
        thresholdDays: numOrNull(formData.get("thresholdDays")),
        isActive: String(formData.get("isActive") ?? "") === "on",
        notes: String(formData.get("notes") ?? "").trim() || undefined,
      },
      admin.id,
    );
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidatePath(PAGE);
  revalidatePath("/cashflow");
  redirect(`${PAGE}?result=${encodeURIComponent("Hazine politikası güncellendi.")}`);
}

function parseAccountKind(raw: string): AccountKindInput | undefined {
  const trimmed = raw.trim();
  if ((ACCOUNT_KIND_INPUTS as readonly string[]).includes(trimmed)) {
    return trimmed as AccountKindInput;
  }
  return undefined;
}

/**
 * F-45 (FIN-03 + A3): Create or update a Kasa/Banka account with IBAN, opening_balance,
 * opening_balance_date, and automatic TDHP 500.99 management ledger opening entry.
 */
export async function upsertTreasuryAccountAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "cash_accounts",
    String(formData.get("cashAccountId") ?? "").trim() ? "update" : "insert",
    PAGE,
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
      ? `Hesap ve açılış bakiyesi güncellendi${ledgerSuffix}.`
      : `Yeni kasa/banka hesabı oluşturuldu${ledgerSuffix}.`;
  } catch (e) {
    redirectWithTreasuryError(e);
  }

  revalidatePath(PAGE);
  revalidatePath("/finance/bank");
  revalidatePath("/finance/ledger");
  revalidatePath("/finance/collections");
  revalidatePath("/cashflow");
  revalidatePath("/");
  redirect(`${PAGE}?result=${encodeURIComponent(summary)}`);
}
