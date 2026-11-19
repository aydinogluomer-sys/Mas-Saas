import type { NavItem } from "@/components/ui/nav";
import { canSeeRoute, type AppRole } from "@/lib/authz/matrix";
import { LIFECYCLE_STAGES, type LifecycleStep } from "@/lib/navigation/module-framing";

export type OperationalIntentKey =
  | "ingest_reconcile"
  | "daily_cash_payables"
  | "portfolio_fx_covenants"
  | "forecast_stress_brief";

export interface OperationalIntentSpec {
  readonly key: OperationalIntentKey;
  readonly stepBadge: string;
  readonly shortLabel: string;
  readonly label: string;
  readonly subtitle: string;
  readonly primaryHref: string;
  readonly secondaryHrefs: readonly { readonly href: string; readonly label: string }[];
}

export interface JobToBeDoneCardSpec {
  readonly id: string;
  readonly intentCategory: OperationalIntentKey;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  readonly ctaLabel: string;
  readonly stageStep: LifecycleStep;
}

export interface IntentRouteEntry {
  readonly href: string;
  readonly label: string;
  readonly description: string;
  readonly icon: NavItem["icon"];
  readonly moduleLabel: string;
  readonly stageStep: LifecycleStep;
  readonly intentCategory: OperationalIntentKey;
  readonly keywords: readonly string[];
}

export interface PaletteCommandItem extends NavItem {
  readonly keywords?: readonly string[];
  readonly moduleLabel?: string;
  readonly stageStep?: LifecycleStep;
  readonly stageLabel?: string;
  readonly intentCategory?: OperationalIntentKey;
}

/**
 * DESIGN.md Law 2 — The 4 Canonical Operational Intents
 * plus 6 concrete Job-to-be-Done launcher cards for "Bugün ne yapmak istiyorsunuz?".
 */
export const OPERATIONAL_INTENTS: readonly OperationalIntentSpec[] = [
  {
    key: "ingest_reconcile",
    stepBadge: "01",
    shortLabel: "Veri & Mutabakat",
    label: "Veri Yükle & Doğrula",
    subtitle: "Excel, açık bankacılık, e-Fatura UBL ve 4-yönlü TDHP mizan mutabakatı",
    primaryHref: "/data/imports",
    secondaryHrefs: [
      { href: "/data/reconciliation", label: "4-Yönlü mutabakat" },
      { href: "/data/trial-balance-bridge", label: "Mizan köprüsü" },
      { href: "/data/integrations", label: "Entegrasyonlar" },
    ],
  },
  {
    key: "daily_cash_payables",
    stepBadge: "02",
    shortLabel: "Nakit & Ödeme",
    label: "Bugünkü Nakit & Ödemeyi Yönet",
    subtitle: "Günlük kasa bakiyesi, vadesi gelen ödemeler, tahsilat ve atölye icrası",
    primaryHref: "/payments",
    secondaryHrefs: [
      { href: "/finance/treasury", label: "Hazine & kasa" },
      { href: "/finance/collections", label: "Ödeme paketi (pain.001)" },
      { href: "/payments/missing", label: "Eksik tutarlar" },
    ],
  },
  {
    key: "portfolio_fx_covenants",
    stepBadge: "03",
    shortLabel: "Risk, Çek & Kredi",
    label: "Risk, Çek & Kredi İzle",
    subtitle: "Çek bordrosu, kredi limit/kovenant, kur pozisyonu, üretim OEE ve mizan defteri",
    primaryHref: "/finance/checks",
    secondaryHrefs: [
      { href: "/finance/facilities", label: "Limit & kovenant" },
      { href: "/finance/fx", label: "Kur riski" },
      { href: "/production", label: "Üretim & OEE" },
    ],
  },
  {
    key: "forecast_stress_brief",
    stepBadge: "04",
    shortLabel: "Tahmin & Rapor",
    label: "Geleceği Simüle Et & Raporla",
    subtitle: "13 haftalık nakit projeksiyonu, stres testi, CFO brifingi ve dönem kapanışı",
    primaryHref: "/cashflow/13-week",
    secondaryHrefs: [
      { href: "/scenarios", label: "Stres senaryosu" },
      { href: "/insights/briefing", label: "CFO brifingi" },
      { href: "/system/controls", label: "İç kontrol" },
    ],
  },
] as const;

export const JTBD_WORKFLOW_CARDS: readonly JobToBeDoneCardSpec[] = [
  {
    id: "jtbd-import-reconcile",
    intentCategory: "ingest_reconcile",
    eyebrow: "AŞAMA 1–2 · VERİ & GÜVEN",
    title: "Banka ekstresi, Excel veya e-Fatura yükle",
    description: "MT940/CAMT.053 ekstreleri, çalışma kitaplarını ve UBL faturaları içeri alıp alt-defterlerle eşleştirin.",
    href: "/data/imports",
    ctaLabel: "Aktarım merkezini aç",
    stageStep: 1,
  },
  {
    id: "jtbd-tdhp-mizan",
    intentCategory: "ingest_reconcile",
    eyebrow: "AŞAMA 2 · MUTABAKAT",
    title: "Alt-defterleri TDHP mizanıyla doğrula",
    description: "102 Banka, 101/103 Çek, 120/320 Cari ve 300 Kredi bakiyelerinin yasal mizan farklarını kapatın.",
    href: "/data/reconciliation",
    ctaLabel: "Mutabakat masasına git",
    stageStep: 2,
  },
  {
    id: "jtbd-daily-payables",
    intentCategory: "daily_cash_payables",
    eyebrow: "AŞAMA 3 · GÜNLÜK İCRA",
    title: "Bugünkü ödemeleri ve ödeme paketini icra et",
    description: "Geciken ve bugün vadesi dolan borçları önceliklendirin, eksik tutarları tamamlayın ve banka emri üretin.",
    href: "/payments",
    ctaLabel: "Ödeme radarını aç",
    stageStep: 3,
  },
  {
    id: "jtbd-checks-facilities",
    intentCategory: "portfolio_fx_covenants",
    eyebrow: "AŞAMA 3 · PORTFÖY & KOVENANT",
    title: "Çek bordrosu, kredi limiti ve kovenant izle",
    description: "Ciro/tahsil/karşılıksız çek geçişlerini, DSCR kovenant eşiklerini ve döviz açık pozisyonunu denetleyin.",
    href: "/finance/checks",
    ctaLabel: "Portföy masasını aç",
    stageStep: 3,
  },
  {
    id: "jtbd-13w-scenario",
    intentCategory: "forecast_stress_brief",
    eyebrow: "AŞAMA 4 · LİKİDİTE & STRES",
    title: "13 haftalık nakit açığını ve senaryoyu simüle et",
    description: "Haftalık minimum kasa darboğazını TRY/USD/EUR bazında görün ve tahsilat gecikmesi stres testi çalıştırın.",
    href: "/cashflow/13-week",
    ctaLabel: "13H tahmini incele",
    stageStep: 4,
  },
  {
    id: "jtbd-cfo-briefing",
    intentCategory: "forecast_stress_brief",
    eyebrow: "AŞAMA 5 · RAPOR & KAPANIŞ",
    title: "Kanıtlı CFO brifingi üret ve dönemi kilitle",
    description: "Kaynak hücre kanıtlı günlük/haftalık yönetim özetini oluşturun, iç kontrol uyarılarını kapatın.",
    href: "/insights/briefing",
    ctaLabel: "CFO brifingine git",
    stageStep: 5,
  },
] as const;

/**
 * Universal 80-entry route & operational workflow index across all 9 MAS modules.
 * Every entry carries rich Turkish financial, accounting (TDHP), banking, and manufacturing synonyms.
 */
export const INTENT_ROUTE_INDEX: readonly IntentRouteEntry[] = [
  // ── MODÜL 01: ANA EKRAN (Overview) ─────────────────────────────────────────
  {
    href: "/",
    label: "Genel Bakış (Ana Kokpit)",
    description: "Konsolide serbest nakit, 13H minimum kasa, işletme sermayesi ve kritik istisnalar",
    icon: "overview",
    moduleLabel: "Ana Ekran",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ana ekran", "kokpit", "özet", "bugün", "dashboard", "serbest nakit", "likidite", "runway", "ccc"],
  },

  // ── MODÜL 02: ÖDEMELER (Payments — 8 routes) ───────────────────────────────
  {
    href: "/payments",
    label: "Ödeme Radarı & Günlük Yük",
    description: "Geciken, bugün ve 7 gün içinde vadesi gelen ödemeler ve nakit çıkış baskısı",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ödeme", "radar", "vade", "bugün ödenecek", "geciken", "çıkış", "borç ödeme", "tedarikçi ödeme"],
  },
  {
    href: "/payments/new",
    label: "Yeni Ödeme Kalemi Ekle",
    description: "Tek seferlik veya düzenli kira, vergi, maaş, abonelik ve tedarikçi ödemesi tanımla",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["yeni ödeme", "ödeme ekle", "ödeme oluştur", "kira", "maaş", "fatura ödeme kaydı"],
  },
  {
    href: "/payments/calendar",
    label: "Ödeme Takvimi",
    description: "Gün bazlı ödeme yoğunluğu, maaş/vergi/SGK günleri ve aylık vade dağılımı",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ödeme takvimi", "takvim", "aylık vade", "ödeme günü", "yoğun günler"],
  },
  {
    href: "/payments/items",
    label: "Ödeme Kalemleri & Sözleşmeler",
    description: "Tüm aktif düzenli ödeme tanımları, kısmi ödeme ve kategori filtreleri",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ödeme kalemleri", "düzenli ödemeler", "sözleşme", "abonelik", "kısmi ödeme", "ödendi"],
  },
  {
    href: "/payments/missing",
    label: "Eksik Tutarlı Ödemeler (TUTAR EKSİK)",
    description: "Tutarı henüz netleşmemiş açık ödeme örneklerini tamamlayın (asla 0 TL varsayılmaz)",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["eksik tutar", "tutar eksik", "belirsiz ödeme", "eksik veriler", "fatura bekleniyor"],
  },
  {
    href: "/payments/history",
    label: "Ödeme Geçmişi & Makbuz İzleri",
    description: "Tamamlanan ve iptal edilen ödemelerin tarih, tutar ve denetim geçmişi",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ödeme geçmişi", "ödendi listesi", "dekont", "makbuz", "geçmiş ödemeler"],
  },
  {
    href: "/payments/archive",
    label: "Ödeme Arşivi & Geri Yükleme",
    description: "Arşivlenmiş ödeme şablonlarını inceleyin ve denetim iziyle geri yükleyin",
    icon: "payments",
    moduleLabel: "Ödemeler",
    stageStep: 5,
    intentCategory: "ingest_reconcile",
    keywords: ["ödeme arşivi", "arşiv geri yükle", "silinen ödemeler", "pasif ödemeler"],
  },

  // ── MODÜL 03: NAKİT AKIŞI (Cashflow — 11 routes & views) ───────────────────
  {
    href: "/cashflow",
    label: "Nakit Akışı Özeti & Runway",
    description: "Aylık nakit köprüsü, açılış/kapanış projeksiyonu ve nakit pisti (runway)",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["nakit akışı", "cashflow", "runway", "pist", "nakit köprüsü", "açılış kapanış"],
  },
  {
    href: "/cashflow/monthly",
    label: "Aylık Nakit Görünümü",
    description: "Ay bazında tahsilat girişleri, ödeme çıkışları ve net nakit hareketi detayı",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["aylık nakit", "aylık görünüm", "gelir gider tablosu", "aylık kapanış"],
  },
  {
    href: "/cashflow/13-week",
    label: "13 Haftalık Nakit Tahmini (Rolling 13W)",
    description: "Haftalık doğrudan nakit tahmini, minimum kasa eşiği ve dondurulmuş snapshot varyansı",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["13 hafta", "13h", "rolling 13w", "haftalık tahmin", "likidite tahmini", "minimum kasa", "dbt"],
  },
  {
    href: "/cashflow/13-week?currency=USD",
    label: "13H Nakit Tahmini · USD Döviz Masası",
    description: "ABD Doları (USD) bazlı 13 haftalık doğrudan tahsilat ve ödeme projeksiyonu",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["13h usd", "dolar nakit tahmini", "usd likidite", "döviz projeksiyon"],
  },
  {
    href: "/cashflow/13-week?currency=EUR",
    label: "13H Nakit Tahmini · EUR Döviz Masası",
    description: "Euro (EUR) bazlı 13 haftalık doğrudan tahsilat ve ödeme projeksiyonu",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["13h eur", "euro nakit tahmini", "eur likidite", "avro projeksiyon"],
  },
  {
    href: "/cashflow/13-week?currency=CONSOLIDATED",
    label: "13H Nakit Tahmini · Konsolide (TCMB Kur Çevrimli)",
    description: "Açık kur etiketiyle TRY + USD + EUR konsolide 13 haftalık grup likidite görünümü",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["konsolide nakit", "grup likidite", "13h konsolide", "çoklu para birimi"],
  },
  {
    href: "/cashflow/budget",
    label: "Bütçe & Tahmin Varyans Köprüsü",
    description: "Maker-checker onaylı bütçe versiyonları ve gerçekleşen vs bütçe sapma analizi",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["bütçe", "budget", "gerçekleşen", "varyans", "sapma", "tahmin versiyonu", "bütçe onayı"],
  },
  {
    href: "/cashflow/concentration",
    label: "Nakit & Karşı Taraf Yoğunlaşma Riski",
    description: "Tek müşteri, tek tedarikçi veya tek banka bağımlılığı ve HHI konsantrasyon analizi",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 4,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["yoğunlaşma", "konsantrasyon", "bağımlılık", "müşteri riski", "tedarikçi riski"],
  },
  {
    href: "/cashflow/controls",
    label: "Nakit Akışı Veri Kontrolleri",
    description: "Açılış-kapanış sürekliliği, mükerrer satır ve negatif bakiye bütünlük kontrolleri",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["nakit kontrol", "veri kontrolleri", "süreklilik", "açılış kapanış farkı"],
  },
  {
    href: "/cashflow/close",
    label: "Dönem Kapanışı & Kilit Yönetimi",
    description: "Muhasebe ve nakit dönemini parmak iziyle kilitleyin veya gerekçeli yeniden açın",
    icon: "cashflow",
    moduleLabel: "Nakit Akışı",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["kapanış", "dönem kapanışı", "dönem kilitle", "ay sonu kapanış", "period lock", "kilidi aç"],
  },

  // ── MODÜL 04: FİNANSMAN & HAZİNE (Finance — 23 routes & views) ─────────────
  {
    href: "/finance",
    label: "Finansman & Hazine Özeti",
    description: "Banka, kasa, alacak/borç, çek/senet, kredi limitleri ve yönetim defteri panoraması",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["finansman", "hazine özeti", "portföy", "finans merkezi"],
  },
  {
    href: "/finance/treasury",
    label: "Hazine & Likidite Masası",
    description: "TRY/USD/EUR serbest nakit, vadeli mevduat dönüşleri, bankalar arası virman ve likidite tamponu",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["hazine", "kasa", "vadeli mevduat", "virman", "repo", "likidite", "100 kasa", "102 banka"],
  },
  {
    href: "/finance/bank",
    label: "Banka Hesapları & Ekstre Eşleştirme",
    description: "MT940, CAMT.053, pain.002 banka hareketleri, otomatik eşleştirici ve 500.99 açılış bakiyesi",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["banka", "ekstre", "mt940", "camt.053", "pain.002", "açık bankacılık", "iban", "banka mutabakatı", "500.99"],
  },
  {
    href: "/finance/fx",
    label: "Kur Riski & Döviz Pozisyonu",
    description: "TCMB günlük kurlar, net döviz açık pozisyonu, kur hassasiyet ve değerleme analizi",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["kur", "kur riski", "döviz", "fx", "tcmb", "açık pozisyon", "hedge", "dolar", "euro", "kambiyo"],
  },
  {
    href: "/finance/calendar",
    label: "Finansal Takvim (POS · Kart · Vergi/SGK)",
    description: "POS bloke/valör çözülme takvimi, kurumsal kredi kartı kesim ve bordro/SGK/vergi tahakkukları",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["finansal takvim", "pos", "pos valör", "kredi kartı", "sgk", "muhtasar", "kdv", "vergi", "bordro tahakkuk"],
  },
  {
    href: "/finance/invoices",
    label: "Faturalar & e-Fatura (UBL-TR)",
    description: "Satış ve alış faturaları, taslak onayı, UBL-TR e-Fatura/e-Arşiv ve tahsilat/ödeme kaydı",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["fatura", "faturalar", "efatura", "e-fatura", "e-arşiv", "ubl", "satış faturası", "alış faturası"],
  },
  {
    href: "/finance/receivables",
    label: "Alacak / Borç Yaşlandırma & FIFO Dağıtım",
    description: "120 Alıcılar ve 320 Satıcılar vade yaşlandırma dilimleri, FIFO tahsilat dağıtımı ve DSO/DPO",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["alacak", "borç", "yaşlandırma", "fifo", "120", "320", "cari bakiye", "dso", "dpo", "tahsisat"],
  },
  {
    href: "/finance/collections",
    label: "Tahsilat Riski & Ödeme Paketi (pain.001)",
    description: "Toplu ödeme paketi (payment run), ISO 20022 pain.001 XML / banka CSV ihracı ve şüpheli alacak",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["tahsilat", "ödeme paketi", "payment run", "pain.001", "garanti", "işbank", "akbank", "yapı kredi", "şüpheli alacak"],
  },
  {
    href: "/finance/promises",
    label: "Ödeme Sözleri & Kırılan Söz Takibi",
    description: "Müşteri tahsilat sözleri, vadesi geçen kırılan söz tespiti ve güvenilirlik skoru",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["ödeme sözü", "tahsilat sözü", "kırılan söz", "vade sözü", "müşteri arama"],
  },
  {
    href: "/finance/counterparties",
    label: "Karşı Taraflar, Cari Ekstre & Grup İçi",
    description: "Müşteri/tedarikçi kartları, IBAN değişiklik denetimi, cari ekstre, grup içi cari ve boyutlar",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["karşı taraf", "cari", "cari ekstre", "müşteri", "tedarikçi", "iban", "vkn", "grup içi", "eliminasyon", "masraf merkezi", "proje"],
  },
  {
    href: "/finance/checks",
    label: "Çek & Senet Portföyü (Bordro & Ciro)",
    description: "Alınan ve verilen çekler, bordro geçişi, ciro, banka tahsil/teminat ve karşılıksız çek takibi",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["çek", "senet", "bordro", "ciro", "karşılıksız", "tahsil", "teminata çıkış", "101", "103", "keşideci"],
  },
  {
    href: "/finance/checks/new",
    label: "Yeni Çek / Senet Kaydı",
    description: "Portföye yeni müşteri çeki veya tedarikçiye verilen çek/senet ekle",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["yeni çek", "çek ekle", "çek girişi", "senet ekle", "çek kaydet"],
  },
  {
    href: "/finance/loans",
    label: "Krediler & Taksit Planları",
    description: "Spot, rotatif ve taksitli ticari krediler, anapara/faiz/BSMV/KKDF ödeme planı",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["kredi", "krediler", "taksit", "anapara", "faiz", "bsmv", "kkdf", "rotatif", "spot kredi", "300", "400"],
  },
  {
    href: "/finance/loans/new",
    label: "Yeni Kredi & Taksit Planı Oluştur",
    description: "Banka kredisi kullanımı ve otomatik itfa/taksit tablosu hesaplama",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["yeni kredi", "kredi ekle", "kredi hesaplama", "itfa planı oluştur"],
  },
  {
    href: "/finance/facilities",
    label: "Kredi Limitleri, Teminat & Kovenant (DSCR)",
    description: "Genel kredi sözleşmeleri (GKS), limit boşluğu, ipotek/kefalet/teminat mektubu ve DSCR kovenantlar",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["kredi limiti", "limit boşluğu", "drawdown", "teminat", "teminat mektubu", "ipotek", "rehin", "kefalet", "kovenant", "dscr"],
  },
  {
    href: "/finance/maturities",
    label: "Portföy Vade Takvimi",
    description: "Çek, kredi taksiti, vadeli mevduat ve açık fatura vadelerinin birleşik takvimi",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["vade takvimi", "portföy vade", "çek vadesi", "taksit vadesi", "itfa takvimi"],
  },
  {
    href: "/finance/exposure",
    label: "Banka & Karşı Taraf Maruziyeti",
    description: "Banka bazlı kredi/mevduat/teminat dağılımı ve karşı taraf net risk maruziyeti",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["maruziyet", "exposure", "risk limiti", "banka riski", "karşı taraf riski"],
  },
  {
    href: "/finance/ledger",
    label: "TDHP Yönetim Defteri & Yevmiye Fişleri",
    description: "Tek Düzen Hesap Planı (TDHP) yevmiye fişleri, tahakkuk, ters kayıt (storno), kur değerleme ve grup içi eliminasyon",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["yönetim defteri", "tdhp", "yevmiye", "muhasebe fişi", "tahakkuk", "storno", "ters kayıt", "eliminasyon", "grup içi", "kur değerleme"],
  },
  {
    href: "/finance/profitability",
    label: "Boyutsal Kârlılık & Maliyet Dağıtımı",
    description: "Müşteri, proje, departman ve masraf merkezi bazında gelir, gider ve net katkı marjı",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["kârlılık", "boyutsal kârlılık", "maliyet dağıtımı", "proje kârlılığı", "müşteri marjı", "ebitda"],
  },
  {
    href: "/finance/archive",
    label: "Finansman Arşivi",
    description: "Arşivlenen fatura, çek ve kredi kayıtlarının denetimli görünümü",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 5,
    intentCategory: "ingest_reconcile",
    keywords: ["finans arşivi", "arşivlenen çekler", "arşivlenen faturalar", "arşivlenen krediler"],
  },
  {
    href: "/finance/archive?entity=checks",
    label: "Finansman Arşivi · Çek Kayıtları",
    description: "Arşivlenmiş çek ve senet kayıtlarını filtrele ve geri yükle",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 5,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["çek arşivi", "iptal çekler", "arşiv çek"],
  },
  {
    href: "/finance/archive?entity=invoices",
    label: "Finansman Arşivi · Fatura Kayıtları",
    description: "Arşivlenmiş alış ve satış faturalarını incele",
    icon: "finance",
    moduleLabel: "Finansman",
    stageStep: 5,
    intentCategory: "ingest_reconcile",
    keywords: ["fatura arşivi", "arşiv fatura"],
  },

  // ── MODÜL 05: ÜRETİM EKONOMİSİ & ATÖLYE (Production — 12 routes & views) ───
  {
    href: "/production",
    label: "Üretim Ekonomisi & Tesis OEE Özeti",
    description: "Canlı tesis OEE, başabaş dakika maliyeti (TL/dk), stok devir hızı (DIO) ve üretim marjı",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["üretim", "atölye", "fabrika", "oee", "başabaş", "dakika maliyeti", "cnc", "imalat"],
  },
  {
    href: "/production/capacity",
    label: "Kapasite, Vardiya & Darboğaz Modeli",
    description: "Normal mesai ve fazla mesai tezgâh kapasitesi, kullanılabilir dakika ve darboğaz analizi",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["kapasite", "vardiya", "darboğaz", "fazla mesai", "tezgah saati", "doluluk oranı"],
  },
  {
    href: "/production/capacity?mode=overtime",
    label: "Kapasite Modeli · Fazla Mesai Simülasyonu",
    description: "Fazla mesai vardiyasında ek dakika kapasitesi ve birim maliyet etkisi",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["fazla mesai", "mesai kapasite", "ek vardiya"],
  },
  {
    href: "/production/costs",
    label: "Dakika Maliyeti, Başabaş & Parça Maliyetleri",
    description: "710/720/730 üretim giderleri, TL/dk başabaş tarifesi, katalog ürünleri ve parça süreleri",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["üretim maliyeti", "başabaş", "tl/dk", "dakika tarifesi", "710", "720", "730", "sabit maliyet", "birim maliyet"],
  },
  {
    href: "/production/profitability",
    label: "Parça & Sipariş Kârlılığı",
    description: "Parça bazında satış fiyatı vs tam üretim maliyeti, negatif marjlı parça uyarıları",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["parça kârlılığı", "ürün marjı", "zarar eden parçalar", "katkı payı", "sipariş marjı"],
  },
  {
    href: "/production/roi",
    label: "Makine Yatırımı & Yıllık ROI",
    description: "CNC/tezgâh yatırım tutarı, amortisman, geri dönüş süresi (payback) ve yıllık ROI analizi",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["makine roi", "yatırım geri dönüş", "amortisman", "capex", "yeni makine", "payback"],
  },
  {
    href: "/production/kiosk",
    label: "Atölye Kiosk & İş Emri QR İstasyonu",
    description: "Saha operatörü için CNC iş emri QR/barkod kartları, hızlı başla/bitir, fire ve duruş girişi",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["kiosk", "barkod", "qr", "atölye ekranı", "saha operatörü", "cnc iş emri", "fire girişi", "duruş kaydı"],
  },
  {
    href: "/production?tab=stations",
    label: "Üretim · İş İstasyonları & Tezgâh OEE",
    description: "CNC tezgâh ve iş merkezi bazında kullanılabilirlik, performans, kalite ve OEE takibi",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["iş istasyonu", "tezgah", "oee", "performans", "kalite", "cnc tezgah"],
  },
  {
    href: "/production?tab=inventory",
    label: "Üretim · TDHP Stok Kartları & DIO/CCC",
    description: "150 İlk Madde, 151 Yarı Mamul, 152 Mamul stok kartları, emniyet stoğu ve stokta kalma günü (DIO)",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["stok", "envanter", "150", "151", "152", "hammadde", "mamul", "dio", "stok devir"],
  },
  {
    href: "/production?tab=bom",
    label: "Üretim · Ürün Reçeteleri (BOM Ağacı)",
    description: "Çok seviyeli ürün reçetesi (BOM), fire oranı ve standart reçete maliyet kırılımı",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["reçete", "ürün reçetesi", "bom", "malzeme listesi", "standart maliyet"],
  },
  {
    href: "/production?tab=workorders",
    label: "Üretim · İş Emirleri, Fire & Duruş",
    description: "Aktif üretim iş emirleri, gerçekleşen süre, hurda/fire sapması ve maliyet farkı",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["iş emri", "iş emirleri", "work order", "fire", "hurda", "duruş", "üretim takibi"],
  },
  {
    href: "/production?tab=rates",
    label: "Üretim · Müşteri Tarifesi & Teklif Simülatörü",
    description: "Müşteri dakika tarifeleri (rate card) ve hedef marjlı hızlı parça teklif hesaplama",
    icon: "production",
    moduleLabel: "Üretim",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["teklif", "müşteri tarifesi", "fiyatlama", "rate card", "fason fiyat"],
  },

  // ── MODÜL 06: SENARYOLAR (Scenarios — 4 routes) ────────────────────────────
  {
    href: "/scenarios",
    label: "Stres Testi & What-If Senaryo Stüdyosu",
    description: "Tahsilat gecikmesi, kur şoku, gider artışı ve başabaş ufku (goal-seek) simülasyonu",
    icon: "scenarios",
    moduleLabel: "Senaryolar",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["senaryo", "stres testi", "what-if", "simülasyon", "kur şoku", "başabaş ufku", "goal seek"],
  },
  {
    href: "/scenarios/compare",
    label: "Senaryo Karşılaştırma (Baz vs Stres)",
    description: "İki farklı senaryo koşusunun kapanış nakdi, minimum kasa ve runway farklarını kıyasla",
    icon: "scenarios",
    moduleLabel: "Senaryolar",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["senaryo karşılaştır", "baz vs stres", "karşılaştırma", "fark analizi"],
  },
  {
    href: "/scenarios/history",
    label: "Senaryo Koşu Geçmişi",
    description: "Kaydedilmiş tüm what-if simülasyonlarının sonuçları ve varsayım izleri",
    icon: "scenarios",
    moduleLabel: "Senaryolar",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["senaryo geçmişi", "eski senaryolar", "simülasyon kayıtları"],
  },
  {
    href: "/scenarios/optimization",
    label: "Likidite & Ödeme Optimizasyon Çözücüsü",
    description: "Minimum kasa kısıtı altında ödeme erteleme, erken tahsilat ve kredi kullanım optimizasyonu",
    icon: "scenarios",
    moduleLabel: "Senaryolar",
    stageStep: 4,
    intentCategory: "forecast_stress_brief",
    keywords: ["optimizasyon", "çözücü", "lp", "nakit optimizasyonu", "finansman seçeneği"],
  },

  // ── MODÜL 07: İÇGÖRÜLER (Insights — 7 routes) ──────────────────────────────
  {
    href: "/insights",
    label: "İçgörüler Özeti",
    description: "Kanıtlı CFO içgörüleri, brifing, rapor ve aksiyon görevleri giriş ekranı",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["içgörüler", "analitik", "cfo özeti"],
  },
  {
    href: "/insights/ask",
    label: "Kanıtlı CFO Soru-Cevap",
    description: "Doğal dilde finansal sorular sorun; her yanıt kaynak tablo ve hücre kanıtıyla üretilir",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["soru cevap", "cfo asistan", "sor", "neden çıktı", "kanıtlı yanıt", "yapay zeka"],
  },
  {
    href: "/insights/briefing",
    label: "Günlük / Haftalık CFO Brifingi",
    description: "Yönetim kurulu ve CFO için nakit, risk, vade ve sapma özeti üretimi ve kanal dağıtımı",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["brifing", "cfo brifingi", "günlük özet", "yönetim raporu", "bülten"],
  },
  {
    href: "/insights/analysis",
    label: "Finansal Analiz Merkezi",
    description: "Çok dönemli trendler, rasyolar, işletme sermayesi ve anomali göstergeleri",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["analiz merkezi", "finansal analiz", "rasyo", "oran analizi", "trend"],
  },
  {
    href: "/insights/reports",
    label: "Rapor Üretimi & Dışa Aktarım",
    description: "Günlük, haftalık ve aylık kurumsal nakit/portföy raporları üretin ve kanallara iletin",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["rapor", "raporlar", "günlük rapor", "haftalık rapor", "aylık rapor", "pdf", "excel rapor"],
  },
  {
    href: "/insights/reminders",
    label: "Vade Hatırlatmaları & Bildirim Kuralları",
    description: "Ödeme, çek, kredi ve söz vadeleri için E-posta, Telegram, WhatsApp ve SMS bildirim kuralları",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["hatırlatma", "bildirim", "alarm", "uyarı", "whatsapp", "sms", "telegram", "eposta", "vade taraması"],
  },
  {
    href: "/insights/tasks",
    label: "Finansal Aksiyon Görevleri",
    description: "Mutabakat farkları, iç kontrol uyarıları ve CFO kararlarından açılan takip görevleri",
    icon: "insights",
    moduleLabel: "İçgörüler",
    stageStep: 3,
    intentCategory: "daily_cash_payables",
    keywords: ["görev", "görevler", "aksiyon", "iş listesi", "takip kuyruğu", "todo"],
  },

  // ── MODÜL 08: VERİ MERKEZİ (Data — 12 routes) ──────────────────────────────
  {
    href: "/data",
    label: "Veri Merkezi Girişi",
    description: "Veri yönetişimi, aktarım ve mutabakat merkezi yönlendirmesi",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["veri merkezi", "veri yönetişimi"],
  },
  {
    href: "/data/imports",
    label: "Excel Çalışma Kitabı İçe Aktarımları",
    description: "Nakit akışı, çek, kredi ve maliyet Excel dosyalarını hücre düzeyinde kanıtla içeri alın",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["excel", "içe aktarım", "yükle", "import", "çalışma kitabı", "xlsx", "veri yükle"],
  },
  {
    href: "/data/imports/v2",
    label: "Standart Şablon Aktarımı (V2 Önizlemeli)",
    description: "Şema doğrulamalı, kuru-koşu (dry-run) önizlemeli standart Excel aktarım sihirbazı",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["standart aktarım", "şablon", "v2 import", "önizleme", "excel şablonu"],
  },
  {
    href: "/data/integrations",
    label: "Entegrasyonlar (Açık Bankacılık · UBL · Paraşüt)",
    description: "TCMB kur, Paraşüt V4, UBL e-Fatura, açık bankacılık ve hibrit banka ekstresi tekilleştirme",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["entegrasyon", "açık bankacılık", "paraşüt", "ubl", "efatura", "hibrit ekstre", "api bağlantı", "senkron"],
  },
  {
    href: "/data/documents",
    label: "SHA-256 Belge Kasası & OCR Kanıt Arşivi",
    description: "Fatura PDF, dekont, sözleşme ve çek görsellerini içerik-adresli SHA-256 mühür ve OCR ile saklayın",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["belge", "doküman", "belge kasası", "ocr", "fatura pdf", "dekont", "sözleşme", "sha256", "kanıt dosyası"],
  },
  {
    href: "/data/quality",
    label: "Veri Sağlığı & Karar Güveni Skoru",
    description: "Eksik tutarlar, eşleşmemiş hareketler, tazelik durumu ve modül bazlı karar güveni endeksi",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["veri sağlığı", "veri kalitesi", "karar güveni", "tazelik", "eksik veri kontrolü"],
  },
  {
    href: "/data/reconciliation",
    label: "4-Yönlü Alt-Defter & Banka Mutabakatı",
    description: "Banka, çek, cari ve kredi alt-defterlerini yönetim defteriyle karşılaştırıp mutabakatı imzalayın",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["mutabakat", "4 yönlü mutabakat", "alt defter", "mutabakat imzala", "uzlaştırma", "bakiye farkı"],
  },
  {
    href: "/data/trial-balance-bridge",
    label: "Yasal Mizan Köprüsü (TDHP 100–799)",
    description: "Resmi muhasebe mizanını yükleyip operasyonel alt-defter ve TDHP yönetim defteriyle köprüleyin",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["mizan", "mizan köprüsü", "tdhp", "yasal mizan", "resmi muhasebe", "kebir", "hesap planı"],
  },
  {
    href: "/data/reviews",
    label: "İçe Aktarım İnceleme Kuyruğu",
    description: "Belirsiz Excel satırlarını, formül uyarılarını ve anomali adaylarını kabul/red/çözüm ile kapatın",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["inceleme kuyruğu", "aktarım inceleme", "şüpheli satır", "kabul", "çöz"],
  },
  {
    href: "/data/approvals",
    label: "Onay Kuyruğu (Maker-Checker Yönetişimi)",
    description: "Ödeme paketi, bütçe versiyonu ve yüksek tutarlı işlemler için çift göz onay merkezi",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 2,
    intentCategory: "ingest_reconcile",
    keywords: ["onay", "onay kuyruğu", "maker checker", "çift göz", "onayla", "revizyon", "yetki eşiği"],
  },
  {
    href: "/data/assumptions",
    label: "Dış & Makroekonomik Varsayımlar",
    description: "Senaryo ve bütçelerde kullanılan onaylı USD/EUR kuru, politika faizi ve enflasyon varsayımları",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "forecast_stress_brief",
    keywords: ["varsayım", "dış varsayımlar", "enflasyon", "politika faizi", "makro", "kur tahmini"],
  },
  {
    href: "/data/sources",
    label: "Kaynak Hücre & Kanıt Gezgini",
    description: "İçe aktarılan çalışma kitaplarının ham sekme, satır, hücre koordinatı ve formüllerini inceleyin",
    icon: "data",
    moduleLabel: "Veri Merkezi",
    stageStep: 1,
    intentCategory: "ingest_reconcile",
    keywords: ["kaynak gezgini", "hücre kanıtı", "sayfa1", "ham veri", "formül izi", "provenance"],
  },

  // ── MODÜL 09: SİSTEM & İÇ KONTROL (System — 10 routes) ─────────────────────
  {
    href: "/system",
    label: "Sistem Durumu & Süreklilik Özeti",
    description: "Çalışma zamanı sağlığı, veritabanı havuzu, son yedekleme ve telemetri göstergeleri",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["sistem", "durum", "sağlık", "telemetri", "sunucu"],
  },
  {
    href: "/system/backup",
    label: "Yedekleme, Geri Yükleme & Dış Disk Kasası",
    description: "Günlük şifreli PostgreSQL yedekleri, geri yükleme tatbikatı ve çevrimdışı disk doğrulaması",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["yedek", "yedekleme", "backup", "restore", "geri yükleme", "felaket kurtarma", "usb disk"],
  },
  {
    href: "/system/jobs",
    label: "Arka Plan İş Kuyruğu & Zamanlayıcı",
    description: "Asenkron rapor, senkron, kur çekimi ve büyük dışa aktarım kuyruğu yönetimi",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "ingest_reconcile",
    keywords: ["arka plan işleri", "kuyruk", "jobs", "worker", "zamanlayıcı", "asılı işler"],
  },
  {
    href: "/system/controls",
    label: "İç Kontrol Merkezi & Adli Anomali Denetimi",
    description: "Mükerrer fatura/ödeme, IBAN değişimi, Benford sapması, hafta sonu fişi ve görev ayrılığı uyarıları",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["iç kontrol", "kontrol merkezi", "adli", "benford", "anomali", "mükerrer ödeme", "suistimal", "uyum"],
  },
  {
    href: "/system/audit",
    label: "Değiştirilemez Denetim Kayıtları (Audit Trail)",
    description: "Kim, ne zaman, hangi kaydı değiştirdi — append-only veritabanı denetim izi",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["denetim", "denetim kayıtları", "audit log", "işlem geçmişi", "iz kaydı"],
  },
  {
    href: "/system/archive",
    label: "Merkezi Arşiv & Kayıt Kurtarma",
    description: "Tüm modüllerde arşivlenmiş kayıtları tek merkezden arayın ve yetkiyle geri yükleyin",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "ingest_reconcile",
    keywords: ["arşiv merkezi", "merkezi arşiv", "silinen kayıtlar", "kurtarma"],
  },
  {
    href: "/system/security",
    label: "Kullanıcılar, Roller, SSO/Passkey & Güvenlik",
    description: "5 katmanlı PostgreSQL RLS rolleri, kullanıcı yönetimi, aktif oturumlar, SSO/Passkey ve parola politikası",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["güvenlik", "kullanıcı", "rol", "yetki", "rls", "sso", "passkey", "oturum", "şifre sıfırla"],
  },
  {
    href: "/system/diagnostics",
    label: "Veritabanı & Çalışma Zamanı Tanılama",
    description: "Sorgu gecikmeleri, indeks sağlığı, RLS doğrulaması ve bağlantı havuzu tanılaması",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["tanılama", "diagnostics", "performans", "veritabanı sağlığı", "indeks"],
  },
  {
    href: "/system/features",
    label: "Faz & Özellik Haritası",
    description: "MAS Nakit Radar modül olgunluk düzeyi ve devreye alınan kurumsal yetenekler",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "forecast_stress_brief",
    keywords: ["özellik haritası", "fazlar", "sürüm", "yetenekler"],
  },
  {
    href: "/change-password",
    label: "Parola Değiştir & Kimlik Doğrulama",
    description: "Kendi oturum parolanızı güvenli Argon2id doğrulamasıyla güncelleyin",
    icon: "system",
    moduleLabel: "Sistem",
    stageStep: 5,
    intentCategory: "portfolio_fx_covenants",
    keywords: ["parola", "şifre değiştir", "parola güncelle", "kendi şifrem"],
  },
] as const;

export const INTENT_ROUTE_BY_HREF: ReadonlyMap<string, IntentRouteEntry> = new Map(
  INTENT_ROUTE_INDEX.map((entry) => [entry.href, entry]),
);

const TURKISH_ASCII_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  i: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/**
 * Normalizes Turkish text for instant, forgiving command-palette search:
 * both exact Turkish lowercase ("karşılıksız", "mizan", "başabaş") and ASCII-folded
 * keyboard input ("karsiliksiz", "basabas", "cek", "icgoru") match cleanly.
 */
export function normalizeTurkishSearch(value: string): { tr: string; ascii: string } {
  const tr = value.trim().toLocaleLowerCase("tr-TR");
  let ascii = "";
  for (const ch of tr) {
    ascii += TURKISH_ASCII_MAP[ch] ?? ch;
  }
  return { tr, ascii };
}

function stageLabelFor(step: LifecycleStep): string {
  return LIFECYCLE_STAGES[step - 1]?.shortLabel ?? `Aşama ${step}`;
}

/**
 * Builds the full role-filtered command palette item list (78+ routes & workflows)
 * from either an `AppRole` or a `(href: string) => boolean` predicate.
 */
export function buildCommandPaletteItems(
  access: AppRole | ((href: string) => boolean),
): PaletteCommandItem[] {
  const allow =
    typeof access === "function"
      ? access
      : (href: string) => {
          const cleanHref = href.split("?")[0] || "/";
          return canSeeRoute(access, cleanHref);
        };

  return INTENT_ROUTE_INDEX.filter((entry) => {
    const cleanHref = entry.href.split("?")[0] || "/";
    return allow(cleanHref);
  }).map((entry) => ({
    href: entry.href,
    label: entry.label,
    description: entry.description,
    icon: entry.icon,
    moduleLabel: entry.moduleLabel,
    stageStep: entry.stageStep,
    stageLabel: stageLabelFor(entry.stageStep),
    intentCategory: entry.intentCategory,
    keywords: entry.keywords,
  }));
}

/**
 * Restricted routes that require explicit role grants in `ROUTE_MIN_TIER`.
 * When `CommandPalette` receives a minimal legacy `items` array (before layout wiring),
 * it enriches passed items AND safely expands visible module sub-routes while never
 * exposing restricted routes unless the caller explicitly included that module/route.
 */
const RESTRICTED_SUBROUTES = new Set<string>([
  "/system/backup",
  "/system/security",
  "/system/diagnostics",
  "/data/approvals",
  "/data/imports/v2",
  "/data/integrations",
  "/data/trial-balance-bridge",
]);

export function enrichAndExpandPaletteItems(
  items: readonly (NavItem & Partial<PaletteCommandItem>)[],
): PaletteCommandItem[] {
  if (items.length === 0) return [];

  const seen = new Set<string>();
  const result: PaletteCommandItem[] = [];

  const allowedIcons = new Set<NavItem["icon"]>();
  const explicitHrefs = new Set<string>();

  for (const item of items) {
    allowedIcons.add(item.icon);
    explicitHrefs.add(item.href);
  }

  for (const item of items) {
    const cleanHref = item.href.split("?")[0] || "/";
    const indexed = INTENT_ROUTE_BY_HREF.get(item.href) ?? INTENT_ROUTE_BY_HREF.get(cleanHref);
    seen.add(item.href);
    result.push({
      ...item,
      description: item.description ?? indexed?.description ?? "Çalışma alanına git",
      moduleLabel: item.moduleLabel ?? indexed?.moduleLabel,
      stageStep: item.stageStep ?? indexed?.stageStep,
      stageLabel:
        item.stageLabel ?? (indexed ? stageLabelFor(indexed.stageStep) : undefined),
      intentCategory: item.intentCategory ?? indexed?.intentCategory,
      keywords: item.keywords ?? indexed?.keywords ?? [],
    });
  }

  // Auto-merge sub-routes belonging to modules already granted in `items`
  // (excluding tier-gated admin/approver routes unless explicitly passed).
  for (const entry of INTENT_ROUTE_INDEX) {
    if (seen.has(entry.href)) continue;
    const cleanHref = entry.href.split("?")[0] || "/";
    if (cleanHref === "/change-password") {
      seen.add(entry.href);
      result.push({
        href: entry.href,
        label: entry.label,
        description: entry.description,
        icon: entry.icon,
        moduleLabel: entry.moduleLabel,
        stageStep: entry.stageStep,
        stageLabel: stageLabelFor(entry.stageStep),
        intentCategory: entry.intentCategory,
        keywords: entry.keywords,
      });
      continue;
    }
    if (!allowedIcons.has(entry.icon)) continue;
    if (RESTRICTED_SUBROUTES.has(cleanHref) && !explicitHrefs.has(cleanHref)) continue;

    seen.add(entry.href);
    result.push({
      href: entry.href,
      label: entry.label,
      description: entry.description,
      icon: entry.icon,
      moduleLabel: entry.moduleLabel,
      stageStep: entry.stageStep,
      stageLabel: stageLabelFor(entry.stageStep),
      intentCategory: entry.intentCategory,
      keywords: entry.keywords,
    });
  }

  return result;
}
