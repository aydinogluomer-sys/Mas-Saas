import { loadEnvConfig } from "@next/env";

// This script runs before `next dev` / `next start`, so Next has not loaded
// `.env.local` yet. Load it before importing modules that validate the environment
// at module evaluation time. Dynamic imports are intentional: static imports would
// run before this call and make a stock `.env.local` installation fail to boot.
loadEnvConfig(process.cwd());

async function main() {
  const [
    { runMigrationLedger },
    { getPool, getRawPool, runAsSystem },
    { ensureWindow },
    { istanbulDateISO },
    { ensureSystemActor },
  ] = await Promise.all([
    import("./db/migrate"),
    import("../src/lib/db"),
    import("../src/lib/radar/engine"),
    import("../src/lib/reports/rules"),
    import("./db/seed-system-actor"),
  ]);

  await runMigrationLedger();

  const pool = getPool();
  try {
    // Faz 24B: this runs before any request, so there is no session to derive a tier from.
    // runAsSystem states the identity explicitly rather than letting the job quietly inherit
    // one — without it every write here is refused by RLS, which is exactly what happened the
    // first time the server was started under the new model.
    // Two identities, because these are two different kinds of work.
    //
    // Provisioning the system account touches public.users, which no tier may write — account
    // administration belongs to admin. But this is not an admin acting: it is the application
    // maintaining its OWN service account, which is precisely what Faz 15's mas_radar_app
    // policy on users exists for. So it runs unswitched, on the raw pool.
    const actorId = await ensureSystemActor(getRawPool());
    // Generating the payment window is ordinary operational work, and it runs as a tier.
    await runAsSystem(() => ensureWindow(pool, istanbulDateISO(), actorId, 24));
    console.log("Ödeme penceresi 24 aylık ufukla hazır.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Çalışma zamanı hazırlığı başarısız:", error);
  process.exit(1);
});
