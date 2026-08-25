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
// Seçenekler: --name <görev adı> --at HH:MM
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TASK_NAME = "MAS-Nakit-Radar-Gunluk-Yedek";
const DEFAULT_TIME = "03:00";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

export interface ScheduleSpec {
  taskName: string;
  time: string;
  wrapperPath: string;
  /** schtasks'a verilecek argüman dizisi (kabuk yorumu yok — tırnak kaçışı derdi de yok). */
  createArgs: string[];
  /** İnsanın kopyalayıp yapıştırabileceği hâli. */
  createCommand: string;
}

export function buildScheduleSpec(repoRoot: string, taskName = DEFAULT_TASK_NAME, time = DEFAULT_TIME): ScheduleSpec {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`--at biçimi HH:MM olmalı: '${time}'`);
  const wrapperPath = path.join(repoRoot, "scripts", "ops", "mas-daily-backup.cmd");
  const createArgs = [
    "/Create",
    "/TN", taskName,
    "/TR", `"${wrapperPath}"`,
    "/SC", "DAILY",
    "/ST", time,
    // /RL LIMITED: görev yönetici hakları İSTEMEZ. Yedek almak için gerekmiyor; gereksiz
    // yükseltme, zamanlanmış bir görevin en kolay kötüye kullanılan yanıdır.
    "/RL", "LIMITED",
    "/F",
  ];
  return {
    taskName,
    time,
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

interface Precheck { name: string; ok: boolean; detail: string }

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
    name: "günlük yedek script'i mevcut",
    ok: existsSync(path.join(process.cwd(), "scripts", "ops", "backup-daily.ts")),
    detail: "scripts/ops/backup-daily.ts",
  });
  const pnpm = pnpmFound();
  list.push({ name: "pnpm PATH'te bulunuyor", ok: pnpm !== null, detail: pnpm ?? "bulunamadı" });
  const envLocal = path.join(process.cwd(), ".env.local");
  list.push({
    name: ".env.local var (bağlantı görevden okunacak)",
    ok: existsSync(envLocal),
    detail: existsSync(envLocal) ? ".env.local" : "yok — görev MIGRATION_DATABASE_URL bulamaz",
  });
  const offDevice = process.env.MAS_OFFDEVICE_BACKUP_DIR;
  list.push({
    name: "MAS_OFFDEVICE_BACKUP_DIR ayarlı (off-device kopya için)",
    ok: Boolean(offDevice),
    detail: offDevice ?? "ayarlı değil — görev exit 3 ile 'TEK KOPYA' uyarısı verecek",
  });
  list.push({
    name: "görev zaten kayıtlı mı",
    ok: true,
    detail: taskExists(spec.taskName) ? `EVET — '${spec.taskName}' var (install üzerine yazar)` : "hayır",
  });
  return list;
}

export function main(): number {
  const action = (process.argv[2] ?? "status").toLowerCase();
  const apply = process.argv.includes("--apply");
  const spec = buildScheduleSpec(process.cwd(), arg("--name") ?? DEFAULT_TASK_NAME, arg("--at") ?? DEFAULT_TIME);

  console.log(`Görev adı   : ${spec.taskName}`);
  console.log(`Çalıştırır  : ${spec.wrapperPath}`);
  console.log(`Zamanlama   : her gün ${spec.time} (yerel saat)`);
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
    const blocking = checks.filter((c) => !c.ok && !c.name.startsWith("MAS_OFFDEVICE"));
    console.log("");
    console.log("Kaydedilecek komut (birebir):");
    console.log(`  ${spec.createCommand}`);
    console.log("");
    if (!apply) {
      console.log("WHAT-IF — hiçbir görev KAYDEDİLMEDİ.");
      console.log("Zamanlanmış görev kalıcı ve dışa dönük bir sistem değişikliğidir; kaydı");
      console.log("operatör açıkça ister: yukarıdaki komutu çalıştırın ya da");
      console.log("  pnpm exec tsx scripts/ops/schedule-windows.ts install --apply");
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
