// Faz 20 / Faz 41 (B1) — bank statement parsing (.xlsx via zip-guard + lazy ExcelJS, .csv via RFC-4180 csv-parser).

import { detectCsvDelimiter, parseCsvStatementBuffer } from "./csv-parser";
import { buildWorksheetFromAoa } from "./row-utils";
import { safeParseWorkbookBuffer, type SafeParseResult } from "./workbook-parser";

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export function detectDelimiter(text: string): string | null {
  return detectCsvDelimiter(text);
}

export type StatementParseResult = SafeParseResult & { format?: "xlsx" | "csv" };

/**
 * Parse a bank statement upload (.xlsx or .csv/.txt/.tsv).
 *
 * Legacy binary `.xls` (CFB_MAGIC) is explicitly rejected by `safeParseWorkbookBuffer` / `inspectZipSafety`.
 * Explicit `"0,00"` cells in CSV are preserved verbatim as string `"0,00"`, never coerced to `null`.
 */
export async function safeParseStatementBuffer(
  buf: Buffer,
  filename: string,
): Promise<StatementParseResult> {
  if (buf.length === 0) return { ok: false, error: "empty file (0 bytes)", fileSize: 0 };

  const head = buf.subarray(0, Math.min(4, buf.length));
  if (head.length === 4 && (head.equals(ZIP_MAGIC) || head.equals(CFB_MAGIC))) {
    const parsed = await safeParseWorkbookBuffer(buf);
    return { ...parsed, format: "xlsx" };
  }

  const looksCsvName = /\.(csv|txt|tsv)$/i.test(filename.trim());
  if (!looksCsvName) {
    const hex = head.toString("hex").padEnd(8, "0");
    return {
      ok: false,
      error:
        `tanınmayan ekstre biçimi (ilk baytlar: 0x${hex}); .xlsx için geçerli bir imza, ` +
        `CSV için .csv/.txt/.tsv uzantısı bekleniyor`,
      fileSize: buf.length,
    };
  }

  const csvResult = parseCsvStatementBuffer(buf);
  if (!csvResult.ok) {
    return { ok: false, error: csvResult.error, fileSize: buf.length };
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
