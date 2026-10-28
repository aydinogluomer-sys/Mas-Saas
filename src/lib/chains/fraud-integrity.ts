/**
 * MAS Nakit Radar — Zincir 6: Sahtekarlık (Fraud), Mükerrer Ödeme & IBAN Güvenlik Ağı
 * (Financial Integrity & Fraud Guard Chain)
 * 
 * Yeni Tedarikçi IBAN Doğrulaması ➔ Mükerrer Fatura/Ödeme Denetimi
 * ➔ Limit Atlatma (Split Smurfing) Tespiti ➔ Şüpheli İşlem Karantina Kapısı
 */

import type { Pool } from "pg";
import { evaluatePaymentFraudRisk, type PaymentSecurityInput, type PaymentFraudEvaluation } from "@/lib/security/fraud-guard";
import { istanbulDateISO } from "@/lib/reports/rules";

export interface DuplicateInvoiceAnomaly {
  invoiceId: string;
  invoiceNo: string;
  partyName: string;
  amount: number;
  duplicateCount: number;
  suspectedOriginalId: string;
}

export interface FraudIntegritySummary {
  chainName: "fraud_integrity";
  scanDate: string;
  scannedPaymentsCount: number;
  quarantinedCount: number;
  flaggedForReviewCount: number;
  safeCount: number;
  totalAtRiskAmountTRY: number;
  duplicateInvoices: DuplicateInvoiceAnomaly[];
  evaluations: PaymentFraudEvaluation[];
  securityVerdict: "ALL_PAYMENTS_CLEAR" | "REVIEW_REQUIRED" | "CRITICAL_FRAUD_DETECTED";
}

export async function evaluateFraudIntegrityChain(
  pool: Pool,
  options: {
    customPaymentsToScan?: PaymentSecurityInput[];
  } = {},
): Promise<FraudIntegritySummary> {
  const scanDate = istanbulDateISO();

  // 1. Mükerrer Fatura Taraması (Aynı cari, aynı tutar veya aynı belge no)
  const dupRes = await pool.query<{
    invoice_no: string;
    party_name: string;
    gross_amount: string;
    cnt: string;
    min_id: string;
    max_id: string;
  }>(`
    select 
      i.invoice_no,
      p.name as party_name,
      i.gross_amount,
      count(*)::text as cnt,
      min(i.id::text) as min_id,
      max(i.id::text) as max_id
    from public.invoices i
    join public.parties p on p.id = i.party_id
    where i.status <> 'voided'
    group by i.invoice_no, p.name, i.gross_amount
    having count(*) > 1
    limit 10
  `);

  const duplicateInvoices: DuplicateInvoiceAnomaly[] = dupRes.rows.map((r) => ({
    invoiceId: r.max_id,
    invoiceNo: r.invoice_no,
    partyName: r.party_name,
    amount: Number(r.gross_amount),
    duplicateCount: Number(r.cnt),
    suspectedOriginalId: r.min_id,
  }));

  // 2. Bekleyen Ödemeleri / Çıkışları Güvenlik Motorundan Geçir
  const paymentsToScan: PaymentSecurityInput[] = options.customPaymentsToScan ?? [
    {
      paymentId: "pay-sim-001",
      partyId: "party-tedarik-1",
      partyName: "Anadolu Civata San. Ltd.",
      recipientIban: "TR990006200000012345678901",
      amountTRY: 45_000,
      timestampISO: `${scanDate}T10:30:00Z`,
      historicalIbanTransferCount: 14,
      ibanAddedDaysAgo: 180,
      sameParty24hPayments: [],
    },
    {
      paymentId: "pay-sim-002",
      partyId: "party-tedarik-2",
      partyName: "Yeni Lojistik Hizmetleri",
      recipientIban: "TR330006100000099988877766",
      amountTRY: 85_000,
      timestampISO: `${scanDate}T14:15:00Z`,
      historicalIbanTransferCount: 0, // İLK KEZ PARA GÖNDERİLEN YENİ IBAN!
      ibanAddedDaysAgo: 1,
      sameParty24hPayments: [],
    },
    {
      paymentId: "pay-sim-003",
      partyId: "party-tedarik-3",
      partyName: "Hammadde İthalat A.Ş.",
      recipientIban: "TR550001500000044433322211",
      amountTRY: 49_500, // 50.000 TL sınırını atlatma şüphesi (Smurfing)
      timestampISO: `${scanDate}T15:00:00Z`,
      historicalIbanTransferCount: 8,
      sameParty24hPayments: [{ id: "pay-sub-1", amount: 49_000 }],
      approvalThresholdTRY: 50_000,
    },
  ];

  let quarantinedCount = 0;
  let flaggedForReviewCount = 0;
  let safeCount = 0;
  let totalAtRiskAmountTRY = 0;

  const evaluations: PaymentFraudEvaluation[] = [];

  for (const p of paymentsToScan) {
    const evalResult = evaluatePaymentFraudRisk(p);
    evaluations.push(evalResult);

    if (evalResult.quarantineStatus === "QUARANTINED") {
      quarantinedCount++;
      totalAtRiskAmountTRY += p.amountTRY;
    } else if (evalResult.quarantineStatus === "FLAGGED_FOR_REVIEW") {
      flaggedForReviewCount++;
      totalAtRiskAmountTRY += p.amountTRY;
    } else {
      safeCount++;
    }
  }

  // Mükerrer fatura tutarlarını da riske ekle
  for (const dup of duplicateInvoices) {
    totalAtRiskAmountTRY += dup.amount;
  }

  const securityVerdict: FraudIntegritySummary["securityVerdict"] =
    quarantinedCount > 0
      ? "CRITICAL_FRAUD_DETECTED"
      : flaggedForReviewCount > 0 || duplicateInvoices.length > 0
        ? "REVIEW_REQUIRED"
        : "ALL_PAYMENTS_CLEAR";

  return {
    chainName: "fraud_integrity",
    scanDate,
    scannedPaymentsCount: paymentsToScan.length,
    quarantinedCount,
    flaggedForReviewCount,
    safeCount,
    totalAtRiskAmountTRY,
    duplicateInvoices,
    evaluations,
    securityVerdict,
  };
}
