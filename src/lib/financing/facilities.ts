// Faz 27 — credit facility rules. Pure, decimal, no database.
//
// The database is the authority on what a facility IS (migration 0064 holds the CHECK and the
// transition guard). This mirrors the same allow-list so the application can refuse a move with a
// sentence instead of a PostgreSQL exception, and `phase27:verify` executes both against real
// rows to prove they still agree.

import { decimal, moneyOrNull, ratioOrNull, type NumericInput } from "@/lib/money";

export const FACILITY_STATUSES = ["active", "suspended", "expired", "closed"] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

export const FACILITY_TYPES = [
  "revolving", "overdraft", "spot", "guarantee_letter", "letter_of_credit", "other",
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

/**
 * The eight permitted moves, identical to 0064's guard.
 *
 * Two are worth naming because leaving either out looks harmless and is not:
 *   suspended -> expired  a frozen facility still ages; without this every suspended line is
 *                         stranded once its term passes.
 *   expired   -> active   renewal. Banks renew annual limits routinely, and forcing a new row
 *                         instead would detach the facility from its own drawdown history.
 */
export const FACILITY_TRANSITIONS: ReadonlyArray<readonly [FacilityStatus, FacilityStatus]> = [
  ["active", "suspended"],
  ["active", "expired"],
  ["active", "closed"],
  ["suspended", "active"],
  ["suspended", "expired"],
  ["suspended", "closed"],
  ["expired", "active"],
  ["expired", "closed"],
] as const;

export function canTransition(from: FacilityStatus, to: FacilityStatus): boolean {
  if (from === to) return true;
  return FACILITY_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export interface FacilityUtilization {
  limitAmount: number;
  drawnAmount: number;
  availableAmount: number;
  /** null when the limit is zero — a ratio against nothing is undefined, not 0. */
  utilizationRatio: number | null;
  overLimit: boolean;
  /** PHASE 2.2 (#34): facility para biriminden farklı hareketler — kullanıma girmedi. */
  foreignMovementCount: number;
}

/**
 * Limit, drawn, available — computed, never stored.
 *
 * `available` is floored at zero and `overLimit` reports the breach separately. A negative
 * headroom propagating into a treasury total would silently reduce the group's available
 * liquidity by the size of someone's overdraft, which is the opposite of what an over-limit
 * facility means.
 */
export type FacilityMovement = NumericInput | { amount: NumericInput; currency?: string | null };

/**
 * PHASE 2.2 (#34): hareket bir para birimi taşıyorsa facility'nin para birimiyle eşleşmeli;
 * eşleşmeyen hareket kullanıma girmez ve `foreignMovementCount` ile sayılır (0094
 * `credit_facility_utilization.foreign_drawdown_count` ile aynı kural). Düz sayı geçen çağıran
 * (eski imza) yapısal olarak facility para biriminde sayılır.
 */
export function utilization(
  limit: NumericInput, movements: FacilityMovement[], facilityCurrency = "TRY",
): FacilityUtilization {
  const limitAmount = moneyOrNull(limit) ?? 0;
  let drawn = decimal(0);
  let foreignMovementCount = 0;
  for (const m of movements) {
    const isObj = typeof m === "object" && m !== null && "amount" in m;
    const cur = isObj ? (m as { currency?: string | null }).currency : undefined;
    if (cur !== undefined && cur !== facilityCurrency) { foreignMovementCount++; continue; }
    const v = moneyOrNull(isObj ? (m as { amount: NumericInput }).amount : (m as NumericInput));
    if (v !== null) drawn = drawn.plus(decimal(v));
  }
  const drawnAmount = Number(drawn.toFixed(2));
  const rawAvailable = Number(decimal(limitAmount).minus(drawn).toFixed(2));
  return {
    limitAmount,
    drawnAmount,
    availableAmount: Math.max(0, rawAvailable),
    utilizationRatio: limitAmount === 0 ? null : ratioOrNull(drawnAmount, limitAmount),
    overLimit: drawnAmount > limitAmount,
    foreignMovementCount,
  };
}

/** Signed movement value: a drawdown consumes limit, a repayment returns it. */
export function signedMovement(movementType: "drawdown" | "repayment", amount: NumericInput): number {
  const v = moneyOrNull(amount) ?? 0;
  return movementType === "drawdown" ? v : -v;
}

export const MATURITY_BUCKETS = [30, 90, 180, 365] as const;
export type MaturityBucket = (typeof MATURITY_BUCKETS)[number];

/** Which ladder bucket a date falls into; null when beyond a year or already past. */
export function maturityBucket(dueDateISO: string, todayISO: string): MaturityBucket | null {
  const days = Math.round(
    (Date.parse(`${dueDateISO}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return null;           // already due — belongs to overdue reporting, not a ladder
  if (days < 30) return 30;
  if (days < 90) return 90;
  if (days < 180) return 180;
  if (days < 365) return 365;
  return null;                          // beyond the ladder's horizon
}

/**
 * Cash exposure in a ladder bucket.
 *
 * Instalments plus only the DRAWN part of expiring facilities. Adding the whole limit would
 * overstate the outflow by every unused lira — an unused limit that expires costs nothing, it
 * simply stops being available.
 */
export function bucketExposure(installmentDue: NumericInput, facilityDrawnExpiring: NumericInput): number {
  const a = moneyOrNull(installmentDue) ?? 0;
  const b = moneyOrNull(facilityDrawnExpiring) ?? 0;
  return Number(decimal(a).plus(decimal(b)).toFixed(2));
}

export const FACILITY_STATUS_LABEL: Record<FacilityStatus, string> = {
  active: "aktif",
  suspended: "donduruldu",
  expired: "vadesi doldu",
  closed: "kapatıldı",
};

export const FACILITY_TYPE_LABEL: Record<FacilityType, string> = {
  revolving: "rotatif",
  overdraft: "KMH",
  spot: "spot",
  guarantee_letter: "teminat mektubu",
  letter_of_credit: "akreditif",
  other: "diğer",
};


/* ── Faz 50 (D4): Audited DB write helpers (keeps module free of @/lib/env for phase27:verify) ── */

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { postJournalEntryWithClient } from "@/lib/ledger/posting-engine";
import { money, rateOrNull, roundMoney as round2 } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

export const COLLATERAL_TYPES = [
  "mortgage",
  "pledge",
  "vehicle_pledge",
  "personal_guarantee",
  "corporate_guarantee",
  "check",
  "promissory_note",
  "cash_blockage",
  "other",
] as const;
export type CollateralType = (typeof COLLATERAL_TYPES)[number];

export const COLLATERAL_TYPE_LABEL: Record<CollateralType, string> = {
  mortgage: "ipotek",
  pledge: "ticari rehin",
  vehicle_pledge: "araç rehni",
  personal_guarantee: "şahsi kefalet",
  corporate_guarantee: "kurumsal kefalet",
  check: "teminat çeki",
  promissory_note: "teminat senedi",
  cash_blockage: "nakit blokaj",
  other: "diğer",
};

export const COVENANT_TYPES = [
  "current_ratio",
  "debt_to_equity",
  "ebitda_multiple",
  "min_equity",
  "max_debt",
  "dscr",
  "other",
] as const;
export type CovenantType = (typeof COVENANT_TYPES)[number];

export const COVENANT_COMPARISONS = ["gte", "lte", "gt", "lt"] as const;
export type CovenantComparison = (typeof COVENANT_COMPARISONS)[number];

export function evaluateCovenantComparison(
  comparison: CovenantComparison,
  thresholdValue: NumericInput,
  measuredValue: NumericInput,
): "compliant" | "breached" {
  const threshold = decimal(thresholdValue);
  const measured = decimal(measuredValue);
  if (comparison === "gte") return measured.gte(threshold) ? "compliant" : "breached";
  if (comparison === "lte") return measured.lte(threshold) ? "compliant" : "breached";
  if (comparison === "gt") return measured.gt(threshold) ? "compliant" : "breached";
  return measured.lt(threshold) ? "compliant" : "breached";
}

export const createFacilitySchema = z.object({
  name: z.string().trim().min(2, "Kredi limiti adı en az 2 karakter olmalı").max(160),
  lenderPartyId: z.uuid().nullable().optional(),
  facilityType: z.enum(FACILITY_TYPES).default("revolving"),
  limitAmount: z.coerce.number().nonnegative("Kredi limiti negatif olamaz"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  interestRate: z.coerce.number().min(0).max(500).nullable().optional(),
  commissionRate: z.coerce.number().min(0).max(100).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(FACILITY_STATUSES).default("active"),
  notes: z.string().trim().max(1000).optional(),
});

export const recordFacilityMovementSchema = z.object({
  facilityId: z.uuid(),
  movementType: z.enum(["drawdown", "repayment", "limit_revision"]),
  movementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Hareket tarihi YYYY-AA-GG olmalı"),
  amount: z.coerce.number().positive("Hareket tutarı sıfırdan büyük olmalı"),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  cashAccountId: z.uuid().nullable().optional(),
  bankTxId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const addCollateralSchema = z.object({
  facilityId: z.uuid().nullable().optional(),
  loanId: z.uuid().nullable().optional(),
  collateralType: z.enum(COLLATERAL_TYPES),
  description: z.string().trim().max(500).optional(),
  valueAmount: z.coerce.number().nonnegative().nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  valuationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  valuationSource: z.enum(["bank", "independent", "internal", "unknown"]).nullable().optional(),
  ownerPartyId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const upsertCovenantSchema = z.object({
  covenantId: z.uuid().nullable().optional(),
  facilityId: z.uuid().nullable().optional(),
  loanId: z.uuid().nullable().optional(),
  covenantType: z.enum(COVENANT_TYPES).default("dscr"),
  description: z.string().trim().min(2, "Kovenant açıklaması gerekli").max(500),
  comparison: z.enum(COVENANT_COMPARISONS).default("gte"),
  thresholdValue: z.coerce.number(),
  testFrequency: z.enum(["monthly", "quarterly", "semiannual", "annual", "on_demand"]).default("quarterly"),
  status: z.enum(["active", "waived", "closed"]).default("active"),
  lastTestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  lastTestValue: z.coerce.number().nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export async function createFacility(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(createFacilitySchema, raw, "Kredi limiti");
  if (input.startDate && input.expiryDate && input.expiryDate < input.startDate) {
    throw new DomainError("VALIDATION", "Vade bitiş tarihi başlangıç tarihinden önce olamaz.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.credit_facilities
         (name, lender_party_id, facility_type, limit_amount, currency,
          interest_rate, commission_rate, start_date, expiry_date, review_date, status, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10::date, $11, $12)
       returning id`,
      [
        input.name,
        input.lenderPartyId ?? null,
        input.facilityType,
        input.limitAmount,
        input.currency,
        input.interestRate ?? null,
        input.commissionRate ?? null,
        input.startDate ?? null,
        input.expiryDate ?? null,
        input.reviewDate ?? null,
        input.status,
        input.notes ?? null,
      ],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_credit_facility",
      entityTable: "credit_facilities",
      entityId: id,
      after: {
        name: input.name,
        facilityType: input.facilityType,
        limitAmount: input.limitAmount,
        currency: input.currency,
        status: input.status,
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

export async function recordFacilityMovement(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ movementId: string; drawnAmount: number; limitAmount: number }> {
  const input = parseOrThrow(recordFacilityMovementSchema, raw, "Kredi limiti hareketi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const facBefore = await client.query<{
      id: string;
      name: string;
      lender_party_id: string | null;
      limit_amount: string;
      drawn_amount: string;
      currency: string;
      status: string;
    }>(
      `select id, name, lender_party_id::text as lender_party_id, limit_amount, drawn_amount, currency, status
         from public.credit_facilities
        where id = $1
          for update`,
      [input.facilityId],
    );
    if (facBefore.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Kredi limiti bulunamadı.");
    }
    const fac = facBefore.rows[0];
    const effCurrency = input.currency || fac.currency;

    let resolvedBankTxId: string | null = input.bankTxId ?? null;
    if (
      input.cashAccountId &&
      !resolvedBankTxId &&
      (input.movementType === "drawdown" || input.movementType === "repayment")
    ) {
      const caRes = await client.query<{ id: string; name: string; currency: string; is_active: boolean }>(
        `select id::text as id, name, currency, is_active
           from public.cash_accounts
          where id = $1 and archived_at is null`,
        [input.cashAccountId],
      );
      if (caRes.rowCount !== 1 || !caRes.rows[0].is_active) {
        throw new DomainError("NOT_FOUND", "Seçilen kasa/banka hesabı bulunamadı veya pasif.");
      }
      if (caRes.rows[0].currency !== effCurrency) {
        throw new DomainError(
          "CONFLICT",
          `Kredi limiti para birimi (${effCurrency}) ile banka hesabı para birimi (${caRes.rows[0].currency}) eşleşmelidir.`,
        );
      }
      await client.query(
        `insert into public.bank_accounts (cash_account_id) values ($1) on conflict (cash_account_id) do nothing`,
        [input.cashAccountId],
      );
      const amtDec = round2(decimal(input.amount));
      const signedBankAmt =
        input.movementType === "drawdown" ? amtDec.toFixed(2) : amtDec.times(-1).toFixed(2);
      const txUid = globalThis.crypto.randomUUID().slice(0, 8);
      const txIns = await client.query<{ id: string }>(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, value_date, amount, currency, description,
            category_rule, status, dedupe_hash)
         values ($1, $2::date, $2::date, $3::numeric, $4, $5,
                 'system_internal_settlement', 'unmatched', $6)
         returning id::text as id`,
        [
          input.cashAccountId,
          input.movementDate,
          signedBankAmt,
          effCurrency,
          `Kredi limiti ${input.movementType === "drawdown" ? "kullanımı" : "geri ödemesi"}: ${fac.name}`,
          `facility_mov:${input.facilityId}:${txUid}`,
        ],
      );
      resolvedBankTxId = txIns.rows[0]?.id ?? null;
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.facility_movements
         (facility_id, movement_type, movement_date, amount, currency, bank_tx_id, notes, created_by)
       values ($1, $2, $3::date, $4, $5, $6, $7, $8)
       returning id`,
      [
        input.facilityId,
        input.movementType,
        input.movementDate,
        input.amount,
        effCurrency,
        resolvedBankTxId,
        input.notes ?? null,
        actorId,
      ],
    );
    const movementId = ins.rows[0].id;

    if (
      (input.movementType === "drawdown" || input.movementType === "repayment") &&
      (input.cashAccountId || resolvedBankTxId)
    ) {
      const amtStr = round2(decimal(input.amount)).toFixed(2);
      await postJournalEntryWithClient(
        client,
        {
          entryDate: input.movementDate,
          sourceType: "facility_movement",
          sourceId: movementId,
          idempotencyKey: `facility_mov:${movementId}`,
          description: `Kredi Limiti ${input.movementType === "drawdown" ? "Kullanımı (102/300)" : "Geri Ödemesi (300/102)"}: ${fac.name}`,
          currency: effCurrency,
          lines:
            input.movementType === "drawdown"
              ? [
                  { accountCode: "102", debitNative: amtStr, memo: `BCH/Rotatif kredi kullanımı (${fac.name})` },
                  { accountCode: "300", creditNative: amtStr, partyId: fac.lender_party_id, memo: `Kısa vadeli banka kredileri (${fac.name})` },
                ]
              : [
                  { accountCode: "300", debitNative: amtStr, partyId: fac.lender_party_id, memo: `BCH/Rotatif kredi anapara kapaması (${fac.name})` },
                  { accountCode: "102", creditNative: amtStr, memo: `Bankadan kredi geri ödemesi (${fac.name})` },
                ],
        },
        actorId,
      );
    }

    const facAfter = await client.query<{ limit_amount: string; drawn_amount: string }>(
      `select limit_amount, drawn_amount from public.credit_facilities where id = $1`,
      [input.facilityId],
    );
    const drawnAmount = moneyOrNull(facAfter.rows[0].drawn_amount) ?? 0;
    const limitAmount = moneyOrNull(facAfter.rows[0].limit_amount) ?? 0;

    await audit(client, {
      actor: actorId,
      action: `facility_${input.movementType}`,
      entityTable: "facility_movements",
      entityId: ins.rows[0].id,
      before: {
        drawnAmount: moneyOrNull(facBefore.rows[0].drawn_amount) ?? 0,
        limitAmount: moneyOrNull(facBefore.rows[0].limit_amount) ?? 0,
      },
      after: {
        facilityId: input.facilityId,
        movementType: input.movementType,
        movementDate: input.movementDate,
        amount: input.amount,
        currency: input.currency || facBefore.rows[0].currency,
        drawnAmount,
        limitAmount,
      },
    });
    await client.query("commit");
    return { movementId: ins.rows[0].id, drawnAmount, limitAmount };
  } catch (e) {
    await client.query("rollback");
    const err = e as { code?: string; message?: string };
    if (err.code === "23514" || err.code === "P0001") {
      throw new DomainError("VALIDATION", err.message ?? "Kredi hareketi kısıt kontrolüne takıldı.");
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function addCollateral(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(addCollateralSchema, raw, "Teminat kaydı");
  const hasFacility = Boolean(input.facilityId);
  const hasLoan = Boolean(input.loanId);
  if (hasFacility === hasLoan) {
    throw new DomainError("VALIDATION", "Teminat tam olarak bir kredi limitine veya bir krediye bağlanmalıdır.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.collateral_records
         (loan_id, facility_id, collateral_type, description, value_amount, currency,
          valuation_date, valuation_source, owner_party_id, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11)
       returning id`,
      [
        input.loanId ?? null,
        input.facilityId ?? null,
        input.collateralType,
        input.description ?? null,
        input.valueAmount ?? null,
        input.currency,
        input.valuationDate ?? null,
        input.valuationSource ?? null,
        input.ownerPartyId ?? null,
        input.notes ?? null,
        actorId,
      ],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "add_collateral",
      entityTable: "collateral_records",
      entityId: id,
      after: {
        facilityId: input.facilityId ?? null,
        loanId: input.loanId ?? null,
        collateralType: input.collateralType,
        valueAmount: input.valueAmount ?? null,
        currency: input.currency,
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

export async function upsertCovenant(pool: Pool, raw: unknown, actorId: string): Promise<string> {
  const input = parseOrThrow(upsertCovenantSchema, raw, "Kovenant kaydı");
  const hasMeasurement = input.lastTestValue != null || Boolean(input.lastTestDate);
  if (hasMeasurement && (input.lastTestValue == null || !input.lastTestDate)) {
    throw new DomainError("VALIDATION", "Kovenant ölçümü için hem ölçüm tarihi hem ölçüm değeri girilmelidir.");
  }
  const computedResult =
    input.lastTestValue != null && input.lastTestDate
      ? evaluateCovenantComparison(input.comparison, input.thresholdValue, input.lastTestValue)
      : null;

  const client = await pool.connect();
  try {
    await client.query("begin");
    if (input.covenantId) {
      const before = await client.query<{
        id: string;
        status: string;
        last_test_value: string | null;
        last_test_result: string | null;
      }>(`select id, status, last_test_value, last_test_result from public.covenant_records where id = $1 for update`, [
        input.covenantId,
      ]);
      if (before.rowCount === 0) {
        throw new DomainError("NOT_FOUND", "Kovenant kaydı bulunamadı.");
      }
      await client.query(
        `update public.covenant_records
            set description = $2,
                comparison = $3,
                threshold_value = $4,
                test_frequency = $5,
                status = $6,
                last_test_date = coalesce($7::date, last_test_date),
                last_test_value = case when $7::date is not null then $8 else last_test_value end,
                last_test_result = case when $7::date is not null then $9 else last_test_result end,
                notes = coalesce($10, notes)
          where id = $1`,
        [
          input.covenantId,
          input.description,
          input.comparison,
          input.thresholdValue,
          input.testFrequency,
          input.status,
          input.lastTestDate ?? null,
          input.lastTestValue ?? null,
          computedResult,
          input.notes ?? null,
        ],
      );
      await audit(client, {
        actor: actorId,
        action: "update_covenant",
        entityTable: "covenant_records",
        entityId: input.covenantId,
        before: before.rows[0],
        after: {
          status: input.status,
          thresholdValue: input.thresholdValue,
          lastTestDate: input.lastTestDate ?? null,
          lastTestValue: input.lastTestValue ?? null,
          lastTestResult: computedResult,
        },
      });
      await client.query("commit");
      return input.covenantId;
    }

    const hasFacility = Boolean(input.facilityId);
    const hasLoan = Boolean(input.loanId);
    if (hasFacility === hasLoan) {
      throw new DomainError("VALIDATION", "Kovenant tam olarak bir kredi limitine veya bir krediye bağlanmalıdır.");
    }
    const ins = await client.query<{ id: string }>(
      `insert into public.covenant_records
         (loan_id, facility_id, covenant_type, description, comparison, threshold_value,
          test_frequency, status, last_test_date, last_test_value, last_test_result, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13)
       returning id`,
      [
        input.loanId ?? null,
        input.facilityId ?? null,
        input.covenantType,
        input.description,
        input.comparison,
        input.thresholdValue,
        input.testFrequency,
        input.status,
        input.lastTestDate ?? null,
        input.lastTestValue ?? null,
        computedResult,
        input.notes ?? null,
        actorId,
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_covenant",
      entityTable: "covenant_records",
      entityId: id,
      after: {
        facilityId: input.facilityId ?? null,
        loanId: input.loanId ?? null,
        covenantType: input.covenantType,
        comparison: input.comparison,
        thresholdValue: input.thresholdValue,
        lastTestResult: computedResult,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    const err = e as { code?: string; message?: string };
    if (err.code === "23514") {
      throw new DomainError("VALIDATION", err.message ?? "Kovenant kısıt kontrolüne takıldı.");
    }
    throw e;
  } finally {
    client.release();
  }
}

/* ── Faz 60 (M-41): BCH / Rotatif Kredi Günlük Adat Tahakkuku & Teminat Mektupları (910/911) ── */

export interface FacilityAdatBreakdown {
  interestAmount: number;
  bsmvAmount: number;
  kkdfAmount: number;
  totalCharge: number;
}

export function calculateFacilityAdatAccrual(input: {
  averageUtilizedBalance: NumericInput;
  daysInPeriod: number;
  annualRatePct: NumericInput;
  bsmvRate?: NumericInput;
  kkdfRate?: NumericInput;
}): FacilityAdatBreakdown {
  const avgBal = decimal(input.averageUtilizedBalance);
  const days = Math.max(1, Math.min(31, Math.round(input.daysInPeriod)));
  const ratePct = decimal(input.annualRatePct);
  const bsmvRate = input.bsmvRate != null ? decimal(input.bsmvRate) : decimal("0.05");
  const kkdfRate = input.kkdfRate != null ? decimal(input.kkdfRate) : decimal("0");
  const normBsmv = bsmvRate.gt(1) ? bsmvRate.div(100) : bsmvRate;
  const normKkdf = kkdfRate.gt(1) ? kkdfRate.div(100) : kkdfRate;

  // Türk bankacılık BCH 360-gün adat formülü: Anapara_Ort * Yıllık_Oran(%) / 100 * Gün / 360
  const interestDec = round2(avgBal.times(ratePct).div(100).times(days).div(360));
  const bsmvDec = round2(interestDec.times(normBsmv));
  const kkdfDec = round2(interestDec.times(normKkdf));
  const totalDec = round2(interestDec.plus(bsmvDec).plus(kkdfDec));

  return {
    interestAmount: money(interestDec),
    bsmvAmount: money(bsmvDec),
    kkdfAmount: money(kkdfDec),
    totalCharge: money(totalDec),
  };
}

export const accrueFacilityInterestSchema = z.object({
  facilityId: z.uuid("Kredi limiti seçilmelidir."),
  accrualMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Tahakkuk dönemi YYYY-AA biçiminde olmalıdır."),
  averageUtilizedBalance: z.coerce.number().positive("Ortalama kullanılan bakiye sıfırdan büyük olmalıdır."),
  daysInPeriod: z.coerce.number().int().min(1).max(31).default(30),
  annualRatePct: z.coerce.number().min(0).max(500),
  bsmvRate: z.coerce.number().min(0).max(100).default(0.05),
  kkdfRate: z.coerce.number().min(0).max(100).default(0),
});

export async function accrueFacilityInterest(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ accrualId: string; breakdown: FacilityAdatBreakdown; journalEntryId: string | null }> {
  const input = parseOrThrow(accrueFacilityInterestSchema, raw, "BCH / rotatif kredi adat tahakkuku");
  const monthStart = `${input.accrualMonth.slice(0, 7)}-01`;
  const breakdown = calculateFacilityAdatAccrual(input);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const facRes = await client.query<{ id: string; name: string; currency: string; lender_party_id: string | null }>(
      `select id::text as id, name, currency, lender_party_id::text as lender_party_id
         from public.credit_facilities
        where id = $1 and archived_at is null`,
      [input.facilityId],
    );
    if (facRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Kredi limiti bulunamadı.");
    }
    const fac = facRes.rows[0];

    let journalEntryId: string | null = null;
    if (breakdown.totalCharge > 0) {
      const je = await postJournalEntryWithClient(
        client,
        {
          entryDate: monthStart,
          sourceType: "facility_movement",
          sourceId: fac.id,
          idempotencyKey: `facility_adat:${fac.id}:${monthStart}`,
          description: `BCH / Rotatif Kredi Adat & BSMV Tahakkuku (${monthStart.slice(0, 7)} · ${fac.name})`,
          currency: fac.currency,
          lines: [
            {
              accountCode: "780",
              debitNative: decimal(breakdown.totalCharge).toFixed(2),
              partyId: fac.lender_party_id,
              memo: `BCH adat faizi (${breakdown.interestAmount.toFixed(2)}) + BSMV (${breakdown.bsmvAmount.toFixed(2)})`,
            },
            {
              accountCode: "300",
              creditNative: decimal(breakdown.totalCharge).toFixed(2),
              partyId: fac.lender_party_id,
              memo: `Dönem sonu kredi faiz tahakkuku (${fac.name})`,
            },
          ],
        },
        actorId,
      );
      journalEntryId = je.entryId;
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.facility_interest_accruals
         (facility_id, accrual_month, average_utilized_balance, days_in_period,
          annual_rate_pct, interest_amount, bsmv_amount, kkdf_amount, total_charge,
          currency, journal_entry_id)
       values ($1, $2::date, $3::numeric, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10, $11)
       on conflict (facility_id, accrual_month) do update
         set average_utilized_balance = excluded.average_utilized_balance,
             days_in_period = excluded.days_in_period,
             annual_rate_pct = excluded.annual_rate_pct,
             interest_amount = excluded.interest_amount,
             bsmv_amount = excluded.bsmv_amount,
             kkdf_amount = excluded.kkdf_amount,
             total_charge = excluded.total_charge,
             journal_entry_id = coalesce(excluded.journal_entry_id, public.facility_interest_accruals.journal_entry_id)
       returning id::text as id`,
      [
        fac.id,
        monthStart,
        decimal(input.averageUtilizedBalance).round(2).toFixed(2),
        input.daysInPeriod,
        decimal(input.annualRatePct).round(4).toFixed(4),
        decimal(breakdown.interestAmount).toFixed(2),
        decimal(breakdown.bsmvAmount).toFixed(2),
        decimal(breakdown.kkdfAmount).toFixed(2),
        decimal(breakdown.totalCharge).toFixed(2),
        fac.currency,
        journalEntryId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "BCH adat tahakkuku kaydedilemedi.");
    }
    const accrualId = ins.rows[0].id;

    await audit(client, {
      actor: actorId,
      action: "accrue_facility_interest",
      entityTable: "facility_interest_accruals",
      entityId: accrualId,
      after: {
        facilityId: fac.id,
        accrualMonth: monthStart,
        ...breakdown,
        currency: fac.currency,
        journalEntryId,
      },
    });

    await client.query("commit");
    return { accrualId, breakdown, journalEntryId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export const GUARANTEE_TYPES = ["gecici", "kesin", "avans", "gumruk", "mahkeme", "diger"] as const;
export type GuaranteeType = (typeof GUARANTEE_TYPES)[number];

export const GUARANTEE_TYPE_LABELS: Record<GuaranteeType, string> = {
  gecici: "Geçici Teminat Mektubu",
  kesin: "Kesin Teminat Mektubu",
  avans: "Avans Teminat Mektubu",
  gumruk: "Gümrük / Vergi Dairesi Mektubu",
  mahkeme: "Mahkeme / İcra Teminat Mektubu",
  diger: "Diğer Teminat Mektubu",
};

export function calculateGuaranteeQuarterlyCommission(
  amount: NumericInput,
  commissionRateAnnual: NumericInput,
): number {
  const amtDec = decimal(amount);
  const rawRate = decimal(commissionRateAnnual);
  const normRate = rawRate.gt(1) ? rawRate.div(100) : rawRate;
  return money(round2(amtDec.times(normRate).div(4)));
}

export const createLetterOfGuaranteeSchema = z.object({
  facilityId: z.uuid().nullable().optional(),
  beneficiaryPartyId: z.uuid().nullable().optional(),
  beneficiaryName: z.string().trim().min(2, "Muhatap kurum/şirket adı girilmelidir.").max(180),
  guaranteeType: z.enum(GUARANTEE_TYPES).default("kesin"),
  referenceNo: z.string().trim().min(2, "Mektup referans no girilmelidir.").max(80),
  amount: z.coerce.number().positive("Mektup tutarı sıfırdan büyük olmalıdır."),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  commissionRateAnnual: z.coerce.number().min(0).max(100).default(0.015),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export async function createLetterOfGuarantee(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string; quarterlyCommissionAmount: number; journalEntryId: string }> {
  const input = parseOrThrow(createLetterOfGuaranteeSchema, raw, "Teminat mektubu kaydı");
  const rawComm = decimal(input.commissionRateAnnual);
  const normComm = rawComm.gt(1) ? rawComm.div(100) : rawComm;
  const quarterlyComm = calculateGuaranteeQuarterlyCommission(input.amount, normComm);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const lgId = globalThis.crypto.randomUUID();
    const amtStr = round2(decimal(input.amount)).toFixed(2);

    const je = await postJournalEntryWithClient(
      client,
      {
        entryDate: input.issueDate,
        sourceType: "facility_movement",
        sourceId: lgId,
        idempotencyKey: `lg_issue:${lgId}`,
        description: `Verilen Teminat Mektubu Nazım Kaydı (${input.referenceNo} · ${input.beneficiaryName})`,
        currency: input.currency,
        lines: [
          {
            accountCode: "910",
            debitNative: amtStr,
            partyId: input.beneficiaryPartyId ?? null,
            memo: `${GUARANTEE_TYPE_LABELS[input.guaranteeType]} (${input.referenceNo})`,
          },
          {
            accountCode: "911",
            creditNative: amtStr,
            partyId: input.beneficiaryPartyId ?? null,
            memo: `Muhatap: ${input.beneficiaryName}`,
          },
        ],
      },
      actorId,
    );

    const ins = await client.query<{ id: string }>(
      `insert into public.letter_of_guarantees
         (id, facility_id, beneficiary_party_id, beneficiary_name, guarantee_type,
          reference_no, amount, currency, commission_rate_annual, quarterly_commission_amount,
          issue_date, expiry_date, is_active, journal_entry_id)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10::numeric, $11::date, $12::date, true, $13)
       returning id::text as id`,
      [
        lgId,
        input.facilityId ?? null,
        input.beneficiaryPartyId ?? null,
        input.beneficiaryName,
        input.guaranteeType,
        input.referenceNo,
        amtStr,
        input.currency,
        normComm.round(4).toFixed(4),
        decimal(quarterlyComm).toFixed(2),
        input.issueDate,
        input.expiryDate ?? null,
        je.entryId,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Teminat mektubu kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "create_letter_of_guarantee",
      entityTable: "letter_of_guarantees",
      entityId: lgId,
      after: {
        referenceNo: input.referenceNo,
        beneficiaryName: input.beneficiaryName,
        guaranteeType: input.guaranteeType,
        amount: input.amount,
        currency: input.currency,
        quarterlyCommissionAmount: quarterlyComm,
        journalEntryId: je.entryId,
      },
    });

    await client.query("commit");
    return { id: lgId, quarterlyCommissionAmount: quarterlyComm, journalEntryId: je.entryId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function returnLetterOfGuarantee(
  pool: Pool,
  guaranteeId: string,
  returnedDate: string | null,
  actorId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{
      id: string;
      reference_no: string;
      beneficiary_name: string;
      beneficiary_party_id: string | null;
      amount: string;
      currency: string;
      issue_date: string;
      is_active: boolean;
    }>(
      `select id::text as id, reference_no, beneficiary_name,
              beneficiary_party_id::text as beneficiary_party_id,
              amount::text, currency, to_char(issue_date, 'YYYY-MM-DD') as issue_date, is_active
         from public.letter_of_guarantees
        where id = $1
        for update`,
      [guaranteeId],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Teminat mektubu bulunamadı.");
    }
    const row = res.rows[0];
    if (!row.is_active) {
      throw new DomainError("CONFLICT", "Bu teminat mektubu zaten iade edilmiş.");
    }
    const effDate =
      returnedDate && /^\d{4}-\d{2}-\d{2}$/.test(returnedDate)
        ? returnedDate
        : new Date().toISOString().slice(0, 10);

    const upd = await client.query(
      `update public.letter_of_guarantees
          set is_active = false,
              returned_at = $2::date,
              updated_at = now()
        where id = $1`,
      [guaranteeId, effDate],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Teminat mektubu iadesi güncellenemedi.");
    }

    const amtStr = round2(decimal(row.amount)).toFixed(2);
    await postJournalEntryWithClient(
      client,
      {
        entryDate: effDate,
        sourceType: "facility_movement",
        sourceId: row.id,
        idempotencyKey: `lg_return:${row.id}`,
        description: `İade Edilen Teminat Mektubu Nazım Kapanışı (${row.reference_no})`,
        currency: row.currency,
        lines: [
          {
            accountCode: "911",
            debitNative: amtStr,
            partyId: row.beneficiary_party_id,
            memo: `Mektup iadesi: ${row.beneficiary_name}`,
          },
          {
            accountCode: "910",
            creditNative: amtStr,
            partyId: row.beneficiary_party_id,
            memo: `Nazım hesap kapanışı (${row.reference_no})`,
          },
        ],
      },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "return_letter_of_guarantee",
      entityTable: "letter_of_guarantees",
      entityId: guaranteeId,
      before: { is_active: true },
      after: { is_active: false, returned_at: effDate },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface FacilityAccrualRow {
  id: string;
  facilityId: string;
  facilityName: string;
  accrualMonth: string;
  averageUtilizedBalance: number;
  daysInPeriod: number;
  annualRatePct: number;
  interestAmount: number;
  bsmvAmount: number;
  kkdfAmount: number;
  totalCharge: number;
  currency: string;
  isSettled: boolean;
}

export interface LetterOfGuaranteeRow {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  beneficiaryName: string;
  guaranteeType: GuaranteeType;
  referenceNo: string;
  amount: number;
  currency: string;
  commissionRateAnnual: number;
  quarterlyCommissionAmount: number;
  issueDate: string;
  expiryDate: string | null;
  isActive: boolean;
  returnedAt: string | null;
}

export async function loadFacilityAccrualsAndGuarantees(pool: Pick<Pool, "query">): Promise<{
  accruals: FacilityAccrualRow[];
  guarantees: LetterOfGuaranteeRow[];
}> {
  const [accRes, lgRes] = await Promise.all([
    pool
      .query(
        `select a.id::text as id,
                a.facility_id::text as facility_id,
                cf.name as facility_name,
                to_char(a.accrual_month, 'YYYY-MM') as accrual_month,
                a.average_utilized_balance,
                a.days_in_period,
                a.annual_rate_pct,
                a.interest_amount,
                a.bsmv_amount,
                a.kkdf_amount,
                a.total_charge,
                a.currency,
                a.is_settled
           from public.facility_interest_accruals a
           join public.credit_facilities cf on cf.id = a.facility_id
          order by a.accrual_month desc, a.created_at desc
          limit 40`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `select lg.id::text as id,
                lg.facility_id::text as facility_id,
                cf.name as facility_name,
                lg.beneficiary_name,
                lg.guarantee_type,
                lg.reference_no,
                lg.amount,
                lg.currency,
                lg.commission_rate_annual,
                lg.quarterly_commission_amount,
                to_char(lg.issue_date, 'YYYY-MM-DD') as issue_date,
                to_char(lg.expiry_date, 'YYYY-MM-DD') as expiry_date,
                lg.is_active,
                to_char(lg.returned_at, 'YYYY-MM-DD') as returned_at
           from public.letter_of_guarantees lg
           left join public.credit_facilities cf on cf.id = lg.facility_id
          order by lg.is_active desc, lg.expiry_date asc nulls last, lg.issue_date desc
          limit 50`,
      )
      .catch(() => ({ rows: [] })),
  ]);

  return {
    accruals: accRes.rows.map((r) => ({
      id: r.id,
      facilityId: r.facility_id,
      facilityName: r.facility_name,
      accrualMonth: r.accrual_month,
      averageUtilizedBalance: moneyOrNull(r.average_utilized_balance) ?? 0,
      daysInPeriod: Number(r.days_in_period ?? 30),
      annualRatePct: rateOrNull(r.annual_rate_pct) ?? 0,
      interestAmount: moneyOrNull(r.interest_amount) ?? 0,
      bsmvAmount: moneyOrNull(r.bsmv_amount) ?? 0,
      kkdfAmount: moneyOrNull(r.kkdf_amount) ?? 0,
      totalCharge: moneyOrNull(r.total_charge) ?? 0,
      currency: r.currency,
      isSettled: Boolean(r.is_settled),
    })),
    guarantees: lgRes.rows.map((r) => ({
      id: r.id,
      facilityId: r.facility_id ?? null,
      facilityName: r.facility_name ?? null,
      beneficiaryName: r.beneficiary_name,
      guaranteeType: (r.guarantee_type as GuaranteeType) ?? "kesin",
      referenceNo: r.reference_no,
      amount: moneyOrNull(r.amount) ?? 0,
      currency: r.currency,
      commissionRateAnnual: rateOrNull(r.commission_rate_annual) ?? 0.015,
      quarterlyCommissionAmount: moneyOrNull(r.quarterly_commission_amount) ?? 0,
      issueDate: r.issue_date,
      expiryDate: r.expiry_date ?? null,
      isActive: Boolean(r.is_active),
      returnedAt: r.returned_at ?? null,
    })),
  };
}
