// Real multi-user auth (P0-A). Replaces the old single-shared-password HMAC gate with
// named accounts, admin/operator roles, and DB-backed sessions (random opaque token,
// hashed server-side — never a recomputed HMAC, never stored in plaintext).
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { getRawPool } from "@/lib/db";
import { audit } from "@/lib/audit";
import { APP_ROLES, DB_ROLE, type AppRole } from "@/lib/authz/matrix";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/auth-constants";
import { PasswordChangeError, passwordSchema } from "@/lib/users/password-policy";

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
  // Deliberately the RAW pool: this lookup is what DECIDES the tier, so it cannot already be
  // running inside one. It reaches users/sessions through the mas_radar_app-targeted policies
  // Faz 15 added, which exist for precisely this moment in the request.
  //
  // And deliberately UNCACHED. The unreviewed layer put a 30-second, process-wide cache in front
  // of this query; Wave 0 removed it. Revocation, deactivation, a role change and a forced
  // password change must take effect on the very next request, and a per-process cache keyed by
  // token hash was cleared only by the user's own logout — not by the user-management engine
  // (which never knew the key) and not by scripts in another process (rotate-passwords, a
  // session revocation run by hand). Per-request deduplication already exists one level up:
  // getDbContext() in @/lib/authz/context is wrapped in React cache(), so the tier lookup behind
  // a page's pooled queries still runs once per render, not once per query.
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

  // Faz 16 — idle window, IN ADDITION TO the 7-day absolute expiry above (which stays as the
  // hard ceiling). A laptop left open on a finance dashboard is the realistic threat here,
  // and an absolute-only lifetime does nothing about it.
  //
  // `created_at` is the fallback because last_seen_at is NULL until the first bump: a
  // brand-new session would otherwise measure its idle time from epoch and be killed on the
  // very next request.
  const referenceMs = new Date(row.last_seen_at ?? row.created_at).getTime();
  if (Date.now() - referenceMs > IDLE_TIMEOUT_MS) {
    // Revoked, not merely ignored — the token must stop working everywhere, not just here.
    await pool.query(`update public.sessions set revoked_at = now() where id = $1 and revoked_at is null`, [
      row.session_id,
    ]);
    return null;
  }

  // Throttled — only bump if stale by more than 5 minutes, not on every single request.
  // Awaited, as before the layer made it fire-and-forget: the idle window above is measured from
  // this column, so a bump that silently failed would quietly log an active user out.
  const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (Date.now() - lastSeenMs > 5 * 60_000) {
    await pool.query(`update public.sessions set last_seen_at = now() where id = $1`, [row.session_id]);
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: !!row.must_change_password,
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
export async function requireApiSession(): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) return null;
  return user;
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
    await getRawPool().query(`update public.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [
      tokenHash,
    ]);
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * The signed-in user changes their OWN password — the self-service half of the forced password
 * change (migration 0095), and the only way out of /change-password.
 *
 * WHY HERE, ON THE RAW POOL. Writing public.users is something only two identities may do: the
 * admin tier (users_admin_write, 0058) and the unswitched runtime role (users_app_runtime, 0035),
 * which is what attemptLogin() above already uses to keep the failed-login counter. The unreviewed
 * layer ran this change through getPool(), i.e. in the caller's own tier, so for viewer, operator,
 * approver and manager the `select … for update` found no row and every one of those users stayed
 * locked in at /change-password — the accounts the forced change exists for (createUser and
 * resetUserPassword force it by default). The change is therefore the identity layer's job, like
 * login and logout, and it touches exactly one row: the session user's own, by id.
 *
 * THE AUDIT ROW, UNDER THE USER'S OWN TIER. Through the one audit writer (@/lib/audit), in the
 * same transaction as the change, after `set local role <tier>` with `app.user_id` set to the
 * user — so the row is judged by the same RLS the person's own requests are, not slipped in by
 * the runtime role (which has no audit_logs policy at all). Four tiers record evidence anyway
 * (0058); migration 0096 gives the viewer tier exactly one INSERT path, limited to this action, on
 * its own row, with actor = current_app_user(). Both settings are transaction-local, so the
 * connection goes back to the pool as plain mas_radar_app after COMMIT — and on ANY error it is
 * destroyed rather than returned, so a raw-pool connection never carries a tier into the next
 * login check.
 *
 * ORDER, AND WHY. The rules first (a reused or short password costs no failed attempt and locks
 * no row); then the old password through attemptLogin() — constant-time, and five wrong answers
 * lock the account exactly like five wrong logins, so this form is not a brute-force side door;
 * then one transaction: lock the user row, confirm THIS session is still live (an admin reset or
 * deactivation that landed in between revoked it, and a stale form must not overwrite that
 * password), read the audit "before" BEFORE the update (the layer read it afterwards and recorded
 * the new state as the old one), update, revoke every OTHER session, audit, commit.
 *
 * The current session survives on purpose: the user just proved the old password in it.
 * getCurrentUser() reads must_change_password live, so the next request is no longer redirected.
 */
export async function changeOwnPassword(
  user: SessionUser,
  oldPassword: string,
  newPassword: string,
): Promise<{ otherSessionsRevoked: number }> {
  if (!passwordSchema.safeParse(newPassword).success) throw new PasswordChangeError("too_short");
  if (newPassword.toLowerCase() === user.username.toLowerCase()) throw new PasswordChangeError("same_as_username");
  if (newPassword === oldPassword) throw new PasswordChangeError("same_as_old");

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new PasswordChangeError("session_ended");
  const currentTokenHash = createHash("sha256").update(token).digest("hex");

  const verdict = await attemptLogin(user.username, oldPassword);
  if (verdict.ok && verdict.userId !== user.id) throw new PasswordChangeError("session_ended");
  if (!verdict.ok) {
    // attemptLogin answers every failure alike, so that a login form cannot tell an unknown name
    // from a locked or deactivated account. This caller is already signed in as the account, so
    // naming the real reason reveals nothing new and tells them what actually helps: a locked
    // account waits, and a deactivated one (an admin acted while this form was open, which also
    // revoked its sessions) is told its session is over. "Wrong password" is true of neither, and
    // would only invite more attempts.
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
    // The role decides which tier writes the audit row; a value outside the five is a broken row,
    // not a user mistake, and is never handed to SET ROLE.
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

    // Same order as @/lib/db's prepare(): the user id first, then the role. SET LOCAL lasts until
    // COMMIT, so anything deferred to COMMIT runs in the tier too. On public.users that is only
    // users_require_active_admin (0031), which reads every admin row and would see none under a
    // non-admin tier — but it fires on updates OF role or is_active, and the update above writes
    // neither. Keep it that way, or move the deferred work before the switch.
    await client.query("select set_config('app.user_id', $1, true)", [user.id]);
    await client.query(`set local role ${DB_ROLE[row.role as AppRole]}`);
    // Never the password, never the hash — only that it changed, and what that did.
    await audit(client, {
      actor: user.id,
      action: "change_own_password",
      entityTable: "users",
      entityId: user.id,
      before,
      after: { ...before, password_changed: true, must_change_password: false, other_sessions_revoked: otherSessionsRevoked },
    });
    await client.query("commit");
    return { otherSessionsRevoked };
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
    // The connection is destroyed in `finally` whatever happens here, and closing it ends the
    // transaction server-side; a failed ROLLBACK must not replace the error that explains why.
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release(failure);
  }
}
