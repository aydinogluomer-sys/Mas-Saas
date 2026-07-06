// Minimal single-operator access gate for local private deployment.
// NOT multi-user SaaS auth. When APP_ACCESS_PASSWORD is set, dashboard routes require a
// cookie session whose value is a deterministic HMAC of the password (server-only). When
// the var is unset, the gate is OFF (trust the single machine). The password is never
// sent to the client and never logged. (node:crypto + next/headers keep this server-only.)
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "mas_session";
const SIGNING_CONTEXT = "mas-nakit-radar/access-gate/v1";

export function accessGateEnabled(): boolean {
  const p = process.env.APP_ACCESS_PASSWORD;
  return p != null && p !== "";
}

/** Deterministic session token derived from the password. Requires the password to forge. */
export function sessionToken(password: string): string {
  return createHmac("sha256", password).update(SIGNING_CONTEXT).digest("hex");
}

export function passwordMatches(candidate: string): boolean {
  const secret = process.env.APP_ACCESS_PASSWORD ?? "";
  if (secret === "") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the gate is off, or a valid session cookie is present. */
export async function hasValidSession(): Promise<boolean> {
  if (!accessGateEnabled()) return true;
  const val = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const expected = sessionToken(process.env.APP_ACCESS_PASSWORD ?? "");
  if (val.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(val), Buffer.from(expected));
}
