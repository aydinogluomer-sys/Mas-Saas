import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  planPromiseReminders,
  onPromiseCreated,
  evaluateCustomerRisk,
  handleBrokenPromise,
  runDisciplineCycle,
} from "@/lib/collections/discipline-engine";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue("audit-id"),
}));

vi.mock("@/lib/cache/engine", () => ({
  invalidateTags: vi.fn(),
  cacheEngine: {
    get: vi.fn(),
    set: vi.fn(),
    invalidateTag: vi.fn(),
    invalidateTable: vi.fn(),
  },
}));

vi.mock("./promises-engine", () => ({
  detectBrokenPromises: vi.fn(),
}));

describe("Kilit Taşı 2: Tahsilat Disiplin Döngüsü (Collection Discipline Loop)", () => {
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      query: vi.fn(),
    };
  });

  describe("planPromiseReminders (T-2, T-0, T+1)", () => {
    it("ödeme sözü için 3 aşamalı hatırlatma planını doğru tarihlerle kurgular", () => {
      const plan = planPromiseReminders({
        promiseId: "p-100",
        partyId: "party-1",
        partyName: "Atlas Dağıtım A.Ş.",
        promisedDate: "2026-10-20",
        amount: 85000,
        currency: "TRY",
      });

      expect(plan.scheduledDeliveries).toHaveLength(3);
      // T-2
      expect(plan.scheduledDeliveries[0].targetDate).toBe("2026-10-18");
      expect(plan.scheduledDeliveries[0].offsetDays).toBe(2);
      // T-0
      expect(plan.scheduledDeliveries[1].targetDate).toBe("2026-10-20");
      expect(plan.scheduledDeliveries[1].offsetDays).toBe(0);
      // T+1
      expect(plan.scheduledDeliveries[2].targetDate).toBe("2026-10-21");
      expect(plan.scheduledDeliveries[2].offsetDays).toBe(-1);
    });
  });

  describe("onPromiseCreated", () => {
    it("yeni ödeme sözü için plan üretir, denetim kaydı atar ve önbelleği geçersiz kılar", async () => {
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "p-101",
            party_id: "party-2",
            party_name: "Kuzey Lojistik",
            promised_date: "2026-11-05",
            promised_amount: "150000.00",
            currency: "TRY",
          },
        ],
      });

      const plan = await onPromiseCreated(mockPool, "p-101", "user-cfo");
      expect(plan.promiseId).toBe("p-101");
      expect(plan.partyName).toBe("Kuzey Lojistik");
      expect(plan.scheduledDeliveries[0].targetDate).toBe("2026-11-03");
    });
  });

  describe("evaluateCustomerRisk", () => {
    it("sağlıklı müşteri için düşük risk ve standart takip önerir", async () => {
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            party_id: "party-good",
            party_name: "Yıldız Holding",
            collection_score: 92,
            score_band: "good",
            score_reasons: [],
            open_receivable_amount: "100000.00",
            overdue_amount: "0.00",
            credit_limit: "500000.00",
            credit_limit_currency: "TRY",
            credit_limit_utilization: 0.2,
            over_credit_limit: false,
          },
        ],
      });

      const res = await evaluateCustomerRisk(mockPool, "party-good");
      expect(res.riskLevel).toBe("LOW");
      expect(res.recommendation).toBe("STANDARD_COLLECTION");
    });

    it("kritik skorda ve limit aşımında FREEZE_CREDIT tavsiye eder", async () => {
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            party_id: "party-bad",
            party_name: "Batık İnşaat",
            collection_score: 25,
            score_band: "critical",
            score_reasons: ["gecikmis_fatura_yasi", "tutulmayan_odeme_sozu"],
            open_receivable_amount: "650000.00",
            overdue_amount: "400000.00",
            credit_limit: "500000.00",
            credit_limit_currency: "TRY",
            credit_limit_utilization: 1.3,
            over_credit_limit: true,
          },
        ],
      });

      const res = await evaluateCustomerRisk(mockPool, "party-bad");
      expect(res.riskLevel).toBe("CRITICAL");
      expect(res.recommendation).toBe("FREEZE_CREDIT");
      expect(res.overCreditLimit).toBe(true);
    });
  });

  describe("handleBrokenPromise", () => {
    it("bozulan söz için durum günceller ve finans ekibine kritik action_item üretir", async () => {
      // 1. fetch promise
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "p-broken-1",
            party_id: "party-risk",
            party_name: "Delta Sanayi",
            promised_date: "2026-10-10",
            promised_amount: "250000.00",
            currency: "TRY",
            status: "pending",
          },
        ],
      });

      // 2. update to broken
      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      // 3. evaluateCustomerRisk
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            party_id: "party-risk",
            party_name: "Delta Sanayi",
            collection_score: 30,
            score_band: "critical",
            score_reasons: ["tutulmayan_odeme_sozu"],
            open_receivable_amount: "300000.00",
            overdue_amount: "250000.00",
            credit_limit: "200000.00",
            credit_limit_currency: "TRY",
            credit_limit_utilization: 1.5,
            over_credit_limit: true,
          },
        ],
      });

      // 4. insert action_items
      mockPool.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: "act-task-999" }],
      });

      const result = await handleBrokenPromise(mockPool, "p-broken-1", "user-cfo", "2026-10-17");

      expect(result.promiseId).toBe("p-broken-1");
      expect(result.daysLate).toBe(7);
      expect(result.actionItemId).toBe("act-task-999");
      expect(result.creditRiskWarning).toBe(true);
      expect(result.evaluation.recommendation).toBe("FREEZE_CREDIT");
    });
  });
});
