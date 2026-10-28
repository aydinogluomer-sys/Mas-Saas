/**
 * MAS Nakit Radar — Unified Background Job Dispatcher
 *
 * PostgreSQL 'background_jobs' kuyruğu ile arka plan işçilerini (workers)
 * birbirine bağlayan merkezi dağıtıcı (dispatcher).
 *
 * Özellikler:
 * - Tip güvenli handler kaydı
 * - 'FOR UPDATE SKIP LOCKED' ile sıfır kilitlenme / çoklu işçi desteği
 * - Otomatik ilerleme raporlama (progress tracking)
 * - Exponential backoff ile hata yakalama ve Dead-Letter-Queue yönetimi
 *
 * Wave 0: the unreviewed layer also had this dispatcher drop "cache tags" after every
 * successful job. That is gone together with the in-process read cache it fed (the module was
 * deleted): reads go to PostgreSQL on every request again, so a finished job has nothing to
 * invalidate. It could not have worked anyway — a worker runs in its own process
 * (scripts/ops/process-import-jobs.ts) and can never reach the web server's in-memory Map.
 *
 * NOBODY CALLS THIS YET. No job type has a registered handler in production code; the one live
 * worker (the async Import V2 preview, scripts/ops/process-import-jobs.ts) drives the queue
 * directly. The contract below is what a future caller must meet:
 *
 *   Identity   Run processNext/processBatch inside runAsSystem() with the role-scoped pool
 *              (getPool()), and pass the reserved 'system' account's id as the actor — resolved
 *              once per run with getSystemActorId(getRawPool()) from scripts/db/seed-system-actor.ts,
 *              exactly as process-import-jobs.ts does. `audit_logs.actor` is a foreign key to
 *              public.users(id): the layer defaulted it to a fixed non-uuid text, which made the
 *              first claim's audit insert fail and the claim roll back, so the queue could never
 *              have moved. The actor is therefore REQUIRED and checked to be a uuid before
 *              anything is claimed; a null "nobody" is not offered either — a job's trail names
 *              the account that ran it.
 *   Handlers   Must be idempotent. A handler that succeeded but whose completion could not be
 *              recorded leaves the job 'running'; reapStuckJobs() (queue.ts) returns such a job to
 *              the queue after its timeout, and the handler runs again.
 */

import type { Pool } from "pg";
import {
  claimNextJob,
  completeJob,
  failJob,
  reportProgress,
  type JobRow,
} from "./queue";
import type { JobType } from "./rules";

export interface JobContext {
  pool: Pool;
  reportProgress: (done: number, total: number | null) => Promise<void>;
  job: JobRow;
}

export type JobHandlerResult = {
  success: boolean;
  resultPayload?: Record<string, unknown>;
};

export type JobHandler = (context: JobContext) => Promise<JobHandlerResult>;

export interface DispatchResult {
  processed: boolean;
  jobId?: string;
  jobType?: JobType;
  status?: "succeeded" | "failed" | "no_handler";
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refuses anything that `audit_logs.actor` (uuid, FK to public.users) could not store. */
function assertActor(actorId: string): void {
  if (typeof actorId !== "string" || !UUID.test(actorId)) {
    throw new Error(
      "İş dağıtıcısı için geçerli bir aktör (rezerve 'system' hesabının uuid'si) gerekli — " +
        "scripts/db/seed-system-actor.ts getSystemActorId. Hiçbir iş sahiplenilmedi.",
    );
  }
}

class JobDispatcher {
  private handlers = new Map<JobType, JobHandler>();

  /**
   * Kayıtlı tüm handler'ları temizler (test izolasyonu için).
   */
  clearHandlers(): void {
    this.handlers.clear();
  }

  /**
   * Belirli bir iş tipi için çalıştırıcı (handler) kaydeder.
   */
  register(jobType: JobType, handler: JobHandler): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  /**
   * Kuyruktaki ilk uygun işi atomik olarak sahiplenir ('claim') ve kaydolan handler ile çalıştırır.
   *
   * `actorId` claim/complete/fail denetim satırlarının aktörüdür (bkz. dosya başlığı: rezerve
   * 'system' hesabının uuid'si, zorunlu). Yalnız handler'ı KAYITLI türler sahiplenilir.
   *
   * Hata ayrımı: yalnız HANDLER'ın hatası (fırlatma ya da success:false) failJob'a gider. Handler
   * başarıyla bittikten sonra completeJob'un kendisi başarısız olursa hata yukarı çıkar ve failJob
   * ÇAĞRILMAZ: katman ikisini aynı try içinde tutuyordu, bu durumda başarılı bir işi "başarısız"
   * kaydedip geri çekilme (backoff) sonunda bitmiş işi yeniden çalıştırırdı. İş 'running' kalır;
   * reapStuckJobs onu zaman aşımından sonra kuyruğa döndürür (handler'lar idempotent olmalı).
   */
  async processNext(pool: Pool, actorId: string): Promise<DispatchResult> {
    assertActor(actorId);
    const registeredTypes = Array.from(this.handlers.keys());
    if (registeredTypes.length === 0) {
      return { processed: false };
    }

    const job = await claimNextJob(pool, registeredTypes, actorId);
    if (!job) {
      return { processed: false };
    }

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      await failJob(pool, job.id, `Handler bulunamadı: ${job.jobType}`, actorId);
      return {
        processed: true,
        jobId: job.id,
        jobType: job.jobType,
        status: "no_handler",
        error: `Handler bulunamadı: ${job.jobType}`,
      };
    }

    const context: JobContext = {
      pool,
      job,
      reportProgress: async (done: number, total: number | null) => {
        await reportProgress(pool, job.id, done, total);
      },
    };

    let outcome: JobHandlerResult;
    try {
      outcome = await handler(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(pool, job.id, message, actorId);
      return {
        processed: true,
        jobId: job.id,
        jobType: job.jobType,
        status: "failed",
        error: message,
      };
    }

    if (!outcome.success) {
      const errMsg = "İş başarısız olarak raporlandı.";
      await failJob(pool, job.id, errMsg, actorId);
      return {
        processed: true,
        jobId: job.id,
        jobType: job.jobType,
        status: "failed",
        error: errMsg,
      };
    }

    // Outside the handler's try on purpose (see above): a failure here propagates untouched.
    await completeJob(pool, job.id, actorId);
    return {
      processed: true,
      jobId: job.id,
      jobType: job.jobType,
      status: "succeeded",
    };
  }

  /**
   * Kuyrukta bekleyen işleri parti halinde (batch) tüketir.
   */
  async processBatch(pool: Pool, actorId: string, maxJobs = 10): Promise<DispatchResult[]> {
    assertActor(actorId);
    const results: DispatchResult[] = [];
    for (let i = 0; i < maxJobs; i++) {
      const res = await this.processNext(pool, actorId);
      if (!res.processed) break;
      results.push(res);
    }
    return results;
  }
}

export const dispatcher = new JobDispatcher();
