// Faz 63 (M-55) — Salt-okunur (SELECT-only) parametrik CFO analitik sorgu araclari.
// Tum sorgular yalniz SELECT kullanir; kesinlikle kayit degisikligi icermez.

import type { Pool, PoolClient } from "pg";
import type { DecisionFact } from "@/lib/facts/engine";
import { canSeeRoute, type AppRole } from "@/lib/authz/matrix";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type AnalyticalToolName =
  | "queryOpenInvoices"
  | "queryCounterpartySummary"
  | "queryTrialBalance"
  | "query13WeekLiquidity"
  | "queryRecentBankMovements"
  | "queryProductionMargins"
  | "queryCovenantHeadroom";

export interface ToolEvidenceRecord {
  tool: AnalyticalToolName;
  table: string;
  count: number;
  asOf: string;
  sourceHref: string;
  headline: string;
  details: string[];
}

export interface AnalyticalToolExecution {
  evidence: ToolEvidenceRecord;
  fact: DecisionFact;
}

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function fmtMoney(amount: number | null, currency = "TRY"): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
  const sym = currency === "TRY" ? "TL" : currency;
  return `${formatted} ${sym}`;
}

function normText(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase();
}

async function loadLatestSpotRatesToTry(
  db: Queryable,
  asOf: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>([["TRY", 1]]);
  try {
    const res = await db.query<{ base_currency: string; rate: string }>(
      `select distinct on (base_currency)
              base_currency,
              rate::text as rate
         from public.fx_rate_snapshots
        where quote_currency = 'TRY'
          and rate_date <= $1::date
        order by base_currency, rate_date desc, id desc`,
      [asOf],
    );
    for (const r of res.rows) {
      const parsed = rateOrNull(r.rate);
      if (parsed != null && parsed > 0) {
        map.set(r.base_currency.toUpperCase(), parsed);
      }
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  return map;
}

/** 1. Acik satis / alis faturalari (vade, doviz kirilimi ve konsolide TRY karsiligi). */
export async function queryOpenInvoices(
  db: Queryable,
  params: {
    asOf: string;
    direction?: "sales" | "purchase" | "all";
    overdueOnly?: boolean;
    currency?: string | null;
    limit?: number;
  },
): Promise<AnalyticalToolExecution> {
  const dir = params.direction ?? "all";
  const overdueOnly = Boolean(params.overdueOnly);
  const currFilter = params.currency?.trim().toUpperCase() || null;
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 25);

  const [aggRes, topRes, fxMap] = await Promise.all([
    db.query<{
      direction: string;
      currency: string;
      inv_count: number;
      overdue_count: number;
      remaining_sum: string | null;
    }>(
      `select v.direction,
              v.currency,
              count(*)::int as inv_count,
              count(*) filter (where v.due_date < $1::date)::int as overdue_count,
              sum(
                greatest(
                  coalesce(v.payable_amount, v.gross_amount) -
                  greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)),
                  0
                )
              )::text as remaining_sum
         from public.invoices v
        where v.status in ('open', 'partial')
          and ($2::text = 'all' or v.direction = $2)
          and (not $3::boolean or v.due_date < $1::date)
          and ($4::text is null or v.currency = $4)
        group by v.direction, v.currency
        order by v.direction, v.currency`,
      [params.asOf, dir, overdueOnly, currFilter],
    ),
    db.query<{
      invoice_no: string | null;
      party_name: string | null;
      direction: string;
      currency: string;
      due_date: string | null;
      remaining: string | null;
    }>(
      `select v.invoice_no,
              p.name as party_name,
              v.direction,
              v.currency,
              to_char(v.due_date, 'YYYY-MM-DD') as due_date,
              greatest(
                coalesce(v.payable_amount, v.gross_amount) -
                greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)),
                0
              )::text as remaining
         from public.invoices v
         left join public.parties p on p.id = v.party_id
        where v.status in ('open', 'partial')
          and ($2::text = 'all' or v.direction = $2)
          and (not $3::boolean or v.due_date < $1::date)
          and ($4::text is null or v.currency = $4)
        order by greatest(
          coalesce(v.payable_amount, v.gross_amount) -
          greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)),
          0
        ) desc nulls last
        limit $5`,
      [params.asOf, dir, overdueOnly, currFilter, limit],
    ),
    loadLatestSpotRatesToTry(db, params.asOf),
  ]);

  let totalCount = 0;
  let overdueCount = 0;
  let salesTryEq = decimal(0);
  let purchaseTryEq = decimal(0);
  const bucketParts: string[] = [];

  for (const row of aggRes.rows) {
    const cnt = Number(row.inv_count ?? 0);
    const ovd = Number(row.overdue_count ?? 0);
    const rem = moneyOrNull(row.remaining_sum) ?? 0;
    totalCount += cnt;
    overdueCount += ovd;
    const labelDir = row.direction === "sales" ? "Alacak" : "Borç";
    bucketParts.push(`${labelDir} (${row.currency}): ${fmtMoney(rem, row.currency)} (${cnt} fatura, ${ovd} gecikmiş)`);
    const fx = fxMap.get(row.currency.toUpperCase());
    if (fx != null) {
      const tryVal = decimal(rem).times(decimal(fx));
      if (row.direction === "sales") salesTryEq = salesTryEq.plus(tryVal);
      else purchaseTryEq = purchaseTryEq.plus(tryVal);
    }
  }

  const topLines = topRes.rows.slice(0, 5).map((r) => {
    const rem = moneyOrNull(r.remaining);
    const tag = r.direction === "sales" ? "Alacak" : "Borç";
    return `${tag} · ${r.party_name ?? "Cari tanımsız"} (${r.invoice_no ?? "No yok"}): ${fmtMoney(rem, r.currency)} · Vade ${r.due_date ?? "—"}`;
  });

  const headline =
    totalCount === 0
      ? "Filtreye uygun açık fatura kaydı bulunmuyor."
      : `Toplam ${totalCount} açık fatura (${overdueCount} gecikmiş) · Konsolide Alacak ≈ ${fmtMoney(money(salesTryEq), "TRY")}, Borç ≈ ${fmtMoney(money(purchaseTryEq), "TRY")}`;

  const sourceHref =
    dir === "sales"
      ? "/finance/invoices?direction=sales"
      : dir === "purchase"
        ? "/finance/invoices?direction=purchase"
        : "/finance/invoices";

  return {
    evidence: {
      tool: "queryOpenInvoices",
      table: "public.invoices",
      count: totalCount,
      asOf: params.asOf,
      sourceHref,
      headline,
      details: [...bucketParts, ...topLines],
    },
    fact: {
      key: `sql_open_invoices_${dir}`,
      title: "SQL Kanıtı — Açık Fatura Portföyü",
      value: `${totalCount} fatura (${overdueCount} gecikmiş)`,
      severity: overdueCount > 0 ? "high" : "low",
      explanation: [headline, ...bucketParts, ...topLines.slice(0, 3)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref,
    },
  };
}

/** 2. Cari hesap ozeti (acik alacak, acik borc ve cek/senet riski). */
export async function queryCounterpartySummary(
  db: Queryable,
  params: { asOf: string; searchTerm?: string | null; limit?: number },
): Promise<AnalyticalToolExecution> {
  const term = params.searchTerm?.trim() || null;
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);

  const res = await db.query<{
    party_id: string;
    party_name: string;
    party_type: string;
    ar_try: string | null;
    ap_try: string | null;
    open_inv_count: number;
    check_exposure_try: string | null;
  }>(
    `select p.id::text as party_id,
            p.name as party_name,
            p.party_type,
            coalesce(inv.ar_try, 0)::text as ar_try,
            coalesce(inv.ap_try, 0)::text as ap_try,
            coalesce(inv.open_inv_count, 0)::int as open_inv_count,
            coalesce(chk.check_try, 0)::text as check_exposure_try
       from public.parties p
       left join lateral (
         select count(*)::int as open_inv_count,
                sum(
                  case when v.direction = 'sales' and v.currency = 'TRY'
                       then greatest(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)), 0)
                       else 0 end
                ) as ar_try,
                sum(
                  case when v.direction = 'purchase' and v.currency = 'TRY'
                       then greatest(coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)), 0)
                       else 0 end
                ) as ap_try
           from public.invoices v
          where v.party_id = p.id
            and v.status in ('open', 'partial')
       ) inv on true
       left join lateral (
         select sum(coalesce(c.amount, abs(c.signed_amount))) as check_try
           from public.checks c
          where c.archived_at is null
            and c.currency = 'TRY'
            and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
            and (c.payer_party_id = p.id or c.payee_party_id = p.id)
       ) chk on true
      where ($1::text is null or p.name ilike '%' || $1 || '%' or p.normalized_name ilike '%' || lower($1) || '%')
        and (coalesce(inv.open_inv_count, 0) > 0 or coalesce(chk.check_try, 0) > 0 or $1::text is not null)
      order by (coalesce(inv.ar_try, 0) + coalesce(inv.ap_try, 0) + coalesce(chk.check_try, 0)) desc
      limit $2`,
    [term, limit],
  );

  const details = res.rows.map((r) => {
    const ar = moneyOrNull(r.ar_try) ?? 0;
    const ap = moneyOrNull(r.ap_try) ?? 0;
    const ck = moneyOrNull(r.check_exposure_try) ?? 0;
    return `${r.party_name} (${r.party_type}): Açık Alacak ${fmtMoney(ar)}, Açık Borç ${fmtMoney(ap)}, Açık Çek/Senet ${fmtMoney(ck)}`;
  });

  const headline =
    res.rows.length === 0
      ? term
        ? `"${term}" aramasına uygun açık bakiyeli cari bulunamadı.`
        : "Açık fatura veya çek bakiyesi taşıyan cari bulunmuyor."
      : `${res.rows.length} cari hesap listelendi · En yüksek bakiye: ${res.rows[0].party_name}`;

  return {
    evidence: {
      tool: "queryCounterpartySummary",
      table: "public.parties",
      count: res.rows.length,
      asOf: params.asOf,
      sourceHref: "/finance/counterparties",
      headline,
      details,
    },
    fact: {
      key: "sql_counterparty_summary",
      title: "SQL Kanıtı — Cari Bakiye & Risk Özeti",
      value: `${res.rows.length} cari`,
      severity: "low",
      explanation: [headline, ...details.slice(0, 4)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref: "/finance/counterparties",
    },
  };
}

/** 3. TDHP Yonetim Mizani & Gelir Tablosu (EBITDA / Net Kar) sorgusu. */
export async function queryTrialBalance(
  db: Queryable,
  params: { asOf: string; codePrefix?: string | null },
): Promise<AnalyticalToolExecution> {
  const prefix = params.codePrefix?.trim() || null;

  const [tbRes, plRes] = await Promise.all([
    db.query<{
      account_code: string;
      account_name: string;
      debit_total_try: string;
      credit_total_try: string;
      net_balance_try: string;
    }>(
      `select account_code,
              account_name,
              debit_total_try::text,
              credit_total_try::text,
              net_balance_try::text
         from public.management_trial_balance_v
        where (debit_total_try <> 0 or credit_total_try <> 0 or $1::text is not null)
          and ($1::text is null or account_code like $1 || '%')
        order by account_code asc
        limit 25`,
      [prefix],
    ),
    db.query<{
      net_sales_try: string;
      gross_profit_try: string;
      management_ebitda_try: string;
      net_income_try: string;
    }>(
      `select net_sales_try::text,
              gross_profit_try::text,
              management_ebitda_try::text,
              net_income_try::text
         from public.management_income_statement_v
        limit 1`,
    ),
  ]);

  let sumDebit = decimal(0);
  let sumCredit = decimal(0);
  for (const row of tbRes.rows) {
    sumDebit = sumDebit.plus(decimal(moneyOrNull(row.debit_total_try) ?? 0));
    sumCredit = sumCredit.plus(decimal(moneyOrNull(row.credit_total_try) ?? 0));
  }
  const pl = plRes.rows[0];
  const netSales = moneyOrNull(pl?.net_sales_try);
  const ebitda = moneyOrNull(pl?.management_ebitda_try);
  const netIncome = moneyOrNull(pl?.net_income_try);

  const accountLines = tbRes.rows.slice(0, 6).map((r) => {
    const net = moneyOrNull(r.net_balance_try) ?? 0;
    return `${r.account_code} ${r.account_name}: Borç ${fmtMoney(moneyOrNull(r.debit_total_try))}, Alacak ${fmtMoney(moneyOrNull(r.credit_total_try))}, Net ${fmtMoney(net)}`;
  });

  const headline = `TDHP Mizan (${tbRes.rows.length} aktif hesap) · Net Satış: ${fmtMoney(netSales)} · Yönetim EBITDA: ${fmtMoney(ebitda)} · Net Dönem Kârı: ${fmtMoney(netIncome)}`;

  return {
    evidence: {
      tool: "queryTrialBalance",
      table: "public.management_trial_balance_v",
      count: tbRes.rows.length,
      asOf: params.asOf,
      sourceHref: "/finance/ledger",
      headline,
      details: accountLines,
    },
    fact: {
      key: "sql_trial_balance",
      title: "SQL Kanıtı — TDHP Mizan & EBITDA",
      value: `EBITDA ${fmtMoney(ebitda)}`,
      severity: (netIncome ?? 0) < 0 ? "medium" : "low",
      explanation: [headline, ...accountLines.slice(0, 4)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref: "/finance/ledger",
    },
  };
}

/** 4. 13 Haftalik (91 gunluk) canli likidite projeksiyonu ve konsolide TRY esdegeri. */
export async function query13WeekLiquidity(
  db: Queryable,
  params: { asOf: string },
): Promise<AnalyticalToolExecution> {
  const [flowRes, cashRes, fxMap] = await Promise.all([
    db.query<{
      currency: string;
      horizon_bucket: string;
      inflow_sum: string | null;
      outflow_sum: string | null;
      item_count: number;
    }>(
      `select currency,
              case
                when flow_date <= ($1::date + 7) then '7d'
                when flow_date <= ($1::date + 30) then '30d'
                else '31_91d'
              end as horizon_bucket,
              sum(case when amount_signed > 0 then amount_signed else 0 end)::text as inflow_sum,
              sum(case when amount_signed < 0 then abs(amount_signed) else 0 end)::text as outflow_sum,
              count(*)::int as item_count
         from public.liquidity_forecast_daily
        where flow_date >= $1::date
          and flow_date <= ($1::date + 91)
        group by currency, 2
        order by currency, 2`,
      [params.asOf],
    ),
    db.query<{
      currency: string;
      account_count: number;
      unknown_opening_count: number;
      total_balance: string | null;
    }>(
      `select ca.currency,
              count(*)::int as account_count,
              count(*) filter (where ca.opening_balance is null)::int as unknown_opening_count,
              case
                when count(*) filter (where ca.opening_balance is null) > 0 then null::text
                else sum(ca.opening_balance + coalesce(tx.net_tx, 0))::text
              end as total_balance
         from public.cash_accounts ca
         left join lateral (
           select sum(bt.amount) as net_tx
             from public.bank_transactions bt
            where bt.bank_account_id = ca.id
              and bt.status <> 'ignored'
              and bt.txn_date <= $1::date
              and coalesce(bt.currency, ca.currency) = ca.currency
         ) tx on true
        where ca.is_active = true
          and ca.archived_at is null
        group by ca.currency
        order by ca.currency`,
      [params.asOf],
    ),
    loadLatestSpotRatesToTry(db, params.asOf),
  ]);

  let totalItems = 0;
  let totalAccounts = 0;
  let totalUnknownOpening = 0;
  let unconvertibleCashCurrency = false;
  let cashConsolidatedTry = decimal(0);
  let net91ConsolidatedTry = decimal(0);
  const details: string[] = [];

  for (const c of cashRes.rows) {
    const accCount = Number(c.account_count ?? 0);
    const unkCount = Number(c.unknown_opening_count ?? 0);
    totalAccounts += accCount;
    totalUnknownOpening += unkCount;

    if (unkCount > 0 || c.total_balance == null) {
      details.push(
        `Hazır Değer (${c.currency}, ${accCount} hesap): Bilinmiyor (FIN-03: ${unkCount} hesapta açılış bakiyesi tanımsız; 0 sayılmaz)`,
      );
      continue;
    }

    const bal = moneyOrNull(c.total_balance);
    if (bal == null) {
      unconvertibleCashCurrency = true;
      details.push(`Hazır Değer (${c.currency}, ${accCount} hesap): Bilinmiyor`);
      continue;
    }

    const fx = fxMap.get(c.currency.toUpperCase()) ?? (c.currency === "TRY" ? 1 : null);
    if (fx != null) {
      cashConsolidatedTry = cashConsolidatedTry.plus(decimal(bal).times(decimal(fx)));
    } else {
      unconvertibleCashCurrency = true;
    }
    details.push(`Hazır Değer (${c.currency}, ${accCount} hesap): ${fmtMoney(bal, c.currency)}`);
  }

  for (const f of flowRes.rows) {
    const inf = moneyOrNull(f.inflow_sum) ?? 0;
    const out = moneyOrNull(f.outflow_sum) ?? 0;
    totalItems += Number(f.item_count ?? 0);
    const fx = fxMap.get(f.currency.toUpperCase()) ?? (f.currency === "TRY" ? 1 : null);
    if (fx != null) {
      net91ConsolidatedTry = net91ConsolidatedTry.plus(decimal(inf).minus(decimal(out)).times(decimal(fx)));
    }
    details.push(
      `Ufuk ${f.horizon_bucket} (${f.currency}): Giriş +${fmtMoney(inf, f.currency)} / Çıkış -${fmtMoney(out, f.currency)} (${f.item_count} kayıt)`,
    );
  }

  const net91Try = money(net91ConsolidatedTry);
  const cashKnown = totalAccounts > 0 && totalUnknownOpening === 0 && !unconvertibleCashCurrency;
  const projectedEndTry = cashKnown ? money(cashConsolidatedTry.plus(net91ConsolidatedTry)) : null;
  const headline = cashKnown
    ? `13 Haftalık Likidite (${totalItems} sözleşmeli akış) · Konsolide Açılış ≈ ${fmtMoney(money(cashConsolidatedTry))} → 91G Sonu Projeksiyon ≈ ${fmtMoney(projectedEndTry)}`
    : `13 Haftalık Likidite (${totalItems} sözleşmeli akış, 91G Net Akış ≈ ${fmtMoney(net91Try)}) · Konsolide Açılış ve 91G Kapanış Bilinmiyor (FIN-03: ${totalUnknownOpening} aktif hesapta açılış bakiyesi eksik)`;

  return {
    evidence: {
      tool: "query13WeekLiquidity",
      table: "public.liquidity_forecast_daily",
      count: totalItems,
      asOf: params.asOf,
      sourceHref: "/cashflow/13-week",
      headline,
      details,
    },
    fact: {
      key: "sql_13w_liquidity",
      title: "SQL Kanıtı — 13 Haftalık Konsolide Likidite",
      value: projectedEndTry == null ? "Bilinmiyor (FIN-03)" : fmtMoney(projectedEndTry),
      severity: projectedEndTry == null ? "medium" : projectedEndTry < 0 ? "critical" : "low",
      explanation: [headline, ...details.slice(0, 5)].join(" | "),
      confidence: cashKnown ? "source" : "needs_review",
      freshness: params.asOf,
      sourceHref: "/cashflow/13-week",
    },
  };
}

/** 5. Son 30 gunluk banka hareketleri ve eslesmemis mutabakat kalemleri. */
export async function queryRecentBankMovements(
  db: Queryable,
  params: { asOf: string; limit?: number },
): Promise<AnalyticalToolExecution> {
  const limit = Math.min(Math.max(params.limit ?? 8, 1), 20);
  const [aggRes, listRes] = await Promise.all([
    db.query<{
      currency: string;
      tx_count: number;
      unmatched_count: number;
      inflow_sum: string | null;
      outflow_sum: string | null;
    }>(
      `select ca.currency,
              count(*)::int as tx_count,
              count(*) filter (where bt.status = 'unmatched')::int as unmatched_count,
              sum(case when bt.amount > 0 then bt.amount else 0 end)::text as inflow_sum,
              sum(case when bt.amount < 0 then abs(bt.amount) else 0 end)::text as outflow_sum
         from public.bank_transactions bt
         join public.cash_accounts ca on ca.id = bt.bank_account_id
        where bt.status <> 'ignored'
          and bt.txn_date >= ($1::date - 30)
          and bt.txn_date <= $1::date
        group by ca.currency
        order by ca.currency`,
      [params.asOf],
    ),
    db.query<{
      tx_date: string;
      account_name: string;
      currency: string;
      direction: string;
      amount: string;
      description: string | null;
      reconciliation_status: string;
    }>(
      `select to_char(bt.txn_date, 'YYYY-MM-DD') as tx_date,
              ca.name as account_name,
              ca.currency,
              bt.direction,
              abs(bt.amount)::text as amount,
              bt.description,
              bt.status as reconciliation_status
         from public.bank_transactions bt
         join public.cash_accounts ca on ca.id = bt.bank_account_id
        where bt.status <> 'ignored'
          and bt.txn_date <= $2::date
        order by bt.txn_date desc, bt.created_at desc
        limit $1`,
      [limit, params.asOf],
    ),
  ]);

  let totalTx = 0;
  let unmatchedTotal = 0;
  const details: string[] = [];

  for (const r of aggRes.rows) {
    totalTx += Number(r.tx_count ?? 0);
    unmatchedTotal += Number(r.unmatched_count ?? 0);
    details.push(
      `Son 30G (${r.currency}): +${fmtMoney(moneyOrNull(r.inflow_sum), r.currency)} / -${fmtMoney(moneyOrNull(r.outflow_sum), r.currency)} (${r.tx_count} işlem, ${r.unmatched_count} eşleşmemiş)`,
    );
  }

  for (const tx of listRes.rows.slice(0, 5)) {
    const sign = tx.direction === "inflow" ? "+" : "-";
    details.push(
      `${tx.tx_date} · ${tx.account_name}: ${sign}${fmtMoney(moneyOrNull(tx.amount), tx.currency)} (${tx.reconciliation_status}) — ${tx.description ?? "Açıklama yok"}`,
    );
  }

  const headline = `Son 30 günde ${totalTx} banka hareketi · ${unmatchedTotal} eşleşmemiş satır`;

  return {
    evidence: {
      tool: "queryRecentBankMovements",
      table: "public.bank_transactions",
      count: totalTx,
      asOf: params.asOf,
      sourceHref: "/finance/bank",
      headline,
      details,
    },
    fact: {
      key: "sql_recent_bank_movements",
      title: "SQL Kanıtı — Son Banka Hareketleri",
      value: `${totalTx} işlem (${unmatchedTotal} eşleşmemiş)`,
      severity: unmatchedTotal > 5 ? "medium" : "low",
      explanation: [headline, ...details.slice(0, 4)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref: "/finance/bank",
    },
  };
}

/** 6. Uretim parca marjlari, musteri tarife kartlari ve is emri OEE ozeti (sifir sabit musteri). */
export async function queryProductionMargins(
  db: Queryable,
  params: { asOf: string },
): Promise<AnalyticalToolExecution> {
  const details: string[] = [];
  let count = 0;

  try {
    const [rcRes, woRes, partRes] = await Promise.all([
      db.query<{ customer_label: string; operation_type: string; rate_per_minute: string; currency: string }>(
        `select customer_label, operation_type, rate_per_minute::text, currency
           from public.customer_rate_cards
          where is_active = true
          order by operation_type, customer_label
          limit 10`,
      ),
      db.query<{
        total_wo: number;
        completed_wo: number;
        good_qty: string | null;
        scrap_qty: string | null;
        run_min: string | null;
        down_min: string | null;
      }>(
        `select count(*)::int as total_wo,
                count(*) filter (where status = 'completed')::int as completed_wo,
                sum(good_qty)::text as good_qty,
                sum(scrap_qty)::text as scrap_qty,
                sum(actual_run_minutes)::text as run_min,
                sum(downtime_minutes)::text as down_min
           from public.work_orders`,
      ),
      db.query<{ part_count: number }>(
        `select count(*)::int as part_count from public.production_parts where is_active = true`,
      ),
    ]);

    count = Number(partRes.rows[0]?.part_count ?? 0) + rcRes.rows.length;
    for (const rc of rcRes.rows.slice(0, 4)) {
      details.push(
        `Tarife Kartı · ${rc.customer_label} (${rc.operation_type}): ${fmtMoney(rateOrNull(rc.rate_per_minute), rc.currency)}/dk`,
      );
    }
    const wo = woRes.rows[0];
    if (wo && Number(wo.total_wo) > 0) {
      details.push(
        `İş Emirleri: ${wo.total_wo} toplam (${wo.completed_wo} tamamlandı) · Sağlam: ${wo.good_qty ?? "0"} · Hurda: ${wo.scrap_qty ?? "0"} · Duruş: ${wo.down_min ?? "0"} dk`,
      );
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }

  const costRes = await db.query<{
    model_name: string;
    breakeven_tl_per_min: string | null;
  }>(
    `select model_name, break_even_tl_per_min::text as breakeven_tl_per_min
       from public.cost_models
      order by created_at desc
      limit 4`,
  ).catch(() => ({ rows: [] as Array<{ model_name: string; breakeven_tl_per_min: string | null }> }));

  for (const cm of costRes.rows) {
    count += 1;
    details.push(`Maliyet Modeli · ${cm.model_name}: Başabaş ${fmtMoney(rateOrNull(cm.breakeven_tl_per_min))}/dk`);
  }

  const headline =
    count === 0
      ? "Henüz aktif üretim parça veya tarife kartı kaydı bulunmuyor."
      : `Üretim Maliyet & Tarife Özeti (${count} aktif kayıt/tarife incelendi)`;

  return {
    evidence: {
      tool: "queryProductionMargins",
      table: "public.customer_rate_cards",
      count,
      asOf: params.asOf,
      sourceHref: "/production/profitability",
      headline,
      details,
    },
    fact: {
      key: "sql_production_margins",
      title: "SQL Kanıtı — Üretim Marjları, İş Emirleri & Tarifeler",
      value: `${count} kayıt`,
      severity: "low",
      explanation: [headline, ...details.slice(0, 4)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref: "/production/profitability",
    },
  };
}

/** 7. Kredi & Limit Kovenant (DSCR / Kaldirac / Cari Oran) boslugu sorgusu. */
export async function queryCovenantHeadroom(
  db: Queryable,
  params: { asOf: string },
): Promise<AnalyticalToolExecution> {
  const res = await db.query<{
    id: string;
    covenant_type: string;
    description: string;
    comparison: string;
    threshold_value: string;
    test_frequency: string;
    last_test_date: string | null;
    last_test_value: string | null;
    last_test_result: string | null;
    subject_name: string | null;
  }>(
    `select cr.id::text,
            cr.covenant_type,
            cr.description,
            cr.comparison,
            cr.threshold_value::text,
            cr.test_frequency,
            to_char(cr.last_test_date, 'YYYY-MM-DD') as last_test_date,
            cr.last_test_value::text,
            cr.last_test_result,
            coalesce(l.name, cf.name) as subject_name
       from public.covenant_records cr
       left join public.loans l on l.id = cr.loan_id
       left join public.credit_facilities cf on cf.id = cr.facility_id
      where cr.status = 'active'
      order by case when cr.last_test_result = 'breached' then 0 else 1 end,
               cr.last_test_date asc nulls first`,
  );

  const breachedCount = res.rows.filter((r) => r.last_test_result === "breached").length;
  const details = res.rows.slice(0, 6).map((r) => {
    const thr = rateOrNull(r.threshold_value);
    const val = rateOrNull(r.last_test_value);
    return `${r.subject_name ?? "Sözleşme"} · ${r.covenant_type.toUpperCase()} (${r.comparison} ${thr ?? "—"}): Son Test ${val ?? "ölçülmedi"} (${r.last_test_result ?? "test edilmedi"}, ${r.last_test_date ?? "—"})`;
  });

  const headline =
    res.rows.length === 0
      ? "Aktif kredi veya limit kovenant kaydı bulunmuyor."
      : `${res.rows.length} aktif kovenant maddesi · ${breachedCount} ihlal (breached)`;

  return {
    evidence: {
      tool: "queryCovenantHeadroom",
      table: "public.covenant_records",
      count: res.rows.length,
      asOf: params.asOf,
      sourceHref: "/finance/facilities",
      headline,
      details,
    },
    fact: {
      key: "sql_covenant_headroom",
      title: "SQL Kanıtı — Kredi Kovenant & DSCR Durumu",
      value: `${res.rows.length} kovenant (${breachedCount} ihlal)`,
      severity: breachedCount > 0 ? "critical" : "low",
      explanation: [headline, ...details.slice(0, 4)].join(" | "),
      confidence: "source",
      freshness: params.asOf,
      sourceHref: "/finance/facilities",
    },
  };
}

export interface PlannedToolSpec {
  name: AnalyticalToolName;
  invoiceDirection?: "sales" | "purchase" | "all";
  overdueOnly?: boolean;
  searchTerm?: string | null;
  codePrefix?: string | null;
}

/** Doğal dil sorusundan hangi salt-okunur SQL araclarinin calistirilacagini deterministik secer. */
export function planToolsForQuestion(question: string): PlannedToolSpec[] {
  const q = normText(question);
  const specs: PlannedToolSpec[] = [];
  const seen = new Set<AnalyticalToolName>();
  const add = (spec: PlannedToolSpec) => {
    if (seen.has(spec.name)) return;
    seen.add(spec.name);
    specs.push(spec);
  };

  if (/\b(fatura|alacak|borc|vade|gecik|tahsilat)\b/.test(q)) {
    const dir =
      q.includes("alacak") || q.includes("satis")
        ? "sales"
        : q.includes("borc") || q.includes("alis") || q.includes("tedarik")
          ? "purchase"
          : "all";
    add({
      name: "queryOpenInvoices",
      invoiceDirection: dir,
      overdueOnly: q.includes("gecik") || q.includes("vadesi gec"),
    });
  }

  if (/\b(cari|musteri|tedarikci|firma|bakiye|yogunlasma|ekstre)\b/.test(q)) {
    const quoted = question.match(/["“”']([^"“”']{2,40})["“”']/);
    add({
      name: "queryCounterpartySummary",
      searchTerm: quoted ? quoted[1].trim() : null,
    });
  }

  if (/\b(mizan|defter|tdhp|ebitda|bilanco|gelir tablosu|kar|zarar|102|120|320|600|770)\b/.test(q)) {
    const codeMatch = q.match(/\b(100|101|102|103|108|120|121|150|151|152|191|300|320|321|335|360|361|391|600|620|710|720|730|760|770|780)\b/);
    add({
      name: "queryTrialBalance",
      codePrefix: codeMatch ? codeMatch[1] : null,
    });
  }

  if (/\b(13 hafta|13h|91 gun|likidite|nakit|kasa|pist|runway|cikis|giris|7 gun|30 gun)\b/.test(q)) {
    add({ name: "query13WeekLiquidity" });
  }

  if (/\b(banka|ekstre|havale|eft|eslesmemis|hareket)\b/.test(q)) {
    add({ name: "queryRecentBankMovements" });
  }

  if (/\b(uretim|parca|marj|maliyet|basabas|tarife|oee|is emri|hurda|kapasite|freze|torna)\b/.test(q)) {
    add({ name: "queryProductionMargins" });
  }

  if (/\b(kovenant|covenant|dscr|limit|teminat|kredi|kaldirac)\b/.test(q)) {
    add({ name: "queryCovenantHeadroom" });
  }

  if (specs.length === 0) {
    add({ name: "query13WeekLiquidity" });
    add({ name: "queryOpenInvoices", invoiceDirection: "all" });
  }

  return specs.slice(0, 4);
}

/** Planlanan salt-okunur SQL araclarini calistirir ve rol gorunurluk suzgecinden gecirir. */
export async function executePlannedTools(
  db: Queryable,
  question: string,
  asOf: string,
  role?: AppRole,
): Promise<{ facts: DecisionFact[]; evidences: ToolEvidenceRecord[] }> {
  const specs = planToolsForQuestion(question);
  const runs = await Promise.all(
    specs.map(async (spec): Promise<AnalyticalToolExecution | null> => {
      try {
        switch (spec.name) {
          case "queryOpenInvoices":
            return await queryOpenInvoices(db, {
              asOf,
              direction: spec.invoiceDirection,
              overdueOnly: spec.overdueOnly,
            });
          case "queryCounterpartySummary":
            return await queryCounterpartySummary(db, {
              asOf,
              searchTerm: spec.searchTerm,
            });
          case "queryTrialBalance":
            return await queryTrialBalance(db, {
              asOf,
              codePrefix: spec.codePrefix,
            });
          case "query13WeekLiquidity":
            return await query13WeekLiquidity(db, { asOf });
          case "queryRecentBankMovements":
            return await queryRecentBankMovements(db, { asOf });
          case "queryProductionMargins":
            return await queryProductionMargins(db, { asOf });
          case "queryCovenantHeadroom":
            return await queryCovenantHeadroom(db, { asOf });
        }
      } catch {
        return null;
      }
    }),
  );

  const facts: DecisionFact[] = [];
  const evidences: ToolEvidenceRecord[] = [];
  for (const r of runs) {
    if (!r) continue;
    const baseRoute = r.evidence.sourceHref.split("?")[0] || "/";
    if (role && !canSeeRoute(role, baseRoute)) continue;
    facts.push(r.fact);
    evidences.push(r.evidence);
  }
  return { facts, evidences };
}
