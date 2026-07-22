// Server-side Postgres pool. Local dev hits the validated PostgreSQL instance;
// future Supabase deploy only swaps DATABASE_URL (schema identical, same migrations).
// NOTE: import only from server components / route handlers / server actions / scripts.
import { Pool } from "pg";

const DEFAULT_LOCAL = "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev";

declare global {
  var __masPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!global.__masPool) {
    const configuredMax = Number(process.env.DATABASE_POOL_MAX ?? 10);
    const max = Number.isFinite(configuredMax) ? Math.min(20, Math.max(2, configuredMax)) : 10;
    global.__masPool = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_LOCAL,
      max,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return global.__masPool;
}
