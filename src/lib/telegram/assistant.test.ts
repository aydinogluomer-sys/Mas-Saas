import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCurrentAccounts: vi.fn(),
  loadLatestLedgerMovements: vi.fn(),
  loadReceivableTotals: vi.fn(),
  loadPayableTotals: vi.fn(),
}));

vi.mock("@/lib/receivables/engine", () => mocks);

import { answerTelegramQuestion, ledgerMovementSide } from "./assistant";

const pool = {} as never;
const account = {
  partyId: "party-1",
  partyName: "Akon Endüstri",
  partyType: "customer",
  // Any synthetic figure works (no assertion reads it). It is deliberately not one of the fallback
  // amounts the removed financial chains hard-coded, which the Wave 0 exit check greps src/ for.
  receivableOpen: 1_320_000,
  payableOpen: 180_000,
  receivableCount: 3,
  payableCount: 1,
  overdueCount: 2,
  earliestDueDate: "2026-08-30",
  salesTotal: 2_000_000,
  purchaseTotal: 200_000,
  lastInvoiceDate: "2026-08-28",
  foreignCurrencyCount: 0,
};

const lineWith = (answer: string, needle: string) => answer.split("\n").find((l) => l.includes(needle)) ?? "";

describe("Telegram salt-okunur asistanı", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCurrentAccounts.mockResolvedValue([account]);
    mocks.loadLatestLedgerMovements.mockResolvedValue([]);
    mocks.loadReceivableTotals.mockResolvedValue({ totalOpenAmount: 2_500_000, overdueCount: 4, foreignCount: 0 });
    mocks.loadPayableTotals.mockResolvedValue({ totalOpenAmount: 900_000, overdueCount: 1, foreignCount: 0 });
  });

  it("firma adıyla cari özetini mevcut motor üzerinden getirir", async () => {
    const result = await answerTelegramQuestion(pool, "Akon firmasının carisi nedir?", "2026-08-29");

    expect(result.kind).toBe("current_account");
    expect(result.answer).toContain("Akon Endüstri");
    expect(result.answer).toContain("Net alacak");
    expect(mocks.loadCurrentAccounts).toHaveBeenCalledWith(pool, 500);
  });

  it("son hareketleri en yeniden eskiye ve istenen adetle döndürür", async () => {
    // The reader already returns newest first (the order is decided in SQL — see
    // assistant-ledger.test.ts for the unmocked proof); the assistant must keep that order.
    mocks.loadLatestLedgerMovements.mockResolvedValue([
      { movementDate: "2026-08-28", movementType: "payment", reference: "T-1", debitAmount: 0, creditAmount: 40, currency: "TRY" },
      { movementDate: "2026-08-20", movementType: "invoice", reference: "F-1", debitAmount: 100, creditAmount: 0, currency: "TRY" },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");

    expect(result.kind).toBe("current_account_ledger");
    expect(result.answer.indexOf("T-1")).toBeLessThan(result.answer.indexOf("F-1"));
    // The requested count goes to the reader (default 10), not a fixed 200-row window.
    expect(mocks.loadLatestLedgerMovements).toHaveBeenCalledWith(pool, "party-1", 10);
  });

  it("/hareket çıktısında fatura yönüne göre satış/tahsilat ile alış/ödeme etiketlerini ayırır", async () => {
    mocks.loadLatestLedgerMovements.mockResolvedValue([
      { movementDate: "2026-08-28", movementType: "tahsilat", reference: "TAH-1", direction: "sales", debitAmount: 0, creditAmount: 400, currency: "TRY" },
      { movementDate: "2026-08-27", movementType: "fatura (satış)", reference: "SAT-1", direction: "sales", debitAmount: 1_000, creditAmount: 0, currency: "TRY" },
      { movementDate: "2026-08-26", movementType: "ödeme", reference: "ODE-1", direction: "purchase", debitAmount: 0, creditAmount: 300, currency: "TRY" },
      { movementDate: "2026-08-25", movementType: "fatura (alış)", reference: "ALI-1", direction: "purchase", debitAmount: 750, creditAmount: 0, currency: "TRY" },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");

    expect(lineWith(result.answer, "SAT-1")).toContain("satış faturası (alacak)");
    expect(lineWith(result.answer, "TAH-1")).toContain("tahsilat (alacak kapama)");
    expect(lineWith(result.answer, "ALI-1")).toContain("alış faturası (borç)");
    expect(lineWith(result.answer, "ODE-1")).toContain("ödeme (borç kapama)");
  });

  it("/hareket fatura yönü varyantlarını (sale/satış vs purchase/alış ve 0099 borç/alacak işaretini) doğru etiketler (Dalga 1 #6)", async () => {
    mocks.loadLatestLedgerMovements.mockResolvedValue([
      // 0099 gerçek SQL görünümü: alış faturası +creditAmount, tedarikçi ödemesi +debitAmount
      { movementDate: "2026-08-29", movementType: "fatura", reference: "ALI-0099", direction: "purchase", debitAmount: 0, creditAmount: 1_500, currency: "TRY" },
      { movementDate: "2026-08-28", movementType: "ödeme", reference: "ODE-0099", direction: "purchase", debitAmount: 600, creditAmount: 0, currency: "TRY" },
      // Türkçe direction belirteçleri ('alış' / 'satış') ve tekil 'sale'
      { movementDate: "2026-08-27", movementType: "invoice", reference: "ALI-TR", direction: "alış", debitAmount: 0, creditAmount: 820, currency: "TRY" },
      { movementDate: "2026-08-26", movementType: "invoice", reference: "SAT-TR", direction: "satış", debitAmount: 940, creditAmount: 0, currency: "TRY" },
      { movementDate: "2026-08-25", movementType: "invoice", reference: "SAT-EN", direction: "sale", debitAmount: 510, creditAmount: 0, currency: "TRY" },
      // direction boşken borç/alacak (debit/credit) işaretinden yön çıkarımı — sabit tek yön etiketi yok
      { movementDate: "2026-08-24", movementType: "invoice", reference: "SIGN-PUR", direction: null, debitAmount: 0, creditAmount: 430, currency: "TRY" },
      { movementDate: "2026-08-23", movementType: "invoice", reference: "SIGN-SAL", direction: null, debitAmount: 390, creditAmount: 0, currency: "TRY" },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");

    expect(lineWith(result.answer, "ALI-0099")).toContain("₺1.500,00 alış faturası (borç)");
    expect(lineWith(result.answer, "ODE-0099")).toContain("₺600,00 ödeme (borç kapama)");
    expect(lineWith(result.answer, "ALI-TR")).toContain("alış faturası (borç)");
    expect(lineWith(result.answer, "SAT-TR")).toContain("satış faturası (alacak)");
    expect(lineWith(result.answer, "SAT-EN")).toContain("satış faturası (alacak)");
    expect(lineWith(result.answer, "SIGN-PUR")).toContain("alış faturası (borç)");
    expect(lineWith(result.answer, "SIGN-SAL")).toContain("satış faturası (alacak)");

    expect(ledgerMovementSide({ movementType: "payment", direction: null, debitAmount: 250, creditAmount: 0 })).toEqual({
      amount: 250,
      label: "ödeme (borç kapama)",
    });
    expect(ledgerMovementSide({ movementType: "payment", direction: null, debitAmount: 0, creditAmount: 250 })).toEqual({
      amount: 250,
      label: "tahsilat (alacak kapama)",
    });
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

describe("Telegram asistanı — tutarlar dürüst etiketlenir (yalnız TRY toplamlar, kendi para birimindeki hareketler)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCurrentAccounts.mockResolvedValue([account]);
    mocks.loadReceivableTotals.mockResolvedValue({ totalOpenAmount: 2_500_000, overdueCount: 4, foreignCount: 3 });
    mocks.loadPayableTotals.mockResolvedValue({ totalOpenAmount: 900_000, overdueCount: 1, foreignCount: 0 });
  });

  it("TRY dışı cari hareketi kendi para birimiyle yazar, asla TL olarak değil", async () => {
    mocks.loadLatestLedgerMovements.mockResolvedValue([
      { movementDate: "2026-08-20", movementType: "fatura (satış)", reference: "F-USD", debitAmount: 1_250, creditAmount: 0, currency: "USD" },
      { movementDate: "2026-08-21", movementType: "fatura (satış)", reference: "F-TRY", debitAmount: 5_000, creditAmount: 0, currency: "TRY" },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");

    const usd = lineWith(result.answer, "F-USD");
    expect(usd).toContain("USD");
    expect(usd).not.toContain("₺");
    expect(usd).not.toMatch(/\bTL\b|TRY/);
    expect(lineWith(result.answer, "F-TRY")).toContain("₺");
    expect(result.answer).toContain("kendi para birimindedir; kur çevrimi yapılmaz");
  });

  it("para birimi bilinmeyen hareketi bilinmiyor olarak yazar, TL varsaymaz", async () => {
    mocks.loadLatestLedgerMovements.mockResolvedValue([
      { movementDate: "2026-08-20", movementType: "tahsilat", reference: "manual", debitAmount: 0, creditAmount: 40, currency: null },
    ]);

    const result = await answerTelegramQuestion(pool, "/hareket Akon", "2026-08-29");
    const line = lineWith(result.answer, "manual");
    expect(line).toContain("para birimi bilinmiyor");
    expect(line).not.toContain("₺");
  });

  it("toplam açık alacak 'yalnız TRY' diye etiketlenir ve dışarıda kalan TRY dışı kalemleri sayar", async () => {
    const result = await answerTelegramQuestion(pool, "Toplam açık alacak ne kadar?", "2026-08-29");

    expect(lineWith(result.answer, "Toplam açık alacak")).toContain("yalnız TRY");
    expect(result.answer).toContain("TRY dışı 3 açık kalem bu toplama dahil değil");
  });

  it("toplam açık borç da 'yalnız TRY'; TRY dışı kalem yoksa uydurma bir satır eklenmez", async () => {
    const result = await answerTelegramQuestion(pool, "Toplam açık borç ne kadar?", "2026-08-29");

    expect(lineWith(result.answer, "Toplam açık borç")).toContain("yalnız TRY");
    expect(result.answer).not.toContain("TRY dışı");
  });

  it("cari özet tutarları 'yalnız TRY' der ve TRY dışı fatura sayısını belirtir", async () => {
    mocks.loadCurrentAccounts.mockResolvedValue([{ ...account, foreignCurrencyCount: 2 }]);

    const result = await answerTelegramQuestion(pool, "/cari Akon", "2026-08-29");

    for (const label of ["Açık alacak", "Açık borç", "Net alacak"]) {
      expect(lineWith(result.answer, label), label).toContain("yalnız TRY");
    }
    expect(result.answer).toContain("TRY dışı 2 fatura bu tutarlara dahil değil");
  });
});
