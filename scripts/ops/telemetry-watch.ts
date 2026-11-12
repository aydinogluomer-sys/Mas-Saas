// AŞAMA 09 Schedule — zamanlanmış görevin ÇALIŞTIRDIĞI şey budur.
//
// Rehber §14 "Schedule" dört şeyin belirli periyotla koşmasını istiyor:
//
//     telemetry snapshot · backup-age check · stale-data check · queue check
//
// Faz 43 (`B3`) ile buna harici yedek doğrulaması (`offdevice_backup_status`) ve web uygulama
// `/ready` + `/health` yoklaması için `.env.local` ortam aktarımı (`PASSTHROUGH_FROM_ENV_LOCAL`)
// eklendi.
//
// backup-daily.ts ile AYNI desen (Aşama 07): ön koşullar → iş → `*.jsonl` koşu kaydı →
// fail-closed çıkış kodları. Ayrı bir operasyon günlüğü formatı icat edilmedi.
//
// ÇIKIŞ KODLARI (zamanlayıcı bunları görür):
//   0  hiçbir uyarı yok, alarm teslimatı tamam
//   1  en az bir uyarı var ve TESLİM EDİLDİ (operatör kalıcı log'da/kanalda görecek)
//   2  ALARM TESLİMATI BAŞARISIZ — alarm borusu kırık; uyarı olmasından daha kötüdür
//   3  anlık görüntü hiç koşamadı (bağlantı yok / script çöktü) → hiçbir şey bilmiyoruz
//
// VERİ SINIFI: yalnız OKUMA. Bu iş hiçbir tabloya yazmaz; tek yazdığı yer `logs/` altındaki
// operasyon günlükleridir.
//
// Kullanım:
//   pnpm ops:telemetry:watch
//   (bağlantı .env.local'den okunur; ortam değişkeni verilmişse o kazanır)

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "scripts", "ops", "telemetry-snapshot.ts");
const LOG_DIR = process.env.MAS_TELEMETRY_LOG_DIR ?? path.join(ROOT, "logs");
const RUN_LOG = path.join(LOG_DIR, "telemetry-runs.jsonl");
const JSON_OUT = path.join(LOG_DIR, "telemetry-latest.json");

/** Rehber §14 + Faz 43 zamanlanmış kontroller → hangi sinyalden okunur. */
const SCHEDULED_CHECKS: ReadonlyArray<{ check: string; signal: string | null }> = Object.freeze([
  { check: "telemetry snapshot", signal: null }, // koşunun bütünü
  { check: "backup-age check", signal: "backup_age_hours" },
  { check: "offdevice-backup check", signal: "offdevice_backup_status" },
  { check: "stale-data check", signal: "latest_import_age_days" },
  { check: "queue check", signal: "jobs_stuck" },
]);

/**
 * Görev Zamanlayıcı oturumsuz (`S4U`) çalıştığında `.env.local` içinden `telemetry-snapshot.ts`'e
 * iletilmesi gereken yapılandırma anahtarları (süreç ortamında açıkça verilmişse süreç kazanır).
 */
export const PASSTHROUGH_FROM_ENV_LOCAL: readonly string[] = Object.freeze([
  "MAS_ALERT_CHANNELS",
  "MAS_APP_BASE_URL",
  "MAS_BACKUP_DIR",
  "MAS_BACKUP_LABEL",
  "MAS_OFFDEVICE_BACKUP_DIR",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "EMAIL_API_URL",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "EMAIL_TO",
  "MAS_ALLOWED_EMAIL_HOSTS",
]);

/** `.env.local`'i process.env'e SIZDIRMADAN okur (backup-daily.ts ile aynı desen). */
function readEnvLocal(): Record<string, string> {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export function buildWatchSubprocessEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  envLocal: Readonly<Record<string, string | undefined>>,
  ownerUrl: string,
  runtimeUrl: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    ...processEnv,
    MIGRATION_DATABASE_URL: ownerUrl,
  };
  if (runtimeUrl) env.DATABASE_URL = runtimeUrl;
  for (const key of PASSTHROUGH_FROM_ENV_LOCAL) {
    if (!processEnv[key] && envLocal[key]) {
      env[key] = envLocal[key];
    }
  }
  return env;
}

interface SnapshotJson {
  runId: string;
  generatedAt: string;
  alertCount: number;
  verdict: string;
  signals: Array<{ name: string; value: string; alert: boolean; severity: string | null }>;
  delivery: { alertLogPath: string; channels: string[]; allDelivered: boolean };
}

export async function runTelemetryWatch(): Promise<number> {
  const startedAt = new Date();
  const envLocal = readEnvLocal();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL || envLocal["MIGRATION_DATABASE_URL"] || "";
  const runtimeUrl = process.env.DATABASE_URL || envLocal["DATABASE_URL"] || "";
  if (!ownerUrl) {
    console.error("MIGRATION_DATABASE_URL yok (ne ortamda ne .env.local'de). Telemetri koşamaz.");
    return 3;
  }
  // Veritabanı ADI güvenle basılabilir; URL parola taşır ve ASLA basılmaz.
  const dbName = (() => { try { return new URL(ownerUrl).pathname.replace(/^\//, ""); } catch { return "(okunamadı)"; } })();
  console.log(`[${startedAt.toISOString()}] MAS telemetri gözetimi — kaynak '${dbName}'`);

  mkdirSync(LOG_DIR, { recursive: true });

  const env = buildWatchSubprocessEnv(process.env, envLocal, ownerUrl, runtimeUrl);

  let snapshotCode = 0;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", SNAPSHOT, "--json", JSON_OUT], {
      cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    snapshotCode = err.status ?? 3;
    stdout = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
  }
  process.stdout.write(stdout);

  let snap: SnapshotJson | null = null;
  try {
    if (existsSync(JSON_OUT)) snap = JSON.parse(readFileSync(JSON_OUT, "utf8")) as SnapshotJson;
  } catch { snap = null; }

  // Anlık görüntü hiç koşamadıysa "sorun yok" DEMEZ: hiçbir şey bilmiyoruz, exit 3.
  if (snap === null) {
    const record = {
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      source_db: dbName, verdict: "SNAPSHOT_UNAVAILABLE", snapshotExit: snapshotCode,
      checks: SCHEDULED_CHECKS.map((c) => ({ check: c.check, verdict: "UNKNOWN" })),
    };
    appendFileSync(RUN_LOG, `${JSON.stringify(record)}\n`, "utf8");
    console.error(`TELEMETRY WATCH: SNAPSHOT UNAVAILABLE (exit ${snapshotCode}) — koşu kaydı: ${RUN_LOG}`);
    return 3;
  }

  const checks = SCHEDULED_CHECKS.map((c) => {
    if (c.signal === null) {
      return { check: c.check, signal: null, verdict: snap.verdict, value: `${snap.alertCount} uyarı` };
    }
    const s = snap.signals.find((x) => x.name === c.signal);
    return {
      check: c.check,
      signal: c.signal,
      verdict: s === undefined ? "MISSING" : s.alert ? "ALERT" : "OK",
      value: s?.value ?? "(sinyal yok)",
    };
  });

  const record = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    source_db: dbName,
    runId: snap.runId,
    verdict: snap.verdict,
    alertCount: snap.alertCount,
    alertingSignals: snap.signals.filter((s) => s.alert).map((s) => ({ name: s.name, severity: s.severity })),
    delivered: snap.delivery.allDelivered,
    channels: snap.delivery.channels,
    alertLog: snap.delivery.alertLogPath,
    snapshotExit: snapshotCode,
    checks,
  };
  appendFileSync(RUN_LOG, `${JSON.stringify(record)}\n`, "utf8");

  console.log("\n── ZAMANLANMIŞ KONTROLLER (rehber §14) ────────────────────────────────");
  for (const c of checks) console.log(`  ${c.verdict.padEnd(20)} ${c.check.padEnd(24)} ${c.value}`);
  console.log(`Koşu kaydı : ${RUN_LOG}`);
  console.log(`Anlık JSON : ${JSON_OUT}`);
  console.log(`Alert log  : ${snap.delivery.alertLogPath}`);

  if (!snap.delivery.allDelivered) {
    console.error("TELEMETRY WATCH: ALERT DELIVERY FAILED — alarm borusu kırık, uyarılar operatöre ULAŞMIYOR.");
    return 2;
  }
  if (snap.alertCount > 0) {
    console.warn(`TELEMETRY WATCH: ${snap.alertCount} UYARI teslim edildi.`);
    return 1;
  }
  console.log("TELEMETRY WATCH: ALL CLEAR");
  return 0;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  void runTelemetryWatch()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(3);
    });
}
