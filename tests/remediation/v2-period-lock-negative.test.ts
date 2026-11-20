import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/lib/domain-error";
import {
  cancelInstance,
  createPayment,
  generateInstancesForMonthWithClient,
  linkPaymentInstanceToInvoice,
  markInstancePaid,
  markInstancePartial,
  markInstanceUnpaid,
  reconcileInstancesWithClient,
  setInstanceAmount,
  updatePaymentWithCascade,
} from "@/lib/radar/engine";
import * as appUrlModule from "../../scripts/db/app-url";
import { createBackupAdapter } from "../../scripts/db/backup-adapter";
import { isDisposableDatabaseName } from "../../scripts/db/owner-url";
import {
  resolveLocalOwnerUrl,
} from "../../scripts/db/pg-local-admin";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "22222222-2222-4222-8222-222222222222";
const INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID = "44444444-4444-4444-8444-444444444444";

type PeriodFaultKind =
  | "42P01_missing_table"
  | "42703_missing_column"
  | "57014_query_timeout"
  | "42501_permission_denied"
  | "unexpected_sql"
  | "period_locked";

function makePeriodFaultError(kind: Exclude<PeriodFaultKind, "period_locked">): Error {
  switch (kind) {
    case "42P01_missing_table":
      return Object.assign(new Error('relation "public.accounting_periods" does not exist'), {
        code: "42P01",
      });
    case "42703_missing_column":
      return Object.assign(new Error('column "period_month" does not exist'), {
        code: "42703",
      });
    case "57014_query_timeout":
      return Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      });
    case "42501_permission_denied":
      return Object.assign(new Error("permission denied for table accounting_periods"), {
        code: "42501",
      });
    case "unexpected_sql":
      return new Error(
        "Sahte client beklenmeyen SQL gördü: select status from public.accounting_periods",
      );
  }
}

interface RecordedMockPool {
  pool: Pool;
  client: PoolClient;
  executedSql: string[];
  mutationQueries: string[];
  commits: number;
  rollbacks: number;
}

function buildPeriodFaultMockPool(
  faultKind: PeriodFaultKind | "unlocked",
  instanceStatus: "unpaid" | "paid" | "partial" = "unpaid",
): RecordedMockPool {
  const executedSql: string[] = [];
  const mutationQueries: string[] = [];
  let commits = 0;
  let rollbacks = 0;

  const queryFn = vi.fn(async (rawSql: string) => {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    const lower = sql.toLowerCase();
    executedSql.push(sql);

    if (lower === "begin") return { rows: [], rowCount: 0 };
    if (lower === "commit") {
      commits += 1;
      return { rows: [], rowCount: 0 };
    }
    if (lower === "rollback") {
      rollbacks += 1;
      return { rows: [], rowCount: 0 };
    }
    if (
      lower.startsWith("savepoint ") ||
      lower.startsWith("release savepoint ") ||
      lower.startsWith("rollback to savepoint ")
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (/^(insert|update|delete|truncate)\b/i.test(lower)) {
      mutationQueries.push(sql);
      if (lower.startsWith("insert into public.payments")) {
        return { rows: [{ id: PAYMENT_ID }], rowCount: 1 };
      }
      if (lower.startsWith("insert into public.payment_instances")) {
        return { rows: [{ id: INSTANCE_ID }], rowCount: 1 };
      }
      if (lower.includes("returning") && lower.includes("cancelled_at_iso")) {
        return { rows: [{ cancelled_at_iso: "2026-08-20T12:00:00.000000Z" }], rowCount: 1 };
      }
      return { rows: [{ id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 };
    }

    if (lower.includes("from public.accounting_periods")) {
      if (faultKind === "unlocked") {
        return { rows: [], rowCount: 0 };
      }
      if (faultKind === "period_locked") {
        return { rows: [{ status: "locked" }], rowCount: 1 };
      }
      throw makePeriodFaultError(faultKind);
    }

    if (lower.includes("from public.payment_instances") && lower.includes("for update")) {
      return {
        rows: [
          {
            id: INSTANCE_ID,
            payment_id: PAYMENT_ID,
            instance_month: "2026-08-01",
            due_date: "2026-08-20",
            status: instanceStatus,
            amount: "12500.00",
            amount_status: "known",
            amount_source: "generated",
            paid_amount: instanceStatus === "partial" ? "4000.00" : instanceStatus === "paid" ? "12500.00" : null,
            paid_at: instanceStatus === "unpaid" ? null : "2026-08-18",
            cancelled_at: null,
            cancel_reason: null,
            direction: "outflow",
            currency: "TRY",
            approval_status: "not_required",
            linked_invoice_id: null,
            note: null,
          },
        ],
        rowCount: 1,
      };
    }

    if (lower.includes("from public.cashflow_months")) {
      return { rows: [], rowCount: 0 };
    }

    if (lower.includes("from public.payments") && lower.includes("for update")) {
      return {
        rows: [
          {
            id: PAYMENT_ID,
            name: "Kira Ödemesi",
            recurrence_type: "one_off",
            due_day: 20,
            due_date: "2026-08-20",
            default_amount: "12500.00",
            currency: "TRY",
            amount_confidence: "known",
            direction: "outflow",
            priority: "normal",
            status: "active",
            source_notes: null,
          },
        ],
        rowCount: 1,
      };
    }

    if (lower.includes("from public.payments")) {
      return {
        rows: [
          {
            id: PAYMENT_ID,
            name: "Kira Ödemesi",
            due_day: 20,
            due_date: null,
            created_iso: "2026-01-01",
            default_amount: "12500.00",
            currency: "TRY",
            recurrence_type: "monthly",
            source_notes: null,
            amount_confidence: "known",
            direction: "outflow",
          },
        ],
        rowCount: 1,
      };
    }

    if (lower.includes("from public.invoices")) {
      return {
        rows: [
          {
            id: INVOICE_ID,
            direction: "purchase",
            currency: "TRY",
            status: "open",
          },
        ],
        rowCount: 1,
      };
    }

    return { rows: [], rowCount: 0 };
  });

  const client = {
    query: queryFn,
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    connect: vi.fn(async () => client),
    query: queryFn,
  } as unknown as Pool;

  return {
    pool,
    client,
    executedSql,
    mutationQueries,
    get commits() {
      return commits;
    },
    get rollbacks() {
      return rollbacks;
    },
  };
}

const ALL_PERIOD_FAULTS: readonly PeriodFaultKind[] = [
  "42P01_missing_table",
  "42703_missing_column",
  "57014_query_timeout",
  "42501_permission_denied",
  "unexpected_sql",
  "period_locked",
];

const ERROR_ONLY_FAULTS: readonly Exclude<PeriodFaultKind, "period_locked">[] = [
  "42P01_missing_table",
  "42703_missing_column",
  "57014_query_timeout",
  "42501_permission_denied",
  "unexpected_sql",
];

function assertExpectedPeriodFailure(err: unknown, faultKind: PeriodFaultKind): void {
  expect(err).toBeDefined();
  if (
    faultKind === "42P01_missing_table" ||
    faultKind === "42703_missing_column" ||
    faultKind === "period_locked"
  ) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("CONFLICT");
    if (faultKind !== "period_locked") {
      expect((err as DomainError).message).toMatch(/SCHEMA_INCOMPATIBLE/i);
    }
  } else if (faultKind === "57014_query_timeout") {
    expect((err as { code?: string }).code).toBe("57014");
  } else if (faultKind === "42501_permission_denied") {
    expect((err as { code?: string }).code).toBe("42501");
  } else if (faultKind === "unexpected_sql") {
    expect((err as Error).message).toMatch(/beklenmeyen SQL/i);
  }
}

describe("V2 Agent 01 — F-02 Fail-Closed Accounting Period Lock (Mocked Fault Matrix)", () => {
  it.each(ALL_PERIOD_FAULTS)(
    "markInstancePaid fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await markInstancePaid(mock.pool, INSTANCE_ID, 12_500, ACTOR_ID);
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "markInstancePartial fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await markInstancePartial(mock.pool, INSTANCE_ID, 5_000, ACTOR_ID);
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "markInstanceUnpaid fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "paid");
      let caught: unknown;
      try {
        await markInstanceUnpaid(mock.pool, INSTANCE_ID, ACTOR_ID);
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "setInstanceAmount (instance update) fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await setInstanceAmount(mock.pool, INSTANCE_ID, 19_000, ACTOR_ID);
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "cancelInstance fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await cancelInstance(mock.pool, INSTANCE_ID, "Mükerrer tahakkuk iptali", ACTOR_ID);
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "linkPaymentInstanceToInvoice fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await linkPaymentInstanceToInvoice(mock.pool, {
          instanceId: INSTANCE_ID,
          invoiceId: INVOICE_ID,
          actor: ACTOR_ID,
        });
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "createPayment (one_off) fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await createPayment(
          mock.pool,
          {
            name: "Kilitli Dönem Ödemesi",
            recurrence_type: "one_off",
            due_date: "2026-08-20",
            default_amount: 12_500,
            currency: "TRY",
            direction: "outflow",
          },
          "2026-08-05",
          ACTOR_ID,
        );
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ALL_PERIOD_FAULTS)(
    "updatePaymentWithCascade fails closed on %s with 0 mutation SQL and full transaction rollback",
    async (faultKind) => {
      const mock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let caught: unknown;
      try {
        await updatePaymentWithCascade(
          mock.pool,
          PAYMENT_ID,
          {
            name: "Güncellenen Kira",
            recurrence_type: "one_off",
            due_day: null,
            due_date: "2026-08-20",
            default_amount: 15_000,
            currency: "TRY",
            amount_confidence: "known",
            direction: "outflow",
            priority: "normal",
            flexibility_class: null,
            status: "active",
            category_id: null,
            provider_party_id: null,
            owner_party_id: null,
            cash_account_id: null,
            description: null,
          },
          "2026-08-05",
          ACTOR_ID,
        );
      } catch (err) {
        caught = err;
      }
      assertExpectedPeriodFailure(caught, faultKind);
      expect(mock.mutationQueries).toEqual([]);
      expect(mock.commits).toBe(0);
      expect(mock.rollbacks).toBe(1);
    },
  );

  it.each(ERROR_ONLY_FAULTS)(
    "generateInstancesForMonthWithClient & reconcileInstancesWithClient never swallow %s (0 mutation SQL)",
    async (faultKind) => {
      const genMock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let genErr: unknown;
      try {
        await generateInstancesForMonthWithClient(genMock.client, "2026-08-01", ACTOR_ID);
      } catch (err) {
        genErr = err;
      }
      assertExpectedPeriodFailure(genErr, faultKind);
      expect(genMock.mutationQueries).toEqual([]);

      const recMock = buildPeriodFaultMockPool(faultKind, "unpaid");
      let recErr: unknown;
      try {
        await reconcileInstancesWithClient(
          recMock.client,
          PAYMENT_ID,
          { dueDay: 25, defaultAmount: 18_000, amountConfidence: "known", currency: "TRY" },
          "2026-08-01",
          ACTOR_ID,
        );
      } catch (err) {
        recErr = err;
      }
      assertExpectedPeriodFailure(recErr, faultKind);
      expect(recMock.mutationQueries).toEqual([]);
    },
  );

  it("positive control: unlocked accounting_periods allows markInstancePaid, setInstanceAmount, and createPayment to commit", async () => {
    const paidMock = buildPeriodFaultMockPool("unlocked", "unpaid");
    await expect(
      markInstancePaid(paidMock.pool, INSTANCE_ID, 12_500, ACTOR_ID),
    ).resolves.toBeUndefined();
    expect(paidMock.commits).toBe(1);
    expect(paidMock.rollbacks).toBe(0);

    const amtMock = buildPeriodFaultMockPool("unlocked", "unpaid");
    await expect(
      setInstanceAmount(amtMock.pool, INSTANCE_ID, 14_000, ACTOR_ID),
    ).resolves.toBeUndefined();
    expect(amtMock.commits).toBe(1);
    expect(amtMock.rollbacks).toBe(0);

    const createMock = buildPeriodFaultMockPool("unlocked", "unpaid");
    const created = await createPayment(
      createMock.pool,
      {
        name: "Açık Dönem Ödemesi",
        recurrence_type: "one_off",
        due_date: "2026-08-20",
        default_amount: 9_500,
        currency: "TRY",
        direction: "outflow",
      },
      "2026-08-05",
      ACTOR_ID,
    );
    expect(created.paymentId).toBe(PAYMENT_ID);
    expect(createMock.commits).toBe(1);
    expect(createMock.rollbacks).toBe(0);
  });
});

function hasLocalPgAdmin(): boolean {
  if (process.env.MIGRATION_DATABASE_URL?.trim()) return true;
  try {
    const local = appUrlModule.readEnvLocal();
    return Boolean(local.MIGRATION_DATABASE_URL?.trim() || local.DATABASE_URL?.trim());
  } catch {
    return false;
  }
}

describe.skipIf(!hasLocalPgAdmin())(
  "V2 Agent 01 — F-02 Real Disposable PostgreSQL Rollback Verification (mas_radar_v2_agent01_period_verify)",
  () => {
    const DISPOSABLE_DB = "mas_radar_v2_agent01_period_verify";
    let pool: Pool;

    beforeAll(async () => {
      expect(isDisposableDatabaseName(DISPOSABLE_DB)).toBe(true);
      expect(DISPOSABLE_DB).toMatch(/^mas_radar_v2_agent01_[a-z0-9_]+$/);

      const adminPool = new Pool({
        connectionString: resolveLocalOwnerUrl("postgres"),
        max: 1,
        connectionTimeoutMillis: 80_000,
      });
      try {
        const existing = await adminPool.query(
          `select 1 from pg_database where datname = $1`,
          [DISPOSABLE_DB],
        );
        if ((existing.rowCount ?? 0) > 0) {
          await adminPool.query(`drop database if exists ${DISPOSABLE_DB} with (force)`);
        }
        await adminPool.query(`create database ${DISPOSABLE_DB}`);
      } finally {
        await adminPool.end().catch(() => {});
      }

      pool = new Pool({
        connectionString: resolveLocalOwnerUrl(DISPOSABLE_DB),
        max: 1,
        connectionTimeoutMillis: 80_000,
      });

      // Build real tables WITHOUT DB period-lock triggers to prove application-layer radar/engine.ts
      // enforces fail-closed rollback on locked period, missing column (42703), and missing table (42P01).
      await pool.query(`
        create extension if not exists pgcrypto;

        create table public.audit_logs (
          id uuid primary key default gen_random_uuid(),
          actor uuid,
          action text not null,
          entity_table text not null,
          entity_id uuid,
          before_data jsonb,
          after_data jsonb,
          created_at timestamptz not null default now()
        );

        create table public.cashflow_months (
          id uuid primary key default gen_random_uuid(),
          month_start date not null unique,
          status text not null default 'open'
        );

        create table public.accounting_periods (
          id uuid primary key default gen_random_uuid(),
          period_month date not null unique,
          status text not null default 'open'
        );

        create table public.payments (
          id uuid primary key default gen_random_uuid(),
          name text not null,
          recurrence_type text not null default 'monthly',
          due_day int,
          due_date date,
          default_amount numeric(18,2),
          currency text not null default 'TRY',
          amount_confidence text not null default 'known',
          direction text not null default 'outflow',
          priority text not null default 'normal',
          flexibility_class text,
          status text not null default 'active',
          category_id uuid,
          provider_party_id uuid,
          owner_party_id uuid,
          cash_account_id uuid,
          cost_center_id uuid,
          project_id uuid,
          department_id uuid,
          description text,
          source_notes text,
          archived_at timestamptz,
          created_at timestamptz not null default now()
        );

        create table public.payment_instances (
          id uuid primary key default gen_random_uuid(),
          payment_id uuid references public.payments(id),
          instance_month date not null,
          due_date date not null,
          amount numeric(18,2),
          currency text not null default 'TRY',
          amount_status text not null default 'known',
          amount_source text not null default 'generated',
          direction text not null default 'outflow',
          status text not null default 'unpaid',
          paid_amount numeric(18,2),
          paid_at timestamptz,
          paid_from_account_id uuid,
          approval_status text not null default 'not_required',
          approval_id uuid,
          cancelled_at timestamptz,
          cancel_reason text,
          linked_invoice_id uuid,
          note text
        );

        create unique index payment_instances_payment_month_uq
          on public.payment_instances (payment_id, instance_month)
          where payment_id is not null;
      `);
    }, SUBPROCESS_TEST_TIMEOUT_MS);

    afterAll(async () => {
      try {
        await pool?.end();
      } finally {
        const dropPool = new Pool({
          connectionString: resolveLocalOwnerUrl("postgres"),
          max: 1,
          connectionTimeoutMillis: 80_000,
        });
        try {
          await dropPool.query(`drop database if exists ${DISPOSABLE_DB} with (force)`);
        } finally {
          await dropPool.end().catch(() => {});
        }
      }
    }, SUBPROCESS_TEST_TIMEOUT_MS);

    async function readCounts(): Promise<{ payments: number; instances: number; audits: number; instanceStatus: string }> {
      const r = await pool.query<{
        payments: number;
        instances: number;
        audits: number;
        instance_status: string;
      }>(`
        select
          (select count(*)::int from public.payments) as payments,
          (select count(*)::int from public.payment_instances) as instances,
          (select count(*)::int from public.audit_logs) as audits,
          coalesce((select status from public.payment_instances limit 1), 'none') as instance_status
      `);
      return {
        payments: r.rows[0]!.payments,
        instances: r.rows[0]!.instances,
        audits: r.rows[0]!.audits,
        instanceStatus: r.rows[0]!.instance_status,
      };
    }

    it("rolls back real PostgreSQL transactions with 0 persisted mutations on locked period, 42703 column drift, and 42P01 missing accounting_periods", async () => {
      // 0) F-06 live cluster-identity verification via resolveRuntimeEnvForTarget on disposable DB
      const sysIdentRes = await pool.query<{ system_identifier: string }>(
        `select system_identifier::text as system_identifier from pg_control_system()`,
      );
      const realIdentifier = sysIdentRes.rows[0]!.system_identifier;
      const runtimeEnv = appUrlModule.resolveRuntimeEnvForTarget(DISPOSABLE_DB, process.env);
      const adapter = createBackupAdapter({
        ownerUrl: resolveLocalOwnerUrl(DISPOSABLE_DB),
        env: runtimeEnv,
      });
      expect(() => adapter.verifyTarget(DISPOSABLE_DB, realIdentifier)).not.toThrow();
      expect(() => adapter.verifyTarget(DISPOSABLE_DB, "0000000000000000000")).toThrow();

      // Seed 1 open payment + 1 unpaid instance in 2026-08, then lock 2026-08 in accounting_periods ONLY
      const seededPay = await pool.query<{ id: string }>(
        `insert into public.payments (name, recurrence_type, due_date, default_amount, currency, status)
         values ('V2 Gerçek PG Şablon', 'one_off', '2026-08-20', 8500.00, 'TRY', 'active')
         returning id::text as id`,
      );
      const seededInst = await pool.query<{ id: string }>(
        `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, status)
         values ($1::uuid, '2026-08-01', '2026-08-20', 8500.00, 'TRY', 'unpaid')
         returning id::text as id`,
        [seededPay.rows[0]!.id],
      );
      const instId = seededInst.rows[0]!.id;

      await pool.query(
        `insert into public.accounting_periods (period_month, status) values ('2026-08-01', 'locked')`,
      );

      const baseline = await readCounts();
      expect(baseline).toEqual({ payments: 1, instances: 1, audits: 0, instanceStatus: "unpaid" });

      // 1) Locked accounting_periods blocks markInstancePaid, setInstanceAmount, cancelInstance, createPayment
      await expect(markInstancePaid(pool, instId, 8_500, ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(setInstanceAmount(pool, instId, 9_900, ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(cancelInstance(pool, instId, "Test iptal", ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(
        createPayment(
          pool,
          {
            name: "Kilitli Ayda Yeni Ödeme",
            recurrence_type: "one_off",
            due_date: "2026-08-25",
            default_amount: 4_200,
            currency: "TRY",
          },
          "2026-08-10",
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await readCounts()).toEqual(baseline);

      // 2) 42703 undefined_column on accounting_periods -> fail-closed CONFLICT + full PostgreSQL ROLLBACK
      await pool.query(`alter table public.accounting_periods rename column status to status_drifted`);
      await expect(markInstancePaid(pool, instId, 8_500, ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/SCHEMA_INCOMPATIBLE/i),
      });
      await expect(
        createPayment(
          pool,
          {
            name: "42703 Şema Kayması Ödemesi",
            recurrence_type: "one_off",
            due_date: "2026-08-25",
            default_amount: 4_200,
            currency: "TRY",
          },
          "2026-08-10",
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/SCHEMA_INCOMPATIBLE/i),
      });
      expect(await readCounts()).toEqual(baseline);

      // 3) 42P01 undefined_table (accounting_periods dropped) -> fail-closed CONFLICT + full PostgreSQL ROLLBACK
      await pool.query(`drop table public.accounting_periods`);
      await expect(markInstancePaid(pool, instId, 8_500, ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/SCHEMA_INCOMPATIBLE/i),
      });
      await expect(setInstanceAmount(pool, instId, 11_000, ACTOR_ID)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/SCHEMA_INCOMPATIBLE/i),
      });
      await expect(
        createPayment(
          pool,
          {
            name: "42P01 Eksik Tablo Ödemesi",
            recurrence_type: "one_off",
            due_date: "2026-08-25",
            default_amount: 4_200,
            currency: "TRY",
          },
          "2026-08-10",
          ACTOR_ID,
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/SCHEMA_INCOMPATIBLE/i),
      });
      expect(await readCounts()).toEqual(baseline);
    }, SUBPROCESS_TEST_TIMEOUT_MS);
  },
);

describe("V2 Agent 01 — F-06 Migration CI Portability vs Fail-Closed Non-Disposable Target", () => {
  const resolveRuntimeEnvForTarget = (
    appUrlModule as unknown as {
      resolveRuntimeEnvForTarget?: (
        targetDbName: string,
        procEnv?: Readonly<Record<string, string | undefined>>,
        readEnvLocalFn?: () => Record<string, string>,
      ) => Record<string, string>;
    }
  ).resolveRuntimeEnvForTarget;

  const missingEnvLocal = (): Record<string, string> => {
    throw new Error(".env.local yok — hedefin app bağlantısı gerçek runtime kimliğinden türetilemiyor.");
  };

  it("exports resolveRuntimeEnvForTarget and removes silent catch {} fallback in scripts/db/migrate-verify.ts", () => {
    expect(typeof resolveRuntimeEnvForTarget).toBe("function");
    const migrateVerifySrc = readFileSync(
      path.join(process.cwd(), "scripts", "db", "migrate-verify.ts"),
      "utf8",
    );
    expect(migrateVerifySrc).toContain("resolveRuntimeEnvForTarget");
    expect(migrateVerifySrc).not.toMatch(/try\s*\{\s*return\s+readEnvLocal\(\);\s*\}\s*catch\s*\{\s*return\s*\{\};\s*\}/);
  });

  it("PASSES when .env.local is missing, targetDbName is disposable, and explicit CI runtime env is provided (without inventing postgres:postgres)", () => {
    expect(typeof resolveRuntimeEnvForTarget).toBe("function");
    const envDocker = resolveRuntimeEnvForTarget!(
      "mas_radar_cluster_identity_test",
      {
        NODE_ENV: "test",
        MAS_PG_RUNTIME: "docker",
        PGHOST: "127.0.0.1",
      },
      missingEnvLocal,
    );
    expect(envDocker.MAS_PG_RUNTIME).toBe("docker");
    expect(envDocker.PGHOST).toBe("127.0.0.1");
    expect(envDocker.DATABASE_URL).toBeUndefined();
    expect(envDocker.MIGRATION_DATABASE_URL).toBeUndefined();

    const envExplicitOwner = resolveRuntimeEnvForTarget!(
      "mas_radar_v2_agent01_verify",
      {
        NODE_ENV: "test",
        MIGRATION_DATABASE_URL: "postgres://ci_owner:ci_pass@127.0.0.1:5432/mas_radar_v2_agent01_verify",
      },
      missingEnvLocal,
    );
    expect(envExplicitOwner.MIGRATION_DATABASE_URL).toBe(
      "postgres://ci_owner:ci_pass@127.0.0.1:5432/mas_radar_v2_agent01_verify",
    );
    expect(envExplicitOwner.DATABASE_URL).toBeUndefined();
  });

  it("FAILS CLOSED when .env.local is missing and targetDbName is NOT disposable (mas_radar_dev / mas_radar_prod / postgres)", () => {
    expect(typeof resolveRuntimeEnvForTarget).toBe("function");
    for (const protectedOrProdTarget of ["mas_radar_dev", "mas_radar_prod", "postgres", ""]) {
      expect(() =>
        resolveRuntimeEnvForTarget!(
          protectedOrProdTarget,
          {
            NODE_ENV: "test",
            MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
            MAS_PG_RUNTIME: "docker",
            PGHOST: "127.0.0.1",
          },
          missingEnvLocal,
        ),
      ).toThrow();
    }
  });

  it("FAILS CLOSED when .env.local is missing on a disposable target WITHOUT explicit MIGRATION_DATABASE_URL / MAS_PG_RUNTIME / PGHOST", () => {
    expect(typeof resolveRuntimeEnvForTarget).toBe("function");
    expect(() =>
      resolveRuntimeEnvForTarget!(
        "mas_radar_cluster_identity_test",
        {
          NODE_ENV: "test",
          PATH: "/usr/local/bin:/usr/bin",
        },
        missingEnvLocal,
      ),
    ).toThrow();
  });

  it("merges only non-secret PG runtime keys from .env.local when present without leaking credentials", () => {
    expect(typeof resolveRuntimeEnvForTarget).toBe("function");
    const resolved = resolveRuntimeEnvForTarget!(
      "mas_radar_cluster_identity_test",
      { NODE_ENV: "test" },
      () => ({
        DATABASE_URL: "postgres://mas_radar_app:super-secret@127.0.0.1:5432/mas_radar_dev",
        TELEGRAM_BOT_TOKEN: "secret-bot-token",
        MAS_PG_RUNTIME: "native",
        MAS_PG_BIN_DIR: "C:\\Program Files\\PostgreSQL\\16\\bin",
      }),
    );
    expect(resolved.MAS_PG_RUNTIME).toBe("native");
    expect(resolved.MAS_PG_BIN_DIR).toBe("C:\\Program Files\\PostgreSQL\\16\\bin");
    expect(resolved.DATABASE_URL).toBeUndefined();
    expect(resolved.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });
});
