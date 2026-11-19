import { loadEnvConfig } from "@next/env";

// This script runs before `next dev` / `next start`, so Next has not loaded
// `.env.local` yet. Load it before importing modules that validate the environment
// at module evaluation time. Dynamic imports are intentional: static imports would
// run before this call and make a stock `.env.local` installation fail to boot.
loadEnvConfig(process.cwd());

async function main() {
  const [
    { getPool, getRawPool, runAsSystem },
    { assertSchemaParity },
    { ensureWindow },
    { istanbulDateISO },
    { ensureSystemActor, getSystemActorId },
  ] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/db/schema-parity"),
    import("../src/lib/radar/engine"),
    import("../src/lib/reports/rules"),
    import("./db/seed-system-actor"),
  ]);

  const pool = getPool();
  try {
    // Faz 62: Fail closed before serving traffic if PostgreSQL schema_migrations lags behind
    // `supabase/migrations/*.sql`.
    await assertSchemaParity(getRawPool());

    // After 0122 revoked `authenticated` from `mas_radar_app`, `mas_radar_app` holds SELECT/UPDATE
    // on `public.users` (enough to read the pre-seeded 'system' actor on normal boot without
    // owner credentials), while initial seeding on a brand-new DB uses `ownerDatabaseUrl()`.
    let actorId: string;
    try {
      actorId = await getSystemActorId(getRawPool());
    } catch {
      const [{ Pool }, { ownerDatabaseUrl }] = await Promise.all([
        import("pg"),
        import("./db/owner-url"),
      ]);
      const ownerUrl = ownerDatabaseUrl();
      if (!ownerUrl) {
        actorId = await ensureSystemActor(getRawPool());
      } else {
        const ownerPool = new Pool({ connectionString: ownerUrl, max: 1 });
        try {
          actorId = await ensureSystemActor(ownerPool);
        } finally {
          await ownerPool.end();
        }
      }
    }

    // Generating the payment window is ordinary operational work, and it runs as a tier.
    await runAsSystem(async () => {
      await ensureWindow(pool, istanbulDateISO(), actorId, 24);
      const { validateContinuity } = await import("../src/lib/cashflow/engine");
      await validateContinuity(pool);
    });
    console.log("Ödeme penceresi 24 aylık ufukla hazır.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Çalışma zamanı hazırlığı başarısız:", error);
  process.exit(1);
});
