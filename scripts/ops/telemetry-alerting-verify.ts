// AŞAMA 09 — alarm TESLİMATININ ve ZAMANLAMASININ kapısı.
//
// scripts/ops/telemetry-verify.ts "uyarı ateşliyor mu / temizleniyor mu" sorusunu cevaplıyor.
// Bu kapı bir sonraki soruyu cevaplıyor ve rehber §14 kabul kriteri tam olarak odur:
//
//     "Sağlıklı durumda alarm yok."
//     "Her yüksek risk sinyal kontrollü enjekte edildiğinde alarm görülüyor."
//     "Alarm delivery başarısızlığı ayrıca görünür."
//     "Alert çıktısında secret yok."
//
// GERÇEK SNAPSHOT ALT SÜREÇ OLARAK KOŞAR. Hiçbir şey taklit edilmiyor: uyarılar gerçekten
// enjekte ediliyor, gerçek `telemetry-snapshot.ts` çalışıyor, kalıcı alert log'u diskten geri
// OKUNUYOR ve satırları sayılıyor. Rehber §30.1: yalnız yeşile dönebilen bir kapı hiçbir şey
// kanıtlamaz — bu yüzden her enjeksiyonun ardından TEMİZLENDİĞİ de ayrıca doğrulanıyor.
//
// TESLİMAT BAŞARISIZLIĞI DA GERÇEK. Üç ayrı yoldan kırılıyor ve üçünde de AYRI çıkış kodu (2)
// bekleniyor: (a) yerel log yazılamaz, (b) MAS_ALERT_CHANNELS'ta bilinmeyen kanal, (c) kimlik
// bilgisi olmayan gerçek Telegram kanalı. Hiçbiri dışarıya tek bir istek atmaz — (c)'de
// taşıyıcı token yokluğunu görüp ağa ÇIKMADAN dürüst bir başarısızlık döndürür.
//
// VERİ SINIFI: hedef DISPOSABLE_SYNTHETIC olmak ZORUNDA (requireDisposableOwnerDatabaseUrl).
// Bu script INSERT/DELETE yapar; `mas_radar_dev`'e asla dokunmaz.
//
// Kullanım (hedef migrate edilmiş harcanabilir bir DB olmalı):
//   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mas_radar_telemetry_verify \
//     pnpm ops:telemetry:alerting:verify

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl, databaseNameFromUrl } from "../db/owner-url";
import { mockTransport } from "@/lib/reminders/transport";
import { deliverAlerts, looksLikeSecret, type AlertLogEntry, type TelemetryAlert } from "@/lib/ops/alert-delivery";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "scripts", "ops", "telemetry-snapshot.ts");
const SCHEDULER = path.join(ROOT, "scripts", "ops", "schedule-windows.ts");
const url = requireDisposableOwnerDatabaseUrl("ops:telemetry:alerting:verify");
const DB_NAME = databaseNameFromUrl(url) ?? "(bilinmiyor)";

interface Outcome { name: string; pass: boolean; detail: string }
const results: Outcome[] = [];
const skipped: string[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function skip(name: string, why: string): void {
  skipped.push(`${name} — ${why}`);
  console.log(`SKIP  ${name}  (${why})`);
}

/* ── mas_radar_app kimliği ────────────────────────────────────────────────────────────────
 *
 * `runtime_user` sinyalinin TEMİZ yönünü kanıtlamak için gerçekten `mas_radar_app` olarak
 * bağlanmak gerekir. Rol küme kapsamlıdır, veritabanı değil — bu yüzden kimlik bilgisi
 * .env.local'den okunup HEDEF VERİTABANI HARCANABİLİR OLANLA DEĞİŞTİRİLİR. Gerçek
 * `mas_radar_dev`'e tek bir bağlantı bile açılmaz.
 *
 * .env.local process.env'e SIZDIRILMAZ (backup-daily.ts deseni) ve URL hiçbir yerde BASILMAZ.
 * Kimlik bilgisi yoksa (CI'da yok) kontrol ATLANIR ve atlandığı raporlanır — sessizce
 * "geçti" sayılmaz.
 */
async function appRoleUrl(): Promise<string | null> {
  const explicit = process.env.MAS_APP_DATABASE_URL;
  const fromEnvLocal = (): string | undefined => {
    const file = path.join(ROOT, ".env.local");
    if (!existsSync(file)) return undefined;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0 || line.slice(0, i).trim() !== "DATABASE_URL") continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
    return undefined;
  };
  const candidate = explicit || fromEnvLocal();
  if (!candidate) return null;
  let candidateUrl: string;
  try {
    const u = new URL(candidate);
    if (u.username !== "mas_radar_app") return null;
    // HEDEFİ ZORLA harcanabilir veritabanına çevir; gerçek DB adı asla kalmasın.
    u.pathname = `/${DB_NAME}`;
    candidateUrl = u.toString();
  } catch {
    return null;
  }
  // Kimlik bilgisi VAR demek, çalışıyor demek DEĞİL: rolün parolası bu kümede hiç ayarlanmamış
  // olabilir (CI'daki durum) ya da hedefte CONNECT yetkisi olmayabilir. Önce GERÇEKTEN bağlanıp
  // `current_user`'ın mas_radar_app olduğunu görüyoruz; olmuyorsa kapı kırmızıya dönmez, ilgili
  // kontroller ATLANIR ve atlandıkları raporlanır.
  const probePool = new Pool({ connectionString: candidateUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const who = await probePool.query<{ u: string }>("select current_user u");
    return who.rows[0]?.u === "mas_radar_app" ? candidateUrl : null;
  } catch {
    return null;
  } finally {
    await probePool.end().catch(() => {});
  }
}

/* ── snapshot koşturucu ───────────────────────────────────────────────────────────────── */

interface SnapshotRun {
  code: number;
  out: string;
  log: AlertLogEntry[];
  json: {
    alertCount: number;
    verdict: string;
    signals: Array<{ name: string; alert: boolean; severity: string | null }>;
    delivery: { allDelivered: boolean; outcomes: Array<{ channel: string; ok: boolean; attempted: boolean }> };
    notObtainable: Array<{ signal: string }>;
  } | null;
  logRaw: string;
  logPath: string;
}

/** Her senaryonun stdout'u ve alert log'u — sonunda topluca sır taraması yapılır. */
const transcript: string[] = [];

let scenarioSeq = 0;
let workDir = "";

function runSnapshot(scenario: string, overrides: Record<string, string>): SnapshotRun {
  scenarioSeq += 1;
  const logPath = path.join(workDir, `${String(scenarioSeq).padStart(2, "0")}-${scenario}.jsonl`);
  const jsonPath = path.join(workDir, `${String(scenarioSeq).padStart(2, "0")}-${scenario}.json`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIGRATION_DATABASE_URL: url,
    MAS_ALERT_LOG: logPath,
    MAS_TELEMETRY_RUN_ID: `verify-${scenario}`,
    DATABASE_URL: "",
    MAS_ALERT_CHANNELS: "",
    MAS_APP_BASE_URL: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    ...overrides,
  };
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", SNAPSHOT, "--json", jsonPath], {
      cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    code = err.status ?? 1;
    out = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
  }
  const logRaw = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const log = logRaw.trim() === "" ? [] : logRaw.trim().split("\n").map((l) => JSON.parse(l) as AlertLogEntry);
  const json = existsSync(jsonPath) ? (JSON.parse(readFileSync(jsonPath, "utf8")) as SnapshotRun["json"]) : null;
  transcript.push(out, logRaw);
  return { code, out, log, json, logRaw, logPath };
}

function signalState(out: string, name: string): "ALERT" | "ok" | "missing" {
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(ALERT|\s+ok)\s+(\S+)/);
    if (m && m[2] === name) return line.startsWith("ALERT") ? "ALERT" : "ok";
  }
  return "missing";
}
function alertRows(run: SnapshotRun): AlertLogEntry[] {
  return run.log.filter((r) => r.kind === "alert");
}
function alertRow(run: SnapshotRun, signal: string): AlertLogEntry | undefined {
  return alertRows(run).find((r) => r.signal === signal);
}

const pool = new Pool({ connectionString: url, max: 2 });

/** Enjeksiyon izleri — hepsi bu sabitlerle etiketlenir ve finally'de silinir. */
const TAG = "telemetry-alerting-verify";

async function cleanup(): Promise<void> {
  await pool.query(`delete from public.background_jobs where dedupe_key = '${TAG}'`).catch(() => {});
  await pool.query(`delete from public.schema_migrations where version = '9998'`).catch(() => {});
  await pool.query(`delete from public.source_workbooks where original_filename like '${TAG}%'`).catch(() => {});
  await pool.query(`delete from public.bank_transactions where dedupe_hash = '${TAG}'`).catch(() => {});
  await pool.query(`delete from public.bank_accounts where cash_account_id in
    (select id from public.cash_accounts where name = '${TAG}')`).catch(() => {});
  await pool.query(`delete from public.cash_accounts where name = '${TAG}'`).catch(() => {});
  await pool.query(`delete from public.cashflow_months where notes = '${TAG}'`).catch(() => {});
}

async function main(): Promise<void> {
  console.log("=== telemetry-alerting-verify: alarm teslimatı + zamanlama kapısı (AŞAMA 09) ===");
  console.log(`Hedef veritabanı : ${DB_NAME} (DISPOSABLE_SYNTHETIC)\n`);

  const present = await pool.query<{ jobs: string | null; wb: string | null; mig: string | null }>(
    `select to_regclass('public.background_jobs')::text as jobs,
            to_regclass('public.source_workbooks')::text as wb,
            to_regclass('public.schema_migrations')::text as mig`,
  );
  if (!present.rows[0].jobs || !present.rows[0].wb || !present.rows[0].mig) {
    console.error(`Hedef veritabanı ('${DB_NAME}') migrate edilmemiş. Önce: pnpm db:migrate`);
    await pool.end();
    process.exit(1);
  }

  workDir = mkdtempSync(path.join(os.tmpdir(), "mas-alerting-"));
  const freshBackupDir = path.join(workDir, "backups-fresh");
  const emptyBackupDir = path.join(workDir, "backups-empty");
  mkdirSync(freshBackupDir, { recursive: true });
  mkdirSync(emptyBackupDir, { recursive: true });
  writeFileSync(path.join(freshBackupDir, "recent.dump"), "taze mtime — gerçek dump değil");

  const appUrl = await appRoleUrl();
  const healthyEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    MAS_BACKUP_DIR: freshBackupDir,
    ...(appUrl ? { DATABASE_URL: appUrl } : {}),
    ...extra,
  });

  await cleanup();
  try {
    /* ════ ÖN KOŞUL — sağlıklı taban durumu kurulur ═══════════════════════════════════════
     * Boş bir veritabanı SAĞLIKLI DEĞİLDİR: hiç içe aktarım yoksa `latest_import` fail-closed
     * ateşler (ve doğrusu budur). "Sağlıklı durumda alarm yok" kriterini ölçebilmek için taze
     * bir içe aktarım kaydı gerekiyor. */
    await pool.query(`insert into public.source_workbooks (original_filename) values ('${TAG}-fresh.xlsx')`);

    /* ════ S0 — SAĞLIKLI: alarm YOK ═══════════════════════════════════════════════════════ */
    const healthy = runSnapshot("healthy", healthyEnv());
    if (appUrl) {
      record("S0 sağlıklı: hiç uyarı yok (exit 0, ALL CLEAR)",
        healthy.code === 0 && /TELEMETRY: ALL CLEAR/.test(healthy.out) && healthy.json?.alertCount === 0,
        `exit=${healthy.code} alertCount=${healthy.json?.alertCount ?? "?"}`);
      record("S0 sağlıklı: runtime_user gerçekten 'mas_radar_app' okundu (temiz yön kanıtlandı)",
        signalState(healthy.out, "runtime_user") === "ok",
        healthy.out.split(/\r?\n/).find((l) => l.includes("runtime_user"))?.trim() ?? "satır yok");
    } else {
      skip("S0 sağlıklı: hiç uyarı yok",
        "mas_radar_app kimlik bilgisi yok (.env.local/MAS_APP_DATABASE_URL) — runtime_user fail-closed ateşler; bu ortamda 'alarm yok' ÖLÇÜLEMEZ");
      record("S0 (kısıtlı): runtime_user DIŞINDA uyaran sinyal yok",
        healthy.json !== null && healthy.json.signals.filter((s) => s.alert).every((s) => s.name === "runtime_user"),
        `uyaranlar=${healthy.json?.signals.filter((s) => s.alert).map((s) => s.name).join(",") || "yok"}`);
    }
    record(appUrl
      ? "S0 sağlıklı: alert log'a ALERT satırı YAZILMADI"
      : "S0 (kısıtlı): alert log'da yalnız runtime_user satırı var (ortam kısıtı)",
      alertRows(healthy).length === (appUrl ? 0 : 1),
      `alert satırı=${alertRows(healthy).length}`);
    record("S0 sağlıklı: heartbeat + teslimat satırı YAZILDI (sessiz log ≠ sağlıklı)",
      healthy.log.some((r) => r.kind === "delivery" && r.channel === "log" && r.ok === true)
        && (appUrl ? healthy.log.some((r) => r.kind === "heartbeat") : true),
      `satır=${healthy.log.map((r) => r.kind).join(",")}`);
    record("S0 sağlıklı: yapısal JSON çıktısı üretildi ve ölçülemeyenleri listeliyor",
      healthy.json !== null && healthy.json.notObtainable.length >= 4,
      `notObtainable=${healthy.json?.notObtainable.map((n) => n.signal).join(" · ") ?? "yok"}`);

    /* ════ S1..S6 — altı fail-closed sinyal: ENJEKTE → ALARM + TESLİMAT → TEMİZLE ═══════ */

    let deliveredSignals = 0;
    const provenSignals: string[] = [];

    /** Tek bir sinyalin üç yönünü de kanıtlar: stdout'ta ALERT, log'da doğru severity'li satır,
     *  ve teslimatın gerçekten "iletildi" demesi. */
    function assertAlarmDelivered(run: SnapshotRun, signal: string, severity: string, label: string): void {
      const row = alertRow(run, signal);
      const ok = signalState(run.out, signal) === "ALERT"
        && row !== undefined
        && row.severity === severity
        && run.log.some((r) => r.kind === "delivery" && r.channel === "log" && r.ok === true)
        && run.code === 1;
      record(`${label}: enjekte → ALARM + kalıcı log'a TESLİM (severity ${severity}, exit 1)`, ok,
        `stdout=${signalState(run.out, signal)} logRow=${row ? `${row.severity}` : "YOK"} exit=${run.code}`);
      if (ok) { deliveredSignals += 1; provenSignals.push(signal); }
    }

    // ── S1 backup age high ────────────────────────────────────────────────────────────────
    const s1 = runSnapshot("backup-age", healthyEnv({ MAS_BACKUP_DIR: emptyBackupDir }));
    assertAlarmDelivered(s1, "backup_age_hours", "P1", "S1 backup age high");
    const s1clear = runSnapshot("backup-age-clear", healthyEnv());
    record("S1 backup age: taze dump geri konunca TEMİZLENDİ",
      signalState(s1clear.out, "backup_age_hours") === "ok" && alertRow(s1clear, "backup_age_hours") === undefined,
      signalState(s1clear.out, "backup_age_hours"));

    // ── S2 queue stuck ────────────────────────────────────────────────────────────────────
    await pool.query(
      `insert into public.background_jobs (job_type, status, started_at, dedupe_key)
       values ('excel_import', 'running', now() - interval '90 minutes', '${TAG}')`,
    );
    const s2 = runSnapshot("jobs-stuck", healthyEnv());
    assertAlarmDelivered(s2, "jobs_stuck", "P1", "S2 queue stuck");
    await pool.query(`delete from public.background_jobs where dedupe_key = '${TAG}'`);
    const s2clear = runSnapshot("jobs-stuck-clear", healthyEnv());
    record("S2 queue stuck: iş silinince TEMİZLENDİ",
      signalState(s2clear.out, "jobs_stuck") === "ok" && alertRow(s2clear, "jobs_stuck") === undefined,
      signalState(s2clear.out, "jobs_stuck"));

    // ── S3 latest import stale ────────────────────────────────────────────────────────────
    await pool.query(
      `update public.source_workbooks set imported_at = now() - interval '400 days'
        where original_filename = '${TAG}-fresh.xlsx'`,
    );
    const s3 = runSnapshot("import-stale", healthyEnv());
    assertAlarmDelivered(s3, "latest_import_age_days", "P2", "S3 latest import stale");
    await pool.query(
      `update public.source_workbooks set imported_at = now() where original_filename = '${TAG}-fresh.xlsx'`,
    );
    const s3clear = runSnapshot("import-stale-clear", healthyEnv());
    record("S3 latest import: taze içe aktarımda TEMİZLENDİ",
      signalState(s3clear.out, "latest_import_age_days") === "ok",
      signalState(s3clear.out, "latest_import_age_days"));

    // ── S4 reconciliation != 0 ────────────────────────────────────────────────────────────
    //
    // treasury_cashflow_reconciliation bir GÖRÜNÜM: sapma uydurulamaz, zincirin tamamı
    // (cash_accounts → bank_accounts → bank_transactions ↔ cashflow_months) kurulmak zorunda.
    // Enjekte edilen değerler bilinçli olarak çelişkili: banka hareketi 12.345,67 ↔ nakit akış
    // kapanışı 1,00 → difference = 12.344,67 ≠ 0.
    await pool.query(`
      with acc as (
        insert into public.cash_accounts (name, account_type, currency)
        values ('${TAG}', 'bank_account', 'TRY') returning id
      ), ba as (
        insert into public.bank_accounts (cash_account_id, bank_name)
        select id, '${TAG}' from acc returning cash_account_id
      )
      insert into public.bank_transactions
        (bank_account_id, txn_date, description, amount, currency, status, dedupe_hash)
      select cash_account_id, date_trunc('month', now())::date, '${TAG}', 12345.67, 'TRY', 'unmatched', '${TAG}'
      from ba`);
    await pool.query(
      `insert into public.cashflow_months (month_start, closing_balance, confidence, status, notes)
       values (date_trunc('month', now())::date, 1.00, 'source_imported', 'draft', '${TAG}')`,
    );
    const s4 = runSnapshot("reconciliation", healthyEnv());
    assertAlarmDelivered(s4, "reconciliation_mismatch", "P0", "S4 reconciliation != 0");
    await pool.query(`delete from public.cashflow_months where notes = '${TAG}'`);
    await pool.query(`delete from public.bank_transactions where dedupe_hash = '${TAG}'`);
    await pool.query(`delete from public.bank_accounts where cash_account_id in
      (select id from public.cash_accounts where name = '${TAG}')`);
    await pool.query(`delete from public.cash_accounts where name = '${TAG}'`);
    const s4clear = runSnapshot("reconciliation-clear", healthyEnv());
    record("S4 reconciliation: zincir sökülünce TEMİZLENDİ",
      signalState(s4clear.out, "reconciliation_mismatch") === "ok",
      signalState(s4clear.out, "reconciliation_mismatch"));

    // ── S5 runtime user != mas_radar_app ──────────────────────────────────────────────────
    const s5 = runSnapshot("runtime-user", healthyEnv({ DATABASE_URL: url }));
    assertAlarmDelivered(s5, "runtime_user", "P0", "S5 runtime user != mas_radar_app");
    record("S5 runtime user: enjekte edilen kimlik GERÇEKTEN okundu ('postgres')",
      /runtime_user\s+postgres/.test(s5.out),
      s5.out.split(/\r?\n/).find((l) => l.includes("runtime_user"))?.trim() ?? "satır yok");
    if (appUrl) {
      const s5clear = runSnapshot("runtime-user-clear", healthyEnv());
      record("S5 runtime user: mas_radar_app ile bağlanınca TEMİZLENDİ",
        signalState(s5clear.out, "runtime_user") === "ok", signalState(s5clear.out, "runtime_user"));
    } else {
      skip("S5 runtime user: temiz yön", "mas_radar_app kimlik bilgisi bu ortamda yok");
    }

    // ── S6 ledger != beklenen ─────────────────────────────────────────────────────────────
    await pool.query(
      `insert into public.schema_migrations (version, name, checksum, applied_by)
       values ('9998', '${TAG}-fake', 'x', '${TAG}')`,
    );
    const s6 = runSnapshot("ledger", healthyEnv());
    assertAlarmDelivered(s6, "schema_ledger", "P0", "S6 ledger != beklenen");
    await pool.query(`delete from public.schema_migrations where version = '9998'`);
    const s6clear = runSnapshot("ledger-clear", healthyEnv());
    record("S6 ledger: sahte satır silinince TEMİZLENDİ",
      signalState(s6clear.out, "schema_ledger") === "ok", signalState(s6clear.out, "schema_ledger"));

    record("Rehber §14'ün ALTI fail-closed sinyalinin TAMAMI alarm verdi VE teslim edildi",
      deliveredSignals === 6, `${deliveredSignals}/6 — ${provenSignals.join(", ")}`);

    /* ════ S7..S10 — TESLİMAT BAŞARISIZLIĞI AYRICA GÖRÜNÜR ═══════════════════════════════ */

    // ── S7: yerel log yazılamıyor (birincil kanal kırık) ──────────────────────────────────
    const blocker = path.join(workDir, "blocker-file");
    writeFileSync(blocker, "bu bir dosya, dizin değil");
    const s7 = runSnapshot("delivery-log-broken", healthyEnv({
      MAS_BACKUP_DIR: emptyBackupDir,                       // en az bir uyarı olsun
      MAS_ALERT_LOG: path.join(blocker, "alt", "alerts.jsonl"),
    }));
    record("S7 teslimat: yerel log yazılamazsa exit 2 ve 'TELEMETRY DELIVERY: FAILED'",
      s7.code === 2 && /TELEMETRY DELIVERY: FAILED/.test(s7.out) && /İLETİLEMEDİ/.test(s7.out),
      `exit=${s7.code}`);
    record("S7 teslimat: çıkış kodu 'uyarı var'dan (1) AYRIŞIYOR — kırık boru ayrı bir arıza",
      s7.code === 2 && s1.code === 1, `log-kırık=${s7.code} uyarı=${s1.code}`);

    // ── S8: bilinmeyen kanal jetonu (sessizce kapanmış teslimat) ──────────────────────────
    const s8 = runSnapshot("delivery-unknown-channel", healthyEnv({
      MAS_BACKUP_DIR: emptyBackupDir, MAS_ALERT_CHANNELS: "log,telegran",
    }));
    record("S8 teslimat: MAS_ALERT_CHANNELS yazım hatası SESSİZCE yutulmuyor (exit 2)",
      s8.code === 2 && /bilinmeyen kanal/.test(s8.out), `exit=${s8.code}`);

    // ── S9: gerçek Telegram kanalı, kimlik bilgisi yok → dürüst başarısızlık, ağ ÇIKIŞI YOK ─
    const s9 = runSnapshot("delivery-telegram-unconfigured", healthyEnv({
      MAS_BACKUP_DIR: emptyBackupDir,
      MAS_ALERT_CHANNELS: "log,telegram",
      DATABASE_URL: appUrl ?? url,   // @/lib/env yüklenebilsin diye
    }));
    const s9row = s9.log.find((r) => r.kind === "delivery" && r.channel === "telegram");
    record("S9 teslimat: yapılandırılmamış Telegram kanalı DÜŞÜYOR ve log'a ok:false yazılıyor",
      s9.code === 2 && s9row?.ok === false, `exit=${s9.code} logRow=${s9row ? `ok=${s9row.ok}` : "YOK"}`);
    record("S9 teslimat: yerel log kanalı yine de İLETTİ (birincil kanal ağdan bağımsız)",
      s9.log.some((r) => r.kind === "delivery" && r.channel === "log" && r.ok === true)
        && alertRows(s9).length > 0,
      `alert satırı=${alertRows(s9).length}`);

    // ── S10: kasten düşen kanal (mockTransport) — teslimat katmanı doğrudan sürülür ────────
    //
    // Ortamda erişilebilir bir Telegram/e-posta ucu YOK ve gerçek bir uca istek atmak bu kapının
    // işi değil. Bu yüzden "kanal cevap verdi ama REDDETTİ" hâli mockTransport ile sürülüyor:
    // S9 yapılandırma eksikliğini, S10 gönderim reddini kanıtlıyor — ikisi farklı arızalar.
    const mockLog = path.join(workDir, "mock-delivery.jsonl");
    const failing = mockTransport({ channel: "telegram", failOn: () => true });
    const sample: TelemetryAlert = {
      signal: "backup_age_hours", section: "DB", value: "YEDEK YOK", threshold: "eşik 36s",
      severity: "P1", message: "backup_age_hours = YEDEK YOK",
    };
    const mockReport = await deliverAlerts({
      runId: "verify-mock-fail", alerts: [sample], logPath: mockLog,
      channels: ["log", "telegram"], transports: { telegram: failing },
    });
    const mockRows = readFileSync(mockLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AlertLogEntry);
    transcript.push(readFileSync(mockLog, "utf8"));
    record("S10 teslimat: kanal gönderimi REDDEDERSE allDelivered=false ve log'da ok:false satırı var",
      mockReport.allDelivered === false
        && mockRows.some((r) => r.kind === "delivery" && r.channel === "telegram" && r.ok === false),
      `allDelivered=${mockReport.allDelivered}`);
    record("S10 teslimat: kanal düşse bile uyarının KENDİSİ kalıcı log'a yazıldı (alarm kaybolmaz)",
      mockRows.some((r) => r.kind === "alert" && r.signal === "backup_age_hours"),
      `alert satırı=${mockRows.filter((r) => r.kind === "alert").length}`);

    /* ════ S11 — ALERT ÇIKTISINDA SIR YOK ════════════════════════════════════════════════ */
    //
    // Taranan şey senaryoların TAMAMININ stdout'u + yazılan HER alert log dosyası. Bağlantı
    // dizesi (parolalı) her koşuda ortamda vardı; hiçbirinde çıktıya sızmamalı.
    //
    // ÜÇ AYRI TARAMA, ÇÜNKÜ TEK TARAMA YETMİYOR — ve biri BİLEREK literal değil:
    //   a. DSN düzeyi — tam bağlantı dizesi hiçbir yerde geçmemeli. En kesin kontrol, parolanın
    //      ne olduğuna bağlı DEĞİL.
    //   b. Şekil düzeyi — parolalı DSN / Bearer / token=… kalıpları; bilinmeyen sırları da yakalar.
    //   c. Literal düzey — app rolünün parolası (bu makinede 18 karakterlik rastgele bir dizge)
    //      metinde hiç geçmemeli.
    //
    // OWNER PAROLASI LİTERAL OLARAK TARANMAZ ve bu bir boşluk değil, ÖLÇÜLMÜŞ bir karar: yerel
    // kümede owner parolası düpedüz 'postgres' — rol adının, veritabanı adının ve
    // `runtime_user postgres` satırının kendisiyle AYNI dizge. Literal taransaydı kapı her koşuda
    // kırmızı yanardı ve yakaladığı şey bir sızıntı değil, bir kelime olurdu (ilk koşuda tam
    // olarak bu oldu). Onun yerine (a) ve (b) devrede: parolayı TAŞIYAN her biçim yakalanıyor.
    const everything = transcript.join("\n");
    const ownerPassword = new URL(url).password;
    const appPassword = appUrl ? new URL(appUrl).password : "";
    const dsnLeak = [url, appUrl].filter((u): u is string => Boolean(u)).filter((u) => everything.includes(u));
    record("S11a sır: tam bağlantı dizesi (DSN) hiçbir çıktıda geçmiyor",
      dsnLeak.length === 0, dsnLeak.length === 0 ? "0 DSN eşleşmesi" : `${dsnLeak.length} DSN sızdı`);
    const shapeHits = looksLikeSecret(everything);
    record("S11b sır: parolalı DSN / Bearer / token=… ŞEKİLLERİ hiçbir çıktıda yok",
      shapeHits.length === 0, shapeHits.length === 0 ? `${everything.length} karakter tarandı` : shapeHits.join(", "));
    if (appPassword.length >= 8) {
      record("S11c sır: app rolü parolası (rastgele dizge) hiçbir çıktıda geçmiyor",
        !everything.includes(appPassword), `${appPassword.length} karakterlik değer arandı`);
    } else {
      skip("S11c sır: app rolü parolası literal taraması",
        "app kimlik bilgisi yok ya da parola çok kısa — literal tarama anlamlı değil");
    }
    record("S11d sır tarayıcısı kör DEĞİL: kasten sırlı iki farklı metni YAKALIYOR",
      looksLikeSecret(`postgres://postgres:${ownerPassword}@127.0.0.1/x`).length > 0
        && looksLikeSecret("authorization: Bearer eyJhbGciOiJIUzI1NiJ9").length > 0,
      "pozitif kontrol");

    /* ════ S12 — ZAMANLAMA: what-if, KAYIT YOK ═════════════════════════════════════════ */
    const runScheduler = (args: string[]): { code: number; out: string } => {
      try {
        return { code: 0, out: execFileSync(process.execPath, ["--import", "tsx", SCHEDULER, ...args], {
          cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
        }) };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    };
    if (process.platform === "win32") {
      const status = runScheduler(["status", "--job", "telemetry"]);
      record("S12 zamanlama: telemetri görevinin durumu sorgulanabiliyor",
        /SCHEDULED TASK = (REGISTERED|NOT REGISTERED)/.test(status.out),
        status.out.split(/\r?\n/).find((l) => l.includes("SCHEDULED TASK"))?.trim() ?? "satır yok");
      const whatIf = runScheduler(["install", "--job", "telemetry"]);
      record("S12 zamanlama: install VARSAYILAN olarak what-if — hiçbir görev KAYDEDİLMEDİ",
        /WHAT-IF/.test(whatIf.out) && /SCHEDULED TASK = NOT REGISTERED/.test(whatIf.out)
          && /mas-telemetry-watch\.cmd/.test(whatIf.out),
        whatIf.out.split(/\r?\n/).find((l) => l.includes("SCHEDULED TASK"))?.trim() ?? "satır yok");
      const after = runScheduler(["status", "--job", "telemetry"]);
      record("S12 zamanlama: what-if SONRASINDA da kayıtlı değil (yan etki yok)",
        /SCHEDULED TASK = NOT REGISTERED/.test(after.out),
        after.out.split(/\r?\n/).find((l) => l.includes("SCHEDULED TASK"))?.trim() ?? "satır yok");
    } else {
      skip("S12 zamanlama", `schtasks yalnız Windows'ta var (platform=${process.platform})`);
    }
  } finally {
    await cleanup();
    rmSync(workDir, { recursive: true, force: true });
    await pool.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti.`);
  if (skipped.length > 0) {
    console.log("ATLANANLAR (ortam kısıtı — 'geçti' SAYILMAZ):");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (failed.length > 0) {
    console.error("TELEMETRY ALERTING VERIFY FAIL:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("TELEMETRY ALERTING VERIFY: ALL PASS");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("telemetry-alerting-verify beklenmedik hata:", e instanceof Error ? e.message : e);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
