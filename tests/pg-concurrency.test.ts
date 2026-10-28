import { describe, expect, it } from "vitest";
import { gather, isPool, type Queryable } from "../src/lib/pg-concurrency";

/**
 * P24B v2.2 — the Pool/PoolClient execution-semantics contract.
 *
 * v2.1's commit message claimed "parallel on a Pool, sequential on a PoolClient". That was true of
 * loadDataQualityCenter, but the TOP LEVEL of collectMetricSnapshots had been made unconditionally
 * sequential, so the Pool path lost its parallelism and nothing noticed — the claim was in prose,
 * not in a test.
 *
 * These assertions are about ORDERING, not timing: each fake load reports when it started and when
 * it finished, and overlap is derived from those events. A timing-threshold test would be flaky on
 * a loaded machine and would not actually prove concurrency.
 */

/** Minimal stand-ins. `isPool` distinguishes them by a counter only Pool exposes. */
const fakePool = (): Queryable => ({ totalCount: 0, query: async () => ({ rows: [] }) }) as unknown as Queryable;
const fakeClient = (): Queryable => ({ query: async () => ({ rows: [] }) }) as unknown as Queryable;

/**
 * Builds n tasks that record start/end order and block until released.
 *
 * `open` latches: once released, a task that starts LATER resolves immediately. Without the latch
 * the sequential case deadlocks — release() would only free the one gate that existed at that
 * moment, and tasks 2..n would never be reached.
 */
function tracked(n: number): { fns: Array<() => Promise<number>>; events: string[]; release: () => void } {
  const events: string[] = [];
  const gates: Array<() => void> = [];
  let open = false;
  const fns = Array.from({ length: n }, (_, i) => async () => {
    events.push(`start:${i}`);
    if (!open) await new Promise<void>((resolve) => gates.push(resolve));
    events.push(`end:${i}`);
    return i;
  });
  return { fns, events, release: () => { open = true; while (gates.length) gates.shift()!(); } };
}

describe("isPool", () => {
  it("Pool ile PoolClient'ı ayırt ediyor", () => {
    expect(isPool(fakePool())).toBe(true);
    expect(isPool(fakeClient())).toBe(false);
  });
});

describe("gather — Pool yolu PARALEL", () => {
  it("ikinci ve üçüncü iş, birincisi bitmeden başlıyor", async () => {
    const { fns, events, release } = tracked(3);
    const p = gather(fakePool(), fns);
    // Bir mikro-tur bekle: paralelse üçünün de BAŞLAMIŞ olması gerekir, hiçbiri bitmeden.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["start:0", "start:1", "start:2"]);
    release();
    await expect(p).resolves.toEqual([0, 1, 2]);
  });
});

describe("gather — PoolClient yolu SIRALI", () => {
  it("ikinci iş, birincisi bitmeden başlamıyor", async () => {
    const { fns, events, release } = tracked(3);
    const p = gather(fakeClient(), fns);
    await Promise.resolve();
    await Promise.resolve();
    // Sıralıysa yalnız ilki başlamış olabilir.
    expect(events).toEqual(["start:0"]);
    release();
    await p;
    // Her iş, bir sonraki başlamadan ÖNCE bitmiş olmalı.
    expect(events).toEqual(["start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
  });
});

describe("gather — iki yol AYNI sonucu veriyor", () => {
  it("Pool ve PoolClient sonuçları birebir eşit", async () => {
    const build = (): Array<() => Promise<unknown>> => [
      async () => ({ a: 1 }),
      async () => [2, 3],
      async () => "dort",
    ];
    const viaPool = await gather(fakePool(), build());
    const viaClient = await gather(fakeClient(), build());
    expect(viaPool).toEqual(viaClient);
    expect(viaPool).toEqual([{ a: 1 }, [2, 3], "dort"]);
  });

  it("tuple tipleri korunuyor (destructuring tek tip birleşimine düşmüyor)", async () => {
    const [obj, arr, str] = await gather(fakePool(), [
      async () => ({ a: 1 }),
      async () => [2, 3],
      async () => "dort",
    ]);
    expect(obj.a).toBe(1);
    expect(arr[0]).toBe(2);
    expect(str.toUpperCase()).toBe("DORT");
  });
});
