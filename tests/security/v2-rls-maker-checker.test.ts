import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideApproval,
  evaluateSelfApprovalEligibility,
  loadActiveApproverCount,
  loadApprovalGovernanceSettings,
  updateApprovalGovernanceSettings,
} from "@/lib/approvals/engine";
import { APP_ROLES, DB_ROLE, can } from "@/lib/authz/matrix";
import { resolveAllowedLegalEntityId } from "@/lib/authz/context";
import * as controlRules from "@/lib/controls/rules";
import { addIban } from "@/lib/counterparties/engine";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { createPayment } from "@/lib/radar/engine";
import { readEnvLocal, swapDatabase } from "../../scripts/db/app-url";
import { isDisposableDatabaseName } from "../../scripts/db/owner-url";
import {
  createDisposableLocalDb,
  dropDisposableLocalDb,
  psqlLocalFile,
  psqlLocalSql,
  resolveLocalOwnerUrl,
} from "../../scripts/db/pg-local-admin";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const ROOT = process.cwd();
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");
const BOOTSTRAP_SQL = path.join(ROOT, "scripts", "db", "local-bootstrap.sql");

const DISPOSABLE_DB = "mas_radar_v2_agent09_sec_verify";
const FORBIDDEN_PROD_DB = "mas_radar_dev";

/** Deterministic ISO 13616 MOD-97-10 Turkish IBAN generator for synthetic test fixtures. */
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

/** Wraps a pinned `PoolClient` as a `Pool`-compatible adapter mapping inner BEGIN/COMMIT/ROLLBACK to SAVEPOINTs. */
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
              await rawQuery(`SAVEPOINT sp_v2_nested_${depth}`);
              return { rows: [], rowCount: 0, command: "BEGIN", oid: 0, fields: [] };
            }
            if (norm === "commit") {
              if (depth > 0) {
                const sp = `sp_v2_nested_${depth}`;
                depth -= 1;
                await rawQuery(`RELEASE SAVEPOINT ${sp}`);
              }
              return { rows: [], rowCount: 0, command: "COMMIT", oid: 0, fields: [] };
            }
            if (norm === "rollback") {
              if (depth > 0) {
                const sp = `sp_v2_nested_${depth}`;
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

const TRANSIENT_PG_RE =
  /timeout expired|connection timeout|terminated unexpectedly|ECONNRESET|EPIPE|57P03|53300/i;

function isLocalPostgresReachable(): boolean {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const out = psqlLocalSql("postgres", "select 1", {
        allowMaintenancePostgres: true,
        readOnly: true,
      }).trim();
      if (out === "1") return true;
    } catch {
      if (attempt < 4) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * attempt);
      }
    }
  }
  return false;
}

async function dropDisposableWithRetry(dbName: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      dropDisposableLocalDb(dbName);
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < 4 && TRANSIENT_PG_RE.test(msg)) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
}

function readProdTupleStatsIfPresent(): string | null {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const out = psqlLocalSql(
        "postgres",
        `select coalesce(tup_inserted::text || ':' || tup_updated::text || ':' || tup_deleted::text, '')
           from pg_stat_database
          where datname = '${FORBIDDEN_PROD_DB}'`,
        { allowMaintenancePostgres: true, readOnly: true },
      ).trim();
      return out || null;
    } catch {
      if (attempt < 3) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800 * attempt);
      }
    }
  }
  return null;
}

/**
 * Resolves a genuine `mas_radar_app` runtime Pool targeting ONLY `DISPOSABLE_DB`.
 * Uses TCP login when `mas_radar_app` credentials exist in `MAS_APP_DATABASE_URL` or `.env.local`;
 * falls back to `SET SESSION AUTHORIZATION mas_radar_app` on fresh passwordless CI containers so
 * `session_user = 'mas_radar_app'`, `current_user = 'mas_radar_app'`, `rolsuper = false`, and
 * `rolbypassrls = false` hold identically in both local and CI environments.
 */
async function createDisposableAppPool(ownerPool: Pool): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const candidates: string[] = [];
  if (process.env.MAS_APP_DATABASE_URL?.trim()) {
    candidates.push(process.env.MAS_APP_DATABASE_URL.trim());
  }
  if (process.env.DATABASE_URL?.trim() && process.env.DATABASE_URL.includes("mas_radar_app")) {
    candidates.push(process.env.DATABASE_URL.trim());
  }
  try {
    const envLocal = readEnvLocal();
    if (envLocal.DATABASE_URL?.includes("mas_radar_app")) {
      candidates.push(envLocal.DATABASE_URL.trim());
    }
  } catch {
    // .env.local absent in CI — handled by session authorization fallback below.
  }

  for (const baseUrl of candidates) {
    try {
      const targetUrl = swapDatabase(baseUrl, DISPOSABLE_DB);
      const tcpPool = new Pool({
        connectionString: targetUrl,
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 25_000,
      });
      const probe = await tcpPool.query<{ db: string; usr: string }>(
        "select current_database() as db, current_user::text as usr",
      );
      if (probe.rows[0]?.db === DISPOSABLE_DB && probe.rows[0]?.usr === "mas_radar_app") {
        return { pool: tcpPool, close: () => tcpPool.end() };
      }
      await tcpPool.end();
    } catch {
      // Try next candidate or session authorization fallback.
    }
  }

  // Fallback for fresh CI containers where mas_radar_app is NOLOGIN: drop session auth to mas_radar_app on checkout.
  const connectAsApp = async (): Promise<PoolClient> => {
    const c = await ownerPool.connect();
    try {
      await c.query("SET SESSION AUTHORIZATION mas_radar_app");
    } catch (err) {
      c.release(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    const origRelease = c.release.bind(c);
    return new Proxy(c, {
      get(target, prop, receiver) {
        if (prop === "release") {
          return (err?: boolean | Error) => {
            target
              .query("RESET ROLE; RESET SESSION AUTHORIZATION;")
              .catch(() => {})
              .finally(() => origRelease(err || true));
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };

  const wrapped = {
    connect: connectAsApp,
    async query(sql: string, params?: unknown[]) {
      const c = await connectAsApp();
      try {
        return await c.query(sql, params);
      } finally {
        c.release();
      }
    },
    async end() {},
  } as unknown as Pool;

  return { pool: wrapped, close: async () => {} };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════
   PART A — Pure Unit & Mock Security Invariants (Always Runs in Static & DB Environments)
   ═══════════════════════════════════════════════════════════════════════════════════════════ */

describe("AGENT 09 V2 (Part A) — Pure Unit & Mock Security Gates (Maker-Checker, IBAN Shield, Pool Safety)", () => {
  it("1. preserves POOL_CONFIG_VERSION = 3 and pre-checkout contextFor() pool-deadlock fix in src/lib/db.ts", () => {
    const dbSource = readFileSync(path.join(ROOT, "src", "lib", "db.ts"), "utf8");
    expect(dbSource).toContain("const POOL_CONFIG_VERSION = 3;");
    // Both scopedQuery and scopedConnect MUST resolve contextFor() BEFORE connectWithRetry(base)
    const scopedQueryMatch = dbSource.match(
      /const scopedQuery[\s\S]*?const resolvedCtx = await contextFor\(\);\s*const client = await connectWithRetry\(base\);/,
    );
    const scopedConnectMatch = dbSource.match(
      /const scopedConnect[\s\S]*?const resolvedCtx = await contextFor\(\);\s*const client = await connectWithRetry\(base\);/,
    );
    expect(scopedQueryMatch).not.toBeNull();
    expect(scopedConnectMatch).not.toBeNull();
  });

  it("2. fails CLOSED on missing/empty approval_governance_settings or 0 approver count, and rejects self-approval when >= 2 approvers exist", async () => {
    const makerAdminId = "11111111-1111-4111-8111-111111111101";

    // (a) >= 2 active approvers -> unconditionally FORBIDDEN even if governance row says true
    const twoApproverClient = {
      async query(sql: string) {
        if (/count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 2 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return {
          rows: [{ allow_single_operator_self_approval: true, min_justification_length: 10 }],
          rowCount: 1,
        };
      },
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(
        twoApproverClient,
        makerAdminId,
        "İki aktif onaycı varken öz-onay denemesi reddedilmelidir.",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // (b) 42P01 missing relation on approval_governance_settings -> MUST fail CLOSED (FORBIDDEN), never default to true
    const missingSchemaClient = {
      async query(sql: string) {
        if (/count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 1 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        if (/from public\.approval_governance_settings/i.test(sql)) {
          throw Object.assign(new Error("relation approval_governance_settings does not exist"), {
            code: "42P01",
          });
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(
        missingSchemaClient,
        makerAdminId,
        "Tablo eksikse fail-closed davranmalı ve öz-onayı reddetmeli.",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const fallbackGov = await loadApprovalGovernanceSettings(missingSchemaClient as unknown as Pool);
    expect(fallbackGov.allowSingleOperatorSelfApproval).toBe(false);

    // (c) Empty approval_governance_settings (0 rows) -> MUST fail CLOSED (FORBIDDEN)
    const emptyGovClient = {
      async query(sql: string) {
        if (/count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 1 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(
        emptyGovClient,
        makerAdminId,
        "Boş yönetişim tablosunda fail-closed öz-onay reddi.",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // (d) Broken/zero approver count (cnt = 0) -> MUST fail CLOSED (FORBIDDEN)
    const zeroCountClient = {
      async query(sql: string) {
        if (/count\(\*\)::int as cnt/i.test(sql)) return { rows: [{ cnt: 0 }], rowCount: 1 };
        if (/select role from public\.users/i.test(sql)) return { rows: [{ role: "admin" }], rowCount: 1 };
        return {
          rows: [{ allow_single_operator_self_approval: true, min_justification_length: 10 }],
          rowCount: 1,
        };
      },
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(
        zeroCountClient,
        makerAdminId,
        "Sıfır onaycı sayımında fail-closed öz-onay reddi.",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("3. blocks split maker-vs-requester self-approval on payment_runs when payment_runs.created_by === actorId and >= 2 approvers exist", async () => {
    const makerId = "11111111-1111-4111-8111-111111111101";
    const submitterId = "22222222-2222-4222-8222-222222222202";
    const approvalId = "33333333-3333-4333-8333-333333333303";
    const runId = "44444444-4444-4444-8444-444444444404";

    let paymentRunApprovedWriteExecuted = false;
    const mockPool = {
      connect: async () => ({
        async query(sql: string) {
          const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (norm === "begin" || norm === "commit" || norm === "rollback") {
            return { rows: [], rowCount: 0 };
          }
          if (norm.includes("from public.approvals where id=$1 for update")) {
            // Note: requested_by is submitterId (Operator B), NOT makerId (Creator A)!
            return {
              rows: [
                {
                  id: approvalId,
                  subject_table: "payment_runs",
                  subject_id: runId,
                  status: "pending",
                  requested_by: submitterId,
                  round_no: 1,
                },
              ],
              rowCount: 1,
            };
          }
          if (norm.includes("from public.payment_runs") && norm.includes("created_by")) {
            return { rows: [{ created_by: makerId }], rowCount: 1 };
          }
          if (norm.includes("count(*)::int as cnt") && norm.includes("from public.users")) {
            return { rows: [{ cnt: 2 }], rowCount: 1 };
          }
          if (norm.startsWith("update public.payment_runs") && norm.includes("status='approved'")) {
            paymentRunApprovedWriteExecuted = true;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [{ n: 2 }], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;

    await expect(
      decideApproval(
        mockPool,
        {
          approvalId,
          decision: "approved",
          note: "Taslağı oluşturan kişi başka birinin onaya sunduğu paketi onaylamaya çalışıyor",
        },
        makerId,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(paymentRunApprovedWriteExecuted).toBe(false);
  });

  it("4. blocks silent iban_verified=true writeback on payment_run_items when beneficiary_iban mismatches approved vault IBAN or verified_at is NULL", async () => {
    const makerId = "11111111-1111-4111-8111-111111111101";
    const checkerId = "22222222-2222-4222-8222-222222222202";
    const approvalId = "55555555-5555-4555-8555-555555555505";
    const runId = "66666666-6666-4666-8666-666666666606";

    const approvedVaultIban = makeValidTrIban("00062", "0000111122223333");
    const spoofedOtherValidIban = makeValidTrIban("00064", "0000999988887777");
    const itemMatchingApproved = "77777777-7777-4777-8777-777777777701";
    const itemMismatchedSpoofed = "77777777-7777-4777-8777-777777777702";
    const itemNullVerifiedAt = "77777777-7777-4777-8777-777777777703";

    let verifiedIdsWritten: string[] = [];

    const mockPool = {
      connect: async () => ({
        async query(sql: string, params?: unknown[]) {
          const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (norm === "begin" || norm === "commit" || norm === "rollback") {
            return { rows: [], rowCount: 0 };
          }
          if (norm.includes("from public.approvals where id=$1 for update")) {
            return {
              rows: [
                {
                  id: approvalId,
                  subject_table: "payment_runs",
                  subject_id: runId,
                  status: "pending",
                  requested_by: makerId,
                  round_no: 1,
                },
              ],
              rowCount: 1,
            };
          }
          if (norm.includes("from public.payment_runs") && norm.includes("created_by")) {
            return { rows: [{ created_by: makerId }], rowCount: 1 };
          }
          if (norm.includes("from public.payment_run_items pri") && norm.includes("join public.ibans ib")) {
            // Simulate DB rows: only rows with ib.verified_at IS NOT NULL should even qualify,
            // and mismatched beneficiary_iban must NEVER be promoted to iban_verified = true!
            const rows = [
              {
                id: itemMatchingApproved,
                beneficiary_iban: approvedVaultIban,
                iban_normalized: approvedVaultIban,
                verified_at: "2026-11-20T08:00:00Z",
              },
              {
                id: itemMismatchedSpoofed,
                beneficiary_iban: spoofedOtherValidIban,
                iban_normalized: approvedVaultIban,
                verified_at: "2026-11-20T08:00:00Z",
              },
            ];
            if (!norm.includes("ib.verified_at is not null")) {
              rows.push({
                id: itemNullVerifiedAt,
                beneficiary_iban: approvedVaultIban,
                iban_normalized: approvedVaultIban,
                verified_at: null as unknown as string,
              });
            }
            return { rows, rowCount: rows.length };
          }
          if (norm.startsWith("update public.payment_run_items set iban_verified = true")) {
            verifiedIdsWritten = (params?.[0] as string[]) ?? [];
            return { rows: [], rowCount: verifiedIdsWritten.length };
          }
          return { rows: [{ n: 2, id: "ok" }], rowCount: 1 };
        },
        release() {},
      }),
    } as unknown as Pool;

    await decideApproval(
      mockPool,
      {
        approvalId,
        decision: "approved",
        note: "Ödeme paketi 4-göz kontrolü ile onaylandı",
      },
      checkerId,
    );

    expect(verifiedIdsWritten).toEqual([itemMatchingApproved]);
    expect(verifiedIdsWritten).not.toContain(itemMismatchedSpoofed);
    expect(verifiedIdsWritten).not.toContain(itemNullVerifiedAt);
  });

  it("5. enforces MOD-97 checksum & pure evaluateIbanControlStatus gate in controls/rules.ts", () => {
    const validTr = makeValidTrIban("00015", "0000444455556666");
    const invalidMod97 = `TR00${validTr.slice(4)}`;
    expect(isTurkishIban(validTr)).toBe(true);
    expect(isValidIbanChecksum(validTr)).toBe(true);
    expect(isValidIbanChecksum(invalidMod97)).toBe(false);

    const evaluateFn = (
      controlRules as unknown as {
        evaluateIbanControlStatus?: (input: {
          approvalStatus: string | null;
          isActive: boolean;
          verifiedAt: string | null;
          makerId?: string | null;
          verifierId?: string | null;
          checksumValid: boolean;
          trLengthValid: boolean;
        }) => {
          canWritebackVerified: boolean;
          requiresControlAlert: boolean;
          blockReason: string | null;
        };
      }
    ).evaluateIbanControlStatus;

    expect(typeof evaluateFn).toBe("function");

    // Invalid MOD-97 -> blocked + alert required
    expect(
      evaluateFn!({
        approvalStatus: "approved",
        isActive: true,
        verifiedAt: "2026-11-20T08:00:00Z",
        makerId: "u1",
        verifierId: "u2",
        checksumValid: false,
        trLengthValid: true,
      }),
    ).toEqual({
      canWritebackVerified: false,
      requiresControlAlert: true,
      blockReason: "invalid_iban_checksum_or_format",
    });

    // Unverified IBAN -> blocked + alert required
    expect(
      evaluateFn!({
        approvalStatus: "pending_approval",
        isActive: true,
        verifiedAt: null,
        makerId: "u1",
        verifierId: null,
        checksumValid: true,
        trLengthValid: true,
      }),
    ).toEqual({
      canWritebackVerified: false,
      requiresControlAlert: true,
      blockReason: "unverified_iban",
    });

    // Maker === verifier -> blocked + alert required
    expect(
      evaluateFn!({
        approvalStatus: "approved",
        isActive: true,
        verifiedAt: "2026-11-20T08:00:00Z",
        makerId: "u1",
        verifierId: "u1",
        checksumValid: true,
        trLengthValid: true,
      }),
    ).toEqual({
      canWritebackVerified: false,
      requiresControlAlert: true,
      blockReason: "maker_equals_checker",
    });

    // Positive control: active + MOD-97 valid + independently verified -> allowed, no alert
    expect(
      evaluateFn!({
        approvalStatus: "approved",
        isActive: true,
        verifiedAt: "2026-11-20T08:00:00Z",
        makerId: "u1",
        verifierId: "u2",
        checksumValid: true,
        trLengthValid: true,
      }),
    ).toEqual({
      canWritebackVerified: true,
      requiresControlAlert: false,
      blockReason: null,
    });
  });

  it("6. enforces static 5-role matrix & cookie legal-entity pinning", () => {
    const entityA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const entityB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    for (const role of ["viewer", "finance_operator", "finance_approver"] as const) {
      expect(resolveAllowedLegalEntityId(role, entityA, [entityB])).toBe(entityB);
      expect(resolveAllowedLegalEntityId(role, null, [entityB])).toBe(entityB);
      expect(resolveAllowedLegalEntityId(role, "consolidated", [entityB])).toBe(entityB);
      expect(resolveAllowedLegalEntityId(role, entityB, [entityA, entityB])).toBe(entityB);
    }

    for (const tbl of ["payments", "payment_instances", "checks", "invoices", "cash_accounts", "approvals", "ibans"]) {
      expect(can("viewer", tbl, "select")).toBe(true);
      expect(can("viewer", tbl, "insert")).toBe(false);
      expect(can("viewer", tbl, "update")).toBe(false);
      expect(can("viewer", tbl, "delete")).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════
   PART B — Disposable PostgreSQL Proof (`mas_radar_v2_agent09_sec_verify`)
   ═══════════════════════════════════════════════════════════════════════════════════════════ */

const pgReachable = isLocalPostgresReachable();

describe.skipIf(!pgReachable)(
  "AGENT 09 V2 (Part B) — Disposable PostgreSQL Multi-Entity 5-Role RLS, Maker-Checker Trigger & IBAN Proof",
  () => {
    let lockPool: Pool | undefined;
    let lockClient: PoolClient | undefined;
    let ownerPool: Pool | undefined;
    let appPoolHandle: { pool: Pool; close: () => Promise<void> } | undefined;
    let prodStatsBefore: string | null = null;

    beforeAll(async () => {
      expect(isDisposableDatabaseName(DISPOSABLE_DB)).toBe(true);
      expect(DISPOSABLE_DB).not.toBe(FORBIDDEN_PROD_DB);

      // Serialize concurrent Vitest runs targeting `mas_radar_v2_agent09_sec_verify` via session advisory lock on `postgres`.
      lockPool = new Pool({
        connectionString: resolveLocalOwnerUrl("postgres"),
        max: 1,
        idleTimeoutMillis: 300_000,
        connectionTimeoutMillis: 30_000,
      });
      lockClient = await lockPool.connect();
      await lockClient.query(
        "select pg_advisory_lock(hashtext('mas_radar_v2_agent09_sec_verify')::bigint)",
      );

      prodStatsBefore = readProdTupleStatsIfPresent();

      const ownerUrl = resolveLocalOwnerUrl(DISPOSABLE_DB);
      let lastProvisionErr: unknown;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        try {
          await dropDisposableWithRetry(DISPOSABLE_DB);
          createDisposableLocalDb(DISPOSABLE_DB);
          psqlLocalFile(DISPOSABLE_DB, BOOTSTRAP_SQL);
          execFileSync(process.execPath, [TSX_CLI, MIGRATE_SCRIPT], {
            cwd: ROOT,
            env: {
              ...process.env,
              DATABASE_URL: ownerUrl,
              MIGRATION_DATABASE_URL: ownerUrl,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          lastProvisionErr = undefined;
          break;
        } catch (err) {
          lastProvisionErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 4 && TRANSIENT_PG_RE.test(msg)) {
            await new Promise((r) => setTimeout(r, 2000 * attempt));
            continue;
          }
          await dropDisposableWithRetry(DISPOSABLE_DB).catch(() => {});
          throw err;
        }
      }
      if (lastProvisionErr) {
        await dropDisposableWithRetry(DISPOSABLE_DB).catch(() => {});
        throw lastProvisionErr;
      }

      ownerPool = new Pool({
        connectionString: ownerUrl,
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 30_000,
      });

      const dbCheck = await ownerPool.query<{ db: string }>("select current_database() as db");
      expect(dbCheck.rows[0]?.db).toBe(DISPOSABLE_DB);

      appPoolHandle = await createDisposableAppPool(ownerPool);
    }, 240_000);

    afterAll(async () => {
      try {
        try {
          if (appPoolHandle) await appPoolHandle.close();
          if (ownerPool) await ownerPool.end();
        } finally {
          await dropDisposableWithRetry(DISPOSABLE_DB);
        }

        const remaining = psqlLocalSql(
          "postgres",
          `select count(*)::int from pg_database where datname = '${DISPOSABLE_DB}'`,
          { allowMaintenancePostgres: true, readOnly: true },
        ).trim();
        expect(remaining).toBe("0");

        if (prodStatsBefore !== null) {
          const prodStatsAfter = readProdTupleStatsIfPresent();
          expect(prodStatsAfter).toBe(prodStatsBefore);
        }
      } finally {
        if (lockClient) {
          await lockClient
            .query("select pg_advisory_unlock(hashtext('mas_radar_v2_agent09_sec_verify')::bigint)")
            .catch(() => {});
          lockClient.release();
          lockClient = undefined;
        }
        if (lockPool) {
          await lockPool.end().catch(() => {});
          lockPool = undefined;
        }
      }
    }, 90_000);

    it(
      "1. verifies mas_radar_app and all 5 tier roles have rolsuper=false and rolbypassrls=false (zero privilege escalation)",
      async () => {
        const expectedRoles = ["mas_radar_app", ...APP_ROLES.map((r) => DB_ROLE[r])].sort();
        const res = await ownerPool!.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcanlogin: boolean;
          rolinherit: boolean;
        }>(
          `select rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
             from pg_roles
            where rolname = any($1::text[])
            order by rolname`,
          [expectedRoles],
        );

        expect(res.rows.map((r) => r.rolname)).toEqual(expectedRoles);
        for (const r of res.rows) {
          expect(r.rolsuper, `${r.rolname}.rolsuper`).toBe(false);
          expect(r.rolbypassrls, `${r.rolname}.rolbypassrls`).toBe(false);
          if (r.rolname === "mas_radar_app") {
            expect(r.rolinherit, "mas_radar_app.rolinherit").toBe(false);
          } else {
            expect(r.rolcanlogin, `${r.rolname}.rolcanlogin`).toBe(false);
          }
        }

        const memberships = await ownerPool!.query<{
          tier: string;
          set_option: boolean;
          inherit_option: boolean;
        }>(
          `select m.rolname as tier, am.set_option, am.inherit_option
             from pg_auth_members am
             join pg_roles r on r.oid = am.member
             join pg_roles m on m.oid = am.roleid
            where r.rolname = 'mas_radar_app'
              and m.rolname = any($1::text[])
            order by m.rolname`,
          [APP_ROLES.map((r) => DB_ROLE[r])],
        );
        expect(memberships.rows).toHaveLength(5);
        for (const m of memberships.rows) {
          expect(m.set_option, `${m.tier}.set_option`).toBe(true);
          expect(m.inherit_option, `${m.tier}.inherit_option`).toBe(false);
        }

        // Unswitched mas_radar_app sees 0 business rows and cannot INSERT
        const appClient = await appPoolHandle!.pool.connect();
        try {
          await appClient.query("BEGIN");
          const who = await appClient.query<{ usr: string; db: string }>(
            "select current_user::text as usr, current_database() as db",
          );
          expect(who.rows[0]).toEqual({ usr: "mas_radar_app", db: DISPOSABLE_DB });

          const rawRead = await appClient.query<{ cnt: number }>(
            "select count(*)::int as cnt from public.payments",
          );
          expect(rawRead.rows[0]?.cnt).toBe(0);

          const rawWriteErr = await expectPgError(appClient, "sp_raw_app_write", () =>
            appClient.query(
              `insert into public.payments (name, recurrence_type, due_day, direction, status)
               values ('Unswitched App Write', 'monthly', 5, 'outflow', 'active')`,
            ),
          );
          expect(rawWriteErr.code).toBe("42501");
        } finally {
          await appClient.query("ROLLBACK").catch(() => {});
          appClient.release();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );

    it(
      "2. enforces 0 cross-entity reads and 0 cross-entity writes across ALL 5 roles (viewer..admin) on payments, payment_instances, checks, invoices, and cash_accounts",
      async () => {
        // Seed Entity A & Entity B + scoped rows via owner connection inside disposable DB
        const seedClient = await ownerPool!.connect();
        let entityA = "";
        let entityB = "";
        let partyId = "";
        const idsA: Record<string, string> = {};
        const idsB: Record<string, string> = {};

        try {
          await seedClient.query("BEGIN");

          entityA = (
            await seedClient.query<{ id: string }>(
              `insert into public.legal_entities (code, name, tax_id_vkn, base_currency, is_default, is_active)
               values ('V2-ENT-A', 'V2 Test Tüzel Kişilik A A.Ş.', '8110000011', 'TRY', false, true)
               returning id::text`,
            )
          ).rows[0]!.id;

          entityB = (
            await seedClient.query<{ id: string }>(
              `insert into public.legal_entities (code, name, tax_id_vkn, base_currency, is_default, is_active)
               values ('V2-ENT-B', 'V2 Test Tüzel Kişilik B Ltd.', '8110000022', 'TRY', false, true)
               returning id::text`,
            )
          ).rows[0]!.id;

          partyId = (
            await seedClient.query<{ id: string }>(
              `insert into public.parties (name, normalized_name, party_type)
               values ('V2 Ortak Tedarikçi A.Ş.', 'v2 ortak tedarikçi a.ş.', 'vendor')
               returning id::text`,
            )
          ).rows[0]!.id;

          // Seed Entity A rows
          idsA.payments = (
            await seedClient.query<{ id: string }>(
              `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
               values ('Entity A Payment', 'monthly', 10, 40000.00, 'TRY', 'outflow', 'active', $1::uuid)
               returning id::text`,
              [entityA],
            )
          ).rows[0]!.id;

          idsA.payment_instances = (
            await seedClient.query<{ id: string }>(
              `insert into public.payment_instances
                 (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source, legal_entity_id)
               values ($1::uuid, '2088-05-01', '2088-05-10', 40000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated', $2::uuid)
               returning id::text`,
              [idsA.payments, entityA],
            )
          ).rows[0]!.id;

          idsA.checks = (
            await seedClient.query<{ id: string }>(
              `insert into public.checks (maturity_date, serial_no, payee_party_id, amount, signed_amount, currency, direction, status, legal_entity_id)
               values ('2088-05-20', 'CHK-A-001', $1::uuid, 30000.00, -30000.00, 'TRY', 'outflow', 'planned', $2::uuid)
               returning id::text`,
              [partyId, entityA],
            )
          ).rows[0]!.id;

          idsA.invoices = (
            await seedClient.query<{ id: string }>(
              `insert into public.invoices (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, status, legal_entity_id)
               values ('purchase', 'INV-ENT-A-001', $1::uuid, '2088-05-01', '2088-05-31', 'TRY', 50000.00, 10000.00, 60000.00, 'open', $2::uuid)
               returning id::text`,
              [partyId, entityA],
            )
          ).rows[0]!.id;

          idsA.cash_accounts = (
            await seedClient.query<{ id: string }>(
              `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active, legal_entity_id)
               values ('Entity A Vadesiz TL', 'bank_account', 'TRY', 250000.00, true, $1::uuid)
               returning id::text`,
              [entityA],
            )
          ).rows[0]!.id;

          // Seed Entity B rows
          idsB.payments = (
            await seedClient.query<{ id: string }>(
              `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
               values ('Entity B Payment', 'monthly', 12, 20000.00, 'TRY', 'outflow', 'active', $1::uuid)
               returning id::text`,
              [entityB],
            )
          ).rows[0]!.id;

          idsB.payment_instances = (
            await seedClient.query<{ id: string }>(
              `insert into public.payment_instances
                 (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source, legal_entity_id)
               values ($1::uuid, '2088-05-01', '2088-05-12', 20000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated', $2::uuid)
               returning id::text`,
              [idsB.payments, entityB],
            )
          ).rows[0]!.id;

          idsB.checks = (
            await seedClient.query<{ id: string }>(
              `insert into public.checks (maturity_date, serial_no, payee_party_id, amount, signed_amount, currency, direction, status, legal_entity_id)
               values ('2088-05-22', 'CHK-B-001', $1::uuid, 15000.00, -15000.00, 'TRY', 'outflow', 'planned', $2::uuid)
               returning id::text`,
              [partyId, entityB],
            )
          ).rows[0]!.id;

          idsB.invoices = (
            await seedClient.query<{ id: string }>(
              `insert into public.invoices (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, status, legal_entity_id)
               values ('purchase', 'INV-ENT-B-001', $1::uuid, '2088-05-02', '2088-05-31', 'TRY', 25000.00, 5000.00, 30000.00, 'open', $2::uuid)
               returning id::text`,
              [partyId, entityB],
            )
          ).rows[0]!.id;

          idsB.cash_accounts = (
            await seedClient.query<{ id: string }>(
              `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active, legal_entity_id)
               values ('Entity B Vadesiz TL', 'bank_account', 'TRY', 125000.00, true, $1::uuid)
               returning id::text`,
              [entityB],
            )
          ).rows[0]!.id;

          await seedClient.query("COMMIT");
        } catch (err) {
          await seedClient.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          seedClient.release();
        }

        const scopedTables = [
          "payments",
          "payment_instances",
          "checks",
          "invoices",
          "cash_accounts",
        ] as const;

        const updateSqlByTable: Record<(typeof scopedTables)[number], string> = {
          payments: "update public.payments set name = 'TAMPERED' where id = $1::uuid",
          payment_instances: "update public.payment_instances set amount = 1 where id = $1::uuid",
          checks: "update public.checks set notes = 'TAMPERED' where id = $1::uuid",
          invoices: "update public.invoices set due_date = '2088-06-01' where id = $1::uuid",
          cash_accounts: "update public.cash_accounts set notes = 'TAMPERED' where id = $1::uuid",
        };

        // Probe EVERY ONE of the 5 roles via mas_radar_app -> SET LOCAL ROLE
        for (const role of APP_ROLES) {
          const dbRole = DB_ROLE[role];
          const client = await appPoolHandle!.pool.connect();
          try {
            await client.query("BEGIN");

            // (A) POSITIVE CONTROL: Under Entity A context, role sees 1 row of Entity A in all 5 tables
            await client.query("SELECT set_config('app.current_legal_entity_id', $1, true)", [entityA]);
            await client.query(`SET LOCAL ROLE ${dbRole}`);

            const activeRoleRes = await client.query<{ rol: string; bypass: boolean; sup: boolean }>(
              `select current_user::text as rol, rolbypassrls as bypass, rolsuper as sup
                 from pg_roles where rolname = current_user`,
            );
            expect(activeRoleRes.rows[0]).toEqual({ rol: dbRole, bypass: false, sup: false });

            for (const tbl of scopedTables) {
              const posA = await client.query<{ cnt: number }>(
                `select count(*)::int as cnt from public.${tbl} where id = $1::uuid`,
                [idsA[tbl]],
              );
              expect(posA.rows[0]?.cnt, `positive control ${role} Entity A ${tbl}`).toBe(1);
            }

            // (B) NEGATIVE ISOLATION: Switch active entity to Entity B -> 0 reads, 0 updates, 0 deletes, 0 inserts on Entity A!
            await client.query("SELECT set_config('app.current_legal_entity_id', $1, true)", [entityB]);

            for (const tbl of scopedTables) {
              const leakRead = await client.query<{ cnt: number }>(
                `select count(*)::int as cnt from public.${tbl} where id = $1::uuid`,
                [idsA[tbl]],
              );
              expect(leakRead.rows[0]?.cnt, `cross-entity read ${role} ${tbl}`).toBe(0);

              const ownRead = await client.query<{ cnt: number }>(
                `select count(*)::int as cnt from public.${tbl} where id = $1::uuid`,
                [idsB[tbl]],
              );
              expect(ownRead.rows[0]?.cnt, `same-entity positive read ${role} ${tbl}`).toBe(1);

              // Cross-entity UPDATE attempt on Entity A row
              await client.query(`SAVEPOINT sp_upd_${role}_${tbl}`);
              let updAffected = 0;
              try {
                const upd = await client.query(updateSqlByTable[tbl], [idsA[tbl]]);
                updAffected = upd.rowCount ?? 0;
              } catch (err) {
                expect((err as { code?: string }).code).toBe("42501");
              }
              await client.query(`ROLLBACK TO SAVEPOINT sp_upd_${role}_${tbl}`);
              await client.query(`RELEASE SAVEPOINT sp_upd_${role}_${tbl}`);
              expect(updAffected, `cross-entity update ${role} ${tbl}`).toBe(0);

              // Cross-entity DELETE attempt on Entity A row
              await client.query(`SAVEPOINT sp_del_${role}_${tbl}`);
              let delAffected = 0;
              try {
                const del = await client.query(`delete from public.${tbl} where id = $1::uuid`, [idsA[tbl]]);
                delAffected = del.rowCount ?? 0;
              } catch (err) {
                expect((err as { code?: string }).code).toBe("42501");
              }
              await client.query(`ROLLBACK TO SAVEPOINT sp_del_${role}_${tbl}`);
              await client.query(`RELEASE SAVEPOINT sp_del_${role}_${tbl}`);
              expect(delAffected, `cross-entity delete ${role} ${tbl}`).toBe(0);
            }

            // Cross-entity INSERT attempt into Entity A while pinned to Entity B -> 42501 for ALL roles (including admin)
            const crossInsertErr = await expectPgError(client, `sp_ins_${role}`, () =>
              client.query(
                `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status, legal_entity_id)
                 values ('Cross Entity Forgery', 'monthly', 15, 1000.00, 'TRY', 'outflow', 'active', $1::uuid)`,
                [entityA],
              ),
            );
            expect(crossInsertErr.code, `cross-entity insert ${role}`).toBe("42501");
          } finally {
            await client.query("ROLLBACK").catch(() => {});
            client.release();
          }
        }

        // Verify all 5 Entity A rows remain untouched
        const verifyRes = await ownerPool!.query<{ cnt: number }>(
          `select (
             (select count(*)::int from public.payments where id = $1::uuid and name = 'Entity A Payment') +
             (select count(*)::int from public.payment_instances where id = $2::uuid and amount = 40000.00) +
             (select count(*)::int from public.checks where id = $3::uuid and notes is null) +
             (select count(*)::int from public.invoices where id = $4::uuid and due_date = '2088-05-31') +
             (select count(*)::int from public.cash_accounts where id = $5::uuid and notes is null)
           ) as cnt`,
          [idsA.payments, idsA.payment_instances, idsA.checks, idsA.invoices, idsA.cash_accounts],
        );
        expect(verifyRes.rows[0]?.cnt).toBe(5);
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );

    it(
      "3. blocks mas_radar_viewer from INSERT/UPDATE/DELETE across financial & approval tables",
      async () => {
        const seedRes = await ownerPool!.query<{
          pay_id: string;
          pi_id: string;
          app_id: string;
        }>(`
          with p as (
            insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status)
            values ('Viewer ReadOnly Probe', 'monthly', 14, 9000.00, 'TRY', 'outflow', 'active')
            returning id
          ),
          pi as (
            insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source)
            select id, '2088-06-01', '2088-06-14', 9000.00, 'TRY', 'known', 'outflow', 'unpaid', 'generated' from p
            returning id
          ),
          ap as (
            insert into public.approvals (subject_table, subject_id, request_kind, status)
            select 'payment_instances', id, 'payment', 'pending' from pi
            returning id
          )
          select (select id::text from p) as pay_id,
                 (select id::text from pi) as pi_id,
                 (select id::text from ap) as app_id
        `);
        const { pay_id: payId, pi_id: piId, app_id: appId } = seedRes.rows[0]!;

        const client = await appPoolHandle!.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.current_legal_entity_id', '', true)");
          await client.query("SET LOCAL ROLE mas_radar_viewer");

          // Positive control: viewer CAN read
          expect((await client.query(`select 1 from public.payments where id = $1::uuid`, [payId])).rowCount).toBe(1);
          expect((await client.query(`select 1 from public.payment_instances where id = $1::uuid`, [piId])).rowCount).toBe(1);
          expect((await client.query(`select 1 from public.approvals where id = $1::uuid`, [appId])).rowCount).toBe(1);

          // Viewer INSERTs -> 42501
          for (const [label, sql, params] of [
            [
              "ins_payments",
              `insert into public.payments (name, recurrence_type, due_day, direction, status) values ('X','monthly',1,'outflow','active')`,
              [],
            ],
            [
              "ins_pi",
              `insert into public.payment_instances (instance_month, due_date, currency, amount_status, direction, status, amount_source) values ('2088-06-01','2088-06-20','TRY','known','outflow','unpaid','manual')`,
              [],
            ],
            [
              "ins_approvals",
              `insert into public.approvals (subject_table, subject_id, request_kind, status) values ('payments', $1::uuid, 'payment', 'pending')`,
              [payId],
            ],
            [
              "ins_cash_accounts",
              `insert into public.cash_accounts (name, account_type, currency) values ('Viewer Illegal Cash', 'cash', 'TRY')`,
              [],
            ],
          ] as const) {
            const err = await expectPgError(client, `sp_${label}`, () =>
              client.query(sql, [...params]),
            );
            expect(err.code, label).toBe("42501");
          }

          // Viewer UPDATE / DELETE -> 42501 or 0 rows
          for (const [label, sql, params] of [
            ["upd_pay", `update public.payments set name = 'Hacked' where id = $1::uuid`, [payId]],
            ["del_pay", `delete from public.payments where id = $1::uuid`, [payId]],
            ["upd_pi", `update public.payment_instances set amount = 1 where id = $1::uuid`, [piId]],
            ["del_pi", `delete from public.payment_instances where id = $1::uuid`, [piId]],
            ["upd_app", `update public.approvals set status = 'approved' where id = $1::uuid`, [appId]],
            ["del_app", `delete from public.approvals where id = $1::uuid`, [appId]],
          ] as const) {
            await client.query(`SAVEPOINT sp_${label}`);
            let blocked = false;
            try {
              const r = await client.query(sql, [...params]);
              blocked = (r.rowCount ?? 0) === 0;
            } catch (err) {
              expect((err as { code?: string }).code, label).toBe("42501");
              blocked = true;
            }
            await client.query(`ROLLBACK TO SAVEPOINT sp_${label}`);
            await client.query(`RELEASE SAVEPOINT sp_${label}`);
            expect(blocked, label).toBe(true);
          }
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );

    it(
      "4. enforces >= 100,000 TRY maker-checker self-approval block and DB settlement trigger (42501), while allowing approved maker != checker settlement",
      async () => {
        // Seed 2 active approver users + lock governance setting to false (matching >=2 approvers state)
        const usersSeed = await ownerPool!.query<{ maker_id: string; checker_id: string }>(`
          with u1 as (
            insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
            values ('v2_maker_admin', 'argon2_stub', 'V2 Maker Admin', 'admin', true, false)
            returning id
          ),
          u2 as (
            insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
            values ('v2_checker_admin', 'argon2_stub', 'V2 Checker Admin', 'admin', true, false)
            returning id
          ),
          gov as (
            update public.approval_governance_settings
               set allow_single_operator_self_approval = false,
                   updated_at = now()
             where singleton_id = true
          )
          select (select id::text from u1) as maker_id,
                 (select id::text from u2) as checker_id
        `);
        const makerId = usersSeed.rows[0]!.maker_id;
        const checkerId = usersSeed.rows[0]!.checker_id;

        const client = await appPoolHandle!.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.user_id', $1, true), set_config('app.current_legal_entity_id', '', true)",
            [makerId],
          );
          await client.query("SET LOCAL ROLE mas_radar_admin");

          const txPool = wrapPinnedTransactionPool(client);
          expect(await loadActiveApproverCount(txPool)).toBeGreaterThanOrEqual(2);

          // Re-enabling single-operator self-approval while >= 2 approvers exist is FORBIDDEN
          await expect(
            updateApprovalGovernanceSettings(
              txPool,
              { allowSingleOperatorSelfApproval: true, minJustificationLength: 15 },
              makerId,
            ),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });

          // Insert 125,000 TRY unpaid outflow payment_instance
          const highPiId = (
            await client.query<{ id: string }>(
              `insert into public.payment_instances
                 (instance_month, due_date, amount, currency, amount_status, direction, status, approval_status, amount_source)
               values ('2088-07-01', '2088-07-15', 125000.00, 'TRY', 'known', 'outflow', 'unpaid', 'not_required', 'manual')
               returning id::text`,
            )
          ).rows[0]!.id;

          // Negative 1: Direct SQL UPDATE status='paid' without approval -> SQLSTATE 42501 APPROVAL_REQUIRED
          const errPaid = await expectPgError(client, "sp_v2_unapproved_paid", () =>
            client.query(
              `update public.payment_instances set status = 'paid', paid_amount = 125000.00, paid_at = now() where id = $1::uuid`,
              [highPiId],
            ),
          );
          expect(errPaid.code).toBe("42501");
          expect(errPaid.message).toContain("APPROVAL_REQUIRED");

          // Negative 2: Direct SQL partial settlement -> SQLSTATE 42501
          const errPartial = await expectPgError(client, "sp_v2_unapproved_partial", () =>
            client.query(
              `update public.payment_instances set status = 'partial', paid_amount = 10000.00, paid_at = now() where id = $1::uuid`,
              [highPiId],
            ),
          );
          expect(errPartial.code).toBe("42501");

          // Negative 3: Spoofing approval_status='approved' without real approvals row -> SQLSTATE 42501
          await client.query("SAVEPOINT sp_v2_spoof_flag");
          await client.query(
            `update public.payment_instances set approval_status = 'approved' where id = $1::uuid`,
            [highPiId],
          );
          let spoofCode: string | undefined;
          try {
            await client.query(
              `update public.payment_instances set status = 'paid', paid_amount = 125000.00, paid_at = now() where id = $1::uuid`,
              [highPiId],
            );
          } catch (err) {
            spoofCode = (err as { code?: string }).code;
          }
          await client.query("ROLLBACK TO SAVEPOINT sp_v2_spoof_flag");
          await client.query("RELEASE SAVEPOINT sp_v2_spoof_flag");
          expect(spoofCode).toBe("42501");

          // Open pending approval round as Maker
          const approvalId = (
            await client.query<{ id: string }>(
              `insert into public.approvals
                 (subject_table, subject_id, subject_label, request_kind, rule_code, round_no, amount, currency, status, requested_by)
               values ('payment_instances', $1::uuid, 'V2 125K Outflow', 'amount_threshold', 'amount_over_100k', 1, 125000.00, 'TRY', 'pending', $2::uuid)
               returning id::text`,
              [highPiId, makerId],
            )
          ).rows[0]!.id;

          // Negative 4: Maker attempting self-approval via decideApproval -> DomainError("FORBIDDEN")
          await expect(
            decideApproval(
              txPool,
              {
                approvalId,
                decision: "approved",
                justification: "Maker kendi 125.000 TL ödemesini onaylamaya çalışıyor",
              },
              makerId,
            ),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });

          // Negative 5: Direct SQL self-approval on public.approvals blocked by RLS
          await client.query("SAVEPOINT sp_v2_direct_self_approve");
          let directSelfBlocked = false;
          try {
            const upd = await client.query(
              `update public.approvals
                  set status = 'approved', decided_by = $2::uuid, decided_at = now(),
                      self_approved_override = true, self_approval_justification = 'Direct SQL bypass attempt'
                where id = $1::uuid`,
              [approvalId, makerId],
            );
            directSelfBlocked = (upd.rowCount ?? 0) === 0;
          } catch {
            directSelfBlocked = true;
          }
          await client.query("ROLLBACK TO SAVEPOINT sp_v2_direct_self_approve");
          await client.query("RELEASE SAVEPOINT sp_v2_direct_self_approve");
          expect(directSelfBlocked).toBe(true);

          // Positive Control: Distinct Checker (checkerId !== makerId) approves -> settlement succeeds!
          await client.query("SELECT set_config('app.user_id', $1, true)", [checkerId]);
          await decideApproval(
            txPool,
            {
              approvalId,
              decision: "approved",
              note: "Bağımsız ikinci onaycı (checker) 125.000 TL ödemeyi doğruladı",
            },
            checkerId,
          );

          const settled = await client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 125000.00, paid_at = now() where id = $1::uuid`,
            [highPiId],
          );
          expect(settled.rowCount).toBe(1);
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );

    it(
      "5. rejects invalid MOD-97 IBANs, alerts on unverified IBANs, blocks unverified/mismatched writebacks, and clears alert only after maker != checker approval",
      async () => {
        const usersRes = await ownerPool!.query<{ id: string }>(
          `select id::text from public.users where is_active = true and role = 'admin' order by created_at asc limit 2`,
        );
        const makerId = usersRes.rows[0]!.id;
        const checkerId = usersRes.rows[1]!.id;

        const validIban = makeValidTrIban("00062", "0000555566667777");
        const invalidChecksumIban = `TR00${validIban.slice(4)}`;
        const spoofedSecondValidIban = makeValidTrIban("00064", "0000888877776666");

        expect(isValidIbanChecksum(validIban)).toBe(true);
        expect(isValidIbanChecksum(invalidChecksumIban)).toBe(false);
        expect(normalizeIban(validIban)).not.toBe(normalizeIban(spoofedSecondValidIban));

        const client = await appPoolHandle!.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('app.user_id', $1, true), set_config('app.current_legal_entity_id', '', true)",
            [makerId],
          );
          await client.query("SET LOCAL ROLE mas_radar_admin");
          const txPool = wrapPinnedTransactionPool(client);

          const partyId = (
            await client.query<{ id: string }>(
              `insert into public.parties (name, normalized_name, party_type)
               values ('V2 BEC Kalkanı Tedarikçi A.Ş.', 'v2 bec kalkanı tedarikçi a.ş.', 'vendor')
               returning id::text`,
            )
          ).rows[0]!.id;

          // 1) Invalid MOD-97 IBAN rejected on payment template creation
          await expect(
            createPayment(
              txPool,
              {
                name: "Hatalı MOD-97 Ödeme Şablonu",
                recurrence_type: "one_off",
                due_date: "2088-08-15",
                default_amount: 30_000,
                currency: "TRY",
                direction: "outflow",
                provider_party_id: partyId,
                iban: invalidChecksumIban,
              },
              "2020-01-15",
              makerId,
            ),
          ).rejects.toMatchObject({ code: "VALIDATION" });

          // 2) Valid MOD-97 IBAN lands unverified (`verified_at IS NULL`, `pending_approval`) + raises control alert & audit
          const createdPay = await createPayment(
            txPool,
            {
              name: "Doğrulanacak IBAN Ödeme Şablonu",
              recurrence_type: "one_off",
              due_date: "2088-08-15",
              default_amount: 30_000,
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
          expect(vaultRow.approval_status).toBe("pending_approval");
          expect(vaultRow.verified_at).toBeNull();
          expect(vaultRow.approval_id).toBeTruthy();

          const ctrlBefore = await client.query<{ is_recent: boolean; requires_verification: boolean }>(
            `select is_recent, requires_verification from public.control_iban_changes where iban_id = $1::uuid`,
            [vaultRow.id],
          );
          expect(ctrlBefore.rows[0]).toEqual({ is_recent: true, requires_verification: true });

          const alertRow = await client.query<{ cnt: number }>(
            `select count(*)::int as cnt from public.control_alerts where check_code = 'iban_changed' and subject_id = $1::uuid and status = 'open'`,
            [vaultRow.id],
          );
          expect(alertRow.rows[0]?.cnt).toBe(1);

          // 3) Maker self-approval of IBAN is FORBIDDEN
          await expect(
            decideApproval(
              txPool,
              {
                approvalId: vaultRow.approval_id!,
                decision: "approved",
                note: "Maker kendi eklediği IBAN'ı onaylamaya çalışıyor",
              },
              makerId,
            ),
          ).rejects.toMatchObject({ code: "FORBIDDEN" });

          // 4) Source-recorded invalid MOD-97 IBAN cannot be approved even by distinct Checker -> VALIDATION
          const badIban = await addIban(
            txPool,
            {
              partyId,
              iban: invalidChecksumIban,
              currency: "TRY",
              accountLabel: "Bozuk Kaynak IBAN",
            },
            makerId,
          );
          expect(badIban.warnings.length).toBeGreaterThan(0);

          await client.query("SELECT set_config('app.user_id', $1, true)", [checkerId]);
          await expect(
            decideApproval(
              txPool,
              {
                approvalId: badIban.approvalId!,
                decision: "approved",
                note: "Bozuk kontrol basamaklı IBAN onay denemesi",
              },
              checkerId,
            ),
          ).rejects.toMatchObject({ code: "VALIDATION" });

          // 5) Seed a draft payment_run as makerId with TWO items referencing vaultRow.id:
          //    - item 1 has matching beneficiary_iban = validIban
          //    - item 2 has mismatched beneficiary_iban = spoofedSecondValidIban
          //    Approving vaultRow.id MUST set iban_verified=true ONLY on item 1, NEVER on item 2!
          await client.query("SELECT set_config('app.user_id', $1, true)", [makerId]);
          const cashAccId = (
            await client.query<{ id: string }>(
              `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
               values ('V2 Ödeme Paketi Kaynak Banka', 'bank_account', 'TRY', 500000.00, true)
               returning id::text`,
            )
          ).rows[0]!.id;
          await client.query(
            `insert into public.bank_accounts (cash_account_id, bank_name, iban) values ($1::uuid, 'Test Bank', $2)`,
            [cashAccId, makeValidTrIban("00010", "0000101010101010")],
          );

          const piTarget1 = (
            await client.query<{ id: string }>(
              `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source)
               values ($1::uuid, '2088-09-01', '2088-09-15', 10000.00, 'TRY', 'known', 'outflow', 'unpaid', 'manual')
               returning id::text`,
              [createdPay.paymentId],
            )
          ).rows[0]!.id;
          const piTarget2 = (
            await client.query<{ id: string }>(
              `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, amount_status, direction, status, amount_source)
               values ($1::uuid, '2088-10-01', '2088-10-15', 10000.00, 'TRY', 'known', 'outflow', 'unpaid', 'manual')
               returning id::text`,
              [createdPay.paymentId],
            )
          ).rows[0]!.id;

          const runId = (
            await client.query<{ id: string }>(
              `insert into public.payment_runs (run_code, planned_execution_date, source_bank_account_id, currency, total_amount, item_count, status, created_by)
               values ('PR-V2-IBAN-SHIELD', '2088-09-15', $1::uuid, 'TRY', 20000.00, 2, 'draft', $2::uuid)
               returning id::text`,
              [cashAccId, makerId],
            )
          ).rows[0]!.id;

          const itemMatchId = (
            await client.query<{ id: string }>(
              `insert into public.payment_run_items (run_id, target_type, target_id, party_id, iban_id, beneficiary_name, beneficiary_iban, amount, currency, due_date, description, iban_verified, status)
               values ($1::uuid, 'payment_instance', $2::uuid, $3::uuid, $4::uuid, 'Tedarikçi', $5, 10000.00, 'TRY', '2088-09-15', 'V2 Eşleşen IBAN Kalemi', false, 'included')
               returning id::text`,
              [runId, piTarget1, partyId, vaultRow.id, validIban],
            )
          ).rows[0]!.id;

          const itemMismatchId = (
            await client.query<{ id: string }>(
              `insert into public.payment_run_items (run_id, target_type, target_id, party_id, iban_id, beneficiary_name, beneficiary_iban, amount, currency, due_date, description, iban_verified, status)
               values ($1::uuid, 'payment_instance', $2::uuid, $3::uuid, $4::uuid, 'Tedarikçi', $5, 10000.00, 'TRY', '2088-10-15', 'V2 Uyuşmayan IBAN Kalemi', false, 'included')
               returning id::text`,
              [runId, piTarget2, partyId, vaultRow.id, spoofedSecondValidIban],
            )
          ).rows[0]!.id;

          // 6) Distinct Checker approves validIban -> stamps verified_at, clears requires_verification, updates ONLY matching item!
          await client.query("SELECT set_config('app.user_id', $1, true)", [checkerId]);
          await decideApproval(
            txPool,
            {
              approvalId: vaultRow.approval_id!,
              decision: "approved",
              note: "Tedarikçi banka teyit mektubu ile IBAN doğrulandı",
            },
            checkerId,
          );

          const verifiedIbanRow = await client.query<{
            approval_status: string;
            verified_at: string | null;
            verified_by: string | null;
          }>(
            `select approval_status, verified_at::text, verified_by::text from public.ibans where id = $1::uuid`,
            [vaultRow.id],
          );
          expect(verifiedIbanRow.rows[0]?.approval_status).toBe("approved");
          expect(verifiedIbanRow.rows[0]?.verified_at).not.toBeNull();
          expect(verifiedIbanRow.rows[0]?.verified_by).toBe(checkerId);

          const ctrlAfter = await client.query<{ is_recent: boolean; requires_verification: boolean }>(
            `select is_recent, requires_verification from public.control_iban_changes where iban_id = $1::uuid`,
            [vaultRow.id],
          );
          expect(ctrlAfter.rows[0]).toEqual({ is_recent: false, requires_verification: false });

          const runItemsAfter = await client.query<{ id: string; iban_verified: boolean }>(
            `select id::text, iban_verified from public.payment_run_items where id = any($1::uuid[])`,
            [[itemMatchId, itemMismatchId]],
          );
          const byId = new Map(runItemsAfter.rows.map((r) => [r.id, r.iban_verified]));
          expect(byId.get(itemMatchId)).toBe(true);
          expect(byId.get(itemMismatchId)).toBe(false);
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );
  },
);
