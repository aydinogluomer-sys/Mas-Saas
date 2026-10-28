import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { requireApiSession } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { istanbulDateISO } from "@/lib/reports/rules";
import { mutationIntent } from "@/lib/ai/rules";
import { parseSearchQuery } from "@/lib/search/nl";
import { groupHits, runSearch } from "@/lib/search/engine";

export const dynamic = "force-dynamic";

const querySchema = z.object({ q: z.string().trim().max(200) });

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    // Session first. The pool below is role-scoped per checkout (Faz 24B), so an unauthenticated
    // caller would see nothing anyway — but a search endpoint that answers strangers is a
    // reconnaissance tool, so it is refused outright. So is a user under a forced password change.
    const user = await requireApiSession();
    if (!user) return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });

    const parsed = querySchema.safeParse({ q: new URL(request.url).searchParams.get("q") ?? "" });
    if (!parsed.success) {
      return apiError(400, "Geçersiz sorgu.", { code: "bad_request", requestId });
    }

    // The same refusal ai/engine.ts applies: a query phrased as an instruction to change data is
    // not a search. Reused rather than reinvented — one definition of "this looks like a
    // mutation", in one place.
    if (mutationIntent(parsed.data.q)) {
      return NextResponse.json(
        {
          hits: [], groups: [], refused: true,
          message: "Arama yalnız okur. Veri değiştiren bir ifade arama olarak çalıştırılmaz.",
        },
        { headers: { [CORRELATION_HEADER]: requestId } });
    }

    const intent = parseSearchQuery(parsed.data.q, istanbulDateISO());
    // getPool(): the role-scoped pool. Search never gets a wider connection than the caller's own
    // tier — see src/lib/search/engine.ts.
    const outcome = await runSearch(getPool(), intent, 8);

    return NextResponse.json(
      {
        hits: outcome.hits,
        groups: groupHits(outcome.hits),
        intent: outcome.intent,
        truncated: outcome.truncated,
        refused: false,
      },
      { headers: { [CORRELATION_HEADER]: requestId } });
  });
}
