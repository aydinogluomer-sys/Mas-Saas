// P24B v2.2 — whole-database state binding, negative control.
//
// WHY TARGET EQUALITY IS NOT ENOUGH. A binding that only pins the 42 target rows says: "the rows
// I am about to delete are unchanged since the backup." That is a weaker promise than it sounds.
// If any OTHER table moved after the backup was taken — a legitimate write, an import, a login
// session — then the backup is no longer a full recovery copy of the state the cleanup is about to
// modify. Restoring it to undo a bad cleanup would also erase whatever happened in between.
//
// So v2.2 binds the whole database as well, and this control proves that binding is enforcement
// rather than decoration. It shows the exact case target-only binding would have let through:
//
//   1. take a backup and generate a binding
//   2. change a NON-target table
//   3. the 42-row target fingerprint is IDENTICAL   ← target-only binding would pass here
//   4. the whole-database fingerprint DIFFERS
//   5. the cleanup refuses, deletes nothing
//
// Writes to a disposable database only, and asserts the cleanup deleted nothing.
//
// Usage: MIGRATION_DATABASE_URL=<disposable> MAS_P24B_BACKUP_RECEIPT=<receipt> \
//        node --import tsx scripts/qa/p24b-wholedb-control.ts <smoke-db> [out.json]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "../db/owner-url";
import { targetFingerprint, wholeDbFingerprintDigest } from "../db/p24b-cleanup-fingerprint";

const MANIFEST = "docs/release-evidence/final-production-readiness/p24b-v6/02-row-evidence-manifest.json";
/** Non-target, data-carrying, and safe to touch on a throwaway copy. */
const NON_TARGET_MUTATION = "update public.sessions set last_seen_at = now() where id = (select id from public.sessions order by id limit 1)";

interface ManifestRow { table: string; id: string; classification: string }

async function fingerprints(url: string): Promise<{ target: string; whole: string }> {
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  try {
    await c.query("begin read only");
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { rows: ManifestRow[] };
    const targets = manifest.rows.filter((r) => r.classification === "DELETE_TARGET");
    const t = await targetFingerprint(c, targets);
    return { target: t.digest, whole: await wholeDbFingerprintDigest(c) };
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
}

async function counts(url: string): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  try {
    const r = await pool.query<{ n: string }>(
      `select (select count(*) from public.users) + (select count(*) from public.action_items)
            + (select count(*) from public.approvals) + (select count(*) from public.payments)
            + (select count(*) from public.payment_instances) + (select count(*) from public.settings) as n`);
    return Number(r.rows[0].n);
  } finally { await pool.end(); }
}

async function main(): Promise<void> {
  const smokeDb = process.argv[2];
  const out = process.argv[3];
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const db = databaseNameFromUrl(url);
  if (!db || !isDisposableDatabaseName(db)) {
    console.error(`GÜVENLİK DURDURMASI: bu kontrol yazma yapar; '${db}' harcanabilir değil.`);
    process.exit(9);
  }
  const receipt = process.env.MAS_P24B_BACKUP_RECEIPT;
  if (!receipt) { console.error("MAS_P24B_BACKUP_RECEIPT gerekli"); process.exit(1); }

  const work = mkdtempSync(path.join(tmpdir(), "p24b-whole-"));
  const bindingPath = path.join(work, "binding.json");
  const result: Record<string, unknown> = { database: db, generatedAtUtc: new Date().toISOString() };

  try {
    // 1 — binding from the pre-mutation state
    execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", bindingPath, smokeDb],
      { env: { ...process.env, MAS_P24B_BACKUP_RECEIPT: receipt, MIGRATION_DATABASE_URL: url }, stdio: "pipe" });
    const before = await fingerprints(url);
    result.beforeMutation = before;

    // 2 — change something that is NOT a target
    execFileSync("docker", ["exec", process.env.MAS_DB_CONTAINER ?? "mas-radar-pg", "psql", "-U", "postgres", "-d", db, "-qc", NON_TARGET_MUTATION], { stdio: "pipe" });
    const after = await fingerprints(url);
    result.afterMutation = after;
    result.mutation = NON_TARGET_MUTATION;

    // 3 & 4 — the whole point: targets identical, database different
    const targetSame = before.target === after.target;
    const wholeDiffers = before.whole !== after.whole;
    result.targetFingerprintUnchanged = targetSame;
    result.wholeDbFingerprintChanged = wholeDiffers;

    // 5 — the cleanup must refuse, and must delete nothing
    const rowsBefore = await counts(url);
    let exitCode = 0; let stderr = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-fixture-cleanup.ts", "--rehearsal"], {
        env: { ...process.env, MAS_P24B_BACKUP_RECEIPT: receipt, MAS_P24B_CLEANUP_BINDING: bindingPath, MIGRATION_DATABASE_URL: url },
        stdio: "pipe", encoding: "utf8",
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      exitCode = err.status ?? -1; stderr = err.stderr ?? "";
    }
    const rowsAfter = await counts(url);
    result.cleanupExitCode = exitCode;
    result.cleanupError = (stderr.split("\n").find((l) => l.includes("GERİ ALINDI") || l.includes("DURDURULDU")) ?? "").slice(0, 160);
    result.targetRowsBefore = rowsBefore;
    result.targetRowsAfter = rowsAfter;
    result.deleteCount = rowsBefore - rowsAfter;

    const pass = targetSame && wholeDiffers && exitCode !== 0
      && rowsBefore === rowsAfter
      && String(result.cleanupError).includes("BACKUP_IS_STALE_FOR_WHOLE_DATABASE_STATE");
    result.verdict = pass ? "PASS" : "FAIL";
    result.reasoning = pass
      ? "Hedef parmak izi AYNI kalırken tüm-DB parmak izi değişti ve cleanup BACKUP_IS_STALE_FOR_WHOLE_DATABASE_STATE ile durdu, sıfır satır silerek. Yalnız hedefe bakan bir binding bu vakayı geçirirdi."
      : "Beklenen zincir gözlenmedi.";

    console.log(`  hedef parmak izi değişmedi : ${targetSame}`);
    console.log(`  tüm-DB parmak izi değişti  : ${wholeDiffers}`);
    console.log(`  cleanup exit                : ${exitCode}  (${result.cleanupError})`);
    console.log(`  silinen satır               : ${rowsBefore - rowsAfter}`);
    console.log(`WHOLE_DB_STALE_NEGATIVE_CONTROL = ${result.verdict}`);
    if (out) { writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8"); console.log(`artifact: ${out}`); }
    if (!pass) process.exit(1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
