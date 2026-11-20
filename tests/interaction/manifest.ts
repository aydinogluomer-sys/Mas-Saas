/**
 * ETKİLEŞİM KAPSAM MANİFESTOSU — "hangi kontrol NASIL doğrulanıyor" kaydı.
 *
 * ═══ BU DOSYA NİÇİN VAR ═══
 *
 * Bir kapının sessizce işe yaramaz hâle gelmesinin en kolay yolu, kapsamının kaybolmasıdır:
 * yeni bir buton eklenir, testi yazılmaz, paket yine yeşil yanar ve kimse fark etmez. Bu repoda
 * bunun somut örneği vardı — `.testsprite/button-inventory.mjs` 16 rotayı tarıyordu, uygulamada
 * 67 rota var; aradaki 51 rotanın kontrolleri hiçbir zaman "eksik" olarak RAPORLANMADI, çünkü
 * hiç KEŞFEDİLMEDİLER.
 *
 * Burada kapsam bir SÖZLEŞMEDİR: çalışma zamanı taramasında keşfedilen HER (rota, kontrol) çifti
 * aşağıdaki kurallardan tam olarak biriyle eşleşmek zorundadır. Eşleşmeyen kontrol `UNTESTED`
 * sayılır ve kapı KIRMIZI verir. Yani yeni bir buton eklendiğinde CI'ın davranışı "sessizce
 * geç" değil, "bu kontrolün nasıl doğrulandığını yaz" olur.
 *
 * ═══ DOĞRULAMA SINIFLARI VE HER BİRİNİN KANIT EŞİĞİ ═══
 *
 *   mutation      DB'den before → gerçek click → UI → DB'den after → reload → (varsa) audit izi.
 *                 DOM değişikliği TEK BAŞINA yeterli değildir. Kanıt eşiği en yüksek sınıf.
 *
 *   navigation    Gerçek click → beklenen rotaya varış + 200 + sıfır konsol/sayfa hatası.
 *                 "URL değişti" yetmez; hedef ekranın GERÇEKTEN render olduğu da ölçülür.
 *
 *   ui-state      Kalıcı durum değiştirmeyen ama kullanıcıya bir şey VAAT EDEN kontroller
 *                 (komut paletini aç, grafiği yakınlaştır, tabloyu sırala, sayfa değiştir).
 *                 Kanıt: gözlenebilir ve İSİMLENDİRİLMİŞ bir UI durumu değişikliği — "tıkladım,
 *                 hata çıkmadı" değil. Sıralama düğmesi için satır SIRASININ değişmesi,
 *                 sayfalama için görünen KAYIT KÜMESİNİN değişmesi aranır.
 *
 *   export        Dosya gerçekten indirilir, açılır ve İÇERİĞİ doğrulanır (satır/sheet/format).
 *                 "download event oluştu" kanıt sayılmaz.
 *
 *   expected-disabled  Kontrol görünür ama pasif. Gerekçesinin EKRANDA yazılı olması şart.
 *
 *   external-not-live  Dış servise bağlı; canlı doğrulanamaz. Yalnız EXTERNAL_ALLOWLIST üzerinden,
 *                      gerekçe + karar sahibi + mock kanıtı ile. Boş gerekçe kabul edilmez.
 *
 * ═══ KURAL EŞLEŞMESİ ═══
 *
 * Kurallar SIRAYLA denenir; ilk eşleşen kazanır. Bu yüzden özel kurallar genel olanlardan önce
 * gelir. Bir kuralın hiç eşleşmemesi de bir bulgudur (ölü kural) ve kapı onu da raporlar —
 * aksi hâlde manifesto zamanla gerçeğe değil, geçmişe ait olur.
 */

export type VerificationClass =
  | "mutation"
  | "navigation"
  | "ui-state"
  | "export"
  | "expected-disabled"
  | "external-not-live";

export interface CoverageRule {
  id: string;
  route?: RegExp;
  label: RegExp;
  tag?: RegExp;
  klass: VerificationClass;
  /** Bu kuralı hangi test karşılıyor — rapor bunu "kanıtın yeri" olarak basar. */
  verifiedBy: string;
  /** mutation sınıfı için: hangi tabloda hangi değişiklik bekleniyor (rapora yazılır). */
  dbEffect?: string;
}

/* ── 1) Kabuk — her rotada tekrar eden kontroller + çıkış ────────────────────────────────── */

const SHELL: CoverageRule[] = [
  {
    id: "shell/logout",
    label: /Çıkış yap/,
    tag: /^button$/,
    klass: "mutation",
    dbEffect: "sessions.revoked_at set edilir; korunan rota artık /login'e döner",
    verifiedBy: "flows.spec.ts › kabuk › çıkış oturumu GERÇEKTEN iptal eder",
  },
  {
    id: "shell/command-palette",
    label: /^(⌕)?Hızlı erişim(Ctrl K)?$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › komut paleti açılır ve kapanır",
  },
  {
    id: "shell/search",
    label: /^(ara ⌘K|⌕Ekran, cari, çek veya mizan ara…Ara⌘K)$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › arama kutusu açılır ve kapanır",
  },
  {
    id: "shell/palette-intent",
    label: /^(Tüm Akışlar|0[1-4](Veri & Mutabakat|Nakit & Ödeme|Risk, Çek & Kredi|Tahmin & Rapor))$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › komut paleti operasyonel amaç filtreleri",
  },
  {
    id: "shell/entity-consolidated",
    label: /^Konsolide Grup$/,
    tag: /^button$/,
    klass: "mutation",
    dbEffect: "mas_entity_scope çerezi consolidated olarak güncellenir",
    verifiedBy: "shell-and-cfo-closures.spec.ts › üst bar grup şirketi ve konsolide kapsam seçici",
  },
  {
    id: "shell/entity-selector",
    label: /^(MAS-HQ \(Grup\)VKN \d+|MAS-HQ|Tüzel kişilik seçin)$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › üst bar grup şirketi ve konsolide kapsam seçici",
  },
  {
    id: "shell/branch-selector",
    label: /^(Tüm Şubeler|MERKEZ|Şube veya tesis seçin)$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › üst bar şube kapsam menüsü",
  },
  {
    id: "shell/theme-toggle",
    label: /^(Washi|E-Ink)$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › Washi / E-Ink göz konforu teması anahtarı",
  },
  {
    id: "shell/density-toggle",
    label: /^(Özet|Analist)$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell-and-cfo-closures.spec.ts › Özet / Analist görünüm yoğunluğu anahtarı",
  },
  { id: "shell/mentions-bell", label: /^(Bildirimler|Mentions)\s*\d*$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › üst bar @mention bildirim çekmecesi açılır" },
  { id: "shell/locale-toggle", label: /^(TR|EN)$/, tag: /^button$/, klass: "mutation", dbEffect: "mas_locale çerezi güncellenir (tr|en)", verifiedBy: "shell-and-cfo-closures.spec.ts › üst bar TR/EN yönetici dil anahtarı" },
  { id: "shell/module-stage-pill", label: /^(Hazine & Banka|Alacak & Tahsilat|Borç, Çek & Kredi|Defter & Kârlılık|1 · Aktarım & Bağlantı|2 · Mutabakat & Mizan|3 · İnceleme & Onay|4 · Kaynak & Varsayım|1 · Durum & Süreklilik|2 · İç Kontrol & Denetim|3 · Güvenlik & Tanılama)\s*\d+$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › iki katmanlı modül aşama sekmesi aktif aşamayı değiştirir" },
  { id: "shell/module-all-routes-drawer", label: /^Tüm ekranlar \(\d+\)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › tüm modül ekranları çekmecesi açılır" },
  { id: "shell/sidebar-collapse", label: /^(‹|Menüyü daralt|Menüyü genişlet)$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › kenar çubuğu daralır/genişler" },
  { id: "shell/mobile-menu", label: /^(☰|Ana menüyü aç)$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › mobil menü açılır" },
];

/* ── 2) Grafik ve tablo kontrolleri — kalıcı durum değiştirmezler ────────────────────────── */

const CHART_AND_TABLE: CoverageRule[] = [
  { id: "chart/zoom-in", label: /^(Yakınlaştır \+|Grafiği yakınlaştır)$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › yakınlaştırma kontrolü" },
  { id: "chart/zoom-out", label: /^(Uzaklaştır −|Grafiği uzaklaştır)$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › uzaklaştırma kontrolü" },
  { id: "chart/reset", label: /^Sıfırla$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › sıfırlama kontrolü" },
  { id: "chart/focus-mode", label: /^Odak modu$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › odak modu açılır/kapanır" },
  { id: "chart/period", label: /^(3A|6A|12A|24A|Tümü)$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › dönem düğmesi aralığı değiştirir" },
  { id: "chart/granularity", label: /^(Günlük|Haftalık|Aylık|Pencere Ölçeği|Konsolide ₺|Eksene dahil et)$/, tag: /^button$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › grafik zaman çözünürlüğü ve ölçek düğmeleri" },
  {
    id: "chart/series-toggle",
    label: /^(Açılış|Kapanış|Gelir|Gider|Net hareket|Çek|Çek \/ Senet|Kredi taksiti|Kullanım|Marj|Kesinleşmiş Çıkış \(Fatura \/ Çek \/ Kredi\)|Şablon Projeksiyonu \(Planlanan\)|Beklenen Tahsilat & Çek Girişi|Gecikmiş|Kısmi|Planlı|TRY Nakit Maruziyeti \(TL Karşılığı\)|Karar Güveni \(\%\)|[A-D]: .+)(· (bu dönemde )?kayıt yok)?$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "ui-state-and-exports.spec.ts › seri düğmesi ilgili seriyi gizler/gösterir",
  },
  {
    id: "table/sort-header",
    label: /[↕▲▼]$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "ui-state-and-exports.spec.ts › sıralama başlığı satır sırasını değiştirir",
  },
  { id: "table/columns", label: /^Kolonlar$/, klass: "ui-state", verifiedBy: "shell-and-cfo-closures.spec.ts › kolon seçici görünen kolonları değiştirir" },
  { id: "table/row-menu", label: /^(⋯|İşlemler)$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › satır menüsü açılır" },
  { id: "table/pagination", label: /^(← Önceki|Sonraki →)$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › sayfalama görünen kayıt kümesini değiştirir" },
  { id: "table/a11y-disclosure", label: /^Erişilebilir veri tablosu$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › erişilebilir tablo açılır ve veri içerir" },
  { id: "chart/why", label: /^Bu sonuç neden çıktı\?$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › açıklama panelini açar" },
  { id: "calendar/goto-month", label: /^Aya git$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › aya git takvimi hedef aya taşır" },
];

/* ── 3) Filtre / görünüm uygulama ────────────────────────────────────────────────────────── */

const FILTERS: CoverageRule[] = [
  { id: "filter/saved-views-disclosure", label: /^Filtre uygula veya mevcut görünümü kaydet/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › SavedViewsBar çekmecesi açılır" },
  { id: "filter/apply-filter", label: /^Filtrele$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › filtre parametrelerini uygular" },
  { id: "filter/save-view", label: /^Görünümü Kaydet$/, tag: /^button$/, klass: "mutation", dbEffect: "saved_views satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Görünümü Kaydet saved_views satırı" },
  { id: "filter/apply", label: /^Uygula$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › filtre uygulama sonuç kümesini daraltır" },
  {
    id: "filter/free-input",
    label: /^\(etiketsiz\)$/,
    tag: /^input$/,
    klass: "ui-state",
    verifiedBy: "ui-state-and-exports.spec.ts › filtre/arama girdisi görünen satırları daraltır",
  },
  {
    id: "form/select",
    label: /.*/,
    tag: /^select$/,
    klass: "ui-state",
    verifiedBy: "ui-state-and-exports.spec.ts › form select kontrolü seçimi DOM üzerinde günceller",
  },
];

/* ── 4) Dışa aktarım — gerçek dosya ──────────────────────────────────────────────────────── */

const EXPORTS: CoverageRule[] = [
  { id: "export/csv", label: /^CSV$/, klass: "export", verifiedBy: "shell-and-cfo-closures.spec.ts › CSV indirilir, ayrıştırılır, iskelet donmaz" },
  { id: "export/excel", label: /^Excel$/, klass: "export", verifiedBy: "shell-and-cfo-closures.spec.ts › XLSX indirilir, ayrıştırılır, iskelet donmaz" },
  { id: "export/png", label: /^(png|PNG)$/, klass: "export", verifiedBy: "ui-state-and-exports.spec.ts › PNG indirilir ve gerçek PNG imzası taşır" },
  { id: "export/svg", label: /^(svg|SVG)$/, klass: "export", verifiedBy: "ui-state-and-exports.spec.ts › SVG indirilir ve XML olarak ayrıştırılır" },
  { id: "export/pdf", label: /^(pdf|PDF)$/, klass: "export", verifiedBy: "ui-state-and-exports.spec.ts › PDF indirilir ve %PDF imzası taşır" },
  { id: "export/payment-run-bank-file", route: /^\/finance\/collections$/, label: /^(pain\.001 XML|Garanti XLSX|İşBank CSV|YKredi CSV|Akbank CSV)$/, klass: "export", verifiedBy: "navigation.spec.ts & domain-mutations-finance.spec.ts › ödeme paketi banka dosyası ihracı" },
  { id: "export/document-vault-download", route: /^\/data\/documents$/, label: /^İndir$/, tag: /^a$/, klass: "export", verifiedBy: "navigation.spec.ts & domain-mutations-data-system.spec.ts › SHA-256 doğrulamalı belge indirme" },
];

/* ── 5) Mutasyonlar ve modül-içi etkileşimler ─────────────────────────────────────────────── */

const PAYMENTS: CoverageRule[] = [
  { id: "payments/mark-paid", label: /^ödendi$/, klass: "mutation", dbEffect: "payment_instances.status→paid, paid_at not null, audit_logs satırı", verifiedBy: "flows.spec.ts › ödendi → geri al" },
  { id: "payments/mark-unpaid", label: /^geri al$/, klass: "mutation", dbEffect: "payment_instances.status→unpaid, paid_at→null, audit_logs satırı", verifiedBy: "flows.spec.ts › ödendi → geri al" },
  { id: "payments/mark-partial", label: /^kısmi$/, klass: "mutation", dbEffect: "payment_instances.status→partial, paid_amount set", verifiedBy: "flows.spec.ts › kısmi ödeme" },
  { id: "payments/cancel", label: /^iptal$/, klass: "mutation", dbEffect: "payment_instances.status→cancelled + iptal nedeni", verifiedBy: "flows.spec.ts › örnek iptali" },
  { id: "payments/create", route: /^\/payments\/new$/, label: /^(kaydet|Kaydet|Oluştur|Ödemeyi kaydet)$/, klass: "mutation", dbEffect: "payments'a satır + payment_instances üretimi", verifiedBy: "flows.spec.ts › ödeme oluştur (pozitif + negatif)" },
  { id: "payments/set-amount", route: /^\/payments/, label: /^kaydet$/, klass: "mutation", dbEffect: "payment_instances.amount null→değer", verifiedBy: "flows.spec.ts › eksik tutarı kaydet" },
  { id: "payments/archive", label: /^Arşivle$/, klass: "mutation", dbEffect: "payments.status→archived (neden zorunlu)", verifiedBy: "flows.spec.ts › arşivle → geri yükle" },
  { id: "payments/restore", label: /^Geri yükle$/, klass: "mutation", dbEffect: "payments.status→active", verifiedBy: "flows.spec.ts › arşivle → geri yükle" },
  { id: "payments/currency-tab", route: /^\/payments$/, label: /^(TRY|USD|EUR)$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ödemeler döviz sekmesi" },
  { id: "payments/parchment-disclosure", route: /^\/payments$/, label: /^▸/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ödemeler katlanabilir analiz çekmeceleri" },
  { id: "payments/watchlist-filter", route: /^\/payments$/, label: /^(Tümü \(\d+\)|Yalnız Gecikenler \(\d+\)|Kritik \/ Büyük Tutar \(\d+\))$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › kritik ödeme izleme listesi filtreleri" },
  { id: "payments/inspector-trigger", route: /^\/payments(\/items)?$/, label: /^(İncele|Sentetik .+)$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ödeme sağ inceleme çekmecesi (Inspector Drawer)" },
  { id: "payments/bulk-checkbox", route: /^\/payments(\/items)?$/, label: /(kalemini seç|ödeme kalemlerini seç)$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › toplu ödeme seçim kutucuğu ve yüzen aksiyon çubuğu" },
];

const FINANCE: CoverageRule[] = [
  { id: "checks/settle", label: /^tahsil edildi$/, klass: "mutation", dbEffect: "checks.status→settled + check_events satırı", verifiedBy: "flows.spec.ts › çek tahsil/karşılıksız" },
  { id: "checks/bounce", label: /^karşılıksız$/, klass: "mutation", dbEffect: "checks.status→bounced + check_events satırı", verifiedBy: "flows.spec.ts › çek tahsil/karşılıksız" },
  { id: "checks/bordro-execute", route: /^\/finance\/checks$/, label: /^Bordroyu uygula$/, klass: "mutation", dbEffect: "check_bordros + checks durum geçişi + check_events + opsiyonel invoice_allocations/collateral_records/control_alerts", verifiedBy: "domain-mutations-finance.spec.ts › Bordroyu uygula (check_bordros + checks durum geçişi)" },
  { id: "checks/create", route: /^\/finance\/checks\/new$/, label: /^(Çeki kaydet|Çeki \/ Senedi Kaydet)$/, klass: "mutation", dbEffect: "checks'e satır", verifiedBy: "domain-mutations-finance.spec.ts › Çeki / Senedi Kaydet" },
  { id: "loans/create", route: /^\/finance\/loans\/new$/, label: /^(Krediyi ve planı oluştur|Krediyi ve Amortisman Planını Oluştur)$/, klass: "mutation", dbEffect: "loans + loan_installments satırları", verifiedBy: "domain-mutations-finance.spec.ts › Krediyi ve Amortisman Planını Oluştur" },
  { id: "counterparties/create", label: /^Karşı taraf ekle$/, klass: "mutation", dbEffect: "parties'e satır", verifiedBy: "flows.spec.ts › karşı taraf ekle" },
  { id: "fx/save", label: /^Kuru kaydet$/, klass: "mutation", dbEffect: "fx_rates'e satır", verifiedBy: "flows.spec.ts › döviz kuru kaydet" },
  { id: "fx/add-hedge", route: /^\/finance\/fx$/, label: /^Hedge kontratı ekle$/, klass: "mutation", dbEffect: "fx_positions (forward/hedge) satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Hedge kontratı ekle" },
  { id: "fx/revalue-vuk280", route: /^\/finance\/fx$/, label: /^VUK 280 Kur Değerleme Fişi Üret$/, klass: "mutation", dbEffect: "management_journal_entries VUK m.280 kur değerleme fişi + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › VUK 280 kur değerleme fişi" },
  { id: "invoices/add-line", route: /^\/finance\/invoices$/, label: /^\+ Kalem Ekle$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › çok satırlı fatura kalem ekleme" },
  { id: "invoices/draft", label: /^(Taslak oluştur|Taslak Fatura Oluştur)$/, klass: "mutation", dbEffect: "invoices'a taslak satır", verifiedBy: "domain-mutations-finance.spec.ts › Taslak Fatura Oluştur" },
  { id: "promises/detect", label: /^Kırılan sözleri tespit et$/, klass: "mutation", dbEffect: "payment_promises.status→broken (vadesi geçenler)", verifiedBy: "flows.spec.ts › kırılan söz tespiti" },
  { id: "promises/save", label: /^Sözü kaydet$/, klass: "mutation", dbEffect: "payment_promises'a satır", verifiedBy: "flows.spec.ts › ödeme sözü kaydet" },
  { id: "bank/import", route: /^\/finance\/bank$/, label: /^İçe aktar$/, klass: "mutation", dbEffect: "bank_transactions satırları", verifiedBy: "flows.spec.ts › banka ekstresi içe aktar" },
  { id: "bank/create-account-opening", route: /^\/finance\/bank$/, label: /^Yeni Hesap & Açılış Bakiyesi Oluştur$/, klass: "mutation", dbEffect: "cash_accounts + bank_accounts + 500.99 management_journal_entries satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › FIN-03 açılış bakiyesi ve 500.99 denkleştirme fişi" },
  { id: "bank/match", label: /^Eşleştiriciyi çalıştır(\s*\(±\d+\s*gün\))?$/, klass: "mutation", dbEffect: "bank_transactions.matched_* alanları", verifiedBy: "flows.spec.ts › banka eşleştirici" },
  { id: "bank/save-profile", route: /^\/finance\/bank$/, label: /^Profili kaydet$/, klass: "mutation", dbEffect: "bank_import_profiles satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › banka aktarım profili kaydetme" },
  { id: "bank/save-account", route: /^\/finance\/bank$/, label: /^Kaydet$/, klass: "mutation", dbEffect: "cash_accounts satırı", verifiedBy: "flows.spec.ts › banka hesabı kaydet" },
  { id: "bank/accept-match", route: /^\/finance\/bank$/, label: /^kabul$/, klass: "mutation", dbEffect: "bank_transactions.status→matched + hedef fatura/ödeme/çek/taksit ve payment_run_items atomik kapanışı", verifiedBy: "domain-mutations-finance.spec.ts › banka eşleşmesi kabul ve atomik kapanış" },
  { id: "bank/reject-candidate", route: /^\/finance\/bank$/, label: /^reddet$/, klass: "mutation", dbEffect: "bank_transaction_match_candidates.rejected_at set", verifiedBy: "flows.spec.ts › banka eşleşme önerisi reddi" },
  { id: "bank/ignore", route: /^\/finance\/bank$/, label: /^yok say$/, klass: "mutation", dbEffect: "bank_transactions.status→ignored + ignored_reason", verifiedBy: "flows.spec.ts › banka hareketi yok sayma" },
  { id: "bank/reconcile-account", route: /^\/finance\/bank$/, label: /^Mutabakata al$/, klass: "mutation", dbEffect: "bank_transactions.status matched→reconciled + audit_logs reconcile_bank_account", verifiedBy: "domain-mutations-finance.spec.ts › banka hesabı mutabakatı" },
  { id: "collections/bad-debt-mark", route: /^\/finance\/collections$/, label: /^şüpheli işaretle$/, klass: "mutation", dbEffect: "invoices.bad_debt_flagged→true + bad_debt_reason", verifiedBy: "flows.spec.ts › şüpheli alacak işaretle/kaldır" },
  { id: "collections/bad-debt-clear", route: /^\/finance\/collections$/, label: /^işareti kaldır$/, klass: "mutation", dbEffect: "invoices.bad_debt_flagged→false", verifiedBy: "flows.spec.ts › şüpheli alacak işaretle/kaldır" },
  { id: "collections/payment-run-create", route: /^\/finance\/collections$/, label: /^([A-Z]{3}\s+)?Ödeme [Pp]aketi [Oo]luştur$/, klass: "mutation", dbEffect: "payment_runs + payment_run_items satırları + 14g kasa simülasyonu", verifiedBy: "domain-mutations-finance.spec.ts › Ödeme paketi oluştur (payment_runs + payment_run_items)" },
  { id: "collections/payment-run-submit", route: /^\/finance\/collections$/, label: /^Onaya gönder$/, klass: "mutation", dbEffect: "payment_runs.status draft→pending_approval + approvals satırı", verifiedBy: "domain-mutations-finance.spec.ts › Ödeme paketini onaya gönder" },
  { id: "collections/payment-run-approve", route: /^\/finance\/collections$/, label: /^Paketi onayla$/, klass: "mutation", dbEffect: "payment_runs.status pending_approval→approved + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Ödeme paketini onayla" },
  { id: "collections/payment-run-cancel", route: /^\/finance\/collections$/, label: /^Paketi iptal et$/, klass: "mutation", dbEffect: "payment_runs.status→cancelled + payment_run_items.status→excluded", verifiedBy: "domain-mutations-finance.spec.ts › Ödeme paketini iptal et" },
  { id: "collections/pain002-apply", route: /^\/finance\/collections$/, label: /^pain\.002 Akıbet Raporunu Uygula$/, klass: "mutation", dbEffect: "payment_run_items (ACSC→settled, RJCT→excluded) + payment_runs durum mutabakatı + audit_logs", verifiedBy: "live-connectors-and-multichannel.test.ts › applyPain002StatusToPaymentRun" },
  { id: "collections/payment-run-item-select", route: /^\/finance\/collections$/, label: /^(loan_installment|payment_instance|check|invoice):[0-9a-f-]{36}$/i, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ödeme paketi kalemi seçimi" },
  { id: "treasury/save", route: /^\/finance\/treasury$/, label: /^kaydet$/, klass: "mutation", dbEffect: "treasury/likidite ayarı satırı", verifiedBy: "flows.spec.ts › hazine ayarı kaydet" },
  { id: "treasury/upsert-account", route: /^\/finance\/treasury$/, label: /^(Hesap ekle|Kaydet)$/, klass: "mutation", dbEffect: "cash_accounts + bank_accounts + 500.99 management_journal_entries + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › hazine kasa/banka hesabı ve FIN-03 500.99 fişi" },
  { id: "treasury/transfer", route: /^\/finance\/treasury$/, label: /^Virman işle$/, klass: "mutation", dbEffect: "bank_transactions virman çifti + management_journal_entries + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Hazine virman / mevduat / POS / kart ekstresi" },
  { id: "treasury/term-deposit", route: /^\/finance\/treasury$/, label: /^Vadeli mevduat bağla$/, klass: "mutation", dbEffect: "term_deposits satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Hazine virman / mevduat / POS / kart ekstresi" },
  { id: "treasury/add-pos", route: /^\/finance\/treasury$/, label: /^POS ekle$/, klass: "mutation", dbEffect: "pos_settlement_batches satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Hazine virman / mevduat / POS / kart ekstresi" },
  { id: "treasury/save-card-statement", route: /^\/finance\/treasury$/, label: /^Ekstre kaydet$/, klass: "mutation", dbEffect: "corporate_card_statements satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Hazine virman / mevduat / POS / kart ekstresi" },
  { id: "finance/archive-search", route: /^\/finance\/archive$/, label: /^Ara$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › finans arşiv arama filtresi" },
  { id: "cashflow/lock-period", route: /^\/cashflow\//, label: /^Dönemi kilitle$/, klass: "mutation", dbEffect: "cashflow_months.status→locked, locked_at/lock_fingerprint set + audit_logs lock_cashflow_period", verifiedBy: "flows.spec.ts › dönem kilitleme" },
  { id: "cashflow/reopen-disclosure", route: /^\/cashflow\//, label: /^Kilidi yeniden aç$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › kilit açma çekmecesi açılır" },
  { id: "cashflow/reopen-period", route: /^\/cashflow\//, label: /^Kilidi aç$/, klass: "mutation", dbEffect: "cashflow_months.status→reviewed, reopen_reason/reopened_at set + audit_logs reopen_cashflow_period", verifiedBy: "flows.spec.ts › gerekçeli dönem kilidi açma" },
  { id: "cashflow/controls-create-task", route: /^\/cashflow\/controls$/, label: /^Görev aç$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › nakit akış kontrolünden görev açma" },
  { id: "budget/disclosure", route: /^\/cashflow\/budget$/, label: /^\+ (Yeni Bütçe Kabı Oluştur|Taslak Bütçe Satırı Ekle|13 Haftalık Tahmin Kabı ve Satırı Ekle)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › bütçe ve tahmin çekmeceleri açılır" },
  { id: "budget/create", route: /^\/cashflow\/budget$/, label: /^Bütçe oluştur$/, klass: "mutation", dbEffect: "budgets satırı + audit_logs create_budget", verifiedBy: "domain-mutations-finance.spec.ts › Bütçe oluştur (budgets + audit_logs)" },
  { id: "budget/add-line", route: /^\/cashflow\/budget$/, label: /^Taslak satır ekle$/, klass: "mutation", dbEffect: "budget_lines (version_status=draft) satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Taslak bütçe satırı ekle" },
  { id: "budget/create-forecast", route: /^\/cashflow\/budget$/, label: /^Tahmin kabı aç$/, klass: "mutation", dbEffect: "forecasts satırı + audit_logs create_forecast", verifiedBy: "domain-mutations-finance.spec.ts › Tahmin kabı aç (forecasts + audit_logs)" },
  { id: "budget/add-forecast-line", route: /^\/cashflow\/budget$/, label: /^Tahmin satırı ekle$/, klass: "mutation", dbEffect: "forecast_lines (version_status=draft) satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Tahmin satırı ekle" },
  { id: "budget/submit-approval", route: /^\/cashflow\/budget$/, label: /^Onaya gönder$/, klass: "mutation", dbEffect: "approvals (entity_table=budget_lines|forecast_lines, status=pending) satırı", verifiedBy: "domain-mutations-finance.spec.ts › Bütçe/tahmin satırını onaya gönder" },
  { id: "budget/approve-version", route: /^\/cashflow\/budget$/, label: /(Versiyonu onayla|^Onayla$|\(\d+ taslak\) onayla)$/, klass: "mutation", dbEffect: "budget_lines|forecast_lines version_status draft→approved (maker≠checker) + budget_vs_actual görünümü canlanır", verifiedBy: "domain-mutations-finance.spec.ts › Bütçe versiyonunu onayla" },
  { id: "facilities/disclosure", route: /^\/finance\/facilities$/, label: /^\+ (Yeni Kredi Limiti Tanımla|Kullanım \(Drawdown\) \/ Geri Ödeme \/ Limit Revizyonu İşle|Teminat Ekle \(İpotek \/ Rehin \/ Kefalet \/ Blokaj\)|Kovenant Maddesi ve Ölçüm Ekle \/ Güncelle|Verilen Teminat Mektubu Kaydet .+)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › kredi limitleri çekmeceleri açılır" },
  { id: "facilities/create", route: /^\/finance\/facilities$/, label: /^Kredi limitini kaydet$/, klass: "mutation", dbEffect: "credit_facilities satırı + audit_logs create_credit_facility", verifiedBy: "domain-mutations-finance.spec.ts › Kredi limitini kaydet (credit_facilities)" },
  { id: "facilities/movement", route: /^\/finance\/facilities$/, label: /^Hareketi kaydet$/, klass: "mutation", dbEffect: "facility_movements satırı + credit_facilities.drawn_amount atomik tetikleyici güncellemesi", verifiedBy: "domain-mutations-finance.spec.ts › Kredi limiti hareketi kaydet" },
  { id: "facilities/collateral", route: /^\/finance\/facilities$/, label: /^Teminatı kaydet$/, klass: "mutation", dbEffect: "collateral_records satırı + audit_logs add_collateral", verifiedBy: "domain-mutations-finance.spec.ts › Teminatı kaydet (collateral_records)" },
  { id: "facilities/covenant", route: /^\/finance\/facilities$/, label: /^Kovenantı kaydet$/, klass: "mutation", dbEffect: "covenant_records ekleme/ölçüm güncellemesi + audit_logs upsert_covenant", verifiedBy: "domain-mutations-finance.spec.ts › Kovenantı kaydet (covenant_records)" },
  { id: "facilities/guarantee-letter", route: /^\/finance\/facilities$/, label: /^Teminat Mektubunu ve 910\/911 Nazım Fişini Kaydet$/, klass: "mutation", dbEffect: "guarantee_letters + 910/911 management_journal_entries + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Teminat mektubu 910/911 nazım kaydı" },
  { id: "counterparties/disclosure", route: /^\/finance\/counterparties$/, label: /^(\+ Yeni (IBAN|boyut) ekle|✎ Seçili Cari Kartı ve Kredi Limitini Güncelle .+)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › IBAN ve boyut çekmeceleri açılır" },
  { id: "counterparties/update-party", route: /^\/finance\/counterparties$/, label: /^Cari Bilgilerini Kaydet$/, klass: "mutation", dbEffect: "parties + counterparty_profiles güncellenir + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Cari kartı ve kredi limiti güncelleme" },
  { id: "counterparties/link-unresolved", route: /^\/finance\/counterparties$/, label: /^eşleştir$/, klass: "mutation", dbEffect: "checks payer_party_id|payee_party_id güncellenir + audit_logs", verifiedBy: "flows.spec.ts › eşleşmemiş karşı taraf bağlama" },
  { id: "counterparties/add-iban", route: /^\/finance\/counterparties$/, label: /^IBAN kaydet$/, klass: "mutation", dbEffect: "counterparty_ibans + iban_change_events (added) satırı", verifiedBy: "domain-mutations-finance.spec.ts › IBAN kaydet (counterparty_ibans + iban_change_events)" },
  { id: "counterparties/deactivate-iban", route: /^\/finance\/counterparties$/, label: /^Pasife al$/, klass: "mutation", dbEffect: "counterparty_ibans.is_active→false + iban_change_events (deactivated) satırı", verifiedBy: "domain-mutations-finance.spec.ts › IBAN pasife al" },
  { id: "counterparties/create-dimension", route: /^\/finance\/counterparties$/, label: /^Boyut oluştur$/, klass: "mutation", dbEffect: "projects|cost_centers|departments satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Boyut oluştur (departments/projects/cost_centers)" },
  { id: "counterparties/show-statement", route: /^\/finance\/counterparties$/, label: /^Ekstreyi Göster$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Ekstreyi Göster cari ekstre görünümü" },
  { id: "counterparties/primary-iban-checkbox", route: /^\/finance\/counterparties$/, label: /^true$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › birincil IBAN kutucuğu" },
  { id: "profitability/rule-disclosure", route: /^\/finance\/profitability$/, label: /^Dağıtım kuralı güncelle$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › dağıtım kuralı çekmecesi açılır" },
  { id: "profitability/rule-save", route: /^\/finance\/profitability$/, label: /^Kuralı kaydet$/, klass: "mutation", dbEffect: "cost_allocation_rules güncellenir + audit_logs update_allocation_rule", verifiedBy: "domain-mutations-finance.spec.ts › Kuralı kaydet (cost_allocation_rules)" },
  { id: "invoices/approve-draft", route: /^\/finance\/invoices$/, label: /^düzenle \(onayla\)$/, klass: "mutation", dbEffect: "invoices.status draft→open + audit_logs", verifiedBy: "flows.spec.ts › fatura taslağı onayı" },
  { id: "invoices/record-payment", route: /^\/finance\/invoices$/, label: /^(tahsil|ödeme)$/, klass: "mutation", dbEffect: "invoice_payments + invoices.paid_amount/status güncellenir", verifiedBy: "flows.spec.ts › fatura tahsil/ödeme kaydı" },
  { id: "receivables/fifo-preview", route: /^\/finance\/receivables$/, label: /^FIFO Dağıtım Önerisi Hesapla$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › FIFO Dağıtım Önerisi Hesapla" },
  { id: "receivables/allocate", route: /^\/finance\/receivables$/, label: /^dağıt$/, klass: "mutation", dbEffect: "invoice_allocations satırı + invoices.paid_amount tetikleyici güncellemesi", verifiedBy: "domain-mutations-finance.spec.ts › Alacak tahsisatı dağıt" },
  { id: "receivables/reverse-allocation", route: /^\/finance\/receivables$/, label: /^Geri al$/, klass: "mutation", dbEffect: "invoice_allocations.reversed_at set + fatura açık bakiyesi geri yüklenir", verifiedBy: "domain-mutations-finance.spec.ts › Alacak tahsisatını geri al" },
  { id: "ledger/filter-trial-balance", route: /^\/finance\/ledger$/, label: /^Mizan & Gelir Tablosunu Filtrele$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › mizan ve gelir tablosu dönem filtresi" },
  { id: "ledger/sync-from-domain", route: /^\/finance\/ledger$/, label: /^Operasyonel Kayıtlardan (Yönetim Defterini|Defteri) Senkronla( \(Idempotent\))?$/, klass: "mutation", dbEffect: "management_journal_entries + management_journal_lines + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Operasyonel kayıtlardan yönetim defterini senkronla" },
  { id: "ledger/revalue-fx", route: /^\/finance\/ledger$/, label: /^Geçici Kur Fişlerini Değerle \(TCMB\)$/, klass: "mutation", dbEffect: "management_journal_entries kur farkı düzeltme fişi + fx_status→valued + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Geçici kur fişlerini değerle (TCMB)" },
  { id: "ledger/create-sub-account", route: /^\/finance\/ledger$/, label: /^TDHP Alt Hesap Aç$/, klass: "mutation", dbEffect: "management_accounts satırı + audit_logs upsert_management_account", verifiedBy: "domain-mutations-finance.spec.ts › TDHP alt hesap aç (management_accounts)" },
  { id: "ledger/period-closing", route: /^\/finance\/ledger$/, label: /^Dönem Sonu Yansıtma & Kapanış Fişi Üret$/, klass: "mutation", dbEffect: "management_journal_entries 7xx→6xx→690 kapanış fişi + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Dönem sonu yansıtma ve kapanış fişi" },
  { id: "ledger/intercompany-run", route: /^\/finance\/ledger$/, label: /^Grup İçi Eliminasyon Çalıştır$/, klass: "mutation", dbEffect: "intercompany_elimination_runs + intercompany_elimination_lines (120↔320, 600↔7xx) + audit_logs", verifiedBy: "enterprise-gaps-0121.test.ts › runIntercompanyElimination" },
  { id: "ledger/intercompany-reverse", route: /^\/finance\/ledger$/, label: /^Ters Kayıt \(İptal\)$/, klass: "mutation", dbEffect: "intercompany_elimination_runs.status→reversed + audit_logs", verifiedBy: "enterprise-gaps-0121.test.ts › reverseIntercompanyEliminationRun" },
  { id: "ledger/add-journal-line", route: /^\/finance\/ledger$/, label: /^\+ Satır Ekle \(Çoklu Bacak\)$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › çok satırlı yevmiye fişi satır ekleme" },
  { id: "ledger/post-manual-adjustment", route: /^\/finance\/ledger$/, label: /^(Tahakkuk Fişi Kaydet|Çok Satırlı Yevmiye Fişini Kaydet)$/, klass: "mutation", dbEffect: "management_journal_entries + management_journal_lines + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Çok satırlı yevmiye fişini kaydet" },
  { id: "ledger/approve-draft", route: /^\/finance\/ledger$/, label: /^Onayla \(Post\)$/, klass: "mutation", dbEffect: "management_journal_entries.status draft→posted + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Taslak yevmiye fişini onayla" },
  { id: "ledger/delete-draft", route: /^\/finance\/ledger$/, label: /^Taslağı Sil$/, klass: "mutation", dbEffect: "management_journal_entries taslak silinir + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Taslak yevmiye fişini sil" },
  { id: "cashflow-13w/refresh", route: /^\/cashflow\/13-week$/, label: /^Açık Kayıtlardan Otomatik Yenile$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Açık kayıtlardan otomatik yenile" },
  { id: "cashflow-13w/freeze", route: /^\/cashflow\/13-week$/, label: /^Haftalık Tahmin Anlık Görüntüsünü Dondur/, klass: "mutation", dbEffect: "forecast_snapshots_13w + forecast_snapshot_13w_lines satırları + audit_logs freeze_forecast_13w_snapshot", verifiedBy: "domain-mutations-finance.spec.ts › Haftalık tahmin anlık görüntüsünü dondur" },
  { id: "cashflow-13w/manual-override", route: /^\/cashflow\/13-week$/, label: /^Manuel Tahmin Satırı Ekle$/, klass: "mutation", dbEffect: "forecasts + forecast_lines (source_kind=manual) satırı + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Manuel tahmin satırı ekle" },
  { id: "cashflow-13w/save-accrual", route: /^\/cashflow\/13-week$/, label: /^Tahakkuku Kaydet \/ Güncelle$/, klass: "mutation", dbEffect: "statutory_tax_accruals satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › 13H vergi/SGK tahakkuk, POS valör ve kart ekstresi" },
  { id: "cashflow-13w/add-pos-batch", route: /^\/cashflow\/13-week$/, label: /^POS Valör Partisini Ekle$/, klass: "mutation", dbEffect: "pos_settlement_batches satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › 13H vergi/SGK tahakkuk, POS valör ve kart ekstresi" },
  { id: "cashflow-13w/save-card-statement", route: /^\/cashflow\/13-week$/, label: /^Kart Ekstresini Kaydet$/, klass: "mutation", dbEffect: "corporate_card_statements satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › 13H vergi/SGK tahakkuk, POS valör ve kart ekstresi" },
  { id: "ledger/reverse-entry", route: /^\/finance\/ledger$/, label: /^Ters Kayıt \(Storno\)$/, klass: "mutation", dbEffect: "management_journal_entries reversal satırı + orijinal status=reversed + audit_logs", verifiedBy: "domain-mutations-finance.spec.ts › Ters kayıt (storno)" },
];

const SCENARIOS: CoverageRule[] = [
  { id: "scenarios/preset", label: /^(Gelir %10 düşerse|Gider %10 artarsa|Gelir %10 artarsa|⚡ .+)$/, klass: "mutation", dbEffect: "scenario_runs satırı", verifiedBy: "flows.spec.ts & shell-and-cfo-closures.spec.ts › hazır ve stres senaryosu çalıştır" },
  { id: "scenarios/run", label: /^Senaryoyu çalıştır$/, klass: "mutation", dbEffect: "scenario_runs satırı", verifiedBy: "flows.spec.ts › özel senaryo çalıştır" },
  { id: "scenarios/run-save", label: /^Çalıştır ve kaydet$/, klass: "mutation", dbEffect: "scenarios + scenario_runs satırları", verifiedBy: "flows.spec.ts › senaryo kaydet" },
  { id: "scenarios/run-unified-13w", route: /^\/scenarios$/, label: /^13 Haftalık Birleşik Senaryoyu Çalıştır & Kaydet$/, klass: "mutation", dbEffect: "scenarios + scenario_runs + scenario_run_weeks satırları", verifiedBy: "shell-and-cfo-closures.spec.ts › 13 haftalık birleşik senaryo çalıştır" },
  { id: "scenarios/compare", route: /^\/scenarios\/compare$/, label: /^(Karşılaştır|Matrisi Güncelle)$/, klass: "mutation", dbEffect: "scenario_runs okunur; karşılaştırma matrisi ekrana çıkar", verifiedBy: "domain-mutations-insights-prod.spec.ts › senaryo karşılaştır" },
  { id: "scenarios/assumptions-disclosure", label: /^Varsayımları göster$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › varsayım paneli açılır" },
  { id: "scenarios/apply-assumptions-checkbox", route: /^\/scenarios$/, label: /^on$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › onaylı varsayımları senaryoya uygula kutucuğu" },
  { id: "scenarios/goalseek-horizon", route: /^\/scenarios$/, label: /^Ufku Hesapla$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Ufku Hesapla başabaş analizi" },
  { id: "scenarios/run-optimizer", route: /^\/scenarios\/optimization$/, label: /^Çözücüyü Çalıştır$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Çözücüyü Çalıştır LP optimizasyonu" },
];

const INSIGHTS: CoverageRule[] = [
  {
    id: "ask/suggested",
    label: /^(Bugün ne ödenecek\?|7 günde ne kadar çıkış var\?|Kasa ne zaman negatife düşüyor\?|En büyük yoğunlaşma nerede\?|Hangi aksiyon öncelikli\?|Gecikmiş açık satış ve alış faturaları ne kadar\?|13 haftalık likidite ve kasa projeksiyonu nedir\?|TDHP 102 mizan bakiyesi ve yönetim EBITDA tutarı nedir\?|Son 30 günlük banka hareketleri ve eşleşmemiş ekstre satırları neler\?|Cari bakiye ve çek yoğunlaşması en yüksek firmalar hangileri\?|Üretim parça marjları, tarife kartları ve OEE durumu nedir\?|Aktif kredi kovenant ve DSCR boşluğu ne durumda\?)$/,
    klass: "mutation",
    dbEffect: "ai_response_snapshots satırı (kaynak izi ile)",
    verifiedBy: "domain-mutations-insights-prod.spec.ts › önerilen soru cevaplanır ve saklanır",
  },
  { id: "ask/answer", label: /^Cevapla$/, klass: "mutation", dbEffect: "ai_response_snapshots satırı", verifiedBy: "domain-mutations-insights-prod.spec.ts › serbest soru cevaplanır" },
  { id: "ask/telegram-query", route: /^\/insights\/ask$/, label: /^Sorgula$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Sorgula salt-okunur CFO sorgusu" },
  { id: "briefing/generate", label: /^Brifingi üret ve kaydet$/, klass: "mutation", dbEffect: "reports (cfo_briefing) satırı", verifiedBy: "domain-mutations-insights-prod.spec.ts › brifing üret" },
  { id: "briefing/distribute", route: /^\/insights\/(briefing|reports)$/, label: /^Brifingi Kanallara Gönder$/, klass: "mutation", dbEffect: "audit_logs dispatch_cfo_briefing satırı", verifiedBy: "domain-mutations-insights-prod.spec.ts › Brifingi Kanallara Gönder" },
  { id: "reports/generate", label: /^(Günlük üret →|Haftalık üret →|Aylık üret →|Yönetim Kurulu & Banka Paketi üret →)$/, klass: "mutation", dbEffect: "reports satırı", verifiedBy: "mutations.spec.ts & domain-mutations-insights-prod.spec.ts › rapor üret" },
  { id: "reports/send-telegram", route: /^\/insights\/reports$/, label: /^Telegram'a ilet$/, klass: "mutation", dbEffect: "report_deliveries satırı + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Raporu Telegram'a ilet" },
  { id: "tasks/create-from-insight", label: /^(gorev|Görev oluştur|Görev Oluştur)$/, klass: "mutation", dbEffect: "action_items satırı", verifiedBy: "domain-mutations-insights-prod.spec.ts › içgörüden görev oluştur" },
  { id: "tasks/auto-close-settled", route: /^\/insights\/tasks$/, label: /^Ödenen Kayıt Görevlerini Otomatik Kapat$/, klass: "mutation", dbEffect: "action_items.status→done (ödenen kayıtlar) + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Ödenen kayıt görevlerini otomatik kapat" },
  { id: "tasks/assign", route: /^\/insights\/tasks$/, label: /^Ata$/, klass: "mutation", dbEffect: "action_items.owner güncellenir + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Görev sorumlusu atama" },
  { id: "reminders/plan-today", label: /^(bugünü planla →|Vade taraması çalıştır \(Ödeme · Fatura · Söz · Çek · Kredi\) →|Vade Taraması Çalıştır →)$/, klass: "mutation", dbEffect: "reminder_deliveries satırları (planned)", verifiedBy: "domain-mutations-insights-prod.spec.ts › vade taraması çalıştır" },
  { id: "reminders/send-pending", label: /^(bekleyenleri gönder \(Telegram\) →|Bekleyenleri gönder \(Telegram \/ E-posta\) →|Bekleyenleri Gönder →)$/, klass: "mutation", dbEffect: "reminder_deliveries satırı (sent|failed)", verifiedBy: "domain-mutations-insights-prod.spec.ts › bekleyenleri gönder" },
  { id: "reminders/send-multichannel", route: /^\/insights\/reminders$/, label: /^Çok Kanallı Hatırlatma Gönder$/, klass: "mutation", dbEffect: "sendCounterpartyReminder (HTML E-posta / SMS / WhatsApp / Telegram) + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Çok kanallı hatırlatma gönder" },
  { id: "reminders/channel-checkbox", route: /^\/insights\/reminders$/, label: /^(telegram|email|sms|whatsapp)$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › çoklu kanal seçim kutucukları" },
  { id: "reminders/rule-disclosure", route: /^\/insights\/reminders$/, label: /^(\+ Yeni hatırlatma kuralı ekle|Kuralı düzenle: .+)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › kural ekleme çekmecesi açılır" },
  { id: "reminders/rule-checkbox", route: /^\/insights\/reminders$/, label: /^on$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › kural aktif kutucuğu" },
  { id: "reminders/rule-save", route: /^\/insights\/reminders$/, label: /^(Kaydet|Güncelle)$/, klass: "mutation", dbEffect: "reminders satırı + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Hatırlatma kuralı kaydet (reminders)" },
  { id: "reminders/rule-toggle", route: /^\/insights\/reminders$/, label: /^(Pasife Al|Etkinleştir|Aktif Yap)$/, klass: "mutation", dbEffect: "reminders.is_active güncellenir + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Hatırlatma kuralı pasife al / etkinleştir" },
];

const DATA: CoverageRule[] = [
  { id: "tasks/start", label: /^Başlat$/, klass: "mutation", dbEffect: "action_items.status→in_progress", verifiedBy: "mutations.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/block", label: /^Engelle$/, klass: "mutation", dbEffect: "action_items.status→blocked", verifiedBy: "domain-mutations-insights-prod.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/complete", label: /^Tamamla$/, klass: "mutation", dbEffect: "action_items.status→done + completion note", verifiedBy: "domain-mutations-insights-prod.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/cancel", label: /^İptal$/, tag: /^button$/, klass: "mutation", dbEffect: "action_items.status→cancelled", verifiedBy: "domain-mutations-insights-prod.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/create", label: /^(Oluştur|Görevi Oluştur)$/, klass: "mutation", dbEffect: "action_items satırı", verifiedBy: "domain-mutations-insights-prod.spec.ts › manuel görev oluştur" },
  { id: "reviews/accept", label: /^Kabul$/, klass: "mutation", dbEffect: "mapping_reviews.status→accepted", verifiedBy: "domain-mutations-data-system.spec.ts › içe aktarım incelemesi" },
  { id: "reviews/reject", label: /^Reddet$/, klass: "mutation", dbEffect: "mapping_reviews.status→rejected | approvals.status→rejected", verifiedBy: "domain-mutations-data-system.spec.ts › inceleme reddi / onay reddi" },
  { id: "reviews/resolve", label: /^Çöz$/, klass: "mutation", dbEffect: "mapping_reviews.status→resolved", verifiedBy: "domain-mutations-data-system.spec.ts › içe aktarım incelemesi" },
  { id: "reviews/group-filter", route: /^\/data\/reviews$/, label: /·/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › inceleme sorun grubu filtre düğmesi" },
  { id: "reviews/group-bulk-action", route: /^\/data\/reviews$/, label: /^Grubu (Kabul Et|Çöz) \(\d+\)$/, klass: "mutation", dbEffect: "mapping_reviews toplu durum geçişi + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › İnceleme grubu toplu karar" },
  { id: "reviews/bulk-checkbox", route: /^\/data\/reviews$/, label: /(incelemesini seç|incelemeleri seç)$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › inceleme çoklu seçim kutucukları" },
  { id: "assumptions/approve", label: /^onay$/, klass: "mutation", dbEffect: "external_assumptions.review_status→approved", verifiedBy: "domain-mutations-data-system.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/reject", label: /^ret$/, klass: "mutation", dbEffect: "external_assumptions.review_status→rejected", verifiedBy: "domain-mutations-data-system.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/archive", label: /^arşiv$/, klass: "mutation", dbEffect: "external_assumptions arşivlenir", verifiedBy: "domain-mutations-data-system.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/save", route: /^\/data\/assumptions$/, label: /^kaydet$/, klass: "mutation", dbEffect: "external_assumptions satırı", verifiedBy: "domain-mutations-data-system.spec.ts › varsayım oluştur" },
  { id: "approvals/approve", label: /^Onayla$/, klass: "mutation", dbEffect: "approvals.status→approved (maker-checker: talep eden onaylayamaz)", verifiedBy: "domain-mutations-data-system.spec.ts › onay akışı + rol zorlaması" },
  { id: "approvals/revise", label: /^Revizyon$/, klass: "mutation", dbEffect: "approvals.status→revision_requested", verifiedBy: "domain-mutations-data-system.spec.ts › onay akışı + rol zorlaması" },
  { id: "approvals/save-governance-policy", route: /^\/data\/approvals$/, label: /^Politikayı kaydet$/, klass: "mutation", dbEffect: "approval_governance_settings güncellenir + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Politikayı kaydet (approval_governance_settings)" },
  { id: "approvals/create-rule", route: /^\/data\/approvals$/, label: /^Kural ekle$/, klass: "mutation", dbEffect: "approval_rules satırı + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Kural ekle (approval_rules)" },
  { id: "approvals/save-rule-threshold", route: /^\/data\/approvals$/, label: /^Eşiği kaydet$/, klass: "mutation", dbEffect: "approval_rules.threshold_amount güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Eşiği kaydet (approval_rules)" },
  { id: "approvals/toggle-rule", route: /^\/data\/approvals$/, label: /^(Pasife al|Aktifleştir)$/, klass: "mutation", dbEffect: "approval_rules.is_active güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Onay kuralı pasife al / aktifleştir" },
  { id: "imports/upload", label: /^(İÇE AKTAR|1 · Sütunları Analiz Et)$/, klass: "mutation", dbEffect: "source_workbooks + source_sheets + import_rows satırları", verifiedBy: "domain-mutations-data-system.spec.ts › çalışma kitabı 3 adımlı sihirbazla içe aktar" },
  { id: "imports-v2/preview", route: /^\/data\/imports\/v2$/, label: /^ÖNİZLE$/, klass: "ui-state", verifiedBy: "import-v2.spec.ts › UPLOAD / SCHEMA_DETECTION / PREVIEW (hiçbir şey yazmaz)" },
  { id: "imports-v2/columns-disclosure", route: /^\/data\/imports\/v2$/, label: /^kolonları göster \(\d+\)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › şablon sekme kolonları çekmecesi" },
  { id: "imports/archive-disclosure", route: /^\/data\/imports$/, label: /^▸/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › geçmiş çalışma kitabı arşivi çekmecesi açılır" },
  { id: "imports/file-input", label: /^\(etiketsiz\)$/, tag: /^input$/, route: /imports/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › çalışma kitabı dosya seçimi" },
  { id: "documents/file-input", label: /^\(etiketsiz\)$/, tag: /^input$/, route: /^\/data\/documents$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › belge kasası dosya seçimi" },
  { id: "documents/upload", route: /^\/data\/documents$/, label: /^Kasaya yükle ve doğrula$/, klass: "mutation", dbEffect: "documents + document_versions + opsiyonel document_links + içerik adresli SHA-256 disk kaydı", verifiedBy: "domain-mutations-data-system.spec.ts › Kasaya yükle ve doğrula (documents + SHA-256)" },
  { id: "documents/attach", route: /^\/data\/documents$/, label: /^Kayda ekle \(attachToEntity\)$/, klass: "mutation", dbEffect: "document_links satırı + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Belgeyi kayda ekle" },
  { id: "documents/smart-extract", route: /^\/data\/documents$/, label: /^Akıllı Alan Çıkarımı \(OCR\/XML\)$/, klass: "mutation", dbEffect: "documents.extracted_metadata (VKN, IBAN, Tutar, Tarih, Belge No) + audit_logs", verifiedBy: "enterprise-gaps-0121.test.ts › extractStructuredDocumentFields & persistDocumentExtraction" },
  { id: "documents/create-draft-payment", route: /^\/data\/documents$/, label: /^Çıkarılan Veriyle Taslak Ödeme Oluştur$/, klass: "mutation", dbEffect: "payments + payment_instances + document_links satırı + audit_logs", verifiedBy: "enterprise-gaps-0121.test.ts › smart document draft creation" },
  { id: "reconciliation/signoff", route: /^\/data\/reconciliation$/, label: /^Mutabakatı imzala$/, klass: "mutation", dbEffect: "reconciliation_signoffs (append-only kanıt) satırı + audit_logs signoff_reconciliation", verifiedBy: "domain-mutations-data-system.spec.ts › Mutabakatı imzala (reconciliation_signoffs)" },
  { id: "reconciliation/create-task", route: /^\/data\/reconciliation$/, label: /^(Aksiyon görevi aç|Görev üret)$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Mutabakat farkından aksiyon görevi aç" },
  { id: "trial-balance/file-input", route: /^\/data\/trial-balance-bridge$/, label: /^\(etiketsiz\)$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › yasal mizan dosya seçimi" },
  { id: "trial-balance/import-and-reconcile", route: /^\/data\/trial-balance-bridge$/, label: /^Yasal Mizanı Yükle & Köprüyü Çalıştır$/, klass: "mutation", dbEffect: "statutory_trial_balances + statutory_trial_balance_lines + trial_balance_reconciliation_runs + trial_balance_reconciliation_items + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Yasal mizanı yükle ve köprüyü çalıştır" },
  { id: "trial-balance/rerun", route: /^\/data\/trial-balance-bridge$/, label: /^Seçili Mizanla Mutabakatı Yenile$/, klass: "mutation", dbEffect: "trial_balance_reconciliation_runs + trial_balance_reconciliation_items + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Seçili mizanla mutabakatı yenile" },
  { id: "trial-balance/create-task", route: /^\/data\/trial-balance-bridge$/, label: /^Görev Aç$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + trial_balance_reconciliation_items.action_item_id + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Mizan farkından görev aç" },
];

const SYSTEM: CoverageRule[] = [
  { id: "overview/fin03-drawer-trigger", route: /^\/$/, label: /^Açılış Gir \(\d+ Hesap\) →$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › FIN-03 hızlı açılış çekmecesi" },
  { id: "overview/chart-mode-tab", route: /^\/$/, label: /^(Ödeme & Vade Baskısı|13H Kümülatif Kasa Ufku|TRY ₺|USD \$|EUR €)$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ana ekran grafik modu ve döviz sekmeleri" },
  { id: "overview/parchment-disclosure", route: /^\/$/, label: /^▸/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › ana ekran kokpit ve eğilim çekmeceleri açılır" },
  { id: "overview/evidence-drawer-trigger", route: /^\/$/, label: /^Kaynak & Kanıt$/, tag: /^button$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › CFO yürütme nabzı kaynak kanıt çekmecesi" },
  { id: "system/refresh-metrics", label: /^Metrikleri yenile$/, klass: "mutation", dbEffect: "metric_snapshots satırı", verifiedBy: "mutations.spec.ts › metrikleri yenile" },
  { id: "system/diagnostics-refresh", label: /^Yenile$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › Yenile tanılama sayfasını tazeler" },
  { id: "system/role-select", route: /^\/system\/security$/, label: /izleyicifinans/, tag: /^select$/, klass: "mutation", dbEffect: "users.role — yalnız admin; yetkisiz rol backend'de REDDEDİLİR", verifiedBy: "domain-mutations-data-system.spec.ts › rol değiştirme + yetki zorlaması" },
  { id: "system/change-role", route: /^\/system\/security$/, label: /^rolü değiştir$/, klass: "mutation", dbEffect: "users.role güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › rol değiştirme + yetki zorlaması" },
  { id: "system/deactivate-user", route: /^\/system\/security$/, label: /^pasifleştir$/, klass: "mutation", dbEffect: "users.is_active→false; oturumları iptal", verifiedBy: "domain-mutations-data-system.spec.ts › kullanıcı pasifleştir" },
  { id: "system/create-user", route: /^\/system\/security$/, label: /^kullanıcı oluştur$/, klass: "mutation", dbEffect: "users satırı", verifiedBy: "domain-mutations-data-system.spec.ts › kullanıcı oluştur" },
  { id: "system/reset-password", route: /^\/system\/security$/, label: /^sıfırla$/, klass: "mutation", dbEffect: "users.password_hash değişir; failed_login_count sıfırlanır", verifiedBy: "domain-mutations-data-system.spec.ts › parola sıfırla" },
  { id: "system/activate-user", route: /^\/system\/security$/, label: /^aktifleştir$/, klass: "mutation", dbEffect: "users.is_active→true + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Kullanıcı aktifleştir (users.is_active→true)" },
  { id: "system/force-password-change", route: /^\/system\/security$/, label: /^şifre değişimi zorla$/, klass: "mutation", dbEffect: "users.must_change_password→true + audit_logs force_password_change", verifiedBy: "mutations.spec.ts › system/force-password-change: 'şifre değişimi zorla' GERÇEKTEN yazıyor" },
  { id: "system/security-unlock-user", route: /^\/system\/security$/, label: /^kilidi aç$/, klass: "mutation", dbEffect: "users.locked_until→null, failed_login_count→0 + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › kilitli kullanıcı kilidini açma" },
  { id: "system/security-2fa-reset", route: /^\/system\/security$/, label: /^2FA Sıfırla$/, klass: "mutation", dbEffect: "users.totp_enabled→false, totp_secret_encrypted→null + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › 2FA TOTP sıfırlama" },
  { id: "system/security-2fa-toggle", route: /^\/system\/security$/, label: /^(2FA \(TOTP\) Devre Dışı Bırak|Doğrula & 2FA Etkinleştir)$/, klass: "mutation", dbEffect: "users.totp_enabled güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › 2FA TOTP etkinleştir/devre dışı bırak" },
  { id: "system/security-revoke-session", route: /^\/system\/security$/, label: /^Oturumu Sonlandır$/, klass: "mutation", dbEffect: "sessions.revoked_at set edilir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › aktif oturumu sonlandır" },
  { id: "system/security-save-sso", route: /^\/system\/security$/, label: /^Yapılandırmayı Kaydet$/, klass: "mutation", dbEffect: "sso_identity_providers satırı güncellenir + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › SSO yapılandırmasını kaydet" },
  { id: "system/security-sso-checkbox", route: /^\/system\/security$/, label: /^true$/, tag: /^input$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › SSO etkinleştirme kutucuğu" },
  { id: "system/features-create-entity", route: /^\/system\/features$/, label: /^Grup Şirketi Oluştur$/, klass: "mutation", dbEffect: "legal_entities satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Grup şirketi ve şube oluştur" },
  { id: "system/features-create-branch", route: /^\/system\/features$/, label: /^Şube \/ Tesis Ekle$/, klass: "mutation", dbEffect: "branches satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Grup şirketi ve şube oluştur" },
  { id: "collab/add-entity-comment", label: /^Yorum Ekle \(@kullanıcı\)$/, klass: "mutation", dbEffect: "entity_comments satırı (@mention GIN dizini) + audit_logs", verifiedBy: "enterprise-gaps-0121.test.ts › addEntityComment & extractMentions" },
  { id: "system/controls-transition", route: /^\/system\/controls$/, label: /^(Gördüm|Ertele|Çözüldü|Yanlış alarm)$/, klass: "mutation", dbEffect: "control_alerts.status güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › İç kontrol uyarısı durum geçişleri" },
  { id: "system/controls-create-task", route: /^\/system\/controls$/, label: /^görev aç$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › İç kontrol uyarısından görev aç" },
  { id: "system/controls-disclosure", route: /^\/system\/controls$/, label: /^▸/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › iç kontrol adli ve anomali çekmeceleri açılır" },
  { id: "system/drain-queue", route: /^\/system\/jobs$/, label: /^Kuyruğu süpür$/, klass: "mutation", dbEffect: "job_runs satırı; kuyruk boşalır", verifiedBy: "domain-mutations-data-system.spec.ts › iş kuyruğunu süpür" },
  { id: "system/jobs-run-next", route: /^\/system\/jobs$/, label: /^Sıradaki işi çalıştır$/, klass: "mutation", dbEffect: "background_jobs + job_runs satırı", verifiedBy: "domain-mutations-data-system.spec.ts › Sıradaki işi çalıştır (background_jobs + job_runs)" },
  { id: "system/jobs-recover-stale", route: /^\/system\/jobs$/, label: /^Asılı İşleri Kurtar$/, klass: "mutation", dbEffect: "background_jobs running→queued/failed kurtarma + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Asılı işleri kurtar (reapStaleRunningJobs)" },
  { id: "system/jobs-enqueue-preset", route: /^\/system\/jobs$/, label: /^\+ (Ana Ekran & Süreklilik Tazele|İç Kontrol Denetimi Çalıştır|Günlük CFO Özeti Üret|TCMB Günlük Kur Çek|Büyük Dışa Aktarma Üret)$/, klass: "mutation", dbEffect: "background_jobs (queued) satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts & domain-mutations-data-system.spec.ts › hazır iş kuyruğa ekleme" },
  { id: "system/archive-filter", route: /^\/system\/archive$/, label: /^Filtrele$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › arşiv filtresi sonuç kümesini daraltır" },
  { id: "tasks/search", route: /^\/insights\/tasks$/, label: /^Ara$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › görev arama sonuç kümesini daraltır" },
  { id: "production/disclosure", route: /^\/production(\/costs|\/roi)?$/, label: /^(\+ (Kapasite \/ vardiya parametresi ekle|Yeni TDHP Stok Kartı .*|Sabit maliyet kalemi ekle \/ güncelle|Yeni müşteri kontrat dakika tarifesi .*|(Klasik )?[Mm]akine \/ yıllık ROI kaydı ekle veya güncelle|Tezgâh \/ müşteri dakika tarifesi \(TL\/dk\) güncelle|Tekil üretim parçası \(süre \/ birim satış fiyatı\) ekle veya güncelle|Katalog ürünü ekle \/ güncelle)|▸\s*(Kaynak Gelir Dağılımı|KAYNAK GELİR DAĞILIMI))/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › üretim parametre çekmeceleri açılır" },
  { id: "production/save-capacity", route: /^\/production$/, label: /^Parametreyi kaydet$/, klass: "mutation", dbEffect: "capacity_models + machine_rates satırları + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Parametreyi kaydet (capacity_models)" },
  { id: "production/save-cost-item", route: /^\/production\/costs$/, label: /^Maliyet kalemini kaydet$/, klass: "mutation", dbEffect: "cost_models + cost_model_items + break_even_tl_per_min yeniden hesabı + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Maliyet kalemini kaydet (cost_model_items)" },
  { id: "production/recalc-profitability", route: /^\/production\/costs$/, label: /^Kârlılığı Şimdi Yeniden Hesapla$/, klass: "mutation", dbEffect: "profitability_snapshots (ON CONFLICT DO UPDATE) + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Kârlılığı şimdi yeniden hesapla" },
  { id: "production/save-operation-rate", route: /^\/production\/costs$/, label: /^Tarifeyi kaydet ve kârlılığı yenile$/, klass: "mutation", dbEffect: "operation_rates + profitability_snapshots + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Tarifeyi kaydet ve kârlılığı yenile" },
  { id: "production/save-rate-card", route: /^\/production\/costs$/, label: /^Tarife kartını kaydet$/, klass: "mutation", dbEffect: "customer_contract_rate_cards satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Müşteri kontrat dakika tarifesi kaydet" },
  { id: "production/save-part", route: /^\/production\/costs$/, label: /^Parçayı kaydet$/, klass: "mutation", dbEffect: "production_parts + profitability_snapshots + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Parçayı kaydet (production_parts)" },
  { id: "production/save-catalog-product", route: /^\/production\/costs$/, label: /^Ürünü kaydet$/, klass: "mutation", dbEffect: "products satırı + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Ürünü kaydet (products)" },
  { id: "production/save-machine-roi", route: /^\/production\/roi$/, label: /^Makineyi kaydet$/, klass: "mutation", dbEffect: "machine_assets + machine_roi_snapshots satırları + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › Makineyi kaydet (machine_assets)" },
  { id: "production/save-npv-irr", route: /^\/production\/roi$/, label: /^NPV \/ IRR Hesapla ve Kaydet$/, klass: "mutation", dbEffect: "capex_npv_irr_evaluations satırı + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › Makine CAPEX NPV/IRR hesapla ve kaydet" },
  { id: "production/kiosk-open-station", route: /^\/production\/kiosk$/, label: /^İstasyonu Aç$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › barkod/karekod ile iş emri istasyonu filtreleme" },
  { id: "production/kiosk-downtime-disclosure", route: /^\/production\/kiosk$/, label: /^\+ Tezgâh Duruşu \/ Arıza Bildir/, tag: /^summary$/, klass: "ui-state", verifiedBy: "ui-state-and-exports.spec.ts › tezgâh duruş bildirim çekmecesi açılır" },
  { id: "production/kiosk-start", route: /^\/production\/kiosk$/, label: /^Tezgâhta Başlat$/, klass: "mutation", dbEffect: "work_orders.status→in_progress, started_at & last_kiosk_event_at set + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › kiosk iş emri başlat" },
  { id: "production/kiosk-record-output", route: /^\/production\/kiosk$/, label: /^Sağlam & Fire Kaydet$/, klass: "mutation", dbEffect: "work_orders completed_qty/scrap_qty/actual_machine_minutes + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › kiosk sağlam ve fire adet kaydı" },
  { id: "production/kiosk-report-downtime", route: /^\/production\/kiosk$/, label: /^Duruş Bildir$/, klass: "mutation", dbEffect: "work_orders downtime_minutes & downtime_reason + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › kiosk duruş bildirimi" },
  { id: "production/kiosk-complete", route: /^\/production\/kiosk$/, label: /^İş Emrini Tamamla$/, klass: "mutation", dbEffect: "work_orders.status→completed, completed_at set + inventory_movements + audit_logs", verifiedBy: "domain-mutations-insights-prod.spec.ts › kiosk iş emri tamamlama" },
  { id: "integrations/closed-loop-sync", route: /^\/data\/integrations$/, label: /^Kapalı Çevrim Tam Senkron \(TCMB \+ (Paraşüt|Banka) \+ .*\)$/, klass: "mutation", dbEffect: "fx_rates + integration_sync_runs + management_journal_entries + forecast_snapshots_13w + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Kapalı çevrim tam senkron" },
  { id: "integrations/add-connection", route: /^\/data\/integrations$/, label: /^Bağlantı Ekle$/, klass: "mutation", dbEffect: "integration_connections satırı + audit_logs create_integration_connection", verifiedBy: "domain-mutations-data-system.spec.ts › Bağlantı ekle (integration_connections)" },
  { id: "integrations/sync-now", route: /^\/data\/integrations$/, label: /^Şimdi Çek$/, klass: "mutation", dbEffect: "background_jobs accounting_sync satırı", verifiedBy: "domain-mutations-data-system.spec.ts › Şimdi çek muhasebe senkronu" },
  { id: "integrations/toggle-status", route: /^\/data\/integrations$/, label: /^(Durdur|Etkinleştir)$/, klass: "mutation", dbEffect: "integration_connections.status güncellenir + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Entegrasyon bağlantısı durdur/etkinleştir" },
  { id: "integrations/resolve-staged-party", route: /^\/data\/integrations$/, label: /^(Yeni Cari Aç|Bağla|Yoksay)$/, klass: "mutation", dbEffect: "integration_staged_parties + parties (createCounterparty) + integration_entity_links + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Bekleyen cari çözümleme" },
  { id: "integrations/save-account-mapping", route: /^\/data\/integrations$/, label: /^Hesap Eşlemesini Kaydet$/, klass: "mutation", dbEffect: "integration_account_mappings satırı + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Hesap eşlemesini kaydet" },
  { id: "integrations/import-hybrid-bank", route: /^\/data\/integrations$/, label: /^Hibrit Ekstreyi İçe Aktar ve Tekilleştir$/, klass: "mutation", dbEffect: "bank_transactions + cross_channel_dedupe_hash + source_workbooks + audit_logs", verifiedBy: "domain-mutations-data-system.spec.ts › Hibrit banka ekstresi içe aktar" },
  { id: "integrations/import-ubl-einvoice", route: /^\/data\/integrations$/, label: /^UBL-TR e-Fatura Paketi İçe Aktar$/, klass: "mutation", dbEffect: "invoices + invoice_lines + integration_staged_parties + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › UBL-TR e-Fatura ve POS yığını içe aktar" },
  { id: "integrations/import-pos-settlement", route: /^\/data\/integrations$/, label: /^POS Gün Sonu Yığınını Aktar$/, klass: "mutation", dbEffect: "pos_settlement_batches (108 Kredi Kartı Alacakları) + audit_logs", verifiedBy: "shell-and-cfo-closures.spec.ts › UBL-TR e-Fatura ve POS yığını içe aktar" },
];

/* ── 6) Dış entegrasyonlar — canlı doğrulanamayanlar ─────────────────────────────────────── */

export interface ExternalAllowlistEntry {
  control: string;
  reason: string;
  ownerDecisionNeeded: string;
  proofOfImplementation: string;
  mockTest: string;
}

export const EXTERNAL_ALLOWLIST: ExternalAllowlistEntry[] = [];

/* ── Kural listesi (SIRA ÖNEMLİ: özelden genele) ─────────────────────────────────────────── */

export const RULES: CoverageRule[] = [
  ...SHELL,
  ...PAYMENTS,
  ...FINANCE,
  ...SCENARIOS,
  ...INSIGHTS,
  ...DATA,
  ...SYSTEM,
  ...EXPORTS,
  ...CHART_AND_TABLE,
  ...FILTERS,
];

/** Genel kural: her `<a href>` bir gezinmedir ve gezinme sınıfıyla doğrulanır. */
export const NAVIGATION_FALLBACK: CoverageRule = {
  id: "navigation/any-link",
  label: /.*/,
  tag: /^a$/,
  klass: "navigation",
  verifiedBy: "navigation.spec.ts › gezinme süpürmesi (her ayrık href bir kez)",
};

export function ruleFor(control: { route: string; label: string; tag: string; href: string | null }): CoverageRule | null {
  for (const rule of RULES) {
    if (rule.route && !rule.route.test(control.route)) continue;
    if (rule.tag && !rule.tag.test(control.tag)) continue;
    if (!rule.label.test(control.label)) continue;
    return rule;
  }
  if (control.tag === "a" && control.href) return NAVIGATION_FALLBACK;
  return null;
}
