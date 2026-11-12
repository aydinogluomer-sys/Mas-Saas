"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionPermission } from "@/lib/auth";
import { createCounterparty } from "@/lib/counterparties/engine";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { importHybridBankStatement } from "@/lib/importers/bank-formats/mt940-camt053-parasut";
import { createConnection, enqueueSync } from "@/lib/integrations/engine";
import {
  normalizeParasutCurrency,
  replayDeferredParasutInvoices,
} from "@/lib/integrations/parasut/mappers";
import { runClosedLoopFinancialPipeline } from "@/lib/integrations/parasut/sync-pipeline";
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
    const sinceDaysRaw = strField(f.sinceDays);
    if (baseUrl) config.baseUrl = baseUrl;
    if (companyId) config.companyId = companyId;
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
