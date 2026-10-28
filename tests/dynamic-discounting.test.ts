import { describe, it, expect } from "vitest";
import {
  analyzeDiscountArbitrage,
  type EarlyDiscountOffer,
} from "@/lib/finance/dynamic-discounting";

describe("Faz 3: Dinamik İskonto & Erken Ödeme Arbitraj Motoru", () => {
  it("yüksek APR getiren ve fonlama maliyetini aşan teklifte PAY_EARLY kararı verir", () => {
    // 2/10 Net 40 teklifi: 30 gün erken ödeme karşılığı %3 iskonto
    const offer: EarlyDiscountOffer = {
      invoiceId: "inv-101",
      counterpartyName: "Çelik Hammadde Sanayi",
      invoiceAmount: 1000000,
      originalDueDate: "2026-11-20",
      earlyPaymentDate: "2026-10-21", // 30 gün erken
      discountPercent: 3.0,          // %3 iskonto = 30.000 TL
    };

    const res = analyzeDiscountArbitrage(offer, {
      borrowingCostAnnual: 35.0, // Şirket borçlanması %35
      availableCashTRY: 2000000,
      minCashFloorTRY: 500000,
    });

    // APR hesabı: (0.03 / 0.97) * (365 / 30) * 100 ≈ 37.63%
    expect(res.decision).toBe("PAY_EARLY");
    expect(res.annualizedReturnAPR).toBeGreaterThan(36);
    expect(res.netSpreadAnnual).toBeGreaterThan(0);
    expect(res.netArbitrageProfitTL).toBeGreaterThan(0);
    expect(res.paymentAmountTL).toBe(970000);
  });

  it("iskonto APR oranı şirketin borçlanma faizinin altındaysa PAY_ON_DUE_DATE kararı verir", () => {
    // 60 gün erken ödeme için sadece %1 iskonto -> APR çok düşük kalır
    const offer: EarlyDiscountOffer = {
      invoiceId: "inv-102",
      counterpartyName: "Ofis Malzemeleri Ltd.",
      invoiceAmount: 100000,
      originalDueDate: "2026-12-20",
      earlyPaymentDate: "2026-10-21", // 60 gün erken
      discountPercent: 1.0,          // %1 iskonto
    };

    const res = analyzeDiscountArbitrage(offer, {
      borrowingCostAnnual: 45.0, // Fonlama %45
      availableCashTRY: 1000000,
      minCashFloorTRY: 200000,
    });

    // APR ≈ 6.14% << 45%
    expect(res.decision).toBe("PAY_ON_DUE_DATE");
    expect(res.netSpreadAnnual).toBeLessThan(0);
    expect(res.decisionReason).toContain("VADESİNDE ÖDE");
  });

  it("serbest nakit ödeme tutarından azsa kasa tabanını korumak için HOLD_LIQUIDITY kararı verir", () => {
    const offer: EarlyDiscountOffer = {
      invoiceId: "inv-103",
      counterpartyName: "Mega Makine A.Ş.",
      invoiceAmount: 500000,
      originalDueDate: "2026-11-20",
      earlyPaymentDate: "2026-10-21",
      discountPercent: 5.0, // Çok cazip iskonto
    };

    const res = analyzeDiscountArbitrage(offer, {
      borrowingCostAnnual: 40.0,
      availableCashTRY: 300000, // Serbest nakit 100.000 TL kalıyor
      minCashFloorTRY: 200000,
    });

    expect(res.decision).toBe("HOLD_LIQUIDITY");
    expect(res.decisionReason).toContain("Nakit kısıtı");
  });
});
