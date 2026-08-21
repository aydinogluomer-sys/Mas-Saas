// Phase 6A verification on REAL data (TEMİZ). Proves:
//   reports generate over already-mapped domain data and cross-check SQL;
//   debt-service × cashflow overlay totals == SQL sum of checks+installments per month;
//   AI/report safety: generating reports MUTATES NO financial table (before==after
//     checksum of payments/instances/checks/loans/installments/cashflow);
//   commentary is prompt-only (meta.commentary_prompt forbids mutation, no API call);
//   Istanbul timezone date handling.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { ensureWindow, mapAcceptedCandidates } from "../src/lib/radar/engine";
import { mapCashflowMonths, validateContinuity } from "../src/lib/cashflow/engine";
import { mapAcceptedChecks, mapLoans } from "../src/lib/financing/engine";
import { generateDaily, generateMonthly, generateWeekly, loadDebtOverlay } from "../src/lib/reports/engine";
import { istanbulDateISO } from "../src/lib/reports/rules";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireOwnerDatabaseUrl(),
});
const fail = (m: string): never => { console.error("PHASE6 VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE6_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const TODAY = "2026-07-06"; // deterministic anchor inside the data range

// count+sum fingerprint of every financial table (source-of-truth integrity)
async function financialFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_payment),0) from public.loans
    union all select 'installments', count(*), coalesce(sum(amount),0) from public.loan_installments
    union all select 'cashflow_months', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
    union all select 'cashflow_lines', count(*), coalesce(sum(amount),0) from public.cashflow_lines
    order by t`);
  return JSON.stringify(rows);
}

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(`truncate public.source_workbooks, public.payments, public.payment_instances, public.cashflow_months, public.cashflow_snapshots, public.checks, public.check_events, public.loans, public.loan_installments, public.reports restart identity cascade`);

  // 0) build the full domain (payments + cashflow + financing), resolving known reviews
  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  const wb = r.workbookId;
  const resolve = (types: string) =>
    pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
                where workbook_id=$1 and issue_type = any($2::text[])`, [wb, types]);
  await pool.query(`update public.mapping_reviews set status='accepted' where workbook_id=$1
                    and issue_type in ('missing_due_day','amount_alignment','unlabeled_amount','multiple_day_markers')`, [wb]);
  await mapAcceptedCandidates(pool, wb, actorId);
  await ensureWindow(pool, TODAY, actorId); // generate instances + risk for prev/cur/next month
  await mapCashflowMonths(pool, wb, actorId);
  await validateContinuity(pool);
  await resolve("{duplicate_check,unparsed_row}"); await mapAcceptedChecks(pool, wb, actorId);
  await resolve("{loan_field_ambiguous,loan_term_mismatch}"); await mapLoans(pool, wb, actorId);

  const payments = (await q(`select count(*)::int n from public.payments`))[0].n;
  const checks = (await q(`select count(*)::int n from public.checks`))[0].n;
  const loans = (await q(`select count(*)::int n from public.loans`))[0].n;
  if (payments === 0 || checks === 0 || loans === 0) fail("domain not fully populated");
  console.log(`domain ready: ${payments} kalem · ${checks} çek · ${loans} kredi`);

  // 1) FINANCIAL INTEGRITY: fingerprint before any report generation
  const before = await financialFingerprint();

  // 2) generate all three reports (return handles unused — assertions read from DB)
  await generateDaily(pool, TODAY, actorId);
  await generateWeekly(pool, TODAY, actorId);
  await generateMonthly(pool, TODAY.slice(0, 7) + "-01", actorId);
  const reportRows = await q(`select report_type, body_md, meta from public.reports order by report_type`);
  if (reportRows.length !== 3) fail(`expected 3 reports, got ${reportRows.length}`);
  for (const rr of reportRows) if (!rr.body_md || rr.body_md.length < 20) fail(`empty report body: ${rr.report_type}`);
  console.log(`reports üretildi: daily/weekly/monthly (body_md dolu) ✓`);

  // 3) FINANCIAL INTEGRITY: fingerprint after — MUST be identical (AI/report cannot mutate)
  const after = await financialFingerprint();
  if (before !== after) fail("report generation MUTATED a financial table — forbidden");
  console.log("mali kayıt bütünlüğü ✓ (rapor üretimi hiçbir mali tabloyu değiştirmedi)");

  // 4) daily cross-check: meta.next7KnownTotal == SQL known sum in [today, today+7]
  const dMeta = reportRows.find((x) => x.report_type === "daily")!.meta;
  const sqlNext7 = (await q(
    `select coalesce(sum(amount),0)::float8 s from public.payment_instances
     where due_date >= $1 and due_date <= ($1::date + 7) and amount is not null
       and status in ('unpaid','partial','planned','late')`, [TODAY]))[0].s;
  if (Math.abs(Number(dMeta.next7KnownTotal) - sqlNext7) > 0.5)
    fail(`daily next7 ${dMeta.next7KnownTotal} ≠ SQL ${sqlNext7}`);
  console.log(`daily ✓ 7-gün bilinen toplam=${dMeta.next7KnownTotal} (SQL cross-check)`);

  // 5) monthly cross-check: meta.knownTotal == SQL month known sum
  const mMeta = reportRows.find((x) => x.report_type === "monthly")!.meta;
  const sqlMonth = (await q(
    `select coalesce(sum(amount),0)::float8 s from public.payment_instances
     where instance_month = $1 and amount is not null`, [TODAY.slice(0, 7) + "-01"]))[0].s;
  if (Math.abs(Number(mMeta.knownTotal) - sqlMonth) > 0.5) fail(`monthly known ${mMeta.knownTotal} ≠ SQL ${sqlMonth}`);
  console.log(`monthly ✓ bilinen yük=${mMeta.knownTotal} · borç servisi=${mMeta.debtServiceKnown} (SQL cross-check)`);

  // 6) overlay is keyed by cashflow months; each month's debtOutflow == SQL sum of
  //    known checks + installments due that month. Debt outside the projection window
  //    (installments start 2024-10, cashflow starts 2026-05) is correctly not overlaid.
  const overlay = await loadDebtOverlay(pool);
  const sqlDebt = new Map(
    (await q(`
      select to_char(d,'YYYY-MM-01') m, coalesce(sum(amt),0)::float8 s from (
        select maturity_date d, abs(amount) amt from public.checks where amount is not null and status in ('planned','unknown')
        union all
        select due_date d, amount amt from public.loan_installments where status in ('planned','unpaid','partial','late')
      ) t group by 1`)).map((row) => [row.m as string, Number(row.s)]),
  );
  let checked = 0, withDebt = 0;
  for (const o of overlay) {
    const expected = sqlDebt.get(o.monthStart) ?? 0;
    if (Math.abs(o.debtOutflow - expected) > 0.5) fail(`overlay ${o.monthStart} ${o.debtOutflow} ≠ SQL ${expected}`);
    checked++;
    if (o.debtOutflow > 0) withDebt++;
  }
  if (withDebt === 0) fail("no overlay month carried debt service");
  const highs = overlay.filter((o) => o.pressure === "high").length;
  console.log(`overlay ✓ ${checked} ay SQL-birebir (${withDebt} ayda borç yükü) · ${highs} ay yüksek baskı (negatif kasa+borç)`);

  // 7) commentary is prompt-only, forbids mutation, no API called
  for (const rr of reportRows) {
    const p = (rr.meta?.commentary_prompt ?? "") as string;
    if (!p) fail(`missing commentary_prompt for ${rr.report_type}`);
    if (!/hiçbir değeri değiştirme/.test(p) || !/Kaynak-of-truth/.test(p))
      fail(`commentary prompt missing mutation-ban for ${rr.report_type}`);
    if (/\b(update|insert|delete)\b/i.test(p)) fail("commentary prompt contains a DB write directive");
  }
  console.log("AI yorum promptu ✓ (yalnız prompt; mutasyon yasağı metni var, model çağrılmadı)");

  // 8) audit trail: one row per generated report
  const auditN = (await q(`select count(*)::int n from public.audit_logs where action like 'generate_report_%'`))[0].n;
  if (auditN !== 3) fail(`expected 3 report audit rows, got ${auditN}`);

  // 9) Istanbul timezone: late-UTC rolls to next civil day
  if (istanbulDateISO(new Date("2026-07-06T22:30:00Z")) !== "2026-07-07")
    fail("istanbulDateISO timezone handling wrong");
  console.log("Europe/Istanbul tarih sınırı ✓ · audit 3 satır ✓");

  console.log("PHASE6 VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
