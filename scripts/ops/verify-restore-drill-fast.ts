// Faz 62 — Hızlı İzole Veritabanı Geri Yükleme Doğrulama Tatbikatı (Fast Isolated-DB DR Drill).
//
// Ne yapar:
//   1. `mas_radar_dev` veritabanından salt-okunur (`default_transaction_read_only=on`) referans
//      şema defteri, RLS tablo sayısı ve finansal toplamları (`payments`, `payment_instances`, vb.) okur.
//   2. `pg_dump -Fc` ile `backups/dr-verify-<timestamp>.dump` tam yedeğini alır, TOC okunabilirliğini
//      doğrular ve `<dump>.sha256` + `<dump>.stage07.json` (+ varsa `.enc`) yan dosyalarını yazar.
//   3. Yalnız harcanabilir `mas_radar_dr_verify_test` veritabanını oluşturur (`createDisposableLocalDb`)
//      ve yedeği bu izole hedefe geri yükler (`restoreIntoDisposableLocalDb`).
//   4. Geri yüklenen veritabanında `schema_migrations` (`122/0122`), tüm `public` tablolarında RLS
//      aktifliğini (`132` tablo), `payments` & `payment_instances` (ve ana finans tabloları) satır
//      sayıları ile parasal toplamların kaynakla birebir örtüştüğünü ve `mas_radar_app` çalışma
//      zamanı rolünün `get_schema_ledger_summary()` çağırabildiğini doğrular.
//   5. YALNIZ `mas_radar_dr_verify_test` veritabanını düşürür (`dropDisposableLocalDb`) ve kanıt
//      makbuzunu `backups/latest-restore-drill.json` olarak atomik yazar.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { checkSchemaParity, readExpectedSchemaManifest } from "../../src/lib/db/schema-parity";
import { encryptBackupFileAes256Gcm } from "../../src/lib/ops/backup-crypto";
import { readEnvLocal, swapDatabase } from "../db/app-url";
import { createBackupAdapter, withPgRuntimeConfig } from "../db/backup-adapter";
import {
  assertLocalPgReachable,
  createDisposableLocalDb,
  dropDisposableLocalDb,
  dumpDatabaseToFileLocal,
  listDumpLocal,
  resolveLocalOwnerUrl,
  restoreIntoDisposableLocalDb,
} from "../db/pg-local-admin";
import {
  formatBytes,
  sha256OfFile,
  writeBufferAtomic,
  writeSha256Sidecar,
  writeStage07Receipt,
  type Stage07Receipt,
} from "./backup-lib";

const SOURCE_DB = "mas_radar_dev";
const DISPOSABLE_DB = "mas_radar_dr_verify_test";

interface FinancialSnapshot {
  migrationCount: number;
  latestVersion: string | null;
  checksumDigest: string | null;
  totalTables: number;
  rlsTables: number;
  counts: Record<string, number>;
  aggregates: Record<string, string>;
}

async function readFinancialSnapshot(pool: Pool): Promise<FinancialSnapshot> {
  const [ledgerRes, rpcRes, tableRes, paymentsRes, instancesRes, invoicesRes, checksRes, loansRes, bankRes] =
    await Promise.all([
      pool.query<{ cnt: number; latest: string | null }>(
        `select count(*)::int as cnt, max(version)::text as latest from public.schema_migrations`,
      ),
      pool.query<{ checksum_digest: string | null }>(
        `select checksum_digest from public.get_schema_ledger_summary()`,
      ),
      pool.query<{ total_tables: number; rls_tables: number }>(
        `select count(*)::int as total_tables,
                count(*) filter (where c.relrowsecurity)::int as rls_tables
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind = 'r'`,
      ),
      pool.query<{ cnt: number; sum_default: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(default_amount), 0)::text as sum_default
           from public.payments`,
      ),
      pool.query<{ cnt: number; sum_amount: string; sum_paid: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(amount), 0)::text as sum_amount,
                coalesce(sum(paid_amount), 0)::text as sum_paid
           from public.payment_instances`,
      ),
      pool.query<{ cnt: number; sum_gross: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(gross_amount), 0)::text as sum_gross
           from public.invoices`,
      ),
      pool.query<{ cnt: number; sum_amount: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(amount), 0)::text as sum_amount
           from public.checks`,
      ),
      pool.query<{ cnt: number; sum_principal: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(principal), 0)::text as sum_principal
           from public.loans`,
      ),
      pool.query<{ cnt: number; sum_amount: string }>(
        `select count(*)::int as cnt,
                coalesce(sum(amount), 0)::text as sum_amount
           from public.bank_transactions`,
      ),
    ]);

  return {
    migrationCount: ledgerRes.rows[0]?.cnt ?? 0,
    latestVersion: ledgerRes.rows[0]?.latest ?? null,
    checksumDigest: rpcRes.rows[0]?.checksum_digest ?? null,
    totalTables: tableRes.rows[0]?.total_tables ?? 0,
    rlsTables: tableRes.rows[0]?.rls_tables ?? 0,
    counts: {
      payments: paymentsRes.rows[0]?.cnt ?? 0,
      payment_instances: instancesRes.rows[0]?.cnt ?? 0,
      invoices: invoicesRes.rows[0]?.cnt ?? 0,
      checks: checksRes.rows[0]?.cnt ?? 0,
      loans: loansRes.rows[0]?.cnt ?? 0,
      bank_transactions: bankRes.rows[0]?.cnt ?? 0,
    },
    aggregates: {
      "payments.default_amount": paymentsRes.rows[0]?.sum_default ?? "0",
      "payment_instances.amount": instancesRes.rows[0]?.sum_amount ?? "0",
      "payment_instances.paid_amount": instancesRes.rows[0]?.sum_paid ?? "0",
      "invoices.gross_amount": invoicesRes.rows[0]?.sum_gross ?? "0",
      "checks.amount": checksRes.rows[0]?.sum_amount ?? "0",
      "loans.principal": loansRes.rows[0]?.sum_principal ?? "0",
      "bank_transactions.amount": bankRes.rows[0]?.sum_amount ?? "0",
    },
  };
}

export function writeDrillReceiptAtomic(
  filePath: string,
  payload: unknown,
  opts: { renameImpl?: (oldPath: string, newPath: string) => void } = {},
): void {
  const resolved = path.resolve(filePath);
  const buf = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeBufferAtomic(resolved, buf, { renameImpl: opts.renameImpl });
}

function readGitState(): { sha: string; branch: string; clean: boolean } {
  const run = (args: string[]): string => {
    try {
      return execFileSync("git", args, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    sha: run(["rev-parse", "HEAD"]) || "(git yok)",
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]) || "(git yok)",
    clean: run(["status", "--porcelain"]) === "",
  };
}

export async function runFastRestoreDrill(): Promise<void> {
  if ((DISPOSABLE_DB as string) === SOURCE_DB) {
    throw new Error("GÜVENLİK DURDURMASI: Harcanabilir hedef kaynak veritabanıyla aynı olamaz.");
  }

  const startedAt = Date.now();
  assertLocalPgReachable();

  const envLocal = (() => {
    try {
      return readEnvLocal();
    } catch {
      return {};
    }
  })();

  const expectedManifest = readExpectedSchemaManifest();
  const expectedLedger = `${expectedManifest.expectedCount}/${expectedManifest.expectedLatestVersion}`;
  const sourceOwnerUrl = resolveLocalOwnerUrl(SOURCE_DB);
  const disposableOwnerUrl = resolveLocalOwnerUrl(DISPOSABLE_DB);

  const backupDir = path.resolve(process.env.MAS_BACKUP_DIR?.trim() || envLocal.MAS_BACKUP_DIR?.trim() || "backups");
  mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpFileName = `dr-verify-${stamp}.dump`;
  const dumpPath = path.join(backupDir, dumpFileName);
  const drillReceiptPath = path.join(backupDir, "latest-restore-drill.json");

  const sourcePool = new Pool({
    connectionString: sourceOwnerUrl,
    max: 2,
    options: "-c default_transaction_read_only=on",
  });

  let disposableCreated = false;
  let disposableDropped = false;

  try {
    console.log(`=== MAS Hızlı İzole DR Geri Yükleme Doğrulaması ===`);
    console.log(`Kaynak (salt-okunur) : ${SOURCE_DB}`);
    console.log(`İzole harcanabilir DB: ${DISPOSABLE_DB}`);
    console.log(`Beklenen şema defteri: ${expectedLedger}`);

    const [srcMetaRes, srcSnap] = await Promise.all([
      sourcePool.query<{ db: string; sysid: string; ver: string }>(
        `select current_database() as db,
                (select system_identifier::text from pg_control_system()) as sysid,
                version() as ver`,
      ),
      readFinancialSnapshot(sourcePool),
    ]);
    const srcMeta = srcMetaRes.rows[0]!;
    if (srcMeta.db !== SOURCE_DB) {
      throw new Error(`Beklenen kaynak '${SOURCE_DB}', bağlanılan '${srcMeta.db}'.`);
    }

    const srcLedger = `${srcSnap.migrationCount}/${srcSnap.latestVersion ?? "yok"}`;
    if (
      srcSnap.migrationCount !== expectedManifest.expectedCount ||
      srcSnap.latestVersion !== expectedManifest.expectedLatestVersion
    ) {
      throw new Error(
        `Kaynak veritabanı şema defteri (${srcLedger}) beklenen manifestle (${expectedLedger}) eşleşmiyor.`,
      );
    }

    console.log(`\n[1/5] pg_dump -Fc ile tam yedek alınıyor: ${dumpFileName}`);
    dumpDatabaseToFileLocal(sourceOwnerUrl, dumpPath);

    if (!existsSync(dumpPath)) {
      throw new Error(`Yedek dosyası üretilemedi: ${dumpPath}`);
    }
    const dumpBytes = statSync(dumpPath).size;
    if (dumpBytes <= 0) {
      throw new Error(`Yedek dosyası boş (0 bayt): ${dumpPath}`);
    }
    const dumpSha256 = sha256OfFile(dumpPath);
    const tocRaw = listDumpLocal(dumpPath);
    const tocLines = tocRaw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith(";"));
    if (tocLines.length === 0) {
      throw new Error("pg_restore --list sıfır TOC girdisi döndürdü.");
    }

    const pgEnv = withPgRuntimeConfig(process.env, envLocal);
    const adapter = createBackupAdapter({ ownerUrl: sourceOwnerUrl, env: pgEnv });
    const toolVersions = adapter.readToolVersions(SOURCE_DB);
    const git = readGitState();

    const stage07Receipt: Stage07Receipt = {
      receiptKind: "mas-stage07-backup-receipt-v1",
      timestamp: new Date().toISOString(),
      source_db: SOURCE_DB,
      system_identifier: srcMeta.sysid,
      git_sha: git.sha,
      schema_ledger: srcLedger,
      file_size: dumpBytes,
      sha256: dumpSha256,
      pg_version: toolVersions.pgVersion,
      pg_dump_version: toolVersions.pgDumpVersion,
      git_branch: git.branch,
      git_tree_clean: git.clean,
      dump_path: path.resolve(dumpPath),
      strict_receipt_path: null,
      strict_receipt_sha256: null,
      data_class: "REAL_READ_ONLY",
      backup_source: adapter.sourceLabel,
    };
    writeStage07Receipt(`${dumpPath}.stage07.json`, stage07Receipt);
    writeSha256Sidecar(dumpPath, dumpSha256);

    const encryptionKey = (process.env.BACKUP_ENCRYPTION_KEY ?? envLocal.BACKUP_ENCRYPTION_KEY ?? "").trim();
    if (encryptionKey.length >= 16) {
      encryptBackupFileAes256Gcm(dumpPath, `${dumpPath}.enc`, encryptionKey);
    }

    console.log(
      `      Yedek hazır: ${formatBytes(dumpBytes)} · sha256=${dumpSha256.slice(0, 16)}… · TOC=${tocLines.length} satır`,
    );

    console.log(`[2/5] İzole '${DISPOSABLE_DB}' veritabanı hazırlanıyor...`);
    dropDisposableLocalDb(DISPOSABLE_DB);
    createDisposableLocalDb(DISPOSABLE_DB);
    disposableCreated = true;

    console.log(`[3/5] '${DISPOSABLE_DB}' içine pg_restore uygulanıyor...`);
    const restoreOutcome = restoreIntoDisposableLocalDb(DISPOSABLE_DB, dumpPath);
    if (restoreOutcome.warned) {
      console.log(`      (pg_restore bilgi uyarısıyla tamamlandı)`);
    }

    console.log(`[4/5] Geri yüklenen şema, RLS ve finansal toplamlar doğrulanıyor...`);
    const restoredPool = new Pool({ connectionString: disposableOwnerUrl, max: 2 });
    let dstSnap: FinancialSnapshot;
    try {
      dstSnap = await readFinancialSnapshot(restoredPool);
    } finally {
      await restoredPool.end();
    }

    let runtimeRoleParityVerified = false;
    const rawRuntimeUrl = (process.env.DATABASE_URL ?? envLocal.DATABASE_URL ?? "").trim();
    if (rawRuntimeUrl) {
      const restoredAppUrl = swapDatabase(rawRuntimeUrl, DISPOSABLE_DB);
      const restoredAppPool = new Pool({ connectionString: restoredAppUrl, max: 1 });
      try {
        const parity = await checkSchemaParity(restoredAppPool);
        const roleCheck = await restoredAppPool.query<{
          session_user: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `select session_user, r.rolsuper, r.rolbypassrls
             from pg_roles r
            where r.rolname = session_user`,
        );
        const roleRow = roleCheck.rows[0];
        runtimeRoleParityVerified =
          parity.aligned &&
          roleRow?.session_user === "mas_radar_app" &&
          roleRow.rolsuper === false &&
          roleRow.rolbypassrls === false;
      } finally {
        await restoredAppPool.end();
      }
    }

    const dstLedger = `${dstSnap.migrationCount}/${dstSnap.latestVersion ?? "yok"}`;
    const ledgerMatched =
      dstSnap.migrationCount === expectedManifest.expectedCount &&
      dstSnap.latestVersion === expectedManifest.expectedLatestVersion &&
      dstSnap.checksumDigest !== null &&
      dstSnap.checksumDigest === srcSnap.checksumDigest;

    const rlsMatched =
      dstSnap.totalTables === srcSnap.totalTables &&
      dstSnap.rlsTables === dstSnap.totalTables &&
      dstSnap.rlsTables >= 132;

    const countMismatches = Object.keys(srcSnap.counts).filter(
      (k) => srcSnap.counts[k] !== dstSnap.counts[k],
    );
    const aggregateMismatches = Object.keys(srcSnap.aggregates).filter(
      (k) => srcSnap.aggregates[k] !== dstSnap.aggregates[k],
    );

    const countsMatched = countMismatches.length === 0;
    const aggregatesMatched = aggregateMismatches.length === 0;

    console.log(`      Şema defteri   : ${dstLedger} (checksum=${dstSnap.checksumDigest?.slice(0, 16) ?? "?"}…)`);
    console.log(`      Tablo & RLS    : ${dstSnap.totalTables} tablo / ${dstSnap.rlsTables} RLS aktif`);
    console.log(
      `      payments       : ${dstSnap.counts.payments} satır · toplam=${dstSnap.aggregates["payments.default_amount"]}`,
    );
    console.log(
      `      payment_inst.  : ${dstSnap.counts.payment_instances} satır · tutar=${dstSnap.aggregates["payment_instances.amount"]} · ödenen=${dstSnap.aggregates["payment_instances.paid_amount"]}`,
    );
    console.log(`      Runtime rolü   : ${runtimeRoleParityVerified ? "DOĞRULANDI (mas_radar_app)" : "ATLANDI/BAŞARISIZ"}`);

    console.log(`[5/5] Yalnız harcanabilir '${DISPOSABLE_DB}' veritabanı temizleniyor...`);
    dropDisposableLocalDb(DISPOSABLE_DB);
    disposableDropped = true;

    const passed =
      ledgerMatched &&
      rlsMatched &&
      countsMatched &&
      aggregatesMatched &&
      (rawRuntimeUrl === "" || runtimeRoleParityVerified);

    const durationMs = Date.now() - startedAt;
    const drillReceipt = {
      receiptKind: "mas-fast-restore-drill-v1",
      verifiedAt: new Date().toISOString(),
      sourceDb: SOURCE_DB,
      isolatedDb: DISPOSABLE_DB,
      isolatedDbDropped: disposableDropped,
      dumpFile: dumpFileName,
      dumpBytes,
      dumpSha256,
      schemaLedger: dstLedger,
      checksumDigest: dstSnap.checksumDigest,
      tablesVerified: dstSnap.totalTables,
      rlsTablesVerified: dstSnap.rlsTables,
      countsMatched,
      aggregatesMatched,
      runtimeRoleParityVerified,
      counts: dstSnap.counts,
      aggregates: dstSnap.aggregates,
      durationMs,
      passed,
    };

    writeDrillReceiptAtomic(drillReceiptPath, drillReceipt);
    console.log(`\nMakbuz yazıldı: ${drillReceiptPath}`);

    if (!passed) {
      const reasons: string[] = [];
      if (!ledgerMatched) reasons.push(`şema defteri uyumsuz (${dstLedger} vs ${expectedLedger})`);
      if (!rlsMatched) reasons.push(`RLS tablo sayısı uyumsuz (${dstSnap.rlsTables}/${dstSnap.totalTables})`);
      if (!countsMatched) reasons.push(`satır sayısı farkı: ${countMismatches.join(", ")}`);
      if (!aggregatesMatched) reasons.push(`toplam farkı: ${aggregateMismatches.join(", ")}`);
      if (rawRuntimeUrl !== "" && !runtimeRoleParityVerified) {
        reasons.push("mas_radar_app şema paritesi doğrulanamadı");
      }
      throw new Error(`DR geri yükleme doğrulaması BAŞARISIZ: ${reasons.join("; ")}`);
    }

    console.log(`FAST RESTORE DRILL: PASS (${durationMs}ms · ${dstLedger} · ${dstSnap.rlsTables} RLS tablo)`);
  } finally {
    await sourcePool.end().catch(() => undefined);
    if (disposableCreated && !disposableDropped) {
      try {
        dropDisposableLocalDb(DISPOSABLE_DB);
        console.log(`Harcanabilir DB temizlendi (finally): ${DISPOSABLE_DB}`);
      } catch (cleanupErr) {
        console.error(
          `Harcanabilir DB temizlenemedi (${DISPOSABLE_DB}): ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }`,
        );
      }
    }
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
  runFastRestoreDrill().catch((err) => {
    console.error("FAST RESTORE DRILL FAIL:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
