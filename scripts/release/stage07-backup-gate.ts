// AŞAMA 07 — gerçek kaynaktan yedek / geri yükleme kapısı (rehber §12 Bölüm A–E).
//
// KAPATTIĞI BOŞLUK. `pnpm release:restore-drill` beş kapıyı zaten soruyordu, ama iki şeyi
// yapamıyordu: (1) beşinci adımında `pnpm db:app-role:password` çağırıyor — o script rolü
// CLUSTER genelinde değiştirir ve bu makinede çalışan production örneğinin `.env.local`
// parolasını geçersiz kılar; (2) yedeğin İKİNCİ bir depolama hedefine kopyalandığını ve
// O KOPYANIN kendisinden restore edilebildiğini hiç sormuyordu. Rehber §12 Bölüm C ve E tam
// olarak bunları istiyor, §30.5 ise "dosya var" cevabını açıkça reddediyor.
//
// VERİ SINIFLARI (rehber §29):
//   mas_radar_dev                          REAL_READ_ONLY  — yalnız pg_dump + SELECT
//   mas_radar_stage07_restore              DISPOSABLE_CLONE — kapı sonunda DROP edilir
//   mas_radar_stage07_offdevice_restore    DISPOSABLE_CLONE — kapı sonunda DROP edilir
//
// ÜÇ TEHLİKE VE ELE ALINIŞLARI (real-clone-gate.ts ile aynı disiplin):
//   1. `pnpm db:app-role:password` ÇAĞRILMAZ. Klonun app bağlantısı MEVCUT `.env.local`
//      DATABASE_URL'inden YALNIZ veritabanı adı değiştirilerek türetilir.
//   2. `.next` EZİLMEZ. Kapı düz `pnpm build` koşmaz; hazır bir production derlemesini
//      (MAS_NEXT_DIST_DIR) ayrı bir portta başlatır ve YALNIZ kendi başlattığı süreci öldürür.
//   3. HİÇBİR BAĞLANTI DİZESİ YAZDIRILMAZ — mesajlar yalnız veritabanı ADINI söyler.
//
// SIRA ÖNEMLİ. `pnpm start` çalışma zamanı hazırlığı yapar (system aktörü + ödeme penceresi)
// ve restore edilen kopyaya YAZAR. Bu yüzden bütün fingerprint karşılaştırmaları uygulama
// başlatılmadan ÖNCE biter; tersi sırada "restore veriyi bozdu" gibi görünen bir fark
// aslında uygulamanın kendi yazdığı satırlar olurdu.
//
// Kullanım:
//   MAS_OFFDEVICE_BACKUP_DIR=<hedef> pnpm exec tsx scripts/release/stage07-backup-gate.ts
//
// Ortam: STAGE07_DUMP, RESTORE_DB, OFFDEVICE_RESTORE_DB, MAS_PG_BIN_DIR (PostgreSQL 16 bin
//        dizini; yoksa PATH), STAGE07_PORT (3270), STAGE07_DIST_DIR (.next-real-clone-gate),
//        STAGE07_OUT, SKIP_APP_START=1
//
// WAVE 0 — NATIVE POSTGRESQL 16. Docker kaldırıldı; kapı YALNIZ native çalışma zamanında koşar
// (MAS_PG_RUNTIME=docker reddedilir). Okunabilirlik, sürümler, makbuz probu ve off-device
// doğrulaması scripts/db/backup-adapter.ts üzerinden; harcanabilir hedeflere düşür/yarat/yükle
// yalnız scripts/db/pg-native-restore.ts üzerinden (harcanabilirlik kapısı her çağrının ilk
// ifadesi). İki restore hedefinin owner bağlantısı `.env.local`'deki owner kimliğinden YALNIZ
// veritabanı adı değiştirilerek türetilir — sabit bir parola yok.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { portInUse, readEnvLocal, swapDatabase } from "../db/app-url";
import {
  createBackupAdapter, createDisposableRestoreOps, describeAdapter, withPgRuntimeConfig,
  type BackupAdapter, type DisposableRestoreOps,
} from "../db/backup-adapter";
import { runBackupReceipt } from "../db/backup-receipt";
import { isDisposableDatabaseName } from "../db/owner-url";
import { resolvePgRuntime } from "../db/pg-native";
import { fingerprint, type Fingerprint } from "./lib/fingerprint";
import {
  classifyOffDeviceTarget, copyToTargetVerified, executePrune, formatBytes, listDumps, newestDump,
  planPrune, sha256OfFile, writeStage07Receipt, STAGE07_RECEIPT_FIELDS,
  type Stage07Receipt,
} from "../ops/backup-lib";
import { writeOffDeviceRecord } from "../ops/offdevice-copy";

/* ── ayarlar ─────────────────────────────────────────────────────────────────────────────── */

const SOURCE_DB = process.env.STAGE07_SOURCE_DB ?? "mas_radar_dev";
const BACKUP_DIR = process.env.MAS_BACKUP_DIR ?? "backups";
const DUMP_LABEL = process.env.STAGE07_LABEL ?? "stage07_real";
const RESTORE_DB = process.env.RESTORE_DB ?? "mas_radar_stage07_restore";
const OFFDEVICE_RESTORE_DB = process.env.OFFDEVICE_RESTORE_DB ?? "mas_radar_stage07_offdevice_restore";
const APP_PORT = process.env.STAGE07_PORT ?? "3270";
const DIST_DIR = process.env.STAGE07_DIST_DIR ?? ".next-real-clone-gate";
const LIVE_PORT = process.env.LIVE_APP_PORT ?? "3000";
const EVIDENCE_DIR = "docs/release-evidence/final-production-readiness";
const OUT = process.env.STAGE07_OUT ?? `${EVIDENCE_DIR}/05-real-backup-restore.md`;
const SERVER_LOG = path.join("test-results", "stage07-app-start.log");

/* ── kayıt defteri ───────────────────────────────────────────────────────────────────────── */

type Section = "A" | "B" | "C" | "D" | "E";
interface Check { section: Section; name: string; pass: boolean; expected: string; actual: string }

const checks: Check[] = [];
const commands: string[] = [];
const exitCodes: Record<string, number> = {};
const notes: string[] = [];

const gates: Record<string, string> = {
  "BACKUP EXISTS": "NO",
  "BACKUP READABLE": "NO",
  "BACKUP RESTORABLE": "NO",
  "RESTORED DATA MATCHES": "NO",
  "APP CAN START ON RESTORE": "NO",
  "OFF_DEVICE COPY": "NO",
  "OPERATIONAL SCHEDULE": "NO",
};

function record(section: Section, name: string, pass: boolean, expected: string, actual: string): boolean {
  checks.push({ section, name, pass, expected, actual });
  console.log(`${pass ? "PASS" : "FAIL"}  [${section}] ${name} — beklenen: ${expected} · gerçek: ${actual}`);
  return pass;
}
function counts(section: Section): { pass: number; total: number } {
  const s = checks.filter((c) => c.section === section);
  return { pass: s.filter((c) => c.pass).length, total: s.length };
}
function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}`);
}

/* ── yardımcılar ─────────────────────────────────────────────────────────────────────────── */

/** main() kurar; sinyal işleyicisi ve `finally` aynı (yalnız native, harcanabilir) yazıcıyı kullanır. */
let restoreOps: DisposableRestoreOps | null = null;

/* ── kesinti temizliği ───────────────────────────────────────────────────────────────────
 *
 * ÖLÇÜLDÜ, VARSAYILMADI: bu kapının bir koşusu 10 dakikalık bir kabuk zaman aşımına takıldı ve
 * SIGTERM ile öldürüldü. `finally` bloğu çalışmadı; geriye iki harcanabilir veritabanı ve
 * (başlamış olsaydı) bir sunucu süreci kaldı. Bırakılan bir klon bir sonraki koşuda "bayat ama
 * dolu" bir hedef demektir ve o hedefin sessizce doğru görünmesi mümkündür.
 *
 * Bu yüzden temizlik yalnız mutlu yola bağlı değil: SIGINT/SIGTERM'de de SENKRON olarak koşar
 * (async temizlik sinyal işleyicisinde tamamlanma şansı bulamaz).
 */
let serverPidForCleanup: number | undefined;
let cleanupArmed = false;

function emergencyCleanup(signal: string): void {
  if (!cleanupArmed) return;
  cleanupArmed = false;
  console.error(`\n${signal} alındı — harcanabilir hedefler ve kapının kendi sunucusu temizleniyor.`);
  if (serverPidForCleanup !== undefined) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(serverPidForCleanup), "/T", "/F"], { stdio: "ignore" });
      else process.kill(serverPidForCleanup, "SIGTERM");
    } catch { /* zaten kapanmış */ }
  }
  for (const db of [RESTORE_DB, OFFDEVICE_RESTORE_DB]) {
    if (!isDisposableDatabaseName(db) || !restoreOps) continue;
    try {
      // Senkron: async temizlik sinyal işleyicisinde tamamlanma şansı bulamaz.
      restoreOps.dropDisposable(db);
      console.error(`  düşürüldü: ${db}`);
    } catch { /* elde ne varsa */ }
  }
  process.exit(130);
}

// swapDatabase / readEnvLocal / portInUse artık scripts/db/app-url.ts'in TEK tanımından geliyor:
// bu dosyadaki kopyalar o dosyanın başlığında anlatılan kaymanın ta kendisiydi.

async function fetchText(url: string, timeoutMs = 4000): Promise<string> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return `${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch {
    return "ulaşılamadı";
  }
}

/** Canlı örneği YALNIZ gözlemler — asla dokunmaz. Tek bir 4 saniyelik istek onu bir kez
 * "ulaşılamadı" diye raporladı; oysa örnek ayaktaydı, sadece kapının yükü altında yavaşlamıştı.
 * Yanlış bir "canlı örnek düştü" satırı, kanıt dosyasındaki en pahalı yanlış cümlelerden biridir. */
async function probeLive(): Promise<string> {
  let last = "ulaşılamadı";
  for (let i = 0; i < 4; i += 1) {
    last = await fetchText(`http://127.0.0.1:${LIVE_PORT}/health`, 10000);
    if (last !== "ulaşılamadı") return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

/** `/health` ilk isteğinde soğuk olabilir: rota ilk kez yükleniyor ve arkasında bir veritabanı
 * gidiş-dönüşü var. İlk koşuda tek bir 4 saniyelik istek "ulaşılamadı" döndürdü ve bu, restore
 * hakkında YANLIŞ bir cevaptı — kapı ölçtüğü şeye zaman tanımadığı için düşmüştü. */
async function fetchHealthWithRetry(base: string): Promise<string> {
  let last = "ulaşılamadı";
  for (let i = 0; i < 6; i += 1) {
    last = await fetchText(`${base}/health`, 15000);
    if (/"db"\s*:\s*"up"/.test(last)) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

/** Alt script'leri KABUKSUZ çalıştırır (`node --import tsx …`). `pnpm exec` + `shell: true`
 * yolu Node'un DEP0190 uyarısını üretiyordu: kabuk açıkken argümanlar kaçışlanmadan
 * birleştirilir. Burada kabuk hiç yok — hem uyarı hem de o sınıf hata ortadan kalkıyor. */
function runCli(args: string[], key: string): { code: number; out: string } {
  commands.push(`node --import tsx ${args.join(" ")}`);
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", ...args], {
      encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"],
    });
    exitCodes[key] = 0;
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    const code = e.status ?? 1;
    exitCodes[key] = code;
    return { code, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message}` };
  }
}

/** `pg_restore --list` — arşivi diskte GERÇEKTEN ayrıştırır (kopya yok, bağlantı yok). Sayı
 * arşivin kendi `TOC Entries:` başlığıdır. */
function tocEntries(adapter: BackupAdapter, dumpPath: string): number {
  commands.push(`pg_restore --list ${path.basename(dumpPath)} (${adapter.sourceLabel} araçlarıyla)`);
  return adapter.verifyRestoreListable(dumpPath).tocEntryCount;
}

/** Arşivi boş bir veritabanına yükler. `--no-owner` EVET, `--no-acl` HAYIR: GRANT'lar
 * yedeğin parçasıdır, uygulamayı dışarıda bırakan bir kurtarma hiçbir şey kurtarmamıştır.
 * pg_restore iyi huylu uyarılarda (olmayan rol, mevcut extension) sıfırdan farklı döner;
 * restore'un gerçekten olduğunu aşağıdaki fingerprint karşılaştırması söyler, çıkış kodu değil. */
function restoreInto(ops: DisposableRestoreOps, dbName: string, dumpPath: string): boolean {
  commands.push(`dropdb --force --if-exists ${dbName} → createdb ${dbName} → pg_restore --no-owner --dbname=${dbName} ${path.basename(dumpPath)}`);
  ops.dropDisposable(dbName);
  ops.createDisposable(dbName);
  return ops.restoreInto(dbName, dumpPath).warned;
}

/**
 * `mas_radar_app` rolünün ETKİN tablo ayrıcalıkları — restore ACL'leri gerçekten geri getirdi mi.
 *
 * İLK HÂLİ VAKUM GEÇİYORDU (rehber §30.1). Sorgu `information_schema.role_table_grants`e
 * bakıyordu ve iki tarafta da SIFIR satır dönüyordu; kontrol "eşit" diyerek PASS veriyordu —
 * hiçbir şey ölçmeden. İki nedenle boştu: (1) o görünüm yalnız oturumun "etkin rolleri" için
 * satır gösterir, postgres süper kullanıcısı için `mas_radar_app` etkin değildir; (2) bu şemada
 * GRANT'lar zaten doğrudan `mas_radar_app`e değil, üyesi olduğu `authenticated` rolüne veriliyor
 * (ölçüldü: `payments` relacl = `authenticated=arwd/postgres`).
 *
 * Doğrusu ETKİN yetkiyi sormaktır: `has_table_privilege` üyelik zincirini de hesaba katar.
 * Kaynak tarafta sonucun SIFIRDAN BÜYÜK olması ayrıca pozitif kontroldür — sorgunun bir şey
 * gördüğünü kanıtlamayan bir eşitlik, eşitlik değildir.
 */
async function appGrantSummary(pool: Pool): Promise<Record<string, number>> {
  const rows = (await pool.query<{ priv: string; n: string }>(
    `select p.priv,
            count(*) filter (where has_table_privilege('mas_radar_app', c.oid, p.priv))::text n
       from pg_class c
       join pg_namespace ns on ns.oid = c.relnamespace
      cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) as p(priv)
      where ns.nspname = 'public' and c.relkind in ('r','p')
      group by p.priv order by p.priv`,
  )).rows;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.priv] = Number(r.n);
  return out;
}

/** RLS politikaları ve satır güvenliği açık tablolar — bu uygulamada yetkilendirmenin
 * kendisi buradadır; politikaları geri getirmeyen bir restore, verisi tam olsa bile
 * güvenlik modelini kaybetmiştir. */
async function securitySummary(pool: Pool): Promise<{ policies: number; rlsTables: number; schemaUsage: boolean }> {
  const policies = Number((await pool.query("select count(*)::int n from pg_policies where schemaname='public'")).rows[0].n);
  const rlsTables = Number((await pool.query(
    `select count(*)::int n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace
      where ns.nspname='public' and c.relkind='r' and c.relrowsecurity`)).rows[0].n);
  const schemaUsage = (await pool.query<{ ok: boolean }>(
    "select has_schema_privilege('mas_radar_app','public','USAGE') ok")).rows[0].ok;
  return { policies, rlsTables, schemaUsage };
}

/* ── canlı kaynak / dondurulmuş arşiv farkı ──────────────────────────────────────────────── */

/** Kaynak CANLI bir veritabanıdır (port 3000'de bir production örneği ona yazıyor). Bu tablolar
 * ve kolonlar yedek alındıktan SONRA da değişmeye devam eder; farkları restore hatası değildir. */
const VOLATILE_TABLES = new Set(["sessions"]);
const VOLATILE_COLUMNS = new Set([
  "last_login_at", "last_seen_at", "last_used_at", "expires_at", "updated_at", "refreshed_at",
]);

async function tableHash(pool: Pool, table: string, cols: string[]): Promise<string> {
  if (cols.length === 0) return "(kolon yok)";
  const projection = cols.map((c) => `t.${JSON.stringify(c)}`).join(", ");
  return (await pool.query<{ hash: string }>(
    `select coalesce(md5(string_agg(h, '' order by h)), 'bos') hash
       from (select md5((${projection})::text) h from public.${table} t) s`,
  )).rows[0].hash;
}

/**
 * Bir hash farkını AÇIKLAR: yalnız oynak kolonlar çıkarıldığında hash'ler eşitleniyorsa fark,
 * yedek ile karşılaştırma arasında geçen sürede canlı kaynağa gelen trafiğin izidir.
 * Eşitlenmiyorsa fark AÇIKLANMAMIŞTIR ve kapı bunu kabul etmez (rehber §10: açıklanmamış drift = STOP).
 */
async function explainHashDrift(
  src: Pool, dst: Pool, table: string, cols: string[],
): Promise<{ explained: boolean; detail: string }> {
  if (VOLATILE_TABLES.has(table)) {
    const sn = Number((await src.query(`select count(*)::int n from public.${table}`)).rows[0].n);
    const dn = Number((await dst.query(`select count(*)::int n from public.${table}`)).rows[0].n);
    return { explained: true, detail: `oynak tablo (canlı oturum deposu): kaynak ${sn} satır, arşiv ${dn} satır` };
  }
  const stable = cols.filter((c) => !VOLATILE_COLUMNS.has(c));
  const dropped = cols.filter((c) => VOLATILE_COLUMNS.has(c));
  if (dropped.length === 0) return { explained: false, detail: "oynak kolon yok — fark açıklanamıyor" };
  const [a, b] = [await tableHash(src, table, stable), await tableHash(dst, table, stable)];
  return a === b
    ? { explained: true, detail: `yalnız oynak kolonlar farklı (${dropped.join(", ")}); kalan ${stable.length} kolonun hash'i AYNI` }
    : { explained: false, detail: `oynak kolonlar (${dropped.join(", ")}) çıkarıldığında da hash farklı — AÇIKLANMAMIŞ` };
}

/**
 * Katı makbuzun (scripts/db/backup-receipt.ts) artık `pgVersion` / `pgDumpVersion` taşıdığını
 * UÇTAN UCA kanıtlar — şemadan geçen gerçek bir makbuz dosyası üreterek.
 *
 * NEDEN GERÇEK KAYNAK ÜZERİNDE DEĞİL. Katı CLI temiz bir git ağacı ister ve bu kapı
 * çalışırken ağaçta bu iş paketinin yeni dosyaları duruyor. O kontrol DOĞRUDUR ve
 * zayıflatılmaz: kanıt bunun yerine bir DISPOSABLE_CLONE üzerinde, kütüphanenin kendi
 * enjeksiyon seam'iyle üretilir. AÇIKÇA KAYBEDİLEN GARANTİ: bu prob makbuzunun git
 * temizlik iddiası taklit edilmiştir; bu yüzden prob makbuzu bir RELEASE makbuzu DEĞİLDİR
 * ve koşu sonunda silinir. Sürüm alanlarının şemaya ve dosyaya gerçekten yazıldığı ise
 * taklit değil, ölçümdür.
 */
async function proveReceiptCarriesVersions(
  dbName: string,
  ownerUrl: string,
  pgEnv: Readonly<Record<string, string | undefined>>,
): Promise<{ ok: boolean; detail: string }> {
  const outDir = path.join("test-results", "stage07-receipt-probe");
  mkdirSync(outDir, { recursive: true });
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Prob makbuzu GERÇEK araç zinciriyle üretilir — yalnız git temizlik iddiası taklittir.
  const adapter = createBackupAdapter({ ownerUrl, env: pgEnv });
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const meta = (await pool.query<{ db: string; sysid: string }>(
      "select current_database() db, (select system_identifier::text from pg_control_system()) sysid")).rows[0];
    const outcome = await runBackupReceipt(
      {
        expectedDatabaseName: meta.db,
        expectedSystemIdentifier: meta.sysid,
        expectedGitBranch: branch,
        expectedGitHead: head,
        container: adapter.sourceLabel,
        label: "stage07_receipt_probe",
        outDir,
      },
      {
        adapter,
        gitStateProvider: { getBranch: () => branch, getHead: () => head, isClean: () => true },
        queryTcpIdentity: async () => ({ databaseName: meta.db, systemIdentifier: meta.sysid }),
        queryLedger: async () => {
          const r = (await pool.query<{ n: string; last: string | null }>(
            "select count(*)::text n, max(version) last from public.schema_migrations")).rows[0];
          if (!r.last) throw new Error("schema_migrations boş");
          return { ledgerCount: Number(r.n), lastMigrationVersion: r.last };
        },
        readDbTimestamp: async () => (await pool.query<{ ts: string }>(
          `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ts`)).rows[0].ts,
      },
    );
    const parsed = JSON.parse(readFileSync(outcome.receiptPath, "utf8")) as Record<string, unknown>;
    const ok = typeof parsed.pgVersion === "string" && typeof parsed.pgDumpVersion === "string";
    const detail = ok
      ? `pgVersion="${String(parsed.pgVersion).slice(0, 28)}…" pgDumpVersion="${String(parsed.pgDumpVersion)}"`
      : "alanlar makbuzda yok";
    // Prob artefaktları bırakılmaz: gerçek finansal veri taşıyan bir dump'ın test-results
    // altında unutulması, bu kapının çözmeye çalıştığı sorunun ta kendisidir.
    for (const p of [outcome.receiptPath, outcome.receipt.path]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* temizlik */ }
    }
    return { ok, detail };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function diffFingerprint(src: Fingerprint, dst: Fingerprint): { countDiff: string[]; aggDiff: string[]; hashDiff: string[] } {
  return {
    countDiff: Object.keys(src.counts).filter((t) => src.counts[t] !== dst.counts[t]),
    aggDiff: Object.keys(src.aggregates).filter((k) => src.aggregates[k] !== dst.aggregates[k]),
    hashDiff: Object.keys(src.hashes).filter((t) => dst.hashes[t] !== undefined && src.hashes[t] !== dst.hashes[t]),
  };
}

/**
 * Budamanın GERÇEKTEN sildiğini ve IMMUTABLE'a dokunmadığını, SENTETİK bir fixture üzerinde
 * kanıtlar.
 *
 * Neden gerçek `backups/` üzerinde değil: bir silme kanıtı, silerek verilir. Gerçek dizinde
 * bunu yapmak 800'den fazla dosyayı yok etmek demektir ve bu, kapının vereceği bir karar
 * değildir (operatör `--apply` ile verir). Fixture aynı kodu, aynı politikayla, atılabilir
 * dosyalar üzerinde koşturur: kuru koşu "silerdim" der, bu test "sildi" der.
 */
function proveRetentionActuallyPrunes(): { ok: boolean; detail: string } {
  const dir = path.join("test-results", "stage07-prune-fixture");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, "-");
  const now = new Date();
  // 120 gün × günde 3 rolling dump — gerçek `backups/` deseninin küçültülmüş hâli.
  for (let day = 1; day <= 120; day += 1) {
    for (let k = 0; k < 3; k += 1) {
      const d = new Date(now.getTime() - day * 86_400_000 + k * 3_600_000);
      writeFileSync(path.join(dir, `migrate-mas_radar_fixture_verify-${stamp(d)}.dump`), "x".repeat(64), "utf8");
    }
  }
  const prunableWithSidecar = `migrate-mas_radar_fixture_verify-${stamp(new Date(now.getTime() - 100 * 86_400_000))}.dump`;
  writeFileSync(path.join(dir, `${prunableWithSidecar}.receipt.json`), "{}", "utf8");
  const immutables = [
    "cutover_A_20260101-1200.dump",
    `stage07_real-${stamp(new Date(now.getTime() - 90 * 86_400_000))}.dump`,
    `migrate-mas_radar_dev-${stamp(new Date(now.getTime() - 95 * 86_400_000))}.dump`,
  ];
  const markedImmutable = `migrate-mas_radar_marked_verify-${stamp(new Date(now.getTime() - 99 * 86_400_000))}.dump`;
  for (const n of [...immutables, markedImmutable]) writeFileSync(path.join(dir, n), "x", "utf8");
  writeFileSync(path.join(dir, `${markedImmutable}.immutable`), "operator: elle korundu", "utf8");

  const before = listDumps(dir).length;
  const plan = planPrune(listDumps(dir));
  const exec = executePrune(plan);
  const after = listDumps(dir);
  const survivors = new Set(after.map((e) => e.name));
  const immutableSurvived = [...immutables, markedImmutable].every((n) => survivors.has(n));
  const sidecarGone = !existsSync(path.join(dir, `${prunableWithSidecar}.receipt.json`));
  const deletedSomething = exec.deletedDumps.length > 0;
  rmSync(dir, { recursive: true, force: true });
  return {
    ok: immutableSurvived && sidecarGone && deletedSomething && exec.failures.length === 0,
    detail:
      `${before} dump → ${exec.deletedDumps.length} silindi, ${after.length} kaldı; ` +
      `IMMUTABLE ${immutableSurvived ? "4/4 hayatta" : "KAYIP"}; ` +
      `yan dosya ${sidecarGone ? "dump ile birlikte silindi" : "SİLİNMEDİ"}; hata ${exec.failures.length}`,
  };
}

/** Restore'un ASLA kaybetmemesi gereken tablolar — bunlarda tek satırlık fark bile kabul edilmez. */
const FINANCIAL_TABLES = [
  "payments", "payment_instances", "checks", "loans", "loan_installments",
  "cashflow_months", "invoices", "bank_transactions", "audit_logs", "parties", "cash_accounts",
] as const;

/**
 * Restore edilen kopyayı kaynakla karşılaştırır ve HER farkı ya eşitlikle ya da ÖLÇÜLMÜŞ bir
 * açıklamayla kapatır.
 *
 * Kaynak canlı olduğu için (port 3000'deki production örneği ona yazmaya devam ediyor) yedek
 * anı ile karşılaştırma anı arasında oturum tabloları ve giriş damgaları değişir. Bunu görmezden
 * gelmek de, "restore bozuk" diye raporlamak da yanlış olur: fark ÖLÇÜLÜR, oynak kolonlar
 * çıkarılınca hash'ler eşitleniyor mu diye SORULUR ve cevabı kanıtla birlikte yazılır.
 */
async function compareAgainstSource(
  section: Section, src: Pool, dst: Pool, srcFp: Fingerprint, dstFp: Fingerprint,
): Promise<boolean> {
  const d = diffFingerprint(srcFp, dstFp);

  const unexplainedCounts: string[] = [];
  const countNotes: string[] = [];
  for (const t of d.countDiff) {
    if (VOLATILE_TABLES.has(t)) countNotes.push(`${t}: ${srcFp.counts[t]} → ${dstFp.counts[t]} (oynak tablo)`);
    else unexplainedCounts.push(`${t}: ${srcFp.counts[t]} → ${dstFp.counts[t]}`);
  }
  record(section, "satır sayıları eşleşiyor (oynak tablolar hariç, farkları ölçülerek)",
    unexplainedCounts.length === 0,
    `${Object.keys(srcFp.counts).length} tablodan ${Object.keys(srcFp.counts).length - VOLATILE_TABLES.size} tanesi birebir`,
    unexplainedCounts.length === 0
      ? `açıklanmamış fark yok${countNotes.length > 0 ? ` · ${countNotes.join("; ")}` : ""}`
      : `açıklanmamış: ${unexplainedCounts.join("; ")}`);

  record(section, "parasal toplamlar eşleşiyor", d.aggDiff.length === 0,
    `${Object.keys(srcFp.aggregates).length} toplam aynı`,
    d.aggDiff.length === 0 ? "tümü aynı" : `farklı: ${d.aggDiff.join(", ")}`);

  const unexplainedHashes: string[] = [];
  const hashNotes: string[] = [];
  for (const t of d.hashDiff) {
    const explanation = await explainHashDrift(src, dst, t, srcFp.columns[t] ?? []);
    if (explanation.explained) hashNotes.push(`${t}: ${explanation.detail}`);
    else unexplainedHashes.push(`${t}: ${explanation.detail}`);
  }
  record(section, "satır hash'leri eşleşiyor (her fark açıklandı)",
    unexplainedHashes.length === 0,
    `${Object.keys(srcFp.hashes).length} tablo`,
    unexplainedHashes.length === 0
      ? `${Object.keys(srcFp.hashes).length - d.hashDiff.length} tablo birebir aynı${hashNotes.length > 0 ? ` · açıklanan drift → ${hashNotes.join(" | ")}` : ""}`
      : `AÇIKLANMAMIŞ: ${unexplainedHashes.join(" | ")}`);
  for (const n of hashNotes) notes.push(`[${section}] canlı kaynak drift'i — ${n}`);

  const financialDiff = FINANCIAL_TABLES.filter((t) =>
    srcFp.counts[t] !== undefined && (srcFp.counts[t] !== dstFp.counts[t] || srcFp.hashes[t] !== dstFp.hashes[t]));
  const financialPresent = FINANCIAL_TABLES.filter((t) => srcFp.counts[t] !== undefined);
  record(section, "finansal tablolar BİREBİR aynı (sayı + hash, istisnasız)",
    financialDiff.length === 0,
    `${financialPresent.length} tablo: ${financialPresent.map((t) => `${t}=${srcFp.counts[t]}`).join(" ")}`,
    financialDiff.length === 0 ? "tümü birebir" : `farklı: ${financialDiff.join(", ")}`);

  record(section, "schema ledger eşleşiyor",
    srcFp.ledger.rows === dstFp.ledger.rows && srcFp.ledger.latest === dstFp.ledger.latest,
    `${srcFp.ledger.rows}/${srcFp.ledger.latest}`, `${dstFp.ledger.rows}/${dstFp.ledger.latest}`);

  const roleDiff = Object.keys(srcFp.roleCounts).filter((r) => srcFp.roleCounts[r] !== dstFp.roleCounts[r]);
  record(section, "kullanıcı rol dağılımı eşleşiyor", roleDiff.length === 0,
    Object.entries(srcFp.roleCounts).map(([k, v]) => `${k}=${v}`).join(" "),
    roleDiff.length === 0 ? "aynı" : `farklı: ${roleDiff.join(", ")}`);

  return unexplainedCounts.length === 0 && d.aggDiff.length === 0 && unexplainedHashes.length === 0
    && financialDiff.length === 0 && roleDiff.length === 0
    && srcFp.ledger.rows === dstFp.ledger.rows && srcFp.ledger.latest === dstFp.ledger.latest;
}

/* ── ana akış ────────────────────────────────────────────────────────────────────────────── */

interface EvidenceInput {
  gitSha: string;
  startedAt: Date;
  finishedAt: Date;
  receipt: Stage07Receipt | null;
  receiptPath: string | null;
  dumpPath: string | null;
  tocCount: number | null;
  srcFp: Fingerprint | null;
  restoredFp: Fingerprint | null;
  offdeviceFp: Fingerprint | null;
  offDeviceKind: string;
  offDeviceEvidence: string;
  offDeviceDest: string | null;
  offDeviceSatisfied: boolean;
  appStartDetail: string;
  liveBefore: string;
  liveAfter: string;
  droppedDbs: string[];
  pruneSummary: string;
  scheduleSummary: string;
  scheduleRegistered: boolean;
  dailyRunSummary: string;
  grantsSource: Record<string, number>;
  grantsRestored: Record<string, number>;
  /** `runtime=native kaynak=native:127.0.0.1:5432` — bağlantı dizesi ASLA. */
  toolchain: string;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  /* ── 0. güvenlik kapıları ───────────────────────────────────────────────────────────── */
  step("0/6 güvenlik kapıları");

  for (const [label, name] of [["restore hedefi", RESTORE_DB], ["off-device restore hedefi", OFFDEVICE_RESTORE_DB]] as const) {
    if (!isDisposableDatabaseName(name)) {
      throw new Error(`GÜVENLİK DURDURMASI: ${label} '${name}' harcanabilir bir ad değil. Bu kapı hedefi DROP eder.`);
    }
  }
  if (isDisposableDatabaseName(SOURCE_DB)) {
    notes.push(`Kaynak '${SOURCE_DB}' harcanabilir işaret taşıyor — beklenen gerçek kaynak değil.`);
  }
  if (await portInUse(APP_PORT)) {
    throw new Error(`Port ${APP_PORT} zaten dinleniyor. Kapı başkasının sunucusuyla yarışmaz ve onu ÖLDÜRMEZ.`);
  }

  const envLocal = readEnvLocal();
  // Araç zinciri ayarları: önce süreç ortamı, yoksa .env.local (yalnız sır-olmayan PG_RUNTIME_ENV_KEYS).
  const pgEnv = withPgRuntimeConfig(process.env, envLocal);
  if (resolvePgRuntime(pgEnv) !== "native") {
    throw new Error("AŞAMA 07 kapısı yalnız native PostgreSQL 16 ile koşar (MAS_PG_RUNTIME=docker reddedildi).");
  }
  const runtimeUrl = envLocal["DATABASE_URL"];
  const ownerRuntimeUrl = envLocal["MIGRATION_DATABASE_URL"];
  if (!runtimeUrl || !ownerRuntimeUrl) throw new Error(".env.local içinde DATABASE_URL / MIGRATION_DATABASE_URL yok.");
  const runtimeUser = new URL(runtimeUrl).username;
  const sourceOwnerUrl = swapDatabase(ownerRuntimeUrl, SOURCE_DB);
  // Harcanabilir hedeflerin owner bağlantısı GERÇEK owner kimliğinden yalnız DB adı değiştirilerek
  // türetilir; eskiden burada sabit bir docker parolası vardı ve native kümede kimlik doğrulamazdı.
  const restoreOwnerUrl = swapDatabase(ownerRuntimeUrl, RESTORE_DB);
  const offdeviceOwnerUrl = swapDatabase(ownerRuntimeUrl, OFFDEVICE_RESTORE_DB);
  const restoreAppUrl = swapDatabase(runtimeUrl, RESTORE_DB);
  // Loopback olmayan bir owner URL'i burada, hiçbir bağlantı açılmadan reddedilir.
  const adapter = createBackupAdapter({ ownerUrl: sourceOwnerUrl, env: pgEnv });
  restoreOps = createDisposableRestoreOps({ ownerUrl: sourceOwnerUrl, env: pgEnv });
  const ops = restoreOps;
  console.log(`Araç zinciri: ${describeAdapter(adapter)}`);

  cleanupArmed = true;
  process.once("SIGINT", () => emergencyCleanup("SIGINT"));
  process.once("SIGTERM", () => emergencyCleanup("SIGTERM"));

  const liveBefore = await probeLive();
  console.log(`Canlı örnek (port ${LIVE_PORT}) kapı öncesi: ${liveBefore}`);

  record("B", "app rolü parolası SIFIRLANMADI (mevcut runtime kimliği yeniden kullanıldı)",
    true, "pnpm db:app-role:password çağrılmaz",
    `'${runtimeUser}' kimliği .env.local'den, yalnız DB adı '${RESTORE_DB}' ile değiştirildi`);

  const droppedDbs: string[] = [];
  let receipt: Stage07Receipt | null = null;
  let receiptPath: string | null = null;
  let dumpPath: string | null = null;
  let tocCount: number | null = null;
  let srcFp: Fingerprint | null = null;
  let restoredFp: Fingerprint | null = null;
  let offdeviceFp: Fingerprint | null = null;
  let offDeviceKind = "YOK";
  let offDeviceEvidence = "MAS_OFFDEVICE_BACKUP_DIR tanımlı değil";
  let offDeviceDest: string | null = null;
  let offDeviceSatisfied = false;
  let appStartDetail = "koşulmadı";
  let grantsSource: Record<string, number> = {};
  let grantsRestored: Record<string, number> = {};
  let pruneSummary = "koşulmadı";
  let scheduleSummary = "koşulmadı";
  let scheduleRegistered = false;
  let dailyRunSummary = "koşu kaydı yok";

  const source = new Pool({ connectionString: sourceOwnerUrl, max: 4 });
  let restored: Pool | null = null;
  let offdevice: Pool | null = null;
  let server: ReturnType<typeof spawn> | null = null;

  try {
    /* ── A. taze gerçek yedek + makbuz ────────────────────────────────────────────────── */
    step("1/6 BÖLÜM A — gerçek kaynaktan yedek ve dokuz alanlı makbuz");

    const explicit = process.env.STAGE07_DUMP;
    const entry = explicit
      ? listDumps(BACKUP_DIR).find((e) => e.fullPath === path.resolve(explicit) || e.name === path.basename(explicit))
      : newestDump(BACKUP_DIR, DUMP_LABEL);
    if (!entry) throw new Error(`'${DUMP_LABEL}' etiketli bir dump bulunamadı (${BACKUP_DIR}).`);
    dumpPath = entry.fullPath;

    const bytes = statSync(dumpPath).size;
    const sha = sha256OfFile(dumpPath);
    record("A", "dump dosyası var ve boş değil", bytes > 0, "> 0 bayt", `${bytes} bayt (${formatBytes(bytes)})`);
    record("A", "sha256 diskten yeniden hesaplandı", /^[0-9a-f]{64}$/.test(sha), "64 hex", `${sha.slice(0, 24)}…`);

    // Katı makbuz (scripts/db/backup-receipt.ts) varsa hash'i onunla ÇAPRAZ doğrulanır:
    // makbuzun iddia ettiği bayt dizisi ile diskteki dosya aynı mı.
    const strictPath = `${dumpPath}.receipt.json`;
    let strictSha: string | null = null;
    let strictMatch = false;
    // Dump ALINDIĞINDA geçerli olan git durumu — kapının koştuğu andaki değil.
    let dumpGitHead = gitSha;
    let dumpGitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    let dumpTreeClean = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "";
    if (existsSync(strictPath)) {
      const strict = JSON.parse(readFileSync(strictPath, "utf8")) as { sha256: string; bytes: number; gitHead: string; gitBranch: string; ledgerCount: number; lastMigrationVersion: string };
      // Katı makbuz dump anının git durumunu TAŞIR ve temiz ağacı zorunlu kılar; dolayısıyla
      // §12'nin `git_sha` alanı için doğru kaynak odur, bu koşunun HEAD'i değil.
      dumpGitHead = strict.gitHead;
      dumpGitBranch = strict.gitBranch;
      dumpTreeClean = true;
      strictSha = sha256OfFile(strictPath);
      strictMatch = strict.sha256 === sha && strict.bytes === bytes;
      record("A", "katı makbuz (git+cluster kimliği) dosyayla eşleşiyor", strictMatch,
        "sha256 ve bayt aynı", strictMatch ? "eşleşti" : `makbuz ${strict.sha256.slice(0, 12)}… / ${strict.bytes}`);
      // Yedeğin alındığı commit ile kapının koştuğu commit AYNI OLMAK ZORUNDA DEĞİL — yedek
      // veriye aittir, koda değil. Ama fark SÖYLENMEK zorundadır: kanıt dosyasında iki farklı
      // SHA görüp açıklamasını bulamayan bir okuyucu, haklı olarak ikisinden birine güvenmez.
      if (strict.gitHead !== gitSha) {
        notes.push(
          `Yedek commit ${strict.gitHead.slice(0, 7)}'te TEMİZ bir ağaçla alındı; kapı ${gitSha.slice(0, 7)}'te koştu ` +
            "(bu iş paketinin dosyaları ağaçta duruyor). Katı makbuzun temiz-ağaç garantisi dump'a aittir ve " +
            "hash ile bu koşuda yeniden doğrulandı; kapının kendi koşusu o garantiyi taşımaz ve taşıdığını iddia etmez.",
        );
      }
      record("A", "katı makbuzun git provenance'ı okunabiliyor ve kayda geçti",
        /^[0-9a-f]{40}$/.test(strict.gitHead), "40 hex git HEAD",
        `${strict.gitHead.slice(0, 7)} (kapı koşusu: ${gitSha.slice(0, 7)}${strict.gitHead === gitSha ? ", aynı" : ", farklı — nota bakın"})`);
    } else {
      record("A", "katı makbuz (git+cluster kimliği) mevcut", false, `${path.basename(strictPath)}`, "yok");
    }

    const meta = (await source.query<{ db: string; sysid: string }>(
      "select current_database() db, (select system_identifier::text from pg_control_system()) sysid")).rows[0];
    record("A", "kaynak veritabanı beklenen", meta.db === SOURCE_DB, SOURCE_DB, meta.db);
    const ledgerRow = (await source.query<{ n: string; last: string | null }>(
      "select count(*)::text n, max(version) last from public.schema_migrations")).rows[0];
    // pg_dump/pg_restore ana sürümü sunucununkiyle aynı değilse burada durur (native okuyucu).
    const versions = adapter.readToolVersions(SOURCE_DB);

    receipt = {
      receiptKind: "mas-stage07-backup-receipt-v1",
      timestamp: new Date().toISOString(),
      source_db: meta.db,
      system_identifier: meta.sysid,
      git_sha: dumpGitHead,
      schema_ledger: `${ledgerRow.n}/${ledgerRow.last ?? "yok"}`,
      file_size: bytes,
      sha256: sha,
      pg_version: versions.pgVersion,
      pg_dump_version: versions.pgDumpVersion,
      git_branch: dumpGitBranch,
      git_tree_clean: dumpTreeClean,
      receipt_written_by_git_sha: gitSha,
      receipt_written_at: new Date().toISOString(),
      dump_path: dumpPath,
      strict_receipt_path: existsSync(strictPath) ? strictPath : null,
      strict_receipt_sha256: strictSha,
      data_class: "REAL_READ_ONLY",
    };
    receiptPath = `${dumpPath}.stage07.json`;
    const receiptSha = writeStage07Receipt(receiptPath, receipt);
    const present = STAGE07_RECEIPT_FIELDS.filter((f) => {
      const v = receipt?.[f];
      return v !== undefined && v !== null && v !== "";
    });
    record("A", "makbuzun dokuz zorunlu alanı dolu (§12 Bölüm A)",
      present.length === STAGE07_RECEIPT_FIELDS.length, `${STAGE07_RECEIPT_FIELDS.length}/9`, `${present.length}/9`);
    console.log(`Makbuz: ${receiptPath} (sha256 ${receiptSha.slice(0, 16)}…)`);

    gates["BACKUP EXISTS"] = bytes > 0 && /^[0-9a-f]{64}$/.test(sha) && strictMatch ? "YES" : "NO";

    /* ── B. okunabilirlik + ayrı hedefe restore ───────────────────────────────────────── */
    step("2/6 BÖLÜM B — okunabilirlik, ayrı hedefe restore, tam karşılaştırma");

    tocCount = tocEntries(adapter, dumpPath);
    record("B", "pg_restore --list arşivi ayrıştırabiliyor", tocCount > 0, "> 0 TOC girdisi", `${tocCount} TOC girdisi`);
    gates["BACKUP READABLE"] = tocCount > 0 ? "YES" : "NO";

    // Kaynağın parmak izi RESTORE'DAN ÖNCE alınır ve tek bir kez kullanılır: iki restore
    // hedefi de AYNI kaynak imzasıyla karşılaştırılır.
    srcFp = await fingerprint(source);
    grantsSource = await appGrantSummary(source);

    const warned = restoreInto(ops, RESTORE_DB, dumpPath);
    if (warned) notes.push("pg_restore uyarılarla döndü (olmayan rol/extension); karşılaştırma yine de tam yapıldı.");
    restored = new Pool({ connectionString: restoreOwnerUrl, max: 4 });
    const restoredTables = Number((await restored.query(
      `select count(*)::int n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind = 'r'`)).rows[0].n);
    record("B", "arşiv boş bir veritabanına yüklendi", restoredTables > 0, "> 0 tablo", `${restoredTables} tablo`);
    gates["BACKUP RESTORABLE"] = restoredTables > 0 ? "YES" : "NO";

    restoredFp = await fingerprint(restored, srcFp.columns);
    const matchesB = await compareAgainstSource("B", source, restored, srcFp, restoredFp);

    grantsRestored = await appGrantSummary(restored);
    const grantKeys = [...new Set([...Object.keys(grantsSource), ...Object.keys(grantsRestored)])].sort();
    const grantDiff = grantKeys.filter((k) => grantsSource[k] !== grantsRestored[k]);
    const grantPositive = Object.values(grantsSource).some((v) => v > 0);
    // POZİTİF KONTROL önce: sorgu kaynakta gerçekten bir şey görüyor mu. Görmüyorsa
    // "iki taraf da eşit" cümlesi hiçbir şey kanıtlamaz (rehber §30.1 vakum geçişi).
    record("B", "ACL pozitif kontrolü — kaynakta app rolünün etkin yetkisi VAR", grantPositive,
      "> 0 tablo", Object.entries(grantsSource).map(([k, v]) => `${k}=${v}`).join(" ") || "(hiç yetki görülmedi)");
    record("B", `ACL geri geldi — '${runtimeUser}' etkin tablo yetkileri kaynakla aynı`,
      grantDiff.length === 0 && grantPositive,
      Object.entries(grantsSource).map(([k, v]) => `${k}=${v}`).join(" "),
      grantDiff.length === 0 ? Object.entries(grantsRestored).map(([k, v]) => `${k}=${v}`).join(" ") : `farklı: ${grantDiff.join(", ")}`);

    const secSrc = await securitySummary(source);
    const secDst = await securitySummary(restored);
    record("B", "RLS politikaları geri geldi", secSrc.policies > 0 && secSrc.policies === secDst.policies,
      `${secSrc.policies} politika`, `${secDst.policies} politika`);
    record("B", "satır güvenliği açık tablolar geri geldi", secSrc.rlsTables > 0 && secSrc.rlsTables === secDst.rlsTables,
      `${secSrc.rlsTables} tablo`, `${secDst.rlsTables} tablo`);
    record("B", "şema USAGE yetkisi geri geldi", secSrc.schemaUsage && secDst.schemaUsage,
      "kaynak true / restore true", `${secSrc.schemaUsage} / ${secDst.schemaUsage}`);

    // Katı makbuz artık dokuz alanın ikisini (pg_version / pg_dump_version) de taşıyor mu —
    // DISPOSABLE_CLONE üzerinde uçtan uca kanıtlanır (bkz. proveReceiptCarriesVersions).
    const versionProof = await proveReceiptCarriesVersions(RESTORE_DB, restoreOwnerUrl, pgEnv);
    record("A", "katı makbuz şeması pg_version + pg_dump_version taşıyor (DISPOSABLE_CLONE üzerinde uçtan uca)",
      versionProof.ok, "her iki alan da makbuz dosyasında", versionProof.detail);

    const ownerRead = Number((await restored.query("select count(*)::int n from public.payments")).rows[0].n);
    record("B", "owner ile login gerekmeyen okuma", ownerRead === srcFp.counts["payments"],
      String(srcFp.counts["payments"]), String(ownerRead));

    const secOk = secSrc.policies > 0 && secSrc.policies === secDst.policies
      && secSrc.rlsTables === secDst.rlsTables && secSrc.schemaUsage && secDst.schemaUsage;
    gates["RESTORED DATA MATCHES"] =
      matchesB && grantDiff.length === 0 && grantPositive && secOk && ownerRead === srcFp.counts["payments"]
        ? "YES" : "NO";

    /* ── C. off-device kopya ──────────────────────────────────────────────────────────── */
    step("3/6 BÖLÜM C — ikinci depolama hedefine kopya ve HEDEFTE doğrulama");

    const targetDir = process.env.MAS_OFFDEVICE_BACKUP_DIR;
    if (!targetDir) {
      record("C", "MAS_OFFDEVICE_BACKUP_DIR tanımlı", false, "bir hedef dizin", "tanımlı değil");
      gates["OFF_DEVICE COPY"] = "NO — hedef tanımlı değil";
    } else {
      const classification = classifyOffDeviceTarget(targetDir, BACKUP_DIR);
      offDeviceKind = classification.kind;
      offDeviceEvidence = classification.evidence;
      offDeviceSatisfied = classification.offDeviceSatisfied;
      const copied = copyToTargetVerified(dumpPath, classification.targetDir, {
        verifyListable: (p) => adapter.verifyRestoreListable(p),
        sourceDir: BACKUP_DIR,
      });
      offDeviceDest = copied.destPath;
      writeOffDeviceRecord(copied);
      commands.push(`MAS_OFFDEVICE_BACKUP_DIR=<hedef> pnpm exec tsx scripts/ops/offdevice-copy.ts --dump ${path.basename(dumpPath)}`);
      record("C", "kopya hedefte oluştu", existsSync(copied.destPath), "dosya var", path.basename(copied.destPath));
      record("C", "HEDEFTEKİ dosyanın sha256'sı kaynakla aynı", copied.sha256Match,
        `${copied.sourceSha256.slice(0, 16)}…`, `${copied.destSha256.slice(0, 16)}…`);
      record("C", "hedefteki boyut kaynakla aynı", copied.bytesMatch, `${copied.sourceBytes}`, `${copied.destBytes}`);
      record("C", "hedefteki kopya hâlâ geçerli bir arşiv (pg_restore --list)", copied.destRestoreListable,
        "> 0 TOC girdisi", `${copied.destTocEntryCount ?? 0} TOC girdisi`);
      record("C", "makbuz yan dosyaları da kopyalandı", copied.sidecarsCopied.length > 0,
        "en az 1 yan dosya", copied.sidecarsCopied.join(", ") || "yok");
      // Rehber §30.5: aynı makinedeki ikinci klasör off-device DEĞİLDİR. Araç bunu ölçer.
      record("C", "hedef fiziksel olarak ayrı bir aygıt", classification.offDeviceSatisfied,
        "REMOVABLE / NETWORK / UNC", `${classification.kind} — ${classification.evidence}`);
      gates["OFF_DEVICE COPY"] = classification.offDeviceSatisfied
        ? "YES"
        : "TOOLING VERIFIED · PHYSICAL TARGET BLOCKED (bu makinede ayrı aygıt yok)";
    }

    /* ── E. saklanan kopyanın KENDİSİNDEN restore ─────────────────────────────────────── */
    step("4/6 BÖLÜM E — saklanan kopyanın KENDİSİNDEN restore");

    if (offDeviceDest && existsSync(offDeviceDest)) {
      const toc2 = tocEntries(adapter, offDeviceDest);
      record("E", "saklanan kopya okunabiliyor", toc2 > 0, "> 0 TOC girdisi", `${toc2} TOC girdisi`);
      restoreInto(ops, OFFDEVICE_RESTORE_DB, offDeviceDest);
      offdevice = new Pool({ connectionString: offdeviceOwnerUrl, max: 4 });
      offdeviceFp = await fingerprint(offdevice, srcFp.columns);
      await compareAgainstSource("E", source, offdevice, srcFp, offdeviceFp);

      // EN KATI KANIT: iki restore de AYNI arşiv baytlarından geldi, dolayısıyla aralarında
      // canlı kaynak drift'i diye bir mazeret YOKTUR — tek bir tabloda tek bir hash farkı bile
      // saklanan kopyanın bozulduğu anlamına gelir. Kaynakla karşılaştırma canlılık gürültüsü
      // taşır; bu karşılaştırma taşımaz.
      if (restoredFp) {
        const pure = diffFingerprint(restoredFp, offdeviceFp);
        record("E", "saklanan kopyadan restore, yerel arşivden restore ile BİREBİR aynı (gürültüsüz kanıt)",
          pure.countDiff.length === 0 && pure.hashDiff.length === 0 && pure.aggDiff.length === 0,
          `${Object.keys(restoredFp.hashes).length} tablo, ${Object.keys(restoredFp.aggregates).length} toplam birebir`,
          pure.countDiff.length === 0 && pure.hashDiff.length === 0 && pure.aggDiff.length === 0
            ? "birebir aynı"
            : `farklı — sayı: ${pure.countDiff.join(", ") || "yok"}; hash: ${pure.hashDiff.join(", ") || "yok"}; toplam: ${pure.aggDiff.join(", ") || "yok"}`);
      }
    } else {
      record("E", "saklanan kopyadan restore denendi", false, "kopya dosyası", "kopya yok — Bölüm C tamamlanmadı");
    }

    /* ── D. operasyonel zamanlama + retention ─────────────────────────────────────────── */
    step("5/6 BÖLÜM D — zamanlama (what-if) ve retention budaması (kuru koşu)");

    const sched = runCli(["scripts/ops/schedule-windows.ts", "status"], "schedule-windows.ts status");
    const registered = /SCHEDULED TASK = REGISTERED/.test(sched.out);
    record("D", "zamanlama durumu sorgulanabiliyor (schtasks)", sched.code === 0, "exit 0", `exit ${sched.code}`);
    const whatIf = runCli(["scripts/ops/schedule-windows.ts", "install"], "schedule-windows.ts install (what-if)");
    const whatIfOk = /WHAT-IF — hiçbir görev KAYDEDİLMEDİ/.test(whatIf.out);
    record("D", "kurulum what-if modunda komutu üretiyor ve KAYIT YAPMIYOR", whatIfOk,
      "what-if çıktısı, kayıt yok", whatIfOk ? "kayıt yapılmadı" : "beklenen çıktı yok");
    // Sorulan şey "görev kayıtlı mı" DEĞİL, "what-if kayıt durumunu değiştirdi mi". Operatör görevi
    // kaydettiğinde (doğru olan budur) eski "hâlâ kayıtlı değil" kontrolü her koşuda düşüyordu.
    const schedAfter = runCli(["scripts/ops/schedule-windows.ts", "status"], "schedule-windows.ts status (what-if sonrası)");
    const registeredAfter = /SCHEDULED TASK = REGISTERED/.test(schedAfter.out);
    record("D", "what-if kayıt durumunu DEĞİŞTİRMEDİ (kullanıcı makinesine kalıcı değişiklik yok)",
      registeredAfter === registered,
      registered ? "REGISTERED → REGISTERED" : "NOT REGISTERED → NOT REGISTERED",
      `${registered ? "REGISTERED" : "NOT REGISTERED"} → ${registeredAfter ? "REGISTERED" : "NOT REGISTERED"}`);
    scheduleRegistered = registered;
    scheduleSummary = `${registered ? "REGISTERED" : "NOT REGISTERED"} · what-if ${whatIfOk ? "üretildi" : "üretilemedi"}`;

    const prune = runCli(["scripts/ops/backup-prune.ts"], "backup-prune.ts (kuru koşu)");
    const planned = /Budanacak\s*:\s*(\d+)/.exec(prune.out);
    const immutable = /IMMUTABLE \(dokunulmaz\):\s*(\d+)/.exec(prune.out);
    record("D", "retention budaması uygulanabilir durumda (kuru koşu)", prune.code === 0, "exit 0", `exit ${prune.code}`);
    record("D", "kuru koşu hiçbir dosya silmedi", /KURU KOŞU/.test(prune.out), "KURU KOŞU satırı", /KURU KOŞU/.test(prune.out) ? "var" : "yok");

    // Budama kararının DOĞRULUĞU: planı kütüphaneden yeniden hesaplayıp immutable dosyaların
    // hiçbirinin silinecekler listesinde olmadığını kanıtla. "Script PASS dedi" kanıt değildir.
    const entries = listDumps(BACKUP_DIR);
    const plan = planPrune(entries);
    const immutablePruned = plan.decisions.filter((x) => !x.keep && x.entry.retentionClass === "immutable");
    record("D", "IMMUTABLE dump'lar budama planında ASLA yok", immutablePruned.length === 0,
      "0 immutable budanıyor", `${immutablePruned.length} immutable budanıyor`);
    const thisDumpDecision = plan.decisions.find((x) => x.entry.fullPath === dumpPath);
    record("D", "bu koşunun gerçek yedeği IMMUTABLE sınıfında", thisDumpDecision?.entry.retentionClass === "immutable",
      "immutable", `${thisDumpDecision?.entry.retentionClass ?? "bulunamadı"} (${thisDumpDecision?.reason ?? "-"})`);
    const pruneProof = proveRetentionActuallyPrunes();
    record("D", "budama SENTETİK fixture üzerinde gerçekten siliyor, IMMUTABLE'a dokunmuyor",
      pruneProof.ok, "immutable 4/4 hayatta, yan dosya dump ile silinir, hata 0", pruneProof.detail);

    // Zamanlanmış işin KENDİSİ koştu mu — koşu kaydı dosyadan okunur, iddiadan değil. Wave 0'dan
    // beri başarısız geceler de `{ ok:false, stage, error }` satırı yazar; bu yüzden "son satır"
    // değil, YEDEK ÜRETEN son koşu aranır ve son başarısızlık ayrıca raporlanır.
    const runLogPath = path.join(BACKUP_DIR, "daily-runs.jsonl");
    if (existsSync(runLogPath)) {
      const runs = readFileSync(runLogPath, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
      const lastBackup = [...runs].reverse().find((r) => typeof r.sha256 === "string");
      const lastFailure = [...runs].reverse().find((r) => r.ok === false);
      dailyRunSummary = `${runs.length} koşu · ` + (lastBackup
        ? `son yedekli koşu: ${String(lastBackup.finishedAt)} · dump ${String(lastBackup.sha256).slice(0, 16)}… · ` +
          `ledger ${String(lastBackup.schema_ledger)} · off-device ${lastBackup.offDeviceOk ? "OK" : "NO"}`
        : "yedek üreten koşu yok") +
        (lastFailure
          ? ` · son başarısız koşu: ${String(lastFailure.finishedAt)} (aşama ${String(lastFailure.stage ?? "?")}, exit ${String(lastFailure.exitCode ?? "?")})`
          : " · başarısız koşu kaydı yok");
      record("D", "günlük yedek işi (zamanlanmış görevin çalıştıracağı script) gerçekten koştu",
        lastBackup !== undefined,
        "backups/daily-runs.jsonl içinde yedek üreten en az bir koşu", dailyRunSummary);
    } else {
      record("D", "günlük yedek işi gerçekten koştu", false, "backups/daily-runs.jsonl", "koşu kaydı yok");
    }

    pruneSummary = `${entries.length} dump (${formatBytes(entries.reduce((s, e) => s + e.bytes, 0))}) · ` +
      `${plan.immutableCount} IMMUTABLE korunuyor · ${planned?.[1] ?? plan.prunedCount} budanabilir ` +
      `(${formatBytes(plan.bytesToFree)}) · uygulanmadı (kuru koşu)`;
    if (immutable) notes.push(`backup-prune.ts kuru koşusu ${immutable[1]} IMMUTABLE dosya saydı.`);

    gates["OPERATIONAL SCHEDULE"] = whatIfOk && prune.code === 0
      ? (registered ? "REGISTERED" : "INSTALLABLE — NOT REGISTERED (operatör adımı)")
      : "NO";

    /* ── B (devam). uygulama restore edilen kopyaya karşı ayağa kalkıyor mu ───────────── */
    step("6/6 BÖLÜM B — uygulama restore edilen kopyayla ayağa kalkıyor mu");

    if (process.env.SKIP_APP_START === "1") {
      record("B", "APP CAN START ON RESTORE", false, "/ready = 200", "SKIP_APP_START=1 ile atlandı");
      appStartDetail = "atlandı (SKIP_APP_START=1)";
      gates["APP CAN START ON RESTORE"] = "NOT VERIFIED";
    } else if (!existsSync(path.join(process.cwd(), DIST_DIR, "BUILD_ID"))) {
      record("B", "APP CAN START ON RESTORE", false, `${DIST_DIR}/BUILD_ID`, "hazır production derlemesi yok");
      appStartDetail = `${DIST_DIR} altında derleme yok`;
      gates["APP CAN START ON RESTORE"] = "NOT VERIFIED";
    } else {
      const buildId = readFileSync(path.join(process.cwd(), DIST_DIR, "BUILD_ID"), "utf8").trim();
      mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
      const logFd = openSync(SERVER_LOG, "w");
      server = spawn("pnpm", ["start"], {
        stdio: ["ignore", logFd, logFd], detached: false, shell: process.platform === "win32",
        env: {
          ...process.env,
          DATABASE_URL: restoreAppUrl,
          MIGRATION_DATABASE_URL: restoreOwnerUrl,
          MAS_NEXT_DIST_DIR: DIST_DIR,
          APP_COMMIT_SHA: gitSha,
          PORT: APP_PORT,
          // Ayrı portta, kendi distDir'iyle BİLEREK ikinci bir sunucu: tek-sunucu kapısı
          // (runtime-port-guard) canlı örneği korumak için var, bu kapıyı durdurmak için değil.
          MAS_ALLOW_PARALLEL_RUNTIME: "1",
        },
      });
      serverPidForCleanup = server.pid;
      commands.push(`pnpm start (PORT=${APP_PORT}, MAS_NEXT_DIST_DIR=${DIST_DIR}, DATABASE_URL → ${RESTORE_DB})`);
      const base = `http://127.0.0.1:${APP_PORT}`;
      let up = false;
      for (let i = 0; i < 60; i += 1) {
        try { if ((await fetch(`${base}/ready`)).ok) { up = true; break; } } catch { /* henüz dinlemiyor */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      const health = up ? await fetchHealthWithRetry(base) : "ulaşılamadı";
      const dbUp = /"db"\s*:\s*"up"/.test(health);
      if (!up && existsSync(SERVER_LOG)) {
        const tail = readFileSync(SERVER_LOG, "utf8").split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
        appStartDetail = `sunucu hazır olmadı — ${tail.slice(0, 400)}`;
      } else {
        appStartDetail = `${base}/ready = 200 · /health = ${health} · derleme ${DIST_DIR} (BUILD_ID ${buildId})`;
      }
      record("B", `uygulama restore edilen '${RESTORE_DB}' ile ayağa kalktı (düşük yetkili '${runtimeUser}' rolüyle)`,
        up, "/ready = 200", up ? "200" : appStartDetail.slice(0, 200));
      record("B", "uygulama restore edilen veritabanına GERÇEKTEN bağlanabiliyor (/health db=up)",
        dbUp, '"db":"up"', health.slice(0, 120));
      gates["APP CAN START ON RESTORE"] = up && dbUp ? "YES" : "NO";
      if (up) {
        notes.push(
          `Uygulama derlemesi YENİDEN ÜRETİLMEDİ: hazır '${DIST_DIR}' (BUILD_ID ${buildId}) yeniden kullanıldı. ` +
            "Düz `pnpm build` canlı `.next`i ezer ve bu makinede port 3000'de bir production örneği çalışıyor. " +
            "Kanıtlanan şey uygulamanın RESTORE EDİLEN VERİTABANIYLA açılabildiğidir; uygulama kodunun " +
            "bu commit'te derlenebildiği ayrı bir kapının işidir.",
        );
      }
    }
  } finally {
    cleanupArmed = false;
    if (server) {
      try {
        if (process.platform === "win32" && server.pid) {
          execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          server.kill("SIGTERM");
        }
      } catch { /* zaten kapanmış */ }
    }
    await source.end().catch(() => undefined);
    if (restored) await restored.end().catch(() => undefined);
    if (offdevice) await offdevice.end().catch(() => undefined);

    // Harcanabilir hedefleri BIRAKMA: bir sonraki koşuya bayat bir kopya miras kalmasın.
    for (const db of [RESTORE_DB, OFFDEVICE_RESTORE_DB]) {
      if (!isDisposableDatabaseName(db)) continue;
      try {
        ops.dropDisposable(db);
        commands.push(`dropdb --force --if-exists ${db}`);
        droppedDbs.push(db);
      } catch (err) {
        notes.push(`'${db}' düşürülemedi: ${(err as Error).message}`);
      }
    }
  }

  const liveAfter = await probeLive();
  console.log(`Canlı örnek (port ${LIVE_PORT}) kapı sonrası: ${liveAfter}`);

  const finishedAt = new Date();
  writeEvidence({
    gitSha, startedAt, finishedAt, receipt, receiptPath, dumpPath, tocCount, srcFp, restoredFp, offdeviceFp,
    offDeviceKind, offDeviceEvidence, offDeviceDest, offDeviceSatisfied, appStartDetail, liveBefore, liveAfter,
    droppedDbs, pruneSummary, scheduleSummary, scheduleRegistered, dailyRunSummary, grantsSource, grantsRestored,
    toolchain: describeAdapter(adapter),
  });

  console.log("\n── AŞAMA 07 kapıları ──────────────────────────────────────────────");
  for (const [k, v] of Object.entries(gates)) console.log(`${k} = ${v}`);
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  console.log(`Kanıt: ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

/* ── kanıt dosyası ───────────────────────────────────────────────────────────────────────── */

function writeEvidence(i: EvidenceInput): void {
  const short = i.gitSha.slice(0, 7);
  const table = (section: Section): string[] => {
    const rows = checks.filter((c) => c.section === section);
    if (rows.length === 0) return ["(kontrol yok)"];
    return [
      "| Kontrol | Beklenen | Gerçek | Sonuç |",
      "|---|---|---|---|",
      ...rows.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.pass ? "PASS" : "**FAIL**"} |`),
    ];
  };
  const failed = checks.filter((c) => !c.pass);
  const yaml = (o: Record<string, unknown>): string[] =>
    Object.entries(o).map(([k, v]) => `  ${k}: ${typeof v === "string" ? `"${v}"` : String(v)}`);

  const lines: string[] = [
    "# 05 — Gerçek kaynaktan yedek / geri yükleme + off-device + zamanlama (AŞAMA 07)",
    "",
    "```text",
    `WORKING COMMIT: ${short} (${i.gitSha})`,
    "TARGET DATABASE CLASS: REAL_READ_ONLY (kaynak) → DISPOSABLE_CLONE (iki restore hedefi)",
    `TARGET DATABASE NAME: ${SOURCE_DB} → ${RESTORE_DB} + ${OFFDEVICE_RESTORE_DB}`,
    "REAL DB WRITE USED: NO — kaynağa yalnız pg_dump ve SELECT uygulandı",
    "",
    "ORIGINAL PLAN REFERENCE:",
    "- section: Gap Closure Rehberi §12 (AŞAMA 07); orijinal plan §9 Faz 6",
    "- lines: L1102-L1216 (rehber), L977-L1043 (orijinal)",
    "- acceptance criterion: fresh real backup + receipt → ayrı hedefe restore → counts/aggregates/hashes/ACL/app start → off-device kopya → saklanan kopyadan restore → operasyonel zamanlama",
    "",
    `CURRENT STATUS: ${
      failed.length === 0
        ? "VERIFIED PASS"
        : failed.every((c) => c.section === "C")
          ? "PARTIAL — yalnız off-device FİZİKSEL hedef BLOCKED; diğer bütün kapılar VERIFIED PASS"
          : "FAIL"
    }`,
    `RUN STARTED: ${i.startedAt.toISOString()}`,
    `RUN FINISHED: ${i.finishedAt.toISOString()}`,
    "```",
    "",
    "## §12 kabul bloğu",
    "",
    "```text",
    ...Object.entries(gates).map(([k, v]) => `${k} = ${v}`),
    "```",
    "",
    "## Çalışma ortamı — canlı örneğe dokunulmadı",
    "",
    "```text",
    `LIVE PRODUCTION INSTANCE: port ${LIVE_PORT} — untouched`,
    `  kapı öncesi /health: ${i.liveBefore}`,
    `  kapı sonrası /health: ${i.liveAfter}`,
    `GATE SERVER PORT: ${APP_PORT}`,
    `GATE BUILD OUTPUT: ${DIST_DIR} (hazır derleme yeniden kullanıldı — canlı .next ezilmedi, yeni build koşulmadı)`,
    "APP ROLE PASSWORD RESET: NO — kimlik .env.local'den alındı, yalnız DB adı değiştirildi",
    `POSTGRES TOOLCHAIN: ${i.toolchain} — parola hiçbir aracın komut satırında değildi`,
    `DISPOSABLE DBs DROPPED: ${i.droppedDbs.join(", ") || "yok"}`,
    "```",
    "",
    "## Bölüm A — gerçek kaynaktan yedek ve makbuz",
    "",
    "```yaml",
    "backup_receipt:",
    ...(i.receipt
      ? yaml({
          timestamp: i.receipt.timestamp,
          source_db: i.receipt.source_db,
          system_identifier: i.receipt.system_identifier,
          git_sha: i.receipt.git_sha,
          schema_ledger: i.receipt.schema_ledger,
          file_size: i.receipt.file_size,
          sha256: i.receipt.sha256,
          pg_version: i.receipt.pg_version,
          pg_dump_version: i.receipt.pg_dump_version,
        })
      : ["  (makbuz üretilemedi)"]),
    "```",
    "",
    ...(i.receipt
      ? [
          `Makbuz dosyası: \`${i.receiptPath}\``,
          `Katı makbuz (git + cluster kimliği, temiz ağaç zorunlu): \`${i.receipt.strict_receipt_path ?? "yok"}\``,
          `Dump: \`${i.dumpPath}\` — ${i.tocCount ?? "?"} TOC girdisi`,
          "",
          "```text",
          `git_sha (DUMP alındığında)  : ${i.receipt.git_sha}  · ağaç temiz: ${i.receipt.git_tree_clean}`,
          `makbuzu yazan koşu (bu kapı): ${i.receipt.receipt_written_by_git_sha ?? "-"}`,
          "```",
          "",
          "İki SHA'nın farklı olması beklenen bir durumdur ve bilerek ayrı alanlarda durur: yedek",
          "VERİYE aittir, koda değil. `git_sha` dump anını anlatır ve kaynağı katı makbuzdur (o CLI",
          "temiz ağaç olmadan koşmaz); ikinci alan yalnız bu kanıt dosyasını kimin ürettiğini söyler.",
          "",
        ]
      : []),
    ...table("A"),
    "",
    "## Bölüm B — ayrı hedefe restore ve tam karşılaştırma",
    "",
    ...table("B"),
    "",
    ...(i.srcFp && i.restoredFp
      ? [
          "```text",
          `kaynak tablo sayısı        : ${Object.keys(i.srcFp.counts).length}`,
          `karşılaştırılan hash sayısı: ${Object.keys(i.srcFp.hashes).length}`,
          `parasal toplam sayısı      : ${Object.keys(i.srcFp.aggregates).length}`,
          `ledger                     : ${i.srcFp.ledger.rows}/${i.srcFp.ledger.latest} → ${i.restoredFp.ledger.rows}/${i.restoredFp.ledger.latest}`,
          `mas_radar_app GRANT (kaynak)   : ${Object.entries(i.grantsSource).map(([k, v]) => `${k}=${v}`).join(" ") || "(yok)"}`,
          `mas_radar_app GRANT (restore)  : ${Object.entries(i.grantsRestored).map(([k, v]) => `${k}=${v}`).join(" ") || "(yok)"}`,
          `uygulama başlangıcı        : ${i.appStartDetail}`,
          "```",
          "",
        ]
      : []),
    "## Bölüm C — off-device kopya",
    "",
    "```text",
    `TARGET DIR   : ${process.env.MAS_OFFDEVICE_BACKUP_DIR ?? "(tanımlı değil)"}`,
    `TARGET KIND  : ${i.offDeviceKind}`,
    `EVIDENCE     : ${i.offDeviceEvidence}`,
    `COPY         : ${i.offDeviceDest ?? "(kopyalanmadı)"}`,
    "",
    "OFF_DEVICE TOOLING         = " + (i.offDeviceDest ? "VERIFIED" : "NOT VERIFIED"),
    "OFF_DEVICE PHYSICAL TARGET = " + (i.offDeviceSatisfied
      ? "OK"
      : "BLOCKED — bu makinede ayrı bir aygıt yok (yalnız C:, DriveType 3)"),
    "```",
    "",
    ...table("C"),
    "",
    "## Bölüm E — saklanan kopyanın KENDİSİNDEN restore",
    "",
    ...table("E"),
    "",
    "## Bölüm D — operasyonel zamanlama ve retention",
    "",
    "```text",
    `SCHEDULE : ${i.scheduleSummary}`,
    `RETENTION: ${i.pruneSummary}`,
    `DAILY JOB: ${i.dailyRunSummary}`,
    "```",
    "",
    ...table("D"),
    "",
    "### Operatör adımları (bu kapının BİLEREK yapmadıkları)",
    "",
    ...(i.scheduleRegistered
      ? [
          "Zamanlanmış görev operatör tarafından **kaydedilmiş** (`SCHEDULED TASK = REGISTERED`). Kapı",
          "onu değiştirmez; what-if'in kayıt durumunu değiştirmediğini ölçer.",
        ]
      : [
          "Zamanlanmış görev **kaydedilmedi**: tekrarlayan bir görev kullanıcının makinesinde kalıcı,",
          "dışa dönük bir değişikliktir ve kararı operatörün olmalıdır. Kapı yalnız kurulabilirliği",
          "kanıtlar (ön koşullar + birebir komut + what-if).",
        ]),
    "",
    "```bash",
    "# 1) off-device hedefi tanımla (harici disk taktıktan / NAS bağladıktan SONRA)",
    "setx MAS_OFFDEVICE_BACKUP_DIR \"E:\\mas-yedek\"        # veya \\\\nas\\mas-yedek",
    "",
    "# 2) günlük görevi kaydet",
    "pnpm exec tsx scripts/ops/schedule-windows.ts install --apply",
    "pnpm exec tsx scripts/ops/schedule-windows.ts status",
    "",
    "# 3) retention'ı gerçekten uygula (önce kuru koşuyu okuyun)",
    "pnpm exec tsx scripts/ops/backup-prune.ts --verbose",
    "pnpm exec tsx scripts/ops/backup-prune.ts --apply",
    "",
    "# geri alma",
    "pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --apply",
    "```",
    "",
    "## Komutlar (gerçekten koşanlar)",
    "",
    "```text",
    ...commands,
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
    ...(["A", "B", "C", "D", "E"] as Section[]).map((s) => {
      const c = counts(s);
      return `Bölüm ${s}: ${c.pass}/${c.total}`;
    }),
    `TOPLAM  : ${checks.length - failed.length}/${checks.length}`,
    "```",
    "",
    ...(notes.length > 0 ? ["## Notlar", "", ...notes.map((n) => `- ${n}`), ""] : []),
    ...(failed.length > 0
      ? ["## FAIL / NOT VERIFIED", "", ...failed.map((c) => `- [${c.section}] ${c.name} — beklenen \`${c.expected}\`, gerçek \`${c.actual}\``), ""]
      : []),
    "## Severity (rehber §31)",
    "",
    "```text",
    i.offDeviceSatisfied
      ? "P0: yok"
      : "P0: OFF_DEVICE PHYSICAL TARGET — bu makinede fiziksel olarak ayrı hiçbir hedef yok " +
        "(yalnız C:, DriveType 3; çıkarılabilir sürücü yok, bağlı ağ paylaşımı yok). Araç zinciri " +
        "kurulu ve doğrulandı; eksik olan DONANIM/HEDEF. Diski, makineyi ya da şifreleyen bir yazılımı " +
        "kaybeden senaryoda yedeğin tek kopyası da kaybedilir.",
    ...(i.scheduleRegistered
      ? ["P1: yok (OPERATIONAL SCHEDULE kayıtlı; günlük koşu sonuçları için DAILY JOB satırına bakın)."]
      : [
          "P1: OPERATIONAL SCHEDULE kurulabilir durumda ama KAYITLI DEĞİL — kayıt bilinçli olarak",
          "    operatöre bırakıldı (kalıcı sistem değişikliği).",
        ]),
    "P1: retention politikası koda döküldü ama gerçek `backups/` üzerinde HENÜZ UYGULANMADI —",
    `    kuru koşu: ${i.pruneSummary}. Uygulama kararı operatörün.`,
    "P2: Golden UI smoke bu restore kopyası üzerinde KOŞULMADI — kapı uygulamanın açıldığını ve",
    "    veritabanına bağlandığını kanıtlar; ekran seviyesi kanıt 03-real-clone-golden-ui.md'de,",
    "    başka bir klon üzerinde durur.",
    "P2: FINDING OPS-01 — yarıda kesilen `pnpm db:legacy-repair:verify` depoyu derlenemez bırakır.",
    "    MEKANİZMA: verify, migration dosyalarını `.hidden-for-legacy-repair-verify-<pid>-<epoch>`",
    "    ekiyle gizler ve koşu sonunda geri alır; süreç arada öldürülürse 58 migration gizli kalır.",
    "    `pnpm db:migrate`, real-clone-gate ve CI düşer; `git status` 58 SİLİNMİŞ dosya gösterir ve",
    "    bu, tam olarak YANLIŞ kurtarmaya (`git checkout`, artık dosya üretir) davet eder.",
    "    KURTARMA: her `*.hidden-for-legacy-repair-verify-*` dosyasından eki sıyırın; migration",
    "    dizinini ASLA `git checkout` etmeyin. Ayrıntı: docs/ops/incident-recovery-notes.md",
    "```",
    "",
    "## NOT VERIFIED — açıkça",
    "",
    "```text",
    "OFF_DEVICE PHYSICAL TARGET : NOT VERIFIED (BLOCKED) — yerel bir klasör off-device SAYILMAZ (§30.5).",
    "GOLDEN UI ON RESTORE       : NOT VERIFIED — bu kapıda koşulmadı.",
    ...(i.scheduleRegistered
      ? ["SCHEDULED TASK RUNNING     : görev KAYITLI — gerçek tetiklenmelerin sonucu DAILY JOB satırında."]
      : [
          "SCHEDULED TASK RUNNING     : NOT VERIFIED — görev kaydedilmedi; kaydedildikten sonraki ilk",
          "                             gerçek tetiklenme operatör tarafından doğrulanmalı.",
        ]),
    "```",
    "",
    "## NEXT GATE",
    "",
    "```text",
    "AŞAMA 08 — Consolidated Financial Correctness Gate (rehber §13).",
    "Bu kapının bıraktığı operatör işi: off-device hedef + zamanlanmış görev kaydı.",
    "```",
    "",
    `## FINAL: ${failed.length === 0 ? "PASS" : (failed.every((c) => c.section === "C") ? "PARTIAL — yalnız fiziksel off-device hedef BLOCKED" : "FAIL")}`,
    "",
    "## Yeniden üretim",
    "",
    "```bash",
    "# 1) gerçek kaynaktan yedek + katı makbuz (temiz git ağacı gerektirir; native PostgreSQL 16,",
    "#    araçlar MAS_PG_BIN_DIR'den — --container YALNIZ MAS_PG_RUNTIME=docker altında verilir)",
    "pnpm exec tsx scripts/db/backup-receipt.ts --expected-database-name mas_radar_dev \\",
    "  --expected-system-identifier <sysid> --expected-git-branch <branch> --expected-git-head <sha> \\",
    "  --label stage07_real --out-dir backups",
    "",
    "# 2) kapı",
    "MAS_OFFDEVICE_BACKUP_DIR=<hedef> pnpm exec tsx scripts/release/stage07-backup-gate.ts",
    "```",
    "",
  ];
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join("\n"), "utf8");
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
