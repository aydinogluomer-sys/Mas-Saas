// Faz 61 (0121) — Grup İçi Konsolidasyon Eliminasyon Motoru (120 ↔ 320 Cari & 600 ↔ 770/730 Gelir-Gider).
//
// Kurallar:
//   * Solo şirket yevmiye/fatura defterlerine ASLA dokunmaz; konsolidasyon düzeltme fişlerini
//     yalnız `intercompany_elimination_runs` ve `intercompany_elimination_lines` tablolarına yazar.
//   * Tüm tutar hesapları `@/lib/money` (`decimal`, `money`, `moneyOrNull`) üzerinden geçer.
//   * BLANK != ZERO: Tutarı veya yabancı para TCMB kuru bilinmeyen faturalar uydurma 0 / 1.0 ile
//     değerlenmez; `skippedUnknownCount` sayacında raporlanır.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, formatMoney, money, moneyOrNull, zero, type Decimal } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

export type EliminationRunStatus = "draft" | "posted" | "reversed";
export type EliminationKind = "ar_ap_120_320" | "rev_exp_600_7xx";

export interface IntercompanyEntityInput {
  id: string;
  code: string;
  name: string;
  taxIdVkn?: string | null;
  taxNumber?: string | null;
}

export interface IntercompanyPartyInput {
  id: string;
  name: string;
  taxNumber?: string | null;
  taxId?: string | null;
}

export interface IntercompanyInvoiceInput {
  id: string;
  invoiceNo: string;
  direction: "sales" | "purchase";
  legalEntityId: string | null;
  partyId: string | null;
  issueDate: string;
  currency?: string | null;
  fxRateToTry?: number | string | null;
  netAmount?: number | string | null;
  grossAmount?: number | string | null;
  payableAmount?: number | string | null;
  paidAmount?: number | string | null;
  allocatedAmount?: number | string | null;
  status?: string | null;
  expenseAccountCode?: "770" | "730" | string | null;
}

export interface DetectIntercompanyInput {
  legalEntities: IntercompanyEntityInput[];
  parties: IntercompanyPartyInput[];
  invoices: IntercompanyInvoiceInput[];
  periodStart?: string;
  periodEnd?: string;
}

export interface IntercompanyEliminationLineDraft {
  sellerEntityId: string;
  sellerEntityName: string;
  buyerEntityId: string;
  buyerEntityName: string;
  eliminationKind: EliminationKind;
  debitAccountCode: string;
  creditAccountCode: string;
  amountTry: number;
  sourceInvoiceId: string;
  description: string;
}

export interface IntercompanyMatchedPair {
  pairKey: string;
  matchMode: "bilateral_mirror" | "unilateral_vkn";
  sellerEntityId: string;
  sellerEntityName: string;
  buyerEntityId: string;
  buyerEntityName: string;
  invoiceNo: string;
  issueDate: string;
  primaryInvoiceId: string;
  mirrorInvoiceId: string | null;
  eliminatedArApTry: number;
  eliminatedRevExpTry: number;
  discrepancyTry: number;
  expenseAccountCode: "770" | "730";
}

export interface IntercompanyDetectionResult {
  pairs: IntercompanyMatchedPair[];
  lines: IntercompanyEliminationLineDraft[];
  matchedPairCount: number;
  eliminatedArApTry: number;
  eliminatedRevExpTry: number;
  totalDebitTry: number;
  totalCreditTry: number;
  isBalanced: boolean;
  skippedUnknownCount: number;
}

export interface IntercompanyEliminationLineRow {
  id: string;
  runId: string;
  sellerEntityId: string | null;
  sellerEntityName: string | null;
  buyerEntityId: string | null;
  buyerEntityName: string | null;
  eliminationKind: EliminationKind;
  debitAccountCode: string;
  creditAccountCode: string;
  amountTry: number;
  sourceInvoiceId: string | null;
  description: string;
}

export interface IntercompanyEliminationRunRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: EliminationRunStatus;
  eliminatedArApTry: number;
  eliminatedRevExpTry: number;
  matchedPairCount: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  lines: IntercompanyEliminationLineRow[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const runIntercompanyEliminationSchema = z
  .object({
    periodStart: z.string().trim().regex(ISO_DATE_RE, "Başlangıç tarihi YYYY-AA-GG formatında olmalı."),
    periodEnd: z.string().trim().regex(ISO_DATE_RE, "Bitiş tarihi YYYY-AA-GG formatında olmalı."),
    actorId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(["draft", "posted"]).default("posted"),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: "Bitiş tarihi başlangıç tarihinden küçük olamaz.",
    path: ["periodEnd"],
  });

export type RunIntercompanyEliminationInput = z.input<typeof runIntercompanyEliminationSchema>;

/** Normalizes a Turkish 10-digit VKN or 11-digit TCKN (digits only). Returns null when absent/invalid. */
export function normalizeTaxVkn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10 || digits.length === 11) {
    return digits;
  }
  return null;
}

function normalizeInvoiceKey(invoiceNo: string | null | undefined, fallbackId: string): string {
  const clean = (invoiceNo ?? "").trim().toUpperCase().replace(/\s+/g, "");
  return clean.length > 0 ? clean : `ID:${fallbackId}`;
}

function resolveExpenseCode(raw: string | null | undefined): "770" | "730" {
  const clean = (raw ?? "").trim();
  return clean === "730" ? "730" : "770";
}

interface ResolvedInvoiceAmounts {
  revExpTry: Decimal;
  openArApTry: Decimal;
}

function resolveInvoiceTryAmounts(inv: IntercompanyInvoiceInput): ResolvedInvoiceAmounts | null {
  const currency = (inv.currency ?? "TRY").trim().toUpperCase() || "TRY";
  let fxRate: Decimal;
  if (currency === "TRY") {
    fxRate = decimal(1);
  } else {
    if (inv.fxRateToTry === null || inv.fxRateToTry === undefined || inv.fxRateToTry === "") {
      return null;
    }
    const parsedFx = decimal(inv.fxRateToTry);
    if (parsedFx.lte(0)) return null;
    fxRate = parsedFx;
  }

  const netVal = moneyOrNull(inv.netAmount);
  const grossVal = moneyOrNull(inv.grossAmount);
  const baseRevExpNative = netVal ?? grossVal;
  if (baseRevExpNative === null || baseRevExpNative <= 0) {
    return null;
  }

  const revExpTry = decimal(baseRevExpNative).times(fxRate).round(2);

  const status = (inv.status ?? "open").trim().toLowerCase();
  let openArApTry = zero();
  if (status === "open" || status === "partial") {
    const payableNative = moneyOrNull(inv.payableAmount) ?? grossVal ?? baseRevExpNative;
    const paidNative = moneyOrNull(inv.paidAmount) ?? 0;
    const allocNative = moneyOrNull(inv.allocatedAmount) ?? 0;
    const settledNative = paidNative > allocNative ? paidNative : allocNative;
    const remainingNative = decimal(payableNative).minus(settledNative);
    if (remainingNative.gt(0)) {
      openArApTry = remainingNative.times(fxRate).round(2);
    }
  }

  return { revExpTry, openArApTry };
}

/**
 * Pure intercompany pair & consolidation elimination builder.
 *
 * Matches group `legal_entities` VKN against counterparty `parties` VKN, deduplicates bilateral
 * mirror invoices (`sales` on Seller + `purchase` on Buyer for the same document number), and
 * emits strictly balanced `320 / 120` (AR/AP) and `600 / 770|730` (Revenue/Expense) lines.
 */
export function detectIntercompanyPairs(
  input: DetectIntercompanyInput,
): IntercompanyDetectionResult {
  const entityById = new Map<string, IntercompanyEntityInput>();
  const entityByVkn = new Map<string, IntercompanyEntityInput>();

  for (const entity of input.legalEntities) {
    entityById.set(entity.id, entity);
    const vkn = normalizeTaxVkn(entity.taxIdVkn ?? entity.taxNumber);
    if (vkn && !entityByVkn.has(vkn)) {
      entityByVkn.set(vkn, entity);
    }
  }

  const counterpartyEntityByPartyId = new Map<string, IntercompanyEntityInput>();
  for (const party of input.parties) {
    const vkn = normalizeTaxVkn(party.taxNumber ?? party.taxId);
    if (!vkn) continue;
    const matchedEntity = entityByVkn.get(vkn);
    if (matchedEntity) {
      counterpartyEntityByPartyId.set(party.id, matchedEntity);
    }
  }

  interface GroupedBucket {
    pairKey: string;
    seller: IntercompanyEntityInput;
    buyer: IntercompanyEntityInput;
    salesSide?: { inv: IntercompanyInvoiceInput; amounts: ResolvedInvoiceAmounts };
    purchaseSide?: { inv: IntercompanyInvoiceInput; amounts: ResolvedInvoiceAmounts };
  }

  const buckets = new Map<string, GroupedBucket>();
  let skippedUnknownCount = 0;

  for (const inv of input.invoices) {
    const status = (inv.status ?? "open").trim().toLowerCase();
    if (!["open", "partial", "paid"].includes(status)) continue;
    if (input.periodStart && inv.issueDate < input.periodStart) continue;
    if (input.periodEnd && inv.issueDate > input.periodEnd) continue;
    if (!inv.legalEntityId || !inv.partyId) continue;

    const bookEntity = entityById.get(inv.legalEntityId);
    const partyEntity = counterpartyEntityByPartyId.get(inv.partyId);
    if (!bookEntity || !partyEntity) continue;
    if (bookEntity.id === partyEntity.id) continue;

    const seller = inv.direction === "sales" ? bookEntity : partyEntity;
    const buyer = inv.direction === "sales" ? partyEntity : bookEntity;

    const amounts = resolveInvoiceTryAmounts(inv);
    if (!amounts) {
      skippedUnknownCount += 1;
      continue;
    }

    const docKey = normalizeInvoiceKey(inv.invoiceNo, inv.id);
    const basePairKey = `${seller.id}::${buyer.id}::${docKey}`;
    let bucket = buckets.get(basePairKey);

    if (
      bucket &&
      ((inv.direction === "sales" && bucket.salesSide) ||
        (inv.direction === "purchase" && bucket.purchaseSide))
    ) {
      // Distinct invoice carrying a repeated document label on the same side — keep separate
      const uniqueKey = `${basePairKey}::${inv.id}`;
      bucket = {
        pairKey: uniqueKey,
        seller,
        buyer,
      };
      buckets.set(uniqueKey, bucket);
    } else if (!bucket) {
      bucket = {
        pairKey: basePairKey,
        seller,
        buyer,
      };
      buckets.set(basePairKey, bucket);
    }

    if (inv.direction === "sales") {
      bucket.salesSide = { inv, amounts };
    } else {
      bucket.purchaseSide = { inv, amounts };
    }
  }

  const pairs: IntercompanyMatchedPair[] = [];
  const lines: IntercompanyEliminationLineDraft[] = [];
  let totalArApDec = zero();
  let totalRevExpDec = zero();
  let totalDebitDec = zero();
  let totalCreditDec = zero();

  for (const bucket of buckets.values()) {
    const sales = bucket.salesSide;
    const purchase = bucket.purchaseSide;
    const primary = sales ?? purchase;
    if (!primary) continue;

    const matchMode: "bilateral_mirror" | "unilateral_vkn" =
      sales && purchase ? "bilateral_mirror" : "unilateral_vkn";

    // Conservative consolidation rule: eliminate the matched common amount, surface any discrepancy
    const revExpDec =
      sales && purchase
        ? sales.amounts.revExpTry.lte(purchase.amounts.revExpTry)
          ? sales.amounts.revExpTry
          : purchase.amounts.revExpTry
        : primary.amounts.revExpTry;

    const arApDec =
      sales && purchase
        ? sales.amounts.openArApTry.lte(purchase.amounts.openArApTry)
          ? sales.amounts.openArApTry
          : purchase.amounts.openArApTry
        : primary.amounts.openArApTry;

    const discrepancyDec =
      sales && purchase
        ? sales.amounts.revExpTry.minus(purchase.amounts.revExpTry).abs().round(2)
        : zero();

    const expenseAccountCode = resolveExpenseCode(
      purchase?.inv.expenseAccountCode ?? sales?.inv.expenseAccountCode,
    );

    const invoiceLabel = (primary.inv.invoiceNo || primary.inv.id).trim();
    const arApNum = money(arApDec);
    const revExpNum = money(revExpDec);

    pairs.push({
      pairKey: bucket.pairKey,
      matchMode,
      sellerEntityId: bucket.seller.id,
      sellerEntityName: bucket.seller.name,
      buyerEntityId: bucket.buyer.id,
      buyerEntityName: bucket.buyer.name,
      invoiceNo: invoiceLabel,
      issueDate: primary.inv.issueDate,
      primaryInvoiceId: primary.inv.id,
      mirrorInvoiceId: sales && purchase ? purchase.inv.id : null,
      eliminatedArApTry: arApNum,
      eliminatedRevExpTry: revExpNum,
      discrepancyTry: money(discrepancyDec),
      expenseAccountCode,
    });

    if (arApDec.gt(0)) {
      lines.push({
        sellerEntityId: bucket.seller.id,
        sellerEntityName: bucket.seller.name,
        buyerEntityId: bucket.buyer.id,
        buyerEntityName: bucket.buyer.name,
        eliminationKind: "ar_ap_120_320",
        debitAccountCode: "320",
        creditAccountCode: "120",
        amountTry: arApNum,
        sourceInvoiceId: primary.inv.id,
        description: `Grup içi cari eliminasyon (320 Borç / 120 Alacak) — ${bucket.seller.code} → ${bucket.buyer.code} (${invoiceLabel})`,
      });
      totalArApDec = totalArApDec.plus(arApDec);
      totalDebitDec = totalDebitDec.plus(arApDec);
      totalCreditDec = totalCreditDec.plus(arApDec);
    }

    if (revExpDec.gt(0)) {
      lines.push({
        sellerEntityId: bucket.seller.id,
        sellerEntityName: bucket.seller.name,
        buyerEntityId: bucket.buyer.id,
        buyerEntityName: bucket.buyer.name,
        eliminationKind: "rev_exp_600_7xx",
        debitAccountCode: "600",
        creditAccountCode: expenseAccountCode,
        amountTry: revExpNum,
        sourceInvoiceId: primary.inv.id,
        description: `Grup içi gelir/gider eliminasyonu (600 Borç / ${expenseAccountCode} Alacak) — ${bucket.seller.code} → ${bucket.buyer.code} (${invoiceLabel})`,
      });
      totalRevExpDec = totalRevExpDec.plus(revExpDec);
      totalDebitDec = totalDebitDec.plus(revExpDec);
      totalCreditDec = totalCreditDec.plus(revExpDec);
    }
  }

  return {
    pairs,
    lines,
    matchedPairCount: pairs.length,
    eliminatedArApTry: money(totalArApDec),
    eliminatedRevExpTry: money(totalRevExpDec),
    totalDebitTry: money(totalDebitDec),
    totalCreditTry: money(totalCreditDec),
    isBalanced: totalDebitDec.eq(totalCreditDec),
    skippedUnknownCount,
  };
}

/**
 * Executes an intercompany consolidation elimination run over `[periodStart, periodEnd]`,
 * persisting results to `intercompany_elimination_runs` + `intercompany_elimination_lines`
 * and writing an `audit()` trail without mutating standalone entity books.
 */
export async function runIntercompanyElimination(
  pool: Pool,
  rawInput: RunIntercompanyEliminationInput,
): Promise<{
  run: IntercompanyEliminationRunRow;
  detection: IntercompanyDetectionResult;
}> {
  const input = parseOrThrow(
    runIntercompanyEliminationSchema,
    rawInput,
    "Grup içi eliminasyon parametreleri",
  );

  const client = await pool.connect();
  try {
    await client.query("begin");

    const entitiesRes = await client.query<{
      id: string;
      code: string;
      name: string;
      tax_id_vkn: string | null;
    }>(
      `select id::text, code, name, tax_id_vkn
         from public.legal_entities
        where is_active = true
        order by is_default desc, code asc`,
    );

    const partiesRes = await client.query<{
      id: string;
      name: string;
      tax_number: string | null;
    }>(
      `select p.id::text, p.name, cp.tax_number
         from public.parties p
         left join public.counterparty_profiles cp on cp.party_id = p.id
        where p.archived_at is null`,
    );

    const invoicesRes = await client.query<{
      id: string;
      invoice_no: string;
      direction: "sales" | "purchase";
      legal_entity_id: string | null;
      party_id: string | null;
      issue_date: string;
      currency: string;
      net_amount: string | null;
      gross_amount: string | null;
      payable_amount: string | null;
      paid_amount: string | null;
      allocated_amount: string | null;
      status: string;
      fx_rate_to_try: string | null;
    }>(
      `select i.id::text,
              coalesce(i.invoice_no, '') as invoice_no,
              i.direction,
              i.legal_entity_id::text,
              i.party_id::text,
              to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
              coalesce(i.currency, 'TRY') as currency,
              i.net_amount::text,
              i.gross_amount::text,
              i.payable_amount::text,
              i.paid_amount::text,
              (
                select coalesce(sum(ia.allocated_amount), 0)::text
                  from public.invoice_allocations ia
                 where ia.invoice_id = i.id
              ) as allocated_amount,
              i.status,
              case
                when coalesce(i.currency, 'TRY') = 'TRY' then '1'
                else (
                  select fr.rate::text
                    from public.fx_rate_snapshots fr
                   where fr.base_currency = upper(btrim(i.currency))
                     and fr.quote_currency = 'TRY'
                     and fr.rate_date <= i.issue_date
                   order by fr.rate_date desc
                   limit 1
                )
              end as fx_rate_to_try
         from public.invoices i
        where i.archived_at is null
          and i.status in ('open', 'partial', 'paid')
          and i.issue_date between $1::date and $2::date
        order by i.issue_date asc, i.id asc`,
      [input.periodStart, input.periodEnd],
    );

    const detection = detectIntercompanyPairs({
      legalEntities: entitiesRes.rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        taxIdVkn: r.tax_id_vkn,
      })),
      parties: partiesRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        taxNumber: r.tax_number,
      })),
      invoices: invoicesRes.rows.map((r) => ({
        id: r.id,
        invoiceNo: r.invoice_no,
        direction: r.direction,
        legalEntityId: r.legal_entity_id,
        partyId: r.party_id,
        issueDate: r.issue_date,
        currency: r.currency,
        fxRateToTry: r.fx_rate_to_try,
        netAmount: r.net_amount,
        grossAmount: r.gross_amount,
        payableAmount: r.payable_amount,
        paidAmount: r.paid_amount,
        allocatedAmount: r.allocated_amount,
        status: r.status,
      })),
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });

    if (!detection.isBalanced) {
      throw new DomainError(
        "VALIDATION",
        "Konsolidasyon eliminasyon satırları borç/alacak dengesini sağlamıyor.",
      );
    }

    const cleanNotes = input.notes?.trim() ? input.notes.trim() : null;
    const runIns = await client.query<{
      id: string;
      created_at: Date | string;
    }>(
      `insert into public.intercompany_elimination_runs
         (period_start, period_end, status, eliminated_ar_ap_try, eliminated_rev_exp_try,
          matched_pair_count, notes, created_by)
       values ($1::date, $2::date, $3, $4::numeric, $5::numeric, $6, $7, $8)
       returning id::text, created_at`,
      [
        input.periodStart,
        input.periodEnd,
        input.status,
        formatMoney(detection.eliminatedArApTry),
        formatMoney(detection.eliminatedRevExpTry),
        detection.matchedPairCount,
        cleanNotes,
        input.actorId ?? null,
      ],
    );

    if (runIns.rowCount !== 1) {
      throw new DomainError("Eliminasyon çalıştırması kaydedilemedi.");
    }
    const runId = runIns.rows[0].id;
    const createdAtIso =
      typeof runIns.rows[0].created_at === "string"
        ? runIns.rows[0].created_at
        : runIns.rows[0].created_at.toISOString();

    const insertedLines: IntercompanyEliminationLineRow[] = [];
    for (const line of detection.lines) {
      const lineIns = await client.query<{ id: string }>(
        `insert into public.intercompany_elimination_lines
           (run_id, seller_entity_id, buyer_entity_id, elimination_kind,
            debit_account_code, credit_account_code, amount_try, source_invoice_id, description)
         values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9)
         returning id::text`,
        [
          runId,
          line.sellerEntityId,
          line.buyerEntityId,
          line.eliminationKind,
          line.debitAccountCode,
          line.creditAccountCode,
          formatMoney(line.amountTry),
          line.sourceInvoiceId,
          line.description,
        ],
      );
      if (lineIns.rowCount !== 1) {
        throw new DomainError("Eliminasyon fiş satırı kaydedilemedi.");
      }
      insertedLines.push({
        id: lineIns.rows[0].id,
        runId,
        sellerEntityId: line.sellerEntityId,
        sellerEntityName: line.sellerEntityName,
        buyerEntityId: line.buyerEntityId,
        buyerEntityName: line.buyerEntityName,
        eliminationKind: line.eliminationKind,
        debitAccountCode: line.debitAccountCode,
        creditAccountCode: line.creditAccountCode,
        amountTry: line.amountTry,
        sourceInvoiceId: line.sourceInvoiceId,
        description: line.description,
      });
    }

    await audit(client, {
      actor: input.actorId ?? null,
      action: "run_intercompany_elimination",
      entityTable: "intercompany_elimination_runs",
      entityId: runId,
      after: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: input.status,
        matchedPairCount: detection.matchedPairCount,
        eliminatedArApTry: detection.eliminatedArApTry,
        eliminatedRevExpTry: detection.eliminatedRevExpTry,
        lineCount: insertedLines.length,
        skippedUnknownCount: detection.skippedUnknownCount,
      },
    });

    await client.query("commit");

    return {
      run: {
        id: runId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: input.status,
        eliminatedArApTry: detection.eliminatedArApTry,
        eliminatedRevExpTry: detection.eliminatedRevExpTry,
        matchedPairCount: detection.matchedPairCount,
        notes: cleanNotes,
        createdBy: input.actorId ?? null,
        createdAt: createdAtIso,
        lines: insertedLines,
      },
      detection,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function reverseIntercompanyEliminationRun(
  pool: Pool,
  runId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<void> {
  const validId = parseOrThrow(z.string().uuid(), runId, "Eliminasyon çalıştırma kimliği");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const prev = await client.query<{ status: EliminationRunStatus; notes: string | null }>(
      `select status, notes
         from public.intercompany_elimination_runs
        where id = $1
        for update`,
      [validId],
    );
    if (prev.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Eliminasyon çalıştırması bulunamadı.");
    }
    const before = prev.rows[0];
    if (before.status === "reversed") {
      throw new DomainError("CONFLICT", "Bu eliminasyon çalıştırması zaten ters kayıtla iptal edilmiş.");
    }
    const appendedNotes = reason?.trim()
      ? [before.notes, `[Ters Kayıt: ${reason.trim()}]`].filter(Boolean).join(" — ")
      : before.notes;

    const upd = await client.query(
      `update public.intercompany_elimination_runs
          set status = 'reversed',
              notes = $2
        where id = $1`,
      [validId, appendedNotes],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Eliminasyon çalıştırması güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "reverse_intercompany_elimination",
      entityTable: "intercompany_elimination_runs",
      entityId: validId,
      before: { status: before.status, notes: before.notes },
      after: { status: "reversed", notes: appendedNotes },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function listIntercompanyEliminationRuns(
  pool: Pool,
  limit = 25,
): Promise<IntercompanyEliminationRunRow[]> {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const runsRes = await pool.query<{
    id: string;
    period_start: string;
    period_end: string;
    status: EliminationRunStatus;
    eliminated_ar_ap_try: string;
    eliminated_rev_exp_try: string;
    matched_pair_count: number;
    notes: string | null;
    created_by: string | null;
    created_at: Date | string;
  }>(
    `select id::text,
            to_char(period_start, 'YYYY-MM-DD') as period_start,
            to_char(period_end, 'YYYY-MM-DD') as period_end,
            status,
            eliminated_ar_ap_try::text,
            eliminated_rev_exp_try::text,
            matched_pair_count,
            notes,
            created_by::text,
            created_at
       from public.intercompany_elimination_runs
      order by created_at desc
      limit $1`,
    [safeLimit],
  );

  if (runsRes.rows.length === 0) return [];

  const runIds = runsRes.rows.map((r) => r.id);
  const linesRes = await pool.query<{
    id: string;
    run_id: string;
    seller_entity_id: string | null;
    seller_entity_name: string | null;
    buyer_entity_id: string | null;
    buyer_entity_name: string | null;
    elimination_kind: EliminationKind;
    debit_account_code: string;
    credit_account_code: string;
    amount_try: string;
    source_invoice_id: string | null;
    description: string;
  }>(
    `select l.id::text,
            l.run_id::text,
            l.seller_entity_id::text,
            se.name as seller_entity_name,
            l.buyer_entity_id::text,
            be.name as buyer_entity_name,
            l.elimination_kind,
            l.debit_account_code,
            l.credit_account_code,
            l.amount_try::text,
            l.source_invoice_id::text,
            l.description
       from public.intercompany_elimination_lines l
       left join public.legal_entities se on se.id = l.seller_entity_id
       left join public.legal_entities be on be.id = l.buyer_entity_id
      where l.run_id = any($1::uuid[])
      order by l.created_at asc, l.id asc`,
    [runIds],
  );

  const linesByRun = new Map<string, IntercompanyEliminationLineRow[]>();
  for (const row of linesRes.rows) {
    const arr = linesByRun.get(row.run_id) ?? [];
    arr.push({
      id: row.id,
      runId: row.run_id,
      sellerEntityId: row.seller_entity_id,
      sellerEntityName: row.seller_entity_name,
      buyerEntityId: row.buyer_entity_id,
      buyerEntityName: row.buyer_entity_name,
      eliminationKind: row.elimination_kind,
      debitAccountCode: row.debit_account_code,
      creditAccountCode: row.credit_account_code,
      amountTry: money(row.amount_try),
      sourceInvoiceId: row.source_invoice_id,
      description: row.description,
    });
    linesByRun.set(row.run_id, arr);
  }

  return runsRes.rows.map((r) => ({
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    eliminatedArApTry: money(r.eliminated_ar_ap_try),
    eliminatedRevExpTry: money(r.eliminated_rev_exp_try),
    matchedPairCount: Number(r.matched_pair_count),
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
    lines: linesByRun.get(r.id) ?? [],
  }));
}
