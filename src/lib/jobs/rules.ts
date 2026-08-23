// Faz 33 — background job rules. Pure: no database, no clock reads beyond what is passed in,
// no LLM. Everything here is a decision that must be reproducible from its inputs, because a
// queue whose retry behaviour cannot be predicted is a queue nobody can debug at 3am.

export const JOB_TYPES = [
  "excel_import",
  "bank_statement_import",
  "report_generation",
  "large_export",
  "read_model_refresh",
  // Faz 37 — integration syncs. Added HERE as well as in the DB CHECK (0086): widening only one
  // side is the Faz 29 drift, and it surfaced exactly that way — enqueueJob() rejected a job type
  // the database would have accepted. phase37:verify now compares the two lists.
  "bank_api_sync",
  "einvoice_sync",
  "fx_rate_sync",
  "accounting_sync",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "queued", "running", "succeeded", "failed", "dead_letter", "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The allowed status moves — MIRRORED from migration 0081's guard, deliberately as data.
 *
 * Faz 29's lesson: a Zod schema and a database CHECK that describe the same set drift silently,
 * because nothing compares them. phase33:verify reads the trigger function's source out of the
 * catalog and asserts this list and that list are the same set — so adding a move in SQL without
 * adding it here (or the reverse) fails the gate instead of failing in production.
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
  ["queued", "running"],
  ["queued", "cancelled"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "dead_letter"],
  ["running", "queued"],
  ["failed", "queued"],
  ["failed", "dead_letter"],
  ["dead_letter", "queued"],
];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> =
  new Set<JobStatus>(["succeeded", "cancelled"]);

/** Statuses that mean "this row is still live" — matches 0081's partial unique index. */
export const LIVE_STATUSES: ReadonlySet<JobStatus> =
  new Set<JobStatus>(["queued", "running", "failed"]);

export const BACKOFF_BASE_SECONDS = 30;
export const BACKOFF_CAP_SECONDS = 3600;

/**
 * Exponential backoff with a cap.
 *
 * Capped on purpose: uncapped doubling reaches days by attempt 15, and a job that will retry
 * "sometime next Thursday" is indistinguishable from a job that is stuck. The cap makes the worst
 * case an hour, which is long enough to let a broken dependency recover and short enough that a
 * human watching the queue sees movement.
 *
 * No jitter: this is a single-company internal system with one worker. Jitter exists to spread a
 * thundering herd across many workers, and adding it here would only make the retry time
 * unpredictable — which is the property this function exists to provide.
 */
export function backoffSeconds(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return BACKOFF_BASE_SECONDS;
  const raw = BACKOFF_BASE_SECONDS * Math.pow(2, Math.min(attempt, 20) - 1);
  return Math.min(raw, BACKOFF_CAP_SECONDS);
}

/**
 * What happens after a failure: retry, or give up and dead-letter.
 *
 * `permanent` exists because some failures cannot be fixed by trying again — a malformed
 * workbook will be just as malformed in 30 seconds. Burning five attempts on it delays every
 * other job in the queue and buries the real error under four identical copies.
 */
export function nextAfterFailure(
  attempts: number, maxAttempts: number, permanent = false,
): { status: Extract<JobStatus, "failed" | "dead_letter">; retryInSeconds: number | null } {
  if (permanent || attempts >= maxAttempts) {
    return { status: "dead_letter", retryInSeconds: null };
  }
  return { status: "failed", retryInSeconds: backoffSeconds(attempts) };
}

/**
 * Progress as a percentage, or null when the total is unknown.
 *
 * Returns NULL rather than 0 when `total` is null — the CLAUDE.md rule applied to a progress bar.
 * "0%" tells a user the work has not started; "unknown" tells them the work has not been counted,
 * and those are different facts. A job reading 0% for ten minutes gets reported as broken.
 */
export function progressPercent(done: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  const pct = (done / total) * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/** A queue is unhealthy if work is waiting far longer than it takes to run. */
export function queueVerdict(
  oldestQueuedAgeSeconds: number | null, deadLetterCount: number,
): { tone: "pos" | "warn" | "neg"; label: string } {
  if (deadLetterCount > 0) {
    return { tone: "neg", label: `${deadLetterCount} iş ölü mektup kuyruğunda` };
  }
  if (oldestQueuedAgeSeconds == null) return { tone: "pos", label: "Bekleyen iş yok" };
  if (oldestQueuedAgeSeconds > 3600) {
    return { tone: "neg", label: "Bir saatten uzun süredir bekleyen iş var" };
  }
  if (oldestQueuedAgeSeconds > 300) {
    return { tone: "warn", label: "Beş dakikadan uzun süredir bekleyen iş var" };
  }
  return { tone: "pos", label: "Kuyruk akıyor" };
}
