import { createConnection } from "node:net";

const mode = process.argv.includes("--dev") ? "dev" : "start";
const requestedPort = Number(process.env.PORT || (mode === "dev" ? 3000 : 3000));
const ports = [...new Set([3000, 3001, requestedPort])];

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function main() {
  if (process.env.MAS_ALLOW_PARALLEL_RUNTIME === "1") return;
  const occupied = (await Promise.all(ports.map(async (port) => ({ port, listening: await isListening(port) }))))
    .filter((entry) => entry.listening)
    .map((entry) => entry.port);
  if (!occupied.length) return;
  throw new Error(
    `Başka bir MAS Next sunucusu çalışıyor (port: ${occupied.join(", ")}). ` +
    "Bellek baskısı ve 10+ saniyelik geçişleri önlemek için önce o terminalde Ctrl+C yapın. " +
    "Test amaçlı bilinçli paralel çalıştırma için MAS_ALLOW_PARALLEL_RUNTIME=1 kullanılabilir.",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
