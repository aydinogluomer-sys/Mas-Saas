// Payment radar domain rules (Phase 3). Pure & deterministic —
// sources: docs/calculation-rules.md + .claude/skills/mas-payment-risk-engine.
//
// Faz 17: still pure — @/lib/money is a decimal helper with no DB or IO of its own, so this
// module remains unit-testable exactly as before.
import { decimal, money, ratioOrNull, zero, type Decimal } from "@/lib/money";

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function monthStartOf(iso: string): string {
  return iso.slice(0, 7) + "-01";
}

export function addMonths(monthStartISO: string, delta: number): string {
  const [y, m] = monthStartISO.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

/** due_day 29–31 in shorter months → last day + short_month_adjustment flag. */
export function dueDateFor(
  monthStartISO: string,
  dueDay: number,
): { dueDate: string; shortMonthAdjusted: boolean } {
  const [y, m] = monthStartISO.split("-").map(Number);
  const dim = daysInMonth(y, m);
  const day = Math.min(dueDay, dim);
  return {
    dueDate: `${monthStartISO.slice(0, 8)}${String(day).padStart(2, "0")}`,
    shortMonthAdjusted: day !== dueDay,
  };
}

/* ── risk engine ── */

export interface RiskThresholds {
  large: number; // large_payment_threshold_try
  critical: number; // critical_payment_threshold_try
  clusterCount: number; // same_day_cluster_count
}

/**
 * Eşiklerin para birimi. `large_payment_threshold_try` / `critical_payment_threshold_try` adları
 * üzerinde TRY yazar; bu sabit o adı koda taşır. Bir kalem ancak bu para birimindeyse eşikle
 * karşılaştırılabilir.
 */
export const THRESHOLD_CURRENCY = "TRY";

/**
 * Bu kalem TRY eşikleriyle karşılaştırılabilir mi?
 *
 * PHASE 2.2 / plan §2.1: `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` — kur çevirimi YOK ve
 * burada yazılmıyor. Kural: "Farklı para birimleri doğrudan toplama/karşılaştırmaya giremez.
 * Politika yoksa tutarı TRY varsayma; açıkça eksik/inceleme gerekli göster." Dolayısıyla `null`
 * (bilinmeyen para birimi) da TRY sayılmaz: karşılaştırma dışında tutulur ve SAYILIR.
 */
export function isThresholdCurrency(currency: string | null | undefined): boolean {
  return currency === THRESHOLD_CURRENCY;
}

export interface RiskInputInstance {
  id: string;
  dueDate: string; // ISO
  amount: number | null;
  status: string; // 'unpaid' | 'paid' | ...
  paidAmount?: number | null;
  /**
   * Kalemin para birimi (payment_instances.currency, `not null default 'TRY'`).
   * Yalnız `THRESHOLD_CURRENCY` satırlar tutar eşikleriyle tartılır; diğerleri (ve `null` =
   * bilinmiyor) toplamdan ve eşik kararından DIŞARIDA tutulur, ama `foreignCount` ile görünür kalır.
   * Sayım tabanlı kurallar (aynı gün yığılma) para biriminden bağımsızdır ve her kalemi sayar.
   */
  currency: string | null;
}

export type RiskReason =
  | "missing_amount"
  | "negative_amount"
  | "large_payment"
  | "critical_payment"
  | "same_day_cluster"
  | "overdue"
  | "overpaid"
  /**
   * PHASE 2.2 (T1-b): kalemin tutarı var ama para birimi TRY değil; `*_threshold_try` eşikleri
   * bu tutara UYGULANMADI. Kur çevirimi yok, dolayısıyla büyük/kritik olup olmadığı BİLİNMİYOR —
   * "risk yok" değil, "inceleme gerekli". Sadece açık kalemlerde ve yalnız eşik dalının yerine yazılır
   * (tutar null → missing_amount, negatif → negative_amount öncelikli ve para biriminden bağımsız).
   */
  | "unsupported_currency";

/**
 * `unsupported_currency` bir şiddet değil, "eşik değerlendirilemedi" işaretidir. Merdivende
 * KESİN olan `critical` ve `overdue`nun altında, `medium`ın üstünde durur: bilinmeyen bir eşik
 * sonucu kritik olabilir, bu yüzden kesin-orta gerekçelerin üstüne çıkar; gecikme ise para
 * biriminden bağımsız kesin bir olgudur ve öncelik listelerinde görünmeye devam etmelidir.
 * DB CHECK'i migration 0092 ile genişletildi (0003'teki beş üyeye altıncı üye).
 */
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical" | "unsupported_currency";

const OPEN_STATUSES = new Set(["unpaid", "partial", "planned", "late"]);

export function isOpen(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

/**
 * Risk ladder (deterministic, documented in calculation-rules.md):
 * critical_payment → critical; overdue → high; unsupported_currency → unsupported_currency;
 * large/cluster/negative/overpaid → medium; missing_amount alone → low; else none.
 */
export function riskLevelOf(reasons: RiskReason[]): RiskLevel {
  if (reasons.includes("critical_payment")) return "critical";
  if (reasons.includes("overdue")) return "high";
  if (reasons.includes("unsupported_currency")) return "unsupported_currency";
  if (
    reasons.includes("large_payment") ||
    reasons.includes("same_day_cluster") ||
    reasons.includes("negative_amount") ||
    reasons.includes("overpaid")
  )
    return "medium";
  if (reasons.includes("missing_amount")) return "low";
  return "none";
}

export function computeRisk(
  instances: RiskInputInstance[],
  todayISO: string,
  t: RiskThresholds,
): Map<string, { reasons: RiskReason[]; level: RiskLevel }> {
  const openByDate = new Map<string, number>();
  for (const i of instances) {
    if (!isOpen(i.status)) continue;
    openByDate.set(i.dueDate, (openByDate.get(i.dueDate) ?? 0) + 1);
  }
  const out = new Map<string, { reasons: RiskReason[]; level: RiskLevel }>();
  for (const i of instances) {
    const reasons: RiskReason[] = [];
    if (isOpen(i.status)) {
      if (i.amount == null) reasons.push("missing_amount");
      else if (i.amount < 0) reasons.push("negative_amount");
      else if (!isThresholdCurrency(i.currency)) {
        // PHASE 2.2 (T1-b): tutar var ama TRY değil (ya da para birimi bilinmiyor) — eşik
        // KARŞILAŞTIRILMAZ, TRY varsayılmaz, sessizce de geçilmez: ayrı gerekçe yazılır ve
        // risk_level olarak DB'ye 'unsupported_currency' iner.
        reasons.push("unsupported_currency");
      } else {
        if (i.amount >= t.critical) reasons.push("critical_payment");
        else if (i.amount >= t.large) reasons.push("large_payment");
      }
      // Yığılma ve gecikme para biriminden bağımsız olgulardır.
      if ((openByDate.get(i.dueDate) ?? 0) >= t.clusterCount) reasons.push("same_day_cluster");
      if (i.dueDate < todayISO) reasons.push("overdue");
    }
    // paid/partial only — amount unknown or negative is not comparable, never flagged as overpaid
    if (
      (i.status === "paid" || i.status === "partial") &&
      i.amount != null &&
      i.paidAmount != null &&
      i.amount >= 0 &&
      i.paidAmount > i.amount
    ) {
      reasons.push("overpaid");
    }
    out.set(i.id, { reasons, level: riskLevelOf(reasons) });
  }
  return out;
}

/**
 * Day-level flags for calendar/risk panels (calculation-rules thresholds).
 *
 * QA-F2: `knownSum` ondalık birikir. Bu toplam yalnız ekrana yazılmıyor — hemen aşağıda
 * `knownSum >= t.critical` eşiğini besliyor, yani `concentration`/`exposureBy` ile aynı
 * sınıfta: birikmiş ikili hata burada gösterilen bir haneyi değil, günün KRİTİK sayılıp
 * sayılmadığını çevirir. Ölçülen örnek: 173.885,27 + 21.752,99 + 47.810,90 + 6.550,84 kuruşu
 * kuruşuna 250.000,00 eder; aynı toplama float `+=` ile 249.999,99999999997 verir ve tam
 * eşikteki günü sessizce kritik olmaktan çıkarır. Yayımlanan tip değişmedi: düz sayı.
 *
 * PHASE 2.2 (T1-a) — PARA BİRİMİ. Eşikler `*_threshold_try`; bu yüzden `knownSum`, `large` ve
 * `critical` YALNIZ `currency === 'TRY'` açık kalemleri tartar. TRY-dışı (veya para birimi
 * bilinmeyen) açık kalemler bu üçünden DIŞARIDA tutulur, sessizce düşürülmez: `foreignCount`
 * onları sayar ve çağıran ekran "n kalem TRY-dışı" diyebilir. `count` ve `cluster` sayım
 * kurallarıdır, para biriminden bağımsız — her açık kalemi sayar.
 */
export interface DayFlags {
  cluster: boolean;
  large: boolean;
  critical: boolean;
  /** Yalnız TRY açık kalemlerin (amount > 0) toplamı. */
  knownSum: number;
  /** Günün TÜM açık kalemleri (para biriminden bağımsız). */
  count: number;
  /** TRY eşikleriyle karşılaştırılamadığı için knownSum/large/critical dışında bırakılan açık kalem sayısı. */
  foreignCount: number;
}

export function dayFlags(dayInstances: RiskInputInstance[], t: RiskThresholds): DayFlags {
  const open = dayInstances.filter((i) => isOpen(i.status));
  const comparable = open.filter((i) => isThresholdCurrency(i.currency));
  let knownSumDecimal = zero();
  for (const i of comparable) {
    if (i.amount != null && i.amount > 0) knownSumDecimal = knownSumDecimal.plus(decimal(i.amount));
  }
  const knownSum = money(knownSumDecimal);
  const anyCritical = comparable.some((i) => i.amount != null && i.amount >= t.critical);
  const anyLarge = comparable.some((i) => i.amount != null && i.amount >= t.large);
  return {
    count: open.length,
    knownSum,
    cluster: open.length >= t.clusterCount,
    large: anyLarge,
    critical: anyCritical || knownSum >= t.critical,
    foreignCount: open.length - comparable.length,
  };
}

/**
 * `dayFlags()`in ÖNCEDEN TOPLANMIŞ girdiyle çalışan hâli.
 *
 * ═══ NEDEN VAR ═══
 *
 * `/payments` panosu bir günün örneklerini artık tek tek çekmiyor; SQL onları güne göre
 * toplayıp geliyor. Toplanmış satırlardan risk kararını yeniden TÜRETMEK, iş kuralının ikinci
 * bir kopyasını yaratır ve iki kopya er geç ayrışır. Bu yüzden kural burada, `dayFlags()`in tam
 * yanında, TEK bir yerde duruyor; sayfa yalnız çağırıyor.
 *
 * ═══ EŞDEĞERLİK — üstteki `dayFlags()` NORMATİF REFERANSTIR ═══
 *
 *   dayFlags                                    dayFlagsFromAggregate
 *   ─────────────────────────────────────────   ─────────────────────────────────────
 *   open = instances.filter(isOpen)             openCount  (SQL: status in OPEN_STATUSES)
 *   comparable = open.filter(currency='TRY')    (SQL: … and currency = 'TRY' — flag_* süzgeci)
 *   count   = open.length                       openCount
 *   knownSum= Σ amount, TRY, amount != null &&>0 knownSum  (SQL: sum(amount) aynı süzgeçle)
 *   cluster = open.length >= clusterCount       openCount >= clusterCount
 *   anyLarge= comparable.some(a!=null&&a>=large) maxAmount >= large   (max yalnız TRY üzerinden)
 *   anyCrit = comparable.some(a!=null&&a>=crit)  maxAmount >= crit
 *   critical= anyCrit || knownSum >= crit       (maxAmount >= crit) || knownSum >= crit
 *   foreignCount = open.length - comparable.len foreignCount (SQL: count(*) filter (currency<>'TRY'))
 *
 * `some(i => i.amount >= E)` ile `max(amount) >= E` aynı önermedir: bir küme, ancak ve ancak
 * en büyük elemanı eşiği geçiyorsa eşiği geçen bir eleman içerir. null'lar SQL'de `max` tarafından
 * zaten yok sayılır, JS'te `a != null` süzgeciyle. Boş gün → `maxAmount = null` → her iki bayrak
 * da false; `some` da boş kümede false döner.
 *
 * PHASE 2.2 (T1-a): `knownSum` ve `maxAmount` SQL'de YALNIZ `currency = 'TRY'` satırlardan
 * gelmelidir (queries.ts `flag_known_sum` / `flag_max_amount`); `foreignCount` ise açık ve
 * TRY-dışı satır sayısıdır. Bu fonksiyon toplanmış girdiyi yeniden süzemez — süzgecin SQL'de
 * uygulanmış olması çağıranın sorumluluğudur ve `payment-day-flags-verify` bunu diferansiyel
 * olarak ölçer.
 *
 * `anyCritical` referansta olduğu için burada da DURUYOR, ama ölçüldüğünde şu çıktı:
 * **sonucu hiçbir girdide değiştiremiyor.** Kanıt tek satırlık — `anyCritical` true ise günde
 * `amount >= critical` olan bir kalem vardır; `critical > 0` iken o kalemin tutarı da pozitiftir,
 * yani `knownSum` toplamına GİRER ve diğer terimler negatif olamadığı için `knownSum >= critical`
 * zaten sağlanır. `critical <= 0` iken de `knownSum >= 0 >= critical`. İki dal her durumda aynı
 * cevabı verir (11.310 kombinasyonla tarandı, karşı örnek yok — `payment-day-flags-verify`).
 *
 * O hâlde neden duruyor: `knownSum`un tanımı (`amount > 0` süzgeci) değişirse eşdeğerlik biter ve
 * dal yeniden anlam kazanır. Referansta var, burada da var — sadeleştirmek ayrı bir karardır.
 * Buradan çıkan diğer sonuç: 44d9c5f'in `anyCritical`ı düşürmesi TEK BAŞINA bir hata değildi;
 * o commit'teki gerçek kayma `remaining` ile `'unknown'` idi.
 *
 * `knownSum` DAİMA `amount` üzerinden; `remaining` üzerinden DEĞİL. Panonun grafik ve KPI'ları
 * `remaining` ("hâlâ borçlu olunan baskı") kullanır ve bu ayrım bilinçlidir — risk eşiği ürün
 * kuralı olarak `amount`a bağlıdır, performans gerekçesiyle değiştirilemez.
 */
export function dayFlagsFromAggregate(
  day: { openCount: number; knownSum: number; maxAmount: number | null; foreignCount: number },
  t: RiskThresholds,
): DayFlags {
  const anyCritical = day.maxAmount != null && day.maxAmount >= t.critical;
  const anyLarge = day.maxAmount != null && day.maxAmount >= t.large;
  return {
    count: day.openCount,
    knownSum: day.knownSum,
    cluster: day.openCount >= t.clusterCount,
    large: anyLarge,
    critical: anyCritical || day.knownSum >= t.critical,
    foreignCount: day.foreignCount,
  };
}

/* ═══════════ Phase 4 — cashflow rules (pure) ═══════════ */

export interface CashMonth {
  monthStart: string; // YYYY-MM-01
  opening: number | null;
  income: number | null;
  expense: number | null;
  closing: number | null;
}

export interface ContinuityBreak {
  prevMonth: string;
  nextMonth: string;
  prevClosing: number | null;
  nextOpening: number | null;
  diff: number | null; // null when either side unknown
}

/** Flags breaks & gaps. NEVER mutates values (rule: flag, don't fix). */
export function findContinuityIssues(months: CashMonth[]): {
  breaks: ContinuityBreak[];
  gaps: Array<{ afterMonth: string; expected: string }>;
} {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  const breaks: ContinuityBreak[] = [];
  const gaps: Array<{ afterMonth: string; expected: string }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const expected = addMonths(a.monthStart, 1);
    if (b.monthStart !== expected) {
      gaps.push({ afterMonth: a.monthStart, expected });
      continue; // chain comparison only meaningful for consecutive months
    }
    if (a.closing == null || b.opening == null) {
      breaks.push({
        prevMonth: a.monthStart, nextMonth: b.monthStart,
        prevClosing: a.closing, nextOpening: b.opening, diff: null,
      });
    } else if (Math.abs(a.closing - b.opening) > 1) {
      breaks.push({
        prevMonth: a.monthStart, nextMonth: b.monthStart,
        prevClosing: a.closing, nextOpening: b.opening,
        diff: b.opening - a.closing,
      });
    }
  }
  return { breaks, gaps };
}

export interface Projection {
  series: Array<{ monthStart: string; closing: number | null; delta: number | null }>;
  firstNegativeMonth: string | null;
  worstMonth: string | null;
  worstBalance: number | null;
  longestNegativeRun: { length: number; from: string | null };
}

export function buildProjection(months: CashMonth[], negativeThreshold = 0): Projection {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  let firstNegativeMonth: string | null = null;
  let worstMonth: string | null = null;
  let worstBalance: number | null = null;
  let run = 0, best = 0, runFrom: string | null = null, bestFrom: string | null = null;
  const series = sorted.map((m) => {
    const delta = m.income != null && m.expense != null ? m.income - m.expense : null;
    if (m.closing != null) {
      if (m.closing < negativeThreshold && firstNegativeMonth == null) firstNegativeMonth = m.monthStart;
      if (worstBalance == null || m.closing < worstBalance) {
        worstBalance = m.closing;
        worstMonth = m.monthStart;
      }
      if (m.closing < 0) {
        if (run === 0) runFrom = m.monthStart;
        run++;
        if (run > best) { best = run; bestFrom = runFrom; }
      } else run = 0;
    } else run = 0; // unknown breaks a negative run (honest: can't claim continuity)
    return { monthStart: m.monthStart, closing: m.closing, delta };
  });
  return { series, firstNegativeMonth, worstMonth, worstBalance, longestNegativeRun: { length: best, from: bestFrom } };
}

export interface HorizonCard {
  horizonMonths: number;
  fromMonth: string;
  toMonth: string; // last month with data inside horizon
  endClosing: number | null;
  minClosing: number | null;
  minMonth: string | null;
  knownIncome: number;
  knownExpense: number;
  missingCount: number; // months lacking income or expense inside window
  firstNegativeInside: string | null;
  truncated: boolean; // data ends before horizon
}

export function horizonCards(
  months: CashMonth[],
  anchorMonthStart: string,
  horizons: number[] = [3, 6, 12, 24, 36],
): HorizonCard[] {
  const sorted = [...months].sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1));
  const startIdx = sorted.findIndex((m) => m.monthStart >= anchorMonthStart);
  const from = startIdx === -1 ? sorted[0]?.monthStart : sorted[startIdx].monthStart;
  return horizons.map((h) => {
    const endExclusive = addMonths(from, h);
    const win = sorted.filter((m) => m.monthStart >= from && m.monthStart < endExclusive);
    let minClosing: number | null = null, minMonth: string | null = null, firstNeg: string | null = null;
    // QA-F2: bu iki toplam yalnız GÖSTERİM içindir (hiçbir eşiği tetiklemez — dayFlags'in
    // aksine), yine de ondalık birikiyor ki ufuk kartındaki rakam Postgres sum() ile aynı olsun.
    let incomeDecimal = zero(), expenseDecimal = zero();
    let missingCount = 0;
    for (const m of win) {
      if (m.income == null || m.expense == null) missingCount++;
      if (m.income != null) incomeDecimal = incomeDecimal.plus(decimal(m.income));
      if (m.expense != null) expenseDecimal = expenseDecimal.plus(decimal(m.expense));
      if (m.closing != null) {
        if (m.closing < 0 && firstNeg == null) firstNeg = m.monthStart;
        if (minClosing == null || m.closing < minClosing) { minClosing = m.closing; minMonth = m.monthStart; }
      }
    }
    const last = win[win.length - 1];
    return {
      horizonMonths: h, fromMonth: from, toMonth: last?.monthStart ?? from,
      endClosing: last?.closing ?? null, minClosing, minMonth,
      knownIncome: money(incomeDecimal), knownExpense: money(expenseDecimal), missingCount,
      firstNegativeInside: firstNeg,
      truncated: win.length < h,
    };
  });
}

export interface ConcentrationEntry { key: string; sum: number; ratio: number; flagged: boolean }

/**
 * Faz 17: the accumulation is exact, the public shape is unchanged.
 *
 * This function decides whether a single customer carries more than `flagRatio` of all known
 * income — a threshold comparison, which is the one place a rounding error changes an ANSWER
 * rather than a displayed digit. It used to add hundreds of `cashflow_lines` amounts with
 * `+=` on floats and then divide; summing 20 000 rows of 0.07 that way yields
 * 1399.9999999999804 where Postgres `sum()` yields 1400.00 (measured). Totals are now
 * accumulated as decimals and rounded once at the end, so an entry sitting exactly on 0.40
 * is no longer flagged or spared by accumulated binary error.
 *
 * Callers and tests still receive plain numbers — the boundary types did not move.
 */
export function concentration(
  items: Array<{ key: string | null; amount: number | null }>,
  flagRatio = 0.4,
): { entries: ConcentrationEntry[]; knownTotal: number; unknownCount: number } {
  const sums = new Map<string, Decimal>();
  let knownTotal = zero();
  let unknownCount = 0;
  for (const it of items) {
    if (it.amount == null) { unknownCount++; continue; }
    const d = decimal(it.amount);
    if (d.lte(0)) continue; // negatives are not concentration; explicit 0 adds nothing
    knownTotal = knownTotal.plus(d);
    const k = it.key ?? "(atanmadı)";
    sums.set(k, (sums.get(k) ?? zero()).plus(d));
  }
  const entries = [...sums.entries()]
    .map(([key, sum]) => ({
      key,
      sum: money(sum),
      // ratioOrNull returns null when there is no denominator; "no known total" is not the
      // same statement as "0% concentration", but the published shape is a number, so the
      // null collapses to 0 here exactly as before rather than changing the contract.
      ratio: ratioOrNull(sum, knownTotal) ?? 0,
      flagged: false,
    }))
    .sort((a, b) => b.sum - a.sum)
    .map((e) => ({ ...e, flagged: e.ratio > flagRatio }));
  return { entries, knownTotal: money(knownTotal), unknownCount };
}
