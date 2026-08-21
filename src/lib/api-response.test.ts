// Faz 16 — the two guarantees src/lib/api-response.ts exists to make, pinned as tests:
// a DomainError reaches the client as a 400 with its own message, and anything else reaches
// the client as a 500 with a generic message that leaks nothing about the cause.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { DomainError } from "@/lib/domain-error";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { apiError, checkOrigin, withApiHandler } from "@/lib/api-response";
import { RATE_RULES, rateLimit, resetRateLimits } from "@/lib/rate-limit";

// The module logs through process.stderr on purpose; silence it so a passing suite stays
// readable, and so an assertion failure is not buried under a stack trace.
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderr.mockRestore();
});

const req = (url = "https://panel.local/api/facts", init?: RequestInit) => new Request(url, init);

describe("withApiHandler", () => {
  it("DomainError'ı 400'e çevirir ve mesajını aynen geçirir", async () => {
    const res = await withApiHandler(req(), async () => {
      throw new DomainError("'paid' durumundan iptal edilemez");
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("'paid' durumundan iptal edilemez");
  });

  it("beklenmeyen hatayı 500'e çevirir ve iç detayı SIZDIRMAZ", async () => {
    const secret = "connect ECONNREFUSED postgres://mas_radar_app:hunter2@127.0.0.1:5432/mas_radar_dev";
    const res = await withApiHandler(req(), async () => {
      throw new Error(secret);
    });
    expect(res.status).toBe(500);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("postgres://");
    expect(raw).toContain("Beklenmeyen bir hata oluştu.");
  });

  it("beklenmeyen hatayı sunucu tarafında TAM olarak loglar", async () => {
    await withApiHandler(req(), async () => {
      throw new Error("ECONNREFUSED ayrıntısı");
    });
    const logged = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(logged).toContain("unhandled_route_error");
    expect(logged).toContain("ECONNREFUSED ayrıntısı");
  });

  it("başarılı yanıta korelasyon kimliğini ekler ve gelen kimliği korur", async () => {
    const res = await withApiHandler(req("https://panel.local/api/facts", { headers: { [CORRELATION_HEADER]: "abcd1234efgh" } }), async () =>
      NextResponse.json({ ok: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(CORRELATION_HEADER)).toBe("abcd1234efgh");
  });

  // CRLF is not tested here because it cannot be reached: the Headers API itself throws on a
  // value containing a newline, so log injection via this header is already impossible one
  // layer below us. What the regex in src/lib/correlation.ts actually defends against is
  // header-legal junk — an unbounded value that would bloat every log line, or characters
  // that break a downstream log parser's field splitting.
  it.each([
    ["çok kısa", "abc"],
    ["aşırı uzun", "x".repeat(200)],
    ["boşluk içeriyor", "id with spaces"],
    ["ayraç içeriyor", 'id";drop'],
  ])("biçimsiz gelen korelasyon kimliğini (%s) reddedip yenisini üretir", async (_label, evil) => {
    const res = await withApiHandler(
      req("https://panel.local/api/facts", { headers: { [CORRELATION_HEADER]: evil } }),
      async () => NextResponse.json({ ok: true }),
    );
    const id = res.headers.get(CORRELATION_HEADER);
    expect(id).not.toBe(evil);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("geçerli gelen kimliği olduğu gibi korur", async () => {
    const res = await withApiHandler(
      req("https://panel.local/api/facts", { headers: { [CORRELATION_HEADER]: "trace-abc.123:9" } }),
      async () => NextResponse.json({ ok: true }),
    );
    expect(res.headers.get(CORRELATION_HEADER)).toBe("trace-abc.123:9");
  });
});

describe("apiError", () => {
  it("code verildiğinde gövdeye ekler, verilmediğinde eklemez", async () => {
    expect((await apiError(429, "yavaşla", { code: "rate_limited" }).json()).error.code).toBe("rate_limited");
    expect((await apiError(400, "olmaz").json()).error.code).toBeUndefined();
  });
});

describe("checkOrigin", () => {
  it("güvenli metotları kontrol etmez", () => {
    expect(checkOrigin(req("https://panel.local/api/facts", { method: "GET" }))).toBeNull();
  });

  it("aynı origin'li mutasyona izin verir", () => {
    const r = req("https://panel.local/x", {
      method: "POST",
      headers: { origin: "https://panel.local", host: "panel.local" },
    });
    expect(checkOrigin(r)).toBeNull();
  });

  it("farklı origin'li mutasyonu 403 ile reddeder", () => {
    const r = req("https://panel.local/x", {
      method: "POST",
      headers: { origin: "https://saldirgan.example", host: "panel.local" },
    });
    expect(checkOrigin(r)?.status).toBe(403);
  });

  it("Origin başlığı olmayan mutasyonu reddeder (varsayılan güvenmemek)", () => {
    const r = req("https://panel.local/x", { method: "POST", headers: { host: "panel.local" } });
    expect(checkOrigin(r)?.status).toBe(403);
  });
});

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("limite kadar izin verir, aşınca reddeder", () => {
    const rule = { limit: 3, windowMs: 60_000 };
    const results = [1, 2, 3, 4].map(() => rateLimit("k", rule, 1_000));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3].retryAfterSec).toBeGreaterThan(0);
  });

  it("pencere dolunca sayaç sıfırlanır", () => {
    const rule = { limit: 1, windowMs: 1_000 };
    expect(rateLimit("k", rule, 0).ok).toBe(true);
    expect(rateLimit("k", rule, 500).ok).toBe(false);
    expect(rateLimit("k", rule, 1_001).ok).toBe(true);
  });

  it("farklı anahtarlar birbirini etkilemez", () => {
    const rule = { limit: 1, windowMs: 60_000 };
    expect(rateLimit("a", rule, 0).ok).toBe(true);
    expect(rateLimit("b", rule, 0).ok).toBe(true);
    expect(rateLimit("a", rule, 0).ok).toBe(false);
  });

  it("login kuralı api kuralından daha sıkıdır", () => {
    expect(RATE_RULES.login.limit).toBeLessThan(RATE_RULES.api.limit);
  });
});
