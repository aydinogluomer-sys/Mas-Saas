"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { attemptLogin, createSessionCookie, revokeCurrentSession, safeRedirectPath } from "@/lib/auth";
import { RATE_RULES, clientKey, rateLimit } from "@/lib/rate-limit";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { log } from "@/lib/logger";

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeRedirectPath(String(formData.get("next") ?? ""), "/overview");

  // Faz 16 — throttle before the password is ever checked. attemptLogin deliberately runs a
  // fixed-cost argon2 verify on every call (including unknown usernames) to avoid a timing
  // oracle; that same property makes an unthrottled login endpoint an easy way to burn CPU.
  // The per-account lockout in public.users stays as the second layer — this one is per
  // client and catches spraying across many usernames, which a per-account counter cannot.
  //
  // A server action has no status-code channel, so the refusal is surfaced as a redirect with
  // a distinct error key rather than a 429. The JSON surface (src/app/api/facts/route.ts)
  // returns a real 429; both share src/lib/rate-limit.ts.
  const requestHeaders = await headers();
  const requestId = requestHeaders.get(CORRELATION_HEADER) ?? undefined;
  const limit = rateLimit(`login:${clientKey(requestHeaders)}`, RATE_RULES.login);
  if (!limit.ok) {
    // The username is NOT logged: a failed-login log that records attempted usernames becomes
    // a list of guesses — and, when someone mistypes their password into the username box, a
    // plaintext password sitting in the log.
    log.warn("login_rate_limited", { requestId, retryAfterSec: limit.retryAfterSec });
    redirect(`/login?error=rate&next=${encodeURIComponent(next)}`);
  }

  const result = await attemptLogin(username, password);
  if (!result.ok || !result.userId) {
    // Same generic message regardless of unknown-username, wrong-password, or
    // locked-account — no case reveals whether the username exists.
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  await createSessionCookie(result.userId);
  if (result.mustChangePassword) {
    redirect("/change-password");
  }
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  await revokeCurrentSession();
  redirect("/login");
}
