// Migration ledger runner (P0-C minimal). Connects only via DATABASE_URL — does NOT call
// scripts/db/ensure.ts, so it never creates an ad-hoc container or points at the wrong DB
// by accident. Detects one of four states (EMPTY / LEGACY_COMPLETE / LEDGER_MANAGED /
// LEDGER_EMPTY_RECOVERY) under a single advisory lock and applies the matching atomic
// procedure. See C:\Users\Trade Bilisim\.claude\plans\grafik-k-sm-nda-3-ay-jazzy-stardust.md
// for the full design rationale.
import { Pool, type PoolClient } from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateFileSet,
  checksumContent,
  verifyLegacyBaseline,
  isLedgerWellFormed,
  type MigrationFile,
  type LegacyBaselineEntry,
  type LedgerRow,
} from "./migration-lib";
import { backupDockerPostgres, verifyBackupTarget, type BackupResult } from "./backup-docker-postgres";
import { ownerDatabaseUrl } from "./owner-url";
import { readEnvLocal, swapDatabase } from "./app-url";
import { diffShapes, schemaShape, type SchemaShape } from "./schema-shape";
import {
  CONNECTION_ENV_NAMES,
  describeEnvSource,
  inspectEnvSources,
  shadowedNames,
} from "./env-source";

const CONTAINER = process.env.MAS_DB_CONTAINER ?? "mas-radar-pg";
const BASELINE_PATH = path.join(process.cwd(), "scripts", "db", "legacy-baseline-0019.json");
const BOOTSTRAP_SQL_PATH = path.join(process.cwd(), "scripts", "db", "local-bootstrap.sql");
const ADVISORY_LOCK_SQL = "select pg_advisory_lock(hashtext('mas_nakit_radar:schema_migrations')::bigint)";
const ADVISORY_UNLOCK_SQL = "select pg_advisory_unlock(hashtext('mas_nakit_radar:schema_migrations')::bigint)";

const RELKIND_FILTER = "('r','p','v','m','S','f')"; // ordinary table, partitioned table, view, matview, sequence, foreign table

interface Anchor {
  version: string;
  label: string;
  sql: string;
}

const ANCHORS: Anchor[] = [
  { version: "0001", label: "public.mapping_reviews", sql: "select to_regclass('public.mapping_reviews') is not null as pass" },
  { version: "0002", label: "public.audit_logs", sql: "select to_regclass('public.audit_logs') is not null as pass" },
  { version: "0003", label: "public.payment_instances", sql: "select to_regclass('public.payment_instances') is not null as pass" },
  { version: "0004", label: "public.cashflow_snapshots", sql: "select to_regclass('public.cashflow_snapshots') is not null as pass" },
  { version: "0005", label: "public.loan_installments", sql: "select to_regclass('public.loan_installments') is not null as pass" },
  { version: "0006", label: "public.reports", sql: "select to_regclass('public.reports') is not null as pass" },
  {
    version: "0007",
    // Faz 24B REPAIRED this anchor — it did not add one, and the array is the same length and
    // the same versions it has always been.
    //
    // It used to look for the policy `payments_authenticated_all`. Migration 0058 deliberately
    // drops that policy (and its 57 siblings) when it replaces the blanket rule with the
    // tier-aware ones, so from 0058 onward the anchor reported "0007 never ran" on a database
    // where 0007 plainly had. That is not cosmetic: LEDGER_EMPTY_RECOVERY consults the anchors
    // to decide whether a ledger-less database is legacy-complete, and one failing anchor among
    // nineteen passing ones is exactly the INCONSISTENT_PARTIAL state that hard-fails. A raw
    // restore of any 24B database would have refused to migrate.
    //
    // 0007 does two things: it enables RLS on every table AND creates the blanket policies.
    // The second is what 24B legitimately supersedes; the first it leaves untouched. So the
    // anchor now fingerprints the durable half. It answers the same question — did 0007 run —
    // and answers it correctly both before 24B (a real legacy DB has RLS on payments) and
    // after, which the policy test no longer could.
    label: "payments row level security enabled",
    sql: "select coalesce((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='payments'), false) as pass",
  },
  { version: "0008", label: "public.checks_source_row_uq", sql: "select to_regclass('public.checks_source_row_uq') is not null as pass" },
  {
    version: "0009",
    label: "checks.counterparty_label",
    sql: "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='checks' and column_name='counterparty_label') as pass",
  },
  { version: "0010", label: "public.machine_roi_snapshots", sql: "select to_regclass('public.machine_roi_snapshots') is not null as pass" },
  { version: "0011", label: "public.scenario_comparisons", sql: "select to_regclass('public.scenario_comparisons') is not null as pass" },
  { version: "0012", label: "public.cost_breakdown_lines", sql: "select to_regclass('public.cost_breakdown_lines') is not null as pass" },
  { version: "0013", label: "public.finance_cost_allocations", sql: "select to_regclass('public.finance_cost_allocations') is not null as pass" },
  { version: "0014", label: "public.ai_response_snapshots", sql: "select to_regclass('public.ai_response_snapshots') is not null as pass" },
  { version: "0015", label: "public.action_items", sql: "select to_regclass('public.action_items') is not null as pass" },
  { version: "0016", label: "public.external_assumptions", sql: "select to_regclass('public.external_assumptions') is not null as pass" },
  { version: "0017", label: "public.metric_snapshots", sql: "select to_regclass('public.metric_snapshots') is not null as pass" },
  {
    version: "0018",
    label: "payments.archived_at",
    sql: "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='archived_at') as pass",
  },
  {
    version: "0019",
    label: "payments.flexibility_class",
    sql: "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='flexibility_class') as pass",
  },
];

interface AnchorResult extends Anchor {
  pass: boolean;
}

interface MigrateReport {
  state: string;
  recoveryFlavor?: "legacy" | "fresh" | "shape";
  /** shape-flavored recovery: ledger'ı yeniden kurarken şemanın ölçülen konumu. */
  recoveredThrough?: string;
  bootstrapped: string[];
  backfilled: string[];
  pendingApplied: string[];
  upToDate: boolean;
  backup: (BackupResult & { systemIdentifier: string }) | null;
}

class HardFailError extends Error {}

function loadLegacyBaseline(): LegacyBaselineEntry[] {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

async function getAnchorResults(client: PoolClient): Promise<AnchorResult[]> {
  const results: AnchorResult[] = [];
  for (const anchor of ANCHORS) {
    const res = await client.query<{ pass: boolean }>(anchor.sql);
    results.push({ ...anchor, pass: res.rows[0]?.pass === true });
  }
  return results;
}

async function getPublicRelCount(client: PoolClient, excludeNames: string[] = []): Promise<number> {
  const res = await client.query<{ n: number }>(
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ${RELKIND_FILTER}
       and c.relname <> all($1::text[])`,
    [excludeNames],
  );
  return res.rows[0]?.n ?? 0;
}

async function checkAuthPrereqs(client: PoolClient): Promise<void> {
  const roles = await client.query<{ rolname: string }>(
    "select rolname from pg_roles where rolname in ('anon','authenticated','service_role')",
  );
  const found = new Set(roles.rows.map((r) => r.rolname));
  const missingRoles = ["anon", "authenticated", "service_role"].filter((r) => !found.has(r));

  const authUsers = await client.query<{ ok: boolean }>("select to_regclass('auth.users') is not null as ok");
  const authUid = await client.query<{ ok: boolean }>(
    "select exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='auth' and p.proname='uid') as ok",
  );

  const problems: string[] = [];
  if (missingRoles.length > 0) problems.push(`eksik roller: ${missingRoles.join(", ")}`);
  if (!authUsers.rows[0]?.ok) problems.push("auth.users tablosu yok");
  if (!authUid.rows[0]?.ok) problems.push("auth.uid() fonksiyonu yok");

  if (problems.length > 0) {
    throw new HardFailError(
      `local-bootstrap.sql henüz çalıştırılmamış, önce onu çalıştırın. (${problems.join("; ")})`,
    );
  }
}

async function runSequentialInsert(client: PoolClient, f: MigrationFile, appliedBy: string, checksum?: string): Promise<void> {
  await client.query(
    "insert into public.schema_migrations(version,name,checksum,applied_by) values ($1,$2,$3,$4)",
    [f.version, f.name, checksum ?? checksumContent(f.content), appliedBy],
  );
}

async function applyPendingSequentially(client: PoolClient, files: MigrationFile[]): Promise<string[]> {
  const applied: string[] = [];
  for (const f of files) {
    await client.query("BEGIN");
    try {
      await client.query(f.content);
      await runSequentialInsert(client, f, "migrate-script");
      await client.query("COMMIT");
      applied.push(f.version);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new HardFailError(`Pending migration ${f.version} (${f.name}) başarısız: ${(err as Error).message}`);
    }
  }
  return applied;
}

function assertManifestClean(diskFiles: MigrationFile[], manifest: LegacyBaselineEntry[]): void {
  const baselineFiles = diskFiles.filter((f) => f.version <= "0019");
  const check = verifyLegacyBaseline(manifest, baselineFiles);
  if (!check.ok) {
    throw new HardFailError(
      `Manifest doğrulaması başarısız (0001-0019 legacy-baseline-0019.json ile uyuşmuyor) — hiçbir SQL çalıştırılmadı:\n  ${check.mismatches.join("\n  ")}`,
    );
  }
}

/** EMPTY state (and LEDGER_EMPTY_RECOVERY's fresh-flavored reuse): one atomic transaction
 * runs 0001..0020 for real (0020 is a no-op if schema_migrations already exists), inserts
 * all matching ledger rows in the same transaction, then applies 0021+ as normal pending. */
async function runEmptyFlow(client: PoolClient, diskFiles: MigrationFile[], manifest: LegacyBaselineEntry[]): Promise<MigrateReport> {
  assertManifestClean(diskFiles, manifest);

  const bootstrapFiles = diskFiles.filter((f) => f.version <= "0020");
  await client.query("BEGIN");
  try {
    for (const f of bootstrapFiles) {
      await client.query(f.content);
    }
    for (const f of bootstrapFiles) {
      await runSequentialInsert(client, f, "migrate-script");
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new HardFailError(`EMPTY bootstrap transaction başarısız, hiçbir şey commit olmadı: ${(err as Error).message}`);
  }

  const pendingFiles = diskFiles.filter((f) => f.version > "0020");
  const pendingApplied = await applyPendingSequentially(client, pendingFiles);

  return {
    state: "EMPTY",
    bootstrapped: bootstrapFiles.map((f) => f.version),
    backfilled: [],
    pendingApplied,
    upToDate: pendingFiles.length === 0,
    backup: null,
  };
}

/** LEGACY_COMPLETE state (and LEDGER_EMPTY_RECOVERY's legacy-flavored reuse): manifest
 * check, mandatory backup, then one atomic transaction runs 0020 for real (no-op if the
 * table already exists) and backfills 0001-0019 ledger rows using the verified manifest
 * checksums (their SQL is never re-executed), then applies 0021+ as normal pending. */
async function runLegacyCompleteFlow(
  client: PoolClient,
  diskFiles: MigrationFile[],
  manifest: LegacyBaselineEntry[],
  backupTarget: { container: string; dbName: string; systemIdentifier: string },
): Promise<MigrateReport> {
  assertManifestClean(diskFiles, manifest);

  verifyBackupTarget({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    expectedSystemIdentifier: backupTarget.systemIdentifier,
  });
  const backupResult = await backupDockerPostgres({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    label: `migrate-${backupTarget.dbName}`,
  });

  const file0020 = diskFiles.find((f) => f.version === "0020");
  if (!file0020) throw new HardFailError("0020_schema_migrations_ledger.sql diskte bulunamadı.");

  await client.query("BEGIN");
  try {
    await client.query(file0020.content);
    await runSequentialInsert(client, file0020, "migrate-script");
    for (const entry of manifest) {
      await client.query(
        "insert into public.schema_migrations(version,name,checksum,applied_by) values ($1,$2,$3,'baseline-backfill')",
        [entry.version, entry.name, entry.checksum],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new HardFailError(`LEGACY_COMPLETE bootstrap transaction başarısız, hiçbir şey commit olmadı: ${(err as Error).message}`);
  }

  const pendingFiles = diskFiles.filter((f) => f.version > "0020");
  const pendingApplied = await applyPendingSequentially(client, pendingFiles);

  return {
    state: "LEGACY_COMPLETE",
    bootstrapped: ["0020"],
    backfilled: manifest.map((m) => m.version),
    pendingApplied,
    upToDate: pendingFiles.length === 0,
    backup: { ...backupResult, systemIdentifier: backupTarget.systemIdentifier },
  };
}

async function runLedgerManagedFlow(
  client: PoolClient,
  diskFiles: MigrationFile[],
  ledgerRows: LedgerRow[],
  backupTarget: { container: string; dbName: string; systemIdentifier: string },
): Promise<MigrateReport> {
  const diskByVersion = new Map(diskFiles.map((f) => [f.version, f]));
  const mismatches: string[] = [];
  for (const row of ledgerRows) {
    const disk = diskByVersion.get(row.version);
    if (!disk) {
      mismatches.push(`${row.version}: ledger'da var, diskte dosya yok (${row.name}).`);
      continue;
    }
    const diskChecksum = checksumContent(disk.content);
    if (diskChecksum !== row.checksum) {
      mismatches.push(`${row.version}: checksum uyuşmuyor — ledger ${row.checksum}, disk ${diskChecksum}.`);
    }
  }
  if (mismatches.length > 0) {
    throw new HardFailError(`LEDGER_MANAGED checksum doğrulaması başarısız, hiçbir yeni SQL çalıştırılmadı:\n  ${mismatches.join("\n  ")}`);
  }

  const ledgerVersions = new Set(ledgerRows.map((r) => r.version));
  const pendingFiles = diskFiles.filter((f) => !ledgerVersions.has(f.version));

  if (pendingFiles.length === 0) {
    return { state: "LEDGER_MANAGED", bootstrapped: [], backfilled: [], pendingApplied: [], upToDate: true, backup: null };
  }

  verifyBackupTarget({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    expectedSystemIdentifier: backupTarget.systemIdentifier,
  });
  const backupResult = await backupDockerPostgres({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    label: `migrate-${backupTarget.dbName}`,
  });

  const pendingApplied = await applyPendingSequentially(client, pendingFiles);
  return {
    state: "LEDGER_MANAGED",
    bootstrapped: [],
    backfilled: [],
    pendingApplied,
    upToDate: false,
    backup: { ...backupResult, systemIdentifier: backupTarget.systemIdentifier },
  };
}

/* ── CI-1 (PRE-PHASE8 CI CLOSURE): şekil-eşleştirmeli ledger kurtarma ─────────────────────
 *
 * ESKİ SÖZLEŞME. "Ledger boş, legacy anchor'lar (0001–0019) geçiyor → şema 0019'dadır; 0020'yi
 * kur, 0001–0019'u manifestten doldur, 0021+'yı YENİDEN OYNAT." Bu, 0021+'nın HEAD'de duran bir
 * şemaya karşı yeniden koşulabildiği varsayımına dayanıyordu. 0093/0094 view kolonlarını
 * değiştirince varsayım çöktü: 0039, 0043, 0047, 0050, 0052, 0061, 0063, 0067, 0070, 0075, 0078,
 * 0082 — on iki `create or replace view` "cannot drop columns from view" ile düşüyor. Migration
 * dosyalarını bunun için yeniden yazmak yasak ve yanlış olurdu; kolon değiştiren bir view
 * migration'ı normal bir şeydir.
 *
 * YENİ SÖZLEŞME. Şemanın nerede olduğu VARSAYILMAZ, ÖLÇÜLÜR: aynı kümede geçici bir referans
 * veritabanı yaratılır, bootstrap + migration'lar 0001'den itibaren sırayla uygulanır ve HER
 * migration'dan sonra `public` şemasının deterministik şekli (schema-shape.ts) alınır. Canlı
 * veritabanının şekli hangi N'de eşleşiyorsa şema oradadır: 0001..N ledger'a yazılır (SQL
 * yeniden oynatılmaz), N+1..HEAD normal pending olarak uygulanır. Hiçbir N eşleşmiyorsa durum
 * INCONSISTENT_PARTIAL'dır ve hard-fail eder (fail-closed; yedekten dönülür). Şekli değiştirmeyen
 * (yalnız veri yazan) bir migration'ın uygulanıp uygulanmadığı şekilden okunamaz — böyle bir
 * belirsizlik N < HEAD iken hard-fail'dir, N = HEAD iken (ham kurulum) tanım gereği uygulanmıştır.
 *
 * Referans veritabanı yalnız bu akışta yaratılır (EMPTY / LEGACY_COMPLETE / LEDGER_MANAGED yolları
 * ona dokunmaz), adı `_tmp` işaretlidir ve `finally` içinde düşürülür. Yedek alınmadan canlı
 * veritabanına tek satır yazılmaz.
 */
interface ShapeMatch {
  version: string;
  ambiguousNext: boolean;
  liveDigest: string;
  scanned: number;
}

async function applyBootstrapAndReadShapes(
  refClient: PoolClient,
  diskFiles: MigrationFile[],
  liveShape: SchemaShape,
): Promise<{ matches: string[]; shapes: Map<string, string>; closest: { version: string; shape: SchemaShape } | null }> {
  await refClient.query(readFileSync(BOOTSTRAP_SQL_PATH, "utf8"));
  const matches: string[] = [];
  const shapes = new Map<string, string>();
  let closest: { version: string; shape: SchemaShape; distance: number } | null = null;
  for (const f of diskFiles) {
    await refClient.query("BEGIN");
    try {
      await refClient.query(f.content);
      await refClient.query("COMMIT");
    } catch (err) {
      await refClient.query("ROLLBACK").catch(() => {});
      throw new HardFailError(`LEDGER_EMPTY_RECOVERY: referans veritabanında ${f.version} uygulanamadı: ${(err as Error).message}`);
    }
    const shape = await schemaShape(refClient);
    shapes.set(f.version, shape.digest);
    if (shape.digest === liveShape.digest) matches.push(f.version);
    const d = diffShapes(shape, liveShape, 1_000_000);
    const distance = d.onlyInA.length + d.onlyInB.length;
    if (closest === null || distance < closest.distance) closest = { version: f.version, shape, distance };
  }
  return { matches, shapes, closest: closest ? { version: closest.version, shape: closest.shape } : null };
}

async function matchLiveSchemaShape(
  client: PoolClient,
  diskFiles: MigrationFile[],
  databaseUrl: string,
): Promise<ShapeMatch> {
  const liveShape = await schemaShape(client);
  const refDb = `mas_radar_recovery_tmp_${process.pid}_${Date.now()}`;
  const maint = new Pool({ connectionString: swapDatabase(databaseUrl, "postgres"), max: 1 });
  try {
    try {
      await maint.query(`create database "${refDb}" template template0`);
    } catch (err) {
      throw new HardFailError(
        `LEDGER_EMPTY_RECOVERY: referans veritabanı yaratılamadı (${(err as Error).message}). ` +
          "Şekil eşleştirmesi için MIGRATION_DATABASE_URL rolünün CREATEDB yetkisi gerekir; canlı veritabanına dokunulmadı.",
      );
    }
    const refPool = new Pool({ connectionString: swapDatabase(databaseUrl, refDb), max: 1 });
    try {
      const refClient = await refPool.connect();
      let scan: Awaited<ReturnType<typeof applyBootstrapAndReadShapes>>;
      try {
        scan = await applyBootstrapAndReadShapes(refClient, diskFiles, liveShape);
      } finally {
        refClient.release();
      }
      if (scan.matches.length === 0) {
        const c = scan.closest;
        const d = c ? diffShapes(liveShape, c.shape) : { onlyInA: [], onlyInB: [] };
        throw new HardFailError(
          "LEDGER_EMPTY_RECOVERY: karışık/tutarsız durum (INCONSISTENT_PARTIAL) — canlı şema hiçbir migration adımının şekliyle eşleşmiyor; " +
            "ledger yeniden kurulamaz, canlı veritabanına dokunulmadı. Yedekten geri dönün ya da şemayı elle inceleyin.\n" +
            `  en yakın adım: ${c?.version ?? "?"}\n` +
            (d.onlyInA.length ? `  yalnız canlıda: ${d.onlyInA.join(" ; ")}\n` : "") +
            (d.onlyInB.length ? `  yalnız referansta: ${d.onlyInB.join(" ; ")}` : ""),
        );
      }
      const version = scan.matches[scan.matches.length - 1];
      const idx = diskFiles.findIndex((f) => f.version === version);
      const next = diskFiles[idx + 1];
      const ambiguousNext = next !== undefined && scan.shapes.get(next.version) === liveShape.digest;
      return { version, ambiguousNext, liveDigest: liveShape.digest, scanned: diskFiles.length };
    } finally {
      await refPool.end().catch(() => {});
      await maint.query(`drop database if exists "${refDb}"`).catch(() => {});
    }
  } finally {
    await maint.end().catch(() => {});
  }
}

async function runShapeRecoveryFlow(
  client: PoolClient,
  diskFiles: MigrationFile[],
  manifest: LegacyBaselineEntry[],
  backupTarget: { container: string; dbName: string; systemIdentifier: string },
  databaseUrl: string,
): Promise<MigrateReport> {
  assertManifestClean(diskFiles, manifest);
  const match = await matchLiveSchemaShape(client, diskFiles, databaseUrl);
  const head = diskFiles[diskFiles.length - 1]?.version ?? "0000";
  if (match.ambiguousNext) {
    // N+1 şekli değiştirmiyor (yalnız veri yazıyor olabilir): uygulanıp uygulanmadığı şemadan
    // okunamaz. Ledger'a "uygulandı" yazmak da, yeniden oynatmak da bir tahmin olurdu.
    throw new HardFailError(
      `LEDGER_EMPTY_RECOVERY: şema ${match.version}'de eşleşti ama bir sonraki migration şekli değiştirmiyor; ` +
        "uygulanıp uygulanmadığı kanıtlanamaz (INCONSISTENT_PARTIAL). Canlı veritabanına dokunulmadı.",
    );
  }
  console.log(`LEDGER_EMPTY_RECOVERY: canlı şema referansla ${match.version}'de eşleşti (HEAD ${head}); SQL yeniden oynatılmadı.`);

  verifyBackupTarget({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    expectedSystemIdentifier: backupTarget.systemIdentifier,
  });
  const backupResult = await backupDockerPostgres({
    container: backupTarget.container,
    dbName: backupTarget.dbName,
    label: `migrate-${backupTarget.dbName}`,
  });

  const manifestByVersion = new Map(manifest.map((m) => [m.version, m]));
  const recovered = diskFiles.filter((f) => f.version <= match.version);
  await client.query("BEGIN");
  try {
    for (const f of recovered) {
      const baseline = manifestByVersion.get(f.version);
      if (baseline) {
        await client.query(
          "insert into public.schema_migrations(version,name,checksum,applied_by) values ($1,$2,$3,'baseline-backfill')",
          [baseline.version, baseline.name, baseline.checksum],
        );
      } else {
        await runSequentialInsert(client, f, "ledger-recovery");
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw new HardFailError(`LEDGER_EMPTY_RECOVERY ledger yeniden kurma transaction'ı başarısız, hiçbir şey commit olmadı: ${(err as Error).message}`);
  }

  const pendingFiles = diskFiles.filter((f) => f.version > match.version);
  const pendingApplied = await applyPendingSequentially(client, pendingFiles);

  return {
    state: "LEDGER_EMPTY_RECOVERY",
    recoveryFlavor: "shape",
    recoveredThrough: match.version,
    bootstrapped: [],
    backfilled: recovered.map((f) => f.version),
    pendingApplied,
    upToDate: pendingFiles.length === 0,
    backup: { ...backupResult, systemIdentifier: backupTarget.systemIdentifier },
  };
}

async function runLedgerEmptyRecoveryFlow(
  client: PoolClient,
  diskFiles: MigrationFile[],
  manifest: LegacyBaselineEntry[],
  backupTarget: { container: string; dbName: string; systemIdentifier: string },
  databaseUrl: string,
): Promise<MigrateReport> {
  const anchors = await getAnchorResults(client);
  const allPass = anchors.every((a) => a.pass);
  const allFail = anchors.every((a) => !a.pass);
  const otherRelCount = await getPublicRelCount(client, [
    "schema_migrations",
    "schema_migrations_pkey",
    "schema_migrations_applied_at_idx",
  ]);

  if (allPass) {
    // Legacy anchor'lar "en az 0019" der, "tam olarak nerede" demez — onu şekil eşleştirmesi ölçer.
    return runShapeRecoveryFlow(client, diskFiles, manifest, backupTarget, databaseUrl);
  }
  if (allFail && otherRelCount === 0) {
    const result = await runEmptyFlow(client, diskFiles, manifest);
    return { ...result, state: "LEDGER_EMPTY_RECOVERY", recoveryFlavor: "fresh" };
  }

  const failing = anchors.filter((a) => !a.pass).map((a) => `${a.version} ${a.label}`);
  throw new HardFailError(
    `LEDGER_EMPTY_RECOVERY: karışık/tutarsız durum (INCONSISTENT_PARTIAL) — allPass=${allPass} allFail=${allFail} otherRelCount=${otherRelCount}.\n` +
      (failing.length ? `  eksik anchor'lar: ${failing.join(", ")}` : ""),
  );
}

async function runMigration(
  client: PoolClient,
  diskFiles: MigrationFile[],
  backupTarget: { container: string; dbName: string; systemIdentifier: string },
  databaseUrl: string,
): Promise<MigrateReport> {
  const manifest = loadLegacyBaseline();
  const ledgerExistsRes = await client.query<{ exists: boolean }>(
    "select to_regclass('public.schema_migrations') is not null as exists",
  );
  const ledgerExists = ledgerExistsRes.rows[0]?.exists === true;

  if (!ledgerExists) {
    const anchors = await getAnchorResults(client);
    const allPass = anchors.every((a) => a.pass);
    const allFail = anchors.every((a) => !a.pass);
    const publicRelCount = await getPublicRelCount(client);

    if (allPass) {
      return runLegacyCompleteFlow(client, diskFiles, manifest, backupTarget);
    }
    if (allFail && publicRelCount === 0) {
      return runEmptyFlow(client, diskFiles, manifest);
    }
    const failing = anchors.filter((a) => !a.pass).map((a) => `${a.version} ${a.label}`);
    throw new HardFailError(
      `INCONSISTENT_PARTIAL: ledger yok, ama şema ne tam legacy ne tam boş (allPass=${allPass} allFail=${allFail} publicRelCount=${publicRelCount}).\n` +
        (failing.length ? `  eksik anchor'lar: ${failing.join(", ")}` : ""),
    );
  }

  const rowsRes = await client.query<LedgerRow>("select version, name, checksum from public.schema_migrations order by version");
  const rows = rowsRes.rows;

  if (rows.length === 0) {
    return runLedgerEmptyRecoveryFlow(client, diskFiles, manifest, backupTarget, databaseUrl);
  }

  const wellFormed = isLedgerWellFormed(rows, diskFiles);
  if (!wellFormed.ok) {
    throw new HardFailError(`INCONSISTENT_PARTIAL: ledger malformed:\n  ${wellFormed.reasons.join("\n  ")}`);
  }

  return runLedgerManagedFlow(client, diskFiles, rows, backupTarget);
}

function printReport(report: MigrateReport, connection: { database: string; user: string; systemIdentifier: string }): void {
  console.log("\n=== Migration raporu ===");
  console.log(`db=${connection.database} user=${connection.user} system_identifier=${connection.systemIdentifier}`);
  console.log(`state=${report.state}${report.recoveryFlavor ? ` (recovery: ${report.recoveryFlavor})` : ""}${report.recoveredThrough ? ` recovered_through=${report.recoveredThrough}` : ""}`);
  if (report.bootstrapped.length) console.log(`bootstrap (gerçek çalıştırma): ${report.bootstrapped.join(", ")}`);
  if (report.backfilled.length) console.log(`backfill (yalnız ledger kaydı): ${report.backfilled.join(", ")}`);
  if (report.pendingApplied.length) console.log(`pending uygulandı: ${report.pendingApplied.join(", ")}`);
  if (report.pendingApplied.length === 0 && report.bootstrapped.length === 0 && report.backfilled.length === 0) {
    console.log("Değişiklik yok — DB zaten güncel.");
  }
  if (report.backup) {
    console.log(`yedek: ${report.backup.path} (${report.backup.bytes} bayt, system_identifier=${report.backup.systemIdentifier})`);
  } else {
    console.log("yedek: alınmadı (EMPTY state veya pending yok — kaybedilecek/değişecek veri yok)");
  }
}

/**
 * AŞAMA 11 / B5 — bağlantı değişkeni HANGİ KAYNAKTAN geldi?
 *
 * `Bağlantı: db=… user=…` satırı hangi veritabanına bağlanıldığını zaten söylüyor, ama
 * NEDEN oraya bağlanıldığını söylemiyor. 2026-08-25 canlı denemesinde eksik olan tam olarak
 * buydu: `.env.local` düzeltildi, hata sürdü, çünkü eski oturumdaki `$env:DATABASE_URL`
 * kazanıyordu ve hiçbir çıktı bunu ima etmiyordu.
 *
 * NEDEN ÖLDÜRMÜYOR. Release kapıları (golden-fingerprint, real-clone-gate) hedefi BİLEREK
 * çocuk ortamda değiştirir; o gölgeleme kasıtlıdır ve bir hata değildir. Bu yüzden burada
 * uyarı, `pnpm db:env:source` CLI'ında ise exit 1. `MAS_ENV_SHADOW_STRICT=1` ile bu giriş de
 * durdurulabilir — cutover kabuğunda önerilen ayar budur.
 *
 * Değer yazdırılmaz; yalnız kaynak ve `kullanıcı@veritabanı` etiketi.
 */
function reportConnectionEnvSource(): void {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    return; // .env.local yok (CI) — karşılaştırılacak bir şey de yok.
  }
  const findings = inspectEnvSources(CONNECTION_ENV_NAMES, process.env, fileEnv);
  const shadowed = shadowedNames(findings);
  if (shadowed.length === 0) return;
  console.warn("ENV SHADOWING UYARISI — kabuk değeri .env.local'ı geçersiz kılıyor:");
  for (const finding of findings.filter((f) => f.shadowed)) {
    console.warn(`  ${describeEnvSource(finding)}`);
  }
  console.warn("  Kasıtlı değilse: yeni bir kabuk açın. Ayrıntı: pnpm db:env:source");
  if (process.env.MAS_ENV_SHADOW_STRICT === "1") {
    throw new HardFailError(
      `MAS_ENV_SHADOW_STRICT=1 ve gölgelenen değişken var (${shadowed.join(", ")}). ` +
        "Hiçbir SQL çalıştırılmadı.",
    );
  }
}

async function main(): Promise<void> {
  reportConnectionEnvSource();

  const databaseUrl = ownerDatabaseUrl();
  if (!databaseUrl) {
    throw new HardFailError("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");
  }

  const fileSet = validateFileSet();
  if (!fileSet.ok) {
    throw new HardFailError(`Dosya-seti doğrulaması başarısız, DB'ye hiç bağlanılmadı:\n  ${fileSet.errors.join("\n  ")}`);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const identRes = await client.query<{ current_database: string; current_user: string; system_identifier: string }>(
      "select current_database(), current_user, (select system_identifier from pg_control_system())::text as system_identifier",
    );
    const ident = identRes.rows[0];
    console.log(`Bağlantı: db=${ident.current_database} user=${ident.current_user} system_identifier=${ident.system_identifier}`);

    await checkAuthPrereqs(client);

    await client.query(ADVISORY_LOCK_SQL);
    try {
      const report = await runMigration(client, fileSet.files, {
        container: CONTAINER,
        dbName: ident.current_database,
        systemIdentifier: ident.system_identifier,
      }, databaseUrl);
      printReport(report, {
        database: ident.current_database,
        user: ident.current_user,
        systemIdentifier: ident.system_identifier,
      });

      const policyCountRes = await client.query<{ n: number }>(
        "select count(*)::int as n from pg_policies where schemaname='public' and tablename='schema_migrations'",
      );
      console.log(`schema_migrations üzerindeki pg_policies satır sayısı: ${policyCountRes.rows[0]?.n ?? 0}`);

      const ledgerRes = await client.query<{ version: string; name: string; applied_by: string }>(
        "select version, name, applied_by from public.schema_migrations order by version",
      );
      console.log(`\nLedger (${ledgerRes.rows.length} satır):`);
      for (const row of ledgerRes.rows) {
        console.log(`  ${row.version}  ${row.name}  (${row.applied_by})`);
      }
    } finally {
      await client.query(ADVISORY_UNLOCK_SQL);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("\nMIGRATION BAŞARISIZ:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
