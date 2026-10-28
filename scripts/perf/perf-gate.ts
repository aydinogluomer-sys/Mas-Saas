// Faz 14 — the performance GATE. The Faz 33 tools next to this file (measure.ts, index-audit.ts,
// volume.ts) MEASURE and rank; they never fail. This turns the measurements that actually predict
// scalability into pass/fail assertions, run against a disposable database loaded with realistic
// volume so the planner behaves the way it will in production rather than seq-scanning a table that
// fits on one page.
//
// WHAT IT ASSERTS, AND WHY EACH ONE IS DETERMINISTIC RATHER THAN A WALL-CLOCK GUESS.
//
//   1. QUERY PLANS on the hot-path access patterns. Each check is a SELECTIVE query — the shape a
//      route actually issues ("what is due soon", "open invoices") — and asserts the large table it
//      touches is reached by an INDEX scan, never a Seq Scan. A wall-clock SLO would move with the
//      runner; a plan shape does not. A seq scan over 60.000 bank_transactions to answer "the last
//      7 days" is a regression on any machine, and that is exactly what this catches. NOT asserted
//      as "no seq scan anywhere": a view that returns a whole table SHOULD scan it, so blanket
//      no-seq-scan would be wrong. Selective-query-must-use-index is the correct, narrower claim.
//
//   2. REDUNDANT indexes = 0. A strict prefix of another index buys nothing and costs write time;
//      deterministic from the catalog.
//
//   3. UNINDEXED foreign keys held at or below a measured BASELINE (a ratchet). There are 115 today
//      — reported honestly, not hidden — and they are lower priority precisely because check (1)
//      proves the read hot paths are already served by purpose-built covering indexes, not by these
//      FK columns (they are source_*/created_by/resolved_by columns the critical reads never join
//      on). The ratchet's job is narrow and real: a future migration that adds a foreign key and
//      forgets its index pushes the count to 116 and fails here, which is the single most common
//      way this class of regression is introduced.
//
//   4. A GENEROUS catastrophe ceiling on execution time. The selective queries run in single-digit
//      milliseconds; the ceiling exists only to catch total breakage (an accidental O(n²) that
//      somehow keeps an index in its plan), and is set high enough that a slow CI runner never
//      trips it. It is a backstop, not the gate — checks (1)-(3) are.
//
// Usage (target MUST carry a disposable marker; provision + migrate it first):
//   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mas_radar_perf_verify \
//     pnpm perf:gate

import { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";
import { generateVolume } from "./volume";
import { redundantIndexes, unindexedForeignKeys } from "./index-audit";

const url = requireDisposableOwnerDatabaseUrl("perf:gate");
const pool = new Pool({ connectionString: url });

// Measured on schema head (0087). A ratchet, not an aspiration: see the header, point 3.
const BASELINE_UNINDEXED_FK_COUNT = 115;
// Backstop only. Selective queries below run in ~1-2 ms; this catches total breakage, not drift.
const CATASTROPHE_MS = 3000;

interface Selective { label: string; table: string; sql: string }

// Every query here is FILTERED the way a route filters, and every `table` is a large table
// (≥6.000 rows at DEFAULT_SCALE) that MUST be reached by an index for the filter to scale.
const SELECTIVE_QUERIES: Selective[] = [
  {
    label: "vadesi yaklaşan ödeme kalemleri (status + due_date)",
    table: "payment_instances",
    sql: "select * from public.payment_instances where status='unpaid' and due_date >= current_date",
  },
  {
    label: "açık faturalar (status + due_date)",
    table: "invoices",
    sql: "select * from public.invoices where status='open' and due_date >= current_date",
  },
  {
    label: "son 7 gün banka hareketleri (txn_date penceresi)",
    table: "bank_transactions",
    sql: "select * from public.bank_transactions where txn_date >= current_date - 7",
  },
  {
    label: "yaklaşan çekler (status + maturity_date)",
    table: "checks",
    sql: "select * from public.checks where status='planned' and maturity_date >= current_date",
  },
];

interface Outcome { name: string; pass: boolean; detail: string }
const results: Outcome[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

interface PlanNode { "Node Type"?: string; "Relation Name"?: string; Plans?: PlanNode[] }
function collectScans(node: PlanNode | undefined, out: Array<{ type: string; rel: string }>): void {
  if (!node) return;
  if (node["Node Type"] && node["Relation Name"]) {
    out.push({ type: node["Node Type"], rel: node["Relation Name"] });
  }
  for (const child of node.Plans ?? []) collectScans(child, out);
}

async function main(): Promise<void> {
  console.log("=== perf-gate: disposable-DB performance gate (Faz 14) ===\n");

  console.log("gerçekçi hacim yükleniyor (deterministik; generate_series)…");
  await generateVolume(pool); // idempotent; ends with VACUUM ANALYZE so plans are production-like
  const vol = await pool.query<{ t: string; n: number }>(`
    select 'payment_instances' t, count(*)::int n from public.payment_instances
    union all select 'invoices', count(*)::int from public.invoices
    union all select 'bank_transactions', count(*)::int from public.bank_transactions
    union all select 'checks', count(*)::int from public.checks
    order by 1`);
  console.log("hacim: " + vol.rows.map((r) => `${r.t}=${r.n}`).join(" · ") + "\n");

  // ── 1) query plans: each selective hot-path query must reach its large table via an index ──
  for (const q of SELECTIVE_QUERIES) {
    const res = await pool.query(`explain (analyze, format json) ${q.sql}`);
    const raw = res.rows[0]["QUERY PLAN"];
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const root = parsed[0].Plan as PlanNode;
    const execMs = Number(parsed[0]["Execution Time"]);

    const scans: Array<{ type: string; rel: string }> = [];
    collectScans(root, scans);
    // A Bitmap Heap Scan IS index-driven: its Bitmap Index Scan child carries the index and is
    // keyed by "Index Name", not "Relation Name", so it never appears in `onTable`. The correct
    // claim is "every access to this table is index-driven" — which excludes Seq Scan and admits
    // the three index-driven heap access types.
    const INDEX_DRIVEN = new Set(["Index Scan", "Index Only Scan", "Bitmap Heap Scan"]);
    const onTable = scans.filter((s) => s.rel === q.table);
    const indexed = onTable.length > 0 && onTable.every((s) => INDEX_DRIVEN.has(s.type));

    record(
      `plan: ${q.label} → ${q.table} indeks ile okunuyor (Seq Scan değil)`,
      indexed,
      onTable.map((s) => s.type).join(", ") || "(tabloya erişim yok)",
    );
    record(
      `SLO: ${q.label} felaket eşiği altında`,
      execMs < CATASTROPHE_MS,
      `${execMs.toFixed(1)} ms (eşik ${CATASTROPHE_MS} ms)`,
    );
  }

  // ── 2) redundant indexes = 0 ──────────────────────────────────────────────────────────────
  const redundant = await redundantIndexes(pool);
  record("gereksiz (ön-ek) indeks yok", redundant.length === 0,
    redundant.length === 0 ? "0" : redundant.map((r) => `${r.narrow}⊂${r.wider}`).join(", "));

  // ── 3) unindexed FK ratchet ─────────────────────────────────────────────────────────────
  const fks = await unindexedForeignKeys(pool);
  record(
    `indekssiz yabancı anahtar sayısı taban çizgisini aşmıyor (≤ ${BASELINE_UNINDEXED_FK_COUNT})`,
    fks.length <= BASELINE_UNINDEXED_FK_COUNT,
    `${fks.length} (taban ${BASELINE_UNINDEXED_FK_COUNT}). Yeni bir indekssiz FK bu kapıyı kırar.`,
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error("PERF GATE FAIL:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PERF GATE: ALL PASS");
  await pool.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("perf-gate beklenmedik hata:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
