// Tek satırlık harcanabilir veritabanı hedefi koruyucusu (Faz 43 / B1-06).
//
// `MIGRATION_DATABASE_URL`, `DATABASE_URL` veya `MAS_APP_DATABASE_URL` değişkenlerinden
// herhangi biri `mas_radar_dev` / `postgres` / `template0` / `template1` gibi korunan bir
// veritabanını gösteriyorsa veya `DISPOSABLE_MARKERS` işaretlerinden hiçbirini taşımıyorsa,
// TEK BİR SOKET BİLE AÇMADAN anında `GÜVENLİK DURDURMASI` hatasıyla çıkar.
//
// Bağlantı dizeleri parola taşıdığı için hata mesajlarında ASLA yazdırılmaz; yalnız değişken
// adı ve ayrıştırılan veritabanı adı raporlanır.
import {
  DISPOSABLE_MARKERS,
  PROTECTED_DB_NAMES,
  databaseNameFromUrl,
  isDisposableDatabaseName,
} from "./owner-url";

export const DEFAULT_DISPOSABLE_ENV_VARS = Object.freeze([
  "MIGRATION_DATABASE_URL",
  "DATABASE_URL",
  "MAS_APP_DATABASE_URL",
] as const);

export interface DisposableTargetSelection {
  readonly dbName: string;
  readonly url: string;
  readonly envVar: string;
}

/**
 * Saf doğrulayıcı: `process.exit` çağırmaz, birim testlerinde doğrudan sınanabilir.
 *
 * Kurallar:
 *   1. `envVarNames` listesindeki değişkenlerden en az biri dolu olmalıdır.
 *   2. Dolu olan HER değişken geçerli bir harcanabilir veritabanı adı taşımalıdır
 *      (böylece `MIGRATION_DATABASE_URL=..._verify` iken `DATABASE_URL=.../mas_radar_dev`
 *      unutulmuşsa bile anında yakalanır).
 */
export function validateDisposableTargetDb(
  env: Readonly<Record<string, string | undefined>> = process.env,
  envVarNames: readonly string[] = DEFAULT_DISPOSABLE_ENV_VARS,
  context = "harcanabilir-db-kapısı",
): DisposableTargetSelection {
  const presentEntries: Array<{ key: string; url: string }> = [];
  for (const key of envVarNames) {
    const raw = env[key]?.trim();
    if (raw) {
      presentEntries.push({ key, url: raw });
    }
  }

  if (presentEntries.length === 0) {
    throw new Error(
      `GÜVENLİK DURDURMASI (${context}): ${envVarNames.join(" veya ")} tanımlı değil. ` +
        "Yıkıcı/fixture betikleri varsayılan veritabanına düşmez; harcanabilir bir hedef verin.",
    );
  }

  let primary: DisposableTargetSelection | null = null;

  for (const entry of presentEntries) {
    const dbName = databaseNameFromUrl(entry.url);
    if (!dbName || !isDisposableDatabaseName(dbName)) {
      const shown = dbName ?? "(bağlantı dizesinden veritabanı adı okunamadı)";
      const reason =
        dbName !== undefined && PROTECTED_DB_NAMES.includes(dbName.toLowerCase())
          ? `'${shown}' korunan bir veritabanı — test/doğrulama betikleri ona ASLA bağlanmaz.`
          : `'${shown}' harcanabilir işaretlerinden hiçbirini taşımıyor (${DISPOSABLE_MARKERS.join(", ")}).`;
      throw new Error(
        `GÜVENLİK DURDURMASI (${context}) [${entry.key}]: ${reason}\n` +
          "Örnek: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_ornek_verify",
      );
    }
    if (!primary) {
      primary = { dbName, url: entry.url, envVar: entry.key };
    }
  }

  return primary!;
}

/**
 * CLI betiklerinin ilk satırında çağrılan süreç-durdurucu kapı.
 */
export function assertDisposableTargetDb(
  envVarNames: readonly string[] = DEFAULT_DISPOSABLE_ENV_VARS,
  context = "harcanabilir-db-kapısı",
): { dbName: string; url: string } {
  try {
    const selected = validateDisposableTargetDb(process.env, envVarNames, context);
    return { dbName: selected.dbName, url: selected.url };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

