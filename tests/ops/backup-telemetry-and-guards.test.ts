/**
 * Faz 43 (`B3`) — Yedekleme + Doküman Kasası Arşivi, Dürüst Telemetri Alarm Borusu,
 * 8 GB RAM Servis/Port Gözetimi, CI ve Harcanabilir-DB Kapıları Test Paketi.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { evaluateOffDeviceRunLog } from "@/lib/ops/telemetry-alerts";
import { validateDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { resolveDailyBackupConfig } from "../../scripts/ops/backup-daily";
import {
  DEFAULT_RETENTION,
  archiveDocumentVault,
  copyToTargetVerified,
  executePrune,
  listDumps,
  planPrune,
  pruneUnverifiedQuarantinedDumps,
  sha256OfFile,
  writeStage07Receipt,
  type OffDeviceClassification,
  type Stage07Receipt,
} from "../../scripts/ops/backup-lib";
import { resolveGuardedPorts } from "../../scripts/ops/runtime-port-guard";
import { PASSTHROUGH_FROM_ENV_LOCAL, buildWatchSubprocessEnv } from "../../scripts/ops/telemetry-watch";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const ROOT = process.cwd();

describe("Faz 43 — Harcanabilir-DB koruyucusu (disposable-guard.ts) ve statik kapsam", () => {
  it("mas_radar_dev, postgres ve işaretsiz hedefleri HİÇBİR soket açmadan GÜVENLİK DURDURMASI ile reddeder; parola sızdırmaz", () => {
    const secret = "CokGizliCanliParola!99";
    for (const badDb of ["mas_radar_dev", "postgres", "template1", "mas_phase", "production"]) {
      let msg = "";
      try {
        validateDisposableTargetDb(
          {
            DATABASE_URL: `postgresql://mas_radar_app:${secret}@127.0.0.1:5432/${badDb}`,
          },
          ["DATABASE_URL", "MIGRATION_DATABASE_URL"],
          "phase3:verify",
        );
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toContain("GÜVENLİK DURDURMASI");
      expect(msg).toContain(badDb);
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain("postgresql://");
    }
  });

  it("MIGRATION_DATABASE_URL harcanabilir olsa bile DATABASE_URL mas_radar_dev gösteriyorsa bölünmüş ortam tuzağını reddeder", () => {
    expect(() =>
      validateDisposableTargetDb(
        {
          MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_p43_verify",
          DATABASE_URL: "postgresql://mas_radar_app:gizli@127.0.0.1:5432/mas_radar_dev",
        },
        ["MIGRATION_DATABASE_URL", "DATABASE_URL"],
        "import-real",
      ),
    ).toThrow(/GÜVENLİK DURDURMASI.*mas_radar_dev/);
  });

  it("geçerli harcanabilir hedefleri (verify / clone / test / drill) kabul eder", () => {
    const res = validateDisposableTargetDb(
      {
        MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_roles_p39_verify",
        DATABASE_URL: "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_roles_p39_verify",
      },
      ["MIGRATION_DATABASE_URL", "DATABASE_URL"],
      "phase43:test",
    );
    expect(res.dbName).toBe("mas_radar_roles_p39_verify");
  });

  it("DB'ye bağlanan TÜM scripts/phase*-verify.ts betikleri ve scripts/import-real.ts assertDisposableTargetDb çağırır", () => {
    const phaseFiles = readdirSync(path.join(ROOT, "scripts"))
      .filter((f) => /^phase\w+-verify\.ts$/.test(f))
      .sort();

    // phase17-verify.ts ve phase18-verify.ts saf AST / kaynak-metin tarayıcısıdır (sıfır DB bağlantısı).
    const sourceOnlyVerifies = new Set(["phase17-verify.ts", "phase18-verify.ts"]);
    const dbPhaseFiles = phaseFiles.filter((f) => !sourceOnlyVerifies.has(f));
    expect(dbPhaseFiles.length).toBeGreaterThanOrEqual(40);

    const unguarded: string[] = [];
    for (const file of [...dbPhaseFiles, "import-real.ts"]) {
      const content = readFileSync(path.join(ROOT, "scripts", file), "utf8");
      const hasImport = content.includes("disposable-guard");
      const hasCall = /\bassertDisposableTargetDb\s*\(/.test(content);
      if (!hasImport || !hasCall) {
        unguarded.push(file);
      }
    }
    expect(unguarded).toEqual([]);

    // phase16-verify.ts ağır `next start` yerine hafif `scripts/ops/start-standalone.ts` başlatır.
    const phase16 = readFileSync(path.join(ROOT, "scripts", "phase16-verify.ts"), "utf8");
    expect(phase16).toContain("scripts/ops/start-standalone.ts");
    expect(phase16).not.toMatch(/spawn\(\s*["']pnpm["']\s*,\s*\[\s*["']exec["']\s*,\s*["']next["']\s*,\s*["']start["']/);
  });

  it("scripts/ altında aktif `docker exec` çağrısı kalmamıştır (yalnız CI MAS_PG_RUNTIME=docker bağdaştırıcısı izole edilmiştir)", () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(ts|sh|mjs|js)$/.test(entry.name)) acc.push(full);
      }
      return acc;
    };

    const allowedDockerAdapters = new Set([
      path.normalize(path.join(ROOT, "scripts", "db", "backup-docker-postgres.ts")),
      path.normalize(path.join(ROOT, "scripts", "db", "ensure.ts")),
    ]);

    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, "scripts"))) {
      if (allowedDockerAdapters.has(path.normalize(file))) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) return;
        if (/\bdocker\s+exec\b/.test(trimmed)) {
          offenders.push(`${path.relative(ROOT, file)}:${idx + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("Faz 43 — .env.local aktarımı, Doküman Kasası SHA-256 arşivleme, off-device kopya ve budama", () => {
  it("resolveDailyBackupConfig süreç ortamı boşken .env.local değişkenlerini okur ve süreç ortamına öncelik verir", () => {
    const fromEnvLocal = resolveDailyBackupConfig(
      {},
      {
        MIGRATION_DATABASE_URL: "postgres://postgres:x@127.0.0.1:5432/mas_radar_dev",
        MAS_OFFDEVICE_BACKUP_DIR: "E:\\mas-offdevice",
        MAS_BACKUP_DIR: "D:\\mas-backups",
        MAS_BACKUP_PRUNE_APPLY: "1",
        MAS_DOCUMENT_STORAGE_DIR: "D:\\mas-docs",
      },
      "C:\\MAS",
    );
    expect(fromEnvLocal.offDeviceDir).toBe("E:\\mas-offdevice");
    expect(fromEnvLocal.backupDir).toBe("D:\\mas-backups");
    expect(fromEnvLocal.pruneApply).toBe(true);
    expect(fromEnvLocal.documentStorageDir).toBe("D:\\mas-docs");

    const overridden = resolveDailyBackupConfig(
      { MAS_OFFDEVICE_BACKUP_DIR: "\\\\nas\\override" },
      { MAS_OFFDEVICE_BACKUP_DIR: "E:\\mas-offdevice" },
      "C:\\MAS",
    );
    expect(overridden.offDeviceDir).toBe("\\\\nas\\override");
  });

  it("telemetry-watch PASSTHROUGH_FROM_ENV_LOCAL MAS_APP_BASE_URL, MAS_OFFDEVICE_BACKUP_DIR ve e-posta/yedek anahtarlarını iletir", () => {
    for (const key of [
      "MAS_APP_BASE_URL",
      "MAS_BACKUP_DIR",
      "MAS_OFFDEVICE_BACKUP_DIR",
      "EMAIL_API_URL",
      "EMAIL_API_KEY",
      "EMAIL_FROM",
      "EMAIL_TO",
    ]) {
      expect(PASSTHROUGH_FROM_ENV_LOCAL).toContain(key);
    }

    const env = buildWatchSubprocessEnv(
      {},
      {
        MAS_APP_BASE_URL: "http://127.0.0.1:3000",
        MAS_OFFDEVICE_BACKUP_DIR: "E:\\mas-yedek",
        EMAIL_TO: "cfo@mas.local",
      },
      "postgres://postgres:p@127.0.0.1:5432/mas_radar_p43_verify",
      "postgresql://mas_radar_app:p@127.0.0.1:5432/mas_radar_p43_verify",
    );
    expect(env.MAS_APP_BASE_URL).toBe("http://127.0.0.1:3000");
    expect(env.MAS_OFFDEVICE_BACKUP_DIR).toBe("E:\\mas-yedek");
    expect(env.EMAIL_TO).toBe("cfo@mas.local");
  });

  it("archiveDocumentVault deterministik .tar.gz + SHA-256 manifest üretir; copyToTargetVerified ve executePrune eşlikçileri yönetir", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mas-p43-vault-"));
    try {
      const storageDir = path.join(tmp, "vault");
      const sourceDir = path.join(tmp, "backups");
      const targetDir = path.join(tmp, "offdevice");
      mkdirSync(path.join(storageDir, "2026", "10"), { recursive: true });
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });

      writeFileSync(path.join(storageDir, "2026", "10", "fatura-001.pdf"), "PDF-FATURA-ICERIK-1", "utf8");
      writeFileSync(path.join(storageDir, "sozlesme-tr.txt"), "Tedarikçi sözleşmesi ₺125.000,00", "utf8");

      const oldStamp = "2026-01-10T03-00-00-000Z";
      const newStamp = "2026-10-30T03-00-00-000Z";
      const oldDump = path.join(sourceDir, `daily-${oldStamp}.dump`);
      const newDump = path.join(sourceDir, `daily-${newStamp}.dump`);
      writeFileSync(oldDump, "OLD-DUMP-BYTES", "utf8");
      writeFileSync(newDump, "NEW-DUMP-BYTES", "utf8");

      const archive1 = archiveDocumentVault(storageDir, newDump);
      const shaFirst = archive1.archiveSha256;
      const archive2 = archiveDocumentVault(storageDir, newDump);
      expect(archive2.archiveSha256).toBe(shaFirst);
      expect(archive2.fileCount).toBe(2);
      expect(existsSync(archive2.archivePath)).toBe(true);
      expect(existsSync(archive2.manifestPath)).toBe(true);

      // Gzip açıldığında her iki dosyanın gerçek içeriği tar akışı içinde mevcuttur.
      const untarredText = gunzipSync(readFileSync(archive2.archivePath)).toString("utf8");
      expect(untarredText).toContain("2026/10/fatura-001.pdf");
      expect(untarredText).toContain("PDF-FATURA-ICERIK-1");
      expect(untarredText).toContain("Tedarikçi sözleşmesi ₺125.000,00");

      // Eski dump için de doküman arşivi oluştur ki retention budamasının eşlikçileri sildiğini kanıtlayalım.
      const oldArchive = archiveDocumentVault(storageDir, oldDump);

      const receipt: Stage07Receipt = {
        receiptKind: "mas-stage07-backup-receipt-v1",
        timestamp: "2026-10-30T03:00:05.000Z",
        source_db: "mas_radar_dev",
        system_identifier: "7000000000000000001",
        git_sha: "abc1234",
        schema_ledger: "98/0098",
        file_size: 14,
        sha256: sha256OfFile(newDump),
        pg_version: "PostgreSQL 16.4",
        pg_dump_version: "pg_dump (PostgreSQL) 16.4",
        git_branch: "main",
        git_tree_clean: true,
        dump_path: newDump,
        strict_receipt_path: null,
        strict_receipt_sha256: null,
        data_class: "REAL_READ_ONLY",
        documents_archive_path: archive2.archivePath,
        documents_archive_sha256: archive2.archiveSha256,
        documents_manifest_path: archive2.manifestPath,
        documents_file_count: archive2.fileCount,
      };
      writeStage07Receipt(`${newDump}.stage07.json`, receipt);

      const fakeUsbClass = (): OffDeviceClassification => ({
        targetDir,
        kind: "USB_PHYSICAL_VOLUME",
        offDeviceSatisfied: true,
        evidence: "test USB aygıtı",
        sameVolumeAsSource: false,
        driveType: 3,
        targetDisk: null,
        sourceDisk: null,
        samePhysicalDisk: false,
        declaredKind: null,
        operatorAttestation: null,
      });

      const copied = copyToTargetVerified(newDump, targetDir, {
        classify: fakeUsbClass,
        verifyListable: () => ({ tocEntryCount: 42 }),
      });
      expect(copied.sha256Match).toBe(true);
      expect(copied.destRestoreListable).toBe(true);
      expect(copied.sidecarsCopied).toEqual(
        expect.arrayContaining([
          `daily-${newStamp}.dump.stage07.json`,
          `daily-${newStamp}-documents.tar.gz`,
          `daily-${newStamp}-documents.manifest.json`,
        ]),
      );
      expect(
        sha256OfFile(path.join(targetDir, `daily-${newStamp}-documents.tar.gz`)),
      ).toBe(archive2.archiveSha256);

      // Budama testi: 1 günlük / 1 haftalık / 1 aylık kova ile 9 ay önceki rolling dump ve doküman arşivi silinir.
      const staleQuarantined = path.join(sourceDir, "daily-2026-01-05T03-00-00-000Z.dump.unverified");
      writeFileSync(staleQuarantined, "QUARANTINED", "utf8");
      const oldDate = new Date("2026-01-05T03:00:00.000Z");
      utimesSync(staleQuarantined, oldDate, oldDate);

      const plan = planPrune(
        listDumps(sourceDir),
        { ...DEFAULT_RETENTION, daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 },
        new Date("2026-10-31T03:00:00.000Z"),
      );
      const exec = executePrune(plan);
      const qExec = pruneUnverifiedQuarantinedDumps(
        sourceDir,
        24,
        new Date("2026-10-31T03:00:00.000Z"),
      );

      expect(exec.deletedDumps).toContain(oldDump);
      expect(existsSync(oldArchive.archivePath)).toBe(false);
      expect(existsSync(oldArchive.manifestPath)).toBe(false);
      expect(existsSync(newDump)).toBe(true);
      expect(existsSync(archive2.archivePath)).toBe(true);
      expect(qExec.deleted).toContain(staleQuarantined);
      expect(existsSync(staleQuarantined)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Faz 43 — Dürüst harici yedek telemetrisi ve 8 GB RAM süreç/CI koruyucuları", () => {
  it("evaluateOffDeviceRunLog exit 3 (tek kopya) veya bozuk kayıtta asla ALL CLEAR vermez (alert=true)", () => {
    const exit3Line = JSON.stringify({
      ok: false,
      exitCode: 3,
      stage: "offdevice",
      offDeviceOk: false,
      offDeviceNote: "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil",
    });
    const status3 = evaluateOffDeviceRunLog(exit3Line);
    expect(status3.alert).toBe(true);
    expect(status3.value).toContain("exit 3");

    expect(evaluateOffDeviceRunLog("{bozuk-json").alert).toBe(true);
    expect(evaluateOffDeviceRunLog(null, { exists: false }).alert).toBe(true);
    expect(
      evaluateOffDeviceRunLog(null, {
        exists: true,
        offDeviceSatisfied: false,
        sha256VerifiedAtDestination: true,
      }).alert,
    ).toBe(true);

    const healthyLine = JSON.stringify({
      ok: true,
      exitCode: 0,
      stage: null,
      offDeviceOk: true,
      offDeviceNote: "USB_PHYSICAL_VOLUME — sha256 hedefte eşleşti",
    });
    const okStatus = evaluateOffDeviceRunLog(healthyLine, {
      exists: true,
      offDeviceSatisfied: true,
      sha256VerifiedAtDestination: true,
    });
    expect(okStatus.alert).toBe(false);
    expect(okStatus.value).toBe("DOĞRULANDI");
  });

  it("runtime-port-guard yalnız istenen PORT'u denetler; start/stop-production.cmd, PS1 servis ve CI dosyaları sertleştirilmiştir", () => {
    expect(resolveGuardedPorts({})).toEqual([3000]);
    expect(resolveGuardedPorts({ PORT: "3210" })).toEqual([3210]);

    const startCmd = readFileSync(path.join(ROOT, "start-production.cmd"), "utf8");
    const stopCmd = readFileSync(path.join(ROOT, "stop-production.cmd"), "utf8");
    expect(startCmd).toContain('findstr /R /C:":3000 "');
    expect(startCmd).toContain("http://127.0.0.1:3000/ready");
    expect(startCmd).toContain("--no-pause");
    expect(stopCmd).toContain('findstr /R /C:":3000 "');
    expect(stopCmd).toContain("--no-pause");

    const ps1 = readFileSync(path.join(ROOT, "scripts", "ops", "install-postgres-service.ps1"), "utf8");
    expect(ps1).toContain("restart/5000/restart/15000/restart/60000");
    expect(ps1).toContain("finally");

    if (process.platform === "win32") {
      const parseCheck = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('scripts/ops/install-postgres-service.ps1', [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { throw ($errors | Out-String) }; 'PS1_PARSE_OK'",
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 20_000 },
      ).trim();
      expect(parseCheck).toBe("PS1_PARSE_OK");
    }

    const setupYml = readFileSync(path.join(ROOT, ".github", "actions", "setup", "action.yml"), "utf8");
    expect(setupYml).not.toMatch(/version:\s*10\b/);

    const ciYml = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ciYml).toContain("pnpm audit --prod --audit-level=high");
    expect(ciYml).toContain("next-build-artifact");
    expect(ciYml).not.toContain("continue-on-error: true");
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});

