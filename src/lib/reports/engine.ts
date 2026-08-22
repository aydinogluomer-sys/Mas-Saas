// Phase 6A reports engine. Loads already-mapped domain data, calls the pure builders,
// and writes a snapshot row into public.reports. It NEVER mutates financial records
// (payments/instances/checks/loans/cashflow) — only appends to reports + audit_logs.
// AI stays commentary-only: meta.commentary_prompt is a string, no model is called.

import type { Pool, PoolClient } from "pg";
import { addDaysISO, debtServiceByMonth } from "@/lib/financing/rules";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { loadMaturityItems } from "@/lib/financing/engine";
import { moneyOrNull } from "@/lib/money";
import { loadThresholds } from "@/lib/radar/engine";
import {
  instancesBetween, monthInstances, monthSummary, overdueOpen, riskyDays,
} from "@/lib/radar/queries";
import { addMonths } from "@/lib/radar/rules";
import {
  buildCommentaryPrompt, buildDailyReport, buildMonthlyReport, buildWeeklyReport,
  overlayDebtService,
  type ReportInstance, type ReportMaturity,
} from "./rules";

async function audit(client: PoolClient, actor: string, action: string, entityId: string | null, after: unknown): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values ($1,$2,'reports',$3,null,$4)`,
    [actor, action, entityId, JSON.stringify(after ?? null)],
  );
}

const toReportInstance = (r: {
  name: string; due_date: string; amount: number | null; status: string; risk_level: string; risk_reasons: string[];
}): ReportInstance => ({
  name: r.name, dueDate: r.due_date, amount: r.amount, status: r.status,
  riskLevel: r.risk_level, riskReasons: r.risk_reasons,
});

async function maturitiesBetween(pool: Pool, fromISO: string, toISO: string): Promise<ReportMaturity[]> {
  const items = await loadMaturityItems(pool);
  return items
    .filter((m) => m.dueDate >= fromISO && m.dueDate <= toISO)
    .map((m) => ({ label: m.label, dueDate: m.dueDate, amount: m.amount, direction: m.direction, kind: m.kind }));
}

async function writeReport(
  pool: Pool, type: string, periodStart: string, periodEnd: string, bodyMd: string, meta: unknown, actorId: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.reports (report_type, period_start, period_end, body_md, meta)
       values ($1,$2,$3,$4,$5) returning id`,
      [type, periodStart, periodEnd, bodyMd, JSON.stringify(meta ?? null)],
    );
    const id: string = ins.rows[0].id;
    await audit(client, actorId, `generate_report_${type}`, id, { periodStart, periodEnd });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── daily ── */

export async function generateDaily(pool: Pool, todayISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const to = addDaysISO(todayISO, 7);
  const t = await loadThresholds(pool);
  const [soon, overdue, maturities, decisionFacts] = await Promise.all([
    instancesBetween(pool, todayISO, to),
    overdueOpen(pool, todayISO),
    maturitiesBetween(pool, todayISO, to),
    loadDecisionFacts(pool, todayISO),
  ]);
  const open = new Set(["unpaid", "partial", "planned", "late"]);
  const report = buildDailyReport(
    {
      dueSoon: soon.filter((i) => open.has(i.status)).map(toReportInstance),
      overdue: overdue.map(toReportInstance),
      maturities,
      criticalThreshold: t.critical,
    },
    todayISO,
  );
  const prompt = buildCommentaryPrompt({
    scope: "daily", period: todayISO,
    deterministicFacts: [
      `bugün ${report.dueToday.length} ödeme`,
      `7 gün bilinen toplam ${report.next7KnownTotal}`,
      `${report.overdueCount} geciken`,
      `${report.next7MissingCount} tutar eksik`,
      `${report.criticalItems.length} kritik`,
      ...decisionFacts.slice(0, 3).map((f) => `${f.title}: ${f.value}`),
    ],
  });
  const id = await writeReport(pool, "daily", todayISO, to, report.bodyMd, {
    next7KnownTotal: report.next7KnownTotal, overdueCount: report.overdueCount,
    missingCount: report.next7MissingCount, commentary_prompt: prompt,
  }, actorId);
  return { id, bodyMd: report.bodyMd };
}

/* ── weekly ── */

export async function generateWeekly(pool: Pool, todayISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const to = addDaysISO(todayISO, 7);
  const monthStart = todayISO.slice(0, 7) + "-01";
  const t = await loadThresholds(pool);
  const [week, matWeek, matMonth, rdays, decisionFacts] = await Promise.all([
    instancesBetween(pool, todayISO, to),
    maturitiesBetween(pool, todayISO, to),
    maturitiesBetween(pool, monthStart, addMonths(monthStart, 1)),
    riskyDays(pool, todayISO, 7, t),
    loadDecisionFacts(pool, todayISO),
  ]);
  const open = new Set(["unpaid", "partial", "planned", "late"]);
  const report = buildWeeklyReport(
    {
      weekInstances: week.filter((i) => open.has(i.status)).map(toReportInstance),
      maturitiesWeek: matWeek,
      installmentsMonth: matMonth.filter((m) => m.kind === "loan_installment"),
      riskDays: rdays.map((d) => ({ date: d.date, cluster: d.cluster, critical: d.critical, large: d.large, knownSum: d.knownSum, count: d.count })),
      largeThreshold: t.large,
    },
    todayISO,
  );
  const prompt = buildCommentaryPrompt({
    scope: "weekly", period: `${todayISO}→${to}`,
    deterministicFacts: [
      `hafta bilinen yük ${report.knownTotal}`,
      `çek yükü ${report.checkLoad}`,
      `ay kredi taksiti ${report.installmentLoadMonth}`,
      `${report.riskDays.length} riskli gün`,
      ...decisionFacts.slice(0, 3).map((f) => `${f.title}: ${f.value}`),
    ],
  });
  const id = await writeReport(pool, "weekly", todayISO, to, report.bodyMd, {
    knownTotal: report.knownTotal, checkLoad: report.checkLoad,
    installmentLoadMonth: report.installmentLoadMonth, commentary_prompt: prompt,
  }, actorId);
  return { id, bodyMd: report.bodyMd };
}

/* ── monthly ── */

async function distribution(pool: Pool, monthStart: string, joinCol: string, nameSelect: string) {
  const r = await pool.query(
    `select coalesce(${nameSelect}, '(atanmadı)') as key, sum(i.amount) as amount
     from public.payment_instances i
     join public.payments p on p.id = i.payment_id
     ${joinCol}
     where i.instance_month = $1 and i.amount is not null
     group by 1 order by amount desc nulls last`,
    [monthStart],
  );
  // Postgres already summed these exactly; only the trip into JS needed fixing. Ordering is
  // still done in SQL on the numeric, so the ranking is unaffected by the decode.
  return r.rows.map((x) => ({ key: x.key as string, amount: moneyOrNull(x.amount) ?? 0 }));
}

export async function generateMonthly(pool: Pool, monthStartISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const monthEnd = addMonths(monthStartISO, 1);
  const [summary, insts, providerDist, categoryDist, ownerDist, checks, installments, cashRow, unassigned, decisionFacts] =
    await Promise.all([
      monthSummary(pool, monthStartISO),
      monthInstances(pool, monthStartISO),
      distribution(pool, monthStartISO, "left join public.parties pr on pr.id = p.provider_party_id", "pr.name"),
      distribution(pool, monthStartISO, "left join public.categories c on c.id = p.category_id", "c.name"),
      distribution(pool, monthStartISO, "left join public.parties o on o.id = p.owner_party_id", "o.name"),
      maturitiesBetween(pool, monthStartISO, monthEnd),
      maturitiesBetween(pool, monthStartISO, monthEnd),
      pool.query(
        `select opening_balance as opening, projected_income as income,
                projected_expense as expense, closing_balance as closing
         from public.cashflow_months where month_start = $1`,
        [monthStartISO],
      ),
      pool.query(
        `select count(*) filter (where provider_party_id is null)::int as no_provider,
                count(*) filter (where category_id is null)::int as no_category
         from public.payments where status='active'`,
      ),
      loadDecisionFacts(pool, monthStartISO),
    ]);

  const topPayments = [...insts]
    .filter((i) => i.amount != null)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, 10)
    .map(toReportInstance);

  const dq: string[] = [];
  if (summary.missing_count > 0) dq.push(`${summary.missing_count} kalemde tutar eksik`);
  if (unassigned.rows[0].no_provider > 0) dq.push(`${unassigned.rows[0].no_provider} kalemde sağlayıcı atanmamış`);
  if (unassigned.rows[0].no_category > 0) dq.push(`${unassigned.rows[0].no_category} kalemde kategori atanmamış`);

  const report = buildMonthlyReport({
    monthStart: monthStartISO,
    knownTotal: summary.known_total, knownRemaining: summary.known_remaining, paidKnown: summary.paid_known,
    missingCount: summary.missing_count, totalCount: summary.total_count,
    topPayments,
    providerDist, categoryDist, ownerDist,
    checksInMonth: checks.filter((m) => m.kind === "check"),
    installmentsInMonth: installments.filter((m) => m.kind === "loan_installment"),
    cashMonth: cashRow.rows[0]
      ? {
          opening: moneyOrNull(cashRow.rows[0].opening), income: moneyOrNull(cashRow.rows[0].income),
          expense: moneyOrNull(cashRow.rows[0].expense), closing: moneyOrNull(cashRow.rows[0].closing),
        }
      : null,
    dataQualityIssues: dq,
  });
  const prompt = buildCommentaryPrompt({
    scope: "monthly", period: monthStartISO.slice(0, 7),
    deterministicFacts: [
      `bilinen yük ${summary.known_total}`,
      `ödenen ${summary.paid_known} kalan ${summary.known_remaining}`,
      `borç servisi ${report.debtServiceKnown}`,
      `${summary.missing_count} tutar eksik`,
      ...decisionFacts.slice(0, 4).map((f) => `${f.title}: ${f.value}`),
    ],
  });
  const id = await writeReport(pool, "monthly", monthStartISO, addDaysISO(monthEnd, -1), report.bodyMd, {
    knownTotal: summary.known_total, debtServiceKnown: report.debtServiceKnown, commentary_prompt: prompt,
  }, actorId);
  return { id, bodyMd: report.bodyMd };
}

/* ── debt-service × cashflow overlay (read-only; used by /cashflow + verify) ── */

export async function loadDebtOverlay(pool: Pool) {
  const [monthsRes, items] = await Promise.all([
    pool.query(
      `select to_char(month_start,'YYYY-MM-DD') as month_start, closing_balance as closing
       from public.cashflow_months order by month_start`,
    ),
    loadMaturityItems(pool),
  ]);
  const debt = debtServiceByMonth(items);
  return overlayDebtService(
    monthsRes.rows.map((m) => ({ monthStart: m.month_start, closing: moneyOrNull(m.closing) })),
    debt.map((d) => ({ monthStart: d.monthStart, knownOutflow: d.knownOutflow, count: d.count, missingCount: d.missingCount })),
  );
}

/* ── read-side for /reports ── */

export async function listReports(pool: Pool) {
  const r = await pool.query(
    `select id, report_type, to_char(period_start,'YYYY-MM-DD') as period_start,
            to_char(period_end,'YYYY-MM-DD') as period_end,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.reports order by created_at desc limit 50`,
  );
  return r.rows as Array<{ id: string; report_type: string; period_start: string; period_end: string; created_at: string }>;
}

export async function loadReport(pool: Pool, id: string) {
  const r = await pool.query(
    `select id, report_type, to_char(period_start,'YYYY-MM-DD') as period_start,
            to_char(period_end,'YYYY-MM-DD') as period_end, body_md, meta,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.reports where id = $1`,
    [id],
  );
  return r.rows[0] as
    | { id: string; report_type: string; period_start: string; period_end: string; body_md: string; meta: Record<string, unknown> | null; created_at: string }
    | undefined;
}
