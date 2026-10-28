import { describe, it, expect } from "vitest";
import {
  calculateIntercompanyNetting,
  calculateCashPoolingArbitrage,
  type IntercompanyDebt,
  type GroupEntityBalance,
} from "@/lib/treasury/cash-pooling";

describe("Faz 4: Holding İçi Nakit Havuzlama & Mahsuplaşma", () => {
  describe("İkili & Çok Taraflı Mahsuplaşma (Netting)", () => {
    it("karşılıklı borçları mahsuplaştırarak brüt para transferini minimize eder", () => {
      // Şirket A -> Şirket B'ye 1.500.000 TL borçlu
      // Şirket B -> Şirket A'ya 1.200.000 TL borçlu
      // Brüt akış: 2.700.000 TL. Net akış: Şirket A -> Şirket B 300.000 TL!
      const debts: IntercompanyDebt[] = [
        {
          debtorEntityId: "ent-A",
          debtorName: "Holding Üretim A.Ş.",
          creditorEntityId: "ent-B",
          creditorName: "Holding Dağıtım Ltd.",
          amountTRY: 1500000,
        },
        {
          debtorEntityId: "ent-B",
          debtorName: "Holding Dağıtım Ltd.",
          creditorEntityId: "ent-A",
          creditorName: "Holding Üretim A.Ş.",
          amountTRY: 1200000,
        },
      ];

      const report = calculateIntercompanyNetting(debts);

      expect(report.grossTransactionVolumeTRY).toBe(2700000);
      expect(report.netSettlementVolumeTRY).toBe(300000);
      expect(report.liquiditySavedTRY).toBe(2400000);
      expect(report.volumeReductionPercent).toBeGreaterThan(85);
      expect(report.settlements).toHaveLength(1);
      expect(report.settlements[0].fromEntityId).toBe("ent-A");
      expect(report.settlements[0].toEntityId).toBe("ent-B");
      expect(report.settlements[0].netSettlementAmountTRY).toBe(300000);
    });
  });

  describe("Sanal Nakit Havuzlama (Cash Pooling Arbitrage)", () => {
    it("fazla nakdi açığı olan şirkete yönlendirerek harici kredi faizinden tasarruf sağlar", () => {
      // Şirket A: +5.000.000 TL nakit (mevduat getirisi: %30)
      // Şirket B: -3.000.000 TL nakit açığı (kredi borçlanma faizi: %48)
      // Faiz spread farkı: %48 - %30 = %18
      // 3.000.000 TL fonlama ile yıllık faiz tasarrufu: 3.000.000 * 0.18 = 540.000 TL!
      const entities: GroupEntityBalance[] = [
        {
          entityId: "ent-A",
          entityName: "Grup Lojistik A.Ş.",
          cashBalanceTRY: 6000000,
          minCashFloorTRY: 1000000, // 5M fazlası var
          externalBorrowingRatePct: 45,
          depositYieldRatePct: 30,
        },
        {
          entityId: "ent-B",
          entityName: "Grup İnşaat Taahhüt",
          cashBalanceTRY: -2000000,
          minCashFloorTRY: 1000000, // 3M açığı var
          externalBorrowingRatePct: 48,
          depositYieldRatePct: 28,
        },
      ];

      const report = calculateCashPoolingArbitrage(entities, "2026-10-17");

      expect(report.externalBorrowingAvoidedTRY).toBe(3000000);
      expect(report.estimatedAnnualInterestSavingsTRY).toBe(540000);
      expect(report.sweepInstructions).toHaveLength(1);
      expect(report.sweepInstructions[0].sourceEntityName).toBe("Grup Lojistik A.Ş.");
      expect(report.sweepInstructions[0].targetEntityName).toBe("Grup İnşaat Taahhüt");
      expect(report.sweepInstructions[0].sweepAmountTRY).toBe(3000000);
      expect(report.sweepInstructions[0].taxComplianceNote).toContain("KVK m.12/13");
      expect(report.executiveSummary).toContain("net faiz tasarrufu");
    });
  });
});
