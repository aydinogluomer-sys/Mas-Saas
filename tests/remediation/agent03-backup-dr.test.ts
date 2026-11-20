import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateOffDeviceRunLog } from "@/lib/ops/telemetry-alerts";
import {
  DEFAULT_RETENTION,
  OFFDEVICE_RECORD_KIND,
  archiveDocumentVault,
  classifyOffDeviceTarget,
  copyToTargetVerified,
  detectBackupPathOverlap,
  executePrune,
  isVerifiedDumpEntry,
  listDumps,
  normalizeBackupPath,
  offDeviceCleanupBlockers,
  planPrune,
  pruneUnverifiedQuarantinedDumps,
  sha256OfFile,
  writeSha256Sidecar,
  writeStage07Receipt,
  type DumpEntry,
  type OffDeviceClassification,
  type OffDeviceCopyRecord,
  type RetentionPolicy,
  type Stage07Receipt,
} from "../../scripts/ops/backup-lib";
import {
  LATEST_OFFDEVICE_POINTER_FILENAME,
  LATEST_OFFDEVICE_POINTER_KIND,
  assertDistinctOffDeviceTarget,
  cleanupFailedOffDeviceCopy,
  writeLatestVerifiedOffDevicePointer,
  writeOffDeviceRecord,
  type LatestVerifiedOffDevicePointer,
} from "../../scripts/ops/offdevice-copy";
import { verifyOffDeviceBackup } from "../../scripts/ops/verify-offdevice-backup";
import { writeDrillReceiptAtomic } from "../../scripts/ops/verify-restore-drill-fast";
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

function mockLocalStandinClassification(targetDir: string): OffDeviceClassification {
  return {
    targetDir,
    kind: "LOCAL_STANDIN",
    offDeviceSatisfied: false,
    evidence: "Hedef kaynakla aynı yerel sabit disk üzerinde (LOCAL_STANDIN)",
    sameVolumeAsSource: true,
    driveType: 3,
    targetDisk: null,
    sourceDisk: null,
    samePhysicalDisk: true,
    declaredKind: null,
    operatorAttestation: null,
  };
}

function makeStage07Receipt(
  dumpPath: string,
  payloadBytes: number,
  sha256: string,
  gitSha = "65f2925",
): Stage07Receipt {
  return {
    receiptKind: "mas-stage07-backup-receipt-v1",
    timestamp: "2026-11-20T02:00:00.000Z",
    source_db: "mas_radar_dev",
    system_identifier: "7000000000000000001",
    git_sha: gitSha,
    schema_ledger: "125/0125",
    file_size: payloadBytes,
    sha256,
    pg_version: "PostgreSQL 16.4",
    pg_dump_version: "pg_dump (PostgreSQL) 16.4",
    git_branch: "remediation/v2-hardening",
    git_tree_clean: true,
    dump_path: dumpPath,
    strict_receipt_path: null,
    strict_receipt_sha256: null,
    data_class: "REAL_READ_ONLY",
  };
}

function assertNoTempOrPrevArtifacts(dir: string): void {
  const leftovers = readdirSync(dir).filter(
    (name) => name.includes(".tmp-") || name.includes(".prev-") || name.includes(".aborted-"),
  );
  expect(leftovers).toEqual([]);
}

interface SeededPriorFixture {
  rootTmp: string;
  sourceV1Dir: string;
  sourceV2Dir: string;
  destDir: string;
  dumpName: string;
  v1Dump: string;
  v2Dump: string;
  v2Bytes: Buffer;
  destDump: string;
  v1Sha: string;
  v2Sha: string;
  v1Stage07Sha: string;
  v1ShaSidecarSha: string;
  v1TarSha: string | null;
  v1ManifestSha: string | null;
  assertV1Intact: () => void;
}

function setupSeededPriorAndCandidate(opts: {
  includeVaultInV1?: boolean;
  includeVaultInV2?: boolean;
} = {}): SeededPriorFixture {
  const includeVaultInV1 = opts.includeVaultInV1 ?? true;
  const includeVaultInV2 = opts.includeVaultInV2 ?? true;

  const rootTmp = createTempDir("mas-agent03-f10-case-");
  const sourceV1Dir = path.join(rootTmp, "source-v1");
  const sourceV2Dir = path.join(rootTmp, "source-v2");
  const vaultV1Dir = path.join(rootTmp, "vault-v1");
  const vaultV2Dir = path.join(rootTmp, "vault-v2");
  const destDir = path.join(rootTmp, "dest");
  for (const d of [sourceV1Dir, sourceV2Dir, vaultV1Dir, vaultV2Dir, destDir]) {
    mkdirSync(d, { recursive: true });
  }

  const dumpName = "daily-2026-11-20T02-00-00-000Z.dump";
  const stem = dumpName.replace(/\.dump$/, "");

  const v1Dump = path.join(sourceV1Dir, dumpName);
  const v1Bytes = Buffer.from("PGDMP-VERIFIED-PRIOR-V1-ARCHIVE-BYTES-INTACT", "utf8");
  writeFileSync(v1Dump, v1Bytes);
  const v1Sha = sha256OfFile(v1Dump);
  writeStage07Receipt(`${v1Dump}.stage07.json`, makeStage07Receipt(v1Dump, v1Bytes.length, v1Sha, "1111111"));
  writeSha256Sidecar(v1Dump, v1Sha);

  let v1TarSha: string | null = null;
  let v1ManifestSha: string | null = null;
  if (includeVaultInV1) {
    writeFileSync(path.join(vaultV1Dir, "doc-v1.txt"), "DOC-VAULT-V1", "utf8");
    const v1Vault = archiveDocumentVault(vaultV1Dir, v1Dump);
    v1TarSha = v1Vault.archiveSha256;
    v1ManifestSha = v1Vault.manifestSha256;
  }

  copyToTargetVerified(v1Dump, destDir, {
    sourceDir: sourceV1Dir,
    classify: () => mockUsbClassification(destDir),
    verifyListable: () => ({ tocEntryCount: 132 }),
  });

  const destDump = path.join(destDir, dumpName);
  const v1Stage07Sha = sha256OfFile(`${destDump}.stage07.json`);
  const v1ShaSidecarSha = sha256OfFile(`${destDump}.sha256`);

  const v2Dump = path.join(sourceV2Dir, dumpName);
  const v2Bytes = Buffer.from("PGDMP-CANDIDATE-V2-ARCHIVE-PAYLOAD-UPDATED-NEW", "utf8");
  writeFileSync(v2Dump, v2Bytes);
  const v2Sha = sha256OfFile(v2Dump);
  writeStage07Receipt(`${v2Dump}.stage07.json`, makeStage07Receipt(v2Dump, v2Bytes.length, v2Sha, "2222222"));
  writeSha256Sidecar(v2Dump, v2Sha);
  if (includeVaultInV2) {
    writeFileSync(path.join(vaultV2Dir, "doc-v2.txt"), "DOC-VAULT-V2-UPDATED", "utf8");
    archiveDocumentVault(vaultV2Dir, v2Dump);
  }

  const assertV1Intact = (): void => {
    expect(existsSync(destDump)).toBe(true);
    expect(sha256OfFile(destDump)).toBe(v1Sha);
    expect(sha256OfFile(`${destDump}.stage07.json`)).toBe(v1Stage07Sha);
    expect(sha256OfFile(`${destDump}.sha256`)).toBe(v1ShaSidecarSha);
    const tarDest = path.join(destDir, `${stem}-documents.tar.gz`);
    const manifestDest = path.join(destDir, `${stem}-documents.manifest.json`);
    if (includeVaultInV1) {
      expect(sha256OfFile(tarDest)).toBe(v1TarSha);
      expect(sha256OfFile(manifestDest)).toBe(v1ManifestSha);
    } else {
      expect(existsSync(tarDest)).toBe(false);
      expect(existsSync(manifestDest)).toBe(false);
    }
    assertNoTempOrPrevArtifacts(destDir);
  };

  return {
    rootTmp,
    sourceV1Dir,
    sourceV2Dir,
    destDir,
    dumpName,
    v1Dump,
    v2Dump,
    v2Bytes,
    destDump,
    v1Sha,
    v2Sha,
    v1Stage07Sha,
    v1ShaSidecarSha,
    v1TarSha,
    v1ManifestSha,
    assertV1Intact,
  };
}

describe("AGENT 03 — V2 Backup Overwrite Crash-Window Hardening (F-10) & Off-Device Honesty (F-11)", () => {
  it("Case 01: unmounted physical off-device target (D:\\MAS-Backups\\mas_radar_dev) surfaces ENOENT and creates zero receipts", () => {
    const sourceDir = createTempDir("mas-agent03-c01-");
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
        classify: () => mockLocalStandinClassification(missingTargetDir),
      });
    } catch (err) {
      caughtError = err as NodeJS.ErrnoException;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.code).toBe("ENOENT");
    expect(caughtError!.message).toContain(missingTargetDir);
    expect(existsSync(`${dumpPath}.offdevice.json`)).toBe(false);
  });

  it("Case 02: rejects same-directory overlap (source === target) across slash/case/trailing-slash variations and CLI preflight", () => {
    expect(detectBackupPathOverlap("C:\\MAS\\Backups\\", "c:/mas/backups")).toBe("identical");
    const winCaseSame = classifyOffDeviceTarget("C:\\MAS\\Backups\\", "c:/mas/backups");
    expect(winCaseSame.sameVolumeAsSource).toBe(true);
    expect(winCaseSame.offDeviceSatisfied).toBe(false);

    const sharedDir = createTempDir("mas-agent03-c02-");
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
    expect(sha256OfFile(dumpPath)).toBe(originalSha);
    expect(existsSync(`${dumpPath}.offdevice.json`)).toBe(false);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("Case 03: rejects nested-directory overlaps (target_inside_source and source_inside_target) without touching disk", () => {
    expect(detectBackupPathOverlap("C:\\MAS\\Backups\\offdevice", "C:\\MAS\\Backups")).toBe("target_inside_source");
    expect(detectBackupPathOverlap("C:\\MAS\\Backups", "C:\\MAS\\Backups\\daily")).toBe("source_inside_target");
    expect(detectBackupPathOverlap("C:\\MAS\\Backups-Offdevice", "C:\\MAS\\Backups")).toBeNull();

    const nestedRoot = createTempDir("mas-agent03-c03-");
    const parentBackupDir = path.join(nestedRoot, "backups");
    const childOffDeviceDir = path.join(parentBackupDir, "nested-offdevice");
    mkdirSync(parentBackupDir, { recursive: true });
    const nestedDump = path.join(parentBackupDir, "daily-2026-11-20T00-00-00-000Z.dump");
    writeFileSync(nestedDump, "PGDMP-NESTED-CHECK", "utf8");

    expect(() => assertDistinctOffDeviceTarget(childOffDeviceDir, parentBackupDir)).toThrow(/çakışıyor/);
    expect(() => assertDistinctOffDeviceTarget(parentBackupDir, childOffDeviceDir)).toThrow(/çakışıyor/);
    expect(() =>
      copyToTargetVerified(nestedDump, childOffDeviceDir, {
        sourceDir: parentBackupDir,
        classify: () => mockUsbClassification(childOffDeviceDir),
      }),
    ).toThrow(/iç içe çakışıyor/);
    expect(() =>
      copyToTargetVerified(nestedDump, nestedRoot, {
        sourceDir: parentBackupDir,
        classify: () => mockUsbClassification(nestedRoot),
      }),
    ).toThrow(/iç içe çakışıyor/);
    expect(existsSync(childOffDeviceDir)).toBe(false);
  });

  it("Case 04: classifies UNC topology accurately (rejects identical, nested, and same-share siblings; accepts distinct UNC share)", () => {
    const uncPath = "\\\\nas-backup\\mas_radar_dev\\daily";
    expect(classifyOffDeviceTarget(uncPath, uncPath).offDeviceSatisfied).toBe(false);
    expect(
      classifyOffDeviceTarget("//NAS-BACKUP/mas_radar_dev/daily/", "\\\\nas-backup\\mas_radar_dev\\daily")
        .offDeviceSatisfied,
    ).toBe(false);
    expect(
      classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev\\daily\\nested", "\\\\nas-backup\\mas_radar_dev\\daily")
        .offDeviceSatisfied,
    ).toBe(false);
    expect(
      classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev", "\\\\nas-backup\\mas_radar_dev\\daily")
        .offDeviceSatisfied,
    ).toBe(false);
    expect(
      classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev\\secondary", "\\\\nas-backup\\mas_radar_dev\\primary")
        .offDeviceSatisfied,
    ).toBe(false);

    const uncDistinctShare = classifyOffDeviceTarget(
      "\\\\nas-dr-vault\\mas_offdevice\\daily",
      "\\\\nas-primary\\mas_radar_dev\\daily",
    );
    expect(uncDistinctShare.sameVolumeAsSource).toBe(false);
    expect(uncDistinctShare.offDeviceSatisfied).toBe(true);
    expect(uncDistinctShare.kind).toBe("UNC_NETWORK_SHARE");
    expect(normalizeBackupPath("//NAS-BACKUP/mas_radar_dev/daily/").canonical).toBe(
      "//nas-backup/mas_radar_dev/daily",
    );
  });

  it("Case 05: enforces LOCAL_STANDIN offDeviceSatisfied=false and blocks cleanup gate on same-disk folders", () => {
    const srcDir = createTempDir("mas-agent03-c05-src-");
    const standinDir = createTempDir("mas-agent03-c05-dst-");
    const dumpPath = path.join(srcDir, "daily-2026-11-20T00-00-00-000Z.dump");
    writeFileSync(dumpPath, "PGDMP-STANDIN-CHECK", "utf8");

    const standinCopy = copyToTargetVerified(dumpPath, standinDir, {
      sourceDir: srcDir,
      classify: () => mockLocalStandinClassification(standinDir),
      verifyListable: () => ({ tocEntryCount: 64 }),
    });
    expect(standinCopy.classification.kind).toBe("LOCAL_STANDIN");
    expect(standinCopy.classification.offDeviceSatisfied).toBe(false);

    const receiptPath = writeOffDeviceRecord(standinCopy);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as OffDeviceCopyRecord;
    expect(receipt.receiptKind).toBe(OFFDEVICE_RECORD_KIND);
    expect(receipt.offDeviceSatisfied).toBe(false);
    expect(offDeviceCleanupBlockers(receipt).length).toBeGreaterThanOrEqual(2);
  });

  it("Case 06: F-10 fault — corrupt main dump bytes (same-size bitflip) preserves prior verified v1 dump + sidecars", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (_src, tmpDest) => {
          const flipped = Buffer.from(fx.v2Bytes);
          flipped[0] = flipped[0]! ^ 0xff;
          writeFileSync(tmpDest, flipped);
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 07: F-10 fault — truncated main dump copy (partial USB disconnect) preserves prior verified v1 dump + sidecars", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (_src, tmpDest) => {
          writeFileSync(tmpDest, fx.v2Bytes.subarray(0, 10));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 08: F-10 fault — copyFileImpl throwing ENOSPC mid-write cleans partial .tmp-* and preserves prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (_src, tmpDest) => {
          writeFileSync(tmpDest, "PARTIAL-BEFORE-ENOSPC", "utf8");
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/ENOSPC/);
    fx.assertV1Intact();
  });

  it("Case 09: F-10 fault — 0-byte empty source dump is rejected before touching prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    const emptyDir = path.join(fx.rootTmp, "empty-src");
    mkdirSync(emptyDir, { recursive: true });
    const emptyDump = path.join(emptyDir, fx.dumpName);
    writeFileSync(emptyDump, Buffer.alloc(0));

    expect(() =>
      copyToTargetVerified(emptyDump, fx.destDir, {
        sourceDir: emptyDir,
        classify: () => mockUsbClassification(fx.destDir),
      }),
    ).toThrow(/0 bayt/);
    fx.assertV1Intact();
  });

  it("Case 10: F-10 fault — verifyListable TOC throw runs on destPath inside rollback guard and restores prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    let verifiedPath = "";
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: (p) => {
          verifiedPath = p;
          throw new Error("pg_restore: error: input file does not appear to be a valid archive");
        },
      }),
    ).toThrow(/valid archive/);
    expect(verifiedPath).toBe(fx.destDump);
    fx.assertV1Intact();
  });

  it("Case 11: F-10 fault — verifyListable returning 0 TOC entries throws before .prev-* commit and restores prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 0 }),
      }),
    ).toThrow(/TOC doğrulamasından geçemedi/);
    fx.assertV1Intact();
  });

  it("Case 12: F-10 fault — corrupt .sha256 companion sidecar write aborts staging and preserves prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (src, tmpDest) => {
          if (src.endsWith(".sha256")) {
            writeFileSync(tmpDest, "00000000  corrupt.dump\n", "utf8");
            return;
          }
          writeFileSync(tmpDest, readFileSync(src));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 13: F-10 fault — corrupt .stage07.json companion sidecar write aborts staging and preserves prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (src, tmpDest) => {
          if (src.endsWith(".stage07.json")) {
            writeFileSync(tmpDest, "{corrupted-stage07", "utf8");
            return;
          }
          writeFileSync(tmpDest, readFileSync(src));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 14: F-10 fault — corrupt -documents.tar.gz companion archive write aborts staging and preserves prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (src, tmpDest) => {
          if (src.endsWith("-documents.tar.gz")) {
            writeFileSync(tmpDest, Buffer.from("CORRUPT-GZIP-BYTES", "utf8"));
            return;
          }
          writeFileSync(tmpDest, readFileSync(src));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 15: F-10 fault — corrupt -documents.manifest.json companion write aborts staging and preserves prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate();
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        copyFileImpl: (src, tmpDest) => {
          if (src.endsWith("-documents.manifest.json")) {
            writeFileSync(tmpDest, "{\"manifestKind\":\"corrupted\"}", "utf8");
            return;
          }
          writeFileSync(tmpDest, readFileSync(src));
        },
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/eşleşmedi/);
    fx.assertV1Intact();
  });

  it("Case 16: F-10 fault — renameImpl EACCES on main dump (dest -> .prev-*) leaves prior verified v1 untouched", () => {
    const fx = setupSeededPriorAndCandidate({ includeVaultInV1: false, includeVaultInV2: true });
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 140 }),
        renameImpl: () => {
          throw Object.assign(new Error("EACCES: permission denied on main dest->prev"), { code: "EACCES" });
        },
      }),
    ).toThrow(/EACCES/);
    fx.assertV1Intact();
  });

  it("Case 17: F-10 fault — renameImpl EIO on main dump (.tmp-* -> dest) rolls back .prev-* to restore prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate({ includeVaultInV1: false, includeVaultInV2: true });
    let calls = 0;
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 140 }),
        renameImpl: (oldP, newP) => {
          calls += 1;
          if (calls === 2) {
            throw Object.assign(new Error("EIO: main temp->dest failed"), { code: "EIO" });
          }
          renameSync(oldP, newP);
        },
      }),
    ).toThrow(/EIO/);
    fx.assertV1Intact();
  });

  it("Case 18: F-10 fault — renameImpl EIO on 1st sidecar (.stage07.json) rolls back promoted main dump to v1", () => {
    const fx = setupSeededPriorAndCandidate({ includeVaultInV1: false, includeVaultInV2: true });
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 140 }),
        renameImpl: (oldP, newP) => {
          if (oldP.includes(".stage07.json.tmp-")) {
            throw Object.assign(new Error("EIO: 1st sidecar promotion failure"), { code: "EIO" });
          }
          renameSync(oldP, newP);
        },
      }),
    ).toThrow(/1st sidecar/);
    fx.assertV1Intact();
  });

  it("Case 19: F-10 fault — renameImpl EIO on 2nd sidecar (.sha256) rolls back main dump + 1st sidecar to prior verified v1", () => {
    const fx = setupSeededPriorAndCandidate({ includeVaultInV1: false, includeVaultInV2: true });
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 140 }),
        renameImpl: (oldP, newP) => {
          if (oldP.includes(".sha256.tmp-")) {
            throw Object.assign(new Error("EIO: 2nd sidecar promotion failure"), { code: "EIO" });
          }
          renameSync(oldP, newP);
        },
      }),
    ).toThrow(/2nd sidecar/);
    fx.assertV1Intact();
  });

  it("Case 20: F-10 fault — renameImpl EXDEV on newly added -documents.tar.gz rolls back all prior files and leaves zero orphan sidecars", () => {
    const fx = setupSeededPriorAndCandidate({ includeVaultInV1: false, includeVaultInV2: true });
    expect(() =>
      copyToTargetVerified(fx.v2Dump, fx.destDir, {
        sourceDir: fx.sourceV2Dir,
        classify: () => mockUsbClassification(fx.destDir),
        verifyListable: () => ({ tocEntryCount: 140 }),
        renameImpl: (oldP, newP) => {
          if (oldP.includes("-documents.tar.gz.tmp-")) {
            throw Object.assign(new Error("EXDEV: cross-device link on vault tar"), { code: "EXDEV" });
          }
          renameSync(oldP, newP);
        },
      }),
    ).toThrow(/EXDEV/);
    fx.assertV1Intact();

    // Positive verification that subsequent healthy v2 run promotes cleanly
    const promoted = copyToTargetVerified(fx.v2Dump, fx.destDir, {
      sourceDir: fx.sourceV2Dir,
      classify: () => mockUsbClassification(fx.destDir),
      verifyListable: () => ({ tocEntryCount: 140 }),
    });
    expect(promoted.destSha256).toBe(fx.v2Sha);
    assertNoTempOrPrevArtifacts(fx.destDir);
  });

  it("Case 21: refuses to overwrite IMMUTABLE backups (by name pattern or .immutable marker) when SHA-256 differs", () => {
    const rootTmp = createTempDir("mas-agent03-c21-");
    const srcA = path.join(rootTmp, "src-a");
    const srcB = path.join(rootTmp, "src-b");
    const destDir = path.join(rootTmp, "dest");
    for (const d of [srcA, srcB, destDir]) mkdirSync(d, { recursive: true });

    const immutableName = "cutover_v2_2026-11-20T00-00-00-000Z.dump";
    const cutoverA = path.join(srcA, immutableName);
    writeFileSync(cutoverA, "PGDMP-CUTOVER-ORIGINAL-IMMUTABLE-BYTES", "utf8");
    const cutoverASha = sha256OfFile(cutoverA);
    copyToTargetVerified(cutoverA, destDir, {
      sourceDir: srcA,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });

    const cutoverDifferent = path.join(srcB, immutableName);
    writeFileSync(cutoverDifferent, "PGDMP-TAMPERED-DIFFERENT-CUTOVER-BYTES", "utf8");
    expect(() =>
      copyToTargetVerified(cutoverDifferent, destDir, {
        sourceDir: srcB,
        classify: () => mockUsbClassification(destDir),
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/GÜVENLİK DURDURMASI: IMMUTABLE yedek farklı içerikle üzerine yazılamaz/);
    expect(sha256OfFile(path.join(destDir, immutableName))).toBe(cutoverASha);

    const markedRollingName = "daily-2026-11-19T00-00-00-000Z.dump";
    const rollingA = path.join(srcA, markedRollingName);
    writeFileSync(rollingA, "PGDMP-PINNED-BY-MARKER-V1", "utf8");
    const rollingASha = sha256OfFile(rollingA);
    copyToTargetVerified(rollingA, destDir, {
      sourceDir: srcA,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    writeFileSync(path.join(destDir, `${markedRollingName}.immutable`), "pinned\n", "utf8");

    const rollingDifferent = path.join(srcB, markedRollingName);
    writeFileSync(rollingDifferent, "PGDMP-DIFFERENT-PAYLOAD-V2", "utf8");
    expect(() =>
      copyToTargetVerified(rollingDifferent, destDir, {
        sourceDir: srcB,
        classify: () => mockUsbClassification(destDir),
        verifyListable: () => ({ tocEntryCount: 132 }),
      }),
    ).toThrow(/IMMUTABLE yedek farklı içerikle üzerine yazılamaz/);
    expect(sha256OfFile(path.join(destDir, markedRollingName))).toBe(rollingASha);
  });

  it("Case 22: allows idempotent re-verification of an IMMUTABLE backup when SHA-256 content is identical", () => {
    const rootTmp = createTempDir("mas-agent03-c22-");
    const srcA = path.join(rootTmp, "src-a");
    const srcB = path.join(rootTmp, "src-b");
    const destDir = path.join(rootTmp, "dest");
    for (const d of [srcA, srcB, destDir]) mkdirSync(d, { recursive: true });

    const immutableName = "mas_radar_dev-20261120-000000.dump";
    const payload = "PGDMP-IMMUTABLE-IDENTICAL-BYTES";
    const dumpA = path.join(srcA, immutableName);
    const dumpB = path.join(srcB, immutableName);
    writeFileSync(dumpA, payload, "utf8");
    writeFileSync(dumpB, payload, "utf8");
    const sha = sha256OfFile(dumpA);
    writeSha256Sidecar(dumpA, sha);
    writeSha256Sidecar(dumpB, sha);

    copyToTargetVerified(dumpA, destDir, {
      sourceDir: srcA,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });

    const idempotentRes = copyToTargetVerified(dumpB, destDir, {
      sourceDir: srcB,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    expect(idempotentRes.destSha256).toBe(sha);
    expect(idempotentRes.destRestoreListable).toBe(true);
    assertNoTempOrPrevArtifacts(destDir);
  });

  it("Case 23: writeStage07Receipt preserves prior valid receipt on mandatory-field failure and on renameImpl EIO failure", () => {
    const destDir = createTempDir("mas-agent03-c23-");
    const stage07Path = path.join(destDir, "sample.dump.stage07.json");
    const validReceiptV1 = makeStage07Receipt("/tmp/sample.dump", 1024, "a".repeat(64), "sha-v1");
    const v1ReceiptHash = writeStage07Receipt(stage07Path, validReceiptV1);

    expect(() => writeStage07Receipt(stage07Path, { ...validReceiptV1, sha256: "" })).toThrow(
      /zorunlu alan boş: sha256/,
    );
    expect(sha256OfFile(stage07Path)).toBe(v1ReceiptHash);

    let renames = 0;
    expect(() =>
      writeStage07Receipt(
        stage07Path,
        { ...validReceiptV1, git_sha: "sha-v2" },
        {
          renameImpl: (oldP, newP) => {
            renames += 1;
            if (renames === 2) {
              throw Object.assign(new Error("EIO: stage07 temp->dest failed"), { code: "EIO" });
            }
            renameSync(oldP, newP);
          },
        },
      ),
    ).toThrow(/EIO/);
    expect(sha256OfFile(stage07Path)).toBe(v1ReceiptHash);
    assertNoTempOrPrevArtifacts(destDir);
  });

  it("Case 24: writeDrillReceiptAtomic preserves prior latest-restore-drill.json when renameImpl fails mid-flight", () => {
    const destDir = createTempDir("mas-agent03-c24-");
    const drillReceiptPath = path.join(destDir, "latest-restore-drill.json");
    writeDrillReceiptAtomic(drillReceiptPath, { receiptKind: "mas-fast-restore-drill-v1", passed: true, seq: 1 });
    const drillV1Sha = sha256OfFile(drillReceiptPath);

    let renames = 0;
    expect(() =>
      writeDrillReceiptAtomic(
        drillReceiptPath,
        { receiptKind: "mas-fast-restore-drill-v1", passed: true, seq: 2 },
        {
          renameImpl: (oldP, newP) => {
            renames += 1;
            if (renames === 2) {
              throw Object.assign(new Error("EIO: drill receipt rename failed"), { code: "EIO" });
            }
            renameSync(oldP, newP);
          },
        },
      ),
    ).toThrow(/EIO/);
    expect(sha256OfFile(drillReceiptPath)).toBe(drillV1Sha);
    assertNoTempOrPrevArtifacts(destDir);
  });

  it("Case 25: canonical pointer manifest (latest-verified-offdevice.json) updates atomically only after verified copy + receipt, rolls back on rename failure, and blocks stand-in downgrade", () => {
    const rootTmp = createTempDir("mas-agent03-c25-");
    const srcDir = path.join(rootTmp, "src");
    const destDir = path.join(rootTmp, "dest");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });

    const dumpName = "daily-2026-11-20T04-00-00-000Z.dump";
    const srcDump = path.join(srcDir, dumpName);
    writeFileSync(srcDump, "PGDMP-POINTER-V1-PAYLOAD", "utf8");
    writeSha256Sidecar(srcDump);

    const unverifiedCopy = copyToTargetVerified(srcDump, destDir, {
      sourceDir: srcDir,
      classify: () => mockUsbClassification(destDir),
    });
    expect(() => writeOffDeviceRecord(unverifiedCopy)).toThrow(/\.offdevice\.json makbuzu YAZILMADI/);
    expect(existsSync(path.join(destDir, LATEST_OFFDEVICE_POINTER_FILENAME))).toBe(false);

    const verifiedV1 = copyToTargetVerified(srcDump, destDir, {
      sourceDir: srcDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    const recPath = writeOffDeviceRecord(verifiedV1);
    const pointerPath = path.join(destDir, LATEST_OFFDEVICE_POINTER_FILENAME);
    expect(existsSync(pointerPath)).toBe(true);

    const parsedPtr = JSON.parse(readFileSync(pointerPath, "utf8")) as LatestVerifiedOffDevicePointer;
    expect(parsedPtr.pointerKind).toBe(LATEST_OFFDEVICE_POINTER_KIND);
    expect(parsedPtr.dumpFileName).toBe(dumpName);
    expect(parsedPtr.destSha256).toBe(verifiedV1.destSha256);
    expect(parsedPtr.offDeviceSatisfied).toBe(true);
    const ptr1Sha = sha256OfFile(pointerPath);

    let ptrRenames = 0;
    expect(() =>
      writeLatestVerifiedOffDevicePointer(verifiedV1, recPath, {
        renameImpl: (oldP, newP) => {
          ptrRenames += 1;
          if (ptrRenames === 2) {
            throw Object.assign(new Error("EIO: pointer rename failed"), { code: "EIO" });
          }
          renameSync(oldP, newP);
        },
      }),
    ).toThrow(/EIO/);
    expect(sha256OfFile(pointerPath)).toBe(ptr1Sha);

    const standinAttempt = writeLatestVerifiedOffDevicePointer(
      { ...verifiedV1, classification: mockLocalStandinClassification(destDir) },
      recPath,
    );
    expect(standinAttempt).toBeNull();
    expect(sha256OfFile(pointerPath)).toBe(ptr1Sha);
  });

  it("Case 26: cleanupFailedOffDeviceCopy removes tampered/unverified copies and .tmp-* artifacts while sparing intact verified dumps", () => {
    const rootTmp = createTempDir("mas-agent03-c26-");
    const srcDir = path.join(rootTmp, "src");
    const destDir = path.join(rootTmp, "dest");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });

    const dumpName = "daily-2026-11-20T05-00-00-000Z.dump";
    const srcDump = path.join(srcDir, dumpName);
    writeFileSync(srcDump, "PGDMP-CLEANUP-GUARD-PAYLOAD", "utf8");

    // Tampered post-copy before .offdevice.json -> removed by writeOffDeviceRecord / cleanupFailedOffDeviceCopy
    const tamperedCopy = copyToTargetVerified(srcDump, destDir, {
      sourceDir: srcDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    writeFileSync(tamperedCopy.destPath, "TAMPERED-ON-DISK", "utf8");
    expect(() => writeOffDeviceRecord(tamperedCopy)).toThrow(/SHA-256\/boyutu kaynakla eşleşmiyor/);
    expect(existsSync(tamperedCopy.destPath)).toBe(false);

    // Intact verified copy + .offdevice.json -> preserved by cleanupFailedOffDeviceCopy while stray .tmp-* is deleted!
    const verifiedCopy = copyToTargetVerified(srcDump, destDir, {
      sourceDir: srcDir,
      classify: () => mockUsbClassification(destDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    const recPath = writeOffDeviceRecord(verifiedCopy);
    const strayTmp = `${verifiedCopy.destPath}.tmp-99999-stray`;
    writeFileSync(strayTmp, "PARTIAL-TMP", "utf8");

    cleanupFailedOffDeviceCopy(destDir, verifiedCopy.destPath, srcDump);
    expect(existsSync(strayTmp)).toBe(false);
    expect(existsSync(verifiedCopy.destPath)).toBe(true);
    expect(existsSync(recPath)).toBe(true);
    expect(existsSync(srcDump)).toBe(true);
  });

  it("Case 27: planPrune & executePrune protect sole verified backup and recheck late .immutable markers before deletion", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const dir = createTempDir("mas-agent03-c27-");

    const oldVerifiedPath = path.join(dir, "daily-2025-10-01T02-00-00-000Z.dump");
    const newerUnverifiedPath = path.join(dir, "daily-2026-11-15T02-00-00-000Z.dump");
    const olderRedundantUnverifiedPath = path.join(dir, "daily-2025-08-01T02-00-00-000Z.dump");

    writeFileSync(oldVerifiedPath, "VERIFIED-OLD-BACKUP-PAYLOAD", "utf8");
    writeSha256Sidecar(oldVerifiedPath);
    writeFileSync(newerUnverifiedPath, "UNVERIFIED-NEWER-DUMP", "utf8");
    writeFileSync(olderRedundantUnverifiedPath, "UNVERIFIED-OLDEST-DUMP", "utf8");

    const entries = listDumps(dir);
    expect(isVerifiedDumpEntry(entries.find((e) => e.fullPath === oldVerifiedPath)!)).toBe(true);
    expect(isVerifiedDumpEntry(entries.find((e) => e.fullPath === newerUnverifiedPath)!)).toBe(false);

    const tightPolicy: RetentionPolicy = { daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 };
    const plan1 = planPrune(entries, tightPolicy, now);
    expect(plan1.decisions.find((d) => d.entry.fullPath === oldVerifiedPath)!.reason).toBe(
      "sole_verified_backup_protected",
    );

    writeFileSync(`${olderRedundantUnverifiedPath}.immutable`, "pinned", "utf8");
    const execPinned = executePrune(plan1);
    expect(execPinned.deletedDumps).toEqual([]);
    expect(execPinned.failures).toHaveLength(1);
    rmSync(`${olderRedundantUnverifiedPath}.immutable`);

    const execClean = executePrune(plan1);
    expect(execClean.deletedDumps).toEqual([olderRedundantUnverifiedPath]);
    expect(existsSync(oldVerifiedPath)).toBe(true);

    // Zero-bucket policy + unreadable timestamp fail-safe check
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
    const invalidDateDump: DumpEntry = {
      name: "legacy-corrupt-mtime.dump",
      fullPath: "/backups/legacy-corrupt-mtime.dump",
      bytes: 512,
      timestamp: new Date("invalid"),
      timestampSource: "mtime",
      label: "legacy",
      retentionClass: "rolling",
      immutableReason: null,
      sidecars: [],
    };
    const plan2 = planPrune(
      [olderVerifiedDump, newerOldVerifiedDump, invalidDateDump],
      { daily: 0, weekly: 0, monthly: 0, minAgeHours: 24 },
      now,
    );
    expect(plan2.decisions.find((d) => d.entry.fullPath === newerOldVerifiedDump.fullPath)!.keep).toBe(true);
    expect(plan2.decisions.find((d) => d.entry.fullPath === invalidDateDump.fullPath)!.keep).toBe(true);
  });

  it("Case 28: pruneUnverifiedQuarantinedDumps removes aged rolling .dump.unverified while sparing young and IMMUTABLE names", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const dir = createTempDir("mas-agent03-c28-");

    const oldRollingUnverified = path.join(dir, "daily-2026-10-01T00-00-00-000Z.dump.unverified");
    const youngRollingUnverified = path.join(dir, "daily-2026-11-20T10-00-00-000Z.dump.unverified");
    const oldImmutableUnverified = path.join(dir, "cutover_2026-01-01T00-00-00-000Z.dump.unverified");
    const oldProdNamedUnverified = path.join(dir, "mas_radar_dev-20260706-181434.dump.unverified");

    for (const p of [oldRollingUnverified, youngRollingUnverified, oldImmutableUnverified, oldProdNamedUnverified]) {
      writeFileSync(p, "QUARANTINED-BYTES", "utf8");
    }
    const oldMtime = new Date("2026-10-01T00:00:00.000Z");
    const youngMtime = new Date("2026-11-20T10:00:00.000Z");
    utimesSync(oldRollingUnverified, oldMtime, oldMtime);
    utimesSync(oldImmutableUnverified, oldMtime, oldMtime);
    utimesSync(oldProdNamedUnverified, oldMtime, oldMtime);
    utimesSync(youngRollingUnverified, youngMtime, youngMtime);

    const qRes = pruneUnverifiedQuarantinedDumps(dir, DEFAULT_RETENTION.minAgeHours, now);
    expect(qRes.deleted).toEqual([oldRollingUnverified]);
    expect(existsSync(oldRollingUnverified)).toBe(false);
    expect(existsSync(youngRollingUnverified)).toBe(true);
    expect(existsSync(oldImmutableUnverified)).toBe(true);
    expect(existsSync(oldProdNamedUnverified)).toBe(true);
  });

  it("Case 29: verifyOffDeviceBackup enforces F-11 honesty (BLOCKED when unmounted, LOCAL_STANDIN, missing receipt, or tampered pointer; PASS only on genuine verified USB)", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const rootTmp = createTempDir("mas-agent03-c29-");
    const localDir = path.join(rootTmp, "local-backups");
    const usbDir = path.join(rootTmp, "usb-target");
    const missingDir = path.join(rootTmp, "unmounted-usb-target");
    mkdirSync(localDir, { recursive: true });
    mkdirSync(usbDir, { recursive: true });

    const localDump = path.join(localDir, "daily-2026-11-20T06-00-00-000Z.dump");
    writeFileSync(localDump, "PGDMP-LOCAL-FALLBACK-VALID", "utf8");
    writeSha256Sidecar(localDump);

    const mockVerifyList = () => ({
      restoreListable: true as const,
      tocEntryCount: 132,
      criticalTablesPresent: {
        paymentInstances: true,
        payments: true,
        auditLogs: true,
        schemaMigrations: true,
      },
    });

    const fallbackReport = verifyOffDeviceBackup({
      localBackupDir: localDir,
      offDeviceBackupDir: missingDir,
      classify: () => mockUsbClassification(missingDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(fallbackReport.ok).toBe(true);
    expect(fallbackReport.mode).toBe("local_fallback");
    expect(fallbackReport.offDeviceGateStatus).toBe("BLOCKED");

    const strictMissing = verifyOffDeviceBackup({
      strictOffDevice: true,
      localBackupDir: localDir,
      offDeviceBackupDir: missingDir,
      classify: () => mockUsbClassification(missingDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(strictMissing.ok).toBe(false);
    expect(strictMissing.offDeviceGateStatus).toBe("BLOCKED");

    const rawCopied = copyToTargetVerified(localDump, usbDir, {
      sourceDir: localDir,
      classify: () => mockUsbClassification(usbDir),
      verifyListable: () => ({ tocEntryCount: 132 }),
    });
    const strictNoReceipt = verifyOffDeviceBackup({
      strictOffDevice: true,
      localBackupDir: localDir,
      offDeviceBackupDir: usbDir,
      classify: () => mockUsbClassification(usbDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(strictNoReceipt.ok).toBe(false);
    expect(strictNoReceipt.offDeviceGateStatus).toBe("BLOCKED");

    writeOffDeviceRecord({ ...rawCopied, classification: mockLocalStandinClassification(usbDir) });
    const strictStandin = verifyOffDeviceBackup({
      strictOffDevice: true,
      localBackupDir: localDir,
      offDeviceBackupDir: usbDir,
      classify: () => mockLocalStandinClassification(usbDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(strictStandin.ok).toBe(false);
    expect(strictStandin.offDeviceGateStatus).toBe("BLOCKED");

    writeOffDeviceRecord(rawCopied);
    const strictPass = verifyOffDeviceBackup({
      strictOffDevice: true,
      localBackupDir: localDir,
      offDeviceBackupDir: usbDir,
      classify: () => mockUsbClassification(usbDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(strictPass.ok).toBe(true);
    expect(strictPass.offDeviceGateStatus).toBe("PASS");
    expect(strictPass.canonicalPointerValid).toBe(true);

    writeFileSync(path.join(usbDir, LATEST_OFFDEVICE_POINTER_FILENAME), "{corrupt-pointer", "utf8");
    const tamperedPointer = verifyOffDeviceBackup({
      strictOffDevice: true,
      localBackupDir: localDir,
      offDeviceBackupDir: usbDir,
      classify: () => mockUsbClassification(usbDir),
      verifyList: mockVerifyList,
      now,
    });
    expect(tamperedPointer.ok).toBe(false);
    expect(tamperedPointer.offDeviceGateStatus).toBe("BLOCKED");
  });

  it("Case 30: evaluateOffDeviceRunLog fails closed on exit 3 ENOENT, exit 1, corrupt JSONL, missing receipt, and unverified SHA-256", () => {
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

    expect(
      evaluateOffDeviceRunLog(
        JSON.stringify({ ok: false, exitCode: 1, stage: "identity", error: "ECONNREFUSED" }),
      ).alert,
    ).toBe(true);

    for (const badJsonl of ["{truncated-json", "null", "[1,2,3]"]) {
      const res = evaluateOffDeviceRunLog(badJsonl);
      expect(res.alert).toBe(true);
      expect(res.value).toBe("BOZUK KOŞU KAYDI");
    }

    const okLogLine = JSON.stringify({
      ok: true,
      exitCode: 0,
      stage: null,
      offDeviceOk: true,
      offDeviceNote: "USB_PHYSICAL_VOLUME — sha256 hedefte eşleşti",
    });
    expect(evaluateOffDeviceRunLog(okLogLine, { exists: false }).alert).toBe(true);
    expect(
      evaluateOffDeviceRunLog(okLogLine, {
        exists: true,
        offDeviceSatisfied: true,
        sha256VerifiedAtDestination: false,
      }).alert,
    ).toBe(true);
    expect(
      evaluateOffDeviceRunLog(okLogLine, {
        exists: true,
        offDeviceSatisfied: false,
        sha256VerifiedAtDestination: true,
      }).alert,
    ).toBe(true);

    const verifiedStatus = evaluateOffDeviceRunLog(okLogLine, {
      exists: true,
      offDeviceSatisfied: true,
      sha256VerifiedAtDestination: true,
    });
    expect(verifiedStatus.alert).toBe(false);
    expect(verifiedStatus.value).toBe("DOĞRULANDI");
  });
});
