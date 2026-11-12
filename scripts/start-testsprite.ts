import { spawn } from "node:child_process";
import { readEnvLocal, swapDatabase } from "./db/app-url";
import { validateDisposableTargetDb } from "./db/disposable-guard";
import { resolveLocalOwnerUrl } from "./db/pg-local-admin";

const TARGET_DB = "mas_radar_testsprite";
const envLocal = readEnvLocal();
const baseAppUrl = process.env.MAS_TESTSPRITE_DATABASE_URL ?? envLocal.DATABASE_URL ?? resolveLocalOwnerUrl(TARGET_DB);
const targetAppUrl = swapDatabase(baseAppUrl, TARGET_DB);
const targetOwnerUrl = resolveLocalOwnerUrl(TARGET_DB);

validateDisposableTargetDb(
  { DATABASE_URL: targetAppUrl, MIGRATION_DATABASE_URL: targetOwnerUrl },
  ["DATABASE_URL", "MIGRATION_DATABASE_URL"],
  "start-testsprite",
);

const isProduction = process.argv.includes("--production");
const childArgs = isProduction
  ? ["--import", "tsx", "scripts/ops/start-standalone.ts", "--port", "3103"]
  : ["node_modules/next/dist/bin/next", "dev", "--port", "3103"];

const child = spawn(process.execPath, childArgs, {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: targetAppUrl,
    MIGRATION_DATABASE_URL: targetOwnerUrl,
    MAS_QA_BYPASS_AUTH: "1",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
