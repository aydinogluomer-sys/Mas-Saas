// Faz 12 / Faz 62 — the operational signals, in one command, with the fail-closed alerts as assertions.
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
// ÇIKIŞ KODLARI:
//   0  uyarı yok, teslimat tamam
//   1  en az bir uyarı var, teslimat tamam
//   2  ALARM TESLİMATI BAŞARISIZ (alarm borusu kırık — bir uyarının kendisinden daha kötüdür)
//
// Usage:
//   MIGRATION_DATABASE_URL=…  [DATABASE_URL=…]  pnpm ops:telemetry
//   MIGRATION_DATABASE_URL=…  pnpm ops:telemetry --json logs/telemetry-latest.json

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { requireOwnerDatabaseUrl } from "../db/owner-url";
import {
  backupAgeAlert,
  evaluateOffDeviceRunLog,
  importStaleAlert,
  jobsStuckAlert,
  ledgerAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";
import {
  deliverAlerts,
  parseAlertChannels,
  type AlertSeverity,
  type TelemetryAlert,
} from "@/lib/ops/alert-delivery";

/** Thresholds. Deliberately conservative: an alert that never fires teaches people to ignore it. */
const BACKUP_MAX_AGE_HOURS = 36;      // günlük yedek + kaçırılan bir gün payı
const JOB_STUCK_MINUTES = 30;         // reaper 30 dakikada bir süpürüyor
const IMPORT_STALE_DAYS = 45;         // aylık çalışma dosyası ritmi + pay

const BACKUP_DIR = process.env.MAS_BACKUP_DIR ?? path.join(process.cwd(), "backups");
const BACKUP_LABEL = process.env.MAS_BACKUP_LABEL ?? "daily";
const OFFDEVICE_BACKUP_DIR = (process.env.MAS_OFFDEVICE_BACKUP_DIR ?? "").trim();

const ALERT_LOG = process.env.MAS_ALERT_LOG ?? path.join(process.cwd(), "logs", "alerts.jsonl");

const APP_BASE_URL = (process.env.MAS_APP_BASE_URL ?? "").replace(/\/+$/, "");
const PROBE_TIMEOUT_MS = 8000;
const SQL_UNKNOWN_NOTE = "UNKNOWN — veritabanı sorgusu başarısız, 0 sayılmaz";

const RUN_ID = process.env.MAS_TELEMETRY_RUN_ID ?? `tel-${new Date().toISOString().replace(/[:.]/g, "-")}`;

/** JSON çıktı yolu: `--json <yol>`, yalnız `--json`, ya da TELEMETRY_JSON_OUT. */
function jsonOutPath(): string | null {
  const i = process.argv.indexOf("--json");
  if (i !== -1) {
    const next = process.argv[i + 1];
    if (next && !next.startsWith("-")) return next;
    return path.join(process.cwd(), "logs", "telemetry-latest.json");
  }
  return process.env.TELEMETRY_JSON_OUT || null;
}

const NOT_OBTAINABLE: ReadonlyArray<{ signal: string; reason: string; wouldRequire: string }> = Object.freeze([
  {
    signal: "restart_count",
    reason: "Süreci yeniden başlatan bir süpervizör yok; `next start` elle/Task Scheduler'dan koşuyor ve yeniden başlatmayı sayan bir taraf bulunmuyor.",
    wouldRequire: "Bir süpervizör (NSSM/Windows Service/pm2) ya da yeniden başlatmaları sayan bir sarmalayıcı .cmd + kalıcı sayaç dosyası.",
  },
  {
    signal: "5xx (uygulama geneli)",
    reason: "Uygulama 5xx'i `src/lib/api-response.ts` üzerinden `log.error(\"unhandled_route_error\")` ile stderr'e JSONL yazıyor; dağıtım stderr'i bir dosyaya YÖNLENDİRMİYOR, bu yüzden sayacak bir toplayıcı yok. CLI anlık görüntüsü sunucunun stderr'ini göremez.",
    wouldRequire: "Sunucu stderr'ini bir dosyaya yönlendiren bir sarmalayıcı (mas-daily-backup.cmd deseni) + bu script'te satır sayan bir okuyucu. `probe_dependency` yalnız probe uçlarındaki 5xx'i görür, uygulama genelini değil.",
  },
  {
    signal: "pageerror",
    reason: "Tarayıcı tarafı sinyal. Uygulamada client-side hata toplayıcı (window.onerror → sunucu ucu) YOK; yalnız Playwright görsel testleri koşarken yakalanıyor.",
    wouldRequire: "Bir client error-reporting ucu (/api/client-error) + toplama tablosu. Yeni bir egress/veri yüzeyi açar; Faz 15 sınır kapısı gereği ayrı bir inceleme ister.",
  },
  {
    signal: "rate-limit failures",
    reason: "`src/lib/rate-limit.ts` BİLEREK süreç-içi (globalThis Map): tek örnekli dağıtımda paylaşılan bir sayaç okuyucusu olmayan altyapı olurdu. Bir CLI anlık görüntüsü sunucunun belleğini göremez.",
    wouldRequire: "Rate-limit reddedilmelerinin kalıcı bir sayaca (tablo/dosya) yazılması. Bugünkü tek kalıcı iz `log.warn(\"login_rate_limited\")` — o da yönlendirilmemiş stderr'de.",
  },
  {
    signal: "slow queries (geçmiş)",
    reason: "`src/lib/perf/slow-query.ts` süreç-içi halka tamponu; sunucunun tamponunu bir CLI süreci OKUYAMAZ (ayrı süreç, paylaşılan bellek yok) ve pg_stat_statements bu kümede kurulu değil. `db_longest_active_query_s` yalnız O ANDA koşan en uzun sorguyu görür — geçmiş değil.",
    wouldRequire: "pg_stat_statements eklentisi (küme düzeyinde shared_preload_libraries) ya da halka tamponunu okuyan kimliği doğrulanmış bir uç.",
  },
]);

type Section = "RUNTIME" | "DB" | "APP";

interface Signal {
  name: string;
  section: Section;
  value: string;
  alert: boolean;
  note: string;
  severity: AlertSeverity | null;
}
const signals: Signal[] = [];
let currentSection: Section = "RUNTIME";

/**
 * STDOUT SÖZLEŞMESİ — DEĞİŞTİRMEYİN.
 * scripts/ops/telemetry-verify.ts bu satırı `^(ALERT|\s+ok)\s+(\S+)` ile ayrıştırıyor.
 * `severity` yalnız yapısal çıktıya ve teslimata gider; insan satırı aynı kalır.
 */
function record(name: string, value: string, alert: boolean, note: string, severity: AlertSeverity | null = null): void {
  signals.push({ name, section: currentSection, value, alert, note, severity: alert ? severity : null });
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

function unwrapErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause;
    const causeMsg =
      cause instanceof Error
        ? cause.message
        : typeof (cause as { message?: unknown } | undefined)?.message === "string"
          ? String((cause as { message: string }).message)
          : "";
    return causeMsg && !e.message.includes(causeMsg) ? `${e.message} (${causeMsg})` : e.message;
  }
  return String(e);
}

/** HTTP probe with 8000ms timeout + 1 retry on transient socket/timeout errors, unwrapping cause. */
async function probe(url: string): Promise<{ status: number | null; ms: number; error?: string; body?: string }> {
  const started = Date.now();
  let lastError = "bilinmeyen ağ hatası";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      const body = (await res.text()).slice(0, 600);
      return { status: res.status, ms: Date.now() - started, body };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        lastError = `zaman aşımı ${PROBE_TIMEOUT_MS}ms`;
      } else {
        lastError = unwrapErrorMessage(e).slice(0, 140);
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { status: null, ms: Date.now() - started, error: lastError };
}

async function main(): Promise<void> {
  currentSection = "RUNTIME";
  console.log("── RUNTIME ────────────────────────────────────────────────────────────");

  let resolvedCommitSha: string | null = process.env.APP_COMMIT_SHA?.trim() || null;

  if (APP_BASE_URL === "") {
    record("commit_sha", resolvedCommitSha ?? "(APP_COMMIT_SHA yok)", false, "canlıda /version");
    record("probe_liveness", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/ready · ölçmek için MAS_APP_BASE_URL verin");
    record("probe_dependency", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/health · ölçmek için MAS_APP_BASE_URL verin");
    record("app_uptime_seconds", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/version → uptimeSeconds");
  } else {
    const [ready, health, version] = await Promise.all([
      probe(`${APP_BASE_URL}/ready`),
      probe(`${APP_BASE_URL}/health`),
      probe(`${APP_BASE_URL}/version`),
    ]);

    let uptime = version.status === null ? `BAĞLANAMADI: ${version.error}` : `(HTTP ${version.status} — alan yok)`;
    try {
      const parsedBody = JSON.parse(version.body ?? "{}") as {
        uptimeSeconds?: number;
        commit?: string;
        buildId?: string;
      };
      if (typeof parsedBody.uptimeSeconds === "number") uptime = `${parsedBody.uptimeSeconds}`;
      if (!resolvedCommitSha) {
        const candidateCommit = parsedBody.commit?.trim();
        if (candidateCommit && candidateCommit !== "unknown") {
          resolvedCommitSha = candidateCommit;
        } else if (parsedBody.buildId && parsedBody.buildId !== "unreadable" && parsedBody.buildId !== "unknown") {
          resolvedCommitSha = parsedBody.buildId.trim();
        }
      }
    } catch {
      /* JSON değilse yukarıdaki değer kalır */
    }

    record(
      "commit_sha",
      resolvedCommitSha ?? "(APP_COMMIT_SHA yok)",
      false,
      process.env.APP_COMMIT_SHA ? "ortamdan (APP_COMMIT_SHA)" : "canlı /version yanıtından",
    );
    record(
      "probe_liveness",
      ready.status === null ? `BAĞLANAMADI: ${ready.error}` : `HTTP ${ready.status} (${ready.ms}ms)`,
      ready.status !== 200,
      "/ready — süreç ayakta mı",
      "P1",
    );
    record(
      "probe_dependency",
      health.status === null ? `BAĞLANAMADI: ${health.error}` : `HTTP ${health.status} (${health.ms}ms)`,
      health.status !== 200,
      "/health — DB/rol/şema sağlıksızsa 503; trafik gönderilsin mi",
      "P1",
    );
    record("app_uptime_seconds", uptime, false, "/version → uptimeSeconds; süreç yeniden başladıysa sıfırlanır");
  }

  currentSection = "DB";
  console.log("\n── VERİTABANI ─────────────────────────────────────────────────────────");

  let dbReachable = false;
  let dbReachableNote = "PostgreSQL bağlantısı doğrulandı";
  try {
    await pool.query("select 1");
    dbReachable = true;
  } catch (e) {
    dbReachableNote = `UNKNOWN — veritabanına ulaşılamadı: ${unwrapErrorMessage(e).slice(0, 120)}`;
  }
  record("db_reachable", dbReachable ? "up" : "down", !dbReachable, dbReachableNote, "P0");

  const conns = await one<string>(`select count(*)::text from pg_stat_activity where datname = current_database()`, "?");
  record("db_connections", conns, conns === "?", conns === "?" ? SQL_UNKNOWN_NOTE : "", "P0");

  const dbSize = await one<string>(`select pg_size_pretty(pg_database_size(current_database()))`, "?");
  record("db_size", dbSize, dbSize === "?", dbSize === "?" ? SQL_UNKNOWN_NOTE : "", "P1");

  const dbUptime = await one<string>(
    `select date_trunc('second', now() - pg_postmaster_start_time())::text`,
    "?",
  );
  record(
    "db_uptime",
    dbUptime,
    dbUptime === "?",
    dbUptime === "?" ? SQL_UNKNOWN_NOTE : "postmaster başlangıcından beri",
    "P1",
  );

  const lockWaits = await one<string>(`select count(*)::text from pg_locks where not granted`, "?");
  const lockWaitsAlert = lockWaits === "?" || Number(lockWaits) > 0;
  record(
    "db_lock_waits",
    lockWaits,
    lockWaitsAlert,
    lockWaits === "?" ? SQL_UNKNOWN_NOTE : Number(lockWaits) > 0 ? "bekleyen kilit var" : "",
    "P1",
  );

  const rolledBack = await one<string>(
    `select coalesce(xact_rollback,0)::text from pg_stat_database where datname = current_database()`,
    "?",
  );
  record(
    "db_failed_transactions",
    rolledBack,
    rolledBack === "?",
    rolledBack === "?" ? SQL_UNKNOWN_NOTE : "kümülatif; ani artış incelenir",
    "P1",
  );

  const longest = await one<string>(
    `select coalesce(round(max(extract(epoch from (now() - query_start))))::text, '0')
       from pg_stat_activity
      where datname = current_database() and state = 'active' and pid <> pg_backend_pid()`,
    "?",
  );
  record(
    "db_longest_active_query_s",
    longest,
    longest === "?",
    longest === "?" ? SQL_UNKNOWN_NOTE : "nokta-zamanlı; geçmiş için pg_stat_statements gerekir",
    "P1",
  );

  /* ── ALERT 1 — backup age & off-device status (Faz 43 / B3) ──────────────────────────── */
  let backupAgeHours = Number.POSITIVE_INFINITY;
  let newest = "(yok)";
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith(`${BACKUP_LABEL}-`) && f.endsWith(".dump"));
    for (const f of files) {
      const ageH = (Date.now() - statSync(path.join(BACKUP_DIR, f)).mtimeMs) / 3_600_000;
      if (ageH < backupAgeHours) { backupAgeHours = ageH; newest = f; }
    }
  } catch { /* dizin yok — sonsuz yaş, alert */ }
  record(
    "backup_age_hours",
    Number.isFinite(backupAgeHours) ? backupAgeHours.toFixed(1) : "YEDEK YOK",
    backupAgeAlert(backupAgeHours, BACKUP_MAX_AGE_HOURS),
    `eşik ${BACKUP_MAX_AGE_HOURS}s · yalnız ${BACKUP_LABEL}-*.dump · en yeni: ${newest}`,
    "P1",
  );

  const runLogPath = path.join(BACKUP_DIR, "daily-runs.jsonl");
  const rawRunLog = existsSync(runLogPath) ? readFileSync(runLogPath, "utf8") : null;
  let offDeviceReceiptInfo:
    | { exists: boolean; offDeviceSatisfied?: boolean; sha256VerifiedAtDestination?: boolean }
    | null = null;
  if (OFFDEVICE_BACKUP_DIR !== "" && newest !== "(yok)") {
    const receiptPath = path.join(OFFDEVICE_BACKUP_DIR, `${newest}.offdevice.json`);
    if (!existsSync(receiptPath)) {
      offDeviceReceiptInfo = { exists: false };
    } else {
      try {
        const parsedReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
          offDeviceSatisfied?: boolean;
          sha256VerifiedAtDestination?: boolean;
        };
        offDeviceReceiptInfo = {
          exists: true,
          offDeviceSatisfied: parsedReceipt.offDeviceSatisfied === true,
          sha256VerifiedAtDestination: parsedReceipt.sha256VerifiedAtDestination === true,
        };
      } catch {
        offDeviceReceiptInfo = {
          exists: true,
          offDeviceSatisfied: false,
          sha256VerifiedAtDestination: false,
        };
      }
    }
  }
  const offDeviceStatus = evaluateOffDeviceRunLog(rawRunLog, offDeviceReceiptInfo);
  record(
    "offdevice_backup_status",
    offDeviceStatus.value,
    offDeviceStatus.alert,
    offDeviceStatus.note,
    "P1",
  );

  currentSection = "APP";
  console.log("\n── UYGULAMA ───────────────────────────────────────────────────────────");

  /* ── ALERT 2 — background queue stuck ─────────────────────────────────────────────────── */
  const stuck = await one<string>(
    `select count(*)::text from public.background_jobs
      where status = 'running' and started_at < now() - interval '${JOB_STUCK_MINUTES} minutes'`,
    "?",
  );
  const deadLettered = await one<string>(
    `select count(*)::text from public.background_jobs where dead_lettered_at is not null`,
    "?",
  );
  record(
    "jobs_stuck",
    stuck,
    jobsStuckAlert(stuck),
    stuck === "?" ? SQL_UNKNOWN_NOTE : `> ${JOB_STUCK_MINUTES} dk 'running'`,
    "P1",
  );
  record(
    "jobs_dead_lettered",
    deadLettered,
    deadLettered === "?",
    deadLettered === "?" ? SQL_UNKNOWN_NOTE : "bilgi — elle replay gerekir",
    "P1",
  );

  const jobsFailed = await one<string>(
    `select count(*)::text from public.background_jobs
      where status in ('failed','dead_letter') and coalesce(finished_at, updated_at) > now() - interval '24 hours'`,
    "?",
  );
  record(
    "jobs_failed_24h",
    jobsFailed,
    jobsFailed === "?",
    jobsFailed === "?" ? SQL_UNKNOWN_NOTE : "arka plan hataları — ani artış incelenir",
    "P1",
  );

  const importsFailed = await one<string>(
    `select count(*)::text from public.background_jobs
      where job_type in ('excel_import','bank_statement_import')
        and status in ('failed','dead_letter')
        and coalesce(finished_at, updated_at) > now() - interval '24 hours'`,
    "?",
  );
  record(
    "import_failures_24h",
    importsFailed,
    importsFailed === "?",
    importsFailed === "?" ? SQL_UNKNOWN_NOTE : "excel/banka içe aktarımı — 24 saat",
    "P1",
  );

  /* ── ALERT 3 — latest import stale ────────────────────────────────────────────────────── */
  const importAgeDays = await (async (): Promise<string> => {
    try {
      const res = await pool.query<{ age_days: string }>(
        `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK') as age_days
           from public.valid_workbook_imports`,
      );
      return res.rows[0]?.age_days ?? "?";
    } catch {
      return await one<string>(
        `select coalesce(round(extract(epoch from (now() - max(source_workbooks.imported_at))) / 86400)::text, 'İÇE AKTARIM YOK')
           from public.source_workbooks
          where status in ('parsed', 'mapped')
            and exists (
              select 1
                from public.import_rows ir
               where ir.workbook_id = source_workbooks.id
            )`,
        "?",
      );
    }
  })();
  record(
    "latest_import_age_days",
    importAgeDays,
    importStaleAlert(importAgeDays, IMPORT_STALE_DAYS),
    importAgeDays === "?" ? SQL_UNKNOWN_NOTE : `eşik ${IMPORT_STALE_DAYS} gün`,
    "P2",
  );

  /* ── ALERT 4 — reconciliation mismatch ────────────────────────────────────────────────── */
  const reconMismatch = await one<string>(
    `select count(*)::text from public.treasury_cashflow_reconciliation where coalesce(difference, 0) <> 0`,
    "?",
  );
  record(
    "reconciliation_mismatch",
    reconMismatch,
    reconciliationAlert(reconMismatch),
    reconMismatch === "?" ? SQL_UNKNOWN_NOTE : "sıfırdan farklı satır sayısı",
    "P0",
  );

  /* ── ALERT 5 — runtime identity ───────────────────────────────────────────────────────── */
  let runtimeUser = "(DATABASE_URL verilmedi)";
  if (process.env.DATABASE_URL) {
    const rt = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      runtimeUser = (await rt.query<{ u: string }>(`select current_user u`)).rows[0].u;
    } catch (e) {
      runtimeUser = `BAĞLANAMADI: ${unwrapErrorMessage(e).slice(0, 80)}`;
    } finally {
      await rt.end().catch(() => {});
    }
  }
  record(
    "runtime_user",
    runtimeUser,
    runtimeIdentityAlert(runtimeUser),
    "mas_radar_app olmalı — değilse RLS baypas",
    "P0",
  );

  /* ── ALERT 6 — schema ledger ──────────────────────────────────────────────────────────── */
  const ledger = await one<string>(
    `select count(*)::text || '/' || coalesce(max(version), 'yok') from public.schema_migrations`,
    "?",
  );
  const expected = (() => {
    try {
      const files = readdirSync(path.join(process.cwd(), "supabase", "migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      return `${files.length}/${files[files.length - 1].slice(0, 4)}`;
    } catch {
      return "?";
    }
  })();
  record(
    "schema_ledger",
    ledger,
    ledgerAlert(ledger, expected),
    ledger === "?" ? `${SQL_UNKNOWN_NOTE} (beklenen ${expected})` : `beklenen ${expected}`,
    "P0",
  );

  /* ── auth / kimlik doğrulama ──────────────────────────────────────────────────────────── */
  const failedLogins = await one<string>(
    `select coalesce(sum(failed_login_count), 0)::text from public.users`,
    "?",
  );
  record(
    "auth_failed_logins",
    failedLogins,
    failedLogins === "?",
    failedLogins === "?" ? SQL_UNKNOWN_NOTE : "users.failed_login_count toplamı — başarılı girişte sıfırlanır",
    "P1",
  );

  const lockedAccounts = await one<string>(
    `select count(*)::text from public.users where locked_until is not null and locked_until > now()`,
    "?",
  );
  record(
    "auth_locked_accounts",
    lockedAccounts,
    lockedAccounts === "?",
    lockedAccounts === "?" ? SQL_UNKNOWN_NOTE : "şu an kilitli hesap (0031: 5 deneme / 15 dk)",
    "P1",
  );

  /* ── ölçülemeyenler ───────────────────────────────────────────────────────────────────── */
  console.log("\n── ÖLÇÜLEMEYEN (rehber §14 listesinde var, bu mimaride toplayıcısı yok) ──");
  for (const n of NOT_OBTAINABLE) console.log(`ÖLÇÜLEMEZ  ${n.signal.padEnd(30)} ${n.reason.slice(0, 96)}`);

  /* ── özet + teslimat ──────────────────────────────────────────────────────────────────── */
  const alerts = signals.filter((s) => s.alert);
  console.log(`\n${signals.length - alerts.length}/${signals.length} sinyal normal.`);
  if (alerts.length > 0) {
    console.log("UYARI VEREN SİNYALLER:");
    for (const a of alerts) console.log(`  - ${a.name} = ${a.value}  (${a.note})`);
  }
  console.log(alerts.length === 0 ? "TELEMETRY: ALL CLEAR" : "TELEMETRY: ALERT");

  const redactValues = [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "EMAIL_API_KEY", "EMAIL_API_URL", "EMAIL_TO",
    "OPENAI_API_KEY", "DATABASE_URL", "MIGRATION_DATABASE_URL", "SEED_ADMIN_PASSWORD",
    "BACKUP_ENCRYPTION_KEY",
  ].map((k) => process.env[k]).filter((v): v is string => typeof v === "string" && v.length > 0);

  const { channels, unknown } = parseAlertChannels(process.env.MAS_ALERT_CHANNELS);
  const payload: TelemetryAlert[] = alerts.map((a) => ({
    signal: a.name,
    section: a.section,
    value: a.value,
    threshold: a.note,
    severity: a.severity ?? "P2",
    message: `${a.name} = ${a.value} (${a.note})`,
  }));

  const delivery = await deliverAlerts({
    runId: RUN_ID,
    alerts: payload,
    logPath: ALERT_LOG,
    channels,
    redactValues,
    pool: dbReachable ? pool : null,
  });

  console.log(`ALERT LOG: ${ALERT_LOG}`);
  for (const o of delivery.outcomes) {
    console.log(`  kanal ${o.channel.padEnd(9)} ${o.attempted ? (o.ok ? "İLETİLDİ" : `İLETİLEMEDİ — ${o.error ?? ""}`) : "denenmedi (uyarı yok)"}`);
  }
  const channelConfigOk = unknown.length === 0;
  if (!channelConfigOk) {
    console.error(`MAS_ALERT_CHANNELS bilinmeyen kanal içeriyor: ${unknown.join(", ")} — teslimat yapılandırması güvenilmez.`);
  }

  const out = jsonOutPath();
  let jsonOk = true;
  const deliveredChannels = delivery.allDelivered && channelConfigOk;
  if (out) {
    try {
      mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      writeFileSync(out, JSON.stringify({
        kind: "mas-telemetry-snapshot-v1",
        runId: RUN_ID,
        generatedAt: new Date().toISOString(),
        commitSha: resolvedCommitSha,
        thresholds: {
          backupMaxAgeHours: BACKUP_MAX_AGE_HOURS,
          jobStuckMinutes: JOB_STUCK_MINUTES,
          importStaleDays: IMPORT_STALE_DAYS,
          probeTimeoutMs: PROBE_TIMEOUT_MS,
        },
        signalCount: signals.length,
        alertCount: alerts.length,
        signals: signals.map((s) => ({
          name: s.name, section: s.section, value: s.value, alert: s.alert, note: s.note, severity: s.severity,
        })),
        notObtainable: NOT_OBTAINABLE,
        delivery: {
          alertLogPath: ALERT_LOG,
          channels,
          unknownChannels: unknown,
          allDelivered: deliveredChannels,
          outcomes: delivery.outcomes,
        },
        verdict: !deliveredChannels ? "DELIVERY_FAILED" : alerts.length === 0 ? "ALL_CLEAR" : "ALERT",
      }, null, 2) + "\n", "utf8");
      console.log(`JSON: ${path.resolve(out)}`);
    } catch (e) {
      jsonOk = false;
      console.error(`JSON çıktısı yazılamadı (${out}): ${(e as Error).message}`);
    }
  }

  const delivered = deliveredChannels && jsonOk;
  console.log(delivered ? "TELEMETRY DELIVERY: OK" : "TELEMETRY DELIVERY: FAILED");

  await pool.end();
  process.exit(!delivered ? 2 : alerts.length === 0 ? 0 : 1);
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => {});
  process.exit(1);
});
