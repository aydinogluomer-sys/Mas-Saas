// Standart Import V2 — asenkron ÖNİZLEME uç noktası (Wave 0 / R8).
//
// POST dosyayı sahneler ve bir önizleme işi kuyruğa alır (202); GET işin durumunu ve işçi
// bitirdiyse saklanan önizleme raporunu döndürür. Hiçbir yol finansal kayıt YAZMAZ: onay,
// /data/imports/v2'deki senkron akışta (dosya yeniden yüklenir, önizleme SHA'sı eşleşmek
// zorunda) kalır. Gerekçe: src/lib/importers/v2/async-runner.ts başlığı.
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, checkOrigin, withApiHandler } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { canPerform } from "@/lib/authz/matrix";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { getPool } from "@/lib/db";
import {
  enqueueAsyncWorkbookPreview, getAsyncPreviewJobStatus,
} from "@/lib/importers/v2/async-runner";
import { validateUploadMeta } from "@/lib/importers/v2/service";

export const dynamic = "force-dynamic";

/** `background_jobs.id` bir uuid; başka bir şey veritabanına hiç gitmez (eskiden pg hatası → 500). */
const jobIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export async function POST(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    // Wave 0: the browser-callable mutating route handler, so the Origin gate comes FIRST — it
    // needs no database, and a forged cross-site upload is refused before the session table is
    // even read. SameSite=Lax on the session cookie already blocks most cross-site POSTs; this is
    // the explicit check api-response.ts documents for every mutating route handler.
    const forbidden = checkOrigin(request, requestId);
    if (forbidden) return forbidden;

    // requireApiSession, not requireSession().catch(() => null): the latter turned every failure
    // (a database outage included) into a 401. A user under a forced password change gets 401.
    const user = await requireApiSession();
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

    // Ad/uzantı/boyut baytlar belleğe alınmadan ÖNCE — senkron akışla aynı kapı (actions.ts
    // readFile): 50 MB üstü ya da .xlsx olmayan dosya arrayBuffer()'a hiç ulaşmaz.
    const meta = validateUploadMeta({ name: file.name, size: file.size });
    if (meta) {
      return apiError(400, meta.detail ? `${meta.message} (${meta.detail})` : meta.message, {
        code: meta.code,
        requestId,
      });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const enq = await enqueueAsyncWorkbookPreview(getPool(), buf, file.name.trim(), user.id);

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
        message:
          "Dosya önizleme kuyruğuna alındı. Önizleme hiçbir kayıt yazmaz; içe aktarmak için raporu " +
          "inceleyip dosyayı Standart içe aktarım (V2) sayfasından onaylayın.",
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
    const user = await requireApiSession();
    if (!user) {
      return apiError(401, "Oturum açmanız gerekiyor.", { code: "unauthorized", requestId });
    }

    // Raporu yalnız içe aktarabilen katmanlar okur — POST ile aynı kapı.
    if (!canPerform(user.role, "import_workbook_v2")) {
      return apiError(403, "Bu oturumun katmanı içe aktarma yapamaz.", { code: "forbidden", requestId });
    }

    const url = new URL(request.url);
    const jobId = jobIdSchema.safeParse(url.searchParams.get("jobId")?.trim() ?? "");
    if (!jobId.success) {
      return apiError(400, "jobId parametresi zorunlu ve bir iş kimliği (uuid) olmalı.", {
        code: "bad_request",
        requestId,
      });
    }

    // Kendi işi; finans yöneticisi ve yönetici herkesinkini görür. Başkasının işi ile var olmayan
    // iş aynı 404'ü alır — kimlik numarasıyla başka kullanıcıların geçmişi yoklanamaz.
    const seeAll = user.role === "finance_manager" || user.role === "admin";
    const job = await getAsyncPreviewJobStatus(getPool(), jobId.data, { id: user.id, seeAll });
    if (!job) {
      return apiError(404, "Kuyruk işi bulunamadı.", { code: "not_found", requestId });
    }

    return NextResponse.json(
      { ok: true, job },
      { headers: { [CORRELATION_HEADER]: requestId } },
    );
  });
}
