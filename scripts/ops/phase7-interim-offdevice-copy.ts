// PHASE 7 FINAL CLOSURE — ARA (interim) off-device kopya: en yeni DOĞRULANMIŞ gerçek yedeği
// (Docker kapalıyken yeni yedek alınamadığı için 05.09 dump'ı) D: üzerindeki hedefe, kanonik
// kütüphaneyle (copyToTargetVerified + writeOffDeviceRecord) kopyalar ve hedefte pg_restore --list'i
// YEREL pg_restore ile koşar (container yok).
//
// BU BİR "FRESH OFF-DEVICE BACKUP" DEĞİLDİR ve öyle raporlanmaz. Amacı: tek kopyası neredeyse dolu
// C: diskinde duran son gerçek yedeğin ayrı fiziksel diskte doğrulanmış bir kopyasının olması.
//
// Kullanım:
//   MAS_BACKUP_DIR=<gerçek backups> MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev
//   MAS_PG_RESTORE_BIN=<pg_restore.exe> node --import tsx scripts/ops/phase7-interim-offdevice-copy.ts <dump> <out.json>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyOffDeviceTarget, copyToTargetVerified, sha256OfFile } from "./backup-lib";
import { writeOffDeviceRecord } from "./offdevice-copy";

const dump = process.argv[2];
const out = process.argv[3];
const sourceDir = process.env.MAS_BACKUP_DIR ?? "backups";
const targetDir = process.env.MAS_OFFDEVICE_BACKUP_DIR;
const pgRestore = process.env.MAS_PG_RESTORE_BIN;
if (!dump || !out || !targetDir || !pgRestore) {
  console.error("kullanım: <dump> <out.json>; MAS_OFFDEVICE_BACKUP_DIR ve MAS_PG_RESTORE_BIN zorunlu");
  process.exit(2);
}
if (!existsSync(dump)) { console.error(`dump yok: ${dump}`); process.exit(1); }

const classification = classifyOffDeviceTarget(targetDir, sourceDir);
if (!classification.offDeviceSatisfied) {
  console.error(`Hedef off-device DEĞİL: ${classification.kind} — ${classification.evidence}`);
  process.exit(1);
}
if (!existsSync(classification.targetDir)) mkdirSync(classification.targetDir, { recursive: true });

// Container verilmez: kütüphane docker adımını atlar; TOC'u aşağıda yerel pg_restore ile ölçeriz.
const result = copyToTargetVerified(dump, classification.targetDir, { sourceDir });
const listing = execFileSync(pgRestore, ["--list", result.destPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const toc = Number((listing.match(/TOC Entries:\s*(\d+)/) ?? [])[1] ?? 0);
result.destRestoreListable = toc > 0;
result.destTocEntryCount = toc;
const recordPath = writeOffDeviceRecord(result);

const report = {
  kind: "mas-phase7-interim-offdevice-copy-v1",
  label: "INTERIM — en yeni doğrulanmış gerçek yedeğin off-device kopyası (bu turun taze yedeği DEĞİL)",
  copiedAt: result.copiedAt,
  source: { path: result.sourcePath, bytes: result.sourceBytes, sha256: result.sourceSha256 },
  dest: { path: result.destPath, bytes: result.destBytes, sha256: result.destSha256 },
  SHA_MATCH: result.sha256Match, BYTES_MATCH: result.bytesMatch,
  dest_pg_restore_list: { tool: "local pg_restore 16.14", TOC: toc, listable: toc > 0 },
  sidecarsCopied: result.sidecarsCopied,
  recordPath, recordSha256: sha256OfFile(recordPath),
  target: {
    kind: classification.kind, offDeviceSatisfied: classification.offDeviceSatisfied,
    samePhysicalDisk: classification.samePhysicalDisk, targetDisk: classification.targetDisk, sourceDisk: classification.sourceDisk,
    evidence: classification.evidence,
  },
  durability: result.durability,
};
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
for (const [k, v] of Object.entries({ SOURCE_SHA: result.sourceSha256, DEST_SHA: result.destSha256, SHA_MATCH: result.sha256Match, SOURCE_BYTES: result.sourceBytes, DEST_BYTES: result.destBytes, DEST_TOC: toc, SAME_PHYSICAL_DISK: classification.samePhysicalDisk, TARGET_KIND: classification.kind, RECORD: path.basename(recordPath) })) {
  console.log(`${k.padEnd(20)} = ${String(v)}`);
}
process.exit(result.sha256Match && result.bytesMatch && toc > 0 ? 0 : 1);
