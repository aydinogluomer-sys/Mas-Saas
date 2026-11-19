import { NextResponse } from "next/server";
import { apiError, withApiHandler } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { loadVerifiedDocumentDownload } from "@/lib/documents/engine";
import { loadJobWithResult } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await requireApiSession();
    if (!user) {
      return apiError(401, "Oturum gerekli.", { code: "UNAUTHORIZED", requestId });
    }
    if (!can(user.role, "background_jobs", "select")) {
      return apiError(403, "Bu iş çıktısına erişim yetkiniz yok.", {
        code: "FORBIDDEN",
        requestId,
      });
    }

    const { jobId } = await context.params;
    if (!UUID_RE.test(jobId)) {
      return apiError(400, "Geçersiz iş kimliği.", { code: "VALIDATION", requestId });
    }

    const pool = getPool();
    const job = await loadJobWithResult(pool, jobId);
    if (!job) {
      return apiError(404, "Arka plan işi bulunamadı.", { code: "NOT_FOUND", requestId });
    }

    const maybeCreatedBy = (job as unknown as { createdBy?: unknown }).createdBy;
    let createdBy: string | null = typeof maybeCreatedBy === "string" ? maybeCreatedBy : null;
    let artifactDocId: string | null = job.artifactDocumentId ?? null;
    try {
      const metaRes = await pool.query<{
        created_by: string | null;
        artifact_document_id: string | null;
      }>(
        `select created_by::text as created_by, artifact_document_id::text as artifact_document_id
           from public.background_jobs
          where id = $1`,
        [jobId],
      );
      if ((metaRes.rowCount ?? 0) > 0) {
        createdBy = metaRes.rows[0]?.created_by ?? createdBy;
        artifactDocId = metaRes.rows[0]?.artifact_document_id ?? artifactDocId;
      }
    } catch {
      try {
        const ownerRes = await pool.query<{ created_by: string | null }>(
          `select created_by::text as created_by from public.background_jobs where id = $1`,
          [jobId],
        );
        if ((ownerRes.rowCount ?? 0) > 0) {
          createdBy = ownerRes.rows[0]?.created_by ?? createdBy;
        }
      } catch {
        // Keep fallback values from loadJobWithResult when mocked in unit tests
      }
    }

    const canInspectAllJobs = user.role === "admin" || user.role === "finance_manager";
    if (!canInspectAllJobs && (!createdBy || createdBy !== user.id)) {
      return apiError(
        403,
        "Yalnızca kendi başlattığınız arka plan işlerinin çıktılarını indirebilirsiniz.",
        { code: "FORBIDDEN", requestId },
      );
    }

    if (!artifactDocId && typeof job.result?.artifactDocumentId === "string") {
      artifactDocId = job.result.artifactDocumentId;
    }

    if (artifactDocId && UUID_RE.test(artifactDocId)) {
      try {
        const verified = await loadVerifiedDocumentDownload(pool, artifactDocId);
        return new NextResponse(new Uint8Array(verified.bytes), {
          status: 200,
          headers: {
            "Content-Type": verified.mimeType || "application/octet-stream",
            "Content-Disposition": `attachment; filename="${verified.originalFilename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            "X-Content-SHA256": verified.sha256,
            "Cache-Control": "no-store",
          },
        });
      } catch {
        // Fall through to inlineBase64 if CAS file was pruned
      }
    }

    const inlineBase64 =
      typeof job.result?.inlineBase64 === "string" ? job.result.inlineBase64 : null;
    if (inlineBase64) {
      const format = job.result?.format === "xlsx" ? "xlsx" : "csv";
      const dataset = typeof job.result?.dataset === "string" ? job.result.dataset : "export";
      const bytes = Buffer.from(inlineBase64, "base64");
      const mime =
        format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv; charset=utf-8";
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${dataset}-${jobId.slice(0, 8)}.${format}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return apiError(404, "Bu iş için indirilebilir bir çıktı dosyası bulunmuyor.", {
      code: "NOT_FOUND",
      requestId,
    });
  });
}

