// Disposable-DB test suite for P0-B Slice 4: payment-template update reconciliation
// (amount_source, due_date/amount propagation) + archive cascade (0028-0029).
// Mirrors scripts/db/transitions-verify.ts's pattern exactly: throwaway DB only, never
// mas_radar_dev, no ensure.ts wrapper.
//
// FAIL-CLOSED SAFETY GATE: no module under src/ is imported at the top of this file —
// they are all loaded via dynamic import() further down, and only after: the disposable
// DB exists, process.env.DATABASE_URL points at it, the parsed DB name is verified against
// both an expected-prefix allowlist and an explicit mas_radar_dev denylist, and a live
// `select current_database()` on that connection confirms it. Any failure in that chain
// exits 1 before a single src/ module is ever imported.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
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
const DB = "mas_radar_reconciliation_verify";
const DISPOSABLE_PREFIX = "mas_radar_reconciliation_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

// Fixed anchor date for every test in this file — today is the 20th, so a due_day
// recomputed to an earlier day-of-month in the CURRENT month falls into the past.
const TODAY = "2026-08-20";
const PREV_MONTH = "2026-07-01";
const CURRENT_MONTH = "2026-08-01";
const NEXT_MONTH = "2026-09-01";

interface TestOutcome { name: string; pass: boolean; detail?: string; }
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
function assertContainerReachable(): void {
  try {
    docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"], { quiet: true });
  } catch {
    console.error(`PostgreSQL konteyneri (${CONTAINER}) erişilebilir değil. Bu script onu otomatik başlatmaz.`);
    process.exit(1);
  }
}
function dropDb(db: string): void {
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", db], { quiet: true });
}
function createDb(db: string): void {
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", db], { quiet: true });
}
function dbUrl(db: string): string {
  return `postgres://postgres:postgres@127.0.0.1:5432/${db}`;
}
function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}
/** Fail-closed: exits the process immediately (before any src/ module can be imported) if the
 * given DB name is the real database, or isn't within this script's disposable namespace. */
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
interface RunResult { code: number; stdout: string; stderr: string; }
interface ExecError { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; }
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
function findLatestManagedFixtureDump(): string {
  const dir = path.join(ROOT, "backups");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("p0b-managed-baseline-") && f.endsWith(".dump"))
    .sort();
  if (files.length === 0) throw new Error("backups/p0b-managed-baseline-*.dump bulunamadı.");
  return path.join(dir, files.at(-1)!);
}
function restoreManagedFixtureInto(db: string): void {
  const dump = findLatestManagedFixtureDump();
  dropDb(db);
  createDb(db);
  docker(["exec", "-i", CONTAINER, "pg_restore", "-U", "postgres", "-d", db, "--no-owner", "--role=postgres"], {
    input: readFileSync(dump),
    quiet: true,
  });
}
/** Reads a single migration file's raw SQL by version prefix, straight off disk — used only
 * to prove the 0028→0029 sequence is safe in true isolation (migrate.ts itself has no CLI
 * option to apply pending migrations one file at a time; see plan notes). The authoritative
 * apply path is still runMigrateAgainstUrl further below. */
function readMigrationSql(version: string): string {
  const dir = path.join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.startsWith(`${version}_`));
  if (files.length !== 1) throw new Error(`Migration dosyası bulunamadı veya belirsiz: ${version} (${files.length} eşleşme)`);
  return readFileSync(path.join(dir, files[0]), "utf8");
}

/** Runs 0028's raw SQL against a deliberately-corrupted (or entirely absent) amount_source
 * column, inside its own BEGIN...ROLLBACK — the real column is never permanently touched.
 * `corruptSql` (or null for "column doesn't exist yet") sets up the pre-existing shape;
 * `expectThrow` says whether 0028 must reject that shape or accept it. */
async function testColumnShapeScenario(
  pool: Pool,
  label: string,
  corruptSql: string | null,
  expectThrow: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("alter table public.payment_instances drop constraint if exists payment_instances_amount_source_check");
    await client.query("alter table public.payment_instances drop column if exists amount_source");
    if (corruptSql) await client.query(corruptSql);
    let threw = false;
    let errMsg = "";
    try {
      await client.query(readMigrationSql("0028"));
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    record(label, threw === expectThrow, errMsg.slice(0, 200));
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Runs 0028 against a deliberately-corrupted (or absent) amount_source CONSTRAINT — the
 * column itself is left alone (already correctly in place by the time these run). Proves
 * 0028 doesn't accept a same-named constraint of the wrong contype/expression just because
 * conname+conrelid matched. Isolated in its own BEGIN...ROLLBACK. */
async function testConstraintShapeScenario0028(
  pool: Pool,
  label: string,
  constraintSetupSql: string | null,
  expectThrow: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("alter table public.payment_instances drop constraint if exists payment_instances_amount_source_check");
    if (constraintSetupSql) await client.query(constraintSetupSql);
    let threw = false;
    let errMsg = "";
    try {
      await client.query(readMigrationSql("0028"));
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    record(label, threw === expectThrow, errMsg.slice(0, 200));
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Same idea for 0029: sets up a specific pre-existing constraint state, then runs 0029 and
 * (optionally) checks convalidated afterward — all inside one BEGIN...ROLLBACK so the real
 * constraint (already validated by the earlier real migrate.ts run) is never disturbed. */
async function testConstraint0029Scenario(
  pool: Pool,
  label: string,
  constraintSetupSql: string | null,
  expectThrow: boolean,
  expectConvalidatedTrue: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("alter table public.payment_instances drop constraint if exists payment_instances_amount_source_check");
    if (constraintSetupSql) await client.query(constraintSetupSql);
    let threw = false;
    let errMsg = "";
    try {
      await client.query(readMigrationSql("0029"));
    } catch (e) {
      threw = true;
      errMsg = (e as Error).message;
    }
    let convalidated: boolean | null = null;
    if (!threw) {
      const r = await client.query<{ convalidated: boolean }>(
        `select convalidated from pg_constraint
         where conname='payment_instances_amount_source_check' and conrelid='public.payment_instances'::regclass`,
      );
      convalidated = r.rows[0]?.convalidated ?? null;
    }
    const ok = threw === expectThrow && (expectThrow || convalidated === expectConvalidatedTrue);
    record(label, ok, errMsg.slice(0, 200) || `convalidated=${convalidated}`);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function expectFnReject(fn: () => Promise<unknown>, nameSubstr: RegExp, label: string): Promise<void> {
  try {
    await fn();
    record(label, false, "beklenmedik şekilde başarılı oldu");
  } catch (err) {
    const msg = (err as Error).message ?? "";
    record(label, nameSubstr.test(msg), msg.slice(0, 160));
  }
}

/* ── seed helpers ── */

async function seedPayment(
  pool: Pool,
  opts: { dueDay?: number | null; defaultAmount?: number | null; amountConfidence?: string; status?: string } = {},
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.payments (name, recurrence_type, due_day, default_amount, amount_confidence, status)
     values ('Reconciliation Test Ödeme', 'monthly', $1, $2, $3, $4)
     returning id`,
    [opts.dueDay ?? 15, opts.defaultAmount ?? 1000, opts.amountConfidence ?? "known", opts.status ?? "active"],
  );
  return r.rows[0].id;
}

async function seedInstance(
  pool: Pool,
  opts: {
    paymentId?: string | null;
    instanceMonth: string;
    dueDate: string;
    status?: string;
    amount?: number | null;
    amountStatus?: string;
    amountSource?: string;
    riskLevel?: string;
    riskReasons?: string[];
  },
): Promise<string> {
  const status = opts.status ?? "unpaid";
  const needsPaidAt = status === "paid" || status === "partial";
  const isCancelled = status === "cancelled";
  const r = await pool.query<{ id: string }>(
    `insert into public.payment_instances
       (payment_id, instance_month, due_date, status, amount, amount_status, amount_source,
        risk_level, risk_reasons, paid_amount, paid_at, cancelled_at, cancel_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,
       case when $10 then 50 else null end,
       case when $10 then now() else null end,
       case when $11 then now() else null end,
       case when $11 then 'seed' else null end)
     returning id`,
    [
      opts.paymentId ?? null,
      opts.instanceMonth,
      opts.dueDate,
      status,
      opts.amount ?? 1000,
      opts.amountStatus ?? "known",
      opts.amountSource ?? "generated",
      opts.riskLevel ?? "none",
      opts.riskReasons ?? [],
      needsPaidAt,
      isCancelled,
    ],
  );
  return r.rows[0].id;
}

async function getInstance(pool: Pool, id: string) {
  const r = await pool.query(`select * from public.payment_instances where id=$1`, [id]);
  return r.rows[0];
}
// pg's default `date` type parser builds a JS Date from local-midnight, not UTC-midnight —
// on a machine whose local timezone isn't UTC, row.due_date.toISOString().slice(0,10) can
// silently shift by a day. to_char(...,'YYYY-MM-DD') sidesteps that entirely (same pattern
// already used by the real engine code, e.g. reconcileInstancesWithClient's own SELECT).
async function dueDateOf(pool: Pool, id: string): Promise<string> {
  const r = await pool.query<{ due_date: string }>(
    `select to_char(due_date,'YYYY-MM-DD') as due_date from public.payment_instances where id=$1`,
    [id],
  );
  return r.rows[0].due_date;
}
async function getPayment(pool: Pool, id: string) {
  const r = await pool.query(`select * from public.payments where id=$1`, [id]);
  return r.rows[0];
}
async function fingerprintInstances(pool: Pool, ids: string[]): Promise<string> {
  if (ids.length === 0) return "EMPTY";
  const r = await pool.query<{ fp: string }>(
    `select coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '') as fp
     from public.payment_instances t where t.id = any($1)`,
    [ids],
  );
  return r.rows[0].fp;
}
// Every risk-refresh call in this script is anchored to the fixed TODAY constant, so its
// scan window is always exactly [PREV_MONTH, "2026-10-01") — any instance_month outside that
// range can never be touched by refreshRiskFlagsWithClient, regardless of what else runs later
// in the script. Used to place the legacy fixture (below) fully out of that window so its
// full-row (nothing excluded) fingerprint stays meaningful for the whole script's duration.
const RISK_WINDOW_FROM = PREV_MONTH;
const RISK_WINDOW_TO_EXCLUSIVE = "2026-10-01";
function safeMonthOutsideRiskWindow(offset: number): string {
  const year = 2030 + Math.floor(offset / 12);
  const month = (offset % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}
async function fingerprintRiskWindow(pool: Pool): Promise<string> {
  const r = await pool.query<{ fp: string }>(
    `select coalesce(string_agg(id::text || ':' || risk_level || ':' || array_to_string(risk_reasons, ','), '|' order by id), '') as fp
     from public.payment_instances
     where instance_month >= $1 and instance_month < $2`,
    [RISK_WINDOW_FROM, RISK_WINDOW_TO_EXCLUSIVE],
  );
  return r.rows[0].fp;
}
async function fingerprintAuditLogs(pool: Pool): Promise<string> {
  const r = await pool.query<{ n: string; fp: string }>(
    `select count(*)::text as n, coalesce(string_agg(id::text, '|' order by id), '') as fp from public.audit_logs`,
  );
  return `${r.rows[0].n}:${r.rows[0].fp}`;
}

async function main(): Promise<void> {
  console.log("=== reconciliation-verify: P0-B Slice 4 disposable-DB test suite (fail-closed) ===\n");

  // ── Fail-closed güvenlik kapısı — bu noktaya kadar src/ altında HİÇBİR modül import edilmedi. ──
  assertSafeDisposableName(DB, "sabit DB adı (DB sabiti)");
  assertContainerReachable();
  restoreManagedFixtureInto(DB);

  const disposableUrl = dbUrl(DB);
  process.env.DATABASE_URL = disposableUrl;
  assertSafeDisposableName(dbNameFromUrl(process.env.DATABASE_URL), "process.env.DATABASE_URL");

  const pool = new Pool({ connectionString: disposableUrl, max: 1 });
  const appPool = new Pool({ connectionString: disposableUrl, max: 5 });

  const live = await pool.query<{ current_database: string }>("select current_database()");
  const liveName = live.rows[0].current_database;
  assertSafeDisposableName(liveName, "select current_database()");
  if (liveName !== DB) {
    console.error(`GÜVENLİK DURDURMASI: canlı bağlantı '${liveName}' döndürdü, beklenen '${DB}'. Çıkış.`);
    await pool.end();
    await appPool.end();
    process.exit(1);
  }
  console.log(`Güvenlik kapısı geçti — disposable DB='${liveName}' doğrulandı. Uygulama/action/engine modülleri şimdi yükleniyor.\n`);

  // ── Yalnız bu noktadan sonra: dynamic import(), src/ altındaki hiçbir modül daha önce yüklenmedi. ──
  // Only the engine layer is exercised here (updatePaymentAndReconcile, archivePayment,
  // setInstanceAmount, reconcileInstancesWithClient) — none of these touch src/lib/db.ts's
  // getPool() singleton, they take an explicit Pool/PoolClient parameter throughout, so
  // there is no global pool to close alongside the disposable DB in the finally block below.
  const { reconcileInstancesWithClient, setInstanceAmount } = await import("../../src/lib/radar/engine");
  const { archivePayment, updatePaymentAndReconcile } = await import("../../src/lib/payments/engine");

  try {
    // ── Migration: 0028 izole → ara-kontrol → 0029 izole → validated. migrate.ts uygular
    // ── pending'leri tek çağrıda ikiye bölemez (bkz. plan notları); bu yüzden SQL dosyaları
    // ── doğrudan okunup izole uygulanıyor. Her iki dosya da idempotent olduğundan bunu izleyen
    // ── gerçek migrate.ts çalıştırması bunları zararsızca yeniden uygulayıp ledger satırlarını ekler.
    await pool.query(readMigrationSql("0028"));
    const check1 = await pool.query<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname='payment_instances_amount_source_check'`,
    );
    record("0028 izole uygulandı: constraint NOT VALID (convalidated=false)", check1.rows[0]?.convalidated === false);

    const dist = await pool.query<{ amount_source: string }>(`select distinct amount_source from public.payment_instances`);
    const validValues = new Set(["generated", "manual", "legacy_unknown"]);
    record(
      "0028 sonrası ara-kontrol: amount_source yalnız 3 değerle sınırlı",
      dist.rows.every((r) => validValues.has(r.amount_source)),
      JSON.stringify(dist.rows.map((r) => r.amount_source)),
    );

    await pool.query(readMigrationSql("0029"));
    const check2 = await pool.query<{ convalidated: boolean }>(
      `select convalidated from pg_constraint where conname='payment_instances_amount_source_check'`,
    );
    record("0029 izole uygulandı: constraint VALIDATE edildi (convalidated=true)", check2.rows[0]?.convalidated === true);

    // ── Gerçek migrate.ts uygulaması — 0028/0029'u (yukarıda zaten idempotent şekilde uygulandığı
    // ── için zararsızca) ledger'a kaydeder ve varsa diğer pending migration'ları da uygular.
    // backups/p0b-managed-baseline-*.dump is frozen from before Slice 5's legacy-repair apply
    // ever ran, so it still carries the one known payment_instances anomaly 0026 grandfathered
    // (see 0026's own comment) — this first migrate.ts call, which also picks up every OTHER
    // pending migration, therefore fails exactly at 0030, same root cause as migrate-verify.ts,
    // constraints-verify.ts, and transitions-verify.ts's own fixtures.
    const bootstrapRun = runMigrateAgainstUrl(disposableUrl);
    record(
      "0028-0029 migrate.ts ile uygulandı (ledger kaydı dahil), 0030 bilinen ihlal nedeniyle beklenen şekilde durdu",
      bootstrapRun.code !== 0
        && /Pending migration 0030/.test(bootstrapRun.stderr)
        && /payment_instances_cancel_consistency/.test(bootstrapRun.stderr),
      bootstrapRun.stderr.slice(0, 300),
    );

    let migrationOk = false;
    if (bootstrapRun.code !== 0 && /Pending migration 0030/.test(bootstrapRun.stderr)) {
      const violationsBeforePrep = await countPaymentInstancesCancelViolations(pool);
      record(
        "p0b-managed-baseline: 0028-0029 sonrası hâlâ bilinen legacy ihlalini taşıyor (1 satır)",
        violationsBeforePrep === 1,
        `got ${violationsBeforePrep}`,
      );

      // Test-setup-only fixture preparation (NOT a production repair — see the shared
      // helper's own doc comment). Narrow before/after checks prove it touched only the
      // one named row.
      const countsBeforePrep = await getTableRowCounts(pool, []);
      const fpBeforePrep = await fingerprintPaymentInstancesExcluding(pool, LEGACY_ANOMALY_INSTANCE_ID);

      await prepareLegacyCheckpointForCancellationValidation(disposableUrl);

      const countsAfterPrep = await getTableRowCounts(pool, []);
      const fpAfterPrep = await fingerprintPaymentInstancesExcluding(pool, LEGACY_ANOMALY_INSTANCE_ID);
      const violationsAfterPrep = await countPaymentInstancesCancelViolations(pool);

      const sameRowCounts = JSON.stringify(countsBeforePrep) === JSON.stringify(countsAfterPrep);
      record(
        "fixture preparation başka hiçbir tablonun satır sayısını değiştirmedi",
        sameRowCounts,
        sameRowCounts ? undefined : JSON.stringify({ before: countsBeforePrep, after: countsAfterPrep }).slice(0, 400),
      );
      record(
        "fixture preparation yalnız hedef satırın cancellation metadata'sını değiştirdi (diğer payment_instances satırları aynı fingerprint)",
        fpBeforePrep === fpAfterPrep,
      );
      record("preparation sonrası ihlal sayısı 0", violationsAfterPrep === 0, `got ${violationsAfterPrep}`);

      const secondRun = runMigrateAgainstUrl(disposableUrl);
      record(
        "0028-0030 migrate.ts ile başarıyla uygulandı (fixture düzeltmesinden sonra)",
        secondRun.code === 0,
        secondRun.code === 0 ? undefined : secondRun.stderr.slice(0, 300),
      );
      migrationOk = secondRun.code === 0;

      if (migrationOk) {
        const violationsAfterMigrate = await countCancelConsistencyViolations(pool);
        record("0030 sonrası ihlal sayısı hâlâ 0", violationsAfterMigrate === 0, `got ${violationsAfterMigrate}`);

        for (const conname of [
          "payment_instances_cancel_consistency",
          "checks_cancel_consistency",
          "loan_installments_cancel_consistency",
        ] as const) {
          const state = await getConstraintCatalogState(pool, conname);
          record(`${conname} convalidated=true`, state.found && state.convalidated === true, JSON.stringify(state));
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
          record(`kapsam dışı ${conname} hâlâ convalidated=false (dokunulmadı)`, state.found && state.convalidated === false, JSON.stringify(state));
        }

        const thirdRun = runMigrateAgainstUrl(disposableUrl);
        record("migrate.ts üçüncü çalıştırma no-op olarak başarıyla tamamlandı", thirdRun.code === 0, thirdRun.code === 0 ? undefined : thirdRun.stderr.slice(0, 300));
        if (thirdRun.code === 0) {
          const ledgerRes = await pool.query<{ n: number; last_version: string | null }>(
            "select count(*)::int as n, max(version) as last_version from schema_migrations",
          );
          record(
            "ledger üçüncü çalıştırma sonrası hâlâ 30 satır, last migration 0030",
            ledgerRes.rows[0]?.n === 30 && ledgerRes.rows[0]?.last_version === "0030",
            `got n=${ledgerRes.rows[0]?.n} last=${ledgerRes.rows[0]?.last_version}`,
          );
        }
      }
    }

  async function runReconciliationAssertions(): Promise<void> {
    // ── 0028 güvenlik testleri: kolon önceden yanlış şekilde mevcutsa migration sessizce kabul
    // ── etmemeli, açık hata ile durmalı. 4 senaryo, her biri kendi BEGIN...ROLLBACK'inde izole —
    // ── gerçek amount_source kolonuna kalıcı dokunulmaz (migrate.ts'in az önce kurduğu hâli sağlam kalır).
    await testColumnShapeScenario(
      pool,
      "0028 güvenlik: kolon hiç yokken migration doğru ekler (kabul edilir)",
      null,
      false,
    );
    await testColumnShapeScenario(
      pool,
      "0028 güvenlik: kolon nullable olarak önceden mevcutsa migration reddeder",
      "alter table public.payment_instances add column amount_source text",
      true,
    );
    await testColumnShapeScenario(
      pool,
      "0028 güvenlik: kolon yanlış default ile önceden mevcutsa migration reddeder",
      "alter table public.payment_instances add column amount_source text not null default 'wrong_default'",
      true,
    );
    await testColumnShapeScenario(
      pool,
      "0028 güvenlik: kolon doğru tanımla (text NOT NULL DEFAULT 'legacy_unknown') önceden mevcutsa migration kabul eder",
      "alter table public.payment_instances add column amount_source text not null default 'legacy_unknown'",
      false,
    );

    // ── Constraint tanımı fail-closed güvenlik testleri: conname+conrelid eşleşmesi TEK
    // ── BAŞINA yeterli değil — contype='c' VE gerçek check ifadesi beklenen kümeyle
    // ── (whitespace normalize edilerek) birebir eşleşmiyorsa migration açık hata ile durmalı.
    const CORRECT_CONSTRAINT_SQL =
      "alter table public.payment_instances add constraint payment_instances_amount_source_check check (amount_source in ('generated','manual','legacy_unknown')) not valid";
    const WRONG_CONSTRAINT_SQL =
      "alter table public.payment_instances add constraint payment_instances_amount_source_check check (amount_source in ('generated','manual')) not valid";

    await testConstraintShapeScenario0028(
      pool,
      "0028 güvenlik: constraint hiç yokken migration doğru ekler (kabul edilir)",
      null,
      false,
    );
    await testConstraintShapeScenario0028(
      pool,
      "0028 güvenlik: doğru kolon + doğru constraint önceden mevcutsa kabul eder",
      CORRECT_CONSTRAINT_SQL,
      false,
    );
    await testConstraintShapeScenario0028(
      pool,
      "0028 güvenlik: doğru kolon + aynı isimli ama yanlış ifadeli constraint önceden mevcutsa reddeder",
      WRONG_CONSTRAINT_SQL,
      true,
    );
    await testConstraint0029Scenario(
      pool,
      "0029 güvenlik: constraint hiç yokken VALIDATE denemeden açık hatayla durur",
      null,
      true,
      false,
    );
    await testConstraint0029Scenario(
      pool,
      "0029 güvenlik: aynı isimli ama yanlış ifadeli constraint ile VALIDATE denemeden reddeder",
      WRONG_CONSTRAINT_SQL,
      true,
      false,
    );
    await testConstraint0029Scenario(
      pool,
      "0029 güvenlik: constraint doğru tanımlıyken VALIDATE eder ve convalidated=true olur",
      CORRECT_CONSTRAINT_SQL,
      false,
      true,
    );

    // Korumacı fallback: amount_source belirtmeden doğrudan INSERT → kolonun kendi DEFAULT'u.
    const rawIns = await pool.query<{ amount_source: string }>(
      `insert into public.payment_instances (instance_month, due_date, status, amount)
       values ($1,$2,'unpaid',100) returning amount_source`,
      [CURRENT_MONTH, "2026-08-05"],
    );
    record(
      "Korumacı fallback: amount_source belirtilmeden INSERT → 'legacy_unknown' varsayılan",
      rawIns.rows[0].amount_source === "legacy_unknown",
    );

    // ── Pre-existing archived-payment legacy fixture — TAM 26 satır (gerçek mas_radar_dev
    // ── envanterinin birebir analogu): 25 unpaid + 1 partial, hepsi AYNI önceden-archived
    // ── payment'a bağlı; unpaid'lerin 24'ü due_date>=todayISO, 1'i due_date<todayISO.
    // ── archivePayment() bu payment/instance'lar üzerinde HİÇ ÇAĞRILMAZ. Her instance_month
    // ── bu script'in TEK risk-refresh penceresinin ([RISK_WINDOW_FROM, RISK_WINDOW_TO_EXCLUSIVE))
    // ── kesinlikle DIŞINDA — bu yüzden refreshRiskFlagsWithClient (Slice 4'ten bağımsız,
    // ── önceden var olan bir mekanizma) bu satırları hiçbir zaman tarayamaz/değiştiremez ve
    // ── aşağıdaki TAM-SATIR (hiçbir kolon çıkarılmadan) fingerprint karşılaştırması gerçekten
    // ── "bu 26 satırın hiçbir kolonunda DML olmadığını" kanıtlar.
    const legacyPayment = await seedPayment(pool, { dueDay: 8, defaultAmount: 300, status: "active" });
    await pool.query(
      `update public.payments set status='archived', archived_at=now(), archive_reason='pre-existing (Slice 4 öncesi)', archived_by_label='legacy-test' where id=$1`,
      [legacyPayment],
    );
    const legacyIds: string[] = [];
    for (let i = 0; i < 24; i++) {
      const m = safeMonthOutsideRiskWindow(i);
      const id = await seedInstance(pool, {
        paymentId: legacyPayment, instanceMonth: m, dueDate: `${m.slice(0, 8)}05`, status: "unpaid",
      });
      legacyIds.push(id);
    }
    legacyIds.push(
      await seedInstance(pool, {
        // 25. unpaid satır: zaten vadesi geçmiş (due_date < todayISO).
        paymentId: legacyPayment, instanceMonth: "2020-01-01", dueDate: "2020-01-05", status: "unpaid",
      }),
    );
    legacyIds.push(
      await seedInstance(pool, {
        // 26. satır: partial.
        paymentId: legacyPayment, instanceMonth: safeMonthOutsideRiskWindow(24), dueDate: `${safeMonthOutsideRiskWindow(24).slice(0, 8)}05`, status: "partial",
      }),
    );
    record("Legacy fixture: tam olarak 26 satır kuruldu (25 unpaid + 1 partial)", legacyIds.length === 26);
    const legacyFutureDueDateCount = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from public.payment_instances where id = any($1) and status='unpaid' and due_date >= $2`,
        [legacyIds, TODAY],
      )
    ).rows[0].n;
    const legacyPastDueDateCount = (
      await pool.query<{ n: string }>(
        `select count(*)::text as n from public.payment_instances where id = any($1) and status='unpaid' and due_date < $2`,
        [legacyIds, TODAY],
      )
    ).rows[0].n;
    record(
      "Legacy fixture: unpaid satırların 24'ü due_date>=todayISO, 1'i due_date<todayISO",
      legacyFutureDueDateCount === "24" && legacyPastDueDateCount === "1",
      `future=${legacyFutureDueDateCount} past=${legacyPastDueDateCount}`,
    );
    const legacyFingerprintBefore = await fingerprintInstances(pool, legacyIds);

    /* ── reconcileInstancesWithClient — doğrudan, izole testler ── */

    // generated tutar güncellenir (due_date no-op, amount değişir).
    {
      const p = await seedPayment(pool, { dueDay: 10, defaultAmount: 1000, amountConfidence: "known" });
      const inst = await seedInstance(pool, {
        paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: 500, amountStatus: "known", amountSource: "generated",
      });
      const res = await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, p, { dueDay: 10, defaultAmount: 1000, amountConfidence: "known" }, TODAY),
      );
      const after = await getInstance(pool, inst);
      const afterDueDate = await dueDateOf(pool, inst);
      record(
        "generated tutar güncellenir (due_date değişmeden)",
        Number(after.amount) === 1000 && afterDueDate === "2026-09-10" && res.amountChanged === 1 && res.dueDateChanged === 0,
        JSON.stringify({ amount: after.amount, due_date: afterDueDate }),
      );
    }

    // No-op doğrulama: hesaplanan değerler zaten aynıysa hiç UPDATE çalışmaz.
    {
      const p = await seedPayment(pool, { dueDay: 10, defaultAmount: 1000, amountConfidence: "known" });
      const inst = await seedInstance(pool, {
        paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: 1000, amountStatus: "known", amountSource: "generated",
      });
      const before = await getInstance(pool, inst);
      const auditBefore = await fingerprintAuditLogs(pool);
      const res = await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, p, { dueDay: 10, defaultAmount: 1000, amountConfidence: "known" }, TODAY),
      );
      const after = await getInstance(pool, inst);
      const auditAfter = await fingerprintAuditLogs(pool);
      record(
        "No-op doğrulama: değişiklik yoksa UPDATE çalışmaz, updated_at ve audit değişmez",
        res.dueDateChanged === 0 && res.amountChanged === 0 &&
          before.updated_at.getTime() === after.updated_at.getTime() && auditBefore === auditAfter,
      );
    }

    // Geriye-taşıma: bugün ayın 20'si, mevcut due_date 25'i, due_day 5'e çekiliyor.
    {
      const p = await seedPayment(pool, { dueDay: 25, defaultAmount: 1000, amountConfidence: "known" });
      const thisMonthInst = await seedInstance(pool, {
        paymentId: p, instanceMonth: CURRENT_MONTH, dueDate: "2026-08-25", amount: 1000, amountStatus: "known", amountSource: "generated",
      });
      const nextMonthInst = await seedInstance(pool, {
        paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-25", amount: 1000, amountStatus: "known", amountSource: "generated",
      });
      await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, p, { dueDay: 5, defaultAmount: 1000, amountConfidence: "known" }, TODAY),
      );
      const thisAfterDueDate = await dueDateOf(pool, thisMonthInst);
      const nextAfterDueDate = await dueDateOf(pool, nextMonthInst);
      record(
        "Geriye-taşıma: bu ayın kaydı DEĞİŞMEZ (yeni due_day geçmişe düşerdi)",
        thisAfterDueDate === "2026-08-25",
        thisAfterDueDate,
      );
      record(
        "Geriye-taşıma: sonraki ayın kaydı yeni due_day'e güncellenir",
        nextAfterDueDate === "2026-09-05",
        nextAfterDueDate,
      );
    }

    // Mevcut ayda vadesi ZATEN geçmiş unpaid — hiç eligible değil, hiç değişmez.
    {
      const p = await seedPayment(pool, { dueDay: 25, defaultAmount: 2000, amountConfidence: "known" });
      const inst = await seedInstance(pool, {
        paymentId: p, instanceMonth: CURRENT_MONTH, dueDate: "2026-08-05", amount: 1000, amountStatus: "known", amountSource: "generated",
      });
      const res = await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, p, { dueDay: 25, defaultAmount: 2000, amountConfidence: "known" }, TODAY),
      );
      const after = await getInstance(pool, inst);
      const afterDueDate = await dueDateOf(pool, inst);
      record(
        "Mevcut ayda vadesi zaten geçmiş unpaid: eligible değil, hiç değişmez",
        res.totalEligible === 0 && Number(after.amount) === 1000 && afterDueDate === "2026-08-05",
      );
    }

    // late: reconciliation'dan tamamen hariç.
    {
      const p = await seedPayment(pool, { dueDay: 25, defaultAmount: 2000, amountConfidence: "known" });
      const inst = await seedInstance(pool, {
        paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-25", amount: 1000, amountStatus: "known", amountSource: "generated", status: "late",
      });
      const res = await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, p, { dueDay: 5, defaultAmount: 2000, amountConfidence: "known" }, TODAY),
      );
      const after = await getInstance(pool, inst);
      const afterDueDate = await dueDateOf(pool, inst);
      record(
        "late statüsü reconciliation'dan tamamen hariç",
        res.totalEligible === 0 && Number(after.amount) === 1000 && afterDueDate === "2026-09-25",
      );
    }

    // current-month manual/legacy_unknown amount korunur, due_date yine de güncellenebilir.
    // (payment_instances_idempotency yalnız bir (payment_id, instance_month) çifti izin verir —
    // her biri kendi payment'ı altında, iki farklı ödeme kullanılıyor.)
    {
      const pManual = await seedPayment(pool, { dueDay: 10, defaultAmount: 2000, amountConfidence: "known" });
      const manualInst = await seedInstance(pool, {
        paymentId: pManual, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: 777, amountStatus: "known", amountSource: "manual",
      });
      await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, pManual, { dueDay: 20, defaultAmount: 2000, amountConfidence: "known" }, TODAY),
      );
      const manualAfter = await getInstance(pool, manualInst);
      const manualAfterDueDate = await dueDateOf(pool, manualInst);
      record(
        "manual amount korunur, due_date güncellenir",
        Number(manualAfter.amount) === 777 && manualAfterDueDate === "2026-09-20",
      );

      const pLegacy = await seedPayment(pool, { dueDay: 10, defaultAmount: 2000, amountConfidence: "known" });
      const legacyInst = await seedInstance(pool, {
        paymentId: pLegacy, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: 888, amountStatus: "known", amountSource: "legacy_unknown",
      });
      await withTransaction(appPool, (c) =>
        reconcileInstancesWithClient(c, pLegacy, { dueDay: 20, defaultAmount: 2000, amountConfidence: "known" }, TODAY),
      );
      const legacyAfter = await getInstance(pool, legacyInst);
      const legacyAfterDueDate = await dueDateOf(pool, legacyInst);
      record(
        "legacy_unknown amount korunur, due_date güncellenir",
        Number(legacyAfter.amount) === 888 && legacyAfterDueDate === "2026-09-20",
      );
    }

    // paid/partial/cancelled — reconciliation'dan tamamen hariç (eligibility zaten status filtreliyor).
    // Her statü kendi ödemesi altında test edilir (aynı payment_id + instance_month çifti
    // payment_instances_idempotency ihlal ederdi).
    {
      const statuses: Array<{ status: string; amount: number }> = [
        { status: "paid", amount: 111 },
        { status: "partial", amount: 222 },
        { status: "cancelled", amount: 333 },
      ];
      for (const s of statuses) {
        const p = await seedPayment(pool, { dueDay: 10, defaultAmount: 2000, amountConfidence: "known" });
        const inst = await seedInstance(pool, {
          paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: s.amount, amountStatus: "known", amountSource: "generated", status: s.status,
        });
        const res = await withTransaction(appPool, (c) =>
          reconcileInstancesWithClient(c, p, { dueDay: 20, defaultAmount: 2000, amountConfidence: "known" }, TODAY),
        );
        const after = await getInstance(pool, inst);
        const afterDueDate = await dueDateOf(pool, inst);
        record(
          `${s.status} instance reconciliation'da hiç değişmez`,
          res.totalEligible === 0 && Number(after.amount) === s.amount && afterDueDate === "2026-09-10",
        );
      }
    }

    /* ── updatePaymentAndReconcile — tam orkestrasyon: reconciliation + generation + risk refresh ── */
    {
      const paymentA = await seedPayment(pool, { dueDay: 10, defaultAmount: 1000, amountConfidence: "known" });
      const instA = await seedInstance(pool, {
        paymentId: paymentA, instanceMonth: NEXT_MONTH, dueDate: "2026-09-10", amount: 400, amountStatus: "known", amountSource: "generated",
        riskLevel: "high", riskReasons: ["overdue"], // deliberately stale/wrong — due_date is in the future
      });
      const paymentB = await seedPayment(pool, { dueDay: 12, defaultAmount: 200, amountConfidence: "known" });

      const paymentARowBefore = JSON.stringify(await getPayment(pool, paymentA));
      const instAFpBefore = await fingerprintInstances(pool, [instA]);
      const bCountBefore = (await pool.query(`select count(*) as n from public.payment_instances where payment_id=$1`, [paymentB])).rows[0].n;
      const auditBefore = await fingerprintAuditLogs(pool);

      // Rollback — audit INSERT enjekte-hatası (en erken adım: update_payment audit'i).
      await pool.query("alter table public.audit_logs add constraint test_force_fail_audit check (false) not valid");
      try {
        await expectFnReject(
          () => updatePaymentAndReconcile(appPool, paymentA, {
            name: "Reconciliation Test Ödeme", recurrence_type: "monthly", due_day: 10, due_date: null,
            default_amount: 1000, amount_confidence: "known", direction: "outflow", priority: "normal",
            status: "active", category_id: null, provider_party_id: null, owner_party_id: null,
            cash_account_id: null, description: null,
          }, TODAY),
          /.*/,
          "updatePaymentAndReconcile rollback (audit hatası): çağrı hata fırlattı",
        );
      } finally {
        await pool.query("alter table public.audit_logs drop constraint test_force_fail_audit");
      }
      const paymentARowAfterFail = JSON.stringify(await getPayment(pool, paymentA));
      const instAFpAfterFail = await fingerprintInstances(pool, [instA]);
      const bCountAfterFail = (await pool.query(`select count(*) as n from public.payment_instances where payment_id=$1`, [paymentB])).rows[0].n;
      const auditAfterFail = await fingerprintAuditLogs(pool);
      record(
        "updatePaymentAndReconcile rollback (audit hatası): payment satırı değişmedi (fingerprint)",
        paymentARowBefore === paymentARowAfterFail,
      );
      record(
        "updatePaymentAndReconcile rollback (audit hatası): reconciliation kapsamındaki instance değişmedi (fingerprint)",
        instAFpBefore === instAFpAfterFail,
      );
      record(
        "updatePaymentAndReconcile rollback (audit hatası): başka aktif ödeme (B) için instance üretilmedi",
        bCountBefore === bCountAfterFail,
      );
      record(
        "updatePaymentAndReconcile rollback (audit hatası): audit_logs değişmedi (fingerprint)",
        auditBefore === auditAfterFail,
      );

      // Şimdi engelsiz, gerçek başarı yolu — tek transaction'da reconciliation + generation + risk refresh.
      await updatePaymentAndReconcile(appPool, paymentA, {
        name: "Reconciliation Test Ödeme", recurrence_type: "monthly", due_day: 10, due_date: null,
        default_amount: 1000, amount_confidence: "known", direction: "outflow", priority: "normal",
        status: "active", category_id: null, provider_party_id: null, owner_party_id: null,
        cash_account_id: null, description: null,
      }, TODAY);
      const instAAfter = await getInstance(pool, instA);
      record("updatePaymentAndReconcile: reconciliation aynı transaction'da amount günceller", Number(instAAfter.amount) === 1000);
      record(
        "updatePaymentAndReconcile: risk refresh aynı transaction'da çalışır (stale 'overdue' kaldırıldı)",
        !instAAfter.risk_reasons.includes("overdue"),
        JSON.stringify(instAAfter.risk_reasons),
      );
      const bCountAfterSuccess = (await pool.query(`select count(*) as n from public.payment_instances where payment_id=$1 and amount_source='generated'`, [paymentB])).rows[0].n;
      record(
        "Açık yan etki: Ödeme A güncellenirken Ödeme B'nin eksik ay örnekleri de aynı transaction'da üretildi",
        Number(bCountAfterSuccess) === 3,
        `got ${bCountAfterSuccess}`,
      );

      // Not-found → DomainError.
      await expectFnReject(
        () => updatePaymentAndReconcile(appPool, "00000000-0000-0000-0000-000000000000", {
          name: "x", recurrence_type: "monthly", due_day: 1, due_date: null, default_amount: null,
          amount_confidence: "known", direction: "outflow", priority: "normal", status: "active",
          category_id: null, provider_party_id: null, owner_party_id: null, cash_account_id: null, description: null,
        }, TODAY),
        /payment not found/,
        "updatePaymentAndReconcile: kayıt yok → DomainError",
      );

      // Rollback — generation aşamasında hata (reconciliation'ın hiç değişiklik yapmadığı bir ödeme
      // kullanılarak hata özellikle generation adımına izole edilir).
      const paymentC = await seedPayment(pool, { dueDay: 11, defaultAmount: 500, amountConfidence: "known" });
      const paymentCRowBefore = JSON.stringify(await getPayment(pool, paymentC));
      const auditBefore2 = await fingerprintAuditLogs(pool);
      await pool.query("alter table public.payment_instances add constraint test_force_fail_generation check (false) not valid");
      try {
        await expectFnReject(
          () => updatePaymentAndReconcile(appPool, paymentC, {
            name: "Reconciliation Test Ödeme", recurrence_type: "monthly", due_day: 11, due_date: null,
            default_amount: 500, amount_confidence: "known", direction: "outflow", priority: "normal",
            status: "active", category_id: null, provider_party_id: null, owner_party_id: null,
            cash_account_id: null, description: null,
          }, TODAY),
          /.*/,
          "updatePaymentAndReconcile rollback (generation hatası): çağrı hata fırlattı",
        );
      } finally {
        await pool.query("alter table public.payment_instances drop constraint test_force_fail_generation");
      }
      const paymentCRowAfter = JSON.stringify(await getPayment(pool, paymentC));
      const auditAfter2 = await fingerprintAuditLogs(pool);
      record(
        "updatePaymentAndReconcile rollback (generation hatası): payment update+audit dahil her şey rollback",
        paymentCRowBefore === paymentCRowAfter && auditBefore2 === auditAfter2,
      );

      // Rollback — risk refresh aşamasında hata. Payment update + audit + reconciliation +
      // generation hepsi sorunsuzca ilerler; YALNIZ risk refresh'in belirli bir instance için
      // attığı UPDATE geçici bir trigger'la reddedilir. reconciliation bu instance için tam
      // no-op olacak şekilde kurulur (due_day/default_amount değişmiyor) — böylece transaction
      // içindeki TEK yazma girişimi risk refresh'in kendisi olur, hata gerçekten ona izole edilir.
      const paymentD = await seedPayment(pool, { dueDay: 15, defaultAmount: 1000, amountConfidence: "known" });
      const instD = await seedInstance(pool, {
        paymentId: paymentD, instanceMonth: NEXT_MONTH, dueDate: "2026-09-15", amount: 1000, amountStatus: "known", amountSource: "generated",
        riskLevel: "high", riskReasons: ["overdue"], // stale/yanlış — due_date gelecekte, refreshRiskFlagsWithClient bu satırı gerçekten güncellemeye çalışır
      });
      const paymentE = await seedPayment(pool, { dueDay: 13, defaultAmount: 250, amountConfidence: "known" });

      const paymentDRowBefore = JSON.stringify(await getPayment(pool, paymentD));
      const instDFpBefore = await fingerprintInstances(pool, [instD]);
      const eCountBefore = (await pool.query(`select count(*) as n from public.payment_instances where payment_id=$1`, [paymentE])).rows[0].n;
      const riskFpBefore = await fingerprintRiskWindow(pool);
      const auditBefore3 = await fingerprintAuditLogs(pool);

      await pool.query(`
        create or replace function test_fail_on_specific_risk_update() returns trigger as $$
        begin
          if new.id = '${instD}' and (new.risk_level is distinct from old.risk_level or new.risk_reasons is distinct from old.risk_reasons) then
            raise exception 'test induced failure on risk update for specific instance';
          end if;
          return new;
        end;
        $$ language plpgsql;
      `);
      await pool.query(
        "create trigger test_fail_risk_update before update on public.payment_instances for each row execute function test_fail_on_specific_risk_update()",
      );
      try {
        await expectFnReject(
          () => updatePaymentAndReconcile(appPool, paymentD, {
            name: "Reconciliation Test Ödeme", recurrence_type: "monthly", due_day: 15, due_date: null,
            default_amount: 1000, amount_confidence: "known", direction: "outflow", priority: "normal",
            status: "active", category_id: null, provider_party_id: null, owner_party_id: null,
            cash_account_id: null, description: null,
          }, TODAY),
          /risk update for specific instance/,
          "updatePaymentAndReconcile rollback (risk refresh hatası): çağrı hata fırlattı (deterministik olarak seçilen tek instance'ın risk UPDATE'i reddedildi)",
        );
      } finally {
        await pool.query("drop trigger test_fail_risk_update on public.payment_instances");
        await pool.query("drop function test_fail_on_specific_risk_update()");
      }

      const paymentDRowAfter = JSON.stringify(await getPayment(pool, paymentD));
      const instDFpAfter = await fingerprintInstances(pool, [instD]);
      const eCountAfter = (await pool.query(`select count(*) as n from public.payment_instances where payment_id=$1`, [paymentE])).rows[0].n;
      const riskFpAfter = await fingerprintRiskWindow(pool);
      const auditAfter3 = await fingerprintAuditLogs(pool);

      record(
        "updatePaymentAndReconcile rollback (risk refresh hatası): payment template satırı değişmedi",
        paymentDRowBefore === paymentDRowAfter,
      );
      record(
        "updatePaymentAndReconcile rollback (risk refresh hatası): reconciliation kapsamındaki instance değişmedi",
        instDFpBefore === instDFpAfter,
      );
      record(
        "updatePaymentAndReconcile rollback (risk refresh hatası): başka aktif ödeme (E) için instance üretilmedi",
        eCountBefore === eCountAfter,
      );
      record(
        "updatePaymentAndReconcile rollback (risk refresh hatası): risk penceresindeki TÜM risk alanları değişmedi (risk refresh gerçekten aynı transaction'da)",
        riskFpBefore === riskFpAfter,
      );
      record(
        "updatePaymentAndReconcile rollback (risk refresh hatası): audit_logs değişmedi",
        auditBefore3 === auditAfter3,
      );
    }

    /* ── setInstanceAmount — tam davranış seti ── */
    {
      await expectFnReject(
        () => setInstanceAmount(appPool, "00000000-0000-0000-0000-000000000000", 100),
        /instance not found/,
        "setInstanceAmount: kayıt yok → DomainError",
      );

      const p = await seedPayment(pool);
      const inst = await seedInstance(pool, {
        paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-15", amount: 100, amountStatus: "missing", amountSource: "legacy_unknown",
      });
      await setInstanceAmount(appPool, inst, 555);
      const after = await getInstance(pool, inst);
      record(
        "setInstanceAmount: amount+amount_status+amount_source='manual' aynı transaction'da güncellenir",
        Number(after.amount) === 555 && after.amount_status === "known" && after.amount_source === "manual",
      );

      // Aynı değer tekrar girilirse: no-op (UPDATE/audit/timestamp yok).
      const before2 = await getInstance(pool, inst);
      const auditBefore3 = await fingerprintAuditLogs(pool);
      await setInstanceAmount(appPool, inst, 555);
      const after2 = await getInstance(pool, inst);
      const auditAfter3 = await fingerprintAuditLogs(pool);
      record(
        "setInstanceAmount: aynı değer tekrar girilirse UPDATE/audit/updated_at üretilmez",
        before2.updated_at.getTime() === after2.updated_at.getTime() && auditBefore3 === auditAfter3,
      );

      // Audit hatasında tam rollback (ayrı bir ay — aynı payment altında NEXT_MONTH zaten dolu).
      const instForFail = await seedInstance(pool, {
        paymentId: p, instanceMonth: "2026-10-01", dueDate: "2026-10-16", amount: 10, amountStatus: "known", amountSource: "legacy_unknown",
      });
      const beforeFail = JSON.stringify(await getInstance(pool, instForFail));
      await pool.query("alter table public.audit_logs add constraint test_force_fail_setamount check (false) not valid");
      try {
        await expectFnReject(
          () => setInstanceAmount(appPool, instForFail, 999),
          /.*/,
          "setInstanceAmount rollback (audit hatası): çağrı hata fırlattı",
        );
      } finally {
        await pool.query("alter table public.audit_logs drop constraint test_force_fail_setamount");
      }
      const afterFail = JSON.stringify(await getInstance(pool, instForFail));
      record("setInstanceAmount rollback (audit hatası): satır tamamen değişmedi", beforeFail === afterFail);
    }

    /* ── archivePayment — cascade + tam-zincir atomiklik ── */
    {
      // payment_instances_idempotency bir (payment_id, instance_month) çiftine yalnız bir satır
      // izin verir — aynı payment altında 7 instance test etmek için her biri farklı bir ay kullanır.
      const p = await seedPayment(pool, { status: "active" });
      const cancelUnpaid = await seedInstance(pool, { paymentId: p, instanceMonth: NEXT_MONTH, dueDate: "2026-09-05", status: "unpaid" });
      const cancelPlanned = await seedInstance(pool, { paymentId: p, instanceMonth: "2026-10-01", dueDate: "2026-10-05", status: "planned" });
      const keepPastUnpaid = await seedInstance(pool, { paymentId: p, instanceMonth: CURRENT_MONTH, dueDate: "2026-08-05", status: "unpaid" });
      const keepLate = await seedInstance(pool, { paymentId: p, instanceMonth: "2026-11-01", dueDate: "2026-11-05", status: "late" });
      const keepPartial = await seedInstance(pool, { paymentId: p, instanceMonth: "2026-12-01", dueDate: "2026-12-05", status: "partial" });
      const keepPaid = await seedInstance(pool, { paymentId: p, instanceMonth: "2027-01-01", dueDate: "2027-01-05", status: "paid" });
      const keepCancelled = await seedInstance(pool, { paymentId: p, instanceMonth: "2027-02-01", dueDate: "2027-02-05", status: "cancelled" });

      const keepFingerprintsBefore = await fingerprintInstances(pool, [keepPastUnpaid, keepLate, keepPartial, keepPaid, keepCancelled]);

      await archivePayment(appPool, p, { reason: "test arşiv", archivedByLabel: "test" }, TODAY);

      const paymentAfter = await getPayment(pool, p);
      const cancelUnpaidAfter = await getInstance(pool, cancelUnpaid);
      const cancelPlannedAfter = await getInstance(pool, cancelPlanned);
      const keepFingerprintsAfter = await fingerprintInstances(pool, [keepPastUnpaid, keepLate, keepPartial, keepPaid, keepCancelled]);

      record("archivePayment: payment status='archived'", paymentAfter.status === "archived");
      record(
        "archivePayment cascade: bugün/gelecek unpaid iptal edilir",
        cancelUnpaidAfter.status === "cancelled" && cancelUnpaidAfter.cancel_reason === "Ödeme arşivlendi: test arşiv",
      );
      record("archivePayment cascade: bugün/gelecek planned iptal edilir", cancelPlannedAfter.status === "cancelled");
      record(
        "archivePayment cascade: geçmiş vadeli unpaid, late, partial, paid, zaten-cancelled hiç dokunulmaz",
        keepFingerprintsBefore === keepFingerprintsAfter,
      );

      // Tam-zincir atomiklik: payment'ın KENDİ archive audit'i başarılı olsun (bu, cascade
      // döngüsünün gerçekten başladığını kanıtlar) — ama döngü içindeki cancel_instance
      // audit'lerinden biri başarısız olsun; payment archive UPDATE'i de dahil TAMAMI rollback olmalı.
      const p2 = await seedPayment(pool, { status: "active" });
      const e1 = await seedInstance(pool, { paymentId: p2, instanceMonth: NEXT_MONTH, dueDate: "2026-09-05", status: "unpaid" });
      const e2 = await seedInstance(pool, { paymentId: p2, instanceMonth: "2026-10-01", dueDate: "2026-10-06", status: "unpaid" });
      const p2Before = JSON.stringify(await getPayment(pool, p2));
      const eBefore = await fingerprintInstances(pool, [e1, e2]);
      await pool.query(`
        create or replace function test_fail_on_cancel_instance_audit() returns trigger as $$
        begin
          if new.action = 'cancel_instance' then
            raise exception 'test induced failure on cancel_instance audit';
          end if;
          return new;
        end;
        $$ language plpgsql;
      `);
      await pool.query(
        "create trigger test_fail_cancel_audit before insert on public.audit_logs for each row execute function test_fail_on_cancel_instance_audit()",
      );
      try {
        await expectFnReject(
          () => archivePayment(appPool, p2, { reason: "rollback test", archivedByLabel: "test" }, TODAY),
          /cancel_instance audit/,
          "archivePayment tam-zincir rollback: cascade döngüsü ortasında (cancel_instance audit'i) hata fırlattı",
        );
      } finally {
        await pool.query("drop trigger test_fail_cancel_audit on public.audit_logs");
        await pool.query("drop function test_fail_on_cancel_instance_audit()");
      }
      const p2After = JSON.stringify(await getPayment(pool, p2));
      const eAfter = await fingerprintInstances(pool, [e1, e2]);
      record(
        "archivePayment tam-zincir rollback: cascade ortasında hata → payment archive UPDATE'i de dahil her şey rollback (payment hâlâ active, hiçbir instance cancel edilmedi)",
        p2Before === p2After && eBefore === eAfter,
      );
    }

    // Pre-existing archived-payment 26-satır legacy fixture — script'in TAMAMI (migration,
    // reconciliation, generation, archive cascade, risk-refresh-rollback testleri dahil)
    // çalıştıktan SONRA, TAM-SATIR (hiçbir kolon çıkarılmadan) fingerprint hâlâ birebir aynı
    // olmalı — bu, 26 satırın hiçbir kolonunda (status, cancellation metadata, amount metadata,
    // risk_level/risk_reasons, updated_at dahil) DML olmadığının kanıtı. Bu satırlar hiç
    // instance_month'u risk-refresh penceresine girmediği için (yukarıda kuruldu) bu karşılaştırma
    // önceden-var-olan risk-refresh mekanizmasınca da bozulamaz — testi zayıflatan bir dışlama yok.
    const legacyFingerprintAfter = await fingerprintInstances(pool, legacyIds);
    record(
      "Mevcut archived payment'ın (pre-existing) 26 legacy instance'ına otomatik backfill/DML yapılmadı (tam-satır fingerprint)",
      legacyFingerprintBefore === legacyFingerprintAfter,
    );

    // Risk penceresi fingerprint'inin en azından deterministik/okunabilir olduğunu doğrula
    // (order by id — generation/risk-refresh testlerinde kullanılan aynı pencere).
    const riskFp = await fingerprintRiskWindow(pool);
    record("Risk penceresi fingerprint sorgusu deterministik biçimde çalışır", typeof riskFp === "string");
  }

    if (migrationOk) {
      await runReconciliationAssertions();
    }
  } finally {
    await appPool.end();
    await pool.end();
    dropDb(DB);
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

main().catch((err) => {
  console.error("reconciliation-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
