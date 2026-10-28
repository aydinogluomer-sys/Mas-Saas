// P24B V6.1 — cleanup + metric-snapshot recompute DRY RUN, on a disposable clone only.
//
// WHAT THIS ANSWERS. The V6 discovery proved 42 rows are contamination. Two questions remain that
// cannot be answered by reading:
//
//   1. In what ORDER must they be deleted so no foreign key blocks or silently orphans anything?
//      (payment_instances.payment_id is ON DELETE SET NULL — delete the payment first and the 26
//      instances survive with a null link, losing the only evidence that ties them to the fixture.)
//   2. What happens to the 24 metric_snapshots rows of 2026-08-27, which were computed over
//      contaminated data? Deleting rows does not fix a stored aggregate.
//
// Both are answered by DOING it — on a throwaway copy of the real database, never on the real one.
//
// THE GUARD. requireDisposableOwnerDatabaseUrl() runs before the pool is constructed and before
// any src/ module is imported. mas_radar_dev is in PROTECTED_DB_NAMES and can never pass.
//
// WHY DYNAMIC IMPORT. This file needs refreshMetricSnapshots() from src/lib/analytics. A STATIC
// import would execute that module's import graph at load time — before the gate above has run.
// The graph is small today, but "today's graph does not reach getPool()" is a property that
// changes silently. Importing after the target is proven disposable makes the ordering structural
// rather than lucky; scripts/db/transitions-verify.ts uses the same shape for the same reason.
import { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

const url = requireDisposableOwnerDatabaseUrl("p24b:cleanup-dryrun");

/** The exact 42, as proven by V6 discovery. Nothing here is inferred at run time. */
const TARGETS = {
  action_items: [
    "639daf7e-9c3e-4244-9ebf-6bef37b57971",
    "12d7532f-a730-44dd-9b91-43cf501a6871",
    "cdcb3e57-d0c3-46ac-afe7-997419720548",
    "cf55cbbc-feaa-4e79-9517-e41d22261e77",
  ],
  approvals: [
    "1fc76c28-9d71-4ce3-91a6-f1e9f94e5dd4",
    "62cd196c-d517-44c8-9431-3cce52d8b81a",
    "8f656a4d-d2e4-40f2-b698-277f6278008b",
    "f4d7db30-44ce-45c0-b4ce-536a0e2886c9",
  ],
  users: [
    "92cee4d3-c649-432d-b507-546d87936a76",
    "a794163c-6ab5-4d00-a1b5-2b0c563be4e3",
    "33796a14-c173-45c7-a784-33e44e8996a0",
    "19688698-2eb2-40bb-9fc5-37cebdc7e824",
    "cd3445b1-9c74-4703-b348-9f09a704a3d3",
    "4b6d2264-a608-4b36-90aa-17fcfa13bb3f",
  ],
  payments: ["7b300bfe-944f-468b-91fa-2de65b7cfee5"],
  settings: ["p24b_fixture_setting"],
} as const;

const FIXTURE_PAYMENT = TARGETS.payments[0];

interface SnapRow {
  snapshot_date: string;
  metric_key: string;
  dimension_key: string;
  value_numeric: string | null;
  value_text: string | null;
  unknown_count: number;
  confidence: string;
  source_cutoff: string;
}

async function readSnapshots(pool: Pool, dates: string[]): Promise<SnapRow[]> {
  const r = await pool.query<SnapRow>(
    `select snapshot_date::text, metric_key, dimension_key,
            value_numeric::text, value_text, unknown_count, confidence, source_cutoff::text
       from public.metric_snapshots
      where snapshot_date = any($1::date[])
      order by metric_key, dimension_key`,
    [dates],
  );
  return r.rows;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 2 });
  const out: Record<string, unknown> = {};

  const dbName = (await pool.query<{ d: string }>("select current_database() d")).rows[0].d;
  out.database = dbName;
  out.generatedAtUtc = new Date().toISOString();
  console.log(`hedef: ${dbName}`);

  // Which snapshot_date(s) do the contaminated rows belong to?
  const dateRows = await pool.query<{ d: string; n: string }>(
    `select snapshot_date::text d, count(*)::text n
       from public.metric_snapshots
      where created_at::date = '2026-08-27'
      group by 1 order by 1`,
  );
  const dates = dateRows.rows.map((r) => r.d);
  out.affectedSnapshotDates = dateRows.rows;
  console.log(`etkilenen snapshot_date: ${dates.join(", ")}`);

  const before = await readSnapshots(pool, dates);
  out.beforeCount = before.length;

  /* ── DELETE, in the order the FK graph requires ─────────────────────────────────────────
   * Measured, not assumed:
   *   action_items / approvals  reference users.id  (NO ACTION -> they block)   => first
   *   payment_instances         references payments.id (SET NULL -> silent orphan) => before payments
   *   users                     only after its referrers are gone
   *   settings                  independent
   */
  const order: Array<{ step: number; table: string; sql: string; params: unknown[] }> = [
    { step: 1, table: "action_items", sql: `delete from public.action_items where id = any($1::uuid[])`, params: [TARGETS.action_items] },
    { step: 2, table: "approvals", sql: `delete from public.approvals where id = any($1::uuid[])`, params: [TARGETS.approvals] },
    { step: 3, table: "payment_instances", sql: `delete from public.payment_instances where payment_id = $1`, params: [FIXTURE_PAYMENT] },
    { step: 4, table: "payments", sql: `delete from public.payments where id = any($1::uuid[])`, params: [TARGETS.payments] },
    { step: 5, table: "users", sql: `delete from public.users where id = any($1::uuid[])`, params: [TARGETS.users] },
    { step: 6, table: "settings", sql: `delete from public.settings where key = any($1::text[])`, params: [TARGETS.settings] },
  ];

  const client = await pool.connect();
  const deletes: Array<Record<string, unknown>> = [];
  try {
    await client.query("begin");
    for (const s of order) {
      const before_ = await client.query<{ n: string }>(
        `select count(*)::text n from public.${s.table}`,
      );
      const res = await client.query(s.sql, s.params);
      const after_ = await client.query<{ n: string }>(
        `select count(*)::text n from public.${s.table}`,
      );
      deletes.push({
        step: s.step,
        table: s.table,
        deleted: res.rowCount,
        before: Number(before_.rows[0].n),
        after: Number(after_.rows[0].n),
        delta: Number(before_.rows[0].n) - Number(after_.rows[0].n),
      });
      console.log(`  ${s.step}. ${s.table.padEnd(18)} silinen=${res.rowCount}`);
    }
    // Orphan check: no instance may survive pointing at nothing.
    const orphan = await client.query<{ n: string }>(
      `select count(*)::text n from public.payment_instances where payment_id is null`,
    );
    out.orphanInstancesAfterDelete = Number(orphan.rows[0].n);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  out.deleteOrder = deletes;

  /* ── RECOMPUTE ─────────────────────────────────────────────────────────────────────────
   * Imported only now: the target has been proven disposable and the deletes have run.
   */
  const { refreshMetricSnapshots } = await import("../../src/lib/analytics/snapshots");
  const actor = (
    await pool.query<{ id: string }>(`select id from public.users where username = 'system' limit 1`)
  ).rows[0];
  if (!actor) throw new Error("system aktörü bulunamadı — recompute aktörsüz çalıştırılamaz");

  for (const d of dates) {
    const n = await refreshMetricSnapshots(pool, actor.id, d);
    console.log(`  recompute ${d}: ${n} metrik yazıldı`);
  }

  const after = await readSnapshots(pool, dates);
  out.afterCount = after.length;

  /* ── COMPARE ───────────────────────────────────────────────────────────────────────────
   * Semantic change (value_numeric / value_text / unknown_count) is reported SEPARATELY from
   * technical provenance change (source_cutoff), because a recompute always rewrites the
   * cutoff and counting that as "the number moved" would drown the two changes that matter.
   */
  const key = (r: SnapRow): string => `${r.snapshot_date}|${r.metric_key}|${r.dimension_key}`;
  const beforeMap = new Map(before.map((r) => [key(r), r]));
  const comparison = after.map((a) => {
    const b = beforeMap.get(key(a));
    const semanticChanged =
      !b ||
      b.value_numeric !== a.value_numeric ||
      b.value_text !== a.value_text ||
      b.unknown_count !== a.unknown_count ||
      b.confidence !== a.confidence;
    const technicalFieldsChanged = !!b && b.source_cutoff !== a.source_cutoff;
    return {
      metric_key: a.metric_key,
      dimension_key: a.dimension_key,
      snapshot_date: a.snapshot_date,
      before_value: b ? (b.value_numeric ?? b.value_text) : null,
      after_value: a.value_numeric ?? a.value_text,
      before_unknown: b?.unknown_count ?? null,
      after_unknown: a.unknown_count,
      semanticChanged,
      technicalFieldsChanged,
      reason: !b
        ? "recompute sonrası yeni satır (upsert anahtarı eşleşmedi)"
        : semanticChanged
          ? "değer kirli veriden hesaplanmıştı; 42 satır kaldırıldıktan sonra yeniden hesaplandı"
          : "değişmedi",
    };
  });
  out.comparison = comparison;
  out.semanticChanges = comparison.filter((c) => c.semanticChanged);
  out.semanticChangeCount = comparison.filter((c) => c.semanticChanged).length;
  out.technicalOnlyChangeCount = comparison.filter(
    (c) => !c.semanticChanged && c.technicalFieldsChanged,
  ).length;

  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
