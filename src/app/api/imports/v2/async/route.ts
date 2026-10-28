import { NextResponse } from "next/server";
import { apiError, withApiHandler } from "@/lib/api-response";
import { requireSession } from "@/lib/auth";
import { canPerform } from "@/lib/authz/matrix";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool } from "@/lib/db";
import {
  enqueueAsyncWorkbookImport, getAsyncImportJobStatus,
} from "@/lib/importers/v2/async-runner";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await requireSession().catch(() => null);
    if (!user) {
      return apiError(401, "Oturum açmanız gerekiyor.", { code: "unauthorized", requestId });
    }

    if (!canPerform(user.role, "import_workbook_v2")) {
      return apiError(403, "Bu oturumun katmanı içe aktarma yapamaz.", {
        code: "forbidden",
        requestId,
      });
    }

    const formData = await request.formData().catch(() => null);
    if (!formData) {
      return apiError(400, "Geçersiz form verisi.", { code: "bad_request", requestId });
    }

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return apiError(400, "Dosya seçilmedi veya dosya boş.", { code: "empty_file", requestId });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const pool = getPool();

    const enq = await enqueueAsyncWorkbookImport(
      pool,
      buf,
      file.name.trim(),
      user.id,
      user.role,
    );

    if (!enq.ok) {
      const msg = enq.rejection.detail
        ? `${enq.rejection.message} (${enq.rejection.detail})`
        : enq.rejection.message;
      return apiError(400, msg, {
        code: enq.rejection.code,
        requestId,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Dosya arka plan işlem kuyruğuna alındı.",
        job: enq.result,
      },
      {
        status: 202,
        headers: { [CORRELATION_HEADER]: requestId },
      },
    );
  });
}

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await requireSession().catch(() => null);
    if (!user) {
      return apiError(401, "Oturum açmanız gerekiyor.", { code: "unauthorized", requestId });
    }

    const url = new URL(request.url);
    const jobId = url.searchParams.get("jobId")?.trim();
    if (!jobId) {
      return apiError(400, "jobId parametresi zorunlu.", { code: "bad_request", requestId });
    }

    const job = await getAsyncImportJobStatus(getPool(), jobId);
    if (!job) {
      return apiError(404, "Kuyruk işi bulunamadı.", { code: "not_found", requestId });
    }

    return NextResponse.json(
      { ok: true, job },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
