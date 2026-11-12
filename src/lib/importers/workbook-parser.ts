// Phase 0 / Faz 41 (B1) — workbook safe-parse and sheet classification via lazy ExcelJS + zip-guard.
// Types mirror the `source_sheets.detected_type` / `parse_confidence` DB enums
// defined in implementation.md §8 exactly. Do not drift.
//
// IMPORTANT (Perf Faz 7 invariant): NEVER add a top-level value `import ExcelJS from "exceljs"`.
// Only `import type ExcelJS from "exceljs"` is permitted at module top level; runtime loading MUST
// stay inside `safeParseWorkbookBuffer` via `await import("exceljs")`.

import { readFileSync } from "node:fs";
import type ExcelJS from "exceljs";
import {
  decodeRange,
  encodeCol,
  excelJsValueToCellVal,
  type ParsedWorkbook,
  type ParsedWorksheet,
} from "./row-utils";
import { inspectZipSafety } from "./zip-guard";

export const MAX_WORKBOOK_CELLS = 200_000;

export type SheetDetectedType =
  | "loan_calculation"
  | "capacity"
  | "machine_roi"
  | "payment_day_matrix"
  | "checks"
  | "cost_model_normal"
  | "cost_model_overtime"
  | "monthly_cashflow"
  | "bank_statement"
  | "standard_import_v2"
  | "unknown";

export type ParseConfidence = "high" | "medium" | "low" | "unknown";

export interface SheetInfo {
  sheetIndex: number;
  sheetName: string;
  sheetNameNormalized: string;
  usedRange: string | null;
  rowCount: number;
  columnCount: number;
  detectedType: SheetDetectedType;
  parseConfidence: ParseConfidence;
}

export type SafeParseResult =
  | { ok: true; workbook: ParsedWorkbook; fileSize: number }
  | { ok: false; error: string; fileSize: number };

/**
 * Turkish-aware lowercase normalization. `String.prototype.toLowerCase`
 * mishandles dotted/dotless I for Turkish sheet names (İ→i̇, I→i), so we
 * map the two problem uppercase letters explicitly first.
 */
export function normalizeTr(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .trim();
}

const TR_MONTHS = [
  "ocak", "şubat", "mart", "nisan", "mayıs", "haziran",
  "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık",
] as const;

export function isMonthlyCashflowName(nameNormalized: string): boolean {
  const hasMonth = TR_MONTHS.some((m) => nameNormalized.includes(m));
  const hasYear = /\b20\d{2}\b/.test(nameNormalized);
  return hasMonth && hasYear;
}

/**
 * Name-based classification. Order matters: the overtime cost model name
 * (`maliyet-mastechnicmesaili`) contains the normal model name as a prefix,
 * so `mesaili` must be tested first. "tablo" is a generic word, so it only
 * gets medium confidence and only on exact match.
 * Rule: never silently discard — anything unmatched is `unknown`, listed.
 */
export function classifySheetName(rawName: string): {
  detectedType: SheetDetectedType;
  parseConfidence: ParseConfidence;
} {
  const n = normalizeTr(rawName);
  if (n.includes("faiz")) return { detectedType: "loan_calculation", parseConfidence: "high" };
  if (n.includes("çek")) return { detectedType: "checks", parseConfidence: "high" };
  if (n.includes("ödeme")) return { detectedType: "payment_day_matrix", parseConfidence: "high" };
  if (n.includes("kapasite")) return { detectedType: "capacity", parseConfidence: "high" };
  if (n.includes("maliyet") && n.includes("mesaili"))
    return { detectedType: "cost_model_overtime", parseConfidence: "high" };
  if (n.includes("maliyet")) return { detectedType: "cost_model_normal", parseConfidence: "high" };
  if (n === "tablo") return { detectedType: "machine_roi", parseConfidence: "medium" };
  if (isMonthlyCashflowName(n)) return { detectedType: "monthly_cashflow", parseConfidence: "high" };
  return { detectedType: "unknown", parseConfidence: "unknown" };
}

function convertExcelJsWorkbook(
  wb: ExcelJS.Workbook,
  maxCells: number = MAX_WORKBOOK_CELLS,
): ParsedWorkbook {
  const SheetNames: string[] = [];
  const Sheets: Record<string, ParsedWorksheet> = {};
  let totalCells = 0;

  for (const ws of wb.worksheets) {
    SheetNames.push(ws.name);
    const parsedSheet: ParsedWorksheet = {};
    let minR = Number.POSITIVE_INFINITY;
    let minC = Number.POSITIVE_INFINITY;
    let maxR = -1;
    let maxC = -1;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;

        let cellText: string | null = null;
        try {
          cellText = cell.text ?? null;
        } catch {
          cellText = null;
        }
        const converted = excelJsValueToCellVal(cell.value, cell.formula ?? null, cellText);
        if (!converted) return;

        totalCells += 1;
        if (totalCells > maxCells) {
          throw new Error(
            `Çalışma kitabı hücre tavanını aşıyor (${totalCells} > ${maxCells} hücre).`,
          );
        }

        const r0 = rowNumber - 1;
        const c0 = colNumber - 1;
        const addr = cell.address || `${encodeCol(c0)}${rowNumber}`;
        parsedSheet[addr] = converted;

        if (r0 < minR) minR = r0;
        if (c0 < minC) minC = c0;
        if (r0 > maxR) maxR = r0;
        if (c0 > maxC) maxC = c0;
      });
    });

    if (maxR >= 0 && maxC >= 0) {
      parsedSheet["!ref"] = `${encodeCol(minC)}${minR + 1}:${encodeCol(maxC)}${maxR + 1}`;
    }
    Sheets[ws.name] = parsedSheet;
  }

  return { SheetNames, Sheets };
}

/**
 * Opens a workbook defensively using `inspectZipSafety` + lazy `ExcelJS`.
 */
export async function safeParseWorkbook(filePath: string): Promise<SafeParseResult> {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}`, fileSize: 0 };
  }
  return safeParseWorkbookBuffer(buf);
}

export async function safeParseWorkbookBuffer(
  buf: Buffer,
  options?: { maxCells?: number; maxUncompressedBytes?: number; maxEntries?: number },
): Promise<SafeParseResult> {
  const safety = inspectZipSafety(buf, {
    maxUncompressedBytes: options?.maxUncompressedBytes,
    maxEntries: options?.maxEntries,
  });
  if (!safety.ok) {
    return {
      ok: false,
      error: safety.error,
      fileSize: buf.length,
    };
  }

  try {
    const { default: ExcelJSRuntime } = await import("exceljs");
    const wb = new ExcelJSRuntime.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const workbook = convertExcelJsWorkbook(wb, options?.maxCells ?? MAX_WORKBOOK_CELLS);
    return { ok: true, workbook, fileSize: buf.length };
  } catch (e) {
    return { ok: false, error: `xlsx parse failed: ${(e as Error).message}`, fileSize: buf.length };
  }
}

/** Lists every sheet with classification. Guarantees no silent discard. */
export function listSheets(workbook: ParsedWorkbook): SheetInfo[] {
  const out: SheetInfo[] = [];
  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const ws = workbook.Sheets[sheetName];
    const ref = ws && ws["!ref"] ? String(ws["!ref"]) : null;
    let rowCount = 0;
    let columnCount = 0;
    if (ref) {
      const r = decodeRange(ref);
      rowCount = r.e.r - r.s.r + 1;
      columnCount = r.e.c - r.s.c + 1;
    }
    const { detectedType, parseConfidence } = classifySheetName(sheetName);
    out.push({
      sheetIndex,
      sheetName,
      sheetNameNormalized: normalizeTr(sheetName),
      usedRange: ref,
      rowCount,
      columnCount,
      detectedType,
      parseConfidence,
    });
  });
  return out;
}
