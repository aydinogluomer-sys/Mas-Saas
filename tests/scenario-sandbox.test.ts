import { describe, it, expect } from "vitest";
import {
  runWhatIfSimulation,
  type SimulationWeekInput,
} from "@/lib/simulations/sandbox";

describe("Faz 3: 'What-If' Finansal Kum Havuzu (Scenario Sandbox)", () => {
  const sampleWeeks: SimulationWeekInput[] = [
    { weekIndex: 1, weekStartDate: "2026-10-19", inflow: 100000, outflow: 80000 },
    { weekIndex: 2, weekStartDate: "2026-10-26", inflow: 100000, outflow: 80000 },
    { weekIndex: 3, weekStartDate: "2026-11-02", inflow: 100000, outflow: 80000 },
    { weekIndex: 4, weekStartDate: "2026-11-09", inflow: 100000, outflow: 80000 },
  ];

  it("müdahalesiz senaryoda nakit akışı olağan seyreder ve açık oluşmaz", () => {
    const report = runWhatIfSimulation({
      initialCash: 500000,
      minCashFloor: 100000,
      weeks: sampleWeeks,
      modifiers: {},
    });

    expect(report.deficitOccurs).toBe(false);
    expect(report.firstDeficitWeek).toBeNull();
    expect(report.weeklyTimeline[3].simulatedClosingBalance).toBe(580000);
    expect(report.cfoExecutiveVerdict).toContain("Senaryo güvenli");
  });

  it("büyük CAPEX yatırımı nakit yapıldığında açığın oluştuğu ilk haftayı tespit eder", () => {
    // 2. haftada 600.000 TL makine yatırımı yapılıyor
    // Hafta 1 sonu: 500k + 20k = 520k
    // Hafta 2 başı: 520k, giriş: 100k, çıkış: 80k + 600k = 680k -> Bakiye: -60.000 TL!
    const report = runWhatIfSimulation({
      initialCash: 500000,
      minCashFloor: 100000,
      weeks: sampleWeeks,
      modifiers: {
        capexOutflows: [
          { weekIndex: 2, amount: 600000, label: "CNC Makinesi Satın Alımı" },
        ],
      },
    });

    expect(report.deficitOccurs).toBe(true);
    expect(report.firstDeficitWeek).toBe(2);
    expect(report.firstDeficitDate).toBe("2026-10-26");
    expect(report.maxDeficitAmount).toBeGreaterThanOrEqual(160000); // 100.000 floor - (-60.000)
    expect(report.cfoExecutiveVerdict).toContain("RİSKLİ SENARYO");
    expect(report.recommendedActions[0]).toContain("rotatif kredi");
  });

  it("tahsilat gecikmesi senaryosunda nakit açığını doğru simüle eder", () => {
    // Hafta 1'deki 80.000 TL alacak Hafta 4'e öteleniyor
    const report = runWhatIfSimulation({
      initialCash: 120000,
      minCashFloor: 100000,
      weeks: sampleWeeks,
      modifiers: {
        delayedInflows: [
          { fromWeekIndex: 1, toWeekIndex: 4, amount: 80000, label: "Büyük Müşteri Vade Erteleme" },
        ],
      },
    });

    // Hafta 1: Başlangıç 120k, Giriş: 100k - 80k = 20k, Çıkış: 80k -> Bakiye: 60k < 100k Floor!
    expect(report.deficitOccurs).toBe(true);
    expect(report.firstDeficitWeek).toBe(1);
    expect(report.weeklyTimeline[0].isDeficit).toBe(true);
    expect(report.weeklyTimeline[0].deficitAmount).toBe(40000);
  });
});
