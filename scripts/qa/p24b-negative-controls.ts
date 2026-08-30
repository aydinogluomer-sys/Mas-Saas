// P24B — negative-control suite for the hardened cleanup (v2.1).
//
// v2.0 shipped with 12 controls, and all 12 passed against a script whose backup gate was
// `existsSync()`. A control suite that cannot fail the code it guards is decoration. These
// controls attack the gates that were actually missing: receipt CONTENT, receipt-to-file binding,
// backup-to-database-state binding, and the correction contract.
//
// Every control asserts two things, not one:
//   · the run FAILS (expected exit code), and
//   · the database is UNCHANGED afterwards (fingerprint identical).
// A gate that rejects but leaves rows deleted is not a gate.
//
// Runs only against a disposable database. Each data-level control gets a freshly restored copy,
// so one control cannot mask another.
//
// Usage:
//   MIGRATION_DATABASE_URL=<disposable> MAS_P24B_NC_DUMP=/tmp/pre.dump \
//   node --import tsx scripts/qa/p24b-negative-controls.ts [out.json]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "../db/owner-url";

const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const IN_CONTAINER_DUMP = process.env.MAS_P24B_NC_DUMP ?? "/tmp/pre.dump";
const CLEANUP = "scripts/db/p24b-fixture-cleanup.ts";
const SMOKE_DB = process.env.MAS_P24B_NC_SMOKE_DB ?? "mas_radar_p24b_ncsmoke_drill";

interface Result { id: string; name: string; expected: string; exitCode: number; dbUnchanged: boolean; verdict: string; detail: string }
const results: Result[] = [];

function sh(args: string[], input?: Buffer): string {
  return execFileSync("docker", args, { input, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

async function main(): Promise<void> {
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const dbName = databaseNameFromUrl(url);
  if (!dbName || !isDisposableDatabaseName(dbName)) {
    console.error(`GÜVENLİK DURDURMASI: negatif kontroller yazma dener; '${dbName}' harcanabilir değil.`);
    process.exit(9);
  }
  const db: string = dbName;

  const work = mkdtempSync(path.join(tmpdir(), "p24b-nc-"));
  const dumpLocal = path.join(work, "src.dump");
  // `docker cp`, not `docker exec cat`: the dump is a binary custom-format archive and reading it
  // through a utf8-decoded stdout silently corrupts it. The corruption only surfaces later, as a
  // pg_restore failure inside the binding generator's smoke test — a long way from its cause.
  execFileSync("docker", ["cp", `${CONTAINER}:${IN_CONTAINER_DUMP}`, dumpLocal], { stdio: "pipe" });
  const destPath = path.join(work, "backup.dump");
  copyFileSync(dumpLocal, destPath);
  const sha = createHash("sha256").update(readFileSync(destPath)).digest("hex");
  const bytes = readFileSync(destPath).length;

  const goodReceipt = {
    receiptKind: "mas-offdevice-copy-record-v1",
    _DRILL_FIXTURE: "negatif kontrol fixture — gerçek off-device yedek değildir",
    copiedAt: new Date().toISOString(),
    sourcePath: dumpLocal, sourceSha256: sha, sourceBytes: bytes,
    destPath, destSha256: sha, destBytes: bytes,
    sha256VerifiedAtDestination: true, bytesVerifiedAtDestination: true,
    destRestoreListable: true, destTocEntryCount: 1387, sidecarsCopied: [],
    targetKind: "REMOVABLE_VOLUME", offDeviceSatisfied: true,
    targetEvidence: "fixture", durability: { fsyncedFile: true, fsyncedDirectory: true },
  };

  async function fingerprint(): Promise<string> {
    const p = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
    try {
      const r = await p.query<{ n: string }>(
        `select count(*)::text n from (
           select 1 from public.users union all select 1 from public.action_items
           union all select 1 from public.approvals union all select 1 from public.payments
           union all select 1 from public.payment_instances union all select 1 from public.settings
           union all select 1 from public.metric_snapshots union all select 1 from public.audit_logs) z`);
      return r.rows[0].n;
    } finally { await p.end(); }
  }

  function restoreFresh(): void {
    sh(["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-qc",
      `select pg_terminate_backend(pid) from pg_stat_activity where datname='${db}' and pid<>pg_backend_pid()`]);
    sh(["exec", CONTAINER, "dropdb", "-U", "postgres", "--if-exists", db]);
    sh(["exec", CONTAINER, "createdb", "-U", "postgres", db]);
    sh(["exec", CONTAINER, "pg_restore", "-U", "postgres", "-d", db, "--no-owner", IN_CONTAINER_DUMP]);
  }

  let cachedBinding: string | null = null;
  let bindingSeq = 0;

  async function run(id: string, name: string, expected: string, mutate: (rc: Record<string, unknown>, bd: Record<string, unknown>) => void,
                     opts: { freshDb?: boolean; dbMutation?: string; omitReceipt?: boolean; omitBinding?: boolean; rawReceipt?: string } = {}): Promise<void> {
    // Order matters: the baseline binding is generated from the PRE-mutation state, so that the
    // control exercises "backup no longer matches current state" rather than "backup never matched".
    if (opts.freshDb) { restoreFresh(); cachedBinding = null; }
    const before0 = opts.dbMutation ? await fingerprint() : null;
    void before0;

    const rc: Record<string, unknown> = JSON.parse(JSON.stringify(goodReceipt));
    // The baseline binding must be VALID, including its restore smoke — otherwise every control
    // would "pass" because the binding was incomplete rather than because the gate under test
    // fired. Regenerated whenever the database state changed, cached otherwise (the smoke test
    // restores a whole database and is far too slow to repeat 24 times for no reason).
    if (!cachedBinding || opts.freshDb || opts.dbMutation) {
      const bindOut = path.join(work, `baseline-binding-${bindingSeq++}.json`);
      execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", bindOut, SMOKE_DB], {
        env: { ...process.env, MAS_P24B_BACKUP_RECEIPT: path.join(work, "good-receipt.json"), MIGRATION_DATABASE_URL: url },
        stdio: "pipe",
      });
      cachedBinding = readFileSync(bindOut, "utf8");
    }
    const bd: Record<string, unknown> = JSON.parse(cachedBinding);

    const mutSql = opts.dbMutation;
    if (mutSql) sh(["exec", CONTAINER, "psql", "-U", "postgres", "-d", db, "-qc", mutSql]);
    const before = await fingerprint();
    mutate(rc, bd);
    const rcPath = path.join(work, `${id}-receipt.json`);
    const bdPath = path.join(work, `${id}-binding-used.json`);
    if (opts.rawReceipt !== undefined) writeFileSync(rcPath, opts.rawReceipt, "utf8");
    else writeFileSync(rcPath, JSON.stringify(rc, null, 2), "utf8");
    writeFileSync(bdPath, JSON.stringify(bd, null, 2), "utf8");

    const env: NodeJS.ProcessEnv = { ...process.env, MIGRATION_DATABASE_URL: url };
    if (opts.omitReceipt) delete env.MAS_P24B_BACKUP_RECEIPT; else env.MAS_P24B_BACKUP_RECEIPT = String(rcPath);
    if (opts.omitBinding) delete env.MAS_P24B_CLEANUP_BINDING; else env.MAS_P24B_CLEANUP_BINDING = String(bdPath);

    let exitCode = 0; let detail = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", CLEANUP, "--rehearsal"], { env, stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      exitCode = err.status ?? -1;
      detail = (err.stderr ?? "").split("\n").find((l) => l.includes("DURDURULDU") || l.includes("GERİ ALINDI")) ?? "";
    }
    const after = await fingerprint();
    const unchanged = before === after;
    const verdict = exitCode !== 0 && unchanged ? "PASS" : "FAIL";
    results.push({ id, name, expected, exitCode, dbUnchanged: unchanged, verdict, detail: detail.slice(0, 110) });
    console.log(`  ${verdict}  ${id.padEnd(6)} ${name.padEnd(46)} exit=${exitCode} dbUnchanged=${unchanged}`);
  }

  writeFileSync(path.join(work, "good-receipt.json"), JSON.stringify(goodReceipt, null, 2), "utf8");
  restoreFresh();
  console.log(`negatif kontroller — hedef ${dbName}\n`);

  await run("NC01", "makbuz yolu tanımsız", "FAIL", () => {}, { omitReceipt: true, freshDb: true });
  await run("NC02", "boş makbuz dosyası", "FAIL", () => {}, { rawReceipt: "" });
  await run("NC03", "bozuk JSON", "FAIL", () => {}, { rawReceipt: "{ bu json degil" });
  await run("NC04", "yanlış receiptKind", "FAIL", (rc) => { rc.receiptKind = "baska-bir-kayit-v1"; });
  await run("NC05", "targetKind LOCAL_STANDIN", "FAIL", (rc) => { rc.targetKind = "LOCAL_STANDIN"; rc.offDeviceSatisfied = false; });
  await run("NC06", "targetKind OPERATOR_ATTESTED", "FAIL", (rc) => { rc.targetKind = "OPERATOR_ATTESTED"; });
  await run("NC07", "offDeviceSatisfied false", "FAIL", (rc) => { rc.offDeviceSatisfied = false; });
  await run("NC08", "hedef dosya yok", "FAIL", (rc) => { rc.destPath = path.join(work, "olmayan.dump"); });
  await run("NC09", "hedef SHA uyuşmuyor", "FAIL", (rc) => { rc.destSha256 = "0".repeat(64); });
  await run("NC10", "hedef bayt sayısı uyuşmuyor", "FAIL", (rc) => { rc.destBytes = 12345; });
  await run("NC11", "kaynak/hedef SHA farklı", "FAIL", (rc) => { rc.sourceSha256 = "1".repeat(64); });
  await run("NC12", "binding yok", "FAIL", () => {}, { omitBinding: true });
  await run("NC13", "binding yanlış DB'ye bağlı", "FAIL", (_rc, bd) => { bd.database = "baska_db"; });
  await run("NC14", "binding yanlış manifest SHA", "FAIL", (_rc, bd) => { bd.manifestSha256 = "2".repeat(64); });
  await run("NC15", "binding targetRows != 42", "FAIL", (_rc, bd) => { bd.targetRows = 41; });
  await run("NC16", "binding unresolved != 0", "FAIL", (_rc, bd) => { bd.unresolved = 1; });
  await run("NC17", "binding başka yedeğe bağlı", "FAIL", (_rc, bd) => { bd.backupDestinationSha256 = "3".repeat(64); });
  await run("NC18", "restore smoke yanlış yedekten", "FAIL", (_rc, bd) => {
    (bd.restoreSmoke as Record<string, unknown>).restoredFromDestinationSha256 = "4".repeat(64);
  });
  await run("NC19", "restore smoke 42 satır görmemiş", "FAIL", (_rc, bd) => {
    (bd.restoreSmoke as Record<string, unknown>).targetRows = 40;
  });
  await run("NC20", "BACKUP_IS_STALE (hedef satır değişti)", "FAIL", () => {}, {
    freshDb: true, dbMutation: "update public.users set display_name='degisti' where username='p24b_fixture_a'",
  });
  await run("NC21", "hedeflerden biri eksik (41)", "FAIL", () => {}, {
    freshDb: true, dbMutation: "delete from public.payment_instances where id='3ab000e6-5187-468d-bf2e-2af882a2a3a2'",
  });
  await run("NC22", "beklenmedik üçüncü semantik değişim", "FAIL", () => {}, {
    freshDb: true, dbMutation: "update public.metric_snapshots set value_numeric = value_numeric + 999 where snapshot_date='2026-08-27' and metric_key='loan_remaining'",
  });
  await run("NC23", "snapshot hedef tarihi boş", "FAIL", () => {}, {
    freshDb: true, dbMutation: "delete from public.metric_snapshots where snapshot_date='2026-08-27'",
  });

  // NC24: a completed cleanup must not silently succeed a second time.
  restoreFresh();
  const bindOk = path.join(work, "ok-binding.json");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/db/p24b-cleanup-binding.ts", bindOk, SMOKE_DB], {
    env: { ...process.env, MAS_P24B_BACKUP_RECEIPT: path.join(work, "good-receipt.json"), MIGRATION_DATABASE_URL: url }, stdio: "pipe",
  });
  const okEnv = { ...process.env, MIGRATION_DATABASE_URL: url, MAS_P24B_BACKUP_RECEIPT: path.join(work, "good-receipt.json"), MAS_P24B_CLEANUP_BINDING: bindOk };
  execFileSync(process.execPath, ["--import", "tsx", CLEANUP, "--rehearsal"], { env: okEnv, stdio: "pipe" });
  const afterFirst = await fingerprint();
  let secondExit = 0; let secondDetail = "";
  try { execFileSync(process.execPath, ["--import", "tsx", CLEANUP, "--rehearsal"], { env: okEnv, stdio: "pipe", encoding: "utf8" }); }
  catch (e) { const err = e as { status?: number; stderr?: string }; secondExit = err.status ?? -1; secondDetail = (err.stderr ?? "").split("\n").find((l) => l.includes("GERİ ALINDI")) ?? ""; }
  const afterSecond = await fingerprint();
  results.push({
    id: "NC24", name: "ikinci cleanup koşusu (sessiz başarı OLMAMALI)", expected: "FAIL",
    exitCode: secondExit, dbUnchanged: afterFirst === afterSecond,
    verdict: secondExit !== 0 && afterFirst === afterSecond ? "PASS" : "FAIL", detail: secondDetail.slice(0, 110),
  });
  console.log(`  ${results[results.length - 1].verdict}  NC24   ikinci koşu${" ".repeat(36)} exit=${secondExit} dbUnchanged=${afterFirst === afterSecond}`);

  rmSync(work, { recursive: true, force: true });

  const passed = results.filter((r) => r.verdict === "PASS").length;
  console.log(`\nNEGATIVE_CONTROLS = ${passed}/${results.length}`);
  if (process.argv[2]) {
    writeFileSync(process.argv[2], JSON.stringify({ generatedAtUtc: new Date().toISOString(), database: db, total: results.length, passed, results }, null, 2) + "\n", "utf8");
    console.log(`artifact: ${process.argv[2]}`);
  }
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
