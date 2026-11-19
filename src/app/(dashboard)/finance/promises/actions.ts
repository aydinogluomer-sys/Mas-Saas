"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";
import { createPromise, detectBrokenPromises, resolvePromise } from "@/lib/collections/promises-engine";
import { moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/finance/promises";

function revalidateAll(): void {
  revalidatePath(PAGE);
  revalidatePath("/finance/collections");
  revalidatePath("/finance/receivables");
  revalidatePath("/insights");
  revalidatePath("/insights/tasks");
}

function fail(e: unknown): never {
  if (e instanceof DomainError) {
    revalidateAll();
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function createPromiseAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "insert", PAGE);
  try {
    await createPromise(getPool(), {
      partyId: String(formData.get("partyId") ?? ""),
      invoiceId: String(formData.get("invoiceId") ?? "").trim() || null,
      promisedAmount: numOrNull(formData.get("promisedAmount")),
      currency: String(formData.get("currency") ?? "TRY"),
      promisedDate: String(formData.get("promisedDate") ?? ""),
      channel: String(formData.get("channel") ?? "phone"),
      note: String(formData.get("note") ?? "").trim() || undefined,
    }, session.id);
  } catch (e) { fail(e); }
  revalidateAll();
  redirect(`${PAGE}?result=created`);
}

export async function resolvePromiseAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "update", PAGE);
  const promiseId = String(formData.get("promiseId") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim() || undefined;
  const keptAmount = numOrNull(formData.get("keptAmount"));
  const nextPromiseDateRaw = String(formData.get("nextPromiseDate") ?? "").trim();

  const pool = getPool();
  let carriedRemainder = 0;
  try {
    // M-35: If partial amount is collected, keep the settled portion & roll over the remainder into an open follow-up promise
    let origRow: {
      party_id: string;
      invoice_id: string | null;
      promised_amount: number | null;
      currency: string;
      channel: string;
      promised_date: string;
    } | null = null;

    if (status === "kept" && keptAmount != null && keptAmount > 0) {
      const r = await pool.query<{
        party_id: string;
        invoice_id: string | null;
        promised_amount: string | null;
        currency: string;
        channel: string;
        promised_date: string;
      }>(
        `select party_id::text, invoice_id::text, promised_amount::text, currency, channel,
                to_char(promised_date, 'YYYY-MM-DD') as promised_date
           from public.promise_to_pay
          where id = $1::uuid`,
        [promiseId],
      );
      if (r.rowCount === 1) {
        origRow = {
          party_id: r.rows[0].party_id,
          invoice_id: r.rows[0].invoice_id,
          promised_amount: moneyOrNull(r.rows[0].promised_amount),
          currency: r.rows[0].currency || "TRY",
          channel: r.rows[0].channel || "phone",
          promised_date: r.rows[0].promised_date,
        };
      }
    }

    const partialSuffix =
      origRow && origRow.promised_amount != null && keptAmount != null && keptAmount < origRow.promised_amount - 0.01
        ? `[Kısmi Tahsilat: ${keptAmount.toFixed(2)} / ${origRow.promised_amount.toFixed(2)} ${origRow.currency}]`
        : "";

    await resolvePromise(
      pool,
      {
        promiseId,
        status,
        note: [note, partialSuffix].filter(Boolean).join(" ") || undefined,
      },
      session.id,
    );

    if (origRow && origRow.promised_amount != null && keptAmount != null && keptAmount < origRow.promised_amount - 0.01) {
      carriedRemainder = Math.round((origRow.promised_amount - keptAmount) * 100) / 100;
      const defaultNextDate = new Date(Date.parse(`${istanbulDateISO()}T00:00:00Z`) + 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      await createPromise(
        pool,
        {
          partyId: origRow.party_id,
          invoiceId: origRow.invoice_id,
          promisedAmount: carriedRemainder,
          currency: origRow.currency,
          promisedDate: nextPromiseDateRaw || defaultNextDate,
          channel: origRow.channel,
          note: `Kısmi ödeme (${keptAmount.toFixed(2)} ${origRow.currency}) sonrası kalan bakiye devri`,
        },
        session.id,
      );
    }
  } catch (e) {
    fail(e);
  }
  revalidateAll();
  redirect(
    `${PAGE}?result=${carriedRemainder > 0 ? "partial-kept" : "resolved"}${carriedRemainder > 0 ? `&rem=${carriedRemainder}` : ""}`,
  );
}

/**
 * M-35: 3-Stage Dunning Workflow (1. Hatırlatma -> 2. Resmi İhtarname -> Hukuki Takip).
 */
export async function escalateDunningAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("action_items", "insert", PAGE);
  const promiseId = String(formData.get("promiseId") ?? "").trim();
  const stage = String(formData.get("stage") ?? "reminder_1").trim();
  const customNote = String(formData.get("note") ?? "").trim();

  const STAGE_META: Record<string, { label: string; severity: "medium" | "high" | "critical" }> = {
    reminder_1: { label: "1. Kademe — Nazik Ödeme Hatırlatması", severity: "medium" },
    warning_2: { label: "2. Kademe — Resmi Vade İhtarnamesi", severity: "high" },
    legal_notice: { label: "3. Kademe — Hukuki Takip & İcra Dosyası Hazırlığı", severity: "critical" },
  };
  const meta = STAGE_META[stage] ?? STAGE_META.reminder_1;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pr = await client.query<{
      id: string;
      party_name: string;
      promised_amount: string | null;
      currency: string;
      promised_date: string;
    }>(
      `select p.id::text, pa.name as party_name, p.promised_amount::text, p.currency,
              to_char(p.promised_date, 'YYYY-MM-DD') as promised_date
         from public.promise_to_pay p
         join public.parties pa on pa.id = p.party_id
        where p.id = $1::uuid`,
      [promiseId],
    );
    if (pr.rowCount !== 1) throw new DomainError("Ödeme sözü bulunamadı.");
    const row = pr.rows[0];
    const amtStr = row.promised_amount ? `${row.promised_amount} ${row.currency}` : "tutarı belirsiz";
    const title = `[${meta.label}] ${row.party_name} (${amtStr})`;
    const bodyNote =
      customNote ||
      `Söz tarihi: ${row.promised_date} · Kademe: ${meta.label} tetiklendi.`;

    const ins = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
       values ($1, $2, 'open', 'collection', 'promise_to_pay', $3::uuid, $4, $5::uuid)
       on conflict (source_type, related_entity_table, related_entity_id)
         where status in ('open', 'in_progress') and related_entity_id is not null
       do update set
         title = excluded.title,
         severity = excluded.severity,
         note = excluded.note
       returning id::text`,
      [title, meta.severity, promiseId, bodyNote, session.id],
    );
    if (ins.rowCount === 1) {
      await audit(client, {
        actor: session.id,
        action: "escalate_dunning_stage",
        entityTable: "action_items",
        entityId: ins.rows[0].id,
        after: { promiseId, stage, severity: meta.severity, partyName: row.party_name },
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    fail(e);
  } finally {
    client.release();
  }

  revalidateAll();
  redirect(`${PAGE}?result=dunning-escalated`);
}

export async function detectBrokenAction(): Promise<void> {
  const session = await requireActionPermission("promise_to_pay", "update", PAGE);
  const result = await detectBrokenPromises(getPool(), istanbulDateISO(), session.id);
  revalidateAll();
  redirect(`${PAGE}?result=detected&n=${result.markedBroken}`);
}
