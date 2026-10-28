import { execFileSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const CONTAINER = "mas-radar-pg";

function docker(args: string[], quiet = false): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Docker komutu başarısız: docker ${args.join(" ")}\n${detail}`);
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (process.env.MAS_SKIP_DB_ENSURE === "1" || (dbUrl && !dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1"))) {
    console.log("Harici/Supabase veritabanı aktif, yerel Docker kontrolü atlanıyor.");
    return;
  }

try {
  const all = docker(["ps", "-a", "--format", "{{.Names}}"], true).split(/\r?\n/);
  if (!all.includes(CONTAINER)) {
    console.log("PostgreSQL konteyneri oluşturuluyor…");
    docker([
      "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1:5432:5432", "postgres:16",
    ], true);
  }

  const running = docker(["ps", "--format", "{{.Names}}"], true).split(/\r?\n/);
  if (!running.includes(CONTAINER)) {
    console.log("PostgreSQL konteyneri başlatılıyor…");
    docker(["start", CONTAINER], true);
  }

  // Readiness probe MUST go over TCP (-h 127.0.0.1), NOT the default unix socket. The
  // postgres:16 image runs a TEMPORARY server during initdb that listens on the container's
  // unix socket only (listen_addresses=''), so its own setup scripts can reach it while
  // external clients cannot. A socket-based `pg_isready` answers TRUE against that temp server,
  // then the image stops it to start the real one — and in that gap the socket file is deleted.
  // A caller that raced in on that false-positive hits "connection to server on socket ...
  // No such file or directory" and the job dies for a reason unrelated to the code under test
  // (observed on CI: provision-verify-db.sh's dropdb, in the `build` job). The temp server
  // never listens on TCP, so a TCP probe only returns true once the REAL server is up. 60×500ms
  // because we now wait for the full initdb+restart on a fresh container, not just the temp one.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-q"], { stdio: "ignore" });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready) throw new Error(`PostgreSQL ${CONTAINER} konteynerinde erişilebilir değil.`);
  console.log("PostgreSQL hazır.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error("Docker Desktop'ın kurulu ve çalışıyor olduğundan emin olun.");
  process.exit(1);
}
}

void main();
