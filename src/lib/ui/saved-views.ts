// Faz 36 — saved views engine.
//
// Takes the role-scoped Pool from getPool() like every other engine; ownership is enforced by RLS
// (migration 0084), not by a WHERE clause this module remembers to add. A filter is a question,
// so a saved view stores the FILTERS and never the rows they matched — reopening one re-runs it
// against today's data instead of showing a quietly ageing copy.

import { z } from "zod";
import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { globalFilterSchema, type GlobalFilters } from "./filters";

export const MODULE_KEYS = [
  "payments", "cashflow", "finance", "invoices", "documents",
  "production", "scenarios", "insights", "data", "system",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const saveViewSchema = z.object({
  name: z.string().trim().min(1).max(120),
  moduleKey: z.enum(MODULE_KEYS),
  // Validated with the SAME schema the URL parser uses, so a saved view can never contain a
  // filter shape the screen cannot render.
  filters: globalFilterSchema,
  isShared: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export type SaveViewInput = z.infer<typeof saveViewSchema>;

export interface SavedView {
  id: string;
  name: string;
  moduleKey: ModuleKey;
  filters: GlobalFilters;
  isShared: boolean;
  isDefault: boolean;
  isMine: boolean;
}

const mapView = (x: Record<string, unknown>, currentUserId: string | null): SavedView => ({
  id: x.id as string,
  name: x.name as string,
  moduleKey: x.module_key as ModuleKey,
  // A view saved under an older filter vocabulary must not crash the screen: unknown keys are
  // dropped by the schema and the rest still applies.
  filters: globalFilterSchema.safeParse(x.filters ?? {}).data ?? globalFilterSchema.parse({}),
  isShared: Boolean(x.is_shared),
  isDefault: Boolean(x.is_default),
  isMine: currentUserId != null && x.created_by === currentUserId,
});

export async function listSavedViews(
  pool: Pool, moduleKey: ModuleKey, currentUserId: string | null,
): Promise<SavedView[]> {
  // No ownership predicate here on purpose — RLS decides what this connection may see, and a
  // second filter in application code would be a second, drifting opinion about visibility.
  const res = await pool.query(
    `select id, name, module_key, filters, is_shared, is_default, created_by
       from public.saved_views
      where module_key = $1
      order by is_default desc, name`, [moduleKey]);
  return res.rows.map((r) => mapView(r, currentUserId));
}

export async function saveView(
  pool: Pool, raw: unknown, actorId: string,
): Promise<{ id: string; replaced: boolean }> {
  const input = saveViewSchema.parse(raw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (input.isDefault) {
      // At most one default per (owner, module) — the partial unique index in 0084 enforces it,
      // so the previous default is cleared here rather than being left to collide.
      await client.query(
        `update public.saved_views set is_default = false
          where created_by = $1 and module_key = $2 and is_default`, [actorId, input.moduleKey]);
    }
    const res = await client.query(
      `insert into public.saved_views (name, module_key, filters, is_shared, is_default, created_by)
       values ($1, $2, $3::jsonb, $4, $5, $6)
       on conflict (created_by, module_key, name) do update
         set filters = excluded.filters, is_shared = excluded.is_shared,
             is_default = excluded.is_default, updated_at = now()
       returning id, (xmax <> 0) as replaced`,
      [input.name, input.moduleKey, JSON.stringify(input.filters),
       input.isShared, input.isDefault, actorId]);
    const id = res.rows[0].id as string;
    await audit(client, {
      actor: actorId, action: "save_view",
      entityTable: "saved_views", entityId: id,
      after: {
        name: input.name, moduleKey: input.moduleKey,
        isShared: input.isShared, isDefault: input.isDefault,
        // Recorded so an audit reader can see it stored a QUESTION, not a snapshot of answers.
        storesFiltersOnly: true,
      },
    });
    await client.query("commit");
    return { id, replaced: Boolean(res.rows[0].replaced) };
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

export async function deleteView(pool: Pool, id: string, actorId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Judged by AFFECTED ROWS, not by an exception: with no matching policy PostgreSQL deletes
    // zero rows silently, so "it threw" is the wrong success test (the Faz 24B lesson).
    const res = await client.query(`delete from public.saved_views where id = $1 returning id`, [id]);
    if (res.rowCount) {
      await audit(client, {
        actor: actorId, action: "delete_view",
        entityTable: "saved_views", entityId: id, after: { deleted: true },
      });
    }
    await client.query("commit");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

/** The view to apply when a module opens with no filters in the URL. */
export async function defaultViewFor(
  pool: Pool, moduleKey: ModuleKey, currentUserId: string | null,
): Promise<SavedView | null> {
  const views = await listSavedViews(pool, moduleKey, currentUserId);
  // Own default beats a shared one: a personal preference should not be overridden by a colleague.
  return views.find((v) => v.isDefault && v.isMine) ?? views.find((v) => v.isDefault) ?? null;
}
