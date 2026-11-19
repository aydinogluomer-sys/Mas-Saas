// AŞAMA 07 Bölüm C — yedeği İKİNCİ bir depolama hedefine kopyalar ve HEDEFTE doğrular.
//
// KURULUM:
//   MAS_OFFDEVICE_BACKUP_DIR=E:\mas-yedek        (harici disk)
//   MAS_OFFDEVICE_BACKUP_DIR=\\nas\mas-yedek     (NAS / ağ paylaşımı)
//
// Değişken tanımlı değilse script HİÇBİR ŞEY yapmaz ve exit 2 ile durur — sessizce yerel bir
// klasöre düşüp "off-device tamam" demez.
//
// NE KANITLAR, NE KANITLAMAZ:
//   kanıtlar     : kopya hedefte var, boyutu ve sha256'sı kaynakla AYNI, arşiv hâlâ
//                  pg_restore ile ayrıştırılabiliyor, makbuz ve doküman kasası yan dosyaları da kopyalandı.
//   kanıtlamaz   : hedefin fiziksel olarak ayrı bir aygıt olduğu — onu classifyOffDeviceTarget
//                  ÖLÇER ve sabit diskteki bir klasörü LOCAL_STANDIN olarak işaretler.
//                  Bu script o durumda `OFF_DEVICE PHYSICAL TARGET = BLOCKED` yazar, "YES" değil.
//
// Kullanım:
//   MAS_OFFDEVICE_BACKUP_DIR=... pnpm exec tsx scripts/ops/offdevice-copy.ts [--dump <yol>] [--dry-run] [--prune]
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createListVerifier, withPgRuntimeConfig } from "../db/backup-adapter";
import { readEnvLocal } from "../db/app-url";
import {
  DEFAULT_RETENTION, classifyOffDeviceTarget, copyToTargetVerified, detectBackupPathOverlap, executePrune, formatBytes,
  listDumps, newestDump, normalizeBackupPath, planPrune, pruneUnverifiedQuarantinedDumps, sha256OfFile,
  type CopyVerifyResult,
  type OffDeviceCopyRecord,
  OFFDEVICE_RECORD_KIND,
} from "./backup-lib";

function safeEnvLocal(): Record<string, string> {
  try { return readEnvLocal(); } catch { return {}; }
}

const SOURCE_DIR = process.env.MAS_BACKUP_DIR ?? "backups";

/**
 * Hedefteki kopyayı `pg_restore --list` ile okuyacak araç zinciri ayarları (MAS_PG_RUNTIME,
 * MAS_PG_BIN_DIR): önce süreç ortamı, yoksa `.env.local` — backup-daily.ts ile aynı öncelik.
 * `.env.local`'den yalnız sır-olmayan PG_RUNTIME_ENV_KEYS taşınır.
 */
function pgToolEnv(): Record<string, string | undefined> {
  return withPgRuntimeConfig(process.env, safeEnvLocal());
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Preflight kapısı: `targetDir` kaynak dizinle aynıysa ya da iç içe çakışıyorsa HİÇBİR dosyaya
 * dokunulmadan hata fırlatır.
 */
export function assertDistinctOffDeviceTarget(targetDir: string, sourceDir: string): void {
  const overlap = detectBackupPathOverlap(targetDir, sourceDir);
  if (overlap !== null) {
    throw new Error(
      `GÜVENLİK DURDURMASI: Off-device hedef dizini kaynak dizinle çakışıyor (${overlap}: '${targetDir}' <-> '${sourceDir}'). ` +
        "Hiçbir dosyaya dokunulmadan durduruldu.",
    );
  }
}

/**
 * Doğrulaması düşen hedef kopyayı, olası `.tmp-*` kısmi dosyaları ve geçersiz `.offdevice.json`
 * kalıntısını temizler; kaynak dizine veya kaynak dosyaya ASLA dokunmaz.
 */
export function cleanupFailedOffDeviceCopy(
  targetDir: string,
  destPath: string | null,
  sourcePath: string,
): void {
  const sourceDir = path.dirname(sourcePath);
  if (detectBackupPathOverlap(targetDir, sourceDir) !== null) return;

  if (destPath && normalizeBackupPath(destPath).canonical !== normalizeBackupPath(sourcePath).canonical) {
    try {
      if (existsSync(destPath)) unlinkSync(destPath);
    } catch { /* zaten yok */ }
    const staleRecord = `${destPath}.offdevice.json`;
    try {
      if (existsSync(staleRecord)) unlinkSync(staleRecord);
    } catch { /* zaten yok */ }
  }

  if (existsSync(targetDir)) {
    const baseName = path.basename(sourcePath);
    try {
      for (const name of readdirSync(targetDir)) {
        if (name.startsWith(baseName) && name.includes(".tmp-")) {
          try { unlinkSync(path.join(targetDir, name)); } catch { /* zaten yok */ }
        }
      }
    } catch { /* dizin okunamadıysa yut */ }
  }
}

/** Kopyanın kaydı: YALNIZ sha256 + boyut + pg_restore --list doğrulandıktan sonra hedefte yazılır. */
export function writeOffDeviceRecord(result: CopyVerifyResult): string {
  if (
    result.sha256Match !== true ||
    result.bytesMatch !== true ||
    result.destRestoreListable !== true ||
    (result.destTocEntryCount !== null && result.destTocEntryCount <= 0) ||
    !result.sourceSha256 ||
    result.destSha256 !== result.sourceSha256 ||
    result.destBytes <= 0 ||
    result.destBytes !== result.sourceBytes
  ) {
    if (result.destPath && result.sourcePath) {
      cleanupFailedOffDeviceCopy(path.dirname(result.destPath), result.destPath, result.sourcePath);
    }
    throw new Error(
      `Off-device doğrulaması başarısız (sha256Match=${String(result.sha256Match)}, ` +
        `bytesMatch=${String(result.bytesMatch)}, destRestoreListable=${String(result.destRestoreListable)}) — ` +
        ".offdevice.json makbuzu YAZILMADI.",
    );
  }

  if (!existsSync(result.destPath)) {
    throw new Error(
      `Hedefteki kopya diskte bulunamadı (${result.destPath}) — .offdevice.json makbuzu YAZILMADI.`,
    );
  }

  const diskBytes = statSync(result.destPath).size;
  const diskSha256 = sha256OfFile(result.destPath);
  if (diskBytes !== result.sourceBytes || diskSha256 !== result.sourceSha256) {
    cleanupFailedOffDeviceCopy(path.dirname(result.destPath), result.destPath, result.sourcePath);
    throw new Error(
      `Hedefteki dosyanın diskteki SHA-256/boyutu kaynakla eşleşmiyor (beklenen ${result.sourceSha256.slice(0, 12)}…, ` +
        `diskte ${diskSha256.slice(0, 12)}…) — bozuk kopya kaldırıldı, .offdevice.json YAZILMADI.`,
    );
  }

  const recordPath = `${result.destPath}.offdevice.json`;
  // TİP AÇIKÇA YAZILDI: alan adları backup-lib.ts'teki TEK tanımdan gelir. Bir alanı burada
  // yeniden adlandırmak artık derleme hatası verir — `fixture-cleanup.ts` ile sessizce
  // ayrışan alan adı hatası (targetSha256Verified vs sha256VerifiedAtDestination) bu yüzden
  // tekrar edemez.
  const record: OffDeviceCopyRecord = {
    receiptKind: OFFDEVICE_RECORD_KIND,
    copiedAt: result.copiedAt,
    sourcePath: result.sourcePath,
    sourceSha256: result.sourceSha256,
    sourceBytes: result.sourceBytes,
    destPath: result.destPath,
    destSha256: result.destSha256,
    destBytes: result.destBytes,
    sha256VerifiedAtDestination: result.sha256Match,
    bytesVerifiedAtDestination: result.bytesMatch,
    destRestoreListable: result.destRestoreListable,
    destTocEntryCount: result.destTocEntryCount,
    sidecarsCopied: result.sidecarsCopied,
    targetKind: result.classification.kind,
    offDeviceSatisfied: result.classification.offDeviceSatisfied,
    targetEvidence: result.classification.evidence,
    durability: result.durability,
  };
  // writeStage07Receipt'in şema doğrulaması bu kayda uymadığı için doğrudan atomik yazım:
  // aynı temp+fsync+rename yolunu kullanan küçük bir sarmalayıcı.
  const text = JSON.stringify(record, null, 2);
  const temp = `${recordPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, text, "utf8");
    const fd = openSync(temp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(recordPath)) unlinkSync(recordPath);
    renameSync(temp, recordPath);
  } catch (err) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* zaten yok */ }
    throw err;
  }
  return recordPath;
}

async function main(): Promise<void> {
  const envLocal = safeEnvLocal();
  const sourceDir = process.env.MAS_BACKUP_DIR || envLocal["MAS_BACKUP_DIR"] || SOURCE_DIR;
  const targetDir = process.env.MAS_OFFDEVICE_BACKUP_DIR || envLocal["MAS_OFFDEVICE_BACKUP_DIR"];
  if (!targetDir) {
    console.error(
      "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil.\n" +
        "Off-device kopya, hedefi olmadan ALINMIŞ SAYILMAZ; bu script varsayılan bir yerel klasöre düşmez.\n" +
        "Operatör adımı: harici diski takın ya da NAS paylaşımını bağlayın, sonra:\n" +
        "  Windows: setx MAS_OFFDEVICE_BACKUP_DIR \"E:\\mas-yedek\"\n" +
        "  NAS    : setx MAS_OFFDEVICE_BACKUP_DIR \"\\\\nas\\mas-yedek\"",
    );
    process.exit(2);
  }

  const classification = classifyOffDeviceTarget(targetDir, sourceDir);
  if (
    detectBackupPathOverlap(targetDir, sourceDir) !== null ||
    detectBackupPathOverlap(classification.targetDir, sourceDir) !== null
  ) {
    console.error(
      `GÜVENLİK DURDURMASI: Off-device hedef dizini kaynak dizinle çakışıyor ('${classification.targetDir}' <-> '${sourceDir}'). ` +
        `Kanıt: ${classification.evidence}`,
    );
    process.exit(1);
  }

  const explicit = arg("--dump");
  const dumpPath = explicit ?? newestDump(sourceDir, "")?.fullPath;
  if (!dumpPath || !existsSync(dumpPath)) {
    console.error(`Kopyalanacak dump bulunamadı (${explicit ?? sourceDir}).`);
    process.exit(1);
  }

  if (detectBackupPathOverlap(classification.targetDir, path.dirname(dumpPath)) !== null) {
    console.error(
      `GÜVENLİK DURDURMASI: Off-device hedef dizini dump kaynak diziniyle çakışıyor ('${classification.targetDir}' <-> '${path.dirname(dumpPath)}').`,
    );
    process.exit(1);
  }

  console.log(`Kaynak dump      : ${dumpPath}`);
  console.log(`Hedef dizin      : ${classification.targetDir}`);
  console.log(`Hedef sınıfı     : ${classification.kind}`);
  console.log(`Kanıt            : ${classification.evidence}`);

  if (process.argv.includes("--dry-run")) {
    console.log("\n--dry-run: hiçbir dosya kopyalanmadı.");
    console.log(`OFF_DEVICE TOOLING         = READY`);
    console.log(`OFF_DEVICE PHYSICAL TARGET = ${classification.offDeviceSatisfied ? "OK" : "BLOCKED"}`);
    return;
  }

  let result: CopyVerifyResult;
  try {
    if (process.platform !== "win32" && /^[A-Za-z]:([\\/]|$)/.test(classification.targetDir)) {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, mkdir '${classification.targetDir}'`),
        { code: "ENOENT", syscall: "mkdir", path: classification.targetDir },
      );
    }
    if (!existsSync(classification.targetDir)) mkdirSync(classification.targetDir, { recursive: true });
    result = copyToTargetVerified(dumpPath, classification.targetDir, {
      verifyListable: createListVerifier(pgToolEnv()),
      sourceDir,
    });
  } catch (err) {
    cleanupFailedOffDeviceCopy(classification.targetDir, null, dumpPath);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (result.sha256Match !== true || result.bytesMatch !== true || result.destRestoreListable !== true) {
    cleanupFailedOffDeviceCopy(classification.targetDir, result.destPath, dumpPath);
    console.error(
      `Off-device doğrulaması BAŞARISIZ (sha256Match=${String(result.sha256Match)}, ` +
        `bytesMatch=${String(result.bytesMatch)}, destRestoreListable=${String(result.destRestoreListable)}) — ` +
        ".offdevice.json makbuzu yazılmadı.",
    );
    process.exit(1);
  }

  const recordPath = writeOffDeviceRecord(result);

  if (process.argv.includes("--prune")) {
    const plan = planPrune(listDumps(classification.targetDir), DEFAULT_RETENTION);
    const exec = executePrune(plan);
    const quarantined = pruneUnverifiedQuarantinedDumps(classification.targetDir, DEFAULT_RETENTION.minAgeHours);
    console.log(
      `hedefte budama   : ${exec.deletedDumps.length} dump + ${quarantined.deleted.length} karantina silindi (${formatBytes(exec.bytesFreed + quarantined.bytesFreed)})`,
    );
  }

  console.log(`\nKopya            : ${result.destPath} (${formatBytes(result.destBytes)})`);
  console.log(`sha256 kaynak    : ${result.sourceSha256}`);
  console.log(`sha256 HEDEFTE   : ${result.destSha256}  ${result.sha256Match ? "EŞLEŞTİ" : "EŞLEŞMEDİ"}`);
  console.log(`hedefte pg_restore --list : ${result.destRestoreListable ? `${result.destTocEntryCount} TOC girdisi` : "okunamadı"}`);
  console.log(`yan dosyalar     : ${result.sidecarsCopied.length > 0 ? result.sidecarsCopied.join(", ") : "yok"}`);
  console.log(`kayıt            : ${recordPath} (sha256 ${sha256OfFile(recordPath).slice(0, 16)}…)`);
  console.log("");
  console.log(`OFF_DEVICE TOOLING         = VERIFIED`);
  console.log(
    `OFF_DEVICE PHYSICAL TARGET = ${classification.offDeviceSatisfied ? "OK" : "BLOCKED — ayrı bir aygıt kanıtlanamadı"}`,
  );
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main as runOffDeviceCopy, SOURCE_DIR as OFFDEVICE_SOURCE_DIR };
