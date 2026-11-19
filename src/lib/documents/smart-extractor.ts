// Faz 61 (0121) — Deterministik Belge / e-Fatura (UBL-TR) / PDF Dekont & Çek Yapısal Alan Çıkarıcı.
//
// Kurallar:
//   * Harici ağ / LLM çağrısı yapmaz; tamamen deterministik ve çevrimdışı çalışır.
//   * BLANK != ZERO: Belgede tutar bulunamazsa ASLA 0 üretmez (`detectedAmount: null`).
//   * Tüm parasal dönüşümler `@/lib/money` (`moneyOrNull`) üzerinden tam kesinlikle yapılır.

import { inflateRawSync, inflateSync } from "node:zlib";
import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { loadVerifiedDocumentDownload } from "@/lib/documents/engine";
import { moneyOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

export type SupportedExtractedCurrency = "TRY" | "USD" | "EUR" | "GBP";

export type ExtractedDocumentClass =
  | "einvoice"
  | "bank_receipt"
  | "check_leaf"
  | "expense_receipt"
  | "general";

export type ExtractionConfidence = "high" | "medium" | "low";

export interface StructuredDocumentExtraction {
  vknOrTckn: string | null;
  iban: string | null;
  detectedDateIso: string | null;
  detectedAmount: number | null;
  currency: SupportedExtractedCurrency | null;
  documentNumber: string | null;
  documentClass: ExtractedDocumentClass;
  confidence: ExtractionConfidence;
  supplierName: string | null;
  ublUuid: string | null;
  rawPreview: string;
}

const MAX_STREAM_SCAN_BYTES = 262_144;
const MAX_TOTAL_INFLATED_BYTES = 1_572_864;

/**
 * Parses a Turkish (`1.250.450,75`), US/ISO (`1,250,450.75`), or plain (`1250450.75`) monetary
 * string into an exact 2-dp number via `@/lib/money`. Returns `null` for blank or invalid text
 * (`BLANK != ZERO` — never fabricates `0`).
 */
export function parseDocumentMoneyOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let cleaned = raw
    .replace(/[\u00A0\s]+/g, "")
    .replace(/^(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£)+/i, "")
    .replace(/(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£)+$/i, "")
    .trim();

  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) {
      // Turkish format: 1.250.450,75
      cleaned = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      // US/ISO format: 1,250,450.75
      cleaned = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = cleaned.split(",");
    if (parts.length === 2 && parts[1].length <= 4) {
      // Decimal comma: 1250,75
      cleaned = `${parts[0]}.${parts[1]}`;
    } else if (parts.every((p, idx) => (idx === 0 ? /^\d{1,3}$/.test(p) : /^\d{3}$/.test(p)))) {
      // Thousands commas only: 1,250,000
      cleaned = parts.join("");
    } else {
      return null;
    }
  } else if (hasDot) {
    const parts = cleaned.split(".");
    if (parts.length > 2) {
      // Multiple dots = Turkish thousands without decimal part: 1.250.000
      if (parts.every((p, idx) => (idx === 0 ? /^[+-]?\d{1,3}$/.test(p) : /^\d{3}$/.test(p)))) {
        cleaned = parts.join("");
      } else {
        return null;
      }
    } else if (parts.length === 2 && parts[1].length === 3 && /^[+-]?\d{1,3}$/.test(parts[0])) {
      // Ambiguous 3-digit group after dot in Turkish text (e.g., 12.500 -> 12500)
      cleaned = parts.join("");
    }
  }

  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  try {
    return moneyOrNull(cleaned);
  } catch {
    return null;
  }
}

function decodeTextBuffer(buf: Buffer): string {
  if (buf.byteLength === 0) return "";
  const headAscii = buf.subarray(0, 512).toString("latin1");
  const declaresWin1254 = /encoding\s*=\s*["'](?:windows-1254|iso-8859-9|cp1254)["']/i.test(headAscii);

  if (!declaresWin1254) {
    const utf8 = buf.toString("utf8");
    if (!utf8.includes("\uFFFD")) {
      return utf8;
    }
  }

  try {
    return new TextDecoder("windows-1254").decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

function unescapePdfLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === "n") {
      out += "\n";
      i += 1;
    } else if (next === "r") {
      out += "\r";
      i += 1;
    } else if (next === "t") {
      out += "\t";
      i += 1;
    } else if (next === "(" || next === ")" || next === "\\") {
      out += next;
      i += 1;
    } else if (/[0-7]/.test(next)) {
      const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
      out += String.fromCharCode(parseInt(oct, 8));
      i += oct.length;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

function extractParenthesizedPdfStrings(segment: string): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] !== "(") {
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let body = "";
    while (j < segment.length && depth > 0) {
      const c = segment[j];
      if (c === "\\") {
        body += segment.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === "(") {
        depth += 1;
        body += c;
      } else if (c === ")") {
        depth -= 1;
        if (depth > 0) body += c;
      } else {
        body += c;
      }
      j += 1;
    }
    const decoded = unescapePdfLiteral(body).trim();
    if (decoded.length > 0) {
      pieces.push(decoded);
    }
    i = j;
  }
  return pieces;
}

function decodePdfHexStrings(segment: string): string[] {
  const out: string[] = [];
  const hexRe = /<([0-9A-Fa-f\s]{4,})>/g;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(segment)) !== null) {
    const cleanHex = m[1].replace(/\s+/g, "");
    if (cleanHex.length < 4) continue;
    const padded = cleanHex.length % 2 === 0 ? cleanHex : `${cleanHex}0`;
    const bytes = Buffer.from(padded, "hex");
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      // UTF-16BE BOM
      let str = "";
      for (let k = 2; k + 1 < bytes.length; k += 2) {
        const code = (bytes[k] << 8) | bytes[k + 1];
        if (code >= 32 || code === 10 || code === 13) str += String.fromCharCode(code);
      }
      if (str.trim()) out.push(str.trim());
    } else {
      const decoded = decodeTextBuffer(bytes).trim();
      if (decoded && /[\p{L}\d]/u.test(decoded)) out.push(decoded);
    }
  }
  return out;
}

function extractTextFromPdfSegment(segment: string): string {
  const chunks: string[] = [];

  // 1) Extract BT ... ET text blocks first for ordered reading
  const btEtRe = /\bBT\b([\s\S]*?)\bET\b/g;
  let blockMatch: RegExpExecArray | null;
  let foundBtEt = false;
  while ((blockMatch = btEtRe.exec(segment)) !== null) {
    foundBtEt = true;
    const block = blockMatch[1];
    chunks.push(...extractParenthesizedPdfStrings(block));
    chunks.push(...decodePdfHexStrings(block));
  }

  // 2) Also extract metadata or top-level parenthesized strings outside BT..ET
  if (!foundBtEt) {
    chunks.push(...extractParenthesizedPdfStrings(segment));
    chunks.push(...decodePdfHexStrings(segment));
  } else {
    const metaRe = /\/(?:Title|Subject|Keywords|Author)\s*\(([^)]*(?:\\.[^)]*)*)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = metaRe.exec(segment)) !== null) {
      const val = unescapePdfLiteral(mm[1]).trim();
      if (val) chunks.push(val);
    }
  }

  return chunks.join(" ");
}

function extractPdfText(buf: Buffer): string {
  const rawLatin = buf.toString("latin1");
  const pieces: string[] = [];

  // Extract metadata & uncompressed text operators at top level
  const topText = extractTextFromPdfSegment(rawLatin);
  if (topText) pieces.push(topText);

  // Inspect stream ... endstream blocks (both uncompressed and FlateDecode)
  let inflatedBudget = 0;
  const streamToken = "stream";
  const endStreamToken = "endstream";
  let cursor = 0;

  while (cursor < rawLatin.length && inflatedBudget < MAX_TOTAL_INFLATED_BYTES) {
    const startIdx = rawLatin.indexOf(streamToken, cursor);
    if (startIdx === -1) break;
    // Ensure it's not "endstream"
    if (startIdx >= 3 && rawLatin.slice(startIdx - 3, startIdx) === "end") {
      cursor = startIdx + streamToken.length;
      continue;
    }

    let bodyStart = startIdx + streamToken.length;
    if (rawLatin[bodyStart] === "\r" && rawLatin[bodyStart + 1] === "\n") bodyStart += 2;
    else if (rawLatin[bodyStart] === "\n" || rawLatin[bodyStart] === "\r") bodyStart += 1;

    const endIdx = rawLatin.indexOf(endStreamToken, bodyStart);
    if (endIdx === -1) break;

    const sliceLen = endIdx - bodyStart;
    if (sliceLen > 0 && sliceLen <= MAX_STREAM_SCAN_BYTES) {
      const dictWindow = rawLatin.slice(Math.max(0, startIdx - 280), startIdx);
      const streamBytes = buf.subarray(bodyStart, endIdx);
      if (/\/FlateDecode\b/.test(dictWindow)) {
        let decompressed: Buffer | null = null;
        try {
          decompressed = inflateSync(streamBytes, { maxOutputLength: MAX_STREAM_SCAN_BYTES * 2 });
        } catch {
          try {
            decompressed = inflateRawSync(streamBytes, { maxOutputLength: MAX_STREAM_SCAN_BYTES * 2 });
          } catch {
            decompressed = null;
          }
        }
        if (decompressed && decompressed.byteLength > 0) {
          inflatedBudget += decompressed.byteLength;
          const segText = extractTextFromPdfSegment(decodeTextBuffer(decompressed));
          if (segText) pieces.push(segText);
        }
      } else {
        const segText = extractTextFromPdfSegment(decodeTextBuffer(streamBytes));
        if (segText) pieces.push(segText);
      }
    }

    cursor = endIdx + endStreamToken.length;
  }

  // Fallback: capture plain readable ASCII/Turkish runs if operators were sparse
  const asciiRuns = rawLatin
    .match(/[A-Za-z0-9ÇĞİÖŞÜçğıöşü:.,/\-_₺$€£\s]{6,}/g)
    ?.map((s) => s.trim())
    .filter((s) => s.length >= 6 && !/^(?:obj|endobj|stream|endstream|xref|trailer)/.test(s));
  if (asciiRuns && asciiRuns.length > 0) {
    pieces.push(asciiRuns.slice(0, 120).join(" "));
  }

  return pieces.join("\n");
}

function isValidTurkishIbanChecksum(iban: string): boolean {
  if (!/^TR\d{24}$/.test(iban)) return false;
  const rearranged = `${iban.slice(4)}2927${iban.slice(2, 4)}`;
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    remainder = (remainder * 10 + Number(rearranged[i])) % 97;
  }
  return remainder === 1;
}

function extractBestIban(text: string): string | null {
  const re = /\bTR\s*(?:\d[\s-]*){24}\b/gi;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalized = m[0].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (/^TR\d{24}$/.test(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }
  if (candidates.length === 0) return null;
  const validChecksum = candidates.find(isValidTurkishIbanChecksum);
  return validChecksum ?? candidates[0];
}

function extractVknOrTckn(textWithoutIbans: string): string | null {
  const labeledRe =
    /(?:VKN|TCKN|V\.?K\.?N\.?|T\.?C\.?\s*Kimlik(?:\s*No)?|Vergi\s*(?:Kimlik)?\s*(?:No|Numaras[ıi]))\s*[:.#\-=]?\s*(\d{10,11})\b/i;
  const labeled = textWithoutIbans.match(labeledRe);
  if (labeled?.[1]) return labeled[1];

  // Fallback: standalone 10- or 11-digit token that is not a phone starting with 05xx or 905xx
  const genericRe = /\b(\d{10,11})\b/g;
  let m: RegExpExecArray | null;
  while ((m = genericRe.exec(textWithoutIbans)) !== null) {
    const digits = m[1];
    if (digits.length === 11 && digits.startsWith("05")) continue;
    if (digits.startsWith("00")) continue;
    return digits;
  }
  return null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1990 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function extractDetectedDateIso(text: string): string | null {
  // 1) ISO YYYY-MM-DD
  const isoRe = /\b(20\d{2}|199\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoRe.exec(text)) !== null) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidCalendarDate(y, mo, d)) {
      return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }

  // 2) Turkish DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
  const trRe = /\b(0?[1-9]|[12]\d|3[01])[./-](0?[1-9]|1[0-2])[./-](20\d{2}|199\d)\b/g;
  while ((m = trRe.exec(text)) !== null) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (isValidCalendarDate(y, mo, d)) {
      return `${String(y)}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

function normalizeCurrencyToken(raw: string | null | undefined): SupportedExtractedCurrency | null {
  if (!raw) return null;
  const u = raw.trim().toUpperCase();
  if (u === "TRY" || u === "TL" || u === "TRL" || raw.includes("₺")) return "TRY";
  if (u === "USD" || raw.includes("$")) return "USD";
  if (u === "EUR" || raw.includes("€")) return "EUR";
  if (u === "GBP" || raw.includes("£")) return "GBP";
  return null;
}

function detectCurrencyAndAmount(textWithoutIbans: string): {
  amount: number | null;
  currency: SupportedExtractedCurrency | null;
} {
  // 1) Labeled total / amount patterns first (Turkish & English)
  const labeledPatterns = [
    /(?:Ödenecek\s*Tutar|Genel\s*Toplam|Toplam\s*Tutar|Dekont\s*Tutar[ıi]|Çek\s*Tutar[ıi]|İşlem\s*Tutar[ıi]|Fatura\s*Toplam[ıi]|Payable\s*Amount|Grand\s*Total|Total\s*Amount|Tutar|Toplam|Bedeli)\s*[:=#\-]?\s*(?:(TRY|TL|USD|EUR|GBP|[₺$€£])\s*)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2}))\s*(TRY|TL|USD|EUR|GBP|[₺$€£])?/gi,
  ];

  for (const re of labeledPatterns) {
    let m: RegExpExecArray | null;
    const matches: Array<{ amount: number; currency: SupportedExtractedCurrency | null }> = [];
    while ((m = re.exec(textWithoutIbans)) !== null) {
      const parsed = parseDocumentMoneyOrNull(m[2]);
      if (parsed !== null && parsed > 0) {
        const curr = normalizeCurrencyToken(m[1]) ?? normalizeCurrencyToken(m[3]);
        matches.push({ amount: parsed, currency: curr });
      }
    }
    if (matches.length > 0) {
      // Pick the last/grand total match when multiple labeled lines exist (e.g. Ara Toplam -> Genel Toplam)
      const best = matches[matches.length - 1];
      return {
        amount: best.amount,
        currency: best.currency ?? detectStandaloneCurrency(textWithoutIbans),
      };
    }
  }

  // 2) Currency-adjacent amounts (e.g. "125.450,75 TL", "USD 4,500.00", "€ 1.200,00")
  const currAfterRe =
    /\b(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{2}|\d{2,9})\s*(TRY|TL|USD|EUR|GBP|[₺$€£])(?![A-Za-z])/gi;
  let cm: RegExpExecArray | null;
  while ((cm = currAfterRe.exec(textWithoutIbans)) !== null) {
    const parsed = parseDocumentMoneyOrNull(cm[1]);
    const curr = normalizeCurrencyToken(cm[2]);
    if (parsed !== null && parsed > 0 && curr) {
      return { amount: parsed, currency: curr };
    }
  }

  const currBeforeRe =
    /(?:^|[\s:(])(TRY|TL|USD|EUR|GBP|[₺$€£])\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+[.,]\d{2}|\d{2,9})\b/gi;
  while ((cm = currBeforeRe.exec(textWithoutIbans)) !== null) {
    const parsed = parseDocumentMoneyOrNull(cm[2]);
    const curr = normalizeCurrencyToken(cm[1]);
    if (parsed !== null && parsed > 0 && curr) {
      return { amount: parsed, currency: curr };
    }
  }

  return {
    amount: null,
    currency: detectStandaloneCurrency(textWithoutIbans),
  };
}

function detectStandaloneCurrency(text: string): SupportedExtractedCurrency | null {
  if (/\b(?:TRY|TL)\b|₺/i.test(text)) return "TRY";
  if (/\bUSD\b|\$/i.test(text)) return "USD";
  if (/\bEUR\b|€/i.test(text)) return "EUR";
  if (/\bGBP\b|£/i.test(text)) return "GBP";
  return null;
}

function extractDocumentNumber(text: string): string | null {
  // 1) Standard 16-char Turkish e-Fatura / e-Arşiv ID (e.g. GIB2026000000123, MAS2026000001452)
  const gibMatch = text.match(/\b([A-Z0-9]{3}20\d{11})\b/);
  if (gibMatch?.[1]) return gibMatch[1];

  // 2) Labeled serial / document / receipt / check numbers
  const labeledDocRe =
    /(?:Fatura\s*No|Belge\s*No|Dekont\s*No|Fiş\s*No|Fis\s*No|Çek\s*(?:Seri\s*)?No|Cek\s*(?:Seri\s*)?No|Seri\s*No|Referans\s*No|Receipt\s*No|Document\s*No)\s*[:.#\-=]?\s*([A-Z0-9][A-Z0-9/\-_]{2,31})\b/i;
  const labeled = text.match(labeledDocRe);
  if (labeled?.[1]) return labeled[1].trim();

  return null;
}

function classifyDocument(
  text: string,
  filename: string,
  hasUblMarkers: boolean,
  documentNumber: string | null,
  iban: string | null,
): ExtractedDocumentClass {
  if (hasUblMarkers) return "einvoice";
  const combined = `${filename}\n${text}`.toLowerCase();

  if (
    /e-fatura|e-arşiv|e-arsiv|ettn|ubl-tr/.test(combined) ||
    (documentNumber !== null && /^[A-Z0-9]{3}20\d{11}$/.test(documentNumber))
  ) {
    return "einvoice";
  }
  if (/çek\b|cek\b|keşide|keside|hamiline|çek\s*seri|bordro/.test(combined)) {
    return "check_leaf";
  }
  if (/dekont|havale|eft\b|fast\b|virman|hesap\s*özeti|hesap\s*ozeti|swift/.test(combined) || (iban && /banka|transfer|ödeme\s*makbuzu/.test(combined))) {
    return "bank_receipt";
  }
  if (/fiş|fis|perakende\s*satış|yazar\s*kasa|ökc|okc|masraf|kasa\s*fişi/.test(combined)) {
    return "expense_receipt";
  }
  return "general";
}

function extractFromUblXml(xml: string): StructuredDocumentExtraction {
  // Strip nested party/line blocks to read top-level header <cbc:ID> and <cbc:UUID> cleanly
  const headerSlice = xml.split(/<(?:[A-Za-z0-9_]+:)?AccountingSupplierParty\b/i)[0] ?? xml;
  const headerWithoutSig = headerSlice.replace(
    /<(?:[A-Za-z0-9_]+:)?Signature\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?Signature>/gi,
    "",
  );

  const docId =
    headerWithoutSig.match(/<(?:[A-Za-z0-9_]+:)?ID(?:\s[^>]*)?>([^<]{3,64})<\/(?:[A-Za-z0-9_]+:)?ID>/i)?.[1]?.trim() ??
    extractDocumentNumber(xml);

  const ublUuid =
    headerWithoutSig
      .match(/<(?:[A-Za-z0-9_]+:)?UUID(?:\s[^>]*)?>([0-9a-fA-F-]{16,64})<\/(?:[A-Za-z0-9_]+:)?UUID>/i)?.[1]
      ?.trim() ?? null;

  const issueDate =
    xml.match(/<(?:[A-Za-z0-9_]+:)?IssueDate(?:\s[^>]*)?>(\d{4}-\d{2}-\d{2})<\/(?:[A-Za-z0-9_]+:)?IssueDate>/i)?.[1] ??
    extractDetectedDateIso(xml);

  const payableMatch =
    xml.match(
      /<(?:[A-Za-z0-9_]+:)?PayableAmount([^>]*)>([^<]+)<\/(?:[A-Za-z0-9_]+:)?PayableAmount>/i,
    ) ??
    xml.match(
      /<(?:[A-Za-z0-9_]+:)?TaxInclusiveAmount([^>]*)>([^<]+)<\/(?:[A-Za-z0-9_]+:)?TaxInclusiveAmount>/i,
    );

  const currencyAttr = payableMatch?.[1]?.match(/currencyID\s*=\s*["']([A-Za-z]{3})["']/i)?.[1];
  const docCurrencyCode = xml.match(
    /<(?:[A-Za-z0-9_]+:)?DocumentCurrencyCode(?:\s[^>]*)?>([A-Za-z]{3})<\/(?:[A-Za-z0-9_]+:)?DocumentCurrencyCode>/i,
  )?.[1];

  const detectedAmount = payableMatch?.[2] ? parseDocumentMoneyOrNull(payableMatch[2].trim()) : null;
  const currency =
    normalizeCurrencyToken(currencyAttr) ??
    normalizeCurrencyToken(docCurrencyCode) ??
    (detectedAmount !== null ? "TRY" : null);

  const supplierBlock =
    xml.match(
      /<(?:[A-Za-z0-9_]+:)?AccountingSupplierParty\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?AccountingSupplierParty>/i,
    )?.[0] ?? "";

  const supplierVkn =
    supplierBlock.match(
      /<(?:[A-Za-z0-9_]+:)?ID[^>]*schemeID\s*=\s*["'](?:VKN|TCKN)["'][^>]*>(\d{10,11})<\/(?:[A-Za-z0-9_]+:)?ID>/i,
    )?.[1] ??
    supplierBlock.match(
      /<(?:[A-Za-z0-9_]+:)?PartyIdentification\b[\s\S]*?<(?:[A-Za-z0-9_]+:)?ID[^>]*>(\d{10,11})<\/(?:[A-Za-z0-9_]+:)?ID>/i,
    )?.[1] ??
    null;

  const supplierPartyNameBlock =
    supplierBlock.match(
      /<(?:[A-Za-z0-9_]+:)?PartyName\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?PartyName>/i,
    )?.[0] ?? "";
  const supplierName =
    supplierPartyNameBlock
      .match(/<(?:[A-Za-z0-9_]+:)?Name(?:\s[^>]*)?>([^<]+)<\/(?:[A-Za-z0-9_]+:)?Name>/i)?.[1]
      ?.trim() ?? null;

  const iban = extractBestIban(xml);

  let signalCount = 0;
  if (docId) signalCount += 1;
  if (issueDate) signalCount += 1;
  if (detectedAmount !== null) signalCount += 1;
  if (supplierVkn) signalCount += 1;
  if (iban) signalCount += 1;

  const confidence: ExtractionConfidence =
    signalCount >= 2 ? "high" : signalCount === 1 ? "medium" : "low";

  return {
    vknOrTckn: supplierVkn,
    iban,
    detectedDateIso: issueDate,
    detectedAmount,
    currency,
    documentNumber: docId ?? null,
    documentClass: "einvoice",
    confidence,
    supplierName,
    ublUuid,
    rawPreview: [docId, supplierName, issueDate, detectedAmount !== null ? `${detectedAmount} ${currency ?? ""}` : null]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 280),
  };
}

/**
 * Deterministic structured document extractor supporting UBL-TR XML, UTF-8 / `windows-1254`
 * receipts, and PDF text streams (`BT ... ET` / `(text)` / `FlateDecode` + metadata).
 */
export function extractStructuredDocumentFields(
  buf: Buffer,
  filename: string,
  mimeType: string,
): StructuredDocumentExtraction {
  const cleanFilename = (filename ?? "").trim();
  const cleanMime = (mimeType ?? "").trim().toLowerCase();

  if (!buf || buf.byteLength === 0) {
    return {
      vknOrTckn: null,
      iban: null,
      detectedDateIso: null,
      detectedAmount: null,
      currency: null,
      documentNumber: null,
      documentClass: "general",
      confidence: "low",
      supplierName: null,
      ublUuid: null,
      rawPreview: "",
    };
  }

  const isPdf =
    cleanMime === "application/pdf" ||
    cleanFilename.toLowerCase().endsWith(".pdf") ||
    buf.subarray(0, 5).toString("latin1") === "%PDF-";

  const decodedText = isPdf ? extractPdfText(buf) : decodeTextBuffer(buf);
  const trimmed = decodedText.trim();

  const isUblXml =
    !isPdf &&
    (cleanMime.includes("xml") || cleanFilename.toLowerCase().endsWith(".xml") || trimmed.startsWith("<?xml") || trimmed.startsWith("<Invoice")) &&
    /<(?:[A-Za-z0-9_]+:)?(?:Invoice|CreditNote|IssueDate|PayableAmount|AccountingSupplierParty)\b/i.test(
      trimmed,
    );

  if (isUblXml) {
    return extractFromUblXml(trimmed);
  }

  const iban = extractBestIban(trimmed);
  // Strip IBAN strings before scanning numbers so 24-digit IBAN tails never masquerade as VKN or amounts
  const textWithoutIbans = trimmed.replace(/\bTR\s*(?:\d[\s-]*){24}\b/gi, " [IBAN] ");

  const vknOrTckn = extractVknOrTckn(textWithoutIbans);
  const detectedDateIso = extractDetectedDateIso(textWithoutIbans);
  const { amount: detectedAmount, currency } = detectCurrencyAndAmount(textWithoutIbans);
  const documentNumber = extractDocumentNumber(textWithoutIbans);
  const documentClass = classifyDocument(trimmed, cleanFilename, false, documentNumber, iban);

  let structuredHits = 0;
  if (vknOrTckn) structuredHits += 1;
  if (iban) structuredHits += 1;
  if (detectedDateIso) structuredHits += 1;
  if (detectedAmount !== null) structuredHits += 1;
  if (documentNumber) structuredHits += 1;

  const confidence: ExtractionConfidence =
    structuredHits >= 3 ? "high" : structuredHits >= 1 ? "medium" : "low";

  return {
    vknOrTckn,
    iban,
    detectedDateIso,
    detectedAmount,
    currency,
    documentNumber,
    documentClass,
    confidence,
    supplierName: null,
    ublUuid: null,
    rawPreview: trimmed.replace(/\s+/g, " ").slice(0, 280),
  };
}

/**
 * Loads the latest stored attachment of `documentId`, runs `extractStructuredDocumentFields`,
 * updates `public.documents.extracted_metadata` (0119), and appends an `audit()` record.
 */
export async function persistDocumentExtraction(
  pool: Pool,
  documentId: string,
  actorId: string | null,
): Promise<StructuredDocumentExtraction> {
  const validDocId = parseOrThrow(z.string().uuid(), documentId, "Doküman kimliği");
  const download = await loadVerifiedDocumentDownload(pool, validDocId);
  const extraction = extractStructuredDocumentFields(
    download.bytes,
    download.originalFilename,
    download.mimeType,
  );

  const client = await pool.connect();
  try {
    await client.query("begin");
    const prevRes = await client.query<{ extracted_metadata: Record<string, unknown> | null }>(
      `select extracted_metadata
         from public.documents
        where id = $1
        for update`,
      [validDocId],
    );
    if (prevRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Doküman kaydı bulunamadı.");
    }
    const beforeMeta = prevRes.rows[0].extracted_metadata ?? null;

    const patchPayload = {
      vknOrTckn: extraction.vknOrTckn,
      iban: extraction.iban,
      detectedDateIso: extraction.detectedDateIso,
      detectedAmount: extraction.detectedAmount,
      currency: extraction.currency,
      documentNumber: extraction.documentNumber,
      documentClass: extraction.documentClass,
      confidence: extraction.confidence,
      supplierName: extraction.supplierName,
      ublUuid: extraction.ublUuid,
      extractedAt: new Date().toISOString(),
      smartExtraction: extraction,
    };

    const upd = await client.query(
      `update public.documents
          set extracted_metadata = coalesce(extracted_metadata, '{}'::jsonb) || $2::jsonb
        where id = $1`,
      [validDocId, JSON.stringify(patchPayload)],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Doküman çıkarım metaverisi güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "extract_document_fields",
      entityTable: "documents",
      entityId: validDocId,
      before: beforeMeta,
      after: {
        documentClass: extraction.documentClass,
        confidence: extraction.confidence,
        documentNumber: extraction.documentNumber,
        detectedDateIso: extraction.detectedDateIso,
        detectedAmount: extraction.detectedAmount,
        currency: extraction.currency,
        hasIban: extraction.iban !== null,
        hasVkn: extraction.vknOrTckn !== null,
      },
    });

    await client.query("commit");
    return extraction;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
