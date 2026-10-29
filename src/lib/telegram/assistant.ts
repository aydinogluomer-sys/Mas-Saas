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
        const amount = row.debitAmount !== 0 ? row.debitAmount : row.creditAmount;
        const side = row.debitAmount !== 0 ? "borç" : "alacak";
        // Each movement in its invoice's own currency — a USD invoice is a USD movement.
        return `• ${row.movementDate} — ${row.reference ?? row.movementType}: ${money(amount, row.currency)} ${side}`;
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
