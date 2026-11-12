// Liveness/readiness probe. Confirms the app is running and PostgreSQL is reachable.
// Faz 40 (A2): Never leaks raw PG driver / network error messages in the response body.
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  let db: "up" | "down" = "down";
  try {
    await getPool().query("select 1");
    db = "up";
  } catch {
    db = "down";
  }
  const body = {
    status: db === "up" ? "ok" : "degraded",
    app: "up",
    db,
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: db === "up" ? 200 : 503 });
}
