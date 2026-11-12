// Real multi-user auth (P0-A). Replaces the old single-shared-password HMAC gate with
// named accounts, admin/operator roles, and DB-backed sessions (random opaque token,
// hashed server-side — never a recomputed HMAC, never stored in plaintext).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import * as nextHeaders from "next/headers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { getRawPool } from "@/lib/db";
import { audit } from "@/lib/audit";
import { APP_ROLES, DB_ROLE, can, canSeeRoute, type Action, type AppRole } from "@/lib/authz/matrix";
import { DomainError } from "@/lib/domain-error";
import { env } from "@/lib/env";
import { extractHostHeaderHostname, isLoopbackHostname } from "@/lib/env-validators";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { safeRedirectPath } from "@/lib/security/redirect";
import { PASSWORD_MAX_LENGTH, PasswordChangeError, passwordSchema } from "@/lib/users/password-policy";

export { SESSION_COOKIE, safeRedirectPath };
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

const DEFAULT_LOCAL_USER: SessionUser = Object.freeze({
  id: "eb9c61e7-ef57-4dae-b180-0e9d5b7fe8ae",
  username: "atilla",
  displayName: "Atilla Aydınoğlu",
  role: "admin",
  mustChangePassword: false,
});

export async function getCurrentUser(): Promise<SessionUser | null> {
  const qaUser = await getQaBypassUser();
  if (qaUser) return qaUser;

  let token: string | undefined;
  try {
    const jar = await cookies();
    token = jar.get(SESSION_COOKIE)?.value;
  } catch {
    token = undefined;
  }

  // Loopback passwordless opt-in ONLY applies when no session cookie was presented at all.
  // Any presented `mas_session` token that is revoked, expired, idle-timed-out, or tied to
  // a locked/inactive user MUST fail closed (`null`) and never resurrect as DEFAULT_LOCAL_USER.
  if (!token) {
    if (!env.localPasswordless || process.env.NODE_ENV === "production") {
      return null;
    }
    try {
      const h = await nextHeaders.headers();
      const forwardedHost = h.get("x-forwarded-host")?.trim() ?? "";
      const hostHeader = h.get("host")?.trim() ?? "";
      for (const rawHost of [forwardedHost, hostHeader]) {
        if (!rawHost) continue;
        for (const hop of rawHost.split(",")) {
          const trimmed = hop.trim();
          if (!trimmed) continue;
          const hostname = extractHostHeaderHostname(trimmed);
          if (!hostname || !isLoopbackHostname(hostname)) {
            return null;
          }
        }
      }
    } catch {
      // Called outside a Next.js HTTP request store (e.g. unit/CLI context).
      // Production is already rejected above before reaching this block.
    }
    return { ...DEFAULT_LOCAL_USER };
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  // Deliberately the RAW pool: this lookup is what DECIDES the tier, so it cannot already be
  // running inside one. It reaches users/sessions through the mas_radar_app-targeted policies
  // Faz 15 added, which exist for precisely this moment in the request.
  //
  // Faz 40 (A2): locked accounts (`u.locked_until > now()`) lose active session resolution
  // immediately, matching login refusal semantics.
  const pool = getRawPool();
  const res = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    role: UserRole;
    must_change_password?: boolean;
    session_id?: string;
    last_seen_at?: string | null;
    created_at?: string;
  }>(
    `select u.id, u.username, u.display_name, u.role, u.must_change_password, s.id as session_id, s.last_seen_at, s.created_at
     from public.sessions s join public.users u on u.id = s.user_id
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active
       and (u.locked_until is null or u.locked_until <= now())`,
    [tokenHash],
  );
  if (res.rowCount !== 1) {
    return null;
  }
  const row = res.rows[0];

  // Faz 16 — idle window, IN ADDITION TO the 7-day absolute expiry above (which stays as the
  // hard ceiling). `created_at` is the fallback because last_seen_at is NULL until the first bump.
  if (row.last_seen_at || row.created_at) {
    const referenceMs = new Date(row.last_seen_at ?? row.created_at!).getTime();
    if (Date.now() - referenceMs > IDLE_TIMEOUT_MS) {
      // Revoked, not merely ignored — the token must stop working everywhere, not just here.
      if (row.session_id) {
        await pool.query(`update public.sessions set revoked_at = now() where id = $1 and revoked_at is null`, [
          row.session_id,
        ]);
      }
      return null;
    }

    // Throttled — only bump if stale by more than 5 minutes, not on every single request.
    if (row.session_id) {
      const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (Date.now() - lastSeenMs > 5 * 60_000) {
        await pool.query(`update public.sessions set last_seen_at = now() where id = $1`, [row.session_id]);
      }
    }
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
  };
}

/**
 * The JSON-route counterpart of requireSession(): the session a route handler may serve, or null.
 *
 * Route handlers cannot use requireSession(): redirect() throws a control-flow error a JSON client
 * cannot follow, and the `requireSession().catch(() => null)` workaround also swallowed real
 * failures (a database outage became a 401 instead of a 500). This returns exactly what
 * requireSession() would let through — a live session (revocation, absolute expiry and the
 * Faz 16 idle window are all enforced inside getCurrentUser) whose user is NOT under a forced
 * password change (0095) — and null for everything else, which the route answers with its 401.
 * Before Wave 0 the JSON routes called getCurrentUser() directly and so kept serving financial
 * data to a user the pages had already sent to /change-password.
 */
interface RequestUserBox {
  promise?: Promise<SessionUser | null>;
}

const requestUserStore = new AsyncLocalStorage<RequestUserBox>();
const reactRequestUserBox = cache((): RequestUserBox => ({}));

/**
 * Explicit request-scoped session deduplication boundary for non-RSC callers and tests.
 * Inside a Next.js RSC render pass, React.cache() automatically provides an isolated box per HTTP
 * request; outside RSC, callers remain uncached unless explicitly wrapped here.
 */
export function withRequestSessionScope<T>(fn: () => Promise<T>): Promise<T> {
  return requestUserStore.run({}, fn);
}

/** Clears any memoized user lookup in the active request scope after an auth mutation. */
export function clearRequestSessionCache(): void {
  const storeBox = requestUserStore.getStore();
  if (storeBox) storeBox.promise = undefined;
  reactRequestUserBox().promise = undefined;
}

/**
 * Per-request deduplicated counterpart of getCurrentUser().
 *
 * Shares a single `sessions join users` lookup across DashboardLayout, module layouts,
 * requireRouteAccess and getDbContext() within one HTTP request render tree, with ZERO
 * cross-request state (revocation, deactivation and role changes take effect on the very next
 * request). Failed lookups clear the promise box so transient DB errors are never memoized.
 */
export async function getRequestUser(): Promise<SessionUser | null> {
  const box = requestUserStore.getStore() ?? reactRequestUserBox();
  if (!box.promise) {
    box.promise = getCurrentUser().catch((err) => {
      box.promise = undefined;
      throw err;
    });
  }
  return box.promise;
}

export async function requireApiSession(): Promise<SessionUser | null> {
  const user = await getRequestUser();
  if (!user || user.mustChangePassword) return null;
  return user;
}

export interface PermissionCheck {
  table: string;
  op: Action;
}

export interface RequireSessionOptions {
  allowMustChangePassword?: boolean;
  allowPasswordChangePending?: boolean;
  requiredPermission?: PermissionCheck;
  routePrefix?: string;
}

export async function requireSession(options?: RequireSessionOptions): Promise<SessionUser> {
  const user = await getRequestUser();
  if (!user) redirect("/login");
  const allowPending = Boolean(options?.allowMustChangePassword || options?.allowPasswordChangePending);
  if (user.mustChangePassword && !allowPending) {
    redirect("/change-password");
  }
  if (options?.routePrefix && !canSeeRoute(user.role, options.routePrefix)) {
    throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  if (options?.requiredPermission && !can(user.role, options.requiredPermission.table, options.requiredPermission.op)) {
    throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  return user;
}

/**
 * Faz 40 (A2) — unified server-action permission gate.
 *
 * Verifies live session + forced-password-change clearance, optional route access (`canSeeRoute`),
 * and table-level CRUD permission (`can(role, table, op)`). Unauthorized roles receive a clean
 * Turkish `DomainError("FORBIDDEN", ...)` with zero DB mutations instead of hitting PG 42501.
 */
export async function requireActionPermission(
  table: string,
  op: Action,
  routePrefix?: string,
): Promise<SessionUser> {
  return requireSession({ requiredPermission: { table, op }, routePrefix });
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
    await getRawPool().query(`update public.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
      tokenHash,
    ]);
  }
  jar.delete(SESSION_COOKIE);
  clearRequestSessionCache();
}

/**
 * The signed-in user changes their OWN password — the self-service half of the forced password
 * change (migration 0095), and the only way out of /change-password.
 */
export async function changeOwnPassword(
  user: SessionUser,
  oldPassword: string,
  newPassword: string,
): Promise<{ otherSessionsRevoked: number }> {
  if (newPassword.length > PASSWORD_MAX_LENGTH) throw new PasswordChangeError("too_long");
  if (!passwordSchema.safeParse(newPassword).success) throw new PasswordChangeError("too_short");
  if (newPassword.toLowerCase() === user.username.toLowerCase()) throw new PasswordChangeError("same_as_username");
  if (newPassword === oldPassword) throw new PasswordChangeError("same_as_old");

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new PasswordChangeError("session_ended");
  const currentTokenHash = createHash("sha256").update(token).digest("hex");

  const verdict = await attemptLogin(user.username, oldPassword);
  if (verdict.ok && verdict.userId !== user.id) throw new PasswordChangeError("session_ended");
  if (!verdict.ok) {
    const state = await getRawPool().query<{ locked: boolean; is_active: boolean }>(
      `select coalesce(locked_until > now(), false) as locked, is_active from public.users where id = $1`,
      [user.id],
    );
    const account = state.rows[0];
    if (!account || !account.is_active) throw new PasswordChangeError("session_ended");
    throw new PasswordChangeError(account.locked ? "locked" : "invalid_old");
  }

  const newHash = await hashPassword(newPassword);
  const client = await getRawPool().connect();
  let failure: Error | undefined;
  try {
    await client.query("begin");
    const res = await client.query<{
      username: string;
      display_name: string;
      role: string;
      is_active: boolean;
      must_change_password: boolean;
    }>(
      `select username, display_name, role, is_active, must_change_password
         from public.users where id = $1 for update`,
      [user.id],
    );
    const row = res.rowCount === 1 ? res.rows[0] : null;
    if (!row || !row.is_active) throw new PasswordChangeError("session_ended");
    const live = await client.query(
      `select 1 from public.sessions
        where token_hash = $1 and user_id = $2 and revoked_at is null and expires_at > now()`,
      [currentTokenHash, user.id],
    );
    if (live.rowCount !== 1) throw new PasswordChangeError("session_ended");
    if (!(APP_ROLES as readonly string[]).includes(row.role)) {
      throw new Error(`Tanınmayan kullanıcı katmanı: ${row.role}`);
    }
    const before = {
      username: row.username,
      display_name: row.display_name,
      role: row.role,
      is_active: row.is_active,
      must_change_password: row.must_change_password,
    };

    await client.query(
      `update public.users
          set password_hash = $2, must_change_password = false, failed_login_count = 0, locked_until = null
        where id = $1`,
      [user.id, newHash],
    );
    const revoked = await client.query(
      `update public.sessions set revoked_at = now()
        where user_id = $1 and token_hash <> $2 and revoked_at is null`,
      [user.id, currentTokenHash],
    );
    const otherSessionsRevoked = revoked.rowCount ?? 0;

    await client.query("select set_config('app.user_id', $1, true)", [user.id]);
    await client.query(`set local role ${DB_ROLE[row.role as AppRole]}`);
    await audit(client, {
      actor: user.id,
      action: "change_own_password",
      entityTable: "users",
      entityId: user.id,
      before,
      after: { ...before, password_changed: true, must_change_password: false, other_sessions_revoked: otherSessionsRevoked },
    });
    await client.query("commit");
    clearRequestSessionCache();
    return { otherSessionsRevoked };
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release(failure);
  }
}
