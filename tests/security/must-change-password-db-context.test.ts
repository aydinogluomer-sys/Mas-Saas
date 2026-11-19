import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth";

const mockGetRequestUser = vi.hoisted(() => vi.fn<() => Promise<SessionUser | null>>());

vi.mock("@/lib/auth", () => ({
  getRequestUser: mockGetRequestUser,
}));

import { getDbContext } from "@/lib/authz/context";
import { APP_ROLES, DB_ROLE } from "@/lib/authz/matrix";

describe("Dalga 1 #1 — getDbContext zorunlu parola değişiminde iş katmanı (DB tier) vermez", () => {
  beforeEach(() => {
    mockGetRequestUser.mockReset();
  });

  it("normal aktif kullanıcı kendi uygulama rolüne karşılık gelen DB katmanını alır", async () => {
    for (const role of APP_ROLES) {
      mockGetRequestUser.mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        username: "aktif.kullanici",
        displayName: "Aktif Kullanıcı",
        role,
        mustChangePassword: false,
      });

      const ctx = await getDbContext();
      expect(ctx).toEqual({
        dbRole: DB_ROLE[role],
        userId: "11111111-1111-4111-8111-111111111111",
        role,
        legalEntityId: null,
      });
    }
  });

  it("mustChangePassword === true olan oturuma (admin dahil) EMPTY döner", async () => {
    for (const role of APP_ROLES) {
      mockGetRequestUser.mockResolvedValueOnce({
        id: "22222222-2222-4222-8222-222222222222",
        username: "zorunlu.degisim",
        displayName: "Zorunlu Değişim",
        role,
        mustChangePassword: true,
      });

      const ctx = await getDbContext();
      expect(ctx).toEqual({
        dbRole: null,
        userId: null,
        role: null,
        legalEntityId: null,
      });
    }
  });

  it("oturumsuz istek veya tanınmayan rol için EMPTY döner", async () => {
    mockGetRequestUser.mockResolvedValueOnce(null);
    expect(await getDbContext()).toEqual({
      dbRole: null,
      userId: null,
      role: null,
      legalEntityId: null,
    });

    mockGetRequestUser.mockResolvedValueOnce({
      id: "33333333-3333-4333-8333-333333333333",
      username: "bilinmeyen.rol",
      displayName: "Bilinmeyen Rol",
      role: "super_root" as never,
      mustChangePassword: false,
    });
    expect(await getDbContext()).toEqual({
      dbRole: null,
      userId: null,
      role: null,
      legalEntityId: null,
    });
  });
});

