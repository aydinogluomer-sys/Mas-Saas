// Version/build metadata. Exposes only non-sensitive provenance (name, version, commit,
// build time, runtime). NO secrets, NO env values, NO financial data.
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    name: pkg.name,
    version: pkg.version,
    commit: env.appCommitSha,
    buildTime: env.appBuildTime,
    node: process.version,
    // NODE_ENV stays a direct read — Next.js inlines it at build time.
    env: process.env.NODE_ENV ?? "unknown",
  });
}
