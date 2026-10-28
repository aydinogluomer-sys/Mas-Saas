// Native PostgreSQL 16 yedek araç zinciri — SALT OKUR. backup-docker-postgres.ts'in native
// karşılığıdır ve aynı güvenceleri verir; o dosya CI (MAS_PG_RUNTIME=docker) için bayt-bayt
// korunur, bu dosya operatör makinesinin varsayılanıdır.
//
// KAYNAĞA YALNIZ ÜÇ ŞEY DOKUNUR, ÜÇÜ DE OKUMA:
//   · pg_dump                 — `default_transaction_read_only=on` oturumunda, `--file` ile
//   · psql                    — sürüm ve kimlik SELECT'leri, aynı salt-okur oturum ayarıyla
//   · pg_restore --list       — veritabanına HİÇ bağlanmaz; diskteki arşivin içindekiler listesi
// Bu dosyada veritabanı yaratan, düşüren ya da bir arşivi veritabanına yükleyen hiçbir çağrı
// yoktur; o yetenek harcanabilir hedeflerle sınırlı olarak pg-native-restore.ts'te yaşar. Ayrım
// writer-surface denetiminin okuyabileceği kadar keskin tutulur.
//
// AYNI BAĞLANTI, İKİ KEZ. Kimlik kontrolü (current_database + system_identifier) pg_dump'ın
// kullanacağı ortamın AYNISIYLA, psql üzerinden yapılır: aynı host, port, kullanıcı, parola,
// veritabanı. Çağıran (backup-daily, backup-receipt, migrate) aynı değerleri kendi TCP havuzundan
// okur ve iki tarafın eşit olduğunu ister; böylece "havuz A kümesine, pg_dump B kümesine" ayrışması
// — aynı adlı iki farklı Postgres örneği, en sinsi yedek hatası — yakalanır.
//
// DAYANIKLILIK ZİNCİRİ docker yolunun birebir aynısı: benzersiz temp → pg_dump süreç çıkışı →
// fsync → boyut > 0 → temp üzerinde `pg_restore --list` → atomik rename → dizin fsync → final
// boyut == temp boyutu → sha256 diskten → final üzerinde `pg_restore --list`. Herhangi bir adım
// düşerse yarım dosya "yedek" adıyla ortalıkta bırakılmaz.
//
// TEK FARK: pg_dump stdout'tan borulanmaz, `--file` ile kendisi yazar. Windows'ta metin kipi
// dönüşümü ya da boru boşaltma yarışı diye bir risk bu yüzden hiç doğmaz.
import { execFileSync, spawn, type ExecFileSyncOptionsWithStringEncoding, type SpawnOptions } from "node:child_process";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import type {
  BackupResult, BackupTargetVerificationResult, PgToolVersions, RestoreVerificationResult,
} from "./backup-docker-postgres";
import { attemptDirectoryFsync, fileSha256, sameVolume } from "./legacy-repair-types";
import {
  asChildProcessEnv, assertPlainDbName, assertSameMajor, buildLibpqEnv, buildToolEnv, describeNativeTarget,
  describeSpawnFailure, parsePgMajor, redactValues, type NativePgTarget, type PgBinaries,
} from "./pg-native";
import { parseRestoreListing } from "./pg-restore-listing";

export interface NativeBackupContext {
  readonly target: NativePgTarget;
  readonly bins: PgBinaries;
  /** Çocuk ortamının izin listesiyle kopyalanacağı kaynak. Varsayılan process.env. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

function baseOf(ctx: { baseEnv?: Readonly<Record<string, string | undefined>> }): Readonly<Record<string, string | undefined>> {
  return ctx.baseEnv ?? process.env;
}

/* ── eşzamanlı araç çağrısı ──────────────────────────────────────────────────────────────── */

export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

/** Araç ÇALIŞTI ama sıfırdan farklı çıktı. `status` null ise sinyalle sonlandı. */
export class PgToolError extends Error {
  readonly tool: string;
  readonly status: number | null;
  readonly stderrTail: string;

  constructor(tool: string, status: number | null, stderrTail: string) {
    super(`${tool} çıkış kodu ${status ?? "?"}${stderrTail ? `: ${stderrTail}` : ""}`);
    this.name = "PgToolError";
    this.tool = tool;
    this.status = status;
    this.stderrTail = stderrTail;
  }
}

/**
 * Bir pg aracını KABUKSUZ çalıştırır ve hatayı okunabilir, sırsız bir mesaja çevirir.
 *
 * Kabuk yok (`shell: false`): argümanlar birleştirilip yeniden ayrıştırılmaz, dolayısıyla bir
 * veritabanı ya da dosya adı komut sözdizimine dönüşemez. stderr kuyruğu, ortamdaki parola
 * değeri ayıklanarak taşınır — libpq hata mesajları parolayı yankılamaz ama bu bir varsayım
 * olarak bırakılmaz.
 */
export function runPgToolSync(
  file: string,
  args: readonly string[],
  opts: {
    env: Record<string, string>;
    tool: string;
    timeoutMs?: number;
    maxBuffer?: number;
    secrets?: readonly (string | undefined)[];
    execImpl?: ExecFileSyncLike;
  },
): string {
  const exec: ExecFileSyncLike = opts.execImpl ?? execFileSync;
  const timeout = opts.timeoutMs ?? 120_000;
  const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
  try {
    return exec(file, args, {
      env: asChildProcessEnv(opts.env),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string | Buffer | null };
    if (e.code === "ENOENT") throw describeSpawnFailure(e, opts.tool);
    if (e.code === "ETIMEDOUT") {
      throw new Error(`${opts.tool} ${Math.round(timeout / 1000)} sn içinde bitmedi — süreç sonlandırıldı.`);
    }
    if (e.code === "ENOBUFS") {
      throw new Error(`${opts.tool} çıktısı ${maxBuffer} bayt sınırını aştı — çıktı ayrıştırılmadı.`);
    }
    const stderr = e.stderr == null ? "" : String(e.stderr);
    const tail = redactValues(stderr.trim(), opts.secrets ?? []).slice(-800);
    throw new PgToolError(opts.tool, typeof e.status === "number" ? e.status : null, tail);
  }
}

/** psql: psqlrc yok (-X), hizasız (-A), yalnız satırlar (-t), sessiz (-q), parola istemez (-w),
 * ilk hatada durur. Çıktı ayrıştırılacağı için biçim sabit tutulur. */
const PSQL_FLAGS: readonly string[] = Object.freeze(["-X", "-A", "-t", "-q", "-w", "-v", "ON_ERROR_STOP=1"]);

const IDENTITY_SQL = "select current_database(), (select system_identifier::text from pg_control_system())";

/* ── sürümler ────────────────────────────────────────────────────────────────────────────── */

/**
 * AŞAMA 07 (rehber §12 Bölüm A): sunucu ve pg_dump sürümlerini ÖLÇER ve ana sürümlerin
 * eşitliğini zorunlu kılar. pg_restore da aynı kontrolden geçer: arşivi yazan pg_dump ile onu
 * okuyacak pg_restore farklı kurulumlardan gelirse (PATH yolunda mümkün) "16.x arşivi 16.x
 * pg_restore ile okunur" iddiası kanıtsız kalırdı.
 */
export function readPgToolVersionsNative(ctx: NativeBackupContext, dbName: string): PgToolVersions {
  const secrets = [ctx.target.password];
  const env = buildLibpqEnv(ctx.target, baseOf(ctx), { database: dbName, readOnly: true });
  const pgVersion = runPgToolSync(ctx.bins.psql, [...PSQL_FLAGS, "-c", "select version()"], {
    env, tool: "psql", secrets,
  }).trim();
  const toolEnv = buildToolEnv(baseOf(ctx));
  const pgDumpVersion = runPgToolSync(ctx.bins.pgDump, ["--version"], { env: toolEnv, tool: "pg_dump" }).trim();
  const pgRestoreVersion = runPgToolSync(ctx.bins.pgRestore, ["--version"], { env: toolEnv, tool: "pg_restore" }).trim();

  const serverMajor = parsePgMajor(pgVersion);
  const dumpMajor = parsePgMajor(pgDumpVersion);
  const restoreMajor = parsePgMajor(pgRestoreVersion);
  if (serverMajor === null || dumpMajor === null || restoreMajor === null) {
    throw new Error(
      `PostgreSQL ana sürümü okunamadı (sunucu: ${JSON.stringify(pgVersion.slice(0, 60))}, ` +
        `pg_dump: ${JSON.stringify(pgDumpVersion.slice(0, 60))}, pg_restore: ${JSON.stringify(pgRestoreVersion.slice(0, 60))}) — yedek iptal edildi.`,
    );
  }
  assertSameMajor(serverMajor, dumpMajor, "pg_dump");
  assertSameMajor(serverMajor, restoreMajor, "pg_restore");
  return { pgVersion, pgDumpVersion };
}

/* ── küme kimliği ────────────────────────────────────────────────────────────────────────── */

/**
 * `dbName`in pg_dump'ın kullanacağı bağlantıdan GERÇEKTEN erişilebilir olduğunu ve beklenen
 * kümeye ait olduğunu (pg_control_system().system_identifier) doğrular.
 *
 * Dönüş alanlarının adları (`container…`) docker yoluyla tip uyumu için korunuyor; native yolda
 * anlamları "araç yolundan görülen kimlik"tir — makbuzun `source*` alanları buradan dolar.
 */
export function verifyBackupTargetNative(
  ctx: NativeBackupContext,
  v: { dbName: string; expectedSystemIdentifier: string },
): BackupTargetVerificationResult {
  const label = describeNativeTarget(ctx.target);
  const env = buildLibpqEnv(ctx.target, baseOf(ctx), { database: v.dbName, readOnly: true });
  let out: string;
  try {
    out = runPgToolSync(ctx.bins.psql, [...PSQL_FLAGS, "-F", "|", "-c", IDENTITY_SQL], {
      env, tool: "psql", secrets: [ctx.target.password],
    });
  } catch (err) {
    if (err instanceof PgToolError) {
      throw new Error(
        `Backup hedefi bulunamadı: '${v.dbName}' ${label} üzerinden okunamadı (psql çıkış kodu ${err.status ?? "?"})` +
          `${err.stderrTail ? `: ${err.stderrTail}` : "."}`,
      );
    }
    throw err;
  }
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const [databaseName = "", systemIdentifier = ""] = line.split("|");
  if (databaseName !== v.dbName) {
    throw new Error(
      `Backup hedefi bulunamadı: araç yolu '${databaseName}' veritabanına bağlandı, beklenen '${v.dbName}' (${label}).`,
    );
  }
  if (systemIdentifier === "" || systemIdentifier !== v.expectedSystemIdentifier) {
    throw new Error(
      `Cluster kimliği eşleşmedi — backup/migration iptal edildi.\n` +
        `  runner bağlantısı system_identifier = ${v.expectedSystemIdentifier}\n` +
        `  ${label} / db '${v.dbName}' system_identifier = ${systemIdentifier || "(okunamadı)"}\n` +
        `Aynı isimde farklı bir Postgres cluster'ına bağlanmış olabilirsiniz.`,
    );
  }
  return { containerDatabaseName: databaseName, containerSystemIdentifier: systemIdentifier };
}

/* ── arşiv okunabilirliği ────────────────────────────────────────────────────────────────── */

/**
 * Diskteki arşivi `pg_restore --list` ile ayrıştırır — kopya yok, veritabanı bağlantısı yok.
 * Docker yolunun dosyayı konteynere kopyalama zorunluluğu (ve onunla gelen büyük-yük hatası)
 * burada hiç doğmaz. Yol mutlak verilir: `-` ile başlayan bir ad argv'de seçenek gibi okunamaz.
 */
export function verifyRestoreListableNative(
  bins: PgBinaries,
  dumpPath: string,
  requireCriticalTables = false,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  execImpl?: ExecFileSyncLike,
): RestoreVerificationResult {
  let listing: string;
  try {
    listing = runPgToolSync(bins.pgRestore, ["--list", path.resolve(dumpPath)], {
      env: buildToolEnv(baseEnv),
      tool: "pg_restore --list",
      timeoutMs: 10 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      execImpl,
    });
  } catch (err) {
    if (err instanceof PgToolError) {
      throw new Error(`Yedek doğrulanamadı: pg_restore --list başarısız (${err.message}) (${dumpPath}).`);
    }
    throw err;
  }
  return parseRestoreListing(listing, dumpPath, requireCriticalTables);
}

/* ── dump ────────────────────────────────────────────────────────────────────────────────── */

/** Test enjeksiyonu için gereken asgari ChildProcess yüzü. Gerçek `spawn` bunu karşılar. */
export interface DumpChild {
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => DumpChild;

const defaultSpawn: SpawnLike = (command, args, options) => spawn(command, args, options);

export interface NativeBackupOptions {
  dbName: string;
  label: string;
  outDir?: string;
  /** Docker yolundaki anlamıyla aynı: dört kritik tablo zorunlu mu (bkz. BackupOptions). */
  requireCriticalTables?: boolean;
}

export interface NativeBackupDeps {
  spawnImpl?: SpawnLike;
  now?: () => Date;
  /** pg_dump için üst süre; verilmezse MAS_BACKUP_TIMEOUT_MS, o da yoksa 30 dakika. */
  timeoutMs?: number;
  /** Zaman aşımında öldürülen sürecin kapanması için tanınan ek süre. */
  killGraceMs?: number;
  /** Temp ve final dosyanın okunabilirlik doğrulayıcısı (varsayılan: pg_restore --list). */
  listVerifier?: (dumpPath: string, requireCriticalTables: boolean) => RestoreVerificationResult;
  renameRetryDelayMs?: number;
}

/** Dosya adına girecek etiket: yol ayırıcı ya da `..` taşıyamaz. */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function backupTimeoutMs(base: Readonly<Record<string, string | undefined>>): number {
  const raw = (base.MAS_BACKUP_TIMEOUT_MS ?? "").trim();
  if (raw === "") return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`MAS_BACKUP_TIMEOUT_MS pozitif bir tamsayı (milisaniye) olmalı; verilen: ${JSON.stringify(raw.slice(0, 20))}.`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dosyayı siler; zaten yoksa sessiz. Windows'ta kapanmakta olan bir tanıtıcı için kısa yeniden deneme. */
async function removeIfPresent(filePath: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "?";
      if (attempt === 5 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        return `${path.basename(filePath)} silinemedi (${code})`;
      }
      await sleep(200 * attempt);
    }
  }
  return null;
}

/**
 * Atomik rename; Windows'ta virüs tarayıcısının dosyayı kısa süre tutması (EPERM/EBUSY) için
 * SINIRLI yeniden deneme. Kopyalamaya ASLA düşülmez: kopya atomik değildir ve yarım bir dosyayı
 * final adıyla gösterebilir.
 */
async function renameWithRetry(from: string, to: string, delayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
      await sleep(delayMs * attempt);
    }
  }
}

/**
 * pg_dump'ı benzersiz bir temp dosyaya yazdırır ve docker yoluyla AYNI dayanıklılık zincirinden
 * geçirir (dosya başlığına bakın). Final yol zaten varsa hiçbir süreç başlatılmadan reddedilir;
 * hiçbir koşulda var olan bir dosyanın üzerine yazılmaz.
 */
export async function backupNativePostgres(
  ctx: NativeBackupContext,
  opts: NativeBackupOptions,
  deps: NativeBackupDeps = {},
): Promise<BackupResult> {
  assertPlainDbName(opts.dbName);
  if (!LABEL_PATTERN.test(opts.label)) {
    throw new Error(`Yedek etiketi dosya adına uygun değil: ${JSON.stringify(opts.label.slice(0, 90))}.`);
  }
  const requireCriticalTables = opts.requireCriticalTables ?? false;
  const now = deps.now ?? (() => new Date());
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const listVerifier =
    deps.listVerifier ??
    ((p: string, required: boolean) => verifyRestoreListableNative(ctx.bins, p, required, baseOf(ctx)));
  const timeoutMs = deps.timeoutMs ?? backupTimeoutMs(baseOf(ctx));
  const killGraceMs = deps.killGraceMs ?? 15_000;
  const renameDelayMs = deps.renameRetryDelayMs ?? 250;

  const outDir = opts.outDir ?? "backups";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(outDir, `${opts.label}-${stamp}.dump`);
  if (existsSync(finalPath)) {
    throw new Error(`Yedek dosyası zaten mevcut, üzerine yazılmaz: ${finalPath}`);
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  if (!sameVolume(tempPath, finalPath)) {
    throw new Error(
      `backupNativePostgres: temp yolu (${tempPath}) ve final yolu (${finalPath}) aynı volume üzerinde değil — rename atomik olmayabilir, işlem başlamadan reddedildi.`,
    );
  }
  // Temp adı ÖZEL olarak alınır ('wx'): aynı adda bir dosya varsa pg_dump onun üzerine yazmasın.
  closeSync(openSync(tempPath, "wx"));

  const env = buildLibpqEnv(ctx.target, baseOf(ctx), { database: opts.dbName, readOnly: true });
  const args = [
    "--format=custom",
    "--no-password",
    `--file=${path.resolve(tempPath)}`,
    `--dbname=${opts.dbName}`,
  ];
  const secrets = [ctx.target.password];

  try {
    await new Promise<void>((resolve, reject) => {
      let child: DumpChild;
      try {
        child = spawnImpl(ctx.bins.pgDump, args, {
          env: asChildProcessEnv(env), shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (err) {
        reject(describeSpawnFailure(err, "pg_dump"));
        return;
      }

      let settled = false;
      let timedOut = false;
      let stderr = "";
      let grace: ReturnType<typeof setTimeout> | undefined;
      const timeoutMessage = `pg_dump ${Math.round(timeoutMs / 1000)} sn içinde bitmedi — süreç sonlandırıldı.`;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* zaten kapanmış */ }
        // Öldürülen süreç 'close' yaymazsa sonsuza kadar beklenmez.
        grace = setTimeout(() => finish(new Error(timeoutMessage)), killGraceMs);
      }, timeoutMs);
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (err) reject(err);
        else resolve();
      };

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      child.on("error", (err) => finish(describeSpawnFailure(err, "pg_dump")));
      child.on("close", (code, signal) => {
        if (timedOut) return finish(new Error(timeoutMessage));
        if (code === 0) return finish();
        const tail = redactValues(stderr.trim(), secrets).slice(-800);
        finish(new Error(`pg_dump çıkış kodu ${code ?? signal ?? "?"}${tail ? `: ${tail}` : ""}`));
      });
    });
  } catch (err) {
    const leftover = await removeIfPresent(tempPath);
    throw new Error(`${(err as Error).message}${leftover ? ` (temp temizliği: ${leftover})` : ""}`);
  }

  {
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  const tempBytes = statSync(tempPath).size;
  if (tempBytes === 0) {
    unlinkSync(tempPath);
    throw new Error("Yedek dosyası sıfır bayt — reddedildi, hiçbir şey yazılmadı.");
  }

  try {
    listVerifier(tempPath, requireCriticalTables);
  } catch (err) {
    unlinkSync(tempPath);
    throw new Error(`Yedek okunabilirlik doğrulaması başarısız (temp dosya silindi, final dosya hiç oluşmadı): ${(err as Error).message}`);
  }

  if (existsSync(finalPath)) {
    unlinkSync(tempPath);
    throw new Error(`Yedek dosyası dump sırasında başka biri tarafından oluşturuldu, üzerine yazılmaz: ${finalPath}`);
  }
  try {
    await renameWithRetry(tempPath, finalPath, renameDelayMs);
  } catch (err) {
    const leftover = await removeIfPresent(tempPath);
    throw new Error(
      `Atomik rename başarısız (${(err as NodeJS.ErrnoException).code ?? "?"}) — kopyaya düşülmedi, final dosya oluşmadı` +
        `${leftover ? `; temp temizliği: ${leftover}` : ""}.`,
    );
  }
  const dumpDurability = attemptDirectoryFsync(outDir);

  const finalBytes = statSync(finalPath).size;
  if (finalBytes !== tempBytes) {
    unlinkSync(finalPath);
    throw new Error(`Rename sonrası final dosya boyutu (${finalBytes}) temp boyutuyla (${tempBytes}) eşleşmiyor — final dosya silindi.`);
  }
  const finalSha256 = fileSha256(readFileSync(finalPath));
  let finalVerification: RestoreVerificationResult;
  try {
    finalVerification = listVerifier(finalPath, requireCriticalTables);
  } catch (err) {
    unlinkSync(finalPath);
    throw new Error(`Final dosya (rename sonrası) okunabilirlik doğrulamasından geçemedi (dosya silindi): ${(err as Error).message}`);
  }

  return {
    path: finalPath,
    bytes: finalBytes,
    sha256: finalSha256,
    dumpDurability,
    dumpVerification: {
      fileFsyncCompleted: true,
      tempRestoreListable: true,
      atomicRenameCompleted: true,
      finalByteSizeVerified: true,
      finalSha256Verified: true,
      finalRestoreListable: true,
      tocEntryCount: finalVerification.tocEntryCount,
      criticalTablesPresent: finalVerification.criticalTablesPresent,
    },
  };
}
