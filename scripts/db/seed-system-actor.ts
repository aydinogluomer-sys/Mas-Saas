// P0-A: seeds the one reserved, is_active=false "system" account used to attribute
// mutations made by non-interactive tooling (legacy-repair-apply.ts, seed-demo.ts,
// disposable-DB verify scripts) that has no real logged-in session to draw an actor id
// from. Never used to log in — the point is an explicit, filterable "system" identity in
// audit_logs, never a silent null.
//
// Run standalone (argument-less, idempotent) once per real environment (dev, prod) after
// migrating. Disposable-DB test scripts instead call ensureSystemActor(pool) directly
// against their own throwaway database. Never invoked by any migration itself (schema and
// seed data are kept separate, same principle as seed-admin.ts).
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { hash as argon2Hash } from "@node-rs/argon2";
import { ownerDatabaseUrl } from "./owner-url";

// `2` is Algorithm.Argon2id — @node-rs/argon2's Algorithm is a const enum, which can't be
// imported by value under this project's isolatedModules; see src/lib/auth.ts.
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const SYSTEM_ACTOR_USERNAME = "system";

export async function getSystemActorId(pool: Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(`select id from public.users where username = $1`, [
    SYSTEM_ACTOR_USERNAME,
  ]);
  if (res.rowCount !== 1) {
    throw new Error(
      `'${SYSTEM_ACTOR_USERNAME}' rezerve hesabı bulunamadı — önce 'tsx scripts/db/seed-system-actor.ts' çalıştırılmalı.`,
    );
  }
  return res.rows[0].id;
}

/** Idempotent — safe to call against any DB (real or disposable) on every run. Returns the
 * row's id whether it was just created or already existed. */
export async function ensureSystemActor(pool: Pool): Promise<string> {
  // Not a real credential — is_active=false means it can never log in, and there is no
  // password an attacker could even try (a random, never-recorded value is hashed here
  // purely to satisfy the not-null password_hash column).
  const unusablePasswordHash = await argon2Hash(randomBytes(32).toString("base64url"), ARGON2_OPTIONS);
  const res = await pool.query<{ id: string }>(
    `insert into public.users (username, password_hash, display_name, role, is_active)
     values ($1, $2, 'Sistem (otomatik araçlar)', 'operator', false)
     on conflict (username) do nothing
     returning id`,
    [SYSTEM_ACTOR_USERNAME, unusablePasswordHash],
  );
  if (res.rowCount === 1) return res.rows[0].id;
  return getSystemActorId(pool);
}

async function main(): Promise<void> {
  const databaseUrl = ownerDatabaseUrl();
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const id = await ensureSystemActor(pool);
    console.log(`OK — '${SYSTEM_ACTOR_USERNAME}' hesabı hazır, id=${id}`);
  } finally {
    await pool.end();
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
