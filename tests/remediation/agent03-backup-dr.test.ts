import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateOffDeviceRunLog } from "@/lib/ops/telemetry-alerts";
import {
  OFFDEVICE_RECORD_KIND,
  classifyOffDeviceTarget,
  copyToTargetVerified,
  detectBackupPathOverlap,
  executePrune,
  isVerifiedDumpEntry,
  listDumps,
  normalizeBackupPath,
  offDeviceCleanupBlockers,
  planPrune,
  sha256OfFile,
  writeSha256Sidecar,
  type DumpEntry,
  type OffDeviceClassification,
  type OffDeviceCopyRecord,
  type RetentionPolicy,
} from "../../scripts/ops/backup-lib";
import {
  assertDistinctOffDeviceTarget,
  cleanupFailedOffDeviceCopy,
  writeOffDeviceRecord,
} from "../../scripts/ops/offdevice-copy";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function mockUsbClassification(targetDir: string): OffDeviceClassification {
  return {
    targetDir,
    kind: "USB_PHYSICAL_VOLUME",
    offDeviceSatisfied: true,
    evidence: "Test USB fiziksel aygıtı (DriveType=3, BusType=USB, targetDisk=1, sourceDisk=0)",
    sameVolumeAsSource: false,
    driveType: 3,
    targetDisk: {
      diskNumber: 1,
      busType: "USB",
      isBoot: false,
      isSystem: false,
      operationalStatus: "Online",
      friendlyName: "Test External SSD",
    },
    sourceDisk: {
      diskNumber: 0,
      busType: "NVMe",
      isBoot: true,
      isSystem: true,
      operationalStatus: "Online",
      friendlyName: "System NVMe",
    },
    samePhysicalDisk: false,
    declaredKind: null,
    operatorAttestation: null,
  };
}

describe("AGENT 03 — Backup, Restore & Disaster Recovery Remediation (I-003)", () => {
  it("surfaces ENOENT when off-device destination drive/directory (D:\\MAS-Backups\\mas_radar_dev) is absent and never creates a receipt", () => {
    const sourceDir = createTempDir("mas-agent03-src-enoent-");
    const dumpPath = path.join(sourceDir, "daily-2026-11-18T00-00-44-034Z.dump");
    writeFileSync(dumpPath, "PGDMP-TEST-ARCHIVE-PAYLOAD", "utf8");

    const candidateDrives = ["D:", "Z:", "Y:", "X:", "W:"];
    const unmountedDrive =
      process.platform === "win32"
        ? (candidateDrives.find((d) => !existsSync(`${d}\\`)) ?? "Z:")
        : "D:";
    const missingTargetDir = `${unmountedDrive}\\MAS-Backups\\mas_radar_dev`;

    let caughtError: NodeJS.ErrnoException | null = null;
    try {
      copyToTargetVerified(dumpPath, missingTargetDir, {
        sourceDir,
        classify: () => ({
          ...mockUsbClassification(missingTargetDir),
          offDeviceSatisfied: false,
          kind: "LOCAL_STANDIN",
          driveType: null,
        }),
      });
    } catch (err) {
      caughtError = err as NodeJS.ErrnoException;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.code).toBe("ENOENT");
    expect(caughtError!.message).toContain("ENOENT");
    expect(caughtError!.message).toContain(missingTargetDir);

    // Real I-003 telemetry integration: daily-runs.jsonl ENOENT must surface verbatim in evaluateOffDeviceRunLog
    const runStatus = evaluateOffDeviceRunLog(
      JSON.stringify({
        ok: false,
        exitCode: 3,
        stage: "offdevice",
        source_db: "mas_radar_dev",
        offDeviceOk: false,
        offDeviceNote: "kopya başarısız: ENOENT: no such file or directory, mkdir 'D:\\MAS-Backups\\mas_radar_dev'",
      }),
    );
    expect(runStatus.alert).toBe(true);
    expect(runStatus.value).toBe("TEK KOPYA (exit 3)");
    expect(runStatus.note).toContain("ENOENT");
    expect(runStatus.note).toContain("D:\\MAS-Backups\\mas_radar_dev");
  });

  it("normalizes cross-platform & UNC paths, rejecting source===target and overlapping subdirectories while accepting distinct UNC shares", () => {
    // 1. Local identical & slash/case/trailing-slash variations
    const localDir = createTempDir("mas-agent03-local-same-");
    const localSame = classifyOffDeviceTarget(localDir, localDir);
    expect(localSame.sameVolumeAsSource).toBe(true);
    expect(localSame.offDeviceSatisfied).toBe(false);
    expect(localSame.kind).toBe("LOCAL_STANDIN");
    expect(localSame.evidence).toContain("AYNI");

    expect(detectBackupPathOverlap("C:\\MAS\\Backups\\", "c:/mas/backups")).toBe("identical");
    expect(detectBackupPathOverlap("C:\\MAS\\Backups\\offdevice", "C:\\MAS\\Backups")).toBe("target_inside_source");
    expect(detectBackupPathOverlap("C:\\MAS\\Backups", "C:\\MAS\\Backups\\daily")).toBe("source_inside_target");
    expect(detectBackupPathOverlap("C:\\MAS\\Backups-Offdevice", "C:\\MAS\\Backups")).toBeNull();

    const winCaseSame = classifyOffDeviceTarget("C:\\MAS\\Backups\\", "c:/mas/backups");
    expect(winCaseSame.sameVolumeAsSource).toBe(true);
    expect(winCaseSame.offDeviceSatisfied).toBe(false);

    // 2. UNC identical & subdirectory overlap MUST fail closed (offDeviceSatisfied: false, sameVolumeAsSource: true)
    const uncPath = "\\\\nas-backup\\mas_radar_dev\\daily";
    const uncSame = classifyOffDeviceTarget(uncPath, uncPath);
    expect(uncSame.sameVolumeAsSource).toBe(true);
    expect(uncSame.offDeviceSatisfied).toBe(false);
    expect(uncSame.kind).toBe("LOCAL_STANDIN");

    const uncSlashCaseSame = classifyOffDeviceTarget(
      "//NAS-BACKUP/mas_radar_dev/daily/",
      "\\\\nas-backup\\mas_radar_dev\\daily",
    );
    expect(uncSlashCaseSame.sameVolumeAsSource).toBe(true);
    expect(uncSlashCaseSame.offDeviceSatisfied).toBe(false);

    const uncSubdir = classifyOffDeviceTarget(
      "\\\\nas-backup\\mas_radar_dev\\daily\\nested",
      "\\\\nas-backup\\mas_radar_dev\\daily",
    );
    expect(uncSubdir.sameVolumeAsSource).toBe(true);
    expect(uncSubdir.offDeviceSatisfied).toBe(false);

    const uncParent = classifyOffDeviceTarget(
      "\\\\nas-backup\\mas_radar_dev",
      "\\\\nas-backup\\mas_radar_dev\\daily",
    );
    expect(uncParent.sameVolumeAsSource).toBe(true);
    expect(uncParent.offDeviceSatisfied).toBe(false);

    // Same UNC share root (`\\nas-backup\mas_radar_dev`), sibling subdirectories -> still same volume!
    const uncSameShareSibling = classifyOffDeviceTarget(
      "\\\\nas-backup\\mas_radar_dev\\secondary",
      "\\\\nas-backup\\mas_radar_dev\\primary",
    );
    expect(uncSameShareSibling.sameVolumeAsSource).toBe(true);
    expect(uncSameShareSibling.offDeviceSatisfied).toBe(false);

    // 3. Distinct UNC share (from local source OR from another UNC server/share) is accepted
    const uncFromLocal = classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev\\daily", localDir);
    expect(uncFromLocal.sameVolumeAsSource).toBe(false);
    expect(uncFromLocal.offDeviceSatisfied).toBe(true);
    expect(uncFromLocal.kind).toBe("UNC_NETWORK_SHARE");

    const uncDistinctShare = classifyOffDeviceTarget(
      "\\\\nas-dr-vault\\mas_offdevice\\daily",
      "\\\\nas-primary\\mas_radar_dev\\daily",
    );
    expect(uncDistinctShare.sameVolumeAsSource).toBe(false);
    expect(uncDistinctShare.offDeviceSatisfied).toBe(true);
    expect(uncDistinctShare.kind).toBe("UNC_NETWORK_SHARE");

    // normalizeBackupPath idempotency check
    expect(normalizeBackupPath("//NAS-BACKUP/mas_radar_dev/daily/").canonical).toBe(
      "//nas-backup/mas_radar_dev/daily",
    );
  });

  it("rejects source === target in offdevice-copy preflight before touching any files", () => {
    const sharedDir = createTempDir("mas-agent03-preflight-same-");
    const dumpPath = path.join(sharedDir, "daily-2026-11-18T01-00-00-000Z.dump");
    writeFileSync(dumpPath, "ORIGINAL-SOURCE-BYTES", "utf8");
    const originalSha = sha256OfFile(dumpPath);

    expect(() => assertDistinctOffDeviceTarget(sharedDir, sharedDir)).toThrow(/çakışıyor/);
    expect(() =>
      copyToTargetVerified(dumpPath, sharedDir, {
        sourceDir: sharedDir,
        classify: () => mockUsbClassification(sharedDir),
      }),
    ).toThrow(/aynı olamaz/);

    // Subprocess CLI verification: offdevice-copy.ts exits non-zero (1) and leaves source dump untouched
    let exitCode = 0;
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/ops/offdevice-copy.ts", "--dump", dumpPath],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MAS_BACKUP_DIR: sharedDir,
            MAS_OFFDEVICE_BACKUP_DIR: sharedDir,
          },
          encoding: "utf8",
          stdio: "pipe",
          timeout: 20_000,
        },
      );
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
    }

    expect(exitCode).toBe(1);
    expect(existsSync(dumpPath)).toBe(true);
    expect(sha256OfFile(dumpPath)).toBe(originalSha);
    expect(existsSync(`${dumpPath}.offdevice.json`)).toBe(false);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("verifies copyToTargetVerified + writeOffDeviceRecord in isolated temp dirs: SHA-256 mismatch or unverified TOC blocks .offdevice.json, valid copy creates verifiable receipt", () => {
    const rootTmp = createTempDir("mas-agent03-copy-verify-");
    const sourceDir = path.join(rootTmp, "source");
    const destDir = path.join(rootTmp, "dest");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });

    const dumpName = "daily-2026-11-18T02-00-00-000Z.dump";
    const sourceDump = path.join(sourceDir, dumpName);
    const payload = Buffer.from("PGDMP-VALID-BINARY-CONTENT-FOR-AGENT03-VERIFY-2026", "utf8");
    writeFileSync(sourceDump, payload);
    writeSha256Sidecar(sourceDump);

    // (a) Simulated corruption during transfer -> copyToTargetVerified throws, deletes corrupt dest file, NO .offdevice.json
    expect(() =>
      copyToTargetVerified(sourceDump, destDir, {
        sourceDir,
        classify: () => mockUsbClassification(destDir),
        copyFileImpl: (_src, tempDest) => {
          writeFileSync(tempDest, Buffer.from("PGDMP-CORRUPTED-BITFLIP-PAYLOAD!!", "utf8"));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);

    const expectedDestDump = path.join(destDir, dumpName);
    expect(existsSync(expectedDestDump)).toBe(false);
    expect(existsSync(`${expectedDestDump}.offdevice.json`)).toBe(false);

    // (b) Valid byte copy, then simulated SHA-256 mismatch or destRestoreListable=false before writeOffDeviceRecord -> blocked!
    const unverifiedListCopy = copyToTargetVerified(sourceDump, destDir, {
      sourceDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 0 }),
    });
    expect(unverifiedListCopy.sha256Match).toBe(true);
    expect(unverifiedListCopy.destRestoreListable).toBe(false);

    expect(() => writeOffDeviceRecord(unverifiedListCopy)).toThrow(/\.offdevice\.json makbuzu YAZILMADI/);
    expect(existsSync(`${expectedDestDump}.offdevice.json`)).toBe(false);
    expect(existsSync(expectedDestDump)).toBe(false);

    // Also verify post-copy disk tampering before writeOffDeviceRecord is caught & cleaned up
    const validForTamperTest = copyToTargetVerified(sourceDump, destDir, {
      sourceDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    const staleTmpArtifact = `${validForTamperTest.destPath}.tmp-99999-12345`;
    writeFileSync(staleTmpArtifact, "PARTIAL", "utf8");
    writeFileSync(validForTamperTest.destPath, "TAMPERED-AFTER-COPY", "utf8");

    expect(() => writeOffDeviceRecord(validForTamperTest)).toThrow(/SHA-256\/boyutu kaynakla eşleşmiyor/);
    expect(existsSync(`${expectedDestDump}.offdevice.json`)).toBe(false);
    expect(existsSync(validForTamperTest.destPath)).toBe(false);
    expect(existsSync(staleTmpArtifact)).toBe(false);

    // Source dump must remain completely intact after cleanupFailedOffDeviceCopy
    cleanupFailedOffDeviceCopy(destDir, expectedDestDump, sourceDump);
    expect(existsSync(sourceDump)).toBe(true);

    // (c) Valid copy + list verifier creates verifiable .offdevice.json receipt
    const verifiedCopy = copyToTargetVerified(sourceDump, destDir, {
      sourceDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    expect(verifiedCopy.sha256Match).toBe(true);
    expect(verifiedCopy.bytesMatch).toBe(true);
    expect(verifiedCopy.destRestoreListable).toBe(true);
    expect(verifiedCopy.destTocEntryCount).toBe(132);
    expect(verifiedCopy.sidecarsCopied).toContain(`${dumpName}.sha256`);

    const receiptPath = writeOffDeviceRecord(verifiedCopy);
    expect(existsSync(receiptPath)).toBe(true);

    const parsedReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as OffDeviceCopyRecord;
    expect(parsedReceipt.receiptKind).toBe(OFFDEVICE_RECORD_KIND);
    expect(parsedReceipt.sha256VerifiedAtDestination).toBe(true);
    expect(parsedReceipt.bytesVerifiedAtDestination).toBe(true);
    expect(parsedReceipt.destRestoreListable).toBe(true);
    expect(parsedReceipt.destTocEntryCount).toBe(132);
    expect(parsedReceipt.destSha256).toBe(sha256OfFile(verifiedCopy.destPath));
    expect(parsedReceipt.sourceSha256).toBe(sha256OfFile(sourceDump));
    expect(offDeviceCleanupBlockers(parsedReceipt)).toEqual([]);
  });

  it("protects the sole verified backup in planPrune & executePrune when newer dumps are unverified or when all dumps exceed age thresholds", () => {
    const now = new Date("2026-11-18T12:00:00.000Z");

    // Case 1: Newer dump is unverified (no receipt/sha256 sidecars) while sole verified dump is 413 days old
    const dir = createTempDir("mas-agent03-prune-guard-");
    const oldVerifiedPath = path.join(dir, "daily-2025-10-01T02-00-00-000Z.dump");
    const newerUnverifiedPath = path.join(dir, "daily-2026-11-15T02-00-00-000Z.dump");
    const olderRedundantUnverifiedPath = path.join(dir, "daily-2025-08-01T02-00-00-000Z.dump");

    writeFileSync(oldVerifiedPath, "VERIFIED-OLD-BACKUP-PAYLOAD", "utf8");
    writeSha256Sidecar(oldVerifiedPath);
    writeFileSync(newerUnverifiedPath, "UNVERIFIED-NEWER-DUMP", "utf8");
    writeFileSync(olderRedundantUnverifiedPath, "UNVERIFIED-OLDEST-DUMP", "utf8");

    const entries = listDumps(dir);
    const verifiedEntry = entries.find((e) => e.fullPath === oldVerifiedPath)!;
    const newerEntry = entries.find((e) => e.fullPath === newerUnverifiedPath)!;
    expect(isVerifiedDumpEntry(verifiedEntry)).toBe(true);
    expect(isVerifiedDumpEntry(newerEntry)).toBe(false);

    const tightPolicy: RetentionPolicy = { daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 };
    const plan1 = planPrune(entries, tightPolicy, now);

    const verifiedDecision = plan1.decisions.find((d) => d.entry.fullPath === oldVerifiedPath)!;
    const redundantDecision = plan1.decisions.find((d) => d.entry.fullPath === olderRedundantUnverifiedPath)!;
    expect(verifiedDecision.keep).toBe(true);
    expect(verifiedDecision.reason).toBe("sole_verified_backup_protected");
    expect(redundantDecision.keep).toBe(false);
    expect(plan1.prunedCount).toBe(1);
    expect(plan1.bytesToFree).toBe(redundantDecision.entry.bytes);

    const exec1 = executePrune(plan1);
    expect(exec1.deletedDumps).toEqual([olderRedundantUnverifiedPath]);
    expect(existsSync(oldVerifiedPath)).toBe(true);
    expect(existsSync(`${oldVerifiedPath}.sha256`)).toBe(true);

    // Case 2: All dumps exceed every age/bucket threshold (0 slots), two old verified dumps exist -> newest verified dump is protected
    const olderVerifiedDump: DumpEntry = {
      name: "daily-2025-05-01T02-00-00-000Z.dump",
      fullPath: "/backups/daily-2025-05-01T02-00-00-000Z.dump",
      bytes: 2_000_000,
      timestamp: new Date("2025-05-01T02:00:00.000Z"),
      timestampSource: "filename",
      label: "daily",
      retentionClass: "rolling",
      immutableReason: null,
      sidecars: ["/backups/daily-2025-05-01T02-00-00-000Z.dump.receipt.json"],
    };
    const newerOldVerifiedDump: DumpEntry = {
      name: "daily-2025-09-01T02-00-00-000Z.dump",
      fullPath: "/backups/daily-2025-09-01T02-00-00-000Z.dump",
      bytes: 2_500_000,
      timestamp: new Date("2025-09-01T02:00:00.000Z"),
      timestampSource: "filename",
      label: "daily",
      retentionClass: "rolling",
      immutableReason: null,
      sidecars: ["/backups/daily-2025-09-01T02-00-00-000Z.dump.sha256"],
    };

    const zeroBucketPolicy: RetentionPolicy = { daily: 0, weekly: 0, monthly: 0, minAgeHours: 24 };
    const plan2 = planPrune([olderVerifiedDump, newerOldVerifiedDump], zeroBucketPolicy, now);

    const keptVerified = plan2.decisions.find((d) => d.entry.fullPath === newerOldVerifiedDump.fullPath)!;
    const prunedOlderVerified = plan2.decisions.find((d) => d.entry.fullPath === olderVerifiedDump.fullPath)!;
    expect(keptVerified.keep).toBe(true);
    expect(keptVerified.reason).toBe("sole_verified_backup_protected");
    expect(prunedOlderVerified.keep).toBe(false);
    expect(plan2.keptCount).toBe(1);
    expect(plan2.prunedCount).toBe(1);
    expect(plan2.bytesToFree).toBe(2_000_000);
  });

  it("enforces fail-closed evaluateOffDeviceRunLog behavior on exit 3, corrupt JSONL, missing .offdevice.json, and unverified SHA-256", () => {
    // 1. exit 3 (single copy / ENOENT)
    const exit3 = evaluateOffDeviceRunLog(
      JSON.stringify({
        ok: false,
        exitCode: 3,
        stage: "offdevice",
        offDeviceOk: false,
        offDeviceNote: "ENOENT: no such file or directory, mkdir 'D:\\MAS-Backups\\mas_radar_dev'",
      }),
      { exists: false },
    );
    expect(exit3.alert).toBe(true);
    expect(exit3.value).toBe("TEK KOPYA (exit 3)");
    expect(exit3.note).toContain("ENOENT");

    // 2. Hard failure (exit 1)
    const exit1 = evaluateOffDeviceRunLog(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        stage: "identity",
        error: "connect ECONNREFUSED 127.0.0.1:5432",
      }),
    );
    expect(exit1.alert).toBe(true);
    expect(exit1.value).toContain("SON KOŞU BAŞARISIZ");
    expect(exit1.note).toContain("ECONNREFUSED");

    // 3. Corrupt JSONL lines (malformed JSON, null, JSON array)
    for (const badJsonl of ["{truncated-json", "null", "[1,2,3]"]) {
      const res = evaluateOffDeviceRunLog(badJsonl);
      expect(res.alert).toBe(true);
      expect(res.value).toBe("BOZUK KOŞU KAYDI");
    }

    // 4. Missing .offdevice.json receipt even if JSONL claims ok:true
    const okLogLine = JSON.stringify({
      ok: true,
      exitCode: 0,
      stage: null,
      offDeviceOk: true,
      offDeviceNote: "USB_PHYSICAL_VOLUME — sha256 hedefte eşleşti",
    });
    const missingReceipt = evaluateOffDeviceRunLog(okLogLine, { exists: false });
    expect(missingReceipt.alert).toBe(true);
    expect(missingReceipt.value).toBe("HARİCİ KOPYA EKSİK");

    const missingReceiptNoLog = evaluateOffDeviceRunLog(null, { exists: false });
    expect(missingReceiptNoLog.alert).toBe(true);
    expect(missingReceiptNoLog.value).toBe("HARİCİ KOPYA EKSİK");

    // 5. Unverified SHA-256 or unsatisfied physical off-device target in receipt
    const unverifiedSha = evaluateOffDeviceRunLog(okLogLine, {
      exists: true,
      offDeviceSatisfied: true,
      sha256VerifiedAtDestination: false,
    });
    expect(unverifiedSha.alert).toBe(true);
    expect(unverifiedSha.value).toBe("HARİCİ KOPYA DOĞRULANMADI");
    expect(unverifiedSha.note).toContain("sha256Verified=false");

    const unsatisfiedTarget = evaluateOffDeviceRunLog(okLogLine, {
      exists: true,
      offDeviceSatisfied: false,
      sha256VerifiedAtDestination: true,
    });
    expect(unsatisfiedTarget.alert).toBe(true);
    expect(unsatisfiedTarget.value).toBe("HARİCİ KOPYA DOĞRULANMADI");
    expect(unsatisfiedTarget.note).toContain("offDeviceSatisfied=false");

    // 6. Positive control: only verified run + verified off-device receipt clears alert
    const verified = evaluateOffDeviceRunLog(okLogLine, {
      exists: true,
      offDeviceSatisfied: true,
      sha256VerifiedAtDestination: true,
    });
    expect(verified.alert).toBe(false);
    expect(verified.value).toBe("DOĞRULANDI");
  });
});
