// Faz 52 (E2) — TDHP Uyumlu Yönetim Hesap Planı (management_accounts) Sorgulama,
// Alt Hesap Açma (120.01, 102.01, 300.01) ve EBITDA Kovası Sınıflandırma Modülü.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseOrThrow } from "@/lib/validation";

export const ACCOUNT_CLASSES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "contra_revenue",
  "cogs",
  "opex",
  "finance_expense",
  "other_income_expense",
  "off_balance",
] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

export const NORMAL_SIDES = ["debit", "credit"] as const;
export type NormalSide = (typeof NORMAL_SIDES)[number];

export const EBITDA_BUCKETS = [
  "revenue",
  "cogs",
  "opex",
  "da_addback",
  "financing",
  "tax",
  "non_operating",
  "balance_sheet",
] as const;
export type EbitdaBucket = (typeof EBITDA_BUCKETS)[number];

export interface ManagementAccountRow {
  id: string;
  code: string;
  name: string;
  parentCode: string | null;
  accountClass: AccountClass;
  normalSide: NormalSide;
  ebitdaBucket: EbitdaBucket;
  tdhpRootCode: string;
  isActive: boolean;
}

export interface TdhpClassification {
  tdhpRootCode: string;
  parentCode: string | null;
  accountClass: AccountClass;
  normalSide: NormalSide;
  ebitdaBucket: EbitdaBucket;
}

/**
 * Deterministically infers TDHP root code, class, normal side, and EBITDA bucket
 * from any standard Turkish Uniform Chart of Accounts (Tekdüzen Hesap Planı) code.
 */
export function inferTdhpClassification(rawCode: string): TdhpClassification {
  const clean = rawCode.trim();
  const parts = clean.split(".");
  const rootMatch = parts[0]?.match(/^(\d{3})/);
  if (!rootMatch) {
    throw new DomainError(`Geçersiz TDHP hesap kodu: "${rawCode}" (3 haneli kök kodla başlamalıdır, ör. 120 veya 120.01).`);
  }
  const root = rootMatch[1];
  const rootNum = Number(root);
  const parentCode = parts.length > 1 ? parts.slice(0, -1).join(".") : null;

  // Amortisman alt hesabı (770.99 / 730.99 / 632.99)
  if (clean.endsWith(".99") && (root === "770" || root === "730" || root === "632")) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "opex",
      normalSide: "debit",
      ebitdaBucket: "da_addback",
    };
  }

  // 1xx Dönen Varlıklar & 2xx Duran Varlıklar
  if (rootNum >= 100 && rootNum < 300) {
    const isContraAsset = root === "103" || root === "122" || root === "129" || root === "257" || root === "268";
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "asset",
      normalSide: isContraAsset ? "credit" : "debit",
      ebitdaBucket: "balance_sheet",
    };
  }

  // 3xx Kısa Vadeli Yabancı Kaynaklar & 4xx Uzun Vadeli Yabancı Kaynaklar
  if (rootNum >= 300 && rootNum < 500) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "liability",
      normalSide: "credit",
      ebitdaBucket: "balance_sheet",
    };
  }

  // 5xx Özkaynaklar
  if (rootNum >= 500 && rootNum < 600) {
    const isLossOrContra = root === "591" || root === "580" || root === "501";
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "equity",
      normalSide: isLossOrContra ? "debit" : "credit",
      ebitdaBucket: "balance_sheet",
    };
  }

  // 60x Brüt Satışlar
  if (root === "600" || root === "601" || root === "602") {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "revenue",
      normalSide: "credit",
      ebitdaBucket: "revenue",
    };
  }

  // 61x Satış İndirimleri (-)
  if (root === "610" || root === "611" || root === "612") {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "contra_revenue",
      normalSide: "debit",
      ebitdaBucket: "revenue",
    };
  }

  // 62x Satışların Maliyeti (-) & 710-740 Üretim Maliyet Hesapları
  if ((rootNum >= 620 && rootNum <= 629) || (rootNum >= 710 && rootNum <= 749)) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "cogs",
      normalSide: "debit",
      ebitdaBucket: "cogs",
    };
  }

  // 63x & 750-770 Faaliyet Giderleri (-)
  if ((rootNum >= 630 && rootNum <= 639) || (rootNum >= 750 && rootNum <= 779)) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "opex",
      normalSide: "debit",
      ebitdaBucket: "opex",
    };
  }

  // 64x Diğer Faaliyetlerden Olağan Gelir ve Kârlar
  if (rootNum >= 640 && rootNum <= 649) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "other_income_expense",
      normalSide: "credit",
      ebitdaBucket: "non_operating",
    };
  }

  // 65x Diğer Faaliyetlerden Olağan Gider ve Zararlar (-)
  if (rootNum >= 650 && rootNum <= 659) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "other_income_expense",
      normalSide: "debit",
      ebitdaBucket: "non_operating",
    };
  }

  // 66x & 780 Finansman Giderleri (-)
  if ((rootNum >= 660 && rootNum <= 669) || root === "780") {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "finance_expense",
      normalSide: "debit",
      ebitdaBucket: "financing",
    };
  }

  // 691 Vergi Karşılıkları
  if (root === "691") {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "other_income_expense",
      normalSide: "debit",
      ebitdaBucket: "tax",
    };
  }

  // 67x-69x Olağandışı / Dönem Kâr-Zarar
  if (rootNum >= 670 && rootNum <= 699) {
    const isDebit = rootNum >= 680 && rootNum <= 689;
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "other_income_expense",
      normalSide: isDebit ? "debit" : "credit",
      ebitdaBucket: "non_operating",
    };
  }

  // 9xx Nazım Hesaplar
  if (rootNum >= 900 && rootNum <= 999) {
    return {
      tdhpRootCode: root,
      parentCode,
      accountClass: "off_balance",
      normalSide: rootNum % 2 === 0 ? "debit" : "credit",
      ebitdaBucket: "balance_sheet",
    };
  }

  throw new DomainError(`TDHP sınıflandırması çözümlenemeyen hesap kodu: "${rawCode}".`);
}

export const createManagementSubAccountSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{3}(\.[A-Za-z0-9_]+)*$/, "Hesap kodu 3 haneli TDHP köküyle başlamalıdır (ör. 120.01 veya 102.01)."),
  name: z.string().trim().min(2, "Hesap adı en az 2 karakter olmalıdır."),
  accountClass: z.enum(ACCOUNT_CLASSES).optional(),
  normalSide: z.enum(NORMAL_SIDES).optional(),
  ebitdaBucket: z.enum(EBITDA_BUCKETS).optional(),
});

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

export async function loadManagementAccounts(
  db: Pool | PoolClient,
): Promise<ManagementAccountRow[]> {
  const res = await db
    .query<{
      id: string;
      code: string;
      name: string;
      parent_code: string | null;
      account_class: AccountClass;
      normal_side: NormalSide;
      ebitda_bucket: EbitdaBucket;
      tdhp_root_code: string;
      is_active: boolean;
    }>(
      `select id::text, code, name, parent_code, account_class, normal_side,
              ebitda_bucket, tdhp_root_code, is_active
         from public.management_accounts
        where is_active = true
        order by code asc`,
    )
    .catch((err: unknown) => {
      if (isMissingSchemaError(err)) {
        return { rows: [], rowCount: 0 };
      }
      throw err;
    });

  return res.rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    parentCode: r.parent_code,
    accountClass: r.account_class,
    normalSide: r.normal_side,
    ebitdaBucket: r.ebitda_bucket,
    tdhpRootCode: r.tdhp_root_code,
    isActive: r.is_active,
  }));
}

export async function getManagementAccountIdByCode(
  client: PoolClient,
  code: string,
): Promise<string> {
  const clean = code.trim();
  const res = await client.query<{ id: string }>(
    `select id::text from public.management_accounts where code = $1 limit 1`,
    [clean],
  );
  if (res.rows[0]?.id) return res.rows[0].id;
  throw new DomainError(`TDHP yönetim hesabı bulunamadı: "${clean}".`);
}

export async function createManagementSubAccount(
  pool: Pool,
  raw: unknown,
  actorId: string | null,
): Promise<ManagementAccountRow> {
  const input = parseOrThrow(createManagementSubAccountSchema, raw, "Alt hesap açma formu");
  const inferred = inferTdhpClassification(input.code);

  const accountClass = input.accountClass ?? inferred.accountClass;
  const normalSide = input.normalSide ?? inferred.normalSide;
  const ebitdaBucket = input.ebitdaBucket ?? inferred.ebitdaBucket;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{
      id: string;
      code: string;
      name: string;
      parent_code: string | null;
      account_class: AccountClass;
      normal_side: NormalSide;
      ebitda_bucket: EbitdaBucket;
      tdhp_root_code: string;
      is_active: boolean;
    }>(
      `insert into public.management_accounts
         (code, name, parent_code, account_class, normal_side, ebitda_bucket, tdhp_root_code)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (code) do update
         set name = excluded.name,
             is_active = true
       returning id::text, code, name, parent_code, account_class, normal_side,
                 ebitda_bucket, tdhp_root_code, is_active`,
      [
        input.code,
        input.name,
        inferred.parentCode,
        accountClass,
        normalSide,
        ebitdaBucket,
        inferred.tdhpRootCode,
      ],
    );
    const row = ins.rows[0];

    await audit(client, {
      actor: actorId,
      action: "upsert_management_account",
      entityTable: "management_accounts",
      entityId: row.id,
      after: {
        code: row.code,
        name: row.name,
        parentCode: row.parent_code,
        accountClass: row.account_class,
        normalSide: row.normal_side,
        ebitdaBucket: row.ebitda_bucket,
        tdhpRootCode: row.tdhp_root_code,
      },
    });

    await client.query("commit");
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      parentCode: row.parent_code,
      accountClass: row.account_class,
      normalSide: row.normal_side,
      ebitdaBucket: row.ebitda_bucket,
      tdhpRootCode: row.tdhp_root_code,
      isActive: row.is_active,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

