// Server-side Postgres pool. The one canonical database is the local PostgreSQL 16 service on
// this machine (docs/ops/postgres-service.md); no cloud deploy is planned, and Wave 0 removed the
// Supabase-only scripts and the cloud-latency connect timeout the unreviewed layer had added.
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
// because nothing switches it beyond a single transaction. One pool doing both jobs would make
// "is this connection currently a viewer?" a question the auth path had to ask. (The one raw-pool
// caller that does switch — changeOwnPassword in @/lib/auth, which writes its audit row under the
// user's own tier — uses SET LOCAL ROLE and a transaction-local app.user_id, both undone by
// COMMIT/ROLLBACK, and destroys the connection on any error instead of returning it.)
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { APP_ROLES, DB_ROLE, type AppRole } from "@/lib/authz/matrix";
import { env } from "@/lib/env";
import { countingClient, recordRequestQuery } from "@/lib/perf/request-metrics";
import { recordQuery } from "@/lib/perf/slow-query";

declare global {
  var __masPool: Pool | undefined;
  var __masRawPool: Pool | undefined;
  var __masPoolVersion: number | undefined;
}

const POOL_CONFIG_VERSION = 3;
if (global.__masPoolVersion !== POOL_CONFIG_VERSION) {
  global.__masPool = undefined;
  global.__masRawPool = undefined;
  global.__masPoolVersion = POOL_CONFIG_VERSION;
}

function createPool(): Pool {
  return new Pool({
    connectionString: env.databaseUrl,
    max: env.databasePoolMax,
    idleTimeoutMillis: 300_000,
    // Windows PostgreSQL spawns a child `postgres.exe` process via CreateProcess() per new
    // physical connection; when combined with Next.js Webpack compilation blocking the Node.js
    // event loop for 6–20s, a 5s timer expires in the Timers phase before the socket poll phase.
    connectionTimeoutMillis: 30_000,
    statement_timeout: env.databaseStatementTimeoutMs ?? 30_000,
    keepAlive: true,
  });
}

async function connectWithRetry(base: Pool): Promise<TaggedClient> {
  try {
    return (await base.connect()) as TaggedClient;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/connection timeout|terminated unexpectedly|ECONNRESET/i.test(msg)) {
      return (await base.connect()) as TaggedClient;
    }
    throw err;
  }
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

/** Marks which tier role and user id a physical connection is currently sitting in. */
const CURRENT_ROLE = Symbol.for("mas.currentDbRole");
const CURRENT_USER = Symbol.for("mas.currentUserId");
const CURRENT_ENTITY = Symbol.for("mas.currentLegalEntityId");
const CURRENT_TIMEOUT = Symbol.for("mas.currentStatementTimeoutMs");
type TaggedClient = PoolClient & {
  [CURRENT_ROLE]?: string | null;
  [CURRENT_USER]?: string | null;
  [CURRENT_ENTITY]?: string | null;
  [CURRENT_TIMEOUT]?: number | null;
};

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
 *
 * A failed `set role` / `reset role` THROWS, and the tag is only written after both statements
 * succeeded. Wave 0 restored this from af210fd: the unreviewed layer caught both failures "for a
 * pooler session", logged a warning and tagged the connection as switched anyway — so a request
 * whose switch failed ran in whatever role the connection last held (another user's tier, or the
 * bare runtime role) and every later checkout trusted the false tag. There is no pooler between
 * this app and its database (local PostgreSQL 16 is the only canonical one), and even if there
 * were, the answer to "the tier could not be established" is to refuse the request, never to
 * run it in an unknown one. getPool() additionally destroys a connection whose switch failed.
 */
async function applyRole(client: TaggedClient, dbRole: string | null): Promise<void> {
  const current = client[CURRENT_ROLE] ?? null;
  if (current === dbRole) return;
  if (dbRole === null) {
    await client.query("reset role");
    await client.query(
      "select set_config('app.user_id', '', false), set_config('app.current_legal_entity_id', '', false)",
    );
    if ((client[CURRENT_TIMEOUT] ?? null) !== null) {
      const defaultTimeout = env.databaseStatementTimeoutMs ?? 30_000;
      await client.query(`set statement_timeout = ${defaultTimeout}`);
      client[CURRENT_TIMEOUT] = null;
    }
    client[CURRENT_USER] = "";
    client[CURRENT_ENTITY] = "";
  } else {
    // dbRole never comes from user input — it is looked up from the five-entry DB_ROLE map in
    // @/lib/authz/matrix — but it is still an identifier being concatenated, so it is
    // validated against that map's shape before it reaches SQL.
    if (!/^mas_radar_[a-z_]+$/.test(dbRole)) throw new Error(`Geçersiz veritabanı rolü: ${dbRole}`);
    await client.query(`set role ${dbRole}`);
  }
  client[CURRENT_ROLE] = dbRole;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeOptionalEntityId(legalEntityId?: string | null): string | null {
  if (legalEntityId == null) return null;
  const trimmed = legalEntityId.trim();
  if (!trimmed || trimmed === "consolidated") return null;
  if (!USER_ID.test(trimmed)) {
    throw new Error("Geçersiz tüzel kişilik kimliği");
  }
  return trimmed;
}

function normalizeStatementTimeoutMs(ms?: number): number | null {
  if (ms == null) return null;
  if (!Number.isFinite(ms) || ms < 500) {
    throw new Error("Geçersiz statement_timeout değeri");
  }
  return Math.min(600_000, Math.round(ms));
}

export interface RunAsSystemOptions {
  legalEntityId?: string | null;
  statementTimeoutMs?: number;
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
const systemContext = new AsyncLocalStorage<{
  dbRole: string;
  userId: string | null;
  legalEntityId: string | null;
  statementTimeoutMs: number | null;
}>();

export function runAsSystem<T>(
  fn: () => Promise<T>,
  opts?: RunAsSystemOptions,
): Promise<T>;
export function runAsSystem<T>(
  actorId: string | null,
  fn: () => Promise<T>,
  opts?: RunAsSystemOptions,
): Promise<T>;
export function runAsSystem<T>(
  first: (() => Promise<T>) | string | null,
  second?: (() => Promise<T>) | RunAsSystemOptions,
  third?: RunAsSystemOptions,
): Promise<T> {
  const isFnFirst = typeof first === "function";
  const actorId = isFnFirst ? null : first;
  const fn = (isFnFirst ? first : second) as () => Promise<T>;
  const opts = (isFnFirst ? second : third) as RunAsSystemOptions | undefined;
  if (actorId !== null && !USER_ID.test(actorId)) {
    throw new Error("Geçersiz sistem aktör kimliği");
  }
  return systemContext.run(
    {
      dbRole: "mas_radar_finance_manager",
      userId: actorId,
      legalEntityId: normalizeOptionalEntityId(opts?.legalEntityId),
      statementTimeoutMs: normalizeStatementTimeoutMs(opts?.statementTimeoutMs),
    },
    fn,
  );
}

/**
 * The read-only machine identity: the viewer tier.
 *
 * For a caller with no person behind it that only ever READS. Viewer reads
 * the same invoice/party data every dashboard tier reads (0058 gives all five tiers SELECT on the
 * operational and reference tables, and the receivables views are granted like any table) and
 * writes nothing — "a viewer cannot write to ANY table" is the invariant db:roles-rls:verify
 * asserts in as many words (see the `personal` class note in @/lib/authz/matrix). So if a bug
 * or a crafted question ever steered this path toward a write, the database refuses it,
 * independently of the code that is supposed to never try. A future machine caller that
 * genuinely needs more is a decision to make explicitly, not a reason to borrow the job identity.
 *
 * The one viewer write that exists (migration 0096: an audit row for the viewer's OWN password
 * change, with actor and entity equal to current_app_user()) cannot fire here: this identity
 * carries no user id, current_app_user() is NULL, and the policy matches nothing.
 */
export function runAsReadOnlySystem<T>(
  fn: () => Promise<T>,
  opts?: { legalEntityId?: string | null },
): Promise<T> {
  return systemContext.run(
    {
      dbRole: "mas_radar_viewer",
      userId: null,
      legalEntityId: normalizeOptionalEntityId(opts?.legalEntityId),
      statementTimeoutMs: null,
    },
    fn,
  );
}

/**
 * A named person's tier, for work done ON THEIR BEHALF outside a request.
 *
 * Used by background workers acting on behalf of a specific user (e.g., Import V2 preview worker).
 * Using the user's own tier means the worker can see nothing that person could not, and `app.user_id`
 * names them for the row policies (plus optional `legalEntityId` for entity-scoped isolation)
 * exactly as their own request would.
 *
 * The identity MUST be the user's row in public.users, re-read by the caller at the moment of use
 * (active, not under a forced password change, permitted) — never an id or a role taken from a
 * request body or a job payload. The role is therefore typed, and still refused at runtime unless
 * it is one of the five tiers: this function hands it to SET ROLE.
 */
export function runAsUser<T>(
  user: { id: string; role: AppRole; legalEntityId?: string | null },
  fn: () => Promise<T>,
  legalEntityId?: string | null,
): Promise<T> {
  if (!(APP_ROLES as readonly string[]).includes(user.role)) {
    throw new Error(`Bilinmeyen kullanıcı katmanı: ${String(user.role)}`);
  }
  if (!USER_ID.test(user.id)) throw new Error("Geçersiz kullanıcı kimliği");
  const resolvedEntityId = normalizeOptionalEntityId(
    legalEntityId !== undefined ? legalEntityId : user.legalEntityId,
  );
  return systemContext.run(
    {
      dbRole: DB_ROLE[user.role],
      userId: user.id,
      legalEntityId: resolvedEntityId,
      statementTimeoutMs: null,
    },
    fn,
  );
}

async function contextFor(): Promise<{
  dbRole: string | null;
  userId: string | null;
  legalEntityId: string | null;
  statementTimeoutMs: number | null;
}> {
  const system = systemContext.getStore();
  if (system) return system;
  try {
    // Imported lazily to break the cycle: the context resolver reads the session, and reading
    // the session needs a pool from this module.
    const { getDbContext } = await import("@/lib/authz/context");
    const ctx = await getDbContext();
    return {
      dbRole: ctx.dbRole,
      userId: ctx.userId,
      legalEntityId: ctx.legalEntityId ?? null,
      statementTimeoutMs: null,
    };
  } catch {
    // No request context (a script, a background task) — no tier, and therefore no access to
    // business tables. Failing closed is the only safe reading of "I don't know who this is".
    return { dbRole: null, userId: null, legalEntityId: null, statementTimeoutMs: null };
  }
}

async function prepare(
  client: TaggedClient,
  forceUserConfig = true,
  resolvedCtx?: Awaited<ReturnType<typeof contextFor>>,
): Promise<void> {
  const { dbRole, userId, legalEntityId, statementTimeoutMs } = resolvedCtx ?? (await contextFor());
  const prevTimeout = client[CURRENT_TIMEOUT] ?? null;
  if (statementTimeoutMs !== prevTimeout) {
    const effectiveTimeout = statementTimeoutMs ?? (env.databaseStatementTimeoutMs ?? 30_000);
    await client.query(`set statement_timeout = ${effectiveTimeout}`);
    client[CURRENT_TIMEOUT] = statementTimeoutMs;
  }
  // Order matters: set the user id & active legal entity BEFORE switching role.
  if (dbRole !== null) {
    const targetUser = userId ?? "";
    const targetEntity = legalEntityId ?? "";
    if (
      forceUserConfig ||
      client[CURRENT_USER] !== targetUser ||
      client[CURRENT_ENTITY] !== targetEntity
    ) {
      await client.query(
        "select set_config('app.user_id', $1, false), set_config('app.current_legal_entity_id', $2, false)",
        [targetUser, targetEntity],
      );
      client[CURRENT_USER] = targetUser;
      client[CURRENT_ENTITY] = targetEntity;
    }
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
/**
 * Runs a batch of read queries on a SINGLE checked-out connection so `prepare()` (`set_config` +
 * `SET ROLE`) and pool checkout/release happen once instead of N times per page render.
 */
export async function withReadConnection<T>(
  pool: Pick<Pool, "connect">,
  fn: (db: Pool) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const inFlight = new Set<Promise<unknown>>();
  let queue: Promise<unknown> = Promise.resolve();
  const runQuery = (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    const exec = async (): Promise<QueryResult<QueryResultRow>> => {
      const startedAt = process.hrtime.bigint();
      try {
        // @ts-expect-error — pg's query() overloads are wider than this passthrough can express.
        return (await client.query(...args)) as QueryResult<QueryResultRow>;
      } finally {
        const text = typeof args[0] === "string"
          ? args[0]
          : (args[0] as { text?: string } | undefined)?.text;
        if (text) {
          recordQuery(text, Number(process.hrtime.bigint() - startedAt) / 1e6);
        }
      }
    };
    const next = queue.then(exec, exec);
    queue = next.then(() => undefined, () => undefined);
    const tracked = next.then(
      () => {
        inFlight.delete(tracked);
      },
      () => {
        inFlight.delete(tracked);
      },
    );
    inFlight.add(tracked);
    return next;
  };
  const pinned = new Proxy(client as unknown as Pool, {
    get(target, prop, receiver) {
      if (prop === "query") return runQuery;
      if (prop === "connect") {
        throw new Error("withReadConnection yalnızca salt-okunur query() çağrıları içindir; iç içe connect() açılamaz.");
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    return await fn(pinned);
  } finally {
    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    client.release();
  }
}

export function getPool(): Pool {
  if (!global.__masPool) {
    const base = createPool();

    const scopedQuery = async (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
      // Resolve request/role context BEFORE checking out a connection from `base`.
      // Otherwise N >= max concurrent `pool.query()` calls check out all pool clients first and
      // self-deadlock when `getDbContext()` needs a read-only entity membership query (`loadAssignedUserEntityIds`).
      const resolvedCtx = await contextFor();
      const client = await connectWithRetry(base);
      // Faz 33: the one choke point every pooled query already passes through, which is why the
      // slow-query timer lives here rather than at ~530 call sites. Only the DURATION and the
      // query SHAPE are recorded — never the parameters, which are financial values.
      const startedAt = process.hrtime.bigint();
      // Set only when prepare() failed. Such a connection's role and identity are unknown — the
      // statement that failed may or may not have taken effect — so it is DESTROYED (pg-pool
      // drops a client released with a truthy argument) rather than pooled for the next
      // request to inherit. A failure of the caller's own SQL leaves the connection reusable.
      let unusable: Error | undefined;
      try {
        try {
          await prepare(client, true, resolvedCtx);
        } catch (e) {
          unusable = e instanceof Error ? e : new Error(String(e));
          throw e;
        }
        // @ts-expect-error — pg's query() overloads are wider than this passthrough can express.
        return await client.query(...args);
      } finally {
        client.release(unusable);
        // In the finally block deliberately: a query that FAILED after ten seconds is exactly the
        // one worth seeing, and recording only successes would hide the worst cases.
        const text = typeof args[0] === "string"
          ? args[0]
          : (args[0] as { text?: string } | undefined)?.text;
        if (text) {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
          recordQuery(text, ms);
          // AŞAMA 10: aynı boğaz noktası, ikinci bir tüketici. recordQuery yalnız YAVAŞ
          // sorguları saklar (varsayılan eşik 200 ms) ve küreseldir; "bu rota kaç sorgu attı"
          // sorusu için ikisi de yetmez. recordRequestQuery açık bir ölçüm kapsamı yokken
          // ilk satırında çıkar — üretim yolunda tek bir getStore() maliyeti.
          recordRequestQuery(text, ms);
        }
      }
    };

    const scopedConnect = async (): Promise<PoolClient> => {
      const resolvedCtx = await contextFor();
      const client = await connectWithRetry(base);
      try {
        await prepare(client, true, resolvedCtx);
      } catch (e) {
        // Destroyed, not pooled — the same reasoning as scopedQuery above.
        client.release(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
      // AŞAMA 10: yazma yollarının tamamı buradan geçer (markInstancePaid, importBankStatement,
      // refreshRiskFlags… her biri kendi transaction'ını sürer) ve bu sorgular yukarıdaki
      // scopedQuery boğaz noktasını HİÇ görmez. Ölçüm kapsamı açık değilse countingClient
      // istemciyi olduğu gibi geri verir — sarmalayıcı bile kurulmaz. prepare() sarmalamadan
      // ÖNCE koştuğu için rol hazırlığı sorguları sayıma girmez; scopedQuery'de de girmiyor.
      return countingClient(client);
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
