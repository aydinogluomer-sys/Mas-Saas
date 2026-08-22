// Faz 18 — the Zod boundary.
//
// THE RULE, from this phase onward: every server action and route handler that accepts input
// from outside the process parses it through a schema declared for that action, and does it
// with `parseOrThrow`. Not `String(formData.get("x") ?? "")`, not a hand-rolled `Number()`
// guard — a schema, one per action, next to the action.
//
// This is a rule for NEW code. The existing actions were deliberately not retrofitted in this
// phase (see docs/status-notes.md): rewriting every form parse while also consolidating
// thirteen audit helpers would have made both changes unreviewable. The helper exists now so
// that the next thing written has somewhere correct to go.
//
// WHY NOT JUST `schema.parse(value)`. Zod v4's `ZodError.message` is a JSON dump of the raw
// issue array — measured:
//
//   [ { "origin": "string", "code": "invalid_format", "format": "uuid", "path": ["id"], ... } ]
//
// That string is developer diagnostics, not a sentence for a finance operator. It matters
// more than it looks: since Faz 16, `src/lib/api-response.ts` maps DomainError straight to a
// 400 WITH ITS MESSAGE PASSED THROUGH (everything else becomes a generic 500), because a
// DomainError is by definition something the user is allowed to read. So interpolating a raw
// ZodError message into a DomainError publishes internal validation structure to the client.
// `parseOrThrow` is the one place that turns issues into a readable Turkish sentence.

import type { z } from "zod";
import { DomainError } from "@/lib/domain-error";

/**
 * Render Zod issues as one operator-readable line.
 *
 * The field path is kept because "tutar: ..." is far more useful than a bare complaint, but
 * nothing else from the issue object is exposed — no codes, no origins, no expected/received
 * internals.
 */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Parse or throw a DomainError carrying a message the user is allowed to see.
 *
 * DomainError rather than a bare Error on purpose: invalid input is an EXPECTED failure the
 * caller should show back to the operator, which is exactly the distinction
 * `src/lib/domain-error.ts` exists to draw. A thrown plain Error would be treated as an
 * unexpected system fault and collapse into "beklenmeyen bir hata" — technically safe, but it
 * would hide "vade tarihi zorunlu" behind a generic apology.
 *
 * @param label Short Turkish noun phrase naming what was being parsed, e.g. "Çek formu".
 *              It prefixes the message so an operator knows which form failed.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  value: unknown,
  label = "Girdi",
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError(`${label} geçersiz — ${formatIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Non-throwing variant, for callers that want to render field errors inline instead of
 * redirecting with a single flash message.
 */
export function parseOrIssues<S extends z.ZodType>(
  schema: S,
  value: unknown,
): { ok: true; data: z.output<S> } | { ok: false; message: string } {
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, message: formatIssues(result.error) };
}

/**
 * FormData as a plain object, ready for a schema.
 *
 * Repeated keys collapse to an array so a multi-select does not silently lose every value but
 * the last — the default `Object.fromEntries(formData)` behaviour, and a real trap.
 *
 * File entries are dropped: this helper feeds schemas that describe scalar form fields, and
 * an upload belongs to the route that streams it, not to a validation object. Empty strings
 * are preserved rather than coerced to undefined, because "the operator cleared this field"
 * and "the field was not submitted" are different statements — schemas that want to treat
 * them alike can say so explicitly.
 */
export function formObject(formData: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}
