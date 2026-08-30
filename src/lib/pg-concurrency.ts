import type { Pool, PoolClient } from "pg";

/** Anything that can run a statement. A `Pool` hands out a connection per call; a `PoolClient` is one. */
export type Queryable = Pool | PoolClient;

/**
 * A `Pool` exposes counters a `PoolClient` does not. Checking for one is how this file tells the
 * two apart at runtime without asking callers to declare which they passed.
 */
export function isPool(db: Queryable): db is Pool {
  return "totalCount" in db;
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
