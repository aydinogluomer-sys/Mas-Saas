// Faz 60 (M-61): 3 Adımlı Etkileşimli Kolon Eşleştirme Sihirbazı (.xlsx ve .csv) motoru.
//
// Hem standart çok-sayfalı V2 `.xlsx` şablonlarını hem de dış sistemlerden (ERP, banka ekstresi,
// serbest Excel / CSV çıktısı) gelen `.xlsx` ve `.csv` dosyalarını tek bir deterministik boru
// hattında buluşturur:
//   1. Dosya Yükle (.xlsx / .csv)
//   2. Kolon Eşleştirme & Otomatik Başlık Tanıma
//   3. Satır Önizleme & Atomik Kayıt (previewImport -> confirmImport)

import path from "node:path";
import type ExcelJS from "exceljs";
import {
  DATA_SHEETS,
  META_SHEET,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  TEMPLATE_ID,
  TEMPLATE_VERSION,
  normalizeHeader,
  sheetByName,
  type ColumnSpec,
  type SheetSpec,
} from "./contract";
import { detectSchema } from "./parser";
import { openWorkbook, safeFilename, UPLOAD_LIMITS, type Rejection } from "./service";
import { canonicalizeZipTimestamps } from "./zip-canonical";

export const WIZARD_ALLOWED_EXTENSIONS = [".xlsx", ".csv"] as const;

export interface TargetColumnOption {
  key: string;
  header: string;
  required: boolean;
  type: ColumnSpec["type"];
}

export interface TargetSheetOption {
  name: string;
  title: string;
  domainTable: string | null;
  columns: TargetColumnOption[];
}

export interface SourceColumnInspection {
  colIndex: number; // 0-based index in parsed CSV/XLSX row
  rawHeader: string;
  sampleValues: string[];
  suggestedKey: string | null;
  matchKind: "exact_contract" | "synonym" | "unmatched";
}

export interface WizardInspectionResult {
  mode: "canonical_v2" | "interactive_mapping";
  filename: string;
  bytes: number;
  ext: ".xlsx" | ".csv";
  sourceSheets: string[];
  selectedSourceSheet: string;
  targetV2Sheet: string;
  totalDataRows: number;
  columns: SourceColumnInspection[];
  sampleRows: string[][];
  targetSheetOptions: TargetSheetOption[];
  canonicalSheetSummary?: Array<{
    sheet: string;
    title: string;
    rowsRead: number;
    matchedHeaders: number;
    unknownHeaders: string[];
  }>;
}

const SYNONYM_HINTS: Readonly<Record<string, readonly string[]>> = {
  external_id: ["external id", "kayıt no", "kayit no", "fiş no", "fis no", "evrak kodu", "ref id"],
  fatura_tipi: ["fatura türü", "fatura turu", "yön", "yon", "alis/satis", "alış/satış", "direction"],
  fatura_no: ["fatura numarası", "fatura numarasi", "belge no", "evrak no", "ettn", "gib no"],
  duzenleme_tarihi: ["fatura tarihi", "belge tarihi", "düzenlenme tarihi", "issue date", "evrak tarihi"],
  vade_tarihi: ["vade", "son ödeme", "son odeme", "maturity", "due date", "ödeme vadesi"],
  karsi_taraf: ["cari", "cari adı", "cari adi", "ünvan", "unvan", "müşteri/tedarikçi", "firma adı", "party"],
  net_tutar: ["matrah", "kdv hariç", "kdv haric", "ara toplam", "net amount", "subtotal"],
  vergi_tutari: ["kdv", "kdv tutarı", "kdv tutari", "vergi", "tax", "vat"],
  toplam_tutar: ["genel toplam", "kdv dahil", "brüt tutar", "brut tutar", "fatura tutarı", "gross", "total"],
  para_birimi: ["döviz cinsi", "doviz cinsi", "pb", "curr", "ccy", "döviz kodu"],
  seri_no: ["çek no", "cek no", "senet no", "evrak seri", "portföy no"],
  signed_tutar: ["çek tutarı", "cek tutari", "net çek", "isaretli tutar"],
  islem_tarihi: ["hareket tarihi", "işlem trh", "tarih/saat", "booking date"],
  aciklama: ["işlem açıklaması", "islem aciklamasi", "izahat", "detay", "memo"],
  tutar: ["işlem tutarı", "meblağ", "meblag", "ödeme tutarı", "tahsilat tutarı"],
  anapara: ["kredi tutarı", "ana para", "principal"],
  sku: ["ürün kodu", "urun kodu", "malzeme kodu", "item code"],
  urun_adi: ["malzeme adı", "stok adı", "item name", "product name"],
  standart_maliyet: ["birim maliyet", "maliyet", "unit cost", "alis fiyati"],
  satis_fiyati: ["birim fiyat", "liste fiyatı", "unit price", "price"],
  siparis_no: ["sipariş kodu", "order code", "po number"],
  siparis_tarihi: ["order date", "sipariş trh"],
  beklenen_tarih: ["teslim tarihi", "termin", "delivery date"],
  sozlesme_degeri: ["kontrat bedeli", "proje tutarı", "contract value"],
  butce_maliyeti: ["hedef maliyet", "planlanan bütçe", "budget cost"],
};

function normToken(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[_\-./()[\]]+/g, " ")
    .replace(/\s+/g, " ");
}

export function autoMatchHeaderToColumn(
  spec: SheetSpec,
  rawHeader: string,
): { key: string | null; kind: "exact_contract" | "synonym" | "unmatched" } {
  const exact = normalizeHeader(spec, rawHeader);
  if (exact) return { key: exact, kind: "exact_contract" };

  const norm = normToken(rawHeader);
  if (!norm) return { key: null, kind: "unmatched" };

  for (const col of spec.columns) {
    const hints = SYNONYM_HINTS[col.key];
    if (!hints) continue;
    for (const h of hints) {
      if (norm === normToken(h) || norm.includes(normToken(h))) {
        return { key: col.key, kind: "synonym" };
      }
    }
  }
  return { key: null, kind: "unmatched" };
}

export function guessTargetV2Sheet(filename: string, headers: string[]): string {
  const fn = filename.toLocaleLowerCase("tr-TR");
  if (/fatura|invoice|efatura|earsiv/.test(fn)) return "08_FATURALAR";
  if (/cek|çek|senet/.test(fn)) return "02_CEKLER";
  if (/ekstre|hareket|statement/.test(fn)) return "07_BANKA_HAREKETLERI";
  if (/hesap|iban/.test(fn)) return "06_BANKA_HESAPLARI";
  if (/kredi_limit|limit|rotatif|bch|kmh/.test(fn)) return "17_KREDI_LIMITLERI";
  if (/taksit|installment/.test(fn)) return "04_KREDI_TAKSITLERI";
  if (/kredi|loan/.test(fn)) return "03_KREDILER";
  if (/siparis|sipariş|order/.test(fn)) return "09_SIPARISLER";
  if (/urun|ürün|stok|product/.test(fn)) return "10_URUNLER";
  if (/proje|project/.test(fn)) return "11_PROJELER";
  if (/butce|bütçe|budget/.test(fn)) return "12_BUTCE";
  if (/nakit|cashflow/.test(fn)) return "05_NAKIT_AKISI";
  if (/odeme|ödeme|payment/.test(fn)) return "01_ODEMELER";

  // Header score fallback: pick the sheet whose columns match the most headers
  let bestSheet = "08_FATURALAR";
  let bestScore = -1;
  for (const spec of DATA_SHEETS) {
    let score = 0;
    for (const h of headers) {
      const m = autoMatchHeaderToColumn(spec, h);
      if (m.kind === "exact_contract") score += 3;
      else if (m.kind === "synonym") score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSheet = spec.name;
    }
  }
  return bestSheet;
}

/**
 * Deterministic RFC-4180 CSV parser with automatic delimiter detection (`;`, `,`, `\t`).
 */
export function parseCsvBuffer(buf: Buffer): { headers: string[]; rows: string[][] } {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text;

  const countOutsideQuotes = (line: string, ch: string): number => {
    let inQuotes = false;
    let n = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && c === ch) n++;
    }
    return n;
  };

  const semi = countOutsideQuotes(firstLine, ";");
  const comma = countOutsideQuotes(firstLine, ",");
  const tab = countOutsideQuotes(firstLine, "\t");
  const delim = tab > semi && tab > comma ? "\t" : semi >= comma && semi > 0 ? ";" : ",";

  const allRows: string[][] = [];
  let curRow: string[] = [];
  let curCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          curCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        curCell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      curRow.push(curCell.trim());
      curCell = "";
    } else if (ch === "\n") {
      curRow.push(curCell.trim());
      curCell = "";
      if (curRow.some((c) => c !== "")) {
        allRows.push(curRow);
      }
      curRow = [];
    } else {
      curCell += ch;
    }
  }
  if (curCell !== "" || curRow.length > 0) {
    curRow.push(curCell.trim());
    if (curRow.some((c) => c !== "")) {
      allRows.push(curRow);
    }
  }

  if (allRows.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = allRows;
  return { headers, rows };
}

function cellToDisplayString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined && v.result !== null) {
      return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result);
    }
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("error" in v && typeof v.error === "string") return v.error;
    return "";
  }
  return String(v).trim();
}

export function listTargetSheetOptions(): TargetSheetOption[] {
  return DATA_SHEETS.map((s) => ({
    name: s.name,
    title: s.title,
    domainTable: s.domainTable,
    columns: s.columns.map((c) => ({
      key: c.key,
      header: c.header,
      required: c.required,
      type: c.type,
    })),
  }));
}

export function validateWizardUploadMeta(input: { name: string; size: number }): Rejection | null {
  const fn = safeFilename(input.name);
  if (!fn.ok) {
    return {
      code: "UNSAFE_FILENAME",
      message: "Dosya adı kabul edilmedi. Dosyayı yeniden adlandırıp tekrar yükleyin.",
      detail: fn.reason,
    };
  }
  const ext = path.extname(fn.name).toLowerCase();
  if (!WIZARD_ALLOWED_EXTENSIONS.includes(ext as ".xlsx" | ".csv")) {
    return {
      code: "BAD_EXTENSION",
      message: "Yalnız .xlsx ve .csv dosyaları kabul edilir.",
      detail: `uzantı: ${ext || "(yok)"}`,
    };
  }
  if (input.size <= 0) return { code: "EMPTY_FILE", message: "Dosya boş.", detail: `${input.size} bayt` };
  if (input.size > UPLOAD_LIMITS.maxBytes) {
    return {
      code: "TOO_LARGE",
      message: "Dosya 50 MB sınırını aşıyor.",
      detail: `${input.size} bayt`,
    };
  }
  return null;
}

export async function inspectFileForColumnWizard(
  buf: Buffer,
  filename: string,
  opts: { preferredSourceSheet?: string; preferredTargetV2Sheet?: string } = {},
): Promise<{ ok: true; inspection: WizardInspectionResult } | { ok: false; rejection: Rejection }> {
  const metaErr = validateWizardUploadMeta({ name: filename, size: buf.length });
  if (metaErr) return { ok: false, rejection: metaErr };

  const ext = path.extname(filename).toLowerCase() as ".xlsx" | ".csv";
  const targetOptions = listTargetSheetOptions();

  if (ext === ".csv") {
    const { headers, rows } = parseCsvBuffer(buf);
    if (headers.length === 0) {
      return {
        ok: false,
        rejection: { code: "EMPTY_FILE", message: "CSV dosyasında başlık satırı bulunamadı." },
      };
    }
    if (rows.length > UPLOAD_LIMITS.maxRows) {
      return {
        ok: false,
        rejection: {
          code: "TOO_MANY_ROWS",
          message: `CSV dosyasında ${rows.length.toLocaleString("tr-TR")} satır var; sınır 100.000.`,
        },
      };
    }
    const targetSheet =
      opts.preferredTargetV2Sheet && sheetByName(opts.preferredTargetV2Sheet)
        ? opts.preferredTargetV2Sheet
        : guessTargetV2Sheet(filename, headers);
    const spec = sheetByName(targetSheet)!;
    const usedKeys = new Set<string>();
    const columns: SourceColumnInspection[] = headers.map((h, idx) => {
      const m = autoMatchHeaderToColumn(spec, h);
      const suggested = m.key && !usedKeys.has(m.key) ? m.key : null;
      if (suggested) usedKeys.add(suggested);
      return {
        colIndex: idx,
        rawHeader: h || `Sütun_${idx + 1}`,
        sampleValues: rows.slice(0, 3).map((r) => r[idx] ?? "").filter((x) => x !== ""),
        suggestedKey: suggested,
        matchKind: suggested ? m.kind : "unmatched",
      };
    });

    return {
      ok: true,
      inspection: {
        mode: "interactive_mapping",
        filename,
        bytes: buf.length,
        ext: ".csv",
        sourceSheets: ["CSV_VERI"],
        selectedSourceSheet: "CSV_VERI",
        targetV2Sheet: targetSheet,
        totalDataRows: rows.length,
        columns,
        sampleRows: rows.slice(0, 5),
        targetSheetOptions: targetOptions,
      },
    };
  }

  // .xlsx path
  const opened = await openWorkbook(buf);
  if (!opened.ok) return opened;
  const wb = opened.wb;
  const schema = detectSchema(wb);

  if (schema.detected) {
    const summary: NonNullable<WizardInspectionResult["canonicalSheetSummary"]> = [];
    let totalRows = 0;
    for (const spec of DATA_SHEETS) {
      const ws = wb.getWorksheet(spec.name);
      if (!ws) continue;
      const row1 = ws.getRow(1);
      let matched = 0;
      const unknown: string[] = [];
      row1.eachCell({ includeEmpty: false }, (cell) => {
        const txt = cellToDisplayString(cell.value);
        if (!txt) return;
        if (normalizeHeader(spec, txt)) matched++;
        else unknown.push(txt);
      });
      const dataRows = Math.max(0, ws.actualRowCount - 1);
      if (dataRows > 0 || unknown.length > 0) {
        totalRows += dataRows;
        summary.push({
          sheet: spec.name,
          title: spec.title,
          rowsRead: dataRows,
          matchedHeaders: matched,
          unknownHeaders: unknown,
        });
      }
    }

    const firstSheetName = summary[0]?.sheet ?? DATA_SHEETS[0].name;
    const firstWs = wb.getWorksheet(firstSheetName);
    const firstSpec = sheetByName(firstSheetName)!;
    const headers: string[] = [];
    const sampleRows: string[][] = [];
    if (firstWs) {
      const maxCol = Math.min(firstWs.columnCount || firstSpec.columns.length, 40);
      const r1 = firstWs.getRow(1);
      for (let c = 1; c <= maxCol; c++) {
        headers.push(cellToDisplayString(r1.getCell(c).value) || `Sütun_${c}`);
      }
      firstWs.eachRow({ includeEmpty: false }, (row, rn) => {
        if (rn === 1 || sampleRows.length >= 5) return;
        const vals: string[] = [];
        for (let c = 1; c <= maxCol; c++) vals.push(cellToDisplayString(row.getCell(c).value));
        if (vals.some((x) => x !== "")) sampleRows.push(vals);
      });
    }

    const columns: SourceColumnInspection[] = headers.map((h, idx) => {
      const k = normalizeHeader(firstSpec, h);
      return {
        colIndex: idx,
        rawHeader: h,
        sampleValues: sampleRows.slice(0, 3).map((r) => r[idx] ?? "").filter(Boolean),
        suggestedKey: k,
        matchKind: k ? "exact_contract" : "unmatched",
      };
    });

    return {
      ok: true,
      inspection: {
        mode: "canonical_v2",
        filename,
        bytes: buf.length,
        ext: ".xlsx",
        sourceSheets: summary.map((s) => s.sheet),
        selectedSourceSheet: firstSheetName,
        targetV2Sheet: firstSheetName,
        totalDataRows: totalRows,
        columns,
        sampleRows,
        targetSheetOptions: targetOptions,
        canonicalSheetSummary: summary,
      },
    };
  }

  // Free-form .xlsx (without _MAS_META) -> Interactive Column Mapping
  const visibleSheets = wb.worksheets
    .filter((ws) => ws.state === "visible" && ws.name !== META_SHEET)
    .map((ws) => ws.name);
  if (visibleSheets.length === 0) {
    return {
      ok: false,
      rejection: { code: "CORRUPT_XLSX", message: "Çalışma kitabında görünür veri sayfası bulunamadı." },
    };
  }

  const selectedSourceSheet =
    opts.preferredSourceSheet && visibleSheets.includes(opts.preferredSourceSheet)
      ? opts.preferredSourceSheet
      : visibleSheets[0];
  const ws = wb.getWorksheet(selectedSourceSheet)!;

  // Locate first non-empty row as header row
  let headerRowNumber = 1;
  ws.eachRow({ includeEmpty: false }, (_row, rn) => {
    if (headerRowNumber === 1 && rn > 1) return;
    if (headerRowNumber === 1) headerRowNumber = rn;
  });

  const maxCol = Math.min(Math.max(ws.columnCount, 1), 60);
  const headerRow = ws.getRow(headerRowNumber);
  const headers: string[] = [];
  for (let c = 1; c <= maxCol; c++) {
    headers.push(cellToDisplayString(headerRow.getCell(c).value));
  }
  while (headers.length > 0 && headers[headers.length - 1] === "") {
    headers.pop();
  }
  if (headers.length === 0) {
    return {
      ok: false,
      rejection: {
        code: "EMPTY_FILE",
        message: `'${selectedSourceSheet}' sayfasında okunabilir kolon başlığı bulunamadı.`,
      },
    };
  }

  const sampleRows: string[][] = [];
  let dataRowCount = 0;
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= headerRowNumber) return;
    const vals: string[] = [];
    let nonBlank = false;
    for (let c = 1; c <= headers.length; c++) {
      const s = cellToDisplayString(row.getCell(c).value);
      if (s !== "") nonBlank = true;
      vals.push(s);
    }
    if (!nonBlank) return;
    dataRowCount++;
    if (sampleRows.length < 5) sampleRows.push(vals);
  });

  const targetSheet =
    opts.preferredTargetV2Sheet && sheetByName(opts.preferredTargetV2Sheet)
      ? opts.preferredTargetV2Sheet
      : sheetByName(selectedSourceSheet)
        ? selectedSourceSheet
        : guessTargetV2Sheet(`${filename} ${selectedSourceSheet}`, headers);
  const spec = sheetByName(targetSheet)!;

  const usedKeys = new Set<string>();
  const columns: SourceColumnInspection[] = headers.map((h, idx) => {
    const cleanH = h || `Sütun_${idx + 1}`;
    const m = autoMatchHeaderToColumn(spec, cleanH);
    const suggested = m.key && !usedKeys.has(m.key) ? m.key : null;
    if (suggested) usedKeys.add(suggested);
    return {
      colIndex: idx,
      rawHeader: cleanH,
      sampleValues: sampleRows.slice(0, 3).map((r) => r[idx] ?? "").filter(Boolean),
      suggestedKey: suggested,
      matchKind: suggested ? m.kind : "unmatched",
    };
  });

  return {
    ok: true,
    inspection: {
      mode: "interactive_mapping",
      filename,
      bytes: buf.length,
      ext: ".xlsx",
      sourceSheets: visibleSheets,
      selectedSourceSheet,
      targetV2Sheet: targetSheet,
      totalDataRows: dataRowCount,
      columns,
      sampleRows,
      targetSheetOptions: targetOptions,
    },
  };
}

/**
 * Synthesizes a deterministic canonical V2 `.xlsx` Buffer from a `.csv` or free-form `.xlsx`
 * file plus the user's interactive column mapping (`colIndex -> targetColumnKey`).
 * Unmapped columns are preserved with a `__ham__:` prefix so V2's `UNKNOWN_COLUMNS_KEY`
 * stores their cell values in `import_rows.row_json` without losing source provenance.
 */
export async function synthesizeCanonicalV2Buffer(
  buf: Buffer,
  filename: string,
  opts: {
    sourceSheetName?: string;
    targetV2Sheet: string;
    columnMapping: Record<string, string>;
  },
): Promise<{ ok: true; buffer: Buffer; effectiveFilename: string } | { ok: false; rejection: Rejection }> {
  const metaErr = validateWizardUploadMeta({ name: filename, size: buf.length });
  if (metaErr) return { ok: false, rejection: metaErr };

  const spec = sheetByName(opts.targetV2Sheet);
  if (!spec) {
    return {
      ok: false,
      rejection: {
        code: "NOT_V2_SCHEMA",
        message: `Hedef tablo şablonu bulunamadı: ${opts.targetV2Sheet}`,
      },
    };
  }

  const ext = path.extname(filename).toLowerCase();
  let sourceHeaders: string[] = [];
  let sourceRows: unknown[][] = [];

  if (ext === ".csv") {
    const parsed = parseCsvBuffer(buf);
    sourceHeaders = parsed.headers;
    sourceRows = parsed.rows;
  } else {
    const opened = await openWorkbook(buf);
    if (!opened.ok) return opened;
    const ws =
      (opts.sourceSheetName ? opened.wb.getWorksheet(opts.sourceSheetName) : undefined) ??
      opened.wb.worksheets.find((s) => s.state === "visible" && s.name !== META_SHEET);
    if (!ws) {
      return {
        ok: false,
        rejection: { code: "EMPTY_FILE", message: "Seçilen kaynak sekme bulunamadı." },
      };
    }
    const maxCol = Math.min(Math.max(ws.columnCount, 1), 60);
    const r1 = ws.getRow(1);
    for (let c = 1; c <= maxCol; c++) {
      sourceHeaders.push(cellToDisplayString(r1.getCell(c).value));
    }
    while (sourceHeaders.length > 0 && sourceHeaders[sourceHeaders.length - 1] === "") {
      sourceHeaders.pop();
    }
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (rn === 1) return;
      const vals: unknown[] = [];
      let anyVal = false;
      for (let c = 1; c <= sourceHeaders.length; c++) {
        const cell = row.getCell(c);
        const val = cell.master.address !== cell.address ? null : (cell.value ?? null);
        if (val !== null && val !== undefined && String(val).trim() !== "") anyVal = true;
        vals.push(val);
      }
      if (anyVal) sourceRows.push(vals);
    });
  }

  const { default: ExcelJSRuntime } = await import("exceljs");
  const outWb = new ExcelJSRuntime.Workbook();
  const fixed = new Date(Date.UTC(2026, 0, 1));
  outWb.created = fixed;
  outWb.modified = fixed;

  const targetWs = outWb.addWorksheet(spec.name);
  const specColByKey = new Map(spec.columns.map((c) => [c.key, c]));

  // Build output column descriptors from source columns
  const outHeaders: string[] = [];
  const colIndices: number[] = [];
  const usedTargetKeys = new Set<string>();

  for (let i = 0; i < sourceHeaders.length; i++) {
    const mappedKey = opts.columnMapping[String(i)]?.trim() || "";
    const targetCol = mappedKey ? specColByKey.get(mappedKey) : undefined;
    if (targetCol && !usedTargetKeys.has(targetCol.key)) {
      usedTargetKeys.add(targetCol.key);
      outHeaders.push(targetCol.header);
      colIndices.push(i);
    } else if (mappedKey === "__skip__") {
      continue;
    } else {
      const rawH = sourceHeaders[i]?.trim() || `Ek_Sutun_${i + 1}`;
      // Ensure unmapped header does not accidentally collide with a canonical header
      const safeRawH = normalizeHeader(spec, rawH) ? `Ham: ${rawH}` : rawH;
      outHeaders.push(safeRawH);
      colIndices.push(i);
    }
  }

  targetWs.addRow(outHeaders);
  for (const r of sourceRows) {
    targetWs.addRow(colIndices.map((idx) => (r[idx] ?? null) as ExcelJS.CellValue));
  }

  const metaWs = outWb.addWorksheet(META_SHEET);
  metaWs.state = "veryHidden";
  metaWs.addRow(["schema_name", SCHEMA_NAME]);
  metaWs.addRow(["schema_version", SCHEMA_VERSION]);
  metaWs.addRow(["template_version", TEMPLATE_VERSION]);
  metaWs.addRow(["template_id", TEMPLATE_ID]);

  const rawOut = Buffer.from(await outWb.xlsx.writeBuffer());
  const { buffer } = canonicalizeZipTimestamps(rawOut);
  const baseName = filename.replace(/\.(csv|xlsx)$/i, "");
  const effectiveFilename = ext === ".csv" ? `${baseName}.xlsx` : filename;
  return { ok: true, buffer, effectiveFilename };
}
