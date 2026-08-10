import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  // Real, DB-backed check — not just middleware's coarse cookie-presence gate, which can't
  // see revocation/expiry without a query. This route sat outside (dashboard) with zero
  // auth check at all until now; a 401 here (not a page redirect — this is a JSON API).
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const today = istanbulDateISO();
  const facts = await loadDecisionFacts(getPool(), today);
  return NextResponse.json({ today, facts });
}
