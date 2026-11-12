import type { Pool } from "pg";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadApprovedExternalAssumptions, type ExternalAssumption } from "@/lib/external-assumptions/engine";
import { loadMaturityItems } from "@/lib/financing/engine";
import { decimal, moneyOrNull, sumMoney } from "@/lib/money";
import { loadCapacityModels, loadCostModels } from "@/lib/production/engine";
import { priceMargin } from "@/lib/production/rules";
import { monthSummary, overdueOpen } from "@/lib/radar/queries";
import { buildProjection, concentration } from "@/lib/radar/rules";
import { loadDebtOverlay } from "@/lib/reports/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  countSeverity,
  hasRiskSeverity,
  ratioSeverity,
  sortBySeverity,
  type FactSeverity,
} from "./rules";

export interface DecisionFact {
  key: string;
  title: string;
  value: string;
  severity: FactSeverity;
  explanation: string;
  confidence: "source" | "calculated" | "needs_review";
  freshness: string;
  sourceHref: string;
}

const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

function monthDiff(fromMonthStart: string, toMonthStart: string): number {
  const [fy, fm] = fromMonthStart.split("-").map(Number);
  const [ty, tm] = toMonthStart.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * Faz 46 (C3): Pure forward cash runway computation from `anchorMonth` (`YYYY-MM-01`) onward.
 * Historical negative months strictly prior to `anchorMonth` never collapse forward runway to 0.
 */
export function computeForwardCashRunway(
  months: ReadonlyArray<{ monthStart: string; closing: number | null }>,
  anchorMonth: string,
): {
  horizonMonths: number;
  runwayMonths: number;
  zeroCashRunwayMonths: number;
  firstForwardNegativeMonth: string | null;
  severity: FactSeverity;
  value: string;
} {
  const forwardMonths = months.filter((m) => m.monthStart >= anchorMonth);
  const forwardProjection = buildProjection(
    forwardMonths.map((m) => ({
      monthStart: m.monthStart,
      opening: null,
      income: null,
      expense: null,
      closing: m.closing,
    })),
  );
  const horizonMonths =
    forwardMonths.length > 0
      ? monthDiff(anchorMonth, forwardMonths[forwardMonths.length - 1].monthStart) + 1
      : 0;
  const runwayMonths =
    forwardProjection.firstNegativeMonth == null
      ? horizonMonths
      : Math.max(0, monthDiff(anchorMonth, forwardProjection.firstNegativeMonth));
  const severity: FactSeverity =
    forwardProjection.firstNegativeMonth == null
      ? "low"
      : runwayMonths <= 1
        ? "critical"
        : runwayMonths <= 3
          ? "high"
          : "medium";
  const value =
    forwardProjection.firstNegativeMonth == null ? `${runwayMonths}+ ay` : `${runwayMonths} ay`;

  return {
    horizonMonths,
    runwayMonths,
    zeroCashRunwayMonths: runwayMonths,
    firstForwardNegativeMonth: forwardProjection.firstNegativeMonth,
    severity,
    value,
  };
}

export interface DualCashRunwayResult {
  /** 13 haftalık (91 günlük) günlük eğride kasa alt limitinin (`minCashFloor`) delindiği ilk güne kalan gün sayısı (`null` = açılış bakiyesi bilinmiyor) */
  floorRunwayDays: number | null;
  floorBreached: boolean | null;
  firstFloorBreachDate: string | null;
  floorRunwayValue: string;
  /** 36 aylık ileri eğride (`monthStart >= anchorMonth`) kasanın `< 0` olduğu ilk aya kalan ay sayısı */
  zeroCashRunwayMonths: number;
  horizonMonths: number;
  firstForwardNegativeMonth: string | null;
  zeroCashRunwayValue: string;
  severity: FactSeverity;
}

/**
 * Faz 55 (F2): Çift İleri Nakit Pisti (`Dual Runway` — `floorRunwayDays` & `zeroCashRunwayMonths`).
 * - `floorRunwayDays`: 13 haftalık (91 günlük) günlük eğride `minCashFloor` alt limitinin delindiği ilk güne kalan gün sayısı.
 * - `zeroCashRunwayMonths`: 36 aylık ileri eğride (`monthStart >= anchorMonth`) kasanın `< 0` olduğu ilk aya kalan ay sayısı.
 */
export function computeDualCashRunway(input: {
  months: ReadonlyArray<{ monthStart: string; closing: number | null }>;
  anchorMonth: string;
  todayISO: string;
  openingCash: number | null;
  minCashFloor?: number | null;
  datedFlows?: ReadonlyArray<{ dateISO: string; signedAmount: number }>;
}): DualCashRunwayResult {
  const monthly = computeForwardCashRunway(input.months, input.anchorMonth);

  if (input.openingCash === null || !Number.isFinite(input.openingCash)) {
    return {
      floorRunwayDays: null,
      floorBreached: null,
      firstFloorBreachDate: null,
      floorRunwayValue: "—",
      zeroCashRunwayMonths: monthly.zeroCashRunwayMonths,
      horizonMonths: monthly.horizonMonths,
      firstForwardNegativeMonth: monthly.firstForwardNegativeMonth,
      zeroCashRunwayValue: monthly.value,
      severity: monthly.severity,
    };
  }

  const floorDec = decimal(input.minCashFloor ?? 0);
  const flowsByDate = new Map<string, ReturnType<typeof decimal>>();
  for (const f of input.datedFlows ?? []) {
    if (!f.dateISO || !Number.isFinite(f.signedAmount)) continue;
    flowsByDate.set(f.dateISO, (flowsByDate.get(f.dateISO) ?? decimal(0)).plus(decimal(f.signedAmount)));
  }

  let runningDec = decimal(input.openingCash);
  let firstFloorBreachDate: string | null = null;
  let floorRunwayDays = 91;
  let floorBreached = false;

  for (let d = 0; d <= 90; d += 1) {
    const dt = addDays(input.todayISO, d);
    const delta = flowsByDate.get(dt);
    if (delta) {
      runningDec = runningDec.plus(delta);
    }
    if (runningDec.lt(floorDec)) {
      floorBreached = true;
      floorRunwayDays = d;
      firstFloorBreachDate = dt;
      break;
    }
  }

  const floorRunwayValue = floorBreached ? `${floorRunwayDays} gün` : "91+ gün";
  const floorSeverity: FactSeverity = !floorBreached
    ? "low"
    : floorRunwayDays <= 7
      ? "critical"
      : floorRunwayDays <= 30
        ? "high"
        : "medium";

  const severityOrder: Record<FactSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const combinedSeverity =
    severityOrder[floorSeverity] > severityOrder[monthly.severity] ? floorSeverity : monthly.severity;

  return {
    floorRunwayDays,
    floorBreached,
    firstFloorBreachDate,
    floorRunwayValue,
    zeroCashRunwayMonths: monthly.zeroCashRunwayMonths,
    horizonMonths: monthly.horizonMonths,
    firstForwardNegativeMonth: monthly.firstForwardNegativeMonth,
    zeroCashRunwayValue: monthly.value,
    severity: combinedSeverity,
  };
}

const EXTERNAL_TYPE_LABEL: Record<string, string> = {
  interest_rate: "Faiz oranı",
  fx_rate: "Kur",
  inflation_rate: "Enflasyon",
  personnel_cost: "Personel maliyeti",
  energy_cost: "Enerji maliyeti",
  loan_rate: "Kredi oranı",
  other: "Diğer varsayım",
};

function externalValue(a: ExternalAssumption): string {
  const formatted = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 }).format(a.value_numeric);
  const currency = a.currency && a.currency !== "TRY" ? ` ${a.currency}` : "";
  return `${formatted} ${a.unit}${currency}`;
}

function externalAssumptionFact(a: ExternalAssumption): DecisionFact {
  const label = EXTERNAL_TYPE_LABEL[a.assumption_type] ?? a.assumption_type;
  const period = a.period_start ? ` Dönem: ${a.period_start}${a.period_end ? `..${a.period_end}` : ""}.` : "";
  return {
    key: `external_${a.assumption_type}`,
    title: `Dış varsayım: ${label}`,
    value: externalValue(a),
    severity: "low",
    explanation: `Onaylı dış varsayım: ${a.label}. Kaynak: ${a.source_name} / ${a.source_date}.${period} Finansal kayıt değiştirmez.`,
    confidence: "source",
    freshness: a.source_date,
    sourceHref: "/assumptions",
  };
}

export async function loadDecisionFacts(pool: Pool, todayISO = istanbulDateISO()): Promise<DecisionFact[]> {
  const monthStart = `${todayISO.slice(0, 7)}-01`;
  const next30 = addDays(todayISO, 30);

  const [
    months,
    overdue,
    summary,
    debtOverlay,
    maturities,
    caps,
    costs,
    incomeLines,
    reviews,
    approvedExternal,
  ] = await Promise.all([
    loadCashMonths(pool),
    overdueOpen(pool, todayISO),
    monthSummary(pool, monthStart),
    loadDebtOverlay(pool),
    loadMaturityItems(pool),
    loadCapacityModels(pool),
    loadCostModels(pool),
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='customer_income'`),
    pool.query(`select count(*)::int n from public.mapping_reviews where status in ('open','rejected')`),
    loadApprovedExternalAssumptions(pool),
  ]);

  const projection = buildProjection(months);
  const anchorMonth = monthStart;
  const runway = computeForwardCashRunway(months, anchorMonth);
  const debtPressureMonths = debtOverlay.filter((m) => m.pressure === "high").length;
  const next30Maturities = maturities.filter((m) => m.dueDate >= todayISO && m.dueDate <= next30 && m.direction === "outflow");
  // These two feed DecisionFacts the AI layer quotes verbatim, so an accumulated float tail
  // would be published as a fact. `sumMoney` skips unknown amounts rather than adding 0 —
  // the same "null is unknown, not zero" rule the old `?? 0` reduce quietly broke.
  const checkLoad30 = sumMoney(
    next30Maturities.filter((m) => m.kind === "check").map((m) => m.amount),
  );
  const loanLoad30 = sumMoney(
    next30Maturities.filter((m) => m.kind === "loan_installment").map((m) => m.amount),
  );
  const conc = concentration(
    incomeLines.rows.map((r) => ({ key: r.key as string | null, amount: moneyOrNull(r.amount) })),
  );
  const topConc = conc.entries[0] ?? null;
  const marginLossCount = costs.filter(
    (c) => priceMargin(c.breakEven, c.akonFreze).loss || priceMargin(c.breakEven, c.akonTorna).loss,
  ).length;
  const staleCount = caps.filter((c) => (c as unknown as { isStaleRate?: boolean }).isStaleRate).length;
  const unresolvedReviews = Number(reviews.rows[0]?.n ?? 0);

  const facts: DecisionFact[] = [
    {
      key: "first_negative_month",
      title: "İlk negatif ay",
      value: ym(projection.firstNegativeMonth),
      severity: hasRiskSeverity(projection.firstNegativeMonth != null, "high"),
      explanation: projection.firstNegativeMonth
        ? `Nakit projeksiyonu ${ym(projection.firstNegativeMonth)} ayında eksiye düşüyor.`
        : "Nakit projeksiyonunda negatif ay görünmüyor.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "worst_cash_month",
      title: "En kötü kasa ayı",
      value: `${ym(projection.worstMonth)} · ${fmt0(projection.worstBalance)} TL`,
      severity: hasRiskSeverity((projection.worstBalance ?? 0) < 0, "high"),
      explanation: "35 aylık cashflow satırlarından en düşük kapanış bakiyesi.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "cash_runway",
      title: "Nakit runway",
      value: runway.value,
      severity: runway.severity,
      explanation: runway.firstForwardNegativeMonth
        ? `Mevcut projeksiyonda kasa yaklaşık ${runway.runwayMonths} ay sonra negatif bölgeye geçiyor (${ym(runway.firstForwardNegativeMonth)}).`
        : `Mevcut ileri projeksiyon ufkunda (${runway.runwayMonths} ay) negatif kasa görünmüyor.`,
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/cashflow",
    },
    {
      key: "overdue_payment_load",
      title: "Geciken ödeme",
      value: String(overdue.length),
      severity: countSeverity(overdue.length, 1, 5),
      explanation: overdue.length > 0 ? "Açık/gecikmiş ödeme aksiyonu gerekiyor." : "Gecikmiş açık ödeme yok.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/radar",
    },
    {
      key: "missing_amount_count",
      title: "Eksik tutar",
      value: String(summary.missing_count),
      severity: countSeverity(summary.missing_count, 1, 8),
      explanation: "Eksik tutar bilinmeyendir; hiçbir hesapta 0 sayılmaz.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/radar",
    },
    {
      key: "debt_pressure_months",
      title: "Borç baskılı ay",
      value: String(debtPressureMonths),
      severity: countSeverity(debtPressureMonths, 1, 4),
      explanation: "Çek/kredi yükünün negatif kasa ile üst üste geldiği aylar.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/financing",
    },
    {
      key: "check_maturity_30d",
      title: "30 gün çek yükü",
      value: `${fmt0(checkLoad30)} TL`,
      severity: hasRiskSeverity(checkLoad30 > 0, "medium"),
      explanation: "Önümüzdeki 30 gün içindeki açık çek çıkışları.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/financing",
    },
    {
      key: "loan_service_30d",
      title: "30 gün kredi taksiti",
      value: `${fmt0(loanLoad30)} TL`,
      severity: hasRiskSeverity(loanLoad30 > 0, "medium"),
      explanation: "Önümüzdeki 30 gün içindeki kredi taksit yükü.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/financing",
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
      explanation: "Akon TL/dk fiyatı, ilgili maliyet modelinin başabaşının altında kalan operasyonlar.",
      confidence: "calculated",
      freshness: todayISO,
      sourceHref: "/production",
    },
    {
      key: "stale_rate_flags",
      title: "Eski üretim tarifesi",
      value: String(staleCount),
      severity: countSeverity(staleCount, 1, 2),
      explanation: "Kapasite TL/dk oranı güncel yılın gerisinde kalan modeller.",
      confidence: "needs_review",
      freshness: todayISO,
      sourceHref: "/production",
    },
    {
      key: "unresolved_review_count",
      title: "Açık inceleme",
      value: String(unresolvedReviews),
      severity: countSeverity(unresolvedReviews, 1, 10),
      explanation: "Karar almayı engelleyebilecek açık/ret mapping review kayıtları.",
      confidence: "source",
      freshness: todayISO,
      sourceHref: "/imports",
    },
  ];

  return sortBySeverity([...facts, ...approvedExternal.map(externalAssumptionFact)]);
}
