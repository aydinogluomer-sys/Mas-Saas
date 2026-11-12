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

/* ── 1) Kabuk — her rotada tekrar eden dört kontrol + çıkış ──────────────────────────────── */

const SHELL: CoverageRule[] = [
  {
    id: "shell/logout",
    label: /Çıkış yap/,
    klass: "mutation",
    dbEffect: "sessions.revoked_at set edilir; korunan rota artık /login'e döner",
    verifiedBy: "flows.spec.ts › kabuk › çıkış oturumu GERÇEKTEN iptal eder",
  },
  {
    id: "shell/command-palette",
    label: /^⌕Hızlı erişim/,
    klass: "ui-state",
    verifiedBy: "shell.spec.ts › komut paleti açılır, arar ve seçilen rotaya GİDER",
  },
  { id: "shell/search", label: /^ara ⌘K$/, klass: "ui-state", verifiedBy: "shell.spec.ts › arama kutusu açılır ve sonuç üretir" },
  { id: "shell/sidebar-collapse", label: /^‹$/, klass: "ui-state", verifiedBy: "shell.spec.ts › kenar çubuğu daralır/genişler" },
  { id: "shell/mobile-menu", label: /^☰$/, klass: "ui-state", verifiedBy: "shell.spec.ts › mobil menü açılır" },
];

/* ── 2) Grafik ve tablo kontrolleri — kalıcı durum değiştirmezler ────────────────────────── */

const CHART_AND_TABLE: CoverageRule[] = [
  { id: "chart/zoom-in", label: /^Yakınlaştır \+$/, klass: "ui-state", verifiedBy: "shell.spec.ts › grafik yakınlaştırma görünen aralığı daraltır" },
  { id: "chart/zoom-out", label: /^Uzaklaştır −$/, klass: "ui-state", verifiedBy: "shell.spec.ts › grafik uzaklaştırma görünen aralığı genişletir" },
  { id: "chart/reset", label: /^Sıfırla$/, klass: "ui-state", verifiedBy: "shell.spec.ts › grafik sıfırlama başlangıç aralığına döner" },
  { id: "chart/focus-mode", label: /^Odak modu$/, klass: "ui-state", verifiedBy: "shell.spec.ts › odak modu grafiği büyütür" },
  { id: "chart/period", label: /^(3A|6A|12A|24A|Tümü)$/, klass: "ui-state", verifiedBy: "shell.spec.ts › dönem düğmesi grafiğin nokta sayısını değiştirir" },
  {
    id: "chart/series-toggle",
    // Etiket DİNAMİK: `analytics-chart.tsx` boş seriye "· bu dönemde kayıt yok" ekler
    // (`{series.label}{emptySeries… && <span>· bu dönemde kayıt yok</span>}`). Aynı düğme,
    // aynı davranış — yalnız o dönemde verisi yok. Kapı bunu yakaladı: mutasyon testleri bütün
    // çekleri kapattıktan sonra `/finance` üzerinde "Çek· bu dönemde kayıt yok" belirdi ve
    // manifestoda karşılığı olmadığı için KIRMIZI verdi. Doğru düzeltme kuralı bu ekle
    // toleranslı yapmaktır; etiketi veya boş-durum bilgisini kaldırmak değil.
    label: /^(Açılış|Kapanış|Gelir|Gider|Net hareket|Çek|Kredi taksiti|Kullanım|Marj)(· bu dönemde kayıt yok)?$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell.spec.ts › seri düğmesi ilgili seriyi gizler/gösterir",
  },
  {
    id: "table/sort-header",
    // Sıralama başlıkları ok işaretiyle biter: ↕ (sırasız), ▲ (artan), ▼ (azalan).
    label: /[↕▲▼]$/,
    tag: /^button$/,
    klass: "ui-state",
    verifiedBy: "shell.spec.ts › sıralama başlığı satır SIRASINI gerçekten değiştirir",
  },
  { id: "table/columns", label: /^Kolonlar$/, klass: "ui-state", verifiedBy: "shell.spec.ts › kolon seçici görünen kolonları değiştirir" },
  { id: "table/row-menu", label: /^⋯$/, klass: "ui-state", verifiedBy: "shell.spec.ts › satır menüsü açılır" },
  { id: "table/pagination", label: /^(← Önceki|Sonraki →)$/, klass: "ui-state", verifiedBy: "shell.spec.ts › sayfalama görünen kayıt kümesini değiştirir" },
  { id: "table/a11y-disclosure", label: /^Erişilebilir veri tablosu$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › erişilebilir tablo açılır ve veri içerir" },
  { id: "chart/why", label: /^Bu sonuç neden çıktı\?$/, klass: "ui-state", verifiedBy: "shell.spec.ts › açıklama panelini açar" },
  { id: "calendar/goto-month", label: /^Aya git$/, klass: "ui-state", verifiedBy: "shell.spec.ts › aya git takvimi hedef aya taşır" },
];

/* ── 3) Filtre / görünüm uygulama ────────────────────────────────────────────────────────── */

const FILTERS: CoverageRule[] = [
  { id: "filter/apply", label: /^Uygula$/, klass: "ui-state", verifiedBy: "shell.spec.ts › filtre uygulama sonuç kümesini daraltır" },
  {
    id: "filter/free-input",
    label: /^\(etiketsiz\)$/,
    tag: /^input$/,
    klass: "ui-state",
    verifiedBy: "shell.spec.ts › filtre/arama girdisi görünen satırları daraltır",
  },
  {
    id: "form/select",
    // Form içindeki <select>'ler kendi başlarına mutation DEĞİLDİR: değerleri, ait oldukları
    // formun submit'iyle birlikte yazılır. Bu yüzden ilgili form testinde POZİTİF senaryonun
    // parçası olarak doldurulur ve yazılan değer DB'den doğrulanır.
    label: /.*/,
    tag: /^select$/,
    klass: "ui-state",
    verifiedBy: "flows.spec.ts › ilgili formun pozitif senaryosu (seçim DB'ye yazılır)",
  },
];

/* ── 4) Dışa aktarım — gerçek dosya ──────────────────────────────────────────────────────── */

const EXPORTS: CoverageRule[] = [
  { id: "export/csv", label: /^CSV$/, klass: "export", verifiedBy: "exports.spec.ts › CSV indirilir, ayrıştırılır, satır sayısı ekranla tutarlı" },
  { id: "export/excel", label: /^Excel$/, klass: "export", verifiedBy: "exports.spec.ts › XLSX indirilir, programatik açılır, sheet/veri doğrulanır" },
  { id: "export/png", label: /^png$/, klass: "export", verifiedBy: "exports.spec.ts › PNG indirilir ve gerçek PNG imzası taşır" },
  { id: "export/svg", label: /^svg$/, klass: "export", verifiedBy: "exports.spec.ts › SVG indirilir ve XML olarak ayrıştırılır" },
  { id: "export/pdf", label: /^pdf$/, klass: "export", verifiedBy: "exports.spec.ts › PDF indirilir ve %PDF imzası taşır" },
  { id: "export/payment-run-bank-file", route: /^\/finance\/collections$/, label: /^(pain\.001 XML|Garanti XLSX|İşBank CSV|YKredi CSV|Akbank CSV)$/, klass: "export", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › pain.001 XML + 4 banka EFT CSV/XLSX ihracı" },
  { id: "export/document-vault-download", route: /^\/data\/documents$/, label: /^İndir$/, tag: /^a$/, klass: "export", verifiedBy: "closed-loops-d4.test.ts › loadVerifiedDocumentDownload SHA-256 doğrulamalı indirme" },
];

/* ── 5) Mutasyonlar — modül modül ────────────────────────────────────────────────────────── */

const PAYMENTS: CoverageRule[] = [
  { id: "payments/mark-paid", label: /^ödendi$/, klass: "mutation", dbEffect: "payment_instances.status→paid, paid_at not null, audit_logs satırı", verifiedBy: "flows.spec.ts › ödendi → geri al" },
  { id: "payments/mark-unpaid", label: /^geri al$/, klass: "mutation", dbEffect: "payment_instances.status→unpaid, paid_at→null, audit_logs satırı", verifiedBy: "flows.spec.ts › ödendi → geri al" },
  { id: "payments/mark-partial", label: /^kısmi$/, klass: "mutation", dbEffect: "payment_instances.status→partial, paid_amount set", verifiedBy: "flows.spec.ts › kısmi ödeme" },
  { id: "payments/cancel", label: /^iptal$/, klass: "mutation", dbEffect: "payment_instances.status→cancelled + iptal nedeni", verifiedBy: "flows.spec.ts › örnek iptali" },
  // SIRA ÖNEMLİ: /payments/new'deki gönder düğmesinin etiketi de "kaydet"tir. Genel kural önce
  // gelseydi, ödeme OLUŞTURMA kontrolü "eksik tutarı kaydet" sanılırdı — kapsam raporu dolu
  // görünür, oluşturma akışı ise hiç doğrulanmamış olurdu. Kapının "ölü kural" uyarısı tam olarak
  // bunu yakaladı: payments/create hiçbir kontrolle eşleşmiyordu.
  { id: "payments/create", route: /^\/payments\/new$/, label: /^(kaydet|Kaydet|Oluştur|Ödemeyi kaydet)$/, klass: "mutation", dbEffect: "payments'a satır + payment_instances üretimi", verifiedBy: "flows.spec.ts › ödeme oluştur (pozitif + negatif)" },
  { id: "payments/set-amount", route: /^\/payments/, label: /^kaydet$/, klass: "mutation", dbEffect: "payment_instances.amount null→değer", verifiedBy: "flows.spec.ts › eksik tutarı kaydet" },
  { id: "payments/archive", label: /^Arşivle$/, klass: "mutation", dbEffect: "payments.status→archived (neden zorunlu)", verifiedBy: "flows.spec.ts › arşivle → geri yükle" },
  { id: "payments/restore", label: /^Geri yükle$/, klass: "mutation", dbEffect: "payments.status→active", verifiedBy: "flows.spec.ts › arşivle → geri yükle" },
];

const FINANCE: CoverageRule[] = [
  { id: "checks/settle", label: /^tahsil edildi$/, klass: "mutation", dbEffect: "checks.status→settled + check_events satırı", verifiedBy: "flows.spec.ts › çek tahsil/karşılıksız" },
  { id: "checks/bounce", label: /^karşılıksız$/, klass: "mutation", dbEffect: "checks.status→bounced + check_events satırı", verifiedBy: "flows.spec.ts › çek tahsil/karşılıksız" },
  { id: "checks/bordro-execute", route: /^\/finance\/checks$/, label: /^Bordroyu uygula$/, klass: "mutation", dbEffect: "check_bordros + checks durum geçişi + check_events + opsiyonel invoice_allocations/collateral_records/control_alerts", verifiedBy: "turkish-check-bordro.test.ts › ciro, tahsil, teminat LTV ve karşılıksız rücu döngüsü" },
  { id: "checks/create", route: /^\/finance\/checks\/new$/, label: /^Çeki kaydet$/, klass: "mutation", dbEffect: "checks'e satır", verifiedBy: "flows.spec.ts › çek oluştur (pozitif + negatif)" },
  { id: "loans/create", route: /^\/finance\/loans\/new$/, label: /^Krediyi ve planı oluştur$/, klass: "mutation", dbEffect: "loans + loan_installments satırları", verifiedBy: "flows.spec.ts › kredi oluştur" },
  { id: "counterparties/create", label: /^Karşı taraf ekle$/, klass: "mutation", dbEffect: "parties'e satır", verifiedBy: "flows.spec.ts › karşı taraf ekle" },
  { id: "fx/save", label: /^Kuru kaydet$/, klass: "mutation", dbEffect: "fx_rates'e satır", verifiedBy: "flows.spec.ts › döviz kuru kaydet" },
  { id: "invoices/draft", label: /^Taslak oluştur$/, klass: "mutation", dbEffect: "invoices'a taslak satır", verifiedBy: "flows.spec.ts › fatura taslağı" },
  { id: "promises/detect", label: /^Kırılan sözleri tespit et$/, klass: "mutation", dbEffect: "payment_promises.status→broken (vadesi geçenler)", verifiedBy: "flows.spec.ts › kırılan söz tespiti" },
  { id: "promises/save", label: /^Sözü kaydet$/, klass: "mutation", dbEffect: "payment_promises'a satır", verifiedBy: "flows.spec.ts › ödeme sözü kaydet" },
  { id: "bank/import", route: /^\/finance\/bank$/, label: /^İçe aktar$/, klass: "mutation", dbEffect: "bank_transactions satırları", verifiedBy: "flows.spec.ts › banka ekstresi içe aktar" },
  { id: "bank/match", label: /^Eşleştiriciyi çalıştır$/, klass: "mutation", dbEffect: "bank_transactions.matched_* alanları", verifiedBy: "flows.spec.ts › banka eşleştirici" },
  { id: "bank/save-account", route: /^\/finance\/bank$/, label: /^Kaydet$/, klass: "mutation", dbEffect: "cash_accounts satırı", verifiedBy: "flows.spec.ts › banka hesabı kaydet" },
  { id: "bank/accept-match", route: /^\/finance\/bank$/, label: /^kabul$/, klass: "mutation", dbEffect: "bank_transactions.status→matched + hedef fatura/ödeme/çek/taksit ve payment_run_items atomik kapanışı", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › acceptMatch atomik kapanış" },
  { id: "bank/reject-candidate", route: /^\/finance\/bank$/, label: /^reddet$/, klass: "mutation", dbEffect: "bank_transaction_match_candidates.rejected_at set", verifiedBy: "flows.spec.ts › banka eşleşme önerisi reddi" },
  { id: "bank/ignore", route: /^\/finance\/bank$/, label: /^yok say$/, klass: "mutation", dbEffect: "bank_transactions.status→ignored + ignored_reason", verifiedBy: "flows.spec.ts › banka hareketi yok sayma" },
  { id: "bank/reconcile-account", route: /^\/finance\/bank$/, label: /^Mutabakata al$/, klass: "mutation", dbEffect: "bank_transactions.status matched→reconciled + audit_logs reconcile_bank_account", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › reconcileBankAccount" },
  { id: "collections/bad-debt-mark", route: /^\/finance\/collections$/, label: /^şüpheli işaretle$/, klass: "mutation", dbEffect: "invoices.bad_debt_flagged→true + bad_debt_reason", verifiedBy: "flows.spec.ts › şüpheli alacak işaretle/kaldır" },
  { id: "collections/bad-debt-clear", route: /^\/finance\/collections$/, label: /^işareti kaldır$/, klass: "mutation", dbEffect: "invoices.bad_debt_flagged→false", verifiedBy: "flows.spec.ts › şüpheli alacak işaretle/kaldır" },
  { id: "collections/payment-run-create", route: /^\/finance\/collections$/, label: /^Ödeme paketi oluştur$/, klass: "mutation", dbEffect: "payment_runs + payment_run_items satırları + 14g kasa simülasyonu", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › createPaymentRun & 14g simülasyon" },
  { id: "collections/payment-run-submit", route: /^\/finance\/collections$/, label: /^Onaya gönder$/, klass: "mutation", dbEffect: "payment_runs.status draft→pending_approval + approvals satırı", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › submitPaymentRunForApproval" },
  { id: "collections/payment-run-cancel", route: /^\/finance\/collections$/, label: /^Paketi iptal et$/, klass: "mutation", dbEffect: "payment_runs.status→cancelled + payment_run_items.status→excluded", verifiedBy: "payment-runs-approvals-and-bank-settlement.test.ts › cancelPaymentRun" },
  { id: "treasury/save", route: /^\/finance\/treasury$/, label: /^kaydet$/, klass: "mutation", dbEffect: "treasury/likidite ayarı satırı", verifiedBy: "flows.spec.ts › hazine ayarı kaydet" },
  { id: "cashflow/lock-period", route: /^\/cashflow\//, label: /^Dönemi kilitle$/, klass: "mutation", dbEffect: "cashflow_months.status→locked, locked_at/lock_fingerprint set + audit_logs lock_cashflow_period", verifiedBy: "period-lock.test.ts & flows.spec.ts › dönem kilitleme" },
  { id: "cashflow/reopen-disclosure", route: /^\/cashflow\//, label: /^Kilidi yeniden aç$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › kilit açma çekmecesi açılır" },
  { id: "cashflow/reopen-period", route: /^\/cashflow\//, label: /^Kilidi aç$/, klass: "mutation", dbEffect: "cashflow_months.status→reviewed, reopen_reason/reopened_at set + audit_logs reopen_cashflow_period", verifiedBy: "period-lock.test.ts & flows.spec.ts › gerekçeli dönem kilidi açma" },
  { id: "cashflow/controls-create-task", route: /^\/cashflow\/controls$/, label: /^Görev aç$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + audit_logs", verifiedBy: "closed-loops-d4.test.ts › createReconciliationTask" },
  { id: "budget/disclosure", route: /^\/cashflow\/budget$/, label: /^\+ (Yeni Bütçe Kabı Oluştur|Taslak Bütçe Satırı Ekle|13 Haftalık Tahmin Kabı ve Satırı Ekle)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › bütçe ve tahmin çekmeceleri açılır" },
  { id: "budget/create", route: /^\/cashflow\/budget$/, label: /^Bütçe oluştur$/, klass: "mutation", dbEffect: "budgets satırı + audit_logs create_budget", verifiedBy: "closed-loops-d4.test.ts › createBudget" },
  { id: "budget/add-line", route: /^\/cashflow\/budget$/, label: /^Taslak satır ekle$/, klass: "mutation", dbEffect: "budget_lines (version_status=draft) satırı + audit_logs", verifiedBy: "closed-loops-d4.test.ts › createBudgetLine" },
  { id: "budget/create-forecast", route: /^\/cashflow\/budget$/, label: /^Tahmin kabı aç$/, klass: "mutation", dbEffect: "forecasts satırı + audit_logs create_forecast", verifiedBy: "closed-loops-d4.test.ts › createForecast" },
  { id: "budget/add-forecast-line", route: /^\/cashflow\/budget$/, label: /^Tahmin satırı ekle$/, klass: "mutation", dbEffect: "forecast_lines (version_status=draft) satırı + audit_logs", verifiedBy: "closed-loops-d4.test.ts › createForecastLine" },
  { id: "budget/submit-approval", route: /^\/cashflow\/budget$/, label: /^Onaya gönder$/, klass: "mutation", dbEffect: "approvals (entity_table=budget_lines|forecast_lines, status=pending) satırı", verifiedBy: "closed-loops-d4.test.ts › requestPlanningLineApproval" },
  { id: "budget/approve-version", route: /^\/cashflow\/budget$/, label: /(Versiyonu onayla|^Onayla$|\(\d+ taslak\) onayla)$/, klass: "mutation", dbEffect: "budget_lines|forecast_lines version_status draft→approved (maker≠checker) + budget_vs_actual görünümü canlanır", verifiedBy: "closed-loops-d4.test.ts › approveBudgetVersion maker-checker + budget_vs_actual varyansı" },
  { id: "facilities/disclosure", route: /^\/finance\/facilities$/, label: /^\+ (Yeni Kredi Limiti Tanımla|Kullanım \(Drawdown\) \/ Geri Ödeme \/ Limit Revizyonu İşle|Teminat Ekle \(İpotek \/ Rehin \/ Kefalet \/ Blokaj\)|Kovenant Maddesi ve Ölçüm Ekle \/ Güncelle)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › kredi limitleri çekmeceleri açılır" },
  { id: "facilities/create", route: /^\/finance\/facilities$/, label: /^Kredi limitini kaydet$/, klass: "mutation", dbEffect: "credit_facilities satırı + audit_logs create_credit_facility", verifiedBy: "closed-loops-d4.test.ts › createFacility" },
  { id: "facilities/movement", route: /^\/finance\/facilities$/, label: /^Hareketi kaydet$/, klass: "mutation", dbEffect: "facility_movements satırı + credit_facilities.drawn_amount atomik tetikleyici güncellemesi", verifiedBy: "closed-loops-d4.test.ts › recordFacilityMovement + optimization çözücüsü" },
  { id: "facilities/collateral", route: /^\/finance\/facilities$/, label: /^Teminatı kaydet$/, klass: "mutation", dbEffect: "collateral_records satırı + audit_logs add_collateral", verifiedBy: "closed-loops-d4.test.ts › addCollateral" },
  { id: "facilities/covenant", route: /^\/finance\/facilities$/, label: /^Kovenantı kaydet$/, klass: "mutation", dbEffect: "covenant_records ekleme/ölçüm güncellemesi + audit_logs upsert_covenant", verifiedBy: "closed-loops-d4.test.ts › upsertCovenant" },
  { id: "counterparties/disclosure", route: /^\/finance\/counterparties$/, label: /^\+ Yeni (IBAN|boyut) ekle$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › IBAN ve boyut çekmeceleri açılır" },
  { id: "counterparties/link-unresolved", route: /^\/finance\/counterparties$/, label: /^eşleştir$/, klass: "mutation", dbEffect: "checks payer_party_id|payee_party_id güncellenir + audit_logs", verifiedBy: "flows.spec.ts › eşleşmemiş karşı taraf bağlama" },
  { id: "counterparties/add-iban", route: /^\/finance\/counterparties$/, label: /^IBAN kaydet$/, klass: "mutation", dbEffect: "counterparty_ibans + iban_change_events (added) satırı", verifiedBy: "closed-loops-d4.test.ts › addIban iban_change_events izi" },
  { id: "counterparties/deactivate-iban", route: /^\/finance\/counterparties$/, label: /^Pasife al$/, klass: "mutation", dbEffect: "counterparty_ibans.is_active→false + iban_change_events (deactivated) satırı", verifiedBy: "closed-loops-d4.test.ts › deactivateIban iban_change_events izi" },
  { id: "counterparties/create-dimension", route: /^\/finance\/counterparties$/, label: /^Boyut oluştur$/, klass: "mutation", dbEffect: "projects|cost_centers|departments satırı + audit_logs", verifiedBy: "closed-loops-d4.test.ts › createDimension departments" },
  { id: "profitability/rule-disclosure", route: /^\/finance\/profitability$/, label: /^Dağıtım kuralı güncelle$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › dağıtım kuralı çekmecesi açılır" },
  { id: "profitability/rule-save", route: /^\/finance\/profitability$/, label: /^Kuralı kaydet$/, klass: "mutation", dbEffect: "cost_allocation_rules güncellenir + audit_logs update_allocation_rule", verifiedBy: "closed-loops-d4.test.ts › updateAllocationRule" },
  { id: "invoices/approve-draft", route: /^\/finance\/invoices$/, label: /^düzenle \(onayla\)$/, klass: "mutation", dbEffect: "invoices.status draft→open + audit_logs", verifiedBy: "flows.spec.ts › fatura taslağı onayı" },
  { id: "invoices/record-payment", route: /^\/finance\/invoices$/, label: /^(tahsil|ödeme)$/, klass: "mutation", dbEffect: "invoice_payments + invoices.paid_amount/status güncellenir", verifiedBy: "flows.spec.ts › fatura tahsil/ödeme kaydı" },
  { id: "receivables/allocate", route: /^\/finance\/receivables$/, label: /^dağıt$/, klass: "mutation", dbEffect: "invoice_allocations satırı + invoices.paid_amount tetikleyici güncellemesi", verifiedBy: "closed-loops-d4.test.ts › allocateSettlement" },
  { id: "receivables/reverse-allocation", route: /^\/finance\/receivables$/, label: /^Geri al$/, klass: "mutation", dbEffect: "invoice_allocations.reversed_at set + fatura açık bakiyesi geri yüklenir", verifiedBy: "closed-loops-d4.test.ts › reverseAllocation" },
  { id: "ledger/sync-from-domain", route: /^\/finance\/ledger$/, label: /^Operasyonel Kayıtlardan Yönetim Defterini Senkronla \(Idempotent\)$/, klass: "mutation", dbEffect: "management_journal_entries + management_journal_lines + audit_logs", verifiedBy: "management-ledger-tdhp.test.ts › rebuildOrSyncManagementLedger" },
  { id: "ledger/create-sub-account", route: /^\/finance\/ledger$/, label: /^TDHP Alt Hesap Aç$/, klass: "mutation", dbEffect: "management_accounts satırı + audit_logs upsert_management_account", verifiedBy: "management-ledger-tdhp.test.ts › createManagementSubAccount" },
  { id: "ledger/post-manual-adjustment", route: /^\/finance\/ledger$/, label: /^Tahakkuk Fişi Kaydet$/, klass: "mutation", dbEffect: "management_journal_entries + management_journal_lines + audit_logs", verifiedBy: "management-ledger-tdhp.test.ts › postManualManagementAdjustment" },
  { id: "ledger/approve-draft", route: /^\/finance\/ledger$/, label: /^Onayla \(Post\)$/, klass: "mutation", dbEffect: "management_journal_entries.status draft→posted + audit_logs", verifiedBy: "management-ledger-tdhp.test.ts › approveDraftManagementEntry" },
  { id: "cashflow-13w/refresh", route: /^\/cashflow\/13-week$/, label: /^Açık Kayıtlardan Otomatik Yenile$/, klass: "ui-state", verifiedBy: "rolling-13w-and-variance-waterfall.test.ts › buildAutoSeeded13WeekForecast" },
  { id: "cashflow-13w/freeze", route: /^\/cashflow\/13-week$/, label: /^Haftalık Tahmin Anlık Görüntüsünü Dondur/, klass: "mutation", dbEffect: "forecast_snapshots_13w + forecast_snapshot_13w_lines satırları + audit_logs freeze_forecast_13w_snapshot", verifiedBy: "rolling-13w-and-variance-waterfall.test.ts › freezeWeekly13wSnapshot" },
  { id: "cashflow-13w/manual-override", route: /^\/cashflow\/13-week$/, label: /^Manuel Tahmin Satırı Ekle$/, klass: "mutation", dbEffect: "forecasts + forecast_lines (source_kind=manual) satırı + audit_logs", verifiedBy: "rolling-13w-and-variance-waterfall.test.ts › manual_override" },
  { id: "ledger/reverse-entry", route: /^\/finance\/ledger$/, label: /^Ters Kayıt \(Storno\)$/, klass: "mutation", dbEffect: "management_journal_entries reversal satırı + orijinal status=reversed + audit_logs", verifiedBy: "management-ledger-tdhp.test.ts › reverseManagementEntry" },
];

const SCENARIOS: CoverageRule[] = [
  { id: "scenarios/preset", label: /^(Gelir %10 düşerse|Gider %10 artarsa|Gelir %10 artarsa)$/, klass: "mutation", dbEffect: "scenario_runs satırı", verifiedBy: "flows.spec.ts › hazır senaryo çalıştır" },
  { id: "scenarios/run", label: /^Senaryoyu çalıştır$/, klass: "mutation", dbEffect: "scenario_runs satırı", verifiedBy: "flows.spec.ts › özel senaryo çalıştır" },
  { id: "scenarios/run-save", label: /^Çalıştır ve kaydet$/, klass: "mutation", dbEffect: "scenarios + scenario_runs satırları", verifiedBy: "flows.spec.ts › senaryo kaydet" },
  { id: "scenarios/compare", route: /^\/scenarios\/compare$/, label: /^Karşılaştır$/, klass: "mutation", dbEffect: "scenario_runs okunur; karşılaştırma sonucu ekrana çıkar", verifiedBy: "flows.spec.ts › senaryo karşılaştır" },
  { id: "scenarios/assumptions-disclosure", label: /^Varsayımları göster$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › varsayım paneli açılır" },
  { id: "scenarios/goalseek-horizon", route: /^\/scenarios$/, label: /^Ufku Hesapla$/, klass: "ui-state", verifiedBy: "cfo-intelligence-f2.test.ts › solveBreakevenLevers" },
];

const INSIGHTS: CoverageRule[] = [
  { id: "ask/suggested", label: /^(Bugün ne ödenecek\?|7 günde ne kadar çıkış var\?|Kasa ne zaman negatife düşüyor\?|En büyük yoğunlaşma nerede\?|Hangi aksiyon öncelikli\?)$/, klass: "mutation", dbEffect: "ai_answers satırı (kaynak izi ile)", verifiedBy: "flows.spec.ts › önerilen soru cevaplanır ve saklanır" },
  { id: "ask/answer", label: /^Cevapla$/, klass: "mutation", dbEffect: "ai_answers satırı", verifiedBy: "flows.spec.ts › serbest soru cevaplanır" },
  { id: "ask/telegram-query", route: /^\/insights\/ask$/, label: /^Sorgula$/, klass: "ui-state", verifiedBy: "telegram-cfo-assistant.test.ts › answerTelegramQuestion salt-okunur sorgu" },
  { id: "briefing/generate", label: /^Brifingi üret ve kaydet$/, klass: "mutation", dbEffect: "briefings satırı", verifiedBy: "flows.spec.ts › brifing üret" },
  { id: "reports/generate", label: /^(Günlük üret →|Haftalık üret →|Aylık üret →)$/, klass: "mutation", dbEffect: "reports satırı", verifiedBy: "flows.spec.ts › rapor üret (idempotency dahil)" },
  { id: "tasks/create-from-insight", label: /^(gorev|Görev oluştur)$/, klass: "mutation", dbEffect: "action_items satırı", verifiedBy: "flows.spec.ts › içgörüden görev oluştur" },
  { id: "reminders/plan-today", label: /^bugünü planla →$/, klass: "mutation", dbEffect: "reminders satırları (planned)", verifiedBy: "flows.spec.ts › bugünü planla" },
  { id: "reminders/send-pending", label: /^bekleyenleri gönder \(Telegram\) →$/, klass: "mutation", dbEffect: "reminder_dispatches satırı (sent|failed) — yapılandırma yoksa DÜRÜST hata", verifiedBy: "flows.spec.ts › bekleyenleri gönder (yapılandırma yoksa dürüst geri bildirim)" },
];

const DATA: CoverageRule[] = [
  { id: "tasks/start", label: /^Başlat$/, klass: "mutation", dbEffect: "action_items.status→in_progress", verifiedBy: "flows.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/block", label: /^Engelle$/, klass: "mutation", dbEffect: "action_items.status→blocked", verifiedBy: "flows.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/complete", label: /^Tamamla$/, klass: "mutation", dbEffect: "action_items.status→done + completion note", verifiedBy: "flows.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/cancel", label: /^İptal$/, klass: "mutation", dbEffect: "action_items.status→cancelled", verifiedBy: "flows.spec.ts › görev yaşam döngüsü" },
  { id: "tasks/create", label: /^Oluştur$/, klass: "mutation", dbEffect: "action_items satırı", verifiedBy: "flows.spec.ts › manuel görev oluştur" },
  { id: "reviews/accept", label: /^Kabul$/, klass: "mutation", dbEffect: "import_reviews.status→accepted", verifiedBy: "flows.spec.ts › içe aktarım incelemesi" },
  { id: "reviews/reject", label: /^Reddet$/, klass: "mutation", dbEffect: "import_reviews.status→rejected | approvals.status→rejected", verifiedBy: "flows.spec.ts › inceleme reddi / onay reddi" },
  { id: "reviews/resolve", label: /^Çöz$/, klass: "mutation", dbEffect: "import_reviews.status→resolved", verifiedBy: "flows.spec.ts › içe aktarım incelemesi" },
  { id: "assumptions/approve", label: /^onay$/, klass: "mutation", dbEffect: "assumptions.status→approved", verifiedBy: "flows.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/reject", label: /^ret$/, klass: "mutation", dbEffect: "assumptions.status→rejected", verifiedBy: "flows.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/archive", label: /^arşiv$/, klass: "mutation", dbEffect: "assumptions.status→archived", verifiedBy: "flows.spec.ts › varsayım onay/ret/arşiv" },
  { id: "assumptions/save", route: /^\/data\/assumptions$/, label: /^kaydet$/, klass: "mutation", dbEffect: "assumptions satırı", verifiedBy: "flows.spec.ts › varsayım oluştur" },
  { id: "approvals/approve", label: /^Onayla$/, klass: "mutation", dbEffect: "approvals.status→approved (maker-checker: talep eden onaylayamaz)", verifiedBy: "flows.spec.ts › onay akışı + rol zorlaması" },
  { id: "approvals/revise", label: /^Revizyon$/, klass: "mutation", dbEffect: "approvals.status→revision_requested", verifiedBy: "flows.spec.ts › onay akışı + rol zorlaması" },
  { id: "imports/upload", label: /^İÇE AKTAR$/, klass: "mutation", dbEffect: "source_workbooks + source_sheets + source_cells satırları", verifiedBy: "flows.spec.ts › çalışma kitabı içe aktar" },
  { id: "imports/file-input", label: /^\(etiketsiz\)$/, tag: /^input$/, route: /imports/, klass: "ui-state", verifiedBy: "flows.spec.ts › çalışma kitabı içe aktar (dosya seçimi)" },
  { id: "documents/file-input", label: /^\(etiketsiz\)$/, tag: /^input$/, route: /^\/data\/documents$/, klass: "ui-state", verifiedBy: "closed-loops-d4.test.ts › uploadValidatedDocument dosya seçimi" },
  { id: "documents/upload", route: /^\/data\/documents$/, label: /^Kasaya yükle ve doğrula$/, klass: "mutation", dbEffect: "documents + document_versions + opsiyonel document_links + içerik adresli SHA-256 disk kaydı", verifiedBy: "closed-loops-d4.test.ts › uploadValidatedDocument + SHA-256 doğrulama" },
  { id: "documents/attach", route: /^\/data\/documents$/, label: /^Kayda ekle \(attachToEntity\)$/, klass: "mutation", dbEffect: "document_links satırı + audit_logs", verifiedBy: "closed-loops-d4.test.ts › linkDocument" },
  { id: "reconciliation/signoff", route: /^\/data\/reconciliation$/, label: /^Mutabakatı imzala$/, klass: "mutation", dbEffect: "reconciliation_signoffs (append-only kanıt) satırı + audit_logs signoff_reconciliation", verifiedBy: "closed-loops-d4.test.ts › signOffReconciliation append-only" },
  { id: "reconciliation/create-task", route: /^\/data\/reconciliation$/, label: /^(Aksiyon görevi aç|Görev üret)$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + audit_logs", verifiedBy: "closed-loops-d4.test.ts › createReconciliationTask" },
  { id: "trial-balance/file-input", route: /^\/data\/trial-balance-bridge$/, label: /^\(etiketsiz\)$/, tag: /^input$/, klass: "ui-state", verifiedBy: "statutory-mizan-bridge.test.ts › importStatutoryMizan" },
  { id: "trial-balance/import-and-reconcile", route: /^\/data\/trial-balance-bridge$/, label: /^Yasal Mizanı Yükle & Köprüyü Çalıştır$/, klass: "mutation", dbEffect: "statutory_trial_balances + statutory_trial_balance_lines + trial_balance_reconciliation_runs + trial_balance_reconciliation_items + audit_logs", verifiedBy: "statutory-mizan-bridge.test.ts › importStatutoryMizan + reconcileTrialBalance" },
  { id: "trial-balance/rerun", route: /^\/data\/trial-balance-bridge$/, label: /^Seçili Mizanla Mutabakatı Yenile$/, klass: "mutation", dbEffect: "trial_balance_reconciliation_runs + trial_balance_reconciliation_items + audit_logs", verifiedBy: "statutory-mizan-bridge.test.ts › reconcileTrialBalance" },
  { id: "trial-balance/create-task", route: /^\/data\/trial-balance-bridge$/, label: /^Görev Aç$/, klass: "mutation", dbEffect: "action_items satırı (source_type=control) + trial_balance_reconciliation_items.action_item_id + audit_logs", verifiedBy: "statutory-mizan-bridge.test.ts › createActionFromReconciliationItem" },
];

const SYSTEM: CoverageRule[] = [
  { id: "system/refresh-metrics", label: /^Metrikleri yenile$/, klass: "mutation", dbEffect: "metric_snapshots satırı", verifiedBy: "flows.spec.ts › metrikleri yenile" },
  { id: "system/diagnostics-refresh", label: /^Yenile$/, klass: "ui-state", verifiedBy: "shell.spec.ts › tanılama yenile sayfayı yeniden okur" },
  { id: "system/role-select", route: /^\/system\/security$/, label: /izleyicifinans/, tag: /^select$/, klass: "mutation", dbEffect: "users.role — yalnız admin; yetkisiz rol backend'de REDDEDİLİR", verifiedBy: "flows.spec.ts › rol değiştirme + yetki zorlaması" },
  { id: "system/change-role", route: /^\/system\/security$/, label: /^rolü değiştir$/, klass: "mutation", dbEffect: "users.role güncellenir + audit_logs", verifiedBy: "flows.spec.ts › rol değiştirme + yetki zorlaması" },
  { id: "system/deactivate-user", route: /^\/system\/security$/, label: /^pasifleştir$/, klass: "mutation", dbEffect: "users.is_active→false; oturumları iptal", verifiedBy: "flows.spec.ts › kullanıcı pasifleştir" },
  { id: "system/create-user", route: /^\/system\/security$/, label: /^kullanıcı oluştur$/, klass: "mutation", dbEffect: "users satırı", verifiedBy: "flows.spec.ts › kullanıcı oluştur" },
  { id: "system/reset-password", route: /^\/system\/security$/, label: /^sıfırla$/, klass: "mutation", dbEffect: "users.password_hash değişir; failed_login_count sıfırlanır", verifiedBy: "flows.spec.ts › parola sıfırla" },
  // Wave 0 KEEP özelliği (0095): her satırda, bayrağı false olan kullanıcıda render edilir — CI'ın
  // beş görsel kullanıcısında da. Kuralı olmadan kapı onu "manifestosuz" sayıp ratchet'i her modda
  // kırmızıya çeviriyordu. Tıklama ayrılmış bir fixture kullanıcısının satırında yapılır; görsel
  // rol kullanıcılarından birine basılsaydı o rolün sonraki her oturumu /change-password'e düşerdi.
  { id: "system/force-password-change", route: /^\/system\/security$/, label: /^şifre değişimi zorla$/, klass: "mutation", dbEffect: "users.must_change_password→true + audit_logs force_password_change", verifiedBy: "mutations.spec.ts › system/force-password-change: 'şifre değişimi zorla' GERÇEKTEN yazıyor" },
  { id: "system/drain-queue", route: /^\/system\/jobs$/, label: /^Kuyruğu süpür$/, klass: "mutation", dbEffect: "job_runs satırı; kuyruk boşalır", verifiedBy: "flows.spec.ts › iş kuyruğunu süpür" },
  { id: "system/archive-filter", route: /^\/system\/archive$/, label: /^Filtrele$/, klass: "ui-state", verifiedBy: "shell.spec.ts › arşiv filtresi sonuç kümesini daraltır" },
  { id: "tasks/search", route: /^\/insights\/tasks$/, label: /^Ara$/, klass: "ui-state", verifiedBy: "shell.spec.ts › görev arama sonuç kümesini daraltır" },
  { id: "production/disclosure", route: /^\/production(\/costs|\/roi)?$/, label: /^\+ (Kapasite \/ vardiya parametresi ekle|Sabit maliyet kalemi ekle \/ güncelle|Makine \/ yıllık ROI kaydı ekle veya güncelle)$/, tag: /^summary$/, klass: "ui-state", verifiedBy: "shell.spec.ts › üretim parametre çekmeceleri açılır" },
  { id: "production/save-capacity", route: /^\/production$/, label: /^Parametreyi kaydet$/, klass: "mutation", dbEffect: "capacity_models + machine_rates satırları + audit_logs", verifiedBy: "closed-loops-d4.test.ts › upsertCapacityModelManual" },
  { id: "production/save-cost-item", route: /^\/production\/costs$/, label: /^Maliyet kalemini kaydet$/, klass: "mutation", dbEffect: "cost_models + cost_model_items + break_even_tl_per_min yeniden hesabı + audit_logs", verifiedBy: "closed-loops-d4.test.ts › upsertCostModelManual" },
  { id: "production/save-machine-roi", route: /^\/production\/roi$/, label: /^Makineyi kaydet$/, klass: "mutation", dbEffect: "machine_assets + machine_roi_snapshots satırları + audit_logs", verifiedBy: "closed-loops-d4.test.ts › upsertMachineRoiManual" },
  { id: "integrations/add-connection", route: /^\/data\/integrations$/, label: /^Bağlantı Ekle$/, klass: "mutation", dbEffect: "integration_connections satırı + audit_logs create_integration_connection", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › createConnection" },
  { id: "integrations/sync-now", route: /^\/data\/integrations$/, label: /^Şimdi Çek$/, klass: "mutation", dbEffect: "background_jobs accounting_sync satırı", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › parasutConnector.sync" },
  { id: "integrations/toggle-status", route: /^\/data\/integrations$/, label: /^(Durdur|Etkinleştir)$/, klass: "mutation", dbEffect: "integration_connections.status güncellenir + audit_logs", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › toggleIntegrationStatusAction" },
  { id: "integrations/resolve-staged-party", route: /^\/data\/integrations$/, label: /^(Yeni Cari Aç|Bağla|Yoksay)$/, klass: "mutation", dbEffect: "integration_staged_parties + parties (createCounterparty) + integration_entity_links + audit_logs", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › S-10 staged party" },
  { id: "integrations/save-account-mapping", route: /^\/data\/integrations$/, label: /^Hesap Eşlemesini Kaydet$/, klass: "mutation", dbEffect: "integration_account_mappings satırı + audit_logs", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › integration_account_mappings" },
  { id: "integrations/import-hybrid-bank", route: /^\/data\/integrations$/, label: /^Hibrit Ekstreyi İçe Aktar ve Tekilleştir$/, klass: "mutation", dbEffect: "bank_transactions + cross_channel_dedupe_hash + source_workbooks + audit_logs", verifiedBy: "parasut-v4-and-hybrid-bank.test.ts › importHybridBankStatement" },
];

/* ── 6) Dış entegrasyonlar — canlı doğrulanamayanlar ─────────────────────────────────────── */

/**
 * SADECE buradaki kontroller `EXTERNAL_NOT_LIVE_VERIFIABLE` olabilir.
 *
 * Her satır dört şeyi SÖYLEMEK ZORUNDA. Boş bırakılan bir alan kapıyı kırar — çünkü bu listenin
 * tek işlevi, "çalışıyor" kelimesinin dürüst kullanılmasını sağlamaktır. Mock HTTP istemcisiyle
 * geçen bir buton "production-ready entegrasyon" DEĞİLDİR ve UI de öyle göstermemelidir.
 */
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
