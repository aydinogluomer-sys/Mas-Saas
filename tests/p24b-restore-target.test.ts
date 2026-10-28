import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { smokeTargetBlockers, SMOKE_DB_PATTERN, smokeDumpPath } from "../scripts/db/p24b-smoke-target";

/**
 * P24B — the restore-smoke target gate.
 *
 * v2.1's binding generator took a database name from argv[3] and passed it, unchecked, to
 * `dropdb --if-exists`. Passing `mas_radar_dev` would have destroyed the real database from inside
 * the tool whose entire job is to prove a backup of it exists. The name was also interpolated into
 * a `bash -c` STRING, making it a shell-injection surface as well as a wrong-target one.
 *
 * ── WHY THE PARAMETRIC CASES ARE PURE (v2.3.1) ───────────────────────────────────────────────
 *
 * v2.3 tested every name through a spawned `node --import tsx` process. Measured on this machine:
 *
 *     the policy decision itself      1.40 µs
 *     one subprocess (tsx module graph: owner-url, pg, backup-lib, fingerprint)   ~1–2 s
 *
 * Eleven spawns therefore cost 11–22 seconds to exercise 15 µs of logic, and individual cases
 * intermittently blew the 5 s default timeout. That flakiness was the TEST HARNESS, not the safety
 * code — the gate runs at line 64 of the binding script, before the receipt is read, before any
 * Pool, connection or docker call.
 *
 * So every name case now runs in-process against the pure predicate, and only two integration
 * cases remain to prove the CLI is actually wired to that predicate. Raising the timeout alone
 * would have hidden the cost rather than removed it.
 */

const ROOT = path.resolve(__dirname, "..");
/** Generous, and explicit: a cold tsx module graph on Windows is seconds, not milliseconds. */
const INTEGRATION_TIMEOUT_MS = 30_000;

describe("smokeTargetBlockers — saf politika (subprocess YOK)", () => {
  const SOURCE = "mas_radar_p24b_v23_drill";

  it.each([
    ["mas_radar_dev", "gerçek veritabanı"],
    ["postgres", "korunan"],
    ["template0", "korunan"],
    ["template1", "korunan"],
  ])("korunan ad reddediliyor: %s", (name) => {
    expect(smokeTargetBlockers(name, SOURCE).ok).toBe(false);
  });

  it.each(["normal_db", "mas_radar_prod", "musteri_db", "yedek"])(
    "harcanabilir işareti taşımayan ad reddediliyor: %s", (name) => {
      expect(smokeTargetBlockers(name, SOURCE).ok).toBe(false);
    });

  it.each([
    "foo;drop database mas_radar_dev",
    "foo$(calc)",
    "foo $(whoami)",
    "foo `id`",
    "../foo",
    "../../etc/passwd",
    "foo bar",
    'foo"bar',
    "FOO_VERIFY",
    "1verify",
    "verify\nmas_radar_dev",
  ])("kabuk/tanımlayıcı olarak geçersiz ad reddediliyor: %j", (name) => {
    const d = smokeTargetBlockers(name, SOURCE);
    expect(d.ok).toBe(false);
    // Ayrıştırılamayan bir ad, disposable/protected mantığına HİÇ ulaşmamalı.
    expect(d.blockers).toHaveLength(1);
    expect(d.blockers[0]).toContain("geçerli bir sade PostgreSQL tanımlayıcısı değil");
  });

  it("boş string ve tanımsız reddediliyor", () => {
    expect(smokeTargetBlockers("", SOURCE).ok).toBe(false);
    expect(smokeTargetBlockers(undefined, SOURCE).ok).toBe(false);
  });

  it("kaynak veritabanının kendisi hedef olamaz", () => {
    expect(smokeTargetBlockers(SOURCE, SOURCE).ok).toBe(false);
  });

  it("geçerli harcanabilir drill adı KABUL ediliyor", () => {
    const d = smokeTargetBlockers("mas_radar_p24b_integration_drill", SOURCE);
    expect(d.ok).toBe(true);
    expect(d.blockers).toHaveLength(0);
  });

  it("mas_radar_dev iki ayrı kuralla reddediliyor (tek kurala bağlı değil)", () => {
    expect(smokeTargetBlockers("mas_radar_dev", SOURCE).blockers.length).toBeGreaterThanOrEqual(2);
  });

  it("desen tırnak gerektiren hiçbir adı kabul etmiyor", () => {
    expect(SMOKE_DB_PATTERN.test("mas_radar_x_verify")).toBe(true);
    expect(SMOKE_DB_PATTERN.test("Mas_Radar_verify")).toBe(false);
    expect(SMOKE_DB_PATTERN.test("a".repeat(64))).toBe(false);
  });

  it("karar maliyeti ihmal edilebilir (harness maliyetiyle karıştırılmasın)", () => {
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) smokeTargetBlockers("mas_radar_dev", SOURCE);
    // Kırılgan bir duvar-saati eşiği değil: 20.000 kararın saniyeler sürmediğini gösteriyor.
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe("smokeDumpPath — DB adı taşımıyor", () => {
  it("container yolu veritabanı adından bağımsız", () => {
    const p = smokeDumpPath();
    expect(p).toMatch(/^\/tmp\/mas-p24b-smoke-\d+-\d+\.dump$/);
    expect(p).not.toContain("mas_radar");
  });
});

/**
 * Two integration cases only: enough to prove the CLI consults the predicate before doing
 * anything, not a second copy of the name matrix.
 *
 * Side effects are COUNTED rather than inferred:
 *   · docker calls  — a fake `docker` on PATH appends every invocation to a log
 *   · DB connections — a real TCP listener stands in for PostgreSQL and counts sockets
 * Asserting on wall-clock would be flaky; asserting on zero side effects is not.
 */
describe("binding CLI — yan etki sayımı", () => {
  let sandbox: string;
  let dockerLog: string;
  let server: Server;
  let port: number;
  let connections = 0;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), "p24b-smoke-"));
    dockerLog = path.join(sandbox, "docker.log");
    const fake = path.join(sandbox, "docker");
    writeFileSync(fake, ["#!/usr/bin/env bash", `echo "$@" >> "${dockerLog.split(path.sep).join("/")}"`, "exit 0", ""].join("\n"), "utf8");
    chmodSync(fake, 0o755);

    connections = 0;
    server = createServer((sock) => { connections += 1; sock.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(smokeDb: string, receiptBody: string | null): { status: number; stderr: string; dockerCalls: number; destructiveCalls: number; dbConnections: number } {
    const receipt = path.join(sandbox, "receipt.json");
    if (receiptBody !== null) writeFileSync(receipt, receiptBody, "utf8");
    let status = 0; let stderr = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", path.join(sandbox, "out.json"), smokeDb], {
        cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${sandbox}${path.delimiter}${process.env.PATH ?? ""}`,
          MAS_P24B_BACKUP_RECEIPT: receipt,
          MIGRATION_DATABASE_URL: `postgres://u:p@127.0.0.1:${port}/mas_radar_p24b_v23_drill`,
        },
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? -1; stderr = err.stderr ?? "";
    }
    const log = existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "";
    return {
      status, stderr,
      dockerCalls: log.split("\n").filter((l) => l.trim() !== "").length,
      destructiveCalls: (log.match(/dropdb|createdb|pg_restore/g) ?? []).length,
      dbConnections: connections,
    };
  }

  it("CASE A — korunan hedef: hiçbir yan etki oluşmuyor", () => {
    const r = run("mas_radar_dev", JSON.stringify({ receiptKind: "mas-offdevice-copy-record-v1" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("restore smoke hedefi reddedildi");
    expect(r.dbConnections).toBe(0);
    expect(r.dockerCalls).toBe(0);
    expect(r.destructiveCalls).toBe(0);
  }, INTEGRATION_TIMEOUT_MS);

  it("CASE B — geçerli harcanabilir hedef: politika kapısını GEÇİYOR", () => {
    // Makbuz kasıtlı olarak geçersiz, yani koşu yine durur — ama ARTIK ADA dair değil.
    // Aranan şey budur: CLI aynı yüklemi kullanıyor ve geçerli bir ad onu takılmıyor.
    const r = run("mas_radar_p24b_integration_drill", JSON.stringify({ receiptKind: "yanlis-kind" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("restore smoke hedefi reddedildi");
    expect(r.stderr).toContain("makbuz");
    // Ad kabul edildi ama makbuz düştü: yine hiçbir yıkıcı komut çalışmamalı.
    expect(r.destructiveCalls).toBe(0);
  }, INTEGRATION_TIMEOUT_MS);
});
