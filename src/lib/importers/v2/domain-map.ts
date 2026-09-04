// Standart Import V2 — sözleşme kolonu → veritabanı kolonu eşlemesi.
//
// ═══ NEDEN AYRI BİR DOSYA ═══
//
// Eşleme bir süre `contract.ts` içinde `domainField` olarak dağınık duruyordu ve yalnız 187
// kolonun 28'inde vardı. Dağınık olması iki şeyi gizliyordu: hangi kolonun nereye gittiğini
// ve — daha önemlisi — HANGİ KOLONUN HİÇBİR YERE GİTMEDİĞİNİ.
//
// Bu dosya her kolon için TEK bir karar taşır ve `assertComplete()` eksik ya da fazla kaydı
// hata olarak verir. Yani "unuttum" diye bir durum kalmıyor: yeni bir kolon eklendiğinde
// karar verilene kadar testler kırmızı.
//
// ═══ DÖRT KARAR TÜRÜ ═══
//
//   domain          → doğrudan bir domain kolonuna yazılır
//   parent          → üst kayda yazılır (cash_accounts, budgets, cashflow_months)
//   ledger          → external_id; domain satırına değil, import_external_keys'e (0088)
//   not_persisted   → veritabanında karşılığı YOK; ham hâliyle import_rows'ta kalır
//
// `not_persisted` bir eksiklik itirafıdır ve öyle olması gerekiyor. Alternatifi, kullanıcının
// doldurduğu bir alanı sessizce çöpe atmaktı. Her birinin yanında SEBEBİ yazılı; sebep
// çoğunlukla "şema o veriyi başka bir şekilde modelliyor" ya da "o alan için tasarlanmış bir
// tablo henüz yok".
import { DATA_SHEETS } from "./contract";

export type ColumnTarget =
  | { kind: "domain"; field: string }
  | { kind: "parent"; field: string }
  | { kind: "ledger" }
  | { kind: "not_persisted"; reason: string };

const d = (field: string): ColumnTarget => ({ kind: "domain", field });
const p = (field: string): ColumnTarget => ({ kind: "parent", field });
const LEDGER: ColumnTarget = { kind: "ledger" };
const no = (reason: string): ColumnTarget => ({ kind: "not_persisted", reason });

/** Sık tekrar eden sebepler — aynı gerekçe her yerde aynı kelimelerle yazılsın diye. */
const NO_CURRENCY_COLUMN = (table: string): string =>
  `${table} para birimi saklamıyor; bu tablodaki tutarlar şirketin ana para birimi (TRY) kabul ediliyor.`;
const NO_NOTES_COLUMN = (table: string): string =>
  `${table} tablosunda serbest not kolonu yok. Not, kaynak satırda (import_rows.row_json) korunur.`;

export const COLUMN_TARGETS: Readonly<Record<string, ColumnTarget>> = Object.freeze({
  /* ── 01_ODEMELER → payments ──────────────────────────────────────────────────────── */
  "01_ODEMELER.external_id": LEDGER,
  "01_ODEMELER.aciklama": d("payments.name"),
  "01_ODEMELER.karsi_taraf": d("payments.provider_party_id"),
  "01_ODEMELER.kategori": d("payments.category_id"),
  "01_ODEMELER.vade_gunu": d("payments.due_day"),
  "01_ODEMELER.ilk_vade_tarihi": d("payments.due_date"),
  "01_ODEMELER.tutar": d("payments.default_amount"),
  "01_ODEMELER.para_birimi": d("payments.currency"),
  "01_ODEMELER.tekrar_tipi": d("payments.recurrence_type"),
  "01_ODEMELER.durum": d("payments.status"),
  // Ödemenin kendisi süresizdir; taksitli/dönemli bir şeyin başlangıcı ve bitişi varsa o
  // kredi ya da sözleşmedir. `payments` bu yüzden tarih aralığı taşımıyor.
  "01_ODEMELER.baslangic_tarihi": no("payments tablosunda başlangıç tarihi kolonu yok."),
  "01_ODEMELER.bitis_tarihi": no("payments tablosunda bitiş tarihi kolonu yok."),
  "01_ODEMELER.notlar": d("payments.description"),

  /* ── 02_CEKLER → checks ──────────────────────────────────────────────────────────── */
  "02_CEKLER.external_id": LEDGER,
  "02_CEKLER.seri_no": d("checks.serial_no"),
  "02_CEKLER.vade_tarihi": d("checks.maturity_date"),
  "02_CEKLER.kime": d("checks.payee_party_id"),
  "02_CEKLER.kimden": d("checks.payer_party_id"),
  "02_CEKLER.banka": d("checks.bank_party_id"),
  "02_CEKLER.signed_tutar": d("checks.signed_amount"),
  // Migration 0090 ile eklendi. Öncesinde bu kolon yoktu ve bir USD çek TRY gibi kaydediliyordu.
  "02_CEKLER.para_birimi": d("checks.currency"),
  "02_CEKLER.durum": d("checks.status"),
  "02_CEKLER.notlar": d("checks.notes"),

  /* ── 03_KREDILER → loans ─────────────────────────────────────────────────────────── */
  "03_KREDILER.external_id": LEDGER,
  "03_KREDILER.kredi_adi": d("loans.name"),
  "03_KREDILER.banka": d("loans.lender_party_id"),
  "03_KREDILER.anapara": d("loans.principal"),
  "03_KREDILER.para_birimi": d("loans.currency"),
  "03_KREDILER.vade_ay": d("loans.term_months"),
  "03_KREDILER.baz_faiz_orani": d("loans.simple_interest_rate"),
  "03_KREDILER.uygulanan_faiz_orani": d("loans.applied_interest_rate"),
  "03_KREDILER.bsmv_orani": d("loans.bsmv_rate"),
  "03_KREDILER.kkdf_orani": d("loans.kkdf_rate"),
  "03_KREDILER.ilk_odeme_tarihi": d("loans.first_payment_date"),
  "03_KREDILER.taksit_tutari": d("loans.installment_amount"),
  "03_KREDILER.toplam_odeme": d("loans.total_payment"),
  "03_KREDILER.finansman_maliyeti": d("loans.total_finance_cost"),
  "03_KREDILER.aylik_maliyet_orani": d("loans.monthly_cost_rate"),
  "03_KREDILER.yillik_maliyet_orani": d("loans.annual_cost_rate"),
  "03_KREDILER.durum": d("loans.status"),
  "03_KREDILER.notlar": d("loans.notes"),

  /* ── 04_KREDI_TAKSITLERI → loan_installments ─────────────────────────────────────── */
  // Kredinin kodu taksit satırına metin olarak yazılmaz; krediyi bulup `loan_id` FK'sine
  // dönüşür. Bulunamayan kod parser tarafından zaten reddediliyor (missing_reference).
  "04_KREDI_TAKSITLERI.loan_external_id": d("loan_installments.loan_id"),
  "04_KREDI_TAKSITLERI.taksit_no": d("loan_installments.installment_no"),
  "04_KREDI_TAKSITLERI.vade_tarihi": d("loan_installments.due_date"),
  "04_KREDI_TAKSITLERI.anapara_bileseni": d("loan_installments.principal_component"),
  "04_KREDI_TAKSITLERI.faiz_bileseni": d("loan_installments.interest_component"),
  "04_KREDI_TAKSITLERI.vergi_bileseni": d("loan_installments.tax_component"),
  "04_KREDI_TAKSITLERI.toplam_tutar": d("loan_installments.amount"),
  "04_KREDI_TAKSITLERI.durum": d("loan_installments.status"),
  "04_KREDI_TAKSITLERI.odeme_tarihi": d("loan_installments.paid_at"),
  "04_KREDI_TAKSITLERI.notlar": no(NO_NOTES_COLUMN("loan_installments")),

  /* ── 05_NAKIT_AKISI → cashflow_lines (+ cashflow_months) ─────────────────────────── */
  "05_NAKIT_AKISI.external_id": LEDGER,
  // Dönem satırın kendisine değil, ayına yazılır: satır bir aya bağlanır (cashflow_month_id).
  "05_NAKIT_AKISI.donem": p("cashflow_months.month_start"),
  "05_NAKIT_AKISI.tarih": d("cashflow_lines.date_value"),
  "05_NAKIT_AKISI.satir_tipi": d("cashflow_lines.line_type"),
  "05_NAKIT_AKISI.karsi_taraf": d("cashflow_lines.party_id"),
  "05_NAKIT_AKISI.kategori": no("cashflow_lines satır kategorisi saklamıyor; ayrım line_type ile yapılıyor."),
  "05_NAKIT_AKISI.aciklama": d("cashflow_lines.label"),
  "05_NAKIT_AKISI.yon": d("cashflow_lines.direction"),
  "05_NAKIT_AKISI.tutar": d("cashflow_lines.amount"),
  "05_NAKIT_AKISI.para_birimi": no(NO_CURRENCY_COLUMN("cashflow_lines")),
  // Gerçekleşen/planlanan ayrımı satırda değil ayda tutuluyor (cashflow_months.confidence).
  // Aynı ayda hem gerçekleşen hem planlanan satır olabildiği için satır düzeyinde yazmak
  // ayın güven düzeyini satırdan satıra çelişkiye düşürürdü.
  "05_NAKIT_AKISI.gerceklesen_planlanan": no(
    "Gerçekleşen/planlanan ayrımı cashflow_months.confidence alanında, satır düzeyinde değil.",
  ),
  "05_NAKIT_AKISI.notlar": d("cashflow_lines.notes"),

  /* ── 06_BANKA_HESAPLARI → bank_accounts (+ cash_accounts) ────────────────────────── */
  // `bank_accounts` bağımsız bir tablo DEĞİL: birincil anahtarı `cash_account_id` ve
  // `cash_accounts`'un 1:1 uzantısı. Hesap adı, para birimi, tip ve aktiflik üst kayda gider.
  "06_BANKA_HESAPLARI.external_id": LEDGER,
  "06_BANKA_HESAPLARI.banka": d("bank_accounts.bank_name"),
  "06_BANKA_HESAPLARI.hesap_adi": p("cash_accounts.name"),
  "06_BANKA_HESAPLARI.iban": d("bank_accounts.iban"),
  "06_BANKA_HESAPLARI.hesap_no": d("bank_accounts.account_number"),
  "06_BANKA_HESAPLARI.para_birimi": p("cash_accounts.currency"),
  "06_BANKA_HESAPLARI.hesap_tipi": p("cash_accounts.account_type"),
  "06_BANKA_HESAPLARI.acilis_bakiyesi": p("cash_accounts.opening_balance"),
  "06_BANKA_HESAPLARI.guncel_bakiye": d("bank_accounts.available_balance"),
  "06_BANKA_HESAPLARI.bakiye_tarihi": d("bank_accounts.balance_as_of"),
  "06_BANKA_HESAPLARI.kredi_limiti": d("bank_accounts.overdraft_limit"),
  "06_BANKA_HESAPLARI.aktif": p("cash_accounts.is_active"),
  "06_BANKA_HESAPLARI.notlar": d("bank_accounts.notes"),

  /* ── 07_BANKA_HAREKETLERI → bank_transactions ────────────────────────────────────── */
  "07_BANKA_HAREKETLERI.external_id": LEDGER,
  "07_BANKA_HAREKETLERI.account_external_id": d("bank_transactions.bank_account_id"),
  "07_BANKA_HAREKETLERI.islem_tarihi": d("bank_transactions.txn_date"),
  "07_BANKA_HAREKETLERI.valor_tarihi": d("bank_transactions.value_date"),
  "07_BANKA_HAREKETLERI.aciklama": d("bank_transactions.description"),
  // Ham isim olarak saklanır, taraf kaydına ÇEVRİLMEZ: ekstre açıklamasındaki isim çoğu zaman
  // kısaltılmış ve tutarsızdır; ondan taraf üretmek yanlış eşleşme riskidir.
  "07_BANKA_HAREKETLERI.karsi_taraf": d("bank_transactions.counterparty_name_raw"),
  // `direction` ÜRETİLMİŞ bir kolon: veritabanı onu `amount`'un işaretinden hesaplıyor.
  // Yani yön alanı doğrudan yazılmaz, tutarın İŞARETİNE dönüşür (bkz. writeBankTransaction).
  // Kolon burada listeleniyor çünkü kullanıcının seçtiği değerin belirlediği alan budur.
  "07_BANKA_HAREKETLERI.yon": d("bank_transactions.direction"),
  "07_BANKA_HAREKETLERI.tutar": d("bank_transactions.amount"),
  "07_BANKA_HAREKETLERI.para_birimi": d("bank_transactions.currency"),
  "07_BANKA_HAREKETLERI.kategori": d("bank_transactions.category"),
  "07_BANKA_HAREKETLERI.referans_no": d("bank_transactions.reference_no"),
  "07_BANKA_HAREKETLERI.notlar": d("bank_transactions.notes"),

  /* ── 08_FATURALAR → invoices ─────────────────────────────────────────────────────── */
  "08_FATURALAR.external_id": LEDGER,
  "08_FATURALAR.fatura_tipi": d("invoices.direction"),
  "08_FATURALAR.fatura_no": d("invoices.invoice_no"),
  "08_FATURALAR.duzenleme_tarihi": d("invoices.issue_date"),
  "08_FATURALAR.vade_tarihi": d("invoices.due_date"),
  "08_FATURALAR.karsi_taraf": d("invoices.party_id"),
  "08_FATURALAR.net_tutar": d("invoices.net_amount"),
  "08_FATURALAR.vergi_tutari": d("invoices.tax_amount"),
  "08_FATURALAR.toplam_tutar": d("invoices.gross_amount"),
  "08_FATURALAR.para_birimi": d("invoices.currency"),
  "08_FATURALAR.durum": d("invoices.status"),
  "08_FATURALAR.project_external_id": d("invoices.project_id"),
  "08_FATURALAR.notlar": d("invoices.notes"),

  /* ── 09_SIPARISLER → orders ──────────────────────────────────────────────────────── */
  // `orders` bir REFERANS tablosu: kod, taraf, proje, tarih. Parasal hiçbir şey taşımıyor —
  // siparişin tutarı sisteme faturayla giriyor. Şablonun sorduğu tutar/durum/tip alanlarının
  // bu tabloda karşılığı yok.
  "09_SIPARISLER.external_id": LEDGER,
  "09_SIPARISLER.siparis_tipi": no("orders tablosunda sipariş tipi kolonu yok."),
  "09_SIPARISLER.siparis_no": d("orders.code"),
  "09_SIPARISLER.siparis_tarihi": d("orders.order_date"),
  "09_SIPARISLER.beklenen_tarih": no("orders tablosunda beklenen teslim tarihi kolonu yok."),
  "09_SIPARISLER.karsi_taraf": d("orders.party_id"),
  "09_SIPARISLER.toplam_tutar": no(
    "orders tutar saklamıyor; siparişin parasal karşılığı faturaya (invoices) yazılır.",
  ),
  "09_SIPARISLER.para_birimi": no(NO_CURRENCY_COLUMN("orders")),
  "09_SIPARISLER.durum": no("orders tablosunda durum kolonu yok; yalnız is_active var."),
  "09_SIPARISLER.project_external_id": d("orders.project_id"),
  "09_SIPARISLER.notlar": d("orders.notes"),

  /* ── 10_URUNLER → products ───────────────────────────────────────────────────────── */
  "10_URUNLER.external_id": LEDGER,
  "10_URUNLER.sku": d("products.code"),
  "10_URUNLER.urun_adi": d("products.name"),
  "10_URUNLER.kategori": no("products tablosunda kategori kolonu yok."),
  "10_URUNLER.birim": d("products.unit"),
  // Fiyat ve maliyet ZAMANLA DEĞİŞİR; ürünün üzerine tek bir değer yazmak, geçmiş bir
  // satışın hangi fiyattan yapıldığını kaybetmek olurdu. Bunun için tarihli bir fiyat
  // tablosu gerekir ve henüz yok.
  "10_URUNLER.standart_maliyet": no("products tablosunda maliyet kolonu yok; tarihli fiyat modeli henüz tasarlanmadı."),
  "10_URUNLER.satis_fiyati": no("products tablosunda fiyat kolonu yok; tarihli fiyat modeli henüz tasarlanmadı."),
  "10_URUNLER.para_birimi": no(NO_CURRENCY_COLUMN("products")),
  "10_URUNLER.aktif": d("products.is_active"),
  "10_URUNLER.notlar": d("products.notes"),

  /* ── 11_PROJELER → projects ──────────────────────────────────────────────────────── */
  "11_PROJELER.external_id": LEDGER,
  "11_PROJELER.proje_adi": d("projects.name"),
  "11_PROJELER.musteri": d("projects.party_id"),
  "11_PROJELER.baslangic_tarihi": no("projects tablosunda tarih aralığı kolonu yok."),
  "11_PROJELER.bitis_tarihi": no("projects tablosunda tarih aralığı kolonu yok."),
  "11_PROJELER.durum": no("projects tablosunda durum kolonu yok; yalnız is_active var."),
  "11_PROJELER.sozlesme_degeri": no("projects tablosunda sözleşme değeri kolonu yok."),
  "11_PROJELER.butce_maliyeti": no("projects bütçe saklamıyor; bütçe budget_lines üzerinden proje kırılımıyla tutulur."),
  "11_PROJELER.para_birimi": no(NO_CURRENCY_COLUMN("projects")),
  "11_PROJELER.notlar": d("projects.notes"),

  /* ── 12_BUTCE → budget_lines (+ budgets) ─────────────────────────────────────────── */
  // `budget_lines` bir `budgets` başlığına bağlı. Senaryo satırın kolonu değil, başlığın
  // kimliğidir: "2026 base_case" bir bütçe, "2026 worst_case" başka bir bütçedir.
  "12_BUTCE.external_id": LEDGER,
  "12_BUTCE.donem": d("budget_lines.period_start"),
  "12_BUTCE.kategori": d("budget_lines.category_id"),
  "12_BUTCE.karsi_taraf": no("budget_lines taraf kolonu taşımıyor; bütçe kalemi kategori ve kırılım üzerinden tutulur."),
  "12_BUTCE.yon": d("budget_lines.direction"),
  "12_BUTCE.tutar": d("budget_lines.amount"),
  "12_BUTCE.para_birimi": d("budget_lines.currency"),
  "12_BUTCE.senaryo": p("budgets.name"),
  "12_BUTCE.notlar": d("budget_lines.notes"),

  /* ── 13_FX_POZISYONU → fx_positions ──────────────────────────────────────────────── */
  "13_FX_POZISYONU.external_id": LEDGER,
  "13_FX_POZISYONU.tarih": d("fx_positions.as_of_date"),
  "13_FX_POZISYONU.para_birimi": d("fx_positions.currency"),
  "13_FX_POZISYONU.pozisyon_tipi": d("fx_positions.position_kind"),
  "13_FX_POZISYONU.doviz_tutari": d("fx_positions.amount"),
  "13_FX_POZISYONU.try_kuru": d("fx_positions.entry_rate"),
  // TRY karşılığı SAKLANMAZ, hesaplanır. Saklamak, kur değiştiğinde ikisinin çelişmesi
  // demekti; hangisinin doğru olduğunu kimse bilemezdi.
  "13_FX_POZISYONU.try_karsiligi": no("fx_positions TRY karşılığını saklamaz; tutar × kur olarak hesaplanır."),
  "13_FX_POZISYONU.karsi_taraf": d("fx_positions.counterparty_party_id"),
  "13_FX_POZISYONU.referans": d("fx_positions.source_note"),
  "13_FX_POZISYONU.notlar": no(NO_NOTES_COLUMN("fx_positions")),

  /* ── 14_KAPASITE → production_parts ──────────────────────────────────────────────── */
  // Parçaya ait olan parçada, atölyeye ait olan kapasite modelinde durur. Verim, çalışma
  // günü ve vardiya bir PARÇANIN özelliği değil; `capacity_models` alanlarıdır ve o tabloyu
  // bu sayfadan doldurmak, her parça satırının atölye modelini yeniden yazması olurdu.
  "14_KAPASITE.external_id": LEDGER,
  "14_KAPASITE.parca_kodu": d("production_parts.part_code"),
  "14_KAPASITE.parca_adi": d("production_parts.part_name"),
  "14_KAPASITE.adet": d("production_parts.quantity"),
  "14_KAPASITE.torna_dk": d("production_parts.torna_minutes"),
  "14_KAPASITE.freze_dk": d("production_parts.freze_minutes"),
  "14_KAPASITE.diger_operasyon_dk": no(
    "production_parts yalnız torna ve freze süresi taşıyor; diğer operasyonlar için kolon yok.",
  ),
  "14_KAPASITE.satis_fiyati": no("production_parts fiyat saklamıyor."),
  "14_KAPASITE.para_birimi": no(NO_CURRENCY_COLUMN("production_parts")),
  "14_KAPASITE.verim_orani": no("Verim atölyenin özelliği (capacity_models.efficiency_rate), parçanın değil."),
  "14_KAPASITE.calisma_gunu": no("Çalışma günü atölyenin özelliği (capacity_models.work_days_per_month)."),
  "14_KAPASITE.vardiya_sayisi": no("Vardiya atölyenin özelliği; production_parts'ta karşılığı yok."),
  "14_KAPASITE.notlar": no(NO_NOTES_COLUMN("production_parts")),

  /* ── 15_MALIYET → cost_models ────────────────────────────────────────────────────── */
  // ═══ BU AİLE BİLEREK YAZILMIYOR: ŞEKİL UYUŞMAZLIĞI ═══
  //
  // Şablon UZUN biçimde: her satır bir maliyet kalemi ("yemek", "servis", "sigorta"…).
  // `cost_models` ise GENİŞ biçimde: ayda TEK satır, her maliyet kalemi ayrı bir kolon
  // (food_daily_cost, transport_staff_daily_cost, health_insurance_cost…).
  //
  // Uzunu genişe çevirmek, `maliyet_kategorisi` metnini kolon adına eşlemeyi gerektirir.
  // O metin serbest: "Yemek", "yemek gideri", "YEMEK" hepsi gelir. Eşleme tahmini olurdu ve
  // yanlış tahmin, maliyeti yanlış kolona yazıp başabaş fiyatını bozardı — sessizce.
  //
  // Doğru çözüm sabit kategori sözlüğü olan ayrı bir sayfa ya da uzun biçimi kabul eden bir
  // maliyet tablosu. İkisi de tasarım işi; buraya sıkıştırılmaz.
  "15_MALIYET.external_id": LEDGER,
  "15_MALIYET.senaryo": no("cost_models geniş biçimde; şablonun uzun biçimi eşlenemiyor (bkz. dosya notu)."),
  "15_MALIYET.maliyet_kategorisi": no("Serbest metin kategori, cost_models'in sabit kolonlarına tahminle eşlenemez."),
  "15_MALIYET.aciklama": no("cost_models satır açıklaması taşımıyor."),
  "15_MALIYET.aylik_tutar": no("Tutarın hangi cost_models kolonuna gideceği kategoriye bağlı; eşleme tahmini olurdu."),
  "15_MALIYET.para_birimi": no(NO_CURRENCY_COLUMN("cost_models")),
  "15_MALIYET.personel_sayisi": no("Personel sayısı capacity_models.staff_count alanında."),
  "15_MALIYET.aylik_calisma_saati": no("Aylık çalışma saati capacity_models.monthly_hours alanında."),
  "15_MALIYET.verim_orani": no("Verim capacity_models.efficiency_rate alanında."),
  "15_MALIYET.notlar": no(NO_NOTES_COLUMN("cost_models")),

  /* ── 16_MAKINE_ROI → machine_assets ──────────────────────────────────────────────── */
  // Makinenin KİMLİĞİ yazılır; getirisi yazılmaz. `machine_roi_snapshots` YILLIK anlık
  // görüntü tutuyor (snapshot_year, revenue, cost, tax, net_after_tax); şablon ise AYLIK
  // değerler soruyor. Aylığı yıllığa çevirmek 12 ile çarpmak demekti — bu, ölçülmemiş bir
  // sayı uydurmaktır.
  "16_MAKINE_ROI.external_id": LEDGER,
  "16_MAKINE_ROI.makine_adi": d("machine_assets.name"),
  "16_MAKINE_ROI.makine_kodu": no("machine_assets tablosunda kod kolonu yok."),
  "16_MAKINE_ROI.alis_tarihi": no("machine_assets alış tarihi saklamıyor."),
  "16_MAKINE_ROI.alis_bedeli": d("machine_assets.purchase_cost"),
  "16_MAKINE_ROI.para_birimi": no(NO_CURRENCY_COLUMN("machine_assets")),
  "16_MAKINE_ROI.aylik_gelir": no("machine_roi_snapshots YILLIK tutuyor; aylıktan yıllığa çevirmek sayı uydurmak olur."),
  "16_MAKINE_ROI.aylik_operasyon_maliyeti": no("machine_roi_snapshots YILLIK tutuyor; aylık karşılığı yok."),
  "16_MAKINE_ROI.yillik_bakim_maliyeti": no("machine_roi_snapshots ayrı bakım kalemi taşımıyor."),
  "16_MAKINE_ROI.kullanim_orani": no("machine_assets kullanım oranı saklamıyor."),
  "16_MAKINE_ROI.faydali_omur_ay": no("machine_assets faydalı ömür saklamıyor; amortisman modeli henüz yok."),
  "16_MAKINE_ROI.aktif": no("machine_assets aktiflik kolonu taşımıyor."),
  "16_MAKINE_ROI.notlar": d("machine_assets.notes"),
});

/* ── Erişim ve bütünlük ──────────────────────────────────────────────────────────────── */

export function targetFor(sheet: string, key: string): ColumnTarget | undefined {
  return COLUMN_TARGETS[`${sheet}.${key}`];
}

/** Bir sayfanın doğrudan domain'e yazılan kolonları: kanonik anahtar → kolon adı. */
export function domainColumnsFor(sheet: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(COLUMN_TARGETS)) {
    if (!k.startsWith(`${sheet}.`)) continue;
    if (t.kind === "domain") out[k.slice(sheet.length + 1)] = t.field.split(".")[1];
  }
  return out;
}

/**
 * Eşlemenin sözleşmeyle birebir örtüştüğünü doğrular.
 *
 * Eksik kayıt = sessizce çöpe atılan bir kullanıcı alanı.
 * Fazla kayıt = artık var olmayan bir kolona verilmiş karar; okuyanı yanıltır.
 */
export function assertComplete(): { checked: number } {
  const eksik: string[] = [];
  const gecerliAnahtarlar = new Set<string>();

  for (const sheet of DATA_SHEETS) {
    for (const col of sheet.columns) {
      const id = `${sheet.name}.${col.key}`;
      gecerliAnahtarlar.add(id);
      if (!(id in COLUMN_TARGETS)) eksik.push(id);
    }
  }

  const fazla = Object.keys(COLUMN_TARGETS).filter((k) => !gecerliAnahtarlar.has(k));

  if (eksik.length > 0 || fazla.length > 0) {
    throw new Error(
      "Domain eşlemesi sözleşmeyle örtüşmüyor.\n" +
      (eksik.length ? `  Kararı olmayan kolon (${eksik.length}): ${eksik.join(", ")}\n` : "") +
      (fazla.length ? `  Sözleşmede olmayan kayıt (${fazla.length}): ${fazla.join(", ")}\n` : ""),
    );
  }
  return { checked: gecerliAnahtarlar.size };
}
