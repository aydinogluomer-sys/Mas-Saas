// Standart Import V2 — workbook parser ve doğrulama katmanı.
//
// GÖREV SINIRI. Bu modül DOMAIN'E YAZMAZ. Bir workbook'u okur, her satırı sözleşmeye göre
// çözer ve üç şeyden birini söyler: "hazır", "incelenmeli", "reddedildi". Domain mutasyonu
// ayrı bir katmanın işi — çünkü §30 kullanıcıya önizleme göstermeden yazmayı yasaklıyor.
//
// MÜKERRER TESPİTİ İLE MÜKERRER SİLMESİ AYNI ŞEY DEĞİLDİR (§28). Bu modül şüphe üretir,
// karar üretmez. TEMİZ.xlsx denetiminde bulunan AKR −45.000 ×2 ve Çağdaş −100.000 ×3
// durumları burada `duplicate_check` olarak işaretlenir ve öyle kalır.
import type ExcelJS from "exceljs";
import {
  DATA_SHEETS, META_SHEET, EXAMPLES_SHEET, README_SHEET,
  SCHEMA_NAME, SCHEMA_VERSION,
  normalizeHeader, sheetByName,
  type SheetSpec, type ColumnSpec,
} from "./contract";
import {
  parseText, parseNumber, parseInteger, parsePercent,
  parseDate, parseMonth, parseEnum, parseBoolean,
  type ParsedValue,
} from "./values";

export type IssueType =
  | "missing_required_field" | "invalid_date" | "invalid_currency" | "invalid_enum"
  | "invalid_number" | "ambiguous_value"
  | "duplicate_external_id" | "duplicate_check" | "missing_reference"
  | "negative_amount" | "amount_mismatch" | "currency_mismatch"
  | "missing_operation_time" | "personal_data_mixed"
  | "unsupported_currency_for_finance_aggregation"
  | "unknown_header" | "unknown_sheet" | "reconciliation_mismatch"
  | "blocked_by_parent";

export type Severity = "low" | "medium" | "high";
/**
 * Satırın kaderi.
 *
 *   ready             → domain'e yazılır
 *   needs_review      → insan kararı bekler, yazılmaz
 *   rejected          → satırın KENDİSİ sözleşmeye uymuyor, yazılmaz
 *   blocked_by_parent → satır kendi başına sağlam, ama bağlı olduğu üst kayıt (kredi, hesap,
 *                       proje) AYNI DOSYADA kabul edilmedi; üst kayıt olmadan yazılmaz
 */
export type RowStatus = "ready" | "needs_review" | "rejected" | "blocked_by_parent";

export interface Issue {
  type: IssueType;
  severity: Severity;
  sheet: string;
  /** Excel satır numarası (1 = başlık). */
  row?: number;
  column?: string;
  message: string;
}

/**
 * `ParsedRow.raw` içinde sözleşme DIŞI kolonların hücrelerini taşıyan anahtar.
 *
 * Sözleşme anahtarları snake_case tanımlayıcılardır ve hiçbiri `__` ile başlamaz; bu yüzden
 * bu ad alanı bir sözleşme anahtarıyla çakışamaz. Değeri `{ "<başlık metni>": hamHücre }`.
 */
export const UNKNOWN_COLUMNS_KEY = "__unknown__";

export interface ParsedRow {
  /** Excel'deki gerçek satır numarası — provenance için birebir korunur. */
  rowIndex: number;
  status: RowStatus;
  /** Kanonik anahtar → çözülmüş değer. `null` değer "bilinmiyor" demektir, 0 demek DEĞİLDİR. */
  values: Record<string, unknown>;
  /**
   * Ham hücreler — inceleme ekranında kullanıcıya gösterilir ve `import_rows.row_json`'a
   * olduğu gibi yazılır.
   *
   * Sözleşme kolonları KENDİ anahtarıyla (`raw.satis_fiyati`); sözleşmede olmayan kolonların
   * hücreleri ise `raw[UNKNOWN_COLUMNS_KEY]` altında başlık metniyle
   * (`raw.__unknown__["Muhasebe Fişi No"]`). İkincisi `values`'a ASLA geçmez — sözleşmenin
   * parçası değildir — ama kaybolmaz da: her ham hücre normalizasyondan önce korunur.
   */
  raw: Record<string, unknown>;
  externalId: string | null;
  issues: Issue[];
}

export interface SheetResult {
  sheet: string;
  family: string;
  domainTable: string | null;
  present: boolean;
  headerRow: string[];
  /** Sözleşmede olmayan başlıklar — sessizce yok sayılmaz. */
  unknownHeaders: string[];
  /** Sözleşmede olup dosyada bulunmayan kolonlar. */
  missingColumns: string[];
  rowsRead: number;
  ready: number;
  needsReview: number;
  rejected: number;
  /** Üst kaydı bu dosyada kabul edilmediği için yazılmayacak satırlar (bkz. RowStatus). */
  blockedByParent: number;
  rows: ParsedRow[];
  issues: Issue[];
}

export interface WorkbookParseResult {
  schemaDetected: boolean;
  schemaName: string | null;
  schemaVersion: number | null;
  templateVersion: string | null;
  /** V2 değilse sebep — çağıran taraf legacy yola düşer. */
  rejectionReason?: string;
  sheets: SheetResult[];
  unknownSheets: string[];
  totals: {
    rowsRead: number; ready: number; needsReview: number; rejected: number;
    blockedByParent: number; issues: number;
  };
  issues: Issue[];
}

/* ── Şema tespiti (§3) ───────────────────────────────────────────────────────────────── */

/**
 * V2 kimliği YALNIZ metadata ile doğrulanır.
 *
 * Sayfa adına bakmak yeterli değil: birisi legacy dosyasına `01_ODEMELER` adında bir sayfa
 * ekleyebilir. Gizli `_MAS_META` sayfasındaki şema adı ve sürümü kontrol edilir; uymuyorsa
 * dosya V2 SAYILMAZ ve legacy yola düşer.
 */
export function detectSchema(wb: ExcelJS.Workbook): {
  detected: boolean; schemaName: string | null; schemaVersion: number | null;
  templateVersion: string | null; reason?: string;
} {
  const meta = wb.getWorksheet(META_SHEET);
  if (!meta) {
    return { detected: false, schemaName: null, schemaVersion: null, templateVersion: null,
      reason: `${META_SHEET} sayfası yok — bu dosya standart V2 şablonu değil` };
  }
  const kv = new Map<string, string>();
  meta.eachRow((row) => {
    const k = row.getCell(1).value;
    const v = row.getCell(2).value;
    if (k !== null && k !== undefined) kv.set(String(k).trim(), v === null || v === undefined ? "" : String(v).trim());
  });
  const name = kv.get("schema_name") ?? null;
  const version = kv.get("schema_version") ? Number(kv.get("schema_version")) : null;
  const tpl = kv.get("template_version") ?? null;

  if (name !== SCHEMA_NAME) {
    return { detected: false, schemaName: name, schemaVersion: version, templateVersion: tpl,
      reason: `şema adı uyuşmuyor: '${name}' (beklenen '${SCHEMA_NAME}')` };
  }
  if (version !== SCHEMA_VERSION) {
    return { detected: false, schemaName: name, schemaVersion: version, templateVersion: tpl,
      reason: `şema sürümü uyuşmuyor: ${version} (beklenen ${SCHEMA_VERSION})` };
  }
  return { detected: true, schemaName: name, schemaVersion: version, templateVersion: tpl };
}

/* ── Hücre çözümü ────────────────────────────────────────────────────────────────────── */

function parseByType(col: ColumnSpec, raw: unknown): ParsedValue<unknown> {
  switch (col.type) {
    case "text": return parseText(raw);
    case "integer": return parseInteger(raw);
    case "decimal":
    case "money": return parseNumber(raw);
    case "percent": return parsePercent(raw);
    case "date": return parseDate(raw);
    case "month": return parseMonth(raw);
    case "boolean": return parseBoolean(raw);
    case "enum": return parseEnum(raw, col.enumValues ?? []);
    default: return parseText(raw);
  }
}

function issueTypeFor(col: ColumnSpec): IssueType {
  if (col.type === "date" || col.type === "month") return "invalid_date";
  if (col.type === "enum") return col.key === "para_birimi" ? "invalid_currency" : "invalid_enum";
  if (col.type === "money" || col.type === "decimal" || col.type === "integer" || col.type === "percent") {
    return "invalid_number";
  }
  return "invalid_enum";
}

/* ── Sayfa ayrıştırma ────────────────────────────────────────────────────────────────── */

function parseSheet(wb: ExcelJS.Workbook, spec: SheetSpec): SheetResult {
  const result: SheetResult = {
    sheet: spec.name, family: spec.family, domainTable: spec.domainTable,
    present: false, headerRow: [], unknownHeaders: [], missingColumns: [],
    rowsRead: 0, ready: 0, needsReview: 0, rejected: 0, blockedByParent: 0, rows: [], issues: [],
  };

  const ws = wb.getWorksheet(spec.name);
  if (!ws) return result;          // Boş/eksik sayfa hata değildir — kullanıcı doldurmamış olabilir.
  result.present = true;

  // ── Başlık eşlemesi ──────────────────────────────────────────────────────────────────
  const headerRow = ws.getRow(1);
  const colIndexByKey = new Map<string, number>();
  // Sözleşme dışı kolonlar: başlık metni → kolon numarası. Aynı başlık iki kez geçerse
  // ikincisi kolon numarasıyla ayrıştırılır — iki hücre tek anahtarda ezişmesin.
  const unknownColIndexByHeader = new Map<string, number>();
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cell.value === null || cell.value === undefined ? "" : String(cell.value).trim();
    if (text === "") return;
    headers.push(text);
    const key = normalizeHeader(spec, text);
    if (key === null) {
      result.unknownHeaders.push(text);
      unknownColIndexByHeader.set(
        unknownColIndexByHeader.has(text) ? `${text} (sütun ${colNumber})` : text, colNumber,
      );
      result.issues.push({
        type: "unknown_header", severity: "medium", sheet: spec.name, row: 1,
        column: text,
        message:
          `'${text}' başlığı sözleşmede tanımlı değil. Sütun İÇERİ AKTARILMADI. ` +
          "Başlık tahmin edilmez — doğru başlığı şablondan kopyalayın.",
      });
      return;
    }
    if (!colIndexByKey.has(key)) colIndexByKey.set(key, colNumber);
  });
  result.headerRow = headers;
  result.missingColumns = spec.columns.filter((c) => !colIndexByKey.has(c.key)).map((c) => c.key);

  // ── Satırlar ─────────────────────────────────────────────────────────────────────────
  const seenExternalIds = new Map<string, number>();

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const values: Record<string, unknown> = {};
    const raw: Record<string, unknown> = {};
    const issues: Issue[] = [];
    let anyValue = false;

    for (const col of spec.columns) {
      const idx = colIndexByKey.get(col.key);
      if (idx === undefined) { values[col.key] = null; continue; }
      const cellRaw = row.getCell(idx).value;
      raw[col.key] = cellRaw;

      const parsed = parseByType(col, cellRaw);
      values[col.key] = parsed.value;
      if (parsed.status !== "blank") anyValue = true;

      if (parsed.status === "invalid") {
        // ÇÖZÜLEMEYEN DEĞER, KOLON İSTEĞE BAĞLI OLSA DA YÜKSEK ŞİDDETLİDİR.
        //
        // Bir süre şiddet `col.required` değerine bağlıydı ve tutarsızdı: zorunlu bir
        // kolondaki geçersiz enum satırı reddediyor, isteğe bağlı olandaki aynı hata
        // incelemeye düşürüyordu. İkincisi iki sebeple yanlış:
        //
        //   1. Sistem o değeri SAKLAYAMAZ. Satırı "incelenmeli" diye kabul etmek, sonradan
        //      kabul edildiğinde veritabanı kısıtına çarpacak bir satırı kuyruğa koymaktır.
        //   2. Tek alternatif o hücreyi NULL yazmaktı — yani kullanıcının yazdığı şeyi
        //      sessizce silmek. Bu sözleşmenin tam olarak önlemek için var olduğu şey.
        //
        // Doğru davranış: satır reddedilir, kullanıcı TEK hücreyi düzeltip yeniden yükler.
        // Belirsiz (ambiguous) değer farklıdır — onun çözüm kuralı var ve kayıt altına alınır.
        issues.push({
          type: issueTypeFor(col), severity: "high",
          sheet: spec.name, row: rowNumber, column: col.header,
          message: `${col.header}: ${parsed.reason ?? "değer okunamadı"}`,
        });
      } else if (parsed.status === "ambiguous") {
        issues.push({
          type: "ambiguous_value", severity: "medium",
          sheet: spec.name, row: rowNumber, column: col.header,
          message: `${col.header}: ${parsed.reason ?? "belirsiz değer"}`,
        });
      } else if (parsed.status === "blank" && col.required) {
        issues.push({
          type: "missing_required_field", severity: "high",
          sheet: spec.name, row: rowNumber, column: col.header,
          message: `${col.header} zorunlu ama boş.`,
        });
      }
    }

    // ── Sözleşme dışı kolonların hücreleri — HAM OLARAK KORUNUR, `values`'a GEÇMEZ ────
    //
    // Bir süre yalnız başlık adı kaydediliyordu (`unknownHeaders`) ve hücre değerleri hiçbir
    // yere yazılmıyordu: `raw` sözleşme kolonlarını döngüye alıyordu, tanınmayan kolon o
    // döngüye hiç girmiyordu. "Sütun içeri aktarılmadı" uyarısı doğruydu ama eksikti —
    // sütun aktarılmamakla kalmıyor, ham hâli de KAYBOLUYORDU. CLAUDE.md'nin kuralı ("her ham
    // hücre normalizasyondan önce korunur") sözleşme kolonlarıyla sınırlı değil.
    //
    // Değer `values`'a yazılmaz: tanınmayan başlığın hangi alan olduğu TAHMİN EDİLMEZ, o
    // yüzden bir domain kolonuna gidemez. Ama `raw[UNKNOWN_COLUMNS_KEY]` altında başlık
    // metniyle durur; inceleme ekranı gösterir, `import_rows.row_json` saklar.
    //
    // Boş hücre yazılmaz: kaybolacak bir değer yok, ve her satıra her tanınmayan başlık için
    // `null` basmak `row_json`'u gürültüyle şişirirdi. Satırın "boş satır" sayılıp sayılmaması
    // da yalnız sözleşme kolonlarına bakar (`anyValue`): sözleşme dışı bir hücreden ibaret
    // satır veri satırı değildir ve okunmaz — bu bilinçli bir sınır, sessiz bir kayıp değil.
    if (unknownColIndexByHeader.size > 0) {
      const unknown: Record<string, unknown> = {};
      for (const [header, idx] of unknownColIndexByHeader) {
        const cellRaw = row.getCell(idx).value;
        if (cellRaw === null || cellRaw === undefined) continue;
        unknown[header] = cellRaw;
      }
      if (Object.keys(unknown).length > 0) raw[UNKNOWN_COLUMNS_KEY] = unknown;
    }

    // Tamamen boş satır: sessizce atlanır, hata değildir.
    if (!anyValue) return;
    result.rowsRead++;

    // ── external_id benzersizliği (§27) ───────────────────────────────────────────────
    const ext = typeof values.external_id === "string" ? values.external_id : null;
    if (ext) {
      const prev = seenExternalIds.get(ext);
      if (prev !== undefined) {
        issues.push({
          type: "duplicate_external_id", severity: "high", sheet: spec.name, row: rowNumber,
          column: "Kayıt Kodu (external_id)",
          message: `'${ext}' kodu ${prev}. satırda da kullanılmış. Aynı dosyada aynı kod iki kez olamaz.`,
        });
      } else {
        seenExternalIds.set(ext, rowNumber);
      }
    }

    // ── Aileye özel kurallar ──────────────────────────────────────────────────────────
    applyFamilyRules(spec, values, rowNumber, issues);

    // Şiddet satırın kaderini belirler:
    //   high   → reddedilir (domain'e yazılamaz)
    //   medium → incelemeye düşer (insan kararı gerekir)
    //   low    → bilgilendirmedir; satır HAZIR kalır
    // Düşük şiddetli notların satırı incelemeye düşürmesi, inceleme kuyruğunu gürültüyle
    // doldurup gerçek sorunları görünmez yapardı.
    const status: RowStatus = issues.some((i) => i.severity === "high")
      ? "rejected"
      : issues.some((i) => i.severity === "medium")
        ? "needs_review"
        : "ready";
    if (status === "ready") result.ready++;
    else if (status === "needs_review") result.needsReview++;
    else result.rejected++;

    // `raw` HER SATIRDA saklanır — bu bir performans tercihi değil, sözleşme gereği.
    //
    // Bir süre boyunca burada `issues.length > 0 ? raw : {}` yazıyordu; gerekçesi sorunsuz
    // satırın ham hücrelerinin inceleme ekranında hiç okunmamasıydı. İki sebeple geri alındı:
    //
    // 1. KAYIT KATMANI ZORUNLU KILIYOR. `import_rows.row_json` NOT NULL (0001_source_layer.sql)
    //    ve HER okunan satır için yazılır — sorunsuz olanlar dahil. `raw` boş bırakıldığında
    //    mapper o sütunu dolduramaz; yani optimizasyon §26 provenance yazımını bloke ediyordu.
    //    CLAUDE.md kuralı da net: "Preserve every raw workbook sheet/cell/row before normalization."
    //
    // 2. GEREKÇESİ OLAN ÖLÇÜM YOKTU. İddia edilen 39 → 125 µs/satır tırmanışı güvenilir
    //    değildi: aynı benchmark ısınma + 5 tekrar + medyan ile yeniden koşulduğunda 10k için
    //    min 399 / maks 5165 ms gibi bir dağılım verdi. Bu genişlikte bir ölçümden "GC baskısı"
    //    sonucu çıkarılamaz. Yük altındaki makine ölçülüyordu, parser değil.
    result.rows.push({
      rowIndex: rowNumber, status, values,
      raw,
      externalId: ext, issues,
    });
    result.issues.push(...issues);
  });

  return result;
}

/**
 * Aileye özel iş kuralları.
 *
 * Buradaki her kural TEMİZ.xlsx denetiminde gerçekten görülmüş bir durumdan geliyor;
 * varsayımsal kural eklenmedi.
 */
function applyFamilyRules(
  spec: SheetSpec, values: Record<string, unknown>, rowNumber: number, issues: Issue[],
): void {
  // Ödemeler: aylık tekrar için vade günü şart (legacy'de "X" işareti olmayan satır vardı).
  if (spec.family === "payments") {
    const rec = values.tekrar_tipi;
    const day = values.vade_gunu;
    if (rec === "monthly" && (day === null || day === undefined)) {
      issues.push({
        type: "missing_required_field", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Vade Günü (1-31)",
        message: "Aylık tekrar seçildi ama vade günü boş. Aylık ödeme için gün gerekir.",
      });
    }
    if (typeof day === "number" && (day < 1 || day > 31)) {
      issues.push({
        type: "invalid_number", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Vade Günü (1-31)", message: `Vade günü 1-31 arasında olmalı, ${day} bulundu.`,
      });
    }
  }

  // ── V2.0 FİNANS TOPLAMA KISITI: ÇEK VE KREDİ YALNIZ TRY ──────────────────────────────
  //
  // Bu bir depolama sınırı DEĞİL. `checks.currency` ve `loans.currency` migration 0090 ile
  // var ve satırın para birimini saklayabiliyor. Sorun TOPLAMADA:
  //
  //   Vade akışı, due30, kalan tutar, aylık finans toplamları ve anlık görüntü tüketicileri
  //   `sum(amount)` kullanıyor; para birimine göre ayırmıyor ve belirlenmiş bir kur dönüşümü
  //   yapmıyor. Bu okuma modellerine 1.000 USD'lik bir çek girdiğinde 1.000 TRY'lik bir çekle
  //   TOPLANIR ve rapor "2.000" der. Böyle bir sayı finansal olarak geçersizdir; üstelik
  //   yanlış olduğu ekranda görünmez.
  //
  // Bu yüzden TRY dışı satır domain'e ALINMAZ. Ama SESSİZCE DE ATILMAZ: ham hâliyle kaynak
  // katmanında durur, yüksek şiddetli bir inceleme kaydı açılır ve kullanıcıya sebebi
  // söylenir. Kullanıcının "dosyamı doğru doldurdum, kaydım nerede?" sorusunun cevabı var.
  //
  // Kalıcı çözüm çoklu para birimi analitiği (kur tarihçesi + dönüşüm politikası); o ayrı bir
  // iş ve açık teknik borç olarak yazılı: MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED.
  if (spec.family === "checks" || spec.family === "loans") {
    const cur = values.para_birimi;
    if (typeof cur === "string" && cur !== "" && cur !== "TRY") {
      issues.push({
        type: "unsupported_currency_for_finance_aggregation", severity: "high",
        sheet: spec.name, row: rowNumber, column: "Para Birimi",
        message:
          `Bu sürüm çek ve kredi toplamlarını yalnız TRY için güvenli biçimde hesaplar. ` +
          `${cur} kayıt kaynakta KORUNMUŞTUR, ancak finans KPI'larına aktarılmamıştır — ` +
          "karışık para birimlerini toplamak yanlış bir toplam üretirdi.",
      });
    }
  }

  // ── Veritabanı kısıtlarının satır düzeyindeki karşılıkları ────────────────────────────
  //
  // Buradaki dört kural, kolon eşlemesi yazılırken hedef tabloların CHECK kısıtları
  // okunduğunda ortaya çıktı. Hepsi INSERT anında zaten patlardı; fark şu: orada patlarsa
  // TÜM import işlemi düşer ve kullanıcı hangi satırın suçlu olduğunu göremez. Burada
  // yakalanınca yalnız o satır reddedilir, gerekçesi yazılır, geri kalan dosya işlenir.

  // Fatura: `invoices` kısıtı `gross_amount = net_amount + tax_amount` diyor ve üçü de
  // NOT NULL. Eksik olan biri diğer ikisinden ÇIKARILIR (bu aritmetik, tahmin değil);
  // ikiden azı varsa satır reddedilir — kalanları uydurmak gerekirdi.
  if (spec.family === "invoices") {
    const net = values.net_tutar, tax = values.vergi_tutari, gross = values.toplam_tutar;
    const n = typeof net === "number", t = typeof tax === "number", g = typeof gross === "number";
    const known = [n, t, g].filter(Boolean).length;

    if (known < 2) {
      issues.push({
        type: "missing_required_field", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Net / Vergi / Toplam",
        message: "Net, vergi ve toplam tutardan en az ikisi gerekli — üçüncüsü hesaplanır. " +
          "Tek değerle kalan ikisi uydurulmuş olurdu.",
      });
    } else if (n && t && g && Math.abs((net as number) + (tax as number) - (gross as number)) > 0.005) {
      issues.push({
        type: "amount_mismatch", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Toplam Tutar",
        message: `Net (${net}) + vergi (${tax}) = ${(net as number) + (tax as number)}, ` +
          `ama toplam ${gross} yazılmış. Hangisinin doğru olduğu tahmin edilemez.`,
      });
    }
    for (const [k, label] of [["net_tutar", "Net tutar"], ["vergi_tutari", "Vergi tutarı"], ["toplam_tutar", "Toplam tutar"]] as const) {
      const v = values[k];
      if (typeof v === "number" && v < 0) {
        issues.push({
          type: "negative_amount", severity: "high", sheet: spec.name, row: rowNumber,
          column: label, message: `${label} eksi olamaz (${v}). Yön "fatura tipi" kolonunda taşınır.`,
        });
      }
    }
  }

  // Bütçe: `budget_lines.amount >= 0`. Gider satırı da artı yazılır; yönü `yon` kolonu söyler.
  if (spec.family === "budget") {
    const amt = values.tutar;
    if (typeof amt === "number" && amt < 0) {
      issues.push({
        type: "negative_amount", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Tutar",
        message: `Bütçe tutarı eksi olamaz (${amt}). Gider satırında da artı yazın; ` +
          "yönü \"income / expense\" kolonu belirler.",
      });
    }
  }

  // Kredi taksidi: `installment_paid_requires_paid_at` kısıtı, ödenmiş bir taksidin ödeme
  // tarihini şart koşuyor. Tarihi uydurmak (bugün yazmak) ödemenin ne zaman yapıldığını
  // kaybetmek olurdu.
  if (spec.family === "loan_installments") {
    if (values.durum === "paid" && (values.odeme_tarihi === null || values.odeme_tarihi === undefined)) {
      issues.push({
        type: "missing_required_field", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Ödeme Tarihi",
        message: "Taksit 'paid' işaretlendi ama ödeme tarihi boş. Ödenmiş bir taksidin tarihi gerekir.",
      });
    }
  }

  // Döviz pozisyonu: `entry_rate > 0`. Sıfır ya da eksi kur bir ölçüm değil, hatadır.
  if (spec.family === "fx") {
    const rate = values.try_kuru;
    if (typeof rate === "number" && rate <= 0) {
      issues.push({
        type: "invalid_number", severity: "high", sheet: spec.name, row: rowNumber,
        column: "TRY Kuru", message: `Kur sıfır veya eksi olamaz (${rate}).`,
      });
    }
  }

  // Çekler.
  //
  // NEGATİF TUTAR İÇİN İNCELEME AÇILMAZ. Legacy formatta işaret sözleşmesi yoktu, bu yüzden
  // eksi bir tutar gerçekten belirsizdi ve `negative_amount` incelemesi anlamlıydı. V2'de
  // kolonun adı "İşaretli Tutar (− ödeme / + tahsilat)" ve anlamı sözleşmede yazılı: eksi
  // NORMAL durumdur. Normal durumu inceleme kuyruğuna atmak o kuyruğu okunmaz hale getirir.
  // `negative_amount` artık yalnız İŞARETSİZ tutar alanlarında (yönü ayrı kolonda taşınan
  // hareket/fatura/sipariş/bütçe) çelişki olarak üretilir — aşağıya bakın.
  if (spec.family === "checks") {
    const amt = values.signed_tutar;
    if (typeof amt === "number" && amt === 0) {
      issues.push({
        type: "amount_mismatch", severity: "medium", sheet: spec.name, row: rowNumber,
        column: "İşaretli Tutar (− ödeme / + tahsilat)",
        message: "Çek tutarı 0 yazılmış. Tutar bilinmiyorsa hücreyi BOŞ bırakın; 0 'gerçekten sıfır' demektir.",
      });
    }
  }

  // İşaretsiz tutar alanları: yön ayrı kolonda taşınıyorsa eksi tutar ÇELİŞKİDİR.
  // "outflow" + "-500" iki kez negatiflemek anlamına gelir ve sessizce geçilirse toplamı bozar.
  const UNSIGNED_AMOUNT_FAMILIES = ["bank_transactions", "invoices", "orders", "budget", "cashflow"];
  if (UNSIGNED_AMOUNT_FAMILIES.includes(spec.family)) {
    for (const key of ["tutar", "toplam_tutar", "net_tutar"]) {
      const v = values[key];
      if (typeof v === "number" && v < 0) {
        issues.push({
          type: "negative_amount", severity: "medium", sheet: spec.name, row: rowNumber,
          column: key,
          message:
            `${key} eksi (${v}) yazılmış, ama bu alan işaretsizdir — yön ayrı kolonda taşınır. ` +
            "Çıkış için yönü 'outflow' seçin ve tutarı pozitif yazın.",
        });
      }
    }
  }

  // Kapasite: operasyon süreleri BOŞ ise ölçülmemiş demektir; 0 ise "o işlem yok".
  // İkisi farklı başabaş noktası üretir, bu yüzden ayırt edilir.
  if (spec.family === "capacity") {
    const t = values.torna_dk, f = values.freze_dk, o = values.diger_operasyon_dk;
    const allBlank = t === null && f === null && o === null;
    if (allBlank) {
      issues.push({
        type: "missing_operation_time", severity: "medium", sheet: spec.name, row: rowNumber,
        message:
          "Hiçbir operasyon süresi girilmemiş. Bu parça kapasite ve başabaş hesabına GİRMEZ. " +
          "İşlem yoksa 0 yazın; ölçülmediyse boş bırakın (fark hesabı değiştirir).",
      });
    }
  }

  // Makine ROI: kişisel/aile gideri satırları makine ekonomisine karışmamalı.
  // Legacy `tablo` sayfasında `personal_data_mixed` incelemesi tam olarak bundan doğmuştu.
  if (spec.family === "machine_roi") {
    const name = typeof values.makine_adi === "string" ? values.makine_adi.toLocaleLowerCase("tr-TR") : "";
    const personalTokens = ["maaş", "maas", "kira", "market", "okul", "aile", "şahsi", "sahsi", "kişisel", "kisisel"];
    if (personalTokens.some((tok) => name.includes(tok))) {
      issues.push({
        type: "personal_data_mixed", severity: "high", sheet: spec.name, row: rowNumber,
        column: "Makine Adı",
        message:
          `'${values.makine_adi}' makine ekonomisi dışında bir gider gibi görünüyor. ` +
          "Makine ROI'ye otomatik taşınmaz; doğruysa onaylayın.",
      });
    }
  }
}

/* ── Çapraz sayfa kuralları ──────────────────────────────────────────────────────────── */

/** Üst/alt sayfa çiftleri — referans bütünlüğü VE üst kayıt kabulü buradan okunur. */
export const PARENT_CHILD_REFS: ReadonlyArray<{
  from: string; field: string; to: string; label: string; required: boolean;
}> = Object.freeze([
  { from: "04_KREDI_TAKSITLERI", field: "loan_external_id", to: "03_KREDILER", label: "Kredi Kodu", required: true },
  { from: "07_BANKA_HAREKETLERI", field: "account_external_id", to: "06_BANKA_HESAPLARI", label: "Hesap Kodu", required: true },
  { from: "08_FATURALAR", field: "project_external_id", to: "11_PROJELER", label: "Proje Kodu", required: false },
  { from: "09_SIPARISLER", field: "project_external_id", to: "11_PROJELER", label: "Proje Kodu", required: false },
]);

const STATUS_LABEL: Record<RowStatus, string> = {
  ready: "hazır", needs_review: "incelemeye düştü", rejected: "reddedildi",
  blocked_by_parent: "üst kaydı yüzünden engellendi",
};

/**
 * Referans bütünlüğü: 04→03, 07→06, 08/09→11.
 *
 * İki ayrı soru sorulur ve ikisi ayrı sonuç üretir:
 *
 *   1. Üst kayıt bu dosyada VAR MI?          yoksa → missing_reference (mevcut kural)
 *   2. Üst kayıt bu dosyada KABUL EDİLDİ Mİ?  edilmediyse → blocked_by_parent
 *
 * ═══ NEDEN İKİNCİ SORU ═══
 *
 * Eşleyici alt kaydın üst kaydını DEFTERDEN (import_external_keys) buluyor. Defter geçmişi
 * bilir, bu dosyayı bilmez. Kredi satırı bu dosyada reddedilmişse (ör. EUR — finans toplama
 * kısıtı) ama aynı kod önceki bir import'tan defterde duruyorsa, taksitler ESKİ krediye
 * bağlanıp normal yazılıyordu: vade akışına ve nakit tahminine giriyorlardı. Kullanıcı
 * "kredim reddedildi" mesajını görüyor, taksitlerinin toplamlara girdiğini görmüyordu.
 *
 * Kabul edilmemiş üst kayıt = "ready" olmayan üst kayıt. Reddedilmiş olanla sınırlı değil:
 * incelemeye düşmüş bir üst kayıt da bu turda YAZILMAZ; alt kayıt yine ya bayat bir kayda
 * bağlanır ya da (defterde de yoksa) yazıcı "defterde yok" diye TÜM import'u düşürür. İki
 * durumda da doğru cevap aynı: alt kayıt beklesin, sebebi yazılsın, dosyanın kalanı işlensin.
 *
 * Alt kaydın KENDİ kusuru varsa (rejected) o durum korunur — kullanıcı önce onu düzeltecek;
 * üst kayıt engeli yine kayda geçer ki iki sorunu tek seferde görsün.
 *
 * Bu karar DOSYA-YEREL'dir ve DB'ye bakmaz: eşleyici defterde ne bulursa bulsun, üst kaydı
 * bu dosyada kabul edilmemiş alt kayıt yazılmaz. Önizleme ile gerçek yazma aynı kararı
 * buradan okur — iki yol ayrı sayamaz.
 */
function applyCrossSheetRules(sheets: SheetResult[]): Issue[] {
  const issues: Issue[] = [];
  const rowsOf = (sheetName: string): Map<string, ParsedRow> => {
    const s = sheets.find((x) => x.sheet === sheetName);
    const out = new Map<string, ParsedRow>();
    // Aynı kod iki kez geçerse İLKİ üst kayıttır — parser ikincisini zaten reddediyor
    // (duplicate_external_id) ve eşleyici yalnız ilkini yazar.
    for (const r of s?.rows ?? []) if (r.externalId && !out.has(r.externalId)) out.set(r.externalId, r);
    return out;
  };

  for (const ref of PARENT_CHILD_REFS) {
    const src = sheets.find((s) => s.sheet === ref.from);
    if (!src || !src.present) continue;
    const targets = rowsOf(ref.to);
    for (const row of src.rows) {
      const v = row.values[ref.field];
      if (typeof v !== "string" || v === "") continue;
      const parent = targets.get(v);

      if (!parent) {
        const issue: Issue = {
          type: "missing_reference", severity: ref.required ? "high" : "medium",
          sheet: ref.from, row: row.rowIndex, column: ref.label,
          message: `'${v}' kodu ${ref.to} sayfasında bulunamadı.`,
        };
        row.issues.push(issue);
        issues.push(issue);
        // Satır durumunu yeniden değerlendir: yüksek şiddet reddi getirir.
        if (ref.required && row.status !== "rejected") {
          if (row.status === "ready") { src.ready--; } else { src.needsReview--; }
          row.status = "rejected"; src.rejected++;
        } else if (row.status === "ready") {
          src.ready--; row.status = "needs_review"; src.needsReview++;
        }
        continue;
      }

      if (parent.status !== "ready") {
        const issue: Issue = {
          type: "blocked_by_parent", severity: "high",
          sheet: ref.from, row: row.rowIndex, column: ref.label,
          message:
            `'${v}' kodlu üst kayıt ${ref.to} sayfasının ${parent.rowIndex}. satırında ` +
            `${STATUS_LABEL[parent.status]}; bu satır üst kaydı olmadan YAZILMAZ. ` +
            "Üst kaydı düzeltip dosyayı yeniden yükleyin — geçmiş bir import'taki aynı kodlu " +
            "kayda bağlanmaz.",
        };
        row.issues.push(issue);
        issues.push(issue);
        if (row.status === "ready") { src.ready--; row.status = "blocked_by_parent"; src.blockedByParent++; }
        else if (row.status === "needs_review") { src.needsReview--; row.status = "blocked_by_parent"; src.blockedByParent++; }
        // rejected: kendi kusuru öncelikli, durum değişmez.
      }
    }
  }
  return issues;
}

/**
 * Çek mükerrer şüphesi (§28).
 *
 * Aynı karşı taraf + vade + tutar üçlüsü birden fazla kez geçiyorsa VE ayırt edici bir
 * kimlik (seri no ya da external_id) yoksa şüphe kaydı açılır. OTOMATİK BİRLEŞTİRME YOK:
 * iki gerçek çek de aynı gün aynı tutarla aynı kişiye yazılmış olabilir.
 */
function applyDuplicateSuspicion(sheets: SheetResult[]): Issue[] {
  const issues: Issue[] = [];
  const s = sheets.find((x) => x.sheet === "02_CEKLER");
  if (!s || !s.present) return issues;

  const groups = new Map<string, ParsedRow[]>();
  for (const r of s.rows) {
    const cp = String(r.values.kime ?? r.values.kimden ?? "").toLocaleLowerCase("tr-TR").trim();
    const key = `${cp}|${String(r.values.vade_tarihi ?? "")}|${String(r.values.signed_tutar ?? "")}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const distinguishable = rows.every((r) => r.externalId || (typeof r.values.seri_no === "string" && r.values.seri_no));
    if (distinguishable) continue;   // Seri no/kod varsa bunlar ayrı çeklerdir, şüphe yok.
    const list = rows.map((r) => r.rowIndex).join(", ");
    for (const r of rows) {
      const issue: Issue = {
        type: "duplicate_check", severity: "medium", sheet: s.sheet, row: r.rowIndex,
        message:
          `Aynı karşı taraf, vade ve tutar ${rows.length} kez geçiyor (satır ${list}) ve ayırt edici ` +
          "seri no / kayıt kodu yok. Bunlar AYRI çekler olabilir de, aynı çekin tekrarı olabilir de — " +
          "sistem BİRLEŞTİRMEZ ve SİLMEZ. Seri no ekleyerek kesinleştirebilirsiniz.",
      };
      r.issues.push(issue);
      issues.push(issue);
      if (r.status === "ready") { s.ready--; r.status = "needs_review"; s.needsReview++; }
    }
  }
  return issues;
}

/* ── Giriş noktası ───────────────────────────────────────────────────────────────────── */

export function parseWorkbook(wb: ExcelJS.Workbook): WorkbookParseResult {
  const schema = detectSchema(wb);
  if (!schema.detected) {
    return {
      schemaDetected: false, schemaName: schema.schemaName, schemaVersion: schema.schemaVersion,
      templateVersion: schema.templateVersion, rejectionReason: schema.reason,
      sheets: [], unknownSheets: [],
      totals: { rowsRead: 0, ready: 0, needsReview: 0, rejected: 0, blockedByParent: 0, issues: 0 },
      issues: [],
    };
  }

  const sheets = DATA_SHEETS.map((spec) => parseSheet(wb, spec));

  const known = new Set<string>([
    ...DATA_SHEETS.map((s) => s.name), META_SHEET, EXAMPLES_SHEET, README_SHEET,
  ]);
  const unknownSheets = wb.worksheets.map((w) => w.name).filter((n) => !known.has(n));

  const issues: Issue[] = [];
  for (const n of unknownSheets) {
    issues.push({
      type: "unknown_sheet", severity: "low", sheet: n,
      message: `'${n}' sayfası sözleşmede yok — içeriği AKTARILMADI.`,
    });
  }

  issues.push(...applyCrossSheetRules(sheets));
  issues.push(...applyDuplicateSuspicion(sheets));
  for (const s of sheets) issues.push(...s.issues);

  const totals = sheets.reduce(
    (a, s) => ({
      rowsRead: a.rowsRead + s.rowsRead, ready: a.ready + s.ready,
      needsReview: a.needsReview + s.needsReview, rejected: a.rejected + s.rejected,
      blockedByParent: a.blockedByParent + s.blockedByParent,
      issues: 0,
    }),
    { rowsRead: 0, ready: 0, needsReview: 0, rejected: 0, blockedByParent: 0, issues: 0 },
  );
  totals.issues = issues.length;

  return {
    schemaDetected: true, schemaName: schema.schemaName, schemaVersion: schema.schemaVersion,
    templateVersion: schema.templateVersion, sheets, unknownSheets, totals, issues,
  };
}

export { sheetByName };
