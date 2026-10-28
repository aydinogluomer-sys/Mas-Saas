import type { Pool } from "pg";
import { mutationIntent } from "@/lib/ai/rules";
import {
  loadCurrentAccountLedger,
  loadCurrentAccounts,
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

function money(value: number): string {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(value);
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
      const rows = await loadCurrentAccountLedger(pool, account.partyId, 200);
      const recent = rows.slice(-limit).reverse();
      if (recent.length === 0) {
        return { kind: "current_account_ledger", answer: `${account.partyName} için cari hareket bulunamadı.` };
      }
      const lines = recent.map((row) => {
        const amount = row.debitAmount !== 0 ? row.debitAmount : row.creditAmount;
        const side = row.debitAmount !== 0 ? "borç" : "alacak";
        return `• ${row.movementDate} — ${row.reference ?? row.movementType}: ${money(amount)} ${side}`;
      });
      return {
        kind: "current_account_ledger",
        answer: `${account.partyName} — son ${recent.length} hareket\n\n${lines.join("\n")}`,
      };
    }

    const net = account.receivableOpen - account.payableOpen;
    const netLabel = net >= 0 ? "Net alacak" : "Net borç";
    return {
      kind: "current_account",
      answer: [
        `${account.partyName} — cari özet`,
        "",
        `Açık alacak: ${money(account.receivableOpen)}`,
        `Açık borç: ${money(account.payableOpen)}`,
        `${netLabel}: ${money(Math.abs(net))}`,
        `Vadesi geçmiş kayıt: ${account.overdueCount}`,
        `En erken vade: ${account.earliestDueDate ?? "yok"}`,
        `Son fatura: ${account.lastInvoiceDate ?? "yok"}`,
      ].join("\n"),
    };
  }

  if (normalized.includes("toplam") && normalized.includes("alacak")) {
    const totals = await loadReceivableTotals(pool, todayISO);
    return {
      kind: "receivable_total",
      answer: `Toplam açık alacak: ${money(totals.totalOpenAmount)}\nVadesi geçmiş kayıt: ${totals.overdueCount}`,
    };
  }

  if (normalized.includes("toplam") && normalized.includes("borc")) {
    const totals = await loadPayableTotals(pool, todayISO);
    return {
      kind: "payable_total",
      answer: `Toplam açık borç: ${money(totals.totalOpenAmount)}\nVadesi geçmiş kayıt: ${totals.overdueCount}`,
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
