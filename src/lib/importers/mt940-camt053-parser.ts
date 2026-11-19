// Faz 61 (M-29) — SWIFT MT940 (.mt940 / .sta / .940) & ISO 20022 CAMT.053 (.xml) Bank Statement Parser.
// Outputs normalized AOA rows compatible with `buildWorksheetFromAoa` & `detectStatementColumns`.

import { decodeTurkishCsvBuffer } from "./csv-parser";

export type StructuredStatementParseResult =
  | { ok: true; rows: string[][]; format: "mt940" | "camt053" }
  | { ok: false; error: string };

const MAX_STRUCTURED_STATEMENT_BYTES = 32 * 1024 * 1024;

const STATEMENT_HEADER = [
  "Tarih",
  "Valör",
  "Tutar",
  "Para Birimi",
  "Açıklama",
  "Karşı Taraf",
  "Karşı IBAN",
  "Referans",
];

function isValidIsoCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= maxDay;
}

function yymmddToIso(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  if (!isValidIsoCalendarDate(year, mm, dd)) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function resolveEntryDateFromMmdd(valueDateIso: string, entryMmdd: string | undefined): string {
  if (!entryMmdd || !/^\d{4}$/.test(entryMmdd)) return valueDateIso;
  const valYear = Number(valueDateIso.slice(0, 4));
  const valMonth = Number(valueDateIso.slice(5, 7));
  const entryMonth = Number(entryMmdd.slice(0, 2));
  const entryDay = Number(entryMmdd.slice(2, 4));

  // Handle year rollover (e.g. booked Dec 31, value date Jan 02 -> entry year = valYear - 1).
  let entryYear = valYear;
  if (valMonth === 1 && entryMonth === 12) entryYear = valYear - 1;
  else if (valMonth === 12 && entryMonth === 1) entryYear = valYear + 1;

  if (!isValidIsoCalendarDate(entryYear, entryMonth, entryDay)) return valueDateIso;
  return `${entryYear}-${String(entryMonth).padStart(2, "0")}-${String(entryDay).padStart(2, "0")}`;
}

/**
 * Format unsigned numeric text (`"1250.50"` or `"1250,50"` or `"125.500"`) with a Turkish decimal
 * comma (`","`) so `parseStatementAmount` in `src/lib/bank/rules.ts` always treats fractional digits
 * as exact decimals (`lastComma > lastDot`) and never confuses 3-decimal ISO/SWIFT amounts with
 * Turkish `.` thousands separators.
 */
function formatSignedDecimalForTurkishSheet(rawUnsigned: string, isPositive: boolean): string {
  const cleaned = rawUnsigned.trim().replace(",", ".");
  const [intPartRaw, fracPart] = cleaned.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "") || "0";
  const formattedUnsigned = fracPart !== undefined ? `${intPart},${fracPart}` : intPart;
  const isZero = /^0+(?:,0+)?$/.test(formattedUnsigned);
  if (isZero) return "0,00";
  return `${isPositive ? "" : "-"}${formattedUnsigned}`;
}

function extractIbanFromText(raw: string): string {
  const trMatch = raw.replace(/\s+/g, "").match(/\b(TR\d{24})\b/i);
  if (trMatch) return trMatch[1].toUpperCase();
  const structuredMatch =
    raw.match(/\?31([A-Z]{2}\d{2}[A-Z0-9]{11,30})/i)?.[1] ??
    raw.match(/\/IBAN\/([A-Z]{2}\d{2}[A-Z0-9]{11,30})/i)?.[1];
  return structuredMatch ? structuredMatch.toUpperCase() : "";
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function extractXmlTag(xml: string, tagName: string): string | null {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_]+:)?${tagName}>`,
    "i",
  );
  const match = xml.match(re);
  return match ? decodeXmlEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) : null;
}

/**
 * SWIFT MT940 parser (`:60F:` / `:60M:` currency discovery + `:61:` statement lines + `:86:` narrative).
 * Supports both UTF-8 and legacy Turkish `windows-1254` bank exports.
 */
export function parseMt940StatementBuffer(buf: Buffer): StructuredStatementParseResult {
  if (buf.length > MAX_STRUCTURED_STATEMENT_BYTES) {
    return { ok: false, error: "MT940 dosyası izin verilen maksimum boyutu (32 MB) aşıyor." };
  }
  const text = decodeTurkishCsvBuffer(buf)
    .text.replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!/:61:/.test(text)) {
    return { ok: false, error: "MT940 dosyasında hareket satırı (:61:) bulunamadı." };
  }

  // Extract account currency from :60F: or :60M: (e.g. :60F:C260501TRY125000,00)
  const balMatch = text.match(/:60[FM]:[CD]\d{6}([A-Z]{3})/);
  const defaultCurrency = balMatch?.[1] ?? "TRY";

  // Tokenize MT940 tags (`:XX:` or `:XXA:`) at start of line
  const tagRegex = /^:(\d{2}[A-Z]?):(.*)$/gm;
  const fields: { tag: string; value: string }[] = [];
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = tagRegex.exec(text)) !== null) {
    if (fields.length > 0 && match.index > lastIndex) {
      const continuation = text.slice(lastIndex, match.index).trim();
      if (continuation) {
        const cleaned = continuation.replace(/-\s*\}[-\s]*$/, "").trim();
        if (cleaned) {
          fields[fields.length - 1].value += " " + cleaned;
        }
      }
    }
    fields.push({ tag: match[1], value: match[2].trim() });
    lastIndex = tagRegex.lastIndex;
  }
  if (fields.length > 0 && lastIndex < text.length) {
    const tail = text.slice(lastIndex).replace(/-\s*\}[-\s\S]*$/, "").trim();
    if (tail) fields[fields.length - 1].value += " " + tail;
  }

  const rows: string[][] = [STATEMENT_HEADER];
  let currentCurrency = defaultCurrency;

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.tag === "60F" || f.tag === "60M") {
      const ccy = f.value.match(/^[CD]\d{6}([A-Z]{3})/)?.[1];
      if (ccy) currentCurrency = ccy;
      continue;
    }
    if (f.tag !== "61") continue;

    // :61:YYMMDD[MMDD](C|D|RC|RD)[currency_3rd_letter?]amountNtrfRef//bankRef
    const lineMatch = f.value.match(
      /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+(?:[.,]\d+)?)[A-Z][A-Z0-9]{3}([^\n]*)$/,
    );
    if (!lineMatch) continue;

    const valueDate = yymmddToIso(lineMatch[1]);
    if (!valueDate) continue;
    const txDate = resolveEntryDateFromMmdd(valueDate, lineMatch[2]);
    const dcMark = lineMatch[3];
    // C = Credit (+), D = Debit (-), RC = Reversal Credit (-), RD = Reversal Debit (+)
    const isPositive = dcMark === "C" || dcMark === "RD";
    const signedAmount = formatSignedDecimalForTurkishSheet(lineMatch[5], isPositive);

    const refChunk = (lineMatch[6] ?? "").trim();
    const [custRefRaw, bankRefRaw] = refChunk.split("//");
    const reference = (bankRefRaw?.trim() || custRefRaw?.trim() || "").replace(/^NONREF$/i, "");

    let narrative = "";
    if (i + 1 < fields.length && fields[i + 1].tag === "86") {
      narrative = fields[i + 1].value.replace(/\s+/g, " ").trim();
      i += 1;
    }

    // Attempt to extract counterparty name & IBAN from structured :86: subfields (?32 / ?31 / /NAME/)
    const nameSub =
      narrative.match(/\?32([^?]+)/)?.[1]?.trim() ??
      narrative.match(/\/NAME\/([^/]+)/)?.[1]?.trim() ??
      "";
    const counterpartyIban = extractIbanFromText(narrative);
    const description = narrative || reference || `MT940 ${dcMark} hareketi`;

    rows.push([
      txDate,
      valueDate,
      signedAmount,
      currentCurrency,
      description,
      nameSub,
      counterpartyIban,
      reference,
    ]);
  }

  if (rows.length <= 1) {
    return { ok: false, error: "MT940 dosyasında geçerli tutar/tarih içeren :61: satırı ayrıştırılamadı." };
  }

  return { ok: true, rows, format: "mt940" };
}

/**
 * ISO 20022 CAMT.053 (`BkToCstmrStmt` / `<Stmt>` / `<Ntry>`) XML bank statement parser.
 */
export function parseCamt053StatementBuffer(buf: Buffer): StructuredStatementParseResult {
  if (buf.length > MAX_STRUCTURED_STATEMENT_BYTES) {
    return { ok: false, error: "CAMT.053 XML dosyası izin verilen maksimum boyutu (32 MB) aşıyor." };
  }
  const xml = decodeTurkishCsvBuffer(buf).text.replace(/^\uFEFF/, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return { ok: false, error: "Güvenlik politikası gereği DTD/ENTITY içeren XML dosyaları reddedildi." };
  }
  if (/<(?:[a-zA-Z0-9_]+:)?Invoice\b/i.test(xml) && !/<(?:[a-zA-Z0-9_]+:)?BkToCstmrStmt\b/i.test(xml)) {
    return {
      ok: false,
      error:
        "Bu dosya bir UBL-TR e-Fatura XML belgesidir; banka ekstresi yerine /data/integrations ekranından yükleyin.",
    };
  }
  if (!/<(?:[a-zA-Z0-9_]+:)?(?:BkToCstmrStmt|Stmt|Ntry)\b/i.test(xml)) {
    return {
      ok: false,
      error: "Geçerli bir ISO 20022 CAMT.053 banka ekstresi (<BkToCstmrStmt> / <Ntry>) bulunamadı.",
    };
  }

  const stmtCurrency =
    xml.match(
      /<(?:[a-zA-Z0-9_]+:)?Acct[\s\S]*?<(?:[a-zA-Z0-9_]+:)?Ccy>([A-Z]{3})<\/(?:[a-zA-Z0-9_]+:)?Ccy>/i,
    )?.[1] ?? "TRY";

  const entryRegex = /<(?:[a-zA-Z0-9_]+:)?Ntry(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?Ntry>/gi;
  const rows: string[][] = [STATEMENT_HEADER];
  let entryMatch: RegExpExecArray | null;

  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const amtTagMatch = block.match(
      /<(?:[a-zA-Z0-9_]+:)?Amt(?:\s+[^>]*Ccy=["']([A-Z]{3})["'][^>]*)?>\s*([0-9]+(?:[.,][0-9]+)?)\s*<\/(?:[a-zA-Z0-9_]+:)?Amt>/i,
    );
    if (!amtTagMatch) continue;

    const currency = amtTagMatch[1] || stmtCurrency;
    const cdtDbt = extractXmlTag(block, "CdtDbtInd")?.toUpperCase() ?? "CRDT";
    const rvsl = extractXmlTag(block, "RvslInd")?.toLowerCase() === "true";
    const isCredit = cdtDbt.startsWith("CRDT") ? !rvsl : rvsl;
    const signedAmount = formatSignedDecimalForTurkishSheet(amtTagMatch[2], isCredit);

    const bookgBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?BookgDt>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?BookgDt>/i)?.[1] ?? "";
    const valBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?ValDt>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?ValDt>/i)?.[1] ?? "";
    const txDateRaw =
      extractXmlTag(bookgBlock, "Dt") ??
      extractXmlTag(bookgBlock, "DtTm")?.slice(0, 10) ??
      extractXmlTag(valBlock, "Dt") ??
      extractXmlTag(valBlock, "DtTm")?.slice(0, 10);
    if (!txDateRaw) continue;
    const txDate = txDateRaw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(txDate)) continue;
    const valDateCandidate = (
      extractXmlTag(valBlock, "Dt") ??
      extractXmlTag(valBlock, "DtTm")?.slice(0, 10) ??
      txDate
    ).slice(0, 10);
    const valDate = /^\d{4}-\d{2}-\d{2}$/.test(valDateCandidate) ? valDateCandidate : txDate;

    const acctSvcrRef = extractXmlTag(block, "AcctSvcrRef") ?? extractXmlTag(block, "EndToEndId") ?? "";
    const ustrd = extractXmlTag(block, "Ustrd") ?? extractXmlTag(block, "AddtlNtryInf") ?? "";
    const dbtrBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?Dbtr>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?Dbtr>/i)?.[1] ?? "";
    const cdtrBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?Cdtr>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?Cdtr>/i)?.[1] ?? "";
    const dbtrAcctBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?DbtrAcct>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?DbtrAcct>/i)?.[1] ?? "";
    const cdtrAcctBlock =
      block.match(/<(?:[a-zA-Z0-9_]+:)?CdtrAcct>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?CdtrAcct>/i)?.[1] ?? "";

    const dbtrName = extractXmlTag(dbtrBlock, "Nm");
    const cdtrName = extractXmlTag(cdtrBlock, "Nm");
    const dbtrIban = extractXmlTag(dbtrAcctBlock, "IBAN");
    const cdtrIban = extractXmlTag(cdtrAcctBlock, "IBAN");

    const counterparty = (isCredit ? dbtrName : cdtrName) ?? dbtrName ?? cdtrName ?? "";
    const counterpartyIban =
      ((isCredit ? dbtrIban : cdtrIban) ?? dbtrIban ?? cdtrIban ?? "").replace(/\s+/g, "").toUpperCase();
    const description = ustrd || counterparty || acctSvcrRef || `CAMT.053 ${cdtDbt}`;

    rows.push([
      txDate,
      valDate,
      signedAmount,
      currency,
      description,
      counterparty,
      counterpartyIban,
      acctSvcrRef === "NOTPROVIDED" ? "" : acctSvcrRef,
    ]);
  }

  if (rows.length <= 1) {
    return { ok: false, error: "CAMT.053 XML içinde ayrıştırılabilir <Ntry> banka hareketi bulunamadı." };
  }

  return { ok: true, rows, format: "camt053" };
}
