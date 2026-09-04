// MAS Nakit Radar — Standart Import V2 veri sözleşmesi.
//
// NEDEN VAR. Legacy `TEMİZ.xlsx` importer'ı hücre koordinatlarına bağlı: kredi anaparası `B4`,
// aylık kasa `J1`, ödeme tutarı `AG` sütunu, vade günü ise B..AF arasında bir "X" işareti.
// Bu, dosyayı dolduran kişinin tablo geometrisini ezberlemesini gerektiriyor ve bir sütun
// kaydığında sessizce yanlış veri üretiyor. V2 bunun yerine ADLANDIRILMIŞ KOLONLAR kullanır.
//
// BU DOSYA TEK KAYNAKTIR. Şablon üreteci de parser da buradan okur; ikisi ayrı listeye
// bakmaz. Legacy importer'a hiç dokunmaz — o `IMPORT_SCHEMA_VERSION = "legacy/v1"` olarak
// çalışmaya devam eder.
//
// NULL/ZERO SÖZLEŞMESİ (release kuralı): boş hücre NULL'dır, `0` yazılmışsa gerçek sıfırdır.
// Hiçbir parser `Number(v) || 0` gibi bir ifade kullanamaz — o ifade ikisini birbirine karıştırır.

export const SCHEMA_NAME = "MAS_NAKIT_RADAR_STANDARD_IMPORT";
export const SCHEMA_VERSION = 2;
export const TEMPLATE_VERSION = "2.0.0";
export const TEMPLATE_ID = "mas-standard-import-v2";

/** Legacy workbook'lar bu sürümle işaretlenir; V2 tespiti onları etkilemez. */
export const LEGACY_SCHEMA_VERSION = "legacy/v1";

export type CellType =
  | "text"
  | "integer"
  | "decimal"
  | "money"
  | "percent"
  | "date"
  | "month"
  | "enum"
  | "boolean";

export interface ColumnSpec {
  /** Kanonik ad — domain eşlemesinde ve testlerde kullanılan anahtar. */
  key: string;
  /** Şablonda görünen Türkçe başlık. */
  header: string;
  type: CellType;
  required: boolean;
  /** `type === "enum"` için izinli değerler; Excel açılır listesi de bundan üretilir. */
  enumValues?: readonly string[];
  /** Kullanıcının yazabileceği alternatif başlıklar. AÇIK LİSTE — bulanık/AI tahmini YOK. */
  aliases?: readonly string[];
  /** Şablondaki hücre notu: alan ne demek, boş bırakılırsa ne olur. */
  note: string;
  /** Bu kolonun karşılığı olan domain alanı (dokümantasyon ve eşleyici için). */
  domainField?: string;
  width?: number;
}

export interface SheetSpec {
  /** Şablondaki sayfa adı. */
  name: string;
  /** Kanonik aile anahtarı. */
  family: string;
  /** Hedef domain tablosu (varsa). */
  domainTable: string | null;
  title: string;
  purpose: string;
  /** Bu sayfanın satırlarının bağlı olduğu üst sayfa (referential integrity). */
  referencesSheet?: string;
  columns: readonly ColumnSpec[];
}

/* ── Ortak enum'lar ──────────────────────────────────────────────────────────────────── */

export const CURRENCIES = ["TRY", "USD", "EUR", "GBP"] as const;
export const DIRECTIONS = ["inflow", "outflow"] as const;
export const RECURRENCE = ["monthly", "weekly", "yearly", "irregular", "one_off"] as const;
export const PAYMENT_STATUS = ["active", "paused", "archived"] as const;
export const CHECK_STATUS = ["planned", "cleared", "bounced", "cancelled"] as const;
// `restructured` BİLEREK YOK. Sözleşme bir süre onu sunuyordu; `public.loans.status` CHECK'i
// ise yalnız active/closed/planned/unknown kabul ediyor. Şablonun kendi açılır listesinden
// seçilen bir değerin INSERT anında reddedilmesi, kullanıcı açısından doğru doldurduğu bir
// formun sebepsiz geri çevrilmesidir — o yüzden liste veritabanına hizalandı.
// Yapılandırılmış kredi ihtiyacı gerçek; karşılığı ayrı bir iş: `loans.status` CHECK'ini
// genişletmek ve motoru/arayüzü o duruma hazırlamak gerekir. Bu sözleşmenin işi değil.
export const LOAN_STATUS = ["active", "closed", "planned"] as const;
export const INSTALLMENT_STATUS = ["planned", "paid", "overdue", "cancelled"] as const;
// `public.cashflow_lines.line_type` CHECK'i ile birebir (yalnız 'unknown' dışarıda: onu bir
// şablonda seçenek olarak sunmak, kullanıcıdan "bilmiyorum" seçmesini istemek olurdu).
//
// `opening_balance` BİLEREK YOK. Devir bir SATIR TİPİ DEĞİL: `cashflow_months.opening_balance`
// bir ay kolonudur. Devri satır olarak yazdırmak hem CHECK tarafından reddedilirdi hem de
// veriyi toplanamayacağı yere koyardı. Devir/kasa alanlarının şablona alınması ayrı bir iş
// (ay düzeyi eşleme); bu sözleşme şimdilik yalnız satırları taşır.
export const CASHFLOW_LINE_TYPES = [
  "customer_income", "vendor_payment", "bank_balance", "credit_card", "loan_payment",
  "check_payment", "operational_cost", "tax", "transfer", "adjustment",
] as const;
export const CASHFLOW_DIRECTIONS = ["inflow", "outflow", "balance"] as const;
export const ACTUAL_OR_PLANNED = ["gerceklesen", "planlanan"] as const;
export const ACCOUNT_TYPES = ["vadesiz", "vadeli", "kredi", "pos", "diger"] as const;
export const INVOICE_TYPES = ["sales", "purchase"] as const;
export const INVOICE_STATUS = ["draft", "issued", "paid", "partial", "cancelled"] as const;
export const ORDER_TYPES = ["sales", "purchase"] as const;
export const ORDER_STATUS = ["open", "confirmed", "delivered", "cancelled"] as const;
export const PROJECT_STATUS = ["planned", "active", "completed", "cancelled"] as const;
export const BUDGET_SCENARIOS = ["budget", "forecast", "best_case", "base_case", "worst_case"] as const;
export const FX_POSITION_TYPES = ["asset", "liability", "receivable", "payable", "hedge"] as const;
export const COST_SCENARIOS = ["normal", "overtime"] as const;

/* ── Tekrar eden kolonlar ────────────────────────────────────────────────────────────── */

const externalId = (domainNote: string): ColumnSpec => ({
  key: "external_id",
  header: "Kayıt Kodu (external_id)",
  type: "text",
  required: false,
  aliases: ["external_id", "kayit_kodu", "kod", "id"],
  note:
    "Sizin kendi kayıt kodunuz. Aynı kodla tekrar import ederseniz kayıt GÜNCELLENİR, ikinci " +
    "kopya oluşmaz. Boş bırakabilirsiniz — ama o zaman sistem bu satırın daha önceki bir " +
    "satırla aynı iş kaydı olduğunu VARSAYMAZ; şüpheli benzerlikler incelemeye düşer. " +
    domainNote,
  width: 22,
});

const currency = (required = true): ColumnSpec => ({
  key: "para_birimi",
  header: "Para Birimi",
  type: "enum",
  required,
  enumValues: CURRENCIES,
  aliases: ["para_birimi", "currency", "doviz", "kur_birimi"],
  note: "TRY, USD, EUR veya GBP. Boş bırakılırsa TRY varsayılmaz — eksik kabul edilir ve incelemeye düşer.",
  width: 12,
});

const notes: ColumnSpec = {
  key: "notlar",
  header: "Notlar",
  type: "text",
  required: false,
  aliases: ["notlar", "not", "aciklama_ek", "notes"],
  note: "Serbest metin. Hesaplamaya girmez, kayıtla birlikte saklanır.",
  width: 30,
};

const amount = (key: string, header: string, note: string, required = false): ColumnSpec => ({
  key, header, type: "money", required,
  aliases: [key, "tutar", "amount", "meblag"],
  note: `${note} BOŞ = bilinmiyor (hesaplamalara katılmaz, "eksik" sayılır). 0 = gerçekten sıfır.`,
  width: 16,
});

/* ── Sayfa tanımları ─────────────────────────────────────────────────────────────────── */

export const SHEET_ODEMELER: SheetSpec = {
  name: "01_ODEMELER",
  family: "payments",
  domainTable: "payments",
  title: "Düzenli ve tek seferlik ödemeler",
  purpose: "Ödeme takvimi, vade günü, aylık ödeme yükü ve gecikme riski bu sayfadan üretilir.",
  columns: [
    externalId("Örn. kendi muhasebe kodunuz."),
    { key: "aciklama", header: "Açıklama", type: "text", required: true,
      aliases: ["aciklama", "ad", "isim", "name", "description"],
      note: "Ödemenin adı. ZORUNLU. Örn. 'MAS ELEKTRİK'.", domainField: "payments.name", width: 34 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: false,
      aliases: ["karsi_taraf", "tedarikci", "firma", "counterparty"],
      note: "Kime ödeniyor. Boş bırakılabilir.", domainField: "payments.provider_party_id", width: 24 },
    { key: "kategori", header: "Kategori", type: "text", required: false,
      aliases: ["kategori", "category", "gider_turu"],
      note: "Örn. 'enerji', 'kira'. Boşsa kategorisiz kalır.", domainField: "payments.category_id", width: 18 },
    { key: "vade_gunu", header: "Vade Günü (1-31)", type: "integer", required: false,
      aliases: ["vade_gunu", "gun", "due_day"],
      note: "Ayın kaçında ödeniyor. 1-31. Aylık tekrar için gereklidir. Boşsa tekrar tipi 'irregular' olmalıdır.",
      domainField: "payments.due_day", width: 16 },
    { key: "ilk_vade_tarihi", header: "İlk Vade Tarihi", type: "date", required: false,
      aliases: ["ilk_vade_tarihi", "vade_tarihi", "first_due_date"],
      note: "Tek seferlik ödemelerde kullanılır. YYYY-AA-GG.", domainField: "payments.due_date", width: 16 },
    amount("tutar", "Tutar", "Ödemenin tutarı."),
    currency(),
    { key: "tekrar_tipi", header: "Tekrar Tipi", type: "enum", required: true,
      enumValues: RECURRENCE, aliases: ["tekrar_tipi", "tekrar", "recurrence"],
      note: "monthly / weekly / yearly / irregular / one_off. ZORUNLU.",
      domainField: "payments.recurrence_type", width: 14 },
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: PAYMENT_STATUS, aliases: ["durum", "status"],
      note: "active / paused / archived. Boşsa 'active'.", domainField: "payments.status", width: 12 },
    { key: "baslangic_tarihi", header: "Başlangıç Tarihi", type: "date", required: false,
      aliases: ["baslangic_tarihi", "start_date"], note: "Tekrarın başladığı tarih. Boş olabilir.", width: 16 },
    { key: "bitis_tarihi", header: "Bitiş Tarihi", type: "date", required: false,
      aliases: ["bitis_tarihi", "end_date"], note: "Tekrarın bittiği tarih. Boşsa süresiz.", width: 16 },
    notes,
  ],
};

export const SHEET_CEKLER: SheetSpec = {
  name: "02_CEKLER",
  family: "checks",
  domainTable: "checks",
  title: "Çekler",
  purpose: "Vade yoğunlaşması, çek riski ve nakit çıkış takvimi bu sayfadan üretilir.",
  columns: [
    externalId("Çekin sizdeki takip kodu."),
    { key: "seri_no", header: "Seri No", type: "text", required: false,
      aliases: ["seri_no", "seri", "cek_no", "serial"],
      note: "Çek seri numarası. Varsa yazın — mükerrer tespitini kesinleştirir. Boş bırakılabilir.",
      domainField: "checks.serial_no", width: 18 },
    { key: "vade_tarihi", header: "Vade Tarihi", type: "date", required: true,
      aliases: ["vade_tarihi", "vade", "maturity_date"],
      note: "ZORUNLU. YYYY-AA-GG.", domainField: "checks.maturity_date", width: 16 },
    { key: "kime", header: "Kime", type: "text", required: false,
      aliases: ["kime", "alacakli", "payee"], note: "Çekin ödeneceği taraf.", domainField: "checks.payee_party_id", width: 22 },
    { key: "kimden", header: "Kimden", type: "text", required: false,
      aliases: ["kimden", "borclu", "payer"], note: "Çeki veren taraf.", domainField: "checks.payer_party_id", width: 22 },
    { key: "banka", header: "Banka", type: "text", required: false,
      aliases: ["banka", "bank"], note: "Çekin bankası.", domainField: "checks.bank_party_id", width: 18 },
    { key: "signed_tutar", header: "İşaretli Tutar (− ödeme / + tahsilat)", type: "money", required: true,
      aliases: ["signed_tutar", "tutar", "amount", "signed_amount"],
      note:
        "ZORUNLU. İŞARET ANLAMLIDIR: eksi (−) = sizin ödeyeceğiniz çek (outflow), " +
        "artı (+) = tahsil edeceğiniz çek (inflow). Sistem işareti KORUR, mutlak değere çevirmez.",
      domainField: "checks.signed_amount", width: 30 },
    currency(),
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: CHECK_STATUS, aliases: ["durum", "status"],
      note: "planned / cleared / bounced / cancelled. Boşsa 'planned'.", domainField: "checks.status", width: 12 },
    notes,
  ],
};

export const SHEET_KREDILER: SheetSpec = {
  name: "03_KREDILER",
  family: "loans",
  domainTable: "loans",
  title: "Krediler",
  purpose: "Kredi borcu, finansman maliyeti ve taksit yükü bu sayfadan üretilir.",
  columns: [
    externalId("Kredi sözleşme numaranız olabilir. Taksit sayfası bu kodla bağlanır."),
    { key: "kredi_adi", header: "Kredi Adı", type: "text", required: true,
      aliases: ["kredi_adi", "ad", "name"], note: "ZORUNLU.", domainField: "loans.name", width: 28 },
    { key: "banka", header: "Banka", type: "text", required: false,
      aliases: ["banka", "bank", "kurum"], note: "Krediyi veren kurum.", domainField: "loans.lender_party_id", width: 20 },
    amount("anapara", "Anapara", "Kredi tutarı.", true),
    currency(),
    { key: "vade_ay", header: "Vade (ay)", type: "integer", required: true,
      aliases: ["vade_ay", "vade", "term_months"], note: "ZORUNLU. Toplam taksit sayısı.", domainField: "loans.term_months", width: 12 },
    { key: "baz_faiz_orani", header: "Baz Faiz Oranı (%)", type: "percent", required: false,
      aliases: ["baz_faiz_orani", "faiz", "faiz_orani"], note: "Aylık baz faiz. Boşsa hesaplanmaz, uydurulmaz.",
      domainField: "loans.simple_interest_rate", width: 18 },
    { key: "uygulanan_faiz_orani", header: "Uygulanan Faiz Oranı (%)", type: "percent", required: false,
      aliases: ["uygulanan_faiz_orani", "applied_rate"], note: "Vergiler dahil edilmiş efektif faiz.",
      domainField: "loans.applied_interest_rate", width: 22 },
    { key: "bsmv_orani", header: "BSMV (%)", type: "percent", required: false,
      aliases: ["bsmv_orani", "bsmv"], note: "Banka ve Sigorta Muameleleri Vergisi oranı.", domainField: "loans.bsmv_rate", width: 12 },
    { key: "kkdf_orani", header: "KKDF (%)", type: "percent", required: false,
      aliases: ["kkdf_orani", "kkdf"], note: "Kaynak Kullanımını Destekleme Fonu oranı.", domainField: "loans.kkdf_rate", width: 12 },
    { key: "ilk_odeme_tarihi", header: "İlk Ödeme Tarihi", type: "date", required: false,
      aliases: ["ilk_odeme_tarihi", "first_payment_date"], note: "İlk taksitin vadesi.", domainField: "loans.first_payment_date", width: 18 },
    amount("taksit_tutari", "Taksit Tutarı", "Aylık taksit."),
    amount("toplam_odeme", "Toplam Ödeme", "Vade sonuna kadar ödenecek toplam."),
    amount("finansman_maliyeti", "Finansman Maliyeti", "Toplam ödeme − anapara."),
    { key: "aylik_maliyet_orani", header: "Aylık Maliyet Oranı (%)", type: "percent", required: false,
      aliases: ["aylik_maliyet_orani", "monthly_cost_rate"], note: "Boş bırakılabilir.", domainField: "loans.monthly_cost_rate", width: 20 },
    { key: "yillik_maliyet_orani", header: "Yıllık Maliyet Oranı (%)", type: "percent", required: false,
      aliases: ["yillik_maliyet_orani", "annual_cost_rate"], note: "Boş bırakılabilir — uydurulmaz.",
      domainField: "loans.annual_cost_rate", width: 20 },
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: LOAN_STATUS, aliases: ["durum", "status"], note: "active / closed / planned.",
      domainField: "loans.status", width: 14 },
    notes,
  ],
};

export const SHEET_KREDI_TAKSITLERI: SheetSpec = {
  name: "04_KREDI_TAKSITLERI",
  family: "loan_installments",
  domainTable: "loan_installments",
  title: "Kredi taksitleri",
  purpose: "Aylık taksit yükü ve nakit akışına kredi etkisi bu sayfadan gelir.",
  referencesSheet: "03_KREDILER",
  columns: [
    { key: "loan_external_id", header: "Kredi Kodu (03'ten)", type: "text", required: true,
      aliases: ["loan_external_id", "kredi_kodu", "kredi_id"],
      note: "ZORUNLU. 03_KREDILER sayfasındaki Kayıt Kodu ile birebir aynı olmalı. Bulunamazsa satır incelemeye düşer.",
      width: 24 },
    { key: "taksit_no", header: "Taksit No", type: "integer", required: true,
      aliases: ["taksit_no", "sira", "seq"], note: "ZORUNLU. 1'den başlar.", width: 12 },
    { key: "vade_tarihi", header: "Vade Tarihi", type: "date", required: true,
      aliases: ["vade_tarihi", "due_date"], note: "ZORUNLU.", width: 16 },
    amount("anapara_bileseni", "Anapara Bileşeni", "Taksitin anapara kısmı."),
    amount("faiz_bileseni", "Faiz Bileşeni", "Taksitin faiz kısmı."),
    amount("vergi_bileseni", "Vergi Bileşeni", "BSMV/KKDF kısmı."),
    amount("toplam_tutar", "Toplam Tutar", "Taksitin toplamı.", true),
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: INSTALLMENT_STATUS, aliases: ["durum", "status"], note: "planned / paid / overdue / cancelled.", width: 12 },
    { key: "odeme_tarihi", header: "Ödeme Tarihi", type: "date", required: false,
      aliases: ["odeme_tarihi", "paid_at"], note: "Ödendiyse gerçek ödeme tarihi.", width: 16 },
    notes,
  ],
};

export const SHEET_NAKIT_AKISI: SheetSpec = {
  name: "05_NAKIT_AKISI",
  family: "cashflow",
  domainTable: "cashflow_lines",
  title: "Nakit akışı satırları",
  purpose:
    "Aylık devir / gelir / gider / fark / kasa buradan HESAPLANIR. Legacy formatta bunlar " +
    "sayfa başındaki B1/D1/F1/H1/J1 hücreleriydi; V2'de her satır ayrı bir kayıt.",
  columns: [
    externalId("Bu nakit akışı satırının kodu."),
    { key: "donem", header: "Dönem (YYYY-AA)", type: "month", required: true,
      aliases: ["donem", "ay", "period", "month"],
      note: "ZORUNLU. Örn. 2026-05. Aylık özet bu alana göre gruplanır.", width: 16 },
    { key: "tarih", header: "Tarih", type: "date", required: false,
      aliases: ["tarih", "date"], note: "Gün bazlı ise tarih. Boş olabilir.", width: 14 },
    { key: "satir_tipi", header: "Satır Tipi", type: "enum", required: true,
      enumValues: CASHFLOW_LINE_TYPES, aliases: ["satir_tipi", "tip", "line_type"],
      note:
        "ZORUNLU. Bu satırın ne olduğu: müşteri tahsilatı, tedarikçi ödemesi, vergi, kredi ödemesi… " +
        "DEVİR BURAYA YAZILMAZ — ay başı bakiye bir satır tipi değil, ayın kendi alanıdır. " +
        "Kasa = devir + gelir − gider olarak SİSTEM hesaplar; siz kapanış yazmazsınız.",
      domainField: "cashflow_lines.line_type", width: 20 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: false,
      aliases: ["karsi_taraf", "musteri", "tedarikci"], note: "Kimden/kime.", width: 22 },
    { key: "kategori", header: "Kategori", type: "text", required: false,
      aliases: ["kategori", "category"], note: "Serbest kategori etiketi.", width: 18 },
    { key: "aciklama", header: "Açıklama", type: "text", required: false,
      aliases: ["aciklama", "description", "label"], note: "Satırın açıklaması.", domainField: "cashflow_lines.label", width: 30 },
    { key: "yon", header: "Yön", type: "enum", required: true,
      enumValues: CASHFLOW_DIRECTIONS, aliases: ["yon", "direction"],
      note: "ZORUNLU. inflow = gelir, outflow = gider, balance = bakiye satırı (devir gibi).",
      domainField: "cashflow_lines.direction", width: 12 },
    amount("tutar", "Tutar", "Satırın tutarı (işaretsiz — yön ayrı kolonda).", false),
    currency(),
    { key: "gerceklesen_planlanan", header: "Gerçekleşen / Planlanan", type: "enum", required: false,
      enumValues: ACTUAL_OR_PLANNED, aliases: ["gerceklesen_planlanan", "durum", "actual_planned"],
      note: "Boşsa 'planlanan' varsayılır.", width: 22 },
    notes,
  ],
};

export const SHEET_BANKA_HESAPLARI: SheetSpec = {
  name: "06_BANKA_HESAPLARI",
  family: "bank_accounts",
  domainTable: "bank_accounts",
  title: "Banka hesapları",
  purpose: "Kasa/banka bakiyesi ve kredi limiti kartları bu sayfadan beslenir.",
  columns: [
    externalId("Hesabın sizdeki kodu. 07_BANKA_HAREKETLERI bu kodla bağlanır."),
    { key: "banka", header: "Banka", type: "text", required: true,
      aliases: ["banka", "bank"], note: "ZORUNLU.", width: 20 },
    { key: "hesap_adi", header: "Hesap Adı", type: "text", required: false,
      aliases: ["hesap_adi", "account_name"], note: "Örn. 'Ana vadesiz TL'.", width: 24 },
    { key: "iban", header: "IBAN", type: "text", required: false,
      aliases: ["iban"], note: "Boş bırakılabilir.", width: 30 },
    { key: "hesap_no", header: "Hesap No", type: "text", required: false,
      aliases: ["hesap_no", "account_no"], note: "Boş bırakılabilir.", width: 18 },
    currency(),
    { key: "hesap_tipi", header: "Hesap Tipi", type: "enum", required: false,
      enumValues: ACCOUNT_TYPES, aliases: ["hesap_tipi", "account_type"], note: "vadesiz / vadeli / kredi / pos / diger.", width: 14 },
    amount("acilis_bakiyesi", "Açılış Bakiyesi", "Takibe başladığınız andaki bakiye."),
    amount("guncel_bakiye", "Güncel Bakiye", "Son bilinen bakiye."),
    { key: "bakiye_tarihi", header: "Bakiye Tarihi", type: "date", required: false,
      aliases: ["bakiye_tarihi", "balance_date"], note: "Güncel bakiyenin ait olduğu tarih.", width: 16 },
    amount("kredi_limiti", "Kredi Limiti", "Hesabın kredili mevduat limiti."),
    { key: "aktif", header: "Aktif", type: "boolean", required: false,
      aliases: ["aktif", "active"], note: "EVET / HAYIR. Boşsa aktif sayılır.", width: 10 },
    notes,
  ],
};

export const SHEET_BANKA_HAREKETLERI: SheetSpec = {
  name: "07_BANKA_HAREKETLERI",
  family: "bank_transactions",
  domainTable: "bank_transactions",
  title: "Banka hareketleri",
  purpose: "Gerçekleşen nakit akışı, mutabakat ve kategori bazlı harcama analizi.",
  referencesSheet: "06_BANKA_HESAPLARI",
  columns: [
    externalId("Bankanın referans numarası olabilir."),
    { key: "account_external_id", header: "Hesap Kodu (06'dan)", type: "text", required: true,
      aliases: ["account_external_id", "hesap_kodu"], note: "ZORUNLU. 06_BANKA_HESAPLARI ile eşleşmeli.", width: 22 },
    { key: "islem_tarihi", header: "İşlem Tarihi", type: "date", required: true,
      aliases: ["islem_tarihi", "tarih", "transaction_date"], note: "ZORUNLU.", width: 16 },
    { key: "valor_tarihi", header: "Valör Tarihi", type: "date", required: false,
      aliases: ["valor_tarihi", "valör_tarihi", "value_date"], note: "Boş olabilir.", width: 16 },
    { key: "aciklama", header: "Açıklama", type: "text", required: false,
      aliases: ["aciklama", "description"], note: "Banka ekstresindeki açıklama.", width: 34 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: false,
      aliases: ["karsi_taraf", "counterparty"], note: "Boş olabilir.", width: 22 },
    { key: "yon", header: "Yön", type: "enum", required: true,
      enumValues: DIRECTIONS, aliases: ["yon", "direction"], note: "ZORUNLU. inflow / outflow.", width: 12 },
    amount("tutar", "Tutar", "Hareket tutarı (işaretsiz).", true),
    currency(),
    { key: "kategori", header: "Kategori", type: "text", required: false,
      aliases: ["kategori", "category"], note: "Boş olabilir.", width: 18 },
    { key: "referans_no", header: "Referans No", type: "text", required: false,
      aliases: ["referans_no", "reference"], note: "Dekont/işlem referansı.", width: 20 },
    notes,
  ],
};

export const SHEET_FATURALAR: SheetSpec = {
  name: "08_FATURALAR",
  family: "invoices",
  domainTable: "invoices",
  title: "Faturalar",
  purpose: "Alacak/borç yaşlandırma, tahsilat riski ve KDV yükü.",
  columns: [
    externalId("Faturanın sizdeki kodu."),
    { key: "fatura_tipi", header: "Fatura Tipi", type: "enum", required: true,
      enumValues: INVOICE_TYPES, aliases: ["fatura_tipi", "tip", "invoice_type"],
      note: "ZORUNLU. sales = satış (alacak), purchase = alış (borç).", width: 14 },
    { key: "fatura_no", header: "Fatura No", type: "text", required: false,
      aliases: ["fatura_no", "invoice_no"], note: "Boş bırakılabilir.", width: 20 },
    { key: "duzenleme_tarihi", header: "Düzenleme Tarihi", type: "date", required: true,
      aliases: ["duzenleme_tarihi", "tarih", "issue_date"], note: "ZORUNLU.", width: 18 },
    { key: "vade_tarihi", header: "Vade Tarihi", type: "date", required: false,
      aliases: ["vade_tarihi", "due_date"], note: "Yaşlandırma bunu kullanır. Boşsa yaşlandırmaya girmez.", width: 16 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: true,
      aliases: ["karsi_taraf", "musteri", "tedarikci"], note: "ZORUNLU.", width: 24 },
    amount("net_tutar", "Net Tutar", "KDV hariç tutar."),
    amount("vergi_tutari", "Vergi Tutarı", "KDV vb."),
    amount("toplam_tutar", "Toplam Tutar", "KDV dahil tutar.", true),
    currency(),
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: INVOICE_STATUS, aliases: ["durum", "status"], note: "draft / issued / paid / partial / cancelled.", width: 12 },
    { key: "project_external_id", header: "Proje Kodu (11'den)", type: "text", required: false,
      aliases: ["project_external_id", "proje_kodu"], note: "Varsa 11_PROJELER ile eşleşmeli.", width: 22 },
    notes,
  ],
};

export const SHEET_SIPARISLER: SheetSpec = {
  name: "09_SIPARISLER",
  family: "orders",
  domainTable: "orders",
  title: "Siparişler",
  purpose: "Gelecek gelir/gider görünürlüğü ve kapasite planlaması.",
  columns: [
    externalId("Siparişin sizdeki kodu."),
    { key: "siparis_tipi", header: "Sipariş Tipi", type: "enum", required: true,
      enumValues: ORDER_TYPES, aliases: ["siparis_tipi", "tip"], note: "ZORUNLU. sales / purchase.", width: 14 },
    { key: "siparis_no", header: "Sipariş No", type: "text", required: false,
      aliases: ["siparis_no", "order_no"], note: "Boş olabilir.", width: 18 },
    { key: "siparis_tarihi", header: "Sipariş Tarihi", type: "date", required: true,
      aliases: ["siparis_tarihi", "tarih"], note: "ZORUNLU.", width: 16 },
    { key: "beklenen_tarih", header: "Beklenen Teslim", type: "date", required: false,
      aliases: ["beklenen_tarih", "expected_date"], note: "Boş olabilir.", width: 16 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: true,
      aliases: ["karsi_taraf", "musteri"], note: "ZORUNLU.", width: 24 },
    amount("toplam_tutar", "Toplam Tutar", "Sipariş tutarı.", true),
    currency(),
    { key: "durum", header: "Durum", type: "enum", required: false,
      enumValues: ORDER_STATUS, aliases: ["durum", "status"], note: "open / confirmed / delivered / cancelled.", width: 14 },
    { key: "project_external_id", header: "Proje Kodu (11'den)", type: "text", required: false,
      aliases: ["project_external_id", "proje_kodu"], note: "Varsa 11_PROJELER ile eşleşmeli.", width: 22 },
    notes,
  ],
};

export const SHEET_URUNLER: SheetSpec = {
  name: "10_URUNLER",
  family: "products",
  domainTable: "products",
  title: "Ürünler",
  purpose: "Ürün marjı ve fiyat/maliyet karşılaştırması.",
  columns: [
    externalId("Ürünün sizdeki kodu."),
    { key: "sku", header: "SKU", type: "text", required: false, aliases: ["sku", "stok_kodu"], note: "Stok kodu.", width: 18 },
    { key: "urun_adi", header: "Ürün Adı", type: "text", required: true, aliases: ["urun_adi", "ad", "name"], note: "ZORUNLU.", width: 28 },
    { key: "kategori", header: "Kategori", type: "text", required: false, aliases: ["kategori"], note: "Boş olabilir.", width: 18 },
    { key: "birim", header: "Birim", type: "text", required: false, aliases: ["birim", "unit"], note: "adet, kg, m vb.", width: 10 },
    amount("standart_maliyet", "Standart Maliyet", "Birim maliyet."),
    amount("satis_fiyati", "Satış Fiyatı", "Birim satış fiyatı."),
    currency(false),
    { key: "aktif", header: "Aktif", type: "boolean", required: false, aliases: ["aktif", "active"], note: "EVET / HAYIR.", width: 10 },
    notes,
  ],
};

export const SHEET_PROJELER: SheetSpec = {
  name: "11_PROJELER",
  family: "projects",
  domainTable: "projects",
  title: "Projeler",
  purpose: "Proje bazlı kârlılık ve bütçe/gerçekleşen karşılaştırması.",
  columns: [
    externalId("Projenin sizdeki kodu. 08 ve 09 bu kodla bağlanır."),
    { key: "proje_adi", header: "Proje Adı", type: "text", required: true, aliases: ["proje_adi", "ad"], note: "ZORUNLU.", width: 28 },
    { key: "musteri", header: "Müşteri", type: "text", required: false, aliases: ["musteri", "customer"], note: "Boş olabilir.", width: 24 },
    { key: "baslangic_tarihi", header: "Başlangıç Tarihi", type: "date", required: false, aliases: ["baslangic_tarihi"], note: "Boş olabilir.", width: 16 },
    { key: "bitis_tarihi", header: "Bitiş Tarihi", type: "date", required: false, aliases: ["bitis_tarihi"], note: "Boş olabilir.", width: 16 },
    { key: "durum", header: "Durum", type: "enum", required: false, enumValues: PROJECT_STATUS,
      aliases: ["durum", "status"], note: "planned / active / completed / cancelled.", width: 14 },
    amount("sozlesme_degeri", "Sözleşme Değeri", "Projenin geliri."),
    amount("butce_maliyeti", "Bütçe Maliyeti", "Planlanan maliyet."),
    currency(false),
    notes,
  ],
};

export const SHEET_BUTCE: SheetSpec = {
  name: "12_BUTCE",
  family: "budget",
  domainTable: "budget_lines",
  title: "Bütçe ve tahmin",
  purpose: "Bütçe/gerçekleşen sapması ve senaryo karşılaştırması.",
  columns: [
    externalId("Bütçe satırının kodu."),
    { key: "donem", header: "Dönem (YYYY-AA)", type: "month", required: true, aliases: ["donem", "ay"], note: "ZORUNLU. Örn. 2026-05.", width: 16 },
    { key: "kategori", header: "Kategori", type: "text", required: true, aliases: ["kategori"], note: "ZORUNLU.", width: 22 },
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: false, aliases: ["karsi_taraf"], note: "Boş olabilir.", width: 22 },
    { key: "yon", header: "Yön", type: "enum", required: true, enumValues: DIRECTIONS,
      aliases: ["yon", "direction"], note: "ZORUNLU. inflow / outflow.", width: 12 },
    amount("tutar", "Tutar", "Bütçelenen tutar.", true),
    currency(),
    { key: "senaryo", header: "Senaryo", type: "enum", required: true, enumValues: BUDGET_SCENARIOS,
      aliases: ["senaryo", "scenario"], note: "ZORUNLU. budget / forecast / best_case / base_case / worst_case.", width: 16 },
    notes,
  ],
};

export const SHEET_FX: SheetSpec = {
  name: "13_FX_POZISYONU",
  family: "fx",
  domainTable: "fx_positions",
  title: "Döviz pozisyonu",
  purpose: "Kur riski ve TL karşılığı görünürlüğü.",
  columns: [
    externalId("Pozisyonun kodu."),
    { key: "tarih", header: "Tarih", type: "date", required: true, aliases: ["tarih", "date"], note: "ZORUNLU.", width: 14 },
    currency(),
    { key: "pozisyon_tipi", header: "Pozisyon Tipi", type: "enum", required: true, enumValues: FX_POSITION_TYPES,
      aliases: ["pozisyon_tipi", "tip"], note: "ZORUNLU. asset / liability / receivable / payable / hedge.", width: 16 },
    amount("doviz_tutari", "Döviz Tutarı", "Yabancı para cinsinden tutar.", true),
    { key: "try_kuru", header: "TRY Kuru", type: "decimal", required: false,
      aliases: ["try_kuru", "kur", "rate"], note: "1 birim dövizin TL karşılığı. Boşsa TL karşılığı hesaplanmaz.", width: 14 },
    amount("try_karsiligi", "TRY Karşılığı", "Boş bırakırsanız ve kur verilmişse SİSTEM hesaplar (tutar × kur)."),
    { key: "karsi_taraf", header: "Karşı Taraf", type: "text", required: false, aliases: ["karsi_taraf"], note: "Boş olabilir.", width: 22 },
    { key: "referans", header: "Referans", type: "text", required: false, aliases: ["referans", "reference"], note: "Boş olabilir.", width: 20 },
    notes,
  ],
};

export const SHEET_KAPASITE: SheetSpec = {
  name: "14_KAPASITE",
  family: "capacity",
  domainTable: "production_parts",
  title: "Kapasite ve parça operasyon süreleri",
  purpose: "Makine dakikası, kapasite kullanımı ve parça kârlılığı buradan hesaplanır.",
  columns: [
    externalId("Parçanın sizdeki kodu."),
    { key: "parca_kodu", header: "Parça Kodu", type: "text", required: true, aliases: ["parca_kodu", "kod"], note: "ZORUNLU.", width: 18 },
    { key: "parca_adi", header: "Parça Adı", type: "text", required: false, aliases: ["parca_adi", "ad"], note: "Boş olabilir.", width: 26 },
    { key: "adet", header: "Adet", type: "integer", required: false, aliases: ["adet", "miktar", "quantity"],
      note: "Aylık üretim adedi. BOŞ = bilinmiyor, 0 = gerçekten üretilmiyor.", width: 12 },
    { key: "torna_dk", header: "Torna (dk)", type: "decimal", required: false, aliases: ["torna_dk", "torna"],
      note: "Parça başına torna dakikası. BOŞ = ölçülmemiş (hesaplama eksik kabul eder), 0 = torna işlemi yok.", width: 14 },
    { key: "freze_dk", header: "Freze (dk)", type: "decimal", required: false, aliases: ["freze_dk", "freze"],
      note: "Parça başına freze dakikası. BOŞ = ölçülmemiş, 0 = freze işlemi yok.", width: 14 },
    { key: "diger_operasyon_dk", header: "Diğer Operasyon (dk)", type: "decimal", required: false,
      aliases: ["diger_operasyon_dk", "diger_dk"], note: "BOŞ = ölçülmemiş, 0 = yok.", width: 20 },
    amount("satis_fiyati", "Satış Fiyatı", "Parça başına satış fiyatı."),
    currency(false),
    { key: "verim_orani", header: "Verim Oranı (%)", type: "percent", required: false,
      aliases: ["verim_orani", "verim", "efficiency"], note: "Makine verimliliği. Boş olabilir.", width: 16 },
    { key: "calisma_gunu", header: "Çalışma Günü / Ay", type: "integer", required: false,
      aliases: ["calisma_gunu", "gun"], note: "Aylık çalışma günü sayısı.", width: 18 },
    { key: "vardiya_sayisi", header: "Vardiya Sayısı", type: "integer", required: false,
      aliases: ["vardiya_sayisi", "vardiya"], note: "Günlük vardiya sayısı.", width: 16 },
    notes,
  ],
};

export const SHEET_MALIYET: SheetSpec = {
  name: "15_MALIYET",
  family: "cost",
  domainTable: "cost_models",
  title: "Sabit maliyet kalemleri",
  purpose: "Başabaş TL/dakika ve normal/mesaili senaryo karşılaştırması buradan hesaplanır.",
  columns: [
    externalId("Maliyet kaleminin kodu."),
    { key: "senaryo", header: "Senaryo", type: "enum", required: true, enumValues: COST_SCENARIOS,
      aliases: ["senaryo", "scenario"], note: "ZORUNLU. normal / overtime.", width: 14 },
    { key: "maliyet_kategorisi", header: "Maliyet Kategorisi", type: "text", required: true,
      aliases: ["maliyet_kategorisi", "kategori"], note: "ZORUNLU. Örn. 'yemek', 'servis', 'sigorta'.", width: 24 },
    { key: "aciklama", header: "Açıklama", type: "text", required: false, aliases: ["aciklama"], note: "Boş olabilir.", width: 30 },
    amount("aylik_tutar", "Aylık Tutar", "Bu kalemin aylık maliyeti.", true),
    currency(),
    { key: "personel_sayisi", header: "Personel Sayısı", type: "integer", required: false,
      aliases: ["personel_sayisi", "personel"], note: "BOŞ = bilinmiyor, 0 = personel yok.", width: 16 },
    { key: "aylik_calisma_saati", header: "Aylık Çalışma Saati", type: "decimal", required: false,
      aliases: ["aylik_calisma_saati", "calisma_saati"], note: "Efektif dakika bundan hesaplanır. Boşsa başabaş hesaplanamaz.", width: 20 },
    { key: "verim_orani", header: "Verim Oranı (%)", type: "percent", required: false,
      aliases: ["verim_orani", "verim"], note: "Boş olabilir.", width: 16 },
    notes,
  ],
};

export const SHEET_MAKINE_ROI: SheetSpec = {
  name: "16_MAKINE_ROI",
  family: "machine_roi",
  domainTable: "machine_assets",
  title: "Makine yatırım geri dönüşü",
  purpose: "Makine başına geri ödeme süresi ve yatırım kârlılığı.",
  columns: [
    externalId("Makinenin sizdeki kodu."),
    { key: "makine_adi", header: "Makine Adı", type: "text", required: true, aliases: ["makine_adi", "ad"], note: "ZORUNLU.", width: 22 },
    { key: "makine_kodu", header: "Makine Kodu", type: "text", required: false, aliases: ["makine_kodu", "kod"], note: "Boş olabilir.", width: 16 },
    { key: "alis_tarihi", header: "Alış Tarihi", type: "date", required: false, aliases: ["alis_tarihi"], note: "Boş olabilir.", width: 16 },
    amount("alis_bedeli", "Alış Bedeli", "Makinenin alış maliyeti."),
    currency(false),
    amount("aylik_gelir", "Aylık Gelir", "Makinenin ürettiği aylık gelir."),
    amount("aylik_operasyon_maliyeti", "Aylık Operasyon Maliyeti", "Elektrik, işçilik vb."),
    amount("yillik_bakim_maliyeti", "Yıllık Bakım Maliyeti", "Periyodik bakım."),
    { key: "kullanim_orani", header: "Kullanım Oranı (%)", type: "percent", required: false,
      aliases: ["kullanim_orani", "kullanim"], note: "Boş olabilir.", width: 18 },
    { key: "faydali_omur_ay", header: "Faydalı Ömür (ay)", type: "integer", required: false,
      aliases: ["faydali_omur_ay", "omur"], note: "Boş olabilir.", width: 18 },
    { key: "aktif", header: "Aktif", type: "boolean", required: false, aliases: ["aktif", "active"], note: "EVET / HAYIR.", width: 10 },
    notes,
  ],
};

/** Şablondaki veri sayfaları — sıra şablonda görünen sıradır. */
export const DATA_SHEETS: readonly SheetSpec[] = [
  SHEET_ODEMELER,
  SHEET_CEKLER,
  SHEET_KREDILER,
  SHEET_KREDI_TAKSITLERI,
  SHEET_NAKIT_AKISI,
  SHEET_BANKA_HESAPLARI,
  SHEET_BANKA_HAREKETLERI,
  SHEET_FATURALAR,
  SHEET_SIPARISLER,
  SHEET_URUNLER,
  SHEET_PROJELER,
  SHEET_BUTCE,
  SHEET_FX,
  SHEET_KAPASITE,
  SHEET_MALIYET,
  SHEET_MAKINE_ROI,
] as const;

export const README_SHEET = "00_README";
export const EXAMPLES_SHEET = "99_ORNEKLER";
export const META_SHEET = "_MAS_META";

/**
 * Bir başlığı kanonik anahtara çevirir.
 *
 * Yalnız AÇIKÇA tanımlanmış alias'lar kabul edilir. Bulanık eşleme, Levenshtein mesafesi ya da
 * model tahmini KULLANILMAZ: yanlış eşlenmiş bir tutar sütunu, hiç eşlenmemiş bir sütundan çok
 * daha tehlikelidir. Tanınmayan başlık `null` döner ve çağıran taraf `unknown_header` incelemesi
 * açar.
 */
export function normalizeHeader(sheet: SheetSpec, rawHeader: string): string | null {
  const norm = rawHeader
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/g, " ");
  for (const col of sheet.columns) {
    if (norm === col.header.trim().toLocaleLowerCase("tr-TR")) return col.key;
    if (norm === col.key.toLocaleLowerCase("tr-TR")) return col.key;
    for (const a of col.aliases ?? []) {
      if (norm === a.trim().toLocaleLowerCase("tr-TR")) return col.key;
    }
  }
  return null;
}

export function sheetByName(name: string): SheetSpec | undefined {
  return DATA_SHEETS.find((s) => s.name === name);
}
