import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export async function GET() {
  const today = istanbulDateISO();
  const facts = await loadDecisionFacts(getPool(), today);
  return NextResponse.json({ today, facts });
}
