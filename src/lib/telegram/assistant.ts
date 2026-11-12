import type { Pool } from "pg";
import { mutationIntent } from "@/lib/ai/rules";
import {
  loadCurrentAccounts,
  loadLatestLedgerMovements,
  loadPayableTotals,
  loadReceivableTotals,
} from "@/lib/receivables/engine";

export type TelegramAnswerKind =
  | "current_account"
  | "current_account_ledger"
  | "receivable_total"
  | "payable_total"
  | "help"
  | "refused";

export interface TelegramAnswer {
  answer: string;
  kind: TelegramAnswerKind;
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function plainNumber(value: number): string {
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(value);
}

/**
 * An amount in its OWN currency — the caller always says which.
 *
 * The first version formatted every amount as TRY, so a USD or EUR ledger movement reached the
 * owner's phone printed as TL. TRY keeps the ₺ it always had; any other currency is printed with
 * its ISO code ("USD 1.250,00"), never with a symbol a reader could take for TL, and never
 * converted — there is no FX conversion anywhere in this product (0094's TRY-only policy). A code
 * Intl rejects is printed verbatim after the number, and null (unknown) says so.
 */
function money(value: number, currency: string | null): string {
  if (currency === null) return `${plainNumber(value)} (para birimi bilinmiyor)`;
  try {
    return new Intl.NumberFormat("tr-TR", {
      style: "currency",
      currency,
      currencyDisplay: currency === "TRY" ? "symbol" : "code",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${plainNumber(value)} ${currency}`;
  }
}

/** The views behind every total here sum TRY rows only (0094); the label says so every time. */
const TRY_ONLY = "yalnız TRY";

/** The non-TRY items a TRY-only figure left out, said out loud rather than silently dropped. */
function excludedForeign(count: number, what: string, from: string): string[] {
  return count > 0 ? [`TRY dışı ${count} ${what} ${from} dahil değil (kur çevrimi yapılmaz).`] : [];
}

/**
 * Faz 42 (B2 — backlog #6) & Faz 44 (C1 — Migration 0099):
 * In 0099 `current_account_ledger` records `sales` invoices as `+debit` (collections `-credit`)
 * and `purchase` invoices as `+credit` (supplier payments `+debit`). Legacy unit fixtures from
 * pre-0099 may still pass `debitAmount` for invoices, and callers may supply English (`sale`,
 * `sales`, `purchase`) or Turkish (`satış`, `alış`) direction tokens or rely on debit/credit sign.
 * Classify invoice vs. settlement from `movementType` first (falling back to direction-aware
 * debit/credit) and resolve direction without ever hardcoding one side for all invoices.
 */
export function ledgerMovementSide(row: {
  direction?: string | null;
  movementType?: string | null;
  debitAmount: number;
  creditAmount: number;
}): { amount: number; label: string } {
  const dirNorm = normalize(row.direction ?? "");
  const mtNorm = normalize(row.movementType ?? "");

  const explicitPurchaseDir = dirNorm === "purchase" || dirNorm === "alis";
  const explicitSalesDir = dirNorm === "sale" || dirNorm === "sales" || dirNorm === "satis";

  const isInvoice = /\b(?:fatura|invoice)\b/.test(mtNorm)
    ? true
    : /\b(?:tahsilat|odeme|payment|collection)\b/.test(mtNorm)
      ? false
      : explicitPurchaseDir
        ? row.creditAmount !== 0
        : explicitSalesDir
          ? row.debitAmount !== 0
          : row.debitAmount !== 0 || row.creditAmount !== 0;

  const isPurchase = explicitPurchaseDir
    ? true
    : explicitSalesDir
      ? false
      : /\b(?:alis|purchase|odeme)\b/.test(mtNorm)
        ? true
        : /\b(?:satis|sale|sales|tahsilat|collection)\b/.test(mtNorm)
          ? false
          : isInvoice
            ? row.creditAmount > 0 && row.debitAmount === 0
            : row.debitAmount > 0 && row.creditAmount === 0;

  const rawAmount = row.debitAmount !== 0 ? row.debitAmount : row.creditAmount;
  const amount = Math.abs(rawAmount);

  if (isInvoice) {
    return {
      amount,
      label: isPurchase ? "alış faturası (borç)" : "satış faturası (alacak)",
    };
  }
  return {
    amount,
    label: isPurchase ? "ödeme (borç kapama)" : "tahsilat (alacak kapama)",
  };
}

function counterpartyTerm(message: string, ledger: boolean): string | null {
  const slash = message.match(ledger ? /^\/hareket\s+(.+)$/iu : /^\/cari\s+(.+)$/iu);
  if (slash?.[1]) return slash[1].trim();

  const patterns = ledger
    ? [/(.+?)\s+firmasının\s+(?:son\s+\d+\s+)?hareket/iu, /(.+?)\s+cari\s+hareket/iu]
    : [/(.+?)\s+firmasının\s+carisi/iu, /(.+?)\s+cari(?:si|\s+hesabı)/iu];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function requestedLedgerLimit(message: string): number {
  const match = message.match(/son\s+(\d{1,2})/iu);
  return Math.min(20, Math.max(1, Number(match?.[1] ?? 10)));
}

async function findAccount(pool: Pool, term: string) {
  const accounts = await loadCurrentAccounts(pool, 500);
  const needle = normalize(term);
  const exact = accounts.filter((row) => normalize(row.partyName) === needle);
  const candidates = exact.length > 0
    ? exact
    : accounts.filter((row) => normalize(row.partyName).includes(needle));
  return candidates;
}

function ambiguousAnswer(names: string[]): TelegramAnswer {
  const options = names.slice(0, 8).map((name) => `• ${name}`).join("\n");
  return {
    kind: "help",
    answer: `Birden fazla cari eşleşti:\n${options}\n\nLütfen /cari Firma Adı biçiminde daha açık yazın.`,
  };
}

export async function answerTelegramQuestion(
  pool: Pool,
  message: string,
  todayISO: string,
): Promise<TelegramAnswer> {
  if (mutationIntent(message)) {
    return {
      kind: "refused",
      answer: "Telegram asistanı salt okunurdur; kayıt ekleme, değiştirme, silme veya onaylama yapmaz.",
    };
  }

  const normalized = normalize(message);
  const wantsLedger = normalized.includes("hareket") || message.trimStart().startsWith("/hareket");
  const term = counterpartyTerm(message, wantsLedger);

  if (term) {
    const candidates = await findAccount(pool, term);
    if (candidates.length === 0) {
      return { kind: "help", answer: `“${term}” adıyla açık bakiyesi olan bir cari bulunamadı.` };
    }
    if (candidates.length > 1) return ambiguousAnswer(candidates.map((row) => row.partyName));

    const account = candidates[0];
    if (wantsLedger) {
      const limit = requestedLedgerLimit(message);
      // Newest first and exactly `limit` rows, both decided in SQL. This used to load the OLDEST 200
      // and print their tail, so a busy party's "son 10 hareket" were rows ~191-200 of its history.
      const recent = await loadLatestLedgerMovements(pool, account.partyId, limit);
      if (recent.length === 0) {
        return { kind: "current_account_ledger", answer: `${account.partyName} için cari hareket bulunamadı.` };
      }
      const lines = recent.map((row) => {
        const { amount, label } = ledgerMovementSide(row);
        // Each movement in its invoice's own currency — a USD invoice is a USD movement.
        return `• ${row.movementDate} — ${row.reference ?? row.movementType}: ${money(amount, row.currency)} ${label}`;
      });
      const mixed = recent.some((row) => row.currency !== "TRY");
      return {
        kind: "current_account_ledger",
        answer: [
          `${account.partyName} — son ${recent.length} hareket`,
          "",
          ...lines,
          ...(mixed ? ["", "Tutarlar her hareketin kendi para birimindedir; kur çevrimi yapılmaz."] : []),
        ].join("\n"),
      };
    }

    // current_account_summary's amounts are TRY-only (0094 #46); the party's other-currency
    // invoices are counted, not summed, and the card says how many were left out.
    const net = account.receivableOpen - account.payableOpen;
    const netLabel = net >= 0 ? "Net alacak" : "Net borç";
    return {
      kind: "current_account",
      answer: [
        `${account.partyName} — cari özet`,
        "",
        `Açık alacak (${TRY_ONLY}): ${money(account.receivableOpen, "TRY")}`,
        `Açık borç (${TRY_ONLY}): ${money(account.payableOpen, "TRY")}`,
        `${netLabel} (${TRY_ONLY}): ${money(Math.abs(net), "TRY")}`,
        ...excludedForeign(account.foreignCurrencyCount, "fatura", "bu tutarlara"),
        `Vadesi geçmiş kayıt: ${account.overdueCount}`,
        `En erken vade: ${account.earliestDueDate ?? "yok"}`,
        `Son fatura: ${account.lastInvoiceDate ?? "yok"}`,
      ].join("\n"),
    };
  }

  // loadOpenTotals sums TRY rows only and returns the other-currency rows as foreignCount
  // (receivables/engine.ts, PHASE 2.2). The first version printed the sum as "the" total.
  if (normalized.includes("toplam") && normalized.includes("alacak")) {
    const totals = await loadReceivableTotals(pool, todayISO);
    return {
      kind: "receivable_total",
      answer: [
        `Toplam açık alacak (${TRY_ONLY}): ${money(totals.totalOpenAmount, "TRY")}`,
        ...excludedForeign(totals.foreignCount, "açık kalem", "bu toplama"),
        `Vadesi geçmiş kayıt: ${totals.overdueCount}`,
      ].join("\n"),
    };
  }

  if (normalized.includes("toplam") && normalized.includes("borc")) {
    const totals = await loadPayableTotals(pool, todayISO);
    return {
      kind: "payable_total",
      answer: [
        `Toplam açık borç (${TRY_ONLY}): ${money(totals.totalOpenAmount, "TRY")}`,
        ...excludedForeign(totals.foreignCount, "açık kalem", "bu toplama"),
        `Vadesi geçmiş kayıt: ${totals.overdueCount}`,
      ].join("\n"),
    };
  }

  return {
    kind: "help",
    answer: [
      "Bu ilk sürümde şunları sorabilirsiniz:",
      "• /cari Firma Adı",
      "• /hareket Firma Adı",
      "• Firma Adı firmasının carisi nedir?",
      "• Toplam açık alacak ne kadar?",
      "• Toplam açık borç ne kadar?",
    ].join("\n"),
  };
}
