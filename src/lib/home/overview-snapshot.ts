// Faz 5 — Ana Ekran birleşik özet okuma modeli (41 sorgu → ≤2 sorgu).
//
// Önceki Ana Ekran açılışında 9 ayrı alan motoru (loadDecisionFacts, loadDataQualityCenter,
// loadDebtOverlay, listReports, deliveryCounts, loadCapacityModels, loadCostModels, loadCashMonths,
// loadThresholds) birbirinden habersiz çağrılıyor; aynı tablolar (cashflow_months 3 kez,
// capacity_models 4 kez, payment_instances 6 kez, mapping_reviews 5 kez) tekrar tekrar okunuyor ve
// toplam 41 veritabanı sorgusu atılıyordu.
//
// Bu modül finansal hesap kurallarının HİÇBİRİNİ yeniden yazmaz: para birimi politikası
// (sumKnownReporting, isReportingCurrency), nakit projeksiyonu (buildProjection, closingTrend),
// borç servisi (debtServiceByMonth, overlayDebtService), başabaş marjı (priceMargin), karar güveni
// (decisionConfidenceScore) ve kokpit sıralaması (pickHeadlineRisk, buildActions) kendi saf kural
// modüllerinden birebir çağrılır. Yalnızca SQL okumaları iki kompakt CTE sorgusunda toplanır ve
// numeric sütunlar JSON sınırında ::text olarak taşınıp moneyOrNull / rateOrNull ile çözümlenir.

import type { Pool } from "pg";
import type { ProofItem } from "@/components/facts/source-proof";
import { isReportingCurrency, sumKnownReporting } from "@/lib/currency-policy";
import { decisionConfidenceLabel, decisionConfidenceScore } from "@/lib/data-quality/rules";
import { withReadConnection } from "@/lib/db";
import { computeDualCashRunway, computeForwardCashRunway, type DecisionFact, type DualCashRunwayResult } from "@/lib/facts/engine";
import {
  countSeverity,
  hasRiskSeverity,
  ratioSeverity,
  sortBySeverity,
  type FactSeverity,
} from "@/lib/facts/rules";
import { debtServiceByMonth, type MaturityItem } from "@/lib/financing/rules";
import {
  buildActions,
  closingTrend,
  pickHeadlineRisk,
  type CockpitAction,
  type CockpitFacts,
} from "@/lib/home/cockpit";
import { intOrNull, moneyOrNull, rate, rateOrNull, sumMoney } from "@/lib/money";
import {
  loadCanonicalKpis,
  loadCanonicalOutflow7dKpi,
  type CanonicalKpiSnapshot,
  type CanonicalOutflow7dKpi,
} from "@/lib/metrics/canonical-kpis";
import { priceMargin } from "@/lib/production/rules";
import { buildProjection, concentration, remainingOpenAmount, type CashMonth } from "@/lib/radar/rules";
import { istanbulDateISO, overlayDebtService } from "@/lib/reports/rules";

const OPEN_STATUSES = new Set(["unpaid", "partial", "planned", "late"]);

const ACTION_FACT_KEY: Record<string, string> = {
  overdue: "overdue_payment_load",
  first_negative: "first_negative_month",
  debt_pressure: "debt_pressure_months",
  missing: "missing_amount_count",
  concentration: "top_customer_concentration",
  stale_rate: "stale_rate_flags",
};

const EXTERNAL_TYPE_LABEL: Record<string, string> = {
  interest_rate: "Faiz oranı",
  fx_rate: "Kur",
  inflation_rate: "Enflasyon",
  personnel_cost: "Personel maliyeti",
  energy_cost: "Enerji maliyeti",
  loan_rate: "Kredi oranı",
  other: "Diğer varsayım",
};

const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

export interface KnownOutflowBucket {
  total: number;
  count: number;
  missing: number;
  foreign: number;
}

export function computeKnownOutflow(
  rows: ReadonlyArray<{ amount: number | null; paidAmount?: number | null; status: string; currency?: string | null }>,
): KnownOutflowBucket {
  const open = rows.filter((r) => OPEN_STATUSES.has(r.status));
  const k = sumKnownReporting(
    open,
    (r) => remainingOpenAmount(r.amount, r.paidAmount ?? null, r.status),
    { positiveOnly: true },
  );
  return { total: k.total, count: open.length, missing: k.missing, foreign: k.foreignCount };
}

export interface OverviewRawPrimary {
  monthTotalCount: number;
  monthMissingCount: number;
  cashMonths: Array<{
    month_start: string;
    opening: string | null;
    income: string | null;
    expense: string | null;
    closing: string | null;
  }>;
  activeInstances: Array<{
    id: string;
    due_date: string;
    amount: string | null;
    paid_amount?: string | null;
    status: string;
    currency: string | null;
  }>;
  maturities: Array<{
    id: string;
    due: string;
    amount: string | null;
    direction: "inflow" | "outflow" | "unknown";
    kind: "check" | "loan_installment";
    label: string;
  }>;
  dq: {
    openReviewCount: number;
    highOpenCount: number;
    reconciliationSignalCount: number;
    missingAmountCount: number;
    externalPendingCount: number;
    capacityTotalCount: number;
    staleProductionRateCount: number;
    firstCapacityStale: boolean;
  };
}

export interface OverviewRawSecondary {
  incomeLines: Array<{ key: string | null; amount: string | null }>;
  costModels: Array<{
    break_even: string | null;
    akon_freze: string | null;
    akon_torna: string | null;
  }>;
  lastReport: { id: string; report_type: string; created_at: string } | null;
  reminderCounts: Array<{ status: string; n: number }>;
  approvedExternal: Array<{
    assumption_type: string;
    label: string;
    period_start: string | null;
    period_end: string | null;
    value_numeric: string;
    unit: string;
    currency: string;
    source_name: string;
    source_date: string;
  }>;
}

export interface OverviewPrimarySnapshot {
  today: string;
  hasData: boolean;
  headline: { text: string; tone: "neg" | "warn" | "pos" };
  dataQuality: {
    decisionConfidence: number;
    decisionConfidenceLabel: string;
    highOpenCount: number;
    missingAmountCount: number;
    openReviewCount: number;
    staleProductionRateCount: number;
    capacityTotalCount: number;
    firstCapacityStale: boolean;
  };
  todayOutflow: KnownOutflowBucket;
  weekOutflow: KnownOutflowBucket;
  overdueOutflow: KnownOutflowBucket;
  overdueCount: number;
  monthMissingCount: number;
  projection: ReturnType<typeof buildProjection>;
  runwayFact: {
    value: string;
    severity: FactSeverity;
    explanation: string;
  };
  dualRunway?: DualCashRunwayResult;
  weekTrendValues: number[];
  weekTrendOmitted: number;
  closingSeries: { values: number[]; unknownCount: number };
  debtPressureMonths: number;
  maturities: MaturityItem[];
}

export interface OverviewSecondarySnapshot {
  actions: CockpitAction[];
  proofByActionKey: Record<string, ProofItem[]>;
  lastReport: { id: string; report_type: string; created_at: string } | null;
  reminders: { pending: number; sent: number; failed: number; skipped: number };
  marginLoss: boolean;
  hasCapacityModel: boolean;
  staleProductionRate: boolean;
}

export interface OverviewSnapshot extends OverviewPrimarySnapshot, OverviewSecondarySnapshot {}

export function computeOverviewPrimary(
  raw: OverviewRawPrimary,
  todayISO: string,
): OverviewPrimarySnapshot {
  const monthStart = `${todayISO.slice(0, 7)}-01`;
  const weekEnd = addDays(todayISO, 6);

  const months: CashMonth[] = raw.cashMonths.map((m) => ({
    monthStart: m.month_start,
    opening: moneyOrNull(m.opening),
    income: moneyOrNull(m.income),
    expense: moneyOrNull(m.expense),
    closing: moneyOrNull(m.closing),
  }));

  const hasData = raw.monthTotalCount > 0 || months.length > 0;

  const decodedInstances = raw.activeInstances.map((r) => ({
    id: r.id,
    due_date: r.due_date,
    amount: moneyOrNull(r.amount),
    paidAmount: moneyOrNull(r.paid_amount ?? null),
    status: r.status,
    currency: r.currency,
  }));

  const todayRows = decodedInstances.filter((r) => r.due_date === todayISO);
  const weekRows = decodedInstances.filter((r) => r.due_date >= todayISO && r.due_date <= weekEnd);
  const overdueRows = decodedInstances.filter(
    (r) => r.due_date < todayISO && OPEN_STATUSES.has(r.status),
  );

  const todayOutflow = computeKnownOutflow(todayRows);
  const weekOutflow = computeKnownOutflow(weekRows);
  const overdueOutflow = computeKnownOutflow(overdueRows);

  const weekTrendValues = weekRows
    .filter((row) => row.amount != null && isReportingCurrency(row.currency))
    .map((row) => row.amount as number);
  const weekTrendOmitted = weekRows.length - weekTrendValues.length;
  const closingSeries = closingTrend(months);

  const maturities: MaturityItem[] = raw.maturities.map((m) => ({
    id: m.id,
    dueDate: m.due,
    amount: moneyOrNull(m.amount),
    direction: m.direction,
    kind: m.kind,
    label: m.label,
  }));

  const debt = debtServiceByMonth(maturities);
  const overlay = overlayDebtService(
    months.map((m) => ({ monthStart: m.monthStart, closing: m.closing })),
    debt.map((d) => ({
      monthStart: d.monthStart,
      knownOutflow: d.knownOutflow,
      count: d.count,
      missingCount: d.missingCount,
    })),
  );
  const debtPressureMonths = overlay.filter((o) => o.pressure === "high").length;

  const projection = buildProjection(months);
  const runway = computeForwardCashRunway(months, monthStart);
  const currentMonthRow = months.find((m) => m.monthStart >= monthStart) ?? months[0] ?? null;
  const dualRunway = computeDualCashRunway({
    months,
    anchorMonth: monthStart,
    todayISO,
    openingCash: currentMonthRow?.opening ?? currentMonthRow?.closing ?? null,
    minCashFloor: 0,
    datedFlows: [
      ...decodedInstances
        .filter((r) => OPEN_STATUSES.has(r.status) && isReportingCurrency(r.currency))
        .map((r) => ({
          dateISO: r.due_date,
          signedAmount: -(remainingOpenAmount(r.amount, r.paidAmount ?? null, r.status) ?? 0),
        })),
      ...maturities
        .filter((m) => m.amount != null)
        .map((m) => ({
          dateISO: m.dueDate,
          signedAmount: m.direction === "inflow" ? (m.amount ?? 0) : -(m.amount ?? 0),
        })),
    ],
  });
  const runwayFact = {
    value: runway.value,
    severity: runway.severity,
    explanation: runway.firstForwardNegativeMonth
      ? `Mevcut projeksiyonda kasa yaklaşık ${runway.runwayMonths} ay sonra negatif bölgeye geçiyor (${ym(runway.firstForwardNegativeMonth)}).`
      : `Mevcut ileri projeksiyon ufkunda (${runway.runwayMonths} ay) negatif kasa görünmüyor.`,
  };

  const decisionConfidence = decisionConfidenceScore({
    openReviewCount: raw.dq.openReviewCount,
    highOpenCount: raw.dq.highOpenCount,
    reconciliationSignalCount: raw.dq.reconciliationSignalCount,
    missingAmountCount: raw.dq.missingAmountCount,
    staleProductionRateCount: raw.dq.staleProductionRateCount,
    externalPendingCount: raw.dq.externalPendingCount,
  });

  const headline = pickHeadlineRisk({
    todayKnownOutflow: todayOutflow.total,
    todayCount: todayOutflow.count,
    todayMissing: todayOutflow.missing,
    next7KnownOutflow: weekOutflow.total,
    next7Count: weekOutflow.count,
    overdueCount: overdueOutflow.count,
    overdueKnownOutflow: overdueOutflow.total,
    firstNegativeMonth: projection.firstNegativeMonth,
    worstMonth: projection.worstMonth,
    worstBalance: projection.worstBalance,
    monthMissingCount: raw.monthMissingCount,
    topConcentration: null,
    debtPressureMonths,
    failedReminders: 0,
    staleProductionRate: raw.dq.firstCapacityStale,
  });

  return {
    today: todayISO,
    hasData,
    headline,
    dataQuality: {
      decisionConfidence,
      decisionConfidenceLabel: decisionConfidenceLabel(decisionConfidence),
      highOpenCount: raw.dq.highOpenCount,
      missingAmountCount: raw.dq.missingAmountCount,
      openReviewCount: raw.dq.openReviewCount,
      staleProductionRateCount: raw.dq.staleProductionRateCount,
      capacityTotalCount: raw.dq.capacityTotalCount,
      firstCapacityStale: raw.dq.firstCapacityStale,
    },
    todayOutflow,
    weekOutflow,
    overdueOutflow,
    overdueCount: overdueRows.length,
    monthMissingCount: raw.monthMissingCount,
    projection,
    runwayFact,
    dualRunway,
    weekTrendValues,
    weekTrendOmitted,
    closingSeries,
    debtPressureMonths,
    maturities,
  };
}

export function computeOverviewSecondary(
  primary: OverviewPrimarySnapshot,
  raw: OverviewRawSecondary,
): OverviewSecondarySnapshot {
  const todayISO = primary.today;
  const next30 = addDays(todayISO, 30);

  const costs = raw.costModels.map((c) => ({
    breakEven: rateOrNull(c.break_even),
    akonFreze: rateOrNull(c.akon_freze),
    akonTorna: rateOrNull(c.akon_torna),
  }));
  const marginLossCount = costs.filter(
    (c) => priceMargin(c.breakEven, c.akonFreze).loss || priceMargin(c.breakEven, c.akonTorna).loss,
  ).length;
  const marginLoss = marginLossCount > 0;

  const conc = concentration(
    raw.incomeLines.map((r) => ({ key: r.key, amount: moneyOrNull(r.amount) })),
  );
  const topConc = conc.entries[0]
    ? { key: conc.entries[0].key, ratio: conc.entries[0].ratio }
    : null;

  const reminderMap = new Map(raw.reminderCounts.map((x) => [x.status, intOrNull(x.n) ?? 0]));
  const reminders = {
    pending: reminderMap.get("pending") ?? 0,
    sent: reminderMap.get("sent") ?? 0,
    failed: reminderMap.get("failed") ?? 0,
    skipped: reminderMap.get("skipped") ?? 0,
  };

  const staleProductionRate = primary.dataQuality.firstCapacityStale;
  const cockpitFacts: CockpitFacts = {
    todayKnownOutflow: primary.todayOutflow.total,
    todayCount: primary.todayOutflow.count,
    todayMissing: primary.todayOutflow.missing,
    next7KnownOutflow: primary.weekOutflow.total,
    next7Count: primary.weekOutflow.count,
    overdueCount: primary.overdueOutflow.count,
    overdueKnownOutflow: primary.overdueOutflow.total,
    firstNegativeMonth: primary.projection.firstNegativeMonth,
    worstMonth: primary.projection.worstMonth,
    worstBalance: primary.projection.worstBalance,
    monthMissingCount: primary.monthMissingCount,
    topConcentration: topConc,
    debtPressureMonths: primary.debtPressureMonths,
    failedReminders: reminders.failed,
    staleProductionRate,
  };
  const actions = buildActions(cockpitFacts);

  const next30Maturities = primary.maturities.filter(
    (m) => m.dueDate >= todayISO && m.dueDate <= next30 && m.direction === "outflow",
  );
  const checkLoad30 = sumMoney(
    next30Maturities.filter((m) => m.kind === "check").map((m) => m.amount),
  );
  const loanLoad30 = sumMoney(
    next30Maturities.filter((m) => m.kind === "loan_installment").map((m) => m.amount),
  );

  const baseFacts: DecisionFact[] = [
    {
      key: "first_negative_month",
      title: "İlk negatif ay",
      value: ym(primary.projection.firstNegativeMonth),
      severity: hasRiskSeverity(primary.projection.firstNegativeMonth != null, "high"),
      explanation: primary.projection.firstNegativeMonth
        ? `Nakit projeksiyonu ${ym(primary.projection.firstNegativeMonth)} ayında eksiye düşüyor.`
        : "Nakit projeksiyonunda negatif ay görünmüyor.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "worst_cash_month",
      title: "En kötü kasa ayı",
      value: `${ym(primary.projection.worstMonth)} · ${fmt0(primary.projection.worstBalance)} TL`,
      severity: hasRiskSeverity((primary.projection.worstBalance ?? 0) < 0, "high"),
      explanation: "35 aylık cashflow satırlarından en düşük kapanış bakiyesi.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "cash_runway",
      title: "Nakit runway",
      value: primary.runwayFact.value,
      severity: primary.runwayFact.severity,
      explanation: primary.runwayFact.explanation,
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "overdue_payment_load",
      title: "Geciken ödeme",
      value: String(primary.overdueCount),
      severity: countSeverity(primary.overdueCount, 1, 5),
      explanation:
        primary.overdueCount > 0
          ? "Açık/gecikmiş ödeme aksiyonu gerekiyor."
          : "Gecikmiş açık ödeme yok.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/payments",
    },
    {
      key: "missing_amount_count",
      title: "Eksik tutar",
      value: String(primary.monthMissingCount),
      severity: countSeverity(primary.monthMissingCount, 1, 8),
      explanation: "Eksik tutar bilinmeyendir; hiçbir hesapta 0 sayılmaz.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/payments",
    },
    {
      key: "debt_pressure_months",
      title: "Borç baskılı ay",
      value: String(primary.debtPressureMonths),
      severity: countSeverity(primary.debtPressureMonths, 1, 4),
      explanation: "Çek/kredi yükünün negatif kasa ile üst üste geldiği aylar.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/finance",
    },
    {
      key: "check_maturity_30d",
      title: "30 gün çek yükü",
      value: `${fmt0(checkLoad30)} TL`,
      severity: hasRiskSeverity(checkLoad30 > 0, "medium"),
      explanation: "Önümüzdeki 30 gün içindeki açık çek çıkışları.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/finance",
    },
    {
      key: "loan_service_30d",
      title: "30 gün kredi taksiti",
      value: `${fmt0(loanLoad30)} TL`,
      severity: hasRiskSeverity(loanLoad30 > 0, "medium"),
      explanation: "Önümüzdeki 30 gün içindeki kredi taksit yükü.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/finance",
    },
    {
      key: "top_customer_concentration",
      title: "Müşteri yoğunlaşması",
      value: topConc ? `${topConc.key} · %${Math.round(topConc.ratio * 100)}` : "—",
      severity: ratioSeverity(topConc?.ratio ?? null, 0.4, 0.6),
      explanation: "Nakit girişlerinin tek müşteriye bağlılık oranı.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "production_margin_loss",
      title: "Zararına üretim fiyatı",
      value: String(marginLossCount),
      severity: countSeverity(marginLossCount, 1, 3),
      explanation:
        "Akon TL/dk fiyatı, ilgili maliyet modelinin başabaşının altında kalan operasyonlar.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/production",
    },
    {
      key: "stale_rate_flags",
      title: "Eski üretim tarifesi",
      value: String(primary.dataQuality.staleProductionRateCount),
      severity: countSeverity(primary.dataQuality.staleProductionRateCount, 1, 2),
      explanation: "Kapasite TL/dk oranı güncel yılın gerisinde kalan modeller.",
      confidence: "needs_review",
      freshness: todayISO,
      sourceHref: "/production",
    },
    {
      key: "unresolved_review_count",
      title: "Açık inceleme",
      value: String(primary.dataQuality.openReviewCount),
      severity: countSeverity(primary.dataQuality.openReviewCount, 1, 10),
      explanation: "Karar almayı engelleyebilecek açık/ret mapping review kayıtları.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/data/imports",
    },
  ];

  const externalFacts: DecisionFact[] = raw.approvedExternal.map((a) => {
    const label = EXTERNAL_TYPE_LABEL[a.assumption_type] ?? a.assumption_type;
    const period = a.period_start
      ? ` Dönem: ${a.period_start}${a.period_end ? `..${a.period_end}` : ""}.`
      : "";
    const formatted = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 }).format(
      rate(a.value_numeric),
    );
    const currency = a.currency && a.currency !== "TRY" ? ` ${a.currency}` : "";
    return {
      key: `external_${a.assumption_type}`,
      title: `Dış varsayım: ${label}`,
      value: `${formatted} ${a.unit}${currency}`,
      severity: "low",
      explanation: `Onaylı dış varsayım: ${a.label}. Kaynak: ${a.source_name} / ${a.source_date}.${period} Finansal kayıt değiştirmez.`,
      confidence: "source",
      freshness: a.source_date,
      sourceHref: "/data/assumptions",
    };
  });

  const decisionFacts = sortBySeverity([...baseFacts, ...externalFacts]);

  const proofByActionKey: Record<string, ProofItem[]> = {};
  for (const action of actions) {
    const fact =
      decisionFacts.find((f) => f.key === ACTION_FACT_KEY[action.key]) ??
      decisionFacts.find((f) => f.sourceHref === action.evidenceHref);
    proofByActionKey[action.key] = fact
      ? [
          {
            key: fact.key,
            title: fact.title,
            value: fact.value,
            confidence: fact.confidence,
            freshness: fact.freshness,
            explanation: fact.explanation,
            sourceHref: fact.sourceHref,
          },
        ]
      : [];
  }

  return {
    actions,
    proofByActionKey,
    lastReport: raw.lastReport,
    reminders,
    marginLoss,
    hasCapacityModel: primary.dataQuality.capacityTotalCount > 0,
    staleProductionRate,
  };
}

let cachedPrimary: { key: string; freshUntil: number; expiresAt: number; value: OverviewPrimarySnapshot } | null = null;
let cachedSecondary: { key: string; freshUntil: number; expiresAt: number; value: OverviewSecondarySnapshot } | null = null;
let revalidatingOverview: Promise<void> | null = null;
const OVERVIEW_FRESH_TTL_MS = 15_000;
const OVERVIEW_STALE_TTL_MS = 3_600_000;

function canUseRuntimeOverviewCache(pool: Pick<Pool, "query">): boolean {
  return process.env.VITEST !== "true" && Boolean(global.__masPool) && (pool as unknown) === global.__masPool;
}

function triggerBackgroundOverviewRevalidate(pool: Pick<Pool, "query">, todayISO: string): void {
  if (revalidatingOverview) return;
  revalidatingOverview = (async () => {
    try {
      const p = await fetchOverviewPrimaryUncached(pool, todayISO);
      if (p.hasData) {
        await fetchOverviewSecondaryUncached(pool, p);
      }
    } catch {
      // Background SWR refresh failure keeps existing stale snapshot until next cycle.
    } finally {
      revalidatingOverview = null;
    }
  })();
}

export function getWarmOverviewPair(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): { primary: OverviewPrimarySnapshot; secondary: OverviewSecondarySnapshot | null } | null {
  if (!canUseRuntimeOverviewCache(pool) || !cachedPrimary || cachedPrimary.key !== todayISO) {
    return null;
  }
  const now = Date.now();
  if (now >= cachedPrimary.expiresAt) {
    return null;
  }
  if (!cachedPrimary.value.hasData) {
    if (now >= cachedPrimary.freshUntil) triggerBackgroundOverviewRevalidate(pool, todayISO);
    return { primary: cachedPrimary.value, secondary: null };
  }
  const secKey = `${cachedPrimary.value.headline.text}:${cachedPrimary.value.dataQuality.decisionConfidence}`;
  if (!cachedSecondary || cachedSecondary.key !== secKey || now >= cachedSecondary.expiresAt) {
    return null;
  }
  if (now >= cachedPrimary.freshUntil || now >= cachedSecondary.freshUntil) {
    triggerBackgroundOverviewRevalidate(pool, todayISO);
  }
  return { primary: cachedPrimary.value, secondary: cachedSecondary.value };
}

export async function loadOverviewPrimary(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<OverviewPrimarySnapshot> {
  const now = Date.now();
  if (canUseRuntimeOverviewCache(pool) && cachedPrimary && cachedPrimary.key === todayISO && cachedPrimary.expiresAt > now) {
    if (now >= cachedPrimary.freshUntil) {
      triggerBackgroundOverviewRevalidate(pool, todayISO);
    }
    return cachedPrimary.value;
  }
  return fetchOverviewPrimaryUncached(pool, todayISO);
}

async function fetchOverviewPrimaryUncached(
  pool: Pick<Pool, "query">,
  todayISO: string,
): Promise<OverviewPrimarySnapshot> {
  const monthStart = `${todayISO.slice(0, 7)}-01`;
  const weekEnd = addDays(todayISO, 6);

  const res = await pool.query(
    `with month_stats as (
       select
         count(*)::int as total_count,
         count(*) filter (where amount is null and status <> 'cancelled')::int as missing_count
       from public.payment_instances
       where instance_month = $2::date
     ),
     cash_months as (
       select
         to_char(month_start, 'YYYY-MM-DD') as month_start,
         opening_balance::text as opening,
         projected_income::text as income,
         projected_expense::text as expense,
         closing_balance::text as closing
       from public.cashflow_months
       order by month_start
     ),
     active_instances as (
       select
         i.id::text as id,
         to_char(i.due_date, 'YYYY-MM-DD') as due_date,
         i.amount::text as amount,
         i.paid_amount::text as paid_amount,
         i.status,
         i.currency
       from public.payment_instances i
       where (i.due_date >= $1::date and i.due_date <= $3::date)
          or (i.due_date < $1::date and i.status in ('unpaid', 'partial', 'planned', 'late'))
       order by i.due_date, i.amount desc nulls last
     ),
     maturities as (
       select
         'chk:' || c.id::text as id,
         to_char(c.maturity_date, 'YYYY-MM-DD') as due,
         c.amount::text as amount,
         c.direction::text as direction,
         'check'::text as kind,
         coalesce(c.counterparty_label, 'çek') as label
       from public.checks c
       where c.status in ('planned', 'unknown') and c.archived_at is null
       union all
       select
         'ins:' || li.id::text as id,
         to_char(li.due_date, 'YYYY-MM-DD') as due,
         li.amount::text as amount,
         'outflow'::text as direction,
         'loan_installment'::text as kind,
         l.name as label
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
       where li.status in ('planned', 'unpaid', 'partial', 'late') and l.archived_at is null
     ),
     review_agg as (
       select
         count(*) filter (where status in ('open', 'rejected'))::int as open_review_count,
         count(*) filter (where status in ('open', 'rejected') and severity in ('critical', 'high'))::int as high_open_count,
         count(*) filter (
           where status in ('open', 'rejected')
             and issue_type in ('cashflow_identity_mismatch', 'continuity_break', 'month_gap')
         )::int as reconciliation_signal_count
       from public.mapping_reviews
     ),
     cap_agg as (
       select
         count(*)::int as capacity_total_count,
         count(*) filter (where is_stale_rate)::int as stale_rate_count,
         coalesce((array_agg(is_stale_rate order by created_at))[1], false) as first_is_stale
       from public.capacity_models
     )
     select
       (select total_count from month_stats) as month_total_count,
       (select missing_count from month_stats) as month_missing_count,
       coalesce((select jsonb_agg(to_jsonb(cm)) from cash_months cm), '[]'::jsonb) as cash_months,
       coalesce((select jsonb_agg(to_jsonb(ai)) from active_instances ai), '[]'::jsonb) as active_instances,
       coalesce((select jsonb_agg(to_jsonb(mt)) from maturities mt), '[]'::jsonb) as maturities,
       (select open_review_count from review_agg) as open_review_count,
       (select high_open_count from review_agg) as high_open_count,
       (select reconciliation_signal_count from review_agg) as reconciliation_signal_count,
       (
         (select count(*)::int from public.payment_instances where amount is null and status in ('unpaid', 'partial', 'planned', 'late')) +
         (select count(*)::int from public.cashflow_lines where amount is null)
       )::int as missing_amount_count,
       (select count(*)::int from public.external_assumptions where review_status = 'pending_review') as external_pending_count,
       (select capacity_total_count from cap_agg) as capacity_total_count,
       (select stale_rate_count from cap_agg) as stale_rate_count,
       (select first_is_stale from cap_agg) as first_is_stale`,
    [todayISO, monthStart, weekEnd],
  );

  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  const computed = computeOverviewPrimary(
    {
      monthTotalCount: intOrNull(row.month_total_count as number) ?? 0,
      monthMissingCount: intOrNull(row.month_missing_count as number) ?? 0,
      cashMonths: (row.cash_months as OverviewRawPrimary["cashMonths"] | undefined) ?? [],
      activeInstances:
        (row.active_instances as OverviewRawPrimary["activeInstances"] | undefined) ?? [],
      maturities: (row.maturities as OverviewRawPrimary["maturities"] | undefined) ?? [],
      dq: {
        openReviewCount: intOrNull(row.open_review_count as number) ?? 0,
        highOpenCount: intOrNull(row.high_open_count as number) ?? 0,
        reconciliationSignalCount: intOrNull(row.reconciliation_signal_count as number) ?? 0,
        missingAmountCount: intOrNull(row.missing_amount_count as number) ?? 0,
        externalPendingCount: intOrNull(row.external_pending_count as number) ?? 0,
        capacityTotalCount: intOrNull(row.capacity_total_count as number) ?? 0,
        staleProductionRateCount: intOrNull(row.stale_rate_count as number) ?? 0,
        firstCapacityStale: Boolean(row.first_is_stale),
      },
    },
    todayISO,
  );
  if (canUseRuntimeOverviewCache(pool)) {
    const now = Date.now();
    cachedPrimary = {
      key: todayISO,
      freshUntil: now + OVERVIEW_FRESH_TTL_MS,
      expiresAt: now + OVERVIEW_STALE_TTL_MS,
      value: computed,
    };
  }
  return computed;
}

export async function loadOverviewSecondary(
  pool: Pick<Pool, "query">,
  primary: OverviewPrimarySnapshot,
): Promise<OverviewSecondarySnapshot> {
  const secKey = `${primary.headline.text}:${primary.dataQuality.decisionConfidence}`;
  const now = Date.now();
  if (canUseRuntimeOverviewCache(pool) && cachedSecondary && cachedSecondary.key === secKey && cachedSecondary.expiresAt > now) {
    if (now >= cachedSecondary.freshUntil) {
      triggerBackgroundOverviewRevalidate(pool, istanbulDateISO());
    }
    return cachedSecondary.value;
  }
  return fetchOverviewSecondaryUncached(pool, primary);
}

async function fetchOverviewSecondaryUncached(
  pool: Pick<Pool, "query">,
  primary: OverviewPrimarySnapshot,
): Promise<OverviewSecondarySnapshot> {
  const secKey = `${primary.headline.text}:${primary.dataQuality.decisionConfidence}`;
  const res = await pool.query(
    `with income_lines as (
       select
         coalesce(p.name, cl.label) as key,
         cl.amount::text as amount
       from public.cashflow_lines cl
       left join public.parties p on p.id = cl.party_id
       where cl.line_type = 'customer_income'
     ),
     cost_rows as (
       select
         break_even_tl_per_min::text as break_even,
         akon_freze_tl_per_min::text as akon_freze,
         akon_torna_tl_per_min::text as akon_torna
       from public.cost_models
       order by scenario_type
     ),
     latest_report as (
       select
         id::text as id,
         report_type,
         to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at
       from public.reports
       order by created_at desc
       limit 1
     ),
     reminder_agg as (
       select status, count(*)::int as n
       from public.reminder_deliveries
       group by status
     ),
     approved_ext as (
       select distinct on (assumption_type)
         assumption_type,
         label,
         to_char(period_start, 'YYYY-MM-DD') as period_start,
         to_char(period_end, 'YYYY-MM-DD') as period_end,
         value_numeric::text as value_numeric,
         unit,
         currency,
         source_name,
         to_char(source_date, 'YYYY-MM-DD') as source_date
       from public.external_assumptions
       where review_status = 'approved' and archived_at is null
       order by assumption_type, source_date desc, created_at desc
       limit 12
     )
     select
       coalesce((select jsonb_agg(to_jsonb(il)) from income_lines il), '[]'::jsonb) as income_lines,
       coalesce((select jsonb_agg(to_jsonb(cr)) from cost_rows cr), '[]'::jsonb) as cost_models,
       (select to_jsonb(lr) from latest_report lr) as last_report,
       coalesce((select jsonb_agg(to_jsonb(ra)) from reminder_agg ra), '[]'::jsonb) as reminder_counts,
       coalesce((select jsonb_agg(to_jsonb(ae)) from approved_ext ae), '[]'::jsonb) as approved_external`,
  );

  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  const computed = computeOverviewSecondary(primary, {
    incomeLines: (row.income_lines as OverviewRawSecondary["incomeLines"] | undefined) ?? [],
    costModels: (row.cost_models as OverviewRawSecondary["costModels"] | undefined) ?? [],
    lastReport: (row.last_report as OverviewRawSecondary["lastReport"] | null) ?? null,
    reminderCounts:
      (row.reminder_counts as OverviewRawSecondary["reminderCounts"] | undefined) ?? [],
    approvedExternal:
      (row.approved_external as OverviewRawSecondary["approvedExternal"] | undefined) ?? [],
  });
  if (canUseRuntimeOverviewCache(pool)) {
    const now = Date.now();
    cachedSecondary = {
      key: secKey,
      freshUntil: now + OVERVIEW_FRESH_TTL_MS,
      expiresAt: now + OVERVIEW_STALE_TTL_MS,
      value: computed,
    };
  }
  return computed;
}

export async function loadOverviewSnapshot(
  pool: Pool,
  todayISO = istanbulDateISO(),
): Promise<OverviewSnapshot> {
  return withReadConnection(pool, async (db) => {
    const primary = await loadOverviewPrimary(db, todayISO);
    if (!primary.hasData) {
      return {
        ...primary,
        actions: [],
        proofByActionKey: {},
        lastReport: null,
        reminders: { pending: 0, sent: 0, failed: 0, skipped: 0 },
        marginLoss: false,
        hasCapacityModel: false,
        staleProductionRate: false,
      };
    }
    const secondary = await loadOverviewSecondary(db, primary);
    return { ...primary, ...secondary };
  });
}

let cachedCanonical: {
  key: string;
  freshUntil: number;
  expiresAt: number;
  value: CanonicalKpiSnapshot;
} | null = null;

/**
 * F-36: Loads canonical verified KPIs (`treasury_position_summary`, `receivables_open`,
 * `payables_open`, and 7-day remaining payment outflows) for the Ana Ekran cockpit,
 * keeping `loadOverviewSnapshot`'s 2-query contract untouched.
 */
export async function loadOverviewCanonicalKpis(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<CanonicalKpiSnapshot> {
  const now = Date.now();
  if (
    canUseRuntimeOverviewCache(pool) &&
    cachedCanonical &&
    cachedCanonical.key === todayISO &&
    cachedCanonical.expiresAt > now
  ) {
    return cachedCanonical.value;
  }
  const value = await loadCanonicalKpis(pool, todayISO);
  if (canUseRuntimeOverviewCache(pool)) {
    cachedCanonical = {
      key: todayISO,
      freshUntil: now + OVERVIEW_FRESH_TTL_MS,
      expiresAt: now + OVERVIEW_STALE_TTL_MS,
      value,
    };
  }
  return value;
}

export async function loadOverviewCanonicalOutflow7d(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<CanonicalOutflow7dKpi> {
  return loadCanonicalOutflow7dKpi(pool, todayISO);
}


