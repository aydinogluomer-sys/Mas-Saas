// AŞAMA 07 Bölüm D — günlük yedeği, telemetri gözetimini ve birleşik arka plan işçisini
// Windows Görev Zamanlayıcı'ya KURAN araç.
//
// "Zamanlama kurulmadı" kabul edilebilir bir cevap değil (rehber §12 Bölüm D). Ama bir
// ajanın kullanıcının makinesine, sormadan, KALICI bir tekrarlayan görev kaydetmesi de
// doğru değil: bu, dışa dönük ve kalıcı bir sistem değişikliğidir.
//
// Bu yüzden araç üç şey yapar ve ÜÇÜNCÜSÜNÜ operatöre bırakır:
//   1. Ön koşulları GERÇEKTEN doğrular (sarmalayıcı .cmd var mı, pnpm bulunuyor mu,
//      görev zaten kayıtlı mı; yedek işi için native PostgreSQL araçları çözülebiliyor mu ve
//      küme dinliyor mu).
//   2. Kaydedilecek KOMUTU birebir üretir ve gösterir (`--what-if`, varsayılan).
//   3. Yalnız `--apply` ile gerçekten `schtasks /Create` çalıştırır.
//
// Kullanım:
//   pnpm exec tsx scripts/ops/schedule-windows.ts status
//   pnpm exec tsx scripts/ops/schedule-windows.ts install            # what-if: kaydetmez
//   pnpm exec tsx scripts/ops/schedule-windows.ts install --apply    # GERÇEKTEN kaydeder
//   pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --apply
//   pnpm exec tsx scripts/ops/schedule-windows.ts run-once           # görevi elle tetikler
//
// Seçenekler: --job backup|telemetry|worker  --name <görev adı>  --at HH:MM
//
// ── FAZ 43 (`B3`): OTURUMSUZ (`S4U`) KAYIT VE BİRLEŞİK ARKA PLAN İŞÇİSİ (`worker`) ───────
//
// `schtasks /Create` varsayılan olarak görevi `InteractiveToken` ile kaydediyordu: sunucu yeniden
// başladığında veya operatör oturumu kilitli/kapalı olduğunda gece 03:00 yedeği, telemetri gözetimi
// ve arka plan işçisi hiç başlamıyordu. `buildSettingsCommand` artık ayarlarla birlikte
// `New-ScheduledTaskPrincipal -LogonType S4U -RunLevel Limited` uygular; görev parola saklamadan
// masaüstü oturumu açık olmasa bile çalışır.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readEnvLocal } from "../db/app-url";
import { withPgRuntimeConfig } from "../db/backup-adapter";
import {
  asChildProcessEnv, buildToolEnv, parseLoopbackEndpoint, resolvePgBinaries, resolvePgRuntime,
} from "../db/pg-native";

/** Ön koşulun ortamda aranışı. `alsoEnvLocal`: işin kendisi değeri `.env.local`'den de okuyor. */
interface AdvisoryEnv {
  name: string;
  envs: string[];
  alsoEnvLocal: boolean;
  /** Değer ASLA yazdırılmaz — yalnız var/yok (token, chat id). */
  presenceOnly: boolean;
  missingNote: string;
}

/** Zamanlanabilir işler. Her biri kendi sarmalayıcı .cmd'sini ve periyodunu taşır. */
interface JobDefinition {
  key: string;
  taskName: string;
  /** scripts/ops/ altındaki sarmalayıcı dosya adı. */
  wrapperFile: string;
  /** Sarmalayıcının çalıştırdığı TypeScript işi — ön koşul denetimi için. */
  jobScript: string;
  defaultTime: string;
  /** schtasks periyot argümanları. Yedek günlük; telemetri 6 saatte bir; worker 5 dk gözetimli. */
  scheduleArgs: string[];
  humanSchedule: (time: string) => string;
  /** İş native PostgreSQL araçlarını (pg_dump/pg_restore/psql) çalıştırıyor mu. */
  requiresPgTools: boolean;
  /** Yalnız bu iş için anlamlı olan, engelleyici SAYILMAYAN ön koşullar. */
  advisoryEnv: AdvisoryEnv[];
}

const JOBS: Record<string, JobDefinition> = {
  backup: {
    key: "backup",
    taskName: "MAS-Nakit-Radar-Gunluk-Yedek",
    wrapperFile: "mas-daily-backup.cmd",
    jobScript: "scripts/ops/backup-daily.ts",
    defaultTime: "03:00",
    scheduleArgs: ["/SC", "DAILY"],
    humanSchedule: (t) => `her gün ${t} (yerel saat, S4U oturumsuz)`,
    requiresPgTools: true,
    advisoryEnv: [{
      name: "MAS_OFFDEVICE_BACKUP_DIR ayarlı (off-device kopya için)",
      envs: ["MAS_OFFDEVICE_BACKUP_DIR"],
      // Faz 43: backup-daily.ts artık süreç ortamında yoksa .env.local'den de okur.
      alsoEnvLocal: true,
      presenceOnly: false,
      missingNote: "ayarlı değil — görev exit 3 ile 'TEK KOPYA' uyarısı verecek",
    }],
  },
  telemetry: {
    key: "telemetry",
    taskName: "MAS-Nakit-Radar-Telemetri-Gozetim",
    wrapperFile: "mas-telemetry-watch.cmd",
    jobScript: "scripts/ops/telemetry-watch.ts",
    defaultTime: "07:00",
    scheduleArgs: ["/SC", "HOURLY", "/MO", "6"],
    humanSchedule: (t) => `${t}'den itibaren 6 saatte bir (yerel saat, S4U oturumsuz)`,
    requiresPgTools: false,
    advisoryEnv: [
      {
        name: "MAS_ALERT_CHANNELS ayarlı (ek operatör kanalı; telegram = sahibin sohbeti)",
        envs: ["MAS_ALERT_CHANNELS"],
        alsoEnvLocal: true,
        presenceOnly: false,
        missingNote: "ayarlı değil — yalnız yerel kalıcı alert log'una yazılır (birincil kanal, her zaman çalışır)",
      },
      {
        name: "TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID tanımlı (telegram kanalı için)",
        envs: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
        alsoEnvLocal: true,
        presenceOnly: true,
        missingNote: "eksik — MAS_ALERT_CHANNELS=telegram olsa bile alarm Telegram'a gidemez (teslimat hatası günlüğe yazılır)",
      },
    ],
  },
  worker: {
    key: "worker",
    taskName: "MAS-Background-Worker",
    wrapperFile: "mas-background-worker.cmd",
    jobScript: "scripts/ops/background-worker.ts",
    defaultTime: "00:00",
    scheduleArgs: ["/SC", "MINUTE", "/MO", "5"],
    humanSchedule: () => "5 dakikada bir gözetim (S4U oturumsuz + tekil süreç kilidi)",
    requiresPgTools: false,
    advisoryEnv: [],
  },
};

function resolveJob(key: string | undefined): JobDefinition {
  const job = JOBS[(key ?? "backup").toLowerCase()];
  if (!job) throw new Error(`--job bilinmiyor: '${key}'. Beklenen: ${Object.keys(JOBS).join(" | ")}`);
  return job;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

export interface ScheduleSpec {
  job: JobDefinition;
  taskName: string;
  time: string;
  wrapperPath: string;
  /** schtasks'a verilecek argüman dizisi (kabuk yorumu yok — tırnak kaçışı derdi de yok). */
  createArgs: string[];
  /** İnsanın kopyalayıp yapıştırabileceği hâli. */
  createCommand: string;
}

export function buildScheduleSpec(
  repoRoot: string,
  taskName?: string,
  time?: string,
  jobKey = "backup",
): ScheduleSpec {
  const job = resolveJob(jobKey);
  const at = time ?? job.defaultTime;
  if (!/^\d{2}:\d{2}$/.test(at)) throw new Error(`--at biçimi HH:MM olmalı: '${at}'`);
  const wrapperPath = path.join(repoRoot, "scripts", "ops", job.wrapperFile);
  const createArgs = [
    "/Create",
    "/TN", taskName ?? job.taskName,
    "/TR", `"${wrapperPath}"`,
    ...job.scheduleArgs,
    "/ST", at,
    // /RL LIMITED: görev yönetici hakları İSTEMEZ. Yedek almak için gerekmiyor; gereksiz
    // yükseltme, zamanlanmış bir görevin en kolay kötüye kullanılan yanıdır.
    "/RL", "LIMITED",
    "/F",
  ];
  return {
    job,
    taskName: taskName ?? job.taskName,
    time: at,
    wrapperPath,
    createArgs,
    createCommand: `schtasks ${createArgs.map((a) => (a.includes(" ") && !a.startsWith('"') ? `"${a}"` : a)).join(" ")}`,
  };
}

/**
 * Görev adı PowerShell komutuna tek tırnak içinde girer; `--name` kullanıcı girdisidir. Tırnak,
 * `;` ya da boşluk taşıyan bir ad komuta dönüşebilirdi — bu yüzden dar bir desen, yoksa RED.
 */
const TASK_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function assertTaskName(taskName: string): void {
  if (!TASK_NAME_PATTERN.test(taskName)) {
    throw new Error(`Görev adı ${JSON.stringify(taskName.slice(0, 80))} kabul edilmiyor (yalnız harf, rakam, '.', '_', '-'; en çok 64).`);
  }
}

/**
 * Kayıttan SONRA uygulanacak ayarlar — tek PowerShell çağrısının argümanları (bkz. dosya başlığı).
 * StartWhenAvailable: kaçırılan tetikleme makine açılınca telafi edilir. ExecutionTimeLimit 2 saat
 * (sürekli çalışan `MAS-Background-Worker` için sınırsız `[TimeSpan]::Zero`): takılan bir koşu
 * sonraki geceleri bloke etmez. IgnoreNew: aynı anda iki koşu olmaz. LogonType S4U: masaüstü
 * oturumu açık olmadan da (sunucu yeniden başlatması sonrası) görev çalışır.
 */
export function buildSettingsCommand(taskName: string): string[] {
  assertTaskName(taskName);
  const timeLimitExpr =
    taskName === JOBS.worker.taskName ? "([TimeSpan]::Zero)" : "(New-TimeSpan -Hours 2)";
  return [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; " +
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ${timeLimitExpr} ` +
      "-MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; " +
      "$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) " +
      "-LogonType S4U -RunLevel Limited; " +
      `Set-ScheduledTask -TaskName '${taskName}' -Settings $s -Principal $p | Out-Null`,
  ];
}

/** `status` için SALT-OKUR ayrıntı: oturum türü, sertleştirilmiş ayarlar, son sonuç. */
export function buildStatusDetailCommand(taskName: string): string[] {
  assertTaskName(taskName);
  return [
    "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; " +
      `$t = Get-ScheduledTask -TaskName '${taskName}'; $i = $t | Get-ScheduledTaskInfo; ` +
      "\"LogonType=$($t.Principal.LogonType)\"; \"RunLevel=$($t.Principal.RunLevel)\"; " +
      "\"StartWhenAvailable=$($t.Settings.StartWhenAvailable)\"; " +
      "\"ExecutionTimeLimit=$($t.Settings.ExecutionTimeLimit)\"; " +
      "\"MultipleInstances=$($t.Settings.MultipleInstances)\"; " +
      "\"LastTaskResult=$($i.LastTaskResult)\"; \"LastRunTime=$($i.LastRunTime)\"; \"NextRunTime=$($i.NextRunTime)\"",
  ];
}

function schtasks(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("schtasks", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
  }
}

function powershell(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("powershell", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, windowsHide: true,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
}

function taskExists(taskName: string): boolean {
  return schtasks(["/Query", "/TN", taskName]).code === 0;
}

function pnpmFound(): string | null {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command pnpm).Source"], {
      encoding: "utf8", timeout: 20000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface Precheck { name: string; ok: boolean; detail: string; advisory?: boolean }

function envLocalOrEmpty(): Record<string, string> {
  try {
    return readEnvLocal();
  } catch {
    return {};
  }
}

function pgToolPrechecks(fileEnv: Record<string, string>): Precheck[] {
  const list: Precheck[] = [];
  const cfg = withPgRuntimeConfig(process.env, fileEnv);
  let runtime: string;
  try {
    runtime = resolvePgRuntime(cfg);
  } catch (err) {
    list.push({ name: "MAS_PG_RUNTIME native", ok: false, detail: (err as Error).message });
    return list;
  }
  if (runtime !== "native") {
    list.push({
      name: "MAS_PG_RUNTIME native",
      ok: false,
      detail: `'${runtime}' — bu makinede Docker yok; yedek görevi native PostgreSQL 16 araçlarıyla koşar`,
    });
    return list;
  }
  let pgDumpVersion: string | null = null;
  let bins: ReturnType<typeof resolvePgBinaries> | null = null;
  let detail: string;
  try {
    bins = resolvePgBinaries(cfg);
    pgDumpVersion = execFileSync(bins.pgDump, ["--version"], {
      encoding: "utf8", env: asChildProcessEnv(buildToolEnv(cfg)), timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    detail = `${pgDumpVersion} (${bins.origin}${bins.dir ? `: ${bins.dir}` : ""})`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    detail = code === "ENOENT"
      ? "pg_dump bulunamadı — MAS_PG_BIN_DIR ayarlayın (ör. C:\\MAS\\pgsql16\\bin)"
      : (err as Error).message.split(/\r?\n/)[0];
  }
  list.push({
    name: "native PostgreSQL 16 araçları çözülebiliyor (MAS_PG_BIN_DIR veya PATH; pg_dump --version)",
    ok: pgDumpVersion !== null,
    detail,
  });

  let host = "127.0.0.1";
  let port = 5432;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL || fileEnv["MIGRATION_DATABASE_URL"] || "";
  try {
    if (ownerUrl) ({ host, port } = parseLoopbackEndpoint(ownerUrl));
  } catch {
    list.push({
      advisory: true, name: "MIGRATION_DATABASE_URL bu makineyi gösteriyor", ok: false,
      detail: "loopback değil ya da ayrıştırılamadı — görev kaynak kapısında exit 1 verecek",
    });
  }
  let listening = "ölçülemedi (pg_isready yok)";
  let listenOk = false;
  if (bins) {
    try {
      execFileSync(bins.pgIsready, ["-h", host, "-p", String(port), "-t", "3"], {
        env: asChildProcessEnv(buildToolEnv(cfg)), timeout: 15_000, windowsHide: true, stdio: "ignore",
      });
      listening = "bağlantı kabul ediyor";
      listenOk = true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number | null };
      listening = e.code === "ENOENT" ? "ölçülemedi (pg_isready yok)" : `cevap yok (pg_isready exit ${e.status ?? "?"})`;
    }
  }
  list.push({ advisory: true, name: `PostgreSQL ${host}:${port} dinliyor`, ok: listenOk, detail: listening });
  return list;
}

function prechecks(spec: ScheduleSpec): Precheck[] {
  const list: Precheck[] = [];
  const fileEnv = envLocalOrEmpty();
  list.push({
    name: "platform Windows",
    ok: process.platform === "win32",
    detail: process.platform,
  });
  list.push({
    name: "sarmalayıcı .cmd mevcut",
    ok: existsSync(spec.wrapperPath),
    detail: spec.wrapperPath,
  });
  list.push({
    name: "iş script'i mevcut",
    ok: existsSync(path.join(process.cwd(), spec.job.jobScript)),
    detail: spec.job.jobScript,
  });
  const pnpm = pnpmFound();
  list.push({ name: "pnpm PATH'te bulunuyor", ok: pnpm !== null, detail: pnpm ?? "bulunamadı" });
  const envLocal = path.join(process.cwd(), ".env.local");
  list.push({
    name: ".env.local var (bağlantı görevden okunacak)",
    ok: existsSync(envLocal),
    detail: existsSync(envLocal) ? ".env.local" : "yok — görev MIGRATION_DATABASE_URL bulamaz",
  });
  if (spec.job.requiresPgTools) list.push(...pgToolPrechecks(fileEnv));
  for (const advisory of spec.job.advisoryEnv) {
    const sources = advisory.envs.map((env) => {
      if (process.env[env]) return { env, from: "ortam", value: process.env[env] as string };
      if (advisory.alsoEnvLocal && fileEnv[env]) return { env, from: ".env.local", value: fileEnv[env] };
      return { env, from: null, value: null };
    });
    const ok = sources.every((s) => s.from !== null);
    const detail = ok
      ? sources.map((s) => (advisory.presenceOnly ? `${s.env} ayarlı (${s.from})` : `${s.value} (${s.from})`)).join(", ")
      : advisory.missingNote;
    list.push({ name: advisory.name, ok, detail, advisory: true });
  }
  list.push({
    advisory: true,
    name: "görev zaten kayıtlı mı",
    ok: true,
    detail: taskExists(spec.taskName) ? `EVET — '${spec.taskName}' var (install üzerine yazar)` : "hayır",
  });
  return list;
}

export function positionalArgs(argv: readonly string[] = process.argv): string[] {
  const FLAGS_WITH_VALUE = new Set(["--name", "--at", "--job"]);
  const out: string[] = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) { i += 1; continue; }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

export function main(): number {
  const action = (positionalArgs()[0] ?? "status").toLowerCase();
  const apply = process.argv.includes("--apply");
  const spec = buildScheduleSpec(process.cwd(), arg("--name"), arg("--at"), arg("--job"));

  console.log(`İş          : ${spec.job.key}`);
  console.log(`Görev adı   : ${spec.taskName}`);
  console.log(`Çalıştırır  : ${spec.wrapperPath}`);
  console.log(`Zamanlama   : ${spec.job.humanSchedule(spec.time)}`);
  console.log("");

  if (action === "status") {
    const q = schtasks(["/Query", "/TN", spec.taskName, "/FO", "LIST", "/V"]);
    if (q.code === 0) {
      const interesting = q.out.split(/\r?\n/).filter((l) =>
        /TaskName|Next Run Time|Status|Last Run Time|Last Result|Schedule Type|Start Time|Task To Run|Görev|Sonraki|Durum|Son Ç/i.test(l));
      console.log("KAYITLI. İlgili satırlar:");
      for (const line of interesting) console.log(`  ${line.trim()}`);
      if (TASK_NAME_PATTERN.test(spec.taskName)) {
        const detail = powershell(buildStatusDetailCommand(spec.taskName));
        if (detail.code === 0) {
          console.log("Görev ayarları:");
          for (const line of detail.out.split(/\r?\n/).filter(Boolean)) console.log(`  ${line.trim()}`);
          console.log(/StartWhenAvailable=True/i.test(detail.out)
            ? "AYARLAR SERTLEŞTİRİLMİŞ (StartWhenAvailable açık)"
            : "AYARLAR SERTLEŞTİRİLMEMİŞ — 'install --apply' ile yeniden kaydedin");
        } else {
          console.log(`Görev ayarları okunamadı: ${detail.out.split(/\r?\n/)[0] ?? ""}`);
        }
      }
      console.log("\nSCHEDULED TASK = REGISTERED");
      return 0;
    }
    console.log(`KAYITLI DEĞİL (schtasks /Query exit ${q.code}).`);
    console.log("SCHEDULED TASK = NOT REGISTERED");
    return 0;
  }

  if (action === "install") {
    const checks = prechecks(spec);
    console.log("Ön koşullar:");
    for (const c of checks) console.log(`  ${c.ok ? "OK  " : "EKSİK"}  ${c.name} — ${c.detail}`);
    const blocking = checks.filter((c) => !c.ok && c.advisory !== true);
    console.log("");
    console.log("Kaydedilecek komut (birebir):");
    console.log(`  ${spec.createCommand}`);
    console.log("Kayıttan sonra uygulanacak ayarlar: LogonType S4U, StartWhenAvailable, MultipleInstances IgnoreNew");
    console.log("");
    if (!apply) {
      console.log("WHAT-IF — hiçbir görev KAYDEDİLMEDİ.");
      console.log("Zamanlanmış görev kalıcı ve dışa dönük bir sistem değişikliğidir; kaydı");
      console.log("operatör açıkça ister: yukarıdaki komutu çalıştırın ya da");
      console.log(`  pnpm exec tsx scripts/ops/schedule-windows.ts install --job ${spec.job.key} --apply`);
      console.log(`SCHEDULED TASK = NOT REGISTERED (what-if ${blocking.length === 0 ? "ön koşullar TAM" : "ön koşullar EKSİK"})`);
      return blocking.length === 0 ? 0 : 1;
    }
    if (blocking.length > 0) {
      console.error(`Ön koşullar eksik (${blocking.map((c) => c.name).join(", ")}) — kayıt yapılmadı.`);
      return 1;
    }
    const created = schtasks(spec.createArgs);
    console.log(created.out.trim());
    if (created.code !== 0) {
      console.log(`KAYIT BAŞARISIZ (exit ${created.code})`);
      return created.code;
    }
    console.log("SCHEDULED TASK = REGISTERED");
    let settingsArgs: string[];
    try {
      settingsArgs = buildSettingsCommand(spec.taskName);
    } catch (err) {
      console.error(`SETTINGS NOT HARDENED — ${(err as Error).message} Görev kayıtlı kaldı.`);
      return 1;
    }
    const hardened = powershell(settingsArgs);
    if (hardened.code !== 0) {
      console.error(`SETTINGS NOT HARDENED — Set-ScheduledTask başarısız (exit ${hardened.code}): ${hardened.out.split(/\r?\n/)[0] ?? ""}`);
      console.error("Görev KAYITLI kaldı ama Windows varsayılanlarıyla (kaçırılan koşu telafi edilmez). 'status' ile bakın.");
      return 1;
    }
    console.log("SETTINGS HARDENED — LogonType S4U, StartWhenAvailable, MultipleInstances IgnoreNew");
    return 0;
  }

  if (action === "uninstall") {
    if (!apply) {
      console.log(`WHAT-IF — kaldırılacak komut:\n  schtasks /Delete /TN ${spec.taskName} /F`);
      console.log(`Görev şu an: ${taskExists(spec.taskName) ? "KAYITLI" : "kayıtlı değil"}`);
      return 0;
    }
    const del = schtasks(["/Delete", "/TN", spec.taskName, "/F"]);
    console.log(del.out.trim());
    console.log(del.code === 0 ? "SCHEDULED TASK = REMOVED" : `KALDIRMA BAŞARISIZ (exit ${del.code})`);
    return del.code;
  }

  if (action === "run-once") {
    if (!taskExists(spec.taskName)) {
      console.error("Görev kayıtlı değil — önce install --apply.");
      return 1;
    }
    if (!apply) {
      console.log(`WHAT-IF — tetiklenecek komut:\n  schtasks /Run /TN ${spec.taskName}`);
      return 0;
    }
    const run = schtasks(["/Run", "/TN", spec.taskName]);
    console.log(run.out.trim());
    return run.code;
  }

  console.error(`Bilinmeyen eylem: '${action}'. Beklenen: status | install | uninstall | run-once`);
  return 1;
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
