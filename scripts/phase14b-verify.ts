// Phase 14B verification. Proves external assumptions are source/date/review
// tracked planning context only; they do not mutate finance/cashflow source tables.
import { Pool } from "pg";
import {
  createExternalAssumption,
  loadExternalAssumptionCenter,
  setExternalAssumptionReviewStatus,
} from "../src/lib/external-assumptions/engine";
import { loadDataQualityCenter } from "../src/lib/data-quality/engine";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireOwnerDatabaseUrl(),
});
const fail = (m: string): never => { console.error("PHASE14B VERIFY FAIL:", m); process.exit(1); };
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
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(`truncate public.external_assumptions, public.action_items restart identity cascade`);
  const before = await financeFingerprint();

  const manualId = await createExternalAssumption(pool, {
    assumptionType: "energy_cost",
    label: "Elektrik birim maliyet varsayimi",
    valueNumeric: 4.2,
    unit: "TRY/kWh",
    currency: "TRY",
    sourceKind: "manual",
    sourceName: "MAS manuel varsayim",
    sourceDate: "2026-07-08",
  }, actorId);
  if (!manualId) fail("manual external assumption not created");

  const internetId = await createExternalAssumption(pool, {
    assumptionType: "loan_rate",
    label: "Piyasa kredi orani",
    valueNumeric: 48,
    unit: "percent",
    currency: "TRY",
    sourceKind: "internet",
    sourceName: "ornek internet kaynagi",
    sourceUrl: "https://example.com/rates",
    sourceDate: "2026-07-08",
  }, actorId);
  if (!internetId) fail("internet external assumption not created");

  let center = await loadExternalAssumptionCenter(pool);
  if (center.pendingCount !== 1 || center.internetPendingCount !== 1) fail("internet assumption must start pending review");
  const dq = await loadDataQualityCenter(pool);
  if (dq.externalPendingCount !== 1) fail("data-quality center must surface pending external assumptions");

  await setExternalAssumptionReviewStatus(pool, internetId as string, "approved", actorId);
  center = await loadExternalAssumptionCenter(pool);
  if (center.pendingCount !== 0) fail("approval did not clear pending count");
  if (!center.latestApproved.some((a) => a.assumption_type === "loan_rate" && a.reviewed_at != null))
    fail("approved internet assumption must have reviewed_at and appear in latest approved");

  const auditCount = Number((await q(`select count(*)::int n from public.audit_logs where entity_table='external_assumptions'`))[0].n);
  if (auditCount < 3) fail("external assumption workflow not audited");

  const after = await financeFingerprint();
  if (before !== after) fail("external assumptions mutated finance/cashflow source tables");
  console.log(`external assumptions ok manual=${manualId} internet=${internetId} audits=${auditCount}`);
  console.log("PHASE14B VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
