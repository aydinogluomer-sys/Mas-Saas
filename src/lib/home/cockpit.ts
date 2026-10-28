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
    c.push({ key: "overdue", severity: "critical", href: "/radar",
      label: `${f.overdueCount} geciken ödeme var — bugün kontrol et${f.overdueKnownOutflow > 0 ? ` (${tl(f.overdueKnownOutflow)})` : ""}.`,
      reason: "Geciken odeme nakit cikisini ve tedarik iliskisini bugun etkiler.",
      impact: f.overdueKnownOutflow > 0 ? `Bilinen yuk ${tl(f.overdueKnownOutflow)}.` : "Tutar kaniti eksik; once kaynagi ac.",
      evidenceHref: "/radar" });

  if (f.todayCount > 0)
    c.push({ key: "today", severity: "high", href: "/radar",
      label: `Bugün ${f.todayCount} ödeme${f.todayKnownOutflow > 0 ? ` — ${tl(f.todayKnownOutflow)} nakit hazırla` : ""}.`,
      reason: "Bugunun odemesi operasyonel aksiyondur; bekletme karari bilincli olmalidir.",
      impact: f.todayKnownOutflow > 0 ? `Bugun bilinen cikis ${tl(f.todayKnownOutflow)}.` : "Bugun odeme var ama tutar kaniti eksik.",
      evidenceHref: "/radar" });

  if (f.next7KnownOutflow > 0)
    c.push({ key: "next7", severity: "medium", href: "/radar",
      label: `Önümüzdeki 7 günde ${tl(f.next7KnownOutflow)} çıkış planla.`,
      reason: "Yedi gunluk pencere kasa hazirligi icin en yakin planlama ufku.",
      impact: `${f.next7Count} odeme icinde bilinen cikis ${tl(f.next7KnownOutflow)}.`,
      evidenceHref: "/radar",
      scenarioHref: "/scenarios?from=home-next7" });

  if (f.firstNegativeMonth != null)
    c.push({ key: "first_negative", severity: "high", href: "/cashflow",
      label: `Kasa ${ym(f.firstNegativeMonth)} ayında negatife geçiyor — finansman planla.`,
      reason: "Ilk negatif ay finansman veya tahsilat/vade karari gerektirir.",
      impact: f.worstBalance != null ? `En kotu bakiye ${tl(f.worstBalance)} (${ym(f.worstMonth)}).` : `Ilk negatif ay ${ym(f.firstNegativeMonth)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-first-negative" });

  if (f.debtPressureMonths > 0)
    c.push({ key: "debt_pressure", severity: "high", href: "/financing",
      label: `${f.debtPressureMonths} ayda çek+kredi yükü negatif kasaya biniyor — vadeleri gözden geçir.`,
      reason: "Borc servisi negatif kasa ile ust uste geldiginde likidite riski artar.",
      impact: `${f.debtPressureMonths} ay borc baskisi tasiyor.`,
      evidenceHref: "/financing",
      scenarioHref: "/scenarios?from=home-debt-pressure" });

  if (f.todayMissing + f.monthMissingCount > 0)
    c.push({ key: "missing", severity: "medium", href: "/radar",
      label: `${f.todayMissing + f.monthMissingCount} kalemde tutar eksik — kaynağı doğrula (eksik asla 0 sayılmaz).`,
      reason: "Eksik tutar karar guvenini dusurur; sistem bunu 0 kabul etmez.",
      impact: `${f.todayMissing + f.monthMissingCount} kalem bilinmeyen tutar tasiyor.`,
      evidenceHref: "/data-quality" });

  if (f.topConcentration && f.topConcentration.ratio > 0.4)
    c.push({ key: "concentration", severity: "medium", href: "/cashflow",
      label: `Gelirin %${Math.round(f.topConcentration.ratio * 100)}'i ${f.topConcentration.key}'e bağlı — yoğunlaşma riski.`,
      reason: "Tek musteriye yuksek bagimlilik tahsilat gecikmesinde kasa riskini buyutur.",
      impact: `${f.topConcentration.key} gelir payi %${Math.round(f.topConcentration.ratio * 100)}.`,
      evidenceHref: "/cashflow",
      scenarioHref: "/scenarios?from=home-concentration" });

  if (f.failedReminders > 0)
    c.push({ key: "failed_reminders", severity: "medium", href: "/reminders",
      label: `${f.failedReminders} hatırlatma gönderilemedi — Telegram ayarını kontrol et.`,
      reason: "Gonderilemeyen hatirlatma manuel takip ihtiyacini artirir.",
      impact: `${f.failedReminders} teslimat basarisiz.`,
      evidenceHref: "/reminders" });

  if (f.staleProductionRate)
    c.push({ key: "stale_rate", severity: "low", href: "/production",
      label: `Üretim TL/dk oranları eski tarife — güncelle (analitik tahmin).`,
      reason: "Eski tarife uretim kar/maliyet yorumunu dusuk guvenli yapar.",
      impact: "Uretim analitigi review gerekli sinyali tasiyor.",
      evidenceHref: "/production" });

  const sorted = c.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 5);
  if (sorted.length === 0)
    return [{
      key: "routine",
      severity: "low",
      href: "/radar",
      label: "Kritik aksiyon yok — rutin kontrol yeterli.",
      reason: "Acil risk sinyali uretilmedi.",
      impact: "Rutin odeme ve veri kalite kontrolu yeterli.",
      evidenceHref: "/radar",
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
 * 0 TL. The page used to map it with `closing ?? 0`, which put a cash crash that is really a
 * missing number on the first screen anyone opens — a fake cliff is worse than no line, because a
 * trend is read at a glance and not interrogated. Same rule as the 30-day payment trend beside it:
 * the sparkline cannot draw a gap, so the gap is stated in its subtitle instead (Wave 0, R10).
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

/**
 * The widget layer, added ALONGSIDE the Faz-14 action list rather than replacing it.
 *
 * Same contract as the rest of this file, restated because it is what makes the widgets safe:
 * NO new financial math, NO database, NO LLM. Every number arrives already computed by the phase
 * that owns it — treasury (26), financing/FX (27), budget/forecast (28), costing (30), controls
 * (31) — and this module only decides how to RANK and PHRASE it.
 *
 * That is also why `CockpitFacts` above is untouched: the existing overview page depends on it,
 * and widening a shared interface to add unrelated fields would make every existing caller supply
 * values it has no business knowing.
 */
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
 * UNKNOWN IS RENDERED AS "—", NEVER AS ZERO. A cash figure of 0 TL and "we could not compute the
 * cash figure" are different statements, and a cockpit that shows the second as the first is
 * exactly the screen that gets trusted while being wrong. Every tile below returns `neutral` with
 * an explicit note when its input is null.
 */
export function buildWidgets(f: CockpitWidgetFacts): CockpitWidget[] {
  const w: CockpitWidget[] = [];
  const unknown = (key: string, label: string, href: string, why: string): CockpitWidget =>
    ({ key, label, value: "—", tone: "neutral", note: why, href });

  // Cash against the configured floor.
  if (f.availableCash == null) {
    w.push(unknown("cash", "Kullanılabilir nakit", "/finance/treasury", "Pozisyon hesaplanamadı"));
  } else if (f.minCashFloor == null) {
    // The cash figure is known; the floor it is judged against is not. "Taban korunuyor" here was
    // a verdict on a comparison that never happened — any positive balance read as compliant. The
    // value is shown, the verdict is withheld, and the tile stays neutral (Wave 0, R10).
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
        // Named for what it omits — this system has no inventory data (Faz 30).
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
