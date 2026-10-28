import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { requireApiSession } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    // Rate limiting for /api/* lives in src/middleware.ts, deliberately not here: middleware
    // runs before the cookie gate, so a flood is refused with a 429 instead of first being
    // redirected to the login page. Keeping a second counter in this handler would only split
    // the same budget across two buckets and make the effective limit harder to reason about.

    // Real, DB-backed check — not just middleware's coarse cookie-presence gate, which can't
    // see revocation/expiry without a query. This route sat outside (dashboard) with zero
    // auth check at all until now; a 401 here (not a page redirect — this is a JSON API).
    // requireApiSession() also refuses a user under a forced password change (Wave 0).
    const user = await requireApiSession();
    if (!user) return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });

    const today = istanbulDateISO();
    const facts = await loadDecisionFacts(getPool(), today);
    return NextResponse.json({ today, facts }, { headers: { [CORRELATION_HEADER]: requestId } });
  });
}
