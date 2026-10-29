/**
 * `scripts/db/backup-adapter.ts` — araç zincirinin TEK seçim noktası ve harcanabilir yazıcının
 * kapısı. Hiçbir test gerçek bir süreç başlatmaz ve hiçbir veritabanına ulaşmaz.
 *
 * ═══ NE SINANIYOR ═══
 *
 *   1. Seçim: MAS_PG_RUNTIME → native (varsayılan) ya da docker; docker'da konteyner adı sırası
 *      MAS_PG_CONTAINER → MAS_DB_CONTAINER → mas-radar-pg (bugüne kadar iki ayrı değişkendi).
 *   2. Native hedef YAPIMDA ayrıştırılır: loopback olmayan bir owner URL'i tek bir süreç
 *      başlamadan reddedilir; ikili dosyalar ise TEMBEL çözülür.
 *   3. Harcanabilir yazıcı: korunan bir adla (mas_radar_dev, postgres, işaretsiz ad, kaynağın
 *      kendisi) yapılan her çağrı, sahte exec ÇAĞRILMADAN reddedilir. Bu, writer-surface
 *      denetiminin istediği "kapı ilk yazmadan önce" özelliğinin davranışsal kanıtıdır.
 *   4. Off-device kopyanın hedefteki dosyası enjekte edilen doğrulayıcıyla okunur; doğrulayıcının
 *      hatası yutulmaz.
 *   5. DDL öncesi yedek (migrate): küme kimliği → araç sürümleri → dump; sürüm reddinde dump
 *      hiç başlamaz (bu yolda sürüm kontrolü eskiden atlanıyordu).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFileSyncLike } from "../scripts/db/backup-native-postgres";
import {
  createBackupAdapter, createDisposableRestoreOps, createListVerifier, describeAdapter, dockerContainerName,
  takeVerifiedBackup, withPgRuntimeConfig, type BackupAdapter,
} from "../scripts/db/backup-adapter";
import type { BackupResult } from "../scripts/db/backup-docker-postgres";
import { copyToTargetVerified, type OffDeviceClassification } from "../scripts/ops/backup-lib";

const SECRET = "Sahip-Parolasi-77";
const OWNER_URL = `postgres://postgres:${encodeURIComponent(SECRET)}@127.0.0.1:5432/mas_radar_dev`;
const NATIVE_ENV = Object.freeze({ MAS_PG_RUNTIME: "native", SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\system32" });

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("fırlatması beklenen çağrı fırlatmadı");
}

describe("createBackupAdapter — seçim", () => {
  it("native: kaynak etiketi kullanıcı/parola taşımaz", () => {
    const adapter = createBackupAdapter({ ownerUrl: OWNER_URL, env: NATIVE_ENV });
    expect(adapter.runtime).toBe("native");
    expect(adapter.sourceLabel).toBe("native:127.0.0.1:5432");
    expect(describeAdapter(adapter)).toBe("runtime=native kaynak=native:127.0.0.1:5432");
  });

  it("MAS_PG_RUNTIME tanımsızken varsayılan native", () => {
    expect(createBackupAdapter({ ownerUrl: OWNER_URL, env: {} }).runtime).toBe("native");
  });

  it("native: loopback olmayan owner URL'i YAPIMDA reddedilir — host ve parola mesajda yok", () => {
    const msg = messageOf(() =>
      createBackupAdapter({ ownerUrl: `postgres://postgres:${SECRET}@db.cloud.example:5432/postgres`, env: NATIVE_ENV }),
    );
    expect(msg).toMatch(/bu makine değil/);
    expect(msg).not.toContain("db.cloud.example");
    expect(msg).not.toContain(SECRET);
  });

  it("native: ikili dosyalar TEMBEL çözülür — geçersiz MAS_PG_BIN_DIR yapımı bozmaz, ilk kullanımda süreçten önce durur", () => {
    const adapter = createBackupAdapter({ ownerUrl: OWNER_URL, env: { ...NATIVE_ENV, MAS_PG_BIN_DIR: "goreli\\bin" } });
    expect(() => adapter.readToolVersions("mas_radar_dev")).toThrow(/mutlak/);
    expect(() => adapter.verifyRestoreListable("x.dump")).toThrow(/mutlak/);
  });

  it("geçersiz MAS_PG_RUNTIME reddedilir", () => {
    expect(() => createBackupAdapter({ ownerUrl: OWNER_URL, env: { MAS_PG_RUNTIME: "podman" } })).toThrow(/MAS_PG_RUNTIME geçersiz/);
  });

  it("docker: konteyner adı MAS_PG_CONTAINER → MAS_DB_CONTAINER → mas-radar-pg; açık parametre kazanır", () => {
    expect(dockerContainerName({ MAS_PG_CONTAINER: "a", MAS_DB_CONTAINER: "b" })).toBe("a");
    expect(dockerContainerName({ MAS_DB_CONTAINER: "b" })).toBe("b");
    expect(dockerContainerName({ MAS_PG_CONTAINER: " ", MAS_DB_CONTAINER: "" })).toBe("mas-radar-pg");
    const env = { MAS_PG_RUNTIME: "docker", MAS_PG_CONTAINER: "a" };
    expect(createBackupAdapter({ ownerUrl: OWNER_URL, env }).sourceLabel).toBe("a");
    expect(createBackupAdapter({ ownerUrl: OWNER_URL, env, container: "cli-container" }).sourceLabel).toBe("cli-container");
  });

  it("docker dalı owner URL'ini ayrıştırmaz (CI konteyneri; davranış değişmedi)", () => {
    const adapter = createBackupAdapter({ ownerUrl: "postgres://u:p@ci-runner.internal:5432/x", env: { MAS_PG_RUNTIME: "docker" } });
    expect(adapter.runtime).toBe("docker");
    expect(adapter.sourceLabel).toBe("mas-radar-pg");
  });
});

describe("takeVerifiedBackup — DDL öncesi yedeğin sırası: küme kimliği → araç sürümleri → dump", () => {
  type Seq = Pick<BackupAdapter, "verifyTarget" | "readToolVersions" | "backup">;

  function recordingAdapter(overrides: Partial<Seq> = {}) {
    const calls: string[] = [];
    const adapter: Seq = {
      verifyTarget: (dbName, sysid) => {
        calls.push(`verifyTarget:${dbName}:${sysid}`);
        return { containerDatabaseName: dbName, containerSystemIdentifier: sysid };
      },
      readToolVersions: (dbName) => {
        calls.push(`readToolVersions:${dbName}`);
        return { pgVersion: "PostgreSQL 16.14 on x86_64-windows", pgDumpVersion: "pg_dump (PostgreSQL) 16.14" };
      },
      backup: async (opts) => {
        calls.push(`backup:${opts.dbName}:${opts.label}`);
        return { path: "backups\\migrate-x.dump", bytes: 10 } as BackupResult;
      },
      ...overrides,
    };
    return { adapter, calls };
  }

  it("sürümleri dump'tan ÖNCE okur ve rapora taşır", async () => {
    const { adapter, calls } = recordingAdapter();
    const result = await takeVerifiedBackup(adapter, { dbName: "mas_radar_dev", systemIdentifier: "7", label: "migrate-mas_radar_dev" });
    expect(calls).toEqual([
      "verifyTarget:mas_radar_dev:7",
      "readToolVersions:mas_radar_dev",
      "backup:mas_radar_dev:migrate-mas_radar_dev",
    ]);
    expect(result.toolVersions.pgDumpVersion).toBe("pg_dump (PostgreSQL) 16.14");
    expect(result.path).toBe("backups\\migrate-x.dump");
  });

  it("ana sürüm reddi (PATH'te daha yeni pg_dump) dump'ı HİÇ başlatmaz", async () => {
    const { adapter, calls } = recordingAdapter({
      readToolVersions: () => {
        throw new Error("pg_dump ana sürümü (17) sunucununkiyle (16) aynı değil — yedek iptal edildi.");
      },
    });
    await expect(
      takeVerifiedBackup(adapter, { dbName: "mas_radar_dev", systemIdentifier: "7", label: "migrate-mas_radar_dev" }),
    ).rejects.toThrow(/ana sürümü/);
    expect(calls).toEqual(["verifyTarget:mas_radar_dev:7"]);
  });

  it("küme kimliği tutmazsa sürüm bile okunmaz", async () => {
    const { adapter, calls } = recordingAdapter({
      verifyTarget: () => {
        throw new Error("system_identifier uyuşmuyor");
      },
    });
    await expect(
      takeVerifiedBackup(adapter, { dbName: "mas_radar_dev", systemIdentifier: "7", label: "l" }),
    ).rejects.toThrow(/system_identifier/);
    expect(calls).toEqual([]);
  });

  it("migrate.ts'in zorunlu ön-yedeği bu sırayı kullanır; adaptörün backup()'ını doğrudan çağırmaz", () => {
    // migrate.ts import edilemez (yüklenirken main() koşar); kaynak düzeyinde bağlanır.
    const src = readFileSync(path.join(process.cwd(), "scripts", "db", "migrate.ts"), "utf8");
    expect(src).toMatch(/return takeVerifiedBackup\(backupTarget\.adapter,/);
    expect(src).not.toMatch(/adapter\.backup\(/);
  });
});

describe("withPgRuntimeConfig — .env.local'den YALNIZ sır olmayan araç ayarları", () => {
  it("süreç ortamı kazanır; dosya yalnız eksikleri doldurur; başka anahtar taşınmaz", () => {
    const merged = withPgRuntimeConfig(
      { MAS_PG_RUNTIME: "docker" },
      {
        MAS_PG_RUNTIME: "native", MAS_PG_BIN_DIR: "C:\\MAS\\pgsql16\\bin", MAS_BACKUP_TIMEOUT_MS: "60000",
        DATABASE_URL: "postgres://app:pw@127.0.0.1/mas_radar_dev", TELEGRAM_BOT_TOKEN: "1:abc",
      },
    );
    expect(merged.MAS_PG_RUNTIME).toBe("docker");
    expect(merged.MAS_PG_BIN_DIR).toBe("C:\\MAS\\pgsql16\\bin");
    expect(merged.MAS_BACKUP_TIMEOUT_MS).toBe("60000");
    expect(merged.DATABASE_URL).toBeUndefined();
    expect(merged.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});

describe("createDisposableRestoreOps — kapı her araç çağrısından ÖNCE", () => {
  function opsWithSpy(ownerUrl = OWNER_URL) {
    const exec = vi.fn<ExecFileSyncLike>(() => "");
    const ops = createDisposableRestoreOps({ ownerUrl, env: NATIVE_ENV, execImpl: exec });
    return { ops, exec };
  }

  it.each(["mas_radar_dev", "postgres", "template1", "mas_radar_prod", "MAS_RADAR_X_VERIFY"])(
    "'%s' düşürülemez, yaratılamaz, üzerine yüklenemez — tek bir süreç bile başlamaz",
    (name) => {
      const { ops, exec } = opsWithSpy();
      expect(() => ops.dropDisposable(name)).toThrow(/GÜVENLİK DURDURMASI/);
      expect(() => ops.createDisposable(name)).toThrow(/GÜVENLİK DURDURMASI/);
      expect(() => ops.restoreInto(name, "x.dump")).toThrow(/GÜVENLİK DURDURMASI/);
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it("kaynak veritabanının kendisi, harcanabilir işaret taşısa bile hedef olamaz", () => {
    const { ops, exec } = opsWithSpy(`postgres://postgres:${encodeURIComponent(SECRET)}@127.0.0.1:5432/mas_radar_src_clone`);
    expect(() => ops.dropDisposable("mas_radar_src_clone")).toThrow(/kaynak veritabanının kendisi/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("harcanabilir hedef: bakım bağlantısıyla düşürülür; parola argv'de değil ortamda", () => {
    const { ops, exec } = opsWithSpy();
    ops.dropDisposable("mas_radar_stage07_restore");
    expect(exec).toHaveBeenCalledTimes(1);
    const [, args, options] = exec.mock.calls[0];
    expect(args).toEqual(["--force", "--if-exists", "--no-password", "--maintenance-db=postgres", "mas_radar_stage07_restore"]);
    expect(options.env?.PGDATABASE).toBe("postgres");
    expect(options.env?.PGPASSWORD).toBe(SECRET);
    expect(options.env?.PGOPTIONS).toBeUndefined();
    expect(options.shell).toBe(false);
    for (const a of args) expect(a).not.toContain(SECRET);
  });

  it("restore: --no-owner EVET, --no-acl HAYIR (GRANT'lar geri gelmeli); başarı = warned false", () => {
    const { ops, exec } = opsWithSpy();
    const result = ops.restoreInto("mas_radar_stage07_restore", "backups\\daily-x.dump");
    const args = exec.mock.calls[0][1];
    expect(args).toContain("--no-owner");
    expect(args).not.toContain("--no-acl");
    expect(args).toContain("--dbname=mas_radar_stage07_restore");
    expect(path.isAbsolute(args[args.length - 1])).toBe(true);
    expect(result).toEqual({ warned: false, stderrTail: "" });
  });

  it("restore sıfırdan farklı döndüğünde istisna değil 'warned' olur (karar parmak izinin)", () => {
    const exec = vi.fn<ExecFileSyncLike>(() => {
      throw Object.assign(new Error("Command failed"), { status: 1, stderr: "pg_restore: warning: errors ignored on restore: 3" });
    });
    const ops = createDisposableRestoreOps({ ownerUrl: OWNER_URL, env: NATIVE_ENV, execImpl: exec });
    expect(ops.restoreInto("mas_radar_stage07_restore", "x.dump")).toEqual({
      warned: true, stderrTail: "pg_restore: warning: errors ignored on restore: 3",
    });
  });

  it("aracın hiç bulunamaması 'warned' DEĞİL, açık bir hatadır", () => {
    const exec = vi.fn<ExecFileSyncLike>(() => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    const ops = createDisposableRestoreOps({ ownerUrl: OWNER_URL, env: NATIVE_ENV, execImpl: exec });
    expect(() => ops.restoreInto("mas_radar_stage07_restore", "x.dump")).toThrow(/bulunamadı — MAS_PG_BIN_DIR/);
  });

  it("docker çalışma zamanında harcanabilir restore yolu yoktur", () => {
    expect(() => createDisposableRestoreOps({ ownerUrl: OWNER_URL, env: { MAS_PG_RUNTIME: "docker" } })).toThrow(/yalnız native/);
  });
});

describe("createListVerifier", () => {
  it("native doğrulayıcı tembeldir: geçersiz bin dizini çağrıda, süreçten önce durur", () => {
    const verify = createListVerifier({ ...NATIVE_ENV, MAS_PG_BIN_DIR: "goreli\\bin" });
    expect(() => verify("x.dump")).toThrow(/mutlak/);
  });
});

describe("copyToTargetVerified — hedefteki dosya enjekte edilen doğrulayıcıyla okunur", () => {
  let src: string;
  let dest: string;

  beforeEach(() => {
    src = mkdtempSync(path.join(os.tmpdir(), "mas-offdevice-src-"));
    dest = mkdtempSync(path.join(os.tmpdir(), "mas-offdevice-dest-"));
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  });

  const classify = (targetDir: string): OffDeviceClassification => ({
    targetDir: path.resolve(targetDir),
    kind: "USB_PHYSICAL_VOLUME",
    offDeviceSatisfied: true,
    evidence: "test sınıflandırması",
    sameVolumeAsSource: false,
    driveType: 3,
    targetDisk: null,
    sourceDisk: null,
    samePhysicalDisk: false,
    declaredKind: null,
    operatorAttestation: null,
  });

  function seedDump(): string {
    const dump = path.join(src, "daily-2026-10-28T03-00-00-000Z.dump");
    writeFileSync(dump, "PGDMP-sahte");
    writeFileSync(`${dump}.stage07.json`, "{}");
    return dump;
  }

  it("doğrulayıcı HEDEFTEKİ kopya üzerinde çağrılır; TOC > 0 → destRestoreListable", () => {
    const dump = seedDump();
    const seen: string[] = [];
    const result = copyToTargetVerified(dump, dest, {
      sourceDir: src, classify,
      verifyListable: (p) => { seen.push(p); return { tocEntryCount: 7 }; },
    });
    expect(seen).toEqual([result.destPath]);
    expect(path.dirname(result.destPath)).toBe(dest);
    expect(result.destRestoreListable).toBe(true);
    expect(result.destTocEntryCount).toBe(7);
    expect(result.sha256Match && result.bytesMatch).toBe(true);
    expect(result.sidecarsCopied).toEqual([`${path.basename(dump)}.stage07.json`]);
  });

  it("doğrulayıcının hatası YUTULMAZ", () => {
    const dump = seedDump();
    expect(() => copyToTargetVerified(dump, dest, {
      sourceDir: src, classify,
      verifyListable: () => { throw new Error("hedefteki arşiv okunamadı"); },
    })).toThrow(/hedefteki arşiv okunamadı/);
  });

  it("doğrulayıcı verilmezse okunabilirlik iddia edilmez", () => {
    const dump = seedDump();
    const result = copyToTargetVerified(dump, dest, { sourceDir: src, classify });
    expect(result.destRestoreListable).toBe(false);
    expect(result.destTocEntryCount).toBeNull();
  });
});
