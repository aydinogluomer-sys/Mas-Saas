// Faz 52 (E2) — Çift Taraflı Yönetim Defteri Otomatik Fiş Kural Motoru,
// Manuel Dönem Sonu Tahakkuk Fişi, Ters Kayıt (Reversal) ve Görünüm Okuyucuları.
//
// Kurallar:
//   * Sıfır kayan nokta: tüm tutarlar @/lib/money (big.js) ve PostgreSQL numeric(14,2)/(16,2) üzerinden geçer.
//   * BLANK ≠ ZERO:
//     - Dövizli işlemde işlem tarihine ait TCMB kuru yoksa asla 1.0 yazılmaz; fiş status='provisional_fx'
//       ve debit_try/credit_try = NULL olarak kaydedilir, kur geldiğinde otomatik değerlenir.
//     - Satırsız basit gider/satış faturasında tax_amount IS NULL ise uydurma 0 KDV satırı açılmaz;
//       needs_tax_split_review = true bayrağıyla işaretlenir.
//   * İdempotent: aynı idempotency_key ile ikinci kez çağrıldığında mükerrer fiş üretmez.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, money, moneyOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { getManagementAccountIdByCode, isMissingSchemaError } from "./accounts";

export type JournalSourceType =
  | "invoice"
  | "bank_transaction"
  | "check_bordro"
  | "loan_installment"
  | "loan_disbursement"
  | "facility_movement"
  | "interbank_transfer"
  | "counterparty_offset"
  | "doubtful_provision"
  | "period_closing"
  | "payroll_tax_accrual"
  | "production_movement"
  | "payment_instance"
  | "manual_adjustment"
  | "fx_revaluation"
  | "reversal"
  | "opening_balance";

export type JournalEntryStatus = "draft" | "provisional_fx" | "posted" | "reversed";

export interface JournalLineInput {
  accountCode: string;
  debitNative?: number | string;
  creditNative?: number | string;
  lineCurrency?: string;
  fxRateOverride?: number | null;
  debitTryOverride?: number | string | null;
  creditTryOverride?: number | string | null;
  partyId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
  departmentId?: string | null;
  memo?: string | null;
}

export interface PostJournalEntrySpec {
  entryDate: string;
  sourceType: JournalSourceType;
  sourceId?: string | null;
  idempotencyKey: string;
  description: string;
  currency?: string;
  fxRate?: number | null;
  status?: "draft" | "posted";
  needsTaxSplitReview?: boolean;
  lines: JournalLineInput[];
}

export interface PostJournalEntryResult {
  entryId: string;
  entryNo: number;
  status: JournalEntryStatus;
  created: boolean;
  needsTaxSplitReview: boolean;
}

/**
 * Looks up the latest TCMB FX rate on or before `entryDate` for `currency -> TRY`.
 * Returns `1` for `TRY`, or `null` when unknown (`BLANK ≠ ZERO` — never fabricates `1.0`).
 */
export async function resolveFxRateOrNull(
  client: PoolClient,
  currency: string,
  entryDate: string,
): Promise<number | null> {
  const cleanCurr = currency.trim().toUpperCase();
  if (cleanCurr === "TRY") return 1;

  const res = await client.query<{ rate: string }>(
    `select rate::text
       from public.fx_rate_snapshots
      where base_currency = $1
        and quote_currency = 'TRY'
        and rate_date <= $2::date
      order by rate_date desc
      limit 1`,
    [cleanCurr, entryDate],
  );
  if (!res.rows[0]?.rate) return null;
  const parsed = Number(res.rows[0].rate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface BalancedTryJournalLineInput {
  accountCode: string;
  debit: number | string;
  credit: number | string;
  memo?: string | null;
  partyId?: string | null;
}

export interface PostBalancedJournalEntrySpec {
  entryDate: string;
  description: string;
  sourceType: JournalSourceType | "manual";
  sourceTable?: string | null;
  sourceId?: string | null;
  idempotencyKey?: string;
  lines: BalancedTryJournalLineInput[];
}

/**
 * Convenience wrapper for balanced TRY journal entries (doubtful AR provisions,
 * 320 <-> 120 counterparty offsets, EFT/SWIFT fee write-offs, inline FX settlements).
 */
export async function postBalancedJournalEntry(
  client: PoolClient,
  spec: PostBalancedJournalEntrySpec,
  actorId: string | null,
): Promise<PostJournalEntryResult> {
  const resolvedSourceType: JournalSourceType =
    spec.sourceType === "manual" ? "manual_adjustment" : spec.sourceType;
  const sig = spec.lines
    .map((l) => `${l.accountCode}:${decimal(l.debit || 0).toFixed(2)}:${decimal(l.credit || 0).toFixed(2)}`)
    .join("|");
  const idempotencyKey =
    spec.idempotencyKey ??
    `balanced:${resolvedSourceType}:${spec.sourceTable ?? "je"}:${spec.sourceId ?? spec.entryDate}:${sig}`;

  return postJournalEntryWithClient(
    client,
    {
      entryDate: spec.entryDate,
      sourceType: resolvedSourceType,
      sourceId: spec.sourceId ?? null,
      idempotencyKey,
      description: spec.description,
      currency: "TRY",
      fxRate: 1,
      status: "posted",
      lines: spec.lines.map((l) => ({
        accountCode: l.accountCode,
        debitNative: l.debit,
        creditNative: l.credit,
        lineCurrency: "TRY",
        fxRateOverride: 1,
        debitTryOverride: l.debit,
        creditTryOverride: l.credit,
        partyId: l.partyId ?? null,
        memo: l.memo ?? null,
      })),
    },
    actorId,
  );
}

/**
 * Core idempotent double-entry journal writer inside an active transaction.
 */
export async function postJournalEntryWithClient(
  client: PoolClient,
  spec: PostJournalEntrySpec,
  actorId: string | null,
): Promise<PostJournalEntryResult> {
  const baseKey = spec.idempotencyKey.trim();
  if (!baseKey) {
    throw new DomainError("Yevmiye fişi idempotency_key boş olamaz.");
  }

  let idemKey = baseKey;
  for (let attempt = 1; attempt <= 25; attempt++) {
    const candidateKey = attempt === 1 ? baseKey : `${baseKey}:r${attempt}`;
    const existing = await client.query<{
      id: string;
      entry_no: string;
      status: JournalEntryStatus;
      needs_tax_split_review: boolean;
    }>(
      `select id::text, entry_no::text, status, needs_tax_split_review
         from public.management_journal_entries
        where idempotency_key = $1
        limit 1`,
      [candidateKey],
    );
    const row = existing.rows[0];
    if (!row) {
      idemKey = candidateKey;
      break;
    }
    if (row.status !== "reversed") {
      return {
        entryId: row.id,
        entryNo: Number(row.entry_no),
        status: row.status,
        created: false,
        needsTaxSplitReview: row.needs_tax_split_review,
      };
    }
    // Mevcut fiş ters kayıtla (storno) kapatılmışsa ve olay yeniden gerçekleşmişse yeni nesil anahtar kullan
    idemKey = `${baseKey}:r${attempt + 1}`;
  }

  if (spec.lines.length < 2) {
    throw new DomainError("Çift taraflı yevmiye fişi en az 2 satır içermelidir.");
  }

  const currency = (spec.currency ?? "TRY").trim().toUpperCase();
  const explicitFx =
    spec.fxRate !== undefined
      ? spec.fxRate
      : await resolveFxRateOrNull(client, currency, spec.entryDate);

  const hasPerLineOverrides = spec.lines.some(
    (l) =>
      l.lineCurrency !== undefined ||
      l.fxRateOverride !== undefined ||
      l.debitTryOverride != null ||
      l.creditTryOverride != null,
  );

  // Check if any line in a multi-currency entry lacks a known FX rate
  let missingAnyFx = currency !== "TRY" && (explicitFx == null || explicitFx <= 0);
  if (hasPerLineOverrides) {
    missingAnyFx = false;
    for (const l of spec.lines) {
      const lc = (l.lineCurrency ?? currency).trim().toUpperCase();
      if (lc === "TRY") continue;
      if (l.debitTryOverride != null || l.creditTryOverride != null) continue;
      const lf =
        l.fxRateOverride !== undefined
          ? l.fxRateOverride
          : lc === currency
            ? explicitFx
            : await resolveFxRateOrNull(client, lc, spec.entryDate);
      if (lf == null || lf <= 0) {
        missingAnyFx = true;
        break;
      }
    }
  }

  const effectiveStatus: JournalEntryStatus =
    spec.status === "draft"
      ? "draft"
      : missingAnyFx
        ? "provisional_fx"
        : "posted";

  const needsTaxSplitReview = Boolean(spec.needsTaxSplitReview);

  // Convert lines to TRY if FX rate is known
  const preparedLines: Array<{
    lineNo: number;
    accountId: string;
    accountCode: string;
    partyId: string | null;
    projectId: string | null;
    costCenterId: string | null;
    departmentId: string | null;
    nativeCurrency: string;
    debitNative: string;
    creditNative: string;
    fxRate: number | null;
    debitTry: string | null;
    creditTry: string | null;
    memo: string | null;
  }> = [];

  for (let i = 0; i < spec.lines.length; i++) {
    const line = spec.lines[i];
    const lineCurr = (line.lineCurrency ?? currency).trim().toUpperCase();
    const debitNat = decimal(line.debitNative ?? 0).round(2);
    const creditNat = decimal(line.creditNative ?? 0).round(2);
    if (
      (debitNat.gt(0) && creditNat.gt(0)) ||
      (debitNat.lte(0) && creditNat.lte(0))
    ) {
      throw new DomainError(
        `Yevmiye satırı #${i + 1} (${line.accountCode}) yalnız borç veya yalnız alacak taşımalıdır.`,
      );
    }

    const accountId = await getManagementAccountIdByCode(client, line.accountCode);

    let debitTry: string | null = null;
    let creditTry: string | null = null;
    let fxRateToStore: number | null = null;

    if (effectiveStatus !== "provisional_fx") {
      const resolvedLineFx =
        line.fxRateOverride !== undefined
          ? line.fxRateOverride
          : lineCurr === "TRY"
            ? 1
            : lineCurr === currency
              ? explicitFx
              : await resolveFxRateOrNull(client, lineCurr, spec.entryDate);

      if (line.debitTryOverride != null && debitNat.gt(0)) {
        fxRateToStore = resolvedLineFx && resolvedLineFx > 0 ? resolvedLineFx : 1;
        debitTry = decimal(line.debitTryOverride).round(2).toFixed(2);
        creditTry = "0.00";
      } else if (line.creditTryOverride != null && creditNat.gt(0)) {
        fxRateToStore = resolvedLineFx && resolvedLineFx > 0 ? resolvedLineFx : 1;
        debitTry = "0.00";
        creditTry = decimal(line.creditTryOverride).round(2).toFixed(2);
      } else if (resolvedLineFx != null && resolvedLineFx > 0) {
        fxRateToStore = resolvedLineFx;
        if (debitNat.gt(0)) {
          debitTry = debitNat.times(resolvedLineFx).round(2).toFixed(2);
          creditTry = "0.00";
        } else {
          debitTry = "0.00";
          creditTry = creditNat.times(resolvedLineFx).round(2).toFixed(2);
        }
      }
    }

    preparedLines.push({
      lineNo: i + 1,
      accountId,
      accountCode: line.accountCode,
      partyId: line.partyId ?? null,
      projectId: line.projectId ?? null,
      costCenterId: line.costCenterId ?? null,
      departmentId: line.departmentId ?? null,
      nativeCurrency: lineCurr,
      debitNative: debitNat.toFixed(2),
      creditNative: creditNat.toFixed(2),
      fxRate: fxRateToStore,
      debitTry,
      creditTry,
      memo: line.memo ?? null,
    });
  }

  // If FX conversion caused a 1-kuruş rounding residual on a natively balanced entry, absorb it on the last credit/debit line
  if (effectiveStatus === "posted" && !hasPerLineOverrides && currency !== "TRY") {
    const natDebit = preparedLines.reduce((acc, l) => acc.plus(l.debitNative), decimal(0));
    const natCredit = preparedLines.reduce((acc, l) => acc.plus(l.creditNative), decimal(0));
    if (natDebit.eq(natCredit)) {
      const tryDebit = preparedLines.reduce((acc, l) => acc.plus(l.debitTry ?? 0), decimal(0));
      const tryCredit = preparedLines.reduce((acc, l) => acc.plus(l.creditTry ?? 0), decimal(0));
      const diff = tryDebit.minus(tryCredit);
      if (!diff.eq(0) && diff.abs().lte("0.05")) {
        const targetCreditLine = [...preparedLines].reverse().find((l) => decimal(l.creditTry ?? 0).gt(0));
        if (targetCreditLine && targetCreditLine.creditTry) {
          targetCreditLine.creditTry = decimal(targetCreditLine.creditTry).plus(diff).round(2).toFixed(2);
        }
      }
    }
  }

  const entryIns = await client.query<{ id: string; entry_no: string; status: JournalEntryStatus }>(
    `insert into public.management_journal_entries
       (entry_date, source_type, source_id, idempotency_key, status,
        needs_tax_split_review, description, created_by)
     values ($1::date, $2, $3, $4, $5, $6, $7, $8)
     returning id::text, entry_no::text, status`,
    [
      spec.entryDate,
      spec.sourceType,
      spec.sourceId ?? null,
      idemKey,
      effectiveStatus,
      needsTaxSplitReview,
      spec.description.trim(),
      actorId,
    ],
  );
  const entryId = entryIns.rows[0].id;
  const entryNo = Number(entryIns.rows[0].entry_no);

  for (const pl of preparedLines) {
    await client.query(
      `insert into public.management_journal_lines
         (entry_id, line_no, account_id, party_id, project_id, cost_center_id, department_id,
          native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
       values ($1, $2, $3, $4, $5, $6, $7,
               $8, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14)`,
      [
        entryId,
        pl.lineNo,
        pl.accountId,
        pl.partyId,
        pl.projectId,
        pl.costCenterId,
        pl.departmentId,
        pl.nativeCurrency,
        pl.debitNative,
        pl.creditNative,
        pl.fxRate,
        pl.debitTry,
        pl.creditTry,
        pl.memo,
      ],
    );
  }

  await audit(client, {
    actor: actorId,
    action: "post_management_journal_entry",
    entityTable: "management_journal_entries",
    entityId: entryId,
    after: {
      entryNo,
      entryDate: spec.entryDate,
      sourceType: spec.sourceType,
      sourceId: spec.sourceId ?? null,
      idempotencyKey: idemKey,
      status: effectiveStatus,
      currency,
      fxRate: explicitFx ?? null,
      needsTaxSplitReview,
      lineCount: preparedLines.length,
    },
  });

  return {
    entryId,
    entryNo,
    status: effectiveStatus,
    created: true,
    needsTaxSplitReview,
  };
}

/**
 * Synchronizes a single domain event (invoice, bank_transaction, check_bordro, loan_installment)
 * into the double-entry management ledger idempotently.
 */
export async function syncDomainEventToManagementLedger(
  pool: Pool,
  event:
    | { kind: "invoice"; invoiceId: string; expenseAccountCode?: string }
    | { kind: "bank_transaction"; bankTransactionId: string }
    | { kind: "check_bordro"; bordroId: string }
    | { kind: "loan_installment"; installmentId: string },
  actorId: string | null,
): Promise<PostJournalEntryResult | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await syncDomainEventWithClient(client, event, actorId);
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function syncDomainEventWithClient(
  client: PoolClient,
  event:
    | { kind: "invoice"; invoiceId: string; expenseAccountCode?: string }
    | { kind: "bank_transaction"; bankTransactionId: string }
    | { kind: "check_bordro"; bordroId: string }
    | { kind: "loan_installment"; installmentId: string },
  actorId: string | null,
): Promise<PostJournalEntryResult | null> {
  if (event.kind === "invoice") {
    const invRes = await client.query<{
      id: string;
      direction: "sales" | "purchase";
      invoice_no: string;
      party_id: string | null;
      department_id: string | null;
      issue_date: string;
      currency: string;
      discount_total: string | null;
      net_amount: string | null;
      tax_amount: string | null;
      gross_amount: string;
      withholding_amount: string | null;
      vat_withholding_amount: string | null;
      income_tax_withholding_total: string | null;
      payable_amount: string | null;
      status: string;
      spender_employee_name: string | null;
    }>(
      `select id::text, direction, invoice_no, party_id::text, department_id::text,
              to_char(issue_date, 'YYYY-MM-DD') as issue_date, currency,
              discount_total::text, net_amount::text, tax_amount::text, gross_amount::text,
              withholding_amount::text, vat_withholding_amount::text,
              income_tax_withholding_total::text, payable_amount::text,
              status, spender_employee_name
         from public.invoices
        where id = $1`,
      [event.invoiceId],
    );
    const inv = invRes.rows[0];
    if (!inv || !["open", "partial", "paid"].includes(inv.status)) {
      return null;
    }

    const gross = money(inv.gross_amount);
    if (gross <= 0) return null;

    const discountTotal = moneyOrNull(inv.discount_total) ?? 0;
    const net = moneyOrNull(inv.net_amount);
    const tax = moneyOrNull(inv.tax_amount);
    const withholding = moneyOrNull(inv.withholding_amount) ?? 0;
    const vatWithholding = moneyOrNull(inv.vat_withholding_amount) ?? 0;
    const incomeTaxWithholding = moneyOrNull(inv.income_tax_withholding_total) ?? 0;
    const effectiveIncomeWithholding = withholding > 0 ? withholding : incomeTaxWithholding;
    const totalDeduction = Number(
      decimal(effectiveIncomeWithholding).plus(vatWithholding).round(2).toFixed(2),
    );
    const payable =
      moneyOrNull(inv.payable_amount) ??
      Number(decimal(gross).minus(totalDeduction).round(2).toFixed(2));

    const lineGroupsRes = await client.query<{
      cost_center_id: string | null;
      project_id: string | null;
      department_id: string | null;
      line_net: string;
    }>(
      `select cost_center_id::text,
              project_id::text,
              coalesce(department_id, $2::uuid)::text as department_id,
              coalesce(sum(net_amount), 0)::text as line_net
         from public.invoice_lines
        where invoice_id = $1
        group by cost_center_id, project_id, coalesce(department_id, $2::uuid)`,
      [inv.id, inv.department_id],
    );
    const dimensionalSlices = lineGroupsRes.rows
      .map((g) => ({
        costCenterId: g.cost_center_id,
        projectId: g.project_id,
        departmentId: g.department_id,
        amount: money(g.line_net),
      }))
      .filter((g) => g.amount > 0);
    const slicesSum = dimensionalSlices.reduce((acc, s) => acc.plus(s.amount), decimal(0));
    const useDimensionalSlices =
      !net || dimensionalSlices.length === 0
        ? false
        : slicesSum.minus(net).abs().lte("0.05") &&
          (dimensionalSlices.length > 1 ||
            dimensionalSlices.some((s) => s.costCenterId != null || s.projectId != null));

    const needsTaxSplitReview = net === null || tax === null;
    const lines: JournalLineInput[] = [];

    if (inv.direction === "sales") {
      lines.push({
        accountCode: "120",
        debitNative: payable,
        partyId: inv.party_id,
        departmentId: inv.department_id,
        memo: `Satış faturası alacak tahakkuku (${inv.invoice_no})`,
      });
      if (totalDeduction > 0) {
        lines.push({
          accountCode: "193",
          debitNative: totalDeduction,
          partyId: inv.party_id,
          departmentId: inv.department_id,
          memo: `Satış faturası stopaj / tevkifat kesintisi (${inv.invoice_no})`,
        });
      }
      if (!needsTaxSplitReview && net !== null && tax !== null) {
        if (discountTotal > 0 && !useDimensionalSlices) {
          const preDiscountSales = Number(decimal(net).plus(discountTotal).round(2).toFixed(2));
          lines.push({
            accountCode: "611",
            debitNative: discountTotal,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `Satış iskontosu (${inv.invoice_no})`,
          });
          lines.push({
            accountCode: "600",
            creditNative: preDiscountSales,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `Yurtiçi brüt satış geliri (${inv.invoice_no})`,
          });
        } else if (useDimensionalSlices) {
          for (const s of dimensionalSlices) {
            lines.push({
              accountCode: "600",
              creditNative: s.amount,
              partyId: inv.party_id,
              costCenterId: s.costCenterId,
              projectId: s.projectId,
              departmentId: s.departmentId,
              memo: `Yurtiçi satış geliri (${inv.invoice_no})`,
            });
          }
        } else {
          lines.push({
            accountCode: "600",
            creditNative: net,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `Yurtiçi satış geliri (${inv.invoice_no})`,
          });
        }
        if (tax > 0) {
          lines.push({
            accountCode: "391",
            creditNative: tax,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `Hesaplanan KDV (${inv.invoice_no})`,
          });
        }
      } else {
        lines.push({
          accountCode: "600",
          creditNative: gross,
          partyId: inv.party_id,
          departmentId: inv.department_id,
          memo: `Satış geliri — KDV ayrımı inceleme bekliyor (${inv.invoice_no})`,
        });
      }
    } else {
      const expenseCode = event.expenseAccountCode ?? "770";
      const creditAccountCode = inv.spender_employee_name ? "335" : "320";

      if (!needsTaxSplitReview && net !== null && tax !== null) {
        if (useDimensionalSlices) {
          for (const s of dimensionalSlices) {
            lines.push({
              accountCode: expenseCode,
              debitNative: s.amount,
              partyId: inv.party_id,
              costCenterId: s.costCenterId,
              projectId: s.projectId,
              departmentId: s.departmentId,
              memo: `Alış/gider tahakkuku (${inv.invoice_no})`,
            });
          }
        } else if (net > 0) {
          lines.push({
            accountCode: expenseCode,
            debitNative: net,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `Alış/gider tahakkuku (${inv.invoice_no})`,
          });
        }
        if (tax > 0) {
          lines.push({
            accountCode: "191",
            debitNative: tax,
            partyId: inv.party_id,
            departmentId: inv.department_id,
            memo: `İndirilecek KDV (${inv.invoice_no})`,
          });
        }
      } else {
        lines.push({
          accountCode: expenseCode,
          debitNative: gross,
          partyId: inv.party_id,
          departmentId: inv.department_id,
          memo: `Basit gider fişi — KDV ayrımı inceleme bekliyor (${inv.invoice_no})`,
        });
      }

      lines.push({
        accountCode: creditAccountCode,
        creditNative: payable,
        partyId: inv.party_id,
        departmentId: inv.department_id,
        memo: inv.spender_employee_name
          ? `Personele borçlar: ${inv.spender_employee_name} (${inv.invoice_no})`
          : `Satıcılar tahakkuku (${inv.invoice_no})`,
      });
      if (totalDeduction > 0) {
        lines.push({
          accountCode: "360",
          creditNative: totalDeduction,
          partyId: inv.party_id,
          departmentId: inv.department_id,
          memo: `Ödenecek stopaj / KDV tevkifatı (${inv.invoice_no})`,
        });
      }
    }

    return postJournalEntryWithClient(
      client,
      {
        entryDate: inv.issue_date,
        sourceType: "invoice",
        sourceId: inv.id,
        idempotencyKey: `invoice:issued:${inv.id}`,
        description: `${inv.direction === "sales" ? "Satış" : "Alış"} Faturası Tahakkuku (${inv.invoice_no})`,
        currency: inv.currency,
        needsTaxSplitReview,
        lines,
      },
      actorId,
    );
  }

  if (event.kind === "bank_transaction") {
    const txRes = await client.query<{
      id: string;
      txn_date: string;
      amount: string;
      currency: string;
      description: string | null;
      transaction_kind: string;
      category_rule: string | null;
      status: string;
      matched_entity_table: string | null;
      matched_entity_id: string | null;
    }>(
      `select id::text, to_char(txn_date, 'YYYY-MM-DD') as txn_date,
              amount::text,
              coalesce(currency, (select ca.currency from public.cash_accounts ca where ca.id = bank_account_id), 'TRY') as currency,
              description,
              coalesce(transaction_kind, 'standard') as transaction_kind,
              category_rule,
              coalesce(status, 'unmatched') as status,
              matched_entity_table,
              matched_entity_id::text
         from public.bank_transactions
        where id = $1`,
      [event.bankTransactionId],
    );
    const tx = txRes.rows[0];
    if (!tx) return null;
    if (tx.status === "ignored") return null;
    if (tx.category_rule === "system_internal_settlement") return null;
    if (tx.matched_entity_table === "check_bordros" || tx.matched_entity_table === "loan_installments") {
      return null;
    }

    const rawAmt = money(tx.amount);
    const absAmt = Math.abs(rawAmt);
    if (absAmt <= 0) return null;

    if (
      (tx.status === "unmatched" || tx.status === "suggested") &&
      tx.transaction_kind === "standard"
    ) {
      const suspenseLines: JournalLineInput[] =
        rawAmt > 0
          ? [
              { accountCode: "102", debitNative: absAmt, memo: tx.description ?? "Banka girişi (mutabakat bekliyor)" },
              { accountCode: "102.99", creditNative: absAmt, memo: "Eşleşmemiş banka tahsilatı geçici hesabı" },
            ]
          : [
              { accountCode: "102.99", debitNative: absAmt, memo: "Eşleşmemiş banka çıkışı geçici hesabı" },
              { accountCode: "102", creditNative: absAmt, memo: tx.description ?? "Banka çıkışı (mutabakat bekliyor)" },
            ];
      return postJournalEntryWithClient(
        client,
        {
          entryDate: tx.txn_date,
          sourceType: "bank_transaction",
          sourceId: tx.id,
          idempotencyKey: `bank_tx:suspense:${tx.id}`,
          description: `Banka Geçici Mutabakat (102.99): ${tx.description ?? tx.id.slice(0, 8)}`,
          currency: tx.currency,
          lines: suspenseLines,
        },
        actorId,
      );
    }

    const priorSuspense = await client.query<{ id: string; status: JournalEntryStatus; entry_no: string }>(
      `select id::text, status, entry_no::text
         from public.management_journal_entries
        where source_type = 'bank_transaction'
          and source_id = $1::uuid
          and idempotency_key like ('bank_tx:suspense:' || $1::text || '%')
          and status in ('posted', 'provisional_fx', 'draft')
        for update`,
      [tx.id],
    );
    for (const sp of priorSuspense.rows) {
      if (sp.status === "posted") {
        await reverseManagementEntryWithClient(
          client,
          sp.id,
          "Banka hareketi eşleştirildiği için 102.99 geçici hesap kapatıldı",
          actorId,
          tx.txn_date,
        );
      } else {
        await client.query(`delete from public.management_journal_entries where id = $1`, [sp.id]);
        await audit(client, {
          actor: actorId,
          action: "discard_unposted_source_journal_entry",
          entityTable: "management_journal_entries",
          entityId: sp.id,
          before: { entryNo: Number(sp.entry_no), status: sp.status, sourceType: "bank_transaction", sourceId: tx.id },
          after: { discarded: true, reason: "102.99 geçici kayıt kapatıldı" },
        });
      }
    }

    if (tx.matched_entity_table === "checks" && tx.matched_entity_id) {
      const hasSettlementBordro = await client.query(
        `select 1
           from public.check_events ce
           join public.check_bordros cb on cb.id = ce.bordro_id
          where ce.check_id = $1::uuid
            and cb.bordro_type = 'settlement'
          limit 1`,
        [tx.matched_entity_id],
      );
      if ((hasSettlementBordro.rowCount ?? 0) > 0) {
        return null;
      }

      const chkRes = await client.query<{
        direction: string;
        instrument_type: string;
        payer_party_id: string | null;
        payee_party_id: string | null;
        had_collection: boolean;
        had_collateral: boolean;
      }>(
        `select c.direction,
                coalesce(c.instrument_type, 'check') as instrument_type,
                c.payer_party_id::text as payer_party_id,
                c.payee_party_id::text as payee_party_id,
                exists (
                  select 1 from public.check_events ce2
                  join public.check_bordros cb2 on cb2.id = ce2.bordro_id
                  where ce2.check_id = c.id and cb2.bordro_type = 'bank_collection'
                ) as had_collection,
                exists (
                  select 1 from public.check_events ce3
                  join public.check_bordros cb3 on cb3.id = ce3.bordro_id
                  where ce3.check_id = c.id and cb3.bordro_type = 'bank_collateral'
                ) as had_collateral
           from public.checks c
          where c.id = $1::uuid`,
        [tx.matched_entity_id],
      );
      const chk = chkRes.rows[0];
      const isNote = chk?.instrument_type === "promissory_note";
      const checkLines: JournalLineInput[] = [];
      if (rawAmt > 0 || chk?.direction === "inflow") {
        const checkAccount = isNote
          ? "121"
          : chk?.had_collateral
            ? "101.03"
            : chk?.had_collection
              ? "101.02"
              : "101.01";
        checkLines.push(
          {
            accountCode: "102",
            debitNative: absAmt,
            partyId: chk?.payer_party_id ?? null,
            memo: tx.description ?? "Banka ekstresiyle çek/senet tahsilatı",
          },
          {
            accountCode: checkAccount,
            creditNative: absAmt,
            partyId: chk?.payer_party_id ?? null,
            memo: "Tahsil edilen müşteri çek/senedinin kapanışı",
          },
        );
      } else {
        checkLines.push(
          {
            accountCode: isNote ? "321" : "103",
            debitNative: absAmt,
            partyId: chk?.payee_party_id ?? null,
            memo: tx.description ?? "Verilen çek/senedin bankadan ödenmesi",
          },
          {
            accountCode: "102",
            creditNative: absAmt,
            memo: "Keşide çek/senet banka çıkışı",
          },
        );
      }

      return postJournalEntryWithClient(
        client,
        {
          entryDate: tx.txn_date,
          sourceType: "bank_transaction",
          sourceId: tx.id,
          idempotencyKey: `bank_tx:settled:${tx.id}`,
          description: `Banka Çek Kapanışı: ${tx.description ?? tx.id.slice(0, 8)}`,
          currency: tx.currency,
          lines: checkLines,
        },
        actorId,
      );
    }

    const allocRes = await client.query<{
      allocated_amount: string;
      invoice_id: string;
      invoice_no: string;
      direction: "sales" | "purchase";
      party_id: string | null;
      currency: string;
      issue_date: string;
      spender_employee_name: string | null;
    }>(
      `select ia.allocated_amount::text,
              i.id::text as invoice_id,
              i.invoice_no,
              i.direction,
              i.party_id::text as party_id,
              i.currency,
              to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
              i.spender_employee_name
         from public.invoice_allocations ia
         join public.invoices i on i.id = ia.invoice_id
        where ia.source_table = 'bank_transactions'
          and ia.source_id = $1::uuid
          and ia.reversed_at is null
        order by ia.created_at asc, ia.id asc`,
      [tx.id],
    );

    if (allocRes.rows.length > 0 && allocRes.rows.every((a) => a.currency === tx.currency)) {
      const settleFx = await resolveFxRateOrNull(client, tx.currency, tx.txn_date);
      const splitLines: JournalLineInput[] = [];
      const totalAllocated = allocRes.rows.reduce((acc, a) => acc.plus(a.allocated_amount), decimal(0));
      let totalRealizedFxTry = decimal(0);

      if (rawAmt > 0) {
        const bankTry = settleFx ? decimal(absAmt).times(settleFx).round(2) : null;
        splitLines.push({
          accountCode: "102",
          debitNative: absAmt,
          lineCurrency: tx.currency,
          fxRateOverride: settleFx,
          debitTryOverride: bankTry ? Number(bankTry.toFixed(2)) : undefined,
          memo: tx.description ?? "Müşteri tahsilatı banka girişi",
        });

        const feeDiff = totalAllocated.minus(absAmt).round(2);
        if (feeDiff.gt(0)) {
          const feeTry = settleFx ? feeDiff.times(settleFx).round(2) : null;
          splitLines.push({
            accountCode: "780",
            debitNative: Number(feeDiff.toFixed(2)),
            lineCurrency: tx.currency,
            fxRateOverride: settleFx,
            debitTryOverride: feeTry ? Number(feeTry.toFixed(2)) : undefined,
            memo: "Tahsilat banka/POS kesinti ve komisyon farkı (780)",
          });
        }

        for (const alloc of allocRes.rows) {
          const allocAmt = money(alloc.allocated_amount);
          const issueFx =
            tx.currency === "TRY"
              ? 1
              : (await resolveFxRateOrNull(client, tx.currency, alloc.issue_date)) ?? settleFx;
          const arTry = issueFx ? decimal(allocAmt).times(issueFx).round(2) : null;
          if (tx.currency !== "TRY" && settleFx != null && issueFx != null) {
            const settledTry = decimal(allocAmt).times(settleFx).round(2);
            totalRealizedFxTry = totalRealizedFxTry.plus(settledTry.minus(arTry!));
          }
          splitLines.push({
            accountCode: alloc.direction === "sales" ? "120" : "320",
            creditNative: allocAmt,
            lineCurrency: tx.currency,
            fxRateOverride: issueFx,
            creditTryOverride: arTry ? Number(arTry.toFixed(2)) : undefined,
            partyId: alloc.party_id,
            memo: `Fatura tahsilat mahsubu (${alloc.invoice_no})`,
          });
        }

        const excess = decimal(absAmt).minus(totalAllocated).round(2);
        if (excess.gt(0)) {
          const exTry = settleFx ? excess.times(settleFx).round(2) : null;
          splitLines.push({
            accountCode: "120",
            creditNative: Number(excess.toFixed(2)),
            lineCurrency: tx.currency,
            fxRateOverride: settleFx,
            creditTryOverride: exTry ? Number(exTry.toFixed(2)) : undefined,
            partyId: allocRes.rows[0]?.party_id ?? null,
            memo: "Tahsis fazlası müşteri cari avansı",
          });
        }
      } else {
        for (const alloc of allocRes.rows) {
          const allocAmt = money(alloc.allocated_amount);
          const issueFx =
            tx.currency === "TRY"
              ? 1
              : (await resolveFxRateOrNull(client, tx.currency, alloc.issue_date)) ?? settleFx;
          const apTry = issueFx ? decimal(allocAmt).times(issueFx).round(2) : null;
          if (tx.currency !== "TRY" && settleFx != null && issueFx != null) {
            const settledTry = decimal(allocAmt).times(settleFx).round(2);
            totalRealizedFxTry = totalRealizedFxTry.plus(apTry!.minus(settledTry));
          }
          splitLines.push({
            accountCode: alloc.spender_employee_name ? "335" : "320",
            debitNative: allocAmt,
            lineCurrency: tx.currency,
            fxRateOverride: issueFx,
            debitTryOverride: apTry ? Number(apTry.toFixed(2)) : undefined,
            partyId: alloc.party_id,
            memo: `Fatura ödeme mahsubu (${alloc.invoice_no})`,
          });
        }

        const outflowExcess = decimal(absAmt).minus(totalAllocated).round(2);
        if (outflowExcess.gt(0)) {
          const exTry = settleFx ? outflowExcess.times(settleFx).round(2) : null;
          const isSmallFee = outflowExcess.lte(decimal(absAmt).times("0.05")) || outflowExcess.lte(500);
          splitLines.push({
            accountCode: isSmallFee ? "780" : "320",
            debitNative: Number(outflowExcess.toFixed(2)),
            lineCurrency: tx.currency,
            fxRateOverride: settleFx,
            debitTryOverride: exTry ? Number(exTry.toFixed(2)) : undefined,
            partyId: isSmallFee ? null : (allocRes.rows[0]?.party_id ?? null),
            memo: isSmallFee ? "EFT/Havale banka masraf farkı (780)" : "Tahsis fazlası tedarikçi cari ödemesi",
          });
        }

        const bankOutTry = settleFx ? decimal(absAmt).times(settleFx).round(2) : null;
        splitLines.push({
          accountCode: "102",
          creditNative: absAmt,
          lineCurrency: tx.currency,
          fxRateOverride: settleFx,
          creditTryOverride: bankOutTry ? Number(bankOutTry.toFixed(2)) : undefined,
          memo: tx.description ?? "Tedarikçi ödemesi banka çıkışı",
        });

        const discountShortfall = totalAllocated.minus(absAmt).round(2);
        if (discountShortfall.gt(0)) {
          const discTry = settleFx ? discountShortfall.times(settleFx).round(2) : null;
          splitLines.push({
            accountCode: "642",
            creditNative: Number(discountShortfall.toFixed(2)),
            lineCurrency: tx.currency,
            fxRateOverride: settleFx,
            creditTryOverride: discTry ? Number(discTry.toFixed(2)) : undefined,
            memo: "Ödeme erken kapama / yuvarlama farkı",
          });
        }
      }

      if (tx.currency !== "TRY" && settleFx != null && !totalRealizedFxTry.eq(0)) {
        const fxGainLossAbs = Number(totalRealizedFxTry.abs().round(2).toFixed(2));
        if (fxGainLossAbs > 0) {
          if (totalRealizedFxTry.gt(0)) {
            splitLines.push({
              accountCode: "646",
              creditNative: fxGainLossAbs,
              lineCurrency: "TRY",
              fxRateOverride: 1,
              creditTryOverride: fxGainLossAbs,
              memo: "Tahsilat/ödeme gerçekleşen kambiyo kârı (646)",
            });
          } else {
            splitLines.push({
              accountCode: "656",
              debitNative: fxGainLossAbs,
              lineCurrency: "TRY",
              fxRateOverride: 1,
              debitTryOverride: fxGainLossAbs,
              memo: "Tahsilat/ödeme gerçekleşen kambiyo zararı (656)",
            });
          }
        }
      }

      return postJournalEntryWithClient(
        client,
        {
          entryDate: tx.txn_date,
          sourceType: "bank_transaction",
          sourceId: tx.id,
          idempotencyKey: `bank_tx:settled:${tx.id}`,
          description: `Banka Fatura Tahsisatı (${allocRes.rows.length} belge): ${tx.description ?? tx.id.slice(0, 8)}`,
          currency: tx.currency,
          fxRate: settleFx ?? undefined,
          lines: splitLines,
        },
        actorId,
      );
    }

    const lines: JournalLineInput[] = [];
    if (rawAmt > 0) {
      const creditCode = tx.transaction_kind === "own_transfer" ? "102" : "120";
      lines.push(
        {
          accountCode: "102",
          debitNative: absAmt,
          memo: tx.description ?? "Banka tahsilatı / girişi",
        },
        {
          accountCode: creditCode,
          creditNative: absAmt,
          memo: tx.transaction_kind === "own_transfer" ? "Bankalar arası virman karşılığı" : "Müşteri banka tahsilatı",
        },
      );
    } else {
      const debitCode =
        tx.transaction_kind === "own_transfer"
          ? "102"
          : tx.transaction_kind === "bank_fee"
            ? "780"
            : tx.transaction_kind === "tax_payment"
              ? "360"
              : tx.transaction_kind === "payroll"
                ? "335"
                : "320";
      lines.push(
        {
          accountCode: debitCode,
          debitNative: absAmt,
          memo: tx.description ?? "Banka çıkışı / ödemesi",
        },
        {
          accountCode: "102",
          creditNative: absAmt,
          memo: tx.description ?? "Bankalar çıkışı",
        },
      );
    }

    return postJournalEntryWithClient(
      client,
      {
        entryDate: tx.txn_date,
        sourceType: "bank_transaction",
        sourceId: tx.id,
        idempotencyKey: `bank_tx:settled:${tx.id}`,
        description: `Banka Hareketi (${tx.transaction_kind}): ${tx.description ?? tx.id.slice(0, 8)}`,
        currency: tx.currency,
        lines,
      },
      actorId,
    );
  }

  if (event.kind === "check_bordro") {
    const bRes = await client.query<{
      id: string;
      bordro_no: string;
      bordro_type: string;
      bordro_date: string;
      target_party_id: string | null;
      currency: string;
      total_amount: string;
    }>(
      `select id::text, bordro_no, bordro_type,
              to_char(bordro_date, 'YYYY-MM-DD') as bordro_date,
              target_party_id::text, currency, total_amount::text
         from public.check_bordros
        where id = $1`,
      [event.bordroId],
    );
    const b = bRes.rows[0];
    if (!b) return null;

    const amt = money(b.total_amount);
    if (amt <= 0) return null;

    const chkMetaRes = await client.query<{
      direction: string;
      instrument_type: string;
      payer_party_id: string | null;
      payee_party_id: string | null;
      endorsed_to_party_id: string | null;
      discount_fee_total: string;
      had_collateral: boolean;
      had_collection: boolean;
      was_endorsed_before_bounce: boolean;
    }>(
      `select (array_agg(c.direction))[1] as direction,
              coalesce((array_agg(c.instrument_type))[1], 'check') as instrument_type,
              (array_agg(c.payer_party_id::text) filter (where c.payer_party_id is not null))[1] as payer_party_id,
              (array_agg(c.payee_party_id::text) filter (where c.payee_party_id is not null))[1] as payee_party_id,
              (array_agg(c.endorsed_to_party_id::text) filter (where c.endorsed_to_party_id is not null))[1] as endorsed_to_party_id,
              coalesce(sum(coalesce(c.discount_fee_amount, 0)), 0)::text as discount_fee_total,
              bool_or(exists (
                select 1 from public.check_events ce2
                join public.check_bordros cb2 on cb2.id = ce2.bordro_id
                where ce2.check_id = c.id and cb2.bordro_type = 'bank_collateral'
              )) as had_collateral,
              bool_or(exists (
                select 1 from public.check_events ce3
                join public.check_bordros cb3 on cb3.id = ce3.bordro_id
                where ce3.check_id = c.id and cb3.bordro_type = 'bank_collection'
              )) as had_collection,
              bool_or(exists (
                select 1 from public.check_events ce4
                where ce4.check_id = c.id
                  and ce4.bordro_id = $1::uuid
                  and ce4.event_type = 'recourse_returned'
              ) or (
                c.endorsed_to_party_id is not null
                and exists (
                  select 1 from public.check_events ce5
                  join public.check_bordros cb5 on cb5.id = ce5.bordro_id
                  where ce5.check_id = c.id and cb5.bordro_type = 'vendor_endorsement'
                )
              )) as was_endorsed_before_bounce
         from public.checks c
        where exists (
          select 1 from public.check_events ce where ce.check_id = c.id and ce.bordro_id = $1::uuid
        )
           or c.last_bordro_id = $1::uuid`,
      [b.id],
    );
    const chkMeta = chkMetaRes.rows[0];
    const isNote = chkMeta?.instrument_type === "promissory_note";
    const portfolioAcc = isNote ? "121" : "101.01";
    const collectionAcc = isNote ? "121" : "101.02";
    const collateralAcc = isNote ? "121" : "101.03";
    const issuedAcc = isNote ? "321" : "103";
    const docLabel = isNote ? "senet" : "çek";

    const lines: JournalLineInput[] = [];
    switch (b.bordro_type) {
      case "customer_receipt":
        lines.push(
          { accountCode: portfolioAcc, debitNative: amt, partyId: b.target_party_id ?? chkMeta?.payer_party_id ?? null, memo: `Müşteri ${docLabel} girişi (${b.bordro_no})` },
          { accountCode: "120", creditNative: amt, partyId: b.target_party_id ?? chkMeta?.payer_party_id ?? null, memo: `Müşteri ${docLabel} alacak mahsubu (${b.bordro_no})` },
        );
        break;
      case "vendor_endorsement":
        lines.push(
          { accountCode: "320", debitNative: amt, partyId: b.target_party_id, memo: `Tedarikçiye ${docLabel} cirosu (${b.bordro_no})` },
          { accountCode: portfolioAcc, creditNative: amt, partyId: b.target_party_id, memo: `Portföyden ciro çıkışı (${b.bordro_no})` },
          { accountCode: "900", debitNative: amt, partyId: b.target_party_id, memo: `Ciro rücu riski nazım borç (${b.bordro_no})` },
          { accountCode: "901", creditNative: amt, partyId: b.target_party_id, memo: `Ciro rücu riski nazım alacak (${b.bordro_no})` },
        );
        break;
      case "bank_collection":
        if (isNote) return null;
        lines.push(
          { accountCode: collectionAcc, debitNative: amt, memo: `Bankaya tahsile verilen çekler (${b.bordro_no})` },
          { accountCode: "101.01", creditNative: amt, memo: `Portföyden tahsile çıkış (${b.bordro_no})` },
        );
        break;
      case "bank_collateral":
        if (isNote) return null;
        lines.push(
          { accountCode: collateralAcc, debitNative: amt, memo: `Bankaya teminata verilen çekler (${b.bordro_no})` },
          { accountCode: "101.01", creditNative: amt, memo: `Portföyden teminata çıkış (${b.bordro_no})` },
        );
        break;
      case "own_issue":
        lines.push(
          { accountCode: "320", debitNative: amt, partyId: b.target_party_id ?? chkMeta?.payee_party_id ?? null, memo: `Keşide ${docLabel} tedarikçi ödemesi (${b.bordro_no})` },
          { accountCode: issuedAcc, creditNative: amt, partyId: b.target_party_id ?? chkMeta?.payee_party_id ?? null, memo: `Verilen ${docLabel}ler (${b.bordro_no})` },
        );
        break;
      case "settlement":
      case "bounce_return": {
        const isOutflow = chkMeta?.direction === "outflow";
        const inflowCheckAccount = isNote
          ? "121"
          : chkMeta?.had_collateral
            ? "101.03"
            : chkMeta?.had_collection
              ? "101.02"
              : "101.01";

        if (b.bordro_type === "settlement") {
          if (isOutflow) {
            lines.push(
              {
                accountCode: issuedAcc,
                debitNative: amt,
                partyId: b.target_party_id ?? chkMeta?.payee_party_id ?? null,
                memo: `Verilen ${docLabel}in bankadan ödenmesi (${b.bordro_no})`,
              },
              {
                accountCode: "102",
                creditNative: amt,
                memo: `Keşide ${docLabel} banka çıkışı (${b.bordro_no})`,
              },
            );
          } else if (chkMeta?.was_endorsed_before_bounce) {
            const endorsedVendorId = chkMeta?.endorsed_to_party_id ?? b.target_party_id ?? null;
            lines.push(
              { accountCode: "901", debitNative: amt, partyId: endorsedVendorId, memo: `Ciro edilen ${docLabel} vadesinde tahsil — rücu nazım kapanışı (${b.bordro_no})` },
              { accountCode: "900", creditNative: amt, partyId: endorsedVendorId, memo: `Ciro edilen ${docLabel} vadesinde tahsil — rücu nazım kapanışı (${b.bordro_no})` },
            );
          } else {
            const discountFee = money(chkMeta?.discount_fee_total ?? 0);
            if (discountFee > 0 && discountFee < amt) {
              const netProceeds = Number(decimal(amt).minus(discountFee).round(2).toFixed(2));
              lines.push(
                { accountCode: "102", debitNative: netProceeds, memo: `Faktoring / iskonto net banka girişi (${b.bordro_no})` },
                { accountCode: "780", debitNative: discountFee, memo: `Çek/senet kırdırma iskonto ve komisyon gideri (${b.bordro_no})` },
                { accountCode: inflowCheckAccount, creditNative: amt, partyId: chkMeta?.payer_party_id ?? null, memo: `İskonto edilen ${docLabel} kapanışı (${b.bordro_no})` },
              );
            } else {
              lines.push(
                { accountCode: "102", debitNative: amt, memo: `${isNote ? "Senet" : "Çek"} tahsilatı (${b.bordro_no})` },
                { accountCode: inflowCheckAccount, creditNative: amt, partyId: chkMeta?.payer_party_id ?? null, memo: `Tahsil edilen ${docLabel} kapanışı (${b.bordro_no})` },
              );
            }
          }
        } else {
          if (isOutflow) {
            const vendorPartyId = b.target_party_id ?? chkMeta?.payee_party_id ?? null;
            lines.push(
              {
                accountCode: issuedAcc,
                debitNative: amt,
                partyId: vendorPartyId,
                memo: `Karşılıksız keşide ${docLabel} yükümlülük dönüşü (${b.bordro_no})`,
              },
              {
                accountCode: "320",
                creditNative: amt,
                partyId: vendorPartyId,
                memo: `Karşılıksız keşide ${docLabel} tedarikçi borcu (${b.bordro_no})`,
              },
            );
          } else if (chkMeta?.was_endorsed_before_bounce) {
            const drawerPartyId = chkMeta?.payer_party_id ?? null;
            const endorsedVendorId = chkMeta?.endorsed_to_party_id ?? b.target_party_id ?? null;
            lines.push(
              {
                accountCode: "120",
                debitNative: amt,
                partyId: drawerPartyId,
                memo: `Cirodan karşılıksız dönen ${docLabel} keşideci rücu borçlandırması (${b.bordro_no})`,
              },
              {
                accountCode: "320",
                creditNative: amt,
                partyId: endorsedVendorId,
                memo: `Karşılıksız dönen ciro ${docLabel}i nedeniyle tedarikçi cari borç iadesi (${b.bordro_no})`,
              },
              {
                accountCode: "901",
                debitNative: amt,
                partyId: endorsedVendorId,
                memo: `Ciro rücu riski nazım hesap kapanışı (${b.bordro_no})`,
              },
              {
                accountCode: "900",
                creditNative: amt,
                partyId: endorsedVendorId,
                memo: `Ciro rücu riski nazım hesap kapanışı (${b.bordro_no})`,
              },
            );
          } else {
            const custPartyId = b.target_party_id ?? chkMeta?.payer_party_id ?? null;
            lines.push(
              { accountCode: "120", debitNative: amt, partyId: custPartyId, memo: `Karşılıksız ${docLabel} rücu borçlandırması (${b.bordro_no})` },
              { accountCode: inflowCheckAccount, creditNative: amt, partyId: custPartyId, memo: `Karşılıksız ${docLabel} portföy/tahsilden düşümü (${b.bordro_no})` },
            );
          }
        }
        break;
      }
      default:
        return null;
    }

    return postJournalEntryWithClient(
      client,
      {
        entryDate: b.bordro_date,
        sourceType: "check_bordro",
        sourceId: b.id,
        idempotencyKey: `check_bordro:${b.id}`,
        description: `${isNote ? "Senet" : "Çek"} Bordrosu (${b.bordro_type}): ${b.bordro_no}`,
        currency: b.currency,
        lines,
      },
      actorId,
    );
  }

  if (event.kind === "loan_installment") {
    const liRes = await client.query<{
      id: string;
      due_date: string;
      paid_at: string | null;
      amount: string;
      principal_component: string | null;
      interest_component: string | null;
      tax_component: string | null;
      bsmv_component: string | null;
      kkdf_component: string | null;
      status: string;
      currency: string;
      loan_name: string;
      loan_kind: string;
    }>(
      `select li.id::text,
              to_char(li.due_date, 'YYYY-MM-DD') as due_date,
              to_char((li.paid_at at time zone 'Europe/Istanbul')::date, 'YYYY-MM-DD') as paid_at,
              li.amount::text,
              li.principal_component::text,
              li.interest_component::text,
              li.tax_component::text,
              li.bsmv_component::text,
              li.kkdf_component::text,
              li.status,
              l.currency,
              l.name as loan_name,
              coalesce(l.loan_kind, 'installment') as loan_kind
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
        where li.id = $1`,
      [event.installmentId],
    );
    const li = liRes.rows[0];
    if (!li || li.status !== "paid") return null;

    const totalAmt = money(li.amount);
    if (totalAmt <= 0) return null;

    const interest = moneyOrNull(li.interest_component) ?? 0;
    const bsmv = moneyOrNull(li.bsmv_component) ?? 0;
    const kkdf = moneyOrNull(li.kkdf_component) ?? 0;
    const explicitTax = moneyOrNull(li.tax_component);
    const tax =
      explicitTax != null
        ? explicitTax
        : Number(decimal(bsmv).plus(kkdf).round(2).toFixed(2));
    const financeCost = Number(decimal(interest).plus(tax).round(2).toFixed(2));
    const explicitPrincipal = moneyOrNull(li.principal_component);
    const principal =
      explicitPrincipal != null
        ? explicitPrincipal
        : Math.max(0, Number(decimal(totalAmt).minus(financeCost).round(2).toFixed(2)));
    const adjustedFinanceCost = Number(decimal(totalAmt).minus(principal).round(2).toFixed(2));

    const lines: JournalLineInput[] = [];
    if (li.loan_kind === "leasing") {
      const grossLeaseRental = Number(decimal(principal).plus(interest).round(2).toFixed(2));
      if (grossLeaseRental > 0) {
        lines.push({
          accountCode: "301",
          debitNative: grossLeaseRental,
          memo: `Finansal kiralama kira taksit anapara+faiz düşümü (${li.loan_name})`,
        });
      }
      if (adjustedFinanceCost > 0) {
        lines.push({
          accountCode: "780",
          debitNative: adjustedFinanceCost,
          memo: `Finansal kiralama dönemsel faiz tahakkuku (${li.loan_name})`,
        });
      }
      lines.push({
        accountCode: "102",
        creditNative: totalAmt,
        memo: `Finansal kiralama taksit banka çıkışı (${li.loan_name})`,
      });
      if (interest > 0) {
        lines.push({
          accountCode: "302",
          creditNative: interest,
          memo: `Ertelenmiş finansal kiralama borçlanma maliyeti itfası (${li.loan_name})`,
        });
      }
    } else {
      if (principal > 0) {
        lines.push({
          accountCode: "300",
          debitNative: principal,
          memo: `Kredi anapara ödemesi (${li.loan_name})`,
        });
      }
      if (adjustedFinanceCost > 0) {
        lines.push({
          accountCode: "780",
          debitNative: adjustedFinanceCost,
          memo: `Kredi faiz + BSMV/KKDF gideri (${li.loan_name})`,
        });
      }
      lines.push({
        accountCode: "102",
        creditNative: totalAmt,
        memo: `Kredi taksit ödemesi banka çıkışı (${li.loan_name})`,
      });
    }

    return postJournalEntryWithClient(
      client,
      {
        entryDate: li.paid_at ?? li.due_date,
        sourceType: "loan_installment",
        sourceId: li.id,
        idempotencyKey: `loan_installment:paid:${li.id}`,
        description: `${li.loan_kind === "leasing" ? "Finansal Kiralama" : "Kredi"} Taksit Ödemesi (${li.loan_name})`,
        currency: li.currency,
        lines,
      },
      actorId,
    );
  }

  return null;
}

/**
 * Re-values any `provisional_fx` journal entries whose transaction date now has a TCMB FX rate
 * in `public.fx_rate_snapshots`, transitioning them to `'posted'`.
 */
export const revalueProvisionalJournalEntries = revalueProvisionalFxEntries;

export async function revalueProvisionalFxEntries(
  pool: Pool,
  actorId: string | null,
): Promise<{ revaluedCount: number; stillProvisionalCount: number }> {
  const client = await pool.connect();
  let revaluedCount = 0;
  let stillProvisionalCount = 0;

  try {
    await client.query("begin");
    const provRes = await client.query<{
      id: string;
      entry_date: string;
    }>(
      `select id::text, to_char(entry_date, 'YYYY-MM-DD') as entry_date
         from public.management_journal_entries
        where status = 'provisional_fx'
        order by entry_date asc
        for update`,
    );

    for (const je of provRes.rows) {
      const linesRes = await client.query<{
        id: string;
        native_currency: string;
        debit_native: string;
        credit_native: string;
      }>(
        `select id::text, native_currency, debit_native::text, credit_native::text
           from public.management_journal_lines
          where entry_id = $1
          order by line_no asc`,
        [je.id],
      );
      if (linesRes.rows.length === 0) continue;

      const currency = linesRes.rows[0].native_currency;
      const fxRate = await resolveFxRateOrNull(client, currency, je.entry_date);
      if (fxRate == null || fxRate <= 0) {
        stillProvisionalCount++;
        continue;
      }

      const converted = linesRes.rows.map((l) => {
        const dNat = decimal(l.debit_native);
        const cNat = decimal(l.credit_native);
        return {
          id: l.id,
          debitTry: dNat.gt(0) ? dNat.times(fxRate).round(2).toFixed(2) : "0.00",
          creditTry: cNat.gt(0) ? cNat.times(fxRate).round(2).toFixed(2) : "0.00",
        };
      });

      const tryDebit = converted.reduce((acc, l) => acc.plus(l.debitTry), decimal(0));
      const tryCredit = converted.reduce((acc, l) => acc.plus(l.creditTry), decimal(0));
      const diff = tryDebit.minus(tryCredit);
      if (!diff.eq(0) && diff.abs().lte("0.05")) {
        const lastCredit = [...converted].reverse().find((l) => decimal(l.creditTry).gt(0));
        if (lastCredit) {
          lastCredit.creditTry = decimal(lastCredit.creditTry).plus(diff).round(2).toFixed(2);
        }
      }

      for (const c of converted) {
        await client.query(
          `update public.management_journal_lines
              set fx_rate = $2::numeric,
                  debit_try = $3::numeric,
                  credit_try = $4::numeric
            where id = $1`,
          [c.id, fxRate, c.debitTry, c.creditTry],
        );
      }

      await client.query(
        `update public.management_journal_entries
            set status = 'posted'
          where id = $1`,
        [je.id],
      );

      await audit(client, {
        actor: actorId,
        action: "revalue_provisional_fx_journal_entry",
        entityTable: "management_journal_entries",
        entityId: je.id,
        before: { status: "provisional_fx" },
        after: { status: "posted", fxRate, currency },
      });

      revaluedCount++;
    }

    await client.query("commit");
    return { revaluedCount, stillProvisionalCount };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Bulk idempotent synchronization of operational invoices, bank transactions, check bordros,
 * and paid loan installments into the double-entry management ledger.
 */
export async function rebuildOrSyncManagementLedger(
  pool: Pool,
  actorId: string | null,
): Promise<{
  createdCount: number;
  skippedCount: number;
  revaluedCount: number;
}> {
  let createdCount = 0;
  let skippedCount = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const invIds = await client.query<{ id: string }>(
      `select i.id::text
         from public.invoices i
        where i.status in ('open', 'partial', 'paid')
          and not exists (
            select 1 from public.cashflow_months cm
             where cm.month_start = date_trunc('month', i.issue_date)::date
               and cm.status = 'locked'
          )
        order by i.issue_date asc, i.created_at asc`,
    );
    for (const r of invIds.rows) {
      const out = await syncDomainEventWithClient(client, { kind: "invoice", invoiceId: r.id }, actorId);
      if (out?.created) createdCount++;
      else skippedCount++;
    }

    const txIds = await client.query<{ id: string }>(
      `select bt.id::text
         from public.bank_transactions bt
        where bt.amount <> 0
          and bt.status <> 'ignored'
          and coalesce(bt.matched_entity_table, '') not in ('check_bordros', 'loan_installments')
          and not exists (
            select 1 from public.cashflow_months cm
             where cm.month_start = date_trunc('month', bt.txn_date)::date
               and cm.status = 'locked'
          )
        order by bt.txn_date asc, bt.created_at asc`,
    );
    for (const r of txIds.rows) {
      const out = await syncDomainEventWithClient(
        client,
        { kind: "bank_transaction", bankTransactionId: r.id },
        actorId,
      );
      if (out?.created) createdCount++;
      else skippedCount++;
    }

    const bordroIds = await client.query<{ id: string }>(
      `select cb.id::text
         from public.check_bordros cb
        where not exists (
          select 1 from public.cashflow_months cm
           where cm.month_start = date_trunc('month', cb.bordro_date)::date
             and cm.status = 'locked'
        )
        order by cb.bordro_date asc, cb.created_at asc`,
    );
    for (const r of bordroIds.rows) {
      const out = await syncDomainEventWithClient(client, { kind: "check_bordro", bordroId: r.id }, actorId);
      if (out?.created) createdCount++;
      else skippedCount++;
    }

    const instIds = await client.query<{ id: string }>(
      `select li.id::text
         from public.loan_installments li
        where li.status = 'paid'
          and not exists (
            select 1 from public.cashflow_months cm
             where cm.month_start = date_trunc('month', coalesce((li.paid_at at time zone 'Europe/Istanbul')::date, li.due_date))::date
               and cm.status = 'locked'
          )
        order by li.due_date asc`,
    );
    for (const r of instIds.rows) {
      const out = await syncDomainEventWithClient(
        client,
        { kind: "loan_installment", installmentId: r.id },
        actorId,
      );
      if (out?.created) createdCount++;
      else skippedCount++;
    }

    // İptal edilen fatura, yok sayılan / çift sayım kapsamına giren banka hareketi ve geri alınan kredi taksitleri için otomatik ters fiş süpürmesi
    const staleSources = await client.query<{
      source_type: JournalSourceType;
      source_id: string;
      reason: string;
    }>(
      `select distinct je.source_type, je.source_id::text as source_id,
              'İptal edilmiş fatura stornosu'::text as reason
         from public.management_journal_entries je
         join public.invoices i on i.id = je.source_id
        where je.source_type = 'invoice'
          and je.status in ('posted', 'provisional_fx')
          and i.status = 'cancelled'
       union all
       select distinct je.source_type, je.source_id::text as source_id,
              'Yok sayılan veya bordro/taksit ile birleşen banka hareketi stornosu'::text as reason
         from public.management_journal_entries je
         join public.bank_transactions bt on bt.id = je.source_id
        where je.source_type = 'bank_transaction'
          and je.status in ('posted', 'provisional_fx')
          and (
            bt.status = 'ignored'
            or bt.matched_entity_table in ('check_bordros', 'loan_installments')
            or (
              bt.matched_entity_table = 'checks'
              and exists (
                select 1
                  from public.check_events ce
                  join public.check_bordros cb on cb.id = ce.bordro_id
                 where ce.check_id = bt.matched_entity_id
                   and cb.bordro_type = 'settlement'
              )
            )
          )
       union all
       select distinct je.source_type, je.source_id::text as source_id,
              'Ödemesi geri alınan kredi taksiti stornosu'::text as reason
         from public.management_journal_entries je
         join public.loan_installments li on li.id = je.source_id
        where je.source_type = 'loan_installment'
          and je.status in ('posted', 'provisional_fx')
          and li.status <> 'paid'`,
    );
    for (const s of staleSources.rows) {
      await reverseJournalEntriesForSourceWithClient(
        client,
        s.source_type,
        s.source_id,
        s.reason,
        actorId,
      );
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  const rev = await revalueProvisionalFxEntries(pool, actorId);
  return {
    createdCount,
    skippedCount,
    revaluedCount: rev.revaluedCount,
  };
}

export const manualAdjustmentSchema = z.object({
  entryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-MM-DD biçiminde olmalıdır."),
  description: z.string().trim().min(3, "Fiş açıklaması en az 3 karakter olmalıdır."),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  status: z.enum(["draft", "posted"]).default("posted"),
  idempotencyKey: z.string().trim().min(3).optional(),
  lines: z
    .array(
      z.object({
        accountCode: z.string().trim().min(3),
        debitNative: z.coerce.number().min(0).default(0),
        creditNative: z.coerce.number().min(0).default(0),
        partyId: z.string().uuid().nullable().optional(),
        projectId: z.string().uuid().nullable().optional(),
        costCenterId: z.string().uuid().nullable().optional(),
        departmentId: z.string().uuid().nullable().optional(),
        memo: z.string().trim().nullable().optional(),
      }),
    )
    .min(2, "Yevmiye fişi en az 2 satır içermelidir."),
});

export async function postManualManagementAdjustment(
  pool: Pool,
  raw: unknown,
  actorId: string | null,
): Promise<PostJournalEntryResult> {
  const input = parseOrThrow(manualAdjustmentSchema, raw, "Manuel yönetim tahakkuk fişi");
  const idemKey =
    input.idempotencyKey ??
    `manual:${input.entryDate}:${input.description.slice(0, 32)}:${Date.now()}`;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await postJournalEntryWithClient(
      client,
      {
        entryDate: input.entryDate,
        sourceType: "manual_adjustment",
        idempotencyKey: idemKey,
        description: input.description,
        currency: input.currency,
        status: input.status,
        lines: input.lines,
      },
      actorId,
    );
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function approveDraftManagementEntry(
  pool: Pool,
  entryId: string,
  actorId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query<{ status: string }>(
      `select status from public.management_journal_entries where id = $1 for update`,
      [entryId],
    );
    if (!cur.rows[0]) {
      throw new DomainError("Yevmiye fişi bulunamadı.");
    }
    if (cur.rows[0].status !== "draft") {
      throw new DomainError(`Yalnız 'draft' durumundaki fişler onaylanabilir (mevcut: ${cur.rows[0].status}).`);
    }

    await client.query(
      `update public.management_journal_entries
          set status = 'posted',
              approved_by = $2,
              approved_at = now()
        where id = $1`,
      [entryId, actorId],
    );

    await audit(client, {
      actor: actorId,
      action: "approve_management_journal_entry",
      entityTable: "management_journal_entries",
      entityId: entryId,
      before: { status: "draft" },
      after: { status: "posted", approvedBy: actorId },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function discardDraftManagementEntry(
  pool: Pool,
  entryId: string,
  actorId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query<{
      id: string;
      entry_no: string;
      entry_date: string;
      status: string;
      description: string;
    }>(
      `select id::text, entry_no::text, to_char(entry_date, 'YYYY-MM-DD') as entry_date, status, description
         from public.management_journal_entries
        where id = $1
        for update`,
      [entryId],
    );
    const row = cur.rows[0];
    if (!row) {
      throw new DomainError("Yevmiye fişi bulunamadı.");
    }
    if (row.status !== "draft") {
      throw new DomainError(
        `Yalnız 'draft' (taslak) durumundaki fişler silinebilir; kesinleşmiş fişler için ters kayıt (storno) kullanılmalıdır (mevcut: ${row.status}).`,
      );
    }

    await client.query(`delete from public.management_journal_entries where id = $1`, [entryId]);

    await audit(client, {
      actor: actorId,
      action: "discard_draft_management_journal_entry",
      entityTable: "management_journal_entries",
      entityId: entryId,
      before: {
        entryNo: Number(row.entry_no),
        entryDate: row.entry_date,
        status: row.status,
        description: row.description,
      },
      after: null,
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function reverseManagementEntryWithClient(
  client: PoolClient,
  entryId: string,
  reason: string,
  actorId: string | null,
  reversalDate?: string,
): Promise<{ reversalEntryId: string; reversalEntryNo: number }> {
  const cleanReason = reason.trim();
  if (cleanReason.length < 3) {
    throw new DomainError("Ters kayıt (storno) gerekçesi en az 3 karakter olmalıdır.");
  }

  const origRes = await client.query<{
    id: string;
    entry_no: string;
    entry_date: string;
    status: string;
    description: string;
  }>(
    `select id::text, entry_no::text, to_char(entry_date, 'YYYY-MM-DD') as entry_date,
            status, description
       from public.management_journal_entries
      where id = $1
      for update`,
    [entryId],
  );
  const orig = origRes.rows[0];
  if (!orig) {
    throw new DomainError("Ters kayıt yapılacak yevmiye fişi bulunamadı.");
  }
  if (orig.status !== "posted") {
    throw new DomainError(`Yalnız 'posted' durumundaki fişlere ters kayıt açılabilir (mevcut: ${orig.status}).`);
  }

  const origLines = await client.query<{
    line_no: number;
    account_id: string;
    party_id: string | null;
    project_id: string | null;
    cost_center_id: string | null;
    department_id: string | null;
    native_currency: string;
    debit_native: string;
    credit_native: string;
    fx_rate: string | null;
    debit_try: string;
    credit_try: string;
    line_memo: string | null;
  }>(
    `select line_no, account_id::text, party_id::text, project_id::text,
            cost_center_id::text, department_id::text,
            native_currency, debit_native::text, credit_native::text,
            fx_rate::text, debit_try::text, credit_try::text, line_memo
       from public.management_journal_lines
      where entry_id = $1
      order by line_no asc`,
    [entryId],
  );

  let effDate = reversalDate ?? orig.entry_date;
  if (!reversalDate) {
    const lockedRes = await client.query<{ locked: boolean }>(
      `select exists (
         select 1 from public.cashflow_months cm
          where cm.month_start = date_trunc('month', $1::date)::date
            and cm.status = 'locked'
       ) as locked`,
      [effDate],
    );
    if (lockedRes.rows[0]?.locked) {
      const todayRes = await client.query<{ today: string }>(
        `select to_char((now() at time zone 'Europe/Istanbul')::date, 'YYYY-MM-DD') as today`,
      );
      effDate = todayRes.rows[0]?.today ?? effDate;
    }
  }

  const revIns = await client.query<{ id: string; entry_no: string }>(
    `insert into public.management_journal_entries
       (entry_date, source_type, source_id, idempotency_key, status,
        description, reversal_of_entry_id, created_by)
     values ($1::date, 'reversal', $2, $3, 'posted', $4, $2, $5)
     returning id::text, entry_no::text`,
    [
      effDate,
      orig.id,
      `reversal:${orig.id}`,
      `TERS KAYIT (#${orig.entry_no}): ${cleanReason}`,
      actorId,
    ],
  );
  const reversalEntryId = revIns.rows[0].id;
  const reversalEntryNo = Number(revIns.rows[0].entry_no);

  for (const l of origLines.rows) {
    await client.query(
      `insert into public.management_journal_lines
         (entry_id, line_no, account_id, party_id, project_id, cost_center_id, department_id,
          native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
       values ($1, $2, $3, $4, $5, $6, $7,
               $8, $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14)`,
      [
        reversalEntryId,
        l.line_no,
        l.account_id,
        l.party_id,
        l.project_id,
        l.cost_center_id,
        l.department_id,
        l.native_currency,
        l.credit_native,
        l.debit_native,
        l.fx_rate,
        l.credit_try,
        l.debit_try,
        `Ters kayıt: ${l.line_memo ?? cleanReason}`,
      ],
    );
  }

  await client.query(
    `update public.management_journal_entries
        set status = 'reversed',
            reversed_by_entry_id = $2
      where id = $1`,
    [orig.id, reversalEntryId],
  );

  await audit(client, {
    actor: actorId,
    action: "reverse_management_journal_entry",
    entityTable: "management_journal_entries",
    entityId: orig.id,
    before: { status: "posted", reversedByEntryId: null },
    after: {
      status: "reversed",
      reversedByEntryId: reversalEntryId,
      reversalEntryNo,
      reason: cleanReason,
    },
  });

  return { reversalEntryId, reversalEntryNo };
}

/**
 * Reverses a `'posted'` journal entry by creating an immutable mirror entry (`source_type = 'reversal'`)
 * with debits and credits swapped, and linking `reversed_by_entry_id` on the original entry.
 */
export async function reverseManagementEntry(
  pool: Pool,
  entryId: string,
  reason: string,
  actorId: string | null,
  reversalDate?: string,
): Promise<{ reversalEntryId: string; reversalEntryNo: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await reverseManagementEntryWithClient(client, entryId, reason, actorId, reversalDate);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Automatically reverses any active journal entries linked to `(sourceType, sourceId)`.
 * - `'posted'` entries receive an immutable mirror `'reversal'` entry.
 * - `'provisional_fx'` or `'draft'` entries (never posted to TRY mizan) are cleanly discarded with audit trace.
 */
export async function reverseJournalEntriesForSourceWithClient(
  client: PoolClient,
  sourceType: JournalSourceType,
  sourceId: string,
  reason: string,
  actorId: string | null,
  reversalDate?: string,
): Promise<{ reversedCount: number; discardedCount: number }> {
  const entries = await client.query<{
    id: string;
    entry_no: string;
    status: JournalEntryStatus;
    description: string;
  }>(
    `select id::text, entry_no::text, status, description
       from public.management_journal_entries
      where source_type = $1
        and source_id = $2::uuid
        and status in ('posted', 'provisional_fx', 'draft')
      order by entry_no asc
      for update`,
    [sourceType, sourceId],
  );

  let reversedCount = 0;
  let discardedCount = 0;

  for (const row of entries.rows) {
    if (row.status === "posted") {
      await reverseManagementEntryWithClient(client, row.id, reason, actorId, reversalDate);
      reversedCount++;
    } else {
      await client.query(`delete from public.management_journal_entries where id = $1`, [row.id]);
      await audit(client, {
        actor: actorId,
        action: "discard_unposted_source_journal_entry",
        entityTable: "management_journal_entries",
        entityId: row.id,
        before: {
          entryNo: Number(row.entry_no),
          status: row.status,
          sourceType,
          sourceId,
          description: row.description,
        },
        after: { discarded: true, reason },
      });
      discardedCount++;
    }
  }

  return { reversedCount, discardedCount };
}

/**
 * Safe SAVEPOINT-wrapped wrapper for domain write transactions so partial/legacy test schemas
 * without `0105` tables never abort the caller's PostgreSQL transaction (`25P02`).
 */
export async function safeSyncDomainEventWithClient(
  client: PoolClient,
  event:
    | { kind: "invoice"; invoiceId: string; expenseAccountCode?: string }
    | { kind: "bank_transaction"; bankTransactionId: string }
    | { kind: "check_bordro"; bordroId: string }
    | { kind: "loan_installment"; installmentId: string },
  actorId: string | null,
): Promise<PostJournalEntryResult | null> {
  await client.query("savepoint mgmt_ledger_sync_sp");
  try {
    const out = await syncDomainEventWithClient(client, event, actorId);
    await client.query("release savepoint mgmt_ledger_sync_sp");
    return out;
  } catch (err) {
    await client.query("rollback to savepoint mgmt_ledger_sync_sp");
    await client.query("release savepoint mgmt_ledger_sync_sp");
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function safeReverseJournalForSourceWithClient(
  client: PoolClient,
  sourceType: JournalSourceType,
  sourceId: string,
  reason: string,
  actorId: string | null,
  reversalDate?: string,
): Promise<{ reversedCount: number; discardedCount: number }> {
  await client.query("savepoint mgmt_ledger_rev_sp");
  try {
    const out = await reverseJournalEntriesForSourceWithClient(
      client,
      sourceType,
      sourceId,
      reason,
      actorId,
      reversalDate,
    );
    await client.query("release savepoint mgmt_ledger_rev_sp");
    return out;
  } catch (err) {
    await client.query("rollback to savepoint mgmt_ledger_rev_sp");
    await client.query("release savepoint mgmt_ledger_rev_sp");
    if (isMissingSchemaError(err)) return { reversedCount: 0, discardedCount: 0 };
    throw err;
  }
}

/* ── Read-Model Loaders for /finance/ledger ───────────────────────────────────────────── */

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  tdhpRootCode: string;
  accountClass: string;
  normalSide: string;
  ebitdaBucket: string;
  entryCount: number;
  debitTotalTry: number;
  creditTotalTry: number;
  debitBalanceTry: number;
  creditBalanceTry: number;
  netBalanceTry: number;
}

export interface IncomeStatementSummary {
  grossSalesTry: number;
  salesDiscountsTry: number;
  netSalesTry: number;
  cogsTry: number;
  grossProfitTry: number;
  opexTotalTry: number;
  daAddbackTry: number;
  opexCashTry: number;
  ebitTry: number;
  managementEbitdaTry: number;
  otherNetIncomeTry: number;
  financingExpenseTry: number;
  ebtTry: number;
  taxExpenseTry: number;
  netIncomeTry: number;
}

export interface BalanceSheetItem {
  accountCode: string;
  accountName: string;
  tdhpRootCode: string;
  section: "asset" | "liability" | "equity";
  amountTry: number;
  isDynamicNetIncome: boolean;
}

export async function loadManagementLedgerOverview(pool: Pool): Promise<{
  trialBalance: TrialBalanceRow[];
  totalDebitTry: number;
  totalCreditTry: number;
  totalDebitBalanceTry: number;
  totalCreditBalanceTry: number;
  incomeStatement: IncomeStatementSummary;
  balanceSheet: BalanceSheetItem[];
  totalAssetsTry: number;
  totalLiabilitiesAndEquityTry: number;
}> {
  const [tbRes, isRes, bsRes] = await Promise.all([
    pool
      .query<{
        account_id: string;
        account_code: string;
        account_name: string;
        tdhp_root_code: string;
        account_class: string;
        normal_side: string;
        ebitda_bucket: string;
        entry_count: number;
        debit_total_try: string;
        credit_total_try: string;
        debit_balance_try: string;
        credit_balance_try: string;
        net_balance_try: string;
      }>(`select * from public.management_trial_balance_v order by account_code asc`)
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        gross_sales_try: string;
        sales_discounts_try: string;
        net_sales_try: string;
        cogs_try: string;
        gross_profit_try: string;
        opex_total_try: string;
        da_addback_try: string;
        opex_cash_try: string;
        ebit_try: string;
        management_ebitda_try: string;
        other_net_income_try: string;
        financing_expense_try: string;
        ebt_try: string;
        tax_expense_try: string;
        net_income_try: string;
      }>(`select * from public.management_income_statement_v limit 1`)
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        account_code: string;
        account_name: string;
        tdhp_root_code: string;
        section: "asset" | "liability" | "equity";
        amount_try: string;
        is_dynamic_net_income: boolean;
      }>(`select * from public.management_balance_sheet_v order by section asc, account_code asc`)
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  const trialBalance: TrialBalanceRow[] = tbRes.rows.map((r) => ({
    accountId: r.account_id,
    accountCode: r.account_code,
    accountName: r.account_name,
    tdhpRootCode: r.tdhp_root_code,
    accountClass: r.account_class,
    normalSide: r.normal_side,
    ebitdaBucket: r.ebitda_bucket,
    entryCount: Number(r.entry_count),
    debitTotalTry: money(r.debit_total_try),
    creditTotalTry: money(r.credit_total_try),
    debitBalanceTry: money(r.debit_balance_try),
    creditBalanceTry: money(r.credit_balance_try),
    netBalanceTry: money(r.net_balance_try),
  }));

  const totalDebitTry = Number(
    trialBalance.reduce((acc, r) => acc.plus(r.debitTotalTry), decimal(0)).round(2).toFixed(2),
  );
  const totalCreditTry = Number(
    trialBalance.reduce((acc, r) => acc.plus(r.creditTotalTry), decimal(0)).round(2).toFixed(2),
  );
  const totalDebitBalanceTry = Number(
    trialBalance.reduce((acc, r) => acc.plus(r.debitBalanceTry), decimal(0)).round(2).toFixed(2),
  );
  const totalCreditBalanceTry = Number(
    trialBalance.reduce((acc, r) => acc.plus(r.creditBalanceTry), decimal(0)).round(2).toFixed(2),
  );

  const isRow = isRes.rows[0];
  const incomeStatement: IncomeStatementSummary = {
    grossSalesTry: money(isRow?.gross_sales_try ?? 0),
    salesDiscountsTry: money(isRow?.sales_discounts_try ?? 0),
    netSalesTry: money(isRow?.net_sales_try ?? 0),
    cogsTry: money(isRow?.cogs_try ?? 0),
    grossProfitTry: money(isRow?.gross_profit_try ?? 0),
    opexTotalTry: money(isRow?.opex_total_try ?? 0),
    daAddbackTry: money(isRow?.da_addback_try ?? 0),
    opexCashTry: money(isRow?.opex_cash_try ?? 0),
    ebitTry: money(isRow?.ebit_try ?? 0),
    managementEbitdaTry: money(isRow?.management_ebitda_try ?? 0),
    otherNetIncomeTry: money(isRow?.other_net_income_try ?? 0),
    financingExpenseTry: money(isRow?.financing_expense_try ?? 0),
    ebtTry: money(isRow?.ebt_try ?? 0),
    taxExpenseTry: money(isRow?.tax_expense_try ?? 0),
    netIncomeTry: money(isRow?.net_income_try ?? 0),
  };

  const balanceSheet: BalanceSheetItem[] = bsRes.rows.map((r) => ({
    accountCode: r.account_code,
    accountName: r.account_name,
    tdhpRootCode: r.tdhp_root_code,
    section: r.section,
    amountTry: money(r.amount_try),
    isDynamicNetIncome: r.is_dynamic_net_income,
  }));

  const totalAssetsTry = Number(
    balanceSheet
      .filter((b) => b.section === "asset")
      .reduce((acc, b) => acc.plus(b.amountTry), decimal(0))
      .round(2)
      .toFixed(2),
  );
  const totalLiabilitiesAndEquityTry = Number(
    balanceSheet
      .filter((b) => b.section === "liability" || b.section === "equity")
      .reduce((acc, b) => acc.plus(b.amountTry), decimal(0))
      .round(2)
      .toFixed(2),
  );

  return {
    trialBalance,
    totalDebitTry,
    totalCreditTry,
    totalDebitBalanceTry,
    totalCreditBalanceTry,
    incomeStatement,
    balanceSheet,
    totalAssetsTry,
    totalLiabilitiesAndEquityTry,
  };
}

