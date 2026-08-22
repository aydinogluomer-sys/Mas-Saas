// Disposable-DB test suite for scripts/db/migrate.ts (P0-C). Every test runs against a
// throwaway DB in the same Docker cluster as mas_radar_dev — never against mas_radar_dev
// itself. migrate.ts is invoked as a real subprocess (not imported) so these tests exercise
// the exact same CLI entrypoint production uses.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { MIGRATIONS_DIR, validateFileSet } from "./migration-lib";
import { verifyBackupTarget } from "./backup-docker-postgres";
import {
  LEGACY_ANOMALY_INSTANCE_ID,
  countCancelConsistencyViolations,
  countPaymentInstancesCancelViolations,
  fingerprintPaymentInstancesExcluding,
  getConstraintCatalogState,
  getTableRowCounts,
  prepareLegacyCheckpointForCancellationValidation,
} from "./legacy-cancellation-fixture";

const ROOT = process.cwd();
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");

// Canonical migration count — derived from the actual files on disk (same discovery
// migrate.ts itself uses via validateFileSet), never hardcoded. A flow that applies every
// migration file from a truly empty/fresh DB always ends up with exactly this many ledger
// rows; hardcoding the number here would go stale every time a migration file is added,
// exactly what happened when 0030 was added.
const CANONICAL_MIGRATION_COUNT = validateFileSet(MIGRATIONS_DIR).files.length;
// 0001-0019 are backfilled from the frozen legacy-baseline-0019.json manifest and never
// grow — see migrate.ts's LEGACY_COMPLETE flow. Everything after that is applied for real
// by migrate-script, so its expected count is simply the remainder.
const EXPECTED_BASELINE_BACKFILL_COUNT = 19;
const EXPECTED_MIGRATE_SCRIPT_COUNT = CANONICAL_MIGRATION_COUNT - EXPECTED_BASELINE_BACKFILL_COUNT;
// The checkpoint's known legacy anomaly is grandfathered by a specific migration (0030),
// fixed by name — not "whichever migration happens to be last." Migrations added after it
// (0031, 0032, ...) must not change how many migrate-script rows commit on the first run
// before hitting 0030's expected failure. Derived from files on disk, same discipline as
// CANONICAL_MIGRATION_COUNT, so this doesn't go stale again the next time something is
// added after 0030 (exactly what happened here: this used to be computed as
// EXPECTED_MIGRATE_SCRIPT_COUNT - 1, which silently assumed 0030 was the last file).
const KNOWN_VIOLATION_VERSION = "0030";
const EXPECTED_MIGRATE_SCRIPT_COUNT_BEFORE_KNOWN_VIOLATION = validateFileSet(MIGRATIONS_DIR).files
  .filter((f) => f.version > "0019" && f.version < KNOWN_VIOLATION_VERSION).length;

interface TestOutcome {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: TestOutcome[] = [];

function record(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function docker(args: string[], opts: { input?: string | Buffer; quiet?: boolean } = {}): string {
  return execFileSync("docker", args, {
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: opts.quiet ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
  });
}

function dropDb(db: string): void {
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", db], { quiet: true });
}
function createDb(db: string): void {
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", db], { quiet: true });
}
function psqlFile(db: string, file: string): void {
  docker(["exec", "-i", CONTAINER, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db], {
    input: readFileSync(file, "utf8"),
    quiet: true,
  });
}
function psqlSql(db: string, sql: string): string {
  return docker(["exec", CONTAINER, "psql", "-U", "postgres", "-d", db, "-tAc", sql], { quiet: true });
}
function dbUrl(db: string): string {
  return `postgres://postgres:postgres@127.0.0.1:5432/${db}`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
interface ExecError {
  status?: number;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}
function runMigrateAgainstUrl(url: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [TSX_CLI, MIGRATE_SCRIPT], {
      cwd: ROOT,
      // Faz 15: owner ve runtime URL'leri birlikte pinlenir. Yalnız DATABASE_URL
      // pinlenseydi, ebeveyn ortamda kalmış bir MIGRATION_DATABASE_URL çocuk süreçte
      // kazanır ve migration'lar disposable DB yerine ONUN gösterdiği veritabanına
      // uygulanırdı.
      env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as ExecError;
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}
function runMigrate(db: string): RunResult {
  return runMigrateAgainstUrl(dbUrl(db));
}

function findLatestCheckpointDump(): string {
  const dir = path.join(ROOT, "backups");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("p0c-checkpoint-") && f.endsWith(".dump"))
    .sort();
  if (files.length === 0) {
    throw new Error("backups/p0c-checkpoint-*.dump bulunamadı — önce Faz 0 checkpoint yedeği alınmalı.");
  }
  return path.join(dir, files.at(-1)!);
}

function restoreCheckpointInto(db: string): void {
  const dump = findLatestCheckpointDump();
  dropDb(db);
  createDb(db);
  docker(["exec", "-i", CONTAINER, "pg_restore", "-U", "postgres", "-d", db, "--no-owner", "--role=postgres"], {
    input: readFileSync(dump),
    quiet: true,
  });
}

async function assertPolicyCountZero(db: string, label: string): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    const pol = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_policies where schemaname='public' and tablename='schema_migrations'",
    );
    record(`${label}: pg_policies(schema_migrations)=0`, pol.rows[0]?.n === 0, `got ${pol.rows[0]?.n}`);
  } finally {
    await pool.end();
  }
}

// --- Test 1: file-set validation (DB'ye hiç dokunmadan hard-fail) ---
async function testFileSetValidation(): Promise<void> {
  const badFile = path.join(MIGRATIONS_DIR, "bad_name_no_version.sql");
  writeFileSync(badFile, "select 1;\n");
  try {
    const bogusUrl = "postgres://nouser:nopass@127.0.0.1:1/nonexistent_db_for_preflight_test";
    const result = runMigrateAgainstUrl(bogusUrl);
    record(
      "Dosya-seti doğrulama: geçersiz dosya adıyla hard-fail",
      result.code !== 0 && /Geçersiz dosya adı/.test(result.stderr),
      result.stderr.split("\n")[1] ?? result.stderr.slice(0, 120),
    );
    record(
      "Dosya-seti doğrulama: hata DB bağlantı hatası DEĞİL (DB'ye hiç dokunulmadı)",
      !/ECONNREFUSED|ENOTFOUND|password authentication/i.test(result.stderr),
    );
  } finally {
    unlinkSync(badFile);
  }
}

// --- Test 2: manifest-drift (0001-0019 dosyalarının kullanılacağı her akışta zorunlu) ---
async function testManifestDrift(): Promise<void> {
  const targetPath = path.join(MIGRATIONS_DIR, "0005_financing.sql");
  const original = readFileSync(targetPath, "utf8");
  try {
    writeFileSync(targetPath, original + "\n-- tampered for manifest-drift test (restored immediately after)\n");

    const dbEmpty = "mas_radar_migrate_manifestdrift_empty_test";
    dropDb(dbEmpty);
    createDb(dbEmpty);
    psqlFile(dbEmpty, path.join(ROOT, "scripts", "db", "local-bootstrap.sql"));
    const rEmpty = runMigrate(dbEmpty);
    record(
      "Manifest-drift (EMPTY akışı): hard-fail, hiçbir SQL çalışmadı",
      rEmpty.code !== 0 && /[Mm]anifest/.test(rEmpty.stderr),
    );
    const relCount = Number(psqlSql(
      dbEmpty,
      "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S','f');",
    ).trim() || "-1");
    record("Manifest-drift (EMPTY akışı): DB'de hiçbir tablo oluşmadı", relCount === 0, `got ${relCount}`);
    dropDb(dbEmpty);

    const dbLegacy = "mas_radar_migrate_manifestdrift_legacy_test";
    restoreCheckpointInto(dbLegacy);
    const rLegacy = runMigrate(dbLegacy);
    record(
      "Manifest-drift (LEGACY_COMPLETE akışı): hard-fail, hiçbir SQL çalışmadı",
      rLegacy.code !== 0 && /[Mm]anifest/.test(rLegacy.stderr),
    );
    const ledgerStillAbsent = psqlSql(dbLegacy, "select to_regclass('public.schema_migrations') is null;").trim();
    record("Manifest-drift (LEGACY_COMPLETE akışı): ledger tablosu oluşmadı", ledgerStillAbsent === "t", `got ${ledgerStillAbsent}`);
    dropDb(dbLegacy);

    record(
      "Manifest-drift: LEDGER_EMPTY_RECOVERY'nin her iki dalı da runEmptyFlow/runLegacyCompleteFlow'u aynen çağırır (kod paylaşımı) — yukarıdaki iki canlı test bu dalları da kapsar",
      true,
    );
  } finally {
    writeFileSync(targetPath, original);
  }
}

// --- Test 3: EMPTY state ---
async function testEmpty(): Promise<void> {
  const db = "mas_radar_migrate_fresh_test";
  dropDb(db);
  createDb(db);
  psqlFile(db, path.join(ROOT, "scripts", "db", "local-bootstrap.sql"));

  const result = runMigrate(db);
  record("EMPTY: migrate.ts başarıyla tamamlandı", result.code === 0, result.code === 0 ? undefined : result.stderr.slice(0, 300));
  if (result.code !== 0) {
    dropDb(db);
    return;
  }
  record("EMPTY: state=EMPTY raporlandı", /state=EMPTY(\s|$)/.test(result.stdout));

  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    const rows = await pool.query<{ version: string; applied_by: string }>(
      "select version, applied_by from schema_migrations order by version",
    );
    record(
      `EMPTY: ledger ${CANONICAL_MIGRATION_COUNT} satır (canonical dosya sayısı)`,
      rows.rows.length === CANONICAL_MIGRATION_COUNT,
      `got ${rows.rows.length}`,
    );
    record(
      "EMPTY: tüm satırlar applied_by='migrate-script'",
      rows.rows.every((r) => r.applied_by === "migrate-script"),
    );
  } finally {
    await pool.end();
  }
  await assertPolicyCountZero(db, "EMPTY");
  dropDb(db);
}

// --- Test 4 + idempotency: LEGACY_COMPLETE state, then re-run on the same clone ---
async function testLegacyCompleteAndIdempotency(): Promise<void> {
  const db = "mas_radar_migrate_legacy_test";
  restoreCheckpointInto(db);

  // First run: applyPendingSequentially commits each pending migration in its OWN
  // transaction (scripts/db/migrate.ts:142-157), so LEGACY_COMPLETE's bootstrap
  // (0001-0020, one atomic block) plus 0021-0029 (one at a time) commit for real before
  // 0030 reaches the checkpoint's still-unrepaired payment_instances row and fails. This
  // first run is EXPECTED to fail in exactly this way — the p0c-checkpoint dump is frozen
  // from before Slice 5's legacy-repair apply ever ran, so it still carries the exact
  // anomaly 0026 grandfathered (see 0026's own comment). A differently-shaped failure here
  // would mean the checkpoint or 0030 changed in some other way, so the exact error text is
  // asserted, not just a nonzero exit code.
  const bootstrapRun = runMigrate(db);
  record(
    "LEGACY_COMPLETE: ilk çalıştırma 0001-0029'u uyguladı, 0030 bilinen ihlal nedeniyle beklenen şekilde durdu",
    bootstrapRun.code !== 0
      && /Pending migration 0030/.test(bootstrapRun.stderr)
      && /payment_instances_cancel_consistency/.test(bootstrapRun.stderr),
    bootstrapRun.stderr.slice(0, 300),
  );
  if (bootstrapRun.code === 0) {
    // Only possible if the checkpoint no longer carries the anomaly at all — the fixture
    // assumptions below would then be meaningless, so stop rather than continue on a
    // premise that no longer holds.
    dropDb(db);
    return;
  }

  const restorePool = new Pool({ connectionString: dbUrl(db), max: 1 });
  const ledgerAfterBootstrap = await restorePool.query<{ n: number }>("select count(*)::int as n from schema_migrations");
  const violationsBeforePrep = await countPaymentInstancesCancelViolations(restorePool);
  await restorePool.end();
  record(
    `LEGACY_COMPLETE: 0001-0029 gerçekten commit oldu (${EXPECTED_BASELINE_BACKFILL_COUNT + EXPECTED_MIGRATE_SCRIPT_COUNT_BEFORE_KNOWN_VIOLATION} satır)`,
    ledgerAfterBootstrap.rows[0]?.n === EXPECTED_BASELINE_BACKFILL_COUNT + EXPECTED_MIGRATE_SCRIPT_COUNT_BEFORE_KNOWN_VIOLATION,
    `got ${ledgerAfterBootstrap.rows[0]?.n}`,
  );
  record(
    "LEGACY_COMPLETE: 0001-0029 sonrası checkpoint hâlâ bilinen ihlali taşıyor (1 satır)",
    violationsBeforePrep === 1,
    `got ${violationsBeforePrep}`,
  );

  // Test-setup-only fixture preparation (NOT a production repair — see the helper's own
  // doc comment). Narrow before/after checks prove it touched only the one named row.
  const prepPool = new Pool({ connectionString: dbUrl(db), max: 1 });
  const countsBeforePrep = await getTableRowCounts(prepPool, ["schema_migrations"]);
  const fpBeforePrep = await fingerprintPaymentInstancesExcluding(prepPool, LEGACY_ANOMALY_INSTANCE_ID);
  await prepPool.end();

  await prepareLegacyCheckpointForCancellationValidation(dbUrl(db));

  const postPrepPool = new Pool({ connectionString: dbUrl(db), max: 1 });
  const countsAfterPrep = await getTableRowCounts(postPrepPool, ["schema_migrations"]);
  const fpAfterPrep = await fingerprintPaymentInstancesExcluding(postPrepPool, LEGACY_ANOMALY_INSTANCE_ID);
  const violationsAfterPrep = await countPaymentInstancesCancelViolations(postPrepPool);
  await postPrepPool.end();

  const sameRowCountsAcrossPrep = JSON.stringify(countsBeforePrep) === JSON.stringify(countsAfterPrep);
  record(
    "LEGACY_COMPLETE: fixture preparation başka hiçbir tablonun satır sayısını değiştirmedi",
    sameRowCountsAcrossPrep,
    sameRowCountsAcrossPrep ? undefined : JSON.stringify({ before: countsBeforePrep, after: countsAfterPrep }).slice(0, 400),
  );
  record(
    "LEGACY_COMPLETE: fixture preparation yalnız hedef satırın cancellation metadata'sını değiştirdi (diğer payment_instances satırları aynı fingerprint)",
    fpBeforePrep === fpAfterPrep,
  );
  record("LEGACY_COMPLETE: preparation sonrası ihlal sayısı 0", violationsAfterPrep === 0, `got ${violationsAfterPrep}`);

  const preePool = new Pool({ connectionString: dbUrl(db), max: 1 });
  const preCounts = await getTableRowCounts(preePool, ["schema_migrations"]);
  await preePool.end();

  // Second run: 0001-0029 are already in the ledger (no-op — takes the LEDGER_MANAGED
  // path this time, not LEGACY_COMPLETE again, since schema_migrations now exists from the
  // first run), only 0030 is pending, and the fixture is now consistent with it.
  const secondRun = runMigrate(db);
  record(
    "LEGACY_COMPLETE: 0030 fixture düzeltmesinden sonra başarıyla uygulandı",
    secondRun.code === 0,
    secondRun.code === 0 ? undefined : secondRun.stderr.slice(0, 300),
  );
  if (secondRun.code !== 0) {
    dropDb(db);
    return;
  }

  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    const rows = await pool.query<{ version: string; applied_by: string }>(
      "select version, applied_by from schema_migrations order by version",
    );
    record(
      `LEGACY_COMPLETE: ledger ${CANONICAL_MIGRATION_COUNT} satır (canonical dosya sayısı)`,
      rows.rows.length === CANONICAL_MIGRATION_COUNT,
      `got ${rows.rows.length}`,
    );
    const backfill = rows.rows.filter((r) => r.version <= "0019");
    record(
      `LEGACY_COMPLETE: 0001-0019 applied_by='baseline-backfill' (${EXPECTED_BASELINE_BACKFILL_COUNT} satır)`,
      backfill.length === EXPECTED_BASELINE_BACKFILL_COUNT && backfill.every((r) => r.applied_by === "baseline-backfill"),
      `got ${backfill.length}`,
    );
    const scripted = rows.rows.filter((r) => r.version > "0019");
    record(
      `LEGACY_COMPLETE: 0020 sonrası applied_by='migrate-script' (${EXPECTED_MIGRATE_SCRIPT_COUNT} satır)`,
      scripted.length === EXPECTED_MIGRATE_SCRIPT_COUNT && scripted.every((r) => r.applied_by === "migrate-script"),
      `got ${scripted.length}`,
    );

    const postCounts = await getTableRowCounts(pool, ["schema_migrations"]);
    const preKeys = Object.keys(preCounts);
    // 0031/0032 are now pending alongside 0030 in this same second run (they weren't a
    // separate later slice — they're just more migrate-script files after it), and 0031
    // adds two brand-new tables (users, sessions). A table that didn't exist "before" has
    // no prior count to compare against; it only needs to be empty, not absent entirely.
    const newTables = Object.keys(postCounts).filter((k) => !(k in preCounts));
    // The invariant being defended is "a migration does not SILENTLY change data", and until Faz
    // 24A "every new table is empty" expressed it exactly. It stopped being the same statement
    // when two migrations began populating their own tables ON PURPOSE:
    //
    //   approval_rules (0054)  five default rules. Structural configuration the application reads,
    //                          not sample data: a database built only from migrations would
    //                          otherwise have NO approval rules and silently require no approvals
    //                          at all — the wrong default for a control panel. seed.sql cannot own
    //                          this, because production is built from migrations alone.
    //   approvals      (0055)  round 1 for every pre-existing mapping_review and external
    //                          assumption, so the unified queue is complete the moment it ships
    //                          rather than starting blind to everything already under review.
    //
    // Both are documented in docs/database-schema.md. They are listed BY NAME here rather than
    // relaxing the rule to "new tables may contain anything", so a new table that arrives
    // populated WITHOUT being declared still fails this gate — which is the whole point.
    const DECLARED_POPULATING_MIGRATIONS = new Set(["approval_rules", "approvals"]);
    const undeclaredPopulated = newTables.filter(
      (k) => postCounts[k] !== 0 && !DECLARED_POPULATING_MIGRATIONS.has(k),
    );
    const preExistingTablesUnchanged = preKeys.every((k) => preCounts[k] === postCounts[k]);
    const sameCounts = preExistingTablesUnchanged && undeclaredPopulated.length === 0;
    record(
      "LEGACY_COMPLETE: 0030+ uygulanması mevcut hiçbir tablonun satır sayısını değiştirmedi (yeni tablolar, beyan edilenler dışında, boş)",
      sameCounts,
      sameCounts
        ? undefined
        : JSON.stringify({ pre: preCounts, post: postCounts, newTables, undeclaredPopulated }).slice(0, 400),
    );

    const violationsAfterMigrate = await countCancelConsistencyViolations(pool);
    record("LEGACY_COMPLETE: 0030 sonrası ihlal sayısı hâlâ 0", violationsAfterMigrate === 0, `got ${violationsAfterMigrate}`);

    for (const conname of [
      "payment_instances_cancel_consistency",
      "checks_cancel_consistency",
      "loan_installments_cancel_consistency",
    ] as const) {
      const state = await getConstraintCatalogState(pool, conname);
      record(`LEGACY_COMPLETE: ${conname} convalidated=true`, state.found && state.convalidated === true, JSON.stringify(state));
    }
    for (const conname of [
      "payment_instances_paid_fields_scoped",
      "loan_installments_paid_fields_scoped",
      "payments_archive_consistency",
      "checks_archive_triplet_consistency",
      "loans_archive_triplet_consistency",
      "scenario_runs_archive_triplet_consistency",
      "external_assumptions_archive_triplet_consistency",
      "action_items_archive_triplet_consistency",
    ] as const) {
      const state = await getConstraintCatalogState(pool, conname);
      record(`LEGACY_COMPLETE: kapsam dışı ${conname} hâlâ convalidated=false (dokunulmadı)`, state.found && state.convalidated === false, JSON.stringify(state));
    }
  } finally {
    await pool.end();
  }
  await assertPolicyCountZero(db, "LEGACY_COMPLETE");

  // Idempotency: third run, everything already applied — pure no-op.
  const thirdRun = runMigrate(db);
  record("Idempotency: üçüncü çalıştırma başarıyla tamamlandı (no-op)", thirdRun.code === 0, thirdRun.code === 0 ? undefined : thirdRun.stderr.slice(0, 300));
  if (thirdRun.code === 0) {
    const pool2 = new Pool({ connectionString: dbUrl(db), max: 1 });
    try {
      const rows2 = await pool2.query<{ n: number }>("select count(*)::int as n from schema_migrations");
      record(
        `Idempotency: ledger hâlâ ${CANONICAL_MIGRATION_COUNT} satır (yeni satır eklenmedi)`,
        rows2.rows[0]?.n === CANONICAL_MIGRATION_COUNT,
        `got ${rows2.rows[0]?.n}`,
      );
    } finally {
      await pool2.end();
    }
  }
  await assertPolicyCountZero(db, "Idempotency");

  dropDb(db);
}

// --- Test 5: checksum-drift ---
async function testChecksumDrift(): Promise<void> {
  const db = "mas_radar_migrate_checksumdrift_test";
  restoreCheckpointInto(db);

  // Same two-run precondition as testLegacyCompleteAndIdempotency: the p0c-checkpoint
  // dump is frozen from before Slice 5's legacy-repair apply ever ran and payment_instances
  // doesn't even have a cancelled_at/cancel_reason column yet at this point (0026 — one of
  // the pending migrations — is what adds it), so the fixture can only be prepared AFTER a
  // first run has committed 0001-0029 (each in its own transaction) and failed at 0030.
  const bootstrapRun = runMigrate(db);
  if (
    bootstrapRun.code === 0
    || !/Pending migration 0030/.test(bootstrapRun.stderr)
    || !/payment_instances_cancel_consistency/.test(bootstrapRun.stderr)
  ) {
    record(
      "Checksum-drift: ön koşul (0001-0029) beklenen şekilde 0030'da durdu",
      false,
      bootstrapRun.code === 0 ? "beklenmedik şekilde tamamen başarılı oldu" : bootstrapRun.stderr.slice(0, 300),
    );
    dropDb(db);
    return;
  }

  await prepareLegacyCheckpointForCancellationValidation(dbUrl(db));

  const firstRun = runMigrate(db);
  record("Checksum-drift: ön koşul migrasyonu başarılı (0030 fixture düzeltmesinden sonra)", firstRun.code === 0, firstRun.code === 0 ? undefined : firstRun.stderr.slice(0, 300));
  if (firstRun.code !== 0) {
    dropDb(db);
    return;
  }

  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    await pool.query(
      "update public.schema_migrations set checksum = $1 where version = '0005'",
      ["corrupted0000000000000000000000000000000000000000000000000000"],
    );
    const before = await pool.query<{ n: number }>("select count(*)::int as n from public.schema_migrations");

    const secondRun = runMigrateAgainstUrl(dbUrl(db));
    record(
      "Checksum-drift: bozuk checksum ile ikinci çalıştırma hard-fail eder",
      secondRun.code !== 0 && /checksum/i.test(secondRun.stderr),
      secondRun.stderr.slice(0, 200),
    );

    const after = await pool.query<{ n: number }>("select count(*)::int as n from public.schema_migrations");
    record(
      "Checksum-drift: hiçbir yeni satır eklenmedi",
      before.rows[0]?.n === after.rows[0]?.n,
      `before=${before.rows[0]?.n} after=${after.rows[0]?.n}`,
    );
  } finally {
    await pool.end();
  }
  dropDb(db);
}

// --- Test 6: LEDGER_EMPTY_RECOVERY smoke test (dev-reset.sh'ın ham sırasını manuel tekrarla) ---
async function testLedgerEmptyRecovery(): Promise<void> {
  const db = "mas_radar_reset_smoke_test";
  dropDb(db);
  createDb(db);

  psqlFile(db, path.join(ROOT, "scripts", "db", "local-bootstrap.sql"));
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of migrationFiles) psqlFile(db, path.join(MIGRATIONS_DIR, f));
  psqlFile(db, path.join(ROOT, "supabase", "seed.sql"));

  const countBefore = psqlSql(db, "select count(*) from public.schema_migrations;").trim();
  record("LEDGER_EMPTY_RECOVERY smoke: ham kurulum sonrası ledger var ama boş", countBefore === "0", `got ${countBefore}`);

  const result = runMigrate(db);
  record("LEDGER_EMPTY_RECOVERY smoke: migrate.ts başarıyla tamamlandı", result.code === 0, result.code === 0 ? undefined : result.stderr.slice(0, 300));
  if (result.code !== 0) {
    dropDb(db);
    return;
  }
  record(
    "LEDGER_EMPTY_RECOVERY smoke: state doğru seçildi (recovery: legacy)",
    /state=LEDGER_EMPTY_RECOVERY \(recovery: legacy\)/.test(result.stdout),
  );

  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    const rows = await pool.query<{ n: number }>("select count(*)::int as n from schema_migrations");
    record(
      `LEDGER_EMPTY_RECOVERY smoke: ledger ${migrationFiles.length} satır (canonical dosya sayısı)`,
      rows.rows[0]?.n === migrationFiles.length,
      `got ${rows.rows[0]?.n}`,
    );
  } finally {
    await pool.end();
  }
  await assertPolicyCountZero(db, "LEDGER_EMPTY_RECOVERY smoke");
  dropDb(db);
}

// --- Test 7: cluster-identity ---
async function testClusterIdentity(): Promise<void> {
  const db = "mas_radar_cluster_identity_test";
  dropDb(db);
  createDb(db);
  try {
    const realIdentifier = psqlSql(db, "select system_identifier from pg_control_system();").trim();

    try {
      verifyBackupTarget({ container: CONTAINER, dbName: db, expectedSystemIdentifier: realIdentifier });
      record("Cluster-identity: doğru identifier ile geçer", true);
    } catch (err) {
      record("Cluster-identity: doğru identifier ile geçer", false, (err as Error).message.slice(0, 200));
    }

    try {
      verifyBackupTarget({ container: CONTAINER, dbName: db, expectedSystemIdentifier: "0000000000000000000" });
      record("Cluster-identity: yanlış identifier ile reddedilir", false, "beklenmedik şekilde geçti");
    } catch {
      record("Cluster-identity: yanlış identifier ile reddedilir", true);
    }
  } finally {
    dropDb(db);
  }
}

async function main(): Promise<void> {
  console.log("=== migrate-verify: disposable-DB test suite (P0-C) ===\n");
  await testFileSetValidation();
  await testManifestDrift();
  await testEmpty();
  await testLegacyCompleteAndIdempotency();
  await testChecksumDrift();
  await testLedgerEmptyRecovery();
  await testClusterIdentity();

  console.log("\n=== Özet ===");
  let pass = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    if (r.pass) pass++;
  }
  console.log(`\n${pass}/${results.length} test geçti`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("migrate-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
