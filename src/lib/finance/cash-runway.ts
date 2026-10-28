// Faz 3 — CFO Risk & Simülasyon: Likidite Stres Testi & Cash Runway ("Cash-Out Day")
//
// Şirketin mevcut nakit ve kullanılabilir kredi tamponlarıyla, operasyonel nakit yakma
// hızına (burn rate) göre kaç gün/ay hayatta kalabileceğini (Runway) ve kasanın hangi gün
// sıfırlanacağını (Cash-Out Day) 3 farklı stres senaryosu altında hesaplar:
//   1. Normal / Baseline: Mevcut sözleşmeli ve beklenen nakit akış trendi.
//   2. Kötümsel (Pessimistic): Tahsilat gecikmeleri (+21 gün), %25 gelir kaybı, %10 maliyet artışı.
//   3. Kara Kuğu (Severe Shock / Black Swan): %60 alacak donması, banka kredi hatlarının kapatılması.

import type { Pool } from "pg";
import { addDaysISO } from "@/lib/financing/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadPositionSummary, loadLiquidityGap } from "@/lib/treasury/engine";

export type RunwayVerdict = "COMFORTABLE" | "MODERATE" | "VULNERABLE" | "CRITICAL";

export interface ScenarioRunway {
  scenarioName: "Baseline" | "Pessimistic" | "Severe Shock";
  description: string;
  monthlyBurnRate: number;
  dailyBurnRate: number;
  effectiveCashBuffer: number;
  runwayDays: number;
  runwayMonths: number;
  cashOutDate: string;
  cashOutDateWithCredit: string | null;
  runwayWithCreditDays: number | null;
  verdict: RunwayVerdict;
  mitigationActions: string[];
}

export interface CashRunwayReport {
  asOfDate: string;
  totalLiquidCash: number;
  availableCreditHeadroom: number;
  totalLiquidityBuffer: number;
  scenarios: {
    baseline: ScenarioRunway;
    pessimistic: ScenarioRunway;
    severeShock: ScenarioRunway;
  };
  summaryRecommendation: string;
}

export interface RunwayInputData {
  asOfDate: string;
  liquidCashTRY: number;
  creditHeadroomTRY: number;
  monthlyOperatingExpense: number; // Aylık sabit ve değişken operasyonel gider
  monthlyContractedInflow: number; // Aylık beklenen olağan tahsilat
  minCashFloor: number;            // Kırmızı çizgi kasa tabanı
}

/**
 * Verilen finansal parametrelere göre 3 senaryolu Cash Runway ve Cash-Out Day hesaplar (Pure function).
 */
export function calculateCashRunway(input: RunwayInputData): CashRunwayReport {
  const {
    asOfDate,
    liquidCashTRY,
    creditHeadroomTRY,
    monthlyOperatingExpense,
    monthlyContractedInflow,
    minCashFloor,
  } = input;

  const totalBuffer = Math.max(0, liquidCashTRY - minCashFloor);
  const totalWithCredit = Math.max(0, liquidCashTRY + creditHeadroomTRY - minCashFloor);

  // 1. BASELINE SCENARIO
  const baseMonthlyNetBurn = Math.max(1, monthlyOperatingExpense - monthlyContractedInflow);
  const baseDailyBurn = baseMonthlyNetBurn / 30;
  const baseRunwayDays = Math.min(365, Math.max(0, Math.floor(totalBuffer / baseDailyBurn)));
  const baseWithCreditDays = Math.min(730, Math.max(0, Math.floor(totalWithCredit / baseDailyBurn)));

  const baseVerdict: RunwayVerdict =
    baseRunwayDays >= 90 ? "COMFORTABLE" : baseRunwayDays >= 45 ? "MODERATE" : baseRunwayDays >= 15 ? "VULNERABLE" : "CRITICAL";

  const baseline: ScenarioRunway = {
    scenarioName: "Baseline",
    description: "Olağan bütçe ve sözleşmeli nakit akışı projeksiyonu.",
    monthlyBurnRate: Math.round(baseMonthlyNetBurn),
    dailyBurnRate: Math.round(baseDailyBurn),
    effectiveCashBuffer: totalBuffer,
    runwayDays: baseRunwayDays,
    runwayMonths: Number((baseRunwayDays / 30).toFixed(1)),
    cashOutDate: addDaysISO(asOfDate, baseRunwayDays),
    cashOutDateWithCredit: addDaysISO(asOfDate, baseWithCreditDays),
    runwayWithCreditDays: baseWithCreditDays,
    verdict: baseVerdict,
    mitigationActions:
      baseRunwayDays < 60
        ? ["Rutin gider kontrolü yapın", "Vadesi geçmiş alacakları hızlandırın"]
        : ["Likidite pozisyonu güçlü. Vadeli mevduat/para piyasası fonu getirisi kovalayın."],
  };

  // 2. PESSIMISTIC SCENARIO (Tahsilat %25 düşer, giderler %10 artar)
  const pessInflow = monthlyContractedInflow * 0.75;
  const pessExpense = monthlyOperatingExpense * 1.10;
  const pessMonthlyNetBurn = Math.max(1, pessExpense - pessInflow);
  const pessDailyBurn = pessMonthlyNetBurn / 30;
  const pessRunwayDays = Math.min(365, Math.max(0, Math.floor(totalBuffer / pessDailyBurn)));
  const pessWithCreditDays = Math.min(730, Math.max(0, Math.floor(totalWithCredit / pessDailyBurn)));

  const pessVerdict: RunwayVerdict =
    pessRunwayDays >= 60 ? "COMFORTABLE" : pessRunwayDays >= 30 ? "MODERATE" : pessRunwayDays >= 10 ? "VULNERABLE" : "CRITICAL";

  const pessimistic: ScenarioRunway = {
    scenarioName: "Pessimistic",
    description: "Müşteri tahsilatlarında %25 düşüş/gecikme, operasyonel maliyetlerde %10 enflasyonist artış.",
    monthlyBurnRate: Math.round(pessMonthlyNetBurn),
    dailyBurnRate: Math.round(pessDailyBurn),
    effectiveCashBuffer: totalBuffer,
    runwayDays: pessRunwayDays,
    runwayMonths: Number((pessRunwayDays / 30).toFixed(1)),
    cashOutDate: addDaysISO(asOfDate, pessRunwayDays),
    cashOutDateWithCredit: addDaysISO(asOfDate, pessWithCreditDays),
    runwayWithCreditDays: pessWithCreditDays,
    verdict: pessVerdict,
    mitigationActions: [
      "Tedarikçi ödeme vadelerini ortalama 14 gün öteleyin.",
      "Kritik olmayan operasyonel harcamaları dondurun.",
      "Alacaklarda erken ödeme iskontosu sunarak nakit girişini öne çekin.",
    ],
  };

  // 3. SEVERE SHOCK / BLACK SWAN SCENARIO (%60 tahsilat şoku, kredi hatları donması)
  const shockInflow = monthlyContractedInflow * 0.40;
  const shockExpense = monthlyOperatingExpense * 1.05;
  const shockMonthlyNetBurn = Math.max(1, shockExpense - shockInflow);
  const shockDailyBurn = shockMonthlyNetBurn / 30;
  // Kara kuğuda banka kredi limitleri kullandırılmayabilir, sadece mevcut nakit hesaba katılır
  const shockRunwayDays = Math.min(365, Math.max(0, Math.floor(totalBuffer / shockDailyBurn)));

  const shockVerdict: RunwayVerdict =
    shockRunwayDays >= 45 ? "COMFORTABLE" : shockRunwayDays >= 20 ? "MODERATE" : "CRITICAL";

  const severeShock: ScenarioRunway = {
    scenarioName: "Severe Shock",
    description: "Ağır piyasa krizi: Tahsilatların %60 kesilmesi, banka kredi hatlarının dondurulması.",
    monthlyBurnRate: Math.round(shockMonthlyNetBurn),
    dailyBurnRate: Math.round(shockDailyBurn),
    effectiveCashBuffer: totalBuffer,
    runwayDays: shockRunwayDays,
    runwayMonths: Number((shockRunwayDays / 30).toFixed(1)),
    cashOutDate: addDaysISO(asOfDate, shockRunwayDays),
    cashOutDateWithCredit: null, // Kredi limitleri dondurulmuş varsayılır
    runwayWithCreditDays: null,
    verdict: shockVerdict,
    mitigationActions: [
      "Acil durum nakit komitesi kurun.",
      "Tüm sermaye yatırımlarını (CAPEX) derhal iptal edin.",
      "Stok eritme ve peşin nakit satış kampanyası başlatın.",
      "Vergi ve SGK yapılandırma imkanlarını devreye alın.",
    ],
  };

  let summary = "Şirket nakit tamponu olağan şartlarda yeterli.";
  if (baseVerdict === "CRITICAL" || pessVerdict === "CRITICAL") {
    summary = `DİKKAT: Kötümsel senaryoda kasanın ${pessRunwayDays} gün içinde (${pessimistic.cashOutDate}) tükenme riski bulunmaktadır! Acil nakit koruma tedbirleri uygulanmalıdır.`;
  } else if (pessVerdict === "VULNERABLE") {
    summary = `UYARI: Olası tahsilat aksamalarında nakit dayanıklılığı ${pessRunwayDays} güne düşmektedir. Kredi hatlarının teyit edilmesi önerilir.`;
  }

  return {
    asOfDate,
    totalLiquidCash: liquidCashTRY,
    availableCreditHeadroom: creditHeadroomTRY,
    totalLiquidityBuffer: liquidCashTRY + creditHeadroomTRY,
    scenarios: {
      baseline,
      pessimistic,
      severeShock,
    },
    summaryRecommendation: summary,
  };
}

/**
 * PostgreSQL veritabanındaki fiili hazine, alacak ve bütçe görünümlerinden beslenerek
 * canlı Cash Runway analizini hazırlar.
 */
export async function loadCashRunwayAnalysis(
  pool: Pool,
  todayISO = istanbulDateISO(),
): Promise<CashRunwayReport> {
  const [positions, gaps, facilityRes, budgetRes] = await Promise.all([
    loadPositionSummary(pool).catch(() => []),
    loadLiquidityGap(pool).catch(() => []),
    pool.query(`
      select coalesce(sum(available_amount), 0) as total_headroom
      from public.credit_facility_utilization
      where status = 'active' and currency = 'TRY'
    `).catch(() => ({ rows: [] })),
    pool.query(`
      select
        coalesce(sum(budget_amount), 0) as total_budget_expense,
        coalesce(sum(actual_amount), 0) as total_actual_expense
      from public.budget_vs_actual
    `).catch(() => ({ rows: [] })),
  ]);

  const tryPos = positions.find((p) => p.currency === "TRY") ?? positions[0];
  const liquidCash = tryPos?.availableNow ?? 0;
  const gap30 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 30);
  const minFloor = gap30?.minCashFloor ?? 100000;
  const creditHeadroom = Number(facilityRes.rows[0]?.total_headroom ?? 0);

  // Ortalama aylık operasyonel gider (Bütçe veya fiili giderlerden türetilir)
  const actualExpense = Number(budgetRes.rows[0]?.total_actual_expense ?? 0);
  const budgetExpense = Number(budgetRes.rows[0]?.total_budget_expense ?? 0);
  const monthlyExpense = actualExpense > 0 ? actualExpense : budgetExpense > 0 ? budgetExpense : 500000;

  // Aylık beklenen tahsilat (Sözleşmeli ve öngörülen nakit akışı)
  const monthlyInflow = gap30?.projectedContracted != null && gap30.projectedContracted > 0
    ? gap30.projectedContracted
    : monthlyExpense * 0.95; // Default dengeli nakit akışı

  return calculateCashRunway({
    asOfDate: todayISO,
    liquidCashTRY: liquidCash,
    creditHeadroomTRY: creditHeadroom,
    monthlyOperatingExpense: monthlyExpense,
    monthlyContractedInflow: monthlyInflow,
    minCashFloor: minFloor,
  });
}
