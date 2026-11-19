import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { safeRedirectPath } from "@/lib/security/redirect";
import type { ActionStatus, DqSeverity } from "@/lib/data-quality/rules";

export interface AssignableUser {
  id: string;
  label: string;
  role: string | null;
}

export interface TaskWithOwner {
  id: string;
  title: string;
  severity: DqSeverity;
  owner: string | null;
  owner_user_id: string | null;
  owner_display: string | null;
  auto_close_on_settlement: boolean;
  due_date: string | null;
  status: ActionStatus;
  source_type: string;
  source_href: string | null;
  related_entity_table: string | null;
  related_entity_id: string | null;
  note: string | null;
  created_at: string;
}

const RESERVED_ACCOUNTS = ["system", "testsprite-qa"];

/**
 * Lists assignable team members under the caller's RLS tier:
 * - Admins see all active `public.users` rows directly.
 * - Non-admin tiers see their own `public.users` row plus active team actors resolved safely
 *   via `public.user_display_label(uuid)` (migration 0098), never bypassing RLS.
 */
export async function listAssignableUsers(pool: Pool | PoolClient): Promise<AssignableUser[]> {
  const byId = new Map<string, AssignableUser>();

  try {
    const direct = await pool.query<{
      id: string;
      username: string;
      display_name: string | null;
      role: string;
    }>(
      `select id::text, username, display_name, role
       from public.users
       where is_active = true
         and username <> all($1::text[])
       order by coalesce(display_name, username) asc`,
      [RESERVED_ACCOUNTS],
    );
    for (const r of direct.rows) {
      byId.set(r.id, {
        id: r.id,
        label: r.display_name?.trim() ? `${r.display_name} (@${r.username})` : r.username,
        role: r.role,
      });
    }
  } catch {
    // Non-selectable tier fallback: continue with user_display_label discovery below.
  }

  try {
    const known = await pool.query<{ uid: string; label: string | null }>(
      `with candidate_ids as (
         select distinct owner_user_id as uid from public.action_items where owner_user_id is not null
         union
         select distinct created_by as uid from public.action_items where created_by is not null
         union
         select distinct requested_by as uid from public.approvals where requested_by is not null
         union
         select distinct decided_by as uid from public.approvals where decided_by is not null
       )
       select uid::text as uid, public.user_display_label(uid) as label
       from candidate_ids
       where uid is not null`,
    );
    for (const r of known.rows) {
      if (!byId.has(r.uid) && r.label && r.label.trim() !== "") {
        byId.set(r.uid, {
          id: r.uid,
          label: r.label.trim(),
          role: null,
        });
      }
    }
  } catch {
    // Ignore if approvals is inaccessible to current role.
  }

  return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label, "tr"));
}

export async function loadTasksWithOwners(
  pool: Pool | PoolClient,
  filter: {
    status?: ActionStatus | "all";
    q?: string;
    ownerUserId?: string;
  },
): Promise<TaskWithOwner[]> {
  const status = filter.status ?? "open";
  const q = (filter.q ?? "").trim();
  const ownerUserId = (filter.ownerUserId ?? "").trim();

  const res = await pool.query<TaskWithOwner>(
    `select
       a.id::text as id,
       a.title,
       a.severity,
       a.owner,
       a.owner_user_id::text as owner_user_id,
       coalesce(public.user_display_label(a.owner_user_id), nullif(btrim(a.owner), '')) as owner_display,
       coalesce(a.auto_close_on_settlement, true) as auto_close_on_settlement,
       to_char(a.due_date, 'YYYY-MM-DD') as due_date,
       a.status,
       a.source_type,
       a.source_href,
       a.related_entity_table,
       a.related_entity_id::text as related_entity_id,
       a.note,
       to_char(a.created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at
     from public.action_items a
     where ($1::text = 'all' or a.status = $1)
       and ($2::text = '' or a.title ilike '%' || $2 || '%' or coalesce(a.note, '') ilike '%' || $2 || '%' or coalesce(a.owner, '') ilike '%' || $2 || '%')
       and (
         $3::text = ''
         or ($3::text = 'unassigned' and a.owner_user_id is null and coalesce(btrim(a.owner), '') = '')
         or a.owner_user_id::text = $3
       )
     order by
       case a.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
       a.due_date nulls last,
       a.created_at desc`,
    [status, q, ownerUserId],
  );

  return res.rows.map((r) => ({
    ...r,
    source_href: r.source_href ? safeRedirectPath(r.source_href, "/insights/tasks") : null,
  }));
}

const assignOwnerSchema = z.object({
  actionId: z.string().uuid("Geçersiz görev kimliği."),
  ownerUserId: z.string().uuid("Geçersiz kullanıcı kimliği.").nullable(),
});

export async function assignActionItemOwner(
  pool: Pool,
  input: { actionId: string; ownerUserId: string | null },
  actorId: string,
): Promise<void> {
  const parsed = assignOwnerSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz atama bilgisi.");
  }
  const { actionId, ownerUserId } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      owner: string | null;
      owner_user_id: string | null;
    }>(
      `select id::text, owner, owner_user_id::text
       from public.action_items
       where id = $1
       for update`,
      [actionId],
    );
    if (before.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Görev kaydı bulunamadı veya yetkiniz yok.");
    }

    const labelRes = ownerUserId
      ? await client.query<{ label: string | null }>(
          `select public.user_display_label($1::uuid) as label`,
          [ownerUserId],
        )
      : { rows: [{ label: null }] };
    const resolvedLabel = labelRes.rows[0]?.label?.trim() || null;

    const upd = await client.query(
      `update public.action_items
       set owner_user_id = $2::uuid,
           owner = $3
       where id = $1`,
      [actionId, ownerUserId, resolvedLabel],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Görev sorumlusu güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "assign_action_owner",
      entityTable: "action_items",
      entityId: actionId,
      before: before.rows[0],
      after: { owner_user_id: ownerUserId, owner: resolvedLabel },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface AutoCloseSettlementResult {
  closedCount: number;
  closedIds: string[];
}

export async function countSettledOpenActionItems(pool: Pool | PoolClient): Promise<number> {
  try {
    const res = await pool.query<{ n: number }>(
      `select count(*)::int as n
       from public.action_items a
       where a.status in ('open', 'in_progress', 'blocked')
         and coalesce(a.auto_close_on_settlement, true) = true
         and a.related_entity_id is not null
         and (
           (a.related_entity_table = 'invoices' and exists (
             select 1 from public.invoices i where i.id = a.related_entity_id and i.status in ('paid', 'cancelled')
           ))
           or (a.related_entity_table = 'checks' and exists (
             select 1 from public.checks c where c.id = a.related_entity_id and c.status in ('collected', 'paid', 'cancelled')
           ))
           or (a.related_entity_table = 'payment_instances' and exists (
             select 1 from public.payment_instances pi where pi.id = a.related_entity_id and pi.status in ('paid', 'cancelled')
           ))
           or (a.related_entity_table = 'loan_installments' and exists (
             select 1 from public.loan_installments li where li.id = a.related_entity_id and li.status in ('paid', 'cancelled')
           ))
           or (a.related_entity_table = 'promise_to_pay' and exists (
             select 1 from public.promise_to_pay ptp where ptp.id = a.related_entity_id and ptp.status in ('kept', 'cancelled')
           ))
         )`,
    );
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Automatically closes open/in_progress/blocked `action_items` with `auto_close_on_settlement = true`
 * whose linked invoice, check, payment_instance, loan_installment, or promise_to_pay has already
 * been settled/paid/collected/cancelled.
 */
export async function autoCloseSettledActionItems(
  pool: Pool,
  actorId: string,
): Promise<AutoCloseSettlementResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const candidates = await client.query<{
      id: string;
      status: string;
      note: string | null;
      related_entity_table: string;
      related_entity_id: string;
      settlement_label: string;
    }>(
      `select
         a.id::text as id,
         a.status,
         a.note,
         a.related_entity_table,
         a.related_entity_id::text as related_entity_id,
         case
           when a.related_entity_table = 'invoices' then (
             select 'Fatura (' || coalesce(i.invoice_no, i.id::text) || ') durumu: ' || i.status
             from public.invoices i
             where i.id = a.related_entity_id and i.status in ('paid', 'cancelled')
           )
           when a.related_entity_table = 'checks' then (
             select 'Çek/Senet (' || coalesce(c.serial_no, c.id::text) || ') durumu: ' || c.status
             from public.checks c
             where c.id = a.related_entity_id and c.status in ('collected', 'paid', 'cancelled')
           )
           when a.related_entity_table = 'payment_instances' then (
             select 'Ödeme planı satırı durumu: ' || pi.status
             from public.payment_instances pi
             where pi.id = a.related_entity_id and pi.status in ('paid', 'cancelled')
           )
           when a.related_entity_table = 'loan_installments' then (
             select 'Kredi taksiti durumu: ' || li.status
             from public.loan_installments li
             where li.id = a.related_entity_id and li.status in ('paid', 'cancelled')
           )
           when a.related_entity_table = 'promise_to_pay' then (
             select 'Ödeme sözü durumu: ' || ptp.status
             from public.promise_to_pay ptp
             where ptp.id = a.related_entity_id and ptp.status in ('kept', 'cancelled')
           )
           else null
         end as settlement_label
       from public.action_items a
       where a.status in ('open', 'in_progress', 'blocked')
         and coalesce(a.auto_close_on_settlement, true) = true
         and a.related_entity_id is not null
         and a.related_entity_table in ('invoices', 'checks', 'payment_instances', 'loan_installments', 'promise_to_pay')
       for update of a`,
    );

    const todayISO = new Date().toISOString().slice(0, 10);
    const closedIds: string[] = [];

    for (const row of candidates.rows) {
      if (!row.settlement_label) continue;
      const autoNote = `Otomatik kapanış (${todayISO}): ${row.settlement_label}`;
      const upd = await client.query(
        `update public.action_items
         set status = 'done',
             note = case
               when note is null or btrim(note) = '' then $2
               else note || E'\n\n' || $2
             end
         where id = $1`,
        [row.id, autoNote],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("FORBIDDEN", "Görev otomatik kapatılamadı.");
      }
      await audit(client, {
        actor: actorId,
        action: "auto_close_settled_action",
        entityTable: "action_items",
        entityId: row.id,
        before: { status: row.status, note: row.note },
        after: {
          status: "done",
          related_entity_table: row.related_entity_table,
          related_entity_id: row.related_entity_id,
          settlement_label: row.settlement_label,
        },
      });
      closedIds.push(row.id);
    }

    await client.query("commit");
    return { closedCount: closedIds.length, closedIds };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
