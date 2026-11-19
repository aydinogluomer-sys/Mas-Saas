import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertSchemaParity,
  checkSchemaParity,
  readExpectedSchemaManifest,
} from "@/lib/db/schema-parity";
import { readEnvLocal } from "../../scripts/db/app-url";
import { checksumContent, validateFileSet } from "../../scripts/db/migration-lib";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

function resolveConnectionUrls(): { appUrl: string; ownerUrl: string } {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    // Fallback to process.env when .env.local is absent (e.g. CI).
  }
  const appUrl = process.env.DATABASE_URL?.trim() || fileEnv.DATABASE_URL?.trim() || "";
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    fileEnv.MIGRATION_DATABASE_URL?.trim() ||
    appUrl;

  if (!appUrl) {
    throw new Error("DATABASE_URL tanımlı değil (.env.local veya ortam değişkeni gerekli).");
  }
  if (!ownerUrl) {
    throw new Error("MIGRATION_DATABASE_URL tanımlı değil.");
  }
  return { appUrl, ownerUrl };
}

function hasLiveAppDbConfig(): boolean {
  if (process.env.DATABASE_URL?.trim()) return true;
  try {
    return Boolean(readEnvLocal().DATABASE_URL?.trim());
  } catch {
    return false;
  }
}

describe.skipIf(!hasLiveAppDbConfig())("Agent 01 — Database Reliability, Migration 0124 & RLS Verification", () => {
  let appPool: Pool;
  let ownerPool: Pool;

  beforeAll(async () => {
    const { appUrl, ownerUrl } = resolveConnectionUrls();
    appPool = new Pool({
      connectionString: appUrl,
      max: 1,
      connectionTimeoutMillis: 30_000,
    });
    ownerPool = new Pool({
      connectionString: ownerUrl,
      max: 1,
      connectionTimeoutMillis: 30_000,
    });
    // Pre-warm physical PostgreSQL backend processes on Windows so individual tests reuse warm sockets.
    await Promise.all([appPool.query("select 1"), ownerPool.query("select 1")]);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.allSettled([appPool?.end(), ownerPool?.end()]);
  });

  it("1. enforces least-privilege runtime DB identity (mas_radar_app, !rolsuper, !rolbypassrls, NOINHERIT)", async () => {
    const identRes = await appPool.query<{
      db: string;
      usr: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolinherit: boolean;
    }>(
      `select current_database() as db,
              current_user as usr,
              r.rolsuper,
              r.rolbypassrls,
              r.rolinherit
         from pg_roles r
        where r.rolname = current_user`,
    );

    expect(identRes.rowCount).toBe(1);
    const ident = identRes.rows[0]!;
    expect(ident.usr).toBe("mas_radar_app");
    expect(ident.rolsuper).toBe(false);
    expect(ident.rolbypassrls).toBe(false);
    expect(ident.rolinherit).toBe(false);

    // Unswitched mas_radar_app cannot read business rows and cannot write schema_migrations
    const unswitchedPayments = await appPool.query<{ n: number }>(
      "select count(*)::int as n from public.payments",
    );
    expect(unswitchedPayments.rows[0]?.n).toBe(0);

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      let sqlState: string | null = null;
      try {
        await client.query(
          "insert into public.schema_migrations (version, name, checksum) values ('9999', 'probe.sql', '0')",
        );
      } catch (err) {
        sqlState = (err as { code?: string }).code ?? "unknown";
      }
      expect(sqlState).toBe("42501");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("2. fails closed when DB is unreachable or schema drifts (checkSchemaParity -> aligned: false)", async () => {
    const unreachableError = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    );
    const unreachablePool = {
      async query() {
        throw unreachableError;
      },
    } as unknown as Pick<Pool, "query">;

    const downParity = await checkSchemaParity(unreachablePool);
    expect(downParity.aligned).toBe(false);
    expect(downParity.actualCount).toBeNull();
    expect(downParity.actualLatestVersion).toBeNull();
    expect(downParity.checksumDigest).toBeNull();
    expect(downParity.error).toContain("ECONNREFUSED");

    await expect(assertSchemaParity(unreachablePool)).rejects.toThrow(/ECONNREFUSED/);

    const driftedPool = {
      async query() {
        return {
          rows: [
            {
              migration_count: 115,
              latest_version: "0115",
              checksum_digest: "0115digest",
              last_applied_at: "2026-11-12T19:11:47.920Z",
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as Pick<Pool, "query">;

    const driftParity = await checkSchemaParity(driftedPool);
    expect(driftParity.aligned).toBe(false);
    expect(driftParity.actualCount).toBe(115);
    expect(driftParity.actualLatestVersion).toBe("0115");
    await expect(assertSchemaParity(driftedPool)).rejects.toThrow(/115\/0115/);
  });

  it("3. enforces RLS on 100% of public tables and security_invoker=true + read-only grants on 100% of public views (including valid_workbook_imports)", async () => {
    const tablesRes = await ownerPool.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
        order by c.relname`,
    );

    expect(tablesRes.rows.length).toBeGreaterThanOrEqual(132);
    const unprotectedTables = tablesRes.rows.filter((t) => !t.relrowsecurity).map((t) => t.relname);
    expect(unprotectedTables).toEqual([]);

    const viewsRes = await ownerPool.query<{ relname: string; invoker: boolean }>(
      `select c.relname,
              coalesce('security_invoker=true' = any(c.reloptions), false) as invoker
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'v'
        order by c.relname`,
    );

    expect(viewsRes.rows.length).toBeGreaterThanOrEqual(91);
    const viewNames = viewsRes.rows.map((v) => v.relname);
    expect(viewNames).toContain("valid_workbook_imports");
    const unprotectedViews = viewsRes.rows.filter((v) => !v.invoker).map((v) => v.relname);
    expect(unprotectedViews).toEqual([]);

    // Zero write privileges on any public view across mas_radar_app and all 5 RBAC tier roles
    const writableViewsRes = await ownerPool.query<{ view_name: string; role_name: string }>(
      `select v.table_name as view_name, r.rolname as role_name
         from information_schema.views v
         cross join pg_roles r
        where v.table_schema = 'public'
          and r.rolname in (
            'mas_radar_app',
            'mas_radar_viewer',
            'mas_radar_finance_operator',
            'mas_radar_finance_approver',
            'mas_radar_finance_manager',
            'mas_radar_admin'
          )
          and (
            has_table_privilege(r.oid, format('public.%I', v.table_name), 'INSERT')
            or has_table_privilege(r.oid, format('public.%I', v.table_name), 'UPDATE')
            or has_table_privilege(r.oid, format('public.%I', v.table_name), 'DELETE')
          )`,
    );
    expect(writableViewsRes.rows).toEqual([]);

    // All 5 RBAC tier roles must have SELECT on valid_workbook_imports
    const selectGrantsRes = await ownerPool.query<{ rolname: string; can_select: boolean }>(
      `select r.rolname,
              has_table_privilege(r.oid, 'public.valid_workbook_imports', 'SELECT') as can_select
         from pg_roles r
        where r.rolname in (
          'mas_radar_viewer',
          'mas_radar_finance_operator',
          'mas_radar_finance_approver',
          'mas_radar_finance_manager',
          'mas_radar_admin'
        )
        order by r.rolname`,
    );
    expect(selectGrantsRes.rows).toHaveLength(5);
    expect(selectGrantsRes.rows.every((r) => r.can_select)).toBe(true);

    // Verify valid_workbook_imports filters out empty ('parsed' with 0 import_rows) and 'failed' workbooks inside BEGIN...ROLLBACK
    const beforeWbCount = Number(
      (await ownerPool.query<{ n: number }>("select count(*)::int as n from public.source_workbooks"))
        .rows[0]?.n ?? 0,
    );
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE mas_radar_finance_operator");

      const emptyParsed = await client.query<{ id: string }>(
        `insert into public.source_workbooks (original_filename, status)
         values ('probe_empty_parsed_0124.xlsx', 'parsed')
         returning id`,
      );
      const failedWithRows = await client.query<{ id: string }>(
        `insert into public.source_workbooks (original_filename, status, parse_error)
         values ('probe_failed_with_rows_0124.xlsx', 'failed', 'corrupt sheet')
         returning id`,
      );
      const failedSheet = await client.query<{ id: string }>(
        `insert into public.source_sheets (workbook_id, sheet_name, sheet_index)
         values ($1, 'Sheet1', 0)
         returning id`,
        [failedWithRows.rows[0]!.id],
      );
      await client.query(
        `insert into public.import_rows (workbook_id, sheet_id, row_index, row_json)
         values ($1, $2, 1, '{"A":"1"}'::jsonb)`,
        [failedWithRows.rows[0]!.id, failedSheet.rows[0]!.id],
      );

      const validParsed = await client.query<{ id: string }>(
        `insert into public.source_workbooks (original_filename, status)
         values ('probe_valid_parsed_0124.xlsx', 'parsed')
         returning id`,
      );
      const validSheet = await client.query<{ id: string }>(
        `insert into public.source_sheets (workbook_id, sheet_name, sheet_index)
         values ($1, 'Sheet1', 0)
         returning id`,
        [validParsed.rows[0]!.id],
      );
      await client.query(
        `insert into public.import_rows (workbook_id, sheet_id, row_index, row_json)
         values ($1, $2, 1, '{"A":"valid"}'::jsonb)`,
        [validParsed.rows[0]!.id, validSheet.rows[0]!.id],
      );

      const visibleProbes = await client.query<{ id: string }>(
        `select id::text as id
           from public.valid_workbook_imports
          where id = any($1::uuid[])`,
        [
          [
            emptyParsed.rows[0]!.id,
            failedWithRows.rows[0]!.id,
            validParsed.rows[0]!.id,
          ],
        ],
      );

      expect(visibleProbes.rows.map((r) => r.id)).toEqual([validParsed.rows[0]!.id]);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    const afterWbCount = Number(
      (await ownerPool.query<{ n: number }>("select count(*)::int as n from public.source_workbooks"))
        .rows[0]?.n ?? 0,
    );
    expect(afterWbCount).toBe(beforeWbCount);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("4. verifies migration manifest vs applied schema_migrations parity (124/0124) and standardized -31 reminder rules", async () => {
    const fileSet = validateFileSet();
    expect(fileSet.ok).toBe(true);
    expect(fileSet.errors).toEqual([]);
    expect(fileSet.files.length).toBeGreaterThanOrEqual(124);
    expect(fileSet.files.some((f) => f.version === "0124")).toBe(true);

    const manifest = readExpectedSchemaManifest();
    expect(manifest.expectedCount).toBe(fileSet.files.length);
    expect(manifest.expectedLatestVersion).toBe(fileSet.files.at(-1)!.version);
    expect(manifest.expectedCount).toBeGreaterThanOrEqual(124);
    expect(Number(manifest.expectedLatestVersion)).toBeGreaterThanOrEqual(124);

    // Check parity via runtime mas_radar_app connection (SECURITY DEFINER get_schema_ledger_summary)
    const parity = await checkSchemaParity(appPool);
    expect(parity.aligned).toBe(true);
    expect(parity.error).toBeNull();
    expect(parity.actualCount).toBe(manifest.expectedCount);
    expect(parity.actualLatestVersion).toBe(manifest.expectedLatestVersion);
    expect(parity.checksumDigest).toMatch(/^[0-9a-f]{64}$/);

    // Verify 0124 checksum in schema_migrations matches on-disk SQL file
    const file0124 = fileSet.files.find((f) => f.version === "0124")!;
    const ledger0124 = await ownerPool.query<{
      version: string;
      name: string;
      checksum: string;
    }>("select version, name, checksum from public.schema_migrations where version = '0124'");
    expect(ledger0124.rowCount).toBe(1);
    expect(ledger0124.rows[0]!.name).toBe("0124_remediation_outbox_incidents_import_freshness.sql");
    expect(ledger0124.rows[0]!.checksum).toBe(checksumContent(file0124.content));

    // Verify -31 reminder rule names standardized to '31+' and internal workflow wording (zero '30+' or 'hukuki')
    const rules31 = await ownerPool.query<{ id: string; name: string; target_kind: string }>(
      "select id::text as id, name, target_kind from public.reminders where offset_days = -31 order by target_kind",
    );
    expect(rules31.rows.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules31.rows) {
      expect(rule.name).toContain("31+");
      expect(rule.name).not.toContain("30+");
      expect(rule.name.toLocaleLowerCase("tr-TR")).not.toContain("hukuki");
    }
    const paymentRule31 = rules31.rows.find((r) => r.target_kind === "payment_instance");
    expect(paymentRule31?.name.toLocaleLowerCase("tr-TR")).toContain(
      "üst eskalasyon (iç inceleme)",
    );
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("5. validates 0124 constraints ('delivery_uncertain', 'claiming', 'SUPPRESSED') inside BEGIN...ROLLBACK with zero persisted rows", async () => {
    const countSnapshot = async () => {
      const res = await ownerPool.query<{
        outbox_n: number;
        deliveries_n: number;
        incidents_n: number;
      }>(
        `select
           (select count(*)::int from public.notification_outbox) as outbox_n,
           (select count(*)::int from public.reminder_deliveries) as deliveries_n,
           (select count(*)::int from public.ops_incidents) as incidents_n`,
      );
      return res.rows[0]!;
    };

    const beforeCounts = await countSnapshot();

    // Verify partial index on reminder_deliveries exists
    const idxRes = await ownerPool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'reminder_deliveries'
          and indexname = 'reminder_deliveries_pending_sched_idx'`,
    );
    expect(idxRes.rowCount).toBe(1);
    expect(idxRes.rows[0]!.indexdef.toLowerCase()).toContain("claiming");

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE mas_radar_finance_operator");

      // (a) notification_outbox accepts 'delivery_uncertain' + uncertain_at + correlation_id, rejects invalid status
      const idemKey = `probe-0124-uncertain-${randomUUID()}`;
      const outboxIns = await client.query<{
        id: string;
        status: string;
        correlation_id: string | null;
        has_uncertain_at: boolean;
      }>(
        `insert into public.notification_outbox
           (stream, channel, recipient_target, idempotency_key, body_text, status, uncertain_at, correlation_id)
         values
           ('ops_incident', 'telegram', '-100123456', $1, 'Probe uncertain delivery', 'delivery_uncertain', now(), 'corr-outbox-0124')
         returning id::text as id, status, correlation_id, (uncertain_at is not null) as has_uncertain_at`,
        [idemKey],
      );
      expect(outboxIns.rows[0]?.status).toBe("delivery_uncertain");
      expect(outboxIns.rows[0]?.correlation_id).toBe("corr-outbox-0124");
      expect(outboxIns.rows[0]?.has_uncertain_at).toBe(true);

      await client.query("SAVEPOINT sp_bad_outbox");
      let badOutboxCode: string | null = null;
      try {
        await client.query(
          "update public.notification_outbox set status = 'invalid_status' where id = $1::uuid",
          [outboxIns.rows[0]!.id],
        );
      } catch (err) {
        badOutboxCode = (err as { code?: string }).code ?? "unknown";
      }
      await client.query("ROLLBACK TO SAVEPOINT sp_bad_outbox");
      expect(badOutboxCode).toBe("23514");

      // (b) reminder_deliveries accepts 'claiming' + claim_token + claimed_at AND 'delivery_uncertain', rejects invalid status
      const ruleRes = await client.query<{ id: string }>(
        "select id::text as id from public.reminders limit 1",
      );
      expect(ruleRes.rowCount).toBe(1);
      const claimToken = randomUUID();
      const entityId = randomUUID();

      const delivIns = await client.query<{
        id: string;
        status: string;
        claim_token: string | null;
        has_claimed_at: boolean;
      }>(
        `insert into public.reminder_deliveries
           (reminder_id, entity_table, entity_id, scheduled_for, status, claim_token, claimed_at)
         values
           ($1::uuid, 'payment_instances', $2::uuid, '2099-12-31', 'claiming', $3::uuid, now())
         returning id::text as id, status, claim_token::text as claim_token, (claimed_at is not null) as has_claimed_at`,
        [ruleRes.rows[0]!.id, entityId, claimToken],
      );
      expect(delivIns.rows[0]?.status).toBe("claiming");
      expect(delivIns.rows[0]?.claim_token).toBe(claimToken);
      expect(delivIns.rows[0]?.has_claimed_at).toBe(true);

      const delivUncertain = await client.query<{ status: string }>(
        `update public.reminder_deliveries
            set status = 'delivery_uncertain', claim_token = null
          where id = $1::uuid
         returning status`,
        [delivIns.rows[0]!.id],
      );
      expect(delivUncertain.rows[0]?.status).toBe("delivery_uncertain");

      await client.query("SAVEPOINT sp_bad_deliv");
      let badDelivCode: string | null = null;
      try {
        await client.query(
          "update public.reminder_deliveries set status = 'bogus_delivery_state' where id = $1::uuid",
          [delivIns.rows[0]!.id],
        );
      } catch (err) {
        badDelivCode = (err as { code?: string }).code ?? "unknown";
      }
      await client.query("ROLLBACK TO SAVEPOINT sp_bad_deliv");
      expect(badDelivCode).toBe("23514");

      // (c) ops_incidents accepts 'SUPPRESSED' + suppression/evidence/correlation columns, rejects invalid state
      const signalKey = `probe_signal_0124_${randomUUID().slice(0, 8)}`;
      const incIns = await client.query<{
        signal_key: string;
        state: string;
        suppression_reason: string | null;
        correlation_id: string | null;
        evidence_check: string | null;
      }>(
        `insert into public.ops_incidents
           (signal_key, severity, state, suppressed_until, suppression_reason,
            last_checked_at, last_success_at, resolution_evidence, correlation_id)
         values
           ($1, 'P1', 'SUPPRESSED', now() + interval '2 hours', 'bakım penceresi',
            now(), now(), '{"verifiedByCheck":"agent01-probe","measuredValue":"124/0124"}'::jsonb, 'corr-inc-0124')
         returning signal_key,
                   state,
                   suppression_reason,
                   correlation_id,
                   resolution_evidence->>'verifiedByCheck' as evidence_check`,
        [signalKey],
      );
      expect(incIns.rows[0]?.state).toBe("SUPPRESSED");
      expect(incIns.rows[0]?.suppression_reason).toBe("bakım penceresi");
      expect(incIns.rows[0]?.correlation_id).toBe("corr-inc-0124");
      expect(incIns.rows[0]?.evidence_check).toBe("agent01-probe");

      await client.query("SAVEPOINT sp_bad_inc");
      let badIncCode: string | null = null;
      try {
        await client.query(
          "update public.ops_incidents set state = 'INVALID_STATE' where signal_key = $1",
          [signalKey],
        );
      } catch (err) {
        badIncCode = (err as { code?: string }).code ?? "unknown";
      }
      await client.query("ROLLBACK TO SAVEPOINT sp_bad_inc");
      expect(badIncCode).toBe("23514");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }

    const afterCounts = await countSnapshot();
    expect(afterCounts).toEqual(beforeCounts);
  }, SUBPROCESS_TEST_TIMEOUT_MS);
});
