// Faz 33 — the queue engine. Owns claiming, retrying, dead-lettering and progress.
//
// The engine deliberately does NOT execute jobs. It hands a claimed job to a caller and records
// what the caller reports back. Putting execution here would mean this module imports every
// importer, exporter and report generator in the system, and a queue that depends on all its
// payloads is a queue that cannot be tested without them.
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import {
  JOB_TYPES, backoffSeconds, nextAfterFailure, progressPercent,
  type JobStatus, type JobType,
} from "./rules";

/** Zod at the boundary — payloads arrive from forms and route handlers, never trusted raw. */
export const enqueueSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(1).max(1000).default(100),
  dedupeKey: z.string().trim().min(1).max(200).optional(),
  maxAttempts: z.number().int().min(1).max(50).default(5),
});
export type EnqueueInput = z.infer<typeof enqueueSchema>;

export interface JobRow {
  id: string;
  jobType: JobType;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  progressDone: number;
  progressTotal: number | null;
  progressPercent: number | null;
  lastError: string | null;
  deadLetterReason: string | null;
  createdAt: string;
  nextRunAt: string;
}

const mapJob = (x: Record<string, unknown>): JobRow => ({
  id: x.id as string,
  jobType: x.job_type as JobType,
  status: x.status as JobStatus,
  priority: Number(x.priority),
  attempts: Number(x.attempts),
  maxAttempts: Number(x.max_attempts),
  payload: (x.payload ?? {}) as Record<string, unknown>,
  progressDone: Number(x.progress_done),
  progressTotal: x.progress_total == null ? null : Number(x.progress_total),
  progressPercent: progressPercent(
    Number(x.progress_done), x.progress_total == null ? null : Number(x.progress_total)),
  lastError: (x.last_error as string | null) ?? null,
  deadLetterReason: (x.dead_letter_reason as string | null) ?? null,
  createdAt: String(x.created_at),
  nextRunAt: String(x.next_run_at),
});

const COLS = `id, job_type, status, priority, attempts, max_attempts, payload,
              progress_done, progress_total, last_error, dead_letter_reason,
              created_at, next_run_at`;

/**
 * Enqueue one job.
 *
 * `dedupeKey` collisions are NOT an error: re-submitting the same import returns the job that is
 * already queued. Throwing would make the caller decide whether a duplicate submit is a failure,
 * and every caller would decide differently.
 */
export async function enqueueJob(
  pool: Pool, raw: unknown, actorId: string | null,
): Promise<{ job: JobRow; created: boolean }> {
  const input = enqueueSchema.parse(raw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (input.dedupeKey) {
      const existing = await client.query(
        `select ${COLS} from public.background_jobs
         where dedupe_key = $1 and status in ('queued','running','failed') limit 1`,
        [input.dedupeKey]);
      if (existing.rowCount) {
        await client.query("commit");
        return { job: mapJob(existing.rows[0]), created: false };
      }
    }
    const res = await client.query(
      `insert into public.background_jobs
         (job_type, payload, priority, dedupe_key, max_attempts, created_by)
       values ($1, $2::jsonb, $3, $4, $5, $6)
       returning ${COLS}`,
      [input.jobType, JSON.stringify(input.payload), input.priority,
       input.dedupeKey ?? null, input.maxAttempts, actorId]);
    const job = mapJob(res.rows[0]);
    await audit(client, {
      actor: actorId, action: "enqueue_job",
      entityTable: "background_jobs", entityId: job.id,
      after: { jobType: job.jobType, priority: job.priority, dedupeKey: input.dedupeKey ?? null },
    });
    await client.query("commit");
    return { job, created: true };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Claim the next eligible job.
 *
 * `for update skip locked` is the whole point: two workers polling at the same moment must not
 * both claim the same row. SKIP LOCKED makes the second worker take the NEXT job instead of
 * blocking behind the first — without it, concurrency degrades to one worker with extra steps.
 */
export async function claimNextJob(
  pool: Pool, jobTypes: readonly JobType[] | null, actorId: string | null,
): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `update public.background_jobs j
          set status = 'running', started_at = now(), attempts = attempts + 1
        where j.id = (
          select c.id from public.background_jobs c
           where c.status = 'queued'
             and c.next_run_at <= now()
             and ($1::text[] is null or c.job_type = any($1::text[]))
           order by c.priority, c.created_at
           for update skip locked
           limit 1)
      returning ${COLS}`,
      [jobTypes && jobTypes.length ? [...jobTypes] : null]);
    if (!res.rowCount) { await client.query("commit"); return null; }
    const job = mapJob(res.rows[0]);
    await audit(client, {
      actor: actorId, action: "claim_job",
      entityTable: "background_jobs", entityId: job.id,
      after: { jobType: job.jobType, attempt: job.attempts, automated: true },
    });
    await client.query("commit");
    return job;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** Report progress. Cheap and frequent, so it takes no transaction and writes no audit row. */
export async function reportProgress(
  pool: Pool, jobId: string, done: number, total: number | null,
): Promise<void> {
  await pool.query(
    `update public.background_jobs
        set progress_done = $2,
            progress_total = coalesce($3, progress_total)
      where id = $1 and status = 'running'`,
    [jobId, Math.max(0, Math.floor(done)), total == null ? null : Math.max(0, Math.floor(total))]);
}

export async function completeJob(
  pool: Pool, jobId: string, actorId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `update public.background_jobs
          set status = 'succeeded', finished_at = now(), last_error = null
        where id = $1 and status = 'running' returning id`, [jobId]);
    if (res.rowCount) {
      await audit(client, {
        actor: actorId, action: "complete_job",
        entityTable: "background_jobs", entityId: jobId,
        after: { automated: true },
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

/**
 * Report a failure and let the retry policy decide what happens next.
 *
 * The decision is made by `nextAfterFailure` (pure, unit-tested) rather than inline SQL, so the
 * rule can be exercised without a database and the same rule governs every job type.
 */
export async function failJob(
  pool: Pool, jobId: string, error: string, actorId: string | null, permanent = false,
): Promise<{ status: "failed" | "dead_letter"; retryInSeconds: number | null } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query(
      `select attempts, max_attempts from public.background_jobs
        where id = $1 and status = 'running' for update`, [jobId]);
    if (!cur.rowCount) { await client.query("commit"); return null; }
    const attempts = Number(cur.rows[0].attempts);
    const maxAttempts = Number(cur.rows[0].max_attempts);
    const decision = nextAfterFailure(attempts, maxAttempts, permanent);
    const message = error.trim() === "" ? "(boş hata mesajı)" : error.slice(0, 4000);

    if (decision.status === "dead_letter") {
      await client.query(
        `update public.background_jobs
            set status = 'dead_letter', finished_at = now(), last_error = $2,
                dead_lettered_at = now(),
                dead_letter_reason = $3
          where id = $1`,
        [jobId, message,
         permanent ? `Kalıcı hata: ${message}` : `Deneme hakkı bitti (${attempts}/${maxAttempts}): ${message}`]);
    } else {
      await client.query(
        `update public.background_jobs
            set status = 'failed', finished_at = now(), last_error = $2,
                next_run_at = now() + ($3 || ' seconds')::interval
          where id = $1`,
        [jobId, message, String(decision.retryInSeconds ?? backoffSeconds(attempts))]);
    }
    await audit(client, {
      actor: actorId, action: "fail_job",
      entityTable: "background_jobs", entityId: jobId,
      after: {
        outcome: decision.status, attempts, maxAttempts, permanent,
        retryInSeconds: decision.retryInSeconds, automated: true,
      },
    });
    await client.query("commit");
    return decision;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

/**
 * Return a failed job to the queue once its backoff has elapsed.
 *
 * Separate from failJob because it is a different actor: failJob is the worker admitting defeat,
 * this is the scheduler noticing the wait is over.
 */
export async function requeueDueFailures(pool: Pool): Promise<number> {
  const res = await pool.query(
    `update public.background_jobs
        set status = 'queued', finished_at = null
      where status = 'failed' and next_run_at <= now() and attempts < max_attempts
      returning id`);
  return res.rowCount ?? 0;
}

/**
 * Replay a dead-lettered job — the one way out of the DLQ, and deliberately manual.
 *
 * Attempts are reset, because the operator is asserting that the CAUSE was fixed; leaving the
 * old count would dead-letter it again on the first hiccup. The audit row records who made that
 * assertion, which is the point of requiring a human.
 */
export async function replayDeadLetter(
  pool: Pool, jobId: string, actorId: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `update public.background_jobs
          set status = 'queued', attempts = 0, next_run_at = now(),
              finished_at = null, dead_lettered_at = null, dead_letter_reason = null
        where id = $1 and status = 'dead_letter' returning id`, [jobId]);
    if (res.rowCount) {
      await audit(client, {
        actor: actorId, action: "replay_dead_letter_job",
        entityTable: "background_jobs", entityId: jobId,
        after: { attemptsReset: true, manual: true },
      });
    }
    await client.query("commit");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

/**
 * Return jobs whose worker died mid-run.
 *
 * A 'running' row with no heartbeat is indistinguishable from a crashed worker after long enough,
 * and leaving it there means the job never runs again AND its dedupe key stays occupied.
 */
export async function reapStuckJobs(pool: Pool, olderThanMinutes = 30): Promise<number> {
  const res = await pool.query(
    `update public.background_jobs
        set status = 'queued', next_run_at = now(),
            last_error = 'İşçi yanıt vermedi, iş kuyruğa geri alındı'
      where status = 'running'
        and started_at < now() - ($1 || ' minutes')::interval
      returning id`, [String(Math.max(1, Math.floor(olderThanMinutes)))]);
  return res.rowCount ?? 0;
}

export async function listJobs(pool: Pool, limit = 100): Promise<JobRow[]> {
  const res = await pool.query(
    `select ${COLS} from public.background_jobs
      order by case status when 'dead_letter' then 0 when 'running' then 1
                           when 'failed' then 2 when 'queued' then 3 else 4 end,
               created_at desc
      limit $1`, [limit]);
  return res.rows.map(mapJob);
}

export async function loadQueueHealth(pool: Pool) {
  const res = await pool.query(
    `select job_type, status, job_count, oldest_created_at, max_attempts_used, avg_seconds
       from public.background_job_queue_health order by job_type, status`);
  return res.rows.map((x) => ({
    jobType: x.job_type as JobType,
    status: x.status as JobStatus,
    jobCount: Number(x.job_count),
    oldestCreatedAt: x.oldest_created_at as string | null,
    maxAttemptsUsed: x.max_attempts_used == null ? null : Number(x.max_attempts_used),
    // NULL stays NULL: "nothing has finished yet" is not "it takes zero seconds".
    avgSeconds: x.avg_seconds == null ? null : Number(x.avg_seconds),
  }));
}

/** Exported for the gate and for callers that need a client-scoped enqueue inside a transaction. */
export async function enqueueOnClient(
  client: PoolClient, input: EnqueueInput, actorId: string | null,
): Promise<string> {
  const res = await client.query(
    `insert into public.background_jobs
       (job_type, payload, priority, dedupe_key, max_attempts, created_by)
     values ($1, $2::jsonb, $3, $4, $5, $6) returning id`,
    [input.jobType, JSON.stringify(input.payload), input.priority,
     input.dedupeKey ?? null, input.maxAttempts, actorId]);
  return res.rows[0].id as string;
}
