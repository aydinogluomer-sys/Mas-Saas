// Faz 44 (C1) — Görünüm matematiği (0099), FIN-03 bilinmeyen açılış bakiyesi yayılımı,
// kredi taksit statü/döviz ayrımı, fatura-çek/ödeme çift sayım engeli, yıllık bütçe 12-ay
// dağılımı, cari hesap defteri işaretleri ve çapraz-döviz fatura tahsisi reddi testleri.
//
// Güvenlik kuralı: Gerçek veritabanına (mas_radar_dev) ASLA bağlanmaz. Canlı PostgreSQL
// doğrulamaları yalnız tek kullanımlık (disposable) veritabanı hedeflendiğinde ve her test
// kendi BEGIN ... ROLLBACK bloğu içinde izole edilerek çalışır.

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { DomainError } from "@/lib/domain-error";
import { allocateBankTransaction, allocateCollection } from "@/lib/receivables/engine";
import {
  loadCashPositions,
  loadLiquidityGap,
  loadLiquidityHorizons,
  loadPositionSummary,
  loadReconciliation,
} from "@/lib/treasury/engine";
import {
  RECONCILIATION_LABEL,
  liquidityHorizons,
  reconciliationVerdict,
} from "@/lib/treasury/rules";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

function openDisposablePool(): Pool {
  const { url } = assertDisposableTargetDb(undefined, "tests/financial/view-math-and-fin03.test.ts");
  return new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
}

async function inRollback<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

function clientAsPool(client: PoolClient): Pool {
  return {
    query: client.query.bind(client),
    connect: async () =>
      new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "release") return () => {};
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        },
      }),
  } as unknown as Pool;
}

describe("Faz 44 (C1) — Saf TypeScript ve Mock-Pool FIN-03 / Çapraz-Döviz / 0099 Kuralları", () => {
  it("tek kullanımlık DB zorunlu tutulduğunda (MAS_REQUIRE_DISPOSABLE_DB_TEST=1) hedef DB gerçekten disposable olmalıdır", () => {
    if (requireDisposableDb) {
      expect(hasDisposableDb).toBe(true);
    }
  });

  it("0099 migration dosyası security_invoker=true, sıfır float8 ve çapraz-döviz 23514 tetikleyicisini eksiksiz içerir", () => {
    const fileSet = validateFileSet(MIGRATIONS_DIR);
    expect(fileSet.errors).toEqual([]);
    const m0099 = fileSet.files.find((f) => f.version === "0099");
    expect(m0099).toBeDefined();
    const sql = m0099!.content
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--.*$/gm, " ");

    expect(sql).not.toMatch(/\bfloat8\b|\bdouble\s+precision\b/i);
    expect(sql).toMatch(/cross_currency_allocation_forbidden/i);
    expect(sql).toMatch(/errcode\s*=\s*'23514'/i);
    expect(sql).toMatch(/incomplete_opening_balance/i);
    expect(sql).toMatch(/unknown_opening_balance/i);
  });

  it("FIN-03: liquidityHorizons açılış bakiyesi null iken uydurma sayı üretmez, akışları korur ve projeksiyonları null döndürür", () => {
    const res = liquidityHorizons({
      openingPosition: null,
      todayISO: "2026-11-01",
      minCashFloor: 50_000,
      flows: [
        { flowDate: "2026-11-03", amountSigned: -12_000, certainty: "contracted" },
        { flowDate: "2026-11-05", amountSigned: 20_000, certainty: "expected" },
      ],
    });

    expect(res).toHaveLength(3);
    expect(res[0]).toEqual({
      horizonDays: 7,
      fromDate: "2026-11-01",
      toDate: "2026-11-08",
      flowCount: 2,
      openingPosition: null,
      contractedNet: -12_000,
      expectedNet: 8_000,
      projectedContracted: null,
      minIntraHorizonBalance: null,
      worstDayISO: null,
      projectedExpected: null,
      minCashFloor: 50_000,
      financingNeed: null,
      breachesFloor: null,
      status: "unknown_opening_balance",
    });
  });

  it("FIN-03: reconciliationVerdict açılış bakiyesi bilinmiyorken sahte 'divergent' yerine 'incomplete_opening_balance' döndürür", () => {
    const verdict = reconciliationVerdict(250_000, null, false);
    expect(verdict).toEqual({
      status: "incomplete_opening_balance",
      difference: null,
    });
    expect(RECONCILIATION_LABEL.incomplete_opening_balance).toContain("açılış bakiyesi eksik");
  });

  it("allocateCollection ve allocateBankTransaction farklı para birimli tahsisi DomainError('VALIDATION') ile reddeder", async () => {
    let rolledBack = false;
    const mockClient = {
      query: async (sql: string) => {
        const lower = sql.toLowerCase();
        if (lower === "begin") return { rows: [], rowCount: 0 };
        if (lower === "rollback") {
          rolledBack = true;
          return { rows: [], rowCount: 0 };
        }
        if (lower.includes("from public.invoices")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                status: "open",
                gross_amount: "10000.00",
                allocated_amount: "0.00",
                currency: "TRY",
              },
            ],
          };
        }
        if (lower.includes("from public.bank_transactions")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                amount: "500.00",
                status: "unmatched",
                currency: "USD",
              },
            ],
          };
        }
        throw new Error(`Beklenmeyen SQL: ${sql}`);
      },
      release: () => {},
    };
    const mockPool = {
      connect: async () => mockClient,
    } as unknown as Pool;

    await expect(
      allocateCollection(
        mockPool,
        {
          invoiceId: "11111111-1111-4111-8111-111111111111",
          sourceTable: "bank_transactions",
          sourceId: "22222222-2222-4222-8222-222222222222",
          amount: 500,
        },
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Farklı para birimleri arasında kur çevrimsiz doğrudan tahsis yapılamaz.",
    });
    expect(rolledBack).toBe(true);

    rolledBack = false;
    await expect(
      allocateBankTransaction(
        mockPool,
        {
          transactionId: "22222222-2222-4222-8222-222222222222",
          lines: [{ invoiceId: "11111111-1111-4111-8111-111111111111", amount: 500 }],
        },
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toBeInstanceOf(DomainError);
    expect(rolledBack).toBe(true);
  });
});

describe.runIf(hasDisposableDb)("Faz 44 (C1) — Canlı Disposable PostgreSQL 0099 Görünüm & Kısıt Doğrulaması", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = openDisposablePool();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("48 'planned' ve 'late'/'partial' kredi taksiti tüm vade, likidite, takvim ve öncelik görünümlerinde görünür", async () => {
    await inRollback(pool, async (c) => {
      // Test izolasyonu: yalnız bu rollback içinde kredi ve çek tablolarını sıfır noktasından kur.
      const loanRes = await c.query<{ id: string }>(
        `insert into public.loans (name, principal, currency, status)
         values ('C1-48-Taksit-TRY', 480000, 'TRY', 'active')
         returning id`,
      );
      const loanId = loanRes.rows[0].id;

      // 48 adet 'planned' taksit: ilk 12'si önümüzdeki 1..12 gün içinde (0-30 gün kovası),
      // kalan 36'sı 31..330 gün aralığında.
      for (let idx = 1; idx <= 48; idx += 1) {
        const dayOffset = idx <= 12 ? idx : 30 + (idx - 12) * 8;
        await c.query(
          `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
           values ($1, $2, current_date + $3::int, 10000, 'planned')`,
          [loanId, idx, dayOffset],
        );
      }

      // Ek olarak 1 'late' (15.000 TL) ve 1 'partial' (20.000 TL tutar, 5.000 TL ödenmiş -> 15.000 TL kalan)
      await c.query(
        `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
         values ($1, 49, current_date + 2, 15000, 'late')`,
        [loanId],
      );
      await c.query(
        `insert into public.loan_installments (loan_id, installment_no, due_date, amount, paid_amount, paid_at, status)
         values ($1, 50, current_date + 3, 20000, 5000, now(), 'partial')`,
        [loanId],
      );

      // 1) debt_maturity_ladder_by_currency: 4 kovada toplam 50 TRY taksit (48*10.000 + 15.000 + 15.000 = 510.000)
      const ladderByCur = await c.query<{ total_count: string; total_due: string }>(
        `select coalesce(sum(installment_count), 0)::text as total_count,
                coalesce(sum(installment_due), 0)::text as total_due
           from public.debt_maturity_ladder_by_currency
          where currency = 'TRY'`,
      );
      expect(Number(ladderByCur.rows[0].total_count)).toBeGreaterThanOrEqual(50);
      expect(Number(ladderByCur.rows[0].total_due)).toBeGreaterThanOrEqual(510_000);

      // 2) liquidity_forecast_daily: bu krediye ait 50 taksitin tamamı negatif sözleşmeli akış olarak görünür
      const forecastRows = await c.query<{ n: string; total_signed: string }>(
        `select count(*)::text as n, coalesce(sum(amount_signed), 0)::text as total_signed
           from public.liquidity_forecast_daily
          where source_kind = 'loan_installment'
            and source_id in (select id from public.loan_installments where loan_id = $1)`,
        [loanId],
      );
      expect(Number(forecastRows.rows[0].n)).toBe(50);
      expect(Number(forecastRows.rows[0].total_signed)).toBe(-510_000);

      // 3) financial_calendar ve payment_priority_queue da 50 taksitin tamamını içerir
      const calCount = await c.query<{ n: string }>(
        `select count(*)::text as n
           from public.financial_calendar
          where source_kind = 'loan_installment'
            and source_id in (select id from public.loan_installments where loan_id = $1)`,
        [loanId],
      );
      expect(Number(calCount.rows[0].n)).toBe(50);

      const queueCount = await c.query<{ n: string }>(
        `select count(*)::text as n
           from public.payment_priority_queue
          where kind = 'loan_installment'
            and entity_id in (select id from public.loan_installments where loan_id = $1)`,
        [loanId],
      );
      expect(Number(queueCount.rows[0].n)).toBe(50);
    });
  });

  it("100.000 USD çek ve USD kredi taksiti TRY likidite açığına ve TRY vade merdivenine ASLA karışmaz; currency IS NULL ödemeler ayrı sayılır", async () => {
    await inRollback(pool, async (c) => {
      // Başlangıç TRY 7-gün sözleşmeli akışını ölç
      const beforeTry = await c.query<{ contracted_net_flow: string; unknown_currency_count: string }>(
        `select contracted_net_flow::text, unknown_currency_count::text
           from public.treasury_liquidity_gap
          where currency = 'TRY' and horizon_days = 7`,
      );
      const baseTryFlow7 = Number(beforeTry.rows[0]?.contracted_net_flow ?? 0);
      const baseUnknown7 = Number(beforeTry.rows[0]?.unknown_currency_count ?? 0);

      const beforeLadderTry = await c.query<{ installment_due: string; foreign_installment_count: string }>(
        `select installment_due::text, foreign_installment_count::text
           from public.debt_maturity_ladder
          where sort_order = 1`,
      );
      const baseTryLadderDue = Number(beforeLadderTry.rows[0].installment_due);
      const baseForeignInstCount = Number(beforeLadderTry.rows[0].foreign_installment_count);

      // 1) 100.000 USD keşide çek (planned, 3 gün vadeli)
      await c.query(
        `insert into public.checks
           (direction, amount, signed_amount, currency, maturity_date, status, counterparty_label)
         values ('outflow', 100000, -100000, 'USD', current_date + 3, 'planned', 'USD Tedarikçi')`,
      );

      // 2) 25.000 USD kredi taksiti (4 gün vadeli, 'planned')
      const usdLoan = await c.query<{ id: string }>(
        `insert into public.loans (name, principal, currency, status)
         values ('C1-USD-Loan', 250000, 'USD', 'active')
         returning id`,
      );
      await c.query(
        `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
         values ($1, 1, current_date + 4, 25000, 'planned')`,
        [usdLoan.rows[0].id],
      );

      // 3) 77.777 EUR ödeme kalemi + payment_instances.currency NOT NULL şema garantisi
      const colCheck = await c.query<{ is_nullable: string }>(
        `select is_nullable
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'payment_instances'
            and column_name = 'currency'`,
      );
      expect(colCheck.rows[0]?.is_nullable).toBe("NO");

      await c.query(
        `insert into public.payment_instances (instance_month, due_date, status, amount, currency, direction)
         values (date_trunc('month', current_date)::date, current_date + 2, 'unpaid', 77777, 'EUR', 'outflow')`,
      );

      // Doğrulama A: TRY 7-gün sözleşmeli nakit akışı kuruşu kuruşuna DEĞİŞMEMİŞ olmalı!
      const afterTry = await c.query<{ contracted_net_flow: string; unknown_currency_count: string }>(
        `select contracted_net_flow::text, unknown_currency_count::text
           from public.treasury_liquidity_gap
          where currency = 'TRY' and horizon_days = 7`,
      );
      expect(Number(afterTry.rows[0].contracted_net_flow)).toBe(baseTryFlow7);
      expect(Number(afterTry.rows[0].unknown_currency_count)).toBe(baseUnknown7);

      // Doğrulama A2: EUR kendi 7-gün likidite açığı satırında -77.777 EUR olarak izole görünür!
      const afterEur = await c.query<{ contracted_net_flow: string }>(
        `select contracted_net_flow::text
           from public.treasury_liquidity_gap
          where currency = 'EUR' and horizon_days = 7`,
      );
      expect(afterEur.rowCount).toBe(1);
      expect(Number(afterEur.rows[0].contracted_net_flow)).toBe(-77_777);

      // Doğrulama B: USD kendi 7-gün likidite açığı satırında -125.000 USD olarak görünür!
      const afterUsd = await c.query<{ contracted_net_flow: string }>(
        `select contracted_net_flow::text
           from public.treasury_liquidity_gap
          where currency = 'USD' and horizon_days = 7`,
      );
      expect(afterUsd.rowCount).toBe(1);
      expect(Number(afterUsd.rows[0].contracted_net_flow)).toBe(-125_000);

      // Doğrulama C: TRY debt_maturity_ladder tutarı değişmez, foreign_installment_count +1 artar;
      // USD debt_maturity_ladder_by_currency ise 25.000 USD gösterir.
      const afterLadderTry = await c.query<{ installment_due: string; foreign_installment_count: string }>(
        `select installment_due::text, foreign_installment_count::text
           from public.debt_maturity_ladder
          where sort_order = 1`,
      );
      expect(Number(afterLadderTry.rows[0].installment_due)).toBe(baseTryLadderDue);
      expect(Number(afterLadderTry.rows[0].foreign_installment_count)).toBe(baseForeignInstCount + 1);

      const usdLadder = await c.query<{ installment_due: string; installment_count: string }>(
        `select installment_due::text, installment_count::text
           from public.debt_maturity_ladder_by_currency
          where currency = 'USD' and sort_order = 1`,
      );
      expect(Number(usdLadder.rows[0].installment_due)).toBe(25_000);
      expect(Number(usdLadder.rows[0].installment_count)).toBe(1);
    });
  });

  it("FIN-03: opening_balance IS NULL olan aktif banka hesabında available_now ve likidite projeksiyonu NULL döner; mutabakat 'incomplete_opening_balance' olur", async () => {
    await inRollback(pool, async (c) => {
      // Mevcut tüm kasa hesaplarını bu rollback içinde pasife al ki senaryo tamamen izole olsun
      await c.query(`update public.cash_accounts set is_active = false`);

      const accRes = await c.query<{ id: string }>(
        `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
         values ('C1-FIN03-NullOpening', 'bank_account', 'TRY', null, true)
         returning id`,
      );
      const accId = accRes.rows[0].id;

      await c.query(
        `insert into public.bank_accounts (cash_account_id, bank_name, available_balance, balance_as_of)
         values ($1, 'FIN03 Bank', 125000, now())`,
        [accId],
      );
      await c.query(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
         values ($1, '2099-07-10', 25000, 'TRY', 'unmatched', 'FIN03 hareket', 'c1-fin03-tx-1')`,
        [accId],
      );
      await c.query(
        `insert into public.cashflow_months
           (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance)
         values ('2099-07-01', 100000, 25000, 0, 25000, 125000)`,
      );

      const txPool = clientAsPool(c);

      // 1) bank_cash_position + loadCashPositions
      const positions = await loadCashPositions(txPool);
      expect(positions).toHaveLength(1);
      expect(positions[0].openingKnown).toBe(false);
      expect(positions[0].derivedBalance).toBeNull();
      expect(positions[0].statedMinusDerived).toBeNull();
      expect(positions[0].movementNet).toBe(25_000);

      // 2) treasury_position_summary + loadPositionSummary
      const summaries = await loadPositionSummary(txPool);
      const trySummary = summaries.find((s) => s.currency === "TRY");
      expect(trySummary).toBeDefined();
      expect(trySummary!.unknownOpeningCount).toBe(1);
      expect(trySummary!.availableNow).toBeNull();
      expect(trySummary!.totalDerived).toBeNull();
      expect(trySummary!.movementDelta).toBe(25_000);

      // 3) treasury_liquidity_gap + loadLiquidityGap + loadLiquidityHorizons
      const gaps = (await loadLiquidityGap(txPool)).filter((g) => g.currency === "TRY");
      expect(gaps).toHaveLength(3);
      for (const g of gaps) {
        expect(g.availableNow).toBeNull();
        expect(g.projectedContracted).toBeNull();
        expect(g.projectedExpected).toBeNull();
        expect(g.financingNeed).toBeNull();
        expect(g.breachesFloor).toBeNull();
        expect(g.status).toBe("unknown_opening_balance");
        expect(g.unknownOpeningCount).toBe(1);
        expect(g.movementDelta).toBe(25_000);
      }

      const horizons = await loadLiquidityHorizons(txPool, "2099-07-01", "TRY");
      expect(horizons).toHaveLength(3);
      expect(horizons[0].openingPosition).toBeNull();
      expect(horizons[0].projectedContracted).toBeNull();
      expect(horizons[0].status).toBe("unknown_opening_balance");

      // 4) treasury_cashflow_reconciliation + loadReconciliation: sahte 'divergent' YOK!
      const sqlRecon = await c.query<{ reconciliation_status: string; treasury_closing: string | null; difference: string | null }>(
        `select reconciliation_status, treasury_closing::text, difference::text
           from public.treasury_cashflow_reconciliation
          where month_start = '2099-07-01'`,
      );
      expect(sqlRecon.rows[0].reconciliation_status).toBe("incomplete_opening_balance");
      expect(sqlRecon.rows[0].treasury_closing).toBeNull();
      expect(sqlRecon.rows[0].difference).toBeNull();

      const appRecon = await loadReconciliation(txPool);
      const julyRecon = appRecon.find((r) => r.monthStart === "2099-07-01");
      expect(julyRecon?.status).toBe("incomplete_opening_balance");
      expect(julyRecon?.difference).toBeNull();

      // Pozitif kontrol: opening_balance = 100.000 girildiği anda mutabakat 'aligned' (100.000 + 25.000 = 125.000) olur!
      await c.query(`update public.cash_accounts set opening_balance = 100000 where id = $1`, [accId]);
      const alignedRecon = (await loadReconciliation(txPool)).find((r) => r.monthStart === "2099-07-01");
      expect(alignedRecon?.status).toBe("aligned");
      expect(alignedRecon?.treasuryClosing).toBe(125_000);
      expect(alignedRecon?.difference).toBe(0);
    });
  });

  it("çift sayım engeli: settled_by_check_id veya linked_invoice_id ile bağlı açık fatura likidite ve öncelik kuyruğunda iki kez toplanmaz", async () => {
    await inRollback(pool, async (c) => {
      const party = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C1 Çift Sayım Tedarikçi', 'c1 cift sayim tedarikci', 'vendor')
           returning id`,
        )
      ).rows[0].id;

      // 1) Çekle kapatılmak üzere bağlanmış 40.000 TL alış faturası
      const checkId = (
        await c.query<{ id: string }>(
          `insert into public.checks
             (direction, amount, signed_amount, currency, maturity_date, status, payee_party_id)
           values ('outflow', 40000, -40000, 'TRY', current_date + 5, 'planned', $1)
           returning id`,
          [party],
        )
      ).rows[0].id;

      const invByCheck = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (direction, invoice_no, party_id, issue_date, due_date, currency,
              net_amount, tax_amount, gross_amount, settled_by_check_id)
           values ('purchase', 'C1-INV-CHK', $1, current_date, current_date + 5, 'TRY',
                   40000, 0, 40000, $2)
           returning id`,
          [party, checkId],
        )
      ).rows[0].id;
      await c.query(`update public.invoices set status = 'open' where id = $1`, [invByCheck]);

      // 2) payment_instances.linked_invoice_id ile bağlanmış 30.000 TL alış faturası
      const invByPi = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (direction, invoice_no, party_id, issue_date, due_date, currency,
              net_amount, tax_amount, gross_amount)
           values ('purchase', 'C1-INV-PI', $1, current_date, current_date + 6, 'TRY',
                   30000, 0, 30000)
           returning id`,
          [party],
        )
      ).rows[0].id;
      await c.query(`update public.invoices set status = 'open' where id = $1`, [invByPi]);

      const piId = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, status, amount, currency, direction, linked_invoice_id)
           values (date_trunc('month', current_date)::date, current_date + 6, 'unpaid', 30000, 'TRY', 'outflow', $1)
           returning id`,
          [invByPi],
        )
      ).rows[0].id;

      // Doğrulama: liquidity_forecast_daily içinde çek (-40.000) ve ödeme kalemi (-30.000) VARDIR,
      // ama bağlı faturalar (invByCheck, invByPi) ayrıca YER ALMAZ!
      const lf = await c.query<{ source_kind: string; source_id: string; amount_signed: string }>(
        `select source_kind, source_id::text, amount_signed::text
           from public.liquidity_forecast_daily
          where source_id = any($1::uuid[])`,
        [[checkId, invByCheck, piId, invByPi]],
      );
      expect(lf.rows.map((r) => r.source_id).sort()).toEqual([checkId, piId].sort());

      const pq = await c.query<{ entity_id: string }>(
        `select entity_id::text
           from public.payment_priority_queue
          where entity_id = any($1::uuid[])`,
        [[checkId, invByCheck, piId, invByPi]],
      );
      expect(pq.rows.map((r) => r.entity_id).sort()).toEqual([checkId, piId].sort());
    });
  });

  it("yıllık (period_kind = 'annual') bütçe 12 aya kuruş farkı kaybolmadan dağılır ve çoklu faturalarda fan-out üretmez", async () => {
    await inRollback(pool, async (c) => {
      const actorId = (
        await c.query<{ id: string }>(
          `insert into public.users (username, password_hash, display_name, role)
           values ('c1_budget_mgr', 'x', 'C1 Budget Manager', 'finance_manager')
           returning id`,
        )
      ).rows[0].id;

      const partyId = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C1 Bütçe Tedarikçi', 'c1 butce tedarikci', 'vendor')
           returning id`,
        )
      ).rows[0].id;

      const ccId = (
        await c.query<{ id: string }>(
          `insert into public.cost_centers (code, name)
           values ('C1-CC-ANNUAL', 'C1 Yıllık Masraf Merkezi')
           returning id`,
        )
      ).rows[0].id;

      const budgetId = (
        await c.query<{ id: string }>(
          `insert into public.budgets (name, fiscal_year, period_kind, currency)
           values ('C1 2098 Yıllık Bütçe', 2098, 'annual', 'TRY')
           returning id`,
        )
      ).rows[0].id;

      // 100.000,00 TL yıllık bütçe: 11 ay * 8.333,33 + Aralık 8.333,37 = tam 100.000,00 TL!
      await c.query(
        `insert into public.budget_lines
           (budget_id, period_start, direction, cost_center_id, currency, amount,
            version_status, approved_at, approved_by)
         values ($1, '2098-01-01', 'expense', $2, 'TRY', 100000.00, 'approved', now(), $3)`,
        [budgetId, ccId, actorId],
      );

      // Ocak 2098 içinde aynı masraf merkezine 2 ayrı alış faturası (3.000 + 6.000 = 9.000 TL)
      for (const [idx, amt] of [
        [1, 3000],
        [2, 6000],
      ] as const) {
        const invId = (
          await c.query<{ id: string }>(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, due_date, currency,
                cost_center_id, net_amount, tax_amount, gross_amount)
             values ('purchase', $1, $2, '2098-01-15', '2098-02-15', 'TRY', $3, $4, 0, $4)
             returning id`,
            [`C1-2098-INV-${idx}`, partyId, ccId, amt],
          )
        ).rows[0].id;
        await c.query(`update public.invoices set status = 'open' where id = $1`, [invId]);
      }

      const rows = await c.query<{
        period_start: string;
        budget_amount: string;
        actual_amount: string | null;
        variance_verdict: string;
      }>(
        `select to_char(period_start, 'YYYY-MM-DD') as period_start,
                budget_amount::text,
                actual_amount::text,
                variance_verdict
           from public.budget_vs_actual
          where budget_id = $1
          order by period_start`,
        [budgetId],
      );

      expect(rows.rows).toHaveLength(12);
      expect(Number(rows.rows[0].budget_amount)).toBe(8333.33);
      expect(Number(rows.rows[11].budget_amount)).toBe(8333.37);
      expect(Number(rows.rows[0].actual_amount)).toBe(9000);
      expect(rows.rows[0].variance_verdict).toBe("over_budget");

      const summary = await c.query<{ line_count: string; budget_total: string; actual_total: string }>(
        `select line_count::text, budget_total::text, actual_total::text
           from public.budget_variance_summary
          where budget_id = $1`,
        [budgetId],
      );
      expect(Number(summary.rows[0].line_count)).toBe(12);
      expect(Number(summary.rows[0].budget_total)).toBe(100_000);
      expect(Number(summary.rows[0].actual_total)).toBe(9_000);
    });
  });

  it("current_account_ledger satış (+borç / tahsilat +alacak) ve alış (+alacak / ödeme +borç) işaretlerini ve döviz bazlı running_balance değerini doğru üretir", async () => {
    await inRollback(pool, async (c) => {
      const partyId = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C1 Cari Muhasebe', 'c1 cari muhasebe', 'customer')
           returning id`,
        )
      ).rows[0].id;

      // Satış faturası: 10.000 TRY (+borç -> running_balance = +10.000), 4.000 TRY tahsilat (+alacak -> +6.000)
      const saleInv = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (direction, invoice_no, party_id, issue_date, currency, net_amount, tax_amount, gross_amount)
           values ('sales', 'C1-SALE-1', $1, '2098-03-01', 'TRY', 10000, 0, 10000)
           returning id`,
          [partyId],
        )
      ).rows[0].id;
      await c.query(`update public.invoices set status = 'open' where id = $1`, [saleInv]);
      await c.query(
        `insert into public.invoice_allocations (invoice_id, source_table, allocated_amount, allocated_on)
         values ($1, 'manual', 4000, '2098-03-05')`,
        [saleInv],
      );

      // Alış faturası (USD): 2.000 USD (+alacak -> running_balance = -2.000 USD), 500 USD ödeme (+borç -> -1.500 USD)
      const purInv = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (direction, invoice_no, party_id, issue_date, currency, net_amount, tax_amount, gross_amount)
           values ('purchase', 'C1-PUR-USD-1', $1, '2098-03-02', 'USD', 2000, 0, 2000)
           returning id`,
          [partyId],
        )
      ).rows[0].id;
      await c.query(`update public.invoices set status = 'open' where id = $1`, [purInv]);
      await c.query(
        `insert into public.invoice_allocations (invoice_id, source_table, allocated_amount, allocated_on)
         values ($1, 'manual', 500, '2098-03-06')`,
        [purInv],
      );

      const ledger = await c.query<{
        currency: string;
        movement_type: string;
        debit_amount: string;
        credit_amount: string;
        running_balance: string;
      }>(
        `select currency, movement_type, debit_amount::text, credit_amount::text, running_balance::text
           from public.current_account_ledger
          where party_id = $1
          order by currency, movement_date, movement_type`,
        [partyId],
      );

      const tryRows = ledger.rows.filter((r) => r.currency === "TRY");
      const usdRows = ledger.rows.filter((r) => r.currency === "USD");

      expect(tryRows).toHaveLength(2);
      expect(Number(tryRows[0].debit_amount)).toBe(10_000);
      expect(Number(tryRows[0].credit_amount)).toBe(0);
      expect(Number(tryRows[0].running_balance)).toBe(10_000);
      expect(Number(tryRows[1].debit_amount)).toBe(0);
      expect(Number(tryRows[1].credit_amount)).toBe(4_000);
      expect(Number(tryRows[1].running_balance)).toBe(6_000);

      expect(usdRows).toHaveLength(2);
      expect(Number(usdRows[0].debit_amount)).toBe(0);
      expect(Number(usdRows[0].credit_amount)).toBe(2_000);
      expect(Number(usdRows[0].running_balance)).toBe(-2_000);
      expect(Number(usdRows[1].debit_amount)).toBe(500);
      expect(Number(usdRows[1].credit_amount)).toBe(0);
      expect(Number(usdRows[1].running_balance)).toBe(-1_500);
    });
  });

  it("control_large_payments & control_approval_bypass yabancı para ödemeleri TCMB kuruyla TL eşiğine çevirir ve kur yoksa needs_fx_review=true işaretler", async () => {
    await inRollback(pool, async (c) => {
      await c.query(
        `insert into public.fx_rate_snapshots (base_currency, quote_currency, rate_date, rate, source)
         values ('USD', 'TRY', '2098-05-01', 35.0, 'tcmb')`,
      );

      // 4.000 USD * 35 = 140.000 TL >= 100.000 TL eşiği -> yakalanmalı!
      const usdLargePi = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, status, amount, paid_amount, paid_at, currency, direction)
           values ('2098-05-01', '2098-05-10', 'paid', 4000, 4000, now(), 'USD', 'outflow')
           returning id`,
        )
      ).rows[0].id;

      // 1.000 USD * 35 = 35.000 TL < 100.000 TL -> yakalanmamalı!
      const usdSmallPi = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, status, amount, currency, direction)
           values ('2098-05-01', '2098-05-10', 'unpaid', 1000, 'USD', 'outflow')
           returning id`,
        )
      ).rows[0].id;

      // Kuru hiç girilmemiş GBP ödeme -> needs_fx_review = true olarak bayraklanmalı!
      const gbpNoRatePi = (
        await c.query<{ id: string }>(
          `insert into public.payment_instances
             (instance_month, due_date, status, amount, currency, direction)
           values ('2098-05-01', '2098-05-10', 'unpaid', 2500, 'GBP', 'outflow')
           returning id`,
        )
      ).rows[0].id;

      const largeRows = await c.query<{
        payment_instance_id: string;
        try_equivalent: string | null;
        needs_fx_review: boolean;
      }>(
        `select payment_instance_id::text, try_equivalent::text, needs_fx_review
           from public.control_large_payments
          where payment_instance_id = any($1::uuid[])`,
        [[usdLargePi, usdSmallPi, gbpNoRatePi]],
      );

      const largeUsd = largeRows.rows.find((r) => r.payment_instance_id === usdLargePi);
      const smallUsd = largeRows.rows.find((r) => r.payment_instance_id === usdSmallPi);
      const noRateGbp = largeRows.rows.find((r) => r.payment_instance_id === gbpNoRatePi);

      expect(largeUsd).toBeDefined();
      expect(Number(largeUsd!.try_equivalent)).toBe(140_000);
      expect(largeUsd!.needs_fx_review).toBe(false);
      expect(smallUsd).toBeUndefined();
      expect(noRateGbp).toBeDefined();
      expect(noRateGbp!.try_equivalent).toBeNull();
      expect(noRateGbp!.needs_fx_review).toBe(true);

      const bypass = await c.query<{ payment_instance_id: string; try_equivalent: string }>(
        `select payment_instance_id::text, try_equivalent::text
           from public.control_approval_bypass
          where payment_instance_id = $1`,
        [usdLargePi],
      );
      expect(bypass.rowCount).toBe(1);
      expect(Number(bypass.rows[0].try_equivalent)).toBe(140_000);
    });
  });

  it("USD banka hareketini TRY faturasına tahsis etme girişimi PostgreSQL tetikleyicisi tarafından ERRCODE 23514 ile reddedilir", async () => {
    await inRollback(pool, async (c) => {
      const partyId = (
        await c.query<{ id: string }>(
          `insert into public.parties (name, normalized_name, party_type)
           values ('C1 Cross Currency Müşteri', 'c1 cross currency musteri', 'customer')
           returning id`,
        )
      ).rows[0].id;

      const tryInv = (
        await c.query<{ id: string }>(
          `insert into public.invoices
             (direction, invoice_no, party_id, issue_date, currency, net_amount, tax_amount, gross_amount)
           values ('sales', 'C1-TRY-INV', $1, '2098-06-01', 'TRY', 10000, 0, 10000)
           returning id`,
          [partyId],
        )
      ).rows[0].id;
      await c.query(`update public.invoices set status = 'open' where id = $1`, [tryInv]);

      const usdCashAcc = (
        await c.query<{ id: string }>(
          `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
           values ('C1-USD-Bank', 'bank_account', 'USD', 0, true)
           returning id`,
        )
      ).rows[0].id;
      await c.query(
        `insert into public.bank_accounts (cash_account_id, bank_name)
         values ($1, 'C1 FX Bank')`,
        [usdCashAcc],
      );
      const usdTxId = (
        await c.query<{ id: string }>(
          `insert into public.bank_transactions
             (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
           values ($1, '2098-06-02', 500, 'USD', 'unmatched', 'USD tahsilat', 'c1-cross-cur-tx')
           returning id`,
          [usdCashAcc],
        )
      ).rows[0].id;

      await c.query("savepoint cross_cur_probe");
      let pgErr: { code?: string; message?: string } | null = null;
      try {
        await c.query(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount)
           values ($1, 'bank_transactions', $2, 500)`,
          [tryInv, usdTxId],
        );
      } catch (err) {
        pgErr = err as { code?: string; message?: string };
        await c.query("rollback to savepoint cross_cur_probe");
      }

      expect(pgErr).not.toBeNull();
      expect(pgErr?.code).toBe("23514");
      expect(pgErr?.message).toMatch(/cross_currency_allocation_forbidden/i);
    });
  });
});
