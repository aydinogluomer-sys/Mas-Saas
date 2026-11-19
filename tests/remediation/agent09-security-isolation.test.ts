import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const headerMockState = vi.hoisted(() => ({
  cookieToken: undefined as string | undefined,
  headers: {} as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "mas_session" && headerMockState.cookieToken
        ? { value: headerMockState.cookieToken }
        : undefined,
    set: () => {},
    delete: () => {
      headerMockState.cookieToken = undefined;
    },
  }),
  headers: async () => ({
    get: (name: string) => {
      const target = name.toLowerCase();
      for (const [k, v] of Object.entries(headerMockState.headers)) {
        if (k.toLowerCase() === target) return v;
      }
      return null;
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import {
  decideApproval,
  evaluateSelfApprovalEligibility,
  loadActiveApproverCount,
  loadApprovalGovernanceSettings,
  updateApprovalGovernanceSettings,
} from "@/lib/approvals/engine";
import { clearRequestSessionCache, getCurrentUser } from "@/lib/auth";
import { resolveAllowedLegalEntityId } from "@/lib/authz/context";
import { can } from "@/lib/authz/matrix";
import {
  ALERT_STATUS_LABEL,
  ANOMALY_LABEL,
  CONTROL_EVIDENCE_LABEL,
  IBAN_CHANGE_TYPE_LABEL,
  INTERNAL_WORKFLOW_CLASSIFICATION_ONLY,
  SEVERITY_LABEL,
  hasStatutoryLegalProceedingClaim,
} from "@/lib/controls/rules";
import { addIban } from "@/lib/counterparties/engine";
import { isTurkishIban, isValidIbanChecksum } from "@/lib/counterparties/rules";
import { env, isLoopbackHostname } from "@/lib/env";
import { extractHostHeaderHostname } from "@/lib/env-validators";
import { looksLikeSecret, redactSecrets } from "@/lib/ops/alert-delivery";
import { createPayment, markInstancePaid } from "@/lib/radar/engine";
import {
  redactBotToken,
  scrubSensitiveTelegramText,
  sendTelegramChatMessage,
} from "@/lib/reminders/transport";
import { readEnvLocal } from "../../scripts/db/app-url";

/** Deterministic ISO 13616 MOD-97-10 Turkish IBAN generator for isolated rollback tests. */
function makeValidTrIban(bankCode5: string, account17: string): string {
  const bban = `${bankCode5.padStart(5, "0").slice(0, 5)}0${account17.padStart(16, "0").slice(0, 16)}`;
  const rearranged = `${bban}TR00`;
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) {
      rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
    }
  }
  const check = String(98 - rem).padStart(2, "0");
  return `TR${check}${bban}`;
}

/** Wraps a pinned `PoolClient` as a `Pool`-compatible adapter mapping inner BEGIN/COMMIT/ROLLBACK to nested SAVEPOINTs so outer ROLLBACK leaves zero DB trace. */
function wrapPinnedTransactionPool(client: PoolClient): Pool {
  let depth = 0;
  const txClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (sql: unknown, params?: unknown[]) => {
          const rawQuery = target.query.bind(target) as (q: unknown, p?: unknown[]) => Promise<unknown>;
          if (typeof sql === "string") {
            const norm = sql.trim().toLowerCase();
            if (norm === "begin") {
              depth += 1;
              await rawQuery(`SAVEPOINT sp_nested_tx_${depth}`);
              return { rows: [], rowCount: 0, command: "BEGIN", oid: 0, fields: [] };
            }
            if (norm === "commit") {
              if (depth > 0) {
                const sp = `sp_nested_tx_${depth}`;
                depth -= 1;
                await rawQuery(`RELEASE SAVEPOINT ${sp}`);
              }
              return { rows: [], rowCount: 0, command: "COMMIT", oid: 0, fields: [] };
            }
            if (norm === "rollback") {
              if (depth > 0) {
                const sp = `sp_nested_tx_${depth}`;
                depth -= 1;
                await rawQuery(`ROLLBACK TO SAVEPOINT ${sp}`);
                await rawQuery(`RELEASE SAVEPOINT ${sp}`);
              }
              return { rows: [], rowCount: 0, command: "ROLLBACK", oid: 0, fields: [] };
            }
          }
          return rawQuery(sql, params);
        };
      }
      if (prop === "release") {
        return () => {};
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  return {
    query: txClient.query.bind(txClient),
    connect: async () => txClient,
  } as unknown as Pool;
}

async function expectPgError(
  client: PoolClient,
  savepointName: string,
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  await client.query(`SAVEPOINT ${savepointName}`);
  try {
    await fn();
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    const pgErr = err as { code?: string; message?: string };
    return {
      code: pgErr.code,
      message: pgErr.message ?? String(err),
    };
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  await client.query(`RELEASE SAVEPOINT ${savepointName}`);
  throw new Error(`Expected PostgreSQL error at savepoint ${savepointName}, but statement succeeded.`);
}

interface DbImmutableFingerprint {
  paymentInstancesCount: number;
  controlAlertsCount: number;
  openApprovalBypassAlerts: Array<{ id: string; status: string; occurrence_count: number }>;
  historical33adRow: {
    id: string;
    status: string;
    amount: string;
    paid_amount: string;
    approval_status: string;
  } | null;
  approvalsCount: number;
  ibansCount: number;
  legalEntitiesCount: number;
  auditLogsCount: number;
}

async function captureLiveDbFingerprint(pool: Pool): Promise<DbImmutableFingerprint> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE mas_radar_admin");
    await client.query("SELECT set_config('app.current_legal_entity_id', '', true)");

    const counts = await client.query<{
      pi_cnt: number;
      ca_cnt: number;
      ap_cnt: number;
      ib_cnt: number;
      le_cnt: number;
      al_cnt: number;
    }>(`
      select
        (select count(*)::int from public.payment_instances) as pi_cnt,
        (select count(*)::int from public.control_alerts) as ca_cnt,
        (select count(*)::int from public.approvals) as ap_cnt,
        (select count(*)::int from public.ibans) as ib_cnt,
        (select count(*)::int from public.legal_entities) as le_cnt,
        (select count(*)::int from public.audit_logs) as al_cnt
    `);

    const bypassAlerts = await client.query<{
      id: string;
      status: string;
      occurrence_count: number;
    }>(`
      select id::text, status, occurrence_count::int
        from public.control_alerts
       where check_code = 'approval_bypass'
       order by id
    `);

    const row33 = await client.query<{
      id: string;
      status: string;
      amount: string;
      paid_amount: string;
      approval_status: string;
    }>(`
      select id::text, status, amount::text, paid_amount::text, approval_status
        from public.payment_instances
       where id::text like '33ad79cf%'
       limit 1
    `);

    await client.query("ROLLBACK");

    const c = counts.rows[0]!;
    return {
      paymentInstancesCount: c.pi_cnt,
      controlAlertsCount: c.ca_cnt,
      openApprovalBypassAlerts: bypassAlerts.rows,
      historical33adRow: row33.rows[0] ?? null,
      approvalsCount: c.ap_cnt,
      ibansCount: c.ib_cnt,
      legalEntitiesCount: c.le_cnt,
      auditLogsCount: c.al_cnt,
    };
  } finally {
    client.release();
  }
}

function resolveLiveAppDbUrl(): string {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  try {
    return readEnvLocal().DATABASE_URL?.trim() ?? "";
  } catch {
    return "";
  }
}

describe.skipIf(!resolveLiveAppDbUrl())("AGENT 09 — Security, Approval Workflows, IBAN Hard-Gates & Multi-Entity Isolation", () => {
  let livePool: Pool;
  let baselineFingerprint: DbImmutableFingerprint;

  beforeAll(async () => {
    livePool = new Pool({
      connectionString: resolveLiveAppDbUrl(),
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 30_000,
    });
    baselineFingerprint = await captureLiveDbFingerprint(livePool);
  }, 30_000);

  afterAll(async () => {
    if (livePool) {
      try {
        if (baselineFingerprint !== undefined) {
          const afterFingerprint = await captureLiveDbFingerprint(livePool);
          expect(afterFingerprint).toEqual(baselineFingerprint);
        }
      } finally {
        await livePool.end();
      }
    }
  }, 30_000);

  beforeEach(() => {
    vi.unstubAllEnvs();
    headerMockState.cookieToken = undefined;
    headerMockState.headers = {};
    clearRequestSessionCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearRequestSessionCache();
  });

  describe("1. I-015 Historical Evidence Transparency & Outflow Settlement Maker-Checker Hard-Gates", () => {
    it("preserves historical pre-gate 33ad79cf (120,000 TRY) finding openly in control_approval_bypass & control_alerts", async () => {
      const client = await livePool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL ROLE mas_radar_admin");
        await client.query("SELECT set_config('app.current_legal_entity_id', '', true)");

        expect(baselineFingerprint.historical33adRow).toEqual({
          id: "33ad79cf-d017-4fc1-9b58-f7772a4e577a",
          status: "paid",
          amount: "120000.00",
          paid_amount: "120000.00",
          approval_status: "not_required",
        });

        const viewRes = await client.query<{
          payment_instance_id: string;
          payment_name: string;
          amount: string;
          threshold_amount: string;
        }>(`
          select payment_instance_id::text, payment_name, amount::text, threshold_amount::text
            from public.control_approval_bypass
           where payment_instance_id::text like '33ad79cf%'
        `);
        expect(viewRes.rowCount).toBe(1);
        expect(viewRes.rows[0]?.amount).toBe("120000.00");
        expect(Number(viewRes.rows[0]?.threshold_amount)).toBe(100_000);

        expect(baselineFingerprint.openApprovalBypassAlerts.length).toBeGreaterThanOrEqual(1);
        expect(
          baselineFingerprint.openApprovalBypassAlerts.some((a) => a.status === "open"),
        ).toBe(true);

        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("blocks unapproved >= 100,000 TRY outflow settlement at BOTH markInstancePaid (FORBIDDEN) and PostgreSQL trigger (42501), while allowing < 100k and approved >= 100k inside ROLLBACK", async () => {
      // (A) Application-layer gate (`markInstancePaid` -> DomainError("FORBIDDEN"))
      let paidUpdateExecuted = false;
      const appMockInstanceId = "33ad79cf-1111-4000-8000-000000000901";
      const mockPool = {
        connect: async () => ({
          async query(sql: string) {
            const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
            if (
              norm === "begin" ||
              norm === "commit" ||
              norm === "rollback" ||
              norm.startsWith("savepoint ") ||
              norm.startsWith("release savepoint ") ||
              norm.startsWith("rollback to savepoint ")
            ) {
              return { rows: [], rowCount: 0 };
            }
            if (norm.includes("from public.payment_instances where id=$1 for update")) {
              return {
                rows: [
                  {
                    id: appMockInstanceId,
                    status: "unpaid",
                    amount: "120000.00",
                    paid_amount: null,
                    paid_at: null,
                    direction: "outflow",
                    currency: "TRY",
                    approval_status: "not_required",
                    due_date: "2026-11-25",
                  },
                ],
                rowCount: 1,
              };
            }
            if (norm.includes("from public.approval_rules")) {
              return {
                rows: [
                  {
                    code: "amount_over_100k",
                    description: "100.000 TL ve üzeri ödeme/fatura ikinci onay ister",
                    trigger_kind: "amount_threshold",
                    threshold_amount: "100000.00",
                    currency: "TRY",
                    applies_to: ["invoices", "payment_instances"],
                    is_active: true,
                  },
                ],
                rowCount: 1,
              };
            }
            if (norm.includes("from public.approvals")) {
              return { rows: [], rowCount: 0 };
            }
            if (norm.startsWith("insert into public.approvals")) {
              return { rows: [{ id: "aaaa1111-0000-4000-8000-000000000001" }], rowCount: 1 };
            }
            if (norm.includes("set status='paid'")) {
              paidUpdateExecuted = true;
              return { rows: [], rowCount: 1 };
            }
            return { rows: [{ id: "ok" }], rowCount: 1 };
          },
          release() {},
        }),
      } as unknown as Pool;

      await expect(
        markInstancePaid(
          mockPool,
          appMockInstanceId,
          120_000,
          "40672c5c-25f0-4623-ae62-55a34e8df5b1",
        ),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(paidUpdateExecuted).toBe(false);

      // (B) PostgreSQL trigger-level hard-gate (`enforce_outflow_settlement_approval_gate` -> 42501) on mas_radar_dev
      const client = await livePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mas_radar_admin");

        const usersRes = await client.query<{ id: string }>(
          `select id::text from public.users where is_active = true and role = 'admin' order by created_at asc limit 2`,
        );
        expect(usersRes.rows.length).toBeGreaterThanOrEqual(2);
        const makerId = usersRes.rows[0]!.id;
        const checkerId = usersRes.rows[1]!.id;

        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.current_legal_entity_id', '', true)",
          [makerId],
        );

        // Insert a 120,000 TRY unpaid outflow in an unlocked future period (2089-07)
        const highPiRes = await client.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, amount, currency, amount_status, direction, status, approval_status, amount_source)
           values ('2089-07-01', '2089-07-15', 120000.00, 'TRY', 'known', 'outflow', 'unpaid', 'not_required', 'manual')
           returning id::text`,
        );
        const highPiId = highPiRes.rows[0]!.id;

        // Negative 1: Direct SQL full settlement without approval -> SQLSTATE 42501 APPROVAL_REQUIRED
        const errFull = await expectPgError(client, "sp_unapproved_full", () =>
          client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 120000.00, paid_at = now() where id = $1::uuid`,
            [highPiId],
          ),
        );
        expect(errFull.code).toBe("42501");
        expect(errFull.message).toContain("APPROVAL_REQUIRED");

        // Negative 2: Direct SQL partial settlement on a 120,000 TRY scheduled outflow -> SQLSTATE 42501
        const errPartial = await expectPgError(client, "sp_unapproved_partial", () =>
          client.query(
            `update public.payment_instances set status = 'partial', paid_amount = 25000.00, paid_at = now() where id = $1::uuid`,
            [highPiId],
          ),
        );
        expect(errPartial.code).toBe("42501");
        expect(errPartial.message).toContain("APPROVAL_REQUIRED");

        // Negative 3: Spoofing payment_instances.approval_status = 'approved' without a real public.approvals row -> SQLSTATE 42501
        await client.query(`SAVEPOINT sp_spoofed_approval_flag`);
        await client.query(
          `update public.payment_instances set approval_status = 'approved' where id = $1::uuid`,
          [highPiId],
        );
        let spoofErrCode: string | undefined;
        try {
          await client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 120000.00, paid_at = now() where id = $1::uuid`,
            [highPiId],
          );
        } catch (err) {
          spoofErrCode = (err as { code?: string }).code;
        }
        await client.query(`ROLLBACK TO SAVEPOINT sp_spoofed_approval_flag`);
        await client.query(`RELEASE SAVEPOINT sp_spoofed_approval_flag`);
        expect(spoofErrCode).toBe("42501");

        // Positive Control 1: Outflow strictly below threshold (99,999.99 TRY < 100,000 TRY) settles cleanly
        const lowPiRes = await client.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, amount, currency, amount_status, direction, status, approval_status, amount_source)
           values ('2089-07-01', '2089-07-16', 99999.99, 'TRY', 'known', 'outflow', 'unpaid', 'not_required', 'manual')
           returning id::text`,
        );
        const lowUpd = await client.query(
          `update public.payment_instances set status = 'paid', paid_amount = 99999.99, paid_at = now() where id = $1::uuid`,
          [lowPiRes.rows[0]!.id],
        );
        expect(lowUpd.rowCount).toBe(1);

        // Positive Control 2: 120,000 TRY outflow WITH genuine maker <> checker 'approved' round settles cleanly
        const appIns = await client.query<{ id: string }>(
          `insert into public.approvals
             (subject_table, subject_id, subject_label, request_kind, rule_code, round_no, amount, currency, status, requested_by)
           values ('payment_instances', $1::uuid, 'Test 120K Outflow', 'amount_threshold', 'amount_over_100k', 1, 120000.00, 'TRY', 'pending', $2::uuid)
           returning id::text`,
          [highPiId, makerId],
        );
        const approvalId = appIns.rows[0]!.id;

        await client.query("SELECT set_config('app.user_id', $1, true)", [checkerId]);
        const txPool = wrapPinnedTransactionPool(client);
        await decideApproval(
          txPool,
          {
            approvalId,
            decision: "approved",
            note: "Fatura ve ödeme talimatı 4-göz kontrolünden geçti",
          },
          checkerId,
        );

        const approvedSettle = await client.query(
          `update public.payment_instances set status = 'paid', paid_amount = 120000.00, paid_at = now() where id = $1::uuid`,
          [highPiId],
        );
        expect(approvedSettle.rowCount).toBe(1);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });
  });

  describe("2. Multi-Entity RESTRICTIVE RLS Isolation & Cookie Membership Pinning", () => {
    it("isolates Entity A rows from mas_radar_viewer and mas_radar_finance_operator sessions scoped to Entity B inside ROLLBACK", async () => {
      const client = await livePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mas_radar_admin");
        await client.query("SELECT set_config('app.current_legal_entity_id', '', true)");

        const entARes = await client.query<{ id: string }>(
          `insert into public.legal_entities (code, name, tax_id_vkn, base_currency, is_default, is_active)
           values ('ENT-TEST-A', 'Test Tüzel Kişilik A A.Ş.', '9000000011', 'TRY', false, true)
           returning id::text`,
        );
        const entBRes = await client.query<{ id: string }>(
          `insert into public.legal_entities (code, name, tax_id_vkn, base_currency, is_default, is_active)
           values ('ENT-TEST-B', 'Test Tüzel Kişilik B Ltd.', '9000000022', 'TRY', false, true)
           returning id::text`,
        );
        const entityA = entARes.rows[0]!.id;
        const entityB = entBRes.rows[0]!.id;

        const payA = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
             values ('Entity A Kira Şablonu', 'monthly', 10, 45000.00, 'TRY', 'outflow', 'active', $1::uuid)
             returning id::text`,
            [entityA],
          )
        ).rows[0]!.id;

        const payB = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
             values ('Entity B Kira Şablonu', 'monthly', 10, 35000.00, 'TRY', 'outflow', 'active', $1::uuid)
             returning id::text`,
            [entityB],
          )
        ).rows[0]!.id;

        const piA = (
          await client.query<{ id: string }>(
            `insert into public.payment_instances
               (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source, legal_entity_id)
             values ($1::uuid, '2089-08-01', '2089-08-10', 45000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated', $2::uuid)
             returning id::text`,
            [payA, entityA],
          )
        ).rows[0]!.id;

        const piB = (
          await client.query<{ id: string }>(
            `insert into public.payment_instances
               (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source, legal_entity_id)
             values ($1::uuid, '2089-08-01', '2089-08-10', 35000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated', $2::uuid)
             returning id::text`,
            [payB, entityB],
          )
        ).rows[0]!.id;

        const alertA = (
          await client.query<{ id: string }>(
            `insert into public.control_alerts (check_code, severity, title, rule_codes, status, legal_entity_id)
             values ('test_rls_a', 'warning', 'Entity A Kontrol Bulgusu', '{round_number}', 'open', $1::uuid)
             returning id::text`,
            [entityA],
          )
        ).rows[0]!.id;

        const alertB = (
          await client.query<{ id: string }>(
            `insert into public.control_alerts (check_code, severity, title, rule_codes, status, legal_entity_id)
             values ('test_rls_b', 'warning', 'Entity B Kontrol Bulgusu', '{round_number}', 'open', $1::uuid)
             returning id::text`,
            [entityB],
          )
        ).rows[0]!.id;

        // Switch into mas_radar_viewer pinned to Entity B
        await client.query("SELECT set_config('app.current_legal_entity_id', $1, true)", [entityB]);
        await client.query("SET LOCAL ROLE mas_radar_viewer");

        // Negative: Entity A rows are completely invisible (0 rows)
        const viewerSeePayA = await client.query(`select id from public.payments where id = $1::uuid`, [payA]);
        const viewerSeePiA = await client.query(`select id from public.payment_instances where id = $1::uuid`, [piA]);
        const viewerSeeAlertA = await client.query(`select id from public.control_alerts where id = $1::uuid`, [alertA]);
        expect(viewerSeePayA.rowCount).toBe(0);
        expect(viewerSeePiA.rowCount).toBe(0);
        expect(viewerSeeAlertA.rowCount).toBe(0);

        // Positive control: Entity B rows are visible (1 row each)
        const viewerSeePayB = await client.query(`select id from public.payments where id = $1::uuid`, [payB]);
        const viewerSeePiB = await client.query(`select id from public.payment_instances where id = $1::uuid`, [piB]);
        const viewerSeeAlertB = await client.query(`select id from public.control_alerts where id = $1::uuid`, [alertB]);
        expect(viewerSeePayB.rowCount).toBe(1);
        expect(viewerSeePiB.rowCount).toBe(1);
        expect(viewerSeeAlertB.rowCount).toBe(1);

        // Switch into mas_radar_finance_operator pinned to Entity B -> cross-entity INSERT into Entity A is blocked by RESTRICTIVE WITH CHECK
        await client.query("SET LOCAL ROLE mas_radar_finance_operator");
        const crossEntityInsertErr = await expectPgError(client, "sp_cross_entity_insert", () =>
          client.query(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
             values ('Yetkisiz Entity A Kaydı', 'monthly', 15, 10000.00, 'TRY', 'outflow', 'active', $1::uuid)`,
            [entityA],
          ),
        );
        expect(crossEntityInsertErr.code).toBe("42501");

        // Positive control: same operator inserting into Entity B succeeds
        const sameEntityInsert = await client.query(
          `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
           values ('Yetkili Entity B Kaydı', 'monthly', 15, 10000.00, 'TRY', 'outflow', 'active', $1::uuid)`,
          [entityB],
        );
        expect(sameEntityInsert.rowCount).toBe(1);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });

    it("pins non-manager roles to assigned user_legal_entities and prevents unauthorized cookie spoofing", () => {
      const entityA = "11111111-1111-4111-8111-111111111111";
      const entityB = "22222222-2222-4222-8222-222222222222";

      for (const role of ["viewer", "finance_operator", "finance_approver"] as const) {
        // Attempting to spoof Entity A cookie while only assigned to Entity B falls back to Entity B
        expect(resolveAllowedLegalEntityId(role, entityA, [entityB])).toBe(entityB);
        // Attempting consolidated group view (null cookie) while assigned to Entity B stays pinned to Entity B
        expect(resolveAllowedLegalEntityId(role, null, [entityB])).toBe(entityB);
        // Requesting assigned Entity B is permitted
        expect(resolveAllowedLegalEntityId(role, entityB, [entityA, entityB])).toBe(entityB);
      }

      // Managers and admins may inspect any valid entity UUID or consolidated view (null)
      expect(resolveAllowedLegalEntityId("admin", entityA, [entityB])).toBe(entityA);
      expect(resolveAllowedLegalEntityId("finance_manager", null, [entityB])).toBeNull();
      // Malformed non-UUID cookie is always sanitized to null
      expect(resolveAllowedLegalEntityId("admin", "'; DROP TABLE payments; --", [])).toBeNull();
    });
  });

  describe("3. RBAC Tier Boundaries (mas_radar_viewer & Unswitched Runtime Role)", () => {
    it("enforces least-privilege runtime role (mas_radar_app) and blocks mas_radar_viewer from INSERT/UPDATE/DELETE on payments, payment_instances, and approvals", async () => {
      // Static matrix check
      for (const tbl of ["payments", "payment_instances", "approvals", "ibans", "control_alerts"]) {
        expect(can("viewer", tbl, "select"), `viewer select ${tbl}`).toBe(true);
        expect(can("viewer", tbl, "insert"), `viewer insert ${tbl}`).toBe(false);
        expect(can("viewer", tbl, "update"), `viewer update ${tbl}`).toBe(false);
        expect(can("viewer", tbl, "delete"), `viewer delete ${tbl}`).toBe(false);
      }

      const client = await livePool.connect();
      try {
        await client.query("BEGIN");

        // 1) Unswitched runtime connection (`mas_radar_app`) is NOSUPERUSER, NOBYPASSRLS, sees 0 business rows, and cannot INSERT
        const roleAttrs = await client.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
        expect(roleAttrs.rows[0]).toEqual({
          rolname: "mas_radar_app",
          rolsuper: false,
          rolbypassrls: false,
        });

        await client.query("SAVEPOINT sp_raw_app_read");
        let rawVisibleCount = 0;
        try {
          const rawRead = await client.query<{ cnt: number }>(`select count(*)::int as cnt from public.payments`);
          rawVisibleCount = rawRead.rows[0]?.cnt ?? 0;
        } catch (err) {
          expect((err as { code?: string }).code).toBe("42501");
        }
        await client.query("ROLLBACK TO SAVEPOINT sp_raw_app_read");
        await client.query("RELEASE SAVEPOINT sp_raw_app_read");
        expect(rawVisibleCount).toBe(0);

        const rawInsertErr = await expectPgError(client, "sp_raw_app_insert", () =>
          client.query(
            `insert into public.payments (name, recurrence_type, due_day, direction, status)
             values ('Raw Role Write Attempt', 'monthly', 1, 'outflow', 'active')`,
          ),
        );
        expect(rawInsertErr.code).toBe("42501");

        // Seed target IDs as admin inside transaction so UPDATE/DELETE probes target real existing rows
        await client.query("SET LOCAL ROLE mas_radar_admin");
        await client.query("SELECT set_config('app.current_legal_entity_id', '', true)");
        const payId = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status)
             values ('Viewer Negatif Test Şablonu', 'monthly', 12, 5000.00, 'TRY', 'outflow', 'active')
             returning id::text`,
          )
        ).rows[0]!.id;
        const piId = (
          await client.query<{ id: string }>(
            `insert into public.payment_instances
               (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source)
             values ($1::uuid, '2089-09-01', '2089-09-12', 5000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated')
             returning id::text`,
            [payId],
          )
        ).rows[0]!.id;
        const appId = (
          await client.query<{ id: string }>(
            `insert into public.approvals (subject_table, subject_id, request_kind, status)
             values ('payment_instances', $1::uuid, 'payment', 'pending')
             returning id::text`,
            [piId],
          )
        ).rows[0]!.id;

        // 2) Switch into `mas_radar_viewer`
        await client.query("SET LOCAL ROLE mas_radar_viewer");

        // Positive control: viewer can SELECT all three tables
        expect((await client.query(`select 1 from public.payments where id = $1::uuid`, [payId])).rowCount).toBe(1);
        expect((await client.query(`select 1 from public.payment_instances where id = $1::uuid`, [piId])).rowCount).toBe(1);
        expect((await client.query(`select 1 from public.approvals where id = $1::uuid`, [appId])).rowCount).toBe(1);

        // Negative checks: viewer INSERT fails with 42501; UPDATE / DELETE either fail with 42501 or match 0 rows under RLS USING policies
        const insertProbes: Array<{ label: string; sql: string; params: unknown[] }> = [
          {
            label: "viewer_insert_payments",
            sql: `insert into public.payments (name, recurrence_type, due_day, direction, status) values ('X', 'monthly', 1, 'outflow', 'active')`,
            params: [],
          },
          {
            label: "viewer_insert_payment_instances",
            sql: `insert into public.payment_instances (instance_month, due_date, currency, amount_status, direction, status, amount_source) values ('2089-09-01', '2089-09-15', 'TRY', 'known', 'outflow', 'unpaid', 'manual')`,
            params: [],
          },
          {
            label: "viewer_insert_approvals",
            sql: `insert into public.approvals (subject_table, subject_id, request_kind, status) values ('payments', $1::uuid, 'payment', 'pending')`,
            params: [payId],
          },
        ];

        for (const p of insertProbes) {
          const err = await expectPgError(client, `sp_${p.label}`, () =>
            client.query(p.sql, p.params),
          );
          expect(err.code, p.label).toBe("42501");
        }

        const mutateProbes: Array<{ label: string; sql: string; params: unknown[] }> = [
          {
            label: "viewer_update_payments",
            sql: `update public.payments set name = 'Hacked' where id = $1::uuid`,
            params: [payId],
          },
          {
            label: "viewer_delete_payments",
            sql: `delete from public.payments where id = $1::uuid`,
            params: [payId],
          },
          {
            label: "viewer_update_payment_instances",
            sql: `update public.payment_instances set amount = 1 where id = $1::uuid`,
            params: [piId],
          },
          {
            label: "viewer_delete_payment_instances",
            sql: `delete from public.payment_instances where id = $1::uuid`,
            params: [piId],
          },
          {
            label: "viewer_update_approvals",
            sql: `update public.approvals set notes = 'tamper' where id = $1::uuid`,
            params: [appId],
          },
          {
            label: "viewer_delete_approvals",
            sql: `delete from public.approvals where id = $1::uuid`,
            params: [appId],
          },
        ];

        for (const p of mutateProbes) {
          await client.query(`SAVEPOINT sp_${p.label}`);
          let blocked = false;
          try {
            const res = await client.query(p.sql, p.params);
            blocked = (res.rowCount ?? 0) === 0;
          } catch (err) {
            expect((err as { code?: string }).code, p.label).toBe("42501");
            blocked = true;
          }
          await client.query(`ROLLBACK TO SAVEPOINT sp_${p.label}`);
          await client.query(`RELEASE SAVEPOINT sp_${p.label}`);
          expect(blocked, p.label).toBe(true);
        }

        // Verify all 3 rows remain completely untouched after every viewer mutation attempt
        const verifyPay = await client.query<{ name: string }>(
          `select name from public.payments where id = $1::uuid`,
          [payId],
        );
        const verifyPi = await client.query<{ amount: string }>(
          `select amount::text from public.payment_instances where id = $1::uuid`,
          [piId],
        );
        const verifyApp = await client.query<{ notes: string | null }>(
          `select notes from public.approvals where id = $1::uuid`,
          [appId],
        );
        expect(verifyPay.rows[0]?.name).toBe("Viewer Negatif Test Şablonu");
        expect(verifyPi.rows[0]?.amount).toBe("5000.00");
        expect(verifyApp.rows[0]?.notes).toBeNull();
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });
  });

  describe("4. Maker-Checker Self-Approval Rejection (>= 2 Approvers) & IBAN MOD-97 / Vault Gates", () => {
    it("rejects self-approval and blocks re-enabling single-operator self-approval when >= 2 active approvers exist", async () => {
      const client = await livePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mas_radar_admin");

        const admins = await client.query<{ id: string }>(
          `select id::text from public.users where is_active = true and role in ('finance_approver', 'finance_manager', 'admin') order by created_at asc`,
        );
        expect(admins.rows.length).toBeGreaterThanOrEqual(2);
        const makerAdminId = admins.rows[0]!.id;

        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.current_legal_entity_id', '', true)",
          [makerAdminId],
        );

        const txPool = wrapPinnedTransactionPool(client);
        expect(await loadActiveApproverCount(txPool)).toBeGreaterThanOrEqual(2);

        const govSettings = await loadApprovalGovernanceSettings(txPool);
        expect(govSettings.allowSingleOperatorSelfApproval).toBe(false);

        // 1) evaluateSelfApprovalEligibility rejects unconditionally when >= 2 approvers exist
        await expect(
          evaluateSelfApprovalEligibility(
            client,
            makerAdminId,
            "İki aktif yönetici varken kendi kaydımı onaylama girişimi.",
          ),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
        });

        // 2) updateApprovalGovernanceSettings refuses to re-enable allowSingleOperatorSelfApproval while >= 2 approvers exist
        await expectPgError(client, "sp_gov_reenable_block", async () => {
          await expect(
            updateApprovalGovernanceSettings(
              txPool,
              { allowSingleOperatorSelfApproval: true, minJustificationLength: 15 },
              makerAdminId,
            ),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });
          throw Object.assign(new Error("expected rollback guard"), { code: "GUARD_OK" });
        });

        // 3) PostgreSQL RLS on public.approvals blocks admin self-approval at DB level as well
        const selfAppRes = await client.query<{ id: string }>(
          `insert into public.approvals (subject_table, subject_id, request_kind, status, requested_by)
           values ('invoices', $1::uuid, 'invoice', 'pending', $2::uuid)
           returning id::text`,
          [randomUUID(), makerAdminId],
        );
        const selfAppId = selfAppRes.rows[0]!.id;

        await client.query("SAVEPOINT sp_db_rls_self_approve");
        let dbBlockedSelfApprove = false;
        try {
          const upd = await client.query(
            `update public.approvals
                set status = 'approved',
                    decided_by = $2::uuid,
                    decided_at = now(),
                    self_approved_override = true,
                    self_approval_justification = 'RLS bypass denemesi'
              where id = $1::uuid`,
            [selfAppId, makerAdminId],
          );
          dbBlockedSelfApprove = upd.rowCount === 0;
        } catch {
          dbBlockedSelfApprove = true;
        }
        await client.query("ROLLBACK TO SAVEPOINT sp_db_rls_self_approve");
        await client.query("RELEASE SAVEPOINT sp_db_rls_self_approve");
        expect(dbBlockedSelfApprove).toBe(true);
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });

    it("validates MOD-97 on payment IBANs, registers unverified IBANs in public.ibans with audit + alert, and blocks approving invalid-checksum or self-created IBANs", async () => {
      const validIban = makeValidTrIban("00062", "0000123456789012");
      expect(isTurkishIban(validIban)).toBe(true);
      expect(isValidIbanChecksum(validIban)).toBe(true);

      // Corrupt check digits -> MOD-97 invalid
      const invalidChecksumIban = `TR00${validIban.slice(4)}`;
      expect(isValidIbanChecksum(invalidChecksumIban)).toBe(false);

      const client = await livePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE mas_radar_admin");

        const admins = await client.query<{ id: string }>(
          `select id::text from public.users where is_active = true and role = 'admin' order by created_at asc limit 2`,
        );
        const makerId = admins.rows[0]!.id;
        const checkerId = admins.rows[1]!.id;

        await client.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.current_legal_entity_id', '', true)",
          [makerId],
        );
        const txPool = wrapPinnedTransactionPool(client);

        const partyId = (
          await client.query<{ id: string }>(
            `insert into public.parties (name, normalized_name, party_type)
             values ('Agent09 Tedarikçi Sanayi A.Ş.', 'agent09 tedarikçi sanayi a.ş.', 'vendor')
             returning id::text`,
          )
        ).rows[0]!.id;

        // 1) Payment template with invalid MOD-97 IBAN is rejected immediately
        await expect(
          createPayment(
            txPool,
            {
              name: "Bozuk IBAN Şablonu",
              recurrence_type: "one_off",
              due_date: "2089-06-15",
              default_amount: 25_000,
              currency: "TRY",
              direction: "outflow",
              provider_party_id: partyId,
              iban: invalidChecksumIban,
            },
            "2020-01-15",
            makerId,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION" });

        // 2) Payment template with valid TR IBAN registers unverified IBAN in public.ibans (verified_at IS NULL, pending_approval) + audit + control_iban_changes
        await createPayment(
          txPool,
          {
            name: "Geçerli IBAN Şablonu",
            recurrence_type: "one_off",
            due_date: "2089-06-15",
            default_amount: 25_000,
            currency: "TRY",
            direction: "outflow",
            provider_party_id: partyId,
            iban: validIban,
          },
          "2020-01-15",
          makerId,
        );

        const vaultRow = (
          await client.query<{
            id: string;
            iban_normalized: string;
            approval_status: string;
            verified_at: string | null;
            approval_id: string | null;
          }>(
            `select id::text, iban_normalized, approval_status, verified_at::text, approval_id::text
               from public.ibans
              where party_id = $1::uuid`,
            [partyId],
          )
        ).rows[0]!;
        expect(vaultRow.iban_normalized).toBe(validIban);
        expect(vaultRow.verified_at).toBeNull();
        expect(vaultRow.approval_status).toBe("pending_approval");
        expect(vaultRow.approval_id).toBeTruthy();

        const ibanAudit = await client.query(
          `select 1 from public.audit_logs where entity_table = 'ibans' and entity_id = $1::uuid and action = 'add_iban'`,
          [vaultRow.id],
        );
        expect(ibanAudit.rowCount).toBe(1);

        const ibanCtrlView = await client.query<{ is_recent: boolean; requires_verification: boolean }>(
          `select is_recent, requires_verification from public.control_iban_changes where iban_id = $1::uuid`,
          [vaultRow.id],
        );
        expect(ibanCtrlView.rows[0]).toEqual({ is_recent: true, requires_verification: true });

        // 3) Maker CANNOT self-approve the IBAN (BEC Kalkanı 4-eyes enforcement)
        await expect(
          decideApproval(
            txPool,
            {
              approvalId: vaultRow.approval_id!,
              decision: "approved",
              note: "Kendi eklediğim IBAN'ı onaylama denemesi",
            },
            makerId,
          ),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });

        // 4) Adding a warning-flagged source IBAN with invalid MOD-97 checksum cannot be marked 'approved' even by a distinct checker
        const badIbanAdded = await addIban(
          txPool,
          {
            partyId,
            iban: invalidChecksumIban,
            currency: "TRY",
            accountLabel: "Faturadaki Hatalı IBAN",
          },
          makerId,
        );
        expect(badIbanAdded.warnings.length).toBeGreaterThan(0);
        expect(badIbanAdded.approvalId).toBeTruthy();

        await client.query("SELECT set_config('app.user_id', $1, true)", [checkerId]);
        await expect(
          decideApproval(
            txPool,
            {
              approvalId: badIbanAdded.approvalId!,
              decision: "approved",
              note: "Kontrol basamağı bozuk IBAN onayı denemesi",
            },
            checkerId,
          ),
        ).rejects.toMatchObject({ code: "VALIDATION" });

        const badAfter = await client.query<{ approval_status: string; verified_at: string | null }>(
          `select approval_status, verified_at::text from public.ibans where id = $1::uuid`,
          [badIbanAdded.ibanId],
        );
        expect(badAfter.rows[0]?.verified_at).toBeNull();
        expect(badAfter.rows[0]?.approval_status).toBe("pending_approval");

        // 5) Positive control: Distinct checker approves the valid MOD-97 IBAN -> verified_at stamped & requires_verification cleared
        await decideApproval(
          txPool,
          {
            approvalId: vaultRow.approval_id!,
            decision: "approved",
            note: "Tedarikçi ıslak imzalı IBAN teyit yazısı kontrol edildi",
          },
          checkerId,
        );
        const goodAfter = await client.query<{
          approval_status: string;
          verified_at: string | null;
          verified_by: string | null;
        }>(
          `select approval_status, verified_at::text, verified_by::text from public.ibans where id = $1::uuid`,
          [vaultRow.id],
        );
        expect(goodAfter.rows[0]?.approval_status).toBe("approved");
        expect(goodAfter.rows[0]?.verified_at).not.toBeNull();
        expect(goodAfter.rows[0]?.verified_by).toBe(checkerId);

        const ibanCtrlAfter = await client.query<{ is_recent: boolean; requires_verification: boolean }>(
          `select is_recent, requires_verification from public.control_iban_changes where iban_id = $1::uuid`,
          [vaultRow.id],
        );
        expect(ibanCtrlAfter.rows[0]).toEqual({ is_recent: false, requires_verification: false });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    });
  });

  describe("5. Loopback-Only Guard on MAS_LOCAL_PASSWORDLESS & Production Isolation", () => {
    it("unconditionally disables MAS_LOCAL_PASSWORDLESS in NODE_ENV=production and rejects external Host / X-Forwarded-Host headers", async () => {
      // Pure hostname extraction & loopback checks
      expect(isLoopbackHostname("127.0.0.1")).toBe(true);
      expect(isLoopbackHostname("localhost")).toBe(true);
      expect(isLoopbackHostname("[::1]")).toBe(true);
      expect(isLoopbackHostname("192.168.1.50")).toBe(false);
      expect(isLoopbackHostname("10.0.0.12")).toBe(false);
      expect(isLoopbackHostname("0.0.0.0")).toBe(false);
      expect(isLoopbackHostname("127.0.0.2")).toBe(false);
      expect(extractHostHeaderHostname("mas.example.com:443")).toBe("mas.example.com");
      expect(isLoopbackHostname(extractHostHeaderHostname("mas.example.com:443") ?? "")).toBe(false);

      // 1) NODE_ENV=production -> always false / null even with loopback DB and loopback Host header
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MAS_LOCAL_PASSWORDLESS", "1");
      vi.stubEnv("MAS_ALLOW_PASSWORDLESS_IN_TEST", "1");
      vi.stubEnv("MAS_QA_BYPASS_AUTH", "");
      vi.stubEnv("DATABASE_URL", "postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev");

      headerMockState.headers = { host: "127.0.0.1:3000" };
      expect(env.localPasswordless).toBe(false);
      expect(await getCurrentUser()).toBeNull();

      headerMockState.headers = { host: "erp.masmakina.com.tr" };
      expect(await getCurrentUser()).toBeNull();

      // 2) Development mode with MAS_LOCAL_PASSWORDLESS=1 STILL rejects external Host or X-Forwarded-Host headers
      vi.stubEnv("NODE_ENV", "development");
      expect(env.localPasswordless).toBe(true);

      for (const externalHost of [
        "erp.masmakina.com.tr",
        "192.168.1.25:3000",
        "10.0.0.8:3000",
        "172.16.0.4:3000",
        "0.0.0.0:3000",
      ]) {
        headerMockState.headers = { host: externalHost };
        expect(await getCurrentUser(), `Host=${externalHost}`).toBeNull();
      }

      // Reverse-proxy forwarding external X-Forwarded-Host to local 127.0.0.1 -> rejected
      headerMockState.headers = {
        host: "127.0.0.1:3000",
        "x-forwarded-host": "erp.masmakina.com.tr",
      };
      expect(await getCurrentUser()).toBeNull();

      // Positive control: strict loopback Host without external X-Forwarded-Host in development
      headerMockState.headers = { host: "127.0.0.1:3000" };
      const localDevUser = await getCurrentUser();
      expect(localDevUser).not.toBeNull();
      expect(localDevUser?.role).toBe("admin");
    });
  });

  describe("6. Telegram allowedChatIds Guard, Secret/IBAN Redaction & Internal Workflow Control Wording", () => {
    it("blocks unauthorized Telegram chatId destinations before network egress and scrubs tokens & IBANs", async () => {
      let networkCalls = 0;
      const recordedBodies: Array<{ chat_id: string; text: string }> = [];
      const mockFetch: typeof fetch = (async (_url, init) => {
        networkCalls += 1;
        recordedBodies.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      // Negative: unauthorized chatId is refused with zero HTTP calls
      const denied = await sendTelegramChatMessage("-100999888777", "CFO Özeti", {
        token: "999888777:AAH_SimulatedSecretBotToken_X1",
        allowedChatIds: ["-100111222333", "-100444555666"],
        fetchImpl: mockFetch,
      });
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("izin listesinde değil");
      expect(networkCalls).toBe(0);

      // Positive: allow-listed chatId succeeds AND raw Turkish IBAN + Bearer/bot tokens are scrubbed before egress
      const rawIban = makeValidTrIban("00064", "0009876543210142");
      const lastTwo = rawIban.slice(-2);
      const allowed = await sendTelegramChatMessage(
        "-100111222333",
        `Ödeme alıcı hesabı ${rawIban} ve Bearer SecretJwtValue12345`,
        {
          token: "999888777:AAH_SimulatedSecretBotToken_X1",
          allowedChatIds: ["-100111222333"],
          fetchImpl: mockFetch,
        },
      );
      expect(allowed.ok).toBe(true);
      expect(networkCalls).toBe(1);
      expect(recordedBodies[0]?.text).not.toContain(rawIban);
      expect(recordedBodies[0]?.text).toContain(`TR** **** **** **** **** **${lastTwo}`);
      expect(recordedBodies[0]?.text).not.toContain("SecretJwtValue12345");
      expect(recordedBodies[0]?.text).toContain("Bearer [REDACTED]");

      // Transport exception redaction: thrown fetch error carrying bot URL never leaks token
      const throwingFetch: typeof fetch = (async (url) => {
        throw new Error(`connect ETIMEDOUT ${String(url)} Authorization: Bearer SuperSecretApiTok99`);
      }) as typeof fetch;

      const failed = await sendTelegramChatMessage("-100111222333", "Test", {
        token: "999888777:AAH_SimulatedSecretBotToken_X1",
        allowedChatIds: ["-100111222333"],
        fetchImpl: throwingFetch,
      });
      expect(failed.ok).toBe(false);
      expect(failed.error).not.toContain("AAH_SimulatedSecretBotToken_X1");
      expect(failed.error).not.toContain("SuperSecretApiTok99");
      expect(failed.error).toContain("bot[REDACTED]");

      // Direct redactSecrets + redactBotToken + scrubSensitiveTelegramText verification
      const rawDiagnostic =
        "Hata postgres://mas_radar_app:DbPass_TopSecret42!@127.0.0.1:5432/mas_radar_dev " +
        "url=https://api.telegram.org/bot1234567:AAH_RealLookingBotSecret_99/sendMessage " +
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig api_key=sk_live_987654321 chat=-100777666555";
      const sanitized = redactSecrets(rawDiagnostic, ["-100777666555"]);
      expect(sanitized).not.toContain("DbPass_TopSecret42!");
      expect(sanitized).not.toContain("AAH_RealLookingBotSecret_99");
      expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(sanitized).not.toContain("sk_live_987654321");
      expect(sanitized).not.toContain("-100777666555");
      expect(looksLikeSecret(sanitized, ["-100777666555"])).toEqual([]);
      expect(redactBotToken("bot12345:ABC_def-99")).toBe("bot[REDACTED]");
      expect(scrubSensitiveTelegramText(`Hesap: ${rawIban}`)).toBe(
        `Hesap: TR** **** **** **** **** **${lastTwo}`,
      );
    });

    it("ensures control labels and live control_registry descriptions stay strictly internal workflow classifications without statutory legal claims", async () => {
      expect(INTERNAL_WORKFLOW_CLASSIFICATION_ONLY).toBe(true);

      const allRuleLabels = [
        ...Object.values(ALERT_STATUS_LABEL),
        ...Object.values(SEVERITY_LABEL),
        ...Object.values(ANOMALY_LABEL),
        ...Object.values(CONTROL_EVIDENCE_LABEL),
        ...Object.values(IBAN_CHANGE_TYPE_LABEL),
      ];
      for (const label of allRuleLabels) {
        expect(hasStatutoryLegalProceedingClaim(label), label).toBe(false);
      }

      // Negative control proving detector catches statutory legal proceeding claims
      expect(hasStatutoryLegalProceedingClaim("31. günde otomatik icra takibi başlatıldı")).toBe(true);
      expect(hasStatutoryLegalProceedingClaim("Borçlu için yasal takip başlatıldı")).toBe(true);
      expect(hasStatutoryLegalProceedingClaim("Noterden ihtarname çekildi")).toBe(true);
      expect(hasStatutoryLegalProceedingClaim("31+ Gün Üst Eskalasyon (İç İnceleme)")).toBe(false);

      // Verify live public.control_registry titles and rationales in mas_radar_dev
      const client = await livePool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL ROLE mas_radar_viewer");
        const reg = await client.query<{ check_code: string; title: string; rationale: string }>(
          `select check_code, title, rationale from public.control_registry order by check_code`,
        );
        expect(reg.rows.length).toBeGreaterThanOrEqual(13);
        for (const row of reg.rows) {
          expect(hasStatutoryLegalProceedingClaim(row.title), `${row.check_code}.title`).toBe(false);
          expect(hasStatutoryLegalProceedingClaim(row.rationale), `${row.check_code}.rationale`).toBe(false);
        }
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });
});
