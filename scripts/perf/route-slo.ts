// AŞAMA 10 — HTTP rota SLO + rota başına DB sorgu muhasebesi.
//
// ═══ HANGİ BOŞLUĞU KAPATIYOR ═══
//
// `perf:gate` (Faz 14) sorgu PLANINI ve indeks hijyenini kapılıyor; `perf:measure` view
// sürelerini ölçüyor; `scripts/measure-navigation.ts` TARAYICI tarafındaki tıklama geri
// bildirimini ölçüyor. Hiçbiri şu soruyu sormuyor: bir kullanıcı /overview'a girdiğinde
// SUNUCU ilk baytı kaç ms'de veriyor, tam yanıt kaç ms sürüyor ve o tek istek arkada KAÇ
// sorgu atıyor. Rehber §15'in "Eksik 1" ve "Eksik 2" maddesi tam olarak bu.
//
// ═══ NEDEN TARAYICI DEĞİL, DÜZ HTTP ═══
//
// Üç ölçülmüş neden:
//
//   1. PREFETCH. Next, /overview yerleştikten sonra kenar çubuğundaki bütün <Link> hedeflerini
//      prefetch eder. Bir tarayıcıyla ölçülen "/cashflow kaç sorgu attı" sayısı, o sırada arka
//      planda render edilen ÜÇ BAŞKA rotanın sorgularını da içerir. Ölçüm değil, gürültü.
//   2. BELLEK. Bu makinede ölçüm anında 1.07 GB boş RAM vardı. Chromium'u Next sunucusuyla
//      yan yana koşturmak, ölçülen gecikmeye ölçüm aracının kendi baskısını katar.
//   3. SORU BU DEĞİL. "main visible / interactive control enabled" tarayıcı sorusudur ve
//      Playwright ile `tests/visual/interactive-readiness.spec.ts`'te ölçülür (Eksik 3).
//      Burada ölçülen şey sunucunun kendisidir.
//
// ═══ EŞİK POLİTİKASI (rehber §15 "Threshold") ═══
//
// "Hard deterministic correctness threshold ile wall-clock performance threshold ayrılmalıdır."
// Bu dosya o ayrımı somutlaştırır:
//
//   SERT KAPI (deterministik, makineden bağımsız):
//     - her rota her örneklemde HTTP 200 döner (307/5xx = kırık, yavaş değil)
//     - rota başına query_count ölçülen tabanı aşmaz  → N+1 regresyon dedektörü
//     - aynı rotanın query_count'u örneklemler arasında OYNAMAZ (deterministik render)
//     - felaket tavanı: bir rota TOPLAM yanıtı CATASTROPHE_MS'i aşarsa kırıktır
//   TREND UYARISI (wall-clock, ortama duyarlı):
//     - TTFB ve toplam süre bütçeleri. Aşılırsa UYARI + trend kaydı; exit kodu DEĞİŞMEZ.
//       Bu makine 4 çekirdekli bir 2018 dizüstü (i5-8265U) ve ölçüm sırasında port 3000'de
//       canlı bir production örneği + Postgres + Supabase konteynerleri koşuyordu. Böyle bir
//       sayıyı CI'da sert kapı yapmak, ürünü runner'ın havasına göre kırmızıya düşürmektir.
//
// ═══ GÜVENLİK ═══
//
//   - Hedef HARCANABİLİR olmalıdır (`requireDisposableOwnerDatabaseUrl`). `mas_radar_dev`
//     bu script tarafından ne okunur ne yazılır.
//   - `pnpm db:app-role:password` ÇAĞRILMAZ; app bağlantısı `.env.local`'in mevcut
//     kimliğinden YALNIZ veritabanı adı değiştirilerek türetilir (scripts/db/app-url.ts).
//   - Hiçbir bağlantı dizesi, parola veya SQL PARAMETRE DEĞERİ yazdırılmaz. Sorgu bilgisi
//     yalnız fingerprint (şekil) olarak gelir — `src/lib/perf/request-metrics.ts`.
//   - Canlı `.next` EZİLMEZ: derleme ayrı bir `MAS_NEXT_DIST_DIR`'e yapılır. Script yalnız
//     KENDİ başlattığı sunucuyu öldürür; port 3000'e dokunmaz ve kapı öncesi/sonrası
//     sağlığını kaydeder.
//
// Kullanım:
//   MIGRATION_DATABASE_URL=postgres://…@127.0.0.1:5432/mas_radar_perf_verify pnpm perf:route-slo
//
// Ortam: ROUTE_SLO_PORT (3280), ROUTE_SLO_DIST_DIR (.next-stage10-perf), ROUTE_SLO_SAMPLES (12),
//        ROUTE_SLO_SKIP_BUILD, ROUTE_SLO_TTFB_BUDGET_MS, ROUTE_SLO_TOTAL_BUDGET_MS,
//        ROUTE_SLO_MAX_QUERIES, LIVE_APP_PORT (3000)

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hash as argon2Hash } from "@node-rs/argon2";
import { Pool } from "pg";
import { portInUse, readEnvLocal, swapDatabase } from "../db/app-url";
import { databaseNameFromUrl, requireDisposableOwnerDatabaseUrl } from "../db/owner-url";
import { ensureSystemActor } from "../db/seed-system-actor";
import { generateVolume } from "./volume";

/* ── ayarlar ─────────────────────────────────────────────────────────────────────────── */

const PORT = process.env.ROUTE_SLO_PORT ?? "3280";
const LIVE_PORT = process.env.LIVE_APP_PORT ?? "3000";
const DIST_DIR = process.env.ROUTE_SLO_DIST_DIR ?? ".next-stage10-perf";
const SAMPLES = Math.max(5, Number(process.env.ROUTE_SLO_SAMPLES ?? 12));
/** Sorgu sayısı deterministik olmalı; bağımsız örneklemler onu doğrular. */
const ACCOUNTING_SAMPLES = Math.max(3, Number(process.env.ROUTE_SLO_ACCOUNTING_SAMPLES ?? 5));
/**
 * Yanıt kapandıktan sonra sayaç okunmadan önce beklenen süre.
 *
 * ÖLÇEREK EKLENDİ, tahminle değil. Bu bekleme yokken /overview üç örneklemde 42/41/41,
 * /insights/briefing ise 18/14/30 sorgu raporladı. Sebep şu: Next App Router yanıtı AKITIR
 * (bu ölçümde TTFB ~17 ms iken tam yanıt ~600 ms) ve gövde akışı kapandığında sunucu tarafında
 * başlamış olan her iş bitmiş olmak zorunda değil. Beklemeden okumak, bir isteğin kuyruğundaki
 * sorguları BİR SONRAKİ pencereye kaydırır — ve sayı "kararsız" görünür, oysa kararsız olan
 * ölçüm penceresidir. Bekleme, pencereyi isteğin gerçek DB kuyruğunu kapsayacak kadar uzatır.
 */
const PROBE_SETTLE_MS = Math.max(0, Number(process.env.ROUTE_SLO_PROBE_SETTLE_MS ?? 750));
const SKIP_BUILD = process.env.ROUTE_SLO_SKIP_BUILD === "1";
/**
 * ZATEN KOŞAN bir sunucuya karşı ölç — CI modu.
 *
 * Kurulduğunda bu script hacim üretmez, derlemez, sunucu başlatmaz ve WALL-CLOCK ölçmez.
 * Yalnız DETERMİNİSTİK alt kümeyi koşar: her rota 200 dönüyor ve beklenen sayfaya varıyor mu,
 * rota başına query_count tavanın altında mı, örneklemler arasında oynuyor mu. Bunlar makineden
 * bağımsızdır — bir CI runner'ının yavaş olması sonucu değiştirmez — o yüzden sert kapı
 * olabilirler. Duvar saati sayıları bu modda HİÇ toplanmaz ki yanlışlıkla kapıya dönüşmesinler.
 *
 * Hedef sunucu `MAS_PERF_PROBE=1` ile başlatılmış olmalıdır; olmazsa /api/perf-probe 404 döner
 * ve bu script açıkça durur (sessizce "0 sorgu" raporlamaz).
 */
const BASE_URL_OVERRIDE = process.env.ROUTE_SLO_BASE_URL;
/**
 * Ölçüm sunucusunu ölçüm bittikten sonra AYAKTA bırak.
 *
 * "Eksik 3" (interactive readiness) Playwright paketi AYNI sunucuya ve AYNI veritabanına
 * ihtiyaç duyar; iki ayrı sunucu ayağa kaldırmak iki ayrı ölçüm ortamı demektir. Bayrak
 * kurulduğunda süreç PID'i yazdırılır ve kapatma çağırana bırakılır:
 *
 *   ROUTE_SLO_KEEP_SERVER=1 pnpm perf:route-slo
 *   BASE_URL=http://127.0.0.1:3280 MAS_E2E_DATABASE_URL=…  *     pnpm exec playwright test tests/visual/interactive-readiness.spec.ts
 *   taskkill /pid <PID> /T /F        (yalnız BU süreç; port 3000'e asla dokunulmaz)
 */
const KEEP_SERVER = process.env.ROUTE_SLO_KEEP_SERVER === "1";

/**
 * Rehber §15'in verdiği rota kümesi, olduğu gibi — VARIŞ yeriyle birlikte.
 *
 * `/radar` dokuz-modül yeniden yapılandırmasında kalıcı bir 301 oldu (next.config.ts:41) ve
 * `/payments`e gider. İstenen yolu 200 beklemek o doğru yönlendirmeyi ARIZA gibi gösterirdi;
 * yönlendirmeyi sessizce izlemek ise /login'e düşen bir kimlik hatasını "hızlı rota" gibi
 * gösterirdi. İkisi de yanlış. Varış yeri YAZILI: yönlendirme izlenir, sonra gerçekten
 * istenen sayfaya varıldığı doğrulanır. Ölçülen süre kullanıcının beklediği süredir —
 * yönlendirme sıçraması dahil.
 */
interface RouteSpec { href: string; expected: string }
const ROUTES: readonly RouteSpec[] = [
  { href: "/overview", expected: "/overview" },
  { href: "/radar", expected: "/payments" },
  { href: "/cashflow", expected: "/cashflow" },
  { href: "/payments", expected: "/payments" },
  { href: "/finance/bank", expected: "/finance/bank" },
  { href: "/finance/invoices", expected: "/finance/invoices" },
  { href: "/data/quality", expected: "/data/quality" },
  { href: "/insights/briefing", expected: "/insights/briefing" },
];

/**
 * SERT felaket tavanı — `perf-gate.ts`'in CATASTROPHE_MS'i ile aynı ruhta.
 *
 * Tek bir seçici SQL için oradaki taban 3000 ms. Burada ölçülen şey bütün bir sunucu
 * render'ı (oturum doğrulama + onlarca sorgu + React server render), o yüzden taban daha
 * cömert. Bunu aşan bir rota YAVAŞ değil KIRIKTIR; yavaşlık aşağıdaki bütçelerin konusu.
 */
const CATASTROPHE_MS = Number(process.env.ROUTE_SLO_CATASTROPHE_MS ?? 8000);

/** TREND bütçeleri — aşılırsa UYARI, exit kodu değişmez. */
const TTFB_BUDGET_MS = Number(process.env.ROUTE_SLO_TTFB_BUDGET_MS ?? 1500);
const TOTAL_BUDGET_MS = Number(process.env.ROUTE_SLO_TOTAL_BUDGET_MS ?? 2000);

/**
 * SERT N+1 cırcırı: bir rota render'ının atabileceği en fazla sorgu.
 *
 * `perf-gate.ts`'teki indekssiz-FK cırcırıyla aynı mantık: bugün ölçülen en yüksek değerin
 * üstünde makul bir pay bırakılır, ve bir gün bir loader döngü içinde sorgu atmaya başlarsa
 * sayı bu tavanı kırar. Wall-clock'tan farkı, bu sayının MAKİNEDEN BAĞIMSIZ olması — aynı
 * kod + aynı veri her yerde aynı sorgu sayısını üretir, o yüzden CI'da sert kapı olabilir.
 */
const MAX_QUERIES_PER_ROUTE = Number(process.env.ROUTE_SLO_MAX_QUERIES ?? 45);

const EVIDENCE_DIR = "docs/release-evidence/final-production-readiness";
const TREND_FILE = path.join(EVIDENCE_DIR, "08-performance-trend.jsonl");
const JSON_OUT = path.join("test-results", "route-slo.json");
const SERVER_LOG = path.join("test-results", "route-slo-server.log");

/* ── kayıt defteri ───────────────────────────────────────────────────────────────────── */

interface Check { name: string; pass: boolean; expected: string; actual: string; hard: boolean }
const checks: Check[] = [];
const warnings: string[] = [];
const commands: string[] = [];
const exitCodes: Record<string, number> = {};

function record(name: string, pass: boolean, expected: string, actual: string): boolean {
  checks.push({ name, pass, expected, actual, hard: true });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — beklenen: ${expected} · gerçek: ${actual}`);
  return pass;
}
function trend(name: string, within: boolean, budget: string, actual: string): void {
  checks.push({ name, pass: within, expected: budget, actual, hard: false });
  if (!within) warnings.push(`${name}: ${actual} (bütçe ${budget})`);
  console.log(`${within ? "OK  " : "WARN"}  [trend] ${name} — bütçe: ${budget} · gerçek: ${actual}`);
}
function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}`);
}

/* ── istatistik ──────────────────────────────────────────────────────────────────────── */

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * Doğrusal interpolasyonlu yüzdelik.
 *
 * En-yakın-sıra (nearest-rank) yöntemi N<20 örneklemde p95'i HER ZAMAN maksimuma eşitler ve
 * "p95" etiketi altında aslında en kötü örneklemi raporlamak, dağılımı tek örnekle temsil
 * etmenin başka bir biçimidir. İnterpolasyon en azından iki üst örneklemi birlikte kullanır;
 * yine de N burada 12'dir ve bu kanıt dosyasında açıkça yazılıdır. Maksimum AYRICA raporlanır.
 */
function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
const r1 = (n: number): number => Number(n.toFixed(1));

/* ── süreç / ağ yardımcıları ─────────────────────────────────────────────────────────── */

/**
 * Başlattığımız sunucuyu ağacıyla birlikte kapat — YALNIZ onu.
 *
 * ÖLÇÜLEREK EKLENDİ. Windows'ta `spawn(..., { shell: true })` araya bir `cmd` sarmalayıcı
 * koyar; `child.kill()` o sarmalayıcıyı öldürür ve asıl `next start` süreci yaşamaya, portu
 * tutmaya devam eder. Somut sonuç: bu kapının ikinci koşusu "Port 3280 zaten dinleniyor"
 * diyerek durdu — kendi bıraktığı artık süreç yüzünden. `taskkill /T` ağacın tamamını
 * kapatır. PID her zaman BİZİM başlattığımız sürecindir; başkasının süreci asla hedeflenmez.
 */
function killOwnServer(child: ReturnType<typeof spawn> | null): void {
  if (!child || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch { /* zaten ölmüş olabilir */ }
    return;
  }
  child.kill();
}

function runCaptured(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  commands.push(`${cmd} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, shell: process.platform === "win32" });
    let output = "";
    const sink = (buf: Buffer) => { const s = buf.toString("utf8"); output += s; process.stdout.write(s); };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
  });
}

async function fetchText(url: string, timeoutMs = 4000): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return `${res.status} ${(await res.text()).slice(0, 120)}`;
  } catch (e) {
    return `ulaşılamadı (${e instanceof Error ? e.message : String(e)})`;
  }
}

/* ── ölçüm ───────────────────────────────────────────────────────────────────────────── */

interface Sample {
  status: number; finalPath: string; ttfbMs: number; totalMs: number; bytes: number;
  /** Sayfa kabuğu gövdede YOK mu? Bkz. RENDERED_SHELL_MARKER — 200 tek başına yetmiyor. */
  errorShell: boolean;
}

/**
 * HTTP 200 BİR SAĞLIK KANITI DEĞİLDİR — bu ölçülerek öğrenildi.
 *
 * Next App Router yanıtı AKITIR: durum satırı ve başlıklar sunucu render'ının BAŞINDA, gövde
 * hazır olmadan gönderilir (bu ölçümde TTFB ~20 ms, tam yanıt ~600 ms). Render sonradan
 * patlarsa durum kodu ARTIK DEĞİŞTİRİLEMEZ; hata, açık olan 200 akışının içine "Application
 * error: a server-side exception has occurred" kabuğu olarak yazılır.
 *
 * Somut vaka: bu makinedeki Postgres konteyneri Docker varsayılanı olan 64 MB `/dev/shm` ile
 * koşuyor. Gerçekçi hacimde paralel sorgu planları paylaşımlı bellek segmentini büyütemiyor ve
 * SQLSTATE 53100 ile düşüyor; sayfa hata kabuğuna dönüşüyor — ama HTTP 200 dönüyor. Yalnız
 * duruma bakan bir kapı bunu YEŞİL raporlardı. Bu yüzden gövde de kontrol ediliyor.
 */
/**
 * POZİTİF KONTROL, negatif işaret DEĞİL — ve bu da ölçülerek düzeltildi.
 *
 * İlk sürüm gövdede "Application error" / "a server-side exception has occurred" dizelerini
 * ARADI ve SEKİZ rotanın 13/13 örneklemini "hata kabuğu" ilan etti. Sayı yanlıştı: sunucu
 * log'unda tek bir hata yoktu ve sayfalar gerçekten render olmuştu. Sebep, Next'in hata
 * sınırının METNİNİ her sayfanın paketine gömmesi — dize sağlıklı sayfada da var.
 *
 * Doğru soru "hata metni var mı" değil, "SAYFA GERÇEKTEN RENDER OLDU MU". Kabuk render
 * olduğunda `main.workspace-content` (dashboard layout'u) gövdededir; Next'in genel hata
 * kabuğu ise layout'un TAMAMINI değiştirir ve o sınıf kaybolur. Rehber §30.1'in kuralı bu:
 * "hiçbir satır dönmedi → geçti" yerine sahibin POZİTİF kontrolü.
 */
const RENDERED_SHELL_MARKER = "workspace-content";

/**
 * Tek bir HTTP GET'i ölç.
 *
 * `fetch()` promise'i BAŞLIKLAR geldiğinde çözülür — yani `t1 - t0` sunucunun ilk baytı
 * (TTFB); gövde `arrayBuffer()` ile tüketildikten sonraki `t2 - t0` tam yanıt süresidir.
 * Yönlendirme İZLENİR (kalıcı 301'ler ürünün bir parçası) ama VARIŞ YERİ geri döndürülür:
 * /login'e düşen bir kimlik hatası böylece "200 döndü, demek ki hızlı" diye okunamaz.
 */
async function measureOnce(url: string, cookie: string): Promise<Sample> {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, {
    headers: { cookie, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    cache: "no-store",
  });
  const t1 = process.hrtime.bigint();
  const body = await res.arrayBuffer();
  const t2 = process.hrtime.bigint();
  // Çözümleme SÜREYİ ÖLÇTÜKTEN SONRA: t2 zaten alındı, gövde incelemesi ölçüme karışmaz.
  const text = new TextDecoder().decode(body);
  return {
    status: res.status,
    finalPath: new URL(res.url).pathname,
    ttfbMs: Number(t1 - t0) / 1e6,
    totalMs: Number(t2 - t0) / 1e6,
    bytes: body.byteLength,
    errorShell: !text.includes(RENDERED_SHELL_MARKER),
  };
}

interface ProbeReading {
  armed?: boolean;
  queryCount: number;
  totalDbTimeMs: number;
  slowestQueryMs: number;
  slowestQueryShape: string | null;
}

async function readProbe(base: string, cookie: string): Promise<ProbeReading> {
  const res = await fetch(`${base}/api/perf-probe`, { headers: { cookie }, redirect: "manual", cache: "no-store" });
  if (res.status !== 200) {
    throw new Error(
      `/api/perf-probe ${res.status} döndü. MAS_PERF_PROBE=1 ile başlatılmamış bir sunucuya karşı ` +
        "sorgu muhasebesi ölçülemez (uç kapalıyken 404 döner — bu kasıtlı).",
    );
  }
  return (await res.json()) as ProbeReading;
}

interface RouteResult {
  route: string;
  coldMs: number;
  coldStatus: number;
  samples: Sample[];
  // CI (base-url) modunda duvar saati HİÇ toplanmaz; null "ölçülmedi" demektir ve tek bir
  // soğuk örneklemin dağılım gibi raporlanmasını yapısal olarak imkânsız kılar.
  ttfbMedian: number | null; ttfbP95: number | null; ttfbMax: number | null;
  totalMedian: number | null; totalP95: number | null; totalMax: number | null;
  queryCounts: number[];
  /** İlk (ısınma) örneklem — süreç ömründe bir kez olan yol. */
  warmupQueryCount: number;
  /** Isınma sonrası örneklemler; kararlılık iddiası bunlar üzerinde kurulur. */
  steadyQueryCounts: number[];
  queryCount: number;
  totalDbTimeMs: number;
  slowestQueryMs: number;
  slowestQueryShape: string | null;
  bytes: number;
}

/* ── ana akış ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("=== perf:route-slo — HTTP rota SLO + rota başına sorgu muhasebesi (AŞAMA 10) ===\n");

  const ownerUrl = requireDisposableOwnerDatabaseUrl("perf:route-slo");
  const dbName = databaseNameFromUrl(ownerUrl) ?? "(okunamadı)";
  // Uygulama bağlantısı: CI'da açıkça verilir (`.env.local` yoktur), yerelde canlı runtime
  // kimliğinden YALNIZ veritabanı adı değiştirilerek türetilir. `pnpm db:app-role:password`
  // ASLA çağrılmaz — o komut rolü cluster genelinde değiştirip canlı örneği düşürür.
  // Zaten koşan bir sunucuya ölçüm yapılıyorsa bu dizeye hiç ihtiyaç yoktur.
  const appUrlBase = BASE_URL_OVERRIDE
    ? ""
    : process.env.MAS_APP_DATABASE_URL ?? swapDatabase(readEnvLocal().DATABASE_URL ?? "", dbName);
  /**
   * ÖLÇÜM SUNUCUSUNUN BAĞLANTILARINDA paralel sorgu işçileri kapatılır.
   *
   * NEDEN. Bu makinedeki `mas-radar-pg` konteyneri Docker varsayılanı 64 MB `/dev/shm` ile
   * koşuyor (`docker inspect … .HostConfig.ShmSize` = 67108864). Gerçekçi hacimde paralel
   * planlar paylaşımlı bellek segmentini büyütemiyor ve sorgular SQLSTATE 53100 ("could not
   * resize shared memory segment") ile düşüyor; sayfa Next'in hata kabuğuna dönüşüyor.
   * ÖLÇÜLDÜ: tek bir koşunun sunucu log'unda 36 adet 53100.
   *
   * NEDEN KONTEYNER DÜZELTİLMİYOR. `shm_size` ancak konteyner YENİDEN OLUŞTURULARAK
   * değiştirilir ve bu konteyner port 3000'deki CANLI production örneğinin veritabanını da
   * barındırıyor. Bu kapı kimsenin sürecini düşürmez.
   *
   * NEDEN `alter database` DEĞİL. O, `mas_radar_perf_verify`i kalıcı olarak değiştirir ve
   * `perf:gate` de aynı hedefi kullanır. Bağlantı dizesindeki `options` YALNIZ bu sürecin
   * bağlantılarını etkiler; ne veritabanı ne canlı örnek değişir.
   *
   * BU BİR DÜZELTME DEĞİL, ÖLÇÜM ŞARTIDIR ve kanıt dosyasında P1 olarak yazılıdır: production
   * konteyneri `shm_size` ≥ 256 MB ile koşmalıdır. Paralellik kapalı ölçüm KARAMSAR taraftadır
   * (daha yavaş), yani raporlanan süreler iyimser değildir.
   */
  const SHM_MITIGATION = "options=-c%20max_parallel_workers_per_gather%3D0";
  const appUrl = appUrlBase === ""
    ? ""
    : appUrlBase + (appUrlBase.includes("?") ? "&" : "?") + SHM_MITIGATION;

  const machine = {
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? "bilinmiyor",
    cores: os.cpus().length,
    totalMemGb: r1(os.totalmem() / 1024 ** 3),
    freeMemGbAtStart: r1(os.freemem() / 1024 ** 3),
    loadavg1: r1(os.loadavg()[0]),
  };
  console.log(`Makine: ${machine.cpu} · ${machine.cores} mantıksal çekirdek · ` +
    `RAM ${machine.totalMemGb} GB (ölçüm başında boş: ${machine.freeMemGbAtStart} GB)`);
  console.log(`Hedef veritabanı: ${dbName} (HARCANABİLİR) · ölçüm portu: ${PORT}`);

  const liveBefore = await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`);
  console.log(`Canlı örnek (port ${LIVE_PORT}) ölçüm öncesi: ${liveBefore}`);

  if (!BASE_URL_OVERRIDE && await portInUse(PORT)) {
    console.error(
      `Port ${PORT} zaten dinleniyor. Bu kapı başkasının sunucusuyla YARIŞMAZ ve onu ÖLDÜRMEZ; ` +
        "ROUTE_SLO_PORT ile boş bir port verin.",
    );
    process.exit(1);
  }

  /* ── 1) hacim + ölçüm kimliği ──────────────────────────────────────────────────────── */
  step("1/5 harcanabilir hedefe gerçekçi hacim + ölçüm oturumu");

  const owner = new Pool({ connectionString: ownerUrl, max: 4 });
  const sessionToken = randomBytes(32).toString("base64url");
  let sessionId = "";
  try {
    // Zaten koşan bir sunucuya ölçüm yapılırken hacim ÜRETİLMEZ: o veritabanı başka bir
    // paketin fixture'ıdır ve altını değiştirmek başkasının ölçümünü bozardı. Sorgu SAYISI
    // zaten kodun şeklinin sonucudur, veri hacminin değil.
    if (!BASE_URL_OVERRIDE) await generateVolume(owner); // deterministik; generate_series, random() yok
    const vol = await owner.query<{ t: string; n: number }>(`
      select 'payment_instances' t, count(*)::int n from public.payment_instances
      union all select 'invoices', count(*)::int from public.invoices
      union all select 'bank_transactions', count(*)::int from public.bank_transactions
      union all select 'checks', count(*)::int from public.checks
      order by 1`);
    const volumeLine = vol.rows.map((r) => `${r.t}=${r.n}`).join(" · ");
    console.log(`hacim: ${volumeLine}`);
    if (!BASE_URL_OVERRIDE) {
      record("harcanabilir hedefte gerçekçi hacim yüklü", vol.rows.every((r) => r.n > 0),
        "her tablo > 0", volumeLine);
    }

    await ensureSystemActor(owner);

    // Ölçüm hesabı. Parola GERÇEK bir kimlik bilgisi değildir ve bu hesap yalnız harcanabilir
    // bir veritabanında vardır; oturum aşağıda doğrudan kurulur, form akışı Playwright
    // tarafında (interactive-readiness.spec.ts) GERÇEK /login formuyla koşar.
    const pwHash = await argon2Hash("stage10-route-slo-not-a-secret",
      { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const user = await owner.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role, is_active)
       values ('perf_route_slo', $1, 'Ölçüm (route SLO)', 'admin', true)
       on conflict (username) do update
         set is_active = true, role = 'admin', password_hash = excluded.password_hash,
             failed_login_count = 0, locked_until = null
       returning id`, [pwHash]);

    // GERÇEK oturum mekanizması: rastgele opak token, DB'de yalnız SHA-256'sı. Uygulama
    // tarafında hiçbir bypass yok — `getCurrentUser()` bu satırı normal yolundan doğrular.
    // MAS_QA_BYPASS_AUTH KURULMAZ.
    const sess = await owner.query<{ id: string }>(
      `insert into public.sessions (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '2 hours') returning id`,
      [user.rows[0].id, createHash("sha256").update(sessionToken).digest("hex")]);
    sessionId = sess.rows[0].id;

    /* ── 2) derleme + sunucu ─────────────────────────────────────────────────────────── */
    step(BASE_URL_OVERRIDE
      ? "2/5 derleme/sunucu ATLANDI — zaten koşan sunucuya ölçüm (CI modu)"
      : "2/5 ayrı distDir'e derleme + ölçüm sunucusu");

    const appEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: appUrl,
      MIGRATION_DATABASE_URL: ownerUrl,
      MAS_NEXT_DIST_DIR: DIST_DIR,
      MAS_PERF_PROBE: "1",
    };
    delete appEnv.MAS_QA_BYPASS_AUTH;

    if (!SKIP_BUILD && !BASE_URL_OVERRIDE) {
      // `next build` tsconfig.json'u kendiliğinden yeniden yazar (özel distDir tipini ekler);
      // release commit'ine build aracı gürültüsü girmesin diye dosya birebir geri yazılır.
      const tsconfigPath = path.join(process.cwd(), "tsconfig.json");
      const tsconfigBefore = readFileSync(tsconfigPath, "utf8");
      const build = await runCaptured("pnpm", ["exec", "next", "build"], appEnv);
      exitCodes["next build (ayrı distDir)"] = build.code;
      if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) {
        writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
      }
      if (!record(`production derleme (distDir '${DIST_DIR}' — canlı .next ezilmedi)`,
        build.code === 0, "exit 0", `exit ${build.code}`)) {
        throw new Error("derleme başarısız");
      }
    } else {
      console.log(`derleme atlandı (ROUTE_SLO_SKIP_BUILD=1) — mevcut '${DIST_DIR}' kullanılıyor`);
    }

    let server: ReturnType<typeof spawn> | null = null;
    if (!BASE_URL_OVERRIDE) {
      // Ödeme penceresini sunucudan ÖNCE üret: `pnpm start` bunu zaten yapar, ama ilk üretim
      // dakikalar sürebilir ve o süre sunucunun "hazır olamadı" gibi görünmesine yol açar.
      const prep = await runCaptured("pnpm", ["exec", "tsx", "scripts/prepare-runtime.ts"], appEnv);
      exitCodes["tsx scripts/prepare-runtime.ts"] = prep.code;
      record("çalışma zamanı hazırlığı (ödeme penceresi) koştu", prep.code === 0, "exit 0", `exit ${prep.code}`);

      mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
      const logFd = openSync(SERVER_LOG, "w");
      server = spawn("pnpm", ["start"], {
        stdio: ["ignore", logFd, logFd], detached: false, shell: process.platform === "win32",
        env: { ...appEnv, PORT },
      });
      commands.push(`pnpm start (PORT=${PORT}, MAS_NEXT_DIST_DIR=${DIST_DIR}, MAS_PERF_PROBE=1)`);
    }

    const base = BASE_URL_OVERRIDE ?? `http://127.0.0.1:${PORT}`;
    const cookie = `mas_session=${sessionToken}`;
    let results: RouteResult[] = [];

    try {
      let up = false;
      for (let i = 0; i < 90; i += 1) {
        try { if ((await fetch(`${base}/ready`)).ok) { up = true; break; } } catch { /* dinlemiyor */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      let bootDetail = up ? `${base}/ready = 200` : "sunucu hazır olmadı";
      if (!up && existsSync(SERVER_LOG)) {
        const tail = readFileSync(SERVER_LOG, "utf8").split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
        bootDetail += tail ? ` — sunucu çıktısı: ${tail.slice(0, 400)}` : " (çıktı boş)";
      }
      if (!record("ölçüm sunucusu ayağa kalktı (QA bypass KAPALI)", up, "/ready = 200", bootDetail)) {
        throw new Error("sunucu hazır olmadı");
      }

      /* ── 3) ısınma turu ──────────────────────────────────────────────────────────── */
      step("3/5 ısınma turu (her rota bir kez — soğuk render ayrı raporlanır)");
      const cold = new Map<string, Sample>();
      for (const route of ROUTES) {
        const s = await measureOnce(`${base}${route.href}`, cookie);
        cold.set(route.href, s);
        console.log(`  soğuk ${route.href.padEnd(20)} ${s.status} ${s.finalPath} · ` +
          `TTFB ${r1(s.ttfbMs)} ms · toplam ${r1(s.totalMs)} ms`);
      }

      // POZİTİF KONTROL: sunucu GERÇEKTEN bu veritabanına mı bağlı? Kimlikli her istek
      // sessions.last_seen_at'i günceller. Doluysa, yukarıda ölçülen HTML'i üreten süreç
      // bu satırı bu veritabanında yazmıştır — "doğru DB'ye bağlıdır" varsayımı değil kanıt.
      const seen = await owner.query<{ n: number }>(
        `select count(*)::int n from public.sessions where id = $1 and last_seen_at is not null`,
        [sessionId]);
      record("ölçüm sunucusu HARCANABİLİR hedefe bağlı (oturum satırı güncellendi)",
        seen.rows[0].n === 1, "last_seen_at dolu", `${seen.rows[0].n} satır`);

      /* ── 4) zamanlama turu ───────────────────────────────────────────────────────── */
      step(BASE_URL_OVERRIDE
        ? "4/5 zamanlama turu ATLANDI — CI modunda duvar saati toplanmaz"
        : `4/5 zamanlama turu (rota başına ${SAMPLES} örneklem)`);
      const timing = new Map<string, Sample[]>();
      for (const route of ROUTES) {
        const samples: Sample[] = [];
        if (!BASE_URL_OVERRIDE) {
          for (let i = 0; i < SAMPLES; i += 1) samples.push(await measureOnce(`${base}${route.href}`, cookie));
          console.log(`  ${route.href.padEnd(20)} medyan TTFB ${r1(median(samples.map((s) => s.ttfbMs)))} ms · ` +
            `medyan toplam ${r1(median(samples.map((s) => s.totalMs)))} ms`);
        }
        timing.set(route.href, samples);
      }

      /* ── 5) sorgu muhasebesi turu ────────────────────────────────────────────────── */
      step(`5/5 sorgu muhasebesi turu (rota başına ${ACCOUNTING_SAMPLES} örneklem)`);
      // İlk çağrı sayacı KURAR ve pencereyi sıfırlar. Ondan sonra her okuma, bir önceki
      // okumadan bu yana geçen tek isteğe aittir — sunucu SIRAYLA, tek istemciyle sürülüyor.
      //
      // HER ROTANIN İLK ÖRNEKLEMİ ISINMA SAYILIR — ölçülerek, varsayılarak değil. Bekleme
      // penceresi eklendikten sonra desen net: /overview 43/41/41/41/41, /insights/briefing
      // 25/20/20/20/20. Yani ilk istek birkaç fazladan sorgu atıyor ve sonrası SABİT. Bu bir
      // gürültü değil, süreç ömründe bir kez ısınan bir yol (ilk çağrıda dolan süreç-içi
      // önbellekler). Zamanlama turu zaten soğuk örneklemi ayırıyor; sorgu muhasebesi de
      // aynısını yapar. Isınma örneklemi ATILMAZ: ayrıca raporlanır ve TAVAN ona da uygulanır,
      // yalnız KARARLILIK iddiası kararlı hâl örneklemleri üzerinde kurulur.
      await readProbe(base, cookie);
      const accounting = new Map<string, ProbeReading[]>();
      for (const route of ROUTES) {
        const readings: ProbeReading[] = [];
        for (let i = 0; i < ACCOUNTING_SAMPLES; i += 1) {
          const s = await measureOnce(`${base}${route.href}`, cookie);
          // Akıtılan yanıt kapandı; sunucunun kuyruğu bitsin diye beklenir (yukarıya bakın).
          await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
          const reading = await readProbe(base, cookie);
          // Varılan yer beklenen sayfa değilse (ör. /login) o pencere bir rota render'ı DEĞİLDİR.
          if (s.status !== 200 || s.finalPath !== route.expected) reading.queryCount = -1;
          readings.push(reading);
        }
        accounting.set(route.href, readings);
        console.log(`  ${route.href.padEnd(20)} query_count ${readings.map((r) => r.queryCount).join("/")} ` +
          `(ilki ısınma) · ` +
          `toplam DB ${r1(readings[0].totalDbTimeMs)} ms · en yavaş şekil: ` +
          `${(readings[0].slowestQueryShape ?? "-").slice(0, 60)}`);
      }

      /* ── sonuçlar ────────────────────────────────────────────────────────────────── */
      results = ROUTES.map(({ href: route }) => {
        const samples = timing.get(route)!;
        const readings = accounting.get(route)!;
        const ttfb = samples.map((s) => s.ttfbMs);
        const total = samples.map((s) => s.totalMs);
        const counts = readings.map((r) => r.queryCount);
        const worst = readings.reduce((a, b) => (b.slowestQueryMs > a.slowestQueryMs ? b : a));
        const has = samples.length > 0;
        return {
          route,
          coldMs: r1(cold.get(route)!.totalMs),
          coldStatus: cold.get(route)!.status,
          samples,
          ttfbMedian: has ? r1(median(ttfb)) : null,
          ttfbP95: has ? r1(percentile(ttfb, 0.95)) : null,
          ttfbMax: has ? r1(Math.max(...ttfb)) : null,
          totalMedian: has ? r1(median(total)) : null,
          totalP95: has ? r1(percentile(total, 0.95)) : null,
          totalMax: has ? r1(Math.max(...total)) : null,
          queryCounts: counts,
          warmupQueryCount: counts[0],
          steadyQueryCounts: counts.slice(1),
          queryCount: Math.max(...counts.slice(1)),
          totalDbTimeMs: r1(median(readings.map((r) => r.totalDbTimeMs))),
          slowestQueryMs: r1(worst.slowestQueryMs),
          slowestQueryShape: worst.slowestQueryShape,
          bytes: samples[0].bytes,
        };
      });

      step("SERT KAPI — deterministik iddialar");
      for (const r of results) {
        const spec = ROUTES.find((x) => x.href === r.route)!;
        const allSamples = [cold.get(r.route)!, ...timing.get(r.route)!];
        const shells = allSamples.filter((x) => x.errorShell).length;
        record(`${r.route}: her örneklem sayfa kabuğunu GERÇEKTEN render etti`, shells === 0,
          `${allSamples.length}/${allSamples.length} örneklemde '${RENDERED_SHELL_MARKER}' var`,
          shells === 0 ? `${allSamples.length}/${allSamples.length}` : `${shells} örneklemde kabuk YOK (hata sayfası)`);
        const bad = allSamples.filter((s) => s.status !== 200 || s.finalPath !== spec.expected);
        record(`${r.route}: her örneklem HTTP 200 ve ${spec.expected} sayfasına vardı`, bad.length === 0,
          `${allSamples.length}/${allSamples.length} × 200 @ ${spec.expected}`,
          bad.length === 0 ? `${allSamples.length}/${allSamples.length} × 200 @ ${spec.expected}`
            : `${bad.length} örneklem: ${[...new Set(bad.map((s) => `${s.status} ${s.finalPath}`))].join(", ")}`);
      }
      for (const r of results) {
        // Tavan ISINMA dahil bütün örneklemlere uygulanır: ilk isteğin patlaması da regresyondur.
        const worstAll = Math.max(...r.queryCounts);
        record(`${r.route}: query_count tavanı aşmıyor (≤ ${MAX_QUERIES_PER_ROUTE})`,
          Math.min(...r.queryCounts) > 0 && worstAll <= MAX_QUERIES_PER_ROUTE,
          `1..${MAX_QUERIES_PER_ROUTE}`, `${worstAll} (ısınma ${r.warmupQueryCount}, kararlı ${r.queryCount})`);
      }
      for (const r of results) {
        // N+1 DEDEKTÖRÜ: kararlı hâlde sayı OYNAMAMALI. Bir loader satır başına sorgu atmaya
        // başlarsa bu sayı veriyle birlikte kayar ve burada düşer — makineden bağımsız.
        const stable = new Set(r.steadyQueryCounts).size === 1;
        record(`${r.route}: kararlı hâlde query_count oynamıyor (N+1 dedektörü)`, stable,
          `${r.steadyQueryCounts.length} örneklemde aynı sayı`,
          `${r.steadyQueryCounts.join("/")} (ısınma ${r.warmupQueryCount} hariç)`);
      }
      if (!BASE_URL_OVERRIDE) {
        for (const r of results) {
          record(`${r.route}: felaket tavanı altında (< ${CATASTROPHE_MS} ms)`,
            r.totalMax! < CATASTROPHE_MS, `< ${CATASTROPHE_MS} ms`, `${r.totalMax} ms (en kötü örneklem)`);
        }

        step("TREND — wall-clock bütçeleri (uyarı; exit kodunu DEĞİŞTİRMEZ)");
        for (const r of results) {
          trend(`${r.route}: TTFB medyanı`, r.ttfbMedian! <= TTFB_BUDGET_MS,
            `≤ ${TTFB_BUDGET_MS} ms`, `${r.ttfbMedian} ms (p95 ${r.ttfbP95}, max ${r.ttfbMax})`);
        }
        for (const r of results) {
          trend(`${r.route}: toplam yanıt medyanı`, r.totalMedian! <= TOTAL_BUDGET_MS,
            `≤ ${TOTAL_BUDGET_MS} ms`, `${r.totalMedian} ms (p95 ${r.totalP95}, max ${r.totalMax})`);
        }
      } else {
        console.log("CI modu: duvar saati eşiği ve trend bütçesi DEĞERLENDİRİLMEDİ (ölçülmedi).");
      }
    } finally {
      // Yalnız KENDİ başlattığımız sunucu. Başkasının süreci ASLA öldürülmez; port 3000'e
      // ve CI modunda paketin kendi sunucusuna dokunulmaz.
      if (server && KEEP_SERVER) {
        console.log(`
ROUTE_SLO_KEEP_SERVER=1 — ölçüm sunucusu AYAKTA bırakıldı: ` +
          `pid ${server.pid}, ${base}. Kapatmak çağırana ait.`);
      } else if (server) {
        killOwnServer(server);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    /* ── kanıt dosyaları ─────────────────────────────────────────────────────────────── */
    const freeMemGbAtEnd = r1(os.freemem() / 1024 ** 3);
    const liveAfter = await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`);
    console.log(`\nCanlı örnek (port ${LIVE_PORT}) ölçüm sonrası: ${liveAfter}`);

    const payload = {
      startedAt, finishedAt: new Date().toISOString(),
      commit: process.env.APP_COMMIT_SHA ?? null,
      databaseName: dbName, databaseClass: "DISPOSABLE_SYNTHETIC",
      port: Number(PORT), samples: SAMPLES, accountingSamples: ACCOUNTING_SAMPLES,
      machine: { ...machine, freeMemGbAtEnd },
      thresholds: {
        hard: { catastropheMs: CATASTROPHE_MS, maxQueriesPerRoute: MAX_QUERIES_PER_ROUTE },
        trend: { ttfbBudgetMs: TTFB_BUDGET_MS, totalBudgetMs: TOTAL_BUDGET_MS },
      },
      liveInstance: { port: Number(LIVE_PORT), before: liveBefore, after: liveAfter },
      routes: results.map(({ samples, ...rest }) => ({ ...rest, sampleCount: samples.length })),
      checks, warnings, commands, exitCodes,
    };
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2), "utf8");

    // Trend kaydı: her koşu bir satır. Rehber §15 "wall-clock SLO = ortama duyarlı eşik +
    // TREND KANITI" — tek bir koşunun sayısı eşik değil, gözlemdir; anlamı ancak seri hâlinde
    // doğar. Satır küçük tutulur (disk %94 dolu).
    // Trend satiri YALNIZ duvar saati gerçekten ölçüldüğünde yazılır; CI modu ölçmediği
    // için seriye "null" enjekte etmez.
    if (!BASE_URL_OVERRIDE) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      appendFileSync(TREND_FILE, JSON.stringify({
        at: startedAt, db: dbName, cores: machine.cores, freeMemGb: machine.freeMemGbAtStart,
        routes: Object.fromEntries(results.map((r) => [r.route, {
          ttfbMedian: r.ttfbMedian, totalMedian: r.totalMedian, q: r.queryCount,
        }])),
      }) + "\n", "utf8");
    }

    /* ── özet ────────────────────────────────────────────────────────────────────────── */
    step("ÖZET");
    console.log("| rota | TTFB medyan/p95 | toplam medyan/p95 | query_count | DB ms | en yavaş şekil |");
    console.log("|---|---|---|---|---|---|");
    for (const r of results) {
      console.log(`| ${r.route} | ${r.ttfbMedian}/${r.ttfbP95} | ${r.totalMedian}/${r.totalP95} | ` +
        `${r.queryCount} | ${r.totalDbTimeMs} | ${(r.slowestQueryShape ?? "-").slice(0, 70)} |`);
    }

    const hard = checks.filter((c) => c.hard);
    const failed = hard.filter((c) => !c.pass);
    console.log(`\nSERT kapı: ${hard.length - failed.length}/${hard.length} geçti.`);
    console.log(`TREND uyarısı: ${warnings.length} (exit kodunu etkilemez).`);
    console.log(`Kanıt: ${JSON_OUT} · trend: ${TREND_FILE}`);
    if (failed.length > 0) {
      console.error("ROUTE SLO GATE FAIL:");
      for (const f of failed) console.error(`  - ${f.name}: beklenen ${f.expected}, gerçek ${f.actual}`);
      process.exitCode = 1;
    } else {
      console.log("ROUTE SLO GATE: SERT KAPININ TAMAMI GEÇTİ");
    }
  } finally {
    if (sessionId) {
      await owner.query(`delete from public.sessions where id = $1`, [sessionId]).catch(() => {});
    }
    await owner.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("route-slo beklenmedik hata:", e instanceof Error ? e.message : e);
  process.exit(1);
});
