// Faz 12 — the operational signals, in one command, with the fail-closed alerts as assertions.
//
// WHY A SCRIPT AND NOT A DASHBOARD.
//
// This is a single-operator, single-machine deployment. Standing up Prometheus to watch one
// Postgres and one Next process would cost more to run than the thing it watches. What the plan
// actually asks for is narrower and more useful: know WHERE each signal lives, and make the six
// dangerous ones FAIL LOUDLY rather than sit unread on a graph.
//
// So the signals are collected here, and the six alerts §15 names are assertions with exit codes.
// A green run means the deployment is in a state someone would recognise as healthy; a red run
// names which signal went bad and what it means.
//
// FAIL-CLOSED, AND THAT IS THE POINT. Every alert below treats "cannot determine" as FAILURE, not
// as "probably fine". An alert that goes quiet when its own data source breaks is worse than no
// alert: it reports health it cannot see.
//
// Usage:
//   MIGRATION_DATABASE_URL=…  [DATABASE_URL=…]  pnpm ops:telemetry
//
// DATABASE_URL is optional and, when present, is used for exactly one check — that the runtime
// really connects as `mas_radar_app`. Without it that check reports NOT DETERMINED (which counts
// as a failure, per the paragraph above).

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { requireOwnerDatabaseUrl } from "../db/owner-url";
import {
  backupAgeAlert,
  importStaleAlert,
  jobsStuckAlert,
  ledgerAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";

/** Thresholds. Deliberately conservative: an alert that never fires teaches people to ignore it. */
const BACKUP_MAX_AGE_HOURS = 36;      // günlük yedek + kaçırılan bir gün payı
const JOB_STUCK_MINUTES = 30;         // reaper 30 dakikada bir süpürüyor
const IMPORT_STALE_DAYS = 45;         // aylık çalışma dosyası ritmi + pay

// Where backups live. Configurable via MAS_BACKUP_DIR so the alert can point at the real backup
// target on the deployment machine — and so the verify can point it at a controlled temp directory
// to prove the alert both fires (no dump) and clears (a fresh dump). Defaults to ./backups.
const BACKUP_DIR = process.env.MAS_BACKUP_DIR ?? path.join(process.cwd(), "backups");

interface Signal { name: string; value: string; alert: boolean; note: string }
const signals: Signal[] = [];

function record(name: string, value: string, alert: boolean, note: string): void {
  signals.push({ name, value, alert, note });
  console.log(`${alert ? "ALERT" : "  ok "}  ${name.padEnd(34)} ${value}${note ? `  — ${note}` : ""}`);
}

const pool = new Pool({ connectionString: requireOwnerDatabaseUrl() });

async function one<T>(sql: string, fallback: T): Promise<T> {
  try {
    const res = await pool.query(sql);
    return (res.rows[0] ? (Object.values(res.rows[0])[0] as T) : fallback);
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  console.log("── RUNTIME ────────────────────────────────────────────────────────────");

  // Commit SHA is exposed by /version at runtime; here it is read from the environment the app
  // would have been built with, so a snapshot taken from the shell still identifies the build.
  record("commit_sha", process.env.APP_COMMIT_SHA ?? "(APP_COMMIT_SHA yok)",
    false, "canlıda /version");
  record("probe_liveness", "/ready", false, "her zaman 200 — süreç ayakta mı");
  record("probe_dependency", "/health", false, "DB kopuksa 503 — trafik gönderilsin mi");

  console.log("\n── VERİTABANI ─────────────────────────────────────────────────────────");

  const conns = await one<string>(`select count(*)::text from pg_stat_activity where datname = current_database()`, "?");
  record("db_connections", conns, false, "");

  const dbSize = await one<string>(`select pg_size_pretty(pg_database_size(current_database()))`, "?");
  record("db_size", dbSize, false, "");

  const lockWaits = await one<string>(`select count(*)::text from pg_locks where not granted`, "?");
  record("db_lock_waits", lockWaits, Number(lockWaits) > 0, Number(lockWaits) > 0 ? "bekleyen kilit var" : "");

  const rolledBack = await one<string>(
    `select coalesce(xact_rollback,0)::text from pg_stat_database where datname = current_database()`, "?");
  record("db_failed_transactions", rolledBack, false, "kümülatif; ani artış incelenir");

  /* ── ALERT 1 — backup age ─────────────────────────────────────────────────────────────── */
  let backupAgeHours = Number.POSITIVE_INFINITY;
  let newest = "(yok)";
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump"));
    for (const f of files) {
      const ageH = (Date.now() - statSync(path.join(BACKUP_DIR, f)).mtimeMs) / 3_600_000;
      if (ageH < backupAgeHours) { backupAgeHours = ageH; newest = f; }
    }
  } catch { /* dizin yok — sonsuz yaş, alert */ }
  record("backup_age_hours",
    Number.isFinite(backupAgeHours) ? backupAgeHours.toFixed(1) : "YEDEK YOK",
    backupAgeAlert(backupAgeHours, BACKUP_MAX_AGE_HOURS),
    `eşik ${BACKUP_MAX_AGE_HOURS}s · en yeni: ${newest}`);

  console.log("\n── UYGULAMA ───────────────────────────────────────────────────────────");

  /* ── ALERT 2 — background queue stuck ─────────────────────────────────────────────────── */
  const stuck = await one<string>(
    `select count(*)::text from public.background_jobs
      where status = 'running' and started_at < now() - interval '${JOB_STUCK_MINUTES} minutes'`, "?");
  const deadLettered = await one<string>(
    `select count(*)::text from public.background_jobs where dead_lettered_at is not null`, "?");
  record("jobs_stuck", stuck, jobsStuckAlert(stuck), `> ${JOB_STUCK_MINUTES} dk 'running'`);
  record("jobs_dead_lettered", deadLettered, false, "bilgi — elle replay gerekir");

  /* ── ALERT 3 — latest import stale ────────────────────────────────────────────────────── */
  // Column is imported_at, not created_at — source_workbooks records WHEN a workbook was imported,
  // and it has no created_at. With the wrong name the query threw every run, the signal read "?"
  // and the alert fired even on a perfectly fresh import: fail-closed, but useless. Caught by the
  // integration verify, which now asserts the empty-table sentinel exactly so a column rename here
  // cannot silently regress it again.
  const importAgeDays = await one<string>(
    `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK')
       from public.source_workbooks`, "?");
  record("latest_import_age_days", importAgeDays,
    importStaleAlert(importAgeDays, IMPORT_STALE_DAYS),
    `eşik ${IMPORT_STALE_DAYS} gün`);

  /* ── ALERT 4 — reconciliation mismatch ────────────────────────────────────────────────── */
  const reconMismatch = await one<string>(
    `select count(*)::text from public.treasury_cashflow_reconciliation where coalesce(difference, 0) <> 0`, "?");
  record("reconciliation_mismatch", reconMismatch,
    reconciliationAlert(reconMismatch), "sıfırdan farklı satır sayısı");

  /* ── ALERT 5 — runtime identity ───────────────────────────────────────────────────────── */
  //
  // The one check that needs the RUNTIME connection rather than the owner one. Without
  // DATABASE_URL it reports NOT DETERMINED, and not-determined counts as an alert — this is
  // precisely the signal that was silently wrong on the real machine (P0-2: DATABASE_URL still
  // pointed at `postgres`, so every RLS policy written since Faz 15 was inert).
  let runtimeUser = "(DATABASE_URL verilmedi)";
  if (process.env.DATABASE_URL) {
    const rt = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      runtimeUser = (await rt.query<{ u: string }>(`select current_user u`)).rows[0].u;
    } catch (e) {
      runtimeUser = `BAĞLANAMADI: ${(e as Error).message.slice(0, 60)}`;
    } finally {
      await rt.end().catch(() => {});
    }
  }
  record("runtime_user", runtimeUser, runtimeIdentityAlert(runtimeUser), "mas_radar_app olmalı — değilse RLS baypas");

  /* ── ALERT 6 — schema ledger ──────────────────────────────────────────────────────────── */
  const ledger = await one<string>(
    `select count(*)::text || '/' || coalesce(max(version), 'yok') from public.schema_migrations`, "?");
  const expected = (() => {
    try {
      const files = readdirSync(path.join(process.cwd(), "supabase", "migrations"))
        .filter((f) => f.endsWith(".sql")).sort();
      return `${files.length}/${files[files.length - 1].slice(0, 4)}`;
    } catch { return "?"; }
  })();
  record("schema_ledger", ledger, ledgerAlert(ledger, expected), `beklenen ${expected}`);

  const auditFailures = await one<string>(
    `select count(*)::text from public.audit_logs
      where action ilike '%login%fail%' and created_at > now() - interval '24 hours'`, "0");
  record("auth_failures_24h", auditFailures, false, "bilgi — ani artış incelenir");

  const alerts = signals.filter((s) => s.alert);
  console.log(`\n${signals.length - alerts.length}/${signals.length} sinyal normal.`);
  if (alerts.length > 0) {
    console.log("UYARI VEREN SİNYALLER:");
    for (const a of alerts) console.log(`  - ${a.name} = ${a.value}  (${a.note})`);
  }
  console.log(alerts.length === 0 ? "TELEMETRY: ALL CLEAR" : "TELEMETRY: ALERT");
  await pool.end();
  process.exit(alerts.length === 0 ? 0 : 1);
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => {});
  process.exit(1);
});
