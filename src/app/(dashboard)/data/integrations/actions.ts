"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionPermission } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { createCounterparty } from "@/lib/counterparties/engine";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { importHybridBankStatement } from "@/lib/importers/bank-formats/mt940-camt053-parasut";
import { importUblTrUpload } from "@/lib/integrations/einvoice/ubl-tr-parser";
import { createConnection, enqueueSync } from "@/lib/integrations/engine";
import {
  normalizeParasutCurrency,
  replayDeferredParasutInvoices,
} from "@/lib/integrations/parasut/mappers";
import { runClosedLoopFinancialPipeline } from "@/lib/integrations/parasut/sync-pipeline";
import {
  parsePosSettlementPayload,
  persistPosSettlementBatches,
} from "@/lib/integrations/pos/pos-settlement-connector";
import { istanbulDateISO } from "@/lib/reports/rules";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { formObject, parseOrThrow } from "@/lib/validation";

const BASE = "/data/integrations";

function strField(v: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(v)) return (v[0] ?? fallback).trim();
  return (v ?? fallback).trim();
}

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  if (e instanceof Error && e.name === "ZodError") {
    redirect(`${BASE}?error=${encodeURIComponent(e.message.slice(0, 240))}`);
  }
  throw e;
}

export async function createIntegrationConnectionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("integration_connections", "insert", BASE);
  const f = formObject(formData);
  try {
    const config: Record<string, unknown> = {};
    const baseUrl = strField(f.baseUrl);
    const companyId = strField(f.companyId);
    const ownTaxNumber = strField(f.ownTaxNumber);
    const consentId = strField(f.consentId);
    const cashAccountId = strField(f.cashAccountId);
    const sinceDaysRaw = strField(f.sinceDays);
    if (baseUrl) config.baseUrl = baseUrl;
    if (companyId) config.companyId = companyId;
    if (ownTaxNumber) config.ownTaxNumber = ownTaxNumber;
    if (consentId) config.consentId = consentId;
    if (cashAccountId) config.cashAccountId = cashAccountId;
    if (sinceDaysRaw && Number.isFinite(Number(sinceDaysRaw))) {
      config.sinceDays = Number(sinceDaysRaw);
    }

    const credEnv = strField(f.credentialEnvVar);
    const syncIntervalRaw = strField(f.syncIntervalMinutes);
    await createConnection(
      getPool(),
      {
        integrationKind: strField(f.integrationKind, "accounting") || "accounting",
        name: strField(f.name),
        provider: strField(f.provider, "parasut") || "parasut",
        credentialEnvVar: credEnv || undefined,
        config,
        syncIntervalMinutes: syncIntervalRaw ? Number(syncIntervalRaw) : 60,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=baglanti-eklendi`);
}

export async function toggleIntegrationStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("integration_connections", "update", BASE);
  const f = formObject(formData);
  const connectionId = strField(f.connectionId);
  const nextStatus = strField(f.nextStatus) === "enabled" ? "enabled" : "disabled";
  if (!connectionId) {
    redirect(`${BASE}?error=${encodeURIComponent("Bağlantı kimliği gerekli.")}`);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query<{ status: string }>(
      `select status from public.integration_connections where id = $1 for update`,
      [connectionId],
    );
    if (!cur.rows[0]) {
      throw new DomainError("Entegrasyon bağlantısı bulunamadı.");
    }
    await client.query(
      `update public.integration_connections set status = $2 where id = $1`,
      [connectionId, nextStatus],
    );
    await audit(client, {
      actor: session.id,
      action: "toggle_integration_connection",
      entityTable: "integration_connections",
      entityId: connectionId,
      before: { status: cur.rows[0].status },
      after: { status: nextStatus },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    domainRedirect(e);
  } finally {
    client.release();
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=durum-guncellendi`);
}

export async function triggerIntegrationSyncAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "insert", BASE);
  const f = formObject(formData);
  const connectionId = strField(f.connectionId);
  if (!connectionId) {
    redirect(`${BASE}?error=${encodeURIComponent("Bağlantı kimliği gerekli.")}`);
  }
  try {
    const enq = await enqueueSync(getPool(), connectionId, session.id);
    if (!enq) {
      throw new DomainError("Senkron kuyruğa alınamadı — bağlantının 'enabled' durumda olduğundan emin olun.");
    }
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/system/jobs");
  redirect(`${BASE}?result=senkron-kuyruga-alindi`);
}

export async function saveAccountMappingAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("integration_account_mappings", "insert", BASE);
  const f = formObject(formData);
  const externalAccountId = strField(f.externalAccountId);
  if (!externalAccountId) {
    redirect(`${BASE}?error=${encodeURIComponent("Harici hesap kimliği gerekli.")}`);
  }

  const provider = strField(f.provider, "parasut") || "parasut";
  const externalAccountName = strField(f.externalAccountName) || null;
  const externalIban = strField(f.externalIban).replace(/\s+/g, "").toUpperCase() || null;
  const externalCurrency = normalizeParasutCurrency(strField(f.externalCurrency, "TRY"));
  const cashAccountId = strField(f.cashAccountId) || null;
  const bankAccountId = strField(f.bankAccountId) || cashAccountId;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.integration_account_mappings
         (provider, external_account_id, external_account_name, external_iban, external_currency, cash_account_id, bank_account_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (provider, external_account_id) do update
         set external_account_name = coalesce(excluded.external_account_name, public.integration_account_mappings.external_account_name),
             external_iban = coalesce(excluded.external_iban, public.integration_account_mappings.external_iban),
             external_currency = excluded.external_currency,
             cash_account_id = excluded.cash_account_id,
             bank_account_id = excluded.bank_account_id
       returning id::text`,
      [
        provider,
        externalAccountId,
        externalAccountName,
        externalIban,
        externalCurrency,
        cashAccountId,
        bankAccountId,
      ],
    );
    await audit(client, {
      actor: session.id,
      action: "upsert_integration_account_mapping",
      entityTable: "integration_account_mappings",
      entityId: res.rows[0].id,
      after: {
        provider,
        externalAccountId,
        externalIban,
        externalCurrency,
        cashAccountId,
        bankAccountId,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    domainRedirect(e);
  } finally {
    client.release();
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=hesap-eslemesi-kaydedildi`);
}

export async function resolveStagedPartyAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("integration_staged_parties", "update", BASE);
  const f = formObject(formData);
  const stagedId = strField(f.stagedId);
  const decision = strField(f.decision);
  if (!stagedId || !["create", "link", "ignore"].includes(decision)) {
    redirect(`${BASE}?error=${encodeURIComponent("Geçersiz cari inceleme kararı.")}`);
  }

  const pool = getPool();
  try {
    const stagedRes = await pool.query<{
      id: string;
      provider: string;
      external_contact_id: string;
      raw_name: string;
      tax_id: string | null;
      account_type: string | null;
    }>(
      `select id::text, provider, external_contact_id, raw_name, tax_id, account_type
         from public.integration_staged_parties
        where id = $1`,
      [stagedId],
    );
    const staged = stagedRes.rows[0];
    if (!staged) {
      throw new DomainError("İnceleme kuyruğunda cari aday kaydı bulunamadı.");
    }

    let resolvedPartyId: string | null = null;
    let nextStatus: "created" | "linked" | "ignored" = "ignored";

    if (decision === "create") {
      await requireActionPermission("parties", "insert", BASE);
      const partyType =
        staged.account_type === "customer"
          ? "customer"
          : staged.account_type === "vendor"
            ? "vendor"
            : "company";
      const created = await createCounterparty(
        pool,
        {
          name: staged.raw_name,
          partyType,
          taxNumber: staged.tax_id ?? undefined,
        },
        session.id,
      );
      resolvedPartyId = created.partyId;
      nextStatus = "created";
    } else if (decision === "link") {
      const targetPartyId = strField(f.partyId);
      if (!targetPartyId) {
        throw new DomainError("Eşleştirilecek mevcut cari seçilmelidir.");
      }
      resolvedPartyId = targetPartyId;
      nextStatus = "linked";
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update public.integration_staged_parties
            set status = $2,
                resolved_party_id = $3,
                reviewed_by = $4,
                reviewed_at = now()
          where id = $1`,
        [staged.id, nextStatus, resolvedPartyId, session.id],
      );
      let replayedInvoices = 0;
      if (resolvedPartyId) {
        await client.query(
          `insert into public.integration_entity_links
             (provider, resource_type, external_id, entity_table, entity_id, last_synced_at)
           values ($1, 'contacts', $2, 'parties', $3, now())
           on conflict (provider, resource_type, external_id) do update
             set entity_id = excluded.entity_id,
                 last_synced_at = now()`,
          [staged.provider, staged.external_contact_id, resolvedPartyId],
        );
        const replay = await replayDeferredParasutInvoices(client);
        replayedInvoices = replay.replayedUpserted;
      }
      await audit(client, {
        actor: session.id,
        action: "resolve_integration_staged_party",
        entityTable: "integration_staged_parties",
        entityId: staged.id,
        after: {
          decision,
          status: nextStatus,
          resolvedPartyId,
          externalContactId: staged.external_contact_id,
          replayedInvoices,
        },
      });
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/counterparties");
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/ledger");
  redirect(`${BASE}?result=cari-aday-islendi`);
}

const closedLoopFormSchema = z.object({
  todayISO: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Geçerli bir tarih (YYYY-AA-GG) giriniz")
    .optional(),
});

export async function runClosedLoopSyncAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("background_jobs", "insert", BASE);
  const raw = formObject(formData);
  const normalized = {
    todayISO: strField(raw.todayISO) || undefined,
  };

  let resultMessage = "kapali-cevrim-tamamlandi";
  try {
    const parsed = parseOrThrow(closedLoopFormSchema, normalized);
    const todayISO = parsed.todayISO ?? istanbulDateISO();
    const pool = getPool();
    const summary = await runClosedLoopFinancialPipeline(pool, session.id, {
      todayISO,
      triggerDueIntegrationSyncs: true,
      processEnqueuedJobs: true,
      syncTcmbFxRates: true,
      syncManagementLedger: true,
      freezeMonday13w: true,
    });
    await audit(pool, {
      actor: session.id,
      action: "manual_closed_loop_financial_sync",
      entityTable: "integration_sync_runs",
      entityId: null,
      after: {
        todayISO,
        ok: summary.ok,
        executedSteps: summary.executedSteps,
        enqueued: summary.integrationSyncs.enqueued,
        fxInserted: summary.fxSync.inserted,
        ledgerCreated: summary.managementLedger.createdCount,
        ledgerRevalued: summary.managementLedger.revaluedCount,
        snapshotId: summary.forecast13w.primarySnapshotId,
      },
    });
    resultMessage = `kapali-cevrim-tamamlandi (kur:${summary.fxSync.inserted}, defter:${summary.managementLedger.createdCount}+${summary.managementLedger.revaluedCount}, 13h:${summary.forecast13w.primarySnapshotId ? "hazir" : "yok"})`;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/system/jobs");
  revalidateFinancialViews();
  redirect(`${BASE}?result=${encodeURIComponent(resultMessage)}`);
}

export async function importHybridBankStatementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("bank_transactions", "insert", BASE);
  const bankAccountId = String(formData.get("bankAccountId") ?? "").trim();
  const file = formData.get("file");

  if (!bankAccountId) {
    redirect(`${BASE}?error=${encodeURIComponent("Banka hesabı seçilmelidir.")}`);
  }
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Yüklenecek MT940 / camt.053 / Excel dosyası seçilmelidir.")}`);
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const outcome = await importHybridBankStatement(getPool(), {
      buf,
      filename: file.name || "statement.mt940",
      bankAccountId,
      actorId: session.id,
    });
    if (!outcome.ok) {
      throw new DomainError(outcome.error ?? "Hibrit banka ekstresi ayrıştırılamadı.");
    }
  } catch (e) {
    domainRedirect(e);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/bank");
  redirect(`${BASE}?result=hibrit-ekstre-aktarildi`);
}

export async function importUblTrInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "insert", BASE);
  const file = formData.get("file");
  const defaultDirectionRaw = String(formData.get("defaultDirection") ?? "purchase").trim();
  const defaultDirection = defaultDirectionRaw === "sales" ? "sales" : "purchase";
  const ownTaxNumber = String(formData.get("ownTaxNumber") ?? "").trim() || null;

  if (!(file instanceof File) || file.size === 0) {
    redirect(
      `${BASE}?error=${encodeURIComponent("Yüklenecek GİB UBL-TR (.xml veya .zip) dosyası seçilmelidir.")}`,
    );
  }

  let resultMsg = "ubl-efatura-aktarildi";
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const summary = await importUblTrUpload(getPool(), {
      bytes,
      filename: file.name || "efatura.xml",
      defaultDirection,
      ownTaxNumber,
      actorId: session.id,
    });
    resultMsg = `ubl-efatura (aktarilan:${summary.importedCount}, cari-aday:${summary.stagedPartyCount}, mukerrer:${summary.duplicateCount})`;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/ledger");
  revalidatePath("/data/documents");
  revalidateFinancialViews();
  redirect(`${BASE}?result=${encodeURIComponent(resultMsg)}`);
}

const posUploadSchema = z.object({
  provider: z
    .string()
    .trim()
    .min(2, "POS sağlayıcısı seçilmelidir.")
    .max(40),
  cashAccountId: z.string().uuid("Geçerli bir banka/kasa hesabı seçin.").optional(),
});

export async function importPosSettlementBatchAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("pos_settlement_batches", "insert", BASE);
  const rawProvider = String(formData.get("provider") ?? "iyzico").trim().toLowerCase();
  const rawCashAccount = String(formData.get("cashAccountId") ?? "").trim();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    redirect(
      `${BASE}?error=${encodeURIComponent("Yüklenecek POS gün sonu hakediş dosyası (.csv veya .json) seçilmelidir.")}`,
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    redirect(
      `${BASE}?error=${encodeURIComponent("POS hakediş dosyası en fazla 10 MB olabilir.")}`,
    );
  }

  let resultMsg = "pos-hakedis-aktarildi";
  try {
    const parsedInput = parseOrThrow(posUploadSchema, {
      provider: rawProvider || "iyzico",
      cashAccountId: rawCashAccount || undefined,
    });

    const bodyText = Buffer.from(await file.arrayBuffer()).toString("utf8");
    const batches = parsePosSettlementPayload(
      bodyText,
      parsedInput.provider,
      file.type || null,
    );

    if (batches.length === 0) {
      throw new DomainError(
        "VALIDATION",
        "Dosyada geçerli POS hakediş satırı bulunamadı (satış tarihi, valör tarihi, brüt ve net tutar alanları zorunludur — BLANK ≠ ZERO).",
      );
    }

    const pool = getPool();
    const todayISO = istanbulDateISO();

    const existingConnRes = await pool
      .query<{ id: string }>(
        `select id::text
           from public.integration_connections
          order by (integration_kind = 'bank_api' and lower(coalesce(provider, '')) = lower($1)) desc,
                   (integration_kind = 'bank_api') desc,
                   created_at desc
          limit 1`,
        [parsedInput.provider],
      )
      .catch(() => ({ rows: [] as Array<{ id: string }> }));

    const existingConnId = existingConnRes.rows[0]?.id;

    if (existingConnId || can(session.role, "integration_connections", "insert")) {
      const outcome = await persistPosSettlementBatches(pool, {
        provider: parsedInput.provider,
        batches,
        cashAccountId: parsedInput.cashAccountId ?? null,
        connectionId: existingConnId,
        asOfISO: todayISO,
        actorId: session.id,
      });

      if (!outcome.ok) {
        throw new DomainError(
          outcome.error ?? "POS gün sonu hakediş yığını kaydedilemedi.",
        );
      }

      const discCount = outcome.discrepancyCount ?? 0;
      resultMsg = `pos-hakedis (aktarilan:${outcome.imported ?? 0}, mukerrer:${outcome.skipped ?? 0}, uyusmazlik:${discCount})`;
    } else {
      // Fallback for non-admin operators when zero integration_connections rows exist yet
      const client = await pool.connect();
      let imported = 0;
      let skipped = 0;
      let discCount = 0;
      try {
        await client.query("begin");
        let targetAccountId = parsedInput.cashAccountId ?? null;
        if (!targetAccountId) {
          const fallbackAcct = await client.query<{ id: string }>(
            `select id::text
               from public.cash_accounts
              where is_active = true
              order by case when account_type = 'bank' then 0 else 1 end, created_at asc
              limit 1`,
          );
          targetAccountId = fallbackAcct.rows[0]?.id ?? null;
        }
        if (!targetAccountId) {
          throw new DomainError(
            "POS hakedişi için aktif kasa/banka hesabı bulunamadı.",
          );
        }

        for (const batch of batches) {
          if (batch.hasDiscrepancy) discCount += 1;

          const dup = await client.query<{ id: string }>(
            `select id::text
               from public.pos_settlement_batches
              where cash_account_id = $1::uuid
                and pos_terminal_label = $2
                and sale_date = $3::date
                and expected_value_date = $4::date
                and gross_amount = $5::numeric
                and net_settlement_amount = $6::numeric
                and currency = $7
              limit 1`,
            [
              targetAccountId,
              batch.terminalOrProvider,
              batch.settlementDate,
              batch.valueDate,
              batch.grossAmount,
              batch.netAmount,
              batch.currency,
            ],
          );
          if ((dup.rowCount ?? 0) > 0) {
            skipped += 1;
            continue;
          }

          const ins = await client.query<{ id: string }>(
            `insert into public.pos_settlement_batches
               (cash_account_id, pos_terminal_label, sale_date, expected_value_date,
                gross_amount, commission_rate, commission_amount, net_settlement_amount,
                currency, is_settled)
             values ($1::uuid, $2, $3::date, $4::date,
                     $5::numeric, $6::numeric, $7::numeric, $8::numeric,
                     $9, false)
             returning id::text`,
            [
              targetAccountId,
              batch.terminalOrProvider,
              batch.settlementDate,
              batch.valueDate,
              batch.grossAmount,
              batch.commissionRate,
              batch.commissionAmount,
              batch.netAmount,
              batch.currency,
            ],
          );

          if (ins.rowCount === 1 && ins.rows[0]?.id) {
            imported += 1;
            await audit(client, {
              actor: session.id,
              action: "pos_settlement_batch_insert",
              entityTable: "pos_settlement_batches",
              entityId: ins.rows[0].id,
              after: {
                provider: parsedInput.provider,
                externalId: batch.externalId,
                posTerminalLabel: batch.terminalOrProvider,
                saleDate: batch.settlementDate,
                expectedValueDate: batch.valueDate,
                grossAmount: batch.grossAmount,
                commissionAmount: batch.commissionAmount,
                bsmvAmount: batch.bsmvAmount,
                netSettlementAmount: batch.netAmount,
                expectedNetAmount: batch.expectedNetAmount,
                discrepancyAmount: batch.discrepancyAmount,
                hasDiscrepancy: batch.hasDiscrepancy,
                currency: batch.currency,
              },
            });
          } else {
            skipped += 1;
          }
        }

        await client.query("commit");
      } catch (innerErr) {
        await client.query("rollback").catch(() => undefined);
        throw innerErr;
      } finally {
        client.release();
      }
      resultMsg = `pos-hakedis (aktarilan:${imported}, mukerrer:${skipped}, uyusmazlik:${discCount})`;
    }
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/finance/treasury");
  revalidatePath("/finance/calendar");
  revalidateFinancialViews();
  redirect(`${BASE}?result=${encodeURIComponent(resultMsg)}`);
}
