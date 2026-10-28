/**
 * MAS Nakit Radar — Kilit Taşı 4: Kredi Limiti ve Hazine Rezerv Kalkanı
 * (Treasury Headroom & Liquidity Buffer Shield Engine)
 * 
 * credit_facilities ↔ collateral_covenants ↔ cash_forecast_13w
 * 
 * 13 haftalık nakit akışı projeksiyonunda açık (deficit) çıkan günleri/haftaları
 * bankalardaki boş kredi limitleri ve teminat kapasitesiyle eşleştirir;
 * en düşük faiz maliyetli kredi kullanım reçetesini otomatik üretir.
 */

import type { Pool } from "pg";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

export interface FacilityHeadroom {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  currency: string;
  lenderName: string;
  limitAmount: number;
  drawnAmount: number;
  availableAmount: number;
  utilizationRatio: number;
  interestRate: number | null;
  daysToExpiry: number | null;
}

export interface CashDeficit {
  horizonDate: string;
  horizonLabel: string;
  projectedBalance: number;
  requiredBuffer: number;
  deficitAmount: number;
}

export interface HeadroomRecommendation {
  targetDate: string;
  deficitAmount: number;
  recommendedFacilityId: string;
  recommendedFacilityName: string;
  lenderName: string;
  facilityType: string;
  availableAmount: number;
  recommendedDrawdown: number;
  interestRate: number | null;
  estimatedMonthlyInterest: number;
  coverageStatus: "fully_covered" | "partially_covered" | "no_headroom";
}

export interface TreasuryShieldReport {
  totalCreditLimit: number;
  totalDrawn: number;
  totalAvailableHeadroom: number;
  weightedAverageInterestRate: number | null;
  deficitsIdentified: number;
  recommendations: HeadroomRecommendation[];
}

/**
 * Bankalardaki nakit kredi limitlerini ve kullanılabilir boşlukları listeler.
 */
export async function loadActiveFacilities(pool: Pool): Promise<FacilityHeadroom[]> {
  const res = await pool.query<{
    facility_id: string;
    facility_name: string;
    facility_type: string;
    currency: string;
    lender_name: string | null;
    limit_amount: string;
    drawn_amount: string;
    available_amount: string;
    utilization_ratio: string | null;
    interest_rate: string | null;
    days_to_expiry: number | null;
  }>(`
    select 
      facility_id,
      facility_name,
      facility_type,
      currency,
      coalesce(lender_name, 'Bilinmeyen Banka') as lender_name,
      limit_amount,
      drawn_amount,
      available_amount,
      utilization_ratio,
      interest_rate,
      days_to_expiry
    from public.credit_facility_utilization
    where status = 'active'
      and facility_type in ('revolving', 'overdraft', 'spot')
      and available_amount > 0
    order by interest_rate asc nulls last, available_amount desc
  `);

  return res.rows.map((r) => ({
    facilityId: r.facility_id,
    facilityName: r.facility_name,
    facilityType: r.facility_type,
    currency: r.currency,
    lenderName: r.lender_name ?? "Bilinmeyen Banka",
    limitAmount: Number(r.limit_amount),
    drawnAmount: Number(r.drawn_amount),
    availableAmount: Number(r.available_amount),
    utilizationRatio: r.utilization_ratio ? Number(r.utilization_ratio) : 0,
    interestRate: r.interest_rate ? Number(r.interest_rate) : null,
    daysToExpiry: r.days_to_expiry,
  }));
}

/**
 * Gelecek nakit açıklarını (deficit) tespit eder.
 */
export async function loadProjectedDeficits(pool: Pool, minBuffer = 50000): Promise<CashDeficit[]> {
  // cash_forecast_13w veya daily_cash_movement görünümlerinden projeksiyonu tara
  const res = await pool.query<{
    forecast_date: string;
    forecast_week: string;
    closing_balance: string;
  }>(`
    select 
      forecast_date::text,
      'Hafta ' || week_number as forecast_week,
      closing_cash as closing_balance
    from public.cash_forecast_13w
    where closing_cash < $1
    order by forecast_date asc
    limit 10
  `, [minBuffer]).catch(async () => {
    // Görünüm henüz veri taşımıyorsa fallback
    return { rows: [] };
  });

  return res.rows.map((r) => {
    const rawVal = r.closing_balance ?? (r as any).closing_cash ?? 0;
    const bal = Number(rawVal);
    const deficit = Math.max(0, minBuffer - bal);
    return {
      horizonDate: r.forecast_date,
      horizonLabel: r.forecast_week,
      projectedBalance: bal,
      requiredBuffer: minBuffer,
      deficitAmount: deficit,
    };
  });
}

/**
 * Açıkları boş kredi limitleriyle eşleştirerek maliyeti en düşük hazine reçetesini üretir.
 */
export async function computeTreasuryShieldReport(
  pool: Pool,
  options?: { minBuffer?: number; bypassCache?: boolean },
): Promise<TreasuryShieldReport> {
  const cacheKey = "treasury:shield:report";

  if (!options?.bypassCache) {
    const cached = await cache.get<TreasuryShieldReport>(cacheKey);
    if (cached) return cached;
  }

  const facilities = await loadActiveFacilities(pool);
  const deficits = await loadProjectedDeficits(pool, options?.minBuffer ?? 50000);

  let totalLimit = 0;
  let totalDrawn = 0;
  let totalAvail = 0;
  let weightedRateSum = 0;
  let rateWeightedBase = 0;

  for (const f of facilities) {
    totalLimit += f.limitAmount;
    totalDrawn += f.drawnAmount;
    totalAvail += f.availableAmount;
    if (f.interestRate != null) {
      weightedRateSum += f.interestRate * f.availableAmount;
      rateWeightedBase += f.availableAmount;
    }
  }

  const weightedAverageRate = rateWeightedBase > 0 ? weightedRateSum / rateWeightedBase : null;

  // Açıklarla kredi limitlerini eşleştir (en ucuz faizli kredi önce)
  const recommendations: HeadroomRecommendation[] = [];
  const trackingHeadroom = facilities.map((f) => ({ ...f, simulatedAvailable: f.availableAmount }));

  for (const deficit of deficits) {
    let needed = deficit.deficitAmount;
    let matched = false;

    for (const fac of trackingHeadroom) {
      if (fac.simulatedAvailable <= 0) continue;

      const drawdown = Math.min(needed, fac.simulatedAvailable);
      fac.simulatedAvailable -= drawdown;
      needed -= drawdown;

      const monthlyInterest = fac.interestRate ? (drawdown * (fac.interestRate / 100)) / 12 : 0;

      recommendations.push({
        targetDate: deficit.horizonDate,
        deficitAmount: deficit.deficitAmount,
        recommendedFacilityId: fac.facilityId,
        recommendedFacilityName: fac.facilityName,
        lenderName: fac.lenderName,
        facilityType: fac.facilityType,
        availableAmount: fac.availableAmount,
        recommendedDrawdown: drawdown,
        interestRate: fac.interestRate,
        estimatedMonthlyInterest: monthlyInterest,
        coverageStatus: needed <= 0 ? "fully_covered" : "partially_covered",
      });

      if (needed <= 0) {
        matched = true;
        break;
      }
    }

    if (!matched && needed > 0) {
      recommendations.push({
        targetDate: deficit.horizonDate,
        deficitAmount: deficit.deficitAmount,
        recommendedFacilityId: "",
        recommendedFacilityName: "Yetersiz Limit",
        lenderName: "Açık Finansman Boşluğu",
        facilityType: "none",
        availableAmount: 0,
        recommendedDrawdown: 0,
        interestRate: null,
        estimatedMonthlyInterest: 0,
        coverageStatus: "no_headroom",
      });
    }
  }

  const report: TreasuryShieldReport = {
    totalCreditLimit: totalLimit,
    totalDrawn: totalDrawn,
    totalAvailableHeadroom: totalAvail,
    weightedAverageInterestRate: weightedAverageRate ? Number(weightedAverageRate.toFixed(4)) : null,
    deficitsIdentified: deficits.length,
    recommendations,
  };

  await cache.set(cacheKey, report, {
    ttlSeconds: 600,
    tags: [CACHE_TAGS.TREASURY, CACHE_TAGS.CREDIT_FACILITIES, CACHE_TAGS.CASHFLOW],
  });

  return report;
}
