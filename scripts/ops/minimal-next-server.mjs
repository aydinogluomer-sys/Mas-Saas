// Saf Node.js minimal Next.js üretim sunucusu başlatıcısı (tsx/TypeScript/Webpack yüklemez).
// Next.js'in kendi standalone/server.js şablonuyla (next/dist/build/utils.js) birebir aynı
// __NEXT_PRIVATE_STANDALONE_CONFIG + startServer yolunu izler; Windows + pnpm üzerinde
// sembolik bağ kopyalamasına ihtiyaç duymadan aynı düşük bellek ayak izini sağlar.
import nextEnv from "@next/env";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = nextEnv;

const projectRoot = process.env.MAS_PROJECT_ROOT || process.cwd();
const manifestPath =
  process.env.MAS_REQUIRED_SERVER_FILES ||
  path.join(projectRoot, ".next", "required-server-files.json");

process.env.NODE_ENV = "production";
process.chdir(projectRoot);
loadEnvConfig(projectRoot, false);

const currentPort = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
const hostname = process.env.HOSTNAME || "127.0.0.1";
const rawKeepAlive = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT ?? "", 10);
const keepAliveTimeout =
  Number.isNaN(rawKeepAlive) || !Number.isFinite(rawKeepAlive) || rawKeepAlive < 0
    ? undefined
    : rawKeepAlive;

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const nextConfig = manifest.config;

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require("next");
const { startServer } = require("next/dist/server/lib/start-server");

startServer({
  dir: projectRoot,
  isDev: false,
  config: nextConfig,
  hostname,
  port: currentPort,
  allowRetry: false,
  keepAliveTimeout,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
