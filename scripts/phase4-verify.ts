// Usage:
//   DATABASE_URL=…/mas_radar_ornek_verify MIGRATION_DATABASE_URL=… pnpm phase4:verify
//
// Target database supplied from outside, same deliberate choice as phase3-verify.ts (see its
// header for why chaining beats self-provisioning here), and same Faz 17-38 gate in front of it:
// requireDisposableOwnerDatabaseUrl() refuses mas_radar_dev and refuses any name that does not
// declare itself disposable — this file truncates three tables before it asserts anything.
//
// Phase 4 verification on REAL data.
// Proves: accepted-only mapping, 35 months, cashflow_months == source header cells
// (reconciliation, every month), null stays null, continuity flags (0 on TEMİZ;
// injected break → flagged NOT fixed), projection == SQL cross-checks,
// concentration math, snapshots, idempotency.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import {
  loadCashMonths, mapCashflowMonths, validateContinuity, writeSnapshots,
} from "../src/lib/cashflow/engine";
import { buildProjection, concentration, horizonCards } from "../src/lib/radar/rules";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireDisposableOwnerDatabaseUrl("phase4:verify"),
});
const fail = (m: string): never => { console.error("PHASE4 VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query("truncate public.source_workbooks, public.cashflow_months, public.cashflow_snapshots restart identity cascade");
  const r = await importWorkbook(pool, readFileSync("data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx"), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  // 1) mapping — reviews left as-is (line-level opens only block their lines)
  const m1 = await mapCashflowMonths(pool, wb, actorId);
  console.log("map#1:", JSON.stringify(m1));
  if (m1.monthsCreated !== 35) fail(`expected 35 months, got ${m1.monthsCreated}`);
  if (m1.monthsExcluded.length !== 0) fail(`unexpected month exclusions: ${JSON.stringify(m1.monthsExcluded)}`);
  const m2 = await mapCashflowMonths(pool, wb, actorId);
  if (m2.monthsCreated !== 0 || m2.monthsSkippedExisting !== 35) fail("month mapping not idempotent");
  console.log(`months=35, lines=${m1.linesCreated} (excluded ${m1.linesExcluded} — açık line-inceleme) · rerun idempotent ✓`);

  // 2) SOURCE RECONCILIATION — every month's 5 header values equal source cells
  const bad = await q(`
    with src as (
      select cm.id, cm.month_start,
             max(case when sc.address='B1' then sc.normalized_value end)::float8 as s_open,
             max(case when sc.address='D1' then sc.normalized_value end)::float8 as s_inc,
             max(case when sc.address='F1' then sc.normalized_value end)::float8 as s_exp,
             max(case when sc.address='H1' then sc.normalized_value end)::float8 as s_delta,
             max(case when sc.address='J1' then sc.normalized_value end)::float8 as s_close
      from public.cashflow_months cm
      join public.source_cells sc on sc.sheet_id = cm.source_sheet_id and sc.address in ('B1','D1','F1','H1','J1')
      group by cm.id, cm.month_start)
    select cm.month_start from public.cashflow_months cm join src on src.id = cm.id
    where coalesce(abs(cm.opening_balance::float8  - src.s_open ), case when cm.opening_balance  is null and src.s_open  is null then 0 else 9 end) > 0.5
       or coalesce(abs(cm.projected_income::float8 - src.s_inc  ), case when cm.projected_income is null and src.s_inc  is null then 0 else 9 end) > 0.5
       or coalesce(abs(cm.projected_expense::float8- src.s_exp  ), case when cm.projected_expense is null and src.s_exp is null then 0 else 9 end) > 0.5
       or coalesce(abs(cm.closing_balance::float8  - src.s_close), case when cm.closing_balance  is null and src.s_close is null then 0 else 9 end) > 0.5`);
  if (bad.length > 0) fail(`source reconciliation failed for: ${bad.map((b) => b.month_start).join(",")}`);
  console.log("source reconciliation ✓ (35/35 ay, B1/D1/F1/J1 birebir)");

  // 3) known truth anchor: final month closing
  const last = await q(`select closing_balance::float8 as c from public.cashflow_months order by month_start desc limit 1`);
  if (Math.abs(last[0].c - -3064608) > 2) fail(`final closing ${last[0].c} ≠ -3.064.608`);
  console.log(`final kasa (2029-03) = ${last[0].c} ✓ (bilinen doğru değer)`);

  // 4) continuity on TEMİZ: 0 breaks; inject one → flagged NOT fixed → revert
  const c0 = await validateContinuity(pool);
  if (c0.breaks !== 0 || c0.gaps !== 0) fail(`TEMİZ chain expected clean, got ${JSON.stringify(c0)}`);
  await pool.query(`update public.cashflow_months set opening_balance = opening_balance + 100000
                    where month_start = date '2027-06-01'`);
  const c1 = await validateContinuity(pool);
  if (c1.breaks !== 1 || c1.newReviews !== 1) fail(`injected break not flagged: ${JSON.stringify(c1)}`);
  const still = await q(`select opening_balance::float8 as o, closing_balance::float8 as c
                         from public.cashflow_months where month_start = date '2027-06-01'`);
  const prevClose = await q(`select closing_balance::float8 as c from public.cashflow_months where month_start = date '2027-05-01'`);
  if (Math.abs(still[0].o - (prevClose[0].c + 100000)) > 0.5) fail("validator MUTATED values — forbidden");
  console.log("continuity: TEMİZ=0 kırık ✓ · enjekte kırık → flag(review) ✓, değer DEĞİŞMEDİ ✓");
  await pool.query(`update public.cashflow_months set opening_balance = opening_balance - 100000
                    where month_start = date '2027-06-01'`);
  await pool.query(`update public.mapping_reviews set status='resolved' where issue_type='continuity_break'`);

  // 5) projection cross-checks vs SQL
  const months = await loadCashMonths(pool);
  const proj = buildProjection(months);
  const sqlWorst = await q(`select to_char(month_start,'YYYY-MM-DD') as m, closing_balance::float8 as c
                            from public.cashflow_months order by closing_balance asc limit 1`);
  const sqlFirstNeg = await q(`select to_char(min(month_start),'YYYY-MM-DD') as m
                               from public.cashflow_months where closing_balance < 0`);
  if (proj.worstMonth !== sqlWorst[0].m || Math.abs((proj.worstBalance ?? 0) - sqlWorst[0].c) > 0.5)
    fail(`worst mismatch: ${proj.worstMonth} vs ${sqlWorst[0].m}`);
  if (proj.firstNegativeMonth !== sqlFirstNeg[0].m)
    fail(`firstNegative mismatch: ${proj.firstNegativeMonth} vs ${sqlFirstNeg[0].m}`);
  console.log(`projection ✓ firstNegative=${proj.firstNegativeMonth?.slice(0,7)} worst=${proj.worstMonth?.slice(0,7)} (${proj.worstBalance}) run=${proj.longestNegativeRun.length}`);

  // 6) horizons from current month
  const today = new Date().toISOString().slice(0, 10);
  const cards = horizonCards(months, today.slice(0, 7) + "-01");
  if (cards.length !== 5) fail("expected 5 horizon cards");
  if (!cards[4].truncated && cards[4].horizonMonths === 36) {
    // 36 months from 2026-07 → 2029-06 > data end 2029-03 ⇒ must be truncated
    fail("36m card should be truncated at data end");
  }
  console.log("horizons ✓", cards.map((c) => `${c.horizonMonths}m→${c.toMonth.slice(0, 7)}${c.truncated ? "(kesik)" : ""}`).join(" "));

  // 7) concentration (customer income across all months)
  const incomeLines = await q(`
    select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
    from public.cashflow_lines cl left join public.parties p on p.id = cl.party_id
    where cl.line_type='customer_income'`);
  const conc = concentration(incomeLines as Array<{ key: string; amount: number | null }>);
  if (conc.entries.length === 0) fail("no income concentration entries");
  const sqlTop = await q(`
    select coalesce(p.name, cl.label) as key, sum(greatest(cl.amount,0))::float8 as s
    from public.cashflow_lines cl left join public.parties p on p.id = cl.party_id
    where cl.line_type='customer_income' and cl.amount is not null
    group by 1 order by s desc limit 1`);
  if (conc.entries[0].key !== sqlTop[0].key) fail(`top customer mismatch ${conc.entries[0].key} vs ${sqlTop[0].key}`);
  console.log(`concentration ✓ top müşteri=${conc.entries[0].key} %${(conc.entries[0].ratio * 100).toFixed(1)} flagged=${conc.entries[0].flagged} (bilinmeyen ${conc.unknownCount})`);

  // 8) null stays null on lines; party traceability exists
  const nullLines = await q(`select count(*)::int as n from public.cashflow_lines where amount is null and amount_status='missing'`);
  const traced = await q(`select count(*)::int as n from public.cashflow_lines where source_row_id is not null`);
  const total = await q(`select count(*)::int as n from public.cashflow_lines`);
  if (nullLines[0].n === 0) fail("expected null-amount lines");
  if (traced[0].n !== total[0].n) fail("source traceability broken on some lines");
  const partyMatched = await q(`select count(*)::int as n from public.cashflow_lines where party_id is not null`);
  console.log(`lines: ${total[0].n} (null=${nullLines[0].n}, source-traced=100%, party-matched=${partyMatched[0].n})`);

  // 9) snapshots
  const snaps = await writeSnapshots(pool, today);
  const snapsAgain = await writeSnapshots(pool, today);
  if (snaps !== 5 || snapsAgain !== 5) fail("snapshots not 5/deterministic");
  const snapRows = await q(`select count(*)::int as n from public.cashflow_snapshots where snapshot_date=$1`, [today]);
  if (snapRows[0].n !== 5) fail("snapshot rerun duplicated rows");
  console.log("snapshots ✓ (5 horizon, gün-idempotent)");

  console.log("PHASE4 VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
