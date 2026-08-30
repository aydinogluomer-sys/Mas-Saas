// P24B fixture cleanup — v2.1 (hardened). Replaces the retired scripts/db/fixture-cleanup.ts.
//
// ═══ WHAT v2.0 GOT WRONG, AND WHY EACH FIX IS SHAPED THE WAY IT IS ═══════════════════════════
//
// v2.0 passed its own rehearsal and was still not safe to point at the real database. Three
// defects, all of the same family: a check that LOOKS like a gate but does not bind to the thing
// it claims to guarantee.
//
// 1. BACKUP BINDING — v2.0 did `existsSync(process.env.MAS_P24B_BACKUP_RECEIPT)`. An empty file
//    at that path satisfied it. It proved a path existed, not that a backup existed, not that the
//    backup was off-device, not that the backup matched THIS database. Fixed by running the
//    canonical validator (offDeviceCleanupBlockers), re-hashing the destination file at execution
//    time, and requiring a separate cleanup-binding document that ties the backup to the exact
//    pre-cleanup state of the 42 target rows.
//
// 2. TOCTOU — v2.0 read preconditions, counts, money and the whole-database fingerprint, and THEN
//    opened the transaction and took its locks. Every number the commit decision rested on was
//    measured while other sessions were free to write. "The runtime is switched off" is an
//    operational claim, not a guarantee, and it is exactly the claim that failed twice in this
//    incident. Fixed by inverting the order: BEGIN and LOCK first, then measure everything that
//    matters inside the lock.
//
// 3. DERIVED CORRECTION — v2.0 deleted 42 rows and stopped. The two aggregates those rows had
//    corrupted (task_status.open = 8, payment_status.unpaid = 13,621,000) stayed wrong, and the
//    script reported success. Deleting the cause without correcting the effect leaves the database
//    committed-and-wrong. Fixed by recomputing the snapshots inside the SAME transaction, through
//    the product's own code path, so the repair is atomic and auditable.
//
// ═══ MODES — real execution is behind independent locks, all checked before BEGIN ════════════
//
//   (default)                   PREFLIGHT — reads and reports. Never mutates.
//   --rehearsal                 Executes against a DISPOSABLE database. Separate code path.
//   --execute-p24b-cleanup-42   Executes against mas_radar_dev. ALSO requires:
//                                 env MAS_ALLOW_P24B_CLEANUP=42-confirmed
//                                 env MAS_P24B_BACKUP_RECEIPT   (validated, not just present)
//                                 env MAS_P24B_CLEANUP_BINDING  (validated against live state)
//
// A second run fails with PRECONDITION_NOT_SATISFIED. An idempotent "0 rows, success" would make
// a finished cleanup indistinguishable from one that never ran, or one aimed at the wrong database.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "./owner-url";
import { offDeviceCleanupBlockers, sha256OfFile } from "../ops/backup-lib";

const MANIFEST_PATH = path.join(
  "docs", "release-evidence", "final-production-readiness", "p24b-v6", "02-row-evidence-manifest.json",
);
const EXPECTED_MANIFEST_SHA256 = "d60de97bcc3c62aa2902b64a7c164e8132e733ba7f6958e71b1a84bac3c8bbb9";
const BINDING_KIND = "mas-p24b-cleanup-binding-v1";

const EXPECTED_COUNTS: Record<string, number> = {
  action_items: 4, approvals: 4, payment_instances: 26, payments: 1, users: 6, settings: 1,
};
const EXPECTED_TOTAL = 42;
const ORDER = ["action_items", "approvals", "payment_instances", "payments", "users", "settings"] as const;
/** Locked together with the targets: the correction writes to both. */
const LOCK_TABLES = [...ORDER, "metric_snapshots", "audit_logs"] as const;
const REAL_DB = "mas_radar_dev";
const ATILLA = "atilla";
const MUTABLE = new Set<string>([...ORDER, "metric_snapshots", "audit_logs"]);
const SNAPSHOT_DATE = "2026-08-27";
/** Measured on a clone in V6.1 and re-asserted here: exactly these two values may move. */
const EXPECTED_SEMANTIC_CHANGES = 2;
/** refresh_metric_snapshots (product) + p24b_fixture_cleanup (this repair). */
const EXPECTED_AUDIT_INSERTS = 2;
const EXPECTED_MONEY_DELTA: Record<string, number> = {
  payments: -1000, instances: -26000, checks: 0, loans: 0, cashflow: 0,
};

interface ManifestRow {
  table: string; id: string; rowFingerprint: string;
  criticalFields: Record<string, string | null>; classification: string; xmin: string;
}
interface Manifest { total: number; counts: Record<string, number>; classificationTotals: Record<string, number>; rows: ManifestRow[] }
interface Binding {
  bindingKind: string; database: string; manifestSha256: string; targetRows: number; unresolved: number;
  migrationLatest: string; migrationCount: number;
  backupDestinationSha256: string; backupDestinationPath: string; createdAtUtc: string;
  preCleanupTargetFingerprint: string; preCleanupWholeDbFingerprint: string;
  preCleanupCounts: Record<string, number>;
  restoreSmoke: { restoredFromDestinationSha256: string; restoreDb: string; ledger: string; targetRows: number; fingerprint: string };
}

type Mode = "preflight" | "rehearsal" | "execute";
const args = process.argv.slice(2);
const mode: Mode = args.includes("--execute-p24b-cleanup-42")
  ? "execute" : args.includes("--rehearsal") ? "rehearsal" : "preflight";

const receipt: Record<string, unknown> = { mode, contractVersion: "v2.1", startedAtUtc: new Date().toISOString() };
function writeReceipt(): void {
  receipt.finishedAtUtc = new Date().toISOString();
  const out = process.env.MAS_P24B_CLEANUP_OUT;
  if (out) { writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n", "utf8"); console.log(`makbuz: ${out}`); }
  else console.log(JSON.stringify(receipt, null, 2));
}
function fail(msg: string, code = 1): never {
  receipt.result = "FAILED_CLOSED"; receipt.error = msg;
  writeReceipt();
  console.error(`DURDURULDU: ${msg}`);
  process.exit(code);
}

/* ── manifest identity ────────────────────────────────────────────────────────────────────── */
if (!existsSync(MANIFEST_PATH)) fail(`manifest bulunamadı: ${MANIFEST_PATH}`);
const manifestRaw = readFileSync(MANIFEST_PATH);
const manifestSha = createHash("sha256").update(manifestRaw).digest("hex");
if (manifestSha !== EXPECTED_MANIFEST_SHA256) {
  fail(`manifest SHA256 uyuşmuyor.\n  beklenen: ${EXPECTED_MANIFEST_SHA256}\n  ölçülen : ${manifestSha}`);
}
const manifest = JSON.parse(manifestRaw.toString("utf8")) as Manifest;
if (manifest.total !== EXPECTED_TOTAL) fail(`manifest total ${manifest.total}`);
if ((manifest.classificationTotals.UNRESOLVED ?? 0) !== 0) fail("manifestte UNRESOLVED satır var");
const targets = manifest.rows.filter((r) => r.classification === "DELETE_TARGET");
if (targets.length !== EXPECTED_TOTAL) fail(`DELETE_TARGET ${targets.length}`);
for (const [t, n] of Object.entries(EXPECTED_COUNTS)) {
  if (targets.filter((r) => r.table === t).length !== n) fail(`tablo dağılımı bozuk: ${t}`);
}
receipt.manifestSha256 = manifestSha;

/* ── backup receipt + cleanup binding ─────────────────────────────────────────────────────── */
let binding: Binding | null = null;
if (mode === "execute" || mode === "rehearsal") {
  if (mode === "execute" && process.env.MAS_ALLOW_P24B_CLEANUP !== "42-confirmed") {
    fail("MAS_ALLOW_P24B_CLEANUP=42-confirmed zorunlu (bayrak tek başına yetmez)", 9);
  }
  const recPath = process.env.MAS_P24B_BACKUP_RECEIPT;
  if (!recPath) fail("MAS_P24B_BACKUP_RECEIPT tanımlı değil", 9);
  if (!existsSync(recPath)) fail(`yedek makbuzu yok: ${recPath}`, 9);

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(recPath, "utf8")); }
  catch (e) { fail(`yedek makbuzu ayrıştırılamadı: ${(e as Error).message}`, 9); }

  // The canonical policy check — the same one the backup subsystem uses. It rejects
  // LOCAL_STANDIN and OPERATOR_ATTESTED targets, and any receipt whose destination
  // verification flags are not all true.
  const blockers = offDeviceCleanupBlockers(raw);
  if (blockers.length) fail(`yedek makbuzu yıkıcı işlem için yetersiz:\n  - ${blockers.join("\n  - ")}`, 9);

  const r = raw as { destPath: string; destSha256: string; destBytes: number; sourceSha256: string };
  // Re-verify the FILE, now, rather than trusting what the receipt says about it. A receipt is a
  // claim about a file; the file can be moved, truncated or replaced after the claim was written.
  if (!existsSync(r.destPath)) fail(`makbuzun gösterdiği yedek dosyası yok: ${r.destPath}`, 9);
  const actualSha = sha256OfFile(r.destPath);
  const actualBytes = statSync(r.destPath).size;
  if (actualSha !== r.destSha256) fail(`hedefteki yedeğin SHA256'sı makbuzla uyuşmuyor (dosya değişmiş)`, 9);
  if (actualBytes !== r.destBytes) fail(`hedefteki yedeğin bayt sayısı makbuzla uyuşmuyor`, 9);
  if (r.sourceSha256 !== r.destSha256) fail(`kaynak ve hedef SHA256 farklı — kopya sadık değil`, 9);
  receipt.backupReceipt = { path: recPath, destPath: r.destPath, destSha256: actualSha, destBytes: actualBytes, revalidatedAtExecution: true };

  // The binding ties that backup to THIS database's exact pre-cleanup state.
  const bPath = process.env.MAS_P24B_CLEANUP_BINDING;
  if (!bPath || !existsSync(bPath)) fail("MAS_P24B_CLEANUP_BINDING geçerli bir binding dosyasını göstermeli", 9);
  let braw: unknown;
  try { braw = JSON.parse(readFileSync(bPath, "utf8")); }
  catch (e) { fail(`binding ayrıştırılamadı: ${(e as Error).message}`, 9); }
  const b = braw as Binding;
  const bp: string[] = [];
  if (b.bindingKind !== BINDING_KIND) bp.push(`bindingKind '${BINDING_KIND}' olmalı`);
  if (b.manifestSha256 !== EXPECTED_MANIFEST_SHA256) bp.push("binding farklı bir manifeste bağlı");
  if (b.targetRows !== EXPECTED_TOTAL) bp.push(`binding targetRows ${b.targetRows}`);
  if (b.unresolved !== 0) bp.push("binding unresolved != 0");
  if (b.migrationLatest !== "0087" || b.migrationCount !== 87) bp.push("binding ledger 0087/87 değil");
  if (b.backupDestinationSha256 !== actualSha) bp.push("binding başka bir yedeğe bağlı (SHA uyuşmuyor)");
  if (b.restoreSmoke?.restoredFromDestinationSha256 !== actualSha) bp.push("restore smoke başka bir yedekten yapılmış");
  if (b.restoreSmoke?.targetRows !== EXPECTED_TOTAL) bp.push("restore smoke 42 hedef satır görmemiş");
  if (bp.length) fail(`cleanup binding geçersiz:\n  - ${bp.join("\n  - ")}`, 9);
  binding = b;
  receipt.binding = { path: bPath, createdAtUtc: b.createdAtUtc, backupDestinationSha256: b.backupDestinationSha256 };
}

const url = ownerDatabaseUrl();
if (!url) fail("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil");
const urlDbName = databaseNameFromUrl(url);
if (mode === "rehearsal" && !isDisposableDatabaseName(urlDbName)) {
  fail(`--rehearsal yalnız harcanabilir bir veritabanında çalışır; '${urlDbName}' değil`, 9);
}
if (mode === "execute" && urlDbName !== REAL_DB) {
  fail(`--execute-p24b-cleanup-42 yalnız ${REAL_DB} üzerinde çalışır; hedef '${urlDbName}'`, 9);
}
if (binding && binding.database !== urlDbName) fail(`binding '${binding.database}' için, hedef '${urlDbName}'`, 9);

/* ── measurement helpers (all take the locked client) ─────────────────────────────────────── */
async function counts(c: PoolClient, tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await c.query<{ n: string }>(`select count(*)::text n from public.${t}`)).rows[0].n);
  return out;
}
async function moneyTotals(c: PoolClient): Promise<Record<string, string>> {
  const r = await c.query<{ k: string; v: string }>(
    `select 'payments' k, coalesce(sum(default_amount),0)::text v from public.payments
     union all select 'instances', coalesce(sum(amount),0)::text from public.payment_instances
     union all select 'checks', coalesce(sum(amount),0)::text from public.checks
     union all select 'loans', coalesce(sum(principal),0)::text from public.loans
     union all select 'cashflow', coalesce(sum(closing_balance),0)::text from public.cashflow_months`);
  return Object.fromEntries(r.rows.map((x) => [x.k, x.v]));
}
async function wholeDbFingerprint(c: PoolClient): Promise<Record<string, string>> {
  const tabs = (await c.query<{ s: string; t: string }>(
    `select table_schema s, table_name t from information_schema.tables
      where table_type='BASE TABLE' and table_schema in ('public','auth') order by 1,2`)).rows;
  const out: Record<string, string> = {};
  for (const { s, t } of tabs) {
    const r = await c.query<{ n: string; fp: string }>(
      `select count(*)::text n, coalesce(md5(string_agg(x::text,'|' order by x::text)),'EMPTY') fp from "${s}"."${t}" x`);
    out[`${s}.${t}`] = `${r.rows[0].n}:${r.rows[0].fp}`;
  }
  return out;
}
/** Order-independent hash over exactly the 42 target rows. */
async function targetFingerprint(c: PoolClient): Promise<string> {
  const parts: string[] = [];
  for (const r of targets) {
    const idCol = r.table === "settings" ? "key" : "id";
    const cast = r.table === "settings" ? "text" : "uuid";
    const q = await c.query<{ fp: string }>(
      `select md5(x::text) fp from public.${r.table} x where x.${idCol} = $1::${cast}`, [r.id]);
    parts.push(`${r.table}/${r.id}/${q.rows[0]?.fp ?? "MISSING"}`);
  }
  return createHash("sha256").update(parts.sort().join("|")).digest("hex");
}
async function snapshotImage(c: PoolClient): Promise<Map<string, { sem: string; cutoff: string }>> {
  const r = await c.query<{ k: string; sem: string; cutoff: string }>(
    `select metric_key||'|'||dimension_key k,
            coalesce(value_numeric::text,'')||'~'||coalesce(value_text,'')||'~'||unknown_count::text||'~'||confidence sem,
            source_cutoff::text cutoff
       from public.metric_snapshots where snapshot_date = $1::date`, [SNAPSHOT_DATE]);
  return new Map(r.rows.map((x) => [x.k, { sem: x.sem, cutoff: x.cutoff }]));
}
async function auditImage(c: PoolClient): Promise<{ n: number; hashes: Set<string> }> {
  const r = await c.query<{ h: string }>(`select md5(a::text) h from public.audit_logs a`);
  return { n: r.rowCount ?? 0, hashes: new Set(r.rows.map((x) => x.h)) };
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 2 });
  const c = await pool.connect();
  try {
    const dbName = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    receipt.database = dbName;
    console.log(`mod=${mode}  veritabanı=${dbName}  manifest=${manifestSha.slice(0, 12)}…`);
    if (mode === "execute" && dbName !== REAL_DB) fail(`ölçülen veritabanı '${dbName}'`, 9);
    if (mode === "rehearsal" && !isDisposableDatabaseName(dbName)) fail(`ölçülen veritabanı '${dbName}' harcanabilir değil`, 9);

    if (mode === "preflight") {
      // Informational only — explicitly NOT the basis of any commit decision.
      const led = (await c.query<{ v: string; n: string }>("select max(version) v, count(*)::text n from public.schema_migrations")).rows[0];
      const tf = await targetFingerprint(c);
      const missing = targets.filter((r) => tf.includes(`${r.table}/${r.id}/MISSING`));
      receipt.preflight = { ledger: `${led.v}/${led.n}`, targetFingerprint: tf, missingTargets: missing.length, note: "PREFLIGHT ölçümleri kilit DIŞINDA alındı; yalnız bilgilendirmedir." };
      receipt.result = "PREFLIGHT_ONLY — hiçbir mutasyon yapılmadı";
      console.log(`PREFLIGHT: ledger ${led.v}/${led.n}, eksik hedef ${missing.length}. Silme YAPILMADI.`);
      writeReceipt();
      return;
    }

    /* ══ TRANSACTION FIRST, THEN LOCK, THEN EVERY DECIDING MEASUREMENT ══════════════════════ */
    await c.query("begin");
    try {
      await c.query("set local lock_timeout = '10s'");
      await c.query(`lock table ${LOCK_TABLES.map((t) => `public.${t}`).join(", ")} in share row exclusive mode`);
      receipt.lockMode = `SHARE ROW EXCLUSIVE on ${LOCK_TABLES.join(", ")} · lock_timeout=10s · locks taken BEFORE preconditions`;
      console.log(`  kilit alındı (${LOCK_TABLES.length} tablo) — tüm önkoşullar bundan SONRA ölçülüyor`);

      const led = (await c.query<{ v: string; n: string }>("select max(version) v, count(*)::text n from public.schema_migrations")).rows[0];
      if (`${led.v}/${led.n}` !== "0087/87") throw new Error(`ledger ${led.v}/${led.n}, 0087/87 bekleniyordu`);
      receipt.ledger = `${led.v}/${led.n}`;

      const fks = (await c.query<{ child: string; col: string; parent: string; act: string }>(
        `select c.conrelid::regclass::text child, a.attname col, c.confrelid::regclass::text parent,
                case c.confdeltype when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
                     when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end act
           from pg_constraint c
           join unnest(c.conkey) with ordinality k(attnum,ord) on true
           join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
          where c.contype='f' and c.confrelid::regclass::text = any($1::text[]) order by 1,2`, [[...ORDER]])).rows;
      const pi = fks.find((f) => f.child === "payment_instances" && f.col === "payment_id" && f.parent === "payments");
      if (!pi) throw new Error("payment_instances.payment_id -> payments FK'sı yok");
      if (pi.act !== "SET NULL") throw new Error(`payment_instances.payment_id ON DELETE '${pi.act}', SET NULL bekleniyordu`);
      if (fks.some((f) => f.act === "CASCADE")) throw new Error("hedef tablolardan CASCADE eden FK var — kapsam genişler");
      receipt.fkContract = fks;

      // 42/42 existence + per-row fingerprint, measured under the lock.
      const problems: string[] = [];
      for (const r of targets) {
        const idCol = r.table === "settings" ? "key" : "id";
        const cast = r.table === "settings" ? "text" : "uuid";
        const q = await c.query<{ fp: string }>(
          `select md5(x::text) fp from public.${r.table} x where x.${idCol} = $1::${cast}`, [r.id]);
        if (q.rowCount === 0) problems.push(`${r.table}/${r.id} BULUNAMADI`);
        else if (q.rows[0].fp !== r.rowFingerprint) problems.push(`${r.table}/${r.id} parmak izi farklı`);
      }
      if (problems.length) {
        receipt.preconditionProblems = problems.slice(0, 20);
        throw new Error(`PRECONDITION_NOT_SATISFIED — ${problems.length} sorun (ilk: ${problems[0]})`);
      }
      receipt.precondition = "PASS (kilit altında)";

      const lockedTargetFp = await targetFingerprint(c);
      if (binding && binding.preCleanupTargetFingerprint !== lockedTargetFp) {
        throw new Error("BACKUP_IS_STALE_FOR_CURRENT_STATE — yedek alındıktan sonra hedef satırlar değişmiş");
      }
      receipt.targetFingerprint = lockedTargetFp;

      const atillaBefore = (await c.query<{ h: string }>(
        `select md5(u::text) h from public.users u where u.username=$1`, [ATILLA])).rows[0];
      if (!atillaBefore) throw new Error("atilla kullanıcısı bulunamadı");

      const beforeCounts = await counts(c, ORDER);
      const beforeMoney = await moneyTotals(c);
      const beforeFp = await wholeDbFingerprint(c);
      const beforeSnap = await snapshotImage(c);
      const beforeAudit = await auditImage(c);
      receipt.before = { counts: beforeCounts, money: beforeMoney, snapshotRows: beforeSnap.size, auditRows: beforeAudit.n };
      if (beforeSnap.size === 0) throw new Error(`${SNAPSHOT_DATE} için snapshot satırı yok — düzeltme hedefi kayıp`);

      /* ── the 42 deletes ────────────────────────────────────────────────────────────────── */
      const deletes: Array<{ step: number; table: string; expected: number; actual: number }> = [];
      let step = 0;
      for (const t of ORDER) {
        step += 1;
        const ids = targets.filter((r) => r.table === t).map((r) => r.id);
        const sql = t === "settings"
          ? `delete from public.settings where key = any($1::text[])`
          : `delete from public.${t} where id = any($1::uuid[])`;
        const actual = (await c.query(sql, [ids])).rowCount ?? -1;
        deletes.push({ step, table: t, expected: EXPECTED_COUNTS[t], actual });
        console.log(`  ${step}. ${t.padEnd(18)} silinen=${actual} (beklenen ${EXPECTED_COUNTS[t]})`);
        if (actual !== EXPECTED_COUNTS[t]) throw new Error(`${t}: ${actual} silindi, ${EXPECTED_COUNTS[t]} bekleniyordu`);
      }
      receipt.deletes = deletes;

      /* ── derived correction, SAME transaction, product code path ───────────────────────── */
      const { refreshMetricSnapshotsWithClient } = await import("../../src/lib/analytics/snapshots");
      const actor = (await c.query<{ id: string }>(`select id from public.users where username='system' limit 1`)).rows[0];
      if (!actor) throw new Error("system aktörü yok — düzeltme aktörsüz yazılamaz");
      const written = await refreshMetricSnapshotsWithClient(c, actor.id, SNAPSHOT_DATE);
      console.log(`  türev düzeltme: ${written} metrik yeniden hesaplandı (aynı transaction)`);

      const { audit } = await import("../../src/lib/audit");
      await audit(c, {
        actor: actor.id,
        action: "p24b_fixture_cleanup",
        entityTable: "payments",
        entityId: null,
        after: {
          incident: "P0-DRIFT-01",
          manifestSha256: manifestSha,
          directRowsRemoved: EXPECTED_TOTAL,
          tables: EXPECTED_COUNTS,
          semanticMetricCorrections: EXPECTED_SEMANTIC_CHANGES,
          snapshotDate: SNAPSHOT_DATE,
          backupDestinationSha256: binding?.backupDestinationSha256 ?? null,
          mode,
        },
      });
      receipt.correction = { snapshotsWritten: written, auditAction: "p24b_fixture_cleanup" };

      /* ── postconditions, all inside the transaction ────────────────────────────────────── */
      const afterCounts = await counts(c, ORDER);
      for (const t of ORDER) {
        const d = beforeCounts[t] - afterCounts[t];
        if (d !== EXPECTED_COUNTS[t]) throw new Error(`${t} delta ${d}, ${EXPECTED_COUNTS[t]} bekleniyordu`);
      }
      const afterMoney = await moneyTotals(c);
      const moneyDeltas: Record<string, number> = {};
      for (const k of Object.keys(EXPECTED_MONEY_DELTA)) {
        const d = Number(afterMoney[k]) - Number(beforeMoney[k]);
        moneyDeltas[k] = d;
        if (d !== EXPECTED_MONEY_DELTA[k]) throw new Error(`parasal delta ${k}: ${d}, ${EXPECTED_MONEY_DELTA[k]} bekleniyordu`);
      }
      receipt.money = { before: beforeMoney, after: afterMoney, deltas: moneyDeltas };

      const g = (await c.query<{ k: string; v: string }>(
        `select 'fixture_payment' k, count(*)::text v from public.payments where id='7b300bfe-944f-468b-91fa-2de65b7cfee5'
         union all select 'orphan_instances', count(*)::text from public.payment_instances where payment_id is null
         union all select 'p24b_users', count(*)::text from public.users u where u::text ilike '%p24b%'
         union all select 'p24b_action_items', count(*)::text from public.action_items a where a::text ilike '%p24b%'
         union all select 'p24b_settings', count(*)::text from public.settings s where s::text ilike '%p24b%'
         union all select 'atilla', count(*)::text from public.users where username='${ATILLA}'`)).rows;
      const gates = Object.fromEntries(g.map((x) => [x.k, Number(x.v)]));
      receipt.residualGates = gates;
      for (const [k, want] of Object.entries({ fixture_payment: 0, orphan_instances: 0, p24b_users: 0, p24b_action_items: 0, p24b_settings: 0, atilla: 1 })) {
        if (gates[k] !== want) throw new Error(`kapı '${k}': ${gates[k]}, ${want} bekleniyordu`);
      }
      const atillaAfter = (await c.query<{ h: string }>(
        `select md5(u::text) h from public.users u where u.username=$1`, [ATILLA])).rows[0];
      if (!atillaAfter || atillaAfter.h !== atillaBefore.h) throw new Error("atilla satırı değişmiş");

      // Snapshot contract: same row count, exactly 2 semantic moves, the rest technical-only.
      const afterSnap = await snapshotImage(c);
      if (afterSnap.size !== beforeSnap.size) throw new Error(`snapshot satır sayısı ${beforeSnap.size} -> ${afterSnap.size}`);
      let semantic = 0, technicalOnly = 0;
      const semanticList: string[] = [];
      for (const [k, a] of afterSnap) {
        const b = beforeSnap.get(k);
        if (!b) throw new Error(`beklenmedik yeni snapshot satırı: ${k}`);
        if (b.sem !== a.sem) { semantic += 1; semanticList.push(k); }
        else if (b.cutoff !== a.cutoff) technicalOnly += 1;
      }
      receipt.snapshot = { rows: afterSnap.size, semanticChanges: semantic, technicalOnlyChanges: technicalOnly, semanticList };
      if (semantic !== EXPECTED_SEMANTIC_CHANGES) {
        throw new Error(`snapshot semantik değişimi ${semantic}, ${EXPECTED_SEMANTIC_CHANGES} bekleniyordu (${semanticList.join(", ")})`);
      }

      // Audit contract: nothing existing may change; exactly the expected inserts appear.
      const afterAudit = await auditImage(c);
      const lost = [...beforeAudit.hashes].filter((h) => !afterAudit.hashes.has(h));
      if (lost.length) throw new Error(`${lost.length} mevcut audit satırı değişmiş/silinmiş`);
      const inserted = afterAudit.n - beforeAudit.n;
      receipt.audit = { existingUnchanged: lost.length === 0, before: beforeAudit.n, after: afterAudit.n, inserted, expectedInserts: EXPECTED_AUDIT_INSERTS };
      if (inserted !== EXPECTED_AUDIT_INSERTS) throw new Error(`audit INSERT ${inserted}, ${EXPECTED_AUDIT_INSERTS} bekleniyordu`);

      const afterFp = await wholeDbFingerprint(c);
      const changed = Object.keys(beforeFp).filter((t) => beforeFp[t] !== afterFp[t]);
      const illegal = changed.filter((t) => !MUTABLE.has(t.replace(/^public\./, "")));
      receipt.changedTables = changed;
      receipt.illegalChanges = illegal;
      if (illegal.length) throw new Error(`hedef DIŞI tablo değişti: ${illegal.join(", ")}`);

      await c.query("commit");
      receipt.result = "COMMITTED";
      receipt.p24bCleanupComplete = true;
      console.log(`  COMMIT — 42 satır silindi, ${semantic} metrik düzeltildi, ${inserted} audit kaydı eklendi`);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      receipt.result = "ROLLED_BACK";
      receipt.p24bCleanupComplete = false;
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

main().catch((e) => { console.error(e); process.exit(1); });
