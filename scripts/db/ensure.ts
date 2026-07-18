import { execFileSync } from "node:child_process";

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

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres", "-q"], { stdio: "ignore" });
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
