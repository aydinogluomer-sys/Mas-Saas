import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    token: "req-dedup-token" as string | null,
    row: null as null | {
      id: string;
      username: string;
      display_name: string;
      role: string;
      must_change_password: boolean;
      session_id: string;
      last_seen_at: string | null;
      created_at: string;
    },
    calls: [] as string[],
    failNextLookup: false,
    localPasswordless: false,
  };
  const pool = {
    query: async (text: string) => {
      state.calls.push(text);
      if (text.includes("from public.sessions s join public.users u")) {
        if (state.failNextLookup) {
          state.failNextLookup = false;
          throw new Error("transient_db_error");
        }
        return state.row ? { rowCount: 1, rows: [state.row] } : { rowCount: 0, rows: [] };
      }
      if (text.includes("update public.sessions set revoked_at = now()")) {
        state.row = null;
      }
      return { rowCount: 1, rows: [] };
    },
  };
  return { state, pool };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "mas_session" && h.state.token ? { value: h.state.token } : undefined),
    set: () => {},
    delete: () => {
      h.state.token = null;
    },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/db", () => ({ getRawPool: () => h.pool }));
vi.mock("@/lib/env", () => ({
  env: {
    qaBypassAuth: false,
    get localPasswordless() {
      return h.state.localPasswordless;
    },
  },
}));
vi.mock("@node-rs/argon2", () => ({ hash: async () => "x", verify: async () => false }));

import {
  getRequestUser,
  requireApiSession,
  requireSession,
  revokeCurrentSession,
  withRequestSessionScope,
} from "@/lib/auth";
import { getDbContext } from "@/lib/authz/context";

const sessionLookups = () => h.state.calls.filter((t) => t.includes("from public.sessions s join public.users u"));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  h.state.token = "req-dedup-token";
  h.state.calls = [];
  h.state.failNextLookup = false;
  h.state.localPasswordless = false;
  h.state.row = {
    id: "22222222-2222-4222-8222-222222222222",
    username: "atilla",
    display_name: "Atilla",
    role: "finance_manager",
    must_change_password: false,
    session_id: "44444444-4444-4444-8444-444444444444",
    last_seen_at: minutesAgo(1),
    created_at: minutesAgo(15),
  };
});

describe("Faz 1 — İstek bazlı oturum tekilleştirme (getRequestUser)", () => {
  it("aynı istek kapsamında DashboardLayout + Modül Layout + Sayfa + getDbContext yalnız 1 DB sorgusu atar", async () => {
    await withRequestSessionScope(async () => {
      const [layoutUser, moduleUser, pageUser, dbCtx1, dbCtx2] = await Promise.all([
        requireSession(),
        requireSession(),
        requireApiSession(),
        getDbContext(),
        getDbContext(),
      ]);

      expect(layoutUser.username).toBe("atilla");
      expect(moduleUser.id).toBe(layoutUser.id);
      expect(pageUser?.role).toBe("finance_manager");
      expect(dbCtx1.dbRole).toBe("mas_radar_finance_manager");
      expect(dbCtx2.userId).toBe(layoutUser.id);
    });

    expect(sessionLookups()).toHaveLength(1);
  });

  it("iki ayrı HTTP isteği arasında hiçbir önbellek taşınmaz: rol değişimi ve iptal anında yansır", async () => {
    const firstRole = await withRequestSessionScope(async () => (await requireSession()).role);
    expect(firstRole).toBe("finance_manager");

    // DB'de rol değişti
    h.state.row = { ...h.state.row!, role: "viewer" };
    const secondRole = await withRequestSessionScope(async () => (await requireSession()).role);
    expect(secondRole).toBe("viewer");

    // DB'de oturum iptal edildi
    h.state.row = null;
    await expect(withRequestSessionScope(() => requireSession())).rejects.toThrow("REDIRECT /login");
    expect(sessionLookups()).toHaveLength(3);
  });

  it("aynı istek içinde revokeCurrentSession çağrılırsa istek içi önbellek derhal temizlenir", async () => {
    await withRequestSessionScope(async () => {
      expect((await getRequestUser())?.username).toBe("atilla");
      await revokeCurrentSession();
      expect(await getRequestUser()).toBeNull();
    });
  });

  it("geçici DB hatası sözü (promise) önbellekte sıkışıp kalmaz", async () => {
    await withRequestSessionScope(async () => {
      h.state.failNextLookup = true;
      await expect(getRequestUser()).rejects.toThrow("transient_db_error");
      const recovered = await getRequestUser();
      expect(recovered?.username).toBe("atilla");
    });
    expect(sessionLookups()).toHaveLength(2);
  });

  it("localPasswordless açıkken bile iptal edilmiş çerezle gelen istek DEFAULT_LOCAL_USER'a düşmez", async () => {
    h.state.localPasswordless = true;
    h.state.token = "revoked-session-cookie";
    h.state.row = null;

    await withRequestSessionScope(async () => {
      expect(await getRequestUser()).toBeNull();
      expect(await requireApiSession()).toBeNull();
      await expect(requireSession()).rejects.toThrow("REDIRECT /login");
    });
    expect(sessionLookups()).toHaveLength(1);
  });
});

