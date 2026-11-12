// Faz 32 + Faz 46 — CFO morning briefing.
//
// ═══ THE CONSISTENCY REQUIREMENT IS STRUCTURAL, NOT ASPIRATIONAL ═══
//
// This module issues NO SQL of its own for any headline figure. It calls the SAME loader functions
// the pages call — loadPositionSummary/loadLiquidityGap (treasury), loadWorkingCapital (costing),
// loadControlDashboard (controls), loadOpenPromises (collections), instancesOn/overdueOpen (radar).
//
// ═══ NO LLM IN THE BRIEFING ═══
//
// This module does not import @/lib/ai.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { decimal, money, moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import { instancesOn, overdueOpen } from "@/lib/radar/queries";
import { loadConfiguredFloorCurrencies, loadLiquidityGap, loadPositionSummary } from "@/lib/treasury/engine";
import { loadWorkingCapital } from "@/lib/costing/engine";
import { loadControlDashboard, loadAlerts } from "@/lib/controls/engine";
import { loadOpenPromises } from "@/lib/collections/promises-engine";
import { buildWidgets, widgetsNeedingAttention, type CockpitWidgetFacts } from "@/lib/home/cockpit";
import { renderBriefing, summariseDay, type BriefingFacts } from "./rules";
import { loadOvernightDeltaAttribution } from "./delta-attribution";

/**
 * Gather the briefing's facts from the systems that own them.
 *
 * Faz 46: Never fall back to a non-TRY currency row (`summary[0]` or `gaps.find(horizonDays === 7)`)
 * because `renderBriefing` formats figures with `" TL"`. When no TRY account/row exists, the TRY
 * headline figures stay `null` ("—") rather than mislabelling USD/EUR cash as Turkish Lira.
 */
export async function loadBriefingFacts(pool: Pool, todayISO: string): Promise<BriefingFacts> {
  const [summary, gaps, floorCurrencies, working, controls, alerts, promises, todayInstances, overdue] =
    await Promise.all([
      loadPositionSummary(pool),
      loadLiquidityGap(pool),
      loadConfiguredFloorCurrencies(pool),
      loadWorkingCapital(pool),
      loadControlDashboard(pool),
      loadAlerts(pool, 200),
      loadOpenPromises(pool, 200),
      instancesOn(pool, todayISO),
      overdueOpen(pool, todayISO),
    ]);

  const tryPos = summary.find((s) => s.currency === "TRY") ?? null;
  const gap7 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 7) ?? null;
  const gap30 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 30) ?? null;

  const today = summariseDay(todayInstances.map((i) => ({
    amount: i.amount, direction: (i as { direction?: string }).direction ?? "outflow",
    currency: (i as { currency?: string | null }).currency ?? null,
  })));
  const late = summariseDay(overdue.map((i) => ({
    amount: i.amount, direction: (i as { direction?: string }).direction ?? "outflow",
    currency: (i as { currency?: string | null }).currency ?? null,
  })));

  const minCashFloor = gap7 != null && floorCurrencies.has(gap7.currency) ? gap7.minCashFloor : null;
  const availableCash = tryPos?.availableNow ?? null;
  const liquidityGap7 = gap7?.financingNeed ?? null;
  const overnightDelta = await loadOvernightDeltaAttribution(pool, todayISO, {
    currency: "TRY",
    currentAvailableCash: availableCash,
    currentLiquidityGap7: liquidityGap7,
  });

  return {
    todayISO,
    availableCash: tryPos?.availableNow ?? null,
    minCashFloor,
    liquidityGap7: gap7?.financingNeed ?? null,
    liquidityGap30: gap30?.financingNeed ?? null,
    projectedContracted7: gap7?.projectedContracted ?? null,
    todayOutflowKnown: today.knownOutflow,
    todayInflowKnown: today.knownInflow,
    todayCount: todayInstances.length,
    todayUnknownAmountCount: today.unknownCount,
    todayForeignCurrencyCount: today.foreignCount,
    overdueForeignCurrencyCount: late.foreignCount,
    overdueCount: overdue.length,
    overdueKnownOutflow: late.knownOutflow,
    criticalControls: controls.filter((c) => c.state === "CRITICAL").map((c) => c.title),
    openAlertCount: alerts.filter((a) => a.status === "open").length,
    newCriticalAlerts: alerts
      .filter((a) => a.status === "open" && a.severity === "critical")
      .slice(0, 5)
      .map((a) => a.title),
    promisesDueToday: promises.filter((p) => p.promisedDate === todayISO).length,
    overduePromises: promises.filter((p) => p.isOverdue).length,
    dsoDays: working?.dsoDays ?? null,
    dpoDays: working?.dpoDays ?? null,
    cycleExcludingInventory: working?.cycleExcludingInventory ?? null,
    overnightDelta,
  };
}

/**
 * Cockpit widget facts, from the SAME loaders as the briefing.
 */
async function gatherWidgetFacts(
  pool: Pool,
  todayISO: string,
  briefingFacts?: Promise<BriefingFacts> | BriefingFacts,
): Promise<{ briefingFacts: BriefingFacts; widgetFacts: CockpitWidgetFacts }> {
  const [facts, working, controls, alerts, debt, facility, fx, budget, conc] = await Promise.all([
    briefingFacts ?? loadBriefingFacts(pool, todayISO),
    loadWorkingCapital(pool),
    loadControlDashboard(pool),
    loadAlerts(pool, 200),
    pool.query(`select coalesce(sum(total_cash_exposure),0) as due30
      from public.debt_maturity_ladder where sort_order = 1`),
    pool.query(`select coalesce(sum(available_amount),0) as available, coalesce(sum(drawn_amount),0) as drawn
      from public.credit_facility_utilization where status = 'active' and currency = 'TRY'`),
    pool.query(`select sum(worst_case_20_delta) as worst from public.fx_exposure_summary`),
    pool.query(`select count(*)::int n from public.budget_vs_actual where variance_verdict = 'over_budget'`),
    pool.query(`select max(late_ratio) as top from public.counterparty_collection_profile`),
  ]);

  const drawn = moneyOrNull(facility.rows[0]?.drawn) ?? 0;

  return { briefingFacts: facts, widgetFacts: {
    availableCash: facts.availableCash,
    minCashFloor: facts.minCashFloor,
    liquidityGap7: facts.liquidityGap7,
    liquidityGap30: facts.liquidityGap30,
    receivablesOpen: working?.receivablesOpen ?? null,
    payablesOpen: working?.payablesOpen ?? null,
    dsoDays: working?.dsoDays ?? null,
    dpoDays: working?.dpoDays ?? null,
    netDebt: facts.availableCash == null
      ? null
      : money(decimal(drawn).minus(decimal(facts.availableCash))),
    facilityAvailable: moneyOrNull(facility.rows[0]?.available),
    debtDue30: moneyOrNull(debt.rows[0]?.due30),
    fxWorstCase20: moneyOrNull(fx.rows[0]?.worst),
    budgetVarianceOverCount: Number(budget.rows[0]?.n ?? 0),
    cycleExcludingInventory: working?.cycleExcludingInventory ?? null,
    criticalControlCount: controls.filter((c) => c.state === "CRITICAL").length,
    openAlertCount: alerts.filter((a) => a.status === "open").length,
    topConcentrationRatio: conc.rows[0]?.top == null ? null : Number(conc.rows[0].top),
  } };
}

export async function loadWidgetFacts(pool: Pool, todayISO: string): Promise<CockpitWidgetFacts> {
  return (await gatherWidgetFacts(pool, todayISO)).widgetFacts;
}

/** One request-level gather for the briefing screen; shared facts are never loaded twice. */
export async function loadBriefingDashboard(pool: Pool, todayISO: string) {
  const factsPromise = loadBriefingFacts(pool, todayISO);
  const { briefingFacts: facts, widgetFacts } = await gatherWidgetFacts(pool, todayISO, factsPromise);
  const widgets = buildWidgets(widgetFacts);
  return { facts, widgets, attention: widgetsNeedingAttention(widgets) };
}

export interface BriefingResult {
  reportId: string;
  bodyMd: string;
  facts: BriefingFacts;
}

export async function generateCfoBriefing(
  pool: Pool, todayISO: string, actorId: string,
): Promise<BriefingResult> {
  const facts = await loadBriefingFacts(pool, todayISO);
  const bodyMd = renderBriefing(facts);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.reports (report_type, period_start, period_end, body_md, meta)
       values ('cfo_briefing', $1::date, $1::date, $2, $3::jsonb)
       returning id`,
      [todayISO, bodyMd, JSON.stringify({
        availableCash: facts.availableCash,
        liquidityGap7: facts.liquidityGap7,
        overdueCount: facts.overdueCount,
        criticalControls: facts.criticalControls.length,
      })]);
    const id = res.rows[0].id;

    await audit(client, {
      actor: actorId, action: "generate_cfo_briefing",
      entityTable: "reports", entityId: id,
      after: {
        todayISO, overdueCount: facts.overdueCount,
        criticalControls: facts.criticalControls.length,
        mutatedFinancialRecords: false, automated: true, llmUsed: false,
      },
    });
    await client.query("commit");
    return { reportId: id, bodyMd, facts };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function dispatchBriefing(
  pool: Pool,
  transport: { channel: string; send(message: string): Promise<{ ok: boolean; error?: string }> },
  bodyMd: string,
  reportId: string,
  actorId: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await transport.send(bodyMd);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await audit(client, {
      actor: actorId, action: "dispatch_cfo_briefing",
      entityTable: "reports", entityId: reportId,
      after: { channel: transport.channel, ok: result.ok, error: result.error ?? null, automated: true },
    });
    await client.query("commit");
  } finally {
    client.release();
  }
  return result;
}

/** Today's calendar, from the unified view. */
export async function loadCalendar(pool: Pool, fromISO: string, toISO: string) {
  const r = await pool.query(
    `select source_kind, source_id, to_char(event_date,'YYYY-MM-DD') as event_date,
            label, category_name, counterparty_name, amount_signed, currency, status, certainty
     from public.financial_calendar
     where event_date >= $1::date and event_date <= $2::date
     order by event_date, source_kind, label`, [fromISO, toISO]);
  return r.rows.map((x) => ({
    sourceKind: x.source_kind as string,
    sourceId: x.source_id as string,
    eventDate: x.event_date as string,
    label: x.label as string,
    categoryName: x.category_name as string | null,
    counterpartyName: x.counterparty_name as string | null,
    amountSigned: moneyOrNull(x.amount_signed),
    currency: x.currency as string,
    status: x.status as string,
    certainty: x.certainty as string,
  }));
}

export async function loadCalendarDaily(pool: Pool, fromISO: string, toISO: string) {
  const r = await pool.query(
    `select to_char(event_date,'YYYY-MM-DD') as event_date, currency, event_count,
            net_contracted, net_expected, inflow_contracted, outflow_contracted, renewal_count
     from public.financial_calendar_daily
     where event_date >= $1::date and event_date <= $2::date
     order by event_date`, [fromISO, toISO]);
  return r.rows.map((x) => ({
    eventDate: x.event_date as string,
    currency: x.currency as string,
    eventCount: Number(x.event_count),
    netContracted: moneyOrNull(x.net_contracted) ?? 0,
    netExpected: moneyOrNull(x.net_expected) ?? 0,
    inflowContracted: moneyOrNull(x.inflow_contracted) ?? 0,
    outflowContracted: moneyOrNull(x.outflow_contracted) ?? 0,
    renewalCount: Number(x.renewal_count),
  }));
}

/** The widgets, ready to render. */
export async function loadCockpitWidgets(pool: Pool, todayISO = istanbulDateISO()) {
  const facts = await loadWidgetFacts(pool, todayISO);
  const widgets = buildWidgets(facts);
  return { facts, widgets, attention: widgetsNeedingAttention(widgets) };
}
