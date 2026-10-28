#!/usr/bin/env node
/**
 * scripts/ops/rotate-passwords.ts — give named accounts a fresh temporary password and force each
 * of them to choose their own at the next login (migration 0095 + /change-password).
 *
 * Usage (on this machine, in an interactive terminal — the temporary passwords are printed once):
 *   pnpm exec tsx scripts/ops/rotate-passwords.ts [--users=admin,atilla]
 *   pnpm exec tsx scripts/ops/rotate-passwords.ts --check          (status only; changes nothing)
 *
 * Per account, in ONE transaction: new argon2id hash, must_change_password = true, failed-login
 * counter and lockout cleared, every open session revoked, one audit row. Nothing is stored
 * anywhere except the hash; the temporary password exists only on this console.
 *
 * ── Wave 0 hardening (the unreviewed layer's version could not run, and recorded the wrong actor)
 *
 *   Connection   The OWNER connection (MIGRATION_DATABASE_URL, scripts/db/owner-url.ts), the same
 *                way seed-admin.ts administers accounts. The layer used the app pool, i.e. plain
 *                mas_radar_app, which has no audit_logs policy at all — on the native PostgreSQL
 *                the rotation transaction was refused at its audit insert.
 *   Audit        Through the one audit writer (src/lib/audit.ts), never an inline insert — the
 *                layer's inline insert also failed phase18:verify, which keeps that rule in CI.
 *   Actor        The reserved 'system' account (scripts/db/seed-system-actor.ts getSystemActorId),
 *                because no person is signed in here. The layer wrote the TARGET as the actor, so
 *                the trail claimed every rotated user had rotated their own password.
 *   Tier         The audit row is written under the system account's own tier (`set local role`,
 *                `app.user_id` = that account), so it passes the same RLS any job's evidence does
 *                instead of riding on the superuser's bypass. Both settings end with the
 *                transaction; the account updates before them stay on the owner connection.
 *   Targets      Reserved accounts ('system', 'testsprite-qa') and inactive accounts are refused —
 *                a password on an account that cannot log in is a credential nobody should hold.
 *                Each account is its own transaction: one failure rolls back that account only and
 *                the run exits non-zero.
 *   Randomness   crypto.randomInt — the layer's `byte % 65` favoured the first 61 symbols.
 *   Output       Rotation refuses to run when stdout is not a terminal (a pipe, a redirect, a
 *                scheduled task's log): a temporary password must never land in a file.
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { randomInt } from "node:crypto";
import { Pool } from "pg";
import { audit } from "../../src/lib/audit";
import { APP_ROLES, DB_ROLE, type AppRole } from "../../src/lib/authz/matrix";
import { requireOwnerDatabaseUrl } from "../db/owner-url";
import { getSystemActorId } from "../db/seed-system-actor";

/** Without look-alikes (0/O, 1/l/I). 20 symbols from 65 ≈ 120 bits; the app's floor is 12. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+";
const TEMP_PASSWORD_LENGTH = 20;

function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const DEFAULT_TARGETS = ["admin", "atilla"];

interface RotationRow {
  Kullanıcı: string;
  Rol: string;
  "Geçici Parola": string;
  "Kapatılan Oturum": number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");

  // Before any connection: the one output this tool produces is a set of live credentials.
  if (!isCheck && !process.stdout.isTTY) {
    console.error(
      "DURDURULDU: çıktı bir terminal değil (yönlendirme, boru ya da zamanlanmış görev günlüğü). " +
        "Geçici parolalar yalnız etkileşimli konsola yazılır; hiçbir şey değiştirilmedi.",
    );
    process.exitCode = 1;
    return;
  }

  // Dynamic: @/lib/auth pulls in @/lib/env, which validates DATABASE_URL as it loads — that must
  // happen AFTER loadEnvConfig above, and static imports are evaluated before it.
  const [{ hashPassword }, { RESERVED_USERNAMES }] = await Promise.all([
    import("../../src/lib/auth"),
    import("../../src/lib/users/engine"),
  ]);

  const pool = new Pool({ connectionString: requireOwnerDatabaseUrl(), max: 1 });
  try {
    if (isCheck) {
      const res = await pool.query<{
        username: string;
        role: string;
        is_active: boolean;
        must_change_password: boolean;
        locked_until: string | null;
        failed_login_count: number;
      }>(
        `select username, role, is_active, must_change_password, locked_until, failed_login_count
           from public.users order by username`,
      );
      console.log("\n=== KULLANICI GÜVENLİK DURUMU ===");
      console.table(res.rows);
      return;
    }

    const userArg = args.find((a) => a.startsWith("--users="));
    const targets = userArg
      ? [...new Set(userArg.slice("--users=".length).split(",").map((u) => u.trim().toLowerCase()).filter(Boolean))]
      : DEFAULT_TARGETS;
    if (targets.length === 0) throw new Error("--users= boş; en az bir kullanıcı adı verin.");

    // The actor every audit row names, and the tier that writes it. Fails closed, before any
    // account is touched, if the reserved account is missing or carries an unknown role.
    const actorId = await getSystemActorId(pool);
    const actorRes = await pool.query<{ role: string }>(`select role from public.users where id = $1`, [actorId]);
    const actorRole = actorRes.rows[0]?.role;
    if (!actorRole || !(APP_ROLES as readonly string[]).includes(actorRole)) {
      throw new Error(`'system' hesabının katmanı tanınmıyor (${actorRole ?? "yok"}); hiçbir hesap değiştirilmedi.`);
    }
    const actorDbRole = DB_ROLE[actorRole as AppRole];

    console.log("\n=== ŞİFRE ROTASYONU ===");
    console.log(`Hedef hesaplar: ${targets.join(", ")}`);
    console.log("Her hesap ilk girişte /change-password ekranına yönlendirilir.\n");

    const rotated: RotationRow[] = [];
    const problems: string[] = [];
    const client = await pool.connect();
    try {
      for (const username of targets) {
        try {
          await client.query("begin");
          const res = await client.query<{
            id: string;
            username: string;
            display_name: string;
            role: string;
            is_active: boolean;
            must_change_password: boolean;
          }>(
            `select id, username, display_name, role, is_active, must_change_password
               from public.users where username = $1 for update`,
            [username],
          );
          const user = res.rowCount === 1 ? res.rows[0] : null;
          const refusal = !user
            ? "bulunamadı"
            : RESERVED_USERNAMES.includes(user.username)
              ? "sistem tarafından ayrılmış hesap — parola verilmez"
              : !user.is_active
                ? "pasif hesap — giriş yapamaz, parola verilmez"
                : null;
          if (!user || refusal) {
            await client.query("rollback");
            problems.push(`${username}: ${refusal}`);
            continue;
          }

          const temporaryPassword = generateTemporaryPassword();
          const passwordHash = await hashPassword(temporaryPassword);
          // Captured before the update: the trail records what the account looked like, not what
          // this run made of it.
          const before = {
            username: user.username,
            display_name: user.display_name,
            role: user.role,
            is_active: user.is_active,
            must_change_password: user.must_change_password,
          };
          await client.query(
            `update public.users
                set password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = null
              where id = $1`,
            [user.id, passwordHash],
          );
          const revoked = await client.query(
            `update public.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
            [user.id],
          );
          const sessionsRevoked = revoked.rowCount ?? 0;

          // Until COMMIT the transaction runs in that tier, deferred checks included. The one
          // deferred trigger on public.users (users_require_active_admin, 0031) fires only on
          // updates OF role or is_active, and the update above writes neither.
          await client.query("select set_config('app.user_id', $1, true)", [actorId]);
          await client.query(`set local role ${actorDbRole}`);
          await audit(client, {
            actor: actorId,
            action: "rotate_user_password_ops",
            entityTable: "users",
            entityId: user.id,
            before,
            after: { ...before, password_changed: true, must_change_password: true, sessions_revoked: sessionsRevoked },
          });
          await client.query("commit");

          rotated.push({
            Kullanıcı: user.username,
            Rol: user.role,
            "Geçici Parola": temporaryPassword,
            "Kapatılan Oturum": sessionsRevoked,
          });
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          problems.push(`${username}: ${e instanceof Error ? e.message : String(e)} (bu hesapta hiçbir değişiklik kalmadı)`);
        }
      }
    } finally {
      client.release();
    }

    if (rotated.length > 0) {
      console.log("=== DÖNDÜRÜLEN HESAPLAR ===");
      console.table(rotated);
      console.log(
        "\nGeçici parolaları sahiplerine ayrı ve güvenli bir yoldan iletin. Hiçbir yerde saklanmadılar; " +
          "bu ekran kapanınca yeniden gösterilemezler.\n",
      );
    }
    if (problems.length > 0) {
      console.error("=== DÖNDÜRÜLMEYEN HESAPLAR ===");
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Şifre rotasyonu hatası:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
