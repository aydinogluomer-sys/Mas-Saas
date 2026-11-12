import * as nextEnvNs from "@next/env";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";

const loadEnvConfig: typeof nextEnvNs.loadEnvConfig =
  nextEnvNs.loadEnvConfig ??
  (nextEnvNs as unknown as { default: typeof nextEnvNs }).default.loadEnvConfig;

export function resolveGuardedPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number[] {
  const raw = Number.parseInt((env.PORT ?? "").trim(), 10);
  const requestedPort = Number.isFinite(raw) && raw > 0 && raw <= 65535 ? raw : 3000;
  // Faz 43 (B3): Sabit [3000, 3001] yerine YALNIZ istenen PORT denetlenir; böylece 3000 üzerinde
  // üretim sunucusu açıkken 3210 üzerinde izole doğrulama/E2E sunucusu çakışmadan çalışabilir.
  return [requestedPort];
}

export function isListening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd(), false);
  if (process.env.MAS_ALLOW_PARALLEL_RUNTIME === "1") return;
  const ports = resolveGuardedPorts(process.env);
  const occupied = (
    await Promise.all(ports.map(async (port) => ({ port, listening: await isListening(port) })))
  )
    .filter((entry) => entry.listening)
    .map((entry) => entry.port);
  if (!occupied.length) return;
  throw new Error(
    `İstenen port üzerinde zaten bir sunucu dinliyor (port: ${occupied.join(", ")}). ` +
      "Bellek baskısı ve port çakışmasını önlemek için önce mevcut sunucuyu kapatın veya farklı bir PORT verin. " +
      "Test amaçlı bilinçli paralel çalıştırma için MAS_ALLOW_PARALLEL_RUNTIME=1 kullanılabilir.",
  );
}

const isDirectEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
