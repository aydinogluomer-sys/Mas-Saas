"use server";

import { revalidatePath } from "next/cache";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { decimal, isNumericString } from "@/lib/money";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import {
  isMissingSchemaError,
  upsertCashOrBankAccountWithOpeningBalance,
  type CashAccountDbType,
} from "@/lib/treasury/engine";

export interface MissingOpeningAccountItem {
  id: string;
  name: string;
  kind: CashAccountDbType;
  currency: string;
  defaultDate: string;
}

export interface OpeningBalanceBatchEntry {
  cashAccountId: string;
  openingBalance: string;
  openingBalanceDate: string;
}

export type BatchSaveOpeningBalancesResult =
  | { ok: true; savedCount: number; error?: undefined }
  | { ok: false; savedCount: 0; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNextRedirectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const dt = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === value;
}

function parseOpeningBalanceText(raw: string): number {
  const compact = raw.trim().replace(/[\s\u00A0]/g, "");
  let normalized = compact;

  const hasDot = compact.includes(".");
  const hasComma = compact.includes(",");

  if (hasDot && hasComma) {
    const lastDot = compact.lastIndexOf(".");
    const lastComma = compact.lastIndexOf(",");
    if (lastComma > lastDot) {
      if (!/^[+-]?\d{1,3}(\.\d{3})+,\d{1,4}$/.test(compact)) {
        throw new DomainError(
          "VALIDATION",
          `Geçersiz açılış bakiyesi biçimi: "${raw.trim()}". Örn: 125.000,50 veya 125000.50 girin.`,
        );
      }
      normalized = compact.replace(/\./g, "").replace(",", ".");
    } else {
      if (!/^[+-]?\d{1,3}(,\d{3})+\.\d{1,4}$/.test(compact)) {
        throw new DomainError(
          "VALIDATION",
          `Geçersiz açılış bakiyesi biçimi: "${raw.trim()}". Örn: 125.000,50 veya 125000.50 girin.`,
        );
      }
      normalized = compact.replace(/,/g, "");
    }
  } else if (hasComma) {
    const commaCount = (compact.match(/,/g) ?? []).length;
    if (commaCount === 1 && /^[+-]?\d+,\d{1,4}$/.test(compact)) {
      normalized = compact.replace(",", ".");
    } else if (commaCount >= 2 && /^[+-]?\d{1,3}(,\d{3})+$/.test(compact)) {
      normalized = compact.replace(/,/g, "");
    } else {
      throw new DomainError(
        "VALIDATION",
        `Geçersiz açılış bakiyesi biçimi: "${raw.trim()}". Örn: 125000,50 veya 125.000,50 girin.`,
      );
    }
  } else if (hasDot) {
    const dotCount = (compact.match(/\./g) ?? []).length;
    if (dotCount >= 2 && /^[+-]?\d{1,3}(\.\d{3})+$/.test(compact)) {
      normalized = compact.replace(/\./g, "");
    } else if (dotCount === 1 && /^[+-]?[1-9]\d{0,2}\.\d{3}$/.test(compact)) {
      normalized = compact.replace(".", "");
    } else if (dotCount === 1 && /^[+-]?\d+\.\d{1,4}$/.test(compact)) {
      normalized = compact;
    } else {
      throw new DomainError(
        "VALIDATION",
        `Geçersiz açılış bakiyesi biçimi: "${raw.trim()}". Örn: 125000.50 veya 125.000,50 girin.`,
      );
    }
  }

  if (!isNumericString(normalized)) {
    throw new DomainError(
      "VALIDATION",
      `Geçersiz açılış bakiyesi: "${raw.trim()}". Lütfen sayısal bir tutar girin.`,
    );
  }

  const rounded = decimal(normalized).round(2);
  if (rounded.abs().gt("999999999999.99")) {
    throw new DomainError(
      "VALIDATION",
      "Açılış bakiyesi izin verilen üst sınırı (999.999.999.999,99) aşıyor.",
    );
  }
  const num = Number(rounded.toFixed(2));
  return Object.is(num, -0) ? 0 : num;
}

function revalidateOpeningBalanceTargets(): void {
  revalidateFinancialViews(["/scenarios"]);
  revalidatePath("/");
  revalidatePath("/finance");
  revalidatePath("/finance/bank");
  revalidatePath("/cashflow");
  revalidatePath("/scenarios");
}

/**
 * Loads active cash/bank accounts whose `opening_balance` is still `NULL` (FIN-03).
 * Invoked lazily when the user opens the quick drawer on `/` so `/` initial SSR query count stays untouched.
 */
export async function listMissingOpeningAccountsAction(): Promise<MissingOpeningAccountItem[]> {
  await requireSession();
  const pool = getPool();

  const r = await pool
    .query<{
      id: string;
      name: string;
      kind: CashAccountDbType;
      currency: string;
      default_date: string;
    }>(
      `select id::text,
              name,
              account_type as kind,
              currency,
              to_char(coalesce(opening_balance_date, date_trunc('year', now())::date), 'YYYY-MM-DD') as default_date
         from public.cash_accounts
        where is_active = true
          and opening_balance is null
        order by currency = 'TRY' desc, name asc`,
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query<{
            id: string;
            name: string;
            kind: CashAccountDbType;
            currency: string;
            default_date: string;
          }>(
            `select id::text,
                    name,
                    account_type as kind,
                    currency,
                    to_char(date_trunc('year', now())::date, 'YYYY-MM-DD') as default_date
               from public.cash_accounts
              where is_active = true
                and opening_balance is null
              order by currency = 'TRY' desc, name asc`,
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [] };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [] };
      throw err;
    });

  return r.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    kind: row.kind ?? "bank_account",
    currency: String(row.currency ?? "TRY"),
    defaultDate: String(row.default_date),
  }));
}

/**
 * R10 (`BLANK != ZERO`) batch saver for FIN-03 missing opening balances:
 * - Blank rows stay untouched as `NULL` (never coerced to `0`).
 * - Explicit `"0"` / `"0,00"` is saved as `0`.
 * - Non-zero balances automatically post balanced TDHP `500.99` Açılış Defteri entries via `upsertCashOrBankAccountWithOpeningBalance`.
 */
export async function batchSaveOpeningBalancesAction(
  entries: Array<{ cashAccountId: string; openingBalance: string; openingBalanceDate: string }>,
): Promise<BatchSaveOpeningBalancesResult> {
  const session = await requireActionPermission("cash_accounts", "update", "/");
  let committedCount = 0;
  try {
    if (!Array.isArray(entries)) {
      return { ok: false, savedCount: 0, error: "Geçersiz açılış bakiyesi listesi." };
    }

    // R10 BLANK != ZERO: blank strings are skipped and remain NULL in PostgreSQL.
    const nonBlankEntries = entries.filter(
      (item) => item != null && typeof item.openingBalance === "string" && item.openingBalance.trim() !== "",
    );

    if (nonBlankEntries.length === 0) {
      return {
        ok: false,
        savedCount: 0,
        error: "Kaydedilecek en az bir açılış bakiyesi girin. Boş bırakılan hesaplar değiştirilmez.",
      };
    }

    // Pre-validate every non-blank row before mutating any DB row so formatting typos never half-apply.
    const validatedRows: Array<{
      cashAccountId: string;
      openingBalance: number;
      openingBalanceDate: string;
    }> = [];
    const seenAccountIds = new Set<string>();

    for (const item of nonBlankEntries) {
      const cashAccountId = String(item.cashAccountId ?? "").trim();
      if (!UUID_RE.test(cashAccountId)) {
        throw new DomainError("VALIDATION", "Geçersiz kasa/banka hesap kimliği.");
      }
      if (seenAccountIds.has(cashAccountId)) {
        throw new DomainError("VALIDATION", "Aynı hesap listede birden fazla kez gönderildi.");
      }
      seenAccountIds.add(cashAccountId);

      const openingBalanceDate = String(item.openingBalanceDate ?? "").trim();
      if (!isValidIsoDate(openingBalanceDate)) {
        throw new DomainError(
          "VALIDATION",
          "Açılış tarihi geçerli YYYY-AA-GG biçiminde olmalıdır.",
        );
      }

      const parsedNumber = parseOpeningBalanceText(item.openingBalance);
      validatedRows.push({
        cashAccountId,
        openingBalance: parsedNumber,
        openingBalanceDate,
      });
    }

    const pool = getPool();
    const savedSummaries: Array<{
      cashAccountId: string;
      currency: string;
      openingBalance: number | null;
      openingBalanceDate: string;
      openingJournalEntryId: string | null;
    }> = [];

    for (const row of validatedRows) {
      const res = await upsertCashOrBankAccountWithOpeningBalance(
        pool,
        {
          cashAccountId: row.cashAccountId,
          openingBalance: row.openingBalance,
          openingBalanceDate: row.openingBalanceDate,
        },
        session.id,
      );
      committedCount += 1;
      savedSummaries.push({
        cashAccountId: res.cashAccountId,
        currency: res.currency,
        openingBalance: res.openingBalance,
        openingBalanceDate: res.openingBalanceDate,
        openingJournalEntryId: res.openingJournalEntryId,
      });
    }

    await audit(pool, {
      actor: session.id,
      action: "batch_set_opening_balances_fin03",
      entityTable: "cash_accounts",
      entityId: savedSummaries.length === 1 ? savedSummaries[0].cashAccountId : null,
      after: {
        source: "overview_fin03_quick_drawer",
        savedCount: committedCount,
        journalPostedCount: savedSummaries.filter((s) => s.openingJournalEntryId !== null).length,
        accounts: savedSummaries,
      },
    });

    revalidateOpeningBalanceTargets();

    return { ok: true, savedCount: committedCount };
  } catch (err: unknown) {
    if (isNextRedirectError(err)) {
      throw err;
    }
    if (committedCount > 0) {
      revalidateOpeningBalanceTargets();
    }
    if (isPgPeriodLockedError(err)) {
      return { ok: false, savedCount: 0, error: PERIOD_LOCKED_USER_MESSAGE };
    }
    if (isHandledActionError(err)) {
      return { ok: false, savedCount: 0, error: toUserActionErrorMessage(err) };
    }
    return {
      ok: false,
      savedCount: 0,
      error: "Açılış bakiyeleri kaydedilirken beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.",
    };
  }
}
