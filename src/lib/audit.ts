// Faz 18 — the one canonical audit writer.
//
// WHAT IT REPLACES. Thirteen independent `audit()` helpers (ai, analytics/snapshots, archive,
// cashflow, data-quality, external-assumptions, financing, payments, production, radar,
// reports, scenarios, users) plus three server actions that wrote `insert into
// public.audit_logs` inline with no helper at all (finance, payments, imports actions).
// Sixteen files, eighteen insert statements, all writing the same six columns in slightly
// different ways.
//
// WHY AN OPTIONS OBJECT AND NOT radar's POSITIONAL SIGNATURE. radar/engine.ts genuinely had
// the most complete signature and is the behavioural base for this module — nullable actor,
// explicit entityTable, before AND after, an optional created_at override for legacy repair,
// and it returns the inserted id. But copying its *positional* shape would have preserved the
// worst property of the old code:
//
//   payments/engine.ts    audit(client, actor, action, entityTable, entityId, before, after)
//   financing/engine.ts   audit(client, actor, action, entityTable, entityId, after, before?)
//                                                                             ^^^^^  ^^^^^^
//
// Two helpers in the same codebase took before/after in the OPPOSITE order, and nothing but
// care stopped a copy-pasted call from silently recording the new value as the old one. A
// named-field object makes that mistake unrepresentable, which is the entire reason this
// consolidation is worth the diff.
//
// SCOPE DISCIPLINE. This module changes WHERE the insert lives, not WHAT gets written. Every
// call site below was migrated field-for-field: a helper that hardcoded its entity_table now
// passes that same literal, one that always wrote null before still passes no before, and the
// JSON encoding (`JSON.stringify(x ?? null)`) is byte-identical to what each helper did. If a
// call site's audit row changes shape, that is a bug in this phase, not an improvement.

import type { Pool, PoolClient } from "pg";

/**
 * A pool or a pooled client.
 *
 * Both are accepted on purpose. Most callers are mid-transaction and pass a `PoolClient`,
 * which is what makes the audit row commit or roll back together with the mutation it
 * describes. But `finance/actions.ts` wrote its audit row with a bare `pool.query`, outside
 * any transaction, and this phase preserves each call site's behaviour exactly rather than
 * quietly changing transaction semantics while refactoring. That non-atomic call site is a
 * real gap — it is recorded in docs/status-notes.md as a finding for a later phase, not
 * fixed here where it would be invisible inside a 16-file refactor.
 */
export type AuditClient = Pool | PoolClient;

export interface AuditEntry {
  /**
   * `public.users.id` of whoever caused the change. Nullable because system-initiated work
   * (legacy repair, scheduled reconciliation) genuinely has no interactive user — radar's
   * helper was the only one of the thirteen that admitted this, and it was right to.
   */
  actor: string | null;
  /** Verb recorded for the change, e.g. `mark_paid`, `create_loan`, `archive_record`. */
  action: string;
  /** The table the row lives in, e.g. `payment_instances`. */
  entityTable: string;
  /**
   * The affected row. Null is legitimate and meaningful: it marks a batch action that has no
   * single subject (`generate_instances`, `reconcile_instances`, a snapshot refresh).
   */
  entityId?: string | null;
  /** Prior state. Omit for a creation — there was nothing before it. */
  before?: unknown;
  /** Resulting state. Omit only when the action carries no payload worth keeping. */
  after?: unknown;
  /**
   * Overrides `created_at`.
   *
   * Exists for exactly one caller — radar's legacy cancellation repair, which backdates the
   * audit row to the moment the original (unaudited) change actually happened, so the trail
   * reads truthfully instead of claiming the repair date. Do not reach for this anywhere
   * else: an audit row that can freely choose its own timestamp is not an audit trail.
   */
  createdAt?: string;
}

/**
 * Append one row to `public.audit_logs` and return its id.
 *
 * The id is returned because radar's legacy-repair path links a follow-up receipt to the
 * audit row it produced; every other caller simply ignores it. Returning it unconditionally
 * costs nothing — `returning id` on an INSERT the database is performing anyway.
 *
 * `public.audit_logs` has been append-only since migration 0022, enforced by BEFORE triggers
 * that refuse UPDATE/DELETE/TRUNCATE even for a superuser. This function is therefore the
 * only way a row ever enters the trail, and `scripts/phase18-verify.ts` is what keeps it that
 * way: it fails if `insert into public.audit_logs` appears anywhere outside this file.
 */
export async function audit(client: AuditClient, entry: AuditEntry): Promise<string> {
  const { actor, action, entityTable, entityId = null, before, after, createdAt } = entry;

  // Two statements rather than one with a `coalesce($7, now())`: the column default is
  // `now()` and letting it apply is not the same as passing an explicit timestamp, which
  // would pin the row to the statement's clock reading in a way the default does not.
  const result = createdAt
    ? await client.query<{ id: string }>(
        `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data, created_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [actor, action, entityTable, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null), createdAt],
      )
    : await client.query<{ id: string }>(
        `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [actor, action, entityTable, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
      );

  return result.rows[0].id;
}
