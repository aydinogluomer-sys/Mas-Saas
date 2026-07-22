// Disposable-DB test suite for the P0-B Slice 2 constraints (0022-0025) + archivePayment().
// Every test runs against a throwaway DB in the same Docker cluster as mas_radar_dev — never
// against mas_radar_dev itself. Unlike migrate-verify.ts, this script does NOT wrap ensure.ts:
// it checks the container is already reachable and fails clearly rather than auto-provisioning.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { archivePayment } from "../../src/lib/payments/engine";
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
const DB = "mas_radar_constraints_verify";

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
function assertContainerReachable(): void {
  try {
    docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"], { quiet: true });
  } catch {
    console.error(
      `PostgreSQL konteyneri (${CONTAINER}) erişilebilir değil. Bu script onu otomatik başlatmaz ` +
        `(yalnız disposable DB kullanır, mas_radar_dev üzerinde ensure/create/migrate yapmaz) — ` +
        `önce container'ı manuel hazırlayın.`,
    );
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

function findLatestManagedFixtureDump(): string {
  const dir = path.join(ROOT, "backups");
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("p0b-managed-baseline-") && f.endsWith(".dump"))
    .sort();
  if (files.length === 0) {
    throw new Error("backups/p0b-managed-baseline-*.dump bulunamadı — önce Slice 1'in managed fixture yedeği alınmalı.");
  }
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

async function expectReject(pool: Pool, sql: string, params: unknown[], nameSubstr: RegExp, label: string): Promise<void> {
  try {
    await pool.query(sql, params);
    record(label, false, "beklenmedik şekilde başarılı oldu");
  } catch (err) {
    const msg = (err as Error).message;
    record(label, nameSubstr.test(msg), msg.slice(0, 160));
  }
}
async function expectAccept(pool: Pool, sql: string, params: unknown[], label: string): Promise<void> {
  try {
    await pool.query(sql, params);
    record(label, true);
  } catch (err) {
    record(label, false, (err as Error).message.slice(0, 160));
  }
}

/** The suite's own original Slice 2 constraint assertions (0022-0025 + archivePayment()) —
 * extracted out of main() so they only run once the disposable DB has genuinely reached a
 * fully-migrated, 0030-validated state; unchanged in substance from before this fix. */
async function runConstraintAssertions(pool: Pool, anomalyId: string): Promise<void> {
  // audit_logs append-only
  const auditRow = await pool.query<{ id: string }>("select id from audit_logs limit 1");
  await expectReject(pool, "update public.audit_logs set action='x' where id=$1", [auditRow.rows[0].id], /append-only/, "audit_logs: UPDATE reddedilir");
  await expectReject(pool, "delete from public.audit_logs where id=$1", [auditRow.rows[0].id], /append-only/, "audit_logs: DELETE reddedilir");
  await expectReject(pool, "truncate public.audit_logs", [], /append-only/, "audit_logs: TRUNCATE reddedilir");
  await expectAccept(
    pool,
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data) values (null,'test_insert','payments',null,null,null)`,
    [],
    "audit_logs: normal INSERT başarılı olur",
  );

  // Legacy anomali satırı — arbitrary update / silent unarchive reddedilmeli
  await expectReject(pool, "update public.payments set description='anomaly-test-change-1' where id=$1", [anomalyId], /immutable/, "legacy anomali: keyfi alan değişikliği reddedilir");
  await expectReject(pool, "update public.payments set status='active' where id=$1", [anomalyId], /immutable/, "legacy anomali: status='active'ye sessiz geçiş reddedilir");
  await expectReject(pool, "update public.payments set status='paused' where id=$1", [anomalyId], /immutable/, "legacy anomali: status='paused'a sessiz geçiş reddedilir");
  // yalnız metadata completion kabul edilir
  await expectAccept(
    pool,
    "update public.payments set archived_at=now(), archive_reason='legacy completion', archived_by_label='mas-dashboard' where id=$1",
    [anomalyId],
    "legacy anomali: yalnız metadata completion kabul edilir",
  );
  // completion sonrası tam immutable
  await expectReject(pool, "update public.payments set description='anomaly-test-change-2' where id=$1", [anomalyId], /immutable/, "legacy anomali: completion sonrası tekrar değişiklik reddedilir (tam kilit)");
  await expectReject(pool, "update public.payments set archive_reason='changed' where id=$1", [anomalyId], /immutable/, "legacy anomali: completion sonrası metadata'yı tekrar değiştirme reddedilir");

  // archivePayment() — gerçek uygulama kodu, ham SQL değil
  const freshForEngine = await pool.query<{ id: string }>(
    "select id from payments where id<>$1 and status<>'archived' order by id limit 1",
    [anomalyId],
  );
  const engineId: string = freshForEngine.rows[0].id;
  const appPool = new Pool({ connectionString: dbUrl(DB), max: 5 });
  try {
    // Slice 4: archivePayment() now takes an explicit todayISO — a far-future anchor keeps
    // its cascade (due_date >= todayISO) from matching any realistic fixture instance, so
    // this Slice 2-era test's archive-only assertions stay unaffected by that new behavior.
    await archivePayment(appPool, engineId, { reason: "test archive", archivedByLabel: "mas-dashboard" }, "2030-01-01");
    const after = await pool.query<{ status: string; archived_at: Date | null; archive_reason: string | null; archived_by_label: string | null }>(
      "select status, archived_at, archive_reason, archived_by_label from payments where id=$1",
      [engineId],
    );
    const row = after.rows[0];
    record(
      "archivePayment(): status+üç metadata alanı tek transaction'da doğru yazıldı",
      row.status === "archived" && row.archived_at !== null && row.archive_reason === "test archive" && row.archived_by_label === "mas-dashboard",
    );
    const auditCheck = await pool.query<{ n: string }>(
      "select count(*)::text as n from audit_logs where entity_table='payments' and entity_id=$1 and action='archive_payment'",
      [engineId],
    );
    record("archivePayment(): audit_logs satırı aynı transaction'da yazıldı", auditCheck.rows[0].n === "1", `got ${auditCheck.rows[0].n}`);
  } catch (err) {
    record("archivePayment(): status+üç metadata alanı tek transaction'da doğru yazıldı", false, (err as Error).message.slice(0, 160));
  }

  // Rollback/atomicity testi: audit_logs INSERT'i kasıtlı olarak başarısız hale getir
  const freshForRollback = await pool.query<{ id: string }>(
    "select id from payments where id<>$1 and id<>$2 and status<>'archived' order by id limit 1",
    [anomalyId, engineId],
  );
  const rollbackId: string = freshForRollback.rows[0].id;
  const beforeRollback = await pool.query(
    "select status, archived_at, archive_reason, archived_by_label from payments where id=$1",
    [rollbackId],
  );
  // Managed fixture is real data — rollbackId may already have genuine historical
  // audit_logs rows, so the correct assertion is "count unchanged", not "count is zero".
  const auditCountBefore = await pool.query<{ n: string }>(
    "select count(*)::text as n from audit_logs where entity_table='payments' and entity_id=$1",
    [rollbackId],
  );
  await pool.query("alter table public.audit_logs add constraint test_force_fail check (false) not valid");
  let threw = false;
  try {
    await archivePayment(appPool, rollbackId, { reason: "should rollback", archivedByLabel: "mas-dashboard" }, "2030-01-01");
  } catch {
    threw = true;
  }
  record("archivePayment() rollback: audit INSERT başarısız olunca hata fırlatılır", threw);
  const afterRollback = await pool.query(
    "select status, archived_at, archive_reason, archived_by_label from payments where id=$1",
    [rollbackId],
  );
  record(
    "archivePayment() rollback: payments satırı değişmeden kaldı",
    JSON.stringify(beforeRollback.rows[0]) === JSON.stringify(afterRollback.rows[0]),
  );
  const auditCountAfter = await pool.query<{ n: string }>(
    "select count(*)::text as n from audit_logs where entity_table='payments' and entity_id=$1",
    [rollbackId],
  );
  record(
    "archivePayment() rollback: audit_logs satır sayısı değişmedi (yeni satır eklenmedi)",
    auditCountBefore.rows[0].n === auditCountAfter.rows[0].n,
    `before=${auditCountBefore.rows[0].n} after=${auditCountAfter.rows[0].n}`,
  );
  await pool.query("alter table public.audit_logs drop constraint test_force_fail");
  await appPool.end();

  // 0023: status='archived' ama archived_at null bırakan taze bir satır
  const freshFor0023 = await pool.query<{ id: string }>(
    "select id from payments where id<>$1 and id<>$2 and id<>$3 and status<>'archived' order by id limit 1",
    [anomalyId, engineId, rollbackId],
  );
  await expectReject(
    pool,
    "update public.payments set status='archived', archived_at=null where id=$1",
    [freshFor0023.rows[0].id],
    /payments_archive_consistency/,
    "0023: status='archived' + archived_at null reddedilir",
  );

  // 0025: payment_instances / loan_installments paid-field scoping
  const instAny = await pool.query<{ id: string }>("select id from payment_instances where status='unpaid' limit 1");
  await expectReject(
    pool,
    "update public.payment_instances set paid_at=now() where id=$1",
    [instAny.rows[0].id],
    /payment_instances_paid_fields_scoped/,
    "0025: payment_instances unpaid + paid_at reddedilir",
  );
  const instPartial = await pool.query<{ id: string }>("select id from payment_instances where status='partial' limit 1");
  if (instPartial.rowCount) {
    await expectAccept(
      pool,
      "update public.payment_instances set paid_at=now(), paid_amount=100 where id=$1",
      [instPartial.rows[0].id],
      "0025: payment_instances partial + paid_at/paid_amount kabul edilir",
    );
  }
  // INSERT, not UPDATE: Slice 3's transition guard forbids planned→paid for loan_installments
  // (only planned→cancelled is allowed there), so a status='paid' UPDATE is now rejected by
  // that trigger regardless of paid_at — testing the 0025/0003 field constraints in isolation
  // requires creating the row already in 'paid' status, which INSERT allows (not guarded by
  // the before-update transition trigger).
  const loanForInsert = await pool.query<{ id: string }>("select id from loans limit 1");
  await expectReject(
    pool,
    "insert into public.loan_installments (loan_id, due_date, amount, status, paid_at) values ($1,'2020-01-05',100,'paid',null)",
    [loanForInsert.rows[0].id],
    /paid_requires_paid_at|loan_installments_paid_fields_scoped/,
    "0025: loan_installments status='paid' + paid_at null reddedilir (0003 kuralı, INSERT ile)",
  );
  await expectAccept(
    pool,
    "insert into public.loan_installments (loan_id, due_date, amount, status, paid_at) values ($1,'2020-01-05',100,'paid',now())",
    [loanForInsert.rows[0].id],
    "0025: loan_installments status='paid' + paid_at kabul edilir (INSERT ile)",
  );
}

async function main(): Promise<void> {
  console.log("=== constraints-verify: P0-B Slice 2 disposable-DB test suite ===\n");
  assertContainerReachable();

  restoreManagedFixtureInto(DB);
  const pool = new Pool({ connectionString: dbUrl(DB), max: 1 });

  try {
    // Legacy-anomaly satırı 0023 UYGULANMADAN ÖNCE seed edilir (NOT VALID, yeni yazımları
    // engeller ama mevcut satırları geriye dönük doğrulamaz — bu satır sonradan oluşturulmaya
    // çalışılırsa constraint reddeder, test anlamsızlaşır).
    const anomaly = await pool.query<{ id: string }>("select id from payments order by id limit 1");
    const anomalyId: string = anomaly.rows[0].id;
    await pool.query(
      `update public.payments set status='archived', archived_at=null, archive_reason=null, archived_by_label=null where id=$1`,
      [anomalyId],
    );

    // backups/p0b-managed-baseline-*.dump is frozen from before Slice 5's legacy-repair apply
    // ever ran, so it still carries the one known payment_instances anomaly 0026 grandfathered
    // (see 0026's own comment) — applying every pending migration in one run therefore fails
    // exactly at 0030, same root cause as migrate-verify.ts's LEGACY_COMPLETE/Checksum-drift
    // scenarios. applyPendingSequentially (migrate.ts:142-157) commits each pending migration
    // in its own transaction, so 0022-0029 (0026 included — the migration that adds the
    // cancelled_at/cancel_reason columns this fixture doesn't have yet) commit for real before
    // 0030 reaches the still-unrepaired row and fails.
    const bootstrapRun = runMigrateAgainstUrl(dbUrl(DB));
    record(
      "0022-0029 migrate.ts ile uygulandı, 0030 bilinen ihlal nedeniyle beklenen şekilde durdu",
      bootstrapRun.code !== 0
        && /Pending migration 0030/.test(bootstrapRun.stderr)
        && /payment_instances_cancel_consistency/.test(bootstrapRun.stderr),
      bootstrapRun.stderr.slice(0, 300),
    );

    let migrationOk = false;
    if (bootstrapRun.code !== 0 && /Pending migration 0030/.test(bootstrapRun.stderr)) {
      const violationsBeforePrep = await countPaymentInstancesCancelViolations(pool);
      record(
        "p0b-managed-baseline: 0022-0029 sonrası hâlâ bilinen legacy ihlalini taşıyor (1 satır)",
        violationsBeforePrep === 1,
        `got ${violationsBeforePrep}`,
      );

      // Test-setup-only fixture preparation (NOT a production repair — see the shared
      // helper's own doc comment). Narrow before/after checks prove it touched only the
      // one named row.
      const countsBeforePrep = await getTableRowCounts(pool, []);
      const fpBeforePrep = await fingerprintPaymentInstancesExcluding(pool, LEGACY_ANOMALY_INSTANCE_ID);

      await prepareLegacyCheckpointForCancellationValidation(dbUrl(DB));

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

      const secondRun = runMigrateAgainstUrl(dbUrl(DB));
      record(
        "0022-0030 migrate.ts ile başarıyla uygulandı (fixture düzeltmesinden sonra)",
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
      }
    }

    if (migrationOk) {
      await runConstraintAssertions(pool, anomalyId);
    }
  } finally {
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
  console.error("constraints-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
