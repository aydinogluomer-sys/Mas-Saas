// Faz 5/6 — the fingerprint, shared by the cutover rehearsal and the restore drill.
//
// Extracted from scripts/release/golden-fingerprint.ts when Faz 6 needed the same measurements to
// answer a different question ("does the restored copy match the source?" rather than "did the
// migration change anything?"). Two copies of a hash definition is how two answers that must agree
// quietly stop agreeing, so there is one.

import type { Pool } from "pg";

export interface Fingerprint {
  counts: Record<string, number>;
  columns: Record<string, string[]>;
  hashes: Record<string, string>;
  aggregates: Record<string, string>;
  roleCounts: Record<string, number>;
  ledger: { rows: number; latest: string | null };
}

/**
 * Everything §8.2 asks for, in one pass.
 *
 * The row hash is computed over an EXPLICIT column list rather than `t::text`, and that choice is
 * what makes the pre/post comparison meaningful. A migration that adds a column changes every
 * row's text representation, so a whole-row hash would report "all data changed" on a migration
 * that changed no data at all — and an operator who sees that once learns to ignore it. Hashing
 * the columns that existed BEFORE the migration lets schema additions through (they are
 * whitelisted) while still catching any value that moved.
 *
 * The hash is order-independent (`string_agg(... order by h)`) so a different physical row order
 * after a restore is not mistaken for a data change.
 */
export async function fingerprint(pool: Pool, columnsFrom?: Record<string, string[]>): Promise<Fingerprint> {
  const tables: string[] = (await pool.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  )).rows.map((r: { relname: string }) => r.relname);

  const counts: Record<string, number> = {};
  const columns: Record<string, string[]> = {};
  const hashes: Record<string, string> = {};

  for (const t of tables) {
    counts[t] = Number((await pool.query(`select count(*) n from public.${t}`)).rows[0].n);

    const live: string[] = (await pool.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = $1 order by column_name`, [t],
    )).rows.map((r: { column_name: string }) => r.column_name);
    columns[t] = live;

    // On the POST pass, project exactly what the PRE pass hashed.
    const wanted = columnsFrom?.[t] ?? live;
    const usable = wanted.filter((c) => live.includes(c));
    if (usable.length === 0) { hashes[t] = "(kolon yok)"; continue; }

    const projection = usable.map((c) => `t.${JSON.stringify(c).replace(/"/g, '"')}`).join(", ");
    hashes[t] = (await pool.query(
      `select coalesce(md5(string_agg(h, '' order by h)), 'bos') hash
       from (select md5((${projection})::text) h from public.${t} t) s`,
    )).rows[0].hash;
  }

  const aggregates: Record<string, string> = {};
  for (const [label, sql] of [
    ["payments.default_amount", `select coalesce(sum(default_amount), 0)::text v from public.payments`],
    ["payment_instances.amount", `select coalesce(sum(amount), 0)::text v from public.payment_instances`],
    ["checks.amount", `select coalesce(sum(amount), 0)::text v from public.checks`],
    ["loans.principal", `select coalesce(sum(principal), 0)::text v from public.loans`],
    ["loan_installments.amount", `select coalesce(sum(amount), 0)::text v from public.loan_installments`],
    ["cashflow_months.closing_balance", `select coalesce(sum(closing_balance), 0)::text v from public.cashflow_months`],
  ] as const) {
    try {
      aggregates[label] = (await pool.query(sql)).rows[0].v;
    } catch {
      aggregates[label] = "(tablo/kolon yok)";
    }
  }

  const roleCounts: Record<string, number> = {};
  for (const r of (await pool.query(`select role, count(*)::int n from public.users group by role order by role`)).rows) {
    roleCounts[(r as { role: string }).role] = (r as { n: number }).n;
  }

  const ledgerRow = (await pool.query(
    `select count(*)::int rows, max(version) latest from public.schema_migrations`,
  )).rows[0] as { rows: number; latest: string | null };

  return { counts, columns, hashes, aggregates, roleCounts, ledger: ledgerRow };
}
