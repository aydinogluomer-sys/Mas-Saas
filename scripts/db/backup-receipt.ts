// P0-B Slice 5 — wraps backupDockerPostgres() with an atomically-written sidecar
// receipt: the dump's own SHA-256, git provenance, cluster-identity cross-checks (the TCP
// connection this tool queries vs. the Docker container the dump actually comes from),
// ledger state, and DB-clock (not Node-clock) timestamps bracketing the backup — so
// legacy-repair-apply.ts's freshness check never depends on this host's own clock.
//
// Fail-closed identity: DATABASE_URL must be set explicitly (no default connection, no
// hardcoded connection string); the DB name it points at must match
// --expected-database-name; the live system_identifier read over that TCP connection
// must match --expected-system-identifier; verifyBackupTarget() then independently reads
// the SAME database's system_identifier through `docker exec` against --container and
// requires it to equal that same expected value — proving the TCP connection and the
// container pg_dump will run against are the SAME Postgres cluster, not two different
// ones that merely share a database name. This runs again AFTER the dump completes (the
// cluster must not have changed identity mid-backup) before a receipt is ever written.
//
// Git provenance: --expected-git-branch/--expected-git-head are required, and the real
// current branch/HEAD/working-tree-cleanliness are checked (via assertExpectedCleanGitState
// in legacy-repair-types.ts) BOTH before the dump starts and again after it completes — a
// backup taken on the wrong branch, against the wrong commit, with uncommitted local
// changes, or where any of those three facts changed mid-backup, is refused before a
// receipt is ever written. The production entrypoint (main(), below) ALWAYS uses the
// real GitStateProvider (REAL_GIT_STATE_PROVIDER, the default parameter) — there is no
// --allow-dirty flag, environment variable, or other bypass reachable from the CLI. The
// only injection seam is runBackupReceipt()'s own `deps` parameter, usable by code that
// imports this module directly (legacy-repair-verify.ts's orchestration-level tests),
// never by anything parsed from argv.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { backupDockerPostgres, verifyBackupTarget, type BackupOptions, type BackupResult, type BackupTargetVerification, type BackupTargetVerificationResult } from "./backup-docker-postgres";
import {
  BackupReceiptSchema,
  CANONICALIZATION_VERSION,
  REAL_GIT_STATE_PROVIDER,
  assertExpectedCleanGitState,
  fileSha256,
  writeViaTempAndRename,
  type BackupReceipt,
  type GitStateProvider,
} from "./legacy-repair-types";

interface Args {
  expectedDatabaseName: string;
  expectedSystemIdentifier: string;
  expectedGitBranch: string;
  expectedGitHead: string;
  container: string;
  label: string;
  outDir: string;
}

function usage(): never {
  console.error(
    "Kullanım: tsx scripts/db/backup-receipt.ts " +
      "--expected-database-name <db> --expected-system-identifier <id> " +
      "--expected-git-branch <branch> --expected-git-head <40-char SHA> " +
      "--container <container> --label <label> --out-dir <dir>\n" +
      "DATABASE_URL ortam değişkeni açıkça verilmeli (varsayılan bağlantı kabul edilmez).",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const expectedDatabaseName = get("--expected-database-name");
  const expectedSystemIdentifier = get("--expected-system-identifier");
  const expectedGitBranch = get("--expected-git-branch");
  const expectedGitHead = get("--expected-git-head");
  const container = get("--container");
  const label = get("--label");
  const outDir = get("--out-dir");
  if (!expectedDatabaseName || !expectedSystemIdentifier || !expectedGitBranch || !expectedGitHead || !container || !label || !outDir) usage();
  return { expectedDatabaseName, expectedSystemIdentifier, expectedGitBranch, expectedGitHead, container, label, outDir };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function dbNameFromUrl(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

const TO_CHAR_INSTANT = `to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface BackupReceiptParams {
  expectedDatabaseName: string;
  expectedSystemIdentifier: string;
  expectedGitBranch: string;
  expectedGitHead: string;
  container: string;
  label: string;
  outDir: string;
}

export interface BackupReceiptDeps {
  /** Defaults to REAL_GIT_STATE_PROVIDER — production NEVER overrides this. */
  gitStateProvider?: GitStateProvider;
  /** Defaults to the real verifyBackupTarget (docker exec). */
  verifyTarget?: (v: BackupTargetVerification) => BackupTargetVerificationResult;
  /** Defaults to the real backupDockerPostgres (spawns real pg_dump via docker exec). */
  runBackup?: (opts: BackupOptions) => Promise<BackupResult>;
  queryTcpIdentity: () => Promise<{ databaseName: string; systemIdentifier: string }>;
  queryLedger: () => Promise<{ ledgerCount: number; lastMigrationVersion: string }>;
  readDbTimestamp: () => Promise<string>;
}

export interface BackupReceiptOutcome {
  receiptPath: string;
  receiptSha256: string;
  receipt: BackupReceipt;
}

/** The full orchestration, injectable at every non-trivial dependency. Production's
 * main() (below) calls this with every optional dep left at its real default; tests
 * (legacy-repair-verify.ts) call it directly with fake providers to exercise git-state
 * and cluster-identity mismatch scenarios without a real second Postgres cluster and
 * without ever touching this repository's own working tree. */
export async function runBackupReceipt(params: BackupReceiptParams, deps: BackupReceiptDeps): Promise<BackupReceiptOutcome> {
  const gitStateProvider = deps.gitStateProvider ?? REAL_GIT_STATE_PROVIDER;
  const verifyTarget = deps.verifyTarget ?? verifyBackupTarget;
  const runBackup = deps.runBackup ?? backupDockerPostgres;

  const preGitState = assertExpectedCleanGitState(
    { branch: params.expectedGitBranch, head: params.expectedGitHead },
    gitStateProvider,
  );

  const tcpIdentity = await deps.queryTcpIdentity();
  if (tcpIdentity.databaseName !== params.expectedDatabaseName) {
    throw new Error(`Canlı current_database() ('${tcpIdentity.databaseName}') --expected-database-name ('${params.expectedDatabaseName}') ile eşleşmiyor.`);
  }
  if (tcpIdentity.systemIdentifier !== params.expectedSystemIdentifier) {
    throw new Error(`Canlı system_identifier ('${tcpIdentity.systemIdentifier}') --expected-system-identifier ('${params.expectedSystemIdentifier}') ile eşleşmiyor.`);
  }

  const ledger = await deps.queryLedger();

  // Pre-dump: prove the Docker container backupDockerPostgres will pg_dump against is the
  // SAME cluster this TCP connection just queried — not a same-named database on a
  // different Postgres instance.
  verifyTarget({
    container: params.container,
    dbName: params.expectedDatabaseName,
    expectedSystemIdentifier: params.expectedSystemIdentifier,
  });

  const backupStartedDbTimestamp = await deps.readDbTimestamp();
  const backupResult = await runBackup({
    container: params.container,
    dbName: params.expectedDatabaseName,
    label: params.label,
    outDir: params.outDir,
    // Slice 5 legacy-repair backs up a fully-migrated database (mas_radar_dev) — unlike
    // migrate.ts's pre-migration backups, all four critical tables must genuinely be
    // present or this backup is not valid input for repair apply.
    requireCriticalTables: true,
  });
  const backupCompletedDbTimestamp = await deps.readDbTimestamp();

  // Post-dump: the cluster identity must not have changed mid-backup. Also supplies the
  // source* provenance fields embedded in the receipt below.
  const sourceVerification = verifyTarget({
    container: params.container,
    dbName: params.expectedDatabaseName,
    expectedSystemIdentifier: params.expectedSystemIdentifier,
  });

  // Post-dump git re-check: branch/HEAD/cleanliness must still hold — a commit, checkout,
  // or edit that happened WHILE the dump was running invalidates the backup's provenance.
  // This compares against the same fixed expected branch/HEAD used pre-dump (preGitState
  // is already proven equal to it above), so any drift — mid-dump commit, checkout, or a
  // tree that got dirtied — is caught here without a separate pre-vs-post comparison.
  assertExpectedCleanGitState(
    { branch: params.expectedGitBranch, head: params.expectedGitHead },
    gitStateProvider,
  );

  const recomputedSha256 = fileSha256(readFileSync(backupResult.path));
  if (recomputedSha256 !== backupResult.sha256) {
    throw new Error(
      `Programlama hatası: backup dosyasının yeniden hesaplanan SHA-256'sı ('${recomputedSha256}') backupDockerPostgres'ün döndürdüğü hash'le ('${backupResult.sha256}') eşleşmiyor.`,
    );
  }

  const receiptPath = `${backupResult.path}.receipt.json`;
  writeViaTempAndRename(
    receiptPath,
    (receiptDurability) => {
      const receipt = {
        canonicalizationVersion: CANONICALIZATION_VERSION,
        gitBranch: preGitState.branch,
        gitHead: preGitState.head,
        containerName: params.container,
        path: path.resolve(backupResult.path),
        bytes: backupResult.bytes,
        sha256: backupResult.sha256,
        databaseName: params.expectedDatabaseName,
        systemIdentifier: params.expectedSystemIdentifier,
        sourceDatabaseName: sourceVerification.containerDatabaseName,
        sourceSystemIdentifier: sourceVerification.containerSystemIdentifier,
        targetVerificationCompleted: true as const,
        ledgerCount: ledger.ledgerCount,
        lastMigrationVersion: ledger.lastMigrationVersion,
        backupStartedDbTimestamp,
        backupCompletedDbTimestamp,
        dumpVerification: backupResult.dumpVerification,
        dumpDurability: backupResult.dumpDurability,
        receiptDurability,
      };
      const parsed = BackupReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        throw new Error(`Üretilen backup receipt kendi şemasından geçemedi (programlama hatası):\n${parsed.error.message}`);
      }
      return JSON.stringify(parsed.data, null, 2);
    },
    (text) => {
      const parsed = BackupReceiptSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`backup receipt kendi şemasından geçemedi: ${parsed.error.message}`);
    },
  );
  const receiptBytes = readFileSync(receiptPath);
  const receiptSha256 = fileSha256(receiptBytes);
  const receipt = BackupReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));

  return { receiptPath, receiptSha256, receipt };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL açıkça verilmeli — varsayılan bağlantı kabul edilmez.");
  const parsedName = dbNameFromUrl(databaseUrl);
  if (parsedName !== args.expectedDatabaseName) {
    fail(`DATABASE_URL'deki DB adı ('${parsedName}') --expected-database-name ('${args.expectedDatabaseName}') ile eşleşmiyor. Çıkış.`);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const outcome = await runBackupReceipt(
      {
        expectedDatabaseName: args.expectedDatabaseName,
        expectedSystemIdentifier: args.expectedSystemIdentifier,
        expectedGitBranch: args.expectedGitBranch,
        expectedGitHead: args.expectedGitHead,
        container: args.container,
        label: args.label,
        outDir: args.outDir,
      },
      {
        // gitStateProvider/verifyTarget/runBackup all deliberately omitted — every one
        // defaults to the real implementation inside runBackupReceipt(). Production never
        // overrides them.
        queryTcpIdentity: async () => {
          const r = await pool.query<{ db: string; sysid: string }>(
            `select current_database() as db, (select system_identifier::text from pg_control_system()) as sysid`,
          );
          return { databaseName: r.rows[0].db, systemIdentifier: r.rows[0].sysid };
        },
        queryLedger: async () => {
          const r = await pool.query<{ n: string; last_version: string | null }>(
            `select count(*)::text as n, max(version) as last_version from public.schema_migrations`,
          );
          if (!r.rows[0].last_version) {
            throw new Error("schema_migrations boş — backup receipt yalnız uygulanmış bir ledger için üretilir.");
          }
          return { ledgerCount: Number(r.rows[0].n), lastMigrationVersion: r.rows[0].last_version };
        },
        readDbTimestamp: async () => {
          const r = await pool.query<{ ts: string }>(`select ${TO_CHAR_INSTANT} as ts`);
          return r.rows[0].ts;
        },
      },
    );

    console.log(`Backup tamam: ${outcome.receipt.path} (${outcome.receipt.bytes} bayt, sha256=${outcome.receipt.sha256})`);
    console.log(`Backup receipt yazıldı: ${outcome.receiptPath}`);
    console.log(`  receipt fileSha256: ${outcome.receiptSha256}`);
  } finally {
    await pool.end();
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
