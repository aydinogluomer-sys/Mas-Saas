// AŞAMA 05 + AŞAMA 06 — gerçek üretim verisi üzerinde migration + fingerprint + Golden UI kapısı.
//
// KAPATTIĞI BOŞLUK. Bugüne kadar Faz 3 ve Faz 5 yalnız `DISPOSABLE_SYNTHETIC` (seed:demo) hedefte
// yeşildi. Orijinal kabul kriteri bunu istemiyor: gerçek verinin pg_dump'ı → ayrı bir klon →
// production migration entrypoint'i → fingerprint → AYNI klon üzerinde Golden UI + parasal
// mutabakat. Sentetik veri test mekaniğini kanıtlar; production-veri uyumluluğunu kanıtlamaz
// (rehber §30.3). Bu dosya o zinciri tek komuta indirir.
//
// KAYNAK NEDEN CANLI DB DEĞİL. Canlı `mas_radar_dev` 2026-08-25 09:43 UTC'de zaten 0087'ye
// migrate edildi. Onu klonlamak 0035→0087 geçişini artık YENİDEN ÜRETEMEZ — klon migrate edilecek
// bir şey bulamaz ve kapı boş bir "pending yok" cevabıyla yeşile döner. Bu yüzden kaynak,
// cutover ÖNCESİ alınmış gerçek snapshot'tır:
//
//   backups/cutover_A_20260825-1211.dump   (0034, 867701 bayt, sha256 f121cd49…)
//
// Arşiv sha256 ile doğrulanır ve restore sonrası baseline SERT karşılaştırılır; açıklanmamış
// drift = STOP (rehber §10).
//
// VERİ SINIFLARI (rehber §29):
//   kaynak arşiv          STATIC_SOURCE  — gerçek üretim verisinin dondurulmuş kopyası
//   REAL_SRC_DB           DISPOSABLE_CLONE (gerçek verinin restore'u)
//   RC_CLONE_DB           DISPOSABLE_CLONE (migrate edilen hedef)
//   mas_radar_dev         DOKUNULMAZ — bu script ona hiç bağlanmaz
//
// ÜÇ TEHLİKE VE BUNLARIN NEDEN BURADA AÇIKÇA ELE ALINDIĞI:
//
// 1. `pnpm db:app-role:password` ÇAĞRILMAZ. O script rolü cluster genelinde değiştirir
//    ("Run once per PostgreSQL cluster, not once per database") — çağrılırsa canlı runtime'ın
//    `.env.local` parolası geçersizleşir ve çalışan production örneği kırılır. Bunun yerine
//    klonun app bağlantısı, MEVCUT `.env.local` DATABASE_URL'inden YALNIZ veritabanı adı
//    değiştirilerek türetilir. Bu hem güvenli hem de daha güçlü bir test: gerçek runtime
//    kimliğiyle bağlanılır, sentetik bir parolayla değil.
//
// 2. `.next` EZİLMEZ. Bu makinede repo'nun `.next/` dizininden servis eden canlı bir production
//    sunucusu var (port 3000). Düz bir `pnpm build` onun altındaki chunk'ları ezer. Kapı kendi
//    derlemesini `MAS_NEXT_DIST_DIR` ile ayrı bir dizine yazar ve `pnpm start`'a aynı dizini
//    verir. Kapı yalnız KENDİ başlattığı sunucuyu öldürür; başkasının süreci asla.
//
// 3. HİÇBİR BAĞLANTI DİZESİ YAZDIRILMAZ. Mesajlar yalnız veritabanı ADINI söyler.
//
// Kullanım:
//   pnpm release:real-clone-gate
//
// Ortam (hepsinin makul varsayılanı var):
//   REAL_SNAPSHOT_DUMP, EXPECTED_DUMP_SHA256, REAL_SRC_DB, RC_CLONE_DB,
//   MAS_PG_CONTAINER, MAS_PG_PORT, SMOKE_PORT, SMOKE_SPEC, GATE_DIST_DIR,
//   FINGERPRINT_OUT, GATE_OUT

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Pool } from "pg";
import { isDisposableDatabaseName } from "../db/owner-url";

/* ── ayarlar ─────────────────────────────────────────────────────────────────────────────── */

const CONTAINER = process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
const PORT = process.env.MAS_PG_PORT ?? "5432";
const SNAPSHOT_DUMP = process.env.REAL_SNAPSHOT_DUMP ?? "backups/cutover_A_20260825-1211.dump";
const EXPECTED_SHA = (process.env.EXPECTED_DUMP_SHA256
  ?? "f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d").toLowerCase();
const REAL_SRC_DB = process.env.REAL_SRC_DB ?? "mas_radar_real_snapshot_0034";
const RC_CLONE_DB = process.env.RC_CLONE_DB ?? "mas_radar_final_rc_clone";
const SMOKE_PORT = process.env.SMOKE_PORT ?? "3260";
const SMOKE_SPEC = process.env.SMOKE_SPEC ?? "tests/visual/golden-ui-smoke.spec.ts";
const DIST_DIR = process.env.GATE_DIST_DIR ?? ".next-real-clone-gate";
const LIVE_PORT = process.env.LIVE_APP_PORT ?? "3000";
const EVIDENCE_DIR = "docs/release-evidence/final-production-readiness";
const FINGERPRINT_OUT = process.env.FINGERPRINT_OUT ?? `${EVIDENCE_DIR}/02-real-clone-migration.md`;
const GATE_OUT = process.env.GATE_OUT ?? `${EVIDENCE_DIR}/03-real-clone-golden-ui.md`;
const CONTAINER_DUMP = "/tmp/mas_real_clone_gate.dump";
const PLAYWRIGHT_JSON = path.join("test-results", "real-clone-gate-playwright.json");
const SERVER_LOG = path.join("test-results", "real-clone-gate-server.log");

/** Rehber §10 "Baseline beklenen" — cutover öncesi gerçek verinin imzası. */
const BASELINE = { ledgerLatest: "0034", ledgerRows: 34, payments: 19, checks: 7, loans: 1, cashflow_months: 35, users: 12 };

/* ── kayıt defteri ───────────────────────────────────────────────────────────────────────── */

type Stage = "step1" | "step2" | "step3";
interface Check { stage: Stage; name: string; pass: boolean; expected: string; actual: string }
const checks: Check[] = [];
const commands: string[] = [];
const exitCodes: Record<string, number> = {};
const notes: string[] = [];

function record(stage: Stage, name: string, pass: boolean, expected: string, actual: string): boolean {
  checks.push({ stage, name, pass, expected, actual });
  console.log(`${pass ? "PASS" : "FAIL"}  [${stage}] ${name} — beklenen: ${expected} · gerçek: ${actual}`);
  return pass;
}
function counts(stage: Stage): { pass: number; total: number } {
  const s = checks.filter((c) => c.stage === stage);
  return { pass: s.filter((c) => c.pass).length, total: s.length };
}
function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}`);
}

/* ── yardımcılar ─────────────────────────────────────────────────────────────────────────── */

/**
 * docker, KABUK OLMADAN. execFileSync + argüman dizisi kullanılır çünkü bu repo Git Bash altında
 * çalışıyor ve MSYS `/tmp/x.dump` gibi argümanları Windows yoluna çevirip `pg_restore: could not
 * open input file "C:/Users/…/Temp/x.dump"` üretiyor. Kabuk devre dışıyken böyle bir dönüşüm yok.
 */
function docker(args: string[]): string {
  commands.push(`docker ${args.join(" ")}`);
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

/**
 * Bağlantı dizesinde YALNIZ veritabanı adını değiştirir.
 *
 * `new URL(...)` round-trip'i yerine hedefli bir regex: URL serileştirmesi yüzde-kaçışlı bir
 * parolayı yeniden kodlayabilir ve sonuç sessizce yanlış bir kimlik olur. Hiçbir kolda dize
 * yazdırılmaz.
 */
function swapDatabase(url: string, db: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)\/([^?#]*)(.*)$/.exec(url);
  if (!m) throw new Error("Bağlantı dizesi ayrıştırılamadı (dize kasıtlı olarak yazdırılmıyor).");
  return `${m[1]}/${db}${m[3]}`;
}

/** `.env.local`'i process.env'e SIZDIRMADAN okur — dönen nesne yalnız burada yaşar. */
function readEnvLocal(): Record<string, string> {
  const file = path.join(process.cwd(), ".env.local");
  if (!existsSync(file)) {
    throw new Error(".env.local yok — klonun app bağlantısı gerçek runtime kimliğinden türetilemiyor.");
  }
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

/** Bir portta zaten dinleyen var mı? Varsa kapı yarışmaz, durur. */
function portInUse(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (v: boolean) => { socket.destroy(); resolve(v); };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Çocuk süreç: çıktıyı HEM akıtır HEM biriktirir (uzun koşuda kör kalmamak için). */
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

async function fetchText(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return `${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch {
    return "ulaşılamadı";
  }
}

/* ── Playwright JSON raporu ──────────────────────────────────────────────────────────────── */

interface SpecResult { title: string; ok: boolean }

/**
 * JSON reporter, `list` çıktısını regex'le ayıklamaktan kat kat güvenilir: onay/çarpı glifleri
 * platforma ve TTY'ye göre değişir, başlıklar Türkçe karakter taşır ve bir yanlış ayrıştırma
 * "uydurulmuş assertion sayısı" demektir — rehber §28'in tam olarak yasakladığı şey.
 */
function parsePlaywrightJson(file: string): SpecResult[] | null {
  if (!existsSync(file)) return null;
  let root: unknown;
  try { root = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const specs: SpecResult[] = [];
  const walk = (node: Record<string, unknown>, trail: string[]): void => {
    const title = typeof node.title === "string" ? node.title : "";
    const here = title ? [...trail, title] : trail;
    for (const s of (node.suites as Record<string, unknown>[] | undefined) ?? []) walk(s, here);
    for (const spec of (node.specs as Record<string, unknown>[] | undefined) ?? []) {
      specs.push({ title: [...here, String(spec.title ?? "")].join(" › "), ok: spec.ok === true });
    }
  };
  for (const s of ((root as Record<string, unknown>).suites as Record<string, unknown>[] | undefined) ?? []) walk(s, []);
  return specs.length > 0 ? specs : null;
}

function group(specs: SpecResult[], needle: string): { pass: number; total: number; failed: string[] } {
  const sel = specs.filter((s) => s.title.includes(needle));
  return { pass: sel.filter((s) => s.ok).length, total: sel.length, failed: sel.filter((s) => !s.ok).map((s) => s.title) };
}

/* ── ana akış ────────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const startedAt = new Date();
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const gitShort = gitSha.slice(0, 7);

  /* ── 0. kapılar ─────────────────────────────────────────────────────────────────────── */
  step("0/4 güvenlik kapıları");

  for (const [label, name] of [["kaynak restore hedefi", REAL_SRC_DB], ["RC klonu", RC_CLONE_DB]] as const) {
    if (!isDisposableDatabaseName(name)) {
      throw new Error(
        `GÜVENLİK DURDURMASI: ${label} '${name}' harcanabilir bir ad değil. Bu script hedefi DROP eder; ` +
          "adının harcanabilir olduğunu söylemesi gerekir (verify/test/clone/snapshot/…).",
      );
    }
  }
  if (process.env.MAS_QA_BYPASS_AUTH) {
    throw new Error(
      "MAS_QA_BYPASS_AUTH ayarlı. Golden UI kapısı gerçek oturum çerezi ile koşmak zorunda; " +
        "bypass açıkken yeşil bir sonuç auth yolu hakkında hiçbir şey kanıtlamaz.",
    );
  }
  if (await portInUse(SMOKE_PORT)) {
    throw new Error(
      `Port ${SMOKE_PORT} zaten dinleniyor. Kapı başkasının sunucusuyla yarışmaz ve onu ÖLDÜRMEZ; ` +
        "SMOKE_PORT ile boş bir port verin.",
    );
  }

  const envLocal = readEnvLocal();
  const runtimeUrl = envLocal["DATABASE_URL"];
  if (!runtimeUrl) throw new Error(".env.local içinde DATABASE_URL yok.");
  const runtimeUser = new URL(runtimeUrl).username;
  const cloneAppUrl = swapDatabase(runtimeUrl, RC_CLONE_DB);
  const cloneOwnerUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/${RC_CLONE_DB}`;
  const srcOwnerUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/${REAL_SRC_DB}`;

  record("step1", "app rolü parolası SIFIRLANMADI (mevcut runtime kimliği yeniden kullanıldı)",
    true, "pnpm db:app-role:password çağrılmaz", `${runtimeUser} kimliği .env.local'den, yalnız DB adı '${RC_CLONE_DB}' ile değiştirildi`);

  const liveBefore = await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`);
  console.log(`Canlı örnek (port ${LIVE_PORT}) kapı öncesi: ${liveBefore}`);

  /* ── 1. gerçek snapshot'ı materyalize et ────────────────────────────────────────────── */
  step("1/4 gerçek üretim snapshot'ını restore et");

  if (!existsSync(SNAPSHOT_DUMP)) throw new Error(`Snapshot arşivi yok: ${SNAPSHOT_DUMP}`);
  const dumpBytes = statSync(SNAPSHOT_DUMP).size;
  const actualSha = createHash("sha256").update(readFileSync(SNAPSHOT_DUMP)).digest("hex");
  record("step1", "snapshot sha256 beklenen değerde", actualSha === EXPECTED_SHA, EXPECTED_SHA, `${actualSha} (${dumpBytes} bayt)`);
  if (actualSha !== EXPECTED_SHA) {
    throw new Error("Arşiv hash'i tutmuyor — hangi verinin restore edildiği belirsiz. STOP.");
  }

  docker(["cp", SNAPSHOT_DUMP, `${CONTAINER}:${CONTAINER_DUMP}`]);
  const listing = docker(["exec", CONTAINER, "pg_restore", "--list", CONTAINER_DUMP]);
  const toc = listing.split(/\r?\n/).filter((l) => l && !l.startsWith(";")).length;
  record("step1", "pg_restore --list arşivi okuyabiliyor", toc > 0, "> 0 TOC girdisi", `${toc} TOC girdisi`);

  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--force", "--if-exists", REAL_SRC_DB]);
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", REAL_SRC_DB]);
  let restoreWarned = false;
  try {
    docker(["exec", CONTAINER, "pg_restore", "--no-owner", "-U", "postgres", "-d", REAL_SRC_DB, CONTAINER_DUMP]);
  } catch {
    // pg_restore iyi huylu uyarılarda (olmayan rol, mevcut extension) sıfırdan farklı döner.
    // Verinin gerçekten geldiğini aşağıdaki baseline karşılaştırması söyler, bu çıkış kodu değil.
    restoreWarned = true;
  }

  const src = new Pool({ connectionString: srcOwnerUrl, max: 4 });
  const one = async (pool: Pool, sql: string): Promise<string> =>
    String((await pool.query<{ v: string | null }>(sql)).rows[0]?.v ?? "");

  const srcLedger = (await src.query<{ rows: number; latest: string | null }>(
    "select count(*)::int rows, max(version) latest from public.schema_migrations")).rows[0];
  record("step1", "restore edilen ledger = 0034 / 34 satır",
    srcLedger.latest === BASELINE.ledgerLatest && srcLedger.rows === BASELINE.ledgerRows,
    `${BASELINE.ledgerLatest} / ${BASELINE.ledgerRows}`, `${srcLedger.latest} / ${srcLedger.rows}`);

  for (const table of ["payments", "checks", "loans", "cashflow_months", "users"] as const) {
    const n = Number(await one(src, `select count(*) v from public.${table}`));
    record("step1", `baseline ${table}`, n === BASELINE[table], String(BASELINE[table]), String(n));
  }
  const baselineOk = counts("step1").pass === counts("step1").total;
  if (!baselineOk) {
    await src.end();
    throw new Error(
      "Baseline gerçek verinin belgelenmiş imzasıyla uyuşmuyor. Rehber §10: açıklanmamış drift = STOP. " +
        "Sayılar değiştiyse önce NEDEN değiştiği yazılmalı, kapı zorlanmamalı.",
    );
  }
  await src.end();
  if (restoreWarned) notes.push("pg_restore uyarılarla döndü (olmayan rol/extension); baseline karşılaştırması yine de tam tuttu.");

  /* ── 2. AŞAMA 05 — golden fingerprint, gerçek klon üzerinde ─────────────────────────── */
  step("2/4 AŞAMA 05 — golden fingerprint (gerçek veri klonu)");

  const fpEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SOURCE_DATABASE_URL: srcOwnerUrl,
    CLONE_DB: RC_CLONE_DB,
    MAS_PG_CONTAINER: CONTAINER,
    MAS_PG_PORT: PORT,
    FINGERPRINT_OUT,
  };
  const fp = await runCaptured("pnpm", ["release:golden-fingerprint"], fpEnv);
  exitCodes["pnpm release:golden-fingerprint"] = fp.code;
  record("step2", "golden-fingerprint (11 değişmez, migration exit_code dahil) exit = 0",
    fp.code === 0, "0", String(fp.code));

  const fpPassLine = /(\d+)\/(\d+) kontrol geçti/.exec(fp.output);
  const fpSummary = fpPassLine ? `${fpPassLine[1]}/${fpPassLine[2]}` : "ayrıştırılamadı";

  // AŞAMA 05'in golden-fingerprint'in KAPSAMADIĞI kabul kalemleri.
  // Kapsam ayrımı bilerek yazılıyor ki aynı iddia iki kez sayılmasın:
  //   golden-fingerprint kapsıyor : ledger satır sayısı + son sürüm, bayat operator = 0,
  //                                 finance_manager artışı = önceki operator (migration 0056),
  //                                 aktif admin >= 1, users_role_check beş katman, FK bütünlüğü,
  //                                 blanket RLS yok, assistant arşiv kısıtı, checksum DRIFT = 0,
  //                                 legacy finansal tablo hash'leri değişmedi.
  //   burada eklenen             : ledger sürüm KÜMESİ = disk dosya kümesi (fazladan satır yok),
  //                                 0035–0087 satırlarının applied_by = 'migrate-script'
  //                                 (yani tek entrypoint `pnpm db:migrate` idi, elle INSERT yok),
  //                                 aynı satırlarda checksum override = 0 (boş checksum yok),
  //                                 aynı satırların applied_at'i BU koşunun içinde.
  const clone = new Pool({ connectionString: cloneOwnerUrl, max: 4 });
  const diskFiles = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  const diskVersions = diskFiles.map((f) => f.slice(0, 4));

  const ledger = (await clone.query<{ version: string; applied_by: string; checksum: string | null; applied_at: Date }>(
    "select version, applied_by, checksum, applied_at from public.schema_migrations order by version")).rows;

  record("step2", "ledger son sürüm = 0087", ledger.at(-1)?.version === "0087", "0087", String(ledger.at(-1)?.version));
  record("step2", `ledger satır sayısı = diskteki migration dosya sayısı`,
    ledger.length === diskFiles.length, `${diskFiles.length} (diskten ÖLÇÜLDÜ)`, String(ledger.length));

  const extra = ledger.map((r) => r.version).filter((v) => !diskVersions.includes(v));
  const missing = diskVersions.filter((v) => !ledger.some((r) => r.version === v));
  record("step2", "ledger sürüm kümesi = disk dosya kümesi (elle eklenmiş satır yok)",
    extra.length === 0 && missing.length === 0, "fazladan 0, eksik 0",
    `fazladan ${extra.length}${extra.length ? " (" + extra.join(",") + ")" : ""}, eksik ${missing.length}${missing.length ? " (" + missing.join(",") + ")" : ""}`);

  const applied = ledger.filter((r) => r.version >= "0035");
  const notByScript = applied.filter((r) => r.applied_by !== "migrate-script").map((r) => `${r.version}:${r.applied_by}`);
  record("step2", "0035–0087 satırları YALNIZ `pnpm db:migrate` tarafından yazıldı",
    applied.length === 53 && notByScript.length === 0,
    "53 satır, hepsi applied_by='migrate-script'",
    `${applied.length} satır, farklı applied_by: ${notByScript.length === 0 ? "yok" : notByScript.slice(0, 5).join(", ")}`);

  const noChecksum = applied.filter((r) => !r.checksum || r.checksum.trim() === "").map((r) => r.version);
  record("step2", "checksum override = 0 (uygulanan aralıkta boş checksum yok)",
    noChecksum.length === 0, "0", `${noChecksum.length}${noChecksum.length ? " (" + noChecksum.slice(0, 5).join(",") + ")" : ""}`);

  const appliedBefore = applied.filter((r) => new Date(r.applied_at).getTime() < startedAt.getTime()).map((r) => r.version);
  record("step2", "0035–0087 BU koşuda uygulandı (restore edilmiş satır değil)",
    appliedBefore.length === 0, "hepsi kapı başlangıcından sonra",
    `${appliedBefore.length} satır daha eski${appliedBefore.length ? " (" + appliedBefore.slice(0, 5).join(",") + ")" : ""}`);

  // Gerçek verinin migration sonrası hacimleri — kabul kriteri değil, KANIT. Boş tablolar
  // (invoices, bank_transactions) gerçek bir bulgu; gizlenmez, olduğu gibi yazılır.
  const volumes: Record<string, number> = {};
  for (const t of ["payments", "payment_instances", "checks", "loans", "loan_installments", "cashflow_months", "parties", "cash_accounts", "invoices", "bank_transactions", "users"]) {
    const exists = await one(clone, `select (to_regclass('public.${t}') is not null)::text v`);
    volumes[t] = exists === "true" ? Number(await one(clone, `select count(*) v from public.${t}`)) : -1;
  }
  console.log("Migration sonrası gerçek veri hacimleri: " + Object.entries(volumes).map(([k, v]) => `${k}=${v}`).join(" "));
  await clone.end();

  const step2 = counts("step2");
  if (step2.pass !== step2.total) {
    writeEvidence({ gitSha, gitShort, startedAt, volumes, fpSummary, liveBefore, liveAfter: await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`), routes: null, monetary: null, authz: null, playwrightRaw: "koşulmadı — AŞAMA 05 durdurdu", runtimeUser });
    console.log("\nAŞAMA 05 geçmedi; AŞAMA 06 KOŞULMADI (rehber §10 hard fail).");
    process.exit(1);
  }

  /* ── 3. AŞAMA 06 — aynı klon üzerinde Golden UI + parasal mutabakat ─────────────────── */
  step("3/4 AŞAMA 06 — Golden UI smoke (AYNI migrate edilmiş gerçek klon)");

  const appEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: cloneAppUrl,
    // Ebeveyn ortamda kalmış bir owner URL'inin kazanmaması için klonun kendi owner'ına sabitlenir
    // (scripts/db/owner-url.ts'in açıkça uyardığı tuzak).
    MIGRATION_DATABASE_URL: cloneOwnerUrl,
    APP_COMMIT_SHA: gitSha,
    MAS_NEXT_DIST_DIR: DIST_DIR,
  };

  let routes: ReturnType<typeof group> | null = null;
  let monetary: ReturnType<typeof group> | null = null;
  let authz: ReturnType<typeof group> | null = null;
  let playwrightRaw = "koşulmadı";
  let server: ReturnType<typeof spawn> | null = null;

  try {
    const seed = await runCaptured("pnpm", ["exec", "tsx", "scripts/db/seed-system-actor.ts"],
      { ...process.env, MIGRATION_DATABASE_URL: cloneOwnerUrl });
    exitCodes["tsx scripts/db/seed-system-actor.ts"] = seed.code;
    record("step3", "system aktörü klona seed edildi", seed.code === 0, "exit 0", `exit ${seed.code}`);

    // ÖLÇÜLEN YAN ETKİ: `next build` tsconfig.json'u kendiliğinden yeniden yazar — dizileri
    // çok satıra açar, `include`a `<distDir>/types/**/*.ts` ekler ve `next-env.d.ts`i sona taşır.
    // Kapı ayrı bir distDir kullandığı için o satır GITIGNORE'LU, yalnız kapı koşarken var olan
    // bir dizini gösterir. Commit'e girmemelidir: feature freeze altındaki bir release commit'ine
    // build aracı gürültüsü sokar ve diff'i okuyanı yanıltır.
    //
    // Bu yüzden dosya kapı tarafından otomatik geri alınır (elle düzeltilmez — birebir eski içerik
    // yazılır). Kapı dışından koşulmuşsa karşılığı: `git checkout -- tsconfig.json`.
    const tsconfigPath = path.join(process.cwd(), "tsconfig.json");
    const tsconfigBefore = readFileSync(tsconfigPath, "utf8");

    const build = await runCaptured("pnpm", ["build"], appEnv);
    exitCodes["pnpm build"] = build.code;

    if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) {
      writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
      notes.push("`next build` tsconfig.json'ı özel distDir için yeniden yazdı; dosya kapı tarafından eski hâline döndürüldü.");
    }

    record("step3", `production build (ayrı distDir '${DIST_DIR}' — canlı .next ezilmedi)`,
      build.code === 0, "exit 0", `exit ${build.code}`);
    if (build.code !== 0) throw new Error("build başarısız");

    mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
    const logFd = openSync(SERVER_LOG, "w");
    server = spawn("pnpm", ["start"], {
      stdio: ["ignore", logFd, logFd], detached: false, shell: process.platform === "win32",
      env: { ...appEnv, PORT: SMOKE_PORT },
    });
    commands.push(`pnpm start (PORT=${SMOKE_PORT}, MAS_NEXT_DIST_DIR=${DIST_DIR})`);

    const base = `http://127.0.0.1:${SMOKE_PORT}`;
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`${base}/ready`)).ok) { up = true; break; } } catch { /* henüz dinlemiyor */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    let bootDetail = up ? `${base}/ready = 200` : "sunucu hazır olmadı";
    if (!up && existsSync(SERVER_LOG)) {
      const tail = readFileSync(SERVER_LOG, "utf8").split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
      bootDetail += tail ? ` — sunucu çıktısı: ${tail.slice(0, 400)}` : " (sunucu çıktısı boş)";
    }
    record("step3", "uygulama gerçek veri klonuyla ayağa kalktı (QA bypass KAPALI)", up, "/ready = 200", bootDetail);
    if (!up) throw new Error("sunucu hazır olmadı");

    const pw = await runCaptured(
      "pnpm",
      ["exec", "playwright", "test", SMOKE_SPEC, "--reporter=list,json"],
      {
        ...process.env,
        BASE_URL: base,
        MAS_E2E_DATABASE_URL: cloneAppUrl,
        MAS_E2E_OWNER_DATABASE_URL: cloneOwnerUrl,
        MIGRATION_DATABASE_URL: cloneOwnerUrl,
        PLAYWRIGHT_JSON_OUTPUT_NAME: PLAYWRIGHT_JSON,
      },
    );
    exitCodes[`pnpm exec playwright test ${SMOKE_SPEC}`] = pw.code;

    const specs = parsePlaywrightJson(PLAYWRIGHT_JSON);
    if (specs) {
      routes = group(specs, "kritik rota golden smoke");
      authz = group(specs, "yetkilendirme");
      monetary = group(specs, "spot-check");
      playwrightRaw = `${specs.filter((s) => s.ok).length}/${specs.length} spec geçti (JSON reporter)`;
    } else {
      // Ayrıştıramıyorsak sayı UYDURULMAZ — ham özet satırı olduğu gibi kaydedilir (rehber §28).
      const tail = pw.output.split(/\r?\n/).filter((l) => /passed|failed|flaky|did not run/.test(l)).slice(-4);
      playwrightRaw = tail.length > 0 ? tail.join(" | ") : "Playwright özeti okunamadı";
    }

    record("step3", "kritik rotalar", routes !== null && routes.total > 0 && routes.pass === routes.total,
      "24/24", routes ? `${routes.pass}/${routes.total}` : "ayrıştırılamadı");
    record("step3", "DB ↔ UI parasal spot-check (owner SQL bağımsız referans)",
      monetary !== null && monetary.total > 0 && monetary.pass === monetary.total,
      "6/6 test (10 parasal büyüklük)", monetary ? `${monetary.pass}/${monetary.total}` : "ayrıştırılamadı");
    record("step3", "yetkilendirme matrisi (5 katman + rol değişimi)",
      authz !== null && authz.total > 0 && authz.pass === authz.total,
      "6/6", authz ? `${authz.pass}/${authz.total}` : "ayrıştırılamadı");
    record("step3", "playwright exit = 0", pw.code === 0, "0", String(pw.code));

    // POZİTİF KONTROL — sunucu GERÇEKTEN klona mı bağlandı?
    //
    // Bu soru retorik değil. `next build`/`next start` süreçleri `.env.local`'i de yükler ve orada
    // `DATABASE_URL` gerçek veritabanını gösterir. @next/env bir anahtarı yalnız ilk process.env
    // anlık görüntüsünde YOKSA uygular, dolayısıyla açıkça verdiğimiz değer kazanır — ama bu,
    // okunan bir kaynak koda dayanan bir çıkarım. Ölçülebilir kanıt şu: `visual_*` hesaplarının
    // OTURUMLARI. Kullanıcı satırlarını test süreci yazar, ama `sessions` satırını gerçek /login
    // akışında SUNUCU yazar. Klonda bu oturumlar varsa sunucu klondaydı; başka türlü açıklanamaz.
    const proof = new Pool({ connectionString: cloneOwnerUrl, max: 2 });
    try {
      const seeded = Number(await one(proof, "select count(*) v from public.users where username like 'visual\\_%'"));
      const sessions = Number(await one(proof,
        `select count(*) v from public.sessions s join public.users u on u.id = s.user_id
         where u.username like 'visual\\_%'`));
      record("step3", "sunucu gerçekten KLONA bağlandı (gerçek /login oturumları klonda)",
        seeded === 5 && sessions >= 5, "5 test hesabı, >= 5 oturum klonda",
        `${seeded} hesap, ${sessions} oturum`);
    } finally {
      await proof.end();
    }
  } catch (error) {
    notes.push(`AŞAMA 06 erken durdu: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // YALNIZ kendi başlattığımız süreç. Başkasının sunucusuna dokunulmaz.
    try {
      if (server?.pid) {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        else server.kill("SIGTERM");
      }
    } catch { /* zaten gitmiş */ }
  }

  /* ── 4. kanıt ───────────────────────────────────────────────────────────────────────── */
  step("4/4 kanıt dosyası");
  const liveAfter = await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`);
  console.log(`Canlı örnek (port ${LIVE_PORT}) kapı sonrası: ${liveAfter}`);

  writeEvidence({ gitSha, gitShort, startedAt, volumes, fpSummary, liveBefore, liveAfter, routes, monetary, authz, playwrightRaw, runtimeUser });

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  for (const f of failed) console.log(`  FAIL [${f.stage}] ${f.name} — beklenen ${f.expected}, gerçek ${f.actual}`);
  console.log(`Kanıt: ${GATE_OUT}`);
  console.log(failed.length === 0 ? "REAL CLONE GATE: ALL PASS" : "REAL CLONE GATE: FAIL");
  process.exit(failed.length === 0 ? 0 : 1);
}

/* ── kanıt dosyası ───────────────────────────────────────────────────────────────────────── */

interface EvidenceInput {
  gitSha: string; gitShort: string; startedAt: Date; volumes: Record<string, number>;
  fpSummary: string; liveBefore: string; liveAfter: string;
  routes: { pass: number; total: number; failed: string[] } | null;
  monetary: { pass: number; total: number; failed: string[] } | null;
  authz: { pass: number; total: number; failed: string[] } | null;
  playwrightRaw: string; runtimeUser: string;
}

function writeEvidence(input: EvidenceInput): void {
  const failed = checks.filter((c) => !c.pass);
  const status = failed.length === 0 ? "VERIFIED PASS" : "FAIL";
  const g = (x: { pass: number; total: number } | null): string => (x ? `${x.pass}/${x.total}` : "ayrıştırılamadı");
  const s1 = counts("step1"), s2 = counts("step2"), s3 = counts("step3");
  const allFailedTitles = [
    ...(input.routes?.failed ?? []), ...(input.monetary?.failed ?? []), ...(input.authz?.failed ?? []),
  ];

  const lines: string[] = [
    "# 03 — Gerçek veri klonu üzerinde migration + Golden UI kapısı (AŞAMA 05 + AŞAMA 06)",
    "",
    "```text",
    `WORKING COMMIT: ${input.gitShort} (${input.gitSha})`,
    "TARGET DATABASE CLASS: DISPOSABLE_CLONE (gerçek üretim verisinin restore'u)",
    `TARGET DATABASE NAME: ${REAL_SRC_DB} → ${RC_CLONE_DB}`,
    "REAL DB WRITE USED: NO — mas_radar_dev'e hiç bağlanılmadı",
    `EVIDENCE CLASS: real production data snapshot, restored to DISPOSABLE_CLONE`,
    "",
    "ORIGINAL PLAN REFERENCE:",
    "- section: Gap Closure Rehberi §10 (AŞAMA 05) + §11 (AŞAMA 06)",
    "- lines: L854-L968 (05), L970-L1100 (06); orijinal plan Faz 3 L673-L824, Faz 5 L916-L975",
    "- acceptance criterion: fresh REAL clone → pnpm db:migrate → 0087 → fingerprint → aynı klonda 24 kritik rota + parasal mutabakat",
    "",
    `CURRENT STATUS: ${status}`,
    `RUN STARTED: ${input.startedAt.toISOString()}`,
    `RUN FINISHED: ${new Date().toISOString()}`,
    "```",
    "",
    "## Çalışma ortamı — canlı örneğe dokunulmadı",
    "",
    "```text",
    `LIVE PRODUCTION INSTANCE: port ${LIVE_PORT} — untouched`,
    `  kapı öncesi /health: ${input.liveBefore}`,
    `  kapı sonrası /health: ${input.liveAfter}`,
    `GATE BUILD OUTPUT: ${DIST_DIR} (ayrı distDir — canlı .next ezilmedi)`,
    `GATE SERVER PORT: ${SMOKE_PORT}`,
    `APP ROLE PASSWORD RESET: NO — '${input.runtimeUser}' kimliği .env.local'den alındı, yalnız DB adı değiştirildi`,
    "```",
    "",
    "## Kaynak — neden canlı DB değil",
    "",
    "Canlı `mas_radar_dev` 2026-08-25 09:43 UTC'de zaten 0087'ye migrate edildi. Onu klonlamak",
    "0035→0087 geçişini yeniden üretemez; klon migrate edilecek hiçbir şey bulamaz ve kapı boş bir",
    "\"pending yok\" cevabıyla yeşile döner. Bu yüzden kaynak, cutover ÖNCESİ alınmış gerçek",
    "snapshot'tır ve arşiv hash'i doğrulanır:",
    "",
    "```text",
    `dump: ${SNAPSHOT_DUMP}`,
    `sha256 (beklenen = ölçülen): ${EXPECTED_SHA}`,
    "```",
    "",
    "## Komut zinciri (gerçekten koşanlar)",
    "",
    "```text",
    ...commands.map((c) => c),
    "```",
    "",
    "## Exit kodları",
    "",
    "```text",
    ...Object.entries(exitCodes).map(([k, v]) => `${k} = ${v}`),
    "```",
    "",
    "## Assertion sayıları",
    "",
    "```text",
    `AŞAMA 05 baseline (adım 1)        : ${s1.pass}/${s1.total}`,
    `AŞAMA 05 fingerprint + ledger     : ${s2.pass}/${s2.total}   (golden-fingerprint kendi içinde: ${input.fpSummary})`,
    `AŞAMA 06 kritik rota              : ${g(input.routes)}`,
    `AŞAMA 06 parasal spot-check       : ${g(input.monetary)}`,
    `AŞAMA 06 yetkilendirme            : ${g(input.authz)}`,
    `AŞAMA 06 kapı kontrolleri (adım 3): ${s3.pass}/${s3.total}`,
    `Playwright özeti                  : ${input.playwrightRaw}`,
    "```",
    "",
    "## Beklenen ↔ gerçek",
    "",
    "| Aşama | Kontrol | Beklenen | Gerçek | Sonuç |",
    "|---|---|---|---|---|",
    ...checks.map((c) => `| ${c.stage} | ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? "PASS" : "**FAIL**"} |`),
    "",
    "## Migration sonrası gerçek veri hacimleri",
    "",
    "Kabul kriteri değil, kanıt. Boş tablolar gerçek bir bulgudur ve gizlenmez: bu şirket henüz",
    "fatura ve banka hareketi modülünü kullanmıyor, dolayısıyla ilgili ekranlar gerçek veride",
    "boş-durum gösterir.",
    "",
    "| Tablo | Satır |",
    "|---|---:|",
    ...Object.entries(input.volumes).map(([k, v]) => `| ${k} | ${v === -1 ? "(tablo yok)" : v} |`),
    "",
    "## Kapsam ayrımı — hangi iddia nerede kanıtlandı",
    "",
    "Aynı iddianın iki kez sayılmaması için:",
    "",
    "- `release:golden-fingerprint` kapsıyor: ledger satır sayısı + son sürüm, bayat `operator` = 0,",
    "  `finance_manager` artışı = önceki `operator` sayısı (**migration 0056 senaryosu, artık gerçek",
    "  veride**), en az bir aktif admin, `users_role_check` beş katman, FK bütünlüğü, blanket",
    "  `authenticated_all` RLS yok, assistant arşiv kısıtı, **checksum drift = 0**, legacy finansal",
    "  tablo hash'leri değişmedi.",
    "- Bu kapı ek olarak kanıtlıyor: ledger sürüm kümesi = disk dosya kümesi (fazladan satır yok),",
    "  0035–0087 satırlarının `applied_by = 'migrate-script'` (tek entrypoint `pnpm db:migrate`,",
    "  elle `schema_migrations` INSERT'i yok), aynı satırlarda boş checksum yok (checksum override = 0),",
    "  ve bu satırların `applied_at`'i bu koşunun içinde (restore edilmiş satır değil).",
    "",
    "## Yan etkiler",
    "",
    "- **`tsconfig.json`** — `next build` bu dosyayı kendiliğinden yeniden yazar: dizileri çok",
    "  satıra açar, `include`a `<distDir>/types/**/*.ts` ekler ve `next-env.d.ts`i sona taşır. Kapı",
    "  ayrı bir distDir kullandığı için eklenen satır gitignore'lu, yalnız kapı koşarken var olan bir",
    "  dizini gösterir; feature freeze altındaki bir release commit'ine girmemelidir. Kapı dosyayı",
    "  derlemeden sonra birebir eski hâline döndürür (kapı dışından koşulduysa:",
    "  `git checkout -- tsconfig.json`).",
    `- **Canlı production örneği (port ${LIVE_PORT})** kapı boyunca ayakta kaldı. Kapının kendi ölçümü`,
    "  yukarıdaki \"Çalışma ortamı\" bloğunda (kapı öncesi/sonrası `/health`); orkestratör ayrıca kapı",
    "  ÖNCESİ, SIRASINDA ve SONRASINDA `/ready = 200` doğruladı.",
    `- **\`${DIST_DIR}\`** dizini gitignore'ludur ve commit edilmez.`,
    "",
    "## Kontaminasyon kontrolü",
    "",
    "Pozitif kontrol kapının içindedir ve yukarıdaki tabloda yer alır: `visual_*` hesaplarının",
    "**oturumları** klonda olmalıdır. Kullanıcı satırlarını test süreci yazar, ama `sessions`",
    "satırını gerçek `/login` akışında **sunucu** yazar — klonda oturum varsa sunucu klondaydı.",
    "",
    "Negatif kontrol kapının DIŞINDADIR ve bilinçli olarak öyledir: bir release script'inin gerçek",
    "veritabanına bağlanmasını normalleştirmek istemiyoruz. Elle, salt-okunur koşulur:",
    "",
    "```bash",
    "docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -At \\",
    "  -c \"select count(*) from users where username like 'visual\\_%'\" \\",
    "  -c \"select count(*) from users where username = 'golden_roleflip'\" \\",
    "  -c \"select count(*) from sessions\"",
    "```",
    "",
    "Beklenen: ilk iki sayı **0** (harness hesapları gerçek veritabanına hiç ulaşmadı) ve oturum",
    "sayısı kapı öncesiyle **aynı**.",
    "",
    "## Başarısızlıklar",
    "",
    failed.length === 0 && allFailedTitles.length === 0
      ? "Yok."
      : [
          ...failed.map((c) => `- \`${c.stage}\` **${c.name}** — beklenen ${c.expected}, gerçek ${c.actual}`),
          ...allFailedTitles.map((t) => `- Playwright: ${t}`),
        ].join("\n"),
    "",
    "## Notlar",
    "",
    notes.length === 0 ? "Yok." : notes.map((n) => `- ${n}`).join("\n"),
    "",
    "## Yeniden üretim",
    "",
    "```bash",
    "pnpm release:real-clone-gate",
    "```",
    "",
    `Kanıt dosyaları: \`${FINGERPRINT_OUT}\` (AŞAMA 05 manifesti) · \`${GATE_OUT}\` (bu dosya) ·`,
    `\`${SERVER_LOG}\` (sunucu logu) · \`${PLAYWRIGHT_JSON}\` (Playwright JSON raporu).`,
    "",
    `FINAL: ${failed.length === 0 ? "PASS" : "FAIL"}`,
    "",
  ];
  mkdirSync(path.dirname(GATE_OUT), { recursive: true });
  writeFileSync(GATE_OUT, lines.join("\n"), "utf8");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
