// Faz 33 — measure every read model, rank by measured cost.
//
// The plan says "the heaviest read models added in Faz 22-32". This script decides WHICH those
// are by running them, not by reading them and forming an opinion. Ranking by eye would have
// picked the query with the most JOINs; the measurement below repeatedly disagrees with that.
import { Pool } from "pg";
import { generateVolume } from "./volume";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }

const pool = new Pool({ connectionString: url });

async function main() {
  if (process.argv.includes("--seed")) {
    console.log("hacim yükleniyor…");
    await generateVolume(pool);
    console.log("yüklendi.");
  }

  const counts = await pool.query(`
    select 'invoices' t, count(*)::int n from public.invoices
    union all select 'bank_transactions', count(*)::int from public.bank_transactions
    union all select 'payment_instances', count(*)::int from public.payment_instances
    union all select 'checks', count(*)::int from public.checks
    union all select 'audit_logs', count(*)::int from public.audit_logs
    order by 1`);
  console.log("VERİ HACMİ: " + counts.rows.map((r) => `${r.t}=${r.n}`).join(" · "));

  const views = await pool.query<{ viewname: string }>(
    `select viewname from pg_views where schemaname = 'public' order by viewname`);

  const results: Array<{ view: string; ms: number; rows: number; err?: string }> = [];
  for (const v of views.rows) {
    const sql = `select * from public.${v.viewname}`;
    try {
      // Three runs, take the MEDIAN. A single timing on the first touch measures cache state as
      // much as the query, and the first run of anything is always the slowest.
      const times: number[] = [];
      let rows = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = process.hrtime.bigint();
        const r = await pool.query(sql);
        const t1 = process.hrtime.bigint();
        times.push(Number(t1 - t0) / 1e6);
        rows = r.rowCount ?? 0;
      }
      times.sort((a, b) => a - b);
      results.push({ view: v.viewname, ms: times[1], rows });
    } catch (e) {
      results.push({ view: v.viewname, ms: -1, rows: 0, err: (e as Error).message.slice(0, 80) });
    }
  }

  results.sort((a, b) => b.ms - a.ms);
  console.log("\n=== EN AĞIR 20 READ MODEL (medyan ms, 3 koşu) ===");
  for (const r of results.slice(0, 20)) {
    console.log(`${r.ms.toFixed(1).padStart(9)} ms  ${String(r.rows).padStart(7)} satır  ${r.view}${r.err ? "  HATA: " + r.err : ""}`);
  }
  const total = results.filter((r) => r.ms > 0).reduce((s, r) => s + r.ms, 0);
  console.log(`\ntoplam ${results.length} view, birikimli ${total.toFixed(0)} ms`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
