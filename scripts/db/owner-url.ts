// Faz 15 — the owner/superuser connection string, for the scripts that create or alter
// schema, roles and seed accounts.
//
// Since Faz 15 there are two credentials, not one:
//   DATABASE_URL            → the low-privilege `mas_radar_app` role the Next.js app runs as
//   MIGRATION_DATABASE_URL  → the owner role (postgres) that may run DDL
//
// The fallback to DATABASE_URL is intentional and keeps every existing invocation working
// on a cluster whose env vars have not been split yet. It is also why every test harness
// that pins DATABASE_URL to a disposable database must pin MIGRATION_DATABASE_URL to the
// same value: otherwise an owner URL left over in the parent environment would win here,
// and a verify run would apply migrations to whatever database that URL points at — the
// real one, quite possibly.
//
// An empty string counts as unset, matching the `if (!databaseUrl)` checks these scripts
// used before.
export function ownerDatabaseUrl(): string | undefined {
  const migration = process.env.MIGRATION_DATABASE_URL;
  if (migration != null && migration !== "") return migration;
  const runtime = process.env.DATABASE_URL;
  return runtime != null && runtime !== "" ? runtime : undefined;
}

/**
 * Same resolution, but refuses to continue without an explicit connection string.
 *
 * The gate scripts used to end their connection setup with
 * `?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev"`. That default was quietly
 * dangerous in a way this phase exists to remove: forget to export the env var and twenty
 * verify scripts connect to the REAL development database as the superuser and TRUNCATE it.
 * Failing loudly is the only safe behaviour for a tool whose first action is to wipe tables.
 */
export function requireOwnerDatabaseUrl(): string {
  const url = ownerDatabaseUrl();
  if (!url) {
    throw new Error(
      "MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil. " +
        "Bu script şema/veri sıfırlaması yapar; varsayılan bir bağlantıya düşmesi kasıtlı olarak engellendi.",
    );
  }
  return url;
}

/* ── Faz 17-38 denetimi: the disposable-target gate ──────────────────────────────────────
 *
 * WHAT WAS MEASURED, AND IT IS WORSE THAN IT SOUNDS.
 *
 * Forty scripts/phase*-verify.ts scripts resolve their connection through the function above.
 * TWENTY-FIVE of them open with a TRUNCATE. None of them — not one — ever asked WHICH database
 * they had been pointed at. Reproduced end to end against a disposable database:
 *
 *   1. inserted a row named 'KIYMETLI-URETIM-KAYDI' into public.payments   -> payments = 20
 *   2. ran phase3-verify with DATABASE_URL pinned to that database         -> "PHASE3 VERIFY: ALL PASS"
 *   3. counted that row again, from OUTSIDE the script                     -> 0
 *
 * The script destroyed pre-existing data, reported success, and the only thing standing between
 * that run and `mas_radar_dev` was whoever typed the environment variable. `requireOwnerDatabaseUrl`
 * already refuses to INVENT a connection string (Faz 15 removed the mas_radar_dev default for
 * exactly this reason) — but it will happily accept one that names the real database.
 *
 * WHY A MARKER RULE AND NOT ONLY A BLOCKLIST. A blocklist of one name protects one name. The
 * rule below inverts the default: a target must SAY it is disposable before anything truncates
 * it. `mas_radar_dev` is additionally named outright, so the protection does not rest on a
 * naming convention alone — belt and braces, the same shape legacy-repair-verify.ts uses
 * (FORBIDDEN_DB_NAME + DISPOSABLE_PREFIX).
 *
 * WHY THE GATE IS NOT INSIDE requireOwnerDatabaseUrl(). migrate.ts uses that function and MUST
 * be able to target the real database — that is the cutover. Mixing the two would either break
 * the cutover or weaken the gate, so they stay separate functions with separate promises.
 */

/** Names no fixture script may ever write to, whatever else the rules say. */
export const PROTECTED_DB_NAMES: readonly string[] = Object.freeze([
  "mas_radar_dev",
  "postgres",
  "template0",
  "template1",
]);

/**
 * A target must carry one of these in its name to be considered disposable.
 *
 * The list is deliberately generous about the words people already use in this repository
 * (`mas_radar_constraints_verify`, `mas_radar_preflight_clone`, `mas_radar_restored`) and
 * deliberately silent about anything that merely looks internal. Adding a marker to a database
 * name is a one-word, deliberate act; that is the whole point — the gate asks the operator to
 * SAY "this database is expendable" before a TRUNCATE runs.
 */
export const DISPOSABLE_MARKERS: readonly string[] = Object.freeze([
  "verify", "test", "tmp", "temp", "disposable", "scratch", "sandbox",
  "fixture", "clone", "restore", "snapshot", "probe",
]);

/** The database name inside a connection string, or undefined when it cannot be read. */
export function databaseNameFromUrl(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.replace(/^\//, "");
    return name === "" ? undefined : decodeURIComponent(name);
  } catch {
    // A malformed URL must not be treated as "no name and therefore fine".
    return undefined;
  }
}

/**
 * Pure predicate behind the gate.
 *
 * Side-effect free on purpose — process.exit() cannot be unit-tested, so the DECISION lives
 * here and the termination lives in the wrapper below. Same split legacy-repair-verify.ts uses.
 */
export function isDisposableDatabaseName(name: string | undefined): boolean {
  if (name === undefined || name.trim() === "") return false;
  const lower = name.toLowerCase();
  if (PROTECTED_DB_NAMES.includes(lower)) return false;
  return DISPOSABLE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The connection string for a fixture script, refusing anything that is not declared disposable.
 *
 * Fails LOUDLY and before any connection is opened. The URL itself is NEVER printed — it carries
 * a password — so the message names only the database.
 */
export function requireDisposableOwnerDatabaseUrl(context = "bu gate"): string {
  const url = requireOwnerDatabaseUrl();
  const name = databaseNameFromUrl(url);
  if (!isDisposableDatabaseName(name)) {
    const shown = name ?? "(bağlantı dizesinden veritabanı adı okunamadı)";
    const why = name !== undefined && PROTECTED_DB_NAMES.includes(name.toLowerCase())
      ? `'${shown}' korunan bir veritabanı — fixture script'leri ona asla yazmaz.`
      : `'${shown}' disposable işaretlerinden hiçbirini taşımıyor (${DISPOSABLE_MARKERS.join(", ")}).`;
    console.error(
      `GÜVENLİK DURDURMASI (${context}): ${why}\n` +
        "Bu script TRUNCATE ve fixture yazımı yapar; hedefin harcanabilir olduğunu ADIYLA " +
        "söylemesi gerekir. Tek başına açık bir DATABASE_URL vermek yeterli değildir — " +
        "Faz 15 varsayılan bağlantıyı bu yüzden kaldırmıştı, bu kapı da aynı kazanın " +
        "elle yazılmış hâlini kapatır.\n" +
        "Örnek: postgres://postgres:postgres@127.0.0.1:5432/mas_radar_ornek_verify",
    );
    process.exit(1);
  }
  return url;
}
