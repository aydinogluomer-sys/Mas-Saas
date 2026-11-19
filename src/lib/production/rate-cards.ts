import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { rate } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";

const num = (v: string | number | null | undefined) => (v == null || v === "" ? 0 : rate(v));
import {
  convertRateToTry,
  loadLatestSpotRatesToTry,
  normalizeCurrency,
  type Queryable,
  type SpotRateMap,
} from "./fx-rates";
import { WORK_CENTER_OPERATION_TYPES, type WorkCenterOperationType } from "./work-centers";

export interface CustomerRateCardRow {
  id: string;
  partyId: string | null;
  partyName: string | null;
  customerLabel: string;
  displayCustomerName: string;
  workCenterId: string | null;
  workCenterCode: string | null;
  operationType: WorkCenterOperationType;
  ratePerMinute: number;
  currency: string;
  ratePerMinuteTry: number | null;
  fxRateUsed: number | null;
  missingFxRate: boolean;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}

export interface CustomerRateCardsOverview {
  cards: CustomerRateCardRow[];
  activeCount: number;
  foreignCurrencyCount: number;
  missingFxCount: number;
}

export function resolveRateCardRow(
  raw: {
    id: string;
    partyId: string | null;
    partyName: string | null;
    customerLabel: string;
    workCenterId: string | null;
    workCenterCode: string | null;
    operationType: WorkCenterOperationType;
    ratePerMinute: number;
    currency: string;
    validFrom: string;
    validTo: string | null;
    isActive: boolean;
  },
  spotRates: SpotRateMap,
): CustomerRateCardRow {
  const conv = convertRateToTry(raw.ratePerMinute, raw.currency, spotRates);
  const displayCustomerName = (raw.partyName?.trim() || raw.customerLabel.trim()) || "Genel Kontrat";
  return {
    ...raw,
    currency: conv.currency,
    displayCustomerName,
    ratePerMinuteTry: conv.rateTry,
    fxRateUsed: conv.fxRateUsed,
    missingFxRate: conv.missingFxRate,
  };
}

export const customerRateCardUpsertSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  partyId: z.string().uuid().optional().nullable(),
  customerLabel: z.string().trim().min(1, "Müşteri / Kontrat etiketi zorunlu").max(160),
  workCenterId: z.string().uuid().optional().nullable(),
  operationType: z.enum(WORK_CENTER_OPERATION_TYPES),
  ratePerMinute: z.coerce.number().positive("Dakika tarifesi 0'dan büyük olmalı"),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Geçerli para birimi seçin (TRY/USD/EUR)").default("TRY"),
  validFrom: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Başlangıç tarihi YYYY-MM-DD olmalı")
    .optional(),
  validTo: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Bitiş tarihi YYYY-MM-DD olmalı")
    .optional()
    .nullable(),
  isActive: z.boolean().optional().default(true),
});

export async function loadActivePartiesForProduction(
  client: Queryable,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await client.query<{ id: string; name: string }>(
      `select id::text, name
         from public.parties
        where archived_at is null
        order by name asc
        limit 250`,
    );
    return res.rows ?? [];
  } catch {
    return [];
  }
}

export async function loadCustomerRateCards(
  client: Queryable,
): Promise<CustomerRateCardsOverview> {
  const spotRates = await loadLatestSpotRatesToTry(client);
  try {
    const res = await client.query<{
      id: string;
      party_id: string | null;
      party_name: string | null;
      customer_label: string;
      work_center_id: string | null;
      work_center_code: string | null;
      operation_type: WorkCenterOperationType;
      rate_per_minute: string;
      currency: string;
      valid_from: string;
      valid_to: string | null;
      is_active: boolean;
    }>(
      `select
         rc.id::text,
         rc.party_id::text,
         pa.name as party_name,
         rc.customer_label,
         rc.work_center_id::text,
         wc.code as work_center_code,
         rc.operation_type,
         rc.rate_per_minute::text,
         rc.currency,
         to_char(rc.valid_from, 'YYYY-MM-DD') as valid_from,
         to_char(rc.valid_to, 'YYYY-MM-DD') as valid_to,
         rc.is_active
       from public.customer_rate_cards rc
       left join public.parties pa on pa.id = rc.party_id
       left join public.work_centers wc on wc.id = rc.work_center_id
       order by rc.is_active desc, coalesce(pa.name, rc.customer_label) asc, rc.operation_type asc`,
    );

    const cards = (res.rows ?? []).map((r) =>
      resolveRateCardRow(
        {
          id: r.id,
          partyId: r.party_id,
          partyName: r.party_name,
          customerLabel: r.customer_label,
          workCenterId: r.work_center_id,
          workCenterCode: r.work_center_code,
          operationType: r.operation_type,
          ratePerMinute: num(r.rate_per_minute),
          currency: r.currency,
          validFrom: r.valid_from,
          validTo: r.valid_to,
          isActive: r.is_active,
        },
        spotRates,
      ),
    );

    const active = cards.filter((c) => c.isActive);
    return {
      cards,
      activeCount: active.length,
      foreignCurrencyCount: active.filter((c) => c.currency !== "TRY").length,
      missingFxCount: active.filter((c) => c.missingFxRate).length,
    };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01" || code === "42703") {
      return {
        cards: [],
        activeCount: 0,
        foreignCurrencyCount: 0,
        missingFxCount: 0,
      };
    }
    throw err;
  }
}

export async function upsertCustomerRateCard(
  pool: Pool,
  rawInput: unknown,
  actorId: string | null,
): Promise<{ id: string }> {
  const input = parseOrThrow(
    customerRateCardUpsertSchema,
    rawInput,
    "Müşteri tarife kartı formu",
  );
  const currency = normalizeCurrency(input.currency);
  const validFrom = input.validFrom ?? new Date().toISOString().slice(0, 10);
  if (input.validTo && input.validTo < validFrom) {
    throw new DomainError("Bitiş tarihi geçerlilik başlangıç tarihinden önce olamaz.");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (input.id) {
      const beforeRes = await client.query(
        `select id::text, party_id::text, customer_label, work_center_id::text,
                operation_type, rate_per_minute::text, currency,
                to_char(valid_from, 'YYYY-MM-DD') as valid_from,
                to_char(valid_to, 'YYYY-MM-DD') as valid_to, is_active
           from public.customer_rate_cards
          where id = $1
          for update`,
        [input.id],
      );
      if (beforeRes.rowCount !== 1) {
        throw new DomainError("Müşteri tarife kartı bulunamadı.");
      }

      const upd = await client.query<{ id: string }>(
        `update public.customer_rate_cards
            set party_id = $2,
                customer_label = $3,
                work_center_id = $4,
                operation_type = $5,
                rate_per_minute = $6,
                currency = $7,
                valid_from = $8::date,
                valid_to = $9::date,
                is_active = $10,
                updated_at = now()
          where id = $1
          returning id::text`,
        [
          input.id,
          input.partyId ?? null,
          input.customerLabel,
          input.workCenterId ?? null,
          input.operationType,
          input.ratePerMinute,
          currency,
          validFrom,
          input.validTo ?? null,
          input.isActive,
        ],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("Müşteri tarife kartı güncellenemedi.");
      }

      await audit(client, {
        actor: actorId,
        action: "update_customer_rate_card",
        entityTable: "customer_rate_cards",
        entityId: upd.rows[0].id,
        before: beforeRes.rows[0],
        after: { ...input, currency, validFrom },
      });

      await client.query("commit");
      return { id: upd.rows[0].id };
    }

    const ins = await client.query<{ id: string }>(
      `insert into public.customer_rate_cards
         (party_id, customer_label, work_center_id, operation_type,
          rate_per_minute, currency, valid_from, valid_to, is_active)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9)
       returning id::text`,
      [
        input.partyId ?? null,
        input.customerLabel,
        input.workCenterId ?? null,
        input.operationType,
        input.ratePerMinute,
        currency,
        validFrom,
        input.validTo ?? null,
        input.isActive,
      ],
    );
    if (ins.rowCount !== 1) {
      throw new DomainError("Müşteri tarife kartı kaydedilemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "create_customer_rate_card",
      entityTable: "customer_rate_cards",
      entityId: ins.rows[0].id,
      after: { ...input, currency, validFrom },
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

export async function toggleCustomerRateCardActive(
  pool: Pool,
  id: string,
  isActive: boolean,
  actorId: string | null,
): Promise<void> {
  const parsed = parseOrThrow(
    z.object({ id: z.string().uuid("Geçersiz tarife kartı ID"), isActive: z.boolean() }),
    { id, isActive },
    "Müşteri tarife kartı durum formu",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const beforeRes = await client.query<{ customer_label: string; is_active: boolean }>(
      `select customer_label, is_active from public.customer_rate_cards where id = $1 for update`,
      [parsed.id],
    );
    if (beforeRes.rowCount !== 1) {
      throw new DomainError("Müşteri tarife kartı bulunamadı.");
    }
    const upd = await client.query(
      `update public.customer_rate_cards set is_active = $2, updated_at = now() where id = $1`,
      [parsed.id, parsed.isActive],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("Müşteri tarife kartı durumu güncellenemedi.");
    }
    await audit(client, {
      actor: actorId,
      action: parsed.isActive ? "activate_customer_rate_card" : "deactivate_customer_rate_card",
      entityTable: "customer_rate_cards",
      entityId: parsed.id,
      before: beforeRes.rows[0],
      after: { customer_label: beforeRes.rows[0].customer_label, is_active: parsed.isActive },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
