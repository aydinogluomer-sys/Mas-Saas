// Faz 48 (D2) — Canlı Maker-Checker Onay Döngüsü, IBAN BEC Kalkanı, 14 Günlük Kasa Tamponu
// Simülasyonlu Ödeme Çalıştırma Paketi (`payment_runs`), ISO 20022 `pain.001.001.03` XML + 4 Büyük
// Türk Bankası EFT/Havale İhracı ve Banka Eşleştirme → Atomik Kapanış (`0101`) uçtan uca testleri.
//
// Güvenlik kuralı: Gerçek veritabanına (`mas_radar_dev`) ASLA bağlanmaz. Tüm canlı DB testleri
// yalnız `assertDisposableTargetDb` ile doğrulanmış tek kullanımlık veritabanında koşar.

import ExcelJS from "exceljs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";
import { decideApproval } from "@/lib/approvals/engine";
import {
  acceptMatch,
  loadCandidates,
  reconcileBankAccount,
  runMatcher,
  upsertBankAccount,
} from "@/lib/bank/engine";
import { addIban, createCounterparty } from "@/lib/counterparties/engine";
import { isTurkishIban, isValidIbanChecksum } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import { changeInvoiceStatus, createInvoice, recordInvoicePayment } from "@/lib/invoices/engine";
import {
  escapeXml,
  exportPaymentRun,
  sanitizeSpreadsheetText,
} from "@/lib/payments/bank-export";
import {
  cancelPaymentRun,
  createPaymentRun,
  submitPaymentRunForApproval,
} from "@/lib/payments/payment-runs";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

/** Builds a valid 26-char Turkish IBAN from a 5-digit bank code + 17-digit account payload using ISO 7064 MOD-97. */
function makeValidTrIban(bankCode5: string, account17: string): string {
  const bban = `${bankCode5.padStart(5, "0").slice(0, 5)}${account17.padStart(17, "0").slice(0, 17)}`;
  // Rearrange: BBAN + "TR00" where T=29, R=27 -> "292700"
  const numericStr = `${bban}292700`;
  let rem = 0;
  for (const ch of numericStr) {
    rem = (rem * 10 + Number(ch)) % 97;
  }
  const check = String(98 - rem).padStart(2, "0");
  return `TR${check}${bban}`;
}

function openDisposablePool(): Pool {
  const { url } = assertDisposableTargetDb(
    undefined,
    "tests/financial/payment-runs-approvals-and-bank-settlement.test.ts",
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
              const sp = `sp_d2_${++spSeq}`;
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

describe("Faz 48 (D2) — Saf birim korumaları (XML varlık kaçışı, CSV enjeksiyon kalkanı, TR IBAN MOD-97 ve 0101 kaydı)", () => {
  it("0101_payment_runs_and_bank_settlement_links.sql migration zincirinde hatasız doğrulanır", () => {
    const fileSet = validateFileSet(MIGRATIONS_DIR);
    expect(fileSet.errors).toEqual([]);
    const m0101 = fileSet.files.find((f) => f.version === "0101");
    expect(m0101?.name).toBe("0101_payment_runs_and_bank_settlement_links.sql");
  });

  it("escapeXml yasadışı kontrol karakterlerini temizler ve 5 XML özel varlığını kaçırır", () => {
    const dirty = "Aksaray\x07 & Çelik <Sanayi> \"Merkez\" 'Şube'";
    expect(escapeXml(dirty)).toBe(
      "Aksaray &amp; Çelik &lt;Sanayi&gt; &quot;Merkez&quot; &apos;Şube&apos;",
    );
  });

  it("sanitizeSpreadsheetText formül enjeksiyonu öneklerini (=, +, -, @) etkisizleştirir", () => {
    expect(sanitizeSpreadsheetText("=CMD|' /C calc'!A0")).toBe("'=CMD|' /C calc'!A0");
    expect(sanitizeSpreadsheetText("+SUM(A1:A5)")).toBe("'+SUM(A1:A5)");
    expect(sanitizeSpreadsheetText("-100+200")).toBe("'-100+200");
    expect(sanitizeSpreadsheetText("@IMPORTXML()")).toBe("'@IMPORTXML()");
    expect(sanitizeSpreadsheetText("Anadolu Tedarik A.Ş.")).toBe("Anadolu Tedarik A.Ş.");
  });

  it("TR IBAN üreticisi ISO 7064 MOD-97 == 1 doğrulamasından geçer ve bozuk kontrol basamağını reddeder", () => {
    const valid = makeValidTrIban("00062", "00012345678901234");
    expect(isTurkishIban(valid)).toBe(true);
    expect(isValidIbanChecksum(valid)).toBe(true);

    const corrupted = `TR${valid.slice(2, 4) === "99" ? "98" : "99"}${valid.slice(4)}`;
    expect(isValidIbanChecksum(corrupted)).toBe(false);
  });
});

describe.runIf(hasDisposableDb || requireDisposableDb)(
  "Faz 48 (D2) — Dalga 2 Uçtan Uca Canlı PostgreSQL Doğrulaması (Fatura → Onay → Payment Run → pain.001 → Banka Eşleşme → Kapanış)",
  () => {
    let pool: Pool;

    beforeAll(() => {
      pool = openDisposablePool();
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("Uçtan uca zincir: Eşik üstü fatura + Yeni IBAN BEC kilidi → Maker-Checker onayı → 14g kasa simülasyonlu ödeme paketi → pain.001 & 4 banka ihracı → Banka eşleşmesiyle otomatik kapanış", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        // İzole 14g likidite simülasyonu için mevcut TRY kasa/politikaları ve önümüzdeki 14 gündeki diğer açık kalemleri temiz pencereye taşıyalım
        await client.query(`update public.cash_accounts set is_active = false where currency = 'TRY'`);
        await client.query(`update public.treasury_policies set is_active = false where currency = 'TRY'`);

        const makerId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d2-maker', 'D2 Maker Operatör', 'hash', 'finance_operator', true)
             returning id::text`,
          )
        ).rows[0].id;

        const checkerId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d2-checker', 'D2 Checker Onaylayıcı', 'hash', 'finance_approver', true)
             returning id::text`,
          )
        ).rows[0].id;

        // Kaynak TRY banka hesabı: açılış bakiyesi = 300.000,00 TRY; asgari kasa tabanı = 200.000,00 TRY
        const debtorIban = makeValidTrIban("00062", "00099887766554433"); // Garanti BBVA (00062)
        const sourceCashId = (
          await client.query<{ id: string }>(
            `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
             values ('D2 Garanti Kurumsal TRY', 'bank_account', 'TRY', 300000.00, true)
             returning id::text`,
          )
        ).rows[0].id;

        await upsertBankAccount(
          txPool,
          {
            cashAccountId: sourceCashId,
            iban: debtorIban,
            bankName: "Garanti BBVA",
            swiftBic: "TGBATRISXXX",
          },
          makerId,
        );

        await client.query(
          `insert into public.treasury_policies (code, description, policy_kind, currency, threshold_amount, is_active)
           values ('d2_min_cash_try', 'D2 Asgari Kasa Tamponu', 'min_cash', 'TRY', 200000.00, true)`,
        );

        await client.query(
          `update public.approval_rules
              set is_active = true
            where code in ('amount_over_100k', 'new_iban_requires_approval')`,
        );

        // 1) Karşı taraf + Yeni IBAN (BEC dolandırıcılık kalkanı otomatik devreye girer)
        const { partyId: vendorId } = await createCounterparty(
          txPool,
          {
            name: "Aksaray & Çelik <Sanayi> A.Ş.",
            partyType: "vendor",
            taxNumber: "1234567890",
          },
          makerId,
        );

        const creditorIban = makeValidTrIban("00064", "00011223344556677"); // İş Bankası (00064 -> EFT)
        await addIban(
          txPool,
          {
            partyId: vendorId,
            iban: creditorIban,
            currency: "TRY",
            isPrimary: true,
            accountLabel: "Ana Tedarikçi Hesabı",
          },
          makerId,
        );

        const ibanRow = (
          await client.query<{ id: string; approval_status: string; approval_id: string | null }>(
            `select id::text, approval_status, approval_id::text
               from public.ibans
              where party_id = $1`,
            [vendorId],
          )
        ).rows[0];
        expect(ibanRow.approval_status).toBe("pending_approval");
        expect(ibanRow.approval_id).toBeTruthy();

        // 2) 125.000,00 TRY alış faturası (uzak bir test penceresi 2088-05-10 seçilir ki diğer seed yükümlülükleriyle karışmasın)
        const today = "2088-05-10";
        const dueDate = "2088-05-15";
        const { invoiceId } = await createInvoice(
          txPool,
          {
            direction: "purchase",
            invoiceNo: "D2-INV-125K",
            partyId: vendorId,
            issueDate: today,
            dueDate,
            currency: "TRY",
            lines: [
              {
                description: "=CMD|' /C calc'!A0 Çelik Levha Alımı",
                quantity: 1,
                unitPrice: 125000,
                taxRate: 0,
              },
            ],
          },
          makerId,
        );
        await changeInvoiceStatus(txPool, { invoiceId, status: "open" }, makerId);

        const invBeforeApproval = (
          await client.query<{ approval_status: string; approval_id: string | null }>(
            `select approval_status, approval_id::text from public.invoices where id = $1`,
            [invoiceId],
          )
        ).rows[0];
        expect(invBeforeApproval.approval_status).toBe("pending_approval");
        expect(invBeforeApproval.approval_id).toBeTruthy();

        // Onaysız alış faturası ne doğrudan ödenebilir ne de ödeme paketine eklenebilir
        await expect(
          recordInvoicePayment(txPool, { invoiceId, amount: 125000 }, makerId),
        ).rejects.toThrow(DomainError);

        await expect(
          createPaymentRun(
            txPool,
            {
              sourceBankAccountId: sourceCashId,
              plannedExecutionDate: dueDate,
              currency: "TRY",
              items: [{ targetType: "invoice", targetId: invoiceId }],
            },
            makerId,
            today,
          ),
        ).rejects.toThrow(/maker-checker/);

        // Maker kendi açtığı fatura onay talebini ONAYLAYAMAZ
        await expect(
          decideApproval(
            txPool,
            {
              approvalId: invBeforeApproval.approval_id!,
              decision: "approved",
              note: "Kendi kendime onay denemesi",
            },
            makerId,
          ),
        ).rejects.toThrow(/maker-checker/);

        // Checker faturayı onaylar -> invoices.approval_status = 'approved'
        await decideApproval(
          txPool,
          {
            approvalId: invBeforeApproval.approval_id!,
            decision: "approved",
            note: "Tedarik sözleşmesi ve irsaliye kontrol edildi",
          },
          checkerId,
        );

        const invAfterApproval = (
          await client.query<{ approval_status: string; approved_by: string }>(
            `select approval_status, approved_by::text from public.invoices where id = $1`,
            [invoiceId],
          )
        ).rows[0];
        expect(invAfterApproval.approval_status).toBe("approved");
        expect(invAfterApproval.approved_by).toBe(checkerId);

        // 3) 14 günlük kasa simülasyonlu ödeme çalıştırma paketi oluşturma
        // 300.000 açılış - 125.000 paket = 175.000 TRY (< 200.000 min_cash tabanı -> breachesCashFloor = true,
        // ve liquidity_forecast_daily içindeki aynı fatura ÇİFT SAYILMAZ: tam 175.000 çıkar, 50.000 değil!)
        const runCreated = await createPaymentRun(
          txPool,
          {
            sourceBankAccountId: sourceCashId,
            plannedExecutionDate: dueDate,
            currency: "TRY",
            items: [
              {
                targetType: "invoice",
                targetId: invoiceId,
                description: "=CMD|' /C calc'!A0 Fatura D2-INV-125K",
              },
            ],
          },
          makerId,
          today,
        );

        expect(runCreated.totalAmount).toBe(125000);
        expect(runCreated.itemCount).toBe(1);
        expect(runCreated.unverifiedIbanCount).toBe(1);
        expect(runCreated.simulation.preRunCash).toBe(300000);
        expect(runCreated.simulation.projected14dMinCash).toBe(175000);
        expect(runCreated.simulation.minCashFloor).toBe(200000);
        expect(runCreated.simulation.breachesCashFloor).toBe(true);

        // Taslak paketten pain.001 ihracı REDDEDİLİR
        await expect(
          exportPaymentRun(txPool, { runId: runCreated.runId, format: "pain001" }, makerId),
        ).rejects.toThrow(DomainError);

        // 4) Paketi maker-checker onayına gönder
        const { approvalId: runApprovalId } = await submitPaymentRunForApproval(
          txPool,
          { runId: runCreated.runId },
          makerId,
        );

        // Onay bekleyen paketten ihraç REDDEDİLİR
        await expect(
          exportPaymentRun(txPool, { runId: runCreated.runId, format: "pain001" }, makerId),
        ).rejects.toThrow(DomainError);

        // Maker paketi kendi kendine onaylayamaz
        await expect(
          decideApproval(
            txPool,
            { approvalId: runApprovalId, decision: "approved", note: "Self approve" },
            makerId,
          ),
        ).rejects.toThrow(/maker-checker/);

        // Checker paketi onaylar -> payment_runs.status = 'approved'
        await decideApproval(
          txPool,
          { approvalId: runApprovalId, decision: "approved", note: "Ödeme paketi onaylandı" },
          checkerId,
        );

        // 5) BEC Dolandırıcılık Kalkanı Kanıtı: Paket onaylı olsa bile yeni IBAN onaylanmadan ihraç BLOKLANIR!
        await expect(
          exportPaymentRun(txPool, { runId: runCreated.runId, format: "pain001" }, makerId),
        ).rejects.toThrow(/BEC Kalkanı/);

        // Checker tedarikçinin yeni IBAN kaydını onaylar -> ibans.approval_status = 'approved' & payment_run_items.iban_verified = true
        await decideApproval(
          txPool,
          {
            approvalId: ibanRow.approval_id!,
            decision: "approved",
            note: "Tedarikçi antetli IBAN teyit yazısı doğrulandı",
          },
          checkerId,
        );

        const priVerified = (
          await client.query<{ iban_verified: boolean }>(
            `select iban_verified from public.payment_run_items where run_id = $1`,
            [runCreated.runId],
          )
        ).rows[0];
        expect(priVerified.iban_verified).toBe(true);

        // 6) ISO 20022 pain.001.001.03 XML + 4 Türk bankası CSV/XLSX ihracı
        const pain = await exportPaymentRun(
          txPool,
          {
            runId: runCreated.runId,
            format: "pain001",
            debtorName: "MAS Makine & Otomasyon A.Ş.",
          },
          makerId,
        );
        const xml = pain.buffer.toString("utf8");
        expect(xml).toContain('xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
        expect(xml).toContain("<NbOfTxs>1</NbOfTxs>");
        expect(xml).toContain("<CtrlSum>125000.00</CtrlSum>");
        expect(xml).toContain(`<IBAN>${debtorIban}</IBAN>`);
        expect(xml).toContain(`<IBAN>${creditorIban}</IBAN>`);
        expect(xml).toContain("Aksaray &amp; Çelik &lt;Sanayi&gt; A.Ş.");
        expect(xml).toContain("MAS Makine &amp; Otomasyon A.Ş.");

        const garantiXlsx = await exportPaymentRun(
          txPool,
          { runId: runCreated.runId, format: "garanti_xlsx" },
          makerId,
        );
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(garantiXlsx.buffer as unknown as ExcelJS.Buffer);
        const ws = wb.worksheets[0];
        expect(ws.name).toBe("Garanti_Toplu_Odeme");
        // Borçlu Garanti (00062), Alacaklı İş Bankası (00064) -> EFT!
        expect(ws.getRow(2).getCell(2).value).toBe("EFT");
        expect(ws.getRow(2).getCell(4).value).toBe(creditorIban);
        expect(ws.getRow(2).getCell(5).value).toBe(125000);
        // Formül enjeksiyonu etkisizleştirilmiş olmalı ('=CMD...)
        expect(String(ws.getRow(2).getCell(8).value)).toMatch(/^'=CMD/);

        const isbankCsv = await exportPaymentRun(
          txPool,
          { runId: runCreated.runId, format: "isbank_csv" },
          makerId,
        );
        const csvText = isbankCsv.buffer.toString("utf8");
        expect(csvText).toContain(creditorIban);
        expect(csvText).toContain("125000.00");
        expect(csvText).toContain("'=CMD");

        const ykCsv = await exportPaymentRun(
          txPool,
          { runId: runCreated.runId, format: "yapikredi_csv" },
          makerId,
        );
        expect(ykCsv.buffer.toString("utf8")).toContain(creditorIban);

        const akbankXlsx = await exportPaymentRun(
          txPool,
          { runId: runCreated.runId, format: "akbank_xlsx" },
          makerId,
        );
        expect(akbankXlsx.buffer.subarray(0, 2).toString("utf8")).toBe("PK");

        const runAfterExport = (
          await client.query<{ status: string; exported_hash: string }>(
            `select status, exported_hash from public.payment_runs where id = $1`,
            [runCreated.runId],
          )
        ).rows[0];
        expect(runAfterExport.status).toBe("exported");
        expect(runAfterExport.exported_hash).toBe(akbankXlsx.sha256);

        // 7) Banka ekstresi hareketi gelir -> Eşleştirici aday detaylarını zenginleştirir -> acceptMatch atomik kapatır!
        const bankTxId = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions
               (bank_account_id, txn_date, description, counterparty_name_raw, amount, currency, dedupe_hash)
             values ($1, $2::date, 'D2-INV-125K EFT Ödemesi', 'Aksaray Çelik Sanayi', -125000.00, 'TRY', 'd2-golden-tx-1')
             returning id::text`,
            [sourceCashId, dueDate],
          )
        ).rows[0].id;

        const matchRes = await runMatcher(txPool, makerId);
        expect(matchRes.suggested).toBeGreaterThanOrEqual(1);

        const candidates = await loadCandidates(txPool, bankTxId);
        const invCand = candidates.find(
          (c) => c.targetTable === "invoices" && c.targetId === invoiceId,
        );
        expect(invCand).toBeDefined();
        expect(invCand?.counterpartyName).toBe("Aksaray & Çelik <Sanayi> A.Ş.");
        expect(invCand?.referenceLabel).toBe("Fatura D2-INV-125K");
        expect(invCand?.openAmount).toBe(125000);
        expect(invCand?.currency).toBe("TRY");
        expect(invCand?.dueDate).toBe(dueDate);

        await acceptMatch(
          txPool,
          {
            transactionId: bankTxId,
            targetTable: "invoices",
            targetId: invoiceId,
          },
          makerId,
        );

        // Atomik sonuç doğrulaması: fatura = paid, tahsis = 125.000, payment_run_items = settled, payment_runs = settled!
        const invSettled = (
          await client.query<{ status: string; allocated_amount: string; paid_amount: string }>(
            `select status, allocated_amount::text, paid_amount::text
               from public.invoices where id = $1`,
            [invoiceId],
          )
        ).rows[0];
        expect(invSettled.status).toBe("paid");
        expect(Number(invSettled.allocated_amount)).toBe(125000);
        expect(Number(invSettled.paid_amount)).toBe(125000);

        const btSettled = (
          await client.query<{ status: string; settled_allocation_id: string | null; settled_by: string | null }>(
            `select status, settled_allocation_id::text, settled_by::text
               from public.bank_transactions where id = $1`,
            [bankTxId],
          )
        ).rows[0];
        expect(btSettled.status).toBe("matched");
        expect(btSettled.settled_allocation_id).toBeTruthy();
        expect(btSettled.settled_by).toBe(makerId);

        const priSettled = (
          await client.query<{ status: string; settled_bank_tx_id: string | null }>(
            `select status, settled_bank_tx_id::text
               from public.payment_run_items where run_id = $1`,
            [runCreated.runId],
          )
        ).rows[0];
        expect(priSettled.status).toBe("settled");
        expect(priSettled.settled_bank_tx_id).toBe(bankTxId);

        const runSettled = (
          await client.query<{ status: string; settled_at: string | null }>(
            `select status, settled_at::text from public.payment_runs where id = $1`,
            [runCreated.runId],
          )
        ).rows[0];
        expect(runSettled.status).toBe("settled");
        expect(runSettled.settled_at).toBeTruthy();

        // 8) Hesap mutabakat kilidi (`reconcileBankAccount`: matched -> reconciled)
        const rec = await reconcileBankAccount(txPool, sourceCashId, makerId);
        expect(rec.reconciledCount).toBe(1);

        const btReconciled = (
          await client.query<{ status: string }>(
            `select status from public.bank_transactions where id = $1`,
            [bankTxId],
          )
        ).rows[0];
        expect(btReconciled.status).toBe("reconciled");
      });
    });

    it("acceptMatch diğer 3 yükümlülük tipini (payment_instances kısmi+tam, checks + check_events, loan_installments) ve kilitli dönem faturasının açık dönem kapanışını atomik yürütür", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const actorId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d2-multi', 'D2 Multi Operatör', 'hash', 'finance_manager', true)
             returning id::text`,
          )
        ).rows[0].id;

        const cashId = (
          await client.query<{ id: string }>(
            `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
             values ('D2 Multi Banka', 'bank_account', 'TRY', 500000.00, true)
             returning id::text`,
          )
        ).rows[0].id;
        await client.query(
          `insert into public.bank_accounts (cash_account_id, iban) values ($1, $2)`,
          [cashId, makeValidTrIban("00067", "00055544433322211")],
        );

        // A) payment_instances: önce 4.000 TL kısmi, ardından 6.000 TL tam kapanış
        const paymentId = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, default_amount, currency, due_date, direction, status)
             values ('D2 Kira Ödemesi', 'one_off', 10000.00, 'TRY', '2088-06-15', 'outflow', 'active')
             returning id::text`,
          )
        ).rows[0].id;
        const piId = (
          await client.query<{ id: string }>(
            `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, status, direction)
             values ($1, '2088-06-01', '2088-06-15', 10000.00, 'TRY', 'unpaid', 'outflow')
             returning id::text`,
            [paymentId],
          )
        ).rows[0].id;

        const txPi1 = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-06-14', -4000.00, 'TRY', 'd2-pi-part-1') returning id::text`,
            [cashId],
          )
        ).rows[0].id;
        await acceptMatch(txPool, { transactionId: txPi1, targetTable: "payment_instances", targetId: piId }, actorId);

        const piAfter1 = (
          await client.query<{ status: string; paid_amount: string }>(
            `select status, paid_amount::text from public.payment_instances where id = $1`,
            [piId],
          )
        ).rows[0];
        expect(piAfter1.status).toBe("partial");
        expect(Number(piAfter1.paid_amount)).toBe(4000);

        const txPi2 = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-06-15', -6000.00, 'TRY', 'd2-pi-part-2') returning id::text`,
            [cashId],
          )
        ).rows[0].id;
        await acceptMatch(txPool, { transactionId: txPi2, targetTable: "payment_instances", targetId: piId }, actorId);

        const piAfter2 = (
          await client.query<{ status: string; paid_amount: string }>(
            `select status, paid_amount::text from public.payment_instances where id = $1`,
            [piId],
          )
        ).rows[0];
        expect(piAfter2.status).toBe("paid");
        expect(Number(piAfter2.paid_amount)).toBe(10000);

        // B) checks: planned -> cleared + check_events satırı
        const checkId = (
          await client.query<{ id: string }>(
            `insert into public.checks (direction, serial_no, maturity_date, amount, currency, status, counterparty_label)
             values ('outflow', 'CHK-D2-01', '2088-06-20', 18500.00, 'TRY', 'planned', 'Demirbaş Tedarik')
             returning id::text`,
          )
        ).rows[0].id;
        const txChk = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-06-20', -18500.00, 'TRY', 'd2-chk-1') returning id::text`,
            [cashId],
          )
        ).rows[0].id;
        await acceptMatch(txPool, { transactionId: txChk, targetTable: "checks", targetId: checkId }, actorId);

        const chkAfter = (
          await client.query<{ status: string }>(`select status from public.checks where id = $1`, [checkId])
        ).rows[0];
        expect(chkAfter.status).toBe("cleared");
        const chkEvtCount = (
          await client.query<{ n: number }>(
            `select count(*)::int as n from public.check_events where check_id = $1 and event_type = 'cleared'`,
            [checkId],
          )
        ).rows[0].n;
        expect(chkEvtCount).toBe(1);

        // C) loan_installments: planned -> paid
        const loanId = (
          await client.query<{ id: string }>(
            `insert into public.loans (name, principal, currency, status)
             values ('D2 İşletme Kredisi', 120000.00, 'TRY', 'active')
             returning id::text`,
          )
        ).rows[0].id;
        const liId = (
          await client.query<{ id: string }>(
            `insert into public.loan_installments (loan_id, installment_no, due_date, amount, status)
             values ($1, 6, '2088-06-25', 11250.50, 'planned')
             returning id::text`,
            [loanId],
          )
        ).rows[0].id;
        const txLi = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-06-25', -11250.50, 'TRY', 'd2-li-1') returning id::text`,
            [cashId],
          )
        ).rows[0].id;
        await acceptMatch(txPool, { transactionId: txLi, targetTable: "loan_installments", targetId: liId }, actorId);

        const liAfter = (
          await client.query<{ status: string; paid_date: string }>(
            `select status, to_char(paid_at at time zone 'UTC', 'YYYY-MM-DD') as paid_date
               from public.loan_installments where id = $1`,
            [liId],
          )
        ).rows[0];
        expect(liAfter.status).toBe("paid");
        expect(liAfter.paid_date).toBe("2088-06-25");

        // D) Kilitli dönemde (2087-11-01) kesilmiş açık satış faturası açık dönemde (2088-06-28) banka tahsilatıyla kapanabilir!
        const { partyId: customerId } = await createCounterparty(
          txPool,
          { name: "D2 Müşteri A.Ş.", partyType: "customer" },
          actorId,
        );
        const lockedInvId = (
          await client.query<{ id: string }>(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, status)
             values ('sales', 'D2-LOCKED-INV', $1, '2087-11-10', '2087-12-10', 'TRY', 15000.00, 0, 15000.00, 'open')
             returning id::text`,
            [customerId],
          )
        ).rows[0].id;

        await client.query(
          `insert into public.cashflow_months
             (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance, status)
           values ('2087-11-01', 100000, 20000, 10000, 10000, 110000, 'locked')`,
        );

        const txLockedSettle = (
          await client.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-06-28', 15000.00, 'TRY', 'd2-locked-inv-settle') returning id::text`,
            [cashId],
          )
        ).rows[0].id;

        await acceptMatch(
          txPool,
          { transactionId: txLockedSettle, targetTable: "invoices", targetId: lockedInvId },
          actorId,
        );

        const lockedInvAfter = (
          await client.query<{ status: string; paid_amount: string }>(
            `select status, paid_amount::text from public.invoices where id = $1`,
            [lockedInvId],
          )
        ).rows[0];
        expect(lockedInvAfter.status).toBe("paid");
        expect(Number(lockedInvAfter.paid_amount)).toBe(15000);
      });
    });

    it("5-katmanlı RLS & Tetikleyici Koruması: finance_operator kendi paketini DB'de onaylayamaz; finance_approver onay sırasında tutarı değiştiremez; iptal edilen paketin kalemi serbest kalır", async () => {
      await inRollback(pool, async (client) => {
        const txPool = transactionalClientAsPool(client);

        const makerId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d2-rls-maker', 'RLS Maker', 'hash', 'finance_operator', true)
             returning id::text`,
          )
        ).rows[0].id;
        const approverId = (
          await client.query<{ id: string }>(
            `insert into public.users (username, display_name, password_hash, role, is_active)
             values ('d2-rls-approver', 'RLS Approver', 'hash', 'finance_approver', true)
             returning id::text`,
          )
        ).rows[0].id;

        const cashId = (
          await client.query<{ id: string }>(
            `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
             values ('D2 RLS Banka', 'bank_account', 'TRY', 100000.00, true)
             returning id::text`,
          )
        ).rows[0].id;
        await client.query(
          `insert into public.bank_accounts (cash_account_id, iban) values ($1, $2)`,
          [cashId, makeValidTrIban("00015", "00012312312312312")],
        );

        const { partyId: vendorId } = await createCounterparty(
          txPool,
          { name: "D2 RLS Tedarikçi", partyType: "vendor" },
          makerId,
        );
        const vendorIban = makeValidTrIban("00046", "00078978978978978");
        await client.query(
          `insert into public.ibans (party_id, iban, currency, is_primary, is_active, approval_status)
           values ($1, $2, 'TRY', true, true, 'approved')`,
          [vendorId, vendorIban],
        );

        const invId = (
          await client.query<{ id: string }>(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, status, approval_status)
             values ('purchase', 'D2-RLS-INV-1', $1, '2088-05-01', '2088-05-10', 'TRY', 25000.00, 0, 25000.00, 'open', 'not_required')
             returning id::text`,
            [vendorId],
          )
        ).rows[0].id;

        const run1 = await createPaymentRun(
          txPool,
          {
            sourceBankAccountId: cashId,
            plannedExecutionDate: "2088-05-10",
            currency: "TRY",
            items: [{ targetType: "invoice", targetId: invId }],
          },
          makerId,
          "2088-05-01",
        );

        // Aynı açık fatura ikinci bir aktif pakete eklenemez
        await expect(
          createPaymentRun(
            txPool,
            {
              sourceBankAccountId: cashId,
              plannedExecutionDate: "2088-05-11",
              currency: "TRY",
              items: [{ targetType: "invoice", targetId: invId }],
            },
            makerId,
            "2088-05-01",
          ),
        ).rejects.toThrow(DomainError);

        await submitPaymentRunForApproval(txPool, { runId: run1.runId }, makerId);

        // 1) mas_radar_finance_operator doğrudan SQL ile status='approved' yapamaz
        await client.query("savepoint sp_op_self");
        let operatorBlocked = false;
        try {
          await client.query(`select set_config('app.user_id', $1, true)`, [makerId]);
          await client.query(`set local role mas_radar_finance_operator`);
          await client.query(
            `update public.payment_runs set status = 'approved', approved_by = $2 where id = $1`,
            [run1.runId, approverId],
          );
        } catch {
          operatorBlocked = true;
        } finally {
          await client.query("rollback to savepoint sp_op_self");
        }
        expect(operatorBlocked).toBe(true);

        // 2) mas_radar_finance_approver onay sırasında total_amount kolonunu değiştiremez (42501)
        await client.query("savepoint sp_app_tamper");
        let tamperBlocked = false;
        try {
          await client.query(`select set_config('app.user_id', $1, true)`, [approverId]);
          await client.query(`set local role mas_radar_finance_approver`);
          await client.query(
            `update public.payment_runs
                set status = 'approved', approved_by = $2, approved_at = now(), total_amount = 1.00
              where id = $1`,
            [run1.runId, approverId],
          );
        } catch {
          tamperBlocked = true;
        } finally {
          await client.query("rollback to savepoint sp_app_tamper");
        }
        expect(tamperBlocked).toBe(true);

        // 3) Paket iptal edildiğinde kalem excluded olur ve yeni pakete tekrar eklenebilir
        await cancelPaymentRun(
          txPool,
          { runId: run1.runId, reason: "Ödeme haftası revize edildi" },
          makerId,
        );

        const run2 = await createPaymentRun(
          txPool,
          {
            sourceBankAccountId: cashId,
            plannedExecutionDate: "2088-05-12",
            currency: "TRY",
            items: [{ targetType: "invoice", targetId: invId }],
          },
          makerId,
          "2088-05-01",
        );
        expect(run2.itemCount).toBe(1);
      });
    });

    it("Yarış durumu (SELECT ... FOR UPDATE) kanıtı: Aynı banka hareketine eşzamanlı iki acceptMatch çağrısından yalnız 1'i kazanır, fatura asla çift tahsis edilmez", async () => {
      // Gerçek satır kilidi çekişmesi için iki bağımsız PG bağlantısının görebileceği geçici kayıtlar açıp finally'de siliyoruz.
      // `audit_logs` append-only olduğu için var olan sistem aktörü kullanılır.
      const actorId = await ensureSystemActor(pool);
      let cashId: string | null = null;
      let partyId: string | null = null;
      let invoiceId: string | null = null;
      let bankTxId: string | null = null;

      try {
        cashId = (
          await pool.query<{ id: string }>(
            `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
             values ('D2 Race Banka ' || gen_random_uuid()::text, 'bank_account', 'TRY', 50000.00, false)
             returning id::text`,
          )
        ).rows[0].id;

        await pool.query(`insert into public.bank_accounts (cash_account_id) values ($1)`, [cashId]);

        const createdParty = await createCounterparty(
          pool,
          { name: `D2 Race Tedarikçi ${Date.now()}`, partyType: "vendor" },
          actorId,
        );
        partyId = createdParty.partyId;

        invoiceId = (
          await pool.query<{ id: string }>(
            `insert into public.invoices
               (direction, invoice_no, party_id, issue_date, due_date, currency, net_amount, tax_amount, gross_amount, status, approval_status)
             values ('purchase', 'D2-RACE-INV', $1, '2088-05-01', '2088-05-05', 'TRY', 20000.00, 0, 20000.00, 'open', 'not_required')
             returning id::text`,
            [partyId],
          )
        ).rows[0].id;

        bankTxId = (
          await pool.query<{ id: string }>(
            `insert into public.bank_transactions (bank_account_id, txn_date, amount, currency, dedupe_hash)
             values ($1, '2088-05-05', -8000.00, 'TRY', 'd2-race-tx')
             returning id::text`,
            [cashId],
          )
        ).rows[0].id;

        const payload = {
          transactionId: bankTxId,
          targetTable: "invoices" as const,
          targetId: invoiceId,
        };

        const outcomes = await Promise.allSettled([
          acceptMatch(pool, payload, actorId),
          acceptMatch(pool, payload, actorId),
        ]);

        const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
        const rejected = outcomes.filter((o) => o.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const allocRes = await pool.query<{ cnt: number; total: string }>(
          `select count(*)::int as cnt, coalesce(sum(allocated_amount), 0)::text as total
             from public.invoice_allocations
            where invoice_id = $1 and reversed_at is null`,
          [invoiceId],
        );
        expect(allocRes.rows[0].cnt).toBe(1);
        expect(Number(allocRes.rows[0].total)).toBe(8000);
      } finally {
        if (bankTxId) {
          await pool.query(`update public.bank_transactions set settled_allocation_id = null where id = $1`, [bankTxId]).catch(() => {});
          await pool.query(`delete from public.invoice_allocations where source_id = $1`, [bankTxId]).catch(() => {});
          await pool.query(`delete from public.bank_transactions where id = $1`, [bankTxId]).catch(() => {});
        }
        if (invoiceId) {
          await pool.query(`delete from public.invoices where id = $1`, [invoiceId]).catch(() => {});
        }
        if (partyId) {
          await pool.query(`delete from public.counterparty_profiles where party_id = $1`, [partyId]).catch(() => {});
          await pool.query(`delete from public.parties where id = $1`, [partyId]).catch(() => {});
        }
        if (cashId) {
          await pool.query(`delete from public.bank_accounts where cash_account_id = $1`, [cashId]).catch(() => {});
          await pool.query(`delete from public.cash_accounts where id = $1`, [cashId]).catch(() => {});
        }
      }
    });
  },
);
