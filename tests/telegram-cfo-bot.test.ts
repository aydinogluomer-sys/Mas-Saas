import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateCallbackSignature,
  verifyCallbackData,
  renderCfoBriefingTelegram,
  handleTelegramApprovalCallback,
} from "@/lib/telegram/cfo-bot";
import { decideApproval } from "@/lib/approvals/engine";
import { DomainError } from "@/lib/domain-error";

vi.mock("@/lib/approvals/engine", () => ({
  decideApproval: vi.fn(),
}));

describe("Kilit Taşı 6: Telegram Yönetici Teslimat Botu & İnteraktif Onay", () => {
  const SECRET = "super-secret-test-key";
  const TEST_APPROVAL_ID = "11111111-2222-3333-4444-555555555555";
  let mockPool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {};
  });

  describe("HMAC İmza ve Callback Doğrulama", () => {
    it("geçerli imza içeren callback_data'yı başarıyla doğrular", () => {
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "approved", SECRET);
      const callbackData = `app:${TEST_APPROVAL_ID}:a:${sig}`;

      const res = verifyCallbackData(callbackData, SECRET);
      expect(res.valid).toBe(true);
      expect(res.approvalId).toBe(TEST_APPROVAL_ID);
      expect(res.decision).toBe("approved");
    });

    it("reddet kararı için üretilen imzayı doğrular", () => {
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "rejected", SECRET);
      const callbackData = `app:${TEST_APPROVAL_ID}:r:${sig}`;

      const res = verifyCallbackData(callbackData, SECRET);
      expect(res.valid).toBe(true);
      expect(res.decision).toBe("rejected");
    });

    it("karar değiştirilmişse (tampered) doğrulamayı reddeder", () => {
      // 'approved' imzası üretilmiş ama callback 'r' (rejected) yapılmış
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "approved", SECRET);
      const tamperedData = `app:${TEST_APPROVAL_ID}:r:${sig}`;

      const res = verifyCallbackData(tamperedData, SECRET);
      expect(res.valid).toBe(false);
    });

    it("farklı bir secret ile doğrulamayı reddeder", () => {
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "approved", SECRET);
      const callbackData = `app:${TEST_APPROVAL_ID}:a:${sig}`;

      const res = verifyCallbackData(callbackData, "wrong-secret-key");
      expect(res.valid).toBe(false);
    });
  });

  describe("renderCfoBriefingTelegram", () => {
    it("CFO brifingini ve inline onay butonlarını eksiksiz üretir", () => {
      const facts: any = {
        todayISO: "2026-10-17",
        availableCash: 1250000,
        minCashFloor: 500000,
        liquidityGap7: null,
        todayOutflowKnown: 150000,
        todayInflowKnown: 220000,
        todayCount: 4,
        overdueCount: 1,
        overdueKnownOutflow: 35000,
        criticalControls: [],
        promisesDueToday: 2,
      };

      const pendingApprovals: any[] = [
        {
          id: TEST_APPROVAL_ID,
          subjectLabel: "Kira Ödemesi",
          subjectTable: "payment_instances",
          amount: 85000,
          currency: "TRY",
        },
      ];

      const msg = renderCfoBriefingTelegram(facts, pendingApprovals, SECRET);

      expect(msg.text).toContain("CFO GÜNLÜK BRİFİNGİ");
      expect(msg.text).toContain("1.250.000");
      expect(msg.text).toContain("Kira Ödemesi");
      expect(msg.reply_markup).toBeDefined();
      expect(msg.reply_markup?.inline_keyboard).toHaveLength(1);
      expect(msg.reply_markup?.inline_keyboard[0][0].text).toContain("Onayla: Kira Ödemesi");
      expect(msg.reply_markup?.inline_keyboard[0][1].text).toBe("❌ Reddet");
    });
  });

  describe("handleTelegramApprovalCallback", () => {
    it("geçerli callback geldiğinde decideApproval fonksiyonunu çağırır", async () => {
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "approved", SECRET);
      const callbackData = `app:${TEST_APPROVAL_ID}:a:${sig}`;

      const res = await handleTelegramApprovalCallback(mockPool, callbackData, "cfo-user-id", SECRET);

      expect(res.ok).toBe(true);
      expect(res.decision).toBe("approved");
      expect(decideApproval).toHaveBeenCalledWith(
        mockPool,
        {
          approvalId: TEST_APPROVAL_ID,
          decision: "approved",
          note: "Telegram CFO Bot üzerinden onaylandı.",
        },
        "cfo-user-id",
      );
    });

    it("iç kontrol gatekeeper blokajı durumunda kullanıcıya açıklayıcı mesaj döner", async () => {
      const sig = generateCallbackSignature(TEST_APPROVAL_ID, "approved", SECRET);
      const callbackData = `app:${TEST_APPROVAL_ID}:a:${sig}`;

      vi.mocked(decideApproval).mockRejectedValueOnce(
        new DomainError("İç kontrol alarmı blokajı: CTRL_IBAN_MISMATCH"),
      );

      const res = await handleTelegramApprovalCallback(mockPool, callbackData, "cfo-user-id", SECRET);

      expect(res.ok).toBe(false);
      expect(res.isBlockedByControls).toBe(true);
      expect(res.message).toContain("ONAY ENGELLENDİ");
      expect(res.message).toContain("CTRL_IBAN_MISMATCH");
    });
  });
});
