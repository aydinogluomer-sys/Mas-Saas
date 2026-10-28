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
   * `actorId` claim/complete/fail denetim satırlarının aktörüdür ve `audit_logs.actor` bir
   * `public.users(id)` yabancı anahtarıdır (0032). Katmanın varsayılanı uuid olmayan sabit bir
   * metindi: ilk claim'in denetim INSERT'i hata verir, işlem geri alınır ve hiçbir iş
   * işlenemezdi (testler kuyruğu mock'ladığı için görünmedi). Varsayılan null — audit.ts'in
   * sistem işi için belgelediği değer; çağıran gerçek bir aktör (ör. rezerve 'system' hesabı)
   * verebilir.
   */
  async processNext(pool: Pool, actorId: string | null = null): Promise<DispatchResult> {
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

    try {
      const outcome = await handler(context);
      if (outcome.success) {
        await completeJob(pool, job.id, actorId);
        return {
          processed: true,
          jobId: job.id,
          jobType: job.jobType,
          status: "succeeded",
        };
      } else {
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
  }

  /**
   * Kuyrukta bekleyen işleri parti halinde (batch) tüketir.
   */
  async processBatch(pool: Pool, maxJobs = 10, actorId: string | null = null): Promise<DispatchResult[]> {
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
