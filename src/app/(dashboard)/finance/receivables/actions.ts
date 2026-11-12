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
  redirect(`${BASE}?result=dagitim-yapildi`);
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
  redirect(`${BASE}?result=dagitim-iptal`);
}
