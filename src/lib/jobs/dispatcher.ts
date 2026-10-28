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
 * - Başarılı işlerin ardından otomatik Cache Invalidation tetikleme
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
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS, type CacheTag } from "@/lib/cache/tags";

export interface JobContext {
  pool: Pool;
  reportProgress: (done: number, total: number | null) => Promise<void>;
  job: JobRow;
}

export type JobHandlerResult = {
  success: boolean;
  resultPayload?: Record<string, unknown>;
  cacheTagsToInvalidate?: CacheTag[];
};

export type JobHandler = (context: JobContext) => Promise<JobHandlerResult>;

export interface DispatchResult {
  processed: boolean;
  jobId?: string;
  jobType?: JobType;
  status?: "succeeded" | "failed" | "no_handler";
  error?: string;
}

/**
 * İş tiplerinin başarıyla tamamlandığında varsayılan olarak hangi cache tag'lerini
 * düşüreceğini haritalar.
 */
const DEFAULT_JOB_CACHE_TAGS: Partial<Record<JobType, CacheTag[]>> = {
  excel_import: [CACHE_TAGS.INVOICES, CACHE_TAGS.PAYMENTS, CACHE_TAGS.CASHFLOW, CACHE_TAGS.CFO_BRIEFING],
  bank_statement_import: [CACHE_TAGS.BANK_TRANSACTIONS, CACHE_TAGS.BANK_ACCOUNTS, CACHE_TAGS.BANK_RECONCILIATION, CACHE_TAGS.CFO_BRIEFING],
  fx_rate_sync: [CACHE_TAGS.FX_RATES, CACHE_TAGS.FX_EXPOSURE, CACHE_TAGS.TREASURY],
  read_model_refresh: [CACHE_TAGS.CASHFLOW, CACHE_TAGS.INVOICES, CACHE_TAGS.REPORTS],
};

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
   */
  async processNext(pool: Pool, actorId: string | null = "worker-daemon"): Promise<DispatchResult> {
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

        // İlgili önbellek etiketlerini otomatik temizle
        const tags = outcome.cacheTagsToInvalidate ?? DEFAULT_JOB_CACHE_TAGS[job.jobType] ?? [];
        if (tags.length > 0) {
          await cache.invalidateTags(tags);
        }

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
  async processBatch(pool: Pool, maxJobs = 10, actorId: string | null = "worker-daemon"): Promise<DispatchResult[]> {
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
