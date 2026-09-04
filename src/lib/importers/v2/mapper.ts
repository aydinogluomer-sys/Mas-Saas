// Standart Import V2 — çözümlenmiş workbook'u veritabanına yazan katman (§26, §27, §29).
//
// GÖREV SINIRI. Parser karar vermez, bu katman yazar. Ama yazdığı şeyin çoğu FİNANSAL KAYIT
// DEĞİL: bir import'un büyük kısmı hazırlık (staging) ve iz kaydıdır. Sıra şudur:
//
//   1. source_workbooks   — dosyanın kendisi
//   2. source_sheets      — her sayfa
//   3. import_rows        — HER okunan satır, ham hâliyle (row_json NOT NULL)
//   4. mapping_reviews    — insan bakması gereken her şey
//   5. domain tabloları   — YALNIZ "hazır" satırlar
//   6. import_external_keys — kullanıcının kodu ile yaratılan kaydın bağı (0088)
//
// 3. ADIM 5. ADIMDAN ÖNCE GELİR VE KOŞULSUZDUR. Reddedilmiş bir satır bile ham hâliyle
// saklanır; aksi hâlde kullanıcı "dosyamda 49 satır vardı, sistemde 39 var, 10'u nerede?"
// sorusunu soramaz. CLAUDE.md'nin kuralı da bu: her ham satır normalizasyondan ÖNCE korunur.
//
// TEK İŞLEM (transaction). Yarısı yazılmış bir import, yazılmamış bir import'tan kötüdür:
// domain kaydı var ama iz kaydı yok demek, o kaydın nereden geldiğini bir daha kimsenin
// bilememesi demektir. Çağıran taraf BEGIN/COMMIT'i kendi yönetir; bu modül yalnız client alır.
import type { PoolClient } from "pg";
import { audit } from "../../audit";
import { sheetByName } from "./contract";
import type { WorkbookParseResult, SheetResult, ParsedRow, Issue, Severity } from "./parser";

/* ── Sonuç tipleri ───────────────────────────────────────────────────────────────────── */

export interface MapperOptions {
  /** Kullanıcının yüklediği dosyanın adı — iz kaydında görünür. */
  filename: string;
  /** Dosyanın sha256'sı; aynı dosyanın ikinci kez yüklendiğini görmeye yarar. */
  fileSha256?: string | null;
  /** public.users.id — audit ve imported_by için. */
  actorId: string;
  /**
   * ÖNİZLEME KİPİ (§30). Her şey hesaplanır, HİÇBİR ŞEY yazılmaz.
   *
   * Kullanıcıya "bu dosya şunları yapacak" demenin tek dürüst yolu, gerçekten yapacak olan
   * kodu çalıştırıp yazmadan durmaktır. Ayrı bir "tahmin" fonksiyonu yazmak, önizleme ile
   * gerçeğin zamanla ayrışması demekti.
   */
  dryRun?: boolean;
}

export interface TableOutcome {
  inserted: number;
  updated: number;
}

export interface MapperResult {
  dryRun: boolean;
  workbookId: string | null;
  sheetsStaged: number;
  rowsStaged: number;
  reviewsOpened: number;
  /** Domain'e yazılan/güncellenen kayıtlar, tablo bazında. */
  perTable: Record<string, TableOutcome>;
  /** Sözleşmede hedef tablosu olan ama henüz eşleyicisi yazılmamış aileler. */
  stagedOnlyFamilies: string[];
  /** "hazır" olduğu hâlde domain'e yazılmayan satır sayısı (eşleyicisi yok). */
  rowsStagedOnly: number;
  rowsMapped: number;
  rowsNeedsReview: number;
  rowsRejected: number;
}

/* ── Şiddet eşlemesi ─────────────────────────────────────────────────────────────────── */

// mapping_reviews.severity: low | medium | high | critical. Parser'ın üç şiddeti var.
// 'critical' bilerek kullanılmıyor: parser'ın gördüğü hiçbir şey "veriyi şimdi durdur"
// düzeyinde değil — en kötü ihtimalle satır yazılmaz ve dosya düzeltilir.
const REVIEW_SEVERITY: Record<Severity, string> = { low: "low", medium: "medium", high: "high" };

/** import_rows.mapping_status — 0089 'rejected' üyesini bu ayrım için ekledi. */
function mappingStatusFor(row: ParsedRow, wroteDomain: boolean): string {
  if (row.status === "rejected") return "rejected";
  if (row.status === "needs_review") return "needs_review";
  return wroteDomain ? "mapped" : "unmapped";
}

/* ── Yardımcı çözücüler ──────────────────────────────────────────────────────────────── */

/**
 * İsimden `parties` kaydı bulur, yoksa yaratır.
 *
 * `normalized_name` Türkçe'ye duyarlı küçültme ile üretilir: "İŞ BANKASI" ile "iş bankası"
 * aynı taraftır. `toLowerCase()` yetmez — noktalı İ'yi 'i̇' yapıp iki ayrı taraf üretirdi.
 *
 * BU BİR BİRLEŞTİRME (merge) DEĞİLDİR. Yalnız birebir aynı normalize adı olan kayıtlar
 * eşleşir; "Vakıf" ile "Vakıfbank" ayrı kalır ve öyle kalmalı — benzer isimleri kendiliğinden
 * birleştirmek, iki farklı tedarikçinin borcunu tek kaleme toplamak demektir.
 */
async function resolveParty(
  client: PoolClient, name: unknown, partyType: string,
): Promise<string | null> {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;

  const normalized = trimmed.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");

  const found = await client.query<{ id: string }>(
    "select id from public.parties where normalized_name = $1 and party_type = $2",
    [normalized, partyType],
  );
  if (found.rowCount && found.rows[0]) return found.rows[0].id;

  const created = await client.query<{ id: string }>(
    `insert into public.parties (name, normalized_name, party_type)
     values ($1, $2, $3)
     on conflict (normalized_name, party_type) do update set name = public.parties.name
     returning id`,
    [trimmed, normalized, partyType],
  );
  return created.rows[0].id;
}

/** Kategori adını `categories`'e çözer; yoksa yaratır. */
async function resolveCategory(
  client: PoolClient, name: unknown, domain: string,
): Promise<string | null> {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;

  const found = await client.query<{ id: string }>(
    "select id from public.categories where name = $1", [trimmed],
  );
  if (found.rowCount && found.rows[0]) return found.rows[0].id;

  const created = await client.query<{ id: string }>(
    `insert into public.categories (name, domain) values ($1, $2)
     on conflict (name) do update set name = public.categories.name
     returning id`,
    [trimmed, domain],
  );
  return created.rows[0].id;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/* ── Aile yazıcıları ─────────────────────────────────────────────────────────────────── */

export interface WriteContext {
  client: PoolClient;
  workbookId: string;
  sheetId: string;
  importRowId: string;
}

/**
 * Bir "hazır" satırı domain tablosuna yazan fonksiyon.
 *
 * `entityId` verildiyse GÜNCELLER (aynı external_id ile ikinci import), yoksa YARATIR.
 * Dönüş: yazılan kaydın id'si.
 */
export type FamilyWriter = (
  ctx: WriteContext, row: ParsedRow, entityId: string | null,
) => Promise<string>;

const writePayment: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const providerId = await resolveParty(ctx.client, v.karsi_taraf, "provider");
  const categoryId = await resolveCategory(ctx.client, v.kategori, "payment");

  // `amount_confidence` NULL/ZERO sözleşmesinin domain'deki karşılığı. Tutar boşsa 'unknown':
  // 0 YAZMIYORUZ. Sıfır yazmak "bu ödeme bedelsiz" demek olurdu — oysa bilinmiyor.
  const amount = num(v.tutar);
  const confidence = amount === null ? "unknown" : "known";

  const cols = {
    name: str(v.aciklama) ?? "(adsız ödeme)",
    description: str(v.notlar),
    category_id: categoryId,
    provider_party_id: providerId,
    recurrence_type: str(v.tekrar_tipi) ?? "monthly",
    due_day: num(v.vade_gunu),
    due_date: v.ilk_vade_tarihi ?? null,
    default_amount: amount,
    currency: str(v.para_birimi) ?? "TRY",
    amount_confidence: confidence,
    status: str(v.durum) ?? "active",
    source_workbook_id: ctx.workbookId,
    source_sheet_id: ctx.sheetId,
    source_row_id: ctx.importRowId,
  };

  if (entityId) {
    await ctx.client.query(
      `update public.payments set
         name=$2, description=$3, category_id=$4, provider_party_id=$5, recurrence_type=$6,
         due_day=$7, due_date=$8, default_amount=$9, currency=$10, amount_confidence=$11,
         status=$12, source_workbook_id=$13, source_sheet_id=$14, source_row_id=$15,
         updated_at=now()
       where id=$1`,
      [entityId, cols.name, cols.description, cols.category_id, cols.provider_party_id,
        cols.recurrence_type, cols.due_day, cols.due_date, cols.default_amount, cols.currency,
        cols.amount_confidence, cols.status, cols.source_workbook_id, cols.source_sheet_id,
        cols.source_row_id],
    );
    return entityId;
  }

  const r = await ctx.client.query<{ id: string }>(
    `insert into public.payments
       (name, description, category_id, provider_party_id, recurrence_type, due_day, due_date,
        default_amount, currency, amount_confidence, status,
        source_workbook_id, source_sheet_id, source_row_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [cols.name, cols.description, cols.category_id, cols.provider_party_id, cols.recurrence_type,
      cols.due_day, cols.due_date, cols.default_amount, cols.currency, cols.amount_confidence,
      cols.status, cols.source_workbook_id, cols.source_sheet_id, cols.source_row_id],
  );
  return r.rows[0].id;
};

const writeCheck: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const payee = await resolveParty(ctx.client, v.kime, "company");
  const payer = await resolveParty(ctx.client, v.kimden, "company");
  const bank = await resolveParty(ctx.client, v.banka, "bank");

  const signed = num(v.signed_tutar);

  // İŞARET SÖZLEŞMESİ. `signed_amount` kullanıcının yazdığı gibi korunur; `amount` mutlak
  // değerdir ve DB'nin check_amount_sign_consistency kısıtı ikisinin tutarlı olmasını şart
  // koşar. Yön işaretten TÜRETİLİR: eksi = bizden çıkan. Sıfır ne giriş ne çıkış olduğu için
  // 'unknown' — tahmin etmiyoruz.
  const direction = signed === null ? "unknown" : signed < 0 ? "outflow" : signed > 0 ? "inflow" : "unknown";

  const cols = {
    maturity_date: v.vade_tarihi ?? null,
    serial_no: str(v.seri_no),
    payee_party_id: payee,
    payer_party_id: payer,
    bank_party_id: bank,
    amount: signed === null ? null : Math.abs(signed),
    signed_amount: signed,
    direction,
    status: str(v.durum) ?? "planned",
    notes: str(v.notlar),
    source_workbook_id: ctx.workbookId,
    source_sheet_id: ctx.sheetId,
    source_row_id: ctx.importRowId,
  };

  if (entityId) {
    await ctx.client.query(
      `update public.checks set
         maturity_date=$2, serial_no=$3, payee_party_id=$4, payer_party_id=$5, bank_party_id=$6,
         amount=$7, signed_amount=$8, direction=$9, status=$10, notes=$11,
         source_workbook_id=$12, source_sheet_id=$13, source_row_id=$14, updated_at=now()
       where id=$1`,
      [entityId, cols.maturity_date, cols.serial_no, cols.payee_party_id, cols.payer_party_id,
        cols.bank_party_id, cols.amount, cols.signed_amount, cols.direction, cols.status,
        cols.notes, cols.source_workbook_id, cols.source_sheet_id, cols.source_row_id],
    );
    return entityId;
  }

  const r = await ctx.client.query<{ id: string }>(
    `insert into public.checks
       (maturity_date, serial_no, payee_party_id, payer_party_id, bank_party_id,
        amount, signed_amount, direction, status, notes,
        source_workbook_id, source_sheet_id, source_row_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [cols.maturity_date, cols.serial_no, cols.payee_party_id, cols.payer_party_id,
      cols.bank_party_id, cols.amount, cols.signed_amount, cols.direction, cols.status,
      cols.notes, cols.source_workbook_id, cols.source_sheet_id, cols.source_row_id],
  );
  return r.rows[0].id;
};

const writeLoan: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const lender = await resolveParty(ctx.client, v.banka, "bank");

  const cols = {
    name: str(v.kredi_adi) ?? "(adsız kredi)",
    lender_party_id: lender,
    principal: num(v.anapara),
    term_months: num(v.vade_ay),
    first_payment_date: v.ilk_odeme_tarihi ?? null,
    simple_interest_rate: num(v.baz_faiz_orani),
    applied_interest_rate: num(v.uygulanan_faiz_orani),
    bsmv_rate: num(v.bsmv_orani),
    kkdf_rate: num(v.kkdf_orani),
    installment_amount: num(v.taksit_tutari),
    total_payment: num(v.toplam_odeme),
    total_finance_cost: num(v.finansman_maliyeti),
    status: str(v.durum) ?? "active",
    notes: str(v.notlar),
    source_workbook_id: ctx.workbookId,
    source_sheet_id: ctx.sheetId,
  };

  // `principal` NOT NULL. Sözleşme `anapara`yı zorunlu işaretliyor, yani buraya null gelmesi
  // parser'ın bir satırı yanlışlıkla "hazır" saymış olması demektir. Sessizce 0 yazmıyoruz —
  // 0 anapara "bedelsiz kredi" demek olurdu; hatayı görünür kılıp satırı reddediyoruz.
  if (cols.principal === null) {
    throw new Error(
      `03_KREDILER satır ${row.rowIndex}: anapara boş, ama loans.principal NOT NULL. ` +
      "Sıfır yazmak veriyi uydurmak olurdu.",
    );
  }

  if (entityId) {
    await ctx.client.query(
      `update public.loans set
         name=$2, lender_party_id=$3, principal=$4, term_months=$5, first_payment_date=$6,
         simple_interest_rate=$7, applied_interest_rate=$8, bsmv_rate=$9, kkdf_rate=$10,
         installment_amount=$11, total_payment=$12, total_finance_cost=$13, status=$14,
         notes=$15, source_workbook_id=$16, source_sheet_id=$17, updated_at=now()
       where id=$1`,
      [entityId, cols.name, cols.lender_party_id, cols.principal, cols.term_months,
        cols.first_payment_date, cols.simple_interest_rate, cols.applied_interest_rate,
        cols.bsmv_rate, cols.kkdf_rate, cols.installment_amount, cols.total_payment,
        cols.total_finance_cost, cols.status, cols.notes, cols.source_workbook_id,
        cols.source_sheet_id],
    );
    return entityId;
  }

  const r = await ctx.client.query<{ id: string }>(
    `insert into public.loans
       (name, lender_party_id, principal, term_months, first_payment_date,
        simple_interest_rate, applied_interest_rate, bsmv_rate, kkdf_rate,
        installment_amount, total_payment, total_finance_cost, status, notes,
        source_workbook_id, source_sheet_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [cols.name, cols.lender_party_id, cols.principal, cols.term_months, cols.first_payment_date,
      cols.simple_interest_rate, cols.applied_interest_rate, cols.bsmv_rate, cols.kkdf_rate,
      cols.installment_amount, cols.total_payment, cols.total_finance_cost, cols.status,
      cols.notes, cols.source_workbook_id, cols.source_sheet_id],
  );
  return r.rows[0].id;
};

/**
 * Aile → domain yazıcısı.
 *
 * BU LİSTE BİLEREK EKSİK. Sözleşmedeki 16 ailenin yalnız üçünün kolon eşlemesi
 * (`domainField`) yazılmış durumda; kalan 13'ü için hedef kolonlar henüz belirlenmedi.
 * Eksik olanı "çalışıyor" göstermek yerine burada YOK bırakıyoruz: yazıcısı olmayan aile
 * hazırlık katmanına yazılır, domain'e yazılmaz ve sonuçta `stagedOnlyFamilies` altında
 * ADIYLA raporlanır. Sessizce atlanan bir aile, kullanıcının veri kaybını fark etmemesi
 * demekti.
 */
export const FAMILY_WRITERS: Readonly<Record<string, FamilyWriter>> = Object.freeze({
  payments: writePayment,
  checks: writeCheck,
  loans: writeLoan,
});

/* ── Hazırlık katmanı ────────────────────────────────────────────────────────────────── */

async function stageWorkbook(
  client: PoolClient, opts: MapperOptions, parsed: WorkbookParseResult,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.source_workbooks (original_filename, file_sha256, imported_by, status, notes)
     values ($1, $2, $3, 'parsed', $4) returning id`,
    [opts.filename, opts.fileSha256 ?? null, opts.actorId,
      `Standart Import V2 · şema ${parsed.schemaName} v${parsed.schemaVersion} · şablon ${parsed.templateVersion ?? "?"}`],
  );
  return r.rows[0].id;
}

async function stageSheet(
  client: PoolClient, workbookId: string, sheet: SheetResult, index: number,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.source_sheets
       (workbook_id, sheet_name, sheet_name_normalized, sheet_index, row_count, column_count,
        detected_type, parse_confidence)
     values ($1,$2,$3,$4,$5,$6,'standard_import_v2','high') returning id`,
    // Aile adı buraya yazılır: `detected_type` sözlüğü legacy tespit edicinin tahminleri için
    // yazılmış ve 16 V2 ailesini taşımıyor (bkz. 0089).
    [workbookId, sheet.sheet, sheet.family, index, sheet.rowsRead, sheet.headerRow.length],
  );
  return r.rows[0].id;
}

async function stageRow(
  client: PoolClient, workbookId: string, sheetId: string, family: string, row: ParsedRow,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `insert into public.import_rows
       (workbook_id, sheet_id, row_index, row_json, detected_entity_type, mapping_status, notes)
     values ($1,$2,$3,$4,$5,'unmapped',$6) returning id`,
    [workbookId, sheetId, row.rowIndex, JSON.stringify(row.raw), family,
      row.externalId ? `external_id=${row.externalId}` : null],
  );
  return r.rows[0].id;
}

async function openReview(
  client: PoolClient, workbookId: string, sheetId: string | null,
  importRowId: string | null, issue: Issue,
): Promise<void> {
  await client.query(
    `insert into public.mapping_reviews
       (workbook_id, sheet_id, import_row_id, issue_type, severity, message, suggested_mapping, status)
     values ($1,$2,$3,$4,$5,$6,$7,'open')`,
    [workbookId, sheetId, importRowId, issue.type, REVIEW_SEVERITY[issue.severity], issue.message,
      JSON.stringify({ sheet: issue.sheet, row: issue.row ?? null, column: issue.column ?? null })],
  );
}

/* ── external_id defteri (0088) ──────────────────────────────────────────────────────── */

async function lookupExternalKey(
  client: PoolClient, entityTable: string, externalId: string,
): Promise<string | null> {
  const r = await client.query<{ entity_id: string }>(
    "select entity_id from public.import_external_keys where entity_table = $1 and external_id = $2",
    [entityTable, externalId],
  );
  return r.rowCount && r.rows[0] ? r.rows[0].entity_id : null;
}

async function recordExternalKey(
  client: PoolClient, entityTable: string, externalId: string,
  entityId: string, workbookId: string,
): Promise<void> {
  await client.query(
    `insert into public.import_external_keys
       (entity_table, external_id, entity_id, first_seen_workbook_id, last_seen_workbook_id)
     values ($1,$2,$3,$4,$4)
     on conflict (entity_table, external_id)
       do update set last_seen_workbook_id = excluded.last_seen_workbook_id`,
    [entityTable, externalId, entityId, workbookId],
  );
}

/* ── Ana akış ────────────────────────────────────────────────────────────────────────── */

/**
 * Çözümlenmiş bir workbook'u yazar.
 *
 * Çağıran taraf işlemi (transaction) yönetir. `dryRun` verildiğinde hiçbir sorgu çalışmaz;
 * sonuç yalnız sayımlardan oluşur.
 */
export async function mapWorkbook(
  client: PoolClient, parsed: WorkbookParseResult, opts: MapperOptions,
): Promise<MapperResult> {
  const dryRun = opts.dryRun === true;

  const result: MapperResult = {
    dryRun, workbookId: null, sheetsStaged: 0, rowsStaged: 0, reviewsOpened: 0,
    perTable: {}, stagedOnlyFamilies: [], rowsStagedOnly: 0,
    rowsMapped: 0, rowsNeedsReview: 0, rowsRejected: 0,
  };

  if (!parsed.schemaDetected) {
    throw new Error(
      `Bu dosya Standart Import V2 değil: ${parsed.rejectionReason ?? "sebep bilinmiyor"}`,
    );
  }

  const stagedOnly = new Set<string>();
  const bump = (table: string, kind: keyof TableOutcome): void => {
    const t = (result.perTable[table] ??= { inserted: 0, updated: 0 });
    t[kind]++;
  };

  if (dryRun) {
    // Yazmadan sayım. Yazıcısı olan ailelerde "kaç kayıt yaratılır/güncellenir" sorusunun
    // cevabı defterin mevcut hâline bağlı olduğu için burada YALNIZ okuma yapılır.
    for (const sheet of parsed.sheets) {
      if (!sheet.present) continue;
      result.sheetsStaged++;
      const spec = sheetByName(sheet.sheet);
      const table = spec?.domainTable ?? null;
      const writer = FAMILY_WRITERS[sheet.family];
      if (table && !writer) stagedOnly.add(sheet.family);

      for (const row of sheet.rows) {
        result.rowsStaged++;
        if (row.status === "rejected") { result.rowsRejected++; continue; }
        if (row.status === "needs_review") { result.rowsNeedsReview++; continue; }
        if (!table || !writer) { result.rowsStagedOnly++; continue; }

        const existing = row.externalId
          ? await lookupExternalKey(client, table, row.externalId)
          : null;
        bump(table, existing ? "updated" : "inserted");
        result.rowsMapped++;
      }
      result.reviewsOpened += sheet.issues.length;
    }
    result.reviewsOpened += parsed.issues.filter((i) => i.row === undefined).length;
    result.stagedOnlyFamilies = [...stagedOnly].sort();
    return result;
  }

  const workbookId = await stageWorkbook(client, opts, parsed);
  result.workbookId = workbookId;

  let sheetIndex = 0;
  for (const sheet of parsed.sheets) {
    if (!sheet.present) continue;
    const sheetId = await stageSheet(client, workbookId, sheet, sheetIndex++);
    result.sheetsStaged++;

    const spec = sheetByName(sheet.sheet);
    const table = spec?.domainTable ?? null;
    const writer = FAMILY_WRITERS[sheet.family];
    if (table && !writer) stagedOnly.add(sheet.family);

    // Sayfa düzeyi sorunlar (bilinmeyen başlık, eksik kolon) satıra bağlı değildir.
    for (const issue of sheet.issues) {
      await openReview(client, workbookId, sheetId, null, issue);
      result.reviewsOpened++;
    }

    for (const row of sheet.rows) {
      const importRowId = await stageRow(client, workbookId, sheetId, sheet.family, row);
      result.rowsStaged++;

      for (const issue of row.issues) {
        await openReview(client, workbookId, sheetId, importRowId, issue);
        result.reviewsOpened++;
      }

      let entityId: string | null = null;
      let wroteDomain = false;

      if (row.status === "ready" && table && writer) {
        const existing = row.externalId ? await lookupExternalKey(client, table, row.externalId) : null;
        entityId = await writer({ client, workbookId, sheetId, importRowId }, row, existing);
        bump(table, existing ? "updated" : "inserted");
        wroteDomain = true;
        result.rowsMapped++;

        if (row.externalId) {
          await recordExternalKey(client, table, row.externalId, entityId, workbookId);
        }
      } else if (row.status === "ready") {
        // Hazır ama yazıcısı yok — hazırlık katmanında kalır ve raporda ADIYLA görünür.
        result.rowsStagedOnly++;
      }

      if (row.status === "needs_review") result.rowsNeedsReview++;
      if (row.status === "rejected") result.rowsRejected++;

      const status = mappingStatusFor(row, wroteDomain);
      await client.query(
        `update public.import_rows
            set mapping_status = $2, mapped_entity_table = $3, mapped_entity_id = $4
          where id = $1`,
        [importRowId, status, wroteDomain ? table : null, entityId],
      );
    }
  }

  // Dosya düzeyi sorunlar (bilinmeyen sayfa) hiçbir sayfaya ait değildir.
  for (const issue of parsed.issues.filter((i) => i.type === "unknown_sheet")) {
    await openReview(client, workbookId, null, null, issue);
    result.reviewsOpened++;
  }

  await client.query("update public.source_workbooks set status = 'mapped' where id = $1", [workbookId]);

  result.stagedOnlyFamilies = [...stagedOnly].sort();

  await audit(client, {
    actor: opts.actorId,
    action: "import_v2_map",
    entityTable: "source_workbooks",
    entityId: workbookId,
    before: null,
    after: {
      filename: opts.filename,
      sheets: result.sheetsStaged,
      rowsStaged: result.rowsStaged,
      rowsMapped: result.rowsMapped,
      rowsNeedsReview: result.rowsNeedsReview,
      rowsRejected: result.rowsRejected,
      rowsStagedOnly: result.rowsStagedOnly,
      stagedOnlyFamilies: result.stagedOnlyFamilies,
      reviewsOpened: result.reviewsOpened,
      perTable: result.perTable,
    },
  });

  return result;
}
