// Real multi-user auth (P0-A). Replaces the old single-shared-password HMAC gate with
// named accounts, admin/operator roles, and DB-backed sessions (random opaque token,
// hashed server-side — never a recomputed HMAC, never stored in plaintext).
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { getRawPool } from "@/lib/db";
import type { AppRole } from "@/lib/authz/matrix";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { cache } from "@/lib/cache/engine";

export { SESSION_COOKIE };
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — unchanged from the old gate's UX
/** Faz 16 — inactivity window layered UNDER the 7-day absolute expiry, not replacing it.
 * The cookie's own maxAge stays at 7 days on purpose: the server, not the browser, decides
 * when an idle session dies, so shortening the cookie would only hide the check. */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// OWASP's current minimum-recommended Argon2id parameters — more than adequate for a
// handful of logins/day on a single internal-tool deployment. `2` is Algorithm.Argon2id
// (@node-rs/argon2's `Algorithm` is a const enum — importing it by value fails under this
// project's isolatedModules; its own .d.ts documents 2 as Argon2id, also the package default).
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Faz 24B widened this from admin|operator to the five tiers. It is an alias rather than a
// second list so the roles are defined in exactly one place — @/lib/authz/matrix, which is also
// what the permission matrix and the RLS gate read.
export type UserRole = AppRole;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword?: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/** Destination must be same-origin and relative — never follow a user-supplied redirect
 * target that could point off-site (protocol-relative `//evil.com`, or an absolute URL). */
export function safeRedirectPath(input: string | null | undefined, fallback: string): string {
  if (!input) return fallback;
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("://")) return fallback;
  return input;
}

export interface AttemptLoginResult {
  ok: boolean;
  userId?: string;
  mustChangePassword?: boolean;
}

// A real argon2id hash of a random, never-recorded value — compared against on every
// login attempt where the username doesn't exist (or is submitted empty), so that path
// pays the same CPU cost as a real wrong-password check. Computed once per process and
// memoized: `attemptLogin` below never branches on found-vs-not-found before this point,
// which is the actual fix — see its own comment. This constant is never a valid credential
// for any account.
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) dummyPasswordHash = argon2Hash(randomBytes(32).toString("base64url"), ARGON2_OPTIONS);
  return dummyPasswordHash;
}

/** Username lookup + password verification + brute-force lockout, all in one transaction
 * (SELECT ... FOR UPDATE) so two concurrent attempts against the same account can't race
 * past the failed-attempt counter. Every failure path (unknown username, wrong password,
 * locked account, inactive account) returns the same shape — the caller must show one
 * generic message for all of them to avoid revealing which case occurred.
 *
 * Response SHAPE alone isn't enough — response TIME leaks the same information if a real
 * argon2 verify only runs for usernames that exist. So `argon2Verify` runs exactly once on
 * every call, unconditionally, against the real hash if found or `getDummyPasswordHash()`
 * if not (empty input included) — every branch below (not-found, inactive, locked, wrong
 * password) is decided only AFTER that fixed-cost call, never before it. */
export async function attemptLogin(rawUsername: string, password: string): Promise<AttemptLoginResult> {
  const username = rawUsername.trim().toLowerCase();
  if (!username || !password) {
    await argon2Verify(await getDummyPasswordHash(), password || " ");
    return { ok: false };
  }
  const client = await getRawPool().connect();
  try {
    await client.query("begin");
    const res = await client.query<{
      id: string;
      password_hash: string;
      is_active: boolean;
      locked_until: string | null;
      failed_login_count: number;
      must_change_password: boolean;
    }>(
      `select id, password_hash, is_active, locked_until, failed_login_count, must_change_password
       from public.users where username = $1 for update`,
      [username],
    );
    const row = res.rowCount === 1 ? res.rows[0] : null;
    const validPassword = await argon2Verify(row?.password_hash ?? (await getDummyPasswordHash()), password);
    if (!row) {
      await client.query("commit");
      return { ok: false };
    }
    const lockedNow = row.locked_until != null && new Date(row.locked_until).getTime() > Date.now();
    if (!row.is_active || lockedNow) {
      await client.query("commit");
      return { ok: false };
    }
    if (!validPassword) {
      const nextCount = row.failed_login_count + 1;
      const lockUntil = nextCount >= MAX_FAILED_LOGIN_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        : null;
      await client.query(`update public.users set failed_login_count = $2, locked_until = $3 where id = $1`, [
        row.id,
        nextCount,
        lockUntil,
      ]);
      await client.query("commit");
      return { ok: false };
    }
    await client.query(`update public.users set failed_login_count = 0, locked_until = null where id = $1`, [row.id]);
    await client.query("commit");
    return { ok: true, userId: row.id, mustChangePassword: !!row.must_change_password };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Random opaque token — never deterministic. Only its SHA-256 lives in the DB; the raw
 * token exists only in the client's cookie, same principle as never storing a plaintext
 * password. */
export async function createSessionCookie(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  await getRawPool().query(`insert into public.sessions (user_id, token_hash, expires_at) values ($1, $2, $3)`, [
    userId,
    tokenHash,
    expiresAt,
  ]);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000,
  });
}

// Reserved, is_active=false account used only by the TestSprite QA harness — never a real
// login. Deliberately never created by any migration (production/dev databases never carry
// it); only disposable/test DB fixtures seed this row. If MAS_QA_BYPASS_AUTH is left on by
// accident anywhere the row doesn't exist, this simply falls through to a real (failing)
// session check — fail-closed, not fail-open.
const QA_BYPASS_USERNAME = "testsprite-qa";

async function getQaBypassUser(): Promise<SessionUser | null> {
  // NODE_ENV stays a direct read (Next.js inlines it at build time); only the bypass flag
  // itself comes from the validated env module.
  if (!env.qaBypassAuth || process.env.NODE_ENV === "production") return null;
  const res = await getRawPool().query<{ id: string; username: string; display_name: string; role: UserRole }>(
    `select id, username, display_name, role from public.users where username = $1 and is_active = false`,
    [QA_BYPASS_USERNAME],
  );
  if (res.rowCount !== 1) return null;
  const row = res.rows[0];
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const qaUser = await getQaBypassUser();
  if (qaUser) return qaUser;

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return cache.withCache(
    `auth:session:${tokenHash}`,
    async () => {
      const pool = getRawPool();
      const res = await pool.query<{
        id: string;
        username: string;
        display_name: string;
        role: UserRole;
        must_change_password: boolean;
        session_id: string;
        last_seen_at: string | null;
        created_at: string;
      }>(
        `select u.id, u.username, u.display_name, u.role, u.must_change_password, s.id as session_id, s.last_seen_at, s.created_at
         from public.sessions s join public.users u on u.id = s.user_id
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.is_active`,
        [tokenHash],
      );
      if (res.rowCount !== 1) return null;
      const row = res.rows[0];

      const referenceMs = new Date(row.last_seen_at ?? row.created_at).getTime();
      if (Date.now() - referenceMs > IDLE_TIMEOUT_MS) {
        await pool.query(`update public.sessions set revoked_at = now() where id = $1 and revoked_at is null`, [
          row.session_id,
        ]);
        return null;
      }

      const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (Date.now() - lastSeenMs > 5 * 60_000) {
        pool.query(`update public.sessions set last_seen_at = now() where id = $1`, [row.session_id]).catch(() => {});
      }

      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        mustChangePassword: !!row.must_change_password,
      };
    },
    { ttlSeconds: 30 }
  );
}

export async function requireSession(options?: { allowMustChangePassword?: boolean }): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !options?.allowMustChangePassword) {
    redirect("/change-password");
  }
  return user;
}

export async function requireAdmin(options?: { allowMustChangePassword?: boolean }): Promise<SessionUser> {
  const user = await requireSession(options);
  if (user.role !== "admin") redirect("/overview");
  return user;
}

/** Marks the current cookie's session revoked in the DB (not just deleting the client's
 * copy) — a stolen/leaked token stops working immediately, not just once the browser
 * forgets it. */
export async function revokeCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await cache.delete(`auth:session:${tokenHash}`);
    await getRawPool().query(`update public.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
      tokenHash,
    ]);
  }
  jar.delete(SESSION_COOKIE);
}
