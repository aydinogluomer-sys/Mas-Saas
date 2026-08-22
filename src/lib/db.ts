// Server-side Postgres pool. Local dev hits the validated PostgreSQL instance;
// future Supabase deploy only swaps DATABASE_URL (schema identical, same migrations).
// NOTE: import only from server components / route handlers / server actions / scripts.
//
// Since Faz 15 the connection string is the low-privilege `mas_radar_app` role and comes
// from @/lib/env, which requires it. The previous hardcoded DEFAULT_LOCAL fallback
// ("postgres://postgres:postgres@...") is gone on purpose: it would have let a missing
// DATABASE_URL silently reconnect the whole application as the superuser, bypassing every
// RLS policy — the exact failure this phase exists to remove.
//
// ── Faz 24B: two pools, because they are two different identities ──────────────────────
//
// After 0058 the business tables carry no policy for `mas_radar_app` itself — only for the
// five tier roles it can SET ROLE into. So a connection is useful only once it has been
// switched, and exactly two kinds of work exist:
//
//   getPool()     Everything that acts on behalf of a signed-in person. Every checkout is
//                 switched into that person's tier before their SQL runs, so the database
//                 enforces the matrix whether or not the calling code remembered to.
//   getRawPool()  The login and session lookups, which by definition happen BEFORE a tier is
//                 known. These stay unswitched and reach users/sessions through the
//                 `mas_radar_app`-targeted policies Faz 15 added for exactly this purpose.
//
// They are separate Pool instances rather than one pool used two ways, and that is the whole
// safety argument: a physical connection in the scoped pool may carry a leftover tier role
// between checkouts (deliberately — see below), and a connection in the raw pool never can,
// because nothing ever switches it. One pool doing both jobs would make "is this connection
// currently a viewer?" a question the auth path had to ask.
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "@/lib/env";

declare global {
  var __masPool: Pool | undefined;
  var __masRawPool: Pool | undefined;
}

function createPool(): Pool {
  return new Pool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * The unswitched pool. Auth only.
 *
 * Anything else using this would run as plain `mas_radar_app`, which after 0058 can read no
 * business table at all — so a misuse fails loudly and immediately rather than quietly
 * escalating. That is the intended failure direction.
 */
export function getRawPool(): Pool {
  if (!global.__masRawPool) global.__masRawPool = createPool();
  return global.__masRawPool;
}

/** Marks which tier role a physical connection is currently sitting in. */
const CURRENT_ROLE = Symbol.for("mas.currentDbRole");
type TaggedClient = PoolClient & { [CURRENT_ROLE]?: string | null };

/**
 * Bring a checked-out connection to the tier this request needs.
 *
 * The role is left in place after release rather than reset, and the tag records it, so a
 * request that reuses a connection already sitting in the right tier costs no extra round
 * trip. Correctness does not depend on that caching: every checkout passes through here, so a
 * connection is never USED in a role other than the one this function just established.
 *
 * When there is no tier (a background job, a code path outside a request), the connection is
 * actively reset to `mas_radar_app`, which can read nothing. Leaving a stale tier behind would
 * be the one way this scheme could hand out privileges nobody asked for.
 */
async function applyRole(client: TaggedClient, dbRole: string | null): Promise<void> {
  const current = client[CURRENT_ROLE] ?? null;
  if (current === dbRole) return;
  if (dbRole === null) {
    await client.query("reset role");
    await client.query("select set_config('app.user_id', '', false)");
  } else {
    // dbRole never comes from user input — it is looked up from the five-entry DB_ROLE map in
    // @/lib/authz/matrix — but it is still an identifier being concatenated, so it is
    // validated against that map's shape before it reaches SQL.
    if (!/^mas_radar_[a-z_]+$/.test(dbRole)) throw new Error(`Geçersiz veritabanı rolü: ${dbRole}`);
    await client.query(`set role ${dbRole}`);
  }
  client[CURRENT_ROLE] = dbRole;
}

/**
 * Explicit identity for server-side work that has no signed-in person behind it.
 *
 * Startup and maintenance jobs are a real category, not an edge case: `prepare-runtime.ts`
 * generates the payment window and writes an audit row before the first request ever arrives.
 * Under the tier model such a job has no session, so it resolves to "no tier" — and no tier can
 * write anything. Correct, and it took down `pnpm start` until this existed.
 *
 * The fix is an identity a job must ASK for, never one it inherits by accident. Jobs run as
 * `finance_manager`: enough to generate instances and record what they did, and deliberately not
 * `admin`, so a background task still cannot change settings, approval rules, or accounts.
 *
 * AsyncLocalStorage is safe here in a way it would not be inside a React render — a script is a
 * single async chain with no component boundaries for the store to fail to cross.
 */
const systemContext = new AsyncLocalStorage<{ dbRole: string; userId: string | null }>();

export function runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  return systemContext.run({ dbRole: "mas_radar_finance_manager", userId: null }, fn);
}

async function contextFor(): Promise<{ dbRole: string | null; userId: string | null }> {
  const system = systemContext.getStore();
  if (system) return system;
  try {
    // Imported lazily to break the cycle: the context resolver reads the session, and reading
    // the session needs a pool from this module.
    const { getDbContext } = await import("@/lib/authz/context");
    return await getDbContext();
  } catch {
    // No request context (a script, a background task) — no tier, and therefore no access to
    // business tables. Failing closed is the only safe reading of "I don't know who this is".
    return { dbRole: null, userId: null };
  }
}

async function prepare(client: TaggedClient): Promise<void> {
  const { dbRole, userId } = await contextFor();
  // Order matters: set the user id BEFORE switching role. `app.user_id` is what the row-level
  // policies read (approvals' maker-checker rule, users_self_read), and set_config must run
  // while the connection still has the privilege to run it.
  if (dbRole !== null) {
    await client.query("select set_config('app.user_id', $1, false)", [userId ?? ""]);
  }
  await applyRole(client, dbRole);
}

/**
 * The role-scoped pool the application uses everywhere.
 *
 * It is typed as `Pool` and intercepts only `query` and `connect`, so all ~530 existing call
 * sites and the ~187 functions that take a `Pool` parameter keep working untouched. That was
 * the deciding factor in putting the switch here rather than at the call sites: a phase that
 * had to edit 530 places to stay correct would be a phase that silently missed some.
 */
export function getPool(): Pool {
  if (!global.__masPool) {
    const base = createPool();

    const scopedQuery = async (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
      const client = (await base.connect()) as TaggedClient;
      try {
        await prepare(client);
        // @ts-expect-error — pg's query() overloads are wider than this passthrough can express.
        return await client.query(...args);
      } finally {
        client.release();
      }
    };

    const scopedConnect = async (): Promise<PoolClient> => {
      const client = (await base.connect()) as TaggedClient;
      try {
        await prepare(client);
      } catch (e) {
        client.release();
        throw e;
      }
      return client;
    };

    // Splitting one pool into two created a shutdown hazard, found by db:transitions:verify:
    // a script that called getPool().end() and then dropped its disposable database was refused,
    // because the RAW pool it never asked for was still holding a connection. From a caller's
    // point of view there is one database layer, so ending it ends all of it.
    const scopedEnd = async (): Promise<void> => {
      await base.end();
      const raw = global.__masRawPool;
      global.__masPool = undefined;
      global.__masRawPool = undefined;
      if (raw) await raw.end();
    };

    global.__masPool = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "query") return scopedQuery;
        if (prop === "connect") return scopedConnect;
        if (prop === "end") return scopedEnd;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return global.__masPool;
}
