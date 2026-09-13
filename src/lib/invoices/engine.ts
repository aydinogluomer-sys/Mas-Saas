// Faz 21 — invoice engine.
//
// Inherited rules, applied rather than re-argued:
//   Faz 17 — money crosses the SQL/JS boundary through @/lib/money, never a ::float8 cast.
//   Faz 18 — every mutation records through the canonical audit(), in the same transaction as
//            the change, and input is parsed with a Zod schema at the boundary.
//   Faz 19 — nothing here creates a counterparty. An invoice needs a party that already exists.
//   Faz 20 — a bank match does not mutate a financial record; the same separation holds here.
//
// THE RULE THIS PHASE ADDS: cancellation is never a silent status change. `cancelInvoice`
// writes the reversal record and flips the status in ONE transaction, and migration 0046's
// deferred constraint trigger refuses the commit if the record is missing — so even a future
// code path that forgets cannot produce a bare `status='cancelled'`.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import {
  canTransition, computeLineTotals, invoiceDedupeKey, sumLineTotals,
  type InvoiceStatus,
} from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

const lineSchema = z.object({
  description: z.string().trim().min(1),
  quantity: z.coerce.number().refine((n) => Number.isFinite(n), "Miktar sayı olmalı"),
  unitPrice: z.coerce.number().refine((n) => Number.isFinite(n), "Birim fiyat sayı olmalı"),
  taxRate: z.coerce.number().min(0).default(0),
  unit: z.string().trim().min(1).optional(),
  productId: z.uuid().optional(),
  costCenterId: z.uuid().optional(),
  projectId: z.uuid().optional(),
});

export const createInvoiceSchema = z.object({
  direction: z.enum(["sales", "purchase"]),
  invoiceNo: z.string().trim().min(1),
  partyId: z.uuid(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG olmalı"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  costCenterId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  notes: z.string().trim().min(1).optional(),
  lines: z.array(lineSchema).min(1, "En az bir kalem gerekli"),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const cancelInvoiceSchema = z.object({
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, "İptal gerekçesi en az 3 karakter olmalı"),
});

export const statusChangeSchema = z.object({
  invoiceId: z.uuid(),
  status: z.enum(["draft", "open", "partial", "paid", "closed", "cancelled"]),
  reason: z.string().trim().min(3).optional(),
});

export const recordPaymentSchema = z.object({
  invoiceId: z.uuid(),
  amount: z.coerce.number().positive("Tutar sıfırdan büyük olmalı"),
});

/* ── create ───────────────────────────────────────────────────────────────────────────── */

/**
 * Create a DRAFT invoice with its lines.
 *
 * Always draft: 0044 makes `draft` the only editable state, so creating anything else would
 * mean writing a document that can never be corrected. Issuing is a separate, audited act
 * (`changeInvoiceStatus` to 'open').
 *
 * The header totals are DERIVED from the lines, never accepted from the caller. A caller-
 * supplied total that disagreed with its lines would violate 0044's `gross = net + tax` CHECK
 * or, worse, satisfy it while disagreeing with the detail underneath.
 */
export async function createInvoice(pool: Pool, raw: unknown, actorId: string): Promise<{ invoiceId: string }> {
  const input = parseOrThrow(createInvoiceSchema, raw, "Fatura formu");

  const lineTotals = input.lines.map((l) =>
    computeLineTotals({ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate }));
  const header = sumLineTotals(lineTotals);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const party = await client.query(`select id, name from public.parties where id=$1`, [input.partyId]);
    if (party.rowCount === 0) throw new DomainError("Karşı taraf bulunamadı.");

    const dedupe = invoiceDedupeKey({
      partyId: input.partyId, invoiceNo: input.invoiceNo,
      grossAmount: header.grossAmount, issueDate: input.issueDate,
    });

    const ins = await client.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, cost_center_id, project_id, order_id,
          issue_date, due_date, currency, net_amount, tax_amount, gross_amount,
          dedupe_hash, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11::numeric,$12::numeric,$13,$14)
       returning id`,
      [
        input.direction, input.invoiceNo, input.partyId, input.costCenterId ?? null,
        input.projectId ?? null, input.orderId ?? null, input.issueDate, input.dueDate ?? null,
        input.currency, header.netAmount, header.taxAmount, header.grossAmount, dedupe,
        input.notes ?? null,
      ],
    );
    const invoiceId = ins.rows[0].id;

    for (const [i, line] of input.lines.entries()) {
      const t = lineTotals[i];
      await client.query(
        `insert into public.invoice_lines
           (invoice_id, line_no, product_id, description, quantity, unit_price, unit, tax_rate,
            net_amount, tax_amount, gross_amount, cost_center_id, project_id)
         values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12,$13)`,
        [
          invoiceId, i + 1, line.productId ?? null, line.description, line.quantity,
          line.unitPrice, line.unit ?? null, line.taxRate,
          t.netAmount, t.taxAmount, t.grossAmount,
          line.costCenterId ?? null, line.projectId ?? null,
        ],
      );
    }

    await audit(client, {
      actor: actorId, action: "create_invoice", entityTable: "invoices", entityId: invoiceId,
      before: null,
      after: {
        direction: input.direction, invoiceNo: input.invoiceNo, partyId: input.partyId,
        gross: header.grossAmount, lineCount: input.lines.length, status: "draft",
      },
    });

    await client.query("commit");
    return { invoiceId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── status ───────────────────────────────────────────────────────────────────────────── */

/**
 * Move an invoice through its lifecycle.
 *
 * Refuses 'cancelled' outright: cancellation must go through `cancelInvoice` so a reversal
 * record is written. Without this guard a caller could reach the terminal state through the
 * generic path, and 0046's deferred trigger would abort the whole transaction with a database
 * message instead of a sentence the operator can act on.
 */
export async function changeInvoiceStatus(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(statusChangeSchema, raw, "Fatura durumu");
  if (input.status === "cancelled") {
    throw new DomainError("İptal bu yoldan yapılamaz — iptal, gerekçesiyle birlikte reversal kaydı yazar.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, closed_at, close_reason from public.invoices where id=$1 for update`,
      [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const current = before.rows[0].status as InvoiceStatus;

    // Checked in the application too, so the operator gets a readable refusal rather than the
    // trigger's raw exception. The database stays the authority.
    if (!canTransition(current, input.status)) {
      throw new DomainError(`'${current}' durumundan '${input.status}' durumuna geçilemez.`);
    }
    if (input.status === "closed" && !input.reason) {
      throw new DomainError("Kapatma gerekçesi zorunlu.");
    }

    await client.query(
      `update public.invoices
         set status=$2,
             closed_at = case when $2='closed' then now() else null end,
             close_reason = case when $2='closed' then $3 else null end
       where id=$1`,
      [input.invoiceId, input.status, input.reason ?? null]);

    await audit(client, {
      actor: actorId, action: "change_invoice_status", entityTable: "invoices",
      entityId: input.invoiceId, before: before.rows[0],
      after: { status: input.status, reason: input.reason ?? null },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Record a settlement against an invoice.
 *
 * Moves `paid_amount` and lets the status follow, but does NOT touch any bank transaction or
 * payment instance. Faz 22 owns the linkage between a settlement and the money that produced
 * it; this phase only records that the invoice was settled.
 */
export async function recordInvoicePayment(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(recordPaymentSchema, raw, "Tahsilat kaydı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, gross_amount, paid_amount from public.invoices where id=$1 for update`,
      [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const row = before.rows[0];
    const status = row.status as InvoiceStatus;
    if (status === "draft") throw new DomainError("Düzenlenmemiş faturaya tahsilat işlenemez.");
    if (status === "cancelled") throw new DomainError("İptal edilmiş faturaya tahsilat işlenemez.");

    const gross = moneyOrNull(row.gross_amount) ?? 0;
    const paidBefore = moneyOrNull(row.paid_amount) ?? 0;

    const updated = await client.query<{ paid_amount: string; status: string }>(
      `update public.invoices set paid_amount = paid_amount + $2::numeric where id=$1
       returning paid_amount, status`,
      [input.invoiceId, input.amount]);
    const paidAfter = moneyOrNull(updated.rows[0].paid_amount) ?? 0;

    // The suggestion is computed from the NEW total, then applied only if the lifecycle allows
    // it — the guard remains the authority on what is legal.
    const suggested: InvoiceStatus = paidAfter <= 0 ? "open" : paidAfter >= gross ? "paid" : "partial";
    if (suggested !== status && canTransition(status, suggested)) {
      await client.query(`update public.invoices set status=$2 where id=$1`, [input.invoiceId, suggested]);
    }

    await audit(client, {
      actor: actorId, action: "record_invoice_payment", entityTable: "invoices",
      entityId: input.invoiceId,
      before: { status, paid_amount: paidBefore },
      after: {
        status: canTransition(status, suggested) ? suggested : status,
        paid_amount: paidAfter, applied: input.amount,
        // Recorded explicitly: this phase does not link a settlement to the bank movement or
        // payment instance that produced it. That is Faz 22.
        linked_settlement_source: null,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── cancellation via a linked reversal record ────────────────────────────────────────── */

/**
 * Cancel an invoice, writing the reversal record that makes the cancellation self-describing.
 *
 * One transaction, both writes. The snapshot freezes what the invoice and its lines SAID at the
 * moment of voiding — `invoices` is immutable after issue, but its history is not otherwise
 * self-describing, and a reader a year later needs the document, not just a status flag.
 *
 * 0046's deferred constraint trigger is the backstop: if this function (or any future one)
 * flipped the status without the record, the COMMIT would fail.
 */
export async function cancelInvoice(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(cancelInvoiceSchema, raw, "Fatura iptali");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select * from public.invoices where id=$1 for update`, [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const inv = before.rows[0];
    const status = inv.status as InvoiceStatus;
    if (status === "cancelled") throw new DomainError("Fatura zaten iptal edilmiş.");
    if (!canTransition(status, "cancelled")) {
      throw new DomainError(
        `'${status}' durumundaki bir fatura iptal edilemez. Kapatılmış faturayı önce yeniden açın.`,
      );
    }

    const lines = await client.query(`select * from public.invoice_lines where invoice_id=$1 order by line_no`,
      [input.invoiceId]);

    await client.query(
      `insert into public.invoice_reversals
         (invoice_id, reversal_type, reason, reversed_amount, snapshot, created_by)
       values ($1,'cancellation',$2,$3::numeric,$4::jsonb,$5)`,
      [
        input.invoiceId, input.reason, moneyOrNull(inv.gross_amount) ?? 0,
        JSON.stringify({ invoice: inv, lines: lines.rows }), actorId,
      ],
    );

    await client.query(
      `update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason=$2 where id=$1`,
      [input.invoiceId, input.reason]);

    await audit(client, {
      actor: actorId, action: "cancel_invoice", entityTable: "invoices", entityId: input.invoiceId,
      before: { status, gross_amount: moneyOrNull(inv.gross_amount) },
      after: { status: "cancelled", reason: input.reason, reversal_record_written: true },
    });

    // Force the deferred trigger to run inside this transaction, so a violation surfaces here
    // rather than at an ambiguous later COMMIT.
    await client.query("set constraints all immediate");
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export interface InvoiceRow {
  id: string;
  direction: "sales" | "purchase";
  invoiceNo: string;
  partyId: string;
  partyName: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  paidAmount: number;
  remaining: number;
  status: InvoiceStatus;
  lineCount: number;
}

export async function listInvoices(
  pool: Pool,
  opts: { status?: string; direction?: string; limit?: number } = {},
): Promise<InvoiceRow[]> {
  const r = await pool.query(
    `select i.id::text, i.direction, i.invoice_no, i.party_id::text, pa.name as party_name,
            to_char(i.issue_date,'YYYY-MM-DD') as issue_date,
            to_char(i.due_date,'YYYY-MM-DD') as due_date,
            i.currency, i.net_amount, i.tax_amount, i.gross_amount, i.paid_amount,
            (i.gross_amount - i.paid_amount) as remaining, i.status,
            (select count(*) from public.invoice_lines l where l.invoice_id = i.id)::int as line_count
     from public.invoices i
     join public.parties pa on pa.id = i.party_id
     where ($1='' or i.status=$1) and ($2='' or i.direction=$2)
     order by i.issue_date desc, i.invoice_no
     limit $3`,
    [opts.status ?? "", opts.direction ?? "", opts.limit ?? 200],
  );
  return r.rows.map((x) => ({
    id: x.id, direction: x.direction, invoiceNo: x.invoice_no, partyId: x.party_id,
    partyName: x.party_name, issueDate: x.issue_date, dueDate: x.due_date, currency: x.currency,
    netAmount: moneyOrNull(x.net_amount) ?? 0, taxAmount: moneyOrNull(x.tax_amount) ?? 0,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0, paidAmount: moneyOrNull(x.paid_amount) ?? 0,
    remaining: moneyOrNull(x.remaining) ?? 0, status: x.status as InvoiceStatus,
    lineCount: intOrNull(x.line_count) ?? 0,
  }));
}

export async function loadInvoiceLines(pool: Pool, invoiceId: string) {
  const r = await pool.query(
    `select id::text, line_no, description, quantity, unit_price, unit, tax_rate,
            net_amount, tax_amount, gross_amount
     from public.invoice_lines where invoice_id=$1 order by line_no`, [invoiceId]);
  return r.rows.map((x) => ({
    id: x.id, lineNo: intOrNull(x.line_no) ?? 0, description: x.description,
    // quantity/unitPrice/taxRate are numeric(_,4) — RATE precision, not TL scale.
    quantity: rateOrNull(x.quantity) ?? 0, unitPrice: rateOrNull(x.unit_price) ?? 0,
    unit: x.unit, taxRate: rateOrNull(x.tax_rate) ?? 0,
    netAmount: moneyOrNull(x.net_amount) ?? 0, taxAmount: moneyOrNull(x.tax_amount) ?? 0,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0,
  }));
}

export async function loadOpenItems(pool: Pool, limit = 200) {
  const r = await pool.query(
    `select id::text, direction, invoice_no, party_name,
            to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            gross_amount, paid_amount, remaining, status, days_overdue, ageing_bucket, currency
     from public.invoice_open_items
     order by (due_date is null), due_date, remaining desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    id: x.id, direction: x.direction, invoiceNo: x.invoice_no, partyName: x.party_name,
    issueDate: x.issue_date, dueDate: x.due_date,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0, paidAmount: moneyOrNull(x.paid_amount) ?? 0,
    remaining: moneyOrNull(x.remaining) ?? 0, status: x.status as InvoiceStatus,
    daysOverdue: intOrNull(x.days_overdue), ageingBucket: x.ageing_bucket as string,
    currency: String(x.currency ?? ""),
  }));
}

export async function loadDuplicateSuspects(pool: Pool, limit = 50) {
  const r = await pool.query(
    `select invoice_id::text, other_invoice_id::text, party_name, invoice_no, other_invoice_no,
            gross_amount, to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(other_issue_date,'YYYY-MM-DD') as other_issue_date, signal, date_gap_days
     from public.invoice_duplicate_suspects order by signal, gross_amount desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    invoiceId: x.invoice_id, otherInvoiceId: x.other_invoice_id, partyName: x.party_name,
    invoiceNo: x.invoice_no, otherInvoiceNo: x.other_invoice_no,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0, issueDate: x.issue_date,
    otherIssueDate: x.other_issue_date, signal: x.signal as string,
    dateGapDays: intOrNull(x.date_gap_days) ?? 0,
  }));
}

export async function loadLineMismatches(pool: Pool, limit = 50) {
  const r = await pool.query(
    `select invoice_id::text, invoice_no, header_gross, lines_gross, difference, line_count
     from public.invoice_line_mismatches order by abs(difference) desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    invoiceId: x.invoice_id, invoiceNo: x.invoice_no,
    headerGross: moneyOrNull(x.header_gross) ?? 0, linesGross: moneyOrNull(x.lines_gross) ?? 0,
    difference: moneyOrNull(x.difference) ?? 0, lineCount: intOrNull(x.line_count) ?? 0,
  }));
}

export async function loadReversals(pool: Pool, invoiceId: string) {
  const r = await pool.query(
    `select id::text, reversal_type, reason, reversed_amount,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.invoice_reversals where invoice_id=$1 order by created_at desc`, [invoiceId]);
  return r.rows.map((x) => ({
    id: x.id, reversalType: x.reversal_type, reason: x.reason,
    reversedAmount: moneyOrNull(x.reversed_amount) ?? 0, createdAt: x.created_at,
  }));
}

/** Counterparties an invoice may be issued to. Read-only; creation stays in Faz 19's action. */
export async function loadInvoiceParties(pool: Pool, limit = 500) {
  const r = await pool.query(
    `select id::text, name, party_type from public.parties where is_active order by name limit $1`,
    [limit]);
  return r.rows as Array<{ id: string; name: string; party_type: string }>;
}

export type { PoolClient };
