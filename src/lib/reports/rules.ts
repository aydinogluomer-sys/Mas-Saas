// Report domain rules (Phase 6A). Pure & deterministic — sources:
// docs/calculation-rules.md + .claude/skills/mas-report-writer. Reports are
// decision-oriented summaries over ALREADY-MAPPED data. They NEVER mutate financial
// records and AI is commentary-only (buildCommentaryPrompt returns a prompt string,
// no API call, no mutation). Null amount stays "TUTAR EKSİK", never 0.

import { addDaysISO } from "@/lib/financing/rules";

/* ── timezone: "today" for reports is Europe/Istanbul (calculation-rules §status) ──
 * Re-exported from the shared time module (src/lib/time/istanbul.ts) — kept here so
 * existing callers importing from this file don't need to change. New payment-domain
 * code should import istanbulDateISO from "@/lib/time/istanbul" directly. */

export { istanbulDateISO } from "@/lib/time/istanbul";

/* ── shared shapes (plain data so builders stay unit-testable without a DB) ── */

export interface ReportInstance {
  name: string;
  dueDate: string; // ISO
  amount: number | null;
  status: string;
  riskLevel: string;
  riskReasons: string[];
}

export interface ReportMaturity {
  label: string;
  dueDate: string;
  amount: number | null;
  direction: "inflow" | "outflow" | "unknown";
  kind: "check" | "loan_installment";
}

const OPEN = new Set(["unpaid", "partial", "planned", "late"]);
const isOpen = (s: string) => OPEN.has(s);

function sumKnown(items: Array<{ amount: number | null }>): { total: number; missing: number } {
  let total = 0, missing = 0;
  for (const i of items) {
    if (i.amount == null) missing++;
    else if (i.amount > 0) total += i.amount;
  }
  return { total, missing };
}

const fmtTL = (n: number | null): string =>
  n == null ? "TUTAR EKSİK" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

/* ── 1) daily report ── */

export interface DailyReportInput {
  dueSoon: ReportInstance[]; // open instances due in [today, today+7]
  overdue: ReportInstance[]; // open instances due < today
  maturities: ReportMaturity[]; // checks + installments due in [today, today+7]
  criticalThreshold: number;
}

export interface DailyReport {
  date: string;
  dueToday: ReportInstance[];
  dueTomorrow: ReportInstance[];
  next7KnownTotal: number;
  next7MissingCount: number;
  overdueCount: number;
  overdueKnownTotal: number;
  checksNext7: ReportMaturity[];
  criticalItems: ReportInstance[];
  actions: string[];
  bodyMd: string;
}

export function buildDailyReport(input: DailyReportInput, todayISO: string): DailyReport {
  const tomorrow = addDaysISO(todayISO, 1);
  const dueToday = input.dueSoon.filter((i) => i.dueDate === todayISO);
  const dueTomorrow = input.dueSoon.filter((i) => i.dueDate === tomorrow);
  const { total: next7KnownTotal, missing: next7MissingCount } = sumKnown(input.dueSoon);
  const overdueKnown = sumKnown(input.overdue);
  const checksNext7 = input.maturities.filter((m) => m.kind === "check");
  const criticalItems = input.dueSoon.filter(
    (i) => i.amount != null && i.amount >= input.criticalThreshold && isOpen(i.status),
  );

  const actions: string[] = [];
  if (dueToday.length) actions.push(`Bugün ${dueToday.length} ödeme — nakit hazırla`);
  if (input.overdue.length) actions.push(`${input.overdue.length} geciken kalem — acil kontrol`);
  if (next7MissingCount) actions.push(`${next7MissingCount} kalemde tutar eksik — kaynağı doğrula`);
  if (criticalItems.length) actions.push(`${criticalItems.length} kritik ödeme (≥${fmtTL(input.criticalThreshold)}) — öncelik ver`);
  if (checksNext7.length) actions.push(`${checksNext7.length} çek 7 gün içinde vadesinde`);
  if (actions.length === 0) actions.push("Kritik aksiyon yok — rutin kontrol yeterli");

  const line = (i: ReportInstance) => `- ${i.dueDate} · ${i.name} · ${fmtTL(i.amount)}${i.riskLevel !== "none" ? ` · ⚠ ${i.riskLevel}` : ""}`;
  const bodyMd = [
    `# Günlük Rapor — ${todayISO}`,
    ``,
    `## Bugün (${dueToday.length})`,
    ...(dueToday.length ? dueToday.map(line) : ["- yok"]),
    ``,
    `## Yarın (${dueTomorrow.length})`,
    ...(dueTomorrow.length ? dueTomorrow.map(line) : ["- yok"]),
    ``,
    `## 7 gün bilinen toplam: ${fmtTL(next7KnownTotal)}${next7MissingCount ? ` · ${next7MissingCount} kalem tutar eksik` : ""}`,
    ``,
    `## Geciken (${input.overdue.length}) — bilinen ${fmtTL(overdueKnown.total)}`,
    ...(input.overdue.length ? input.overdue.slice(0, 10).map(line) : ["- yok"]),
    ``,
    `## 7 gün içindeki çekler (${checksNext7.length})`,
    ...(checksNext7.length ? checksNext7.map((m) => `- ${m.dueDate} · ${m.label} · ${fmtTL(m.amount)}`) : ["- yok"]),
    ``,
    `## Aksiyon listesi`,
    ...actions.map((a) => `- [ ] ${a}`),
  ].join("\n");

  return {
    date: todayISO, dueToday, dueTomorrow, next7KnownTotal, next7MissingCount,
    overdueCount: input.overdue.length, overdueKnownTotal: overdueKnown.total,
    checksNext7, criticalItems, actions, bodyMd,
  };
}

/* ── 2) weekly report (rolling 7 days) ── */

export interface WeeklyReportInput {
  weekInstances: ReportInstance[]; // open instances due in [today, today+7]
  maturitiesWeek: ReportMaturity[]; // checks + installments in [today, today+7]
  installmentsMonth: ReportMaturity[]; // loan installments due in current month
  riskDays: Array<{ date: string; cluster: boolean; critical: boolean; large: boolean; knownSum: number; count: number }>;
  largeThreshold: number;
}

export interface WeeklyReport {
  from: string;
  to: string;
  knownTotal: number;
  missingCount: number;
  largest: ReportInstance[];
  checkLoad: number;
  installmentLoadWeek: number;
  installmentLoadMonth: number;
  riskDays: WeeklyReportInput["riskDays"];
  actions: string[];
  bodyMd: string;
}

export function buildWeeklyReport(input: WeeklyReportInput, todayISO: string): WeeklyReport {
  const to = addDaysISO(todayISO, 7);
  const { total: knownTotal, missing: missingCount } = sumKnown(input.weekInstances);
  const largest = [...input.weekInstances]
    .filter((i) => i.amount != null && i.amount >= input.largeThreshold)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 5);
  const checkLoad = sumKnown(input.maturitiesWeek.filter((m) => m.kind === "check")).total;
  const installmentLoadWeek = sumKnown(input.maturitiesWeek.filter((m) => m.kind === "loan_installment")).total;
  const installmentLoadMonth = sumKnown(input.installmentsMonth).total;

  const actions: string[] = [];
  if (input.riskDays.length) actions.push(`${input.riskDays.length} riskli gün — yığılma/kritik kontrol`);
  if (missingCount) actions.push(`${missingCount} kalemde tutar eksik`);
  if (installmentLoadMonth > 0) actions.push(`Bu ay kredi taksit yükü ${fmtTL(installmentLoadMonth)}`);
  if (checkLoad > 0) actions.push(`Bu hafta çek yükü ${fmtTL(checkLoad)}`);
  if (actions.length === 0) actions.push("Hafta sakin — rutin hazırlık");

  const bodyMd = [
    `# Haftalık Rapor — ${todayISO} → ${to}`,
    ``,
    `## Bilinen ödeme yükü: ${fmtTL(knownTotal)}${missingCount ? ` · ${missingCount} eksik` : ""}`,
    `- çek yükü (hafta): ${fmtTL(checkLoad)}`,
    `- kredi taksiti (hafta): ${fmtTL(installmentLoadWeek)}`,
    `- kredi taksiti (ay): ${fmtTL(installmentLoadMonth)}`,
    ``,
    `## En büyük ödemeler`,
    ...(largest.length ? largest.map((i) => `- ${i.dueDate} · ${i.name} · ${fmtTL(i.amount)}`) : ["- yok"]),
    ``,
    `## Riskli günler (${input.riskDays.length})`,
    ...(input.riskDays.length
      ? input.riskDays.map((d) => `- ${d.date} · ${d.count} kalem · ${fmtTL(d.knownSum)}${d.critical ? " · KRİTİK" : ""}${d.cluster ? " · yığılma" : ""}`)
      : ["- yok"]),
    ``,
    `## Hazırlık aksiyonları`,
    ...actions.map((a) => `- [ ] ${a}`),
  ].join("\n");

  return {
    from: todayISO, to, knownTotal, missingCount, largest,
    checkLoad, installmentLoadWeek, installmentLoadMonth, riskDays: input.riskDays, actions, bodyMd,
  };
}

/* ── 3) monthly report ── */

export interface ConcentrationRow { key: string; amount: number }
export interface MonthlyReportInput {
  monthStart: string;
  knownTotal: number;
  knownRemaining: number;
  paidKnown: number;
  missingCount: number;
  totalCount: number;
  topPayments: ReportInstance[]; // pre-sorted desc by amount, top 10
  providerDist: ConcentrationRow[];
  categoryDist: ConcentrationRow[];
  ownerDist: ConcentrationRow[];
  checksInMonth: ReportMaturity[];
  installmentsInMonth: ReportMaturity[];
  cashMonth: { opening: number | null; income: number | null; expense: number | null; closing: number | null } | null;
  dataQualityIssues: string[];
}

export interface MonthlyReport {
  monthStart: string;
  paidUnpaidSplit: { paid: number; remaining: number };
  debtServiceKnown: number;
  bodyMd: string;
}

export function buildMonthlyReport(input: MonthlyReportInput): MonthlyReport {
  const debtServiceKnown =
    sumKnown(input.checksInMonth).total + sumKnown(input.installmentsInMonth).total;
  const cm = input.cashMonth;
  const distBlock = (title: string, rows: ConcentrationRow[]) =>
    [`### ${title}`, ...(rows.length ? rows.slice(0, 5).map((r) => `- ${r.key}: ${fmtTL(r.amount)}`) : ["- yok"])];

  const bodyMd = [
    `# Aylık Rapor — ${input.monthStart.slice(0, 7)}`,
    ``,
    ...(cm
      ? [
          `## Nakit akış`,
          `- devir: ${fmtTL(cm.opening)} · gelir: ${fmtTL(cm.income)} · gider: ${fmtTL(cm.expense)} · kasa: ${fmtTL(cm.closing)}`,
          ``,
        ]
      : []),
    `## Ödeme yükü`,
    `- bilinen toplam: ${fmtTL(input.knownTotal)}`,
    `- ödenen (bilinen): ${fmtTL(input.paidKnown)} · kalan (bilinen): ${fmtTL(input.knownRemaining)}`,
    `- kalem: ${input.totalCount} · tutar eksik: ${input.missingCount}`,
    `- borç servisi (çek+taksit, bilinen): ${fmtTL(debtServiceKnown)}`,
    ``,
    `## En büyük 10 ödeme`,
    ...(input.topPayments.length
      ? input.topPayments.map((i) => `- ${i.name} · ${fmtTL(i.amount)}${i.status === "paid" ? " · ✓ödendi" : ""}`)
      : ["- yok"]),
    ``,
    ...distBlock("Sağlayıcı dağılımı", input.providerDist),
    ``,
    ...distBlock("Kategori dağılımı", input.categoryDist),
    ``,
    ...distBlock("Sahip (owner) dağılımı", input.ownerDist),
    ``,
    `## Veri kalitesi`,
    ...(input.dataQualityIssues.length ? input.dataQualityIssues.map((d) => `- ${d}`) : ["- sorun yok"]),
  ].join("\n");

  return {
    monthStart: input.monthStart,
    paidUnpaidSplit: { paid: input.paidKnown, remaining: input.knownRemaining },
    debtServiceKnown, bodyMd,
  };
}

/* ── 4) debt-service × cashflow overlay ("eklensin") ── */

export interface CashMonthLite { monthStart: string; closing: number | null }
export interface DebtMonthLite { monthStart: string; knownOutflow: number; count: number; missingCount: number }

export interface OverlayRow {
  monthStart: string;
  closing: number | null;
  debtOutflow: number;
  debtCount: number;
  debtMissingCount: number;
  pressure: "none" | "watch" | "high";
}

/**
 * Overlays Phase-5 debt service (checks + installments due in a month) onto the
 * Phase-4 projected closing balance. Pressure: high = negatif kasa AND borç yükü var;
 * watch = pozitif ama borç ay kasasının >%25'i. Unknown amounts disclosed, never zeroed.
 */
export function overlayDebtService(
  months: CashMonthLite[],
  debt: DebtMonthLite[],
  watchRatio = 0.25,
): OverlayRow[] {
  const debtBy = new Map(debt.map((d) => [d.monthStart, d]));
  return [...months]
    .sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1))
    .map((m) => {
      const d = debtBy.get(m.monthStart);
      const debtOutflow = d?.knownOutflow ?? 0;
      let pressure: OverlayRow["pressure"] = "none";
      if (debtOutflow > 0) {
        if (m.closing != null && m.closing < 0) pressure = "high";
        else if (m.closing != null && m.closing > 0 && debtOutflow > m.closing * watchRatio) pressure = "watch";
        else pressure = "watch";
      }
      return {
        monthStart: m.monthStart,
        closing: m.closing,
        debtOutflow,
        debtCount: d?.count ?? 0,
        debtMissingCount: d?.missingCount ?? 0,
        pressure,
      };
    });
}

/* ── 5) AI commentary prompt (template only — NO API call, NO mutation) ── */

export interface CommentaryFacts {
  scope: "daily" | "weekly" | "monthly";
  period: string;
  deterministicFacts: string[]; // already-computed numbers only
}

/**
 * Returns a PROMPT STRING for an AI narrative layer. AI may explain these
 * pre-computed facts; it is explicitly forbidden from changing any value, marking
 * paid, or recomputing. This function never calls a model and never mutates.
 */
export function buildCommentaryPrompt(facts: CommentaryFacts): string {
  return [
    `Sen MAS Nakit Radar'ın yorum katmanısın. Aşağıdaki DETERMİNİSTİK gerçekleri`,
    `Türkçe, kısa ve operasyonel biçimde yorumla. KESİN KURAL: hiçbir değeri değiştirme,`,
    `yeniden hesaplama, "ödendi" işaretleme veya kayıt silme. Yalnızca zaten hesaplanmış`,
    `sayıları açıkla ve "sırada ne kontrol edilmeli" öner. Kaynak-of-truth veritabanıdır.`,
    ``,
    `Kapsam: ${facts.scope} · Dönem: ${facts.period}`,
    `Gerçekler:`,
    ...facts.deterministicFacts.map((f) => `- ${f}`),
  ].join("\n");
}

export { fmtTL as reportFmtTL };
