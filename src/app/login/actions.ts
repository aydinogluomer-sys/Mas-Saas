"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  attemptLogin,
  createSessionCookie,
  resolveLocalWorkstationAutoLoginUserId,
  revokeCurrentSession,
  safeRedirectPath,
} from "@/lib/auth";
import { completePasswordReset, requestPasswordReset } from "@/lib/auth/password-reset";
import { getRawPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
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

export async function localWorkstationAutoLoginAction(rawNext: string): Promise<void> {
  const next = safeRedirectPath(rawNext, "/");
  const userId = await resolveLocalWorkstationAutoLoginUserId();
  if (!userId) {
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  await createSessionCookie(userId);
  redirect(next);
}

const requestResetFormSchema = z.object({
  usernameOrEmail: z
    .string()
    .trim()
    .min(1, "Kullanıcı adı veya e-posta adresi giriniz.")
    .max(180, "Kullanıcı adı veya e-posta en fazla 180 karakter olabilir."),
});

const completeResetFormSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^[a-fA-F0-9]{64}$/, "Geçerli 64 karakterlik sıfırlama kodunu giriniz."),
    newPassword: z
      .string()
      .min(12, "Yeni parola en az 12 karakter olmalıdır.")
      .max(128, "Yeni parola en fazla 128 karakter olabilir."),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Yeni parola ve parola tekrarı eşleşmiyor.",
  });

export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const next = safeRedirectPath(String(formData.get("next") ?? ""), "/overview");
  const requestHeaders = await headers();
  const requestId = requestHeaders.get(CORRELATION_HEADER) ?? undefined;
  const ipKey = clientKey(requestHeaders);

  const limit = rateLimit(`pwd-reset-req:${ipKey}`, RATE_RULES.login);
  if (!limit.ok) {
    log.warn("password_reset_request_rate_limited", {
      requestId,
      retryAfterSec: limit.retryAfterSec,
    });
    redirect(`/login?mode=reset&reset=rate&next=${encodeURIComponent(next)}`);
  }

  const parsed = requestResetFormSchema.safeParse({
    usernameOrEmail: String(formData.get("usernameOrEmail") ?? ""),
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Geçersiz sıfırlama isteği.";
    redirect(
      `/login?mode=reset&resetError=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`,
    );
  }

  await requestPasswordReset(getRawPool(), parsed.data.usernameOrEmail, ipKey);
  redirect(`/login?mode=reset&reset=sent&next=${encodeURIComponent(next)}`);
}

export async function completePasswordResetAction(formData: FormData): Promise<void> {
  const next = safeRedirectPath(String(formData.get("next") ?? ""), "/overview");
  const requestHeaders = await headers();
  const requestId = requestHeaders.get(CORRELATION_HEADER) ?? undefined;
  const ipKey = clientKey(requestHeaders);

  const limit = rateLimit(`pwd-reset-complete:${ipKey}`, RATE_RULES.login);
  if (!limit.ok) {
    log.warn("password_reset_complete_rate_limited", {
      requestId,
      retryAfterSec: limit.retryAfterSec,
    });
    redirect(`/login?mode=reset&reset=rate&next=${encodeURIComponent(next)}`);
  }

  const parsed = completeResetFormSchema.safeParse({
    token: String(formData.get("token") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Geçersiz parola sıfırlama verisi.";
    redirect(
      `/login?mode=reset&resetError=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`,
    );
  }

  try {
    await completePasswordReset(
      getRawPool(),
      parsed.data.token,
      parsed.data.newPassword,
    );
  } catch (err) {
    if (err instanceof DomainError) {
      redirect(
        `/login?mode=reset&resetError=${encodeURIComponent(err.message)}&next=${encodeURIComponent(next)}`,
      );
    }
    throw err;
  }

  redirect(`/login?reset=completed&next=${encodeURIComponent(next)}`);
}
