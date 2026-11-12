import * as nextEnvNs from "@next/env";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const loadEnvConfig: typeof nextEnvNs.loadEnvConfig =
  nextEnvNs.loadEnvConfig ??
  (nextEnvNs as unknown as { default: typeof nextEnvNs }).default.loadEnvConfig;

export interface StandaloneLayout {
  projectRoot: string;
  distDir: string;
  distPath: string;
  standaloneDir: string;
  serverEntry: string;
  requiredServerFiles: string;
  minimalRunnerEntry: string;
  sourceStaticDir: string;
  targetStaticDir: string;
  sourcePublicDir: string;
  targetPublicDir: string;
}

export type ProductionLaunchMode = "standalone-dir" | "minimal-in-place";

export function resolveDistDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = (env.MAS_NEXT_DIST_DIR ?? "").trim();
  return raw === "" ? ".next" : raw;
}

export function resolveStandaloneLayout(
  projectRoot: string,
  distDir = ".next",
): StandaloneLayout {
  const distPath = path.resolve(projectRoot, distDir);
  const standaloneDir = path.join(distPath, "standalone");
  const normalizedRelDist = path.relative(projectRoot, distPath) || ".next";

  return {
    projectRoot,
    distDir,
    distPath,
    standaloneDir,
    serverEntry: path.join(standaloneDir, "server.js"),
    requiredServerFiles: path.join(distPath, "required-server-files.json"),
    minimalRunnerEntry: path.join(projectRoot, "scripts", "ops", "minimal-next-server.mjs"),
    sourceStaticDir: path.join(distPath, "static"),
    targetStaticDir: path.join(standaloneDir, normalizedRelDist, "static"),
    sourcePublicDir: path.join(projectRoot, "public"),
    targetPublicDir: path.join(standaloneDir, "public"),
  };
}

export function resolveLaunchMode(layout: StandaloneLayout): ProductionLaunchMode {
  if (existsSync(layout.serverEntry)) {
    return "standalone-dir";
  }
  if (existsSync(layout.requiredServerFiles)) {
    return "minimal-in-place";
  }
  throw new Error(
    `Üretim derlemesi bulunamadı (${layout.requiredServerFiles}). Önce 'pnpm build' çalıştırın.`,
  );
}

export function prepareStandaloneAssets(
  layout: StandaloneLayout,
): { mode: ProductionLaunchMode; staticCopied: boolean; publicCopied: boolean } {
  const mode = resolveLaunchMode(layout);
  if (mode === "minimal-in-place") {
    // Yerinde minimal mod doğrudan <distDir>/static ve <projectRoot>/public dizinlerini okur;
    // dosya veya sembolik bağ kopyalaması gerekmez.
    return { mode, staticCopied: false, publicCopied: false };
  }

  let staticCopied = false;
  if (existsSync(layout.sourceStaticDir)) {
    cpSync(layout.sourceStaticDir, layout.targetStaticDir, {
      recursive: true,
      force: true,
    });
    staticCopied = true;
  }

  let publicCopied = false;
  if (existsSync(layout.sourcePublicDir)) {
    cpSync(layout.sourcePublicDir, layout.targetPublicDir, {
      recursive: true,
      force: true,
    });
    publicCopied = true;
  }

  return { mode, staticCopied, publicCopied };
}

export function resolveRuntimeBind(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): { hostname: string; port: string } {
  let port = (env.PORT ?? "").trim() || "3000";
  let hostname = (env.HOSTNAME ?? "").trim() || "127.0.0.1";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) {
      port = argv[i + 1]!;
      i++;
    } else if ((arg === "--hostname" || arg === "-H") && argv[i + 1]) {
      hostname = argv[i + 1]!;
      i++;
    }
  }

  return { hostname, port };
}

async function runCli(): Promise<void> {
  const projectRoot = process.cwd();
  // @next/env yalnız process.env'de henüz TANIMLI OLMAYAN değişkenleri .env.local'dan yükler;
  // böylece klon/drill kapılarının açıkça verdiği DATABASE_URL ve PORT her zaman kazanır.
  loadEnvConfig(projectRoot, false);

  const distDir = resolveDistDir(process.env);
  const layout = resolveStandaloneLayout(projectRoot, distDir);
  const { mode } = prepareStandaloneAssets(layout);
  const { hostname, port } = resolveRuntimeBind(process.argv.slice(2), process.env);

  const entryScript =
    mode === "standalone-dir" ? layout.serverEntry : layout.minimalRunnerEntry;
  const targetCwd =
    mode === "standalone-dir" ? layout.standaloneDir : projectRoot;

  // Faz 43 (B3): İkinci bir alt Node süreci ve boşta bekleyen üst tsx/sarmalayıcı süreci tutmak
  // yerine ortam değişkenlerini ve çalışma dizinini hazırlayıp doğrudan aynı Node sürecinde
  // minimal/standalone sunucuya devreder (~60 MB RAM tasarrufu + Windows'ta yetim alt süreç sıfır).
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.HOSTNAME = hostname;
  process.env.PORT = port;
  process.env.MAS_PROJECT_ROOT = projectRoot;
  process.env.MAS_REQUIRED_SERVER_FILES = layout.requiredServerFiles;
  process.chdir(targetCwd);

  await import(pathToFileURL(entryScript).href);
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  runCli().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
