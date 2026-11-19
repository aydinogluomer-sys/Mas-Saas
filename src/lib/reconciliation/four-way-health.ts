import type { Pool } from "pg";
import { decimal, moneyOrNull } from "@/lib/money";

export type FourWayPillarStatus =
  | "aligned"
  | "divergent"
  | "unknown_opening_balance"
  | "query_failed";

export interface FourWayPillarRow {
  key: "bank_102" | "ar_ap_120_320" | "checks_101_103" | "loans_300_400";
  title: string;
  tdhpCodes: string;
  subledgerTry: number | null;
  glLedgerTry: number | null;
  deltaTry: number | null;
  aligned: boolean;
  status: FourWayPillarStatus;
  queryFailed: boolean;
  queryError?: string | null;
  unknownOpeningCount?: number;
  detail: string;
}

export interface FourWaySubledgerHealth {
  alignedCount: number;
  divergentCount: number;
  unknownCount: number;
  failedCount: number;
  pillars: FourWayPillarRow[];
}

interface SafeQueryOutcome<T> {
  ok: boolean;
  rows: T[];
  error: string | null;
}

async function runSafeQuery<T>(fn: () => Promise<{ rows: T[] }>): Promise<SafeQueryOutcome<T>> {
  try {
    const res = await fn();
    return { ok: true, rows: res.rows, error: null };
  } catch (err: unknown) {
    return {
      ok: false,
      rows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * M-61: Live 4-Way Subledger ↔ TDHP Management Ledger Reconciliation Health
 * (`Banka/Kasa ↔ 100/102`, `Faturalar ↔ 120/320`, `Çek/Senet ↔ 101/103/121/321`, `Krediler ↔ 300/400`).
 * Pure numeric SQL + Big.js (`decimal`) — zero float8 casts, zero swallowed errors, and strict FIN-03.
 */
export async function loadFourWaySubledgerHealth(pool: Pool): Promise<FourWaySubledgerHealth> {
  const [glRes, bankRes, invRes, checkRes, loanRes] = await Promise.all([
    runSafeQuery(() =>
      pool.query<{ tdhp_root_code: string; debit_try: string; credit_try: string }>(
        `select ma.tdhp_root_code,
                coalesce(sum(jl.debit_try) filter (where je.id is not null), 0)::numeric(16,2)::text as debit_try,
                coalesce(sum(jl.credit_try) filter (where je.id is not null), 0)::numeric(16,2)::text as credit_try
           from public.management_accounts ma
           left join public.management_journal_lines jl on jl.account_id = ma.id
           left join public.management_journal_entries je
             on je.id = jl.entry_id
            and je.status in ('posted', 'reversed')
          where ma.tdhp_root_code in ('100','101','102','103','120','121','300','320','321','400')
          group by ma.tdhp_root_code`,
      ),
    ),
    runSafeQuery(() =>
      pool.query<{ active_n: number; unknown_n: number; sub_try: string | null }>(
        `select count(*)::int as active_n,
                count(*) filter (where ca.opening_balance is null)::int as unknown_n,
                case
                  when count(*) filter (where ca.opening_balance is null) > 0 then null::text
                  else coalesce(sum(ca.opening_balance + coalesce(tx.tx_sum, 0)), 0)::numeric(16,2)::text
                end as sub_try
           from public.cash_accounts ca
           left join (
             select bank_account_id, sum(amount) as tx_sum
               from public.bank_transactions
              where status <> 'ignored'
                and coalesce(currency, 'TRY') = 'TRY'
              group by bank_account_id
           ) tx on tx.bank_account_id = ca.id
          where ca.is_active = true
            and ca.archived_at is null
            and ca.currency = 'TRY'`,
      ),
    ),
    runSafeQuery(() =>
      pool.query<{ net_ar_ap_try: string }>(
        `select coalesce(sum(
           case
             when direction = 'sales' then greatest(coalesce(payable_amount, gross_amount) - coalesce(allocated_amount, 0), 0)
             when direction = 'purchase' then -greatest(coalesce(payable_amount, gross_amount) - coalesce(allocated_amount, 0), 0)
             else 0
           end
         ), 0)::numeric(16,2)::text as net_ar_ap_try
           from public.invoices
          where status in ('open', 'partial')
            and archived_at is null
            and bad_debt_at is null
            and currency = 'TRY'`,
      ),
    ),
    runSafeQuery(() =>
      pool.query<{ net_checks_try: string }>(
        `select coalesce(sum(
           case
             when direction = 'inflow' then coalesce(amount, 0)
             when direction = 'outflow' then -coalesce(amount, 0)
             else 0
           end
         ), 0)::numeric(16,2)::text as net_checks_try
           from public.checks
          where archived_at is null
            and coalesce(currency, 'TRY') = 'TRY'
            and status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')`,
      ),
    ),
    runSafeQuery(() =>
      pool.query<{ loans_try: string }>(
        `select coalesce(sum(coalesce(li.principal_component, li.amount, 0)), 0)::numeric(16,2)::text as loans_try
           from public.loan_installments li
           join public.loans l on l.id = li.loan_id
          where l.archived_at is null
            and coalesce(l.currency, 'TRY') = 'TRY'
            and li.status in ('planned', 'unpaid', 'late', 'partial')`,
      ),
    ),
  ]);

  const glMap = new Map<string, { debit: number; credit: number }>();
  for (const r of glRes.rows) {
    glMap.set(r.tdhp_root_code, {
      debit: moneyOrNull(r.debit_try) ?? 0,
      credit: moneyOrNull(r.credit_try) ?? 0,
    });
  }

  const netDrMinusCr = (codes: string[]): number | null => {
    if (!glRes.ok) return null;
    let acc = decimal(0);
    for (const code of codes) {
      const g = glMap.get(code);
      if (g) acc = acc.plus(decimal(g.debit).minus(g.credit));
    }
    return Number(acc.round(2).toFixed(2));
  };

  const netCrMinusDr = (codes: string[]): number | null => {
    if (!glRes.ok) return null;
    let acc = decimal(0);
    for (const code of codes) {
      const g = glMap.get(code);
      if (g) acc = acc.plus(decimal(g.credit).minus(g.debit));
    }
    return Number(acc.round(2).toFixed(2));
  };

  const makePillar = (params: {
    key: FourWayPillarRow["key"];
    title: string;
    tdhpCodes: string;
    subOk: boolean;
    subError: string | null;
    subVal: number | null;
    glVal: number | null;
    detail: string;
    unknownOpeningCount?: number;
  }): FourWayPillarRow => {
    const queryFailed = !params.subOk || !glRes.ok;
    const queryError = !params.subOk ? params.subError : !glRes.ok ? glRes.error : null;

    if (queryFailed) {
      return {
        key: params.key,
        title: params.title,
        tdhpCodes: params.tdhpCodes,
        subledgerTry: null,
        glLedgerTry: params.glVal,
        deltaTry: null,
        aligned: false,
        status: "query_failed",
        queryFailed: true,
        queryError,
        unknownOpeningCount: params.unknownOpeningCount,
        detail: `${params.detail} · Sorgu hatası nedeniyle mutabakat doğrulanamadı`,
      };
    }

    if ((params.unknownOpeningCount ?? 0) > 0 || params.subVal === null || params.glVal === null) {
      return {
        key: params.key,
        title: params.title,
        tdhpCodes: params.tdhpCodes,
        subledgerTry: null,
        glLedgerTry: params.glVal,
        deltaTry: null,
        aligned: false,
        status: "unknown_opening_balance",
        queryFailed: false,
        queryError: null,
        unknownOpeningCount: params.unknownOpeningCount ?? 0,
        detail: `FIN-03: ${params.unknownOpeningCount ?? 1} aktif TRY hesapta açılış bakiyesi tanımsız — mutabakat ölçülemez`,
      };
    }

    const delta = Number(decimal(params.subVal).minus(params.glVal).round(2).toFixed(2));
    const aligned = Math.abs(delta) <= 1;
    return {
      key: params.key,
      title: params.title,
      tdhpCodes: params.tdhpCodes,
      subledgerTry: params.subVal,
      glLedgerTry: params.glVal,
      deltaTry: delta,
      aligned,
      status: aligned ? "aligned" : "divergent",
      queryFailed: false,
      queryError: null,
      unknownOpeningCount: params.unknownOpeningCount ?? 0,
      detail: params.detail,
    };
  };

  const bankRow = bankRes.rows[0];
  const bankUnknownCount = bankRes.ok ? Number(bankRow?.unknown_n ?? 0) : 0;

  const pillars: FourWayPillarRow[] = [
    makePillar({
      key: "bank_102",
      title: "Banka & Kasa Alt Defteri",
      tdhpCodes: "100 / 102",
      subOk: bankRes.ok,
      subError: bankRes.error,
      subVal:
        !bankRes.ok || bankUnknownCount > 0 ? null : (moneyOrNull(bankRow?.sub_try) ?? 0),
      glVal: netDrMinusCr(["100", "102"]),
      unknownOpeningCount: bankUnknownCount,
      detail: "TRY aktif kasa+banka bakiyesi ↔ TDHP 100/102 net borç",
    }),
    makePillar({
      key: "ar_ap_120_320",
      title: "Açık Cari Faturalar (Alacak - Borç)",
      tdhpCodes: "120 / 320",
      subOk: invRes.ok,
      subError: invRes.error,
      subVal: invRes.ok ? (moneyOrNull(invRes.rows[0]?.net_ar_ap_try) ?? 0) : null,
      glVal: netDrMinusCr(["120", "320"]),
      detail: "Açık TRY satış - alış fatura bakiyesi ↔ TDHP 120 - 320 net",
    }),
    makePillar({
      key: "checks_101_103",
      title: "Çek & Senet Portföyü",
      tdhpCodes: "101 / 103 / 121 / 321",
      subOk: checkRes.ok,
      subError: checkRes.error,
      subVal: checkRes.ok ? (moneyOrNull(checkRes.rows[0]?.net_checks_try) ?? 0) : null,
      glVal: netDrMinusCr(["101", "103", "121", "321"]),
      detail: "Portföy/tahsil/teminat alınan - verilen çekler ↔ TDHP 101/103/121/321",
    }),
    makePillar({
      key: "loans_300_400",
      title: "Banka Kredileri Kalan Anapara",
      tdhpCodes: "300 / 400",
      subOk: loanRes.ok,
      subError: loanRes.error,
      subVal: loanRes.ok ? (moneyOrNull(loanRes.rows[0]?.loans_try) ?? 0) : null,
      glVal: netCrMinusDr(["300", "400"]),
      detail: "Açık TRY kredi taksit anaparaları ↔ TDHP 300/400 net alacak",
    }),
  ];

  const alignedCount = pillars.filter((p) => p.aligned).length;
  const unknownCount = pillars.filter((p) => p.status === "unknown_opening_balance").length;
  const failedCount = pillars.filter((p) => p.queryFailed).length;
  return {
    alignedCount,
    divergentCount: pillars.length - alignedCount,
    unknownCount,
    failedCount,
    pillars,
  };
}
