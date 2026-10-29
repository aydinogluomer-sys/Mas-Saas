// Yedek araç zincirinin TEK seçim noktası: MAS_PG_RUNTIME=native (varsayılan) | docker (CI).
//
// NEDEN BİR CEPHE. Yedek alan, doğrulayan ya da geri yükleyen her çağıran (günlük yedek,
// off-device kopya, katı makbuz, migrate'in zorunlu ön-yedeği, restore drill, AŞAMA 07 kapısı)
// bugüne kadar `docker exec mas-radar-pg …`i ya doğrudan çağırıyor ya da o dosyanın fonksiyonlarını
// import ediyordu. Docker kaldırılınca hepsi aynı anda kırıldı. Çağıranlar artık yalnız bu
// arayüzü görür; hangi araç zincirinin koşacağına burada, tek yerde karar verilir.
//
// DOCKER DALI bilerek değiştirilmedi: backup-docker-postgres.ts'in dışa açtığı fonksiyonlar
// olduğu gibi çağrılır (o dosyanın kaynak metni legacy-repair-verify ve phase33-verify tarafından
// doğrulanıyor). Konteyner adı için bugüne kadar iki ayrı değişken kullanılıyordu —
// MAS_PG_CONTAINER (yedek/off-device/kapılar) ve MAS_DB_CONTAINER (migrate) — burada tek sıraya
// bağlandı: MAS_PG_CONTAINER, sonra MAS_DB_CONTAINER, sonra `mas-radar-pg`.
//
// NATIVE DAL hedefi YAPIM ANINDA ayrıştırır: loopback olmayan bir owner URL'i adaptör oluşurken
// reddedilir, tek bir süreç başlamadan. İkili dosyalar ise TEMBEL çözülür: güncel ya da boş bir
// veritabanında `pnpm db:migrate` hiç yedek almaz ve pg_dump'a hiç ihtiyaç duymaz.
//
// Günlüklere yalnız `runtime=native kaynak=native:127.0.0.1:5432` yazılır — URL ASLA.
import {
  backupDockerPostgres, readPgToolVersions, verifyBackupTarget, verifyRestoreListable,
  type BackupResult, type BackupTargetVerificationResult, type PgToolVersions, type RestoreVerificationResult,
} from "./backup-docker-postgres";
import {
  backupNativePostgres, readPgToolVersionsNative, verifyBackupTargetNative, verifyRestoreListableNative,
  type ExecFileSyncLike, type NativeBackupContext,
} from "./backup-native-postgres";
import {
  describeNativeTarget, parseNativeTarget, resolvePgBinaries, resolvePgRuntime, type PgBinaries, type PgRuntime,
} from "./pg-native";
import { createDisposableNative, dropDisposableNative, restoreIntoNative } from "./pg-native-restore";

type EnvLike = Readonly<Record<string, string | undefined>>;

export interface AdapterBackupOptions {
  dbName: string;
  label: string;
  outDir?: string;
  requireCriticalTables?: boolean;
}

export interface BackupAdapter {
  readonly runtime: PgRuntime;
  /** Makbuzun `containerName` alanı ve günlük etiketi: konteyner adı ya da `native:<host>:<port>`. */
  readonly sourceLabel: string;
  readToolVersions(dbName: string): PgToolVersions;
  verifyTarget(dbName: string, expectedSystemIdentifier: string): BackupTargetVerificationResult;
  backup(opts: AdapterBackupOptions): Promise<BackupResult>;
  verifyRestoreListable(dumpPath: string, requireCriticalTables?: boolean): RestoreVerificationResult;
}

export interface DisposableRestoreOps {
  dropDisposable(name: string): void;
  createDisposable(name: string): void;
  restoreInto(name: string, dumpPath: string): { warned: boolean; stderrTail: string };
}

function present(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === "" ? undefined : v;
}

export function dockerContainerName(env: EnvLike): string {
  return present(env.MAS_PG_CONTAINER) ?? present(env.MAS_DB_CONTAINER) ?? "mas-radar-pg";
}

/** Günlük satırı: hangi araç zinciri, hangi kaynak. Bağlantı dizesi ASLA. */
export function describeAdapter(adapter: Pick<BackupAdapter, "runtime" | "sourceLabel">): string {
  return `runtime=${adapter.runtime} kaynak=${adapter.sourceLabel}`;
}

/**
 * Native araçların okuduğu, SIR OLMAYAN ayarlar: önce süreç ortamı, yoksa `.env.local`.
 *
 * Zamanlanmış görev `.env.local`'i process.env'e yüklemez (ve yüklememeli — o dosyada parolalar
 * var). Bu yüzden çağıran dosyayı kendisi okur ve YALNIZ bu anahtarları buraya verir; geri kalan
 * hiçbir `.env.local` değeri sürece ya da çocuk süreçlere sızmaz.
 */
export const PG_RUNTIME_ENV_KEYS = Object.freeze(["MAS_PG_RUNTIME", "MAS_PG_BIN_DIR", "MAS_BACKUP_TIMEOUT_MS"] as const);

export function withPgRuntimeConfig(env: EnvLike, fileEnv: EnvLike): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of PG_RUNTIME_ENV_KEYS) {
    if (present(out[key]) === undefined && present(fileEnv[key]) !== undefined) out[key] = fileEnv[key];
  }
  return out;
}

export function createBackupAdapter(input: {
  ownerUrl: string;
  env?: EnvLike;
  /** Yalnız docker dalı: CLI'dan açıkça verilen konteyner adı ortamdakini geçersiz kılar. */
  container?: string;
}): BackupAdapter {
  const env = input.env ?? process.env;
  const runtime = resolvePgRuntime(env);

  if (runtime === "docker") {
    const container = present(input.container) ?? dockerContainerName(env);
    return {
      runtime,
      sourceLabel: container,
      readToolVersions: (dbName) => readPgToolVersions(container, dbName),
      verifyTarget: (dbName, expectedSystemIdentifier) =>
        verifyBackupTarget({ container, dbName, expectedSystemIdentifier }),
      backup: (opts) => backupDockerPostgres({ container, ...opts }),
      verifyRestoreListable: (dumpPath, requireCriticalTables = false) =>
        verifyRestoreListable(container, dumpPath, requireCriticalTables),
    };
  }

  const target = parseNativeTarget(input.ownerUrl);
  let bins: PgBinaries | null = null;
  const getBins = (): PgBinaries => (bins ??= resolvePgBinaries(env));
  const ctx = (): NativeBackupContext => ({ target, bins: getBins(), baseEnv: env });
  return {
    runtime,
    sourceLabel: describeNativeTarget(target),
    readToolVersions: (dbName) => readPgToolVersionsNative(ctx(), dbName),
    verifyTarget: (dbName, expectedSystemIdentifier) =>
      verifyBackupTargetNative(ctx(), { dbName, expectedSystemIdentifier }),
    backup: (opts) => backupNativePostgres(ctx(), opts),
    verifyRestoreListable: (dumpPath, requireCriticalTables = false) =>
      verifyRestoreListableNative(getBins(), dumpPath, requireCriticalTables, env),
  };
}

/**
 * DDL'den önceki zorunlu yedeğin TEK sırası — dump'a güvenilebilmesi için üç adım, bu sırayla:
 *
 *   1. verifyTarget      araç yolu, çağıranın TCP bağlantısıyla AYNI kümeye (system_identifier) varıyor;
 *   2. readToolVersions  pg_dump ve pg_restore ana sürümü sunucununkine eşit (native bunu ZORLAR;
 *                        docker konteynerin kendi araçlarını ölçer);
 *   3. backup.
 *
 * NEDEN AYRI BİR FONKSİYON. migrate.ts'in ön-yedeği yalnız 1 ve 3'ü yapıyordu. Diğer bütün dump
 * çağıranları (backup-daily, backup-receipt, restore-drill, stage07) önce sürümleri okur; gerçek
 * veritabanında DDL'den hemen önce alınan TEK dump okumuyordu. Native'de MAS_PG_BIN_DIR boşken
 * araçlar PATH'ten gelir: PATH'te önde duran daha yeni bir istemci 16.x sunucuyu daha yeni bir arşiv
 * biçimiyle döker ve onu KENDİ pg_restore'u ile "doğrular"; migration'dan sonra kümenin kendi 16.x
 * pg_restore'u, migration'dan önceki tek yedeği okuyamaz. Sıra burada, tek yerde; birim testi
 * (tests/backup-adapter-select.test.ts) sürüm reddinde dump'ın hiç başlamadığını sınar. Buradaki
 * her hata ilk dump baytından ve migrate'in ilk SQL'inden ÖNCE fırlar.
 */
export async function takeVerifiedBackup(
  adapter: Pick<BackupAdapter, "verifyTarget" | "readToolVersions" | "backup">,
  opts: { dbName: string; systemIdentifier: string; label: string },
): Promise<BackupResult & { toolVersions: PgToolVersions }> {
  adapter.verifyTarget(opts.dbName, opts.systemIdentifier);
  const toolVersions = adapter.readToolVersions(opts.dbName);
  const result = await adapter.backup({ dbName: opts.dbName, label: opts.label });
  return { ...result, toolVersions };
}

/**
 * Harcanabilir veritabanlarına yazan işlemler — YALNIZ native. Docker yolunun karşılığı iki
 * kapının içinde satır içi `docker exec` çağrılarıydı; o yol artık yok ve CI bu kapıları koşmaz.
 * `sourceDb` verilmezse owner URL'inin veritabanıdır: harcanabilir hedef asla o olamaz.
 */
export function createDisposableRestoreOps(input: {
  ownerUrl: string;
  env?: EnvLike;
  sourceDb?: string;
  execImpl?: ExecFileSyncLike;
}): DisposableRestoreOps {
  const env = input.env ?? process.env;
  if (resolvePgRuntime(env) !== "native") {
    throw new Error(
      "createDisposableRestoreOps yalnız native çalışma zamanında kullanılır (MAS_PG_RUNTIME=docker iken harcanabilir restore yolu yok).",
    );
  }
  const target = parseNativeTarget(input.ownerUrl);
  const sourceDb = input.sourceDb ?? target.database;
  let bins: PgBinaries | null = null;
  const ctx = () => ({ target, bins: (bins ??= resolvePgBinaries(env)), baseEnv: env, execImpl: input.execImpl });
  return {
    dropDisposable: (name) => dropDisposableNative(ctx(), name, sourceDb),
    createDisposable: (name) => createDisposableNative(ctx(), name, sourceDb),
    restoreInto: (name, dumpPath) => restoreIntoNative(ctx(), name, dumpPath, sourceDb),
  };
}

/**
 * Off-device kopyanın HEDEFTEKİ dosyasını doğrulayan, veritabanına bağlanmayan okuyucu.
 * backup-lib.ts'in copyToTargetVerified'ı bunu enjeksiyonla alır; böylece o kütüphane hiçbir
 * araç zincirini kendisi seçmez.
 */
export function createListVerifier(
  env: EnvLike = process.env,
): (dumpPath: string, requireCriticalTables?: boolean) => RestoreVerificationResult {
  const runtime = resolvePgRuntime(env);
  if (runtime === "docker") {
    const container = dockerContainerName(env);
    return (dumpPath, requireCriticalTables = false) => verifyRestoreListable(container, dumpPath, requireCriticalTables);
  }
  let bins: PgBinaries | null = null;
  return (dumpPath, requireCriticalTables = false) =>
    verifyRestoreListableNative((bins ??= resolvePgBinaries(env)), dumpPath, requireCriticalTables, env);
}
