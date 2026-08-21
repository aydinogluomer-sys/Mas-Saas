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
