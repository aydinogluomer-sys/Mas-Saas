import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractInvoiceNoCandidate,
  calculateTextOverlap,
  findAutoMatchCandidates,
  runAutoReconciliation,
} from "@/lib/reconciliation/auto-matcher";
import { cache } from "@/lib/cache/engine";

describe("Kilit Taşı 1: Otomatik 3'lü Mutabakat Motoru", () => {
  describe("Yardımcı Fonksiyonlar", () => {
    it("açıklamadan fatura numarasını doğru ayıklar", () => {
      expect(extractInvoiceNoCandidate("Ödeme: GIB2026000012345 faturası")).toBe("GIB2026000012345");
      expect(extractInvoiceNoCandidate("FT NO: MAS202699887711")).toBe("MAS202699887711");
      expect(extractInvoiceNoCandidate("Açıklamasız rastgele metin")).toBeNull();
    });

    it("metin benzerliğini kelime örtüşmesiyle hesaplar", () => {
      const score1 = calculateTextOverlap("Mas Makina Sanayi Ltd.", "MAS MAKİNA SANAYİ");
      expect(score1).toBeGreaterThanOrEqual(0.75);

      const score2 = calculateTextOverlap("Alakasız Şirket A.Ş.", "Başka Bir Tedarikçi");
      expect(score2).toBe(0);
    });
  });

  describe("Auto Matcher Veritabanı Mantığı", () => {
    let mockClient: any;
    let mockPool: any;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      mockPool = {
        connect: vi.fn().mockResolvedValue(mockClient),
      };
    });

    it("açıklamasında fatura no ve tutarı uyuşan işlemi %100 güvenle eşleştirir", async () => {
      // 1. Banka hareketi mock
      mockClient.query
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: "txn-1",
              amount: "15000.00",
              booking_date: "2026-10-15",
              description: "Havale GIB2026000011111 bedeli",
              counterparty_name_raw: "Alıcı A.Ş.",
              counterparty_iban: "TR11000",
            },
          ],
        })
        // 2. Açık fatura mock
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: "inv-1",
              invoice_no: "GIB2026000011111",
              direction: "sales",
              total_amount: "15000.00",
              paid_amount: "0.00",
              issue_date: "2026-10-10",
              due_date: "2026-10-20",
              party_name: "Alıcı Ticaret A.Ş.",
              party_tax_id: "1234567890",
            },
          ],
        });

      const candidates = await findAutoMatchCandidates(mockClient);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].confidence).toBe(1.0);
      expect(candidates[0].matchRule).toBe("EXACT_INVOICE_NO");
      expect(candidates[0].invoiceId).toBe("inv-1");
    });

    it("runAutoReconciliation işlemi yürüttüğünde faturayı kapatır ve cache'i temizler", async () => {
      const invalidateSpy = vi.spyOn(cache, "invalidateTags");

      // Transaction begin
      mockClient.query.mockResolvedValueOnce({});
      // Txns
      mockClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "txn-2",
            amount: "5000.00",
            booking_date: "2026-10-16",
            description: "GIB2026000022222",
            counterparty_name_raw: "Test",
            counterparty_iban: null,
          },
        ],
      });
      // Invoices
      mockClient.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            id: "inv-2",
            invoice_no: "GIB2026000022222",
            direction: "sales",
            total_amount: "5000.00",
            paid_amount: "0.00",
            issue_date: "2026-10-15",
            due_date: null,
            party_name: "Test",
            party_tax_id: null,
          },
        ],
      });
      // update bank_transactions
      mockClient.query.mockResolvedValueOnce({});
      // insert invoice_allocations
      mockClient.query.mockResolvedValueOnce({});
      // update invoices
      mockClient.query.mockResolvedValueOnce({ rows: [{ total_amount: "5000.00", paid_amount: "5000.00" }] });
      // audit
      mockClient.query.mockResolvedValueOnce({ rows: [{ id: "audit-1" }] });
      // commit
      mockClient.query.mockResolvedValueOnce({});

      const report = await runAutoReconciliation(mockPool);

      expect(report.autoMatched).toBe(1);
      expect(report.totalAllocated).toBe(5000);
      expect(invalidateSpy).toHaveBeenCalled();
    });
  });
});
