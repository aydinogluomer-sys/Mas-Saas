// Version/build metadata. Exposes only non-sensitive provenance (name, version, commit,
// build time, runtime). NO secrets, NO env values, NO financial data.
import { NextResponse } from "next/server";
import pkg from "../../../package.json";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    name: pkg.name,
    version: pkg.version,
    commit: process.env.APP_COMMIT_SHA ?? "unknown",
    buildTime: process.env.APP_BUILD_TIME ?? "unknown",
    node: process.version,
    env: process.env.NODE_ENV ?? "unknown",
  });
}
