// P0-B Slice 5 — wraps the runtime-selected backup (scripts/db/backup-adapter.ts: native
// PostgreSQL 16 by default, the docker container only under MAS_PG_RUNTIME=docker in CI) with
// an atomically-written sidecar receipt: the dump's own SHA-256, git provenance,
// cluster-identity cross-checks (the TCP connection this tool queries vs. the tool path the
// dump actually comes from), ledger state, and DB-clock (not Node-clock) timestamps
// bracketing the backup — so legacy-repair-apply.ts's freshness check never depends on this
// host's own clock.
//
// Fail-closed identity: DATABASE_URL must be set explicitly (no default connection, no
// hardcoded connection string); the DB name it points at must match
// --expected-database-name; the live system_identifier read over that TCP connection
// must match --expected-system-identifier; the backup-target check then independently reads
// the SAME database's system_identifier through the tool path pg_dump will use — `psql` with
// the very libpq environment pg_dump gets (native), or `docker exec` against --container
// (docker) — and requires it to equal that same expected value. That proves the TCP
// connection and the source pg_dump reads are the SAME Postgres cluster, not two different
// ones that merely share a database name. This runs again AFTER the dump completes (the
// cluster must not have changed identity mid-backup) before a receipt is ever written.
//
// The receipt's `containerName` is the adapter's source label: the container name under
// docker, `native:127.0.0.1:5432` under native. `--container` is required only under docker
// and refused under native, where the source is derived from the owner URL and nothing else.
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
import { backupDockerPostgres, readPgToolVersions, verifyBackupTarget as verifyDockerBackupTarget, type BackupOptions, type BackupResult, type BackupTargetVerification, type BackupTargetVerificationResult } from "./backup-docker-postgres";
import { createBackupAdapter, withPgRuntimeConfig, type BackupAdapter } from "./backup-adapter";
import { readEnvLocal } from "./app-url";
import { resolvePgRuntime } from "./pg-native";
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
import { ownerDatabaseUrl } from "./owner-url";

interface Args {
  expectedDatabaseName: string;
  expectedSystemIdentifier: string;
  expectedGitBranch: string;
  expectedGitHead: string;
  /** Yalnız docker çalışma zamanında; native'de yedek kaynağı owner URL'inden türetilir. */
  container: string | undefined;
  label: string;
  outDir: string;
}

function usage(): never {
  console.error(
    "Kullanım: tsx scripts/db/backup-receipt.ts " +
      "--expected-database-name <db> --expected-system-identifier <id> " +
      "--expected-git-branch <branch> --expected-git-head <40-char SHA> " +
      "[--container <container> (yalnız MAS_PG_RUNTIME=docker)] --label <label> --out-dir <dir>\n" +
      "DATABASE_URL ortam değişkeni açıkça verilmeli (varsayılan bağlantı kabul edilmez).",
  );
  process.exit(1);
}

/** Araç zinciri ayarları: önce süreç ortamı, yoksa `.env.local` (yalnız sır-olmayan PG_RUNTIME_ENV_KEYS). */
function pgToolEnv(): Record<string, string | undefined> {
  let fileEnv: Record<string, string> = {};
  try { fileEnv = readEnvLocal(); } catch { /* .env.local yok (CI) */ }
  return withPgRuntimeConfig(process.env, fileEnv);
}

function parseArgs(argv: string[], env: Readonly<Record<string, string | undefined>>): Args {
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
  if (!expectedDatabaseName || !expectedSystemIdentifier || !expectedGitBranch || !expectedGitHead || !label || !outDir) usage();
  // --container yalnız docker'da anlamlı. Native'de kabul etmek, makbuza GERÇEK kaynaktan farklı
  // bir etiket yazdırmanın yolunu açardı: kaynak orada owner URL'inden türetilir, başka hiçbir şeyden.
  const runtime = resolvePgRuntime(env);
  if (runtime === "docker" && !container) usage();
  if (runtime === "native" && argv.includes("--container")) {
    fail(
      "Native çalışma zamanında --container kabul edilmez: yedek kaynağı MIGRATION_DATABASE_URL'in " +
        "gösterdiği yerel kümedir (makbuzda 'native:<host>:<port>' olarak yazılır). " +
        "Docker konteyneri yalnız MAS_PG_RUNTIME=docker (CI) altında kullanılır.",
    );
  }
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
  /**
   * The runtime-selected REAL toolchain (scripts/db/backup-adapter.ts). main() always passes
   * one; when it is absent the docker exports are the real implementations, which is exactly
   * the path legacy-repair-verify.ts's in-process orchestration tests exercise.
   */
  adapter?: BackupAdapter;
  /** Defaults to the real backup-target check: the adapter's when given, else docker exec. */
  verifyTarget?: (v: BackupTargetVerification) => BackupTargetVerificationResult;
  /** Defaults to the real backup: the adapter's when given, else backupDockerPostgres. */
  runBackup?: (opts: BackupOptions) => Promise<BackupResult>;
  queryTcpIdentity: () => Promise<{ databaseName: string; systemIdentifier: string }>;
  queryLedger: () => Promise<{ ledgerCount: number; lastMigrationVersion: string }>;
  readDbTimestamp: () => Promise<string>;
  /** AŞAMA 07: sunucu ve pg_dump sürümleri, yedeği alan araç zincirinden ÖLÇÜLEREK. Varsayılan
   * adaptörün okuması (native'de ana sürüm eşitliği dahil), adaptör yoksa gerçek `docker exec`
   * okumasıdır; enjeksiyon seam'i yalnız testler içindir. */
  readVersions?: () => { pgVersion: string; pgDumpVersion: string };
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
  // The REAL implementations for this run: the adapter's runtime-selected tools when main()
  // hands one in, the docker exports otherwise. Each injectable default below resolves to
  // these — a test seam may replace a leaf, but nothing reachable from argv can.
  const adapter = deps.adapter;
  const verifyBackupTarget = adapter
    ? (v: BackupTargetVerification) => adapter.verifyTarget(v.dbName, v.expectedSystemIdentifier)
    : verifyDockerBackupTarget;
  const backupRealSource = adapter
    ? (o: BackupOptions) =>
        adapter.backup({ dbName: o.dbName, label: o.label, outDir: o.outDir, requireCriticalTables: o.requireCriticalTables })
    : backupDockerPostgres;
  const verifyTarget = deps.verifyTarget ?? verifyBackupTarget;
  const runBackup = deps.runBackup ?? backupRealSource;
  const readVersions = deps.readVersions ?? (() =>
    adapter
      ? adapter.readToolVersions(params.expectedDatabaseName)
      : readPgToolVersions(params.container, params.expectedDatabaseName));

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
  // Sürümler dump'tan ÖNCE okunur: makbuz, arşivi üreten araçların o andaki sürümünü
  // anlatmalı — dump bittikten sonra okunan bir sürüm, arada değişen bir container'da
  // yanlış şeyi anlatırdı.
  const versions = readVersions();

  // Pre-dump: prove the source pg_dump will read (the native tool path, or the docker
  // container) is the SAME cluster this TCP connection just queried — not a same-named
  // database on a different Postgres instance.
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
      `Programlama hatası: backup dosyasının yeniden hesaplanan SHA-256'sı ('${recomputedSha256}') yedek aracının döndürdüğü hash'le ('${backupResult.sha256}') eşleşmiyor.`,
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
        pgVersion: versions.pgVersion,
        pgDumpVersion: versions.pgDumpVersion,
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
  const pgEnv = pgToolEnv();
  const args = parseArgs(process.argv.slice(2), pgEnv);

  const databaseUrl = ownerDatabaseUrl();
  if (!databaseUrl) fail("MIGRATION_DATABASE_URL (veya DATABASE_URL) açıkça verilmeli — varsayılan bağlantı kabul edilmez.");
  const parsedName = dbNameFromUrl(databaseUrl);
  if (parsedName !== args.expectedDatabaseName) {
    fail(`DATABASE_URL'deki DB adı ('${parsedName}') --expected-database-name ('${args.expectedDatabaseName}') ile eşleşmiyor. Çıkış.`);
  }

  // Native'de hedef burada, hiçbir bağlantı açılmadan ayrıştırılır: loopback olmayan bir
  // owner URL'i adaptör oluşurken reddedilir. Docker'da --container olduğu gibi kullanılır.
  const adapter = createBackupAdapter({ ownerUrl: databaseUrl, env: pgEnv, container: args.container });
  console.log(`Yedek kaynağı: runtime=${adapter.runtime} kaynak=${adapter.sourceLabel}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const outcome = await runBackupReceipt(
      {
        expectedDatabaseName: args.expectedDatabaseName,
        expectedSystemIdentifier: args.expectedSystemIdentifier,
        expectedGitBranch: args.expectedGitBranch,
        expectedGitHead: args.expectedGitHead,
        container: adapter.sourceLabel,
        label: args.label,
        outDir: args.outDir,
      },
      {
        // The adapter IS the real toolchain for this runtime; gitStateProvider/verifyTarget/
        // runBackup are all deliberately omitted — every one defaults to the real
        // implementation inside runBackupReceipt(). Production never overrides them.
        adapter,
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
