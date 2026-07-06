// Liveness/readiness probe. Confirms the app is running and PostgreSQL is reachable.
// Returns NO financial data and NO secrets. 200 when healthy, 503 when the DB is down.
// Reachable even when the access gate is on (monitoring must not require the password).
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  let db: "up" | "down" = "down";
  let dbError: string | undefined;
  try {
    await getPool().query("select 1");
    db = "up";
  } catch (e) {
    dbError = (e as Error).message?.slice(0, 120); // generic driver message; no secrets/DSN
  }
  const body = {
    status: db === "up" ? "ok" : "degraded",
    app: "up",
    db,
    ...(dbError ? { dbError } : {}),
    latencyMs: Date.now() - startedAt,
    time: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: db === "up" ? 200 : 503 });
}
