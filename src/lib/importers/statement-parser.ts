// Faz 20 — bank statement parsing (CSV as well as XLSX).
//
// WHY A SEPARATE MODULE INSTEAD OF LOOSENING safeParseWorkbookBuffer. That function refuses
// anything without a ZIP or CFB magic number, and that refusal is a specified, tested
// behaviour: implementation.md §1.1 requires the all-zero-bytes upload to be rejected rather
// than "parsed" by the xlsx library's promiscuous fallbacks, and workbook-parser.test.ts pins
// it. Statements arrive as CSV often enough that they must be supported — but relaxing the
// magic-number check to allow it would silently re-open the corrupt-file hole for every
// workbook import in the app.
//
// So the workbook path is untouched, and CSV gets its own door with its own guard. A CSV is
// still refused when it is empty, contains NUL bytes (i.e. is really binary), or has no
// delimiter on any of its first lines — the same "fail loudly, never guess" posture.

import * as XLSX from "xlsx";
import { safeParseWorkbookBuffer, type SafeParseResult } from "./workbook-parser";

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

/** Bytes that no text export contains but every truncated/corrupt binary does. */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  return sample.includes(0x00);
}

/**
 * Strips a UTF-8 BOM.
 *
 * Turkish bank exports are frequently UTF-8 with BOM, and the BOM would otherwise become part
 * of the first header cell — turning "İşlem Tarihi" into "﻿İşlem Tarihi", which the
 * column detector would then fail to recognise. A one-character bug that costs a whole import.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Guess the delimiter from the header line.
 *
 * Turkish locale CSVs commonly use ';' precisely BECAUSE ',' is the decimal separator, so
 * assuming ',' would split "1.234,56" into two columns. Counting occurrences on the first
 * non-empty line picks the right one without a setting to forget.
 */
export function detectDelimiter(text: string): string | null {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "");
  if (!firstLine) return null;
  const counts: Array<[string, number]> = [
    [";", (firstLine.match(/;/g) ?? []).length],
    ["\t", (firstLine.match(/\t/g) ?? []).length],
    [",", (firstLine.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
}

export type StatementParseResult = SafeParseResult & { format?: "xlsx" | "csv" };

/**
 * Parse a statement upload.
 *
 * XLSX/XLS delegate to the existing, unchanged workbook parser. Everything else is attempted
 * as delimited text.
 */
export function safeParseStatementBuffer(buf: Buffer, filename: string): StatementParseResult {
  if (buf.length === 0) return { ok: false, error: "empty file (0 bytes)", fileSize: 0 };

  const head = buf.subarray(0, 4);
  if (head.equals(ZIP_MAGIC) || head.equals(CFB_MAGIC)) {
    return { ...safeParseWorkbookBuffer(buf), format: "xlsx" };
  }

  const looksCsvName = /\.(csv|txt|tsv)$/i.test(filename.trim());
  if (!looksCsvName) {
    const hex = head.toString("hex").padEnd(8, "0");
    return {
      ok: false,
      error:
        `tanınmayan ekstre biçimi (ilk baytlar: 0x${hex}); .xlsx/.xls için geçerli bir imza, ` +
        `CSV için .csv/.txt/.tsv uzantısı bekleniyor`,
      fileSize: buf.length,
    };
  }

  if (looksBinary(buf)) {
    return {
      ok: false,
      error: "CSV uzantılı ama ikili (NUL bayt) içerik — bozuk ya da yanlış adlandırılmış dosya",
      fileSize: buf.length,
    };
  }

  const text = stripBom(buf.toString("utf8"));
  if (text.trim() === "") return { ok: false, error: "CSV boş", fileSize: buf.length };

  const delimiter = detectDelimiter(text);
  if (!delimiter) {
    return {
      ok: false,
      error: "CSV ayırıcı bulunamadı (';', ',' veya sekme bekleniyor) — tek sütunlu bir ekstre okunamaz",
      fileSize: buf.length,
    };
  }

  try {
    // raw:false keeps every cell as its formatted string, which is what the statement rules
    // expect: they do the Turkish/English number and date disambiguation themselves and must
    // not receive values xlsx has already guessed at.
    const workbook = XLSX.read(text, { type: "string", FS: delimiter, raw: false });
    if (workbook.SheetNames.length === 0) {
      return { ok: false, error: "CSV ayrıştırıldı ama sayfa üretmedi", fileSize: buf.length };
    }
    return { ok: true, workbook, fileSize: buf.length, format: "csv" };
  } catch (e) {
    return { ok: false, error: `CSV ayrıştırma başarısız: ${(e as Error).message}`, fileSize: buf.length };
  }
}
