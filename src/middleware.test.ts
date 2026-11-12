import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { config, middleware } from "./middleware";

function cookieless(pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return middleware(new NextRequest(`http://127.0.0.1:3000${pathname}`, init));
}

function expectLoginRedirect(response: Response) {
  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
}

describe("Wave 0 & Faz 42 (B2) — kaldırılan yüzeyler artık oturum kapısına tabi (sıfır çerezsiz API istisnası)", () => {
  const REMOVED = [
    "/api/telegram/assistant",
    "/api/telegram/assistant/",
    "/api/telegram/assistant/x",
    "/api/telegram/assistantx",
    "/API/telegram/assistant",
    "/api/telegram/other",
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
    const spoofed = {
      "user-agent": "TelegramBot (like TwitterBot)",
      "x-telegram-init-data": "webapp",
      "x-telegram-internal-key": "a".repeat(32),
      "x-telegram-bot-api-secret-token": "a".repeat(32),
    };
    for (const p of [
      "/api/telegram/assistant",
      "/api/telegram/miniapp",
      "/telegram/miniapp",
      "/api/erp/sync",
      "/api/telegram/webhook",
    ]) {
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

  const GATED = [
    "/",
    "/overview",
    "/finance/receivables",
    "/data/imports",
    "/api/facts",
    "/api/search",
    "/change-password",
    "/login-bypass",
    "/healthcheck",
    "/ready-probe",
    "/version2",
    "/robots.txt.bak",
    "/sw.js.map",
  ];
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

describe("her route.ts için sıfır çerezsiz API muafiyeti (Faz 42 / B2)", () => {
  const PUBLIC_BY_MATCHER = new Set(["/health", "/ready", "/version"]);
  const files = routeFiles(path.join(process.cwd(), "src", "app"));

  it("route dosyaları bulundu (boş tarama geçmiş sayılmaz)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("çerezsiz istekte HİÇBİR API route oturum kapısını atlamaz", () => {
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
    expect(bypassing).toEqual([]);
  });
});
