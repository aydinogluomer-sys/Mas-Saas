import { Pool } from "pg";
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
  loadApprovalGovernanceSettings,
  updateApprovalGovernanceSettings,
} from "@/lib/approvals/engine";
import { clearRequestSessionCache, getCurrentUser } from "@/lib/auth";
import { resolveAllowedLegalEntityId } from "@/lib/authz/context";
import { APP_ROLES, DB_ROLE, can } from "@/lib/authz/matrix";
import {
  ALERT_STATUS_LABEL,
  ANOMALY_LABEL,
  CONTROL_EVIDENCE_LABEL,
  IBAN_CHANGE_TYPE_LABEL,
  INTERNAL_WORKFLOW_CLASSIFICATION_ONLY,
  SEVERITY_LABEL,
  evaluateIbanControlStatus,
  hasStatutoryLegalProceedingClaim,
} from "@/lib/controls/rules";
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
import { databaseNameFromUrl } from "../../scripts/db/owner-url";

/** Deterministic ISO 13616 MOD-97-10 Turkish IBAN generator for synthetic unit/mock tests. */
function makeValidTrIban(bankCode5: string, account16: string): string {
  const bban = `${bankCode5.padStart(5, "0").slice(0, 5)}0${account16.padStart(16, "0").slice(0, 16)}`;
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
  tupleWriteSignature: string;
}

async function connectWithRetry(pool: Pool) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await pool.connect();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        attempt < 4 &&
        /timeout|terminated unexpectedly|ECONNRESET|57P03|53300/i.test(msg)
      ) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function captureReadOnlyDbFingerprint(pool: Pool): Promise<DbImmutableFingerprint> {
  const client = await connectWithRetry(pool);
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
      tup_sig: string;
    }>(`
      select
        (select count(*)::int from public.payment_instances) as pi_cnt,
        (select count(*)::int from public.control_alerts) as ca_cnt,
        (select count(*)::int from public.approvals) as ap_cnt,
        (select count(*)::int from public.ibans) as ib_cnt,
        (select count(*)::int from public.legal_entities) as le_cnt,
        (select count(*)::int from public.audit_logs) as al_cnt,
        coalesce((
          select tup_inserted::text || ':' || tup_updated::text || ':' || tup_deleted::text
            from pg_stat_database
           where datname = current_database()
        ), '0:0:0') as tup_sig
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
      tupleWriteSignature: c.tup_sig,
    };
  } finally {
    client.release();
  }
}

function resolveLiveProdDevUrlIfPresent(): string {
  const candidates = [process.env.DATABASE_URL?.trim() ?? ""];
  try {
    candidates.push(readEnvLocal().DATABASE_URL?.trim() ?? "");
  } catch {
    // .env.local absent in CI
  }
  for (const url of candidates) {
    if (url && databaseNameFromUrl(url) === "mas_radar_dev") {
      return url;
    }
  }
  return "";
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
   SUITE 1 — Deterministic Unit & Mock Security Invariants (Zero DB Side Effects)
   ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("AGENT 09 — Application Security, Maker-Checker, IBAN Hard-Gates, Loopback & Redaction", () => {
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

  it("1. blocks unapproved >= 100,000 TRY outflow settlement at markInstancePaid (FORBIDDEN) while allowing < 100k and approved >= 100k", async () => {
    const actorId = "40672c5c-25f0-4623-ae62-55a34e8df5b1";
    const instanceId = "33ad79cf-1111-4000-8000-000000000901";

    function buildSettlementPool(opts: {
      amount: string;
      approvalStatus: "not_required" | "pending_approval" | "approved";
    }) {
      let paidUpdateExecuted = false;
      const pool = {
        connect: async () => ({
          async query(sql: string) {
            const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
            if (norm === "begin" || norm === "commit" || norm === "rollback") {
              return { rows: [], rowCount: 0 };
            }
            if (norm.includes("from public.accounting_periods") || norm.includes("from public.cashflow_months")) {
              return { rows: [{ locked: false }], rowCount: 1 };
            }
            if (norm.includes("from public.payment_instances where id=$1 for update")) {
              return {
                rows: [
                  {
                    id: instanceId,
                    status: "unpaid",
                    amount: opts.amount,
                    paid_amount: null,
                    paid_at: null,
                    direction: "outflow",
                    currency: "TRY",
                    approval_status: opts.approvalStatus,
                    due_date: "2089-11-25",
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
              return opts.approvalStatus === "approved"
                ? { rows: [{ id: "aaaa1111-0000-4000-8000-000000000001", status: "approved" }], rowCount: 1 }
                : { rows: [], rowCount: 0 };
            }
            if (norm.startsWith("insert into public.approvals")) {
              return { rows: [{ id: "aaaa1111-0000-4000-8000-000000000001" }], rowCount: 1 };
            }
            if (norm.includes("set status='paid'")) {
              paidUpdateExecuted = true;
              return { rows: [{ id: instanceId }], rowCount: 1 };
            }
            return { rows: [{ id: "ok" }], rowCount: 1 };
          },
          release() {},
        }),
      } as unknown as Pool;
      return { pool, didUpdatePaid: () => paidUpdateExecuted };
    }

    // (a) Unapproved 120,000 TRY (>= 100k) -> FORBIDDEN, 0 paid updates
    const unapprovedHigh = buildSettlementPool({ amount: "120000.00", approvalStatus: "not_required" });
    await expect(markInstancePaid(unapprovedHigh.pool, instanceId, 120_000, actorId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(unapprovedHigh.didUpdatePaid()).toBe(false);

    // (b) 99,999.99 TRY (< 100k) -> permitted
    const belowThreshold = buildSettlementPool({ amount: "99999.99", approvalStatus: "not_required" });
    await expect(markInstancePaid(belowThreshold.pool, instanceId, 99_999.99, actorId)).resolves.toBeUndefined();
    expect(belowThreshold.didUpdatePaid()).toBe(true);

    // (c) Approved 120,000 TRY -> permitted
    const approvedHigh = buildSettlementPool({ amount: "120000.00", approvalStatus: "approved" });
    await expect(markInstancePaid(approvedHigh.pool, instanceId, 120_000, actorId)).resolves.toBeUndefined();
    expect(approvedHigh.didUpdatePaid()).toBe(true);
  });

  it("2. pins non-manager roles to assigned user_legal_entities and enforces viewer read-only RBAC matrix", () => {
    const entityA = "11111111-1111-4111-8111-111111111111";
    const entityB = "22222222-2222-4222-8222-222222222222";

    for (const role of ["viewer", "finance_operator", "finance_approver"] as const) {
      expect(resolveAllowedLegalEntityId(role, entityA, [entityB])).toBe(entityB);
      expect(resolveAllowedLegalEntityId(role, null, [entityB])).toBe(entityB);
      expect(resolveAllowedLegalEntityId(role, entityB, [entityA, entityB])).toBe(entityB);
    }

    expect(resolveAllowedLegalEntityId("admin", entityA, [entityB])).toBe(entityA);
    expect(resolveAllowedLegalEntityId("finance_manager", null, [entityB])).toBeNull();
    expect(resolveAllowedLegalEntityId("admin", "'; DROP TABLE payments; --", [])).toBeNull();

    for (const tbl of ["payments", "payment_instances", "checks", "invoices", "cash_accounts", "approvals", "ibans", "control_alerts"]) {
      expect(can("viewer", tbl, "select"), `viewer select ${tbl}`).toBe(true);
      expect(can("viewer", tbl, "insert"), `viewer insert ${tbl}`).toBe(false);
      expect(can("viewer", tbl, "update"), `viewer update ${tbl}`).toBe(false);
      expect(can("viewer", tbl, "delete"), `viewer delete ${tbl}`).toBe(false);
    }
  });

  it("3. rejects self-approval when >= 2 active approvers exist, fails closed on missing governance config, and blocks re-enabling self-approval", async () => {
    const makerAdminId = "eb9c61e7-ef57-4dae-b180-0e9d5b7fe8ae";

    const twoApproverClient = {
      async query(sql: string) {
        if (/count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 2 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return {
          rows: [{ allow_single_operator_self_approval: false, min_justification_length: 10 }],
          rowCount: 1,
        };
      },
    };

    await expect(
      evaluateSelfApprovalEligibility(
        twoApproverClient as unknown as Parameters<typeof evaluateSelfApprovalEligibility>[0],
        makerAdminId,
        "İki aktif yönetici varken kendi kaydımı onaylama girişimi.",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const twoApproverPool = {
      connect: async () => ({
        query: twoApproverClient.query,
        release() {},
      }),
    } as unknown as Pool;

    await expect(
      updateApprovalGovernanceSettings(
        twoApproverPool,
        { allowSingleOperatorSelfApproval: true, minJustificationLength: 15 },
        makerAdminId,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Missing governance row fails closed (`allowSingleOperatorSelfApproval === false`)
    const emptyGovPool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const gov = await loadApprovalGovernanceSettings(emptyGovPool);
    expect(gov.allowSingleOperatorSelfApproval).toBe(false);
  });

  it("4. rejects invalid MOD-97 IBANs on templates & approvals and blocks unverified IBAN verified-writebacks", async () => {
    const validIban = makeValidTrIban("00062", "0000123456789012");
    const invalidChecksumIban = `TR00${validIban.slice(4)}`;
    expect(isTurkishIban(validIban)).toBe(true);
    expect(isValidIbanChecksum(validIban)).toBe(true);
    expect(isValidIbanChecksum(invalidChecksumIban)).toBe(false);

    expect(
      evaluateIbanControlStatus({
        approvalStatus: "pending_approval",
        isActive: true,
        verifiedAt: null,
        checksumValid: true,
        trLengthValid: true,
      }),
    ).toEqual({
      canWritebackVerified: false,
      requiresControlAlert: true,
      blockReason: "unverified_iban",
    });

    const makerId = "11111111-1111-4111-8111-111111111101";
    const checkerId = "22222222-2222-4222-8222-222222222202";
    const partyId = "33333333-3333-4333-8333-333333333303";
    const badIbanId = "44444444-4444-4444-8444-444444444404";
    const badApprovalId = "55555555-5555-4555-8555-555555555505";

    const mockPool = {
      connect: async () => ({
        async query(sql: string) {
          const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (norm === "begin" || norm === "commit" || norm === "rollback") {
            return { rows: [], rowCount: 0 };
          }
          if (norm.includes("from public.approvals where id=$1 for update")) {
            return {
              rows: [
                {
                  id: badApprovalId,
                  subject_table: "ibans",
                  subject_id: badIbanId,
                  status: "pending",
                  requested_by: makerId,
                  round_no: 1,
                },
              ],
              rowCount: 1,
            };
          }
          if (norm.includes("select iban_normalized, is_active from public.ibans")) {
            return {
              rows: [{ iban_normalized: invalidChecksumIban, is_active: true }],
              rowCount: 1,
            };
          }
          return { rows: [{ n: 2, locked: false }], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;

    await expect(
      createPayment(
        mockPool,
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

    await expect(
      decideApproval(
        mockPool,
        {
          approvalId: badApprovalId,
          decision: "approved",
          note: "Kontrol basamağı bozuk IBAN onayı denemesi",
        },
        checkerId,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("5. unconditionally disables MAS_LOCAL_PASSWORDLESS in NODE_ENV=production and rejects external Host / X-Forwarded-Host headers", async () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("192.168.1.50")).toBe(false);
    expect(isLoopbackHostname("10.0.0.12")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("127.0.0.2")).toBe(false);
    expect(extractHostHeaderHostname("mas.example.com:443")).toBe("mas.example.com");
    expect(isLoopbackHostname(extractHostHeaderHostname("mas.example.com:443") ?? "")).toBe(false);

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

    headerMockState.headers = {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "erp.masmakina.com.tr",
    };
    expect(await getCurrentUser()).toBeNull();

    headerMockState.headers = { host: "127.0.0.1:3000" };
    const localDevUser = await getCurrentUser();
    expect(localDevUser).not.toBeNull();
    expect(localDevUser?.role).toBe("admin");
  });

  it("6. blocks unauthorized Telegram chatId destinations before network egress, scrubs tokens & IBANs, and enforces internal-only control wording", async () => {
    let networkCalls = 0;
    const recordedBodies: Array<{ chat_id: string; text: string }> = [];
    const mockFetch: typeof fetch = (async (_url, init) => {
      networkCalls += 1;
      recordedBodies.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const denied = await sendTelegramChatMessage("-100999888777", "CFO Özeti", {
      token: "999888777:AAH_SimulatedSecretBotToken_X1",
      allowedChatIds: ["-100111222333", "-100444555666"],
      fetchImpl: mockFetch,
    });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("izin listesinde değil");
    expect(networkCalls).toBe(0);

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
    expect(hasStatutoryLegalProceedingClaim("31. günde otomatik icra takibi başlatıldı")).toBe(true);
    expect(hasStatutoryLegalProceedingClaim("Borçlu için yasal takip başlatıldı")).toBe(true);
    expect(hasStatutoryLegalProceedingClaim("Noterden ihtarname çekildi")).toBe(true);
    expect(hasStatutoryLegalProceedingClaim("31+ Gün Üst Eskalasyon (İç İnceleme)")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
   SUITE 2 — Strictly Read-Only (`BEGIN READ ONLY`) Live `mas_radar_dev` Evidence & Role Hygiene
   (Zero writes, zero rolled-back DML; all write/trigger/RLS proofs run on disposable DB in
    `tests/security/v2-rls-maker-checker.test.ts`!)
   ═══════════════════════════════════════════════════════════════════════════════════════════ */

const liveProdDevUrl = resolveLiveProdDevUrlIfPresent();

describe.skipIf(!liveProdDevUrl)(
  "AGENT 09 — Read-Only Live Historical Evidence & Role Hygiene Verification (prod_db_writes = 0)",
  () => {
    let livePool: Pool;
    let baselineFingerprint: DbImmutableFingerprint;

    beforeAll(async () => {
      livePool = new Pool({
        connectionString: liveProdDevUrl,
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 20_000,
      });
      baselineFingerprint = await captureReadOnlyDbFingerprint(livePool);
    }, 90_000);

    afterAll(async () => {
      if (livePool) {
        try {
          if (baselineFingerprint !== undefined) {
            const afterFingerprint = await captureReadOnlyDbFingerprint(livePool);
            expect(afterFingerprint).toEqual(baselineFingerprint);
          }
        } finally {
          await livePool.end();
        }
      }
    }, 90_000);

    it("1. preserves historical pre-gate 33ad79cf (120,000 TRY) finding openly in control_approval_bypass & control_alerts (BEGIN READ ONLY)", async () => {
      const client = await connectWithRetry(livePool);
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
          amount: string;
          threshold_amount: string;
        }>(`
          select payment_instance_id::text, amount::text, threshold_amount::text
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

    it("2. verifies mas_radar_app + 5 tier roles have rolsuper=false & rolbypassrls=false and control_registry has zero statutory claims (BEGIN READ ONLY)", async () => {
      const client = await connectWithRetry(livePool);
      try {
        await client.query("BEGIN READ ONLY");

        const expectedRoles = ["mas_radar_app", ...APP_ROLES.map((r) => DB_ROLE[r])].sort();
        const roleAttrs = await client.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
        }>(
          `select rolname, rolsuper, rolbypassrls
             from pg_roles
            where rolname = any($1::text[])
            order by rolname`,
          [expectedRoles],
        );
        expect(roleAttrs.rows.map((r) => r.rolname)).toEqual(expectedRoles);
        for (const r of roleAttrs.rows) {
          expect(r.rolsuper, `${r.rolname}.rolsuper`).toBe(false);
          expect(r.rolbypassrls, `${r.rolname}.rolbypassrls`).toBe(false);
        }

        // Unswitched mas_radar_app reads 0 business rows
        const rawRead = await client.query<{ cnt: number }>(
          "select count(*)::int as cnt from public.payments",
        );
        expect(rawRead.rows[0]?.cnt).toBe(0);

        // Viewer reads control_registry cleanly with 0 statutory legal claims
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
  },
);
