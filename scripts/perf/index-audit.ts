// Faz 33 — index audit.
//
// Three questions, each answered from the catalog rather than from an opinion:
//
//   1. Which FOREIGN KEY columns have no index? This is the one that actually bites: PostgreSQL
//      indexes the referenced side automatically (it is a primary key) but NOT the referencing
//      side, so every `delete from parties` scans every table that points at it, and every join
//      from child to parent does the same.
//   2. Which indexes are REDUNDANT — a strict column-prefix of another index on the same table?
//      Each one costs write time and planning time and buys nothing the wider index does not.
//   3. Which indexes are UNUSED? Reported, but honestly caveated: on a freshly migrated database
//      every counter is zero, so a gate must never fail on this. It is information for the
//      operator running it against a live system, not a pass/fail.
import type { Pool } from "pg";

export interface UnindexedForeignKey {
  table: string;
  constraint: string;
  columns: string[];
}
export interface RedundantIndex {
  table: string;
  narrow: string;
  wider: string;
  columns: string;
}
export interface UnusedIndex {
  table: string;
  index: string;
  scans: number;
  sizeBytes: number;
}

/**
 * Foreign keys whose referencing columns have no index starting with them.
 *
 * "Starting with" matters: an index on (party_id, issue_date) DOES serve a foreign key on
 * party_id, because a btree can use any leading prefix. Requiring an exact match would report
 * dozens of false positives and train everyone to ignore the report.
 */
export async function unindexedForeignKeys(pool: Pool): Promise<UnindexedForeignKey[]> {
  const res = await pool.query(`
    with fk as (
      select c.oid, c.conname, c.conrelid::regclass::text as tbl, c.conkey
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where c.contype = 'f' and n.nspname = 'public'
    ),
    fk_cols as (
      select fk.oid, fk.conname, fk.tbl, fk.conkey,
             (select array_agg(a.attname order by k.ord)
                from unnest(fk.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = (fk.tbl)::regclass and a.attnum = k.attnum
             ) as colnames
      from fk
    )
    select f.tbl, f.conname, f.colnames
    from fk_cols f
    where not exists (
      select 1 from pg_index i
      where i.indrelid = (f.tbl)::regclass
        -- leading-prefix match: the FK columns must be the FIRST columns of the index
        and (i.indkey::int2[])[0:array_length(f.conkey,1)-1] = f.conkey
    )
    order by f.tbl, f.conname`);
  return res.rows.map((r) => ({
    table: r.tbl as string,
    constraint: r.conname as string,
    // This subquery returns the aggregate as a Postgres array LITERAL ('{a,b}'), not as a mapped
    // array — measured, not assumed: the first run crashed calling .join() on a string, and the
    // second printed "{created_by}" with the braces. Both forms are handled.
    columns: Array.isArray(r.colnames)
      ? (r.colnames as string[])
      : r.colnames == null
        ? []
        : String(r.colnames).replace(/^\{|\}$/g, "").split(",").filter(Boolean),
  }));
}

/** Indexes that are a strict leading prefix of another index on the same table. */
export async function redundantIndexes(pool: Pool): Promise<RedundantIndex[]> {
  const res = await pool.query(`
    select t.relname as tbl,
           ai.relname as narrow, bi.relname as wider,
           a.indkey::text as cols
    from pg_index a
    join pg_index b on a.indrelid = b.indrelid and a.indexrelid <> b.indexrelid
    join pg_class ai on ai.oid = a.indexrelid
    join pg_class bi on bi.oid = b.indexrelid
    join pg_class t on t.oid = a.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and not a.indisprimary and not a.indisunique
      and array_length(b.indkey::int2[], 1) > array_length(a.indkey::int2[], 1)
      and (b.indkey::int2[])[0:array_length(a.indkey::int2[],1)-1] = a.indkey::int2[]
      -- partial indexes answer a different question; never call one redundant
      and a.indpred is null and b.indpred is null
    order by t.relname, ai.relname`);
  return res.rows.map((r) => ({
    table: r.tbl as string, narrow: r.narrow as string,
    wider: r.wider as string, columns: r.cols as string,
  }));
}

/**
 * Indexes never used since statistics were last reset.
 *
 * INFORMATIONAL ONLY. On a database that was migrated an hour ago this returns everything, which
 * is why nothing in the gate is allowed to fail on it — a check that reports "drop all 140
 * indexes" on a fresh install is not a check, it is a trap.
 */
export async function unusedIndexes(pool: Pool): Promise<UnusedIndex[]> {
  const res = await pool.query(`
    select s.relname as tbl, s.indexrelname as idx, s.idx_scan::bigint as scans,
           pg_relation_size(s.indexrelid)::bigint as bytes
    from pg_stat_user_indexes s
    join pg_index i on i.indexrelid = s.indexrelid
    where s.schemaname = 'public' and not i.indisprimary and not i.indisunique
      and s.idx_scan = 0
    order by pg_relation_size(s.indexrelid) desc`);
  return res.rows.map((r) => ({
    table: r.tbl as string, index: r.idx as string,
    scans: Number(r.scans), sizeBytes: Number(r.bytes),
  }));
}

async function main() {
  const { Pool } = await import("pg");
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const pool = new Pool({ connectionString: url });

  const fks = await unindexedForeignKeys(pool);
  console.log(`\n=== İNDEKSSİZ YABANCI ANAHTARLAR (${fks.length}) ===`);
  for (const f of fks) console.log(`  ${f.table}.(${f.columns.join(", ")})  [${f.constraint}]`);
  if (fks.length === 0) console.log("  yok");

  const red = await redundantIndexes(pool);
  console.log(`\n=== GEREKSİZ (ÖN-EK) İNDEKSLER (${red.length}) ===`);
  for (const r of red) console.log(`  ${r.table}: ${r.narrow} ⊂ ${r.wider}`);
  if (red.length === 0) console.log("  yok");

  const un = await unusedIndexes(pool);
  console.log(`\n=== HİÇ KULLANILMAMIŞ İNDEKSLER (${un.length}) — YALNIZCA BİLGİ ===`);
  console.log("  (taze migrate edilmiş bir DB'de hepsi sıfırdır; bu bir hata değildir)");
  for (const u of un.slice(0, 15)) {
    console.log(`  ${u.table}.${u.index}  ${(u.sizeBytes / 1024).toFixed(0)} KB`);
  }

  await pool.end();
}

if (process.argv[1] && process.argv[1].endsWith("index-audit.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
