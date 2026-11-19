import type { Pool, PoolClient } from "pg";
import { cookies } from "next/headers";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";

export const ACTIVE_LEGAL_ENTITY_COOKIE = "mas_active_legal_entity";
export const ACTIVE_BRANCH_COOKIE = "mas_active_branch";
export const CONSOLIDATED_ENTITY_TOKEN = "consolidated";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LegalEntityRecord {
  id: string;
  code: string;
  name: string;
  taxIdVkn: string | null;
  mersisNo: string | null;
  taxOffice: string | null;
  baseCurrency: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface BranchRecord {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  city: string | null;
  isHeadquarters: boolean;
  isActive: boolean;
}

export interface ActiveEntityScope {
  mode: "consolidated" | "entity";
  legalEntityId: string | null;
  branchId: string | null;
  activeEntity: LegalEntityRecord | null;
  activeBranch: BranchRecord | null;
  entities: LegalEntityRecord[];
  branches: BranchRecord[];
}

interface RawLegalEntityRow {
  id: string;
  code: string;
  name: string;
  tax_id_vkn: string | null;
  mersis_no: string | null;
  tax_office: string | null;
  base_currency: string;
  is_default: boolean;
  is_active: boolean;
  created_at: Date | string;
}

interface RawBranchRow {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  city: string | null;
  is_headquarters: boolean;
  is_active: boolean;
}

function mapEntity(r: RawLegalEntityRow): LegalEntityRecord {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    taxIdVkn: r.tax_id_vkn,
    mersisNo: r.mersis_no,
    taxOffice: r.tax_office,
    baseCurrency: r.base_currency,
    isDefault: r.is_default,
    isActive: r.is_active,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

function mapBranch(r: RawBranchRow): BranchRecord {
  return {
    id: r.id,
    legalEntityId: r.legal_entity_id,
    code: r.code,
    name: r.name,
    city: r.city,
    isHeadquarters: r.is_headquarters,
    isActive: r.is_active,
  };
}

export async function readActiveLegalEntityCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(ACTIVE_LEGAL_ENTITY_COOKIE)?.value?.trim() ?? "";
    if (!raw || raw === CONSOLIDATED_ENTITY_TOKEN) return null;
    return UUID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function readActiveBranchCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const raw = jar.get(ACTIVE_BRANCH_COOKIE)?.value?.trim() ?? "";
    return UUID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function listLegalEntities(db: Pick<Pool, "query"> | PoolClient): Promise<LegalEntityRecord[]> {
  try {
    const res = await db.query<RawLegalEntityRow>(
      `select id, code, name, tax_id_vkn, mersis_no, tax_office, base_currency, is_default, is_active, created_at
         from public.legal_entities
        where is_active = true
        order by is_default desc, code asc`,
    );
    return res.rows.map(mapEntity);
  } catch {
    // Graceful fallback before 0116 cutover on canonical DB during rolling dev/tests
    return [];
  }
}

export async function listBranches(
  db: Pick<Pool, "query"> | PoolClient,
  legalEntityId?: string | null,
): Promise<BranchRecord[]> {
  try {
    const res = legalEntityId
      ? await db.query<RawBranchRow>(
          `select id, legal_entity_id, code, name, city, is_headquarters, is_active
             from public.branches
            where is_active = true and legal_entity_id = $1
            order by is_headquarters desc, code asc`,
          [legalEntityId],
        )
      : await db.query<RawBranchRow>(
          `select id, legal_entity_id, code, name, city, is_headquarters, is_active
             from public.branches
            where is_active = true
            order by is_headquarters desc, code asc`,
        );
    return res.rows.map(mapBranch);
  } catch {
    return [];
  }
}

export async function getActiveEntityScope(db: Pick<Pool, "query"> | PoolClient): Promise<ActiveEntityScope> {
  const [entities, cookieEntityId, cookieBranchId] = await Promise.all([
    listLegalEntities(db),
    readActiveLegalEntityCookie(),
    readActiveBranchCookie(),
  ]);
  const activeEntity = cookieEntityId ? (entities.find((e) => e.id === cookieEntityId) ?? null) : null;
  const branches = await listBranches(db, activeEntity?.id ?? null);
  const activeBranch =
    activeEntity && cookieBranchId
      ? (branches.find((b) => b.id === cookieBranchId && b.legalEntityId === activeEntity.id) ?? null)
      : null;

  return {
    mode: activeEntity ? "entity" : "consolidated",
    legalEntityId: activeEntity?.id ?? null,
    branchId: activeBranch?.id ?? null,
    activeEntity,
    activeBranch,
    entities,
    branches,
  };
}

const createLegalEntitySchema = z.object({
  code: z.string().trim().min(2).max(24).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  taxIdVkn: z.string().trim().max(20).optional().nullable(),
  mersisNo: z.string().trim().max(24).optional().nullable(),
  taxOffice: z.string().trim().max(120).optional().nullable(),
  baseCurrency: z.string().trim().regex(/^[A-Z]{3}$/).default("TRY"),
});

export async function createLegalEntity(
  pool: Pool,
  rawInput: unknown,
  actorUserId: string | null,
): Promise<LegalEntityRecord> {
  const parsed = createLegalEntitySchema.safeParse(rawInput);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "input").join(", ");
    throw new DomainError("VALIDATION_ERROR", `Geçersiz grup şirketi bilgisi (${fields}).`);
  }
  const input = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<RawLegalEntityRow>(
      `insert into public.legal_entities (code, name, tax_id_vkn, mersis_no, tax_office, base_currency, is_default, is_active)
       values ($1, $2, $3, $4, $5, $6, false, true)
       returning id, code, name, tax_id_vkn, mersis_no, tax_office, base_currency, is_default, is_active, created_at`,
      [
        input.code,
        input.name,
        input.taxIdVkn?.trim() || null,
        input.mersisNo?.trim() || null,
        input.taxOffice?.trim() || null,
        input.baseCurrency,
      ],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Grup şirketi oluşturulamadı.");
    }
    const created = mapEntity(res.rows[0]);
    await audit(client, {
      actor: actorUserId,
      action: "create_legal_entity",
      entityTable: "legal_entities",
      entityId: created.id,
      after: created,
    });
    await client.query("commit");
    return created;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const createBranchSchema = z.object({
  legalEntityId: z.string().uuid(),
  code: z.string().trim().min(2).max(24).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  city: z.string().trim().max(80).optional().nullable(),
  isHeadquarters: z.boolean().default(false),
});

export async function createBranch(
  pool: Pool,
  rawInput: unknown,
  actorUserId: string | null,
): Promise<BranchRecord> {
  const parsed = createBranchSchema.safeParse(rawInput);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "input").join(", ");
    throw new DomainError("VALIDATION_ERROR", `Geçersiz şube/tesis bilgisi (${fields}).`);
  }
  const input = parsed.data;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<RawBranchRow>(
      `insert into public.branches (legal_entity_id, code, name, city, is_headquarters, is_active)
       values ($1, $2, $3, $4, $5, true)
       returning id, legal_entity_id, code, name, city, is_headquarters, is_active`,
      [input.legalEntityId, input.code, input.name, input.city?.trim() || null, input.isHeadquarters],
    );
    if (res.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Şube oluşturulamadı.");
    }
    const created = mapBranch(res.rows[0]);
    await audit(client, {
      actor: actorUserId,
      action: "create_branch",
      entityTable: "branches",
      entityId: created.id,
      after: created,
    });
    await client.query("commit");
    return created;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
