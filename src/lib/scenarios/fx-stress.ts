/**
 * SA-8 (v6) — TCMB Kur Şoku (+%10 / +%20 / +%30), Doğal Hedge Karşılama Oranı
 * ve Kovenant Kırılma Stres Katmanı (`computeFxStressAndNaturalHedge` & `loadFxStressOverlay`).
 *
 * Ev Kuralları (CLAUDE.md & calculation-rules.md):
 * 1. Farklı para birimleri (`USD`, `EUR`, `GBP` vb.) orijinal birimlerinde ASLA toplanmaz.
 * 2. Yalnızca resmi TCMB kuru (`fx_rate_snapshots` / `loadLatestRates`) mevcutsa açık stres
 *    simülasyonu içinde `TRY`'ye çevrilir. Kur eksikse ASLA `1.0` veya `0` ikame edilmez;
 *    `status = "missing_fx_rates"`, `missingFxCurrencies` ve `consolidatedNetOpenTry = null` döner.
 * 3. `FIN-03` bilinmeyen açılış bakiyesi (`cashBalance === null` / `availableNowTry === null`)
 *    ASLA `0`'a zorlanmaz; `hasUnknownCashOpening = true` olarak yayılır.
 * 4. Tüm parasal hesaplamalar `Big` (`@/lib/money`) ve mevcut `STRESS_BANDS` / `stressValue`
 *    (`@/lib/fx/rules`), `computeCashDscrWindow` / `evaluateCovenantThreshold`
 *    (`@/lib/financing/covenants-and-dscr`) yapıtaşları üzerinden yürütülür.
 *
 * Bu modül `@/lib/ai` veya `@/lib/env` import etmez.
 */

import type { Pool, PoolClient } from "pg";
import { loadLatestRates } from "@/lib/fx/engine";
import { STRESS_BANDS, stressValue } from "@/lib/fx/rules";
import {
  computeCashDscrWindow,
  evaluateCovenantThreshold,
  isMissingSchemaError,
  loadCovenantAndDscrRadar,
  type CashDscrWindow,
  type CovenantAndDscrRadar,
  type CovenantEarlyWarningState,
} from "@/lib/financing/covenants-and-dscr";
import {
  decimal,
  divOrNull,
  money,
  moneyOrNull,
  rateOrNull,
  sub,
  toDecimalOrNull,
  zero,
  type Decimal,
  type NumericInput,
} from "@/lib/money";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** Deterministik TL değer kaybı (döviz kuru artışı) stres bantları: +%10, +%20, +%30 */
export const FX_SHOCK_PCTS = [STRESS_BANDS[1], STRESS_BANDS[2], 30] as const;
export type FxShockPct = (typeof FX_SHOCK_PCTS)[number];

export type FxStressStatus =
  | "no_fx_exposure"
  | "missing_fx_rates"
  | "unknown_cash_opening"
  | "ok";

export type NaturalHedgeStatus =
  | "unknown_cash_opening"
  | "no_liability"
  | "naturally_hedged"
  | "partial_hedge"
  | "unhedged";

export interface FxCurrencyExposureInput {
  /** ISO-4217 yabancı para kodu ('USD', 'EUR', 'GBP' vb. — 'TRY' hariç) */
  currency: string;
  /**
   * Aktif döviz kasa/banka kullanılabilir bakiyesi.
   * - Aktif hesap yoksa veya bakiye sıfırsa `0`.
   * - Aktif hesapta `opening_balance IS NULL` (FIN-03) varsa `null` (asla `0` yapılmaz!).
   */
  cashBalance: NumericInput;
  /** FIN-03: Bu dövizde açılış bakiyesi bilinmeyen aktif kasa/banka hesabı var mı? */
  hasUnknownCashOpening?: boolean;
  /** Açık satış faturaları kalan alacak tutarı (orijinal döviz) */
  openReceivables?: NumericInput;
  /** Portföydeki / tahsildeki / teminattaki aktif müşteri çekleri (orijinal döviz) */
  portfolioCustomerChecks?: NumericInput;
  /** Açık alış faturaları + dövizli açık planlı ödemeler (`payment_instances`) (orijinal döviz) */
  openPayables?: NumericInput;
  /** Kalan kredi taksitleri anapara + faiz + vergi toplamı (`planned`/`unpaid`/`partial`/`late`) */
  loanPrincipalAndInterestRemaining?: NumericInput;
  /** Kaldıraç (`Net Borç / EBITDA`) kovenantı için kalan kredi anaparası (verilmezse taksit toplamı kullanılır) */
  loanPrincipalRemaining?: NumericInput;
  /** Kullanılan aktif döviz rotatif kredi tutarı */
  facilityDrawn?: NumericInput;
  /** Keşide edilmiş aktif borç çekleri (orijinal döviz) */
  issuedChecks?: NumericInput;
  /** Gelecek 12 ay içinde vadesi gelen döviz kredi borç servisi (orijinal döviz) */
  next12mDebtServiceNative?: NumericInput;
  /** `fx_rate_snapshots` resmi TCMB kuru (1 birim döviz karşılığı TL); kayıt yoksa `null` */
  tcmbBaseRate: NumericInput;
  /** Resmi TCMB kur tarihi (`YYYY-MM-DD`) */
  tcmbRateDate?: string | null;
}

export interface FxStressCovenantInput {
  covenantId: string;
  subjectName: string;
  covenantType: string;
  description?: string;
  comparison: ">=" | "<=" | ">" | "<" | "=";
  thresholdValue: number;
  status?: string;
  baseMeasuredValue?: number | null;
}

export interface FxStressDscrBaselineInput {
  periodStart?: string;
  periodEnd?: string;
  /** Gelecek 12 ay TL operasyonel nakit girişleri (borç servisi öncesi) */
  tryOperationalInflows: NumericInput;
  /** Gelecek 12 ay TL operasyonel nakit çıkışları (borç servisi öncesi) */
  tryOperationalOutflowsBeforeDebtService: NumericInput;
  /** Gelecek 12 ay TL kredi taksitleri (kur şokundan etkilenmeyen TL borç servisi) */
  tryInstallments?: ReadonlyArray<{
    amount: number;
    principalComponent?: number | null;
    interestComponent?: number | null;
    taxComponentBsmvKkdf?: number | null;
  }>;
  /** Kaldıraç kovenantı için kalan TL kredi anaparası */
  tryLoanPrincipalRemaining?: NumericInput;
  /** Kaldıraç kovenantı için kullanılan TL rotatif kredi bakiyesi */
  tryFacilityDrawn?: NumericInput;
  /** Faz 52 Yönetim EBITDA'sı (TL) */
  managementEbitdaTry?: NumericInput;
  /** Aktif kredi kovenantları */
  covenants?: ReadonlyArray<FxStressCovenantInput>;
  extraUnknownCount?: number;
}

export interface ComputeFxStressInput {
  asOfDate: string;
  /** Mevcut kullanılabilir TL nakit (`FIN-03` açılış bakiyesi eksikse `null`) */
  availableNowTry: NumericInput;
  /** FIN-03: TL kasa/banka hesaplarında bilinmeyen açılış bakiyesi var mı? */
  hasUnknownTryCashOpening?: boolean;
  /** Yabancı para pozisyon girdileri */
  exposures: ReadonlyArray<FxCurrencyExposureInput>;
  /** Nakit DSCR & Kovenant temel bağlamı (`loadCovenantAndDscrRadar` çıktısı) */
  dscrBaseline?: FxStressDscrBaselineInput | null;
}

export interface FxCurrencyBucket {
  currency: string;
  hasUnknownCashOpening: boolean;
  cashBalance: number | null;
  openReceivables: number;
  portfolioCustomerChecks: number;
  /** Döviz varlıklar (`cashBalance + openReceivables + portfolioCustomerChecks`); açılış eksikse `null` */
  fxInflowsAndCash: number | null;
  /** `fxInflowsAndCash` ile özdeş alan adı */
  fxAssets: number | null;
  openPayables: number;
  loanPrincipalAndInterestRemaining: number;
  loanPrincipalRemaining: number;
  facilityDrawn: number;
  issuedChecks: number;
  /** Döviz yükümlülükler (`openPayables + loanPrincipalAndInterestRemaining + facilityDrawn + issuedChecks`) */
  fxOutflowsAndDebt: number;
  /** `fxOutflowsAndDebt` ile özdeş alan adı */
  fxLiabilities: number;
  next12mDebtServiceNative: number;
  /** `fxAssets - fxLiabilities` (`> 0` uzun pozisyon, `< 0` kısa/açık pozisyon; açılış eksikse `null`) */
  netNativePosition: number | null;
  positionDirection: "long" | "short" | "flat" | "unknown";
  /** `fxLiabilities > 0 ? fxAssets / fxLiabilities : null` (`>= 1.0` doğal hedgeli) */
  naturalHedgeRatio: number | null;
  isNaturallyHedged: boolean | null;
  hedgeStatus: NaturalHedgeStatus;
  tcmbBaseRate: number | null;
  tcmbRateDate: string | null;
  hasOpenExposure: boolean;
  hasMissingRate: boolean;
  baseNetValueTry: number | null;
  shockDeltasByBand: Record<FxShockPct, number | null>;
}

export interface FxShockCurrencyBreakdown {
  currency: string;
  baseRate: number | null;
  shockedRate: number | null;
  baseNetValueTry: number | null;
  shockedNetValueTry: number | null;
  shockDeltaTry: number | null;
  shockedNext12mDebtServiceTry: number | null;
}

export interface FxShockCovenantImpact {
  covenantId: string;
  subjectName: string;
  covenantType: string;
  description: string;
  comparison: ">=" | "<=" | ">" | "<" | "=";
  thresholdValue: number;
  baseMeasuredValue: number | null;
  baseState: CovenantEarlyWarningState;
  postShockMeasuredValue: number | null;
  postShockState: CovenantEarlyWarningState;
  postShockHeadroomPct: number | null;
  postShockExplanation: string;
  /** Kovenant bu kur şoku bandında ilk kez `"breached"` durumuna geçtiyse `true` */
  crossedIntoBreach: boolean;
}

export interface FxShockBandResult {
  shockPct: FxShockPct;
  label: string;
  perCurrency: FxShockCurrencyBreakdown[];
  consolidatedPostShockNetTry: number | null;
  /** Net döviz pozisyonu kur şoku farkı (kısa pozisyonda TL değer kaybı altında negatif) */
  netWorthShockDeltaTry: number | null;
  /** `netWorthShockDeltaTry` ile özdeş konsolide kur şoku farkı (TL) */
  consolidatedShockDeltaTry: number | null;
  /** `availableNowTry + netWorthShockDeltaTry` (`FIN-03` veya eksik kur varsa `null`) */
  postShockLiquidityBufferTry: number | null;
  shockedFxNext12mDebtServiceTry: number | null;
  postShockForward12mDscrWindow: CashDscrWindow | null;
  postShockForward12mDscr: number | null;
  postShockNetDebtTry: number | null;
  postShockNetDebtToEbitda: number | null;
  covenantEvaluations: FxShockCovenantImpact[];
  breachedCovenantCount: number;
  newlyBreachedCovenantCount: number;
  /** Bir `min_dscr` veya `max_net_debt_to_ebitda` (veya likidite) kovenantı bu şokla `"breached"` durumuna geçtiyse `true` */
  covenantBreachTriggered: boolean;
}

export interface FxStressAndNaturalHedgeResult {
  asOfDate: string;
  status: FxStressStatus;
  shockBandsPct: readonly FxShockPct[];
  hasUnknownCashOpening: boolean;
  hasUnknownFxCashOpening: boolean;
  hasUnknownTryCashOpening: boolean;
  missingFxCurrencies: string[];
  availableNowTry: number | null;
  /** Yalnızca yabancı para kalemleri — orijinal döviz tutarları birbiriyle ASLA toplanmaz */
  currencies: FxCurrencyBucket[];
  consolidatedNetOpenTry: number | null;
  baseForward12mDscrWithSpotFx: number | null;
  shockBands: FxShockBandResult[];
}

const PRIORITY_CURRENCIES: Record<string, number> = {
  USD: 1,
  EUR: 2,
  GBP: 3,
  CHF: 4,
};

function normalizeZero(n: number): number {
  return Object.is(n, -0) || n === 0 ? 0 : n;
}

function roundMoneyNum(d: Decimal): number {
  return normalizeZero(money(d));
}

function nonNegDecimal(v: NumericInput): Decimal {
  const d = toDecimalOrNull(v);
  if (d === null) return zero();
  return d.lt(0) ? d.abs() : d;
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function sortCurrencyCodes(a: string, b: string): number {
  const pa = PRIORITY_CURRENCIES[a] ?? 99;
  const pb = PRIORITY_CURRENCIES[b] ?? 99;
  if (pa !== pb) return pa - pb;
  return a.localeCompare(b);
}

/** Orijinal döviz tutarını kendi para birimi koduyla biçimlendirir (asla "TL" eklemez). */
export function formatNativeFx(amount: number | null | undefined, currency: string): string {
  if (amount == null) return "TUTAR EKSİK";
  const clean = normalizeZero(amount);
  return `${new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(clean)} ${currency.trim().toUpperCase()}`;
}

/** Resmi TCMB kurunu 4 ondalık hassasiyetle biçimlendirir; kur yoksa dürüstçe açıklar. */
export function formatTcmbRate(rate: number | null | undefined): string {
  if (rate == null || rate <= 0) return "TCMB kuru eksik";
  return `${new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(rate)} TL`;
}

function isStressTestedCovenantType(covenantType: string): boolean {
  const ct = covenantType.trim().toLowerCase();
  return (
    ct === "dscr" ||
    ct === "min_dscr" ||
    ct === "net_debt_to_ebitda" ||
    ct === "max_net_debt_to_ebitda" ||
    ct === "leverage" ||
    ct === "min_cash_balance" ||
    ct === "liquidity"
  );
}

/**
 * Saf (pure), deterministik Döviz Doğal Hedge, TCMB Kur Şoku (+%10 / +%20 / +%30) ve
 * Kovenant Kırılma Stres Hesaplayıcısı.
 */
export function computeFxStressAndNaturalHedge(
  input: ComputeFxStressInput,
): FxStressAndNaturalHedgeResult {
  const hasUnknownTryCash =
    input.hasUnknownTryCashOpening === true || input.availableNowTry === null || input.availableNowTry === undefined;
  const availableNowTry: number | null = hasUnknownTryCash
    ? null
    : normalizeZero(money(input.availableNowTry));

  // Aynı para biriminde birden fazla girdi varsa orijinal para birimi içinde birleştir (farklı dövizler ASLA karışmaz!)
  const grouped = new Map<
    string,
    {
      currency: string;
      hasUnknownCashOpening: boolean;
      cashDec: Decimal;
      receivablesDec: Decimal;
      customerChecksDec: Decimal;
      payablesDec: Decimal;
      loanTotalDec: Decimal;
      loanPrincipalDec: Decimal;
      facilityDrawnDec: Decimal;
      issuedChecksDec: Decimal;
      next12mServiceDec: Decimal;
      tcmbBaseRate: number | null;
      tcmbRateDate: string | null;
    }
  >();

  for (const raw of input.exposures) {
    const code = raw.currency.trim().toUpperCase();
    if (!code || code === "TRY") continue;

    const existing = grouped.get(code) ?? {
      currency: code,
      hasUnknownCashOpening: false,
      cashDec: zero(),
      receivablesDec: zero(),
      customerChecksDec: zero(),
      payablesDec: zero(),
      loanTotalDec: zero(),
      loanPrincipalDec: zero(),
      facilityDrawnDec: zero(),
      issuedChecksDec: zero(),
      next12mServiceDec: zero(),
      tcmbBaseRate: null,
      tcmbRateDate: null,
    };

    const cashDecOrNull = toDecimalOrNull(raw.cashBalance);
    if (raw.hasUnknownCashOpening === true || cashDecOrNull === null) {
      existing.hasUnknownCashOpening = true;
    } else {
      existing.cashDec = existing.cashDec.plus(cashDecOrNull);
    }

    existing.receivablesDec = existing.receivablesDec.plus(nonNegDecimal(raw.openReceivables));
    existing.customerChecksDec = existing.customerChecksDec.plus(
      nonNegDecimal(raw.portfolioCustomerChecks),
    );
    existing.payablesDec = existing.payablesDec.plus(nonNegDecimal(raw.openPayables));

    const loanRem = nonNegDecimal(raw.loanPrincipalAndInterestRemaining);
    existing.loanTotalDec = existing.loanTotalDec.plus(loanRem);

    const loanPrin =
      raw.loanPrincipalRemaining !== undefined && raw.loanPrincipalRemaining !== null
        ? nonNegDecimal(raw.loanPrincipalRemaining)
        : loanRem;
    existing.loanPrincipalDec = existing.loanPrincipalDec.plus(loanPrin);

    existing.facilityDrawnDec = existing.facilityDrawnDec.plus(nonNegDecimal(raw.facilityDrawn));
    existing.issuedChecksDec = existing.issuedChecksDec.plus(nonNegDecimal(raw.issuedChecks));
    existing.next12mServiceDec = existing.next12mServiceDec.plus(
      nonNegDecimal(raw.next12mDebtServiceNative),
    );

    const parsedRate = rateOrNull(raw.tcmbBaseRate);
    if (parsedRate !== null && parsedRate > 0) {
      existing.tcmbBaseRate = parsedRate;
      existing.tcmbRateDate = raw.tcmbRateDate ?? existing.tcmbRateDate;
    }

    grouped.set(code, existing);
  }

  const sortedCodes = Array.from(grouped.keys()).sort(sortCurrencyCodes);
  const currencies: FxCurrencyBucket[] = [];
  const missingFxCurrencies: string[] = [];
  let hasUnknownFxCashOpening = false;

  for (const code of sortedCodes) {
    const g = grouped.get(code)!;
    const openReceivables = roundMoneyNum(g.receivablesDec);
    const portfolioCustomerChecks = roundMoneyNum(g.customerChecksDec);
    const openPayables = roundMoneyNum(g.payablesDec);
    const loanPrincipalAndInterestRemaining = roundMoneyNum(g.loanTotalDec);
    const loanPrincipalRemaining = roundMoneyNum(g.loanPrincipalDec);
    const facilityDrawn = roundMoneyNum(g.facilityDrawnDec);
    const issuedChecks = roundMoneyNum(g.issuedChecksDec);
    const next12mDebtServiceNative = roundMoneyNum(g.next12mServiceDec);

    const fxLiabilitiesDec = g.payablesDec
      .plus(g.loanTotalDec)
      .plus(g.facilityDrawnDec)
      .plus(g.issuedChecksDec);
    const fxLiabilities = roundMoneyNum(fxLiabilitiesDec);

    const nonCashAssetsDec = g.receivablesDec.plus(g.customerChecksDec);
    const cashBalance: number | null = g.hasUnknownCashOpening
      ? null
      : roundMoneyNum(g.cashDec);

    const fxAssetsDec: Decimal | null = g.hasUnknownCashOpening
      ? null
      : g.cashDec.plus(nonCashAssetsDec);
    const fxAssets: number | null = fxAssetsDec === null ? null : roundMoneyNum(fxAssetsDec);

    const hasOpenExposure =
      g.hasUnknownCashOpening ||
      !g.cashDec.eq(0) ||
      !nonCashAssetsDec.eq(0) ||
      !fxLiabilitiesDec.eq(0) ||
      !g.next12mServiceDec.eq(0);

    // Tamamen sıfır ve açılışı bilinen pasif döviz satırlarını atla
    if (!hasOpenExposure) {
      continue;
    }

    if (g.hasUnknownCashOpening) {
      hasUnknownFxCashOpening = true;
    }

    const tcmbBaseRate = g.tcmbBaseRate;
    const hasMissingRate = hasOpenExposure && tcmbBaseRate === null;
    if (hasMissingRate) {
      missingFxCurrencies.push(code);
    }

    const netNativeDec: Decimal | null =
      fxAssetsDec === null ? null : fxAssetsDec.minus(fxLiabilitiesDec);
    const netNativePosition: number | null =
      netNativeDec === null ? null : roundMoneyNum(netNativeDec);

    const positionDirection: FxCurrencyBucket["positionDirection"] =
      netNativeDec === null
        ? "unknown"
        : netNativeDec.gt(0)
          ? "long"
          : netNativeDec.lt(0)
            ? "short"
            : "flat";

    const hedgeRatioDec =
      fxAssetsDec === null || fxLiabilitiesDec.lte(0)
        ? null
        : divOrNull(fxAssetsDec, fxLiabilitiesDec);
    const naturalHedgeRatio: number | null =
      hedgeRatioDec === null ? null : Number(hedgeRatioDec.round(4).toFixed(4));

    const isNaturallyHedged: boolean | null =
      fxAssetsDec === null
        ? null
        : fxLiabilitiesDec.lte(0)
          ? true
          : fxAssetsDec.gte(fxLiabilitiesDec);

    const hedgeStatus: NaturalHedgeStatus =
      fxAssetsDec === null
        ? "unknown_cash_opening"
        : fxLiabilitiesDec.lte(0)
          ? "no_liability"
          : fxAssetsDec.gte(fxLiabilitiesDec)
            ? "naturally_hedged"
            : fxAssetsDec.gt(0)
              ? "partial_hedge"
              : "unhedged";

    const baseNetValueTry: number | null =
      netNativePosition === null || tcmbBaseRate === null
        ? null
        : normalizeZero(stressValue(netNativePosition, tcmbBaseRate, 0)!);

    const shockDeltasByBand: Record<FxShockPct, number | null> = {
      10: null,
      20: null,
      30: null,
    };
    if (netNativePosition !== null && tcmbBaseRate !== null && baseNetValueTry !== null) {
      for (const pct of FX_SHOCK_PCTS) {
        const shockedVal = stressValue(netNativePosition, tcmbBaseRate, pct);
        shockDeltasByBand[pct] =
          shockedVal === null ? null : roundMoneyNum(sub(shockedVal, baseNetValueTry));
      }
    }

    currencies.push({
      currency: code,
      hasUnknownCashOpening: g.hasUnknownCashOpening,
      cashBalance,
      openReceivables,
      portfolioCustomerChecks,
      fxInflowsAndCash: fxAssets,
      fxAssets,
      openPayables,
      loanPrincipalAndInterestRemaining,
      loanPrincipalRemaining,
      facilityDrawn,
      issuedChecks,
      fxOutflowsAndDebt: fxLiabilities,
      fxLiabilities,
      next12mDebtServiceNative,
      netNativePosition,
      positionDirection,
      naturalHedgeRatio,
      isNaturallyHedged,
      hedgeStatus,
      tcmbBaseRate,
      tcmbRateDate: g.tcmbRateDate,
      hasOpenExposure,
      hasMissingRate,
      baseNetValueTry,
      shockDeltasByBand,
    });
  }

  const hasUnknownCashOpening = hasUnknownTryCash || hasUnknownFxCashOpening;

  const status: FxStressStatus =
    currencies.length === 0
      ? "no_fx_exposure"
      : missingFxCurrencies.length > 0
        ? "missing_fx_rates"
        : hasUnknownFxCashOpening
          ? "unknown_cash_opening"
          : "ok";

  // Konsolide baz TL net döviz pozisyonu (kur eksikse veya döviz kasa açılışı eksikse ASLA kısmi toplam dönmez!)
  let consolidatedNetOpenTry: number | null = null;
  if (status === "no_fx_exposure") {
    consolidatedNetOpenTry = 0;
  } else if (status === "ok") {
    let sumBaseDec = zero();
    for (const c of currencies) {
      sumBaseDec = sumBaseDec.plus(decimal(c.baseNetValueTry!));
    }
    consolidatedNetOpenTry = roundMoneyNum(sumBaseDec);
  }

  // DSCR & Kovenant temel hesaplayıcısı (spot 0% ve şoklu +%10/+%20/+%30 için ortak yardımcı)
  const baseline = input.dscrBaseline ?? null;
  const periodStart = baseline?.periodStart ?? input.asOfDate;
  const periodEnd = baseline?.periodEnd ?? addDaysISO(input.asOfDate, 365);

  const computeDscrAtShock = (
    shockPct: number,
  ): {
    fxDebtServiceTry: number | null;
    window: CashDscrWindow | null;
    dscr: number | null;
  } => {
    // Döviz borç servisi olan herhangi bir para biriminde resmi TCMB kuru eksikse DSCR uydurulmaz!
    const missingDebtRate = currencies.some(
      (c) => c.next12mDebtServiceNative > 0 && c.tcmbBaseRate === null,
    );
    if (missingDebtRate || status === "missing_fx_rates") {
      return { fxDebtServiceTry: null, window: null, dscr: null };
    }

    let fxServiceDec = zero();
    for (const c of currencies) {
      if (c.next12mDebtServiceNative > 0 && c.tcmbBaseRate !== null) {
        const valTry = stressValue(c.next12mDebtServiceNative, c.tcmbBaseRate, shockPct);
        if (valTry !== null) {
          fxServiceDec = fxServiceDec.plus(decimal(valTry));
        }
      }
    }
    const fxDebtServiceTry = roundMoneyNum(fxServiceDec);

    if (!baseline) {
      return { fxDebtServiceTry, window: null, dscr: null };
    }

    const tryInflow = moneyOrNull(baseline.tryOperationalInflows);
    const tryOutflow = moneyOrNull(baseline.tryOperationalOutflowsBeforeDebtService);
    const installments = [
      ...(baseline.tryInstallments ?? []),
      ...(fxDebtServiceTry > 0 ? [{ amount: fxDebtServiceTry }] : []),
    ];

    const window = computeCashDscrWindow({
      horizon: "forward_12m",
      label:
        shockPct === 0
          ? "Gelecek 12 Ay (TCMB Spot Kur Dahil)"
          : `Gelecek 12 Ay (+%${shockPct} TCMB Kur Şoku)`,
      periodStart,
      periodEnd,
      currency: "TRY",
      operationalInflows: [tryInflow],
      operationalOutflowsBeforeDebtService: [tryOutflow],
      installments,
      extraUnknownCount: baseline.extraUnknownCount ?? 0,
    });

    return {
      fxDebtServiceTry,
      window,
      dscr: window.dscr,
    };
  };

  const computeLeverageAtShock = (
    shockPct: number,
  ): {
    netDebtTry: number | null;
    netDebtToEbitda: number | null;
    managementEbitdaTry: number | null;
  } => {
    const ebitdaTry = baseline ? moneyOrNull(baseline.managementEbitdaTry) : null;
    if (
      !baseline ||
      availableNowTry === null ||
      hasUnknownFxCashOpening ||
      missingFxCurrencies.length > 0
    ) {
      return { netDebtTry: null, netDebtToEbitda: null, managementEbitdaTry: ebitdaTry };
    }

    const tryGrossDebtDec = nonNegDecimal(baseline.tryLoanPrincipalRemaining).plus(
      nonNegDecimal(baseline.tryFacilityDrawn),
    );
    let fxGrossDebtTryDec = zero();
    let fxCashTryDec = zero();

    for (const c of currencies) {
      const fxGrossNative = decimal(c.loanPrincipalRemaining).plus(decimal(c.facilityDrawn));
      if (fxGrossNative.gt(0) && c.tcmbBaseRate !== null) {
        const debtVal = stressValue(fxGrossNative, c.tcmbBaseRate, shockPct);
        if (debtVal !== null) fxGrossDebtTryDec = fxGrossDebtTryDec.plus(decimal(debtVal));
      }
      if (c.cashBalance !== null && c.cashBalance !== 0 && c.tcmbBaseRate !== null) {
        const cashVal = stressValue(c.cashBalance, c.tcmbBaseRate, shockPct);
        if (cashVal !== null) fxCashTryDec = fxCashTryDec.plus(decimal(cashVal));
      }
    }

    const totalGrossDebtTryDec = tryGrossDebtDec.plus(fxGrossDebtTryDec);
    const totalAvailableCashTryDec = decimal(availableNowTry).plus(fxCashTryDec);
    const netDebtTry = roundMoneyNum(totalGrossDebtTryDec.minus(totalAvailableCashTryDec));

    const netDebtToEbitda: number | null =
      ebitdaTry === null || ebitdaTry <= 0
        ? null
        : Number(decimal(netDebtTry).div(decimal(ebitdaTry)).toFixed(4));

    return { netDebtTry, netDebtToEbitda, managementEbitdaTry: ebitdaTry };
  };

  const spotDscr = computeDscrAtShock(0);
  const spotLeverage = computeLeverageAtShock(0);

  const evaluateCovenantsForBand = (params: {
    postShockDscr: number | null;
    postShockNetDebtTry: number | null;
    postShockNetDebtToEbitda: number | null;
    postShockLiquidityBufferTry: number | null;
  }): FxShockCovenantImpact[] => {
    if (!baseline?.covenants || baseline.covenants.length === 0) return [];

    return baseline.covenants.map((cov) => {
      const ct = cov.covenantType.trim().toLowerCase();
      let baseMeasured: number | null = cov.baseMeasuredValue ?? null;
      let shockedMeasured: number | null = cov.baseMeasuredValue ?? null;

      if (ct === "dscr" || ct === "min_dscr") {
        baseMeasured = spotDscr.dscr ?? cov.baseMeasuredValue ?? null;
        shockedMeasured = params.postShockDscr;
      } else if (
        ct === "net_debt_to_ebitda" ||
        ct === "max_net_debt_to_ebitda" ||
        ct === "leverage"
      ) {
        baseMeasured = spotLeverage.netDebtToEbitda ?? cov.baseMeasuredValue ?? null;
        shockedMeasured = params.postShockNetDebtToEbitda;
      } else if (ct === "min_cash_balance" || ct === "liquidity") {
        baseMeasured = availableNowTry ?? cov.baseMeasuredValue ?? null;
        shockedMeasured = params.postShockLiquidityBufferTry;
      }

      const baseEval = evaluateCovenantThreshold({
        comparison: cov.comparison,
        thresholdValue: cov.thresholdValue,
        measuredValue: baseMeasured,
        status: cov.status,
        covenantType: ct,
        netDebt: spotLeverage.netDebtTry,
        managementEbitda: spotLeverage.managementEbitdaTry,
      });

      const shockedEval = evaluateCovenantThreshold({
        comparison: cov.comparison,
        thresholdValue: cov.thresholdValue,
        measuredValue: shockedMeasured,
        status: cov.status,
        covenantType: ct,
        netDebt: params.postShockNetDebtTry,
        managementEbitda: spotLeverage.managementEbitdaTry,
      });

      const crossedIntoBreach =
        isStressTestedCovenantType(ct) &&
        baseEval.state !== "breached" &&
        shockedEval.state === "breached";

      return {
        covenantId: cov.covenantId,
        subjectName: cov.subjectName,
        covenantType: cov.covenantType,
        description: cov.description ?? cov.covenantType,
        comparison: cov.comparison,
        thresholdValue: cov.thresholdValue,
        baseMeasuredValue: baseMeasured,
        baseState: baseEval.state,
        postShockMeasuredValue: shockedMeasured,
        postShockState: shockedEval.state,
        postShockHeadroomPct: shockedEval.headroomPct,
        postShockExplanation: shockedEval.explanation,
        crossedIntoBreach,
      };
    });
  };

  const shockBands: FxShockBandResult[] = FX_SHOCK_PCTS.map((shockPct) => {
    const perCurrency: FxShockCurrencyBreakdown[] = currencies.map((c) => {
      if (c.tcmbBaseRate === null) {
        return {
          currency: c.currency,
          baseRate: null,
          shockedRate: null,
          baseNetValueTry: null,
          shockedNetValueTry: null,
          shockDeltaTry: null,
          shockedNext12mDebtServiceTry: null,
        };
      }

      const factor = decimal(1).plus(decimal(shockPct).div(100));
      const shockedRate = rateOrNull(decimal(c.tcmbBaseRate).times(factor));
      const shockedNetValueTry =
        c.netNativePosition === null
          ? null
          : normalizeZero(stressValue(c.netNativePosition, c.tcmbBaseRate, shockPct)!);
      const shockDeltaTry = c.shockDeltasByBand[shockPct];
      const shockedNext12mDebtServiceTry =
        c.next12mDebtServiceNative > 0
          ? normalizeZero(stressValue(c.next12mDebtServiceNative, c.tcmbBaseRate, shockPct)!)
          : 0;

      return {
        currency: c.currency,
        baseRate: c.tcmbBaseRate,
        shockedRate,
        baseNetValueTry: c.baseNetValueTry,
        shockedNetValueTry,
        shockDeltaTry,
        shockedNext12mDebtServiceTry,
      };
    });

    let consolidatedPostShockNetTry: number | null = null;
    let netWorthShockDeltaTry: number | null = null;

    if (status === "no_fx_exposure") {
      consolidatedPostShockNetTry = 0;
      netWorthShockDeltaTry = 0;
    } else if (status === "ok") {
      let sumShockedDec = zero();
      let sumDeltaDec = zero();
      for (const row of perCurrency) {
        sumShockedDec = sumShockedDec.plus(decimal(row.shockedNetValueTry!));
        sumDeltaDec = sumDeltaDec.plus(decimal(row.shockDeltaTry!));
      }
      consolidatedPostShockNetTry = roundMoneyNum(sumShockedDec);
      netWorthShockDeltaTry = roundMoneyNum(sumDeltaDec);
    }

    const postShockLiquidityBufferTry: number | null =
      availableNowTry === null || netWorthShockDeltaTry === null
        ? null
        : roundMoneyNum(decimal(availableNowTry).plus(decimal(netWorthShockDeltaTry)));

    const dscrAtBand = computeDscrAtShock(shockPct);
    const leverageAtBand = computeLeverageAtShock(shockPct);

    const covenantEvaluations = evaluateCovenantsForBand({
      postShockDscr: dscrAtBand.dscr,
      postShockNetDebtTry: leverageAtBand.netDebtTry,
      postShockNetDebtToEbitda: leverageAtBand.netDebtToEbitda,
      postShockLiquidityBufferTry,
    });

    const breachedCovenantCount = covenantEvaluations.filter(
      (c) => c.postShockState === "breached",
    ).length;
    const newlyBreachedCovenantCount = covenantEvaluations.filter(
      (c) => c.crossedIntoBreach,
    ).length;

    return {
      shockPct,
      label: `+%${shockPct} TCMB Kur Şoku`,
      perCurrency,
      consolidatedPostShockNetTry,
      netWorthShockDeltaTry,
      consolidatedShockDeltaTry: netWorthShockDeltaTry,
      postShockLiquidityBufferTry,
      shockedFxNext12mDebtServiceTry: dscrAtBand.fxDebtServiceTry,
      postShockForward12mDscrWindow: dscrAtBand.window,
      postShockForward12mDscr: dscrAtBand.dscr,
      postShockNetDebtTry: leverageAtBand.netDebtTry,
      postShockNetDebtToEbitda: leverageAtBand.netDebtToEbitda,
      covenantEvaluations,
      breachedCovenantCount,
      newlyBreachedCovenantCount,
      covenantBreachTriggered: newlyBreachedCovenantCount > 0,
    };
  });

  return {
    asOfDate: input.asOfDate,
    status,
    shockBandsPct: FX_SHOCK_PCTS,
    hasUnknownCashOpening,
    hasUnknownFxCashOpening,
    hasUnknownTryCashOpening: hasUnknownTryCash,
    missingFxCurrencies,
    availableNowTry,
    currencies,
    consolidatedNetOpenTry,
    baseForward12mDscrWithSpotFx: spotDscr.dscr,
    shockBands,
  };
}

/**
 * Veritabanından yabancı para kasa/banka pozisyonlarını, açık döviz fatura/ödeme/çek/kredi
 * yükümlülüklerini, resmi TCMB kurlarını (`loadLatestRates`) ve kovenant/DSCR radarını
 * (`loadCovenantAndDscrRadar`) okuyarak kur şoku ve doğal hedge katmanını üretir.
 */
export async function loadFxStressOverlay(
  pool: Pool,
  options: {
    asOfDate?: string;
    dscrRadar?: CovenantAndDscrRadar | Promise<CovenantAndDscrRadar>;
  } = {},
): Promise<FxStressAndNaturalHedgeResult> {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const fwd12End = addDaysISO(asOfDate, 365);
  const client: Queryable = pool;

  const radarPromise = options.dscrRadar
    ? Promise.resolve(options.dscrRadar)
    : loadCovenantAndDscrRadar(pool, { asOfDate, currency: "TRY" });

  const [cashRes, invRes, piRes, checkRes, loanRes, facRes, latestRates, dscrRadar] =
    await Promise.all([
      client
        .query<{
          currency: string;
          account_count: number | string;
          unknown_opening_count: number | string;
          available_now: string | null;
        }>(
          `select
             upper(btrim(p.currency)) as currency,
             count(*)::int as account_count,
             count(*) filter (where not p.opening_known)::int as unknown_opening_count,
             case
               when count(*) filter (where not p.opening_known) > 0 then null::text
               else (coalesce(sum(p.derived_balance), 0) - sum(coalesce(p.blocked_balance, 0)))::numeric(14,2)::text
             end as available_now
           from public.bank_cash_position p
           where p.is_active
             and p.currency is not null
           group by upper(btrim(p.currency))
           order by 1`,
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string } | null)?.code;
          if (code === "42703") {
            return client
              .query<{
                currency: string;
                account_count: number | string;
                unknown_opening_count: number | string;
                available_now: string | null;
              }>(
                `select
                   upper(btrim(p.currency)) as currency,
                   count(*)::int as account_count,
                   count(*) filter (where p.derived_balance is null)::int as unknown_opening_count,
                   case
                     when count(*) filter (where p.derived_balance is null) > 0 then null::text
                     else (coalesce(sum(p.derived_balance), 0) - sum(coalesce(p.blocked_balance, 0)))::numeric(14,2)::text
                   end as available_now
                 from public.bank_cash_position p
                 where p.is_active
                   and p.currency is not null
                 group by upper(btrim(p.currency))
                 order by 1`,
              )
              .catch((e2: unknown) => {
                if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
                throw e2;
              });
          }
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      client
        .query<{
          currency: string;
          direction: string;
          remaining_amount: string;
        }>(
          `select
             upper(btrim(v.currency)) as currency,
             v.direction,
             coalesce(sum(
               greatest(
                 0,
                 coalesce(v.payable_amount, v.gross_amount)
                 - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
               )
             ), 0)::numeric(14,2)::text as remaining_amount
           from public.invoices v
           where v.status in ('open', 'partial')
             and v.bad_debt_at is null
             and v.currency is not null
             and upper(btrim(v.currency)) <> 'TRY'
             and coalesce(v.payable_amount, v.gross_amount) > greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))
             and not (
               v.settled_by_check_id is not null
               and exists (
                 select 1 from public.checks c0
                 where c0.id = v.settled_by_check_id
                   and c0.archived_at is null
                   and c0.status <> 'cancelled'
               )
             )
             and not exists (
               select 1
               from public.payment_instances pi2
               left join public.payments p2 on p2.id = pi2.payment_id
               where pi2.linked_invoice_id = v.id
                 and pi2.status <> 'cancelled'
                 and (p2.id is null or (p2.status = 'active' and p2.archived_at is null))
             )
             and not exists (
               select 1
               from public.checks c2
               where coalesce(c2.settled_invoice_id, c2.linked_invoice_id) = v.id
                 and c2.archived_at is null
                 and c2.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
                 and not exists (
                   select 1
                   from public.invoice_allocations ia
                   where ia.invoice_id = v.id
                     and ia.source_table = 'checks'
                     and ia.source_id = c2.id
                     and ia.reversed_at is null
                 )
             )
           group by upper(btrim(v.currency)), v.direction
           order by 1, 2`,
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string } | null)?.code;
          if (code === "42703") {
            return client
              .query<{
                currency: string;
                direction: string;
                remaining_amount: string;
              }>(
                `select
                   upper(btrim(v.currency)) as currency,
                   v.direction,
                   coalesce(sum(greatest(0, v.gross_amount - coalesce(v.allocated_amount, 0))), 0)::numeric(14,2)::text as remaining_amount
                 from public.invoices v
                 where v.status in ('open', 'partial')
                   and v.bad_debt_at is null
                   and v.currency is not null
                   and upper(btrim(v.currency)) <> 'TRY'
                   and v.gross_amount > coalesce(v.allocated_amount, 0)
                 group by upper(btrim(v.currency)), v.direction
                 order by 1, 2`,
              )
              .catch((e2: unknown) => {
                if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
                throw e2;
              });
          }
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      client
        .query<{
          currency: string;
          direction: string;
          remaining_amount: string;
        }>(
          `select
             upper(btrim(pi.currency)) as currency,
             coalesce(pi.direction, 'outflow') as direction,
             coalesce(sum(
               greatest(
                 0,
                 case
                   when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0)
                   else pi.amount
                 end
               )
             ), 0)::numeric(14,2)::text as remaining_amount
           from public.payment_instances pi
           left join public.payments p on p.id = pi.payment_id
           where pi.status in ('planned', 'unpaid', 'partial', 'late')
             and (p.id is null or (p.status = 'active' and p.archived_at is null))
             and coalesce(pi.direction, 'outflow') <> 'transfer'
             and pi.currency is not null
             and upper(btrim(pi.currency)) <> 'TRY'
             and pi.amount is not null
           group by upper(btrim(pi.currency)), coalesce(pi.direction, 'outflow')
           order by 1, 2`,
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string } | null)?.code;
          if (code === "42703") {
            return client
              .query<{
                currency: string;
                direction: string;
                remaining_amount: string;
              }>(
                `select
                   upper(btrim(pi.currency)) as currency,
                   'outflow'::text as direction,
                   coalesce(sum(greatest(0, pi.amount)), 0)::numeric(14,2)::text as remaining_amount
                 from public.payment_instances pi
                 where pi.status in ('planned', 'unpaid', 'partial', 'late')
                   and pi.currency is not null
                   and upper(btrim(pi.currency)) <> 'TRY'
                   and pi.amount is not null
                 group by upper(btrim(pi.currency))
                 order by 1`,
              )
              .catch((e2: unknown) => {
                if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
                throw e2;
              });
          }
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      client
        .query<{
          currency: string;
          direction: string;
          total_amount: string;
        }>(
          `select
             upper(btrim(c.currency)) as currency,
             c.direction,
             coalesce(sum(abs(c.amount)), 0)::numeric(14,2)::text as total_amount
           from public.checks c
           where c.archived_at is null
             and c.currency is not null
             and upper(btrim(c.currency)) <> 'TRY'
             and c.amount is not null
             and (
               (c.direction = 'inflow' and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral'))
               or (c.direction = 'outflow' and c.status in ('planned', 'issued_to_vendor'))
             )
           group by upper(btrim(c.currency)), c.direction
           order by 1, 2`,
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      client
        .query<{
          currency: string;
          total_remaining: string;
          principal_remaining: string;
          next12m_service: string;
        }>(
          `select
             upper(btrim(l.currency)) as currency,
             coalesce(sum(
               greatest(
                 0,
                 case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end
               )
             ), 0)::numeric(14,2)::text as total_remaining,
             coalesce(sum(
               greatest(
                 0,
                 case
                   when li.status = 'partial' then greatest(0, coalesce(li.principal_component, li.amount) - coalesce(li.paid_amount, 0))
                   else coalesce(li.principal_component, li.amount)
                 end
               )
             ), 0)::numeric(14,2)::text as principal_remaining,
             coalesce(sum(
               greatest(
                 0,
                 case when li.status = 'partial' then li.amount - coalesce(li.paid_amount, 0) else li.amount end
               )
             ) filter (where li.due_date > $1::date and li.due_date <= $2::date), 0)::numeric(14,2)::text as next12m_service
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
           where l.archived_at is null
             and coalesce(l.status, 'active') = 'active'
             and l.currency is not null
             and upper(btrim(l.currency)) <> 'TRY'
             and li.status in ('planned', 'unpaid', 'partial', 'late')
             and li.amount is not null
           group by upper(btrim(l.currency))
           order by 1`,
          [asOfDate, fwd12End],
        )
        .catch((err: unknown) => {
          const code = (err as { code?: string } | null)?.code;
          if (code === "42703") {
            return client
              .query<{
                currency: string;
                total_remaining: string;
                principal_remaining: string;
                next12m_service: string;
              }>(
                `select
                   upper(btrim(l.currency)) as currency,
                   coalesce(sum(greatest(0, li.amount)), 0)::numeric(14,2)::text as total_remaining,
                   coalesce(sum(greatest(0, li.amount)), 0)::numeric(14,2)::text as principal_remaining,
                   coalesce(sum(greatest(0, li.amount)) filter (where li.due_date > $1::date and li.due_date <= $2::date), 0)::numeric(14,2)::text as next12m_service
                 from public.loan_installments li
                 join public.loans l on l.id = li.loan_id
                 where l.archived_at is null
                   and l.currency is not null
                   and upper(btrim(l.currency)) <> 'TRY'
                   and li.status in ('planned', 'unpaid', 'partial', 'late')
                   and li.amount is not null
                 group by upper(btrim(l.currency))
                 order by 1`,
                [asOfDate, fwd12End],
              )
              .catch((e2: unknown) => {
                if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
                throw e2;
              });
          }
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      client
        .query<{
          currency: string;
          drawn_amount: string;
        }>(
          `select
             upper(btrim(u.currency)) as currency,
             coalesce(sum(u.drawn_amount), 0)::numeric(14,2)::text as drawn_amount
           from public.credit_facility_utilization u
           where u.status = 'active'
             and u.currency is not null
             and upper(btrim(u.currency)) <> 'TRY'
             and u.drawn_amount > 0
           group by upper(btrim(u.currency))
           order by 1`,
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        }),

      loadLatestRates(pool).catch((err: unknown) => {
        if (isMissingSchemaError(err)) return [];
        throw err;
      }),

      radarPromise,
    ]);

  // TRY kasa bakiyesi (FIN-03 uyumlu)
  const tryCashRow = cashRes.rows.find((r) => r.currency === "TRY");
  const tryUnknownCount = tryCashRow ? Number(tryCashRow.unknown_opening_count) : 0;
  const hasUnknownTryCashOpening =
    tryUnknownCount > 0 || dscrRadar.availableCash === null;
  const availableNowTry: number | null = hasUnknownTryCashOpening
    ? null
    : tryCashRow
      ? moneyOrNull(tryCashRow.available_now)
      : dscrRadar.availableCash;

  // Resmi TCMB kurları haritası (yalnızca quote_currency === 'TRY')
  const rateMap = new Map<string, { rate: number | null; rateDate: string | null }>();
  for (const r of latestRates) {
    if (String(r.quoteCurrency).toUpperCase() === "TRY" && r.rate !== null && r.rate > 0) {
      rateMap.set(String(r.baseCurrency).toUpperCase(), {
        rate: r.rate,
        rateDate: r.rateDate ?? null,
      });
    }
  }

  // Tüm aktif yabancı para kodlarını topla
  const fxCodes = new Set<string>();
  for (const r of cashRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);
  for (const r of invRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);
  for (const r of piRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);
  for (const r of checkRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);
  for (const r of loanRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);
  for (const r of facRes.rows) if (r.currency !== "TRY") fxCodes.add(r.currency);

  const exposures: FxCurrencyExposureInput[] = [];

  for (const code of fxCodes) {
    const cashRow = cashRes.rows.find((r) => r.currency === code);
    const fxUnknownCount = cashRow ? Number(cashRow.unknown_opening_count) : 0;
    const cashBalance: NumericInput =
      fxUnknownCount > 0 ? null : cashRow ? moneyOrNull(cashRow.available_now) : 0;

    let openReceivablesDec = zero();
    let openPayablesDec = zero();

    for (const r of invRes.rows) {
      if (r.currency !== code) continue;
      const amt = nonNegDecimal(r.remaining_amount);
      if (r.direction === "sales" || r.direction === "sale") {
        openReceivablesDec = openReceivablesDec.plus(amt);
      } else {
        openPayablesDec = openPayablesDec.plus(amt);
      }
    }

    for (const r of piRes.rows) {
      if (r.currency !== code) continue;
      const amt = nonNegDecimal(r.remaining_amount);
      if (r.direction === "inflow") {
        openReceivablesDec = openReceivablesDec.plus(amt);
      } else {
        openPayablesDec = openPayablesDec.plus(amt);
      }
    }

    let customerChecksDec = zero();
    let issuedChecksDec = zero();
    for (const r of checkRes.rows) {
      if (r.currency !== code) continue;
      const amt = nonNegDecimal(r.total_amount);
      if (r.direction === "inflow") {
        customerChecksDec = customerChecksDec.plus(amt);
      } else {
        issuedChecksDec = issuedChecksDec.plus(amt);
      }
    }

    const loanRow = loanRes.rows.find((r) => r.currency === code);
    const facRow = facRes.rows.find((r) => r.currency === code);
    const tcmb = rateMap.get(code);

    exposures.push({
      currency: code,
      cashBalance,
      hasUnknownCashOpening: fxUnknownCount > 0,
      openReceivables: openReceivablesDec,
      portfolioCustomerChecks: customerChecksDec,
      openPayables: openPayablesDec,
      loanPrincipalAndInterestRemaining: loanRow?.total_remaining ?? 0,
      loanPrincipalRemaining: loanRow?.principal_remaining ?? 0,
      facilityDrawn: facRow?.drawn_amount ?? 0,
      issuedChecks: issuedChecksDec,
      next12mDebtServiceNative: loanRow?.next12m_service ?? 0,
      tcmbBaseRate: tcmb?.rate ?? null,
      tcmbRateDate: tcmb?.rateDate ?? null,
    });
  }

  const fwd12 = dscrRadar.dscrWindows.forward12m;
  const tryInstallments =
    fwd12.totalDebtService > 0
      ? [
          {
            amount: fwd12.totalDebtService,
            principalComponent: fwd12.principalComponent,
            interestComponent: fwd12.interestComponent,
            taxComponentBsmvKkdf: fwd12.taxComponentBsmvKkdf,
          },
        ]
      : [];

  return computeFxStressAndNaturalHedge({
    asOfDate,
    availableNowTry,
    hasUnknownTryCashOpening,
    exposures,
    dscrBaseline: {
      periodStart: fwd12.periodStart,
      periodEnd: fwd12.periodEnd,
      tryOperationalInflows: fwd12.operationalInflows,
      tryOperationalOutflowsBeforeDebtService: fwd12.operationalOutflowsBeforeDebtService,
      tryInstallments,
      tryLoanPrincipalRemaining: dscrRadar.totalLoanPrincipalRemaining,
      tryFacilityDrawn: dscrRadar.totalFacilityDrawn,
      managementEbitdaTry: dscrRadar.managementEbitda,
      covenants: dscrRadar.covenants.map((c) => ({
        covenantId: c.covenantId,
        subjectName: c.subjectName,
        covenantType: c.covenantType,
        description: c.description,
        comparison: c.comparison,
        thresholdValue: c.thresholdValue,
        status: c.state === "waived" ? "waived" : "active",
        baseMeasuredValue: c.measuredValue,
      })),
      extraUnknownCount: fwd12.unknownComponentCount,
    },
  });
}
