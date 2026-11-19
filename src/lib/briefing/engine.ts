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

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { isPool, withPinnedRead } from "@/lib/pg-concurrency";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";
import {
  computeContentSha256,
  loadBoardFinancialPackage,
  loadReportProvenance,
  type ReportProvenance,
} from "@/lib/reports/board-pack";
import { istanbulDateISO } from "@/lib/reports/rules";
import { instancesOn, overdueOpen } from "@/lib/radar/queries";
import { loadConfiguredFloorCurrencies, loadLiquidityGap, loadPositionSummary } from "@/lib/treasury/engine";
import { loadWorkingCapital } from "@/lib/costing/engine";
import { loadControlDashboard, loadAlerts } from "@/lib/controls/engine";
import { loadOpenPromises } from "@/lib/collections/promises-engine";
import { buildWidgets, widgetsNeedingAttention, type CockpitWidgetFacts } from "@/lib/home/cockpit";
import {
  renderBriefing,
  renderBriefingTelegramText,
  summariseDay,
  type BriefingCurrencyPosition,
  type BriefingFacts,
} from "./rules";
import { isMissingSchemaError, loadOvernightDeltaAttribution } from "./delta-attribution";

async function loadSpotFxRatesToTry(
  pool: Pool,
  todayISO: string,
): Promise<{ rates: Record<string, number>; latestDate: string | null }> {
  const rates: Record<string, number> = { TRY: 1 };
  let latestDate: string | null = null;
  try {
    const res = await pool.query<{
      base_currency: string;
      rate: string;
      rate_date: string;
    }>(
      `select distinct on (base_currency)
              base_currency,
              rate::text as rate,
              to_char(rate_date, 'YYYY-MM-DD') as rate_date
         from public.fx_rate_snapshots
        where quote_currency = 'TRY'
          and rate_date <= $1::date
        order by base_currency, rate_date desc, id desc`,
      [todayISO],
    );
    for (const r of res.rows) {
      const parsed = rateOrNull(r.rate);
      if (parsed != null && parsed > 0) {
        rates[r.base_currency.toUpperCase()] = parsed;
        if (!latestDate || r.rate_date > latestDate) latestDate = r.rate_date;
      }
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  return { rates, latestDate };
}

/**
 * Gather the briefing's facts from the systems that own them.
 *
 * Faz 46 + M-56: Preserves native TRY figures (`availableCash`, `liquidityGap7`) while also
 * computing TCMB `fx_rate_snapshots`-converted multi-currency equivalents (`consolidatedCashTry`,
 * `consolidatedGap7Try`, `todayConsolidatedOutflowTry`, `overdueConsolidatedOutflowTry`) so USD/EUR/GBP
 * obligations are neither raw-summed nor silently dropped.
 */
async function loadBriefingCore(pool: Pool, todayISO: string) {
  const [summary, gaps, floorCurrencies, working, controls, alerts, promises, todayInstances, overdue, fxSnap, fin03MetaRes] =
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
      loadSpotFxRatesToTry(pool, todayISO),
      pool
        .query<{ unknown_opening_n?: number; stored_briefing_id?: string | null }>(
          `select
             (select count(*) filter (where opening_balance is null)::int
                from public.cash_accounts
               where is_active = true and archived_at is null) as unknown_opening_n,
             (select id::text
                from public.reports
               where report_type = 'cfo_briefing'
                 and period_start = $1::date
               order by created_at desc
               limit 1) as stored_briefing_id`,
          [todayISO],
        )
        .catch((err: unknown) => {
          if (isMissingSchemaError(err)) return { rows: [] as Array<Record<string, never>> };
          throw err;
        }),
    ]);

  const fxRates = fxSnap.rates;
  const tryPos = summary.find((s) => s.currency === "TRY") ?? null;
  const gap7 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 7) ?? null;
  const gap30 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 30) ?? null;

  const dbUnknownOpeningCount = Number(fin03MetaRes.rows[0]?.unknown_opening_n ?? 0);
  const summaryHasUnknownOpening =
    dbUnknownOpeningCount > 0 ||
    summary.some(
      (s) =>
        ((s as { unknownOpeningCount?: number }).unknownOpeningCount ?? 0) > 0 ||
        s.availableNow == null,
    );

  const currencyPositions: BriefingCurrencyPosition[] = [];
  let consolidatedCashDec = decimal(0);
  let hasAnyKnownCash = false;
  let allCurrenciesConverted = true;
  for (const s of summary) {
    const ccy = s.currency.toUpperCase();
    const rate = fxRates[ccy] ?? null;
    const avail = s.availableNow;
    let tryEq: number | null = null;
    if (avail != null && rate != null && rate > 0) {
      const converted = decimal(avail).times(decimal(rate));
      tryEq = money(converted.toString());
      consolidatedCashDec = consolidatedCashDec.plus(converted);
      hasAnyKnownCash = true;
    } else {
      allCurrenciesConverted = false;
    }
    currencyPositions.push({
      currency: ccy,
      availableNow: avail,
      rateToTry: rate,
      tryEquivalent: tryEq,
    });
  }
  const consolidatedCashTry =
    !summaryHasUnknownOpening && allCurrenciesConverted && hasAnyKnownCash
      ? money(consolidatedCashDec.toString())
      : null;

  const gap7Rows = gaps.filter((row) => row.horizonDays === 7);
  let consolidatedGap7Dec = decimal(0);
  let hasGap7 = false;
  let allGap7Converted = !summaryHasUnknownOpening;
  for (const g of gap7Rows) {
    const rate = fxRates[g.currency.toUpperCase()];
    if (g.financingNeed != null && rate != null && rate > 0) {
      consolidatedGap7Dec = consolidatedGap7Dec.plus(decimal(g.financingNeed).times(decimal(rate)));
      hasGap7 = true;
    } else {
      allGap7Converted = false;
    }
  }
  const consolidatedGap7Try =
    allGap7Converted && hasGap7 ? money(consolidatedGap7Dec.toString()) : null;

  const gap30Rows = gaps.filter((row) => row.horizonDays === 30);
  let consolidatedGap30Dec = decimal(0);
  let hasGap30 = false;
  let allGap30Converted = !summaryHasUnknownOpening;
  for (const g of gap30Rows) {
    const rate = fxRates[g.currency.toUpperCase()];
    if (g.financingNeed != null && rate != null && rate > 0) {
      consolidatedGap30Dec = consolidatedGap30Dec.plus(decimal(g.financingNeed).times(decimal(rate)));
      hasGap30 = true;
    } else {
      allGap30Converted = false;
    }
  }
  const consolidatedGap30Try =
    allGap30Converted && hasGap30 ? money(consolidatedGap30Dec.toString()) : null;

  const today = summariseDay(
    todayInstances.map((i) => ({
      amount: i.amount,
      direction: (i as { direction?: string }).direction ?? "outflow",
      currency: (i as { currency?: string | null }).currency ?? null,
    })),
    fxRates,
  );
  const late = summariseDay(
    overdue.map((i) => ({
      amount: i.amount,
      direction: (i as { direction?: string }).direction ?? "outflow",
      currency: (i as { currency?: string | null }).currency ?? null,
    })),
    fxRates,
  );

  const minCashFloor = gap7 != null && floorCurrencies.has(gap7.currency) ? gap7.minCashFloor : null;
  const availableCash = tryPos ? tryPos.availableNow : null;
  const liquidityGap7 = gap7 ? gap7.financingNeed : null;
  const effectiveDeltaCash = summaryHasUnknownOpening ? null : (consolidatedCashTry ?? availableCash);
  const effectiveDeltaGap7 = summaryHasUnknownOpening ? null : (consolidatedGap7Try ?? liquidityGap7);
  const overnightDelta = await loadOvernightDeltaAttribution(pool, todayISO, {
    currency: "TRY",
    currentAvailableCash: effectiveDeltaCash,
    currentLiquidityGap7: effectiveDeltaGap7,
    fxRates,
  });

  const storedBriefingId =
    typeof fin03MetaRes.rows[0]?.stored_briefing_id === "string" &&
    fin03MetaRes.rows[0].stored_briefing_id.length > 0
      ? fin03MetaRes.rows[0].stored_briefing_id
      : undefined;
  const provenance = await loadReportProvenance(pool, todayISO, {
    snapshotId: storedBriefingId,
    contentForHash: JSON.stringify({
      todayISO,
      availableCash,
      consolidatedCashTry,
      liquidityGap7,
      todayCount: todayInstances.length,
      overdueCount: overdue.length,
    }),
  });

  const facts: BriefingFacts = {
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
    dioDays: working?.dioDays ?? null,
    cashConversionCycleDays: working?.cashConversionCycleDays ?? null,
    cycleExcludingInventory: working?.cycleExcludingInventory ?? null,
    overnightDelta,
    fxRatesAsOf: fxSnap.latestDate,
    consolidatedCashTry,
    consolidatedGap7Try,
    consolidatedGap30Try,
    todayConsolidatedOutflowTry: today.consolidatedOutflowTry,
    todayConsolidatedInflowTry: today.consolidatedInflowTry,
    overdueConsolidatedOutflowTry: late.consolidatedOutflowTry,
    convertedForeignCount: today.convertedForeignCount + late.convertedForeignCount,
    unconvertibleForeignCount: today.unconvertibleForeignCount + late.unconvertibleForeignCount,
    currencyPositions,
    provenance,
  };

  return { facts, working, controls, alerts };
}

export async function loadBriefingFacts(pool: Pool, todayISO: string): Promise<BriefingFacts> {
  if (isPool(pool)) {
    return withPinnedRead(pool, async (pinned) => (await loadBriefingCore(pinned, todayISO)).facts);
  }
  return (await loadBriefingCore(pool, todayISO)).facts;
}

/**
 * Cockpit widget facts, from the SAME loaders as the briefing.
 */
async function gatherWidgetFacts(
  pool: Pool,
  todayISO: string,
): Promise<{ briefingFacts: BriefingFacts; widgetFacts: CockpitWidgetFacts }> {
  return withPinnedRead(pool, async (pinned) => {
    const [core, extraRes] = await Promise.all([
      loadBriefingCore(pinned, todayISO),
      pinned.query<{
        due30: string | null;
        available: string | null;
        drawn: string | null;
        worst: string | null;
        over_budget_n: number;
        top_late: string | null;
      }>(
        `select
           (select coalesce(sum(total_cash_exposure), 0) from public.debt_maturity_ladder where sort_order = 1)::text as due30,
           fac.available::text as available,
           fac.drawn::text as drawn,
           (select sum(worst_case_20_delta) from public.fx_exposure_summary)::text as worst,
           (select count(*)::int from public.budget_vs_actual where variance_verdict = 'over_budget') as over_budget_n,
           (select max(late_ratio) from public.counterparty_collection_profile)::text as top_late
         from (
           select coalesce(
                    sum(
                      case
                        when cfu.currency = 'TRY' then cfu.available_amount
                        when l.rate is not null then cfu.available_amount * l.rate
                        else 0
                      end
                    ),
                    0
                  ) as available,
                  coalesce(
                    sum(
                      case
                        when cfu.currency = 'TRY' then cfu.drawn_amount
                        when l.rate is not null then cfu.drawn_amount * l.rate
                        else 0
                      end
                    ),
                    0
                  ) as drawn
           from public.credit_facility_utilization cfu
           left join public.fx_latest_rates l
             on l.base_currency = cfu.currency and l.quote_currency = 'TRY'
           where cfu.status = 'active'
         ) fac`,
      ),
    ]);

    const { facts, working, controls, alerts } = core;
    const extra = extraRes.rows[0];
    const drawn = moneyOrNull(extra?.drawn) ?? 0;
    const effectiveCash = facts.consolidatedCashTry ?? facts.availableCash;

    return {
      briefingFacts: facts,
      widgetFacts: {
        availableCash: effectiveCash,
        minCashFloor: facts.minCashFloor,
        liquidityGap7: facts.consolidatedGap7Try ?? facts.liquidityGap7,
        liquidityGap30: facts.consolidatedGap30Try ?? facts.liquidityGap30,
        receivablesOpen: working?.receivablesOpen ?? null,
        payablesOpen: working?.payablesOpen ?? null,
        dsoDays: working?.dsoDays ?? null,
        dpoDays: working?.dpoDays ?? null,
        netDebt:
          effectiveCash == null
            ? null
            : money(decimal(drawn).minus(decimal(effectiveCash))),
        facilityAvailable: moneyOrNull(extra?.available),
        debtDue30: moneyOrNull(extra?.due30),
        fxWorstCase20: moneyOrNull(extra?.worst),
        budgetVarianceOverCount: Number(extra?.over_budget_n ?? 0),
        cycleExcludingInventory: working?.cycleExcludingInventory ?? null,
        criticalControlCount: controls.filter((c) => c.state === "CRITICAL").length,
        openAlertCount: alerts.filter((a) => a.status === "open").length,
        topConcentrationRatio: extra?.top_late == null ? null : Number(extra.top_late),
      },
    };
  });
}

export async function loadWidgetFacts(pool: Pool, todayISO: string): Promise<CockpitWidgetFacts> {
  return (await gatherWidgetFacts(pool, todayISO)).widgetFacts;
}

/** One request-level gather for the briefing screen; shared facts are never loaded twice. */
export async function loadBriefingDashboard(pool: Pool, todayISO: string) {
  const { briefingFacts: facts, widgetFacts } = await gatherWidgetFacts(pool, todayISO);
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
  const reportId = randomUUID();
  const [rawFacts, baseBoardPack] = await Promise.all([
    loadBriefingFacts(pool, todayISO),
    loadBoardFinancialPackage(pool, todayISO),
  ]);
  const bodyMd = renderBriefing(rawFacts);
  const asOfAt = new Date().toISOString();
  const contentSha256 = computeContentSha256(
    `${bodyMd}\n---\n${JSON.stringify({
      todayISO,
      availableCash: rawFacts.availableCash,
      consolidatedCashTry: rawFacts.consolidatedCashTry ?? null,
      liquidityGap7: rawFacts.liquidityGap7,
      overdueCount: rawFacts.overdueCount,
      criticalControls: rawFacts.criticalControls,
    })}`,
  );
  const loadedProv = await loadReportProvenance(pool, todayISO, {
    snapshotId: reportId,
    asOfAt,
    contentForHash: bodyMd,
  });
  const provenance: ReportProvenance = {
    ...loadedProv,
    snapshotId: reportId,
    contentSha256,
  };
  const facts: BriefingFacts = {
    ...rawFacts,
    provenance,
  };
  const frozenSnapshot = {
    ...baseBoardPack,
    provenance,
    reportScope: "cfo_briefing",
    briefingFacts: facts,
  };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.reports (id, report_type, period_start, period_end, body_md, meta)
       values ($1, 'cfo_briefing', $2::date, $2::date, $3, $4::jsonb)
       returning id`,
      [reportId, todayISO, bodyMd, JSON.stringify({
        availableCash: facts.availableCash,
        consolidatedCashTry: facts.consolidatedCashTry ?? null,
        liquidityGap7: facts.liquidityGap7,
        consolidatedGap7Try: facts.consolidatedGap7Try ?? null,
        fxRatesAsOf: facts.fxRatesAsOf ?? null,
        overdueCount: facts.overdueCount,
        criticalControls: facts.criticalControls.length,
        provenance,
        snapshot: frozenSnapshot,
      })]);
    if (res.rowCount !== 1) {
      throw new Error("CFO brifing raporu oluşturulamadı");
    }
    const id = res.rows[0].id;

    await audit(client, {
      actor: actorId, action: "generate_cfo_briefing",
      entityTable: "reports", entityId: id,
      after: {
        todayISO, overdueCount: facts.overdueCount,
        criticalControls: facts.criticalControls.length,
        consolidatedCashTry: facts.consolidatedCashTry ?? null,
        provenance,
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
  options?: { masked?: boolean; facts?: BriefingFacts },
): Promise<{ ok: boolean; error?: string }> {
  const isTelegramCfoBriefing =
    transport.channel === "telegram" &&
    (options !== undefined ||
      bodyMd.startsWith("# CFO Sabah Brifingi") ||
      bodyMd.includes("\n## "));
  const masked =
    options?.masked !== undefined ? options.masked : transport.channel === "telegram";
  const outboundText = isTelegramCfoBriefing
    ? renderBriefingTelegramText(options?.facts ?? bodyMd, { masked })
    : options?.masked && options.facts
      ? renderBriefing(options.facts, { masked: true })
      : bodyMd;

  const result = await transport.send(outboundText);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await audit(client, {
      actor: actorId, action: "dispatch_cfo_briefing",
      entityTable: "reports", entityId: reportId,
      after: {
        channel: transport.channel,
        masked: isTelegramCfoBriefing ? masked : Boolean(options?.masked),
        ok: result.ok,
        error: result.error ?? null,
        automated: true,
      },
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
