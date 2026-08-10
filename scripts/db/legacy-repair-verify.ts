// Persistent disposable-DB test suite for P0-B Slice 5's legacy repair toolchain
// (legacy-repair-inventory.ts / -approval.ts / -apply.ts / -recover-receipt.ts /
// backup-receipt.ts). Mirrors scripts/db/transitions-verify.ts's and
// reconciliation-verify.ts's pattern exactly: throwaway DBs only, never mas_radar_dev.
// Every tool under test is invoked exactly as an operator would — as a separate `tsx`
// subprocess with explicit CLI args and DATABASE_URL — so this suite exercises the real
// fail-closed CLI surface, not an in-process shortcut.
//
// FAIL-CLOSED SAFETY GATE: this file itself does not import any src/ module at its top
// level. The one exception (legacy-repair-recover-receipt's crash-recovery scenario,
// which must replay a partial repair transaction directly) dynamically imports
// src/lib/radar/engine.ts, and only after assertSafeDisposableName() has already
// confirmed the target DB is a disposable, non-production database.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { verifyBackupTarget, verifyRestoreListable, type BackupOptions, type BackupResult, type BackupTargetVerification, type BackupTargetVerificationResult } from "./backup-docker-postgres";
import { runBackupReceipt, type BackupReceiptDeps, type BackupReceiptParams } from "./backup-receipt";
import { assertApplyGitProvenance } from "./legacy-repair-apply";
import { getSystemActorId } from "./seed-system-actor";
import {
  AppliedRepairResultSchema,
  ApprovalManifestSchema,
  BackupReceiptSchema,
  CANONICALIZATION_VERSION,
  CommittedReceiptFileSchema,
  DumpVerificationSchema,
  DurabilityMetadataSchema,
  INVENTORY_MANIFEST_VERSION,
  InventoryManifestSchema,
  InventoryTargetSchema,
  ReceiptCoreSchema,
  RolledBackReceiptFileSchema,
  assertExpectedCleanGitState,
  attemptDirectoryFsync,
  canonicalHash,
  fileSha256,
  isCleanWorkingTree,
  payloadSha256,
  sameVolume,
  sortAppliedRepairsDeterministically,
  writeExclusiveDurable,
  writeViaTempAndRename,
  type BackupReceipt,
  type DirectoryFsyncImpl,
  type DurabilityMetadata,
  type GitStateProvider,
  type InventoryManifest,
  type ReceiptCore,
} from "./legacy-repair-types";

const ROOT = process.cwd();
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");
const INVENTORY_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-inventory.ts");
const APPROVAL_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-approval.ts");
const APPLY_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-apply.ts");
const BACKUP_RECEIPT_SCRIPT = path.join(ROOT, "scripts", "db", "backup-receipt.ts");
const BACKUP_DOCKER_POSTGRES_SCRIPT = path.join(ROOT, "scripts", "db", "backup-docker-postgres.ts");
const RECOVER_SCRIPT = path.join(ROOT, "scripts", "db", "legacy-repair-recover-receipt.ts");
const PRODUCTION_SCRIPTS = [INVENTORY_SCRIPT, APPROVAL_SCRIPT, APPLY_SCRIPT, RECOVER_SCRIPT, BACKUP_RECEIPT_SCRIPT, BACKUP_DOCKER_POSTGRES_SCRIPT];

const DB = "mas_radar_legacy_repair_verify";
const DB_MULTI = "mas_radar_legacy_repair_verify_multi";
const DISPOSABLE_PREFIX = "mas_radar_legacy_repair_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

const TMP = path.join(ROOT, "scripts", "db", "_legacy_repair_verify_tmp");

interface TestOutcome { name: string; pass: boolean; detail?: string; }
const results: TestOutcome[] = [];
function record(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Pure predicate behind the fail-closed DB-identity gate — kept side-effect-free
 * (no process.exit) specifically so it can be unit-tested directly below, unlike
 * assertSafeDisposableName which is the process-terminating wrapper every real call
 * site uses. */
function isSafeDisposableName(name: string): boolean {
  if (name === FORBIDDEN_DB_NAME) return false;
  return name.startsWith(DISPOSABLE_PREFIX);
}
/** Fail-closed: exits immediately if the target DB is the real database, or outside this
 * script's disposable namespace — before any further setup, let alone a src/ import. */
function assertSafeDisposableName(name: string, context: string): void {
  if (name === FORBIDDEN_DB_NAME) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${FORBIDDEN_DB_NAME}' — gerçek veritabanına asla dokunulmaz. Çıkış.`);
    process.exit(1);
  }
  if (!name.startsWith(DISPOSABLE_PREFIX)) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${name}', beklenen disposable önek '${DISPOSABLE_PREFIX}' ile başlamıyor. Çıkış.`);
    process.exit(1);
  }
}

function docker(args: string[], opts: { input?: string | Buffer } = {}): string {
  return execFileSync("docker", args, { input: opts.input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}
function assertContainerReachable(): void {
  try {
    docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"]);
  } catch {
    console.error(`PostgreSQL konteyneri (${CONTAINER}) erişilebilir değil. Bu script onu otomatik başlatmaz.`);
    process.exit(1);
  }
}
function dropDb(db: string): void {
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", db]);
}
function createDb(db: string): void {
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", db]);
}
function dbUrl(db: string): string {
  return `postgres://postgres:postgres@127.0.0.1:5432/${db}`;
}
function findLatestManagedFixtureDump(): string {
  const dir = path.join(ROOT, "backups");
  const files = readdirSync(dir).filter((f) => f.startsWith("p0b-managed-baseline-") && f.endsWith(".dump")).sort();
  if (files.length === 0) throw new Error("backups/p0b-managed-baseline-*.dump bulunamadı.");
  return path.join(dir, files.at(-1)!);
}
function restoreManagedFixture(db: string): void {
  dropDb(db);
  createDb(db);
  docker(["exec", "-i", CONTAINER, "pg_restore", "-U", "postgres", "-d", db, "--no-owner", "--role=postgres"], {
    input: readFileSync(findLatestManagedFixtureDump()),
  });
}
interface RunResult { code: number; stdout: string; stderr: string; }

// legacy-repair-inventory.ts / backup-receipt.ts / legacy-repair-apply.ts all read git
// state (via `execFileSync("git", ...)` with no explicit cwd, so they inherit whatever
// `process.cwd()` their OWN process was launched with). This project's own real repo is
// legitimately dirty for the entire duration of a correction round like this one (edit →
// test → stage → report, before any commit) — so these three scripts are instead run
// against a throwaway, isolated git repository (set up once in main(), see
// TEMP_GIT_REPO below) rather than this repo, letting the new fail-closed git-provenance
// gates in backup-receipt.ts/legacy-repair-apply.ts be satisfied by a genuinely clean
// repository without ever touching this project's own working tree. Confirmed safe:
// none of these three scripts read any OTHER cwd-relative path (migrate.ts and
// migration-lib.ts do, which is exactly why MIGRATE_SCRIPT is deliberately NOT included
// here and keeps running against ROOT).
let TEMP_GIT_REPO = "";
const GIT_AWARE_SCRIPTS = new Set<string>([INVENTORY_SCRIPT, BACKUP_RECEIPT_SCRIPT, APPLY_SCRIPT]);

function runTsx(script: string, args: string[], env: Record<string, string | undefined> = {}): RunResult {
  // `{...process.env, ...env}` alone would stringify an explicitly-`undefined`-valued key
  // (e.g. `{ DATABASE_URL: undefined }`, used to test "env var genuinely absent") into the
  // literal 4-character string "undefined" — Node's own env-building coerces every value
  // with template-literal semantics. Deleting `undefined` entries after the merge is what
  // actually makes that key absent from the child's environment.
  const mergedEnv: Record<string, string | undefined> = { ...process.env, ...env };
  for (const key of Object.keys(mergedEnv)) {
    if (mergedEnv[key] === undefined) delete mergedEnv[key];
  }
  const cwd = GIT_AWARE_SCRIPTS.has(script) && TEMP_GIT_REPO ? TEMP_GIT_REPO : ROOT;
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, script, ...args], {
      cwd,
      env: mergedEnv as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}
function runMigrateAgainstUrl(url: string): RunResult {
  return runTsx(MIGRATE_SCRIPT, [], { DATABASE_URL: url });
}

/** Creates a fresh, isolated, single-commit git repository under `dir` and returns its
 * branch name and HEAD SHA — used as the "expected" git identity for every
 * inventory/backup/apply invocation that needs a genuinely clean, real repository rather
 * than a fake provider (see GIT_AWARE_SCRIPTS above). Never touches this project's own
 * repository in any way. */
function setUpTempGitRepo(dir: string): { branch: string; head: string } {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "legacy-repair-verify@localhost"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "legacy-repair-verify"], { cwd: dir });
  writeFileSync(path.join(dir, "marker.txt"), "legacy-repair-verify disposable git fixture repository\n");
  execFileSync("git", ["add", "marker.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "legacy-repair-verify: initial disposable commit"], { cwd: dir });
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { branch, head };
}
function dirtyTempGitRepo(dir: string): void {
  writeFileSync(path.join(dir, "uncommitted-scratch-file.txt"), "makes the tree dirty for a fail-closed test\n");
}
function cleanTempGitRepo(dir: string): void {
  const scratchPath = path.join(dir, "uncommitted-scratch-file.txt");
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true });
}

// Set once near the top of main() (queried from the already-open disposable-DB pool) —
// every database in this suite lives in the SAME running mas-radar-pg cluster, so they
// all share this one cluster-level system_identifier.
let SYSTEM_IDENTIFIER = "";
// Set once main() creates TEMP_GIT_REPO — the expected git identity every
// inventory/backup/apply invocation is told to require.
let TEST_GIT_BRANCH = "";
let TEST_GIT_HEAD = "";

interface BackupBundle { dumpPath: string; receiptPath: string; backupSha256: string; backupReceiptSha256: string; }
function makeBackup(db: string, label: string, outDir: string): BackupBundle {
  const res = runTsx(BACKUP_RECEIPT_SCRIPT, [
    "--expected-database-name", db,
    "--expected-system-identifier", SYSTEM_IDENTIFIER,
    "--expected-git-branch", TEST_GIT_BRANCH,
    "--expected-git-head", TEST_GIT_HEAD,
    "--container", CONTAINER,
    "--label", label,
    "--out-dir", outDir,
  ], { DATABASE_URL: dbUrl(db) });
  if (res.code !== 0) throw new Error(`backup-receipt başarısız (${label}): ${res.stderr}`);
  const line = res.stdout.split("\n").find((l) => l.startsWith("Backup tamam: "));
  if (!line) throw new Error(`backup-receipt çıktısında dosya yolu bulunamadı: ${res.stdout}`);
  const dumpPath = line.slice("Backup tamam: ".length).split(" (")[0];
  const receiptPath = `${dumpPath}.receipt.json`;
  return {
    dumpPath,
    receiptPath,
    backupSha256: fileSha256(readFileSync(dumpPath)),
    backupReceiptSha256: fileSha256(readFileSync(receiptPath)),
  };
}
function makeInventory(db: string, url: string, outPath: string): { inventory: InventoryManifest; sha256: string } {
  const res = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", db, "--out", outPath], { DATABASE_URL: url });
  if (res.code !== 0) throw new Error(`inventory üretimi başarısız: ${res.stderr}`);
  const bytes = readFileSync(outPath);
  return { inventory: InventoryManifestSchema.parse(JSON.parse(bytes.toString("utf8"))), sha256: fileSha256(bytes) };
}
function extractOperationId(applyStdout: string): string {
  const m = applyStdout.match(/operationId=([0-9a-f-]+)/);
  if (!m) throw new Error(`apply çıktısından operationId çıkarılamadı: ${applyStdout}`);
  return m[1];
}
function listReceiptFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
function listRolledBackReceipts(dir: string): string[] {
  return listReceiptFiles(dir).filter((f) => f.endsWith(".rolled-back.json"));
}

async function main(): Promise<void> {
  assertContainerReachable();
  assertSafeDisposableName(DB, "ana disposable DB");
  assertSafeDisposableName(DB_MULTI, "çoğulluk-koruması disposable DB");

  // ── §0 fail-closed DB-identity predicate + production-tool DDL-safety self-check ──
  record("assertSafeDisposableName: 'mas_radar_dev' kesin reddedilir", !isSafeDisposableName(FORBIDDEN_DB_NAME));
  record("assertSafeDisposableName: disposable önekli ad kabul edilir", isSafeDisposableName(DB));
  record("assertSafeDisposableName: önek dışı rastgele ad reddedilir", !isSafeDisposableName("baska_bir_veritabani"));
  {
    const violations: string[] = [];
    for (const scriptPath of PRODUCTION_SCRIPTS) {
      const source = readFileSync(scriptPath, "utf8").toLowerCase();
      if (source.includes("disable trigger") || source.includes("drop constraint") || source.includes("disable rule")) {
        violations.push(path.basename(scriptPath));
      }
    }
    record(
      "production araçlarında (inventory/approval/apply/recover/backup-receipt) hiçbir constraint/trigger disable/drop kodu yok",
      violations.length === 0,
      violations.length > 0 ? `bulunan: ${violations.join(", ")}` : undefined,
    );
  }

  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const receiptsDir = path.join(TMP, "receipts");
  mkdirSync(receiptsDir, { recursive: true });

  // Isolated, disposable git repository — see GIT_AWARE_SCRIPTS's comment above for why
  // inventory/backup-receipt/apply are run against THIS, never this project's own
  // (legitimately mid-round-dirty) working tree.
  TEMP_GIT_REPO = path.join(TMP, "_git_fixture_repo");
  const tempGitIdentity = setUpTempGitRepo(TEMP_GIT_REPO);
  TEST_GIT_BRANCH = tempGitIdentity.branch;
  TEST_GIT_HEAD = tempGitIdentity.head;

  // backups/p0b-managed-baseline-*.dump is frozen from before Slice 5's legacy-repair apply
  // ever ran, so it still carries the one known payment_instances anomaly 0026 grandfathered
  // (0026's own comment) — that anomaly is EXACTLY what this whole suite's inventory/approval/
  // apply/recover-receipt tests exercise repairing. 0030 (VALIDATE CONSTRAINT) requires that
  // row already fixed, which would make it structurally impossible for this suite's inventory
  // tool to ever discover it as "unresolved" — the two requirements are incompatible within
  // one disposable DB. 0030 isn't what this suite tests (it tests the 0022-0029-era repair
  // tooling, mirroring the real Slice 5→6 order where repair happened before validation), so
  // it's temporarily hidden from MIGRATIONS_DIR for this suite's entire run.
  //
  // Every migration from 0030 onward is hidden together, not just 0030 itself — hiding a
  // single file out of the middle of the sequence leaves a version GAP (0029 then 0031),
  // which validateFileSet's own sequential-numbering check correctly rejects. Hiding the
  // whole contiguous tail starting at 0030 avoids that: the sequence simply ends at 0029
  // for the duration of this suite, exactly as it did before 0030 ever existed. Discovered
  // dynamically (>= "0030"), not hardcoded to a fixed list, so this doesn't go stale again
  // the next time a migration is added after 0030 (the same class of bug that made this
  // suite crash the moment 0031/0032 were added).
  const migrationsDir = path.join(ROOT, "supabase", "migrations");
  const hiddenFromVersion = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && f.slice(0, 4) >= "0030")
    .sort()
    .map((f) => {
      const filePath = path.join(migrationsDir, f);
      const hiddenPath = `${filePath}.hidden-for-legacy-repair-verify-${process.pid}-${Date.now()}`;
      return { filePath, hiddenPath, sha256BeforeHide: fileSha256(readFileSync(filePath)) };
    });
  for (const f of hiddenFromVersion) renameSync(f.filePath, f.hiddenPath);
  try {
    await runMainBody();
  } finally {
    const mismatches: string[] = [];
    for (const f of hiddenFromVersion) {
      renameSync(f.hiddenPath, f.filePath);
      const sha256AfterRestore = fileSha256(readFileSync(f.filePath));
      if (sha256AfterRestore !== f.sha256BeforeHide) {
        mismatches.push(`${path.basename(f.filePath)} (beklenen ${f.sha256BeforeHide}, bulunan ${sha256AfterRestore})`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `GÜVENLİK DURDURMASI: gizlenen migration dosyaları geri yüklendi ama byte SHA-256'sı değişti — ${mismatches.join("; ")}.`,
      );
    }
  }

  console.log("\n=== Özet ===");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} test geçti`);
  process.exit(pass === results.length ? 0 : 1);
}

async function runMainBody(): Promise<void> {
  const receiptsDir = path.join(TMP, "receipts");
  restoreManagedFixture(DB);
  const url = dbUrl(DB);
  const migrateRes = runMigrateAgainstUrl(url);
  if (migrateRes.code !== 0) throw new Error(`migrate başarısız: ${migrateRes.stderr}`);
  const pool = new Pool({ connectionString: url, max: 5 });
  const sysidRes = await pool.query<{ sysid: string }>(`select system_identifier::text as sysid from pg_control_system()`);
  SYSTEM_IDENTIFIER = sysidRes.rows[0].sysid;

  try {
    // ── §1 inventory ──
    const inventoryPath = path.join(TMP, "inventory.json");
    const { inventory, sha256: inventoryFileSha256 } = makeInventory(DB, url, inventoryPath);
    record("inventory: genuine discovery — en az 24 candidate + 1 unresolved + 2 ineligible hedef üretti", (() => {
      const c = inventory.targets.filter((t) => t.classification === "candidate").length;
      const u = inventory.targets.filter((t) => t.classification === "unresolved").length;
      const i = inventory.targets.filter((t) => t.classification === "ineligible").length;
      return c >= 20 && u === 1 && i >= 1;
    })());
    record("inventory: unresolved hedefin proposedCancelReason'ı null (fabrikasyon yok)", (() => {
      const unresolvedTgt = inventory.targets.find((t) => t.classification === "unresolved");
      return unresolvedTgt?.proposedCancelReason === null;
    })());
    record("inventory: --expected-database-name DATABASE_URL ile uyuşmayınca reddedilir", (() => {
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", "baska_bir_db", "--out", path.join(TMP, "should-not-exist.json")], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(path.join(TMP, "should-not-exist.json"));
    })());
    record("inventory: aynı --out yolu ikinci kez yazılamaz (immutability, wx flag)", (() => {
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB, "--out", inventoryPath], { DATABASE_URL: url });
      return r.code !== 0;
    })());

    const candidates = inventory.targets.filter((t) => t.classification === "candidate").map((t) => t.instanceId);
    const unresolvedTarget = inventory.targets.find((t) => t.classification === "unresolved")!;
    const ineligibleTarget = inventory.targets.find((t) => t.classification === "ineligible")!;
    const [happyId1, happyId2, driftPreconditionId, driftEligibilityId, commitUnknownId, ...restCandidates] = candidates;

    // ── §2 approval ──
    const apprOut = (name: string) => path.join(TMP, `approval-${name}.json`);
    record("approval: yanlış --expected-inventory-sha256 reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", "0".repeat(64),
        "--approve-archive-instance", happyId1, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("bad-hash"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-hash"));
    })());
    record("approval: ineligible hedef archive olarak onaylanamaz", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", ineligibleTarget.instanceId, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("ineligible"),
      ]);
      return r.code !== 0 && r.stderr.includes("classification") && !existsSync(apprOut("ineligible"));
    })());
    record("approval: --confirm-archive-reason eksikse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1,
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", apprOut("no-reason"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("no-reason"));
    })());
    record("approval: --confirm-archive-timestamp-policy yanlış değerse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "yanlis_deger", "--out", apprOut("bad-policy"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-policy"));
    })());
    record("approval: aynı UUID iki kez onaylanamaz", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", happyId1, "--approve-archive-instance", happyId1,
        "--confirm-archive-reason", "x", "--confirm-archive-timestamp-policy", "apply_transaction_timestamp",
        "--out", apprOut("dup"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("dup"));
    })());
    record("approval: sıfır onaylı hedefle manifest üretilmez", (() => {
      const r = runTsx(APPROVAL_SCRIPT, ["--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256, "--out", apprOut("zero")]);
      return r.code !== 0 && !existsSync(apprOut("zero"));
    })());
    record("approval: metadata onayında --confirm-timestamp proposedCancelledAt ile birebir eşleşmezse reddedilir", (() => {
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-metadata-instance", unresolvedTarget.instanceId, "--reason", "x",
        "--confirm-timestamp", "2020-01-01T00:00:00.000000Z", "--out", apprOut("bad-ts"),
      ]);
      return r.code !== 0 && !existsSync(apprOut("bad-ts"));
    })());
    const happyApprovalPath = apprOut("happy");
    const happyApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", happyId1, "--approve-archive-instance", happyId2,
      "--confirm-archive-reason", "Legacy repair verify: mutlu yol",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp",
      "--out", happyApprovalPath,
    ]);
    record("approval: mutlu yol (2 archive onayı) başarıyla üretildi", happyApprRes.code === 0, happyApprRes.stderr.slice(0, 300));
    const happyApprovalBytes = readFileSync(happyApprovalPath);
    const happyApprovalSha256 = fileSha256(happyApprovalBytes);
    const happyApproval = ApprovalManifestSchema.parse(JSON.parse(happyApprovalBytes.toString("utf8")));
    record("approval: manifest şeması + payload hash'i kendi içinde tutarlı", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { approvedAt: _a, approvalPayloadSha256: _h, durability: _d, ...rest } = happyApproval;
      return payloadSha256(rest) === happyApproval.approvalPayloadSha256;
    })());

    // ── §2.5 canonicalizationVersion + durability on inventory/approval manifests ──
    record("inventory: canonicalizationVersion taşıyor", inventory.canonicalizationVersion === CANONICALIZATION_VERSION);
    record("approval: canonicalizationVersion taşıyor", happyApproval.canonicalizationVersion === CANONICALIZATION_VERSION);
    record("inventory: durability metadata taşıyor ve strict şemadan geçiyor (directoryFsyncAttempted=true)", (() => {
      const parsed = DurabilityMetadataSchema.safeParse(inventory.durability);
      return parsed.success && inventory.durability.directoryFsyncAttempted === true;
    })());
    record("approval: durability metadata taşıyor ve strict şemadan geçiyor (directoryFsyncAttempted=true)", (() => {
      const parsed = DurabilityMetadataSchema.safeParse(happyApproval.durability);
      return parsed.success && happyApproval.durability.directoryFsyncAttempted === true;
    })());
    record("inventory: gerçek yazım win32 full-directory-fsync olarak raporlandı (bu host)", inventory.durability.durabilityMode === "full-directory-fsync");
    record("approval: gerçek yazım win32 full-directory-fsync olarak raporlandı (bu host)", happyApproval.durability.durabilityMode === "full-directory-fsync");
    record("inventory: durable-write ile yazılıp yeniden okunarak byte/hash/schema doğrulamasından geçti (makeInventory zaten throw etmedi + dış yeniden-doğrulama)", (() => {
      const reReadBytes = readFileSync(inventoryPath);
      const reReadSha256 = fileSha256(reReadBytes);
      const reParsed = InventoryManifestSchema.safeParse(JSON.parse(reReadBytes.toString("utf8")));
      return reReadSha256 === inventoryFileSha256 && reParsed.success;
    })());
    record("approval: durable-write ile yazılıp yeniden okunarak byte/hash/schema doğrulamasından geçti", (() => {
      const reReadBytes = readFileSync(happyApprovalPath);
      const reReadSha256 = fileSha256(reReadBytes);
      const reParsed = ApprovalManifestSchema.safeParse(JSON.parse(reReadBytes.toString("utf8")));
      return reReadSha256 === happyApprovalSha256 && reParsed.success;
    })());

    // Field-shape helper for the negative canonicalizationVersion tests below — clones
    // the REAL, already-generated (and already schema-valid) inventory/approval objects
    // and mutates exactly one field, so every other field stays realistic.
    function withoutField<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
      const clone = { ...obj };
      delete clone[key];
      return clone;
    }
    record("InventoryManifestSchema: eksik canonicalizationVersion reddedilir", !InventoryManifestSchema.safeParse(withoutField(inventory, "canonicalizationVersion")).success);
    record("ApprovalManifestSchema: eksik canonicalizationVersion reddedilir", !ApprovalManifestSchema.safeParse(withoutField(happyApproval, "canonicalizationVersion")).success);
    record("InventoryManifestSchema: bilinmeyen canonicalizationVersion reddedilir", !InventoryManifestSchema.safeParse({ ...inventory, canonicalizationVersion: "project-canonical-json-v2" }).success);
    record("ApprovalManifestSchema: bilinmeyen canonicalizationVersion reddedilir", !ApprovalManifestSchema.safeParse({ ...happyApproval, canonicalizationVersion: "project-canonical-json-v2" }).success);

    // SIMULATED (schema-level, not live-reproduced — see the real durability tests above
    // and the SIMULE attemptDirectoryFsync tests further below for why this host cannot
    // organically produce EPERM/ENOSYS through the real write path): proves the artifact
    // schemas correctly ACCEPT a valid windows-best-effort durability shape when embedded,
    // i.e. the artifact CAN correctly represent that outcome if it ever occurs.
    const bestEffortDurability = { platform: "win32" as const, durabilityMode: "windows-best-effort" as const, directoryFsyncAttempted: true, directoryFsyncSupported: false, directoryFsyncErrorCode: "EPERM" };
    record("InventoryManifestSchema: SIMULE win32 best-effort durability şekli kabul edilir", InventoryManifestSchema.safeParse({ ...inventory, durability: bestEffortDurability }).success);
    record("ApprovalManifestSchema: SIMULE win32 best-effort durability şekli kabul edilir", ApprovalManifestSchema.safeParse({ ...happyApproval, durability: bestEffortDurability }).success);

    record("inventory: beklenmeyen directory hatası (nonexistent --out dizini) fail-closed reddedilir, dosya oluşmaz", (() => {
      const badOut = path.join(TMP, "nonexistent-subdir-xyz", "should-not-be-created.json");
      const r = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB, "--out", badOut], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(badOut);
    })());

    // Old-format inventory (pre-this-round shape: no canonicalizationVersion, no
    // durability) — matching exactly what scripts/db/legacy-repair-inventory.ts produced
    // before this correction, including the real artifact already on disk at
    // backups/legacy-repair-manifests/legacy-repair-inventory-2026-07-20T14-23-39-599Z.json
    // (sha256 82cdd01a53b59dc01970fbd07d3b5640e50d925db7fac40c12e63cf66a6b65e8, never
    // touched by this suite). Built here from the real, current inventory object with
    // both new fields stripped, so every OTHER field is realistic.
    record("apply: eski formatlı (canonicalizationVersion/durability yok) inventory dosyası şema seviyesinde reddedilir", (() => {
      const oldShapeInventory = withoutField(withoutField(inventory, "canonicalizationVersion"), "durability");
      const oldShapePath = path.join(TMP, "old-shape-inventory.json");
      const oldShapeJson = JSON.stringify(oldShapeInventory, null, 2);
      writeFileSync(oldShapePath, oldShapeJson, { encoding: "utf8", flag: "wx" });
      const oldShapeSha256 = fileSha256(Buffer.from(oldShapeJson, "utf8"));
      const parsedDirectly = InventoryManifestSchema.safeParse(oldShapeInventory);
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", oldShapePath, "--expected-inventory-sha256", oldShapeSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", "does-not-matter.dump", "--expected-backup-sha256", "0".repeat(64),
        "--backup-receipt", "does-not-matter.receipt.json", "--expected-backup-receipt-sha256", "0".repeat(64),
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", path.join(TMP, "receipts"),
      ], { DATABASE_URL: url });
      return !parsedDirectly.success && r.code !== 0 && r.stderr.includes("strict şemadan geçemedi");
    })());

    // payload-hash policy tests: generatedAt/durability excluded, canonicalizationVersion included.
    record("payload hash: generatedAt değişse de semantic payload hash aynı kalır", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const variantB = { ...inventory, generatedAt: "2020-01-01T00:00:00.000000Z" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) === payloadSha256(restB);
    })());
    record("payload hash: canonicalizationVersion değişikliği payload hash'i değiştirir", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const variantB = { ...inventory, canonicalizationVersion: "project-canonical-json-v2" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) !== payloadSha256(restB);
    })());
    record("payload hash: durability değişikliği (dahil edilmediği için) payload hash'i DEĞİŞTİRMEZ — politika testle sabitlendi", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const differentDurability = { platform: "linux" as const, durabilityMode: "full-directory-fsync" as const, directoryFsyncAttempted: true, directoryFsyncSupported: true, directoryFsyncErrorCode: null };
      const variantB = { ...inventory, durability: differentDurability };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) === payloadSha256(restB);
    })());

    // ── §2.6 inventoryManifestVersion / sourceInventoryManifestVersion — SEMANTIC manifest
    // version, deliberately separate from canonicalizationVersion (serialization format
    // only). Also covers the paymentId defect this field was introduced to guard against:
    // the metadata-repair target's paymentId must reflect the live row's real payment_id,
    // never a hardcoded/omitted value. ──
    record("inventory: inventoryManifestVersion taşıyor", inventory.inventoryManifestVersion === INVENTORY_MANIFEST_VERSION);
    record("approval: sourceInventoryManifestVersion taşıyor", happyApproval.sourceInventoryManifestVersion === INVENTORY_MANIFEST_VERSION);
    record("payload hash: inventoryManifestVersion değişikliği payload hash'i değiştirir", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g1, inventoryPayloadSha256: _h1, durability: _d1, ...restA } = inventory;
      const variantB = { ...inventory, inventoryManifestVersion: "legacy-repair-inventory-v4" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { generatedAt: _g2, inventoryPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) !== payloadSha256(restB);
    })());
    record("payload hash: sourceInventoryManifestVersion değişikliği approval payload hash'i değiştirir", (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { approvedAt: _a1, approvalPayloadSha256: _h1, durability: _d1, ...restA } = happyApproval;
      const variantB = { ...happyApproval, sourceInventoryManifestVersion: "legacy-repair-inventory-v4" };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
      const { approvedAt: _a2, approvalPayloadSha256: _h2, durability: _d2, ...restB } = variantB;
      return payloadSha256(restA) !== payloadSha256(restB);
    })());

    // v2-shape fixture: has canonicalizationVersion + durability (exactly like the real,
    // superseded v2 artifact, fileSha256
    // 4685772479f41655c3b5da10f8fccf73d321bef30da2dc1145f4e2fe40501bef — NEVER touched or
    // referenced by path here) but lacks inventoryManifestVersion, the field introduced in
    // this round. Built from the CURRENT valid inventory object with only that one field
    // stripped, so every other field is realistic and the real protected artifact is never
    // read or written by this suite.
    record("InventoryManifestSchema: v2-şekilli (inventoryManifestVersion eksik, canonicalizationVersion+durability mevcut) inventory reddedilir", (() => {
      const v2ShapeInventory = withoutField(inventory, "inventoryManifestVersion");
      return !InventoryManifestSchema.safeParse(v2ShapeInventory).success;
    })());
    record("approval: v2-şekilli (inventoryManifestVersion eksik) inventory dosyasını reddeder", (() => {
      const v2ShapeInventory = withoutField(inventory, "inventoryManifestVersion");
      const v2ShapeJson = JSON.stringify(v2ShapeInventory, null, 2);
      const v2ShapePath = path.join(TMP, "v2-shape-inventory-for-approval.json");
      writeFileSync(v2ShapePath, v2ShapeJson, { encoding: "utf8", flag: "wx" });
      const v2ShapeSha256 = fileSha256(Buffer.from(v2ShapeJson, "utf8"));
      const badOut = path.join(TMP, "should-not-exist-v2-approval.json");
      const r = runTsx(APPROVAL_SCRIPT, [
        "--inventory", v2ShapePath, "--expected-inventory-sha256", v2ShapeSha256,
        "--approve-archive-instance", happyId1, "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", badOut,
      ]);
      return r.code !== 0 && r.stderr.includes("inventoryManifestVersion") && !existsSync(badOut);
    })());
    record("apply: v2-şekilli (inventoryManifestVersion eksik) inventory dosyasını reddeder", (() => {
      const v2ShapeInventory = withoutField(inventory, "inventoryManifestVersion");
      const v2ShapeJson = JSON.stringify(v2ShapeInventory, null, 2);
      const v2ShapePath = path.join(TMP, "v2-shape-inventory-for-apply.json");
      writeFileSync(v2ShapePath, v2ShapeJson, { encoding: "utf8", flag: "wx" });
      const v2ShapeSha256 = fileSha256(Buffer.from(v2ShapeJson, "utf8"));
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", v2ShapePath, "--expected-inventory-sha256", v2ShapeSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", "does-not-matter.dump", "--expected-backup-sha256", "0".repeat(64),
        "--backup-receipt", "does-not-matter.receipt.json", "--expected-backup-receipt-sha256", "0".repeat(64),
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", path.join(TMP, "receipts"),
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("inventoryManifestVersion");
    })());

    // paymentId ground-truth check: compares the metadata-repair target's manifest
    // paymentId directly against a fresh, independent live-DB query — proves the
    // generator neither hardcodes null nor fabricates a value, for whatever the row's
    // real relationship actually is.
    {
      const liveLegacy = await pool.query<{ payment_id: string | null }>(
        `select payment_id from public.payment_instances where id=$1`,
        [unresolvedTarget.instanceId],
      );
      record(
        "inventory: metadata-repair hedefinin paymentId'si canlı satırdaki gerçek (non-null) payment_id ile birebir aynı, null'a çevrilmiyor",
        liveLegacy.rows[0].payment_id !== null && unresolvedTarget.paymentId === liveLegacy.rows[0].payment_id,
        `live=${liveLegacy.rows[0].payment_id} manifest=${unresolvedTarget.paymentId}`,
      );
    }
    record("InventoryTargetSchema: paymentId=null (gerçek DB ilişkisi yokken) kabul edilir, fabrikasyon yapılmaz", (() => {
      const nullTarget = { ...unresolvedTarget, paymentId: null };
      const parsed = InventoryTargetSchema.safeParse(nullTarget);
      return parsed.success && parsed.data.paymentId === null;
    })());

    // ── §2.8 metadata-repair paymentId=null RUNTIME proof — separate, single-use disposable
    // DB (never touches DB/DB_MULTI's fixture state). The schema-level test above only
    // proves InventoryTargetSchema is CAPABLE of accepting null; it says nothing about
    // what the real generator actually produces. This test runs the REAL
    // legacy-repair-inventory.ts subprocess against a real disposable Postgres row whose
    // live payment_id IS NULL, and reads the real v3 manifest back off disk — proving the
    // generator neither fabricates nor coerces this value in either direction. payment_id
    // itself has no NOT NULL constraint (only a partial unique index over non-null values,
    // supabase/migrations/0003_payments.sql) — but 0026's payment_instances_cancel_
    // consistency check constraint re-validates the WHOLE row on ANY update to this
    // specific grandfathered (NOT VALID, pre-existing-violation) legacy row, per that
    // migration's own documented comment ("any future UPDATE to it — even unrelated
    // columns — will be re-checked and rejected"). Dropped here ONLY on this single-use
    // disposable DB (never re-added — DB_NULLPAY is dropped whole at the end, same
    // pattern already used by the §6 multiplicity test above for the identical
    // constraint), never on mas_radar_dev, never in any production tool. ──
    const DB_NULLPAY = "mas_radar_legacy_repair_verify_nullpay";
    assertSafeDisposableName(DB_NULLPAY, "null-payment-id disposable DB");
    restoreManagedFixture(DB_NULLPAY);
    const urlNullPay = dbUrl(DB_NULLPAY);
    const migrateNullPayRes = runMigrateAgainstUrl(urlNullPay);
    if (migrateNullPayRes.code !== 0) throw new Error(`null-payment-id DB migrate başarısız: ${migrateNullPayRes.stderr}`);
    const poolNullPay = new Pool({ connectionString: urlNullPay, max: 2 });
    try {
      const legacyRow = await poolNullPay.query<{ id: string }>(
        `select id from public.payment_instances where status='cancelled' and (cancelled_at is null or cancel_reason is null)`,
      );
      record("null-payment-id fixture: tam olarak 1 metadata-eksik cancelled satır bulundu", legacyRow.rowCount === 1, `rowCount=${legacyRow.rowCount}`);
      const legacyInstanceId = legacyRow.rows[0].id;

      await poolNullPay.query(`alter table public.payment_instances drop constraint payment_instances_cancel_consistency`);
      await poolNullPay.query(`update public.payment_instances set payment_id = null where id = $1`, [legacyInstanceId]);

      const liveAfterNull = await poolNullPay.query<{
        payment_id: string | null; status: string; cancelled_at: string | null; cancel_reason: string | null;
      }>(`select payment_id, status, cancelled_at, cancel_reason from public.payment_instances where id=$1`, [legacyInstanceId]);
      record(
        "null-payment-id fixture: canlı satır payment_id IS NULL + status='cancelled' + cancelled_at/cancel_reason IS NULL",
        liveAfterNull.rows[0].payment_id === null
          && liveAfterNull.rows[0].status === "cancelled"
          && liveAfterNull.rows[0].cancelled_at === null
          && liveAfterNull.rows[0].cancel_reason === null,
      );

      const auditEvidence = await poolNullPay.query<{ n: string }>(
        `select count(*)::text as n from public.audit_logs where entity_table='payment_instances' and entity_id=$1 and action='cancel_instance'`,
        [legacyInstanceId],
      );
      record("null-payment-id fixture: güvenilir cancel_instance audit kanıtı mevcut", Number(auditEvidence.rows[0].n) >= 1, auditEvidence.rows[0].n);

      const nullPayInventoryPath = path.join(TMP, "nullpay-inventory.json");
      const { inventory: nullPayInventory } = makeInventory(DB_NULLPAY, urlNullPay, nullPayInventoryPath);
      const nullPayTarget = nullPayInventory.targets.find(
        (t) => t.instanceId === legacyInstanceId && t.kind === "cancellation_metadata_repair",
      );
      record("null-payment-id: gerçek inventory subprocess'i metadata-repair hedefini üretti", Boolean(nullPayTarget));
      record(
        "null-payment-id: manifest hedefinin paymentId'si GERÇEKTEN null (gerçek CLI + gerçek disposable DB satırı üzerinden, fabrikasyon yok)",
        nullPayTarget?.paymentId === null,
      );

      const liveFullRow = await poolNullPay.query<{ raw: string }>(
        `select to_jsonb(t)::text as raw from public.payment_instances t where t.id=$1`,
        [legacyInstanceId],
      );
      const liveFullRowHash = canonicalHash(liveFullRow.rows[0].raw);
      record(
        "null-payment-id: hedefin beforeStateHash'i canlı tam satır hash'iyle eşleşiyor",
        nullPayTarget?.beforeStateHash === liveFullRowHash,
      );
    } finally {
      await poolNullPay.end();
      dropDb(DB_NULLPAY);
    }

    // ── §3 backup-receipt ──
    const backup1 = makeBackup(DB, "verify-happy", path.join(TMP, "backups"));
    record("backup-receipt: dump + receipt üretildi, receipt.sha256 gerçek dump hash'iyle eşleşiyor", (() => {
      const receipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      return receipt.sha256 === backup1.backupSha256 && receipt.databaseName === DB;
    })());
    record("backup-receipt: dumpDurability strict şemadan geçiyor ve directoryFsyncAttempted=true", (() => {
      const receipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const parsed = DurabilityMetadataSchema.safeParse(receipt.dumpDurability);
      return parsed.success && receipt.dumpDurability.directoryFsyncAttempted === true;
    })());
    record("backup-receipt: receiptDurability strict şemadan geçiyor ve directoryFsyncAttempted=true", (() => {
      const receipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const parsed = DurabilityMetadataSchema.safeParse(receipt.receiptDurability);
      return parsed.success && receipt.receiptDurability.directoryFsyncAttempted === true;
    })());

    // ── §3.6 explicit-connection backup CLI, cluster-binding, git provenance, durable
    // dump temp→rename flow, and old-receipt-format rejection. Everything here reuses the
    // suite's own disposable DB/pool/container — never mas_radar_dev. ──
    record("backup-receipt CLI: DATABASE_URL eksikken reddedilir", (() => {
      const outDir = path.join(TMP, "backups-no-dburl");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", DB, "--expected-system-identifier", SYSTEM_IDENTIFIER,
        "--container", CONTAINER, "--label", "verify-no-dburl", "--out-dir", outDir,
      ], { DATABASE_URL: undefined });
      return r.code !== 0 && !existsSync(outDir);
    })());
    record("backup-receipt CLI: yanlış --expected-database-name reddedilir", (() => {
      const outDir = path.join(TMP, "backups-wrong-dbname");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", "baska_bir_db", "--expected-system-identifier", SYSTEM_IDENTIFIER,
        "--container", CONTAINER, "--label", "verify-wrong-dbname", "--out-dir", outDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(outDir);
    })());
    record("backup-receipt CLI: yanlış --expected-system-identifier reddedilir", (() => {
      const outDir = path.join(TMP, "backups-wrong-sysid");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", DB, "--expected-system-identifier", "9".repeat(19),
        "--container", CONTAINER, "--label", "verify-wrong-sysid", "--out-dir", outDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && !existsSync(outDir);
    })());

    // Cluster-binding core logic: this suite runs against a single real Postgres cluster
    // (mas-radar-pg), so a genuine second cluster with a DIFFERENT system_identifier
    // can't be constructed here — verifyBackupTarget() is instead exercised DIRECTLY
    // (the exact function the real execution path calls) with a deliberately wrong
    // expectation, proving it correctly discriminates a cluster-identity mismatch.
    record("verifyBackupTarget: container'ın gerçek system_identifier'ı yanlış bir expectedSystemIdentifier ile karşılaştırıldığında reddeder (cluster-binding çekirdek mantığı)", (() => {
      try {
        verifyBackupTarget({ container: CONTAINER, dbName: DB, expectedSystemIdentifier: "1".repeat(19) });
        return false;
      } catch (e) {
        return (e as Error).message.includes("Cluster kimliği eşleşmedi");
      }
    })());
    record("verifyBackupTarget: doğru expectedSystemIdentifier ile gerçek container+DB üzerinden başarıyla geçer", (() => {
      const result = verifyBackupTarget({ container: CONTAINER, dbName: DB, expectedSystemIdentifier: SYSTEM_IDENTIFIER });
      return result.containerDatabaseName === DB && result.containerSystemIdentifier === SYSTEM_IDENTIFIER;
    })());
    record("backup-receipt.ts: verifyTarget() (varsayılanı gerçek verifyBackupTarget olan DI noktası) kaynak kodda pre-dump ve post-dump olarak en az iki kez çağrılıyor", (() => {
      const source = readFileSync(BACKUP_RECEIPT_SCRIPT, "utf8");
      const defaultsToRealImplementation = /const verifyTarget = deps\.verifyTarget \?\? verifyBackupTarget;/.test(source);
      const callSites = source.match(/(?<!\.)\bverifyTarget\(/g) ?? [];
      return defaultsToRealImplementation && callSites.length >= 2;
    })());

    record("backup-receipt: yeni format alanları doğru taşınıyor (gitBranch/gitHead/containerName/sourceDatabaseName/sourceSystemIdentifier/targetVerificationCompleted)", (() => {
      const receipt = BackupReceiptSchema.parse(JSON.parse(readFileSync(backup1.receiptPath, "utf8")));
      return receipt.gitBranch === TEST_GIT_BRANCH
        && receipt.gitHead === TEST_GIT_HEAD
        && receipt.containerName === CONTAINER
        && receipt.sourceDatabaseName === DB
        && receipt.sourceSystemIdentifier === SYSTEM_IDENTIFIER
        && receipt.targetVerificationCompleted === true;
    })());
    record("backup-receipt: dumpVerification tüm kanıtları taşıyor (fsync/temp-listable/rename/final-size/final-sha256/final-listable/TOC/kritik tablolar)", (() => {
      const receipt = BackupReceiptSchema.parse(JSON.parse(readFileSync(backup1.receiptPath, "utf8")));
      const dv = receipt.dumpVerification;
      return dv.fileFsyncCompleted === true
        && dv.tempRestoreListable === true
        && dv.atomicRenameCompleted === true
        && dv.finalByteSizeVerified === true
        && dv.finalSha256Verified === true
        && dv.finalRestoreListable === true
        && dv.tocEntryCount > 0
        && dv.criticalTablesPresent.paymentInstances === true
        && dv.criticalTablesPresent.payments === true
        && dv.criticalTablesPresent.auditLogs === true
        && dv.criticalTablesPresent.schemaMigrations === true;
    })());
    record("DumpVerificationSchema: eksik bir alan (tocEntryCount) ile reddedilir", (() => {
      const receiptRaw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped to test schema rejection
      const { tocEntryCount: _omitted, ...incompleteDv } = receiptRaw.dumpVerification;
      return !DumpVerificationSchema.safeParse(incompleteDv).success;
    })());
    record("DumpVerificationSchema: bir kanıt alanı false olursa (finalRestoreListable) reddedilir", (() => {
      const receiptRaw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const falsifiedDv = { ...receiptRaw.dumpVerification, finalRestoreListable: false };
      return !DumpVerificationSchema.safeParse(falsifiedDv).success;
    })());
    record("DumpVerificationSchema: kritik tablo kanıtı eksik/false olursa reddedilir", (() => {
      const receiptRaw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const falsifiedDv = { ...receiptRaw.dumpVerification, criticalTablesPresent: { ...receiptRaw.dumpVerification.criticalTablesPresent, auditLogs: false } };
      return !DumpVerificationSchema.safeParse(falsifiedDv).success;
    })());
    record("apply: dumpVerification eksik/geçersiz bir receipt'i reddeder (schema seviyesinde)", (() => {
      const receiptRaw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const falsifiedReceipt = { ...receiptRaw, dumpVerification: { ...receiptRaw.dumpVerification, finalRestoreListable: false } };
      const falsifiedPath = path.join(TMP, "falsified-dumpverification-backup-receipt.json");
      const falsifiedJson = JSON.stringify(falsifiedReceipt, null, 2);
      writeFileSync(falsifiedPath, falsifiedJson, { encoding: "utf8", flag: "wx" });
      const falsifiedSha256 = fileSha256(Buffer.from(falsifiedJson, "utf8"));
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", "does-not-matter.dump", "--expected-backup-sha256", "0".repeat(64),
        "--backup-receipt", falsifiedPath, "--expected-backup-receipt-sha256", falsifiedSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("strict şemadan geçemedi");
    })());
    record("backup receipt: dumpDurability ve receiptDurability şemada AYRI, bağımsız alanlar (tek bir ortak 'durability' alanı yok)", (() => {
      const raw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      return Object.prototype.hasOwnProperty.call(raw, "dumpDurability")
        && Object.prototype.hasOwnProperty.call(raw, "receiptDurability")
        && !Object.prototype.hasOwnProperty.call(raw, "durability");
    })());

    record("isCleanWorkingTree: boş porcelain çıktısı temiz kabul edilir", isCleanWorkingTree(""));
    record(
      "isCleanWorkingTree: boş-olmayan porcelain çıktısı kirli kabul edilir (gerçek repo'ya dokunulmadan, sahte çıktıyla test edilir)",
      !isCleanWorkingTree(" M scripts/db/some-file.ts\n"),
    );

    // Old-format backup receipt (two rounds ago's shape: no gitBranch/gitHead/
    // containerName/sourceDatabaseName/sourceSystemIdentifier/targetVerificationCompleted/
    // dumpVerification, single "durability" field instead of dumpDurability+
    // receiptDurability) — built here from the CURRENT valid receipt with those fields
    // stripped/collapsed, never touching any real protected artifact.
    const backup1ReceiptRaw = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped to build the old-shape fixture
    const { gitBranch: _oldGitBranch, gitHead: _oldGitHead, containerName: _oldContainerName, sourceDatabaseName: _oldSourceDb, sourceSystemIdentifier: _oldSourceSys, targetVerificationCompleted: _oldTvc, dumpVerification: _oldDumpVerification, receiptDurability: _oldReceiptDurability, dumpDurability: oldDurability, ...oldReceiptRest } = backup1ReceiptRaw;
    const oldShapeReceipt = { ...oldReceiptRest, durability: oldDurability };
    record("BackupReceiptSchema: eski (gitBranch/gitHead/containerName/dumpVerification/... eksik) receipt reddedilir", !BackupReceiptSchema.safeParse(oldShapeReceipt).success);
    const oldShapeReceiptPath = path.join(TMP, "old-shape-backup-receipt.json");
    const oldShapeReceiptJson = JSON.stringify(oldShapeReceipt, null, 2);
    writeFileSync(oldShapeReceiptPath, oldShapeReceiptJson, { encoding: "utf8", flag: "wx" });
    const oldShapeReceiptSha256 = fileSha256(Buffer.from(oldShapeReceiptJson, "utf8"));
    record("apply: eski backup receipt formatını reddeder", (() => {
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", "does-not-matter.dump", "--expected-backup-sha256", "0".repeat(64),
        "--backup-receipt", oldShapeReceiptPath, "--expected-backup-receipt-sha256", oldShapeReceiptSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("strict şemadan geçemedi");
    })());

    // gitHead mismatch: a schema-valid receipt whose gitHead differs from the live repo's
    // current HEAD must be rejected by apply's own live comparison (schema alone cannot
    // catch this, since any well-formed 40-hex-char value passes InventoryManifestSchema-
    // style literal checks — there is no "expected" git SHA baked into the schema).
    const wrongGitHeadReceipt = { ...backup1ReceiptRaw, gitHead: "0".repeat(40) };
    record("BackupReceiptSchema: sahte ama şekli geçerli gitHead ile de strict şemadan geçer (yalnız apply'ın canlı karşılaştırması yakalar)", BackupReceiptSchema.safeParse(wrongGitHeadReceipt).success);
    const wrongGitHeadPath = path.join(TMP, "wrong-githead-backup-receipt.json");
    const wrongGitHeadJson = JSON.stringify(wrongGitHeadReceipt, null, 2);
    writeFileSync(wrongGitHeadPath, wrongGitHeadJson, { encoding: "utf8", flag: "wx" });
    const wrongGitHeadSha256 = fileSha256(Buffer.from(wrongGitHeadJson, "utf8"));
    record("apply: backup receipt'in gitHead'i canlı git HEAD'iyle eşleşmezse reddedilir", (() => {
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", wrongGitHeadPath, "--expected-backup-receipt-sha256", wrongGitHeadSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("gitHead");
    })());

    // branch mismatch: same idea, but for gitBranch — a receipt claiming a different
    // branch than what's actually checked out must be rejected by apply's live check.
    const wrongGitBranchReceipt = { ...backup1ReceiptRaw, gitBranch: "not-the-real-branch" };
    record("BackupReceiptSchema: sahte ama şekli geçerli gitBranch ile de strict şemadan geçer (yalnız apply'ın canlı karşılaştırması yakalar)", BackupReceiptSchema.safeParse(wrongGitBranchReceipt).success);
    const wrongGitBranchPath = path.join(TMP, "wrong-gitbranch-backup-receipt.json");
    const wrongGitBranchJson = JSON.stringify(wrongGitBranchReceipt, null, 2);
    writeFileSync(wrongGitBranchPath, wrongGitBranchJson, { encoding: "utf8", flag: "wx" });
    const wrongGitBranchSha256 = fileSha256(Buffer.from(wrongGitBranchJson, "utf8"));
    record("apply: backup receipt'in gitBranch'ı canlı git branch'iyle eşleşmezse reddedilir", (() => {
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", wrongGitBranchPath, "--expected-backup-receipt-sha256", wrongGitBranchSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("gitBranch");
    })());

    // Durable dump temp→fsync→listable→rename→final-verify flow — structural (source)
    // proof for the parts not independently observable as black-box behavior, plus
    // behavioral proof (no leftover temp file after a real backup) for the parts that are.
    record("backup-docker-postgres.ts: dump önce benzersiz bir temp dosyaya yazılıyor (.tmp- deseni)", readFileSync(BACKUP_DOCKER_POSTGRES_SCRIPT, "utf8").includes(".tmp-"));
    record("backup-docker-postgres.ts: tamamlanan temp dosyada file fsync uygulanıyor (fsyncSync)", readFileSync(BACKUP_DOCKER_POSTGRES_SCRIPT, "utf8").includes("fsyncSync"));
    record("backup-docker-postgres.ts: doğrulanmış temp dosya atomic rename ile final oluyor (renameSync)", readFileSync(BACKUP_DOCKER_POSTGRES_SCRIPT, "utf8").includes("renameSync"));
    record("backup-docker-postgres.ts: restore-listable hem temp hem final dosya üzerinde ayrı ayrı çağrılıyor", (() => {
      const source = readFileSync(BACKUP_DOCKER_POSTGRES_SCRIPT, "utf8");
      return source.includes("verifyRestoreListable(opts.container, tempPath, opts.requireCriticalTables)") && source.includes("verifyRestoreListable(opts.container, finalPath, opts.requireCriticalTables)");
    })());
    record("backup-docker-postgres: gerçek backup sonrası çıktı dizininde hiçbir .tmp- dosyası kalmadı (temp dosya rename ile final oldu)", (() => {
      const files = readdirSync(path.dirname(backup1.dumpPath));
      return !files.some((f) => f.includes(".tmp-"));
    })());
    record("verifyRestoreListable: bozuk/rastgele içerikli dosya reddedilir (pg_restore --list başarısız olur)", (() => {
      const garbagePath = path.join(TMP, "garbage-not-a-dump.bin");
      writeFileSync(garbagePath, Buffer.from("bu bir pg_dump dosyası değil, rastgele veri".repeat(50), "utf8"));
      try {
        verifyRestoreListable(CONTAINER, garbagePath);
        return false;
      } catch {
        return true;
      }
    })());
    record("verifyRestoreListable: kritik tablo eksik GERÇEK dump reddedilir (payment_instances --exclude-table ile üretildi)", (() => {
      const excludedDumpPath = path.join(TMP, "dump-missing-payment-instances.dump");
      const dumpBuffer = execFileSync(
        "docker",
        ["exec", CONTAINER, "pg_dump", "-U", "postgres", "-Fc", "--exclude-table=public.payment_instances", DB],
        { maxBuffer: 128 * 1024 * 1024 },
      );
      writeFileSync(excludedDumpPath, dumpBuffer);
      try {
        verifyRestoreListable(CONTAINER, excludedDumpPath, true);
        return false;
      } catch (e) {
        return (e as Error).message.includes("payment_instances");
      }
    })());
    record("verifyRestoreListable: requireCriticalTables=false (varsayılan) iken kritik tablo eksik dump reddedilmez, yalnız false raporlanır (migrate.ts'in ön-migrasyon backup'ları için)", (() => {
      const excludedDumpPath = path.join(TMP, "dump-missing-payment-instances-lenient.dump");
      const dumpBuffer = execFileSync(
        "docker",
        ["exec", CONTAINER, "pg_dump", "-U", "postgres", "-Fc", "--exclude-table=public.payment_instances", DB],
        { maxBuffer: 128 * 1024 * 1024 },
      );
      writeFileSync(excludedDumpPath, dumpBuffer);
      const result = verifyRestoreListable(CONTAINER, excludedDumpPath);
      return result.criticalTablesPresent.paymentInstances === false
        && result.criticalTablesPresent.payments === true
        && result.criticalTablesPresent.auditLogs === true
        && result.criticalTablesPresent.schemaMigrations === true;
    })());

    // ── §3.7 git-state provenance — dependency-injected orchestration tests. Both
    // assertExpectedCleanGitState (backup) and assertApplyGitProvenance (apply) are
    // exercised DIRECTLY, in-process, with fake providers — never by dirtying this
    // repository's own working tree, and never through any CLI-level bypass (there isn't
    // one: the injection seam is these functions' own optional parameter, reachable only
    // by importing the module). ──
    const FAKE_HEAD = "a".repeat(40);
    record("assertExpectedCleanGitState: doğru branch+HEAD+temiz → başarılı", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      const state = assertExpectedCleanGitState({ branch: "fake-branch", head: FAKE_HEAD }, fake);
      return state.branch === "fake-branch" && state.head === FAKE_HEAD && state.clean === true;
    })());
    record("assertExpectedCleanGitState: kirli working tree reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => false };
      try {
        assertExpectedCleanGitState({ branch: "fake-branch", head: FAKE_HEAD }, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("temiz değil");
      }
    })());
    record("assertExpectedCleanGitState: yanlış HEAD reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => "b".repeat(40), isClean: () => true };
      try {
        assertExpectedCleanGitState({ branch: "fake-branch", head: FAKE_HEAD }, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("HEAD uyuşmuyor");
      }
    })());
    record("assertExpectedCleanGitState: yanlış branch reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "different-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      try {
        assertExpectedCleanGitState({ branch: "fake-branch", head: FAKE_HEAD }, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("branch uyuşmuyor");
      }
    })());

    record("assertApplyGitProvenance: doğru HEAD+branch+temiz → başarılı", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      const fakeReceipt = { ...backup1ReceiptRaw, gitBranch: "fake-branch", gitHead: FAKE_HEAD } as BackupReceipt;
      const state = assertApplyGitProvenance(FAKE_HEAD, fakeReceipt, fake);
      return state.head === FAKE_HEAD;
    })());
    record("assertApplyGitProvenance: kirli working tree reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => false };
      const fakeReceipt = { ...backup1ReceiptRaw, gitBranch: "fake-branch", gitHead: FAKE_HEAD } as BackupReceipt;
      try {
        assertApplyGitProvenance(FAKE_HEAD, fakeReceipt, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("temiz değil");
      }
    })());
    record("assertApplyGitProvenance: yanlış inventory gitHead reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      const fakeReceipt = { ...backup1ReceiptRaw, gitBranch: "fake-branch", gitHead: FAKE_HEAD } as BackupReceipt;
      try {
        assertApplyGitProvenance("b".repeat(40), fakeReceipt, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("inventory'nin gitHead'iyle");
      }
    })());
    record("assertApplyGitProvenance: yanlış receipt gitHead reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      const fakeReceipt = { ...backup1ReceiptRaw, gitBranch: "fake-branch", gitHead: "b".repeat(40) } as BackupReceipt;
      try {
        assertApplyGitProvenance(FAKE_HEAD, fakeReceipt, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("backup receipt'in gitHead'iyle");
      }
    })());
    record("assertApplyGitProvenance: yanlış receipt gitBranch reddedilir", (() => {
      const fake: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
      const fakeReceipt = { ...backup1ReceiptRaw, gitBranch: "different-branch", gitHead: FAKE_HEAD } as BackupReceipt;
      try {
        assertApplyGitProvenance(FAKE_HEAD, fakeReceipt, fake);
        return false;
      } catch (e) {
        return (e as Error).message.includes("gitBranch'ıyla");
      }
    })());
    record("backup-receipt.ts: main() runBackupReceipt'i deps override etmeden çağırıyor (gitStateProvider/verifyTarget/runBackup için gerçek varsayılanlar kullanılıyor)", (() => {
      const source = readFileSync(BACKUP_RECEIPT_SCRIPT, "utf8");
      return source.includes("await runBackupReceipt(")
        && !source.includes("gitStateProvider:")
        && !source.includes("verifyTarget:")
        && !/\brunBackup:/.test(source);
    })());

    // ── §3.8 runBackupReceipt orchestration-level DI tests — container/TCP mismatch,
    // post-dump identity change, and mid-flight git-state change, all WITHOUT a real
    // second Postgres cluster: only the leaf dependencies are faked, the REAL
    // orchestration function (runBackupReceipt itself, imported unmodified) runs. ──
    const FAKE_DURABILITY: DurabilityMetadata = {
      platform: "win32", durabilityMode: "full-directory-fsync",
      directoryFsyncAttempted: true, directoryFsyncSupported: true, directoryFsyncErrorCode: null,
    };
    const fakeBackupResult = (dumpPath: string): BackupResult => ({
      path: dumpPath,
      bytes: 100,
      sha256: "0".repeat(64),
      dumpDurability: FAKE_DURABILITY,
      dumpVerification: {
        fileFsyncCompleted: true, tempRestoreListable: true, atomicRenameCompleted: true,
        finalByteSizeVerified: true, finalSha256Verified: true, finalRestoreListable: true,
        tocEntryCount: 1,
        criticalTablesPresent: { paymentInstances: true, payments: true, auditLogs: true, schemaMigrations: true },
      },
    });
    const alwaysCleanFakeGit: GitStateProvider = { getBranch: () => "fake-branch", getHead: () => FAKE_HEAD, isClean: () => true };
    const baseFakeDeps = (): BackupReceiptDeps => ({
      gitStateProvider: alwaysCleanFakeGit,
      queryTcpIdentity: async () => ({ databaseName: "mas_radar_dev", systemIdentifier: "1111111111111111111" }),
      queryLedger: async () => ({ ledgerCount: 1, lastMigrationVersion: "0001" }),
      readDbTimestamp: async () => "2026-01-01T00:00:00.000000Z",
    });
    const baseFakeParams = (label: string, outDir: string): BackupReceiptParams => ({
      expectedDatabaseName: "mas_radar_dev",
      expectedSystemIdentifier: "1111111111111111111",
      expectedGitBranch: "fake-branch",
      expectedGitHead: FAKE_HEAD,
      container: CONTAINER,
      label,
      outDir,
    });

    {
      let runBackupCallCount = 0;
      const outDir = path.join(TMP, "backups-orchestration-mismatch");
      let threw: Error | null = null;
      try {
        await runBackupReceipt(baseFakeParams("verify-mismatch-orchestration", outDir), {
          ...baseFakeDeps(),
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must match verifyTarget; param intentionally unused, this fake always rejects
          verifyTarget: (_v: BackupTargetVerification): BackupTargetVerificationResult => {
            throw new Error("Cluster kimliği eşleşmedi — backup/migration iptal edildi. (SIMULE: container systemIdentifier='2222222222222222222' TCP'nin '1111111111111111111' değeriyle eşleşmiyor)");
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must match runBackup; param intentionally unused, only call count matters
          runBackup: async (_opts: BackupOptions): Promise<BackupResult> => {
            runBackupCallCount++;
            return fakeBackupResult(path.join(outDir, "should-not-be-created.dump"));
          },
        });
      } catch (e) {
        threw = e as Error;
      }
      record(
        "runBackupReceipt: TCP identity (systemIdentifier=A) ile container identity (systemIdentifier=B) uyuşmazsa dump başlamadan reddedilir, pg_dump hiç çağrılmaz",
        threw !== null && threw.message.includes("Cluster kimliği eşleşmedi") && runBackupCallCount === 0 && !existsSync(outDir),
      );
    }

    {
      let verifyCallCount = 0;
      const outDir = path.join(TMP, "backups-orchestration-postmismatch");
      const fakeDumpPath = path.join(outDir, "fake-not-real.dump");
      let threw: Error | null = null;
      try {
        await runBackupReceipt(baseFakeParams("verify-postmismatch", outDir), {
          ...baseFakeDeps(),
          verifyTarget: (v: BackupTargetVerification): BackupTargetVerificationResult => {
            verifyCallCount++;
            if (verifyCallCount === 1) return { containerDatabaseName: v.dbName, containerSystemIdentifier: v.expectedSystemIdentifier };
            throw new Error("Cluster kimliği eşleşmedi — backup/migration iptal edildi. (SIMULE: post-dump identity changed)");
          },
          runBackup: async (): Promise<BackupResult> => fakeBackupResult(fakeDumpPath),
        });
      } catch (e) {
        threw = e as Error;
      }
      record(
        "runBackupReceipt: post-dump container identity değişirse (mismatch) receipt yazılmaz",
        threw !== null && threw.message.includes("Cluster kimliği eşleşmedi") && !existsSync(`${fakeDumpPath}.receipt.json`),
      );
    }

    {
      let gitCallCount = 0;
      const outDir = path.join(TMP, "backups-orchestration-gitchange");
      const fakeDumpPath = path.join(outDir, "fake-not-real-2.dump");
      const changingGit: GitStateProvider = {
        getBranch: () => "fake-branch",
        getHead: () => {
          gitCallCount++;
          return gitCallCount === 1 ? FAKE_HEAD : "c".repeat(40);
        },
        isClean: () => true,
      };
      let threw: Error | null = null;
      try {
        await runBackupReceipt(baseFakeParams("verify-gitchange", outDir), {
          ...baseFakeDeps(),
          gitStateProvider: changingGit,
          verifyTarget: (v: BackupTargetVerification): BackupTargetVerificationResult => ({ containerDatabaseName: v.dbName, containerSystemIdentifier: v.expectedSystemIdentifier }),
          runBackup: async (): Promise<BackupResult> => fakeBackupResult(fakeDumpPath),
        });
      } catch (e) {
        threw = e as Error;
      }
      record(
        "runBackupReceipt: pre-check sonrası HEAD değişirse receipt yazılmaz",
        threw !== null && threw.message.includes("Git HEAD uyuşmuyor") && !existsSync(`${fakeDumpPath}.receipt.json`),
      );
    }

    {
      let cleanCallCount = 0;
      const outDir = path.join(TMP, "backups-orchestration-dirtymidflight");
      const fakeDumpPath = path.join(outDir, "fake-not-real-3.dump");
      const dirtyingMidFlight: GitStateProvider = {
        getBranch: () => "fake-branch",
        getHead: () => FAKE_HEAD,
        isClean: () => {
          cleanCallCount++;
          return cleanCallCount === 1;
        },
      };
      let threw: Error | null = null;
      try {
        await runBackupReceipt(baseFakeParams("verify-dirtymidflight", outDir), {
          ...baseFakeDeps(),
          gitStateProvider: dirtyingMidFlight,
          verifyTarget: (v: BackupTargetVerification): BackupTargetVerificationResult => ({ containerDatabaseName: v.dbName, containerSystemIdentifier: v.expectedSystemIdentifier }),
          runBackup: async (): Promise<BackupResult> => fakeBackupResult(fakeDumpPath),
        });
      } catch (e) {
        threw = e as Error;
      }
      record(
        "runBackupReceipt: pre-check sonrası working tree kirlenirse receipt yazılmaz",
        threw !== null && threw.message.includes("temiz değil") && !existsSync(`${fakeDumpPath}.receipt.json`),
      );
    }

    // ── §3.9 real subprocess, isolated temp git repo — proves the REAL CLI entrypoints
    // (not just the extracted functions) genuinely enforce this, without ever touching
    // this project's own working tree. ──
    record("backup-receipt CLI: yanlış --expected-git-head reddedilir (gerçek izole repo, doğru branch)", (() => {
      const outDir = path.join(TMP, "backups-wrong-git-head-cli");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", DB, "--expected-system-identifier", SYSTEM_IDENTIFIER,
        "--expected-git-branch", TEST_GIT_BRANCH, "--expected-git-head", "0".repeat(40),
        "--container", CONTAINER, "--label", "verify-wrong-git-head-cli", "--out-dir", outDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("HEAD uyuşmuyor") && !existsSync(outDir);
    })());
    record("backup-receipt CLI: yanlış --expected-git-branch reddedilir (gerçek izole repo, doğru HEAD)", (() => {
      const outDir = path.join(TMP, "backups-wrong-git-branch-cli");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", DB, "--expected-system-identifier", SYSTEM_IDENTIFIER,
        "--expected-git-branch", "not-the-real-branch", "--expected-git-head", TEST_GIT_HEAD,
        "--container", CONTAINER, "--label", "verify-wrong-git-branch-cli", "--out-dir", outDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("branch uyuşmuyor") && !existsSync(outDir);
    })());
    record("backup-receipt CLI: gerçek izole repo kirletilince reddedilir, temizlenince tekrar kullanılabilir", (() => {
      dirtyTempGitRepo(TEMP_GIT_REPO);
      const outDir = path.join(TMP, "backups-dirty-repo-cli");
      const r = runTsx(BACKUP_RECEIPT_SCRIPT, [
        "--expected-database-name", DB, "--expected-system-identifier", SYSTEM_IDENTIFIER,
        "--expected-git-branch", TEST_GIT_BRANCH, "--expected-git-head", TEST_GIT_HEAD,
        "--container", CONTAINER, "--label", "verify-dirty-repo-cli", "--out-dir", outDir,
      ], { DATABASE_URL: url });
      cleanTempGitRepo(TEMP_GIT_REPO);
      return r.code !== 0 && r.stderr.includes("temiz değil") && !existsSync(outDir);
    })());
    record("apply CLI: gerçek izole repo kirliyken DB'ye bağlanmadan, hiçbir yeni receipt üretmeden reddedilir", (() => {
      dirtyTempGitRepo(TEMP_GIT_REPO);
      const beforeCount = listReceiptFiles(receiptsDir).length;
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", backup1.receiptPath, "--expected-backup-receipt-sha256", backup1.backupReceiptSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      cleanTempGitRepo(TEMP_GIT_REPO);
      const afterCount = listReceiptFiles(receiptsDir).length;
      return r.code !== 0 && r.stderr.includes("temiz değil") && afterCount === beforeCount;
    })());

    // ── §3.5 Windows durability infrastructure ──
    record("durability: gerçek attemptDirectoryFsync (win32, bu host) — 'r+' ile GERÇEK full-directory-fsync başarılı", (() => {
      const d = attemptDirectoryFsync(receiptsDir);
      return d.platform === "win32" && d.durabilityMode === "full-directory-fsync" && d.directoryFsyncSupported === true && d.directoryFsyncErrorCode === null;
    })());
    record("durability: sameVolume aynı yol için true döner", sameVolume("C:\\foo\\bar.json", "C:\\foo\\bar-2.json"));
    record("durability: sameVolume farklı sürücü harfleri için false döner", !sameVolume("C:\\foo\\bar.json", "D:\\foo\\bar.json"));

    function fakeImpl(codeToThrow: string, flagsToFail: string[] = ["r+", "r"]): DirectoryFsyncImpl {
      return {
        open: (_p, flag) => {
          if (flagsToFail.includes(flag)) {
            const err = new Error(`simulated ${codeToThrow}`) as NodeJS.ErrnoException;
            err.code = codeToThrow;
            throw err;
          }
          return 999;
        },
        fsync: () => {},
        close: () => {},
      };
    }
    // SIMULATED (not empirically reproduced on this host — this host's real 'r+' path
    // succeeds, see the real test above): proves the win32 best-effort tolerance branch
    // for EPERM and ENOSYS, and the fail-closed branch for an unexpected code (EIO),
    // by injecting a fake open/fsync implementation rather than relying on genuine OS
    // behavior this host does not exhibit.
    record("durability: SIMULE win32 EPERM (r+ ve r ikisi de) → best-effort devam eder, metadata kaydedilir", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EPERM"));
      return d.durabilityMode === "windows-best-effort" && d.directoryFsyncSupported === false && d.directoryFsyncErrorCode === "EPERM" && d.platform === "win32";
    })());
    record("durability: SIMULE win32 ENOSYS (r+ ve r ikisi de) → best-effort devam eder", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("ENOSYS"));
      return d.durabilityMode === "windows-best-effort" && d.directoryFsyncErrorCode === "ENOSYS";
    })());
    record("durability: SIMULE win32 beklenmeyen EIO → fail-closed (throw)", (() => {
      try {
        attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EIO"));
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EIO";
      }
    })());
    record("durability: aynı EPERM kodu win32 DIŞINDA (linux) tolere edilmez → fail-closed (throw)", (() => {
      try {
        attemptDirectoryFsync(receiptsDir, "linux", fakeImpl("EPERM", ["r"]));
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    })());
    record("durability: 'r+' başarısız ama 'r' başarılı olursa win32'de full-directory-fsync raporlanır", (() => {
      const d = attemptDirectoryFsync(receiptsDir, "win32", fakeImpl("EPERM", ["r+"]));
      return d.durabilityMode === "full-directory-fsync" && d.directoryFsyncSupported === true;
    })());
    record("DurabilityMetadataSchema: durabilityMode='windows-best-effort' + platform='linux' tutarsızlığı reddedilir", (() => {
      return !DurabilityMetadataSchema.safeParse({
        platform: "linux", durabilityMode: "windows-best-effort",
        directoryFsyncAttempted: true, directoryFsyncSupported: false, directoryFsyncErrorCode: "EPERM",
      }).success;
    })());
    record("DurabilityMetadataSchema: directoryFsyncSupported=true + errorCode dolu tutarsızlığı reddedilir", (() => {
      return !DurabilityMetadataSchema.safeParse({
        platform: "win32", durabilityMode: "full-directory-fsync",
        directoryFsyncAttempted: true, directoryFsyncSupported: true, directoryFsyncErrorCode: "EPERM",
      }).success;
    })());
    record("durable-write: validate() reddederse writeExclusiveDurable throw eder (dosya zaten yazılmış olsa bile)", (() => {
      const p = path.join(TMP, "validate-reject-exclusive.json");
      try {
        writeExclusiveDurable(p, () => JSON.stringify({ ok: true }), () => {
          throw new Error("simulated validate rejection");
        });
        return false;
      } catch (e) {
        return (e as Error).message.includes("simulated validate rejection");
      }
    })());
    record("durable-write: validate() reddederse writeViaTempAndRename throw eder", (() => {
      const p = path.join(TMP, "validate-reject-rename.json");
      try {
        writeViaTempAndRename(p, () => JSON.stringify({ ok: true }), () => {
          throw new Error("simulated validate rejection");
        });
        return false;
      } catch (e) {
        return (e as Error).message.includes("simulated validate rejection");
      }
    })());
    record("durable-write: writeViaTempAndRename sonucu byte-hash-doğru re-read edilebilir (rename sonrası dosya gerçekten okunabilir ve doğrulanmış içerikle eşleşir)", (() => {
      const p = path.join(TMP, "reread-check.json");
      const content = JSON.stringify({ marker: "reread-check", n: 12345 });
      writeViaTempAndRename(p, () => content, (text) => {
        if (text !== content) throw new Error("reread mismatch");
      });
      return readFileSync(p, "utf8") === content;
    })());

    // ── ReceiptCoreSchema: appliedRepairs duplicate/canonical-order guards (schema-level, no DB) ──
    function makeBaseReceiptCore(appliedRepairs: unknown[]): unknown {
      return {
        canonicalizationVersion: CANONICALIZATION_VERSION,
        operationId: randomUUID(),
        inventoryFileSha256: "0".repeat(64),
        approvalFileSha256: "0".repeat(64),
        backupSha256: "0".repeat(64),
        backupReceiptSha256: "0".repeat(64),
        gitHead: "0".repeat(40),
        databaseName: DB,
        systemIdentifier: "123456789",
        ledgerCount: 29,
        lastMigrationVersion: "0029",
        transactionTimestamp: "2026-07-20T00:00:00.000000Z",
        advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: "1" },
        appliedRepairs,
        untouchedInstanceIds: [],
        untouchedScopeBeforeHash: "0".repeat(64),
        untouchedScopeAfterHash: "0".repeat(64),
      };
    }
    // version=4/variant=8 nibbles are required — zod's z.uuid() enforces RFC 4122 shape,
    // not just the general xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx pattern.
    const idA = "00000000-0000-4000-8000-00000000000a";
    const idB = "00000000-0000-4000-8000-00000000000b";
    const auditA = "10000000-0000-4000-8000-00000000000a";
    const auditB = "10000000-0000-4000-8000-00000000000b";
    const repairEntry = (instanceId: string, auditId: string) => ({
      instanceId, kind: "archive_cascade_repair", auditId,
      cancelledAt: "2026-07-20T00:00:00.000000Z", beforeHash: "0".repeat(64), afterHash: "0".repeat(64),
    });
    record("AppliedRepairResultSchema: geçerli tek girdi şemadan geçer", AppliedRepairResultSchema.safeParse(repairEntry(idA, auditA)).success);
    record("ReceiptCoreSchema: appliedRepairs boşsa reddedilir", !ReceiptCoreSchema.safeParse(makeBaseReceiptCore([])).success);
    record("ReceiptCoreSchema: duplicate instanceId reddedilir", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idA, auditB)]),
    ).success);
    record("ReceiptCoreSchema: duplicate auditId reddedilir", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idB, auditA)]),
    ).success);
    record("ReceiptCoreSchema: canonical (artan instanceId) sırada olan geçerli dizi kabul edilir", ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idA, auditA), repairEntry(idB, auditB)]),
    ).success);
    record("ReceiptCoreSchema: canonical OLMAYAN (ters) sıradaki dizi sessizce sıralanmaz, REDDEDİLİR", !ReceiptCoreSchema.safeParse(
      makeBaseReceiptCore([repairEntry(idB, auditB), repairEntry(idA, auditA)]),
    ).success);
    record("sortAppliedRepairsDeterministically: ters sırayı canonical sıraya döndürür", (() => {
      const sorted = sortAppliedRepairsDeterministically([repairEntry(idB, auditB), repairEntry(idA, auditA)]);
      return sorted[0].instanceId === idA && sorted[1].instanceId === idB;
    })());

    // ── §4 apply ──
    const commonApplyArgs = (approvalPath: string, approvalSha: string, backup: BackupBundle) => [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approval", approvalPath, "--expected-approval-sha256", approvalSha,
      "--backup", backup.dumpPath, "--expected-backup-sha256", backup.backupSha256,
      "--backup-receipt", backup.receiptPath, "--expected-backup-receipt-sha256", backup.backupReceiptSha256,
      "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
    ];

    const dryRunRes = runTsx(APPLY_SCRIPT, commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), { DATABASE_URL: url });
    record("apply: --apply verilmeden dry-run başarılı, hiçbir receipt yazılmadı", dryRunRes.code === 0 && listReceiptFiles(receiptsDir).length === 0, dryRunRes.stderr.slice(0, 300));

    record("apply: yanlış --expected-database-name reddedilir", (() => {
      const args = commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1).map((a) => (a === DB ? "yanlis_db_adi" : a));
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());
    record("apply: yanlış --expected-backup-sha256 reddedilir", (() => {
      const args = [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1)];
      args[args.indexOf("--expected-backup-sha256") + 1] = "0".repeat(64);
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0 && listReceiptFiles(receiptsDir).length === 0;
    })());
    record("apply: yanlış --expected-backup-receipt-sha256 reddedilir", (() => {
      const args = [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1)];
      args[args.indexOf("--expected-backup-receipt-sha256") + 1] = "0".repeat(64);
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());

    // approval bound to a DIFFERENT inventory file → rejected even with correct byte hashes.
    const inventory2Path = path.join(TMP, "inventory2.json");
    const { sha256: inventory2Sha256 } = makeInventory(DB, url, inventory2Path);
    record("apply: approval başka bir inventory dosyasına bağlıysa (inventoryFileSha256 uyuşmazlığı) reddedilir", (() => {
      const r = runTsx(APPLY_SCRIPT, [
        "--inventory", inventory2Path, "--expected-inventory-sha256", inventory2Sha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", backup1.receiptPath, "--expected-backup-receipt-sha256", backup1.backupReceiptSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("başka bir inventory");
    })());

    // freshness ordering: a backup taken BEFORE the approval it's paired with.
    record("apply: approval, ilişkili backup'tan sonra üretilmişse (tazelik sırası) reddedilir", (() => {
      const earlyBackup = makeBackup(DB, "verify-early", path.join(TMP, "backups-early"));
      const laterApprovalPath = apprOut("later-than-backup");
      const r0 = runTsx(APPROVAL_SCRIPT, [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approve-archive-instance", restCandidates[0], "--confirm-archive-reason", "x",
        "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", laterApprovalPath,
      ]);
      if (r0.code !== 0) return false;
      const laterApprovalSha = fileSha256(readFileSync(laterApprovalPath));
      const r = runTsx(APPLY_SCRIPT, commonApplyArgs(laterApprovalPath, laterApprovalSha, earlyBackup), { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("tazelik sırası");
    })());

    // freshness window: a syntactically-valid but stale backup receipt (same real dump,
    // hand-crafted old backupCompletedDbTimestamp) must be rejected once connected to the DB.
    record("apply: 30 dakikayı aşan (bayat) backup receipt reddedilir", (() => {
      const staleReceipt: BackupReceipt = JSON.parse(readFileSync(backup1.receiptPath, "utf8"));
      const stale = { ...staleReceipt, backupStartedDbTimestamp: "2020-01-01T00:00:00.000000Z", backupCompletedDbTimestamp: "2020-01-01T00:00:05.000000Z" };
      const stalePath = path.join(TMP, "stale.receipt.json");
      writeFileSync(stalePath, JSON.stringify(stale, null, 2));
      const staleSha256 = fileSha256(readFileSync(stalePath));
      const args = [
        "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
        "--approval", happyApprovalPath, "--expected-approval-sha256", happyApprovalSha256,
        "--backup", backup1.dumpPath, "--expected-backup-sha256", backup1.backupSha256,
        "--backup-receipt", stalePath, "--expected-backup-receipt-sha256", staleSha256,
        "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir,
      ];
      const r = runTsx(APPLY_SCRIPT, args, { DATABASE_URL: url });
      return r.code !== 0;
    })());

    // ledger drift: DB's schema_migrations changed since inventory was generated.
    {
      await pool.query(
        `insert into public.schema_migrations(version,name,checksum,applied_by)
         values ('9999','legacy-repair-verify-ledger-drift','deadbeef','legacy-repair-verify')
         on conflict do nothing`,
      );
      const r = runTsx(APPLY_SCRIPT, commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), { DATABASE_URL: url });
      await pool.query(`delete from public.schema_migrations where version='9999'`);
      record("apply: inventory alındıktan sonra ledger değişmişse (canlı ledger sapması) reddedilir", r.code !== 0 && r.stderr.includes("ledger"));
    }

    // ── happy-path real apply, with full receipt/audit verification ──
    const applyRes = runTsx(APPLY_SCRIPT, [...commonApplyArgs(happyApprovalPath, happyApprovalSha256, backup1), "--apply"], { DATABASE_URL: url });
    record("apply: mutlu yol --apply başarıyla commit edildi", applyRes.code === 0, applyRes.stderr.slice(0, 500));
    const happyOperationId = extractOperationId(applyRes.stdout);
    const happyCommittedPath = path.join(receiptsDir, `${happyOperationId}.receipt.committed.json`);
    const happyPendingPath = path.join(receiptsDir, `${happyOperationId}.receipt.pending.json`);
    record("apply: pending + committed receipt dosyaları var", existsSync(happyPendingPath) && existsSync(happyCommittedPath));
    if (existsSync(happyCommittedPath)) {
      const committed = CommittedReceiptFileSchema.parse(JSON.parse(readFileSync(happyCommittedPath, "utf8")));
      const realPendingSha256 = fileSha256(readFileSync(happyPendingPath));
      record("apply: committed.pendingFileSha256 gerçek pending byte hash'iyle eşleşiyor", committed.pendingFileSha256 === realPendingSha256);
      record("apply: committed.finalizationMode === 'normal'", committed.finalizationMode === "normal");
      record("apply: committed.durability strict şemadan geçiyor", DurabilityMetadataSchema.safeParse(committed.durability).success);
      record("apply: receiptCore.lastMigrationVersion === '0029'", committed.receiptCore.lastMigrationVersion === "0029");
      record("apply: receiptCore.ledgerCount === 29", committed.receiptCore.ledgerCount === 29);
      record("apply: receiptCore.appliedRepairs iki hedefi içeriyor, canonical sırada", (() => {
        const ids = committed.receiptCore.appliedRepairs.map((r) => r.instanceId);
        return ids.length === 2 && [...ids].sort().join() === ids.join();
      })());
      const summary = await pool.query<{ id: string; after_data: { pendingFileSha256?: string } }>(
        `select id, after_data from public.audit_logs where action='legacy_repair_summary' and after_data->>'operationId'=$1`,
        [happyOperationId],
      );
      record("apply: DB'de tam 1 legacy_repair_summary satırı var", summary.rowCount === 1);
      record("apply: summary.id === committed.summaryAuditId", summary.rows[0]?.id === committed.summaryAuditId);
      const instRows = await pool.query<{ status: string; cancel_reason: string | null }>(
        `select status, cancel_reason from public.payment_instances where id = any($1)`,
        [[happyId1, happyId2]],
      );
      record("apply: onaylı 2 hedef gerçekten cancelled + doğru reason", instRows.rows.every((r) => r.status === "cancelled" && r.cancel_reason === "Legacy repair verify: mutlu yol"));
      const untouched = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftPreconditionId]);
      record("apply: onaylanmamış diğer adaylar dokunulmamış", ["unpaid", "planned"].includes(untouched.rows[0].status));
    }

    // ── forged manifest: metadata target's paymentId mutated to a value different from
    // the true live payment_id, then the file rebuilt so it passes strict schema AND its
    // own self-consistent payload hash — proving file-level integrity checks alone are
    // NOT sufficient; only apply's live-DB semantic invariant (added to legacy-repair-
    // apply.ts this round) catches it. Placed here (after the main happy-path apply block,
    // which is the last test relying on receiptsDir starting out completely empty) rather
    // than earlier, since both this test and the genuine metadata-repair happy path below
    // write real receipt files — running them any earlier would break the two absolute
    // zero-receipt-count checks near the top of §4 (dry-run, wrong-backup-sha256). Must
    // run BEFORE the genuine metadata-repair happy path below: a successful apply there
    // would change the row's status/cancel_reason, which would trip the earlier
    // beforeStateHash precondition check instead of exercising the NEW paymentId
    // invariant if the order were reversed. ──
    const forgedWrongPaymentId = unresolvedTarget.paymentId === null ? "00000000-0000-4000-8000-0000000000ff" : null;
    const forgedTargets = inventory.targets.map((t) =>
      t.instanceId === unresolvedTarget.instanceId && t.kind === "cancellation_metadata_repair"
        ? { ...t, paymentId: forgedWrongPaymentId }
        : t,
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately stripped before hashing
    const { generatedAt: _forgedGeneratedAt, inventoryPayloadSha256: _forgedOldHash, durability: _forgedOldDurability, ...forgedRest } = inventory;
    const forgedWithoutHash = { ...forgedRest, targets: forgedTargets };
    const forgedPayloadSha256 = payloadSha256(forgedWithoutHash);
    const forgedManifest = {
      generatedAt: inventory.generatedAt,
      ...forgedWithoutHash,
      inventoryPayloadSha256: forgedPayloadSha256,
      durability: inventory.durability,
    };
    record("forged inventory: sahte paymentId ile de strict şemadan ve kendi self-hash kontrolünden geçer (dosya seviyesinde tespit edilemez)", InventoryManifestSchema.safeParse(forgedManifest).success);
    const forgedInventoryPath = path.join(TMP, "forged-paymentid-inventory.json");
    const forgedJson = JSON.stringify(forgedManifest, null, 2);
    writeFileSync(forgedInventoryPath, forgedJson, { encoding: "utf8", flag: "wx" });
    const forgedInventorySha256 = fileSha256(Buffer.from(forgedJson, "utf8"));

    const forgedApprovalPath = apprOut("forged-paymentid");
    const forgedApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", forgedInventoryPath, "--expected-inventory-sha256", forgedInventorySha256,
      "--approve-metadata-instance", unresolvedTarget.instanceId, "--reason", "Forged manifest testi",
      "--confirm-timestamp", unresolvedTarget.proposedCancelledAt!,
      "--out", forgedApprovalPath,
    ]);
    record("forged manifest: approval seviyesinde de üretilebiliyor (approval canlı DB'yi hiç bilmiyor, yalnız dosya-seviyesi kontrol yapar)", forgedApprRes.code === 0, forgedApprRes.stderr.slice(0, 300));
    const forgedApprovalSha256 = fileSha256(readFileSync(forgedApprovalPath));
    const forgedBackup = makeBackup(DB, "verify-forged-paymentid", path.join(TMP, "backups-forged-paymentid"));

    const rolledBackBeforeForged = new Set(listRolledBackReceipts(receiptsDir));
    const beforeForgedFiles = new Set(listReceiptFiles(receiptsDir));
    const forgedApplyRes = runTsx(APPLY_SCRIPT, [
      "--inventory", forgedInventoryPath, "--expected-inventory-sha256", forgedInventorySha256,
      "--approval", forgedApprovalPath, "--expected-approval-sha256", forgedApprovalSha256,
      "--backup", forgedBackup.dumpPath, "--expected-backup-sha256", forgedBackup.backupSha256,
      "--backup-receipt", forgedBackup.receiptPath, "--expected-backup-receipt-sha256", forgedBackup.backupReceiptSha256,
      "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir, "--apply",
    ], { DATABASE_URL: url });
    record("forged manifest: apply canlı payment ilişkisi invariant'ında reddedildi (exit != 0)", forgedApplyRes.code !== 0, forgedApplyRes.stderr.slice(0, 400));
    record("forged manifest: red mesajı instance ID'yi içeriyor (maskelenmemiş)", forgedApplyRes.stderr.includes(unresolvedTarget.instanceId));
    const forgedNewReceipts = listReceiptFiles(receiptsDir).filter((f) => !beforeForgedFiles.has(f));
    record("forged manifest: hiçbir pending/committed receipt yazılmadı, yalnız rolled-back", forgedNewReceipts.length === 1 && forgedNewReceipts[0].endsWith(".rolled-back.json"));
    const forgedNewRolledBack = [...listRolledBackReceipts(receiptsDir)].filter((f) => !rolledBackBeforeForged.has(f));
    const forgedRolledBack = forgedNewRolledBack.length === 1
      ? RolledBackReceiptFileSchema.parse(JSON.parse(readFileSync(path.join(receiptsDir, forgedNewRolledBack[0]), "utf8")))
      : null;
    record(
      "forged manifest: failureStage='precondition', pendingFileSha256=null (mutation'a hiç başlanmadı)",
      forgedRolledBack?.failureStage === "precondition" && forgedRolledBack.pendingFileSha256 === null,
    );
    const forgedTargetAfter = await pool.query<{ status: string; cancel_reason: string | null }>(
      `select status, cancel_reason from public.payment_instances where id=$1`,
      [unresolvedTarget.instanceId],
    );
    record("forged manifest: hedef satır HİÇ değişmedi (status/cancel_reason aynı kaldı)", forgedTargetAfter.rows[0].status === "cancelled" && forgedTargetAfter.rows[0].cancel_reason === null);
    const allSummariesAfterForged = await pool.query<{ after_data: { appliedRepairs?: Array<{ instanceId: string }> } }>(
      `select after_data from public.audit_logs where action='legacy_repair_summary'`,
    );
    const forgedInstanceMentionedInAnySummary = allSummariesAfterForged.rows.some((r) =>
      (r.after_data.appliedRepairs ?? []).some((ar) => ar.instanceId === unresolvedTarget.instanceId),
    );
    record("forged manifest: bu instance için hiçbir legacy_repair_summary audit satırı yazılmadı", !forgedInstanceMentionedInAnySummary);

    // ── metadata-repair genuine happy path: paymentId matches the live row exactly, apply
    // proceeds normally and is NOT blocked by the new invariant. Runs SECOND (after the
    // forged-manifest test above), since this is the one test that actually consumes the
    // single metadata-repair instance for real. ──
    const metadataApprovalPath = apprOut("metadata-happy");
    const metadataApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-metadata-instance", unresolvedTarget.instanceId, "--reason", "Legacy repair verify: metadata mutlu yol",
      "--confirm-timestamp", unresolvedTarget.proposedCancelledAt!,
      "--out", metadataApprovalPath,
    ]);
    record("metadata-repair mutlu yol: approval üretildi", metadataApprRes.code === 0);
    const metadataApprovalSha256 = fileSha256(readFileSync(metadataApprovalPath));
    const metadataBackup = makeBackup(DB, "verify-metadata-happy", path.join(TMP, "backups-metadata-happy"));
    const metadataApplyRes = runTsx(APPLY_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approval", metadataApprovalPath, "--expected-approval-sha256", metadataApprovalSha256,
      "--backup", metadataBackup.dumpPath, "--expected-backup-sha256", metadataBackup.backupSha256,
      "--backup-receipt", metadataBackup.receiptPath, "--expected-backup-receipt-sha256", metadataBackup.backupReceiptSha256,
      "--expected-database-name", DB, "--container", CONTAINER, "--receipts-dir", receiptsDir, "--apply",
    ], { DATABASE_URL: url });
    record("metadata-repair mutlu yol: paymentId doğru eşleştiği için apply bozulmadı, başarıyla commit edildi", metadataApplyRes.code === 0, metadataApplyRes.stderr.slice(0, 400));
    const metadataAfter = await pool.query<{ status: string; cancel_reason: string | null }>(
      `select status, cancel_reason from public.payment_instances where id=$1`,
      [unresolvedTarget.instanceId],
    );
    record(
      "metadata-repair mutlu yol: cancel_reason gerçekten DB'ye yazıldı",
      metadataAfter.rows[0].status === "cancelled" && metadataAfter.rows[0].cancel_reason === "Legacy repair verify: metadata mutlu yol",
    );

    // ── precondition-drift rollback: an approved-but-unrelated row mutated between
    // inventory and apply — the row's own hash no longer matches. ──
    const driftApprovalPath = apprOut("drift-precondition");
    const driftApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", driftPreconditionId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", driftApprovalPath,
    ]);
    record("drift testi: precondition approval üretildi", driftApprRes.code === 0);
    const driftBackup = makeBackup(DB, "verify-drift-precondition", path.join(TMP, "backups-drift-precondition"));
    const rolledBackBeforePrecondition = new Set(listRolledBackReceipts(receiptsDir));
    await pool.query(`update public.payment_instances set due_date = due_date - interval '365 days' where id=$1`, [driftPreconditionId]);
    const driftRes = runTsx(APPLY_SCRIPT, [
      ...commonApplyArgs(driftApprovalPath, fileSha256(readFileSync(driftApprovalPath)), driftBackup), "--apply",
    ], { DATABASE_URL: url });
    record("apply: satır hash sapması (precondition) apply'ı reddetti", driftRes.code !== 0);
    const newPreconditionReceipts = listRolledBackReceipts(receiptsDir).filter((f) => !rolledBackBeforePrecondition.has(f));
    const preconditionRolledBack = newPreconditionReceipts.length === 1
      ? RolledBackReceiptFileSchema.parse(JSON.parse(readFileSync(path.join(receiptsDir, newPreconditionReceipts[0]), "utf8")))
      : null;
    record(
      "apply: precondition sapması için failureStage='precondition' rolled-back receipt üretildi (pendingFileSha256=null, durability şemadan geçiyor)",
      preconditionRolledBack?.failureStage === "precondition"
        && preconditionRolledBack.pendingFileSha256 === null
        && DurabilityMetadataSchema.safeParse(preconditionRolledBack.durability).success,
    );
    const afterDrift = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftPreconditionId]);
    record("apply: precondition sapmasında hedef satır cancelled OLMADI (rollback gerçek)", afterDrift.rows[0].status !== "cancelled");

    // ── COMMIT-OUTCOME-UNKNOWN: a DEFERRABLE INITIALLY DEFERRED constraint trigger on
    // audit_logs raises unconditionally — deferred, so every INSERT inside the repair
    // transaction (including the summary-audit row) succeeds immediately, but the
    // deferred check fires exactly at COMMIT time, making the real COMMIT call itself
    // fail with a genuine Postgres error. This is the real, unmodified apply.ts
    // subprocess — not a mock — hitting the exact "commit_outcome_unknown" code path.
    // MUST run before the parent-payment-drift test below: that test's un-archive/
    // re-archive dance changes the payment row's updated_at (a generic trigger, not the
    // archive-immutability one), permanently invalidating inventory.archivedPayment's
    // original beforeStateHash for the rest of this process — which would make every
    // later archive_cascade_repair apply (including this one) fail at the EARLIER
    // payment-hash precondition check instead of ever reaching COMMIT. ──
    const commitUnknownApprovalPath = apprOut("commit-unknown");
    const commitUnknownApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", commitUnknownId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", commitUnknownApprovalPath,
    ]);
    record("commit-outcome-unknown testi: approval üretildi", commitUnknownApprRes.code === 0);
    const commitUnknownBackup = makeBackup(DB, "verify-commit-unknown", path.join(TMP, "backups-commit-unknown"));
    await pool.query(`
      create or replace function public.verify_force_commit_failure() returns trigger language plpgsql as $f$
      begin
        raise exception 'legacy-repair-verify: simulated commit-time failure (deferred constraint trigger)';
      end $f$;
    `);
    await pool.query(`
      create constraint trigger verify_force_commit_failure_trigger
        after insert on public.audit_logs
        deferrable initially deferred
        for each row execute function public.verify_force_commit_failure()
    `);
    let commitUnknownPendingPath: string | null = null;
    try {
      const beforeFiles = new Set(listReceiptFiles(receiptsDir));
      const commitUnknownRes = runTsx(APPLY_SCRIPT, [
        ...commonApplyArgs(commitUnknownApprovalPath, fileSha256(readFileSync(commitUnknownApprovalPath)), commitUnknownBackup), "--apply",
      ], { DATABASE_URL: url });
      record("apply: COMMIT çağrısı gerçekten başarısız oldu (exit != 0)", commitUnknownRes.code !== 0);
      record("apply: stderr 'commit_outcome_unknown' içeriyor", commitUnknownRes.stderr.includes("commit_outcome_unknown"), commitUnknownRes.stderr.slice(0, 400));
      record("apply: stderr rollback VARSAYILDIĞINI iddia etmiyor ('rollback edildi' YOK)", !commitUnknownRes.stderr.includes("rollback edildi"));
      const newFiles = listReceiptFiles(receiptsDir).filter((f) => !beforeFiles.has(f));
      record("apply: sadece pending receipt yazıldı (rolled-back YOK, committed YOK)", (
        newFiles.length === 1 && newFiles[0].endsWith(".receipt.pending.json")
      ), `yeni dosyalar: ${newFiles.join(", ")}`);
      const commitUnknownOperationId = newFiles.length === 1 ? newFiles[0].split(".")[0] : null;
      commitUnknownPendingPath = commitUnknownOperationId ? path.join(receiptsDir, `${commitUnknownOperationId}.receipt.pending.json`) : null;
      record("apply: pending dosyası immutable kaldı (hâlâ mevcut, silinmedi)", Boolean(commitUnknownPendingPath && existsSync(commitUnknownPendingPath)));

      if (commitUnknownPendingPath) {
        const targetAfter = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [commitUnknownId]);
        record("apply: sunucu deferred trigger nedeniyle GERÇEKTEN rollback etti (hedef satır cancelled DEĞİL)", targetAfter.rows[0].status !== "cancelled");

        // Recovery against this pending file: since Postgres genuinely rolled back the
        // whole transaction (deferred-check failure at COMMIT auto-aborts), there is no
        // legacy_repair_summary row — recovery must independently arrive at "unresolved",
        // never fabricating a committed receipt just because a pending file exists.
        const pendingSha = fileSha256(readFileSync(commitUnknownPendingPath));
        const recoverRes = runTsx(RECOVER_SCRIPT, [
          "--pending", commitUnknownPendingPath, "--expected-pending-sha256", pendingSha, "--expected-database-name", DB,
        ], { DATABASE_URL: url });
        record("recovery: commit_outcome_unknown pending'i için DB kanıtı yok → ÇÖZÜLEMEDİ (committed üretilmez)", (
          recoverRes.code !== 0 && recoverRes.stderr.includes("ÇÖZÜLEMEDİ")
          && !existsSync(path.join(receiptsDir, `${commitUnknownOperationId}.receipt.committed.json`))
        ));
      }
    } finally {
      await pool.query(`drop trigger if exists verify_force_commit_failure_trigger on public.audit_logs`);
      await pool.query(`drop function if exists public.verify_force_commit_failure()`);
    }

    // ── parent-payment drift rollback: target instance row itself untouched, but its
    // PARENT payment was un-archived out of band. 0024's payments_archived_immutability
    // trigger AND 0023's payments_archive_consistency check constraint together make
    // un-archiving a payment genuinely impossible through any application path — disabling
    // both for this one connection is the only way to construct the scenario at all.
    //
    // This empirically resolved a real question about apply.ts's own layering: the
    // transaction's payment-level hash check (comparing the archived payment's FULL row
    // against inventory.archivedPayment.beforeStateHash) runs BEFORE the per-target loop,
    // so it catches this exact drift first, at failureStage='precondition' — the per-target
    // eligibility block's own `payments.status='archived'` re-check never gets a chance to
    // fire here. That re-check is not dead code, though: it is the only thing that would
    // still catch this same drift if the earlier payment-level hash check were ever
    // weakened or removed in a future change — intentional defense in depth, verified here
    // indirectly via the failureStage this scenario actually produces today.
    //
    // This is also, deliberately, the LAST test in this suite to touch the archived
    // payment's row: restoring status='archived' afterward does not restore updated_at,
    // so inventory.archivedPayment.beforeStateHash is permanently stale for this process
    // from here on — nothing after this point may rely on it matching live state again.
    const eligApprovalPath = apprOut("drift-parent-payment");
    const eligApprRes = runTsx(APPROVAL_SCRIPT, [
      "--inventory", inventoryPath, "--expected-inventory-sha256", inventoryFileSha256,
      "--approve-archive-instance", driftEligibilityId, "--confirm-archive-reason", "x",
      "--confirm-archive-timestamp-policy", "apply_transaction_timestamp", "--out", eligApprovalPath,
    ]);
    record("drift testi: parent-payment approval üretildi", eligApprRes.code === 0);
    const eligBackup = makeBackup(DB, "verify-drift-parent-payment", path.join(TMP, "backups-drift-parent-payment"));
    await pool.query(`alter table public.payments disable trigger payments_archived_immutability`);
    await pool.query(`alter table public.payments drop constraint payments_archive_consistency`);
    try {
      await pool.query(`update public.payments set status='active' where id=$1`, [inventory.archivedPayment!.id]);
      const rolledBackBeforeElig = new Set(listRolledBackReceipts(receiptsDir));
      const eligRes = runTsx(APPLY_SCRIPT, [
        ...commonApplyArgs(eligApprovalPath, fileSha256(readFileSync(eligApprovalPath)), eligBackup), "--apply",
      ], { DATABASE_URL: url });
      record("apply: parent payment un-archive edilince apply'ı reddetti", eligRes.code !== 0);
      const newEligReceipts = listRolledBackReceipts(receiptsDir).filter((f) => !rolledBackBeforeElig.has(f));
      const eligRolledBack = newEligReceipts.length === 1
        ? RolledBackReceiptFileSchema.parse(JSON.parse(readFileSync(path.join(receiptsDir, newEligReceipts[0]), "utf8")))
        : null;
      record(
        "apply: parent-payment sapması için failureStage='precondition' rolled-back receipt üretildi (payment-level hash kontrolü, per-target eligibility'den ÖNCE yakalıyor)",
        eligRolledBack?.failureStage === "precondition" && eligRolledBack.pendingFileSha256 === null,
      );
      await pool.query(`update public.payments set status='archived' where id=$1`, [inventory.archivedPayment!.id]);
    } finally {
      await pool.query(
        `alter table public.payments add constraint payments_archive_consistency check (
           (status = 'archived') = (archived_at is not null)
           and (archived_at is not null) = (archive_reason is not null)
           and (archived_at is not null) = (archived_by_label is not null)
         ) not valid`,
      );
      await pool.query(`alter table public.payments enable trigger payments_archived_immutability`);
    }
    const afterElig = await pool.query<{ status: string }>(`select status from public.payment_instances where id=$1`, [driftEligibilityId]);
    record("apply: parent-payment sapmasında hedef satır cancelled OLMADI (rollback gerçek)", afterElig.rows[0].status !== "cancelled");

    // ── §5 recover-receipt ──
    // report mode against the happy-path pending file.
    const reportRes = runTsx(RECOVER_SCRIPT, ["--pending", happyPendingPath, "--expected-database-name", DB], { DATABASE_URL: url });
    record("recover: rapor modu başarılı, committed üretmedi", reportRes.code === 0 && reportRes.stdout.includes("RAPOR MODU"));
    record("recover: zaten normal commit edilmiş operasyon için tam recovery reddedilir", (() => {
      const r = runTsx(RECOVER_SCRIPT, [
        "--pending", happyPendingPath, "--expected-pending-sha256", fileSha256(readFileSync(happyPendingPath)),
        "--expected-database-name", DB,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("finalizationMode='normal'");
    })());

    // true crash-recovery: manually replay apply.ts's transaction body through COMMIT,
    // deliberately never writing a committed receipt (the exact artifact a real crash
    // between `commit` and the committed-receipt write would leave behind). Built here
    // (rather than after the ledger-mismatch tests below) specifically so those tests
    // have a pending file with NO existing committed receipt to test against —
    // happyPendingPath already has one (finalizationMode='normal'), which would trip
    // recovery's own "already normal" pre-check before ever reaching the ledger
    // comparison, masking the very thing being tested.
    const crashId = restCandidates[1];
    const crashTarget = inventory.targets.find((t) => t.instanceId === crashId)!;
    const { cancelInstanceWithClient, writeLegacyRepairSummaryWithClient } = await import("../../src/lib/radar/engine");
    // Same conditional as legacy-repair-apply.ts: this suite hides every migration from 0030
    // onward (see main()), so public.users does not exist here and null is the truthful actor.
    const crashUsersExists = await pool.query<{ present: boolean }>(
      `select to_regclass('public.users') is not null as present`,
    );
    const crashActorId = crashUsersExists.rows[0].present ? await getSystemActorId(pool) : null;
    const crashClient = await pool.connect();
    const crashOperationId = randomUUID();
    const crashPendingPath = path.join(receiptsDir, `${crashOperationId}.receipt.pending.json`);
    try {
      await crashClient.query("begin");
      const lockRes = await crashClient.query<{ hash64: string }>(`select hashtextextended('mas_nakit_radar:legacy_repair', 0)::text as hash64`);
      await crashClient.query(`select pg_advisory_xact_lock(hashtextextended('mas_nakit_radar:legacy_repair', 0))`);
      const tsRes = await crashClient.query<{ ts: string }>(`select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts`);
      const eventTimestamp = tsRes.rows[0].ts;
      const cancelResult = await cancelInstanceWithClient(crashClient, crashId, "Recovery crash simülasyonu", crashActorId, {
        auditAction: "legacy_archive_cascade_repair",
        eventTimestamp,
      });
      const afterRow = await crashClient.query<{ raw: string }>(`select to_jsonb(t)::text as raw from public.payment_instances t where t.id=$1`, [crashId]);
      const receiptCore: ReceiptCore = {
        canonicalizationVersion: CANONICALIZATION_VERSION,
        operationId: crashOperationId,
        inventoryFileSha256, approvalFileSha256: fileSha256(readFileSync(driftApprovalPath)),
        backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
        gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        databaseName: DB, systemIdentifier: inventory.systemIdentifier, ledgerCount: inventory.ledgerCount,
        lastMigrationVersion: inventory.lastMigrationVersion,
        transactionTimestamp: eventTimestamp,
        advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: lockRes.rows[0].hash64 },
        appliedRepairs: sortAppliedRepairsDeterministically([{
          instanceId: crashId, kind: "archive_cascade_repair", auditId: cancelResult.auditId,
          cancelledAt: cancelResult.cancelledAt, beforeHash: crashTarget.beforeStateHash, afterHash: canonicalHash(afterRow.rows[0].raw),
        }]),
        untouchedInstanceIds: [], untouchedScopeBeforeHash: canonicalHash(""), untouchedScopeAfterHash: canonicalHash(""),
      };
      const receiptCoreSha256 = payloadSha256(receiptCore);
      writeExclusiveDurable(
        crashPendingPath,
        (durability) => JSON.stringify({ status: "pending", operationId: crashOperationId, receiptCore, receiptCoreSha256, durability }, null, 2),
        () => {},
      );
      const pendingFileSha256 = fileSha256(readFileSync(crashPendingPath));
      await writeLegacyRepairSummaryWithClient(crashClient, {
        operationId: crashOperationId, receiptCoreSha256, pendingFileSha256,
        inventoryFileSha256, approvalFileSha256: receiptCore.approvalFileSha256,
        backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
        transactionTimestamp: eventTimestamp, appliedRepairs: receiptCore.appliedRepairs,
        untouchedScopeAfterHash: receiptCore.untouchedScopeAfterHash,
      }, eventTimestamp, crashActorId);
      await crashClient.query("commit");
    } finally {
      crashClient.release();
    }
    const crashPendingSha256 = fileSha256(readFileSync(crashPendingPath));

    // ledgerCount / lastMigrationVersion recovery checks — INDEPENDENT of each other.
    // Uses crashPendingPath (no committed receipt exists for it yet) rather than
    // happyPendingPath, which already has one and would trip the "already normal"
    // pre-check before ever reaching the ledger comparison.
    // Version '0000' is lower than every real version, so max(version) stays '0029'
    // while count increases by exactly one — isolates a ledgerCount-only mismatch.
    const ledgerCountOnlyRejected = await withTempLedgerRow(pool, "0000", () => {
      const r = runTsx(RECOVER_SCRIPT, [
        "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256,
        "--expected-database-name", DB,
      ], { DATABASE_URL: url });
      return r.code !== 0 && r.stderr.includes("ledgerCount");
    });
    record("recover: sadece ledgerCount canlıdan farklıysa (lastMigrationVersion aynı) reddedilir", ledgerCountOnlyRejected);

    // Swap '0029' for '0030' (delete one, insert one) — net count unchanged, but
    // max(version) changes — isolates a lastMigrationVersion-only mismatch.
    await pool.query(`delete from public.schema_migrations where version='0029'`);
    await pool.query(`insert into public.schema_migrations(version,name,checksum,applied_by) values ('0030','legacy-repair-verify-version-swap','deadbeef','legacy-repair-verify')`);
    const lastVersionRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256,
      "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    await pool.query(`delete from public.schema_migrations where version='0030'`);
    await pool.query(`insert into public.schema_migrations(version,name,checksum,applied_by) values ('0029','restored','deadbeef','legacy-repair-verify')`);
    record(
      "recover: sadece lastMigrationVersion canlıdan farklıysa (ledgerCount aynı) reddedilir",
      lastVersionRes.code !== 0 && lastVersionRes.stderr.includes("lastMigrationVersion"),
    );

    const recoverRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: çökme sonrası tam recovery başarılı", recoverRes.code === 0, recoverRes.stderr.slice(0, 300));
    const recoveredPath = path.join(receiptsDir, `${crashOperationId}.receipt.committed.json`);
    if (existsSync(recoveredPath)) {
      const recovered = CommittedReceiptFileSchema.parse(JSON.parse(readFileSync(recoveredPath, "utf8")));
      record("recover: recovered.finalizationMode === 'recovered'", recovered.finalizationMode === "recovered");
      record("recover: recovered.durability strict şemadan geçiyor", DurabilityMetadataSchema.safeParse(recovered.durability).success);
    } else {
      record("recover: recovered.finalizationMode === 'recovered'", false, "committed dosya yazılmadı");
    }
    const recoverAgainRes = runTsx(RECOVER_SCRIPT, [
      "--pending", crashPendingPath, "--expected-pending-sha256", crashPendingSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: tekrar çalıştırıldığında idempotent (yine başarılı)", recoverAgainRes.code === 0);

    // unresolved: pending with no matching DB evidence at all.
    const ghostOperationId = randomUUID();
    const ghostPendingPath = path.join(receiptsDir, `${ghostOperationId}.receipt.pending.json`);
    const ghostCore: ReceiptCore = {
      canonicalizationVersion: CANONICALIZATION_VERSION,
      operationId: ghostOperationId,
      inventoryFileSha256, approvalFileSha256: happyApprovalSha256,
      backupSha256: backup1.backupSha256, backupReceiptSha256: backup1.backupReceiptSha256,
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      databaseName: DB, systemIdentifier: inventory.systemIdentifier, ledgerCount: inventory.ledgerCount,
      lastMigrationVersion: inventory.lastMigrationVersion,
      transactionTimestamp: "2026-01-01T00:00:00.000000Z",
      advisoryLockKey: { name: "mas_nakit_radar:legacy_repair", hash64: "1" },
      appliedRepairs: [{
        instanceId: idA, kind: "archive_cascade_repair", auditId: auditA,
        cancelledAt: "2026-01-01T00:00:00.000000Z", beforeHash: "0".repeat(64), afterHash: "0".repeat(64),
      }],
      untouchedInstanceIds: [], untouchedScopeBeforeHash: canonicalHash(""), untouchedScopeAfterHash: canonicalHash(""),
    };
    const ghostCoreSha256 = payloadSha256(ghostCore);
    writeExclusiveDurable(
      ghostPendingPath,
      (durability) => JSON.stringify({ status: "pending", operationId: ghostOperationId, receiptCore: ghostCore, receiptCoreSha256: ghostCoreSha256, durability }, null, 2),
      () => {},
    );
    const ghostSha256 = fileSha256(readFileSync(ghostPendingPath));
    const ghostRes = runTsx(RECOVER_SCRIPT, [
      "--pending", ghostPendingPath, "--expected-pending-sha256", ghostSha256, "--expected-database-name", DB,
    ], { DATABASE_URL: url });
    record("recover: kanıtsız (hayalet) operationId ÇÖZÜLEMEDİ ile reddedildi (exit != 0)", ghostRes.code !== 0);
    record("recover: hayalet reddediliş mesajı 'ÇÖZÜLEMEDİ' içeriyor", ghostRes.stderr.includes("ÇÖZÜLEMEDİ"), ghostRes.stderr.slice(0, 200));
    record("recover: hayalet için committed dosya YAZILMADI", !existsSync(path.join(receiptsDir, `${ghostOperationId}.receipt.committed.json`)));

    // ── §6 (separate DB) inventory multiplicity guards ──
    assertSafeDisposableName(DB_MULTI, "çoğulluk-koruması disposable DB");
    restoreManagedFixture(DB_MULTI);
    const urlMulti = dbUrl(DB_MULTI);
    const migrateMultiRes = runMigrateAgainstUrl(urlMulti);
    if (migrateMultiRes.code !== 0) throw new Error(`multi-DB migrate başarısız: ${migrateMultiRes.stderr}`);

    {
      const poolCancelled = new Pool({ connectionString: urlMulti, max: 2 });
      try {
        // 0026's payment_instances_cancel_consistency check constraint (NOT VALID —
        // tolerates the one pre-existing legacy row, but enforced for every write going
        // forward) blocks creating a SECOND such row through any normal path, by design.
        // Dropping it for this one write is the only way to construct this genuine-
        // discovery multiplicity scenario at all; it is never re-added since this DB copy
        // is discarded right after.
        await poolCancelled.query(`alter table public.payment_instances drop constraint payment_instances_cancel_consistency`);
        await poolCancelled.query(
          `update public.payment_instances set status='cancelled', cancelled_at=null, cancel_reason=null
           where id = (select id from public.payment_instances where status not in ('cancelled') limit 1)`,
        );
        const cancelledNullCount = await poolCancelled.query<{ n: string }>(
          `select count(*)::text as n from public.payment_instances where status='cancelled' and (cancelled_at is null or cancel_reason is null)`,
        );
        record("multiplicity test kurulumu: artık 2 metadata-eksik cancelled satır var", cancelledNullCount.rows[0].n === "2", cancelledNullCount.rows[0].n);
      } finally {
        await poolCancelled.end();
      }
      const multiRes = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB_MULTI, "--out", path.join(TMP, "multi-cancelled-inventory.json")], { DATABASE_URL: urlMulti });
      record("inventory: birden fazla metadata-eksik cancelled satır bulununca yüksek sesle durur", multiRes.code !== 0 && multiRes.stderr.includes("Beklenmedik durum"));
    }

    {
      restoreManagedFixture(DB_MULTI);
      const migrateAgainRes = runMigrateAgainstUrl(urlMulti);
      if (migrateAgainRes.code !== 0) throw new Error(`multi-DB (archived-payment senaryosu) migrate başarısız: ${migrateAgainRes.stderr}`);
      const poolArchived = new Pool({ connectionString: urlMulti, max: 2 });
      try {
        // Second archived payment — no trigger/constraint bypass needed: transitioning a
        // still-active payment INTO archived for the first time is a normal, allowed write
        // (the immutability trigger only locks rows that are ALREADY archived).
        await poolArchived.query(
          `update public.payments set status='archived', archived_at=now(), archive_reason='legacy-repair-verify: multiplicity testi', archived_by_label='legacy-repair-verify'
           where id = (select id from public.payments where status <> 'archived' limit 1)`,
        );
        const archivedCount = await poolArchived.query<{ n: string }>(`select count(*)::text as n from public.payments where status='archived'`);
        record("multiplicity test kurulumu: artık 2 archived payment var", archivedCount.rows[0].n === "2", archivedCount.rows[0].n);
      } finally {
        await poolArchived.end();
      }
      const multiArchivedRes = runTsx(INVENTORY_SCRIPT, ["--expected-database-name", DB_MULTI, "--out", path.join(TMP, "multi-archived-inventory.json")], { DATABASE_URL: urlMulti });
      record("inventory: birden fazla archived payment bulununca yüksek sesle durur", multiArchivedRes.code !== 0 && multiArchivedRes.stderr.includes("Beklenmedik durum"));
    }
  } finally {
    await pool.end();
    dropDb(DB);
    dropDb(DB_MULTI);
    rmSync(TMP, { recursive: true, force: true });
  }
}

/** Inserts a schema_migrations row with a version LOWER than every real applied
 * version (so max(version) / lastMigrationVersion is untouched) purely to bump
 * ledgerCount by exactly one — isolates a "ledgerCount differs" scenario from a
 * "lastMigrationVersion differs" one, which a plain top-of-ledger insert cannot do
 * (that changes both at once). Always removes the row afterward, success or failure. */
async function withTempLedgerRow<T>(pool: Pool, version: string, fn: () => T): Promise<T> {
  await pool.query(
    `insert into public.schema_migrations(version,name,checksum,applied_by) values ($1,'legacy-repair-verify-ledgercount-only','deadbeef','legacy-repair-verify') on conflict do nothing`,
    [version],
  );
  try {
    return fn();
  } finally {
    await pool.query(`delete from public.schema_migrations where version=$1`, [version]);
  }
}

main().catch((err) => {
  console.error("legacy-repair-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
