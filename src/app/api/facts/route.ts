import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { scopeFactsForRole } from "@/lib/assistant/visibility";
import { istanbulDateISO } from "@/lib/reports/rules";
import { requireApiSession } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await requireApiSession();
    if (!user) return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });

    const today = istanbulDateISO();
    const allFacts = await loadDecisionFacts(getPool(), today);
    const facts = scopeFactsForRole(user.role, allFacts).visible;
    return NextResponse.json({ today, facts }, { headers: { [CORRELATION_HEADER]: requestId } });
  });
}
