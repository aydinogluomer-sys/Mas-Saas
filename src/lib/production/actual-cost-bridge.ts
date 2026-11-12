// Faz 54 / v6 — TDHP 7xx Yönetim Defteri Fiili Gider ↔ Üretim Tezgâh Dakika (TL/dk) Köprüsü.
//
// Kurallar:
//   * BLANK ≠ ZERO: Yönetim defterinde (management_journal_entries / management_journal_lines)
//     geri bakış penceresinde kesinleşmiş (posted) 7xx kaydı yoksa VEYA etkin tezgâh dakikası
//     null / <= 0 ise ASLA 0,00 TL/dk üretilmez; status = "insufficient_ledger_actuals"
//     (veya "unknown_effective_minutes") ve actualBreakEvenTlPerMin = null döner.
//   * Sıfır IEEE-754 kayması: tüm parasal tutarlar ve TL/dk oranları @/lib/money (big.js)
//     üzerinden hesaplanır, sınırda 2 ondalığa (half-up) yuvarlanır.
//   * Mevcut üretim kurallarıyla (breakEvenTLPerMin, partProfitability, priceMargin) ve
//     yükleyicilerle (loadCostModels, loadCapacityModels, loadPartProfitability) doğrudan
//     birleşir; formül tekrarı yapılmaz.

import type { Pool } from "pg";
import {
  add,
  decimal,
  divOrNull,
  formatMoneyOrNull,
  money,
  moneyOrNull,
  mul,
  rateOrNull,
  sub,
  sumDecimal,
  zero,
  type Decimal,
} from "@/lib/money";
import { loadCapacityModels, loadCostModels, loadPartProfitability } from "./engine";
import {
  breakEvenTLPerMin,
  partProfitability,
  priceMargin,
  type PartInput,
} from "./rules";
import { isMissingSchemaError, sourceRevenue } from "./source-revenue";

export const DEFAULT_ACTUAL_COST_LOOKBACK_MONTHS = 3;
export const MAX_HIDDEN_EROSION_PARTS = 10;

export type ActualCostBridgeStatus =
  | "ready"
  | "insufficient_ledger_actuals"
  | "unknown_effective_minutes";

export interface MonthlyLedger7xxRow {
  /** YYYY-MM-DD (ay başı, örn. "2026-03-01") veya YYYY-MM dönem anahtarı. */
  periodMonth: string;
  /** TDHP 710..749 üretim maliyet hesapları (amortisman hariç, ebitda_bucket = 'cogs'). */
  production710_730Try: number;
  /** TDHP 750..779 faaliyet giderleri (770.99 amortisman hariç, ebitda_bucket = 'opex'). */
  opex760_770ExclDaTry: number;
  /** TDHP 7xx amortisman ve itfa payları (770.99 / 730.99, ebitda_bucket = 'da_addback'). */
  depreciationDaTry: number;
  /** TDHP 780 finansman giderleri (faiz, BSMV, KKDF, banka komisyonu; ayrı raporlanır). */
  financing780Try: number;
  /** Dönemdeki ters kayıt (reversal) dışı aktif kesinleşmiş (posted) 7xx fiş sayısı. */
  postedEntryCount: number;
}

export interface CostModelBridgeInput {
  id: string;
  name: string;
  scenario: string;
  monthlyCost: number | null;
  breakEven: number | null;
  effectiveMinutes: number | null;
  akonFreze: number | null;
  akonTorna: number | null;
  sheetId?: string | null;
  workbookId?: string | null;
}

export interface PartBridgeInput extends PartInput {
  id?: string;
  customerName?: string | null;
}

export interface ComputeActualCostBridgeInput {
  monthlyLedger7xx: MonthlyLedger7xxRow[];
  costModels: CostModelBridgeInput[];
  parts?: PartBridgeInput[];
  lookbackMonths?: number;
  maxErosionParts?: number;
  isStaleCapacityRate?: boolean;
}

export interface CustomerRateBridgeComparison {
  operation: "freze" | "torna";
  label: string;
  priceTlPerMin: number | null;
  bookMarginTlPerMin: number | null;
  bookMarginPct: number | null;
  bookLoss: boolean;
  actualCashMarginTlPerMin: number | null;
  actualCashLoss: boolean;
  actualFullMarginTlPerMin: number | null;
  actualFullMarginPct: number | null;
  actualFullLoss: boolean;
  /**
   * Statik/kitabi başabaşa göre kârlı görünen (`price > bookBreakEven`) ancak fiili 7xx tam
   * başabaş altında zarara dönen (`price < actualFullBreakEven`) gizli marj erimesi sinyali.
   */
  hiddenMarginErosion: boolean;
}

export interface ModelActualCostBridge {
  modelId: string;
  modelName: string;
  scenario: string;
  modelStatus: ActualCostBridgeStatus;
  staticMonthlyCostTry: number | null;
  effectiveMinutes: number | null;
  bookBreakEvenTlPerMin: number | null;
  actualCashBreakEvenTlPerMin: number | null;
  actualFullBreakEvenTlPerMin: number | null;
  /** Tam fiili başabaş (`actualFullBreakEvenTlPerMin` ile özdeş; ölçülemez durumda `null`). */
  actualBreakEvenTlPerMin: number | null;
  /** Bilgi amaçlı ayrı izlenen TDHP 780 finansman yükü (TL/dk). */
  financing780TlPerMin: number | null;
  /** `actualFullBreakEvenTlPerMin - bookBreakEvenTlPerMin` (TL/dk). */
  rateDriftTlPerMin: number | null;
  /** `((actualFull - book) / book) * 100` (yüzde puan, 2 ondalık; `book === 0` veya `null` ise `null`). */
  rateDriftPct: number | null;
  /** `actualCashBreakEvenTlPerMin - bookBreakEvenTlPerMin` (TL/dk). */
  cashRateDriftTlPerMin: number | null;
  akonFrezeComparison: CustomerRateBridgeComparison;
  akonTornaComparison: CustomerRateBridgeComparison;
  customerRates: CustomerRateBridgeComparison[];
  hasHiddenRateErosion: boolean;
}

export interface PartMarginErosionItem {
  partId: string | null;
  partCode: string | null;
  partName: string;
  customerName: string | null;
  quantity: number;
  totalMinutes: number;
  revenueTry: number;
  impliedPriceTlPerMin: number | null;
  bookCostTry: number;
  bookMarginTry: number;
  actualCashCostTry: number | null;
  actualCashMarginTry: number | null;
  actualFullCostTry: number;
  actualFullMarginTry: number;
  /** `actualFullMarginTry - bookMarginTry` (TL). */
  marginDeltaTry: number;
  hiddenMarginErosion: boolean;
}

export interface ActualCostBridgeResult {
  status: ActualCostBridgeStatus;
  lookbackMonths: number;
  includedMonths: MonthlyLedger7xxRow[];
  monthCount: number;
  totalPosted7xxEntries: number;
  avgMonthlyProduction710_730Try: number | null;
  avgMonthlyOpex760_770ExclDaTry: number | null;
  avgMonthlyOperating7xxExclDaTry: number | null;
  avgMonthlyDepreciationDaTry: number | null;
  avgMonthlyFull7xxInclDaTry: number | null;
  avgMonthlyFinancing780Try: number | null;
  primaryScenario: string | null;
  bookBreakEvenTlPerMin: number | null;
  actualCashBreakEvenTlPerMin: number | null;
  actualFullBreakEvenTlPerMin: number | null;
  actualBreakEvenTlPerMin: number | null;
  rateDriftTlPerMin: number | null;
  rateDriftPct: number | null;
  models: ModelActualCostBridge[];
  hiddenErosionRateCount: number;
  evaluatedPartCount: number;
  unmeasurablePartCount: number;
  bookProfitablePartCount: number;
  actualLossPartCount: number;
  hiddenErosionPartCount: number;
  hiddenErosionTotalLossTry: number | null;
  hiddenErosionParts: PartMarginErosionItem[];
  isStaleCapacityRate: boolean;
}

export interface LoadActualCostBridgeOptions {
  asOfDate?: string;
  lookbackMonths?: number;
}

function normalizeLookbackMonths(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_ACTUAL_COST_LOOKBACK_MONTHS;
  }
  const rounded = Math.trunc(raw);
  return rounded >= 1 ? Math.min(rounded, 24) : DEFAULT_ACTUAL_COST_LOOKBACK_MONTHS;
}

/**
 * `rules.ts` içindeki `breakEvenTLPerMin` sözleşmesini koruyarak `Big.js` tam ondalık bölmesiyle
 * TL/dk başabaş oranını hesaplar. `BLANK ≠ ZERO`: payda <= 0 veya tutar <= 0 ise `null` döner
 * (asla `0,00 TL/dk`, `NaN` veya `Infinity` üretmez).
 */
function exactPositiveBreakEvenTlPerMin(
  monthlyCostDec: Decimal | null,
  effMinutes: number | null,
): number | null {
  if (monthlyCostDec === null || effMinutes === null || !Number.isFinite(effMinutes) || effMinutes <= 0) {
    return null;
  }
  if (monthlyCostDec.lte(0)) {
    return null;
  }
  // Compose with canonical rules.ts guard (`breakEvenTLPerMin` returns null on unknown/0 minutes)
  if (breakEvenTLPerMin(1, effMinutes) === null) {
    return null;
  }
  const q = divOrNull(monthlyCostDec, effMinutes);
  if (q === null || q.lte(0)) return null;
  const rounded = moneyOrNull(q);
  return rounded !== null && rounded > 0 ? rounded : null;
}

function exactNonNegativeTlPerMin(
  monthlyAmountDec: Decimal | null,
  effMinutes: number | null,
): number | null {
  if (monthlyAmountDec === null || effMinutes === null || !Number.isFinite(effMinutes) || effMinutes <= 0) {
    return null;
  }
  if (breakEvenTLPerMin(1, effMinutes) === null) {
    return null;
  }
  const q = divOrNull(monthlyAmountDec, effMinutes);
  return q === null ? null : moneyOrNull(q);
}

/**
 * Müşteri TL/dk tarifesini (örn. Akon Freze / Akon Torna) kitabi başabaş, nakit 7xx başabaş ve
 * tam 7xx (+ amortisman) başabaş karşısında `priceMargin` (`rules.ts`) ile sınar; tüm fark ve
 * yüzdeleri `Big.js` üzerinden 2 ondalığa yuvarlar.
 */
function buildCustomerRateComparison(
  operation: "freze" | "torna",
  label: string,
  rawPrice: number | null,
  bookBreakEven: number | null,
  actualCashBreakEven: number | null,
  actualFullBreakEven: number | null,
): CustomerRateBridgeComparison {
  const priceTlPerMin = rawPrice !== null && Number.isFinite(rawPrice) ? moneyOrNull(rawPrice) : null;

  const bookPm = priceMargin(bookBreakEven, priceTlPerMin);
  const cashPm = priceMargin(actualCashBreakEven, priceTlPerMin);
  const fullPm = priceMargin(actualFullBreakEven, priceTlPerMin);

  const bookMarginTlPerMin =
    bookPm.margin !== null && priceTlPerMin !== null && bookBreakEven !== null
      ? moneyOrNull(sub(priceTlPerMin, bookBreakEven))
      : null;
  const bookMarginPct =
    bookMarginTlPerMin !== null && priceTlPerMin !== null && priceTlPerMin !== 0
      ? moneyOrNull(mul(divOrNull(sub(priceTlPerMin, bookBreakEven!), priceTlPerMin)!, 100))
      : null;
  const bookLoss = bookMarginTlPerMin !== null ? bookMarginTlPerMin < 0 : bookPm.loss;

  const actualCashMarginTlPerMin =
    cashPm.margin !== null && priceTlPerMin !== null && actualCashBreakEven !== null
      ? moneyOrNull(sub(priceTlPerMin, actualCashBreakEven))
      : null;
  const actualCashLoss = actualCashMarginTlPerMin !== null ? actualCashMarginTlPerMin < 0 : cashPm.loss;

  const actualFullMarginTlPerMin =
    fullPm.margin !== null && priceTlPerMin !== null && actualFullBreakEven !== null
      ? moneyOrNull(sub(priceTlPerMin, actualFullBreakEven))
      : null;
  const actualFullMarginPct =
    actualFullMarginTlPerMin !== null && priceTlPerMin !== null && priceTlPerMin !== 0
      ? moneyOrNull(mul(divOrNull(sub(priceTlPerMin, actualFullBreakEven!), priceTlPerMin)!, 100))
      : null;
  const actualFullLoss = actualFullMarginTlPerMin !== null ? actualFullMarginTlPerMin < 0 : fullPm.loss;

  const hiddenMarginErosion =
    bookMarginTlPerMin !== null &&
    bookMarginTlPerMin > 0 &&
    !bookLoss &&
    actualFullMarginTlPerMin !== null &&
    actualFullMarginTlPerMin < 0 &&
    actualFullLoss;

  return {
    operation,
    label,
    priceTlPerMin,
    bookMarginTlPerMin,
    bookMarginPct,
    bookLoss,
    actualCashMarginTlPerMin,
    actualCashLoss,
    actualFullMarginTlPerMin,
    actualFullMarginPct,
    actualFullLoss,
    hiddenMarginErosion,
  };
}

/**
 * Saf ve deterministik TDHP 7xx Fiili Gider ↔ Tezgâh Dakika (TL/dk) başabaş köprü motoru.
 */
export function computeActualCostBridge(
  input: ComputeActualCostBridgeInput,
): ActualCostBridgeResult {
  const lookbackMonths = normalizeLookbackMonths(input.lookbackMonths);
  const maxErosionParts =
    input.maxErosionParts !== undefined && input.maxErosionParts > 0
      ? Math.trunc(input.maxErosionParts)
      : MAX_HIDDEN_EROSION_PARTS;

  // Yalnız gerçek posted 7xx aktivitesi olan dönemleri al, en güncelden geriye sırala
  const activeMonths = input.monthlyLedger7xx
    .filter((m) => m.postedEntryCount > 0)
    .slice()
    .sort((a, b) => b.periodMonth.localeCompare(a.periodMonth))
    .slice(0, lookbackMonths)
    .map((m) => ({
      periodMonth: m.periodMonth,
      production710_730Try: money(m.production710_730Try),
      opex760_770ExclDaTry: money(m.opex760_770ExclDaTry),
      depreciationDaTry: money(m.depreciationDaTry),
      financing780Try: money(m.financing780Try),
      postedEntryCount: Math.trunc(m.postedEntryCount),
    }));

  const monthCount = activeMonths.length;
  const totalPosted7xxEntries = activeMonths.reduce((acc, m) => acc + m.postedEntryCount, 0);

  let avgProdDec: Decimal | null = null;
  let avgOpexExclDaDec: Decimal | null = null;
  let avgOperatingExclDaDec: Decimal | null = null;
  let avgDaDec: Decimal | null = null;
  let avgFullInclDaDec: Decimal | null = null;
  let avgFinancingDec: Decimal | null = null;

  if (monthCount > 0) {
    const prodSum = sumDecimal(activeMonths.map((m) => m.production710_730Try));
    const opexSum = sumDecimal(activeMonths.map((m) => m.opex760_770ExclDaTry));
    const daSum = sumDecimal(activeMonths.map((m) => m.depreciationDaTry));
    const finSum = sumDecimal(activeMonths.map((m) => m.financing780Try));
    const operatingSum = add(prodSum, opexSum);
    const fullSum = add(operatingSum, daSum);

    avgProdDec = divOrNull(prodSum, monthCount);
    avgOpexExclDaDec = divOrNull(opexSum, monthCount);
    avgOperatingExclDaDec = divOrNull(operatingSum, monthCount);
    avgDaDec = divOrNull(daSum, monthCount);
    avgFullInclDaDec = divOrNull(fullSum, monthCount);
    avgFinancingDec = divOrNull(finSum, monthCount);
  }

  // BLANK ≠ ZERO: 0 posted 7xx ayı varsa VEYA 710..770 tam faaliyet/üretim maliyeti <= 0 ise
  // asla 0,00 TL/dk başabaş üretilmez.
  const hasSufficientOperatingActuals =
    monthCount > 0 && avgFullInclDaDec !== null && avgFullInclDaDec.gt(0);

  const models: ModelActualCostBridge[] = input.costModels.map((m) => {
    const validEffMinutes =
      m.effectiveMinutes !== null &&
      Number.isFinite(m.effectiveMinutes) &&
      m.effectiveMinutes > 0
        ? m.effectiveMinutes
        : null;

    const bookBreakEvenTlPerMin =
      m.breakEven !== null && Number.isFinite(m.breakEven) ? moneyOrNull(m.breakEven) : null;
    const staticMonthlyCostTry =
      m.monthlyCost !== null && Number.isFinite(m.monthlyCost) ? moneyOrNull(m.monthlyCost) : null;

    let modelStatus: ActualCostBridgeStatus;
    if (!hasSufficientOperatingActuals) {
      modelStatus = "insufficient_ledger_actuals";
    } else if (validEffMinutes === null) {
      modelStatus = "unknown_effective_minutes";
    } else {
      modelStatus = "ready";
    }

    const actualCashBreakEvenTlPerMin =
      modelStatus === "ready"
        ? exactPositiveBreakEvenTlPerMin(avgOperatingExclDaDec, validEffMinutes)
        : null;
    const actualFullBreakEvenTlPerMin =
      modelStatus === "ready"
        ? exactPositiveBreakEvenTlPerMin(avgFullInclDaDec, validEffMinutes)
        : null;
    const financing780TlPerMin =
      modelStatus === "ready"
        ? exactNonNegativeTlPerMin(avgFinancingDec, validEffMinutes)
        : null;

    // Eğer tam 7xx bölümü yuvarlama sonrası null döndüyse modelStatus ölçülemez kalır
    if (modelStatus === "ready" && actualFullBreakEvenTlPerMin === null) {
      modelStatus = "insufficient_ledger_actuals";
    }

    const rateDriftTlPerMin =
      actualFullBreakEvenTlPerMin !== null && bookBreakEvenTlPerMin !== null
        ? moneyOrNull(sub(actualFullBreakEvenTlPerMin, bookBreakEvenTlPerMin))
        : null;

    const rateDriftPct =
      rateDriftTlPerMin !== null &&
      bookBreakEvenTlPerMin !== null &&
      bookBreakEvenTlPerMin !== 0 &&
      actualFullBreakEvenTlPerMin !== null
        ? moneyOrNull(
            mul(
              divOrNull(
                sub(actualFullBreakEvenTlPerMin, bookBreakEvenTlPerMin),
                bookBreakEvenTlPerMin,
              )!,
              100,
            ),
          )
        : null;

    const cashRateDriftTlPerMin =
      actualCashBreakEvenTlPerMin !== null && bookBreakEvenTlPerMin !== null
        ? moneyOrNull(sub(actualCashBreakEvenTlPerMin, bookBreakEvenTlPerMin))
        : null;

    const akonFrezeComparison = buildCustomerRateComparison(
      "freze",
      "Akon Freze",
      m.akonFreze,
      bookBreakEvenTlPerMin,
      actualCashBreakEvenTlPerMin,
      actualFullBreakEvenTlPerMin,
    );
    const akonTornaComparison = buildCustomerRateComparison(
      "torna",
      "Akon Torna",
      m.akonTorna,
      bookBreakEvenTlPerMin,
      actualCashBreakEvenTlPerMin,
      actualFullBreakEvenTlPerMin,
    );
    const customerRates = [akonFrezeComparison, akonTornaComparison];
    const hasHiddenRateErosion = customerRates.some((cr) => cr.hiddenMarginErosion);

    return {
      modelId: m.id,
      modelName: m.name,
      scenario: m.scenario,
      modelStatus,
      staticMonthlyCostTry,
      effectiveMinutes: validEffMinutes,
      bookBreakEvenTlPerMin,
      actualCashBreakEvenTlPerMin,
      actualFullBreakEvenTlPerMin,
      actualBreakEvenTlPerMin: actualFullBreakEvenTlPerMin,
      financing780TlPerMin,
      rateDriftTlPerMin,
      rateDriftPct,
      cashRateDriftTlPerMin,
      akonFrezeComparison,
      akonTornaComparison,
      customerRates,
      hasHiddenRateErosion,
    };
  });

  const readyModels = models.filter((m) => m.modelStatus === "ready");
  let status: ActualCostBridgeStatus;
  if (!hasSufficientOperatingActuals) {
    status = "insufficient_ledger_actuals";
  } else if (readyModels.length === 0) {
    status = "unknown_effective_minutes";
  } else {
    status = "ready";
  }

  const primaryModel =
    readyModels.find((m) => m.scenario === "normal") ??
    readyModels[0] ??
    models.find((m) => m.scenario === "normal") ??
    models[0] ??
    null;

  const hiddenErosionRateCount = models.reduce(
    (acc, m) => acc + m.customerRates.filter((cr) => cr.hiddenMarginErosion).length,
    0,
  );

  // Parça bazlı gizli marj erimesi analizi (kitabi marj > 0 iken fiili 7xx tam marj < 0 olanlar)
  let evaluatedPartCount = 0;
  let unmeasurablePartCount = 0;
  let bookProfitablePartCount = 0;
  let actualLossPartCount = 0;
  const allErosionItems: PartMarginErosionItem[] = [];

  const partsList = input.parts ?? [];
  const refBookRate = primaryModel?.bookBreakEvenTlPerMin ?? null;
  const refCashRate = primaryModel?.actualCashBreakEvenTlPerMin ?? null;
  const refFullRate = primaryModel?.actualFullBreakEvenTlPerMin ?? null;

  for (const part of partsList) {
    // Mevcut rules.ts `partProfitability` ile operasyon süresi ve null kurallarını uygula
    const bookProf = partProfitability(part, refBookRate, refBookRate);
    const fullProf = partProfitability(part, refFullRate, refFullRate);

    if (
      status !== "ready" ||
      refBookRate === null ||
      refFullRate === null ||
      bookProf.missingOperationTime ||
      part.quantity === null ||
      !Number.isFinite(part.quantity) ||
      part.quantity <= 0 ||
      part.revenue === null ||
      !Number.isFinite(part.revenue) ||
      bookProf.estimatedMargin === null ||
      fullProf.estimatedMargin === null
    ) {
      unmeasurablePartCount++;
      continue;
    }

    const tornaMinDec =
      part.tornaMinutesPerUnit !== null && Number.isFinite(part.tornaMinutesPerUnit)
        ? mul(part.tornaMinutesPerUnit, part.quantity)
        : zero();
    const frezeMinDec =
      part.frezeMinutesPerUnit !== null && Number.isFinite(part.frezeMinutesPerUnit)
        ? mul(part.frezeMinutesPerUnit, part.quantity)
        : zero();
    const totalMinDec = add(tornaMinDec, frezeMinDec);

    if (totalMinDec.lte(0)) {
      unmeasurablePartCount++;
      continue;
    }

    evaluatedPartCount++;

    const revenueDec = decimal(part.revenue);
    const bookCostDec = mul(totalMinDec, refBookRate);
    const bookMarginDec = sub(revenueDec, bookCostDec);
    const fullCostDec = mul(totalMinDec, refFullRate);
    const fullMarginDec = sub(revenueDec, fullCostDec);

    const bookCostTry = money(bookCostDec);
    const bookMarginTry = money(bookMarginDec);
    const actualFullCostTry = money(fullCostDec);
    const actualFullMarginTry = money(fullMarginDec);

    const actualCashCostTry =
      refCashRate !== null ? money(mul(totalMinDec, refCashRate)) : null;
    const actualCashMarginTry =
      refCashRate !== null ? money(sub(revenueDec, mul(totalMinDec, refCashRate))) : null;

    if (bookMarginTry > 0) bookProfitablePartCount++;
    if (actualFullMarginTry < 0) actualLossPartCount++;

    const hiddenMarginErosion = bookMarginTry > 0 && actualFullMarginTry < 0;
    if (hiddenMarginErosion) {
      const impliedRateDec = divOrNull(revenueDec, totalMinDec);
      allErosionItems.push({
        partId: part.id ?? null,
        partCode: part.code,
        partName: part.name,
        customerName: part.customerName ?? null,
        quantity: part.quantity,
        totalMinutes: rateOrNull(totalMinDec) as number,
        revenueTry: money(revenueDec),
        impliedPriceTlPerMin: impliedRateDec !== null ? moneyOrNull(impliedRateDec) : null,
        bookCostTry,
        bookMarginTry,
        actualCashCostTry,
        actualCashMarginTry,
        actualFullCostTry,
        actualFullMarginTry,
        marginDeltaTry: money(sub(actualFullMarginTry, bookMarginTry)),
        hiddenMarginErosion: true,
      });
    }
  }

  allErosionItems.sort((a, b) => a.actualFullMarginTry - b.actualFullMarginTry);
  const hiddenErosionPartCount = allErosionItems.length;
  const hiddenErosionTotalLossTry =
    status === "ready"
      ? money(sumDecimal(allErosionItems.map((it) => it.actualFullMarginTry)))
      : null;
  const hiddenErosionParts = allErosionItems.slice(0, maxErosionParts);

  return {
    status,
    lookbackMonths,
    includedMonths: activeMonths,
    monthCount,
    totalPosted7xxEntries,
    avgMonthlyProduction710_730Try: hasSufficientOperatingActuals ? moneyOrNull(avgProdDec) : null,
    avgMonthlyOpex760_770ExclDaTry: hasSufficientOperatingActuals ? moneyOrNull(avgOpexExclDaDec) : null,
    avgMonthlyOperating7xxExclDaTry: hasSufficientOperatingActuals
      ? moneyOrNull(avgOperatingExclDaDec)
      : null,
    avgMonthlyDepreciationDaTry: hasSufficientOperatingActuals ? moneyOrNull(avgDaDec) : null,
    avgMonthlyFull7xxInclDaTry: hasSufficientOperatingActuals ? moneyOrNull(avgFullInclDaDec) : null,
    avgMonthlyFinancing780Try: monthCount > 0 ? moneyOrNull(avgFinancingDec) : null,
    primaryScenario: primaryModel?.scenario ?? null,
    bookBreakEvenTlPerMin: primaryModel?.bookBreakEvenTlPerMin ?? null,
    actualCashBreakEvenTlPerMin:
      status === "ready" ? (primaryModel?.actualCashBreakEvenTlPerMin ?? null) : null,
    actualFullBreakEvenTlPerMin:
      status === "ready" ? (primaryModel?.actualFullBreakEvenTlPerMin ?? null) : null,
    actualBreakEvenTlPerMin:
      status === "ready" ? (primaryModel?.actualFullBreakEvenTlPerMin ?? null) : null,
    rateDriftTlPerMin: status === "ready" ? (primaryModel?.rateDriftTlPerMin ?? null) : null,
    rateDriftPct: status === "ready" ? (primaryModel?.rateDriftPct ?? null) : null,
    models,
    hiddenErosionRateCount,
    evaluatedPartCount,
    unmeasurablePartCount,
    bookProfitablePartCount,
    actualLossPartCount,
    hiddenErosionPartCount,
    hiddenErosionTotalLossTry,
    hiddenErosionParts,
    isStaleCapacityRate: Boolean(input.isStaleCapacityRate),
  };
}

async function loadMonthlyLedger7xxRows(
  pool: Pool,
  asOfDate: string | null,
  lookbackMonths: number,
): Promise<MonthlyLedger7xxRow[]> {
  const res = await pool
    .query<{
      period_month: string;
      production_710_730_try: string;
      opex_760_770_excl_da_try: string;
      depreciation_da_try: string;
      financing_780_try: string;
      posted_entry_count: number | string;
    }>(
      `select
         to_char(e.period_month, 'YYYY-MM-DD') as period_month,
         coalesce(sum(case
           when a.ebitda_bucket = 'cogs' then coalesce(l.debit_try, 0) - coalesce(l.credit_try, 0)
           else 0
         end), 0)::numeric(16,2)::text as production_710_730_try,
         coalesce(sum(case
           when a.ebitda_bucket = 'opex' then coalesce(l.debit_try, 0) - coalesce(l.credit_try, 0)
           else 0
         end), 0)::numeric(16,2)::text as opex_760_770_excl_da_try,
         coalesce(sum(case
           when a.ebitda_bucket = 'da_addback' then coalesce(l.debit_try, 0) - coalesce(l.credit_try, 0)
           else 0
         end), 0)::numeric(16,2)::text as depreciation_da_try,
         coalesce(sum(case
           when a.ebitda_bucket = 'financing' then coalesce(l.debit_try, 0) - coalesce(l.credit_try, 0)
           else 0
         end), 0)::numeric(16,2)::text as financing_780_try,
         count(distinct e.id) filter (
           where e.status = 'posted' and e.source_type <> 'reversal'
         )::int as posted_entry_count
       from public.management_journal_entries e
       join public.management_journal_lines l
         on l.entry_id = e.id
       join public.management_accounts a
         on a.id = l.account_id
      where e.status in ('posted', 'reversed')
        and a.is_active = true
        and a.tdhp_root_code like '7%'
        and a.ebitda_bucket in ('cogs', 'opex', 'da_addback', 'financing')
        and ($1::date is null or e.period_month <= date_trunc('month', $1::date)::date)
      group by e.period_month
      having count(distinct e.id) filter (
        where e.status = 'posted' and e.source_type <> 'reversal'
      ) > 0
      order by e.period_month desc
      limit $2`,
      [asOfDate, lookbackMonths],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) {
        return { rows: [], rowCount: 0 };
      }
      throw err;
    });

  return (res?.rows ?? []).map((r) => ({
    periodMonth: r.period_month,
    production710_730Try: money(r.production_710_730_try),
    opex760_770ExclDaTry: money(r.opex_760_770_excl_da_try),
    depreciationDaTry: money(r.depreciation_da_try),
    financing780Try: money(r.financing_780_try),
    postedEntryCount: Number(r.posted_entry_count),
  }));
}

async function loadBridgeParts(
  pool: Pool,
  fallbackRevenuesByCode: Map<string, number | null>,
): Promise<PartBridgeInput[]> {
  const res = await pool
    .query<{
      id: string;
      part_code: string | null;
      part_name: string;
      quantity: number | string | null;
      torna_minutes: string | number | null;
      freze_minutes: string | number | null;
      unit_sale_price: string | number | null;
      currency: string | null;
      row_json: unknown;
    }>(
      `select pp.id::text as id,
              pp.part_code,
              pp.part_name,
              pp.quantity,
              pp.torna_minutes::text as torna_minutes,
              pp.freze_minutes::text as freze_minutes,
              pp.unit_sale_price::text as unit_sale_price,
              pp.currency,
              ir.row_json
         from public.production_parts pp
         left join public.import_rows ir on ir.id = pp.source_row_id
        order by pp.part_code nulls last, pp.part_name`,
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query<{
            id: string;
            part_code: string | null;
            part_name: string;
            quantity: number | string | null;
            torna_minutes: string | number | null;
            freze_minutes: string | number | null;
            unit_sale_price: string | number | null;
            currency: string | null;
            row_json: unknown;
          }>(
            `select pp.id::text as id,
                    pp.part_code,
                    pp.part_name,
                    pp.quantity,
                    pp.torna_minutes::text as torna_minutes,
                    pp.freze_minutes::text as freze_minutes,
                    null::text as unit_sale_price,
                    'TRY'::text as currency,
                    ir.row_json
               from public.production_parts pp
               left join public.import_rows ir on ir.id = pp.source_row_id
              order by pp.part_code nulls last, pp.part_name`,
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  return (res?.rows ?? []).map((row) => {
    const qty = row.quantity === null || row.quantity === undefined ? null : Number(row.quantity);
    let rev: number | null = null;
    try {
      rev = sourceRevenue(row.row_json ?? null, qty);
    } catch {
      rev = null;
    }
    if (
      rev === null &&
      row.unit_sale_price !== null &&
      row.unit_sale_price !== undefined &&
      qty !== null &&
      (row.currency === null || row.currency === undefined || row.currency === "TRY")
    ) {
      rev = moneyOrNull(mul(row.unit_sale_price, qty));
    }
    if (rev === null && row.part_code !== null) {
      rev = fallbackRevenuesByCode.get(row.part_code) ?? null;
    }
    return {
      id: row.id,
      code: row.part_code,
      name: row.part_name,
      quantity: qty,
      tornaMinutesPerUnit: rateOrNull(row.torna_minutes),
      frezeMinutesPerUnit: rateOrNull(row.freze_minutes),
      revenue: rev,
    };
  });
}

/**
 * Veritabanından 0105 çift taraflı yönetim defterindeki posted 7xx özetini, maliyet modellerini,
 * kapasite modellerini ve üretim parçalarını okuyup canlı başabaş köprüsünü hesaplar.
 * 0105 öncesi şemalarda veya boş tablolarda hata fırlatmadan `insufficient_ledger_actuals` döner.
 */
export async function loadActualCostBridge(
  pool: Pool,
  options?: LoadActualCostBridgeOptions,
): Promise<ActualCostBridgeResult> {
  const lookbackMonths = normalizeLookbackMonths(options?.lookbackMonths);
  const asOfDate =
    options?.asOfDate !== undefined && options.asOfDate.trim() !== ""
      ? options.asOfDate.trim()
      : null;

  const [monthlyLedger7xx, costModels, capacityModels, storedProfitability] = await Promise.all([
    loadMonthlyLedger7xxRows(pool, asOfDate, lookbackMonths),
    loadCostModels(pool),
    loadCapacityModels(pool),
    loadPartProfitability(pool, 200),
  ]);

  const fallbackRevenuesByCode = new Map<string, number | null>();
  for (const sp of storedProfitability) {
    if (sp.part_code !== null && sp.revenue !== null && !fallbackRevenuesByCode.has(sp.part_code)) {
      fallbackRevenuesByCode.set(sp.part_code, sp.revenue);
    }
  }

  const parts = await loadBridgeParts(pool, fallbackRevenuesByCode);
  const isStaleCapacityRate = capacityModels.some((cm) => cm.isStaleRate === true);

  return computeActualCostBridge({
    monthlyLedger7xx,
    costModels,
    parts,
    lookbackMonths,
    isStaleCapacityRate,
  });
}

/* ── UI Biçimlendirme Yardımcıları (BLANK ≠ ZERO uyumlu, Big.js half-up yuvarlamalı) ── */

function formatGroupingTr(exactFixed: string): string {
  const [intRaw, fracPart] = exactFixed.split(".");
  const isNeg = intRaw.startsWith("-");
  const digits = isNeg ? intRaw.slice(1) : intRaw;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return fracPart !== undefined
    ? `${isNeg ? "-" : ""}${grouped},${fracPart}`
    : `${isNeg ? "-" : ""}${grouped}`;
}

/** `null` değeri asla `0,00 TL/dk` göstermez; `"—"` döner. */
export function fmtTlPerMin(value: number | null | undefined): string {
  const exact = formatMoneyOrNull(value, 2);
  if (exact === null) return "—";
  return `${formatGroupingTr(exact)} TL/dk`;
}

/** İşaretli sapma gösterimi (`+3,22 TL/dk` / `-1,90 TL/dk`); `null` ise `"—"` döner. */
export function fmtSignedTlPerMin(value: number | null | undefined): string {
  const exact = formatMoneyOrNull(value, 2);
  if (exact === null) return "—";
  const prefix = !exact.startsWith("-") && exact !== "0.00" ? "+" : "";
  return `${prefix}${formatGroupingTr(exact)} TL/dk`;
}

/** İşaretli yüzde gösterimi (`+%12,30` / `-%6,91`); `null` ise `"—"` döner. */
export function fmtSignedPct(value: number | null | undefined): string {
  const exact = formatMoneyOrNull(value, 2);
  if (exact === null) return "—";
  if (exact.startsWith("-")) {
    return `-%${formatGroupingTr(exact.slice(1))}`;
  }
  const prefix = exact !== "0.00" ? "+" : "";
  return `${prefix}%${formatGroupingTr(exact)}`;
}
