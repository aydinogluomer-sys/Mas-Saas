import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseOrThrow } from "@/lib/validation";

export const RECONCILIATION_SCOPES = [
  "bank_cash",
  "ar_ap",
  "workbook_source",
  "trial_balance",
] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];

export const RECONCILIATION_SCOPE_LABEL: Record<ReconciliationScope, string> = {
  bank_cash: "Banka ve Kasa Mutabakatı",
  ar_ap: "Cari Alacak / Borç (AR/AP)",
  workbook_source: "Çalışma Kitabı ↔ Uygulama Nakit",
  trial_balance: "Yönetim Defteri ↔ Yasal Mizan",
};

export const signOffReconciliationSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "Dönem YYYY-AA veya YYYY-AA-01 olmalı"),
  scope: z.enum(RECONCILIATION_SCOPES),
  status: z.enum(["signed_clean", "signed_with_exceptions"]),
  openExceptionCount: z.coerce.number().int().min(0).default(0),
  notes: z.string().trim().max(1500).optional(),
});

export const createReconciliationTaskSchema = z.object({
  title: z.string().trim().min(3, "Görev başlığı en az 3 karakter olmalı").max(240),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
  relatedEntityTable: z.string().trim().max(80).nullable().optional(),
  relatedEntityId: z.uuid().nullable().optional(),
  note: z.string().trim().max(1500).optional(),
});

export function normalizePeriodMonth(raw: string): string {
  const ym = raw.slice(0, 7);
  return `${ym}-01`;
}

export async function signOffReconciliation(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(signOffReconciliationSchema, raw, "Dönem mutabakat imzalama");
  const periodMonth = normalizePeriodMonth(input.periodMonth);

  if (input.status === "signed_clean" && input.openExceptionCount > 0) {
    throw new DomainError(
      "VALIDATION",
      "Açık mutabakat farkı varken 'temiz imzalandı' seçilemez; 'istisnalı imzalandı' seçip gerekçe girin.",
    );
  }
  if (input.status === "signed_with_exceptions" && (!input.notes || !input.notes.trim())) {
    throw new DomainError(
      "VALIDATION",
      "İstisnalı mutabakat imzasında fark gerekçesi (not) zorunludur.",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.reconciliation_signoffs
         (period_month, scope, status, open_exception_count, notes, signed_by)
       values ($1::date, $2, $3, $4, $5, $6)
       returning id`,
      [
        periodMonth,
        input.scope,
        input.status,
        input.openExceptionCount,
        input.notes ?? null,
        actorId,
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "sign_off_reconciliation",
      entityTable: "reconciliation_signoffs",
      entityId: id,
      after: {
        periodMonth,
        scope: input.scope,
        status: input.status,
        openExceptionCount: input.openExceptionCount,
      },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    const err = e as { code?: string; message?: string };
    if (err.code === "23514") {
      throw new DomainError("VALIDATION", err.message ?? "Mutabakat imzası kısıt kontrolüne takıldı.");
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function createReconciliationTask(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(createReconciliationTaskSchema, raw, "Mutabakat görevi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
       values ($1, $2, 'open', 'control', $3, $4, $5, $6)
       returning id`,
      [
        input.title,
        input.severity,
        input.relatedEntityTable ?? null,
        input.relatedEntityId ?? null,
        input.note ?? null,
        actorId,
      ],
    );
    const id = ins.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_reconciliation_task",
      entityTable: "action_items",
      entityId: id,
      after: {
        title: input.title,
        severity: input.severity,
        sourceType: "control",
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

export async function listReconciliationSignoffs(pool: Pool, limit = 50) {
  const res = await pool.query(
    `select s.id,
            to_char(s.period_month, 'YYYY-MM') as period_month,
            s.scope,
            s.status,
            s.open_exception_count,
            s.notes,
            s.signed_by,
            to_char(s.signed_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as signed_at
       from public.reconciliation_signoffs s
      order by s.period_month desc, s.signed_at desc
      limit $1`,
    [limit],
  ).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "42P01") return { rows: [] };
    throw err;
  });
  return res.rows.map((r) => ({
    id: r.id as string,
    periodMonth: r.period_month as string,
    scope: r.scope as ReconciliationScope,
    status: r.status as "signed_clean" | "signed_with_exceptions",
    openExceptionCount: Number(r.open_exception_count ?? 0),
    notes: (r.notes as string | null) ?? null,
    signedBy: r.signed_by as string,
    signedAt: r.signed_at as string,
  }));
}

