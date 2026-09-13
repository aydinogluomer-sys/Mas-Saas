// Standart Import V2 — çözümlenmiş workbook'u veritabanına yazan katman (§26, §27, §29).
//
// GÖREV SINIRI. Parser karar vermez, bu katman yazar. Ama yazdığı şeyin çoğu FİNANSAL KAYIT
// DEĞİL: bir import'un büyük kısmı hazırlık (staging) ve iz kaydıdır. Sıra şudur:
//
//   1. source_workbooks   — dosyanın kendisi
//   2. source_sheets      — her sayfa
//   3. import_rows        — HER okunan satır, ham hâliyle (row_json NOT NULL)
//   4. mapping_reviews    — insan bakması gereken her şey
//   5. domain tabloları   — YALNIZ "hazır" satırlar (incelemede, reddedilmiş ya da üst
//                           kaydı yüzünden engellenmiş satır yazılmaz)
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

/* ── Yapısal bütünlük hataları ───────────────────────────────────────────────────────── */

/**
 * Defterin işaret ettiği domain kaydı YOK.
 *
 * Bu bir kullanıcı verisi hatası değil, KİMLİK ZİNCİRİ KOPUKLUĞU. Kaydın silinmiş olması ya
 * da defterin başka bir veritabanından taşınmış olması gibi yapısal bir sebep var. Bu yüzden
 * satır incelemeye düşürülüp devam edilmez — import DURUR.
 *
 * Otomatik "iyileştirme" (yeni kayıt yaratıp deftere bağlamak) BİLEREK yapılmıyor: o, kopuk
 * zinciri gizler ve kullanıcının güncellediğini sandığı kayıt sessizce ikinci bir kayda
 * dönüşür. Fail closed.
 */
export class StaleExternalKeyBindingError extends Error {
  readonly code = "STALE_EXTERNAL_KEY_BINDING";
  constructor(
    readonly entityTable: string,
    readonly externalId: string,
    readonly entityId: string,
  ) {
    super(
      `STALE_EXTERNAL_KEY_BINDING: '${externalId}' kodu ${entityTable} tablosunda ` +
      `${entityId} kaydına bağlı, ama o kayıt yok. Kimlik zinciri kopuk — import durduruldu.`,
    );
    this.name = "StaleExternalKeyBindingError";
  }
}

/**
 * Bir kod, bağlı olduğundan BAŞKA bir kayda bağlanmaya çalışıldı.
 *
 * `(entity_table, external_id) → TEK entity_id` değişmezi. Bir kodun işaret ettiği kayıt
 * sessizce değişirse, kullanıcının "ODM-KIRA" diye bildiği kayıt geçmişini kaybeder ve eski
 * kayıt sahipsiz kalır. Bu yüzden çakışma sessizce `last_seen_workbook_id` güncellenerek
 * geçiştirilmez.
 */
export class ExternalKeyBindingConflictError extends Error {
  readonly code = "EXTERNAL_KEY_BINDING_CONFLICT";
  constructor(
    readonly entityTable: string,
    readonly externalId: string,
    readonly boundEntityId: string,
    readonly attemptedEntityId: string,
  ) {
    super(
      `EXTERNAL_KEY_BINDING_CONFLICT: '${externalId}' kodu ${entityTable} tablosunda zaten ` +
      `${boundEntityId} kaydına bağlı; ${attemptedEntityId} kaydına bağlanmak istendi. ` +
      "Bir kod tek bir kayda aittir.",
    );
    this.name = "ExternalKeyBindingConflictError";
  }
}

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
  /** Yazma sırasında yeri tanımlanmamış sayfalar — sona alındılar, atlanmadılar. */
  unorderedSheets: string[];
  /**
   * ÖNİZLEMEDE: kullanıcı kodu olmadığı için yeni mi güncelleme mi olduğu belirlenemeyen
   * satır sayısı. Gerçek yazmada her zaman 0'dır — orada cevap ölçülür, tahmin edilmez.
   */
  rowsUndetermined: number;
  rowsMapped: number;
  rowsNeedsReview: number;
  rowsRejected: number;
  /**
   * Üst kaydı (kredi, hesap, proje) AYNI DOSYADA kabul edilmediği için yazılmayan satırlar.
   * Karar parser'da verilir (blocked_by_parent); burada yalnız sayılır ve `import_rows`'a
   * ayrı bir durumla işlenir. Önizleme ve gerçek yazma aynı sayıyı verir.
   */
  rowsBlockedByParent: number;
}

/* ── Şiddet eşlemesi ─────────────────────────────────────────────────────────────────── */

// mapping_reviews.severity: low | medium | high | critical. Parser'ın üç şiddeti var.
// 'critical' bilerek kullanılmıyor: parser'ın gördüğü hiçbir şey "veriyi şimdi durdur"
// düzeyinde değil — en kötü ihtimalle satır yazılmaz ve dosya düzeltilir.
const REVIEW_SEVERITY: Record<Severity, string> = { low: "low", medium: "medium", high: "high" };

/**
 * import_rows.mapping_status — 0089 'rejected', 0091 'blocked_by_parent' üyesini ekledi.
 *
 * 'blocked_by_parent' ayrı bir değer, çünkü 'rejected' YANLIŞ olurdu: satırın kendisi
 * sözleşmeye uyuyor. Kullanıcının yapacağı iş farklı — bu satırı değil, üst kaydı düzeltmek.
 * İkisini aynı kovaya koymak "hangi satırı düzelteyim?" sorusunu cevapsız bırakırdı.
 */
function mappingStatusFor(row: ParsedRow, wroteDomain: boolean): string {
  if (row.status === "rejected") return "rejected";
  if (row.status === "blocked_by_parent") return "blocked_by_parent";
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

/**
 * `YYYY-AA` biçimindeki dönemi ayın İLK GÜNÜNE çevirir.
 *
 * Sözleşmenin `month` tipi "2026-05" üretiyor; hedef kolonlar (`cashflow_months.month_start`,
 * `budget_lines.period_start`) ise `date`. Postgres "2026-05" değerini tarih olarak kabul
 * etmez. Dönüşüm burada YAPILIR ve gün olarak 1 seçilir — dönem bir aydır, ayın herhangi bir
 * gününü seçmek o aya ait olmayan bir kesinlik uydurmak olurdu.
 */
const monthStart = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/* ── Aile yazıcıları ─────────────────────────────────────────────────────────────────── */

export interface WriteContext {
  client: PoolClient;
  workbookId: string;
  sheetId: string;
  importRowId: string;
}

/**
 * Bir yazma işleminin sonucu.
 *
 * `created` alanı ŞART: çağıran taraf bunu kendi başına bilemez. Bir süre "defterde kod
 * var mıydı" sorusundan tahmin ediliyordu ve yanlıştı — kullanıcı kodu olmayan satırlar
 * doğal anahtarlarından bulunup GÜNCELLENDİĞİ hâlde rapora "yaratıldı" diye yazılıyordu.
 * Sayı doğruydu ama açıklaması yanlıştı; kullanıcıya "2 yeni taksit eklendi" denecekti.
 */
export interface WriteOutcome {
  id: string;
  created: boolean;
}

/**
 * Bir "hazır" satırı domain tablosuna yazan fonksiyon.
 *
 * `entityId` verildiyse GÜNCELLER (aynı external_id ile ikinci import), yoksa yazıcı önce
 * doğal anahtarla arar; o da bulunmazsa YARATIR.
 */
export type FamilyWriter = (
  ctx: WriteContext, row: ParsedRow, entityId: string | null,
) => Promise<WriteOutcome>;

/**
 * Bir kaydı yazar ya da günceller ve id'sini döndürür.
 *
 * Kolon adları `domain-map.ts`'ten gelen sabit bir sözlükten üretilir, kullanıcı verisinden
 * DEĞİL; değerler her zaman parametre olarak geçer. Bu yüzden SQL metnine kullanıcıdan bir
 * şey karışmıyor.
 *
 * Neden elle yazılmış 15 INSERT yerine tek yardımcı: onbeş ayrı sorgu demek, onbeş yerde
 * kolon sırası ile değer sırasının kayma ihtimali demek. O tür bir kayma tip denetiminden
 * geçer, testten de geçebilir (iki `numeric` kolon yer değiştirdiğinde sayım aynı kalır) ve
 * sessizce yanlış finansal veri üretir.
 */
async function upsertRow(
  client: PoolClient, table: string, entityId: string | null,
  cols: Record<string, unknown>, hasUpdatedAt: boolean,
): Promise<WriteOutcome> {
  const names = Object.keys(cols);
  const values = names.map((n) => cols[n]);

  if (entityId) {
    const sets = names.map((n, i) => `${n} = $${i + 2}`);
    if (hasUpdatedAt) sets.push("updated_at = now()");
    const r = await client.query(
      `update public.${table} set ${sets.join(", ")} where id = $1`,
      [entityId, ...values],
    );

    // ═══ ETKİLENEN SATIR SAYISI KONTROL EDİLİR ═══
    //
    // Bir süre bu sonuç hiç okunmuyordu. `UPDATE ... WHERE id = $1` hiçbir satırı
    // etkilemediğinde Postgres HATA VERMEZ — sessizce 0 satır günceller. Kod "güncelledim"
    // diye döner, rapor "1 kayıt güncellendi" yazar ve ORTADA GÜNCELLENMİŞ BİR ŞEY YOKTUR.
    // Kullanıcı verisinin kaybolduğunu hiçbir yerden anlayamaz.
    //
    // 0 satır = defterin işaret ettiği kayıt yok (bkz. StaleExternalKeyBindingError).
    // 1'den fazla satır birincil anahtar yüzünden mümkün olmamalı; yine de değişmez olarak
    // kontrol ediliyor, çünkü "mümkün değil" varsayımı sessizce yanlış çıkarsa bunu
    // öğrenmenin tek yolu budur.
    if (r.rowCount !== 1) {
      throw new Error(
        `UPDATE public.${table} id=${entityId} → ${r.rowCount} satır etkiledi (1 bekleniyordu).`,
      );
    }
    return { id: entityId, created: false };
  }

  const r = await client.query<{ id: string }>(
    `insert into public.${table} (${names.join(", ")})
     values (${names.map((_, i) => `$${i + 1}`).join(", ")})
     returning id`,
    values,
  );
  return { id: r.rows[0].id, created: true };
}

/**
 * Kullanıcı kodu yoksa kaydı DOĞAL ANAHTARINDAN bulur.
 *
 * Defter (`import_external_keys`) yalnız kullanıcının kendi kodunu bilir. Kod yoksa — ya da
 * o sayfada hiç kod kolonu yoksa, 04_KREDI_TAKSITLERI gibi — ikinci import kaydı tanıyamaz
 * ve yeniden yazmaya çalışır. Veritabanında eşsizlik kısıtı varsa bu bir HATA olarak patlar
 * ve tüm import düşer; kısıt yoksa daha kötüsü olur ve sessizce mükerrer üretilir.
 *
 * Oysa kimlik zaten tanımlı: kredinin 3. taksidi, kodu X olan ürün, aynı hesaptaki aynı
 * parmak izli hareket. Bu fonksiyon o tanımı kullanır. TAHMİN DEĞİL: yalnız veritabanının
 * kendi eşsizlik kısıtlarıyla birebir örtüşen alanlarla sorgulanır.
 */
async function findByNaturalKey(
  client: PoolClient, table: string, where: Record<string, unknown>,
): Promise<string | null> {
  const names = Object.keys(where);
  if (names.some((n) => where[n] === null || where[n] === undefined)) return null;
  const r = await client.query<{ id: string }>(
    `select id from public.${table} where ${names.map((n, i) => `${n} = $${i + 1}`).join(" and ")} limit 1`,
    names.map((n) => where[n]),
  );
  return r.rowCount && r.rows[0] ? r.rows[0].id : null;
}

/** Kaynak izini her kayda aynı biçimde ekler (§26). */
const lineage = (ctx: WriteContext, withRow = true): Record<string, unknown> => ({
  source_workbook_id: ctx.workbookId,
  source_sheet_id: ctx.sheetId,
  ...(withRow ? { source_row_id: ctx.importRowId } : {}),
});

/* ── 01 · Ödemeler ───────────────────────────────────────────────────────────────────── */

const writePayment: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  // Tutar boşsa `amount_confidence = 'unknown'`. 0 YAZILMAZ: sıfır "bu ödeme bedelsiz"
  // demektir, oysa burada bilinmeyen bir tutar var.
  const amount = num(v.tutar);
  return upsertRow(ctx.client, "payments", entityId, {
    name: str(v.aciklama) ?? "(adsız ödeme)",
    description: str(v.notlar),
    category_id: await resolveCategory(ctx.client, v.kategori, "payment"),
    provider_party_id: await resolveParty(ctx.client, v.karsi_taraf, "provider"),
    recurrence_type: str(v.tekrar_tipi) ?? "monthly",
    due_day: num(v.vade_gunu),
    due_date: v.ilk_vade_tarihi ?? null,
    default_amount: amount,
    currency: str(v.para_birimi) ?? "TRY",
    amount_confidence: amount === null ? "unknown" : "known",
    status: str(v.durum) ?? "active",
    ...lineage(ctx),
  }, true);
};

/* ── 02 · Çekler ─────────────────────────────────────────────────────────────────────── */

const writeCheck: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const signed = num(v.signed_tutar);

  // İŞARET SÖZLEŞMESİ. `signed_amount` kullanıcının yazdığı gibi korunur; `amount` mutlak
  // değerdir (DB'nin check_amount_sign_consistency kısıtı ikisini bağlıyor). Yön işaretten
  // TÜRETİLİR: eksi = bizden çıkan. Sıfır ne giriş ne çıkış olduğu için 'unknown'.
  const direction = signed === null ? "unknown"
    : signed < 0 ? "outflow" : signed > 0 ? "inflow" : "unknown";

  return upsertRow(ctx.client, "checks", entityId, {
    maturity_date: v.vade_tarihi ?? null,
    serial_no: str(v.seri_no),
    payee_party_id: await resolveParty(ctx.client, v.kime, "company"),
    payer_party_id: await resolveParty(ctx.client, v.kimden, "company"),
    bank_party_id: await resolveParty(ctx.client, v.banka, "bank"),
    amount: signed === null ? null : Math.abs(signed),
    signed_amount: signed,
    direction,
    currency: str(v.para_birimi) ?? "TRY",
    status: str(v.durum) ?? "planned",
    notes: str(v.notlar),
    ...lineage(ctx),
  }, true);
};

/* ── 03 · Krediler ───────────────────────────────────────────────────────────────────── */

const writeLoan: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const principal = num(v.anapara);

  // `loans.principal` NOT NULL ve sözleşme anaparayı zorunlu işaretliyor. Buraya null
  // gelmesi parser'ın bir satırı yanlışlıkla "hazır" saymış olması demek. Sessizce 0
  // yazmıyoruz — 0 anapara "bedelsiz kredi" olurdu.
  if (principal === null) {
    throw new Error(
      `03_KREDILER satır ${row.rowIndex}: anapara boş, ama loans.principal NOT NULL. ` +
      "Sıfır yazmak veriyi uydurmak olurdu.",
    );
  }

  return upsertRow(ctx.client, "loans", entityId, {
    name: str(v.kredi_adi) ?? "(adsız kredi)",
    lender_party_id: await resolveParty(ctx.client, v.banka, "bank"),
    principal,
    currency: str(v.para_birimi) ?? "TRY",
    term_months: num(v.vade_ay),
    first_payment_date: v.ilk_odeme_tarihi ?? null,
    simple_interest_rate: num(v.baz_faiz_orani),
    applied_interest_rate: num(v.uygulanan_faiz_orani),
    monthly_cost_rate: num(v.aylik_maliyet_orani),
    annual_cost_rate: num(v.yillik_maliyet_orani),
    bsmv_rate: num(v.bsmv_orani),
    kkdf_rate: num(v.kkdf_orani),
    installment_amount: num(v.taksit_tutari),
    total_payment: num(v.toplam_odeme),
    total_finance_cost: num(v.finansman_maliyeti),
    status: str(v.durum) ?? "active",
    notes: str(v.notlar),
    ...lineage(ctx, false),   // loans tablosunda source_row_id yok
  }, true);
};

/* ── 04 · Kredi taksitleri ───────────────────────────────────────────────────────────── */

const writeLoanInstallment: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const loanCode = str(v.loan_external_id);

  // Kredi, defter üzerinden bulunur. Parser bulunamayan kodu zaten reddediyor
  // (missing_reference) ve aynı dosyada kabul edilmemiş krediye bağlı taksidi engelliyor
  // (blocked_by_parent); buraya gelen bir satırın kredisi bu dosyada VAR ve KABUL EDİLMİŞ
  // demektir. Yine de sessiz geçmiyoruz: defterde yoksa bu, aynı dosyada kredinin
  // yazılmamış olması gibi bir sıra hatasıdır ve görülmesi gerekir.
  const loanId = loanCode ? await lookupExternalKey(ctx.client, "loans", loanCode) : null;
  if (!loanId) {
    throw new Error(
      `04_KREDI_TAKSITLERI satır ${row.rowIndex}: '${loanCode ?? "(boş)"}' kodlu kredi ` +
      "defterde yok. Taksit, bağlı olduğu kredi olmadan yazılamaz.",
    );
  }

  const amount = num(v.toplam_tutar);
  if (amount === null) {
    throw new Error(
      `04_KREDI_TAKSITLERI satır ${row.rowIndex}: taksit tutarı boş, ama ` +
      "loan_installments.amount NOT NULL.",
    );
  }

  const installmentNo = num(v.taksit_no);
  // `loan_installments` (loan_id, installment_no) üzerinde eşsiz ve bu sayfada kullanıcı
  // kodu kolonu YOK. Kimlik oradan gelir: "şu kredinin şu numaralı taksidi".
  const existing = entityId
    ?? await findByNaturalKey(ctx.client, "loan_installments", { loan_id: loanId, installment_no: installmentNo });

  return upsertRow(ctx.client, "loan_installments", existing, {
    loan_id: loanId,
    installment_no: installmentNo,
    due_date: v.vade_tarihi ?? null,
    amount,
    principal_component: num(v.anapara_bileseni),
    interest_component: num(v.faiz_bileseni),
    tax_component: num(v.vergi_bileseni),
    status: str(v.durum) ?? "planned",
    paid_at: v.odeme_tarihi ?? null,
  }, false);
};

/* ── 05 · Nakit akışı ────────────────────────────────────────────────────────────────── */

/**
 * Ayı bulur, yoksa yaratır.
 *
 * `cashflow_months.month_start` eşsiz. Satırlar aya bağlanır; ayın devir/kasa alanları bu
 * import tarafından DOLDURULMAZ — onlar ayrı bir kaynaktan gelir ve buradan yazmak,
 * hesaplanmış bir bakiyeyi satır verisiyle ezmek olurdu.
 */
async function resolveCashflowMonth(
  ctx: WriteContext, monthStart_: unknown,
): Promise<string> {
  if (typeof monthStart_ !== "string" || monthStart_ === "") {
    throw new Error("05_NAKIT_AKISI: dönem boş — satır bir aya bağlanamaz.");
  }
  const first = monthStart(monthStart_);
  if (!first) {
    throw new Error(`05_NAKIT_AKISI: dönem '${String(monthStart_)}' YYYY-AA biçiminde değil.`);
  }
  // Var olan ay DOKUNULMADAN bulunur. Eski hâli `on conflict do update set month_start =
  // month_start` idi: "hiçbir şey değiştirmeyen" bir UPDATE — ama `cashflow_months`'un
  // updated_at tetikleyicisi yine ateşlenir ve gerçek yedeğin klonundaki prova (PHASE 6.2)
  // bunu yakaladı: 2026-05 ve 2026-06 aylarının updated_at'i "değişmiş" göründü, finansal
  // alanlar aynıyken. Bir ayın son değişiklik zamanı, o aya dokunmayan bir import yüzünden
  // ilerlememeli. Yarış: iki import aynı yeni ayı aynı anda yaratırsa `on conflict do nothing`
  // birine boş döner; o zaman yeniden okunur.
  const found = await ctx.client.query<{ id: string }>(
    "select id from public.cashflow_months where month_start = $1", [first]);
  if (found.rows[0]) return found.rows[0].id;
  const ins = await ctx.client.query<{ id: string }>(
    `insert into public.cashflow_months (month_start, source_workbook_id, source_sheet_id)
     values ($1, $2, $3)
     on conflict (month_start) do nothing
     returning id`,
    [first, ctx.workbookId, ctx.sheetId],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const again = await ctx.client.query<{ id: string }>(
    "select id from public.cashflow_months where month_start = $1", [first]);
  if (!again.rows[0]) throw new Error(`05_NAKIT_AKISI: ${first} ayı yaratılamadı ve bulunamadı.`);
  return again.rows[0].id;
}

const writeCashflowLine: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const amount = num(v.tutar);

  return upsertRow(ctx.client, "cashflow_lines", entityId, {
    cashflow_month_id: await resolveCashflowMonth(ctx, v.donem),
    line_type: str(v.satir_tipi) ?? "unknown",
    direction: str(v.yon) ?? "unknown",
    party_id: await resolveParty(ctx.client, v.karsi_taraf, "company"),
    label: str(v.aciklama) ?? str(v.satir_tipi) ?? "(açıklamasız kalem)",
    amount,
    // BOŞ ≠ SIFIR'ın bu tablodaki karşılığı. Tutar yoksa 'missing'; 0 yazılmışsa 'known'.
    amount_status: amount === null ? "missing" : "known",
    date_value: v.tarih ?? null,
    notes: str(v.notlar),
    source_row_id: ctx.importRowId,
  }, false);
};

/* ── 06 · Banka hesapları ────────────────────────────────────────────────────────────── */

/**
 * `bank_accounts` bağımsız bir tablo DEĞİL: birincil anahtarı `cash_account_id` ve
 * `cash_accounts`'un 1:1 uzantısı. Bu yüzden önce üst kayıt yazılır.
 *
 * Üst kayıt hesap ADIYLA eşsiz. Aynı adı taşıyan ikinci bir hesap yeni kayıt yaratmaz,
 * mevcut olanı günceller — iki "Ana vadesiz TL" hesabı, bakiyeyi ikiye bölmek demekti.
 */
const writeBankAccount: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const name = str(v.hesap_adi) ?? str(v.banka) ?? "(adsız hesap)";

  const parent = await ctx.client.query<{ id: string }>(
    `insert into public.cash_accounts (name, provider_party_id, account_type, currency, opening_balance, is_active, notes)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (name) do update set
       provider_party_id = excluded.provider_party_id,
       account_type      = excluded.account_type,
       currency          = excluded.currency,
       opening_balance   = excluded.opening_balance,
       is_active         = excluded.is_active
     returning id`,
    [name,
      await resolveParty(ctx.client, v.banka, "bank"),
      str(v.hesap_tipi) ?? "bank_account",
      str(v.para_birimi) ?? "TRY",
      num(v.acilis_bakiyesi),
      v.aktif === null || v.aktif === undefined ? true : Boolean(v.aktif),
      str(v.notlar)],
  );
  const cashAccountId = entityId ?? parent.rows[0].id;
  // Üst kayıt ada göre upsert edildiği için "yeni mi" sorusunun cevabı uzantı satırındadır.
  const before = await ctx.client.query(
    "select 1 from public.bank_accounts where cash_account_id = $1", [cashAccountId]);
  const created = before.rowCount === 0;

  // Uzantı satırı: birincil anahtar üst kaydın id'si olduğu için `upsertRow` kullanılmıyor.
  await ctx.client.query(
    `insert into public.bank_accounts
       (cash_account_id, bank_name, iban, account_number, available_balance, balance_as_of, overdraft_limit, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (cash_account_id) do update set
       bank_name         = excluded.bank_name,
       iban              = excluded.iban,
       account_number    = excluded.account_number,
       available_balance = excluded.available_balance,
       balance_as_of     = excluded.balance_as_of,
       overdraft_limit   = excluded.overdraft_limit,
       notes             = excluded.notes,
       updated_at        = now()`,
    [cashAccountId, str(v.banka), str(v.iban), str(v.hesap_no),
      num(v.guncel_bakiye), v.bakiye_tarihi ?? null, num(v.kredi_limiti), str(v.notlar)],
  );
  return { id: cashAccountId, created };
};

/* ── 07 · Banka hareketleri ──────────────────────────────────────────────────────────── */

/**
 * Aynı hareketin iki kez yazılmasını engelleyen parmak izi.
 *
 * `bank_transactions` (bank_account_id, dedupe_hash) üzerinde eşsiz. Parmak izi hareketin
 * KENDİSİNDEN üretilir — tarih, tutar, yön ve açıklama — çünkü ekstreler çoğu zaman kayıt
 * kodu taşımaz. Kullanıcının kendi kodu varsa o kullanılır: kendi kodu daha güvenilirdir.
 */
function transactionFingerprint(v: Record<string, unknown>, externalId: string | null): string {
  if (externalId) return `ext:${externalId}`;
  return ["date:" + String(v.islem_tarihi ?? ""), "amt:" + String(v.tutar ?? ""),
    "dir:" + String(v.yon ?? ""), "desc:" + String(v.aciklama ?? "").trim().toLocaleLowerCase("tr-TR")]
    .join("|");
}

const writeBankTransaction: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const accountCode = str(v.account_external_id);
  const accountId = accountCode
    ? await lookupExternalKey(ctx.client, "bank_accounts", accountCode)
    : null;
  if (!accountId) {
    throw new Error(
      `07_BANKA_HAREKETLERI satır ${row.rowIndex}: '${accountCode ?? "(boş)"}' kodlu banka ` +
      "hesabı defterde yok. Hareket, hesabı olmadan yazılamaz.",
    );
  }

  const amount = num(v.tutar);
  if (amount === null) {
    throw new Error(
      `07_BANKA_HAREKETLERI satır ${row.rowIndex}: tutar boş, ama bank_transactions.amount NOT NULL.`,
    );
  }

  // ═══ YÖN, İŞARETLE TAŞINIR ═══
  //
  // `bank_transactions.direction` ÜRETİLMİŞ bir kolon: değerini `amount`'un işaretinden
  // alıyor (amount < 0 → outflow, değilse inflow). Şablon ise işaretsiz tutar + ayrı yön
  // kolonu kullanıyor.
  //
  // Bu ikisi uzlaştırılmazsa hata SESSİZ ve AĞIR olurdu: 5.000 TL'lik bir ÖDEME artı
  // yazıldığı için veritabanınca TAHSİLAT sayılırdı. Nakit akışı, banka mutabakatı ve açık
  // hesaplaması o hareketi ters yönde toplardı; kullanıcı dosyasına doğru yönü yazmış olurdu.
  //
  // Bu yüzden yön burada işarete çevrilir ve `direction` HİÇ yazılmaz — üretilmiş bir kolona
  // değer göndermek Postgres tarafından zaten reddediliyor.
  const signedAmount = str(v.yon) === "outflow" ? -Math.abs(amount) : Math.abs(amount);

  const fingerprint = transactionFingerprint(v, row.externalId);
  // Parmak izi tam da bunun için var: aynı hesapta aynı hareket iki kez yazılmaz.
  const existingTxn = entityId
    ?? await findByNaturalKey(ctx.client, "bank_transactions", { bank_account_id: accountId, dedupe_hash: fingerprint });

  return upsertRow(ctx.client, "bank_transactions", existingTxn, {
    bank_account_id: accountId,
    txn_date: v.islem_tarihi ?? null,
    value_date: v.valor_tarihi ?? null,
    description: str(v.aciklama) ?? "(açıklamasız hareket)",
    // Ham isim olarak saklanır, taraf kaydına ÇEVRİLMEZ: ekstre açıklamasındaki isim
    // kısaltılmış ve tutarsızdır; ondan taraf üretmek yanlış eşleşme riskidir.
    counterparty_name_raw: str(v.karsi_taraf),
    amount: signedAmount,
    currency: str(v.para_birimi) ?? "TRY",
    // Kategori boşsa 'unknown'. Tahmin edilmez: açıklamadan kategori çıkarmak, kullanıcının
    // görmediği bir sınıflandırmayı finansal rapora sokmak olurdu.
    category: str(v.kategori) ?? "unknown",
    reference_no: str(v.referans_no),
    // Eşleştirme bu katmanın işi değil; her hareket eşleşmemiş başlar.
    status: "unmatched",
    dedupe_hash: fingerprint,
    notes: str(v.notlar),
    ...lineage(ctx),
  }, true);
};

/* ── 08 · Faturalar ──────────────────────────────────────────────────────────────────── */

const writeInvoice: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;

  // Üçlü tutar. Parser eksik olanın diğer ikisinden çıkarılabildiğini garanti ediyor
  // (en az ikisi dolu, dolu olanlar tutarlı); burada o aritmetik uygulanır.
  const n = num(v.net_tutar), t = num(v.vergi_tutari), g = num(v.toplam_tutar);
  const net = n ?? (g !== null && t !== null ? g - t : null);
  const tax = t ?? (g !== null && n !== null ? g - n : null);
  const gross = g ?? (n !== null && t !== null ? n + t : null);
  if (net === null || tax === null || gross === null) {
    throw new Error(
      `08_FATURALAR satır ${row.rowIndex}: net/vergi/toplam üçlüsü tamamlanamadı. ` +
      "invoices üçünü de NOT NULL istiyor.",
    );
  }

  const partyId = await resolveParty(ctx.client, v.karsi_taraf, "company");
  if (!partyId) {
    throw new Error(`08_FATURALAR satır ${row.rowIndex}: karşı taraf boş, ama invoices.party_id NOT NULL.`);
  }

  const projectCode = str(v.project_external_id);
  return upsertRow(ctx.client, "invoices", entityId, {
    direction: str(v.fatura_tipi) ?? "sales",
    // Fatura numarası boş olamaz (btrim(invoice_no) <> ''). Kullanıcı kodu varsa o, yoksa
    // satırın kaynağından türetilmiş bir yer tutucu — uydurma bir numara değil, "bu satır
    // numarasız geldi" diyen okunabilir bir işaret.
    invoice_no: str(v.fatura_no) ?? row.externalId ?? `(numarasız-satır-${row.rowIndex})`,
    party_id: partyId,
    project_id: projectCode ? await lookupExternalKey(ctx.client, "projects", projectCode) : null,
    issue_date: v.duzenleme_tarihi ?? null,
    due_date: v.vade_tarihi ?? null,
    currency: str(v.para_birimi) ?? "TRY",
    net_amount: net,
    tax_amount: tax,
    gross_amount: gross,
    // Tahsilat bu import'un konusu değil. 0 yazmak "hiç ödenmedi" demek ve şu an doğru olan
    // tek şey bu: fatura yeni kaydediliyor, tahsilat kaydı ayrı bir olay.
    paid_amount: 0,
    status: str(v.durum) ?? "draft",
    notes: str(v.notlar),
    ...lineage(ctx),
  }, true);
};

/* ── 09 · Siparişler ─────────────────────────────────────────────────────────────────── */

/**
 * `code` NOT NULL ve eşsiz olan tablolar için kod türetir.
 *
 * Sırayla: kullanıcının yazdığı kod, kendi kayıt kodu, son çare olarak addan üretilmiş
 * okunabilir bir kod. Rastgele bir kimlik ÜRETİLMEZ — kullanıcı o kodu ekranda görecek.
 */
function deriveCode(explicit: unknown, externalId: string | null, name: unknown, rowIndex: number): string {
  const e = str(explicit);
  if (e) return e;
  if (externalId) return externalId;
  const n = str(name);
  if (n) {
    const slug = n.trim().toLocaleUpperCase("tr-TR").replace(/\s+/g, "-").slice(0, 40);
    return slug;
  }
  return `SATIR-${rowIndex}`;
}

const writeOrder: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const projectCode = str(v.project_external_id);
  const code = deriveCode(v.siparis_no, row.externalId, v.karsi_taraf, row.rowIndex);
  return upsertRow(ctx.client, "orders",
    entityId ?? await findByNaturalKey(ctx.client, "orders", { code }), {
    code,
    party_id: await resolveParty(ctx.client, v.karsi_taraf, "company"),
    project_id: projectCode ? await lookupExternalKey(ctx.client, "projects", projectCode) : null,
    order_date: v.siparis_tarihi ?? null,
    notes: str(v.notlar),
  }, true);
};

/* ── 10 · Ürünler ────────────────────────────────────────────────────────────────────── */

const writeProduct: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const code = deriveCode(v.sku, row.externalId, v.urun_adi, row.rowIndex);
  return upsertRow(ctx.client, "products",
    entityId ?? await findByNaturalKey(ctx.client, "products", { code }), {
    code,
    name: str(v.urun_adi) ?? "(adsız ürün)",
    unit: str(v.birim),
    is_active: v.aktif === null || v.aktif === undefined ? true : Boolean(v.aktif),
    notes: str(v.notlar),
  }, true);
};

/* ── 11 · Projeler ───────────────────────────────────────────────────────────────────── */

const writeProject: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const code = deriveCode(null, row.externalId, v.proje_adi, row.rowIndex);
  return upsertRow(ctx.client, "projects",
    entityId ?? await findByNaturalKey(ctx.client, "projects", { code }), {
    code,
    name: str(v.proje_adi) ?? "(adsız proje)",
    party_id: await resolveParty(ctx.client, v.musteri, "customer"),
    notes: str(v.notlar),
  }, true);
};

/* ── 12 · Bütçe ──────────────────────────────────────────────────────────────────────── */

/**
 * Senaryo bir SATIR alanı değil, BÜTÇE BAŞLIĞIDIR.
 *
 * `budget_lines` bir `budgets` kaydına bağlı ve o kayıt (ad, mali yıl) ikilisiyle eşsiz.
 * "2026 base_case" bir bütçedir, "2026 worst_case" başkası. Senaryoyu satıra yazmaya
 * çalışmak, aynı bütçe içinde çelişen iki planı karıştırmak olurdu.
 */
async function resolveBudget(
  ctx: WriteContext, scenario: unknown, period: unknown, currency: unknown,
): Promise<string> {
  const name = str(scenario) ?? "import";
  const year = typeof period === "string" && /^\d{4}/.test(period)
    ? Number(period.slice(0, 4))
    : new Date().getUTCFullYear();

  const r = await ctx.client.query<{ id: string }>(
    `insert into public.budgets (name, fiscal_year, period_kind, currency)
     values ($1, $2, 'monthly', $3)
     on conflict (name, fiscal_year) do update set period_kind = public.budgets.period_kind
     returning id`,
    [name, year, str(currency) ?? "TRY"],
  );
  return r.rows[0].id;
}

const writeBudgetLine: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const amount = num(v.tutar);
  if (amount === null) {
    throw new Error(`12_BUTCE satır ${row.rowIndex}: tutar boş, ama budget_lines.amount NOT NULL.`);
  }

  return upsertRow(ctx.client, "budget_lines", entityId, {
    budget_id: await resolveBudget(ctx, v.senaryo, v.donem, v.para_birimi),
    period_start: monthStart(v.donem),
    direction: str(v.yon) ?? "expense",
    amount,
    currency: str(v.para_birimi) ?? "TRY",
    category_id: await resolveCategory(ctx.client, v.kategori, "other"),
    // Import edilen bir bütçe taslaktır. Onay ayrı bir eylemdir ve `approved_at`/`approved_by`
    // ister; toplu import kimin onayladığını bilemez.
    version_no: 1,
    version_status: "draft",
    notes: str(v.notlar),
  }, true);
};

/* ── 13 · Döviz pozisyonu ────────────────────────────────────────────────────────────── */

const writeFxPosition: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const amount = num(v.doviz_tutari);
  if (amount === null) {
    throw new Error(`13_FX_POZISYONU satır ${row.rowIndex}: döviz tutarı boş, ama fx_positions.amount NOT NULL.`);
  }
  return upsertRow(ctx.client, "fx_positions", entityId, {
    currency: str(v.para_birimi) ?? "USD",
    amount,
    position_kind: str(v.pozisyon_tipi) ?? "other",
    as_of_date: v.tarih ?? null,
    entry_rate: num(v.try_kuru),
    counterparty_party_id: await resolveParty(ctx.client, v.karsi_taraf, "company"),
    source_note: str(v.referans),
  }, true);
};

/* ── 14 · Kapasite (üretim parçaları) ────────────────────────────────────────────────── */

const writeProductionPart: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  return upsertRow(ctx.client, "production_parts", entityId, {
    part_code: str(v.parca_kodu),
    part_name: str(v.parca_adi) ?? str(v.parca_kodu) ?? "(adsız parça)",
    quantity: num(v.adet),
    // BOŞ ≠ SIFIR burada da geçerli: ölçülmemiş süre null kalır, "0 dakika" yazılmaz.
    torna_minutes: num(v.torna_dk),
    freze_minutes: num(v.freze_dk),
    ...lineage(ctx),
  }, false);
};

/* ── 16 · Makine ─────────────────────────────────────────────────────────────────────── */

const writeMachineAsset: FamilyWriter = async (ctx, row, entityId) => {
  const v = row.values;
  const name = str(v.makine_adi) ?? "(adsız makine)";
  // `machine_assets.name` eşsizdir (0010). Gerçek yedeğin klonunda prova (PHASE 6.2) bunu
  // birebir yakaladı: "Awea" zaten vardı, INSERT 23505 ile düştü ve tüm import geri alındı.
  // Ürün/proje/sipariş ile AYNI kural: kod bağlaması yoksa doğal anahtardan bulunur ve
  // bağlanır — tahmin değil, veritabanının kendi eşsizlik kısıtıyla birebir alan.
  return upsertRow(ctx.client, "machine_assets",
    entityId ?? await findByNaturalKey(ctx.client, "machine_assets", { name }), {
    name,
    purchase_cost: num(v.alis_bedeli),
    notes: str(v.notlar),
  }, false);
};

/**
 * Aile → domain yazıcısı.
 *
 * `cost` (15_MALIYET) BİLEREK YOK ve bu bir gecikme değil, bir karar. Şablon UZUN biçimde
 * (her satır bir maliyet kalemi), `cost_models` ise GENİŞ biçimde (ayda tek satır, her
 * kalem ayrı kolon). Uzunu genişe çevirmek `maliyet_kategorisi` serbest metnini kolon adına
 * eşlemeyi gerektirir; "Yemek", "yemek gideri", "YEMEK" hepsi gelir ve yanlış tahmin
 * maliyeti yanlış kolona yazıp başabaş fiyatını sessizce bozar. Gerekçe `domain-map.ts`
 * içinde kolon kolon yazılı.
 *
 * Yazıcısı olmayan aile kaybolmaz: satırları hazırlık katmanına yazılır ve sonuçta
 * `stagedOnlyFamilies` altında ADIYLA raporlanır.
 */
export const FAMILY_WRITERS: Readonly<Record<string, FamilyWriter>> = Object.freeze({
  payments: writePayment,
  checks: writeCheck,
  loans: writeLoan,
  loan_installments: writeLoanInstallment,
  cashflow: writeCashflowLine,
  bank_accounts: writeBankAccount,
  bank_transactions: writeBankTransaction,
  invoices: writeInvoice,
  orders: writeOrder,
  products: writeProduct,
  projects: writeProject,
  budget: writeBudgetLine,
  fx: writeFxPosition,
  capacity: writeProductionPart,
  machine_roi: writeMachineAsset,
});

/**
 * Sayfaların YAZILMA sırası — numara sırası değil, BAĞIMLILIK sırası.
 *
 * Bir satır başka bir sayfanın kaydına atıf yaparsa (fatura → proje, taksit → kredi,
 * hareket → hesap), atıf edilen kayıt DEFTERDE olmalı; yoksa arama boş döner ve bağ
 * kurulamaz. Numara sırası bunu garanti etmiyor: 08_FATURALAR projeye atıf yapıyor ama
 * projeler 11. sayfada.
 *
 * Bu yüzden önce atıf EDİLENLER yazılır.
 */
export const SHEET_WRITE_ORDER: readonly string[] = Object.freeze([
  "10_URUNLER",            // kimseye atıf yapmaz
  "11_PROJELER",           // 08 ve 09 buna atıf yapıyor
  "06_BANKA_HESAPLARI",    // 07 buna atıf yapıyor
  "03_KREDILER",           // 04 buna atıf yapıyor
  "01_ODEMELER",
  "02_CEKLER",
  "04_KREDI_TAKSITLERI",
  "05_NAKIT_AKISI",
  "07_BANKA_HAREKETLERI",
  "08_FATURALAR",
  "09_SIPARISLER",
  "12_BUTCE",
  "13_FX_POZISYONU",
  "14_KAPASITE",
  "15_MALIYET",
  "16_MAKINE_ROI",
]);

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

/**
 * Bir domain tablosunun kimlik kolonu.
 *
 * Neredeyse hepsinde `id`, ama `bank_accounts` istisna: o bağımsız bir tablo değil,
 * `cash_accounts`'un 1:1 uzantısı ve birincil anahtarı `cash_account_id`. Varsayılanı her
 * yere uygulamak, bayat bağlama kontrolünü tam da o tabloda "kolon yok" hatasıyla düşürürdü.
 */
const IDENTITY_COLUMN: Readonly<Record<string, string>> = Object.freeze({
  bank_accounts: "cash_account_id",
});
const identityColumn = (table: string): string => IDENTITY_COLUMN[table] ?? "id";

/**
 * Bir `(entity_table, external_id)` anahtarını İŞLEM SÜRESİNCE kilitler.
 *
 * ═══ NEDEN GEREKLİ ═══
 *
 * Kilitsiz akış şuydu:
 *
 *     defterde ara → bulunamadı → domain INSERT → defter INSERT
 *
 * İki import aynı anda koştuğunda ikisi de "bulunamadı" görür, ikisi de kayıt yaratır ve
 * ikisi de deftere yazmayı dener. Sonuç: aynı koda karşılık İKİ domain kaydı; biri deftere
 * bağlı, diğeri sahipsiz. `external_id` vaadi ("aynı kodla tekrar import mükerrer üretmez")
 * tam olarak burada kırılıyordu.
 *
 * ═══ NEDEN ADVISORY LOCK ═══
 *
 * Kilitlenecek satır HENÜZ YOK; `SELECT ... FOR UPDATE` kilitleyecek bir şey bulamaz.
 * Advisory lock var olmayan bir şeyi — bir ANAHTARI — kilitleyebilir.
 *
 * `pg_advisory_xact_lock` işlem kapsamlı: COMMIT ya da ROLLBACK ile kendiliğinden bırakılır.
 * Elle serbest bırakma yok, dolayısıyla hata yolunda unutulan kilit de yok.
 *
 * ═══ ANAHTAR TÜRETİMİ ═══
 *
 * İki argümanlı biçim (`classid`, `objid`) kullanılıyor: tablo adı ayrı bir ad alanı
 * oluşturuyor, yani `checks/EXT-1` ile `loans/EXT-1` birbirini BEKLETMEZ.
 *
 * Hash Postgres'in kendi `hashtext`'i ile SQL tarafında hesaplanıyor. JavaScript tarafında
 * 64-bit hash üretmeye çalışmak `Number`'ın 53-bit hassasiyeti yüzünden sessizce yanlış
 * anahtar üretebilirdi. Değerler parametre olarak geçiyor; SQL metnine hiçbir kullanıcı
 * verisi karışmıyor.
 *
 * Hash çakışması yalnız GEREKSİZ SERİLEŞTİRME yaratır — iki alakasız anahtar sırayla işlenir.
 * Doğruluk bozulmaz; kilit doğruluğun kaynağı değil, kilit ALTINDA yapılan yeniden arama
 * doğruluğun kaynağıdır.
 */
async function lockExternalKey(
  client: PoolClient, entityTable: string, externalId: string,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    [entityTable, externalId]);
}

async function lookupExternalKey(
  client: PoolClient, entityTable: string, externalId: string,
): Promise<string | null> {
  const r = await client.query<{ entity_id: string }>(
    "select entity_id from public.import_external_keys where entity_table = $1 and external_id = $2",
    [entityTable, externalId],
  );
  return r.rowCount && r.rows[0] ? r.rows[0].entity_id : null;
}

/**
 * Bağlamayı yazar ve DEĞİŞMEZİ KORUR: bir kod tek bir kayda aittir.
 *
 * Çakışma durumunda eskiden yalnız `last_seen_workbook_id` güncellenip devam ediliyordu.
 * Bu, kodun işaret ettiği kaydın SESSİZCE DEĞİŞMESİNE izin veriyordu: kullanıcının
 * "ODM-KIRA" diye bildiği kayıt geçmişini kaybeder, eski kayıt sahipsiz kalırdı.
 *
 * Artık çakışmada mevcut bağlama okunur ve aynı kayda mı işaret ettiği doğrulanır. Değilse
 * hata verilir ve işlem geri alınır — bağlama DEĞİŞMEZ.
 */
async function recordExternalKey(
  client: PoolClient, entityTable: string, externalId: string,
  entityId: string, workbookId: string,
): Promise<void> {
  const r = await client.query<{ entity_id: string }>(
    `insert into public.import_external_keys
       (entity_table, external_id, entity_id, first_seen_workbook_id, last_seen_workbook_id)
     values ($1,$2,$3,$4,$4)
     on conflict (entity_table, external_id)
       do update set last_seen_workbook_id = excluded.last_seen_workbook_id
     returning entity_id`,
    [entityTable, externalId, entityId, workbookId],
  );

  // `returning` çakışmada MEVCUT satırın entity_id'sini verir; eşit değilse bağlama
  // değiştirilmek isteniyor demektir.
  const bound = r.rows[0]?.entity_id;
  if (bound !== entityId) {
    throw new ExternalKeyBindingConflictError(entityTable, externalId, bound ?? "(okunamadı)", entityId);
  }
}

/**
 * Bir sayfanın YALNIZ sayfa düzeyi sorunları — satır sorunları hariç.
 *
 * `SheetResult.issues` hem sayfa düzeyi sorunları hem de o sayfanın tüm satır sorunlarını
 * biriktiriyor. Ayrım nesne kimliğiyle yapılır, alanlara bakarak değil: satır sorunları
 * `row.issues` ile `sheet.issues` arasında AYNI nesnelerdir. Alan karşılaştırması
 * (`row === undefined` gibi) yanlış olurdu — bilinmeyen başlık sayfa düzeyi bir sorun
 * olduğu hâlde `row: 1` taşıyor.
 */
function sheetLevelIssues(sheet: SheetResult): Issue[] {
  const satirSorunlari = new Set<Issue>(sheet.rows.flatMap((r) => r.issues));
  return sheet.issues.filter((i) => !satirSorunlari.has(i));
}

/**
 * Sayfaları YAZILMA sırasına dizer.
 *
 * `SHEET_WRITE_ORDER`'da olmayan bir sayfa (sözleşmeye yeni eklenmiş ve sıraya yazılmamış)
 * sessizce atlanmaz — sona alınır ve `unorderedSheets` ile raporlanır. Sessiz atlama, o
 * ailenin verisinin kaybolması demekti.
 */
function inWriteOrder(sheets: SheetResult[]): { ordered: SheetResult[]; unordered: string[] } {
  const rank = new Map(SHEET_WRITE_ORDER.map((n, i) => [n, i]));
  const unordered = sheets.filter((s) => !rank.has(s.sheet)).map((s) => s.sheet);
  const ordered = [...sheets].sort(
    (a, b) => (rank.get(a.sheet) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.sheet) ?? Number.MAX_SAFE_INTEGER),
  );
  return { ordered, unordered };
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
    perTable: {}, stagedOnlyFamilies: [], rowsStagedOnly: 0, unorderedSheets: [],
    rowsUndetermined: 0,
    rowsMapped: 0, rowsNeedsReview: 0, rowsRejected: 0, rowsBlockedByParent: 0,
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

  const { ordered, unordered } = inWriteOrder(parsed.sheets);
  result.unorderedSheets = unordered;

  if (dryRun) {
    // Yazmadan sayım. Yazıcısı olan ailelerde "kaç kayıt yaratılır/güncellenir" sorusunun
    // cevabı defterin mevcut hâline bağlı olduğu için burada YALNIZ okuma yapılır.
    for (const sheet of ordered) {
      if (!sheet.present) continue;
      result.sheetsStaged++;
      const spec = sheetByName(sheet.sheet);
      const table = spec?.domainTable ?? null;
      const writer = FAMILY_WRITERS[sheet.family];
      if (table && !writer) stagedOnly.add(sheet.family);

      for (const row of sheet.rows) {
        result.rowsStaged++;
        if (row.status === "rejected") { result.rowsRejected++; continue; }
        if (row.status === "blocked_by_parent") { result.rowsBlockedByParent++; continue; }
        if (row.status === "needs_review") { result.rowsNeedsReview++; continue; }
        if (!table || !writer) { result.rowsStagedOnly++; continue; }

        // ÖNİZLEME NE BİLİR, NE BİLMEZ.
        //
        // Kullanıcı kodu olan satır için cevap kesin: defterde varsa güncellenir, yoksa
        // yaratılır. Kodu OLMAYAN satır için kesin değil — yazıcı onu doğal anahtarından
        // (ürün kodu, kredinin taksit numarası, hareketin parmak izi) bulabilir. Bunu
        // önizlemede tekrarlamak, yazma mantığını ikinci kez ve ayrı yazmak olurdu; iki
        // kopya zamanla ayrışır ve önizleme yalan söylemeye başlar.
        //
        // O yüzden burada TAHMİN EDİLMİYOR: kodsuz satırlar ayrı sayılıyor ve kullanıcıya
        // "şu kadar satırın yeni mi güncelleme mi olduğu ancak yazarken belli olur" denebiliyor.
        if (row.externalId) {
          const existing = await lookupExternalKey(client, table, row.externalId);
          bump(table, existing ? "updated" : "inserted");
        } else {
          result.rowsUndetermined++;
        }
        result.rowsMapped++;
      }
      // Gerçek yazmayla AYNI sayım: satır sorunları satırlarıyla, sayfa düzeyi sorunlar
      // bir kez. Önizleme farklı sayarsa kullanıcıya yanlış sayı gösterirdi.
      result.reviewsOpened += sheet.rows.reduce((n, r) => n + r.issues.length, 0);
      result.reviewsOpened += sheetLevelIssues(sheet).length;
    }
    result.reviewsOpened += parsed.issues.filter((i) => i.type === "unknown_sheet").length;
    result.stagedOnlyFamilies = [...stagedOnly].sort();
    return result;
  }

  const workbookId = await stageWorkbook(client, opts, parsed);
  result.workbookId = workbookId;

  let sheetIndex = 0;
  for (const sheet of ordered) {
    if (!sheet.present) continue;
    const sheetId = await stageSheet(client, workbookId, sheet, sheetIndex++);
    result.sheetsStaged++;

    const spec = sheetByName(sheet.sheet);
    const table = spec?.domainTable ?? null;
    const writer = FAMILY_WRITERS[sheet.family];
    if (table && !writer) stagedOnly.add(sheet.family);

    // ── SAYFA DÜZEYİ SORUNLAR — SATIR SORUNLARI HARİÇ ────────────────────────────────
    //
    // `SheetResult.issues` hem sayfa düzeyi sorunları (bilinmeyen başlık, eksik kolon) HEM
    // DE o sayfanın tüm satır sorunlarını biriktiriyor. Bir süre buradan hepsi yazılıyordu
    // ve her satır sorunu inceleme kuyruğuna İKİ KEZ giriyordu: bir kez satırına bağlı,
    // bir kez satırsız. İkinci kopya kuyruğu iki katına çıkarıp "hangi satır?" sorusunu
    // cevapsız bırakıyordu — inceleme kuyruğunun tek işi o soruyu cevaplamak.
    //
    // Ayrım nesne kimliğiyle yapılır, alanlara bakarak değil: satır sorunları `row.issues`
    // ile `sheet.issues` arasında AYNI nesnelerdir. Alan karşılaştırması (`row === undefined`
    // gibi) yanlış olurdu — bilinmeyen başlık sayfa düzeyi bir sorun olduğu hâlde `row: 1`
    // taşıyor.
    for (const issue of sheetLevelIssues(sheet)) {
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
        // ═══ KANONİK SIRA — ARAMADAN ÖNCE KİLİT ═══
        //
        //   1. anahtarı kilitle (işlem kapsamlı)
        //   2. defterde YENİDEN ara (kilit elde tutulurken)
        //   3. bağlama varsa TAM O kaydı güncelle, yoksa yarat
        //   4. bağlamayı yaz/doğrula
        //
        // Kilitten ÖNCE yapılan bir arama sonucu güvenilir değildir: iki import arasında
        // pencere açık kalır ve ikisi de "yok" görüp ayrı kayıt yaratır. Bu yüzden arama
        // kilit altında tekrarlanıyor — kilidin tek işi o aramayı anlamlı kılmak.
        let existing: string | null = null;
        if (row.externalId) {
          await lockExternalKey(client, table, row.externalId);
          existing = await lookupExternalKey(client, table, row.externalId);

          // Defter bir kayda işaret ediyorsa O KAYIT GERÇEKTEN VAR MI? Bu soru yazmadan
          // ÖNCE ve açıkça sorulur. `UPDATE`'in 0 satır etkilemesinden geriye doğru
          // çıkarım yapmak da mümkündü, ama o zaman hata "0 satır güncellendi" gibi
          // teşhis edilemez bir mesaj olurdu; burada hangi kod hangi kayda bağlıydı
          // bilgisiyle birlikte söylenebiliyor.
          //
          // Tablo adı sözleşme sabitinden geliyor (spec.domainTable), kullanıcı verisinden
          // değil; kimlik parametre olarak geçiyor.
          if (existing) {
            const alive = await client.query(
              `select 1 from public.${table} where ${identityColumn(table)} = $1`, [existing]);
            if (alive.rowCount !== 1) {
              throw new StaleExternalKeyBindingError(table, row.externalId, existing);
            }
          }
        }

        const outcome = await writer({ client, workbookId, sheetId, importRowId }, row, existing);
        entityId = outcome.id;
        bump(table, outcome.created ? "inserted" : "updated");
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
      // Üst kaydı bu dosyada kabul edilmemiş satır: yazıcıya HİÇ gitmedi (yalnız "ready"
      // gider), sebebi `row.issues` üzerinden inceleme kaydı olarak yukarıda açıldı.
      if (row.status === "blocked_by_parent") result.rowsBlockedByParent++;

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
      // PHASE 4 §4.5 "source provenance = present": dosya özeti audit satırında da durur —
      // source_workbooks silinse/değişse bile iz kaydı hangi baytların yazıldığını söyler.
      fileSha256: opts.fileSha256 ?? null,
      schema: { name: parsed.schemaName, version: parsed.schemaVersion, template: parsed.templateVersion },
      sheets: result.sheetsStaged,
      rowsStaged: result.rowsStaged,
      rowsMapped: result.rowsMapped,
      rowsNeedsReview: result.rowsNeedsReview,
      rowsRejected: result.rowsRejected,
      rowsBlockedByParent: result.rowsBlockedByParent,
      rowsStagedOnly: result.rowsStagedOnly,
      stagedOnlyFamilies: result.stagedOnlyFamilies,
      unorderedSheets: result.unorderedSheets,
      reviewsOpened: result.reviewsOpened,
      perTable: result.perTable,
    },
  });

  return result;
}
