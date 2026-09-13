// Phase 3 verification on REAL data. Proves every Phase-3 rule end-to-end:
//   eligibility (accepted/resolved in, open/rejected out, nameless never),
//   idempotent mapping + generation (duplicate impossible),
//   due-day 29/30/31 clamping in DB, missing amount stays NULL,
//   paid/unpaid mutations write audit_logs, risk flags land.
//
// Usage:
//   DATABASE_URL=…/mas_radar_ornek_verify MIGRATION_DATABASE_URL=… pnpm phase3:verify
//
// THE TARGET DATABASE IS SUPPLIED FROM OUTSIDE, DELIBERATELY — and Faz 17-38 audit added the
// gate that makes that safe. This script is NOT self-provisioning like scripts/db/*-verify.ts,
// and the difference is a real design choice rather than an oversight: it exercises the actual
// engine functions against the actual workbook in data/source/, and phase4/phase5 then measure
// the state phase3 leaves behind (phase5's regression condition depends on it). A script that
// created and dropped its own database each run could not be chained that way, and would
// re-apply 87 migrations per gate.
//
// What that costs is that the caller chooses the target — and the caller can choose wrong. So
// the connection now resolves through requireDisposableOwnerDatabaseUrl(), which refuses
// mas_radar_dev outright and refuses any name that does not DECLARE itself disposable, before a
// connection is opened. That gate exists because this file's very first act is a TRUNCATE; see
// scripts/db/owner-url.ts for the reproduction that motivated it.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import {
  ensureWindow,
  generateInstancesForMonth,
  mapAcceptedCandidates,
  markInstancePaid,
  markInstanceUnpaid,
  refreshRiskFlags,
} from "../src/lib/radar/engine";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireDisposableOwnerDatabaseUrl("phase3:verify"),
});
// Faz 24B'den beri payment_instances bakımı (ensureWindow / generateInstancesForMonth /
// refreshRiskFlags) yalnız INSERT+UPDATE yetkili KATMAN rollerinde çalışır
// (engine.ts tierMayMaintainInstances); sahip rol (postgres) sessizce 0 üretir. Bu betik o
// kapıdan önce yazılmıştı ve gerçek şemada "gen created=0 → clamp yok" diye düşüyordu.
// Üretim adımları bu yüzden yönetici katmanı olarak koşar; sahip havuz yalnız hazırlık
// (truncate, review kararları) ve doğrulama sorguları için kalır.
const tierPool = new Pool({
  connectionString: requireDisposableOwnerDatabaseUrl("phase3:verify"),
  options: "-c role=mas_radar_admin",
});
const fail = (m: string): never => {
  console.error("PHASE3 VERIFY FAIL:", m);
  process.exit(1);
};
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  // 0) fresh staging + fresh domain
  await pool.query(
    "truncate public.source_workbooks, public.payments, public.payment_instances restart identity cascade",
  );
  const r = await importWorkbook(
    pool,
    readFileSync("data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx"),
    "TEMİZ.xlsx",
    actorId,
  );
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  // 1) controlled review decisions on the KNOWN anomalies
  //    TİJEN negative → LEFT OPEN  ⇒ excluded
  //    ÖMER amount_alignment → ACCEPTED ⇒ imported (variable amount)
  //    ATİLLA amount_alignment → REJECTED ⇒ excluded
  //    PRONET missing_due_day → ACCEPTED ⇒ imported as irregular (dayless)
  //    AG25 unlabeled → ACCEPTED ⇒ still excluded (nameless can never import)
  const dec = async (like: string, status: string) => {
    const res = await pool.query(
      `update public.mapping_reviews set status=$2, reviewed_at=now()
       where workbook_id=$1 and message like $3 returning id`,
      [wb, status, like],
    );
    if (res.rowCount === 0) fail(`review not found for ${like}`);
  };
  await dec("%ÖMER%", "accepted");
  await dec("%ATİLLA%", "rejected");
  await dec("%PRONET%", "accepted");
  await dec("%Etiketsiz tutar%", "accepted");
  // multiple_day_markers rows (if any) — accept so they don't block counting
  await pool.query(
    `update public.mapping_reviews set status='accepted', reviewed_at=now()
     where workbook_id=$1 and issue_type='multiple_day_markers'`,
    [wb],
  );

  // 2) mapping — accepted-only
  const m1 = await mapAcceptedCandidates(pool, wb, actorId);
  console.log("map#1:", JSON.stringify(m1));
  if (m1.created === 0) fail("nothing mapped");
  const names = (await q(`select name from public.payments order by name`)).map((x) => x.name);
  if (names.some((n) => /TİJEN/.test(n) && /TELEFON/.test(n))) fail("open-review row imported (TİJEN)");
  if (names.some((n) => /ATİLLA/.test(n) && /TELEFON/.test(n))) fail("rejected row imported (ATİLLA)");
  if (!names.some((n) => /ÖMER/.test(n))) fail("accepted row missing (ÖMER)");
  const pronet = await q(`select recurrence_type, due_day from public.payments where name ilike '%PRONET%'`);
  if (pronet.length !== 1 || pronet[0].recurrence_type !== "irregular" || pronet[0].due_day !== null)
    fail("PRONET should be irregular/dayless");
  const nulls = await q(
    `select count(*)::int as n from public.payments where default_amount is null`,
  );
  if (nulls[0].n === 0) fail("expected null default_amounts to survive as NULL");
  const zeros = await q(`select count(*)::int as n from public.payments where default_amount = 0`);
  if (zeros[0].n !== 0) fail("a missing amount became ZERO — forbidden");
  console.log(`payments: ${names.length} (${names.join(" | ")})`);

  // idempotent mapping
  const m2 = await mapAcceptedCandidates(pool, wb, actorId);
  if (m2.created !== 0) fail("mapping not idempotent");
  console.log("map#2 idempotent ✓ (created=0, skipped=" + m2.skippedAlreadyMapped + ")");

  // 3) generation — real months + Şubat clamp months
  const today = new Date().toISOString().slice(0, 10);
  await ensureWindow(tierPool, today, actorId);
  const g1 = await generateInstancesForMonth(tierPool, "2027-02-01", actorId);
  const g2 = await generateInstancesForMonth(tierPool, "2027-02-01", actorId); // duplicate attempt
  if (g2.created !== 0) fail("duplicate generation created rows");
  console.log(`gen Şubat27: created=${g1.created} shortMonthAdjusted=${g1.shortMonthAdjusted}; rerun created=${g2.created} ✓`);

  // day 30 (garanti kk) must clamp to 2027-02-28 with note
  const clamp = await q(
    `select to_char(i.due_date,'YYYY-MM-DD') as d, i.due_day, i.note
     from public.payment_instances i join public.payments p on p.id=i.payment_id
     where p.due_day=30 and i.instance_month=date '2027-02-01'`,
  );
  if (clamp.length === 0) fail("no day-30 payment instance for Şubat 2027");
  if (clamp[0].d !== "2027-02-28" || clamp[0].note !== "short_month_adjustment")
    fail(`clamp wrong: ${JSON.stringify(clamp[0])}`);
  console.log("29/30/31 clamp in DB ✓ (30 → 2027-02-28, flagged)");

  // DB-level duplicate impossibility (unique index, not just app logic)
  const anyInst = await q(`select payment_id, instance_month from public.payment_instances limit 1`);
  let uniqueFired = false;
  try {
    await pool.query(
      `insert into public.payment_instances (payment_id, instance_month, due_date) values ($1,$2,current_date)`,
      [anyInst[0].payment_id, anyInst[0].instance_month],
    );
  } catch (e) {
    uniqueFired = /duplicate key|unique/i.test((e as Error).message);
  }
  if (!uniqueFired) fail("DB unique did not prevent duplicate instance");
  console.log("duplicate instance impossible at DB level ✓");

  // 4) missing amounts stayed NULL at instance level
  const instNull = await q(
    `select count(*)::int as n from public.payment_instances where amount is null and amount_status='missing'`,
  );
  const instZero = await q(`select count(*)::int as n from public.payment_instances where amount = 0`);
  if (instNull[0].n === 0) fail("expected missing-amount instances");
  if (instZero[0].n !== 0) fail("instance amount became ZERO — forbidden");
  console.log(`missing amounts remain NULL ✓ (${instNull[0].n} instance)`);

  // 5) risk flags: day-9 cluster (business+paraf+tijen akbank) and 190k critical
  await refreshRiskFlags(tierPool, today);
  const cluster = await q(
    `select count(*)::int as n from public.payment_instances
     where 'same_day_cluster' = any(risk_reasons) and extract(day from due_date)=9
       and instance_month = date_trunc('month', current_date)::date`,
  );
  if (cluster[0].n < 3) fail(`expected ≥3 day-9 cluster instances, got ${cluster[0].n}`);
  const critical = await q(
    `select count(*)::int as n from public.payment_instances
     where risk_level='critical'
       and instance_month = date_trunc('month', current_date)::date`,
  );
  if (critical[0].n === 0) fail("expected critical instances (190k / 120k)");
  console.log(`risk ✓ (day-9 cluster=${cluster[0].n}, critical=${critical[0].n})`);

  // 6) paid/unpaid mutations write audit_logs
  const target = (await q(
    `select id from public.payment_instances
     where instance_month = date_trunc('month', current_date)::date and status='unpaid' limit 1`,
  ))[0].id;
  const auditBefore = (await q(`select count(*)::int as n from public.audit_logs where action in ('mark_paid','mark_unpaid')`))[0].n;
  await markInstancePaid(pool, target, null, actorId);
  const paidRow = await q(`select status, paid_at from public.payment_instances where id=$1`, [target]);
  if (paidRow[0].status !== "paid" || paidRow[0].paid_at == null) fail("paid state wrong");
  await markInstanceUnpaid(pool, target, actorId);
  const auditAfter = (await q(`select count(*)::int as n from public.audit_logs where action in ('mark_paid','mark_unpaid')`))[0].n;
  if (auditAfter - auditBefore !== 2) fail(`audit entries missing: ${auditAfter - auditBefore}`);
  const auditShape = await q(
    `select before_data->>'status' as b, after_data->>'status' as a
     from public.audit_logs where action='mark_paid' and entity_id=$1`,
    [target],
  );
  if (auditShape[0].b !== "unpaid" || auditShape[0].a !== "paid") fail("audit before/after wrong");
  console.log("paid/unpaid mutations audited ✓ (+2 audit rows, before/after doğru)");

  console.log("PHASE3 VERIFY: ALL PASS");
  await tierPool.end();
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
