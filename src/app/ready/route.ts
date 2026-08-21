// Faz 16 — process-liveness probe. Deliberately the *opposite* end of the pair from /health:
//
//   /ready   this file. Touches nothing. 200 as long as the Node process can serve a
//            request at all. Never 503. A monitor watching this one is asking
//            "should I restart the process?"
//   /health  src/app/health/route.ts. Runs `select 1`. 200 when the DB is reachable,
//            503 when it is not. A monitor watching that one is asking
//            "should I send traffic here / page someone about the database?"
//
// Naming note, since the two words are used the other way round in some Kubernetes docs:
// here /ready is the cheap liveness signal and /health is the dependency-aware one. Wiring a
// restart policy to /health instead would reboot a perfectly healthy app every time
// PostgreSQL hiccups, which is exactly the failure this split exists to prevent.
//
// Returns no secrets and no financial data. Exempt from the login gate in src/middleware.ts —
// a probe that needs a password is not a probe.
import { NextResponse } from "next/server";
import { CORRELATION_HEADER, readOrCreateCorrelationId } from "@/lib/correlation";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = readOrCreateCorrelationId(request.headers);
  return NextResponse.json(
    { status: "ready", app: "up", time: new Date().toISOString() },
    { status: 200, headers: { [CORRELATION_HEADER]: requestId } },
  );
}
