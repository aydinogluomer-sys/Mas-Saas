// `pnpm dev`, `pnpm start`, `pnpm db:ensure` ve her `tsx scripts/db/ensure.ts && …` zincirinin
// ilk veritabanı halkası: "PostgreSQL ayakta mı?" sorusunu SORAR — hiçbir şeyi kurmaz.
//
// İKİ ÇALIŞMA ZAMANI (scripts/db/pg-native.ts → resolvePgRuntime):
//
//   native (varsayılan, operatör makinesi) — SALT-OKUR YOKLAMA. Kanonik küme yerel PostgreSQL 16
//     (C:\MAS\pgdata16, Windows hizmeti `MAS-PostgreSQL16`; hizmet kurulana kadar oturum açılış
//     görevi `MAS-PostgreSQL16-Oturum-Baslat`). Bağlantı dizesinin host/port'u loopback olmalı;
//     TCP ile yoklanır, pg_isready çözülebiliyorsa ayrıca sorulur. Kapalıysa hizmet durumu
//     okunur ve operatöre TEK, somut bir sonraki adım söylenir. Bu yol hiçbir küme OLUŞTURMAZ,
//     initdb koşturmaz, hiçbir hizmeti başlatmaz ve bağlantı dizesini asla yazdırmaz.
//
//   docker (yalnız CI; ci.yml MAS_PG_RUNTIME=docker ayarlar) — eski davranış, DEĞİŞTİRİLMEDİ:
//     GitHub runner'ında atılabilir `mas-radar-pg` konteynerini yaratır/başlatır ve TCP üzerinden
//     hazır olmasını bekler. Bu dalda görünen parola o atılabilir CI konteynerine aittir.
//
// KATMANIN BIRAKTIĞI BAYPAS KALDIRILDI. 46541d8, `localhost`/`127.0.0.1` alt dizesini içermeyen
// HER URL için (SUPABASE_DB_URL dahil) bu kontrolü sessizce atlıyordu: "harici veritabanı aktif".
// Bulut bağlantısı kesildi; uzak bir host artık atlanmaz, REDDEDİLİR. Tek bilinçli atlama
// `MAS_SKIP_DB_ENSURE=1`dir ve o da yaptığını açıkça yazar.
//
// ÇIKIŞ KODLARI: 0 hazır (ya da bilinçli atlandı) · 1 erişilemiyor / reddedildi · 2 geçersiz
// MAS_PG_RUNTIME.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { asChildProcessEnv, buildToolEnv, parseLoopbackEndpoint, resolvePgBinaries, resolvePgRuntime } from "./pg-native";

const CONTAINER = "mas-radar-pg";

/** Native kümenin Windows hizmeti ve hizmet kurulana kadarki oturum açılış görevi. */
export const PG_SERVICE_NAME = "MAS-PostgreSQL16";
export const PG_LOGON_TASK_NAME = "MAS-PostgreSQL16-Oturum-Baslat";

type EnvLike = Readonly<Record<string, string | undefined>>;

export type EnsureDecision =
  | { action: "skip" }
  | { action: "refuse"; reason: string; exitCode: 1 | 2 }
  | { action: "probe-native"; host: "127.0.0.1" | "::1"; port: number; warnLocalhost: boolean }
  | { action: "docker-legacy" };

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * SAF karar: ortamdan ne yapılacağını söyler, hiçbir şey yapmaz.
 *
 * Native'de URL önce DATABASE_URL'den (uygulamanın kendisi), yoksa MIGRATION_DATABASE_URL'den
 * okunur. İkisi de varsa AYNI sunucuyu (host + port) göstermek zorundadır: yarısı yeniden
 * yönlendirilmiş bir `.env.local` — uygulama bir sunucuda, owner başka birinde — tam da yanlış
 * kümeye migration/yedek uygulatan ayrışmadır. Veritabanı ADININ farklı olması ise meşrudur
 * (doğrulama koşuları owner URL'ini harcanabilir bir veritabanına sabitler) ve yoklanan şey
 * zaten veritabanı değil, sunucudur.
 */
export function decideEnsure(env: EnvLike): EnsureDecision {
  if (env.MAS_SKIP_DB_ENSURE === "1") return { action: "skip" };

  let runtime: "native" | "docker";
  try {
    runtime = resolvePgRuntime(env);
  } catch (err) {
    return { action: "refuse", reason: (err as Error).message, exitCode: 2 };
  }
  if (runtime === "docker") return { action: "docker-legacy" };

  const runtimeUrl = present(env.DATABASE_URL);
  const ownerUrl = present(env.MIGRATION_DATABASE_URL);
  const url = runtimeUrl ?? ownerUrl;
  if (!url) {
    return {
      action: "refuse",
      reason:
        "DATABASE_URL (ya da MIGRATION_DATABASE_URL) tanımlı değil — .env.local'i doldurun " +
        "(örnek: .env.example; host 127.0.0.1, port 5432).",
      exitCode: 1,
    };
  }

  let endpoint: ReturnType<typeof parseLoopbackEndpoint>;
  try {
    endpoint = parseLoopbackEndpoint(url);
  } catch (err) {
    const which = runtimeUrl ? "DATABASE_URL" : "MIGRATION_DATABASE_URL";
    return {
      action: "refuse",
      reason: `${which}: ${(err as Error).message} Bulut bağlantısı kesildi; tek kanonik veritabanı bu makinedeki PostgreSQL 16 kümesidir.`,
      exitCode: 1,
    };
  }

  if (runtimeUrl && ownerUrl) {
    let owner: ReturnType<typeof parseLoopbackEndpoint>;
    try {
      owner = parseLoopbackEndpoint(ownerUrl);
    } catch (err) {
      return { action: "refuse", reason: `MIGRATION_DATABASE_URL: ${(err as Error).message}`, exitCode: 1 };
    }
    if (owner.host !== endpoint.host || owner.port !== endpoint.port) {
      return {
        action: "refuse",
        reason:
          "DATABASE_URL ve MIGRATION_DATABASE_URL farklı sunuculara işaret ediyor (host/port farklı). " +
          "İkisi de aynı yerel kümeyi göstermeli — .env.local yarım güncellenmiş olabilir.",
        exitCode: 1,
      };
    }
  }

  return { action: "probe-native", host: endpoint.host, port: endpoint.port, warnLocalhost: endpoint.wasLocalhost };
}

/** Bir TCP dinleyicisi var mı? Bağlanır, hemen kapatır; hiçbir bayt göndermez. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `attempts` kez yoklar, aralarda `intervalMs` bekler; ilk başarıda döner. */
export async function waitForTcp(
  host: string,
  port: number,
  attempts: number,
  intervalMs: number,
  probe: (host: string, port: number, timeoutMs: number) => Promise<boolean> = probeTcp,
): Promise<boolean> {
  for (let i = 1; i <= attempts; i += 1) {
    if (await probe(host, port, 1000)) return true;
    if (i < attempts) await sleep(intervalMs);
  }
  return false;
}

export type ServiceState = "running" | "stopped" | "missing" | "unknown";

/** `(Get-Service …).Status` çıktısı. Enum adı yerelleştirilmez; boş çıktı = hizmet yok. */
export function parseServiceStatus(output: string): ServiceState {
  const t = output.trim().toLowerCase();
  if (t === "") return "missing";
  if (t === "running") return "running";
  if (t === "stopped") return "stopped";
  return "unknown";
}

/** Hizmet durumunu SALT-OKUR okur. Windows dışında ya da okunamazsa `unknown`. */
function readServiceState(serviceName: string): ServiceState {
  if (process.platform !== "win32" || !/^[A-Za-z0-9._-]{1,64}$/.test(serviceName)) return "unknown";
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue).Status`],
      { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    return parseServiceStatus(out);
  } catch {
    return "unknown";
  }
}

/** Küme kapalıyken operatörün okuyacağı mesaj: durum + TEK somut sonraki adım. */
export function pgDownMessage(i: {
  host: string;
  port: number;
  serviceName: string;
  state: ServiceState;
  logonTaskName?: string;
}): string {
  const task = i.logonTaskName ?? PG_LOGON_TASK_NAME;
  const where = `${i.host === "::1" ? "[::1]" : i.host}:${i.port}`;
  const next: Record<ServiceState, string> = {
    missing:
      `Windows hizmeti '${i.serviceName}' kurulu değil. Kalıcı çözüm: scripts\\ops\\install-postgres-service.ps1 ` +
      "dosyasını YÖNETİCİ olarak açılmış PowerShell'de bir kez çalıştırın. Hizmet kurulana kadar küme oturum " +
      `açılışında '${task}' görevinden başlar; hemen başlatmak için: Start-ScheduledTask -TaskName '${task}'`,
    stopped:
      `'${i.serviceName}' hizmeti kurulu ama DURDURULMUŞ. Yönetici PowerShell'de: Start-Service ${i.serviceName}`,
    running:
      `'${i.serviceName}' hizmeti ÇALIŞIYOR ama ${where} cevap vermiyor: postgresql.conf'taki listen_addresses ve ` +
      "port ayarlarını, C:\\MAS\\pgdata16\\log altındaki son günlüğü ve .env.local'deki portu karşılaştırın.",
    unknown:
      `'${i.serviceName}' hizmetinin durumu okunamadı. Get-Service ${i.serviceName} ile bakın; hizmet yoksa ` +
      "scripts\\ops\\install-postgres-service.ps1 (yönetici).",
  };
  return [
    `PostgreSQL ${where} adresinde bağlantı kabul etmiyor.`,
    next[i.state],
    "Bu komut hiçbir küme OLUŞTURMAZ ve hiçbir hizmeti başlatmaz — yalnız yoklar. Ayrıntı: docs/ops/postgres-service.md",
  ].join("\n");
}

/**
 * TCP açıksa pg_isready'ye de sorar: port açık ama sunucu henüz bağlantı kabul etmiyor olabilir
 * (açılış, kurtarma). pg_isready bulunamazsa TCP cevabı yeterli sayılır — bu bir yoklamadır,
 * yedek değil; araç zinciri eksikliğini günlük yedek kendi ön koşulunda ayrıca yakalar.
 */
async function confirmWithPgIsready(
  host: string,
  port: number,
  env: EnvLike,
): Promise<"ready" | "not-ready" | "unavailable"> {
  let bin: string;
  try {
    bin = resolvePgBinaries(env).pgIsready;
  } catch (err) {
    console.warn(`Uyarı: ${(err as Error).message} — yalnız TCP yoklaması kullanıldı.`);
    return "unavailable";
  }
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      execFileSync(bin, ["-h", host, "-p", String(port), "-t", "5"], {
        env: asChildProcessEnv(buildToolEnv(env)), stdio: "ignore", windowsHide: true, timeout: 15_000,
      });
      return "ready";
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number | null };
      if (e.code === "ENOENT") return "unavailable";
      // 1 = sunucu bağlantıları reddediyor (açılış/kurtarma) → bekle; 2 = cevap yok; 3 = parametre.
      if (e.status === 1 && attempt < 20) {
        await sleep(500);
        continue;
      }
      return e.status === 3 ? "unavailable" : "not-ready";
    }
  }
  return "not-ready";
}

async function ensureNative(d: Extract<EnsureDecision, { action: "probe-native" }>, env: EnvLike): Promise<number> {
  if (d.warnLocalhost) {
    console.warn("Uyarı: bağlantı dizesi 'localhost' kullanıyor — Node onu önce ::1'e çözebilir; 127.0.0.1 yazmanız önerilir.");
  }
  if (await waitForTcp(d.host, d.port, 10, 500)) {
    const ready = await confirmWithPgIsready(d.host, d.port, env);
    if (ready !== "not-ready") {
      console.log(
        `PostgreSQL hazır (native, ${d.host}:${d.port}${ready === "unavailable" ? " — TCP yoklaması; pg_isready kullanılmadı" : ""}).`,
      );
      return 0;
    }
  }
  console.error(pgDownMessage({ host: d.host, port: d.port, serviceName: PG_SERVICE_NAME, state: readServiceState(PG_SERVICE_NAME) }));
  return 1;
}

/* ── docker (yalnız CI) — eski davranış, değiştirilmedi ──────────────────────────────────── */

function docker(args: string[], quiet = false): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker komutu başarısız: docker ${args.join(" ")}\n${detail}`);
  }
}

async function ensureDockerLegacy(): Promise<void> {
try {
  const all = docker(["ps", "-a", "--format", "{{.Names}}"], true).split(/\r?\n/);
  if (!all.includes(CONTAINER)) {
    console.log("PostgreSQL konteyneri oluşturuluyor…");
    docker([
      "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1:5432:5432", "postgres:16",
    ], true);
  }

  const running = docker(["ps", "--format", "{{.Names}}"], true).split(/\r?\n/);
  if (!running.includes(CONTAINER)) {
    console.log("PostgreSQL konteyneri başlatılıyor…");
    docker(["start", CONTAINER], true);
  }

  // Readiness probe MUST go over TCP (-h 127.0.0.1), NOT the default unix socket. The
  // postgres:16 image runs a TEMPORARY server during initdb that listens on the container's
  // unix socket only (listen_addresses=''), so its own setup scripts can reach it while
  // external clients cannot. A socket-based `pg_isready` answers TRUE against that temp server,
  // then the image stops it to start the real one — and in that gap the socket file is deleted.
  // A caller that raced in on that false-positive hits "connection to server on socket ...
  // No such file or directory" and the job dies for a reason unrelated to the code under test
  // (observed on CI: provision-verify-db.sh's dropdb, in the `build` job). The temp server
  // never listens on TCP, so a TCP probe only returns true once the REAL server is up. 60×500ms
  // because we now wait for the full initdb+restart on a fresh container, not just the temp one.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"], { stdio: "ignore" });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error(`PostgreSQL ${CONTAINER} konteynerinde erişilebilir değil.`);
  console.log("PostgreSQL hazır.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error("Docker Desktop'ın kurulu ve çalışıyor olduğundan emin olun.");
  process.exit(1);
}
}

async function main(): Promise<number> {
  // `.env.local` yalnız doğrudan çalıştırmada yüklenir: bu modülü import eden bir test, gerçek
  // bağlantı dizelerini kendi sürecine çekmemeli.
  loadEnvConfig(process.cwd());
  const decision = decideEnsure(process.env);
  switch (decision.action) {
    case "skip":
      console.log("MAS_SKIP_DB_ENSURE=1 — veritabanı yoklaması bilinçli olarak ATLANDI.");
      return 0;
    case "refuse":
      console.error(decision.reason);
      return decision.exitCode;
    case "docker-legacy":
      await ensureDockerLegacy();
      return 0;
    case "probe-native":
      return ensureNative(decision, process.env);
  }
}

/** Doğrudan çalıştırma mı, import mu? Yollar gerçek yollarına (8.3 kısa adlar, sembolik
 * bağlantılar çözülerek), büyük/küçük harften ve URL kodlamasından bağımsız karşılaştırılır: bu
 * script `pnpm dev`/`pnpm start` zincirinin halkasıdır ve yanlış bir "import edildi" kararı
 * yoklamayı SESSİZCE atlatırdı. */
const isDirectRun = (() => {
  const canonical = (p: string): string => {
    try {
      return realpathSync.native(p).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  };
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return canonical(path.resolve(entry)) === canonical(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
