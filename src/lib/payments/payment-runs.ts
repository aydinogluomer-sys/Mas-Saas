// Faz 48 (D2) — Payment Runs (Ödeme Çalıştırma Paketi) & 14-Day Minimum Cash Buffer Simulation.
//
// Invariants:
//   * Zero float math: all amounts & running balances use `@/lib/money` (`decimal()`, `money()`).
//   * FIN-03 null-aware: if `treasury_position_summary.unknown_opening_count > 0`, `preRunCash` and
//     `projected14dMinCash` stay `null` rather than fabricating a `0` opening balance.
//   * Live Maker-Checker: unapproved/rejected targets (`approval_status in ('pending_approval','rejected')`)
//     cannot enter a payment run; the run itself must move `draft -> pending_approval -> approved`
//     via a second pair of eyes (`approved_by <> created_by`, `approver+` tier) before export.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { requestApprovalWithClient } from "@/lib/approvals/engine";
import { audit } from "@/lib/audit";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, money, moneyOrNull } from "@/lib/money";
import { bufferDaysFloor, effectiveFloor } from "@/lib/treasury/rules";
import { parseOrThrow } from "@/lib/validation";

export const PAYMENT_RUN_TARGET_TYPES = [
  "invoice",
  "payment_instance",
  "check",
  "loan_installment",
] as const;

export type PaymentRunTargetType = (typeof PAYMENT_RUN_TARGET_TYPES)[number];

export const paymentRunItemSelectionSchema = z.object({
  targetType: z.enum(PAYMENT_RUN_TARGET_TYPES),
  targetId: z.uuid(),
  ibanId: z.uuid().optional(),
  beneficiaryIban: z.string().trim().min(5).optional(),
  beneficiaryName: z.string().trim().min(1).optional(),
  amount: z.coerce.number().positive("Ödeme tutarı sıfırdan büyük olmalı").optional(),
  description: z.string().trim().min(1).max(240).optional(),
});

export const createPaymentRunSchema = z.object({
  sourceBankAccountId: z.uuid(),
  plannedExecutionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Planlanan ödeme tarihi YYYY-AA-GG olmalı"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(paymentRunItemSelectionSchema).min(1, "Ödeme paketinde en az bir kalem bulunmalı"),
});

export const submitPaymentRunSchema = z.object({
  runId: z.uuid(),
  note: z.string().trim().min(1).max(500).optional(),
});

export const cancelPaymentRunSchema = z.object({
  runId: z.uuid(),
  reason: z.string().trim().min(3, "İptal gerekçesi en az 3 karakter olmalı").max(500),
});

export interface Liquidity14dSimulation {
  currency: string;
  todayISO: string;
  plannedExecutionDate: string;
  runTotal: number;
  preRunCash: number | null;
  postRunImmediateCash: number | null;
  projected14dMinCash: number | null;
  minCashFloor: number | null;
  breachesCashFloor: boolean;
  unknownOpeningBalance: boolean;
}

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

function addDaysISO(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function resolveFloorWithClient(
  client: Pick<PoolClient, "query">,
  currency: string,
  todayISO: string,
): Promise<number | null> {
  const policies = await client.query(
    `select policy_kind, threshold_amount, threshold_days
       from public.treasury_policies
      where is_active and currency=$1 and cash_account_id is null`,
    [currency],
  );
  const minCash = moneyOrNull(policies.rows.find((p) => p.policy_kind === "min_cash")?.threshold_amount);
  const days = intOrNull(policies.rows.find((p) => p.policy_kind === "buffer_days")?.threshold_days);

  let bufferFloor: number | null = null;
  if (days != null) {
    const outRes = await client.query(
      `select coalesce(abs(sum(bt.amount) filter (where bt.amount < 0)), 0) as total_out_90d
         from public.bank_transactions bt
         join public.bank_accounts ba on ba.cash_account_id = bt.bank_account_id
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where bt.status <> 'ignored' and ca.currency = $1
          and bt.txn_date >= ($2::date - 90) and bt.txn_date < $2::date`,
      [currency, todayISO],
    );
    const totalOut90d = decimal(outRes.rows[0]?.total_out_90d ?? 0).abs();
    const avgDailyOut = totalOut90d.eq(0) ? 0 : totalOut90d.div(90).toString();
    bufferFloor = bufferDaysFloor(avgDailyOut, days);
  }
  return effectiveFloor(minCash, bufferFloor);
}

/**
 * Simulates the 14-day cash trajectory if `runTotal` executes on `plannedExecutionDate`,
 * deduplicating any selected obligations that already appear in `public.liquidity_forecast_daily`.
 */
export async function simulatePaymentRun14dLiquidity(
  client: Pick<PoolClient, "query">,
  params: {
    plannedExecutionDate: string;
    runTotal: number | string;
    currency: string;
    todayISO: string;
    selectedTargets?: ReadonlyArray<{ targetType: PaymentRunTargetType; targetId: string }>;
  },
): Promise<Liquidity14dSimulation> {
  const { currency, todayISO, plannedExecutionDate } = params;
  const runTotalDec = decimal(params.runTotal);
  const runTotalNum = money(runTotalDec.toString());

  const posRes = await client
    .query<{
      available_now: string | null;
      unknown_opening_count: string | number;
    }>(
      `select available_now, unknown_opening_count
         from public.treasury_position_summary
        where currency = $1`,
      [currency],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return client
          .query<{
            available_now: string | null;
            unknown_opening_count: string | number;
          }>(
            `select available_now, 0::int as unknown_opening_count
               from public.treasury_position_summary
              where currency = $1`,
            [currency],
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return { rows: [], rowCount: 0 };
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const minCashFloor = await resolveFloorWithClient(client, currency, todayISO);
  const posRow = posRes.rows[0];
  const unknownOpeningCount = posRes.rowCount === 0 ? 0 : Number(posRow?.unknown_opening_count ?? 0);

  if (unknownOpeningCount > 0) {
    return {
      currency,
      todayISO,
      plannedExecutionDate,
      runTotal: runTotalNum,
      preRunCash: null,
      postRunImmediateCash: null,
      projected14dMinCash: null,
      minCashFloor,
      breachesCashFloor: false,
      unknownOpeningBalance: true,
    };
  }

  const preRunCashNum = posRes.rowCount === 0 ? 0 : (moneyOrNull(posRow?.available_now) ?? 0);
  const preRunDec = decimal(preRunCashNum);
  const postRunImmediateDec = preRunDec.minus(runTotalDec);

  const windowEndExclusive = addDaysISO(todayISO, 14);
  const effectiveExecDate = plannedExecutionDate < todayISO ? todayISO : plannedExecutionDate;
  const horizonEndExclusive =
    effectiveExecDate >= windowEndExclusive ? addDaysISO(effectiveExecDate, 1) : windowEndExclusive;

  const flowRes = await client
    .query<{
      flow_date: string;
      source_kind: string;
      source_id: string;
      amount_signed: string;
    }>(
      `select to_char(flow_date,'YYYY-MM-DD') as flow_date,
              source_kind,
              source_id::text as source_id,
              amount_signed::text as amount_signed
         from public.liquidity_forecast_daily
        where currency = $1
          and flow_date >= $2::date
          and flow_date < $3::date`,
      [currency, todayISO, horizonEndExclusive],
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const selectedSet = new Set(
    (params.selectedTargets ?? []).map((t) => `${t.targetType}:${t.targetId}`),
  );

  const netByDay = new Map<string, ReturnType<typeof decimal>>();
  for (const row of flowRes.rows) {
    if (selectedSet.has(`${row.source_kind}:${row.source_id}`)) {
      continue;
    }
    const prev = netByDay.get(row.flow_date) ?? decimal(0);
    netByDay.set(row.flow_date, prev.plus(decimal(row.amount_signed)));
  }

  const prevExec = netByDay.get(effectiveExecDate) ?? decimal(0);
  netByDay.set(effectiveExecDate, prevExec.minus(runTotalDec));

  let running = preRunDec;
  let minRunning: ReturnType<typeof decimal> | null = null;
  let cursor = todayISO;
  while (cursor < horizonEndExclusive) {
    const delta = netByDay.get(cursor);
    if (delta) {
      running = running.plus(delta);
    }
    if (minRunning === null || running.lt(minRunning)) {
      minRunning = running;
    }
    cursor = addDaysISO(cursor, 1);
  }

  const projectedMinDec = minRunning ?? postRunImmediateDec;
  const floorDec = minCashFloor != null ? decimal(minCashFloor) : decimal(0);
  const breachesCashFloor = projectedMinDec.lt(floorDec) || postRunImmediateDec.lt(floorDec);

  return {
    currency,
    todayISO,
    plannedExecutionDate,
    runTotal: runTotalNum,
    preRunCash: preRunCashNum,
    postRunImmediateCash: money(postRunImmediateDec.toString()),
    projected14dMinCash: money(projectedMinDec.toString()),
    minCashFloor,
    breachesCashFloor,
    unknownOpeningBalance: false,
  };
}

export interface PayableRunCandidate {
  targetType: PaymentRunTargetType;
  targetId: string;
  referenceLabel: string;
  partyId: string | null;
  partyName: string;
  ibanId: string | null;
  beneficiaryIban: string | null;
  ibanApprovalStatus: string | null;
  ibanVerified: boolean;
  openAmount: number;
  currency: string;
  dueDate: string | null;
  approvalStatus: string;
  eligibleForRun: boolean;
  blockReason: string | null;
}

/**
 * Lists open outbound obligations (purchase invoices, outflow payment instances, outflow checks,
 * loan installments) not currently locked in another active (`included`) payment run.
 */
export async function loadPayableRunCandidates(
  pool: Pick<Pool, "query">,
  currency = "TRY",
  limit = 80,
): Promise<PayableRunCandidate[]> {
  const r = await pool.query<{
    target_type: PaymentRunTargetType;
    target_id: string;
    reference_label: string;
    party_id: string | null;
    party_name: string;
    open_amount: string;
    currency: string;
    due_date: string | null;
    approval_status: string;
    iban_id: string | null;
    iban_normalized: string | null;
    iban_approval_status: string | null;
  }>(
    `with raw_targets as (
       select 'invoice'::text as target_type,
              inv.id as target_id,
              ('Fatura ' || inv.invoice_no) as reference_label,
              inv.party_id as party_id,
              pa.name as party_name,
              greatest(0, coalesce(inv.payable_amount, inv.gross_amount) - greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0))) as open_amount,
              inv.currency as currency,
              coalesce(inv.due_date, inv.issue_date) as due_date,
              inv.approval_status as approval_status
         from public.invoices inv
         join public.parties pa on pa.id = inv.party_id
        where inv.direction = 'purchase'
          and inv.status in ('open', 'partial')
          and coalesce(inv.payable_amount, inv.gross_amount) > greatest(coalesce(inv.paid_amount, 0), coalesce(inv.allocated_amount, 0))
          and inv.currency = $1

       union all

       select 'payment_instance'::text as target_type,
              pi.id as target_id,
              coalesce(p.name, 'Ödeme kalemi') as reference_label,
              p.provider_party_id as party_id,
              coalesce(pa.name, p.name, 'Belirtilmemiş Alacaklı') as party_name,
              (pi.amount - coalesce(pi.paid_amount, 0)) as open_amount,
              pi.currency as currency,
              pi.due_date as due_date,
              pi.approval_status as approval_status
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
         left join public.parties pa on pa.id = p.provider_party_id
        where coalesce(pi.direction, p.direction, 'outflow') = 'outflow'
          and pi.status in ('unpaid', 'partial', 'planned', 'late')
          and (p.id is null or (p.status = 'active' and p.archived_at is null))
          and pi.amount is not null
          and pi.amount > coalesce(pi.paid_amount, 0)
          and pi.currency = $1

       union all

       select 'check'::text as target_type,
              c.id as target_id,
              coalesce('Çek ' || c.serial_no, 'Verilen Çek') as reference_label,
              c.payee_party_id as party_id,
              coalesce(pa.name, c.counterparty_label, 'Çek Alacaklısı') as party_name,
              c.amount as open_amount,
              c.currency as currency,
              c.maturity_date as due_date,
              'not_required'::text as approval_status
         from public.checks c
         left join public.parties pa on pa.id = c.payee_party_id
        where c.direction = 'outflow'
          and c.status in ('planned', 'issued_to_vendor')
          and c.archived_at is null
          and c.amount is not null
          and c.amount > 0
          and c.currency = $1

       union all

       select 'loan_installment'::text as target_type,
              li.id as target_id,
              (l.name || ' #' || li.installment_no::text) as reference_label,
              l.lender_party_id as party_id,
              coalesce(pa.name, l.name) as party_name,
              li.amount as open_amount,
              l.currency as currency,
              li.due_date as due_date,
              'not_required'::text as approval_status
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         left join public.parties pa on pa.id = l.lender_party_id
        where li.status in ('planned', 'late')
          and l.archived_at is null
          and li.amount is not null
          and li.amount > 0
          and l.currency = $1
     )
     select rt.target_type,
            rt.target_id::text as target_id,
            rt.reference_label,
            rt.party_id::text as party_id,
            rt.party_name,
            rt.open_amount::text as open_amount,
            rt.currency,
            to_char(rt.due_date, 'YYYY-MM-DD') as due_date,
            rt.approval_status,
            ib.id::text as iban_id,
            ib.iban_normalized,
            ib.approval_status as iban_approval_status
       from raw_targets rt
       left join lateral (
         select i.id, i.iban_normalized, i.approval_status
           from public.ibans i
          where i.party_id = rt.party_id
            and i.is_active = true
            and i.currency = rt.currency
          order by i.is_primary desc, (i.approval_status = 'approved') desc, i.created_at asc
          limit 1
       ) ib on true
      where not exists (
        select 1
          from public.payment_run_items pri
         where pri.target_type = rt.target_type
           and pri.target_id = rt.target_id
           and pri.status = 'included'
      )
      order by (rt.due_date is null), rt.due_date asc, rt.open_amount desc
      limit $2`,
    [currency, limit],
  ).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });

  return r.rows.map((x) => {
    const ibanNorm = x.iban_normalized;
    const ibanChecksumOk = ibanNorm != null && isTurkishIban(ibanNorm) && isValidIbanChecksum(ibanNorm);
    const ibanVerified = ibanChecksumOk && x.iban_approval_status === "approved";

    let blockReason: string | null = null;
    if (x.approval_status === "pending_approval") {
      blockReason = "Kalem maker-checker onayı bekliyor";
    } else if (x.approval_status === "rejected") {
      blockReason = "Kalem onayı reddedildi";
    } else if (!ibanNorm) {
      blockReason = "Aktif IBAN tanımlı değil";
    }

    return {
      targetType: x.target_type,
      targetId: x.target_id,
      referenceLabel: x.reference_label,
      partyId: x.party_id,
      partyName: x.party_name,
      ibanId: x.iban_id,
      beneficiaryIban: ibanNorm,
      ibanApprovalStatus: x.iban_approval_status,
      ibanVerified,
      openAmount: moneyOrNull(x.open_amount) ?? 0,
      currency: x.currency,
      dueDate: x.due_date,
      approvalStatus: x.approval_status,
      eligibleForRun: blockReason === null,
      blockReason,
    };
  });
}

interface ResolvedTargetRow {
  targetType: PaymentRunTargetType;
  targetId: string;
  partyId: string | null;
  ibanId: string | null;
  beneficiaryName: string;
  beneficiaryIban: string;
  amountStr: string;
  currency: string;
  dueDate: string | null;
  description: string;
  ibanVerified: boolean;
}

async function resolveAndValidateTarget(
  client: PoolClient,
  item: z.infer<typeof paymentRunItemSelectionSchema>,
  expectedCurrency: string,
): Promise<ResolvedTargetRow> {
  let partyId: string | null = null;
  let defaultBeneficiary = "";
  let maxOpenDec = decimal(0);
  let targetCurrency = expectedCurrency;
  let dueDate: string | null = null;
  let defaultDesc = "";
  let approvalStatus = "not_required";

  if (item.targetType === "invoice") {
    const r = await client.query<{
      direction: string;
      status: string;
      invoice_no: string;
      party_id: string;
      party_name: string;
      currency: string;
      open_amount: string;
      due_date: string | null;
      approval_status: string;
    }>(
      `select i.direction, i.status, i.invoice_no, i.party_id::text, pa.name as party_name,
              i.currency,
              greatest(0, coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)))::text as open_amount,
              to_char(coalesce(i.due_date, i.issue_date), 'YYYY-MM-DD') as due_date,
              i.approval_status
         from public.invoices i
         join public.parties pa on pa.id = i.party_id
        where i.id = $1
        for update of i`,
      [item.targetId],
    );
    if (r.rowCount === 0) throw new DomainError("NOT_FOUND", `Fatura bulunamadı (${item.targetId}).`);
    const row = r.rows[0];
    if (row.direction !== "purchase") {
      throw new DomainError("CONFLICT", `Satış faturası (${row.invoice_no}) ödeme paketine eklenemez.`);
    }
    if (!["open", "partial"].includes(row.status)) {
      throw new DomainError("CONFLICT", `Fatura ${row.invoice_no} '${row.status}' durumunda; ödeme paketine alınamaz.`);
    }
    partyId = row.party_id;
    defaultBeneficiary = row.party_name;
    maxOpenDec = decimal(row.open_amount);
    targetCurrency = row.currency;
    dueDate = row.due_date;
    defaultDesc = `Fatura ${row.invoice_no} ödemesi`;
    approvalStatus = row.approval_status;
  } else if (item.targetType === "payment_instance") {
    const r = await client.query<{
      status: string;
      direction: string;
      currency: string;
      open_amount: string | null;
      due_date: string | null;
      approval_status: string;
      party_id: string | null;
      party_name: string;
      payment_name: string;
    }>(
      `select pi.status,
              coalesce(pi.direction, p.direction, 'outflow') as direction,
              pi.currency,
              case when pi.amount is null then null else (pi.amount - coalesce(pi.paid_amount, 0))::text end as open_amount,
              to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
              pi.approval_status,
              p.provider_party_id::text as party_id,
              coalesce(pa.name, p.name, 'Alacaklı') as party_name,
              coalesce(p.name, 'Ödeme kalemi') as payment_name
         from public.payment_instances pi
         left join public.payments p on p.id = pi.payment_id
         left join public.parties pa on pa.id = p.provider_party_id
        where pi.id = $1
        for update of pi`,
      [item.targetId],
    );
    if (r.rowCount === 0) throw new DomainError("NOT_FOUND", `Ödeme kalemi bulunamadı (${item.targetId}).`);
    const row = r.rows[0];
    if (row.direction !== "outflow") {
      throw new DomainError("CONFLICT", "Yalnız çıkış (outflow) yönlü ödeme kalemleri ödeme paketine eklenebilir.");
    }
    if (!["unpaid", "partial", "planned", "late"].includes(row.status)) {
      throw new DomainError("CONFLICT", `'${row.status}' durumundaki ödeme kalemi ödeme paketine eklenemez.`);
    }
    if (row.open_amount == null) {
      throw new DomainError("CONFLICT", "Tutarı bilinmeyen ödeme kalemi ödeme paketine eklenemez.");
    }
    partyId = row.party_id;
    defaultBeneficiary = row.party_name;
    maxOpenDec = decimal(row.open_amount);
    targetCurrency = row.currency;
    dueDate = row.due_date;
    defaultDesc = `${row.payment_name}${row.due_date ? ` (${row.due_date})` : ""}`;
    approvalStatus = row.approval_status;
  } else if (item.targetType === "check") {
    const r = await client.query<{
      direction: string;
      status: string;
      currency: string;
      amount: string | null;
      due_date: string | null;
      party_id: string | null;
      party_name: string;
      serial_no: string | null;
    }>(
      `select c.direction, c.status, c.currency, c.amount::text as amount,
              to_char(c.maturity_date, 'YYYY-MM-DD') as due_date,
              c.payee_party_id::text as party_id,
              coalesce(pa.name, c.counterparty_label, 'Çek Alacaklısı') as party_name,
              c.serial_no
         from public.checks c
         left join public.parties pa on pa.id = c.payee_party_id
        where c.id = $1 and c.archived_at is null
        for update of c`,
      [item.targetId],
    );
    if (r.rowCount === 0) throw new DomainError("NOT_FOUND", `Çek bulunamadı (${item.targetId}).`);
    const row = r.rows[0];
    if (row.direction !== "outflow" || !["planned", "issued_to_vendor"].includes(row.status)) {
      throw new DomainError("CONFLICT", "Yalnız 'planned' veya 'issued_to_vendor' durumundaki verilen (outflow) çekler ödeme paketine alınabilir.");
    }
    if (row.amount == null) {
      throw new DomainError("CONFLICT", "Tutarı bilinmeyen çek ödeme paketine alınamaz.");
    }
    partyId = row.party_id;
    defaultBeneficiary = row.party_name;
    maxOpenDec = decimal(row.amount);
    targetCurrency = row.currency;
    dueDate = row.due_date;
    defaultDesc = row.serial_no ? `Çek ${row.serial_no} ödemesi` : "Verilen çek ödemesi";
  } else {
    const r = await client.query<{
      status: string;
      currency: string;
      open_amount: string | null;
      due_date: string | null;
      party_id: string | null;
      party_name: string;
      loan_name: string;
      installment_no: number;
    }>(
      `select li.status, l.currency,
              li.amount::text as open_amount,
              to_char(li.due_date, 'YYYY-MM-DD') as due_date,
              l.lender_party_id::text as party_id,
              coalesce(pa.name, l.name) as party_name,
              l.name as loan_name,
              li.installment_no
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         left join public.parties pa on pa.id = l.lender_party_id
        where li.id = $1 and l.archived_at is null
        for update of li`,
      [item.targetId],
    );
    if (r.rowCount === 0) throw new DomainError("NOT_FOUND", `Kredi taksiti bulunamadı (${item.targetId}).`);
    const row = r.rows[0];
    if (!["planned", "late"].includes(row.status)) {
      throw new DomainError("CONFLICT", `'${row.status}' durumundaki kredi taksiti ödeme paketine alınamaz.`);
    }
    if (row.open_amount == null) {
      throw new DomainError("CONFLICT", "Tutarı bilinmeyen kredi taksiti ödeme paketine alınamaz.");
    }
    partyId = row.party_id;
    defaultBeneficiary = row.party_name;
    maxOpenDec = decimal(row.open_amount);
    targetCurrency = row.currency;
    dueDate = row.due_date;
    defaultDesc = `${row.loan_name} Taksit #${row.installment_no}`;
  }

  if (["pending_approval", "rejected"].includes(approvalStatus)) {
    throw new DomainError(
      "FORBIDDEN",
      `Seçilen kalem (${defaultDesc}) ikinci onay (maker-checker) bekliyor veya reddedildi; onaylanmadan ödeme paketine eklenemez.`,
    );
  }
  if (targetCurrency !== expectedCurrency) {
    throw new DomainError(
      "CONFLICT",
      `Döviz uyumsuzluğu: paket ${expectedCurrency}, kalem (${defaultDesc}) ${targetCurrency}. Farklı dövizler tek pakette karıştırılamaz.`,
    );
  }
  if (maxOpenDec.lte(0)) {
    throw new DomainError("CONFLICT", `Kalemin (${defaultDesc}) açık tutarı kalmamış.`);
  }

  const chosenDec = item.amount != null ? decimal(item.amount) : maxOpenDec;
  if (chosenDec.lte(0) || chosenDec.gt(maxOpenDec)) {
    throw new DomainError(
      "CONFLICT",
      `Kalem (${defaultDesc}) ödeme tutarı açık bakiyeyi (${maxOpenDec.toFixed(2)} ${expectedCurrency}) aşamaz.`,
    );
  }
  if ((item.targetType === "check" || item.targetType === "loan_installment") && !chosenDec.eq(maxOpenDec)) {
    throw new DomainError(
      "CONFLICT",
      `Çek ve kredi taksitleri ödeme paketinde tam tutarıyla (${maxOpenDec.toFixed(2)} ${expectedCurrency}) kapatılmalıdır.`,
    );
  }

  // Duplicate active inclusion check (readable error before unique index fires)
  const dupActive = await client.query<{ run_code: string }>(
    `select pr.run_code
       from public.payment_run_items pri
       join public.payment_runs pr on pr.id = pri.run_id
      where pri.target_type = $1
        and pri.target_id = $2
        and pri.status = 'included'
      limit 1`,
    [item.targetType, item.targetId],
  );
  if ((dupActive.rowCount ?? 0) > 0) {
    throw new DomainError(
      "CONFLICT",
      `Kalem (${defaultDesc}) zaten aktif bir ödeme paketinde (${dupActive.rows[0].run_code}) yer alıyor.`,
    );
  }

  // Resolve IBAN + BEC verification flag
  let ibanId: string | null = item.ibanId ?? null;
  let beneficiaryIban = item.beneficiaryIban ? normalizeIban(item.beneficiaryIban) : "";
  let ibanApprovedInDirectory = false;

  if (ibanId) {
    const ib = await client.query<{
      id: string;
      party_id: string;
      iban_normalized: string;
      is_active: boolean;
      approval_status: string;
    }>(
      `select id::text, party_id::text, iban_normalized, is_active, approval_status
         from public.ibans where id = $1`,
      [ibanId],
    );
    if (ib.rowCount === 0) throw new DomainError("NOT_FOUND", "Seçilen IBAN kaydı bulunamadı.");
    const ibRow = ib.rows[0];
    if (!ibRow.is_active) throw new DomainError("CONFLICT", "Pasif IBAN ödeme paketinde kullanılamaz.");
    if (partyId && ibRow.party_id !== partyId) {
      throw new DomainError("CONFLICT", "Seçilen IBAN kalemin karşı tarafına ait değil (BEC koruması).");
    }
    beneficiaryIban = ibRow.iban_normalized;
    ibanApprovedInDirectory = ibRow.approval_status === "approved";
  } else if (partyId) {
    if (beneficiaryIban) {
      const ib = await client.query<{ id: string; is_active: boolean; approval_status: string }>(
        `select id::text, is_active, approval_status
           from public.ibans
          where party_id = $1 and iban_normalized = $2
          limit 1`,
        [partyId, beneficiaryIban],
      );
      if ((ib.rowCount ?? 0) > 0) {
        if (!ib.rows[0].is_active) {
          throw new DomainError("CONFLICT", "Pasif IBAN ödeme paketinde kullanılamaz.");
        }
        ibanId = ib.rows[0].id;
        ibanApprovedInDirectory = ib.rows[0].approval_status === "approved";
      }
    } else {
      const ib = await client.query<{
        id: string;
        iban_normalized: string;
        approval_status: string;
      }>(
        `select id::text, iban_normalized, approval_status
           from public.ibans
          where party_id = $1 and is_active = true and currency = $2
          order by is_primary desc, (approval_status = 'approved') desc, created_at asc
          limit 1`,
        [partyId, expectedCurrency],
      );
      if ((ib.rowCount ?? 0) > 0) {
        ibanId = ib.rows[0].id;
        beneficiaryIban = ib.rows[0].iban_normalized;
        ibanApprovedInDirectory = ib.rows[0].approval_status === "approved";
      }
    }
  }

  if (!beneficiaryIban) {
    throw new DomainError(
      "CONFLICT",
      `Kalem (${defaultDesc}) için alacaklı IBAN bulunamadı — önce karşı tarafa aktif bir IBAN ekleyin.`,
    );
  }

  const validTrChecksum = isTurkishIban(beneficiaryIban) && isValidIbanChecksum(beneficiaryIban);
  // BEC Fraud Shield: if linked to a party or IBAN directory row, the IBAN MUST exist in `public.ibans`
  // with `approval_status = 'approved'` AND pass TR 26-char MOD-97 checksum to be `iban_verified = true`.
  const ibanVerified = validTrChecksum && ibanId !== null && ibanApprovedInDirectory;

  return {
    targetType: item.targetType,
    targetId: item.targetId,
    partyId,
    ibanId,
    beneficiaryName: (item.beneficiaryName ?? defaultBeneficiary).trim(),
    beneficiaryIban,
    amountStr: chosenDec.toFixed(2),
    currency: expectedCurrency,
    dueDate,
    description: (item.description ?? defaultDesc).trim(),
    ibanVerified,
  };
}

function buildRunCode(plannedDate: string): string {
  const compactDate = plannedDate.replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PR-${compactDate}-${suffix}`;
}

export interface CreatePaymentRunResult {
  runId: string;
  runCode: string;
  totalAmount: number;
  itemCount: number;
  unverifiedIbanCount: number;
  simulation: Liquidity14dSimulation;
}

export async function createPaymentRun(
  pool: Pool,
  raw: unknown,
  actorId: string,
  todayISO: string,
): Promise<CreatePaymentRunResult> {
  const input = parseOrThrow(createPaymentRunSchema, raw, "Ödeme çalıştırma paketi");
  const seenKeys = new Set<string>();
  for (const it of input.items) {
    const key = `${it.targetType}:${it.targetId}`;
    if (seenKeys.has(key)) {
      throw new DomainError("CONFLICT", `Aynı kalem (${key}) tek pakete iki kez eklenemez.`);
    }
    seenKeys.add(key);
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const acct = await client.query<{
      cash_account_id: string;
      account_name: string;
      currency: string;
      is_active: boolean;
      iban_normalized: string | null;
    }>(
      `select ba.cash_account_id::text, ca.name as account_name, ca.currency, ca.is_active, ba.iban_normalized
         from public.bank_accounts ba
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where ba.cash_account_id = $1`,
      [input.sourceBankAccountId],
    );
    if (acct.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Kaynak banka hesabı bulunamadı — önce Banka Merkezi'nde IBAN profili tanımlayın.");
    }
    const sourceAcct = acct.rows[0];
    if (!sourceAcct.is_active) {
      throw new DomainError("CONFLICT", "Pasif banka hesabından ödeme paketi oluşturulamaz.");
    }
    if (sourceAcct.currency !== input.currency) {
      throw new DomainError(
        "CONFLICT",
        `Kaynak banka hesabı dövizi (${sourceAcct.currency}) ile paket dövizi (${input.currency}) eşleşmiyor.`,
      );
    }

    const resolvedItems: ResolvedTargetRow[] = [];
    let totalDec = decimal(0);
    for (const item of input.items) {
      const resolved = await resolveAndValidateTarget(client, item, input.currency);
      resolvedItems.push(resolved);
      totalDec = totalDec.plus(decimal(resolved.amountStr));
    }

    const simulation = await simulatePaymentRun14dLiquidity(client, {
      plannedExecutionDate: input.plannedExecutionDate,
      runTotal: totalDec.toFixed(2),
      currency: input.currency,
      todayISO,
      selectedTargets: resolvedItems.map((r) => ({ targetType: r.targetType, targetId: r.targetId })),
    });

    const runCode = buildRunCode(input.plannedExecutionDate);
    const insRun = await client.query<{ id: string }>(
      `insert into public.payment_runs
         (run_code, planned_execution_date, source_bank_account_id, currency,
          total_amount, item_count, pre_run_cash, projected_14d_min_cash,
          min_cash_floor, breaches_cash_floor, status, created_by, notes)
       values ($1, $2::date, $3, $4, $5::numeric, $6, $7::numeric, $8::numeric, $9::numeric, $10, 'draft', $11, $12)
       returning id`,
      [
        runCode,
        input.plannedExecutionDate,
        input.sourceBankAccountId,
        input.currency,
        totalDec.toFixed(2),
        resolvedItems.length,
        simulation.preRunCash,
        simulation.projected14dMinCash,
        simulation.minCashFloor,
        simulation.breachesCashFloor,
        actorId,
        input.notes ?? null,
      ],
    );
    const runId = insRun.rows[0].id;

    for (const item of resolvedItems) {
      await client.query(
        `insert into public.payment_run_items
           (run_id, target_type, target_id, party_id, iban_id, beneficiary_name,
            beneficiary_iban, amount, currency, due_date, description, iban_verified, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10::date, $11, $12, 'included')`,
        [
          runId,
          item.targetType,
          item.targetId,
          item.partyId,
          item.ibanId,
          item.beneficiaryName,
          item.beneficiaryIban,
          item.amountStr,
          item.currency,
          item.dueDate,
          item.description,
          item.ibanVerified,
        ],
      );
    }

    const unverifiedIbanCount = resolvedItems.filter((r) => !r.ibanVerified).length;
    const totalAmount = money(totalDec.toString());

    await audit(client, {
      actor: actorId,
      action: "create_payment_run",
      entityTable: "payment_runs",
      entityId: runId,
      before: null,
      after: {
        runCode,
        plannedExecutionDate: input.plannedExecutionDate,
        sourceBankAccountId: input.sourceBankAccountId,
        currency: input.currency,
        totalAmount,
        itemCount: resolvedItems.length,
        unverifiedIbanCount,
        breachesCashFloor: simulation.breachesCashFloor,
        projected14dMinCash: simulation.projected14dMinCash,
        minCashFloor: simulation.minCashFloor,
      },
    });

    await client.query("commit");
    return {
      runId,
      runCode,
      totalAmount,
      itemCount: resolvedItems.length,
      unverifiedIbanCount,
      simulation,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Transitions a `draft` payment run into `pending_approval` and opens a maker-checker `approvals`
 * round in the same transaction.
 */
export async function submitPaymentRunForApproval(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ approvalId: string }> {
  const input = parseOrThrow(submitPaymentRunSchema, raw, "Ödeme paketi onay talebi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const runRes = await client.query<{
      id: string;
      run_code: string;
      status: string;
      total_amount: string;
      currency: string;
      item_count: number;
      breaches_cash_floor: boolean;
    }>(
      `select id::text, run_code, status, total_amount::text, currency, item_count, breaches_cash_floor
         from public.payment_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (runRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Ödeme paketi bulunamadı.");
    const run = runRes.rows[0];
    if (run.status !== "draft") {
      throw new DomainError("CONFLICT", `Yalnız 'draft' durumundaki ödeme paketi onaya gönderilebilir (mevcut: '${run.status}').`);
    }

    const defaultNote = run.breaches_cash_floor
      ? "DİKKAT: Bu ödeme paketi 14 günlük asgari kasa tamponunu aşıyor."
      : `${run.item_count} kalemlik banka ödeme paketi maker-checker onayı`;

    const { approvalId } = await requestApprovalWithClient(
      client,
      {
        subjectTable: "payment_runs",
        subjectId: input.runId,
        subjectLabel: `${run.run_code} (${run.item_count} kalem)`,
        requestKind: "payment_run",
        ruleCode: "payment_run_maker_checker",
        amount: moneyOrNull(run.total_amount) ?? undefined,
        currency: run.currency,
        note: input.note ?? defaultNote,
      },
      actorId,
      { reuseOpen: true },
    );

    const upd = await client.query(
      `update public.payment_runs
          set status = 'pending_approval', approval_id = $2
        where id = $1`,
      [input.runId, approvalId],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Ödeme paketi durumu güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "submit_payment_run",
      entityTable: "payment_runs",
      entityId: input.runId,
      before: { status: "draft" },
      after: { status: "pending_approval", approvalId },
    });

    await client.query("commit");
    return { approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelPaymentRun(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<void> {
  const input = parseOrThrow(cancelPaymentRunSchema, raw, "Ödeme paketi iptali");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const runRes = await client.query<{
      id: string;
      status: string;
      approval_id: string | null;
    }>(
      `select id::text, status, approval_id::text
         from public.payment_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (runRes.rowCount === 0) throw new DomainError("NOT_FOUND", "Ödeme paketi bulunamadı.");
    const run = runRes.rows[0];
    if (run.status === "cancelled" || run.status === "settled") {
      throw new DomainError("CONFLICT", `'${run.status}' durumundaki ödeme paketi iptal edilemez.`);
    }

    const upd = await client.query(
      `update public.payment_runs
          set status = 'cancelled', cancelled_at = now(), cancel_reason = $2
        where id = $1`,
      [input.runId, input.reason],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Ödeme paketi iptal edilemedi.");
    }

    await client.query(
      `update public.payment_run_items
          set status = 'excluded'
        where run_id = $1 and status = 'included'`,
      [input.runId],
    );

    await audit(client, {
      actor: actorId,
      action: "cancel_payment_run",
      entityTable: "payment_runs",
      entityId: input.runId,
      before: { status: run.status },
      after: { status: "cancelled", cancelReason: input.reason },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface PaymentRunSummaryRow {
  id: string;
  runCode: string;
  plannedExecutionDate: string;
  sourceBankAccountId: string;
  sourceBankName: string;
  sourceBankIban: string | null;
  currency: string;
  totalAmount: number;
  itemCount: number;
  settledItemCount: number;
  unverifiedIbanCount: number;
  preRunCash: number | null;
  projected14dMinCash: number | null;
  minCashFloor: number | null;
  breachesCashFloor: boolean;
  status: string;
  approvalId: string | null;
  exportedFormat: string | null;
  exportedHash: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  createdAt: string;
  exportedAt: string | null;
}

export async function loadPaymentRuns(
  pool: Pick<Pool, "query">,
  limit = 25,
): Promise<PaymentRunSummaryRow[]> {
  const r = await pool.query(
    `select pr.id::text,
            pr.run_code,
            to_char(pr.planned_execution_date, 'YYYY-MM-DD') as planned_execution_date,
            pr.source_bank_account_id::text,
            ca.name as source_bank_name,
            ba.iban_normalized as source_bank_iban,
            pr.currency,
            pr.total_amount,
            pr.item_count,
            (select count(*)::int from public.payment_run_items pri where pri.run_id = pr.id and pri.status = 'settled') as settled_item_count,
            (select count(*)::int
               from public.payment_run_items pri
               left join public.ibans ib on ib.id = pri.iban_id
              where pri.run_id = pr.id
                and pri.status in ('included', 'settled')
                and (not pri.iban_verified or (pri.iban_id is not null and (ib.is_active is not true or ib.approval_status <> 'approved')))) as unverified_iban_count,
            pr.pre_run_cash,
            pr.projected_14d_min_cash,
            pr.min_cash_floor,
            pr.breaches_cash_floor,
            pr.status,
            pr.approval_id::text,
            pr.exported_format,
            pr.exported_hash,
            public.user_display_label(pr.created_by) as created_by_name,
            public.user_display_label(pr.approved_by) as approved_by_name,
            to_char(pr.created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at,
            to_char(pr.exported_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as exported_at
       from public.payment_runs pr
       join public.bank_accounts ba on ba.cash_account_id = pr.source_bank_account_id
       join public.cash_accounts ca on ca.id = ba.cash_account_id
      order by pr.created_at desc
      limit $1`,
    [limit],
  ).catch((err: unknown) => {
    if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
    throw err;
  });

  return r.rows.map((x) => ({
    id: x.id,
    runCode: x.run_code,
    plannedExecutionDate: x.planned_execution_date,
    sourceBankAccountId: x.source_bank_account_id,
    sourceBankName: x.source_bank_name,
    sourceBankIban: x.source_bank_iban ?? null,
    currency: x.currency,
    totalAmount: moneyOrNull(x.total_amount) ?? 0,
    itemCount: intOrNull(x.item_count) ?? 0,
    settledItemCount: intOrNull(x.settled_item_count) ?? 0,
    unverifiedIbanCount: intOrNull(x.unverified_iban_count) ?? 0,
    preRunCash: moneyOrNull(x.pre_run_cash),
    projected14dMinCash: moneyOrNull(x.projected_14d_min_cash),
    minCashFloor: moneyOrNull(x.min_cash_floor),
    breachesCashFloor: Boolean(x.breaches_cash_floor),
    status: x.status,
    approvalId: x.approval_id ?? null,
    exportedFormat: x.exported_format ?? null,
    exportedHash: x.exported_hash ?? null,
    createdByName: x.created_by_name ?? null,
    approvedByName: x.approved_by_name ?? null,
    createdAt: x.created_at,
    exportedAt: x.exported_at ?? null,
  }));
}

