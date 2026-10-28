// Faz 3 — CFO Risk & Simülasyon: Dinamik İskonto & Erken Ödeme Arbitraj Motoru
// (Dynamic Discounting & Early Payment Arbitrage Engine)
//
// Tedarikçilerin sunduğu veya müşterilere önerilen erken ödeme iskontolarını (Örn: 2/10 net 45),
// şirketin alternatif borçlanma/fonlama maliyeti (TLREF/Kredi faizi) ile karşılaştırarak
// yıllıklandırılmış getiri oranını (APR) ve net TL arbitraj kazancını hesaplar.
//
// Formüller:
//   Kazandırılan Gün (Days Saved) = Vade Tarihi - Erken Ödeme Tarihi
//   Bileşik Yıllık Getiri (APR %)  = (İskonto % / (100 - İskonto %)) * (365 / Days Saved) * 100
//   Net Spread %                  = APR % - Borçlanma/Fırsat Maliyeti %
//   Net Finansal Arbitraj (TL)    = İskonto Tutarı - (Fatura Tutarı * Fonlama Maliyeti * Days Saved / 365)

import type { Pool } from "pg";
import { daysBetween } from "@/lib/treasury/rules";
import { loadPositionSummary } from "@/lib/treasury/engine";

export type ArbitrageDecision =
  | "PAY_EARLY"         // Erken öde: Net arbitraj kazancı pozitif ve nakit müsait
  | "PAY_ON_DUE_DATE"   // Vadesinde öde: İskonto getirisi borçlanma maliyetini karşılamıyor
  | "HOLD_LIQUIDITY";   // Nakit koruma: Arbitraj kazançlı olsa bile kasa tabanı kısıtlı

export interface EarlyDiscountOffer {
  invoiceId: string;
  invoiceNo?: string;
  counterpartyName: string;
  invoiceAmount: number;
  originalDueDate: string;       // YYYY-MM-DD
  earlyPaymentDate: string;      // YYYY-MM-DD
  discountPercent: number;       // Örn: %2.5 için 2.5
}

export interface ArbitrageAnalysisResult {
  invoiceId: string;
  counterpartyName: string;
  invoiceAmount: number;
  discountPercent: number;
  discountAmountTL: number;
  paymentAmountTL: number;
  daysSaved: number;
  annualizedReturnAPR: number;   // Yıllık getiri oranı %
  borrowingCostAnnual: number;   // Karşılaştırma fonlama maliyeti %
  netSpreadAnnual: number;       // APR - Fonlama Maliyeti %
  netArbitrageProfitTL: number;  // Şirketin net cepte kalan kârı (TL)
  decision: ArbitrageDecision;
  decisionReason: string;
}

export interface BatchDiscountOptimizationReport {
  analyzedOffersCount: number;
  recommendedEarlyPaymentsCount: number;
  totalCashOutflowRequired: number;
  totalGrossDiscountEarned: number;
  totalNetArbitrageProfit: number;
  averageAnnualizedAPR: number;
  results: ArbitrageAnalysisResult[];
}

/**
 * Tek bir fatura için erken ödeme iskonto arbitrajını analiz eder (Pure function).
 */
export function analyzeDiscountArbitrage(
  offer: EarlyDiscountOffer,
  options: {
    borrowingCostAnnual: number; // Şirketin yıllık borçlanma faizi % (Örn: %45)
    availableCashTRY: number;    // Mevcut serbest nakit
    minCashFloorTRY: number;     // Dokunulmaz asgari kasa tabanı
  },
): ArbitrageAnalysisResult {
  const { borrowingCostAnnual, availableCashTRY, minCashFloorTRY } = options;

  const daysSaved = Math.max(1, daysBetween(offer.earlyPaymentDate, offer.originalDueDate));
  const discountRate = offer.discountPercent / 100;
  const discountAmountTL = Math.round(offer.invoiceAmount * discountRate * 100) / 100;
  const paymentAmountTL = Math.round((offer.invoiceAmount - discountAmountTL) * 100) / 100;

  // APR Formülü: (d / (1 - d)) * (365 / days) * 100
  const apr = Number((((discountRate / (1 - discountRate)) * (365 / daysSaved)) * 100).toFixed(2));
  const netSpread = Number((apr - borrowingCostAnnual).toFixed(2));

  // Fonlama maliyeti (erken ödenen gün sayısı boyunca taşınma maliyeti)
  const fundingCostTL = Math.round((paymentAmountTL * (borrowingCostAnnual / 100) * (daysSaved / 365)) * 100) / 100;
  const netArbitrageProfitTL = Math.round((discountAmountTL - fundingCostTL) * 100) / 100;

  const usableCash = Math.max(0, availableCashTRY - minCashFloorTRY);

  let decision: ArbitrageDecision = "PAY_ON_DUE_DATE";
  let decisionReason = "";

  if (usableCash < paymentAmountTL) {
    decision = "HOLD_LIQUIDITY";
    decisionReason = `Nakit kısıtı: Serbest likidite (₺${usableCash.toLocaleString("tr-TR")}) ödeme tutarından (₺${paymentAmountTL.toLocaleString("tr-TR")}) düşük. Kasa tabanını korumak için erken ödeme önerilmez.`;
  } else if (netSpread > 0 && netArbitrageProfitTL > 0) {
    decision = "PAY_EARLY";
    decisionReason = `FIRSAT: %${apr.toFixed(1)} yıllıklandırılmış getiri (Şirket borçlanma maliyeti %${borrowingCostAnnual}'den %${netSpread.toFixed(1)} daha karlı). Net finansal kazanç: ₺${netArbitrageProfitTL.toLocaleString("tr-TR")}.`;
  } else {
    decision = "PAY_ON_DUE_DATE";
    decisionReason = `VADESİNDE ÖDE: İskonto getirisi (%${apr.toFixed(1)} APR), şirketin fonlama/mevduat maliyetinin (%${borrowingCostAnnual}) altında kalıyor. Vadede ödemek daha kârlı.`;
  }

  return {
    invoiceId: offer.invoiceId,
    counterpartyName: offer.counterpartyName,
    invoiceAmount: offer.invoiceAmount,
    discountPercent: offer.discountPercent,
    discountAmountTL,
    paymentAmountTL,
    daysSaved,
    annualizedReturnAPR: apr,
    borrowingCostAnnual,
    netSpreadAnnual: netSpread,
    netArbitrageProfitTL,
    decision,
    decisionReason,
  };
}

/**
 * Açık satın alma faturaları arasından erken ödeme tekliflerini veya potansiyel
 * iskonto fırsatlarını toplu optimize eder.
 */
export async function optimizePayablesDiscounts(
  pool: Pool,
  offers: EarlyDiscountOffer[],
  borrowingCostAnnual = 42.0, // Default TLREF + Spread
): Promise<BatchDiscountOptimizationReport> {
  const positions = await loadPositionSummary(pool);
  const tryPos = positions.find((p) => p.currency === "TRY") ?? positions[0];
  const availableCash = tryPos?.availableNow ?? 0;
  const minFloor = 200000; // Standart güvenlik tabanı

  let cashPool = availableCash;
  const results: ArbitrageAnalysisResult[] = [];

  // En yüksek APR getirisi sunan tekliften başlayarak sırala (Greedy optimization)
  const preEvaluated = offers.map((offer) => {
    const daysSaved = Math.max(1, daysBetween(offer.earlyPaymentDate, offer.originalDueDate));
    const dRate = offer.discountPercent / 100;
    const apr = ((dRate / (1 - dRate)) * (365 / daysSaved)) * 100;
    return { offer, estimatedAPR: apr };
  });

  preEvaluated.sort((a, b) => b.estimatedAPR - a.estimatedAPR);

  for (const item of preEvaluated) {
    const analysis = analyzeDiscountArbitrage(item.offer, {
      borrowingCostAnnual,
      availableCashTRY: cashPool,
      minCashFloorTRY: minFloor,
    });

    if (analysis.decision === "PAY_EARLY") {
      cashPool -= analysis.paymentAmountTL;
    }

    results.push(analysis);
  }

  const earlyPayments = results.filter((r) => r.decision === "PAY_EARLY");
  const totalOutflow = earlyPayments.reduce((sum, r) => sum + r.paymentAmountTL, 0);
  const totalGrossDiscount = earlyPayments.reduce((sum, r) => sum + r.discountAmountTL, 0);
  const totalNetArbitrage = earlyPayments.reduce((sum, r) => sum + r.netArbitrageProfitTL, 0);
  const avgAPR = earlyPayments.length > 0
    ? Number((earlyPayments.reduce((sum, r) => sum + r.annualizedReturnAPR, 0) / earlyPayments.length).toFixed(2))
    : 0;

  return {
    analyzedOffersCount: offers.length,
    recommendedEarlyPaymentsCount: earlyPayments.length,
    totalCashOutflowRequired: Math.round(totalOutflow * 100) / 100,
    totalGrossDiscountEarned: Math.round(totalGrossDiscount * 100) / 100,
    totalNetArbitrageProfit: Math.round(totalNetArbitrage * 100) / 100,
    averageAnnualizedAPR: avgAPR,
    results,
  };
}
