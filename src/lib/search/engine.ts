// Faz 35 — universal search execution.
//
// ═══ THE SECURITY PROPERTY: SEARCH NEVER GETS ITS OWN CONNECTION ═══
//
// Every function here takes a `Pool` and uses it. It does NOT import `getPool`, does not call
// `getRawPool`, does not call `runAsSystem`, and does not construct a `new Pool`. The caller —
// a page or a route handler that already went through `requireSession()` — passes the
// role-scoped pool from `src/lib/db.ts`, which does `SET ROLE` per checkout (Faz 24B).
//
// This matters because of a specific and very common search-engine mistake: running search over
// one wide/admin connection "for performance", and filtering results afterwards in application
// code. That leaks. A viewer would get rows in their search results that every other screen in
// the product correctly hides from them, and the leak would look like a feature.
//
// Here, RLS does the filtering, in the database, on the same connection every other read uses.
// If a tier cannot see a row, the row never reaches this process. phase35:verify proves it with a
// real `SET ROLE` rather than trusting this comment.
//
// The LLM contributes nothing to any query in this file — see nl.ts.

import type { Pool } from "pg";
import { moneyOrNull } from "@/lib/money";
import {
  SEARCH_ENTITIES, SEARCH_ENTITY_KEYS, assertSafeIdentifiers, hrefFor,
  type SearchEntity, type SearchEntityKey,
} from "./registry";
import { isEmptyIntent, type SearchIntent } from "./nl";

export interface SearchHit {
  entityKey: SearchEntityKey;
  entityLabel: string;
  id: string;
  title: string;
  subtitle: string | null;
  /** Null when the entity has no amount, or the row's amount is unknown. Never 0 as a stand-in. */
  amount: number | null;
  date: string | null;
  href: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** Per-entity counts, so "nothing found" can be distinguished from "not searched". */
  searchedEntities: SearchEntityKey[];
  truncated: boolean;
  intent: SearchIntent;
}

/**
 * Build one entity's SQL.
 *
 * Every identifier comes from the registry and is re-checked by `assertSafeIdentifiers` on the
 * way in. Every VALUE is a bound parameter. There is no code path where caller text becomes part
 * of the statement.
 */
function buildEntityQuery(
  entity: SearchEntity, intent: SearchIntent, limit: number,
): { sql: string; params: unknown[] } {
  assertSafeIdentifiers(entity);

  const params: unknown[] = [];
  const where: string[] = [];

  if (intent.text) {
    // ILIKE over the registry's text columns, one bound parameter shared by all of them.
    params.push(`%${intent.text}%`);
    const idx = params.length;
    const ors = entity.textColumns.map((c) => `${c} ilike $${idx}`);
    where.push(`(${ors.join(" or ")})`);
  }
  if (intent.dateFrom && entity.dateColumn) {
    params.push(intent.dateFrom);
    where.push(`${entity.dateColumn} >= $${params.length}::date`);
  }
  if (intent.dateTo && entity.dateColumn) {
    params.push(intent.dateTo);
    where.push(`${entity.dateColumn} <= $${params.length}::date`);
  }
  if (intent.amountMin != null && entity.amountColumn) {
    params.push(intent.amountMin);
    // abs(): outflows are stored signed in several tables (checks), and "over 10.000 TL" means
    // magnitude, not sign.
    where.push(`abs(${entity.amountColumn}) >= $${params.length}::numeric`);
  }

  const dateSelect = entity.dateColumn
    ? `to_char(${entity.dateColumn}, 'YYYY-MM-DD')`
    : "null::text";
  const amountSelect = entity.amountColumn ?? "null::numeric";

  params.push(limit);
  const sql = `
    select id::text as id,
           ${entity.titleColumn}::text as title,
           ${dateSelect} as row_date,
           ${amountSelect} as row_amount
      from public.${entity.table}
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by ${entity.dateColumn ?? "id"} desc nulls last
     limit $${params.length}`;
  return { sql, params };
}

/**
 * Run a search across the requested entities.
 *
 * `pool` MUST be the role-scoped pool from getPool(). This function deliberately has no way to
 * obtain a connection of its own.
 */
export async function runSearch(
  pool: Pool, intent: SearchIntent, perEntityLimit = 10,
): Promise<SearchOutcome> {
  // An intent with no text and no filters would return "the newest rows of everything", which is
  // not a search result — it is a data dump with a search box in front of it.
  if (isEmptyIntent(intent)) {
    return { hits: [], searchedEntities: [], truncated: false, intent };
  }

  const targets: SearchEntityKey[] = intent.entities.length
    ? intent.entities
    : [...SEARCH_ENTITY_KEYS];

  const results = await Promise.all(targets.map(async (key) => {
    const entity = SEARCH_ENTITIES[key];
    const { sql, params } = buildEntityQuery(entity, intent, perEntityLimit);
    try {
      const r = await pool.query(sql, params);
      return r.rows.map((row): SearchHit => ({
        entityKey: key,
        entityLabel: entity.label,
        id: row.id as string,
        title: (row.title as string | null) ?? "(başlıksız)",
        subtitle: null,
        amount: moneyOrNull(row.row_amount),
        date: (row.row_date as string | null) ?? null,
        href: hrefFor(entity, row.id as string),
      }));
    } catch {
      // A tier without SELECT on a table raises rather than returning rows. That is the RLS/grant
      // layer doing its job, and it must NOT abort the whole search or leak which table refused —
      // the entity simply contributes nothing for this caller.
      return [];
    }
  }));

  const hits = results.flat();
  // Total order, so two runs over the same data never differ: date desc, then entity, then id.
  hits.sort((a, b) =>
    (b.date ?? "").localeCompare(a.date ?? "")
    || a.entityKey.localeCompare(b.entityKey)
    || a.id.localeCompare(b.id));

  return {
    hits,
    searchedEntities: targets,
    truncated: results.some((r) => r.length === perEntityLimit),
    intent,
  };
}

/** Group hits by entity for the palette UI. */
export function groupHits(hits: readonly SearchHit[]): Array<{ key: SearchEntityKey; label: string; hits: SearchHit[] }> {
  const groups = new Map<SearchEntityKey, SearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.entityKey) ?? [];
    list.push(hit);
    groups.set(hit.entityKey, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, label: SEARCH_ENTITIES[key].label, hits: list }))
    .sort((a, b) => a.label.localeCompare(b.label, "tr"));
}
