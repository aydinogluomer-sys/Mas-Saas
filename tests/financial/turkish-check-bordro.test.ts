// Faz 49 (D3) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil,
// Banka Teminat LTV ve Karşılıksız Rücu Riski, `Migration 0102`) birim + canlı tek kullanımlık DB testleri.
//
// Güvenlik kuralı: Gerçek veritabanına (`mas_radar_dev`) ASLA bağlanmaz. Tüm canlı DB testleri
// yalnız `assertDisposableTargetDb` ile doğrulanmış tek kullanımlık veritabanında koşar.

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";
import { decideApproval } from "@/lib/approvals/engine";
import { upsertBankAccount } from "@/lib/bank/engine";
import { createCounterparty } from "@/lib/counterparties/engine";
import { DomainError } from "@/lib/domain-error";
import {
  CHECK_BORDRO_OPERATIONS,
  CHECK_BORDRO_TYPES,
  CHECK_STATUS_LABELS_TR,
  executeCheckBordroTransition,
  loadCheckBordroTargets,
  loadCheckPortfolioSummary,
  loadRecentCheckBordros,
} from "@/lib/financing/check-bordro";
import { markCheckBounced, markCheckCleared } from "@/lib/financing/engine";
import { changeInvoiceStatus, createInvoice } from "@/lib/invoices/engine";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

function openDisposablePool(): Pool {
  const { url } = assertDisposableTargetDb(
    undefined,
    "tests/financial/turkish-check-bordro.test.ts",
  );
  return new Pool({
    connectionString: url,
    max: 4,
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

function transactionalClientAsPool(client: PoolClient): Pool {
  let spSeq = 0;
  const stack: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const proxyClient = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "release") {
        return () => {};
      }
      if (prop === "query") {
        return (sql: unknown, params?: unknown) =>
          enqueue(async () => {
            if (typeof sql === "string") {
              const norm = sql.trim().toLowerCase();
              if (norm === "begin") {
                const sp = `sp_d3_${++spSeq}`;
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
          });
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  return {
    connect: async () => proxyClient,
    query: (sql: string, params?: unknown[]) =>
      (proxyClient.query as (q: string, p?: unknown[]) => Promise<unknown>)(sql, params),
  } as unknown as Pool;
}

describe("Faz 49 (D3) — Saf birim doğrulamaları (0102 migration zinciri ve bordro durum/işlem sözlüğü)", () => {
  it("0102_turkish_check_bordro_lifecycle.sql migration zincirinde hatasız doğrulanır", () => {
    const fileSet = validateFileSet(MIGRATIONS_DIR);
    expect(fileSet.errors).toEqual([]);
    const m0102 = fileSet.files.find((f) => f.version === "0102");
    expect(m0102?.name).toBe("0102_turkish_check_bordro_lifecycle.sql");
  });

  it("8 bordro operasyonu, 7 bordro türü ve 11 çek/senet durumu eksiksiz tanımlıdır", () => {
    expect(CHECK_BORDRO_OPERATIONS).toHaveLength(8);
    expect(CHECK_BORDRO_TYPES).toHaveLength(7);
    expect(Object.keys(CHECK_STATUS_LABELS_TR)).toEqual([
      "planned",
      "in_portfolio",
      "endorsed_to_vendor",
      "in_bank_collection",
      "in_bank_collateral",
      "issued_to_vendor",
      "cleared",
      "bounced",
      "returned",
      "cancelled",
      "unknown",
    ]);
  });
});

describe.runIf(hasDisposableDb || requireDisposableDb)(
  "Faz 49 (D3) — Türkiye Çek/Senet Bordrosu, Likidite Çift Sayım Kalkanı, LTV Teminat ve Karşılıksız Rücu Dönüşü Canlı DB Testleri",
  () => {
    let pool: Pool;

    beforeAll(() => {
      pool = openDisposablePool();
    });

    afterAll(async () => {
      await pool?.end();
    });

    it(
      "1) Müşteri çekinin tedarikçiye cirosu alış faturasını kapatır, likidite çift sayımını sıfırlar, rücu riskini izler ve çapraz dövizi reddeder",
      { timeout: 30_000 },
      async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);
        const actorId = await ensureSystemActor(txPool);
        const checkerId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d3-checker', 'D3 Checker Onaylayıcı', 'hash', 'finance_approver', true)
             returning id::text`,
          )
        ).rows[0].id;

        const customerName = "D3 Marmara Müşteri A.Ş.";
        const { partyId: customerId } = await createCounterparty(
          txPool,
          { name: customerName, partyType: "customer" },
          actorId,
        );
        const { partyId: vendorId } = await createCounterparty(
          txPool,
          { name: "D3 Ege Çelik Tedarik Ltd.", partyType: "vendor" },
          actorId,
        );

        // İzole bir gelecek tarih kullanarak mevcut seed verilerinden bağımsız günlük likidite satırını doğrula.
        const maturityDate = "2099-06-15";

        const { invoiceId: purchaseInvoiceId, approvalId: invApprovalId } = await createInvoice(
          txPool,
          {
            direction: "purchase",
            invoiceNo: "D3-ALIS-001",
            partyId: vendorId,
            issueDate: "2099-05-15",
            dueDate: maturityDate,
            currency: "TRY",
            lines: [{ description: "Sac levha alımı", quantity: 1, unitPrice: 150_000, taxRate: 0 }],
          },
          actorId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: purchaseInvoiceId, status: "open" }, actorId);

        const chkRes = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, payer_party_id, counterparty_label,
              amount, signed_amount, currency, instrument_type, direction, status)
           values ($1, 'CHK-D3-100K', $2, $3, 100000.00, 100000.00, 'TRY', 'check', 'inflow', 'in_portfolio')
           returning id`,
          [maturityDate, customerId, customerName],
        );
        const checkId = chkRes.rows[0].id;

        // Eğer 150.000 TRY fatura maker-checker onayına düştüyse, onaysız faturaya çek cirosu da engellenir!
        if (invApprovalId) {
          await expect(
            executeCheckBordroTransition(
              txPool,
              {
                operation: "endorse_to_vendor",
                checkIds: [checkId],
                bordroDate: "2099-05-20",
                targetInvoiceId: purchaseInvoiceId,
              },
              actorId,
            ),
          ).rejects.toThrow(/maker-checker/i);

          await decideApproval(
            txPool,
            { approvalId: invApprovalId, decision: "approved", note: "D3 fatura onayı" },
            checkerId,
          );
        }

        // Ciro ÖNCESİ 2099-06-15 likidite tahmini: +100.000 çek girişi - 150.000 fatura çıkışı = -50.000 net.
        const liqBefore = await client.query<{
          inflow_checks: string;
          outflow_invoices: string;
          net: string;
        }>(
          `select coalesce(sum(amount_signed) filter (where source_kind = 'check'), 0)::text as inflow_checks,
                  coalesce(sum(-amount_signed) filter (where source_kind = 'invoice'), 0)::text as outflow_invoices,
                  coalesce(sum(amount_signed), 0)::text as net
             from public.liquidity_forecast_daily
            where flow_date = $1::date and currency = 'TRY'`,
          [maturityDate],
        );
        expect(liqBefore.rowCount).toBe(1);
        expect(Number(liqBefore.rows[0].inflow_checks)).toBe(100_000);
        expect(Number(liqBefore.rows[0].outflow_invoices)).toBe(150_000);
        expect(Number(liqBefore.rows[0].net)).toBe(-50_000);

        // Çapraz döviz ciro denemesi (USD çek -> TRY alış faturası) kesin olarak reddedilmeli.
        const usdChkRes = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, payer_party_id, amount, signed_amount,
              currency, instrument_type, direction, status)
           values ($1, 'CHK-D3-USD', $2, 2500.00, 2500.00, 'USD', 'check', 'inflow', 'in_portfolio')
           returning id`,
          [maturityDate, customerId],
        );
        await expect(
          executeCheckBordroTransition(
            txPool,
            {
              operation: "endorse_to_vendor",
              checkIds: [usdChkRes.rows[0].id],
              bordroDate: "2099-05-20",
              targetInvoiceId: purchaseInvoiceId,
            },
            actorId,
          ),
        ).rejects.toThrow(/para birimi/i);

        const summaryBefore = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );
        const recourseBefore = summaryBefore?.contingentRecourseAmount ?? 0;

        // Tedarikçiye ciro bordrosunu çalıştır (100.000 TRY çek -> 150.000 TRY alış faturası).
        const endorseRes = await executeCheckBordroTransition(
          txPool,
          {
            operation: "endorse_to_vendor",
            checkIds: [checkId],
            bordroDate: "2099-05-20",
            targetInvoiceId: purchaseInvoiceId,
            notes: "Ege Çelik cari mahsuben ciro",
          },
          actorId,
        );
        expect(endorseRes.bordroType).toBe("vendor_endorsement");
        expect(endorseRes.nextStatus).toBe("endorsed_to_vendor");
        expect(endorseRes.totalAmount).toBe(100_000);
        expect(endorseRes.settledAllocationIds).toHaveLength(1);

        // Alış faturası `partial` durumuna ve 100.000 TRY `allocated_amount` değerine güncellenmiş olmalı.
        const invAfter = await client.query<{
          status: string;
          allocated_amount: string;
          open_amount: string;
        }>(
          `select status,
                  allocated_amount::text,
                  (gross_amount - coalesce(allocated_amount, 0))::text as open_amount
             from public.invoices
            where id = $1`,
          [purchaseInvoiceId],
        );
        expect(invAfter.rows[0].status).toBe("partial");
        expect(Number(invAfter.rows[0].allocated_amount)).toBe(100_000);
        expect(Number(invAfter.rows[0].open_amount)).toBe(50_000);

        // LİKİDİTE ÇİFT SAYIM KALKANI:
        // Ciro edilen 100.000 TRY çek kasaya girmeyeceği için `inflow_checks` 0'a iner,
        // tedarikçi faturası açık bakiyesi de 50.000 TRY'ye indiği için günlük net -50.000 TRY olarak KURUŞU KURUŞUNA korunur!
        const liqAfter = await client.query<{
          inflow_checks: string;
          outflow_invoices: string;
          net: string;
        }>(
          `select coalesce(sum(amount_signed) filter (where source_kind = 'check'), 0)::text as inflow_checks,
                  coalesce(sum(-amount_signed) filter (where source_kind = 'invoice'), 0)::text as outflow_invoices,
                  coalesce(sum(amount_signed), 0)::text as net
             from public.liquidity_forecast_daily
            where flow_date = $1::date and currency = 'TRY'`,
          [maturityDate],
        );
        expect(liqAfter.rowCount).toBe(1);
        expect(Number(liqAfter.rows[0].inflow_checks)).toBe(0);
        expect(Number(liqAfter.rows[0].outflow_invoices)).toBe(50_000);
        expect(Number(liqAfter.rows[0].net)).toBe(-50_000);

        // Şarta bağlı rücu riski (`contingent_recourse_amount`) tam +100.000 TRY artmış olmalı.
        const summaryAfter = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );
        expect((summaryAfter?.contingentRecourseAmount ?? 0) - recourseBefore).toBe(100_000);

        const recent = await loadRecentCheckBordros(txPool, 5);
        expect(recent.some((b) => b.id === endorseRes.bordroId && b.checkCount === 1)).toBe(true);
      });
    });

    it(
      "2) Ciro edilen çek karşılıksız (bounced) çıkarsa tahsisat terslenir, tedarikçi borcu yeniden canlanır ve P0 rücu alarmı üretilir; tahsil edilirse (cleared) rücu riski kapanır",
      { timeout: 30_000 },
      async () => {
      // Senaryo A: Karşılıksız (Rücu dönüşü)
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);
        const actorId = await ensureSystemActor(txPool);

        const customerName = "D3 Rücu Müşteri Ltd.";
        const { partyId: customerId } = await createCounterparty(
          txPool,
          { name: customerName, partyType: "customer" },
          actorId,
        );
        const { partyId: vendorId } = await createCounterparty(
          txPool,
          { name: "D3 Rücu Tedarikçi A.Ş.", partyType: "vendor" },
          actorId,
        );

        const maturityDate = "2099-07-20";
        const { invoiceId: purchaseInvoiceId } = await createInvoice(
          txPool,
          {
            direction: "purchase",
            invoiceNo: "D3-ALIS-RUCU-01",
            partyId: vendorId,
            issueDate: "2099-06-01",
            dueDate: maturityDate,
            currency: "TRY",
            lines: [{ description: "Hammadde", quantity: 1, unitPrice: 90_000, taxRate: 0 }],
          },
          actorId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: purchaseInvoiceId, status: "open" }, actorId);

        const chkRes = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, payer_party_id, counterparty_label,
              amount, signed_amount, currency, instrument_type, direction, status)
           values ($1, 'CHK-RUCU-90K', $2, $3, 90000.00, 90000.00, 'TRY', 'check', 'inflow', 'in_portfolio')
           returning id`,
          [maturityDate, customerId, customerName],
        );
        const checkId = chkRes.rows[0].id;

        // 90.000 TRY çek ile 90.000 TRY tedarikçi faturasını tamamen kapat (`paid`).
        await executeCheckBordroTransition(
          txPool,
          {
            operation: "endorse_to_vendor",
            checkIds: [checkId],
            bordroDate: "2099-06-05",
            targetInvoiceId: purchaseInvoiceId,
          },
          actorId,
        );

        const invPaid = await client.query<{ status: string; allocated_amount: string }>(
          `select status, allocated_amount::text from public.invoices where id = $1`,
          [purchaseInvoiceId],
        );
        expect(invPaid.rows[0].status).toBe("paid");
        expect(Number(invPaid.rows[0].allocated_amount)).toBe(90_000);

        const summaryMid = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );
        const contingentMid = summaryMid?.contingentRecourseAmount ?? 0;
        const bouncedRecourseBefore = summaryMid?.bouncedRecourseAmount ?? 0;

        // Vadesinde çek KARŞILIKSIZ (`markCheckBounced` / `mark_bounced`) çıkar!
        await markCheckBounced(txPool, checkId, actorId);

        // 1) `invoice_allocations` terslenmiş (`reversed_at IS NOT NULL`) ve tedarikçi faturası otomatik `open` durumuna dönmüş olmalı!
        const allocRow = await client.query<{ reversed_at: string | null }>(
          `select reversed_at::text
             from public.invoice_allocations
            where source_table = 'checks' and source_id = $1`,
          [checkId],
        );
        expect(allocRow.rowCount).toBe(1);
        expect(allocRow.rows[0].reversed_at).not.toBeNull();

        const invRevived = await client.query<{ status: string; allocated_amount: string }>(
          `select status, allocated_amount::text from public.invoices where id = $1`,
          [purchaseInvoiceId],
        );
        expect(invRevived.rows[0].status).toBe("open");
        expect(Number(invRevived.rows[0].allocated_amount)).toBe(0);

        // 2) Likidite tahmininde 90.000 TRY tedarikçi çıkış borcu geri canlanmış olmalı.
        const liqRevived = await client.query<{ outflow_invoices: string; net: string }>(
          `select coalesce(sum(-amount_signed) filter (where source_kind = 'invoice'), 0)::text as outflow_invoices,
                  coalesce(sum(amount_signed), 0)::text as net
             from public.liquidity_forecast_daily
            where flow_date = $1::date and currency = 'TRY'`,
          [maturityDate],
        );
        expect(Number(liqRevived.rows[0].outflow_invoices)).toBe(90_000);
        expect(Number(liqRevived.rows[0].net)).toBe(-90_000);

        // 3) Şarta bağlı rücu riski 90.000 düşerken gerçekleşmiş karşılıksız rücu 90.000 artmalı.
        const summaryBounced = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );
        expect(contingentMid - (summaryBounced?.contingentRecourseAmount ?? 0)).toBe(90_000);
        expect((summaryBounced?.bouncedRecourseAmount ?? 0) - bouncedRecourseBefore).toBe(90_000);

        // 4) P0 (`severity = 'critical'`) `control_alerts` rücu alarmı atomik olarak üretilmiş olmalı.
        const alertRes = await client.query<{
          check_code: string;
          severity: string;
          status: string;
          title: string;
          detail: string;
        }>(
          `select check_code, severity, status, title, detail
             from public.control_alerts
            where subject_table = 'checks'
              and subject_id = $1
              and check_code = 'endorsed_check_bounced_recourse'`,
          [checkId],
        );
        expect(alertRes.rowCount).toBe(1);
        expect(alertRes.rows[0].severity).toBe("critical");
        expect(alertRes.rows[0].status).toBe("open");
        expect(alertRes.rows[0].title).toContain("CHK-RUCU-90K");
      });

      // Senaryo B: Vadesinde sorunsuz tahsil (`endorsed_to_vendor -> cleared`)
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);
        const actorId = await ensureSystemActor(txPool);

        const { partyId: vendorId } = await createCounterparty(
          txPool,
          { name: "D3 Sorunsuz Ciro Tedarik A.Ş.", partyType: "vendor" },
          actorId,
        );
        const { invoiceId: purchaseInvoiceId } = await createInvoice(
          txPool,
          {
            direction: "purchase",
            invoiceNo: "D3-ALIS-OK-01",
            partyId: vendorId,
            issueDate: "2099-08-01",
            dueDate: "2099-08-25",
            currency: "TRY",
            lines: [{ description: "Lojistik hizmet", quantity: 1, unitPrice: 40_000, taxRate: 0 }],
          },
          actorId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: purchaseInvoiceId, status: "open" }, actorId);

        const chkRes = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, amount, signed_amount, currency, instrument_type, direction, status)
           values ('2099-08-25', 'CHK-OK-40K', 40000.00, 40000.00, 'TRY', 'check', 'inflow', 'in_portfolio')
           returning id`,
        );
        const checkId = chkRes.rows[0].id;

        await executeCheckBordroTransition(
          txPool,
          {
            operation: "endorse_to_vendor",
            checkIds: [checkId],
            bordroDate: "2099-08-05",
            targetInvoiceId: purchaseInvoiceId,
          },
          actorId,
        );

        const mid = (await loadCheckPortfolioSummary(txPool)).find((r) => r.currency === "TRY");
        await markCheckCleared(txPool, checkId, actorId);
        const after = (await loadCheckPortfolioSummary(txPool)).find((r) => r.currency === "TRY");

        expect((mid?.contingentRecourseAmount ?? 0) - (after?.contingentRecourseAmount ?? 0)).toBe(
          40_000,
        );
        const invStillPaid = await client.query<{ status: string }>(
          `select status from public.invoices where id = $1`,
          [purchaseInvoiceId],
        );
        expect(invStillPaid.rows[0].status).toBe("paid");
      });
    });

    it("3) Senet (promissory_note) kredi limitine LTV oranıyla teminata bağlanır (collateral_records), tahsile çekildiğinde veya ödendiğinde teminat otomatik serbest kalır", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);
        const actorId = await ensureSystemActor(txPool);

        const bankAccId = (
          await client.query<{ id: string }>(
            `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
             values ('D3 Garanti Tahsil Hesabı', 'bank_account', 'TRY', 50000.00, true)
             returning id::text`,
          )
        ).rows[0].id;
        await upsertBankAccount(
          txPool,
          {
            cashAccountId: bankAccId,
            bankName: "Garanti BBVA",
          },
          actorId,
        );

        const facRes = await client.query<{ id: string }>(
          `insert into public.credit_facilities
             (name, facility_type, limit_amount, currency, status)
           values ('D3 Garanti Rotatif Kredi Limiti', 'revolving', 500000.00, 'TRY', 'active')
           returning id`,
        );
        const facilityId = facRes.rows[0].id;

        const noteRes = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, counterparty_label, amount, signed_amount,
              currency, instrument_type, direction, status)
           values ('2099-09-10', 'SNT-D3-80K', 'Anadolu Makina San.', 80000.00, 80000.00,
                   'TRY', 'promissory_note', 'inflow', 'in_portfolio')
           returning id`,
        );
        const noteId = noteRes.rows[0].id;

        const targets = await loadCheckBordroTargets(txPool);
        expect(targets.bankAccounts.some((b) => b.id === bankAccId)).toBe(true);
        expect(targets.creditFacilities.some((f) => f.id === facilityId)).toBe(true);

        const summaryBefore = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );

        // %75 LTV ile kredi limitine teminata ver -> 80.000 * 0.75 = 60.000 TRY teminat borçlanma değeri.
        const pledgeRes = await executeCheckBordroTransition(
          txPool,
          {
            operation: "pledge_to_bank_collateral",
            checkIds: [noteId],
            bordroDate: "2099-08-10",
            targetFacilityId: facilityId,
            ltvRatio: 0.75,
          },
          actorId,
        );
        expect(pledgeRes.nextStatus).toBe("in_bank_collateral");
        expect(pledgeRes.createdCollateralIds).toHaveLength(1);
        const collateralId = pledgeRes.createdCollateralIds[0];

        const colRow = await client.query<{
          collateral_type: string;
          value_amount: string;
          released_at: string | null;
        }>(
          `select collateral_type, value_amount::text, released_at::text
             from public.collateral_records
            where id = $1`,
          [collateralId],
        );
        expect(colRow.rows[0].collateral_type).toBe("promissory_note");
        expect(Number(colRow.rows[0].value_amount)).toBe(60_000);
        expect(colRow.rows[0].released_at).toBeNull();

        const summaryPledged = (await loadCheckPortfolioSummary(txPool)).find(
          (r) => r.currency === "TRY",
        );
        expect(
          (summaryPledged?.inCollateralAmount ?? 0) - (summaryBefore?.inCollateralAmount ?? 0),
        ).toBe(80_000);
        expect(
          (summaryPledged?.collateralBorrowingValue ?? 0) -
            (summaryBefore?.collateralBorrowingValue ?? 0),
        ).toBe(60_000);

        // Teminattaki senedi vadesi yaklaşırken bankada tahsile geçir -> teminat kaydı otomatik serbest kalır!
        const toColRes = await executeCheckBordroTransition(
          txPool,
          {
            operation: "send_to_bank_collection",
            checkIds: [noteId],
            bordroDate: "2099-09-01",
            targetBankAccountId: bankAccId,
          },
          actorId,
        );
        expect(toColRes.nextStatus).toBe("in_bank_collection");
        expect(toColRes.releasedCollateralIds).toEqual([collateralId]);

        const colReleased = await client.query<{
          released_at: string | null;
          release_reason: string | null;
        }>(
          `select released_at::text, release_reason from public.collateral_records where id = $1`,
          [collateralId],
        );
        expect(colReleased.rows[0].released_at).not.toBeNull();
        expect(colReleased.rows[0].release_reason).toContain("tahsil");

        // Tahsildeki senet ödenir (`cleared`).
        await markCheckCleared(txPool, noteId, actorId);
        const finalNote = await client.query<{ status: string }>(
          `select status from public.checks where id = $1`,
          [noteId],
        );
        expect(finalNote.rows[0].status).toBe("cleared");
      });
    });

    it("4) Kendi keşide borç çekimiz, kilitli dönem (0100) reddi ve 5 katmanlı RLS yetki sınırları eksiksiz çalışır", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);
        const actorId = await ensureSystemActor(txPool);

        // A) Kendi keşide çekimiz (`planned -> issued_to_vendor -> cleared`)
        const ownChk = await client.query<{ id: string }>(
          `insert into public.checks
             (maturity_date, serial_no, counterparty_label, amount, signed_amount,
              currency, instrument_type, direction, status)
           values ('2099-10-15', 'KESIDE-001', 'Bursa Kalıp Ltd.', 55000.00, -55000.00,
                   'TRY', 'check', 'outflow', 'planned')
           returning id`,
        );
        const issueRes = await executeCheckBordroTransition(
          txPool,
          {
            operation: "issue_own_check",
            checkIds: [ownChk.rows[0].id],
            bordroDate: "2099-09-15",
          },
          actorId,
        );
        expect(issueRes.nextStatus).toBe("issued_to_vendor");

        // B) Kilitli dönem (`cashflow_months.status = 'locked'`) içine bordro kaydı `0100` trigger'ı tarafından reddedilir.
        await client.query(
          `insert into public.cashflow_months
             (month_start, status, locked_at, locked_by, lock_fingerprint)
           values ('2098-04-01', 'locked', now(), $1, 'fp-d3-lock')
           on conflict (month_start) do update
             set status = 'locked', locked_at = now(), locked_by = $1, lock_fingerprint = 'fp-d3-lock'`,
          [actorId],
        );
        await expect(
          executeCheckBordroTransition(
            txPool,
            {
              operation: "mark_cleared",
              checkIds: [ownChk.rows[0].id],
              bordroDate: "2098-04-12",
            },
            actorId,
          ),
        ).rejects.toBeInstanceOf(DomainError);

        // Açık dönemde ödeme kapanışı başarılıdır.
        await markCheckCleared(txPool, ownChk.rows[0].id, actorId);
        const clearedRow = await client.query<{ status: string }>(
          `select status from public.checks where id = $1`,
          [ownChk.rows[0].id],
        );
        expect(clearedRow.rows[0].status).toBe("cleared");

        // C) 5 Katmanlı RLS doğrulaması: viewer ve finance_approver okuyabilir ama `check_bordros` yazamaz (42501).
        for (const readOnlyRole of ["mas_radar_viewer", "mas_radar_finance_approver"] as const) {
          await client.query("savepoint sp_rls_probe");
          await client.query(`set local role ${readOnlyRole}`);
          const readBordros = await client.query(`select count(*)::int as c from public.check_bordros`);
          expect(readBordros.rows[0].c).toBeGreaterThanOrEqual(1);
          const readView = await client.query(
            `select count(*)::int as c from public.check_portfolio_and_recourse_summary`,
          );
          expect(readView.rows[0].c).toBeGreaterThanOrEqual(0);

          let deniedCode: string | null = null;
          try {
            await client.query(
              `insert into public.check_bordros
                 (bordro_no, bordro_type, bordro_date, currency, total_amount)
               values ('BRD-RLS-DENY', 'settlement', '2099-10-16', 'TRY', 100.00)`,
            );
          } catch (err) {
            deniedCode = (err as { code?: string }).code ?? "ERR";
          }
          expect(deniedCode).toBe("42501");
          await client.query("rollback to savepoint sp_rls_probe");
          await client.query("release savepoint sp_rls_probe");
        }
      });
    });
  },
);
