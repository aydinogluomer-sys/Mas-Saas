// Read-side queries for radar/calendar/payments pages.
//
// Faz 17: money columns are selected as `numeric` and parsed with @/lib/money instead of
// being cast to `::float8` in SQL. Every query below feeds a typed interface whose amount
// fields are `number | null`, so the parse is not optional bookkeeping — node-postgres hands
// back `numeric` as a STRING, and returning `.rows` unmapped would leave TypeScript believing
// in numbers while the runtime carried strings. `mapInstanceRow` is that boundary.
import type { Pool } from "pg";
import { moneyOrNull, intOrNull } from "@/lib/money";
import { addMonths, dayFlags, type RiskThresholds } from "./rules";

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

export async function instancesOn(pool: Pool, dateISO: string): Promise<InstanceRow[]> {
  return (await pool.query(BASE + `where i.due_date = $1 order by i.amount desc nulls last`, [dateISO])).rows.map(mapInstanceRow);
}

export async function instancesBetween(pool: Pool, fromISO: string, toISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(BASE + `where i.due_date >= $1 and i.due_date <= $2 order by i.due_date, i.amount desc nulls last`, [fromISO, toISO])
  ).rows.map(mapInstanceRow);
}

export async function overdueOpen(pool: Pool, todayISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.due_date < $1 and i.status in ('unpaid','partial','planned','late') order by i.due_date`,
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
    ), buckets as (
      select to_char(due_date,'YYYY-MM-DD') as due_date,
             case when due_date < $1::date then 'overdue' when status='partial' then 'partial' else 'planned' end as pressure_status,
             count(*)::int as record_count,
             coalesce(sum(remaining) filter (where remaining is not null),0) as known_amount,
             count(*) filter (where remaining is null)::int as unknown_count,
             max(remaining) filter (where remaining is not null) as max_amount,
             count(*) filter (where currency <> 'TRY')::int as foreign_currency_count,
             count(*) filter (where decision_flexibility='critical')::int as critical_count,
             count(*) filter (where decision_flexibility='flexible')::int as flexible_count,
             count(*) filter (where decision_flexibility='optional')::int as optional_count,
             count(*) filter (where decision_flexibility='unclassified')::int as unclassified_count
      from active group by due_date, pressure_status
    ), flexibility as (
      select decision_flexibility, count(*)::int as record_count,
             count(distinct coalesce(payment_id,id))::int as template_count,
             coalesce(sum(remaining) filter (where remaining is not null),0) as known_amount,
             count(*) filter (where remaining is null)::int as unknown_count
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
               case risk_level when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end desc,
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
      foreignCurrencyCount: Number(row.foreign_currency_count),
      criticalCount: Number(row.critical_count), flexibleCount: Number(row.flexible_count),
      optionalCount: Number(row.optional_count), unclassifiedCount: Number(row.unclassified_count),
    })),
    flexibility: payload.flexibility.map((row) => ({
      id: row.decision_flexibility as PaymentDashboardFlexibility["id"],
      count: Number(row.record_count), templateCount: Number(row.template_count),
      knownAmount: moneyOrNull(row.known_amount as string | number | null) ?? 0, unknownCount: Number(row.unknown_count),
    })),
    watchList: payload.watch_list.map((row) => ({
      ...mapInstanceRow(row), remaining: moneyOrNull(row.remaining as string | number | null),
      daysOverdue: Number(row.days_overdue),
      decisionFlexibility: row.decision_flexibility as PaymentDashboardFlexibility["id"],
    })),
    priorities: payload.priorities.map(mapInstanceRow),
  };
}

export async function monthSummary(pool: Pool, monthStartISO: string) {
  const r = await pool.query(
    `select
       coalesce(sum(amount) filter (where amount is not null),0) as known_total,
       coalesce(sum(amount) filter (where amount is not null and status in ('unpaid','partial','planned','late')),0) as known_remaining,
       coalesce(sum(coalesce(paid_amount, amount)) filter (where status='paid'),0) as paid_known,
       count(*) filter (where amount is null and status <> 'cancelled')::int as missing_count,
       count(*)::int as total_count
     from public.payment_instances where instance_month = $1`,
    [monthStartISO],
  );
  // The three sums are computed exactly by Postgres and only lose their exactness on the way
  // into JS; `money()` rounds once at TL scale instead of letting float8 do it in binary.
  // The two counts keep their `::int` casts — int4 already arrives as a JS number.
  const row = r.rows[0] as Record<string, unknown>;
  return {
    known_total: moneyOrNull(row.known_total as string) ?? 0,
    known_remaining: moneyOrNull(row.known_remaining as string) ?? 0,
    paid_known: moneyOrNull(row.paid_known as string) ?? 0,
    missing_count: intOrNull(row.missing_count as number) ?? 0,
    total_count: intOrNull(row.total_count as number) ?? 0,
  };
}

export async function missingAmountInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.instance_month = $1 and i.amount is null and i.status in ('unpaid','partial','planned','late') order by i.due_date nulls last`,
      [monthStartISO],
    )
  ).rows.map(mapInstanceRow);
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
    const f = dayFlags(list.map((x) => ({ id: x.id, dueDate: x.due_date, amount: x.amount, status: x.status })), t);
    if (f.cluster || f.critical || f.large) out.push({ date, ...f });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function monthInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(BASE + `where i.instance_month = $1 order by i.due_date`, [monthStartISO])
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
}

export { addMonths };
