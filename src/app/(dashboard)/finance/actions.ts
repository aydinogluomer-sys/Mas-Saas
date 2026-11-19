"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { DomainError } from "@/lib/domain-error";
import { audit } from "@/lib/audit";
import { decimal, money } from "@/lib/money";
import {
  CHECK_BORDRO_OPERATIONS,
  CHECK_STATUS_LABELS_TR,
  executeCheckBordroTransition,
  type CheckBordroOperation,
} from "@/lib/financing/check-bordro";
import {
  cancelCheck,
  cancelLoanInstallment,
  classifyUnknownCheck,
  mapAcceptedChecks,
  mapLoans,
  markCheckBounced,
  markCheckCleared,
  markInstallmentPaid,
} from "@/lib/financing/engine";
import {
  createLoanWithAmortization,
  LOAN_INTEREST_TYPES,
  LOAN_KINDS,
  LOAN_SCHEDULE_METHODS,
  type LoanInterestType,
  type LoanKind,
  type LoanScheduleMethod,
} from "@/lib/financing/loans-amortization";
import { addMonthsPreservingAnchorDay } from "@/lib/financing/rules";
import { isMissingSchemaError } from "@/lib/ledger/accounts";
import { postJournalEntryWithClient } from "@/lib/ledger/posting-engine";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { cancelActionSchema } from "@/lib/validation/financial";

const number = (v: FormDataEntryValue | null) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const installmentCountSchema = z.number().int().min(1).max(360);
const ALLOWED_CURRENCIES = new Set(["TRY", "USD", "EUR", "GBP"]);

export async function createCheckAction(formData: FormData) {
  const session = await requireActionPermission("checks", "insert", "/finance");
  const date = String(formData.get("maturityDate") ?? "").trim();
  const rawAmount = number(formData.get("amount"));
  const amount = rawAmount == null ? null : money(Math.abs(rawAmount));
  const rawDirection = String(formData.get("direction") ?? "outflow");
  const direction =
    rawDirection === "inflow" || rawDirection === "outflow" ? rawDirection : "unknown";
  const rawInstrument = String(formData.get("instrumentType") ?? "check");
  const instrumentType = rawInstrument === "promissory_note" ? "promissory_note" : "check";
  const rawCurrency = String(formData.get("currency") ?? "TRY").trim().toUpperCase();
  const currency = ALLOWED_CURRENCIES.has(rawCurrency) ? rawCurrency : "TRY";
  if (!date) throw new DomainError("VALIDATION_ERROR", "Vade tarihi zorunlu.");

  const partyIdRaw = String(formData.get("partyId") ?? "").trim() || null;
  const settledInvoiceId = String(formData.get("settledInvoiceId") ?? "").trim() || null;
  const issueDate = String(formData.get("issueDate") ?? "").trim() || null;
  const issuePlace = String(formData.get("issuePlace") ?? "").trim() || null;
  const drawerTaxNo = String(formData.get("drawerTaxNo") ?? "").trim() || null;
  const serial = String(formData.get("serial") ?? "").trim() || null;
  const counterpartyInput = String(formData.get("counterparty") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const signed =
    amount == null
      ? null
      : direction === "outflow"
        ? money(decimal(amount).times(-1))
        : amount;
  const initialStatus =
    direction === "inflow"
      ? "in_portfolio"
      : direction === "outflow"
        ? "issued_to_vendor"
        : "planned";

  const pool = getPool();
  const client = await pool.connect();
  let createdId: string;
  try {
    await client.query("begin");

    let resolvedPartyId = partyIdRaw;
    let resolvedPartyName = counterpartyInput;
    if (resolvedPartyId) {
      const pRes = await client.query<{ name: string; tax_no: string | null }>(
        `select name, tax_no from public.parties where id = $1`,
        [resolvedPartyId],
      );
      if (pRes.rows[0] && !resolvedPartyName) {
        resolvedPartyName = pRes.rows[0].name;
      }
    }

    let lockedInvoice: {
      id: string;
      invoice_no: string;
      direction: string;
      currency: string;
      party_id: string | null;
      open_amount: string;
    } | null = null;

    if (settledInvoiceId) {
      if (amount == null || amount <= 0) {
        throw new DomainError("VALIDATION_ERROR", "Fatura mahsubu için çek/senet tutarı sıfırdan büyük olmalıdır.");
      }
      if (direction === "unknown") {
        throw new DomainError("VALIDATION_ERROR", "Fatura mahsubu için evrak yönü (tahsil / ödeme) seçilmelidir.");
      }
      const invRes = await client.query<{
        id: string;
        invoice_no: string;
        direction: string;
        currency: string;
        party_id: string | null;
        open_amount: string;
      }>(
        `select id::text as id,
                coalesce(invoice_no, left(id::text, 8)) as invoice_no,
                direction,
                coalesce(currency, 'TRY') as currency,
                party_id::text as party_id,
                greatest(
                  0,
                  coalesce(payable_amount, gross_amount) -
                  greatest(coalesce(paid_amount, 0), coalesce(allocated_amount, 0))
                )::numeric(14,2)::text as open_amount
           from public.invoices
          where id = $1
            and status in ('open', 'partial')
            and archived_at is null
          for update`,
        [settledInvoiceId],
      );
      if (invRes.rowCount !== 1) {
        throw new DomainError("NOT_FOUND", "Seçilen açık fatura bulunamadı veya kapanmış.");
      }
      lockedInvoice = invRes.rows[0];
      if (lockedInvoice.currency !== currency) {
        throw new DomainError(
          "CONFLICT",
          `Evrak para birimi (${currency}) ile fatura para birimi (${lockedInvoice.currency}) eşleşmelidir.`,
        );
      }
      const expectedDirection = direction === "inflow" ? "sales" : "purchase";
      if (lockedInvoice.direction !== expectedDirection) {
        throw new DomainError(
          "CONFLICT",
          direction === "inflow"
            ? "Müşteri tahsilat evrakı yalnız satış (120) faturasıyla mahsuplaştırılabilir."
            : "Tedarikçi ödeme evrakı yalnız alış (320) faturasıyla mahsuplaştırılabilir.",
        );
      }
      if (decimal(amount).gt(decimal(lockedInvoice.open_amount).plus("0.01"))) {
        throw new DomainError(
          "CONFLICT",
          `Evrak tutarı (${amount} ${currency}) faturanın açık bakiyesini (${lockedInvoice.open_amount} ${currency}) aşıyor.`,
        );
      }
      if (!resolvedPartyId && lockedInvoice.party_id) {
        resolvedPartyId = lockedInvoice.party_id;
      }
    }

    const payerPartyId = direction === "inflow" ? resolvedPartyId : null;
    const payeePartyId = direction === "outflow" ? resolvedPartyId : null;

    let result: { rows: Array<{ id: string }>; rowCount: number | null };
    await client.query("savepoint chk_insert_v6_sp");
    try {
      result = await client.query<{ id: string }>(
        `insert into public.checks
           (maturity_date, serial_no, counterparty_label, payer_party_id, payee_party_id,
            settled_invoice_id, issue_date, issue_place, drawer_tax_no,
            amount, signed_amount, currency, instrument_type, direction, status, notes)
         values ($1::date, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         returning id::text as id`,
        [
          date,
          serial,
          resolvedPartyName,
          payerPartyId,
          payeePartyId,
          lockedInvoice ? lockedInvoice.id : null,
          issueDate,
          issuePlace,
          drawerTaxNo,
          amount,
          signed,
          currency,
          instrumentType,
          direction,
          initialStatus,
          notes,
        ],
      );
      await client.query("release savepoint chk_insert_v6_sp");
    } catch (insErr) {
      await client.query("rollback to savepoint chk_insert_v6_sp");
      await client.query("release savepoint chk_insert_v6_sp");
      const pgCode = (insErr as { code?: string })?.code;
      if (pgCode !== "42703") throw insErr;
      result = await client.query<{ id: string }>(
        `insert into public.checks
           (maturity_date, serial_no, counterparty_label, amount, signed_amount,
            currency, instrument_type, direction, status, notes)
         values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id::text as id`,
        [date, serial, resolvedPartyName, amount, signed, currency, instrumentType, direction, initialStatus, notes],
      );
    }

    if (result.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Çek/senet kaydı oluşturulamadı.");
    }
    createdId = result.rows[0].id;

    if (lockedInvoice && amount != null && amount > 0) {
      const allocAmt = decimal(amount).gt(decimal(lockedInvoice.open_amount))
        ? decimal(lockedInvoice.open_amount).toFixed(2)
        : decimal(amount).toFixed(2);
      await client.query(
        `insert into public.invoice_allocations
           (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
         values ($1, 'checks', $2, $3::numeric, $4::date, $5, $6)`,
        [
          lockedInvoice.id,
          createdId,
          allocAmt,
          issueDate ?? date,
          `Evrak kaydı ile fatura mahsubu (${serial ?? createdId.slice(0, 8)})`,
          session.id,
        ],
      );
    }

    await client.query(
      `insert into public.check_events (check_id, event_type, event_note, created_by)
       values ($1, 'created', $2, $3)`,
      [
        createdId,
        `Manuel ${instrumentType === "promissory_note" ? "senet" : "çek"} kaydı (${initialStatus})`,
        session.id,
      ],
    );

    if (amount != null && amount > 0 && (direction === "inflow" || direction === "outflow")) {
      const entryDate = issueDate ?? date;
      const amtStr = decimal(amount).toFixed(2);
      const debitCode =
        direction === "inflow"
          ? instrumentType === "promissory_note"
            ? "121"
            : "101"
          : "320";
      const creditCode =
        direction === "inflow"
          ? "120"
          : instrumentType === "promissory_note"
            ? "321"
            : "103";

      await client.query("savepoint chk_open_je_sp");
      try {
        await postJournalEntryWithClient(
          client,
          {
            entryDate,
            sourceType: "check_bordro",
            sourceId: createdId,
            idempotencyKey: `check_create:${createdId}`,
            description: `${
              direction === "inflow" ? "Alınan" : "Keşide Edilen"
            } ${instrumentType === "promissory_note" ? "Senet" : "Çek"} Kaydı (${serial ?? createdId.slice(0, 8)})`,
            currency,
            lines: [
              {
                accountCode: debitCode,
                debitNative: amtStr,
                partyId: resolvedPartyId,
                memo: `${resolvedPartyName ?? "Cari"} (${serial ?? "evrak"})`,
              },
              {
                accountCode: creditCode,
                creditNative: amtStr,
                partyId: resolvedPartyId,
                memo: lockedInvoice
                  ? `Fatura mahsubu: ${lockedInvoice.invoice_no}`
                  : `${resolvedPartyName ?? "Cari"} (${serial ?? "evrak"})`,
              },
            ],
          },
          session.id,
        );
        await client.query("release savepoint chk_open_je_sp");
      } catch (jeErr) {
        await client.query("rollback to savepoint chk_open_je_sp");
        await client.query("release savepoint chk_open_je_sp");
        if (!isMissingSchemaError(jeErr)) throw jeErr;
      }
    }

    await audit(client, {
      actor: session.id,
      action: "create_check",
      entityTable: "checks",
      entityId: createdId,
      after: {
        date,
        amount,
        currency,
        instrumentType,
        direction,
        status: initialStatus,
        settledInvoiceId: lockedInvoice?.id ?? null,
        issueDate,
        issuePlace,
      },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (isPgPeriodLockedError(error) || isHandledActionError(error)) {
      errorRedirect("/finance/checks", toUserActionErrorMessage(error, "Çek/senet kaydı oluşturulamadı."));
    }
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/finance");
  revalidatePath("/finance/checks");
  revalidateFinancialViews();
  redirect("/finance/checks?flash=saved");
}

export async function executeCheckBordroAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("check_bordros", "insert", "/finance/checks");
  const backTo = backOf(formData, "/finance/checks");
  const rawOperation = String(formData.get("operation") ?? "").trim();
  if (!(CHECK_BORDRO_OPERATIONS as readonly string[]).includes(rawOperation)) {
    errorRedirect(backTo, "Geçersiz çek/senet bordro işlemi.");
  }
  const checkIds = formData
    .getAll("checkIds")
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (checkIds.length === 0) {
    errorRedirect(backTo, "Bordro işlemi için en az bir çek veya senet seçmelisiniz.");
  }
  const bordroDate = String(formData.get("bordroDate") ?? "").trim() || undefined;
  const targetInvoiceId = String(formData.get("targetInvoiceId") ?? "").trim() || null;
  const targetBankAccountId = String(formData.get("targetBankAccountId") ?? "").trim() || null;
  const targetFacilityId = String(formData.get("targetFacilityId") ?? "").trim() || null;
  const rawLtv = number(formData.get("ltvRatio"));
  const rawDiscountFee = number(formData.get("discountFeeAmount"));
  const notes = String(formData.get("notes") ?? "").trim() || null;

  let res;
  try {
    res = await executeCheckBordroTransition(
      getPool(),
      {
        operation: rawOperation as CheckBordroOperation,
        checkIds,
        bordroDate,
        targetInvoiceId,
        targetBankAccountId,
        targetFacilityId,
        ltvRatio: rawLtv ?? 0.8,
        discountFeeAmount: rawDiscountFee != null && rawDiscountFee >= 0 ? rawDiscountFee : 0,
        notes,
      },
      session.id,
    );
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Bordro işlemi tamamlanamadı."));
    }
    throw e;
  }

  revalidatePath("/finance/checks");
  revalidateFinancialViews();
  const nextLabel = CHECK_STATUS_LABELS_TR[res.nextStatus] ?? res.nextStatus;
  redirect(
    `/finance/checks?flash=saved&result=${encodeURIComponent(
      `Bordro ${res.bordroNo} uygulandı (${res.processedCount} evrak → ${nextLabel}).`,
    )}`,
  );
}

export async function createLoanAction(formData: FormData) {
  const session = await requireActionPermission("loans", "insert", "/finance");
  const name = String(formData.get("name") ?? "").trim();
  const principal = number(formData.get("principal"));
  const rawCount = number(formData.get("installmentCount"));
  const installment = number(formData.get("installmentAmount"));
  const first = String(formData.get("firstPaymentDate") ?? "").trim();
  const rawScheduleMethod = String(formData.get("scheduleMethod") ?? "").trim();
  const rawAnnualRate = number(formData.get("annualInterestRatePct"));

  // M-38: Full commercial amortization / spot / leasing / TLREF-SOFR-EURIBOR generator
  if (rawScheduleMethod || rawAnnualRate != null) {
    const rawKind = String(formData.get("loanKind") ?? "installment").trim();
    const loanKind: LoanKind = (LOAN_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as LoanKind)
      : "installment";
    const scheduleMethod: LoanScheduleMethod = (LOAN_SCHEDULE_METHODS as readonly string[]).includes(
      rawScheduleMethod,
    )
      ? (rawScheduleMethod as LoanScheduleMethod)
      : loanKind === "leasing"
        ? "leasing"
        : loanKind === "spot"
          ? "spot"
          : "annuity";
    const rawIntType = String(formData.get("interestType") ?? "fixed").trim();
    const interestType: LoanInterestType = (LOAN_INTEREST_TYPES as readonly string[]).includes(rawIntType)
      ? (rawIntType as LoanInterestType)
      : "fixed";
    const rawCurrency = String(formData.get("currency") ?? "TRY").trim().toUpperCase();
    const currency = ALLOWED_CURRENCIES.has(rawCurrency) ? rawCurrency : "TRY";

    try {
      const created = await createLoanWithAmortization(
        getPool(),
        {
          name,
          lenderPartyId: String(formData.get("lenderPartyId") ?? "").trim() || null,
          currency,
          loanKind,
          scheduleMethod,
          interestType,
          principal: principal ?? 0,
          installmentCount: rawCount ?? 12,
          firstPaymentDate: first,
          disbursementDate: String(formData.get("disbursementDate") ?? "").trim() || first,
          annualInterestRatePct: rawAnnualRate ?? 0,
          referenceRatePct: number(formData.get("referenceRatePct")),
          spreadBps: number(formData.get("spreadBps")),
          bsmvRate: number(formData.get("bsmvRate")) ?? 0.05,
          kkdfRate: number(formData.get("kkdfRate")) ?? 0,
          disbursementAccountId: String(formData.get("disbursementAccountId") ?? "").trim() || null,
          notes: String(formData.get("notes") ?? "").trim() || null,
        },
        session.id,
      );
      revalidatePath("/finance");
      revalidatePath("/finance/loans");
      revalidateFinancialViews();
      redirect(`/finance/loans/${created.loanId}`);
    } catch (error) {
      if (isPgPeriodLockedError(error) || isHandledActionError(error)) {
        errorRedirect("/finance/loans/new", toUserActionErrorMessage(error, "Kredi ödeme planı oluşturulamadı."));
      }
      throw error;
    }
  }

  // Legacy flat-installment fallback
  if (!name || principal == null || rawCount == null || installment == null || !first) {
    throw new DomainError("VALIDATION_ERROR", "Kredi temel alanları zorunlu.");
  }
  const parsedCount = installmentCountSchema.safeParse(rawCount);
  if (!parsedCount.success) {
    throw new DomainError("VALIDATION_ERROR", "Taksit sayısı 1 ile 360 arasında tam sayı olmalı.");
  }
  const count = parsedCount.data;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const total = money(decimal(installment).times(decimal(count)));
    const financeCost = money(decimal(total).minus(decimal(principal)));
    const loan = await client.query(
      `insert into public.loans(name,principal,installment_count,first_payment_date,installment_amount,total_payment,total_finance_cost,status) values($1,$2,$3,$4,$5,$6,$7,'active') returning id`,
      [name, principal, count, first, installment, total, financeCost],
    );
    for (let i = 0; i < count; i++) {
      const { dueDate } = addMonthsPreservingAnchorDay(first, i);
      await client.query(
        `insert into public.loan_installments(loan_id,installment_no,due_date,amount,status) values($1,$2,$3,$4,'planned')`,
        [loan.rows[0].id, i + 1, dueDate, installment],
      );
    }
    await audit(client, {
      actor: session.id,
      action: "create_loan",
      entityTable: "loans",
      entityId: loan.rows[0].id,
      after: { name, principal, count },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (isPgPeriodLockedError(error) || isHandledActionError(error)) {
      errorRedirect("/finance/loans", toUserActionErrorMessage(error, "Kredi kaydı oluşturulamadı."));
    }
    throw error;
  } finally {
    client.release();
  }
  revalidatePath("/finance");
  revalidatePath("/finance/loans");
  redirect("/finance/loans");
}

function backOf(formData: FormData, fallback: string): string {
  return safeRedirectPath(formData.get("backTo"), fallback);
}
function errorRedirect(backTo: string, message: string): never {
  redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

export async function markCheckClearedAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckCleared(getPool(), id, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Çek tahsil işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markCheckBouncedAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const backTo = backOf(formData, "/finance/checks");
  try {
    await markCheckBounced(getPool(), id, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Karşılıksız çek işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function markInstallmentPaidAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("loan_installments", "update", "/finance");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const raw = String(formData.get("paidAt") ?? "").trim();
  const backTo = backOf(formData, "/finance/loans");
  try {
    await markInstallmentPaid(getPool(), id, raw === "" ? null : raw, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Kredi taksiti ödeme işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance");
}

export async function mapFinancingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "insert", "/finance");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  let checksCreated = 0;
  let loansCreated = 0;
  let installmentsCreated = 0;
  try {
    const c = await mapAcceptedChecks(pool, workbookId, session.id);
    const l = await mapLoans(pool, workbookId, session.id);
    checksCreated = c.created;
    loansCreated = l.created;
    installmentsCreated = l.installmentsCreated;
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance", toUserActionErrorMessage(e, "Finansman kayıtları eşleştirilemedi."));
    }
    throw e;
  }
  revalidatePath("/finance");
  redirect(`/finance?checks=${checksCreated}&loans=${loansCreated}&installments=${installmentsCreated}`);
}

export async function classifyUnknownCheckAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance/checks");
  const id = String(formData.get("id") ?? "").trim();
  const targetStatus = String(formData.get("targetStatus") ?? "").trim();
  const backTo = backOf(formData, "/finance/checks");
  if (!id || (targetStatus !== "in_portfolio" && targetStatus !== "issued_to_vendor")) {
    errorRedirect(backTo, "Çek sınıflandırması için geçerli hedef durum seçilmelidir.");
  }
  try {
    await classifyUnknownCheck(getPool(), id, targetStatus, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect(backTo, toUserActionErrorMessage(e, "Çek sınıflandırma işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath(backTo);
  revalidatePath("/finance/checks");
  revalidateFinancialViews();
}

export async function cancelCheckAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", "/finance");
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/finance/checks?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  try {
    await cancelCheck(getPool(), parsed.data.id, parsed.data.reason, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance/checks", toUserActionErrorMessage(e, "Çek iptal işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/checks");
}

export async function cancelLoanInstallmentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("loan_installments", "update", "/finance");
  const parsed = cancelActionSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    redirect(`/finance/loans?error=${encodeURIComponent("İptal için geçerli bir neden gerekli.")}`);
  }
  try {
    await cancelLoanInstallment(getPool(), parsed.data.id, parsed.data.reason, session.id);
  } catch (e) {
    if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
      errorRedirect("/finance/loans", toUserActionErrorMessage(e, "Kredi taksiti iptal işlemi tamamlanamadı."));
    }
    throw e;
  }
  revalidatePath("/finance");
  revalidatePath("/finance/loans");
}
