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
      label: `${f.overdueCount} geciken ödeme var — bugün kontrol et${f.overdueKnownOutflow > 0 ? ` (${tl(f.overdueKnownOutflow)})` : ""}.` });

  if (f.todayCount > 0)
    c.push({ key: "today", severity: "high", href: "/radar",
      label: `Bugün ${f.todayCount} ödeme${f.todayKnownOutflow > 0 ? ` — ${tl(f.todayKnownOutflow)} nakit hazırla` : ""}.` });

  if (f.next7KnownOutflow > 0)
    c.push({ key: "next7", severity: "medium", href: "/radar",
      label: `Önümüzdeki 7 günde ${tl(f.next7KnownOutflow)} çıkış planla.` });

  if (f.firstNegativeMonth != null)
    c.push({ key: "first_negative", severity: "high", href: "/cashflow",
      label: `Kasa ${ym(f.firstNegativeMonth)} ayında negatife geçiyor — finansman planla.` });

  if (f.debtPressureMonths > 0)
    c.push({ key: "debt_pressure", severity: "high", href: "/financing",
      label: `${f.debtPressureMonths} ayda çek+kredi yükü negatif kasaya biniyor — vadeleri gözden geçir.` });

  if (f.todayMissing + f.monthMissingCount > 0)
    c.push({ key: "missing", severity: "medium", href: "/radar",
      label: `${f.todayMissing + f.monthMissingCount} kalemde tutar eksik — kaynağı doğrula (eksik asla 0 sayılmaz).` });

  if (f.topConcentration && f.topConcentration.ratio > 0.4)
    c.push({ key: "concentration", severity: "medium", href: "/cashflow",
      label: `Gelirin %${Math.round(f.topConcentration.ratio * 100)}'i ${f.topConcentration.key}'e bağlı — yoğunlaşma riski.` });

  if (f.failedReminders > 0)
    c.push({ key: "failed_reminders", severity: "medium", href: "/reminders",
      label: `${f.failedReminders} hatırlatma gönderilemedi — Telegram ayarını kontrol et.` });

  if (f.staleProductionRate)
    c.push({ key: "stale_rate", severity: "low", href: "/production",
      label: `Üretim TL/dk oranları eski tarife — güncelle (analitik tahmin).` });

  const sorted = c.sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, 5);
  if (sorted.length === 0)
    return [{ key: "routine", severity: "low", href: "/radar", label: "Kritik aksiyon yok — rutin kontrol yeterli." }];
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
