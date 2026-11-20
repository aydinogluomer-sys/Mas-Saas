// Phase 6A & Faz 46 (C3) reports engine. Loads already-mapped domain data, calls the pure builders,
// and writes a snapshot row into public.reports. It NEVER mutates financial records
// (payments/instances/checks/loans/cashflow) — only appends to reports + audit_logs.
// AI stays commentary-only: meta.commentary_prompt is a string, no model is called.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { addDaysISO, debtServiceByMonth } from "@/lib/financing/rules";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { loadMaturityItems } from "@/lib/financing/engine";
import { moneyOrNull } from "@/lib/money";
import { loadThresholds } from "@/lib/radar/engine";
import {
  instancesBetween, monthInstances, monthSummary, overdueOpen, riskyDays,
} from "@/lib/radar/queries";
import { addMonths } from "@/lib/radar/rules";
import { audit } from "@/lib/audit";
import {
  buildCommentaryPrompt, buildDailyReport, buildMonthlyReport, buildWeeklyReport,
  overlayDebtService,
  type MonthlyActualBankCashStatus, type ReportInstance, type ReportMaturity,
} from "./rules";
import {
  computeContentSha256,
  loadBoardFinancialPackage,
  loadReportProvenance,
  renderBoardPackMarkdown,
  type BoardFinancialPackage,
  type ReportProvenance,
} from "./board-pack";

export const toReportInstance = (r: {
  name: string;
  due_date: string;
  amount: number | null;
  original_amount?: number | null;
  paid_amount?: number | null;
  remaining_amount?: number | null;
  status: string;
  risk_level: string;
  risk_reasons: string[];
  currency?: string | null;
}): ReportInstance => ({
  name: r.name,
  dueDate: r.due_date,
  amount: r.amount,
  originalAmount: r.original_amount ?? r.amount,
  paidAmount: r.paid_amount ?? null,
  paid_amount: r.paid_amount ?? null,
  allocatedPaidAmount: r.paid_amount ?? null,
  outstandingAmount: r.remaining_amount ?? undefined,
  status: r.status,
  riskLevel: r.risk_level,
  riskReasons: r.risk_reasons,
  // PHASE 2.2 (#10): BASE sorgusu currency'yi secer; yoksa null (= bilinmiyor, TRY varsayilmaz).
  currency: r.currency ?? null,
});

async function maturitiesBetween(pool: Pool, fromISO: string, toISO: string): Promise<ReportMaturity[]> {
  const items = await loadMaturityItems(pool);
  return items
    .filter((m) => m.dueDate >= fromISO && m.dueDate <= toISO)
    .map((m) => ({ label: m.label, dueDate: m.dueDate, amount: m.amount, direction: m.direction, kind: m.kind }));
}

/**
 * Faz 46 (C3): Half-open `[fromISO, toExclusiveISO)` range for calendar months so an
 * installment or check due on the 1st of the next month is never double-counted in two months.
 */
async function maturitiesBetweenHalfOpen(
  pool: Pool,
  fromISO: string,
  toExclusiveISO: string,
): Promise<ReportMaturity[]> {
  const items = await loadMaturityItems(pool);
  return items
    .filter((m) => m.dueDate >= fromISO && m.dueDate < toExclusiveISO)
    .map((m) => ({ label: m.label, dueDate: m.dueDate, amount: m.amount, direction: m.direction, kind: m.kind }));
}

async function writeReport(
  pool: Pool,
  type: string,
  periodStart: string,
  periodEnd: string,
  bodyMd: string,
  meta: Record<string, unknown> | null,
  actorId: string,
  explicitReportId?: string,
): Promise<string> {
  const candidateId = explicitReportId ?? randomUUID();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query(
      `insert into public.reports (id, report_type, period_start, period_end, body_md, meta)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [candidateId, type, periodStart, periodEnd, bodyMd, JSON.stringify(meta ?? null)],
    );
    if (ins.rowCount !== 1) {
      throw new Error("Rapor oluşturulamadı");
    }
    const id: string = ins.rows[0].id;
    await audit(client, {
      actor: actorId, action: `generate_report_${type}`, entityTable: "reports", entityId: id,
      after: {
        periodStart,
        periodEnd,
        provenance: meta && typeof meta.provenance === "object" ? meta.provenance : undefined,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function buildFrozenMetaEnvelope(
  pool: Pool,
  asOfDateISO: string,
  bodyMd: string,
  reportScope: string,
  reportMetrics: Record<string, unknown>,
  existingBoardPack?: BoardFinancialPackage,
  provenanceHints?: {
    reconciliationAligned?: boolean;
    missingPaymentAmountCount?: number;
    controlAlertsOpenCount?: number;
    existingProvenance?: ReportProvenance;
    explicitReportId?: string;
  },
): Promise<{ reportId: string; provenance: ReportProvenance; snapshot: BoardFinancialPackage & { reportScope: string; reportMetrics: Record<string, unknown> } }> {
  const reportId = provenanceHints?.explicitReportId ?? randomUUID();
  const asOfAt = provenanceHints?.existingProvenance?.asOfAt ?? new Date().toISOString();
  const basePack = existingBoardPack ?? (await loadBoardFinancialPackage(pool, asOfDateISO));
  const canonicalPayload = `${bodyMd}\n---\n${JSON.stringify({ reportScope, reportMetrics, executiveSummary: basePack.executiveSummary })}`;
  const contentSha256 = computeContentSha256(canonicalPayload);
  const missingFromMetrics =
    provenanceHints?.missingPaymentAmountCount ??
    (typeof reportMetrics.missingCount === "number" ? reportMetrics.missingCount : undefined);
  const provenance =
    provenanceHints?.existingProvenance ??
    (await loadReportProvenance(pool, asOfDateISO, {
      snapshotId: reportId,
      asOfAt,
      contentForHash: canonicalPayload,
      unknownOpeningAccountCount: basePack.unknownOpeningAccountCount,
      knownOpeningAccountCount:
        basePack.executiveSummary.consolidatedCashTry != null ? 1 : 0,
      cashSourceStatus: basePack.cashSourceStatus,
      schemaIncompatibleSources: basePack.schemaIncompatibleSources,
      missingPaymentAmountCount: missingFromMetrics,
      reconciliationAligned:
        provenanceHints?.reconciliationAligned ?? basePack.balanceSheet.balanced,
      controlAlertsOpenCount:
        provenanceHints?.controlAlertsOpenCount ?? basePack.executiveSummary.covenantBreachCount,
    }));
  const finalProvenance: ReportProvenance = {
    ...provenance,
    snapshotId: reportId,
    contentSha256,
  };
  const snapshot = {
    ...basePack,
    provenance: finalProvenance,
    reportScope,
    reportMetrics,
  };
  return { reportId, provenance: finalProvenance, snapshot };
}

/* ── daily ── */

export async function generateDaily(pool: Pool, todayISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const reportId = randomUUID();
  const asOfAt = new Date().toISOString();
  const to = addDaysISO(todayISO, 7);
  const t = await loadThresholds(pool);
  const [soon, overdue, maturities, decisionFacts, basePack, actualBankCashStatus] = await Promise.all([
    instancesBetween(pool, todayISO, to),
    overdueOpen(pool, todayISO),
    maturitiesBetween(pool, todayISO, to),
    loadDecisionFacts(pool, todayISO),
    loadBoardFinancialPackage(pool, todayISO),
    loadMonthlyActualBankCashStatus(pool, todayISO),
  ]);
  const open = new Set(["unpaid", "partial", "planned", "late"]);
  const dueSoonInstances = soon.filter((i) => open.has(i.status)).map(toReportInstance);
  const overdueInstances = overdue.map(toReportInstance);
  const missingCountHint = dueSoonInstances.filter((i) => (i.originalAmount ?? i.amount) == null).length;
  const preProvenance = await loadReportProvenance(pool, todayISO, {
    snapshotId: reportId,
    asOfAt,
    unknownOpeningAccountCount: basePack.unknownOpeningAccountCount,
    knownOpeningAccountCount: basePack.executiveSummary.consolidatedCashTry != null ? 1 : 0,
    cashSourceStatus: basePack.cashSourceStatus,
    schemaIncompatibleSources: basePack.schemaIncompatibleSources,
    missingPaymentAmountCount: missingCountHint,
    reconciliationAligned: basePack.balanceSheet.balanced,
    controlAlertsOpenCount: basePack.executiveSummary.covenantBreachCount,
  });
  const report = buildDailyReport(
    {
      dueSoon: dueSoonInstances,
      overdue: overdueInstances,
      maturities,
      criticalThreshold: t.critical,
      actualBankCashStatus,
      provenance: preProvenance,
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
  const { provenance, snapshot } = await buildFrozenMetaEnvelope(
    pool,
    todayISO,
    report.bodyMd,
    "daily",
    {
      next7KnownTotal: report.next7KnownTotal,
      overdueCount: report.overdueCount,
      overdueKnownTotal: report.overdueKnownTotal,
      missingCount: report.next7MissingCount,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
    },
    basePack,
    {
      existingProvenance: preProvenance,
      explicitReportId: reportId,
    },
  );
  const id = await writeReport(
    pool,
    "daily",
    todayISO,
    to,
    report.bodyMd,
    {
      next7KnownTotal: report.next7KnownTotal,
      overdueCount: report.overdueCount,
      overdueKnownTotal: report.overdueKnownTotal,
      missingCount: report.next7MissingCount,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
      commentary_prompt: prompt,
      provenance,
      snapshot,
    },
    actorId,
    reportId,
  );
  return { id, bodyMd: report.bodyMd };
}

/* ── weekly ── */

export async function generateWeekly(pool: Pool, todayISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const reportId = randomUUID();
  const asOfAt = new Date().toISOString();
  const to = addDaysISO(todayISO, 7);
  const monthStart = todayISO.slice(0, 7) + "-01";
  const nextMonthStart = addMonths(monthStart, 1);
  const t = await loadThresholds(pool);
  const [week, matWeek, matMonth, rdays, decisionFacts, basePack, actualBankCashStatus] = await Promise.all([
    instancesBetween(pool, todayISO, to),
    maturitiesBetween(pool, todayISO, to),
    maturitiesBetweenHalfOpen(pool, monthStart, nextMonthStart),
    riskyDays(pool, todayISO, 7, t),
    loadDecisionFacts(pool, todayISO),
    loadBoardFinancialPackage(pool, todayISO),
    loadMonthlyActualBankCashStatus(pool, todayISO),
  ]);
  const open = new Set(["unpaid", "partial", "planned", "late"]);
  const weekOpenInstances = week.filter((i) => open.has(i.status)).map(toReportInstance);
  const missingCountHint = weekOpenInstances.filter((i) => (i.originalAmount ?? i.amount) == null).length;
  const preProvenance = await loadReportProvenance(pool, todayISO, {
    snapshotId: reportId,
    asOfAt,
    unknownOpeningAccountCount: basePack.unknownOpeningAccountCount,
    knownOpeningAccountCount: basePack.executiveSummary.consolidatedCashTry != null ? 1 : 0,
    cashSourceStatus: basePack.cashSourceStatus,
    schemaIncompatibleSources: basePack.schemaIncompatibleSources,
    missingPaymentAmountCount: missingCountHint,
    reconciliationAligned: basePack.balanceSheet.balanced,
    controlAlertsOpenCount: basePack.executiveSummary.covenantBreachCount,
  });
  const report = buildWeeklyReport(
    {
      weekInstances: weekOpenInstances,
      maturitiesWeek: matWeek,
      installmentsMonth: matMonth.filter((m) => m.kind === "loan_installment" && m.direction !== "inflow"),
      riskDays: rdays.map((d) => ({ date: d.date, cluster: d.cluster, critical: d.critical, large: d.large, knownSum: d.knownSum, count: d.count })),
      largeThreshold: t.large,
      actualBankCashStatus,
      provenance: preProvenance,
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
  const { provenance, snapshot } = await buildFrozenMetaEnvelope(
    pool,
    todayISO,
    report.bodyMd,
    "weekly",
    {
      knownTotal: report.knownTotal,
      checkLoad: report.checkLoad,
      installmentLoadWeek: report.installmentLoadWeek,
      installmentLoadMonth: report.installmentLoadMonth,
      missingCount: report.missingCount,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
    },
    basePack,
    {
      existingProvenance: preProvenance,
      explicitReportId: reportId,
    },
  );
  const id = await writeReport(
    pool,
    "weekly",
    todayISO,
    to,
    report.bodyMd,
    {
      knownTotal: report.knownTotal,
      checkLoad: report.checkLoad,
      installmentLoadWeek: report.installmentLoadWeek,
      installmentLoadMonth: report.installmentLoadMonth,
      missingCount: report.missingCount,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
      commentary_prompt: prompt,
      provenance,
      snapshot,
    },
    actorId,
    reportId,
  );
  return { id, bodyMd: report.bodyMd };
}

/* ── monthly ── */

async function distribution(pool: Pool, monthStart: string, joinCol: string, nameSelect: string) {
  const r = await pool.query(
    // PHASE 2.2 (#9) & 4.A: Dağılım yalnız aktif, iptal edilmemiş TRY çıkış kalemlerinden hesaplanır.
    `select coalesce(${nameSelect}, '(atanmadı)') as key,
            sum(i.amount) filter (where i.currency = 'TRY') as amount,
            count(*) filter (where i.currency <> 'TRY')::int as foreign_count
     from public.payment_instances i
     left join public.payments p on p.id = i.payment_id
     ${joinCol}
     where i.instance_month = $1
       and i.amount is not null
       and i.status <> 'cancelled'
       and i.cancelled_at is null
       and coalesce(i.direction, 'outflow') = 'outflow'
     group by 1 order by amount desc nulls last`,
    [monthStart],
  );
  // Postgres already summed these exactly; only the trip into JS needed fixing. Ordering is
  // still done in SQL on the numeric, so the ranking is unaffected by the decode.
  return r.rows.map((x) => ({ key: x.key as string, amount: moneyOrNull(x.amount) ?? 0, foreignCount: Number(x.foreign_count ?? 0) }));
}

async function loadMonthlyActualBankCashStatus(
  pool: Pool,
  periodEndISO: string,
): Promise<MonthlyActualBankCashStatus | null> {
  try {
    const res = await pool.query<{
      unknown_opening_n: number;
      known_opening_n: number;
      actual_cash_try: string | null;
      bt_total: number;
      bt_reconciled: number;
      bt_unmatched: number;
    }>(
      `select
         (select count(*) filter (where opening_balance is null)::int
            from public.cash_accounts
           where is_active = true and archived_at is null) as unknown_opening_n,
         (select count(*) filter (where opening_balance is not null)::int
            from public.cash_accounts
           where is_active = true and archived_at is null and currency = 'TRY') as known_opening_n,
         (select case
                   when count(*) filter (where ca.opening_balance is null) > 0 then null::text
                   when count(*) = 0 then null::text
                   else sum(ca.opening_balance + coalesce(tx.net_tx, 0))::text
                 end
            from public.cash_accounts ca
            left join lateral (
              select sum(bt.amount) as net_tx
                from public.bank_transactions bt
               where bt.bank_account_id = ca.id
                 and bt.status <> 'ignored'
                 and bt.txn_date <= $1::date
                 and coalesce(bt.currency, 'TRY') = 'TRY'
            ) tx on true
           where ca.is_active = true and ca.archived_at is null and ca.currency = 'TRY') as actual_cash_try,
         (select count(*)::int from public.bank_transactions where status <> 'ignored' and txn_date <= $1::date) as bt_total,
         (select count(*) filter (where status in ('matched', 'reconciled'))::int
            from public.bank_transactions
           where status <> 'ignored' and txn_date <= $1::date) as bt_reconciled,
         (select count(*) filter (where status in ('unmatched', 'suggested'))::int
            from public.bank_transactions
           where status <> 'ignored' and txn_date <= $1::date) as bt_unmatched`,
      [periodEndISO],
    );
    const row = res.rows[0];
    if (!row) return null;
    const unknownOpeningCount = Number(row.unknown_opening_n ?? 0);
    const knownOpeningCount = Number(row.known_opening_n ?? 0);
    const btTotal = Number(row.bt_total ?? 0);
    const parsedCash = unknownOpeningCount > 0 ? null : moneyOrNull(row.actual_cash_try);
    const cashSourceStatus =
      unknownOpeningCount > 0
        ? "PARTIAL_MISSING_OPENING"
        : knownOpeningCount === 0 || parsedCash === null || (parsedCash === 0 && btTotal === 0)
          ? "SOURCE_UNAVAILABLE"
          : "COMPLETE";
    return {
      availableCashTry: cashSourceStatus === "COMPLETE" ? parsedCash : null,
      unknownOpeningCount,
      hasVerifiedBankFeed: btTotal > 0,
      reconciledTxCount: Number(row.bt_reconciled ?? 0),
      unmatchedTxCount: Number(row.bt_unmatched ?? 0),
      cashSourceStatus,
    };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01" || code === "42703") {
      return {
        availableCashTry: null,
        unknownOpeningCount: 0,
        hasVerifiedBankFeed: false,
        reconciledTxCount: 0,
        unmatchedTxCount: 0,
        cashSourceStatus: "SCHEMA_INCOMPATIBLE",
      };
    }
    throw err;
  }
}

export async function generateMonthly(pool: Pool, monthStartISO: string, actorId: string): Promise<{ id: string; bodyMd: string }> {
  const reportId = randomUUID();
  const asOfAt = new Date().toISOString();
  const nextMonthStart = addMonths(monthStartISO, 1);
  const periodEndISO = addDaysISO(nextMonthStart, -1);
  const [summary, insts, providerDist, categoryDist, ownerDist, monthMaturities, cashRow, unassigned, decisionFacts, actualBankCashStatus, basePack] =
    await Promise.all([
      monthSummary(pool, monthStartISO),
      monthInstances(pool, monthStartISO),
      distribution(pool, monthStartISO, "left join public.parties pr on pr.id = p.provider_party_id", "pr.name"),
      distribution(pool, monthStartISO, "left join public.categories c on c.id = p.category_id", "c.name"),
      distribution(pool, monthStartISO, "left join public.parties o on o.id = p.owner_party_id", "o.name"),
      maturitiesBetweenHalfOpen(pool, monthStartISO, nextMonthStart),
      pool.query(
        `select opening_balance as opening, projected_income as income,
                projected_expense as expense, closing_balance as closing
         from public.cashflow_months where month_start = $1`,
        [monthStartISO],
      ),
      pool.query(
        `select count(*) filter (where p.provider_party_id is null)::int as no_provider,
                count(*) filter (where p.category_id is null)::int as no_category
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
         where i.instance_month = $1
           and i.status <> 'cancelled'
           and i.cancelled_at is null
           and coalesce(i.direction, 'outflow') = 'outflow'`,
        [monthStartISO],
      ),
      loadDecisionFacts(pool, monthStartISO),
      loadMonthlyActualBankCashStatus(pool, periodEndISO),
      loadBoardFinancialPackage(pool, periodEndISO),
    ]);

  const noProviderCount = Number(unassigned.rows[0]?.no_provider ?? 0);
  const noCategoryCount = Number(unassigned.rows[0]?.no_category ?? 0);

  const topPayments = [...insts]
    .filter((i) => (i.original_amount ?? i.amount) != null)
    .sort((a, b) => ((b.original_amount ?? b.amount) ?? 0) - ((a.original_amount ?? a.amount) ?? 0))
    .slice(0, 10)
    .map(toReportInstance);

  const dq: string[] = [];
  if (summary.missing_count > 0) dq.push(`${summary.missing_count} kalemde tutar eksik`);
  if (noProviderCount > 0) dq.push(`${noProviderCount} kalemde sağlayıcı atanmamış`);
  if (noCategoryCount > 0) dq.push(`${noCategoryCount} kalemde kategori atanmamış`);

  const preProvenance = await loadReportProvenance(pool, periodEndISO, {
    snapshotId: reportId,
    asOfAt,
    unknownOpeningAccountCount: basePack.unknownOpeningAccountCount,
    knownOpeningAccountCount: basePack.executiveSummary.consolidatedCashTry != null ? 1 : 0,
    cashSourceStatus: actualBankCashStatus?.cashSourceStatus ?? basePack.cashSourceStatus,
    schemaIncompatibleSources: basePack.schemaIncompatibleSources,
    missingPaymentAmountCount: summary.missing_count,
    reconciliationAligned: summary.unexplainedGapTry === 0,
    controlAlertsOpenCount: basePack.executiveSummary.covenantBreachCount,
  });

  const report = buildMonthlyReport({
    monthStart: monthStartISO,
    knownTotal: summary.known_total,
    knownRemaining: summary.known_remaining,
    paidKnown: summary.paid_known,
    missingCount: summary.missing_count,
    totalCount: summary.total_count,
    cancelledCount: summary.cancelledCount,
    cancelledKnownTotal: summary.cancelledKnownTotal,
    settlementAdjustmentTry: summary.settlementAdjustmentTry,
    overpaymentAdjustmentTry: summary.overpaymentAdjustmentTry,
    foreignCount: summary.foreign_count,
    topPayments,
    providerDist, categoryDist, ownerDist,
    checksInMonth: monthMaturities.filter((m) => m.kind === "check" && m.direction === "outflow"),
    installmentsInMonth: monthMaturities.filter((m) => m.kind === "loan_installment" && m.direction !== "inflow"),
    cashMonth: cashRow.rows[0]
      ? {
          opening: moneyOrNull(cashRow.rows[0].opening), income: moneyOrNull(cashRow.rows[0].income),
          expense: moneyOrNull(cashRow.rows[0].expense), closing: moneyOrNull(cashRow.rows[0].closing),
        }
      : null,
    actualBankCashStatus,
    provenance: preProvenance,
    dataQualityIssues: dq,
  });
  const prompt = buildCommentaryPrompt({
    scope: "monthly", period: monthStartISO.slice(0, 7),
    deterministicFacts: [
      `bilinen yük ${summary.known_total}`,
      `ödenen ${summary.paid_known} kalan ${summary.known_remaining}`,
      ...(summary.cancelledCount > 0
        ? [`iptal edilen toplam dışı ${summary.cancelledCount} kalem (${summary.cancelledKnownTotal})`]
        : []),
      `borç servisi ${report.debtServiceKnown}`,
      `${summary.missing_count} tutar eksik`,
      ...decisionFacts.slice(0, 4).map((f) => `${f.title}: ${f.value}`),
    ],
  });
  const { provenance, snapshot } = await buildFrozenMetaEnvelope(
    pool,
    periodEndISO,
    report.bodyMd,
    "monthly",
    {
      knownTotal: summary.known_total,
      knownRemaining: summary.known_remaining,
      paidKnown: summary.paid_known,
      cancelledCount: summary.cancelledCount,
      cancelledKnownTotal: summary.cancelledKnownTotal,
      settlementAdjustmentTry: summary.settlementAdjustmentTry,
      overpaymentAdjustmentTry: summary.overpaymentAdjustmentTry,
      unexplainedGapTry: summary.unexplainedGapTry,
      totalCount: summary.total_count,
      missingCount: summary.missing_count,
      noProviderCount,
      noCategoryCount,
      debtServiceKnown: report.debtServiceKnown,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
    },
    basePack,
    {
      reconciliationAligned: summary.unexplainedGapTry === 0,
      missingPaymentAmountCount: summary.missing_count,
      existingProvenance: preProvenance,
      explicitReportId: reportId,
    },
  );
  const id = await writeReport(
    pool,
    "monthly",
    monthStartISO,
    periodEndISO,
    report.bodyMd,
    {
      knownTotal: summary.known_total,
      knownRemaining: summary.known_remaining,
      paidKnown: summary.paid_known,
      cancelledCount: summary.cancelledCount,
      cancelledKnownTotal: summary.cancelledKnownTotal,
      settlementAdjustmentTry: summary.settlementAdjustmentTry,
      overpaymentAdjustmentTry: summary.overpaymentAdjustmentTry,
      unexplainedGapTry: summary.unexplainedGapTry,
      totalCount: summary.total_count,
      missingCount: summary.missing_count,
      debtServiceKnown: report.debtServiceKnown,
      monetaryBasisByMetric: report.monetaryBasisByMetric,
      commentary_prompt: prompt,
      provenance,
      snapshot,
    },
    actorId,
    reportId,
  );
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

/* ── board & bank financial package (M-58) ── */

export async function generateBoardPackage(
  pool: Pool,
  todayISO: string,
  actorId: string,
): Promise<{ id: string; bodyMd: string; snapshot: BoardFinancialPackage }> {
  const baseSnapshot = await loadBoardFinancialPackage(pool, todayISO);
  const bodyMd = renderBoardPackMarkdown(baseSnapshot);
  const periodStart = `${todayISO.slice(0, 7)}-01`;
  const prompt = buildCommentaryPrompt({
    scope: "monthly",
    period: `${periodStart}..${todayISO}`,
    deterministicFacts: [
      `konsolide kasa ${baseSnapshot.executiveSummary.consolidatedCashTry ?? "bilinmiyor"}`,
      `FAVÖK ${baseSnapshot.executiveSummary.managementEbitdaTry ?? "bilinmiyor"}`,
      `13H en düşük kasa ${baseSnapshot.executiveSummary.worst13WeekCashTry ?? "bilinmiyor"}`,
      `açık alacak ${baseSnapshot.executiveSummary.openArTry} açık borç ${baseSnapshot.executiveSummary.openApTry}`,
      `kovenant ihlali ${baseSnapshot.executiveSummary.covenantBreachCount}`,
    ],
  });
  const { reportId, provenance, snapshot } = await buildFrozenMetaEnvelope(
    pool,
    todayISO,
    bodyMd,
    "board_pack",
    {
      consolidatedCashTry: baseSnapshot.executiveSummary.consolidatedCashTry,
      managementEbitdaTry: baseSnapshot.executiveSummary.managementEbitdaTry,
      worst13WeekCashTry: baseSnapshot.executiveSummary.worst13WeekCashTry,
    },
    baseSnapshot,
  );
  const id = await writeReport(
    pool,
    "strategic",
    periodStart,
    todayISO,
    bodyMd,
    {
      packageKind: "board_pack",
      provenance,
      snapshot,
      commentary_prompt: prompt,
    },
    actorId,
    reportId,
  );
  return { id, bodyMd, snapshot };
}

/* ── read-side for /reports ── */

export async function listReports(pool: Pool) {
  const r = await pool.query(
    `select id, report_type, to_char(period_start,'YYYY-MM-DD') as period_start,
            to_char(period_end,'YYYY-MM-DD') as period_end,
            meta,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.reports order by created_at desc limit 50`,
  );
  return r.rows as Array<{
    id: string;
    report_type: string;
    period_start: string;
    period_end: string;
    meta: Record<string, unknown> | null;
    created_at: string;
  }>;
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
