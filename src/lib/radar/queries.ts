// Read-side queries for radar/calendar/payments pages.
import type { Pool } from "pg";
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
         i.amount::float8 as amount, i.amount_status, i.status,
         i.paid_amount::float8 as paid_amount, i.risk_level, i.risk_reasons, i.note,
         i.currency, i.direction, p.priority, p.flexibility_class as flexibility, c.name as category,
         (i.source_row_id is not null or p.source_row_id is not null) as source_linked
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
  left join public.categories c on c.id = p.category_id
`;

export async function instancesOn(pool: Pool, dateISO: string): Promise<InstanceRow[]> {
  return (await pool.query(BASE + `where i.due_date = $1 order by i.amount desc nulls last`, [dateISO])).rows;
}

export async function instancesBetween(pool: Pool, fromISO: string, toISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(BASE + `where i.due_date >= $1 and i.due_date <= $2 order by i.due_date, i.amount desc nulls last`, [fromISO, toISO])
  ).rows;
}

export async function overdueOpen(pool: Pool, todayISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.due_date < $1 and i.status in ('unpaid','partial','planned','late') order by i.due_date`,
      [todayISO],
    )
  ).rows;
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
  ).rows;
}

export async function monthSummary(pool: Pool, monthStartISO: string) {
  const r = await pool.query(
    `select
       coalesce(sum(amount) filter (where amount is not null),0)::float8 as known_total,
       coalesce(sum(amount) filter (where amount is not null and status in ('unpaid','partial','planned','late')),0)::float8 as known_remaining,
       coalesce(sum(coalesce(paid_amount, amount)) filter (where status='paid'),0)::float8 as paid_known,
       count(*) filter (where amount is null and status <> 'cancelled')::int as missing_count,
       count(*)::int as total_count
     from public.payment_instances where instance_month = $1`,
    [monthStartISO],
  );
  return r.rows[0] as {
    known_total: number; known_remaining: number; paid_known: number;
    missing_count: number; total_count: number;
  };
}

export async function missingAmountInstances(pool: Pool, monthStartISO: string): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.instance_month = $1 and i.amount is null and i.status in ('unpaid','partial','planned','late') order by i.due_date nulls last`,
      [monthStartISO],
    )
  ).rows;
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
  ).rows;
}

export async function paidInstances(pool: Pool, limit = 100): Promise<InstanceRow[]> {
  return (
    await pool.query(
      BASE + `where i.status = 'paid' order by i.due_date desc limit $1`,
      [limit],
    )
  ).rows;
}

export interface PaymentHistoryEvent {
  id:string; instanceId:string; paymentName:string; eventType:"paid"|"partial"|"reopened"|"cancelled";
  previousStatus:string|null; nextStatus:string; amount:number|null; paidAmount:number|null; remainingAmount:number|null;
  occurredAt:string; sourceLinked:boolean;
}

export async function paymentHistoryEvents(pool:Pool, filters:{status?:string;q?:string;from?:string;to?:string;limit?:number}={}):Promise<PaymentHistoryEvent[]> {
  const result=await pool.query(`
    with audit_events as (
      select a.id,a.entity_id instance_id,coalesce(p.name,'(silinmiş kalem)') payment_name,
        case when a.action='mark_paid' then 'paid' when a.action='mark_unpaid' then 'reopened'
             when a.after_data->>'status'='partial' then 'partial' else 'cancelled' end event_type,
        a.before_data->>'status' previous_status,coalesce(a.after_data->>'status','unknown') next_status,
        i.amount::float8 amount,nullif(a.after_data->>'paid_amount','')::float8 paid_amount,
        case when i.amount is null then null else greatest(0,i.amount-coalesce(nullif(a.after_data->>'paid_amount','')::numeric,0))::float8 end remaining_amount,
        to_char(a.created_at,'YYYY-MM-DD HH24:MI') occurred_at,(i.source_row_id is not null) source_linked
      from public.audit_logs a left join public.payment_instances i on i.id=a.entity_id left join public.payments p on p.id=i.payment_id
      where a.entity_table='payment_instances' and (a.action in ('mark_paid','mark_unpaid') or a.after_data->>'status' in ('partial','cancelled'))
    ), current_events as (
      select i.id,i.id,coalesce(p.name,'(silinmiş kalem)'),i.status,null,i.status,i.amount::float8,i.paid_amount::float8,
        case when i.amount is null then null else greatest(0,i.amount-coalesce(i.paid_amount,0))::float8 end,
        to_char(coalesce(i.paid_at,i.updated_at),'YYYY-MM-DD HH24:MI'),(i.source_row_id is not null)
      from public.payment_instances i left join public.payments p on p.id=i.payment_id
      where i.status in ('partial','cancelled') and not exists(select 1 from audit_events a where a.instance_id=i.id and a.next_status=i.status)
    ) select * from (select * from audit_events union all select * from current_events) h
    where ($1='' or event_type=$1) and ($2='' or payment_name ilike '%'||$2||'%') and ($3='' or occurred_at::text >= $3) and ($4='' or occurred_at::text <= $4||' 23:59')
    order by occurred_at desc limit $5`,[filters.status??"",filters.q??"",filters.from??"",filters.to??"",filters.limit??250]);
  return result.rows.map(r=>({id:r.id,instanceId:r.instance_id,paymentName:r.payment_name,eventType:r.event_type,previousStatus:r.previous_status,nextStatus:r.next_status,amount:r.amount,paidAmount:r.paid_amount,remainingAmount:r.remaining_amount,occurredAt:r.occurred_at,sourceLinked:r.source_linked}));
}

export { addMonths };
