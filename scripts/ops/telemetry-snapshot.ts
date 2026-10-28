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
// ═══ AŞAMA 09 — bu script'e EKLENENLER ═══
//
// Rehber §14: "Ama 'script exit 1 veriyor' tek başına production alerting sayılmaz." Üç şey eklendi
// ve stdout sözleşmesi (scripts/ops/telemetry-verify.ts onu ayrıştırıyor) BOZULMADI:
//
//   1. TESLİMAT. Uyarılar `src/lib/ops/alert-delivery.ts` üzerinden kalıcı bir JSONL alert log'una
//      yazılır (birincil, her zaman var) ve yapılandırıldıysa Telegram/e-postaya iletilir.
//      Teslimat başarısızlığının KENDİSİ görünür: log'a yazılır ve AYRI bir çıkış kodu (2) verir.
//   2. MAKİNE OKUNUR ÇIKTI. `--json <yol>` / `TELEMETRY_JSON_OUT` ile aynı anlık görüntü yapısal
//      olarak da yazılır — zamanlanmış iş ve ileride bir pano bunu tüketir. İnsan okunur stdout
//      OLDUĞU GİBİ korunur.
//   3. GENİŞLETİLMİŞ KAPSAM. Rehber §14'ün runtime/DB/app listesinden gerçekten ölçülebilenler
//      eklendi (DB uptime, en uzun aktif sorgu, arka plan/içe aktarım hataları, kilitli hesap,
//      GERÇEK /ready + /health probe'ları). Ölçülemeyenler UYDURULMADI: NOT_OBTAINABLE listesinde
//      adı, sebebi ve neyin gerekeceği yazılı — hem stdout'ta hem JSON çıktısında.
//
// ÇIKIŞ KODLARI:
//   0  uyarı yok, teslimat tamam
//   1  en az bir uyarı var, teslimat tamam
//   2  ALARM TESLİMATI BAŞARISIZ (alarm borusu kırık — bir uyarının kendisinden daha kötüdür)
//
// Usage:
//   MIGRATION_DATABASE_URL=…  [DATABASE_URL=…]  pnpm ops:telemetry
//   MIGRATION_DATABASE_URL=…  pnpm ops:telemetry --json logs/telemetry-latest.json
//
// DATABASE_URL is optional and, when present, is used for exactly one check — that the runtime
// really connects as `mas_radar_app`. Without it that check reports NOT DETERMINED (which counts
// as a failure, per the paragraph above).

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

// Where backups live. Configurable via MAS_BACKUP_DIR so the alert can point at the real backup
// target on the deployment machine — and so the verify can point it at a controlled temp directory
// to prove the alert both fires (no dump) and clears (a fresh dump). Defaults to ./backups.
const BACKUP_DIR = process.env.MAS_BACKUP_DIR ?? path.join(process.cwd(), "backups");
// Yedek yaşını YALNIZ zamanlanmış günlük işin dosyaları belirler (`daily-*.dump`; etiket
// backup-daily.ts ile aynı değişkenden). Her `db:migrate` de backups/ altına bir ön-migrasyon
// dump'ı yazar; onları saymak, günlük iş haftalarca düşerken alarmı susturabiliyordu — ölçüldü:
// en yeni dosya bir `migrate-mas_radar_dev-…` dump'ıydı ve günlük görev o sırada her gece exit 1
// veriyordu. Alarm artık "bir dump var mı" değil, "günlük yedek işi çalışıyor mu" sorusudur.
const BACKUP_LABEL = process.env.MAS_BACKUP_LABEL ?? "daily";

// Kalıcı alert log'u. backups/daily-runs.jsonl ile aynı JSONL deseni; ayrı bir dizinde çünkü
// backups/ yedek dosyalarının retention budamasına tabi ve bir alarm geçmişi budanmamalı.
const ALERT_LOG = process.env.MAS_ALERT_LOG ?? path.join(process.cwd(), "logs", "alerts.jsonl");

// Uygulama probe'larının kökü. Tanımlı DEĞİLSE /ready ve /health ÖLÇÜLMEZ (uydurulmaz):
// değer "(MAS_APP_BASE_URL yok — ölçülmedi)" olur ve bu bir uyarı SAYILMAZ. Tanımlıysa probe
// gerçekten koşar ve 2xx dışındaki her cevap (ya da bağlanamama) UYARI verir — fail-closed.
const APP_BASE_URL = (process.env.MAS_APP_BASE_URL ?? "").replace(/\/+$/, "");
const PROBE_TIMEOUT_MS = 4000;

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

/**
 * Rehber §14 listesinde olup BU MİMARİDE ölçülemeyen sinyaller.
 *
 * Boş bir yuvayı sahte bir metrikle doldurmak, kapsam iddiasını yalan yapar (rehber §28: "PASS
 * çünkü script PASS dedi" yasak ifadelerden). Bu yüzden her biri adıyla, sebebiyle ve neyin
 * gerekeceğiyle burada duruyor ve JSON çıktısının birinci sınıf alanı.
 */
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

/** Tek HTTP probe. Zaman aşımı zorunlu: cevap vermeyen bir uç, "ölçüm askıda kaldı" değil,
 *  "sağlıksız" demektir — asılı kalan bir telemetri koşusu zamanlayıcıda sessiz bir arızadır. */
async function probe(url: string): Promise<{ status: number | null; ms: number; error?: string; body?: string }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const body = (await res.text()).slice(0, 400);
    return { status: res.status, ms: Date.now() - started, body };
  } catch (e) {
    return { status: null, ms: Date.now() - started, error: (e as Error).name === "AbortError"
      ? `zaman aşımı ${PROBE_TIMEOUT_MS}ms` : (e as Error).message.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  currentSection = "RUNTIME";
  console.log("── RUNTIME ────────────────────────────────────────────────────────────");

  // Commit SHA is exposed by /version at runtime; here it is read from the environment the app
  // would have been built with, so a snapshot taken from the shell still identifies the build.
  record("commit_sha", process.env.APP_COMMIT_SHA ?? "(APP_COMMIT_SHA yok)",
    false, "canlıda /version");

  /* ── /ready + /health — AŞAMA 09'da GERÇEK probe oldu ──────────────────────────────────
   *
   * Bunlar eskiden yalnız "/ready" ve "/health" METİNLERİNİ basıyordu: hiçbir şey ölçülmüyor,
   * ama çıktı ölçülmüş gibi görünüyordu. Rehber §14 "health, ready" istiyor — yolun adını değil,
   * cevabını. MAS_APP_BASE_URL tanımlıysa gerçekten çağrılır; tanımlı değilse ÖLÇÜLMEDİĞİ
   * yazılır ve sağlıklı SAYILMAZ (uyarı da vermez — yapılandırılmamış bir probe'un her koşuda
   * kırmızı yanması, kapıyı okunmaz yapar; bu sınır kanıt dosyasında açıkça belgeli).
   */
  if (APP_BASE_URL === "") {
    record("probe_liveness", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/ready · ölçmek için MAS_APP_BASE_URL verin");
    record("probe_dependency", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/health · ölçmek için MAS_APP_BASE_URL verin");
    record("app_uptime_seconds", "(MAS_APP_BASE_URL yok — ölçülmedi)", false, "/version → uptimeSeconds");
  } else {
    const ready = await probe(`${APP_BASE_URL}/ready`);
    record("probe_liveness", ready.status === null ? `BAĞLANAMADI: ${ready.error}` : `HTTP ${ready.status} (${ready.ms}ms)`,
      ready.status !== 200, "/ready — süreç ayakta mı", "P1");

    const health = await probe(`${APP_BASE_URL}/health`);
    record("probe_dependency", health.status === null ? `BAĞLANAMADI: ${health.error}` : `HTTP ${health.status} (${health.ms}ms)`,
      health.status !== 200, "/health — DB kopuksa 503; trafik gönderilsin mi", "P1");

    const version = await probe(`${APP_BASE_URL}/version`);
    let uptime = version.status === null ? `BAĞLANAMADI: ${version.error}` : `(HTTP ${version.status} — alan yok)`;
    try {
      const parsedBody = JSON.parse(version.body ?? "{}") as { uptimeSeconds?: number };
      if (typeof parsedBody.uptimeSeconds === "number") uptime = `${parsedBody.uptimeSeconds}`;
    } catch { /* JSON değilse yukarıdaki değer kalır */ }
    record("app_uptime_seconds", uptime, false, "/version → uptimeSeconds; süreç yeniden başladıysa sıfırlanır");
  }

  currentSection = "DB";
  console.log("\n── VERİTABANI ─────────────────────────────────────────────────────────");

  const conns = await one<string>(`select count(*)::text from pg_stat_activity where datname = current_database()`, "?");
  record("db_connections", conns, false, "");

  const dbSize = await one<string>(`select pg_size_pretty(pg_database_size(current_database()))`, "?");
  record("db_size", dbSize, false, "");

  // Rehber §14 "uptime" — küme tarafı ölçülebilir ve gerçek: postmaster ne zamandır ayakta.
  // Uygulama süreci uptime'ı ayrı bir sinyal (app_uptime_seconds), ikisi karıştırılmamalı.
  const dbUptime = await one<string>(
    `select date_trunc('second', now() - pg_postmaster_start_time())::text`, "?");
  record("db_uptime", dbUptime, false, "postmaster başlangıcından beri");

  const lockWaits = await one<string>(`select count(*)::text from pg_locks where not granted`, "?");
  record("db_lock_waits", lockWaits, Number(lockWaits) > 0, Number(lockWaits) > 0 ? "bekleyen kilit var" : "");

  const rolledBack = await one<string>(
    `select coalesce(xact_rollback,0)::text from pg_stat_database where datname = current_database()`, "?");
  record("db_failed_transactions", rolledBack, false, "kümülatif; ani artış incelenir");

  // Rehber §14 "slow queries" — O ANDA koşan en uzun sorgu. GEÇMİŞ yavaş sorgu şekilleri bu
  // süreçten görülemez (NOT_OBTAINABLE'a bakın); bu sinyal nokta-zamanlıdır ve öyle etiketlenir.
  const longest = await one<string>(
    `select coalesce(round(max(extract(epoch from (now() - query_start))))::text, '0')
       from pg_stat_activity
      where datname = current_database() and state = 'active' and pid <> pg_backend_pid()`, "?");
  record("db_longest_active_query_s", longest, false, "nokta-zamanlı; geçmiş için pg_stat_statements gerekir");

  /* ── ALERT 1 — backup age ─────────────────────────────────────────────────────────────── */
  let backupAgeHours = Number.POSITIVE_INFINITY;
  let newest = "(yok)";
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith(`${BACKUP_LABEL}-`) && f.endsWith(".dump"));
    for (const f of files) {
      const ageH = (Date.now() - statSync(path.join(BACKUP_DIR, f)).mtimeMs) / 3_600_000;
      if (ageH < backupAgeHours) { backupAgeHours = ageH; newest = f; }
    }
  } catch { /* dizin yok — sonsuz yaş, alert */ }
  record("backup_age_hours",
    Number.isFinite(backupAgeHours) ? backupAgeHours.toFixed(1) : "YEDEK YOK",
    backupAgeAlert(backupAgeHours, BACKUP_MAX_AGE_HOURS),
    `eşik ${BACKUP_MAX_AGE_HOURS}s · yalnız ${BACKUP_LABEL}-*.dump · en yeni: ${newest}`,
    "P1"); // §31 P1: "backup schedule/off-device control not operational before pilot"

  currentSection = "APP";
  console.log("\n── UYGULAMA ───────────────────────────────────────────────────────────");

  /* ── ALERT 2 — background queue stuck ─────────────────────────────────────────────────── */
  const stuck = await one<string>(
    `select count(*)::text from public.background_jobs
      where status = 'running' and started_at < now() - interval '${JOB_STUCK_MINUTES} minutes'`, "?");
  const deadLettered = await one<string>(
    `select count(*)::text from public.background_jobs where dead_lettered_at is not null`, "?");
  record("jobs_stuck", stuck, jobsStuckAlert(stuck), `> ${JOB_STUCK_MINUTES} dk 'running'`, "P1");
  record("jobs_dead_lettered", deadLettered, false, "bilgi — elle replay gerekir");

  // Rehber §14 "background failures". Son 24 saatte terminal-hata durumuna düşen işler.
  // Bilgi sinyali: tek bir başarısız iş yeniden denenir ve normaldir; ALARM eşiği takılı kuyruk
  // (jobs_stuck) ve dead-letter tarafında zaten var — burada ikinci bir eşik uydurulmadı.
  const jobsFailed = await one<string>(
    `select count(*)::text from public.background_jobs
      where status in ('failed','dead_letter') and coalesce(finished_at, updated_at) > now() - interval '24 hours'`, "?");
  record("jobs_failed_24h", jobsFailed, false, "arka plan hataları — ani artış incelenir");

  // Rehber §14 "failed import". Aynı tablo, yalnız içe aktarım tipleri: bir raporun düşmesiyle
  // bir muhasebe dosyasının düşmesi aynı şey değildir.
  const importsFailed = await one<string>(
    `select count(*)::text from public.background_jobs
      where job_type in ('excel_import','bank_statement_import')
        and status in ('failed','dead_letter')
        and coalesce(finished_at, updated_at) > now() - interval '24 hours'`, "?");
  record("import_failures_24h", importsFailed, false, "excel/banka içe aktarımı — 24 saat");

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
    `eşik ${IMPORT_STALE_DAYS} gün`,
    "P2"); // §31: bayat kaynak veriyi BOZMAZ, geciktirir — P0/P1 listelerinde yok

  /* ── ALERT 4 — reconciliation mismatch ────────────────────────────────────────────────── */
  const reconMismatch = await one<string>(
    `select count(*)::text from public.treasury_cashflow_reconciliation where coalesce(difference, 0) <> 0`, "?");
  record("reconciliation_mismatch", reconMismatch,
    reconciliationAlert(reconMismatch), "sıfırdan farklı satır sayısı",
    "P0"); // §31 P0: "incorrect monetary KPI" / "double counting"

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
  record("runtime_user", runtimeUser, runtimeIdentityAlert(runtimeUser), "mas_radar_app olmalı — değilse RLS baypas",
    "P0"); // §31 P0: "owner/superuser runtime" + "RLS bypass"

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
  record("schema_ledger", ledger, ledgerAlert(ledger, expected), `beklenen ${expected}`,
    "P0"); // §31 P0: "wrong ledger"

  /* ── auth / kimlik doğrulama — AŞAMA 09'da GERÇEK kaynağa taşındı ──────────────────────
   *
   * BULUNAN DEFEKT. Bu sinyal `audit_logs where action ilike '%login%fail%'` sorguluyordu.
   * Ölçüldü: `src/app/login/actions.ts` başarısız girişte audit_logs'a HİÇBİR satır yazmıyor
   * (BİLEREK — kullanıcı adını loglamak, yanlış kutuya yazılmış parolayı loglamak demektir).
   * Yani sorgu YAPISAL olarak her zaman 0 döndürüyordu: ölü bir metrik, kapsam iddiası yalan.
   *
   * Gerçek ve kalıcı kaynak `public.users`: `failed_login_count` (başarılı girişte sıfırlanır)
   * ve `locked_until` (0031'deki 5-deneme/15-dakika kilidi). İkisi de gerçekten yazılıyor.
   */
  const failedLogins = await one<string>(
    `select coalesce(sum(failed_login_count), 0)::text from public.users`, "?");
  record("auth_failed_logins", failedLogins, false, "users.failed_login_count toplamı — başarılı girişte sıfırlanır");

  const lockedAccounts = await one<string>(
    `select count(*)::text from public.users where locked_until is not null and locked_until > now()`, "?");
  record("auth_locked_accounts", lockedAccounts, false, "şu an kilitli hesap (0031: 5 deneme / 15 dk)");

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

  // Ortamda GERÇEKTEN tanımlı sır değerleri — teslimat katmanına maskelenmek üzere verilir.
  // Adları burada, DEĞERLERİ hiçbir yerde basılmaz.
  const redactValues = [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "EMAIL_API_KEY", "EMAIL_API_URL", "EMAIL_TO",
    "OPENAI_API_KEY", "DATABASE_URL", "MIGRATION_DATABASE_URL", "SEED_ADMIN_PASSWORD",
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
  });

  console.log(`ALERT LOG: ${ALERT_LOG}`);
  for (const o of delivery.outcomes) {
    console.log(`  kanal ${o.channel.padEnd(9)} ${o.attempted ? (o.ok ? "İLETİLDİ" : `İLETİLEMEDİ — ${o.error ?? ""}`) : "denenmedi (uyarı yok)"}`);
  }
  // Bilinmeyen kanal jetonu = sessizce kapanmış bir teslimat. Fail-closed.
  const channelConfigOk = unknown.length === 0;
  if (!channelConfigOk) {
    console.error(`MAS_ALERT_CHANNELS bilinmeyen kanal içeriyor: ${unknown.join(", ")} — teslimat yapılandırması güvenilmez.`);
  }
  /* ── yapısal çıktı ─────────────────────────────────────────────────────────────────────
   *
   * TESLİMAT SATIRINDAN ÖNCE yazılır ve BİLEREK öyle: yazılamayan bir JSON da bir teslimat
   * başarısızlığıdır (zamanlanmış iş koşu kaydını bu dosyadan kuruyor), dolayısıyla
   * "TELEMETRY DELIVERY: OK" satırı ancak JSON da yazıldıktan sonra basılabilir. Aksi hâlde
   * stdout "OK" derken çıkış kodu 2 olurdu — raporu okuyan kişiyi yanıltan tam olarak bu.
   */
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
        commitSha: process.env.APP_COMMIT_SHA ?? null,
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
  // Teslimat başarısızlığı en yüksek önceliktedir: bilinen bir uyarıdan daha kötüdür, çünkü
  // bundan sonraki uyarıların HİÇBİRİ görülmeyecek demektir.
  process.exit(!delivered ? 2 : alerts.length === 0 ? 0 : 1);
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => {});
  process.exit(1);
});
