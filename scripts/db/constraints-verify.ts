// Disposable-DB test suite for the P0-B Slice 2 constraints (0022-0025) + archivePayment().
// Every test runs against a throwaway DB in the same Docker cluster as mas_radar_dev — never
// against mas_radar_dev itself. Unlike migrate-verify.ts, this script does NOT wrap ensure.ts:
// it checks the container is already reachable and fails clearly rather than auto-provisioning.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { archivePayment } from "../../src/lib/payments/engine";
import { ensureSystemActor } from "./seed-system-actor";
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
/**
 * Faz 19 additions (migrations 0036-0039).
 *
 * Extended here rather than only in phase19-verify because these are CONSTRAINTS, and this is
 * the script that owns constraint coverage. phase19-verify proves the behaviour of the views
 * and the change-recorder; this proves the FKs and CHECKs refuse what they must.
 */
async function runFaz19ConstraintAssertions(pool: Pool): Promise<void> {
  const party = (await pool.query<{ id: string }>(
    `insert into public.parties(name, normalized_name, party_type)
     values ('CV Faz19', 'cv faz19', 'vendor') returning id`)).rows[0].id;

  // ── FK integrity: every new reference must refuse an unknown parent ──────────────────────
  const ghost = "00000000-0000-0000-0000-000000000000";
  await expectReject(pool, `insert into public.counterparty_profiles(party_id) values ($1)`, [ghost],
    /foreign key|violates/i, "counterparty_profiles: bilinmeyen party_id reddedilir");
  await expectReject(pool, `insert into public.ibans(party_id, iban) values ($1,'TR330006100519786457841326')`, [ghost],
    /foreign key|violates/i, "ibans: bilinmeyen party_id reddedilir");
  await expectReject(pool, `insert into public.projects(code,name,party_id) values ('P19-P1','Proje',$1)`, [ghost],
    /foreign key|violates/i, "projects: bilinmeyen party_id reddedilir");
  await expectReject(pool, `insert into public.orders(code,party_id) values ('P19-O1',$1)`, [ghost],
    /foreign key|violates/i, "orders: bilinmeyen party_id reddedilir");
  await expectReject(pool, `insert into public.departments(code,name,parent_department_id) values ('P19-D1','Bölüm',$1)`, [ghost],
    /foreign key|violates/i, "departments: bilinmeyen parent_department_id reddedilir");

  // ── CHECK constraints ───────────────────────────────────────────────────────────────────
  await expectReject(pool, `insert into public.counterparty_profiles(party_id, credit_limit) values ($1, -0.01)`, [party],
    /credit_limit/i, "counterparty_profiles: negatif kredi limiti reddedilir");
  await expectReject(pool, `insert into public.counterparty_profiles(party_id, tax_number) values ($1, '   ')`, [party],
    /tax_number/i, "counterparty_profiles: boşluktan ibaret vergi no reddedilir");
  await expectReject(pool, `insert into public.counterparty_profiles(party_id, country_code) values ($1, 'TUR')`, [party],
    /country_code/i, "counterparty_profiles: 2 harf olmayan ülke kodu reddedilir");
  await expectAccept(pool, `insert into public.counterparty_profiles(party_id, credit_limit) values ($1, 0)`, [party],
    "counterparty_profiles: SIFIR kredi limiti kabul edilir (gerçek bir değer, 'limit yok' değil)");

  await expectReject(pool, `insert into public.ibans(party_id, iban) values ($1,'   ')`, [party],
    /iban/i, "ibans: boş IBAN reddedilir");
  await expectReject(pool, `insert into public.ibans(party_id, iban, currency) values ($1,'TR330006100519786457841326','TRYX')`, [party],
    /currency/i, "ibans: 3 harf olmayan para birimi reddedilir");

  await expectReject(pool, `insert into public.cost_centers(code,name) values ('  ','Ad')`, [],
    /code/i, "cost_centers: boş kod reddedilir");
  await expectAccept(pool, `insert into public.cost_centers(code,name) values ('P19-CC','Masraf Merkezi')`, [],
    "cost_centers: normal kayıt kabul edilir");
  await expectReject(pool, `insert into public.cost_centers(code,name) values ('P19-CC','Kopya')`, [],
    /unique|duplicate/i, "cost_centers: yinelenen kod reddedilir");

  // ── the 1:1 guarantee, as a constraint rather than a convention ──────────────────────────
  await expectReject(pool, `insert into public.counterparty_profiles(party_id) values ($1)`, [party],
    /unique|duplicate|pkey/i, "counterparty_profiles: aynı party için ikinci profil reddedilir (1:1)");

  // ── parties may not be deleted out from under a financial record ─────────────────────────
  // All eight pre-existing FKs into parties are NO ACTION; the Faz 19 additions must not have
  // quietly loosened that into a cascade that erases financial history.
  const guarded = (await pool.query<{ n: string }>(
    `select count(*) n from information_schema.referential_constraints rc
     join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.constraint_name
     where ccu.table_name = 'parties' and rc.delete_rule = 'CASCADE'
       and rc.constraint_name not like 'counterparty_profiles%'
       and rc.constraint_name not like 'ibans%'`)).rows[0].n;
  record(
    "parties'e giden mali FK'lar hâlâ CASCADE DEĞİL (yalnız profil/IBAN sidecar'ları cascade eder)",
    Number(guarded) === 0,
    `${guarded} beklenmeyen cascade`,
  );
}

/**
 * Faz 22 additions (migration 0048) — the allocation ceiling.
 *
 * implementation.md §18 states the invariant as "odenen > fatura, tahsilat > alacak hic
 * asilmamali" and is explicit that an application-level check does not satisfy it. So it is
 * asserted HERE, against the database, with the application nowhere in the picture: every
 * statement below is raw SQL that a rogue script or a psql session could equally have run.
 */
async function runFaz22ConstraintAssertions(pool: Pool, actorId: string): Promise<void> {
  const party = (await pool.query<{ id: string }>(
    `insert into public.parties(name, normalized_name, party_type)
     values ('Alloc Faz22', 'alloc faz22', 'customer') returning id`)).rows[0].id;

  const mkInvoice = async (no: string, gross: number, status: string) => {
    const id = (await pool.query<{ id: string }>(
      `insert into public.invoices(direction, invoice_no, party_id, issue_date,
                                   net_amount, tax_amount, gross_amount)
       values ('sales',$2,$1,'2026-01-01',$3::numeric,0,$3::numeric) returning id`,
      [party, no, gross])).rows[0].id;
    if (status !== "draft") await pool.query(`update public.invoices set status=$2 where id=$1`, [id, status]);
    return id;
  };

  const open = await mkInvoice("ALLOC-1", 120, "open");

  await expectReject(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, allocated_amount)
     values ($1,'manual',120.01)`, [open], /aşamaz/i,
    "0048: tek dagitim fatura tutarini asamaz");

  await expectAccept(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, allocated_amount)
     values ($1,'manual',100.00)`, [open],
    "0048: tutar icindeki dagitim kabul edilir");

  // The invariant is about the SUM, not one row — this is the case a per-row CHECK could never
  // have caught, and the reason 0048 uses a trigger.
  await expectReject(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, allocated_amount)
     values ($1,'manual',20.01)`, [open], /aşamaz/i,
    "0048: dagitim TOPLAMI fatura tutarini asamaz (satir bazli CHECK yakalayamazdi)");

  await expectAccept(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, allocated_amount)
     values ($1,'manual',20.00)`, [open],
    "0048: tam tutara kadar dagitim kabul edilir");

  const totals = await pool.query<{ allocated_amount: string }>(
    `select allocated_amount from public.invoices where id=$1`, [open]);
  record("0048: invoices.allocated_amount trigger tarafindan dogru tutuluyor",
    Number(totals.rows[0].allocated_amount) === 120, `allocated=${totals.rows[0].allocated_amount}`);

  // UPDATE must be guarded too, not just INSERT.
  await expectReject(pool,
    `update public.invoice_allocations set allocated_amount = allocated_amount + 1
     where invoice_id=$1 and reversed_at is null and allocated_amount = 20.00`, [open], /aşamaz/i,
    "0048: UPDATE ile tavan asilamaz");

  // Reversing frees room, and the total is recomputed from the surviving rows.
  await pool.query(
    `update public.invoice_allocations
       set reversed_at=now(), reversed_by=$2, reversed_reason='constraints-verify'
     where invoice_id=$1 and reversed_at is null and allocated_amount = 100.00`, [open, actorId]);
  const afterReversal = await pool.query<{ allocated_amount: string }>(
    `select allocated_amount from public.invoices where id=$1`, [open]);
  record("0048: iptal edilen dagitim toplamdan dusuluyor",
    Number(afterReversal.rows[0].allocated_amount) === 20, `allocated=${afterReversal.rows[0].allocated_amount}`);

  // Lifecycle gate: only an issued, live invoice may receive allocations.
  const draft = await mkInvoice("ALLOC-2", 50, "draft");
  await expectReject(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, allocated_amount)
     values ($1,'manual',10.00)`, [draft], /bağlanamaz/i,
    "0048: taslak faturaya dagitim yapilamaz");

  // The stored column may not be forged past the ceiling either.
  await expectReject(pool,
    `update public.invoices set allocated_amount = gross_amount + 1 where id=$1`, [open],
    /invoices_allocated_within_gross/i,
    "0048: invoices.allocated_amount kolonu da CHECK ile sinirli");

  // Source consistency: a typed source must name its row, 'manual' must not.
  await expectReject(pool,
    `insert into public.invoice_allocations(invoice_id, source_table, source_id, allocated_amount)
     values ($1,'manual','00000000-0000-0000-0000-000000000000',1.00)`, [open],
    /source_consistency/i, "0048: manual kaynak kayit id'si tasiyamaz");

  // Faz 22 / migration 0049: the matching CHECK really was widened.
  await expectAccept(pool,
    `insert into public.bank_transaction_match_candidates
       (bank_transaction_id, target_table, target_id, confidence)
     select bt.id, 'invoices', $1, 0.9 from public.bank_transactions bt limit 1`, [open],
    "0049: aday kuyrugu artik 'invoices' hedefini kabul ediyor (satir yoksa no-op)");
}

async function runConstraintAssertions(pool: Pool, anomalyId: string, actorId: string): Promise<void> {
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
    await archivePayment(appPool, engineId, { reason: "test archive", archivedByLabel: "mas-dashboard" }, "2030-01-01", actorId);
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
    await archivePayment(appPool, rollbackId, { reason: "should rollback", archivedByLabel: "mas-dashboard" }, "2030-01-01", actorId);
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


/**
 * Faz 31 — control alerts. Every new CHECK gets its own entry here, per the phase's own gate
 * requirement: this EXTENDS the script rather than altering any existing assertion.
 */
async function runFaz31ConstraintAssertions(pool: Pool, actorId: string): Promise<void> {
  const base = `insert into public.control_alerts (check_code, severity, title, rule_codes`;

  // has_rules — the coalesce() case. array_length() on an EMPTY array returns NULL, and a CHECK
  // evaluating to NULL PASSES; Faz 29 found that the hard way, so this pins the fixed form.
  await expectReject(
    pool,
    `${base}) values ('p31_x','warning','no rules','{}')`,
    [], /has_rules/, "control_alerts: gerekçesiz uyarı (boş dizi) reddedilir",
  );
  await expectAccept(
    pool,
    `${base}) values ('p31_ok','warning','has rule','{round_number}')`,
    [], "control_alerts: kural adı taşıyan uyarı kabul edilir",
  );

  // status_consistency — an open alert may not carry resolution or acknowledgement stamps.
  await expectReject(
    pool,
    `${base}, acknowledged_at, acknowledged_by)
     values ('p31_a','warning','open with ack','{round_number}', now(), $1)`,
    [actorId], /status_consistency/, "control_alerts: açık uyarı onay damgası taşıyamaz",
  );
  await expectReject(
    pool,
    `${base}, status, snooze_until) values ('p31_b','warning','snooze no date','{round_number}','snoozed', null)`,
    [], /status_consistency/, "control_alerts: erteleme tarihsiz olamaz",
  );

  // resolution_reason — closing without a reason is how a control gets quietly switched off.
  await expectReject(
    pool,
    `${base}, status, resolved_at, resolved_by)
     values ('p31_c','warning','resolved no note','{round_number}','resolved', now(), $1)`,
    [actorId], /resolution_reason/, "control_alerts: gerekçesiz kapatma reddedilir",
  );
  await expectAccept(
    pool,
    `${base}, status, resolved_at, resolved_by, resolution_note)
     values ('p31_d','warning','resolved ok','{round_number}','resolved', now(), $1, 'incelendi')`,
    [actorId], "control_alerts: gerekçeli kapatma kabul edilir",
  );

  // subject_pair — a subject id without its table points nowhere.
  await expectReject(
    pool,
    `${base}, subject_table) values ('p31_e','warning','half subject','{round_number}','invoices')`,
    [], /subject_pair/, "control_alerts: özne tablosu id'siz olamaz",
  );

  // seen_order — last_seen cannot precede first_seen.
  await expectReject(
    pool,
    `${base}, first_seen_at, last_seen_at)
     values ('p31_f','warning','time travel','{round_number}', now(), now() - interval '1 day')`,
    [], /seen_order/, "control_alerts: son görülme ilk görülmeden önce olamaz",
  );

  // anomaly_score range.
  await expectReject(
    pool,
    `${base}, anomaly_score) values ('p31_g','warning','bad score','{round_number}', 1.5)`,
    [], /anomaly_score/, "control_alerts: anomali skoru 0..1 dışına çıkamaz",
  );

  // alert_escalation_rules — a non-positive window would escalate instantly and forever.
  await expectReject(
    pool,
    `insert into public.alert_escalation_rules (code, description, severity, escalate_after_hours)
     values ('p31_esc','x','warning', 0)`,
    [], /escalate_after_hours/, "alert_escalation_rules: sıfır saatlik eskalasyon penceresi reddedilir",
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
      const actorId = await ensureSystemActor(pool);
      await runConstraintAssertions(pool, anomalyId, actorId);
      await runFaz19ConstraintAssertions(pool);
      await runFaz22ConstraintAssertions(pool, actorId);
      await runFaz31ConstraintAssertions(pool, actorId);
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
