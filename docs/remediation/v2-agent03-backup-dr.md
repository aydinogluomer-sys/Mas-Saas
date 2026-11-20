# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 03` · Backup, Restore & Disaster Recovery Engineer)

- **Agent:** `Agent 03` (Backup, Restore & Disaster Recovery Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-10` (`P1` — Backup & Receipt Overwrite Crash-Window Hardening, Rollback-Safe Atomic Promotion, Immutable Overwrite Guard & Canonical Pointer Manifest) and `F-11` / `RG-03` (`P0/O` — Physical Off-Device Storage Honesty & Strict Gate Enforcement)
- **Code Remediation Verdict (`F-10`):** **`PASS`** (`30 / 30` distinct fault-injection & topology tests in `tests/remediation/agent03-backup-dr.test.ts` + `110 / 110` cross-suite regression tests across `backup-adapter-select.test.ts`, `backup-native-durability.test.ts`, `offdevice-cleanup-gate.test.ts`, `offdevice-usb-topology.test.ts`, `backup-telemetry-and-guards.test.ts`, `backup-daily-run-record.test.ts`, and `mandatory-16-scenarios.test.ts` = `140 / 140` green; `0` ESLint errors/warnings; `0` TypeScript errors across all owned files and downstream importers; `8 / 8` `boundary:verify` `PASS`)
- **Physical Release Gate Verdict (`F-11` / `RG-03`):** **`BLOCKED`** *(Honest hardware blocker: `D:\MAS-Backups\mas_radar_dev` is physically unmounted on this single-drive `C:` host; `verify-offdevice-backup.ts --strict-offdevice` exits `1` with `offDeviceGateStatus: "BLOCKED"`; zero `.offdevice.json` or pointer receipts fabricated)*
- **Safety & Privacy Invariants:** `prod_db_writes = 0`, `live_backups_dir_mutations = 0`, `real_network_sends = 0`, `100%` redacted (`0` counterparty names, `0` payment UUIDs, `0` raw IBANs, `0` secrets).

---

## 1. V2 Structured Handoff Contract (`Agent 03 -> Agent 00, Agent 11 & Agent 14`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agentId": "Agent 03",
  "role": "Backup, Restore & Disaster Recovery Engineer",
  "branch": "remediation/v2-hardening",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:10:48.000Z",
  "status": "PASS_CODE_REMEDIATION_BLOCKED_PHYSICAL_TARGET",
  "codeRemediationStatus": "PASS",
  "physicalGateStatus": "BLOCKED",
  "prod_db_writes": 0,
  "live_backups_dir_mutations": 0,
  "real_network_sends": 0,
  "exclusive_write_allowlist": [
    "scripts/ops/backup-lib.ts",
    "scripts/ops/offdevice-copy.ts",
    "scripts/ops/verify-offdevice-backup.ts",
    "scripts/ops/verify-restore-drill-fast.ts",
    "tests/remediation/agent03-backup-dr.test.ts",
    "docs/remediation/v2-agent03-backup-dr.md"
  ],
  "files_modified": [
    "scripts/ops/backup-lib.ts",
    "scripts/ops/offdevice-copy.ts",
    "scripts/ops/verify-offdevice-backup.ts",
    "scripts/ops/verify-restore-drill-fast.ts",
    "tests/remediation/agent03-backup-dr.test.ts"
  ],
  "files_created": [
    "docs/remediation/v2-agent03-backup-dr.md"
  ],
  "files_modified_outside_allowlist": [],
  "findings": {
    "F-10": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Reproduced F-10 crash-window data-loss bug test-first (exit_code: 1 where copyOneVerified unlinked an existing verified dump before renameSync, byte/SHA-256 re-read, companion sidecar verification, and pg_restore --list TOC check, permanently destroying the prior verified backup on mid-flight failure). Replaced all unlink-before-rename paths across backup-lib.ts, offdevice-copy.ts, and verify-restore-drill-fast.ts with staged .tmp-* pre-verification (fsync + byte count + SHA-256 + TOC listability + all companion sidecars) BEFORE rollback-safe .prev-* atomic batch/file promotion (replaceBatchRollbackSafe / replaceFileRollbackSafe), enforced immutable overwrite refusal on differing SHA-256, added atomic latest-verified-offdevice.json pointer publication after verified .offdevice.json creation, and locked 30 distinct fault-injection & topology tests."
    },
    "F-11": {
      "priority": "P0/O",
      "status": "BLOCKED",
      "confidence": "D/O",
      "summary": "Configured off-device target D:\\MAS-Backups\\mas_radar_dev is physically absent on host (existsSync=false; only internal NVMe volume C: is mounted). verify-offdevice-backup.ts reports offDeviceGateStatus='BLOCKED' in both fallback mode (ok=true for local dump TOC readability, offDeviceSatisfied=false) and --strict-offdevice mode (ok=false, exit_code=1). Zero .offdevice.json or latest-verified-offdevice.json files were fabricated."
    }
  },
  "exported_contracts_for_peers": {
    "Agent 11": [
      "copyToTargetVerified(sourcePath, destDir, opts?: CopyToTargetOptions): CopyVerifyResult",
      "replaceFileRollbackSafe(tempPath, destPath, opts?: ReplaceFileRollbackOptions): DurabilityMetadata",
      "writeStage07Receipt(receiptPath, receipt, opts?: { renameImpl? }): string",
      "writeOffDeviceRecord(result, opts?: { renameImpl?; updatePointer? }): string",
      "writeLatestVerifiedOffDevicePointer(result, recordPath, opts?: { renameImpl? }): string | null",
      "verifyOffDeviceBackup(opts?: VerifyOffDeviceOptions): VerifyOffDeviceReport"
    ],
    "Agent 14": [
      "verifyOffDeviceBackup({ strictOffDevice: true }) -> offDeviceGateStatus: 'PASS' | 'BLOCKED'",
      "LATEST_OFFDEVICE_POINTER_FILENAME = 'latest-verified-offdevice.json'"
    ]
  },
  "release_gate_signals": [
    {
      "id": "RG-03-TOOLING",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "30/30 fault-injection & topology cases in agent03-backup-dr.test.ts + 110/110 regression tests (including backup-adapter-select.test.ts 27/27) pass; staged .tmp-* pre-verification + rollback-guarded verifyListable(destPath) before .prev-* commit + immutable overwrite guard + sole-verified retention guard verified in isolated temp directories."
    },
    {
      "id": "RG-03",
      "scope": "host_physical_only",
      "status": "BLOCKED",
      "evidence": "Physical external volume D:\\MAS-Backups\\mas_radar_dev is unmounted (ENOENT); verify-offdevice-backup.ts --strict-offdevice exits 1 with offDeviceGateStatus='BLOCKED'."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-03-01",
      "symbol": "copyOneVerified / copyToTargetVerified (backup-lib.ts)",
      "defectBeforeFix": "unlinkSync(destPath) executed before renameSync(tempPath, destPath), before byte/SHA-256 verification, before companion sidecar verification, and before pg_restore --list TOC check — permanently destroying any prior verified dump at destPath on corrupt write, TOC error, sidecar mismatch, or rename EIO/EACCES.",
      "minimalFix": "Introduced stageOneVerifiedTemp + pre-promotion companion staging + replaceBatchRollbackSafe using .prev-* preservation, post-rename byte/SHA-256 verification, and rollback-guarded verifyListable(finalDestPath) (requiring tocEntryCount > 0 BEFORE .prev-* backups are unlinked) with full reverse rollback on any failure."
    },
    {
      "id": "EC-03-02",
      "symbol": "assertImmutableOverwriteAllowed (backup-lib.ts)",
      "defectBeforeFix": "copyToTargetVerified allowed overwriting an existing immutable backup (cutover_*, mas_radar_dev*, or .immutable marker) at destDir with different bytes.",
      "minimalFix": "Added upfront assertImmutableOverwriteAllowed rejecting differing-content overwrites with 'GÜVENLİK DURDURMASI: IMMUTABLE yedek farklı içerikle üzerine yazılamaz' while permitting identical-SHA-256 idempotent re-verification."
    },
    {
      "id": "EC-03-03",
      "symbol": "writeStage07Receipt / writeBufferAtomic / writeDrillReceiptAtomic",
      "defectBeforeFix": "writeStage07Receipt, writeBufferAtomic, writeOffDeviceRecord, and verify-restore-drill-fast.ts writeJsonAtomic all called unlinkSync(destPath) before renameSync(tempPath, destPath) and validated Stage07 mandatory fields only AFTER overwriting receiptPath.",
      "minimalFix": "Validated Stage07 mandatory fields on tempPath before promotion and routed all atomic file writers through replaceFileRollbackSafe so rename or validation failures restore .prev-* without losing prior receipts."
    },
    {
      "id": "EC-03-04",
      "symbol": "cleanupFailedOffDeviceCopy / writeLatestVerifiedOffDevicePointer (offdevice-copy.ts)",
      "defectBeforeFix": "cleanupFailedOffDeviceCopy blindly unlinked destPath even if destPath was an intact previously verified backup matching its .offdevice.json receipt, and offdevice-copy.ts lacked an atomic canonical pointer manifest.",
      "minimalFix": "Added hasIntactPriorVerifiedOffDeviceCopy guard in cleanupFailedOffDeviceCopy and added atomic writeLatestVerifiedOffDevicePointer ('latest-verified-offdevice.json') updated strictly after verified copy + .offdevice.json creation (refusing LOCAL_STANDIN downgrades)."
    },
    {
      "id": "EC-03-05",
      "symbol": "copyToTargetVerified nested overlap & planPrune invalid-timestamp guard (backup-lib.ts)",
      "defectBeforeFix": "copyToTargetVerified checked only overlap === 'identical' (allowing nested target_inside_source / source_inside_target when invoked directly), and planPrune threw RangeError on unreadable/NaN mtime timestamps.",
      "minimalFix": "Rejected all non-null detectBackupPathOverlap kinds in copyToTargetVerified and added fail-safe NaN timestamp retention protection in planPrune."
    }
  ],
  "verification": {
    "baselineNegativeReproducerCommand": "pnpm exec vitest run tests/remediation/agent03-backup-dr.test.ts",
    "baselineNegativeReproducerResult": "exit_code=1 (AssertionError: expected false to be true on existsSync(destDump) at line 556 before backup-lib.ts fix — proving prior verified v1 dump was destroyed on corrupt overwrite)",
    "vitestAgentSuiteCommand": "pnpm exec vitest run tests/remediation/agent03-backup-dr.test.ts",
    "vitestAgentSuiteResult": "exit_code=0 (1 test file passed, 30/30 distinct fault-injection & topology tests passed)",
    "vitestRegressionCommand": "pnpm exec vitest run tests/backup-adapter-select.test.ts tests/backup-native-durability.test.ts tests/backup-daily-run-record.test.ts tests/offdevice-cleanup-gate.test.ts tests/offdevice-usb-topology.test.ts tests/ops/backup-telemetry-and-guards.test.ts && pnpm exec vitest run tests/remediation/mandatory-16-scenarios.test.ts -t \"Scenario 9\"",
    "vitestRegressionResult": "exit_code=0 (110/110 tests passed across 7 regression suites)",
    "eslintCommand": "pnpm exec eslint scripts/ops/backup-lib.ts scripts/ops/offdevice-copy.ts scripts/ops/verify-offdevice-backup.ts scripts/ops/verify-restore-drill-fast.ts tests/remediation/agent03-backup-dr.test.ts",
    "eslintResult": "exit_code=0 (0 errors, 0 warnings)",
    "scopedTypecheckCommand": "pnpm exec tsc --noEmit -p <temp-tsconfig-including-agent03-files-and-importers>",
    "scopedTypecheckResult": "exit_code=0 (0 TypeScript errors across all Agent 03 owned files and importers; workspace pnpm typecheck observed only 3 unrelated in-flight errors in Agent 01 scripts/db/migrate-verify.ts and Agent 09 security test files)",
    "boundaryCommand": "pnpm boundary:verify",
    "boundaryResult": "exit_code=0 (8/8 PASS)",
    "readOnlyOffDeviceVerifyCommand": "pnpm backup:offdevice:verify -- --json && pnpm exec tsx scripts/ops/verify-offdevice-backup.ts --strict-offdevice --json",
    "readOnlyOffDeviceVerifyResult": "fallback: ok=true, mode='local_fallback', offDeviceReachable=false, offDeviceSatisfied=false, offDeviceGateStatus='BLOCKED', tocEntryCount=2358; strict: ok=false, offDeviceGateStatus='BLOCKED', exit_code=1"
  },
  "rollback_plan": "Restore scripts/ops/backup-lib.ts, scripts/ops/offdevice-copy.ts, scripts/ops/verify-offdevice-backup.ts, scripts/ops/verify-restore-drill-fast.ts, and tests/remediation/agent03-backup-dr.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a and remove docs/remediation/v2-agent03-backup-dr.md. Zero database migrations or live backup files were modified."
}
```

---

## 2. Root Cause & Surgical Remediation Summary (`F-10` & `F-11`)

### 2.1 `F-10` — Crash-Window & Destructive Overwrite Closure
1. **Staged Pre-Verification Before Touching Destination (`stageOneVerifiedTemp` & `copyToTargetVerified` in [`scripts/ops/backup-lib.ts`](../../scripts/ops/backup-lib.ts)):**
   - Main `.dump` is copied to `${destPath}.tmp-${pid}-${ts}-${seq}-${nonce}`, flushed via `fsyncSync(fd)`, and verified on disk for `tempBytes === sourceBytes` and `tempSha256 === sourceSha256` **before** touching `destPath`.
   - Every present companion sidecar (`.receipt.json`, `.stage07.json`, `.sha256`, `.enc`, `-documents.tar.gz`, `-documents.manifest.json`) is staged to its own `.tmp-*` file, `fsyncSync`ed, and byte/SHA-256 verified **before** any existing file in `destDir` is moved.
   - When `opts.verifyListable` is supplied, `replaceBatchRollbackSafe` invokes `opts.verifyListable(finalDestPath)` (enforcing `tocEntryCount > 0`) **inside the rollback-protected transaction block after moving prior targets to `.prev-*` and promoting `.tmp-* -> destPath`, strictly BEFORE `.prev-*` backups are unlinked** — satisfying both `[result.destPath]` TOC inspection and 100% rollback restoration of prior verified backups on TOC failure.
2. **Rollback-Safe Multi-File & Single-File Atomic Publication (`replaceBatchRollbackSafe` & `replaceFileRollbackSafe`):**
   - Eliminated every `if (existsSync(destPath)) unlinkSync(destPath)` pattern across [`scripts/ops/backup-lib.ts`](../../scripts/ops/backup-lib.ts), [`scripts/ops/offdevice-copy.ts`](../../scripts/ops/offdevice-copy.ts), and [`scripts/ops/verify-restore-drill-fast.ts`](../../scripts/ops/verify-restore-drill-fast.ts).
   - Existing targets are moved to `${destPath}.prev-*` prior to `renameImpl(tempPath, destPath)`. If `renameImpl` or post-promotion disk SHA-256/schema validation fails on the main dump or any Nth companion sidecar, all promoted files in the batch are rolled back in reverse order and every `.prev-*` is restored to its original path, leaving the prior verified backup + sidecar set `100%` intact with zero `.tmp-*`, `.prev-*`, or `.aborted-*` leftovers.
   - `.prev-*` backups are unlinked **only after** the entire batch passes post-rename byte and SHA-256 verification on disk.
3. **Immutable Backup Overwrite Guard (`assertImmutableOverwriteAllowed`):**
   - Refuses to overwrite an existing destination dump classified as `immutable` (via `IMMUTABLE_NAME_PATTERNS`, `MAS_BACKUP_PROTECTED_PATTERNS`, or a `${destPath}.immutable` marker) whenever `sourceSha256` or `sourceBytes` differs from the existing file (`GÜVENLİK DURDURMASI: IMMUTABLE yedek farklı içerikle üzerine yazılamaz`), while allowing idempotent re-verification of identical SHA-256 content.
4. **Canonical Pointer Manifest (`latest-verified-offdevice.json` in [`scripts/ops/offdevice-copy.ts`](../../scripts/ops/offdevice-copy.ts)):**
   - `writeLatestVerifiedOffDevicePointer` atomically writes/updates `latest-verified-offdevice.json` in the destination directory strictly **after** `copyToTargetVerified` and `<dump>.offdevice.json` succeed, and refuses to overwrite a physical (`offDeviceSatisfied: true`) pointer with a `LOCAL_STANDIN` (`offDeviceSatisfied: false`) run.

### 2.2 `F-11` — Physical Off-Device Honesty (`RG-03 = BLOCKED`)
- [`scripts/ops/verify-offdevice-backup.ts`](../../scripts/ops/verify-offdevice-backup.ts) now exposes `offDeviceGateStatus: "PASS" | "BLOCKED"`, enforces `.offdevice.json` presence + zero `offDeviceCleanupBlockers` + `latest-verified-offdevice.json` integrity in `--strict-offdevice` mode, and reports `offDeviceGateStatus = "BLOCKED"` whenever `D:\MAS-Backups\mas_radar_dev` is unreachable (`ENOENT`) or classified as `LOCAL_STANDIN`.

---

## 3. 30-Case Fault-Injection & Topology Test Matrix ([`tests/remediation/agent03-backup-dr.test.ts`](../../tests/remediation/agent03-backup-dr.test.ts))

| Case | Scenario Verified | Result |
|---|---|---|
| `Case 01` | Unmounted `D:\MAS-Backups\mas_radar_dev` raises `ENOENT` & writes zero receipts | **PASS** |
| `Case 02` | Same-directory overlap (`source === target`, slash/case variants & CLI exit `1`) | **PASS** |
| `Case 03` | Nested-directory overlap (`target_inside_source` & `source_inside_target`) rejected | **PASS** |
| `Case 04` | UNC topology (`identical`, `nested`, same-share sibling `false` vs distinct share `true`) | **PASS** |
| `Case 05` | `LOCAL_STANDIN` sets `offDeviceSatisfied=false` & blocks destructive cleanup gate | **PASS** |
| `Case 06` | Corrupt main dump bytes (same-length bitflip) preserves prior verified `v1` + sidecars | **PASS** |
| `Case 07` | Truncated main dump copy preserves prior verified `v1` + sidecars | **PASS** |
| `Case 08` | `copyFileImpl` throwing `ENOSPC` mid-write cleans `.tmp-*` & preserves `v1` | **PASS** |
| `Case 09` | `0`-byte empty source dump rejected before touching prior verified `v1` | **PASS** |
| `Case 10` | `verifyListable` TOC throw on `destPath` inside rollback guard restores `v1` | **PASS** |
| `Case 11` | `verifyListable` returning `0` TOC entries before `.prev-*` commit restores `v1` | **PASS** |
| `Case 12` | Corrupt `.sha256` sidecar during staging cleans all `.tmp-*` & preserves `v1` | **PASS** |
| `Case 13` | Corrupt `.stage07.json` sidecar during staging cleans all `.tmp-*` & preserves `v1` | **PASS** |
| `Case 14` | Corrupt `-documents.tar.gz` archive during staging cleans all `.tmp-*` & preserves `v1` | **PASS** |
| `Case 15` | Corrupt `-documents.manifest.json` during staging cleans all `.tmp-*` & preserves `v1` | **PASS** |
| `Case 16` | `renameImpl` `EACCES` on main `dest -> .prev-*` leaves prior verified `v1` untouched | **PASS** |
| `Case 17` | `renameImpl` `EIO` on main `.tmp-* -> dest` rolls back `.prev-*` to restore `v1` | **PASS** |
| `Case 18` | `renameImpl` `EIO` on 1st sidecar (`.stage07.json`) rolls back promoted main dump to `v1` | **PASS** |
| `Case 19` | `renameImpl` `EIO` on 2nd sidecar (`.sha256`) rolls back main + 1st sidecar to `v1` | **PASS** |
| `Case 20` | `renameImpl` `EXDEV` on newly added `-documents.tar.gz` rolls back all & leaves zero orphans | **PASS** |
| `Case 21` | Immutable dump (`cutover_*` & `.immutable` marker) rejects differing-SHA-256 overwrite | **PASS** |
| `Case 22` | Immutable dump (`mas_radar_dev-*`) allows identical-SHA-256 idempotent re-verification | **PASS** |
| `Case 23` | `writeStage07Receipt` preserves prior valid receipt on empty field & `renameImpl` `EIO` | **PASS** |
| `Case 24` | `writeDrillReceiptAtomic` preserves prior `latest-restore-drill.json` on `renameImpl` `EIO` | **PASS** |
| `Case 25` | `latest-verified-offdevice.json` atomic pointer update, `EIO` rollback & stand-in guard | **PASS** |
| `Case 26` | `cleanupFailedOffDeviceCopy` removes tampered files & `.tmp-*` while sparing verified `v1` | **PASS** |
| `Case 27` | `planPrune` / `executePrune` sole-verified guard, `NaN`-date guard & late `.immutable` recheck | **PASS** |
| `Case 28` | `pruneUnverifiedQuarantinedDumps` removes aged rolling `.unverified`, spares immutable names | **PASS** |
| `Case 29` | `verifyOffDeviceBackup` strict/fallback `BLOCKED` vs genuine verified USB `PASS` | **PASS** |
| `Case 30` | `evaluateOffDeviceRunLog` fail-closed telemetry (`exit 3`, `exit 1`, bad JSONL, missing receipt) | **PASS** |
