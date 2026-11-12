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

import { createHash } from "node:crypto";
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

/**
 * Creates a fresh `JobDispatcher` pre-loaded with built-in handlers for every `JOB_TYPES` entry.
 */
export function createConfiguredDispatcher(): JobDispatcher {
  return registerBuiltInJobHandlers(new JobDispatcher());
}

/**
 * Faz 42 (B2) / F-33 / F-34: Registers deterministic, idempotent built-in handlers for all
 * `JOB_TYPES` in `background_jobs` using lazy module imports so `src/lib/jobs/dispatcher.ts`
 * stays free of `@/lib/env` at load time.
 */
export function registerBuiltInJobHandlers(
  target: JobDispatcher = new JobDispatcher(),
): JobDispatcher {
  target.register("excel_import", async ({ pool, actorId, job, reportProgress: onProgress }) => {
    const [{ getRawPool }, { processAsyncWorkbookPreviewJob }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/importers/v2/async-runner"),
    ]);
    await onProgress(0, 3);
    const outcome = await processAsyncWorkbookPreviewJob(
      {
        pool,
        identityPool: getRawPool(),
        systemActorId: actorId,
      },
      job.id,
    );
    if (outcome.outcome === "succeeded") {
      // `processAsyncWorkbookPreviewJob` already persisted the compact preview report into `result`
      // and marked the job `'succeeded'`; returning `{ success: true }` without `resultPayload`
      // preserves that stored report (`completeJob` no-ops on non-running rows).
      return { success: true };
    }
    return {
      success: false,
      resultPayload: {
        task: "excel.preview",
        outcome: outcome.outcome,
        error: outcome.error ?? "Asenkron çalışma kitabı önizlemesi tamamlanamadı.",
      },
    };
  });

  target.register("bank_statement_import", async ({ pool, actorId, job, reportProgress: onProgress }) => {
    const bankAccountId =
      typeof job.payload.bankAccountId === "string" ? job.payload.bankAccountId.trim() : "";
    const filename =
      typeof job.payload.filename === "string" && job.payload.filename.trim()
        ? job.payload.filename.trim()
        : "statement.mt940";

    let buf: Buffer | null = null;
    if (typeof job.payload.contentBase64 === "string" && job.payload.contentBase64.trim()) {
      buf = Buffer.from(job.payload.contentBase64.trim(), "base64");
    } else if (typeof job.payload.rawText === "string" && job.payload.rawText.length > 0) {
      buf = Buffer.from(job.payload.rawText, "utf8");
    }

    if (!bankAccountId || !buf || buf.length === 0) {
      return {
        success: false,
        resultPayload: {
          task: "bank.statement_import",
          error:
            "Banka ekstresi işi için geçerli 'bankAccountId' ve 'contentBase64' (veya 'rawText') yükü gerekli.",
        },
      };
    }

    await onProgress(0, 1);
    const { importHybridBankStatement } = await import(
      "@/lib/importers/bank-formats/mt940-camt053-parasut"
    );
    const outcome = await importHybridBankStatement(pool, {
      buf,
      filename,
      bankAccountId,
      actorId,
    });
    await onProgress(1, 1);

    if (!outcome.ok) {
      return {
        success: false,
        resultPayload: {
          task: "bank.statement_import",
          bankAccountId,
          filename,
          workbookId: outcome.workbookId,
          error: outcome.error ?? "Hibrit banka ekstresi ayrıştırılamadı.",
        },
      };
    }

    return {
      success: true,
      resultPayload: {
        task: "bank.statement_import",
        bankAccountId,
        filename,
        workbookId: outcome.workbookId,
        rowsSeen: outcome.rowsSeen,
        inserted: outcome.inserted,
        duplicates: outcome.duplicates,
        ownTransfers: outcome.ownTransfers,
      },
    };
  });

  target.register("large_export", async ({ pool, job, reportProgress: onProgress }) => {
    const { rowsToCsv, toXlsxBuffer } = await import("@/lib/analytics/export");
    const dataset =
      job.payload.dataset === "payment_instances" ||
      job.payload.dataset === "bank_transactions" ||
      job.payload.dataset === "working_capital"
        ? job.payload.dataset
        : "open_invoices";
    const format = job.payload.format === "xlsx" ? "xlsx" : "csv";

    await onProgress(0, 2);

    let sheetName = "Acik Faturalar";
    let sheetRows: (string | number | null)[][] = [];

    if (dataset === "payment_instances") {
      sheetName = "Odeme Ornekleri";
      const res = await pool.query<{
        period_month: string;
        title: string;
        status: string;
        due_date: string | null;
        currency: string;
        amount_planned: string | null;
        amount_paid: string;
      }>(
        `select to_char(pi.period_month, 'YYYY-MM-DD') as period_month,
                p.title,
                pi.status,
                to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
                pi.currency,
                pi.amount_planned::text as amount_planned,
                pi.amount_paid::text as amount_paid
           from public.payment_instances pi
           join public.payment_items p on p.id = pi.payment_item_id
          order by pi.due_date desc nulls last, pi.created_at desc
          limit 5000`,
      );
      sheetRows = [
        ["Dönem", "Kalem", "Durum", "Vade", "Döviz", "Planlanan", "Ödenen"],
        ...res.rows.map((r) => [
          r.period_month,
          r.title,
          r.status,
          r.due_date,
          r.currency,
          r.amount_planned,
          r.amount_paid,
        ]),
      ];
    } else if (dataset === "bank_transactions") {
      sheetName = "Banka Hareketleri";
      const res = await pool.query<{
        txn_date: string;
        currency: string;
        amount: string;
        transaction_kind: string;
        status: string;
        channel: string;
        counterparty: string;
        reference_no: string;
      }>(
        `select to_char(txn_date, 'YYYY-MM-DD') as txn_date,
                currency,
                amount::text as amount,
                transaction_kind,
                status,
                channel,
                coalesce(counterparty_name_raw, '') as counterparty,
                coalesce(reference_no, '') as reference_no
           from public.bank_transactions
          order by txn_date desc, created_at desc
          limit 5000`,
      );
      sheetRows = [
        ["Tarih", "Döviz", "Tutar", "Tür", "Durum", "Kanal", "Karşı Taraf", "Referans"],
        ...res.rows.map((r) => [
          r.txn_date,
          r.currency,
          r.amount,
          r.transaction_kind,
          r.status,
          r.channel,
          r.counterparty,
          r.reference_no,
        ]),
      ];
    } else if (dataset === "working_capital") {
      sheetName = "Isletme Sermayesi";
      const res = await pool.query<{
        period_month: string;
        receivables_open: string;
        payables_open: string;
        net_working_capital_ex_inventory: string;
        dso_days: string | null;
        dpo_days: string | null;
        cash_cycle_excluding_inventory: string | null;
      }>(
        `select to_char(period_start, 'YYYY-MM') as period_month,
                receivables_open::text,
                payables_open::text,
                net_working_capital_ex_inventory::text,
                dso_days::text,
                dpo_days::text,
                cash_cycle_excluding_inventory::text
           from public.working_capital_monthly_v
          order by period_start desc
          limit 120`,
      );
      sheetRows = [
        ["Ay", "Açık Alacak (TRY)", "Açık Borç (TRY)", "NİS (Stok Hariç)", "DSO (Gün)", "DPO (Gün)", "CCC (Gün)"],
        ...res.rows.map((r) => [
          r.period_month,
          r.receivables_open,
          r.payables_open,
          r.net_working_capital_ex_inventory,
          r.dso_days,
          r.dpo_days,
          r.cash_cycle_excluding_inventory,
        ]),
      ];
    } else {
      const res = await pool.query<{
        invoice_no: string;
        direction: string;
        issue_date: string;
        due_date: string | null;
        currency: string;
        gross_amount: string;
        payable_amount: string | null;
        paid_amount: string;
        status: string;
      }>(
        `select invoice_no,
                direction,
                to_char(issue_date, 'YYYY-MM-DD') as issue_date,
                to_char(due_date, 'YYYY-MM-DD') as due_date,
                currency,
                gross_amount::text,
                payable_amount::text,
                paid_amount::text,
                status
           from public.invoices
          where status in ('open', 'partial')
          order by due_date nulls last, issue_date desc
          limit 5000`,
      );
      sheetRows = [
        ["Fatura No", "Yön", "Düzenleme", "Vade", "Döviz", "Brüt", "Ödenecek", "Ödenen", "Durum"],
        ...res.rows.map((r) => [
          r.invoice_no,
          r.direction,
          r.issue_date,
          r.due_date,
          r.currency,
          r.gross_amount,
          r.payable_amount,
          r.paid_amount,
          r.status,
        ]),
      ];
    }

    await onProgress(1, 2);

    const rowCount = Math.max(0, sheetRows.length - 1);
    const bytes =
      format === "xlsx"
        ? await toXlsxBuffer([{ name: sheetName, rows: sheetRows }])
        : Buffer.from(rowsToCsv(sheetRows), "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await onProgress(2, 2);
    return {
      success: true,
      resultPayload: {
        task: "export.large",
        dataset,
        format,
        sheetName,
        rowCount,
        byteLength: bytes.byteLength,
        sha256,
        generatedAt: new Date().toISOString(),
        inlineBase64: bytes.byteLength <= 65_536 ? bytes.toString("base64") : null,
      },
    };
  });
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
