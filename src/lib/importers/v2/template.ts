// Standart Import V2 — şablon üreteci (kütüphane).
//
// Binary Excel dosyası elle üretilmez: şablon, `./contract.ts` içindeki TEK sözleşmeden
// deterministik olarak türetilir. Böylece şablon ile parser'ın kolon listesi birbirinden
// ayrışamaz — ikisi de aynı kaynağı okur.
//
// Burada durmasının sebebi (PHASE 4): `/data/imports/v2/template` route'u şablonu ÇALIŞMA
// ZAMANINDA bu koddan üretir; depodaki `templates/*.xlsx` kopyası dağıtım/kanıt içindir.
// İkisi aynı bayttır (zip-canonical.test.ts: byte-determinizm) — kullanıcı hangisini alırsa
// alsın sha256 aynı çıkar. CLI: `pnpm import:template:v2` (scripts/import/generate-standard-template-v2.ts).
import ExcelJS from "exceljs";
import {
  DATA_SHEETS, README_SHEET, EXAMPLES_SHEET, META_SHEET,
  SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION, TEMPLATE_ID,
  type SheetSpec, type ColumnSpec,
} from "./contract";
import { canonicalizeZipTimestamps, TEMPLATE_ZIP_TIMESTAMP } from "./zip-canonical";

/** Kullanıcıya indirilen dosyanın adı — tek yerde. */
export const TEMPLATE_FILENAME = "MAS_Nakit_Radar_Standart_Import_v2.xlsx";

const HEADER_FILL = "FF1F3A5F";
const REQUIRED_FILL = "FF2E5E3E";
const HEADER_FONT = "FFFFFFFF";

function numFmt(col: ColumnSpec): string | undefined {
  switch (col.type) {
    case "money": return "#,##0.00";
    case "percent": return "0.0000";
    case "decimal": return "#,##0.0000";
    case "integer": return "0";
    case "date": return "yyyy-mm-dd";
    default: return undefined;
  }
}

/** Excel'in kendi açılır listesi — kullanıcı enum'u elle yazmak zorunda kalmasın. */
function addEnumValidation(ws: ExcelJS.Worksheet, colIndex: number, values: readonly string[]): void {
  // 2. satırdan itibaren geniş bir aralık: kullanıcı satır ekledikçe kural geçerli kalsın.
  for (let r = 2; r <= 500; r++) {
    ws.getCell(r, colIndex).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${values.join(",")}"`],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "Geçersiz değer",
      error: `İzin verilen değerler: ${values.join(", ")}`,
    };
  }
}

function buildDataSheet(wb: ExcelJS.Workbook, spec: SheetSpec): void {
  const ws = wb.addWorksheet(spec.name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = spec.columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? 18,
  }));

  const header = ws.getRow(1);
  header.height = 28;
  spec.columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: HEADER_FONT }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: col.required ? REQUIRED_FILL : HEADER_FILL } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    // Hücre notu: alanın anlamı + boş bırakılırsa ne olacağı.
    cell.note = {
      texts: [{ text: `${col.required ? "ZORUNLU ALAN\n\n" : ""}${col.note}` }],
      margins: { insetmode: "auto" },
    };
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: spec.columns.length } };

  spec.columns.forEach((col, i) => {
    const fmt = numFmt(col);
    if (fmt) ws.getColumn(i + 1).numFmt = fmt;
    // Açılır liste `templateValues` varsa ondan üretilir: parser'ın OKUYABİLDİĞİ değerler
    // ile şablonun SUNDUĞU değerler aynı olmak zorunda değil (bkz. FINANCE_TRY_ONLY).
    const sunulan = col.templateValues ?? col.enumValues;
    if (col.type === "enum" && sunulan) addEnumValidation(ws, i + 1, sunulan);
  });

  // Sayfanın ne işe yaradığı, ilk satırın hemen üstünde değil — başlık notunda değil, sayfa
  // adının kendisinde taşınamaz. Bu yüzden A1 notuna sayfanın amacını da ekliyoruz.
  const a1 = ws.getCell(1, 1);
  const existing = a1.note && typeof a1.note === "object" && "texts" in a1.note ? a1.note.texts : [];
  a1.note = {
    texts: [{ text: `${spec.title}\n${spec.purpose}\n\n` }, ...(existing ?? [])],
    margins: { insetmode: "auto" },
  };
}

function buildReadme(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet(README_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ width: 26 }, { width: 96 }];

  const lines: Array<[string, string]> = [
    ["MAS NAKİT RADAR", "Standart Veri Aktarım Şablonu"],
    ["Şablon sürümü", TEMPLATE_VERSION],
    ["Şema", `${SCHEMA_NAME} v${SCHEMA_VERSION}`],
    ["", ""],
    ["NASIL DOLDURULUR", ""],
    ["1", "Yalnızca doldurmak istediğiniz sayfaları doldurun. Boş sayfa hata değildir."],
    ["2", "İlk satırdaki başlıkları DEĞİŞTİRMEYİN, silmeyin, yerlerini kaydırmayın."],
    ["3", "Koyu yeşil başlıklar ZORUNLU alanlardır. Lacivert başlıklar isteğe bağlıdır."],
    ["4", "Her başlığın üzerine gelince o alanın ne demek olduğunu ve boş bırakırsanız ne olacağını görürsünüz."],
    ["", ""],
    ["EN ÖNEMLİ KURAL", "BOŞ HÜCRE ile 0 AYNI ŞEY DEĞİLDİR."],
    ["Boş bırakırsanız", "'Bilinmiyor' anlamına gelir. O tutar toplamlara KATILMAZ, 'eksik veri' olarak raporlanır."],
    ["0 yazarsanız", "'Gerçekten sıfır' anlamına gelir. Hesaplamaya sıfır olarak girer."],
    ["Neden önemli", "Bilinmeyen bir gideri 0 saymak, nakit açığını olduğundan iyi gösterir. Sistem bu ikisini asla karıştırmaz."],
    ["", ""],
    ["KAYIT KODU (external_id)", "Aynı kodla tekrar yüklerseniz kayıt güncellenir, ikinci kopya oluşmaz."],
    ["Boş bırakırsanız", "Sistem satırın daha önceki bir satırla aynı kayıt olduğunu VARSAYMAZ."],
    ["Mükerrer şüphesi", "Benzer kayıtlar otomatik BİRLEŞTİRİLMEZ veya SİLİNMEZ; incelemenize sunulur."],
    ["", ""],
    ["TARİH", "YYYY-AA-GG yazın (örn. 2026-05-31). Excel tarih hücresi de kabul edilir."],
    ["", "01/02/03 gibi belirsiz tarihler tahmin EDİLMEZ; incelemeye düşer."],
    ["PARA", "35000 veya 35.000,50 yazabilirsiniz. Para birimini ayrı kolonda belirtin."],
    ["YÜZDE", "Oranları sayı olarak yazın: %3,14 için 3.14"],
    ["", ""],
    ["FORMÜL KULLANIMI", "Hücrede formül kullanabilirsiniz, ancak sistem finansal sonucu KENDİ hesaplar."],
    ["", "Formülün son hesaplanmış değeri okunur; Excel çalıştırılmaz."],
    ["", ""],
    ["ÖRNEKLER", `Örnek satırlar ${EXAMPLES_SHEET} sayfasındadır ve içeri AKTARILMAZ.`],
    ["", "Örnekleri veri sayfalarına kopyalamayın; kendi verinizi yazın."],
    ["", ""],
    ["SAYFALAR", ""],
  ];

  for (const [a, b] of lines) ws.addRow([a, b]);
  for (const s of DATA_SHEETS) ws.addRow([s.name, `${s.title} — ${s.purpose}`]);

  ws.getRow(1).font = { bold: true, size: 14 };
  ws.getColumn(1).font = { bold: true };
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  ws.eachRow((row) => { row.alignment = { vertical: "top", wrapText: true }; });
}

/** Örnekler AYRI sayfada: importer bunları asla gerçek veri sanmaz. */
function buildExamples(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet(EXAMPLES_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ width: 22 }, { width: 26 }, { width: 70 }];
  ws.addRow(["Sayfa", "Kolon", "Örnek değer ve açıklama"]);
  ws.getRow(1).font = { bold: true, color: { argb: HEADER_FONT } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };

  const examples: Array<[string, string, string]> = [
    ["01_ODEMELER", "aciklama", "MAS ELEKTRİK — ödemenin adı"],
    ["01_ODEMELER", "vade_gunu", "3 — her ayın 3'ünde ödeniyor"],
    ["01_ODEMELER", "tutar", "(boş) — tutar değişken/bilinmiyorsa BOŞ bırakın, 0 yazmayın"],
    ["01_ODEMELER", "tekrar_tipi", "monthly"],
    ["02_CEKLER", "signed_tutar", "-45000 — ödeyeceğiniz çek (eksi işaret ödemeyi gösterir)"],
    ["02_CEKLER", "signed_tutar", "120000 — tahsil edeceğiniz çek (artı işaret tahsilatı gösterir)"],
    ["02_CEKLER", "seri_no", "AKR-2026-0031 — varsa yazın, mükerrer tespitini kesinleştirir"],
    ["03_KREDILER", "external_id", "KREDI-VAKIF-01 — taksit sayfası bu kodla bağlanır"],
    ["03_KREDILER", "anapara", "1500000"],
    ["04_KREDI_TAKSITLERI", "loan_external_id", "KREDI-VAKIF-01 — 03'teki kodla birebir aynı olmalı"],
    ["05_NAKIT_AKISI", "donem", "2026-05"],
    ["05_NAKIT_AKISI", "satir_tipi", "opening_balance — ay başı devir; kasa sistem tarafından hesaplanır"],
    ["05_NAKIT_AKISI", "yon", "balance — devir satırları için"],
    ["06_BANKA_HESAPLARI", "external_id", "BANKA-VAKIF-TL — hareket sayfası bu kodla bağlanır"],
    ["07_BANKA_HAREKETLERI", "account_external_id", "BANKA-VAKIF-TL"],
    ["08_FATURALAR", "fatura_tipi", "sales — satış faturası (alacak)"],
    ["12_BUTCE", "senaryo", "base_case"],
    ["13_FX_POZISYONU", "try_karsiligi", "(boş) — kur verirseniz sistem hesaplar"],
    ["14_KAPASITE", "torna_dk", "(boş) — süre ölçülmediyse BOŞ; 0 yazarsanız 'torna işlemi yok' demektir"],
    ["15_MALIYET", "senaryo", "normal / overtime"],
    ["16_MAKINE_ROI", "makine_adi", "Awea — kişisel/aile gideri satırları buraya YAZILMAZ"],
  ];
  for (const r of examples) ws.addRow(r);
  ws.getColumn(3).alignment = { wrapText: true, vertical: "top" };
}

/** Gizli metadata: importer yalnız sayfa adına bakarak V2 sanmaz. */
function buildMeta(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet(META_SHEET);
  ws.state = "veryHidden";
  ws.columns = [{ width: 24 }, { width: 48 }];
  ws.addRow(["schema_name", SCHEMA_NAME]);
  ws.addRow(["schema_version", SCHEMA_VERSION]);
  ws.addRow(["template_version", TEMPLATE_VERSION]);
  ws.addRow(["template_id", TEMPLATE_ID]);
  ws.addRow(["sheet_count", DATA_SHEETS.length]);
}

export async function buildTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MAS Nakit Radar";
  wb.lastModifiedBy = "MAS Nakit Radar";
  // Deterministik çıktı: sabit zaman damgası olmadan aynı girdi farklı byte üretirdi.
  const fixed = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  wb.created = fixed;
  wb.modified = fixed;

  buildReadme(wb);
  for (const spec of DATA_SHEETS) buildDataSheet(wb, spec);
  buildExamples(wb);
  buildMeta(wb);
  return wb;
}

/**
 * Şablonun dağıtılacak BAYTLARI. `wb.created/modified` sabitlemek belge içeriğini
 * deterministik yapar; ZIP girdi başlıklarındaki üretim-anı damgasını ise ExcelJS
 * ayarlanabilir kılmıyor → paketleme sonrası kanonikleştirilir (plan §3.7). Aynı sözleşme,
 * aynı kod → aynı SHA256. Test ve CLI aynı yolu kullanır ki kanıt ile dağıtım ayrışmasın.
 */
export async function buildTemplateBuffer(): Promise<{ buffer: Buffer; workbook: ExcelJS.Workbook; zipEntries: number }> {
  const workbook = await buildTemplateWorkbook();
  const raw = Buffer.from(await workbook.xlsx.writeBuffer());
  const { buffer, entries } = canonicalizeZipTimestamps(raw, TEMPLATE_ZIP_TIMESTAMP);
  return { buffer, workbook, zipEntries: entries };
}
