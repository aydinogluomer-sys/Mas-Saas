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
      limit_amount: string;
      drawn_amount: string;
      currency: string;
      status: string;
    }>(
      `select id, limit_amount, drawn_amount, currency, status
         from public.credit_facilities
        where id = $1
          for update`,
      [input.facilityId],
    );
    if (facBefore.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Kredi limiti bulunamadı.");
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
        input.currency || facBefore.rows[0].currency,
        input.bankTxId ?? null,
        input.notes ?? null,
        actorId,
      ],
    );

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
