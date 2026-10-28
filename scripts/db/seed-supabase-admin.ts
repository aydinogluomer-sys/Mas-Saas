import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import { Pool } from "pg";
import { createHash } from "node:crypto";
import { hashPassword } from "../../src/lib/auth";

async function seed() {
  const conn =
    process.env.SUPABASE_DB_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!conn) {
    throw new Error("SUPABASE_DB_URL veya DATABASE_URL tanımlı değil.");
  }
  const pool = new Pool({ connectionString: conn });
  const client = await pool.connect();
  try {
    await client.query("set role mas_radar_admin");

    // 1. System actor
    const sysHash = await hashPassword("SystemPassword123!");
    await client.query(
      `insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
       values ('system', $1, 'Sistem Hesabı', 'admin', false, false)
       on conflict (username) do update set is_active=false, must_change_password=false`,
      [sysHash],
    );
    console.log("System actor ready.");

    // 2. Admin user
    const adminHash = await hashPassword("Admin123456!");
    const res = await client.query(
      `insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
       values ('admin', $1, 'Yönetici (CFO)', 'admin', true, false)
       on conflict (username) do update set password_hash=$1, is_active=true, must_change_password=false
       returning id, username, role`,
      [adminHash],
    );
    console.log("Admin user ready:", res.rows[0]);

    // 3. Create active session for admin with a permanent token
    const token = "qa-crawler-session-token-123456789";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await client.query(
      `insert into public.sessions (user_id, token_hash, expires_at)
       values ($1, $2, $3)
       on conflict do nothing`,
      [res.rows[0].id, tokenHash, expiresAt],
    );
    console.log("Active admin session created with token:", token);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
