// P0-A user administration. Every mutation here is admin-only (enforced by the caller,
// src/app/(dashboard)/system/security/actions.ts) and audited with the acting admin's real
// user id — never a null or synthetic actor.
//
// Passwords never appear in audit_logs: before_data/after_data carry only non-secret fields
// (username, display_name, role, is_active, must_change_password). A password change is
// recorded as the FACT that it happened, never the value or the hash.
//
// Forced password change (migration 0095) + admin session visibility/revocation (migration 0098):
// sessions_admin_read and sessions_admin_revoke allow `mas_radar_admin` to count and revoke
// live sessions of managed accounts inside the tier-scoped transaction.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DomainError } from "@/lib/domain-error";
import { hashPassword } from "@/lib/auth";
import { encryptTotpSecret, verifyTotpCode } from "@/lib/auth/totp";
import { audit } from "@/lib/audit";
import { APP_ROLES, type AppRole } from "@/lib/authz/matrix";
import { passwordSchema } from "./password-policy";

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{3,32}$/, "Kullanıcı adı 3-32 karakter olmalı; yalnız küçük harf, rakam, nokta, tire, alt tire.");
const displayNameSchema = z.string().trim().min(1, "Görünen ad zorunlu.").max(120, "Görünen ad çok uzun.");
const roleSchema = z.enum(APP_ROLES);

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  email: z.string().trim().email("Geçerli bir e-posta adresi giriniz.").max(180).optional().nullable(),
  role: roleSchema,
  password: passwordSchema,
  mustChangePassword: z.boolean().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export interface UserListRow {
  id: string;
  username: string;
  displayName: string;
  email?: string | null;
  role: AppRole;
  isActive: boolean;
  lockedUntil: string | null;
  failedLoginCount: number;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions: number;
  mustChangePassword: boolean;
  totpEnabled?: boolean;
}

export interface ActiveSessionRow {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
}

export const RESERVED_USERNAMES: readonly string[] = ["system", "testsprite-qa"];

export async function listUsers(pool: Pool): Promise<UserListRow[]> {
  try {
    const res = await pool.query<{
      id: string; username: string; display_name: string; email: string | null; role: AppRole;
      is_active: boolean; locked_until: string | null; failed_login_count: number;
      created_at: string; last_seen_at: string | null; active_sessions: number;
      must_change_password: boolean; totp_enabled: boolean;
    }>(
      `select u.id, u.username, u.display_name, u.email, u.role, u.is_active, u.locked_until,
              u.failed_login_count, u.created_at, u.must_change_password,
              (u.totp_enabled_at is not null) as totp_enabled,
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
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      email: r.email,
      role: r.role,
      isActive: r.is_active,
      lockedUntil: r.locked_until,
      failedLoginCount: r.failed_login_count,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      activeSessions: Number(r.active_sessions),
      mustChangePassword: !!r.must_change_password,
      totpEnabled: !!r.totp_enabled,
    }));
  } catch {
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
}

export const listUsersWithActivity = listUsers;

interface UserAuditShape {
  username: string; display_name: string; role: string; is_active: boolean; must_change_password: boolean;
}
async function loadForAudit(client: PoolClient, id: string): Promise<UserAuditShape> {
  const res = await client.query<UserAuditShape>(
    `select username, display_name, role, is_active, must_change_password from public.users where id=$1 for update`,
    [id],
  );
  if (res.rowCount !== 1) throw new DomainError("NOT_FOUND", "Kullanıcı bulunamadı.");
  return res.rows[0];
}

async function assertNotReserved(client: PoolClient, id: string): Promise<void> {
  const res = await client.query<{ username: string }>(`select username from public.users where id=$1`, [id]);
  if (res.rowCount !== 1) throw new DomainError("NOT_FOUND", "Kullanıcı bulunamadı.");
  if (RESERVED_USERNAMES.includes(res.rows[0].username)) {
    throw new DomainError("FORBIDDEN", "Bu hesap sistem tarafından ayrılmıştır; yönetilemez.");
  }
}

export async function createUser(pool: Pool, input: CreateUserInput, actorId: string): Promise<string> {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz giriş.");
  const { username, displayName, role, password, mustChangePassword = true } = parsed.data;
  if (password.toLowerCase() === username.toLowerCase()) {
    throw new DomainError("VALIDATION", "Parola kullanıcı adıyla aynı olamaz.");
  }
  if (RESERVED_USERNAMES.includes(username)) {
    throw new DomainError("FORBIDDEN", "Bu kullanıcı adı sistem tarafından ayrılmıştır.");
  }
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query(`select 1 from public.users where username=$1`, [username]);
    if (exists.rowCount) throw new DomainError("CONFLICT", "Bu kullanıcı adı zaten kullanılıyor.");
    const res = await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role, must_change_password)
       values ($1,$2,$3,$4,$5) returning id`,
      [username, passwordHash, displayName, role, mustChangePassword],
    );
    const id = res.rows[0].id;
    const cleanEmail = parsed.data.email?.trim() || null;
    if (cleanEmail) {
      await client.query("savepoint usr_email_sp");
      try {
        await client.query(`update public.users set email = $2 where id = $1`, [id, cleanEmail]);
        await client.query("release savepoint usr_email_sp");
      } catch {
        await client.query("rollback to savepoint usr_email_sp");
        await client.query("release savepoint usr_email_sp");
      }
    }
    await audit(client, {
      actor: actorId, action: "create_user", entityTable: "users", entityId: id, before: null,
      after: { username, display_name: displayName, email: cleanEmail, role, is_active: true, must_change_password: mustChangePassword },
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

export async function resetUserPassword(
  pool: Pool,
  id: string,
  newPassword: string,
  actorId: string,
  forceMustChange = true,
): Promise<{ sessionsRevoked: number }> {
  const parsed = passwordSchema.safeParse(newPassword);
  if (!parsed.success) throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz parola.");
  const passwordHash = await hashPassword(parsed.data);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    if (parsed.data.toLowerCase() === before.username.toLowerCase()) {
      throw new DomainError("VALIDATION", "Parola kullanıcı adıyla aynı olamaz.");
    }
    const upd = await client.query(
      `update public.users set password_hash=$2, must_change_password=$3, failed_login_count=0, locked_until=null where id=$1`,
      [id, passwordHash, forceMustChange],
    );
    if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Kullanıcı parolası güncellenemedi.");
    const revoked = await client.query(
      `update public.sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,
      [id],
    );
    const sessionsRevoked = revoked.rowCount ?? 0;
    await audit(client, {
      actor: actorId, action: "reset_user_password", entityTable: "users", entityId: id, before,
      after: { ...before, password_changed: true, must_change_password: forceMustChange, sessions_revoked: sessionsRevoked },
    });
    await client.query("commit");
    return { sessionsRevoked };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function forcePasswordChange(pool: Pool, id: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    const upd = await client.query(`update public.users set must_change_password=true where id=$1`, [id]);
    if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Kullanıcı güncellenemedi.");
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

export async function setUserActive(pool: Pool, id: string, isActive: boolean, actorId: string): Promise<{ sessionsRevoked: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    const upd = await client.query(
      `update public.users set is_active=$2, failed_login_count=0, locked_until=null where id=$1`,
      [id, isActive],
    );
    if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Kullanıcı aktiflik durumu güncellenemedi.");
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
    return { sessionsRevoked };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export const deactivateUser = (pool: Pool, id: string, actorId: string) =>
  setUserActive(pool, id, false, actorId);

export async function setUserRole(pool: Pool, id: string, role: AppRole, actorId: string): Promise<{ sessionsRevoked: number }> {
  const parsed = roleSchema.safeParse(role);
  if (!parsed.success) throw new DomainError("VALIDATION", "Geçersiz rol.");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    const upd = await client.query(`update public.users set role=$2 where id=$1`, [id, parsed.data]);
    if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Kullanıcı rolü güncellenemedi.");
    const revoked = await client.query(
      `update public.sessions set revoked_at=now() where user_id=$1 and revoked_at is null`,
      [id],
    );
    const sessionsRevoked = revoked.rowCount ?? 0;
    await audit(client, {
      actor: actorId, action: "set_user_role", entityTable: "users", entityId: id, before,
      after: {
        ...before,
        role: parsed.data,
        sessions_revoked: sessionsRevoked,
      },
    });
    await client.query("commit");
    return { sessionsRevoked };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function unlockUser(pool: Pool, id: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, id);
    const before = await loadForAudit(client, id);
    const upd = await client.query(`update public.users set failed_login_count=0, locked_until=null where id=$1`, [id]);
    if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Kullanıcı kilidi kaldırılamadı.");
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

export async function listActiveSessions(pool: Pool, limit = 50): Promise<ActiveSessionRow[]> {
  try {
    const res = await pool.query<{
      id: string;
      user_id: string;
      username: string;
      display_name: string;
      ip_address: string | null;
      user_agent: string | null;
      created_at: string;
      last_seen_at: string | null;
      expires_at: string;
    }>(
      `select s.id::text,
              s.user_id::text,
              u.username,
              u.display_name,
              s.ip_address,
              s.user_agent,
              s.created_at::text,
              s.last_seen_at::text,
              s.expires_at::text
         from public.sessions s
         join public.users u on u.id = s.user_id
        where s.revoked_at is null
          and s.expires_at > now()
          and u.username <> all($1::text[])
        order by coalesce(s.last_seen_at, s.created_at) desc
        limit $2`,
      [RESERVED_USERNAMES, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
    }));
  } catch {
    return [];
  }
}

export async function revokeSingleSession(
  pool: Pool,
  sessionId: string,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const upd = await client.query<{ user_id: string }>(
      `update public.sessions
          set revoked_at = now()
        where id = $1 and revoked_at is null
        returning user_id::text`,
      [sessionId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Aktif oturum bulunamadı veya zaten sonlandırılmış.");
    }
    await audit(client, {
      actor: actorId,
      action: "revoke_single_session",
      entityTable: "sessions",
      entityId: sessionId,
      after: { revoked: true, targetUserId: upd.rows[0].user_id },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function enrollAndVerifyUserTotp(
  pool: Pool,
  userId: string,
  secretBase32: string,
  code: string,
  actorId: string,
): Promise<void> {
  if (!verifyTotpCode(secretBase32, code)) {
    throw new DomainError("VALIDATION", "6 haneli TOTP doğrulama kodu geçersiz veya süresi dolmuş.");
  }
  const encrypted = encryptTotpSecret(secretBase32);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, userId);
    const before = await loadForAudit(client, userId);
    const upd = await client.query(
      `update public.users
          set totp_secret_encrypted = $2,
              totp_enabled_at = now()
        where id = $1`,
      [userId, encrypted],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "TOTP etkinleştirilemedi.");
    }
    await audit(client, {
      actor: actorId,
      action: "enable_user_totp",
      entityTable: "users",
      entityId: userId,
      before,
      after: { ...before, totp_enabled: true },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function disableUserTotp(
  pool: Pool,
  userId: string,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertNotReserved(client, userId);
    const before = await loadForAudit(client, userId);
    const upd = await client.query(
      `update public.users
          set totp_secret_encrypted = null,
              totp_enabled_at = null
        where id = $1`,
      [userId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "TOTP devre dışı bırakılamadı.");
    }
    await audit(client, {
      actor: actorId,
      action: "disable_user_totp",
      entityTable: "users",
      entityId: userId,
      before,
      after: { ...before, totp_enabled: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
