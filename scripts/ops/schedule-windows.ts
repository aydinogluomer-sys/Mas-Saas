// AŞAMA 07 Bölüm D — günlük yedeği Windows Görev Zamanlayıcı'ya KURAN araç.
//
// "Zamanlama kurulmadı" kabul edilebilir bir cevap değil (rehber §12 Bölüm D). Ama bir
// ajanın kullanıcının makinesine, sormadan, KALICI bir tekrarlayan görev kaydetmesi de
// doğru değil: bu, dışa dönük ve kalıcı bir sistem değişikliğidir.
//
// Bu yüzden araç üç şey yapar ve ÜÇÜNCÜSÜNÜ operatöre bırakır:
//   1. Ön koşulları GERÇEKTEN doğrular (sarmalayıcı .cmd var mı, pnpm bulunuyor mu,
//      görev zaten kayıtlı mı, kaynak DB erişilebilir mi).
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
// Seçenekler: --job backup|telemetry  --name <görev adı>  --at HH:MM
//
// ── AŞAMA 09: İKİNCİ İŞ ─────────────────────────────────────────────────────────────────
//
// Rehber §14 "Schedule" telemetri anlık görüntüsünün, yedek-yaşı, bayat-veri ve kuyruk
// kontrollerinin belirli periyotla koşmasını istiyor. Bunun için İKİNCİ bir zamanlayıcı aracı
// yazılmadı: aynı what-if/apply disiplinini ikinci kez yazmak, ikinci kez yanlış yazma fırsatı
// demektir. Araç `--job` ile parametrelendi; VARSAYILAN `backup` olarak KALDI, çünkü Aşama 07
// kanıtı ve `release:stage07-backup-gate` bu aracı bayraksız çağırıyor.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Zamanlanabilir işler. Her biri kendi sarmalayıcı .cmd'sini ve periyodunu taşır. */
interface JobDefinition {
  key: string;
  taskName: string;
  /** scripts/ops/ altındaki sarmalayıcı dosya adı. */
  wrapperFile: string;
  /** Sarmalayıcının çalıştırdığı TypeScript işi — ön koşul denetimi için. */
  jobScript: string;
  defaultTime: string;
  /** schtasks periyot argümanları. Yedek günlük; telemetri 6 saatte bir. */
  scheduleArgs: string[];
  humanSchedule: (time: string) => string;
  /** Yalnız bu iş için anlamlı olan, engelleyici SAYILMAYAN ön koşullar. */
  advisoryEnv: Array<{ name: string; env: string; missingNote: string }>;
}

const JOBS: Record<string, JobDefinition> = {
  backup: {
    key: "backup",
    taskName: "MAS-Nakit-Radar-Gunluk-Yedek",
    wrapperFile: "mas-daily-backup.cmd",
    jobScript: "scripts/ops/backup-daily.ts",
    defaultTime: "03:00",
    scheduleArgs: ["/SC", "DAILY"],
    humanSchedule: (t) => `her gün ${t} (yerel saat)`,
    advisoryEnv: [{
      name: "MAS_OFFDEVICE_BACKUP_DIR ayarlı (off-device kopya için)",
      env: "MAS_OFFDEVICE_BACKUP_DIR",
      missingNote: "ayarlı değil — görev exit 3 ile 'TEK KOPYA' uyarısı verecek",
    }],
  },
  telemetry: {
    key: "telemetry",
    taskName: "MAS-Nakit-Radar-Telemetri-Gozetim",
    wrapperFile: "mas-telemetry-watch.cmd",
    jobScript: "scripts/ops/telemetry-watch.ts",
    defaultTime: "07:00",
    // Günde bir telemetri, takılı bir kuyruğu 24 saat görmeden bırakır — kuyruk süpürücüsü 30
    // dakikada bir koşuyor. 6 saat, "alarm zamanında görülsün" ile "bildirim gürültüsü olmasın"
    // arasındaki kasıtlı orta nokta; ilk koşu --at ile verilen saatte başlar.
    scheduleArgs: ["/SC", "HOURLY", "/MO", "6"],
    humanSchedule: (t) => `${t}'den itibaren 6 saatte bir (yerel saat)`,
    advisoryEnv: [{
      name: "MAS_ALERT_CHANNELS ayarlı (ek operatör kanalı)",
      env: "MAS_ALERT_CHANNELS",
      missingNote: "ayarlı değil — yalnız yerel kalıcı alert log'una yazılır (birincil kanal, her zaman çalışır)",
    }],
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

function schtasks(args: string[]): { code: number; out: string } {
  try {
    // stderr YAKALANIR, ebeveyne akıtılmaz: "görev bulunamadı" normal bir cevaptır ve
    // ham bir ERROR satırı olarak görünmesi raporu okuyanı yanıltır.
    const out = execFileSync("schtasks", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
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

function prechecks(spec: ScheduleSpec): Precheck[] {
  const list: Precheck[] = [];
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
  for (const advisory of spec.job.advisoryEnv) {
    const value = process.env[advisory.env];
    list.push({ name: advisory.name, ok: Boolean(value), detail: value ?? advisory.missingNote, advisory: true });
  }
  list.push({
    advisory: true,
    name: "görev zaten kayıtlı mı",
    ok: true,
    detail: taskExists(spec.taskName) ? `EVET — '${spec.taskName}' var (install üzerine yazar)` : "hayır",
  });
  return list;
}

/**
 * Eylemi argv'den POZİSYONEL olarak okur, `process.argv[2]`'den değil.
 *
 * Neden: `package.json`'daki `ops:telemetry:schedule` bayrağı komuta ÖNDEN ekliyor
 * (`… schedule-windows.ts --job telemetry status`), dolayısıyla argv[2] = "--job" oluyordu ve
 * araç "Bilinmeyen eylem: '--job'" diyerek her çağrıda düşüyordu. Değer alan bayraklar
 * atlanır, `--apply` gibi salt bayraklar da öyle; geriye yalnız eylem kalır.
 */
function positionalArgs(): string[] {
  const FLAGS_WITH_VALUE = new Set(["--name", "--at", "--job"]);
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
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
    // advisory = eksikliği kaydı ENGELLEMEZ ama çıktıda görünür (off-device hedefi, ek kanal).
    const blocking = checks.filter((c) => !c.ok && c.advisory !== true);
    console.log("");
    console.log("Kaydedilecek komut (birebir):");
    console.log(`  ${spec.createCommand}`);
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
    console.log(created.code === 0 ? "SCHEDULED TASK = REGISTERED" : `KAYIT BAŞARISIZ (exit ${created.code})`);
    return created.code;
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
