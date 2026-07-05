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
    global.__masPool = new Pool({
      connectionString: process.env.DATABASE_URL ?? DEFAULT_LOCAL,
      max: 5,
    });
  }
  return global.__masPool;
}
