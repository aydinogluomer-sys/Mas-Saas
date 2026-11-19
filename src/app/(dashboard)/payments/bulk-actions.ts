"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  toUserActionErrorMessage,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { createPaymentRun } from "@/lib/payments/payment-runs";
import { markInstancePaid } from "@/lib/radar/engine";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { istanbulDateISO } from "@/lib/time/istanbul";
import { formatIssues } from "@/lib/validation";

export type BulkTriageInstanceActionKind =
  | "create_run"
  | "shift_7d"
  | "shift_14d"
  | "mark_paid";

export type FlexibilityClassValue = "critical" | "flexible" | "optional";

export interface BulkPaymentActionResult {
  ok: boolean;
  count: number;
  message: string;
}

const bulkTriageSchema = z.object({
  instanceIds: z
    .array(z.uuid("Geçersiz ödeme örneği kimliği."))
    .min(1, "En az bir ödeme kalemi seçilmelidir.")
    .max(200, "Tek seferde en fazla 200 ödeme kalemi işlenebilir."),
  action: z.enum(["create_run", "shift_7d", "shift_14d", "mark_paid"]),
});

const bulkFlexibilitySchema = z.object({
  paymentIds: z
    .array(z.uuid("Geçersiz ödeme kalemi kimliği."))
    .min(1, "En az bir ödeme kalemi seçilmelidir.")
    .max(200, "Tek seferde en fazla 200 ödeme kalemi güncellenebilir."),
  flexibilityClass: z.enum(["critical", "flexible", "optional"]),
});

const FLEX_LABELS: Record<FlexibilityClassValue, string> = {
  critical: "Kritik",
  flexible: "Esnek",
  optional: "İsteğe Bağlı",
};

function isNextRouterInterrupt(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND"))
  );
}

function normalizeActionErrorMessage(err: unknown, fallback: string): string {
  try {
    translatePeriodLockError(err);
  } catch (translated) {
    if (translated instanceof DomainError) {
      return translated.message;
    }
    return toUserActionErrorMessage(translated, fallback);
  }
}

function revalidatePaymentSurfaces(): void {
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/payments/calendar");
  revalidatePath("/cashflow");
  revalidatePath("/");
  revalidateFinancialViews();
}

export async function bulkTriagePaymentInstancesAction(input: {
  instanceIds: string[];
  action: BulkTriageInstanceActionKind;
}): Promise<BulkPaymentActionResult> {
  await requireSession();
  const parsed = bulkTriageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      count: 0,
      message: formatIssues(parsed.error),
    };
  }

  const uniqueIds = [...new Set(parsed.data.instanceIds)];
  const { action } = parsed.data;

  try {
    if (action === "create_run") {
      const session = await requireActionPermission("payment_runs", "insert", "/payments");
      const pool = getPool();
      const todayISO = istanbulDateISO();

      const [instRes, bankRes] = await Promise.all([
        pool.query<{
          id: string;
          currency: string;
          amount: string | null;
          paid_amount: string | null;
          status: string;
          direction: string;
          approval_status: string;
          template_iban: string | null;
          party_iban_id: string | null;
          party_iban: string | null;
          in_active_run: boolean;
        }>(
          `select pi.id::text as id,
                  coalesce(pi.currency, 'TRY') as currency,
                  pi.amount::text as amount,
                  pi.paid_amount::text as paid_amount,
                  pi.status,
                  coalesce(pi.direction, p.direction, 'outflow') as direction,
                  coalesce(pi.approval_status, 'not_required') as approval_status,
                  nullif(trim(coalesce(to_jsonb(p)->>'iban', '')), '') as template_iban,
                  ib.id::text as party_iban_id,
                  ib.iban_normalized as party_iban,
                  exists (
                    select 1
                      from public.payment_run_items pri
                     where pri.target_type = 'payment_instance'
                       and pri.target_id = pi.id
                       and pri.status = 'included'
                  ) as in_active_run
             from public.payment_instances pi
             left join public.payments p on p.id = pi.payment_id
             left join lateral (
               select i.id, i.iban_normalized
                 from public.ibans i
                where i.party_id = p.provider_party_id
                  and i.is_active = true
                  and i.currency = coalesce(pi.currency, 'TRY')
                order by i.is_primary desc, (i.approval_status = 'approved') desc, i.created_at asc
                limit 1
             ) ib on true
            where pi.id = any($1::uuid[])
              and pi.cancelled_at is null
              and pi.status in ('unpaid', 'planned', 'late', 'partial')
            order by pi.due_date asc`,
          [uniqueIds],
        ),
        pool.query<{ id: string; currency: string }>(
          `select ba.cash_account_id::text as id,
                  coalesce(ca.currency, 'TRY') as currency
             from public.bank_accounts ba
             join public.cash_accounts ca on ca.id = ba.cash_account_id
            where ca.is_active = true
            order by ca.created_at asc`,
        ),
      ]);

      if (instRes.rows.length === 0) {
        return {
          ok: false,
          count: 0,
          message: "Seçilen kayıtlar arasında açık ödeme kalemi bulunamadı.",
        };
      }

      let skippedMissingAmount = 0;
      let skippedInRun = 0;
      let skippedApproval = 0;
      let skippedMissingIban = 0;

      const byCurrency = new Map<
        string,
        Array<{
          id: string;
          partyIbanId: string | null;
          templateIban: string | null;
        }>
      >();

      for (const row of instRes.rows) {
        if (row.direction !== "outflow") continue;
        const amt = row.amount == null ? null : Number(row.amount);
        const paid = row.paid_amount == null ? 0 : Number(row.paid_amount);
        if (amt == null || amt <= 0 || amt - paid <= 0) {
          skippedMissingAmount += 1;
          continue;
        }
        if (row.in_active_run) {
          skippedInRun += 1;
          continue;
        }
        if (row.approval_status === "pending_approval" || row.approval_status === "rejected") {
          skippedApproval += 1;
          continue;
        }
        if (!row.party_iban && !row.template_iban) {
          skippedMissingIban += 1;
          continue;
        }
        const ccy = row.currency.toUpperCase();
        const group = byCurrency.get(ccy) ?? [];
        group.push({
          id: row.id,
          partyIbanId: row.party_iban_id,
          templateIban: row.template_iban,
        });
        byCurrency.set(ccy, group);
      }

      const bankByCurrency = new Map<string, string>();
      for (const b of bankRes.rows) {
        const ccy = b.currency.toUpperCase();
        if (!bankByCurrency.has(ccy)) {
          bankByCurrency.set(ccy, b.id);
        }
      }

      if (byCurrency.size === 0) {
        const reasons: string[] = [];
        if (skippedMissingAmount > 0) reasons.push(`${skippedMissingAmount} tutar eksik`);
        if (skippedMissingIban > 0) reasons.push(`${skippedMissingIban} aktif IBAN eksik`);
        if (skippedInRun > 0) reasons.push(`${skippedInRun} zaten aktif pakette`);
        if (skippedApproval > 0) reasons.push(`${skippedApproval} onay bekliyor/reddedildi`);
        return {
          ok: false,
          count: 0,
          message:
            reasons.length > 0
              ? `Taslak paket oluşturulamadı (${reasons.join(" · ")}). Önce karşı taraf IBAN veya eksik tutar bilgisini tamamlayın.`
              : "Seçilen kalemler ödeme paketine alınmaya uygun değil.",
        };
      }

      const sortedCurrencies = [...byCurrency.keys()].sort((a, b) =>
        a === "TRY" ? -1 : b === "TRY" ? 1 : a.localeCompare(b),
      );

      let packagedCount = 0;
      const runCodes: string[] = [];
      const missingBankCurrencies: string[] = [];

      for (const ccy of sortedCurrencies) {
        const items = byCurrency.get(ccy) ?? [];
        if (items.length === 0) continue;
        const sourceBankAccountId = bankByCurrency.get(ccy);
        if (!sourceBankAccountId) {
          missingBankCurrencies.push(ccy);
          continue;
        }

        const run = await createPaymentRun(
          pool,
          {
            sourceBankAccountId,
            plannedExecutionDate: todayISO,
            currency: ccy,
            notes: `Toplu Seçim Paketi — ${todayISO}`,
            items: items.map((it) => ({
              targetType: "payment_instance" as const,
              targetId: it.id,
              ...(it.partyIbanId
                ? { ibanId: it.partyIbanId }
                : it.templateIban
                  ? { beneficiaryIban: it.templateIban }
                  : {}),
            })),
          },
          session.id,
          todayISO,
        );
        packagedCount += run.itemCount;
        runCodes.push(run.runCode);
      }

      if (packagedCount === 0) {
        return {
          ok: false,
          count: 0,
          message: `${missingBankCurrencies.join(", ") || "TRY"} dövizinde aktif kaynak banka hesabı bulunamadı — Banka Merkezi'nden aktif hesap tanımlayın.`,
        };
      }

      revalidatePaymentSurfaces();

      const skippedNotes: string[] = [];
      if (skippedMissingAmount > 0) skippedNotes.push(`${skippedMissingAmount} tutar eksik`);
      if (skippedMissingIban > 0) skippedNotes.push(`${skippedMissingIban} IBAN eksik`);
      if (skippedInRun > 0) skippedNotes.push(`${skippedInRun} pakette`);
      if (missingBankCurrencies.length > 0) {
        skippedNotes.push(`${missingBankCurrencies.join("/")} banka hesabı yok`);
      }

      return {
        ok: true,
        count: packagedCount,
        message: `Taslak ödeme paketi (${runCodes.join(", ")}) oluşturuldu — ${packagedCount} kalem paketlendi.${
          skippedNotes.length > 0 ? ` (${skippedNotes.join(" · ")} atlandı)` : ""
        }`,
      };
    }

    if (action === "shift_7d" || action === "shift_14d") {
      const session = await requireActionPermission("payment_instances", "update", "/payments");
      const days = action === "shift_7d" ? 7 : 14;
      const pool = getPool();
      const client = await pool.connect();

      let shiftedCount = 0;
      try {
        await client.query("begin");
        const beforeRes = await client.query<{
          id: string;
          due_date: string;
          status: string;
        }>(
          `select id::text as id,
                  to_char(due_date, 'YYYY-MM-DD') as due_date,
                  status
             from public.payment_instances
            where id = any($1::uuid[])
              and cancelled_at is null
              and status in ('unpaid', 'planned', 'late')
            for update`,
          [uniqueIds],
        );

        if (beforeRes.rows.length === 0) {
          await client.query("rollback");
          return {
            ok: false,
            count: 0,
            message:
              "Seçilen kayıtlar arasında vadesi kaydırılabilecek açık ('unpaid', 'planned', 'late') kalem bulunamadı.",
          };
        }

        const updateSql =
          days === 7
            ? `update public.payment_instances
                  set due_date = (due_date + interval '7 days')::date
                where id = any($1::uuid[])
                  and cancelled_at is null
                  and status in ('unpaid', 'planned', 'late')
               returning id::text as id, to_char(due_date, 'YYYY-MM-DD') as due_date, status`
            : `update public.payment_instances
                  set due_date = (due_date + interval '14 days')::date
                where id = any($1::uuid[])
                  and cancelled_at is null
                  and status in ('unpaid', 'planned', 'late')
               returning id::text as id, to_char(due_date, 'YYYY-MM-DD') as due_date, status`;

        const updRes = await client.query<{
          id: string;
          due_date: string;
          status: string;
        }>(updateSql, [uniqueIds]);

        shiftedCount = updRes.rowCount ?? 0;

        await audit(client, {
          actor: session.id,
          action: days === 7 ? "bulk_shift_due_7d" : "bulk_shift_due_14d",
          entityTable: "payment_instances",
          entityId: shiftedCount === 1 ? updRes.rows[0]?.id ?? null : null,
          before: beforeRes.rows,
          after: {
            shiftDays: days,
            count: shiftedCount,
            rows: updRes.rows,
          },
        });

        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        translatePeriodLockError(err);
      } finally {
        client.release();
      }

      revalidatePaymentSurfaces();
      return {
        ok: true,
        count: shiftedCount,
        message: `${shiftedCount} ödeme kaleminin vadesi +${days} gün ertelendi.`,
      };
    }

    // action === "mark_paid"
    const session = await requireActionPermission("payment_instances", "update", "/payments");
    const pool = getPool();
    const candidatesRes = await pool.query<{
      id: string;
      amount: string | null;
      status: string;
    }>(
      `select id::text as id,
              amount::text as amount,
              status
         from public.payment_instances
        where id = any($1::uuid[])
          and cancelled_at is null
          and status in ('unpaid', 'planned', 'late', 'partial')
        order by due_date asc`,
      [uniqueIds],
    );

    if (candidatesRes.rows.length === 0) {
      return {
        ok: false,
        count: 0,
        message: "Seçilen kayıtlar arasında ödenebilir açık ödeme kalemi bulunamadı.",
      };
    }

    const knownRows = candidatesRes.rows.filter((r) => r.amount != null);
    const missingAmountCount = candidatesRes.rows.length - knownRows.length;

    if (knownRows.length === 0) {
      return {
        ok: false,
        count: 0,
        message: `Seçilen ${missingAmountCount} kalemin tutarı eksik (TUTAR EKSİK — asla 0 TL varsayılmaz). Önce tutar girilmelidir.`,
      };
    }

    let paidCount = 0;
    let firstError: string | null = null;
    let failedCount = 0;

    for (const row of knownRows) {
      try {
        await markInstancePaid(pool, row.id, null, session.id);
        paidCount += 1;
      } catch (err) {
        failedCount += 1;
        if (!firstError) {
          firstError = normalizeActionErrorMessage(err, "Ödeme kalemi kapatılamadı.");
        }
      }
    }

    if (paidCount === 0) {
      return {
        ok: false,
        count: 0,
        message: firstError ?? "Seçilen kalemler ödendi işaretlenemedi.",
      };
    }

    revalidatePaymentSurfaces();

    const disclosures: string[] = [];
    if (missingAmountCount > 0) {
      disclosures.push(`${missingAmountCount} tutarı eksik kalem R10 gereği atlandı`);
    }
    if (failedCount > 0) {
      disclosures.push(`${failedCount} kalem onay/kilit nedeniyle atlandı`);
    }

    return {
      ok: true,
      count: paidCount,
      message: `${paidCount} ödeme kalemi ödendi olarak işaretlendi.${
        disclosures.length > 0 ? ` (${disclosures.join(" · ")})` : ""
      }`,
    };
  } catch (err) {
    if (isNextRouterInterrupt(err)) throw err;
    return {
      ok: false,
      count: 0,
      message: normalizeActionErrorMessage(err, "Toplu ödeme işlemi tamamlanamadı."),
    };
  }
}

export async function bulkSetFlexibilityClassAction(input: {
  paymentIds: string[];
  flexibilityClass: FlexibilityClassValue;
}): Promise<BulkPaymentActionResult> {
  const session = await requireActionPermission("payments", "update", "/payments/items");
  const parsed = bulkFlexibilitySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      count: 0,
      message: formatIssues(parsed.error),
    };
  }

  const uniqueIds = [...new Set(parsed.data.paymentIds)];
  const { flexibilityClass } = parsed.data;

  try {
    const pool = getPool();
    const client = await pool.connect();

    let updatedCount = 0;
    try {
      await client.query("begin");
      const beforeRes = await client.query<{
        id: string;
        name: string;
        flexibility_class: string | null;
      }>(
        `select id::text as id, name, flexibility_class
           from public.payments
          where id = any($1::uuid[])
            and status <> 'archived'
          for update`,
        [uniqueIds],
      );

      if (beforeRes.rows.length === 0) {
        await client.query("rollback");
        return {
          ok: false,
          count: 0,
          message: "Güncellenecek aktif ödeme kalemi bulunamadı.",
        };
      }

      const updRes = await client.query<{ id: string }>(
        `update public.payments
            set flexibility_class = $1,
                updated_at = now()
          where id = any($2::uuid[])
            and status <> 'archived'
         returning id::text as id`,
        [flexibilityClass, uniqueIds],
      );

      updatedCount = updRes.rowCount ?? 0;

      await audit(client, {
        actor: session.id,
        action: "bulk_set_flexibility_class",
        entityTable: "payments",
        entityId: updatedCount === 1 ? updRes.rows[0]?.id ?? null : null,
        before: beforeRes.rows,
        after: {
          flexibility_class: flexibilityClass,
          count: updatedCount,
          paymentIds: updRes.rows.map((r) => r.id),
        },
      });

      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      translatePeriodLockError(err);
    } finally {
      client.release();
    }

    revalidatePath("/payments");
    revalidatePath("/payments/items");
    revalidatePath("/scenarios");

    return {
      ok: true,
      count: updatedCount,
      message: `${updatedCount} ödeme kaleminin esneklik sınıfı "${FLEX_LABELS[flexibilityClass]}" olarak güncellendi.`,
    };
  } catch (err) {
    if (isNextRouterInterrupt(err)) throw err;
    return {
      ok: false,
      count: 0,
      message: normalizeActionErrorMessage(err, "Esneklik sınıfı güncellenemedi."),
    };
  }
}
