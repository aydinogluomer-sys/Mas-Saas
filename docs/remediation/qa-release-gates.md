# MAS Nexus — Phase F Independent QA, Regression & 15 Release Gates Verification (`Agent 11`)

- **Verification Date:** `2026-11-19` (`Europe/Istanbul` / UTC `2026-11-18..19`)
- **Independent Certifier:** `Agent 11 — QA, Regression & Release Verification`
- **Target Database (Read-Only / Rolled-Back Only):** `mas_radar_dev` (`PostgreSQL 16.14`, native `127.0.0.1:5432`, head migration `0124`, ledger `124/0124`, checksum `87cb14b6662446794cb431da822f1f241f36e3b176c2a8b1a91b86097eb807bb`)
- **Live Runtime Processes Inspected (Unmodified):** Next.js standalone server (`127.0.0.1:3000`, `/ready = 200`, `/health = 200`) & background maintenance worker
- **Verification Harness:** [`scripts/qa/verify-rg-15-gates.ts`](../../scripts/qa/verify-rg-15-gates.ts) & [`tests/remediation/mandatory-16-scenarios.test.ts`](../../tests/remediation/mandatory-16-scenarios.test.ts)

---

## 1. Executive Summary & Overall Release Recommendation

| Metric | Phase B Baseline | Phase F Post-Remediation |
| :--- | :--- | :--- |
| **Mandatory 16 Regression Scenarios** | `8 PASS` / `8 FAIL` (`50%`) | **`16 / 16 PASS` (`100%`)** |
| **Specialist Remediation Suites (`agent01..agent10` + `mandatory-16`)** | N/A (pre-implementation) | **`11 / 11 files` · `87 / 87 tests PASS`** |
| **Core Security / Financial / Ops Regression Suite (9 files)** | Baseline | **`9 / 9 files` · `200 / 200 tests PASS`** |
| **TypeScript (`tsc --noEmit`), ESLint (`pnpm lint`), Boundary (`8/8`), Phase 17 (`9/9`), Phase 18 (`13/13`), DB Roles (`8/8`)** | `tsc` PASS | **ALL PASS (`exit 0`, `0` errors, `0` warnings)** |
| **Isolated DR Restore Drill (`mas_radar_dr_verify_test` at `124/0124`)** | Stale (`119/0119`) | **`PASS` (`124/0124` · `132/132` RLS · `71,898ms`)** |
| **15 Canonical Release Gates (`RG-01 .. RG-15`, Section 8)** | Pre-remediation | **`14 PASS` · `1 BLOCKED` (`RG-03`) · `0 FAIL` · `0 NOT VERIFIED` (`exit 2`)** |
| **Live `mas_radar_dev` Data Mutation Count** | `0` | **`0` (`beforeFp === afterFp` verified)** |

### Overall Release Recommendation: **`BLOCKED BY EXTERNAL DEPENDENCY` (`14 / 15 PASS` · `1 / 15 BLOCKED` on `RG-03` · `0 / 15 FAIL`)**

Every single software, database, schema-consistency, financial-reconciliation, partial-payment, temporal, notification-deduplication, incident-lifecycle, data-quality, CFO-reporting, authorization/RLS, regression, runtime-health, environment-isolation, and evidence-integrity gate (**`RG-01`**, **`RG-02`**, and **`RG-04` through `RG-15` — `14 / 14` software gates**) **PASSED** with **`0` `FAIL`** and **`0` `NOT VERIFIED`**.

In strict compliance with the **Section 8 Honesty Rule** (*never interpret `BLOCKED` as `PASS`*), **`RG-03 — Backup recoverability`** is reported honestly as **`BLOCKED`** (`exit 2`):
- **Local backup & isolated DR `pg_restore` = `VERIFIED`:** Fresh custom-format `pg_dump` (`backups/dr-verify-2026-11-18T19-28-02-244Z.dump`, `2.0 MB`, `sha256=dfbc6933f3651311…`), `.sha256` + `.stage07.json` receipts, and isolated `pg_restore` into disposable `mas_radar_dr_verify_test` at head schema **`124/0124`** (`132/132` RLS tables, exact row & monetary aggregate parity, `mas_radar_app` runtime role parity, clean `DROP DATABASE`) all **PASSED**.
- **Off-device copy & retention tooling = `VERIFIED`:** `copyToTargetVerified`, `classifyOffDeviceTarget` (rejecting same-directory/same-volume targets), `planPrune` (never deleting the sole remaining verified `.dump`), and `evaluateOffDeviceRunLog` (`ENOENT` exit `3` alerting) all **PASSED**.
- **Physical external hardware target = `BLOCKED`:** Configured `MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev` is physically disconnected on this Windows workstation (`exists=false` / `ENOENT`, `offDeviceSatisfied=false`). Mounting external drive `D:\` and executing `pnpm ops:backup:offdevice` is the sole external infrastructure prerequisite remaining to flip `RG-03` to `PASS` (`15 / 15 PASS`, `exit 0`).

---

## 2. Independent QA Integrity & Zero-Mutation Proofs

### 2.1 Phase B Baseline Test-Suite Integrity Check
`tests/remediation/mandatory-16-scenarios.test.ts` was cryptographically verified untouched across Phases C, D, E, and F:

- **File:** `tests/remediation/mandatory-16-scenarios.test.ts`
- **Byte Length:** `68,396` bytes
- **Last Write Timestamp:** `2026-11-18T16:52:09.5331881+03:00` (exact Phase B completion timestamp)
- **SHA-256 Digest:** `819369DD92B56329EB4796B5FF6626832C52137A3CF91DF8F926E70F0D444569`
- **Result:** **`VERIFIED UNTOUCHED` (`0` bytes modified since Phase B)**.

### 2.2 Strict Separation of Duties Check
- `Agent 11` modified **`0`** production files under `src/`, `scripts/ops/`, or `supabase/migrations/`, and **`0`** specialist test files (`agent01..agent10`).
- Phase F QA artifacts authored exclusively in `Agent 11` scope:
  - [`scripts/qa/verify-rg-15-gates.ts`](../../scripts/qa/verify-rg-15-gates.ts)
  - [`docs/remediation/qa-release-gates.md`](./qa-release-gates.md)

### 2.3 Live `mas_radar_dev` Zero-Mutation Immutability Fingerprint
`scripts/qa/verify-rg-15-gates.ts` uses `default_transaction_read_only=on` pools for all queries and explicit `BEGIN ... ROLLBACK` transactions for negative trigger/RLS/view probes, capturing a full database count & monetary aggregate fingerprint before `RG-01` and after `RG-15`:

- **Before === After Fingerprint (`liveDbZeroMutation=true`):**
  - `schema_migrations`: `124` (`latest_version = '0124'`, `checksum = 87cb14b666244679…`)
  - `payments`: `19` rows (`sum(default_amount) = 540000.00`)
  - `payment_instances`: `536` rows (`sum(amount) = 16080000.00`, `sum(paid_amount) = 167000.00`)
  - `checks`: preserved unchanged (`3` active `2026-08-31` `100,000 TRY` `Çağdaş` checks intact)
  - `control_alerts`, `approvals`, `ops_incidents`, `notification_outbox`, `reminder_deliveries`, `legal_entities`, `audit_logs`: **identical before and after execution (`0` persistent writes, `0` deletes)**.

---

## 3. Mandatory 16 Regression Scenarios — Phase B vs Phase F Matrix

Command executed:
```powershell
npx vitest run tests/remediation/mandatory-16-scenarios.test.ts
```
Output:
```text
 ✓ tests/remediation/mandatory-16-scenarios.test.ts (16 tests) 543ms
 Test Files  1 passed (1)
      Tests  16 passed (16)
   Duration  8.07s
Exit code: 0
```

| # | Scenario | Incidents | Phase B Baseline | Phase F Result | Verified Post-Remediation Behavior |
| :-: | :--- | :--- | :---: | :---: | :--- |
| **1** | **364-day & 400-day overdue loan escalation** | `I-006` | `FAIL` | **`PASS`** | Disjoint bucket matching classifies `364d` (`2025-11-19`) and `400d` (`2025-10-14`) overdue loans exclusively into `offsetDays = -31` (`31+`), never `-1` or `-8`, and `scheduleReminders` lookback (`3650d`) no longer drops `>365d` obligations. |
| **2** | **Day-30 vs Day-31 boundary & internal `31+` label** | `I-006`, Sec. 7 | `FAIL` | **`PASS`** | `30d` overdue (`2026-10-19` at `2026-11-18`) stays in `overdue_8_30`; `31d` (`2026-10-18`) enters `overdue_31_plus` with explicit `"31+ Gün Üst Eskalasyon (İç İnceleme)"` header (no `"30+"` ambiguity, no statutory `"Hukuki Eskalasyon"` claim). |
| **3** | **Repeated cron evaluation deduplication** | `I-007` | `PASS` (safeguard) | **`PASS`** | Deterministic `(reminder_id, entity_table, entity_id, scheduled_for)` + SHA-256 `computeNotificationIdempotencyKey` yields zero duplicate deliveries across repeated runs. |
| **4** | **Concurrent cron worker atomic claiming** | `I-007` | `FAIL` | **`PASS`** | `dispatchPending` claims due rows atomically via `FOR UPDATE SKIP LOCKED` (`status = 'claiming'`, `claim_token`); two concurrent workers invoke `transport.send` **at most once (`sent.length === 1`)**. |
| **5** | **Missing payment amount (`BLANK != ZERO`)** | `I-010`, `I-011` | `PASS` (safeguard) | **`PASS`** | `amount: null` stays `null` / `"TUTAR EKSİK"` / `"tutar eksik"`, never coerced to `0`, and increments `missingCount`. |
| **6** | **Partially paid obligation remaining exposure** | `I-012` | `FAIL` | **`PASS`** | For `original: 30,000`, `paid: 10,000`, `status: "partial"`, both `buildDailyReport` and `buildReminderMessage` compute overdue exposure as **`20,000 TL`** (never `30,000 TL`) while displaying `30.000 TL`, `10.000 TL`, and `20.000 TL`. |
| **7** | **Financial reconciliation & cancelled obligations** | `I-009` | `PASS` (safeguard) | **`PASS`** | `monthSummary` & `buildMonthlyReport` exclude cancelled rows from active `knownTotal` (`522,500 = 0 + 522,500`, `unexplainedGapTry = 0`) while disclosing `cancelledKnownTotal = 30,000`. |
| **8** | **DB outage fail-closed predicates & scheduler slot safety** | `I-001`, `I-004` | `FAIL` | **`PASS`** | `runtimeIdentityAlert`, `jobsStuckAlert("?")`, and `reconciliationAlert("?")` fail closed (`true`), and `runScheduledMaintenance` leaves `state.lastHourlySlot` **unstamped (`undefined`)** when sub-steps throw infrastructure errors. |
| **9** | **Missing off-device directory & sole-backup retention guard** | `I-003` | `FAIL` | **`PASS`** | `evaluateOffDeviceRunLog` alerts on `ENOENT` (`exitCode: 3`), `classifyOffDeviceTarget` rejects same-directory/same-volume targets, and `planPrune` **never deletes the last remaining verified `.dump`** regardless of age. |
| **10** | **Schema manifest version/count/checksum drift** | `I-002` | `PASS` (safeguard) | **`PASS`** | `checkSchemaParity` & `assertSchemaParity` detect `115/0115` vs head manifest drift (`aligned: false`) and `ledgerAlert` fires `true`. |
| **11** | **`Europe/Istanbul` cross-midnight boundary** | `I-008` | `PASS` (safeguard) | **`PASS`** | `2026-11-17T21:30:00Z` (`00:30` Istanbul) resolves via `istanbulDateISO` to `"2026-11-18"`, classifying `2026-11-18` as due today (`offset 0`) and `2026-11-21` as `+3d`. |
| **12** | **Non-destructive duplicate surfacing & review gate** | `I-011` | `PASS` (safeguard) | **`PASS`** | Multiple `Çağdaş` checks (`100,000 TRY`, `2026-08-31`) are never auto-merged, while `status = 'resolved'` (not `'accepted'`) `duplicate_check` reviews are excluded by `mapAcceptedChecks`. |
| **13** | **Incident lifecycle (`UNKNOWN`, `P2`, `SUPPRESSED`, `RESOLVED`)** | `I-005`, `I-013` | `FAIL` | **`PASS`** | `OPEN + "?"` transitions to `UNKNOWN` (never `RESOLVED`); initial `OK -> OPEN` `P2` emits `[OPEN][P2]`; `SUPPRESSED` mutes dispatch until expiry; `OPEN -> RESOLVED` attaches structured `resolutionEvidence`. |
| **14** | **Maker-checker approval gate & Telegram chat allowlist** | `I-015` | `PASS` (safeguard) | **`PASS`** | `sendTelegramChatMessage` blocks non-allowlisted `chatId` (`0` HTTP calls); unapproved `>= 100k TRY` outflow settlement and self-approval when `>= 2` active approvers exist throw `FORBIDDEN`. |
| **15** | **Single-pass Telegram HTML, `429 retry_after`, & `delivery_uncertain`** | `I-007`, `I-014` | `FAIL` | **`PASS`** | `escapeTelegramHtml` renders `[P1]`, `&`, `missing_amount` cleanly without `&#91;`, `&amp;amp;`, or `missing\_amount`; HTTP `429` parses `retryAfterSeconds: 17`; `TimeoutError` sets `uncertainOutcome: true` and `claimAndDispatchOutbox` transitions row to `'delivery_uncertain'`. |
| **16** | **Core functionality preservation** | Regression | `PASS` (safeguard) | **`PASS`** | `computeObligationAmounts`, `splitTelegramHtmlMessage` (`<= 3900` chars with balanced tags), and `redactSecrets` remain intact. |

---

## 4. All Specialist Remediation Suites (`agent01..agent10` + `mandatory-16`)

Command executed:
```powershell
npx vitest run tests/remediation/ --maxWorkers=1
```
Output:
```text
 ✓ tests/remediation/agent01-db-migrations.test.ts (5 tests) 29902ms
 ✓ tests/remediation/agent02-scheduler-health.test.ts (5 tests) 331ms
 ✓ tests/remediation/agent03-backup-dr.test.ts (6 tests) 1029ms
 ✓ tests/remediation/agent04-financial-reconciliation.test.ts (5 tests) 2476ms
 ✓ tests/remediation/agent05-temporal-escalation.test.ts (11 tests) 103ms
 ✓ tests/remediation/agent06-telegram-idempotency.test.ts (9 tests) 427ms
 ✓ tests/remediation/agent07-incident-lifecycle.test.ts (8 tests) 3251ms
 ✓ tests/remediation/agent08-cfo-reporting.test.ts (5 tests) 118ms
 ✓ tests/remediation/agent09-security-isolation.test.ts (10 tests) 5698ms
 ✓ tests/remediation/agent10-data-quality.test.ts (7 tests) 2474ms
 ✓ tests/remediation/mandatory-16-scenarios.test.ts (16 tests) 312ms

 Test Files  11 passed (11)
      Tests  87 passed (87)
   Duration  68.53s
Exit code: 0
```

---

## 5. Repository-Wide Static, Boundary, Database, DR Restore & Regression Command Evidence

| Check / Suite | Exact Command | Exit Code | Concrete Output Summary |
| :--- | :--- | :---: | :--- |
| **TypeScript Typecheck** | `pnpm typecheck` (`tsc --noEmit`) | **`0`** | `0` type errors across `src/`, `scripts/` (including `verify-rg-15-gates.ts`), and `tests/`. |
| **ESLint (`pnpm lint`)** | `pnpm lint` | **`0`** | `$ eslint` — **`0` errors and `0` warnings** across the entire repository (`src/`, `scripts/`, `tests/`). *(Two minor test lint items identified in initial QA pass at `agent06:678` and `agent09:59` were resolved and re-verified clean.)* |
| **Architecture Boundaries** | `pnpm boundary:verify` | **`0`** | `8/8 sınır kontrolü geçti. BOUNDARY VERIFY: ALL PASS`. |
| **Migration Numbering (Phase 17)** | `pnpm phase17:verify` | **`0`** | `9/9 kontrol geçti. PHASE17 VERIFY: ALL PASS` (`125` numeric migration files `0000..0124` verified). |
| **Schema Documentation (Phase 18)** | `pnpm phase18:verify` | **`0`** | `13/13 kontrol geçti. PHASE18 VERIFY: ALL PASS` (`docs/database-schema.md` covers `0022–0124`). |
| **PostgreSQL Runtime Roles & RLS** | `node --env-file=.env.local --import tsx scripts/db/roles-verify.ts` | **`0`** | `Hedef: db=mas_radar_dev user=mas_radar_app` — `8/8 kontrol geçti` (`NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, `SET LOCAL ROLE` switching, `schema_migrations` write blocked). |
| **Destructive Fixture Safety Guard** | `pnpm phase6b:verify` | **`1` (Safety Guard)** | `PostgreSQL hazır (native, 127.0.0.1:5432). GÜVENLİK DURDURMASI (phase6b:verify): MIGRATION_DATABASE_URL veya DATABASE_URL veya MAS_APP_DATABASE_URL tanımlı değil. Yıkıcı/fixture betikleri varsayılan veritabanına düşmez; harcanabilir bir hedef verin.` |
| **Core 9-File Vitest Regression** | `npx vitest run tests/security/write-gates.test.ts tests/security/local-passwordless-guard.test.ts tests/no-fabricated-figures.test.ts src/lib/reminders/rules.test.ts src/lib/reports/rules.test.ts src/lib/briefing/rules.test.ts src/lib/ops/alert-delivery.test.ts src/lib/ops/telemetry-alerts.test.ts tests/ops/telegram-and-background-worker.test.ts` | **`0`** | **`9 / 9` test files, `200 / 200` tests PASSED** (`write-gates`: `35/35`, `local-passwordless-guard`: `14/14`, `no-fabricated-figures`: `11/11`, `reminders/rules`: `33/33`, `reports/rules`: `21/21`, `briefing/rules`: `24/24`, `alert-delivery`: `25/25`, `telemetry-alerts`: `21/21`, `telegram-and-background-worker`: `16/16`). |
| **Fresh Isolated DR Restore Drill (`124/0124`)** | `node --env-file=.env.local --import tsx scripts/ops/verify-restore-drill-fast.ts` | **`0`** | `FAST RESTORE DRILL: PASS (71898ms · 124/0124 · 132 RLS tablo)` — Created `backups/dr-verify-2026-11-18T19-28-02-244Z.dump` (`2.0 MB`, `sha256=dfbc6933f3651311…`, `TOC=2354`), restored into disposable `mas_radar_dr_verify_test`, verified `124/0124` + `132/132` RLS + row/monetary parity + `mas_radar_app` parity, dropped `mas_radar_dr_verify_test`, and updated `backups/latest-restore-drill.json` to `124/0124`. |
| **15 Canonical Release Gates Harness** | `node --env-file=.env.local --import tsx scripts/qa/verify-rg-15-gates.ts` | **`2` (`BLOCKED`)** | `PASS: 14 | BLOCKED: 1 (RG-03) | FAIL: 0 | NOT VERIFIED: 0 (Total: 15)` · `liveDbZeroMutation=true`. |
| **TestSprite CLI Preflight** | `testsprite --version` & `testsprite auth whoami` | **`0`** | CLI `0.3.0` authenticated (`projectId=9e441666-c537-48fb-8f5f-e3608718a347`); remote cloud run skipped per `AGENTS.md` because Next.js runs on `127.0.0.1:3000` only and ephemeral tunnel `intervals-murphy-ultimately-levitra.trycloudflare.com` is offline (`TUNNEL_DOWN`). |

---

## 6. Canonical 15 Release Gates Verification Table (`RG-01 .. RG-15`, Section 8)

Executed via [`scripts/qa/verify-rg-15-gates.ts`](../../scripts/qa/verify-rg-15-gates.ts) against live `mas_radar_dev`:

| Gate | Canonical Release Gate (Section 8) | Incidents | Status | Concrete Measured Evidence |
| :--- | :--- | :--- | :---: | :--- |
| **`RG-01`** | **Database reliability** | `I-001` | **`PASS`** | `db=mas_radar_dev user=mas_radar_app super=false bypassrls=false inherit=false RLS=132/132 invokerViews=91/91 writableViews=0 ledgerWrite42501=true failClosedPredicates=true` |
| **`RG-02`** | **Schema consistency** | `I-002` | **`PASS`** | `aligned=true ledger=124/0124 expected=124/0124 checksum=87cb14b666244679… driftBlocked=true` |
| **`RG-03`** | **Backup recoverability** | `I-003` | **`BLOCKED`** | `localDumpAndIsolatedRestore=VERIFIED (ledger=124/0124, sha256=dfbc6933f365…, rls=132/132, dropped=true)` · `offDeviceTooling=VERIFIED` · **`physicalOffDeviceTarget=BLOCKED`** (`target='D:\MAS-Backups\mas_radar_dev'`, `exists=false`, `offDeviceSatisfied=false`) |
| **`RG-04`** | **Financial correctness** | `I-009` | **`PASS`** | `allMonthsZeroGap=true` (`2026-06..2026-12`) · `2026-11(known=510000, rem=510000, cancelled=30000)` · `2026-06(known=490000, paid=155000, rem=335000, cancelled=50000)` |
| **`RG-05`** | **Payment accuracy** | `I-012` | **`PASS`** | `liveRow0fbd2b5b(orig=30000, paid=12000, rem=18000)` · `scenario6DailyOverdue=20000` · `triValueDisplayed=true` (`30.000 TL` / `10.000 TL` / `20.000 TL`) |
| **`RG-06`** | **Temporal correctness** | `I-006`, `I-008` | **`PASS`** | `istanbulDate(21:30Z)=2026-11-18 day30=overdue_8_30 day31Label='31+ Gün Üst Eskalasyon (İç İnceleme)' 364dMatchedRules=[r31] dbMinus31RulesClean=true` |
| **`RG-07`** | **Notification deduplication** | `I-007`, `I-014` | **`PASS`** | `dbOutboxUnique=true concurrentWorkerSends=1 retryAfter429=17s outboxHold='delivery_uncertain' singlePassHtml=true balancedChunks=2 secretLeaks=0` |
| **`RG-08`** | **Incident lifecycle** | `I-005`, `I-013` | **`PASS`** | `blindTransition=UNKNOWN initialP2Emitted=true resolvedState=RESOLVED resolutionEvidenceKeys=[whatChanged,verifiedByCheck,verifiedAtISO,measuredValue,evidenceSource] dbSuppressedConstraint=true` |
| **`RG-09`** | **Data-quality transparency** | `I-005`, `I-010`, `I-011` | **`PASS`** | `blankStaysNull=true validImportAgeDays=124 (emptyFailedExcluded=true) · zeroJoinMult=true novActive=17 activeCagdasChecks=3 resolvedDupExcluded=1` |
| **`RG-10`** | **CFO report reliability** | `I-010` | **`PASS`** | `bank102Subledger=null consolidatedCash=null bankFeedFlows=null confidenceGrade=UNVERIFIED_CASH_BASIS reproducibleSha256=true (a08a77413e4c…)` |
| **`RG-11`** | **Authorization safety** | `I-015` | **`PASS`** | `historical33adOpen=true appForbidden=true dbTrigger42501=true selfApprovalBlocked=true ibanMod97=true crossTenantLeaks=0 chatBlocked=true` |
| **`RG-12`** | **Regression safety** | All (`I-001..I-016`) | **`PASS`** | `mandatory16=16/16 PASS` · `remediationSuites=87/87 PASS` · `coreRegression=200/200 PASS` · `tsc=PASS` · `eslint=PASS` |
| **`RG-13`** | **Runtime health** | `I-004` | **`PASS`** | `ready=200 health=200 (roleSafe=true, parity=0124)` · `liveHttp(ready=200, health=200)` · `hourlySlotUnstampedOnOutage=true` |
| **`RG-14`** | **Environment isolation** | `I-016` | **`PASS`** | `prodPasswordlessHardBlocked=true loopbackHostGuard=true disposableDbGuardBlocksDevProd=true lineageClassificationMutations=0` |
| **`RG-15`** | **Evidence integrity** | All (`I-001..I-016`) | **`PASS`** | `phaseBTestUntouched=true (sha256=819369DD92B5…)` · `boundary=8/8 PASS` · `drillReceiptAndSha256=VERIFIED` · `liveDbZeroMutation=true` |

---

## 7. Single Remaining External Infrastructure Step to Reach `15 / 15 PASS`

1. **Mount Physical Off-Device Backup Volume (`RG-03`):**
   - Connect and mount physical external drive `D:\` (`D:\MAS-Backups\mas_radar_dev`) — or configure `MAS_OFFDEVICE_BACKUP_DIR` to an independent physical volume / network share distinct from `C:\`.
   - Execute `pnpm ops:backup:offdevice` and verify `backups/latest-offdevice-sync.json` records `exitCode: 0`, `offDeviceSatisfied: true`, and verified SHA-256 + `pg_restore --list` parity on the external device.
2. **Final Sign-Off Verification:**
   - Re-run `node --env-file=.env.local --import tsx scripts/qa/verify-rg-15-gates.ts` and confirm `PASS: 15 | BLOCKED: 0 | FAIL: 0 | NOT VERIFIED: 0` (`exit 0`).
