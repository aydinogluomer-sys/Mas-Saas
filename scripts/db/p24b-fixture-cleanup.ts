// P24B fixture cleanup — v2. Replaces scripts/db/fixture-cleanup.ts, which is OUTDATED and must
// never run: it still expects users=4, payment_instances=3 and knows nothing of settings or
// approvals. The measured footprint is 42 rows across 6 tables.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MANIFEST IS THE ONLY SOURCE OF SCOPE.
//
// Nothing here re-derives what to delete. The scope comes from
// docs/release-evidence/final-production-readiness/p24b-v6/02-row-evidence-manifest.json, whose
// SHA256 is pinned below. Writing the ID list a second time by hand is how a cleanup script and
// its evidence drift apart, and the drift is silent — the old script is proof.
//
// There is NO `like '%p24b%'`, NO timestamp range, NO heuristic anywhere in the delete path.
// Every statement matches exact primary identity, and every row is re-read and fingerprint-checked
// before a single delete runs. A pattern match would have deleted whatever happened to look like a
// fixture on the day someone ran it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// MODES — real execution is behind THREE independent locks, checked before the transaction opens.
//
//   (default)                        PREFLIGHT. Reads, checks, reports. Never mutates.
//   --rehearsal                      Executes against a DISPOSABLE database. Refuses a protected
//                                    name. A completely separate code path from real execution,
//                                    so the two cannot be confused by a mistyped flag.
//   --execute-p24b-cleanup-42        Executes against mas_radar_dev. ALSO requires:
//                                      env  MAS_ALLOW_P24B_CLEANUP=42-confirmed
//                                      env  MAS_P24B_BACKUP_RECEIPT=<path to an off-device receipt>
//                                    Any one missing → exit non-zero before anything opens.
//
// WHY A SECOND CLEANUP RUN MUST FAIL. An idempotent "0 rows deleted, success" is the worst
// possible outcome for an operator: it makes a no-op indistinguishable from a completed cleanup,
// and it makes a cleanup pointed at the WRONG database look successful. The precondition gate
// demands all 42 rows present with matching fingerprints, so the second run fails loudly with
// PRECONDITION_NOT_SATISFIED.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl, PROTECTED_DB_NAMES } from "./owner-url";

const MANIFEST_PATH = path.join(
  "docs", "release-evidence", "final-production-readiness", "p24b-v6", "02-row-evidence-manifest.json",
);
/** Pinned at the commit that produced the manifest. A mismatch means the evidence moved; stop. */
const EXPECTED_MANIFEST_SHA256 = "d60de97bcc3c62aa2902b64a7c164e8132e733ba7f6958e71b1a84bac3c8bbb9";

const EXPECTED_COUNTS: Record<string, number> = {
  action_items: 4, approvals: 4, payment_instances: 26, payments: 1, users: 6, settings: 1,
};
const EXPECTED_TOTAL = 42;
/** Delete order. Re-verified against pg_catalog before use; never trusted as a bare constant. */
const ORDER = ["action_items", "approvals", "payment_instances", "payments", "users", "settings"] as const;
const REAL_DB = "mas_radar_dev";
const ATILLA = "atilla";
/** Tables the cleanup is allowed to change. Everything else must be byte-identical afterwards. */
const MUTABLE = new Set<string>([...ORDER]);

interface ManifestRow {
  table: string; id: string; rowFingerprint: string;
  criticalFields: Record<string, string | null>;
  classification: string; xmin: string;
}
interface Manifest { total: number; counts: Record<string, number>; classificationTotals: Record<string, number>; rows: ManifestRow[] }

type Mode = "preflight" | "rehearsal" | "execute";
const args = process.argv.slice(2);
const mode: Mode = args.includes("--execute-p24b-cleanup-42")
  ? "execute" : args.includes("--rehearsal") ? "rehearsal" : "preflight";

const fail = (msg: string, code = 1): never => { console.error(`DURDURULDU: ${msg}`); process.exit(code); };
const receipt: Record<string, unknown> = { mode, startedAtUtc: new Date().toISOString() };

/* ── 1. manifest identity ─────────────────────────────────────────────────────────────────── */
if (!existsSync(MANIFEST_PATH)) fail(`manifest bulunamadı: ${MANIFEST_PATH}`);
const manifestRaw = readFileSync(MANIFEST_PATH);
const manifestSha = createHash("sha256").update(manifestRaw).digest("hex");
if (manifestSha !== EXPECTED_MANIFEST_SHA256) {
  fail(
    `manifest SHA256 uyuşmuyor.\n  beklenen: ${EXPECTED_MANIFEST_SHA256}\n  ölçülen : ${manifestSha}\n` +
      "Kanıt değişmiş. Kapsamı yeniden doğrulamadan silme yapılmaz.",
  );
}
const manifest = JSON.parse(manifestRaw.toString("utf8")) as Manifest;
if (manifest.total !== EXPECTED_TOTAL) fail(`manifest total ${manifest.total}, ${EXPECTED_TOTAL} bekleniyordu`);
if ((manifest.classificationTotals.UNRESOLVED ?? 0) !== 0) fail("manifestte UNRESOLVED satır var");
const targets = manifest.rows.filter((r) => r.classification === "DELETE_TARGET");
if (targets.length !== EXPECTED_TOTAL) fail(`DELETE_TARGET ${targets.length}, ${EXPECTED_TOTAL} bekleniyordu`);
for (const [t, n] of Object.entries(EXPECTED_COUNTS)) {
  const got = targets.filter((r) => r.table === t).length;
  if (got !== n) fail(`tablo dağılımı bozuk: ${t} ${got}, ${n} bekleniyordu`);
}
const unexpectedTables = [...new Set(targets.map((r) => r.table))].filter((t) => !EXPECTED_COUNTS[t]);
if (unexpectedTables.length) fail(`beklenmeyen hedef tablo: ${unexpectedTables.join(", ")}`);
receipt.manifestSha256 = manifestSha;
receipt.targetRows = targets.length;
receipt.targetTables = EXPECTED_COUNTS;

/* ── 2. execution locks ───────────────────────────────────────────────────────────────────── */
if (mode === "execute") {
  if (process.env.MAS_ALLOW_P24B_CLEANUP !== "42-confirmed") {
    fail("gerçek çalıştırma için MAS_ALLOW_P24B_CLEANUP=42-confirmed zorunlu (bayrak tek başına yetmez)", 9);
  }
  const rec = process.env.MAS_P24B_BACKUP_RECEIPT;
  if (!rec || !existsSync(rec)) {
    fail("gerçek çalıştırma için MAS_P24B_BACKUP_RECEIPT geçerli bir off-device yedek makbuzunu göstermeli", 9);
  }
  receipt.backupReceipt = rec;
}

const url = ownerDatabaseUrl();
if (!url) fail("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil");
const urlDbName = databaseNameFromUrl(url as string);

/* Identity gate, decided from the URL BEFORE connecting, then re-measured from the server. */
if (mode === "rehearsal" && !isDisposableDatabaseName(urlDbName)) {
  fail(`--rehearsal yalnız harcanabilir bir veritabanında çalışır; '${urlDbName}' değil`, 9);
}
if (mode === "execute" && urlDbName !== REAL_DB) {
  fail(`--execute-p24b-cleanup-42 yalnız ${REAL_DB} üzerinde çalışır; hedef '${urlDbName}'`, 9);
}
if (mode === "preflight" && urlDbName && PROTECTED_DB_NAMES.includes(urlDbName) && false) { /* preflight reads anywhere */ }

async function tableCounts(c: PoolClient, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = Number((await c.query<{ n: string }>(`select count(*)::text n from public.${t}`)).rows[0].n);
  }
  return out;
}

/** Row count + order-independent content hash for every base table. */
async function fingerprintAll(c: PoolClient): Promise<Record<string, string>> {
  const tabs = (await c.query<{ s: string; t: string }>(
    `select table_schema s, table_name t from information_schema.tables
      where table_type='BASE TABLE' and table_schema in ('public','auth') order by 1,2`)).rows;
  const out: Record<string, string> = {};
  for (const { s, t } of tabs) {
    const r = await c.query<{ n: string; fp: string }>(
      `select count(*)::text n, coalesce(md5(string_agg(x::text,'|' order by x::text)),'EMPTY') fp
         from "${s}"."${t}" x`);
    out[`${s}.${t}`] = `${r.rows[0].n}:${r.rows[0].fp}`;
  }
  return out;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: url as string, max: 2 });
  const c = await pool.connect();
  try {
    const dbName = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    receipt.database = dbName;
    console.log(`mod=${mode}  veritabanı=${dbName}  manifest=${manifestSha.slice(0, 12)}…`);

    // Server-measured identity, not just the URL's opinion.
    if (mode === "execute" && dbName !== REAL_DB) fail(`ölçülen veritabanı '${dbName}', ${REAL_DB} bekleniyordu`, 9);
    if (mode === "rehearsal" && !isDisposableDatabaseName(dbName)) fail(`ölçülen veritabanı '${dbName}' harcanabilir değil`, 9);

    const ledger = (await c.query<{ v: string; n: string }>(
      "select max(version) v, count(*)::text n from public.schema_migrations")).rows[0];
    receipt.ledger = `${ledger.v}/${ledger.n}`;
    if (receipt.ledger !== "0087/87") fail(`ledger ${receipt.ledger}, 0087/87 bekleniyordu`);

    /* ── 3. FK contract, re-measured ─────────────────────────────────────────────────────── */
    const fks = (await c.query<{ child: string; col: string; parent: string; act: string }>(
      `select c.conrelid::regclass::text child, a.attname col, c.confrelid::regclass::text parent,
              case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
                   when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end act
         from pg_constraint c
         join unnest(c.conkey) with ordinality k(attnum,ord) on true
         join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
        where c.contype='f' and c.confrelid::regclass::text = any($1::text[]) order by 1,2`,
      [[...ORDER]])).rows;
    receipt.fkContract = fks;
    const pi = fks.find((f) => f.child === "payment_instances" && f.col === "payment_id" && f.parent === "payments");
    if (!pi) {
      fail("payment_instances.payment_id -> payments FK'sı bulunamadı; şema beklenenden farklı");
    } else if (pi.act !== "SET NULL") {
      fail(`payment_instances.payment_id ON DELETE '${pi.act}', 'SET NULL' bekleniyordu — silme sırası bu davranışa dayanıyor`);
    }
    // Anything that would CASCADE out of a target table is a scope change, not a detail.
    const cascades = fks.filter((f) => f.act === "CASCADE");
    if (cascades.length) {
      fail(`hedef tablolardan CASCADE eden FK var (kapsam genişler): ${cascades.map((f) => `${f.child}.${f.col}`).join(", ")}`);
    }
    console.log(`  FK sözleşmesi doğrulandı (${fks.length} gelen FK, payment_instances=SET NULL, CASCADE yok)`);

    /* ── 4. precondition gate ────────────────────────────────────────────────────────────── */
    const problems: string[] = [];
    for (const r of targets) {
      const idCol = r.table === "settings" ? "key" : "id";
      const cast = r.table === "settings" ? "text" : "uuid";
      const q = await c.query<{ fp: string }>(
        `select md5(x::text) fp from public.${r.table} x where x.${idCol} = $1::${cast}`, [r.id]);
      if (q.rowCount === 0) { problems.push(`${r.table}/${r.id} BULUNAMADI`); continue; }
      if (q.rows[0].fp !== r.rowFingerprint) {
        problems.push(`${r.table}/${r.id} parmak izi farklı (beklenen ${r.rowFingerprint.slice(0, 8)}, ölçülen ${q.rows[0].fp.slice(0, 8)})`);
      }
    }
    receipt.preconditionProblems = problems;
    if (problems.length) {
      receipt.precondition = "FAIL";
      writeReceipt();
      console.error(`PRECONDITION_NOT_SATISFIED — ${problems.length} sorun:`);
      for (const p of problems.slice(0, 12)) console.error(`  ${p}`);
      process.exit(2);
    }
    receipt.precondition = "PASS";
    console.log(`  önkoşul: 42/42 satır mevcut ve parmak izleri eşleşiyor`);

    const beforeCounts = await tableCounts(c, [...ORDER]);
    const money = (await c.query<{ k: string; v: string }>(
      `select 'payments' k, coalesce(sum(default_amount),0)::text v from public.payments
       union all select 'instances', coalesce(sum(amount),0)::text from public.payment_instances
       union all select 'checks', coalesce(sum(amount),0)::text from public.checks
       union all select 'loans', coalesce(sum(principal),0)::text from public.loans
       union all select 'cashflow', coalesce(sum(closing_balance),0)::text from public.cashflow_months`)).rows;
    const beforeMoney = Object.fromEntries(money.map((m) => [m.k, m.v]));
    receipt.before = { counts: beforeCounts, money: beforeMoney };

    if (mode === "preflight") {
      receipt.result = "PREFLIGHT_ONLY — hiçbir mutasyon yapılmadı";
      console.log("PREFLIGHT tamam: tüm kapılar geçti, silme YAPILMADI.");
      writeReceipt();
      return;
    }

    /* ── 5. the transaction ──────────────────────────────────────────────────────────────── */
    const beforeFp = await fingerprintAll(c);
    await c.query("begin");
    try {
      // Write freeze. SHARE ROW EXCLUSIVE blocks every writer (INSERT/UPDATE/DELETE and DDL) while
      // still permitting plain SELECT, so a reader that wanders in is not broken by the cleanup.
      // A short timeout keeps a stuck lock from turning into an open transaction on the real
      // database — failing to acquire is a rollback, never a wait.
      await c.query("set local lock_timeout = '10s'");
      for (const t of [...ORDER, "metric_snapshots"]) {
        await c.query(`lock table public.${t} in share row exclusive mode`);
      }
      receipt.lockMode = "SHARE ROW EXCLUSIVE (writers blocked, readers allowed), lock_timeout=10s";

      const deletes: Array<{ step: number; table: string; expected: number; actual: number }> = [];
      let step = 0;
      for (const t of ORDER) {
        step += 1;
        const ids = targets.filter((r) => r.table === t).map((r) => r.id);
        const sql = t === "settings"
          ? `delete from public.settings where key = any($1::text[])`
          : `delete from public.${t} where id = any($1::uuid[])`;
        const res = await c.query(sql, [ids]);
        const actual = res.rowCount ?? -1;
        deletes.push({ step, table: t, expected: EXPECTED_COUNTS[t], actual });
        console.log(`  ${step}. ${t.padEnd(18)} silinen=${actual} (beklenen ${EXPECTED_COUNTS[t]})`);
        if (actual !== EXPECTED_COUNTS[t]) {
          throw new Error(`${t}: ${actual} satır silindi, ${EXPECTED_COUNTS[t]} bekleniyordu — GERİ ALINIYOR`);
        }
      }
      receipt.deletes = deletes;

      /* ── 6. pre-commit gates ───────────────────────────────────────────────────────────── */
      const afterCounts = await tableCounts(c, [...ORDER]);
      for (const t of ORDER) {
        const delta = beforeCounts[t] - afterCounts[t];
        if (delta !== EXPECTED_COUNTS[t]) throw new Error(`${t} delta ${delta}, ${EXPECTED_COUNTS[t]} bekleniyordu`);
      }
      receipt.after = { counts: afterCounts };

      const money2 = (await c.query<{ k: string; v: string }>(
        `select 'payments' k, coalesce(sum(default_amount),0)::text v from public.payments
         union all select 'instances', coalesce(sum(amount),0)::text from public.payment_instances
         union all select 'checks', coalesce(sum(amount),0)::text from public.checks
         union all select 'loans', coalesce(sum(principal),0)::text from public.loans
         union all select 'cashflow', coalesce(sum(closing_balance),0)::text from public.cashflow_months`)).rows;
      const afterMoney = Object.fromEntries(money2.map((m) => [m.k, m.v]));
      const expectedMoneyDelta: Record<string, string> = {
        payments: "-1000", instances: "-26000", checks: "0", loans: "0", cashflow: "0",
      };
      const moneyDeltas: Record<string, string> = {};
      for (const k of Object.keys(expectedMoneyDelta)) {
        const d = Number(afterMoney[k]) - Number(beforeMoney[k]);
        moneyDeltas[k] = d.toString();
        if (d !== Number(expectedMoneyDelta[k])) {
          throw new Error(`parasal delta ${k}: ${d}, ${expectedMoneyDelta[k]} bekleniyordu`);
        }
      }
      receipt.money = { before: beforeMoney, after: afterMoney, deltas: moneyDeltas };

      // Residual / orphan / preservation gates.
      const g = (await c.query<{ k: string; v: string }>(
        `select 'fixture_payment' k, count(*)::text v from public.payments where id='7b300bfe-944f-468b-91fa-2de65b7cfee5'
         union all select 'orphan_instances', count(*)::text from public.payment_instances where payment_id is null
         union all select 'p24b_users', count(*)::text from public.users u where u::text ilike '%p24b%'
         union all select 'p24b_action_items', count(*)::text from public.action_items a where a::text ilike '%p24b%'
         union all select 'p24b_settings', count(*)::text from public.settings s where s::text ilike '%p24b%'
         union all select 'atilla', count(*)::text from public.users where username='${ATILLA}'
         union all select 'ledger', count(*)::text from public.schema_migrations`)).rows;
      const gates = Object.fromEntries(g.map((x) => [x.k, Number(x.v)]));
      receipt.residualGates = gates;
      for (const [k, want] of Object.entries({ fixture_payment: 0, orphan_instances: 0, p24b_users: 0, p24b_action_items: 0, p24b_settings: 0, atilla: 1, ledger: 87 })) {
        if (gates[k] !== want) throw new Error(`kapı '${k}': ${gates[k]}, ${want} bekleniyordu`);
      }

      // Non-target fingerprint: everything outside the six tables must be byte-identical.
      const afterFp = await fingerprintAll(c);
      const changed = Object.keys(beforeFp).filter((t) => beforeFp[t] !== afterFp[t]);
      const illegal = changed.filter((t) => !MUTABLE.has(t.replace(/^public\./, "")));
      receipt.changedTables = changed;
      receipt.illegalChanges = illegal;
      if (illegal.length) throw new Error(`hedef DIŞI tablo değişti: ${illegal.join(", ")}`);

      await c.query("commit");
      receipt.result = "COMMITTED";
      console.log(`  COMMIT — 42 satır silindi, hedef dışı değişiklik yok`);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      receipt.result = "ROLLED_BACK";
      receipt.error = (e as Error).message;
      writeReceipt();
      console.error(`GERİ ALINDI: ${(e as Error).message}`);
      process.exit(3);
    }
    writeReceipt();
  } finally {
    c.release();
    await pool.end();
  }
}

function writeReceipt(): void {
  receipt.finishedAtUtc = new Date().toISOString();
  const out = process.env.MAS_P24B_CLEANUP_OUT;
  if (out) { writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n", "utf8"); console.log(`makbuz: ${out}`); }
  else console.log(JSON.stringify(receipt, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
