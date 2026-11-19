import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/** Anything that can run a statement. A `Pool` hands out a connection per call; a `PoolClient` is one. */
export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/**
 * A `Pool` exposes counters a `PoolClient` does not. Checking for one is how this file tells the
 * two apart at runtime without asking callers to declare which they passed.
 */
export function isPool(db: Queryable): db is Pool {
  return typeof db === "object" && db !== null && "totalCount" in db;
}

/**
 * Pins a multi-query read batch onto a single checked-out connection when `db` is a `Pool`,
 * avoiding N separate `set_config` / role-prep round-trips and Windows multi-process IPC contention
 * while remaining a transparent pass-through on an existing `PoolClient` or unit-test mock.
 */
export async function withPinnedRead<T>(
  db: Queryable,
  fn: (pinned: Pool) => Promise<T>,
): Promise<T> {
  if (!isPool(db) || typeof (db as Partial<Pool>).connect !== "function") {
    return fn(db as Pool);
  }
  const client = await db.connect();
  const inFlight = new Set<Promise<unknown>>();
  let queue: Promise<unknown> = Promise.resolve();
  const runQuery = (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    const exec = async (): Promise<QueryResult<QueryResultRow>> => {
      // @ts-expect-error — pg's query() overloads are wider than this passthrough can express.
      return (await client.query(...args)) as QueryResult<QueryResultRow>;
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
    has(target, prop) {
      if (prop === "totalCount") return false;
      return Reflect.has(target, prop);
    },
    get(target, prop, receiver) {
      if (prop === "query") return runQuery;
      if (prop === "totalCount") return undefined;
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

type Awaitables = readonly (() => Promise<unknown>)[];
type Results<T extends Awaitables> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * Run a fixed set of queries, in parallel on a Pool and sequentially on a PoolClient.
 *
 * WHY THE DISTINCTION IS NOT A MICRO-OPTIMISATION. `Promise.all` over a single PoolClient issues
 * concurrent queries on one connection: pg serialises them anyway, warns
 * ("Calling client.query() when the client is already executing a query is deprecated"), and will
 * remove the behaviour in pg@9. So on a client the parallel form buys nothing and breaks later.
 *
 * On a Pool it buys a great deal — loadDataQualityCenter fans out fourteen queries behind a
 * dashboard with a sub-100ms navigation budget, and making that sequential to satisfy a code path
 * used once by a cleanup script would be paying for the repair with the product's latency.
 *
 * Results keep their tuple types, so destructuring at the call site is unchanged either way.
 */
// `[...T]` rather than `T`: it forces TypeScript to infer a TUPLE instead of collapsing the
// argument to an array of a union, which is what keeps each destructured result its own type.
export async function gather<T extends Awaitables>(db: Queryable, fns: [...T]): Promise<Results<T>> {
  if (isPool(db)) return (await Promise.all(fns.map((f) => f()))) as Results<T>;
  const out: unknown[] = [];
  for (const f of fns) out.push(await f());
  return out as Results<T>;
}
