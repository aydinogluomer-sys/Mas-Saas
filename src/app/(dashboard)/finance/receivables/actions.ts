"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { recordInvoicePayment } from "@/lib/invoices/engine";
import { postBalancedJournalEntry } from "@/lib/ledger/posting-engine";
import { decimal, moneyOrNull, rateOrNull } from "@/lib/money";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { formObject } from "@/lib/validation";
import {
  allocateBankTransaction,
  allocateToInvoice,
  proposeAllocation,
  reverseAllocation,
} from "@/lib/receivables/engine";

const BASE = "/finance/receivables";

function domainRedirect(e: unknown): never {
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(`${BASE}?error=${encodeURIComponent(toUserActionErrorMessage(e, "Tahsis işlemi tamamlanamadı."))}`);
  }
  throw e;
}

export async function allocateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "insert", BASE);
  const f = formObject(formData);
  const settlementSource = typeof f.settlementSource === "string" ? f.settlementSource.trim() : "";

  // M-33: If settled directly against an active Cash/Bank account (100/102), run full atomic payment + TDHP ledger
  if (settlementSource.startsWith("cash_accounts:")) {
    const [, cashAccountId] = settlementSource.split(":", 2);
    try {
      await recordInvoicePayment(
        getPool(),
        {
          invoiceId: f.invoiceId,
          amount: f.amount,
          cashAccountId,
        },
        session.id,
      );
    } catch (e) {
      domainRedirect(e);
    }
    revalidatePath(BASE);
    revalidatePath("/finance/invoices");
    revalidatePath("/finance/bank");
    revalidatePath("/finance/ledger");
    revalidateFinancialViews();
    redirect(`${BASE}?result=banka-kasa-tahsisi-ve-muhasebe-fisi-islendi`);
  }

  if (settlementSource) {
    if (settlementSource === "manual") {
      f.sourceTable = "manual";
      delete f.sourceId;
    } else if (settlementSource.includes(":")) {
      const [sourceTable, sourceId] = settlementSource.split(":", 2);
      f.sourceTable = sourceTable;
      f.sourceId = sourceId;
    }
    delete f.settlementSource;
  }
  try {
    await allocateToInvoice(getPool(), f, session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidateFinancialViews();
  redirect(`${BASE}?result=dagitim-yapildi`);
}

/**
 * M-33: 120 ↔ 320 Cari Mahsup Protokolü (Bilateral AR/AP Offset).
 * Allocates equal amounts on both a sales invoice (120) and purchase invoice (320) of the same party
 * and posts TDHP `320 Satıcılar (B) / 120 Alıcılar (A)`.
 */
export async function offsetCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "insert", BASE);
  const salesInvoiceId = String(formData.get("salesInvoiceId") ?? "").trim();
  const purchaseInvoiceId = String(formData.get("purchaseInvoiceId") ?? "").trim();
  const amount = Number(formData.get("amount") ?? 0);
  const protocolNote =
    String(formData.get("protocolNote") ?? "").trim() || "120 ↔ 320 Cari Mahsup Protokolü";

  const pool = getPool();
  try {
    if (!salesInvoiceId || !purchaseInvoiceId || salesInvoiceId === purchaseInvoiceId) {
      throw new DomainError("VALIDATION", "Mahsup için geçerli bir satış (120) ve alış (320) faturası seçilmelidir.");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError("VALIDATION", "Mahsup tutarı sıfırdan büyük olmalıdır.");
    }

    const pairRes = await pool.query<{
      id: string;
      party_id: string;
      party_name: string;
      direction: string;
      currency: string;
      invoice_no: string;
      open_amt: string;
    }>(
      `select i.id::text, i.party_id::text, p.name as party_name, i.direction, i.currency, i.invoice_no,
              (coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.allocated_amount, 0), coalesce(i.paid_amount, 0)))::text as open_amt
         from public.invoices i
         join public.parties p on p.id = i.party_id
        where i.id = any($1::uuid[])`,
      [[salesInvoiceId, purchaseInvoiceId]],
    );
    const sInv = pairRes.rows.find((r) => r.id === salesInvoiceId && r.direction === "sales");
    const pInv = pairRes.rows.find((r) => r.id === purchaseInvoiceId && r.direction === "purchase");
    if (!sInv || !pInv) {
      throw new DomainError("NOT_FOUND", "Seçilen satış veya alış faturası bulunamadı.");
    }
    if (sInv.party_id !== pInv.party_id) {
      throw new DomainError("VALIDATION", "Cari mahsup yalnız aynı karşı tarafa (cariye) ait faturalar arasında yapılabilir.");
    }
    if (sInv.currency !== pInv.currency) {
      throw new DomainError("VALIDATION", `Mahsup edilecek faturalar aynı para biriminde olmalıdır (${sInv.currency} ≠ ${pInv.currency}).`);
    }
    const maxOffset = Math.min(moneyOrNull(sInv.open_amt) ?? 0, moneyOrNull(pInv.open_amt) ?? 0);
    if (amount > maxOffset + 0.009) {
      throw new DomainError(
        "VALIDATION",
        `Mahsup tutarı her iki faturanın açık bakiyesini (${maxOffset.toFixed(2)} ${sInv.currency}) aşamaz.`,
      );
    }

    const noteText = `${protocolNote} (${sInv.invoice_no} ↔ ${pInv.invoice_no})`;
    await allocateToInvoice(
      pool,
      { invoiceId: salesInvoiceId, sourceTable: "manual", amount, notes: noteText },
      session.id,
    );
    await allocateToInvoice(
      pool,
      { invoiceId: purchaseInvoiceId, sourceTable: "manual", amount, notes: noteText },
      session.id,
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      let amountTry = Number(decimal(amount).round(2).toFixed(2));
      if (sInv.currency !== "TRY") {
        const fx = await client.query<{ rate: string }>(
          `select rate::text from public.fx_rates
            where base_currency = $1 and quote_currency = 'TRY'
            order by rate_date desc limit 1`,
          [sInv.currency],
        );
        const r = rateOrNull(fx.rows[0]?.rate) ?? 1;
        amountTry = Number(decimal(amount).times(r).round(2).toFixed(2));
      }
      if (amountTry > 0) {
        await postBalancedJournalEntry(
          client,
          {
            entryDate: new Date().toISOString().slice(0, 10),
            description: `Cari Mahsup Fişi (320 ↔ 120): ${sInv.party_name} · ${sInv.invoice_no} / ${pInv.invoice_no}`,
            sourceType: "counterparty_offset",
            sourceTable: "invoices",
            sourceId: salesInvoiceId,
            lines: [
              { accountCode: "320", debit: amountTry, credit: 0, memo: `${pInv.invoice_no} borç mahsubu` },
              { accountCode: "120", debit: 0, credit: amountTry, memo: `${sInv.invoice_no} alacak mahsubu` },
            ],
          },
          session.id,
        );
      }
      await client.query("commit");
    } catch {
      await client.query("rollback").catch(() => {});
    } finally {
      client.release();
    }
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/counterparties");
  revalidatePath("/finance/ledger");
  revalidateFinancialViews();
  redirect(`${BASE}?result=cari-mahsup-320-120-uygulandi`);
}

export async function applyFifoAllocationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "insert", BASE);
  const f = formObject(formData);
  const partyId = typeof f.partyId === "string" ? f.partyId.trim() : "";
  const direction = f.direction === "purchase" ? "purchase" : "sales";
  const rawCurrency = typeof f.currency === "string" ? f.currency.trim().toUpperCase() : "TRY";
  const currency = ["TRY", "USD", "EUR", "GBP"].includes(rawCurrency) ? rawCurrency : "TRY";
  const amount = Number(f.amount ?? 0);
  const settlementSource = typeof f.settlementSource === "string" ? f.settlementSource.trim() : "manual";
  const notes = typeof f.notes === "string" && f.notes.trim() ? f.notes.trim() : "Otomatik FIFO dağıtım";

  let appliedCount = 0;
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(partyId)) {
      throw new DomainError("VALIDATION", "FIFO dağıtımı için geçerli bir karşı taraf seçilmelidir.");
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError("VALIDATION", "FIFO dağıtım tutarı sıfırdan büyük olmalıdır.");
    }

    const pool = getPool();
    const proposal = await proposeAllocation(pool, partyId, direction, amount);
    if (proposal.lines.length === 0) {
      throw new DomainError("CONFLICT", "Seçili cari için dağıtılabilir açık fatura bulunamadı.");
    }

    const invMeta = await pool.query<{ id: string; currency: string }>(
      `select id::text, currency
         from public.invoices
        where id = any($1::uuid[])`,
      [proposal.lines.map((l) => l.invoiceId)],
    );
    const currencyById = new Map(invMeta.rows.map((r) => [r.id, r.currency]));
    const matchingLines = proposal.lines.filter((l) => (currencyById.get(l.invoiceId) ?? "TRY") === currency);

    if (matchingLines.length === 0) {
      throw new DomainError(
        "VALIDATION",
        `Seçili carinin ${currency} para biriminde açık faturası bulunamadı.`,
      );
    }

    if (settlementSource.startsWith("bank_transactions:")) {
      const [, transactionId] = settlementSource.split(":", 2);
      const res = await allocateBankTransaction(
        pool,
        { transactionId, lines: matchingLines },
        session.id,
      );
      appliedCount = res.lineCount;
    } else if (settlementSource.startsWith("cash_accounts:")) {
      const [, cashAccountId] = settlementSource.split(":", 2);
      for (const line of matchingLines) {
        await recordInvoicePayment(
          pool,
          { invoiceId: line.invoiceId, amount: line.amount, cashAccountId },
          session.id,
        );
        appliedCount += 1;
      }
    } else {
      let sourceTable: "manual" | "payment_instances" | "checks" = "manual";
      let sourceId: string | undefined;
      if (settlementSource !== "manual" && settlementSource.includes(":")) {
        const [tbl, sid] = settlementSource.split(":", 2);
        if (tbl === "payment_instances" || tbl === "checks") {
          sourceTable = tbl;
          sourceId = sid;
        }
      }
      for (const line of matchingLines) {
        await allocateToInvoice(
          pool,
          {
            invoiceId: line.invoiceId,
            sourceTable,
            ...(sourceId ? { sourceId } : {}),
            amount: line.amount,
            notes,
          },
          session.id,
        );
        appliedCount += 1;
      }
    }
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/counterparties");
  revalidateFinancialViews();
  redirect(`${BASE}?result=${encodeURIComponent(`fifo-dagitim-uygulandi-${appliedCount}-fatura`)}`);
}

export async function reverseAllocationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "update", BASE);
  try {
    await reverseAllocation(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidateFinancialViews();
  redirect(`${BASE}?result=dagitim-iptal`);
}
