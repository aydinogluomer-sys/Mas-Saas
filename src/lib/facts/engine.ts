import type { Pool } from "pg";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadApprovedExternalAssumptions, type ExternalAssumption } from "@/lib/external-assumptions/engine";
import { loadMaturityItems } from "@/lib/financing/engine";
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

const EXTERNAL_TYPE_LABEL: Record<string, string> = {
  interest_rate: "Faiz orani",
  fx_rate: "Kur",
  inflation_rate: "Enflasyon",
  personnel_cost: "Personel maliyeti",
  energy_cost: "Enerji maliyeti",
  loan_rate: "Kredi orani",
  other: "Diger varsayim",
};

function externalValue(a: ExternalAssumption): string {
  const formatted = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 }).format(a.value_numeric);
  const currency = a.currency && a.currency !== "TRY" ? ` ${a.currency}` : "";
  return `${formatted} ${a.unit}${currency}`;
}

function externalAssumptionFact(a: ExternalAssumption): DecisionFact {
  const label = EXTERNAL_TYPE_LABEL[a.assumption_type] ?? a.assumption_type;
  const period = a.period_start ? ` Donem: ${a.period_start}${a.period_end ? `..${a.period_end}` : ""}.` : "";
  return {
    key: `external_${a.assumption_type}`,
    title: `Dis varsayim: ${label}`,
    value: externalValue(a),
    severity: "low",
    explanation: `Onayli dis varsayim: ${a.label}. Kaynak: ${a.source_name} / ${a.source_date}.${period} Finansal kayit degistirmez.`,
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
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='customer_income'`),
    pool.query(`select count(*)::int n from public.mapping_reviews where status in ('open','rejected')`),
    loadApprovedExternalAssumptions(pool),
  ]);

  const projection = buildProjection(months);
  const anchorMonth = monthStart;
  const horizonMonths = months.length > 0 ? monthDiff(anchorMonth, months[months.length - 1].monthStart) + 1 : 0;
  const runwayMonths = projection.firstNegativeMonth == null
    ? horizonMonths
    : Math.max(0, monthDiff(anchorMonth, projection.firstNegativeMonth));
  const runwaySeverity: FactSeverity = projection.firstNegativeMonth == null
    ? "low"
    : runwayMonths <= 1
      ? "critical"
      : runwayMonths <= 3
        ? "high"
        : "medium";
  const runwayValue = projection.firstNegativeMonth == null
    ? `${runwayMonths}+ ay`
    : `${runwayMonths} ay`;
  const debtPressureMonths = debtOverlay.filter((m) => m.pressure === "high").length;
  const next30Maturities = maturities.filter((m) => m.dueDate >= todayISO && m.dueDate <= next30 && m.direction === "outflow");
  const checkLoad30 = next30Maturities
    .filter((m) => m.kind === "check")
    .reduce((acc, m) => acc + (m.amount ?? 0), 0);
  const loanLoad30 = next30Maturities
    .filter((m) => m.kind === "loan_installment")
    .reduce((acc, m) => acc + (m.amount ?? 0), 0);
  const conc = concentration(incomeLines.rows);
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
      value: runwayValue,
      severity: runwaySeverity,
      explanation: projection.firstNegativeMonth
        ? `Mevcut projeksiyonda kasa yaklaşık ${runwayMonths} ay sonra negatif bölgeye geçiyor (${ym(projection.firstNegativeMonth)}).`
        : `Mevcut projeksiyon ufkunda (${runwayMonths} ay) negatif kasa görünmüyor.`,
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
