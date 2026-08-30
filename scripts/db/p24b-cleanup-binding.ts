// P24B — cleanup binding generator.
//
// An off-device backup receipt proves a file exists somewhere safe. It says nothing about WHICH
// database state that file captures. Between taking a backup and running a cleanup, the database
// can move — a legitimate write, a second incident, or simply the wrong backup being pointed at.
// A cleanup that trusts a receipt alone can therefore destroy 42 rows whose recovery copy does not
// contain them.
//
// This produces the missing link: a `mas-p24b-cleanup-binding-v1` document tying one verified
// backup to the exact pre-cleanup fingerprint of the 42 target rows and of the whole database. The
// cleanup script re-measures that fingerprint UNDER ITS LOCK and refuses to proceed if it has
// moved (BACKUP_IS_STALE_FOR_CURRENT_STATE).
//
// It is generated, never hand-written: every field here is measured, and a binding typed by hand
// would be a claim about the database rather than a measurement of it.
//
// READ-ONLY against the source database — engine-enforced, same three layers as
// quiescence-snapshot.ts. The restore smoke test runs against a separate disposable database.
//
// Usage:
//   MAS_P24B_BACKUP_RECEIPT=<receipt.json> MIGRATION_DATABASE_URL=<source> \
//   node --import tsx scripts/db/p24b-cleanup-binding.ts <out.json> [restore-smoke-db]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool, type PoolClient } from "pg";
import { ownerDatabaseUrl } from "./owner-url";
import { offDeviceCleanupBlockers, sha256OfFile } from "../ops/backup-lib";

const MANIFEST_PATH = path.join(
  "docs", "release-evidence", "final-production-readiness", "p24b-v6", "02-row-evidence-manifest.json",
);
const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const TABLES = ["action_items", "approvals", "payment_instances", "payments", "users", "settings"] as const;

interface ManifestRow { table: string; id: string; classification: string }
interface Manifest { rows: ManifestRow[]; classificationTotals: Record<string, number> }

function die(m: string): never { console.error(`DURDURULDU: ${m}`); process.exit(1); }

async function targetFingerprint(c: PoolClient, targets: ManifestRow[]): Promise<string> {
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
async function wholeDbFingerprint(c: PoolClient): Promise<string> {
  const tabs = (await c.query<{ s: string; t: string }>(
    `select table_schema s, table_name t from information_schema.tables
      where table_type='BASE TABLE' and table_schema in ('public','auth') order by 1,2`)).rows;
  const parts: string[] = [];
  for (const { s, t } of tabs) {
    const r = await c.query<{ n: string; fp: string }>(
      `select count(*)::text n, coalesce(md5(string_agg(x::text,'|' order by x::text)),'EMPTY') fp from "${s}"."${t}" x`);
    parts.push(`${s}.${t}:${r.rows[0].n}:${r.rows[0].fp}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

async function main(): Promise<void> {
  const out = process.argv[2];
  const smokeDb = process.argv[3];
  if (!out) die("kullanım: p24b-cleanup-binding.ts <out.json> [restore-smoke-db]");

  const recPath = process.env.MAS_P24B_BACKUP_RECEIPT;
  if (!recPath || !existsSync(recPath)) die("MAS_P24B_BACKUP_RECEIPT geçerli bir makbuzu göstermeli");
  const raw = JSON.parse(readFileSync(recPath, "utf8")) as {
    destPath: string; destSha256: string; destBytes: number; sourceSha256: string;
  };
  const blockers = offDeviceCleanupBlockers(raw);
  if (blockers.length) die(`makbuz yıkıcı işlem için yetersiz:\n  - ${blockers.join("\n  - ")}`);
  if (!existsSync(raw.destPath)) die(`makbuzun gösterdiği dosya yok: ${raw.destPath}`);
  const destSha = sha256OfFile(raw.destPath);
  const destBytes = statSync(raw.destPath).size;
  if (destSha !== raw.destSha256 || destBytes !== raw.destBytes) die("hedefteki yedek makbuzla uyuşmuyor");

  const manifestRaw = readFileSync(MANIFEST_PATH);
  const manifestSha = createHash("sha256").update(manifestRaw).digest("hex");
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as Manifest;
  const targets = manifest.rows.filter((r) => r.classification === "DELETE_TARGET");

  const url = ownerDatabaseUrl();
  if (!url) die("MIGRATION_DATABASE_URL tanımlı değil");
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  let binding: Record<string, unknown>;
  try {
    await c.query("begin read only");
    const db = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    const led = (await c.query<{ v: string; n: string }>(
      "select max(version) v, count(*)::text n from public.schema_migrations")).rows[0];
    const preCounts: Record<string, number> = {};
    for (const t of TABLES) {
      preCounts[t] = Number((await c.query<{ n: string }>(`select count(*)::text n from public.${t}`)).rows[0].n);
    }
    const targetFp = await targetFingerprint(c, targets);
    const wholeFp = await wholeDbFingerprint(c);
    if (targetFp.includes("MISSING")) die("hedef satırlardan bazıları kaynakta yok");

    /* Restore smoke: prove the backup this binding names can actually be restored and that the
     * restored copy still carries all 42 rows. A backup nobody has restored is a hope. */
    let smoke: Record<string, unknown> = { skipped: true };
    if (smokeDb) {
      execFileSync("docker", ["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", smokeDb], { stdio: "pipe" });
      execFileSync("docker", ["exec", CONTAINER, "createdb", "-U", "postgres", smokeDb], { stdio: "pipe" });
      execFileSync("docker", ["exec", "-i", CONTAINER, "bash", "-c", `cat > /tmp/${smokeDb}.dump`],
        { input: readFileSync(raw.destPath), stdio: ["pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
      execFileSync("docker", ["exec", CONTAINER, "pg_restore", "-U", "postgres", "-d", smokeDb, "--no-owner", `/tmp/${smokeDb}.dump`], { stdio: "pipe" });
      const q = (sql: string): string =>
        execFileSync("docker", ["exec", CONTAINER, "psql", "-U", "postgres", "-d", smokeDb, "-tAc", sql], { encoding: "utf8" }).trim();
      const smokeLedger = q("select max(version)||'/'||count(*) from public.schema_migrations");
      const smokePool = new Pool({ connectionString: url.replace(/\/[^/]+$/, `/${smokeDb}`), max: 1 });
      const sc = await smokePool.connect();
      let smokeTargetFp: string;
      try { smokeTargetFp = await targetFingerprint(sc, targets); } finally { sc.release(); await smokePool.end(); }
      const found = targets.length - (smokeTargetFp.match(/MISSING/g)?.length ?? 0);
      smoke = {
        restoredFromDestinationSha256: destSha, restoreDb: smokeDb, ledger: smokeLedger,
        targetRows: found, fingerprint: smokeTargetFp,
        fingerprintMatchesSource: smokeTargetFp === targetFp,
      };
      if (smokeTargetFp !== targetFp) die("restore smoke: geri yüklenen kopyanın hedef parmak izi kaynakla uyuşmuyor");
    }

    binding = {
      bindingKind: "mas-p24b-cleanup-binding-v1",
      createdAtUtc: new Date().toISOString(),
      database: db,
      manifestSha256: manifestSha,
      targetRows: targets.length,
      unresolved: manifest.classificationTotals.UNRESOLVED ?? 0,
      migrationLatest: led.v,
      migrationCount: Number(led.n),
      backupDestinationSha256: destSha,
      backupDestinationPath: raw.destPath,
      preCleanupTargetFingerprint: targetFp,
      preCleanupWholeDbFingerprint: wholeFp,
      preCleanupCounts: preCounts,
      restoreSmoke: smoke,
    };
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }

  writeFileSync(out, JSON.stringify(binding, null, 2) + "\n", "utf8");
  console.log(`binding yazıldı: ${out}`);
  console.log(`  database=${binding.database} targetRows=${binding.targetRows} ledger=${binding.migrationLatest}/${binding.migrationCount}`);
  console.log(`  backupDestinationSha256=${String(binding.backupDestinationSha256).slice(0, 16)}…`);
  console.log(`  preCleanupTargetFingerprint=${String(binding.preCleanupTargetFingerprint).slice(0, 16)}…`);
}

main().catch((e) => { console.error(e); process.exit(1); });
