// Disposable-DB test suite for the P0-B Slice 3 status-transition guards (0026-0027) +
// cancelInstance/cancelCheck/cancelLoanInstallment + markInstancePaid/markInstanceUnpaid's
// new app-layer source-status guard. Mirrors scripts/db/constraints-verify.ts's pattern:
// throwaway DB only, never mas_radar_dev, no ensure.ts wrapper.
//
// FAIL-CLOSED SAFETY GATE: no module under src/ (action files, engine files, or anything else
// that could reach src/lib/db.ts's getPool() singleton, which defaults to the REAL mas_radar_dev
// when DATABASE_URL is unset) is imported at the top of this file. They are all loaded via
// dynamic import() further down, and only after: the disposable DB exists, process.env.DATABASE_URL
// points at it, the parsed DB name is verified against both an expected-prefix allowlist and an
// explicit mas_radar_dev denylist, and a live `select current_database()` on that connection
// confirms it. Any failure in that chain exits 1 before a single src/ module is ever imported.
// (Historical note: an earlier draft of this script imported those modules statically and, as a
// result, two harmless SELECT ... FOR UPDATE lookups were sent to the real mas_radar_dev — no
// rows matched, nothing was written, but that gap is exactly what this gate closes for good.)
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { MIGRATIONS_DIR, validateFileSet } from "./migration-lib";
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
const DB = "mas_radar_transitions_verify";
// Derived from files on disk, not hardcoded — a fixed "30 satır, last migration 0030"
// literal here went stale the moment 0031/0032 were added, same class of bug
// CANONICAL_MIGRATION_COUNT in migrate-verify.ts already exists to avoid.
const CANONICAL_MIGRATION_FILES = validateFileSet(MIGRATIONS_DIR).files;
const CANONICAL_MIGRATION_COUNT = CANONICAL_MIGRATION_FILES.length;
const CANONICAL_LAST_VERSION = CANONICAL_MIGRATION_FILES.map((f) => f.version).sort().at(-1);
const DISPOSABLE_PREFIX = "mas_radar_transitions_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

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
async function expectFnReject(fn: () => Promise<void>, nameSubstr: RegExp, label: string): Promise<void> {
  try {
    await fn();
    record(label, false, "beklenmedik şekilde başarılı oldu");
  } catch (err) {
    const msg = (err as Error).message;
    record(label, nameSubstr.test(msg), msg.slice(0, 160));
  }
}
async function expectFnAccept(fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
    record(label, true);
  } catch (err) {
    record(label, false, (err as Error).message.slice(0, 160));
  }
}

/* ── seed helpers: INSERT is never guarded by the (before update) transition trigger ── */
async function seedPI(pool: Pool, status: string): Promise<string> {
  const needsPaidAt = status === "paid" || status === "partial";
  const isCancelled = status === "cancelled";
  const r = await pool.query<{ id: string }>(
    `insert into public.payment_instances
       (instance_month, due_date, status, amount, paid_amount, paid_at, cancelled_at, cancel_reason)
     values ('2020-01-01','2020-01-05',$1,100,
       case when $2 then 50 else null end,
       case when $2 then now() else null end,
       case when $3 then now() else null end,
       case when $3 then 'seed' else null end)
     returning id`,
    [status, needsPaidAt, isCancelled],
  );
  return r.rows[0].id;
}
async function seedCheck(pool: Pool, status: string): Promise<string> {
  const isCancelled = status === "cancelled";
  const r = await pool.query<{ id: string }>(
    `insert into public.checks (maturity_date, status, cancelled_at, cancel_reason)
     values ('2020-01-05',$1, case when $2 then now() else null end, case when $2 then 'seed' else null end)
     returning id`,
    [status, isCancelled],
  );
  return r.rows[0].id;
}
async function seedLI(pool: Pool, status: string, loanId: string): Promise<string> {
  const needsPaidAt = status === "paid" || status === "partial";
  const isCancelled = status === "cancelled";
  const r = await pool.query<{ id: string }>(
    `insert into public.loan_installments (loan_id, due_date, amount, status, paid_at, cancelled_at, cancel_reason)
     values ($1,'2020-01-05',100,$2,
       case when $3 then now() else null end,
       case when $4 then now() else null end,
       case when $4 then 'seed' else null end)
     returning id`,
    [loanId, status, needsPaidAt, isCancelled],
  );
  return r.rows[0].id;
}

/* ── accept-path UPDATE builders: fix up dependent fields so ONLY the transition guard
   is under test, not an unrelated constraint (paid_at/cancelled_at requirements) ── */
function acceptSql(table: string, to: string): { sql: string; params: (id: string) => unknown[] } {
  if (to === "paid") {
    return {
      sql: `update ${table} set status='paid', paid_at=now()${table === "payment_instances" ? ", paid_amount=100" : ""} where id=$1`,
      params: (id) => [id],
    };
  }
  if (to === "unpaid") {
    return {
      sql: `update ${table} set status='unpaid', paid_at=null${table === "payment_instances" ? ", paid_amount=null" : ""} where id=$1`,
      params: (id) => [id],
    };
  }
  if (to === "cancelled") {
    return { sql: `update ${table} set status='cancelled', cancelled_at=now(), cancel_reason='ok' where id=$1`, params: (id) => [id] };
  }
  return { sql: `update ${table} set status=$2 where id=$1`, params: (id) => [id, to] };
}

const PI_STATUSES = ["planned", "unpaid", "partial", "paid", "late", "cancelled", "unknown"];
const PI_ALLOWED = new Set([
  "unpaid|paid", "planned|paid", "late|paid", "partial|paid",
  "unpaid|partial", "planned|partial", "late|partial", // 0033: markInstancePartial's matching gap
  "paid|unpaid",
  "unpaid|cancelled", "planned|cancelled", "late|cancelled",
]);
const CHECK_STATUSES = ["planned", "cleared", "bounced", "cancelled", "unknown"];
const CHECK_ALLOWED = new Set([
  "planned|cleared", "planned|bounced", // 0034: settlement outcomes 0027 never allowed
  "planned|cancelled",
]);
const LI_STATUSES = ["planned", "unpaid", "partial", "paid", "late", "cancelled"];
const LI_ALLOWED = new Set([
  "planned|paid", "late|paid", "planned|late", // 0034: settlement outcomes 0027 never allowed
  "planned|cancelled", "late|cancelled",
]);

// Harmless self-assignment per table used to probe the same-status no-op path — proves the
// trigger doesn't block on an unrelated field change, without depending on a text column that
// not every table has (loan_installments has neither `note` nor `notes`).
const NOOP_COLUMN: Record<string, string> = {
  payment_instances: "note = note",
  checks: "notes = notes",
  loan_installments: "amount = amount",
};

async function tableDrivenTransitions(
  pool: Pool,
  table: string,
  statuses: string[],
  allowed: Set<string>,
  seed: (status: string) => Promise<string>,
): Promise<void> {
  for (const from of statuses) {
    for (const to of statuses) {
      const id = await seed(from);
      if (from === to) {
        await expectAccept(pool, `update ${table} set ${NOOP_COLUMN[table]} where id=$1`, [id], `${table} ${from}→${to} (aynı-durum no-op)`);
        continue;
      }
      const key = `${from}|${to}`;
      if (allowed.has(key)) {
        const { sql, params } = acceptSql(table, to);
        await expectAccept(pool, sql, params(id), `${table} ${from}→${to} izinli`);
      } else {
        await expectReject(pool, `update ${table} set status=$2 where id=$1`, [id, to], /status_transition_guard|izinli değil/, `${table} ${from}→${to} yasak`);
      }
    }
  }
}

async function main(): Promise<void> {
  console.log("=== transitions-verify: P0-B Slice 3 disposable-DB test suite (fail-closed) ===\n");

  // ── Fail-closed güvenlik kapısı — bu noktaya kadar src/ altında HİÇBİR modül import edilmedi. ──
  assertSafeDisposableName(DB, "sabit DB adı (DB sabiti)");
  assertContainerReachable();
  restoreManagedFixtureInto(DB);

  const disposableUrl = dbUrl(DB);
  process.env.DATABASE_URL = disposableUrl;
  // Aynı gerekçe: owner URL'i de bu sürece pinle (bkz. scripts/db/owner-url.ts).
  process.env.MIGRATION_DATABASE_URL = disposableUrl;
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
  const { markInstancePaid, markInstanceUnpaid, cancelInstance } = await import("../../src/lib/radar/engine");
  const { cancelCheck, cancelLoanInstallment } = await import("../../src/lib/financing/engine");
  const { cancelActionSchema } = await import("../../src/lib/validation/financial");
  const { DomainError } = await import("../../src/lib/domain-error");
  const { markPaidAction, markUnpaidAction } = await import("../../src/app/(dashboard)/radar/actions");
  const { getPool } = await import("../../src/lib/db");

  // Everything after the migration/fixture-prep chain below — unchanged in substance from
  // before this fix, only moved into a function so it can be called conditionally (only once
  // the disposable DB has genuinely reached a fully-migrated, 0030-validated state).
  async function runTransitionAssertions(): Promise<void> {
    // Every mutation below writes audit_logs.actor_id, an FK to public.users(id) since 0032.
    // This harness has no logged-in session, so it attributes to the reserved is_active=false
    // "system" account — same convention as every other non-interactive script.
    const actorId = await ensureSystemActor(pool);

    // The reserved, never-loggable account that MAS_QA_BYPASS_AUTH resolves to (see
    // getQaBypassUser() in src/lib/auth.ts). Seeded with the same idempotent, is_active=false
    // shape scripts/db/sanitize-testsprite.sql uses, so the bypass resolves identically here
    // and in the TestSprite harness rather than through a second, divergent mechanism.
    // is_active=false is what makes the flag fail closed: a real dev/prod DB never has this
    // row, so leaving MAS_QA_BYPASS_AUTH set anywhere else yields no session at all.
    await pool.query(
      `insert into public.users (username, password_hash, display_name, role, is_active)
       values ('testsprite-qa', 'sanitized-unusable-hash', 'TestSprite QA', 'admin', false)
       on conflict (username) do nothing`,
    );
    // Zod boundary — tested directly against the schema, no Next.js runtime needed.
    record("Zod: boş reason reddedilir", !cancelActionSchema.safeParse({ id: "0e8af5cc-ad81-4c52-9dbd-cb2f51b095e9", reason: "" }).success);
    record("Zod: yalnız-boşluk reason reddedilir", !cancelActionSchema.safeParse({ id: "0e8af5cc-ad81-4c52-9dbd-cb2f51b095e9", reason: "   " }).success);
    record("Zod: geçersiz UUID reddedilir", !cancelActionSchema.safeParse({ id: "not-a-uuid", reason: "geçerli neden" }).success);
    record("Zod: geçerli girdi kabul edilir", cancelActionSchema.safeParse({ id: "0e8af5cc-ad81-4c52-9dbd-cb2f51b095e9", reason: "geçerli neden" }).success);

    // Legacy cancelled+null-metadata satırı: 0030 gerekliliği yüzünden fixture preparation bu
    // ÖZEL satırın (LEGACY_ANOMALY_INSTANCE_ID) cancellation metadata'sını artık migrate.ts
    // zincirinin bir ÖNKOŞULU olarak dolduruyor — status='cancelled' + cancelled_at IS NULL
    // durumu artık tamamen migre edilmiş bir DB'de YAPISAL OLARAK İMKANSIZ (0030 validate
    // edildiği için CHECK constraint her satırı kapsar). Bu yüzden orijinal "satır hâlâ kırık
    // bulunur" senaryosu artık test edilemez — ama asıl korunan invariant hâlâ anlamlı ve
    // test edilebilir: bu tarihsel olarak istisnai satırın kendisi bile artık constraint
    // tarafından korunuyor, geriye kırık duruma döndürülemiyor.
    const legacy = await pool.query<{ id: string; cancelled_at: string | null; cancel_reason: string | null }>(
      "select id, cancelled_at, cancel_reason from payment_instances where id=$1",
      [LEGACY_ANOMALY_INSTANCE_ID],
    );
    record(
      "Legacy cancelled satır (fixture preparation ile onarılmış) fixture'da bulundu ve metadata dolu",
      legacy.rowCount === 1 && legacy.rows[0].cancelled_at !== null && legacy.rows[0].cancel_reason !== null,
      JSON.stringify(legacy.rows[0]),
    );
    if (legacy.rowCount === 1) {
      const legacyId = legacy.rows[0].id;
      await expectReject(
        pool,
        "update public.payment_instances set cancelled_at=null where id=$1",
        [legacyId],
        /cancel_consistency/,
        "Legacy satır (onarılmış): geriye null metadata'ya döndürme denemesi 0030 tarafından validate edilmiş CHECK constraint tarafından reddedilir",
      );
      await expectReject(
        pool,
        "update public.payment_instances set status='unpaid' where id=$1",
        [legacyId],
        /status_transition_guard|izinli değil/,
        "Legacy satır (onarılmış): status değiştirme denemesi ayrıca trigger tarafından da reddedilir",
      );
    }

    // Tam sıralı-çift (Cartesian) döngüsü — üç tablo.
    const loanId = (await pool.query<{ id: string }>("select id from loans limit 1")).rows[0].id;
    await tableDrivenTransitions(pool, "payment_instances", PI_STATUSES, PI_ALLOWED, (s) => seedPI(pool, s));
    await tableDrivenTransitions(pool, "checks", CHECK_STATUSES, CHECK_ALLOWED, (s) => seedCheck(pool, s));
    await tableDrivenTransitions(pool, "loan_installments", LI_STATUSES, LI_ALLOWED, (s) => seedLI(pool, s, loanId));

    // markInstancePaid/markInstanceUnpaid — gerçek fonksiyonlar, app-layer domain hatası.
    const freshUnpaid = await seedPI(pool, "unpaid");
    await expectFnAccept(async () => markInstancePaid(appPool, freshUnpaid, 100, actorId), "markInstancePaid: unpaid→paid gerçek fonksiyonla başarılı");
    const freshPaidForUnpaid = await seedPI(pool, "paid");
    await expectFnAccept(async () => markInstanceUnpaid(appPool, freshPaidForUnpaid, actorId), "markInstanceUnpaid: paid→unpaid gerçek fonksiyonla başarılı");
    const freshCancelledForPaid = await seedPI(pool, "cancelled");
    await expectFnReject(
      async () => markInstancePaid(appPool, freshCancelledForPaid, 100, actorId),
      /durumundan ödendi işaretlenemez/,
      "markInstancePaid: cancelled kaynaktan app-layer domain hatası (DB trigger'a düşmeden)",
    );
    const freshUnpaidForUnmark = await seedPI(pool, "unpaid");
    await expectFnReject(
      async () => markInstanceUnpaid(appPool, freshUnpaidForUnmark, actorId),
      /durumundan geri alınamaz/,
      "markInstanceUnpaid: unpaid kaynaktan app-layer domain hatası",
    );

    // Re-call semantics — tekrar çağrı sessizce yeni timestamp/audit üretmemeli, kontrollü
    // domain hatası vermeli. "paid olmayan → mark unpaid" zaten yukarıda test edildi.
    {
      const alreadyPaid = await seedPI(pool, "paid");
      const before = await pool.query("select paid_at, paid_amount from payment_instances where id=$1", [alreadyPaid]);
      const auditBefore = await pool.query<{ n: string }>(
        "select count(*)::text as n from audit_logs where entity_table='payment_instances' and entity_id=$1", [alreadyPaid],
      );
      await expectFnReject(
        async () => markInstancePaid(appPool, alreadyPaid, 999, actorId),
        /durumundan ödendi işaretlenemez/,
        "Tekrar çağrı: zaten paid → mark paid tekrar → domain hatası",
      );
      const after = await pool.query("select paid_at, paid_amount from payment_instances where id=$1", [alreadyPaid]);
      const auditAfter = await pool.query<{ n: string }>(
        "select count(*)::text as n from audit_logs where entity_table='payment_instances' and entity_id=$1", [alreadyPaid],
      );
      record(
        "Tekrar çağrı: zaten paid → mark paid tekrar → paid_at/paid_amount değişmedi, yeni audit satırı yok",
        JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]) && auditBefore.rows[0].n === auditAfter.rows[0].n,
      );
    }
    {
      const alreadyCancelled = await seedPI(pool, "cancelled");
      const before = await pool.query("select cancelled_at, cancel_reason from payment_instances where id=$1", [alreadyCancelled]);
      await expectFnReject(
        async () => cancelInstance(appPool, alreadyCancelled, "tekrar iptal", actorId),
        /durumundan iptal edilemez/,
        "Tekrar çağrı: zaten cancelled (payment_instances) → cancel tekrar → domain hatası",
      );
      const after = await pool.query("select cancelled_at, cancel_reason from payment_instances where id=$1", [alreadyCancelled]);
      record(
        "Tekrar çağrı: zaten cancelled (payment_instances) → cancelled_at/cancel_reason değişmedi",
        JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]),
      );
    }
    {
      const alreadyCancelledCheck = await seedCheck(pool, "cancelled");
      await expectFnReject(
        async () => cancelCheck(appPool, alreadyCancelledCheck, "tekrar iptal", actorId),
        /durumundan iptal edilemez/,
        "Tekrar çağrı: zaten cancelled (checks) → cancel tekrar → domain hatası",
      );
    }
    {
      const alreadyCancelledLI = await seedLI(pool, "cancelled", loanId);
      await expectFnReject(
        async () => cancelLoanInstallment(appPool, alreadyCancelledLI, "tekrar iptal", actorId),
        /durumundan iptal edilemez/,
        "Tekrar çağrı: zaten cancelled (loan_installments) → cancel tekrar → domain hatası",
      );
    }

    // Hata sınıflandırması: bilinen domain hataları DomainError örneğidir (action katmanı bunu
    // güvenli mesaja çevirebilir); ham/beklenmeyen sistem hataları DEĞİLDİR (yutulmamalı,
    // olduğu gibi fırlatılmalı). "check(false)" ile audit INSERT'i kasıtlı bozarak markInstancePaid
    // içinde app-layer guard'ın DIŞINDA, gerçek bir sistem hatası üretiyoruz.
    {
      const cancelledForClassify = await seedPI(pool, "cancelled");
      try {
        await markInstancePaid(appPool, cancelledForClassify, 100, actorId);
        record("Sınıflandırma: bilinen hata DomainError örneğidir", false, "beklenmedik başarı");
      } catch (e) {
        record("Sınıflandırma: bilinen hata (yanlış kaynak status) DomainError örneğidir", e instanceof DomainError);
        record(
          "Sınıflandırma: bilinen hata mesajı ham Postgres/stack-trace içermiyor",
          !/relation|constraint|at Object|at async|node_modules|\.ts:\d/.test((e as Error).message),
        );
      }

      await pool.query("alter table public.audit_logs add constraint test_force_fail_classify check (false) not valid");
      try {
        const freshForSystemError = await seedPI(pool, "unpaid");
        try {
          await markInstancePaid(appPool, freshForSystemError, 100, actorId);
          record("Sınıflandırma: bilinmeyen sistem hatası DomainError DEĞİLDİR", false, "beklenmedik başarı");
        } catch (e) {
          record("Sınıflandırma: bilinmeyen sistem hatası (audit INSERT başarısız) DomainError DEĞİLDİR — yutulmaz, olduğu gibi kalır", !(e instanceof DomainError));
        }
      } finally {
        await pool.query("alter table public.audit_logs drop constraint test_force_fail_classify");
      }
    }

    // markPaidAction/markUnpaidAction — gerçek Next.js action'ları, doğrudan çağrılır (disposable
    // DB'ye pinlenmiş process.env.DATABASE_URL sayesinde getPool() de disposable DB'ye bağlanır).
    // Bilinen domain hatası → redirect() (NEXT_REDIRECT) ile güvenli mesaj; ham Postgres/
    // stack-trace metni asla kullanıcıya gitmez.
    //
    // P0-A sonrası bu action'lar kendi içlerinde requireSession() → cookies() çağırıyor; çıplak
    // fonksiyon olarak çağrıldıklarında gerçek bir Next.js request scope'u olmadığı için
    // "`cookies` was called outside a request scope" ile patlıyorlardı. Yeni bir test kancası
    // icat etmek yerine var olan QA bypass'ı kullanıyoruz (yukarıda seed'lenen testsprite-qa
    // satırı + bu bayrak). Bayrak SADECE bu blok boyunca açık: try/finally ile eski değerine
    // döndürülüyor, böylece script'in geri kalanı auth açısından fail-closed kalıyor.
    const qaFlagBefore = process.env.MAS_QA_BYPASS_AUTH;
    process.env.MAS_QA_BYPASS_AUTH = "1";
    try {
    {
      const cancelledForAction = await seedPI(pool, "cancelled");
      const fd = new FormData();
      fd.set("id", cancelledForAction);
      fd.set("backTo", "/radar");
      try {
        await markPaidAction(fd);
        record("markPaidAction: cancelled kaynaktan çağrı yönlendirme ile sonuçlanır (çıplak hata sızmaz)", false, "beklenmedik şekilde döndü");
      } catch (e) {
        const digest = (e as { digest?: string }).digest ?? "";
        const isRedirect = digest.startsWith("NEXT_REDIRECT") || /NEXT_REDIRECT/.test((e as Error).message ?? "");
        record("markPaidAction: cancelled kaynaktan çağrı yönlendirme ile sonuçlanır (çıplak hata sızmaz)", isRedirect, JSON.stringify({ digest, message: (e as Error).message }).slice(0, 200));
      }
    }
    {
      // markPaidAction's success path calls revalidatePath(), which needs a live Next.js
      // request context this disposable-DB script cannot provide ("static generation store
      // missing") — that specific, expected environment artifact is not a domain-error
      // redirect, so seeing it (instead of NEXT_REDIRECT) still proves the action took the
      // success branch and never routed a valid transition through the error-conversion path.
      const unpaidForAction = await seedPI(pool, "unpaid");
      const fd = new FormData();
      fd.set("id", unpaidForAction);
      fd.set("backTo", "/radar");
      try {
        await markPaidAction(fd);
        record("markPaidAction: unpaid kaynaktan başarı yolunu izler (domain-error redirect'ine düşmez)", true);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        record(
          "markPaidAction: unpaid kaynaktan başarı yolunu izler (domain-error redirect'ine düşmez)",
          !/NEXT_REDIRECT/.test(msg) && /static generation store missing/.test(msg),
          msg.slice(0, 160),
        );
      }
    }
    {
      const unpaidForUnmarkAction = await seedPI(pool, "unpaid");
      const fd = new FormData();
      fd.set("id", unpaidForUnmarkAction);
      fd.set("backTo", "/radar");
      try {
        await markUnpaidAction(fd);
        record("markUnpaidAction: unpaid kaynaktan çağrı yönlendirme ile sonuçlanır (çıplak hata sızmaz)", false, "beklenmedik şekilde döndü");
      } catch (e) {
        const digest = (e as { digest?: string }).digest ?? "";
        const isRedirect = digest.startsWith("NEXT_REDIRECT") || /NEXT_REDIRECT/.test((e as Error).message ?? "");
        record("markUnpaidAction: unpaid kaynaktan çağrı yönlendirme ile sonuçlanır (çıplak hata sızmaz)", isRedirect, JSON.stringify({ digest, message: (e as Error).message }).slice(0, 200));
      }
    }
    {
      const paidForUnmarkAction = await seedPI(pool, "paid");
      const fd = new FormData();
      fd.set("id", paidForUnmarkAction);
      fd.set("backTo", "/radar");
      try {
        await markUnpaidAction(fd);
        record("markUnpaidAction: paid kaynaktan başarı yolunu izler (domain-error redirect'ine düşmez)", true);
      } catch (e) {
        const msg = (e as Error).message ?? "";
        record(
          "markUnpaidAction: paid kaynaktan başarı yolunu izler (domain-error redirect'ine düşmez)",
          !/NEXT_REDIRECT/.test(msg) && /static generation store missing/.test(msg),
          msg.slice(0, 160),
        );
      }
    }
    } finally {
      if (qaFlagBefore === undefined) delete process.env.MAS_QA_BYPASS_AUTH;
      else process.env.MAS_QA_BYPASS_AUTH = qaFlagBefore;
    }

    // Yeni cancel fonksiyonları — başarı + kayıt yok + yasak kaynak status.
    const freshUnpaidForCancel = await seedPI(pool, "unpaid");
    await expectFnAccept(async () => cancelInstance(appPool, freshUnpaidForCancel, "test iptal", actorId), "cancelInstance: unpaid→cancelled başarılı");
    await expectFnReject(
      async () => cancelInstance(appPool, "00000000-0000-0000-0000-000000000000", "x", actorId),
      /instance not found/,
      "cancelInstance: kayıt yok hatası",
    );
    const freshPaidForCancel = await seedPI(pool, "paid");
    await expectFnReject(
      async () => cancelInstance(appPool, freshPaidForCancel, "x", actorId),
      /durumundan iptal edilemez/,
      "cancelInstance: paid kaynaktan app-layer domain hatası",
    );

    const freshPlannedCheck = await seedCheck(pool, "planned");
    await expectFnAccept(async () => cancelCheck(appPool, freshPlannedCheck, "test iptal", actorId), "cancelCheck: planned→cancelled başarılı");
    await expectFnReject(
      async () => cancelCheck(appPool, "00000000-0000-0000-0000-000000000000", "x", actorId),
      /check not found/,
      "cancelCheck: kayıt yok hatası",
    );

    const freshPlannedLI = await seedLI(pool, "planned", loanId);
    await expectFnAccept(async () => cancelLoanInstallment(appPool, freshPlannedLI, "test iptal", actorId), "cancelLoanInstallment: planned→cancelled başarılı");
    await expectFnReject(
      async () => cancelLoanInstallment(appPool, "00000000-0000-0000-0000-000000000000", "x", actorId),
      /loan installment not found/,
      "cancelLoanInstallment: kayıt yok hatası",
    );

    // Rollback/atomicity — üç cancel fonksiyonunun tamamı, ayrı ayrı.
    await pool.query("alter table public.audit_logs add constraint test_force_fail check (false) not valid");
    try {
      const rbInstance = await seedPI(pool, "unpaid");
      let threw = false;
      try {
        await cancelInstance(appPool, rbInstance, "should rollback", actorId);
      } catch {
        threw = true;
      }
      record("cancelInstance rollback: hata fırlatıldı", threw);
      const afterInst = await pool.query("select status, cancelled_at, cancel_reason from payment_instances where id=$1", [rbInstance]);
      record("cancelInstance rollback: satır değişmedi", afterInst.rows[0].status === "unpaid" && afterInst.rows[0].cancelled_at === null);

      const rbCheck = await seedCheck(pool, "planned");
      threw = false;
      try {
        await cancelCheck(appPool, rbCheck, "should rollback", actorId);
      } catch {
        threw = true;
      }
      record("cancelCheck rollback: hata fırlatıldı", threw);
      const afterCheck = await pool.query("select status, cancelled_at from checks where id=$1", [rbCheck]);
      record("cancelCheck rollback: satır değişmedi", afterCheck.rows[0].status === "planned" && afterCheck.rows[0].cancelled_at === null);

      const rbLI = await seedLI(pool, "planned", loanId);
      threw = false;
      try {
        await cancelLoanInstallment(appPool, rbLI, "should rollback", actorId);
      } catch {
        threw = true;
      }
      record("cancelLoanInstallment rollback: hata fırlatıldı", threw);
      const afterLI = await pool.query("select status, cancelled_at from loan_installments where id=$1", [rbLI]);
      record("cancelLoanInstallment rollback: satır değişmedi", afterLI.rows[0].status === "planned" && afterLI.rows[0].cancelled_at === null);
    } finally {
      await pool.query("alter table public.audit_logs drop constraint test_force_fail");
    }
  }

  try {
    // backups/p0b-managed-baseline-*.dump is frozen from before Slice 5's legacy-repair apply
    // ever ran, so it still carries the one known payment_instances anomaly 0026 grandfathered
    // (see 0026's own comment) — applying every pending migration in one run therefore fails
    // exactly at 0030, same root cause as migrate-verify.ts's LEGACY_COMPLETE/Checksum-drift
    // and constraints-verify.ts's own fixture. applyPendingSequentially (migrate.ts:142-157)
    // commits each pending migration in its own transaction, so 0022-0029 (0026 included — the
    // migration that adds the cancelled_at/cancel_reason columns this fixture doesn't have
    // yet) commit for real before 0030 reaches the still-unrepaired row and fails.
    const bootstrapRun = runMigrateAgainstUrl(disposableUrl);
    record(
      "0026-0029 migrate.ts ile uygulandı, 0030 bilinen ihlal nedeniyle beklenen şekilde durdu",
      bootstrapRun.code !== 0
        && /Pending migration 0030/.test(bootstrapRun.stderr)
        && /payment_instances_cancel_consistency/.test(bootstrapRun.stderr),
      bootstrapRun.stderr.slice(0, 300),
    );

    let migrationOk = false;
    if (bootstrapRun.code !== 0 && /Pending migration 0030/.test(bootstrapRun.stderr)) {
      const violationsBeforePrep = await countPaymentInstancesCancelViolations(pool);
      record(
        "p0b-managed-baseline: 0026-0029 sonrası hâlâ bilinen legacy ihlalini taşıyor (1 satır)",
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
        "0026-0030 migrate.ts ile başarıyla uygulandı (fixture düzeltmesinden sonra)",
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
            `ledger üçüncü çalıştırma sonrası hâlâ ${CANONICAL_MIGRATION_COUNT} satır, last migration ${CANONICAL_LAST_VERSION}`,
            ledgerRes.rows[0]?.n === CANONICAL_MIGRATION_COUNT && ledgerRes.rows[0]?.last_version === CANONICAL_LAST_VERSION,
            `got n=${ledgerRes.rows[0]?.n} last=${ledgerRes.rows[0]?.last_version}`,
          );
        }
      }
    }

    if (migrationOk) {
      await runTransitionAssertions();
    }
  } finally {
    await appPool.end();
    await pool.end();
    // markPaidAction/markUnpaidAction opened src/lib/db.ts's global pool singleton (pinned to
    // the disposable DB by the safety gate above) — it must be closed too, or dropdb below
    // fails with "database is being accessed by other users".
    await getPool().end();
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
  console.error("transitions-verify beklenmedik hata ile durdu:", err);
  process.exit(1);
});
