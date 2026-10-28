/**
 * MAS Nakit Radar — Bütünleşik Finansal Sinir Sistemi (Unified Financial Nervous System)
 * 
 * 8 Temel İhtiyaç Tabanlı Zinciri Tek Çatı Altında Birleştiren Orkestratör:
 * 1. Order-to-Cash & DSO (Gelir Zinciri)
 * 2. Procure-to-Pay & Bütçe Bariyeri (Gider & Likidite Kalkanı)
 * 3. Treasury & Kredi Tesisleri (Hazine & Çek Portföyü Optimizasyonu)
 * 4. FX Defense (Kur Riski & Doğal Hedge Kalkanı)
 * 5. Statutory Defense (Vergi/SGK Takvimi & Kasa Emniyet Blokajı)
 * 6. Fraud Integrity (Sahtekarlık & Mükerrer Ödeme Güvenlik Ağı)
 * 7. Cash-Unit Economics (Üretim-Birim Nakit Kârlılığı)
 * 8. Executive Hub (Sabah 08:30 Brifingi & Mobil Karar Merkezi)
 */

import type { Pool } from "pg";
import { evaluateOrderToCashChain, type OrderToCashSummary } from "./order-to-cash";
import { evaluateProcureToPayChain, type ProcureToPaySummary } from "./procure-to-pay";
import { evaluateTreasuryOptimizationChain, type TreasuryOptimizationSummary } from "./treasury-optimization";
import { evaluateFxDefenseChain, type FxDefenseSummary } from "./fx-defense";
import { evaluateStatutoryDefenseChain, type StatutoryDefenseSummary } from "./statutory-defense";
import { evaluateFraudIntegrityChain, type FraudIntegritySummary } from "./fraud-integrity";
import { evaluateCashUnitEconomicsChain, type CashUnitEconomicsSummary } from "./cash-unit-economics";
import { evaluateExecutiveHubChain, type ExecutiveHubSummary } from "./executive-hub";
import { istanbulDateISO } from "@/lib/reports/rules";

export * from "./order-to-cash";
export * from "./procure-to-pay";
export * from "./treasury-optimization";
export * from "./fx-defense";
export * from "./statutory-defense";
export * from "./fraud-integrity";
export * from "./cash-unit-economics";
export * from "./executive-hub";

export interface NervousSystemAlert {
  id: string;
  chain: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  recommendedAction: string;
}

export interface FinancialNervousSystemReport {
  timestamp: string;
  scanDate: string;
  durationMs: number;
  overallHealthScore: number; // 0 - 100
  healthStatus: "EXCELLENT" | "STABLE" | "ATTENTION_REQUIRED" | "CRITICAL_RISK";
  activeAlertsCount: number;
  alerts: NervousSystemAlert[];
  chains: {
    orderToCash: OrderToCashSummary;
    procureToPay: ProcureToPaySummary;
    treasuryOptimization: TreasuryOptimizationSummary;
    fxDefense: FxDefenseSummary;
    statutoryDefense: StatutoryDefenseSummary;
    fraudIntegrity: FraudIntegritySummary;
    cashUnitEconomics: CashUnitEconomicsSummary;
    executiveHub: ExecutiveHubSummary;
  };
}

/**
 * 8 Finansal Zinciri tek seferde paralel olarak değerlendirir ve
 * şirketin genel finansal nabzını, kalkanlarını ve öncelikli aksiyonlarını üretir.
 */
export async function runFinancialNervousSystemCheck(
  pool: Pool,
  options: {
    borrowingCostAnnual?: number;
    currentCashBalanceTRY?: number;
    safetyBufferTRY?: number;
  } = {},
): Promise<FinancialNervousSystemReport> {
  const start = Date.now();
  const scanDate = istanbulDateISO();

  // Tüm 8 zinciri paralel olarak çalıştır
  const [
    orderToCash,
    procureToPay,
    treasuryOptimization,
    fxDefense,
    statutoryDefense,
    fraudIntegrity,
    cashUnitEconomics,
    executiveHub,
  ] = await Promise.all([
    evaluateOrderToCashChain(pool, { companyBorrowingRateAnnual: options.borrowingCostAnnual }),
    evaluateProcureToPayChain(pool, { currentCashBalanceTRY: options.currentCashBalanceTRY, safetyBufferTRY: options.safetyBufferTRY }),
    evaluateTreasuryOptimizationChain(pool),
    evaluateFxDefenseChain(pool),
    evaluateStatutoryDefenseChain(pool, { currentBankBalanceTRY: options.currentCashBalanceTRY }),
    evaluateFraudIntegrityChain(pool),
    evaluateCashUnitEconomicsChain(pool, { annualFinancingCostPercent: options.borrowingCostAnnual }),
    evaluateExecutiveHubChain(pool),
  ]);

  const alerts: NervousSystemAlert[] = [];
  let scoreDeductions = 0;

  // 1. Order-to-Cash Uyarıları
  if (orderToCash.overdueReceivablesTRY > 200_000) {
    alerts.push({
      id: "al-otc-1",
      chain: "order_to_cash",
      severity: "warning",
      title: "Gecikmiş Alacak Hacmi Yüksek",
      detail: `${orderToCash.overdueReceivablesTRY.toLocaleString("tr-TR")} ₺ vadesi geçmiş tahsilat bekliyor.`,
      recommendedAction: "Cari riskli müşterilere dinamik iskonto veya ödeme sözü hatırlatması gönderin.",
    });
    scoreDeductions += 10;
  }

  // 2. Procure-to-Pay Uyarıları
  if (procureToPay.cashDeficitAlertsCount > 0) {
    alerts.push({
      id: "al-p2p-1",
      chain: "procure_to_pay",
      severity: "critical",
      title: "Harcamalar Kasa Tamponunu Tehdit Ediyor",
      detail: `${procureToPay.cashDeficitAlertsCount} tedarikçi faturası ödendiğinde kasa tamponu eksiye düşüyor.`,
      recommendedAction: "Fatura vadelerini 15 gün öteleyin veya vadeli çek teklif edin.",
    });
    scoreDeductions += 15;
  }

  // 3. Treasury Uyarıları
  if (treasuryOptimization.riskyChecksCount > 0) {
    alerts.push({
      id: "al-try-1",
      chain: "treasury_optimization",
      severity: "warning",
      title: "Riskli Müşteri Çekleri Portföyde",
      detail: `${treasuryOptimization.riskyChecksCount} adet çek (${treasuryOptimization.riskyChecksVolumeTRY.toLocaleString("tr-TR")} ₺) istihbaratı zayıf müşterilere ait.`,
      recommendedAction: "Çekleri derhal banka teminatına veya faktoringe vererek nakde çevirin.",
    });
    scoreDeductions += 8;
  }

  // 4. FX Defense Uyarıları
  if (fxDefense.overallVerdict === "HIGH_FX_RISK") {
    alerts.push({
      id: "al-fxd-1",
      chain: "fx_defense",
      severity: "critical",
      title: "Yüksek Açık Döviz Pozisyonu",
      detail: `%20 kur şokunda potansiyel kur zararı: ${fxDefense.totalShock20PctRiskTRY.toLocaleString("tr-TR")} ₺.`,
      recommendedAction: "Doğal koruma dışındaki açık pozisyon için forward sözleşmesi yapın.",
    });
    scoreDeductions += 15;
  }

  // 5. Statutory Defense Uyarıları
  if (statutoryDefense.isReserveCompromised) {
    alerts.push({
      id: "al-std-1",
      chain: "statutory_defense",
      severity: "critical",
      title: "Yasal Vergi / Maaş Rezervi Açığı",
      detail: `Kasa bakiyesi zorunlu vergi/SGK/maaş toplamına yetmiyor. Açık: ${statutoryDefense.compromiseDeficitTRY.toLocaleString("tr-TR")} ₺.`,
      recommendedAction: "Keyfi ödemeleri derhal durdurun; tahsilatları öne çekin.",
    });
    scoreDeductions += 25;
  }

  // 6. Fraud Integrity Uyarıları
  if (fraudIntegrity.securityVerdict === "CRITICAL_FRAUD_DETECTED") {
    alerts.push({
      id: "al-frd-1",
      chain: "fraud_integrity",
      severity: "critical",
      title: "Dolandırıcılık Şüphesi — Ödemeler Karantinada",
      detail: `${fraudIntegrity.quarantinedCount} adet ödeme şüpheli IBAN / manipülasyon nedeniyle donduruldu.`,
      recommendedAction: "Tedarikçi yetkilisiyle telefon teyidi yapmadan karantinayı kaldırmayın.",
    });
    scoreDeductions += 20;
  }

  // 7. Cash-Unit Economics Uyarıları
  if (cashUnitEconomics.cashDrainersCount > 0) {
    alerts.push({
      id: "al-cue-1",
      chain: "cash_unit_economics",
      severity: "info",
      title: "Sermaye Yutan Ürün Siparişleri",
      detail: `${cashUnitEconomics.cashDrainersCount} ürün grubu uzun vadeli satış nedeniyle kârını finansman faizine kaptırıyor.`,
      recommendedAction: "Satış vadelerini maksimum 45 gün ile sınırlandırın.",
    });
    scoreDeductions += 5;
  }

  const overallHealthScore = Math.max(10, Math.min(100, 100 - scoreDeductions));
  const healthStatus: FinancialNervousSystemReport["healthStatus"] =
    overallHealthScore >= 85
      ? "EXCELLENT"
      : overallHealthScore >= 70
        ? "STABLE"
        : overallHealthScore >= 50
          ? "ATTENTION_REQUIRED"
          : "CRITICAL_RISK";

  return {
    timestamp: new Date().toISOString(),
    scanDate,
    durationMs: Date.now() - start,
    overallHealthScore,
    healthStatus,
    activeAlertsCount: alerts.length,
    alerts,
    chains: {
      orderToCash,
      procureToPay,
      treasuryOptimization,
      fxDefense,
      statutoryDefense,
      fraudIntegrity,
      cashUnitEconomics,
      executiveHub,
    },
  };
}
