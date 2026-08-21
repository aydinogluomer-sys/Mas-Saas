// Server-side Postgres pool. Local dev hits the validated PostgreSQL instance;
// future Supabase deploy only swaps DATABASE_URL (schema identical, same migrations).
// NOTE: import only from server components / route handlers / server actions / scripts.
//
// Since Faz 15 the connection string is the low-privilege `mas_radar_app` role and comes
// from @/lib/env, which requires it. The previous hardcoded DEFAULT_LOCAL fallback
// ("postgres://postgres:postgres@...") is gone on purpose: it would have let a missing
// DATABASE_URL silently reconnect the whole application as the superuser, bypassing every
// RLS policy — the exact failure this phase exists to remove.
import { Pool } from "pg";
import { env } from "@/lib/env";

declare global {
  var __masPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!global.__masPool) {
    global.__masPool = new Pool({
      connectionString: env.databaseUrl,
      max: env.databasePoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return global.__masPool;
}
