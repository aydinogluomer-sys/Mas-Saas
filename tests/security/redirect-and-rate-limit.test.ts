// Faz 40 (A2) — Open redirect shield, CSV formula injection guard, rate-limit LRU/proxy-trust,
// perf-probe production/session gate, health error masking, password max length, and check-env tests.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ||= "postgresql://unit_test_no_connect:x@127.0.0.1:5432/mas_radar_unit_dummy";
});
import { safeRedirectPath } from "@/lib/security/redirect";
import { rowsToCsv } from "@/lib/analytics/export";
import {
  MAX_BUCKETS,
  clientKey,
  rateLimit,
  rateLimitBucketCount,
  resetRateLimits,
} from "@/lib/rate-limit";
import { PASSWORD_MAX_LENGTH, passwordSchema } from "@/lib/users/password-policy";
import { redactBotToken } from "@/lib/reminders/transport";
import { isAllowedCredentialEnvVar, validateIntegrationEndpointUrl } from "@/lib/integrations/types";
import { isAllowedTcmbUrl } from "@/lib/fx/provider";
import { auditEnvironment } from "../../scripts/check-env";

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireApiSession: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(),
}));

describe("Faz 40 — safeRedirectPath açık yönlendirme kalkanı", () => {
  it("geçerli uygulama içi rotaları ve sorgu parametrelerini korur", () => {
    expect(safeRedirectPath("/payments")).toBe("/payments");
    expect(safeRedirectPath("/finance/invoices?page=2&dir=sales", "/overview")).toBe(
      "/finance/invoices?page=2&dir=sales",
    );
    expect(safeRedirectPath("/")).toBe("/");
  });

  it("harici URL, protokol-göreli, ters eğik çizgi, kontrol karakteri ve döngü vektörlerini reddeder", () => {
    const vectors = [
      "https://evil.com",
      "http://evil.com/payments",
      "//evil.com",
      "/\\evil.com",
      "\\evil.com",
      "\t//evil.com",
      "/payments\r\nSet-Cookie: x=1",
      "/payments\x00/evil",
      "/%2fevil.com",
      "/%5cevil.com",
      "javascript:alert(1)",
      "/login",
      "/login?next=/login",
      "/change-password",
      "/change-password?error=locked",
      "",
      null,
      undefined,
      `/${"a".repeat(2050)}`,
    ];
    for (const v of vectors) {
      expect(safeRedirectPath(v, "/payments"), String(v)).toBe("/payments");
    }
  });
});

describe("Faz 40 — CSV formül enjeksiyonu kalkanı", () => {
  it("=, +, -, @, sekme ve satır başı ile başlayan metin hücrelerini tek tırnak ile etkisizleştirir", () => {
    const csv = rowsToCsv([
      ["Cari", " Tutar ", "Formül"],
      ["=CMD|' /C calc'!A0", -150.25, "+1+1"],
      ["-SUM(A1:A5)", 42, "@SUM(1,2)"],
      ["\t=1+1", 0, "\r=2+2"],
    ]);
    const lines = csv.split("\n");
    expect(lines[1]).toBe("'=CMD|' /C calc'!A0;-150.25;'+1+1");
    expect(lines[2]).toBe("'-SUM(A1:A5);42;'@SUM(1,2)");
    expect(lines[3]).toContain("'\t=1+1;0;");
    expect(lines[3]).toContain("\"'\r=2+2\"");
  });
});

describe("Faz 40 — rate-limit MAS_TRUST_PROXY ve MAX_BUCKETS = 4096 LRU koruması", () => {
  const originalTrustProxy = process.env.MAS_TRUST_PROXY;

  beforeEach(() => {
    resetRateLimits();
    delete process.env.MAS_TRUST_PROXY;
  });

  afterEach(() => {
    resetRateLimits();
    if (originalTrustProxy === undefined) delete process.env.MAS_TRUST_PROXY;
    else process.env.MAS_TRUST_PROXY = originalTrustProxy;
  });

  it("MAS_TRUST_PROXY kapalıyken sahte X-Forwarded-For / X-Real-IP başlıklarını yok sayar", () => {
    const h1 = new Headers({ "x-forwarded-for": "203.0.113.10", "x-real-ip": "203.0.113.11" });
    const h2 = new Headers({ "x-forwarded-for": "198.51.100.99" });
    expect(clientKey(h1)).toBe("unknown");
    expect(clientKey(h2)).toBe("unknown");

    process.env.MAS_TRUST_PROXY = "1";
    expect(clientKey(h1)).toBe("203.0.113.10");
  });

  it("kova sayısını MAX_BUCKETS (4096) tavanında tutar ve en eski girdiyi düşürür", () => {
    const rule = { limit: 5, windowMs: 60_000 };
    for (let i = 0; i < MAX_BUCKETS + 250; i++) {
      const verdict = rateLimit(`k:${i}`, rule, 1_000_000);
      expect(verdict.ok).toBe(true);
    }
    expect(rateLimitBucketCount()).toBe(MAX_BUCKETS);
  });
});

describe("Faz 40 — parola üst sınırı, bot token maskeleme ve SSRF/kimlik sınırı", () => {
  it("256 karakteri aşan parolaları Argon2id öncesinde reddeder", () => {
    expect(passwordSchema.safeParse("A".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(passwordSchema.safeParse("A".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("Telegram hata metinlerindeki bot<TOKEN> dizgelerini maskeler", () => {
    const leaked = "FetchError: request to https://api.telegram.org/bot123456789:AAH_secret-Token_99/sendMessage failed";
    const safe = redactBotToken(leaked);
    expect(safe).not.toContain("AAH_secret");
    expect(safe).toContain("bot[REDACTED]/sendMessage");
  });

  it("entegrasyon URL'lerinde HTTP, loopback, RFC1918, metadata ve izin dışı hostları engeller", () => {
    expect(validateIntegrationEndpointUrl("http://api.parasut.com/v4", { enforceAllowlist: true })).not.toBeNull();
    expect(validateIntegrationEndpointUrl("https://127.0.0.1:5432/", { enforceAllowlist: false })).not.toBeNull();
    expect(validateIntegrationEndpointUrl("https://169.254.169.254/latest/meta-data", { enforceAllowlist: false })).not.toBeNull();
    expect(validateIntegrationEndpointUrl("https://192.168.1.10/api", { enforceAllowlist: false })).not.toBeNull();
    expect(validateIntegrationEndpointUrl("https://evil.example.com/v1", { enforceAllowlist: true })).not.toBeNull();
    expect(validateIntegrationEndpointUrl("https://api.parasut.com/v4", { enforceAllowlist: true })).toBeNull();
    expect(isAllowedTcmbUrl("https://www.tcmb.gov.tr/kurlar/today.xml")).toBe(true);
    expect(isAllowedTcmbUrl("http://www.tcmb.gov.tr/kurlar/today.xml")).toBe(false);
    expect(isAllowedTcmbUrl("https://169.254.169.254/kurlar/today.xml")).toBe(false);
  });

  it("readCredential izin listesi yalnız MAS_INTEGRATION_* ve PARASUT_* öneklerini kabul eder", () => {
    expect(isAllowedCredentialEnvVar("PARASUT_CLIENT_SECRET")).toBe(true);
    expect(isAllowedCredentialEnvVar("MAS_INTEGRATION_BANK_TOKEN")).toBe(true);
    expect(isAllowedCredentialEnvVar("DATABASE_URL")).toBe(false);
    expect(isAllowedCredentialEnvVar("MIGRATION_DATABASE_URL")).toBe(false);
    expect(isAllowedCredentialEnvVar("OPENAI_API_KEY")).toBe(false);
    expect(isAllowedCredentialEnvVar("TELEGRAM_BOT_TOKEN")).toBe(false);
  });
});

describe("Faz 40 — /api/perf-probe ve /health güvenlik sınırları", () => {
  const origPerf = process.env.MAS_PERF_PROBE;
  const origAllowProd = process.env.MAS_ALLOW_PROD_PERF_PROBE;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (origPerf === undefined) delete process.env.MAS_PERF_PROBE;
    else process.env.MAS_PERF_PROBE = origPerf;
    if (origAllowProd === undefined) delete process.env.MAS_ALLOW_PROD_PERF_PROBE;
    else process.env.MAS_ALLOW_PROD_PERF_PROBE = origAllowProd;
  });

  it("NODE_ENV=production altında MAS_PERF_PROBE=1 olsa bile /api/perf-probe 404 döner", async () => {
    process.env.MAS_PERF_PROBE = "1";
    delete process.env.MAS_ALLOW_PROD_PERF_PROBE;
    vi.stubEnv("NODE_ENV", "production");

    const { GET } = await import("@/app/api/perf-probe/route");
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("oturumsuz çağrıda /api/perf-probe 401 döner", async () => {
    process.env.MAS_PERF_PROBE = "1";
    vi.stubEnv("NODE_ENV", "test");
    const authMod = await import("@/lib/auth");
    vi.mocked(authMod.requireApiSession).mockResolvedValueOnce(null);

    const { GET } = await import("@/app/api/perf-probe/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("/health veritabanı düştüğünde ham PG hata metnini sızdırmaz", async () => {
    const dbMod = await import("@/lib/db");
    vi.mocked(dbMod.getPool).mockReturnValueOnce({
      query: vi.fn().mockRejectedValueOnce(new Error("FATAL: password authentication failed for user supersecret")),
    } as unknown as ReturnType<typeof dbMod.getPool>);

    const { GET } = await import("@/app/health/route");
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.db).toBe("down");
    expect(json.dbError).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("supersecret");
  });
});

describe("Faz 40 — scripts/check-env.ts güvenlik kontrolleri", () => {
  it("kök dizindeki .env.local.bak* yedeğini, yanlış DB kullanıcısını ve CHANGE_ME yer tutucusunu yakalar", () => {
    // 1. Real workspace root check: detects any untracked `.env.local.bak*` if present
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mas-check-env-"));
    try {
      writeFileSync(path.join(tmp, ".env.local.bak-20261029-092503"), "DATABASE_URL=postgres://x:y@127.0.0.1:5432/db\n");
      const bad = auditEnvironment({
        rootDir: tmp,
        envVars: {
          DATABASE_URL: "postgres://postgres:CHANGE_ME@127.0.0.1:5432/mas_radar_dev",
          EMAIL_API_URL: "http://127.0.0.1:8080/send",
        },
      });
      expect(bad.ok).toBe(false);
      const codes = bad.issues.map((i) => i.code);
      expect(codes).toContain("PLAINTEXT_ENV_BACKUP");
      expect(codes).toContain("WRONG_RUNTIME_DB_USER");
      expect(codes).toContain("PLACEHOLDER_SECRET");
      expect(codes).toContain("INVALID_EMAIL_API_URL");

      rmSync(path.join(tmp, ".env.local.bak-20261029-092503"));
      const clean = auditEnvironment({
        rootDir: tmp,
        envVars: {
          DATABASE_URL: "postgres://mas_radar_app:StrongLocalSecret99!@127.0.0.1:5432/mas_radar_dev",
          EMAIL_API_URL: "https://api.resend.com/emails",
          MAS_ALLOWED_EMAIL_HOSTS: "api.resend.com",
        },
      });
      expect(clean.ok).toBe(true);
      expect(clean.issues).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("çalışma dizininde izlenmeyen .env.local.bak-20261029-092503 varsa PLAINTEXT_ENV_BACKUP uyarısı üretir", () => {
    const workspaceAudit = auditEnvironment({
      rootDir: process.cwd(),
      envVars: {
        DATABASE_URL: "postgres://mas_radar_app:StrongLocalSecret99!@127.0.0.1:5432/mas_radar_dev",
      },
    });
    if (workspaceAudit.backupFiles.length > 0) {
      expect(workspaceAudit.ok).toBe(false);
      expect(workspaceAudit.issues.some((i) => i.code === "PLAINTEXT_ENV_BACKUP")).toBe(true);
    }
  });
});
