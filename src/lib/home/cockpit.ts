// Ana Ekran cockpit rules (UX & CFO Executive Pulse layer).
// Pure & deterministic — ranks ALREADY-COMPUTED signals into headline risk, action items,
// and the 11 Executive CFO Cockpit Cards with source-proof links.
// Null amount is disclosed as unknown ("—"), never fabricated as 0.

import type { ProofItem } from "@/components/facts/source-proof";

export interface CockpitFacts {
  todayKnownOutflow: number;
  todayCount: number;
  todayMissing: number;
  next7KnownOutflow: number;
  next7Count: number;
  overdueCount: number;
  overdueKnownOutflow: number;
  firstNegativeMonth: string | null; // YYYY-MM-01
  worstMonth: string | null;
  worstBalance: number | null;
  monthMissingCount: number;
  topConcentration: { key: string; ratio: number } | null;
  debtPressureMonths: number; // months where debt-service + negative cash
  failedReminders: number;
  staleProductionRate: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface CockpitAction {
  key: string;
  severity: Severity;
  label: string; // plain Turkish, decision-oriented
  href: string;
  reason: string;
  impact: string;
  evidenceHref: string;
  scenarioHref?: string;
}

const tl = (n: number) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";
const fmtDays = (n: number) =>
  new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 }).format(n) + " gün";
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");

/**
 * Deterministic action list. Every candidate is backed by an existing fact; only
 * triggered ones appear, sorted by severity then a fixed priority, capped at 5.
 */
export function buildActions(f: CockpitFacts): CockpitAction[] {
  const c: CockpitAction[] = [];

  if (f.overdueCount > 0)
    c.push({
      key: "overdue",
      severity: "critical",
      href: "/payments",
      label: `${f.overdueCount} geciken ödeme var — bugün kontrol et${f.overdueKnownOutflow > 0 ? ` (${tl(f.overdueKnownOutflow)})` : ""}.`,
      reason: "Geciken ödeme nakit çıkışını ve tedarik ilişkisini bugün etkiler.",
      impact: f.overdueKnownOutflow > 0 ? `Bilinen yük ${tl(f.overdueKnownOutflow)}.` : "Tutar kanıtı eksik; önce kaynağı aç.",
      evidenceHref: "/payments",
    });

  if (f.todayCount > 0)
    c.push({
      key: "today",
      severity: "high",
      href: "/payments",
      label: `Bugün ${f.todayCount} ödeme${f.todayKnownOutflow > 0 ? ` — ${tl(f.todayKnownOutflow)} nakit hazırla` : ""}.`,
      reason: "Bugünün ödemesi operasyonel aksiyondur; bekletme kararı bilinçli olmalıdır.",
      impact: f.todayKnownOutflow > 0 ? `Bugün bilinen çıkış ${tl(f.todayKnownOutflow)}.` : "Bugün ödeme var ama tutar kanıtı eksik.",
      evidenceHref: "/payments",
    });

  if (f.next7KnownOutflow > 0)
    c.push({
      key: "next7",
      severity: "medium",
      href: "/payments",
      label: `Önümüzdeki 7 günde ${tl(f.next7KnownOutflow)} çıkış planla.`,
      reason: "Yedi günlük pencere kasa hazırlığı için en yakın planlama ufku.",
      impact: `${f.next7Count} ödeme içinde bilinen çıkış ${tl(f.next7KnownOutflow)}.`,
      evidenceHref: "/payments",
      scenarioHref: "/scenarios?from=home-next7",
    });

  if (f.firstNegativeMonth != null)
    c.push({
      key: "first_negative",
      severity: "high",
      href: "/cashflow",
      label: `Kasa ${ym(f.firstNegativeMonth)} ayında negatife geçiyor — finansman planla.`,
      reason: "İlk negatif ay finansman veya tahsilat/vade kararı gerektirir.",
      impact:
        f.worstBalance != null
          ? `En kötü bakiye ${tl(f.worstBalance)} (${ym(f.worstMonth)}).`
          : `İlk negatif ay ${ym(f.firstNegativeMonth)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-first-negative",
    });

  if (f.debtPressureMonths > 0)
    c.push({
      key: "debt_pressure",
      severity: "high",
      href: "/finance",
      label: `${f.debtPressureMonths} ayda çek+kredi yükü negatif kasaya biniyor — vadeleri gözden geçir.`,
      reason: "Borç servisi negatif kasa ile üst üste geldiğinde likidite riski artar.",
      impact: `${f.debtPressureMonths} ay borç baskısı taşıyor.`,
      evidenceHref: "/finance",
      scenarioHref: "/scenarios?from=home-debt-pressure",
    });

  if (f.todayMissing + f.monthMissingCount > 0)
    c.push({
      key: "missing",
      severity: "medium",
      href: "/payments/missing",
      label: `${f.todayMissing + f.monthMissingCount} kalemde tutar eksik — kaynağı doğrula (eksik asla 0 sayılmaz).`,
      reason: "Eksik tutar karar güvenini düşürür; sistem bunu 0 kabul etmez.",
      impact: `${f.todayMissing + f.monthMissingCount} kalem bilinmeyen tutar taşıyor.`,
      evidenceHref: "/data/quality",
    });

  if (f.topConcentration && f.topConcentration.ratio > 0.4)
    c.push({
      key: "concentration",
      severity: "medium",
      href: "/cashflow",
      label: `Gelirin %${Math.round(f.topConcentration.ratio * 100)}'i ${f.topConcentration.key}'e bağlı — yoğunlaşma riski.`,
      reason: "Tek müşteriye yüksek bağımlılık tahsilat gecikmesinde kasa riskini büyütür.",
      impact: `${f.topConcentration.key} gelir payı %${Math.round(f.topConcentration.ratio * 100)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-concentration",
    });

  if (f.failedReminders > 0)
    c.push({
      key: "failed_reminders",
      severity: "medium",
      href: "/insights/reminders",
      label: `${f.failedReminders} hatırlatma gönderilemedi — Telegram ayarını kontrol et.`,
      reason: "Gönderilemeyen hatırlatma manuel takip ihtiyacını artırır.",
      impact: `${f.failedReminders} teslimat başarısız.`,
      evidenceHref: "/insights/reminders",
    });

  if (f.staleProductionRate)
    c.push({
      key: "stale_rate",
      severity: "low",
      href: "/production",
      label: `Üretim TL/dk oranları eski tarife — güncelle (analitik tahmin).`,
      reason: "Eski tarife üretim kâr/maliyet yorumunu düşük güvenli yapar.",
      impact: "Üretim analitiği inceleme gerekli sinyali taşıyor.",
      evidenceHref: "/production",
    });

  const sorted = c.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 5);
  if (sorted.length === 0)
    return [
      {
        key: "routine",
        severity: "low",
        href: "/payments",
        label: "Kritik aksiyon yok — rutin kontrol yeterli.",
        reason: "Acil risk sinyali üretilmedi.",
        impact: "Rutin ödeme ve veri kalite kontrolü yeterli.",
        evidenceHref: "/payments",
      },
    ];
  return sorted;
}

/** Single highest-severity headline risk for the top of Ana Ekran. */
export function pickHeadlineRisk(f: CockpitFacts): { text: string; tone: "neg" | "warn" | "pos" } {
  if (f.overdueCount > 0)
    return { text: `${f.overdueCount} geciken ödeme — en yüksek öncelik.`, tone: "neg" };
  if (f.firstNegativeMonth != null)
    return {
      text: `Kasa ${ym(f.firstNegativeMonth)}'de negatife geçiyor; en kötü ay ${ym(f.worstMonth)} (${f.worstBalance != null ? tl(f.worstBalance) : "—"}).`,
      tone: "neg",
    };
  if (f.debtPressureMonths > 0)
    return { text: `${f.debtPressureMonths} ayda borç-servisi baskısı var.`, tone: "warn" };
  if (f.todayCount > 0 || f.next7KnownOutflow > 0)
    return { text: `Bugün ${f.todayCount} ödeme, 7 günde ${tl(f.next7KnownOutflow)} çıkış.`, tone: "warn" };
  if (f.monthMissingCount + f.todayMissing > 0)
    return { text: `${f.monthMissingCount + f.todayMissing} kalemde tutar eksik — veri kalitesi.`, tone: "warn" };
  return { text: "Belirgin risk yok — tablo sakin.", tone: "pos" };
}

/**
 * The "12 aylık kasa eğilimi" sparkline on Ana Ekran: the first `limit` months' closing balances.
 * A month whose closing balance is UNKNOWN is left out of the series and COUNTED, never drawn as 0 TL.
 */
export function closingTrend(
  months: ReadonlyArray<{ closing: number | null }>,
  limit = 12,
): { values: number[]; unknownCount: number } {
  const span = months.slice(0, limit);
  const values = span.flatMap((m) => (m.closing == null ? [] : [m.closing]));
  return { values, unknownCount: span.length - values.length };
}

/* ═══════════ Faz 32 — management cockpit widgets (backwards-compatible) ═══════════ */

export interface CockpitWidgetFacts {
  availableCash: number | null;
  minCashFloor: number | null;
  liquidityGap7: number | null;
  liquidityGap30: number | null;
  receivablesOpen: number | null;
  payablesOpen: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  netDebt: number | null;
  facilityAvailable: number | null;
  debtDue30: number | null;
  fxWorstCase20: number | null;
  budgetVarianceOverCount: number | null;
  cycleExcludingInventory: number | null;
  criticalControlCount: number;
  openAlertCount: number;
  topConcentrationRatio: number | null;
}

export type WidgetTone = "pos" | "neutral" | "warn" | "neg";

export interface CockpitWidget {
  key: string;
  label: string;
  value: string;
  tone: WidgetTone;
  note: string;
  href: string;
}

export function buildWidgets(f: CockpitWidgetFacts): CockpitWidget[] {
  const w: CockpitWidget[] = [];
  const unknown = (key: string, label: string, href: string, why: string): CockpitWidget => ({
    key,
    label,
    value: "—",
    tone: "neutral",
    note: why,
    href,
  });

  if (f.availableCash == null) {
    w.push(unknown("cash", "Kullanılabilir nakit", "/finance/treasury", "Pozisyon hesaplanamadı"));
  } else if (f.minCashFloor == null) {
    w.push({
      key: "cash",
      label: "Kullanılabilir nakit",
      value: tl(f.availableCash),
      tone: "neutral",
      note: "Taban tanımlı değil",
      href: "/finance/treasury",
    });
  } else {
    const belowFloor = f.availableCash < f.minCashFloor;
    w.push({
      key: "cash",
      label: "Kullanılabilir nakit",
      value: tl(f.availableCash),
      tone: belowFloor ? "neg" : "pos",
      note: belowFloor ? `Taban ${tl(f.minCashFloor)} altında` : "Taban korunuyor",
      href: "/finance/treasury",
    });
  }

  if (f.liquidityGap7 == null) {
    w.push(unknown("liquidity", "7 günlük likidite açığı", "/finance/treasury", "Likidite verisi yok"));
  } else {
    w.push({
      key: "liquidity",
      label: "7 günlük likidite açığı",
      value: f.liquidityGap7 > 0 ? tl(f.liquidityGap7) : "yok",
      tone: f.liquidityGap7 > 0 ? "neg" : "pos",
      note: f.liquidityGap7 > 0 ? "Finansman ihtiyacı var" : "7 gün içinde açık yok",
      href: "/finance/treasury",
    });
  }

  w.push(
    f.receivablesOpen == null
      ? unknown("ar", "Açık alacak", "/finance/receivables", "Alacak verisi yok")
      : {
          key: "ar",
          label: "Açık alacak",
          value: tl(f.receivablesOpen),
          tone: "neutral",
          note: f.dsoDays == null ? "DSO hesaplanamıyor" : `DSO ${f.dsoDays} gün`,
          href: "/finance/receivables",
        },
  );

  w.push(
    f.payablesOpen == null
      ? unknown("ap", "Açık borç", "/finance/receivables", "Borç verisi yok")
      : {
          key: "ap",
          label: "Açık borç",
          value: tl(f.payablesOpen),
          tone: "neutral",
          note: f.dpoDays == null ? "DPO hesaplanamıyor" : `DPO ${f.dpoDays} gün`,
          href: "/finance/receivables",
        },
  );

  w.push(
    f.netDebt == null
      ? unknown("netdebt", "Net borç", "/finance/facilities", "Borç pozisyonu yok")
      : {
          key: "netdebt",
          label: "Net borç",
          value: tl(f.netDebt),
          tone: f.netDebt > 0 ? "warn" : "pos",
          note: f.facilityAvailable == null ? "Limit bilgisi yok" : `Kullanılabilir limit ${tl(f.facilityAvailable)}`,
          href: "/finance/facilities",
        },
  );

  w.push(
    f.debtDue30 == null
      ? unknown("debt30", "30 günde vadesi gelen borç", "/finance/facilities", "Vade merdiveni boş")
      : {
          key: "debt30",
          label: "30 günde vadesi gelen borç",
          value: tl(f.debtDue30),
          tone: f.debtDue30 > 0 ? "warn" : "pos",
          note: "Taksit + çekilen limit",
          href: "/finance/facilities",
        },
  );

  w.push(
    f.fxWorstCase20 == null
      ? unknown("fx", "FX en kötü hâl (%20)", "/finance/fx", "Kuru olan pozisyon yok")
      : {
          key: "fx",
          label: "FX en kötü hâl (%20)",
          value: tl(f.fxWorstCase20),
          tone: f.fxWorstCase20 < 0 ? "warn" : "neutral",
          note: "Yön duyarlı hesaplanır",
          href: "/finance/fx",
        },
  );

  w.push(
    f.cycleExcludingInventory == null
      ? unknown("ccc", "Nakit döngüsü (env. hariç)", "/finance/profitability", "DSO/DPO hesaplanamıyor")
      : {
          key: "ccc",
          label: "Nakit döngüsü (env. hariç)",
          value: `${f.cycleExcludingInventory} gün`,
          tone: f.cycleExcludingInventory > 45 ? "warn" : "pos",
          note: "Envanter verisi yok, DIO hariç",
          href: "/finance/profitability",
        },
  );

  w.push(
    f.budgetVarianceOverCount == null
      ? unknown("budget", "Bütçe aşımı", "/cashflow/budget", "Onaylı bütçe satırı yok")
      : {
          key: "budget",
          label: "Bütçe aşımı",
          value: String(f.budgetVarianceOverCount),
          tone: f.budgetVarianceOverCount > 0 ? "warn" : "pos",
          note: "Onaylı satırlar üzerinden",
          href: "/cashflow/budget",
        },
  );

  w.push({
    key: "controls",
    label: "Kritik kontrol",
    value: String(f.criticalControlCount),
    tone: f.criticalControlCount > 0 ? "neg" : "pos",
    note: `${f.openAlertCount} açık uyarı`,
    href: "/system/controls",
  });

  w.push(
    f.topConcentrationRatio == null
      ? unknown("concentration", "En yüksek yoğunlaşma", "/cashflow/concentration", "Yoğunlaşma verisi yok")
      : {
          key: "concentration",
          label: "En yüksek yoğunlaşma",
          value: `%${Math.round(f.topConcentrationRatio * 100)}`,
          tone: f.topConcentrationRatio >= 0.4 ? "warn" : "pos",
          note: "Tek karşı taraf payı",
          href: "/cashflow/concentration",
        },
  );

  return w;
}

export function widgetsNeedingAttention(widgets: CockpitWidget[]): CockpitWidget[] {
  const rank: Record<WidgetTone, number> = { neg: 0, warn: 1, neutral: 2, pos: 3 };
  return widgets
    .filter((x) => x.tone === "neg" || x.tone === "warn")
    .sort((a, b) => rank[a.tone] - rank[b.tone] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* ═══════════ M-12 — 11 CFO Executive Cockpit Cards Engine ═══════════ */

export interface ExecutiveCockpitInput {
  asOf: string;
  /** 1. Net Likidite */
  freeCashConsolidatedTry: number | null;
  freeCashTryOnly: number | null;
  fxCashTryEquivalent: number;
  unknownOpeningCount: number;
  activeAccountCount: number;
  /** 2. 13H Nakit Ufku */
  minCash13wTry: number | null;
  minCash13wDate: string | null;
  netFlow13wTry: number | null;
  /** 3 & 4 & 5. DSO, DPO, DIO & CCC */
  receivablesOpenTry: number | null;
  payablesOpenTry: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cccDays: number | null;
  cycleExclInventoryDays: number | null;
  /** 6. Vadesi Geçmiş Alacak */
  overdueReceivablesTry: number | null;
  overdueReceivablesCount: number;
  /** 7. Çek/Senet Portföy & Ciro Riski */
  checkPortfolioInflowTry: number;
  checkCollateralTry: number;
  checkIssuedOutflowTry: number;
  checkEndorsedRiskTry: number;
  checkBouncedCount: number;
  /** 8. Döviz Açık Pozisyonu */
  fxNetOpenTry: number | null;
  fxShock20LossTry: number | null;
  fxRateSummary: string | null;
  /** 9. Kredi & Kovenant Boşluğu */
  facilityAvailableTry: number | null;
  facilityLimitTry: number | null;
  covenantActiveCount: number;
  covenantBreachedCount: number;
  /** 10. Bütçe Sapması */
  budgetOverCount: number | null;
  budgetNetVarianceTry: number | null;
  budgetMeasuredCount: number;
  /** 11. Onay & Mutabakat İstisnaları */
  pendingApprovalsCount: number;
  unmatchedBankTxCount: number;
  criticalControlAlertCount: number;
  openMappingReviewCount: number;
}

export interface ExecutiveCockpitCard {
  key:
    | "net_liquidity"
    | "horizon_13w"
    | "dso_velocity"
    | "dpo_maturity"
    | "dio_ccc"
    | "overdue_receivables"
    | "check_portfolio_endorsement"
    | "fx_open_position"
    | "credit_covenant_headroom"
    | "budget_variance"
    | "approval_recon_exceptions";
  title: string;
  value: string;
  sublabel: string;
  tone: WidgetTone;
  badgeText: string;
  href: string;
  proofItems: ProofItem[];
}

export function buildExecutiveCockpitCards(f: ExecutiveCockpitInput): ExecutiveCockpitCard[] {
  const cards: ExecutiveCockpitCard[] = [];

  // 1. Net Likidite
  const netLiqVal = f.freeCashConsolidatedTry != null ? tl(f.freeCashConsolidatedTry) : "—";
  const netLiqTone: WidgetTone =
    f.freeCashConsolidatedTry == null
      ? "warn"
      : f.freeCashConsolidatedTry < 0
        ? "neg"
        : f.unknownOpeningCount > 0
          ? "warn"
          : "pos";
  cards.push({
    key: "net_liquidity",
    title: "Net Likidite",
    value: netLiqVal,
    sublabel:
      f.freeCashConsolidatedTry == null
        ? `${f.unknownOpeningCount} hesapta açılış bakiyesi belirsiz (FIN-03)`
        : `TRY: ${f.freeCashTryOnly != null ? tl(f.freeCashTryOnly) : "—"} · Döviz karşılığı: ${tl(f.fxCashTryEquivalent)}`,
    tone: netLiqTone,
    badgeText:
      f.freeCashConsolidatedTry == null
        ? "Açılış Eksik"
        : f.freeCashConsolidatedTry < 0
          ? "Eksi Bakiye"
          : "Serbest Kasa",
    href: "/finance/treasury",
    proofItems: [
      {
        key: "net_liquidity",
        title: "Konsolide Serbest Kasa & Banka",
        value: netLiqVal,
        confidence: f.unknownOpeningCount > 0 ? "needs_review" : "source",
        freshness: f.asOf,
        explanation: `${f.activeAccountCount} aktif kasa/banka hesabı ve TCMB güncel döviz kurlarıyla konsolide edilmiştir.`,
        sourceHref: "/finance/treasury",
        sourceLabel: "Hazine Pozisyonu",
      },
    ],
  });

  // 2. 13H Nakit Ufku
  const min13Val = f.minCash13wTry != null ? tl(f.minCash13wTry) : "—";
  const min13Tone: WidgetTone =
    f.minCash13wTry == null ? "neutral" : f.minCash13wTry < 0 ? "neg" : f.minCash13wTry === 0 ? "warn" : "pos";
  cards.push({
    key: "horizon_13w",
    title: "13H Nakit Ufku",
    value: min13Val,
    sublabel:
      f.minCash13wTry == null
        ? "13 haftalık günlük akış hesaplanamadı"
        : `En düşük gün: ${f.minCash13wDate ?? f.asOf}${f.netFlow13wTry != null ? ` · 13H net: ${tl(f.netFlow13wTry)}` : ""}`,
    tone: min13Tone,
    badgeText: f.minCash13wTry == null ? "Veri Yok" : f.minCash13wTry < 0 ? "Açık Riski" : "Pozitif Ufuk",
    href: "/cashflow",
    proofItems: [
      {
        key: "horizon_13w",
        title: "13 Haftalık (91 Gün) En Düşük Kasa Noktası",
        value: min13Val,
        confidence: "calculated",
        freshness: f.asOf,
        explanation:
          "liquidity_forecast_daily (fatura, ödeme planı, 0102 çek statüleri, kredi taksitleri ve ödeme sözleri) üzerinden günlük kümülatif en düşük bakiye.",
        sourceHref: "/cashflow",
        sourceLabel: "Nakit Akışı & 13H Projeksiyon",
      },
    ],
  });

  // 3. DSO / Tahsilat Hızı
  cards.push({
    key: "dso_velocity",
    title: "DSO / Tahsilat Hızı",
    value: f.dsoDays != null ? fmtDays(f.dsoDays) : "—",
    sublabel:
      f.receivablesOpenTry != null
        ? `Açık müşteri alacağı: ${tl(f.receivablesOpenTry)}`
        : "365 günlük satış / açık alacak verisi bekleniyor",
    tone: f.dsoDays == null ? "neutral" : f.dsoDays > 65 ? "warn" : "pos",
    badgeText: f.dsoDays == null ? "Ölçülemedi" : f.dsoDays > 65 ? "Yavaş Tahsilat" : "Dengeli",
    href: "/finance/receivables",
    proofItems: [
      {
        key: "dso_velocity",
        title: "Alacak Tahsil Süresi (DSO)",
        value: f.dsoDays != null ? fmtDays(f.dsoDays) : "—",
        confidence: "calculated",
        freshness: f.asOf,
        explanation: "working_capital_metrics üzerinden (Açık Alacak / Son 365 Gün Net Satış) × 365 formülüyle hesaplanır.",
        sourceHref: "/finance/receivables",
        sourceLabel: "Alacak Yaşlandırma",
      },
    ],
  });

  // 4. DPO / Ödeme Vadesi
  cards.push({
    key: "dpo_maturity",
    title: "DPO / Ödeme Vadesi",
    value: f.dpoDays != null ? fmtDays(f.dpoDays) : "—",
    sublabel:
      f.payablesOpenTry != null
        ? `Açık tedarikçi borcu: ${tl(f.payablesOpenTry)}`
        : "365 günlük alış / açık borç verisi bekleniyor",
    tone: f.dpoDays == null ? "neutral" : f.dpoDays < 20 ? "warn" : "pos",
    badgeText: f.dpoDays == null ? "Ölçülemedi" : f.dpoDays < 20 ? "Erken Çıkış" : "Vade Dengeli",
    href: "/finance/invoices?direction=purchase",
    proofItems: [
      {
        key: "dpo_maturity",
        title: "Ticari Borç Ödeme Süresi (DPO)",
        value: f.dpoDays != null ? fmtDays(f.dpoDays) : "—",
        confidence: "calculated",
        freshness: f.asOf,
        explanation: "working_capital_metrics üzerinden (Açık Tedarikçi Borcu / Son 365 Gün Net Alım) × 365 formülüyle hesaplanır.",
        sourceHref: "/finance/invoices?direction=purchase",
        sourceLabel: "Alış Faturaları",
      },
    ],
  });

  // 5. DIO & Nakit Döngüsü (CCC)
  const effectiveCycle = f.cccDays ?? f.cycleExclInventoryDays;
  cards.push({
    key: "dio_ccc",
    title: "DIO & Nakit Döngüsü (CCC)",
    value: effectiveCycle != null ? fmtDays(effectiveCycle) : "—",
    sublabel:
      f.dioDays != null
        ? `DIO: ${fmtDays(f.dioDays)} · Tam nakit dönüşüm döngüsü`
        : effectiveCycle != null
          ? "DIO: stok kartı bekleniyor (DSO − DPO gösteriliyor)"
          : "DSO, DIO ve DPO için fatura/stok hareketi bekleniyor",
    tone: effectiveCycle == null ? "neutral" : effectiveCycle > 60 ? "warn" : "pos",
    badgeText: f.cccDays != null ? "Tam CCC" : effectiveCycle != null ? "Stok Hariç" : "Veri Yok",
    href: "/finance/profitability",
    proofItems: [
      {
        key: "dio_ccc",
        title: "Nakit Dönüşüm Döngüsü (DSO + DIO − DPO)",
        value: effectiveCycle != null ? fmtDays(effectiveCycle) : "—",
        confidence: f.dioDays != null ? "calculated" : "needs_review",
        freshness: f.asOf,
        explanation:
          f.dioDays != null
            ? `Stok devir süresi (DIO: ${fmtDays(f.dioDays)}) dahil tam CCC hesaplandı.`
            : "Aktif stok bakiyesi girilmediğinde DIO 0 uydurulmaz; DSO − DPO ticari döngüsü raporlanır.",
        sourceHref: "/finance/profitability",
        sourceLabel: "Kârlılık & İşletme Sermayesi",
      },
    ],
  });

  // 6. Vadesi Geçmiş Alacak
  const ovdAr = f.overdueReceivablesTry;
  cards.push({
    key: "overdue_receivables",
    title: "Vadesi Geçmiş Alacak",
    value: ovdAr != null ? tl(ovdAr) : "—",
    sublabel:
      f.overdueReceivablesCount > 0
        ? `${f.overdueReceivablesCount} gecikmiş satış faturası tahsilat bekliyor`
        : "Vadesi geçmiş açık müşteri faturası yok",
    tone: f.overdueReceivablesCount > 0 || (ovdAr ?? 0) > 0 ? "neg" : "pos",
    badgeText: f.overdueReceivablesCount > 0 ? `${f.overdueReceivablesCount} Gecikmiş` : "Temiz",
    href: "/finance/receivables",
    proofItems: [
      {
        key: "overdue_receivables",
        title: "Gecikmiş Açık Müşteri Alacakları",
        value: ovdAr != null ? tl(ovdAr) : "0 TL",
        confidence: "source",
        freshness: f.asOf,
        explanation: "receivables_open görünümünde vade tarihi geçmiş (days_overdue > 0) açık fatura bakiyeleri.",
        sourceHref: "/finance/receivables",
        sourceLabel: "Alacak Takibi",
      },
    ],
  });

  // 7. Çek/Senet Portföy & Ciro Riski
  const netCheckExposure = f.checkPortfolioInflowTry - f.checkIssuedOutflowTry;
  const hasCheckRisk = f.checkBouncedCount > 0 || f.checkEndorsedRiskTry > 0;
  cards.push({
    key: "check_portfolio_endorsement",
    title: "Çek/Senet Portföy & Ciro Riski",
    value: tl(f.checkPortfolioInflowTry),
    sublabel: `Keşide borç: ${tl(f.checkIssuedOutflowTry)} · Ciro/Teminat: ${tl(f.checkEndorsedRiskTry + f.checkCollateralTry)}${f.checkBouncedCount > 0 ? ` · ${f.checkBouncedCount} karşılıksız` : ""}`,
    tone: f.checkBouncedCount > 0 ? "neg" : hasCheckRisk || f.checkIssuedOutflowTry > f.checkPortfolioInflowTry ? "warn" : "pos",
    badgeText:
      f.checkBouncedCount > 0
        ? `${f.checkBouncedCount} Karşılıksız`
        : netCheckExposure >= 0
          ? "Portföy Artıda"
          : "Net Keşide Yükü",
    href: "/finance/checks",
    proofItems: [
      {
        key: "check_portfolio_endorsement",
        title: "0102 Türk Çek/Senet Bordro Statüleri",
        value: `Portföy/Tahsil: ${tl(f.checkPortfolioInflowTry)} | Keşide: ${tl(f.checkIssuedOutflowTry)}`,
        confidence: "source",
        freshness: f.asOf,
        explanation:
          "in_portfolio, in_bank_collection, in_bank_collateral, issued_to_vendor, endorsed_to_vendor ve bounced statülerinin canlı toplamı.",
        sourceHref: "/finance/checks",
        sourceLabel: "Çek & Senet Portföyü",
      },
    ],
  });

  // 8. Döviz Açık Pozisyonu
  const fxVal = f.fxNetOpenTry != null ? tl(f.fxNetOpenTry) : "—";
  cards.push({
    key: "fx_open_position",
    title: "Döviz Açık Pozisyonu",
    value: fxVal,
    sublabel:
      f.fxNetOpenTry == null
        ? "TCMB kur görüntüsü veya döviz kalemi bulunamadı"
        : `%20 kur şoku etkisi: ${f.fxShock20LossTry != null ? tl(f.fxShock20LossTry) : "—"}${f.fxRateSummary ? ` · ${f.fxRateSummary}` : ""}`,
    tone:
      f.fxNetOpenTry == null
        ? "neutral"
        : f.fxNetOpenTry < 0
          ? "warn"
          : "pos",
    badgeText:
      f.fxNetOpenTry == null
        ? "Kur Bekleniyor"
        : f.fxNetOpenTry < 0
          ? "Kısa (Açık) Pozisyon"
          : "Uzun / Dengeli",
    href: "/finance/fx",
    proofItems: [
      {
        key: "fx_open_position",
        title: "Canlı Net Yabancı Para Pozisyonu",
        value: fxVal,
        confidence: "calculated",
        freshness: f.asOf,
        explanation:
          "Döviz kasa/banka + döviz açık alacak/borç + döviz çek/kredi bakiyelerinin TCMB fx_rate_snapshots kurlarıyla TL karşılığı.",
        sourceHref: "/finance/fx",
        sourceLabel: "Döviz Pozisyonu & Kur Şoku",
      },
    ],
  });

  // 9. Kredi & Kovenant Boşluğu
  const headroomVal = f.facilityAvailableTry != null ? tl(f.facilityAvailableTry) : "—";
  cards.push({
    key: "credit_covenant_headroom",
    title: "Kredi & Kovenant Boşluğu",
    value: headroomVal,
    sublabel:
      f.covenantBreachedCount > 0
        ? `${f.covenantBreachedCount} kovenant ihlali! · Toplam limit: ${f.facilityLimitTry != null ? tl(f.facilityLimitTry) : "—"}`
        : `${f.covenantActiveCount} aktif kovenant uyumlu · Toplam limit: ${f.facilityLimitTry != null ? tl(f.facilityLimitTry) : "—"}`,
    tone:
      f.covenantBreachedCount > 0
        ? "neg"
        : f.facilityAvailableTry != null && f.facilityAvailableTry > 0
          ? "pos"
          : "neutral",
    badgeText:
      f.covenantBreachedCount > 0
        ? `${f.covenantBreachedCount} İhlal`
        : f.facilityAvailableTry != null
          ? "Kullanıma Hazır"
          : "Limit Tanımsız",
    href: "/finance/facilities",
    proofItems: [
      {
        key: "credit_covenant_headroom",
        title: "Kullanılabilir Kredi Limiti & Kovenant Uyum Durumu",
        value: headroomVal,
        confidence: "source",
        freshness: f.asOf,
        explanation:
          "credit_facility_utilization (aktif limit − kullanılan bakiye) ve covenant_records son test sonuçları.",
        sourceHref: "/finance/facilities",
        sourceLabel: "Kredi Limitleri & Kovenantlar",
      },
    ],
  });

  // 10. Bütçe Sapması
  const hasBudget = f.budgetMeasuredCount > 0 && f.budgetOverCount != null;
  cards.push({
    key: "budget_variance",
    title: "Bütçe Sapması",
    value: hasBudget
      ? f.budgetNetVarianceTry != null
        ? tl(f.budgetNetVarianceTry)
        : `${f.budgetOverCount} aşım`
      : "—",
    sublabel: hasBudget
      ? `${f.budgetMeasuredCount} onaylı satır ölçüldü · ${f.budgetOverCount} kalemde bütçe aşımı`
      : "Onaylı bütçe satırı veya gerçekleşen fatura eşleşmesi yok",
    tone: !hasBudget ? "neutral" : (f.budgetOverCount ?? 0) > 0 ? "warn" : "pos",
    badgeText: !hasBudget ? "Bütçe Yok" : (f.budgetOverCount ?? 0) > 0 ? `${f.budgetOverCount} Aşım` : "Bütçe İçi",
    href: "/cashflow/budget",
    proofItems: [
      {
        key: "budget_variance",
        title: "KDV Hariç Net Bütçe vs Gerçekleşen Sapması",
        value: hasBudget && f.budgetNetVarianceTry != null ? tl(f.budgetNetVarianceTry) : "—",
        confidence: "calculated",
        freshness: f.asOf,
        explanation: "budget_vs_actual görünümü üzerinden onaylı bütçe satırları ile KDV hariç net gerçekleşmeler karşılaştırılır.",
        sourceHref: "/cashflow/budget",
        sourceLabel: "Bütçe & Sapma Analizi",
      },
    ],
  });

  // 11. Onay & Mutabakat İstisnaları
  const totalExceptions =
    f.pendingApprovalsCount +
    f.unmatchedBankTxCount +
    f.criticalControlAlertCount +
    f.openMappingReviewCount;
  cards.push({
    key: "approval_recon_exceptions",
    title: "Onay & Mutabakat İstisnaları",
    value: `${totalExceptions} istisna`,
    sublabel: `${f.pendingApprovalsCount} onay · ${f.unmatchedBankTxCount} eşleşmemiş banka · ${f.criticalControlAlertCount} kritik uyarı`,
    tone:
      f.criticalControlAlertCount > 0
        ? "neg"
        : totalExceptions > 0
          ? "warn"
          : "pos",
    badgeText:
      f.criticalControlAlertCount > 0
        ? "Kritik Uyarı"
        : totalExceptions > 0
          ? "Aksiyon Bekliyor"
          : "Mutabık",
    href: f.pendingApprovalsCount > 0 ? "/system/approvals" : f.unmatchedBankTxCount > 0 ? "/finance/bank-import" : "/system/controls",
    proofItems: [
      {
        key: "approval_recon_exceptions",
        title: "Maker-Checker Onay, Banka Mutabakat ve İç Kontrol Özeti",
        value: `${totalExceptions} açık kayıt`,
        confidence: "source",
        freshness: f.asOf,
        explanation: `Bekleyen onay: ${f.pendingApprovalsCount}, Eşleşmemiş banka hareketi: ${f.unmatchedBankTxCount}, Kritik kontrol uyarısı: ${f.criticalControlAlertCount}, Veri inceleme: ${f.openMappingReviewCount}.`,
        sourceHref: "/system/controls",
        sourceLabel: "İç Kontrol & Mutabakat",
      },
    ],
  });

  return cards;
}
