export const EDITORIAL_LINEN_TEXTURE = "/textures/editorial-linen-cream.webp" as const;
export const ARCHIVAL_PARCHMENT_TILE = "/textures/archival-parchment-tile.webp" as const;

export type CanonicalModuleKey =
  | "overview"
  | "payments"
  | "cashflow"
  | "finance"
  | "production"
  | "scenarios"
  | "insights"
  | "data"
  | "system";

export type LifecycleStep = 1 | 2 | 3 | 4 | 5;

export interface LifecycleStageSpec {
  readonly step: LifecycleStep;
  readonly shortLabel: string;
  readonly label: string;
  readonly href: string;
  readonly description: string;
}

export const LIFECYCLE_STAGES: readonly LifecycleStageSpec[] = [
  {
    step: 1,
    shortLabel: "1 · Veri Girişi",
    label: "Veri Girişi & İçe Aktarım",
    href: "/data/imports",
    description: "Excel çalışma kitabı, banka ekstresi, e-Fatura ve açık bankacılık akışlarını içeri alın.",
  },
  {
    step: 2,
    shortLabel: "2 · Mutabakat & Güven",
    label: "Mutabakat & Karar Güveni",
    href: "/data/reconciliation",
    description: "4-yönlü alt-defter bakiyelerini TDHP yönetim defteri, yasal mizan ve inceleme kuyruğuyla doğrulayın.",
  },
  {
    step: 3,
    shortLabel: "3 · Günlük Nakit & İcra",
    label: "Günlük Nakit & Ödeme İcrası",
    href: "/payments",
    description: "Bugünkü serbest nakit, ödeme vadeleri, çek/kredi portföyü ve üretim ekonomisini yönetin.",
  },
  {
    step: 4,
    shortLabel: "4 · 13H Tahmin & Senaryo",
    label: "13H Projeksiyon & Stres Senaryosu",
    href: "/cashflow/13-week",
    description: "13 haftalık nakit dar boğazlarını, döviz likiditesini ve stres senaryolarını simüle edin.",
  },
  {
    step: 5,
    shortLabel: "5 · CFO Raporu & Kontrol",
    label: "CFO Raporu & Dönem Kapanışı",
    href: "/insights/briefing",
    description: "Kanıtlı CFO brifingi, iç kontrol denetimi ve dönem kapanışı güvencesini tamamlayın.",
  },
] as const;

export interface ModuleQuickAction {
  readonly href: string;
  readonly label: string;
}

export interface ModuleFramingSpec {
  readonly key: CanonicalModuleKey;
  readonly folioCode: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly rootHref: string;
  readonly prefixes: readonly string[];
  readonly artworkSrc: string;
  readonly lifecycleStage: LifecycleStep;
  readonly lifecycleLabel: string;
  readonly quickActions: readonly ModuleQuickAction[];
}

export const MODULE_FRAMING: Record<CanonicalModuleKey, ModuleFramingSpec> = {
  overview: {
    key: "overview",
    folioCode: "MODÜL 01",
    eyebrow: "Operatör Kokpiti",
    title: "Ana Ekran",
    rootHref: "/",
    prefixes: ["/overview"],
    artworkSrc: "/visuals/treasury-ledger-hero.webp",
    lifecycleStage: 3,
    lifecycleLabel: "Günlük Nakit & Kokpit",
    quickActions: [
      { href: "/payments", label: "Ödeme radarı" },
      { href: "/cashflow/13-week", label: "13H nakit tahmini" },
      { href: "/finance", label: "Hazine özeti" },
    ],
  },
  payments: {
    key: "payments",
    folioCode: "MODÜL 02",
    eyebrow: "Ödeme Operasyonları",
    title: "Ödemeler",
    rootHref: "/payments",
    prefixes: ["/payments", "/radar", "/calendar"],
    artworkSrc: "/visuals/payments-radar-hero.webp",
    lifecycleStage: 3,
    lifecycleLabel: "Günlük Ödeme İcrası",
    quickActions: [
      { href: "/payments/new", label: "Yeni ödeme ekle" },
      { href: "/payments/calendar", label: "Ödeme takvimi" },
    ],
  },
  cashflow: {
    key: "cashflow",
    folioCode: "MODÜL 03",
    eyebrow: "Likidite & Projeksiyon",
    title: "Nakit Akışı",
    rootHref: "/cashflow",
    prefixes: ["/cashflow"],
    artworkSrc: "/visuals/cashflow-locks-hero.webp",
    lifecycleStage: 4,
    lifecycleLabel: "13H Projeksiyon & Likidite",
    quickActions: [
      { href: "/cashflow/13-week", label: "13 haftalık tahmin" },
      { href: "/scenarios", label: "Senaryoda dene" },
    ],
  },
  finance: {
    key: "finance",
    folioCode: "MODÜL 04",
    eyebrow: "Hazine & Finansman",
    title: "Finansman",
    rootHref: "/finance",
    prefixes: ["/finance", "/financing"],
    artworkSrc: "/visuals/finance-vault-hero.webp",
    lifecycleStage: 3,
    lifecycleLabel: "Hazine, Portföy & Defter",
    quickActions: [
      { href: "/finance/checks/new", label: "Yeni çek" },
      { href: "/finance/loans/new", label: "Yeni kredi" },
    ],
  },
  production: {
    key: "production",
    folioCode: "MODÜL 05",
    eyebrow: "Üretim Ekonomisi",
    title: "Üretim",
    rootHref: "/production",
    prefixes: ["/production"],
    artworkSrc: "/visuals/precision-production-hero.webp",
    lifecycleStage: 3,
    lifecycleLabel: "Üretim Ekonomisi & Atölye",
    quickActions: [
      { href: "/production/capacity", label: "Kapasite modeli" },
      { href: "/production/profitability", label: "Parça kârlılığı" },
    ],
  },
  scenarios: {
    key: "scenarios",
    folioCode: "MODÜL 06",
    eyebrow: "Karar Simülasyonu",
    title: "Senaryolar",
    rootHref: "/scenarios",
    prefixes: ["/scenarios"],
    artworkSrc: "/visuals/scenarios-armillary-hero.webp",
    lifecycleStage: 4,
    lifecycleLabel: "Stres Testi & Karar Simülasyonu",
    quickActions: [
      { href: "/scenarios", label: "Yeni senaryo" },
      { href: "/scenarios/compare", label: "Karşılaştırma" },
    ],
  },
  insights: {
    key: "insights",
    folioCode: "MODÜL 07",
    eyebrow: "Kanıtlı İçgörüler",
    title: "İçgörüler",
    rootHref: "/insights/ask",
    prefixes: ["/insights", "/ask", "/reports", "/reminders"],
    artworkSrc: "/visuals/insights-prism-hero.webp",
    lifecycleStage: 5,
    lifecycleLabel: "CFO Brifingi & Raporlama",
    quickActions: [
      { href: "/insights/reports", label: "Rapor oluştur" },
      { href: "/insights/briefing", label: "CFO brifingi" },
    ],
  },
  data: {
    key: "data",
    folioCode: "MODÜL 08",
    eyebrow: "Veri Yönetişimi",
    title: "Veri Merkezi",
    rootHref: "/data/quality",
    prefixes: ["/data", "/imports", "/data-quality", "/assumptions"],
    artworkSrc: "/visuals/data-archive-hero.webp",
    lifecycleStage: 1,
    lifecycleLabel: "Veri Girişi & Mutabakat",
    quickActions: [
      { href: "/data/imports", label: "Excel yükle" },
      { href: "/data/reconciliation", label: "Mutabakat" },
    ],
  },
  system: {
    key: "system",
    folioCode: "MODÜL 09",
    eyebrow: "Platform & Denetim",
    title: "Sistem",
    rootHref: "/system",
    prefixes: ["/system", "/admin", "/phases"],
    artworkSrc: "/visuals/internal-controls-hero.webp",
    lifecycleStage: 5,
    lifecycleLabel: "İç Kontrol & Dönem Güvencesi",
    quickActions: [
      { href: "/system/controls", label: "Kontrol merkezi" },
      { href: "/system/audit", label: "Denetim kayıtları" },
    ],
  },
};

const ORDERED_MODULES: readonly ModuleFramingSpec[] = Object.values(MODULE_FRAMING);

const STAGE_2_PREFIXES = [
  "/data/reconciliation",
  "/data/quality",
  "/data/reviews",
  "/data/approvals",
  "/data/trial-balance-bridge",
  "/data-quality",
  "/cashflow/controls",
] as const;

const STAGE_5_PREFIXES = [
  "/cashflow/close",
] as const;

function matchPathToModule(pathValue: string | null | undefined): ModuleFramingSpec | null {
  if (!pathValue) return null;
  const clean = pathValue.split("?")[0] || "/";
  if (clean === "/") return MODULE_FRAMING.overview;
  for (const spec of ORDERED_MODULES) {
    for (const prefix of spec.prefixes) {
      if (clean === prefix || clean.startsWith(`${prefix}/`)) {
        return spec;
      }
    }
  }
  return null;
}

export function resolveLifecycleStage(pathname: string | null | undefined): LifecycleStageSpec {
  const clean = (pathname ?? "/").split("?")[0] || "/";
  for (const prefix of STAGE_2_PREFIXES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return LIFECYCLE_STAGES[1];
    }
  }
  for (const prefix of STAGE_5_PREFIXES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return LIFECYCLE_STAGES[4];
    }
  }
  const moduleSpec = matchPathToModule(clean) ?? MODULE_FRAMING.overview;
  return LIFECYCLE_STAGES[moduleSpec.lifecycleStage - 1];
}

export function resolveModuleFraming(input: {
  pathname?: string | null;
  primaryTabHref?: string | null;
  title?: string | null;
}): ModuleFramingSpec {
  const fromTab = matchPathToModule(input.primaryTabHref);
  if (fromTab) return fromTab;

  const fromPath = matchPathToModule(input.pathname);
  if (fromPath) return fromPath;

  if (input.title) {
    const normalized = input.title.trim().toLocaleLowerCase("tr-TR");
    const fromTitle = ORDERED_MODULES.find(
      (spec) => spec.title.toLocaleLowerCase("tr-TR") === normalized,
    );
    if (fromTitle) return fromTitle;
  }

  return MODULE_FRAMING.overview;
}
