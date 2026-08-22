"use server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { replayDeadLetter, reapStuckJobs, requeueDueFailures } from "@/lib/jobs/queue";
import { requireSession } from "@/lib/auth";

/**
 * Replay one dead-lettered job.
 *
 * Deliberately a per-job button rather than a "replay all": dead-lettering means the cause was
 * not transient, and replaying a batch without looking at why each one died is how the same
 * failure gets re-run twenty times.
 */
export async function replayJobAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  await replayDeadLetter(getPool(), jobId, session.id);
  revalidatePath("/system/jobs");
}

/** Run the two housekeeping sweeps by hand — the same functions a scheduler would call. */
export async function sweepQueueAction(): Promise<void> {
  await requireSession();
  const pool = getPool();
  await requeueDueFailures(pool);
  await reapStuckJobs(pool, 30);
  revalidatePath("/system/jobs");
}
