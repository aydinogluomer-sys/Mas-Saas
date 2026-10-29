// Faz 22 — allocations, receivables/payables and the current account card.
//
// Inherited rules, applied rather than re-argued:
//   Faz 17 — money crosses the SQL/JS boundary through @/lib/money.
//   Faz 18 — every mutation records through the canonical audit(), in the same transaction, and
//            input is parsed with a Zod schema at the boundary.
//   Faz 19 — nothing here creates a counterparty.
//   Faz 21 — an invoice's commercial content is immutable once issued; allocations never touch it.
//
// THE INVARIANT THIS PHASE GUARANTEES lives in migration 0048's trigger, not here. The checks in
// this file exist so an operator gets a readable refusal instead of a raw trigger exception —
// implementation.md §18 is explicit that an application-level check is NOT sufficient, so
// nothing below may ever become the only thing standing between a user and an over-allocation.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { COLLECTION_BUCKETS, computeDPO, computeDSO, openAmount, planAllocation, type AgeingSummary, type AllocatableInvoice } from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

const SOURCE_TABLES = ["bank_transactions", "payment_instances", "checks", "manual"] as const;

export const allocateSchema = z.object({
  invoiceId: z.uuid(),
  sourceTable: z.enum(SOURCE_TABLES),
  sourceId: z.uuid().optional(),
  amount: z.coerce.number().positive("Tutar sıfırdan büyük olmalı"),
  allocatedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().trim().min(1).optional(),
}).refine((v) => (v.sourceTable === "manual") === (v.sourceId === undefined), {
  message: "manual dışındaki kaynaklar için kaynak kaydı zorunlu, manual için verilmemeli",
});

export const reverseAllocationSchema = z.object({
  allocationId: z.uuid(),
  reason: z.string().trim().min(3, "Gerekçe en az 3 karakter olmalı"),
});

export const allocateBankTransactionSchema = z.object({
  transactionId: z.uuid(),
  lines: z.array(z.object({
    invoiceId: z.uuid(),
    amount: z.coerce.number().positive(),
  })).min(1, "En az bir fatura seçilmeli"),
});

/* ── write side ───────────────────────────────────────────────────────────────────────── */

/**
 * Allocate money to one invoice.
 *
 * The ceiling is checked here for a readable message AND enforced by 0048's trigger. Both, on
 * purpose: this one can be bypassed by any other code path, the trigger cannot.
 */
export async function allocateToInvoice(pool: Pool, raw: unknown, actorId: string): Promise<{ allocationId: string }> {
  const input = parseOrThrow(allocateSchema, raw, "Dağıtım");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inv = await client.query(
      `select id, status, gross_amount, allocated_amount, direction from public.invoices where id=$1 for update`,
      [input.invoiceId]);
    if (inv.rowCount === 0) throw new DomainError("Fatura bulunamadı.");
    const row = inv.rows[0];
    if (!["open", "partial", "paid"].includes(row.status)) {
      throw new DomainError(`'${row.status}' durumundaki faturaya dağıtım yapılamaz.`);
    }
    const gross = moneyOrNull(row.gross_amount) ?? 0;
    const already = moneyOrNull(row.allocated_amount) ?? 0;
    const free = openAmount(gross, already);
    if (input.amount > free) {
      throw new DomainError(
        `Bu faturaya en fazla ${free} TL dağıtılabilir (tutar ${gross}, dağıtılmış ${already}).`,
      );
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.invoice_allocations
         (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
       values ($1,$2,$3,$4::numeric,coalesce($5::date, current_date),$6,$7) returning id`,
      [input.invoiceId, input.sourceTable, input.sourceId ?? null, input.amount,
       input.allocatedOn ?? null, input.notes ?? null, actorId]);

    await audit(client, {
      actor: actorId, action: "allocate_to_invoice", entityTable: "invoice_allocations",
      entityId: ins.rows[0].id, before: null,
      after: {
        invoiceId: input.invoiceId, sourceTable: input.sourceTable, sourceId: input.sourceId ?? null,
        amount: input.amount, allocatedBefore: already, invoiceGross: gross,
      },
    });
    await client.query("commit");
    return { allocationId: ins.rows[0].id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reverse an allocation.
 *
 * Reversal, never deletion: an allocation that was made and undone is history worth keeping,
 * and 0048's trigger recomputes the invoice total from the surviving open rows.
 */
export async function reverseAllocation(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(reverseAllocationSchema, raw, "Dağıtım iptali");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, invoice_id, allocated_amount, reversed_at from public.invoice_allocations where id=$1 for update`,
      [input.allocationId]);
    if (before.rowCount === 0) throw new DomainError("Dağıtım kaydı bulunamadı.");
    if (before.rows[0].reversed_at) throw new DomainError("Bu dağıtım zaten iptal edilmiş.");

    await client.query(
      `update public.invoice_allocations
         set reversed_at=now(), reversed_by=$2, reversed_reason=$3 where id=$1`,
      [input.allocationId, actorId, input.reason]);

    await audit(client, {
      actor: actorId, action: "reverse_allocation", entityTable: "invoice_allocations",
      entityId: input.allocationId,
      before: { amount: moneyOrNull(before.rows[0].allocated_amount), invoiceId: before.rows[0].invoice_id },
      after: { reversed: true, reason: input.reason },
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
 * Spread one bank transaction across several invoices — the many-to-many case.
 *
 * All lines in one transaction: a partial application that left half a settlement allocated
 * would be worse than none, because the operator would have no way to tell which half.
 */
export async function allocateBankTransaction(
  pool: Pool, raw: unknown, actorId: string,
): Promise<{ allocated: number; lineCount: number }> {
  const input = parseOrThrow(allocateBankTransactionSchema, raw, "Banka hareketi dağıtımı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const txn = await client.query(
      `select id, amount, status from public.bank_transactions where id=$1 for update`, [input.transactionId]);
    if (txn.rowCount === 0) throw new DomainError("Banka hareketi bulunamadı.");

    const txnAmount = Math.abs(moneyOrNull(txn.rows[0].amount) ?? 0);
    const already = moneyOrNull((await client.query(
      `select coalesce(sum(allocated_amount),0) s from public.invoice_allocations
       where source_table='bank_transactions' and source_id=$1 and reversed_at is null`,
      [input.transactionId])).rows[0].s) ?? 0;
    const requested = input.lines.reduce((n, l) => n + l.amount, 0);

    // A settlement cannot give out more money than it carried. The invoice-side ceiling is
    // 0048's job; this is the source-side ceiling and has no database trigger behind it, so it
    // is checked here deliberately rather than by convention.
    if (already + requested > txnAmount + 1e-9) {
      throw new DomainError(
        `Bu hareket ${txnAmount} TL taşıyor; ${already} TL zaten dağıtılmış, ${requested} TL daha dağıtılamaz.`,
      );
    }

    let allocated = 0;
    for (const line of input.lines) {
      await client.query(
        `insert into public.invoice_allocations
           (invoice_id, source_table, source_id, allocated_amount, created_by)
         values ($1,'bank_transactions',$2,$3::numeric,$4)`,
        [line.invoiceId, input.transactionId, line.amount, actorId]);
      allocated += line.amount;
    }

    await audit(client, {
      actor: actorId, action: "allocate_bank_transaction", entityTable: "bank_transactions",
      entityId: input.transactionId, before: { allocatedBefore: already },
      after: { lines: input.lines, allocated, transactionAmount: txnAmount },
    });
    await client.query("commit");
    return { allocated, lineCount: input.lines.length };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export interface OpenItem {
  invoiceId: string;
  partyId: string;
  partyName: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  grossAmount: number;
  allocatedAmount: number;
  openAmount: number;
  status: string;
  daysOverdue: number | null;
  ageingBucket: string;
}

async function loadOpen(pool: Pool, view: "receivables_open" | "payables_open", limit: number): Promise<OpenItem[]> {
  const r = await pool.query(
    `select invoice_id::text, party_id::text, party_name, invoice_no,
            to_char(issue_date,'YYYY-MM-DD') as issue_date,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            gross_amount, allocated_amount, open_amount, status, days_overdue, ageing_bucket
     from public.${view}
     order by (due_date is null), due_date, open_amount desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    invoiceId: x.invoice_id, partyId: x.party_id, partyName: x.party_name, invoiceNo: x.invoice_no,
    issueDate: x.issue_date, dueDate: x.due_date,
    grossAmount: moneyOrNull(x.gross_amount) ?? 0,
    allocatedAmount: moneyOrNull(x.allocated_amount) ?? 0,
    openAmount: moneyOrNull(x.open_amount) ?? 0,
    status: x.status, daysOverdue: intOrNull(x.days_overdue), ageingBucket: x.ageing_bucket,
  }));
}

export const loadReceivables = (pool: Pool, limit = 200) => loadOpen(pool, "receivables_open", limit);
export const loadPayables = (pool: Pool, limit = 200) => loadOpen(pool, "payables_open", limit);

/* ── Limitten BAĞIMSIZ finansal toplamlar ─────────────────────────────────────────────────
 *
 * NE ÖLÇÜLDÜ. `/finance/receivables` ekranı `recTotal`, `payTotal`, yaşlandırma kovaları ve
 * gecikmiş sayacını LİSTEYE gelen satırlardan hesaplıyordu:
 *
 *     const recTotal = receivables.reduce((n, r) => n + r.openAmount, 0);
 *     const recAgeing = summarizeAgeing(receivables.map(...), today);
 *     const overdue = receivables.filter((r) => (r.daysOverdue ?? 0) > 0);
 *
 * Liste `loadReceivables(pool, 75)` ile sınırlı olduğu için bu, "toplam açık alacak"ın aslında
 * "en büyük 75 alacağın toplamı" olması demekti. 75'in üzerinde açık kayıt olduğunda ekrandaki
 * her finansal rakam GERÇEĞİN ALTINDA kalıyordu — ve hiçbir yerde bunu söyleyen bir şey yoktu.
 *
 * Bu 150'de de böyleydi; limitin 75'e inmesi yalnız yanılma eşiğini yarıya indirdi. Yani sorun
 * limitin değeri değil, TOPLAMLARIN LİSTEYE BAĞLI OLMASIYDI.
 *
 * ═══ NEDEN AYNI VIEW ÜZERİNDEN AGGREGATE ═══
 *
 * Filtre ve statü semantiği `public.receivables_open` / `public.payables_open` view'larının
 * içinde yaşıyor — hangi faturanın "açık" sayıldığı, `open_amount`un nasıl hesaplandığı, hepsi.
 * Toplamları aynı view üzerinden almak, o semantiği yeniden yazmadan birebir korumanın tek
 * yoludur. Kendi `where` cümlemi yazsaydım iki tanım oluşur ve ilk şema değişikliğinde
 * sessizce ayrışırlardı.
 *
 * ═══ KOVA SINIRLARI `collectionBucket()` İLE AYNI OLMAK ZORUNDA ═══
 *
 * `src/lib/receivables/rules.ts`:
 *     null            → "tarihsiz"
 *     days <= 0       → "vadesi gelmemiş"
 *     days <= 7       → "1-7 gün"
 *     days <= 30      → "8-30 gün"
 *     days <= 60      → "31-60 gün"
 *     aksi            → "60+ gün"
 * ve `days = floor((today - dueDate) / 1 gün)`.
 *
 * PostgreSQL'de `date - date` zaten tam sayı gün verir, dolayısıyla `$1::date - due_date`
 * JS'teki floor hesabının birebir karşılığıdır (ikisi de tarih-düzeyinde çalışır).
 *
 * `overdueCount` ise kovadan DEĞİL, view'ın kendi `days_overdue` kolonundan türetilir — çünkü
 * ekrandaki sayaç da öyleydi (`(r.daysOverdue ?? 0) > 0`). İki farklı soru, iki farklı kaynak;
 * birini diğerine uydurmak sessiz bir davranış değişikliği olurdu.
 */
export interface OpenTotals {
  /** Uygun BÜTÜN kayıtların açık tutar toplamı — liste limitinden etkilenmez. */
  totalOpenAmount: number;
  /** Uygun BÜTÜN kayıtların sayısı. */
  itemCount: number;
  /** `days_overdue > 0` olan bütün kayıtlar. */
  overdueCount: number;
  /** PHASE 2.2: TRY-dışı açık kalem sayısı — totalOpenAmount'a girmedi. */
  foreignCount: number;
  /** `COLLECTION_BUCKETS` ile aynı sırada ve aynı sınırlarla. */
  ageing: AgeingSummary[];
}

async function loadOpenTotals(
  pool: Pool,
  view: "receivables_open" | "payables_open",
  todayISO: string,
): Promise<OpenTotals> {
  // PHASE 2.2 (#49): toplam yalniz TRY; TRY-disi acik kalemler foreign_count ile doner (view
  // `i.currency` tasir, 0050). Sayimlar para biriminden bagimsiz.
  const r = await pool.query(
    `select
       coalesce(sum(open_amount) filter (where currency = 'TRY'), 0)   as total_open,
       count(*)::int                                                   as item_count,
       count(*) filter (where coalesce(days_overdue, 0) > 0)::int      as overdue_count,
       count(*) filter (where currency <> 'TRY')::int                  as foreign_count,
       case
         when due_date is null then 'tarihsiz'
         when ($1::date - due_date) <= 0  then 'vadesi gelmemiş'
         when ($1::date - due_date) <= 7  then '1-7 gün'
         when ($1::date - due_date) <= 30 then '8-30 gün'
         when ($1::date - due_date) <= 60 then '31-60 gün'
         else '60+ gün'
       end                                                             as bucket
     from public.${view}
     group by rollup (bucket)`,
    [todayISO],
  );

  // `rollup` tek sorguda hem kova satırlarını hem genel toplamı döndürür: bucket = null olan
  // satır TOPLAMDIR. İki ayrı sorgu atmak, aralarında bir yazma olursa tutarsız iki rakam
  // üretebilirdi; tek sorgu bunu yapısal olarak imkânsız kılar.
  const grand = r.rows.find((row) => row.bucket === null);
  const byBucket = new Map<string, { count: number; amount: number; foreignCount: number }>();
  for (const row of r.rows) {
    if (row.bucket === null) continue;
    byBucket.set(String(row.bucket), {
      count: Number(row.item_count),
      amount: moneyOrNull(row.total_open) ?? 0,
      foreignCount: Number(row.foreign_count ?? 0),
    });
  }

  return {
    totalOpenAmount: moneyOrNull(grand?.total_open) ?? 0,
    itemCount: Number(grand?.item_count ?? 0),
    overdueCount: Number(grand?.overdue_count ?? 0),
    foreignCount: Number(grand?.foreign_count ?? 0),
    // Boş kovalar da döner: eksik bir satır ile sıfır satır bir rapor okuyan için çok farklı
    // şeylerdir (rules.ts'teki summarizeAgeing de aynı sözü verir).
    ageing: COLLECTION_BUCKETS.map((bucket) => ({
      bucket,
      count: byBucket.get(bucket)?.count ?? 0,
      amount: byBucket.get(bucket)?.amount ?? 0,
      foreignCount: byBucket.get(bucket)?.foreignCount ?? 0,
    })),
  };
}

export const loadReceivableTotals = (pool: Pool, todayISO: string) =>
  loadOpenTotals(pool, "receivables_open", todayISO);
export const loadPayableTotals = (pool: Pool, todayISO: string) =>
  loadOpenTotals(pool, "payables_open", todayISO);

export async function loadCurrentAccounts(pool: Pool, limit = 200) {
  // 0094 (#46): every amount column of current_account_summary is TRY-only; its
  // foreign_currency_count says how many of the party's non-cancelled invoices are in another
  // currency and therefore NOT in those sums. Carried through so a reader of the amounts can say so
  // (the Telegram assistant does) instead of presenting a TRY-only figure as the whole balance.
  const r = await pool.query(
    `select party_id::text, party_name, party_type, receivable_open, payable_open,
            receivable_count, payable_count, overdue_count,
            to_char(earliest_due_date,'YYYY-MM-DD') as earliest_due_date,
            sales_total_all_time, purchase_total_all_time,
            to_char(last_invoice_date,'YYYY-MM-DD') as last_invoice_date,
            foreign_currency_count
     from public.current_account_summary
     where receivable_open <> 0 or payable_open <> 0 or receivable_count > 0 or payable_count > 0
     order by (receivable_open + payable_open) desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    partyId: x.party_id, partyName: x.party_name, partyType: x.party_type,
    receivableOpen: moneyOrNull(x.receivable_open) ?? 0,
    payableOpen: moneyOrNull(x.payable_open) ?? 0,
    receivableCount: intOrNull(x.receivable_count) ?? 0,
    payableCount: intOrNull(x.payable_count) ?? 0,
    overdueCount: intOrNull(x.overdue_count) ?? 0,
    earliestDueDate: x.earliest_due_date,
    salesTotal: moneyOrNull(x.sales_total_all_time) ?? 0,
    purchaseTotal: moneyOrNull(x.purchase_total_all_time) ?? 0,
    lastInvoiceDate: x.last_invoice_date,
    /** Non-TRY invoices of this party, excluded from every amount above (0094). */
    foreignCurrencyCount: intOrNull(x.foreign_currency_count) ?? 0,
  }));
}

// current_account_ledger (0050) has no currency column, but every movement — the invoice row and
// each allocation against it — is denominated in its invoice's currency, and every row carries
// invoice_id. The join gives each movement its own currency so no reader has to assume TRY.
// invoices.currency is NOT NULL with an ISO-4217 shape check (0044); the left join only means a
// missing match surfaces as null (unknown) rather than dropping the movement.
const LEDGER_SELECT =
  `select to_char(l.movement_date,'YYYY-MM-DD') as movement_date, l.movement_type, l.reference,
          l.direction, l.debit_amount, l.credit_amount, l.invoice_id::text, i.currency
   from public.current_account_ledger l
   left join public.invoices i on i.id = l.invoice_id
   where l.party_id=$1`;

function ledgerRow(x: Record<string, unknown>) {
  return {
    movementDate: x.movement_date as string, movementType: x.movement_type as string,
    reference: x.reference as string | null,
    direction: x.direction as "sales" | "purchase",
    debitAmount: moneyOrNull(x.debit_amount as string | null) ?? 0,
    creditAmount: moneyOrNull(x.credit_amount as string | null) ?? 0,
    invoiceId: x.invoice_id as string,
    currency: (x.currency as string | null) ?? null,
  };
}

/** The ledger in statement order: oldest first, the first `limit` movements. */
export async function loadCurrentAccountLedger(pool: Pool, partyId: string, limit = 200) {
  const r = await pool.query(
    `${LEDGER_SELECT}
     order by l.movement_date, l.movement_type limit $2`, [partyId, limit]);
  return r.rows.map(ledgerRow);
}

/**
 * The party's LATEST `limit` movements, newest first — what "son N hareket" means.
 *
 * Not loadCurrentAccountLedger read backwards, deliberately. The Telegram assistant used to take
 * that reader's first 200 rows (oldest first) and print their tail as "the latest": for a party
 * past 200 movements it showed rows ~191-200 of its history under a "son 10 hareket" heading,
 * and every newer invoice and collection had already been cut off by the LIMIT — the owner would
 * read "nothing since March" about a customer who paid yesterday. A LIMIT taken from the wrong end
 * of the ordering cannot be repaired afterwards in JavaScript, so the order and the size are both
 * in the SQL here. Same-day ties keep the statement's own tie-break, reversed, so this is exactly
 * the statement read from the bottom up.
 */
export async function loadLatestLedgerMovements(pool: Pool, partyId: string, limit: number) {
  const r = await pool.query(
    `${LEDGER_SELECT}
     order by l.movement_date desc, l.movement_type desc limit $2`, [partyId, limit]);
  return r.rows.map(ledgerRow);
}

/**
 * DSO / DPO over a chosen window.
 *
 * The view supplies components only; the ratio is computed here so the period is an explicit
 * argument rather than an assumption baked into SQL. Both are null when the denominator is
 * zero — see computeDSO's note on why that is not the same as 0.
 */
export async function loadDsoDpo(pool: Pool, periodDays: 90 | 365 = 365) {
  const r = await pool.query(
    `select receivables_open, payables_open, sales_365, purchases_365, sales_90, purchases_90
     from public.dso_dpo_components`);
  const x = r.rows[0];
  const receivables = moneyOrNull(x.receivables_open) ?? 0;
  const payables = moneyOrNull(x.payables_open) ?? 0;
  const sales = moneyOrNull(periodDays === 365 ? x.sales_365 : x.sales_90) ?? 0;
  const purchases = moneyOrNull(periodDays === 365 ? x.purchases_365 : x.purchases_90) ?? 0;
  return {
    periodDays, receivablesOpen: receivables, payablesOpen: payables,
    salesInPeriod: sales, purchasesInPeriod: purchases,
    dso: computeDSO(receivables, sales, periodDays),
    dpo: computeDPO(payables, purchases, periodDays),
  };
}

export async function loadSettlementSpeed(pool: Pool, limit = 100) {
  const r = await pool.query(
    `select s.party_id::text, pa.name as party_name, s.direction, s.settled_invoice_count,
            s.avg_days_to_settle, s.fastest_days, s.slowest_days
     from public.counterparty_settlement_speed s
     join public.parties pa on pa.id = s.party_id
     order by s.avg_days_to_settle desc nulls last limit $1`, [limit]);
  return r.rows.map((x) => ({
    partyId: x.party_id, partyName: x.party_name, direction: x.direction as "sales" | "purchase",
    settledInvoiceCount: intOrNull(x.settled_invoice_count) ?? 0,
    avgDaysToSettle: rateOrNull(x.avg_days_to_settle),
    fastestDays: intOrNull(x.fastest_days), slowestDays: intOrNull(x.slowest_days),
  }));
}

/** Money received or paid that no invoice has claimed — where over-receipt surfaces. */
export async function loadUnallocatedSettlements(pool: Pool, limit = 100) {
  const r = await pool.query(
    `select source_table, source_id::text, to_char(source_date,'YYYY-MM-DD') as source_date,
            description, source_amount, allocated_amount, unallocated_amount, direction
     from public.settlement_unallocated order by unallocated_amount desc limit $1`, [limit]);
  return r.rows.map((x) => ({
    sourceTable: x.source_table, sourceId: x.source_id, sourceDate: x.source_date,
    description: x.description, sourceAmount: moneyOrNull(x.source_amount) ?? 0,
    allocatedAmount: moneyOrNull(x.allocated_amount) ?? 0,
    unallocatedAmount: moneyOrNull(x.unallocated_amount) ?? 0,
    direction: x.direction as "inflow" | "outflow",
  }));
}

export async function loadInvoiceAllocations(pool: Pool, invoiceId: string) {
  const r = await pool.query(
    `select id::text, source_table, source_id::text, allocated_amount,
            to_char(allocated_on,'YYYY-MM-DD') as allocated_on,
            (reversed_at is not null) as reversed, reversed_reason
     from public.invoice_allocations where invoice_id=$1 order by allocated_on, created_at`,
    [invoiceId]);
  return r.rows.map((x) => ({
    id: x.id, sourceTable: x.source_table, sourceId: x.source_id,
    allocatedAmount: moneyOrNull(x.allocated_amount) ?? 0, allocatedOn: x.allocated_on,
    reversed: x.reversed as boolean, reversedReason: x.reversed_reason,
  }));
}

/**
 * Candidate invoices for a settlement, with a proposed FIFO split.
 *
 * A proposal only — `planAllocation` never writes, and the caller must confirm. Allocating to
 * the wrong invoice is exactly as wrong as not allocating at all.
 */
export async function proposeAllocation(
  pool: Pool, partyId: string, direction: "sales" | "purchase", amount: number,
) {
  const r = await pool.query(
    `select id::text, (gross_amount - allocated_amount) as open_amount,
            to_char(due_date,'YYYY-MM-DD') as due_date, to_char(issue_date,'YYYY-MM-DD') as issue_date
     from public.invoices
     where party_id=$1 and direction=$2 and status in ('open','partial')
       and gross_amount > allocated_amount`,
    [partyId, direction]);
  const invoices: AllocatableInvoice[] = r.rows.map((x) => ({
    invoiceId: x.id, openAmount: moneyOrNull(x.open_amount) ?? 0,
    dueDate: x.due_date, issueDate: x.issue_date,
  }));
  return planAllocation(amount, invoices);
}
