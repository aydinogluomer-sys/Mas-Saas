/**
 * Faz 55 (F2) — Gece Nakit Değişim Atfı (Overnight Cash & Gap7 Delta Attribution).
 *
 * CFO'nun her sabah ilk sorduğu "Dünden bugüne kasam ve 7 günlük likidite açığım neden değişti?"
 * sorusunu 5 deterministik bileşende kuruşu kuruşuna yanıtlar:
 *   1. Gerçekleşen banka tahsilatları (`realizedBankInflows`, +)
 *   2. Gerçekleşen banka ödemeleri / masrafları (`realizedBankOutflows`, -)
 *   3. Yeni eklenen veya vadesi 7 gün içine giren ödemeler / çekler / faturalar / taksitler (`newlyEntered7dObligations`)
 *   4. Vadesi kayan veya kırılan tahsilat sözleri & geciken alacaklar (`slippedPromisesAndOverdueAr`)
 *   5. Kur değerleme / açılış düzeltme etkisi (`fxAndAdjustmentImpact`)
 *
 * Kuruş özdeşliği (Cash Delta Identity):
 *   `previousAvailableCash + realizedBankInflows + realizedBankOutflows + fxAndAdjustmentImpact === currentAvailableCash`
 *   (`deltaAvailableCash === realizedBankInflows + realizedBankOutflows + fxAndAdjustmentImpact`)
 *
 * Bu modül `@/lib/ai` veya `@/lib/env` import etmez.
 */

import type { Pool, PoolClient } from "pg";
import { decimal, money, moneyOrNull } from "@/lib/money";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type OvernightDeltaCategory =
  | "realized_bank_inflows"
  | "realized_bank_outflows"
  | "newly_entered_7d_obligations"
  | "slipped_ptp_and_overdue_ar"
  | "fx_and_adjustment_impact";

export const DELTA_CATEGORY_LABELS: Record<OvernightDeltaCategory, string> = {
  realized_bank_inflows: "① Gerçekleşen Banka Tahsilatı (+)",
  realized_bank_outflows: "② Gerçekleşen Banka Ödemesi / Masrafı (-)",
  newly_entered_7d_obligations: "③ 7G Pencereye Yeni Giren Yükümlülük",
  slipped_ptp_and_overdue_ar: "④ Vadesi Kayan Söz / Geciken Alacak",
  fx_and_adjustment_impact: "⑤ Kur Değerleme / Bakiye Düzeltme",
};

/** `42P01` (`undefined_table`) veya `42703` (`undefined_column`) şema geçiş koruması. */
export function isMissingSchemaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

export interface OvernightDeltaComponentItem {
  category: OvernightDeltaCategory;
  label: string;
  counterpartyName: string | null;
  amountSigned: number;
  eventDate: string;
  sourceTable: string | null;
  sourceId: string | null;
}

export interface OvernightDeltaAttribution {
  fromDateISO: string;
  toDateISO: string;
  currency: string;
  hasPriorSnapshot: boolean;
  hasVerifiedBankFeed: boolean;
  hasFxSnapshots: boolean;
  identityUnmeasurable: boolean;
  previousAvailableCash: number | null;
  currentAvailableCash: number | null;
  deltaAvailableCash: number | null;
  previousLiquidityGap7: number | null;
  currentLiquidityGap7: number | null;
  deltaLiquidityGap7: number | null;
  /** ① Gerçekleşen banka tahsilatları (>= 0; doğrulanmış ekstre yoksa null) */
  realizedBankInflows: number | null;
  /** ② Gerçekleşen banka ödemeleri ve masrafları (<= 0; doğrulanmış ekstre yoksa null) */
  realizedBankOutflows: number | null;
  /** ③ Yeni eklenen veya vadesi 7 gün içine giren yükümlülükler (>= 0, Gap7 artırıcı) */
  newlyEntered7dObligations: number;
  /** ④ Vadesi kayan / kırılan tahsilat sözleri ve geciken alacaklar (>= 0, beklenen giriş kaybı) */
  slippedPromisesAndOverdueAr: number;
  /** ⑤ Kur değerleme / açılış düzeltme etkisi (işaretli; FIN-03 veya ekstre eksikse null) */
  fxAndAdjustmentImpact: number | null;
  /** Özdeşlik kontrolü: deltaAvailableCash === realizedBankInflows + realizedBankOutflows + fxAndAdjustmentImpact */
  cashDeltaIdentityBalanced: boolean;
  cashDeltaIdentityDiff: number;
  items: OvernightDeltaComponentItem[];
}

export type OvernightDeltaBridge = OvernightDeltaAttribution;

export interface BuildOvernightDeltaInput {
  fromDateISO: string;
  toDateISO: string;
  currency?: string;
  hasPriorSnapshot?: boolean;
  hasVerifiedBankFeed?: boolean;
  hasFxSnapshots?: boolean;
  previousAvailableCash: number | null;
  currentAvailableCash: number | null;
  previousLiquidityGap7: number | null;
  currentLiquidityGap7: number | null;
  bankInflows: ReadonlyArray<{
    id?: string | null;
    txnDate: string;
    amount: number;
    description?: string | null;
    counterpartyName?: string | null;
  }>;
  bankOutflows: ReadonlyArray<{
    id?: string | null;
    txnDate: string;
    amount: number; // positive magnitude or negative signed; normalized to negative
    description?: string | null;
    counterpartyName?: string | null;
  }>;
  newlyEntered7dObligations: ReadonlyArray<{
    sourceTable: string;
    sourceId?: string | null;
    dueDate: string;
    amount: number;
    label: string;
    counterpartyName?: string | null;
  }>;
  slippedPromisesAndOverdueAr: ReadonlyArray<{
    sourceTable: string;
    sourceId?: string | null;
    dueDate: string;
    amount: number;
    label: string;
    counterpartyName?: string | null;
  }>;
  explicitFxImpact?: number | null;
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function maskCounterpartyLabel(name: string | null | undefined): string {
  if (!name || !name.trim()) return "Muhatap";
  const trimmed = name.trim();
  if (trimmed.length <= 2) return `${trimmed[0]}***`;
  return `${trimmed.slice(0, 2)}***`;
}

/**
 * Saf (pure) gece nakit ve 7 günlük açık değişim atfı hesaplayıcısı.
 * Tüm toplamlar `Big` (`decimal`) ile kuruş hassasiyetinde yürütülür.
 */
export function buildOvernightDeltaAttribution(
  input: BuildOvernightDeltaInput,
): OvernightDeltaAttribution {
  const currency = (input.currency ?? "TRY").trim().toUpperCase();
  const items: OvernightDeltaComponentItem[] = [];

  let inflowsDec = decimal(0);
  for (const row of input.bankInflows) {
    const mag = decimal(row.amount ?? 0).abs();
    if (mag.lte(0)) continue;
    inflowsDec = inflowsDec.plus(mag);
    items.push({
      category: "realized_bank_inflows",
      label: row.description?.trim() || "Banka Tahsilatı",
      counterpartyName: row.counterpartyName ?? null,
      amountSigned: money(mag.toString()),
      eventDate: row.txnDate,
      sourceTable: "bank_transactions",
      sourceId: row.id ?? null,
    });
  }

  let outflowsDec = decimal(0); // negative or zero
  for (const row of input.bankOutflows) {
    const mag = decimal(row.amount ?? 0).abs();
    if (mag.lte(0)) continue;
    const signed = mag.times(-1);
    outflowsDec = outflowsDec.plus(signed);
    items.push({
      category: "realized_bank_outflows",
      label: row.description?.trim() || "Banka Ödemesi / Masrafı",
      counterpartyName: row.counterpartyName ?? null,
      amountSigned: money(signed.toString()),
      eventDate: row.txnDate,
      sourceTable: "bank_transactions",
      sourceId: row.id ?? null,
    });
  }

  let newObligationsDec = decimal(0);
  for (const ob of input.newlyEntered7dObligations) {
    const mag = decimal(ob.amount ?? 0).abs();
    if (mag.lte(0)) continue;
    newObligationsDec = newObligationsDec.plus(mag);
    items.push({
      category: "newly_entered_7d_obligations",
      label: ob.label,
      counterpartyName: ob.counterpartyName ?? null,
      amountSigned: money(mag.toString()),
      eventDate: ob.dueDate,
      sourceTable: ob.sourceTable,
      sourceId: ob.sourceId ?? null,
    });
  }

  let slippedDec = decimal(0);
  for (const sl of input.slippedPromisesAndOverdueAr) {
    const mag = decimal(sl.amount ?? 0).abs();
    if (mag.lte(0)) continue;
    slippedDec = slippedDec.plus(mag);
    items.push({
      category: "slipped_ptp_and_overdue_ar",
      label: sl.label,
      counterpartyName: sl.counterpartyName ?? null,
      amountSigned: money(mag.times(-1).toString()),
      eventDate: sl.dueDate,
      sourceTable: sl.sourceTable,
      sourceId: sl.sourceId ?? null,
    });
  }

  const hasVerifiedBankFeed = input.hasVerifiedBankFeed ?? true;
  const hasFxSnapshots = input.hasFxSnapshots ?? true;
  const cashKnown =
    input.previousAvailableCash !== null && input.currentAvailableCash !== null;

  const realizedBankInflows: number | null =
    hasVerifiedBankFeed && cashKnown
      ? money(inflowsDec.toString())
      : hasVerifiedBankFeed && (input.bankInflows.length > 0 || input.bankOutflows.length > 0)
        ? money(inflowsDec.toString())
        : null;
  const realizedBankOutflows: number | null =
    hasVerifiedBankFeed && cashKnown
      ? money(outflowsDec.toString())
      : hasVerifiedBankFeed && (input.bankInflows.length > 0 || input.bankOutflows.length > 0)
        ? money(outflowsDec.toString())
        : null;
  const newlyEntered7dObligations = money(newObligationsDec.toString());
  const slippedPromisesAndOverdueAr = money(slippedDec.toString());

  const netBankFlowDec = inflowsDec.plus(outflowsDec);

  let deltaAvailableCash: number | null = null;
  let fxAndAdjustmentImpact: number | null = null;
  let fxAndAdjustmentDec: ReturnType<typeof decimal> | null = null;

  if (cashKnown) {
    const deltaCashDec = decimal(input.currentAvailableCash!).minus(decimal(input.previousAvailableCash!));
    deltaAvailableCash = money(deltaCashDec.toString());
    if (hasVerifiedBankFeed) {
      fxAndAdjustmentDec =
        input.explicitFxImpact != null
          ? decimal(input.explicitFxImpact)
          : deltaCashDec.minus(netBankFlowDec);
      fxAndAdjustmentImpact = money(fxAndAdjustmentDec.toString());
      if (!fxAndAdjustmentDec.eq(0)) {
        items.push({
          category: "fx_and_adjustment_impact",
          label: "Kur Değerleme ve Açılış/Bakiye Düzeltme Etkisi",
          counterpartyName: null,
          amountSigned: fxAndAdjustmentImpact,
          eventDate: input.toDateISO,
          sourceTable: null,
          sourceId: null,
        });
      }
    }
  }

  const deltaLiquidityGap7 =
    input.previousLiquidityGap7 !== null && input.currentLiquidityGap7 !== null
      ? money(decimal(input.currentLiquidityGap7).minus(decimal(input.previousLiquidityGap7)).toString())
      : null;

  const identityUnmeasurable = !cashKnown || !hasVerifiedBankFeed || fxAndAdjustmentDec === null;
  let cashDeltaIdentityDiff = 0;
  let cashDeltaIdentityBalanced = false;
  if (!identityUnmeasurable && deltaAvailableCash !== null && fxAndAdjustmentDec !== null) {
    const reconstructedDec = inflowsDec.plus(outflowsDec).plus(fxAndAdjustmentDec);
    const diffDec = reconstructedDec.minus(decimal(deltaAvailableCash));
    cashDeltaIdentityDiff = money(diffDec.toString());
    cashDeltaIdentityBalanced = diffDec.abs().lte(decimal("0.005"));
  }

  return {
    fromDateISO: input.fromDateISO,
    toDateISO: input.toDateISO,
    currency,
    hasPriorSnapshot: Boolean(input.hasPriorSnapshot),
    hasVerifiedBankFeed,
    hasFxSnapshots,
    identityUnmeasurable,
    previousAvailableCash: input.previousAvailableCash,
    currentAvailableCash: input.currentAvailableCash,
    deltaAvailableCash,
    previousLiquidityGap7: input.previousLiquidityGap7,
    currentLiquidityGap7: input.currentLiquidityGap7,
    deltaLiquidityGap7,
    realizedBankInflows,
    realizedBankOutflows,
    newlyEntered7dObligations,
    slippedPromisesAndOverdueAr,
    fxAndAdjustmentImpact,
    cashDeltaIdentityBalanced,
    cashDeltaIdentityDiff,
    items,
  };
}

/**
 * Veritabanından son brifing anlık görüntüsü (veya dün `todayISO - 1`) ile bugün arasındaki
 * 5 bileşenli Gece Nakit ve 7 Günlük Likidite Açığı Değişim Atfını yükler.
 */
function convertWithFxToTry(
  amount: number,
  rowCurrency: string | null | undefined,
  baseCurrency: string,
  fxRates?: Readonly<Record<string, number>>,
): { converted: number; fxNote: string | null } | null {
  const ccy = (rowCurrency ?? baseCurrency).trim().toUpperCase() || baseCurrency;
  if (ccy === baseCurrency) {
    return { converted: amount, fxNote: null };
  }
  if (!fxRates) return null;
  const rate = fxRates[ccy];
  if (rate == null || !(rate > 0)) return null;
  const converted = money(decimal(amount).times(decimal(rate)).toString());
  const rateFmt = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(rate);
  return { converted, fxNote: `[${ccy} × ${rateFmt}]` };
}

/**
 * Veritabanından son brifing anlık görüntüsü (veya dün `todayISO - 1`) ile bugün arasındaki
 * 5 bileşenli Gece Nakit ve 7 Günlük Likidite Açığı Değişim Atfını yükler.
 * `options.fxRates` verildiğinde (TCMB `fx_rate_snapshots`), TRY-dışı banka hareketleri ve
 * yükümlülükler güncel TCMB kuru üzerinden konsolide TL karşılığına çevrilir.
 */
export async function loadOvernightDeltaAttribution(
  client: Queryable,
  todayISO: string,
  options: {
    fromDateISO?: string;
    currency?: string;
    currentAvailableCash?: number | null;
    currentLiquidityGap7?: number | null;
    fxRates?: Readonly<Record<string, number>>;
  } = {},
): Promise<OvernightDeltaAttribution> {
  const currency = (options.currency ?? "TRY").trim().toUpperCase();
  const fxRates = options.fxRates;
  const multiCurrency = Boolean(fxRates && currency === "TRY");
  const defaultFromISO = addDaysISO(todayISO, -1);

  // 1. Son kaydedilmiş cfo_briefing raporunu kontrol et
  const prevRepRes = await client
    .query<{
      period_end: string;
      meta: {
        availableCash?: number | null;
        liquidityGap7?: number | null;
        consolidatedCashTry?: number | null;
        consolidatedGap7Try?: number | null;
      } | null;
    }>(
      `select
         to_char(period_end, 'YYYY-MM-DD') as period_end,
         meta
       from public.reports
       where report_type = 'cfo_briefing'
         and period_end < $1::date
       order by period_end desc, created_at desc
       limit 1`,
      [todayISO],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const prevRep = prevRepRes.rows[0] ?? null;
  const fromDateISO = options.fromDateISO ?? prevRep?.period_end ?? defaultFromISO;
  const hasPriorSnapshot = prevRep !== null;

  // 2. (fromDateISO, todayISO] aralığındaki gerçekleşen banka hareketleri (`own_transfer` ve `ignored` hariç)
  const bankRes = await client
    .query<{
      id: string;
      txn_date: string;
      amount: string;
      currency: string;
      description: string | null;
      counterparty_name: string | null;
    }>(
      `select
         bt.id::text,
         to_char(bt.txn_date, 'YYYY-MM-DD') as txn_date,
         bt.amount,
         bt.currency,
         bt.description,
         bt.counterparty_name_raw as counterparty_name
       from public.bank_transactions bt
       where ($4::boolean or bt.currency = $1)
         and bt.status <> 'ignored'
         and coalesce(bt.transaction_kind, 'standard') <> 'own_transfer'
         and bt.txn_date > $2::date
         and bt.txn_date <= $3::date
       order by bt.txn_date, bt.id`,
      [currency, fromDateISO, todayISO, multiCurrency],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return client
          .query<{
            id: string;
            txn_date: string;
            amount: string;
            currency: string;
            description: string | null;
            counterparty_name: string | null;
          }>(
            `select
               bt.id::text,
               to_char(bt.txn_date, 'YYYY-MM-DD') as txn_date,
               bt.amount,
               ca.currency,
               bt.description,
               null::text as counterparty_name
             from public.bank_transactions bt
             join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
             join public.cash_accounts ca on ca.id = ba.cash_account_id
             where ($4::boolean or ca.currency = $1)
               and bt.status <> 'ignored'
               and bt.txn_date > $2::date
               and bt.txn_date <= $3::date
             order by bt.txn_date, bt.id`,
            [currency, fromDateISO, todayISO, multiCurrency],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const bankInflows: Array<BuildOvernightDeltaInput["bankInflows"][number]> = [];
  const bankOutflows: Array<BuildOvernightDeltaInput["bankOutflows"][number]> = [];
  let netBankMovementsDec = decimal(0);

  for (const r of bankRes.rows) {
    const rawAmt = moneyOrNull(r.amount) ?? 0;
    if (rawAmt === 0) continue;
    const conv = convertWithFxToTry(rawAmt, r.currency, currency, fxRates);
    if (!conv) continue;
    const amt = conv.converted;
    if (amt === 0) continue;
    const desc = conv.fxNote
      ? `${r.description?.trim() || (amt > 0 ? "Banka Tahsilatı" : "Banka Ödemesi")} ${conv.fxNote}`
      : r.description;
    netBankMovementsDec = netBankMovementsDec.plus(decimal(amt));
    if (amt > 0) {
      bankInflows.push({
        id: r.id,
        txnDate: r.txn_date,
        amount: amt,
        description: desc,
        counterpartyName: r.counterparty_name,
      });
    } else {
      bankOutflows.push({
        id: r.id,
        txnDate: r.txn_date,
        amount: Math.abs(amt),
        description: desc,
        counterpartyName: r.counterparty_name,
      });
    }
  }

  // 3. Yeni 7 günlük pencereye giren yükümlülükler: due_date in (fromDateISO + 7d, todayISO + 7d]
  const prevHorizon7End = addDaysISO(fromDateISO, 7);
  const currHorizon7End = addDaysISO(todayISO, 7);

  const newlyEnteredRes = await client
    .query<{
      source_table: string;
      source_id: string;
      due_date: string;
      amount: string;
      currency: string;
      label: string;
      counterparty_name: string | null;
    }>(
      `select * from (
         select
           'payment_instances'::text as source_table,
           pi.id::text as source_id,
           to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
           greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)::numeric(14,2) as amount,
           pi.currency,
           coalesce(p.name, 'Planlı Ödeme') as label,
           pa.name as counterparty_name
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
         left join public.parties pa on pa.id = p.provider_party_id
         where pi.status in ('planned', 'unpaid', 'partial', 'late')
           and (p.id is null or (p.status = 'active' and p.archived_at is null))
           and coalesce(pi.direction, 'outflow') = 'outflow'
           and ($4::boolean or pi.currency = $1)
           and pi.due_date > $2::date
           and pi.due_date <= $3::date
           and pi.amount is not null

         union all

         select
           'invoices'::text as source_table,
           v.id::text as source_id,
           to_char(v.due_date, 'YYYY-MM-DD') as due_date,
           (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
           v.currency,
           ('Alış Faturası ' || v.invoice_no) as label,
           pa.name as counterparty_name
         from public.invoices v
         left join public.parties pa on pa.id = v.party_id
         where v.direction = 'purchase'
           and v.status in ('open', 'partial')
           and ($4::boolean or v.currency = $1)
           and v.due_date > $2::date
           and v.due_date <= $3::date
           and v.gross_amount > coalesce(v.allocated_amount, 0)
           and v.settled_by_check_id is null

         union all

         select
           'checks'::text as source_table,
           c.id::text as source_id,
           to_char(c.maturity_date, 'YYYY-MM-DD') as due_date,
           abs(c.amount)::numeric(14,2) as amount,
           c.currency,
           ('Çek/Senet Vadesi ' || coalesce(c.counterparty_label, '')) as label,
           coalesce(pe.name, c.counterparty_label) as counterparty_name
         from public.checks c
         left join public.parties pe on pe.id = c.payee_party_id
         where c.archived_at is null
           and c.direction = 'outflow'
           and c.status in ('planned', 'issued_to_vendor')
           and ($4::boolean or c.currency = $1)
           and c.maturity_date > $2::date
           and c.maturity_date <= $3::date
           and c.amount > 0

         union all

         select
           'loan_installments'::text as source_table,
           li.id::text as source_id,
           to_char(li.due_date, 'YYYY-MM-DD') as due_date,
           li.amount::numeric(14,2) as amount,
           l.currency,
           (coalesce(l.name, 'Kredi') || ' Taksit #' || coalesce(li.installment_no::text, '')) as label,
           pa.name as counterparty_name
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         left join public.parties pa on pa.id = l.lender_party_id
         where l.archived_at is null
           and li.status in ('planned', 'unpaid', 'partial', 'late')
           and ($4::boolean or l.currency = $1)
           and li.due_date > $2::date
           and li.due_date <= $3::date
           and li.amount > 0
       ) q
       order by due_date, source_table, source_id`,
      [currency, prevHorizon7End, currHorizon7End, multiCurrency],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        if (currency !== "TRY" && !multiCurrency) return { rows: [], rowCount: 0 };
        return client
          .query<{
            source_table: string;
            source_id: string;
            due_date: string;
            amount: string;
            currency: string;
            label: string;
            counterparty_name: string | null;
          }>(
            `select * from (
               select
                 'payment_instances'::text as source_table,
                 pi.id::text as source_id,
                 to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
                 greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)::numeric(14,2) as amount,
                 'TRY'::text as currency,
                 coalesce(p.name, 'Planlı Ödeme') as label,
                 pa.name as counterparty_name
               from public.payment_instances pi
               left join public.payments p on p.id = pi.payment_id
               left join public.parties pa on pa.id = p.provider_party_id
               where pi.status in ('planned', 'unpaid', 'partial', 'late')
                 and (p.id is null or (p.status = 'active' and p.archived_at is null))
                 and coalesce(pi.direction, 'outflow') = 'outflow'
                 and pi.due_date > $2::date
                 and pi.due_date <= $3::date
                 and pi.amount is not null

               union all

               select
                 'invoices'::text as source_table,
                 v.id::text as source_id,
                 to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                 (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
                 v.currency,
                 ('Alış Faturası ' || v.invoice_no) as label,
                 pa.name as counterparty_name
               from public.invoices v
               left join public.parties pa on pa.id = v.party_id
               where v.direction = 'purchase'
                 and v.status in ('open', 'partial')
                 and ($4::boolean or v.currency = $1)
                 and v.due_date > $2::date
                 and v.due_date <= $3::date
                 and v.gross_amount > coalesce(v.allocated_amount, 0)
             ) q
             order by due_date, source_table, source_id`,
            [currency, prevHorizon7End, currHorizon7End, multiCurrency],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  // 4. Vadesi kayan / kırılan tahsilat sözleri ve geciken alacaklar: [fromDateISO, todayISO)
  const slippedRes = await client
    .query<{
      source_table: string;
      source_id: string;
      due_date: string;
      amount: string;
      currency: string;
      label: string;
      counterparty_name: string | null;
    }>(
      `select * from (
         select
           'promise_to_pay'::text as source_table,
           pr.id::text as source_id,
           to_char(pr.promised_date, 'YYYY-MM-DD') as due_date,
           pr.promised_amount::numeric(14,2) as amount,
           pr.currency,
           'Vadesi Geçen / Kırılan Tahsilat Sözü'::text as label,
           pa.name as counterparty_name
         from public.promise_to_pay pr
         left join public.parties pa on pa.id = pr.party_id
         where pr.status in ('pending', 'broken')
           and ($4::boolean or pr.currency = $1)
           and pr.promised_date >= $2::date
           and pr.promised_date < $3::date
           and pr.promised_amount > 0

         union all

         select
           'invoices'::text as source_table,
           v.id::text as source_id,
           to_char(v.due_date, 'YYYY-MM-DD') as due_date,
           (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
           v.currency,
           ('Geciken Satış Faturası ' || v.invoice_no) as label,
           pa.name as counterparty_name
         from public.invoices v
         left join public.parties pa on pa.id = v.party_id
         where v.direction = 'sales'
           and v.status in ('open', 'partial')
           and v.bad_debt_at is null
           and ($4::boolean or v.currency = $1)
           and v.due_date >= $2::date
           and v.due_date < $3::date
           and v.gross_amount > coalesce(v.allocated_amount, 0)
       ) s
       order by due_date, source_table, source_id`,
      [currency, fromDateISO, todayISO, multiCurrency],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) {
        if (currency !== "TRY" && !multiCurrency && (err as { code?: string } | null)?.code === "42703") {
          return { rows: [], rowCount: 0 };
        }
        return client
          .query<{
            source_table: string;
            source_id: string;
            due_date: string;
            amount: string;
            currency: string;
            label: string;
            counterparty_name: string | null;
          }>(
            `select
               'invoices'::text as source_table,
               v.id::text as source_id,
               to_char(v.due_date, 'YYYY-MM-DD') as due_date,
               (v.gross_amount - coalesce(v.allocated_amount, 0))::numeric(14,2) as amount,
               v.currency,
               ('Geciken Satış Faturası ' || v.invoice_no) as label,
               pa.name as counterparty_name
             from public.invoices v
             left join public.parties pa on pa.id = v.party_id
             where v.direction = 'sales'
               and v.status in ('open', 'partial')
               and v.bad_debt_at is null
               and ($4::boolean or v.currency = $1)
               and v.due_date >= $2::date
               and v.due_date < $3::date
               and v.gross_amount > coalesce(v.allocated_amount, 0)
             order by due_date, source_id`,
            [currency, fromDateISO, todayISO, multiCurrency],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      throw err;
    });

  const feedMetaRes = await client
    .query<{
      bank_tx_count?: number;
      fx_count?: number;
      unknown_opening_n?: number;
      derived_cash?: string | null;
    }>(
      `select
         (select count(*)::int from public.bank_transactions where status <> 'ignored') as bank_tx_count,
         (select count(*)::int from public.fx_rate_snapshots where quote_currency = 'TRY' and rate > 0) as fx_count,
         (select count(*) filter (where opening_balance is null)::int
            from public.cash_accounts
           where is_active = true and archived_at is null) as unknown_opening_n,
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
                 and bt.txn_date <= $2::date
                 and coalesce(bt.currency, ca.currency) = ca.currency
            ) tx on true
           where ca.is_active = true and ca.archived_at is null and ca.currency = $1) as derived_cash`,
      [currency, todayISO],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [] as Array<Record<string, never>> };
      throw err;
    });

  const feedMeta = feedMetaRes.rows[0] as
    | {
        bank_tx_count?: number;
        fx_count?: number;
        unknown_opening_n?: number;
        derived_cash?: string | null;
      }
    | undefined;

  const hasVerifiedBankFeed =
    feedMeta && feedMeta.bank_tx_count !== undefined
      ? Number(feedMeta.bank_tx_count ?? 0) > 0
      : bankRes.rows.length > 0;
  const hasFxSnapshots =
    feedMeta && feedMeta.fx_count !== undefined
      ? Number(feedMeta.fx_count ?? 0) > 0
      : Boolean(fxRates && Object.keys(fxRates).some((k) => k !== "TRY"));

  const currentAvailableCash =
    options.currentAvailableCash !== undefined
      ? options.currentAvailableCash
      : feedMeta && Number(feedMeta.unknown_opening_n ?? 0) === 0
        ? moneyOrNull(feedMeta.derived_cash ?? null)
        : null;
  const currentLiquidityGap7 = options.currentLiquidityGap7 ?? null;

  const rawPrevCash = multiCurrency
    ? (prevRep?.meta?.consolidatedCashTry ?? prevRep?.meta?.availableCash)
    : prevRep?.meta?.availableCash;
  const previousAvailableCash: number | null =
    prevRep?.meta && rawPrevCash !== undefined
      ? moneyOrNull(rawPrevCash as number | string | null)
      : currentAvailableCash !== null && hasVerifiedBankFeed
        ? money(decimal(currentAvailableCash).minus(netBankMovementsDec).toString())
        : null;

  const rawPrevGap7 = multiCurrency
    ? (prevRep?.meta?.consolidatedGap7Try ?? prevRep?.meta?.liquidityGap7)
    : prevRep?.meta?.liquidityGap7;
  const previousLiquidityGap7: number | null =
    prevRep?.meta && rawPrevGap7 !== undefined
      ? moneyOrNull(rawPrevGap7 as number | string | null)
      : null;

  const newlyEnteredConverted: Array<BuildOvernightDeltaInput["newlyEntered7dObligations"][number]> = [];
  for (const r of newlyEnteredRes.rows) {
    const raw = moneyOrNull(r.amount) ?? 0;
    const conv = convertWithFxToTry(raw, r.currency, currency, fxRates);
    if (!conv || conv.converted === 0) continue;
    newlyEnteredConverted.push({
      sourceTable: r.source_table,
      sourceId: r.source_id,
      dueDate: r.due_date,
      amount: conv.converted,
      label: conv.fxNote ? `${r.label} ${conv.fxNote}` : r.label,
      counterpartyName: r.counterparty_name,
    });
  }

  const slippedConverted: Array<BuildOvernightDeltaInput["slippedPromisesAndOverdueAr"][number]> = [];
  for (const r of slippedRes.rows) {
    const raw = moneyOrNull(r.amount) ?? 0;
    const conv = convertWithFxToTry(raw, r.currency, currency, fxRates);
    if (!conv || conv.converted === 0) continue;
    slippedConverted.push({
      sourceTable: r.source_table,
      sourceId: r.source_id,
      dueDate: r.due_date,
      amount: conv.converted,
      label: conv.fxNote ? `${r.label} ${conv.fxNote}` : r.label,
      counterpartyName: r.counterparty_name,
    });
  }

  return buildOvernightDeltaAttribution({
    fromDateISO,
    toDateISO: todayISO,
    currency,
    hasPriorSnapshot,
    hasVerifiedBankFeed,
    hasFxSnapshots,
    previousAvailableCash,
    currentAvailableCash,
    previousLiquidityGap7,
    currentLiquidityGap7,
    bankInflows,
    bankOutflows,
    newlyEntered7dObligations: newlyEnteredConverted,
    slippedPromisesAndOverdueAr: slippedConverted,
  });
}

export const loadOvernightDeltaInputs = loadOvernightDeltaAttribution;

function fmtSignedTl(val: number | null, masked = false, nullLabel = "—"): string {
  if (val == null) return nullLabel;
  if (masked) {
    if (val === 0) return "0 TL";
    return val > 0 ? "+[MASKELİ TL]" : "-[MASKELİ TL]";
  }
  const absFormatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(val));
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  return `${sign}${absFormatted} TL`;
}

/**
 * Sabah brifingi ve kapalı-devre dış bildirim (Telegram/e-posta) için
 * Gece Nakit & Gap7 Değişim Köprüsü markdown çıktısı üretir.
 */
export function formatOvernightDeltaBridgeMd(
  delta: OvernightDeltaAttribution,
  options: { masked?: boolean } = {},
): string {
  const masked = Boolean(options.masked);
  const bankNullLabel = !delta.hasVerifiedBankFeed
    ? "Bilinmiyor (banka ekstresi yok)"
    : "Bilinmiyor (FIN-03 açılış eksik)";
  const fxNullLabel =
    delta.previousAvailableCash == null || delta.currentAvailableCash == null
      ? "Bilinmiyor (FIN-03 açılış eksik)"
      : "Bilinmiyor (banka ekstresi yok)";
  const lines: string[] = [];
  lines.push(`## Dünden Bugüne Nakit ve 7 Günlük Açık Değişim Köprüsü (Δ: ${delta.fromDateISO} → ${delta.toDateISO})`);
  lines.push(
    `- Nakit Değişimi (ΔCash): ${fmtSignedTl(
      delta.deltaAvailableCash,
      masked,
      "Bilinmiyor (FIN-03 açılış eksik)",
    )} (Önceki: ${
      delta.previousAvailableCash == null
        ? "Bilinmiyor (FIN-03 açılış eksik)"
        : fmtSignedTl(delta.previousAvailableCash, masked)
    } → Bugün: ${
      delta.currentAvailableCash == null
        ? "Bilinmiyor (FIN-03 açılış eksik)"
        : fmtSignedTl(delta.currentAvailableCash, masked)
    })`,
  );
  lines.push(
    `- ① Gerçekleşen Banka Tahsilatları (+): ${fmtSignedTl(delta.realizedBankInflows, masked, bankNullLabel)}`,
  );
  lines.push(
    `- ② Gerçekleşen Banka Ödemeleri / Masrafları (-): ${fmtSignedTl(delta.realizedBankOutflows, masked, bankNullLabel)}`,
  );
  lines.push(
    `- ③ 7 Günlük Pencereye Yeni Giren Yükümlülükler: ${fmtSignedTl(delta.newlyEntered7dObligations, masked)}`,
  );
  lines.push(
    `- ④ Vadesi Kayan / Kırılan Tahsilat Sözleri & Geciken Alacaklar: ${fmtSignedTl(-delta.slippedPromisesAndOverdueAr, masked)}`,
  );
  lines.push(
    `- ⑤ Kur Değerleme ve Bakiye Düzeltme Etkisi (FX): ${fmtSignedTl(delta.fxAndAdjustmentImpact, masked, fxNullLabel)}`,
  );
  lines.push(
    `- 7 Günlük Likidite Açığı Değişimi (ΔGap7): ${fmtSignedTl(
      delta.deltaLiquidityGap7,
      masked,
      "Bilinmiyor (FIN-03 açılış eksik)",
    )}`,
  );
  return lines.join("\n");
}