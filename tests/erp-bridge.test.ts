import { describe, expect, it } from "vitest";
import {
  getAgentScriptSnippet,
  getSampleErpPayload,
  verifyErpApiKey,
} from "@/lib/erp/bridge";
import {
  mapErpInvoices,
  mapGenericInvoicePayload,
  mapLogoInvoicePayload,
  mapLucaInvoicePayload,
  mapMikroInvoicePayload,
  mapParasutInvoicePayload,
  mapZirveInvoicePayload,
} from "@/lib/erp/mappers";
import {
  ERP_PAYLOAD_TYPES,
  ERP_VENDORS,
  erpWebhookPayloadSchema,
} from "@/lib/erp/types";

describe("ERP & Muhasebe Entegrasyon Köprüsü (Item 4)", () => {
  describe("Vendor List & Schema Validation", () => {
    it("tüm hedeflenen Türk muhasebe ve ERP sistemlerini destekler", () => {
      expect(ERP_VENDORS).toContain("logo");
      expect(ERP_VENDORS).toContain("mikro");
      expect(ERP_VENDORS).toContain("zirve");
      expect(ERP_VENDORS).toContain("parasut");
      expect(ERP_VENDORS).toContain("luca");
      expect(ERP_VENDORS).toContain("generic");
    });

    it("desteklenen veri türleri doğru tanımlanmıştır", () => {
      expect(ERP_PAYLOAD_TYPES).toContain("invoices");
      expect(ERP_PAYLOAD_TYPES).toContain("counterparties");
      expect(ERP_PAYLOAD_TYPES).toContain("checks");
      expect(ERP_PAYLOAD_TYPES).toContain("bank_transactions");
    });

    it("webhook şeması geçerli bir yükü onaylar ve geçersiz olanları reddeder", () => {
      const valid = {
        vendor: "logo",
        payloadType: "invoices",
        data: [{ FICHENO: "FAT-001", GROSSTOTAL: 1000 }],
      };
      expect(erpWebhookPayloadSchema.safeParse(valid).success).toBe(true);

      const invalidVendor = {
        vendor: "sap_non_existent",
        payloadType: "invoices",
        data: [{ FICHENO: "FAT-001" }],
      };
      expect(erpWebhookPayloadSchema.safeParse(invalidVendor).success).toBe(false);

      const emptyData = {
        vendor: "logo",
        payloadType: "invoices",
        data: [],
      };
      expect(erpWebhookPayloadSchema.safeParse(emptyData).success).toBe(false);
    });
  });

  describe("Vendor Mappers", () => {
    it("Logo Yazılım fatura yükünü doğru dönüştürür (TRCODE 8 -> Satış, TRCODE 1 -> Alış)", () => {
      const logoSales = {
        LOGICALREF: "1001",
        FICHENO: "FAT2026-001",
        TRCODE: 8,
        DATE_: "2026-10-18",
        ARP_NAME: "Müşteri Torna A.Ş.",
        TAX_NR: "1234567890",
        NETTOTAL: 100000,
        TOTAL_VAT: 20000,
        GROSSTOTAL: 120000,
        CURRENCY: "TRY",
      };

      const mappedSales = mapLogoInvoicePayload(logoSales, 0);
      expect(mappedSales).not.toBeNull();
      expect(mappedSales?.direction).toBe("sales");
      expect(mappedSales?.grossAmount).toBe(120000);
      expect(mappedSales?.counterpartyName).toBe("Müşteri Torna A.Ş.");
      expect(mappedSales?.invoiceNo).toBe("FAT2026-001");

      const logoPurchase = {
        LOGICALREF: "1002",
        FICHENO: "ALF2026-002",
        TRCODE: 1, // Satınalma
        DATE_: "2026-10-18",
        ARP_NAME: "Hammadde Çelik Ltd.",
        GROSSTOTAL: 50000,
      };

      const mappedPurchase = mapLogoInvoicePayload(logoPurchase, 1);
      expect(mappedPurchase?.direction).toBe("purchase");
      expect(mappedPurchase?.grossAmount).toBe(50000);
    });

    it("Mikro Yazılım fatura yükünü doğru dönüştürür (cha_cinsi)", () => {
      const mikroPurchase = {
        cha_Guid: "guid-mikro-001",
        cha_belge_no: "MKR-0099",
        cha_tarihi: "2026-10-18",
        cha_unvan: "Bursa Rulman Tedarik",
        cha_vergi_no: "9876543210",
        cha_cinsi: 0, // Alış faturası
        cha_meblag: 84000,
        cha_kdv: 14000,
        cha_matrah: 70000,
        cha_dimes: "TRY",
      };

      const mapped = mapMikroInvoicePayload(mikroPurchase, 0);
      expect(mapped).not.toBeNull();
      expect(mapped?.direction).toBe("purchase");
      expect(mapped?.grossAmount).toBe(84000);
      expect(mapped?.counterpartyTaxNo).toBe("9876543210");
    });

    it("Zirve Finansman fatura yükünü doğru dönüştürür", () => {
      const zirveSales = {
        kayitNo: "ZRV-99",
        faturaNo: "ZR-2026-88",
        tarih: "2026-10-18",
        unvan: "Ege Lojistik",
        faturaTipi: "SATIS",
        toplam: 36000,
        kdv: 6000,
        matrah: 30000,
      };

      const mapped = mapZirveInvoicePayload(zirveSales, 0);
      expect(mapped).not.toBeNull();
      expect(mapped?.direction).toBe("sales");
      expect(mapped?.grossAmount).toBe(36000);
      expect(mapped?.counterpartyName).toBe("Ege Lojistik");
    });

    it("Paraşüt API v4 yükünü doğru dönüştürür", () => {
      const parasutSales = {
        id: "prs-1234",
        type: "sales_invoices",
        attributes: {
          invoice_no: "PRS-0012",
          issue_date: "2026-10-18",
          gross_total: 45000,
          total_vat: 7500,
          net_total: 37500,
          currency: "TRY",
        },
        relationships: {
          contact: {
            data: {
              name: "Teknoloji Danışmanlık A.Ş.",
              tax_number: "5554443322",
            },
          },
        },
      };

      const mapped = mapParasutInvoicePayload(parasutSales, 0);
      expect(mapped).not.toBeNull();
      expect(mapped?.direction).toBe("sales");
      expect(mapped?.grossAmount).toBe(45000);
      expect(mapped?.counterpartyName).toBe("Teknoloji Danışmanlık A.Ş.");
      expect(mapped?.counterpartyTaxNo).toBe("5554443322");
    });

    it("Luca e-Defter ve Cari yükünü doğru dönüştürür", () => {
      const lucaRow = {
        islemId: "LCA-101",
        belgeNo: "LCA-FAT-55",
        belgeTarihi: "2026-10-18",
        cariUnvan: "Marmara Kağıt Sanayi",
        borc: 0,
        alacak: 24000,
        dovizCinsi: "TRY",
      };

      const mapped = mapLucaInvoicePayload(lucaRow, 0);
      expect(mapped).not.toBeNull();
      expect(mapped?.direction).toBe("sales");
      expect(mapped?.grossAmount).toBe(24000);
    });

    it("Generic ERP yükünü doğru dönüştürür", () => {
      const genericRow = {
        externalId: "EXT-888",
        invoiceNo: "INV-888",
        direction: "purchase",
        counterpartyName: "Global Hammadde A.Ş.",
        issueDate: "2026-10-18",
        grossAmount: 90000,
      };

      const mapped = mapGenericInvoicePayload(genericRow, 0);
      expect(mapped).not.toBeNull();
      expect(mapped?.direction).toBe("purchase");
      expect(mapped?.grossAmount).toBe(90000);
    });

    it("mapErpInvoices tüm satırları dönüştürür ve geçersiz/sıfır tutarları ayıklar", () => {
      const rows = [
        { FICHENO: "FAT-1", GROSSTOTAL: 1000 },
        { FICHENO: "FAT-2", GROSSTOTAL: 0 }, // Sıfır tutar elenmeli
        { FICHENO: "FAT-3", GROSSTOTAL: 2500 },
      ];
      const result = mapErpInvoices("logo", rows);
      expect(result.length).toBe(2);
      expect(result[0].invoiceNo).toBe("FAT-1");
      expect(result[1].invoiceNo).toBe("FAT-3");
    });
  });

  describe("API Key & Bridge Security", () => {
    it("doğru API anahtarını veya Bearer token'ı onaylar", () => {
      const key = "erp_mas_default_live_key_2026";
      expect(verifyErpApiKey(key)).toBe(true);
      expect(verifyErpApiKey(`Bearer ${key}`)).toBe(true);
      expect(verifyErpApiKey("wrong_key_12345")).toBe(false);
      expect(verifyErpApiKey(null)).toBe(false);
      expect(verifyErpApiKey("")).toBe(false);
    });

    it("her ERP vendor'u için geçerli şemaya uygun örnek yük üretir", () => {
      for (const vendor of ERP_VENDORS) {
        const sample = getSampleErpPayload(vendor);
        expect(sample.vendor).toBe(vendor);
        expect(sample.data.length).toBeGreaterThan(0);
        const parseCheck = erpWebhookPayloadSchema.safeParse(sample);
        expect(parseCheck.success).toBe(true);
      }
    });

    it("BT ekipleri için çalışan Python ve PowerShell ajan betikleri üretir", () => {
      const snippets = getAgentScriptSnippet("http://localhost:3000", "test_key_123");
      expect(snippets.powershell).toContain("Invoke-RestMethod");
      expect(snippets.powershell).toContain("http://localhost:3000/api/erp/webhook");
      expect(snippets.powershell).toContain("test_key_123");

      expect(snippets.python).toContain("requests.post");
      expect(snippets.python).toContain("http://localhost:3000/api/erp/webhook");
      expect(snippets.python).toContain("test_key_123");
    });
  });
});
