// AŞAMA 10 & Faz 40 (A2) — request-scoped DB query accounting.

import { AsyncLocalStorage } from "node:async_hooks";
import { fingerprint, recordQuery } from "./slow-query";

interface Sink {
  queryCount: number;
  totalDbTimeMs: number;
  slowestQueryShape: string | null;
  slowestQueryMs: number;
}

export interface RequestQueryMetrics {
  queryCount: number;
  totalDbTimeMs: number;
  slowestQueryShape: string | null;
  slowestQueryMs: number;
}

function newSink(): Sink {
  return { queryCount: 0, totalDbTimeMs: 0, slowestQueryShape: null, slowestQueryMs: -1 };
}

function snapshot(sink: Sink): RequestQueryMetrics {
  return {
    queryCount: sink.queryCount,
    totalDbTimeMs: Number(sink.totalDbTimeMs.toFixed(3)),
    slowestQueryShape: sink.slowestQueryShape,
    slowestQueryMs: sink.slowestQueryMs < 0 ? 0 : Number(sink.slowestQueryMs.toFixed(3)),
  };
}

const scope = new AsyncLocalStorage<Sink>();
const suppressed = new AsyncLocalStorage<boolean>();

let probeSink: Sink | undefined;

function activeSink(): Sink | undefined {
  if (suppressed.getStore() === true) return undefined;
  return scope.getStore() ?? probeSink;
}

/**
 * Faz 40 (A2): Run probe-internal session verification without adding +1 auth query to the
 * measured route's probe window.
 */
export function withoutProbeCounting<T>(fn: () => Promise<T>): Promise<T> {
  return suppressed.run(true, fn);
}

export function recordRequestQuery(sql: string, ms: number): void {
  const sink = activeSink();
  if (sink === undefined) return;
  try {
    if (!Number.isFinite(ms) || ms < 0) return;
    sink.queryCount += 1;
    sink.totalDbTimeMs += ms;
    if (ms > sink.slowestQueryMs) {
      sink.slowestQueryMs = ms;
      sink.slowestQueryShape = fingerprint(sql);
    }
  } catch {
    /* observation must never break the observed request */
  }
}

export async function measureRequestQueries<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; metrics: RequestQueryMetrics }> {
  const sink = newSink();
  const value = await scope.run(sink, fn);
  return { value, metrics: snapshot(sink) };
}

/* ── HTTP probe surface ────────────────────────────────────────────────────────────────── */

export function armProbe(): void {
  if (probeSink === undefined) probeSink = newSink();
}

export function isProbeArmed(): boolean {
  return probeSink !== undefined;
}

export function readAndResetProbe(): RequestQueryMetrics {
  const current = probeSink ?? newSink();
  probeSink = newSink();
  return snapshot(current);
}

export function disarmProbe(): void {
  probeSink = undefined;
}

/* ── pool.connect() client wrapper ────────────────────────────────────────────────────── */

type AnyArgs = unknown[];
interface QueryableClient {
  query: (...args: never[]) => unknown;
}

export function sqlTextOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg !== null && typeof arg === "object") {
    const text = (arg as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

const COUNTING_CLIENT_SYM = Symbol.for("mas.countingClient");

export function countingClient<T extends QueryableClient>(client: T): T {
  if ((client as Record<symbol, unknown>)[COUNTING_CLIENT_SYM] === true) return client;

  const original = client.query.bind(client) as (...args: AnyArgs) => unknown;
  const wrapped = (...args: AnyArgs): unknown => {
    const startedAt = process.hrtime.bigint();
    const finish = (): void => {
      const text = sqlTextOf(args[0]);
      if (text) {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        recordQuery(text, ms);
        recordRequestQuery(text, ms);
      }
    };
    let out: unknown;
    try {
      out = original(...args);
    } catch (e) {
      finish();
      throw e;
    }
    if (out !== null && typeof out === "object" && typeof (out as PromiseLike<unknown>).then === "function") {
      void (out as Promise<unknown>).then(finish, finish);
    } else {
      finish();
    }
    return out;
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === COUNTING_CLIENT_SYM) return true;
      if (prop === "query") return wrapped;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
