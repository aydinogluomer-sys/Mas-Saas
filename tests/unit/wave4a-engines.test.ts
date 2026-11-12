import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  parasutConnector,
  replayDeferredParasutInvoices,
} from "@/lib/integrations/parasut/mappers";
import { mockHttpClient } from "@/lib/integrations/types";
import { cancelJob, reapStaleRunningJobs } from "@/lib/jobs/queue";
import { createConfiguredDispatcher } from "@/lib/jobs/dispatcher";
import { JOB_TYPES } from "@/lib/jobs/rules";
import { dispatchBriefing } from "@/lib/briefing/engine";
import { mockTransport } from "@/lib/reminders/transport";
import { loadMetricHistory } from "@/lib/analytics/snapshots";
import { globalFilterSchema } from "@/lib/ui/filters";
import {
  buildSavedViewHrefPreservingContext,
  defaultViewFor,
  extractPreservedContextParams,
  pickDefaultSavedView,
  touchSavedView,
  type SavedView,
} from "@/lib/ui/saved-views";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const PARTY_ID = "33333333-3333-4333-8333-333333333333";
const VIEW_OWN_ID = "44444444-4444-4444-8444-444444444444";
const VIEW_SHARED_ID = "55555555-5555-4555-8555-555555555555";

describe("F-53: Paraşüt S-10 deferred contact invoice replay across watermark advancement", () => {
  it("replays deferred sales_invoices once staged contact is approved even when incremental fetch is empty", async () => {
    const rawPayloads: Array<{
      id: string;
      resource_type: string;
      external_id: string;
      external_updated_at: string | null;
      payload_sha256: string;
      payload_json: Record<string, unknown>;
    }> = [];
    const stagedParties = new Map<
      string,
      { id: string; status: string; resolved_party_id: string | null; raw_name: string }
    >();
    const entityLinks = new Map<string, { entity_table: string; entity_id: string }>();
    const invoices = new Map<
      string,
      { id: string; party_id: string; invoice_no: string; gross_amount: number }
    >();
    let lastWatermarkTo: string | null = null;
    let seq = 1;

    const queryImpl = async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();

      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.integration_connections")) {
        return { rows: [{ id: "conn-parasut-1" }], rowCount: 1 };
      }
      if (sql.includes("select watermark_to::text from public.integration_sync_runs")) {
        return { rows: lastWatermarkTo ? [{ watermark_to: lastWatermarkTo }] : [], rowCount: lastWatermarkTo ? 1 : 0 };
      }
      if (sql.startsWith("insert into public.integration_sync_runs")) {
        return { rows: [{ id: `sync-run-${seq++}` }], rowCount: 1 };
      }
      if (sql.startsWith("update public.integration_sync_runs")) {
        if (sql.includes("watermark_to = $2")) {
          const wm = params[1] as string | null | undefined;
          if (wm) lastWatermarkTo = wm;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into public.integration_raw_payloads")) {
        const resourceType = String(params[1]);
        const externalId = String(params[2]);
        const externalUpdatedAt = (params[3] as string | null) ?? null;
        const sha = String(params[4]);
        const jsonObj = JSON.parse(String(params[5])) as Record<string, unknown>;
        const dup = rawPayloads.find(
          (r) => r.resource_type === resourceType && r.external_id === externalId && r.payload_sha256 === sha,
        );
        if (dup) return { rows: [], rowCount: 0 };
        const id = `raw-${seq++}`;
        rawPayloads.push({
          id,
          resource_type: resourceType,
          external_id: externalId,
          external_updated_at: externalUpdatedAt,
          payload_sha256: sha,
          payload_json: jsonObj,
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith("select id from public.integration_raw_payloads")) {
        const found = rawPayloads.find(
          (r) =>
            r.resource_type === String(params[0]) &&
            r.external_id === String(params[1]) &&
            r.payload_sha256 === String(params[2]),
        );
        return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.startsWith("select distinct on (rp.resource_type, rp.external_id)")) {
        const eligible = rawPayloads.filter((rp) => {
          if (rp.resource_type !== "sales_invoices" && rp.resource_type !== "purchase_bills") {
            return false;
          }
          if (entityLinks.has(`parasut:${rp.resource_type}:${rp.external_id}`)) {
            return false;
          }
          if (invoices.has(`parasut:${rp.resource_type}:${rp.external_id}`)) {
            return false;
          }
          return true;
        });
        return { rows: eligible, rowCount: eligible.length };
      }
      if (sql.includes("from public.integration_entity_links") && sql.includes("resource_type = 'contacts'")) {
        const link = entityLinks.get(`parasut:contacts:${String(params[0])}`);
        return { rows: link ? [{ entity_id: link.entity_id }] : [], rowCount: link ? 1 : 0 };
      }
      if (sql.includes("from public.integration_staged_parties") && sql.includes("status in ('linked', 'created')")) {
        const st = stagedParties.get(String(params[0]));
        if (st && (st.status === "linked" || st.status === "created") && st.resolved_party_id) {
          return { rows: [{ resolved_party_id: st.resolved_party_id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.counterparty_profiles") || sql.includes("from public.ibans") || sql.includes("from public.parties")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select id::text, status, resolved_party_id::text from public.integration_staged_parties")) {
        const st = stagedParties.get(String(params[0]));
        return { rows: st ? [st] : [], rowCount: st ? 1 : 0 };
      }
      if (sql.startsWith("insert into public.integration_staged_parties")) {
        const extId = String(params[0]);
        if (!stagedParties.has(extId)) {
          stagedParties.set(extId, {
            id: `stage-${seq++}`,
            status: "pending",
            resolved_party_id: null,
            raw_name: String(params[1]),
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from public.integration_account_mappings")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.bank_accounts")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("from public.invoices where external_key = $1")) {
        const inv = invoices.get(String(params[0]));
        return {
          rows: inv
            ? [{ id: inv.id, status: "open", invoice_no: inv.invoice_no, paid_amount: "0" }]
            : [],
          rowCount: inv ? 1 : 0,
        };
      }
      if (sql.startsWith("insert into public.invoices")) {
        const extKey = String(params[15]);
        const id = `inv-db-${seq++}`;
        invoices.set(extKey, {
          id,
          invoice_no: String(params[1]),
          party_id: String(params[2]),
          gross_amount: Number(params[8]),
        });
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.startsWith("insert into public.integration_entity_links")) {
        const key = `parasut:${String(params[0])}:${String(params[1])}`;
        entityLinks.set(key, {
          entity_table: String(params[2]),
          entity_id: String(params[3]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into public.audit_logs")) {
        return { rows: [{ id: `audit-${seq++}` }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const fakeClient = {
      query: queryImpl,
      release: () => undefined,
    } as unknown as PoolClient;

    const fakePool = {
      query: queryImpl,
      connect: async () => fakeClient,
    } as unknown as Pool;

    let syncRound = 1;
    const http = mockHttpClient((req) => {
      if (req.url.endsWith("/oauth/token")) {
        return {
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({ access_token: "tok-1", expires_in: 7200 }),
        };
      }
      if (syncRound === 1 && req.url.includes("/sales_invoices")) {
        return {
          ok: true,
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [
              {
                id: "inv-s10-9001",
                type: "sales_invoices",
                attributes: {
                  item_type: "invoice",
                  invoice_no: "GIB2026000009001",
                  issue_date: "2026-03-01",
                  due_date: "2026-03-31",
                  currency: "TRL",
                  net_total: "10000.00",
                  total_vat: "2000.00",
                  gross_total: "12000.00",
                  total_paid: "0.00",
                  remaining: "12000.00",
                  payment_status: "unpaid",
                  updated_at: "2026-03-01T10:00:00Z",
                },
                relationships: {
                  contact: { data: { id: "c-9001", type: "contacts" } },
                },
              },
            ],
            included: [
              {
                id: "c-9001",
                type: "contacts",
                attributes: {
                  name: "Yeni Müşteri A.Ş.",
                  tax_number: "9001900190",
                  account_type: "customer",
                },
              },
            ],
            meta: { current_page: 1, total_pages: 1 },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: {},
        body: JSON.stringify({ data: [], included: [], meta: { current_page: 1, total_pages: 1 } }),
      };
    });

    const connector = parasutConnector({ limiterOptions: { maxRequestsPerWindow: 100, windowMs: 10 } });
    const ctxBase = {
      connectionId: "conn-parasut-1",
      config: { companyId: "12345" },
      credential: JSON.stringify({
        companyId: "12345",
        clientId: "cid",
        clientSecret: "csec",
        username: "u@example.com",
        password: "pw",
      }),
      http,
    };

    // Round 1: Unknown contact -> staged in S-10 queue, invoice deferred, watermark advances!
    const round1 = await connector.sync({ ...ctxBase, asOfISO: "2026-03-02" }, fakePool, ACTOR_ID);
    expect(round1.ok).toBe(true);
    expect(stagedParties.get("c-9001")?.status).toBe("pending");
    expect(invoices.size).toBe(0);
    expect(lastWatermarkTo).toBe("2026-03-01T10:00:00.000Z");

    // Operator approves staged contact in /data/integrations
    stagedParties.set("c-9001", {
      id: "stage-1",
      status: "created",
      resolved_party_id: PARTY_ID,
      raw_name: "Yeni Müşteri A.Ş.",
    });

    // Round 2: Incremental run 40 days later — Paraşüt returns 0 invoices because watermark advanced,
    // yet replayDeferredParasutInvoices materializes the deferred invoice!
    syncRound = 2;
    const round2 = await connector.sync({ ...ctxBase, asOfISO: "2026-04-10" }, fakePool, ACTOR_ID);
    expect(round2.ok).toBe(true);
    expect(round2.imported).toBe(1);
    const materialized = invoices.get("parasut:sales_invoices:inv-s10-9001");
    expect(materialized).toBeDefined();
    expect(materialized?.party_id).toBe(PARTY_ID);
    expect(materialized?.invoice_no).toBe("GIB2026000009001");
    expect(materialized?.gross_amount).toBe(12000);

    // Round 3: Direct replay call is idempotent once entity_link/invoice exists
    const replayAgain = await replayDeferredParasutInvoices(fakeClient);
    expect(replayAgain).toEqual({ replayedUpserted: 0, stillDeferred: 0 });
  });
});

describe("F-33 & F-34: Job queue cancellation, stale reaping, and configured dispatcher", () => {
  it("createConfiguredDispatcher registers handlers for every declared JOB_TYPES entry", () => {
    const d = createConfiguredDispatcher();
    for (const jt of JOB_TYPES) {
      expect(d.hasHandler(jt)).toBe(true);
    }
  });

  it("cancelJob cancels a queued job and writes audit, returning false when not queued", async () => {
    const audits: string[] = [];
    let isQueued = true;

    const client = {
      async query(sql: string) {
        if (sql.toLowerCase().startsWith("update public.background_jobs")) {
          if (!isQueued) return { rows: [], rowCount: 0 };
          isQueued = false;
          return { rows: [{ id: "job-1", job_type: "large_export" }], rowCount: 1 };
        }
        if (sql.toLowerCase().includes("insert into public.audit_logs")) {
          audits.push("cancel_background_job");
          return { rows: [{ id: "aud-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };

    const pool = { connect: async () => client } as unknown as Pool;
    expect(await cancelJob(pool, "job-1", ACTOR_ID, "operatör iptali")).toBe(true);
    expect(audits).toEqual(["cancel_background_job"]);
    expect(await cancelJob(pool, "job-1", ACTOR_ID)).toBe(false);
  });

  it("reapStaleRunningJobs requeues hung running jobs and records count", async () => {
    let auditCalls = 0;
    const client = {
      async query(sql: string) {
        if (sql.toLowerCase().startsWith("update public.background_jobs")) {
          return { rows: [{ id: "hung-1" }, { id: "hung-2" }], rowCount: 2 };
        }
        if (sql.toLowerCase().includes("insert into public.audit_logs")) {
          auditCalls += 1;
          return { rows: [{ id: "aud-reap" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const reaped = await reapStaleRunningJobs(pool, 30, ACTOR_ID);
    expect(reaped).toBe(2);
    expect(auditCalls).toBe(1);
  });
});

describe("F-39 & F-40: dispatchBriefing and loadMetricHistory", () => {
  it("dispatchBriefing delivers message over transport and writes dispatch_cfo_briefing audit", async () => {
    const auditPayloads: Array<{ action: string; entityId: string }> = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        if (sql.toLowerCase().includes("insert into public.audit_logs")) {
          auditPayloads.push({
            action: String(params?.[1] ?? ""),
            entityId: String(params?.[3] ?? ""),
          });
          return { rows: [{ id: "aud-briefing" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const transport = mockTransport({ channel: "telegram" });

    const res = await dispatchBriefing(pool, transport, "# Sabah Brifingi\nNakit tam.", REPORT_ID, ACTOR_ID);
    expect(res.ok).toBe(true);
    expect(transport.sent).toEqual(["# Sabah Brifingi\nNakit tam."]);
    expect(auditPayloads).toEqual([{ action: "dispatch_cfo_briefing", entityId: REPORT_ID }]);
  });

  it("loadMetricHistory queries metric_snapshots and preserves full decimal precision", async () => {
    const pool = {
      async query(_sql: string, params: unknown[]) {
        expect(params).toEqual(["decision_confidence", 30]);
        return {
          rows: [
            {
              snapshot_date: "2026-04-10",
              metric_key: "decision_confidence",
              dimension_key: "total",
              value_numeric: "87.5432",
              value_text: null,
              unknown_count: 0,
              confidence: "high",
              source_cutoff: "2026-04-10 09:00",
              meta: {},
            },
          ],
        };
      },
    } as unknown as Pool;

    const history = await loadMetricHistory(pool, "decision_confidence", 30);
    expect(history).toHaveLength(1);
    expect(history[0].value_numeric).toBe(87.5432);
    expect(history[0].confidence).toBe("high");
  });
});

describe("F-42 & F-62: Saved views default resolution, touchSavedView, and context preservation", () => {
  const sampleViews: SavedView[] = [
    {
      id: VIEW_SHARED_ID,
      name: "Takım Varsayılanı",
      moduleKey: "invoices",
      filters: globalFilterSchema.parse({ datePreset: "last_90" }),
      isShared: true,
      isDefault: true,
      isMine: false,
    },
    {
      id: VIEW_OWN_ID,
      name: "Kişisel USD Görünümü",
      moduleKey: "invoices",
      filters: globalFilterSchema.parse({ datePreset: "last_30", currency: "USD" }),
      isShared: false,
      isDefault: true,
      isMine: true,
    },
  ];

  it("pickDefaultSavedView & defaultViewFor prioritize personal default over shared default", async () => {
    expect(pickDefaultSavedView(sampleViews)?.id).toBe(VIEW_OWN_ID);

    const pool = {
      async query() {
        return {
          rows: [
            {
              id: VIEW_SHARED_ID,
              name: "Takım Varsayılanı",
              module_key: "invoices",
              filters: { datePreset: "last_90" },
              is_shared: true,
              is_default: true,
              created_by: "99999999-9999-4999-8999-999999999999",
            },
            {
              id: VIEW_OWN_ID,
              name: "Kişisel USD Görünümü",
              module_key: "invoices",
              filters: { datePreset: "last_30", currency: "USD" },
              is_shared: false,
              is_default: true,
              created_by: ACTOR_ID,
            },
          ],
        };
      },
    } as unknown as Pool;

    const resolved = await defaultViewFor(pool, "invoices", ACTOR_ID);
    expect(resolved?.id).toBe(VIEW_OWN_ID);
  });

  it("touchSavedView updates owned saved view and fails gracefully on viewer RLS or invalid id", async () => {
    const okPool = {
      async query() {
        return { rows: [{ id: VIEW_OWN_ID }], rowCount: 1 };
      },
    } as unknown as Pool;
    expect(await touchSavedView(okPool, VIEW_OWN_ID, ACTOR_ID)).toBe(true);
    expect(await touchSavedView(okPool, "not-a-uuid", ACTOR_ID)).toBe(false);
    expect(await touchSavedView(okPool, VIEW_OWN_ID, null)).toBe(false);

    const viewerPool = {
      async query() {
        const err = new Error("permission denied for table saved_views") as Error & { code: string };
        err.code = "42501";
        throw err;
      },
    } as unknown as Pool;
    expect(await touchSavedView(viewerPool, VIEW_OWN_ID, ACTOR_ID)).toBe(false);
  });

  it("preserves tab, month, period, direction, currency across saved view switches unless overridden", () => {
    const rawUrl = new URLSearchParams(
      "tab=sales&month=2026-04&period=Q2&direction=inflow&currency=TRY&dp=last_7&q=eski&page=3",
    );
    const preserved = extractPreservedContextParams(rawUrl);
    expect(preserved).toEqual({
      tab: "sales",
      month: "2026-04",
      period: "Q2",
      direction: "inflow",
      currency: "TRY",
    });

    // Switching to a saved view WITHOUT currency preserves `currency=TRY` + `tab/month/period/direction`
    const noCurFilters = globalFilterSchema.parse({ datePreset: "last_30", q: "akon" });
    const hrefKeepCurrency = buildSavedViewHrefPreservingContext("/finance/invoices", rawUrl, noCurFilters);
    const p1 = new URLSearchParams(hrefKeepCurrency.split("?")[1]);
    expect(p1.get("tab")).toBe("sales");
    expect(p1.get("month")).toBe("2026-04");
    expect(p1.get("period")).toBe("Q2");
    expect(p1.get("direction")).toBe("inflow");
    expect(p1.get("currency")).toBe("TRY");
    expect(p1.get("dp")).toBe("last_30");
    expect(p1.get("q")).toBe("akon");
    expect(p1.get("page")).toBeNull();

    // Switching to a saved view WITH `currency: "USD"` overrides `currency` + sets `cur=USD` while keeping `tab/month/period/direction`
    const usdFilters = globalFilterSchema.parse({ datePreset: "this_month", currency: "USD" });
    const hrefOverrideCurrency = buildSavedViewHrefPreservingContext("/finance/invoices", rawUrl, usdFilters);
    const p2 = new URLSearchParams(hrefOverrideCurrency.split("?")[1]);
    expect(p2.get("tab")).toBe("sales");
    expect(p2.get("month")).toBe("2026-04");
    expect(p2.get("period")).toBe("Q2");
    expect(p2.get("direction")).toBe("inflow");
    expect(p2.get("cur")).toBe("USD");
    expect(p2.get("currency")).toBe("USD");

    // Resetting to default (`targetFilters = null`) clears global filters while keeping active tab/month/period/direction
    const resetHref = buildSavedViewHrefPreservingContext("/finance/invoices", rawUrl, null);
    const p3 = new URLSearchParams(resetHref.split("?")[1]);
    expect(p3.get("tab")).toBe("sales");
    expect(p3.get("month")).toBe("2026-04");
    expect(p3.get("dp")).toBeNull();
    expect(p3.get("q")).toBeNull();
  });
});
