import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadActiveFacilities,
  computeTreasuryShieldReport,
} from "@/lib/treasury/headroom-engine";
import { cache } from "@/lib/cache/engine";

describe("Kilit Taşı 4: Kredi Limiti ve Hazine Rezerv Kalkanı", () => {
  let mockPool: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    await cache.clear();
    mockPool = {
      query: vi.fn(),
    };
  });

  it("aktif kredi limitlerini çeker ve kullanılabilir tutarları doğru hesaplar", async () => {
    mockPool.query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        {
          facility_id: "fac-1",
          facility_name: "Garanti BCH",
          facility_type: "revolving",
          currency: "TRY",
          lender_name: "Garanti BBVA",
          limit_amount: "2000000.00",
          drawn_amount: "500000.00",
          available_amount: "1500000.00",
          utilization_ratio: "0.2500",
          interest_rate: "42.5000",
          days_to_expiry: 180,
        },
      ],
    });

    const list = await loadActiveFacilities(mockPool);
    expect(list).toHaveLength(1);
    expect(list[0].facilityName).toBe("Garanti BCH");
    expect(list[0].availableAmount).toBe(1500000);
    expect(list[0].interestRate).toBe(42.5);
  });

  it("gelecek nakit açığını en ucuz faizli krediyle eşleştirerek reçete üretir", async () => {
    // 1. Kredi limitleri (2 banka: Biri %40 faiz, diğeri %48 faiz)
    mockPool.query
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          {
            facility_id: "fac-cheap",
            facility_name: "Akbank Rotatif",
            facility_type: "revolving",
            currency: "TRY",
            lender_name: "Akbank",
            limit_amount: "1000000.00",
            drawn_amount: "0.00",
            available_amount: "1000000.00",
            utilization_ratio: "0.0000",
            interest_rate: "40.0000",
            days_to_expiry: 90,
          },
          {
            facility_id: "fac-expensive",
            facility_name: "İş Bankası Spot",
            facility_type: "spot",
            currency: "TRY",
            lender_name: "İş Bankası",
            limit_amount: "2000000.00",
            drawn_amount: "0.00",
            available_amount: "2000000.00",
            utilization_ratio: "0.0000",
            interest_rate: "48.0000",
            days_to_expiry: 120,
          },
        ],
      })
      // 2. Nakit açığı: 600.000 TL açık var
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            forecast_date: "2026-11-05",
            week_number: 3,
            closing_cash: "-550000.00", // minBuffer 50k olduğuna göre açık = 600.000 TL
          },
        ],
      });

    const report = await computeTreasuryShieldReport(mockPool, { minBuffer: 50000, bypassCache: true });

    expect(report.totalCreditLimit).toBe(3000000);
    expect(report.totalAvailableHeadroom).toBe(3000000);
    expect(report.deficitsIdentified).toBe(1);

    // Eşleşme kontrolü: 600.000 TL'lik açık EN UCUZ olan Akbank'tan (%40) karşılanmalı
    expect(report.recommendations).toHaveLength(1);
    const rec = report.recommendations[0];
    expect(rec.recommendedFacilityId).toBe("fac-cheap");
    expect(rec.recommendedDrawdown).toBe(600000);
    expect(rec.coverageStatus).toBe("fully_covered");
    expect(rec.interestRate).toBe(40);
  });
});
