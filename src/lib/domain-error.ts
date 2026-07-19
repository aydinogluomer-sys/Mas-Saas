/** Thrown for expected, user-facing failures (not-found, invalid source status for a
 * transition). Distinguishes these from unexpected system/DB errors so callers can convert
 * only DomainError into a safe redirect message and let everything else propagate. */
export class DomainError extends Error {}
