// HAND-MAINTAINED INVENTORY — NOT LIVE STATUS.
//
// This module is a curated map of "which capability lives at which route, and which gate
// proves it". Nothing here is measured at runtime: `implemented` and `uiVisible` are claims a
// human keeps in sync with the code, and `verifiedBy` names the gate script that actually
// exercises the feature.
//
// It deliberately no longer carries a `tested: boolean`. That field was hardcoded `true` for
// every row, which read on screen as a live test result while being nothing of the sort — a
// green badge that could never turn red is worse than no badge, because it invites trust it
// has not earned. Naming the gate instead is checkable: anyone can run it and see for
// themselves. `pnpm test` (vitest) plus the listed `pnpm <gate>` scripts are the real signal.
export interface FeatureState {
  id: string;
  title: string;
  implemented: boolean;
  uiVisible: boolean;
  /** Gate scripts that exercise this feature end-to-end. Run them to confirm the claim. */
  verifiedBy: string[];
  canonicalRoute: string;
}

export const FEATURE_REGISTRY: FeatureState[] = [
  { id: "01", title: "Kaynak veri haritası ve Excel ayrıştırma", implemented: true, uiVisible: true, verifiedBy: ["import:real", "phase3:verify"], canonicalRoute: "/data/imports" },
  { id: "02", title: "Ödeme radarı ve ödeme yönetimi", implemented: true, uiVisible: true, verifiedBy: ["phase3:verify"], canonicalRoute: "/payments" },
  { id: "03", title: "Nakit akışı ve projeksiyon", implemented: true, uiVisible: true, verifiedBy: ["phase4:verify"], canonicalRoute: "/cashflow" },
  { id: "04", title: "Çek, kredi ve vade yönetimi", implemented: true, uiVisible: true, verifiedBy: ["phase5:verify"], canonicalRoute: "/finance" },
  { id: "05", title: "Üretim kapasite ve maliyet", implemented: true, uiVisible: true, verifiedBy: ["phase7:verify", "phase9a:verify"], canonicalRoute: "/production" },
  { id: "06", title: "Makine ROI ve finansman tahsisi", implemented: true, uiVisible: true, verifiedBy: ["phase9c:verify", "phase9d:verify"], canonicalRoute: "/production/roi" },
  { id: "07", title: "Raporlar ve hatırlatmalar", implemented: true, uiVisible: true, verifiedBy: ["phase6:verify", "phase6b:verify"], canonicalRoute: "/insights/reports" },
  { id: "08", title: "AI soru-cevap ve rapor yorumu", implemented: true, uiVisible: true, verifiedBy: ["phase12a:verify"], canonicalRoute: "/insights/ask" },
  { id: "09", title: "Senaryo motoru", implemented: true, uiVisible: true, verifiedBy: ["phase8:verify"], canonicalRoute: "/scenarios" },
  { id: "10", title: "Senaryo v2 optimizasyon", implemented: true, uiVisible: true, verifiedBy: ["phase13a:verify", "phase13b:verify"], canonicalRoute: "/scenarios/optimization" },
  { id: "11", title: "Veri sağlığı ve karar güveni", implemented: true, uiVisible: true, verifiedBy: ["phase14a:verify", "phase14e:verify"], canonicalRoute: "/data/quality" },
  { id: "12", title: "İnceleme ve mutabakat", implemented: true, uiVisible: true, verifiedBy: ["phase3:verify", "phase14e:verify"], canonicalRoute: "/data/reviews" },
  { id: "13", title: "Dış varsayımlar", implemented: true, uiVisible: true, verifiedBy: ["phase14b:verify", "phase14d:verify"], canonicalRoute: "/data/assumptions" },
  { id: "14", title: "Aksiyon ve görev yönetimi", implemented: true, uiVisible: true, verifiedBy: ["phase14a:verify", "phase14c:verify"], canonicalRoute: "/insights/tasks" },
  { id: "15", title: "Kaynak kanıtı ve denetim izi", implemented: true, uiVisible: true, verifiedBy: ["phase14c:verify", "db:verify"], canonicalRoute: "/system/audit" },
];
