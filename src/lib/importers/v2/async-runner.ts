/**
 * Standart Import V2 — Asenkron Kuyruk Yöneticisi (Faz 3).
 *
 * Büyük Excel dosyalarının (>10MB) HTTP istek sınırları ve gateway zaman aşımlarına (30-60 sn)
 * takılmadan işlenebilmesi için `public.background_jobs` kuyruğunu sürer:
 *   1. Dosyayı güvenli şekilde sahneleme alanına (data/uploads/staging) yazar.
 *   2. İşi `excel_import` türünde kuyruğa alır.
 *   3. İstemciye anında HTTP 202 Accepted yanıtı döner.
 *   4. Arka plan işçisi `processAsyncWorkbookImportJob` ile dosyayı okur, onaylar ve panoları yeniler.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import type { AppRole } from "@/lib/authz/matrix";
import {
  completeJob, enqueueJob, failJob, reportProgress, type JobRow,
} from "@/lib/jobs/queue";
import { confirmImport, validateUploadMeta, type ImportOutcome, type Rejection } from "./service";

const STAGING_DIR = path.resolve(process.cwd(), "data", "uploads", "staging");

function ensureStagingDir(): void {
  if (!existsSync(STAGING_DIR)) {
    mkdirSync(STAGING_DIR, { recursive: true });
  }
}

export interface EnqueueAsyncImportResult {
  jobId: string;
  status: string;
  sha256: string;
  filename: string;
  created: boolean;
}

export async function enqueueAsyncWorkbookImport(
  pool: Pool,
  buf: Buffer,
  filename: string,
  actorId: string,
  role: AppRole,
): Promise<{ ok: true; result: EnqueueAsyncImportResult } | { ok: false; rejection: Rejection }> {
  const meta = validateUploadMeta({ name: filename, size: buf.length });
  if (meta) return { ok: false, rejection: meta };

  ensureStagingDir();

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const filePath = path.join(STAGING_DIR, `${sha256}.xlsx`);

  await writeFile(filePath, buf);

  const dedupeKey = `v2_import_${sha256}`;
  const { job, created } = await enqueueJob(
    pool,
    {
      jobType: "excel_import",
      payload: {
        filename,
        fileSha256: sha256,
        filePath,
        actorId,
        role,
      },
      priority: 50,
      dedupeKey,
      maxAttempts: 3,
    },
    actorId,
  );

  return {
    ok: true,
    result: {
      jobId: job.id,
      status: job.status,
      sha256,
      filename,
      created,
    },
  };
}

export interface ProcessImportJobOutcome {
  jobId: string;
  success: boolean;
  outcome?: ImportOutcome;
  error?: string;
}

export async function processAsyncWorkbookImportJob(
  pool: Pool,
  jobId: string,
  actorId: string | null = null,
): Promise<ProcessImportJobOutcome> {
  const jobRes = await pool.query<JobRow>(
    `select id, job_type, status, payload from public.background_jobs where id = $1`,
    [jobId],
  );

  if (jobRes.rowCount === 0) {
    throw new Error(`İş bulunamadı: ${jobId}`);
  }

  const job = jobRes.rows[0];
  const payload = job.payload as {
    filename?: string;
    fileSha256?: string;
    filePath?: string;
    actorId?: string;
    role?: AppRole;
  };

  const filename = payload.filename ?? "unknown.xlsx";
  const fileSha256 = payload.fileSha256 ?? "";
  const filePath = payload.filePath;
  const jobActorId = payload.actorId ?? actorId ?? "00000000-0000-0000-0000-000000000000";
  const role = payload.role ?? "admin";

  if (!filePath || !existsSync(filePath)) {
    const err = "Sahnelenen dosya bulunamadı veya silinmiş.";
    await failJob(pool, jobId, err, jobActorId, true);
    return { jobId, success: false, error: err };
  }

  try {
    await reportProgress(pool, jobId, 10, 100);

    const buf = await readFile(filePath);
    await reportProgress(pool, jobId, 30, 100);

    const importRes = await confirmImport(pool, buf, filename, jobActorId, fileSha256, { role });

    if (!importRes.ok) {
      await failJob(pool, jobId, importRes.rejection.message, jobActorId, true);
      return { jobId, success: false, error: importRes.rejection.message };
    }

    await reportProgress(pool, jobId, 80, 100);

    // Başarılı import sonrası metrik özetlerini yenile
    await refreshMetricSnapshots(pool, jobActorId).catch(() => undefined);
    await reportProgress(pool, jobId, 100, 100);

    await completeJob(pool, jobId, jobActorId);

    // Geçici sahneleme dosyasını temizle
    await unlink(filePath).catch(() => undefined);

    return { jobId, success: true, outcome: importRes.outcome };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(pool, jobId, msg, jobActorId, false);
    return { jobId, success: false, error: msg };
  }
}

export async function getAsyncImportJobStatus(
  pool: Pool,
  jobId: string,
): Promise<{
  id: string;
  jobType: string;
  status: string;
  progressDone: number;
  progressTotal: number | null;
  progressPercent: number | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
} | null> {
  const res = await pool.query(
    `select id, job_type, status, progress_done, progress_total, last_error,
            to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') as created_at,
            to_char(finished_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI:SS') as finished_at
     from public.background_jobs
     where id = $1`,
    [jobId],
  );

  if (res.rowCount === 0) return null;
  const row = res.rows[0];

  const done = Number(row.progress_done);
  const total = row.progress_total == null ? null : Number(row.progress_total);
  const percent = total != null && total > 0 ? Math.round((done / total) * 100) : null;

  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    progressDone: done,
    progressTotal: total,
    progressPercent: percent,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? null,
  };
}
