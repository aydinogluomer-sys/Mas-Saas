import { describe, expect, it, vi } from "vitest";
import { createBranch, createLegalEntity, getActiveEntityScope, listLegalEntities } from "./engine";
import { DomainError } from "@/lib/domain-error";

describe("Grup İçi Çoklu Tüzel Kişilik Motoru (legal_entities & branches)", () => {
  it("listLegalEntities aktif şirketleri döner ve şema öncesi hatada güvenli boş dizi verir", async () => {
    const okDb = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            code: "MAS-HQ",
            name: "MAS Makina ve Finans A.Ş.",
            tax_id_vkn: "6120000001",
            mersis_no: null,
            tax_office: "Kurumlar V.D.",
            base_currency: "TRY",
            is_default: true,
            is_active: true,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    };

    const entities = await listLegalEntities(okDb as never);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      code: "MAS-HQ",
      taxIdVkn: "6120000001",
      baseCurrency: "TRY",
      isDefault: true,
    });

    const brokenDb = {
      query: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    };
    expect(await listLegalEntities(brokenDb as never)).toEqual([]);
  });

  it("getActiveEntityScope çerez olmadığında konsolide grup modunda döner", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const scope = await getActiveEntityScope(db as never);
    expect(scope.mode).toBe("consolidated");
    expect(scope.legalEntityId).toBeNull();
    expect(scope.branchId).toBeNull();
  });

  it("createLegalEntity ve createBranch geçersiz girdide DomainError(VALIDATION_ERROR) fırlatır", async () => {
    const fakePool = { connect: vi.fn() };
    await expect(
      createLegalEntity(fakePool as never, { code: "X", name: "", baseCurrency: "invalid" }, null),
    ).rejects.toBeInstanceOf(DomainError);

    await expect(
      createBranch(fakePool as never, { legalEntityId: "not-a-uuid", code: "", name: "" }, null),
    ).rejects.toBeInstanceOf(DomainError);
    expect(fakePool.connect).not.toHaveBeenCalled();
  });
});

