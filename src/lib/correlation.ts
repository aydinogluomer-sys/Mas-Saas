// Faz 16 — request correlation id.
//
// Edge-safe on purpose: src/middleware.ts imports this and runs in the Edge runtime, so
// nothing here may touch node: APIs, `pg`, or native bindings. `crypto.randomUUID()` exists
// in both the Edge runtime and Node, which is why it is used instead of node:crypto.
//
// The id travels three ways: middleware puts it on the *forwarded request* headers so server
// components and route handlers can read it, echoes it on the response so an operator can
// quote it from a browser's network tab, and every structured log line carries it.

/** Standard-ish name; also what most reverse proxies already set, which is why an inbound
 * value is reused rather than overwritten — a request keeps one id end to end. */
export const CORRELATION_HEADER = "x-request-id";

/** Accepts an inbound id only if it looks like one. An unvalidated header would otherwise
 * end up in log lines verbatim, letting a caller inject newlines and forge log entries. */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function readOrCreateCorrelationId(headers: Headers): string {
  const inbound = headers.get(CORRELATION_HEADER);
  if (inbound && SAFE_ID.test(inbound)) return inbound;
  return newCorrelationId();
}
