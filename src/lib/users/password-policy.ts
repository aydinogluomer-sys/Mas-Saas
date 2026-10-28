// The password rules and the self-service change's error vocabulary, in one module that both
// account paths can import.
//
// WHY A MODULE OF ITS OWN. Two places set passwords: the admin-driven operations in
// ./engine.ts (create, reset) and the signed-in user's own change, which lives in @/lib/auth
// because it has to run on the identity connection (see changeOwnPassword there). ./engine.ts
// already imports @/lib/auth for hashPassword, so @/lib/auth importing ./engine.ts back would
// be a cycle. The shared rule therefore sits below both, and depends on nothing but zod.
//
// WHY CODES AND NOT MESSAGES IN THE URL. The change-password action reports a failure by
// redirecting to /change-password with `?error=<code>`, and the page renders the fixed Turkish
// text for a code it knows — nothing else. Before Wave 0 the action put the raw error message
// into the URL and the page printed whatever `?error=` held, so anyone could make the login
// screen of a finance tool display a sentence of their choosing. Same rule as the curated flash
// keys in src/components/ui/primitives/toast.tsx.
import { z } from "zod";
import { DomainError } from "@/lib/domain-error";

/** 12 is the same floor scripts/db/seed-admin.ts enforces — one rule, every entry point. */
export const PASSWORD_MIN_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Parola en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`);

export const PASSWORD_CHANGE_ERROR_CODES = [
  "mismatch",
  "too_short",
  "same_as_username",
  "same_as_old",
  "invalid_old",
  "locked",
  "session_ended",
] as const;
export type PasswordChangeErrorCode = (typeof PASSWORD_CHANGE_ERROR_CODES)[number];

/** The only texts /change-password ever shows for a failure. */
export const PASSWORD_CHANGE_MESSAGES: Record<PasswordChangeErrorCode, string> = {
  mismatch: "Yeni parolalar birbiriyle eşleşmiyor.",
  too_short: `Yeni parola en az ${PASSWORD_MIN_LENGTH} karakter olmalı.`,
  same_as_username: "Yeni parola kullanıcı adıyla aynı olamaz.",
  same_as_old: "Yeni parola mevcut parolayla aynı olamaz.",
  invalid_old: "Mevcut parola hatalı.",
  // Five wrong attempts lock the account exactly as five wrong logins do (attemptLogin is the
  // check in both places); the session that is already open stays open meanwhile.
  locked: "Çok sayıda hatalı deneme: hesap 15 dakikalığına kilitlendi. Süre dolunca yeniden deneyin.",
  session_ended: "Oturumunuz bu sırada sona erdi ya da kapatıldı; parola değiştirilmedi. Yeniden giriş yapın.",
};

/** The message for a `?error=` value, or null for anything that is not one of the codes above. */
export function passwordChangeMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return (PASSWORD_CHANGE_ERROR_CODES as readonly string[]).includes(code)
    ? PASSWORD_CHANGE_MESSAGES[code as PasswordChangeErrorCode]
    : null;
}

/**
 * An expected, user-facing failure of the self-service change. A DomainError, so every existing
 * "DomainError means show it, anything else means propagate" caller keeps working; the code is
 * what the action puts into the redirect.
 */
export class PasswordChangeError extends DomainError {
  constructor(readonly code: PasswordChangeErrorCode) {
    super(PASSWORD_CHANGE_MESSAGES[code]);
    this.name = "PasswordChangeError";
  }
}
