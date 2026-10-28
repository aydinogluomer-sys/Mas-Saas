// Faz 5 — Kurumsal Güvenlik: Dolandırıcılık & Oltalama Önleme / Karantina
// (Fraud & Phishing Guard Engine)
//
// Şirket banka ödemelerinde sahte fatura, tedarikçi e-posta hacklenmesi (VEC) ve
// limit atlatma (smurfing) dolandırıcılıklarını engeller.
//
// Tespit Edilen Riskler:
//   1. FIRST_TIME_IBAN: Tedarikçiye daha önce HİÇ para transferi yapılmamış yeni IBAN.
//   2. SPLIT_TRANSACTION: Onay limitini (Örn: 50.000 TL) atlatmak için aynı gün parçalanmış ödemeler.
//   3. OFF_HOURS_HIGH_VALUE: Hafta sonu veya gece (22:00 - 06:00) yüksek tutarlı çıkış denemesi.
//   4. VELOCITY_SPIKE: Aynı cariye 1 saat içinde alışılmışın dışında işlem sıklığı.
//
// Kritik şüphede işlemi derhal QUARANTINE (Karantina) durumuna alır ve bankaya gönderimi kilitler.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { invalidateTags } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

export type FraudRiskLevel = "SAFE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type QuarantineStatus = "CLEARED" | "FLAGGED_FOR_REVIEW" | "QUARANTINED";

export interface FraudAnomaly {
  code: "FIRST_TIME_IBAN" | "SPLIT_TRANSACTION" | "OFF_HOURS_HIGH_VALUE" | "VELOCITY_SPIKE";
  severity: "warning" | "critical";
  description: string;
  evidence: Record<string, unknown>;
}

export interface PaymentFraudEvaluation {
  paymentId: string;
  partyId: string;
  partyName: string;
  recipientIban: string;
  amountTRY: number;
  timestamp: string;
  riskScore: number; // 0 - 100
  riskLevel: FraudRiskLevel;
  quarantineStatus: QuarantineStatus;
  detectedAnomalies: FraudAnomaly[];
  recommendation: string;
}

export interface PaymentSecurityInput {
  paymentId: string;
  partyId: string;
  partyName: string;
  recipientIban: string;
  amountTRY: number;
  timestampISO: string;
  // Geçmiş veriler (Mock veya DB sorgusundan gelir)
  historicalIbanTransferCount: number;
  ibanAddedDaysAgo?: number;
  sameParty24hPayments: Array<{ id: string; amount: number }>;
  approvalThresholdTRY?: number;
}

/**
 * Bir ödeme talebini dolandırıcılık ve manipülasyon kurallarına göre inceler (Pure function).
 */
export function evaluatePaymentFraudRisk(input: PaymentSecurityInput): PaymentFraudEvaluation {
  const anomalies: FraudAnomaly[] = [];
  let score = 0;

  const threshold = input.approvalThresholdTRY ?? 50000;

  // 1. FIRST_TIME_IBAN KONTROLÜ
  // Eğer bu IBAN'a daha önce hiç ödeme yapılmamışsa veya IBAN son 7 günde değiştirilmişse
  if (input.historicalIbanTransferCount === 0 || (input.ibanAddedDaysAgo != null && input.ibanAddedDaysAgo < 7)) {
    score += 45;
    anomalies.push({
      code: "FIRST_TIME_IBAN",
      severity: input.amountTRY > 25000 ? "critical" : "warning",
      description: `Bilinmeyen veya Yeni IBAN: ${input.partyName} carisine bu IBAN (${input.recipientIban}) üzerinden daha önce hiç ödeme yapılmamış.`,
      evidence: {
        historicalTransfers: input.historicalIbanTransferCount,
        ibanAgeDays: input.ibanAddedDaysAgo,
      },
    });
  }

  // 2. SPLIT TRANSACTION / SMURFING KONTROLÜ
  // Onay limitinin hemen altında (Örn: 50.000 TL limit için 40.000 - 49.999 TL arası)
  // ve son 24 saatte aynı cariye başka benzer ödeme varsa
  const nearThreshold = input.amountTRY >= threshold * 0.75 && input.amountTRY < threshold;
  const recentSamePartyTotal = input.sameParty24hPayments.reduce((s, p) => s + p.amount, 0);

  if (nearThreshold && (input.sameParty24hPayments.length >= 1 || recentSamePartyTotal + input.amountTRY >= threshold)) {
    score += 40;
    anomalies.push({
      code: "SPLIT_TRANSACTION",
      severity: "critical",
      description: `Onay Limiti Atlatma (Smurfing) Şüphesi: Tutar (₺${input.amountTRY.toLocaleString("tr-TR")}) limitin (₺${threshold.toLocaleString("tr-TR")}) hemen altında ve 24 saat içinde aynı cariye ₺${recentSamePartyTotal.toLocaleString("tr-TR")} tutarında başka işlemler var.`,
      evidence: {
        paymentAmount: input.amountTRY,
        approvalLimit: threshold,
        recent24hCount: input.sameParty24hPayments.length,
        recent24hTotal: recentSamePartyTotal,
      },
    });
  }

  // 3. OFF_HOURS_HIGH_VALUE KONTROLÜ
  // Saat 22:00 - 06:00 arası veya hafta sonu başlatılan >100.000 TL transferler
  const dateObj = new Date(input.timestampISO);
  const hour = dateObj.getUTCHours() + 3; // Istanbul UTC+3
  const normalizedHour = hour >= 24 ? hour - 24 : hour;
  const dayOfWeek = dateObj.getUTCDay(); // 0: Pazar, 6: Cumartesi
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isNight = normalizedHour >= 22 || normalizedHour < 6;

  if ((isWeekend || isNight) && input.amountTRY >= 100000) {
    score += 25;
    anomalies.push({
      code: "OFF_HOURS_HIGH_VALUE",
      severity: "warning",
      description: `Mesai Dışı / Hafta Sonu Yüksek Tutar: Saat ${normalizedHour}:00'de mesai dışı ₺${input.amountTRY.toLocaleString("tr-TR")} tutarında transfer girişimi.`,
      evidence: { hour: normalizedHour, isWeekend, amount: input.amountTRY },
    });
  }

  // 4. VELOCITY SPIKE
  if (input.sameParty24hPayments.length >= 4) {
    score += 20;
    anomalies.push({
      code: "VELOCITY_SPIKE",
      severity: "warning",
      description: `Anormal Transfer Hızı: Aynı cariye 24 saat içinde ${input.sameParty24hPayments.length + 1}. transfer talebi oluşturuldu.`,
      evidence: { count: input.sameParty24hPayments.length + 1 },
    });
  }

  // Skor normalizasyonu
  score = Math.min(100, score);

  let riskLevel: FraudRiskLevel = "SAFE";
  let quarantineStatus: QuarantineStatus = "CLEARED";
  let recommendation = "İşlem güvenli; transfer akışına devam edilebilir.";

  if (score >= 60 || anomalies.some((a) => a.severity === "critical")) {
    riskLevel = "CRITICAL";
    quarantineStatus = "QUARANTINED";
    recommendation = "🚨 İŞLEM KARANTİNAYA ALINDI: Güvenlik / Oltalama şüphesi nedeniyle otomatik banka gönderimi kilitlendi. Tedarikçi yetkilisi telefonla aranıp IBAN doğrulanmadan onay verilemez.";
  } else if (score >= 30) {
    riskLevel = "MEDIUM";
    quarantineStatus = "FLAGGED_FOR_REVIEW";
    recommendation = "⚠️ İNCELEME GEREKLİ: Şüpheli sinyaller mevcut. Ödeme onaylayıcısının dikkatine sunulmalı.";
  }

  return {
    paymentId: input.paymentId,
    partyId: input.partyId,
    partyName: input.partyName,
    recipientIban: input.recipientIban,
    amountTRY: input.amountTRY,
    timestamp: input.timestampISO,
    riskScore: score,
    riskLevel,
    quarantineStatus,
    detectedAnomalies: anomalies,
    recommendation,
  };
}

/**
 * Canlı veritabanındaki bir ödeme kaydını FraudGuard süzgecinden geçirir.
 * Karantina gerekiyorsa action_items tablosuna acil uyarı kaydeder.
 */
export async function scanPaymentForFraud(
  pool: Pool,
  paymentId: string,
  actorId: string,
): Promise<PaymentFraudEvaluation> {
  const pRes = await pool.query(
    `select
       p.id,
       p.owner_party_id,
       pa.name as party_name,
       p.recipient_iban,
       p.amount,
       p.created_at
     from public.payments p
     join public.parties pa on pa.id = p.owner_party_id
     where p.id = $1`,
    [paymentId],
  );

  if (pRes.rowCount === 0) {
    throw new Error(`Ödeme kaydı bulunamadı: ${paymentId}`);
  }

  const p = pRes.rows[0];
  const partyId = p.owner_party_id;
  const iban = p.recipient_iban ?? "";
  const amount = Number(p.amount ?? 0);

  // Tarihsel transferler
  const histRes = await pool.query(
    `select count(*)::int as n
     from public.payments
     where recipient_iban = $1 and id <> $2 and status in ('executed', 'matched')`,
    [iban, paymentId],
  );

  const histCount = Number(histRes.rows[0]?.n ?? 0);

  // Son 24 saatteki aynı cariye ödemeler
  const recentRes = await pool.query(
    `select id, amount
     from public.payments
     where owner_party_id = $1 and id <> $2
       and created_at >= (now() - interval '24 hours')`,
    [partyId, paymentId],
  );

  const recentPayments = recentRes.rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
  }));

  const evaluation = evaluatePaymentFraudRisk({
    paymentId,
    partyId,
    partyName: p.party_name,
    recipientIban: iban,
    amountTRY: amount,
    timestampISO: new Date().toISOString(),
    historicalIbanTransferCount: histCount,
    sameParty24hPayments: recentPayments,
  });

  if (evaluation.quarantineStatus === "QUARANTINED") {
    // action_items tablosuna kritik alarm düşür
    await pool.query(
      `insert into public.action_items
         (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
       values ($1, 'critical', 'open', 'collection', 'payments', $2, $3, $4)
       on conflict do nothing`,
      [
        `🚨 DOLANDIRICILIK ŞÜPHESİ: ${p.party_name} (₺${amount.toLocaleString("tr-TR")})`,
        paymentId,
        evaluation.recommendation,
        actorId,
      ],
    );

    await audit(pool, {
      actor: actorId,
      action: "payment_fraud_quarantine",
      entityTable: "payments",
      entityId: paymentId,
      after: {
        riskScore: evaluation.riskScore,
        anomalies: evaluation.detectedAnomalies,
        quarantined: true,
      },
    });

    invalidateTags([CACHE_TAGS.CONTROLS, CACHE_TAGS.PAYMENTS]);
  }

  return evaluation;
}
