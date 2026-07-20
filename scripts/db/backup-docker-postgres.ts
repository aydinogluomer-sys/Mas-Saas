// Docker adapter for pg_dump/pg_restore backups. NOT platform-independent — assumes the
// target Postgres runs in a named Docker container reachable via `docker exec`.
// Streams the dump to disk (spawn, not execFileSync) so large databases never hit a
// buffered-output memory limit; verifies non-zero size and pg_restore --list readability
// before returning success.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface BackupOptions {
  container: string;
  dbName: string;
  label: string;
  outDir?: string;
}

export interface BackupResult {
  path: string;
  bytes: number;
}

export interface BackupTargetVerification {
  container: string;
  dbName: string;
  expectedSystemIdentifier: string;
}

/** Confirms `dbName` exists inside `container` AND belongs to the same Postgres cluster
 * as the runner's live connection (matched via pg_control_system().system_identifier,
 * not just the database name — two different clusters can share a DB name). */
export function verifyBackupTarget(v: BackupTargetVerification): void {
  const listing = execFileSync("docker", ["exec", v.container, "psql", "-U", "postgres", "-lqt"], {
    encoding: "utf8",
  });
  const dbNames = listing
    .split("\n")
    .map((line) => line.split("|")[0]?.trim())
    .filter((name): name is string => Boolean(name));
  if (!dbNames.includes(v.dbName)) {
    throw new Error(
      `Backup hedefi bulunamadı: '${v.dbName}' container '${v.container}' içindeki DB listesinde yok.`,
    );
  }

  const containerIdentifier = execFileSync(
    "docker",
    [
      "exec", v.container, "psql", "-U", "postgres", "-d", v.dbName, "-tAc",
      "select system_identifier from pg_control_system();",
    ],
    { encoding: "utf8" },
  ).trim();

  if (containerIdentifier !== v.expectedSystemIdentifier) {
    throw new Error(
      `Cluster kimliği eşleşmedi — backup/migration iptal edildi.\n` +
        `  runner bağlantısı system_identifier = ${v.expectedSystemIdentifier}\n` +
        `  container '${v.container}' / db '${v.dbName}' system_identifier = ${containerIdentifier}\n` +
        `Aynı isimde farklı bir Postgres cluster'ına bağlanmış olabilirsiniz.`,
    );
  }
}

/** Exported so legacy-repair-apply.ts's offline dump-readability check reuses the exact
 * same docker/pg_restore invocation instead of a second, potentially-drifting copy. */
export function verifyRestoreListable(container: string, dumpPath: string): void {
  const result = execFileSync("docker", ["exec", "-i", container, "pg_restore", "--list"], {
    input: readFileSync(dumpPath),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!result || result.trim().length === 0) {
    throw new Error(`Yedek doğrulanamadı: 'pg_restore --list' boş çıktı döndürdü (${dumpPath}).`);
  }
}

/** Streams `pg_dump -Fc` to a local file via spawn (not execFileSync — avoids Node's
 * maxBuffer ceiling on large databases). Verifies non-zero size and pg_restore --list
 * readability before returning; deletes a half-written file on any failure. */
export async function backupDockerPostgres(opts: BackupOptions): Promise<BackupResult> {
  const outDir = opts.outDir ?? "backups";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `${opts.label}-${stamp}.dump`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("docker", ["exec", opts.container, "pg_dump", "-U", "postgres", "-Fc", opts.dbName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(outPath);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.stdout.pipe(out);
    proc.on("error", (err) => {
      out.close();
      reject(err);
    });
    out.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      out.close();
      if (code !== 0) {
        reject(new Error(`pg_dump çıkış kodu ${code}: ${stderr.trim()}`));
        return;
      }
      resolve();
    });
  }).catch((err) => {
    if (existsSync(outPath)) unlinkSync(outPath);
    throw err;
  });

  const bytes = statSync(outPath).size;
  if (bytes === 0) {
    unlinkSync(outPath);
    throw new Error("Yedek dosyası sıfır bayt — reddedildi, hiçbir şey yazılmadı.");
  }

  try {
    verifyRestoreListable(opts.container, outPath);
  } catch (err) {
    unlinkSync(outPath);
    throw new Error(`Yedek okunabilirlik doğrulaması başarısız (dosya silindi): ${(err as Error).message}`);
  }

  return { path: outPath, bytes };
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const [container, dbName, label] = process.argv.slice(2);
  if (!container || !dbName || !label) {
    console.error("Kullanım: tsx scripts/db/backup-docker-postgres.ts <container> <dbName> <label>");
    process.exit(1);
  }
  backupDockerPostgres({ container, dbName, label })
    .then((result) => {
      console.log(`Yedek tamam: ${result.path} (${result.bytes} bayt)`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
