import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import {
  buildCpaReconciliationPackBuffer,
  loadReconciliationRun,
} from "@/lib/ledger/trial-balance-bridge";

export async function GET(
  _req: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const user = await requireApiSession();
  if (!user) {
    return NextResponse.json({ error: "Oturum gerekli." }, { status: 401 });
  }
  if (!can(user.role, "trial_balance_reconciliation_runs", "select")) {
    return NextResponse.json({ error: "Dışa aktarma yetkiniz yok." }, { status: 403 });
  }

  const { runId } = await context.params;
  const summary = await loadReconciliationRun(getPool(), runId);
  if (!summary) {
    return NextResponse.json({ error: "Mutabakat koşusu bulunamadı." }, { status: 404 });
  }

  const buf = await buildCpaReconciliationPackBuffer(summary);
  const safePeriod = summary.periodLabel.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filename = `mali_musavir_mutabakat_paketi_${safePeriod}_${summary.asOfDate}.xlsx`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

