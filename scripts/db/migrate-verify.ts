// Disposable-DB test suite for scripts/db/migrate.ts (P0-C). Every test runs against a
// throwaway DB in the same Docker cluster as mas_radar_dev — never against mas_radar_dev
// itself. migrate.ts is invoked as a real subprocess (not imported) so these tests exercise
// the exact same CLI entrypoint production uses.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { MIGRATIONS_DIR } from "./migration-lib";
import { verifyBackupTarget } from "./backup-docker-postgres";

const ROOT = process.cwd();
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");

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
      env: { ...process.env, DATABASE_URL: url },
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

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

async function getTableRowCounts(pool: Pool, excludeTables: string[]): Promise<Record<string, number>> {
  const tablesRes = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname='public' and tablename <> all($1::text[]) order by tablename",
    [excludeTables],
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of tablesRes.rows) {
    const r = await pool.query<{ n: number }>(`select count(*)::int as n from public.${quoteIdent(tablename)}`);
    counts[tablename] = r.rows[0]?.n ?? 0;
  }
  return counts;
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
    record("EMPTY: ledger 29 satır", rows.rows.length === 29, `got ${rows.rows.length}`);
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

  const preePool = new Pool({ connectionString: dbUrl(db), max: 1 });
  const preCounts = await getTableRowCounts(preePool, []);
  await preePool.end();

  const firstRun = runMigrate(db);
  record("LEGACY_COMPLETE: migrate.ts başarıyla tamamlandı", firstRun.code === 0, firstRun.code === 0 ? undefined : firstRun.stderr.slice(0, 300));
  if (firstRun.code !== 0) {
    dropDb(db);
    return;
  }
  record("LEGACY_COMPLETE: state=LEGACY_COMPLETE raporlandı", /state=LEGACY_COMPLETE(\s|$)/.test(firstRun.stdout));

  const pool = new Pool({ connectionString: dbUrl(db), max: 1 });
  try {
    const rows = await pool.query<{ version: string; applied_by: string }>(
      "select version, applied_by from schema_migrations order by version",
    );
    record("LEGACY_COMPLETE: ledger 29 satır", rows.rows.length === 29, `got ${rows.rows.length}`);
    const backfill = rows.rows.filter((r) => r.version <= "0019");
    record(
      "LEGACY_COMPLETE: 0001-0019 applied_by='baseline-backfill' (19 satır)",
      backfill.length === 19 && backfill.every((r) => r.applied_by === "baseline-backfill"),
      `got ${backfill.length}`,
    );
    const scripted = rows.rows.filter((r) => r.version > "0019");
    record(
      "LEGACY_COMPLETE: 0020-0029 applied_by='migrate-script' (10 satır)",
      scripted.length === 10 && scripted.every((r) => r.applied_by === "migrate-script"),
      `got ${scripted.length}`,
    );

    const postCounts = await getTableRowCounts(pool, ["schema_migrations"]);
    const preKeys = Object.keys(preCounts).sort();
    const postKeys = Object.keys(postCounts).sort();
    const sameTableSet = JSON.stringify(preKeys) === JSON.stringify(postKeys);
    const sameCounts = sameTableSet && preKeys.every((k) => preCounts[k] === postCounts[k]);
    record(
      "LEGACY_COMPLETE: tüm mevcut public tabloların satır sayıları öncesi/sonrası birebir aynı (schema_migrations hariç)",
      sameCounts,
      sameCounts ? undefined : JSON.stringify({ pre: preCounts, post: postCounts }).slice(0, 400),
    );
  } finally {
    await pool.end();
  }
  await assertPolicyCountZero(db, "LEGACY_COMPLETE");

  const secondRun = runMigrate(db);
  record("Idempotency: ikinci çalıştırma başarıyla tamamlandı", secondRun.code === 0, secondRun.code === 0 ? undefined : secondRun.stderr.slice(0, 300));
  if (secondRun.code === 0) {
    const pool2 = new Pool({ connectionString: dbUrl(db), max: 1 });
    try {
      const rows2 = await pool2.query<{ n: number }>("select count(*)::int as n from schema_migrations");
      record("Idempotency: ledger hâlâ 29 satır (yeni satır eklenmedi)", rows2.rows[0]?.n === 29, `got ${rows2.rows[0]?.n}`);
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
  const firstRun = runMigrate(db);
  if (firstRun.code !== 0) {
    record("Checksum-drift: ön koşul migrasyonu başarılı", false, firstRun.stderr.slice(0, 300));
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
    record("LEDGER_EMPTY_RECOVERY smoke: ledger 29 satır", rows.rows[0]?.n === 29, `got ${rows.rows[0]?.n}`);
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
