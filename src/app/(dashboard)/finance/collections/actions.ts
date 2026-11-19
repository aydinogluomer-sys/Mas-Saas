"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  applyPain002StatusToPaymentRun,
  parsePain002StatusReport,
} from "@/lib/integrations/open-banking/pain002-status-parser";
import { postBalancedJournalEntry, safeReverseJournalForSourceWithClient } from "@/lib/ledger/posting-engine";
import { decimal, moneyOrNull, rateOrNull } from "@/lib/money";
import { formObject } from "@/lib/validation";
import { clearBadDebt, markBadDebt } from "@/lib/collections/engine";
import { formatMoney } from "@/lib/money-format";
import {
  approvePaymentRun,
  cancelPaymentRun,
  createPaymentRun,
  PAYMENT_RUN_TARGET_TYPES,
  submitPaymentRunForApproval,
  type PaymentRunTargetType,
} from "@/lib/payments/payment-runs";
import { istanbulDateISO } from "@/lib/reports/rules";

const BASE = "/finance/collections";

function redirectWithFlash(kind: "result" | "error", message: string): never {
  redirect(`${BASE}?${kind}=${encodeURIComponent(message)}`);
}

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function markBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  const f = formObject(formData);
  const pool = getPool();
  try {
    await markBadDebt(pool, f, session.id);

    // M-34: Post TDHP 128 / 120 + 654 / 129 doubtful receivable provision journal entry
    const invoiceId = String(f.invoiceId ?? "").trim();
    if (invoiceId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const invRes = await client.query<{
          invoice_no: string;
          currency: string;
          open_amt: string;
          party_name: string;
        }>(
          `select i.invoice_no, i.currency,
                  (coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.allocated_amount, 0), coalesce(i.paid_amount, 0)))::text as open_amt,
                  p.name as party_name
             from public.invoices i
             join public.parties p on p.id = i.party_id
            where i.id = $1::uuid`,
          [invoiceId],
        );
        if (invRes.rowCount === 1) {
          const inv = invRes.rows[0];
          const openNative = Math.max(0, moneyOrNull(inv.open_amt) ?? 0);
          let openTry = openNative;
          if (inv.currency !== "TRY" && openNative > 0) {
            const fx = await client.query<{ rate: string }>(
              `select rate::text from public.fx_rates
                where base_currency = $1 and quote_currency = 'TRY'
                order by rate_date desc limit 1`,
              [inv.currency],
            );
            openTry = Number(decimal(openNative).times(rateOrNull(fx.rows[0]?.rate) ?? 1).round(2).toFixed(2));
          }

          let provisionJeId: string | null = null;
          if (openTry > 0) {
            await client.query("savepoint doubtful_je_sp");
            try {
              const je = await postBalancedJournalEntry(
                client,
                {
                  entryDate: istanbulDateISO(),
                  description: `Şüpheli ticari alacak karşılık fişi (128/129/654): ${inv.invoice_no} · ${inv.party_name}`,
                  sourceType: "doubtful_provision",
                  sourceTable: "invoices",
                  sourceId: invoiceId,
                  lines: [
                    { accountCode: "128", debit: openTry, credit: 0, memo: "Şüpheli ticari alacaklara virman" },
                    { accountCode: "120", debit: 0, credit: openTry, memo: "Normal alıcı hesabından çıkış" },
                    { accountCode: "654", debit: openTry, credit: 0, memo: "Şüpheli alacak karşılık gideri" },
                    { accountCode: "129", debit: 0, credit: openTry, memo: "Şüpheli ticari alacaklar karşılığı (-)" },
                  ],
                },
                session.id,
              );
              provisionJeId = je.entryId;
              await client.query("release savepoint doubtful_je_sp");
            } catch {
              await client.query("rollback to savepoint doubtful_je_sp");
              await client.query("release savepoint doubtful_je_sp");
            }
          }

          await client.query("savepoint doubtful_col_sp");
          try {
            await client.query(
              `update public.invoices
                  set is_doubtful = true,
                      doubtful_provision_entry_id = coalesce($2::uuid, doubtful_provision_entry_id)
                where id = $1::uuid`,
              [invoiceId, provisionJeId],
            );
            await client.query("release savepoint doubtful_col_sp");
          } catch {
            await client.query("rollback to savepoint doubtful_col_sp");
            await client.query("release savepoint doubtful_col_sp");
          }
        }
        await client.query("commit");
      } catch {
        await client.query("rollback").catch(() => {});
      } finally {
        client.release();
      }
    }
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/ledger");
  redirect(`${BASE}?result=supheli-alacak-ve-128-129-karsilik-fisi-islendi`);
}

export async function clearBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  const f = formObject(formData);
  const pool = getPool();
  try {
    await clearBadDebt(pool, f, session.id);

    const invoiceId = String(f.invoiceId ?? "").trim();
    if (invoiceId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await safeReverseJournalForSourceWithClient(
          client,
          "doubtful_provision",
          invoiceId,
          `Şüpheli alacak işareti kaldırıldı: ${String(f.reason ?? "")}`,
          session.id,
        );
        await client.query("savepoint clear_doubtful_col_sp");
        try {
          await client.query(
            `update public.invoices
                set is_doubtful = false,
                    doubtful_provision_entry_id = null
              where id = $1::uuid`,
            [invoiceId],
          );
          await client.query("release savepoint clear_doubtful_col_sp");
        } catch {
          await client.query("rollback to savepoint clear_doubtful_col_sp");
          await client.query("release savepoint clear_doubtful_col_sp");
        }
        await client.query("commit");
      } catch {
        await client.query("rollback").catch(() => {});
      } finally {
        client.release();
      }
    }
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/ledger");
  redirect(`${BASE}?result=isaret-ve-128-129-karsilik-kaldirildi`);
}

function isPaymentRunTargetType(v: string): v is PaymentRunTargetType {
  return (PAYMENT_RUN_TARGET_TYPES as readonly string[]).includes(v);
}

export async function createPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "insert", BASE);
  const sourceBankAccountId = String(formData.get("sourceBankAccountId") ?? "").trim();
  const plannedExecutionDate = String(formData.get("plannedExecutionDate") ?? "").trim();
  const currency = String(formData.get("currency") ?? "TRY").trim().toUpperCase() || "TRY";
  const notes = String(formData.get("notes") ?? "").trim();
  const rawTargets = formData.getAll("selectedTargets").map((x) => String(x));

  const items: Array<{ targetType: PaymentRunTargetType; targetId: string }> = [];
  for (const token of rawTargets) {
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    const tType = token.slice(0, idx);
    const tId = token.slice(idx + 1);
    if (isPaymentRunTargetType(tType) && tId) {
      items.push({ targetType: tType, targetId: tId });
    }
  }

  if (items.length === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Ödeme paketi için en az bir uygun borç/ödeme kalemi seçin.")}`);
  }

  let summary = "";
  try {
    const res = await createPaymentRun(
      getPool(),
      {
        sourceBankAccountId,
        plannedExecutionDate,
        currency,
        notes: notes || undefined,
        items,
      },
      session.id,
      istanbulDateISO(),
    );
    const min14Label =
      res.simulation.projected14dMinCash == null
        ? "14g min kasa: bilinmiyor"
        : `14g min kasa: ${formatMoney(res.simulation.projected14dMinCash, currency)}`;
    const floorWarn = res.simulation.breachesCashFloor ? " [ASGARİ KASA TAMPONU AŞILDI]" : "";
    summary = `${res.runCode} oluşturuldu (${res.itemCount} kalem · ${formatMoney(res.totalAmount, currency)} · ${min14Label})${floorWarn}`;
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?runCurrency=${encodeURIComponent(currency)}&result=${encodeURIComponent(summary)}`);
}

export async function submitPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "update", BASE);
  try {
    await submitPaymentRunForApproval(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/data/approvals");
  redirect(`${BASE}?result=${encodeURIComponent("Ödeme paketi maker-checker onayına gönderildi.")}`);
}

export async function approvePaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("approvals", "update", BASE);
  const runId = String(formData.get("runId") ?? "").trim();
  const justification = String(formData.get("justification") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  let selfApproved = false;
  try {
    const res = await approvePaymentRun(
      getPool(),
      {
        runId,
        justification: justification || undefined,
        note: note || undefined,
      },
      session.id,
    );
    selfApproved = res.selfApprovedOverride;
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/data/approvals");
  redirect(
    `${BASE}?result=${encodeURIComponent(
      selfApproved
        ? "Ödeme paketi tek-operatör öz-onay istisnasıyla onaylandı; pain.001 / SEPA / SWIFT XML ihracına hazır."
        : "Ödeme paketi onaylandı; banka talimat dosyası indirilebilir.",
    )}`,
  );
}

export async function cancelPaymentRunAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payment_runs", "update", BASE);
  try {
    await cancelPaymentRun(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/data/approvals");
  redirect(`${BASE}?result=${encodeURIComponent("Ödeme paketi iptal edildi ve kalemler serbest bırakıldı.")}`);
}

const MAX_PAIN002_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

const uploadPain002Schema = z.object({
  runId: z.string().trim().uuid("Mutabakat yapılacak ödeme paketi kimliği geçersiz."),
});

export async function uploadPain002StatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  if (!can(session.role, "payment_runs", "update")) {
    redirectWithFlash("error", "ISO 20022 pain.002 ödeme akıbeti mutabakatı yetkiniz yok.");
  }

  const parsed = uploadPain002Schema.safeParse({
    runId: String(formData.get("runId") ?? "").trim(),
  });
  if (!parsed.success) {
    redirectWithFlash("error", parsed.error.issues[0]?.message ?? "Geçerli bir ödeme paketi seçin.");
  }

  const fileEntry = formData.get("pain002File");
  const xmlEntry = formData.get("pain002Xml");

  let xmlBuffer: Buffer | null = null;
  if (fileEntry instanceof File && fileEntry.size > 0) {
    if (fileEntry.size > MAX_PAIN002_UPLOAD_BYTES) {
      redirectWithFlash("error", "pain.002 XML dosyası en fazla 2 MB boyutunda olabilir.");
    }
    xmlBuffer = Buffer.from(await fileEntry.arrayBuffer());
  } else if (xmlEntry instanceof File && xmlEntry.size > 0) {
    if (xmlEntry.size > MAX_PAIN002_UPLOAD_BYTES) {
      redirectWithFlash("error", "pain.002 XML dosyası en fazla 2 MB boyutunda olabilir.");
    }
    xmlBuffer = Buffer.from(await xmlEntry.arrayBuffer());
  } else if (typeof xmlEntry === "string" && xmlEntry.trim().length > 0) {
    const rawBuf = Buffer.from(xmlEntry.trim(), "utf8");
    if (rawBuf.byteLength > MAX_PAIN002_UPLOAD_BYTES) {
      redirectWithFlash("error", "Yapıştırılan pain.002 XML içeriği 2 MB sınırını aşıyor.");
    }
    xmlBuffer = rawBuf;
  }

  if (!xmlBuffer || xmlBuffer.byteLength === 0) {
    redirectWithFlash(
      "error",
      "Banka pain.002 XML dosyasını seçin veya XML metnini alana yapıştırın.",
    );
  }

  let summaryMessage = "";
  try {
    const report = parsePain002StatusReport(xmlBuffer);
    const res = await applyPain002StatusToPaymentRun(
      getPool(),
      parsed.data.runId,
      xmlBuffer,
      session.id,
    );
    const rejectSuffix =
      res.unmatchedItems > 0 ? ` · ${res.unmatchedItems} eşleşmeyen referans` : "";
    summaryMessage = `${res.runCode} pain.002 (${report.messageId}) mutabakatı tamamlandı: ${res.settledItems} ACSC ödendi · ${res.rejectedItems} RJCT reddedildi · ${res.pendingItems} PDNG beklemede${rejectSuffix}`;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/payments");
  revalidatePath("/finance/bank");
  redirectWithFlash("result", summaryMessage);
}
