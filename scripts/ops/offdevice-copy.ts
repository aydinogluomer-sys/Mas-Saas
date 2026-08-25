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
//                  pg_restore ile ayrıştırılabiliyor, makbuz yan dosyası da kopyalandı.
//   kanıtlamaz   : hedefin fiziksel olarak ayrı bir aygıt olduğu — onu classifyOffDeviceTarget
//                  ÖLÇER ve sabit diskteki bir klasörü LOCAL_STANDIN olarak işaretler.
//                  Bu script o durumda `OFF_DEVICE PHYSICAL TARGET = BLOCKED` yazar, "YES" değil.
//
// Kullanım:
//   MAS_OFFDEVICE_BACKUP_DIR=... pnpm exec tsx scripts/ops/offdevice-copy.ts [--dump <yol>] [--dry-run]
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classifyOffDeviceTarget, copyToTargetVerified, formatBytes, newestDump, sha256OfFile,
  type CopyVerifyResult,
} from "./backup-lib";

const CONTAINER = process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
const SOURCE_DIR = process.env.MAS_BACKUP_DIR ?? "backups";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Kopyanın kaydı: hedefteki dosyanın yanına, hedefte yazılır. */
export function writeOffDeviceRecord(result: CopyVerifyResult): string {
  const recordPath = `${result.destPath}.offdevice.json`;
  const record = {
    receiptKind: "mas-offdevice-copy-record-v1" as const,
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
  writeFileSync(temp, text, "utf8");
  const fd = openSync(temp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(recordPath)) unlinkSync(recordPath);
  renameSync(temp, recordPath);
  return recordPath;
}

async function main(): Promise<void> {
  const targetDir = process.env.MAS_OFFDEVICE_BACKUP_DIR;
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

  const explicit = arg("--dump");
  const dumpPath = explicit ?? newestDump(SOURCE_DIR, "")?.fullPath;
  if (!dumpPath || !existsSync(dumpPath)) {
    console.error(`Kopyalanacak dump bulunamadı (${explicit ?? SOURCE_DIR}).`);
    process.exit(1);
  }

  const classification = classifyOffDeviceTarget(targetDir, SOURCE_DIR);
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

  if (!existsSync(classification.targetDir)) mkdirSync(classification.targetDir, { recursive: true });
  const result = copyToTargetVerified(dumpPath, classification.targetDir, {
    container: CONTAINER,
    sourceDir: SOURCE_DIR,
  });
  const recordPath = writeOffDeviceRecord(result);

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

  if (!result.sha256Match || !result.bytesMatch) process.exit(1);
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
