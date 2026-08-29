// Faz 33 — measure every read model, rank by measured cost.
//
// The plan says "the heaviest read models added in Faz 22-32". This script decides WHICH those
// are by running them, not by reading them and forming an opinion. Ranking by eye would have
// picked the query with the most JOINs; the measurement below repeatedly disagrees with that.
import { Pool } from "pg";
import { generateVolume } from "./volume";
import { ownerDatabaseUrl, requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

/* ── P24B writer-surface audit — the gate this file was missing ───────────────────────────────
 *
 * WHAT WAS WRONG. This script read MIGRATION_DATABASE_URL raw — not even through
 * ownerDatabaseUrl() — opened a Pool on it, and with `--seed` called generateVolume(), which
 * INSERTs into nine tables including payments, payment_instances, invoices, bank_transactions
 * and checks. There was no disposable check of any kind. `.env.local` in this repository points
 * BOTH URLs at mas_radar_dev, and the operator's shell routinely exports them, so
 * `pnpm perf:measure --seed` wrote thousands of synthetic financial rows into the real database.
 * Same class as the roles-rls-verify defect fixed in 9844dd3, found by the same audit.
 *
 * WHY THE GATE IS ON `--seed` AND NOT ON THE WHOLE SCRIPT. Without `--seed` this file only runs
 * `select count(*)` and `select * from <view>`: it reads. Measuring read models against the REAL
 * data shape is the legitimate reason to reach for it during a perf investigation, and a
 * disposable-only rule would delete that capability and push people into ad-hoc psql instead —
 * strictly worse. So the gate sits exactly on the destructive capability, the same split
 * owner-url.ts already makes for migrate.ts.
 *
 * The gate runs BEFORE the Pool is constructed. A gate that fires after the connection is open
 * still lets a later edit slip a write in ahead of it; refusing before anything connects is the
 * property worth having.
 *
 * The read path is now engine-enforced read-only (`default_transaction_read_only=on`), so the
 * no-seed mode cannot write even if a future edit adds an UPDATE to the measurement loop.
 */
const SEEDING = process.argv.includes("--seed");

const url = SEEDING ? requireDisposableOwnerDatabaseUrl("perf:measure --seed") : ownerDatabaseUrl();
if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }

const pool = new Pool({
  connectionString: url,
  ...(SEEDING ? {} : { options: "-c default_transaction_read_only=on" }),
});

async function main() {
  if (SEEDING) {
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
