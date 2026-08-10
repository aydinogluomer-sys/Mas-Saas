import { spawn } from "node:child_process";

const mode = process.argv.includes("--production") ? "start" : "dev";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", mode, "--port", "3103"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_testsprite",
    // Real login is now always required (P0-A) — no env toggle disables auth entirely
    // anymore, that class of footgun is exactly what P0-A closes. TestSprite instead gets
    // a narrowly-scoped bypass: both NODE_ENV!=="production" AND this flag must hold, and
    // it only works at all against a disposable DB that has seeded the one reserved,
    // is_active=false "testsprite-qa" row (scripts/db/sanitize-testsprite.sql, run by
    // scripts/db/create-testsprite-db.ts) — a real
    // dev/prod database never has that row, so leaving this flag on by accident anywhere
    // else fails closed, not open.
    MAS_QA_BYPASS_AUTH: "1",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
