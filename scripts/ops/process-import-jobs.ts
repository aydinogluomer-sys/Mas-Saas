/**
 * Standart Import V2 — asenkron ÖNİZLEME işçisi (Wave 0 / R8 & Faz 42 B2).
 *
 * `POST /api/imports/v2/async` ile kuyruğa alınmış `excel_import` işlerini alır, her biri için
 * önizlemeyi (dry-run) koşturur ve raporu iş satırına yazar. HİÇBİR finansal kaydı yazmaz.
 *
 * Faz 42 (B2 — backlog #7): Her döngü başında `requeueDueFailures` ve `reapStuckJobs` çağrılarak
 * geçici G/Ç veya veritabanı hatası almış `failed` önizleme işleri ve yarım kalmış `running` işleri
 * bekleme süresi dolduğunda yeniden `'queued'` durumuna döndürülür; ayrıca `background-worker.ts`
 * içinden çağrılabilir `processPendingImportJobs` fonksiyonu dışa aktarılır.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { AsyncPreviewOutcome, AsyncPreviewWorkerDeps } from "../../src/lib/importers/v2/async-runner";

export const MAX_JOBS_PER_RUN = 25;

export interface ImportJobsCycleSummary {
  requeued: number;
  reaped: number;
  processed: number;
  outcomes: AsyncPreviewOutcome[];
  sweptRemoved: number;
  sweptKept: number;
}

export interface ImportJobsCycleOptions {
  maxJobs?: number;
  stuckAfterMinutes?: number;
  sweepStaging?: boolean;
  quiet?: boolean;
}

/**
 * Runs one bounded cycle of Import V2 async preview jobs inside the caller's `runAsSystem` context.
 */
export async function processPendingImportJobs(
  deps: AsyncPreviewWorkerDeps & { pool: Pool },
  opts: ImportJobsCycleOptions = {},
): Promise<ImportJobsCycleSummary> {
  const [{ claimNextJob, reapStuckJobs, requeueDueFailures }, runner] = await Promise.all([
    import("../../src/lib/jobs/queue"),
    import("../../src/lib/importers/v2/async-runner"),
  ]);

  const maxJobs = Math.max(1, opts.maxJobs ?? MAX_JOBS_PER_RUN);
  const stuckAfterMinutes = Math.max(1, opts.stuckAfterMinutes ?? 30);
  const quiet = opts.quiet ?? false;
  const shouldSweep = opts.sweepStaging ?? true;

  // Faz 42 (B2 — backlog #7): Return backoff-elapsed transient failures & dead-worker jobs to 'queued'.
  const requeued = await requeueDueFailures(deps.pool);
  const reaped = await reapStuckJobs(deps.pool, stuckAfterMinutes);

  if (!quiet) {
    console.log("=== Standart Import V2 — asenkron önizleme işçisi ===");
    if (requeued > 0 || reaped > 0) {
      console.log(`Kurtarılan işler: yeniden_kuyruk=${requeued} takılı_kurtarılan=${reaped}`);
    }
  }

  let processed = 0;
  const outcomes: AsyncPreviewOutcome[] = [];
  while (processed < maxJobs) {
    const job = await claimNextJob(deps.pool, [runner.ASYNC_PREVIEW_JOB_TYPE], deps.systemActorId);
    if (!job) break;
    processed++;
    const r = await runner.processAsyncWorkbookPreviewJob(deps, job.id);
    outcomes.push(r);
    if (!quiet) {
      // Yalnız sayaçlar ve durum yazılır; tutar, karşı taraf ya da dosya içeriği konsola düşmez.
      if (r.outcome === "succeeded" && r.counters) {
        const c = r.counters;
        console.log(
          `ÖNİZLENDİ  ${job.id}  yaratılacak=${c.create} güncellenecek=${c.update} ` +
            `inceleme=${c.review} red=${c.reject} belirlenemedi=${c.undetermined}`,
        );
      } else {
        console.log(`${r.outcome.toUpperCase()}  ${job.id}  ${r.error ?? ""}`);
      }
    }
  }

  if (!quiet) {
    if (processed === 0) console.log("Kuyrukta bekleyen önizleme işi yok.");
    if (processed === maxJobs) console.log(`Koşu sınırı (${maxJobs}) doldu; kalanlar sonraki koşuda.`);
  }

  let sweptRemoved = 0;
  let sweptKept = 0;
  if (shouldSweep) {
    const swept = await runner.sweepStaleStagedFiles(deps.pool, { stagingDir: deps.stagingDir });
    sweptRemoved = swept.removed;
    sweptKept = swept.kept;
    if (!quiet) {
      console.log(`Sahneleme süpürmesi: ${swept.removed} sahipsiz dosya silindi, ${swept.kept} dosya korundu.`);
    }
  }

  return {
    requeued,
    reaped,
    processed,
    outcomes,
    sweptRemoved,
    sweptKept,
  };
}

async function main(): Promise<void> {
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());

  const [db, { getSystemActorId }] = await Promise.all([
    import("../../src/lib/db"),
    import("../db/seed-system-actor"),
  ]);

  const pool = db.getPool();
  try {
    const systemActorId = await getSystemActorId(db.getRawPool());
    const deps = { pool, identityPool: db.getRawPool(), systemActorId };

    await db.runAsSystem(async () => {
      await processPendingImportJobs(deps, { quiet: false, sweepStaging: true });
    });
  } finally {
    await pool.end();
  }
}

const isDirectCli =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCli) {
  main().catch((err) => {
    console.error("Önizleme işçisi hatası:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
