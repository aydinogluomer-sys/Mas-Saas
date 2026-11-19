import { NextResponse } from "next/server";
import { apiError, withApiHandler } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { loadReport } from "@/lib/reports/engine";
import {
  buildBoardPackExcelBuffer,
  isBoardFinancialPackage,
  loadBoardFinancialPackage,
  renderExecutiveReportHtml,
  renderReportCsv,
  type BoardFinancialPackage,
  type ReportProvenance,
} from "@/lib/reports/board-pack";

export const dynamic = "force-dynamic";

function resolveFrozenSnapshot(meta: Record<string, unknown> | null): BoardFinancialPackage | null {
  if (!meta || typeof meta !== "object") return null;
  const rawSnapshot = meta.snapshot;
  const rawProvenance =
    meta.provenance && typeof meta.provenance === "object"
      ? (meta.provenance as ReportProvenance)
      : undefined;

  if (isBoardFinancialPackage(rawSnapshot)) {
    return rawProvenance && !rawSnapshot.provenance
      ? { ...rawSnapshot, provenance: rawProvenance }
      : rawSnapshot;
  }

  if (
    rawSnapshot &&
    typeof rawSnapshot === "object" &&
    "boardPack" in rawSnapshot &&
    isBoardFinancialPackage((rawSnapshot as { boardPack?: unknown }).boardPack)
  ) {
    const inner = (rawSnapshot as { boardPack: BoardFinancialPackage }).boardPack;
    return rawProvenance && !inner.provenance ? { ...inner, provenance: rawProvenance } : inner;
  }

  return null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ reportId: string }> },
): Promise<NextResponse> {
  return withApiHandler(request, async ({ requestId }) => {
    const session = await requireApiSession();
    if (!session) {
      return apiError(401, "Oturum gerekli.", { code: "UNAUTHORIZED", requestId });
    }
    if (!can(session.role, "reports", "select")) {
      return apiError(403, "Rapor dışa aktarma yetkiniz yok.", { code: "FORBIDDEN", requestId });
    }

    const { reportId } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(reportId)) {
      return apiError(400, "Geçersiz rapor kimliği.", { code: "INVALID_ID", requestId });
    }

    const pool = getPool();
    const report = await loadReport(pool, reportId);
    if (!report) {
      return apiError(404, "Rapor bulunamadı.", { code: "NOT_FOUND", requestId });
    }

    const url = new URL(request.url);
    const format = (url.searchParams.get("format") ?? "xlsx").toLowerCase();
    const autoPrint = url.searchParams.get("print") === "1";

    const storedSnapshot = resolveFrozenSnapshot(report.meta);
    const rawPack = storedSnapshot ?? (await loadBoardFinancialPackage(pool, report.period_end));
    const storedProvenance =
      report.meta && typeof report.meta === "object" && report.meta.provenance && typeof report.meta.provenance === "object"
        ? (report.meta.provenance as ReportProvenance)
        : undefined;
    const pack: BoardFinancialPackage =
      storedProvenance && !rawPack.provenance
        ? { ...rawPack, provenance: storedProvenance }
        : rawPack;

    const safeBase = `mas_finansal_paket_${report.report_type}_${report.period_end}`;
    const commonHeaders: Record<string, string> = {
      "Cache-Control": "private, no-store",
      "X-Snapshot-Source": storedSnapshot ? "frozen" : "reconstructed-as-of",
      ...(pack.provenance?.snapshotId ? { "X-Snapshot-Id": pack.provenance.snapshotId } : {}),
    };

    if (format === "html" || format === "pdf") {
      const html = renderExecutiveReportHtml(report, pack, autoPrint || format === "pdf");
      return new NextResponse(html, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    }

    if (format === "csv") {
      const csv = renderReportCsv(pack);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          ...commonHeaders,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeBase}.csv"`,
        },
      });
    }

    const xlsxBuf = await buildBoardPackExcelBuffer(report, pack);
    return new NextResponse(new Uint8Array(xlsxBuf), {
      status: 200,
      headers: {
        ...commonHeaders,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safeBase}.xlsx"`,
      },
    });
  });
}
