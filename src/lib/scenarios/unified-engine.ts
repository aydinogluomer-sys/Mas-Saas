/**
 * Dalga 2B (`M-50`, `M-52`, `M-53`) — Birleşik 13 Haftalık Dinamik Senaryo Motoru (`unified-engine.ts`).
 *
 * Tek birleşik simülasyon zinciri:
 *   Canlı 13H Nakit Tahmini (`rolling-13w-engine`)
 * + Canlı YP Açık Pozisyon (`live_fx_exposure_v`)
 * + Canlı BOM Döviz Hammadde Hassasiyeti (`loadBomSummaries`)
 * + Onaylı Dış Varsayımlar (`external_assumptions`)
 * + Kullanılabilir Rotatif Kredi Limitleri (`credit_facilities`)
 *   ↓
 * Haftalar 1..13 boyunca eşzamanlı:
 *   1. Kur Şoku (`fxShockPct`): YP kasa/banka, YP alacak/borç, YP kredi taksitleri ve YP BOM alımlarını değerler,
 *   2. Tahsilat Gecikmesi (`collectionDelayDays`) & Tedarikçi Vade Uzatma (`paymentDelayDays`):
 *      13. haftanın ötesine taşan tahsilatları ASLA yok etmez; `deferred_receivables_carryover` olarak kaydeder!
 *   3. Satış Hacim Şoku (`revenueDeltaPct`) & Maliyet Fiyat Geçişi (`passThroughPct`),
 *   4. Otomatik Rotatif Limit Çekimi (`auto_facility_draw`): Haftalık kapanış `minCashBufferTry` altına
 *      düştüğünde kalan kredi limitinden otomatik çeker, haftalık `780` ek faiz + `%5 BSMV` + `KKDF`
 *      (`incremental_interest_tax`) hesaplar, proforma `EBITDA` / `projected_dscr` ve `covenant_breach` üretir.
 *
 * Sıfır kayan nokta: tüm parasal/oran hesapları `Big.js` (`@/lib/money`) ile yürütülür.
 */

import type { Pool } from "pg";
import { z } from "zod";
import { loadApprovedExternalAssumptions } from "@/lib/external-assumptions/engine";
import { audit } from "@/lib/audit";
import { buildAutoSeeded13WeekForecast } from "@/lib/cashflow/rolling-13w-engine";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, money, moneyOrNull, rateOrNull, roundMoney } from "@/lib/money";
import { loadBomSummaries } from "@/lib/production/bom";
import { istanbulDateISO } from "@/lib/reports/rules";
import { parseOrThrow } from "@/lib/validation";

export interface UnifiedBaselineWeekInput {
  weekIndex: number;
  weekStart: string;
  baselineInflow: number;
  baselineOutflow: number;
  /** Sözleşmesel sert çıkışlar (kredi taksiti + vergi/SGK): `paymentDelayDays` ile ötelenmez. */
  hardOutflow?: number;
  baselineClosingCash: number | null;
  /** İlgili haftadaki YP tahsilatların baz TL karşılığı */
  fxReceivableInflowTry?: number;
  /** İlgili haftadaki YP tedarikçi borç/çek çıkışlarının baz TL karşılığı */
  fxPayableOutflowTry?: number;
  /** İlgili haftadaki YP kredi taksitlerinin baz TL karşılığı */
  fxLoanOutflowTry?: number;
  /** İlgili haftadaki ithal/YP BOM hammadde alımlarının baz TL karşılığı */
  bomFxOutflowTry?: number;
}

export interface UnifiedScenarioParams {
  fxShockPct: number;
  collectionDelayDays: number;
  paymentDelayDays: number;
  revenueDeltaPct: number;
  passThroughPct: number;
  expenseDeltaPct?: number;
  minCashBufferTry: number;
  autoDrawFacility: boolean;
}

export interface UnifiedScenarioSimulationInput {
  baselineWeeks: UnifiedBaselineWeekInput[];
  openingCashTry: number | null;
  /** YP kasa/banka varlıklarının baz TL karşılığı (`fxShockPct` ile 1. haftada değerlenir) */
  fxCashBankNetTry: number;
  availableFacilityHeadroomTry: number;
  /** Yıllık ağırlıklı rotatif kredi faiz oranı (ondalık: örn. `%48` -> `0.48`) */
  weightedFacilityAnnualRate: number;
  /** BSMV oranı (varsayılan `0.05` = `%5`) */
  bsmvRate?: number;
  /** KKDF oranı (ticari kredilerde varsayılan `0`) */
  kkdfRate?: number;
  baselineAnnualizedEbitdaTry: number | null;
  baselineAnnualDebtServiceTry: number;
  /** Yıllık YP kredi borç servisinin baz TL karşılığı (`fxShockPct` ile DSCR paydasını etkiler) */
  fxAnnualDebtServiceTry?: number;
  minDscrThreshold?: number;
  minCashCovenantTry?: number | null;
  params: UnifiedScenarioParams;
}

export interface UnifiedScenarioWeekResult {
  weekIndex: number;
  weekStart: string;
  baselineInflow: number;
  baselineOutflow: number;
  baselineClosingCash: number | null;
  scenarioInflow: number;
  scenarioOutflow: number;
  autoFacilityDraw: number;
  incrementalInterestTax: number;
  scenarioClosingCash: number | null;
  remainingFacilityHeadroom: number;
  projectedDscr: number | null;
  covenantBreach: boolean;
}

export interface UnifiedScenarioSimulationResult {
  weeks: UnifiedScenarioWeekResult[];
  baselineFinalCash: number | null;
  scenarioFinalCash: number | null;
  finalDelta: number | null;
  baselineFirstNegative: string | null;
  scenarioFirstNegative: string | null;
  worstWeekStart: string | null;
  worstBalance: number | null;
  maxCashGap: number | null;
  recoveryWeekStart: string | null;
  totalAutoFacilityDraw: number;
  totalIncrementalInterestTax: number;
  deferredReceivablesCarryover: number;
  deferredPayablesCarryover: number;
  projectedEbitdaTry: number | null;
  projectedMinDscr: number | null;
  covenantBreachCount: number;
  confidence: "high" | "medium" | "low";
  insights: string[];
}

export const unifiedScenarioRunSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullish(),
  fxShockPct: z.coerce.number().min(-80).max(300).default(0),
  collectionDelayDays: z.coerce.number().int().min(0).max(180).default(0),
  paymentDelayDays: z.coerce.number().int().min(0).max(180).default(0),
  revenueDeltaPct: z.coerce.number().min(-95).max(300).default(0),
  passThroughPct: z.coerce.number().min(0).max(150).default(0),
  expenseDeltaPct: z.coerce.number().min(-80).max(300).optional(),
  minCashBufferTry: z.coerce.number().min(0).max(10_000_000_000).optional(),
  autoDrawFacility: z.boolean().default(true),
  useExternalAssumptions: z.boolean().default(true),
});

export type UnifiedScenarioRunFormInput = z.infer<typeof unifiedScenarioRunSchema>;

function fmtTlPlain(n: number): string {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Saf (pure) deterministik 13 haftalık birleşik senaryo simülatörü (`M-50`).
 * Hiçbir tahsilatı vade kayması nedeniyle yok etmez; 13. hafta sonrasına taşan alacakları
 * kuruşu kuruşuna `deferredReceivablesCarryover` alanında muhafaza eder.
 */
export function simulateUnified13WeekScenario(
  input: UnifiedScenarioSimulationInput,
): UnifiedScenarioSimulationResult {
  const weeksCount = input.baselineWeeks.length;
  const p = input.params;
  const fxRatio = decimal(p.fxShockPct).div(100);
  const revFactor = decimal(1).plus(decimal(p.revenueDeltaPct).div(100));
  const passRatio = decimal(p.passThroughPct).div(100);
  const expRatio = decimal(p.expenseDeltaPct ?? 0).div(100);
  const minBufferDec = decimal(Math.max(0, p.minCashBufferTry));
  const minDscrDec = decimal(input.minDscrThreshold ?? 1.2);
  const minCashCovDec =
    input.minCashCovenantTry != null ? decimal(input.minCashCovenantTry) : null;

  const annualRateDec = decimal(Math.max(0, input.weightedFacilityAnnualRate));
  const taxMultiplierDec = decimal(1)
    .plus(decimal(input.bsmvRate ?? 0.05))
    .plus(decimal(input.kkdfRate ?? 0));
  // Haftalık efektif finansman çarpanı: (yıllık faiz / 52) * (1 + BSMV + KKDF)
  const weeklyFinanceRateDec = annualRateDec.div(52).times(taxMultiplierDec);

  // 1) Şoklanmış (kaydırılmamış) haftalık akışların hesaplanması
  const rawInflows = input.baselineWeeks.map(() => decimal(0));
  const stretchableOutflows = input.baselineWeeks.map(() => decimal(0));
  const hardOutflows = input.baselineWeeks.map(() => decimal(0));

  for (let i = 0; i < weeksCount; i++) {
    const bw = input.baselineWeeks[i];
    const baseIn = decimal(Math.max(0, bw.baselineInflow));
    const baseOut = decimal(Math.max(0, bw.baselineOutflow));
    const hardBase = decimal(Math.min(Math.max(0, bw.hardOutflow ?? 0), bw.baselineOutflow));
    const stretchBase = baseOut.minus(hardBase);

    const fxArDelta = decimal(bw.fxReceivableInflowTry ?? 0).times(fxRatio);
    const fxApDelta = decimal(bw.fxPayableOutflowTry ?? 0).times(fxRatio);
    const fxLoanDelta = decimal(bw.fxLoanOutflowTry ?? 0).times(fxRatio);
    const bomFxDelta = decimal(bw.bomFxOutflowTry ?? 0).times(fxRatio);

    const opExpDelta = stretchBase.times(expRatio);
    const totalCostShock = fxApDelta.plus(fxLoanDelta).plus(bomFxDelta).plus(opExpDelta);
    const positiveCostIncrease = totalCostShock.gt(0) ? totalCostShock : decimal(0);
    const passThroughInflowAdd = positiveCostIncrease.times(passRatio);

    const shockedIn = baseIn.plus(fxArDelta).times(revFactor).plus(passThroughInflowAdd);
    rawInflows[i] = shockedIn.gt(0) ? shockedIn : decimal(0);

    const shockedStretchOut = stretchBase.plus(fxApDelta).plus(bomFxDelta).plus(opExpDelta);
    stretchableOutflows[i] = shockedStretchOut.gt(0) ? shockedStretchOut : decimal(0);

    const shockedHardOut = hardBase.plus(fxLoanDelta);
    hardOutflows[i] = shockedHardOut.gt(0) ? shockedHardOut : decimal(0);
  }

  // 2) Gün bazlı kesirli hafta kaydırma + ufuk ötesi devir (`deferredReceivablesCarryover`)
  const shiftedInflows = input.baselineWeeks.map(() => decimal(0));
  let deferredReceivablesDec = decimal(0);
  const colWholeWeeks = Math.floor(Math.max(0, p.collectionDelayDays) / 7);
  const colRemDays = Math.max(0, p.collectionDelayDays) % 7;
  const colNextFrac = decimal(colRemDays).div(7);
  const colStayFrac = decimal(1).minus(colNextFrac);

  for (let i = 0; i < weeksCount; i++) {
    const amt = rawInflows[i];
    if (amt.lte(0)) continue;
    const stayPart = roundMoney(amt.times(colStayFrac));
    const nextPart = amt.minus(stayPart);

    const idxStay = i + colWholeWeeks;
    if (idxStay < weeksCount) {
      shiftedInflows[idxStay] = shiftedInflows[idxStay].plus(stayPart);
    } else {
      deferredReceivablesDec = deferredReceivablesDec.plus(stayPart);
    }

    if (nextPart.gt(0)) {
      const idxNext = i + colWholeWeeks + 1;
      if (idxNext < weeksCount) {
        shiftedInflows[idxNext] = shiftedInflows[idxNext].plus(nextPart);
      } else {
        deferredReceivablesDec = deferredReceivablesDec.plus(nextPart);
      }
    }
  }

  const shiftedStretchOutflows = input.baselineWeeks.map(() => decimal(0));
  let deferredPayablesDec = decimal(0);
  const payWholeWeeks = Math.floor(Math.max(0, p.paymentDelayDays) / 7);
  const payRemDays = Math.max(0, p.paymentDelayDays) % 7;
  const payNextFrac = decimal(payRemDays).div(7);
  const payStayFrac = decimal(1).minus(payNextFrac);

  for (let i = 0; i < weeksCount; i++) {
    const amt = stretchableOutflows[i];
    if (amt.lte(0)) continue;
    const stayPart = roundMoney(amt.times(payStayFrac));
    const nextPart = amt.minus(stayPart);

    const idxStay = i + payWholeWeeks;
    if (idxStay < weeksCount) {
      shiftedStretchOutflows[idxStay] = shiftedStretchOutflows[idxStay].plus(stayPart);
    } else {
      deferredPayablesDec = deferredPayablesDec.plus(stayPart);
    }

    if (nextPart.gt(0)) {
      const idxNext = i + payWholeWeeks + 1;
      if (idxNext < weeksCount) {
        shiftedStretchOutflows[idxNext] = shiftedStretchOutflows[idxNext].plus(nextPart);
      } else {
        deferredPayablesDec = deferredPayablesDec.plus(nextPart);
      }
    }
  }

  // Proforma yıllık EBITDA hesabı: tahakkuk bazında toplam üretilen giriş/çıkış farkını yansıtır
  // (vade kayması tahsilat zamanlamasını değiştirir, ekonomik geliri yok etmez!)
  const totalBaseInDec = input.baselineWeeks.reduce(
    (acc, w) => acc.plus(decimal(Math.max(0, w.baselineInflow))),
    decimal(0),
  );
  const totalBaseOutDec = input.baselineWeeks.reduce(
    (acc, w) => acc.plus(decimal(Math.max(0, w.baselineOutflow))),
    decimal(0),
  );
  const totalEconomicInDec = rawInflows.reduce((acc, d) => acc.plus(d), decimal(0));
  const totalEconomicOutDec = stretchableOutflows.reduce(
    (acc, d, idx) => acc.plus(d).plus(hardOutflows[idx]),
    decimal(0),
  );
  const quarterlyOperatingDeltaDec = totalEconomicInDec
    .minus(totalBaseInDec)
    .minus(totalEconomicOutDec.minus(totalBaseOutDec));
  const annualizedOperatingDeltaDec = quarterlyOperatingDeltaDec.times(4);

  const baseEbitdaDec =
    input.baselineAnnualizedEbitdaTry != null
      ? decimal(input.baselineAnnualizedEbitdaTry)
      : totalBaseInDec.minus(totalBaseOutDec).times(4);
  const projectedEbitdaDec = roundMoney(baseEbitdaDec.plus(annualizedOperatingDeltaDec));

  const fxDebtAnnualShockDec = decimal(input.fxAnnualDebtServiceTry ?? 0).times(fxRatio);
  const baseShockedAnnualDebtDec = decimal(Math.max(0, input.baselineAnnualDebtServiceTry)).plus(
    fxDebtAnnualShockDec,
  );

  // 3) Hafta-hafta kasa zinciri, otomatik BCH çekimi, 780 faiz+BSMV+KKDF ve DSCR / kovenant testi
  const hasKnownOpening = input.openingCashTry !== null && Number.isFinite(input.openingCashTry);
  let runningCashDec = hasKnownOpening
    ? roundMoney(decimal(input.openingCashTry!).plus(decimal(input.fxCashBankNetTry).times(fxRatio)))
    : null;

  let remHeadroomDec = roundMoney(decimal(Math.max(0, input.availableFacilityHeadroomTry)));
  let cumDrawnDec = decimal(0);
  let totalDrawDec = decimal(0);
  let totalIntTaxDec = decimal(0);

  const weekResults: UnifiedScenarioWeekResult[] = [];
  let minDscrDecFound: ReturnType<typeof decimal> | null = null;
  let covenantBreachCount = 0;

  let baselineFirstNegative: string | null = null;
  let scenarioFirstNegative: string | null = null;
  let worstWeekStart: string | null = null;
  let worstBalanceDec: ReturnType<typeof decimal> | null = null;
  let maxCashGapDec = decimal(0);
  let sawNegativeScenario = false;
  let recoveryWeekStart: string | null = null;

  for (let i = 0; i < weeksCount; i++) {
    const bw = input.baselineWeeks[i];
    const scenInDec = roundMoney(shiftedInflows[i]);
    const scenOutExFinanceDec = roundMoney(shiftedStretchOutflows[i].plus(hardOutflows[i]));

    if (bw.baselineClosingCash != null && bw.baselineClosingCash < 0 && !baselineFirstNegative) {
      baselineFirstNegative = bw.weekStart;
    }

    let autoDrawDec = decimal(0);
    let incIntTaxDec = decimal(0);
    let scenClosingDec: ReturnType<typeof decimal> | null = null;

    if (runningCashDec !== null) {
      const existingIntTaxDec = roundMoney(cumDrawnDec.times(weeklyFinanceRateDec));
      const preDrawCashDec = runningCashDec
        .plus(scenInDec)
        .minus(scenOutExFinanceDec)
        .minus(existingIntTaxDec);

      if (p.autoDrawFacility && preDrawCashDec.lt(minBufferDec) && remHeadroomDec.gt(0)) {
        const deficitToBufferDec = minBufferDec.minus(preDrawCashDec);
        const netDrawFactor = decimal(1).minus(weeklyFinanceRateDec);
        const rawNeededDec = netDrawFactor.gt(decimal("0.01"))
          ? deficitToBufferDec.div(netDrawFactor)
          : deficitToBufferDec;
        const cappedDrawDec = roundMoney(
          rawNeededDec.gt(remHeadroomDec) ? remHeadroomDec : rawNeededDec,
        );
        if (cappedDrawDec.gt(0)) {
          autoDrawDec = cappedDrawDec;
        }
      }

      const newDrawIntTaxDec = roundMoney(autoDrawDec.times(weeklyFinanceRateDec));
      incIntTaxDec = existingIntTaxDec.plus(newDrawIntTaxDec);
      scenClosingDec = roundMoney(preDrawCashDec.plus(autoDrawDec).minus(newDrawIntTaxDec));

      cumDrawnDec = cumDrawnDec.plus(autoDrawDec);
      remHeadroomDec = roundMoney(remHeadroomDec.minus(autoDrawDec));
      totalDrawDec = totalDrawDec.plus(autoDrawDec);
      totalIntTaxDec = totalIntTaxDec.plus(incIntTaxDec);
      runningCashDec = scenClosingDec;

      if (scenClosingDec.lt(0)) {
        if (!scenarioFirstNegative) scenarioFirstNegative = bw.weekStart;
        sawNegativeScenario = true;
        const absGap = scenClosingDec.abs();
        if (absGap.gt(maxCashGapDec)) maxCashGapDec = absGap;
      } else if (sawNegativeScenario && !recoveryWeekStart) {
        recoveryWeekStart = bw.weekStart;
      }

      if (worstBalanceDec === null || scenClosingDec.lt(worstBalanceDec)) {
        worstBalanceDec = scenClosingDec;
        worstWeekStart = bw.weekStart;
      }
    }

    // Proforma DSCR: Yıllıklandırılmış EBITDA / (Baz Yıllık Borç Servisi + YP Kur Farkı + Çekilen Rotatif Yıllık Faiz+Vergi)
    const annualizedRevolvingServiceDec = cumDrawnDec.times(annualRateDec).times(taxMultiplierDec);
    const effectiveAnnualDebtServiceDec = baseShockedAnnualDebtDec.plus(annualizedRevolvingServiceDec);
    let projectedDscr: number | null = null;
    let dscrBreach = false;
    if (effectiveAnnualDebtServiceDec.gt(0)) {
      const dscrDec = projectedEbitdaDec.div(effectiveAnnualDebtServiceDec);
      projectedDscr = Number(dscrDec.toFixed(4));
      if (minDscrDecFound === null || dscrDec.lt(minDscrDecFound)) {
        minDscrDecFound = dscrDec;
      }
      if (dscrDec.lt(minDscrDec)) {
        dscrBreach = true;
      }
    }

    const cashBufferBreach = scenClosingDec !== null && scenClosingDec.lt(minBufferDec);
    const cashCovenantBreach =
      minCashCovDec !== null && scenClosingDec !== null && scenClosingDec.lt(minCashCovDec);
    const covenantBreach = dscrBreach || cashBufferBreach || cashCovenantBreach;
    if (covenantBreach) covenantBreachCount += 1;

    weekResults.push({
      weekIndex: bw.weekIndex,
      weekStart: bw.weekStart,
      baselineInflow: money(bw.baselineInflow),
      baselineOutflow: money(bw.baselineOutflow),
      baselineClosingCash: bw.baselineClosingCash != null ? money(bw.baselineClosingCash) : null,
      scenarioInflow: money(scenInDec),
      scenarioOutflow: money(scenOutExFinanceDec),
      autoFacilityDraw: money(autoDrawDec),
      incrementalInterestTax: money(incIntTaxDec),
      scenarioClosingCash: scenClosingDec != null ? money(scenClosingDec) : null,
      remainingFacilityHeadroom: money(remHeadroomDec),
      projectedDscr,
      covenantBreach,
    });
  }

  const lastWeek = weekResults[weekResults.length - 1] ?? null;
  const baselineFinalCash = lastWeek?.baselineClosingCash ?? null;
  const scenarioFinalCash = lastWeek?.scenarioClosingCash ?? null;
  const finalDelta =
    baselineFinalCash != null && scenarioFinalCash != null
      ? money(decimal(scenarioFinalCash).minus(decimal(baselineFinalCash)))
      : null;

  const totalAutoFacilityDraw = money(totalDrawDec);
  const totalIncrementalInterestTax = money(totalIntTaxDec);
  const deferredReceivablesCarryover = money(deferredReceivablesDec);
  const deferredPayablesCarryover = money(deferredPayablesDec);
  const projectedEbitdaTry = hasKnownOpening ? money(projectedEbitdaDec) : money(projectedEbitdaDec);
  const projectedMinDscr = minDscrDecFound != null ? Number(minDscrDecFound.toFixed(4)) : null;

  const insights: string[] = [];
  if (finalDelta != null) {
    insights.push(
      `13. hafta kapanış kasası baz tahmine göre ${finalDelta >= 0 ? "+" : ""}${fmtTlPlain(finalDelta)} TL değişiyor (Baz: ${fmtTlPlain(baselineFinalCash ?? 0)} TL → Senaryo: ${fmtTlPlain(scenarioFinalCash ?? 0)} TL).`,
    );
  }
  if (deferredReceivablesCarryover > 0) {
    insights.push(
      `Tahsilat gecikmesi (${p.collectionDelayDays} gün) nedeniyle ${fmtTlPlain(deferredReceivablesCarryover)} TL tutarında alacak silinmedi; 13. hafta sonrasına devreden alacak (carryover) olarak korundu.`,
    );
  }
  if (totalAutoFacilityDraw > 0) {
    insights.push(
      `Asgari kasa tamponunu (${fmtTlPlain(p.minCashBufferTry)} TL) korumak için toplam ${fmtTlPlain(totalAutoFacilityDraw)} TL otomatik rotatif kredi çekildi; 780 faiz + BSMV + KKDF ek maliyeti ${fmtTlPlain(totalIncrementalInterestTax)} TL oldu.`,
    );
  }
  if (covenantBreachCount > 0) {
    insights.push(
      `13 haftalık ufukta ${covenantBreachCount} haftada kasa tamponu veya DSCR kovenant eşiği ihlal edildi${projectedMinDscr != null ? ` (En düşük proforma DSCR: ${projectedMinDscr.toFixed(2)}x)` : ""}.`,
    );
  } else if (weeksCount > 0 && hasKnownOpening) {
    insights.push("13 haftalık ufuk boyunca kasa tamponu ve DSCR kovenant eşikleri korunuyor.");
  }

  const confidence: "high" | "medium" | "low" = !hasKnownOpening
    ? "low"
    : weeksCount >= 13
      ? "high"
      : "medium";

  return {
    weeks: weekResults,
    baselineFinalCash,
    scenarioFinalCash,
    finalDelta,
    baselineFirstNegative,
    scenarioFirstNegative,
    worstWeekStart,
    worstBalance: worstBalanceDec != null ? money(worstBalanceDec) : null,
    maxCashGap: money(maxCashGapDec),
    recoveryWeekStart,
    totalAutoFacilityDraw,
    totalIncrementalInterestTax,
    deferredReceivablesCarryover,
    deferredPayablesCarryover,
    projectedEbitdaTry,
    projectedMinDscr,
    covenantBreachCount,
    confidence,
    insights,
  };
}

/* ── DB Entegrasyonu (`runUnifiedDynamicScenario`, `loadScenarioComparisonMatrix`) ── */

function weekIndexForDate(anchorWeekStart: string, dueDateIso: string, maxWeeks = 13): number | null {
  const anchorMs = Date.parse(`${anchorWeekStart}T00:00:00Z`);
  const dueMs = Date.parse(`${dueDateIso}T00:00:00Z`);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(dueMs)) return null;
  const diffDays = Math.floor((dueMs - anchorMs) / 86_400_000);
  if (diffDays < 0) return 0;
  const idx = Math.floor(diffDays / 7);
  return idx < maxWeeks ? idx : null;
}

export async function runUnifiedDynamicScenario(
  pool: Pool,
  rawInput: unknown,
  actorId: string,
): Promise<{
  scenarioId: string;
  runId: string;
  simulation: UnifiedScenarioSimulationResult;
}> {
  const parsed = parseOrThrow(unifiedScenarioRunSchema, rawInput, "Birleşik dinamik senaryo");
  const today = istanbulDateISO();

  const [forecast13w, bomSummaries, approvedExternal, fxExpRes, fxFlowsRes, facRes, floorRes, covRes] =
    await Promise.all([
      buildAutoSeeded13WeekForecast(pool, { currency: "TRY", asOfDate: today }),
      loadBomSummaries(pool).catch(() => ({ boms: [], byPartId: {} })),
      parsed.useExternalAssumptions ? loadApprovedExternalAssumptions(pool).catch(() => []) : Promise.resolve([]),
      pool
        .query<{
          currency: string;
          cash_bank_native: string | null;
          spot_rate_to_try: string | null;
        }>(
          `select currency, cash_bank_native::text, spot_rate_to_try::text
             from public.live_fx_exposure_v`,
        )
        .catch(() => ({ rows: [] })),
      pool
        .query<{
          due_date: string;
          flow_kind: "ar" | "ap" | "loan";
          try_amount: string;
        }>(
          `with latest_fx as (
             select distinct on (base_currency) base_currency, rate
               from public.fx_rate_snapshots
              where quote_currency = 'TRY' and rate > 0
              order by base_currency, rate_date desc, fetched_at desc
           )
           select to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                  case when v.direction = 'sales' then 'ar' else 'ap' end as flow_kind,
                  ((v.gross_amount - coalesce(v.allocated_amount, 0)) * fx.rate)::numeric(14,2)::text as try_amount
             from public.invoices v
             join latest_fx fx on fx.base_currency = v.currency
            where v.currency <> 'TRY'
              and v.status in ('open', 'partial')
              and v.bad_debt_at is null
              and v.due_date >= $1::date
              and v.due_date <= ($1::date + interval '91 days')
              and v.gross_amount > coalesce(v.allocated_amount, 0)
           union all
           select to_char(li.due_date, 'YYYY-MM-DD') as due_date,
                  'loan' as flow_kind,
                  (greatest(0, li.amount - coalesce(li.paid_amount, 0)) * fx.rate)::numeric(14,2)::text as try_amount
             from public.loan_installments li
             join public.loans l on l.id = li.loan_id
             join latest_fx fx on fx.base_currency = l.currency
            where l.currency <> 'TRY'
              and l.archived_at is null
              and li.status in ('planned', 'unpaid', 'partial', 'late')
              and li.due_date >= $1::date
              and li.due_date <= ($1::date + interval '365 days')`,
          [today],
        )
        .catch(() => ({ rows: [] })),
      pool
        .query<{
          available_try: string | null;
          weighted_rate: string | null;
        }>(
          `select
             coalesce(sum(greatest(limit_amount - coalesce(drawn_amount, 0), 0)), 0)::numeric(14,2)::text as available_try,
             case
               when sum(greatest(limit_amount - coalesce(drawn_amount, 0), 0)) filter (where interest_rate is not null) > 0
               then (
                 sum(greatest(limit_amount - coalesce(drawn_amount, 0), 0) * interest_rate) filter (where interest_rate is not null)
                 / sum(greatest(limit_amount - coalesce(drawn_amount, 0), 0)) filter (where interest_rate is not null)
               )::numeric(10,6)::text
               else null
             end as weighted_rate
           from public.credit_facilities
           where archived_at is null
             and status = 'active'
             and currency = 'TRY'`,
        )
        .catch(() => ({ rows: [{ available_try: "0", weighted_rate: null }] })),
      pool
        .query<{ min_buffer: string | null }>(
          `select coalesce(
             (select min_cash_buffer_try::text from public.treasury_policies where is_active = true limit 1),
             (select threshold_amount::text from public.approval_rules where trigger_kind = 'cash_floor_breach' and is_active = true order by threshold_amount desc nulls last limit 1),
             '0'
           ) as min_buffer`,
        )
        .catch(() => ({ rows: [{ min_buffer: "0" }] })),
      pool
        .query<{ covenant_type: string; threshold_value: string }>(
          `select covenant_type, threshold_value::text
             from public.loan_covenants
            where is_active = true`,
        )
        .catch(() => ({ rows: [] })),
    ]);

  // Dış varsayımlardan boş bırakılan alanları tamamla
  let resolvedExpenseDeltaPct = parsed.expenseDeltaPct;
  let externalRateFallback: number | null = null;
  for (const ext of approvedExternal) {
    const val = ext.value_numeric;
    const asPct = ext.unit === "%" || Math.abs(val) > 1 ? val : val * 100;
    if (resolvedExpenseDeltaPct === undefined && (ext.assumption_type === "inflation_rate" || ext.assumption_type === "energy_cost")) {
      // Yıllık enflasyonun 13 haftalık (çeyreklik) maliyet yansıması
      resolvedExpenseDeltaPct = Number(decimal(asPct).div(4).toFixed(2));
    }
    if (externalRateFallback === null && (ext.assumption_type === "loan_rate" || ext.assumption_type === "interest_rate")) {
      externalRateFallback = Math.abs(val) > 1 ? val / 100 : val;
    }
  }

  let fxCashBankNetDec = decimal(0);
  for (const r of fxExpRes.rows) {
    const cb = rateOrNull(r.cash_bank_native);
    const spot = rateOrNull(r.spot_rate_to_try);
    if (cb != null && spot != null && spot > 0) {
      fxCashBankNetDec = fxCashBankNetDec.plus(decimal(cb).times(decimal(spot)));
    }
  }

  // Haftalık BOM YP hammadde alım tabanı: `fxSensitivePerUnitTry * batchSize` aylık etki olarak haftalığa bölünür
  let weeklyBomFxBaseTryDec = decimal(0);
  for (const b of bomSummaries.boms) {
    if (b.fxSensitivePerUnitTry > 0) {
      weeklyBomFxBaseTryDec = weeklyBomFxBaseTryDec.plus(
        decimal(b.fxSensitivePerUnitTry).times(Math.max(1, b.batchSize)).div(decimal("4.3333")),
      );
    }
  }
  const weeklyBomFxBaseTry = money(weeklyBomFxBaseTryDec);

  const anchorWeekStart = forecast13w.weeks[0]?.weekStart ?? today;
  const fxArByWeek = new Array<number>(13).fill(0);
  const fxApByWeek = new Array<number>(13).fill(0);
  const fxLoanByWeek = new Array<number>(13).fill(0);
  let fxAnnualDebtServiceDec = decimal(0);

  for (const f of fxFlowsRes.rows) {
    const amt = moneyOrNull(f.try_amount) ?? 0;
    if (amt <= 0) continue;
    if (f.flow_kind === "loan") {
      fxAnnualDebtServiceDec = fxAnnualDebtServiceDec.plus(decimal(amt));
    }
    const wIdx = weekIndexForDate(anchorWeekStart, f.due_date, 13);
    if (wIdx !== null && wIdx >= 0 && wIdx < 13) {
      if (f.flow_kind === "ar") fxArByWeek[wIdx] = money(decimal(fxArByWeek[wIdx]).plus(decimal(amt)));
      else if (f.flow_kind === "ap") fxApByWeek[wIdx] = money(decimal(fxApByWeek[wIdx]).plus(decimal(amt)));
      else fxLoanByWeek[wIdx] = money(decimal(fxLoanByWeek[wIdx]).plus(decimal(amt)));
    }
  }

  const baselineWeeks: UnifiedBaselineWeekInput[] = forecast13w.weeks.map((w, idx) => {
    const hardOut = money(
      decimal(w.outflowByCategory.loan_installment ?? 0).plus(
        decimal(w.outflowByCategory.statutory_tax_sgk ?? 0),
      ),
    );
    return {
      weekIndex: w.weekIndex,
      weekStart: w.weekStart,
      baselineInflow: w.inflow,
      baselineOutflow: w.outflow,
      hardOutflow: hardOut,
      baselineClosingCash: w.closingBalance,
      fxReceivableInflowTry: fxArByWeek[idx] ?? 0,
      fxPayableOutflowTry: fxApByWeek[idx] ?? 0,
      fxLoanOutflowTry: fxLoanByWeek[idx] ?? 0,
      bomFxOutflowTry: weeklyBomFxBaseTry,
    };
  });

  const baseline13wLoanOutflowDec = forecast13w.weeks.reduce(
    (acc, w) => acc.plus(decimal(w.outflowByCategory.loan_installment ?? 0)),
    decimal(0),
  );
  const baselineAnnualDebtServiceTry = money(
    baseline13wLoanOutflowDec.times(4).plus(fxAnnualDebtServiceDec),
  );

  const rawWeightedRate = rateOrNull(facRes.rows[0]?.weighted_rate);
  const normalizedFacilityRate =
    rawWeightedRate != null
      ? rawWeightedRate > 1
        ? rawWeightedRate / 100
        : rawWeightedRate
      : externalRateFallback ?? 0.48;

  const defaultBufferTry =
    moneyOrNull(floorRes.rows[0]?.min_buffer) ?? forecast13w.minCashFloor ?? 0;
  const effectiveMinBufferTry =
    parsed.minCashBufferTry !== undefined ? parsed.minCashBufferTry : defaultBufferTry;

  let minDscrThreshold = 1.2;
  let minCashCovenantTry: number | null = null;
  for (const cov of covRes.rows) {
    const tv = rateOrNull(cov.threshold_value);
    if (tv == null) continue;
    if (cov.covenant_type === "min_dscr") minDscrThreshold = tv;
    if (cov.covenant_type === "min_cash") minCashCovenantTry = tv;
  }

  const params: UnifiedScenarioParams = {
    fxShockPct: parsed.fxShockPct,
    collectionDelayDays: parsed.collectionDelayDays,
    paymentDelayDays: parsed.paymentDelayDays,
    revenueDeltaPct: parsed.revenueDeltaPct,
    passThroughPct: parsed.passThroughPct,
    expenseDeltaPct: resolvedExpenseDeltaPct ?? 0,
    minCashBufferTry: effectiveMinBufferTry,
    autoDrawFacility: parsed.autoDrawFacility,
  };

  const simulation = simulateUnified13WeekScenario({
    baselineWeeks,
    openingCashTry: forecast13w.openingCash,
    fxCashBankNetTry: money(fxCashBankNetDec),
    availableFacilityHeadroomTry: moneyOrNull(facRes.rows[0]?.available_try) ?? 0,
    weightedFacilityAnnualRate: normalizedFacilityRate,
    bsmvRate: 0.05,
    kkdfRate: 0,
    baselineAnnualizedEbitdaTry: null,
    baselineAnnualDebtServiceTry,
    fxAnnualDebtServiceTry: money(fxAnnualDebtServiceDec),
    minDscrThreshold,
    minCashCovenantTry,
    params,
  });

  // Atomik kayıt: `scenarios` + `scenario_runs` + `scenario_run_weeks` (13 satır) + `scenario_run_lines` (aylık özet) + `scenario_assumptions` + `scenario_comparisons` + `audit`
  const client = await pool.connect();
  try {
    await client.query("begin");

    const scenIns = await client.query<{ id: string }>(
      `insert into public.scenarios
         (name, description, scenario_type, baseline_label, baseline_month_count, created_by)
       values ($1, $2, 'combined_custom_scenario', $3, 3, $4)
       returning id::text`,
      [
        parsed.name,
        parsed.description ?? "13 Haftalık Birleşik Dinamik Stres & Likidite Simülasyonu",
        `13H Canlı Nakit + YP + BOM (${anchorWeekStart}..${forecast13w.horizonEnd})`,
        actorId,
      ],
    );
    if (scenIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Senaryo başlığı kaydedilemedi.");
    }
    const scenarioId = scenIns.rows[0].id;

    const assumptionsJson = {
      engine: "unified_13w",
      ...params,
      weightedFacilityAnnualRate: normalizedFacilityRate,
      minDscrThreshold,
    };

    const runIns = await client.query<{ id: string }>(
      `insert into public.scenario_runs (
         scenario_id, assumptions,
         baseline_final_cash, scenario_final_cash, final_delta,
         baseline_first_negative, scenario_first_negative,
         worst_month, worst_balance, max_cash_gap, recovery_month,
         month_count, null_month_count, confidence, notes,
         total_auto_facility_draw, total_incremental_interest_tax,
         deferred_receivables_carryover, projected_ebitda_try,
         projected_min_dscr, covenant_breach_count
       ) values (
         $1, $2::jsonb,
         $3, $4, $5,
         $6::date, $7::date,
         $8::date, $9, $10, $11::date,
         $12, $13, $14, $15,
         $16, $17,
         $18, $19,
         $20, $21
       ) returning id::text`,
      [
        scenarioId,
        JSON.stringify(assumptionsJson),
        simulation.baselineFinalCash,
        simulation.scenarioFinalCash,
        simulation.finalDelta,
        simulation.baselineFirstNegative,
        simulation.scenarioFirstNegative,
        simulation.worstWeekStart,
        simulation.worstBalance,
        simulation.maxCashGap,
        simulation.recoveryWeekStart,
        simulation.weeks.length,
        forecast13w.openingCash === null ? simulation.weeks.length : 0,
        simulation.confidence,
        simulation.insights.join(" "),
        simulation.totalAutoFacilityDraw,
        simulation.totalIncrementalInterestTax,
        simulation.deferredReceivablesCarryover,
        simulation.projectedEbitdaTry,
        simulation.projectedMinDscr,
        simulation.covenantBreachCount,
      ],
    );
    if (runIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Birleşik senaryo çalıştırması kaydedilemedi.");
    }
    const runId = runIns.rows[0].id;

    for (const w of simulation.weeks) {
      const wIns = await client.query(
        `insert into public.scenario_run_weeks (
           run_id, week_index, week_start,
           baseline_inflow, baseline_outflow, baseline_closing_cash,
           scenario_inflow, scenario_outflow,
           auto_facility_draw, incremental_interest_tax,
           scenario_closing_cash, remaining_facility_headroom,
           projected_dscr, covenant_breach
         ) values ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          runId,
          w.weekIndex,
          w.weekStart,
          w.baselineInflow,
          w.baselineOutflow,
          w.baselineClosingCash,
          w.scenarioInflow,
          w.scenarioOutflow,
          w.autoFacilityDraw,
          w.incrementalInterestTax,
          w.scenarioClosingCash,
          w.remainingFacilityHeadroom,
          w.projectedDscr,
          w.covenantBreach,
        ],
      );
      if (wIns.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Haftalık senaryo satırı kaydedilemedi.");
      }
    }

    // Aylık özet uyumluluğu: `scenario_run_lines` içine ay bazında gruplanmış satırlar yazılır
    // (böylece hem 13 haftalık eğri hem klasik aylık grafik bileşeni sorunsuz çalışır)
    const monthBuckets = new Map<
      string,
      {
        baseInc: ReturnType<typeof decimal>;
        scenInc: ReturnType<typeof decimal>;
        baseExp: ReturnType<typeof decimal>;
        scenExp: ReturnType<typeof decimal>;
        baseClose: number | null;
        scenClose: number | null;
      }
    >();
    for (const w of simulation.weeks) {
      const mStart = `${w.weekStart.slice(0, 7)}-01`;
      const cur = monthBuckets.get(mStart) ?? {
        baseInc: decimal(0),
        scenInc: decimal(0),
        baseExp: decimal(0),
        scenExp: decimal(0),
        baseClose: null,
        scenClose: null,
      };
      cur.baseInc = cur.baseInc.plus(decimal(w.baselineInflow));
      cur.scenInc = cur.scenInc.plus(decimal(w.scenarioInflow));
      cur.baseExp = cur.baseExp.plus(decimal(w.baselineOutflow));
      cur.scenExp = cur.scenExp
        .plus(decimal(w.scenarioOutflow))
        .plus(decimal(w.incrementalInterestTax));
      cur.baseClose = w.baselineClosingCash;
      cur.scenClose = w.scenarioClosingCash;
      monthBuckets.set(mStart, cur);
    }

    for (const [monthStart, mb] of monthBuckets.entries()) {
      const deltaClose =
        mb.baseClose != null && mb.scenClose != null
          ? money(decimal(mb.scenClose).minus(decimal(mb.baseClose)))
          : null;
      await client.query(
        `insert into public.scenario_run_lines (
           run_id, month_start,
           baseline_income, scenario_income,
           baseline_expense, scenario_expense,
           baseline_closing, scenario_closing, delta
         ) values ($1,$2::date,$3,$4,$5,$6,$7,$8,$9)`,
        [
          runId,
          monthStart,
          money(mb.baseInc),
          money(mb.scenInc),
          money(mb.baseExp),
          money(mb.scenExp),
          mb.baseClose,
          mb.scenClose,
          deltaClose,
        ],
      );
    }

    const disclosedRows: Array<{ key: string; val: number; unit: string; desc: string }> = [
      { key: "fxShockPct", val: params.fxShockPct / 100, unit: "oran", desc: "TCMB Döviz Kur Şoku" },
      { key: "collectionDelayDays", val: params.collectionDelayDays, unit: "gün", desc: "Müşteri Tahsilat Gecikmesi (DSO)" },
      { key: "paymentDelayDays", val: params.paymentDelayDays, unit: "gün", desc: "Tedarikçi Ödeme Ertelemesi (DPO)" },
      { key: "revenueDeltaPct", val: params.revenueDeltaPct / 100, unit: "oran", desc: "Satış Hacim Değişimi" },
      { key: "passThroughPct", val: params.passThroughPct / 100, unit: "oran", desc: "Maliyet Artışı Fiyat Geçişkenliği" },
      { key: "minCashBufferTry", val: params.minCashBufferTry, unit: "TRY", desc: "Asgari Kasa Tamponu (Otomatik BCH Eşiği)" },
    ];
    for (const a of disclosedRows) {
      if (a.val === 0 && a.key !== "minCashBufferTry") continue;
      await client.query(
        `insert into public.scenario_assumptions (run_id, key, value_numeric, unit, description)
         values ($1, $2, $3, $4, $5)`,
        [runId, a.key, a.val, a.unit, a.desc],
      );
    }

    const comparisonMetrics: Array<[string, number | null, number | null, number | null]> = [
      ["final_cash", simulation.baselineFinalCash, simulation.scenarioFinalCash, simulation.finalDelta],
      ["worst_balance", null, simulation.worstBalance, null],
      ["max_cash_gap", 0, simulation.maxCashGap, simulation.maxCashGap],
      ["auto_facility_draw", 0, simulation.totalAutoFacilityDraw, simulation.totalAutoFacilityDraw],
      ["incremental_interest_tax", 0, simulation.totalIncrementalInterestTax, simulation.totalIncrementalInterestTax],
      ["deferred_receivables_carryover", 0, simulation.deferredReceivablesCarryover, simulation.deferredReceivablesCarryover],
    ];
    for (const [metric, baseVal, scenVal, deltaVal] of comparisonMetrics) {
      await client.query(
        `insert into public.scenario_comparisons (run_id, metric, baseline_value, scenario_value, delta)
         values ($1, $2, $3, $4, $5)`,
        [runId, metric, baseVal, scenVal, deltaVal],
      );
    }

    await audit(client, {
      actor: actorId,
      action: "run_unified_dynamic_scenario",
      entityTable: "scenario_runs",
      entityId: runId,
      after: {
        scenarioId,
        name: parsed.name,
        params,
        finalDelta: simulation.finalDelta,
        totalAutoFacilityDraw: simulation.totalAutoFacilityDraw,
        deferredReceivablesCarryover: simulation.deferredReceivablesCarryover,
        covenantBreachCount: simulation.covenantBreachCount,
      },
    });

    await client.query("commit");
    return { scenarioId, runId, simulation };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function loadUnifiedScenarioWeeks(
  pool: Pool,
  runId: string,
): Promise<UnifiedScenarioWeekResult[]> {
  const res = await pool
    .query<{
      week_index: number;
      week_start: string;
      baseline_inflow: string;
      baseline_outflow: string;
      baseline_closing_cash: string | null;
      scenario_inflow: string;
      scenario_outflow: string;
      auto_facility_draw: string;
      incremental_interest_tax: string;
      scenario_closing_cash: string | null;
      remaining_facility_headroom: string | null;
      projected_dscr: string | null;
      covenant_breach: boolean;
    }>(
      `select
         week_index,
         to_char(week_start, 'YYYY-MM-DD') as week_start,
         baseline_inflow::text,
         baseline_outflow::text,
         baseline_closing_cash::text,
         scenario_inflow::text,
         scenario_outflow::text,
         auto_facility_draw::text,
         incremental_interest_tax::text,
         scenario_closing_cash::text,
         remaining_facility_headroom::text,
         projected_dscr::text,
         covenant_breach
       from public.scenario_run_weeks
       where run_id = $1
       order by week_index asc`,
      [runId],
    )
    .catch(() => ({ rows: [] }));

  return res.rows.map((r) => ({
    weekIndex: intOrNull(r.week_index) ?? 1,
    weekStart: r.week_start,
    baselineInflow: moneyOrNull(r.baseline_inflow) ?? 0,
    baselineOutflow: moneyOrNull(r.baseline_outflow) ?? 0,
    baselineClosingCash: moneyOrNull(r.baseline_closing_cash),
    scenarioInflow: moneyOrNull(r.scenario_inflow) ?? 0,
    scenarioOutflow: moneyOrNull(r.scenario_outflow) ?? 0,
    autoFacilityDraw: moneyOrNull(r.auto_facility_draw) ?? 0,
    incrementalInterestTax: moneyOrNull(r.incremental_interest_tax) ?? 0,
    scenarioClosingCash: moneyOrNull(r.scenario_closing_cash),
    remainingFacilityHeadroom: moneyOrNull(r.remaining_facility_headroom) ?? 0,
    projectedDscr: rateOrNull(r.projected_dscr),
    covenantBreach: Boolean(r.covenant_breach),
  }));
}

export interface ScenarioComparisonColumn {
  runId: string;
  scenarioId: string;
  name: string;
  scenarioType: string;
  isUnified13w: boolean;
  runAt: string;
  confidence: string;
  baselineFinalCash: number | null;
  scenarioFinalCash: number | null;
  finalDelta: number | null;
  worstBalance: number | null;
  maxCashGap: number | null;
  firstNegative: string | null;
  recoveryDate: string | null;
  totalAutoFacilityDraw: number | null;
  totalIncrementalInterestTax: number | null;
  deferredReceivablesCarryover: number | null;
  projectedEbitdaTry: number | null;
  projectedMinDscr: number | null;
  covenantBreachCount: number;
  weeks: UnifiedScenarioWeekResult[];
  monthlyLines: Array<{
    monthStart: string;
    baselineClosing: number | null;
    scenarioClosing: number | null;
  }>;
}

export interface ScenarioComparisonMatrixResult {
  runs: ScenarioComparisonColumn[];
  viewMetrics: Array<{
    runId: string;
    metric: string;
    baselineValue: number | null;
    scenarioValue: number | null;
    delta: number | null;
    deltaRatio: number | null;
    magnitudeRank: number | null;
  }>;
}

/**
 * `M-52`: 2–4 senaryolu canlı karşılaştırma matrisi (`scenario_comparison_matrix` view + `scenario_runs` + `scenario_run_weeks`).
 */
export async function loadScenarioComparisonMatrix(
  pool: Pool,
  runIds: string[],
): Promise<ScenarioComparisonMatrixResult> {
  const cleanIds = Array.from(new Set(runIds.map((id) => id.trim()).filter(Boolean))).slice(0, 4);
  if (cleanIds.length === 0) {
    return { runs: [], viewMetrics: [] };
  }

  const [runsRes, weeksRes, linesRes, matrixViewRes] = await Promise.all([
    pool.query<{
      id: string;
      scenario_id: string;
      name: string;
      scenario_type: string;
      assumptions: Record<string, unknown> | null;
      run_at: string;
      confidence: string;
      baseline_final_cash: string | null;
      scenario_final_cash: string | null;
      final_delta: string | null;
      worst_balance: string | null;
      max_cash_gap: string | null;
      scen_first_neg: string | null;
      recovery_month: string | null;
      total_auto_facility_draw: string | null;
      total_incremental_interest_tax: string | null;
      deferred_receivables_carryover: string | null;
      projected_ebitda_try: string | null;
      projected_min_dscr: string | null;
      covenant_breach_count: number | null;
    }>(
      `select
         r.id::text,
         r.scenario_id::text,
         s.name,
         s.scenario_type,
         r.assumptions,
         to_char(r.run_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as run_at,
         r.confidence,
         r.baseline_final_cash::text,
         r.scenario_final_cash::text,
         r.final_delta::text,
         r.worst_balance::text,
         r.max_cash_gap::text,
         to_char(r.scenario_first_negative, 'YYYY-MM-DD') as scen_first_neg,
         to_char(r.recovery_month, 'YYYY-MM-DD') as recovery_month,
         r.total_auto_facility_draw::text,
         r.total_incremental_interest_tax::text,
         r.deferred_receivables_carryover::text,
         r.projected_ebitda_try::text,
         r.projected_min_dscr::text,
         coalesce(r.covenant_breach_count, 0) as covenant_breach_count
       from public.scenario_runs r
       join public.scenarios s on s.id = r.scenario_id
       where r.id = any($1::uuid[])
         and r.archived_at is null`,
      [cleanIds],
    ),
    pool
      .query<{
        run_id: string;
        week_index: number;
        week_start: string;
        baseline_inflow: string;
        baseline_outflow: string;
        baseline_closing_cash: string | null;
        scenario_inflow: string;
        scenario_outflow: string;
        auto_facility_draw: string;
        incremental_interest_tax: string;
        scenario_closing_cash: string | null;
        remaining_facility_headroom: string | null;
        projected_dscr: string | null;
        covenant_breach: boolean;
      }>(
        `select
           run_id::text,
           week_index,
           to_char(week_start, 'YYYY-MM-DD') as week_start,
           baseline_inflow::text,
           baseline_outflow::text,
           baseline_closing_cash::text,
           scenario_inflow::text,
           scenario_outflow::text,
           auto_facility_draw::text,
           incremental_interest_tax::text,
           scenario_closing_cash::text,
           remaining_facility_headroom::text,
           projected_dscr::text,
           covenant_breach
         from public.scenario_run_weeks
         where run_id = any($1::uuid[])
         order by run_id, week_index asc`,
        [cleanIds],
      )
      .catch(() => ({ rows: [] })),
    pool.query<{
      run_id: string;
      month_start: string;
      baseline_closing: string | null;
      scenario_closing: string | null;
    }>(
      `select
         run_id::text,
         to_char(month_start, 'YYYY-MM-DD') as month_start,
         baseline_closing::text,
         scenario_closing::text
       from public.scenario_run_lines
       where run_id = any($1::uuid[])
       order by run_id, month_start asc`,
      [cleanIds],
    ),
    pool
      .query<{
        run_id: string;
        metric: string;
        baseline_value: string | null;
        scenario_value: string | null;
        delta: string | null;
        delta_ratio: string | null;
        magnitude_rank: string | null;
      }>(
        `select
           run_id::text,
           metric,
           baseline_value::text,
           scenario_value::text,
           delta::text,
           delta_ratio::text,
           magnitude_rank::text
         from public.scenario_comparison_matrix
         where run_id = any($1::uuid[])`,
        [cleanIds],
      )
      .catch(() => ({ rows: [] })),
  ]);

  const weeksByRun = new Map<string, UnifiedScenarioWeekResult[]>();
  for (const w of weeksRes.rows) {
    const arr = weeksByRun.get(w.run_id) ?? [];
    arr.push({
      weekIndex: intOrNull(w.week_index) ?? 1,
      weekStart: w.week_start,
      baselineInflow: moneyOrNull(w.baseline_inflow) ?? 0,
      baselineOutflow: moneyOrNull(w.baseline_outflow) ?? 0,
      baselineClosingCash: moneyOrNull(w.baseline_closing_cash),
      scenarioInflow: moneyOrNull(w.scenario_inflow) ?? 0,
      scenarioOutflow: moneyOrNull(w.scenario_outflow) ?? 0,
      autoFacilityDraw: moneyOrNull(w.auto_facility_draw) ?? 0,
      incrementalInterestTax: moneyOrNull(w.incremental_interest_tax) ?? 0,
      scenarioClosingCash: moneyOrNull(w.scenario_closing_cash),
      remainingFacilityHeadroom: moneyOrNull(w.remaining_facility_headroom) ?? 0,
      projectedDscr: rateOrNull(w.projected_dscr),
      covenantBreach: Boolean(w.covenant_breach),
    });
    weeksByRun.set(w.run_id, arr);
  }

  const linesByRun = new Map<
    string,
    Array<{ monthStart: string; baselineClosing: number | null; scenarioClosing: number | null }>
  >();
  for (const l of linesRes.rows) {
    const arr = linesByRun.get(l.run_id) ?? [];
    arr.push({
      monthStart: l.month_start,
      baselineClosing: moneyOrNull(l.baseline_closing),
      scenarioClosing: moneyOrNull(l.scenario_closing),
    });
    linesByRun.set(l.run_id, arr);
  }

  // Seçim sırasını (`cleanIds`) koru
  const rowMap = new Map(runsRes.rows.map((r) => [r.id, r]));
  const runs: ScenarioComparisonColumn[] = [];
  for (const id of cleanIds) {
    const r = rowMap.get(id);
    if (!r) continue;
    const weeks = weeksByRun.get(id) ?? [];
    const isUnified13w =
      weeks.length > 0 || (r.assumptions as { engine?: string } | null)?.engine === "unified_13w";
    runs.push({
      runId: r.id,
      scenarioId: r.scenario_id,
      name: r.name,
      scenarioType: r.scenario_type,
      isUnified13w,
      runAt: r.run_at,
      confidence: r.confidence,
      baselineFinalCash: moneyOrNull(r.baseline_final_cash),
      scenarioFinalCash: moneyOrNull(r.scenario_final_cash),
      finalDelta: moneyOrNull(r.final_delta),
      worstBalance: moneyOrNull(r.worst_balance),
      maxCashGap: moneyOrNull(r.max_cash_gap),
      firstNegative: r.scen_first_neg,
      recoveryDate: r.recovery_month,
      totalAutoFacilityDraw: moneyOrNull(r.total_auto_facility_draw),
      totalIncrementalInterestTax: moneyOrNull(r.total_incremental_interest_tax),
      deferredReceivablesCarryover: moneyOrNull(r.deferred_receivables_carryover),
      projectedEbitdaTry: moneyOrNull(r.projected_ebitda_try),
      projectedMinDscr: rateOrNull(r.projected_min_dscr),
      covenantBreachCount: intOrNull(r.covenant_breach_count) ?? 0,
      weeks,
      monthlyLines: linesByRun.get(id) ?? [],
    });
  }

  return {
    runs,
    viewMetrics: matrixViewRes.rows.map((m) => ({
      runId: m.run_id,
      metric: m.metric,
      baselineValue: moneyOrNull(m.baseline_value),
      scenarioValue: moneyOrNull(m.scenario_value),
      delta: moneyOrNull(m.delta),
      deltaRatio: rateOrNull(m.delta_ratio),
      magnitudeRank: intOrNull(m.magnitude_rank),
    })),
  };
}
