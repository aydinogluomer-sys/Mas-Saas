// AŞAMA 08 — Consolidated Financial Correctness Gate: the deterministic golden fixture pack.
//
// NEDEN BU DOSYA VAR.
// Bu depoda para doğruluğu zaten test ediliyor — money.test.ts yuvarlamayı, domain süitleri
// fatura/çek/kredi/FX/bütçe kurallarını, financial-invariants.test.ts üç kayıp invariant'ı
// çiviliyor. Eksik olan şey kapsam değil, TEK BİR release-level artefakt'tı: bir denetçinin
// "paranın doğru olduğunu nerede görüyorum" sorusuna gösterebileceği tek dosya. Bu paket odur.
// Mevcut testlerle örtüşmesi kabul edilmiştir; katma değer konsolidasyon + elle yazılmış
// beklenen değerlerdir.
//
// ═══ TEK VE EN ÖNEMLİ KURAL (rehber §30.2 — "self-fulfilling finance check") ═══
//
// Buradaki HER beklenen değer elle hesaplanmış bir LİTERAL'dir. Hiçbiri, test edilecek
// fonksiyonun kendisi çağrılarak üretilmemiştir. Her vakanın `derivation` alanı, o literali
// üreten aritmetiği yazıyla taşır; bir insan onu hesap makinesiyle yeniden üretebilmelidir.
// Bir beklenen değeri elle hesaplayamıyorsanız, hesaplayabileceğiniz daha basit bir vaka seçin.
//
// Bu dosya SAF VERİdir: vitest import etmez, ürün kodu import etmez, hiçbir şey hesaplamaz.
// Böylece "beklenen" ile "gerçek" arasında paylaşılan tek satır kod bile kalmaz.
//
// TARİH SABİTİ. Zamana bağlı her vaka BUGÜN'ü 2026-08-25 kabul eder. Sistem saatinden
// okunmaz; okunsaydı paket bir gün sessizce anlamını değiştirirdi.

/** Her vakanın ortak gövdesi. `derivation` bir yorum değil, taşınan kanıttır. */
export interface GoldenCase<TInput, TExpected> {
  /** Kararlı kimlik — rapor ve kapsam haritası bunu referans alır. */
  readonly id: string;
  /** Rehber §13'teki kapsam listesindeki başlık. */
  readonly area: GoldenArea;
  /** Türkçe, iş dilinde açıklama. */
  readonly description: string;
  readonly input: TInput;
  readonly expected: TExpected;
  /** Beklenen değeri üreten aritmetik, elle. */
  readonly derivation: string;
}

export type GoldenArea =
  | "payment"
  | "partial payment"
  | "overpayment"
  | "overdue"
  | "check"
  | "loan"
  | "invoice"
  | "receivable"
  | "allocation"
  | "FX"
  | "budget"
  | "forecast"
  | "reversal"
  | "cashflow identity";

/** Rehber §13'ün kapsam listesi. Test dosyası her başlığın kapsandığını ispatlar. */
export const REQUIRED_AREAS: readonly GoldenArea[] = [
  "payment",
  "partial payment",
  "overpayment",
  "overdue",
  "check",
  "loan",
  "invoice",
  "receivable",
  "allocation",
  "FX",
  "budget",
  "forecast",
  "reversal",
  "cashflow identity",
] as const;

/** Zamana bağlı her vakanın "bugün"ü. Sistem saatinden ASLA okunmaz. */
export const TODAY = "2026-08-25";

/* ════════════════════════════════════════════════════════════════════════════════════════
   payment — vade günü üretimi ve gün seviyesinde risk
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const PAYMENT_DUE_DAY_31 = Object.freeze({
  id: "FIN-PAY-01",
  area: "payment",
  description:
    "Ayın 31'inde ödenen tekrarlayan ödeme: kısa aylarda ayın son gününe çekilir ve bu " +
    "çekme işlemi bayrakla açıkça bildirilir.",
  input: {
    dueDay: 31,
    monthStarts: ["2026-01-01", "2026-02-01", "2026-04-01", "2028-02-01"],
  },
  expected: [
    // Ocak 2026: 31 gün → 31 ≤ 31, çekme yok
    { dueDate: "2026-01-31", shortMonthAdjusted: false },
    // Şubat 2026: 2026 dörde bölünmez → 28 gün → min(31,28) = 28, çekme VAR
    { dueDate: "2026-02-28", shortMonthAdjusted: true },
    // Nisan 2026: 30 gün → min(31,30) = 30, çekme VAR
    { dueDate: "2026-04-30", shortMonthAdjusted: true },
    // Şubat 2028: 2028 artık yıl → 29 gün → min(31,29) = 29, çekme VAR
    { dueDate: "2028-02-29", shortMonthAdjusted: true },
  ],
  derivation:
    "dueDate = min(dueDay, o ayın gün sayısı). 2026 artık yıl değil (2026/4 = 506,5), " +
    "2028 artık yıl (2028/4 = 507, yüzyıl değil). Şubat 2026 = 28, Nisan = 30, Şubat 2028 = 29.",
} as const satisfies GoldenCase<
  { dueDay: number; monthStarts: readonly string[] },
  ReadonlyArray<{ dueDate: string; shortMonthAdjusted: boolean }>
>);

export const PAYMENT_DAY_FLAGS = Object.freeze({
  id: "FIN-PAY-02",
  area: "payment",
  description:
    "Tek günün ödeme yükü: ödenmiş kalem güne yük yazmaz, tutarı bilinmeyen kalem sıfır " +
    "sayılmaz, üç açık kalem kümelenme eşiğini tetikler.",
  input: {
    thresholds: { large: 50_000, critical: 250_000, clusterCount: 3 },
    instances: [
      { id: "P-A", dueDate: "2026-09-10", amount: 20_000, status: "unpaid", currency: "TRY" },
      { id: "P-B", dueDate: "2026-09-10", amount: 15_000.5, status: "unpaid", currency: "TRY" },
      { id: "P-C", dueDate: "2026-09-10", amount: null, status: "unpaid", currency: "TRY" },
      { id: "P-D", dueDate: "2026-09-10", amount: 90_000, status: "paid", currency: "TRY" },
    ],
  },
  expected: {
    count: 3,
    knownSum: 35_000.5,
    cluster: true,
    large: false,
    critical: false,
    foreignCount: 0,
  },
  derivation:
    "Açık kalemler: P-A, P-B, P-C (P-D 'paid' → açık değil, güne yük yazmaz). " +
    "Dört kalem de TRY (PHASE 2.2: eşikler *_threshold_try, yalnız TRY kalemler tartılır) → " +
    "foreignCount = 0; TRY-dışı kalem olsaydı toplama girmez ama burada sayılırdı. " +
    "knownSum = 20.000,00 + 15.000,50 = 35.000,50 (P-C null → toplama girmez, 0 sayılmaz). " +
    "count = 3 ≥ clusterCount 3 → cluster = true. " +
    "Açık kalemlerin hiçbiri 50.000 eşiğine ulaşmıyor → large = false. " +
    "35.000,50 < 250.000 ve tekil kritik yok → critical = false. " +
    "P-D 90.000 ödenmiş olduğu için large'ı tetiklemez — bu vakanın asıl kanıtı budur.",
} as const);

export const PAYMENT_THRESHOLD_BOUNDARY = Object.freeze({
  id: "FIN-PAY-04",
  area: "payment",
  description:
    "Gün eşiklerinin TAM SINIRI. dayFlags karşılaştırması '>=' olduğu için eşiğin tam " +
    "üstünde oturan gün bayrağı TETİKLER; bir kuruş altı tetiklemez. Ayrıca kritik eşiği " +
    "tek kalemle değil, günün TOPLAMIYLA da tetiklenebilir — asıl sınav orasıdır.",
  input: {
    thresholds: { large: 50_000, critical: 250_000, clusterCount: 3 },
    // 1) tek kalem tam kritik eşiğinde
    criticalExactly: [{ id: "B-1", dueDate: "2026-09-10", amount: 250_000.0, status: "unpaid", currency: "TRY" }],
    // 2) tek kalem kritik eşiğinin bir kuruş altında
    criticalOneKurusBelow: [
      { id: "B-2", dueDate: "2026-09-10", amount: 249_999.99, status: "unpaid", currency: "TRY" },
    ],
    // 3) tek kalem tam büyük-ödeme eşiğinde
    largeExactly: [{ id: "B-3", dueDate: "2026-09-10", amount: 50_000.0, status: "unpaid", currency: "TRY" }],
    // 4) tek kalem büyük-ödeme eşiğinin bir kuruş altında
    largeOneKurusBelow: [
      { id: "B-4", dueDate: "2026-09-10", amount: 49_999.99, status: "unpaid", currency: "TRY" },
    ],
    // 5) hiçbir kalem tek başına kritik değil ama GÜN TOPLAMI kuruşu kuruşuna eşikte
    criticalBySumExactly: [
      { id: "B-5a", dueDate: "2026-09-10", amount: 173_885.27, status: "unpaid", currency: "TRY" },
      { id: "B-5b", dueDate: "2026-09-10", amount: 21_752.99, status: "unpaid", currency: "TRY" },
      { id: "B-5c", dueDate: "2026-09-10", amount: 47_810.9, status: "unpaid", currency: "TRY" },
      { id: "B-5d", dueDate: "2026-09-10", amount: 6_550.84, status: "unpaid", currency: "TRY" },
    ],
    // 6) aynı gün, son kalem bir kuruş eksik
    criticalBySumOneKurusBelow: [
      { id: "B-6a", dueDate: "2026-09-10", amount: 173_885.27, status: "unpaid", currency: "TRY" },
      { id: "B-6b", dueDate: "2026-09-10", amount: 21_752.99, status: "unpaid", currency: "TRY" },
      { id: "B-6c", dueDate: "2026-09-10", amount: 47_810.9, status: "unpaid", currency: "TRY" },
      { id: "B-6d", dueDate: "2026-09-10", amount: 6_550.83, status: "unpaid", currency: "TRY" },
    ],
  },
  expected: {
    criticalExactly: {
      count: 1, knownSum: 250_000.0, cluster: false, large: true, critical: true, foreignCount: 0 },
    criticalOneKurusBelow: {
      count: 1, knownSum: 249_999.99, cluster: false, large: true, critical: false, foreignCount: 0 },
    largeExactly: {
      count: 1, knownSum: 50_000.0, cluster: false, large: true, critical: false, foreignCount: 0 },
    largeOneKurusBelow: {
      count: 1, knownSum: 49_999.99, cluster: false, large: false, critical: false, foreignCount: 0 },
    criticalBySumExactly: {
      count: 4, knownSum: 250_000.0, cluster: true, large: true, critical: true, foreignCount: 0 },
    criticalBySumOneKurusBelow: {
      count: 4, knownSum: 249_999.99, cluster: true, large: true, critical: false, foreignCount: 0 },
    /**
     * 5. vakadaki dört tutar float `+=` ile toplanırsa ölçülen değer budur — kuruşun
     * yüz milyarda biri kadar EKSİK, ve tam da bu yüzden `>= 250.000` karşılaştırmasını
     * düşürüp günü kritik olmaktan çıkarır. Cevabın kendisi değişir, gösterilen hane değil.
     */
    criticalBySumIfFloatAccumulated: 249_999.99999999997,
    criticalBySumWouldBeCriticalIfFloat: false,
  },
  derivation:
    "Tüm kalemler TRY → foreignCount = 0 her vakada (TRY-dışı kalem eşiğe girmez, sayılır). " +
    "dayFlags kaynağı: large = open.some(amount >= t.large), " +
    "critical = open.some(amount >= t.critical) || knownSum >= t.critical. İki karşılaştırma " +
    "da '>=' — yani TAM EŞİK BAYRAK ÜRETİR, '>' değil. " +
    "1) 250.000,00 >= 250.000 → kritik VAR; aynı kalem 50.000 eşiğini de geçtiği için large da VAR. " +
    "2) 249.999,99 >= 250.000 yanlış → kritik YOK; 249.999,99 >= 50.000 doğru → large VAR. " +
    "3) 50.000,00 >= 50.000 → large VAR; 50.000 >= 250.000 yanlış → kritik YOK. " +
    "4) 49.999,99 >= 50.000 yanlış → large YOK, kritik YOK. " +
    "5) 173.885,27 + 21.752,99 = 195.638,26 ; + 47.810,90 = 243.449,16 ; + 6.550,84 = 250.000,00. " +
    "Hiçbir kalem tek başına 250.000 değil, ama gün toplamı tam eşikte → kritik VAR. " +
    "Kümelenme 4 >= 3 → VAR; 173.885,27 >= 50.000 → large VAR. " +
    "6) Son kalem 6.550,83 → toplam 249.999,99 < 250.000 → kritik YOK, diğer bayraklar aynı.",
} as const);

export const PAYMENT_RISK_LADDER = Object.freeze({
  id: "FIN-PAY-03",
  area: "payment",
  description: "Risk merdiveni: aynı kalemde birden çok gerekçe varsa en ağır olan kazanır.",
  input: [
    { reasons: ["critical_payment", "missing_amount"] },
    { reasons: ["overdue", "large_payment"] },
    { reasons: ["large_payment"] },
    { reasons: ["same_day_cluster"] },
    { reasons: ["overpaid"] },
    { reasons: ["missing_amount"] },
    { reasons: [] },
  ],
  expected: ["critical", "high", "medium", "medium", "medium", "low", "none"],
  derivation:
    "Merdiven sırası (calculation-rules.md): critical_payment → critical; overdue → high; " +
    "large_payment / same_day_cluster / negative_amount / overpaid → medium; " +
    "yalnız missing_amount → low; gerekçe yoksa → none. " +
    "Birinci satır hem critical_payment hem missing_amount taşır; en ağır olan critical döner.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   invoice · partial payment · overpayment
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const INVOICE_LINE_TOTALS = Object.freeze({
  id: "FIN-INV-01",
  area: "invoice",
  description:
    "Üç satırlı fatura: başlık toplamı satır toplamlarına kuruşu kuruşuna eşit olmalı, " +
    "üçüncü satır yarım-kuruş yuvarlamasını taşır.",
  input: {
    lines: [
      { quantity: 3, unitPrice: 1250.55, taxRate: 0.2 },
      { quantity: 7, unitPrice: 33.335, taxRate: 0.1 },
      { quantity: 1, unitPrice: 1.005, taxRate: 0.2 },
    ],
  },
  expected: {
    lines: [
      // 3 × 1.250,55 = 3.751,65 ; KDV = 3.751,65 × 0,20 = 750,33 ; brüt = 3.751,65 + 750,33
      { netAmount: 3751.65, taxAmount: 750.33, grossAmount: 4501.98 },
      // 7 × 33,335 = 233,345 → yarım-kuruş, half-up → 233,35 ;
      // KDV = 233,35 × 0,10 = 23,335 → half-up → 23,34 ; brüt = 233,35 + 23,34
      { netAmount: 233.35, taxAmount: 23.34, grossAmount: 256.69 },
      // 1 × 1,005 = 1,005 → half-up → 1,01 ; KDV = 1,01 × 0,20 = 0,202 → 0,20 ; brüt = 1,21
      { netAmount: 1.01, taxAmount: 0.2, grossAmount: 1.21 },
    ],
    header: { netAmount: 3986.01, taxAmount: 773.87, grossAmount: 4759.88 },
    /** Aynı brütün satır bazında toplanmış hâli — başlıkla birebir eşit olmak zorunda. */
    grossFromLines: 4759.88,
  },
  derivation:
    "net toplamı = 3.751,65 + 233,35 + 1,01 = 3.986,01. " +
    "KDV toplamı = 750,33 + 23,34 + 0,20 = 773,87. " +
    "brüt = net + KDV = 3.986,01 + 773,87 = 4.759,88. " +
    "Satır brütlerinin toplamı = 4.501,98 + 256,69 + 1,21 = 4.759,88 — aynı sayı. " +
    "Bu eşitlik migration 0044'ün `gross = net + tax` CHECK'inin uygulama tarafındaki karşılığıdır.",
} as const);

export const INVOICE_PARTIAL_PAYMENT = Object.freeze({
  id: "FIN-INV-02",
  area: "partial payment",
  description: "Kısmi tahsilat: 12.500,00 TL faturaya 4.750,25 TL ödeme.",
  input: { gross: 12_500.0, paid: 4_750.25, currentStatus: "open" },
  // 12.500,00 − 4.750,25 = 7.749,75 ; 0 < ödenen < brüt → 'partial'
  expected: { remaining: 7_749.75, status: "partial", isSettled: false },
  derivation:
    "12.500,00 − 4.750,25 = 7.749,75. Ödenen tutar 0'dan büyük ama brütten küçük " +
    "olduğu için önerilen durum 'partial'. Kalan 0 olmadığı için kalem kapatılamaz.",
} as const);

export const INVOICE_OVERPAYMENT = Object.freeze({
  id: "FIN-INV-03",
  area: "overpayment",
  description:
    "Aşırı ödeme KIRPILMAZ: 8.450,75 TL faturaya 9.000,00 TL tahsilat girildiğinde kalan " +
    "negatif kalır ve fatura 'paid' okunur.",
  input: { gross: 8_450.75, paid: 9_000.0, currentStatus: "open" },
  // 8.450,75 − 9.000,00 = −549,25 → NEGATİF kalır, sıfıra kırpılmaz
  expected: { remaining: -549.25, status: "paid", overpayment: 549.25 },
  derivation:
    "8.450,75 − 9.000,00 = −549,25. Migration 0044 paid_amount'a üst sınır koymaz (0047 bunu " +
    "açıkça yazar), çünkü fazla tahsilat gerçekten olmuş bir para hareketidir. Sıfıra kırpmak " +
    "ekranda gerçekten hareket etmiş 549,25 TL'yi yok eder. Ödenen ≥ brüt olduğu için durum " +
    "'partial' değil 'paid'. Fazla = 9.000,00 − 8.450,75 = 549,25.",
} as const);

export const INVOICE_TERMINAL_INERT = Object.freeze({
  id: "FIN-INV-04",
  area: "invoice",
  description:
    "Terminal durumlar ödeme sinyaliyle yeniden sınıflanmaz: geç gelen bir tahsilat satırı " +
    "kapatılmış veya iptal edilmiş defteri sessizce açamaz.",
  input: {
    cases: [
      { status: "closed", gross: 100.0, paid: 50.0 },
      { status: "cancelled", gross: 100.0, paid: 50.0 },
      { status: "draft", gross: 100.0, paid: 50.0 },
    ],
    transitions: [
      { from: "closed", to: "open", allowed: true },
      { from: "closed", to: "partial", allowed: false },
      { from: "cancelled", to: "open", allowed: false },
      { from: "paid", to: "partial", allowed: true },
    ],
  },
  expected: {
    suggestions: [null, null, null],
    terminal: { cancelled: true, closed: false, paid: false },
  },
  derivation:
    "suggestStatusFromPayment draft/cancelled/closed için null döner — bu üç durumda ödeme " +
    "tutarının söyleyecek sözü yoktur. 'cancelled' terminaldir (0044'te ondan çıkan geçiş " +
    "yoktur); 'closed' terminal DEĞİLDİR çünkü closed→open geçişi tanımlıdır.",
} as const);

export const INVOICE_DUPLICATE = Object.freeze({
  id: "FIN-INV-05",
  area: "invoice",
  description:
    "Çifte kayıt tespiti: aynı fatura numarası farklı yazımlarla girildiğinde tek sinyal " +
    "yeter; farklı numara + aynı tutar için tarih penceresi gerekir.",
  input: {
    sameNumber: {
      a: { invoiceNo: "FTR-2026-0091", grossAmount: 45_000.0, issueDate: "2026-07-14" },
      b: { invoiceNo: "ftr 2026 0091", grossAmount: 45_000.0, issueDate: "2026-07-14" },
    },
    nearMatch: {
      a: { invoiceNo: "FTR-2026-0091", grossAmount: 45_000.0, issueDate: "2026-07-14" },
      b: { invoiceNo: "FTR-2026-0102", grossAmount: 45_000.0, issueDate: "2026-07-17" },
    },
    unrelated: {
      a: { invoiceNo: "FTR-2026-0091", grossAmount: 45_000.0, issueDate: "2026-07-14" },
      b: { invoiceNo: "FTR-2026-0102", grossAmount: 12_300.0, issueDate: "2026-07-31" },
    },
  },
  expected: {
    // 0,8 (same_number) + 0,6 (same_amount_and_date, gap = 0) = 1,4 → min(1, 1,4) = 1
    sameNumber: { isSuspect: true, signals: ["same_number", "same_amount_and_date"], confidence: 1 },
    // numara farklı → 0 ; tutar aynı ve gap = 3 gün ≤ 7 → +0,4
    nearMatch: { isSuspect: true, signals: ["near_match"], confidence: 0.4 },
    // hiçbir sinyal yok
    unrelated: { isSuspect: false, signals: [], confidence: 0 },
  },
  derivation:
    "normalizeInvoiceNo ayırıcıları ve büyük/küçük harfi siler: 'FTR-2026-0091' ve " +
    "'ftr 2026 0091' → ikisi de 'ftr20260091'. Aynı numara 0,8 puan; tutar aynı ve tarih farkı " +
    "0 gün ise ek 0,6 → 1,4, tavan 1. İkinci vakada numara farklı, tutar aynı, tarih farkı " +
    "17−14 = 3 gün ≤ 7 → yalnız 'near_match' ve 0,4. Üçüncüde ne numara ne tutar tutuyor → 0.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   overdue — yaşlandırma sınırları
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const OVERDUE_AGEING_BOUNDARIES = Object.freeze({
  id: "FIN-AGE-01",
  area: "overdue",
  description:
    "Faz 21 raporlama yaşlandırması (1-30 / 31-60 / 61-90 / 90+) — her kova sınırının iki " +
    "yanı da elle sayılarak yazıldı. Bugün 2026-08-25.",
  input: {
    todayISO: TODAY,
    dueDates: [
      null,
      "2026-09-01",
      "2026-08-25",
      "2026-08-24",
      "2026-07-26",
      "2026-07-25",
      "2026-06-26",
      "2026-06-25",
      "2026-05-27",
      "2026-05-26",
    ],
  },
  expected: [
    "tarihsiz", //             vade yok
    "vadesi gelmemiş", //      −7 gün
    "vadesi gelmemiş", //        0 gün — sınır: 0 gecikme henüz gecikme değildir
    "1-30 gün", //               1 gün
    "1-30 gün", //              30 gün — üst sınır dahil
    "31-60 gün", //             31 gün
    "31-60 gün", //             60 gün
    "61-90 gün", //             61 gün
    "61-90 gün", //             90 gün
    "90+ gün", //               91 gün
  ],
  derivation:
    "Gecikme günü = bugün − vade. " +
    "2026-07-26 → Temmuz'dan 5 gün (26→31) + Ağustos 25 = 30. " +
    "2026-07-25 → 6 + 25 = 31. " +
    "2026-06-26 → Haziran 4 (26→30) + Temmuz 31 + Ağustos 25 = 60. " +
    "2026-06-25 → 5 + 31 + 25 = 61. " +
    "2026-05-27 → Mayıs 4 (27→31) + Haziran 30 + Temmuz 31 + Ağustos 25 = 90. " +
    "2026-05-26 → 5 + 30 + 31 + 25 = 91.",
} as const);

export const OVERDUE_COLLECTION_BOUNDARIES = Object.freeze({
  id: "FIN-AGE-02",
  area: "overdue",
  description:
    "Faz 22 tahsilat aciliyeti yaşlandırması (1-7 / 8-30 / 31-60 / 60+) — Faz 21'den " +
    "BİLEREK farklı; ilk ayı böler çünkü üç gün ile üç hafta gecikme farklı bir sabah demektir.",
  input: {
    todayISO: TODAY,
    dueDates: [
      null,
      "2026-08-25",
      "2026-08-18",
      "2026-08-17",
      "2026-07-26",
      "2026-07-25",
      "2026-06-26",
      "2026-06-25",
    ],
  },
  expected: [
    "tarihsiz",
    "vadesi gelmemiş", //  0 gün
    "1-7 gün", //          7 gün — üst sınır dahil
    "8-30 gün", //         8 gün
    "8-30 gün", //        30 gün
    "31-60 gün", //       31 gün
    "31-60 gün", //       60 gün
    "60+ gün", //         61 gün
  ],
  derivation:
    "2026-08-18 → 25 − 18 = 7. 2026-08-17 → 8. " +
    "2026-07-26 → 5 + 25 = 30. 2026-07-25 → 6 + 25 = 31. " +
    "2026-06-26 → 4 + 31 + 25 = 60. 2026-06-25 → 5 + 31 + 25 = 61.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   check — çek vadeleri ve işaretli tutar semantiği
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const CHECK_SIGNED_DIRECTION = Object.freeze({
  id: "FIN-CHK-01",
  area: "check",
  description:
    "İşaretli çek tutarı yön + mutlak değere ayrışır; açık sıfır ile bilinmeyen ayrı kalır.",
  input: [-125_000.5, 340_000.0, 0, null],
  expected: [
    { direction: "outflow", amount: 125_000.5 },
    { direction: "inflow", amount: 340_000.0 },
    // açık sıfır: tutar 0 olarak KORUNUR ama yön taşımaz
    { direction: "unknown", amount: 0 },
    // bilinmeyen: tutar null KALIR, 0'a çevrilmez
    { direction: "unknown", amount: null },
  ],
  derivation:
    "Kural (calculation-rules §Checks): işaret < 0 → outflow, işaret > 0 → inflow, " +
    "tutar = |işaret|. Sıfır açık bir ölçümdür (kapatılmış çek) ve 0 olarak korunur; " +
    "null bilinmeyendir ve null kalır. İkisinin aynı kovaya düşmesi CLAUDE.md'nin " +
    "'null bilinmeyendir, sıfır değildir' kuralının ihlali olurdu.",
} as const);

export const CHECK_MATURITY_GROUPING = Object.freeze({
  id: "FIN-CHK-02",
  area: "check",
  description:
    "Aylık çek vade takvimi: giriş ve çıkış ayrı toplanır, tutarı bilinmeyen çek sayılır " +
    "ama toplanmaz.",
  input: {
    items: [
      { id: "CHK-1", dueDate: "2026-09-03", amount: 125_000.5, direction: "outflow" },
      { id: "CHK-2", dueDate: "2026-09-28", amount: 74_999.5, direction: "outflow" },
      { id: "CHK-3", dueDate: "2026-09-15", amount: 200_000.0, direction: "inflow" },
      { id: "CHK-4", dueDate: "2026-09-20", amount: null, direction: "outflow" },
      { id: "CHK-5", dueDate: "2026-10-05", amount: 50_000.0, direction: "outflow" },
    ],
  },
  expected: [
    {
      key: "2026-09",
      from: "2026-09-01",
      to: "2026-09-30",
      count: 4,
      knownOutflow: 200_000.0,
      knownInflow: 200_000.0,
      missingCount: 1,
      unknownDirectionCount: 0,
    },
    {
      key: "2026-10",
      from: "2026-10-01",
      to: "2026-10-31",
      count: 1,
      knownOutflow: 50_000.0,
      knownInflow: 0,
      missingCount: 0,
      unknownDirectionCount: 0,
    },
  ],
  derivation:
    "Eylül çıkışı = 125.000,50 + 74.999,50 = 200.000,00. Eylül girişi = 200.000,00. " +
    "CHK-4'ün tutarı bilinmiyor: missingCount = 1 olur, çıkış toplamına 0 olarak EKLENMEZ. " +
    "count = 4 (bilinmeyen dahil sayılır — sayı gizlenmez, yalnız tutarı bilinmez). " +
    "Kova sonu = ayın son günü: Eylül 30, Ekim 31. " +
    "Eylül net etkisi 200.000 giriş − 200.000 çıkış = 0 gibi görünse de missingCount = 1 " +
    "olduğu için bu ay 'nötr' diye okunamaz — paketin bu vakada ispatladığı şey budur.",
} as const);

export const CHECK_MATURITY_WINDOWS = Object.freeze({
  id: "FIN-CHK-03",
  area: "check",
  description:
    "İleriye dönük 7/14/30 günlük pencereler yarı-açıktır: [bugün, bugün+gün). Vadesi geçmiş " +
    "çek pencereye girmez, sınır günündeki çek bir sonraki pencereye düşer — çifte sayım olmaz.",
  input: {
    todayISO: TODAY,
    items: [
      { id: "W-0", dueDate: "2026-08-20", amount: 10_000.0, direction: "outflow" }, // geçmiş
      { id: "W-1", dueDate: "2026-08-25", amount: 40_000.0, direction: "outflow" }, // bugün
      { id: "W-2", dueDate: "2026-08-31", amount: 25_000.0, direction: "inflow" },
      { id: "W-3", dueDate: "2026-09-01", amount: 60_000.0, direction: "outflow" }, // 7. gün
      { id: "W-4", dueDate: "2026-09-08", amount: 15_000.0, direction: "outflow" }, // 14. gün
      { id: "W-5", dueDate: "2026-09-20", amount: null, direction: "outflow" },
    ],
  },
  expected: [
    // 7 gün: [2026-08-25, 2026-09-01) → W-1, W-2. W-3 tam sınırda, DIŞARIDA.
    {
      days: 7,
      from: TODAY,
      toExclusive: "2026-09-01",
      count: 2,
      knownOutflow: 40_000.0,
      knownInflow: 25_000.0,
      missingCount: 0,
    },
    // 14 gün: [2026-08-25, 2026-09-08) → W-1, W-2, W-3. W-4 tam sınırda, DIŞARIDA.
    {
      days: 14,
      from: TODAY,
      toExclusive: "2026-09-08",
      count: 3,
      knownOutflow: 100_000.0,
      knownInflow: 25_000.0,
      missingCount: 0,
    },
    // 30 gün: [2026-08-25, 2026-09-24) → W-1..W-5. W-0 geçmişte, hiçbir pencerede yok.
    {
      days: 30,
      from: TODAY,
      toExclusive: "2026-09-24",
      count: 5,
      knownOutflow: 115_000.0,
      knownInflow: 25_000.0,
      missingCount: 1,
    },
  ],
  derivation:
    "2026-08-25 + 7 = 2026-09-01 (Ağustos'ta 6 gün kalıyor, +1). " +
    "+14 = 2026-09-08. +30 = 2026-09-24 (6 + 24). " +
    "14 günlük çıkış = 40.000 + 60.000 = 100.000. " +
    "30 günlük çıkış = 40.000 + 60.000 + 15.000 = 115.000 (W-5 null → toplama girmez). " +
    "W-0 (2026-08-20) hiçbir pencerede yoktur; gecikmiş kalem ileri bakan pencerenin üyesi değildir.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   loan — taksit takvimi ve kredi mutabakatı
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const LOAN_SCHEDULE = Object.freeze({
  id: "FIN-LOAN-01",
  area: "loan",
  description:
    "İlk taksiti 31 Ocak olan 4 taksitli kredi: kısa aylarda vade ayın son gününe çekilir, " +
    "ama SONRAKİ taksit yine ayın 31'ini hedefler — çekme kalıcı kayma yaratmaz.",
  input: { firstPaymentISO: "2026-01-31", count: 4 },
  expected: [
    { no: 1, dueDate: "2026-01-31", shortMonthAdjusted: false },
    { no: 2, dueDate: "2026-02-28", shortMonthAdjusted: true },
    { no: 3, dueDate: "2026-03-31", shortMonthAdjusted: false },
    { no: 4, dueDate: "2026-04-30", shortMonthAdjusted: true },
  ],
  derivation:
    "Gün = 31, ay başı = 2026-01-01 ve her taksit için +1 ay. " +
    "Ocak 31 → 31. Şubat 28 → min(31,28) = 28 (çekildi). Mart 31 → 31 (çekme yok — " +
    "Şubat'ın 28'i taşınsaydı 3. taksit 28'e sabitlenirdi, bu hata OLMUYOR). Nisan 30 → 30.",
} as const);

export const LOAN_RECONCILIATION_OK = Object.freeze({
  id: "FIN-LOAN-02",
  area: "loan",
  description: "Tutarlı kredi: Σtaksit = toplam ödeme ve toplam − anapara = finansman maliyeti.",
  input: {
    installmentSum: 1_250_000.0,
    totalPayment: 1_250_000.0,
    principal: 1_000_000.0,
    financeCost: 250_000.0,
  },
  expected: { ok: true, issueCount: 0 },
  derivation:
    "Σtaksit 1.250.000,00 − toplam ödeme 1.250.000,00 = 0 ≤ 1 TL tolerans. " +
    "1.250.000,00 − 1.000.000,00 − 250.000,00 = 0 ≤ 1 TL. İki kontrol de temiz.",
} as const);

export const LOAN_RECONCILIATION_MISMATCH = Object.freeze({
  id: "FIN-LOAN-03",
  area: "loan",
  description:
    "5 TL'lik taksit farkı BAYRAKLANIR, düzeltilmez — kaynak değerler asla değiştirilmez.",
  input: {
    installmentSum: 1_249_995.0,
    totalPayment: 1_250_000.0,
    principal: 1_000_000.0,
    financeCost: 250_000.0,
  },
  expected: {
    ok: false,
    issueCount: 1,
    code: "installment_sum_mismatch",
    diff: -5,
    message: "Σtaksit 1249995.00 ≠ toplam ödeme 1250000.00 (fark -5.00)",
  },
  derivation:
    "1.249.995,00 − 1.250.000,00 = −5,00 ; |−5| > 1 TL tolerans → bayrak. " +
    "İkinci kontrol (1.250.000 − 1.000.000 − 250.000 = 0) temiz olduğu için tek sorun üretilir. " +
    "Fonksiyon değerleri DÜZELTMEZ: diff raporlanır, girdi olduğu gibi kalır.",
} as const);

export const LOAN_NULL_NOT_ZERO = Object.freeze({
  id: "FIN-LOAN-04",
  area: "loan",
  description:
    "Anapara kaynakta yoksa 0 sayılmaz: eksik alan bildirilir, hayalî bir finansman " +
    "maliyeti sapması ÜRETİLMEZ.",
  input: {
    installmentSum: 1_250_000.0,
    totalPayment: 1_250_000.0,
    principal: null,
    financeCost: 250_000.0,
  },
  expected: {
    ok: false,
    issueCount: 1,
    code: "missing_totals",
    message: "Kaynakta eksik mutabakat alanları: principal",
    /** Anapara 0 sayılsaydı ortaya çıkacak sahte sapma — üretilmemeli. */
    phantomDiffIfNullWereZero: 1_000_000.0,
  },
  derivation:
    "Anapara null olduğu için yalnız 'missing_totals' üretilir. " +
    "Σtaksit = toplam ödeme olduğundan ilk kontrol temiz. " +
    "Anapara sessizce 0 sayılsaydı: 1.250.000 − 0 − 250.000 = 1.000.000 TL'lik bir " +
    "'finance_cost_mismatch' uydurulurdu. Böyle bir bayrak ÇIKMAMALI — bu vakanın kanıtı budur.",
} as const);

export const LOAN_TOLERANCE_BOUNDARY = Object.freeze({
  id: "FIN-LOAN-05",
  area: "loan",
  description:
    "Kredi mutabakat toleransının TAM SINIRI. Karşılaştırma '|fark| > 1' olduğu için tam " +
    "1,00 TL bayraklanmaz, 1,01 TL bayraklanır. Sınırın iki yanı da hem Σtaksit hem " +
    "finansman maliyeti kontrolü için çivilendi ki tolerans sessizce genişlemesin.",
  input: {
    installmentExactlyOneLira: {
      installmentSum: 1_250_001.0,
      totalPayment: 1_250_000.0,
      principal: 1_000_000.0,
      financeCost: 250_000.0,
    },
    installmentOneKurusOver: {
      installmentSum: 1_250_001.01,
      totalPayment: 1_250_000.0,
      principal: 1_000_000.0,
      financeCost: 250_000.0,
    },
    financeCostExactlyOneLira: {
      installmentSum: 1_250_000.0,
      totalPayment: 1_250_000.0,
      principal: 1_000_000.0,
      financeCost: 249_999.0,
    },
    financeCostOneKurusOver: {
      installmentSum: 1_250_000.0,
      totalPayment: 1_250_000.0,
      principal: 1_000_000.0,
      financeCost: 249_998.99,
    },
  },
  expected: {
    installmentExactlyOneLira: { ok: true, issueCount: 0 },
    installmentOneKurusOver: {
      ok: false,
      issueCount: 1,
      code: "installment_sum_mismatch",
      message: "Σtaksit 1250001.01 ≠ toplam ödeme 1250000.00 (fark 1.01)",
      diffFormatted: "1.01",
      /**
       * Ham fark bir float artefaktıdır: 1.250.001,01 − 1.250.000,00 IEEE-754'te tam 1,01
       * vermez. Sapma kuruşun on milyarda biri mertebesindedir, tolerans ise 1 TL — yani
       * karar bundan ETKİLENMEZ, ama gizlemek yerine yazıyoruz.
       */
      diffFloatArtifact: 1.0100000000093132,
    },
    financeCostExactlyOneLira: { ok: true, issueCount: 0 },
    financeCostOneKurusOver: {
      ok: false,
      issueCount: 1,
      code: "finance_cost_mismatch",
      message: "toplam − anapara ≠ fark (sapma 1.01)",
      diffFormatted: "1.01",
      diffFloatArtifact: 1.0100000000093132,
    },
  },
  derivation:
    "reconcileLoan kaynağı: her iki kontrol de `if (Math.abs(diff) > tol)` — tol = 1 TL. " +
    "'>' olduğu için TAM 1,00 sınırda BAYRAKLANMAZ. " +
    "1) Σtaksit 1.250.001,00 − 1.250.000,00 = +1,00 ; |1| > 1 yanlış → sorun yok. " +
    "İkinci kontrol 1.250.000 − 1.000.000 − 250.000 = 0 → temiz. Toplam 0 sorun. " +
    "2) Σtaksit 1.250.001,01 − 1.250.000,00 = +1,01 ; |1,01| > 1 doğru → tek bayrak. " +
    "3) toplam − anapara − fark = 1.250.000 − 1.000.000 − 249.999 = +1,00 → sınırda, bayrak yok " +
    "(Σtaksit kontrolü de temiz: 1.250.000 = 1.250.000). " +
    "4) 1.250.000 − 1.000.000 − 249.998,99 = +1,01 > 1 → tek bayrak, finance_cost_mismatch. " +
    "Mesajlardaki tutarlar kaynak koddaki toFixed(2) biçimidir; fonksiyon hiçbir değeri " +
    "DÜZELTMEZ, yalnız bildirir.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   receivable — yaşlandırma özeti, DSO, cari hesap
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const RECEIVABLE_AGEING_SUMMARY = Object.freeze({
  id: "FIN-REC-01",
  area: "receivable",
  description:
    "Açık alacak yaşlandırma özeti: boş kova bile satır olarak görünür, tarihsiz kalem " +
    "gizlenmez, toplam elle sayılabilir.",
  input: {
    todayISO: TODAY,
    rows: [
      { dueDate: "2026-09-01", openAmount: 10_000.0 },
      { dueDate: "2026-08-20", openAmount: 2_500.55 },
      { dueDate: "2026-08-01", openAmount: 1_250.45 },
      { dueDate: "2026-07-01", openAmount: 900.0 },
      { dueDate: "2026-05-01", openAmount: 100.1 },
      { dueDate: null, openAmount: 77.77 },
    ],
  },
  expected: {
    // Kova sırası sabittir: vadesi gelmemiş → 1-7 → 8-30 → 31-60 → 60+ → tarihsiz
    buckets: [
      { bucket: "vadesi gelmemiş", count: 1, amount: 10_000.0 },
      { bucket: "1-7 gün", count: 1, amount: 2_500.55 },
      { bucket: "8-30 gün", count: 1, amount: 1_250.45 },
      { bucket: "31-60 gün", count: 1, amount: 900.0 },
      { bucket: "60+ gün", count: 1, amount: 100.1 },
      { bucket: "tarihsiz", count: 1, amount: 77.77 },
    ],
    total: 14_828.87,
  },
  derivation:
    "Gecikmeler: 2026-09-01 → −7 (vadesi gelmemiş); 2026-08-20 → 5 (1-7); " +
    "2026-08-01 → 24 (8-30); 2026-07-01 → 30 + 25 = 55 (31-60); " +
    "2026-05-01 → 30 + 30 + 31 + 25 = 116 (60+); tarih yok → tarihsiz. " +
    "Toplam = 10.000,00 + 2.500,55 + 1.250,45 + 900,00 + 100,10 + 77,77 = 14.828,87.",
} as const);

export const RECEIVABLE_DSO = Object.freeze({
  id: "FIN-REC-02",
  area: "receivable",
  description:
    "DSO: satış yoksa 0 değil NULL. Sıfır satışlı bir çeyreği 'müşteriler anında ödüyor' " +
    "diye okumak, en kötü çeyreğin en gurur verici yorumu olurdu.",
  input: {
    normal: { openReceivables: 2_450_000.0, salesInPeriod: 9_000_000.0, periodDays: 90 },
    noSales: { openReceivables: 2_450_000.0, salesInPeriod: 0, periodDays: 90 },
    noPeriod: { openReceivables: 2_450_000.0, salesInPeriod: 9_000_000.0, periodDays: 0 },
  },
  expected: { normal: 24.5, noSales: null, noPeriod: null },
  derivation:
    "DSO = (açık alacak / dönem satışı) × dönem günü = " +
    "(2.450.000 × 90) / 9.000.000 = 220.500.000 / 9.000.000 = 24,5 gün. " +
    "Payda 0 ise oran tanımsızdır → null. Dönem günü 0 ise de tanımsızdır → null.",
} as const);

export const RECEIVABLE_RUNNING_BALANCE = Object.freeze({
  id: "FIN-REC-03",
  area: "receivable",
  description:
    "Cari hesap yürüyen bakiyesi: girdi karışık sırada verilse de tarihe göre sıralanır ve " +
    "her adım bir öncekinin üstüne biner.",
  input: {
    movements: [
      { movementDate: "2026-03-10", debitAmount: 0, creditAmount: 4_000.25 },
      { movementDate: "2026-01-15", debitAmount: 12_500.75, creditAmount: 0 },
      { movementDate: "2026-02-20", debitAmount: 3_000.0, creditAmount: 1_500.5 },
    ],
  },
  expected: {
    dates: ["2026-01-15", "2026-02-20", "2026-03-10"],
    balances: [12_500.75, 14_000.25, 10_000.0],
  },
  derivation:
    "0 + 12.500,75 − 0 = 12.500,75. " +
    "12.500,75 + 3.000,00 − 1.500,50 = 14.000,25. " +
    "14.000,25 + 0 − 4.000,25 = 10.000,00.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   allocation — tahsilatın faturalara dağıtımı
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const ALLOCATION_FIFO_EXACT = Object.freeze({
  id: "FIN-ALL-01",
  area: "allocation",
  description:
    "100.000,00 TL tahsilat en eski vadeden başlayarak dağıtılır; kapanmış fatura aday " +
    "değildir, vadesiz fatura en sona kalır.",
  input: {
    amount: 100_000.0,
    invoices: [
      { invoiceId: "INV-C", openAmount: 60_000.0, dueDate: "2026-08-01", issueDate: "2026-07-20" },
      { invoiceId: "INV-A", openAmount: 45_000.0, dueDate: "2026-06-30", issueDate: "2026-06-01" },
      { invoiceId: "INV-E", openAmount: 5_000.0, dueDate: null, issueDate: "2026-04-01" },
      { invoiceId: "INV-B", openAmount: 30_000.5, dueDate: "2026-07-15", issueDate: "2026-07-01" },
      { invoiceId: "INV-D", openAmount: 0, dueDate: "2026-05-01", issueDate: "2026-04-15" },
    ],
  },
  expected: {
    lines: [
      { invoiceId: "INV-A", amount: 45_000.0 },
      { invoiceId: "INV-B", amount: 30_000.5 },
      { invoiceId: "INV-C", amount: 24_999.5 },
    ],
    allocated: 100_000.0,
    unallocated: 0,
  },
  derivation:
    "Sıra vade tarihine göre: A (06-30), B (07-15), C (08-01), sonra vadesiz E. " +
    "D'nin açık tutarı 0 olduğu için aday listesinden düşer. " +
    "100.000,00 − 45.000,00 = 55.000,00 ; 55.000,00 − 30.000,50 = 24.999,50 ; " +
    "C'nin açığı 60.000,00 > 24.999,50 olduğu için kalanın tamamı C'ye yazılır ve biter. " +
    "E'ye sıra gelmez. Dağıtılan = 45.000,00 + 30.000,50 + 24.999,50 = 100.000,00, artan 0.",
} as const);

export const ALLOCATION_LEFTOVER = Object.freeze({
  id: "FIN-ALL-02",
  area: "allocation",
  description:
    "Faturalardan büyük tahsilat: artan para son faturaya ZORLANMAZ, ayrı kalem olarak " +
    "operatöre gösterilir.",
  input: {
    amount: 100_000.0,
    invoices: [
      { invoiceId: "INV-X", openAmount: 40_000.0, dueDate: "2026-06-01", issueDate: "2026-05-01" },
      { invoiceId: "INV-Y", openAmount: 22_500.25, dueDate: "2026-06-15", issueDate: "2026-06-01" },
    ],
  },
  expected: {
    lines: [
      { invoiceId: "INV-X", amount: 40_000.0 },
      { invoiceId: "INV-Y", amount: 22_500.25 },
    ],
    allocated: 62_500.25,
    unallocated: 37_499.75,
  },
  derivation:
    "40.000,00 + 22.500,25 = 62.500,25 dağıtılabilir. " +
    "100.000,00 − 62.500,25 = 37.499,75 artar. " +
    "Artan son faturaya eklenseydi 0048'in tavan trigger'ı reddederdi; burada operatör " +
    "'37.499,75 TL açıkta' cümlesini görür, çözemeyeceği bir veritabanı hatasını değil.",
} as const);

export const ALLOCATION_CEILING = Object.freeze({
  id: "FIN-ALL-03",
  area: "allocation",
  description:
    "Dağıtım tavanı: fatura brütüne kadar serbest, bir kuruş fazlası reddedilir. Aynı " +
    "tahsilat aynı faturaya iki kez yazılamaz.",
  input: {
    exactlyAtCeiling: { gross: 10_000.0, alreadyAllocated: 9_500.0, newAmount: 500.0 },
    oneKurusOver: { gross: 10_000.0, alreadyAllocated: 9_500.0, newAmount: 500.01 },
    doubleApply: { gross: 100_000.0, alreadyAllocated: 100_000.0, newAmount: 100_000.0 },
    openAfterFullSettlement: { gross: 100_000.0, allocated: 100_000.0 },
    openAfterOverAllocation: { gross: 100_000.0, allocated: 120_000.0 },
  },
  expected: {
    exactlyAtCeiling: false,
    oneKurusOver: true,
    doubleApply: true,
    openAfterFullSettlement: 0,
    openAfterOverAllocation: 0,
  },
  derivation:
    "9.500,00 + 500,00 = 10.000,00 ; 10.000,00 > 10.000,00 YANLIŞ → tavana tam oturmak serbest. " +
    "9.500,00 + 500,01 = 10.000,01 > 10.000,00 → reddedilir. " +
    "Kapanmış faturaya aynı 100.000,00'ın ikinci kez yazılması 200.000,00 > 100.000,00 → " +
    "reddedilir; fatura/ödeme/banka arasında çifte sayımı engelleyen kural budur. " +
    "openAmount taban 0'dır: 100.000 − 120.000 = −20.000 → 0 (eksi headroom hazineye sızmaz).",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   FX — yeniden değerleme, stres bantları, net pozisyon
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const FX_LONG_POSITION = Object.freeze({
  id: "FIN-FX-01",
  area: "FX",
  description: "250.000 USD varlık pozisyonu: giriş 32,1500 → güncel 34,7500.",
  input: { currency: "USD", amount: 250_000, entryRate: 32.15, currentRate: 34.75 },
  expected: {
    amountFx: 250_000,
    bookValueTry: 8_037_500.0,
    currentValueTry: 8_687_500.0,
    unrealizedGainLoss: 650_000.0,
    worstCase20Delta: -1_737_500.0,
  },
  derivation:
    "Defter değeri = 250.000 × 32,15 = 8.037.500,00. " +
    "Güncel değer = 250.000 × 34,75 = 8.687.500,00. " +
    "Gerçekleşmemiş kâr = 250.000 × (34,75 − 32,15) = 250.000 × 2,60 = 650.000,00 ; " +
    "aynı sonuca 8.687.500 − 8.037.500 farkından da varılır. İki yol ONDALIK aritmetikte " +
    "birbirinin aynıdır — IEEE-754'te DEĞİLDİR: çarpım yolu float ile 650000.0000000003, " +
    "çıkarma yolu 650000 verir (ölçüldü; 34.75 − 32.15 float'ta 2.6000000000000014'tür). " +
    "Beklenen literal 650.000,00'dır, yani ondalık yolun verdiği değerdir. " +
    "Uzun pozisyon kurun DÜŞMESİNDEN zarar eder → ters yön −%20 → " +
    "8.687.500 × (−0,20) = −1.737.500,00.",
} as const);

export const FX_SHORT_POSITION = Object.freeze({
  id: "FIN-FX-02",
  area: "FX",
  description:
    "180.000 EUR borç pozisyonu: kur YÜKSELDİĞİNDE zarar eder. Tek yönsüz '±%20 etki' " +
    "rakamı, en büyük borcu en büyük yastık gibi gösterirdi.",
  input: { currency: "EUR", amount: -180_000, entryRate: 37.4, currentRate: 39.9 },
  expected: {
    amountFx: -180_000,
    bookValueTry: -6_732_000.0,
    currentValueTry: -7_182_000.0,
    unrealizedGainLoss: -450_000.0,
    worstCase20Delta: -1_436_400.0,
  },
  derivation:
    "Defter = −180.000 × 37,40 = −6.732.000,00. Güncel = −180.000 × 39,90 = −7.182.000,00. " +
    "Zarar = −180.000 × (39,90 − 37,40) = −180.000 × 2,50 = −450.000,00. " +
    "Kısa pozisyon için ters yön +%20 → −180.000 × 39,90 × 0,20 = −7.182.000 × 0,20 = −1.436.400,00. " +
    "Sonucun NEGATİF olması doğrudur: bu bir zarardır.",
} as const);

export const FX_UNKNOWN_RATE = Object.freeze({
  id: "FIN-FX-03",
  area: "FX",
  description:
    "Güncel kur kaydedilmemişse türetilen her rakam NULL'dır, 0 değil. 0 'kâr yok' iddiasıdır; " +
    "NULL 'bilemeyiz' der ve doğru olan budur.",
  input: { currency: "GBP", amount: 75_000, entryRate: 42.5, currentRate: null },
  expected: {
    amountFx: 75_000,
    bookValueTry: 3_187_500.0,
    currentValueTry: null,
    unrealizedGainLoss: null,
    worstCase20Delta: null,
  },
  derivation:
    "Defter değeri hâlâ hesaplanabilir: 75.000 × 42,50 = 3.187.500,00. " +
    "Güncel kur yok → güncel değer, kâr/zarar ve stres deltası hesaplanamaz → hepsi null.",
} as const);

export const FX_STRESS_TABLE = Object.freeze({
  id: "FIN-FX-04",
  area: "FX",
  description:
    "%5/%10/%20 stres bantları — model değil, aynı pozisyonun kaydırılmış kurla değeri. " +
    "Hesap makinesiyle yeniden üretilebilir.",
  input: { amount: 250_000, currentRate: 34.75, bands: [5, 10, 20] },
  expected: [
    { band: 5, up: 9_121_875.0, down: 8_253_125.0 },
    { band: 10, up: 9_556_250.0, down: 7_818_750.0 },
    { band: 20, up: 10_425_000.0, down: 6_950_000.0 },
  ],
  derivation:
    "Taban değer = 250.000 × 34,75 = 8.687.500,00. " +
    "×1,05 = 9.121.875,00 ; ×0,95 = 8.253.125,00. " +
    "×1,10 = 9.556.250,00 ; ×0,90 = 7.818.750,00. " +
    "×1,20 = 10.425.000,00 ; ×0,80 = 6.950.000,00.",
} as const);

export const FX_NET_EXPOSURE = Object.freeze({
  id: "FIN-FX-05",
  area: "FX",
  description:
    "Tek para birimindeki net pozisyon: bilinmeyenler atlanır, açık sıfır toplama girer ve " +
    "sonucu değiştirmez.",
  input: ["250000.00", null, "-180000.00", "", "0.00"],
  expected: 70_000.0,
  derivation: "250.000,00 − 180.000,00 = 70.000,00. null ve boş metin atlanır, 0 sayılmaz.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   budget — bütçe/fiili sapması
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const BUDGET_VARIANCE = Object.freeze({
  id: "FIN-BUD-01",
  area: "budget",
  description:
    "Sapma yönü hükmü belirler: gideri aşmak ile geliri aşmak zıt sonuçlardır. Tek yönsüz " +
    "'sapma' rakamı iyi bir ayı kırmızıya boyardı.",
  input: [
    { direction: "expense", budget: 500_000.0, actual: 512_345.67 },
    { direction: "income", budget: 800_000.0, actual: 720_000.0 },
    { direction: "income", budget: 800_000.0, actual: 800_000.0 },
    { direction: "expense", budget: 500_000.0, actual: 487_654.33 },
  ],
  expected: [
    // 512.345,67 − 500.000,00 = 12.345,67 ; 12.345,67 / 500.000 = 0,02469134
    { varianceAmount: 12_345.67, varianceRatio: 0.02469134, verdict: "over_budget" },
    // 720.000,00 − 800.000,00 = −80.000,00 ; −80.000 / 800.000 = −0,1
    { varianceAmount: -80_000.0, varianceRatio: -0.1, verdict: "under_target" },
    // fiili = bütçe → sapma 0, oran 0, hedefe eşit sayılır
    { varianceAmount: 0, varianceRatio: 0, verdict: "on_or_above_target" },
    // 487.654,33 − 500.000,00 = −12.345,67 ; −12.345,67 / 500.000 = −0,02469134
    { varianceAmount: -12_345.67, varianceRatio: -0.02469134, verdict: "within_budget" },
  ],
  derivation:
    "12.345,67 / 500.000 = 0,02469134 (500.000 × 0,02469134 = 12.345,67 — tam bölünüyor). " +
    "80.000 / 800.000 = 0,1. " +
    "Gider yönünde fiili > bütçe ise 'over_budget', değilse 'within_budget'. " +
    "Gelir yönünde fiili < bütçe ise 'under_target', değilse 'on_or_above_target' — " +
    "eşitlik hedefin ALTINDA sayılmaz.",
} as const);

export const BUDGET_NOT_MEASURED = Object.freeze({
  id: "FIN-BUD-02",
  area: "budget",
  description:
    "Fiili henüz kaydedilmemişse sapma 0 değil NULL, hüküm 'ölçülmedi'. 0 'hiç harcanmadı' " +
    "iddiasıdır; kimse henüz bakmamış olabilir.",
  input: [
    { direction: "expense", budget: 100_000.0, actual: null },
    { direction: "expense", budget: 0, actual: 250.0 },
  ],
  expected: [
    { actualAmount: null, varianceAmount: null, varianceRatio: null, verdict: "not_measured" },
    // bütçe 0: sapma tutarı hesaplanır (250,00) ama ORAN tanımsızdır → null
    { actualAmount: 250.0, varianceAmount: 250.0, varianceRatio: null, verdict: "over_budget" },
  ],
  derivation:
    "Fiili null → sapma ve oran null, hüküm 'not_measured'. " +
    "Bütçe 0 iken 250,00 harcandıysa sapma 250,00 TL'dir ve gider yönünde 'over_budget'tır, " +
    "ama %oran sıfıra bölme olduğu için null kalır — sonsuz veya 0 yazmak ikisi de yanlış olurdu.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   forecast — 13 haftalık ufuk, doğruluk, ağırlıklı net
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const FORECAST_WEEK_BUCKETS = Object.freeze({
  id: "FIN-FC-01",
  area: "forecast",
  description:
    "13 haftalık ufuk satırlardan türetilmez, ÜRETİLİR: tahmini olmayan hafta boş satır " +
    "olarak görünür, sessizce düşmez.",
  input: { anchorISO: TODAY, weeks: 13 },
  expected: {
    count: 13,
    first: { weekNo: 1, weekStart: "2026-08-25", weekEnd: "2026-08-31" },
    second: { weekNo: 2, weekStart: "2026-09-01", weekEnd: "2026-09-07" },
    last: { weekNo: 13, weekStart: "2026-11-17", weekEnd: "2026-11-23" },
  },
  derivation:
    "Hafta n başı = çapa + (n−1)×7 gün, sonu = başı + 6 gün (iki uç dahil, kesintisiz). " +
    "13. hafta başı = 2026-08-25 + 84 gün. 2026-08-25 → 2026-09-25 = 31 gün; " +
    "→ 2026-10-25 = 61 gün; 2026-10-25 + 23 gün = 2026-11-17 (61 + 23 = 84). " +
    "Sonu = 2026-11-17 + 6 = 2026-11-23. 13 × 7 = 91 gün, ilk gün dahil 2026-08-25..2026-11-23.",
} as const);

export const FORECAST_ACCURACY = Object.freeze({
  id: "FIN-FC-02",
  area: "forecast",
  description:
    "Tahmin doğruluğu yalnız ÖLÇÜLMÜŞ satırlar üzerinden: fiilisi olmayan satır 'tam isabet' " +
    "sayılmaz, sıfır tahminli satır MAPE'den çıkarılır ama sayısı açıkça bildirilir.",
  input: [
    { forecast: 100_000.0, actual: 110_000.0 },
    { forecast: 50_000.0, actual: 45_000.0 },
    { forecast: 0, actual: 2_500.0 },
    { forecast: 80_000.0, actual: null },
  ],
  expected: {
    measuredCount: 3,
    biasTotal: 7_500.0,
    absoluteErrorTotal: 17_500.0,
    mape: 0.1,
    zeroForecastLines: 1,
  },
  derivation:
    "Ölçülen satırlar: 1, 2, 3 (4. satırın fiilisi yok → atlanır, ölçülmez). " +
    "Sapmalar: +10.000, −5.000, +2.500 → bias = 7.500,00. " +
    "Mutlak: 10.000 + 5.000 + 2.500 = 17.500,00. " +
    "MAPE yalnız sıfır olmayan tahminler üzerinden: (10.000/100.000 + 5.000/50.000) / 2 = " +
    "(0,1 + 0,1) / 2 = 0,1. Sıfır tahminli satır sayısı = 1 ve ayrıca raporlanır.",
} as const);

export const FORECAST_WEIGHTED_NET = Object.freeze({
  id: "FIN-FC-03",
  area: "forecast",
  description:
    "Güven ağırlıklı haftalık net: puanı olmayan satır KAYBOLMAZ, tam yüzle (ağırlık 1) girer.",
  input: [
    { amount: 100_000.0, direction: "inflow", confidence: 0.95 },
    { amount: 40_000.0, direction: "outflow", confidence: 0.85 },
    { amount: 25_000.0, direction: "inflow", confidence: null },
    { amount: null, direction: "inflow", confidence: 0.5 },
  ],
  expected: 86_000.0,
  derivation:
    "100.000 × 0,95 = +95.000,00 ; 40.000 × 0,85 = 34.000,00 çıkış → −34.000,00 ; " +
    "25.000 × 1 (puan yok → tam yüz) = +25.000,00 ; tutarı null olan satır atlanır. " +
    "Net = 95.000 − 34.000 + 25.000 = 86.000,00.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   reversal — ters kayıt net etkisi
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const REVERSAL_LEDGER = Object.freeze({
  id: "FIN-REV-01",
  area: "reversal",
  description:
    "Cari hesapta ters kayıt: hatalı borç ve birebir alacağı kapandıktan sonra bakiye " +
    "hatadan ÖNCEKİ değere tam döner, kuruş artığı kalmaz.",
  input: {
    movements: [
      { movementDate: "2026-01-01", debitAmount: 100_000.0, creditAmount: 0 },
      { movementDate: "2026-01-05", debitAmount: 45_678.91, creditAmount: 0 },
      { movementDate: "2026-01-06", debitAmount: 0, creditAmount: 45_678.91 },
    ],
  },
  expected: { balances: [100_000.0, 145_678.91, 100_000.0], netEffectOfReversal: 0 },
  derivation:
    "100.000,00 → +45.678,91 = 145.678,91 → −45.678,91 = 100.000,00. " +
    "Ters kaydın net etkisi TAM OLARAK 0 olmalı; artık bırakan bir iptal, aylar sonra " +
    "açıklanamayan bir toplam olarak ortaya çıkar.",
} as const);

export const REVERSAL_AWKWARD_DECIMALS = Object.freeze({
  id: "FIN-REV-02",
  area: "reversal",
  description:
    "Kanonik float tuzağı defter üzerinde: 0,10 + 0,20 − 0,30 tam sıfır olmalı. " +
    "Float yolunda bu 5,55e−17 verir.",
  input: {
    movements: [
      { movementDate: "2026-02-01", debitAmount: 0.1, creditAmount: 0 },
      { movementDate: "2026-02-02", debitAmount: 0.2, creditAmount: 0 },
      { movementDate: "2026-02-03", debitAmount: 0, creditAmount: 0.3 },
    ],
  },
  expected: { balances: [0.1, 0.3, 0], floatResidue: 5.551115123125783e-17 },
  derivation:
    "0,10 → 0,30 → 0,00. Ondalık aritmetikte kapanış tam 0'dır. " +
    "Aynı işlem IEEE-754 float ile 0.1 + 0.2 − 0.3 = 5.551115123125783e−17 verir; " +
    "bu artık yüzlerce satırlık bir defterde bakiyeye yapışır ve @/lib/money bu yüzden var.",
} as const);

export const REVERSAL_CHECK_CANCELLED = Object.freeze({
  id: "FIN-REV-03",
  area: "reversal",
  description:
    "İptal edilen çek: aynı ay içinde −125.000,50 ve +125.000,50 birlikte görünür; net etki " +
    "sıfırdır ama iki hareket de takvimde SAKLANMAZ.",
  input: {
    items: [
      { id: "CHK-9", dueDate: "2026-09-12", amount: 125_000.5, direction: "outflow" },
      { id: "CHK-9-REV", dueDate: "2026-09-12", amount: 125_000.5, direction: "inflow" },
    ],
    netExposureAmounts: ["-125000.50", "125000.50"],
  },
  expected: {
    bucket: { key: "2026-09", count: 2, knownOutflow: 125_000.5, knownInflow: 125_000.5 },
    netEffect: 0,
    netExposure: 0,
  },
  derivation:
    "Çıkış 125.000,50 ve giriş 125.000,50 → net 0. " +
    "Kova sayısı 2 kalır: iptal, hareketi tarihten silmez; iki satır da denetim izinde durur. " +
    "İşaretli tutarların net toplamı da −125.000,50 + 125.000,50 = 0.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   cashflow identity — kapanış = açılış + gelir − gider
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const CASHFLOW_IDENTITY_MONTHS = Object.freeze({
  id: "FIN-CF-01",
  area: "cashflow identity",
  description:
    "Altı aylık projeksiyon: her ayın kapanışı elle 'açılış + gelir − gider' ile yazıldı; " +
    "ilk negatif ay, en kötü ay ve en uzun negatif seri buradan çıkar.",
  input: {
    months: [
      { monthStart: "2026-01-01", opening: 500_000.0, income: 1_200_000.0, expense: 900_000.0, closing: 800_000.0 },
      { monthStart: "2026-02-01", opening: 800_000.0, income: 700_000.0, expense: 1_450_000.0, closing: 50_000.0 },
      { monthStart: "2026-03-01", opening: 50_000.0, income: 600_000.0, expense: 950_000.0, closing: -300_000.0 },
      { monthStart: "2026-04-01", opening: -300_000.0, income: 1_100_000.0, expense: 500_000.0, closing: 300_000.0 },
      { monthStart: "2026-05-01", opening: 300_000.0, income: null, expense: 400_000.0, closing: null },
      { monthStart: "2026-06-01", opening: null, income: 800_000.0, expense: 700_000.0, closing: 250_000.0 },
    ],
  },
  expected: {
    // kimlik: her ay için açılış + gelir − gider
    identityClosings: [800_000.0, 50_000.0, -300_000.0, 300_000.0, null, null],
    deltas: [300_000.0, -750_000.0, -350_000.0, 600_000.0, null, 100_000.0],
    firstNegativeMonth: "2026-03-01",
    worstMonth: "2026-03-01",
    worstBalance: -300_000.0,
    longestNegativeRun: { length: 1, from: "2026-03-01" },
  },
  derivation:
    "Ocak: 500.000 + 1.200.000 − 900.000 = 800.000. Şubat: 800.000 + 700.000 − 1.450.000 = 50.000. " +
    "Mart: 50.000 + 600.000 − 950.000 = −300.000. Nisan: −300.000 + 1.100.000 − 500.000 = 300.000. " +
    "Mayıs: gelir bilinmiyor → kapanış hesaplanamaz, NULL (0 değil). " +
    "Haziran: açılış bilinmiyor → kimlik kurulamaz, NULL. " +
    "delta = gelir − gider: 300.000 / −750.000 / −350.000 / 600.000 / null (gelir yok) / 100.000. " +
    "İlk negatif kapanış Mart; en düşük kapanış da Mart (−300.000). " +
    "Negatif seri yalnız Mart'ta 1 ay sürer — Nisan artıya döner.",
} as const);

export const CASHFLOW_CONTINUITY = Object.freeze({
  id: "FIN-CF-02",
  area: "cashflow identity",
  description:
    "Zincir kontrolü: bir ayın kapanışı bir sonrakinin açılışı olmalı. Kopukluk ve eksik ay " +
    "BAYRAKLANIR, düzeltilmez.",
  input: {
    months: [
      { monthStart: "2026-01-01", opening: 500_000.0, income: 1_200_000.0, expense: 900_000.0, closing: 800_000.0 },
      { monthStart: "2026-02-01", opening: 800_000.0, income: 700_000.0, expense: 1_450_000.0, closing: 50_000.0 },
      { monthStart: "2026-03-01", opening: 49_000.0, income: 600_000.0, expense: 950_000.0, closing: -301_000.0 },
      { monthStart: "2026-05-01", opening: -301_000.0, income: 100_000.0, expense: 50_000.0, closing: -251_000.0 },
    ],
  },
  expected: {
    breakCount: 1,
    firstBreak: {
      prevMonth: "2026-02-01",
      nextMonth: "2026-03-01",
      prevClosing: 50_000.0,
      nextOpening: 49_000.0,
      diff: -1_000.0,
    },
    gapCount: 1,
    firstGap: { afterMonth: "2026-03-01", expected: "2026-04-01" },
  },
  derivation:
    "Ocak→Şubat: 800.000 kapanış = 800.000 açılış, fark 0 → temiz. " +
    "Şubat→Mart: 50.000 kapanış ≠ 49.000 açılış, fark = 49.000 − 50.000 = −1.000 TL, " +
    "|−1.000| > 1 TL tolerans → kopukluk. " +
    "Mart'tan sonra beklenen ay 2026-04-01 ama sıradaki 2026-05-01 → eksik ay bayrağı. " +
    "Zincir karşılaştırması yalnız ardışık aylar için anlamlı olduğundan Mart→Mayıs " +
    "kopukluk olarak DEĞİL, boşluk olarak raporlanır.",
} as const);

export const CASHFLOW_TOLERANCE_BOUNDARY = Object.freeze({
  id: "FIN-CF-03",
  area: "cashflow identity",
  description:
    "Zincir toleransı tam 1,00 TL'dir: 1,00 fark bayraklanmaz, 2,00 bayraklanır. Sınırın " +
    "iki yanı da yazıldı ki tolerans sessizce genişlemesin.",
  input: {
    exactlyOne: [
      { monthStart: "2026-01-01", opening: 0, income: null, expense: null, closing: 50_000.0 },
      { monthStart: "2026-02-01", opening: 50_001.0, income: null, expense: null, closing: null },
    ],
    twoLira: [
      { monthStart: "2026-01-01", opening: 0, income: null, expense: null, closing: 50_000.0 },
      { monthStart: "2026-02-01", opening: 50_002.0, income: null, expense: null, closing: null },
    ],
  },
  expected: {
    exactlyOne: { breakCount: 0 },
    twoLira: { breakCount: 1, diff: 2 },
  },
  derivation:
    "|50.001,00 − 50.000,00| = 1,00 ; kural '> 1' olduğu için 1,00 tam sınırda bayraklanmaz. " +
    "|50.002,00 − 50.000,00| = 2,00 > 1 → bayrak, diff = 50.002 − 50.000 = +2,00.",
} as const);

export const CASHFLOW_LIQUIDITY_HORIZONS = Object.freeze({
  id: "FIN-CF-04",
  area: "cashflow identity",
  description:
    "Hazine 7/30/90 gün: pencere yarı-açıktır [bugün, bugün+N), sınır günündeki hareket bir " +
    "sonraki ufka düşer — hiçbir para iki ufukta birden sayılmaz. Sözleşmeli ve beklenen " +
    "ayrı raporlanır: rahat rakamın müşteri sözüne bağlı olup olmadığı tek sayıyla söylenemez.",
  input: {
    openingPosition: 1_500_000.0,
    todayISO: TODAY,
    minCashFloor: 500_000.0,
    flows: [
      { flowDate: "2026-08-25", amountSigned: 250_000.0, certainty: "contracted" },
      { flowDate: "2026-08-30", amountSigned: -400_000.0, certainty: "contracted" },
      { flowDate: "2026-09-01", amountSigned: 180_000.5, certainty: "expected" },
      { flowDate: "2026-09-01", amountSigned: -60_000.5, certainty: "contracted" },
      { flowDate: "2026-09-24", amountSigned: -900_000.0, certainty: "contracted" },
      { flowDate: "2026-11-30", amountSigned: -1_000_000.0, certainty: "contracted" },
    ],
  },
  expected: [
    {
      horizonDays: 7,
      toDate: "2026-09-01",
      flowCount: 2,
      contractedNet: -150_000.0,
      expectedNet: -150_000.0,
      projectedContracted: 1_350_000.0,
      projectedExpected: 1_350_000.0,
      financingNeed: 0,
      breachesFloor: false,
    },
    {
      horizonDays: 30,
      toDate: "2026-09-24",
      flowCount: 4,
      contractedNet: -210_000.5,
      expectedNet: -30_000.0,
      projectedContracted: 1_289_999.5,
      projectedExpected: 1_470_000.0,
      financingNeed: 0,
      breachesFloor: false,
    },
    {
      horizonDays: 90,
      toDate: "2026-11-23",
      flowCount: 5,
      contractedNet: -1_110_000.5,
      expectedNet: -930_000.0,
      projectedContracted: 389_999.5,
      projectedExpected: 570_000.0,
      financingNeed: 110_000.5,
      breachesFloor: true,
    },
  ],
  derivation:
    "Pencere sonları: 2026-08-25 + 7 = 2026-09-01 ; +30 = 2026-09-24 ; +90 = 2026-11-23. " +
    "7 gün: 250.000 − 400.000 = −150.000 → 1.500.000 − 150.000 = 1.350.000. " +
    "  09-01 tarihli iki hareket TAM SINIRDA olduğu için 7 günlük ufka GİRMEZ. " +
    "30 gün: sözleşmeli 250.000 − 400.000 − 60.000,50 = −210.000,50 → 1.289.999,50 ; " +
    "  tümü 250.000 − 400.000 + 180.000,50 − 60.000,50 = −30.000 → 1.470.000. " +
    "  09-24 tarihli hareket TAM SINIRDA, 30 günlük ufka girmez. " +
    "90 gün: sözleşmeli −210.000,50 − 900.000 = −1.110.000,50 → 389.999,50 ; " +
    "  tümü −30.000 − 900.000 = −930.000 → 570.000. 11-30 tarihli hareket ufkun dışında. " +
    "Taban 500.000: 500.000 − 389.999,50 = 110.000,50 finansman ihtiyacı, taban delinmiş. " +
    "Beklenen senaryoda 570.000 > 500.000 — yani rahatlık tamamen müşteri sözüne bağlı.",
} as const);

export const CASHFLOW_RECONCILIATION = Object.freeze({
  id: "FIN-CF-05",
  area: "cashflow identity",
  description:
    "Hazine kapanışı ile gözden geçirilmiş nakit akış kapanışının mutabakatı: 1,00 TL " +
    "toleransla uyumlu/sapmalı. Eksik taraf 0 sayılmaz, ayrı bir hükümle bildirilir.",
  input: {
    aligned: { cashflowClosing: 1_290_000.0, treasuryClosing: 1_289_999.5 },
    divergent: { cashflowClosing: 1_290_000.0, treasuryClosing: 1_288_500.0 },
    cashflowMissing: { cashflowClosing: null, treasuryClosing: 1_289_999.5 },
    noBankMovement: { cashflowClosing: 1_290_000.0, treasuryClosing: null },
  },
  expected: {
    aligned: { status: "aligned", difference: -0.5 },
    divergent: { status: "divergent", difference: -1_500.0 },
    cashflowMissing: { status: "cashflow_missing", difference: null },
    noBankMovement: { status: "no_bank_movement", difference: null },
  },
  derivation:
    "fark = hazine − nakit akış. 1.289.999,50 − 1.290.000,00 = −0,50 ; |−0,50| ≤ 1 → uyumlu. " +
    "1.288.500,00 − 1.290.000,00 = −1.500,00 ; |−1.500| > 1 → SAPMA VAR. " +
    "Taraflardan biri yoksa fark null'dır: 0 yazmak 'iki kaynak birebir tutuyor' demek olurdu, " +
    "oysa ölçülen bir şey yok.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   destek vakaları — kredi limiti, maliyet dağıtımı, yoğunlaşma
   (kapsam listesinde ayrı başlık değil; check/loan/allocation başlıklarını güçlendirir)
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const FACILITY_UTILIZATION = Object.freeze({
  id: "FIN-FAC-01",
  area: "loan",
  description:
    "Kredi limiti kullanımı: çekiliş limiti tüketir, geri ödeme iade eder. Limit aşımında " +
    "kullanılabilir tutar 0'a sabitlenir, EKSİ olarak hazine toplamına sızmaz.",
  input: {
    within: {
      limit: 5_000_000.0,
      movements: [
        { type: "drawdown", amount: 1_200_000.0 },
        { type: "drawdown", amount: 800_000.5 },
        { type: "repayment", amount: 500_000.0 },
      ],
    },
    over: {
      limit: 1_000_000.0,
      movements: [{ type: "drawdown", amount: 1_250_000.0 }],
    },
    zeroLimit: { limit: 0, movements: [{ type: "drawdown", amount: 100_000.0 }] },
  },
  expected: {
    signed: [1_200_000.0, 800_000.5, -500_000.0],
    within: {
      drawnAmount: 1_500_000.5,
      availableAmount: 3_499_999.5,
      utilizationRatio: 0.3000001,
      overLimit: false,
    },
    over: {
      drawnAmount: 1_250_000.0,
      availableAmount: 0,
      utilizationRatio: 1.25,
      overLimit: true,
    },
    // limit 0 iken oran TANIMSIZ'dır, 0 değil
    zeroLimit: { drawnAmount: 100_000.0, availableAmount: 0, utilizationRatio: null, overLimit: true },
  },
  derivation:
    "Çekilen = 1.200.000,00 + 800.000,50 − 500.000,00 = 1.500.000,50. " +
    "Kullanılabilir = 5.000.000,00 − 1.500.000,50 = 3.499.999,50. " +
    "Kullanım oranı = 1.500.000,50 / 5.000.000 = 0,3000001. " +
    "Aşım vakası: 1.000.000 − 1.250.000 = −250.000 → tabanlanır 0 ; oran 1,25 ; aşım true. " +
    "Limit 0 iken oranın paydası yoktur → null (0 yazmak '%0 kullanım' demek olurdu).",
} as const);

export const FACILITY_MATURITY_LADDER = Object.freeze({
  id: "FIN-FAC-02",
  area: "check",
  description:
    "Vade merdiveni 30/90/180/365: gecikmiş kalem merdivende yer almaz (gecikme raporunun " +
    "konusudur), bir yılı aşan da yer almaz.",
  input: {
    todayISO: TODAY,
    dueDates: ["2026-08-24", "2026-08-25", "2026-09-23", "2026-09-24", "2027-08-24", "2027-08-25"],
  },
  expected: [null, 30, 30, 90, 365, null],
  derivation:
    "2026-08-24 → −1 gün (gecikmiş) → null. 2026-08-25 → 0 gün → 30 kovası. " +
    "2026-09-23 → 29 gün (Ağustos'ta 6 + 23) → 30 kovası. 2026-09-24 → 30 gün → 90 kovası. " +
    "2027-08-24 → 364 gün → 365 kovası. 2027-08-25 → 365 gün → merdivenin dışında, null.",
} as const);

export const COSTING_ALLOCATION_REMAINDER = Object.freeze({
  id: "FIN-CST-01",
  area: "allocation",
  description:
    "Kuruş problemi: 100,00 TL üçe bölününce 33,33 × 3 = 99,99 eder. Kalan bir kuruş EN BÜYÜK " +
    "paya verilir; parçaların toplamı bütüne TAM eşit olmak zorundadır.",
  input: {
    equalThirds: {
      totalCost: 100.0,
      targets: [
        { id: "cc-a", label: "A merkezi", driver: 1 },
        { id: "cc-b", label: "B merkezi", driver: 1 },
        { id: "cc-c", label: "C merkezi", driver: 1 },
      ],
    },
    weighted: {
      totalCost: 120_000.0,
      targets: [
        { id: "m2", label: "Makine 2", driver: 3_000 },
        { id: "m1", label: "Makine 1", driver: 4_500 },
        { id: "m3", label: "Makine 3", driver: 1_500 },
      ],
    },
  },
  expected: {
    equalThirds: {
      order: ["cc-a", "cc-b", "cc-c"],
      amounts: [33.34, 33.33, 33.33],
      total: 100.0,
    },
    weighted: {
      order: ["m1", "m2", "m3"],
      shares: [0.5, 0.3333333333, 0.1666666667],
      amounts: [60_000.0, 40_000.0, 20_000.0],
      total: 120_000.0,
    },
  },
  derivation:
    "Eşit üçlü: pay = 1/3 → 10 hane yuvarlamayla 0,3333333333 ; 100 × 0,3333333333 = 33,33 " +
    "(her biri). Toplam 99,99 ; kalan 100,00 − 99,99 = 0,01. Sürücüler eşit olduğu için sıra " +
    "id'ye göre belirlenir (cc-a, cc-b, cc-c) ve kuruş ilk sıraya eklenir: 33,33 + 0,01 = 33,34. " +
    "Ağırlıklı: sürücü toplamı 4.500 + 3.000 + 1.500 = 9.000. " +
    "4.500/9.000 = 0,5 → 60.000,00 ; 3.000/9.000 = 0,3333333333 → 39.999,999996 → 40.000,00 ; " +
    "1.500/9.000 = 0,1666666667 → 20.000,000004 → 20.000,00. Toplam tam 120.000,00, kalan 0.",
} as const);

export const COSTING_PROFITABILITY = Object.freeze({
  id: "FIN-CST-02",
  area: "budget",
  description:
    "Kârlılık: maliyet kaydedilmemişse marj 0 değil NULL. Sıfır ciro ise marj gerçek bir " +
    "negatif sayıdır, yalnız YÜZDESİ bilinemez.",
  input: {
    normal: { revenue: 850_000.0, cost: 612_000.0 },
    zeroRevenue: { revenue: 0, cost: 125_000.0 },
    unknownCost: { revenue: 500_000.0, cost: null },
  },
  expected: {
    normal: { margin: 238_000.0, marginRate: 0.28, confidence: "estimated" },
    zeroRevenue: { margin: -125_000.0, marginRate: null, confidence: "estimated" },
    unknownCost: { margin: null, marginRate: null, confidence: "needs_review" },
  },
  derivation:
    "850.000,00 − 612.000,00 = 238.000,00 ; 238.000 / 850.000 = 0,28 " +
    "(850.000 × 0,28 = 238.000 — tam bölünüyor). " +
    "Ciro 0 iken 0 − 125.000,00 = −125.000,00 gerçek bir zarardır ve KORUNUR; oran ise " +
    "sıfıra bölme olduğu için null. Maliyet bilinmiyorsa marj hesaplanamaz → null ve " +
    "'needs_review' — 0 yazmak gerçek bir başabaş ile ayırt edilemez olurdu.",
} as const);

export const COSTING_CASH_CYCLE = Object.freeze({
  id: "FIN-CST-03",
  area: "receivable",
  description:
    "Nakit dönüşüm süresi: bu sistemde stok verisi YOK, o yüzden CCC null döner ve gerekçesi " +
    "yazılır. DIO'yu 0 saymak döngüyü kısaltıp işletme sermayesini olduğundan iyi gösterirdi.",
  input: { dsoDays: 62.5, dioDays: null, dpoDays: 41.2 },
  expected: {
    cashConversionCycleDays: null,
    cycleExcludingInventory: 21.3,
    unmeasurableReason: "dio_unknown",
    /** Aynı çıkarma float ile yapılsaydı: */
    floatResult: 21.299999999999997,
  },
  derivation:
    "62,5 − 41,2 = 21,3 gün (stok hariç döngü). " +
    "CCC = DSO + DIO − DPO ve DIO bilinmiyor → null, gerekçe 'dio_unknown'. " +
    "Aynı çıkarma IEEE-754 float ile 21.299999999999997 verir — ondalık aritmetik tam 21,3 verir.",
} as const);

export const CONCENTRATION_RISK = Object.freeze({
  id: "FIN-CON-01",
  area: "receivable",
  description:
    "Müşteri yoğunlaşması: aynı müşterinin satırları toplanır, atanmamış anahtar gizlenmez, " +
    "negatif ve sıfır satırlar yoğunlaşma sayılmaz, tutarı bilinmeyen satır ayrıca bildirilir.",
  input: {
    items: [
      { key: "Müşteri A", amount: 600_000.0 },
      { key: "Müşteri B", amount: 250_000.0 },
      { key: "Müşteri A", amount: 150_000.0 },
      { key: "Müşteri C", amount: 200_000.0 },
      { key: null, amount: 300_000.0 },
      { key: "Müşteri D", amount: null },
      { key: "Müşteri E", amount: -50_000.0 },
      { key: "Müşteri F", amount: 0 },
    ],
    flagRatio: 0.4,
  },
  expected: {
    knownTotal: 1_500_000.0,
    unknownCount: 1,
    entries: [
      { key: "Müşteri A", sum: 750_000.0, ratio: 0.5, flagged: true },
      { key: "(atanmadı)", sum: 300_000.0, ratio: 0.2, flagged: false },
      { key: "Müşteri B", sum: 250_000.0, ratio: 0.1666666667, flagged: false },
      { key: "Müşteri C", sum: 200_000.0, ratio: 0.1333333333, flagged: false },
    ],
  },
  derivation:
    "Bilinen toplam = 600.000 + 250.000 + 150.000 + 200.000 + 300.000 = 1.500.000. " +
    "A = 600.000 + 150.000 = 750.000 → 750.000/1.500.000 = 0,5 > 0,40 → BAYRAK. " +
    "(atanmadı) = 300.000 → 0,2. B = 250.000 → 0,1666666667 (10 hane). " +
    "C = 200.000 → 0,1333333333. " +
    "D'nin tutarı null → unknownCount = 1, toplama 0 olarak girmez. " +
    "E negatif ve F sıfır → yoğunlaşma değildir, ikisi de toplama girmez. " +
    "Sıralama tutara göre azalan.",
} as const);

export const CONCENTRATION_THRESHOLD_BOUNDARY = Object.freeze({
  id: "FIN-CON-02",
  area: "receivable",
  description:
    "Yoğunlaşma eşiğinin TAM SINIRI. Karşılaştırma 'oran > 0,40' olduğu için tam %40 " +
    "BAYRAKLANMAZ, bir kuruş fazlası bayraklanır. Sınırdaki müşterinin tutarı üç satırdan " +
    "birikir: aynı birikim float ile yapılsaydı oran 0,4000000000000001 çıkıp tam sınırdaki " +
    "müşteriyi HAKSIZ YERE bayraklardı — bu vaka ondalık birikimin bekçisidir.",
  input: {
    // A'nın üç satırı kuruşu kuruşuna 400.000,00 eder; bilinen toplam tam 1.000.000,00.
    exactlyForty: [
      { key: "Müşteri A", amount: 159_785.98 },
      { key: "Müşteri A", amount: 137_818.07 },
      { key: "Müşteri A", amount: 102_395.95 },
      { key: "Müşteri B", amount: 350_000.0 },
      { key: "Müşteri C", amount: 250_000.0 },
    ],
    // Aynı kurgu, A'nın son satırı bir kuruş fazla; B bir kuruş eksik → toplam yine 1.000.000,00.
    oneKurusAbove: [
      { key: "Müşteri A", amount: 159_785.98 },
      { key: "Müşteri A", amount: 137_818.07 },
      { key: "Müşteri A", amount: 102_395.96 },
      { key: "Müşteri B", amount: 349_999.99 },
      { key: "Müşteri C", amount: 250_000.0 },
    ],
    flagRatio: 0.4,
  },
  expected: {
    exactlyForty: {
      knownTotal: 1_000_000.0,
      unknownCount: 0,
      entries: [
        { key: "Müşteri A", sum: 400_000.0, ratio: 0.4, flagged: false },
        { key: "Müşteri B", sum: 350_000.0, ratio: 0.35, flagged: false },
        { key: "Müşteri C", sum: 250_000.0, ratio: 0.25, flagged: false },
      ],
      flaggedCount: 0,
    },
    oneKurusAbove: {
      knownTotal: 1_000_000.0,
      unknownCount: 0,
      entries: [
        { key: "Müşteri A", sum: 400_000.01, ratio: 0.40000001, flagged: true },
        { key: "Müşteri B", sum: 349_999.99, ratio: 0.34999999, flagged: false },
        { key: "Müşteri C", sum: 250_000.0, ratio: 0.25, flagged: false },
      ],
      flaggedCount: 1,
    },
    /** A'nın üç satırı float `+=` ile toplandığında ölçülen değer ve ondan doğan oran. */
    exactlyFortyIfFloatAccumulated: { sum: 400_000.00000000006, ratio: 0.4000000000000001 },
    /** Float yol tam sınırdaki müşteriyi bayraklardı; ondalık yol bayraklamıyor. */
    exactlyFortyWouldFlagIfFloat: true,
  },
  derivation:
    "concentration kaynağı: `.map((e) => ({ ...e, flagged: e.ratio > flagRatio }))` — '>' , " +
    "'>=' DEĞİL. Yani tam 0,40 bayraklanmaz. " +
    "A = 159.785,98 + 137.818,07 = 297.604,05 ; + 102.395,95 = 400.000,00. " +
    "Bilinen toplam = 400.000,00 + 350.000,00 + 250.000,00 = 1.000.000,00. " +
    "A oranı = 400.000/1.000.000 = 0,40 ; 0,40 > 0,40 yanlış → BAYRAK YOK. " +
    "B = 0,35 ; C = 0,25 → hiçbiri bayraklanmaz, flaggedCount = 0. " +
    "Bir kuruş üstü: A = 400.000,01 → 0,40000001 > 0,40 → BAYRAK; B = 349.999,99 → 0,34999999 ; " +
    "C = 0,25 → tam olarak BİR bayrak. " +
    "Aynı A toplamı float ile: 159785.98 + 137818.07 + 102395.95 = 400000.00000000006 (ölçüldü), " +
    "bölüm 0,4000000000000001 > 0,40 → tam sınırdaki müşteri haksız yere bayraklanırdı. " +
    "Sıralama tutara göre azalan: A, B, C.",
} as const);

export const EXPOSURE_THRESHOLD_BOUNDARY = Object.freeze({
  id: "FIN-EXP-01",
  area: "check",
  description:
    "Banka maruziyeti eşiğinin TAM SINIRI. exposureBy, concentration ile AYNI algoritmayı " +
    "aynı 0,40 eşiğiyle koşturur; bu vaka iki fonksiyonun sınırda aynı cevabı verdiğini " +
    "çiviler. Giriş ve çıkış ayrı birikir, maruziyet ikisinin toplamıdır.",
  input: {
    exactlyForty: [
      { key: "HALK", amount: 159_785.98, direction: "outflow" },
      { key: "HALK", amount: 137_818.07, direction: "outflow" },
      { key: "HALK", amount: 102_395.95, direction: "inflow" },
      { key: "DENİZ", amount: 350_000.0, direction: "outflow" },
      { key: "ZİRAAT", amount: 250_000.0, direction: "outflow" },
    ],
    oneKurusAbove: [
      { key: "HALK", amount: 159_785.98, direction: "outflow" },
      { key: "HALK", amount: 137_818.07, direction: "outflow" },
      { key: "HALK", amount: 102_395.96, direction: "inflow" },
      { key: "DENİZ", amount: 349_999.99, direction: "outflow" },
      { key: "ZİRAAT", amount: 250_000.0, direction: "outflow" },
    ],
    flagRatio: 0.4,
  },
  expected: {
    exactlyForty: {
      knownTotal: 1_000_000.0,
      unknownCount: 0,
      entries: [
        {
          key: "HALK", outflowSum: 297_604.05, inflowSum: 102_395.95,
          total: 400_000.0, ratio: 0.4, flagged: false,
        },
        {
          key: "DENİZ", outflowSum: 350_000.0, inflowSum: 0,
          total: 350_000.0, ratio: 0.35, flagged: false,
        },
        {
          key: "ZİRAAT", outflowSum: 250_000.0, inflowSum: 0,
          total: 250_000.0, ratio: 0.25, flagged: false,
        },
      ],
      flaggedCount: 0,
    },
    oneKurusAbove: {
      knownTotal: 1_000_000.0,
      unknownCount: 0,
      entries: [
        {
          key: "HALK", outflowSum: 297_604.05, inflowSum: 102_395.96,
          total: 400_000.01, ratio: 0.40000001, flagged: true,
        },
        {
          key: "DENİZ", outflowSum: 349_999.99, inflowSum: 0,
          total: 349_999.99, ratio: 0.34999999, flagged: false,
        },
        {
          key: "ZİRAAT", outflowSum: 250_000.0, inflowSum: 0,
          total: 250_000.0, ratio: 0.25, flagged: false,
        },
      ],
      flaggedCount: 1,
    },
    /** Float `+=` ile ölçülen: çıkış toplamı da, maruziyet toplamı da sürükleniyor. */
    exactlyFortyIfFloatAccumulated: {
      outflowSum: 297_604.05000000005,
      total: 400_000.00000000006,
      ratio: 0.4000000000000001,
    },
    exactlyFortyWouldFlagIfFloat: true,
  },
  derivation:
    "exposureBy kaynağı: `.map((e) => ({ ...e, flagged: e.ratio > flagRatio }))` — " +
    "concentration ile birebir aynı karşılaştırma, '>' . " +
    "HALK çıkış = 159.785,98 + 137.818,07 = 297.604,05 ; giriş = 102.395,95 ; " +
    "maruziyet = 297.604,05 + 102.395,95 = 400.000,00. " +
    "Bilinen toplam = 400.000,00 + 350.000,00 + 250.000,00 = 1.000.000,00 (maruziyet iki yönü " +
    "de mutlak değeriyle sayar). " +
    "HALK oranı = 0,40 ; 0,40 > 0,40 yanlış → BAYRAK YOK. DENİZ 0,35 ; ZİRAAT 0,25. " +
    "Bir kuruş üstü: HALK girişi 102.395,96 → maruziyet 400.000,01 → 0,40000001 > 0,40 → BAYRAK; " +
    "DENİZ 349.999,99 → 0,34999999 → bayrak yok. Tam olarak BİR bayrak. " +
    "Float ölçümü: çıkış 297604.05000000005, toplam 400000.00000000006, oran 0,4000000000000001 " +
    "→ tam sınırdaki banka haksız yere bayraklanırdı.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   precision — rehber §13 "Precision" listesi
   ════════════════════════════════════════════════════════════════════════════════════════ */

export const PRECISION_ROUNDING_DIRECTION = Object.freeze({
  id: "FIN-PRC-01",
  area: "invoice",
  description:
    "Yuvarlama YÖNÜ: half-up (sıfırdan uzağa), Postgres round(numeric, n) ile aynı. " +
    "Banker's rounding (half-even) DEĞİL ve JS toFixed DEĞİL.",
  input: ["2.665", "2.685", "2.675", "-2.675", "-0.005", "1.005", "1.0049999999"],
  expected: {
    halfUp: ["2.67", "2.69", "2.68", "-2.68", "-0.01", "1.01", "1.00"],
    // Aynı girdiler half-even (banker's) uygulansaydı: 2.665→2.66, 2.685→2.68
    halfEvenWouldGive: ["2.66", "2.68"],
    // JS toFixed'in verdiği (yanlış) karşılıklar
    toFixedGives: ["2.67", "2.69", "2.67", "-2.67", "-0.01", "1.00", "1.00"],
  },
  derivation:
    "half-up: ondalıktan sonraki üçüncü hane 5 ise sıfırdan UZAĞA yuvarlanır. " +
    "2,665 → 2,67 (half-even 2,66 verirdi — ayırt edici vaka). " +
    "2,685 → 2,69 (half-even 2,68 verirdi — ikinci ayırt edici vaka). " +
    "−2,675 → −2,68 ve −0,005 → −0,01: negatifte de sıfırdan uzağa. " +
    "1,0049999999 tam yarımın ALTINDA → 1,00, yuvarlanmaz. " +
    "1,005 için JS (1.005).toFixed(2) = '1.00' verir; Postgres ve bu modül 1,01 verir.",
} as const);

export const PRECISION_LARGE_AMOUNTS = Object.freeze({
  id: "FIN-PRC-02",
  area: "cashflow identity",
  description:
    "Milyar TL ölçeğinde toplama ve numeric(14,2) tavanı: her kuruş korunmalı.",
  input: {
    billions: ["4500000000.00", "3750000000.55"],
    nearMax: ["999999999999.99", "0.01"],
    maxPlusMax: ["499999999999.99", "499999999999.99"],
  },
  expected: {
    billions: 8_250_000_000.55,
    billionsFormatted: "8250000000.55",
    nearMax: 1_000_000_000_000,
    nearMaxFormatted: "1000000000000.00",
    maxPlusMax: 999_999_999_999.98,
  },
  derivation:
    "4.500.000.000,00 + 3.750.000.000,55 = 8.250.000.000,55. " +
    "999.999.999.999,99 + 0,01 = 1.000.000.000.000,00. " +
    "499.999.999.999,99 + 499.999.999.999,99 = 999.999.999.999,98. " +
    "numeric(14,2) tavanı 12 tam basamaktır; float64 tam sayı olarak 2^53 ≈ 9,0e15 kuruşa " +
    "kadar hatasızdır, yani sütunun tüm aralığı 2 hane ölçekte tam gider.",
} as const);

export const PRECISION_MANY_ADDITIONS = Object.freeze({
  id: "FIN-PRC-03",
  area: "cashflow identity",
  description:
    "Binlerce toplama sürüklenmeden birikmeli. 5.000 satır × 12.345,67 TL — bir yılın " +
    "hareket hacmi mertebesinde.",
  input: { rowCount: 5_000, amount: "12345.67" },
  expected: {
    exact: 61_728_350,
    exactFormatted: "61728350.00",
    // aynı toplama `+=` ile float üzerinde yapıldığında ölçülen değer
    floatDrift: 61_728_350.000006415,
  },
  derivation:
    "5.000 × 12.345,67 = 61.728.350,00 (12.345,67 × 5 = 61.728,35 ; ×1.000 = 61.728.350,00). " +
    "Aynı toplamayı `total += 12345.67` ile yapmak 61.728.350,000006415 verir — " +
    "kuruşun altında ama SIFIR DEĞİL, ve bir eşik karşılaştırmasında cevabı çevirebilir. " +
    "@/lib/money'nin sumMoney'si Postgres sum() ile aynı tam değeri verir.",
} as const);

export const PRECISION_BOUNDARY_VALUES = Object.freeze({
  id: "FIN-PRC-04",
  area: "cashflow identity",
  description:
    "Sınır değerler: açık sıfır ile bilinmeyen ayrı şeylerdir; boş metin bilinmeyendir; " +
    "en küçük para birimi 0,01 TL'dir ve eksi tarafı da vardır.",
  input: ["0.00", "0", null, undefined, "", "   ", "0.01", "-0.01", "0.004", "0.005"],
  expected: [0, 0, null, null, null, null, 0.01, -0.01, 0, 0.01],
  derivation:
    "'0.00' ve '0' açık ölçümlerdir → 0. " +
    "null/undefined/boş/boşluk bilinmeyendir → null (0 DEĞİL). " +
    "0,01 ve −0,01 en küçük TL birimleridir. " +
    "0,004 yarımın altında → 0,00 ; 0,005 tam yarım → half-up ile 0,01.",
} as const);

/* ════════════════════════════════════════════════════════════════════════════════════════
   kayıt — kapsam haritası testinin okuduğu liste
   ════════════════════════════════════════════════════════════════════════════════════════ */

/** Her vakanın (id, area) çifti. Kapsam testi bunu REQUIRED_AREAS ile karşılaştırır. */
export const GOLDEN_CASE_INDEX: ReadonlyArray<{ id: string; area: GoldenArea }> = Object.freeze([
  { id: PAYMENT_DUE_DAY_31.id, area: PAYMENT_DUE_DAY_31.area },
  { id: PAYMENT_DAY_FLAGS.id, area: PAYMENT_DAY_FLAGS.area },
  { id: PAYMENT_RISK_LADDER.id, area: PAYMENT_RISK_LADDER.area },
  { id: PAYMENT_THRESHOLD_BOUNDARY.id, area: PAYMENT_THRESHOLD_BOUNDARY.area },
  { id: INVOICE_LINE_TOTALS.id, area: INVOICE_LINE_TOTALS.area },
  { id: INVOICE_PARTIAL_PAYMENT.id, area: INVOICE_PARTIAL_PAYMENT.area },
  { id: INVOICE_OVERPAYMENT.id, area: INVOICE_OVERPAYMENT.area },
  { id: INVOICE_TERMINAL_INERT.id, area: INVOICE_TERMINAL_INERT.area },
  { id: INVOICE_DUPLICATE.id, area: INVOICE_DUPLICATE.area },
  { id: OVERDUE_AGEING_BOUNDARIES.id, area: OVERDUE_AGEING_BOUNDARIES.area },
  { id: OVERDUE_COLLECTION_BOUNDARIES.id, area: OVERDUE_COLLECTION_BOUNDARIES.area },
  { id: CHECK_SIGNED_DIRECTION.id, area: CHECK_SIGNED_DIRECTION.area },
  { id: CHECK_MATURITY_GROUPING.id, area: CHECK_MATURITY_GROUPING.area },
  { id: CHECK_MATURITY_WINDOWS.id, area: CHECK_MATURITY_WINDOWS.area },
  { id: LOAN_SCHEDULE.id, area: LOAN_SCHEDULE.area },
  { id: LOAN_RECONCILIATION_OK.id, area: LOAN_RECONCILIATION_OK.area },
  { id: LOAN_RECONCILIATION_MISMATCH.id, area: LOAN_RECONCILIATION_MISMATCH.area },
  { id: LOAN_NULL_NOT_ZERO.id, area: LOAN_NULL_NOT_ZERO.area },
  { id: LOAN_TOLERANCE_BOUNDARY.id, area: LOAN_TOLERANCE_BOUNDARY.area },
  { id: RECEIVABLE_AGEING_SUMMARY.id, area: RECEIVABLE_AGEING_SUMMARY.area },
  { id: RECEIVABLE_DSO.id, area: RECEIVABLE_DSO.area },
  { id: RECEIVABLE_RUNNING_BALANCE.id, area: RECEIVABLE_RUNNING_BALANCE.area },
  { id: ALLOCATION_FIFO_EXACT.id, area: ALLOCATION_FIFO_EXACT.area },
  { id: ALLOCATION_LEFTOVER.id, area: ALLOCATION_LEFTOVER.area },
  { id: ALLOCATION_CEILING.id, area: ALLOCATION_CEILING.area },
  { id: FX_LONG_POSITION.id, area: FX_LONG_POSITION.area },
  { id: FX_SHORT_POSITION.id, area: FX_SHORT_POSITION.area },
  { id: FX_UNKNOWN_RATE.id, area: FX_UNKNOWN_RATE.area },
  { id: FX_STRESS_TABLE.id, area: FX_STRESS_TABLE.area },
  { id: FX_NET_EXPOSURE.id, area: FX_NET_EXPOSURE.area },
  { id: BUDGET_VARIANCE.id, area: BUDGET_VARIANCE.area },
  { id: BUDGET_NOT_MEASURED.id, area: BUDGET_NOT_MEASURED.area },
  { id: FORECAST_WEEK_BUCKETS.id, area: FORECAST_WEEK_BUCKETS.area },
  { id: FORECAST_ACCURACY.id, area: FORECAST_ACCURACY.area },
  { id: FORECAST_WEIGHTED_NET.id, area: FORECAST_WEIGHTED_NET.area },
  { id: REVERSAL_LEDGER.id, area: REVERSAL_LEDGER.area },
  { id: REVERSAL_AWKWARD_DECIMALS.id, area: REVERSAL_AWKWARD_DECIMALS.area },
  { id: REVERSAL_CHECK_CANCELLED.id, area: REVERSAL_CHECK_CANCELLED.area },
  { id: CASHFLOW_IDENTITY_MONTHS.id, area: CASHFLOW_IDENTITY_MONTHS.area },
  { id: CASHFLOW_CONTINUITY.id, area: CASHFLOW_CONTINUITY.area },
  { id: CASHFLOW_TOLERANCE_BOUNDARY.id, area: CASHFLOW_TOLERANCE_BOUNDARY.area },
  { id: CASHFLOW_LIQUIDITY_HORIZONS.id, area: CASHFLOW_LIQUIDITY_HORIZONS.area },
  { id: CASHFLOW_RECONCILIATION.id, area: CASHFLOW_RECONCILIATION.area },
  { id: FACILITY_UTILIZATION.id, area: FACILITY_UTILIZATION.area },
  { id: FACILITY_MATURITY_LADDER.id, area: FACILITY_MATURITY_LADDER.area },
  { id: COSTING_ALLOCATION_REMAINDER.id, area: COSTING_ALLOCATION_REMAINDER.area },
  { id: COSTING_PROFITABILITY.id, area: COSTING_PROFITABILITY.area },
  { id: COSTING_CASH_CYCLE.id, area: COSTING_CASH_CYCLE.area },
  { id: CONCENTRATION_RISK.id, area: CONCENTRATION_RISK.area },
  { id: CONCENTRATION_THRESHOLD_BOUNDARY.id, area: CONCENTRATION_THRESHOLD_BOUNDARY.area },
  { id: EXPOSURE_THRESHOLD_BOUNDARY.id, area: EXPOSURE_THRESHOLD_BOUNDARY.area },
  { id: PRECISION_ROUNDING_DIRECTION.id, area: PRECISION_ROUNDING_DIRECTION.area },
  { id: PRECISION_LARGE_AMOUNTS.id, area: PRECISION_LARGE_AMOUNTS.area },
  { id: PRECISION_MANY_ADDITIONS.id, area: PRECISION_MANY_ADDITIONS.area },
  { id: PRECISION_BOUNDARY_VALUES.id, area: PRECISION_BOUNDARY_VALUES.area },
]);
