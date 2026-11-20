import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, money, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import type { Queryable } from "./fx-rates";

const round2 = money;
const numOrNull = rateOrNull;

export const CORPORATE_TAX_RATE_DEFAULT = 0.25;

export interface CapexYearScheduleRow {
  yearIndex: number;
  grossEbitdaTry: number;
  depreciation253_257Try: number;
  taxShieldTry: number;
  corporateTaxPayableTry: number;
  afterTaxCashFlowTry: number;
  discountedCashFlowTry: number;
  cumulativeDiscountedTry: number;
}

export interface CapexFeasibilityInput {
  purchaseCostTry: number;
  usefulLifeYears: number;
  annualRevenueTry: number;
  annualOperatingCostTry: number;
  discountRatePct: number;
  corporateTaxRate?: number;
}

export interface CapexFeasibilityResult {
  purchaseCostTry: number;
  usefulLifeYears: number;
  discountRatePct: number;
  corporateTaxRate: number;
  annualEbitdaTry: number;
  /** TDHP 253 / 257 straight-line annual depreciation = purchase_cost / useful_life_years */
  annualDepreciationTry: number;
  /** Corporate tax shield = annual_depreciation * 0.25 */
  taxShieldAmountTry: number;
  annualCorporateTaxTry: number;
  annualAfterTaxCashFlowTry: number;
  npvTry: number;
  irrPct: number | null;
  simplePaybackMonths: number | null;
  discountedPaybackMonths: number | null;
  profitabilityIndex: number | null;
  decisionVerdict: "yatirim_uygun" | "sinirda_izle" | "yatirim_ret";
  schedule: CapexYearScheduleRow[];
}

function npvAtRate(cashFlowDec: ReturnType<typeof decimal>, costDec: ReturnType<typeof decimal>, years: number, rDec: ReturnType<typeof decimal>) {
  let pvSum = decimal(0);
  const onePlusR = decimal(1).plus(rDec);
  for (let t = 1; t <= years; t++) {
    const denom = onePlusR.pow(t);
    pvSum = pvSum.plus(cashFlowDec.div(denom));
  }
  return pvSum.minus(costDec);
}

/**
 * Pure deterministic CAPEX Feasibility calculator (M-49):
 * - TDHP 253 / 257 straight-line depreciation (`purchase_cost / useful_life_years`)
 * - 25% corporate tax shield (`annual_depreciation * 0.25`)
 * - NPV discounted at `discountRatePct` (WACC / TLREF)
 * - IRR solved via exact Big.js bisection (zero binary float error)
 * - Simple & Discounted Payback Period in months
 */
export function computeCapexFeasibility(input: CapexFeasibilityInput): CapexFeasibilityResult {
  if (!(input.purchaseCostTry > 0)) {
    throw new DomainError("Makine yatırım tutarı (CAPEX) 0'dan büyük olmalıdır.");
  }
  if (!Number.isInteger(input.usefulLifeYears) || input.usefulLifeYears < 1 || input.usefulLifeYears > 50) {
    throw new DomainError("Ekonomik ömür (yıl) 1 ile 50 arasında tam sayı olmalıdır.");
  }
  if (input.discountRatePct < 0 || input.discountRatePct > 300) {
    throw new DomainError("İskonto oranı (WACC/TLREF) %0 ile %300 arasında olmalıdır.");
  }

  const taxRateDec = decimal(input.corporateTaxRate ?? CORPORATE_TAX_RATE_DEFAULT);
  const costDec = decimal(input.purchaseCostTry);
  const lifeDec = decimal(input.usefulLifeYears);
  const revDec = decimal(input.annualRevenueTry);
  const opCostDec = decimal(input.annualOperatingCostTry);
  const ebitdaDec = revDec.minus(opCostDec);

  // TDHP 253 Tesis, Makine ve Cihazlar / 257 Birikmiş Amortismanlar (-)
  const annualDeprDec = costDec.div(lifeDec);
  const annualDepreciationTry = round2(annualDeprDec);

  // 25% Kurumlar Vergisi Amortisman Vergi Kalkanı
  const taxShieldDec = annualDeprDec.times(taxRateDec);
  const taxShieldAmountTry = round2(taxShieldDec);

  // Vergi matrahı = max(0, EBITDA - Amortisman)
  // Eğer EBITDA >= Amortisman ise: Vergi = (EBITDA - D)*0.25 = EBITDA*0.25 - VergiKalkanı
  // Vergi sonrası nakit akışı = EBITDA - Vergi = EBITDA*(1 - 0.25) + VergiKalkanı
  // Eğer şirket konsolide vergi matrahına sahipse ve EBITDA > 0 ise amortisman kalkanı grup matrahından düşer.
  const taxableProfitDec = ebitdaDec.gt(annualDeprDec) ? ebitdaDec.minus(annualDeprDec) : decimal(0);
  const annualTaxDec = ebitdaDec.gt(0)
    ? (ebitdaDec.gte(annualDeprDec)
        ? taxableProfitDec.times(taxRateDec)
        : decimal(0))
    : decimal(0);
  const afterTaxCfDec = ebitdaDec.gt(0)
    ? (ebitdaDec.gte(annualDeprDec)
        ? ebitdaDec.minus(annualTaxDec)
        : ebitdaDec.times(decimal(1).minus(taxRateDec)).plus(taxShieldDec))
    : ebitdaDec;

  const annualEbitdaTry = round2(ebitdaDec);
  const annualCorporateTaxTry = round2(annualTaxDec);
  const annualAfterTaxCashFlowTry = round2(afterTaxCfDec);

  const rDec = decimal(input.discountRatePct).div(100);
  const onePlusR = decimal(1).plus(rDec);

  let cumulativeDiscDec = costDec.times(-1);
  let totalPvInflowsDec = decimal(0);
  let discountedPaybackMonths: number | null = null;
  const schedule: CapexYearScheduleRow[] = [];

  for (let t = 1; t <= input.usefulLifeYears; t++) {
    const pvDec = afterTaxCfDec.div(onePlusR.pow(t));
    const prevCumDec = cumulativeDiscDec;
    cumulativeDiscDec = cumulativeDiscDec.plus(pvDec);
    totalPvInflowsDec = totalPvInflowsDec.plus(pvDec);

    if (discountedPaybackMonths == null && prevCumDec.lt(0) && cumulativeDiscDec.gte(0) && pvDec.gt(0)) {
      const fractionOfYear = prevCumDec.abs().div(pvDec);
      const months = decimal(t - 1).times(12).plus(fractionOfYear.times(12));
      discountedPaybackMonths = round2(months);
    }

    schedule.push({
      yearIndex: t,
      grossEbitdaTry: annualEbitdaTry,
      depreciation253_257Try: annualDepreciationTry,
      taxShieldTry: taxShieldAmountTry,
      corporateTaxPayableTry: annualCorporateTaxTry,
      afterTaxCashFlowTry: annualAfterTaxCashFlowTry,
      discountedCashFlowTry: round2(pvDec),
      cumulativeDiscountedTry: round2(cumulativeDiscDec),
    });
  }

  const npvDec = totalPvInflowsDec.minus(costDec);
  const npvTry = round2(npvDec);

  const simplePaybackMonths =
    afterTaxCfDec.gt(0)
      ? round2(costDec.div(afterTaxCfDec).times(12))
      : null;

  // Solve IRR via Big.js bisection on [-0.90, 5.00] (-90% .. +500%)
  let irrPct: number | null = null;
  if (afterTaxCfDec.gt(0)) {
    const undiscountedTotal = afterTaxCfDec.times(lifeDec);
    // Even if undiscounted < cost, IRR can still be negative (between -90% and 0%) if total > 0!
    let low = decimal("-0.90");
    let high = decimal("5.00");
    const npvLow = npvAtRate(afterTaxCfDec, costDec, input.usefulLifeYears, low);
    const npvHigh = npvAtRate(afterTaxCfDec, costDec, input.usefulLifeYears, high);

    if (undiscountedTotal.gt(0) && npvLow.gte(0) && npvHigh.lte(0)) {
      for (let iter = 0; iter < 80; iter++) {
        const mid = low.plus(high).div(2);
        const val = npvAtRate(afterTaxCfDec, costDec, input.usefulLifeYears, mid);
        if (val.eq(0)) {
          low = mid;
          high = mid;
          break;
        }
        if (val.gt(0)) {
          low = mid;
        } else {
          high = mid;
        }
      }
      irrPct = round2(low.plus(high).div(2).times(100));
    }
  }

  const profitabilityIndex = round2(totalPvInflowsDec.div(costDec));

  const decisionVerdict: CapexFeasibilityResult["decisionVerdict"] =
    npvTry > 0 && (irrPct == null || irrPct >= input.discountRatePct)
      ? "yatirim_uygun"
      : annualAfterTaxCashFlowTry > 0 && npvTry > -round2(costDec.times("0.05"))
        ? "sinirda_izle"
        : "yatirim_ret";

  return {
    purchaseCostTry: round2(costDec),
    usefulLifeYears: input.usefulLifeYears,
    discountRatePct: round2(decimal(input.discountRatePct)),
    corporateTaxRate: Number(taxRateDec.toFixed(4)),
    annualEbitdaTry,
    annualDepreciationTry,
    taxShieldAmountTry,
    annualCorporateTaxTry,
    annualAfterTaxCashFlowTry,
    npvTry,
    irrPct,
    simplePaybackMonths,
    discountedPaybackMonths,
    profitabilityIndex,
    decisionVerdict,
    schedule,
  };
}

export interface CapexRoiSnapshotRow {
  snapshotId: string;
  assetId: string;
  machineCode: string | null;
  machineName: string;
  snapshotYear: number | null;
  purchaseCostTry: number | null;
  usefulLifeYears: number | null;
  discountRatePct: number | null;
  annualRevenueTry: number | null;
  annualCostTry: number | null;
  annualDepreciationTry: number | null;
  taxShieldAmountTry: number | null;
  netAfterTaxTry: number | null;
  npvTry: number | null;
  irrPct: number | null;
  paybackMonths: number | null;
  discountedPaybackMonths: number | null;
  confidence: string;
  notes: string | null;
}

export const capexSimulationFormSchema = z.object({
  machineName: z.string().trim().min(1, "Makine / Yatırım adı zorunlu").max(180),
  machineCode: z.string().trim().max(60).optional().nullable(),
  purchaseDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD olmalı")
    .optional()
    .nullable(),
  purchaseCostTry: z.coerce.number().positive("Yatırım bedeli (TL) > 0 olmalı"),
  usefulLifeYears: z.coerce.number().int().min(1, "Ekonomik ömür en az 1 yıl").max(30, "En fazla 30 yıl").default(5),
  discountRatePct: z.coerce.number().min(0, "İskonto oranı >= 0").max(300, "İskonto oranı <= 300").default(35),
  annualRevenueTry: z.coerce.number().min(0, "Yıllık beklenen gelir >= 0"),
  annualOperatingCostTry: z.coerce.number().min(0, "Yıllık işletme gideri >= 0"),
  utilizationRate: z.coerce.number().min(0).max(1.5).optional().nullable(),
  snapshotYear: z.coerce.number().int().min(2000).max(2100).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function loadCapexRoiSnapshots(client: Queryable): Promise<CapexRoiSnapshotRow[]> {
  try {
    const res = await client.query<{
      snapshot_id: string;
      asset_id: string;
      machine_code: string | null;
      machine_name: string;
      snapshot_year: number | null;
      purchase_cost: string | null;
      useful_life_years: number | null;
      useful_life_months: number | null;
      discount_rate_pct: string | null;
      annual_revenue: string | null;
      annual_cost: string | null;
      annual_depreciation: string | null;
      tax_shield_amount: string | null;
      net_after_tax: string | null;
      npv_try: string | null;
      irr_pct: string | null;
      payback_months: string | null;
      discounted_payback_months: string | null;
      confidence: string;
      notes: string | null;
    }>(
      `select
         s.id::text as snapshot_id,
         a.id::text as asset_id,
         a.machine_code,
         a.name as machine_name,
         s.snapshot_year,
         a.purchase_cost::text,
         coalesce(s.useful_life_years, case when a.useful_life_months is not null and a.useful_life_months >= 12 then round(a.useful_life_months / 12.0)::int else null end) as useful_life_years,
         a.useful_life_months,
         s.discount_rate_pct::text,
         s.revenue::text as annual_revenue,
         s.cost::text as annual_cost,
         s.annual_depreciation::text,
         s.tax_shield_amount::text,
         s.net_after_tax::text,
         s.npv_try::text,
         s.irr_pct::text,
         s.discounted_payback_months::text,
         s.confidence,
         coalesce(s.notes, a.notes) as notes
       from public.machine_roi_snapshots s
       join public.machine_assets a on a.id = s.machine_asset_id
       order by s.created_at desc, a.name asc`,
    );

    return (res.rows ?? []).map((r) => {
      const purchaseCostTry = numOrNull(r.purchase_cost);
      const usefulLifeYears = r.useful_life_years != null ? Number(r.useful_life_years) : null;
      const discountRatePct = numOrNull(r.discount_rate_pct);
      const annualRevenueTry = numOrNull(r.annual_revenue);
      const annualCostTry = numOrNull(r.annual_cost);
      const netAfterTaxRaw = numOrNull(r.net_after_tax);

      // Compute on-the-fly fallback if legacy snapshot predates 0118 columns AND has purchase_cost + revenue + cost
      let computedFallback: CapexFeasibilityResult | null = null;
      if (
        r.npv_try == null &&
        purchaseCostTry != null &&
        purchaseCostTry > 0 &&
        annualRevenueTry != null &&
        annualCostTry != null
      ) {
        computedFallback = computeCapexFeasibility({
          purchaseCostTry,
          usefulLifeYears: usefulLifeYears && usefulLifeYears >= 1 ? usefulLifeYears : 5,
          annualRevenueTry,
          annualOperatingCostTry: annualCostTry,
          discountRatePct: discountRatePct ?? 35,
        });
      }

      const netAfterTaxTry = netAfterTaxRaw ?? computedFallback?.annualAfterTaxCashFlowTry ?? null;
      const derivedPaybackMonths =
        purchaseCostTry != null && purchaseCostTry > 0 && netAfterTaxTry != null && netAfterTaxTry > 0
          ? round2(decimal(purchaseCostTry).div(decimal(netAfterTaxTry)).times(12))
          : null;

      return {
        snapshotId: r.snapshot_id,
        assetId: r.asset_id,
        machineCode: r.machine_code,
        machineName: r.machine_name,
        snapshotYear: r.snapshot_year,
        purchaseCostTry,
        usefulLifeYears: usefulLifeYears ?? computedFallback?.usefulLifeYears ?? null,
        discountRatePct: discountRatePct ?? computedFallback?.discountRatePct ?? null,
        annualRevenueTry,
        annualCostTry,
        annualDepreciationTry:
          numOrNull(r.annual_depreciation) ?? computedFallback?.annualDepreciationTry ?? null,
        taxShieldAmountTry:
          numOrNull(r.tax_shield_amount) ?? computedFallback?.taxShieldAmountTry ?? null,
        netAfterTaxTry,
        npvTry: numOrNull(r.npv_try) ?? computedFallback?.npvTry ?? null,
        irrPct: numOrNull(r.irr_pct) ?? computedFallback?.irrPct ?? null,
        paybackMonths: derivedPaybackMonths ?? computedFallback?.simplePaybackMonths ?? null,
        discountedPaybackMonths:
          numOrNull(r.discounted_payback_months) ?? computedFallback?.discountedPaybackMonths ?? null,
        confidence: r.confidence,
        notes: r.notes,
      };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return [];
    }
    throw err;
  }
}

export async function simulateAndSaveCapexRoi(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ assetId: string; snapshotId: string; feasibility: CapexFeasibilityResult }> {
  const input = parseOrThrow(capexSimulationFormSchema, rawInput, "CAPEX fizibilite formu");
  const feasibility = computeCapexFeasibility({
    purchaseCostTry: input.purchaseCostTry,
    usefulLifeYears: input.usefulLifeYears,
    annualRevenueTry: input.annualRevenueTry,
    annualOperatingCostTry: input.annualOperatingCostTry,
    discountRatePct: input.discountRatePct,
  });

  const snapshotYear = input.snapshotYear ?? new Date().getFullYear();
  const usefulLifeMonths = input.usefulLifeYears * 12;
  const monthlyRev = round2(decimal(input.annualRevenueTry).div(12));
  const monthlyCost = round2(decimal(input.annualOperatingCostTry).div(12));

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query<{ id: string }>(
      `select id::text from public.machine_assets where lower(name) = lower($1) limit 1`,
      [input.machineName],
    );

    let assetId: string;
    if (existing.rowCount === 1) {
      assetId = existing.rows[0].id;
      const updAsset = await client.query(
        `update public.machine_assets
            set machine_code = coalesce($2, machine_code),
                purchase_date = coalesce($3::date, purchase_date),
                purchase_cost = $4,
                monthly_revenue = $5,
                monthly_operating_cost = $6,
                utilization_rate = coalesce($7, utilization_rate),
                useful_life_months = $8,
                notes = coalesce($9, notes)
          where id = $1`,
        [
          assetId,
          input.machineCode ?? null,
          input.purchaseDate ?? null,
          feasibility.purchaseCostTry,
          monthlyRev,
          monthlyCost,
          input.utilizationRate ?? null,
          usefulLifeMonths,
          input.notes ?? null,
        ],
      );
      if (updAsset.rowCount !== 1) {
        throw new DomainError("Makine varlığı güncellenemedi.");
      }
    } else {
      const insAsset = await client.query<{ id: string }>(
        `insert into public.machine_assets
           (machine_code, name, purchase_date, purchase_cost, monthly_revenue,
            monthly_operating_cost, utilization_rate, useful_life_months, notes)
         values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)
         returning id::text`,
        [
          input.machineCode ?? null,
          input.machineName,
          input.purchaseDate ?? null,
          feasibility.purchaseCostTry,
          monthlyRev,
          monthlyCost,
          input.utilizationRate ?? null,
          usefulLifeMonths,
          input.notes ?? null,
        ],
      );
      if (insAsset.rowCount !== 1) {
        throw new DomainError("Makine varlığı oluşturulamadı.");
      }
      assetId = insAsset.rows[0].id;
    }

    const snapIns = await client.query<{ id: string }>(
      `insert into public.machine_roi_snapshots
         (machine_asset_id, snapshot_year, revenue, cost, remaining,
          tax, net_after_tax, confidence, notes,
          useful_life_years, discount_rate_pct, annual_depreciation, tax_shield_amount,
          npv_try, irr_pct, discounted_payback_months)
       values ($1, $2, $3, $4, $5, $6, $7, 'calculated', $8,
               $9, $10, $11, $12, $13, $14, $15)
       on conflict (machine_asset_id, snapshot_year) do update set
         revenue = excluded.revenue,
         cost = excluded.cost,
         remaining = excluded.remaining,
         tax = excluded.tax,
         net_after_tax = excluded.net_after_tax,
         confidence = excluded.confidence,
         notes = excluded.notes,
         useful_life_years = excluded.useful_life_years,
         discount_rate_pct = excluded.discount_rate_pct,
         annual_depreciation = excluded.annual_depreciation,
         tax_shield_amount = excluded.tax_shield_amount,
         npv_try = excluded.npv_try,
         irr_pct = excluded.irr_pct,
         discounted_payback_months = excluded.discounted_payback_months
       returning id::text`,
      [
        assetId,
        snapshotYear,
        round2(decimal(input.annualRevenueTry)),
        round2(decimal(input.annualOperatingCostTry)),
        feasibility.annualEbitdaTry,
        feasibility.annualCorporateTaxTry,
        feasibility.annualAfterTaxCashFlowTry,
        input.notes ?? null,
        feasibility.usefulLifeYears,
        feasibility.discountRatePct,
        feasibility.annualDepreciationTry,
        feasibility.taxShieldAmountTry,
        feasibility.npvTry,
        feasibility.irrPct,
        feasibility.discountedPaybackMonths,
      ],
    );
    if (snapIns.rowCount !== 1) {
      throw new DomainError("CAPEX fizibilite anlık görüntüsü kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "simulate_capex_roi",
      entityTable: "machine_roi_snapshots",
      entityId: snapIns.rows[0].id,
      after: {
        assetId,
        machineName: input.machineName,
        purchaseCostTry: feasibility.purchaseCostTry,
        usefulLifeYears: feasibility.usefulLifeYears,
        discountRatePct: feasibility.discountRatePct,
        annualDepreciationTry: feasibility.annualDepreciationTry,
        taxShieldAmountTry: feasibility.taxShieldAmountTry,
        npvTry: feasibility.npvTry,
        irrPct: feasibility.irrPct,
        discountedPaybackMonths: feasibility.discountedPaybackMonths,
        decisionVerdict: feasibility.decisionVerdict,
      },
    });

    await client.query("commit");
    return { assetId, snapshotId: snapIns.rows[0].id, feasibility };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
