// M-20 & M-21 — Live Hybrid Cashflow Engine (TMS 7 Direct Method + Forward Forecast + Excel Hybrid).
//
// Ensures `/cashflow`, `/cashflow/monthly`, and `/cashflow/[monthId]` never sit empty waiting for
// `TEMİZ.xlsx`: computes live monthly & daily actuals from `public.bank_transactions` classified by
// TMS 7 Direct Method (Operating / Investing / Financing) + forward open flows from
// `public.liquidity_forecast_daily`, seamlessly merged with `public.cashflow_months` when present.

import type { Pool, PoolClient } from "pg";
import type { ChartModel } from "@/lib/analytics/chart";
import { decimal, moneyOrNull, round2 } from "@/lib/money";
import { addMonths, daysInMonth, type CashMonth } from "@/lib/radar/rules";
import { loadCashMonths } from "./engine";

export type Tms7ActivityKind = "operating" | "investing" | "financing";

export interface Tms7Summary {
  operatingInflow: number;
  operatingOutflow: number;
  operatingNet: number;
  investingInflow: number;
  investingOutflow: number;
  investingNet: number;
  financingInflow: number;
  financingOutflow: number;
  financingNet: number;
}

export interface HybridCashMonth extends CashMonth {
  id: string;
  ym: string;
  status: string;
  sourceKind: "live" | "hybrid" | "imported";
  sourceLabel: string;
  sheetId: string | null;
  workbookId: string | null;
  actualInflow: number;
  actualOutflow: number;
  forecastInflow: number;
  forecastOutflow: number;
  tms7: Tms7Summary;
}

export interface HybridLiveLine {
  id: string;
  date: string;
  label: string;
  counterparty: string | null;
  amountSigned: number;
  currency: string;
  tms7: Tms7ActivityKind;
  origin: "bank_actual" | "forecast_open";
  sourceDetail: string;
}

export interface ImportedCashLine {
  id: string;
  line_type: string;
  direction: string;
  label: string;
  amount: number | null;
  amount_status: string;
  party: string | null;
  row_index: number | null;
}

export interface HybridMonthDetail {
  id: string;
  ym: string;
  monthStart: string;
  cashflowMonthId: string | null;
  accountingPeriodId: string | null;
  opening: number | null;
  income: number | null;
  expense: number | null;
  delta: number | null;
  closing: number | null;
  status: string;
  confidence: string;
  sourceLabel: string;
  hasUnknownOpeningBalances: boolean;
  source_workbook_id: string | null;
  source_sheet_id: string | null;
  sheet_name: string | null;
  tms7: Tms7Summary;
  dailyChartModel: ChartModel;
  liveLines: HybridLiveLine[];
  importedLines: ImportedCashLine[];
}

function emptyTms7Acc() {
  return {
    opIn: decimal(0),
    opOut: decimal(0),
    invIn: decimal(0),
    invOut: decimal(0),
    finIn: decimal(0),
    finOut: decimal(0),
  };
}

function finalizeTms7(acc: ReturnType<typeof emptyTms7Acc>): Tms7Summary {
  return {
    operatingInflow: round2(acc.opIn),
    operatingOutflow: round2(acc.opOut),
    operatingNet: round2(acc.opIn.minus(acc.opOut)),
    investingInflow: round2(acc.invIn),
    investingOutflow: round2(acc.invOut),
    investingNet: round2(acc.invIn.minus(acc.invOut)),
    financingInflow: round2(acc.finIn),
    financingOutflow: round2(acc.finOut),
    financingNet: round2(acc.finIn.minus(acc.finOut)),
  };
}

export function classifyTms7BankTx(row: {
  transaction_kind: string | null;
  matched_entity_table: string | null;
  description: string | null;
  counterparty_name: string | null;
}): Tms7ActivityKind {
  const kind = (row.transaction_kind ?? "standard").toLowerCase();
  const matched = (row.matched_entity_table ?? "").toLowerCase();
  const text = `${row.description ?? ""} ${row.counterparty_name ?? ""}`.toLowerCase();

  if (
    matched === "loan_installments" ||
    matched === "loans" ||
    /\b(kredi|rotatif|spot kredi|sermaye|ortak cari|temettü|temettu|leasing|anapara)\b/i.test(text)
  ) {
    return "financing";
  }

  if (
    /\b(capex|demirbaş|demirbas|sabit kıymet|sabit kiymet|makine|teçhizat|techizat|taşıt alım|tasit alim|yazılım yatırım)\b/i.test(
      text,
    )
  ) {
    return "investing";
  }

  if (kind === "payroll" || kind === "tax_payment" || kind === "bank_fee") {
    return "operating";
  }

  return "operating";
}

export function classifyTms7ForecastSource(sourceKind: string, label?: string | null): Tms7ActivityKind {
  if (sourceKind === "loan_installment") return "financing";
  const text = (label ?? "").toLowerCase();
  if (/\b(capex|demirbaş|demirbas|sabit kıymet|makine)\b/i.test(text)) return "investing";
  if (/\b(kredi|leasing|sermaye)\b/i.test(text)) return "financing";
  return "operating";
}

function isMissingSchema(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  return code === "42P01" || code === "42703";
}

export async function loadHybridCashMonths(
  pool: Pool | PoolClient,
  todayISO: string,
): Promise<{
  months: HybridCashMonth[];
  sourceMode: "live" | "hybrid" | "imported";
  tms7Total: Tms7Summary;
  hasUnknownOpeningBalances: boolean;
  knownOpeningCount: number;
  unknownOpeningCount: number;
}> {
  const anchorMonth = `${todayISO.slice(0, 7)}-01`;
  const defaultStartMonth = addMonths(anchorMonth, -6);
  const defaultEndMonth = addMonths(anchorMonth, 12);
  const horizonExclusive = addMonths(defaultEndMonth, 1);

  const [importedMonths, openingRes, bankRes, forecastRes, apRes] = await Promise.all([
    loadCashMonths(pool),
    pool
      .query<{ total_opening: string | null; known_count: number; unknown_count: number }>(
        `select sum(opening_balance) filter (where opening_balance is not null)::text as total_opening,
                count(*) filter (where opening_balance is not null)::int as known_count,
                count(*) filter (where opening_balance is null)::int as unknown_count
           from public.cash_accounts
          where is_active = true
            and archived_at is null
            and coalesce(currency, 'TRY') = 'TRY'`,
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) {
          return { rows: [{ total_opening: null, known_count: 0, unknown_count: 0 }] };
        }
        throw err;
      }),
    pool
      .query<{
        ym: string;
        txn_date: string;
        amount: string;
        transaction_kind: string | null;
        matched_entity_table: string | null;
        description: string | null;
        counterparty_name: string | null;
      }>(
        `select to_char(date_trunc('month', txn_date), 'YYYY-MM-DD') as ym,
                to_char(txn_date, 'YYYY-MM-DD') as txn_date,
                amount::text as amount,
                to_jsonb(bt)->>'transaction_kind' as transaction_kind,
                matched_entity_table,
                description,
                bt.counterparty_name_raw as counterparty_name
           from public.bank_transactions bt
          where status <> 'ignored'
            and coalesce(currency, 'TRY') = 'TRY'
          order by txn_date asc`,
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        ym: string;
        source_kind: string;
        amount_signed: string;
      }>(
        `select to_char(date_trunc('month', flow_date), 'YYYY-MM-DD') as ym,
                source_kind,
                amount_signed::text as amount_signed
           from public.liquidity_forecast_daily
          where currency = 'TRY'
            and flow_date >= $1::date
            and flow_date < $2::date`,
        [todayISO, horizonExclusive],
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{ id: string; month_start: string; status: string }>(
        `select id::text as id,
                to_char(period_month, 'YYYY-MM-DD') as month_start,
                status
           from public.accounting_periods`,
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) return { rows: [] };
        throw err;
      }),
  ]);

  const importedByMonth = new Map(importedMonths.map((m) => [m.monthStart, m]));
  const apByMonth = new Map(apRes.rows.map((a) => [a.month_start, a]));

  interface MonthBucket {
    actualIn: ReturnType<typeof decimal>;
    actualOut: ReturnType<typeof decimal>;
    forecastIn: ReturnType<typeof decimal>;
    forecastOut: ReturnType<typeof decimal>;
    netTransferDelta: ReturnType<typeof decimal>;
    tms7: ReturnType<typeof emptyTms7Acc>;
  }

  const bucketOf = new Map<string, MonthBucket>();
  const ensureBucket = (monthStart: string): MonthBucket => {
    let b = bucketOf.get(monthStart);
    if (!b) {
      b = {
        actualIn: decimal(0),
        actualOut: decimal(0),
        forecastIn: decimal(0),
        forecastOut: decimal(0),
        netTransferDelta: decimal(0),
        tms7: emptyTms7Acc(),
      };
      bucketOf.set(monthStart, b);
    }
    return b;
  };

  let priorNetBeforeWindow = decimal(0);
  const earliestImported = importedMonths[0]?.monthStart ?? defaultStartMonth;
  const startMonth = earliestImported < defaultStartMonth ? earliestImported : defaultStartMonth;
  const latestImported = importedMonths[importedMonths.length - 1]?.monthStart ?? defaultEndMonth;
  const endMonth = latestImported > defaultEndMonth ? latestImported : defaultEndMonth;

  for (const row of bankRes.rows) {
    const amt = decimal(row.amount || "0");
    if (row.ym < startMonth) {
      priorNetBeforeWindow = priorNetBeforeWindow.plus(amt);
      continue;
    }
    if (row.ym > endMonth) continue;
    const b = ensureBucket(row.ym);
    if ((row.transaction_kind ?? "standard") === "own_transfer") {
      b.netTransferDelta = b.netTransferDelta.plus(amt);
      continue;
    }
    const cls = classifyTms7BankTx(row);
    if (amt.gte(0)) {
      b.actualIn = b.actualIn.plus(amt);
      if (cls === "investing") b.tms7.invIn = b.tms7.invIn.plus(amt);
      else if (cls === "financing") b.tms7.finIn = b.tms7.finIn.plus(amt);
      else b.tms7.opIn = b.tms7.opIn.plus(amt);
    } else {
      const absAmt = amt.abs();
      b.actualOut = b.actualOut.plus(absAmt);
      if (cls === "investing") b.tms7.invOut = b.tms7.invOut.plus(absAmt);
      else if (cls === "financing") b.tms7.finOut = b.tms7.finOut.plus(absAmt);
      else b.tms7.opOut = b.tms7.opOut.plus(absAmt);
    }
  }

  for (const fRow of forecastRes.rows) {
    if (fRow.ym < startMonth || fRow.ym > endMonth) continue;
    const amt = decimal(fRow.amount_signed || "0");
    const b = ensureBucket(fRow.ym);
    const cls = classifyTms7ForecastSource(fRow.source_kind);
    if (amt.gte(0)) {
      b.forecastIn = b.forecastIn.plus(amt);
      if (cls === "investing") b.tms7.invIn = b.tms7.invIn.plus(amt);
      else if (cls === "financing") b.tms7.finIn = b.tms7.finIn.plus(amt);
      else b.tms7.opIn = b.tms7.opIn.plus(amt);
    } else {
      const absAmt = amt.abs();
      b.forecastOut = b.forecastOut.plus(absAmt);
      if (cls === "investing") b.tms7.invOut = b.tms7.invOut.plus(absAmt);
      else if (cls === "financing") b.tms7.finOut = b.tms7.finOut.plus(absAmt);
      else b.tms7.opOut = b.tms7.opOut.plus(absAmt);
    }
  }

  const knownOpeningCount = Number(openingRes.rows[0]?.known_count ?? 0);
  const unknownOpeningCount = Number(openingRes.rows[0]?.unknown_count ?? 0);
  const hasUnknownOpeningBalances = unknownOpeningCount > 0;
  const baseOpening: ReturnType<typeof decimal> | null =
    !hasUnknownOpeningBalances && knownOpeningCount > 0 && openingRes.rows[0]?.total_opening != null
      ? decimal(openingRes.rows[0].total_opening).plus(priorNetBeforeWindow)
      : null;
  const hasAnyLive =
    knownOpeningCount > 0 ||
    bankRes.rows.length > 0 ||
    forecastRes.rows.length > 0;

  //FIN-03: When unknown_count > 0 (or no verified cash accounts exist), runningOpening stays null (NEVER coerced to 0).
  const months: HybridCashMonth[] = [];
  const totalTms7 = emptyTms7Acc();
  let runningOpening: ReturnType<typeof decimal> | null = baseOpening;

  for (let cur = startMonth, guard = 0; cur <= endMonth && guard < 60; cur = addMonths(cur, 1), guard++) {
    const imp = importedByMonth.get(cur);
    const ap = apByMonth.get(cur);
    const b = bucketOf.get(cur);
    const liveIn = (b ? b.actualIn.plus(b.forecastIn) : decimal(0));
    const liveOut = (b ? b.actualOut.plus(b.forecastOut) : decimal(0));
    const liveTransfer = b ? b.netTransferDelta : decimal(0);
    const hasLiveMovement =
      !liveIn.eq(0) || !liveOut.eq(0) || !liveTransfer.eq(0);

    const ym = cur.slice(0, 7);
    const effectiveStatus =
      ap?.status === "locked" || imp?.status === "locked"
        ? "locked"
        : ap?.status ?? imp?.status ?? "open";
    const id = imp?.id ?? ap?.id ?? ym;

    if (imp && !hasLiveMovement) {
      const impIn = imp.income != null ? decimal(imp.income) : decimal(0);
      const impOut = imp.expense != null ? decimal(imp.expense) : decimal(0);
      const tms = emptyTms7Acc();
      tms.opIn = impIn;
      tms.opOut = impOut;
      totalTms7.opIn = totalTms7.opIn.plus(impIn);
      totalTms7.opOut = totalTms7.opOut.plus(impOut);
      if (!hasUnknownOpeningBalances) {
        if (imp.closing != null) {
          runningOpening = decimal(imp.closing);
        } else if (imp.opening != null) {
          runningOpening = decimal(imp.opening).plus(impIn).minus(impOut);
        }
      }
      months.push({
        id,
        ym,
        monthStart: cur,
        opening: imp.opening,
        income: imp.income,
        expense: imp.expense,
        closing: imp.closing,
        status: effectiveStatus,
        sourceKind: "imported",
        sourceLabel: "Forecast (Excel Tahmini)",
        sheetId: imp.sheetId,
        workbookId: imp.workbookId,
        actualInflow: 0,
        actualOutflow: 0,
        forecastInflow: imp.income ?? 0,
        forecastOutflow: imp.expense ?? 0,
        tms7: finalizeTms7(tms),
      });
      continue;
    }

    const openingVal = runningOpening !== null ? round2(runningOpening) : null;
    const incomeVal = round2(liveIn);
    const expenseVal = round2(liveOut);
    const nextClosingDec =
      runningOpening !== null
        ? runningOpening.plus(liveIn).minus(liveOut).plus(liveTransfer)
        : null;
    const closingVal = nextClosingDec !== null ? round2(nextClosingDec) : null;
    runningOpening = nextClosingDec;

    const tms = b ? b.tms7 : emptyTms7Acc();
    totalTms7.opIn = totalTms7.opIn.plus(tms.opIn);
    totalTms7.opOut = totalTms7.opOut.plus(tms.opOut);
    totalTms7.invIn = totalTms7.invIn.plus(tms.invIn);
    totalTms7.invOut = totalTms7.invOut.plus(tms.invOut);
    totalTms7.finIn = totalTms7.finIn.plus(tms.finIn);
    totalTms7.finOut = totalTms7.finOut.plus(tms.finOut);

    months.push({
      id,
      ym,
      monthStart: cur,
      opening: openingVal,
      income: incomeVal,
      expense: expenseVal,
      closing: closingVal,
      status: effectiveStatus,
      sourceKind: imp ? "hybrid" : "live",
      sourceLabel: imp
        ? "Hibrit (Fiili Banka + Forecast (Excel Tahmini))"
        : "Canlı Banka (Actual) + Açık Vadeler (Planned)",
      sheetId: imp?.sheetId ?? null,
      workbookId: imp?.workbookId ?? null,
      actualInflow: b ? round2(b.actualIn) : 0,
      actualOutflow: b ? round2(b.actualOut) : 0,
      forecastInflow: b ? round2(b.forecastIn) : 0,
      forecastOutflow: b ? round2(b.forecastOut) : 0,
      tms7: finalizeTms7(tms),
    });
  }

  const sourceMode: "live" | "hybrid" | "imported" =
    importedMonths.length > 0 && hasAnyLive
      ? "hybrid"
      : importedMonths.length > 0
        ? "imported"
        : "live";

  return {
    months,
    sourceMode,
    tms7Total: finalizeTms7(totalTms7),
    hasUnknownOpeningBalances,
    knownOpeningCount,
    unknownOpeningCount,
  };
}

export async function loadHybridMonthDetail(
  pool: Pool | PoolClient,
  monthIdOrYm: string,
  todayISO: string,
): Promise<HybridMonthDetail | null> {
  const trimmed = monthIdOrYm.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
  const isYm = /^\d{4}-\d{2}$/.test(trimmed);
  const isYmd = /^\d{4}-\d{2}-01$/.test(trimmed);

  const cmRes = await pool.query<{
    id: string;
    ym: string;
    month_start: string;
    opening: string | null;
    income: string | null;
    expense: string | null;
    delta: string | null;
    closing: string | null;
    status: string;
    confidence: string;
    source_workbook_id: string | null;
    source_sheet_id: string | null;
    sheet_name: string | null;
  }>(
    `select cm.id::text as id,
            to_char(cm.month_start, 'YYYY-MM') as ym,
            to_char(cm.month_start, 'YYYY-MM-DD') as month_start,
            cm.opening_balance::text as opening,
            cm.projected_income::text as income,
            cm.projected_expense::text as expense,
            cm.monthly_delta::text as delta,
            cm.closing_balance::text as closing,
            cm.status,
            cm.confidence,
            cm.source_workbook_id::text as source_workbook_id,
            cm.source_sheet_id::text as source_sheet_id,
            ss.sheet_name
       from public.cashflow_months cm
       left join public.source_sheets ss on ss.id = cm.source_sheet_id
      where cm.id::text = $1
         or to_char(cm.month_start, 'YYYY-MM') = $1
         or to_char(cm.month_start, 'YYYY-MM-DD') = $1
      limit 1`,
    [trimmed],
  );

  let apRow: { id: string; ym: string; month_start: string; status: string } | null = null;
  try {
    const apRes = await pool.query<{ id: string; ym: string; month_start: string; status: string }>(
      `select id::text as id,
              to_char(period_month, 'YYYY-MM') as ym,
              to_char(period_month, 'YYYY-MM-DD') as month_start,
              status
         from public.accounting_periods
        where id::text = $1
           or to_char(period_month, 'YYYY-MM') = $1
           or to_char(period_month, 'YYYY-MM-DD') = $1
        limit 1`,
      [trimmed],
    );
    apRow = apRes.rows[0] ?? null;
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
  }

  const cmRow = cmRes.rows[0] ?? null;
  let ym: string | null = cmRow?.ym ?? apRow?.ym ?? null;
  if (!ym) {
    if (isYm) ym = trimmed;
    else if (isYmd) ym = trimmed.slice(0, 7);
    else if (isUuid) return null;
    else return null;
  }

  const [yr, mo] = ym.split("-").map(Number);
  if (!yr || !mo || mo < 1 || mo > 12) return null;
  const monthStart = `${ym}-01`;
  const nextMonthStart = addMonths(monthStart, 1);
  const dim = daysInMonth(yr, mo);

  const [hybridAll, bankLinesRes, forecastLinesRes, importedLinesRes] = await Promise.all([
    loadHybridCashMonths(pool, todayISO),
    pool
      .query<{
        id: string;
        txn_date: string;
        amount: string;
        currency: string;
        transaction_kind: string | null;
        matched_entity_table: string | null;
        description: string | null;
        counterparty_name: string | null;
      }>(
        `select bt.id::text as id,
                to_char(bt.txn_date, 'YYYY-MM-DD') as txn_date,
                bt.amount::text as amount,
                coalesce(bt.currency, 'TRY') as currency,
                to_jsonb(bt)->>'transaction_kind' as transaction_kind,
                bt.matched_entity_table,
                bt.description,
                bt.counterparty_name_raw as counterparty_name
           from public.bank_transactions bt
          where bt.txn_date >= $1::date
            and bt.txn_date < $2::date
            and bt.status <> 'ignored'
          order by bt.txn_date asc, bt.created_at asc`,
        [monthStart, nextMonthStart],
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) return { rows: [] };
        throw err;
      }),
    pool
      .query<{
        source_kind: string;
        source_id: string;
        event_date: string;
        label: string;
        counterparty_name: string | null;
        amount_signed: string;
        currency: string;
      }>(
        `select source_kind,
                source_id::text as source_id,
                to_char(event_date, 'YYYY-MM-DD') as event_date,
                label,
                counterparty_name,
                amount_signed::text as amount_signed,
                coalesce(currency, 'TRY') as currency
           from public.financial_calendar
          where event_date >= greatest($1::date, $3::date)
            and event_date < $2::date
          order by event_date asc`,
        [monthStart, nextMonthStart, todayISO],
      )
      .catch((err: unknown) => {
        if (isMissingSchema(err)) return { rows: [] };
        throw err;
      }),
    cmRow
      ? pool.query<{
          id: string;
          line_type: string;
          direction: string;
          label: string;
          amount: string | null;
          amount_status: string;
          party: string | null;
          row_index: number | null;
        }>(
          `select cl.id::text as id,
                  cl.line_type,
                  cl.direction,
                  cl.label,
                  cl.amount::text as amount,
                  cl.amount_status,
                  p.name as party,
                  ir.row_index
             from public.cashflow_lines cl
             left join public.parties p on p.id = cl.party_id
             left join public.import_rows ir on ir.id = cl.source_row_id
            where cl.cashflow_month_id = $1::uuid
            order by cl.line_type, ir.row_index nulls last`,
          [cmRow.id],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const summaryMonth = hybridAll.months.find((x) => x.monthStart === monthStart);

  const tms7Acc = emptyTms7Acc();
  const dailyIn = new Map<string, ReturnType<typeof decimal>>();
  const dailyOut = new Map<string, ReturnType<typeof decimal>>();
  const liveLines: HybridLiveLine[] = [];

  for (const bt of bankLinesRes.rows) {
    if ((bt.transaction_kind ?? "standard") === "own_transfer") continue;
    const amt = decimal(bt.amount || "0");
    const cls = classifyTms7BankTx(bt);
    liveLines.push({
      id: `bt:${bt.id}`,
      date: bt.txn_date,
      label: bt.description || "Banka hareketi",
      counterparty: bt.counterparty_name,
      amountSigned: round2(amt),
      currency: bt.currency,
      tms7: cls,
      origin: "bank_actual",
      sourceDetail: bt.transaction_kind ?? "banka",
    });
    if (bt.currency === "TRY") {
      if (amt.gte(0)) {
        dailyIn.set(bt.txn_date, (dailyIn.get(bt.txn_date) ?? decimal(0)).plus(amt));
        if (cls === "investing") tms7Acc.invIn = tms7Acc.invIn.plus(amt);
        else if (cls === "financing") tms7Acc.finIn = tms7Acc.finIn.plus(amt);
        else tms7Acc.opIn = tms7Acc.opIn.plus(amt);
      } else {
        const absAmt = amt.abs();
        dailyOut.set(bt.txn_date, (dailyOut.get(bt.txn_date) ?? decimal(0)).plus(absAmt));
        if (cls === "investing") tms7Acc.invOut = tms7Acc.invOut.plus(absAmt);
        else if (cls === "financing") tms7Acc.finOut = tms7Acc.finOut.plus(absAmt);
        else tms7Acc.opOut = tms7Acc.opOut.plus(absAmt);
      }
    }
  }

  for (const fc of forecastLinesRes.rows) {
    const amt = decimal(fc.amount_signed || "0");
    const cls = classifyTms7ForecastSource(fc.source_kind, fc.label);
    liveLines.push({
      id: `fc:${fc.source_kind}:${fc.source_id}`,
      date: fc.event_date,
      label: fc.label,
      counterparty: fc.counterparty_name,
      amountSigned: round2(amt),
      currency: fc.currency,
      tms7: cls,
      origin: "forecast_open",
      sourceDetail: fc.source_kind,
    });
    if (fc.currency === "TRY") {
      if (amt.gte(0)) {
        dailyIn.set(fc.event_date, (dailyIn.get(fc.event_date) ?? decimal(0)).plus(amt));
        if (cls === "investing") tms7Acc.invIn = tms7Acc.invIn.plus(amt);
        else if (cls === "financing") tms7Acc.finIn = tms7Acc.finIn.plus(amt);
        else tms7Acc.opIn = tms7Acc.opIn.plus(amt);
      } else {
        const absAmt = amt.abs();
        dailyOut.set(fc.event_date, (dailyOut.get(fc.event_date) ?? decimal(0)).plus(absAmt));
        if (cls === "investing") tms7Acc.invOut = tms7Acc.invOut.plus(absAmt);
        else if (cls === "financing") tms7Acc.finOut = tms7Acc.finOut.plus(absAmt);
        else tms7Acc.opOut = tms7Acc.opOut.plus(absAmt);
      }
    }
  }

  const allDays: string[] = [];
  for (let d = 1; d <= dim; d++) {
    allDays.push(`${ym}-${String(d).padStart(2, "0")}`);
  }

  const dailyChartModel: ChartModel = {
    title: `${ym} Günlük Nakit Akışı (Fiili + Açık Vadeler)`,
    description: "Banka fiili tahsilat/ödemeleri ve açık ileri vadeli nakit hareketleri (TRY).",
    asOf: todayISO,
    timeDirection: "both",
    preferredView: "grouped",
    summaryMode: "sum",
    availableGranularities: ["day", "week"],
    sourceLabel: "Banka & Finansal Takvim",
    sourceHref: `/payments/calendar?ym=${ym}`,
    series: [
      {
        id: "inflow",
        label: "Nakit Girişi",
        tone: "positive",
        format: "currency",
        points: allDays.map((day) => ({
          key: day,
          label: day.slice(8),
          value: round2(dailyIn.get(day) ?? decimal(0)),
        })),
      },
      {
        id: "outflow",
        label: "Nakit Çıkışı",
        tone: "negative",
        format: "currency",
        points: allDays.map((day) => ({
          key: day,
          label: day.slice(8),
          value: round2(dailyOut.get(day) ?? decimal(0)),
        })),
      },
    ],
  };

  const opening = cmRow
    ? moneyOrNull(cmRow.opening) ?? summaryMonth?.opening ?? null
    : summaryMonth?.opening ?? null;
  const income =
    cmRow && liveLines.length === 0
      ? moneyOrNull(cmRow.income)
      : summaryMonth?.income ?? round2(tms7Acc.opIn.plus(tms7Acc.invIn).plus(tms7Acc.finIn));
  const expense =
    cmRow && liveLines.length === 0
      ? moneyOrNull(cmRow.expense)
      : summaryMonth?.expense ?? round2(tms7Acc.opOut.plus(tms7Acc.invOut).plus(tms7Acc.finOut));
  const delta =
    income != null && expense != null
      ? round2(decimal(income).minus(expense))
      : cmRow
        ? moneyOrNull(cmRow.delta)
        : null;
  const closing =
    cmRow && liveLines.length === 0
      ? moneyOrNull(cmRow.closing)
      : summaryMonth?.closing ??
        (opening != null && delta != null ? round2(decimal(opening).plus(delta)) : null);

  const effectiveStatus =
    apRow?.status === "locked" || cmRow?.status === "locked"
      ? "locked"
      : apRow?.status ?? cmRow?.status ?? "open";

  const sourceLabel = cmRow
    ? liveLines.length > 0
      ? "Hibrit (Fiili Banka + Forecast (Excel Tahmini))"
      : "Forecast (Excel Tahmini)"
    : "Canlı Banka (Actual) + Açık Vadeler (Planned)";

  return {
    id: cmRow?.id ?? apRow?.id ?? ym,
    ym,
    monthStart,
    cashflowMonthId: cmRow?.id ?? null,
    accountingPeriodId: apRow?.id ?? null,
    opening,
    income,
    expense,
    delta,
    closing,
    status: effectiveStatus,
    confidence: cmRow
      ? liveLines.length > 0
        ? "hybrid_live · Forecast (Excel Tahmini)"
        : `${cmRow.confidence} · Forecast (Excel Tahmini)`
      : "live_tms7",
    sourceLabel,
    hasUnknownOpeningBalances: hybridAll.hasUnknownOpeningBalances,
    source_workbook_id: cmRow?.source_workbook_id ?? null,
    source_sheet_id: cmRow?.source_sheet_id ?? null,
    sheet_name: cmRow?.sheet_name ?? null,
    tms7: summaryMonth?.tms7 ?? finalizeTms7(tms7Acc),
    dailyChartModel,
    liveLines,
    importedLines: importedLinesRes.rows.map((l) => ({
      ...l,
      amount: moneyOrNull(l.amount),
    })),
  };
}
