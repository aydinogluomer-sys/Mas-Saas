// AŞAMA 10 & Faz 40 (A2) — route-level DB query accounting probe.
//
// Security boundaries:
//   1. Returns 404 when `MAS_PERF_PROBE !== "1"` OR when `NODE_ENV === "production"` without
//      the explicit harness opt-in `MAS_ALLOW_PROD_PERF_PROBE === "1"`.
//   2. Requires a live DB-verified session (`requireApiSession()`), wrapped in
//      `withoutProbeCounting` so the probe's own session check never pollutes measured queryCount.

import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { armProbe, readAndResetProbe, withoutProbeCounting } from "@/lib/perf/request-metrics";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const blockedInProd =
    process.env.NODE_ENV === "production" && process.env.MAS_ALLOW_PROD_PERF_PROBE !== "1";
  if (!env.perfProbeEnabled || blockedInProd) {
    return NextResponse.json(
      { error: { message: "Bulunamadı.", code: "not_found" } },
      { status: 404 },
    );
  }
  const user = await withoutProbeCounting(() => requireApiSession());
  if (!user) {
    return NextResponse.json(
      { error: { message: "Yetkisiz.", code: "unauthorized" } },
      { status: 401 },
    );
  }
  armProbe();
  const metrics = readAndResetProbe();
  return NextResponse.json({
    armed: true,
    queryCount: metrics.queryCount,
    totalDbTimeMs: metrics.totalDbTimeMs,
    slowestQueryMs: metrics.slowestQueryMs,
    slowestQueryShape: metrics.slowestQueryShape,
  });
}
