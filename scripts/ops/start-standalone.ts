import * as nextEnvNs from "@next/env";
import { cpSync, existsSync } from "node:fs";
import http from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
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

const HTML_STATIC_ASYNC_SCRIPT_RE =
  /(<script\b[^>]*\bsrc="\/_next\/static\/[^"]+"[^>]*)\basync=""/g;

/**
 * Prevents Blink/Chromium HTML tokenizer mid-document yields on large SSR pages (150–300 KB)
 * from firing cached `<script src="/_next/static/..." async="">` (`hydrateRoot`) before inline
 * React Fizz `$RS(...)` / `$RC(...)` segment-completion scripts at the tail of `<body>` have parsed.
 * Rewriting `async=""` (8 bytes) -> `defer=""` (8 bytes) on `/_next/static/` script tags preserves
 * parallel script preloading while guaranteeing per HTML5 §4.12.1 that `hydrateRoot` runs only
 * after the full document and all inline Fizz scripts have executed.
 */
export function installDeterministicHtmlHydrationGuard(): void {
  const cjsRequire = createRequire(import.meta.url);
  const cjsHttp = cjsRequire("node:http") as typeof http;
  const origCreateServer = cjsHttp.createServer.bind(cjsHttp);
  const patchedCreateServer = function patchedCreateServer(
    ...args: Parameters<typeof http.createServer>
  ): ReturnType<typeof http.createServer> {
    const listenerIdx = args.findIndex((a) => typeof a === "function");
    if (listenerIdx === -1) {
      return (origCreateServer as (...a: unknown[]) => http.Server)(...args);
    }
    const origListener = args[listenerIdx] as http.RequestListener;
    const wrappedListener: http.RequestListener = (req, res) => {
      const url = req.url ?? "";
      const accept = String(req.headers["accept"] ?? "");
      const isCandidateHtmlGet =
        req.method === "GET" &&
        !url.startsWith("/_next/") &&
        !url.startsWith("/api/") &&
        url !== "/ready" &&
        url !== "/health" &&
        url !== "/version" &&
        !req.headers["rsc"] &&
        !req.headers["next-action"] &&
        (accept.includes("text/html") || accept.includes("*/*") || accept === "");

      if (isCandidateHtmlGet) {
        req.headers["accept-encoding"] = "identity";
        let decided = false;
        let bufferHtml = false;
        const bufferedChunks: Buffer[] = [];
        let inspectedStatus = 200;
        let inspectedHeaderCt: string | undefined;

        const origWriteHead = res.writeHead.bind(res);
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        const decideMode = (): boolean => {
          if (decided) return bufferHtml;
          decided = true;
          const ct = String(
            inspectedHeaderCt ?? res.getHeader("content-type") ?? "",
          ).toLowerCase();
          bufferHtml =
            inspectedStatus >= 200 &&
            inspectedStatus < 300 &&
            ct.startsWith("text/html");
          return bufferHtml;
        };

        res.writeHead = function patchedWriteHead(
          statusCode: number,
          ...rest: unknown[]
        ): http.ServerResponse {
          inspectedStatus = statusCode;
          const maybeHeaders =
            typeof rest[0] === "object" && rest[0] !== null
              ? (rest[0] as http.OutgoingHttpHeaders)
              : typeof rest[1] === "object" && rest[1] !== null
                ? (rest[1] as http.OutgoingHttpHeaders)
                : undefined;
          if (maybeHeaders) {
            for (const [k, v] of Object.entries(maybeHeaders)) {
              if (k.toLowerCase() === "content-type" && v != null) {
                inspectedHeaderCt = Array.isArray(v) ? v.join("; ") : String(v);
              }
            }
          }
          return (origWriteHead as (...a: unknown[]) => http.ServerResponse)(
            statusCode,
            ...rest,
          );
        } as typeof res.writeHead;

        res.write = function patchedWrite(
          chunk: unknown,
          ...rest: unknown[]
        ): boolean {
          if (decideMode() && chunk != null) {
            const enc =
              typeof rest[0] === "string"
                ? (rest[0] as BufferEncoding)
                : "utf8";
            bufferedChunks.push(
              Buffer.isBuffer(chunk)
                ? chunk
                : chunk instanceof Uint8Array
                  ? Buffer.from(chunk)
                  : Buffer.from(String(chunk), enc),
            );
            const maybeCb = rest.find((r) => typeof r === "function") as
              | ((err?: Error | null) => void)
              | undefined;
            if (maybeCb) maybeCb(null);
            return true;
          }
          return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
        } as typeof res.write;

        res.end = function patchedEnd(
          ...rest: unknown[]
        ): http.ServerResponse {
          const first = rest[0];
          const hasChunk = first !== undefined && typeof first !== "function";
          if (decideMode()) {
            if (hasChunk && first != null) {
              const enc =
                typeof rest[1] === "string"
                  ? (rest[1] as BufferEncoding)
                  : "utf8";
              bufferedChunks.push(
                Buffer.isBuffer(first)
                  ? first
                  : first instanceof Uint8Array
                    ? Buffer.from(first)
                    : Buffer.from(String(first), enc),
              );
            }
            const cb = rest.find((r) => typeof r === "function") as
              | (() => void)
              | undefined;
            const fullHtml = Buffer.concat(bufferedChunks).toString("utf8");
            const deferredHtml = fullHtml.replace(
              HTML_STATIC_ASYNC_SCRIPT_RE,
              '$1defer=""',
            );
            const outBuf = Buffer.from(deferredHtml, "utf8");
            return cb ? origEnd(outBuf, cb) : origEnd(outBuf);
          }
          return (origEnd as (...a: unknown[]) => http.ServerResponse)(...rest);
        } as typeof res.end;
      }

      return origListener(req, res);
    };
    const nextArgs = [...args] as Parameters<typeof http.createServer>;
    nextArgs[listenerIdx] = wrappedListener as never;
    return (origCreateServer as (...a: unknown[]) => http.Server)(...nextArgs);
  } as typeof http.createServer;
  cjsHttp.createServer = patchedCreateServer;
  http.createServer = patchedCreateServer;
  syncBuiltinESMExports();
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

  installDeterministicHtmlHydrationGuard();
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
