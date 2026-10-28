import { describe, it, expect } from "vitest";
import {
  evaluatePaymentFraudRisk,
  type PaymentSecurityInput,
} from "@/lib/security/fraud-guard";

describe("Faz 5: Dolandırıcılık ve Oltalama Önleme (Fraud Guard)", () => {
  it("tanınan IBAN ve normal saatlerdeki rutin ödemeyi CLEARED olarak onaylar", () => {
    const input: PaymentSecurityInput = {
      paymentId: "pay-normal",
      partyId: "vendor-1",
      partyName: "Tedaş Elektrik A.Ş.",
      recipientIban: "TR110001500000123456789012",
      amountTRY: 12500,
      timestampISO: "2026-10-17T11:30:00.000Z", // Gündüz mesai içi
      historicalIbanTransferCount: 24, // 24 kez para gönderilmiş güvenli IBAN
      sameParty24hPayments: [],
      approvalThresholdTRY: 50000,
    };

    const res = evaluatePaymentFraudRisk(input);
    expect(res.riskLevel).toBe("SAFE");
    expect(res.quarantineStatus).toBe("CLEARED");
    expect(res.riskScore).toBe(0);
    expect(res.detectedAnomalies).toHaveLength(0);
  });

  it("yeni/bilinmeyen IBAN'a yüksek tutarlı transferi QUARANTINED yapar", () => {
    // Klasik VEC (Vendor Email Compromise): Tedarikçinin hacklenen maili ile gelen yeni IBAN
    const input: PaymentSecurityInput = {
      paymentId: "pay-phishing",
      partyId: "vendor-steel",
      partyName: "Demir Çelik Sanayi A.Ş.",
      recipientIban: "TR990006200000987654321099", // Sistemde hiç işlem görmemiş yeni IBAN!
      amountTRY: 450000,
      timestampISO: "2026-10-17T14:00:00.000Z",
      historicalIbanTransferCount: 0,
      sameParty24hPayments: [],
      approvalThresholdTRY: 100000,
    };

    const res = evaluatePaymentFraudRisk(input);
    expect(res.riskLevel).toBe("CRITICAL");
    expect(res.quarantineStatus).toBe("QUARANTINED");
    expect(res.detectedAnomalies.some((a) => a.code === "FIRST_TIME_IBAN")).toBe(true);
    expect(res.recommendation).toContain("İŞLEM KARANTİNAYA ALINDI");
  });

  it("onay limitini atlatmak için parçalanmış (smurfing) işlemleri tespit eder", () => {
    // Onay eşiği 50.000 TL; 48.000 TL transfer yapılıyor ve 24 saat içinde 47.500 TL yapılmış
    const input: PaymentSecurityInput = {
      paymentId: "pay-smurf-2",
      partyId: "vendor-tech",
      partyName: "Bilişim Sistemleri Ltd.",
      recipientIban: "TR220001000000555555555555",
      amountTRY: 48000,
      timestampISO: "2026-10-17T15:20:00.000Z",
      historicalIbanTransferCount: 15,
      sameParty24hPayments: [{ id: "pay-smurf-1", amount: 47500 }],
      approvalThresholdTRY: 50000,
    };

    const res = evaluatePaymentFraudRisk(input);
    expect(res.quarantineStatus).toBe("QUARANTINED");
    expect(res.detectedAnomalies.some((a) => a.code === "SPLIT_TRANSACTION")).toBe(true);
    expect(res.detectedAnomalies[0].severity).toBe("critical");
  });

  it("gece mesai dışı yüksek tutarlı transferleri uyarır", () => {
    const input: PaymentSecurityInput = {
      paymentId: "pay-night",
      partyId: "vendor-cons",
      partyName: "Danışmanlık A.Ş.",
      recipientIban: "TR330006100000111122223333",
      amountTRY: 180000,
      // UTC 20:00 -> Istanbul 23:00 (Gece)
      timestampISO: "2026-10-17T20:30:00.000Z",
      historicalIbanTransferCount: 8,
      sameParty24hPayments: [],
      approvalThresholdTRY: 250000,
    };

    const res = evaluatePaymentFraudRisk(input);
    expect(res.detectedAnomalies.some((a) => a.code === "OFF_HOURS_HIGH_VALUE")).toBe(true);
  });
});
