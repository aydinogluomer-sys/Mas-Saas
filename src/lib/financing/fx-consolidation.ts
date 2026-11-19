// Faz 58 (M-27) — Çoklu Döviz Konsolidasyonu (TCMB Son Kur ile Konsolide TRY Karşılığı, Asla 1:1 Toplanmaz)
// ve Karşı Taraf / Banka / Kredi Limit / Döviz Konsantrasyon & Açık Pozisyon Matrisi.

import type { Pool, PoolClient } from "pg";
import { isMissingSchemaError } from "@/lib/ledger/accounts";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";

export interface LatestFxRateInfo {
  currency: string;
  rate: number;
  rateDate: string;
  source: string;
}

export interface CurrencyConsolidationSlice {
  currency: string;
  nativeAmount: number;
  itemCount: number;
  fxRate: number | null;
  rateDate: string | null;
  tryEquivalent: number | null;
}

export type CurrencyBreakdownItem = CurrencyConsolidationSlice;

export interface ConsolidatedMoneySummary {
  consolidatedTry: number;
  knownTryItemCount: number;
  missingFxCount: number;
  missingFxCurrencies: string[];
  byCurrency: CurrencyConsolidationSlice[];
}

export async function loadLatestTryFxRateMap(
  pool: Pick<Pool, "query"> | PoolClient,
  asOfISO?: string,
): Promise<Map<string, LatestFxRateInfo>> {
  const map = new Map<string, LatestFxRateInfo>();
  map.set("TRY", {
    currency: "TRY",
    rate: 1,
    rateDate: asOfISO ?? new Date().toISOString().slice(0, 10),
    source: "parity",
  });

  const res = await pool
    .query<{
      base_currency: string;
      rate: string;
      rate_date: string;
      source: string;
    }>(
      asOfISO
        ? `select distinct on (base_currency)
                  base_currency,
                  rate::text as rate,
                  to_char(rate_date, 'YYYY-MM-DD') as rate_date,
                  source
             from public.fx_rate_snapshots
            where quote_currency = 'TRY'
              and rate_date <= $1::date
            order by base_currency, rate_date desc, created_at desc`
        : `select distinct on (base_currency)
                  base_currency,
                  rate::text as rate,
                  to_char(rate_date, 'YYYY-MM-DD') as rate_date,
                  source
             from public.fx_rate_snapshots
            where quote_currency = 'TRY'
            order by base_currency, rate_date desc, created_at desc`,
      asOfISO ? [asOfISO] : [],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  for (const row of res.rows) {
    const curr = String(row.base_currency).trim().toUpperCase();
    const r = rateOrNull(row.rate);
    if (r != null && r > 0) {
      map.set(curr, {
        currency: curr,
        rate: r,
        rateDate: row.rate_date,
        source: row.source,
      });
    }
  }
  return map;
}

/**
 * Pure decimal multi-currency consolidator.
 * NEVER adds foreign currencies 1:1 into TRY; when a foreign currency has no TCMB snapshot,
 * its native total is preserved in `byCurrency` with `tryEquivalent: null` and flagged in `missingFxCurrencies`.
 */
export function consolidateCurrencyAmounts(
  items: ReadonlyArray<{ amount: number | string | null | undefined; currency?: string | null }>,
  rateMap: ReadonlyMap<string, LatestFxRateInfo>,
): ConsolidatedMoneySummary {
  const buckets = new Map<string, { sum: ReturnType<typeof decimal>; count: number }>();
  for (const item of items) {
    const parsedAmt = moneyOrNull(item.amount);
    if (parsedAmt == null) continue;
    const curr = (item.currency ?? "TRY").trim().toUpperCase() || "TRY";
    const cur = buckets.get(curr) ?? { sum: decimal(0), count: 0 };
    cur.sum = cur.sum.plus(parsedAmt);
    cur.count += 1;
    buckets.set(curr, cur);
  }

  let consolidatedTryDec = decimal(0);
  let knownTryItemCount = 0;
  let missingFxCount = 0;
  const missingFxCurrencies: string[] = [];
  const byCurrency: CurrencyConsolidationSlice[] = [];

  const sortedCurrencies = [...buckets.keys()].sort((a, b) => {
    if (a === "TRY") return -1;
    if (b === "TRY") return 1;
    return a.localeCompare(b);
  });

  for (const curr of sortedCurrencies) {
    const b = buckets.get(curr)!;
    const nativeAmount = Number(b.sum.round(2).toFixed(2));
    const fxInfo = curr === "TRY" ? { rate: 1, rateDate: null } : (rateMap.get(curr) ?? null);
    if (fxInfo && fxInfo.rate > 0) {
      const tryEqDec = b.sum.times(fxInfo.rate).round(2);
      consolidatedTryDec = consolidatedTryDec.plus(tryEqDec);
      knownTryItemCount += b.count;
      byCurrency.push({
        currency: curr,
        nativeAmount,
        itemCount: b.count,
        fxRate: fxInfo.rate,
        rateDate: fxInfo.rateDate,
        tryEquivalent: Number(tryEqDec.toFixed(2)),
      });
    } else {
      missingFxCount += b.count;
      missingFxCurrencies.push(curr);
      byCurrency.push({
        currency: curr,
        nativeAmount,
        itemCount: b.count,
        fxRate: null,
        rateDate: null,
        tryEquivalent: null,
      });
    }
  }

  return {
    consolidatedTry: Number(consolidatedTryDec.round(2).toFixed(2)),
    knownTryItemCount,
    missingFxCount,
    missingFxCurrencies,
    byCurrency,
  };
}

export function convertSingleAmountToTry(
  amount: number | null | undefined,
  currency: string | null | undefined,
  rateMap: ReadonlyMap<string, LatestFxRateInfo>,
): { tryEquivalent: number | null; fxRate: number | null } {
  if (amount == null || !Number.isFinite(amount)) return { tryEquivalent: null, fxRate: null };
  const curr = (currency ?? "TRY").trim().toUpperCase() || "TRY";
  if (curr === "TRY") {
    return { tryEquivalent: Number(decimal(amount).round(2).toFixed(2)), fxRate: 1 };
  }
  const info = rateMap.get(curr);
  if (!info || info.rate <= 0) {
    return { tryEquivalent: null, fxRate: null };
  }
  return {
    tryEquivalent: Number(decimal(amount).times(info.rate).round(2).toFixed(2)),
    fxRate: info.rate,
  };
}

/* ── Exposure Matrix Workspace (/finance/exposure) ─────────────────────────────────────────── */

export interface CounterpartyExposureRow {
  partyId: string;
  partyName: string;
  partyType: string;
  currency: string;
  receivableOpen: number;
  receivableOverdue: number;
  checksInflowOpen: number;
  payableOpen: number;
  checksOutflowOpen: number;
  creditLimit: number | null;
  limitUtilizationRatio: number | null;
  overCreditLimit: boolean;
  netExposureNative: number;
  netExposureTry: number | null;
  grossExposureTry: number | null;
  shareOfReceivablesPct: number | null;
}

export interface BankConcentrationRow {
  bankName: string;
  cashTryEquivalent: number;
  termDepositTryEquivalent: number;
  loanDebtTryEquivalent: number;
  facilityLimitTryEquivalent: number;
  facilityDrawnTryEquivalent: number;
  facilityHeadroomTryEquivalent: number;
  guaranteeLettersTryEquivalent: number;
  netPositionTry: number;
  missingFxCurrencies: string[];
}

export interface LiveFxMatrixRow {
  currency: string;
  cashBankFx: number;
  receivablesFx: number;
  checksInflowFx: number;
  payablesFx: number;
  checksOutflowFx: number;
  loansFx: number;
  facilitiesFx: number;
  derivativesHedgeFx: number;
  netFxPosition: number;
  latestTcmbRate: number | null;
  latestRateDate: string | null;
  netTryEquivalent: number | null;
  shock10PctPnlTry: number | null;
  shock20PctPnlTry: number | null;
}

export interface ExposureMatrixWorkspace {
  todayISO: string;
  rates: LatestFxRateInfo[];
  counterparties: CounterpartyExposureRow[];
  banks: BankConcentrationRow[];
  fxRows: LiveFxMatrixRow[];
  totals: {
    totalReceivablesTry: number;
    totalPayablesTry: number;
    totalBankCashTry: number;
    totalBankDebtTry: number;
    totalFacilityHeadroomTry: number;
    totalGuaranteesTry: number;
    netFxOpenTry: number;
    overLimitCounterpartyCount: number;
    topCounterpartyConcentrationPct: number | null;
  };
}

export async function loadExposureMatrixWorkspace(
  pool: Pool,
  todayISO: string,
): Promise<ExposureMatrixWorkspace> {
  const rateMap = await loadLatestTryFxRateMap(pool, todayISO);

  const [cpRes, fxRes, bankCashRes, termDepRes, loanRes, facRes, lgRes] = await Promise.all([
    pool
      .query<{
        party_id: string;
        party_name: string;
        party_type: string;
        currency: string;
        receivable_open: string;
        receivable_overdue: string;
        checks_inflow_open: string;
        payable_open: string;
        checks_outflow_open: string;
        credit_limit: string | null;
      }>(
        `select p.id::text as party_id,
                p.name as party_name,
                p.party_type,
                currencies.currency,
                coalesce(ar.open_amt, 0)::text as receivable_open,
                coalesce(ar.overdue_amt, 0)::text as receivable_overdue,
                coalesce(chk_in.amt, 0)::text as checks_inflow_open,
                coalesce(ap.open_amt, 0)::text as payable_open,
                coalesce(chk_out.amt, 0)::text as checks_outflow_open,
                case when currencies.currency = 'TRY' then cp.credit_limit::text else null end as credit_limit
           from public.parties p
           cross join lateral (
             select distinct curr as currency from (
               select i.currency as curr from public.invoices i where i.party_id = p.id and i.status in ('open', 'partial')
               union
               select c.currency as curr from public.checks c where (c.payer_party_id = p.id or c.payee_party_id = p.id) and c.archived_at is null and c.status in ('planned','in_portfolio','in_bank_collection','in_bank_collateral','issued_to_vendor')
             ) u where curr is not null
           ) currencies
           left join public.counterparty_profiles cp on cp.party_id = p.id
           left join lateral (
             select sum(greatest(coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)), 0)) as open_amt,
                    sum(case when i.due_date < $1::date then greatest(coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)), 0) else 0 end) as overdue_amt
               from public.invoices i
              where i.party_id = p.id and i.direction = 'sales' and i.status in ('open', 'partial') and i.currency = currencies.currency
           ) ar on true
           left join lateral (
             select sum(greatest(coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)), 0)) as open_amt
               from public.invoices i
              where i.party_id = p.id and i.direction = 'purchase' and i.status in ('open', 'partial') and i.currency = currencies.currency
           ) ap on true
           left join lateral (
             select sum(coalesce(c.amount, 0)) as amt
               from public.checks c
              where c.payer_party_id = p.id and c.direction = 'inflow' and c.archived_at is null
                and c.status in ('planned','in_portfolio','in_bank_collection','in_bank_collateral')
                and c.currency = currencies.currency
           ) chk_in on true
           left join lateral (
             select sum(coalesce(c.amount, 0)) as amt
               from public.checks c
              where c.payee_party_id = p.id and c.direction = 'outflow' and c.archived_at is null
                and c.status in ('planned','issued_to_vendor')
                and c.currency = currencies.currency
           ) chk_out on true
          where p.archived_at is null
            and (coalesce(ar.open_amt, 0) > 0 or coalesce(ap.open_amt, 0) > 0 or coalesce(chk_in.amt, 0) > 0 or coalesce(chk_out.amt, 0) > 0)
          order by p.name asc`,
        [todayISO],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        currency: string;
        total_assets_native: string;
        total_liabilities_native: string;
        net_position_native: string;
        cash_bank_native: string;
        receivables_native: string;
        payables_native: string;
        checks_payable_native: string;
        loan_debt_native: string;
        hedge_native: string;
        spot_rate_to_try: string | null;
        rate_date: string | null;
        net_position_try: string | null;
      }>(
        `select currency,
                total_assets_native::text,
                total_liabilities_native::text,
                net_position_native::text,
                cash_bank_native::text,
                receivables_native::text,
                payables_native::text,
                checks_payable_native::text,
                loan_debt_native::text,
                hedge_native::text,
                spot_rate_to_try::text,
                to_char(rate_date, 'YYYY-MM-DD') as rate_date,
                net_position_try::text
           from public.live_fx_exposure_v
          order by currency asc`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ bank_label: string; currency: string; bal: string }>(
        `select coalesce(nullif(btrim(bank_name), ''), account_name, 'Diğer Kasa/Banka') as bank_label,
                currency,
                coalesce(derived_balance, stated_balance, 0)::text as bal
           from public.bank_cash_position
          where is_active = true`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ bank_label: string; currency: string; principal: string }>(
        `select coalesce(nullif(btrim(ca.bank_name), ''), ca.name, 'Diğer Banka') as bank_label,
                td.currency,
                td.principal_amount::text as principal
           from public.term_deposits td
           join public.cash_accounts ca on ca.id = td.cash_account_id
          where td.is_active = true`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ bank_label: string; currency: string; rem: string }>(
        `select coalesce(p.name, l.name, 'Diğer Kredi') as bank_label,
                l.currency,
                coalesce(sum(li.amount) filter (where li.status <> 'paid' and li.status <> 'cancelled'), 0)::text as rem
           from public.loans l
           left join public.parties p on p.id = l.lender_party_id
           left join public.loan_installments li on li.loan_id = l.id
          where l.archived_at is null and l.status = 'active'
          group by coalesce(p.name, l.name, 'Diğer Kredi'), l.currency`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ bank_label: string; currency: string; lim: string; drawn: string }>(
        `select coalesce(p.name, cf.name, 'Diğer Limit') as bank_label,
                cf.currency,
                cf.limit_amount::text as lim,
                cf.drawn_amount::text as drawn
           from public.credit_facilities cf
           left join public.parties p on p.id = cf.lender_party_id
          where cf.status in ('active', 'suspended')`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ bank_label: string; currency: string; amt: string }>(
        `select coalesce(p.name, cf.name, lg.beneficiary_name, 'Teminat Bankası') as bank_label,
                lg.currency,
                lg.amount::text as amt
           from public.letter_of_guarantees lg
           left join public.credit_facilities cf on cf.id = lg.facility_id
           left join public.parties p on p.id = cf.lender_party_id
          where lg.is_active = true`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  let totalReceivablesTryDec = decimal(0);
  let totalPayablesTryDec = decimal(0);

  const rawCounterparties = cpRes.rows.map((r) => {
    const ar = money(r.receivable_open);
    const arOverdue = money(r.receivable_overdue);
    const chkIn = money(r.checks_inflow_open);
    const ap = money(r.payable_open);
    const chkOut = money(r.checks_outflow_open);
    const arRisk = decimal(ar).plus(chkIn);
    const apRisk = decimal(ap).plus(chkOut);
    const netNative = Number(arRisk.minus(apRisk).round(2).toFixed(2));
    const grossNative = Number(arRisk.plus(apRisk).round(2).toFixed(2));
    const creditLimit = moneyOrNull(r.credit_limit);

    const arTry = convertSingleAmountToTry(Number(arRisk.toFixed(2)), r.currency, rateMap).tryEquivalent;
    const apTry = convertSingleAmountToTry(Number(apRisk.toFixed(2)), r.currency, rateMap).tryEquivalent;
    const netTry = convertSingleAmountToTry(netNative, r.currency, rateMap).tryEquivalent;
    const grossTry = convertSingleAmountToTry(grossNative, r.currency, rateMap).tryEquivalent;

    if (arTry != null) totalReceivablesTryDec = totalReceivablesTryDec.plus(arTry);
    if (apTry != null) totalPayablesTryDec = totalPayablesTryDec.plus(apTry);

    const limitRatio =
      creditLimit != null && creditLimit > 0
        ? Number(arRisk.div(creditLimit).times(100).round(1).toFixed(1))
        : null;
    const overLimit = creditLimit != null && creditLimit > 0 && arRisk.gt(creditLimit);

    return {
      partyId: r.party_id,
      partyName: r.party_name,
      partyType: r.party_type,
      currency: r.currency,
      receivableOpen: ar,
      receivableOverdue: arOverdue,
      checksInflowOpen: chkIn,
      payableOpen: ap,
      checksOutflowOpen: chkOut,
      creditLimit,
      limitUtilizationRatio: limitRatio,
      overCreditLimit: overLimit,
      netExposureNative: netNative,
      netExposureTry: netTry,
      grossExposureTry: grossTry,
      arTryForShare: arTry ?? 0,
    };
  });

  const totalReceivablesTry = Number(totalReceivablesTryDec.round(2).toFixed(2));
  const totalPayablesTry = Number(totalPayablesTryDec.round(2).toFixed(2));

  const counterparties: CounterpartyExposureRow[] = rawCounterparties
    .map((c) => ({
      partyId: c.partyId,
      partyName: c.partyName,
      partyType: c.partyType,
      currency: c.currency,
      receivableOpen: c.receivableOpen,
      receivableOverdue: c.receivableOverdue,
      checksInflowOpen: c.checksInflowOpen,
      payableOpen: c.payableOpen,
      checksOutflowOpen: c.checksOutflowOpen,
      creditLimit: c.creditLimit,
      limitUtilizationRatio: c.limitUtilizationRatio,
      overCreditLimit: c.overCreditLimit,
      netExposureNative: c.netExposureNative,
      netExposureTry: c.netExposureTry,
      grossExposureTry: c.grossExposureTry,
      shareOfReceivablesPct:
        totalReceivablesTry > 0 && c.arTryForShare > 0
          ? Number(decimal(c.arTryForShare).div(totalReceivablesTry).times(100).round(1).toFixed(1))
          : null,
    }))
    .sort((a, b) => Math.abs(b.grossExposureTry ?? 0) - Math.abs(a.grossExposureTry ?? 0));

  const bankMap = new Map<
    string,
    {
      cash: ReturnType<typeof decimal>;
      td: ReturnType<typeof decimal>;
      loan: ReturnType<typeof decimal>;
      facLim: ReturnType<typeof decimal>;
      facDrawn: ReturnType<typeof decimal>;
      lg: ReturnType<typeof decimal>;
      missing: Set<string>;
    }
  >();

  const ensureBank = (rawName: string) => {
    const key = rawName.trim() || "Diğer Banka";
    let b = bankMap.get(key);
    if (!b) {
      b = {
        cash: decimal(0),
        td: decimal(0),
        loan: decimal(0),
        facLim: decimal(0),
        facDrawn: decimal(0),
        lg: decimal(0),
        missing: new Set<string>(),
      };
      bankMap.set(key, b);
    }
    return b;
  };

  for (const r of bankCashRes.rows) {
    const b = ensureBank(r.bank_label);
    const conv = convertSingleAmountToTry(money(r.bal), r.currency, rateMap);
    if (conv.tryEquivalent != null) b.cash = b.cash.plus(conv.tryEquivalent);
    else b.missing.add(r.currency);
  }
  for (const r of termDepRes.rows) {
    const b = ensureBank(r.bank_label);
    const conv = convertSingleAmountToTry(money(r.principal), r.currency, rateMap);
    if (conv.tryEquivalent != null) b.td = b.td.plus(conv.tryEquivalent);
    else b.missing.add(r.currency);
  }
  for (const r of loanRes.rows) {
    const b = ensureBank(r.bank_label);
    const conv = convertSingleAmountToTry(money(r.rem), r.currency, rateMap);
    if (conv.tryEquivalent != null) b.loan = b.loan.plus(conv.tryEquivalent);
    else b.missing.add(r.currency);
  }
  for (const r of facRes.rows) {
    const b = ensureBank(r.bank_label);
    const limConv = convertSingleAmountToTry(money(r.lim), r.currency, rateMap);
    const drwConv = convertSingleAmountToTry(money(r.drawn), r.currency, rateMap);
    if (limConv.tryEquivalent != null) b.facLim = b.facLim.plus(limConv.tryEquivalent);
    else b.missing.add(r.currency);
    if (drwConv.tryEquivalent != null) b.facDrawn = b.facDrawn.plus(drwConv.tryEquivalent);
  }
  for (const r of lgRes.rows) {
    const b = ensureBank(r.bank_label);
    const conv = convertSingleAmountToTry(money(r.amt), r.currency, rateMap);
    if (conv.tryEquivalent != null) b.lg = b.lg.plus(conv.tryEquivalent);
    else b.missing.add(r.currency);
  }

  const banks: BankConcentrationRow[] = [...bankMap.entries()]
    .map(([bankName, v]) => {
      const cashTry = Number(v.cash.round(2).toFixed(2));
      const tdTry = Number(v.td.round(2).toFixed(2));
      const loanTry = Number(v.loan.round(2).toFixed(2));
      const facLimTry = Number(v.facLim.round(2).toFixed(2));
      const facDrawnTry = Number(v.facDrawn.round(2).toFixed(2));
      const headroom = Math.max(0, Number(v.facLim.minus(v.facDrawn).round(2).toFixed(2)));
      const lgTry = Number(v.lg.round(2).toFixed(2));
      const netPos = Number(
        v.cash.plus(v.td).minus(v.loan).minus(v.facDrawn).round(2).toFixed(2),
      );
      return {
        bankName,
        cashTryEquivalent: cashTry,
        termDepositTryEquivalent: tdTry,
        loanDebtTryEquivalent: loanTry,
        facilityLimitTryEquivalent: facLimTry,
        facilityDrawnTryEquivalent: facDrawnTry,
        facilityHeadroomTryEquivalent: headroom,
        guaranteeLettersTryEquivalent: lgTry,
        netPositionTry: netPos,
        missingFxCurrencies: [...v.missing],
      };
    })
    .sort(
      (a, b) =>
        b.cashTryEquivalent +
        b.termDepositTryEquivalent +
        b.loanDebtTryEquivalent +
        b.facilityDrawnTryEquivalent -
        (a.cashTryEquivalent +
          a.termDepositTryEquivalent +
          a.loanDebtTryEquivalent +
          a.facilityDrawnTryEquivalent),
    );

  const fxRows: LiveFxMatrixRow[] = fxRes.rows.map((r) => {
    const totalAssets = money(r.total_assets_native);
    const cashBank = money(r.cash_bank_native);
    const receivables = money(r.receivables_native);
    const hedgeAmt = money(r.hedge_native);
    const checksInflowEst = Math.max(
      0,
      money(decimal(totalAssets).minus(cashBank).minus(receivables).minus(Math.max(0, hedgeAmt))),
    );
    const netTry = moneyOrNull(r.net_position_try);
    return {
      currency: r.currency,
      cashBankFx: cashBank,
      receivablesFx: receivables,
      checksInflowFx: checksInflowEst,
      payablesFx: money(r.payables_native),
      checksOutflowFx: money(r.checks_payable_native),
      loansFx: money(r.loan_debt_native),
      facilitiesFx: 0,
      derivativesHedgeFx: hedgeAmt,
      netFxPosition: money(r.net_position_native),
      latestTcmbRate: rateOrNull(r.spot_rate_to_try),
      latestRateDate: r.rate_date ? String(r.rate_date).slice(0, 10) : null,
      netTryEquivalent: netTry,
      shock10PctPnlTry:
        netTry != null ? Number(decimal(netTry).times("0.10").round(2).toFixed(2)) : null,
      shock20PctPnlTry:
        netTry != null ? Number(decimal(netTry).times("0.20").round(2).toFixed(2)) : null,
    };
  });

  const sumBank = (fn: (b: BankConcentrationRow) => number) =>
    Number(banks.reduce((acc, b) => acc.plus(fn(b)), decimal(0)).round(2).toFixed(2));

  const netFxOpenTry = Number(
    fxRows
      .reduce((acc, f) => acc.plus(f.netTryEquivalent ?? 0), decimal(0))
      .round(2)
      .toFixed(2),
  );

  const topShare = counterparties.reduce<number | null>((best, c) => {
    if (c.shareOfReceivablesPct == null) return best;
    return best == null || c.shareOfReceivablesPct > best ? c.shareOfReceivablesPct : best;
  }, null);

  return {
    todayISO,
    rates: [...rateMap.values()].filter((r) => r.currency !== "TRY"),
    counterparties,
    banks,
    fxRows,
    totals: {
      totalReceivablesTry,
      totalPayablesTry,
      totalBankCashTry: Number(
        decimal(sumBank((b) => b.cashTryEquivalent))
          .plus(sumBank((b) => b.termDepositTryEquivalent))
          .round(2)
          .toFixed(2),
      ),
      totalBankDebtTry: Number(
        decimal(sumBank((b) => b.loanDebtTryEquivalent))
          .plus(sumBank((b) => b.facilityDrawnTryEquivalent))
          .round(2)
          .toFixed(2),
      ),
      totalFacilityHeadroomTry: sumBank((b) => b.facilityHeadroomTryEquivalent),
      totalGuaranteesTry: sumBank((b) => b.guaranteeLettersTryEquivalent),
      netFxOpenTry,
      overLimitCounterpartyCount: counterparties.filter((c) => c.overCreditLimit).length,
      topCounterpartyConcentrationPct: topShare,
    },
  };
}
