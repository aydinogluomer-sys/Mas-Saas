import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCounterparty } from "@/lib/counterparties/engine";
import { postManualManagementAdjustment } from "@/lib/ledger/posting-engine";
import {
  importStatutoryMizan,
  parseStatutoryMizanBuffer,
} from "@/lib/ledger/statutory-mizan-importer";
import {
  buildCpaReconciliationPackBuffer,
  createActionFromReconciliationItem,
  loadReconciliationRun,
  reconcileTrialBalance,
} from "@/lib/ledger/trial-balance-bridge";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

describe.runIf(hasDisposableDb || requireDisposableDb)("Faz 53 (E3) — Mali Müşavir Yasal Mizan İçe Aktarımı ve 12 Kök Nedenli Yönetim ↔ Yasal Mizan Köprüsü", () => {
  let pool: Pool;
  let actorId = "";
  let customerPartyId = "";
  let vendorPartyId = "";

  beforeAll(async () => {
    const dbTarget = assertDisposableTargetDb(
      undefined,
      "Faz 53 (E3) statutory-mizan-bridge test",
    );
    pool = new Pool({ connectionString: dbTarget.url, max: 2 });
    actorId = await ensureSystemActor(pool);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from public.trial_balance_reconciliation_items`);
      await client.query(`delete from public.trial_balance_reconciliation_runs`);
      await client.query(`delete from public.statutory_trial_balance_lines`);
      await client.query(`delete from public.statutory_trial_balances`);
      await client.query(`alter table public.management_journal_entries disable trigger user`);
      await client.query(`alter table public.management_journal_lines disable trigger user`);
      await client.query(`delete from public.management_journal_lines`);
      await client.query(`delete from public.management_journal_entries`);
      await client.query(`alter table public.management_journal_lines enable trigger user`);
      await client.query(`alter table public.management_journal_entries enable trigger user`);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }

    const cust = await createCounterparty(
      pool,
      {
        name: "E3 Test Müşteri A.Ş.",
        partyType: "customer",
        taxNumber: "5353535301",
      },
      actorId,
    );
    customerPartyId = cust.partyId;

    const vend = await createCounterparty(
      pool,
      {
        name: "E3 Test Tedarikçi Ltd.",
        partyType: "vendor",
        taxNumber: "5353535302",
      },
      actorId,
    );
    vendorPartyId = vend.partyId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1) Luca/Logo hiyerarşik mizanında (120 + 120.01 + 120.01.001) yaprak-olmayan satırları is_leaf=false işaretler, çift saymaz ve dengesiz mizanı is_self_balanced=false olarak kaydeder", async () => {
    const csvContent = [
      "Hesap Kodu;Hesap Adı;Borç Toplamı;Alacak Toplamı;Borç Bakiyesi;Alacak Bakiyesi",
      "120;ALICILAR ANA HESAP;150.000,00;30.000,00;120.000,00;0,00",
      "120.01;YURTİÇİ ALICILAR;150.000,00;30.000,00;120.000,00;0,00",
      "120.01.001;A GRUBU MÜŞTERİ;90.000,00;10.000,00;80.000,00;0,00",
      "120.01.002;B GRUBU MÜŞTERİ;60.000,00;20.000,00;40.000,00;0,00",
      "600;YURTİÇİ SATIŞLAR;0,00;100.000,00;0,00;100.000,00",
      "391;HESAPLANAN KDV;0,00;20.000,00;0,00;20.000,00",
      "102;BANKALAR;30.000,00;0,00;30.000,00;0,00",
      "TOPLAM;GENEL TOPLAM;180.000,00;180.000,00;150.000,00;120.000,00",
    ].join("\r\n");

    const parsed = await parseStatutoryMizanBuffer(
      Buffer.from(csvContent, "utf8"),
      "luca_haziran_mizan.csv",
    );

    // 120 and 120.01 must be non-leaf; 120.01.001, 120.01.002, 600, 391, 102 must be leaf
    const row120 = parsed.lines.find((l) => l.accountCode === "120");
    const row120_01 = parsed.lines.find((l) => l.accountCode === "120.01");
    const row120_01_001 = parsed.lines.find((l) => l.accountCode === "120.01.001");
    expect(row120?.isLeaf).toBe(false);
    expect(row120_01?.isLeaf).toBe(false);
    expect(row120_01_001?.isLeaf).toBe(true);
    expect(parsed.nonLeafCount).toBe(2);
    expect(parsed.leafCount).toBe(5);

    // Leaf debit sum = 90,000 + 60,000 + 0 + 0 + 30,000 = 180,000 (not 480,000!)
    expect(parsed.totalDebitTry).toBe(180000);
    // Leaf credit sum = 10,000 + 20,000 + 100,000 + 20,000 + 0 = 150,000 -> intentionally unbalanced to test is_self_balanced=false!
    expect(parsed.totalCreditTry).toBe(150000);
    expect(parsed.isSelfBalanced).toBe(false);
    expect(parsed.parentWarnings).toHaveLength(0);

    const saved = await importStatutoryMizan(
      pool,
      {
        asOfDate: "2026-06-30",
        periodLabel: "2026-06 Test Dengesiz Mizan",
        sourceSoftware: "Luca",
        originalFilename: "luca_dengesiz.csv",
        buffer: Buffer.from(csvContent, "utf8"),
      },
      actorId,
    );
    expect(saved.isSelfBalanced).toBe(false);
    expect(saved.totalDebitTry).toBe(180000);
    expect(saved.totalCreditTry).toBe(150000);
  });

  it("2) 12 deterministik kök nedenin tamamını (100, 101, 102, 103, 120, 131/331, 190/191/391, 300/400, 320, 335, 360/361 ve EBITDA↔690) pozitif sınıflandırır ve hiçbir kaydı sessizce değiştirmez", async () => {
    // 1. Seed MAS Management Ledger entries as of 2026-07-31:
    // Balanced management entry covering all TDHP roots:
    // Debits:
    //   100 Kasa:                    20,000
    //   101.01 Alınan Çekler:        50,000  (after 40,000 vendor endorsement!)
    //   102 Bankalar:               300,000
    //   120 Alıcılar:               180,000
    //   191 İndirilecek KDV:         36,000
    //   620 Satılan Mamul Maliyeti: 120,000
    //   770 Genel Yönetim Gideri:    40,000
    //   770.99 Amortisman (D&A):     15,000
    //   780 Finansman Giderleri:      8,000
    // Total Debits = 769,000 TRY
    //
    // Credits:
    //   103 Verilen Çekler:          35,000
    //   257 Birikmiş Amortisman:     15,000
    //   300 Banka Kredileri:         80,000  (20,000 principal repaid)
    //   320 Satıcılar:               95,000
    //   335 Personele Borçlar:       25,000
    //   360 Ödenecek Vergi:          18,000
    //   361 Ödenecek SGK:            12,000
    //   391 Hesaplanan KDV:          60,000
    //   500 Sermaye:                129,000
    //   600 Yurtiçi Satışlar:       300,000
    // Total Credits = 769,000 TRY
    //
    // Management P&L & EBITDA:
    //   Net Sales (600) = 300,000
    //   COGS (620)      = 120,000 -> Gross Profit = 180,000
    //   Cash OPEX (770) = 40,000
    //   D&A (770.99)    = 15,000  -> EBIT = 125,000
    //   Management EBITDA = 125,000 + 15,000 = 140,000 TRY
    //   Financing (780) = 8,000   -> Management 690 EBT = 117,000 TRY

    await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-07-31",
        description: "Temmuz 2026 Konsolide Yönetim Defteri Fişi",
        currency: "TRY",
        status: "posted",
        idempotencyKey: "e3:mgmt:consolidated:2026-07",
        lines: [
          { accountCode: "100", debitNative: 20000, creditNative: 0, partyId: customerPartyId },
          { accountCode: "101.01", debitNative: 50000, creditNative: 0, partyId: customerPartyId },
          { accountCode: "102", debitNative: 300000, creditNative: 0 },
          { accountCode: "120", debitNative: 180000, creditNative: 0, partyId: customerPartyId },
          { accountCode: "191", debitNative: 36000, creditNative: 0 },
          { accountCode: "620", debitNative: 120000, creditNative: 0 },
          { accountCode: "770", debitNative: 40000, creditNative: 0 },
          { accountCode: "770.99", debitNative: 15000, creditNative: 0 },
          { accountCode: "780", debitNative: 8000, creditNative: 0 },
          { accountCode: "103", debitNative: 0, creditNative: 35000, partyId: vendorPartyId },
          { accountCode: "257", debitNative: 0, creditNative: 15000 },
          { accountCode: "300", debitNative: 0, creditNative: 80000 },
          { accountCode: "320", debitNative: 0, creditNative: 95000, partyId: vendorPartyId },
          { accountCode: "335", debitNative: 0, creditNative: 25000 },
          { accountCode: "360", debitNative: 0, creditNative: 18000 },
          { accountCode: "361", debitNative: 0, creditNative: 12000 },
          { accountCode: "391", debitNative: 0, creditNative: 60000 },
          { accountCode: "500", debitNative: 0, creditNative: 129000 },
          { accountCode: "600", debitNative: 0, creditNative: 300000, partyId: customerPartyId },
        ],
      },
      actorId,
    );

    // 2. Build a self-balanced XML Statutory CPA Mizan as of 2026-07-31 that exhibits all 12 Turkish accounting gaps:
    //   100 Kasa:             85,000 Borç (CPA inflated cash by +65,000 -> CASH_100_INFLATION)
    //   101 Alınan Çekler:    90,000 Borç (CPA didn't book 40,000 endorsement -> CHECK_ENDORSEMENT_OR_CLEARING_LAG)
    //   102 Bankalar:        260,000 Borç (CPA missing 40,000 bank statement -> UNBOOKED_BANK_TXN_OR_FX)
    //   103 Verilen Çekler:   15,000 Alacak (CPA missing 20,000 issued check -> ISSUED_CHECK_NOT_DELIVERED_TO_CPA)
    //   120 Alıcılar:        140,000 Borç (CPA missing 40,000 cutoff invoice -> CUTOFF_UNBILLED_OR_UNALLOCATED_CASH)
    //   131 Ortaklardan Al.:  35,000 Borç (CPA plugged unbooked items to 131 -> PARTNER_ACCOUNT_PLUG)
    //   191 İndirilecek KDV:  30,000 Borç & 391 Hesaplanan KDV: 52,000 Alacak (Net -22,000 vs -24,000 -> VAT_TAHAKKUK_UNCLOSED)
    //   300 Banka Kredileri:  72,000 Alacak (CPA deducted gross installment 28,000 from 300 instead of 20,000 principal + 8,000 780 interest -> LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT)
    //   320 Satıcılar:        70,000 Alacak (CPA missing 25,000 purchase invoice -> MISSING_PURCHASE_INVOICE)
    //   335 Personele Borç:   10,000 Alacak (CPA missing 15,000 employee expense/payroll -> PAYROLL_ADVANCE_OR_EXPENSE_GAP)
    //   360 Ödenecek Vergi:   20,000 Alacak (CPA 20,000 vs MAS 30,000 -> UNPAID_OR_RESTRUCTURED_TAX_DEBT)
    //   600 Yurtiçi Satışlar: 260,000 Alacak
    //   620 SMM:              110,000 Borç
    //   770 GYG:               35,000 Borç
    //   500 Sermaye:          286,000 Alacak (balances total debit = 785,000, total credit = 785,000!)
    const xmlMizan = `<?xml version="1.0" encoding="UTF-8"?>
<Mizan>
  <Satir><HesapKodu>100</HesapKodu><HesapAdi>KASA</HesapAdi><BorcToplami>85000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>101</HesapKodu><HesapAdi>ALINAN ÇEKLER</HesapAdi><BorcToplami>90000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>102</HesapKodu><HesapAdi>BANKALAR</HesapAdi><BorcToplami>260000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>103</HesapKodu><HesapAdi>VERİLEN ÇEKLER</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>15000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>120</HesapKodu><HesapAdi>ALICILAR</HesapAdi><BorcToplami>140000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>131</HesapKodu><HesapAdi>ORTAKLARDAN ALACAKLAR</HesapAdi><BorcToplami>35000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>191</HesapKodu><HesapAdi>İNDİRİLECEK KDV</HesapAdi><BorcToplami>30000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>300</HesapKodu><HesapAdi>BANKA KREDİLERİ</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>72000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>320</HesapKodu><HesapAdi>SATICILAR</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>70000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>335</HesapKodu><HesapAdi>PERSONELE BORÇLAR</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>10000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>360</HesapKodu><HesapAdi>ÖDENECEK VERGİ VE FONLAR</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>20000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>391</HesapKodu><HesapAdi>HESAPLANAN KDV</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>52000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>500</HesapKodu><HesapAdi>SERMAYE</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>286000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>600</HesapKodu><HesapAdi>YURTİÇİ SATIŞLAR</HesapAdi><BorcToplami>0,00</BorcToplami><AlacakToplami>260000,00</AlacakToplami></Satir>
  <Satir><HesapKodu>620</HesapKodu><HesapAdi>SATILAN MAMULLER MALİYETİ</HesapAdi><BorcToplami>110000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
  <Satir><HesapKodu>770</HesapKodu><HesapAdi>GENEL YÖNETİM GİDERLERİ</HesapAdi><BorcToplami>35000,00</BorcToplami><AlacakToplami>0,00</AlacakToplami></Satir>
</Mizan>`;

    const imported = await importStatutoryMizan(
      pool,
      {
        asOfDate: "2026-07-31",
        periodLabel: "2026-07 Temmuz Yasal Mizan",
        sourceSoftware: "Logo",
        originalFilename: "logo_temmuz_2026.xml",
        buffer: Buffer.from(xmlMizan, "utf8"),
      },
      actorId,
    );

    expect(imported.isSelfBalanced).toBe(true);
    expect(imported.totalDebitTry).toBe(785000);
    expect(imported.totalCreditTry).toBe(785000);

    // Count management journal lines before reconciliation to prove zero mutation
    const mgmtCountBefore = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.management_journal_lines`,
    );

    const recon = await reconcileTrialBalance(pool, imported.trialBalanceId, actorId);

    const mgmtCountAfter = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.management_journal_lines`,
    );
    expect(mgmtCountAfter.rows[0].n).toBe(mgmtCountBefore.rows[0].n);

    // Verify all 12 deterministic root causes are classified positively
    const codes = new Map(recon.items.map((it) => [it.tdhpGroupCode, it]));

    expect(codes.get("100")?.rootCauseCode).toBe("CASH_100_INFLATION");
    expect(codes.get("100")?.deltaTry).toBe(-65000);

    expect(codes.get("101")?.rootCauseCode).toBe("CHECK_ENDORSEMENT_OR_CLEARING_LAG");
    expect(codes.get("101")?.deltaTry).toBe(-40000);

    expect(codes.get("102")?.rootCauseCode).toBe("UNBOOKED_BANK_TXN_OR_FX");
    expect(codes.get("102")?.deltaTry).toBe(40000);

    expect(codes.get("103")?.rootCauseCode).toBe("ISSUED_CHECK_NOT_DELIVERED_TO_CPA");
    expect(codes.get("103")?.deltaTry).toBe(20000);

    expect(codes.get("120")?.rootCauseCode).toBe("CUTOFF_UNBILLED_OR_UNALLOCATED_CASH");
    expect(codes.get("120")?.deltaTry).toBe(40000);

    expect(codes.get("131/331")?.rootCauseCode).toBe("PARTNER_ACCOUNT_PLUG");
    expect(codes.get("131/331")?.deltaTry).toBe(-35000);

    expect(codes.get("190/191/391")?.rootCauseCode).toBe("VAT_TAHAKKUK_UNCLOSED");
    expect(codes.get("190/191/391")?.deltaTry).toBe(-2000);

    expect(codes.get("300/400")?.rootCauseCode).toBe("LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT");
    expect(codes.get("300/400")?.deltaTry).toBe(8000);

    expect(codes.get("320")?.rootCauseCode).toBe("MISSING_PURCHASE_INVOICE");
    expect(codes.get("320")?.deltaTry).toBe(25000);

    expect(codes.get("335")?.rootCauseCode).toBe("PAYROLL_ADVANCE_OR_EXPENSE_GAP");
    expect(codes.get("335")?.deltaTry).toBe(15000);

    expect(codes.get("360/361")?.rootCauseCode).toBe("UNPAID_OR_RESTRUCTURED_TAX_DEBT");
    expect(codes.get("360/361")?.deltaTry).toBe(10000);

    expect(codes.get("EBITDA_690")?.rootCauseCode).toBe(
      "MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE",
    );

    // 3. Verify Management EBITDA <-> Statutory 690 Bridge math:
    // Management EBITDA = 140,000
    // Less D&A (770.99) = 15,000 -> EBIT = 125,000
    // Less Financing (780) = 8,000 -> Management 690 EBT = 117,000
    // Statutory 690 EBT = 260,000 (600) - 110,000 (620) - 35,000 (770) = 115,000
    const b = recon.ebitdaTo690Bridge;
    expect(b.managementEbitdaTry).toBe(140000);
    expect(b.lessManagementDepreciationTry).toBe(15000);
    expect(b.managementEbitTry).toBe(125000);
    expect(b.lessManagementFinancingTry).toBe(8000);
    expect(b.management690EbtTry).toBe(117000);
    expect(b.statutory690EbtTry).toBe(115000);
    expect(
      b.management690EbtTry +
        b.revenueTimingGapTry +
        b.expenseTimingGapTry +
        b.financingTimingGapTry +
        b.unexplainedBridgeResidualTry,
    ).toBe(b.statutory690EbtTry);

    // 4. Create an action_items task from the 100 Kasa discrepancy item
    const item100 = codes.get("100")!;
    const taskRes = await createActionFromReconciliationItem(pool, item100.id, actorId);
    expect(taskRes.actionItemId).toBeTruthy();

    const loaded = await loadReconciliationRun(pool, recon.runId);
    expect(loaded?.items.find((i) => i.tdhpGroupCode === "100")?.actionItemId).toBe(
      taskRes.actionItemId,
    );

    // 5. Generate the 3-sheet CPA ExcelJS export pack and verify all 3 sheets exist
    const xlsxBuf = await buildCpaReconciliationPackBuffer(loaded!);
    expect(xlsxBuf.byteLength).toBeGreaterThan(1000);

    const ExcelJSImport = await import("exceljs");
    const ExcelJS = ExcelJSImport.default ?? ExcelJSImport;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBuf as unknown as ArrayBuffer);
    const sheetNames = wb.worksheets.map((ws) => ws.name);
    expect(sheetNames).toEqual([
      "1_Ozet_Fark_Tablosu",
      "2_Eksik_Belge_Kanit_Listesi",
      "3_EBITDA_690_Koprusu",
    ]);
  });
});
