// Faz 20 / Faz 41 (B1) / Faz 61 (M-29) — bank statement parsing (.xlsx, .csv/.txt/.tsv, SWIFT .mt940/.sta/.940, ISO 20022 CAMT.053 .xml).

import { decodeTurkishCsvBuffer, detectCsvDelimiter, parseCsvStatementBuffer } from "./csv-parser";
import { parseCamt053StatementBuffer, parseMt940StatementBuffer } from "./mt940-camt053-parser";
import { buildWorksheetFromAoa, type ParsedWorkbook } from "./row-utils";
import { safeParseWorkbookBuffer } from "./workbook-parser";

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export function detectDelimiter(text: string): string | null {
  return detectCsvDelimiter(text);
}

export type StatementFormat = "xlsx" | "csv" | "mt940" | "camt053";

export type StatementParseResult =
  | {
      ok: true;
      workbook: ParsedWorkbook;
      fileSize: number;
      format: StatementFormat;
    }
  | {
      ok: false;
      error: string;
      fileSize: number;
      format?: StatementFormat;
    };

/**
 * Parse a bank statement upload (.xlsx, .csv/.txt/.tsv, SWIFT .mt940/.sta/.940, or CAMT.053 .xml).
 *
 * Legacy binary `.xls` (CFB_MAGIC) is explicitly rejected by `safeParseWorkbookBuffer` / `inspectZipSafety`.
 * Explicit `"0,00"` cells in CSV/MT940/CAMT.053 are preserved verbatim as string `"0,00"`, never coerced to `null`.
 */
export async function safeParseStatementBuffer(
  buf: Buffer,
  filename: string,
): Promise<StatementParseResult> {
  if (buf.length === 0) {
    return { ok: false, error: "empty file (0 bytes)", fileSize: 0 };
  }

  const head = buf.subarray(0, Math.min(4, buf.length));
  if (head.length === 4 && (head.equals(ZIP_MAGIC) || head.equals(CFB_MAGIC))) {
    const parsed = await safeParseWorkbookBuffer(buf);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, fileSize: parsed.fileSize, format: "xlsx" };
    }
    return {
      ok: true,
      workbook: parsed.workbook,
      fileSize: parsed.fileSize,
      format: "xlsx",
    };
  }

  const trimmedName = filename.trim();
  const sampleText = decodeTurkishCsvBuffer(buf.subarray(0, Math.min(8192, buf.length))).text;

  // SWIFT MT940 (.mt940, .sta, .940, or content-sniffed SWIFT :20:/:60F:/:60M: + :61: tags)
  const looksMt940Ext = /\.(mt940|sta|940)$/i.test(trimmedName);
  const looksSwiftMt940Content =
    !(trimmedName && /\.xml$/i.test(trimmedName)) &&
    (/:20:/.test(sampleText) || /:60[FM]:/.test(sampleText)) &&
    /:61:/.test(sampleText);

  if (looksMt940Ext || looksSwiftMt940Content) {
    const mt = parseMt940StatementBuffer(buf);
    if (!mt.ok) {
      return { ok: false, error: mt.error, fileSize: buf.length, format: "mt940" };
    }
    const sheet = buildWorksheetFromAoa(mt.rows);
    return {
      ok: true,
      workbook: { SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } },
      fileSize: buf.length,
      format: "mt940",
    };
  }

  // ISO 20022 CAMT.053 (.xml or content-sniffed XML bank statement)
  const looksXmlExt = /\.xml$/i.test(trimmedName);
  const looksCamtXmlContent =
    /^\s*(?:<\?xml|<(?:\w+:)?Document\b|<(?:\w+:)?BkToCstmrStmt\b)/i.test(sampleText) &&
    /<(?:\w+:)?(?:BkToCstmrStmt|Ntry|Invoice)\b/i.test(sampleText);

  if (looksXmlExt || looksCamtXmlContent) {
    const camt = parseCamt053StatementBuffer(buf);
    if (!camt.ok) {
      return { ok: false, error: camt.error, fileSize: buf.length, format: "camt053" };
    }
    const sheet = buildWorksheetFromAoa(camt.rows);
    return {
      ok: true,
      workbook: { SheetNames: ["Sheet1"], Sheets: { Sheet1: sheet } },
      fileSize: buf.length,
      format: "camt053",
    };
  }

  const looksCsvName = /\.(csv|txt|tsv)$/i.test(trimmedName);
  if (!looksCsvName) {
    const hex = head.toString("hex").padEnd(8, "0");
    return {
      ok: false,
      error:
        `tanınmayan ekstre biçimi (ilk baytlar: 0x${hex}); .xlsx için geçerli bir imza, ` +
        `CSV için .csv/.txt/.tsv, SWIFT için .mt940/.sta/.940 veya CAMT.053 için .xml uzantısı bekleniyor`,
      fileSize: buf.length,
    };
  }

  const csvResult = parseCsvStatementBuffer(buf);
  if (!csvResult.ok) {
    return { ok: false, error: csvResult.error, fileSize: buf.length, format: "csv" };
  }

  const sheet = buildWorksheetFromAoa(csvResult.rows);
  return {
    ok: true,
    workbook: {
      SheetNames: ["Sheet1"],
      Sheets: { Sheet1: sheet },
    },
    fileSize: buf.length,
    format: "csv",
  };
}
