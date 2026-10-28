import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkBudgetHeadroom } from "@/lib/budget/guardrail";

describe("Kilit Taşı 5: Harcama Anında Bütçe Aşım Kilidi", () => {
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      query: vi.fn(),
    };
  });

  it("masraf merkezi belirtilmemişse kısıt uygulamaz", async () => {
    const res = await checkBudgetHeadroom(mockClient, { amount: 50000 });
    expect(res.allowed).toBe(true);
    expect(res.requiresCfoOverride).toBe(false);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it("dönem için bütçe tanımlanmamışsa bilgi mesajıyla izin verir", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 0,
      rows: [],
    });

    const res = await checkBudgetHeadroom(mockClient, {
      costCenterId: "cc-100",
      amount: 15000,
      currency: "TRY",
      date: "2026-10-15",
    });

    expect(res.allowed).toBe(true);
    expect(res.budgetAllocated).toBe(false);
  });

  it("harcama bütçe sınırları içindeyse onay verir", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          budget_amount: "100000.00",
          actual_amount: "40000.00",
          cost_center_name: "Pazarlama Departmanı",
          project_name: null,
        },
      ],
    });

    const res = await checkBudgetHeadroom(mockClient, {
      costCenterId: "cc-pazarlama",
      amount: 30000, // Toplam 70.000 TL olacak (100.000 TL altında)
      currency: "TRY",
      date: "2026-10-15",
    });

    expect(res.allowed).toBe(true);
    expect(res.requiresCfoOverride).toBe(false);
    expect(res.remainingBefore).toBe(60000);
    expect(res.utilizationAfter).toBe(0.7);
  });

  it("harcama bütçe tavanını aştığında işlemi kilitler ve CFO onayını zorunlu kılar", async () => {
    mockClient.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          budget_amount: "100000.00",
          actual_amount: "80000.00",
          cost_center_name: "IT ve Yazılım",
          project_name: null,
        },
      ],
    });

    const res = await checkBudgetHeadroom(mockClient, {
      costCenterId: "cc-it",
      amount: 45000, // Toplam 125.000 TL olacak (25.000 TL aşım!)
      currency: "TRY",
      date: "2026-10-15",
    });

    expect(res.allowed).toBe(false);
    expect(res.requiresCfoOverride).toBe(true);
    expect(res.overrunAmount).toBe(25000);
    expect(res.utilizationAfter).toBe(1.25);
    expect(res.message).toContain("BÜTÇE AŞIM BLOKAJI");
    expect(res.message).toContain("CFO Bütçe Revizyon Onayına yönlendirildi");
  });
});
