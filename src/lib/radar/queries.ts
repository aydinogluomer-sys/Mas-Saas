// Read-side queries for radar/calendar/payments pages.
//
// Faz 17: money columns are selected as `numeric` and parsed with @/lib/money instead of
// binary floating-point casts in SQL. Every query below feeds a typed interface whose amount
// fields are `number | null`, so the parse is not optional bookkeeping — node-postgres hands
// back `numeric` as a STRING, and returning `.rows` unmapped would leave TypeScript believing
// in numbers while the runtime carried strings. `mapInstanceRow` is that boundary.
import type { Pool } from "pg";
import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { decimal, moneyOrNull, intOrNull, round2 } from "@/lib/money";
import {
  addMonths, dayFlags, dayFlagsFromAggregate, type RiskInputInstance, type RiskThresholds,
} from "./rules";
import { computeInstanceScheduleForMonth } from "./engine";

export interface InstanceRow {
  id: string;
  payment_id: string | null;
  name: string;
  due_date: string;
  amount: number | null;
  amount_status: string;
  status: string;
  paid_amount: number | null;
  /** Contract A: Original scheduled/contractual obligation amount (`null` = unknown, NEVER coerced to 0). */
  original_amount?: number | null;
  /** Contract A: Remaining unpaid exposure (`null` when `amount === null`; `0` when paid/cancelled/overpaid). */
  remaining_amount?: number | null;
  /** Contract A: Non-zero when `paid_amount > amount` on a settled/partial obligation. */
  overpayment_amount?: number;
  risk_level: string;
  risk_reasons: string[];
  note: string | null;
  currency?: string;
  direction?: string;
  priority?: string | null;
  category?: string | null;
  source_linked?: boolean;
  flexibility?: "critical" | "flexible" | "optional" | null;
  linked_invoice_id?: string | null;
  paid_from_account_id?: string | null;
}

const BASE = `
  select i.id, i.payment_id, coalesce(p.name,'(silinmiş kalem)') as name,
         to_char(i.due_date,'YYYY-MM-DD') as due_date,
         i.amount, i.amount_status, i.status,
         i.paid_amount, i.risk_level, i.risk_reasons, i.note,
         i.currency, i.direction, p.priority, p.flexibility_class as flexibility, c.name as category,
         (i.source_row_id is not null or p.source_row_id is not null) as source_linked,
         to_jsonb(i)->>'linked_invoice_id' as linked_invoice_id,
         to_jsonb(i)->>'paid_from_account_id' as paid_from_account_id
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
`;

/** The single decode point for every `BASE` query. Ordering still happens in SQL on the
 * exact `numeric`, so dropping the cast did not change any `order by i.amount` result. */
export function mapInstanceRow(r: Record<string, unknown>): InstanceRow {
  const amount = moneyOrNull(r.amount as string | number | null);
  const paid_amount = moneyOrNull(r.paid_amount as string | number | null);
  const effectiveStatus = r.cancelled_at != null ? "cancelled" : String(r.status ?? "unpaid");
  const computed = computeObligationAmounts({
    originalAmount: amount,
    paidAmount: paid_amount,
    status: effectiveStatus,
  });
  return {
    ...(r as unknown as InstanceRow),
    amount,
    paid_amount,
    original_amount: computed.originalAmount,
    remaining_amount: computed.outstandingAmount,
    overpayment_amount: computed.overpaymentAmount,
  };
}

/**
 * `InstanceRow` → `dayFlags()` girdisi. TEK dönüşüm noktası: `currency` her çağıranda ayrı ayrı
 * unutulmasın diye. `BASE` `i.currency`'yi daima seçer (kolon `not null default 'TRY'`); yine de
 * alan tipte isteğe bağlı olduğu için eksikse `null` (= bilinmiyor) geçilir — TRY VARSAYILMAZ,
 * `dayFlags` o kalemi eşik dışında tutup `foreignCount`ta sayar (CLAUDE.md, plan §2.1).
 */
export function toRiskInput(x: Pick<InstanceRow, "id" | "due_date" | "amount" | "status" | "currency">): RiskInputInstance {
  return { id: x.id, dueDate: x.due_date, amount: x.amount, status: x.status, currency: x.currency ?? null };
}

export async function instancesOn(pool: Pool, dateISO: string): Promise<InstanceRow[]> {
  return (await pool.query(BASE + `where i.due_date = $1 order by i.amount desc nulls last`, [dateISO])).rows.map(mapInstanceRow);
}

export async function instancesBetween(pool: Pool, fromISO: string, toISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(BASE + `where i.due_date >= $1 and i.due_date <= $2 order by i.due_date, i.amount desc nulls last`, [fromISO, toISO])
  ).rows.map(mapInstanceRow);
}

export async function overdueOpen(pool: Pick<Pool, "query">, todayISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE +
        `where i.due_date < $1
           and i.status in ('unpaid','partial','planned','late')
           and i.status <> 'cancelled'
           and i.cancelled_at is null
         order by i.due_date`,
      [todayISO],
    )
  ).rows.map(mapInstanceRow);
}

/** One bounded read for the complete Payments overview. */
export async function paymentOverviewInstances(
  pool: Pool,
  todayISO: string,
  futureEndISO: string,
): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.due_date <= $2
        and (i.due_date >= $1 or i.status in ('unpaid','partial','planned','late'))
        order by i.due_date, i.amount desc nulls last`,
      [todayISO, futureEndISO],
    )
  ).rows.map(mapInstanceRow);
}

export interface PaymentDashboardBucket {
  dueDate: string;
  status: "overdue" | "partial" | "planned";
  count: number;
  knownAmount: number;
  unknownCount: number;
  maxAmount: number | null;
  /**
   * Risk bayrakları için `dayFlags()` ile BİREBİR alanlar. Görüntüleme alanlarından ayrı
   * tutulmaları bilerek: `knownAmount`/`maxAmount` `remaining` üzerinden ("baskı"), bunlar ise
   * `amount` üzerinden ve yalnız OPEN_STATUSES üzerinden hesaplanır — çünkü risk kuralı
   * `src/lib/radar/rules.ts`'te öyle tanımlı ve performans için iş kuralı değiştirilemez.
   */
  openCount: number;
  flagKnownSum: number;
  flagMaxAmount: number | null;
  /** Açık (OPEN_STATUSES) ve TRY-dışı kalem sayısı — `dayFlags().foreignCount` ile birebir. */
  flagForeignCount: number;
  foreignCurrencyCount: number;
  criticalCount: number;
  flexibleCount: number;
  optionalCount: number;
  unclassifiedCount: number;
}

export interface PaymentDashboardFlexibility {
  id: "critical" | "flexible" | "optional" | "unclassified";
  count: number;
  templateCount: number;
  knownAmount: number;
  unknownCount: number;
  /** PHASE 2.2: TRY-dışı kalem — knownAmount'a girmez. */
  foreignCurrencyCount: number;
}

/**
 * Bir gunun kovalarini `dayFlags()`in bekledigi tek girdiye indirger ve karari ona sorar.
 *
 * Bir gun, `pressure_status`e gore birden cok kovaya bolunebiliyor (overdue / partial / planned);
 * `dayFlags` ise gunu BUTUN olarak tartar. Birlestirme burada, TEK yerde duruyor — sayfa da bu
 * dogrulama scripti de ayni fonksiyonu cagiriyor, yani test sayfanin gercekten calistirdigi yolu
 * olcuyor, ona benzeyen bir kopyayi degil.
 *
 * Alanlar bilerek `knownAmount`/`maxAmount` DEGIL: onlar `remaining` uzerinden hesaplanir ve
 * grafigi besler. Risk esigi urun kurali olarak `amount`a bagli — bkz. `dayFlagsFromAggregate`.
 */
export function dayFlagsForDate(
  buckets: PaymentDashboardBucket[],
  date: string,
  thresholds: RiskThresholds,
): ReturnType<typeof dayFlagsFromAggregate> {
  const rows = buckets.filter((row) => row.dueDate === date);
  return dayFlagsFromAggregate({
    openCount: rows.reduce((sum, row) => sum + row.openCount, 0),
    knownSum: rows.reduce((sum, row) => sum + row.flagKnownSum, 0),
    maxAmount: rows.reduce<number | null>(
      (max, row) => (row.flagMaxAmount != null && (max == null || row.flagMaxAmount > max) ? row.flagMaxAmount : max),
      null,
    ),
    foreignCount: rows.reduce((sum, row) => sum + row.flagForeignCount, 0),
  }, thresholds);
}

/** Bounded read model for the payments landing page; detail pages keep the full-row loaders. */
export async function loadPaymentDashboard(
  pool: Pool,
  todayISO: string,
  futureEndISO: string,
): Promise<{
  buckets: PaymentDashboardBucket[];
  flexibility: PaymentDashboardFlexibility[];
  watchList: Array<InstanceRow & { remaining: number | null; daysOverdue: number; decisionFlexibility: PaymentDashboardFlexibility["id"] }>;
  priorities: Array<InstanceRow & { remaining: number | null }>;
}> {
  const tomorrowISO = new Date(Date.parse(todayISO) + 86400000).toISOString().slice(0, 10);
  const result = await pool.query(`
    with active as materialized (
      select i.*, p.name as payment_name, p.priority, p.flexibility_class,
             c.name as category,
             case when i.amount is null then null else greatest(i.amount-coalesce(i.paid_amount,0),0) end as remaining,
             case when p.flexibility_class in ('critical','flexible','optional') then p.flexibility_class
                  when p.priority in ('critical','high') or i.risk_level='critical' then 'critical'
                  when p.priority='low' then 'optional' else 'unclassified' end as decision_flexibility
      from public.payment_instances i
      left join public.payments p on p.id=i.payment_id
      left join public.categories c on c.id=p.category_id
      where i.due_date <= $2::date
        and (i.due_date >= $1::date or i.status in ('unpaid','partial','planned','late'))
        and i.status in ('unpaid','partial','planned','late','unknown')
        -- ═══ IPTAL EDILMIS KAYITLAR ODEME YUKUNUN DISINDADIR ═══════════════════════════
        --
        -- KURAL. status='cancelled' ya da cancelled_at dolu bir odeme ornegi; bugun/yarin/
        -- 7 gunluk cikisa, gecikmis ve acik toplamlara, oncelikli odemelere, riskli gun
        -- hesabina ve grafigin acik odeme serisine GIRMEZ. /payments/history uzerinde
        -- gorunmeye devam eder — orasi denetim izidir, yuk gostergesi degil.
        --
        -- KAYNAKLAR (bu kural burada icat edilmiyor):
        --   src/lib/radar/rules.ts        OPEN_STATUSES = unpaid|partial|planned|late
        --   docs/calculation-rules.md     "Odenmis/iptal kayitlar risk almaz."
        --   tests/visual/golden-ui-smoke  OPEN = "status <> 'paid' and cancelled_at is null"
        --
        -- BU IKI SATIR BUGUN TEK BASINA IS GORMUYOR — ve bu bilerek boyle.
        -- Ustteki izin listesi 'cancelled' ICERMIYOR, yani dislama zaten oluyor. Fark su:
        -- orada dislama bir YAN ETKI, burada bir BEYAN. Izin listesine bir gun 'cancelled'
        -- eklenirse (ornegin "iptalleri de sayalim" denip geri alinmazsa) kural burada
        -- ayakta kalir. Ayrica sorguyu okuyan biri, kuralin uygulandigini bir listede
        -- OLMAYAN bir degeri fark ederek degil, yazili olarak gorur.
        --
        -- IKI YUKLEM DE YAZILDI, CUNKU SORGU GORMEDIGI BIR GARANTIYE DAYANMAMALI.
        -- public.payment_instances uzerindeki payment_instances_cancel_consistency
        -- kisiti ((status = 'cancelled') = (cancelled_at IS NOT NULL)) esdegerligini
        -- ZATEN garanti ediyor; yani bugun ikisi ayni satirlari eliyor. Kisit sorgunun
        -- icinde gorunmedigi icin, tek yuklem yazip digerini "nasilsa kisit tutuyor"
        -- diye atlamak, sessiz bir bagimlilik olurdu.
        and i.status <> 'cancelled'
        and i.cancelled_at is null
    ), buckets as (
      select to_char(due_date,'YYYY-MM-DD') as due_date,
             case when due_date < $1::date then 'overdue' when status='partial' then 'partial' else 'planned' end as pressure_status,
             count(*)::int as record_count,
             -- PHASE 2.2 (#3): goruntuleme toplamlari da yalniz TRY; TRY-disi kalem toplama girmez,
             -- foreign_currency_count ile ekranda sayilir (plan §2.3).
             coalesce(sum(remaining) filter (where remaining is not null and currency = 'TRY'),0) as known_amount,
             count(*) filter (where remaining is null)::int as unknown_count,
             max(remaining) filter (where remaining is not null and currency = 'TRY') as max_amount,
             count(*) filter (where currency <> 'TRY')::int as foreign_currency_count,
             count(*) filter (where decision_flexibility='critical')::int as critical_count,
             count(*) filter (where decision_flexibility='flexible')::int as flexible_count,
             count(*) filter (where decision_flexibility='optional')::int as optional_count,
             count(*) filter (where decision_flexibility='unclassified')::int as unclassified_count,
             -- ── RISK BAYRAKLARI ICIN AYRI ALANLAR — dayFlags() ile BIREBIR ────────────
             -- Yukaridaki known_amount/max_amount GORUNTULEME icindir ve remaining
             -- uzerinden hesaplanir ("baski" = hala borclu olunan). Risk KARARI ise
             -- src/lib/radar/rules.ts'teki dayFlags()'in tanimini kullanmak ZORUNDA;
             -- performans icin is kurali degistirilemez. Bu yuzden ayri alanlar:
             --   open_count        dayFlags'in open.lengthi — OPEN_STATUSES, 'unknown' HARIC
             --   flag_known_sum    dayFlags'in knownSum'i — amount, remaining DEGIL,
             --                     ve yalniz amount > 0 olanlar
             --   flag_max_amount   dayFlags'in anyLarge/anyCritical'i — per-instance amount
             --                     maksimumu; max >= esik ile some(i => i.amount >= esik)
             --                     ayni onermedir
             --   flag_foreign_count dayFlags'in foreignCount'u — acik ve TRY-disi kalemler
             --
             -- PHASE 2.2 (T1-a): esikler *_threshold_try; flag_known_sum ve flag_max_amount
             -- YALNIZ currency = 'TRY' satirlardan gelir (dayFlags'teki "comparable" suzgeci).
             -- TRY-disi acik kalemler sessizce dusmez: flag_foreign_count onlari sayar.
             -- open_count para biriminden bagimsizdir (yigilma sayim kuralidir).
             count(*) filter (where status in ('unpaid','partial','planned','late'))::int as open_count,
             coalesce(sum(amount) filter (
               where status in ('unpaid','partial','planned','late') and currency = 'TRY'
                 and amount is not null and amount > 0
             ),0) as flag_known_sum,
             max(amount) filter (
               where status in ('unpaid','partial','planned','late') and currency = 'TRY' and amount is not null
             ) as flag_max_amount,
             count(*) filter (
               where status in ('unpaid','partial','planned','late') and currency <> 'TRY'
             )::int as flag_foreign_count
      from active group by due_date, pressure_status
    ), flexibility as (
      select decision_flexibility, count(*)::int as record_count,
             count(distinct coalesce(payment_id,id))::int as template_count,
             coalesce(sum(remaining) filter (where remaining is not null and currency = 'TRY'),0) as known_amount,
             count(*) filter (where remaining is null)::int as unknown_count,
             count(*) filter (where currency <> 'TRY')::int as foreign_currency_count
      from active group by decision_flexibility
    ), watch_list as (
      select id, payment_id, coalesce(payment_name,'(silinmiş kalem)') as name,
             to_char(due_date,'YYYY-MM-DD') as due_date, amount, amount_status, status,
             paid_amount, risk_level, risk_reasons, note, currency, direction, priority,
             category, flexibility_class as flexibility, (source_row_id is not null) as source_linked,
             remaining, greatest(0,($1::date-due_date))::int as days_overdue, decision_flexibility
      from active order by greatest(0,($1::date-due_date)) desc,
               (decision_flexibility='critical') desc, remaining desc nulls last limit 8
    ), priorities as (
      select id, payment_id, coalesce(payment_name,'(silinmiş kalem)') as name,
             to_char(due_date,'YYYY-MM-DD') as due_date, amount, amount_status, status,
             paid_amount, risk_level, risk_reasons, note, currency, direction, priority,
             category, flexibility_class as flexibility, (source_row_id is not null) as source_linked, remaining
      from active where due_date <= $3::date
      order by (due_date < $1::date) desc, due_date, (decision_flexibility='critical') desc,
               -- PHASE 2.2 (T1-b): 'unsupported_currency' = esik degerlendirilemedi; merdivende
               -- high ile medium arasinda (rules.ts riskLevelOf ile ayni sira).
               case risk_level when 'critical' then 5 when 'high' then 4 when 'unsupported_currency' then 3
                               when 'medium' then 2 when 'low' then 1 else 0 end desc,
               remaining desc nulls last limit 5
    )
    select
      coalesce((select jsonb_agg(to_jsonb(b) order by b.due_date,b.pressure_status) from buckets b),'[]'::jsonb) buckets,
      coalesce((select jsonb_agg(to_jsonb(f) order by f.decision_flexibility) from flexibility f),'[]'::jsonb) flexibility,
      coalesce((select jsonb_agg(to_jsonb(w)) from watch_list w),'[]'::jsonb) watch_list,
      coalesce((select jsonb_agg(to_jsonb(p)) from priorities p),'[]'::jsonb) priorities`,
    [todayISO, futureEndISO, tomorrowISO]);
  const payload = result.rows[0] as { buckets: Record<string, unknown>[]; flexibility: Record<string, unknown>[]; watch_list: Record<string, unknown>[]; priorities: Record<string, unknown>[] };

  return {
    buckets: payload.buckets.map((row) => ({
      dueDate: row.due_date as string,
      status: row.pressure_status as PaymentDashboardBucket["status"],
      count: Number(row.record_count),
      knownAmount: moneyOrNull(row.known_amount as string | number | null) ?? 0,
      unknownCount: Number(row.unknown_count),
      maxAmount: moneyOrNull(row.max_amount as string | number | null),
      openCount: Number(row.open_count),
      flagKnownSum: moneyOrNull(row.flag_known_sum as string | number | null) ?? 0,
      flagMaxAmount: moneyOrNull(row.flag_max_amount as string | number | null),
      flagForeignCount: Number(row.flag_foreign_count),
      foreignCurrencyCount: Number(row.foreign_currency_count),
      criticalCount: Number(row.critical_count), flexibleCount: Number(row.flexible_count),
      optionalCount: Number(row.optional_count), unclassifiedCount: Number(row.unclassified_count),
    })),
    flexibility: payload.flexibility.map((row) => ({
      id: row.decision_flexibility as PaymentDashboardFlexibility["id"],
      count: Number(row.record_count), templateCount: Number(row.template_count),
      knownAmount: moneyOrNull(row.known_amount as string | number | null) ?? 0, unknownCount: Number(row.unknown_count),
      foreignCurrencyCount: Number(row.foreign_currency_count ?? 0),
    })),
    watchList: payload.watch_list.map((row) => ({
      ...mapInstanceRow(row), remaining: moneyOrNull(row.remaining as string | number | null),
      daysOverdue: Number(row.days_overdue),
      decisionFlexibility: row.decision_flexibility as PaymentDashboardFlexibility["id"],
    })),
    priorities: payload.priorities.map((row) => ({ ...mapInstanceRow(row), remaining: moneyOrNull(row.remaining as string | number | null) })),
  };
}

export interface MonthSummaryResult {
  known_total: number;
  known_remaining: number;
  paid_known: number;
  missing_count: number;
  /** PHASE 2.2: TRY-dışı kalem sayısı — hiçbir toplama girmedi. */
  foreign_count: number;
  total_count: number;
  cancelledCount: number;
  cancelledKnownTotal: number;
  settlementAdjustmentTry: number;
  overpaymentAdjustmentTry: number;
  unexplainedGapTry: number;
}

export async function monthSummary(
  pool: Pick<Pool, "query">,
  monthStartISO: string,
): Promise<MonthSummaryResult> {
  const r = await pool.query(
    // PHASE 2.2 (#2), 4.A & Agent 04 (I-009/I-012): Aktif çıkış (outflow) kalemleri ve iptal edilenlerin ayrıştırılması;
    // known_total + overpaymentAdjustmentTry === paid_known + known_remaining + settlementAdjustmentTry özdeşliğini korur.
    `select
       coalesce(sum(amount) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
       ), 0) as known_total,
       coalesce(sum(greatest(amount - coalesce(paid_amount, 0), 0)) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
           and status in ('unpaid','partial','planned','late')
       ), 0) as known_remaining,
       coalesce(sum(
         case
           when status = 'paid' then coalesce(paid_amount, amount)
           when status = 'partial' then coalesce(paid_amount, 0)
           else 0
         end
       ) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
       ), 0) as paid_known,
       count(*) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is null
       )::int as missing_count,
       count(*) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and currency <> 'TRY'
       )::int as foreign_count,
       count(*) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
       )::int as total_count,
       count(*) filter (
         where (status = 'cancelled' or cancelled_at is not null)
           and coalesce(direction, 'outflow') = 'outflow'
       )::int as cancelled_count,
       coalesce(sum(amount) filter (
         where (status = 'cancelled' or cancelled_at is not null)
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
       ), 0) as cancelled_known_total,
       coalesce(sum(greatest(amount - coalesce(paid_amount, amount), 0)) filter (
         where status = 'paid'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
       ), 0) as settlement_adjustment_try,
       coalesce(sum(greatest(coalesce(paid_amount, 0) - amount, 0)) filter (
         where status <> 'cancelled'
           and cancelled_at is null
           and coalesce(direction, 'outflow') = 'outflow'
           and amount is not null
           and currency = 'TRY'
           and status in ('paid', 'partial')
       ), 0) as overpayment_adjustment_try
     from public.payment_instances where instance_month = $1`,
    [monthStartISO],
  );
  // The sums are computed exactly by Postgres and only decoded at TL scale via @/lib/money.
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  const known_total =
    moneyOrNull((row.known_total as string | number | null | undefined) ?? null) ?? 0;
  const known_remaining =
    moneyOrNull((row.known_remaining as string | number | null | undefined) ?? null) ?? 0;
  const paid_known =
    moneyOrNull((row.paid_known as string | number | null | undefined) ?? null) ?? 0;
  const missing_count =
    intOrNull((row.missing_count as number | string | null | undefined) ?? null) ?? 0;
  const foreign_count =
    intOrNull((row.foreign_count as number | string | null | undefined) ?? null) ?? 0;
  const total_count =
    intOrNull((row.total_count as number | string | null | undefined) ?? null) ?? 0;
  const cancelledCount =
    intOrNull((row.cancelled_count as number | string | null | undefined) ?? null) ?? 0;
  const cancelledKnownTotal =
    moneyOrNull((row.cancelled_known_total as string | number | null | undefined) ?? null) ?? 0;
  const settlementAdjustmentTry =
    moneyOrNull((row.settlement_adjustment_try as string | number | null | undefined) ?? null) ?? 0;
  const overpaymentAdjustmentTry =
    moneyOrNull((row.overpayment_adjustment_try as string | number | null | undefined) ?? null) ?? 0;
  const rawGap = round2(
    decimal(known_total)
      .plus(overpaymentAdjustmentTry)
      .minus(decimal(paid_known).plus(known_remaining).plus(settlementAdjustmentTry)),
  );
  const unexplainedGapTry = rawGap === 0 ? 0 : rawGap;

  return {
    known_total,
    known_remaining,
    paid_known,
    missing_count,
    foreign_count,
    total_count,
    cancelledCount,
    cancelledKnownTotal,
    settlementAdjustmentTry,
    overpaymentAdjustmentTry,
    unexplainedGapTry,
  };
}

export type DistributionBy = "provider" | "category" | "owner";

export interface DistributionBucket {
  key: string;
  /** Active known TRY scheduled outflow total (`sum(amount)`), reconciling with `monthSummary.known_total`. */
  amount: number;
  /** Active known TRY unpaid/remaining exposure, reconciling with `monthSummary.known_remaining`. */
  remainingAmount: number;
  /** Active known TRY paid outflow total, reconciling with `monthSummary.paid_known`. */
  paidAmount: number;
  /** Active known TRY row count in this bucket. */
  count: number;
  /** Active non-TRY row count in this bucket (excluded from TRY sums). */
  foreignCount: number;
}

/**
 * Monthly outflow distribution by `provider`, `category`, or `owner`.
 * Uses 1:1 PK `LEFT JOIN`s (zero row multiplication) and excludes `cancelled` and `inflow`
 * rows identically to `monthSummary`.
 */
export async function distribution(
  pool: Pick<Pool, "query">,
  monthStartISO: string,
  by: DistributionBy,
): Promise<DistributionBucket[]> {
  let joinClause: string;
  let keyExpr: string;
  switch (by) {
    case "provider":
      joinClause = "left join public.parties pr on pr.id = p.provider_party_id";
      keyExpr = "coalesce(pr.name, '(atanmadı)')";
      break;
    case "category":
      joinClause = "left join public.categories c on c.id = p.category_id";
      keyExpr = "coalesce(c.name, '(atanmadı)')";
      break;
    case "owner":
      joinClause = "left join public.parties o on o.id = p.owner_party_id";
      keyExpr = "coalesce(o.name, '(atanmadı)')";
      break;
    default: {
      const exhaustive: never = by;
      throw new TypeError(`Geçersiz dağılım boyutu: ${String(exhaustive)}`);
    }
  }

  const r = await pool.query(
    `select ${keyExpr} as key,
            coalesce(sum(i.amount) filter (where i.currency = 'TRY'), 0) as amount,
            coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0)) filter (
              where i.currency = 'TRY'
                and i.status in ('unpaid','partial','planned','late')
            ), 0) as remaining_amount,
            coalesce(sum(
              case
                when i.status = 'paid' then coalesce(i.paid_amount, i.amount)
                when i.status = 'partial' then coalesce(i.paid_amount, 0)
                else 0
              end
            ) filter (where i.currency = 'TRY'), 0) as paid_amount,
            count(*) filter (where i.currency = 'TRY')::int as try_count,
            count(*) filter (where i.currency <> 'TRY')::int as foreign_count
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
       ${joinClause}
      where i.instance_month = $1
        and i.amount is not null
        and i.status <> 'cancelled'
        and i.cancelled_at is null
        and coalesce(i.direction, 'outflow') = 'outflow'
      group by 1
      order by amount desc nulls last, key asc`,
    [monthStartISO],
  );

  return r.rows.map((x: Record<string, unknown>) => ({
    key: String(x.key ?? "(atanmadı)"),
    amount: moneyOrNull((x.amount as string | number | null | undefined) ?? null) ?? 0,
    remainingAmount:
      moneyOrNull((x.remaining_amount as string | number | null | undefined) ?? null) ?? 0,
    paidAmount: moneyOrNull((x.paid_amount as string | number | null | undefined) ?? null) ?? 0,
    count: intOrNull((x.try_count as number | string | null | undefined) ?? null) ?? 0,
    foreignCount: intOrNull((x.foreign_count as number | string | null | undefined) ?? null) ?? 0,
  }));
}

export async function missingAmountInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.instance_month = $1 and i.amount is null and i.status in ('unpaid','partial','planned','late') and i.cancelled_at is null order by i.due_date nulls last`,
      [monthStartISO],
    )
  ).rows.map(mapInstanceRow);
}

/** M-17: All open missing-amount instances across ALL months (past, current, future). */
export async function allMissingAmountInstances(pool: Pool): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE +
        `where i.amount is null
           and i.status in ('unpaid','partial','planned','late')
           and i.status <> 'cancelled'
           and i.cancelled_at is null
         order by i.due_date asc nulls last, i.instance_month asc`,
    )
  ).rows.map(mapInstanceRow);
}

export type DashboardCurrencyMode = "TRY" | "USD" | "EUR" | "CONSOLIDATED";

export interface CurrencyDashboardResult {
  buckets: PaymentDashboardBucket[];
  currencyMode: DashboardCurrencyMode;
  unconvertibleForeignCount: number;
  fxRatesUsed: Record<string, { rate: number; rateDate: string }>;
}

/**
 * M-15: Pure read-only chart data loader supporting TRY | USD | EUR | CONSOLIDATED.
 * Zero DB writes — projects virtual future template instances in memory for months that
 * do not yet have a `payment_instances` row, and converts foreign obligations using the
 * latest TCMB `fx_rate_snapshots` when `CONSOLIDATED` is requested (keeping unconvertible
 * rows explicit instead of assuming 1:1).
 */
export async function loadPaymentDashboardForCurrency(
  pool: Pool,
  todayISO: string,
  futureEndISO: string,
  currencyMode: DashboardCurrencyMode = "TRY",
): Promise<CurrencyDashboardResult> {
  const [openRes, existingPairRes, templatesRes] = await Promise.all([
    pool.query<{
      due_date: string;
      status: string;
      amount: string | null;
      remaining: string | null;
      currency: string;
      decision_flexibility: "critical" | "flexible" | "optional" | "unclassified";
    }>(
      `select to_char(i.due_date, 'YYYY-MM-DD') as due_date,
              i.status,
              i.amount::text as amount,
              case when i.amount is null then null else greatest(i.amount - coalesce(i.paid_amount, 0), 0)::text end as remaining,
              coalesce(i.currency, 'TRY') as currency,
              case when p.flexibility_class in ('critical','flexible','optional') then p.flexibility_class
                   when p.priority in ('critical','high') or i.risk_level='critical' then 'critical'
                   when p.priority='low' then 'optional' else 'unclassified' end as decision_flexibility
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
        where i.due_date <= $2::date
          and (i.due_date >= $1::date or i.status in ('unpaid','partial','planned','late'))
          and i.status in ('unpaid','partial','planned','late','unknown')
          and i.status <> 'cancelled'
          and i.cancelled_at is null`,
      [todayISO, futureEndISO],
    ),
    pool.query<{ payment_id: string; instance_month: string }>(
      `select payment_id::text as payment_id,
              to_char(instance_month, 'YYYY-MM-DD') as instance_month
         from public.payment_instances
        where payment_id is not null
          and instance_month >= date_trunc('month', $1::date)::date
          and instance_month <= date_trunc('month', $2::date)::date`,
      [todayISO, futureEndISO],
    ),
    pool.query<{
      id: string;
      due_day: number | null;
      due_date: string | null;
      created_iso: string | null;
      default_amount: string | null;
      currency: string;
      recurrence_type: string | null;
      source_notes: string | null;
      priority: string | null;
      flexibility_class: string | null;
    }>(
      `select id::text as id,
              due_day,
              to_char(due_date, 'YYYY-MM-DD') as due_date,
              to_char(created_at, 'YYYY-MM-DD') as created_iso,
              default_amount::text as default_amount,
              coalesce(currency, 'TRY') as currency,
              recurrence_type,
              source_notes,
              priority,
              flexibility_class
         from public.payments
        where status = 'active'
          and archived_at is null`,
    ),
  ]);

  const fxRatesUsed: Record<string, { rate: number; rateDate: string }> = {};
  if (currencyMode === "CONSOLIDATED") {
    try {
      const fxRes = await pool.query<{ base_currency: string; rate: string; rate_date: string }>(
        `select distinct on (base_currency)
                upper(base_currency) as base_currency,
                rate::text as rate,
                to_char(rate_date, 'YYYY-MM-DD') as rate_date
           from public.fx_rate_snapshots
          where quote_currency = 'TRY'
            and rate > 0
          order by upper(base_currency), rate_date desc, fetched_at desc`,
      );
      for (const r of fxRes.rows) {
        const parsedRate = moneyOrNull(r.rate);
        if (parsedRate != null && parsedRate > 0) {
          fxRatesUsed[r.base_currency] = { rate: parsedRate, rateDate: r.rate_date };
        }
      }
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
      if (code !== "42P01" && code !== "42703") throw err;
    }
  }

  const existingMonths = new Set<string>(
    existingPairRes.rows.map((r) => `${r.payment_id}:${r.instance_month}`),
  );

  interface RawChartItem {
    dueDate: string;
    status: string;
    amount: number | null;
    remaining: number | null;
    currency: string;
    decisionFlexibility: "critical" | "flexible" | "optional" | "unclassified";
  }

  const items: RawChartItem[] = openRes.rows.map((r) => ({
    dueDate: r.due_date,
    status: r.status,
    amount: moneyOrNull(r.amount),
    remaining: moneyOrNull(r.remaining),
    currency: (r.currency || "TRY").toUpperCase(),
    decisionFlexibility: r.decision_flexibility,
  }));

  // Virtual read-only projection for months without materialized payment_instances
  const startMonth = `${todayISO.slice(0, 7)}-01`;
  const endMonth = `${futureEndISO.slice(0, 7)}-01`;
  for (let m = startMonth, guard = 0; m <= endMonth && guard < 36; m = addMonths(m, 1), guard++) {
    for (const tpl of templatesRes.rows) {
      if (existingMonths.has(`${tpl.id}:${m}`)) continue;
      const sched = computeInstanceScheduleForMonth(tpl, m);
      if (!sched) continue;
      if (sched.dueDate < todayISO || sched.dueDate > futureEndISO) continue;
      const decisionFlexibility: RawChartItem["decisionFlexibility"] =
        tpl.flexibility_class === "critical" ||
        tpl.flexibility_class === "flexible" ||
        tpl.flexibility_class === "optional"
          ? tpl.flexibility_class
          : tpl.priority === "critical" || tpl.priority === "high"
            ? "critical"
            : tpl.priority === "low"
              ? "optional"
              : "unclassified";
      items.push({
        dueDate: sched.dueDate,
        status: "planned",
        amount: sched.amount,
        remaining: sched.amount,
        currency: (tpl.currency || "TRY").toUpperCase(),
        decisionFlexibility,
      });
    }
  }

  const bucketMap = new Map<
    string,
    {
      dueDate: string;
      status: PaymentDashboardBucket["status"];
      count: number;
      knownSum: ReturnType<typeof decimal>;
      unknownCount: number;
      maxAmount: number | null;
      openCount: number;
      flagKnownSum: ReturnType<typeof decimal>;
      flagMaxAmount: number | null;
      flagForeignCount: number;
      foreignCurrencyCount: number;
      criticalCount: number;
      flexibleCount: number;
      optionalCount: number;
      unclassifiedCount: number;
    }
  >();

  let unconvertibleForeignCount = 0;

  for (const item of items) {
    // Single-currency foreign filter: when viewing USD or EUR specifically, show only that currency
    if ((currencyMode === "USD" || currencyMode === "EUR") && item.currency !== currencyMode) {
      continue;
    }

    const pressureStatus: PaymentDashboardBucket["status"] =
      item.dueDate < todayISO ? "overdue" : item.status === "partial" ? "partial" : "planned";
    const key = `${item.dueDate}:${pressureStatus}`;
    let acc = bucketMap.get(key);
    if (!acc) {
      acc = {
        dueDate: item.dueDate,
        status: pressureStatus,
        count: 0,
        knownSum: decimal(0),
        unknownCount: 0,
        maxAmount: null,
        openCount: 0,
        flagKnownSum: decimal(0),
        flagMaxAmount: null,
        flagForeignCount: 0,
        foreignCurrencyCount: 0,
        criticalCount: 0,
        flexibleCount: 0,
        optionalCount: 0,
        unclassifiedCount: 0,
      };
      bucketMap.set(key, acc);
    }

    acc.count += 1;
    if (item.decisionFlexibility === "critical") acc.criticalCount += 1;
    else if (item.decisionFlexibility === "flexible") acc.flexibleCount += 1;
    else if (item.decisionFlexibility === "optional") acc.optionalCount += 1;
    else acc.unclassifiedCount += 1;

    const isOpenStatus =
      item.status === "unpaid" ||
      item.status === "partial" ||
      item.status === "planned" ||
      item.status === "late";
    if (isOpenStatus) acc.openCount += 1;

    let fxMultiplier: ReturnType<typeof decimal> | null = null;
    if (currencyMode === "CONSOLIDATED") {
      if (item.currency === "TRY") {
        fxMultiplier = decimal(1);
      } else if (fxRatesUsed[item.currency]) {
        fxMultiplier = decimal(fxRatesUsed[item.currency].rate);
      } else {
        fxMultiplier = null;
      }
    } else if (item.currency === currencyMode) {
      fxMultiplier = decimal(1);
    }

    if (fxMultiplier == null) {
      acc.foreignCurrencyCount += 1;
      if (isOpenStatus) acc.flagForeignCount += 1;
      if (currencyMode === "CONSOLIDATED") unconvertibleForeignCount += 1;
      if (item.remaining == null) acc.unknownCount += 1;
      continue;
    }

    if (item.remaining == null) {
      acc.unknownCount += 1;
    } else {
      const convertedRemaining = decimal(item.remaining).times(fxMultiplier);
      acc.knownSum = acc.knownSum.plus(convertedRemaining);
      const remNum = round2(convertedRemaining);
      if (acc.maxAmount == null || remNum > acc.maxAmount) acc.maxAmount = remNum;
    }

    if (isOpenStatus && item.amount != null && item.amount > 0) {
      const convertedAmount = decimal(item.amount).times(fxMultiplier);
      acc.flagKnownSum = acc.flagKnownSum.plus(convertedAmount);
      const amtNum = round2(convertedAmount);
      if (acc.flagMaxAmount == null || amtNum > acc.flagMaxAmount) acc.flagMaxAmount = amtNum;
    }
  }

  const buckets: PaymentDashboardBucket[] = [...bucketMap.values()]
    .sort((a, b) =>
      a.dueDate === b.dueDate ? a.status.localeCompare(b.status) : a.dueDate.localeCompare(b.dueDate),
    )
    .map((b) => ({
      dueDate: b.dueDate,
      status: b.status,
      count: b.count,
      knownAmount: round2(b.knownSum),
      unknownCount: b.unknownCount,
      maxAmount: b.maxAmount,
      openCount: b.openCount,
      flagKnownSum: round2(b.flagKnownSum),
      flagMaxAmount: b.flagMaxAmount,
      flagForeignCount: b.flagForeignCount,
      foreignCurrencyCount: b.foreignCurrencyCount,
      criticalCount: b.criticalCount,
      flexibleCount: b.flexibleCount,
      optionalCount: b.optionalCount,
      unclassifiedCount: b.unclassifiedCount,
    }));

  return {
    buckets,
    currencyMode,
    unconvertibleForeignCount,
    fxRatesUsed,
  };
}

export async function daylessPayments(pool: Pool) {
  return (
    await pool.query(
      `select id, name from public.payments
       where status='active' and (recurrence_type='irregular' or due_day is null)
       order by name`,
    )
  ).rows as Array<{ id: string; name: string }>;
}

export async function riskyDays(pool: Pool, todayISO: string, horizonDays: number, t: RiskThresholds) {
  const to = new Date(Date.parse(todayISO) + horizonDays * 86400000).toISOString().slice(0, 10);
  const rows = await instancesBetween(pool, todayISO, to);
  const byDate = new Map<string, InstanceRow[]>();
  for (const r of rows) {
    if (!byDate.has(r.due_date)) byDate.set(r.due_date, []);
    byDate.get(r.due_date)!.push(r);
  }
  const out: Array<{ date: string } & ReturnType<typeof dayFlags>> = [];
  for (const [date, list] of byDate) {
    const f = dayFlags(list.map(toRiskInput), t);
    if (f.cluster || f.critical || f.large) out.push({ date, ...f });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function monthInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE +
        `where i.instance_month = $1
           and i.status <> 'cancelled'
           and i.cancelled_at is null
           and coalesce(i.direction, 'outflow') = 'outflow'
         order by i.due_date`,
      [monthStartISO],
    )
  ).rows.map(mapInstanceRow);
}

export async function paidInstances(pool: Pool, limit = 100): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.status = 'paid' order by i.due_date desc limit $1`,
      [limit],
    )
  ).rows.map(mapInstanceRow);
}

export interface PaymentHistoryEvent {
  id: string;
  instanceId: string;
  paymentName: string;
  eventType: "paid" | "partial" | "reopened" | "cancelled";
  previousStatus: string | null;
  nextStatus: string;
  amount: number | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  currency: string;
  occurredAt: string;
  sourceLinked: boolean;
}

/**
 * Both `paid_amount` and `remaining_amount` parse as `numeric` in SQL and decode once in JS,
 * preserving `coalesce(i.currency, p.currency, 'TRY')` per event row.
 */
export async function paymentHistoryEvents(
  pool: Pick<Pool, "query">,
  filters: { status?: string; q?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
): Promise<PaymentHistoryEvent[]> {
  const limit = Math.max(1, Math.min(250, filters.limit ?? 50));
  const offset = Math.max(0, filters.offset ?? 0);
  const result = await pool.query(
    `
    with audit_events as (
      select a.id,a.entity_id instance_id,coalesce(p.name,'(silinmiş kalem)') payment_name,
        case when a.action='mark_paid' then 'paid' when a.action='mark_unpaid' then 'reopened'
             when a.after_data->>'status'='partial' then 'partial' else 'cancelled' end event_type,
        a.before_data->>'status' previous_status,coalesce(a.after_data->>'status','unknown') next_status,
        i.amount amount,nullif(a.after_data->>'paid_amount','')::numeric paid_amount,
        case when i.amount is null then null else greatest(0,i.amount-coalesce(nullif(a.after_data->>'paid_amount','')::numeric,0)) end remaining_amount,
        coalesce(i.currency, p.currency, 'TRY') currency,
        to_char(a.created_at,'YYYY-MM-DD HH24:MI') occurred_at,(i.source_row_id is not null) source_linked
      from public.audit_logs a left join public.payment_instances i on i.id=a.entity_id left join public.payments p on p.id=i.payment_id
      where a.entity_table='payment_instances' and (a.action in ('mark_paid','mark_unpaid') or a.after_data->>'status' in ('partial','cancelled'))
    ), current_events as (
      select i.id,i.id,coalesce(p.name,'(silinmiş kalem)'),i.status,null,i.status,i.amount,i.paid_amount,
        case when i.amount is null then null else greatest(0,i.amount-coalesce(i.paid_amount,0)) end,
        coalesce(i.currency, p.currency, 'TRY'),
        to_char(coalesce(i.paid_at,i.updated_at),'YYYY-MM-DD HH24:MI'),(i.source_row_id is not null)
      from public.payment_instances i left join public.payments p on p.id=i.payment_id
      where i.status in ('partial','cancelled') and not exists(select 1 from audit_events a where a.instance_id=i.id and a.next_status=i.status)
    ) select * from (select * from audit_events union all select * from current_events) h
    where ($1='' or event_type=$1) and ($2='' or payment_name ilike '%'||$2||'%') and ($3='' or occurred_at::text >= $3) and ($4='' or occurred_at::text <= $4||' 23:59')
    order by occurred_at desc, id desc limit $5 offset $6`,
    [filters.status ?? "", filters.q ?? "", filters.from ?? "", filters.to ?? "", limit, offset],
  );
  return result.rows.map((r) => ({
    id: r.id,
    instanceId: r.instance_id,
    paymentName: r.payment_name,
    eventType: r.event_type,
    previousStatus: r.previous_status,
    nextStatus: r.next_status,
    amount: moneyOrNull(r.amount),
    paidAmount: moneyOrNull(r.paid_amount),
    remainingAmount: moneyOrNull(r.remaining_amount),
    currency: (r.currency as string | undefined) ?? "TRY",
    occurredAt: r.occurred_at,
    sourceLinked: r.source_linked,
  }));
}

export async function paymentHistoryCounts(
  pool: Pick<Pool, "query">,
  filters: { q?: string; from?: string; to?: string } = {},
): Promise<{ total: number; paid: number; partial: number; reopened: number; cancelled: number }> {
  const result = await pool.query<{ event_type: string; n: number }>(
    `with audit_events as (
       select a.id, a.entity_id as instance_id, coalesce(p.name, '(silinmiş kalem)') as payment_name,
              case
                when a.action = 'mark_paid' then 'paid'
                when a.action = 'mark_unpaid' then 'reopened'
                when a.after_data->>'status' = 'partial' then 'partial'
                else 'cancelled'
              end as event_type,
              coalesce(a.after_data->>'status', 'unknown') as next_status,
              to_char(a.created_at, 'YYYY-MM-DD HH24:MI') as occurred_at
       from public.audit_logs a
       left join public.payment_instances i on i.id = a.entity_id
       left join public.payments p on p.id = i.payment_id
       where a.entity_table = 'payment_instances'
         and (a.action in ('mark_paid', 'mark_unpaid') or a.after_data->>'status' in ('partial', 'cancelled'))
     ),
     current_events as (
       select i.id, i.id as instance_id, coalesce(p.name, '(silinmiş kalem)') as payment_name,
              i.status as event_type, i.status as next_status,
              to_char(coalesce(i.paid_at, i.updated_at), 'YYYY-MM-DD HH24:MI') as occurred_at
       from public.payment_instances i
       left join public.payments p on p.id = i.payment_id
       where i.status in ('partial', 'cancelled')
         and not exists (select 1 from audit_events a where a.instance_id = i.id and a.next_status = i.status)
     )
     select event_type, count(*)::int as n
     from (select * from audit_events union all select * from current_events) h
     where ($1 = '' or payment_name ilike '%' || $1 || '%')
       and ($2 = '' or occurred_at::text >= $2)
       and ($3 = '' or occurred_at::text <= $3 || ' 23:59')
     group by event_type`,
    [filters.q ?? "", filters.from ?? "", filters.to ?? ""],
  );
  const byType = new Map(result.rows.map((r) => [r.event_type, intOrNull(r.n) ?? 0]));
  const paid = byType.get("paid") ?? 0;
  const partial = byType.get("partial") ?? 0;
  const reopened = byType.get("reopened") ?? 0;
  const cancelled = byType.get("cancelled") ?? 0;
  return {
    total: paid + partial + reopened + cancelled,
    paid,
    partial,
    reopened,
    cancelled,
  };
}

export { addMonths };
