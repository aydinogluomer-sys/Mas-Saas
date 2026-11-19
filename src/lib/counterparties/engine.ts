// Faz 19 + Faz 48 (D2) — counterparty (cari hesap) read/write engine.
//
// Every rule this phase inherits is applied here rather than re-litigated:
//   Faz 17 — money crosses the SQL/JS boundary through @/lib/money, never a ::float8 cast.
//   Faz 18 — every mutation records through the single canonical audit(), inside the same
//            transaction as the change it describes; input is parsed with a Zod schema.
//
// AND THE RULE THIS PHASE EXISTS TO PROTECT: nothing in this file creates a party implicitly.
// `createCounterparty` is the only function that inserts into public.parties, it is reachable
// only from an explicit operator action, and it refuses to run without a name the operator
// typed. The importer's behaviour (match by normalized name, keep the raw label, leave the FK
// null — src/lib/financing/engine.ts's partyIdByName) is untouched.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { evaluateAndRequestIfNeededWithClient } from "@/lib/approvals/engine";
import { audit } from "@/lib/audit";
import { raiseAlertWithClient } from "@/lib/controls/engine";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import { parseOrThrow } from "@/lib/validation";
import { inspectIban, normalizeIban } from "./rules";

/* ── schemas (Faz 18: one schema per action, at the boundary) ──────────────────────────── */

const PARTY_TYPES = [
  "company", "person", "bank", "provider", "customer", "vendor", "internal_owner", "unknown",
] as const;

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalTrimmedString = z.preprocess(
  emptyToUndefined,
  z.string().trim().min(1).optional(),
);

const optionalNonNegativeNumber = z.preprocess(
  emptyToUndefined,
  z.coerce.number().min(0).optional(),
);

const optionalNonNegativeInt = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(0).optional(),
);

export const createCounterpartySchema = z.object({
  name: z.string().trim().min(2, "En az 2 karakter olmalı"),
  partyType: z.enum(PARTY_TYPES).default("unknown"),
  taxNumber: optionalTrimmedString,
  taxOffice: optionalTrimmedString,
  addressLine: optionalTrimmedString,
  city: optionalTrimmedString,
  countryCode: z.preprocess(
    emptyToUndefined,
    z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default("TR"),
  ),
  creditLimit: optionalNonNegativeNumber,
  paymentTermsDays: optionalNonNegativeInt,
  contactName: optionalTrimmedString,
  contactEmail: optionalTrimmedString,
  contactPhone: optionalTrimmedString,
  notes: optionalTrimmedString,
});
export type CreateCounterpartyInput = z.infer<typeof createCounterpartySchema>;

export const addIbanSchema = z.object({
  partyId: z.uuid(),
  iban: z.string().trim().min(5),
  bankName: optionalTrimmedString,
  accountLabel: optionalTrimmedString,
  currency: z.preprocess(
    emptyToUndefined,
    z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  ),
  isPrimary: z.coerce.boolean().default(false),
});

export const linkCounterpartySchema = z.object({
  checkId: z.uuid(),
  partyId: z.uuid(),
  /** Which side of the check this party is. */
  role: z.enum(["payee", "payer"]),
});

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export interface CounterpartyExposureRow {
  partyId: string;
  partyName: string;
  partyType: string;
  isActive: boolean;
  itemCount: number;
  unknownAmountCount: number;
  outflowAmount: number;
  inflowAmount: number;
  checkAmount: number;
  checkCount: number;
  loanAmount: number;
  loanInstallmentCount: number;
  paymentAmount: number;
  paymentCount: number;
  earliestDueDate: string | null;
  totalExposure: number;
  exposureRatio: number | null;
  creditLimit: number | null;
  creditLimitUtilization: number | null;
  /**
   * PHASE 2.2 (T1-c, migration 0093): `null` = KARŞILAŞTIRILAMADI — limit TRY değil, maruziyet
   * TRY-only. "Aşılmadı" DEĞİL; ekran bunu ayrı söyler.
   */
  overCreditLimit: boolean | null;
  /** Limit var ve TRY → oran/aşım anlamlı. */
  creditLimitComparable: boolean;
  creditLimitCurrency: string | null;
  /** Açık kalemlerden TRY-dışı olanlar: hiçbir tutar toplamına girmez, sayısı görünür (plan §2.3). */
  foreignCurrencyCount: number;
  activeIbanCount: number;
}

/**
 * Reads public.counterparty_exposure (migration 0039).
 *
 * The view does the arithmetic in `numeric`; this decodes it. Amounts land at money scale,
 * ratios at rate scale — flattening a 0.416667 concentration ratio to 0.42 would move it
 * across the 0.40 threshold the banding uses.
 */
export async function loadCounterpartyExposure(
  pool: Pool,
  opts: { withExposureOnly?: boolean; limit?: number } = {},
): Promise<CounterpartyExposureRow[]> {
  const r = await pool.query(
    `select party_id, party_name, party_type, is_active, item_count, unknown_amount_count,
            outflow_amount, inflow_amount, check_amount, check_count, loan_amount,
            loan_installment_count, payment_amount, payment_count,
            to_char(earliest_due_date,'YYYY-MM-DD') as earliest_due_date,
            total_exposure, exposure_ratio, credit_limit, credit_limit_currency, credit_limit_utilization,
            over_credit_limit, credit_limit_comparable, foreign_currency_count, active_iban_count
     from public.counterparty_exposure
     where ($1::boolean is not true or item_count > 0)
     order by total_exposure desc, party_name
     limit $2`,
    [opts.withExposureOnly ?? false, opts.limit ?? 200],
  );
  return r.rows.map((x) => ({
    partyId: x.party_id,
    partyName: x.party_name,
    partyType: x.party_type,
    isActive: x.is_active,
    itemCount: intOrNull(x.item_count) ?? 0,
    unknownAmountCount: intOrNull(x.unknown_amount_count) ?? 0,
    outflowAmount: moneyOrNull(x.outflow_amount) ?? 0,
    inflowAmount: moneyOrNull(x.inflow_amount) ?? 0,
    checkAmount: moneyOrNull(x.check_amount) ?? 0,
    checkCount: intOrNull(x.check_count) ?? 0,
    loanAmount: moneyOrNull(x.loan_amount) ?? 0,
    loanInstallmentCount: intOrNull(x.loan_installment_count) ?? 0,
    paymentAmount: moneyOrNull(x.payment_amount) ?? 0,
    paymentCount: intOrNull(x.payment_count) ?? 0,
    earliestDueDate: x.earliest_due_date,
    totalExposure: moneyOrNull(x.total_exposure) ?? 0,
    exposureRatio: rateOrNull(x.exposure_ratio),
    creditLimit: moneyOrNull(x.credit_limit),
    creditLimitUtilization: rateOrNull(x.credit_limit_utilization),
    overCreditLimit: x.over_credit_limit == null ? null : Boolean(x.over_credit_limit),
    creditLimitComparable: Boolean(x.credit_limit_comparable),
    creditLimitCurrency: x.credit_limit_currency ?? null,
    foreignCurrencyCount: intOrNull(x.foreign_currency_count) ?? 0,
    activeIbanCount: intOrNull(x.active_iban_count) ?? 0,
  }));
}

export interface UnresolvedCounterparty {
  source: "check" | "loan";
  sourceId: string;
  rawLabel: string;
  dueDate: string | null;
  amount: number | null;
  status: string;
  direction?: "inflow" | "outflow" | "unknown";
}

/**
 * The rows an import could not resolve to a counterparty.
 *
 * This list is the deliberate alternative to a backfill. Faz 19 does not guess which party a
 * raw label belongs to — it makes the unresolved rows visible so an operator can decide. For
 * `loan` rows the `rawLabel` is `loans.name`, the loan's OWN name, because loans has no
 * counterparty_label column at all (verified by introspection); it is a hint for a human, never
 * a matching key.
 */
export async function loadUnresolvedCounterparties(pool: Pool, limit = 100): Promise<UnresolvedCounterparty[]> {
  let r;
  try {
    r = await pool.query(
      `select source, source_id::text as source_id, raw_label,
              to_char(due_date,'YYYY-MM-DD') as due_date, amount, status,
              coalesce(direction, 'outflow') as direction
       from public.counterparty_unresolved
       order by amount desc nulls last, raw_label
       limit $1`,
      [limit],
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703" && pgCode !== "42P01") throw err;
    r = await pool.query(
      `select source, source_id::text as source_id, raw_label,
              to_char(due_date,'YYYY-MM-DD') as due_date, amount, status,
              'outflow'::text as direction
       from public.counterparty_unresolved
       order by amount desc nulls last, raw_label
       limit $1`,
      [limit],
    );
  }
  return r.rows.map((x) => ({
    source: x.source,
    sourceId: x.source_id,
    rawLabel: x.raw_label,
    dueDate: x.due_date,
    amount: moneyOrNull(x.amount),
    status: x.status,
    direction: (x.direction === "inflow" || x.direction === "outflow" ? x.direction : "unknown"),
  }));
}

export interface ActiveIbanSummaryRow {
  id: string;
  partyId: string;
  partyName: string;
  ibanNormalized: string;
  bankName: string | null;
  accountLabel: string | null;
  currency: string;
  isPrimary: boolean;
  approvalStatus: string;
  createdAt: string;
}

export async function loadAllActiveIbans(pool: Pool, limit = 100): Promise<ActiveIbanSummaryRow[]> {
  let r;
  try {
    r = await pool.query(
      `select i.id::text, i.party_id::text as party_id, p.name as party_name,
              i.iban_normalized, i.bank_name, i.account_label, i.currency,
              i.is_primary, i.approval_status,
              to_char(i.created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
         from public.ibans i
         join public.parties p on p.id = i.party_id
        where i.is_active = true
        order by i.created_at desc
        limit $1`,
      [limit],
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703") throw err;
    r = await pool.query(
      `select i.id::text, i.party_id::text as party_id, p.name as party_name,
              i.iban_normalized, i.bank_name, i.account_label, i.currency,
              i.is_primary, 'approved'::text as approval_status,
              to_char(i.created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
         from public.ibans i
         join public.parties p on p.id = i.party_id
        where i.is_active = true
        order by i.created_at desc
        limit $1`,
      [limit],
    );
  }
  return r.rows.map((x) => ({
    id: x.id,
    partyId: x.party_id,
    partyName: x.party_name,
    ibanNormalized: x.iban_normalized,
    bankName: x.bank_name ?? null,
    accountLabel: x.account_label ?? null,
    currency: x.currency,
    isPrimary: Boolean(x.is_primary),
    approvalStatus: String(x.approval_status ?? "approved"),
    createdAt: x.created_at,
  }));
}

export interface IbanRow {
  id: string;
  ibanNormalized: string;
  bankName: string | null;
  accountLabel: string | null;
  currency: string;
  isPrimary: boolean;
  isActive: boolean;
  approvalStatus: string;
  verifiedAt: string | null;
  createdAt: string;
}

export async function loadIbans(pool: Pool, partyId: string): Promise<IbanRow[]> {
  let r;
  try {
    r = await pool.query(
      `select id::text, iban_normalized, bank_name, account_label, currency, is_primary, is_active,
              approval_status,
              to_char(verified_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as verified_at,
              to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
       from public.ibans where party_id=$1 order by is_primary desc, created_at`,
      [partyId],
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42703") throw err;
    r = await pool.query(
      `select id::text, iban_normalized, bank_name, account_label, currency, is_primary, is_active,
              'approved'::text as approval_status,
              to_char(verified_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as verified_at,
              to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
       from public.ibans where party_id=$1 order by is_primary desc, created_at`,
      [partyId],
    );
  }
  return r.rows.map((x) => ({
    id: x.id, ibanNormalized: x.iban_normalized, bankName: x.bank_name,
    accountLabel: x.account_label, currency: x.currency,
    isPrimary: x.is_primary, isActive: x.is_active,
    approvalStatus: String(x.approval_status ?? "approved"),
    verifiedAt: x.verified_at ?? null,
    createdAt: x.created_at,
  }));
}

/** The database-level, append-only history from migration 0037 — not audit_logs. */
export async function loadIbanHistory(pool: Pool, partyId: string, limit = 50) {
  const r = await pool.query(
    `select id::text, iban_id::text, change_type,
            before_data->>'iban_normalized' as before_iban,
            after_data->>'iban_normalized' as after_iban,
            to_char(changed_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as changed_at
     from public.iban_change_events where party_id=$1 order by changed_at desc limit $2`,
    [partyId, limit],
  );
  return r.rows as Array<{
    id: string; iban_id: string; change_type: string;
    before_iban: string | null; after_iban: string | null; changed_at: string;
  }>;
}

/** Candidate list for the resolve UI's suggestion shortlist. Read-only. */
export async function loadPartyCandidates(pool: Pool, limit = 500): Promise<Array<{ id: string; name: string }>> {
  const r = await pool.query(
    `select id::text, name from public.parties where is_active order by name limit $1`,
    [limit],
  );
  return r.rows as Array<{ id: string; name: string }>;
}

/* ── write side — every one of these is an EXPLICIT operator action ────────────────────── */

/**
 * The only function in the codebase that inserts into public.parties outside the seed.
 *
 * Deliberately NOT reachable from any import path. It takes a name a person typed, refuses a
 * duplicate rather than silently reusing one (the operator should see that the counterparty
 * already exists and pick it), and writes the profile in the same transaction as the party so
 * a half-created counterparty cannot exist.
 */
export async function createCounterparty(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ partyId: string; approvalId?: string | null }> {
  const input = parseOrThrow(createCounterpartySchema, raw, "Karşı taraf formu");
  const normalized = normalizeTr(input.name);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const existing = await client.query<{ id: string }>(
      `select id from public.parties where normalized_name=$1 and party_type=$2`,
      [normalized, input.partyType],
    );
    if ((existing.rowCount ?? 0) > 0) {
      // A DomainError, not a silent reuse: "this already exists, choose it" is information the
      // operator needs. Reusing it here is exactly the implicit-creation behaviour this phase
      // is protecting against, in reverse.
      throw new DomainError(
        `"${input.name}" adlı ${input.partyType} tipinde bir karşı taraf zaten var — yenisini yaratmak yerine onu seçin.`,
      );
    }

    const party = await client.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type) values ($1,$2,$3) returning id`,
      [input.name, normalized, input.partyType],
    );
    const partyId = party.rows[0].id;

    await client.query(
      `insert into public.counterparty_profiles
         (party_id, tax_number, tax_office, address_line, city, country_code,
          credit_limit, payment_terms_days, contact_name, contact_email, contact_phone, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        partyId, input.taxNumber ?? null, input.taxOffice ?? null, input.addressLine ?? null,
        input.city ?? null, input.countryCode, input.creditLimit ?? null,
        input.paymentTermsDays ?? null, input.contactName ?? null, input.contactEmail ?? null,
        input.contactPhone ?? null, input.notes ?? null,
      ],
    );

    const { approvalId } = await evaluateAndRequestIfNeededWithClient(client, {
      ruleInput: { subjectTable: "parties", triggerKind: "new_counterparty" },
      subjectId: partyId,
      subjectLabel: input.name,
      actorId,
    });
    if (approvalId) {
      await client.query(
        `update public.parties set approval_status='pending_approval', approval_id=$2 where id=$1`,
        [partyId, approvalId],
      );
    }

    await audit(client, {
      actor: actorId,
      action: "create_counterparty",
      entityTable: "parties",
      entityId: partyId,
      before: null,
      after: {
        name: input.name,
        partyType: input.partyType,
        hasProfile: true,
        approvalStatus: approvalId ? "pending_approval" : "approved",
        approvalId,
      },
    });

    await client.query("commit");
    return { partyId, approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertCounterpartyProfile(
  pool: Pool,
  partyId: string,
  raw: unknown,
  actorId: string,
): Promise<void> {
  const input = parseOrThrow(createCounterpartySchema.partial().omit({ name: true, partyType: true }), raw, "Karşı taraf profili");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select * from public.counterparty_profiles where party_id=$1 for update`,
      [partyId],
    );
    await client.query(
      `insert into public.counterparty_profiles
         (party_id, tax_number, tax_office, address_line, city, country_code,
          credit_limit, payment_terms_days, contact_name, contact_email, contact_phone, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (party_id) do update set
         tax_number=excluded.tax_number, tax_office=excluded.tax_office,
         address_line=excluded.address_line, city=excluded.city, country_code=excluded.country_code,
         credit_limit=excluded.credit_limit, payment_terms_days=excluded.payment_terms_days,
         contact_name=excluded.contact_name, contact_email=excluded.contact_email,
         contact_phone=excluded.contact_phone, notes=excluded.notes`,
      [
        partyId, input.taxNumber ?? null, input.taxOffice ?? null, input.addressLine ?? null,
        input.city ?? null, input.countryCode ?? "TR", input.creditLimit ?? null,
        input.paymentTermsDays ?? null, input.contactName ?? null, input.contactEmail ?? null,
        input.contactPhone ?? null, input.notes ?? null,
      ],
    );
    await audit(client, {
      actor: actorId, action: "upsert_counterparty_profile", entityTable: "counterparty_profiles",
      entityId: partyId, before: before.rows[0] ?? null, after: input,
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export const updateCounterpartySchema = createCounterpartySchema.extend({
  partyId: z.uuid(),
  isActive: z.preprocess(
    (v) => (v === "false" ? false : v === "true" ? true : undefined),
    z.boolean().optional(),
  ),
});

export interface CounterpartyProfileDetail {
  partyId: string;
  name: string;
  partyType: string;
  isActive: boolean;
  taxNumber: string | null;
  taxOffice: string | null;
  addressLine: string | null;
  city: string | null;
  countryCode: string;
  creditLimit: number | null;
  paymentTermsDays: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
}

export async function loadCounterpartyProfile(
  pool: Pool,
  partyId: string,
): Promise<CounterpartyProfileDetail | null> {
  const r = await pool.query<{
    id: string;
    name: string;
    party_type: string;
    is_active: boolean;
    tax_number: string | null;
    tax_office: string | null;
    address_line: string | null;
    city: string | null;
    country_code: string | null;
    credit_limit: string | null;
    payment_terms_days: string | null;
    contact_name: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    notes: string | null;
  }>(
    `select p.id::text, p.name, p.party_type, p.is_active,
            cp.tax_number, cp.tax_office, cp.address_line, cp.city, cp.country_code,
            cp.credit_limit::text, cp.payment_terms_days::text,
            cp.contact_name, cp.contact_email, cp.contact_phone, cp.notes
       from public.parties p
       left join public.counterparty_profiles cp on cp.party_id = p.id
      where p.id = $1::uuid`,
    [partyId],
  );
  if (r.rowCount !== 1) return null;
  const row = r.rows[0];
  return {
    partyId: row.id,
    name: row.name,
    partyType: row.party_type,
    isActive: Boolean(row.is_active),
    taxNumber: row.tax_number ?? null,
    taxOffice: row.tax_office ?? null,
    addressLine: row.address_line ?? null,
    city: row.city ?? null,
    countryCode: row.country_code ?? "TR",
    creditLimit: moneyOrNull(row.credit_limit),
    paymentTermsDays: intOrNull(row.payment_terms_days),
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    contactPhone: row.contact_phone ?? null,
    notes: row.notes ?? null,
  };
}

/**
 * M-36: Explicit operator update of counterparty header (`parties`) + `counterparty_profiles`.
 * Never inserts a new party; strictly updates an existing party row and upserts its 1:1 profile.
 */
export async function updateCounterparty(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ partyId: string }> {
  const input = parseOrThrow(updateCounterpartySchema, raw, "Karşı taraf güncelleme formu");
  const normalized = normalizeTr(input.name);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeParty = await client.query<{
      id: string;
      name: string;
      normalized_name: string;
      party_type: string;
      is_active: boolean;
    }>(
      `select id::text, name, normalized_name, party_type, is_active
         from public.parties
        where id = $1::uuid
        for update`,
      [input.partyId],
    );
    if (beforeParty.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "Güncellenecek karşı taraf bulunamadı.");
    }

    const dup = await client.query(
      `select 1 from public.parties
        where normalized_name = $1 and party_type = $2 and id <> $3::uuid`,
      [normalized, input.partyType, input.partyId],
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw new DomainError("CONFLICT", "Aynı ünvan ve tipte başka bir cari kartı zaten mevcut.");
    }

    const nextActive = input.isActive ?? beforeParty.rows[0].is_active;
    const upd = await client.query(
      `update public.parties
          set name = $2,
              normalized_name = $3,
              party_type = $4,
              is_active = $5
        where id = $1::uuid`,
      [input.partyId, input.name, normalized, input.partyType, nextActive],
    );

    await client.query(
      `insert into public.counterparty_profiles
         (party_id, tax_number, tax_office, address_line, city, country_code,
          credit_limit, payment_terms_days, contact_name, contact_email, contact_phone, notes)
       values ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (party_id) do update set
         tax_number = excluded.tax_number,
         tax_office = excluded.tax_office,
         address_line = excluded.address_line,
         city = excluded.city,
         country_code = excluded.country_code,
         credit_limit = excluded.credit_limit,
         payment_terms_days = excluded.payment_terms_days,
         contact_name = excluded.contact_name,
         contact_email = excluded.contact_email,
         contact_phone = excluded.contact_phone,
         notes = excluded.notes`,
      [
        input.partyId,
        input.taxNumber ?? null,
        input.taxOffice ?? null,
        input.addressLine ?? null,
        input.city ?? null,
        input.countryCode ?? "TR",
        input.creditLimit ?? null,
        input.paymentTermsDays ?? null,
        input.contactName ?? null,
        input.contactEmail ?? null,
        input.contactPhone ?? null,
        input.notes ?? null,
      ],
    );

    if (upd.rowCount === 1) {
      await audit(client, {
        actor: actorId,
        action: "update_counterparty",
        entityTable: "parties",
        entityId: input.partyId,
        before: beforeParty.rows[0],
        after: {
          name: input.name,
          partyType: input.partyType,
          isActive: nextActive,
          taxNumber: input.taxNumber ?? null,
          creditLimit: input.creditLimit ?? null,
          paymentTermsDays: input.paymentTermsDays ?? null,
        },
      });
    }

    await client.query("commit");
    return { partyId: input.partyId };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface UnifiedStatementRow {
  sourceId: string;
  movementDate: string;
  movementType: "invoice" | "allocation" | "check" | "bank";
  reference: string | null;
  direction: "sales" | "purchase" | "inflow" | "outflow";
  currency: string;
  debitAmount: number;
  creditAmount: number;
  runningBalance: number;
}

/**
 * M-36: Chronological Unified Counterparty Statement (Birleşik Cari Hesap Ekstresi)
 * combining `current_account_ledger` (`invoices` + `invoice_allocations`), unallocated `checks`,
 * and unallocated IBAN-linked `bank_transactions` with per-currency running balance.
 */
export async function loadUnifiedCounterpartyStatement(
  pool: Pool,
  partyId: string,
  limit = 250,
): Promise<UnifiedStatementRow[]> {
  const r = await pool.query<{
    source_id: string;
    movement_date: string;
    movement_type: "invoice" | "allocation" | "check" | "bank";
    reference: string | null;
    direction: "sales" | "purchase" | "inflow" | "outflow";
    currency: string;
    debit_amount: string;
    credit_amount: string;
  }>(
    `with unified as (
       select
         l.invoice_id::text as source_id,
         to_char(l.movement_date, 'YYYY-MM-DD') as movement_date,
         case when l.movement_type = 'invoice' then 'invoice' else 'allocation' end as movement_type,
         l.reference,
         l.direction::text as direction,
         coalesce(l.currency, i.currency, 'TRY') as currency,
         coalesce(l.debit_amount, 0)::text as debit_amount,
         coalesce(l.credit_amount, 0)::text as credit_amount
       from public.current_account_ledger l
       left join public.invoices i on i.id = l.invoice_id
       where l.party_id = $1::uuid

       union all

       select
         c.id::text as source_id,
         to_char(coalesce(c.maturity_date, c.created_at::date), 'YYYY-MM-DD') as movement_date,
         'check'::text as movement_type,
         coalesce(c.serial_no, 'Çek #' || left(c.id::text, 8)) as reference,
         c.direction::text as direction,
         coalesce(c.currency, 'TRY') as currency,
         case
           when c.payee_party_id = $1::uuid or c.endorsed_to_party_id = $1::uuid
             then coalesce(c.amount, 0)::text
           else '0'
         end as debit_amount,
         case
           when c.payer_party_id = $1::uuid and c.payee_party_id is distinct from $1::uuid
             then coalesce(c.amount, 0)::text
           else '0'
         end as credit_amount
       from public.checks c
       where c.archived_at is null
         and c.status <> 'cancelled'
         and (c.payer_party_id = $1::uuid or c.payee_party_id = $1::uuid or c.endorsed_to_party_id = $1::uuid)
         and not exists (
           select 1
             from public.invoice_allocations ia
            where ia.source_table = 'checks'
              and ia.source_id = c.id
              and ia.reversed_at is null
         )

       union all

       select
         bt.id::text as source_id,
         to_char(bt.txn_date, 'YYYY-MM-DD') as movement_date,
         'bank'::text as movement_type,
         coalesce(nullif(btrim(bt.reference_no), ''), left(bt.description, 42)) as reference,
         bt.direction::text as direction,
         coalesce(bt.currency, 'TRY') as currency,
         case when bt.amount < 0 then abs(bt.amount)::text else '0' end as debit_amount,
         case when bt.amount > 0 then bt.amount::text else '0' end as credit_amount
       from public.bank_transactions bt
       where bt.status <> 'ignored'
         and regexp_replace(upper(coalesce(bt.counterparty_iban_raw, '')), '\s+', '', 'g') in (
           select ib.iban_normalized
             from public.ibans ib
            where ib.party_id = $1::uuid
         )
         and not exists (
           select 1
             from public.invoice_allocations ia
            where ia.source_table = 'bank_transactions'
              and ia.source_id = bt.id
              and ia.reversed_at is null
         )
     )
     select source_id, movement_date,
            movement_type::text as movement_type,
            reference, direction, currency, debit_amount, credit_amount
       from unified
      order by movement_date asc, movement_type asc, source_id asc
      limit $2`,
    [partyId, limit],
  );

  const runningByCurrency = new Map<string, number>();
  return r.rows.map((row) => {
    const cur = row.currency || "TRY";
    const debit = moneyOrNull(row.debit_amount) ?? 0;
    const credit = moneyOrNull(row.credit_amount) ?? 0;
    const prev = runningByCurrency.get(cur) ?? 0;
    const next = Math.round((prev + debit - credit) * 100) / 100;
    runningByCurrency.set(cur, next);
    return {
      sourceId: row.source_id,
      movementDate: row.movement_date,
      movementType: row.movement_type,
      reference: row.reference,
      direction: row.direction,
      currency: cur,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance: next,
    };
  });
}

async function raiseIbanChangedControlAlertSafely(
  client: PoolClient,
  params: { ibanId: string; partyName: string; ibanNormalized: string },
  actorId: string | null,
): Promise<void> {
  try {
    await client.query("savepoint sp_iban_ctrl_alert");
    await raiseAlertWithClient(
      client,
      {
        checkCode: "iban_changed",
        severity: "critical",
        subjectTable: "ibans",
        subjectId: params.ibanId,
        subjectLabel: `${params.partyName} · ${params.ibanNormalized}`,
        title: `Yeni / doğrulanmamış IBAN kaydı: ${params.partyName} (${params.ibanNormalized})`,
        detail:
          "BEC Kalkanı: İkinci onay (maker-checker) tamamlanana kadar bu IBAN dışa ödeme ihracında bloklanır.",
        ruleCodes: ["iban_changed"],
      },
      actorId,
    );
    await client.query("release savepoint sp_iban_ctrl_alert");
  } catch (err) {
    await client.query("rollback to savepoint sp_iban_ctrl_alert").catch(() => undefined);
    await client.query("release savepoint sp_iban_ctrl_alert").catch(() => undefined);
    const code = (err as { code?: string } | null)?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === "42P01" || code === "42703" || msg.includes("beklenmeyen SQL")) {
      return;
    }
    throw err;
  }
}

/**
 * Ensures a counterparty's IBAN exists in `public.ibans` inside an active transaction, registering
 * it with full `new_iban_requires_approval` maker-checker + real-time `iban_changed` control alert
 * if not yet tracked.
 */
export async function ensurePartyIbanTrackedWithClient(
  client: PoolClient,
  params: {
    partyId: string;
    iban: string;
    currency: string;
    accountLabel?: string | null;
  },
  actorId: string,
): Promise<{ ibanId: string; created: boolean; approvalId: string | null }> {
  const inspection = inspectIban(params.iban);
  const existing = await client.query<{ id: string }>(
    `select id::text as id
       from public.ibans
      where party_id = $1::uuid
        and iban_normalized = $2
      limit 1`,
    [params.partyId, inspection.normalized],
  );
  if ((existing.rowCount ?? 0) > 0) {
    return { ibanId: existing.rows[0].id, created: false, approvalId: null };
  }

  const partyRes = await client.query<{ name: string }>(
    `select name from public.parties where id = $1::uuid`,
    [params.partyId],
  );
  if (partyRes.rowCount === 0) {
    throw new DomainError("NOT_FOUND", "IBAN tanımlanacak karşı taraf bulunamadı.");
  }
  const partyName = partyRes.rows[0].name;

  const ins = await client.query<{ id: string }>(
    `insert into public.ibans (party_id, iban, bank_name, account_label, currency, is_primary)
     values ($1::uuid, $2, null, $3, $4, false)
     returning id::text as id`,
    [params.partyId, inspection.normalized, params.accountLabel ?? null, params.currency],
  );
  const ibanId = ins.rows[0].id;

  const { approvalId } = await evaluateAndRequestIfNeededWithClient(client, {
    ruleInput: { subjectTable: "ibans", triggerKind: "new_iban", currency: params.currency },
    subjectId: ibanId,
    subjectLabel: `${partyName} · ${inspection.normalized}`,
    currency: params.currency,
    actorId,
  });
  if (approvalId) {
    await client.query(
      `update public.ibans set approval_status='pending_approval', approval_id=$2 where id=$1`,
      [ibanId, approvalId],
    );
    await raiseIbanChangedControlAlertSafely(
      client,
      { ibanId, partyName, ibanNormalized: inspection.normalized },
      actorId,
    );
  }

  await audit(client, {
    actor: actorId,
    action: "add_iban",
    entityTable: "ibans",
    entityId: ibanId,
    before: null,
    after: {
      partyId: params.partyId,
      ibanNormalized: inspection.normalized,
      checksumValid: inspection.checksumValid,
      isPrimary: false,
      approvalStatus: approvalId ? "pending_approval" : "approved",
      approvalId,
    },
  });

  return { ibanId, created: true, approvalId };
}

/**
 * Add a bank account.
 *
 * A failing checksum is REPORTED, not rejected: a real invoice can carry an IBAN this
 * implementation does not like, and refusing to record what the source says would violate the
 * preserve-the-source rule. The warning travels back to the operator and the row is written.
 * Migration 0037's trigger records the change independently of this function.
 *
 * Faz 48 (D2): Live BEC fraud shield — when `new_iban_requires_approval` is active in
 * `public.approval_rules`, the newly added IBAN starts in `approval_status = 'pending_approval'`
 * with a maker-checker `approvals` round AND a real-time `iban_changed` `control_alerts` finding
 * opened in the same transaction; outbound `pain.001` / EFT export is strictly blocked until a
 * second pair of eyes approves it.
 */
export async function addIban(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ ibanId: string; warnings: string[]; approvalId?: string | null }> {
  const input = parseOrThrow(addIbanSchema, raw, "IBAN formu");
  const inspection = inspectIban(input.iban);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const partyRes = await client.query<{ name: string }>(
      `select name from public.parties where id=$1`,
      [input.partyId],
    );
    if (partyRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Karşı taraf bulunamadı.");
    }
    const partyName = partyRes.rows[0].name;

    const dup = await client.query(
      `select 1 from public.ibans where party_id=$1 and iban_normalized=$2`,
      [input.partyId, normalizeIban(input.iban)],
    );
    if ((dup.rowCount ?? 0) > 0) {
      throw new DomainError("Bu IBAN bu karşı tarafta zaten kayıtlı.");
    }
    if (input.isPrimary) {
      // At most one primary per party (0037's partial unique index). Demote the incumbent in
      // the same transaction so the index never sees two.
      await client.query(`update public.ibans set is_primary=false where party_id=$1 and is_primary`, [input.partyId]);
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.ibans (party_id, iban, bank_name, account_label, currency, is_primary)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [input.partyId, input.iban, input.bankName ?? null, input.accountLabel ?? null, input.currency, input.isPrimary],
    );
    const ibanId = ins.rows[0].id;

    const { approvalId } = await evaluateAndRequestIfNeededWithClient(client, {
      ruleInput: { subjectTable: "ibans", triggerKind: "new_iban", currency: input.currency },
      subjectId: ibanId,
      subjectLabel: `${partyName} · ${inspection.normalized}`,
      currency: input.currency,
      actorId,
    });
    if (approvalId) {
      await client.query(
        `update public.ibans set approval_status='pending_approval', approval_id=$2 where id=$1`,
        [ibanId, approvalId],
      );
      await raiseIbanChangedControlAlertSafely(
        client,
        { ibanId, partyName, ibanNormalized: inspection.normalized },
        actorId,
      );
    }

    await audit(client, {
      actor: actorId, action: "add_iban", entityTable: "ibans", entityId: ibanId,
      before: null,
      after: {
        partyId: input.partyId, ibanNormalized: inspection.normalized,
        checksumValid: inspection.checksumValid, isPrimary: input.isPrimary,
        approvalStatus: approvalId ? "pending_approval" : "approved",
        approvalId,
      },
    });

    await client.query("commit");
    return { ibanId, warnings: inspection.warnings, approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function deactivateIban(pool: Pool, ibanId: string, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, party_id, iban_normalized, is_active, is_primary from public.ibans where id=$1 for update`,
      [ibanId],
    );
    if (before.rowCount === 0) throw new DomainError("IBAN bulunamadı.");
    if (!before.rows[0].is_active) throw new DomainError("Bu IBAN zaten pasif.");

    // Deactivate rather than delete: 0037 keeps a history either way, but a soft flag leaves
    // the row joinable from any record that referenced it.
    await client.query(`update public.ibans set is_active=false, is_primary=false where id=$1`, [ibanId]);
    await audit(client, {
      actor: actorId, action: "deactivate_iban", entityTable: "ibans", entityId: ibanId,
      before: before.rows[0], after: { is_active: false, is_primary: false },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Link a check's raw counterparty label to an existing party — the reviewed, explicit act that
 * a migration is not allowed to perform.
 *
 * `counterparty_label` is NOT cleared. The raw text is source evidence (CLAUDE.md: preserve
 * every source value, keep traceability), and the resolved FK is an interpretation layered on
 * top of it. Deleting the label would destroy the only record of what the workbook said.
 */
export async function linkCheckCounterparty(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(linkCounterpartySchema, raw, "Karşı taraf eşleştirmesi");
  const column = input.role === "payee" ? "payee_party_id" : "payer_party_id";

  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, counterparty_label, payee_party_id, payer_party_id from public.checks where id=$1 for update`,
      [input.checkId],
    );
    if (before.rowCount === 0) throw new DomainError("Çek bulunamadı.");

    const party = await client.query(`select id, name from public.parties where id=$1`, [input.partyId]);
    if (party.rowCount === 0) throw new DomainError("Karşı taraf bulunamadı.");

    await client.query(`update public.checks set ${column}=$2 where id=$1`, [input.checkId, input.partyId]);

    await audit(client, {
      actor: actorId, action: "link_check_counterparty", entityTable: "checks", entityId: input.checkId,
      before: before.rows[0],
      after: {
        role: input.role, partyId: input.partyId, partyName: party.rows[0].name,
        // Recorded explicitly so the trail shows the label was kept, not replaced.
        counterparty_label_preserved: before.rows[0].counterparty_label,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── minimal organizational dimensions (Faz 19 scope: reference data only) ─────────────── */

export type DimensionTable = "cost_centers" | "departments" | "projects" | "products" | "orders";
const DIMENSION_TABLES: readonly DimensionTable[] = ["cost_centers", "departments", "projects", "products", "orders"];

export const dimensionSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  notes: optionalTrimmedString,
});

export async function listDimension(pool: Pool, table: DimensionTable, limit = 200) {
  if (!DIMENSION_TABLES.includes(table)) throw new DomainError("Bilinmeyen boyut tablosu.");
  // `orders` has no `name` column — it is reference data keyed by code (see migration 0038).
  const nameExpr = table === "orders" ? "coalesce(notes, code)" : "name";
  const r = await pool.query(
    `select id::text, code, ${nameExpr} as name, is_active,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD') as created_at
     from public.${table} order by code limit $1`,
    [limit],
  );
  return r.rows as Array<{ id: string; code: string; name: string; is_active: boolean; created_at: string }>;
}

export async function createDimension(
  pool: Pool,
  table: DimensionTable,
  raw: unknown,
  actorId: string,
): Promise<{ id: string }> {
  if (!DIMENSION_TABLES.includes(table)) throw new DomainError("Bilinmeyen boyut tablosu.");
  const input = parseOrThrow(dimensionSchema, raw, "Boyut kaydı");
  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    const exists = await client.query(`select 1 from public.${table} where code=$1`, [input.code]);
    if ((exists.rowCount ?? 0) > 0) throw new DomainError(`"${input.code}" kodu bu tabloda zaten var.`);

    // orders carries no name column; its descriptive text goes to notes.
    const ins =
      table === "orders"
        ? await client.query<{ id: string }>(
            `insert into public.orders (code, notes) values ($1,$2) returning id`,
            [input.code, input.notes ?? input.name],
          )
        : await client.query<{ id: string }>(
            `insert into public.${table} (code, name, notes) values ($1,$2,$3) returning id`,
            [input.code, input.name, input.notes ?? null],
          );

    await audit(client, {
      actor: actorId, action: `create_${table.replace(/s$/, "")}`, entityTable: table,
      entityId: ins.rows[0].id, before: null, after: input,
    });
    await client.query("commit");
    return { id: ins.rows[0].id };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Explicit operator-upload / authorized-sync party resolver inside an active transaction.
 * Centralizes `public.parties` creation inside `counterparties/engine.ts` so every write
 * entry point shares exact TR-locale normalization (`toLocaleLowerCase("tr-TR")`).
 */
export async function resolveOrCreateOperatorPartyWithClient(
  client: PoolClient,
  name: unknown,
  partyType: string,
): Promise<string | null> {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;

  const normalized = trimmed.toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");

  const found = await client.query<{ id: string }>(
    "select id from public.parties where normalized_name = $1 and party_type = $2",
    [normalized, partyType],
  );
  if (found.rowCount && found.rows[0]) return found.rows[0].id;

  const created = await client.query<{ id: string }>(
    `insert into public.parties (name, normalized_name, party_type)
     values ($1, $2, $3)
     on conflict (normalized_name, party_type) do update set name = public.parties.name
     returning id`,
    [trimmed, normalized, partyType],
  );
  return created.rows[0].id;
}

export {
  COUNTERPARTY_SCORECARD_MODEL_CONSTANTS,
  COUNTERPARTY_TIER_LABEL,
  computeCounterpartyScorecard,
  loadCounterpartyScorecards,
  type CounterpartyBehavioralTier,
  type CounterpartyCheckBucket,
  type CounterpartyCheckExposureItem,
  type CounterpartyScorecard,
  type CounterpartyScorecardInput,
  type CounterpartyScorecardSignal,
  type LoadCounterpartyScorecardsOptions,
} from "./scorecard";
