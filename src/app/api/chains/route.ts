import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { runFinancialNervousSystemCheck } from "@/lib/chains";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSession();
    const pool = getPool();
    const report = await runFinancialNervousSystemCheck(pool);
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(req: Request) {
  try {
    await requireSession();
    const body = (await req.json().catch(() => ({}))) as {
      borrowingCostAnnual?: number;
      currentCashBalanceTRY?: number;
      safetyBufferTRY?: number;
    };

    const pool = getPool();
    const report = await runFinancialNervousSystemCheck(pool, body);
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 401 });
  }
}

