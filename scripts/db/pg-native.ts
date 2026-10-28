// Native PostgreSQL 16 araç zinciri — SAF yardımcılar. İçe aktarımda yan etki yok; bu dosya
// hiçbir süreç başlatmaz, hiçbir veritabanına bağlanmaz.
//
// NEDEN BU DOSYA VAR. Docker Desktop bu makineden kaldırıldı ve kanonik veritabanı artık yerel
// PostgreSQL 16 kümesi (C:\MAS\pgdata16, yalnız 127.0.0.1/::1:5432). Yedek, doğrulama ve
// ön-migrasyon yedeği yıllarca `docker exec mas-radar-pg …` ile çalıştı; o yol artık yok. Yerine
// gelen yerel araçlar (pg_dump, psql, pg_restore) AYNI güvenceleri vermek zorunda ve bu
// güvencelerin üçü tamamen "argv'ye ne yazılır, çocuk sürece hangi ortam verilir" sorusudur:
//
//   1. PAROLA ASLA ARGV'DE DEĞİL. Windows'ta bir sürecin komut satırı Win32_Process üzerinden
//      okunabilir. `pg_dump postgres://u:PAROLA@…` biçiminde bir çağrı parolayı dump boyunca
//      açıkta tutar. Burada bağlantı dizesi hiçbir araca VERİLMEZ: hedef ayrıştırılır, parola
//      yalnız çocuk sürecin ortamına PGPASSWORD olarak girer.
//   2. ÇOCUK ORTAMI İZİN LİSTESİYLE KURULUR. Ebeveynden miras kalan bir PGHOST / PGSERVICE /
//      PGOPTIONS (CI'ın genel PGHOST'u, eski bir oturumdan kalan değer) libpq'yu SESSİZCE başka
//      bir hedefe ya da başka oturum ayarlarına yönlendirebilir; DATABASE_URL, Telegram token'ı,
//      API anahtarları ise pg araçlarının hiçbir işine yaramaz. Ebeveyn ortamı bu yüzden
//      KOPYALANMAZ: yalnız Windows'un bir süreci başlatmak için gerçekten ihtiyaç duyduğu birkaç
//      değişken taşınır, PG* değerleri sıfırdan, ayrıştırılmış hedeften yazılır.
//   3. YALNIZ LOOPBACK. Yedeklenen tek kaynak bu makinedeki kümedir. Uzak bir host'u kabul etmek
//      "yedek" adı altında araçların başka bir sunucuya bağlanmasına izin vermek olurdu — ve bu
//      yaşandı: 2026-10-18 ile 10-28 arasında günlük görev bir bulut kiracısındaki `postgres`
//      veritabanını yedeklemeye çalıştı; onu yalnız küme kimliği kapısı durdurdu.
//
// Üç kural da burada SAF fonksiyon olarak yaşar ki veritabanı, Docker ya da PostgreSQL ikilisi
// olmadan birim testlerle kanıtlanabilsin (tests/pg-native.test.ts).
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/* ── çalışma zamanı seçimi ───────────────────────────────────────────────────────────────── */

export type PgRuntime = "native" | "docker";

const PgRuntimeSchema = z.enum(["native", "docker"]);

/**
 * `MAS_PG_RUNTIME` → hangi araç zinciri.
 *
 * Varsayılan `native`: operatör makinesinde Docker YOK. `docker` yalnız CI içindir (GitHub
 * runner'ında atılabilir bir konteyner; ci.yml bunu açıkça ayarlar). Tanınmayan bir değer
 * native'e SESSİZCE düşmez: "dokcer" gibi bir yazım hatası yanlış araç zincirini seçtirmek
 * yerine durdurur.
 */
export function resolvePgRuntime(env: Readonly<Record<string, string | undefined>>): PgRuntime {
  const raw = (env.MAS_PG_RUNTIME ?? "").trim().toLowerCase();
  if (raw === "") return "native";
  const parsed = PgRuntimeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `MAS_PG_RUNTIME geçersiz: ${JSON.stringify(raw.slice(0, 40))}. ` +
        "Beklenen: native (varsayılan, bu makine) | docker (yalnız CI).",
    );
  }
  return parsed.data;
}

/* ── ikili dosyalar ──────────────────────────────────────────────────────────────────────── */

/**
 * Araç adları tablosu. Burada YALNIZ adlar durur — bu dosya hiçbirini çalıştırmaz. Okuyan/
 * yazan ayrımı çağıran modüllerde: backup-native-postgres.ts salt-okur (pg_dump, SELECT,
 * `pg_restore --list`), pg-native-restore.ts yalnız harcanabilir hedeflere yazar.
 */
export const PG_TOOL_NAMES = Object.freeze({
  pgDump: "pg_dump",
  pgRestore: "pg_restore",
  psql: "psql",
  createdb: "createdb",
  dropdb: "dropdb",
  pgIsready: "pg_isready",
} as const);

export type PgToolKey = keyof typeof PG_TOOL_NAMES;

export interface PgBinaries {
  readonly pgDump: string;
  readonly pgRestore: string;
  readonly psql: string;
  readonly createdb: string;
  readonly dropdb: string;
  readonly pgIsready: string;
  /** Yolların nereden geldiği — kanıt satırlarında ve hata mesajlarında söylenir. */
  readonly origin: "MAS_PG_BIN_DIR" | "PATH";
  readonly dir: string | null;
}

const TOOL_KEYS = Object.keys(PG_TOOL_NAMES) as PgToolKey[];

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Araçların yolunu çözer.
 *
 * `MAS_PG_BIN_DIR` verilmişse MUTLAK olmalı ve altı aracın HEPSİ orada bulunmalı; eksik olanlar
 * adlarıyla raporlanır. Göreli bir yol reddedilir: zamanlanmış görev başka bir çalışma
 * dizininde koşar ve göreli bir yol orada başka bir şeyi (ya da hiçbir şeyi) gösterirdi.
 *
 * Verilmemişse çıplak adlar döner ve PATH'te süreç başlatılırken çözülür; bulunamazsa
 * `describeSpawnFailure` ENOENT'i operatörün yapacağı tek adıma çevirir.
 */
export function resolvePgBinaries(
  env: Readonly<Record<string, string | undefined>>,
  deps: { exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {},
): PgBinaries {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const raw = stripWrappingQuotes((env.MAS_PG_BIN_DIR ?? "").trim());

  if (raw === "") {
    const bare = Object.fromEntries(TOOL_KEYS.map((k) => [k, PG_TOOL_NAMES[k]])) as Record<PgToolKey, string>;
    return Object.freeze({ ...bare, origin: "PATH" as const, dir: null });
  }

  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(raw)) {
    throw new Error(
      `MAS_PG_BIN_DIR mutlak bir yol olmalı (ör. C:\\MAS\\pgsql16\\bin); verilen: ${JSON.stringify(raw.slice(0, 200))}.`,
    );
  }
  const dir = p.normalize(raw);
  const ext = platform === "win32" ? ".exe" : "";
  const resolved = Object.fromEntries(
    TOOL_KEYS.map((k) => [k, p.join(dir, `${PG_TOOL_NAMES[k]}${ext}`)]),
  ) as Record<PgToolKey, string>;
  const missing = TOOL_KEYS.filter((k) => !exists(resolved[k])).map((k) => `${PG_TOOL_NAMES[k]}${ext}`);
  if (missing.length > 0) {
    throw new Error(`MAS_PG_BIN_DIR içinde eksik araç(lar): ${missing.join(", ")} — dizin: ${dir}`);
  }
  return Object.freeze({ ...resolved, origin: "MAS_PG_BIN_DIR" as const, dir });
}

/**
 * Bir süreç başlatma hatasını operatörün okuyacağı TEK cümleye çevirir.
 *
 * ENOENT "dosya yok" demektir ama operatör için anlamı "araç bulunamadı, nereye bakılacağını
 * söyle"dir. Ham `spawn pg_dump ENOENT` satırı o adımı söylemez.
 */
export function describeSpawnFailure(err: unknown, tool: string): Error {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === "ENOENT") {
    return new Error(
      `${tool} bulunamadı — MAS_PG_BIN_DIR ayarlayın (ör. C:\\MAS\\pgsql16\\bin) ` +
        "ya da PostgreSQL 16 bin dizinini PATH'e ekleyin.",
    );
  }
  return new Error(`${tool} başlatılamadı: ${e?.code ?? "?"} ${e?.message ?? String(err)}`.trim());
}

/* ── hedef: yalnız loopback ──────────────────────────────────────────────────────────────── */

/** `Map`, düz nesne DEĞİL: `hostname === "constructor"` gibi bir dize Object.prototype'tan
 * truthy bir değer döndürüp kapıyı geçebilirdi. */
const LOOPBACK_HOSTS: ReadonlyMap<string, "127.0.0.1" | "::1"> = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "::1"],
  ["localhost", "127.0.0.1"],
]);

/**
 * Bağlantı dizesinde hedefi BAŞKA yere yönlendirebilecek sorgu parametreleri. Native araçlara
 * URL hiç verilmez, ama aynı dize node-postgres havuzuna (kimlik kontrolünün tarafı) verilir —
 * `?host=` ile oraya başka bir sunucu söyletmek iki tarafı ayrıştırırdı.
 */
const REDIRECTING_PARAMS: readonly string[] = Object.freeze([
  "host", "hostaddr", "port", "dbname", "user", "password", "passfile", "service", "options",
]);

export interface LoopbackEndpoint {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  /** URL `localhost` diyordu: Node onu önce ::1'e çözebilir; çağıran uyarabilir. */
  readonly wasLocalhost: boolean;
}

function parsePgUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Bağlantı dizesi ayrıştırılamadı (dize kasıtlı olarak yazdırılmıyor).");
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("Bağlantı dizesi postgres:// ya da postgresql:// ile başlamalı (dize kasıtlı olarak yazdırılmıyor).");
  }
  return u;
}

/**
 * Bağlantı dizesinin host/port'unu döndürür; host bu makine değilse REDDEDER.
 *
 * Hiçbir hata mesajı URL'i, host'u ya da parolayı içermez — bu mesajlar zamanlanmış görev
 * günlüğüne ve koşu kayıtlarına gider.
 */
export function parseLoopbackEndpoint(url: string): LoopbackEndpoint {
  const u = parsePgUrl(url);
  for (const param of REDIRECTING_PARAMS) {
    if (u.searchParams.has(param)) {
      throw new Error(
        `Bağlantı dizesi hedefi yönlendiren '${param}' sorgu parametresi taşıyor — native araçlar bunu reddeder.`,
      );
    }
  }
  const rawHost = u.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const host = LOOPBACK_HOSTS.get(rawHost);
  if (!host) {
    throw new Error(
      "Bağlantı dizesindeki host bu makine değil (127.0.0.1, ::1 ya da localhost bekleniyordu; " +
        "host kasıtlı olarak yazdırılmıyor). Native PostgreSQL araçları yalnız yerel kümeye bağlanır.",
    );
  }
  const port = u.port === "" ? 5432 : Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Bağlantı dizesindeki port geçersiz (1-65535 bekleniyordu).");
  }
  return { host, port, wasLocalhost: rawHost === "localhost" };
}

/**
 * pg araçlarına komut satırında verilecek veritabanı adları için kural. PostgreSQL tırnaklı
 * adlarda neredeyse her şeye izin verir; burada bilerek DAHA DAR: `-f` gibi bir ad argv'de
 * seçenek olarak okunur, boşluk ya da `;` taşıyan bir ad hiçbir meşru akışta yoktur.
 */
export const PLAIN_DB_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertPlainDbName(name: string): void {
  if (typeof name !== "string" || !PLAIN_DB_IDENTIFIER.test(name)) {
    throw new Error(
      `Veritabanı adı düz bir tanımlayıcı değil: ${JSON.stringify(String(name).slice(0, 80))} — ` +
        "yalnız küçük harf, rakam ve '_' (ilk karakter harf ya da '_'), en çok 63 karakter. " +
        "Tırnak gerektiren ya da '-' ile başlayan adlar komut satırında seçenek gibi okunabilir; reddedilir.",
    );
  }
}

export interface NativePgTarget {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password?: string;
}

/**
 * Owner bağlantı dizesini native araçların hedefine çevirir: loopback host, port (varsayılan
 * 5432), kullanıcı, düz veritabanı adı ve — varsa — yüzde-kodlaması çözülmüş parola.
 *
 * `localhost` 127.0.0.1'e normalleştirilir: küme 127.0.0.1 ve ::1'de dinliyor, ama tek bir
 * adresle konuşmak kimlik kontrolünün iki tarafının aynı soketi kullanmasını kolaylaştırır.
 */
export function parseNativeTarget(url: string): NativePgTarget {
  const { host, port } = parseLoopbackEndpoint(url);
  const u = parsePgUrl(url);
  let database: string;
  let user: string;
  let password: string | undefined;
  try {
    database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    user = decodeURIComponent(u.username);
    password = u.password === "" ? undefined : decodeURIComponent(u.password);
  } catch {
    throw new Error("Bağlantı dizesindeki yüzde kodlaması çözülemedi (dize kasıtlı olarak yazdırılmıyor).");
  }
  if (user === "") throw new Error("Bağlantı dizesinde kullanıcı adı yok.");
  assertPlainDbName(database);
  return Object.freeze({ host, port, user, database, ...(password !== undefined ? { password } : {}) });
}

/** Makbuz ve günlük etiketi: `native:127.0.0.1:5432`. Kullanıcı ve parola ASLA. */
export function describeNativeTarget(t: Pick<NativePgTarget, "host" | "port">): string {
  return `native:${t.host === "::1" ? "[::1]" : t.host}:${t.port}`;
}

/* ── çocuk süreç ortamı ──────────────────────────────────────────────────────────────────── */

/**
 * Ebeveynden taşınan YALNIZ bunlar. SystemRoot olmadan pg araçları Windows'ta Winsock'u
 * başlatamaz; PATH/PATHEXT araç ve DLL çözümü içindir; TEMP/TMP/profil dizinleri libpq'nun
 * kendi varsayılan dosya konumları içindir. Geri kalan her şey — PG* değerleri, *_URL'ler,
 * token'lar, API anahtarları — bilerek dışarıda kalır.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "SystemRoot", "windir", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA",
  "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "ComSpec",
]);

/** Windows ortam adları büyük/küçük harfe duyarsızdır (`Path` = `PATH`); düz nesnelerde de. */
function lookupEnv(base: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const exact = base[key];
  if (exact !== undefined) return exact;
  const upper = key.toUpperCase();
  for (const k of Object.keys(base)) {
    if (k.toUpperCase() === upper) return base[k];
  }
  return undefined;
}

/**
 * Bağlantı GEREKTİRMEYEN araç çağrıları (`--version`, `pg_restore --list <dosya>`) için ortam:
 * izin listesi + `LC_MESSAGES=C` (ayrıştırılan çıktılar çevrilmemiş gelsin). Hiçbir PG*
 * değişkeni yok — miras kalan bir PGHOST bile.
 */
export function buildToolEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = lookupEnv(base, key);
    if (value !== undefined && value !== "") out[key] = value;
  }
  out.LC_MESSAGES = "C";
  return out;
}

/**
 * Bağlanan araçlar (pg_dump, psql, createdb, dropdb, pg_restore) için libpq ortamı.
 *
 * `readOnly`: kaynağa dokunan her araç `default_transaction_read_only=on` ile açılır — pg_dump
 * ve kimlik SELECT'i yazmaz zaten; bu ayar bunu NİYETTEN MOTOR GARANTİSİNE çevirir
 * (p24b-readonly-psql.sh ile aynı okuma).
 *
 * Dönen nesne parola taşır: ASLA yazdırılmaz, JSON'a çevrilmez, günlüğe geçmez. `base`
 * değiştirilmez.
 */
export function buildLibpqEnv(
  target: NativePgTarget,
  base: Readonly<Record<string, string | undefined>>,
  opts: { database?: string; readOnly?: boolean; appName?: string } = {},
): Record<string, string> {
  const database = opts.database ?? target.database;
  assertPlainDbName(database);
  const env = buildToolEnv(base);
  env.PGHOST = target.host;
  env.PGPORT = String(target.port);
  env.PGUSER = target.user;
  env.PGDATABASE = database;
  if (target.password !== undefined) env.PGPASSWORD = target.password;
  env.PGAPPNAME = opts.appName ?? "mas-backup";
  env.PGCONNECT_TIMEOUT = "10";
  if (opts.readOnly) env.PGOPTIONS = "-c default_transaction_read_only=on";
  return env;
}

/**
 * Süreç başlatma sınırındaki TİP dönüşümü — değer değişmez. Next'in global bildirimi
 * `NodeJS.ProcessEnv`'de NODE_ENV'i zorunlu kılar; izin listeli pg araç ortamında onun yeri yok
 * (bilerek dışarıda), bu yüzden tip yalnız `spawn`/`execFileSync`'e verilirken daraltılır.
 */
export function asChildProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

/**
 * Bilinen sır DEĞERLERİNİ metinden çıkarır (araç stderr'i günlüğe yazılmadan önce). Araçlara
 * hiçbir zaman URL verilmediği için şekil tabanlı maskeleme gerekmez; tek risk, bir hata
 * mesajının parolayı yankılamasıdır. 4 karakterden kısa değerler bilerek atlanır — "1" gibi
 * bir değeri maskelemek metnin her yerini yıldıza çevirir.
 */
export function redactValues(text: string, values: readonly (string | undefined)[]): string {
  let out = text;
  for (const raw of values) {
    if (raw !== undefined && raw.length >= 4) out = out.split(raw).join("***");
  }
  return out;
}

/* ── sürüm uyumu ─────────────────────────────────────────────────────────────────────────── */

/**
 * Ana sürüm numarası: `pg_dump (PostgreSQL) 16.14`, `PostgreSQL 16.14, compiled by …` ve
 * `server_version_num` biçimi `160014`. Okunamazsa `null` — çağıran bunu RED sayar.
 */
export function parsePgMajor(text: string): number | null {
  const t = text.trim();
  if (/^\d{6}$/.test(t)) return Math.floor(Number(t) / 10000);
  const m = /PostgreSQL\)?\s+(\d+)(?:\.\d+)?/.exec(t);
  return m ? Number(m[1]) : null;
}

/**
 * Araç ve sunucu AYNI ana sürümde olmalı — iki yönde de.
 *
 * Daha eski bir pg_dump daha yeni bir sunucuyu dökemez; daha yeni bir pg_dump'ın ürettiği arşivi
 * ise kurtarma günü elde olan 16.x pg_restore okuyamayabilir. Bunu felaket gününde keşfetmek,
 * yedeği hiç almamış olmakla aynı kapıya çıkar.
 */
export function assertSameMajor(serverMajor: number, toolMajor: number, tool: string): void {
  if (!Number.isInteger(serverMajor) || !Number.isInteger(toolMajor) || serverMajor !== toolMajor) {
    throw new Error(
      `${tool} ana sürümü (${toolMajor}) sunucunun ana sürümüyle (${serverMajor}) aynı değil — ` +
        "yedek iptal edildi. MAS_PG_BIN_DIR sunucuyla aynı PostgreSQL kurulumunun bin dizinini göstermeli.",
    );
  }
}
