// Faz 45 (C2) — Veritabanı seviyesinde sert dönem kilidi (0100_hard_period_lock_enforcement.sql),
// rol-korumalı kilit/yeniden açma geçişi, kapanış öncesi kontrol listesi (evaluatePeriodCloseReadiness),
// lockCashflowPeriod / reopenCashflowPeriod denetim izi ve açık dönem tahsilatı istisnası testleri.
//
// Güvenlik kuralı: Gerçek veritabanına (mas_radar_dev) ASLA bağlanmaz. Canlı PostgreSQL
// doğrulamaları yalnız tek kullanımlık (disposable) veritabanı hedeflendiğinde ve her test
// kendi BEGIN ... ROLLBACK bloğu içinde izole edilerek çalışır.

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { canManagePeriodLock } from "@/lib/authz/matrix";
import {
  PERIOD_LOCKED_USER_MESSAGE,
  evaluatePeriodCloseReadiness,
  isPgPeriodLockedError,
  lockCashflowPeriod,
  reopenCashflowPeriod,
  reopenPeriodSchema,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { DomainError } from "@/lib/domain-error";
import { generateInstancesForMonthWithClient, refreshRiskFlagsWithClient } from "@/lib/radar/engine";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

function openDisposablePool(): Pool {
  const { url } = assertDisposableTargetDb(undefined, "tests/financial/period-lock.test.ts");
  return new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
}

async function inRollback<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/**
 * Wraps an already-checked-out transactional PoolClient as a Pool so service functions that call
 * `pool.connect()` + `begin`/`commit`/`rollback` execute inside nested SAVEPOINTs and roll back
 * cleanly at the end of the test.
 */
function transactionalClientAsPool(client: PoolClient): Pool {
  let spSeq = 0;
  const stack: string[] = [];
  const proxyClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "release") {
        return () => {};
      }
      if (prop === "query") {
        return async (sql: unknown, params?: unknown) => {
          if (typeof sql === "string") {
            const norm = sql.trim().toLowerCase();
            if (norm === "begin") {
              const sp = `sp_plock_${++spSeq}`;
              stack.push(sp);
              return target.query(`savepoint ${sp}`);
            }
            if (norm === "commit") {
              const sp = stack.pop();
              if (sp) return target.query(`release savepoint ${sp}`);
              return { rows: [], rowCount: 0 };
            }
            if (norm === "rollback") {
              const sp = stack.pop();
              if (sp) return target.query(`rollback to savepoint ${sp}`);
              return { rows: [], rowCount: 0 };
            }
          }
          return (target.query as (q: unknown, p?: unknown) => Promise<unknown>)(sql, params);
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  return {
    connect: async () => proxyClient,
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
  } as unknown as Pool;
}

async function expectPgError(
  client: PoolClient,
  expectedCode: string,
  expectedMessagePattern: RegExp,
  fn: () => Promise<unknown>,
): Promise<void> {
  await client.query("savepoint sp_expect_err");
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  await client.query("rollback to savepoint sp_expect_err");
  await client.query("release savepoint sp_expect_err");

  expect(caught).not.toBeNull();
  const code = (caught as { code?: string })?.code;
  const message = String((caught as { message?: string })?.message ?? "");
  expect(code).toBe(expectedCode);
  expect(message).toMatch(expectedMessagePattern);
}

describe("Faz 45 (C2) — Dönem kilidi birim ve şema sözleşmesi kontrolleri", () => {
  it("0100_hard_period_lock_enforcement.sql migration dosya kümesi doğrulamasından geçer", () => {
    const fileSet = validateFileSet(MIGRATIONS_DIR);
    expect(fileSet.errors).toEqual([]);
    const m0100 = fileSet.files.find((f) => f.version === "0100");
    expect(m0100).toBeDefined();
    expect(m0100?.name).toBe("0100_hard_period_lock_enforcement.sql");
  });

  it("canManagePeriodLock yalnız finance_manager ve admin rollerine izin verir", () => {
    expect(canManagePeriodLock("viewer")).toBe(false);
    expect(canManagePeriodLock("finance_operator")).toBe(false);
    expect(canManagePeriodLock("finance_approver")).toBe(false);
    expect(canManagePeriodLock("finance_manager")).toBe(true);
    expect(canManagePeriodLock("admin")).toBe(true);
  });

  it("translatePeriodLockError PostgreSQL P0001 / 42501 / 23514 hatalarını Türkçe DomainError mesajlarına çevirir", () => {
    const pgLocked = Object.assign(new Error("period_locked: 2099-08 ayı kilitlidir"), { code: "P0001" });
    expect(isPgPeriodLockedError(pgLocked)).toBe(true);
    expect(() => translatePeriodLockError(pgLocked)).toThrowError(
      new DomainError("CONFLICT", PERIOD_LOCKED_USER_MESSAGE),
    );

    try {
      translatePeriodLockError(pgLocked);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("CONFLICT");
      expect((err as DomainError).message).toBe(PERIOD_LOCKED_USER_MESSAGE);
    }

    const pgRole = Object.assign(new Error("period_lock_requires_manager"), { code: "42501" });
    try {
      translatePeriodLockError(pgRole);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("FORBIDDEN");
    }

    const pgReason = Object.assign(new Error("period_reopen_reason_required"), { code: "23514" });
    try {
      translatePeriodLockError(pgReason);
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe("VALIDATION");
    }
  });

  it("reopenPeriodSchema 10 karakterden kısa veya boşlukla şişirilmiş gerekçeleri reddeder", () => {
    const uuid = "00000000-0000-4000-8000-000000000001";
    expect(reopenPeriodSchema.safeParse({ monthId: uuid, reason: "kısa" }).success).toBe(false);
    expect(reopenPeriodSchema.safeParse({ monthId: uuid, reason: "   12345   " }).success).toBe(false);
    expect(
      reopenPeriodSchema.safeParse({ monthId: uuid, reason: "Geç gelen tedarikçi faturası düzeltmesi" }).success,
    ).toBe(true);
  });

  it("zorunlu modda (MAS_REQUIRE_DISPOSABLE_DB_TEST=1) tek kullanımlık veritabanı sağlanmış olmalıdır", () => {
    if (requireDisposableDb) {
      expect(hasDisposableDb).toBe(true);
    } else {
      expect(typeof hasDisposableDb).toBe("boolean");
    }
  });
});

describe.skipIf(!hasDisposableDb)("Faz 45 (C2) — Canlı PostgreSQL 0100 sert dönem kilidi kapıları", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = openDisposablePool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("8 finansal tablonun tamamında kilitli aya INSERT, UPDATE (yerinde + dönemler arası tarih kaydırma) ve DELETE P0001 ile reddedilir; açık ayda çalışır", async () => {
    await inRollback(pool, async (c) => {
      const partyId = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C2 Kilit Tedarikçi', 'c2 kilit tedarikci', 'vendor')
           returning id`,
        )
      ).rows[0].id;

      const cashAccId = (
        await c.query<{ id: string }>(
          `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
           values ('C2 Kilit Banka', 'bank_account', 'TRY', 100000, true)
           returning id`,
        )
      ).rows[0].id;
      await c.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, available_balance, balance_as_of)
         values ($1, 'C2 Bank', 100000, now())`,
        [cashAccId],
      );

      const loanId = (
        await c.query<{ id: string }>(
          `insert into public.loans (name, principal, currency, status)
           values ('C2 Kilit Kredi', 120000, 'TRY', 'active')
           returning id`,
        )
      ).rows[0].id;

      // 1) Henüz açık olan 2099-08 ve 2099-09 dönemlerini ve her iki dönemin başlangıç kayıtlarını oluştur
      const augMonthId = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2099-08-01', 100000, 50000, 30000, 20000, 120000, 'reviewed')
           returning id`,
        )
      ).rows[0].id;

      const sepMonthId = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2099-09-01', 120000, 40000, 10000, 30000, 150000, 'draft')
           returning id`,
        )
      ).rows[0].id;

      // 2099-08 (birazdan kilitlenecek ay) kayıtları
      const augInvoiceId = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
           values ($1, 'purchase', '2099-08-05', '2099-08-20', 5000, 5000, 'TRY', 'open', 'C2-AUG-INV-1')
           returning id`,
          [partyId],
        )
      ).rows[0].id;

      const augPayId = (
        await c.query<{ id: string }>(
          `insert into public.payments (name, recurrence_type, due_date, default_amount, currency, status)
           values ('C2 Ağustos Tekil Ödeme', 'one_off', '2099-08-12', 2500, 'TRY', 'active')
           returning id`,
        )
      ).rows[0].id;

      const augPiId = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (payment_id, instance_month, due_date, amount, amount_status, currency, status, direction)
           values ($1, '2099-08-01', '2099-08-12', 2500, 'known', 'TRY', 'unpaid', 'outflow')
           returning id`,
          [augPayId],
        )
      ).rows[0].id;

      const augAllocId = (
        await c.query<{ id: string }>(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount, allocated_on)
           values ($1, 'payment_instances', $2, 1000, '2099-08-14')
           returning id`,
          [augInvoiceId, augPiId],
        )
      ).rows[0].id;

      const augLineId = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_lines
             (cashflow_month_id, line_type, direction, label, amount, amount_status)
           values ($1, 'vendor_payment', 'outflow', 'C2 Ağustos Satır', 3000, 'known')
           returning id`,
          [augMonthId],
        )
      ).rows[0].id;

      const augCheckId = (
        await c.query<{ id: string }>(
          `insert into public.checks
             (direction, amount, signed_amount, currency, maturity_date, status, counterparty_label)
           values ('outflow', 4000, -4000, 'TRY', '2099-08-18', 'planned', 'C2 Çek Alıcısı')
           returning id`,
        )
      ).rows[0].id;

      const augLoanInstId = (
        await c.query<{ id: string }>(
          `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
           values ($1, 1, '2099-08-22', 6000, 'planned')
           returning id`,
          [loanId],
        )
      ).rows[0].id;

      const augBankTxId = (
        await c.query<{ id: string }>(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
           values ($1, '2099-08-15', -2500, 'TRY', 'unmatched', 'C2 Ağustos Hareket', 'c2-aug-btx-1')
           returning id`,
          [cashAccId],
        )
      ).rows[0].id;

      // 2099-09 (açık ay) kayıtları — açık aydan kilitli aya tarih kaydırma (backdate) denemeleri için
      const sepInvoiceId = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
           values ($1, 'purchase', '2099-09-05', '2099-09-20', 7000, 7000, 'TRY', 'open', 'C2-SEP-INV-1')
           returning id`,
          [partyId],
        )
      ).rows[0].id;

      const sepPayId = (
        await c.query<{ id: string }>(
          `insert into public.payments (name, recurrence_type, due_date, default_amount, currency, status)
           values ('C2 Eylül Tekil Ödeme', 'one_off', '2099-09-12', 3500, 'TRY', 'active')
           returning id`,
        )
      ).rows[0].id;

      const sepPiId = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (payment_id, instance_month, due_date, amount, amount_status, currency, status, direction)
           values ($1, '2099-09-01', '2099-09-12', 3500, 'known', 'TRY', 'unpaid', 'outflow')
           returning id`,
          [sepPayId],
        )
      ).rows[0].id;

      const sepAllocId = (
        await c.query<{ id: string }>(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount, allocated_on)
           values ($1, 'payment_instances', $2, 1000, '2099-09-14')
           returning id`,
          [sepInvoiceId, sepPiId],
        )
      ).rows[0].id;

      const sepLineId = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_lines
             (cashflow_month_id, line_type, direction, label, amount, amount_status)
           values ($1, 'vendor_payment', 'outflow', 'C2 Eylül Satır', 3000, 'known')
           returning id`,
          [sepMonthId],
        )
      ).rows[0].id;

      const sepCheckId = (
        await c.query<{ id: string }>(
          `insert into public.checks
             (direction, amount, signed_amount, currency, maturity_date, status, counterparty_label)
           values ('outflow', 4000, -4000, 'TRY', '2099-09-18', 'planned', 'C2 Eylül Çek')
           returning id`,
        )
      ).rows[0].id;

      const sepLoanInstId = (
        await c.query<{ id: string }>(
          `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
           values ($1, 2, '2099-09-22', 6000, 'planned')
           returning id`,
          [loanId],
        )
      ).rows[0].id;

      const sepBankTxId = (
        await c.query<{ id: string }>(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
           values ($1, '2099-09-15', -3500, 'TRY', 'unmatched', 'C2 Eylül Hareket', 'c2-sep-btx-1')
           returning id`,
          [cashAccId],
        )
      ).rows[0].id;

      // 2) ŞİMDİ 2099-08 dönemini kilitle!
      await c.query(`update public.cashflow_months set status = 'locked' where id = $1`, [augMonthId]);

      // ── A) Kilitli aya INSERT denemeleri (8 tablonun tamamı P0001 / period_locked) ──
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.invoices
             (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
           values ($1, 'purchase', '2099-08-11', '2099-09-11', 900, 900, 'TRY', 'open', 'C2-BLOCKED-INV')`,
          [partyId],
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount, allocated_on)
           values ($1, 'payment_instances', $2, 500, '2099-08-25')`,
          [sepInvoiceId, sepPiId],
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.payments (name, recurrence_type, due_date, default_amount, currency, status)
           values ('C2 Engellenen Ödeme', 'one_off', '2099-08-19', 800, 'TRY', 'active')`,
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.payment_instances
             (instance_month, due_date, amount, amount_status, currency, status, direction)
           values ('2099-08-01', '2099-08-19', 800, 'known', 'TRY', 'unpaid', 'outflow')`,
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.cashflow_lines
             (cashflow_month_id, line_type, direction, label, amount, amount_status)
           values ($1, 'vendor_payment', 'outflow', 'C2 Engellenen Satır', 500, 'known')`,
          [augMonthId],
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.checks
             (direction, amount, signed_amount, currency, maturity_date, status, counterparty_label)
           values ('outflow', 1500, -1500, 'TRY', '2099-08-27', 'planned', 'C2 Engellenen Çek')`,
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
           values ($1, 3, '2099-08-28', 6000, 'planned')`,
          [loanId],
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
           values ($1, '2099-08-28', -1200, 'TRY', 'unmatched', 'C2 Engellenen Hareket', 'c2-aug-btx-blocked')`,
          [cashAccId],
        ),
      );

      // ── B) Kilitli aydaki satırları UPDATE (ve kilitli aydan açık aya tarih kaçırma: OLD kilitli!) ──
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.invoices set notes = 'değiştirildi' where id = $1`, [augInvoiceId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.invoice_allocations set allocated_on = '2099-09-14' where id = $1`, [augAllocId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.payments set due_date = '2099-09-12' where id = $1`, [augPayId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(
          `update public.payment_instances set due_date = '2099-09-12', instance_month = '2099-09-01' where id = $1`,
          [augPiId],
        ),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.cashflow_lines set cashflow_month_id = $2 where id = $1`, [augLineId, sepMonthId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.checks set maturity_date = '2099-09-18' where id = $1`, [augCheckId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.loan_installments set due_date = '2099-09-22' where id = $1`, [augLoanInstId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.bank_transactions set txn_date = '2099-09-15' where id = $1`, [augBankTxId]),
      );

      // ── C) Açık aydaki satırların tarihini kilitli aya kaydırma (NEW kilitli!) ──
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.invoices set due_date = '2099-08-29' where id = $1`, [sepInvoiceId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.invoice_allocations set allocated_on = '2099-08-25' where id = $1`, [sepAllocId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.payments set due_date = '2099-08-25' where id = $1`, [sepPayId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.payment_instances set due_date = '2099-08-25' where id = $1`, [sepPiId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.cashflow_lines set cashflow_month_id = $2 where id = $1`, [sepLineId, augMonthId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.checks set maturity_date = '2099-08-25' where id = $1`, [sepCheckId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.loan_installments set due_date = '2099-08-25' where id = $1`, [sepLoanInstId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.bank_transactions set txn_date = '2099-08-25' where id = $1`, [sepBankTxId]),
      );

      // ── D) Kilitli aydaki satırları DELETE denemeleri (8 tablonun tamamı P0001) ──
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.invoice_allocations where id = $1`, [augAllocId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.invoices where id = $1`, [augInvoiceId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.payment_instances where id = $1`, [augPiId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.payments where id = $1`, [augPayId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.cashflow_lines where id = $1`, [augLineId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.checks where id = $1`, [augCheckId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.loan_installments where id = $1`, [augLoanInstId]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.bank_transactions where id = $1`, [augBankTxId]),
      );

      // ── E) Açık ayda (2099-09) normal yazma VE geçmişte kilitlenmiş faturaya açık ayda tahsilat dağıtımı ÇALIŞIR! ──
      await c.query(`update public.cashflow_lines set amount = 3250 where id = $1`, [sepLineId]);

      // Kilitli Ağustos faturasının kalan 4.000 TL bakiyesi açık Eylül ayında ödenebilir (pg_trigger_depth() > 1)
      await c.query(
        `insert into public.invoice_allocations
           (invoice_id, source_table, source_id, allocated_amount, allocated_on)
         values ($1, 'payment_instances', $2, 1500, '2099-09-16')`,
        [augInvoiceId, sepPiId],
      );
      const afterAlloc = await c.query<{ allocated_amount: string }>(
        `select allocated_amount::text from public.invoices where id = $1`,
        [augInvoiceId],
      );
      expect(Number(afterAlloc.rows[0].allocated_amount)).toBe(2500);
    });
  });

  it("rol ve geçiş bekçisi: finance_operator dönem kilitleyemez veya kilit açamaz (42501); gerekçesiz veya draft'a reopen 23514 ile reddedilir", async () => {
    await inRollback(pool, async (c) => {
      const mOpen = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2099-10-01', 10000, 5000, 2000, 3000, 13000, 'reviewed')
           returning id`,
        )
      ).rows[0].id;

      const mLocked = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2099-11-01', 13000, 4000, 1000, 3000, 16000, 'locked')
           returning id`,
        )
      ).rows[0].id;

      // 1) mas_radar_finance_operator rolü ne dönem kilitleyebilir ne de kilit açabilir
      await expectPgError(c, "42501", /period_lock_requires_manager/, async () => {
        await c.query(`set local role mas_radar_finance_operator`);
        await c.query(`update public.cashflow_months set status = 'locked' where id = $1`, [mOpen]);
      });

      await expectPgError(c, "42501", /period_lock_requires_manager/, async () => {
        await c.query(`set local role mas_radar_finance_operator`);
        await c.query(
          `update public.cashflow_months set status = 'reviewed', reopen_reason = 'Operatör yetkisiz kilit açma denemesi' where id = $1`,
          [mLocked],
        );
      });

      // 2) Yönetici rolünde dahi kilitli dönem 'draft' statüsüne açılamaz (yalnız 'reviewed')
      await expectPgError(c, "23514", /period_reopen_target_invalid/, () =>
        c.query(
          `update public.cashflow_months set status = 'draft', reopen_reason = 'Geçerli uzunlukta bir gerekçe' where id = $1`,
          [mLocked],
        ),
      );

      // 3) Yönetici rolünde dahi < 10 karakter gerekçeyle kilit açılamaz
      await expectPgError(c, "23514", /period_reopen_reason_required/, () =>
        c.query(`update public.cashflow_months set status = 'reviewed', reopen_reason = 'kısa' where id = $1`, [
          mLocked,
        ]),
      );

      // 4) Kilitli dönemde başlık rakamları değiştirilemez ve dönem silinemez
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`update public.cashflow_months set closing_balance = 999999 where id = $1`, [mLocked]),
      );
      await expectPgError(c, "P0001", /period_locked/, () =>
        c.query(`delete from public.cashflow_months where id = $1`, [mLocked]),
      );
    });
  });

  it("evaluatePeriodCloseReadiness, lockCashflowPeriod, reopenCashflowPeriod ve radar bakım işleri tam yaşam döngüsünü ve audit_logs izini doğrular", async () => {
    await inRollback(pool, async (c) => {
      const managerId = (
        await c.query<{ id: string }>(
          `insert into public.users (username, display_name, password_hash, role, is_active)
           values ('c2_mgr_test', 'C2 Finans Yöneticisi', 'not-a-login-hash', 'finance_manager', true)
           returning id`,
        )
      ).rows[0].id;

      const operatorId = (
        await c.query<{ id: string }>(
          `insert into public.users (username, display_name, password_hash, role, is_active)
           values ('c2_op_test', 'C2 Operatör', 'not-a-login-hash', 'finance_operator', true)
           returning id`,
        )
      ).rows[0].id;

      const partyId = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C2 Kapanış Cari', 'c2 kapanis cari', 'vendor')
           returning id`,
        )
      ).rows[0].id;

      const cashAccId = (
        await c.query<{ id: string }>(
          `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
           values ('C2 Kapanış Banka', 'bank_account', 'TRY', 50000, true)
           returning id`,
        )
      ).rows[0].id;
      await c.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, available_balance, balance_as_of)
         values ($1, 'C2 Kapanış Bank', 50000, now())`,
        [cashAccId],
      );

      const monthId = (
        await c.query<{ id: string }>(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2099-12-01', 50000, 20000, 10000, 10000, 60000, 'reviewed')
           returning id`,
        )
      ).rows[0].id;

      // Engelleyici 1: taslak fatura; Engelleyici 2: tutarı eksik ödeme; Uyarı 1: eşleşmemiş banka hareketi
      const draftInvId = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
           values ($1, 'purchase', '2099-12-05', '2099-12-20', 4000, 4000, 'TRY', 'draft', 'C2-DEC-DRAFT')
           returning id`,
          [partyId],
        )
      ).rows[0].id;

      const missingPiId = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, amount, amount_status, currency, status, direction)
           values ('2099-12-01', '2099-12-10', null, 'missing', 'TRY', 'unpaid', 'outflow')
           returning id`,
        )
      ).rows[0].id;

      await c.query(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
         values ($1, '2099-12-11', -1500, 'TRY', 'unmatched', 'C2 Eşleşmemiş Hareket', 'c2-dec-btx-1')`,
        [cashAccId],
      );

      const txPool = transactionalClientAsPool(c);

      // 1) Ön-kontrol 2 engelleyici ve 1 uyarı döndürür; lockCashflowPeriod VALIDATION ile reddeder
      const blockedReadiness = await evaluatePeriodCloseReadiness(txPool, monthId);
      expect(blockedReadiness.blockerCount).toBe(2);
      expect(blockedReadiness.warningCount).toBe(1);
      expect(blockedReadiness.readyToLock).toBe(false);

      await expect(
        lockCashflowPeriod(txPool, { monthId }, { id: managerId, role: "finance_manager" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });

      // 2) Engelleyicileri çöz (taslak faturayı onayla, eksik ödeme tutarını gir)
      await c.query(`update public.invoices set status = 'open' where id = $1`, [draftInvId]);
      await c.query(
        `update public.payment_instances set amount = 6000, amount_status = 'known' where id = $1`,
        [missingPiId],
      );

      const cleanReadiness = await evaluatePeriodCloseReadiness(txPool, monthId);
      expect(cleanReadiness.blockerCount).toBe(0);
      expect(cleanReadiness.warningCount).toBe(1);
      expect(cleanReadiness.readyToLock).toBe(true);

      // 3) finance_operator servis katmanında da FORBIDDEN ile reddedilir
      await expect(
        lockCashflowPeriod(txPool, { monthId }, { id: operatorId, role: "finance_operator" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // 4) finance_manager dönemi başarıyla kilitler
      const lockRes = await lockCashflowPeriod(
        txPool,
        { monthId, notes: "Aralık 2099 kapanışı onaylandı" },
        { id: managerId, role: "finance_manager" },
      );
      expect(lockRes.ym).toBe("2099-12");
      expect(lockRes.lockFingerprint).toHaveLength(24);

      // 5) Radar arka plan bakım işleri (generateInstancesForMonthWithClient & refreshRiskFlagsWithClient)
      // kilitli ayı sessizce atlar ve P0001 fırlatmaz!
      await c.query(
        `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, status)
         values ('C2 Aylık Şablon', 'monthly', 15, 2200, 'TRY', 'active')`,
      );
      const genLocked = await generateInstancesForMonthWithClient(c, "2099-12-01", managerId);
      expect(genLocked.created).toBe(0);
      await expect(refreshRiskFlagsWithClient(c, "2099-12-25")).resolves.toBeGreaterThanOrEqual(0);

      // 6) Gerekçeli yeniden açma (reopenCashflowPeriod) + düzeltme + yeniden kilitleme
      const reopenRes = await reopenCashflowPeriod(
        txPool,
        { monthId, reason: "Geç gelen Aralık tedarikçi faturası kaydı için açıldı" },
        { id: managerId, role: "finance_manager" },
      );
      expect(reopenRes.ym).toBe("2099-12");

      // Kilit açıldıktan sonra 2099-12'ye yeni fatura girilebilir
      await c.query(
        `insert into public.invoices
           (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status, invoice_no)
         values ($1, 'purchase', '2099-12-18', '2099-12-28', 2500, 2500, 'TRY', 'open', 'C2-DEC-LATE-INV')`,
        [partyId],
      );

      // Yeniden kilitleme parmak izini günceller
      const relockRes = await lockCashflowPeriod(
        txPool,
        { monthId, notes: "Düzeltme sonrası yeniden kilitlendi" },
        { id: managerId, role: "finance_manager" },
      );
      expect(relockRes.lockFingerprint).not.toBe(lockRes.lockFingerprint);

      // 7) audit_logs tam iz doğrulaması (2 lock_cashflow_period + 1 reopen_cashflow_period)
      const audits = await c.query<{ action: string; after_data: Record<string, unknown> }>(
        `select action, after_data
           from public.audit_logs
          where entity_table = 'cashflow_months'
            and entity_id = $1::uuid
          order by ctid asc`,
        [monthId],
      );
      expect(audits.rows.map((r) => r.action)).toEqual([
        "lock_cashflow_period",
        "reopen_cashflow_period",
        "lock_cashflow_period",
      ]);
      expect(audits.rows[1].after_data.reopenReason).toBe(
        "Geç gelen Aralık tedarikçi faturası kaydı için açıldı",
      );
    });
  });
});

