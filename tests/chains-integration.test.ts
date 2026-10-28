import { describe, expect, it } from "vitest";
import {
  evaluateOrderToCashChain,
  evaluateProcureToPayChain,
  evaluateTreasuryOptimizationChain,
  evaluateFxDefenseChain,
  evaluateStatutoryDefenseChain,
  evaluateFraudIntegrityChain,
  evaluateCashUnitEconomicsChain,
  evaluateExecutiveHubChain,
  runFinancialNervousSystemCheck,
} from "@/lib/chains";

// Mock pool creating realistic, isolated database query responses
function createMockPool() {
  return {
    query: async (queryText: string, params?: unknown[]) => {
      const q = queryText.toLowerCase();

      // Invoices
      if (q.includes("from public.invoices") && q.includes("direction = 'sales'")) {
        return {
          rowCount: 2,
          rows: [
            {
              id: "inv-s-1",
              invoice_no: "FAT-SATIS-001",
              party_id: "party-1",
              party_name: "Mega Yapı A.Ş.",
              gross_amount: "350000",
              currency: "TRY",
              due_date: "2026-11-15",
              issue_date: "2026-10-01",
              status: "open",
            },
            {
              id: "inv-s-2",
              invoice_no: "FAT-SATIS-002",
              party_id: "party-2",
              party_name: "Atlas Dış Ticaret",
              gross_amount: "120000",
              currency: "TRY",
              due_date: "2026-10-10", // Vadesi geçmiş
              issue_date: "2026-09-10",
              status: "overdue",
            },
          ],
        };
      }

      if (q.includes("from public.invoices") && q.includes("direction = 'purchase'")) {
        return {
          rowCount: 2,
          rows: [
            {
              id: "inv-p-1",
              invoice_no: "FAT-ALIS-001",
              party_id: "party-3",
              party_name: "Hammadde Kimya A.Ş.",
              gross_amount: "280000",
              currency: "TRY",
              due_date: "2026-10-25",
              status: "open",
              cost_center_id: null,
              project_id: null,
            },
            {
              id: "inv-p-2",
              invoice_no: "FAT-ALIS-002",
              party_id: "party-4",
              party_name: "Lojistik Ambalaj Ltd.",
              gross_amount: "95000",
              currency: "TRY",
              due_date: "2026-10-22",
              status: "open",
              cost_center_id: null,
              project_id: null,
            },
          ],
        };
      }

      // DSO & Counterparties
      if (q.includes("from public.parties p") && q.includes("counterparty_profiles")) {
        return {
          rowCount: 2,
          rows: [
            {
              party_id: "party-1",
              party_name: "Mega Yapı A.Ş.",
              dso_days: "65",
              open_balance: "350000",
              score_band: "HIGH",
            },
            {
              party_id: "party-2",
              party_name: "Atlas Dış Ticaret",
              dso_days: "35",
              open_balance: "120000",
              score_band: "LOW",
            },
          ],
        };
      }

      // Promises
      if (q.includes("from public.promise_to_pay")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "pr-1",
              party_id: "party-1",
              party_name: "Mega Yapı A.Ş.",
              promised_amount: "150000",
              promised_date: "2026-10-24",
              currency: "TRY",
              status: "pending",
            },
          ],
        };
      }

      // Bank accounts
      if (q.includes("from public.bank_accounts")) {
        return {
          rowCount: 2,
          rows: [
            {
              id: "ba-1",
              account_name: "Ana Ticari Hesap",
              bank_name: "Garanti BBVA",
              currency: "TRY",
              balance: "850000",
              total: "1450000",
            },
            {
              id: "ba-2",
              account_name: "Şube Operasyon",
              bank_name: "İş Bankası",
              currency: "TRY",
              balance: "600000",
              total: "1450000",
            },
          ],
        };
      }

      // Bank transactions / reconciliation
      if (q.includes("from public.bank_transactions")) {
        return {
          rowCount: 1,
          rows: [{ unmatched_tx: "3", unmatched_inv: "2", potential_vol: "470000" }],
        };
      }

      // Checks
      if (q.includes("from public.checks")) {
        return {
          rowCount: 2,
          rows: [
            {
              id: "chk-1",
              check_no: "CHK-2026-001",
              amount: "250000",
              currency: "TRY",
              due_date: "2026-11-05",
              status: "portfolio",
              party_name: "Mega Yapı A.Ş.",
              score_band: "HIGH",
            },
            {
              id: "chk-2",
              check_no: "CHK-2026-002",
              amount: "180000",
              currency: "TRY",
              due_date: "2026-10-28",
              status: "portfolio",
              party_name: "Atlas Dış Ticaret",
              score_band: "LOW",
            },
          ],
        };
      }

      // FX Invoices
      if (q.includes("currency in ('usd', 'eur', 'gbp')")) {
        return {
          rowCount: 3,
          rows: [
            { currency: "USD", direction: "sales", total_amount: "150000" },
            { currency: "USD", direction: "purchase", total_amount: "90000" },
            { currency: "EUR", direction: "purchase", total_amount: "120000" },
          ],
        };
      }

      // Duplicate invoices
      if (q.includes("having count(*) > 1")) {
        return {
          rowCount: 0,
          rows: [],
        };
      }

      return { rowCount: 0, rows: [] };
    },
  } as any;
}

describe("Bütünleşik Finansal Sinir Sistemi (8 İhtiyaç Tabanlı Zincir)", () => {
  const pool = createMockPool();

  describe("Zincir 1: Otonom Tahsilat & Erken Nakit Döngüsü (Order-to-Cash & DSO)", () => {
    it("açık ve vadesi geçmiş alacakları, DSO ağırlığını ve dinamik iskontoyu doğru hesaplar", async () => {
      const res = await evaluateOrderToCashChain(pool, {
        companyBorrowingRateAnnual: 42.0,
      });

      expect(res.chainName).toBe("order_to_cash");
      expect(res.totalOpenReceivablesTRY).toBe(470000); // 350k + 120k
      expect(res.overdueReceivablesTRY).toBe(120000);
      expect(res.weightedAverageDSO).toBeGreaterThan(40);
      expect(res.criticalDsoCustomers).toHaveLength(2);
      expect(res.activePromises).toHaveLength(1);
      expect(res.activePromises[0].reminders.scheduledDeliveries.length).toBeGreaterThan(0);
      expect(res.dynamicDiscountOpportunities.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Zincir 2: Satınalma & Likidite Koruma Kalkanı (Procure-to-Pay)", () => {
    it("bütçe aşımını ve kasa tamponunu tehdit eden faturalara erteleme / çek reçetesi üretir", async () => {
      const res = await evaluateProcureToPayChain(pool, {
        currentCashBalanceTRY: 300000,
        safetyBufferTRY: 150000,
      });

      expect(res.chainName).toBe("procure_to_pay");
      expect(res.totalPendingPayablesTRY).toBe(375000); // 280k + 95k
      expect(res.evaluatedPayables).toHaveLength(2);
      // İlk fatura (280k) ödendiğinde bakiye 300k - 280k = 20k (< 150k tampon) -> Deficit tespit edilmeli
      const firstPayable = res.evaluatedPayables[0];
      expect(firstPayable.liquidityImpact.causesCashDeficit).toBe(true);
      expect(["ISSUE_PROMISSORY_NOTE", "DEFER_PAYMENT_15D"]).toContain(
        firstPayable.liquidityImpact.recommendedAction,
      );
    });
  });

  describe("Zincir 3: Çek/Senet & Kredi Tesisleri Optimizasyonu (Treasury)", () => {
    it("portföydeki riskli çekleri tespit eder ve en düşük faizli finansman rotasını önerir", async () => {
      const res = await evaluateTreasuryOptimizationChain(pool, {
        targetDeficitToCoverTRY: 200000,
      });

      expect(res.chainName).toBe("treasury_optimization");
      expect(res.totalChecksPortfolioTRY).toBe(430000); // 250k + 180k
      expect(res.riskyChecksCount).toBe(1); // Mega Yapı A.Ş. HIGH bandı
      expect(res.riskyChecksVolumeTRY).toBe(250000);
      expect(res.cheapestLiquidityRoute.recommendedSource).toBeDefined();
    });
  });

  describe("Zincir 4: Kur Riski & Doğal Hedge Kalkanı (FX Defense)", () => {
    it("net açık pozisyonu ve %20 kur şokundaki potansiyel TL zararını hesaplar", async () => {
      const res = await evaluateFxDefenseChain(pool, {
        spotRates: { USD: 35.0, EUR: 38.0, GBP: 45.0 },
      });

      expect(res.chainName).toBe("fx_defense");
      expect(res.positions.length).toBeGreaterThanOrEqual(2); // USD ve EUR
      const usdPos = res.positions.find((p) => p.currency === "USD");
      expect(usdPos).toBeDefined();
      expect(usdPos?.netExposureFX).toBe(60000); // 150k - 90k (Net Long)
      expect(res.totalShock20PctRiskTRY).toBeGreaterThan(0);
    });
  });

  describe("Zincir 5: Yasal Takvim & Kasa Emniyet Bariyeri (Statutory Defense)", () => {
    it("vergi, SGK ve maaş rezervini serbest nakitten bloke eder ve açığı bildirir", async () => {
      const res = await evaluateStatutoryDefenseChain(pool, {
        currentBankBalanceTRY: 600000, // Toplam zorunlu rezervden daha düşük
        estimatedMonthlyPayrollTRY: 400000,
      });

      expect(res.chainName).toBe("statutory_defense");
      expect(res.statutoryReservedAmountTRY).toBeGreaterThan(600000);
      // Kasa 600k ama rezerv >600k olduğu için açığı yakalamalı
      expect(res.isReserveCompromised).toBe(true);
      expect(res.safetyVerdict).toBe("CRITICAL_DEFICIT");
      expect(res.actionableWarning).toContain("DİKKAT");
    });
  });

  describe("Zincir 6: Dolandırıcılık (Fraud) & IBAN Güvenlik Ağı", () => {
    it("ilk kez gönderilen IBAN ve limit atlatma (smurfing) şüphelerini karantinaya alır", async () => {
      const res = await evaluateFraudIntegrityChain(pool);

      expect(res.chainName).toBe("fraud_integrity");
      expect(res.scannedPaymentsCount).toBe(3);
      expect(res.quarantinedCount).toBeGreaterThanOrEqual(1); // pay-sim-002 (Yeni IBAN)
      expect(res.securityVerdict).toBe("CRITICAL_FRAUD_DETECTED");
    });
  });

  describe("Zincir 7: Üretim Maliyeti & Gerçek Kasa Karlılığı (Cash-Unit Economics)", () => {
    it("kağıt üzerinde karlı görünen ancak uzun müşteri vadesiyle sermaye yutan ürünleri tespit eder", async () => {
      const res = await evaluateCashUnitEconomicsChain(pool, {
        annualFinancingCostPercent: 42.0,
      });

      expect(res.chainName).toBe("cash_unit_economics");
      expect(res.analyzedProductsCount).toBe(4);
      expect(res.cashDrainersCount).toBeGreaterThanOrEqual(1);
      // prod-001 (120 gün vade vs 15 gün hammadde) nakit yutucu olarak işaretlenmeli
      const drainer = res.products.find((p) => p.productId === "prod-001");
      expect(drainer?.cashDrainVerdict).toBe("CASH_DRAINER");
      expect(drainer?.trueCashMarginPercent).toBeLessThan(drainer?.accountingGrossMarginPercent || 0);
    });
  });

  describe("Zincir 8: Sabah 08:30 Mobil Yönetici Özeti (Executive Hub)", () => {
    it("30 saniyelik Telegram Mini App brifingi ve tek tuşla onay/erteleme aksiyonları hazırlar", async () => {
      const res = await evaluateExecutiveHubChain(pool, {
        forcedBriefingTime: "08:30",
      });

      expect(res.chainName).toBe("executive_hub");
      expect(res.briefingTime).toBe("08:30");
      expect(res.netLiquidityStatus.totalAvailableLiquidityTRY).toBeGreaterThan(0);
      expect(res.pendingMobileActions.length).toBeGreaterThanOrEqual(2);
      expect(res.telegramMiniAppPayload.quickSummaryMarkdown).toContain("08:30");
    });
  });

  describe("Master Orkestratör: runFinancialNervousSystemCheck", () => {
    it("tüm 8 zinciri paralel olarak çalıştırıp genel sağlık skoru ve öncelikli alarmları üretir", async () => {
      const report = await runFinancialNervousSystemCheck(pool, {
        borrowingCostAnnual: 42.0,
        currentCashBalanceTRY: 1200000,
        safetyBufferTRY: 300000,
      });

      expect(report.overallHealthScore).toBeGreaterThanOrEqual(10);
      expect(report.overallHealthScore).toBeLessThanOrEqual(100);
      expect(["EXCELLENT", "STABLE", "ATTENTION_REQUIRED", "CRITICAL_RISK"]).toContain(report.healthStatus);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(report.alerts.length).toBeGreaterThan(0);
      // 8 zincirin hepsi raporda yer almalı
      expect(report.chains.orderToCash).toBeDefined();
      expect(report.chains.procureToPay).toBeDefined();
      expect(report.chains.treasuryOptimization).toBeDefined();
      expect(report.chains.fxDefense).toBeDefined();
      expect(report.chains.statutoryDefense).toBeDefined();
      expect(report.chains.fraudIntegrity).toBeDefined();
      expect(report.chains.cashUnitEconomics).toBeDefined();
      expect(report.chains.executiveHub).toBeDefined();
    });
  });
});
