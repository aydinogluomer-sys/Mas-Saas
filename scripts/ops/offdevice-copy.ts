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
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createListVerifier, withPgRuntimeConfig } from "../db/backup-adapter";
import { readEnvLocal } from "../db/app-url";
import {
  DEFAULT_RETENTION, classifyOffDeviceTarget, copyToTargetVerified, detectBackupPathOverlap, executePrune, formatBytes,
  listDumps, newestDump, normalizeBackupPath, planPrune, pruneUnverifiedQuarantinedDumps, sha256OfFile,
  writeBufferAtomic,
  type CopyVerifyResult,
  type OffDeviceCopyRecord,
  type OffDeviceTargetKind,
  OFFDEVICE_RECORD_KIND,
} from "./backup-lib";

export const LATEST_OFFDEVICE_POINTER_FILENAME = "latest-verified-offdevice.json";
export const LATEST_OFFDEVICE_POINTER_KIND = "mas-latest-verified-offdevice-pointer-v1";

export interface LatestVerifiedOffDevicePointer {
  pointerKind: typeof LATEST_OFFDEVICE_POINTER_KIND;
  updatedAt: string;
  copiedAt: string;
  dumpFileName: string;
  destPath: string;
  destBytes: number;
  destSha256: string;
  destTocEntryCount: number;
  offDeviceReceiptFileName: string;
  offDeviceReceiptPath: string;
  offDeviceReceiptSha256: string;
  sidecarsCopied: string[];
  targetKind: OffDeviceTargetKind;
  offDeviceSatisfied: boolean;
  targetEvidence: string;
}

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

function hasIntactPriorVerifiedOffDeviceCopy(destPath: string): boolean {
  const recordPath = `${destPath}.offdevice.json`;
  if (!existsSync(destPath) || !existsSync(recordPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<OffDeviceCopyRecord>;
    if (
      parsed.receiptKind !== OFFDEVICE_RECORD_KIND ||
      parsed.sha256VerifiedAtDestination !== true ||
      parsed.bytesVerifiedAtDestination !== true ||
      parsed.destRestoreListable !== true ||
      typeof parsed.destSha256 !== "string" ||
      typeof parsed.destBytes !== "number" ||
      parsed.destBytes <= 0
    ) {
      return false;
    }
    const diskBytes = statSync(destPath).size;
    if (diskBytes !== parsed.destBytes) return false;
    return sha256OfFile(destPath) === parsed.destSha256;
  } catch {
    return false;
  }
}

/**
 * Doğrulaması düşen hedef kopyayı, olası `.tmp-*` / `.aborted-*` kısmi dosyaları ve geçersiz
 * `.offdevice.json` kalıntısını temizler; kaynak dizine, kaynak dosyaya ya da diskte bütünlüğü
 * hâlâ sağlam olan ÖNCEKİ doğrulanmış hedef kopyaya ASLA dokunmaz (`F-10`).
 */
export function cleanupFailedOffDeviceCopy(
  targetDir: string,
  destPath: string | null,
  sourcePath: string,
): void {
  const sourceDir = path.dirname(sourcePath);
  if (detectBackupPathOverlap(targetDir, sourceDir) !== null) return;

  if (destPath && normalizeBackupPath(destPath).canonical !== normalizeBackupPath(sourcePath).canonical) {
    if (!hasIntactPriorVerifiedOffDeviceCopy(destPath)) {
      try {
        if (existsSync(destPath)) unlinkSync(destPath);
      } catch { /* zaten yok */ }
      const staleRecord = `${destPath}.offdevice.json`;
      try {
        if (existsSync(staleRecord)) unlinkSync(staleRecord);
      } catch { /* zaten yok */ }
    }
  }

  if (existsSync(targetDir)) {
    const baseName = path.basename(sourcePath);
    try {
      for (const name of readdirSync(targetDir)) {
        if (name.startsWith(baseName) && (name.includes(".tmp-") || name.includes(".aborted-"))) {
          try { unlinkSync(path.join(targetDir, name)); } catch { /* zaten yok */ }
        }
      }
    } catch { /* dizin okunamadıysa yut */ }
  }
}

/**
 * Kanonik `latest-verified-offdevice.json` işaretçi manifestini YALNIZ `copyToTargetVerified` ve
 * `<dump>.offdevice.json` makbuzu başarıyla doğrulandıktan sonra geri alınabilir (rollback-safe)
 * atomik yazımla günceller (`F-10` / `F-11`).
 */
export function writeLatestVerifiedOffDevicePointer(
  result: CopyVerifyResult,
  recordPath: string,
  opts: { renameImpl?: (oldPath: string, newPath: string) => void } = {},
): string | null {
  if (
    result.sha256Match !== true ||
    result.bytesMatch !== true ||
    result.destRestoreListable !== true ||
    result.destTocEntryCount === null ||
    result.destTocEntryCount <= 0 ||
    !existsSync(result.destPath) ||
    !existsSync(recordPath)
  ) {
    return null;
  }

  const targetDir = path.dirname(result.destPath);
  const pointerPath = path.join(targetDir, LATEST_OFFDEVICE_POINTER_FILENAME);

  // F-11 Dürüstlük Koruması: hedefte fiziksel olarak doğrulanmış (`offDeviceSatisfied: true`) bir
  // işaretçi zaten varsa ve yeni koşu `LOCAL_STANDIN` (`offDeviceSatisfied: false`) ise kanonik
  // fiziksel işaretçiyi asla yerel stand-in ile ezme.
  if (!result.classification.offDeviceSatisfied && existsSync(pointerPath)) {
    try {
      const existing = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<LatestVerifiedOffDevicePointer>;
      if (
        existing.offDeviceSatisfied === true &&
        typeof existing.destPath === "string" &&
        existsSync(existing.destPath)
      ) {
        return null;
      }
    } catch {
      /* bozuk işaretçi yeni geçerli kayıtla güncellenebilir */
    }
  }

  const pointerPayload: LatestVerifiedOffDevicePointer = {
    pointerKind: LATEST_OFFDEVICE_POINTER_KIND,
    updatedAt: new Date().toISOString(),
    copiedAt: result.copiedAt,
    dumpFileName: path.basename(result.destPath),
    destPath: result.destPath,
    destBytes: result.destBytes,
    destSha256: result.destSha256,
    destTocEntryCount: result.destTocEntryCount,
    offDeviceReceiptFileName: path.basename(recordPath),
    offDeviceReceiptPath: recordPath,
    offDeviceReceiptSha256: sha256OfFile(recordPath),
    sidecarsCopied: result.sidecarsCopied,
    targetKind: result.classification.kind,
    offDeviceSatisfied: result.classification.offDeviceSatisfied,
    targetEvidence: result.classification.evidence,
  };

  writeBufferAtomic(
    pointerPath,
    Buffer.from(`${JSON.stringify(pointerPayload, null, 2)}\n`, "utf8"),
    { renameImpl: opts.renameImpl },
  );
  return pointerPath;
}

/** Kopyanın kaydı: YALNIZ sha256 + boyut + pg_restore --list doğrulandıktan sonra hedefte yazılır. */
export function writeOffDeviceRecord(
  result: CopyVerifyResult,
  opts: { renameImpl?: (oldPath: string, newPath: string) => void; updatePointer?: boolean } = {},
): string {
  if (
    result.sha256Match !== true ||
    result.bytesMatch !== true ||
    result.destRestoreListable !== true ||
    result.destTocEntryCount === null ||
    result.destTocEntryCount <= 0 ||
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

  writeBufferAtomic(
    recordPath,
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"),
    { renameImpl: opts.renameImpl },
  );

  if (opts.updatePointer !== false) {
    writeLatestVerifiedOffDevicePointer(result, recordPath, { renameImpl: opts.renameImpl });
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
  const pointerPath = path.join(path.dirname(result.destPath), LATEST_OFFDEVICE_POINTER_FILENAME);

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
  if (existsSync(pointerPath)) {
    console.log(`kanonik işaretçi : ${pointerPath}`);
  }
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
