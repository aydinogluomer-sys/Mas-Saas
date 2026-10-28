import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCurrentAccounts: vi.fn(),
  loadCurrentAccountLedger: vi.fn(),
  loadReceivableTotals: vi.fn(),
  loadPayableTotals: vi.fn(),
}));

vi.mock("@/lib/receivables/engine", () => mocks);

import { answerTelegramQuestion } from "./assistant";

const pool = {} as never;
const account = {
  partyId: "party-1",
  partyName: "Akon Endüstri",
  partyType: "customer",
  receivableOpen: 1_250_000,
  payableOpen: 180_000,
  receivableCount: 3,
  payableCount: 1,
  overdueCount: 2,
  earliestDueDate: "2026-08-30",
  salesTotal: 2_000_000,
  purchaseTotal: 200_000,
  lastInvoiceDate: "2026-08-28",
};

describe("Telegram salt-okunur asistanı", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCurrentAccounts.mockResolvedValue([account]);
    mocks.loadCurrentAccountLedger.mockResolvedValue([]);
    mocks.loadReceivableTotals.mockResolvedValue({ totalOpenAmount: 2_500_000, overdueCount: 4 });
    mocks.loadPayableTotals.mockResolvedValue({ totalOpenAmount: 900_000, overdueCount: 1 });
  });

  it("firma adıyla cari özetini mevcut motor üzerinden getirir", async () => {
    const result = await answerTelegramQuestion(pool, "Akon firmasının carisi nedir?", "2026-08-29");

    expect(result.kind).toBe("current_account");
    expect(result.answer).toContain("Akon Endüstri");
    expect(result.answer).toContain("Net alacak");
    expect(mocks.loadCurrentAccounts).toHaveBeenCalledWith(pool, 500);
  });

  it("son hareketleri en yeniden eskiye ve istenen adetle döndürür", async () => {
    mocks.loadCurrentAccountLedger.mockResolvedValue([
      { movementDate: "2026-08-20", movementType: "invoice", reference: "F-1", debitAmount: 100, creditAmount: 0 },
      { movementDate: "2026-08-28", movementType: "payment", reference: "T-1", debitAmount: 0, creditAmount: 40 },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");

    expect(result.kind).toBe("current_account_ledger");
    expect(result.answer.indexOf("T-1")).toBeLessThan(result.answer.indexOf("F-1"));
  });

  it("toplam açık alacağı limitli satır toplamı yerine totals motorundan alır", async () => {
    const result = await answerTelegramQuestion(pool, "Toplam açık alacak ne kadar?", "2026-08-29");

    expect(result.kind).toBe("receivable_total");
    expect(mocks.loadReceivableTotals).toHaveBeenCalledWith(pool, "2026-08-29");
    expect(result.answer).toContain("2.500.000");
  });

  it("veri değiştirme talebini hiçbir veri motoruna gitmeden reddeder", async () => {
    const result = await answerTelegramQuestion(pool, "Akon kaydını sil", "2026-08-29");

    expect(result.kind).toBe("refused");
    expect(mocks.loadCurrentAccounts).not.toHaveBeenCalled();
  });
});
