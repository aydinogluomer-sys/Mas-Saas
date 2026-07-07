// Phase 14C verification. Proves report/AI answers can create audited action
// items, stay idempotent while open, and do not mutate finance/cashflow source
// tables.
import { Pool } from "pg";
import { createActionFromAiResponse, createActionFromReport } from "../src/lib/data-quality/engine";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});
const fail = (m: string): never => { console.error("PHASE14C VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

async function financeFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'cashflow_months', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
    union all select 'cashflow_lines', count(*), coalesce(sum(amount),0) from public.cashflow_lines
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_finance_cost),0) from public.loans
    union all select 'installments', count(*), coalesce(sum(amount),0) from public.loan_installments
    order by t`);
  return JSON.stringify(rows);
}

async function main() {
  await pool.query(`truncate public.action_items, public.ai_response_snapshots,
    public.reports, public.audit_logs restart identity cascade`);
  const before = await financeFingerprint();

  const reportId = String((await q(
    `insert into public.reports (report_type, period_start, period_end, body_md, meta)
     values ('daily','2026-07-08','2026-07-08',$1,$2) returning id`,
    ["## Aksiyon\n- [ ] nakit kontrol", JSON.stringify({ commentary_prompt: "Nakit riskini yorumla." })],
  ))[0]?.id ?? "");
  if (!reportId) fail("report snapshot not inserted");

  const aiId = String((await q(
    `insert into public.ai_response_snapshots
       (question, answer_md, response_mode, source_fact_keys, source_hrefs, report_id)
     values ($1,$2,'deterministic',$3,$4,$5) returning id`,
    [
      "Rapor yorumu: ne yapmaliyim?",
      "Nakit kontrolu yap; kaynaklari rapordan takip et.",
      ["first_negative_month"],
      ["/cashflow"],
      reportId,
    ],
  ))[0]?.id ?? "");
  if (!aiId) fail("ai response snapshot not inserted");

  const reportAction1 = await createActionFromReport(pool, reportId);
  const reportAction2 = await createActionFromReport(pool, reportId);
  if (!reportAction1 || reportAction1 !== reportAction2) fail("report action must be idempotent while open");

  const aiAction1 = await createActionFromAiResponse(pool, aiId);
  const aiAction2 = await createActionFromAiResponse(pool, aiId);
  if (!aiAction1 || aiAction1 !== aiAction2) fail("ai response action must be idempotent while open");

  const actions = await q(
    `select source_type, related_entity_table, related_entity_id::text, source_href
     from public.action_items order by source_type`,
  );
  if (actions.length !== 2) fail(`expected 2 action rows, got ${actions.length}`);
  const reportAction = actions.find((a) => a.source_type === "report");
  const aiAction = actions.find((a) => a.source_type === "ai_response");
  if (!reportAction || reportAction.related_entity_table !== "reports" || reportAction.related_entity_id !== reportId)
    fail("report action missing related report pointer");
  if (!aiAction || aiAction.related_entity_table !== "ai_response_snapshots" || aiAction.related_entity_id !== aiId)
    fail("ai action missing related response pointer");
  if (aiAction.source_href !== `/reports/${reportId}?ai=${aiId}`) fail("ai action source link must point back to report AI answer");

  const audits = await q(
    `select action, count(*)::int n from public.audit_logs
     where entity_table='action_items'
       and action in ('create_action_from_report','create_action_from_ai_response')
     group by action`,
  );
  const auditMap = new Map(audits.map((r) => [r.action, Number(r.n)]));
  if ((auditMap.get("create_action_from_report") ?? 0) < 1) fail("report task creation not audited");
  if ((auditMap.get("create_action_from_ai_response") ?? 0) < 1) fail("ai task creation not audited");

  const after = await financeFingerprint();
  if (before !== after) fail("report/AI task creation mutated finance/cashflow source tables");

  console.log(`report/ai actions ok report=${reportAction1} ai=${aiAction1}`);
  console.log("PHASE14C VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
