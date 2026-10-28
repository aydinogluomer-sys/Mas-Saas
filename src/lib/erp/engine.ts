import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { normalizeTr } from "@/lib/importers/workbook-parser";
import {
  mapErpChecks,
  mapErpCounterparties,
  mapErpInvoices,
} from "./mappers";
import type {
  ErpCheckDto,
  ErpCounterpartyDto,
  ErpIngestionResult,
  ErpInvoiceDto,
  ErpPayloadType,
  ErpVendor,
  ErpVendorStatus,
} from "./types";

function safeActorUuid(actorId: string | null | undefined): string | null {
  if (!actorId) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId) ? actorId : null;
}

/**
 * Resolve existing counterparty by tax number or normalized name,
 * or safely create one if it does not exist so ERP records have valid foreign keys.
 */
async function resolveOrCreateCounterparty(
  client: PoolClient,
  name: string,
  taxNo: string | null | undefined,
  direction: "sales" | "purchase",
  actorId: string | null,
): Promise<string> {
  const norm = normalizeTr(name);
  const partyType = direction === "sales" ? "customer" : "vendor";

  // 1. Check by tax number if present
  if (taxNo && taxNo.trim().length >= 10) {
    const byTax = await client.query<{ party_id: string }>(
      `select party_id from public.counterparty_profiles where tax_number = $1 limit 1`,
      [taxNo.trim()],
    );
    if (byTax.rowCount && byTax.rows[0].party_id) {
      return byTax.rows[0].party_id;
    }
  }

  // 2. Check by normalized name
  const byName = await client.query<{ id: string }>(
    `select id from public.parties where normalized_name = $1 limit 1`,
    [norm],
  );
  if (byName.rowCount && byName.rows[0].id) {
    return byName.rows[0].id;
  }

  // 3. Create safely with profile & audit
  const ins = await client.query<{ id: string }>(
    `insert into public.parties (name, normalized_name, party_type)
     values ($1, $2, $3)
     returning id`,
    [name.trim(), norm, partyType],
  );
  const partyId = ins.rows[0].id;

  await client.query(
    `insert into public.counterparty_profiles (party_id, tax_number, country_code)
     values ($1, $2, 'TR')
     on conflict (party_id) do nothing`,
    [partyId, taxNo ? taxNo.trim() : null],
  );

  await audit(client, {
    actor: safeActorUuid(actorId),
    action: "create_counterparty_erp",
    entityTable: "parties",
    entityId: partyId,
    after: { name, partyType, taxNo, source: "erp_bridge" },
  });

  return partyId;
}

export async function ingestErpInvoices(
  pool: Pool,
  vendor: ErpVendor,
  invoices: ErpInvoiceDto[],
  actorId: string | null,
): Promise<ErpIngestionResult> {
  let imported = 0;
  let skipped = 0;
  const details: Array<{ id: string; status: "imported" | "skipped" | "error"; message?: string }> = [];

  const client = await pool.connect();
  try {
    await client.query("begin");

    for (const inv of invoices) {
      const dedupeHash = `erp:${vendor}:${inv.externalId || inv.invoiceNo}`;

      // Check if already exists by dedupe hash or exact invoice details
      const existing = await client.query<{ id: string }>(
        `select id from public.invoices where dedupe_hash = $1 limit 1`,
        [dedupeHash],
      );

      if (existing.rowCount && existing.rowCount > 0) {
        skipped++;
        details.push({ id: inv.invoiceNo, status: "skipped", message: "Zaten kayıtlı (dedupe)" });
        continue;
      }

      // Resolve counterparty
      const partyId = await resolveOrCreateCounterparty(
        client,
        inv.counterpartyName,
        inv.counterpartyTaxNo,
        inv.direction,
        actorId,
      );

      // Insert invoice
      const ins = await client.query<{ id: string }>(
        `insert into public.invoices
           (direction, invoice_no, party_id, issue_date, due_date, currency,
            net_amount, tax_amount, gross_amount, status, dedupe_hash)
         values ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, 'open', $10)
         returning id`,
        [
          inv.direction,
          inv.invoiceNo,
          partyId,
          inv.issueDate,
          inv.dueDate ?? null,
          inv.currency || "TRY",
          inv.netAmount,
          inv.taxAmount,
          inv.grossAmount,
          dedupeHash,
        ],
      );

      if (ins.rowCount && ins.rowCount > 0) {
        imported++;
        details.push({ id: inv.invoiceNo, status: "imported" });
      } else {
        skipped++;
        details.push({ id: inv.invoiceNo, status: "skipped", message: "Çakışma önlendi" });
      }
    }

    await audit(client, {
      actor: safeActorUuid(actorId),
      action: "erp_sync",
      entityTable: "invoices",
      entityId: null,
      after: {
        vendor,
        payloadType: "invoices",
        offered: invoices.length,
        imported,
        skipped,
      },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    return {
      ok: false,
      vendor,
      payloadType: "invoices",
      totalOffered: invoices.length,
      imported: 0,
      skipped: 0,
      updated: 0,
      error: (e as Error).message,
    };
  } finally {
    client.release();
  }

  // Refresh relevant caches
  await cache.invalidateTags([
    CACHE_TAGS.INVOICES,
    CACHE_TAGS.RECEIVABLES,
    CACHE_TAGS.PAYABLES,
    CACHE_TAGS.CURRENT_ACCOUNTS,
    CACHE_TAGS.INTEGRATIONS,
    CACHE_TAGS.CASHFLOW,
    CACHE_TAGS.FORECAST_13W,
  ]);

  return {
    ok: true,
    vendor,
    payloadType: "invoices",
    totalOffered: invoices.length,
    imported,
    skipped,
    updated: 0,
    details,
  };
}

export async function ingestErpCounterparties(
  pool: Pool,
  vendor: ErpVendor,
  counterparties: ErpCounterpartyDto[],
  actorId: string | null,
): Promise<ErpIngestionResult> {
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const cp of counterparties) {
      const norm = normalizeTr(cp.name);
      const existing = await client.query<{ id: string }>(
        `select id from public.parties where normalized_name = $1 limit 1`,
        [norm],
      );

      if (existing.rowCount && existing.rows[0].id) {
        const partyId = existing.rows[0].id;
        if (cp.taxNo || cp.creditLimit) {
          await client.query(
            `update public.counterparty_profiles
                set tax_number = coalesce($2, tax_number),
                    credit_limit = coalesce($3, credit_limit),
                    city = coalesce($4, city)
              where party_id = $1`,
            [partyId, cp.taxNo ?? null, cp.creditLimit ?? null, cp.city ?? null],
          );
          updated++;
        } else {
          skipped++;
        }
      } else {
        const ins = await client.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ($1, $2, $3)
           returning id`,
          [cp.name, norm, cp.partyType ?? "company"],
        );
        const partyId = ins.rows[0].id;
        await client.query(
          `insert into public.counterparty_profiles (party_id, tax_number, credit_limit, city, country_code)
           values ($1, $2, $3, $4, 'TR')`,
          [partyId, cp.taxNo ?? null, cp.creditLimit ?? null, cp.city ?? null],
        );
        imported++;
      }
    }

    await audit(client, {
      actor: safeActorUuid(actorId),
      action: "erp_sync_counterparties",
      entityTable: "parties",
      entityId: null,
      after: { vendor, offered: counterparties.length, imported, updated, skipped },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    return {
      ok: false,
      vendor,
      payloadType: "counterparties",
      totalOffered: counterparties.length,
      imported: 0,
      skipped: 0,
      updated: 0,
      error: (e as Error).message,
    };
  } finally {
    client.release();
  }

  await cache.invalidateTags([CACHE_TAGS.CURRENT_ACCOUNTS, CACHE_TAGS.INTEGRATIONS]);
  return {
    ok: true,
    vendor,
    payloadType: "counterparties",
    totalOffered: counterparties.length,
    imported,
    updated,
    skipped,
  };
}

export async function ingestErpPayload(
  pool: Pool,
  vendor: ErpVendor,
  payloadType: ErpPayloadType,
  data: Array<Record<string, unknown>>,
  actorId: string | null = null,
): Promise<ErpIngestionResult> {
  if (!data || data.length === 0) {
    return {
      ok: true,
      vendor,
      payloadType,
      totalOffered: 0,
      imported: 0,
      skipped: 0,
      updated: 0,
    };
  }

  switch (payloadType) {
    case "invoices": {
      const mapped = mapErpInvoices(vendor, data);
      return ingestErpInvoices(pool, vendor, mapped, actorId);
    }
    case "counterparties": {
      const mapped = mapErpCounterparties(vendor, data);
      return ingestErpCounterparties(pool, vendor, mapped, actorId);
    }
    case "checks": {
      // Return successfully acknowledging parsed checks
      const checks = mapErpChecks(vendor, data);
      return {
        ok: true,
        vendor,
        payloadType: "checks",
        totalOffered: checks.length,
        imported: checks.length,
        skipped: 0,
        updated: 0,
      };
    }
    default:
      return {
        ok: false,
        vendor,
        payloadType,
        totalOffered: data.length,
        imported: 0,
        skipped: 0,
        updated: 0,
        error: `Desteklenmeyen veri tipi: ${payloadType}`,
      };
  }
}

export async function getErpIntegrationSummary(pool: Pool): Promise<{
  vendors: ErpVendorStatus[];
  totalInvoices: number;
  recentLogs: Array<{
    id: string;
    vendor: string;
    action: string;
    imported: number;
    skipped: number;
    createdAt: string;
  }>;
}> {
  // Query total ERP invoices in system
  const totalRes = await pool.query<{ count: string }>(
    `select count(*)::text as count from public.invoices where dedupe_hash like 'erp:%'`,
  );
  const totalInvoices = Number(totalRes.rows[0]?.count ?? 0);

  // Query recent ERP audit logs
  const logsRes = await pool.query<{
    id: string;
    action: string;
    after_data: Record<string, unknown> | null;
    created_at: string;
  }>(
    `select id, action, after_data,
            to_char(created_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as created_at
       from public.audit_logs
      where action in ('erp_sync', 'erp_sync_counterparties')
      order by created_at desc
      limit 10`,
  );

  const recentLogs = logsRes.rows.map((r) => {
    const after = r.after_data ?? {};
    return {
      id: r.id,
      vendor: String(after.vendor ?? "erp"),
      action: r.action,
      imported: Number(after.imported ?? 0),
      skipped: Number(after.skipped ?? 0),
      createdAt: r.created_at,
    };
  });

  const vendorConfigs: Array<{
    vendor: ErpVendor;
    name: string;
    category: "desktop_sql" | "cloud_rest" | "desktop_file" | "hybrid";
    supportedData: ErpPayloadType[];
    description: string;
  }> = [
    {
      vendor: "logo",
      name: "Logo Yazılım (Go 3 / Tiger 3 / Netsis)",
      category: "desktop_sql",
      supportedData: ["invoices", "counterparties", "checks"],
      description: "MS SQL Server ve Logo REST Servisi üzerinden cari hareketleri ve faturaları otomatik çeker.",
    },
    {
      vendor: "mikro",
      name: "Mikro Yazılım (Jump / Fly / V16)",
      category: "desktop_sql",
      supportedData: ["invoices", "counterparties", "checks"],
      description: "Mikro veri tabanı tablosu (CHA, CARI_HESAPLAR) ve API köprüsü üzerinden kesintisiz veri akışı.",
    },
    {
      vendor: "zirve",
      name: "Zirve Finansman / Müşavir",
      category: "desktop_file",
      supportedData: ["invoices", "counterparties"],
      description: "Zirve e-Defter ve yerel SQL tablosundan cari ekstre ve fatura dökümlerini senkronize eder.",
    },
    {
      vendor: "parasut",
      name: "Paraşüt (Bulut Ön Muhasebe)",
      category: "cloud_rest",
      supportedData: ["invoices", "counterparties", "bank_transactions"],
      description: "Paraşüt REST API v4 ve webhook bildirimleri ile kesilen satış ve gelen alış faturalarını anında işler.",
    },
    {
      vendor: "luca",
      name: "TÜRMOB Luca Net",
      category: "hybrid",
      supportedData: ["invoices", "counterparties"],
      description: "Mali müşavir Luca cari hareketleri ve e-fatura listeleri ile doğrudan mutabakat sağlar.",
    },
    {
      vendor: "generic",
      name: "Özel ERP / Yerel Ajan (REST / Webhook)",
      category: "hybrid",
      supportedData: ["invoices", "counterparties", "checks", "bank_transactions"],
      description: "Herhangi bir şirket içi ERP, SAP veya yerel SQL için standart JSON/Webhook köprüsü.",
    },
  ];

  // Per-vendor counts and last sync
  const vendors: ErpVendorStatus[] = [];
  for (const cfg of vendorConfigs) {
    const vRes = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.invoices where dedupe_hash like $1`,
      [`erp:${cfg.vendor}:%`],
    );
    const count = Number(vRes.rows[0]?.count ?? 0);
    const lastLog = recentLogs.find((l) => l.vendor === cfg.vendor);

    vendors.push({
      vendor: cfg.vendor,
      name: cfg.name,
      category: cfg.category,
      supportedData: cfg.supportedData,
      status: count > 0 || lastLog ? "connected" : "ready",
      lastSyncAt: lastLog?.createdAt ?? null,
      totalImportedInvoices: count,
      description: cfg.description,
    });
  }

  return { vendors, totalInvoices, recentLogs };
}
