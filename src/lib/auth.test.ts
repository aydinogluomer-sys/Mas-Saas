// Wave 0 — the session lookup is uncached again, and JSON routes honour the forced password change.
//
// The unreviewed layer cached getCurrentUser() for 30 seconds per process. That meant a revoked
// session, a deactivated user or a role change kept working for up to half a minute, and nothing
// outside the user's own logout could clear it. These tests pin the restored behaviour without a
// database: a fake raw pool answers the session query, and each assertion is about what the NEXT
// call sees after the row changes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    token: "oturum-belirteci" as string | null,
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
    /** Makes the last_seen bump fail, to prove it is awaited rather than fired and forgotten. */
    failBump: false,
  };
  const pool = {
    query: async (text: string) => {
      state.calls.push(text);
      if (text.includes("from public.sessions s join public.users u")) {
        return state.row ? { rowCount: 1, rows: [state.row] } : { rowCount: 0, rows: [] };
      }
      if (text.includes("set last_seen_at") && state.failBump) throw new Error("bump başarısız");
      return { rowCount: 1, rows: [] };
    },
  };
  return { state, pool };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "mas_session" && h.state.token ? { value: h.state.token } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/db", () => ({ getRawPool: () => h.pool }));
vi.mock("@/lib/env", () => ({ env: { qaBypassAuth: false } }));
// The real argon2 binding is irrelevant here and slow to load; nothing below hashes a password.
vi.mock("@node-rs/argon2", () => ({ hash: async () => "x", verify: async () => false }));

import { getCurrentUser, requireApiSession, requireSession } from "./auth";

const sessionLookups = () => h.state.calls.filter((t) => t.includes("from public.sessions s join public.users u"));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  h.state.token = "oturum-belirteci";
  h.state.calls = [];
  h.state.failBump = false;
  h.state.row = {
    id: "11111111-1111-4111-8111-111111111111",
    username: "ayse",
    display_name: "Ayşe",
    role: "viewer",
    must_change_password: false,
    session_id: "33333333-3333-4333-8333-333333333333",
    last_seen_at: minutesAgo(1),
    created_at: minutesAgo(30),
  };
});

describe("getCurrentUser — süreç içi oturum önbelleği yok", () => {
  it("her çağrı oturum satırını veritabanından yeniden okur", async () => {
    await getCurrentUser();
    await getCurrentUser();
    expect(sessionLookups()).toHaveLength(2);
  });

  it("oturum iptal edilince BİR SONRAKİ çağrı null döner", async () => {
    expect(await getCurrentUser()).not.toBeNull();
    h.state.row = null; // revoked_at set, user deactivated or session expired: the query finds nothing
    expect(await getCurrentUser()).toBeNull();
  });

  it("rol değişikliği bir sonraki çağrıda görünür", async () => {
    expect((await getCurrentUser())?.role).toBe("viewer");
    h.state.row = { ...h.state.row!, role: "finance_manager" };
    expect((await getCurrentUser())?.role).toBe("finance_manager");
  });

  it("boşta kalma penceresi (60 dk) aşılınca oturum iptal edilir ve null döner", async () => {
    h.state.row = { ...h.state.row!, last_seen_at: minutesAgo(61) };
    expect(await getCurrentUser()).toBeNull();
    expect(h.state.calls.some((t) => t.includes("set revoked_at = now()"))).toBe(true);
  });

  it("last_seen güncellemesi BEKLENİR (ateşle-unut değil): başarısızlık çağırana ulaşır", async () => {
    h.state.row = { ...h.state.row!, last_seen_at: minutesAgo(6) };
    h.state.failBump = true;
    await expect(getCurrentUser()).rejects.toThrow("bump başarısız");
  });

  it("çerez yoksa veritabanına hiç gidilmez", async () => {
    h.state.token = null;
    expect(await getCurrentUser()).toBeNull();
    expect(h.state.calls).toHaveLength(0);
  });
});

describe("requireApiSession — JSON rotalarının kapısı", () => {
  it("geçerli oturumu döndürür", async () => {
    expect((await requireApiSession())?.username).toBe("ayse");
  });

  it("zorunlu parola değişikliği bekleyen kullanıcıya null döner (rota 401 verir)", async () => {
    h.state.row = { ...h.state.row!, must_change_password: true };
    expect(await requireApiSession()).toBeNull();
  });

  it("oturum yoksa null döner", async () => {
    h.state.token = null;
    expect(await requireApiSession()).toBeNull();
  });

  it("veritabanı hatasını 401'e çevirip yutmaz — hata çağırana ulaşır (rota 500 verir)", async () => {
    h.state.row = { ...h.state.row!, last_seen_at: minutesAgo(6) };
    h.state.failBump = true;
    await expect(requireApiSession()).rejects.toThrow();
  });
});

describe("requireSession — zorunlu parola değişikliği (0095) sayfalarda da geçerli", () => {
  it("bayraklı kullanıcıyı /change-password'e yönlendirir", async () => {
    h.state.row = { ...h.state.row!, must_change_password: true };
    await expect(requireSession()).rejects.toThrow("REDIRECT /change-password");
  });

  it("allowMustChangePassword yalnız parola değiştirme yüzeyi içindir ve kullanıcıyı döndürür", async () => {
    h.state.row = { ...h.state.row!, must_change_password: true };
    expect((await requireSession({ allowMustChangePassword: true })).mustChangePassword).toBe(true);
  });

  it("oturumsuz isteği /login'e yönlendirir", async () => {
    h.state.token = null;
    await expect(requireSession()).rejects.toThrow("REDIRECT /login");
  });
});
