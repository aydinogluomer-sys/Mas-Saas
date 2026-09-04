// Standart Import V2 — parser performans ölçümü (§46).
//
// Amaç iddia değil ölçüm: 10k ve 50k satırda süre, satır başına maliyet ve bellek tepesi.
// Doğrusal ölçekleniyorsa satır başına süre iki ölçümde birbirine yakın kalır; O(n²) bir
// davranış olsaydı 5× satırda satır başına süre de ~5× artardı.
import ExcelJS from "exceljs";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import {
  DATA_SHEETS, META_SHEET, SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION,
} from "../../src/lib/importers/v2/contract";

const SHEET = "07_BANKA_HAREKETLERI";

async function buildLarge(rows: number): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const spec = DATA_SHEETS.find((s) => s.name === SHEET)!;
  const ws = wb.addWorksheet(spec.name);
  ws.addRow(spec.columns.map((c) => c.header));

  // Hesap sayfası: referans bütünlüğü kuralı gerçek yükte de çalışsın.
  const acc = DATA_SHEETS.find((s) => s.name === "06_BANKA_HESAPLARI")!;
  const aws = wb.addWorksheet(acc.name);
  aws.addRow(acc.columns.map((c) => c.header));
  aws.addRow(acc.columns.map((c) =>
    c.key === "external_id" ? "ACC-1" : c.key === "banka" ? "Vakıf" : c.key === "para_birimi" ? "TRY" : null));

  for (let i = 0; i < rows; i++) {
    ws.addRow(spec.columns.map((c) => {
      switch (c.key) {
        case "external_id": return `HRK-${i}`;
        case "account_external_id": return "ACC-1";
        case "islem_tarihi": return "2026-05-03";
        case "aciklama": return `Hareket ${i}`;
        case "yon": return i % 2 === 0 ? "inflow" : "outflow";
        case "tutar": return (i % 977) * 13.5;
        case "para_birimi": return "TRY";
        default: return null;
      }
    }));
  }

  const meta = wb.addWorksheet(META_SHEET);
  meta.state = "veryHidden";
  meta.addRow(["schema_name", SCHEMA_NAME]);
  meta.addRow(["schema_version", SCHEMA_VERSION]);
  meta.addRow(["template_version", TEMPLATE_VERSION]);
  return wb;
}

const WARMUP = 1;
const REPEATS = 5;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Tek ölçüm güvenilmezdir.
 *
 * İlk sürümde her boyut bir kez koşuldu ve 10k için 39 µs/satır, sonraki koşuda 407 µs/satır
 * çıktı — yani "iyileşti/kötüleşti" diye okunacak her şey aslında JIT ısınması ve makine
 * yüküydü. Bu yüzden: workbook bir kez kurulur (kurulum maliyeti ölçüme girmez), önce ısınma
 * koşusu yapılır, sonra çoklu tekrar alınır ve MEDYAN raporlanır. En iyi/en kötü de yazılır
 * ki dağılımın genişliği görünsün.
 */
async function run(rows: number): Promise<Record<string, number | string>> {
  const wb = await buildLarge(rows);

  for (let i = 0; i < WARMUP; i++) parseWorkbook(wb);

  const samples: number[] = [];
  let last = parseWorkbook(wb);
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;

  for (let i = 0; i < REPEATS; i++) {
    const t0 = performance.now();
    last = parseWorkbook(wb);
    samples.push(performance.now() - t0);
  }
  const after = process.memoryUsage().heapUsed;
  const ms = median(samples);

  return {
    rows,
    parsedRows: last.totals.rowsRead,
    ready: last.totals.ready,
    rejected: last.totals.rejected,
    medianMs: Math.round(ms),
    minMs: Math.round(Math.min(...samples)),
    maxMs: Math.round(Math.max(...samples)),
    usPerRow: Math.round((ms * 1000) / Math.max(1, last.totals.rowsRead)),
    heapDeltaMB: Math.round(((after - before) / 1048576) * 10) / 10,
  };
}

async function main(): Promise<void> {
  const out: Array<Record<string, number | string>> = [];
  for (const n of [10_000, 50_000]) {
    const r = await run(n);
    out.push(r);
    console.log(
      `${String(r.rows).padStart(6)} satır → medyan ${String(r.medianMs).padStart(5)} ms ` +
      `(min ${r.minMs} / maks ${r.maxMs}) · ${String(r.usPerRow).padStart(4)} µs/satır ` +
      `· heap +${r.heapDeltaMB} MB · okunan ${r.parsedRows}`,
    );
  }
  const a = out[0], b = out[1];
  const scale = Number(b.usPerRow) / Number(a.usPerRow);
  console.log(`\nsatır başına maliyet oranı (50k / 10k): ${scale.toFixed(2)}×  [${REPEATS} tekrarın medyanı]`);
  console.log(scale < 1.5 ? "→ doğrusal: satır başına maliyet ölçekle artmıyor"
    : scale < 2.5 ? "→ hafif süper-doğrusal"
    : "→ DİKKAT: satır başına maliyet belirgin arttı");
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
