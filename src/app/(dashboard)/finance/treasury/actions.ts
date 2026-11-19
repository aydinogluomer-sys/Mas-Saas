"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission, requireAdmin } from "@/lib/auth";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  createCorporateCardStatement,
  createPosSettlementBatch,
  createTermDeposit,
  executeInterbankTransfer,
  payCorporateCardStatement,
  settlePosSettlementBatch,
  settleTermDeposit,
} from "@/lib/financing/treasury-ops";
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

function numOrUndefined(v: FormDataEntryValue | null): number | undefined {
  const parsed = numOrNull(v);
  return parsed == null ? undefined : parsed;
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

function revalidateTreasurySurfaces(): void {
  revalidatePath(PAGE);
  revalidatePath("/finance");
  revalidatePath("/finance/bank");
  revalidatePath("/finance/ledger");
  revalidatePath("/finance/exposure");
  revalidatePath("/cashflow");
  revalidatePath("/");
}

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

  revalidateTreasurySurfaces();
  revalidatePath("/finance/collections");
  redirect(`${PAGE}?result=${encodeURIComponent(summary)}`);
}

/* ── M-28: Bankalar Arası Virman, Vadeli Mevduat, POS Valör & Kurumsal Kart Aksiyonları ── */

export async function executeInterbankTransferAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("interbank_transfers", "insert", PAGE);
  try {
    await executeInterbankTransfer(
      getPool(),
      {
        fromAccountId: String(formData.get("fromAccountId") ?? "").trim(),
        toAccountId: String(formData.get("toAccountId") ?? "").trim(),
        transferDate: String(formData.get("transferDate") ?? "").trim(),
        fromAmount: numOrUndefined(formData.get("fromAmount")),
        toAmount: numOrUndefined(formData.get("toAmount")),
        fxRate: numOrUndefined(formData.get("fxRate")),
        feeAmount: numOrUndefined(formData.get("feeAmount")) ?? 0,
        description: String(formData.get("description") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(
    `${PAGE}?result=${encodeURIComponent("Bankalar arası virman / döviz işlemi ve 100/102 TDHP fişi işlendi.")}`,
  );
}

export async function createTermDepositAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("term_deposits", "insert", PAGE);
  let netSummary = "";
  try {
    const res = await createTermDeposit(
      getPool(),
      {
        cashAccountId: String(formData.get("cashAccountId") ?? "").trim(),
        depositName: String(formData.get("depositName") ?? "").trim(),
        principalAmount: numOrUndefined(formData.get("principalAmount")),
        annualInterestRate: numOrUndefined(formData.get("annualInterestRate")),
        withholdingTaxRate: numOrUndefined(formData.get("withholdingTaxRate")) ?? 0.075,
        startDate: String(formData.get("startDate") ?? "").trim(),
        maturityDate: String(formData.get("maturityDate") ?? "").trim(),
      },
      session.id,
    );
    netSummary = `Vadeli mevduat (102.05) bağlandı · Beklenen net getiri: ${res.yieldSummary.netInterest.toFixed(2)}.`;
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent(netSummary)}`);
}

export async function settleTermDepositAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("term_deposits", "update", PAGE);
  const depositId = String(formData.get("depositId") ?? "").trim();
  const settledDate = String(formData.get("settledDate") ?? "").trim() || null;
  try {
    await settleTermDeposit(getPool(), depositId, settledDate, session.id);
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(
    `${PAGE}?result=${encodeURIComponent("Vadeli mevduat vade dönüşü (102 / 193 / 642) hesaba aktarıldı.")}`,
  );
}

export async function createPosSettlementBatchAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("pos_settlement_batches", "insert", PAGE);
  try {
    await createPosSettlementBatch(
      getPool(),
      {
        cashAccountId: String(formData.get("cashAccountId") ?? "").trim(),
        posTerminalLabel: String(formData.get("posTerminalLabel") ?? "").trim(),
        saleDate: String(formData.get("saleDate") ?? "").trim(),
        expectedValueDate: String(formData.get("expectedValueDate") ?? "").trim(),
        grossAmount: numOrUndefined(formData.get("grossAmount")),
        commissionRate: numOrUndefined(formData.get("commissionRate")) ?? 0.025,
      },
      session.id,
    );
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent("POS valör blokaj partisi (108) kuyruğa eklendi.")}`);
}

export async function settlePosSettlementBatchAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("pos_settlement_batches", "update", PAGE);
  const batchId = String(formData.get("batchId") ?? "").trim();
  const settledDate = String(formData.get("settledDate") ?? "").trim() || null;
  try {
    await settlePosSettlementBatch(getPool(), batchId, settledDate, session.id);
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(
    `${PAGE}?result=${encodeURIComponent("POS valör partisi hesaba geçti (102 + 780 / 108 fişi işlendi).")}`,
  );
}

export async function createCorporateCardStatementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("corporate_card_statements", "insert", PAGE);
  const payFromRaw = String(formData.get("payFromAccountId") ?? "").trim();
  try {
    await createCorporateCardStatement(
      getPool(),
      {
        cardAccountId: String(formData.get("cardAccountId") ?? "").trim(),
        payFromAccountId: payFromRaw || null,
        statementMonth: String(formData.get("statementMonth") ?? "").trim(),
        cutoffDate: String(formData.get("cutoffDate") ?? "").trim(),
        dueDate: String(formData.get("dueDate") ?? "").trim(),
        statementAmount: numOrUndefined(formData.get("statementAmount")),
        minimumPaymentAmount: numOrNull(formData.get("minimumPaymentAmount")),
      },
      session.id,
    );
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent("Kurumsal kredi kartı ekstresi (309) kaydedildi.")}`);
}

export async function payCorporateCardStatementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("corporate_card_statements", "update", PAGE);
  try {
    await payCorporateCardStatement(
      getPool(),
      {
        statementId: String(formData.get("statementId") ?? "").trim(),
        payFromAccountId: String(formData.get("payFromAccountId") ?? "").trim(),
        payAmount: numOrUndefined(formData.get("payAmount")),
        paymentDate: String(formData.get("paymentDate") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    redirectWithTreasuryError(e);
  }
  revalidateTreasurySurfaces();
  redirect(
    `${PAGE}?result=${encodeURIComponent("Kurumsal kart ekstresi ödendi (309 / 102 TDHP fişi işlendi).")}`,
  );
}
