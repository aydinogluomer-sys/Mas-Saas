// AŞAMA 07 Bölüm D — günlük rolling yedek işi. Zamanlanmış görevin çalıştırdığı ŞEY budur.
//
// TEK KOŞUDA: dump al → doküman kasasını arşivle → makbuz yaz → off-device kopya + hedefte doğrula → retention budaması.
//
// VERİ SINIFI: kaynak `mas_radar_dev` = REAL_READ_ONLY. Bu script kaynağa YALNIZ `pg_dump`
// ve okuma sorguları (system_identifier, schema_migrations, sürüm) uygular; tek bir yazma yoktur.
// Native yolda pg_dump ve psql ayrıca `default_transaction_read_only=on` ile açılır.
//
// KAYNAK SABİT. Yedeklenen tek veritabanı bu makinedeki kümede (loopback) `mas_radar_dev`dir ve
// bu, HİÇBİR bağlantı açılmadan önce kontrol edilir (assertCanonicalBackupSource). 2026-10-18 ile
// 10-28 arasında owner URL'i bir bulut kiracısının `postgres` veritabanına çevrilmişti ve görev her
// gece onu yedeklemeye çalıştı; onu yalnız küme kimliği kapısı durdurdu. Kaynak artık URL'in
// gösterdiği şeye göre değil, sabit bir kurala göre seçilir.
//
// NEDEN `scripts/db/backup-receipt.ts` DEĞİL. O CLI temiz bir git ağacı ve beklenen bir
// branch/HEAD ister — doğru bir taleptir ve CUTOVER yedeği için vazgeçilmezdir. Ama gece 03:00'te
// zamanlayıcıdan koşan bir işin git ağacının temiz olduğunu VARSAYAMAYIZ; öyle bir koşul günlük
// yedeği "bugün çalışmadı"ya çevirir. Bu iş bu yüzden aynı DAYANIKLILIK zincirini
// (BackupAdapter.backup: fsync → temp doğrulama → atomik rename → final doğrulama) kullanır,
// git durumunu ise gizlemek yerine makbuza OLDUĞU GİBİ yazar (`git_tree_clean`). Kaybedilen
// garanti açıkça kaydedilir; sessizce zayıflatılmaz.
//
// KÜME KİMLİĞİ İKİ KEZ. TCP havuzunun okuduğu system_identifier, pg_dump'ın kullanacağı araç
// yolundan dump'tan ÖNCE ve SONRA yeniden okunur (backup-receipt.ts ile aynı iki-nokta kanıtı):
// aynı adlı iki farklı Postgres örneği en sinsi yedek hatasıdır ve kimlik yedek sırasında
// değişmemelidir.
//
// KOŞU KAYDI HER ÇIKIŞTA. `backups/daily-runs.jsonl` eskiden yalnız başarılı koşuları yazıyordu;
// 2026-09-15'ten sonraki her başarısız gece makine-okunur hiçbir iz bırakmadı. Artık sıfırdan
// farklı her çıkış da `{ ok:false, exitCode, stage, error }` satırı yazar (hata metni sırlardan
// arındırılmış olarak).
//
// ÇIKIŞ KODLARI (zamanlayıcı bunları görür):
//   0  yedek + doğrulama + off-device kopya tamam
//   1  yedek alınamadı / doğrulama düştü        → P0, geri dönülecek nokta yok demektir
//   3  yedek tamam ama OFF-DEVICE hedef yok     → tek kopya yedek değildir (politika §3)
//      (bilinçli kabul için: MAS_OFFDEVICE_ACKNOWLEDGED_MISSING=1)
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { redactSecrets } from "@/lib/ops/alert-delivery";
import { createBackupAdapter, describeAdapter, withPgRuntimeConfig, type BackupAdapter } from "../db/backup-adapter";
import { parseNativeTarget } from "../db/pg-native";
import {
  DEFAULT_RETENTION, archiveDocumentVault, classifyOffDeviceTarget, copyToTargetVerified, executePrune,
  formatBytes, listDumps, planPrune, pruneUnverifiedQuarantinedDumps, sha256OfFile, writeStage07Receipt,
  type DocumentVaultArchiveResult, type Stage07Receipt,
} from "./backup-lib";
import { writeOffDeviceRecord } from "./offdevice-copy";

/** Günlük yedeğin TEK meşru kaynağı (bkz. dosya başlığı, "KAYNAK SABİT"). */
export const CANONICAL_BACKUP_SOURCE_DB = "mas_radar_dev";

/** `.env.local`'i process.env'e SIZDIRMADAN okur (real-clone-gate.ts ile aynı desen). */
export function readEnvLocal(cwd: string = process.cwd()): Record<string, string> {
  const file = path.join(cwd, ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export interface ResolvedDailyBackupConfig {
  ownerUrl: string;
  backupDir: string;
  label: string;
  runLog: string;
  offDeviceDir: string;
  pruneApply: boolean;
  acknowledgedMissing: boolean;
  documentStorageDir: string;
}

/**
 * Görev Zamanlayıcı oturumsuz (`S4U`) çalıştığında kullanıcı `setx` değişkenleri bazen yüklenmez;
 * bu yüzden süreç ortamı (`process.env`) öncelikli olmak üzere `.env.local` değerlerine de düşülür.
 */
export function resolveDailyBackupConfig(
  processEnv: Readonly<Record<string, string | undefined>> = process.env,
  envLocal: Readonly<Record<string, string | undefined>> = {},
  cwd: string = process.cwd(),
): ResolvedDailyBackupConfig {
  const pick = (key: string): string => (processEnv[key] ?? "").trim() || (envLocal[key] ?? "").trim();
  const backupDir = pick("MAS_BACKUP_DIR") || "backups";
  const label = pick("MAS_BACKUP_LABEL") || "daily";
  return {
    ownerUrl: pick("MIGRATION_DATABASE_URL"),
    backupDir,
    label,
    runLog: path.join(backupDir, "daily-runs.jsonl"),
    offDeviceDir: pick("MAS_OFFDEVICE_BACKUP_DIR"),
    pruneApply: pick("MAS_BACKUP_PRUNE_APPLY") === "1",
    acknowledgedMissing: pick("MAS_OFFDEVICE_ACKNOWLEDGED_MISSING") === "1",
    documentStorageDir: pick("MAS_DOCUMENT_STORAGE_DIR") || path.join(cwd, ".data", "documents"),
  };
}

function gitState(): { sha: string; branch: string; clean: boolean } {
  const run = (args: string[]): string => {
    try { return execFileSync("git", args, { encoding: "utf8" }).trim(); } catch { return ""; }
  };
  return {
    sha: run(["rev-parse", "HEAD"]) || "(git yok)",
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "(git yok)",
    clean: run(["status", "--porcelain"]) === "",
  };
}

/**
 * Kaynak kapısı — SAF ve bağlantısız. Owner URL'i bu makineyi (loopback) ve `expectedDb`yi
 * göstermiyorsa fırlatır; mesaj URL'i, host'u ya da parolayı içermez.
 */
export function assertCanonicalBackupSource(ownerUrl: string, expectedDb: string = CANONICAL_BACKUP_SOURCE_DB): void {
  const target = parseNativeTarget(ownerUrl);
  if (target.database !== expectedDb) {
    throw new Error(
      `Günlük yedeğin kaynağı '${expectedDb}' olmalı; MIGRATION_DATABASE_URL '${target.database}' veritabanını ` +
        "gösteriyor — hiçbir bağlantı açılmadan durduruldu.",
    );
  }
}

/** Koşunun hangi aşamada düştüğü — telemetri ve AŞAMA 07 kapısı bu alanı okur. */
export type DailyRunStage = "config" | "identity" | "versions" | "dump" | "receipt" | "offdevice";

/**
 * Başarısız bir koşunun kaydı. SAF: test edilebilmesi için dosyaya yazmaz. Hata metni hem şekil
 * (bağlantı dizesi parolası, token) hem değer (ortamdaki gerçek parola) üzerinden maskelenir —
 * bu satır günlük dosyasında kalır ve telemetri tarafından okunur.
 */
export function buildDailyRunRecord(i: {
  startedAt: Date;
  finishedAt: Date;
  exitCode: number;
  stage: DailyRunStage;
  sourceDb: string | null;
  error: unknown;
  secrets?: readonly string[];
}): Record<string, unknown> {
  const message = i.error instanceof Error ? i.error.message : String(i.error);
  return {
    startedAt: i.startedAt.toISOString(),
    finishedAt: i.finishedAt.toISOString(),
    ok: false,
    exitCode: i.exitCode,
    stage: i.stage,
    source_db: i.sourceDb,
    error: redactSecrets(message, i.secrets ?? []).slice(0, 2000),
  };
}

/** Owner URL'inin kendisi ve çözülmüş parolası — tam-değer maskelemesi için. */
function secretValuesOf(ownerUrl: string): string[] {
  const values = ownerUrl ? [ownerUrl] : [];
  try {
    const password = decodeURIComponent(new URL(ownerUrl).password);
    if (password) values.push(password);
  } catch { /* ayrıştırılamayan URL: şekil maskelemesi yine çalışır */ }
  return values;
}

/** Koşu kaydını ekler. Kaydın YAZILAMAMASI çıkış kodunu değiştirmez ama sessiz de kalmaz. */
function appendRunRecord(backupDir: string, runLog: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(backupDir, { recursive: true });
    appendFileSync(runLog, `${JSON.stringify(record)}\n`, "utf8");
    console.log(`Koşu kaydı: ${runLog}`);
  } catch (err) {
    console.error(`Koşu kaydı YAZILAMADI (${runLog}): ${(err as Error).message}`);
  }
}

export async function runDailyBackup(): Promise<number> {
  const startedAt = new Date();
  const envLocal = readEnvLocal();
  const cfg = resolveDailyBackupConfig(process.env, envLocal);
  const { ownerUrl, backupDir, label, runLog } = cfg;
  const secrets = secretValuesOf(ownerUrl);

  const fail = (stage: DailyRunStage, error: unknown, sourceDb: string | null): number => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`YEDEK BAŞARISIZ [${stage}]: ${redactSecrets(message, secrets)}`);
    appendRunRecord(backupDir, runLog, buildDailyRunRecord({
      startedAt, finishedAt: new Date(), exitCode: 1, stage, sourceDb, error, secrets,
    }));
    return 1;
  };

  if (!ownerUrl) {
    return fail("config", new Error("MIGRATION_DATABASE_URL yok (ne ortamda ne .env.local'de). Yedek alınamaz."), null);
  }
  // Kaynak kapısı HİÇBİR bağlantıdan önce: yanlış bir hedefe tek bir paket bile gitmez.
  try {
    assertCanonicalBackupSource(ownerUrl);
  } catch (err) {
    return fail("config", err, null);
  }
  const dbName = CANONICAL_BACKUP_SOURCE_DB;

  // Araç zinciri ayarları (MAS_PG_RUNTIME, MAS_PG_BIN_DIR, MAS_BACKUP_TIMEOUT_MS): önce süreç
  // ortamı, yoksa .env.local. Yalnız bu sır-olmayan anahtarlar taşınır; .env.local'in geri kalanı
  // sürece sızmaz.
  let adapter: BackupAdapter;
  try {
    adapter = createBackupAdapter({ ownerUrl, env: withPgRuntimeConfig(process.env, envLocal) });
  } catch (err) {
    return fail("config", err, dbName);
  }
  console.log(`[${startedAt.toISOString()}] MAS günlük yedek — kaynak '${dbName}' (REAL_READ_ONLY) · ${describeAdapter(adapter)}`);

  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  let stage: DailyRunStage = "identity";
  let receipt: Stage07Receipt;
  let dumpPath: string;
  let docArchive: DocumentVaultArchiveResult | null = null;
  try {
    const meta = (await pool.query<{ db: string; sysid: string }>(
      "select current_database() db, (select system_identifier::text from pg_control_system()) sysid",
    )).rows[0];
    if (meta.db !== dbName) throw new Error(`Bağlanılan veritabanı ('${meta.db}') beklenenden ('${dbName}') farklı.`);

    // TCP bağlantısı ile pg_dump'ın kullanacağı araç yolu AYNI cluster mı — aynı isimli iki farklı
    // Postgres örneği en sinsi yedek hatasıdır.
    adapter.verifyTarget(dbName, meta.sysid);

    const ledger = (await pool.query<{ n: string; last: string | null }>(
      "select count(*)::text n, max(version) last from public.schema_migrations",
    )).rows[0];

    stage = "versions";
    const versions = adapter.readToolVersions(dbName);

    stage = "dump";
    const backup = await adapter.backup({ dbName, label, outDir: backupDir, requireCriticalTables: true });
    dumpPath = backup.path;

    // Kimlik dump SIRASINDA değişmemiş olmalı. Kanıtlanamazsa dump makbuzsuz kalır ve `.dump`
    // adından çıkarılır: yedek-yaşı alarmı makbuzsuz, kökeni kanıtlanmamış bir dosyayı "taze
    // yedek" sayamaz. Dosya SİLİNMEZ — geçici bir psql hatası iyi bir dump'ı yok etmemeli.
    stage = "identity";
    try {
      adapter.verifyTarget(dbName, meta.sysid);
    } catch (err) {
      const quarantined = `${backup.path}.unverified`;
      try { renameSync(backup.path, quarantined); } catch { /* yeniden adlandırılamadıysa hata yine yükselir */ }
      throw new Error(`Dump sonrası küme kimliği doğrulanamadı (dosya ${path.basename(quarantined)} olarak kenara alındı): ${(err as Error).message}`);
    }

    stage = "receipt";
    if (existsSync(cfg.documentStorageDir)) {
      docArchive = archiveDocumentVault(cfg.documentStorageDir, backup.path);
    }

    const git = gitState();
    receipt = {
      receiptKind: "mas-stage07-backup-receipt-v1",
      timestamp: new Date().toISOString(),
      source_db: dbName,
      system_identifier: meta.sysid,
      git_sha: git.sha,
      schema_ledger: `${ledger.n}/${ledger.last ?? "yok"}`,
      file_size: backup.bytes,
      sha256: backup.sha256,
      pg_version: versions.pgVersion,
      pg_dump_version: versions.pgDumpVersion,
      git_branch: git.branch,
      git_tree_clean: git.clean,
      dump_path: path.resolve(backup.path),
      strict_receipt_path: null,
      strict_receipt_sha256: null,
      data_class: "REAL_READ_ONLY",
      backup_source: adapter.sourceLabel,
      documents_archive_path: docArchive?.archivePath ?? null,
      documents_archive_sha256: docArchive?.archiveSha256 ?? null,
      documents_manifest_path: docArchive?.manifestPath ?? null,
      documents_file_count: docArchive?.fileCount ?? 0,
    };
    const receiptSha = writeStage07Receipt(`${backup.path}.stage07.json`, receipt);
    console.log(`Yedek     : ${backup.path} (${formatBytes(backup.bytes)}, sha256 ${backup.sha256.slice(0, 16)}…)`);
    if (docArchive) {
      console.log(`Dokümanlar: ${docArchive.archivePath} (${docArchive.fileCount} dosya, ${formatBytes(docArchive.archiveBytes)}, sha256 ${docArchive.archiveSha256.slice(0, 16)}…)`);
    }
    console.log(`Makbuz    : ${backup.path}.stage07.json (sha256 ${receiptSha.slice(0, 16)}…)`);
    console.log(`Ledger    : ${receipt.schema_ledger} · TOC ${backup.dumpVerification.tocEntryCount} girdi`);
    console.log(`Araçlar   : ${versions.pgDumpVersion} · sunucu ${versions.pgVersion.split(",")[0]}`);
  } catch (err) {
    await pool.end().catch(() => undefined);
    return fail(stage, err, dbName);
  }
  await pool.end();

  /* ── off-device kopya ─────────────────────────────────────────────────────────────────── */

  let offDeviceOk = false;
  let offDeviceNote = "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil";
  const targetDir = cfg.offDeviceDir;
  if (targetDir) {
    const classification = classifyOffDeviceTarget(targetDir, backupDir);
    try {
      const copied = copyToTargetVerified(dumpPath, classification.targetDir, {
        verifyListable: (p) => adapter.verifyRestoreListable(p),
        sourceDir: backupDir,
      });
      writeOffDeviceRecord(copied);
      offDeviceOk = copied.sha256Match && copied.bytesMatch && copied.destRestoreListable && classification.offDeviceSatisfied;
      offDeviceNote = `${classification.kind} — sha256 hedefte ${copied.sha256Match ? "eşleşti" : "EŞLEŞMEDİ"}; ${classification.evidence}`;
      console.log(`Off-device: ${copied.destPath} (${classification.kind})`);
      console.log(`            hedefte sha256 doğrulaması: ${copied.sha256Match ? "EŞLEŞTİ" : "EŞLEŞMEDİ"}`);
      console.log(`            hedefte pg_restore --list : ${copied.destRestoreListable ? `${copied.destTocEntryCount} TOC girdisi` : "OKUNAMADI"}`);
      if (copied.sidecarsCopied.length > 0) {
        console.log(`            eşlikçi dosyalar          : ${copied.sidecarsCopied.join(", ")}`);
      }
    } catch (err) {
      offDeviceNote = `kopya başarısız: ${(err as Error).message}`;
      console.error(`Off-device kopya BAŞARISIZ: ${(err as Error).message}`);
    }
  } else {
    console.warn(
      "Off-device hedef tanımlı DEĞİL. Tek kopya yedek değildir (politika §3): " +
        "harici disk/NAS bağlayıp MAS_OFFDEVICE_BACKUP_DIR ayarlayın.",
    );
  }

  /* ── retention (yerel + harici hedef + *.dump.unverified temizliği) ───────────────────── */

  const pruneApply = cfg.pruneApply;
  const plan = planPrune(listDumps(backupDir), DEFAULT_RETENTION);
  let freed = 0;
  let offDeviceFreed = 0;
  if (pruneApply) {
    const exec = executePrune(plan);
    const quarantined = pruneUnverifiedQuarantinedDumps(backupDir, DEFAULT_RETENTION.minAgeHours);
    freed = exec.bytesFreed + quarantined.bytesFreed;
    console.log(
      `Budama    : ${exec.deletedDumps.length} dump + ${quarantined.deleted.length} karantina silindi, ` +
        `${formatBytes(freed)} boşaldı (IMMUTABLE ${plan.immutableCount} dosyaya dokunulmadı)`,
    );
    if (exec.failures.length > 0) console.log(`            ${exec.failures.length} dosya atlandı`);

    if (targetDir && existsSync(targetDir)) {
      try {
        const targetPlan = planPrune(listDumps(targetDir), DEFAULT_RETENTION);
        const targetExec = executePrune(targetPlan);
        const targetQuarantined = pruneUnverifiedQuarantinedDumps(targetDir, DEFAULT_RETENTION.minAgeHours);
        offDeviceFreed = targetExec.bytesFreed + targetQuarantined.bytesFreed;
        console.log(
          `Off-device budama: ${targetExec.deletedDumps.length} eski dump silindi, ${formatBytes(offDeviceFreed)} boşaldı`,
        );
      } catch (err) {
        console.warn(`Off-device budama atlandı (${targetDir}): ${(err as Error).message}`);
      }
    }
  } else {
    console.log(`Budama    : KURU KOŞU — ${plan.prunedCount} dump budanabilir (${formatBytes(plan.bytesToFree)}); uygulamak için MAS_BACKUP_PRUNE_APPLY=1`);
  }

  /* ── koşu kaydı ───────────────────────────────────────────────────────────────────────── */

  const acknowledgedMissing = !offDeviceOk && cfg.acknowledgedMissing;
  const exitCode = offDeviceOk || acknowledgedMissing ? 0 : 3;
  appendRunRecord(backupDir, runLog, {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ok: exitCode === 0,
    exitCode,
    stage: exitCode === 0 ? null : "offdevice",
    source_db: receipt.source_db,
    backup_source: adapter.sourceLabel,
    dump: receipt.dump_path,
    sha256: receipt.sha256,
    bytes: receipt.file_size,
    documents_archive: receipt.documents_archive_path ?? null,
    documents_sha256: receipt.documents_archive_sha256 ?? null,
    documents_file_count: receipt.documents_file_count ?? 0,
    schema_ledger: receipt.schema_ledger,
    offDeviceOk,
    offDeviceNote,
    pruneApplied: pruneApply,
    prunedPlanned: plan.prunedCount,
    bytesFreed: freed,
    offDeviceBytesFreed: offDeviceFreed,
  });
  console.log(`Makbuz sha256 (yeniden okundu): ${sha256OfFile(`${dumpPath}.stage07.json`).slice(0, 16)}…`);

  if (acknowledgedMissing) {
    console.warn("OFF_DEVICE COPY = NO — operatör tarafından bilinçli olarak kabul edildi (exit 0).");
  } else if (exitCode === 3) {
    console.error(`OFF_DEVICE COPY = NO — ${offDeviceNote}. Exit 3: yedek alındı ama TEK KOPYA.`);
  }
  return exitCode;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  void runDailyBackup()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
