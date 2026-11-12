"use server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { enqueueJob, replayDeadLetter, reapStuckJobs, requeueDueFailures } from "@/lib/jobs/queue";
import { JobDispatcher, registerBuiltInJobHandlers } from "@/lib/jobs/dispatcher";
import { JOB_TYPES, type JobType } from "@/lib/jobs/rules";
import { requireActionPermission } from "@/lib/auth";

/**
 * Replay one dead-lettered job.
 *
 * Deliberately a per-job button rather than a "replay all": dead-lettering means the cause was
 * not transient, and replaying a batch without looking at why each one died is how the same
 * failure gets re-run twenty times.
 */
export async function replayJobAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const jobId = String(formData.get("jobId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  await replayDeadLetter(getPool(), jobId, session.id);
  revalidatePath("/system/jobs");
}

/** Run the two housekeeping sweeps by hand — the same functions a scheduler would call. */
export async function sweepQueueAction(): Promise<void> {
  await requireActionPermission("background_jobs", "update", "/system/jobs");
  const pool = getPool();
  await requeueDueFailures(pool);
  await reapStuckJobs(pool, 30);
  revalidatePath("/system/jobs");
}

/** Enqueue a built-in background job and immediately run one dispatcher cycle. */
export async function enqueueAndDispatchJobAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "insert", "/system/jobs");
  const rawType = String(formData.get("jobType") ?? "read_model_refresh");
  const jobType: JobType = (JOB_TYPES as readonly string[]).includes(rawType)
    ? (rawType as JobType)
    : "read_model_refresh";
  const task = String(formData.get("task") ?? "overview.refresh");
  const pool = getPool();
  await enqueueJob(
    pool,
    {
      jobType,
      payload: { task, triggeredFrom: "ui_dispatcher" },
    },
    session.id,
  );
  const localDispatcher = registerBuiltInJobHandlers(new JobDispatcher());
  await localDispatcher.processNext(pool, session.id);
  revalidatePath("/system/jobs");
}

/** Process the next queued job using the unified JobDispatcher. */
export async function processNextQueuedJobAction(): Promise<void> {
  const session = await requireActionPermission("background_jobs", "update", "/system/jobs");
  const pool = getPool();
  const localDispatcher = registerBuiltInJobHandlers(new JobDispatcher());
  await localDispatcher.processNext(pool, session.id);
  revalidatePath("/system/jobs");
}
