// Faz 60 (M-30) — Canlı Döviz Pozisyonu (`live_fx_exposure_v`), Türev / Forward Hedge CRUD (`fx_positions`)
// ve Dönem Sonu VUK 280 Kur Değerleme (`646 Kambiyo Kârları / 656 Kambiyo Zararları`) Motoru.
//
// Sıfır kayan nokta: Tüm kur çarpım ve değerleme farkları `@/lib/money` (`decimal`, `round2`) ile yürütülür.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  postJournalEntryWithClient,
  resolveFxRateOrNull,
  revalueProvisionalJournalEntries,
  type JournalLineInput,
} from "@/lib/ledger/posting-engine";
import { decimal, money, moneyOrNull, rateOrNull, roundMoney as round2 } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(val: string | null | undefined): string | null {
  return val && UUID_RE.test(val) ? val : null;
}

export const FX_POSITION_KINDS = [
  "forward",
  "bank_balance",
  "receivable",
  "payable",
  "loan",
  "facility",
  "other",
] as const;
export type FxPositionKind = (typeof FX_POSITION_KINDS)[number];

export interface LiveFxExposureCurrencyRow {
  currency: string;
  totalAssetsNative: number;
  totalLiabilitiesNative: number;
  netPositionNative: number;
  cashBankNative: number;
  receivablesNative: number;
  checksReceivableNative: number;
  payablesNative: number;
  checksPayableNative: number;
  loanDebtNative: number;
  hedgeNative: number;
  spotRateToTry: number | null;
  rateDate: string | null;
  netPositionTry: number | null;
}

export interface FxPositionHedgeItem {
  id: string;
  currency: string;
  amount: number;
  positionKind: string;
  asOfDate: string;
  entryRate: number | null;
  counterpartyName: string | null;
  sourceNote: string | null;
  isActive: boolean;
  spotRate: number | null;
  unrealizedPnlTry: number | null;
}

export interface RecentRevaluationEntry {
  id: string;
  entryNo: number;
  entryDate: string;
  description: string;
  totalDebitTry: number;
}

export interface LiveFxWorkspace {
  liveRows: LiveFxExposureCurrencyRow[];
  totalNetPositionTry: number;
  missingRateCurrencies: string[];
  hedgePositions: FxPositionHedgeItem[];
  provisionalJournalCount: number;
  recentRevaluations: RecentRevaluationEntry[];
  bankCounterparties: Array<{ id: string; name: string }>;
}

export async function loadLiveFxExposureWorkspace(
  pool: Pick<Pool, "query">,
): Promise<LiveFxWorkspace> {
  const [viewRes, posRes, provRes, revalRes, banksRes] = await Promise.all([
    pool
      .query(
        `select currency,
                total_assets_native::text,
                total_liabilities_native::text,
                net_position_native::text,
                cash_bank_native::text,
                receivables_native::text,
                payables_native::text,
                checks_payable_native::text,
                loan_debt_native::text,
                hedge_native::text,
                spot_rate_to_try::text,
                to_char(rate_date, 'YYYY-MM-DD') as rate_date,
                net_position_try::text
           from public.live_fx_exposure_v
          order by currency asc`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `select fp.id::text as id,
                fp.currency,
                fp.amount::text,
                fp.position_kind,
                to_char(fp.as_of_date, 'YYYY-MM-DD') as as_of_date,
                fp.entry_rate::text,
                pa.name as counterparty_name,
                fp.source_note,
                fp.is_active
           from public.fx_positions fp
           left join public.parties pa on pa.id = fp.counterparty_party_id
          order by fp.is_active desc, fp.as_of_date desc, fp.created_at desc
          limit 50`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{ n: number }>(
        `select count(*)::int as n
           from public.management_journal_entries
          where status = 'provisional_fx'`,
      )
      .catch(() => ({ rows: [{ n: 0 }] })),
    pool
      .query(
        `select je.id::text as id,
                je.entry_no,
                to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
                je.description,
                coalesce(sum(jl.debit_try), 0)::text as total_debit_try
           from public.management_journal_entries je
           left join public.management_journal_lines jl on jl.entry_id = je.id
          where je.source_type = 'fx_revaluation'
            and je.status = 'posted'
          group by je.id
          order by je.entry_date desc, je.entry_no desc
          limit 15`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{ id: string; name: string }>(
        `select id::text as id, name
           from public.parties
          where is_active = true
            and archived_at is null
          order by case when party_type = 'bank' then 0 else 1 end, name asc
          limit 100`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  const spotByCurr = new Map<string, number>();
  let totalNetTryDec = decimal(0);
  const missingRateCurrencies: string[] = [];

  const liveRows: LiveFxExposureCurrencyRow[] = viewRes.rows.map((r) => {
    const totalAssets = moneyOrNull(r.total_assets_native) ?? 0;
    const cashBank = moneyOrNull(r.cash_bank_native) ?? 0;
    const receivables = moneyOrNull(r.receivables_native) ?? 0;
    const hedgeAmt = moneyOrNull(r.hedge_native) ?? 0;
    // Alacak çekleri = total_assets - cash_bank - receivables - pozitif hedge (yaklaşık ayrım)
    const checksRecEst = Math.max(
      0,
      money(decimal(totalAssets).minus(cashBank).minus(receivables).minus(hedgeAmt)),
    );
    const spot = rateOrNull(r.spot_rate_to_try);
    if (spot != null && spot > 0) {
      spotByCurr.set(r.currency, spot);
    } else {
      missingRateCurrencies.push(r.currency);
    }
    const netTry = moneyOrNull(r.net_position_try);
    if (netTry != null) {
      totalNetTryDec = totalNetTryDec.plus(decimal(netTry));
    }
    return {
      currency: r.currency,
      totalAssetsNative: totalAssets,
      totalLiabilitiesNative: moneyOrNull(r.total_liabilities_native) ?? 0,
      netPositionNative: moneyOrNull(r.net_position_native) ?? 0,
      cashBankNative: cashBank,
      receivablesNative: receivables,
      checksReceivableNative: checksRecEst,
      payablesNative: moneyOrNull(r.payables_native) ?? 0,
      checksPayableNative: moneyOrNull(r.checks_payable_native) ?? 0,
      loanDebtNative: moneyOrNull(r.loan_debt_native) ?? 0,
      hedgeNative: hedgeAmt,
      spotRateToTry: spot,
      rateDate: r.rate_date ?? null,
      netPositionTry: netTry,
    };
  });

  const hedgePositions: FxPositionHedgeItem[] = posRes.rows.map((p) => {
    const amt = moneyOrNull(p.amount) ?? 0;
    const entryRate = rateOrNull(p.entry_rate);
    const spot = spotByCurr.get(p.currency) ?? null;
    let unrealizedPnlTry: number | null = null;
    if (entryRate != null && spot != null) {
      unrealizedPnlTry = money(round2(decimal(amt).times(decimal(spot).minus(decimal(entryRate)))));
    }
    return {
      id: p.id,
      currency: p.currency,
      amount: amt,
      positionKind: p.position_kind,
      asOfDate: p.as_of_date,
      entryRate,
      counterpartyName: p.counterparty_name ?? null,
      sourceNote: p.source_note ?? null,
      isActive: Boolean(p.is_active),
      spotRate: spot,
      unrealizedPnlTry,
    };
  });

  return {
    liveRows,
    totalNetPositionTry: money(totalNetTryDec),
    missingRateCurrencies,
    hedgePositions,
    provisionalJournalCount: Number(provRes.rows[0]?.n ?? 0),
    recentRevaluations: revalRes.rows.map((e) => ({
      id: e.id,
      entryNo: Number(e.entry_no),
      entryDate: e.entry_date,
      description: e.description,
      totalDebitTry: moneyOrNull(e.total_debit_try) ?? 0,
    })),
    bankCounterparties: banksRes.rows,
  };
}

/* ── Forward / Opsiyon / Manuel Döviz Pozisyonu CRUD (`fx_positions`) ────────────────────── */

export const createFxPositionSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "3 harfli ISO döviz kodu giriniz (örn. USD, EUR).")
    .refine((c) => c !== "TRY", "Döviz pozisyonu TRY dışında bir yabancı para olmalıdır."),
  direction: z.enum(["long", "short"]).default("long"),
  amount: z.coerce.number().positive("Pozisyon büyüklüğü sıfırdan büyük olmalıdır."),
  instrumentSubtype: z.enum(["forward", "option", "swap", "manual"]).default("forward"),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Vade / kayıt tarihi YYYY-AA-GG olmalıdır."),
  entryRate: z.coerce.number().positive("Sözleşme / giriş kuru sıfırdan büyük olmalıdır.").nullable().optional(),
  counterpartyPartyId: z.uuid().nullable().optional(),
  sourceNote: z.string().trim().max(500).optional(),
});

export async function createFxPosition(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(createFxPositionSchema, raw, "Forward / hedge döviz pozisyonu");
  const signedAmountDec =
    input.direction === "short"
      ? round2(decimal(input.amount)).times(-1)
      : round2(decimal(input.amount));

  const positionKind: FxPositionKind =
    input.instrumentSubtype === "forward" ? "forward" : "other";
  const prefixLabel =
    input.instrumentSubtype === "option"
      ? "[OPSİYON] "
      : input.instrumentSubtype === "swap"
        ? "[SWAP] "
        : input.instrumentSubtype === "forward"
          ? "[FORWARD] "
          : "";
  const fullNote = `${prefixLabel}${input.sourceNote ?? ""}`.trim() || null;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.fx_positions
         (currency, amount, position_kind, as_of_date, entry_rate, counterparty_party_id,
          source_note, is_active, created_by)
       values ($1, $2::numeric, $3, $4::date, $5::numeric, $6, $7, true, $8)
       returning id::text as id`,
      [
        input.currency,
        signedAmountDec.toFixed(2),
        positionKind,
        input.asOfDate,
        input.entryRate != null ? decimal(input.entryRate).round(6).toFixed(6) : null,
        input.counterpartyPartyId ?? null,
        fullNote,
        uuidOrNull(actorId),
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Forward / döviz pozisyonu oluşturulamadı.");
    }
    const id = ins.rows[0].id;

    await audit(client, {
      actor: actorId,
      action: "create_fx_position",
      entityTable: "fx_positions",
      entityId: id,
      after: {
        currency: input.currency,
        signedAmount: money(signedAmountDec),
        positionKind,
        instrumentSubtype: input.instrumentSubtype,
        asOfDate: input.asOfDate,
        entryRate: input.entryRate ?? null,
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

export async function closeFxPosition(
  pool: Pool,
  positionId: string,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{ id: string; is_active: boolean; currency: string; amount: string }>(
      `select id::text as id, is_active, currency, amount::text
         from public.fx_positions
        where id = $1
        for update`,
      [positionId],
    );
    if (before.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Döviz pozisyonu bulunamadı.");
    }
    const upd = await client.query(
      `update public.fx_positions set is_active = false, updated_at = now() where id = $1`,
      [positionId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Döviz pozisyonu kapatılamadı.");
    }
    await audit(client, {
      actor: actorId,
      action: "close_fx_position",
      entityTable: "fx_positions",
      entityId: positionId,
      before: { is_active: before.rows[0].is_active },
      after: { is_active: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── Dönem Sonu VUK 280 Kur Değerleme (`646 Kambiyo Kârları / 656 Kambiyo Zararları`) ────── */

export const vuk280RevaluationSchema = z.object({
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Değerleme tarihi YYYY-AA-GG olmalıdır."),
});

export interface Vuk280RevaluationResult {
  asOfDate: string;
  revaluedProvisionalCount: number;
  journalEntryId: string | null;
  totalGainTry: number;
  totalLossTry: number;
  adjustedLinesCount: number;
  skippedMissingRateCurrencies: string[];
}

export async function runPeriodEndVuk280Revaluation(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<Vuk280RevaluationResult> {
  const input = parseOrThrow(vuk280RevaluationSchema, raw, "Dönem sonu VUK 280 kur değerleme");

  // 1) Önce eksik kurlu provisional_fx fişleri (kuru artık geldiyse) kesinleştir
  const provRes = await revalueProvisionalJournalEntries(pool, actorId);

  const client = await pool.connect();
  try {
    await client.query("begin");

    // 2) Parasal döviz hesaplarındaki (100, 101, 102, 120, 121, 128, 300, 301, 309, 320, 321)
    //    açık döviz bakiyelerini ve mevcut TL defter değerlerini (önceki VUK280 düzeltmeleri dahil) oku
    const monRes = await client.query<{
      account_code: string;
      ccy: string;
      net_native: string;
      book_net_try: string;
    }>(
      `with fx_ledger as (
         select ma.code as account_code,
                jl.native_currency as ccy,
                (jl.debit_native - jl.credit_native) as net_native,
                (coalesce(jl.debit_try, 0) - coalesce(jl.credit_try, 0)) as net_try
           from public.management_journal_lines jl
           join public.management_journal_entries je on je.id = jl.entry_id
           join public.management_accounts ma on ma.id = jl.account_id
          where je.status in ('posted', 'reversed')
            and je.entry_date <= $1::date
            and jl.native_currency <> 'TRY'
            and ma.tdhp_root_code in ('100','101','102','120','121','128','300','301','309','320','321')
         union all
         select ma.code as account_code,
                substring(jl.line_memo from '^\\[VUK280:([A-Z]{3})\\]') as ccy,
                0::numeric as net_native,
                (coalesce(jl.debit_try, 0) - coalesce(jl.credit_try, 0)) as net_try
           from public.management_journal_lines jl
           join public.management_journal_entries je on je.id = jl.entry_id
           join public.management_accounts ma on ma.id = jl.account_id
          where je.status in ('posted', 'reversed')
            and je.entry_date <= $1::date
            and je.source_type = 'fx_revaluation'
            and jl.line_memo ~ '^\\[VUK280:[A-Z]{3}\\]'
            and ma.tdhp_root_code in ('100','101','102','120','121','128','300','301','309','320','321')
       )
       select account_code,
              ccy,
              coalesce(sum(net_native), 0)::text as net_native,
              coalesce(sum(net_try), 0)::text as book_net_try
         from fx_ledger
        where ccy is not null
        group by account_code, ccy
        order by account_code, ccy`,
      [input.asOfDate],
    );

    const lines: JournalLineInput[] = [];
    let totalGainDec = decimal(0);
    let totalLossDec = decimal(0);
    const skippedMissing = new Set<string>();
    const rateCache = new Map<string, number | null>();

    for (const r of monRes.rows) {
      const netNat = round2(decimal(r.net_native));
      if (netNat.abs().lte("0.00")) continue;

      if (!rateCache.has(r.ccy)) {
        const rate = await resolveFxRateOrNull(client, r.ccy, input.asOfDate);
        rateCache.set(r.ccy, rate);
      }
      const spotRate = rateCache.get(r.ccy) ?? null;
      if (spotRate == null || spotRate <= 0) {
        skippedMissing.add(r.ccy);
        continue;
      }

      const targetTry = round2(netNat.times(spotRate));
      const bookTry = round2(decimal(r.book_net_try));
      const deltaTry = round2(targetTry.minus(bookTry));
      if (deltaTry.abs().lt("0.01")) continue;

      const tagMemo = `[VUK280:${r.ccy}] ${input.asOfDate} kur değerleme (${netNat.toFixed(2)} ${r.ccy} @ ${spotRate})`;
      if (deltaTry.gt(0)) {
        // Varlık arttı veya borç azaldı -> Borç İlgili Hesap / Alacak 646 Kambiyo Kârları
        lines.push({
          accountCode: r.account_code,
          lineCurrency: "TRY",
          debitNative: deltaTry.toFixed(2),
          fxRateOverride: 1,
          debitTryOverride: deltaTry.toFixed(2),
          memo: tagMemo,
        });
        totalGainDec = round2(totalGainDec.plus(deltaTry));
      } else {
        const absLoss = deltaTry.abs();
        // Varlık azaldı veya borç arttı -> Borç 656 Kambiyo Zararları / Alacak İlgili Hesap
        lines.push({
          accountCode: r.account_code,
          lineCurrency: "TRY",
          creditNative: absLoss.toFixed(2),
          fxRateOverride: 1,
          creditTryOverride: absLoss.toFixed(2),
          memo: tagMemo,
        });
        totalLossDec = round2(totalLossDec.plus(absLoss));
      }
    }

    if (lines.length === 0) {
      await client.query("commit");
      return {
        asOfDate: input.asOfDate,
        revaluedProvisionalCount: provRes.revaluedCount,
        journalEntryId: null,
        totalGainTry: 0,
        totalLossTry: 0,
        adjustedLinesCount: 0,
        skippedMissingRateCurrencies: [...skippedMissing],
      };
    }

    const adjustedLinesCount = lines.length;
    if (totalGainDec.gt(0)) {
      lines.push({
        accountCode: "646",
        lineCurrency: "TRY",
        creditNative: totalGainDec.toFixed(2),
        fxRateOverride: 1,
        creditTryOverride: totalGainDec.toFixed(2),
        memo: `VUK 280 dönem sonu kambiyo değerleme kârları (${input.asOfDate})`,
      });
    }
    if (totalLossDec.gt(0)) {
      lines.push({
        accountCode: "656",
        lineCurrency: "TRY",
        debitNative: totalLossDec.toFixed(2),
        fxRateOverride: 1,
        debitTryOverride: totalLossDec.toFixed(2),
        memo: `VUK 280 dönem sonu kambiyo değerleme zararları (${input.asOfDate})`,
      });
    }

    const runUid = globalThis.crypto.randomUUID().slice(0, 8);
    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: input.asOfDate,
        sourceType: "fx_revaluation",
        idempotencyKey: `vuk280_reval:${input.asOfDate}:${runUid}`,
        description: `VUK 280 Dönem Sonu Kur Değerleme Fişi (${input.asOfDate})`,
        currency: "TRY",
        fxRate: 1,
        lines,
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "run_vuk280_fx_revaluation",
      entityTable: "management_journal_entries",
      entityId: je.entryId,
      after: {
        asOfDate: input.asOfDate,
        revaluedProvisionalCount: provRes.revaluedCount,
        totalGainTry: money(totalGainDec),
        totalLossTry: money(totalLossDec),
        adjustedLinesCount,
      },
    });

    await client.query("commit");
    return {
      asOfDate: input.asOfDate,
      revaluedProvisionalCount: provRes.revaluedCount,
      journalEntryId: je.entryId,
      totalGainTry: money(totalGainDec),
      totalLossTry: money(totalLossDec),
      adjustedLinesCount,
      skippedMissingRateCurrencies: [...skippedMissing],
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
