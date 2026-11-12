// Ana Ekran cockpit rules (UX layer). Pure & deterministic — ranks ALREADY-COMPUTED
// signals into a headline risk and a short "Ne yapmalıyım?" action list. No new financial
// math, no DB, no LLM. null amount is disclosed as unknown, never treated as 0.

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
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");

/**
 * Deterministic action list. Every candidate is backed by an existing fact; only
 * triggered ones appear, sorted by severity then a fixed priority, capped at 5.
 */
export function buildActions(f: CockpitFacts): CockpitAction[] {
  const c: CockpitAction[] = [];

  if (f.overdueCount > 0)
    c.push({ key: "overdue", severity: "critical", href: "/payments",
      label: `${f.overdueCount} geciken ödeme var — bugün kontrol et${f.overdueKnownOutflow > 0 ? ` (${tl(f.overdueKnownOutflow)})` : ""}.`,
      reason: "Geciken ödeme nakit çıkışını ve tedarik ilişkisini bugün etkiler.",
      impact: f.overdueKnownOutflow > 0 ? `Bilinen yük ${tl(f.overdueKnownOutflow)}.` : "Tutar kanıtı eksik; önce kaynağı aç.",
      evidenceHref: "/payments" });

  if (f.todayCount > 0)
    c.push({ key: "today", severity: "high", href: "/payments",
      label: `Bugün ${f.todayCount} ödeme${f.todayKnownOutflow > 0 ? ` — ${tl(f.todayKnownOutflow)} nakit hazırla` : ""}.`,
      reason: "Bugünün ödemesi operasyonel aksiyondur; bekletme kararı bilinçli olmalıdır.",
      impact: f.todayKnownOutflow > 0 ? `Bugün bilinen çıkış ${tl(f.todayKnownOutflow)}.` : "Bugün ödeme var ama tutar kanıtı eksik.",
      evidenceHref: "/payments" });

  if (f.next7KnownOutflow > 0)
    c.push({ key: "next7", severity: "medium", href: "/payments",
      label: `Önümüzdeki 7 günde ${tl(f.next7KnownOutflow)} çıkış planla.`,
      reason: "Yedi günlük pencere kasa hazırlığı için en yakın planlama ufku.",
      impact: `${f.next7Count} ödeme içinde bilinen çıkış ${tl(f.next7KnownOutflow)}.`,
      evidenceHref: "/payments",
      scenarioHref: "/scenarios?from=home-next7" });

  if (f.firstNegativeMonth != null)
    c.push({ key: "first_negative", severity: "high", href: "/cashflow",
      label: `Kasa ${ym(f.firstNegativeMonth)} ayında negatife geçiyor — finansman planla.`,
      reason: "İlk negatif ay finansman veya tahsilat/vade kararı gerektirir.",
      impact: f.worstBalance != null ? `En kötü bakiye ${tl(f.worstBalance)} (${ym(f.worstMonth)}).` : `İlk negatif ay ${ym(f.firstNegativeMonth)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-first-negative" });

  if (f.debtPressureMonths > 0)
    c.push({ key: "debt_pressure", severity: "high", href: "/finance",
      label: `${f.debtPressureMonths} ayda çek+kredi yükü negatif kasaya biniyor — vadeleri gözden geçir.`,
      reason: "Borç servisi negatif kasa ile üst üste geldiğinde likidite riski artar.",
      impact: `${f.debtPressureMonths} ay borç baskısı taşıyor.`,
      evidenceHref: "/finance",
      scenarioHref: "/scenarios?from=home-debt-pressure" });

  if (f.todayMissing + f.monthMissingCount > 0)
    c.push({ key: "missing", severity: "medium", href: "/payments/missing",
      label: `${f.todayMissing + f.monthMissingCount} kalemde tutar eksik — kaynağı doğrula (eksik asla 0 sayılmaz).`,
      reason: "Eksik tutar karar güvenini düşürür; sistem bunu 0 kabul etmez.",
      impact: `${f.todayMissing + f.monthMissingCount} kalem bilinmeyen tutar taşıyor.`,
      evidenceHref: "/data/quality" });

  if (f.topConcentration && f.topConcentration.ratio > 0.4)
    c.push({ key: "concentration", severity: "medium", href: "/cashflow",
      label: `Gelirin %${Math.round(f.topConcentration.ratio * 100)}'i ${f.topConcentration.key}'e bağlı — yoğunlaşma riski.`,
      reason: "Tek müşteriye yüksek bağımlılık tahsilat gecikmesinde kasa riskini büyütür.",
      impact: `${f.topConcentration.key} gelir payı %${Math.round(f.topConcentration.ratio * 100)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-concentration" });

  if (f.failedReminders > 0)
    c.push({ key: "failed_reminders", severity: "medium", href: "/insights/reminders",
      label: `${f.failedReminders} hatırlatma gönderilemedi — Telegram ayarını kontrol et.`,
      reason: "Gönderilemeyen hatırlatma manuel takip ihtiyacını artırır.",
      impact: `${f.failedReminders} teslimat başarısız.`,
      evidenceHref: "/insights/reminders" });

  if (f.staleProductionRate)
    c.push({ key: "stale_rate", severity: "low", href: "/production",
      label: `Üretim TL/dk oranları eski tarife — güncelle (analitik tahmin).`,
      reason: "Eski tarife üretim kâr/maliyet yorumunu düşük güvenli yapar.",
      impact: "Üretim analitiği inceleme gerekli sinyali taşıyor.",
      evidenceHref: "/production" });

  const sorted = c.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 5);
  if (sorted.length === 0)
    return [{
      key: "routine",
      severity: "low",
      href: "/payments",
      label: "Kritik aksiyon yok — rutin kontrol yeterli.",
      reason: "Acil risk sinyali üretilmedi.",
      impact: "Rutin ödeme ve veri kalite kontrolü yeterli.",
      evidenceHref: "/payments",
    }];
  return sorted;
}

/** Single highest-severity headline risk for the top of Ana Ekran. */
export function pickHeadlineRisk(f: CockpitFacts): { text: string; tone: "neg" | "warn" | "pos" } {
  if (f.overdueCount > 0)
    return { text: `${f.overdueCount} geciken ödeme — en yüksek öncelik.`, tone: "neg" };
  if (f.firstNegativeMonth != null)
    return { text: `Kasa ${ym(f.firstNegativeMonth)}'de negatife geçiyor; en kötü ay ${ym(f.worstMonth)} (${f.worstBalance != null ? tl(f.worstBalance) : "—"}).`, tone: "neg" };
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
 *
 * A month whose closing balance is UNKNOWN is left out of the series and COUNTED, never drawn as
 * 0 TL.
 */
export function closingTrend(
  months: ReadonlyArray<{ closing: number | null }>,
  limit = 12,
): { values: number[]; unknownCount: number } {
  const span = months.slice(0, limit);
  const values = span.flatMap((m) => (m.closing == null ? [] : [m.closing]));
  return { values, unknownCount: span.length - values.length };
}

/* ═══════════ Faz 32 — management cockpit widgets ═══════════ */

export interface CockpitWidgetFacts {
  /** Treasury (Faz 26). */
  availableCash: number | null;
  minCashFloor: number | null;
  liquidityGap7: number | null;
  liquidityGap30: number | null;
  /** Receivables / payables (Faz 22, 30). */
  receivablesOpen: number | null;
  payablesOpen: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  /** Financing (Faz 27). */
  netDebt: number | null;
  facilityAvailable: number | null;
  debtDue30: number | null;
  /** FX (Faz 27). NULL when no position has a rate. */
  fxWorstCase20: number | null;
  /** Budget / forecast (Faz 28). */
  budgetVarianceOverCount: number | null;
  /** Costing (Faz 30). */
  cycleExcludingInventory: number | null;
  /** Controls (Faz 31). */
  criticalControlCount: number;
  openAlertCount: number;
  /** Concentration (Faz 23). */
  topConcentrationRatio: number | null;
}

export type WidgetTone = "pos" | "neutral" | "warn" | "neg";

export interface CockpitWidget {
  key: string;
  label: string;
  /** Already formatted for display, or "—" when the underlying value is unknown. */
  value: string;
  tone: WidgetTone;
  /** Why this tone — shown so a red tile can be interrogated rather than just believed. */
  note: string;
  href: string;
}

/**
 * Build the management cockpit tiles.
 *
 * UNKNOWN IS RENDERED AS "—", NEVER AS ZERO.
 */
export function buildWidgets(f: CockpitWidgetFacts): CockpitWidget[] {
  const w: CockpitWidget[] = [];
  const unknown = (key: string, label: string, href: string, why: string): CockpitWidget =>
    ({ key, label, value: "—", tone: "neutral", note: why, href });

  // Cash against the configured floor.
  if (f.availableCash == null) {
    w.push(unknown("cash", "Kullanılabilir nakit", "/finance/treasury", "Pozisyon hesaplanamadı"));
  } else if (f.minCashFloor == null) {
    w.push({
      key: "cash", label: "Kullanılabilir nakit", value: tl(f.availableCash),
      tone: "neutral", note: "Taban tanımlı değil", href: "/finance/treasury",
    });
  } else {
    const belowFloor = f.availableCash < f.minCashFloor;
    w.push({
      key: "cash", label: "Kullanılabilir nakit", value: tl(f.availableCash),
      tone: belowFloor ? "neg" : "pos",
      note: belowFloor ? `Taban ${tl(f.minCashFloor)} altında` : "Taban korunuyor",
      href: "/finance/treasury",
    });
  }

  // Liquidity gap — judged on the 7-day horizon because that is the one you cannot refinance out of.
  if (f.liquidityGap7 == null) {
    w.push(unknown("liquidity", "7 günlük likidite açığı", "/finance/treasury", "Likidite verisi yok"));
  } else {
    w.push({
      key: "liquidity", label: "7 günlük likidite açığı",
      value: f.liquidityGap7 > 0 ? tl(f.liquidityGap7) : "yok",
      tone: f.liquidityGap7 > 0 ? "neg" : "pos",
      note: f.liquidityGap7 > 0 ? "Finansman ihtiyacı var" : "7 gün içinde açık yok",
      href: "/finance/treasury",
    });
  }

  w.push(f.receivablesOpen == null
    ? unknown("ar", "Açık alacak", "/finance/receivables", "Alacak verisi yok")
    : { key: "ar", label: "Açık alacak", value: tl(f.receivablesOpen), tone: "neutral",
        note: f.dsoDays == null ? "DSO hesaplanamıyor" : `DSO ${f.dsoDays} gün`,
        href: "/finance/receivables" });

  w.push(f.payablesOpen == null
    ? unknown("ap", "Açık borç", "/finance/receivables", "Borç verisi yok")
    : { key: "ap", label: "Açık borç", value: tl(f.payablesOpen), tone: "neutral",
        note: f.dpoDays == null ? "DPO hesaplanamıyor" : `DPO ${f.dpoDays} gün`,
        href: "/finance/receivables" });

  w.push(f.netDebt == null
    ? unknown("netdebt", "Net borç", "/finance/facilities", "Borç pozisyonu yok")
    : { key: "netdebt", label: "Net borç", value: tl(f.netDebt),
        tone: f.netDebt > 0 ? "warn" : "pos",
        note: f.facilityAvailable == null ? "Limit bilgisi yok"
          : `Kullanılabilir limit ${tl(f.facilityAvailable)}`,
        href: "/finance/facilities" });

  w.push(f.debtDue30 == null
    ? unknown("debt30", "30 günde vadesi gelen borç", "/finance/facilities", "Vade merdiveni boş")
    : { key: "debt30", label: "30 günde vadesi gelen borç", value: tl(f.debtDue30),
        tone: f.debtDue30 > 0 ? "warn" : "pos", note: "Taksit + çekilen limit",
        href: "/finance/facilities" });

  // FX worst case is ALWAYS a loss by construction (Faz 27), so a non-null value is never good news.
  w.push(f.fxWorstCase20 == null
    ? unknown("fx", "FX en kötü hâl (%20)", "/finance/fx", "Kuru olan pozisyon yok")
    : { key: "fx", label: "FX en kötü hâl (%20)", value: tl(f.fxWorstCase20),
        tone: f.fxWorstCase20 < 0 ? "warn" : "neutral", note: "Yön duyarlı hesaplanır",
        href: "/finance/fx" });

  w.push(f.cycleExcludingInventory == null
    ? unknown("ccc", "Nakit döngüsü (env. hariç)", "/finance/profitability", "DSO/DPO hesaplanamıyor")
    : { key: "ccc", label: "Nakit döngüsü (env. hariç)",
        value: `${f.cycleExcludingInventory} gün`,
        tone: f.cycleExcludingInventory > 45 ? "warn" : "pos",
        note: "Envanter verisi yok, DIO hariç",
        href: "/finance/profitability" });

  w.push(f.budgetVarianceOverCount == null
    ? unknown("budget", "Bütçe aşımı", "/cashflow/budget", "Onaylı bütçe satırı yok")
    : { key: "budget", label: "Bütçe aşımı", value: String(f.budgetVarianceOverCount),
        tone: f.budgetVarianceOverCount > 0 ? "warn" : "pos", note: "Onaylı satırlar üzerinden",
        href: "/cashflow/budget" });

  w.push({
    key: "controls", label: "Kritik kontrol", value: String(f.criticalControlCount),
    tone: f.criticalControlCount > 0 ? "neg" : "pos",
    note: `${f.openAlertCount} açık uyarı`,
    href: "/system/controls",
  });

  w.push(f.topConcentrationRatio == null
    ? unknown("concentration", "En yüksek yoğunlaşma", "/cashflow/concentration", "Yoğunlaşma verisi yok")
    : { key: "concentration", label: "En yüksek yoğunlaşma",
        value: `%${Math.round(f.topConcentrationRatio * 100)}`,
        tone: f.topConcentrationRatio >= 0.4 ? "warn" : "pos", note: "Tek karşı taraf payı",
        href: "/cashflow/concentration" });

  return w;
}

/** Tiles that warrant attention, worst first — the cockpit's own triage. */
export function widgetsNeedingAttention(widgets: CockpitWidget[]): CockpitWidget[] {
  const rank: Record<WidgetTone, number> = { neg: 0, warn: 1, neutral: 2, pos: 3 };
  return widgets
    .filter((x) => x.tone === "neg" || x.tone === "warn")
    .sort((a, b) => (rank[a.tone] - rank[b.tone]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
