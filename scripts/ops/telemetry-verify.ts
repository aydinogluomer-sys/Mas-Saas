// Faz 12 — proof that telemetry-snapshot.ts is wired to reality, not just that its predicates are
// correct in isolation (that is telemetry-alerts.test.ts's job).
//
// This runs the REAL snapshot script as a subprocess against a DISPOSABLE, migrated database and,
// for every signal it can inject cleanly, asserts the alert FIRES on bad state and CLEARS again
// once the state is fixed. A one-directional test ("it alerted") would not catch a predicate stuck
// at true; the clear-after-fix half is what makes this a gate rather than a smoke test.
//
// Honest coverage split, stated so nobody overclaims it:
//   - jobs_stuck, schema_ledger, backup_age  → BOTH directions, injected here.
//   - runtime_user                           → wiring proven (reads the real current_user); the
//                                              mas_radar_app "clear" path needs a logged-in app
//                                              role and is covered by telemetry-alerts.test.ts.
//   - reconciliation, latest_import          → clear/empty path + wiring proven here; their bad
//                                              path needs the full bank_transactions↔cashflow
//                                              chain / a source_workbooks fixture and is covered
//                                              by telemetry-alerts.test.ts.
//
// Usage (target MUST carry a disposable marker; the DB must already be migrated to head):
//   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mas_radar_telemetry_verify \
//     pnpm ops:telemetry:verify
//   (provision first with: MIGRATION_DATABASE_URL=<same> pnpm db:migrate)

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "scripts", "ops", "telemetry-snapshot.ts");
const url = requireDisposableOwnerDatabaseUrl("ops:telemetry:verify");

interface Outcome { name: string; pass: boolean; detail: string }
const results: Outcome[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** Run the real snapshot; it exits 1 on any alert, so capture output from the throw too. */
function runTelemetry(overrides: Record<string, string>): { code: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, MIGRATION_DATABASE_URL: url, ...overrides };
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", SNAPSHOT], {
      cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: err.status ?? 1, out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}` };
  }
}

function signalLine(out: string, name: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(ALERT|\s+ok)\s+(\S+)/);
    if (m && m[2] === name) return line;
  }
  return null;
}
function signalState(out: string, name: string): "ALERT" | "ok" | "missing" {
  const line = signalLine(out, name);
  if (line === null) return "missing";
  return line.startsWith("ALERT") ? "ALERT" : "ok";
}

const pool = new Pool({ connectionString: url, max: 2 });

async function main(): Promise<void> {
  console.log("=== telemetry-verify: disposable-DB integration gate (Faz 12) ===\n");

  // ── precondition: the target is migrated ────────────────────────────────────────────────
  const present = await pool.query<{ jobs: string | null; wb: string | null; mig: string | null }>(
    `select to_regclass('public.background_jobs')::text as jobs,
            to_regclass('public.source_workbooks')::text as wb,
            to_regclass('public.schema_migrations')::text as mig`,
  );
  if (!present.rows[0].jobs || !present.rows[0].wb || !present.rows[0].mig) {
    console.error(
      "Hedef veritabanı migrate edilmemiş (background_jobs/source_workbooks/schema_migrations yok).\n" +
        `Önce çalıştırın: MIGRATION_DATABASE_URL=${databaseNameHint()} pnpm db:migrate`,
    );
    await pool.end();
    process.exit(1);
  }

  const freshBackupDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-fresh-"));
  const emptyBackupDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-empty-"));
  writeFileSync(path.join(freshBackupDir, "recent.dump"), "not a real dump, just a fresh mtime");

  try {
    // ── R0: baseline — fresh backup present, nothing injected, DATABASE_URL absent ──────────
    const base = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: "" });
    record("baseline: jobs_stuck ok (kuyruk temiz)", signalState(base.out, "jobs_stuck") === "ok",
      signalLine(base.out, "jobs_stuck") ?? "satır yok");
    record("baseline: schema_ledger ok (migrate head'de)", signalState(base.out, "schema_ledger") === "ok",
      signalLine(base.out, "schema_ledger") ?? "satır yok");
    record("baseline: backup_age ok (taze dump var)", signalState(base.out, "backup_age_hours") === "ok",
      signalLine(base.out, "backup_age_hours") ?? "satır yok");
    record("baseline: reconciliation ok (banka verisi yok → 0 sapma)",
      signalState(base.out, "reconciliation_mismatch") === "ok",
      signalLine(base.out, "reconciliation_mismatch") ?? "satır yok");
    // fail-closed wiring: no DATABASE_URL → identity unknown → ALERT
    record("baseline: runtime_user ALERT (DATABASE_URL yok → belirsiz kimlik fail-closed)",
      signalState(base.out, "runtime_user") === "ALERT",
      signalLine(base.out, "runtime_user") ?? "satır yok");
    // wiring + column check: empty source_workbooks must read the sentinel 'İÇE AKTARIM YOK', NOT
    // "?". A "?" means the query threw (e.g. a wrong column name) and the age is never computed —
    // the alert would be permanently, uselessly on. Asserting the exact value guards that.
    {
      const line = signalLine(base.out, "latest_import_age_days") ?? "satır yok";
      record("baseline: latest_import ALERT ve değer 'İÇE AKTARIM YOK' (sorgu çalıştı, '?' değil)",
        signalState(base.out, "latest_import_age_days") === "ALERT" && /İÇE AKTARIM YOK/.test(line), line);
    }

    // ── jobs_stuck: fires on a stuck job, clears when removed ────────────────────────────────
    await pool.query(
      `insert into public.background_jobs (job_type, status, started_at, dedupe_key)
       values ('excel_import', 'running', now() - interval '90 minutes', 'telemetry-verify-stuck')`,
    );
    const stuckRun = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: "" });
    record("jobs_stuck: takılı iş enjekte edilince ALERT",
      signalState(stuckRun.out, "jobs_stuck") === "ALERT", signalLine(stuckRun.out, "jobs_stuck") ?? "");
    record("jobs_stuck: takılı iş varken çıkış kodu 1", stuckRun.code === 1, `code=${stuckRun.code}`);
    await pool.query(`delete from public.background_jobs where dedupe_key = 'telemetry-verify-stuck'`);

    // ── schema_ledger: fires on a fake extra row, clears when removed ────────────────────────
    await pool.query(
      `insert into public.schema_migrations (version, name, checksum, applied_by)
       values ('9999', 'telemetry-verify-fake', 'x', 'telemetry-verify')`,
    );
    const ledgerRun = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: "" });
    record("schema_ledger: sahte ledger satırı enjekte edilince ALERT",
      signalState(ledgerRun.out, "schema_ledger") === "ALERT", signalLine(ledgerRun.out, "schema_ledger") ?? "");
    await pool.query(`delete from public.schema_migrations where version = '9999'`);

    // ── backup_age: fires when the backup dir has no dump ───────────────────────────────────
    const noBackupRun = runTelemetry({ MAS_BACKUP_DIR: emptyBackupDir, DATABASE_URL: "" });
    record("backup_age: dump yoksa ALERT (YEDEK YOK)",
      signalState(noBackupRun.out, "backup_age_hours") === "ALERT",
      signalLine(noBackupRun.out, "backup_age_hours") ?? "");

    // ── runtime_user wiring: with an owner DATABASE_URL it reads the real user (postgres) ─────
    const ownerRun = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: url });
    const rtLine = signalLine(ownerRun.out, "runtime_user") ?? "";
    record("runtime_user: gerçek current_user okunuyor (owner → 'postgres') ve ALERT",
      signalState(ownerRun.out, "runtime_user") === "ALERT" && /postgres/.test(rtLine), rtLine);

    // ── latest_import: clears when a recent workbook exists ─────────────────────────────────
    await pool.query(`insert into public.source_workbooks (original_filename) values ('telemetry-verify.xlsx')`);
    const importRun = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: "" });
    record("latest_import: taze içe aktarım varken ok",
      signalState(importRun.out, "latest_import_age_days") === "ok",
      signalLine(importRun.out, "latest_import_age_days") ?? "");
    await pool.query(`delete from public.source_workbooks where original_filename = 'telemetry-verify.xlsx'`);

    // ── clear-after-fix: baseline again → the injected signals are back to ok ────────────────
    const after = runTelemetry({ MAS_BACKUP_DIR: freshBackupDir, DATABASE_URL: "" });
    record("temizlik sonrası: jobs_stuck yeniden ok", signalState(after.out, "jobs_stuck") === "ok",
      signalLine(after.out, "jobs_stuck") ?? "");
    record("temizlik sonrası: schema_ledger yeniden ok", signalState(after.out, "schema_ledger") === "ok",
      signalLine(after.out, "schema_ledger") ?? "");
  } finally {
    rmSync(freshBackupDir, { recursive: true, force: true });
    rmSync(emptyBackupDir, { recursive: true, force: true });
    await pool.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error("TELEMETRY VERIFY FAIL:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("TELEMETRY VERIFY: ALL PASS");
  process.exit(0);
}

/** The database name only, never the URL (it carries a password). */
function databaseNameHint(): string {
  try {
    return `…/${new URL(url).pathname.replace(/^\//, "")}`;
  } catch {
    return "<disposable-db>";
  }
}

main().catch(async (e) => {
  console.error("telemetry-verify beklenmedik hata:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
