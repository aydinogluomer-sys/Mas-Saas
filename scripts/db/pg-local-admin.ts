// Yerel / TCP PostgreSQL 16 yönetim yardımcıları — YALNIZ HARCANABİLİR doğrulama veritabanları için.
//
// `docker exec mas-radar-pg ...` çağrılarının yerini alır: hem Windows native PostgreSQL 16
// (`MAS_PG_BIN_DIR` / `C:\Program Files\PostgreSQL\16\bin`) hem de Linux CI (`postgresql-client`)
// üzerinde loopback TCP (`127.0.0.1:5432`) ve `PGPASSWORD` süreç ortamı üzerinden çalışır.
// Parolalar komut satırı argümanı olarak ASLA geçirilmez.
import path from "node:path";
import { readEnvLocal, swapDatabase } from "./app-url";
import { PgToolError, runPgToolSync } from "./backup-native-postgres";
import { isDisposableDatabaseName } from "./owner-url";
import { smokeTargetBlockers } from "./p24b-smoke-target";
import { buildLibpqEnv, parseNativeTarget, resolvePgBinaries, type NativePgTarget, type PgBinaries } from "./pg-native";

function assertSafeDisposableDb(name: string): void {
  if (!isDisposableDatabaseName(name)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${name}' harcanabilir bir veritabanı adı değil — DROP/CREATE/RESTORE reddedildi.`,
    );
  }
  const decision = smokeTargetBlockers(name, "mas_radar_dev");
  if (!decision.ok) {
    throw new Error(`GÜVENLİK DURDURMASI: ${decision.blockers.join("; ")}`);
  }
}

function resolveRawOwnerBaseUrl(): string {
  const fromProcess = process.env.MIGRATION_DATABASE_URL?.trim();
  if (fromProcess) return fromProcess;
  const envLocal = readEnvLocal();
  const fromFile = envLocal.MIGRATION_DATABASE_URL?.trim();
  if (fromFile) return fromFile;
  const port = process.env.MAS_PG_PORT?.trim() || "5432";
  return `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
}

export function resolveLocalOwnerUrl(dbName = "postgres"): string {
  const base = resolveRawOwnerBaseUrl();
  // Loopback zorunluluğu — uzak sunucuya bağlantı açılmaz.
  parseNativeTarget(base);
  return swapDatabase(base, dbName);
}

function adminContext(): { target: NativePgTarget; bins: PgBinaries; env: Record<string, string | undefined> } {
  const envLocal = readEnvLocal();
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    MAS_PG_BIN_DIR: process.env.MAS_PG_BIN_DIR ?? envLocal.MAS_PG_BIN_DIR,
  };
  const target = parseNativeTarget(resolveLocalOwnerUrl("postgres"));
  const bins = resolvePgBinaries(mergedEnv);
  return { target, bins, env: mergedEnv };
}

export function assertLocalPgReachable(): void {
  const { target, bins, env } = adminContext();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      runPgToolSync(
        bins.pgIsready,
        ["-h", target.host, "-p", String(target.port), "-U", target.user, "-t", "5", "-q"],
        {
          env: buildLibpqEnv(target, env, { database: "postgres", appName: "mas-pg-probe" }),
          tool: "pg_isready",
          timeoutMs: 10_000,
          secrets: [target.password],
        },
      );
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      }
    }
  }
  console.error(
    `Yerel PostgreSQL 16 erişilebilir değil (${lastErr instanceof Error ? lastErr.message : String(lastErr)}). ` +
      "Bu betik kümeyi otomatik başlatmaz; önce MAS-PostgreSQL16 servisinin çalıştığını doğrulayın.",
  );
  process.exit(1);
}

export function dropDisposableLocalDb(dbName: string): void {
  assertSafeDisposableDb(dbName);
  const { target, bins, env } = adminContext();
  runPgToolSync(
    bins.dropdb,
    ["--force", "--if-exists", "--no-password", "--maintenance-db=postgres", dbName],
    {
      env: buildLibpqEnv(target, env, { database: "postgres", appName: "mas-verify-admin" }),
      tool: "dropdb",
      secrets: [target.password],
    },
  );
}

export function createDisposableLocalDb(dbName: string): void {
  assertSafeDisposableDb(dbName);
  const { target, bins, env } = adminContext();
  runPgToolSync(
    bins.createdb,
    ["--no-password", "--maintenance-db=postgres", dbName],
    {
      env: buildLibpqEnv(target, env, { database: "postgres", appName: "mas-verify-admin" }),
      tool: "createdb",
      secrets: [target.password],
    },
  );
}

export function psqlLocalFile(dbName: string, filePath: string): void {
  assertSafeDisposableDb(dbName);
  const { target, bins, env } = adminContext();
  runPgToolSync(
    bins.psql,
    ["-q", "-v", "ON_ERROR_STOP=1", "--no-password", "-d", dbName, "-f", path.resolve(filePath)],
    {
      env: buildLibpqEnv(target, env, { database: dbName, appName: "mas-verify-psql" }),
      tool: "psql",
      secrets: [target.password],
    },
  );
}

export function psqlLocalSql(
  dbName: string,
  sql: string,
  opts: { allowMaintenancePostgres?: boolean; readOnly?: boolean } = {},
): string {
  if (!(opts.allowMaintenancePostgres && dbName === "postgres")) {
    assertSafeDisposableDb(dbName);
  }
  const { target, bins, env } = adminContext();
  return runPgToolSync(
    bins.psql,
    ["--no-password", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sql],
    {
      env: buildLibpqEnv(target, env, {
        database: dbName,
        appName: "mas-verify-psql",
        readOnly: opts.readOnly,
      }),
      tool: "psql",
      secrets: [target.password],
    },
  );
}

export function restoreIntoDisposableLocalDb(
  dbName: string,
  dumpPath: string,
  opts: { extraArgs?: string[]; strict?: boolean } = {},
): { warned: boolean; stderrTail: string } {
  assertSafeDisposableDb(dbName);
  const { target, bins, env } = adminContext();
  const args = [
    "--no-owner",
    "--no-password",
    `--dbname=${dbName}`,
    ...(opts.extraArgs ?? []),
    path.resolve(dumpPath),
  ];
  try {
    runPgToolSync(bins.pgRestore, args, {
      env: buildLibpqEnv(target, env, { database: dbName, appName: "mas-verify-restore" }),
      tool: "pg_restore",
      timeoutMs: 60 * 60_000,
      maxBuffer: 128 * 1024 * 1024,
      secrets: [target.password],
    });
    return { warned: false, stderrTail: "" };
  } catch (err) {
    if (!opts.strict && err instanceof PgToolError && err.status !== null) {
      return { warned: true, stderrTail: err.stderrTail };
    }
    throw err;
  }
}

export function listDumpLocal(dumpPath: string): string {
  const { bins, env, target } = adminContext();
  return runPgToolSync(bins.pgRestore, ["--list", path.resolve(dumpPath)], {
    env: buildLibpqEnv(target, env, { database: "postgres", appName: "mas-verify-list" }),
    tool: "pg_restore",
    maxBuffer: 64 * 1024 * 1024,
    secrets: [target.password],
  });
}

export function dumpDatabaseToFileLocal(
  sourceUrl: string,
  outPath: string,
  extraArgs: string[] = [],
): void {
  const envLocal = readEnvLocal();
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    MAS_PG_BIN_DIR: process.env.MAS_PG_BIN_DIR ?? envLocal.MAS_PG_BIN_DIR,
  };
  const sourceTarget = parseNativeTarget(sourceUrl);
  const bins = resolvePgBinaries(mergedEnv);
  runPgToolSync(
    bins.pgDump,
    ["-Fc", "--no-password", "-f", path.resolve(outPath), ...extraArgs, sourceTarget.database],
    {
      env: buildLibpqEnv(sourceTarget, mergedEnv, {
        database: sourceTarget.database,
        appName: "mas-readonly-dump",
        readOnly: true,
      }),
      tool: "pg_dump",
      timeoutMs: 60 * 60_000,
      maxBuffer: 128 * 1024 * 1024,
      secrets: [sourceTarget.password],
    },
  );
}

