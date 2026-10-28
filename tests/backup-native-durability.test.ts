/**
 * `backupNativePostgres` — native yedeğin DAYANIKLILIK zinciri, gerçek pg_dump OLMADAN.
 *
 * ═══ NE SINANIYOR ═══
 *
 * Zincirin her halkası docker yolundakiyle aynı sözü veriyor: benzersiz temp → süreç çıkışı →
 * fsync → boyut > 0 → temp üzerinde okunabilirlik → atomik rename → final boyut/sha → final
 * üzerinde okunabilirlik. Bir halka düştüğünde diskte "yedek" adıyla hiçbir şey kalmamalı.
 *
 * pg_dump yerine `--file=` yoluna bayt yazan sahte bir süreç, `pg_restore --list` yerine sahte bir
 * doğrulayıcı enjekte edilir. Böylece ölçülen şey yalnız ZİNCİRİN kendisidir — ve argv/ortam:
 * parola hiçbir argümanda yok, bağlantı dizesi hiçbir argümanda yok, çocuk ortamında DATABASE_URL
 * yok. Gerçek sürecin ve gerçek arşivin sınaması orkestratörün canlı koşusudur.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RestoreVerificationResult } from "../scripts/db/backup-docker-postgres";
import { backupNativePostgres, type NativeBackupContext, type SpawnLike } from "../scripts/db/backup-native-postgres";
import { parseNativeTarget, resolvePgBinaries } from "../scripts/db/pg-native";

const SECRET = "Gizli-Parola-2026!";
const OWNER_URL = `postgres://postgres:${encodeURIComponent(SECRET)}@127.0.0.1:5432/mas_radar_dev`;
const DUMP_BYTES = Buffer.from("PGDMP-sahte-arsiv-icerigi".repeat(64), "utf8");

const BASE_ENV = Object.freeze({
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\system32",
  DATABASE_URL: "postgres://mas_radar_app:apppw@127.0.0.1:5432/mas_radar_dev",
  MIGRATION_DATABASE_URL: OWNER_URL,
  PGHOST: "10.1.2.3",
});

const CTX: NativeBackupContext = {
  target: parseNativeTarget(OWNER_URL),
  bins: resolvePgBinaries({}, { platform: "win32" }),
  baseEnv: BASE_ENV,
};

const OK_LISTING: RestoreVerificationResult = {
  restoreListable: true,
  tocEntryCount: 42,
  criticalTablesPresent: { paymentInstances: true, payments: true, auditLogs: true, schemaMigrations: true },
};

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough();
  killed = false;
  constructor(private readonly closeOnKill: boolean) {
    super();
  }
  kill(): boolean {
    this.killed = true;
    if (this.closeOnKill) setImmediate(() => this.emit("close", null, "SIGTERM"));
    return true;
  }
}

interface SpawnCall { command: string; args: string[]; env: Record<string, string> }

function fakeSpawn(behaviour: { bytes?: Buffer; code?: number; stderr?: string; never?: boolean; closeOnKill?: boolean }) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const impl: SpawnLike = (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env as Record<string, string> });
    const child = new FakeChild(behaviour.closeOnKill ?? true);
    children.push(child);
    if (!behaviour.never) {
      setImmediate(() => {
        const fileArg = args.find((a) => a.startsWith("--file="));
        if (fileArg && behaviour.bytes) writeFileSync(fileArg.slice("--file=".length), behaviour.bytes);
        if (behaviour.stderr) child.stderr.write(behaviour.stderr);
        setImmediate(() => child.emit("close", behaviour.code ?? 0, null));
      });
    }
    return child;
  };
  return { impl, calls, children };
}

function verifier(failOnCall?: number) {
  const seen: string[] = [];
  const fn = (dumpPath: string): RestoreVerificationResult => {
    seen.push(dumpPath);
    if (failOnCall !== undefined && seen.length === failOnCall) throw new Error("pg_restore --list okuyamadı (sahte)");
    return OK_LISTING;
  };
  return { fn, seen };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "mas-native-durability-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("backupNativePostgres — başarılı zincir", () => {
  it("final dosya var, temp kalmadı, sha diskten, doğrulayıcı önce temp sonra final üzerinde", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    const list = verifier();
    const result = await backupNativePostgres(
      CTX,
      { dbName: "mas_radar_dev", label: "daily", outDir: dir, requireCriticalTables: true },
      { spawnImpl: spawn.impl, listVerifier: list.fn },
    );

    expect(readdirSync(dir)).toEqual([path.basename(result.path)]);
    expect(readFileSync(result.path).equals(DUMP_BYTES)).toBe(true);
    expect(result.bytes).toBe(DUMP_BYTES.length);
    expect(result.sha256).toBe(createHash("sha256").update(DUMP_BYTES).digest("hex"));
    expect(list.seen).toHaveLength(2);
    expect(list.seen[0]).toContain(".tmp-");
    expect(list.seen[1]).toBe(result.path);
    expect(result.dumpVerification).toMatchObject({
      fileFsyncCompleted: true, tempRestoreListable: true, atomicRenameCompleted: true,
      finalByteSizeVerified: true, finalSha256Verified: true, finalRestoreListable: true, tocEntryCount: 42,
    });
  });

  it("argv: custom biçim, parola sorulmaz, --file ve --dbname; parola ya da URL HİÇBİR argümanda yok", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
      { spawnImpl: spawn.impl, listVerifier: verifier().fn });

    expect(spawn.calls).toHaveLength(1);
    const { command, args } = spawn.calls[0];
    expect(command).toBe(CTX.bins.pgDump);
    expect(args).toContain("--format=custom");
    expect(args).toContain("--no-password");
    expect(args).toContain("--dbname=mas_radar_dev");
    expect(args.some((a) => a.startsWith("--file=") && path.isAbsolute(a.slice("--file=".length)))).toBe(true);
    for (const a of args) {
      expect(a).not.toContain(SECRET);
      expect(a).not.toContain(encodeURIComponent(SECRET));
      expect(a).not.toContain("postgres://");
    }
  });

  it("çocuk ortamı: PGPASSWORD var, salt-okur oturum, DATABASE_URL ve miras PGHOST YOK", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
      { spawnImpl: spawn.impl, listVerifier: verifier().fn });

    const env = spawn.calls[0].env;
    expect(env.PGPASSWORD).toBe(SECRET);
    expect(env.PGHOST).toBe("127.0.0.1");
    expect(env.PGDATABASE).toBe("mas_radar_dev");
    expect(env.PGOPTIONS).toBe("-c default_transaction_read_only=on");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MIGRATION_DATABASE_URL).toBeUndefined();
  });
});

describe("backupNativePostgres — her kırık halkada diskte 'yedek' kalmaz", () => {
  it("pg_dump exit 1: temp silinir, final yok, stderr kuyruğu hatada (parola maskeli)", async () => {
    const spawn = fakeSpawn({ code: 1, stderr: `pg_dump: error: connection failed (password ${SECRET})` });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier().fn }),
    ).rejects.toThrow(/pg_dump çıkış kodu 1: pg_dump: error: connection failed \(password \*\*\*\)/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("sıfır bayt reddedilir", async () => {
    const spawn = fakeSpawn({});
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier().fn }),
    ).rejects.toThrow(/sıfır bayt/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("temp doğrulaması düşerse final dosya HİÇ oluşmaz", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier(1).fn }),
    ).rejects.toThrow(/temp dosya silindi, final dosya hiç oluşmadı/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("final doğrulaması düşerse rename edilmiş final dosya silinir", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier(2).fn }),
    ).rejects.toThrow(/Final dosya \(rename sonrası\)/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("final yol zaten varsa hiçbir süreç başlatılmadan reddedilir ve dosyaya dokunulmaz", async () => {
    const fixed = new Date("2026-10-28T03:00:00.000Z");
    const existing = path.join(dir, "daily-2026-10-28T03-00-00-000Z.dump");
    writeFileSync(existing, "ONCEKI-YEDEK");
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier().fn, now: () => fixed }),
    ).rejects.toThrow(/zaten mevcut, üzerine yazılmaz/);
    expect(spawn.calls).toHaveLength(0);
    expect(readFileSync(existing, "utf8")).toBe("ONCEKI-YEDEK");
    expect(readdirSync(dir)).toEqual([path.basename(existing)]);
  });

  it("zaman aşımı: süreç öldürülür, temp silinir", async () => {
    const spawn = fakeSpawn({ never: true, closeOnKill: true });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier().fn, timeoutMs: 50, killGraceMs: 2_000 }),
    ).rejects.toThrow(/bitmedi — süreç sonlandırıldı/);
    expect(spawn.children[0].killed).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("öldürülen süreç hiç kapanmasa da bekleme sonsuz değildir", async () => {
    const spawn = fakeSpawn({ never: true, closeOnKill: false });
    await expect(
      backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "daily", outDir: dir },
        { spawnImpl: spawn.impl, listVerifier: verifier().fn, timeoutMs: 30, killGraceMs: 30 }),
    ).rejects.toThrow(/bitmedi/);
    expect(spawn.children[0].killed).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("dosya adına girecek etiket ve argv'ye girecek veritabanı adı süreçten ÖNCE doğrulanır", async () => {
    const spawn = fakeSpawn({ bytes: DUMP_BYTES });
    await expect(backupNativePostgres(CTX, { dbName: "mas_radar_dev", label: "..\\kacis", outDir: dir },
      { spawnImpl: spawn.impl, listVerifier: verifier().fn })).rejects.toThrow(/etiketi/);
    await expect(backupNativePostgres(CTX, { dbName: "-f", label: "daily", outDir: dir },
      { spawnImpl: spawn.impl, listVerifier: verifier().fn })).rejects.toThrow(/düz bir tanımlayıcı değil/);
    expect(spawn.calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});
