export const EDITORIAL_LINEN_TEXTURE = "/textures/editorial-linen-cream.webp" as const;

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
    artworkSrc: "/modules/overview-cream.webp",
    quickActions: [
      { href: "/payments", label: "Ödeme radarı" },
      { href: "/cashflow", label: "Nakit projeksiyonu" },
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
    artworkSrc: "/modules/payments-cream.webp",
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
    artworkSrc: "/modules/cashflow-cream.webp",
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
    artworkSrc: "/modules/finance-cream.webp",
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
    artworkSrc: "/modules/production-cream.webp",
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
    artworkSrc: "/modules/scenarios-cream.webp",
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
    artworkSrc: "/modules/insights-cream.webp",
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
    artworkSrc: "/modules/data-cream.webp",
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
    artworkSrc: "/modules/system-cream.webp",
    quickActions: [
      { href: "/system/controls", label: "Kontrol merkezi" },
      { href: "/system/audit", label: "Denetim kayıtları" },
    ],
  },
};

const ORDERED_MODULES: readonly ModuleFramingSpec[] = Object.values(MODULE_FRAMING);

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
