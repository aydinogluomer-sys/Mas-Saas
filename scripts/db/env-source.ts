// AŞAMA 11 / B5 — bağlantı değişkeninin HANGİ KAYNAKTAN geldiğini söyleyen kapı.
//
// NEDEN VAR. Rehber §16 "environment shadowing"i zorunlu failure injection yaptı, çünkü bu
// makinede gerçekten yaşandı: `.env.local` düzeltildi, hata sürdü, sebep eski bir PowerShell
// oturumunda kalmış `$env:DATABASE_URL` idi. AŞAMA 11 provasında bu üç ayrı yoldan ÖLÇÜLDÜ:
//
//   1. `tsx` girişleri `.env.local`'ı HİÇ okumaz. Temiz bir kabukta, dosya tamamen doğruyken
//      `scripts/db/roles-verify.ts` "DATABASE_URL tanımlı değil" diyerek durdu. Yani dosyayı
//      düzeltmek bir script'i düzeltmez — dosyanın script'ler üzerinde hiçbir etkisi yoktur.
//
//   2. Kabukta YANLIŞ ama GEÇERLİ bir hedef varken aynı script 8/8 PASS, exit 0 verdi ve
//      "18 kullanıcı satırı görülebiliyor" dedi. `.env.local`'ın işaret ettiği gerçek
//      veritabanında 17 kullanıcı var. Kapı yeşil yandı — YANLIŞ veritabanı için. Çıktının
//      hiçbir yerinde veritabanı adı, kimlik ya da kaynak geçmiyordu.
//
//   3. Next'in kendi yükleyicisi (@next/env 15.5.20 `loadEnvConfig`) zaten TANIMLI bir
//      process değişkenini EZMEZ. Ölçüldü: yükleyici çağrıldıktan sonra da kabuktan gelen
//      değer yerinde kaldı. `.env.local` sessizce kaybediyor.
//
// NE YAPAR, NE YAPMAZ. Bu modül yalnız KAYNAĞI söyler: değişken adı, kaynağı ve hedefin
// `kullanıcı@veritabanı` etiketi. Bağlantı dizesi, parola ya da host asla yazdırılmaz —
// `describe*` fonksiyonlarının hiçbir kolunda ham değer dönmez. Parolayı görünür kılmadan
// "hangi veritabanına, hangi kimlikle, hangi kaynaktan" sorusunu cevaplar; operatörün
// C1 adımında ihtiyacı olan tam olarak budur.
//
// KARAR NEDEN SAF FONKSİYONDA. `process.exit()` birim testten çağrılamaz. Kapının KARARI
// burada saf yüklemler olarak yaşıyor, sonlandırma CLI sarmalayıcısında
// (`scripts/db/env-source-check.ts`) — `scripts/db/owner-url.ts`'in
// isDisposableDatabaseName / requireDisposableOwnerDatabaseUrl ayrımıyla aynı desen.

/** Bir bağlantı değişkeninin gerçekte nereden geldiği. */
export type EnvSource =
  /** Ne kabukta ne `.env.local`'da var. */
  | "absent"
  /** Yalnız `.env.local`'da var — `tsx` girişleri bunu OKUMAZ. */
  | "env-local-only"
  /** Yalnız kabukta var; `.env.local` bu değişkeni hiç tanımlamıyor. */
  | "shell-only"
  /** İkisinde de var ve AYNI — gölgeleme yok. */
  | "shell-matches-env-local"
  /** İkisinde de var ve FARKLI — kabuk `.env.local`'ı sessizce geçersiz kılıyor. */
  | "shell-shadows-env-local";

export interface EnvSourceFinding {
  name: string;
  source: EnvSource;
  /** Kabuk değeri `.env.local`'dakinden farklı mı? Tek gerçek alarm koşulu budur. */
  shadowed: boolean;
  /** Kabuktaki değerin hedefi, `kullanıcı@veritabanı` — parola ASLA. */
  shellTarget?: string;
  /** `.env.local`'daki değerin hedefi, `kullanıcı@veritabanı` — parola ASLA. */
  fileTarget?: string;
}

/** Boş dize tanımsız sayılır — `scripts/db/owner-url.ts` ile aynı kural. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Bağlantı dizesinden YALNIZ `kullanıcı@veritabanı` etiketi.
 *
 * Host ve port bilerek dışarıda: bu etiket loglara ve kanıt dosyalarına giriyor ve amacı
 * "doğru yere mi bağlanıyorum" sorusunu cevaplamak, topolojiyi yayınlamak değil. Parola
 * hiçbir kolda dönmez; ayrıştırılamayan bir dize için `undefined` döner ve çağıran onu
 * "(okunamadı)" diye gösterir — ham dizeyi ASLA.
 */
export function connectionTargetParts(
  url: string | undefined,
): { user: string; database: string } | undefined {
  if (present(url) === undefined) return undefined;
  try {
    const parsed = new URL(url as string);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    const user = decodeURIComponent(parsed.username);
    if (database === "") return undefined;
    return { user, database };
  } catch {
    return undefined;
  }
}

export function connectionTargetLabel(url: string | undefined): string | undefined {
  const parts = connectionTargetParts(url);
  if (parts === undefined) return undefined;
  return parts.user === "" ? parts.database : `${parts.user}@${parts.database}`;
}

/**
 * AŞAMA 20 / P2 — kapıların çıktısındaki TEK kimlik satırı.
 *
 * NEDEN VAR. AŞAMA 11'in B5-2 provasında `db:roles:verify` yanlış bir veritabanına karşı
 * `8/8 kontrol geçti` yazdı ve exit 0 verdi. Yanlışlığı ortaya çıkaran tek şey DIŞARIDAN
 * alınan bir satır sayımıydı (18 ≠ 17); kapının kendi çıktısında hangi veritabanına
 * bağlanıldığını söyleyen hiçbir şey yoktu. Bu satır o boşluğu kapatır.
 *
 * YALNIZ AD. Host, port, parola ve bağlantı dizesi hiçbir kolda yazdırılmaz — kanıt
 * dosyalarına ve konsol geçmişine giren metin budur.
 */
export function formatTargetIdentity(
  database: string | undefined,
  user: string | undefined,
): string {
  const db = present(database) ?? "(bilinmiyor)";
  const usr = present(user) ?? "(bilinmiyor)";
  return `Hedef: db=${db} user=${usr}`;
}

/**
 * Aynı satırın, bağlantı HİÇ AÇILAMADIĞINDA kullanılan hâli.
 *
 * Bağlanamamış bir kapı `current_database()` soramaz; o durumda operatörün görmesi gereken
 * şey NİYET EDİLEN hedeftir — "hangi veritabanına ulaşmaya çalıştım" sorusu, "orada ne
 * gördüm" sorusundan bağımsız olarak cevaplanmalıdır.
 */
export function formatIntendedTargetIdentity(url: string | undefined): string {
  const parts = connectionTargetParts(url);
  return parts === undefined
    ? "Hedef (bağlanılamadı): db=(okunamadı) user=(okunamadı)"
    : `Hedef (bağlanılamadı): db=${parts.database} user=${parts.user === "" ? "(okunamadı)" : parts.user}`;
}

/** Saf karar: değer nereden geliyor? */
export function classifyEnvSource(
  shellValue: string | undefined,
  fileValue: string | undefined,
): EnvSource {
  const shell = present(shellValue);
  const file = present(fileValue);
  if (shell === undefined && file === undefined) return "absent";
  if (shell === undefined) return "env-local-only";
  if (file === undefined) return "shell-only";
  return shell === file ? "shell-matches-env-local" : "shell-shadows-env-local";
}

/** Tek bir değişken için bulgu. */
export function inspectEnvSource(
  name: string,
  shellValue: string | undefined,
  fileValue: string | undefined,
): EnvSourceFinding {
  const source = classifyEnvSource(shellValue, fileValue);
  return {
    name,
    source,
    shadowed: source === "shell-shadows-env-local",
    shellTarget: connectionTargetLabel(shellValue),
    fileTarget: connectionTargetLabel(fileValue),
  };
}

/** Birden çok değişken için bulgular — sıra girdideki sıradır. */
export function inspectEnvSources(
  names: readonly string[],
  shellEnv: Record<string, string | undefined>,
  fileEnv: Record<string, string | undefined>,
): EnvSourceFinding[] {
  return names.map((name) => inspectEnvSource(name, shellEnv[name], fileEnv[name]));
}

/**
 * Operatörün göreceği tek satır. Değer değil, KAYNAK ve HEDEF.
 *
 * Metin kasıtlı olarak "ne yapmalıyım" sorusunu da cevaplıyor: gölgeleme satırı kabuğun
 * kazandığını açıkça söyler, çünkü bu senaryonun tamamı "dosyayı düzelttim, hâlâ olmuyor"
 * ile başlıyor.
 */
export function describeEnvSource(finding: EnvSourceFinding): string {
  const shell = finding.shellTarget ?? "(hedef okunamadı)";
  const file = finding.fileTarget ?? "(hedef okunamadı)";
  switch (finding.source) {
    case "absent":
      return `${finding.name}: TANIMSIZ — ne kabukta ne .env.local'da.`;
    case "env-local-only":
      return (
        `${finding.name}: yalnız .env.local (${file}) — DİKKAT: tsx script'leri .env.local'ı ` +
        "OKUMAZ, bu değeri görmezler."
      );
    case "shell-only":
      return `${finding.name}: yalnız kabuk (${shell}).`;
    case "shell-matches-env-local":
      return `${finding.name}: kabuk = .env.local (${shell}) — gölgeleme yok.`;
    case "shell-shadows-env-local":
      return (
        `${finding.name}: GÖLGELEME — kabuk (${shell}) .env.local'ı (${file}) geçersiz kılıyor. ` +
        "Kazanan KABUK değeridir."
      );
  }
}

/** Tek bakışta özet: gölgelenen değişken adları (boşsa temiz). */
export function shadowedNames(findings: readonly EnvSourceFinding[]): string[] {
  return findings.filter((f) => f.shadowed).map((f) => f.name);
}

/**
 * Cutover'da izlenen iki bağlantı değişkeni. `owner-url.ts` bu ikisi arasında
 * MIGRATION_DATABASE_URL → DATABASE_URL sırasıyla geri düşer, dolayısıyla bayat bir
 * DATABASE_URL doğru bir MIGRATION_DATABASE_URL'in yokluğunda owner kimliği yerine geçebilir.
 */
export const CONNECTION_ENV_NAMES: readonly string[] = Object.freeze([
  "MIGRATION_DATABASE_URL",
  "DATABASE_URL",
]);
