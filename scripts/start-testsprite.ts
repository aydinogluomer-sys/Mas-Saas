import { spawn } from "node:child_process";

const mode = process.argv.includes("--production") ? "start" : "dev";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", mode, "--port", "3103"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_testsprite",
    APP_ACCESS_PASSWORD: "",
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
