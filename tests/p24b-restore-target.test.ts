import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { smokeTargetBlockers, SMOKE_DB_PATTERN, smokeDumpPath } from "../scripts/db/p24b-smoke-target";

/**
 * P24B v2.2 — the restore-smoke target gate.
 *
 * v2.1's binding generator took a database name from argv[3] and passed it, unchecked, to
 * `dropdb --if-exists`. Passing `mas_radar_dev` would have destroyed the real database from inside
 * the tool whose entire job is to prove a backup of it exists. The name was also interpolated into
 * a `bash -c` STRING, so it was a shell-injection surface as well as a wrong-target one.
 *
 * The assertion that matters here is NOT the exit code. A gate that rejects the name but has
 * already run `dropdb` is worthless, so the integration tests below count DESTRUCTIVE SUBPROCESS
 * CALLS through a fake `docker` on PATH and require that count to be zero.
 */

const ROOT = path.resolve(__dirname, "..");

describe("smokeTargetBlockers — saf yüklem", () => {
  const SOURCE = "mas_radar_p24b_v22_drill";

  it.each([
    ["mas_radar_dev", "gerçek veritabanı"],
    ["postgres", "korunan"],
    ["template0", "korunan"],
    ["template1", "korunan"],
  ])("korunan ad reddediliyor: %s", (name) => {
    expect(smokeTargetBlockers(name, SOURCE).ok).toBe(false);
  });

  it("harcanabilir işareti taşımayan ad reddediliyor", () => {
    expect(smokeTargetBlockers("mas_radar_prod", SOURCE).ok).toBe(false);
    expect(smokeTargetBlockers("musteri_db", SOURCE).ok).toBe(false);
  });

  it.each([
    "foo;drop database mas_radar_dev",
    "foo $(whoami)",
    "foo `id`",
    "../../etc/passwd",
    "foo bar",
    'foo"bar',
    "FOO_VERIFY",          // büyük harf: tırnak gerektirir
    "1verify",             // rakamla başlıyor
    "verify\nmas_radar_dev",
  ])("kabuk/tanımlayıcı olarak geçersiz ad reddediliyor: %j", (name) => {
    const d = smokeTargetBlockers(name, SOURCE);
    expect(d.ok).toBe(false);
    // Ayrıştırılamayan bir ad, disposable/protected mantığına HİÇ ulaşmamalı.
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0]).toContain("geçerli bir sade PostgreSQL tanımlayıcısı değil");
  });

  it("kaynak veritabanının kendisi hedef olamaz", () => {
    expect(smokeTargetBlockers(SOURCE, SOURCE).ok).toBe(false);
  });

  it("ad verilmemişse reddediliyor", () => {
    expect(smokeTargetBlockers(undefined, SOURCE).ok).toBe(false);
    expect(smokeTargetBlockers("", SOURCE).ok).toBe(false);
  });

  it("geçerli harcanabilir ad KABUL ediliyor", () => {
    const d = smokeTargetBlockers("mas_radar_p24b_smoke_drill", SOURCE);
    expect(d.ok).toBe(true);
    expect(d.blockers).toHaveLength(0);
  });

  it("mas_radar_dev iki ayrı kuralla reddediliyor (tek kurala bağlı değil)", () => {
    const d = smokeTargetBlockers("mas_radar_dev", SOURCE);
    expect(d.blockers.length).toBeGreaterThanOrEqual(2);
  });

  it("desen tırnak gerektiren hiçbir adı kabul etmiyor", () => {
    expect(SMOKE_DB_PATTERN.test("mas_radar_x_verify")).toBe(true);
    expect(SMOKE_DB_PATTERN.test("Mas_Radar_verify")).toBe(false);
    expect(SMOKE_DB_PATTERN.test("a".repeat(64))).toBe(false);
  });
});

describe("smokeDumpPath — DB adı taşımıyor", () => {
  it("container yolu veritabanı adından bağımsız", () => {
    const p = smokeDumpPath();
    expect(p).toMatch(/^\/tmp\/mas-p24b-smoke-\d+-\d+\.dump$/);
    expect(p).not.toContain("mas_radar");
  });
});

describe("binding generator — yıkıcı çağrı sayısı", () => {
  let sandbox: string;
  let dockerLog: string;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "p24b-smoke-"));
    dockerLog = path.join(sandbox, "docker.log");
    // Sahte docker: her çağrıyı log'lar, hiçbir şey yapmaz. Gerçek bir veritabanı asla riske girmez.
    const fake = path.join(sandbox, "docker");
    writeFileSync(fake, ["#!/usr/bin/env bash", `echo "$@" >> "${dockerLog.split(path.sep).join("/")}"`, "exit 0", ""].join("\n"), "utf8");
    chmodSync(fake, 0o755);
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  function runBinding(smokeDb: string): { status: number; destructiveCalls: number; stderr: string } {
    // Kasıtlı olarak GEÇERSİZ bir makbuz: kapı sırası önemli değil, önemli olan hiçbir yıkıcı
    // komutun çalışmamış olması. Makbuz kapısı da smokeDb kapısı da bunu sağlamalı.
    const receipt = path.join(sandbox, "receipt.json");
    writeFileSync(receipt, JSON.stringify({ receiptKind: "yanlis" }), "utf8");
    let status = 0; let stderr = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", path.join(sandbox, "out.json"), smokeDb], {
        cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${sandbox}${path.delimiter}${process.env.PATH ?? ""}`,
          MAS_P24B_BACKUP_RECEIPT: receipt,
          MIGRATION_DATABASE_URL: "postgres://u:p@127.0.0.1:5432/mas_radar_p24b_v22_drill",
        },
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1; stderr = err.stderr ?? "";
    }
    const log = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
    const destructiveCalls = (log.match(/dropdb|createdb|pg_restore/g) ?? []).length;
    return { status, destructiveCalls, stderr };
  }

  it.each([
    "mas_radar_dev",
    "postgres",
    "template0",
    "mas_radar_prod",
    "foo;drop database mas_radar_dev",
    "foo $(whoami)",
    "../../etc/passwd",
    "mas_radar_p24b_v22_drill", // kaynağın kendisi
  ])("tehlikeli hedef '%s': yıkıcı subprocess sayısı 0", (name) => {
    const r = runBinding(name);
    expect(r.status).not.toBe(0);
    // Asıl iddia bu: dropdb/createdb/pg_restore HİÇ çağrılmadı.
    expect(r.destructiveCalls).toBe(0);
  });
});

describe("fail-fast — korunan ad DB'ye BAĞLANMADAN reddediliyor", () => {
  /**
   * v2.2'de kapı Pool açıldıktan ve 86 tablonun parmak izi hesaplandıktan SONRA çalışıyordu.
   * Doğruydu ama geçti: korunan bir ad bile önce bir bağlantıya ve tam bir fingerprint'e mal
   * oluyordu — testin 5 saniyede timeout olmasının sebebi buydu.
   *
   * Ayrım şu: URL, hiçbir şeyin dinlemediği bir porta bakıyor. Kapı fail-fast ise hata ADA dair
   * olur; önce bağlanmaya çalışsaydı hata BAĞLANTIYA dair olurdu.
   */
  const DEAD_PORT_URL = "postgres://u:p@127.0.0.1:59999/mas_radar_x_verify";

  it.each(["mas_radar_dev", "postgres", "foo;drop database mas_radar_dev"])(
    "'%s' — hata ada dair, bağlantıya dair değil", (name) => {
      let stderr = ""; let status = 0;
      try {
        execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", path.join(tmpdir(), "unused.json"), name], {
          cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MIGRATION_DATABASE_URL: DEAD_PORT_URL, MAS_P24B_BACKUP_RECEIPT: "" },
        });
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        status = err.status ?? -1; stderr = err.stderr ?? "";
      }
      expect(status).not.toBe(0);
      expect(stderr).toContain("restore smoke hedefi reddedildi");
      // Bağlantı denenmiş olsaydı bu izlerden biri görünürdü.
      expect(stderr).not.toMatch(/ECONNREFUSED|timeout|connect/i);
    });
});

