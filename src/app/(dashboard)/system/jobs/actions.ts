"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { createConfiguredDispatcher } from "@/lib/jobs/dispatcher";
import {
  cancelJob,
  enqueueJob,
  reapStaleRunningJobs,
  replayDeadLetter,
  requeueDueFailures,
} from "@/lib/jobs/queue";
import { JOB_TYPES, type JobType } from "@/lib/jobs/rules";
import { formObject, parseOrThrow } from "@/lib/validation";

const jobIdSchema = z.object({
  jobId: z.string().trim().uuid("Geçerli bir iş kimliği (UUID) gerekli"),
  reason: z.string().trim().max(500).optional(),
});

const reapSchema = z.object({
  olderThanMinutes: z.coerce.number().int().min(1).max(1440).default(30),
});

function scalarField(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0]?.trim() || undefined;
  const s = v?.trim();
  return s ? s : undefined;
}

/**
 * Replay one dead-lettered job.
 *
 * Deliberately a per-job button rather than a "replay all": dead-lettering means the cause was
 * not transient, and replaying a batch without looking at why each one died is how the same
 * failure gets re-run twenty times.
 */
export async function replayJobAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const raw = formObject(formData);
  const jobId = scalarField(raw.jobId) ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  const parsed = parseOrThrow(jobIdSchema, { jobId });
  await replayDeadLetter(getPool(), parsed.jobId, session.id);
  revalidatePath("/system/jobs");
}

/**
 * Cancel a queued/pending job (`queued -> cancelled`) and write an audit trail receipt.
 */
export async function cancelJobAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const raw = formObject(formData);
  const jobId = scalarField(raw.jobId) ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  const parsed = parseOrThrow(jobIdSchema, {
    jobId,
    reason: scalarField(raw.reason) ?? "Operatör tarafından iptal edildi",
  });
  await cancelJob(getPool(), parsed.jobId, session.id, parsed.reason);
  revalidatePath("/system/jobs");
}

/**
 * Recover stale `'running'` jobs whose worker timed out (`running -> queued`) with audit receipt.
 */
export async function reapStaleJobsAction(formData?: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const raw = formData ? formObject(formData) : {};
  const parsed = parseOrThrow(reapSchema, {
    olderThanMinutes: scalarField(raw.olderThanMinutes) ?? "30",
  });
  await reapStaleRunningJobs(getPool(), parsed.olderThanMinutes, session.id);
  revalidatePath("/system/jobs");
}

/** Run the two housekeeping sweeps by hand — the same functions a scheduler would call. */
export async function sweepQueueAction(): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const pool = getPool();
  await requeueDueFailures(pool);
  await reapStaleRunningJobs(pool, 30, session.id);
  revalidatePath("/system/jobs");
}

/** Enqueue a built-in background job and immediately run one dispatcher cycle. */
export async function enqueueAndDispatchJobAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "insert", "/system/jobs");
  const raw = formObject(formData);
  const rawType = scalarField(raw.jobType) ?? "read_model_refresh";
  const jobType: JobType = (JOB_TYPES as readonly string[]).includes(rawType)
    ? (rawType as JobType)
    : "read_model_refresh";
  const task = scalarField(raw.task) ?? "overview.refresh";
  const dataset = scalarField(raw.dataset);
  const format = scalarField(raw.format);
  const payload: Record<string, unknown> = { task, triggeredFrom: "ui_dispatcher" };
  if (dataset) payload.dataset = dataset;
  if (format) payload.format = format;

  const pool = getPool();
  await enqueueJob(
    pool,
    {
      jobType,
      payload,
    },
    session.id,
  );
  const localDispatcher = createConfiguredDispatcher();
  await localDispatcher.processNext(pool, session.id);
  revalidatePath("/system/jobs");
}

/** Process the next queued job using the unified JobDispatcher. */
export async function processNextQueuedJobAction(): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const pool = getPool();
  const localDispatcher = createConfiguredDispatcher();
  await localDispatcher.processNext(pool, session.id);
  revalidatePath("/system/jobs");
}
