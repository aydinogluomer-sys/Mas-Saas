// Cell/row utilities shared by the importer and extractors.
// Faz 41 (B1): 100% SheetJS (`xlsx`) free; works over pure `ParsedWorksheet` maps or `ExcelJS.Worksheet`.

import { createHash } from "node:crypto";
import type ExcelJS from "exceljs";
import { formulaErrorToken } from "./v2/values";

/** One preserved cell as stored in row_json / source_cells. */
export interface CellVal {
  v: string | number | boolean; // raw value (cached formula result, or error token when t === "e")
  t: "n" | "s" | "b" | "d" | "e" | "z"; // cell type ("e" = Excel formula error; NEVER coerced to number/date!)
  f?: string; // formula text, if any
  w?: string; // formatted text, if any
}

/** SheetJS-shaped dictionary produced by ExcelJS & CSV adapters (`ws["!ref"]`, `ws["A1"]`). */
export interface ParsedWorksheet {
  "!ref"?: string;
  [address: string]: CellVal | string | undefined;
}

export interface ParsedWorkbook {
  SheetNames: string[];
  Sheets: Record<string, ParsedWorksheet>;
}

export type RowJson = Record<string, CellVal>; // key = column letter
export interface SheetRow {
  rowIndex: number; // 1-based, as in Excel
  cells: RowJson;
}

/**
 * Turkish-aware lowercase normalization. `String.prototype.toLowerCase`
 * mishandles dotted/dotless I for Turkish sheet names (İ→i̇, I→i).
 */
function normalizeTrLocal(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "ı")
    .toLowerCase()
    .trim();
}

/** 0-based column index → Excel column letters (0 -> "A", 1 -> "B", 26 -> "AA"). */
export function encodeCol(col0: number): string {
  let n = col0 + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel A1 cell address → 0-based { r, c } coordinates. */
export function decodeCell(address: string): { r: number; c: number } {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(address.trim());
  if (!m) throw new Error(`Geçersiz hücre adresi: ${address}`);
  const letters = m[1]!.toUpperCase();
  let c = 0;
  for (let i = 0; i < letters.length; i++) {
    c = c * 26 + (letters.charCodeAt(i) - 64);
  }
  return { r: Number(m[2]) - 1, c: c - 1 };
}

/** Excel A1 range ("A1:AG45" or "A1") → 0-based start/end coordinates. */
export function decodeRange(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const [start, end] = ref.split(":");
  const s = decodeCell(start!);
  const e = end ? decodeCell(end) : { ...s };
  return { s, e };
}

/** JS UTC Date → Excel 1900 serial number (1899-12-30 epoch). */
export function dateToExcelSerial(d: Date): number {
  const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30);
  const secOfDay =
    d.getUTCHours() * 3600 +
    d.getUTCMinutes() * 60 +
    d.getUTCSeconds() +
    d.getUTCMilliseconds() / 1000;
  return Math.round(dayMs / 86400000) + (secOfDay > 0 ? secOfDay / 86400 : 0);
}

/** Converts an ExcelJS cell value into a preserved `CellVal` (or `null` when truly empty). */
export function excelJsValueToCellVal(rawVal: unknown, cellFormula?: string | null, cellText?: string | null): CellVal | null {
  if (rawVal === null || rawVal === undefined) return null;

  let formula: string | undefined = cellFormula ? String(cellFormula) : undefined;
  let value: unknown = rawVal;

  if (typeof value === "object" && !(value instanceof Date) && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.formula === "string" && !formula) {
      formula = obj.formula;
    }
    if (typeof obj.sharedFormula === "string" && !formula) {
      formula = obj.sharedFormula;
    }
  }

  // Formula error check BEFORE any unwrap/number/date coercion!
  // Prevents SheetJS's infamous `#REF! -> 0x17 (23 -> 23,00 TL / 1900-01-22)` corruption.
  const errToken = formulaErrorToken(rawVal);
  if (errToken) {
    const cell: CellVal = { v: errToken, t: "e", w: errToken };
    if (formula) cell.f = formula;
    return cell;
  }

  if (typeof value === "object" && !(value instanceof Date) && value !== null) {
    const obj = value as Record<string, unknown>;
    if ("result" in obj) {
      value = obj.result;
    } else if (Array.isArray(obj.richText)) {
      value = obj.richText
        .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
        .join("");
    } else if (typeof obj.text === "string") {
      value = obj.text;
    } else if ("hyperlink" in obj && obj.text !== undefined) {
      value = String(obj.text ?? "");
    }
  }

  if (value === null || value === undefined) {
    if (formula) {
      // Formula without cached result: preserve formula lineage without inventing 0.
      return { v: "", t: "z", f: formula };
    }
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const serial = dateToExcelSerial(value);
    const cell: CellVal = { v: serial, t: "n", w: value.toISOString().slice(0, 10) };
    if (formula) cell.f = formula;
    return cell;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const cell: CellVal = { v: value, t: "n" };
    if (formula) cell.f = formula;
    if (cellText && cellText !== String(value)) cell.w = cellText;
    return cell;
  }

  if (typeof value === "boolean") {
    const cell: CellVal = { v: value, t: "b" };
    if (formula) cell.f = formula;
    return cell;
  }

  const str = String(value);
  if (str === "" && !formula) return null;
  const cell: CellVal = { v: str, t: "s" };
  if (formula) cell.f = formula;
  return cell;
}

/** Pure helper converting a 2D array of values into a `ParsedWorksheet` (used by CSV parser & unit tests). */
export function buildWorksheetFromAoa(
  rows: readonly (readonly (string | number | boolean | Date | null | undefined)[])[],
  options?: { preserveEmptyStrings?: boolean },
): ParsedWorksheet {
  const ws: ParsedWorksheet = {};
  let minR = Number.POSITIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let maxR = -1;
  let maxC = -1;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const raw = row[c];
      if (raw === null || raw === undefined) continue;
      if (raw === "" && !options?.preserveEmptyStrings) continue;

      const cell =
        raw === ""
          ? ({ v: "", t: "s" } satisfies CellVal)
          : excelJsValueToCellVal(raw);
      if (!cell) continue;

      const addr = `${encodeCol(c)}${r + 1}`;
      ws[addr] = cell;
      if (r < minR) minR = r;
      if (c < minC) minC = c;
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
  }

  if (maxR >= 0 && maxC >= 0) {
    ws["!ref"] = `${encodeCol(minC)}${minR + 1}:${encodeCol(maxC)}${maxR + 1}`;
  }
  return ws;
}

function isExcelJsWorksheet(ws: ParsedWorksheet | ExcelJS.Worksheet): ws is ExcelJS.Worksheet {
  return typeof (ws as ExcelJS.Worksheet).eachRow === "function";
}

/** Iterates every populated cell of a worksheet (`ParsedWorksheet` or `ExcelJS.Worksheet`). No silent discard. */
export function sheetCells(
  ws: ParsedWorksheet | ExcelJS.Worksheet | undefined,
): Array<{ address: string; rowIndex: number; columnIndex: number; cell: CellVal }> {
  const out: Array<{ address: string; rowIndex: number; columnIndex: number; cell: CellVal }> = [];
  if (!ws) return out;

  if (isExcelJsWorksheet(ws)) {
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (c, colNumber) => {
        if (c.isMerged && c.master.address !== c.address) return;
        let cellText: string | null = null;
        try {
          cellText = c.text ?? null;
        } catch {
          cellText = null;
        }
        const converted = excelJsValueToCellVal(c.value, c.formula ?? null, cellText);
        if (!converted) return;
        const address = c.address || `${encodeCol(colNumber - 1)}${rowNumber}`;
        out.push({ address, rowIndex: rowNumber, columnIndex: colNumber, cell: converted });
      });
    });
    return out;
  }

  for (const address of Object.keys(ws)) {
    if (address.startsWith("!")) continue;
    const raw = ws[address];
    if (!raw || typeof raw !== "object") continue;
    if (raw.v === undefined || raw.v === null) continue;
    if (raw.v === "" && raw.t !== "z" && !raw.f) continue;
    const { r, c } = decodeCell(address);
    const cell: CellVal = { v: raw.v, t: raw.t ?? "z" };
    if (raw.f) cell.f = String(raw.f);
    if (raw.w) cell.w = String(raw.w);
    out.push({ address, rowIndex: r + 1, columnIndex: c + 1, cell });
  }
  return out;
}

export function cellsToRows(cells: ReturnType<typeof sheetCells>): SheetRow[] {
  const byRow = new Map<number, RowJson>();
  for (const { rowIndex, columnIndex, cell } of cells) {
    const col = encodeCol(columnIndex - 1);
    let row = byRow.get(rowIndex);
    if (!row) {
      row = {};
      byRow.set(rowIndex, row);
    }
    row[col] = cell;
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rowIndex, cells]) => ({ rowIndex, cells }));
}

/** address → cell map, for anchor-cell extraction (monthly sheets, faiz). */
export function cellsToMap(cells: ReturnType<typeof sheetCells>): Record<string, CellVal> {
  const m: Record<string, CellVal> = {};
  for (const { address, cell } of cells) m[address] = cell;
  return m;
}

export function hashRow(row: RowJson): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex").slice(0, 32);
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Excel serial date → ISO (1899-12-30 base; uses floor+second rounding so noon timestamps never jump to tomorrow). */
export function serialToISO(serial: number): string {
  const wholeDays = Math.floor(serial);
  const fracSeconds = Math.round((serial - wholeDays) * 86400);
  const extraDays = Math.floor(fracSeconds / 86400);
  const d = new Date(Date.UTC(1899, 11, 30) + (wholeDays + extraDays) * 86400000);
  return d.toISOString().slice(0, 10);
}

const TR_MONTH_INDEX: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

/** "ŞUBAT 2028" → "2028-02-01". Returns null when not a month sheet name. */
export function monthSheetNameToISO(sheetName: string): string | null {
  const n = normalizeTrLocal(sheetName);
  const year = n.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  for (const [name, idx] of Object.entries(TR_MONTH_INDEX)) {
    if (n.includes(name)) return `${year}-${String(idx).padStart(2, "0")}-01`;
  }
  return null;
}

export function isFormulaErrorCell(c: CellVal | undefined): boolean {
  if (!c) return false;
  if (c.t === "e") return true;
  if (typeof c.v === "string" && formulaErrorToken(c.v) !== null) return true;
  return false;
}

export function asNumber(c: CellVal | undefined): number | null {
  if (!c) return null;
  if (isFormulaErrorCell(c)) return null;
  if (typeof c.v === "number") return Number.isFinite(c.v) ? c.v : null;
  if (typeof c.v === "string") {
    const trimmed = c.v.trim();
    if (!trimmed) return null;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(trimmed.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asText(c: CellVal | undefined): string | null {
  if (!c) return null;
  if (isFormulaErrorCell(c)) return null;
  return String(c.v).trim() || null;
}
