import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { config, middleware } from "./middleware";

// A request is refused without a session when BOTH halves agree: Next's matcher sends the path
// through the middleware at all (config.matcher, evaluated by Next's own helper rather than a
// re-implementation of its regex), and the middleware then redirects a cookieless request.
// Calling middleware() alone would skip the first half, which is exactly where a public-asset
// exclusion could quietly grow into a hole.
function cookieless(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return middleware(new NextRequest(`http://127.0.0.1:3000${pathname}`, init));
}

function expectLoginRedirect(response: Response) {
  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
}

describe("Telegram assistant middleware sınırı", () => {
  it("yalnız tam Telegram assistant yolunu servis kimlik doğrulamasına bırakır", () => {
    const response = cookieless("/api/telegram/assistant", { method: "POST" });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("komşu Telegram API yollarını oturum kapısından kaçırmaz", () => {
    expectLoginRedirect(cookieless("/api/telegram/other"));
  });

  it("assistant yolunun benzerleri (sonda eğik çizgi, alt yol, büyük harf) kapıdan geçemez", () => {
    for (const p of ["/api/telegram/assistant/", "/api/telegram/assistant/x", "/api/telegram/assistantx", "/API/telegram/assistant"]) {
      expectLoginRedirect(cookieless(p, { method: "POST" }));
    }
  });
});

describe("Wave 0 — kaldırılan yüzeyler artık oturum kapısına tabi", () => {
  // The layer exempted these from the cookie gate: /api/telegram/webhook exactly, and the rest
  // by PREFIX. The routes are gone; the paths must still land on the gate, so that re-adding a
  // file at any of them cannot silently re-open it.
  const REMOVED = [
    "/api/erp/sync",
    "/api/erp/webhook",
    "/api/erp/x",
    "/api/telegram/webhook",
    "/api/telegram/miniapp",
    "/api/telegram/miniappx",
    "/telegram/miniapp",
    "/telegram/miniapp/x",
    "/telegram/miniapp-anything",
  ];

  for (const p of REMOVED) {
    it(`${p}: matcher kapsıyor ve çerezsiz istek /login'e yönleniyor`, () => {
      expect(unstable_doesMiddlewareMatch({ config, url: p })).toBe(true);
      expectLoginRedirect(cookieless(p, { method: "POST" }));
    });
  }

  it("Telegram'ı taklit eden başlıklar ve User-Agent kapıyı açmaz", () => {
    // The mini-app accepted any x-telegram-init-data header or a User-Agent containing
    // "Telegram" as authentication. None of it may count for anything now.
    const spoofed = {
      "user-agent": "TelegramBot (like TwitterBot)",
      "x-telegram-init-data": "webapp",
      "x-telegram-internal-key": "a".repeat(32),
      "x-telegram-bot-api-secret-token": "a".repeat(32),
    };
    for (const p of ["/api/telegram/miniapp", "/telegram/miniapp", "/api/erp/sync", "/api/telegram/webhook"]) {
      expectLoginRedirect(cookieless(p, { method: "POST", headers: spoofed }));
    }
  });
});

describe("matcher — yalnız oturumsuz gereken statik ve sağlık yolları dışarıda", () => {
  const PUBLIC = [
    "/login",
    "/health",
    "/ready",
    "/version",
    "/robots.txt",
    "/manifest.json",
    "/sw.js",
    "/icon.svg",
    "/favicon.ico",
    "/_next/static/chunks/main.js",
    "/_next/image",
  ];
  for (const p of PUBLIC) {
    it(`${p} middleware'e uğramaz (genel varlık)`, () => {
      expect(unstable_doesMiddlewareMatch({ config, url: p })).toBe(false);
    });
  }

  const GATED = ["/", "/overview", "/finance/receivables", "/data/imports", "/api/facts", "/api/search", "/change-password"];
  for (const p of GATED) {
    it(`${p} middleware'den geçer ve çerezsiz istek reddedilir`, () => {
      expect(unstable_doesMiddlewareMatch({ config, url: p })).toBe(true);
      expectLoginRedirect(cookieless(p));
    });
  }

  it("çerezi olan istek middleware'den geçer (asıl DB kontrolü sayfada/rotada)", () => {
    const response = middleware(new NextRequest("http://127.0.0.1:3000/api/facts", {
      headers: { cookie: `${SESSION_COOKIE}=herhangi` },
    }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

/** URL path of an App Router route file: route groups dropped, dynamic segments filled in. */
function urlPathOf(routeFile: string): string {
  const segments = path.relative(path.join(process.cwd(), "src", "app"), path.dirname(routeFile))
    .split(path.sep)
    .filter((s) => s !== "" && !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => (s.startsWith("[") ? "x" : s));
  return `/${segments.join("/")}`;
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

describe("her route.ts için tek muafiyet", () => {
  // Health/readiness/version answer probes that cannot hold a session; they are kept out by the
  // matcher, not by an exemption in the middleware body, and expose no financial data.
  const PUBLIC_BY_MATCHER = new Set(["/health", "/ready", "/version"]);
  const MACHINE_AUTH = new Set(["/api/telegram/assistant"]);
  const files = routeFiles(path.join(process.cwd(), "src", "app"));

  it("route dosyaları bulundu (boş tarama geçmiş sayılmaz)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("çerezsiz istekte yalnız /api/telegram/assistant oturum kapısını atlar", () => {
    const bypassing: string[] = [];
    for (const file of files) {
      const url = urlPathOf(file);
      if (!unstable_doesMiddlewareMatch({ config, url })) {
        expect(PUBLIC_BY_MATCHER.has(url), `${url} matcher dışında ama genel yol listesinde değil`).toBe(true);
        continue;
      }
      const response = cookieless(url, { method: "POST" });
      if (response.status !== 307) bypassing.push(url);
    }
    expect(bypassing).toEqual([...MACHINE_AUTH]);
  });
});
