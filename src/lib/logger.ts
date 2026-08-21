// Faz 16 — structured (JSON-lines) server logging.
//
// Scope is deliberately narrow: this does NOT replace the existing console.log/console.error
// calls scattered through the scripts and engines. Rewriting all of them would be a large,
// risky diff with no functional gain, and the verify scripts parse some of that output.
// Only code added from Faz 16 onwards logs through here, so the structured stream grows as
// the app does instead of arriving in one unreviewable sweep.
//
// One line per event, so `grep`/`jq` work and a future log shipper needs no parser:
//   {"ts":"…","level":"error","msg":"unhandled_route_error","requestId":"…","route":"/api/facts"}
//
// SERVER ONLY. Never log secrets, connection strings, tokens, passwords or financial row
// contents — the same rule src/lib/users/engine.ts follows for audit payloads.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** Correlation id, when the call site has one (see src/lib/correlation.ts). */
  requestId?: string;
  [key: string]: unknown;
}

/** Errors do not survive JSON.stringify (name/message/stack are non-enumerable), so they are
 * projected explicitly. The stack stays server-side: callers must never put this in a
 * response body — src/lib/api-response.ts is what enforces that boundary. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "NonError", message: String(err) };
}

function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
  const { error, ...rest } = fields;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...rest,
  };
  if (error !== undefined) line.error = serializeError(error);

  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    // A circular value in `fields` must never take down the request that was being logged.
    text = JSON.stringify({ ts: line.ts, level, msg, logError: "alanlar serialize edilemedi" });
  }
  // stderr for warn/error so ordinary output and problems can be routed separately.
  if (level === "error" || level === "warn") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
};
