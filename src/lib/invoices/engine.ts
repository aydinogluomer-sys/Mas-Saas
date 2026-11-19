// Faz 21 + Faz 48 (D2) + Faz 61 (M-32) — invoice engine (multi-line discount/withholding, payment_instances link, inline bank/cash TDHP + 646/656 FX settlement).

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  evaluateAndRequestIfNeededWithClient,
  evaluateRulesWithClient,
} from "@/lib/approvals/engine";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  postBalancedJournalEntry,
  safeReverseJournalForSourceWithClient,
  safeSyncDomainEventWithClient,
} from "@/lib/ledger/posting-engine";
import { decimal, intOrNull, money, moneyOrNull, mul, rateOrNull, sumDecimal } from "@/lib/money";
import { resolvePromisesForPaidInvoicesWithClient } from "@/lib/receivables/engine";
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
  discountRate: z.coerce.number().min(0).max(1).default(0),
  incomeTaxWithholdingRate: z.coerce.number().min(0).max(1).default(0),
  unit: z.string().trim().min(1).optional(),
  productId: z.uuid().optional(),
  costCenterId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
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
  departmentId: z.uuid().optional(),
  orderId: z.uuid().optional(),
  linkedPaymentInstanceId: z.uuid().optional(),
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
  cashAccountId: z.uuid().optional(),
  fxRate: z.coerce.number().positive().optional(),
});

interface ExtendedLineCalc {
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  discountRate: number;
  discountAmount: number;
  incomeTaxWithholdingRate: number;
  incomeTaxWithholdingAmount: number;
}

function computeExtendedLine(l: z.infer<typeof lineSchema>): ExtendedLineCalc {
  const discRate = l.discountRate ?? 0;
  const stopajRate = l.incomeTaxWithholdingRate ?? 0;
  if (discRate === 0 && stopajRate === 0) {
    const base = computeLineTotals({ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate });
    return {
      ...base,
      discountRate: 0,
      discountAmount: 0,
      incomeTaxWithholdingRate: 0,
      incomeTaxWithholdingAmount: 0,
    };
  }
  const rawNet = mul(l.quantity, l.unitPrice).round(2);
  const discountAmt = rawNet.times(decimal(discRate)).round(2);
  const netRounded = rawNet.minus(discountAmt).round(2);
  const taxRounded = netRounded.times(decimal(l.taxRate)).round(2);
  const stopajAmt = netRounded.times(decimal(stopajRate)).round(2);
  return {
    netAmount: money(netRounded.toString()),
    taxAmount: money(taxRounded.toString()),
    grossAmount: money(netRounded.plus(taxRounded).toString()),
    discountRate: discRate,
    discountAmount: money(discountAmt.toString()),
    incomeTaxWithholdingRate: stopajRate,
    incomeTaxWithholdingAmount: money(stopajAmt.toString()),
  };
}

/* ── create ───────────────────────────────────────────────────────────────────────────── */

export async function createInvoice(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ invoiceId: string; approvalId?: string | null }> {
  const input = parseOrThrow(createInvoiceSchema, raw, "Fatura formu");

  const extendedLines = input.lines.map(computeExtendedLine);
  const header = sumLineTotals(extendedLines);
  const discountTotal = money(sumDecimal(extendedLines.map((l) => l.discountAmount)).toString());
  const withholdingTotal = money(sumDecimal(extendedLines.map((l) => l.incomeTaxWithholdingAmount)).toString());
  const payableAmount =
    withholdingTotal > 0
      ? Math.max(0, money(decimal(header.grossAmount).minus(withholdingTotal).toString()))
      : null;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const party = await client.query<{ id: string; name: string }>(
      `select id, name from public.parties where id=$1`,
      [input.partyId],
    );
    if (party.rowCount === 0) throw new DomainError("Karşı taraf bulunamadı.");

    const dedupe = invoiceDedupeKey({
      partyId: input.partyId, invoiceNo: input.invoiceNo,
      grossAmount: header.grossAmount, issueDate: input.issueDate,
    });

    let invoiceId: string;
    await client.query("savepoint inv_ext_header_sp");
    try {
      const ins = await client.query<{ id: string }>(
        `insert into public.invoices
           (direction, invoice_no, party_id, cost_center_id, project_id, department_id, order_id,
            issue_date, due_date, currency, net_amount, tax_amount, gross_amount,
            discount_total, income_tax_withholding_total, payable_amount,
            dedupe_hash, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17,$18)
         returning id`,
        [
          input.direction, input.invoiceNo, input.partyId, input.costCenterId ?? null,
          input.projectId ?? null, input.departmentId ?? null, input.orderId ?? null,
          input.issueDate, input.dueDate ?? null,
          input.currency, header.netAmount, header.taxAmount, header.grossAmount,
          discountTotal, withholdingTotal, payableAmount,
          dedupe, input.notes ?? null,
        ],
      );
      invoiceId = ins.rows[0].id;
      await client.query("release savepoint inv_ext_header_sp");
    } catch (err) {
      await client.query("rollback to savepoint inv_ext_header_sp");
      await client.query("release savepoint inv_ext_header_sp");
      if ((err as { code?: string })?.code !== "42703") throw err;
      const insFallback = await client.query<{ id: string }>(
        `insert into public.invoices
           (direction, invoice_no, party_id, cost_center_id, project_id, department_id, order_id,
            issue_date, due_date, currency, net_amount, tax_amount, gross_amount,
            dedupe_hash, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12::numeric,$13::numeric,$14,$15)
         returning id`,
        [
          input.direction, input.invoiceNo, input.partyId, input.costCenterId ?? null,
          input.projectId ?? null, input.departmentId ?? null, input.orderId ?? null,
          input.issueDate, input.dueDate ?? null,
          input.currency, header.netAmount, header.taxAmount, header.grossAmount, dedupe,
          input.notes ?? null,
        ],
      );
      invoiceId = insFallback.rows[0].id;
    }

    for (const [i, line] of input.lines.entries()) {
      const t = extendedLines[i];
      await client.query("savepoint inv_ext_line_sp");
      try {
        await client.query(
          `insert into public.invoice_lines
             (invoice_id, line_no, product_id, description, quantity, unit_price, unit, tax_rate,
              discount_rate, discount_amount, income_tax_withholding_rate, income_tax_withholding_amount,
              net_amount, tax_amount, gross_amount, cost_center_id, project_id, department_id)
           values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12::numeric,$13::numeric,$14::numeric,$15::numeric,$16,$17,$18)`,
          [
            invoiceId, i + 1, line.productId ?? null, line.description, line.quantity,
            line.unitPrice, line.unit ?? null, line.taxRate,
            t.discountRate, t.discountAmount, t.incomeTaxWithholdingRate, t.incomeTaxWithholdingAmount,
            t.netAmount, t.taxAmount, t.grossAmount,
            line.costCenterId ?? input.costCenterId ?? null,
            line.projectId ?? input.projectId ?? null,
            line.departmentId ?? input.departmentId ?? null,
          ],
        );
        await client.query("release savepoint inv_ext_line_sp");
      } catch (err) {
        await client.query("rollback to savepoint inv_ext_line_sp");
        await client.query("release savepoint inv_ext_line_sp");
        if ((err as { code?: string })?.code !== "42703") throw err;
        await client.query(
          `insert into public.invoice_lines
             (invoice_id, line_no, product_id, description, quantity, unit_price, unit, tax_rate,
              net_amount, tax_amount, gross_amount, cost_center_id, project_id, department_id)
           values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric,$10::numeric,$11::numeric,$12,$13,$14)`,
          [
            invoiceId, i + 1, line.productId ?? null, line.description, line.quantity,
            line.unitPrice, line.unit ?? null, line.taxRate,
            t.netAmount, t.taxAmount, t.grossAmount,
            line.costCenterId ?? input.costCenterId ?? null,
            line.projectId ?? input.projectId ?? null,
            line.departmentId ?? input.departmentId ?? null,
          ],
        );
      }
    }

    // M-32: Link matching open payment_instance so 13-week forecast does not double-count
    await client.query("savepoint inv_pi_link_sp");
    try {
      const piDir = input.direction === "sales" ? "inflow" : "outflow";
      if (input.linkedPaymentInstanceId) {
        await client.query(
          `update public.payment_instances
              set linked_invoice_id = $2::uuid
            where id = $1::uuid and linked_invoice_id is null`,
          [input.linkedPaymentInstanceId, invoiceId],
        );
      } else {
        await client.query(
          `update public.payment_instances pi
              set linked_invoice_id = $1::uuid
            where pi.id = (
              select pi2.id
                from public.payment_instances pi2
                join public.payments p2 on p2.id = pi2.payment_id
               where p2.party_id = $2::uuid
                 and pi2.direction = $3
                 and pi2.status in ('planned', 'unpaid', 'partial', 'late')
                 and pi2.linked_invoice_id is null
                 and p2.currency = $4
                 and abs(coalesce(pi2.due_date, $5::date) - coalesce($6::date, $5::date)) <= 20
               order by abs(coalesce(pi2.expected_amount, 0) - $7::numeric) asc
               limit 1
            )`,
          [
            invoiceId,
            input.partyId,
            piDir,
            input.currency,
            input.issueDate,
            input.dueDate ?? input.issueDate,
            payableAmount ?? header.grossAmount,
          ],
        );
      }
      await client.query("release savepoint inv_pi_link_sp");
    } catch {
      await client.query("rollback to savepoint inv_pi_link_sp");
      await client.query("release savepoint inv_pi_link_sp");
    }

    const { approvalId } = await evaluateAndRequestIfNeededWithClient(client, {
      ruleInput: {
        subjectTable: "invoices",
        triggerKind: "invoice",
        amount: header.grossAmount,
        currency: input.currency,
      },
      subjectId: invoiceId,
      subjectLabel: `${input.invoiceNo} · ${party.rows[0].name}`,
      amount: header.grossAmount,
      currency: input.currency,
      actorId,
    });
    if (approvalId) {
      await client.query(
        `update public.invoices set approval_status='pending_approval', approval_id=$2 where id=$1`,
        [invoiceId, approvalId],
      );
    }

    await audit(client, {
      actor: actorId, action: "create_invoice", entityTable: "invoices", entityId: invoiceId,
      before: null,
      after: {
        direction: input.direction, invoiceNo: input.invoiceNo, partyId: input.partyId,
        gross: header.grossAmount, discountTotal, withholdingTotal, payableAmount,
        lineCount: input.lines.length, status: "draft",
        approvalStatus: approvalId ? "pending_approval" : "not_required",
        approvalId,
      },
    });

    await client.query("commit");
    return { invoiceId, approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── status ───────────────────────────────────────────────────────────────────────────── */

export async function changeInvoiceStatus(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(statusChangeSchema, raw, "Fatura durumu");
  if (input.status === "cancelled") {
    throw new DomainError("İptal bu yoldan yapılamaz — iptal, gerekçesiyle birlikte reversal kaydı yazar.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      status: string;
      invoice_no: string;
      gross_amount: string;
      currency: string;
      approval_status: string;
      closed_at: string | null;
      close_reason: string | null;
      party_id: string;
    }>(
      `select id, status, invoice_no, gross_amount, currency, approval_status,
              closed_at, close_reason, party_id
         from public.invoices where id=$1 for update`,
      [input.invoiceId],
    );
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const inv = before.rows[0];
    const current = inv.status as InvoiceStatus;

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

    let approvalId: string | null = null;
    if (current === "draft" && input.status === "open" && inv.approval_status !== "approved") {
      const party = await client.query<{ name: string }>(
        `select name from public.parties where id=$1`,
        [inv.party_id],
      );
      const partyName = party.rows[0]?.name ?? "";
      const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
        ruleInput: {
          subjectTable: "invoices",
          triggerKind: "invoice",
          amount: inv.gross_amount,
          currency: inv.currency,
        },
        subjectId: input.invoiceId,
        subjectLabel: partyName ? `${inv.invoice_no} · ${partyName}` : inv.invoice_no,
        amount: moneyOrNull(inv.gross_amount),
        currency: inv.currency,
        actorId,
      });
      approvalId = evaluated.approvalId;
      if (approvalId) {
        await client.query(
          `update public.invoices set approval_status='pending_approval', approval_id=$2 where id=$1`,
          [input.invoiceId, approvalId],
        );
      }
    }

    if (["open", "partial", "paid"].includes(input.status)) {
      await safeSyncDomainEventWithClient(
        client,
        { kind: "invoice", invoiceId: input.invoiceId },
        actorId,
      );
    }
    if (input.status === "paid") {
      await resolvePromisesForPaidInvoicesWithClient(client, [input.invoiceId], actorId);
    }

    await audit(client, {
      actor: actorId, action: "change_invoice_status", entityTable: "invoices",
      entityId: input.invoiceId,
      before: { status: inv.status, closed_at: inv.closed_at, close_reason: inv.close_reason },
      after: { status: input.status, reason: input.reason ?? null, approvalId },
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
 * Record an inline settlement against an invoice (`F-23`, `F-24`, `F-25`, `M-32`).
 *
 * When `cashAccountId` is provided:
 *  - Creates a matched `bank_transactions` row (when a `bank_accounts` profile exists on the same currency)
 *  - Links `invoice_allocations` to that `bank_transactions` row (or `'manual'` for pure cash `100`)
 *  - Posts TDHP `100/102 <-> 120/320` + `646/656` FX difference journal entry!
 */
export async function recordInvoicePayment(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(recordPaymentSchema, raw, "Tahsilat kaydı");
  const client = await pool.connect();
  let approvalQueuedAndCommitted = false;
  try {
    await client.query("begin");
    const before = await client.query(
      `select i.id, i.direction, i.status, i.invoice_no, i.currency, to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
              i.gross_amount, i.payable_amount, i.paid_amount, i.allocated_amount, i.approval_status,
              p.name as party_name
         from public.invoices i
         join public.parties p on p.id = i.party_id
        where i.id = $1 for update of i`,
      [input.invoiceId]);
    if (before.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const row = before.rows[0];
    const status = row.status as InvoiceStatus;
    if (status === "draft") throw new DomainError("Düzenlenmemiş faturaya tahsilat işlenemez.");
    if (status === "cancelled") throw new DomainError("İptal edilmiş faturaya tahsilat işlenemez.");
    if (row.direction === "purchase" && ["pending_approval", "rejected"].includes(String(row.approval_status))) {
      throw new DomainError(
        "FORBIDDEN",
        "Bu alış faturası ikinci onay (maker-checker) bekliyor veya reddedildi; onaylanmadan ödeme işlenemez.",
      );
    }

    const gross = moneyOrNull(row.gross_amount) ?? 0;
    const ceiling = moneyOrNull(row.payable_amount) ?? gross;
    const paidBefore = moneyOrNull(row.paid_amount) ?? 0;
    const allocatedBefore = moneyOrNull(row.allocated_amount) ?? 0;
    const effectivePaidBefore = Math.max(paidBefore, allocatedBefore);

    if (row.direction === "purchase" && String(row.approval_status ?? "not_required") !== "approved") {
      const candidateTotal = Math.max(
        gross,
        ceiling,
        Number(decimal(effectivePaidBefore).plus(input.amount).round(2).toFixed(2)),
      );
      let firedCount = 0;
      try {
        await client.query("savepoint sp_inv_pay_rule_eval");
        const fired = await evaluateRulesWithClient(client, {
          subjectTable: "invoices",
          triggerKind: "invoice",
          amount: candidateTotal,
          currency: String(row.currency ?? "TRY"),
        });
        firedCount = fired.length;
        await client.query("release savepoint sp_inv_pay_rule_eval");
      } catch (err) {
        await client.query("rollback to savepoint sp_inv_pay_rule_eval").catch(() => undefined);
        await client.query("release savepoint sp_inv_pay_rule_eval").catch(() => undefined);
        const code = (err as { code?: string } | null)?.code;
        if (code !== "42P01" && code !== "42703") throw err;
      }

      if (firedCount > 0) {
        try {
          await client.query("savepoint sp_inv_pay_queue_app");
          const evaluated = await evaluateAndRequestIfNeededWithClient(client, {
            ruleInput: {
              subjectTable: "invoices",
              triggerKind: "invoice",
              amount: candidateTotal,
              currency: String(row.currency ?? "TRY"),
            },
            subjectId: input.invoiceId,
            subjectLabel: `${row.invoice_no} · ${row.party_name}`,
            amount: candidateTotal,
            currency: String(row.currency ?? "TRY"),
            actorId,
          });
          if (evaluated.approvalId) {
            await client.query(
              `update public.invoices set approval_status='pending_approval', approval_id=$2 where id=$1`,
              [input.invoiceId, evaluated.approvalId],
            );
            await client.query("release savepoint sp_inv_pay_queue_app");
            await client.query("commit");
            approvalQueuedAndCommitted = true;
          } else {
            await client.query("rollback to savepoint sp_inv_pay_queue_app").catch(() => undefined);
            await client.query("release savepoint sp_inv_pay_queue_app").catch(() => undefined);
          }
        } catch {
          await client.query("rollback to savepoint sp_inv_pay_queue_app").catch(() => undefined);
          await client.query("release savepoint sp_inv_pay_queue_app").catch(() => undefined);
        }
        throw new DomainError(
          "FORBIDDEN",
          "Bu alış faturası kritik onay eşiğini aşıyor; bağımsız ikinci onay (maker-checker) tamamlanmadan ödeme işlenemez.",
        );
      }
    }

    const allocRoom = Math.max(0, Number(decimal(ceiling).minus(allocatedBefore).round(2).toFixed(2)));
    const allocAmt = Math.min(Number(decimal(input.amount).round(2).toFixed(2)), allocRoom);
    let allocationId: string | null = null;
    let bankTransactionId: string | null = null;
    let cashAccountType = "bank_account";

    if (input.cashAccountId) {
      const acctRes = await client.query<{
        id: string;
        account_type: string;
        currency: string;
        has_bank_profile: boolean;
      }>(
        `select ca.id::text, ca.account_type, ca.currency,
                exists(select 1 from public.bank_accounts ba where ba.cash_account_id = ca.id) as has_bank_profile
           from public.cash_accounts ca
          where ca.id = $1::uuid`,
        [input.cashAccountId],
      );
      if (acctRes.rowCount === 1) {
        const acct = acctRes.rows[0];
        cashAccountType = acct.account_type;
        if (acct.currency !== row.currency) {
          throw new DomainError(
            `Seçilen hesap (${acct.currency}) ile fatura para birimi (${row.currency}) aynı olmalıdır.`,
          );
        }
        if (acct.has_bank_profile) {
          await client.query("savepoint inv_inline_btx_sp");
          try {
            const signedAmt = row.direction === "sales" ? input.amount : -input.amount;
            const dedupeHash = createHash("sha256")
              .update(`inline-inv-pay|${input.invoiceId}|${input.cashAccountId}|${Date.now()}|${signedAmt}`)
              .digest("hex");
            const btx = await client.query<{ id: string }>(
              `insert into public.bank_transactions
                 (bank_account_id, txn_date, value_date, description, counterparty_name_raw,
                  amount, currency, category, category_rule, status,
                  matched_entity_table, matched_entity_id, match_confidence, matched_at, dedupe_hash)
               values ($1::uuid, current_date, current_date, $2, $3,
                       $4::numeric, $5, $6, 'inline_invoice_payment', 'matched',
                       'invoices', $7::uuid, 1, now(), $8)
               returning id::text`,
              [
                input.cashAccountId,
                `Fatura ${row.direction === "sales" ? "tahsilatı" : "ödemesi"}: ${row.invoice_no}`,
                row.party_name,
                signedAmt.toFixed(2),
                row.currency,
                row.direction === "sales" ? "incoming_payment" : "outgoing_payment",
                input.invoiceId,
                dedupeHash,
              ],
            );
            bankTransactionId = btx.rows[0]?.id ?? null;
            await client.query("release savepoint inv_inline_btx_sp");
          } catch {
            await client.query("rollback to savepoint inv_inline_btx_sp");
            await client.query("release savepoint inv_inline_btx_sp");
          }
        }
      }
    }

    if (allocAmt > 0) {
      await client.query("savepoint inv_inline_alloc_sp");
      try {
        const insAlloc = await client.query<{ id: string }>(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount, notes, created_by)
           values ($1, $2, $3::uuid, $4::numeric, 'Satır-içi fatura tahsilat/ödeme kaydı', $5)
           returning id::text as id`,
          [
            input.invoiceId,
            bankTransactionId ? "bank_transactions" : "manual",
            bankTransactionId,
            allocAmt.toFixed(2),
            actorId,
          ],
        );
        allocationId = insAlloc.rows[0]?.id ?? null;
        await client.query("release savepoint inv_inline_alloc_sp");
      } catch (err) {
        await client.query("rollback to savepoint inv_inline_alloc_sp");
        await client.query("release savepoint inv_inline_alloc_sp");
        const code = (err as { code?: string })?.code;
        if (code !== "42P01") throw err;
      }
    }

    const targetPaid = Number(decimal(effectivePaidBefore).plus(input.amount).round(2).toFixed(2));
    const curAfterAlloc = await client.query<{ paid_amount: string; allocated_amount: string; status: string }>(
      `select paid_amount::text, coalesce(allocated_amount, 0)::text as allocated_amount, status
         from public.invoices
        where id = $1`,
      [input.invoiceId],
    );
    let paidAfter = moneyOrNull(curAfterAlloc.rows[0]?.paid_amount) ?? paidBefore;
    const allocatedAfter = moneyOrNull(curAfterAlloc.rows[0]?.allocated_amount) ?? allocatedBefore;
    let currentStatus = (curAfterAlloc.rows[0]?.status ?? status) as InvoiceStatus;

    if (targetPaid > paidAfter) {
      const updated = await client.query<{ paid_amount: string; status: string }>(
        `update public.invoices set paid_amount = $2::numeric where id=$1
         returning paid_amount::text, status`,
        [input.invoiceId, targetPaid.toFixed(2)],
      );
      paidAfter = moneyOrNull(updated.rows[0].paid_amount) ?? targetPaid;
      currentStatus = updated.rows[0].status as InvoiceStatus;
    }

    const suggested: InvoiceStatus = paidAfter <= 0 ? "open" : paidAfter >= ceiling ? "paid" : "partial";
    if (suggested !== currentStatus && canTransition(currentStatus, suggested)) {
      await client.query(`update public.invoices set status=$2 where id=$1`, [input.invoiceId, suggested]);
      currentStatus = suggested;
    }

    if (currentStatus === "paid") {
      await resolvePromisesForPaidInvoicesWithClient(client, [input.invoiceId], actorId);
    }

    // M-32: Post TDHP 100/102 <-> 120/320 (+ 646/656 FX diff for foreign currency) when cashAccountId is used
    if (input.cashAccountId) {
      await client.query("savepoint inv_inline_je_sp");
      try {
        const cashCode = cashAccountType === "cash" ? "100" : "102";
        const arApCode = row.direction === "sales" ? "120" : "320";
        let bookTry = Number(decimal(input.amount).round(2).toFixed(2));
        let settleTry = bookTry;

        if (row.currency !== "TRY") {
          const issueFxRes = await client.query<{ rate: string }>(
            `select rate::text from public.fx_rates
              where base_currency = $1 and quote_currency = 'TRY' and rate_date <= $2::date
              order by rate_date desc limit 1`,
            [row.currency, row.issue_date],
          );
          const settleFxRes = await client.query<{ rate: string }>(
            `select rate::text from public.fx_rates
              where base_currency = $1 and quote_currency = 'TRY'
              order by rate_date desc limit 1`,
            [row.currency],
          );
          const issueRate = rateOrNull(issueFxRes.rows[0]?.rate) ?? input.fxRate ?? 1;
          const settleRate = input.fxRate ?? rateOrNull(settleFxRes.rows[0]?.rate) ?? issueRate;
          bookTry = Number(decimal(input.amount).times(issueRate).round(2).toFixed(2));
          settleTry = Number(decimal(input.amount).times(settleRate).round(2).toFixed(2));
        }

        const fxDiff = Number(decimal(settleTry).minus(bookTry).round(2).toFixed(2));
        const lines: { accountCode: string; debit: number; credit: number; memo?: string }[] = [];

        if (row.direction === "sales") {
          lines.push({ accountCode: cashCode, debit: settleTry, credit: 0, memo: `${row.invoice_no} tahsilatı` });
          lines.push({ accountCode: arApCode, debit: 0, credit: bookTry, memo: `${row.party_name} cari kapama` });
          if (fxDiff > 0) {
            lines.push({ accountCode: "646", debit: 0, credit: fxDiff, memo: "Kambiyo kârı (tahsilat kur farkı)" });
          } else if (fxDiff < 0) {
            lines.push({ accountCode: "656", debit: Math.abs(fxDiff), credit: 0, memo: "Kambiyo zararı (tahsilat kur farkı)" });
          }
        } else {
          lines.push({ accountCode: arApCode, debit: bookTry, credit: 0, memo: `${row.party_name} cari kapama` });
          lines.push({ accountCode: cashCode, debit: 0, credit: settleTry, memo: `${row.invoice_no} ödemesi` });
          if (fxDiff > 0) {
            lines.push({ accountCode: "656", debit: fxDiff, credit: 0, memo: "Kambiyo zararı (ödeme kur farkı)" });
          } else if (fxDiff < 0) {
            lines.push({ accountCode: "646", debit: 0, credit: Math.abs(fxDiff), memo: "Kambiyo kârı (ödeme kur farkı)" });
          }
        }

        const todayIso = new Date().toISOString().slice(0, 10);
        await postBalancedJournalEntry(
          client,
          {
            entryDate: todayIso,
            description: `Fatura ${row.direction === "sales" ? "tahsilatı" : "ödemesi"}: ${row.invoice_no} (${row.party_name})`,
            sourceType: bankTransactionId ? "bank_transaction" : "manual",
            sourceTable: bankTransactionId ? "bank_transactions" : "invoices",
            sourceId: bankTransactionId ?? input.invoiceId,
            lines,
          },
          actorId,
        );
        await client.query("release savepoint inv_inline_je_sp");
      } catch {
        await client.query("rollback to savepoint inv_inline_je_sp");
        await client.query("release savepoint inv_inline_je_sp");
      }
    }

    await audit(client, {
      actor: actorId, action: "record_invoice_payment", entityTable: "invoices",
      entityId: input.invoiceId,
      before: { status, paid_amount: paidBefore, allocated_amount: allocatedBefore },
      after: {
        status: currentStatus,
        paid_amount: paidAfter,
        allocated_amount: allocatedAfter,
        applied: input.amount,
        allocation_id: allocationId,
        bank_transaction_id: bankTransactionId,
        cash_account_id: input.cashAccountId ?? null,
        linked_settlement_source: bankTransactionId
          ? "bank_transactions"
          : allocationId
            ? "manual_allocation"
            : null,
      },
    });
    await client.query("commit");
  } catch (e) {
    if (!approvalQueuedAndCommitted) {
      await client.query("rollback");
    }
    throw e;
  } finally {
    client.release();
  }
}

/* ── cancellation via a linked reversal record ────────────────────────────────────────── */

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

    await safeReverseJournalForSourceWithClient(
      client,
      "invoice",
      input.invoiceId,
      input.reason,
      actorId,
    );

    await audit(client, {
      actor: actorId, action: "cancel_invoice", entityTable: "invoices", entityId: input.invoiceId,
      before: { status, gross_amount: moneyOrNull(inv.gross_amount) },
      after: { status: "cancelled", reason: input.reason, reversal_record_written: true },
    });

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
  approvalStatus: string;
  lineCount: number;
}

export async function listInvoices(
  pool: Pool,
  opts: { status?: string; direction?: string; limit?: number; offset?: number } = {},
): Promise<InvoiceRow[]> {
  const params = [opts.status ?? "", opts.direction ?? "", opts.limit ?? 50, Math.max(0, opts.offset ?? 0)];
  const r = await pool.query(
    `select i.id::text, i.direction, i.invoice_no, i.party_id::text, pa.name as party_name,
            to_char(i.issue_date,'YYYY-MM-DD') as issue_date,
            to_char(i.due_date,'YYYY-MM-DD') as due_date,
            i.currency, i.net_amount, i.tax_amount, i.gross_amount, i.paid_amount,
            (coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0))) as remaining,
            i.status, i.approval_status,
            (select count(*) from public.invoice_lines l where l.invoice_id = i.id)::int as line_count
     from public.invoices i
     join public.parties pa on pa.id = i.party_id
     where i.archived_at is null
       and ($1='' or i.status=$1) and ($2='' or i.direction=$2)
     order by i.issue_date desc, i.invoice_no
     limit $3 offset $4`,
    params,
  ).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42703") {
      return pool.query(
        `select i.id::text, i.direction, i.invoice_no, i.party_id::text, pa.name as party_name,
                to_char(i.issue_date,'YYYY-MM-DD') as issue_date,
                to_char(i.due_date,'YYYY-MM-DD') as due_date,
                i.currency, i.net_amount, i.tax_amount, i.gross_amount, i.paid_amount,
                (i.gross_amount - i.paid_amount) as remaining, i.status,
                'not_required'::text as approval_status,
                (select count(*) from public.invoice_lines l where l.invoice_id = i.id)::int as line_count
         from public.invoices i
         join public.parties pa on pa.id = i.party_id
         where ($1='' or i.status=$1) and ($2='' or i.direction=$2)
         order by i.issue_date desc, i.invoice_no
         limit $3 offset $4`,
        params,
      );
    }
    throw err;
  });
  return r.rows.map((x) => ({
    id: x.id, direction: x.direction, invoiceNo: x.invoice_no, partyId: x.party_id,
    partyName: x.party_name, issueDate: x.issue_date, dueDate: x.due_date, currency: x.currency,
    netAmount: moneyOrNull(x.net_amount) ?? 0, taxAmount: moneyOrNull(x.tax_amount) ?? 0,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0, paidAmount: moneyOrNull(x.paid_amount) ?? 0,
    remaining: moneyOrNull(x.remaining) ?? 0, status: x.status as InvoiceStatus,
    approvalStatus: String(x.approval_status ?? "not_required"),
    lineCount: intOrNull(x.line_count) ?? 0,
  }));
}

export async function countInvoices(
  pool: Pick<Pool, "query">,
  opts: { status?: string; direction?: string } = {},
): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `select count(*)::int as n
     from public.invoices i
     where ($1 = '' or i.status = $1) and ($2 = '' or i.direction = $2)`,
    [opts.status ?? "", opts.direction ?? ""],
  );
  return intOrNull(r.rows[0]?.n) ?? 0;
}

export async function loadInvoiceLines(pool: Pool, invoiceId: string) {
  const r = await pool.query(
    `select id::text, line_no, description, quantity, unit_price, unit, tax_rate,
            net_amount, tax_amount, gross_amount
     from public.invoice_lines where invoice_id=$1 order by line_no`, [invoiceId]);
  return r.rows.map((x) => ({
    id: x.id, lineNo: intOrNull(x.line_no) ?? 0, description: x.description,
    quantity: rateOrNull(x.quantity) ?? 0, unitPrice: rateOrNull(x.unit_price) ?? 0,
    unit: x.unit, taxRate: rateOrNull(x.tax_rate) ?? 0,
    netAmount: moneyOrNull(x.net_amount) ?? 0, taxAmount: moneyOrNull(x.tax_amount) ?? 0,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0,
  }));
}

export async function loadOpenItems(pool: Pool, limit = 50, offset = 0) {
  const r = await pool.query(
    `select id::text, direction, invoice_no, party_name,
            to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            gross_amount, paid_amount, remaining, status, days_overdue, ageing_bucket, currency
     from public.invoice_open_items
     order by (due_date is null), due_date, remaining desc limit $1 offset $2`, [limit, Math.max(0, offset)]);
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
    `select d.invoice_id::text, d.other_invoice_id::text, d.party_name, d.invoice_no, d.other_invoice_no, inv.currency,
            d.gross_amount, to_char(d.issue_date,'YYYY-MM-DD') as issue_date,
            to_char(d.other_issue_date,'YYYY-MM-DD') as other_issue_date, d.signal, d.date_gap_days
     from public.invoice_duplicate_suspects d left join public.invoices inv on inv.id = d.invoice_id order by d.signal, d.gross_amount desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    invoiceId: x.invoice_id, otherInvoiceId: x.other_invoice_id, partyName: x.party_name,
    invoiceNo: x.invoice_no, otherInvoiceNo: x.other_invoice_no,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0, issueDate: x.issue_date,
    otherIssueDate: x.other_issue_date, signal: x.signal as string,
    dateGapDays: intOrNull(x.date_gap_days) ?? 0, currency: String(x.currency ?? "TRY"),
  }));
}

export async function loadLineMismatches(pool: Pool, limit = 50) {
  const r = await pool.query(
    `select m.invoice_id::text, m.invoice_no, m.header_gross, m.lines_gross, m.difference, m.line_count, inv.currency
     from public.invoice_line_mismatches m left join public.invoices inv on inv.id = m.invoice_id order by abs(m.difference) desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    invoiceId: x.invoice_id, invoiceNo: x.invoice_no,
    headerGross: moneyOrNull(x.header_gross) ?? 0, linesGross: moneyOrNull(x.lines_gross) ?? 0,
    difference: moneyOrNull(x.difference) ?? 0, lineCount: intOrNull(x.line_count) ?? 0, currency: String(x.currency ?? "TRY"),
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
