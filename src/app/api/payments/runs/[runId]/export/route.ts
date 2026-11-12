import { NextResponse } from "next/server";
import { apiError, withApiHandler } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import {
  PAYMENT_RUN_EXPORT_FORMATS,
  exportPaymentRun,
  type PaymentRunExportFormat,
} from "@/lib/payments/bank-export";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  return withApiHandler(request, async ({ requestId }) => {
    const auth = await requireApiSession();
    if (!auth) {
      return apiError(401, "Oturum açmanız gerekiyor.", { code: "UNAUTHORIZED", requestId });
    }

    // Exporting updates `exported_at`, `exported_format`, `exported_hash` and `status -> exported`,
    // so the caller must hold `update` permission on `payment_runs` (operator / manager / admin).
    if (!can(auth.role, "payment_runs", "update")) {
      return apiError(403, "Ödeme paketi banka dosyası ihraç etme yetkiniz yok.", {
        code: "FORBIDDEN",
        requestId,
      });
    }

    const { runId } = await context.params;
    const url = new URL(request.url);
    const rawFormat = (url.searchParams.get("format") ?? "pain001").trim();
    const format: PaymentRunExportFormat = (PAYMENT_RUN_EXPORT_FORMATS as readonly string[]).includes(rawFormat)
      ? (rawFormat as PaymentRunExportFormat)
      : "pain001";

    const artifact = await exportPaymentRun(
      getPool(),
      { runId, format },
      auth.id,
    );

    return new NextResponse(new Uint8Array(artifact.buffer), {
      status: 200,
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Cache-Control": "no-store",
        "X-Export-Sha256": artifact.sha256,
      },
    });
  });
}
