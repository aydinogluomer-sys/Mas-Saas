// Off-device hedef sınıflandırma PROBU — salt okunur.
//
// Bir yolu `classifyOffDeviceTarget()`'a verir ve ölçümün tamamını basar. Hiçbir dizin
// OLUŞTURMAZ, hiçbir dosya kopyalamaz, veritabanına dokunmaz: kararın kendisini görmek için
// gerçek bir yedek üretmek gerekmesin diye vardır.
//
// Kullanım:
//   pnpm exec tsx scripts/ops/offdevice-classify-probe.ts D:\MAS-Backups
import { pathToFileURL } from "node:url";
import path from "node:path";
import { classifyOffDeviceTarget, CLEANUP_GRADE_TARGET_KINDS } from "./backup-lib";

const SOURCE_DIR = process.env.MAS_BACKUP_DIR ?? "backups";

function main(): void {
  const target = process.argv[2];
  if (!target) {
    console.error("Kullanım: tsx scripts/ops/offdevice-classify-probe.ts <hedef-yol>");
    process.exit(2);
  }

  const c = classifyOffDeviceTarget(target, SOURCE_DIR);
  const cleanupGrade = c.offDeviceSatisfied && CLEANUP_GRADE_TARGET_KINDS.has(c.kind);

  const rows: Array<[string, string]> = [
    ["TARGET_PATH", c.targetDir],
    ["SOURCE_PATH", path.resolve(SOURCE_DIR)],
    ["LOGICAL_DRIVE_TYPE", `${c.driveType ?? "ölçülemedi"}`],
    ["PHYSICAL_DISK_NUMBER", c.targetDisk === null ? "ÖLÇÜLEMEDİ" : `${c.targetDisk.diskNumber}`],
    ["BUS_TYPE", c.targetDisk?.busType ?? "ÖLÇÜLEMEDİ"],
    ["IS_BOOT", c.targetDisk === null ? "ÖLÇÜLEMEDİ" : `${c.targetDisk.isBoot}`],
    ["IS_SYSTEM", c.targetDisk === null ? "ÖLÇÜLEMEDİ" : `${c.targetDisk.isSystem}`],
    ["OPERATIONAL_STATUS", c.targetDisk?.operationalStatus ?? "ÖLÇÜLEMEDİ"],
    ["FRIENDLY_NAME", c.targetDisk?.friendlyName ?? "—"],
    ["SOURCE_PHYSICAL_DISK_NUMBER", c.sourceDisk === null ? "ÖLÇÜLEMEDİ" : `${c.sourceDisk.diskNumber}`],
    ["SOURCE_BUS_TYPE", c.sourceDisk?.busType ?? "ÖLÇÜLEMEDİ"],
    ["SAME_PHYSICAL_DISK", c.samePhysicalDisk === null ? "BİLİNMİYOR" : `${c.samePhysicalDisk}`],
    ["SAME_VOLUME_AS_SOURCE", `${c.sameVolumeAsSource}`],
    ["TARGET_KIND", c.kind],
    ["OFF_DEVICE_SATISFIED", `${c.offDeviceSatisfied}`],
    ["CLEANUP_GRADE", `${cleanupGrade}`],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)} : ${v}`);
  console.log(`${"EVIDENCE".padEnd(w)} : ${c.evidence}`);
  console.log("");
  console.log("PROBE_MUTATIONS: 0 (dizin oluşturulmadı, dosya yazılmadı, DB'ye dokunulmadı)");
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) main();
