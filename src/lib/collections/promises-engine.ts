// Faz 25 — promise-to-pay writes and the broken-promise detection job.
//
// Kept in its own file rather than appended to engine.ts because the two have different safety
// stories. engine.ts holds the bad-debt flag, which CLAUDE.md reserves for an explicit human
// decision and which no job may ever touch. This file DOES contain an automated write — and the
// distinction between the two is exactly what must stay visible.
//
// WHAT THE JOB IS ALLOWED TO DO, AND WHY THAT IS NOT A CONTRADICTION
//
// `detectBrokenPromises` marks promises broken automatically. That is permitted where a bad-debt
// flag is not, because the two record different kinds of fact:
//
//   bad debt   a JUDGEMENT that money will never arrive. Requires a person.
//   broken     an OBSERVATION that a date passed and the money did not arrive. Requires a
//              calendar. Nobody's opinion is involved and the underlying fact is already true
//              whether or not this job runs.
//
// The job still never touches a financial record: it does not alter an invoice, an amount, a due
// date, or a payment. It writes a status on the promise table and raises an action_item for a
// human. Every run is audited with automated:true so the trail distinguishes it from an operator.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import {
  brokenPromiseSeverity, brokenPromiseTitle, canTransition, daysLate,
  PROMISE_STATUSES, type PromiseStatus,
} from "./promises";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const createPromiseSchema = z.object({
  partyId: z.uuid(),
  invoiceId: z.uuid().nullable().optional(),
  // Coerced from a form field, but NOT defaulted to 0: an empty amount box means the customer
  // did not name a figure, and that is a different fact from a promise of nothing.
  promisedAmount: z.number().nonnegative().nullable().optional(),
  currency: z.string().trim().min(1).default("TRY"),
  promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Söz verilen tarih YYYY-AA-GG olmalı"),
  channel: z.enum(["phone", "email", "meeting", "message", "other"]).default("phone"),
  note: z.string().trim().max(2000).optional(),
});

export const resolvePromiseSchema = z.object({
  promiseId: z.uuid(),
  status: z.enum(["kept", "broken", "cancelled"]),
  note: z.string().trim().max(2000).optional(),
});

/* ── writes ───────────────────────────────────────────────────────────────────────────── */

/** Record what a customer said. Audited; changes no financial record. */
export async function createPromise(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createPromiseSchema, raw, "Ödeme sözü");
  const client = await pool.connect();
  try {
    await client.query("begin");

    if (input.invoiceId) {
      // A promise pinned to an invoice must belong to the same counterparty, or the score it
      // feeds would credit the wrong customer.
      const inv = await client.query(
        `select party_id, direction from public.invoices where id=$1`, [input.invoiceId]);
      if (inv.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
      if (inv.rows[0].direction !== "sales") {
        throw new DomainError("Ödeme sözü yalnız satış faturası için verilir.");
      }
      if (inv.rows[0].party_id !== input.partyId) {
        throw new DomainError("Fatura başka bir cariye ait — söz yanlış cariye bağlanamaz.");
      }
    }

    const res = await client.query(
      `insert into public.promise_to_pay
         (party_id, invoice_id, promised_amount, currency, promised_date, channel, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id`,
      [input.partyId, input.invoiceId ?? null, input.promisedAmount ?? null, input.currency,
       input.promisedDate, input.channel, input.note ?? null, actorId]);
    const id = res.rows[0].id;

    await audit(client, {
      actor: actorId, action: "create_promise_to_pay",
      entityTable: "promise_to_pay", entityId: id,
      after: {
        partyId: input.partyId, invoiceId: input.invoiceId ?? null,
        promisedAmount: input.promisedAmount ?? null, promisedDate: input.promisedDate,
        channel: input.channel, automated: false,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * An operator resolves a promise by hand.
 *
 * The transition is checked here as well as in the database. That is not redundancy for its own
 * sake: the guard raises a PostgreSQL exception, which reaches the operator as a 500, whereas
 * this produces a sentence they can act on. The guard remains the authority — if this check were
 * ever wrong, the database would still refuse.
 */
export async function resolvePromise(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(resolvePromiseSchema, raw, "Ödeme sözü kararı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, party_id, promised_amount, promised_date
       from public.promise_to_pay where id=$1 for update`, [input.promiseId]);
    if (before.rowCount === 0) throw new DomainError("Ödeme sözü bulunamadı.");
    const current = before.rows[0].status as PromiseStatus;

    if (current === input.status) throw new DomainError("Ödeme sözü zaten bu durumda.");
    if (!canTransition(current, input.status)) {
      throw new DomainError(
        `Bu geçiş yapılamaz: ${current} → ${input.status}. ` +
        `Karara bağlanmış bir söz yeniden açılmaz; yeni bir söz kaydedin.`);
    }

    await client.query(
      `update public.promise_to_pay
         set status=$2, resolved_at=now(), resolved_by=$3, resolution_source='manual',
             note = coalesce($4, note)
       where id=$1`,
      [input.promiseId, input.status, actorId, input.note ?? null]);

    await audit(client, {
      actor: actorId, action: `promise_${input.status}`,
      entityTable: "promise_to_pay", entityId: input.promiseId,
      before: { status: current },
      after: { status: input.status, resolutionSource: "manual", automated: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── the detection job ────────────────────────────────────────────────────────────────── */

export interface BrokenPromiseResult {
  scanned: number;
  markedBroken: number;
  actionItemsCreated: number;
  /** Promise ids marked, so a caller can report specifics rather than a bare count. */
  promiseIds: string[];
}

/**
 * Mark every pending promise whose date has passed as broken, and raise one action_item each.
 *
 * IDEMPOTENT BY CONSTRUCTION, in two independent ways, because this is meant to run repeatedly:
 *   - the promise UPDATE filters on `status='pending'`, so a second run selects nothing;
 *   - the action_item INSERT relies on 0015's partial unique index
 *     (source_type, related_entity_table, related_entity_id) WHERE status is still open, so a
 *     re-run cannot pile duplicate tasks onto the same promise.
 *
 * `todayISO` is a parameter rather than read from the clock inside, so the gate can drive it to a
 * chosen date and assert exact behaviour instead of hoping the machine's date cooperates.
 */
export async function detectBrokenPromises(
  pool: Pool,
  todayISO: string,
  actorId: string,
): Promise<BrokenPromiseResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // Strictly BEFORE today: a promise for today has the rest of the day to be kept.
    const due = await client.query(
      `select p.id, p.party_id, p.promised_amount, p.promised_date, pa.name as party_name
       from public.promise_to_pay p
       join public.parties pa on pa.id = p.party_id
       where p.status = 'pending' and p.promised_date < $1::date
       order by p.promised_date, p.id
       for update of p`,
      [todayISO]);

    let actionItemsCreated = 0;
    const promiseIds: string[] = [];

    for (const row of due.rows) {
      await client.query(
        `update public.promise_to_pay
           set status='broken', resolved_at=now(), resolved_by=null,
               resolution_source='auto_detection'
         where id=$1 and status='pending'`, [row.id]);
      promiseIds.push(row.id);

      const late = daysLate(String(row.promised_date).slice(0, 10), todayISO);
      const severity = brokenPromiseSeverity(late, row.promised_amount);

      // The follow-up work is an action_item — the existing task model, not a second one.
      const item = await client.query(
        `insert into public.action_items
           (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
         values ($1,$2,'open','collection','promise_to_pay',$3,$4,$5)
         on conflict do nothing
         returning id`,
        [brokenPromiseTitle(row.party_name, String(row.promised_date).slice(0, 10)),
         severity, row.id,
         `Söz verilen tarih ${String(row.promised_date).slice(0, 10)}, ${late} gün geçti.`,
         actorId]);
      if ((item.rowCount ?? 0) > 0) actionItemsCreated += 1;

      await audit(client, {
        actor: actorId, action: "promise_broken_detected",
        entityTable: "promise_to_pay", entityId: row.id,
        before: { status: "pending" },
        after: {
          status: "broken", resolutionSource: "auto_detection", lateDays: late,
          promisedAmount: moneyOrNull(row.promised_amount),
          // The trail must be able to answer "did a person decide this?" without inference.
          automated: true, actionItemRaised: (item.rowCount ?? 0) > 0,
        },
      });
    }

    await client.query("commit");
    return {
      scanned: due.rowCount ?? 0,
      markedBroken: promiseIds.length,
      actionItemsCreated,
      promiseIds,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export interface CollectionScoreRow {
  partyId: string;
  partyName: string;
  collectionScore: number;
  scoreBand: string;
  scoreReasons: string[];
  openReceivableAmount: number | null;
  overdueAmount: number | null;
  promisePendingCount: number;
  promiseBrokenCount: number;
  promiseKeptRatio: number | null;
}

export async function loadCollectionScores(pool: Pool, limit = 100): Promise<CollectionScoreRow[]> {
  return cache.withCache(
    `collections:scores:${limit}`,
    async () => {
      const res = await pool.query(
        `select party_id, party_name, collection_score, score_band, score_reasons,
                open_receivable_amount, overdue_amount,
                promise_pending_count, promise_broken_count, promise_kept_ratio
         from public.customer_collection_score
         order by collection_score asc, overdue_amount desc nulls last, party_name asc
         limit $1`, [limit]);
      return res.rows.map((r) => ({
        partyId: r.party_id,
        partyName: r.party_name,
        collectionScore: Number(r.collection_score),
        scoreBand: r.score_band,
        scoreReasons: (r.score_reasons ?? []) as string[],
        openReceivableAmount: moneyOrNull(r.open_receivable_amount),
        overdueAmount: moneyOrNull(r.overdue_amount),
        promisePendingCount: Number(r.promise_pending_count),
        promiseBrokenCount: Number(r.promise_broken_count),
        promiseKeptRatio: r.promise_kept_ratio == null ? null : Number(r.promise_kept_ratio),
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.COLLECTIONS] }
  );
}

export async function loadOpenPromises(pool: Pool, limit = 200) {
  return cache.withCache(
    `collections:openPromises:${limit}`,
    async () => {
      const res = await pool.query(
        `select promise_id, party_id, party_name, invoice_id, promised_amount, currency,
                promised_date, channel, note, days_late, is_overdue
         from public.promise_to_pay_open
         order by promised_date asc, party_name asc
         limit $1`, [limit]);
      return res.rows.map((r) => ({
        promiseId: r.promise_id,
        partyId: r.party_id,
        partyName: r.party_name,
        invoiceId: r.invoice_id,
        promisedAmount: moneyOrNull(r.promised_amount),
        currency: r.currency,
        promisedDate: String(r.promised_date).slice(0, 10),
        channel: r.channel,
        note: r.note,
        daysLate: Number(r.days_late),
        isOverdue: Boolean(r.is_overdue),
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.PROMISES, CACHE_TAGS.COLLECTIONS] }
  );
}

/** Collection follow-up history — action_items, the existing model, filtered to this phase. */
export async function loadCollectionActions(pool: Pool, limit = 100) {
  return cache.withCache(
    `collections:actions:${limit}`,
    async () => {
      const res = await pool.query(
        `select a.id, a.title, a.severity, a.status, a.note, a.created_at,
                a.related_entity_id as promise_id, p.party_id, pa.name as party_name
         from public.action_items a
         left join public.promise_to_pay p
           on a.related_entity_table = 'promise_to_pay' and p.id = a.related_entity_id
         left join public.parties pa on pa.id = p.party_id
         where a.source_type = 'collection' and a.archived_at is null
         order by a.created_at desc
         limit $1`, [limit]);
      return res.rows;
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.COLLECTIONS] }
  );
}

/** Guard for callers that build their own status filters. */
export function isPromiseStatus(value: string): value is PromiseStatus {
  return (PROMISE_STATUSES as readonly string[]).includes(value);
}

export type { PoolClient };
