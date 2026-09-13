// Faz 19 — counterparty (cari hesap) read/write engine.
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
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import { parseOrThrow } from "@/lib/validation";
import { inspectIban, normalizeIban } from "./rules";

/* ── schemas (Faz 18: one schema per action, at the boundary) ──────────────────────────── */

const PARTY_TYPES = [
  "company", "person", "bank", "provider", "customer", "vendor", "internal_owner", "unknown",
] as const;

export const createCounterpartySchema = z.object({
  name: z.string().trim().min(2, "En az 2 karakter olmalı"),
  partyType: z.enum(PARTY_TYPES).default("unknown"),
  taxNumber: z.string().trim().min(1).optional(),
  taxOffice: z.string().trim().min(1).optional(),
  addressLine: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default("TR"),
  creditLimit: z.coerce.number().min(0).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).optional(),
  contactName: z.string().trim().min(1).optional(),
  contactEmail: z.string().trim().min(1).optional(),
  contactPhone: z.string().trim().min(1).optional(),
  notes: z.string().trim().min(1).optional(),
});
export type CreateCounterpartyInput = z.infer<typeof createCounterpartySchema>;

export const addIbanSchema = z.object({
  partyId: z.uuid(),
  iban: z.string().trim().min(5),
  bankName: z.string().trim().min(1).optional(),
  accountLabel: z.string().trim().min(1).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
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
  const r = await pool.query(
    `select source, source_id::text as source_id, raw_label,
            to_char(due_date,'YYYY-MM-DD') as due_date, amount, status
     from public.counterparty_unresolved
     order by amount desc nulls last, raw_label
     limit $1`,
    [limit],
  );
  return r.rows.map((x) => ({
    source: x.source,
    sourceId: x.source_id,
    rawLabel: x.raw_label,
    dueDate: x.due_date,
    amount: moneyOrNull(x.amount),
    status: x.status,
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
  createdAt: string;
}

export async function loadIbans(pool: Pool, partyId: string): Promise<IbanRow[]> {
  const r = await pool.query(
    `select id::text, iban_normalized, bank_name, account_label, currency, is_primary, is_active,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
     from public.ibans where party_id=$1 order by is_primary desc, created_at`,
    [partyId],
  );
  return r.rows.map((x) => ({
    id: x.id, ibanNormalized: x.iban_normalized, bankName: x.bank_name,
    accountLabel: x.account_label, currency: x.currency,
    isPrimary: x.is_primary, isActive: x.is_active, createdAt: x.created_at,
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

export async function loadCounterpartyProfile(pool: Pool, partyId: string) {
  const r = await pool.query(
    `select party_id::text, tax_number, tax_office, address_line, city, country_code,
            credit_limit, credit_limit_currency, payment_terms_days,
            contact_name, contact_email, contact_phone, notes
     from public.counterparty_profiles where party_id=$1`,
    [partyId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    partyId: x.party_id, taxNumber: x.tax_number, taxOffice: x.tax_office,
    addressLine: x.address_line, city: x.city, countryCode: x.country_code,
    creditLimit: moneyOrNull(x.credit_limit), creditLimitCurrency: x.credit_limit_currency,
    paymentTermsDays: intOrNull(x.payment_terms_days),
    contactName: x.contact_name, contactEmail: x.contact_email, contactPhone: x.contact_phone,
    notes: x.notes,
  };
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
): Promise<{ partyId: string }> {
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

    await audit(client, {
      actor: actorId,
      action: "create_counterparty",
      entityTable: "parties",
      entityId: partyId,
      before: null,
      after: { name: input.name, partyType: input.partyType, hasProfile: true },
    });

    await client.query("commit");
    return { partyId };
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

/**
 * Add a bank account.
 *
 * A failing checksum is REPORTED, not rejected: a real invoice can carry an IBAN this
 * implementation does not like, and refusing to record what the source says would violate the
 * preserve-the-source rule. The warning travels back to the operator and the row is written.
 * Migration 0037's trigger records the change independently of this function.
 */
export async function addIban(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ ibanId: string; warnings: string[] }> {
  const input = parseOrThrow(addIbanSchema, raw, "IBAN formu");
  const inspection = inspectIban(input.iban);

  const client = await pool.connect();
  try {
    await client.query("begin");

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

    await audit(client, {
      actor: actorId, action: "add_iban", entityTable: "ibans", entityId: ins.rows[0].id,
      before: null,
      after: {
        partyId: input.partyId, ibanNormalized: inspection.normalized,
        checksumValid: inspection.checksumValid, isPrimary: input.isPrimary,
      },
    });

    await client.query("commit");
    return { ibanId: ins.rows[0].id, warnings: inspection.warnings };
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
  notes: z.string().trim().min(1).optional(),
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
