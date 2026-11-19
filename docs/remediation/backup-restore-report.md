# MAS Nexus — Backup, Restore & Disaster Recovery Remediation Report (`Agent 03` · `I-003`)

## 1. Executive Summary & Readiness Status

| Capability / Gate | Status | Evidence Summary |
| :--- | :--- | :--- |
| **Local Nightly Backup & Checksum Sidecars (`mas_radar_dev`)** | **VERIFIED** | Latest daily dump `backups/daily-2026-11-18T00-00-44-034Z.dump` (`2,073,367` bytes, SHA-256 `526570b1206877bede88dc14ed7339449f735836a208b97bfe945a63609459ea`, ledger `123/0123`) verified with `.stage07.json` and `.sha256` sidecars. |
| **Off-Device Copy Tooling, Checksum & TOC Gate** | **VERIFIED** | `scripts/ops/backup-lib.ts` and `scripts/ops/offdevice-copy.ts` enforce `source != destination` independence, post-copy disk SHA-256 + byte size + `pg_restore --list` TOC verification before `.offdevice.json` creation, and corrupt-target cleanup on failure. |
| **Sole Verified Backup Retention Protection (`planPrune`)** | **VERIFIED** | `planPrune()` protects the newest verified `.dump` (`sole_verified_backup_protected`) whenever standard GFS retention slots would otherwise retain only unverified dumps or prune all aged verified dumps. |
| **Fail-Closed Backup Telemetry (`evaluateOffDeviceRunLog`)** | **VERIFIED** | `src/lib/ops/telemetry-alerts.ts` alerts (`alert: true`) on `exit 3` (surfacing `ENOENT` path details verbatim), `exit 1`, corrupt JSONL, missing `.offdevice.json`, unverified destination SHA-256, and `LOCAL_STANDIN` targets. |
| **Isolated Full `pg_restore` Disaster Recovery Drill** | **VERIFIED** | `backups/latest-restore-drill.json` (`mas-fast-restore-drill-v1`) restored `mas_radar_dev` into disposable `mas_radar_dr_verify_test` in `26,406 ms` with `123/0123` migrations, `132/132` RLS tables, exact row & monetary aggregate parity, `mas_radar_app` role parity, and clean teardown (`isolatedDbDropped: true`). |
| **Physical Off-Device Storage Destination (`D:\MAS-Backups\mas_radar_dev`)** | **BLOCKED** | **Hardware Blocker:** Windows workstation currently mounts only internal system NVMe volume `C:` (`DriveType=3`, Disk 0). External USB SSD (`D:\`, `'Min Yi U YZWY_TECH'`) is physically disconnected (`ENOENT`). Zero `.offdevice.json` receipts were fabricated in `backups/`. |

---

## 2. Incident `I-003` Root Cause Analysis

### 2.1 Operational Hardware Root Cause (`ENOENT` on `D:\MAS-Backups\mas_radar_dev`)
1. **Configured Environment Target:** Windows User Environment defines `MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev`.
2. **Historical Hardware Proof (`backups/daily-runs.jsonl`):**
   - On `2026-09-13T13:40:28.933Z` (line 11), `D:\` was physically attached and measured as an independent external USB SSD (`USB_PHYSICAL_VOLUME`, `DriveType=3`, `BusType=USB`, `targetDisk=1`, `sourceDisk=0`, `IsBoot=false`, `IsSystem=false`, `'Min Yi U YZWY_TECH'`), achieving `offDeviceOk: true`.
   - From `2026-09-15T00:00:12.314Z` through `2026-11-18T00:00:41.226Z` (lines 12–34), the external USB drive `D:\` was disconnected from the workstation.
3. **Live Host Disk Measurement (`Win32_LogicalDisk`):**
   - Only `C:` (`DriveType=3`, `254,950,084,608` bytes total, `12,540,076,032` bytes free, System/Boot NVMe Disk 0) is mounted; `Test-Path "D:\MAS-Backups\mas_radar_dev"` evaluates to `False`.
   - When `backup-daily.ts` attempts to create/copy to `D:\MAS-Backups\mas_radar_dev`, Node.js raises `ENOENT: no such file or directory, mkdir 'D:\MAS-Backups\mas_radar_dev'`, recording `ok: false`, `exitCode: 3`, `stage: "offdevice"`, `offDeviceOk: false`.

### 2.2 Code-Level Safety Defects Remediated (Phase B Scenario 9)
1. **Defect 1 — Cross-Platform & UNC `source === target` / Subdirectory Overlap Bypass (`scripts/ops/backup-lib.ts` & `scripts/ops/offdevice-copy.ts`):**
   - Previously, `classifyOffDeviceTarget(targetDir, sourceDir)` checked `if (resolved.startsWith("\\\\") || resolved.startsWith("//"))` and immediately returned `kind: "UNC_NETWORK_SHARE", offDeviceSatisfied: true` without verifying whether `targetDir` equaled or overlapped `sourceDir` (e.g. `classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev\\daily", "\\\\nas-backup\\mas_radar_dev\\daily")`), and `offdevice-copy.ts` lacked an upfront preflight guard preventing self-copy when `MAS_OFFDEVICE_BACKUP_DIR === MAS_BACKUP_DIR`.
2. **Defect 2 — Pruning the Sole Remaining Verified Backup (`scripts/ops/backup-lib.ts`):**
   - Previously, `planPrune(entries, policy, now)` populated GFS (`daily`, `weekly`, `monthly`) retention buckets strictly by timestamp without inspecting verification sidecars (`.receipt.json`, `.sha256`, `.stage07.json`, `.offdevice.json`). When a newer *unverified* `.dump` occupied the `daily: 1` slot while the last verified `.dump` was older than the retention window (e.g. `413` days old), `planPrune` marked the sole verified backup `keep: false` for deletion.

---

## 3. Fixes Implemented

### 3.1 `scripts/ops/backup-lib.ts`
- **Cross-Platform Path Normalization & Overlap Detection (`normalizeBackupPath`, `detectBackupPathOverlap`):**
  - Normalizes Windows drive paths (`C:\...`, `c:/...`), UNC shares (`\\server\share\...`, `//SERVER/share/...`), and POSIX paths across platforms, stripping trailing slashes and applying case-folding on Windows/UNC namespaces.
  - Detects `"identical"`, `"target_inside_source"`, and `"source_inside_target"` overlaps cleanly without false positives on sibling prefixes (e.g. `C:\MAS\Backups` vs `C:\MAS\Backups-Offdevice`).
- **Fail-Closed `classifyOffDeviceTarget(targetDir, sourceDir)`:**
  - Unconditionally returns `sameVolumeAsSource: true`, `offDeviceSatisfied: false`, and `kind: "LOCAL_STANDIN"` with explicit overlap evidence whenever `targetDir` equals `sourceDir` or overlaps as a parent/child directory — including on UNC paths (`\\nas-backup\mas_radar_dev\daily`) and same-share UNC sibling folders — while still accepting genuinely distinct UNC shares (`UNC_NETWORK_SHARE`).
- **Hardened `copyToTargetVerified` & `copyOneVerified`:**
  - Rejects `destDir === sourceDir` before touching disk, cleans up `.tmp-*` partial files in `catch` blocks on mid-copy failure, cleans up previously copied sidecars if any companion checksum fails, and raises `ENOENT` consistently on unmounted Windows drive paths across platforms.
- **Sole Verified Backup Retention Guard (`VERIFIED_SIDECAR_SUFFIXES`, `isVerifiedDumpEntry`, `planPrune`):**
  - Identifies verified dumps via `.receipt.json`, `.stage07.json`, `.offdevice.json`, or `.sha256` sidecars.
  - After computing standard GFS retention decisions, if `entries` contain at least one verified dump and zero verified dumps were marked `keep === true`, `planPrune` force-retains the newest verified dump (`keep = true`, `reason = "sole_verified_backup_protected"`) and recomputes `keptCount`, `prunedCount`, and `bytesToFree`.

### 3.2 `scripts/ops/offdevice-copy.ts`
- **Preflight Overlap Gate (`assertDistinctOffDeviceTarget` & `main`):**
  - Rejects overlapping `targetDir` and `sourceDir` (or `path.dirname(dumpPath)`) and exits `1` before creating directories or touching any files.
- **Strict Post-Verification Receipt Creation (`writeOffDeviceRecord` & `cleanupFailedOffDeviceCopy`):**
  - `writeOffDeviceRecord(result)` is called **only after** `result.sha256Match === true && result.bytesMatch === true && result.destRestoreListable === true`, and re-verifies on-disk destination byte size and SHA-256 against `sourceBytes` and `sourceSha256` prior to atomic `temp + fsync + rename` creation of `<dump>.offdevice.json`.
  - Any checksum, byte-length, or `pg_restore --list` failure invokes `cleanupFailedOffDeviceCopy` to remove corrupt destination copies and `.tmp-*` partial artifacts (never touching `sourceDir`), writes zero `.offdevice.json` receipts, and exits `1`.

### 3.3 `src/lib/ops/telemetry-alerts.ts`
- Inspected `evaluateOffDeviceRunLog(rawJsonl, offDeviceReceipt)` and confirmed all fail-closed invariants hold with all existing tests green:
  - `exitCode === 3` -> `alert: true`, `value: "TEK KOPYA (exit 3)"`, surfacing `ENOENT` note from `daily-runs.jsonl`.
  - Malformed/non-object JSONL -> `alert: true`, `value: "BOZUK KOŞU KAYDI"`.
  - Missing `.offdevice.json` (`exists: false`) -> `alert: true`, `value: "HARİCİ KOPYA EKSİK"`.
  - Unverified destination SHA-256 or `offDeviceSatisfied !== true` -> `alert: true`, `value: "HARİCİ KOPYA DOĞRULANMADI"`.

---

## 4. Verification Evidence

### 4.1 Automated Test Suites & Typecheck
- `npx tsc --noEmit` — **PASS** (`0` errors)
- `npx vitest run tests/remediation/agent03-backup-dr.test.ts` — **PASS** (`6/6` tests)
- `npx vitest run tests/remediation/mandatory-16-scenarios.test.ts -t "Scenario 9"` — **PASS** (`1/1` scenario, `17 ms`)
- `npx vitest run tests/offdevice-cleanup-gate.test.ts tests/offdevice-usb-topology.test.ts tests/ops/backup-telemetry-and-guards.test.ts tests/backup-daily-run-record.test.ts` — **PASS** (`71/71` existing regression tests)

### 4.2 Isolated Temp-Target Copy, SHA-256 & `pg_restore --list` Verification
Executed `scripts/ops/offdevice-copy.ts --dump backups\daily-2026-11-18T00-00-44-034Z.dump` against an isolated ephemeral directory in `%TEMP%` (cleaned up immediately after verification; live `backups/` left untouched):
- **Tooling Verification:** Canonical `mas_radar_dev` dump (`2,073,367` bytes, SHA-256 `526570b1206877bede88dc14ed7339449f735836a208b97bfe945a63609459ea`) and companions (`.stage07.json`, `.sha256`) matched source SHA-256 byte-for-byte at destination, PostgreSQL 16 `pg_restore --list` verified **`2,355` TOC entries**, and `daily-2026-11-18T00-00-44-034Z.dump.offdevice.json` (`1,563` bytes, SHA-256 `e6db769e2d6fbe13…`) was written atomically inside the isolated temp target (`OFF_DEVICE TOOLING = VERIFIED`).
- **Honest Physical Classification:** Because `%TEMP%` resides on `C:\` (Disk 0, `BusType=RAID`, `IsBoot=true`, `IsSystem=true`), `classifyOffDeviceTarget` classified the temp target as `LOCAL_STANDIN` (`offDeviceSatisfied: false`) and printed:
  `OFF_DEVICE PHYSICAL TARGET = BLOCKED — ayrı bir aygıt kanıtlanamadı`.
- **Read-Only Fallback Verifier (`scripts/ops/verify-offdevice-backup.ts --json`):** Reported `ok: true`, `mode: "local_fallback"`, `offDeviceConfigured: true`, `offDeviceReachable: false`, `offDeviceSatisfied: false`, `restoreListable: true`, and explicit warning that `D:\MAS-Backups\mas_radar_dev` is currently unreachable.

### 4.3 Full Isolated `pg_restore` Disaster Recovery Drill (`backups/latest-restore-drill.json`)
Verified full backup-and-restore evidence recorded in `backups/latest-restore-drill.json`:
- **Receipt Kind:** `mas-fast-restore-drill-v1` (`verifiedAt: 2026-11-17T20:22:57.149Z`, `durationMs: 26406`, `passed: true`)
- **Source -> Isolated Target:** `mas_radar_dev` (read-only snapshot) -> disposable `mas_radar_dr_verify_test` (`isolatedDbDropped: true` after verification)
- **Dump Verified:** `dr-verify-2026-11-17T20-22-31-477Z.dump` (`2,072,101` bytes, SHA-256 `d3b79fff00a8dcc5b8b12243eb47294db520d3f45ca8b13887c5617b6f0f9f6a`)
- **Schema & Security Parity:** `schemaLedger: "123/0123"`, `checksumDigest: "23724d4f35383e47185c90ec217e0420d8c279cc867a550b331897eaa95ee4a9"`, `tablesVerified: 132`, `rlsTablesVerified: 132`, `runtimeRoleParityVerified: true` (`mas_radar_app` with `rolsuper = false`, `rolbypassrls = false`)
- **Row Count & Monetary Aggregate Parity (`countsMatched: true`, `aggregatesMatched: true`):**
  - `payments`: `19` rows · `default_amount = 540000.00`
  - `payment_instances`: `536` rows · `amount = 16080000.00` · `paid_amount = 167000.00`
  - `checks`: `7` rows · `amount = 590000.00`
  - `loans`: `1` row · `principal = 1500000.00`
  - `invoices`: `0` rows · `bank_transactions`: `0` rows

---

## 5. Hardware Blocker & Operator Unblock Runbook

> **CURRENT PHYSICAL OFF-DEVICE STATUS: `BLOCKED`**
> No external USB disk (`D:\`) or independent SMB/NAS share is currently mounted on this single-drive (`C:\`) Windows workstation. Per safety policy, no `.offdevice.json` receipt was fabricated on `C:\`.

To clear `offdevice_backup_status` (`I-003`) to `DOĞRULANDI` in production:
1. Connect the dedicated external USB SSD (`D:\`, `BusType=USB`, distinct physical disk number) **or** mount an independent NAS share (`\\<nas-host>\<share>`).
2. Confirm `MAS_OFFDEVICE_BACKUP_DIR` points to the mounted volume (e.g. `D:\MAS-Backups\mas_radar_dev` or `\\nas-backup\mas_radar_dev\daily`).
3. Run `pnpm exec tsx scripts/ops/offdevice-copy.ts` and verify output prints both `OFF_DEVICE TOOLING = VERIFIED` and `OFF_DEVICE PHYSICAL TARGET = OK`.
4. Confirm strict gate closure via `pnpm backup:offdevice:verify -- --strict-offdevice`.
