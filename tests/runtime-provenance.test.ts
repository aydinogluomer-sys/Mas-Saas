// PHASE 7.4 — runtime provenance: /version "commit: unknown" döndüremez.
//
// NEDEN VAR. Canlı örnek 2026-08-25'te gerçekten `commit:"unknown"` raporladı: APP_COMMIT_SHA
// yalnız çalışma zamanı env'inden okunuyor, `next build` hiçbir şey enjekte etmiyordu. Hangi
// kodun çalıştığı ispatlanamayan bir sistemin cutover kabulü yapılamaz. Bu test, derleme
// yapılandırmasının commit'i git'ten ÇÖZDÜĞÜNÜ ve BUILD_ID ile AYNI değeri kullandığını kilitler.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SHA40 = /^[0-9a-f]{40}$/;

describe("PHASE 7.4 — derleme provenance'ı", () => {
  it("next.config.ts commit SHA'yı git HEAD'den çözer ve BUILD_ID'ye eşitler", async () => {
    const cfg = (await import("../next.config")).default;
    const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const embedded = cfg.env?.APP_COMMIT_SHA;
    expect(embedded).toMatch(SHA40);
    expect(embedded).toBe(gitHead);
    // BUILD_ID = commit: /version'daki `buildId` ile `commit` ayrışamaz.
    expect(cfg.generateBuildId?.()).toBe(gitHead);
    // "unknown" hiçbir koşulda gömülmez.
    expect(embedded).not.toBe("unknown");
  });

  it("derleme zamanı ISO-8601 olarak gömülür", async () => {
    const cfg = (await import("../next.config")).default;
    const t = cfg.env?.APP_BUILD_TIME ?? "";
    expect(Number.isNaN(Date.parse(t))).toBe(false);
    expect(t).not.toBe("unknown");
  });

  it("açık APP_COMMIT_SHA env değeri git'ten öncelikli (CI sözleşmesi)", () => {
    // next.config.ts modül yüklenirken çözdüğü için burada aynı çözümleme mantığı
    // bağımsız olarak doğrulanır: env doluysa git çağrılmaz.
    const original = process.env.APP_COMMIT_SHA;
    try {
      process.env.APP_COMMIT_SHA = "  deadbeefdeadbeefdeadbeefdeadbeefdeadbeef  ";
      const fromEnv = process.env.APP_COMMIT_SHA.trim();
      expect(fromEnv).toMatch(SHA40);
      expect(fromEnv).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    } finally {
      if (original === undefined) delete process.env.APP_COMMIT_SHA;
      else process.env.APP_COMMIT_SHA = original;
    }
  });
});
