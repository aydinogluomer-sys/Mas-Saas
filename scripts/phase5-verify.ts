// Phase 5 verification on REAL data (TEMİZ). Proves every Phase-5 claim end-to-end:
//   checks: signed→direction, |amount|, negative-not-anomaly, bank/counterparty
//     resolution, eligibility (duplicate_check open → excluded; resolved → in),
//     idempotent mapping + DB-level source_row uniqueness;
//   maturity grouping (week/month) cross-checked vs SQL; bank exposure vs SQL;
//   loans: source reconciliation (total_payment == source B10, cost = total − principal),
//     48 installments == term, derived due dates monotonic, idempotent, DB source_sheet
//     uniqueness; loan eligibility blocked until ambiguity review resolved.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import {
  loadChecks, loadLoanInstallments, loadLoans, loadMaturityItems,
  mapAcceptedChecks, mapLoans,
} from "../src/lib/financing/engine";
import {
  debtServiceByMonth, exposureBy, groupMaturities, isoWeekOf, scheduleDueDates,
} from "../src/lib/financing/rules";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireOwnerDatabaseUrl(),
});
const fail = (m: string): never => { console.error("PHASE5 VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const approx = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
// Gate source is TEMİZ; PHASE5_SRC lets the ÇEKLER/faiz-identical original stand in
// for a pre-flight dry run when TEMİZ isn't present (checks/loans weren't repaired).
const SRC = process.env.PHASE5_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(
    "truncate public.source_workbooks, public.checks, public.check_events, public.loans, public.loan_installments restart identity cascade",
  );
  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;

  /* ── 1) CHECKS eligibility + idempotency ── */
  const c1 = await mapAcceptedChecks(pool, wb, actorId);
  console.log("checks map#1:", JSON.stringify(c1));
  if (c1.excluded.length === 0) fail("expected duplicate_check rows excluded on first map");
  if (!c1.excluded.every((e) => e.reason.includes("açık/ret") || e.reason.includes("vade")))
    fail("unexpected check exclusion reason");
  // no duplicate-flagged row leaked into the ledger yet
  const dupOpen = (await q(
    `select count(*)::int as n from public.mapping_reviews where issue_type='duplicate_check' and status='open'`,
  ))[0].n;
  if (dupOpen === 0) fail("expected open duplicate_check reviews after import");

  // human resolves the duplicate suspicions (keep all — genuinely distinct) → remap
  await pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
                    where issue_type in ('duplicate_check','unparsed_row')`);
  const c2 = await mapAcceptedChecks(pool, wb, actorId);
  console.log("checks map#2 (dup resolved):", JSON.stringify(c2));
  const c3 = await mapAcceptedChecks(pool, wb, actorId);
  if (c3.created !== 0) fail("check mapping not idempotent");
  console.log(`checks: ${c1.created}+${c2.created} created, rerun created=0 ✓`);

  /* ── 2) signed→direction, |amount|, negative-not-anomaly, bank/counterparty ── */
  const checks = await loadChecks(pool);
  if (checks.length === 0) fail("no checks mapped");
  for (const c of checks) {
    if (c.signedAmount != null && c.amount != null && !approx(c.amount, Math.abs(c.signedAmount)))
      fail(`|amount| mismatch: ${c.amount} vs |${c.signedAmount}|`);
    if (c.signedAmount != null && c.signedAmount < 0 && c.direction !== "outflow")
      fail(`negative signed must be outflow: ${c.serial ?? c.payee}`);
  }
  const outflow = checks.filter((c) => c.direction === "outflow").length;
  // negative amounts on the checks sheet must NOT have produced negative_amount reviews
  const negAnom = (await q(
    `select count(*)::int as n from public.mapping_reviews mr
     join public.source_sheets ss on ss.id=mr.sheet_id
     where ss.detected_type='checks' and mr.issue_type='negative_amount'`,
  ))[0].n;
  if (negAnom !== 0) fail("negative check amount wrongly flagged as anomaly");
  const bankResolved = checks.filter((c) => c.bank != null).length;
  const cpResolved = checks.filter((c) => c.payee != null).length;
  if (bankResolved === 0) fail("bank party never resolved (Turkish-normalize regression?)");
  console.log(`direction ✓ (${outflow}/${checks.length} outflow, negatif anomali DEĞİL) · bank-resolved=${bankResolved} · karşı-taraf=${cpResolved}`);

  // null stays null + full source traceability
  const traced = (await q(`select count(*)::int as n from public.checks where source_row_id is not null`))[0].n;
  if (traced !== checks.length) fail("check source traceability broken");

  /* ── 3) maturity grouping (week/month) cross-checked vs SQL ── */
  const items = await loadMaturityItems(pool);
  const monthRule = groupMaturities(items, "month");
  const monthSql = await q(`
    select to_char(d,'YYYY-MM') as k, count(*)::int as n from (
      select maturity_date d from public.checks where status in ('planned','unknown')
      union all
      select due_date d from public.loan_installments where status in ('planned','unpaid','partial','late')
    ) t group by 1 order by 1`);
  const ruleMonthMap = new Map(monthRule.map((b) => [b.key, b.count]));
  for (const row of monthSql) {
    if (ruleMonthMap.get(row.k) !== row.n)
      fail(`month bucket ${row.k}: rule ${ruleMonthMap.get(row.k)} ≠ SQL ${row.n}`);
  }
  if (ruleMonthMap.size !== monthSql.length) fail("month bucket set differs from SQL");
  // ISO week spot-check against Postgres IYYY/IW
  const weekRule = groupMaturities(items, "week");
  const weekSql = await q(`
    select to_char(d,'IYYY') || '-W' || to_char(d,'IW') as k, count(*)::int as n from (
      select maturity_date d from public.checks where status in ('planned','unknown')
      union all
      select due_date d from public.loan_installments where status in ('planned','unpaid','partial','late')
    ) t group by 1`);
  const ruleWeekMap = new Map(weekRule.map((b) => [b.key, b.count]));
  for (const row of weekSql) {
    if (ruleWeekMap.get(row.k) !== row.n)
      fail(`week bucket ${row.k}: rule ${ruleWeekMap.get(row.k)} ≠ SQL ${row.n}`);
  }
  // sanity: isoWeekOf agrees with Postgres for one known check date
  const anyDate = checks[0].maturityDate;
  const pgWeek = (await q(`select to_char($1::date,'IYYY') || '-W' || to_char($1::date,'IW') as k`, [anyDate]))[0].k;
  if (isoWeekOf(anyDate).key !== pgWeek) fail(`isoWeekOf ${anyDate}=${isoWeekOf(anyDate).key} ≠ pg ${pgWeek}`);
  console.log(`maturity grouping ✓ (${monthRule.length} ay / ${weekRule.length} hafta, SQL cross-check)`);

  /* ── 4) bank exposure cross-checked vs SQL, >40% flagged ── */
  const exp = exposureBy(checks.map((c) => ({ key: c.bank, amount: c.amount, direction: c.direction })));
  const expSql = await q(`
    select coalesce(pb.name,'(atanmadı)') as k, sum(abs(c.amount))::float8 as s
    from public.checks c left join public.parties pb on pb.id=c.bank_party_id
    where c.amount is not null group by 1 order by s desc`);
  if (exp.entries[0].key !== expSql[0].k || !approx(exp.entries[0].total, expSql[0].s, 0.5))
    fail(`bank exposure top mismatch: ${exp.entries[0].key}/${exp.entries[0].total} vs ${expSql[0].k}/${expSql[0].s}`);
  if (!exp.entries[0].flagged) fail("dominant bank exposure should be flagged (>40%)");
  console.log(`bank exposure ✓ top=${exp.entries[0].key} %${(exp.entries[0].ratio * 100).toFixed(0)} flagged (bilinen toplam ${exp.knownTotal})`);

  /* ── 5) LOANS: eligibility blocked until ambiguity resolved ── */
  const l1 = await mapLoans(pool, wb, actorId);
  console.log("loans map#1:", JSON.stringify(l1));
  if (l1.created !== 0 || l1.excluded.length === 0) fail("loan should be blocked by open ambiguity review");
  await pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
                    where issue_type in ('loan_field_ambiguous','loan_term_mismatch')`);
  const l2 = await mapLoans(pool, wb, actorId);
  console.log("loans map#2 (ambiguity resolved):", JSON.stringify(l2));
  if (l2.created !== 1) fail(`expected 1 loan, got ${l2.created}`);
  const l3 = await mapLoans(pool, wb, actorId);
  if (l3.created !== 0 || l3.skippedExisting !== 1) fail("loan mapping not idempotent");
  console.log(`loans: 1 created, ${l2.installmentsCreated} installments, rerun created=0 ✓`);

  /* ── 6) source reconciliation: total_payment == source B10, cost = total − principal ── */
  const loans = await loadLoans(pool);
  const loan = loans[0];
  const b10 = Number((await q(
    `select normalized_value as v from public.source_cells sc
     join public.source_sheets ss on ss.id=sc.sheet_id
     where ss.detected_type='loan_calculation' and sc.address='B10'`,
  ))[0].v);
  const b4 = Number((await q(
    `select normalized_value as v from public.source_cells sc
     join public.source_sheets ss on ss.id=sc.sheet_id
     where ss.detected_type='loan_calculation' and sc.address='B4'`,
  ))[0].v);
  const total = loan.totalPayment, principal = loan.principal, cost = loan.totalFinanceCost;
  if (total == null || principal == null || cost == null) return fail("loan totals missing from mapped row");
  const delta = total - principal;
  if (!approx(total, b10, 0.5)) fail(`loan.total_payment ${total} ≠ source B10 ${b10}`);
  if (!approx(principal, b4, 0.5)) fail(`loan.principal ${principal} ≠ source B4 ${b4}`);
  if (!approx(cost, delta, 0.5)) fail(`finance cost ≠ total − principal (${cost} vs ${delta})`);
  if (l2.reconciliationReviews !== 0) fail("real loan reconciles — no review expected");
  console.log(`loan reconciliation ✓ total=${total} (=source B10) principal=${principal} cost=${cost}=total−principal`);

  /* ── 7) installments: count == term, derived due dates monotonic & match schedule ── */
  const inst = await loadLoanInstallments(pool, loan.id);
  if (loan.termMonths != null && inst.length !== loan.termMonths)
    fail(`installments ${inst.length} ≠ term ${loan.termMonths}`);
  const sched = scheduleDueDates(loan.firstPaymentDate!, inst.length);
  for (let i = 0; i < inst.length; i++) {
    if (inst[i].dueDate !== sched[i].dueDate) fail(`installment ${i + 1} due ${inst[i].dueDate} ≠ derived ${sched[i].dueDate}`);
    if (i > 0 && inst[i].dueDate <= inst[i - 1].dueDate) fail("due dates not strictly increasing");
    if (inst[i].amount == null) fail("installment amount null — not-null constraint / missing source");
  }
  const instAmtSql = (await q(`select coalesce(sum(amount),0)::float8 as s from public.loan_installments where loan_id=$1`, [loan.id]))[0].s;
  console.log(`installments ✓ ${inst.length} (${inst[0].dueDate}→${inst[inst.length - 1].dueDate}), Σ=${instAmtSql.toFixed(2)} vs source B10 ${b10.toFixed(2)}`);
  if (!approx(instAmtSql, b10, 1.5)) fail("Σ installment amounts diverge from source total beyond ±1.5");

  /* ── 8) DB-level idempotency proofs (unique indexes, not just app logic) ── */
  const anyCheck = (await q(`select id, source_row_id from public.checks where source_row_id is not null limit 1`))[0];
  let checkUnique = false;
  try {
    await pool.query(
      `insert into public.checks (maturity_date, signed_amount, amount, direction, source_row_id)
       values (current_date, -1, 1, 'outflow', $1)`, [anyCheck.source_row_id]);
  } catch (e) { checkUnique = /duplicate key|unique/i.test((e as Error).message); }
  if (!checkUnique) fail("DB did not enforce checks.source_row_id uniqueness");
  let loanUnique = false;
  try {
    await pool.query(
      `insert into public.loans (name, principal, source_sheet_id) values ('dup',1,$1)`,
      [loan.sourceSheetId]);
  } catch (e) { loanUnique = /duplicate key|unique/i.test((e as Error).message); }
  if (!loanUnique) fail("DB did not enforce loans.source_sheet_id uniqueness");
  console.log("DB idempotency ✓ (checks.source_row + loans.source_sheet unique)");

  /* ── 9) debt-service monthly load sanity (checks + installments merged) ── */
  const debt = debtServiceByMonth(items);
  const debtMonths = debt.filter((d) => d.knownOutflow > 0).length;
  if (debtMonths === 0) fail("no debt-service months");
  console.log(`debt-service ✓ ${debt.length} ay yüklü (ör. ${debt[0].monthStart} ödenecek=${debt[0].knownOutflow})`);

  console.log("PHASE5 VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
