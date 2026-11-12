export type DomainErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "VALIDATION_ERROR"
  | "PASSWORD_CHANGE_REQUIRED";

const DOMAIN_ERROR_CODES = new Set<string>([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION",
  "VALIDATION_ERROR",
  "PASSWORD_CHANGE_REQUIRED",
]);

/** Thrown for expected, user-facing failures (not-found, forbidden, conflict, invalid source
 * status for a transition). Distinguishes these from unexpected system/DB errors so callers can
 * convert only DomainError into a safe message and let everything else propagate. */
export class DomainError extends Error {
  readonly code?: string;

  constructor(message: string);
  constructor(code: DomainErrorCode, message: string);
  constructor(codeOrMessage: string, maybeMessage?: string) {
    if (maybeMessage !== undefined && DOMAIN_ERROR_CODES.has(codeOrMessage)) {
      super(maybeMessage);
      this.code = codeOrMessage;
    } else {
      super(codeOrMessage);
    }
    this.name = "DomainError";
  }
}
