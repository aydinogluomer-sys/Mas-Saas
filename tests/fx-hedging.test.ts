import { describe, it, expect } from "vitest";
import { analyzeCurrencyHedge } from "@/lib/finance/fx-hedging";

describe("Faz 3: Net Açık FX Pozisyonu & Doğal Hedge Motoru", () => {
  it("döviz giriş ve çıkışları birbirine yakınken EXCELLENT_NATURAL_HEDGE tespit eder", () => {
    // 100.000 USD ihracat alacağı, 90.000 USD ithalat borcu
    const res = analyzeCurrencyHedge({
      currency: "USD",
      inflowFX: 100000,
      outflowFX: 90000,
      spotRateTRY: 35.0,
    });

    expect(res.netExposureFX).toBe(10000);
    expect(res.positionType).toBe("NET_LONG");
    expect(res.naturalHedgeRatio).toBe(90);
    expect(res.verdict).toBe("EXCELLENT_NATURAL_HEDGE");
    expect(res.stressTest.shock20PctDeltaTRY).toBe(70000); // Pozitif etki (kambiyo kârı)
  });

  it("yüksek açık pozisyon ve düşük doğal korumada UNHEDGED_EXPOSURE ve Forward önerir", () => {
    // 20.000 EUR giriş, 200.000 EUR borç çıkışı (Açık: 180.000 EUR)
    const res = analyzeCurrencyHedge({
      currency: "EUR",
      inflowFX: 20000,
      outflowFX: 200000,
      spotRateTRY: 38.0,
    });

    expect(res.netExposureFX).toBe(-180000);
    expect(res.positionType).toBe("NET_SHORT");
    expect(res.naturalHedgeRatio).toBe(10);
    expect(res.verdict).toBe("UNHEDGED_EXPOSURE");
    // %20 kur şokunda net zarar: -180.000 * 38 * 0.20 = -1.368.000 TL
    expect(res.stressTest.shock20PctDeltaTRY).toBe(-1368000);
    expect(res.recommendation).toContain("YÜKSEK KUR RİSKİ");
    expect(res.recommendation).toContain("Forward");
  });

  it("giriş ve çıkış sıfırken veya tam eşitken SQUARE ve nötr risk belirler", () => {
    const res = analyzeCurrencyHedge({
      currency: "GBP",
      inflowFX: 50000,
      outflowFX: 50000,
      spotRateTRY: 45.0,
    });

    expect(res.positionType).toBe("SQUARE");
    expect(res.naturalHedgeRatio).toBe(100);
    expect(res.stressTest.shock20PctDeltaTRY).toBe(0);
    expect(res.recommendation).toContain("DENGELİ POZİSYON");
  });
});
