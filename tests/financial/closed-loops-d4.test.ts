// Faz 50 (D4) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (`Migration 0103`)
// birim + canlı tek kullanımlık DB doğrulama testleri.
//
// Güvenlik kuralı: Gerçek veritabanına (`mas_radar_dev`) ASLA bağlanmaz. Tüm canlı DB testleri
// yalnız `assertDisposableTargetDb` ile doğrulanmış tek kullanımlık veritabanında koşar.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";
import { upsertBankAccount } from "@/lib/bank/engine";
import {
  approveBudgetVersion,
  createBudget,
  createBudgetLine,
  createForecast,
  createForecastLine,
  loadBudgetVsActual,
} from "@/lib/budget/engine";
import {
  loadAllocationRules,
  loadDepartmentProfitability,
  updateAllocationRule,
} from "@/lib/costing/engine";
import {
  addIban,
  createCounterparty,
  createDimension,
  deactivateIban,
  loadCounterpartyExposure,
} from "@/lib/counterparties/engine";
import {
  loadVerifiedDocumentDownload,
  uploadValidatedDocument,
} from "@/lib/documents/engine";
import {
  DocumentIntegrityError,
  documentRoot,
  sha256,
  storagePathFor,
  validateDocumentUpload,
} from "@/lib/documents/storage";
import { DomainError } from "@/lib/domain-error";
import {
  addCollateral,
  createFacility,
  recordFacilityMovement,
  upsertCovenant,
} from "@/lib/financing/facilities";
import { changeInvoiceStatus, createInvoice } from "@/lib/invoices/engine";
import { runOptimization } from "@/lib/optimization/engine";
import {
  loadCostBreakdown,
  loadCostModels,
  loadMachineRoi,
  upsertCapacityModelManual,
  upsertCostModelManual,
  upsertMachineRoiManual,
} from "@/lib/production/engine";
import { allocateToInvoice, reverseAllocation } from "@/lib/receivables/engine";
import {
  createReconciliationTask,
  listReconciliationSignoffs,
  signOffReconciliation,
} from "@/lib/reconciliation/signoffs";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

function openDisposablePool(): Pool {
  const { url } = assertDisposableTargetDb(
    undefined,
    "tests/financial/closed-loops-d4.test.ts",
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
              const trimmed = sql.trim().toLowerCase();
              if (trimmed === "begin") {
                const sp = `sp_d4_${++spSeq}`;
                stack.push(sp);
                return target.query(`savepoint ${sp}`);
              }
              if (trimmed === "commit") {
                const sp = stack.pop();
                return sp ? target.query(`release savepoint ${sp}`) : target.query("select 1");
              }
              if (trimmed === "rollback") {
                const sp = stack.pop();
                return sp
                  ? target.query(`rollback to savepoint ${sp}`)
                  : target.query("select 1");
              }
            }
            return params !== undefined
              ? target.query(sql as string, params as unknown[])
              : target.query(sql as string);
          });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    connect: async () => proxyClient,
    query: (sql: unknown, params?: unknown) =>
      enqueue(() =>
        params !== undefined
          ? client.query(sql as string, params as unknown[])
          : client.query(sql as string),
      ),
  } as unknown as Pool;
}

describe("Faz 50 (D4) — statik sözleşme ve doküman kasası güvenlik kuralları", () => {
  it("migration 0103 sıralı ve benzersiz biçimde dosya kümesinde kayıtlıdır", () => {
    const fileSet = validateFileSet(MIGRATIONS_DIR);
    expect(fileSet.errors).toEqual([]);
    const m0103 = fileSet.files.find((f) => f.version === "0103");
    expect(m0103?.name).toBe("0103_close_operational_loops_and_reconciliation_signoffs.sql");
  });

  it("doküman kasası MIME beyaz listesini, sihirli bayt imzasını ve içerik-adresli yolu zorlar", () => {
    const validPdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF", "ascii");
    const meta = validateDocumentUpload(
      validPdf,
      "application/pdf",
      "../../gizli/Kredi_Sözleşmesi_2026.pdf",
    );
    expect(meta.mimeType).toBe("application/pdf");
    expect(meta.safeExt).toBe("pdf");
    expect(meta.sanitizedOriginalFilename).toBe("Kredi_Sözleşmesi_2026.pdf");

    const hash = sha256(validPdf);
    const relPath = storagePathFor(hash, meta.safeExt);
    expect(relPath.split(path.sep)).toEqual([
      hash.slice(0, 2),
      hash.slice(2, 4),
      `${hash}.pdf`,
    ]);
    expect(relPath).not.toContain("Kredi");

    // Yürütülebilir dosya ve sahte uzantı reddedilir
    expect(() =>
      validateDocumentUpload(Buffer.from("MZ-fake-exe"), "application/x-msdownload", "evil.exe"),
    ).toThrow(DomainError);

    expect(() =>
      validateDocumentUpload(Buffer.from("bu bir pdf degil"), "application/pdf", "sahte.pdf"),
    ).toThrow(DomainError);

    expect(() =>
      validateDocumentUpload(Buffer.alloc(0), "application/pdf", "bos.pdf"),
    ).toThrow(DomainError);
  });
});

describe("Faz 50 (D4) — canlı tek kullanımlık DB kapalı iş döngüleri (0103)", () => {
  it("DB testi atlanmışsa zorunlu modda hata verir", () => {
    if (requireDisposableDb && !hasDisposableDb) {
      throw new Error(
        "MAS_REQUIRE_DISPOSABLE_DB_TEST=1 iken tek kullanımlık DB bulunamadı!",
      );
    }
  });

  describe.skipIf(!hasDisposableDb)("Canlı tek kullanımlık PostgreSQL 16 testleri", () => {
    let pool: Pool;
    let makerId: string;
    let checkerId: string;
    let tempVaultDir: string;
    let prevVaultEnv: string | undefined;

    beforeAll(async () => {
      prevVaultEnv = process.env.MAS_DOCUMENT_STORAGE_DIR;
      tempVaultDir = mkdtempSync(path.join(os.tmpdir(), "mas-d4-vault-"));
      process.env.MAS_DOCUMENT_STORAGE_DIR = tempVaultDir;

      pool = openDisposablePool();
      makerId = await ensureSystemActor(pool);
      await pool.query(
        `insert into public.users (username, display_name, password_hash, role, is_active)
         values ('d4_test_admin', 'D4 Test Yöneticisi', 'scrypt$test$hash', 'admin', true)
         on conflict (username) do nothing`,
      );
      await pool.query(
        `insert into public.users (username, display_name, password_hash, role, is_active)
         values ('d4_checker', 'D4 İkinci Göz Onaylayıcı', 'scrypt$test$hash', 'finance_approver', true)
         on conflict (username) do nothing`,
      );
      const checkerRes = await pool.query<{ id: string }>(
        `select id from public.users where username = 'd4_checker'`,
      );
      checkerId = checkerRes.rows[0].id;
    });

    afterAll(async () => {
      if (pool) await pool.end();
      if (prevVaultEnv === undefined) {
        delete process.env.MAS_DOCUMENT_STORAGE_DIR;
      } else {
        process.env.MAS_DOCUMENT_STORAGE_DIR = prevVaultEnv;
      }
      if (tempVaultDir) {
        rmSync(tempVaultDir, { recursive: true, force: true });
      }
    });

    it("1) Bütçe satırı ekleme → maker-checker onaylama → budget_vs_actual ve departman kârlılığında gerçek varyans", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const dept = await createDimension(
          txPool,
          "departments",
          { code: "DEP-D4-URETIM", name: "D4 Üretim Departmanı" },
          makerId,
        );

        const budgetId = await createBudget(
          txPool,
          {
            name: "2026 D4 Test Bütçesi",
            fiscalYear: 2026,
            periodKind: "monthly",
            currency: "TRY",
          },
          makerId,
        );

        const lineId = await createBudgetLine(
          txPool,
          {
            budgetId,
            periodStart: "2026-10-01",
            direction: "expense",
            amount: 100_000,
            currency: "TRY",
            departmentId: dept.id,
          },
          makerId,
        );

        // Taslak (draft) iken budget_vs_actual görünümünde yer almaz
        const beforeApproval = await loadBudgetVsActual(txPool, budgetId);
        expect(beforeApproval).toHaveLength(0);

        // Maker kendi bütçe satırını onaylayamaz (maker ≠ checker)
        await expect(
          approveBudgetVersion(txPool, { table: "budget_lines", lineId }, makerId),
        ).rejects.toThrow(/maker|onaylayamazsınız/i);

        // İkinci göz (checker) onaylar: draft -> approved
        const approved = await approveBudgetVersion(
          txPool,
          { table: "budget_lines", lineId },
          checkerId,
        );
        expect(approved.approvedCount).toBe(1);

        // Henüz fatura yokken BLANK != ZERO gereği actualAmount null ve verdict 'not_measured' olur
        const approvedNoInvoices = await loadBudgetVsActual(txPool, budgetId);
        expect(approvedNoInvoices).toHaveLength(1);
        expect(approvedNoInvoices[0].actualAmount).toBeNull();
        expect(approvedNoInvoices[0].verdict).toBe("not_measured");

        // Departman etiketli alış ve satış faturaları oluşturup açalım
        const vendor = await createCounterparty(
          txPool,
          { name: "D4 Çelik Tedarik A.Ş.", partyType: "vendor", taxNumber: "4440001112" },
          makerId,
        );
        const customer = await createCounterparty(
          txPool,
          { name: "D4 Savunma Müşteri A.Ş.", partyType: "customer", taxNumber: "4440002223" },
          makerId,
        );

        const purchaseInv = await createInvoice(
          txPool,
          {
            direction: "purchase",
            partyId: vendor.partyId,
            invoiceNo: "D4-ALIS-001",
            issueDate: "2026-10-12",
            dueDate: "2026-11-12",
            currency: "TRY",
            departmentId: dept.id,
            lines: [{ description: "Alaşımlı Çelik", quantity: 10, unitPrice: 10_000, taxRate: 0.2 }],
          },
          makerId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: purchaseInv.invoiceId, status: "open" }, makerId);

        const salesInv = await createInvoice(
          txPool,
          {
            direction: "sales",
            partyId: customer.partyId,
            invoiceNo: "D4-SATIS-001",
            issueDate: "2026-10-18",
            dueDate: "2026-11-18",
            currency: "TRY",
            departmentId: dept.id,
            lines: [{ description: "Hassas Mil Teslimatı", quantity: 10, unitPrice: 20_000, taxRate: 0.2 }],
          },
          makerId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: salesInv.invoiceId, status: "open" }, makerId);

        // Bütçe 100.000 TL, gerçekleşen 120.000 TL (KDV dahil gross_amount) -> +20.000 TL aşım (over_budget)
        const afterInvoices = await loadBudgetVsActual(txPool, budgetId);
        expect(afterInvoices).toHaveLength(1);
        expect(afterInvoices[0].budgetAmount).toBe(100_000);
        expect(afterInvoices[0].actualAmount).toBe(120_000);
        expect(afterInvoices[0].varianceAmount).toBe(20_000);
        expect(afterInvoices[0].verdict).toBe("over_budget");

        // Departman kârlılığı görünümü de aynı gerçek faturalardan satış=240.000, maliyet=120.000, marj=120.000 okur
        const deptProf = await loadDepartmentProfitability(txPool);
        const targetDept = deptProf.find((d) => d.departmentId === dept.id);
        expect(targetDept).toBeDefined();
        expect(targetDept?.unmeasurableReason).toBeNull();
        expect(targetDept?.revenue).toBe(240_000);
        expect(targetDept?.directCost).toBe(120_000);
        expect(targetDept?.margin).toBe(120_000);

        // 13 haftalık tahmin kabı ve satırı da maker-checker onayından geçer
        const forecastId = await createForecast(
          txPool,
          { name: "D4 13H Tahmin", horizonKind: "weekly_13", anchorDate: "2026-10-05", currency: "TRY" },
          makerId,
        );
        const fLineId = await createForecastLine(
          txPool,
          {
            forecastId,
            periodStart: "2026-10-05",
            periodEnd: "2026-10-11",
            direction: "inflow",
            amount: 85_000,
            sourceKind: "contracted",
          },
          makerId,
        );
        const fApproved = await approveBudgetVersion(
          txPool,
          { table: "forecast_lines", lineId: fLineId },
          checkerId,
        );
        expect(fApproved.approvedCount).toBe(1);
      });
    });

    it("2) Kredi limiti + rotatif kullanım/geri ödeme → atomik drawn_amount, limit koruması, teminat/kovenant ve optimizasyon çözücüsü", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        // Bilinen açılış bakiyeli TRY kasa hesabı (FIN-03 gereği bilinmeyen bakiye varsa çözücü durur)
        const cashAcct = await client.query<{ id: string }>(
          `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
           values ('D4 Ana Vadesiz TRY', 'bank_account', 'TRY', 100000, true)
           returning id`,
        );
        await upsertBankAccount(
          txPool,
          {
            cashAccountId: cashAcct.rows[0].id,
            bankName: "Garanti BBVA",
          },
          makerId,
        );

        const lender = await createCounterparty(
          txPool,
          { name: "D4 Finansman Bankası A.Ş.", partyType: "bank", taxNumber: "5550001114" },
          makerId,
        );

        const facilityId = await createFacility(
          txPool,
          {
            name: "D4 Rotatif BCH Limiti",
            lenderPartyId: lender.partyId,
            facilityType: "revolving",
            limitAmount: 1_000_000,
            currency: "TRY",
            interestRate: 42,
            startDate: "2026-01-01",
            expiryDate: "2027-01-01",
            status: "active",
          },
          makerId,
        );

        const draw1 = await recordFacilityMovement(
          txPool,
          {
            facilityId,
            movementType: "drawdown",
            movementDate: "2026-10-10",
            amount: 400_000,
            currency: "TRY",
            notes: "İlk rotatif çekiş",
          },
          makerId,
        );
        expect(draw1.drawnAmount).toBe(400_000);

        const repay1 = await recordFacilityMovement(
          txPool,
          {
            facilityId,
            movementType: "repayment",
            movementDate: "2026-10-15",
            amount: 150_000,
            currency: "TRY",
            notes: "Kısmi geri ödeme",
          },
          makerId,
        );
        expect(repay1.drawnAmount).toBe(250_000);

        // Limit aşımı (250.000 + 800.000 > 1.000.000) ve negatif bakiye (250.000 - 300.000 < 0) DB tetikleyicisiyle reddedilir
        await expect(
          recordFacilityMovement(
            txPool,
            { facilityId, movementType: "drawdown", movementDate: "2026-10-16", amount: 800_000, currency: "TRY" },
            makerId,
          ),
        ).rejects.toThrow(DomainError);

        await expect(
          recordFacilityMovement(
            txPool,
            { facilityId, movementType: "repayment", movementDate: "2026-10-16", amount: 300_000, currency: "TRY" },
            makerId,
          ),
        ).rejects.toThrow(DomainError);

        // Teminat ve kovenant kaydı + otomatik ihlal/uyum değerlendirmesi
        const collateralId = await addCollateral(
          txPool,
          {
            facilityId,
            collateralType: "mortgage",
            description: "OSB Fabrika İpoteği",
            valueAmount: 2_500_000,
            currency: "TRY",
            valuationDate: "2026-10-01",
            valuationSource: "independent",
          },
          makerId,
        );
        expect(collateralId).toBeTruthy();

        const covenantId = await upsertCovenant(
          txPool,
          {
            facilityId,
            covenantType: "dscr",
            description: "Minimum DSCR >= 1.20",
            comparison: "gte",
            thresholdValue: 1.2,
            lastTestDate: "2026-10-15",
            lastTestValue: 1.05,
          },
          makerId,
        );
        const covBreached = await client.query<{ last_test_result: string }>(
          `select last_test_result from public.covenant_records where id = $1`,
          [covenantId],
        );
        expect(covBreached.rows[0].last_test_result).toBe("breached");

        await upsertCovenant(
          txPool,
          {
            covenantId,
            facilityId,
            covenantType: "dscr",
            description: "Minimum DSCR >= 1.20",
            comparison: "gte",
            thresholdValue: 1.2,
            lastTestDate: "2026-10-20",
            lastTestValue: 1.35,
          },
          makerId,
        );
        const covCompliant = await client.query<{ last_test_result: string }>(
          `select last_test_result from public.covenant_records where id = $1`,
          [covenantId],
        );
        expect(covCompliant.rows[0].last_test_result).toBe("compliant");

        // Optimizasyon çözücüsü gerçek drawnAmount (250.000) ve kullanılabilir boşluğu (750.000) okur
        const opt = await runOptimization(
          txPool,
          {
            name: "D4 Kredi Limiti Optimizasyon Testi",
            objective: "min_financing_cost",
            anchorDate: "2026-10-20",
            horizonDays: 30,
            currency: "TRY",
          },
          makerId,
        );
        const runRow = await client.query<{ constraints: { drawnAmount: number; facilityCount: number } }>(
          `select constraints from public.optimization_runs where id = $1`,
          [opt.runId],
        );
        expect(runRow.rows[0].constraints.drawnAmount).toBe(250_000);
        expect(runRow.rows[0].constraints.facilityCount).toBeGreaterThanOrEqual(1);
      });
    });

    it("3) Doküman yükleme, finansal kayda bağlama, SHA-256 doğrulamalı indirme ve disk bozulma tespiti", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const facilityId = await createFacility(
          txPool,
          {
            name: "D4 Doküman Bağlantılı Limit",
            facilityType: "spot",
            limitAmount: 500_000,
            currency: "TRY",
          },
          makerId,
        );

        const pdfBytes = Buffer.from(
          "%PDF-1.4\n% D4 Test Sözleşmesi\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n",
          "utf8",
        );
        const expectedHash = sha256(pdfBytes);

        const uploaded = await uploadValidatedDocument(
          txPool,
          {
            title: "2026 Genel Kredi Sözleşmesi",
            docType: "contract",
            tags: ["kredi", "2026"],
            bytes: pdfBytes,
            mimeType: "application/pdf",
            originalFilename: "..\\..\\GKS_2026_İmzalı.pdf",
            entityTable: "credit_facilities",
            entityId: facilityId,
            entityLabel: "D4 Doküman Bağlantılı Limit",
            linkKind: "contract",
          },
          makerId,
        );

        expect(uploaded.linked).toBe(true);
        expect(uploaded.version.sha256).toBe(expectedHash);
        expect(uploaded.version.storagePath).toBe(storagePathFor(expectedHash, "pdf"));

        const docRow = await client.query<{ original_filename: string }>(
          `select original_filename from public.documents where id = $1`,
          [uploaded.documentId],
        );
        expect(docRow.rows[0].original_filename).toBe("GKS_2026_İmzalı.pdf");

        const downloaded = await loadVerifiedDocumentDownload(txPool, uploaded.documentId);
        expect(downloaded.sha256).toBe(expectedHash);
        expect(downloaded.originalFilename).toBe("GKS_2026_İmzalı.pdf");
        expect(downloaded.bytes.equals(pdfBytes)).toBe(true);

        // Disk üzerindeki dosya tahrif edilirse SHA-256 doğrulaması DocumentIntegrityError fırlatır
        const diskFile = path.join(documentRoot(), uploaded.version.storagePath);
        writeFileSync(diskFile, Buffer.from("%PDF-1.4\nBOZULMUS VERI\n%%EOF\n", "utf8"));
        await expect(
          loadVerifiedDocumentDownload(txPool, uploaded.documentId),
        ).rejects.toThrow(DocumentIntegrityError);
      });
    });

    it("4) Karşı taraf Tümü/Aktif görünürlüğü, IBAN ekleme/pasifleştirme iban_change_events izi, tahsis geri alma ve dağıtım kuralı", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const party = await createCounterparty(
          txPool,
          { name: "D4 Sıfır Hareketli Yeni Cari Ltd.", partyType: "vendor", taxNumber: "6660003335" },
          makerId,
        );

        // Sıfır hareketli cari 'withExposureOnly: false' (Tümü sekmesi) ile gizlenmeden görünür
        const allExposure = await loadCounterpartyExposure(txPool, { withExposureOnly: false, limit: 200 });
        const foundZeroParty = allExposure.find((p) => p.partyId === party.partyId);
        expect(foundZeroParty).toBeDefined();
        expect(foundZeroParty?.itemCount).toBe(0);

        const ibanRes = await addIban(
          txPool,
          {
            partyId: party.partyId,
            iban: "TR330006100519786457841326",
            bankName: "Türkiye İş Bankası",
            accountLabel: "Ana TL",
            currency: "TRY",
            isPrimary: true,
          },
          makerId,
        );

        await deactivateIban(txPool, ibanRes.ibanId, makerId);

        const events = await client.query<{ change_type: string }>(
          `select change_type
             from public.iban_change_events
            where iban_id = $1
            order by changed_at asc, id asc`,
          [ibanRes.ibanId],
        );
        const eventTypes = events.rows.map((r) => r.change_type);
        expect(eventTypes).toContain("created");
        expect(eventTypes).toContain("updated");

        // Alacak tahsisi ve geri alma (reverseAllocation) döngüsü
        const cust = await createCounterparty(
          txPool,
          { name: "D4 Tahsis Test Müşteri A.Ş.", partyType: "customer", taxNumber: "6660004446" },
          makerId,
        );
        const inv = await createInvoice(
          txPool,
          {
            direction: "sales",
            partyId: cust.partyId,
            invoiceNo: "D4-TAHSIS-01",
            issueDate: "2026-10-05",
            dueDate: "2026-10-25",
            currency: "TRY",
            lines: [{ description: "CNC İşleme", quantity: 1, unitPrice: 50_000, taxRate: 0.2 }],
          },
          makerId,
        );
        await changeInvoiceStatus(txPool, { invoiceId: inv.invoiceId, status: "open" }, makerId);

        const alloc = await allocateToInvoice(
          txPool,
          { invoiceId: inv.invoiceId, sourceTable: "manual", amount: 25_000 },
          makerId,
        );
        const afterAlloc = await client.query<{ allocated_amount: string }>(
          `select allocated_amount from public.invoices where id = $1`,
          [inv.invoiceId],
        );
        expect(Number(afterAlloc.rows[0].allocated_amount)).toBe(25_000);

        await reverseAllocation(
          txPool,
          { allocationId: alloc.allocationId, reason: "Yanlış faturaya eşleştirildi" },
          makerId,
        );
        const afterReverse = await client.query<{ allocated_amount: string }>(
          `select allocated_amount from public.invoices where id = $1`,
          [inv.invoiceId],
        );
        expect(Number(afterReverse.rows[0].allocated_amount)).toBe(0);

        // Masraf dağıtım kuralı güncelleme
        const rules = await loadAllocationRules(txPool);
        if (rules.length > 0) {
          await updateAllocationRule(
            txPool,
            {
              code: rules[0].code,
              allocationBasis: "fixed_percent",
              fixedPercent: 0.35,
              isActive: true,
              notes: "D4 test güncellemesi",
            },
            makerId,
          );
          const updatedRules = await loadAllocationRules(txPool);
          const updated = updatedRules.find((r) => r.code === rules[0].code);
          expect(updated?.allocationBasis).toBe("fixed_percent");
          expect(updated?.fixedPercent).toBe(0.35);
        }
      });
    });

    it("5) Dönem mutabakat imzalama (append-only kanıt), görev üretimi ve working_capital_monthly_v görünümü", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        // Açık fark varken temiz imza atılamaz
        await expect(
          signOffReconciliation(
            txPool,
            { periodMonth: "2026-10", scope: "bank_cash", status: "signed_clean", openExceptionCount: 2 },
            makerId,
          ),
        ).rejects.toThrow(DomainError);

        // İstisnalı imzada not zorunludur
        await expect(
          signOffReconciliation(
            txPool,
            { periodMonth: "2026-10", scope: "bank_cash", status: "signed_with_exceptions", openExceptionCount: 2 },
            makerId,
          ),
        ).rejects.toThrow(DomainError);

        const signId = await signOffReconciliation(
          txPool,
          {
            periodMonth: "2026-10",
            scope: "bank_cash",
            status: "signed_with_exceptions",
            openExceptionCount: 1,
            notes: "Valör farkı ertesi güne sarktı",
          },
          makerId,
        );
        const list = await listReconciliationSignoffs(txPool, 10);
        expect(list.some((s) => s.id === signId)).toBe(true);

        // Append-only kanıt koruması: doğrudan UPDATE ve DELETE veritabanı tetikleyicisi tarafından reddedilir
        await client.query("savepoint sp_immut_upd");
        await expect(
          client.query(`update public.reconciliation_signoffs set notes = 'tahrif' where id = $1`, [signId]),
        ).rejects.toThrow();
        await client.query("rollback to savepoint sp_immut_upd");

        await client.query("savepoint sp_immut_del");
        await expect(
          client.query(`delete from public.reconciliation_signoffs where id = $1`, [signId]),
        ).rejects.toThrow();
        await client.query("rollback to savepoint sp_immut_del");

        const taskId = await createReconciliationTask(
          txPool,
          {
            title: "2026-10 valör farkı dekont kontrolü",
            severity: "high",
            relatedEntityTable: "reconciliation_signoffs",
            relatedEntityId: signId,
          },
          makerId,
        );
        const taskRow = await client.query<{ source_type: string; status: string }>(
          `select source_type, status from public.action_items where id = $1`,
          [taskId],
        );
        expect(taskRow.rows[0]).toEqual({ source_type: "control", status: "open" });

        // Zombi working_capital_trend_reference kalkmış ve working_capital_monthly_v aktif olmalı
        const zombieCheck = await client.query(
          `select to_regclass('public.working_capital_trend_reference') as zombie,
                  to_regclass('public.working_capital_monthly_v') as active_view`,
        );
        expect(zombieCheck.rows[0].zombie).toBeNull();
        expect(zombieCheck.rows[0].active_view).toBe("working_capital_monthly_v");
      });
    });

    it("6) Üretim ekonomisi manuel parametre formları (kapasite, sabit maliyet kalemi başabaş ve makine ROI)", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const capId = await upsertCapacityModelManual(
          txPool,
          {
            name: "D4 2026 Atölye Kapasite",
            scenarioType: "normal",
            workDaysPerMonth: 22,
            hoursPerDay: 8,
            efficiencyRate: 0.85,
            tornaRateTLPerMin: 24,
            frezeRateTLPerMin: 30,
            rateYear: 2026,
          },
          makerId,
        );
        expect(capId).toBeTruthy();

        await upsertCostModelManual(
          txPool,
          {
            scenarioType: "custom",
            costCategory: "Atölye Elektrik",
            description: "Trafo baz yük",
            monthlyAmount: 89_760,
            staffCount: 6,
            monthlyWorkHours: 176,
            efficiencyRate: 0.85,
          },
          makerId,
        );

        const costModels = await loadCostModels(txPool);
        const customModel = costModels.find((m) => m.scenario === "custom");
        expect(customModel).toBeDefined();
        expect(customModel?.monthlyCost).toBe(89_760);
        // 176 * 60 * 0.85 = 8.976 dk -> 89.760 / 8.976 = 10 TL/dk başabaş
        expect(customModel?.breakEven).toBe(10);
        const breakdown = await loadCostBreakdown(txPool, customModel!.id);
        expect(breakdown.some((b) => b.label.includes("Atölye Elektrik"))).toBe(true);

        // Kişisel gider adı makine formunda da reddedilir
        await expect(
          upsertMachineRoiManual(
            txPool,
            { name: "Patron Ev Kira Gideri", purchaseCost: 100_000 },
            makerId,
          ),
        ).rejects.toThrow(DomainError);

        await upsertMachineRoiManual(
          txPool,
          {
            name: "Mazak Integrex D4",
            machineCode: "MZK-D4",
            purchaseDate: "2026-02-01",
            purchaseCost: 4_500_000,
            monthlyRevenue: 320_000,
            monthlyOperatingCost: 110_000,
            utilizationRate: 82,
            usefulLifeMonths: 120,
            snapshotYear: 2026,
            annualRevenue: 3_840_000,
            annualCost: 1_320_000,
          },
          makerId,
        );

        const machines = await loadMachineRoi(txPool);
        const mazak = machines.find((m) => m.name === "Mazak Integrex D4");
        expect(mazak).toBeDefined();
        expect(mazak?.purchase_cost).toBe(4_500_000);
        expect(mazak?.revenue).toBe(3_840_000);
        expect(mazak?.cost).toBe(1_320_000);
        expect(mazak?.net).toBe(2_520_000);
      });
    });
  });
});
