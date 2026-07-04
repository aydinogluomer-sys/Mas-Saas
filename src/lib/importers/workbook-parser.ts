// Phase 0 spike — workbook safe-parse and sheet classification.
// Types mirror the `source_sheets.detected_type` / `parse_confidence` DB enums
// defined in implementation.md §8 exactly. Do not drift.

import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";

export type SheetDetectedType =
  | "loan_calculation"
  | "capacity"
  | "machine_roi"
  | "payment_day_matrix"
  | "checks"
  | "cost_model_normal"
  | "cost_model_overtime"
  | "monthly_cashflow"
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
  | { ok: true; workbook: XLSX.WorkBook; fileSize: number }
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

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 (xlsx)
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // legacy .xls

/**
 * Opens a workbook defensively. The corrupt upload we must support
 * (all-zero bytes) would otherwise be "parsed" by the promiscuous xlsx
 * fallbacks, so the file signature is checked explicitly first —
 * implementation.md §1.1: "does not expose a valid XLSX/ZIP signature".
 */
export function safeParseWorkbook(filePath: string): SafeParseResult {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `read failed: ${(e as Error).message}`, fileSize: 0 };
  }
  if (buf.length === 0) {
    return { ok: false, error: "empty file (0 bytes)", fileSize: 0 };
  }
  const head = buf.subarray(0, 4);
  if (!head.equals(ZIP_MAGIC) && !head.equals(CFB_MAGIC)) {
    const hex = head.toString("hex").padEnd(8, "0");
    return {
      ok: false,
      error: `no valid XLSX/ZIP signature (first bytes: 0x${hex}); file is not a parseable workbook`,
      fileSize: buf.length,
    };
  }
  try {
    const workbook = XLSX.read(buf, { type: "buffer", cellFormula: true, cellStyles: false });
    return { ok: true, workbook, fileSize: buf.length };
  } catch (e) {
    return { ok: false, error: `xlsx parse failed: ${(e as Error).message}`, fileSize: buf.length };
  }
}

/** Lists every sheet with classification. Guarantees no silent discard. */
export function listSheets(workbook: XLSX.WorkBook): SheetInfo[] {
  const out: SheetInfo[] = [];
  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const ws = workbook.Sheets[sheetName];
    const ref = ws && ws["!ref"] ? String(ws["!ref"]) : null;
    let rowCount = 0;
    let columnCount = 0;
    if (ref) {
      const r = XLSX.utils.decode_range(ref);
      rowCount = r.e.r - r.s.r + 1;
      columnCount = r.e.c - r.s.c + 1;
    }
    const cls = classifySheetName(sheetName);
    out.push({
      sheetIndex,
      sheetName,
      sheetNameNormalized: normalizeTr(sheetName),
      usedRange: ref,
      rowCount,
      columnCount,
      detectedType: cls.detectedType,
      parseConfidence: cls.parseConfidence,
    });
  });
  if (out.length !== workbook.SheetNames.length) {
    throw new Error(
      `silent discard detected: listed ${out.length} of ${workbook.SheetNames.length} sheets`,
    );
  }
  return out;
}
