import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyAuditChainAction,
  runSimulationAction,
  recomputeDiscountArbitrageAction,
} from "@/app/(dashboard)/finance/cockpit/actions";

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  })),
}));

vi.mock("@/lib/audit/hash-chain", () => ({
  verifyDatabaseAuditLogs: vi.fn().mockResolvedValue({
    isValid: true,
    totalEntries: 25,
    verifiedCount: 25,
    tamperedSequenceNo: null,
    tamperedEntryId: null,
    expectedHash: null,
    foundHash: null,
    verdictMessage: "KUSURSUZ DENETİM İZİ",
  }),
}));

vi.mock("@/lib/simulations/sandbox", () => ({
  runSandboxFromDatabase: vi.fn().mockImplementation((_pool, modifiers) => ({
    scenarioName: "Simülasyon",
    initialCash: 1000000,
    minCashFloor: 200000,
    baselineMinCash: 800000,
    simulatedMinCash: modifiers.revenueShockPercent ? 600000 : 800000,
    deficitOccurs: Boolean(modifiers.capexOutflows?.length),
    firstDeficitWeek: modifiers.capexOutflows?.length ? 3 : null,
    firstDeficitDate: modifiers.capexOutflows?.length ? "2026-11-02" : null,
    maxDeficitAmount: modifiers.capexOutflows?.length ? 150000 : 0,
    headroomRequired: modifiers.capexOutflows?.length ? 150000 : 0,
    weeklyTimeline: [],
    cfoExecutiveVerdict: "Test Değerlendirme",
    recommendedActions: [],
  })),
}));

vi.mock("@/lib/finance/dynamic-discounting", () => ({
  optimizePayablesDiscounts: vi.fn().mockImplementation((_pool, offers, rate) => ({
    analyzedOffersCount: offers.length,
    recommendedEarlyPaymentsCount: 1,
    totalCashOutflowRequired: 500000,
    totalGrossDiscountEarned: 25000,
    totalNetArbitrageProfit: 12000,
    averageAnnualizedAPR: 38.5,
    results: [],
  })),
}));

describe("CFO Command Center (actions.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("verifyAuditChainAction veritabanındaki denetim loglarını başarıyla doğrular", async () => {
    const res = await verifyAuditChainAction();
    expect(res.isValid).toBe(true);
    expect(res.verifiedCount).toBe(25);
    expect(res.verdictMessage).toContain("KUSURSUZ DENETİM İZİ");
  });

  it("runSimulationAction parametreleri What-If motoruna iletir ve sonucu döner", async () => {
    const res = await runSimulationAction({
      revenueShockPercent: -20,
      capexOutflows: [{ weekIndex: 3, amount: 500000, label: "Makine" }],
    });

    expect(res.deficitOccurs).toBe(true);
    expect(res.firstDeficitWeek).toBe(3);
    expect(res.maxDeficitAmount).toBe(150000);
  });

  it("recomputeDiscountArbitrageAction güncellenen faiz oranına göre arbitrajı hesaplar", async () => {
    const sampleOffers: any[] = [{ invoiceId: "inv-1", amount: 100000 }];
    const res = await recomputeDiscountArbitrageAction(sampleOffers, 45.0);

    expect(res.analyzedOffersCount).toBe(1);
    expect(res.averageAnnualizedAPR).toBe(38.5);
    expect(res.totalNetArbitrageProfit).toBe(12000);
  });
});
