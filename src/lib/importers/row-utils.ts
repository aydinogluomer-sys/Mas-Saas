// Cell/row utilities shared by the importer and extractors.
// Design: keep everything pure so Phase 2 logic is unit-testable without a DB.

import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { normalizeTr } from "./workbook-parser";

/** One preserved cell as stored in row_json / source_cells. */
export interface CellVal {
  v: string | number | boolean; // raw value (xlsx cached value for formulas)
  t: "n" | "s" | "b" | "d" | "e" | "z"; // xlsx type
  f?: string; // formula, if any
  w?: string; // formatted text, if any
}

export type RowJson = Record<string, CellVal>; // key = column letter
export interface SheetRow {
  rowIndex: number; // 1-based, as in Excel
  cells: RowJson;
}

/** Iterates every populated cell of a worksheet. No silent discard. */
export function sheetCells(
  ws: XLSX.WorkSheet,
): Array<{ address: string; rowIndex: number; columnIndex: number; cell: CellVal }> {
  const out: Array<{ address: string; rowIndex: number; columnIndex: number; cell: CellVal }> = [];
  for (const address of Object.keys(ws)) {
    if (address.startsWith("!")) continue;
    const raw = ws[address] as XLSX.CellObject;
    if (raw == null || raw.v === undefined || raw.v === null) continue;
    const { r, c } = XLSX.utils.decode_cell(address);
    const cell: CellVal = { v: raw.v as CellVal["v"], t: (raw.t ?? "z") as CellVal["t"] };
    if (raw.f) cell.f = String(raw.f);
    if (raw.w) cell.w = String(raw.w);
    out.push({ address, rowIndex: r + 1, columnIndex: c + 1, cell });
  }
  return out;
}

export function cellsToRows(cells: ReturnType<typeof sheetCells>): SheetRow[] {
  const byRow = new Map<number, RowJson>();
  for (const { rowIndex, columnIndex, cell } of cells) {
    const col = XLSX.utils.encode_col(columnIndex - 1);
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

/** Excel serial date → ISO (1899-12-30 base, matches this workbook's values). */
export function serialToISO(serial: number): string {
  const ms = Math.round(serial) * 86400000;
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return d.toISOString().slice(0, 10);
}

const TR_MONTH_INDEX: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
};

/** "ŞUBAT 2028" → "2028-02-01". Returns null when not a month sheet name. */
export function monthSheetNameToISO(sheetName: string): string | null {
  const n = normalizeTr(sheetName);
  const year = n.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  for (const [name, idx] of Object.entries(TR_MONTH_INDEX)) {
    if (n.includes(name)) return `${year}-${String(idx).padStart(2, "0")}-01`;
  }
  return null;
}

export function asNumber(c: CellVal | undefined): number | null {
  if (!c) return null;
  if (typeof c.v === "number") return c.v;
  if (typeof c.v === "string") {
    const n = Number(c.v.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asText(c: CellVal | undefined): string | null {
  if (!c) return null;
  return String(c.v).trim() || null;
}
