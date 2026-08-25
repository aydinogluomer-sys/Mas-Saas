// Docker adapter for pg_dump/pg_restore backups. NOT platform-independent — assumes the
// target Postgres runs in a named Docker container reachable via `docker exec`.
// Streams the dump to a unique TEMP file (spawn, not execFileSync — avoids Node's
// maxBuffer ceiling on large databases), fsyncs it, verifies pg_restore --list
// readability on the TEMP file, only then atomically renames to the final path, fsyncs
// the containing directory, and finally re-verifies byte count + restore-listability on
// the FINAL (renamed) file — a half-written or corrupting-rename dump is never presented
// as a successful backup, and the final path is never created (let alone overwritten)
// unless every one of these steps succeeded.
import { spawn, execFileSync } from "node:child_process";
import {
  createWriteStream, existsSync, mkdirSync, openSync, fsyncSync, closeSync,
  readFileSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attemptDirectoryFsync, fileSha256, sameVolume, type DurabilityMetadata } from "./legacy-repair-types";

export interface BackupOptions {
  container: string;
  dbName: string;
  label: string;
  outDir?: string;
  /** When true, the dump is rejected unless all four critical tables (payment_instances,
   * payments, audit_logs, schema_migrations) appear in the TOC with both their TABLE and
   * TABLE DATA entries. Defaults to false: migrate.ts backs up databases that legitimately
   * don't have schema_migrations yet (that table is what LEGACY_COMPLETE is about to
   * create), so the strict check must never be forced onto every caller. Only
   * backup-receipt.ts's Slice-5 legacy-repair flow (backing up a fully-migrated database)
   * opts in. */
  requireCriticalTables?: boolean;
}

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  dumpDurability: DurabilityMetadata;
  dumpVerification: BackupDumpVerification;
}

export interface BackupDumpVerification {
  fileFsyncCompleted: true;
  tempRestoreListable: true;
  atomicRenameCompleted: true;
  finalByteSizeVerified: true;
  finalSha256Verified: true;
  finalRestoreListable: true;
  tocEntryCount: number;
  criticalTablesPresent: {
    paymentInstances: boolean;
    payments: boolean;
    auditLogs: boolean;
    schemaMigrations: boolean;
  };
}

export interface RestoreVerificationResult {
  restoreListable: true;
  tocEntryCount: number;
  criticalTablesPresent: {
    paymentInstances: boolean;
    payments: boolean;
    auditLogs: boolean;
    schemaMigrations: boolean;
  };
}

const CRITICAL_TABLES = ["payment_instances", "payments", "audit_logs", "schema_migrations"] as const;

export interface PgToolVersions {
  pgVersion: string;
  pgDumpVersion: string;
}

/** AŞAMA 07 (rehber §12 Bölüm A). Sunucu ve `pg_dump` sürümlerini container'dan ÖLÇER.
 * Makbuza yazılırlar çünkü kurtarma anında elde başka bir kayıt yoktur: 16.14 ile yazılmış
 * bir arşivin daha eski bir `pg_restore` ile yüklenebileceği garanti değildir ve bunu
 * felaket gününde keşfetmek, yedeği hiç almamış olmakla aynı kapıya çıkar. */
export function readPgToolVersions(container: string, dbName: string): PgToolVersions {
  const pgVersion = execFileSync(
    "docker",
    ["exec", container, "psql", "-U", "postgres", "-d", dbName, "-tAc", "select version()"],
    { encoding: "utf8" },
  ).trim();
  const pgDumpVersion = execFileSync("docker", ["exec", container, "pg_dump", "--version"], {
    encoding: "utf8",
  }).trim();
  return { pgVersion, pgDumpVersion };
}

export interface BackupTargetVerification {
  container: string;
  dbName: string;
  expectedSystemIdentifier: string;
}

export interface BackupTargetVerificationResult {
  containerDatabaseName: string;
  containerSystemIdentifier: string;
}

/** Confirms `dbName` exists inside `container` AND belongs to the same Postgres cluster
 * as the caller's own TCP connection (matched via pg_control_system().system_identifier,
 * not just the database name — two different clusters can share a database name).
 * Returns what was actually read from the container so the caller can embed it as
 * independent provenance (BackupReceipt's sourceDatabaseName/sourceSystemIdentifier)
 * rather than this function only ever throwing-or-not. */
export function verifyBackupTarget(v: BackupTargetVerification): BackupTargetVerificationResult {
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
  return { containerDatabaseName: v.dbName, containerSystemIdentifier: containerIdentifier };
}

const CRITICAL_TABLE_PROPERTY: Record<(typeof CRITICAL_TABLES)[number], keyof RestoreVerificationResult["criticalTablesPresent"]> = {
  payment_instances: "paymentInstances",
  payments: "payments",
  audit_logs: "auditLogs",
  schema_migrations: "schemaMigrations",
};

/** Exported so legacy-repair-apply.ts's offline dump-readability check reuses the exact
 * same docker/pg_restore invocation instead of a second, potentially-drifting copy.
 * Returns STRUCTURED evidence (TOC entry count + presence of all four critical tables,
 * both their TABLE definition and TABLE DATA entries) rather than a bare boolean/void —
 * this is what lets BackupReceipt carry the proof as immutable, hash-scoped data instead
 * of only a console log line. Critical-table presence is only ENFORCED (throwing on a
 * missing table) when `requireCriticalTables` is true — migrate.ts backs up databases
 * that legitimately don't have schema_migrations yet, so that caller leaves it false and
 * merely gets the true/false evidence back without rejection. */
export function verifyRestoreListable(container: string, dumpPath: string, requireCriticalTables = false): RestoreVerificationResult {
  // Faz 33: the dump is COPIED into the container and pg_restore reads it as a file, rather than
  // being read into memory and pushed through the child's stdin.
  //
  // Found by measurement, not review: after loading a realistic volume (24.000 invoices, 60.000
  // bank transactions) every `db:migrate` began failing with `spawnSync docker EOF`. The previous
  // form did `input: readFileSync(dumpPath)` — it buffered the ENTIRE dump and wrote it down a
  // spawnSync stdin pipe, which breaks on a large payload. The consequence was not cosmetic: no
  // migration could be applied to any database holding real data, because the mandatory backup
  // could never be verified. The bug was invisible for 82 migrations because every test database
  // was small.
  //
  // What is verified is unchanged: the same pg_restore --list, over the same dump bytes. Only the
  // transport moved off a memory buffer. The listing itself is small (one line per object), so it
  // still fits the output buffer comfortably.
  const inContainer = `/tmp/mas-backup-verify-${process.pid}-${Date.now()}.dump`;
  let result: string;
  execFileSync("docker", ["cp", dumpPath, `${container}:${inContainer}`]);
  try {
    result = execFileSync("docker", ["exec", container, "pg_restore", "--list", inContainer], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    // Best-effort: a leftover temp file in the container must never mask the real verification
    // result, so a failure to clean up is not allowed to throw over it.
    try {
      execFileSync("docker", ["exec", container, "rm", "-f", inContainer]);
    } catch { /* cleanup only */ }
  }
  if (!result || result.trim().length === 0) {
    throw new Error(`Yedek doğrulanamadı: 'pg_restore --list' boş çıktı döndürdü (${dumpPath}).`);
  }

  const tocMatch = result.match(/TOC Entries:\s*(\d+)/);
  if (!tocMatch) {
    throw new Error(`Yedek doğrulanamadı: 'TOC Entries:' başlığı bulunamadı (${dumpPath}).`);
  }
  const tocEntryCount = Number(tocMatch[1]);
  if (!(tocEntryCount > 0)) {
    throw new Error(`Yedek doğrulanamadı: TOC Entries geçersiz (${tocEntryCount}) (${dumpPath}).`);
  }

  const criticalTablesPresent = { paymentInstances: false, payments: false, auditLogs: false, schemaMigrations: false };
  const missing: string[] = [];
  for (const tableName of CRITICAL_TABLES) {
    const hasTable = new RegExp(`TABLE public ${tableName} `).test(result);
    const hasTableData = new RegExp(`TABLE DATA public ${tableName} `).test(result);
    const present = hasTable && hasTableData;
    criticalTablesPresent[CRITICAL_TABLE_PROPERTY[tableName]] = present;
    if (!present) missing.push(tableName);
  }
  if (requireCriticalTables && missing.length > 0) {
    throw new Error(`Yedek doğrulanamadı: kritik tablo(lar) TOC'ta eksik (TABLE ve/veya TABLE DATA girdisi yok): ${missing.join(", ")} (${dumpPath}).`);
  }

  return { restoreListable: true, tocEntryCount, criticalTablesPresent };
}

/** Streams `pg_dump -Fc` to a unique temp file, waits for BOTH the docker-exec process to
 * exit 0 AND the write stream to fully flush ('finish') — resolving on process-close
 * alone, as the previous implementation did, left a real race where a large dump could
 * still have buffered bytes in flight when the caller believed the write was done — then
 * fsyncs the completed temp file, verifies non-zero size and pg_restore --list
 * readability on the TEMP file, and only THEN atomically renames to the final path
 * (same directory/volume as the temp file, checked via sameVolume before anything is
 * written). After rename: fsyncs the containing directory (Windows best-effort per
 * attemptDirectoryFsync's existing policy) and re-verifies byte count + restore-
 * listability on the FINAL file. Any failure before rename deletes the temp file and
 * never creates the final path; a failure in the post-rename re-verification deletes the
 * (already-renamed) final file too, since no receipt will ever legitimize it. */
export async function backupDockerPostgres(opts: BackupOptions): Promise<BackupResult> {
  const outDir = opts.outDir ?? "backups";
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(outDir, `${opts.label}-${stamp}.dump`);
  if (existsSync(finalPath)) {
    throw new Error(`Yedek dosyası zaten mevcut, üzerine yazılmaz: ${finalPath}`);
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  if (!sameVolume(tempPath, finalPath)) {
    throw new Error(
      `backupDockerPostgres: temp yolu (${tempPath}) ve final yolu (${finalPath}) aynı volume üzerinde değil — rename atomik olmayabilir, işlem başlamadan reddedildi.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("docker", ["exec", opts.container, "pg_dump", "-U", "postgres", "-Fc", opts.dbName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(tempPath, { flags: "wx" });
    let stderr = "";
    let procExitCode: number | null = null;
    let procClosed = false;
    let writeFinished = false;
    let settled = false;

    const maybeResolve = () => {
      if (settled || !procClosed || !writeFinished) return;
      settled = true;
      if (procExitCode === 0) resolve();
      else reject(new Error(`pg_dump çıkış kodu ${procExitCode}: ${stderr.trim()}`));
    };
    const failOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.stdout.pipe(out);
    proc.on("error", failOnce);
    out.on("error", failOnce);
    // 'finish' fires only after end() was called (pipe() does this automatically when
    // proc.stdout ends) AND every buffered chunk has actually been written — the genuine
    // "all bytes are on the OS side of the fd" signal that process-close alone is not.
    out.on("finish", () => {
      writeFinished = true;
      maybeResolve();
    });
    proc.on("close", (code) => {
      procExitCode = code;
      procClosed = true;
      maybeResolve();
    });
  }).catch((err) => {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw err;
  });

  {
    const fd = openSync(tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  const tempBytes = statSync(tempPath).size;
  if (tempBytes === 0) {
    unlinkSync(tempPath);
    throw new Error("Yedek dosyası sıfır bayt — reddedildi, hiçbir şey yazılmadı.");
  }

  try {
    verifyRestoreListable(opts.container, tempPath, opts.requireCriticalTables);
  } catch (err) {
    unlinkSync(tempPath);
    throw new Error(`Yedek okunabilirlik doğrulaması başarısız (temp dosya silindi, final dosya hiç oluşmadı): ${(err as Error).message}`);
  }

  renameSync(tempPath, finalPath);
  const dumpDurability = attemptDirectoryFsync(outDir);

  const finalBytes = statSync(finalPath).size;
  if (finalBytes !== tempBytes) {
    unlinkSync(finalPath);
    throw new Error(`Rename sonrası final dosya boyutu (${finalBytes}) temp boyutuyla (${tempBytes}) eşleşmiyor — final dosya silindi.`);
  }
  const finalSha256 = fileSha256(readFileSync(finalPath));
  let finalVerification: RestoreVerificationResult;
  try {
    finalVerification = verifyRestoreListable(opts.container, finalPath, opts.requireCriticalTables);
  } catch (err) {
    unlinkSync(finalPath);
    throw new Error(`Final dosya (rename sonrası) okunabilirlik doğrulamasından geçemedi (dosya silindi): ${(err as Error).message}`);
  }

  return {
    path: finalPath,
    bytes: finalBytes,
    sha256: finalSha256,
    dumpDurability,
    dumpVerification: {
      fileFsyncCompleted: true,
      tempRestoreListable: true,
      atomicRenameCompleted: true,
      finalByteSizeVerified: true,
      finalSha256Verified: true,
      finalRestoreListable: true,
      tocEntryCount: finalVerification.tocEntryCount,
      criticalTablesPresent: finalVerification.criticalTablesPresent,
    },
  };
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
      console.log(`Yedek tamam: ${result.path} (${result.bytes} bayt, sha256=${result.sha256})`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
