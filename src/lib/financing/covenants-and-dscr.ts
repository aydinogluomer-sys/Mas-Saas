/**
 * Faz 55 (F2) — Kovenant Erken Uyarı Radarı, Nakit DSCR (Cash Debt Service Coverage Ratio)
 * ve CFADS (Cash Flow Available for Debt Service) Köprüsü.
 *
 * Temel Formüller & Kurallar:
 * 1. Nakit DSCR:
 *    `DSCR = CFADS / (Anapara Taksitleri + Faiz + BSMV + KKDF)`
 *    - Payda (`totalDebtService`) `0` ise `dscr = null` döner (asla `NaN` veya `Infinity` üretmez).
 *    - CFADS penceresinde tutarı bilinmeyen (`null`) ay/kalem varsa `confidence = "partial_confidence"` işaretlenir.
 * 2. Net Borç / Yönetim EBITDA:
 *    - `Net Borç = Kalan Kredi Anapara + Kullanılan Rotatif Kredi Limiti - Kullanılabilir Nakit`
 *    - `Yönetim EBITDA` Faz 52'nin `public.management_income_statement_v` görünümünden okunur.
 *    - `Yönetim EBITDA <= 0` ise oran `null` döner (asla `0`'a bölünmez).
 * 3. Kovenant Erken Uyarı (`evaluateCovenantThreshold`):
 *    - Alt sınır (`>=`, `>`): `actual < threshold` => `breached`; `actual <= threshold * 1.10` => `warning` (%10 erken uyarı tamponu); aksi halde `compliant`.
 *    - Üst sınır (`<=`, `<`): `actual > threshold` => `breached`; `actual >= threshold * 0.90` => `warning` (%10 erken uyarı tamponu); aksi halde `compliant`.
 *
 * Bu modül `@/lib/ai` veya `@/lib/env` import etmez.
 */

import type { Pool, PoolClient } from "pg";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

export type DscrHorizonKey = "trailing_3m" | "forward_3m" | "forward_12m";
export type DscrConfidence = "full" | "partial_confidence";
export type CovenantEarlyWarningState = "compliant" | "warning" | "breached" | "waived" | "not_tested";

export interface CashDscrWindow {
  horizon: DscrHorizonKey;
  label: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  operationalInflows: number;
  operationalOutflowsBeforeDebtService: number;
  cfads: number;
  principalComponent: number;
  interestComponent: number;
  taxComponentBsmvKkdf: number;
  totalDebtService: number;
  /** Payda 0 ise null; asla NaN veya Infinity olmaz */
  dscr: number | null;
  confidence: DscrConfidence;
  unknownComponentCount: number;
}

export interface CovenantEvaluationItem {
  covenantId: string;
  subjectName: string;
  covenantType: string;
  description: string;
  comparison: ">=" | "<=" | ">" | "<" | "=";
  thresholdValue: number;
  measuredValue: number | null;
  state: CovenantEarlyWarningState;
  /** Eşik değerine olan yüzdesel mesafe (negatifse ihlal, 0..10 arasıysa erken uyarı) */
  headroomPct: number | null;
  explanation: string;
  metricSource: string;
}

export interface CovenantAndDscrRadar {
  asOfDate: string;
  currency: string;
  availableCash: number | null;
  totalLoanPrincipalRemaining: number;
  totalFacilityDrawn: number;
  netDebt: number | null;
  managementEbitda: number | null;
  netDebtToEbitda: number | null;
  dscrWindows: {
    trailing3m: CashDscrWindow;
    forward3m: CashDscrWindow;
    forward12m: CashDscrWindow;
  };
  covenants: CovenantEvaluationItem[];
  breachedCount: number;
  warningCount: number;
  compliantCount: number;
}

export interface ComputeCashDscrWindowInput {
  horizon: DscrHorizonKey;
  label: string;
  periodStart: string;
  periodEnd: string;
  currency?: string;
  operationalInflows: ReadonlyArray<number | null>;
  operationalOutflowsBeforeDebtService: ReadonlyArray<number | null>;
  installments: ReadonlyArray<{
    amount: number;
    principalComponent?: number | null;
    interestComponent?: number | null;
    taxComponentBsmvKkdf?: number | null;
  }>;
  extraUnknownCount?: number;
}

/**
 * Saf (pure) Nakit DSCR & CFADS pencere hesaplayıcısı.
 * Payda 0 olduğunda her zaman `dscr: null` döner.
 */
export function computeCashDscrWindow(input: ComputeCashDscrWindowInput): CashDscrWindow {
  const currency = (input.currency ?? "TRY").trim().toUpperCase();
  let unknownCount = input.extraUnknownCount ?? 0;

  let inflowDec = decimal(0);
  for (const v of input.operationalInflows) {
    if (v == null || !Number.isFinite(v)) {
      unknownCount += 1;
      continue;
    }
    inflowDec = inflowDec.plus(decimal(v).abs());
  }

  let outflowDec = decimal(0);
  for (const v of input.operationalOutflowsBeforeDebtService) {
    if (v == null || !Number.isFinite(v)) {
      unknownCount += 1;
      continue;
    }
    outflowDec = outflowDec.plus(decimal(v).abs());
  }

  const cfadsDec = inflowDec.minus(outflowDec);

  let principalDec = decimal(0);
  let interestDec = decimal(0);
  let taxDec = decimal(0);
  let totalServiceDec = decimal(0);

  for (const inst of input.installments) {
    const amt = decimal(inst.amount ?? 0).abs();
    const p = decimal(inst.principalComponent ?? 0).abs();
    const i = decimal(inst.interestComponent ?? 0).abs();
    const t = decimal(inst.taxComponentBsmvKkdf ?? 0).abs();
    const partsSum = p.plus(i).plus(t);

    if (partsSum.gt(0)) {
      principalDec = principalDec.plus(p);
      interestDec = interestDec.plus(i);
      taxDec = taxDec.plus(t);
      // Eğer taksit toplam tutarı bileşen toplamından büyükse farkı anaparaya ekle ki borç servisi eksik kalmasın
      if (amt.gt(partsSum)) {
        principalDec = principalDec.plus(amt.minus(partsSum));
        totalServiceDec = totalServiceDec.plus(amt);
      } else {
        totalServiceDec = totalServiceDec.plus(partsSum);
      }
    } else if (amt.gt(0)) {
      principalDec = principalDec.plus(amt);
      totalServiceDec = totalServiceDec.plus(amt);
    }
  }

  const dscr: number | null = totalServiceDec.lte(0)
    ? null
    : Number(cfadsDec.div(totalServiceDec).toFixed(4));

  return {
    horizon: input.horizon,
    label: input.label,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency,
    operationalInflows: money(inflowDec.toString()),
    operationalOutflowsBeforeDebtService: money(outflowDec.toString()),
    cfads: money(cfadsDec.toString()),
    principalComponent: money(principalDec.toString()),
    interestComponent: money(interestDec.toString()),
    taxComponentBsmvKkdf: money(taxDec.toString()),
    totalDebtService: money(totalServiceDec.toString()),
    dscr,
    confidence: unknownCount > 0 ? "partial_confidence" : "full",
    unknownComponentCount: unknownCount,
  };
}

/**
 * Tek bir kovenant eşiğini %10 erken uyarı tamponu (`warning`) ve ihlal (`breached`) kurallarıyla değerlendirir.
 */
export function evaluateCovenantThreshold(input: {
  comparison: ">=" | "<=" | ">" | "<" | "=";
  thresholdValue: number;
  measuredValue: number | null;
  status?: string;
  covenantType?: string;
  netDebt?: number | null;
  managementEbitda?: number | null;
}): {
  state: CovenantEarlyWarningState;
  headroomPct: number | null;
  explanation: string;
} {
  if (input.status === "waived") {
    return {
      state: "waived",
      headroomPct: null,
      explanation: "Kovenant banka tarafından muaf tutuldu (waived).",
    };
  }

  const thresholdDec = decimal(input.thresholdValue);

  // Özel durum: Net Borç / EBITDA üst sınır kovenantında EBITDA <= 0 ve Net Borç > 0 ise
  if (
    input.measuredValue === null &&
    (input.covenantType === "net_debt_to_ebitda" ||
      input.covenantType === "max_net_debt_to_ebitda" ||
      input.covenantType === "leverage") &&
    input.netDebt != null &&
    input.netDebt > 0 &&
    input.managementEbitda != null &&
    input.managementEbitda <= 0
  ) {
    return {
      state: "breached",
      headroomPct: -100,
      explanation: "Yönetim EBITDA ≤ 0 iken pozitif net borç mevcut; kaldıraç kovenantı ihlal edildi.",
    };
  }

  if (input.measuredValue === null || !Number.isFinite(input.measuredValue)) {
    return {
      state: "not_tested",
      headroomPct: null,
      explanation: "Ölçüm metriği henüz hesaplanamadı (veri veya payda eksik).",
    };
  }

  const actualDec = decimal(input.measuredValue);

  if (input.comparison === ">=" || input.comparison === ">") {
    const isBreached =
      input.comparison === ">=" ? actualDec.lt(thresholdDec) : actualDec.lte(thresholdDec);
    const headroomPct = thresholdDec.eq(0)
      ? null
      : Number(actualDec.minus(thresholdDec).div(thresholdDec.abs()).times(100).toFixed(2));

    if (isBreached) {
      return {
        state: "breached",
        headroomPct,
        explanation: `Ölçülen değer (${actualDec.toFixed(2)}), alt sınır eşiğinin (${thresholdDec.toFixed(2)}) altında.`,
      };
    }

    // %10 erken uyarı tamponu: actual <= threshold * 1.10
    const warnLimit = thresholdDec.times("1.10");
    if (actualDec.lte(warnLimit)) {
      return {
        state: "warning",
        headroomPct,
        explanation: `Ölçülen değer (${actualDec.toFixed(2)}), alt sınır eşiğine (${thresholdDec.toFixed(2)}) %10'dan daha yakın (%${headroomPct ?? 0} tampon).`,
      };
    }

    return {
      state: "compliant",
      headroomPct,
      explanation: `Uyumlu (eşik üzerinde %${headroomPct ?? 0} güvenli tampon).`,
    };
  }

  if (input.comparison === "<=" || input.comparison === "<") {
    const isBreached =
      input.comparison === "<=" ? actualDec.gt(thresholdDec) : actualDec.gte(thresholdDec);
    const headroomPct = thresholdDec.eq(0)
      ? null
      : Number(thresholdDec.minus(actualDec).div(thresholdDec.abs()).times(100).toFixed(2));

    if (isBreached) {
      return {
        state: "breached",
        headroomPct,
        explanation: `Ölçülen değer (${actualDec.toFixed(2)}), üst sınır eşiğini (${thresholdDec.toFixed(2)}) aştı.`,
      };
    }

    // %10 erken uyarı tamponu: actual >= threshold * 0.90
    const warnLimit = thresholdDec.times("0.90");
    if (actualDec.gte(warnLimit)) {
      return {
        state: "warning",
        headroomPct,
        explanation: `Ölçülen değer (${actualDec.toFixed(2)}), üst sınır eşiğine (${thresholdDec.toFixed(2)}) %10'dan daha yakın (%${headroomPct ?? 0} tampon).`,
      };
    }

    return {
      state: "compliant",
      headroomPct,
      explanation: `Uyumlu (eşik altında %${headroomPct ?? 0} güvenli tampon).`,
    };
  }

  // comparison === "="
  const equal = actualDec.eq(thresholdDec);
  return {
    state: equal ? "compliant" : "breached",
    headroomPct: equal ? 0 : -100,
    explanation: equal ? "Eşitlik kovenantı sağlandı." : "Eşitlik kovenantı sağlanmadı.",
  };
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Veritabanından Nakit DSCR (Son 3 Ay, Gelecek 3 Ay, Gelecek 12 Ay), CFADS Köprüsü,
 * Faz 52 Yönetim EBITDA'sı ve Kovenant Erken Uyarı Radarını yükler.
 */
export async function loadCovenantAndDscrRadar(
  client: Queryable,
  options: {
    asOfDate?: string;
    currency?: string;
  } = {},
): Promise<CovenantAndDscrRadar> {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const currency = (options.currency ?? "TRY").trim().toUpperCase();

  const trail3Start = addDaysISO(asOfDate, -90);
  const fwd3End = addDaysISO(asOfDate, 90);
  const fwd12End = addDaysISO(asOfDate, 365);

  // 1. Kullanılabilir nakit (FIN-03 uyumlu)
  const posRes = await client
    .query<{
      available_now: string | null;
      unknown_opening_count: number | string;
    }>(
      `select available_now, unknown_opening_count
         from public.treasury_position_summary
        where currency = $1`,
      [currency],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return client
          .query<{
            available_now: string | null;
            unknown_opening_count: number | string;
          }>(
            `select available_now, 0::int as unknown_opening_count
               from public.treasury_position_summary
              where currency = $1`,
            [currency],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) {
              return { rows: [], rowCount: 0 };
            }
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) {
        return { rows: [], rowCount: 0 };
      }
      throw err;
    });
  const posRow = posRes.rows[0];
  const unknownOpeningCount = posRes.rowCount === 0 ? 0 : Number(posRow?.unknown_opening_count ?? 0);
  const availableCash: number | null =
    posRes.rowCount === 0
      ? 0
      : unknownOpeningCount > 0
        ? null
        : moneyOrNull(posRow?.available_now) ?? 0;

  // 2. Kalan kredi anapara bakiyesi + kullanılan rotatif kredi limiti
  const [loanRemRes, facDrawnRes] = await Promise.all([
    client
      .query<{ rem_principal: string }>(
        `select
           coalesce(sum(coalesce(li.principal_component, li.amount)), 0)::numeric(14,2) as rem_principal
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         where l.archived_at is null
           and l.status = 'active'
           and l.currency = $1
           and li.status in ('planned', 'unpaid', 'partial', 'late')`,
        [currency],
      )
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "42703") {
          if (currency !== "TRY") {
            return { rows: [{ rem_principal: "0" }], rowCount: 1 };
          }
          return client
            .query<{ rem_principal: string }>(
              `select
                 coalesce(sum(li.amount), 0)::numeric(14,2) as rem_principal
               from public.loan_installments li
               join public.loans l on l.id = li.loan_id
               where l.archived_at is null
                 and l.status = 'active'
                 and li.status in ('planned', 'unpaid', 'partial', 'late')`,
            )
            .catch((e2: unknown) => {
              if (isMissingSchemaError(e2)) {
                return { rows: [{ rem_principal: "0" }], rowCount: 1 };
              }
              throw e2;
            });
        }
        if (isMissingSchemaError(err)) {
          return { rows: [{ rem_principal: "0" }], rowCount: 1 };
        }
        throw err;
      }),
    client
      .query<{ drawn: string }>(
        `select
           coalesce(sum(drawn_amount), 0)::numeric(14,2) as drawn
         from public.credit_facility_utilization
         where status = 'active'
           and currency = $1`,
        [currency],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) {
          return { rows: [{ drawn: "0" }], rowCount: 1 };
        }
        throw err;
      }),
  ]);

  const totalLoanPrincipalRemaining = moneyOrNull(loanRemRes.rows[0]?.rem_principal) ?? 0;
  const totalFacilityDrawn = moneyOrNull(facDrawnRes.rows[0]?.drawn) ?? 0;
  const totalGrossDebtDec = decimal(totalLoanPrincipalRemaining).plus(decimal(totalFacilityDrawn));
  const netDebt: number | null =
    availableCash === null
      ? null
      : money(totalGrossDebtDec.minus(decimal(availableCash)).toString());

  // 3. Faz 52 Yönetim EBITDA'sı (`management_income_statement_v`)
  let managementEbitda: number | null = null;
  let ebitdaResolvedDirectly = false;
  const isRes = await client
    .query<{
      section_code: string;
      account_code: string;
      signed_amount: string;
    }>(
      `select section_code, account_code, signed_amount::text
         from public.management_income_statement_v`,
    )
    .catch(async (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        const directRes = await client
          .query<{ management_ebitda_try: string | null }>(
            `select management_ebitda_try::text
               from public.management_income_statement_v
              limit 1`,
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) {
              return { rows: [], rowCount: 0 };
            }
            throw e2;
          });
        if ((directRes.rowCount ?? 0) > 0 && directRes.rows[0]?.management_ebitda_try != null) {
          managementEbitda = moneyOrNull(directRes.rows[0].management_ebitda_try);
          ebitdaResolvedDirectly = true;
        }
        return { rows: [], rowCount: 0 };
      }
      if (isMissingSchemaError(err)) {
        return { rows: [], rowCount: 0 };
      }
      throw err;
    });

  if (!ebitdaResolvedDirectly && (isRes.rowCount ?? 0) > 0) {
    let opProfitDec = decimal(0);
    let depDec = decimal(0);
    for (const r of isRes.rows) {
      const signed = decimal(r.signed_amount ?? 0);
      if (
        r.section_code === "GROSS_SALES" ||
        r.section_code === "SALES_DEDUCTIONS" ||
        r.section_code === "COST_OF_SALES" ||
        r.section_code === "OPERATING_EXPENSES"
      ) {
        opProfitDec = opProfitDec.plus(signed);
      }
      if (r.account_code === "770") {
        // 770 signed_amount negatif giderdir; amortisman katkı büyüklüğü için 257'yi de kontrol et
      }
    }
    const dep257Res = await client
      .query<{ dep_credit: string }>(
        `select coalesce(sum(credit_total - debit_total), 0)::numeric(14,2) as dep_credit
           from public.management_trial_balance_v
          where account_code = '257'`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) {
          return { rows: [{ dep_credit: "0" }], rowCount: 1 };
        }
        throw err;
      });
    depDec = decimal(dep257Res.rows[0]?.dep_credit ?? 0);
    if (depDec.lt(0)) depDec = decimal(0);
    managementEbitda = money(opProfitDec.plus(depDec).toString());
  }

  const netDebtToEbitda: number | null =
    netDebt === null || managementEbitda === null || managementEbitda <= 0
      ? null
      : Number(decimal(netDebt).div(decimal(managementEbitda)).toFixed(4));

  // 4. Son 3 ay gerçekleşen banka nakit akışı (borç servisi öncesi) ve gerçekleşen/vadesi geçen taksitler
  const [trailBankRes, allInstallmentsRes, fwdMonthsRes] = await Promise.all([
    client
      .query<{
        direction: string;
        matched_entity_table: string | null;
        total_amt: string;
      }>(
        `select
           bt.direction,
           bt.matched_entity_table,
           coalesce(sum(abs(bt.amount)), 0)::numeric(14,2) as total_amt
         from public.bank_transactions bt
         where bt.currency = $1
           and bt.status <> 'ignored'
           and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
           and bt.txn_date >= $2::date
           and bt.txn_date <= $3::date
         group by bt.direction, bt.matched_entity_table`,
        [currency, trail3Start, asOfDate],
      )
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "42703") {
          return client
            .query<{
              direction: string;
              matched_entity_table: string | null;
              total_amt: string;
            }>(
              `select
                 case when bt.amount >= 0 then 'inflow' else 'outflow' end as direction,
                 bt.matched_entity_table,
                 coalesce(sum(abs(bt.amount)), 0)::numeric(14,2) as total_amt
               from public.bank_transactions bt
               join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
               join public.cash_accounts ca on ca.id = ba.cash_account_id
               where ca.currency = $1
                 and bt.status <> 'ignored'
                 and bt.txn_date >= $2::date
                 and bt.txn_date <= $3::date
               group by 1, bt.matched_entity_table`,
              [currency, trail3Start, asOfDate],
            )
            .catch((e2: unknown) => {
              if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
              throw e2;
            });
        }
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    client
      .query<{
        due_date: string;
        amount: string;
        principal_component: string | null;
        interest_component: string | null;
        tax_component: string | null;
        status: string;
      }>(
        `select
           to_char(li.due_date, 'YYYY-MM-DD') as due_date,
           li.amount::text,
           li.principal_component::text,
           li.interest_component::text,
           li.tax_component::text,
           li.status
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         where l.archived_at is null
           and l.currency = $1
           and li.status <> 'cancelled'
           and li.due_date >= $2::date
           and li.due_date <= $3::date
         order by li.due_date, li.id`,
        [currency, trail3Start, fwd12End],
      )
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "42703") {
          if (currency !== "TRY") return { rows: [], rowCount: 0 };
          return client
            .query<{
              due_date: string;
              amount: string;
              principal_component: string | null;
              interest_component: string | null;
              tax_component: string | null;
              status: string;
            }>(
              `select
                 to_char(li.due_date, 'YYYY-MM-DD') as due_date,
                 li.amount::text,
                 null::text as principal_component,
                 null::text as interest_component,
                 null::text as tax_component,
                 li.status
               from public.loan_installments li
               join public.loans l on l.id = li.loan_id
               where l.archived_at is null
                 and li.status <> 'cancelled'
                 and li.due_date >= $1::date
                 and li.due_date <= $2::date
               order by li.due_date, li.id`,
              [trail3Start, fwd12End],
            )
            .catch((e2: unknown) => {
              if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
              throw e2;
            });
        }
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    client
      .query<{
        month_start: string;
        income: string | null;
        expense: string | null;
      }>(
        `select
           to_char(month_start, 'YYYY-MM-DD') as month_start,
           projected_income::text as income,
           projected_expense::text as expense
         from public.cashflow_months
         where month_start >= date_trunc('month', $1::date)::date
           and month_start <= date_trunc('month', $2::date)::date
         order by month_start`,
        [asOfDate, fwd12End],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  let trailInflowDec = decimal(0);
  let trailOutflowBeforeDebtDec = decimal(0);
  for (const r of trailBankRes.rows) {
    const amt = decimal(r.total_amt ?? 0);
    if (r.direction === "inflow") {
      trailInflowDec = trailInflowDec.plus(amt);
    } else if (r.matched_entity_table !== "loan_installments") {
      trailOutflowBeforeDebtDec = trailOutflowBeforeDebtDec.plus(amt);
    }
  }

  const mapInst = (r: {
    amount: string;
    principal_component: string | null;
    interest_component: string | null;
    tax_component: string | null;
  }) => ({
    amount: moneyOrNull(r.amount) ?? 0,
    principalComponent: moneyOrNull(r.principal_component),
    interestComponent: moneyOrNull(r.interest_component),
    taxComponentBsmvKkdf: moneyOrNull(r.tax_component),
  });

  const trailInst = allInstallmentsRes.rows
    .filter((r) => r.due_date >= trail3Start && r.due_date <= asOfDate)
    .map(mapInst);
  const fwd3Inst = allInstallmentsRes.rows
    .filter((r) => r.due_date > asOfDate && r.due_date <= fwd3End)
    .map(mapInst);
  const fwd12Inst = allInstallmentsRes.rows
    .filter((r) => r.due_date > asOfDate && r.due_date <= fwd12End)
    .map(mapInst);

  const fwd3Months = fwdMonthsRes.rows.slice(0, 3);
  const fwd12Months = fwdMonthsRes.rows.slice(0, 12);

  // Eğer cashflow_months boşsa fatura/planlı ödemelerden ileri akışları topla
  let fwd3Inflows: Array<number | null> = fwd3Months.map((m) => moneyOrNull(m.income));
  let fwd3Outflows: Array<number | null> = fwd3Months.map((m) => moneyOrNull(m.expense));
  let fwd12Inflows: Array<number | null> = fwd12Months.map((m) => moneyOrNull(m.income));
  let fwd12Outflows: Array<number | null> = fwd12Months.map((m) => moneyOrNull(m.expense));

  if (fwdMonthsRes.rowCount === 0) {
    const opFlowRes = await client
      .query<{
        in3: string;
        out3: string;
        in12: string;
        out12: string;
      }>(
        `select
           coalesce((
             select sum(v.gross_amount - coalesce(v.allocated_amount, 0))
               from public.invoices v
              where v.direction = 'sales'
                and v.status in ('open', 'partial')
                and v.bad_debt_at is null
                and v.currency = $1
                and v.due_date > $2::date and v.due_date <= $3::date
           ), 0)::numeric(14,2) as in3,
           coalesce((
             select sum(v.gross_amount - coalesce(v.allocated_amount, 0))
               from public.invoices v
              where v.direction = 'purchase'
                and v.status in ('open', 'partial')
                and v.currency = $1
                and v.due_date > $2::date and v.due_date <= $3::date
           ), 0)::numeric(14,2) as out3,
           coalesce((
             select sum(v.gross_amount - coalesce(v.allocated_amount, 0))
               from public.invoices v
              where v.direction = 'sales'
                and v.status in ('open', 'partial')
                and v.bad_debt_at is null
                and v.currency = $1
                and v.due_date > $2::date and v.due_date <= $4::date
           ), 0)::numeric(14,2) as in12,
           coalesce((
             select sum(v.gross_amount - coalesce(v.allocated_amount, 0))
               from public.invoices v
              where v.direction = 'purchase'
                and v.status in ('open', 'partial')
                and v.currency = $1
                and v.due_date > $2::date and v.due_date <= $4::date
           ), 0)::numeric(14,2) as out12`,
        [currency, asOfDate, fwd3End, fwd12End],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) {
          return { rows: [{ in3: "0", out3: "0", in12: "0", out12: "0" }], rowCount: 1 };
        }
        throw err;
      });
    const opRow = opFlowRes.rows[0];
    fwd3Inflows = [moneyOrNull(opRow?.in3) ?? 0];
    fwd3Outflows = [moneyOrNull(opRow?.out3) ?? 0];
    fwd12Inflows = [moneyOrNull(opRow?.in12) ?? 0];
    fwd12Outflows = [moneyOrNull(opRow?.out12) ?? 0];
  }

  const trailing3m = computeCashDscrWindow({
    horizon: "trailing_3m",
    label: "Son 3 Ay (Gerçekleşen)",
    periodStart: trail3Start,
    periodEnd: asOfDate,
    currency,
    operationalInflows: [money(trailInflowDec.toString())],
    operationalOutflowsBeforeDebtService: [money(trailOutflowBeforeDebtDec.toString())],
    installments: trailInst,
    extraUnknownCount: unknownOpeningCount,
  });

  const forward3m = computeCashDscrWindow({
    horizon: "forward_3m",
    label: "Gelecek 3 Ay (Projeksiyon)",
    periodStart: asOfDate,
    periodEnd: fwd3End,
    currency,
    operationalInflows: fwd3Inflows,
    operationalOutflowsBeforeDebtService: fwd3Outflows,
    installments: fwd3Inst,
    extraUnknownCount: unknownOpeningCount,
  });

  const forward12m = computeCashDscrWindow({
    horizon: "forward_12m",
    label: "Gelecek 12 Ay (Projeksiyon)",
    periodStart: asOfDate,
    periodEnd: fwd12End,
    currency,
    operationalInflows: fwd12Inflows,
    operationalOutflowsBeforeDebtService: fwd12Outflows,
    installments: fwd12Inst,
    extraUnknownCount: unknownOpeningCount,
  });

  // 5. Kovenant kayıtlarını oku ve canlı metriklerle değerlendir
  const covRes = await client
    .query<{
      id: string;
      covenant_type: string;
      description: string;
      comparison: ">=" | "<=" | ">" | "<" | "=";
      threshold_value: string;
      status: string;
      last_test_value: string | null;
      subject_name: string | null;
    }>(
      `select
         v.id::text,
         v.covenant_type,
         v.description,
         v.comparison,
         v.threshold_value::text,
         v.status,
         v.last_test_value::text,
         coalesce(l.name, f.name, 'Genel Kredi Kovenantı') as subject_name
       from public.covenant_records v
       left join public.loans l on l.id = v.loan_id
       left join public.credit_facilities f on f.id = v.facility_id
       where v.status in ('active', 'waived')
       order by v.status, v.covenant_type, v.created_at desc`,
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const bestLiveDscr = forward12m.dscr ?? forward3m.dscr ?? trailing3m.dscr;

  const covenants: CovenantEvaluationItem[] = covRes.rows.map((row) => {
    const thresholdValue = rateOrNull(row.threshold_value) ?? moneyOrNull(row.threshold_value) ?? 0;
    const storedTestVal = rateOrNull(row.last_test_value) ?? moneyOrNull(row.last_test_value);

    let measuredValue: number | null = storedTestVal;
    let metricSource = "Kaydedilmiş son test değeri";

    const ct = row.covenant_type.toLowerCase();
    if (ct === "dscr" || ct === "min_dscr") {
      if (bestLiveDscr !== null) {
        measuredValue = bestLiveDscr;
        metricSource = "Canlı Nakit DSCR (CFADS / Borç Servisi)";
      }
    } else if (
      ct === "net_debt_to_ebitda" ||
      ct === "max_net_debt_to_ebitda" ||
      ct === "leverage"
    ) {
      if (netDebtToEbitda !== null) {
        measuredValue = netDebtToEbitda;
        metricSource = "Canlı Net Borç / Yönetim EBITDA (Faz 52)";
      } else if (netDebt != null && managementEbitda != null && managementEbitda <= 0) {
        measuredValue = null;
        metricSource = "Canlı Net Borç / Yönetim EBITDA (Faz 52)";
      }
    } else if (ct === "min_cash_balance" || ct === "liquidity") {
      if (availableCash !== null) {
        measuredValue = availableCash;
        metricSource = "Canlı Hazine Kullanılabilir Nakit";
      }
    }

    const evalRes = evaluateCovenantThreshold({
      comparison: row.comparison,
      thresholdValue,
      measuredValue,
      status: row.status,
      covenantType: ct,
      netDebt,
      managementEbitda,
    });

    return {
      covenantId: row.id,
      subjectName: row.subject_name ?? "Kredi Sözleşmesi",
      covenantType: row.covenant_type,
      description: row.description,
      comparison: row.comparison,
      thresholdValue,
      measuredValue,
      state: evalRes.state,
      headroomPct: evalRes.headroomPct,
      explanation: evalRes.explanation,
      metricSource,
    };
  });

  const breachedCount = covenants.filter((c) => c.state === "breached").length;
  const warningCount = covenants.filter((c) => c.state === "warning").length;
  const compliantCount = covenants.filter((c) => c.state === "compliant").length;

  return {
    asOfDate,
    currency,
    availableCash,
    totalLoanPrincipalRemaining,
    totalFacilityDrawn,
    netDebt,
    managementEbitda,
    netDebtToEbitda,
    dscrWindows: {
      trailing3m,
      forward3m,
      forward12m,
    },
    covenants,
    breachedCount,
    warningCount,
    compliantCount,
  };
}