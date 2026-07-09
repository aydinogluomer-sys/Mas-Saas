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
