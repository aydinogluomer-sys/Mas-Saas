// Faz 60 (M-28) — Hazine Operasyonları Motoru:
//   1. Bankalar Arası Virman ve Döviz Alım/Satım (`interbank_transfers` + atomik ikili `bank_transactions`
//      `own_transfer` + TDHP `102/102`, masraf `780` ve çapraz kur farkı `646/656`)
//   2. Vadeli Mevduat (`term_deposits`, TDHP `102.05`, brüt faiz & stopaj `193` / `642` hesaplayıcı)
//   3. POS Valör Kuyruğu (`pos_settlement_batches`, TDHP `108` -> `102 + 780`)
//   4. Kurumsal Kredi Kartı Ekstreleri (`corporate_card_statements`, TDHP `309 / 102`)
//
// Sıfır kayan nokta: Tüm tutar, faiz, stopaj ve komisyon hesaplamaları `@/lib/money` (`decimal`) ile yürütülür.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  postJournalEntryWithClient,
  resolveFxRateOrNull,
  type JournalLineInput,
} from "@/lib/ledger/posting-engine";
import { decimal, money, moneyOrNull, rateOrNull, roundMoney as round2 } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(val: string | null | undefined): string | null {
  return val && UUID_RE.test(val) ? val : null;
}

async function ensureBankAccountRow(client: PoolClient, cashAccountId: string): Promise<void> {
  await client.query(
    `insert into public.bank_accounts (cash_account_id) values ($1) on conflict (cash_account_id) do nothing`,
    [cashAccountId],
  );
}

/* ── 1) Vadeli Mevduat Getiri & Stopaj Hesaplayıcı (Pure) ───────────────────────────────── */

export interface TermDepositYieldResult {
  days: number;
  dayCountBasis: 360 | 365;
  grossInterest: number;
  withholdingTaxAmount: number;
  netInterest: number;
  maturityTotal: number;
}

export function calculateTermDepositYield(input: {
  principalAmount: number;
  annualInterestRate: number; // örn. 48.5 (%48.5 yıllık)
  withholdingTaxRate: number; // örn. 0.075 (%7.5 stopaj) veya 7.5
  startDate: string;
  maturityDate: string;
  currency?: string;
}): TermDepositYieldResult {
  const startMs = Date.parse(`${input.startDate}T00:00:00Z`);
  const endMs = Date.parse(`${input.maturityDate}T00:00:00Z`);
  const rawDays = Math.round((endMs - startMs) / 86_400_000);
  const days = Math.max(1, Number.isFinite(rawDays) ? rawDays : 1);
  const ccy = (input.currency ?? "TRY").trim().toUpperCase();
  const dayCountBasis: 360 | 365 = ccy === "USD" || ccy === "EUR" || ccy === "CHF" ? 360 : 365;

  const normStopaj =
    input.withholdingTaxRate > 1
      ? decimal(input.withholdingTaxRate).div(100)
      : decimal(Math.max(0, input.withholdingTaxRate));

  const principalDec = decimal(input.principalAmount);
  const rateDec = decimal(Math.max(0, input.annualInterestRate)).div(100);
  const grossDec = round2(principalDec.times(rateDec).times(days).div(dayCountBasis));
  const taxDec = round2(grossDec.times(normStopaj));
  const netDec = round2(grossDec.minus(taxDec));
  const totalDec = round2(principalDec.plus(netDec));

  return {
    days,
    dayCountBasis,
    grossInterest: money(grossDec),
    withholdingTaxAmount: money(taxDec),
    netInterest: money(netDec),
    maturityTotal: money(totalDec),
  };
}

/* ── 2) Bankalar Arası Virman & Döviz Alım/Satım (`own_transfer`) ────────────────────────── */

export const interbankTransferSchema = z.object({
  fromAccountId: z.uuid("Gönderen kasa/banka hesabı seçilmelidir."),
  toAccountId: z.uuid("Alıcı kasa/banka hesabı seçilmelidir."),
  transferDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tarih YYYY-AA-GG olmalıdır."),
  fromAmount: z.coerce.number().positive("Gönderilen tutar sıfırdan büyük olmalıdır."),
  toAmount: z.coerce.number().positive().optional(),
  fxRate: z.coerce.number().positive().optional(),
  feeAmount: z.coerce.number().min(0).default(0),
  description: z.string().trim().max(500).optional(),
});

export async function executeInterbankTransfer(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{
  transferId: string;
  outflowBankTxnId: string;
  inflowBankTxnId: string;
  journalEntryId: string;
}> {
  const input = parseOrThrow(interbankTransferSchema, raw, "Bankalar arası virman / döviz işlemi");
  if (input.fromAccountId === input.toAccountId) {
    throw new DomainError("VALIDATION", "Gönderen ve alıcı banka/kasa hesabı aynı olamaz.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const accRes = await client.query<{
      id: string;
      name: string;
      currency: string;
      account_type: string;
      is_active: boolean;
    }>(
      `select id::text as id, name, currency, account_type, is_active
         from public.cash_accounts
        where id = any($1::uuid[])
          and archived_at is null
        for update`,
      [[input.fromAccountId, input.toAccountId]],
    );

    const fromAcc = accRes.rows.find((r) => r.id === input.fromAccountId);
    const toAcc = accRes.rows.find((r) => r.id === input.toAccountId);
    if (!fromAcc || !fromAcc.is_active) {
      throw new DomainError("NOT_FOUND", "Gönderen kasa/banka hesabı bulunamadı veya pasif.");
    }
    if (!toAcc || !toAcc.is_active) {
      throw new DomainError("NOT_FOUND", "Alıcı kasa/banka hesabı bulunamadı veya pasif.");
    }

    const fromCurr = fromAcc.currency.toUpperCase();
    const toCurr = toAcc.currency.toUpperCase();
    const fromAmtDec = round2(decimal(input.fromAmount));
    const feeDec = round2(decimal(input.feeAmount ?? 0));

    let toAmtDec = fromAmtDec;
    let effectiveFxRateDec = decimal(1);

    if (fromCurr === toCurr) {
      if (input.toAmount != null && !round2(decimal(input.toAmount)).eq(fromAmtDec)) {
        throw new DomainError(
          "VALIDATION",
          `Aynı para biriminde (${fromCurr}) gönderilen ve alınan net tutar eşit olmalıdır.`,
        );
      }
      toAmtDec = fromAmtDec;
      effectiveFxRateDec = decimal(1);
    } else {
      if (input.toAmount != null && input.toAmount > 0) {
        toAmtDec = round2(decimal(input.toAmount));
        effectiveFxRateDec =
          fromCurr === "TRY"
            ? fromAmtDec.div(toAmtDec)
            : toCurr === "TRY"
              ? toAmtDec.div(fromAmtDec)
              : toAmtDec.div(fromAmtDec);
      } else if (input.fxRate != null && input.fxRate > 0) {
        const rateDec = decimal(input.fxRate);
        effectiveFxRateDec = rateDec;
        if (fromCurr === "TRY" && toCurr !== "TRY") {
          // Örn. 345.000 TRY -> kur 34.50 -> 10.000 USD
          toAmtDec = round2(fromAmtDec.div(rateDec));
        } else {
          // Örn. 10.000 USD -> kur 34.50 -> 345.000 TRY
          toAmtDec = round2(fromAmtDec.times(rateDec));
        }
      } else {
        throw new DomainError(
          "VALIDATION",
          `Çapraz döviz virmanında (${fromCurr} -> ${toCurr}) hedef tutar veya işlem kuru girilmelidir.`,
        );
      }
    }

    if (toAmtDec.lte(0)) {
      throw new DomainError("VALIDATION", "Hesaplanan alıcı tutar sıfırdan büyük olmalıdır.");
    }

    await ensureBankAccountRow(client, fromAcc.id);
    await ensureBankAccountRow(client, toAcc.id);

    const transferUid = globalThis.crypto.randomUUID();
    const totalOutflowDec = round2(fromAmtDec.plus(feeDec));
    const descBase =
      input.description?.trim() ||
      (fromCurr === toCurr
        ? `Virman: ${fromAcc.name} -> ${toAcc.name}`
        : `Döviz Alım/Satım Virmanı: ${fromAcc.name} (${fromAmtDec.toFixed(2)} ${fromCurr}) -> ${toAcc.name} (${toAmtDec.toFixed(2)} ${toCurr})`);

    const outIns = await client.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, value_date, amount, currency, description,
          category_rule, status, transaction_kind, dedupe_hash)
       values ($1, $2::date, $2::date, $3::numeric, $4, $5,
               'system_internal_settlement', 'unmatched', 'own_transfer', $6)
       returning id::text as id`,
      [
        fromAcc.id,
        input.transferDate,
        totalOutflowDec.times(-1).toFixed(2),
        fromCurr,
        descBase,
        `interbank_out:${transferUid}`,
      ],
    );
    if (outIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Gönderen banka hareketi oluşturulamadı.");
    }

    const inIns = await client.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, value_date, amount, currency, description,
          category_rule, status, transaction_kind, dedupe_hash)
       values ($1, $2::date, $2::date, $3::numeric, $4, $5,
               'system_internal_settlement', 'unmatched', 'own_transfer', $6)
       returning id::text as id`,
      [
        toAcc.id,
        input.transferDate,
        toAmtDec.toFixed(2),
        toCurr,
        descBase,
        `interbank_in:${transferUid}`,
      ],
    );
    if (inIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Alıcı banka hareketi oluşturulamadı.");
    }

    const fromCode = fromAcc.account_type === "cash" ? "100" : "102";
    const toCode = toAcc.account_type === "cash" ? "100" : "102";

    const lines: JournalLineInput[] = [];
    if (fromCurr === toCurr) {
      const spotRate =
        fromCurr === "TRY" ? 1 : await resolveFxRateOrNull(client, fromCurr, input.transferDate);
      lines.push({
        accountCode: toCode,
        debitNative: toAmtDec.toFixed(2),
        memo: `Alıcı: ${toAcc.name}`,
      });
      if (feeDec.gt(0)) {
        lines.push({
          accountCode: "780",
          debitNative: feeDec.toFixed(2),
          memo: `Virman/EFT komisyonu (${fromAcc.name})`,
        });
      }
      lines.push({
        accountCode: fromCode,
        creditNative: totalOutflowDec.toFixed(2),
        memo: `Gönderen: ${fromAcc.name}`,
      });

      const je = await postJournalEntryWithClient(
        client,
        {
          entryDate: input.transferDate,
          sourceType: "interbank_transfer",
          sourceId: transferUid,
          idempotencyKey: `interbank_transfer:${transferUid}`,
          description: descBase,
          currency: fromCurr,
          fxRate: spotRate,
          lines,
        },
        actorId,
      );

      const trIns = await client.query<{ id: string }>(
        `insert into public.interbank_transfers
           (id, from_account_id, to_account_id, transfer_date, from_amount, from_currency,
            to_amount, to_currency, fx_rate, fee_amount, outflow_bank_txn_id, inflow_bank_txn_id,
            journal_entry_id, description, created_by)
         values ($1, $2, $3, $4::date, $5::numeric, $6, $7::numeric, $8, $9::numeric, $10::numeric,
                 $11, $12, $13, $14, $15)
         returning id::text as id`,
        [
          transferUid,
          fromAcc.id,
          toAcc.id,
          input.transferDate,
          fromAmtDec.toFixed(2),
          fromCurr,
          toAmtDec.toFixed(2),
          toCurr,
          effectiveFxRateDec.round(6).toFixed(6),
          feeDec.toFixed(2),
          outIns.rows[0].id,
          inIns.rows[0].id,
          je.entryId,
          descBase,
          uuidOrNull(actorId),
        ],
      );
      if (trIns.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Bankalar arası virman kaydı oluşturulamadı.");
      }

      await audit(client, {
        actor: actorId,
        action: "execute_interbank_transfer",
        entityTable: "interbank_transfers",
        entityId: transferUid,
        after: {
          fromAccountId: fromAcc.id,
          toAccountId: toAcc.id,
          fromAmount: money(fromAmtDec),
          fromCurrency: fromCurr,
          toAmount: money(toAmtDec),
          toCurrency: toCurr,
          feeAmount: money(feeDec),
          journalEntryId: je.entryId,
        },
      });

      await client.query("commit");
      return {
        transferId: transferUid,
        outflowBankTxnId: outIns.rows[0].id,
        inflowBankTxnId: inIns.rows[0].id,
        journalEntryId: je.entryId,
      };
    }

    // Çapraz para birimi (Döviz Alım / Satım / Arbitraj): TCMB spot karşılığı + 646/656 kambiyo farkı
    let fromSpotTry =
      fromCurr === "TRY" ? 1 : await resolveFxRateOrNull(client, fromCurr, input.transferDate);
    let toSpotTry =
      toCurr === "TRY" ? 1 : await resolveFxRateOrNull(client, toCurr, input.transferDate);

    // Eğer bir ayak TRY ise ve TCMB kuru henüz çekilmemişse işlem kuru yedek olarak kullanılır
    if (fromSpotTry == null && toCurr === "TRY") {
      fromSpotTry = Number(toAmtDec.div(fromAmtDec).round(6).toFixed(6));
    }
    if (toSpotTry == null && fromCurr === "TRY") {
      toSpotTry = Number(fromAmtDec.div(toAmtDec).round(6).toFixed(6));
    }

    const hasBothTryRates = fromSpotTry != null && fromSpotTry > 0 && toSpotTry != null && toSpotTry > 0;
    if (hasBothTryRates) {
      const inflowTry = round2(toAmtDec.times(toSpotTry!));
      const outflowPrincipalTry = round2(fromAmtDec.times(fromSpotTry!));
      const feeTry = round2(feeDec.times(fromSpotTry!));
      const totalCreditTry = round2(outflowPrincipalTry.plus(feeTry));
      // Kambiyo farkı = Alınan dövizin TCMB değeri - Gönderilen dövizin TCMB değeri
      const fxDiffTry = round2(inflowTry.minus(outflowPrincipalTry));

      lines.push({
        accountCode: toCode,
        lineCurrency: toCurr,
        debitNative: toAmtDec.toFixed(2),
        fxRateOverride: toSpotTry!,
        debitTryOverride: inflowTry.toFixed(2),
        memo: `Alıcı: ${toAcc.name} (${toAmtDec.toFixed(2)} ${toCurr})`,
      });
      if (feeDec.gt(0)) {
        lines.push({
          accountCode: "780",
          lineCurrency: fromCurr,
          debitNative: feeDec.toFixed(2),
          fxRateOverride: fromSpotTry!,
          debitTryOverride: feeTry.toFixed(2),
          memo: `Döviz işlem komisyonu (${fromAcc.name})`,
        });
      }
      if (fxDiffTry.lt(0)) {
        lines.push({
          accountCode: "656",
          lineCurrency: "TRY",
          debitNative: fxDiffTry.abs().toFixed(2),
          fxRateOverride: 1,
          debitTryOverride: fxDiffTry.abs().toFixed(2),
          memo: `Döviz alım/satım kur farkı zararı (TCMB spot farkı)`,
        });
      }
      lines.push({
        accountCode: fromCode,
        lineCurrency: fromCurr,
        creditNative: totalOutflowDec.toFixed(2),
        fxRateOverride: fromSpotTry!,
        creditTryOverride: totalCreditTry.toFixed(2),
        memo: `Gönderen: ${fromAcc.name} (${totalOutflowDec.toFixed(2)} ${fromCurr})`,
      });
      if (fxDiffTry.gt(0)) {
        lines.push({
          accountCode: "646",
          lineCurrency: "TRY",
          creditNative: fxDiffTry.toFixed(2),
          fxRateOverride: 1,
          creditTryOverride: fxDiffTry.toFixed(2),
          memo: `Döviz alım/satım kur farkı kârı (TCMB spot farkı)`,
        });
      }
    } else {
      // İki yabancı para arasında (örn. EUR -> USD) hiç kur yoksa provisional_fx olarak kaydet
      lines.push({
        accountCode: toCode,
        lineCurrency: toCurr,
        debitNative: toAmtDec.toFixed(2),
        fxRateOverride: null,
        memo: `Alıcı: ${toAcc.name}`,
      });
      if (feeDec.gt(0)) {
        lines.push({
          accountCode: "780",
          lineCurrency: fromCurr,
          debitNative: feeDec.toFixed(2),
          fxRateOverride: null,
          memo: `Döviz işlem komisyonu`,
        });
      }
      lines.push({
        accountCode: fromCode,
        lineCurrency: fromCurr,
        creditNative: totalOutflowDec.toFixed(2),
        fxRateOverride: null,
        memo: `Gönderen: ${fromAcc.name}`,
      });
    }

    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: input.transferDate,
        sourceType: "interbank_transfer",
        sourceId: transferUid,
        idempotencyKey: `interbank_transfer:${transferUid}`,
        description: descBase,
        currency: "TRY",
        fxRate: 1,
        lines,
      },
      actorId,
    );

    const trIns = await client.query<{ id: string }>(
      `insert into public.interbank_transfers
         (id, from_account_id, to_account_id, transfer_date, from_amount, from_currency,
          to_amount, to_currency, fx_rate, fee_amount, outflow_bank_txn_id, inflow_bank_txn_id,
          journal_entry_id, description, created_by)
       values ($1, $2, $3, $4::date, $5::numeric, $6, $7::numeric, $8, $9::numeric, $10::numeric,
               $11, $12, $13, $14, $15)
       returning id::text as id`,
      [
        transferUid,
        fromAcc.id,
        toAcc.id,
        input.transferDate,
        fromAmtDec.toFixed(2),
        fromCurr,
        toAmtDec.toFixed(2),
        toCurr,
        effectiveFxRateDec.round(6).toFixed(6),
        feeDec.toFixed(2),
        outIns.rows[0].id,
        inIns.rows[0].id,
        je.entryId,
        descBase,
        uuidOrNull(actorId),
      ],
    );
    if (trIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Çapraz döviz virman kaydı oluşturulamadı.");
    }

    await audit(client, {
      actor: actorId,
      action: "execute_interbank_transfer",
      entityTable: "interbank_transfers",
      entityId: transferUid,
      after: {
        fromAccountId: fromAcc.id,
        toAccountId: toAcc.id,
        fromAmount: money(fromAmtDec),
        fromCurrency: fromCurr,
        toAmount: money(toAmtDec),
        toCurrency: toCurr,
        fxRate: Number(effectiveFxRateDec.round(6).toFixed(6)),
        feeAmount: money(feeDec),
        journalEntryId: je.entryId,
      },
    });

    await client.query("commit");
    return {
      transferId: transferUid,
      outflowBankTxnId: outIns.rows[0].id,
      inflowBankTxnId: inIns.rows[0].id,
      journalEntryId: je.entryId,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 3) Vadeli Mevduat (`term_deposits` — TDHP `102.05`) ─────────────────────────────────── */

export const createTermDepositSchema = z.object({
  cashAccountId: z.uuid("Vadesiz/vadeli banka hesabı seçilmelidir."),
  depositName: z.string().trim().min(2, "Vadeli hesap etiketi en az 2 karakter olmalıdır.").max(160),
  principalAmount: z.coerce.number().positive("Anapara sıfırdan büyük olmalıdır."),
  annualInterestRate: z.coerce.number().min(0).max(500),
  withholdingTaxRate: z.coerce.number().min(0).max(100).default(0.075),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maturityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function createTermDeposit(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string; yieldSummary: TermDepositYieldResult }> {
  const input = parseOrThrow(createTermDepositSchema, raw, "Vadeli mevduat bağlama");
  if (input.maturityDate < input.startDate) {
    throw new DomainError("VALIDATION", "Vade dönüş tarihi başlangıç tarihinden önce olamaz.");
  }

  const normStopaj =
    input.withholdingTaxRate > 1
      ? Number(decimal(input.withholdingTaxRate).div(100).round(4).toFixed(4))
      : Number(decimal(input.withholdingTaxRate).round(4).toFixed(4));

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accRes = await client.query<{ id: string; name: string; currency: string; is_active: boolean }>(
      `select id::text as id, name, currency, is_active
         from public.cash_accounts
        where id = $1 and archived_at is null`,
      [input.cashAccountId],
    );
    if (accRes.rowCount !== 1 || !accRes.rows[0].is_active) {
      throw new DomainError("NOT_FOUND", "Vadeli mevduat bağlanacak aktif banka hesabı bulunamadı.");
    }
    const acc = accRes.rows[0];
    const yieldSummary = calculateTermDepositYield({
      principalAmount: input.principalAmount,
      annualInterestRate: input.annualInterestRate,
      withholdingTaxRate: normStopaj,
      startDate: input.startDate,
      maturityDate: input.maturityDate,
      currency: acc.currency,
    });

    const ins = await client.query<{ id: string }>(
      `insert into public.term_deposits
         (cash_account_id, deposit_name, principal_amount, currency, annual_interest_rate,
          withholding_tax_rate, start_date, maturity_date, expected_net_interest, is_active)
       values ($1, $2, $3::numeric, $4, $5::numeric, $6::numeric, $7::date, $8::date, $9::numeric, true)
       returning id::text as id`,
      [
        acc.id,
        input.depositName,
        round2(decimal(input.principalAmount)).toFixed(2),
        acc.currency,
        decimal(input.annualInterestRate).round(4).toFixed(4),
        decimal(normStopaj).round(4).toFixed(4),
        input.startDate,
        input.maturityDate,
        decimal(yieldSummary.netInterest).toFixed(2),
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Vadeli mevduat kaydı oluşturulamadı.");
    }
    const depositId = ins.rows[0].id;

    await postJournalEntryWithClient(
      client,
      {
        entryDate: input.startDate,
        sourceType: "interbank_transfer",
        sourceId: depositId,
        idempotencyKey: `term_deposit:open:${depositId}`,
        description: `Vadeli mevduat bağlama: ${input.depositName} (${acc.name})`,
        currency: acc.currency,
        lines: [
          {
            accountCode: "102.05",
            debitNative: round2(decimal(input.principalAmount)).toFixed(2),
            memo: `Vadeli hesap açılışı (${yieldSummary.days} gün, %${input.annualInterestRate})`,
          },
          {
            accountCode: "102",
            creditNative: round2(decimal(input.principalAmount)).toFixed(2),
            memo: `Vadesizden vadeliye aktarım (${acc.name})`,
          },
        ],
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "create_term_deposit",
      entityTable: "term_deposits",
      entityId: depositId,
      after: {
        depositName: input.depositName,
        principalAmount: input.principalAmount,
        currency: acc.currency,
        annualInterestRate: input.annualInterestRate,
        withholdingTaxRate: normStopaj,
        expectedNetInterest: yieldSummary.netInterest,
      },
    });

    await client.query("commit");
    return { id: depositId, yieldSummary };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function settleTermDeposit(
  pool: Pool,
  depositId: string,
  settledDate: string | null,
  actorId: string,
): Promise<{ netInterest: number; journalEntryId: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{
      id: string;
      cash_account_id: string;
      deposit_name: string;
      principal_amount: string;
      currency: string;
      annual_interest_rate: string;
      withholding_tax_rate: string;
      start_date: string;
      maturity_date: string;
      is_active: boolean;
    }>(
      `select id::text as id, cash_account_id::text as cash_account_id, deposit_name,
              principal_amount::text, currency, annual_interest_rate::text,
              withholding_tax_rate::text,
              to_char(start_date, 'YYYY-MM-DD') as start_date,
              to_char(maturity_date, 'YYYY-MM-DD') as maturity_date,
              is_active
         from public.term_deposits
        where id = $1
        for update`,
      [depositId],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Vadeli mevduat kaydı bulunamadı.");
    }
    const row = res.rows[0];
    if (!row.is_active) {
      throw new DomainError("CONFLICT", "Bu vadeli mevduat zaten vadesinde kapatılmış.");
    }

    const effDate = settledDate && /^\d{4}-\d{2}-\d{2}$/.test(settledDate) ? settledDate : row.maturity_date;
    const yieldSummary = calculateTermDepositYield({
      principalAmount: Number(row.principal_amount),
      annualInterestRate: Number(row.annual_interest_rate),
      withholdingTaxRate: Number(row.withholding_tax_rate),
      startDate: row.start_date,
      maturityDate: row.maturity_date,
      currency: row.currency,
    });

    const upd = await client.query(
      `update public.term_deposits set is_active = false, updated_at = now() where id = $1`,
      [depositId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Vadeli mevduat kapatılamadı.");
    }

    await ensureBankAccountRow(client, row.cash_account_id);
    if (yieldSummary.netInterest > 0) {
      await client.query(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, value_date, amount, currency, description,
            category_rule, status, dedupe_hash)
         values ($1, $2::date, $2::date, $3::numeric, $4, $5,
                 'system_internal_settlement', 'unmatched', $6)
         on conflict (bank_account_id, dedupe_hash) do nothing`,
        [
          row.cash_account_id,
          effDate,
          decimal(yieldSummary.netInterest).toFixed(2),
          row.currency,
          `Vadeli mevduat net faiz getirisi: ${row.deposit_name}`,
          `term_deposit_interest:${depositId}`,
        ],
      );
    }

    const principalDec = round2(decimal(row.principal_amount));
    const netDec = round2(decimal(yieldSummary.netInterest));
    const taxDec = round2(decimal(yieldSummary.withholdingTaxAmount));
    const grossDec = round2(decimal(yieldSummary.grossInterest));

    const lines: JournalLineInput[] = [
      {
        accountCode: "102",
        debitNative: round2(principalDec.plus(netDec)).toFixed(2),
        memo: `Vadeli mevduat dönüşü (anapara + net faiz)`,
      },
    ];
    if (taxDec.gt(0)) {
      lines.push({
        accountCode: "193",
        debitNative: taxDec.toFixed(2),
        memo: `Mevduat faizi stopaj kesintisi`,
      });
    }
    lines.push({
      accountCode: "102.05",
      creditNative: principalDec.toFixed(2),
      memo: `Vadeli mevduat anapara kapanışı`,
    });
    if (grossDec.gt(0)) {
      lines.push({
        accountCode: "642",
        creditNative: grossDec.toFixed(2),
        memo: `Vadeli mevduat brüt faiz geliri`,
      });
    }

    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: effDate,
        sourceType: "interbank_transfer",
        sourceId: depositId,
        idempotencyKey: `term_deposit:settle:${depositId}`,
        description: `Vadeli mevduat vade dönüşü: ${row.deposit_name}`,
        currency: row.currency,
        lines,
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "settle_term_deposit",
      entityTable: "term_deposits",
      entityId: depositId,
      before: { is_active: true },
      after: {
        is_active: false,
        grossInterest: yieldSummary.grossInterest,
        withholdingTax: yieldSummary.withholdingTaxAmount,
        netInterest: yieldSummary.netInterest,
        journalEntryId: je.entryId,
      },
    });

    await client.query("commit");
    return { netInterest: yieldSummary.netInterest, journalEntryId: je.entryId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 4) POS Valör Kuyruğu (`pos_settlement_batches` — TDHP `108` -> `102 + 780`) ─────────── */

export const createPosBatchSchema = z.object({
  cashAccountId: z.uuid("POS bağlı banka hesabı seçilmelidir."),
  posTerminalLabel: z.string().trim().min(2, "POS terminal etiketi en az 2 karakter olmalıdır.").max(120),
  saleDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedValueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  grossAmount: z.coerce.number().positive("Brüt POS çekim tutarı sıfırdan büyük olmalıdır."),
  commissionRate: z.coerce.number().min(0).max(100).default(0.025),
});

export async function createPosSettlementBatch(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(createPosBatchSchema, raw, "POS valör kaydı");
  const normCommRate =
    input.commissionRate > 1
      ? decimal(input.commissionRate).div(100)
      : decimal(input.commissionRate);
  const grossDec = round2(decimal(input.grossAmount));
  const commDec = round2(grossDec.times(normCommRate));
  const netDec = round2(grossDec.minus(commDec));

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accRes = await client.query<{ id: string; currency: string; is_active: boolean }>(
      `select id::text as id, currency, is_active from public.cash_accounts where id = $1 and archived_at is null`,
      [input.cashAccountId],
    );
    if (accRes.rowCount !== 1 || !accRes.rows[0].is_active) {
      throw new DomainError("NOT_FOUND", "POS banka hesabı bulunamadı veya pasif.");
    }
    const currency = accRes.rows[0].currency;

    const ins = await client.query<{ id: string }>(
      `insert into public.pos_settlement_batches
         (cash_account_id, pos_terminal_label, sale_date, expected_value_date,
          gross_amount, commission_rate, commission_amount, net_settlement_amount, currency)
       values ($1, $2, $3::date, $4::date, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9)
       returning id::text as id`,
      [
        input.cashAccountId,
        input.posTerminalLabel,
        input.saleDate,
        input.expectedValueDate,
        grossDec.toFixed(2),
        normCommRate.round(4).toFixed(4),
        commDec.toFixed(2),
        netDec.toFixed(2),
        currency,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "POS valör kaydı oluşturulamadı.");
    }
    const batchId = ins.rows[0].id;

    await audit(client, {
      actor: actorId,
      action: "create_pos_settlement_batch",
      entityTable: "pos_settlement_batches",
      entityId: batchId,
      after: {
        posTerminalLabel: input.posTerminalLabel,
        grossAmount: money(grossDec),
        commissionAmount: money(commDec),
        netSettlementAmount: money(netDec),
        expectedValueDate: input.expectedValueDate,
      },
    });

    await client.query("commit");
    return batchId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function settlePosSettlementBatch(
  pool: Pool,
  batchId: string,
  settledDate: string | null,
  actorId: string,
): Promise<{ bankTxnId: string; journalEntryId: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{
      id: string;
      cash_account_id: string;
      pos_terminal_label: string;
      expected_value_date: string;
      gross_amount: string;
      commission_amount: string;
      net_settlement_amount: string;
      currency: string;
      is_settled: boolean;
    }>(
      `select id::text as id, cash_account_id::text as cash_account_id, pos_terminal_label,
              to_char(expected_value_date, 'YYYY-MM-DD') as expected_value_date,
              gross_amount::text, commission_amount::text, net_settlement_amount::text,
              currency, is_settled
         from public.pos_settlement_batches
        where id = $1
        for update`,
      [batchId],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "POS valör kaydı bulunamadı.");
    }
    const row = res.rows[0];
    if (row.is_settled) {
      throw new DomainError("CONFLICT", "Bu POS valör partisi zaten hesaba geçmiş.");
    }

    const effDate = settledDate && /^\d{4}-\d{2}-\d{2}$/.test(settledDate) ? settledDate : row.expected_value_date;
    await ensureBankAccountRow(client, row.cash_account_id);

    const txIns = await client.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, value_date, amount, currency, description,
          category_rule, status, dedupe_hash)
       values ($1, $2::date, $2::date, $3::numeric, $4, $5,
               'system_internal_settlement', 'unmatched', $6)
       returning id::text as id`,
      [
        row.cash_account_id,
        effDate,
        round2(decimal(row.net_settlement_amount)).toFixed(2),
        row.currency,
        `POS valör dönüşü: ${row.pos_terminal_label}`,
        `pos_settlement:${batchId}`,
      ],
    );
    if (txIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "POS banka hareketi oluşturulamadı.");
    }
    const bankTxnId = txIns.rows[0].id;

    const upd = await client.query(
      `update public.pos_settlement_batches
          set is_settled = true,
              settled_at = now(),
              settled_bank_txn_id = $2,
              updated_at = now()
        where id = $1`,
      [batchId, bankTxnId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "POS valör durumu güncellenemedi.");
    }

    const grossDec = round2(decimal(row.gross_amount));
    const commDec = round2(decimal(row.commission_amount));
    const netDec = round2(decimal(row.net_settlement_amount));

    const lines: JournalLineInput[] = [
      {
        accountCode: "102",
        debitNative: netDec.toFixed(2),
        memo: `POS net hesaba geçen (${row.pos_terminal_label})`,
      },
    ];
    if (commDec.gt(0)) {
      lines.push({
        accountCode: "780",
        debitNative: commDec.toFixed(2),
        memo: `POS banka komisyon kesintisi`,
      });
    }
    lines.push({
      accountCode: "108",
      creditNative: grossDec.toFixed(2),
      memo: `POS blokaj çözümü (108 Diğer Hazır Değerler)`,
    });

    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: effDate,
        sourceType: "bank_transaction",
        sourceId: bankTxnId,
        idempotencyKey: `pos_batch:settle:${batchId}`,
        description: `POS valör hesaba geçişi: ${row.pos_terminal_label}`,
        currency: row.currency,
        lines,
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "settle_pos_batch",
      entityTable: "pos_settlement_batches",
      entityId: batchId,
      before: { is_settled: false },
      after: { is_settled: true, bankTxnId, journalEntryId: je.entryId },
    });

    await client.query("commit");
    return { bankTxnId, journalEntryId: je.entryId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 5) Kurumsal Kredi Kartı Ekstreleri (`corporate_card_statements` — TDHP `309`) ──────── */

export const createCardStatementSchema = z.object({
  cardAccountId: z.uuid("Kurumsal kart hesabı seçilmelidir."),
  payFromAccountId: z.uuid().nullable().optional(),
  statementMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  cutoffDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  statementAmount: z.coerce.number().positive("Ekstre tutarı sıfırdan büyük olmalıdır."),
  minimumPaymentAmount: z.coerce.number().min(0).nullable().optional(),
});

export async function createCorporateCardStatement(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(createCardStatementSchema, raw, "Kurumsal kart ekstresi");
  const monthStart = `${input.statementMonth.slice(0, 7)}-01`;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const accRes = await client.query<{ id: string; currency: string }>(
      `select id::text as id, currency from public.cash_accounts where id = $1 and archived_at is null`,
      [input.cardAccountId],
    );
    if (accRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Kurumsal kart hesabı bulunamadı.");
    }
    const currency = accRes.rows[0].currency;

    const ins = await client.query<{ id: string }>(
      `insert into public.corporate_card_statements
         (card_account_id, pay_from_account_id, statement_month, cutoff_date, due_date,
          statement_amount, minimum_payment_amount, currency)
       values ($1, $2, $3::date, $4::date, $5::date, $6::numeric, $7::numeric, $8)
       on conflict (card_account_id, statement_month) do update
         set cutoff_date = excluded.cutoff_date,
             due_date = excluded.due_date,
             statement_amount = excluded.statement_amount,
             minimum_payment_amount = excluded.minimum_payment_amount,
             pay_from_account_id = coalesce(excluded.pay_from_account_id, public.corporate_card_statements.pay_from_account_id),
             updated_at = now()
       returning id::text as id`,
      [
        input.cardAccountId,
        input.payFromAccountId ?? null,
        monthStart,
        input.cutoffDate,
        input.dueDate,
        round2(decimal(input.statementAmount)).toFixed(2),
        input.minimumPaymentAmount != null ? round2(decimal(input.minimumPaymentAmount)).toFixed(2) : null,
        currency,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Kurumsal kart ekstresi kaydedilemedi.");
    }
    const id = ins.rows[0].id;

    await audit(client, {
      actor: actorId,
      action: "upsert_corporate_card_statement",
      entityTable: "corporate_card_statements",
      entityId: id,
      after: {
        cardAccountId: input.cardAccountId,
        statementMonth: monthStart,
        statementAmount: input.statementAmount,
        dueDate: input.dueDate,
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

export const payCardStatementSchema = z.object({
  statementId: z.uuid(),
  payFromAccountId: z.uuid("Ödemenin yapılacağı banka hesabı seçilmelidir."),
  payAmount: z.coerce.number().positive("Ödeme tutarı sıfırdan büyük olmalıdır.").optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function payCorporateCardStatement(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ bankTxnId: string; journalEntryId: string }> {
  const input = parseOrThrow(payCardStatementSchema, raw, "Kurumsal kart ekstre ödemesi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const stRes = await client.query<{
      id: string;
      card_account_id: string;
      statement_month: string;
      due_date: string;
      statement_amount: string;
      paid_amount: string;
      currency: string;
      is_settled: boolean;
    }>(
      `select id::text as id, card_account_id::text as card_account_id,
              to_char(statement_month, 'YYYY-MM') as statement_month,
              to_char(due_date, 'YYYY-MM-DD') as due_date,
              statement_amount::text, paid_amount::text, currency, is_settled
         from public.corporate_card_statements
        where id = $1
        for update`,
      [input.statementId],
    );
    if (stRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Kurumsal kart ekstresi bulunamadı.");
    }
    const st = stRes.rows[0];
    if (st.is_settled) {
      throw new DomainError("CONFLICT", "Bu kurumsal kart ekstresi zaten tamamen ödenmiş.");
    }

    const bankRes = await client.query<{ id: string; name: string; currency: string; is_active: boolean }>(
      `select id::text as id, name, currency, is_active
         from public.cash_accounts
        where id = $1 and archived_at is null`,
      [input.payFromAccountId],
    );
    if (bankRes.rowCount !== 1 || !bankRes.rows[0].is_active) {
      throw new DomainError("NOT_FOUND", "Ödeme yapılacak banka hesabı bulunamadı veya pasif.");
    }
    if (bankRes.rows[0].currency !== st.currency) {
      throw new DomainError(
        "CONFLICT",
        `Ekstre para birimi (${st.currency}) ile banka hesabı para birimi (${bankRes.rows[0].currency}) eşleşmelidir.`,
      );
    }

    const remainingDec = round2(decimal(st.statement_amount).minus(decimal(st.paid_amount)));
    const payDec = input.payAmount != null ? round2(decimal(input.payAmount)) : remainingDec;
    if (payDec.lte(0) || payDec.gt(remainingDec)) {
      throw new DomainError(
        "VALIDATION",
        `Ödeme tutarı (${payDec.toFixed(2)}) kalan ekstre borcunu (${remainingDec.toFixed(2)}) aşamaz.`,
      );
    }

    const effDate = input.paymentDate ?? st.due_date;
    await ensureBankAccountRow(client, input.payFromAccountId);

    const newPaidDec = round2(decimal(st.paid_amount).plus(payDec));
    const isNowSettled = newPaidDec.gte(round2(decimal(st.statement_amount)));
    const paymentSeq = globalThis.crypto.randomUUID().slice(0, 8);

    const txIns = await client.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, value_date, amount, currency, description,
          category_rule, status, dedupe_hash)
       values ($1, $2::date, $2::date, $3::numeric, $4, $5,
               'system_internal_settlement', 'unmatched', $6)
       returning id::text as id`,
      [
        input.payFromAccountId,
        effDate,
        payDec.times(-1).toFixed(2),
        st.currency,
        `Kurumsal kart ekstre ödemesi (${st.statement_month})`,
        `corp_card_pay:${st.id}:${paymentSeq}`,
      ],
    );
    if (txIns.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Kart ekstre ödemesi banka hareketi oluşturulamadı.");
    }
    const bankTxnId = txIns.rows[0].id;

    const upd = await client.query(
      `update public.corporate_card_statements
          set paid_amount = $2::numeric,
              pay_from_account_id = $3,
              is_settled = $4,
              updated_at = now()
        where id = $1`,
      [st.id, newPaidDec.toFixed(2), input.payFromAccountId, isNowSettled],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Kart ekstresi ödeme durumu güncellenemedi.");
    }

    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: effDate,
        sourceType: "bank_transaction",
        sourceId: bankTxnId,
        idempotencyKey: `corp_card_pay:${st.id}:${paymentSeq}`,
        description: `Kurumsal kredi kartı ekstre ödemesi (${st.statement_month})`,
        currency: st.currency,
        lines: [
          {
            accountCode: "309",
            debitNative: payDec.toFixed(2),
            memo: `Kurumsal kart borç kapanışı (${st.statement_month})`,
          },
          {
            accountCode: "102",
            creditNative: payDec.toFixed(2),
            memo: `Ödeme bankası: ${bankRes.rows[0].name}`,
          },
        ],
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "pay_corporate_card_statement",
      entityTable: "corporate_card_statements",
      entityId: st.id,
      before: { paid_amount: moneyOrNull(st.paid_amount), is_settled: st.is_settled },
      after: {
        paid_amount: money(newPaidDec),
        is_settled: isNowSettled,
        bankTxnId,
        journalEntryId: je.entryId,
      },
    });

    await client.query("commit");
    return { bankTxnId, journalEntryId: je.entryId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 6) Hazine Çalışma Alanı Okuma Modeli (`loadTreasuryWorkspaceOps`) ───────────────────── */

export interface TreasuryInterbankRow {
  id: string;
  transferDate: string;
  fromAccountName: string;
  toAccountName: string;
  fromAmount: number;
  fromCurrency: string;
  toAmount: number;
  toCurrency: string;
  fxRate: number;
  feeAmount: number;
  description: string | null;
}

export interface TreasuryTermDepositRow {
  id: string;
  cashAccountId: string;
  accountName: string;
  depositName: string;
  principalAmount: number;
  currency: string;
  annualInterestRate: number;
  withholdingTaxRate: number;
  startDate: string;
  maturityDate: string;
  expectedNetInterest: number;
  isActive: boolean;
}

export interface TreasuryPosBatchRow {
  id: string;
  cashAccountId: string;
  accountName: string;
  posTerminalLabel: string;
  saleDate: string;
  expectedValueDate: string;
  grossAmount: number;
  commissionRate: number;
  commissionAmount: number;
  netSettlementAmount: number;
  currency: string;
  isSettled: boolean;
}

export interface TreasuryCardStatementRow {
  id: string;
  cardAccountId: string;
  cardAccountName: string;
  payFromAccountName: string | null;
  statementMonth: string;
  cutoffDate: string;
  dueDate: string;
  statementAmount: number;
  minimumPaymentAmount: number | null;
  paidAmount: number;
  remainingAmount: number;
  currency: string;
  isSettled: boolean;
}

export async function loadTreasuryWorkspaceOps(pool: Pick<Pool, "query">): Promise<{
  transfers: TreasuryInterbankRow[];
  termDeposits: TreasuryTermDepositRow[];
  posBatches: TreasuryPosBatchRow[];
  cardStatements: TreasuryCardStatementRow[];
}> {
  const [trRes, tdRes, posRes, cardRes] = await Promise.all([
    pool
      .query(
        `select t.id::text as id,
                to_char(t.transfer_date, 'YYYY-MM-DD') as transfer_date,
                fa.name as from_account_name,
                ta.name as to_account_name,
                t.from_amount, t.from_currency,
                t.to_amount, t.to_currency,
                t.fx_rate, t.fee_amount, t.description
           from public.interbank_transfers t
           join public.cash_accounts fa on fa.id = t.from_account_id
           join public.cash_accounts ta on ta.id = t.to_account_id
          order by t.transfer_date desc, t.created_at desc
          limit 25`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `select td.id::text as id,
                td.cash_account_id::text as cash_account_id,
                ca.name as account_name,
                td.deposit_name,
                td.principal_amount, td.currency,
                td.annual_interest_rate, td.withholding_tax_rate,
                to_char(td.start_date, 'YYYY-MM-DD') as start_date,
                to_char(td.maturity_date, 'YYYY-MM-DD') as maturity_date,
                td.expected_net_interest, td.is_active
           from public.term_deposits td
           join public.cash_accounts ca on ca.id = td.cash_account_id
          order by td.is_active desc, td.maturity_date asc
          limit 40`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `select p.id::text as id,
                p.cash_account_id::text as cash_account_id,
                ca.name as account_name,
                p.pos_terminal_label,
                to_char(p.sale_date, 'YYYY-MM-DD') as sale_date,
                to_char(p.expected_value_date, 'YYYY-MM-DD') as expected_value_date,
                p.gross_amount, p.commission_rate, p.commission_amount,
                p.net_settlement_amount, p.currency, p.is_settled
           from public.pos_settlement_batches p
           join public.cash_accounts ca on ca.id = p.cash_account_id
          order by p.is_settled asc, p.expected_value_date asc
          limit 40`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `select c.id::text as id,
                c.card_account_id::text as card_account_id,
                ca.name as card_account_name,
                pa.name as pay_from_account_name,
                to_char(c.statement_month, 'YYYY-MM') as statement_month,
                to_char(c.cutoff_date, 'YYYY-MM-DD') as cutoff_date,
                to_char(c.due_date, 'YYYY-MM-DD') as due_date,
                c.statement_amount, c.minimum_payment_amount,
                c.paid_amount, c.currency, c.is_settled
           from public.corporate_card_statements c
           join public.cash_accounts ca on ca.id = c.card_account_id
           left join public.cash_accounts pa on pa.id = c.pay_from_account_id
          order by c.is_settled asc, c.due_date asc
          limit 40`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  return {
    transfers: trRes.rows.map((r) => ({
      id: r.id,
      transferDate: r.transfer_date,
      fromAccountName: r.from_account_name,
      toAccountName: r.to_account_name,
      fromAmount: moneyOrNull(r.from_amount) ?? 0,
      fromCurrency: r.from_currency,
      toAmount: moneyOrNull(r.to_amount) ?? 0,
      toCurrency: r.to_currency,
      fxRate: rateOrNull(r.fx_rate) ?? 1,
      feeAmount: moneyOrNull(r.fee_amount) ?? 0,
      description: r.description ?? null,
    })),
    termDeposits: tdRes.rows.map((r) => ({
      id: r.id,
      cashAccountId: r.cash_account_id,
      accountName: r.account_name,
      depositName: r.deposit_name,
      principalAmount: moneyOrNull(r.principal_amount) ?? 0,
      currency: r.currency,
      annualInterestRate: rateOrNull(r.annual_interest_rate) ?? 0,
      withholdingTaxRate: rateOrNull(r.withholding_tax_rate) ?? 0.075,
      startDate: r.start_date,
      maturityDate: r.maturity_date,
      expectedNetInterest: moneyOrNull(r.expected_net_interest) ?? 0,
      isActive: Boolean(r.is_active),
    })),
    posBatches: posRes.rows.map((r) => ({
      id: r.id,
      cashAccountId: r.cash_account_id,
      accountName: r.account_name,
      posTerminalLabel: r.pos_terminal_label,
      saleDate: r.sale_date,
      expectedValueDate: r.expected_value_date,
      grossAmount: moneyOrNull(r.gross_amount) ?? 0,
      commissionRate: rateOrNull(r.commission_rate) ?? 0,
      commissionAmount: moneyOrNull(r.commission_amount) ?? 0,
      netSettlementAmount: moneyOrNull(r.net_settlement_amount) ?? 0,
      currency: r.currency,
      isSettled: Boolean(r.is_settled),
    })),
    cardStatements: cardRes.rows.map((r) => {
      const stAmt = moneyOrNull(r.statement_amount) ?? 0;
      const paidAmt = moneyOrNull(r.paid_amount) ?? 0;
      return {
        id: r.id,
        cardAccountId: r.card_account_id,
        cardAccountName: r.card_account_name,
        payFromAccountName: r.pay_from_account_name ?? null,
        statementMonth: r.statement_month,
        cutoffDate: r.cutoff_date,
        dueDate: r.due_date,
        statementAmount: stAmt,
        minimumPaymentAmount: moneyOrNull(r.minimum_payment_amount),
        paidAmount: paidAmt,
        remainingAmount: Math.max(0, money(decimal(stAmt).minus(decimal(paidAmt)))),
        currency: r.currency,
        isSettled: Boolean(r.is_settled),
      };
    }),
  };
}
