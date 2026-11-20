// Phase 13B verification (hardened in V2 F-18). Proves the financing-optimization candidate ranking
// is a deterministic read-only estimator: it compares supported overlays, validates candidate
// keys/labels/metrics/ranking/improvement/determinism, writes no scenario rows, and does not
// mutate finance/cashflow source tables.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  estimateOptimizationCandidates,
  type OptimizationCandidate,
} from "../src/lib/scenarios/engine";
import { assertDisposableTargetDb } from "./db/disposable-guard";

const EXPECTED_CANDIDATE_PREFIXES = [
  "delay_cagdas",
  "factor_hpt",
  "income_plus_10",
  "expense_efficiency_5",
  "combo_cagdas",
] as const;

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * Active structural, numerical, ranking, improvement, and determinism assertions for
 * `estimateOptimizationCandidates` (`F-18` — replaces legacy unreachable loop).
 */
export function validateOptimizationCandidates(
  candidates: readonly OptimizationCandidate[],
  secondPassCandidates?: readonly OptimizationCandidate[],
  baselineMaxCashGap = 10_000,
): void {
  if (candidates.length !== 5) {
    throw new Error(`expected 5 optimization candidates, got ${candidates.length}`);
  }

  const seenKeys = new Set<string>();
  for (const c of candidates) {
    if (typeof c.key !== "string" || c.key.trim() === "") {
      throw new Error(`optimization candidate has empty key: ${JSON.stringify(c)}`);
    }
    if (seenKeys.has(c.key)) {
      throw new Error(`optimization candidates must have distinct keys; duplicate '${c.key}'`);
    }
    seenKeys.add(c.key);

    if (typeof c.label !== "string" || c.label.trim() === "") {
      throw new Error(`optimization candidate '${c.key}' has empty label`);
    }
    if (!c.assumptions || typeof c.assumptions !== "object") {
      throw new Error(`optimization candidate '${c.key}' missing assumptions object`);
    }
    if (!VALID_CONFIDENCE.has(c.confidence)) {
      throw new Error(`optimization candidate '${c.key}' has invalid confidence '${String(c.confidence)}'`);
    }
    if (typeof c.maxCashGap !== "number" || !Number.isFinite(c.maxCashGap) || c.maxCashGap < 0) {
      throw new Error(`optimization candidate '${c.key}' has non-finite/negative maxCashGap=${String(c.maxCashGap)}`);
    }
    if (typeof c.finalCash !== "number" || !Number.isFinite(c.finalCash)) {
      throw new Error(`optimization candidate '${c.key}' has non-finite finalCash=${String(c.finalCash)}`);
    }
    if (typeof c.finalDelta !== "number" || !Number.isFinite(c.finalDelta)) {
      throw new Error(`optimization candidate '${c.key}' has non-finite finalDelta=${String(c.finalDelta)}`);
    }
  }

  for (const prefix of EXPECTED_CANDIDATE_PREFIXES) {
    if (!candidates.some((c) => c.key === prefix || c.key.startsWith(prefix))) {
      throw new Error(`missing optimization candidate matching '${prefix}'`);
    }
  }

  for (let i = 1; i < candidates.length; i++) {
    const prev = candidates[i - 1]!;
    const curr = candidates[i]!;
    const prevGap = prev.maxCashGap ?? Number.POSITIVE_INFINITY;
    const currGap = curr.maxCashGap ?? Number.POSITIVE_INFINITY;
    if (prevGap > currGap) {
      throw new Error(
        `optimization candidates are not sorted by lowest maxCashGap (${prev.key}=${prevGap} > ${curr.key}=${currGap})`,
      );
    }
    if (prevGap === currGap) {
      const prevFinal = prev.finalCash ?? Number.NEGATIVE_INFINITY;
      const currFinal = curr.finalCash ?? Number.NEGATIVE_INFINITY;
      if (prevFinal < currFinal) {
        throw new Error(
          `equal-gap optimization candidates are not tie-broken by highest finalCash (${prev.key}=${prevFinal} < ${curr.key}=${currFinal})`,
        );
      }
    }
  }

  const bestGap = candidates[0]!.maxCashGap ?? Number.POSITIVE_INFINITY;
  if (bestGap >= baselineMaxCashGap) {
    throw new Error(
      `best optimization candidate '${candidates[0]!.key}' did not reduce baseline cash gap (${bestGap} >= ${baselineMaxCashGap})`,
    );
  }

  if (secondPassCandidates !== undefined) {
    if (JSON.stringify(secondPassCandidates) !== JSON.stringify(candidates)) {
      throw new Error(
        "estimateOptimizationCandidates is not deterministic across consecutive read-only calls",
      );
    }
  }
}

async function financeFingerprint(pool: Pool): Promise<string> {
  const rows = (
    await pool.query(`
      select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
      union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
      union all select 'cashflow_months', count(*), coalesce(sum(closing_balance),0) from public.cashflow_months
      union all select 'cashflow_lines', count(*), coalesce(sum(amount),0) from public.cashflow_lines
      union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
      union all select 'loans', count(*), coalesce(sum(total_finance_cost),0) from public.loans
      union all select 'installments', count(*), coalesce(sum(amount),0) from public.loan_installments
      order by t`)
  ).rows;
  return JSON.stringify(rows);
}

async function main(): Promise<void> {
  const fail = (m: string): never => {
    console.error("PHASE13B VERIFY FAIL:", m);
    process.exit(1);
  };

  const pool = new Pool({
    connectionString: assertDisposableTargetDb(undefined, "phase13b:verify").url,
  });

  try {
    const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

    // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
    // deliberately NOT in the reset below. Each verify run gets a freshly created
    // disposable database instead, so the audit table starts empty without weakening
    // the invariant.
    await pool.query(
      `truncate public.cashflow_months, public.cashflow_lines, public.scenario_assumptions, public.scenario_comparisons, public.scenario_run_lines, public.scenario_runs, public.scenarios restart identity cascade`,
    );

    const months = await q(
      `insert into public.cashflow_months
         (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, confidence, status)
       values
         ('2026-07-01', 100000, 70000, 180000, -110000, -10000, 'calculated', 'draft'),
         ('2026-08-01', -10000, 220000, 120000, 100000, 90000, 'calculated', 'draft'),
         ('2026-09-01', 90000, 90000, 140000, -50000, 40000, 'calculated', 'draft')
       returning id, to_char(month_start,'YYYY-MM-DD') as month_start`,
    );
    const byMonth = new Map(months.map((m) => [m.month_start, m.id]));
    await pool.query(
      `insert into public.cashflow_lines (cashflow_month_id, line_type, direction, label, amount, amount_status)
       values
         ($1,'vendor_payment','outflow','Cagdas makina odemesi',80000,'known'),
         ($2,'customer_income','inflow','Hpt tahsilat',200000,'known'),
         ($3,'customer_income','inflow','Hpt tahsilat',70000,'known')`,
      [byMonth.get("2026-07-01"), byMonth.get("2026-08-01"), byMonth.get("2026-09-01")],
    );

    const before = await financeFingerprint(pool);
    const candidates = await estimateOptimizationCandidates(pool);
    const candidatesSecond = await estimateOptimizationCandidates(pool);

    try {
      validateOptimizationCandidates(candidates, candidatesSecond, 10_000);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }

    const scenarioRows = (
      await q(
        `select
           (select count(*)::int from public.scenarios) as scenarios,
           (select count(*)::int from public.scenario_runs) as runs,
           (select count(*)::int from public.scenario_run_lines) as lines`,
      )
    )[0];
    if (scenarioRows.scenarios !== 0 || scenarioRows.runs !== 0 || scenarioRows.lines !== 0) {
      fail(`optimizer estimator wrote scenario rows: ${JSON.stringify(scenarioRows)}`);
    }

    const after = await financeFingerprint(pool);
    if (before !== after) {
      fail("optimization estimator mutated finance/cashflow source tables");
    }

    console.log(
      `optimization candidates ok count=${candidates.length} best=${candidates[0]!.key} gap=${candidates[0]!.maxCashGap} deterministic=true`,
    );
    console.log("PHASE13B VERIFY: ALL PASS");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
