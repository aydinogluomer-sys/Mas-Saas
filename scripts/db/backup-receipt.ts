// P0-B Slice 5 — wraps the existing backupDockerPostgres() (Slice 2, unmodified) with an
// atomically-written sidecar receipt: the dump's own SHA-256, the DB's system_identifier,
// ledger state, and DB-clock (not Node-clock) timestamps bracketing the backup — so
// legacy-repair-apply.ts's freshness check never depends on this host's own clock.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { backupDockerPostgres } from "./backup-docker-postgres";
import { BackupReceiptSchema, CANONICALIZATION_VERSION, fileSha256, writeViaTempAndRename } from "./legacy-repair-types";

const TO_CHAR_INSTANT = `to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function dbUrl(dbName: string): string {
  return `postgres://postgres:postgres@127.0.0.1:5432/${dbName}`;
}

async function readDbTimestamp(pool: Pool): Promise<string> {
  const r = await pool.query<{ ts: string }>(`select ${TO_CHAR_INSTANT} as ts`);
  return r.rows[0].ts;
}

async function main(): Promise<void> {
  const [container, dbName, label, outDir] = process.argv.slice(2);
  if (!container || !dbName || !label) {
    console.error("Kullanım: tsx scripts/db/backup-receipt.ts <container> <dbName> <label> [outDir]");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl(dbName), max: 1 });
  try {
    const backupStartedDbTimestamp = await readDbTimestamp(pool);

    const backupResult = await backupDockerPostgres({ container, dbName, label, outDir });

    const backupCompletedDbTimestamp = await readDbTimestamp(pool);

    const identity = await pool.query<{ sysid: string }>(
      `select system_identifier::text as sysid from pg_control_system()`,
    );
    const ledger = await pool.query<{ n: string; last_version: string | null }>(
      `select count(*)::text as n, max(version) as last_version from public.schema_migrations`,
    );
    if (!ledger.rows[0].last_version) {
      throw new Error("schema_migrations boş — backup receipt yalnız uygulanmış bir ledger için üretilir.");
    }

    const dumpBytes = readFileSync(backupResult.path);
    const sha256 = fileSha256(dumpBytes);

    const receiptPath = `${backupResult.path}.receipt.json`;
    writeViaTempAndRename(
      receiptPath,
      (durability) => {
        const receipt = {
          canonicalizationVersion: CANONICALIZATION_VERSION,
          path: path.resolve(backupResult.path),
          bytes: backupResult.bytes,
          sha256,
          databaseName: dbName,
          systemIdentifier: identity.rows[0].sysid,
          ledgerCount: Number(ledger.rows[0].n),
          lastMigrationVersion: ledger.rows[0].last_version,
          backupStartedDbTimestamp,
          backupCompletedDbTimestamp,
          durability,
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
    const receiptSha256 = fileSha256(readFileSync(receiptPath));

    console.log(`Backup tamam: ${backupResult.path} (${backupResult.bytes} bayt, sha256=${sha256})`);
    console.log(`Backup receipt yazıldı: ${receiptPath}`);
    console.log(`  receipt fileSha256: ${receiptSha256}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
