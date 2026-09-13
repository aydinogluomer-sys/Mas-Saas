// AŞAMA 07 Bölüm D — günlük rolling yedek işi. Zamanlanmış görevin çalıştırdığı ŞEY budur.
//
// TEK KOŞUDA: dump al → makbuz yaz → off-device kopya + hedefte doğrula → retention budaması.
//
// VERİ SINIFI: kaynak `mas_radar_dev` = REAL_READ_ONLY. Bu script kaynağa YALNIZ `pg_dump`
// ve iki okuma sorgusu (system_identifier, schema_migrations) uygular; tek bir yazma yoktur.
//
// NEDEN `scripts/db/backup-receipt.ts` DEĞİL. O CLI temiz bir git ağacı ve beklenen bir
// branch/HEAD ister — doğru bir taleptir ve CUTOVER yedeği için vazgeçilmezdir. Ama gece 03:00'te
// zamanlayıcıdan koşan bir işin git ağacının temiz olduğunu VARSAYAMAYIZ; öyle bir koşul günlük
// yedeği "bugün çalışmadı"ya çevirir. Bu iş bu yüzden aynı DAYANIKLILIK zincirini
// (backupDockerPostgres: fsync → temp doğrulama → atomik rename → final doğrulama) kullanır,
// git durumunu ise gizlemek yerine makbuza OLDUĞU GİBİ yazar (`git_tree_clean`). Kaybedilen
// garanti açıkça kaydedilir; sessizce zayıflatılmaz.
//
// ÇIKIŞ KODLARI (zamanlayıcı bunları görür):
//   0  yedek + doğrulama + off-device kopya tamam
//   1  yedek alınamadı / doğrulama düştü        → P0, geri dönülecek nokta yok demektir
//   3  yedek tamam ama OFF-DEVICE hedef yok     → tek kopya yedek değildir (politika §3)
//      (bilinçli kabul için: MAS_OFFDEVICE_ACKNOWLEDGED_MISSING=1)
//
// PHASE 7 — koşu kaydına iki alan eklendi, ikisi de tazelik sözleşmesinin girdisi:
//   toc_entry_count   pg_restore --list'in yedek anındaki sonucu; sha256 ile bu dosyaya bağlı
//                     (telemetri Docker kapalıyken bile "doğrulanmış" kararını buna dayandırır).
//   offDeviceStatus   OK | NOT_CONFIGURED | DRIVE_ABSENT | NOT_OFF_DEVICE | FAILED — "D: takılı
//                     değil" ile "kopya bozuk" aynı kelimeyle geçiştirilmez; hiçbiri sessiz PASS değil.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { backupDockerPostgres, verifyBackupTarget } from "../db/backup-docker-postgres";
import { volumeRootPresent } from "./backup-freshness-probe";
import {
  DEFAULT_RETENTION, classifyOffDeviceTarget, copyToTargetVerified, executePrune, formatBytes,
  listDumps, planPrune, readPgVersions, sha256OfFile, writeStage07Receipt, type Stage07Receipt,
} from "./backup-lib";
import { writeOffDeviceRecord } from "./offdevice-copy";

const CONTAINER = process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
const BACKUP_DIR = process.env.MAS_BACKUP_DIR ?? "backups";
const LABEL = process.env.MAS_BACKUP_LABEL ?? "daily";
const RUN_LOG = path.join(BACKUP_DIR, "daily-runs.jsonl");

/** `.env.local`'i process.env'e SIZDIRMADAN okur (real-clone-gate.ts ile aynı desen). */
function readEnvLocal(): Record<string, string> {
  const file = path.join(process.cwd(), ".env.local");
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

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

export type OffDeviceStatus = "OK" | "NOT_CONFIGURED" | "DRIVE_ABSENT" | "NOT_OFF_DEVICE" | "FAILED";

export async function runDailyBackup(): Promise<number> {
  const startedAt = new Date();
  const envLocal = readEnvLocal();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL || envLocal["MIGRATION_DATABASE_URL"] || "";
  if (!ownerUrl) {
    console.error("MIGRATION_DATABASE_URL yok (ne ortamda ne .env.local'de). Yedek alınamaz.");
    return 1;
  }
  const dbName = dbNameFromUrl(ownerUrl);
  console.log(`[${startedAt.toISOString()}] MAS günlük yedek — kaynak '${dbName}' (REAL_READ_ONLY)`);

  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  let receipt: Stage07Receipt;
  let dumpPath: string;
  let tocEntryCount: number;
  try {
    const meta = (await pool.query<{ db: string; sysid: string }>(
      "select current_database() db, (select system_identifier::text from pg_control_system()) sysid",
    )).rows[0];
    if (meta.db !== dbName) throw new Error(`Bağlanılan veritabanı ('${meta.db}') beklenenden ('${dbName}') farklı.`);

    // TCP bağlantısı ile pg_dump'ın koşacağı container AYNI cluster mı — aynı isimli iki farklı
    // Postgres örneği en sinsi yedek hatasıdır.
    verifyBackupTarget({ container: CONTAINER, dbName, expectedSystemIdentifier: meta.sysid });

    const ledger = (await pool.query<{ n: string; last: string | null }>(
      "select count(*)::text n, max(version) last from public.schema_migrations",
    )).rows[0];

    const versions = readPgVersions(CONTAINER, dbName);
    const backup = await backupDockerPostgres({
      container: CONTAINER, dbName, label: LABEL, outDir: BACKUP_DIR, requireCriticalTables: true,
    });
    dumpPath = backup.path;
    tocEntryCount = backup.dumpVerification.tocEntryCount;

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
    };
    const receiptSha = writeStage07Receipt(`${backup.path}.stage07.json`, receipt);
    console.log(`Yedek     : ${backup.path} (${formatBytes(backup.bytes)}, sha256 ${backup.sha256.slice(0, 16)}…)`);
    console.log(`Makbuz    : ${backup.path}.stage07.json (sha256 ${receiptSha.slice(0, 16)}…)`);
    console.log(`Ledger    : ${receipt.schema_ledger} · TOC ${backup.dumpVerification.tocEntryCount} girdi`);
  } catch (err) {
    console.error(`YEDEK BAŞARISIZ: ${(err as Error).message}`);
    await pool.end();
    return 1;
  }
  await pool.end();

  /* ── off-device kopya ─────────────────────────────────────────────────────────────────── */

  let offDeviceOk = false;
  let offDeviceStatus: OffDeviceStatus = "NOT_CONFIGURED";
  let offDeviceNote = "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil";
  const targetDir = process.env.MAS_OFFDEVICE_BACKUP_DIR;
  const targetVolume = targetDir ? volumeRootPresent(targetDir) : null;
  if (targetDir && targetVolume && !targetVolume.present) {
    // PHASE 7 — harici disk takılı değil. Kopyayı denemek anlamsız; ama bu "tanımsız" da
    // "başarısız" da değil: operatörün diski takması yeter, yapılandırma doğru.
    offDeviceStatus = "DRIVE_ABSENT";
    offDeviceNote = `hedef sürücü takılı değil: ${targetVolume.root} (${targetDir})`;
    console.error(`Off-device kopya YAPILAMADI — DRIVE_ABSENT: ${targetVolume.root} yok. Diski takıp işi yeniden çalıştırın.`);
  } else if (targetDir) {
    const classification = classifyOffDeviceTarget(targetDir, BACKUP_DIR);
    try {
      const copied = copyToTargetVerified(dumpPath, classification.targetDir, {
        container: CONTAINER, sourceDir: BACKUP_DIR,
      });
      writeOffDeviceRecord(copied);
      offDeviceOk = copied.sha256Match && copied.bytesMatch && classification.offDeviceSatisfied;
      offDeviceStatus = offDeviceOk ? "OK" : classification.offDeviceSatisfied ? "FAILED" : "NOT_OFF_DEVICE";
      offDeviceNote = `${classification.kind} — sha256 hedefte ${copied.sha256Match ? "eşleşti" : "EŞLEŞMEDİ"}; ${classification.evidence}`;
      console.log(`Off-device: ${copied.destPath} (${classification.kind})`);
      console.log(`            hedefte sha256 doğrulaması: ${copied.sha256Match ? "EŞLEŞTİ" : "EŞLEŞMEDİ"}`);
    } catch (err) {
      offDeviceStatus = "FAILED";
      offDeviceNote = `kopya başarısız: ${(err as Error).message}`;
      console.error(`Off-device kopya BAŞARISIZ: ${(err as Error).message}`);
    }
  } else {
    console.warn(
      "Off-device hedef tanımlı DEĞİL. Tek kopya yedek değildir (politika §3): " +
        "harici disk/NAS bağlayıp MAS_OFFDEVICE_BACKUP_DIR ayarlayın.",
    );
  }

  /* ── retention ────────────────────────────────────────────────────────────────────────── */

  const pruneApply = process.env.MAS_BACKUP_PRUNE_APPLY === "1";
  const plan = planPrune(listDumps(BACKUP_DIR), DEFAULT_RETENTION);
  let freed = 0;
  if (pruneApply) {
    const exec = executePrune(plan);
    freed = exec.bytesFreed;
    console.log(`Budama    : ${exec.deletedDumps.length} dump silindi, ${formatBytes(exec.bytesFreed)} boşaldı (IMMUTABLE ${plan.immutableCount} dosyaya dokunulmadı)`);
    if (exec.failures.length > 0) console.log(`            ${exec.failures.length} dosya atlandı`);
  } else {
    console.log(`Budama    : KURU KOŞU — ${plan.prunedCount} dump budanabilir (${formatBytes(plan.bytesToFree)}); uygulamak için MAS_BACKUP_PRUNE_APPLY=1`);
  }

  /* ── koşu kaydı ───────────────────────────────────────────────────────────────────────── */

  const record = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    source_db: receipt.source_db,
    dump: receipt.dump_path,
    sha256: receipt.sha256,
    bytes: receipt.file_size,
    schema_ledger: receipt.schema_ledger,
    toc_entry_count: tocEntryCount,
    offDeviceOk,
    offDeviceStatus,
    offDeviceNote,
    pruneApplied: pruneApply,
    prunedPlanned: plan.prunedCount,
    bytesFreed: freed,
  };
  appendFileSync(RUN_LOG, `${JSON.stringify(record)}\n`, "utf8");
  console.log(`Koşu kaydı: ${RUN_LOG}`);
  console.log(`Makbuz sha256 (yeniden okundu): ${sha256OfFile(`${dumpPath}.stage07.json`).slice(0, 16)}…`);

  if (!offDeviceOk) {
    if (process.env.MAS_OFFDEVICE_ACKNOWLEDGED_MISSING === "1") {
      console.warn(`OFF_DEVICE_COPY = ${offDeviceStatus} — operatör tarafından bilinçli olarak kabul edildi (exit 0).`);
      return 0;
    }
    console.error(`OFF_DEVICE_COPY = ${offDeviceStatus} — ${offDeviceNote}. Exit 3: yedek alındı ama TEK KOPYA.`);
    return 3;
  }
  console.log("OFF_DEVICE_COPY = OK");
  return 0;
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
