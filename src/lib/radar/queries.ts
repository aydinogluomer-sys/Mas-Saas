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
}

const BASE = `
  select i.id, i.payment_id, coalesce(p.name,'(silinmiş kalem)') as name,
         to_char(i.due_date,'YYYY-MM-DD') as due_date,
         i.amount::float8 as amount, i.amount_status, i.status,
         i.paid_amount::float8 as paid_amount, i.risk_level, i.risk_reasons, i.note
  from public.payment_instances i
  left join public.payments p on p.id = i.payment_id
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

export { addMonths };
