import { describe, it, expect } from "vitest";
import { calculateCashRunway } from "@/lib/finance/cash-runway";

describe("Faz 3: Likidite Stres Testi & Cash Runway (Cash-Out Day)", () => {
  it("güçlü nakit tamponu ve düşük burn rate durumunda COMFORTABLE runway üretir", () => {
    const report = calculateCashRunway({
      asOfDate: "2026-10-17",
      liquidCashTRY: 5000000,
      creditHeadroomTRY: 2000000,
      monthlyOperatingExpense: 600000,
      monthlyContractedInflow: 500000, // Net burn = 100.000 TL / ay -> 3.333 TL / gün
      minCashFloor: 200000,
    });

    expect(report.totalLiquidCash).toBe(5000000);
    expect(report.scenarios.baseline.verdict).toBe("COMFORTABLE");
    expect(report.scenarios.baseline.runwayDays).toBeGreaterThan(180);
    expect(report.scenarios.pessimistic.runwayDays).toBeGreaterThan(30);
  });

  it("yüksek burn rate ve kısıtlı nakitte CRITICAL verdict ve yakın Cash-Out Day üretir", () => {
    const report = calculateCashRunway({
      asOfDate: "2026-10-17",
      liquidCashTRY: 150000,
      creditHeadroomTRY: 50000,
      monthlyOperatingExpense: 400000,
      monthlyContractedInflow: 100000, // Net burn = 300.000 TL / ay -> 10.000 TL / gün
      minCashFloor: 50000, // Efektif tampon = 100.000 TL -> 10 gün!
    });

    expect(report.scenarios.baseline.verdict).toBe("CRITICAL");
    expect(report.scenarios.baseline.runwayDays).toBeLessThanOrEqual(15);
    expect(report.scenarios.baseline.cashOutDate).toBe("2026-10-27");
    expect(report.summaryRecommendation).toContain("DİKKAT");
  });

  it("kredi limitleri kriz senaryosunda dondurulmuş varsayılarak sadece nakit tamponu baz alınır", () => {
    const report = calculateCashRunway({
      asOfDate: "2026-10-17",
      liquidCashTRY: 1000000,
      creditHeadroomTRY: 3000000,
      monthlyOperatingExpense: 800000,
      monthlyContractedInflow: 600000,
      minCashFloor: 100000,
    });

    expect(report.scenarios.severeShock.cashOutDateWithCredit).toBeNull();
    expect(report.scenarios.severeShock.runwayWithCreditDays).toBeNull();
    expect(report.scenarios.severeShock.mitigationActions.length).toBeGreaterThan(0);
  });
});
