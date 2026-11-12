/**
 * 8 GB RAM Windows ana makine ve CI için güvenli Next.js üretim derleme sarmalayıcısı (Faz 43 / B3).
 *
 * - `MAS_NEXT_CPUS` ortamda açıkça verilmemişse varsayılan olarak `"1"` atar (`next.config.ts`
 *   bunu okuyarak `experimental.cpus = 1` sınırını uygular ve paralel worker OOM riskini önler).
 * - `next build` alt sürecini `--max-old-space-size=4096` ile başlatır ve çıkış kodunu iletir.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const extraArgs = process.argv.slice(2);

const child = spawn(
  process.execPath,
  ["--max-old-space-size=4096", nextBin, "build", ...extraArgs],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      MAS_NEXT_CPUS: (process.env.MAS_NEXT_CPUS ?? "").trim() || "1",
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

