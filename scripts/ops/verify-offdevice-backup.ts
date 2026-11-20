// Faz 59 (F-72) — Salt-okunur yedek & harici hedef (off-device) doğrulayıcısı.
//
// KRİTİK KURAL:
//   Bu betik HİÇBİR veritabanı bağlantısı açmaz, HİÇBİR SQL çalıştırmaz ve diskteki hiçbir
//   dosyayı değiştirmez (`writer-surface` denetimi %100 temiz kalır). Yalnız en güncel `.dump`
//   dosyasının varlığını, boyutunu (> 0 bayt), yaşını (varsayılan <= 48 saat), SHA-256 özetini
//   ve yerel PostgreSQL 16 `pg_restore --list` ile içindekiler tablosu (TOC) okunabilirliğini doğrular.
//
// Davranış Modları:
//   - Varsayılan / `--allow-local-fallback`: Önce `MAS_OFFDEVICE_BACKUP_DIR` hedefini dener;
//     değişken tanımsızsa veya harici disk o an takılı/erişilebilir değilse açıkça
//     `mode = "local_fallback"`, `offDeviceConfigured`, `offDeviceReachable = false` ve
//     `offDeviceSatisfied = false` bayraklarını raporlayarak `backups/` dizinindeki en güncel
//     `.dump` yedeğinin geri yüklenebilirliğini doğrular (sessizce "off-device tamam" demez).
//   - `--strict-offdevice`: Harici hedef tanımsızsa, erişilemiyorsa veya fiziksel olarak ayrı
//     bir aygıt değilse yerel klasöre düşmez ve sıfır-dışı çıkış koduyla (`1` / `2`) durur.
//
// Kullanım:
//   pnpm backup:offdevice:verify
//   pnpm backup:offdevice:verify -- --strict-offdevice
//   pnpm backup:offdevice:verify -- --allow-local-fallback --max-age-hours 48 --json

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createListVerifier, withPgRuntimeConfig } from "../db/backup-adapter";
import { readEnvLocal } from "../db/app-url";
import {
  classifyOffDeviceTarget,
  formatBytes,
  newestDump,
  offDeviceCleanupBlockers,
  sha256OfFile,
  type OffDeviceClassification,
  type OffDeviceCopyRecord,
} from "./backup-lib";
import {
  LATEST_OFFDEVICE_POINTER_FILENAME,
  LATEST_OFFDEVICE_POINTER_KIND,
  type LatestVerifiedOffDevicePointer,
} from "./offdevice-copy";

const DEFAULT_MAX_AGE_HOURS = 48;

export interface VerifyOffDeviceOptions {
  strictOffDevice?: boolean;
  allowLocalFallback?: boolean;
  maxAgeHours?: number;
  explicitDumpPath?: string;
  now?: Date;
  localBackupDir?: string;
  offDeviceBackupDir?: string;
  classify?: (targetDir: string, sourceDir: string) => OffDeviceClassification;
  verifyList?: (
    dumpPath: string,
    requireCriticalTables?: boolean,
  ) => {
    restoreListable: boolean;
    tocEntryCount: number;
    criticalTablesPresent: VerifyOffDeviceReport["criticalTablesPresent"];
  };
}

export interface VerifyOffDeviceReport {
  ok: boolean;
  offDeviceGateStatus: "PASS" | "BLOCKED";
  checkedAt: string;
  mode: "offdevice" | "local_fallback";
  offDeviceConfigured: boolean;
  offDeviceReachable: boolean;
  offDeviceSatisfied: boolean;
  fallbackReason: string | null;
  targetKind: string;
  targetEvidence: string;
  inspectedDir: string;
  dumpPath: string | null;
  sizeBytes: number;
  sizeFormatted: string;
  ageHours: number | null;
  maxAgeHours: number;
  freshEnough: boolean;
  sha256: string | null;
  offDeviceReceiptPresent: boolean;
  offDeviceReceiptShaMatch: boolean | null;
  canonicalPointerPresent: boolean;
  canonicalPointerValid: boolean | null;
  restoreListable: boolean;
  tocEntryCount: number;
  criticalTablesPresent: {
    paymentInstances: boolean;
    payments: boolean;
    auditLogs: boolean;
    schemaMigrations: boolean;
  } | null;
  warnings: string[];
  errors: string[];
}

function safeEnvLocal(): Record<string, string> {
  try {
    return readEnvLocal();
  } catch {
    return {};
  }
}

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

export function verifyOffDeviceBackup(opts: VerifyOffDeviceOptions = {}): VerifyOffDeviceReport {
  const envLocal = safeEnvLocal();
  const localDir = (
    opts.localBackupDir ??
    process.env.MAS_BACKUP_DIR ??
    envLocal["MAS_BACKUP_DIR"] ??
    "backups"
  ).trim();
  const resolvedLocalDir = path.resolve(localDir);
  const rawOffDeviceDir = (
    opts.offDeviceBackupDir ??
    process.env.MAS_OFFDEVICE_BACKUP_DIR ??
    envLocal["MAS_OFFDEVICE_BACKUP_DIR"] ??
    ""
  ).trim();

  const offDeviceConfigured = rawOffDeviceDir.length > 0;
  const strictOffDevice = opts.strictOffDevice ?? false;
  const allowLocalFallback = strictOffDevice ? false : (opts.allowLocalFallback ?? true);
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const errors: string[] = [];
  const classifyFn = opts.classify ?? classifyOffDeviceTarget;

  let mode: "offdevice" | "local_fallback" = offDeviceConfigured ? "offdevice" : "local_fallback";
  let offDeviceReachable = false;
  let offDeviceSatisfied = false;
  let fallbackReason: string | null = null;
  let targetKind = "UNCONFIGURED";
  let targetEvidence = "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil; yerel yedek dizini kontrol ediliyor.";
  let inspectedDir = resolvedLocalDir;

  if (offDeviceConfigured) {
    const classification = classifyFn(rawOffDeviceDir, localDir);
    targetKind = classification.kind;
    targetEvidence = classification.evidence;
    offDeviceReachable = existsSync(classification.targetDir);

    if (offDeviceReachable) {
      const offDeviceNewest = newestDump(classification.targetDir, "");
      if (offDeviceNewest || opts.explicitDumpPath || !allowLocalFallback) {
        mode = "offdevice";
        inspectedDir = classification.targetDir;
        offDeviceSatisfied = classification.offDeviceSatisfied;
        if (strictOffDevice && !offDeviceSatisfied) {
          errors.push(
            `MAS_OFFDEVICE_BACKUP_DIR fiziksel olarak ayrı bir aygıt değil (${classification.kind}): ${classification.evidence}`,
          );
        } else if (!offDeviceSatisfied) {
          warnings.push(
            `MAS_OFFDEVICE_BACKUP_DIR ayrı fiziksel aygıt olarak doğrulanmadı (${classification.kind}).`,
          );
        }
      } else {
        mode = "local_fallback";
        inspectedDir = resolvedLocalDir;
        offDeviceSatisfied = false;
        fallbackReason = `MAS_OFFDEVICE_BACKUP_DIR (${classification.targetDir}) içinde henüz .dump bulunamadı; yerel '${localDir}' dizinine düşüldü.`;
        warnings.push(fallbackReason);
      }
    } else if (allowLocalFallback) {
      mode = "local_fallback";
      inspectedDir = resolvedLocalDir;
      offDeviceSatisfied = false;
      fallbackReason = `MAS_OFFDEVICE_BACKUP_DIR (${classification.targetDir}) şu an erişilebilir değil (harici disk/NAS bağlı olmayabilir); yerel '${localDir}' dizinine düşüldü.`;
      warnings.push(fallbackReason);
    } else {
      mode = "offdevice";
      inspectedDir = classification.targetDir;
      offDeviceSatisfied = false;
      errors.push(`Harici yedek dizini erişilebilir değil: ${classification.targetDir}`);
    }
  } else {
    mode = "local_fallback";
    inspectedDir = resolvedLocalDir;
    offDeviceSatisfied = false;
    fallbackReason = `MAS_OFFDEVICE_BACKUP_DIR tanımlı değil; yerel '${localDir}' dizinine düşüldü.`;
    if (!allowLocalFallback) {
      errors.push(
        "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil (--strict-offdevice modunda yerel geri dönüş kabul edilmez).",
      );
    } else {
      warnings.push(fallbackReason);
    }
  }

  if (!existsSync(inspectedDir)) {
    if (!errors.some((e) => e.includes(inspectedDir))) {
      errors.push(`Yedek dizini bulunamadı: ${inspectedDir}`);
    }
    return {
      ok: false,
      offDeviceGateStatus: "BLOCKED",
      checkedAt: now.toISOString(),
      mode,
      offDeviceConfigured,
      offDeviceReachable,
      offDeviceSatisfied,
      fallbackReason,
      targetKind,
      targetEvidence,
      inspectedDir,
      dumpPath: null,
      sizeBytes: 0,
      sizeFormatted: "0 B",
      ageHours: null,
      maxAgeHours,
      freshEnough: false,
      sha256: null,
      offDeviceReceiptPresent: false,
      offDeviceReceiptShaMatch: null,
      canonicalPointerPresent: false,
      canonicalPointerValid: null,
      restoreListable: false,
      tocEntryCount: 0,
      criticalTablesPresent: null,
      warnings,
      errors,
    };
  }

  let dumpPath: string | null = null;
  let dumpTimestamp: Date | null = null;

  if (opts.explicitDumpPath) {
    dumpPath = path.resolve(opts.explicitDumpPath);
    if (existsSync(dumpPath)) {
      dumpTimestamp = statSync(dumpPath).mtime;
    }
  } else {
    const latest = newestDump(inspectedDir, "");
    if (latest) {
      dumpPath = latest.fullPath;
      dumpTimestamp = latest.timestamp;
    }
  }

  if (!dumpPath || !existsSync(dumpPath)) {
    errors.push(`Dizinde doğrulanacak .dump yedeği bulunamadı: ${inspectedDir}`);
    return {
      ok: false,
      offDeviceGateStatus: "BLOCKED",
      checkedAt: now.toISOString(),
      mode,
      offDeviceConfigured,
      offDeviceReachable,
      offDeviceSatisfied,
      fallbackReason,
      targetKind,
      targetEvidence,
      inspectedDir,
      dumpPath,
      sizeBytes: 0,
      sizeFormatted: "0 B",
      ageHours: null,
      maxAgeHours,
      freshEnough: false,
      sha256: null,
      offDeviceReceiptPresent: false,
      offDeviceReceiptShaMatch: null,
      canonicalPointerPresent: false,
      canonicalPointerValid: null,
      restoreListable: false,
      tocEntryCount: 0,
      criticalTablesPresent: null,
      warnings,
      errors,
    };
  }

  const stat = statSync(dumpPath);
  const sizeBytes = stat.size;
  if (sizeBytes <= 0) {
    errors.push(`Yedek dosyası boş (0 bayt): ${dumpPath}`);
  }

  const effectiveTime = dumpTimestamp ?? stat.mtime;
  const ageHours = Number(Math.max(0, (now.getTime() - effectiveTime.getTime()) / 3_600_000).toFixed(2));
  const freshEnough = ageHours <= maxAgeHours;
  if (!freshEnough) {
    errors.push(
      `En güncel yedek çok eski (${ageHours} saat > izin verilen ${maxAgeHours} saat): ${dumpPath}`,
    );
  }

  const sha256 = sizeBytes > 0 ? sha256OfFile(dumpPath) : null;

  const offDeviceReceiptPath = `${dumpPath}.offdevice.json`;
  const offDeviceReceiptPresent = existsSync(offDeviceReceiptPath);
  let offDeviceReceiptShaMatch: boolean | null = null;
  let offDeviceReceiptClean = false;
  if (offDeviceReceiptPresent && sha256) {
    try {
      const parsed = JSON.parse(readFileSync(offDeviceReceiptPath, "utf8")) as Partial<OffDeviceCopyRecord>;
      offDeviceReceiptShaMatch = parsed.destSha256 === sha256;
      if (!offDeviceReceiptShaMatch) {
        errors.push(`Off-device makbuz SHA-256 özeti diskteki dosyayla uyuşmuyor: ${offDeviceReceiptPath}`);
      }
      const receiptBlockers = offDeviceCleanupBlockers(parsed);
      offDeviceReceiptClean = receiptBlockers.length === 0 && offDeviceReceiptShaMatch;
      if (strictOffDevice && receiptBlockers.length > 0) {
        errors.push(`Off-device makbuzu katı kapı doğrulamasından geçemedi: ${receiptBlockers.join("; ")}`);
      }
    } catch (err) {
      offDeviceReceiptShaMatch = false;
      errors.push(
        `Off-device makbuzu okunamadı (${offDeviceReceiptPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (strictOffDevice) {
    errors.push(`Strict off-device modunda .offdevice.json doğrulama makbuzu bulunamadı: ${offDeviceReceiptPath}`);
  }

  const pointerPath = path.join(inspectedDir, LATEST_OFFDEVICE_POINTER_FILENAME);
  const canonicalPointerPresent = mode === "offdevice" && existsSync(pointerPath);
  let canonicalPointerValid: boolean | null = null;
  if (canonicalPointerPresent) {
    try {
      const parsedPtr = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<LatestVerifiedOffDevicePointer>;
      const ptrTargetExists = typeof parsedPtr.destPath === "string" && existsSync(parsedPtr.destPath);
      const ptrShaMatch =
        ptrTargetExists &&
        typeof parsedPtr.destSha256 === "string" &&
        sha256OfFile(parsedPtr.destPath!) === parsedPtr.destSha256;
      canonicalPointerValid =
        parsedPtr.pointerKind === LATEST_OFFDEVICE_POINTER_KIND && ptrTargetExists && ptrShaMatch;
      if (!canonicalPointerValid) {
        errors.push(`Kanonik off-device işaretçisi (${pointerPath}) bozuk veya diskteki dump ile eşleşmiyor.`);
      }
    } catch (err) {
      canonicalPointerValid = false;
      errors.push(
        `Kanonik off-device işaretçisi okunamadı (${pointerPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let restoreListable = false;
  let tocEntryCount = 0;
  let criticalTablesPresent: VerifyOffDeviceReport["criticalTablesPresent"] = null;

  if (sizeBytes > 0) {
    try {
      const verifyList =
        opts.verifyList ?? createListVerifier(withPgRuntimeConfig(process.env, envLocal));
      const listRes = verifyList(dumpPath, true);
      restoreListable = listRes.restoreListable;
      tocEntryCount = listRes.tocEntryCount;
      criticalTablesPresent = listRes.criticalTablesPresent;
      if (tocEntryCount <= 0) {
        errors.push(`pg_restore --list sıfır TOC girdisi döndürdü: ${dumpPath}`);
      }
    } catch (err) {
      restoreListable = false;
      errors.push(
        `pg_restore --list doğrulaması başarısız (${dumpPath}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ok = errors.length === 0 && sizeBytes > 0 && freshEnough && restoreListable && tocEntryCount > 0;
  const offDeviceGateStatus: "PASS" | "BLOCKED" =
    ok &&
    mode === "offdevice" &&
    offDeviceSatisfied &&
    offDeviceReceiptPresent &&
    offDeviceReceiptClean
      ? "PASS"
      : "BLOCKED";

  return {
    ok,
    offDeviceGateStatus,
    checkedAt: now.toISOString(),
    mode,
    offDeviceConfigured,
    offDeviceReachable,
    offDeviceSatisfied,
    fallbackReason,
    targetKind,
    targetEvidence,
    inspectedDir,
    dumpPath,
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
    ageHours,
    maxAgeHours,
    freshEnough,
    sha256,
    offDeviceReceiptPresent,
    offDeviceReceiptShaMatch,
    canonicalPointerPresent,
    canonicalPointerValid,
    restoreListable,
    tocEntryCount,
    criticalTablesPresent,
    warnings,
    errors,
  };
}

function main(): void {
  const strictOffDevice = process.argv.includes("--strict-offdevice");
  const allowLocalFallback = !strictOffDevice && (process.argv.includes("--allow-local-fallback") || true);
  const rawMaxAge = argValue("--max-age-hours");
  const maxAgeHours = rawMaxAge ? Number(rawMaxAge) : DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error(`Geçersiz --max-age-hours değeri: ${rawMaxAge}`);
    process.exit(1);
  }
  const explicitDumpPath = argValue("--dump");

  const report = verifyOffDeviceBackup({
    strictOffDevice,
    allowLocalFallback,
    maxAgeHours,
    explicitDumpPath,
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Doğrulama modu           : ${report.mode}`);
    console.log(`offDeviceConfigured      : ${report.offDeviceConfigured}`);
    console.log(`offDeviceReachable       : ${report.offDeviceReachable}`);
    console.log(`offDeviceSatisfied       : ${report.offDeviceSatisfied} (${report.targetKind})`);
    console.log(`Hedef kanıtı             : ${report.targetEvidence}`);
    if (report.fallbackReason) {
      console.log(`Yerel geri dönüş nedeni  : ${report.fallbackReason}`);
    }
    console.log(`İncelenen dizin          : ${report.inspectedDir}`);
    console.log(`En güncel .dump          : ${report.dumpPath ?? "YOK"}`);
    console.log(`Dosya boyutu             : ${report.sizeFormatted} (${report.sizeBytes} bayt)`);
    console.log(
      `Yedek yaşı               : ${report.ageHours !== null ? `${report.ageHours} saat` : "bilinmiyor"} (üst sınır: <= ${report.maxAgeHours} saat)`,
    );
    console.log(`SHA-256                  : ${report.sha256 ?? "hesaplanmadı"}`);
    console.log(
      `pg_restore --list durumu : ${report.restoreListable ? `OK (${report.tocEntryCount} TOC girdisi)` : "BAŞARISIZ"}`,
    );
    if (report.warnings.length > 0) {
      console.log("\nUyarılar:");
      for (const w of report.warnings) {
        console.log(`  ! ${w}`);
      }
    }
    if (report.errors.length > 0) {
      console.error("\nDoğrulama Hataları:");
      for (const e of report.errors) {
        console.error(`  - ${e}`);
      }
    }
    console.log(
      `\nBACKUP_VERIFY_STATUS     = ${report.ok ? "PASS" : "FAIL"} (mode=${report.mode}, offDeviceConfigured=${report.offDeviceConfigured}, offDeviceReachable=${report.offDeviceReachable}, offDeviceSatisfied=${report.offDeviceSatisfied})`,
    );
    console.log(`OFF_DEVICE_GATE_STATUS   = ${report.offDeviceGateStatus}`);
  }

  if (!report.ok) {
    process.exit(strictOffDevice && !report.offDeviceConfigured ? 2 : 1);
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
