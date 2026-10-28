import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DISPOSABLE_MARKERS } from "../scripts/db/owner-url";

/**
 * P24B writer-surface audit — the regressions this file exists to catch.
 *
 * The audit found ONE genuinely unsafe writer, scripts/perf/measure.ts, and it was missed by the
 * first sweep for an instructive reason: the file contains no SQL. It writes by calling
 * generateVolume() from another module, so every "grep for INSERT" check passed it. `.env.local`
 * points BOTH database URLs at mas_radar_dev, so `pnpm perf:measure --seed` wrote synthetic
 * financial volume into the real database — measured at >150k rows when the same command was
 * later run against a disposable clone.
 *
 * So the assertions below are POSITIONAL, not textual. "The file mentions the gate somewhere" is
 * not the property that matters; "the gate runs before anything can write" is.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

/** 1-based line of the first match that is not inside a comment, or Infinity. */
function lineOf(src: string, re: RegExp): number {
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(\/\/|\*|\/\*|#)/.test(lines[i])) continue;
    if (re.test(lines[i])) return i + 1;
  }
  return Number.POSITIVE_INFINITY;
}

const GATE = /requireDisposableOwnerDatabaseUrl|isDisposableDatabaseName/;

describe("perf:measure --seed disposable kapısı", () => {
  const src = read("scripts/perf/measure.ts");

  it("kapı, Pool YARATILMADAN önce çalışır", () => {
    // Bağlantı açıldıktan sonra kontrol eden bir kapı, sonraki bir düzenlemenin araya yazma
    // sokmasına izin verir. Hiçbir şey bağlanmadan reddetmek istenen özelliktir.
    expect(lineOf(src, GATE)).toBeLessThan(lineOf(src, /new\s+Pool\s*\(/));
  });

  it("kapı, generateVolume çağrısından önce çalışır", () => {
    expect(lineOf(src, GATE)).toBeLessThan(lineOf(src, /\bgenerateVolume\s*\(/));
  });

  it("--seed YOKKEN bağlantı motor düzeyinde salt-okunur açılır", () => {
    // Ölçüm modu yalnız okur; bunu niyet değil motor garanti etmeli.
    expect(src).toMatch(/default_transaction_read_only=on/);
  });

  it("gerçek veritabanı hedefi --seed ile REDDEDİLİR (alt süreç, exit 1)", () => {
    // Kapı Pool'dan önce çalıştığı için bu test bir veritabanı GEREKTİRMEZ; bağlantı hiç açılmaz.
    let status = 0;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/perf/measure.ts", "--seed"],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            MIGRATION_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/mas_radar_dev",
            DATABASE_URL: "postgres://u:p@127.0.0.1:5432/mas_radar_dev",
          },
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1;
      stderr = err.stderr ?? "";
    }
    expect(status).toBe(1);
    expect(stderr).toContain("GÜVENLİK DURDURMASI");
    expect(stderr).toContain("mas_radar_dev");
  });
});

describe("generateVolume / dropVolume — her caller kapılı", () => {
  // volume.ts bir Pool parametresi alır ve kendi hedefini SEÇMEZ; güvenlik tamamen caller'ın
  // yükümlülüğüdür (LIBRARY_REQUIRES_CALLER_GUARD). Bu yüzden kural caller tarafında ölçülür.
  const callers = readdirSync(path.join(ROOT, "scripts"), { recursive: true, encoding: "utf8" })
    .filter((f) => typeof f === "string" && f.endsWith(".ts"))
    .map((f) => path.join("scripts", f).split(path.sep).join("/"))
    .filter((f) => !f.endsWith("perf/volume.ts") && !f.includes("writer-surface-manifest"))
    .filter((f) => /\b(generateVolume|dropVolume)\s*\(/.test(read(f)));

  it("en az bir caller bulundu (test kendi kendini boşa düşürmesin)", () => {
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers)("%s: disposable kapısı çağrıdan ÖNCE", (file) => {
    const src = read(file);
    const gate = lineOf(src, GATE);
    const call = lineOf(src, /\b(generateVolume|dropVolume)\s*\(/);
    expect(gate).toBeLessThan(call);
  });
});

describe("provision-verify-db.sh — kabuktaki işaret listesi kopyası", () => {
  // Bu dosya owner-url.ts'i import EDEMEZ (shell), bu yüzden DISPOSABLE_MARKERS'ı elle
  // kopyalıyor. Kendi başlığı bu kopyanın bir kez zaten kaydığını yazıyor: "drill" kanonik
  // listeye eklendi ve bu kopya `mas_radar_rollback_drill` adını reddetmeye devam etti.
  const sh = read("scripts/ci/provision-verify-db.sh");

  it("kanonik DISPOSABLE_MARKERS ile birebir aynı", () => {
    const caseLine = sh.split(/\r?\n/).find((l) => l.includes("*verify*") && l.includes("|"));
    expect(caseLine, "işaret case satırı bulunamadı").toBeTruthy();
    const inShell = [...(caseLine as string).matchAll(/\*([a-z]+)\*/g)].map((m) => m[1]).sort();
    expect(inShell).toEqual([...DISPOSABLE_MARKERS].sort());
  });

  it("korunan adlar dropdb'den ÖNCE reddediliyor", () => {
    const protectedLine = lineOf(sh, /mas_radar_dev\|postgres\|template0\|template1/);
    const dropLine = lineOf(sh, /\bdropdb\b/);
    expect(protectedLine).toBeLessThan(dropLine);
  });
});
