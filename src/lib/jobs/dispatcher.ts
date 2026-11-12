/**
 * MAS Nakit Radar — Unified Background Job Dispatcher (Faz 33 & Faz 42 B2)
 *
 * PostgreSQL 'background_jobs' kuyruğu ile arka plan işçilerini (workers)
 * birbirine bağlayan merkezi dağıtıcı (dispatcher).
 *
 * Özellikler:
 * - Tip güvenli handler kaydı
 * - 'FOR UPDATE SKIP LOCKED' ile sıfır kilitlenme / çoklu işçi desteği
 * - Otomatik ilerleme raporlama (progress tracking)
 * - Exponential backoff ile hata yakalama ve Dead-Letter-Queue yönetimi
 * - `completeJob(pool, job.id, actorId, outcome.resultPayload)` ile sonuç yükü kalıcılığı (Faz 42 / backlog #8)
 *
 * Identity: Run processNext/processBatch inside `runAsSystem()` with the role-scoped pool
 * (`getPool()`), and pass the reserved `'system'` account's UUID as `actorId` (`getSystemActorId(getRawPool())`).
 * Handlers MUST be idempotent (`reapStuckJobs` returns timed-out jobs to `'queued'`).
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
  actorId: string;
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
  resultPayload?: Record<string, unknown>;
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

export class JobDispatcher {
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

  hasHandler(jobType: JobType): boolean {
    return this.handlers.has(jobType);
  }

  /**
   * Kuyruktaki ilk uygun işi atomik olarak sahiplenir ('claim') ve kaydolan handler ile çalıştırır.
   *
   * `actorId` claim/complete/fail denetim satırlarının aktörüdür (rezerve 'system' hesabının uuid'si).
   * Yalnız handler'ı KAYITLI türler sahiplenilir.
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
      actorId,
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
      const errMsg =
        typeof outcome.resultPayload?.error === "string" && outcome.resultPayload.error.trim()
          ? outcome.resultPayload.error
          : "İş başarısız olarak raporlandı.";
      await failJob(pool, job.id, errMsg, actorId);
      return {
        processed: true,
        jobId: job.id,
        jobType: job.jobType,
        status: "failed",
        error: errMsg,
      };
    }

    // Faz 42 (B2 — backlog #8): Persist `outcome.resultPayload` in the same atomic UPDATE as `status = 'succeeded'`.
    if (outcome.resultPayload !== undefined) {
      await completeJob(pool, job.id, actorId, outcome.resultPayload);
    } else {
      await completeJob(pool, job.id, actorId);
    }
    return {
      processed: true,
      jobId: job.id,
      jobType: job.jobType,
      status: "succeeded",
      resultPayload: outcome.resultPayload,
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

/**
 * Faz 42 (B2): Registers deterministic, idempotent built-in handlers for `background_jobs`
 * using lazy module imports so `src/lib/jobs/dispatcher.ts` stays free of `@/lib/env` at load time.
 *
 * Note: `excel_import` is processed separately by `scripts/ops/process-import-jobs.ts` because
 * it switches into the uploading user's RLS tier via `runAsUser`.
 */
export function registerBuiltInJobHandlers(target: JobDispatcher = dispatcher): JobDispatcher {
  target.register("report_generation", async ({ pool, actorId, job, reportProgress: onProgress }) => {
    const [{ generateDaily, generateMonthly, generateWeekly }, { istanbulDateISO }] = await Promise.all([
      import("@/lib/reports/engine"),
      import("@/lib/reports/rules"),
    ]);
    await onProgress(0, 1);
    const scope =
      job.payload.scope === "weekly" || job.payload.scope === "monthly" ? job.payload.scope : "daily";
    const todayISO =
      typeof job.payload.todayISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(job.payload.todayISO)
        ? job.payload.todayISO
        : istanbulDateISO();

    const report =
      scope === "weekly"
        ? await generateWeekly(pool, todayISO, actorId)
        : scope === "monthly"
          ? await generateMonthly(pool, todayISO.slice(0, 7) + "-01", actorId)
          : await generateDaily(pool, todayISO, actorId);

    await onProgress(1, 1);
    return {
      success: true,
      resultPayload: {
        task: "report.generate",
        scope,
        todayISO,
        reportId: report.id,
      },
    };
  });

  target.register("read_model_refresh", async ({ pool, actorId, job, reportProgress: onProgress }) => {
    const task = typeof job.payload.task === "string" ? job.payload.task : "overview.refresh";
    const { istanbulDateISO } = await import("@/lib/reports/rules");
    const todayISO =
      typeof job.payload.todayISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(job.payload.todayISO)
        ? job.payload.todayISO
        : istanbulDateISO();

    await onProgress(0, 1);

    if (task === "reminders.dispatch") {
      const { scheduleReminders, dispatchPending } = await import("@/lib/reminders/engine");
      const scheduled = await scheduleReminders(pool, todayISO);
      const delivered = await dispatchPending(pool, undefined, todayISO);
      await onProgress(1, 1);
      return {
        success: true,
        resultPayload: { task, todayISO, scheduled, delivered },
      };
    }

    if (task === "controls.evaluate") {
      const { loadControlDashboard, raiseAlert } = await import("@/lib/controls/engine");
      const rows = await loadControlDashboard(pool);
      let raised = 0;
      for (const row of rows) {
        if (row.findingCount > 0) {
          await raiseAlert(
            pool,
            {
              checkCode: row.checkCode,
              severity: row.severity,
              title: `${row.title} (${row.findingCount} bulgu)`,
              detail: row.rationale,
              ruleCodes: [row.checkCode],
            },
            actorId,
          );
          raised += 1;
        }
      }
      await onProgress(1, 1);
      return {
        success: true,
        resultPayload: { task, todayISO, controlsChecked: rows.length, alertsRaisedOrUpdated: raised },
      };
    }

    if (task === "integrations.parasut_incremental") {
      const { enqueueDueSyncs } = await import("@/lib/integrations/engine");
      const due = await enqueueDueSyncs(pool, actorId, todayISO);
      await onProgress(1, 1);
      return {
        success: true,
        resultPayload: { task, todayISO, enqueued: due.enqueued, skipped: due.skipped },
      };
    }

    if (task === "maintenance.daily_rollover") {
      const [{ ensureWindow }, { detectBrokenPromises }] = await Promise.all([
        import("@/lib/radar/engine"),
        import("@/lib/collections/promises-engine"),
      ]);
      const generated = await ensureWindow(pool, todayISO, actorId, 24);
      const broken = await detectBrokenPromises(pool, todayISO, actorId);
      await onProgress(1, 1);
      return {
        success: true,
        resultPayload: {
          task,
          todayISO,
          monthsChecked: generated.length,
          instancesCreated: generated.reduce((s, r) => s + r.created, 0),
          promisesMarkedBroken: broken.markedBroken,
        },
      };
    }

    const [{ validateContinuity }, { loadOverviewSnapshot }] = await Promise.all([
      import("@/lib/cashflow/engine"),
      import("@/lib/home/overview-snapshot"),
    ]);
    await validateContinuity(pool);
    await loadOverviewSnapshot(pool, todayISO);
    await onProgress(1, 1);
    return {
      success: true,
      resultPayload: {
        task: "overview.refresh",
        todayISO,
        refreshedAt: new Date().toISOString(),
      },
    };
  });

  target.register("fx_rate_sync", async ({ pool, actorId, job, reportProgress: onProgress }) => {
    const [{ importRates }, { tcmbProvider }, { istanbulDateISO }] = await Promise.all([
      import("@/lib/fx/engine"),
      import("@/lib/fx/provider"),
      import("@/lib/reports/rules"),
    ]);
    const todayISO =
      typeof job.payload.todayISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(job.payload.todayISO)
        ? job.payload.todayISO
        : istanbulDateISO();
    await onProgress(0, 1);
    const res = await importRates(pool, tcmbProvider(), todayISO, actorId);
    await onProgress(1, 1);
    if (!res.ok) {
      return {
        success: false,
        resultPayload: { task: "fx.tcmb_daily", todayISO, error: res.error ?? "TCMB kurları alınamadı" },
      };
    }
    return {
      success: true,
      resultPayload: {
        task: "fx.tcmb_daily",
        todayISO,
        rateDate: res.rateDate,
        inserted: res.inserted,
        skipped: res.skipped,
      },
    };
  });

  for (const syncType of ["accounting_sync", "bank_api_sync", "einvoice_sync"] as const) {
    target.register(syncType, async ({ pool, actorId, job, reportProgress: onProgress }) => {
      const [{ runSyncJob }, { realHttpClient }] = await Promise.all([
        import("@/lib/integrations/engine"),
        import("@/lib/integrations/types"),
      ]);
      await onProgress(0, 1);
      const outcome = await runSyncJob(pool, job, realHttpClient(), actorId);
      await onProgress(1, 1);
      return {
        success: outcome.ok,
        resultPayload: {
          jobType: syncType,
          imported: outcome.imported,
          skipped: outcome.skipped,
          stagedParties: outcome.stagedParties ?? 0,
          syncRunId: outcome.syncRunId ?? null,
          error: outcome.error ?? null,
        },
      };
    });
  }

  return target;
}
