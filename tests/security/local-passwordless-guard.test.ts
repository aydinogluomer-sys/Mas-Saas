import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://mas_radar_app:unit_test_dummy@127.0.0.1:5432/mas_radar_unit_dummy";

  const state = {
    token: null as string | null,
    headers: {} as Record<string, string>,
    row: null as null | {
      id: string;
      username: string;
      display_name: string;
      role: "admin" | "finance_manager" | "finance_ops" | "sales_ops" | "viewer";
      must_change_password: boolean;
      session_id: string;
      last_seen_at: string | null;
      created_at: string;
    },
    calls: [] as string[],
  };

  const pool = {
    query: async (text: string) => {
      state.calls.push(text);
      if (text.includes("from public.sessions s join public.users u")) {
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
  headers: async () => ({
    get: (name: string) => {
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(h.state.headers)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

vi.mock("@/lib/db", () => ({ getRawPool: () => h.pool }));
vi.mock("@node-rs/argon2", () => ({ hash: async () => "x", verify: async () => false }));

import {
  clearRequestSessionCache,
  getCurrentUser,
  requireAdmin,
  requireApiSession,
  requireSession,
  safeRedirectPath,
  withRequestSessionScope,
} from "@/lib/auth";
import { env, envPresence, isLoopbackHostname } from "@/lib/env";
import { middleware } from "@/middleware";
import { auditEnvironment } from "../../scripts/check-env";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("SA-1 — MAS_LOCAL_PASSWORDLESS ve oturum sınırı sertleştirmesi", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:unit_test_dummy@127.0.0.1:5432/mas_radar_unit_dummy");
    vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "");
    vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "");
    vi.stubEnv("MAS_QA_BYPASS_AUTH", "");
    h.state.token = null;
    h.state.headers = {};
    h.state.row = null;
    h.state.calls = [];
    clearRequestSessionCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRequestSessionCache();
  });

  describe("isLoopbackHostname ve env.localPasswordless", () => {
    it("yalnız katı loopback (127.0.0.1, localhost, ::1) adreslerini kabul eder; LAN/RFC1918 alt ağlarını reddeder", () => {
      expect(isLoopbackHostname("127.0.0.1")).toBe(true);
      expect(isLoopbackHostname("localhost")).toBe(true);
      expect(isLoopbackHostname("LOCALHOST")).toBe(true);
      expect(isLoopbackHostname("::1")).toBe(true);
      expect(isLoopbackHostname("[::1]")).toBe(true);

      expect(isLoopbackHostname("192.168.1.10")).toBe(false);
      expect(isLoopbackHostname("10.0.0.5")).toBe(false);
      expect(isLoopbackHostname("172.16.0.1")).toBe(false);
      expect(isLoopbackHostname("127.0.0.2")).toBe(false);
      expect(isLoopbackHostname("0.0.0.0")).toBe(false);
      expect(isLoopbackHostname("db.internal")).toBe(false);
      expect(isLoopbackHostname("app.local")).toBe(false);
      expect(isLoopbackHostname("sub.localhost")).toBe(false);
      expect(isLoopbackHostname("")).toBe(false);
    });

    it("NODE_ENV=production altında MAS_LOCAL_PASSWORDLESS=1 ve loopback DB olsa bile her zaman false/null döner (F-06)", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");
      h.state.token = null;
      h.state.headers = { host: "127.0.0.1:3000" };

      expect(env.localPasswordless).toBe(false);
      expect(await getCurrentUser()).toBeNull();
    });

    it("NODE_ENV=test altında MAS_ALLOW_PASSWORDLESS_IN_TEST=1 verilmedikçe her zaman false döner (.env.local sızıntı koruması)", () => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");

      expect(env.localPasswordless).toBe(false);
    });

    it("LAN IP (192.168.1.10 / 10.x / 172.16.x) üzerinde MAS_LOCAL_PASSWORDLESS=1 olsa bile false döner", () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");

      for (const host of ["192.168.1.10", "10.0.0.25", "172.16.1.5", "0.0.0.0", "db.example.com"]) {
        vi.stubEnv("DATABASE_URL", `postgresql://mas_radar_app:x@${host}:5432/mas_radar_dev`);
        expect(env.localPasswordless, host).toBe(false);
      }
    });

    it("yalnız loopback (127.0.0.1, localhost, ::1) ve açık bayraklarla true döner", () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");

      for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
        vi.stubEnv("DATABASE_URL", `postgresql://mas_radar_app:x@${host}:5432/mas_radar_dev`);
        expect(env.localPasswordless, host).toBe(true);
      }

      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "0");
      expect(env.localPasswordless).toBe(false);
    });

    it("envPresence() içinde MAS_LOCAL_PASSWORDLESS görünürlüğünü sır sızdırmadan raporlar", () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      const entry = envPresence().find((item) => item.name === "MAS_LOCAL_PASSWORDLESS");
      expect(entry).toBeDefined();
      expect(entry?.required).toBe(false);
      expect(entry?.set).toBe(true);
    });
  });

  describe("getCurrentUser() — sunulan çerez iptal / süresi dolmuş / boşta kalmışsa ASLA DEFAULT_LOCAL_USER'a düşmez", () => {
    it("env.localPasswordless === true iken bile iptal edilmiş veya DB'de bulunmayan mas_session çerezi için null döner", async () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");
      expect(env.localPasswordless).toBe(true);

      h.state.token = "revoked-or-unknown-session-token";
      h.state.row = null; // revoked_at is not null / expired / user locked or inactive

      expect(await getCurrentUser()).toBeNull();
      expect(h.state.calls.some((q) => q.includes("from public.sessions s join public.users u"))).toBe(true);

      await withRequestSessionScope(async () => {
        expect(await requireApiSession()).toBeNull();
        await expect(requireSession()).rejects.toThrow("REDIRECT /login");
      });
    });

    it("env.localPasswordless === true iken bile boşta kalma süresi (60 dk) aşılınca oturumu DB'de iptal eder ve null döner", async () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");
      expect(env.localPasswordless).toBe(true);

      h.state.token = "idle-expired-session-token";
      h.state.row = {
        id: "11111111-1111-4111-8111-111111111111",
        username: "operator.kullanici",
        display_name: "Operatör",
        role: "viewer",
        must_change_password: false,
        session_id: "99999999-9999-4999-8999-999999999999",
        last_seen_at: minutesAgo(61),
        created_at: minutesAgo(120),
      };

      expect(await getCurrentUser()).toBeNull();
      expect(h.state.calls.some((q) => q.includes("update public.sessions set revoked_at = now()"))).toBe(true);
    });

    it("yalnız hiç çerez sunulmadığında (!token) ve env.localPasswordless === true olduğunda yerel geliştirici oturumu döner", async () => {
      h.state.token = null;

      // 1. Default test mode (no MAS_ALLOW_PASSWORDLESS_IN_TEST): null
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");
      expect(await getCurrentUser()).toBeNull();

      // 2. Opted-in on loopback: returns isolated copy of DEFAULT_LOCAL_USER without touching DB
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      h.state.headers = { host: "127.0.0.1:3000" };
      const first = await getCurrentUser();
      expect(first).not.toBeNull();
      expect(first?.username).toBe("atilla");
      expect(first?.role).toBe("admin");
      expect(h.state.calls).toHaveLength(0);

      if (first) first.role = "viewer";
      const second = await getCurrentUser();
      expect(second?.role).toBe("admin");
    });

    it("loopback olmayan Host veya X-Forwarded-Host başlığı parolasız geçişi getCurrentUser() içinde engeller (F-06)", async () => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");
      h.state.token = null;

      // Non-loopback Host headers -> blocked
      for (const badHost of ["192.168.1.10:3000", "10.0.0.5:3000", "mas.example.com", "0.0.0.0:3000"]) {
        h.state.headers = { host: badHost };
        expect(await getCurrentUser(), `host=${badHost}`).toBeNull();
      }

      // Reverse proxy forwarding external X-Forwarded-Host to local Host -> blocked
      h.state.headers = {
        host: "127.0.0.1:3000",
        "x-forwarded-host": "mas.example.com",
      };
      expect(await getCurrentUser()).toBeNull();

      // LAN Host attempting to spoof X-Forwarded-Host as loopback -> blocked
      h.state.headers = {
        host: "192.168.1.10:3000",
        "x-forwarded-host": "127.0.0.1:3000",
      };
      expect(await getCurrentUser()).toBeNull();

      // Valid loopback Host headers (IPv4, localhost, IPv6 bracketed) -> allowed in non-production
      for (const okHost of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "localhost"]) {
        h.state.headers = { host: okHost };
        const user = await getCurrentUser();
        expect(user, `host=${okHost}`).not.toBeNull();
        expect(user?.username).toBe("atilla");
      }
    });

    it("must_change_password === true oturumları requireSession, requireAdmin ve requireApiSession kapılarında engellenir (F-07)", async () => {
      h.state.token = "pending-password-change-session";
      h.state.row = {
        id: "22222222-2222-4222-8222-222222222222",
        username: "admin.degisim",
        display_name: "Admin Zorunlu Değişim",
        role: "admin",
        must_change_password: true,
        session_id: "88888888-8888-4888-8888-888888888888",
        last_seen_at: minutesAgo(1),
        created_at: minutesAgo(5),
      };

      await withRequestSessionScope(async () => {
        expect(await requireApiSession()).toBeNull();
        await expect(requireSession()).rejects.toThrow("REDIRECT /change-password");
        await expect(requireAdmin()).rejects.toThrow("REDIRECT /change-password");
        const allowedPending = await requireSession({ allowMustChangePassword: true });
        expect(allowedPending.mustChangePassword).toBe(true);
      });
    });
  });

  describe("middleware + safeRedirectPath + check-env tutarlılığı", () => {
    it("middleware NODE_ENV=test varsayılanında ve LAN IP üzerinde parolasız geçişe izin vermez", () => {
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");

      // NODE_ENV=test without MAS_ALLOW_PASSWORDLESS_IN_TEST -> redirect to /login
      const testRes = middleware(new NextRequest("http://127.0.0.1:3000/overview"));
      expect(testRes.status).toBe(307);
      expect(testRes.headers.get("location")).toContain("/login");

      // Opted-in test, LAN IP -> redirect to /login
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      const lanRes = middleware(new NextRequest("http://192.168.1.10:3000/overview"));
      expect(lanRes.status).toBe(307);
      expect(lanRes.headers.get("location")).toContain("/login");

      // Opted-in test, strict loopback -> allowed through
      const loopbackRes = middleware(new NextRequest("http://127.0.0.1:3000/overview"));
      expect(loopbackRes.status).toBe(200);
    });

    it("auth üzerinden dışa aktarılan safeRedirectPath ters eğik çizgi, kontrol karakterleri ve // vektörlerini reddeder", () => {
      for (const bad of [
        "//evil.com",
        "/\\evil.com",
        "\\evil.com",
        "/payments\\..\\admin",
        "\t//evil.com",
        "/payments\r\nInjected: 1",
        "/payments\n//evil.com",
        "/payments\x00/evil",
        "/payments\x1f/evil",
        "/payments\x7f/evil",
      ]) {
        expect(safeRedirectPath(bad, "/overview"), JSON.stringify(bad)).toBe("/overview");
      }
      expect(safeRedirectPath("/payments?tab=due", "/overview")).toBe("/payments?tab=due");
    });

    it("scripts/check-env.ts MAS_LOCAL_PASSWORDLESS=1 iken çıkış kodunu bozmadan (ok: true) açık uyarı üretir", () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "mas-check-env-pwless-"));
      try {
        const withPwless = auditEnvironment({
          rootDir: tmp,
          envVars: {
            DATABASE_URL: "postgres://mas_radar_app:TopSecretCutoverPass99!@127.0.0.1:5432/mas_radar_dev",
            MAS_LOCAL_PASSWORDLESS: "1",
          },
        });
        expect(withPwless.ok).toBe(true);
        expect(withPwless.issues).toEqual([]);
        expect(withPwless.warnings).toHaveLength(1);
        expect(withPwless.warnings[0]?.code).toBe("LOCAL_PASSWORDLESS_ACTIVE");
        expect(withPwless.warnings[0]?.message).toContain("MAS_LOCAL_PASSWORDLESS=1");
        expect(JSON.stringify(withPwless)).not.toContain("TopSecretCutoverPass99!");

        const withoutPwless = auditEnvironment({
          rootDir: tmp,
          envVars: {
            DATABASE_URL: "postgres://mas_radar_app:TopSecretCutoverPass99!@127.0.0.1:5432/mas_radar_dev",
          },
        });
        expect(withoutPwless.ok).toBe(true);
        expect(withoutPwless.warnings).toEqual([]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
