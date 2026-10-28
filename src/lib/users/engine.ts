// P0-A user administration. Every mutation here is admin-only (enforced by the caller,
// src/app/(dashboard)/system/security/actions.ts) and audited with the acting admin's real
// user id — never a null or synthetic actor.
//
// Passwords never appear in audit_logs: before_data/after_data carry only non-secret fields
// (username, display_name, role, is_active, must_change_password). A password change is
// recorded as the FACT that it happened, never the value or the hash.
//
// There is no public signup and no email-based reset anywhere in this app (no email
// infrastructure exists — reminders are Telegram-only), so password resets are admin-driven
// by design, same as scripts/db/seed-admin.ts.
//
// Forced password change (migration 0095): an account an admin creates or resets here must
// choose its own password at its next request, and an admin can demand that of any account
// without resetting it. The signed-in user's OWN change is not here — it is not an admin
// operation, and it must run on the identity connection rather than the caller's tier, so it
// lives next to the login check in @/lib/auth (changeOwnPassword). Wave 0 moved it: the
// unreviewed layer ran it from here through the tier pool, where only the admin tier may update
// public.users, so every other tier was locked out at /change-password for good.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DomainError } from "@/lib/domain-error";
import { hashPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { APP_ROLES, type AppRole } from "@/lib/authz/matrix";
import { passwordSchema } from "./password-policy";

/** Mirrors the DB CHECK in 0031 — kept in sync deliberately so a bad value fails at the
 * boundary with a Turkish message instead of as a raw Postgres constraint error. */
const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{3,32}$/, "Kullanıcı adı 3-32 karakter olmalı; yalnız küçük harf, rakam, nokta, tire, alt tire.");
const displayNameSchema = z.string().trim().min(1, "Görünen ad zorunlu.").max(120, "Görünen ad çok uzun.");
// Faz 24B: the five tiers, taken from the permission matrix rather than restated, so the form
// can never accept a role the matrix does not know how to enforce.
const roleSchema = z.enum(APP_ROLES);

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  role: roleSchema,
  password: passwordSchema,
  mustChangePassword: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export interface UserListRow {
  id: string;
  username: string;
  displayName: string;
  role: AppRole;
  isActive: boolean;
  lockedUntil: string | null;
  failedLoginCount: number;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions: number;
  mustChangePassword: boolean;
}

/** The reserved non-login accounts (see scripts/db/seed-system-actor.ts). They exist only to
 * own audit rows written by non-interactive tooling and must never be listed as manageable
 * people — editing or "reactivating" one would be meaningless at best and would turn a
 * never-loggable identity into a real credential at worst. Exported for the one other place that
 * hands out passwords, scripts/ops/rotate-passwords.ts, so the two lists cannot drift apart. */
export const RESERVED_USERNAMES: readonly string[] = ["system", "testsprite-qa"];

export async function listUsers(pool: Pool): Promise<UserListRow[]> {
  const res = await pool.query<{
    id: string; username: string; display_name: string; role: AppRole;
    is_active: boolean; locked_until: string | null; failed_login_count: number;
    created_at: string; last_seen_at: string | null; active_sessions: number;
    must_change_password: boolean;
  }>(
    `select u.id, u.username, u.display_name, u.role, u.is_active, u.locked_until,
            u.failed_login_count, u.created_at, u.must_change_password,
            max(s.last_seen_at) filter (where s.revoked_at is null) as last_seen_at,
            count(s.id) filter (where s.revoked_at is null and s.expires_at > now())::int as active_sessions
       from public.users u
       left join public.sessions s on s.user_id = u.id
      where u.username <> all($1::text[])
      group by u.id
      order by u.role, u.username`,
    [RESERVED_USERNAMES],
  );
  return res.rows.map((r) => ({
    id: r.id, username: r.username, displayName: r.display_name, role: r.role,
    isActive: r.is_active, lockedUntil: r.locked_until, failedLoginCount: r.failed_login_count,
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, activeSessions: Number(r.active_sessions),
    mustChangePassword: !!r.must_change_password,
  }));
}

/** Non-secret projection used for audit before/after. Never includes password_hash.
 * must_change_password joined it with 0095: without it a forced-change or reset row could only
 * say what the flag became, never what it was. */
interface UserAuditShape {
  username: string; display_name: string; role: string; is_active: boolean; must_change_password: boolean;
}
async function loadForAudit(client: PoolClient, id: string): Promise<UserAuditShape> {
  const res = await client.query<UserAuditShape>(
    `select username, display_name, role, is_active, must_change_password from public.users where id=$1 for update`,
    [id],
  );
  if (res.rowCount !== 1) throw new DomainError("Kullanıcı bulunamadı.");
  return res.rows[0];
}

/** Guards every mutation below: a reserved account is never a valid administration target,
 * even if its id is submitted directly (the UI never renders one, but the id is not a secret). */
async function assertNotReserved(client: PoolClient, id: string): Promise<void> {
  const res = await client.query<{ username: string }>(`select username from public.users where id=$1`, [id]);
  if (res.rowCount !== 1) throw new DomainError("Kullanıcı bulunamadı.");
  if (RESERVED_USERNAMES.includes(res.rows[0].username)) {
    throw new DomainError("Bu hesap sistem tarafından ayrılmıştır; yönetilemez.");
  }
}

export async function createUser(pool: Pool, input: CreateUserInput, actorId: string): Promise<string> {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? "Geçersiz giriş.");
  const { username, displayName, role, password, mustChangePassword = true } = parsed.data;
  if (password.toLowerCase() === username.toLowerCase()) {
    throw new DomainError("Parola kullanıcı adıyla aynı olamaz.");
  }
  if (RESERVED_USERNAMES.includes(username)) {
    throw new DomainError("Bu kullanıcı adı sistem tarafından ayrılmıştır.");
  }
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query(`select 1 from public.users where username=$1`, [username]);
    if (exists.rowCount) throw new DomainError("Bu kullanıcı adı zaten kullanılıyor.");
    const res = await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role, must_change_password)
       values ($1,$2,$3,$4,$5) returning id`,
      [username, passwordHash, displayName, role, mustChangePassword],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId, action: "create_user", entityTable: "users", entityId: id, before: null,
      after: { username, display_name: displayName, role, is_active: true, must_change_password: mustChangePassword },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Admin-driven reset. Revokes the target's live sessions in the same transaction — a reset
 * that left the old cookie working would not actually lock anyone out. */
export async function resetUserPassword(
  pool: Pool,
  id: string,
  newPassword: string,
  actorId: string,
  forceMustChange = true,
): Promise<void> {
  const parsed = passwordSchema.safeParse(newPassword);
  if (!parsed.success) throw new DomainError(parsed.error.issues[0]?.message ?? "Geçersiz parola.");
  const passwordHash = await hashPassword(parsed.data);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    if (parsed.data.toLowerCase() === before.username.toLowerCase()) {
      throw new DomainError("Parola kullanıcı adıyla aynı olamaz.");
    }
    await client.query(
      `update public.users set password_hash=$2, must_change_password=$3, failed_login_count=0, locked_until=null where id=$1`,
      [id, passwordHash, forceMustChange],
    );
    const revoked = await client.query(
      `update public.sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,
      [id],
    );
    // The new password itself is never recorded — only that a reset happened, and its effect.
    await audit(client, {
      actor: actorId, action: "reset_user_password", entityTable: "users", entityId: id, before,
      after: { ...before, password_changed: true, must_change_password: forceMustChange, sessions_revoked: revoked.rowCount ?? 0 },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Forces an account to change password on their next request without resetting it. The
 * account's open sessions stay open on purpose: getCurrentUser() reads the flag live on every
 * request, so the very next page that user opens sends them to /change-password, and their own
 * change then closes every other session. */
export async function forcePasswordChange(pool: Pool, id: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    await client.query(`update public.users set must_change_password=true where id=$1`, [id]);
    await audit(client, {
      actor: actorId, action: "force_password_change", entityTable: "users", entityId: id, before,
      after: { ...before, must_change_password: true },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Deactivation also revokes live sessions, for the same reason a password reset does.
 * The "at least one active admin" invariant is enforced by 0031's deferred constraint
 * trigger, so a race between two admin sessions cannot slip past a UI-only check. */
export async function setUserActive(pool: Pool, id: string, isActive: boolean, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    await client.query(
      `update public.users set is_active=$2, failed_login_count=0, locked_until=null where id=$1`,
      [id, isActive],
    );
    let sessionsRevoked = 0;
    if (!isActive) {
      const revoked = await client.query(
        `update public.sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,
        [id],
      );
      sessionsRevoked = revoked.rowCount ?? 0;
    }
    await audit(client, {
      actor: actorId, action: isActive ? "activate_user" : "deactivate_user", entityTable: "users",
      entityId: id, before,
      after: { ...before, is_active: isActive, sessions_revoked: sessionsRevoked },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function setUserRole(pool: Pool, id: string, role: AppRole, actorId: string): Promise<void> {
  const parsed = roleSchema.safeParse(role);
  if (!parsed.success) throw new DomainError("Geçersiz rol.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    await client.query(`update public.users set role=$2 where id=$1`, [id, parsed.data]);
    // Faz 16 — a role change must not wait for the target's session to expire. Role is read
    // once per request from public.users, so a demoted admin would otherwise keep admin-level
    // access for up to seven days on their existing cookie. Revoking forces a fresh login and
    // therefore a fresh role. Same transaction as the role write: the two cannot diverge.
    const revoked = await client.query(
      `update public.sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,
      [id],
    );
    await audit(client, {
      actor: actorId, action: "set_user_role", entityTable: "users", entityId: id, before,
      after: {
        ...before,
        role: parsed.data,
        sessions_revoked: revoked.rowCount ?? 0,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Clears a brute-force lockout without touching the password. */
export async function unlockUser(pool: Pool, id: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    await client.query(`update public.users set failed_login_count=0, locked_until=null where id=$1`, [id]);
    await audit(client, {
      actor: actorId, action: "unlock_user", entityTable: "users", entityId: id, before,
      after: { ...before, unlocked: true },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
