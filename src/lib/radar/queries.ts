// Read-side queries for radar/calendar/payments pages.
//
// Faz 17: money columns are selected as `numeric` and parsed with @/lib/money instead of
// being cast to `::float8` in SQL. Every query below feeds a typed interface whose amount
// fields are `number | null`, so the parse is not optional bookkeeping — node-postgres hands
// back `numeric` as a STRING, and returning `.rows` unmapped would leave TypeScript believing
// in numbers while the runtime carried strings. `mapInstanceRow` is that boundary.
import type { Pool } from "pg";
import { moneyOrNull, intOrNull } from "@/lib/money";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import {
  addMonths, dayFlags, dayFlagsFromAggregate, type RiskInputInstance, type RiskThresholds,
} from "./rules";

export interface InstanceRow {
  id: string;
  payment_id: string | null;
  name: string;
  due_date: string;
  amount: number | null;
  amount_status: string;
  status: string;
  paid_amount: number | null;
  risk_level: string;
  risk_reasons: string[];
  note: string | null;
  currency?: string;
  direction?: string;
  priority?: string | null;
  category?: string | null;
  source_linked?: boolean;
  flexibility?: "critical" | "flexible" | "optional" | null;
}

const BASE = `
  select i.id, i.payment_id, coalesce(p.name,'(silinmiş kalem)') as name,
         to_char(i.due_date,'YYYY-MM-DD') as due_date,
         i.amount, i.amount_status, i.status,
         i.paid_amount, i.risk_level, i.risk_reasons, i.note,
         i.currency, i.direction, p.priority, p.flexibility_class as flexibility, c.name as category,
         (i.source_row_id is not null or p.source_row_id is not null) as source_linked
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
`;

/** The single decode point for every `BASE` query. Ordering still happens in SQL on the
 * exact `numeric`, so dropping the cast did not change any `order by i.amount` result. */
function mapInstanceRow(r: Record<string, unknown>): InstanceRow {
  return {
    ...(r as unknown as InstanceRow),
    amount: moneyOrNull(r.amount as string | null),
    paid_amount: moneyOrNull(r.paid_amount as string | null),
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
  return cache.withCache(
    `radar:instances:on:${dateISO}`,
    async () => (await pool.query(BASE + `where i.due_date = $1 order by i.amount desc nulls last`, [dateISO])).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export async function instancesBetween(pool: Pool, fromISO: string, toISO: string): Promise<InstanceRow[]> {
  return cache.withCache(
    `radar:instances:between:${fromISO}:${toISO}`,
    async () => (
      await pool.query(BASE + `where i.due_date >= $1 and i.due_date <= $2 order by i.due_date, i.amount desc nulls last`, [fromISO, toISO])
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export async function overdueOpen(pool: Pool, todayISO: string): Promise<InstanceRow[]> {
  return cache.withCache(
    `radar:instances:overdue:${todayISO}`,
    async () => (
      await pool.query(
        BASE + `where i.due_date < $1 and i.status in ('unpaid','partial','planned','late') order by i.due_date`,
        [todayISO],
      )
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

/** One bounded read for the complete Payments overview. */
export async function paymentOverviewInstances(
  pool: Pool,
  todayISO: string,
  futureEndISO: string,
): Promise<InstanceRow[]> {
  return cache.withCache(
    `radar:instances:overview:${todayISO}:${futureEndISO}`,
    async () => (
      await pool.query(
        BASE + `where i.due_date <= $2
          and (i.due_date >= $1 or i.status in ('unpaid','partial','planned','late'))
          order by i.due_date, i.amount desc nulls last`,
        [todayISO, futureEndISO],
      )
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
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
  priorities: InstanceRow[];
}> {
  return cache.withCache(
    `payments:dashboard:${todayISO}:${futureEndISO}`,
    async () => {
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
             category, flexibility_class as flexibility, (source_row_id is not null) as source_linked
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
    priorities: payload.priorities.map(mapInstanceRow),
  };
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.PAYMENT_CALENDAR] },
  );
}

export async function monthSummary(pool: Pool, monthStartISO: string) {
  return cache.withCache(
    `radar:monthSummary:${monthStartISO}`,
    async () => {
      const r = await pool.query(
        // PHASE 2.2 (#2): uc toplam da yalniz TRY; TRY-disi satirlar foreign_count ile doner.
        `select
           coalesce(sum(amount) filter (where amount is not null and currency = 'TRY'),0) as known_total,
           coalesce(sum(amount) filter (where amount is not null and currency = 'TRY' and status in ('unpaid','partial','planned','late')),0) as known_remaining,
           coalesce(sum(coalesce(paid_amount, amount)) filter (where status='paid' and currency = 'TRY'),0) as paid_known,
           count(*) filter (where amount is null and status <> 'cancelled')::int as missing_count,
           count(*) filter (where currency <> 'TRY' and status <> 'cancelled')::int as foreign_count,
           count(*)::int as total_count
         from public.payment_instances where instance_month = $1`,
        [monthStartISO],
      );
      const row = r.rows[0] as Record<string, unknown>;
      return {
        known_total: moneyOrNull(row.known_total as string) ?? 0,
        known_remaining: moneyOrNull(row.known_remaining as string) ?? 0,
        paid_known: moneyOrNull(row.paid_known as string) ?? 0,
        missing_count: intOrNull(row.missing_count as number) ?? 0,
        foreign_count: intOrNull(row.foreign_count as number) ?? 0,
        total_count: intOrNull(row.total_count as number) ?? 0,
      };
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export async function missingAmountInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return cache.withCache(
    `radar:instances:missing:${monthStartISO}`,
    async () => (
      await pool.query(
        BASE + `where i.instance_month = $1 and i.amount is null and i.status in ('unpaid','partial','planned','late') order by i.due_date nulls last`,
        [monthStartISO],
      )
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export async function daylessPayments(pool: Pool) {
  return cache.withCache(
    "radar:payments:dayless",
    async () => (
      await pool.query(
        `select id, name from public.payments
         where status='active' and (recurrence_type='irregular' or due_day is null)
         order by name`,
      )
    ).rows as Array<{ id: string; name: string }>,
    { ttlSeconds: 120, tags: [CACHE_TAGS.PAYMENTS] }
  );
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
  return cache.withCache(
    `radar:instances:month:${monthStartISO}`,
    async () => (
      await pool.query(BASE + `where i.instance_month = $1 order by i.due_date`, [monthStartISO])
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export async function paidInstances(pool: Pool, limit = 100): Promise<InstanceRow[]> {
  return cache.withCache(
    `radar:instances:paid:${limit}`,
    async () => (
      await pool.query(
        BASE + `where i.status = 'paid' order by i.due_date desc limit $1`,
        [limit],
      )
    ).rows.map(mapInstanceRow),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export interface PaymentHistoryEvent {
  id:string; instanceId:string; paymentName:string; eventType:"paid"|"partial"|"reopened"|"cancelled";
  previousStatus:string|null; nextStatus:string; amount:number|null; paidAmount:number|null; remainingAmount:number|null;
  occurredAt:string; sourceLinked:boolean;
}

/**
 * Faz 17 fixed a genuine inconsistency here, not merely a cast: `audit_events` read the same
 * JSON field `after_data->>'paid_amount'` TWO different ways in one select list — as
 * `::float8` for the `paid_amount` column and as `::numeric` inside the `remaining_amount`
 * arithmetic. The two columns could therefore disagree about the same underlying value, so
 * `amount − paid_amount` did not always equal the reported `remaining_amount`. Both now parse
 * as `numeric` and the whole row is decoded once in JS.
 */
export async function paymentHistoryEvents(pool:Pool, filters:{status?:string;q?:string;from?:string;to?:string;limit?:number}={}):Promise<PaymentHistoryEvent[]> {
  const cacheKey = `radar:history:${filters.status ?? ""}:${filters.q ?? ""}:${filters.from ?? ""}:${filters.to ?? ""}:${filters.limit ?? 250}`;
  return cache.withCache(
    cacheKey,
    async () => {
      const result=await pool.query(`
        with audit_events as (
          select a.id,a.entity_id instance_id,coalesce(p.name,'(silinmiş kalem)') payment_name,
            case when a.action='mark_paid' then 'paid' when a.action='mark_unpaid' then 'reopened'
                 when a.after_data->>'status'='partial' then 'partial' else 'cancelled' end event_type,
            a.before_data->>'status' previous_status,coalesce(a.after_data->>'status','unknown') next_status,
            i.amount amount,nullif(a.after_data->>'paid_amount','')::numeric paid_amount,
            case when i.amount is null then null else greatest(0,i.amount-coalesce(nullif(a.after_data->>'paid_amount','')::numeric,0)) end remaining_amount,
            to_char(a.created_at,'YYYY-MM-DD HH24:MI') occurred_at,(i.source_row_id is not null) source_linked
          from public.audit_logs a left join public.payment_instances i on i.id=a.entity_id left join public.payments p on p.id=i.payment_id
          where a.entity_table='payment_instances' and (a.action in ('mark_paid','mark_unpaid') or a.after_data->>'status' in ('partial','cancelled'))
        ), current_events as (
          select i.id,i.id,coalesce(p.name,'(silinmiş kalem)'),i.status,null,i.status,i.amount,i.paid_amount,
            case when i.amount is null then null else greatest(0,i.amount-coalesce(i.paid_amount,0)) end,
            to_char(coalesce(i.paid_at,i.updated_at),'YYYY-MM-DD HH24:MI'),(i.source_row_id is not null)
          from public.payment_instances i left join public.payments p on p.id=i.payment_id
          where i.status in ('partial','cancelled') and not exists(select 1 from audit_events a where a.instance_id=i.id and a.next_status=i.status)
        ) select * from (select * from audit_events union all select * from current_events) h
        where ($1='' or event_type=$1) and ($2='' or payment_name ilike '%'||$2||'%') and ($3='' or occurred_at::text >= $3) and ($4='' or occurred_at::text <= $4||' 23:59')
        order by occurred_at desc limit $5`,[filters.status??"",filters.q??"",filters.from??"",filters.to??"",filters.limit??250]);
      return result.rows.map(r=>({id:r.id,instanceId:r.instance_id,paymentName:r.payment_name,eventType:r.event_type,previousStatus:r.previous_status,nextStatus:r.next_status,amount:moneyOrNull(r.amount),paidAmount:moneyOrNull(r.paid_amount),remainingAmount:moneyOrNull(r.remaining_amount),occurredAt:r.occurred_at,sourceLinked:r.source_linked}));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS] }
  );
}

export { addMonths };
