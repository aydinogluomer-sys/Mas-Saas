// Faz 5 & M-01 / M-12 — Ana Ekran birleşik özet okuma modeli (≤2 tekil CTE sorgusu, sıfır bellek önbelleği).
//
// M-01 gereği modül seviyesi JS bellek önbellekleri (cachedPrimary, cachedSecondary, cachedCanonical)
// tamamen kaldırılmıştır: her şirket/şube geçişi (EntitySwitcher) ve her veritabanı mutasyonu
// gecikmesiz olarak canlı veriyi yansıtır.
//
// Bu modül finansal hesap kurallarının HİÇBİRİNİ yeniden yazmaz: para birimi politikası
// (sumKnownReporting, isReportingCurrency), nakit projeksiyonu (buildProjection, closingTrend),
// borç servisi (debtServiceByMonth, overlayDebtService), başabaş marjı (priceMargin), karar güveni
// (decisionConfidenceScore) ve 11 CFO kokpit kartı (buildExecutiveCockpitCards) kendi saf kural
// modüllerinden birebir çağrılır.

import type { Pool } from "pg";
import type { ProofItem } from "@/components/facts/source-proof";
import type { ChartModel, ChartPoint } from "@/lib/analytics/chart";
import { isReportingCurrency, sumKnownReporting } from "@/lib/currency-policy";
import { decisionConfidenceLabel, decisionConfidenceScore } from "@/lib/data-quality/rules";
import { withReadConnection } from "@/lib/db";
import {
  computeDualCashRunway,
  computeForwardCashRunway,
  type DecisionFact,
  type DualCashRunwayResult,
} from "@/lib/facts/engine";
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
  buildExecutiveCockpitCards,
  closingTrend,
  pickHeadlineRisk,
  type CockpitAction,
  type CockpitFacts,
  type ExecutiveCockpitCard,
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
const CONFIRMED_FORECAST_KINDS = new Set(["invoice", "check", "loan_installment"]);

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
const round2 = (n: number) => Math.round(n * 100) / 100;

export type OverviewChartCurrency = "CONSOLIDATED" | "TRY" | "USD" | "EUR";

export interface OverviewCurrencyChartBundle {
  balanceChart: ChartModel;
  pressureChart: ChartModel;
}

export interface KnownOutflowBucket {
  total: number;
  count: number;
  missing: number;
  foreign: number;
}

export function computeKnownOutflow(
  rows: ReadonlyArray<{
    amount: number | null;
    paidAmount?: number | null;
    status: string;
    currency?: string | null;
  }>,
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
  /** M-12 optional live treasury & 13W forecast enrichments (backwards-compatible) */
  treasuryRows?: Array<Record<string, unknown>>;
  fxRates?: Array<{
    base_currency: string;
    rate: string;
    rate_date: string;
  }>;
  forecastRows?: Array<{
    flow_date: string;
    currency: string;
    source_kind: string;
    inflow: string;
    outflow: string;
    net_flow: string;
    item_count: number;
  }>;
  checkPortfolio?: Array<{
    status: string;
    direction: string;
    currency: string;
    cnt: number;
    total_amount: string;
  }>;
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
  /** M-12 optional working capital, credit, covenant, budget & exception enrichments */
  wcRow?: Record<string, unknown> | null;
  arRows?: Array<{
    currency: string;
    total_open: string;
    overdue_open: string;
    item_count: number;
    overdue_count: number;
  }>;
  apRows?: Array<{
    currency: string;
    total_open: string;
    overdue_open: string;
    item_count: number;
    overdue_count: number;
  }>;
  facilityRows?: Array<{
    currency: string;
    limit_sum: string;
    available_sum: string;
    drawn_sum: string;
  }>;
  covenantCounts?: {
    active_count?: number;
    breached_count?: number;
  } | null;
  budgetAgg?: {
    measured_count?: number;
    over_count?: number;
    net_variance_try?: string | null;
  } | null;
  exceptionCounts?: {
    pending_approvals?: number;
    unmatched_bank_tx?: number;
    critical_alerts?: number;
    open_alerts?: number;
  } | null;
  fxExposureRows?: Array<{
    currency: string;
    net_position_native: string;
    spot_rate_to_try: string | null;
    net_position_try: string | null;
  }>;
}

export interface OverviewHeroPrimary {
  freeCashConsolidatedTry: number | null;
  freeCashTryOnly: number | null;
  fxCashTryEquivalent: number;
  cashByCurrency: Record<"TRY" | "USD" | "EUR", number | null>;
  unknownOpeningCount: number;
  activeAccountCount: number;
  fxRateMap: Record<string, number>;
  fxRateSummary: string | null;
  minCash13wTry: number | null;
  minCash13wDate: string | null;
  netFlow13wTry: number | null;
  trajectory13wValues: number[];
  checkPortfolioInflowTry: number;
  checkCollateralTry: number;
  checkIssuedOutflowTry: number;
  checkEndorsedRiskTry: number;
  checkBouncedCount: number;
}

export interface OverviewHeroSecondary {
  netWorkingCapitalTry: number | null;
  receivablesOpenTry: number | null;
  payablesOpenTry: number | null;
  overdueReceivablesTry: number | null;
  overdueReceivablesCount: number;
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  cccDays: number | null;
  cycleExclInventoryDays: number | null;
  facilityLimitTry: number | null;
  facilityAvailableTry: number | null;
  covenantActiveCount: number;
  covenantBreachedCount: number;
  pendingApprovalsCount: number;
  unmatchedBankTxCount: number;
  criticalControlAlertCount: number;
  openControlAlertCount: number;
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
  heroPrimary: OverviewHeroPrimary;
  chartsByCurrency: Record<OverviewChartCurrency, OverviewCurrencyChartBundle>;
}

export interface OverviewSecondarySnapshot {
  actions: CockpitAction[];
  proofByActionKey: Record<string, ProofItem[]>;
  lastReport: { id: string; report_type: string; created_at: string } | null;
  reminders: { pending: number; sent: number; failed: number; skipped: number };
  marginLoss: boolean;
  hasCapacityModel: boolean;
  staleProductionRate: boolean;
  heroSecondary: OverviewHeroSecondary;
  cockpitCards: ExecutiveCockpitCard[];
}

export interface OverviewSnapshot extends OverviewPrimarySnapshot, OverviewSecondarySnapshot {}

function buildOverviewChartsByCurrency(params: {
  todayISO: string;
  months: CashMonth[];
  forecastRows: NonNullable<OverviewRawPrimary["forecastRows"]>;
  fxRateMap: Record<string, number>;
  freeCashConsolidatedTry: number | null;
  cashByCurrency: Record<"TRY" | "USD" | "EUR", number | null>;
  fallbackOpeningTry: number | null;
}): Record<OverviewChartCurrency, OverviewCurrencyChartBundle> {
  const {
    todayISO,
    months,
    forecastRows,
    fxRateMap,
    freeCashConsolidatedTry,
    cashByCurrency,
    fallbackOpeningTry,
  } = params;

  const convert = (amount: number, rowCcy: string, target: OverviewChartCurrency): number | null => {
    if (target === "CONSOLIDATED") {
      if (rowCcy === "TRY") return amount;
      const r = fxRateMap[rowCcy];
      return r && r > 0 ? round2(amount * r) : null;
    }
    return rowCcy === target ? amount : null;
  };

  const buildForMode = (mode: OverviewChartCurrency): OverviewCurrencyChartBundle => {
    const currencyCode = mode === "CONSOLIDATED" ? "CONSOLIDATED" : mode;
    const modeLabel =
      mode === "CONSOLIDATED"
        ? "Konsolide ₺ (TCMB)"
        : mode === "TRY"
          ? "Türk Lirası (TRY)"
          : mode === "USD"
            ? "Amerikan Doları (USD)"
            : "Euro (EUR)";

    // Aggregate daily flows for this currency mode
    const byDate = new Map<
      string,
      { confirmedOut: number; projectedOut: number; inflow: number; net: number; count: number }
    >();

    for (const row of forecastRows) {
      const ccy = row.currency || "TRY";
      const rawIn = moneyOrNull(row.inflow) ?? 0;
      const rawOut = moneyOrNull(row.outflow) ?? 0;
      const rawNet = moneyOrNull(row.net_flow) ?? 0;
      const convIn = convert(rawIn, ccy, mode);
      const convOut = convert(rawOut, ccy, mode);
      const convNet = convert(rawNet, ccy, mode);
      if (convIn == null && convOut == null && convNet == null) continue;

      const cur = byDate.get(row.flow_date) ?? {
        confirmedOut: 0,
        projectedOut: 0,
        inflow: 0,
        net: 0,
        count: 0,
      };
      const outVal = convOut ?? 0;
      if (CONFIRMED_FORECAST_KINDS.has(row.source_kind)) {
        cur.confirmedOut = round2(cur.confirmedOut + outVal);
      } else {
        cur.projectedOut = round2(cur.projectedOut + outVal);
      }
      cur.inflow = round2(cur.inflow + (convIn ?? 0));
      cur.net = round2(cur.net + (convNet ?? 0));
      cur.count += intOrNull(row.item_count) ?? 1;
      byDate.set(row.flow_date, cur);
    }

    // Fallback for Excel-imported cashflow_months when daily forecast has no rows yet
    if (byDate.size === 0 && (mode === "CONSOLIDATED" || mode === "TRY") && months.length > 0) {
      const monthPressureSeries = [
        {
          id: "projected-outflow",
          label: "Planlanan Çıkış",
          tone: "negative" as const,
          format: "currency" as const,
          projectionKind: "projected" as const,
          points: months.map(
            (m): ChartPoint => ({
              key: m.monthStart.slice(0, 7),
              label: m.monthStart.slice(0, 7),
              value: m.expense,
              href: "/cashflow",
              confidence: "medium",
              freshness: todayISO,
              projectionKind: "projected",
            }),
          ),
        },
        {
          id: "expected-inflow",
          label: "Beklenen Giriş",
          tone: "positive" as const,
          format: "currency" as const,
          projectionKind: "projected" as const,
          points: months.map(
            (m): ChartPoint => ({
              key: m.monthStart.slice(0, 7),
              label: m.monthStart.slice(0, 7),
              value: m.income,
              href: "/cashflow",
              confidence: "medium",
              freshness: todayISO,
              projectionKind: "projected",
            }),
          ),
        },
      ];

      const monthBalanceSeries = [
        {
          id: "closing-balance",
          label: "Dönem Sonu Kasa Projeksiyonu",
          tone: "info" as const,
          format: "currency" as const,
          projectionKind: "projected" as const,
          points: months.map(
            (m): ChartPoint => ({
              key: m.monthStart.slice(0, 7),
              label: m.monthStart.slice(0, 7),
              value: m.closing,
              href: "/cashflow",
              confidence: "medium",
              freshness: todayISO,
              projectionKind: "projected",
            }),
          ),
        },
      ];

      return {
        balanceChart: {
          title: `Nakit Projeksiyon Ufku · ${modeLabel}`,
          description: "Aylık kapanış kasa projeksiyonu ve sıfır bakiye eşiği.",
          series: monthBalanceSeries,
          annotations: [],
          unknownCount: months.filter((m) => m.closing == null).length,
          sourceLabel: "Nakit Akış Projeksiyonu",
          sourceHref: "/cashflow",
          asOf: todayISO.slice(0, 7),
          timeDirection: "forward",
          availableGranularities: ["month"],
          criticalThreshold: 0,
          summaryMode: "endpoint",
          currencyCode,
        },
        pressureChart: {
          title: `Ödeme & Tahsilat Baskısı · ${modeLabel}`,
          description: "Aylık nakit giriş ve çıkış dengesi.",
          series: monthPressureSeries,
          annotations: [],
          unknownCount: 0,
          sourceLabel: "Nakit Akış Projeksiyonu",
          sourceHref: "/cashflow",
          asOf: todayISO.slice(0, 7),
          timeDirection: "forward",
          availableGranularities: ["month"],
          summaryMode: "sum",
          currencyCode,
        },
      };
    }

    // Build unified timeline keys: overdue dates + next 14 days daily + weekly anchors up to 52 weeks + any active flow dates
    const keySet = new Set<string>();
    for (const k of byDate.keys()) keySet.add(k);
    for (let d = 0; d < 14; d += 1) keySet.add(addDays(todayISO, d));
    for (let w = 2; w <= 52; w += 1) keySet.add(addDays(todayISO, w * 7));
    const sortedKeys = [...keySet].sort();

    const confirmedOutPoints: ChartPoint[] = [];
    const projectedOutPoints: ChartPoint[] = [];
    const inflowPoints: ChartPoint[] = [];

    for (const k of sortedKeys) {
      const bucket = byDate.get(k);
      const isOverdue = k < todayISO;
      const href = isOverdue ? "/payments?filter=overdue" : `/payments?from=${k}&to=${k}`;
      confirmedOutPoints.push({
        key: k,
        label: k,
        value: bucket?.confirmedOut ?? 0,
        href,
        confidence: "high",
        freshness: todayISO,
        projectionKind: "confirmed",
        meta: bucket ? { kalemAdedi: bucket.count } : undefined,
      });
      projectedOutPoints.push({
        key: k,
        label: k,
        value: bucket?.projectedOut ?? 0,
        href,
        confidence: "medium",
        freshness: todayISO,
        projectionKind: "projected",
      });
      inflowPoints.push({
        key: k,
        label: k,
        value: bucket?.inflow ?? 0,
        href: "/finance/receivables",
        confidence: "high",
        freshness: todayISO,
        projectionKind: "confirmed",
      });
    }

    // Forward cumulative balance horizon (from todayISO .. +365 days)
    const opening =
      mode === "CONSOLIDATED"
        ? (freeCashConsolidatedTry ?? fallbackOpeningTry ?? 0)
        : (cashByCurrency[mode] ?? 0);

    const forwardKeys = sortedKeys.filter((k) => k >= todayISO);
    const balancePoints: ChartPoint[] = [];
    let running = opening;
    let cursorDate = todayISO;

    // Walk day-by-day up to last forward key so cumulative balance includes every intermediate flow
    const maxForwardKey = forwardKeys[forwardKeys.length - 1] ?? addDays(todayISO, 90);
    const forwardKeySet = new Set(forwardKeys);
    while (cursorDate <= maxForwardKey) {
      const flow = byDate.get(cursorDate);
      if (flow) {
        running = round2(running + flow.net);
      }
      if (forwardKeySet.has(cursorDate)) {
        balancePoints.push({
          key: cursorDate,
          label: cursorDate,
          value: running,
          href: "/cashflow",
          confidence: "high",
          freshness: todayISO,
          projectionKind: cursorDate <= addDays(todayISO, 30) ? "confirmed" : "projected",
        });
      }
      cursorDate = addDays(cursorDate, 1);
    }

    return {
      balanceChart: {
        title: `13H & Yıllık Kümülatif Kasa Ufku · ${modeLabel}`,
        description:
          "Serbest banka/kasa açılışından itibaren fatura, 0102 çek statüleri, kredi taksitleri ve ödeme planlarının kümülatif seyri.",
        series: [
          {
            id: "cumulative-cash",
            label: "Kümülatif Serbest Kasa",
            tone: "info",
            format: "currency",
            projectionKind: "confirmed",
            points: balancePoints,
          },
        ],
        annotations: [],
        unknownCount: 0,
        sourceLabel: "Hazine & Likidite Projeksiyonu",
        sourceHref: "/cashflow",
        asOf: todayISO,
        timeDirection: "forward",
        availableGranularities: ["day", "week", "month"],
        defaultGranularityByPeriod: {
          "3m": "week",
          "6m": "week",
          "12m": "month",
          "24m": "month",
          all: "month",
        },
        criticalThreshold: 0,
        summaryMode: "endpoint",
        currencyCode,
      },
      pressureChart: {
        title: `Ödeme & Vade Baskısı · ${modeLabel}`,
        description:
          "Kesinleşmiş fatura/çek/kredi çıkışları (dolu sütun) ile şablon projeksiyonları (taramalı sütun) ve beklenen tahsilatlar.",
        series: [
          {
            id: "confirmed-outflow",
            label: "Kesinleşmiş Çıkış (Fatura / Çek / Kredi)",
            tone: "negative",
            format: "currency",
            projectionKind: "confirmed",
            points: confirmedOutPoints,
          },
          {
            id: "projected-outflow",
            label: "Şablon Projeksiyonu (Planlanan)",
            tone: "warning",
            format: "currency",
            projectionKind: "projected",
            points: projectedOutPoints,
          },
          {
            id: "expected-inflow",
            label: "Beklenen Tahsilat & Çek Girişi",
            tone: "positive",
            format: "currency",
            projectionKind: "confirmed",
            points: inflowPoints,
          },
        ],
        annotations: [],
        unknownCount: 0,
        sourceLabel: "Likidite Günlük Akışı",
        sourceHref: "/payments",
        asOf: todayISO,
        timeDirection: "forward",
        availableGranularities: ["day", "week", "month"],
        defaultGranularityByPeriod: {
          "3m": "week",
          "6m": "week",
          "12m": "month",
          "24m": "month",
          all: "month",
        },
        summaryMode: "sum",
        currencyCode,
      },
    };
  };

  return {
    CONSOLIDATED: buildForMode("CONSOLIDATED"),
    TRY: buildForMode("TRY"),
    USD: buildForMode("USD"),
    EUR: buildForMode("EUR"),
  };
}

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

  const treasuryRows = raw.treasuryRows ?? [];
  const fxRates = raw.fxRates ?? [];
  const forecastRows = raw.forecastRows ?? [];
  const checkPortfolio = raw.checkPortfolio ?? [];

  const hasLiveAccounts = treasuryRows.some(
    (r) => (intOrNull(r.account_count as number) ?? 0) > 0,
  );
  const hasData =
    raw.monthTotalCount > 0 || months.length > 0 || hasLiveAccounts || forecastRows.length > 0;

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

  // FX Rate Map (TCMB)
  const fxRateMap: Record<string, number> = { TRY: 1 };
  const fxSummaryParts: string[] = [];
  for (const fx of fxRates) {
    const r = rateOrNull(fx.rate);
    if (r != null && r > 0) {
      fxRateMap[fx.base_currency] = r;
      if (fx.base_currency === "USD" || fx.base_currency === "EUR") {
        fxSummaryParts.push(
          `${fx.base_currency} ${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(r)}`,
        );
      }
    }
  }
  const toTry = (amt: number, ccy: string): number | null => {
    if (ccy === "TRY") return amt;
    const r = fxRateMap[ccy];
    return r && r > 0 ? round2(amt * r) : null;
  };

  // Treasury Position Summary (FIN-03 + TCMB Consolidated)
  let freeCashTryOnly: number | null = 0;
  let fxCashTryEquivalent = 0;
  let unknownOpeningCount = 0;
  let unknownTryCount = 0;
  let activeAccountCount = 0;
  const cashByCurrency: Record<"TRY" | "USD" | "EUR", number | null> = {
    TRY: 0,
    USD: 0,
    EUR: 0,
  };

  for (const r of treasuryRows) {
    const ccy = String(r.currency ?? "TRY");
    const acctCount = intOrNull(r.account_count as number) ?? 0;
    const unkCount = intOrNull(r.unknown_opening_count as number) ?? 0;
    const avail = unkCount > 0 ? null : moneyOrNull(r.available_now as string | number | null);
    activeAccountCount += acctCount;
    unknownOpeningCount += unkCount;

    if (ccy === "TRY") {
      unknownTryCount = unkCount;
      freeCashTryOnly = unkCount > 0 ? null : (avail ?? 0);
      cashByCurrency.TRY = freeCashTryOnly;
    } else {
      if (ccy === "USD" || ccy === "EUR") {
        cashByCurrency[ccy] = avail;
      }
      if (avail != null) {
        const eq = toTry(avail, ccy);
        if (eq != null) fxCashTryEquivalent = round2(fxCashTryEquivalent + eq);
      }
    }
  }

  let freeCashConsolidatedTry: number | null =
    unknownTryCount > 0
      ? null
      : activeAccountCount > 0
        ? round2((freeCashTryOnly ?? 0) + fxCashTryEquivalent)
        : (currentMonthRow?.opening ?? (months.length > 0 ? currentMonthRow?.closing ?? 0 : 0));

  if (!hasData && activeAccountCount === 0) {
    freeCashConsolidatedTry = 0;
  }

  // 13-Week (91-day) Daily Liquidity Horizon
  const netByDay = new Map<string, number>();
  for (const row of forecastRows) {
    if (row.flow_date < todayISO) continue;
    const conv = toTry(moneyOrNull(row.net_flow) ?? 0, row.currency || "TRY");
    if (conv == null) continue;
    netByDay.set(row.flow_date, round2((netByDay.get(row.flow_date) ?? 0) + conv));
  }

  let minCash13wTry: number | null = null;
  let minCash13wDate: string | null = null;
  let netFlow13wTry: number | null = null;
  const trajectory13wValues: number[] = [];

  if (freeCashConsolidatedTry != null && (forecastRows.length > 0 || activeAccountCount > 0)) {
    let running = freeCashConsolidatedTry;
    let net91 = 0;
    minCash13wTry = running;
    minCash13wDate = todayISO;
    for (let d = 0; d <= 90; d += 1) {
      const iso = addDays(todayISO, d);
      const dayDelta = netByDay.get(iso) ?? 0;
      running = round2(running + dayDelta);
      net91 = round2(net91 + dayDelta);
      if (running < minCash13wTry) {
        minCash13wTry = running;
        minCash13wDate = iso;
      }
      if (d > 0 && d % 7 === 0) {
        trajectory13wValues.push(running);
      }
    }
    netFlow13wTry = net91;
  } else if (closingSeries.values.length > 0) {
    minCash13wTry = projection.worstBalance;
    minCash13wDate = projection.worstMonth;
    trajectory13wValues.push(...closingSeries.values.slice(0, 12));
  }

  // 0102 Turkish Check / Promissory Note Portfolio Summary
  let checkPortfolioInflowTry = 0;
  let checkCollateralTry = 0;
  let checkIssuedOutflowTry = 0;
  let checkEndorsedRiskTry = 0;
  let checkBouncedCount = 0;

  for (const cp of checkPortfolio) {
    const cnt = intOrNull(cp.cnt) ?? 0;
    const amtTry = toTry(moneyOrNull(cp.total_amount) ?? 0, cp.currency || "TRY") ?? 0;
    if (cp.status === "bounced") {
      checkBouncedCount += cnt;
    } else if (cp.status === "in_bank_collateral") {
      checkCollateralTry = round2(checkCollateralTry + amtTry);
    } else if (cp.status === "endorsed_to_vendor") {
      checkEndorsedRiskTry = round2(checkEndorsedRiskTry + amtTry);
    } else if (
      cp.direction === "inflow" &&
      (cp.status === "planned" || cp.status === "in_portfolio" || cp.status === "in_bank_collection")
    ) {
      checkPortfolioInflowTry = round2(checkPortfolioInflowTry + amtTry);
    } else if (
      cp.direction === "outflow" &&
      (cp.status === "planned" || cp.status === "issued_to_vendor")
    ) {
      checkIssuedOutflowTry = round2(checkIssuedOutflowTry + amtTry);
    }
  }

  const heroPrimary: OverviewHeroPrimary = {
    freeCashConsolidatedTry,
    freeCashTryOnly,
    fxCashTryEquivalent,
    cashByCurrency,
    unknownOpeningCount,
    activeAccountCount,
    fxRateMap,
    fxRateSummary: fxSummaryParts.length > 0 ? fxSummaryParts.join(" · ") : null,
    minCash13wTry,
    minCash13wDate,
    netFlow13wTry,
    trajectory13wValues,
    checkPortfolioInflowTry,
    checkCollateralTry,
    checkIssuedOutflowTry,
    checkEndorsedRiskTry,
    checkBouncedCount,
  };

  const chartsByCurrency = buildOverviewChartsByCurrency({
    todayISO,
    months,
    forecastRows,
    fxRateMap,
    freeCashConsolidatedTry,
    cashByCurrency,
    fallbackOpeningTry: currentMonthRow?.opening ?? currentMonthRow?.closing ?? null,
  });

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
    heroPrimary,
    chartsByCurrency,
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

  // Decode Working Capital, AR/AP, Credit Facilities, Covenants, Budget, FX Exposure & Exceptions
  const fxMap = primary.heroPrimary.fxRateMap;
  const toTry = (amt: number, ccy: string): number | null => {
    if (ccy === "TRY") return amt;
    const r = fxMap[ccy];
    return r && r > 0 ? round2(amt * r) : null;
  };

  const wc = raw.wcRow ?? null;
  const dsoDays = wc ? rateOrNull(wc.dso_days as string | number | null) : null;
  const dpoDays = wc ? rateOrNull(wc.dpo_days as string | number | null) : null;
  const dioDays = wc ? rateOrNull(wc.dio_days as string | number | null) : null;
  const cccDays = wc ? rateOrNull(wc.cash_conversion_cycle_days as string | number | null) : null;
  const cycleExclInventoryDays = wc
    ? rateOrNull(wc.cash_cycle_excluding_inventory as string | number | null)
    : null;

  let receivablesOpenTry: number | null = wc
    ? moneyOrNull(wc.receivables_open as string | number | null)
    : null;
  let overdueReceivablesTry: number | null = raw.arRows ? 0 : null;
  let overdueReceivablesCount = 0;

  if (raw.arRows && raw.arRows.length > 0) {
    let arSum = 0;
    let ovdSum = 0;
    for (const r of raw.arRows) {
      const openConv = toTry(moneyOrNull(r.total_open) ?? 0, r.currency || "TRY");
      const ovdConv = toTry(moneyOrNull(r.overdue_open) ?? 0, r.currency || "TRY");
      if (openConv != null) arSum = round2(arSum + openConv);
      if (ovdConv != null) ovdSum = round2(ovdSum + ovdConv);
      overdueReceivablesCount += intOrNull(r.overdue_count) ?? 0;
    }
    receivablesOpenTry = arSum;
    overdueReceivablesTry = ovdSum;
  }

  let payablesOpenTry: number | null = wc
    ? moneyOrNull(wc.payables_open as string | number | null)
    : null;
  if (raw.apRows && raw.apRows.length > 0) {
    let apSum = 0;
    for (const r of raw.apRows) {
      const openConv = toTry(moneyOrNull(r.total_open) ?? 0, r.currency || "TRY");
      if (openConv != null) apSum = round2(apSum + openConv);
    }
    payablesOpenTry = apSum;
  }

  const netWorkingCapitalTry =
    receivablesOpenTry != null || payablesOpenTry != null
      ? round2((receivablesOpenTry ?? 0) - (payablesOpenTry ?? 0))
      : null;

  let facilityLimitTry: number | null = null;
  let facilityAvailableTry: number | null = null;
  if (raw.facilityRows && raw.facilityRows.length > 0) {
    let limSum = 0;
    let availSum = 0;
    let sawAny = false;
    for (const r of raw.facilityRows) {
      const lim = toTry(moneyOrNull(r.limit_sum) ?? 0, r.currency || "TRY");
      const av = toTry(moneyOrNull(r.available_sum) ?? 0, r.currency || "TRY");
      if (lim != null) {
        limSum = round2(limSum + lim);
        sawAny = true;
      }
      if (av != null) {
        availSum = round2(availSum + av);
        sawAny = true;
      }
    }
    if (sawAny) {
      facilityLimitTry = limSum;
      facilityAvailableTry = availSum;
    }
  }

  const covenantActiveCount = intOrNull(raw.covenantCounts?.active_count ?? 0) ?? 0;
  const covenantBreachedCount = intOrNull(raw.covenantCounts?.breached_count ?? 0) ?? 0;

  const budgetMeasuredCount = intOrNull(raw.budgetAgg?.measured_count ?? 0) ?? 0;
  const budgetOverCount =
    budgetMeasuredCount > 0 ? (intOrNull(raw.budgetAgg?.over_count ?? 0) ?? 0) : null;
  const budgetNetVarianceTry =
    budgetMeasuredCount > 0 ? moneyOrNull(raw.budgetAgg?.net_variance_try ?? null) : null;

  let fxNetOpenTry: number | null = null;
  let fxShock20LossTry: number | null = null;
  if (raw.fxExposureRows && raw.fxExposureRows.length > 0) {
    let sumNetTry = 0;
    let sawRated = false;
    for (const fxRow of raw.fxExposureRows) {
      const posTry = moneyOrNull(fxRow.net_position_try);
      if (posTry != null) {
        sumNetTry = round2(sumNetTry + posTry);
        sawRated = true;
      } else {
        const native = moneyOrNull(fxRow.net_position_native);
        if (native != null) {
          const fallbackConv = toTry(native, fxRow.currency);
          if (fallbackConv != null) {
            sumNetTry = round2(sumNetTry + fallbackConv);
            sawRated = true;
          }
        }
      }
    }
    if (sawRated) {
      fxNetOpenTry = sumNetTry;
      // +20% TRY depreciation impact on net FX position
      fxShock20LossTry = round2(sumNetTry * 0.2);
    }
  } else if (primary.heroPrimary.fxCashTryEquivalent > 0) {
    fxNetOpenTry = primary.heroPrimary.fxCashTryEquivalent;
    fxShock20LossTry = round2(primary.heroPrimary.fxCashTryEquivalent * 0.2);
  }

  const pendingApprovalsCount = intOrNull(raw.exceptionCounts?.pending_approvals ?? 0) ?? 0;
  const unmatchedBankTxCount = intOrNull(raw.exceptionCounts?.unmatched_bank_tx ?? 0) ?? 0;
  const criticalControlAlertCount = intOrNull(raw.exceptionCounts?.critical_alerts ?? 0) ?? 0;
  const openControlAlertCount = intOrNull(raw.exceptionCounts?.open_alerts ?? 0) ?? 0;

  const heroSecondary: OverviewHeroSecondary = {
    netWorkingCapitalTry,
    receivablesOpenTry,
    payablesOpenTry,
    overdueReceivablesTry,
    overdueReceivablesCount,
    dsoDays,
    dpoDays,
    dioDays,
    cccDays,
    cycleExclInventoryDays,
    facilityLimitTry,
    facilityAvailableTry,
    covenantActiveCount,
    covenantBreachedCount,
    pendingApprovalsCount,
    unmatchedBankTxCount,
    criticalControlAlertCount,
    openControlAlertCount,
  };

  const cockpitCards = buildExecutiveCockpitCards({
    asOf: todayISO,
    freeCashConsolidatedTry: primary.heroPrimary.freeCashConsolidatedTry,
    freeCashTryOnly: primary.heroPrimary.freeCashTryOnly,
    fxCashTryEquivalent: primary.heroPrimary.fxCashTryEquivalent,
    unknownOpeningCount: primary.heroPrimary.unknownOpeningCount,
    activeAccountCount: primary.heroPrimary.activeAccountCount,
    minCash13wTry: primary.heroPrimary.minCash13wTry,
    minCash13wDate: primary.heroPrimary.minCash13wDate,
    netFlow13wTry: primary.heroPrimary.netFlow13wTry,
    receivablesOpenTry,
    payablesOpenTry,
    dsoDays,
    dpoDays,
    dioDays,
    cccDays,
    cycleExclInventoryDays,
    overdueReceivablesTry,
    overdueReceivablesCount,
    checkPortfolioInflowTry: primary.heroPrimary.checkPortfolioInflowTry,
    checkCollateralTry: primary.heroPrimary.checkCollateralTry,
    checkIssuedOutflowTry: primary.heroPrimary.checkIssuedOutflowTry,
    checkEndorsedRiskTry: primary.heroPrimary.checkEndorsedRiskTry,
    checkBouncedCount: primary.heroPrimary.checkBouncedCount,
    fxNetOpenTry,
    fxShock20LossTry,
    fxRateSummary: primary.heroPrimary.fxRateSummary,
    facilityAvailableTry,
    facilityLimitTry,
    covenantActiveCount,
    covenantBreachedCount,
    budgetOverCount,
    budgetNetVarianceTry,
    budgetMeasuredCount,
    pendingApprovalsCount,
    unmatchedBankTxCount,
    criticalControlAlertCount,
    openMappingReviewCount: primary.dataQuality.openReviewCount,
  });

  return {
    actions,
    proofByActionKey,
    lastReport: raw.lastReport,
    reminders,
    marginLoss,
    hasCapacityModel: primary.dataQuality.capacityTotalCount > 0,
    staleProductionRate,
    heroSecondary,
    cockpitCards,
  };
}

/**
 * M-01: Module-level memory cache has been purged so entity/branch switches and DB mutations
 * reflect instantaneously without stale cross-scope leakage. Kept as a backwards-compatible symbol.
 */
export function getWarmOverviewPair(
  _pool: Pick<Pool, "query">,
  _todayISO = istanbulDateISO(),
): { primary: OverviewPrimarySnapshot; secondary: OverviewSecondarySnapshot | null } | null {
  void _pool;
  void _todayISO;
  return null;
}

export async function loadOverviewPrimary(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<OverviewPrimarySnapshot> {
  return fetchOverviewPrimaryUncached(pool, todayISO);
}

async function fetchOverviewPrimaryUncached(
  pool: Pick<Pool, "query">,
  todayISO: string,
): Promise<OverviewPrimarySnapshot> {
  const monthStart = `${todayISO.slice(0, 7)}-01`;
  const weekEnd = addDays(todayISO, 6);

  const enrichedQuery = `with month_stats as (
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
       where c.status in ('planned', 'unknown', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
         and c.archived_at is null
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
     ),
     treasury_rows as (
       select to_jsonb(tps) as item
       from public.treasury_position_summary tps
     ),
     fx_rates as (
       select distinct on (base_currency)
         base_currency,
         rate::text as rate,
         to_char(rate_date, 'YYYY-MM-DD') as rate_date
       from public.fx_rate_snapshots
       where quote_currency = 'TRY'
       order by base_currency, rate_date desc, fetched_at desc
     ),
     forecast_rows as (
       select
         to_char(flow_date, 'YYYY-MM-DD') as flow_date,
         coalesce(currency, 'TRY') as currency,
         source_kind,
         coalesce(sum(amount_signed) filter (where amount_signed > 0), 0)::text as inflow,
         coalesce(sum(abs(amount_signed)) filter (where amount_signed < 0), 0)::text as outflow,
         coalesce(sum(amount_signed), 0)::text as net_flow,
         count(*)::int as item_count
       from public.liquidity_forecast_daily
       where flow_date >= ($1::date - 60)
         and flow_date <= ($1::date + 730)
       group by flow_date, coalesce(currency, 'TRY'), source_kind
       order by flow_date
     ),
     check_portfolio as (
       select
         status,
         direction::text as direction,
         coalesce(currency, 'TRY') as currency,
         count(*)::int as cnt,
         coalesce(sum(amount), 0)::text as total_amount
       from public.checks
       where archived_at is null
         and status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor', 'endorsed_to_vendor', 'bounced')
       group by status, direction, coalesce(currency, 'TRY')
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
       (select first_is_stale from cap_agg) as first_is_stale,
       coalesce((select jsonb_agg(tr.item) from treasury_rows tr), '[]'::jsonb) as treasury_rows,
       coalesce((select jsonb_agg(to_jsonb(fx)) from fx_rates fx), '[]'::jsonb) as fx_rates,
       coalesce((select jsonb_agg(to_jsonb(fr)) from forecast_rows fr), '[]'::jsonb) as forecast_rows,
       coalesce((select jsonb_agg(to_jsonb(cp)) from check_portfolio cp), '[]'::jsonb) as check_portfolio`;

  const fallbackPrimaryQuery = `with month_stats as (
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
       (select first_is_stale from cap_agg) as first_is_stale`;

  const res = await pool.query(enrichedQuery, [todayISO, monthStart, weekEnd]).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return pool.query(fallbackPrimaryQuery, [todayISO, monthStart, weekEnd]);
    }
    throw err;
  });
  const row = (res.rows[0] ?? {}) as Record<string, unknown>;

  return computeOverviewPrimary(
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
      treasuryRows: (row.treasury_rows as OverviewRawPrimary["treasuryRows"] | undefined) ?? [],
      fxRates: (row.fx_rates as OverviewRawPrimary["fxRates"] | undefined) ?? [],
      forecastRows: (row.forecast_rows as OverviewRawPrimary["forecastRows"] | undefined) ?? [],
      checkPortfolio:
        (row.check_portfolio as OverviewRawPrimary["checkPortfolio"] | undefined) ?? [],
    },
    todayISO,
  );
}

export async function loadOverviewSecondary(
  pool: Pick<Pool, "query">,
  primary: OverviewPrimarySnapshot,
): Promise<OverviewSecondarySnapshot> {
  return fetchOverviewSecondaryUncached(pool, primary);
}

async function fetchOverviewSecondaryUncached(
  pool: Pick<Pool, "query">,
  primary: OverviewPrimarySnapshot,
): Promise<OverviewSecondarySnapshot> {
  const enrichedSecondaryQuery = `with income_lines as (
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
     ),
     ar_agg as (
       select
         coalesce(currency, 'TRY') as currency,
         coalesce(sum(open_amount), 0)::text as total_open,
         coalesce(sum(open_amount) filter (where coalesce(days_overdue, 0) > 0), 0)::text as overdue_open,
         count(*)::int as item_count,
         count(*) filter (where coalesce(days_overdue, 0) > 0)::int as overdue_count
       from public.receivables_open
       group by coalesce(currency, 'TRY')
     ),
     ap_agg as (
       select
         coalesce(currency, 'TRY') as currency,
         coalesce(sum(open_amount), 0)::text as total_open,
         coalesce(sum(open_amount) filter (where coalesce(days_overdue, 0) > 0), 0)::text as overdue_open,
         count(*)::int as item_count,
         count(*) filter (where coalesce(days_overdue, 0) > 0)::int as overdue_count
       from public.payables_open
       group by coalesce(currency, 'TRY')
     ),
     facility_agg as (
       select
         coalesce(currency, 'TRY') as currency,
         coalesce(sum(limit_amount), 0)::text as limit_sum,
         coalesce(sum(available_amount), 0)::text as available_sum,
         coalesce(sum(drawn_amount), 0)::text as drawn_sum
       from public.credit_facility_utilization
       where status = 'active'
       group by coalesce(currency, 'TRY')
     ),
     cov_agg as (
       select
         count(*) filter (where status = 'active')::int as active_count,
         count(*) filter (where status = 'active' and last_test_result = 'breached')::int as breached_count
       from public.covenant_records
     ),
     budget_agg as (
       select
         count(*) filter (where variance_verdict <> 'not_measured')::int as measured_count,
         count(*) filter (where variance_verdict in ('over_budget', 'under_target'))::int as over_count,
         sum(
           case
             when variance_verdict = 'not_measured' or variance_amount is null then 0
             when direction = 'expense' then -variance_amount
             else variance_amount
           end
         ) filter (where currency = 'TRY' and variance_verdict <> 'not_measured')::text as net_variance_try
       from public.budget_vs_actual
     ),
     exc_agg as (
       select
         (select count(*)::int from public.approvals where status = 'pending') as pending_approvals,
         (select count(*)::int from public.bank_transactions where status = 'unmatched') as unmatched_bank_tx,
         (select count(*)::int from public.control_alerts where status = 'open' and severity = 'critical') as critical_alerts,
         (select count(*)::int from public.control_alerts where status = 'open') as open_alerts
     ),
     fx_exposure as (
       select
         currency,
         net_position_native::text as net_position_native,
         spot_rate_to_try::text as spot_rate_to_try,
         net_position_try::text as net_position_try
       from public.live_fx_exposure_v
     )
     select
       coalesce((select jsonb_agg(to_jsonb(il)) from income_lines il), '[]'::jsonb) as income_lines,
       coalesce((select jsonb_agg(to_jsonb(cr)) from cost_rows cr), '[]'::jsonb) as cost_models,
       (select to_jsonb(lr) from latest_report lr) as last_report,
       coalesce((select jsonb_agg(to_jsonb(ra)) from reminder_agg ra), '[]'::jsonb) as reminder_counts,
       coalesce((select jsonb_agg(to_jsonb(ae)) from approved_ext ae), '[]'::jsonb) as approved_external,
       (select to_jsonb(wcm) from public.working_capital_metrics wcm limit 1) as wc_row,
       coalesce((select jsonb_agg(to_jsonb(ar)) from ar_agg ar), '[]'::jsonb) as ar_rows,
       coalesce((select jsonb_agg(to_jsonb(ap)) from ap_agg ap), '[]'::jsonb) as ap_rows,
       coalesce((select jsonb_agg(to_jsonb(fa)) from facility_agg fa), '[]'::jsonb) as facility_rows,
       (select to_jsonb(ca) from cov_agg ca) as covenant_counts,
       (select to_jsonb(ba) from budget_agg ba) as budget_agg,
       (select to_jsonb(ea) from exc_agg ea) as exception_counts,
       coalesce((select jsonb_agg(to_jsonb(fx)) from fx_exposure fx), '[]'::jsonb) as fx_exposure_rows`;

  const fallbackSecondaryQuery = `with income_lines as (
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
       coalesce((select jsonb_agg(to_jsonb(ae)) from approved_ext ae), '[]'::jsonb) as approved_external`;

  const res = await pool.query(enrichedSecondaryQuery).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return pool.query(fallbackSecondaryQuery);
    }
    throw err;
  });

  const row = (res.rows[0] ?? {}) as Record<string, unknown>;
  return computeOverviewSecondary(primary, {
    incomeLines: (row.income_lines as OverviewRawSecondary["incomeLines"] | undefined) ?? [],
    costModels: (row.cost_models as OverviewRawSecondary["costModels"] | undefined) ?? [],
    lastReport: (row.last_report as OverviewRawSecondary["lastReport"] | null) ?? null,
    reminderCounts:
      (row.reminder_counts as OverviewRawSecondary["reminderCounts"] | undefined) ?? [],
    approvedExternal:
      (row.approved_external as OverviewRawSecondary["approvedExternal"] | undefined) ?? [],
    wcRow: (row.wc_row as OverviewRawSecondary["wcRow"]) ?? null,
    arRows: (row.ar_rows as OverviewRawSecondary["arRows"]) ?? [],
    apRows: (row.ap_rows as OverviewRawSecondary["apRows"]) ?? [],
    facilityRows: (row.facility_rows as OverviewRawSecondary["facilityRows"]) ?? [],
    covenantCounts: (row.covenant_counts as OverviewRawSecondary["covenantCounts"]) ?? null,
    budgetAgg: (row.budget_agg as OverviewRawSecondary["budgetAgg"]) ?? null,
    exceptionCounts: (row.exception_counts as OverviewRawSecondary["exceptionCounts"]) ?? null,
    fxExposureRows: (row.fx_exposure_rows as OverviewRawSecondary["fxExposureRows"]) ?? [],
  });
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
        heroSecondary: {
          netWorkingCapitalTry: null,
          receivablesOpenTry: null,
          payablesOpenTry: null,
          overdueReceivablesTry: null,
          overdueReceivablesCount: 0,
          dsoDays: null,
          dpoDays: null,
          dioDays: null,
          cccDays: null,
          cycleExclInventoryDays: null,
          facilityLimitTry: null,
          facilityAvailableTry: null,
          covenantActiveCount: 0,
          covenantBreachedCount: 0,
          pendingApprovalsCount: 0,
          unmatchedBankTxCount: 0,
          criticalControlAlertCount: 0,
          openControlAlertCount: 0,
        },
        cockpitCards: [],
      };
    }
    const secondary = await loadOverviewSecondary(db, primary);
    return { ...primary, ...secondary };
  });
}

/**
 * F-36 / M-01: Loads canonical verified KPIs (`treasury_position_summary`, `receivables_open`,
 * `payables_open`, and 7-day remaining payment outflows) with zero stale module-level cache.
 */
export async function loadOverviewCanonicalKpis(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<CanonicalKpiSnapshot> {
  return loadCanonicalKpis(pool, todayISO);
}

export async function loadOverviewCanonicalOutflow7d(
  pool: Pick<Pool, "query">,
  todayISO = istanbulDateISO(),
): Promise<CanonicalOutflow7dKpi> {
  return loadCanonicalOutflow7dKpi(pool, todayISO);
}
