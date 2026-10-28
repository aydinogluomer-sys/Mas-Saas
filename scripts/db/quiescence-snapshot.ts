// P24B / writer-surface-audit — deterministic READ-ONLY snapshot of a database.
//
// WHY THIS EXISTS. The writer audit had to prove that mas_radar_dev stops moving once every
// local writer is down. "I ran two counts and they matched" is not evidence anybody can re-check
// six weeks from now, so the measurement is a script and its output is a committed artifact.
//
// THE READ-ONLY PROMISE IS ENFORCED BY THE ENGINE, NOT BY THIS FILE'S GOOD INTENTIONS.
// Three layers, because a snapshot tool aimed at the real database is exactly the kind of thing
// that must not be able to write even when someone edits it carelessly later:
//
//   1. the connection asks for `default_transaction_read_only=on` as a startup option,
//   2. every statement runs inside an explicit `BEGIN READ ONLY`,
//   3. the transaction is ALWAYS closed with ROLLBACK — never COMMIT.
//
// The snapshot records `transaction_read_only` as MEASURED by the server (`show transaction_read_only`)
// rather than as intended, so the artifact carries proof of its own harmlessness.
//
// THE CONNECTION STRING IS NEVER PRINTED OR SERIALISED. It carries a password. Only the database
// NAME reaches the artifact — which is the part a reader actually needs.
//
// Usage:  node --import tsx scripts/db/quiescence-snapshot.ts <out.json> [label]
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { ownerDatabaseUrl } from "./owner-url";

interface TableSnapshot {
  table: string;
  rowCount: number;
  contentFingerprint: string;
}
interface Snapshot {
  label: string;
  timestampUtc: string;
  database: string;
  transactionReadOnly: string;
  migrationLedger: { table: string; maxVersion: string | null; count: number };
  tablesMeasured: number;
  tables: TableSnapshot[];
}

async function main(): Promise<void> {
  const out = process.argv[2];
  const label = process.argv[3] ?? "snapshot";
  if (!out) {
    console.error("kullanım: quiescence-snapshot.ts <out.json> [label]");
    process.exit(1);
  }

  const url = ownerDatabaseUrl();
  if (!url) {
    console.error("MIGRATION_DATABASE_URL (veya DATABASE_URL) tanımlı değil.");
    process.exit(1);
  }

  // Layer 1: the server refuses writes for this session before a single statement is sent.
  const pool = new Pool({
    connectionString: url,
    max: 1,
    options: "-c default_transaction_read_only=on",
  });

  const client = await pool.connect();
  try {
    // Layer 2.
    await client.query("begin read only");

    // Layer 3's proof: what the SERVER says, not what we asked for.
    const ro = (await client.query<{ transaction_read_only: string }>("show transaction_read_only"))
      .rows[0].transaction_read_only;
    const database = (await client.query<{ current_database: string }>("select current_database()"))
      .rows[0].current_database;

    const ledger = (
      await client.query<{ max_version: string | null; n: string }>(
        "select max(version) as max_version, count(*)::text as n from public.schema_migrations",
      )
    ).rows[0];

    // Deterministic table list: schema, then name.
    const tableRows = (
      await client.query<{ schema: string; name: string }>(
        `select table_schema as schema, table_name as name
           from information_schema.tables
          where table_type = 'BASE TABLE' and table_schema in ('public','auth')
          order by table_schema, table_name`,
      )
    ).rows;

    // One statement per table. The fingerprint orders rows by their own text form, so it does not
    // depend on physical row order — the thing that changes after a VACUUM without any data change.
    const tables: TableSnapshot[] = [];
    for (const t of tableRows) {
      const q = await client.query<{ n: string; fp: string }>(
        `select count(*)::text as n,
                coalesce(md5(string_agg(x::text, '|' order by x::text)), 'EMPTY') as fp
           from "${t.schema}"."${t.name}" x`,
      );
      tables.push({
        table: `${t.schema}.${t.name}`,
        rowCount: Number(q.rows[0].n),
        contentFingerprint: q.rows[0].fp,
      });
    }

    const snapshot: Snapshot = {
      label,
      timestampUtc: new Date().toISOString(),
      database,
      transactionReadOnly: ro,
      migrationLedger: {
        table: "public.schema_migrations",
        maxVersion: ledger.max_version,
        count: Number(ledger.n),
      },
      tablesMeasured: tables.length,
      tables,
    };

    writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    console.log(
      `${label}: ${database} · ${tables.length} tablo · ledger ${ledger.max_version}/${ledger.n} · read_only=${ro} -> ${out}`,
    );
  } finally {
    // Never COMMIT. Nothing to commit, and this makes that structural.
    await client.query("rollback").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
