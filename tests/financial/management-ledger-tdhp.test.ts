import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptMatch } from "@/lib/bank/engine";
import { createCounterparty } from "@/lib/counterparties/engine";
import { executeCheckBordroTransition, loadCheckBordroTargets } from "@/lib/financing/check-bordro";
import { recordRate } from "@/lib/fx/engine";
import {
  cancelInvoice,
  changeInvoiceStatus,
  createInvoice,
  listInvoices,
  recordInvoicePayment,
} from "@/lib/invoices/engine";
import {
  createManagementSubAccount,
  inferTdhpClassification,
  loadManagementAccounts,
} from "@/lib/ledger/accounts";
import {
  approveDraftManagementEntry,
  discardDraftManagementEntry,
  loadManagementLedgerOverview,
  postManualManagementAdjustment,
  rebuildOrSyncManagementLedger,
  reverseManagementEntry,
  revalueProvisionalFxEntries,
  syncDomainEventToManagementLedger,
} from "@/lib/ledger/posting-engine";
import { loadPayableRunCandidates } from "@/lib/payments/payment-runs";
import { reverseAllocation } from "@/lib/receivables/engine";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";

describe.runIf(hasDisposableDb || requireDisposableDb)("Faz 52 (E2) — Çift Taraflı TDHP Yönetim Defteri, DEFERRABLE Denge, Mizan, Bilanço ve EBITDA", () => {
  let pool: Pool;
  let actorId = "";
  let customerPartyId = "";
  let vendorPartyId = "";
  let bankAccountId = "";

  beforeAll(async () => {
    const dbTarget = assertDisposableTargetDb(
      undefined,
      "Faz 52 (E2) management-ledger-tdhp test",
    );
    pool = new Pool({ connectionString: dbTarget.url, max: 2 });
    actorId = await ensureSystemActor(pool);

    // Clean any prior management journal entries on disposable DB
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`alter table public.management_journal_entries disable trigger user`);
      await client.query(`alter table public.management_journal_lines disable trigger user`);
      await client.query(`delete from public.management_journal_lines`);
      await client.query(`delete from public.management_journal_entries`);
      await client.query(`alter table public.management_journal_lines enable trigger user`);
      await client.query(`alter table public.management_journal_entries enable trigger user`);
      await client.query("commit");
    } finally {
      client.release();
    }

    const cust = await createCounterparty(
      pool,
      {
        name: "E2 Test Alıcı A.Ş.",
        partyType: "customer",
        taxNumber: "5252525251",
      },
      actorId,
    );
    customerPartyId = cust.partyId;

    const vend = await createCounterparty(
      pool,
      {
        name: "E2 Test Tedarikçi Ltd.",
        partyType: "vendor",
        taxNumber: "5252525252",
      },
      actorId,
    );
    vendorPartyId = vend.partyId;

    const ca = await pool.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance)
       values ('E2 Ana Banka TRY', 'bank_account', 'TRY', 250000.00)
       on conflict (name) do update set opening_balance = 250000.00
       returning id::text`,
    );
    bankAccountId = ca.rows[0].id;
    await pool.query(
      `insert into public.bank_accounts (cash_account_id, bank_name, iban)
       values ($1, 'Garanti BBVA', 'TR330006100519786457849999')
       on conflict (cash_account_id) do nothing`,
      [bankAccountId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("1) TDHP hesap planı tohumlarını ve alt hesap açma (120.01, 102.01) kurallarını doğrular", async () => {
    const accounts = await loadManagementAccounts(pool);
    const codes = new Set(accounts.map((a) => a.code));
    for (const required of [
      "100",
      "101.01",
      "101.02",
      "102",
      "103",
      "120",
      "191",
      "253",
      "257",
      "300",
      "320",
      "335",
      "360",
      "361",
      "391",
      "500",
      "600",
      "620",
      "632",
      "770",
      "770.99",
      "780",
      "900",
      "901",
    ]) {
      expect(codes.has(required)).toBe(true);
    }

    const sub = await createManagementSubAccount(
      pool,
      {
        code: "120.01",
        name: "Yurtiçi Kurumsal Alıcılar",
      },
      actorId,
    );
    expect(sub.code).toBe("120.01");
    expect(sub.parentCode).toBe("120");
    expect(sub.accountClass).toBe("asset");
    expect(sub.normalSide).toBe("debit");
    expect(sub.ebitdaBucket).toBe("balance_sheet");

    const daClass = inferTdhpClassification("770.99");
    expect(daClass.ebitdaBucket).toBe("da_addback");
  });

  it("2) DEFERRABLE denge tetikleyicisi borç ≠ alacak olan fişleri COMMIT anında 23514 ile reddeder", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const acc102 = await client.query<{ id: string }>(
        `select id::text from public.management_accounts where code = '102'`,
      );
      const acc500 = await client.query<{ id: string }>(
        `select id::text from public.management_accounts where code = '500'`,
      );

      const je = await client.query<{ id: string }>(
        `insert into public.management_journal_entries
           (entry_date, source_type, idempotency_key, status, description, created_by)
         values ('2026-06-01', 'manual_adjustment', 'test:unbalanced:1', 'posted', 'Dengesiz Fiş Testi', $1)
         returning id::text`,
        [actorId],
      );

      await client.query(
        `insert into public.management_journal_lines
           (entry_id, line_no, account_id, native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try)
         values
           ($1, 1, $2, 'TRY', 10000.00, 0, 1, 10000.00, 0),
           ($1, 2, $3, 'TRY', 0, 9500.00, 1, 0, 9500.00)`,
        [je.rows[0].id, acc102.rows[0].id, acc500.rows[0].id],
      );

      await expect(client.query("commit")).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("3) Kesinleşmiş (posted) fişin doğrudan UPDATE/DELETE girişimini reddeder ve ters kayıt (reversal) ile sıfırlar", async () => {
    const posted = await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-06-02",
        description: "Test tahakkuk fişi — ters kayıt denemesi",
        currency: "TRY",
        status: "posted",
        idempotencyKey: "test:immutable:1",
        lines: [
          { accountCode: "770", debitNative: 15000, creditNative: 0 },
          { accountCode: "320", debitNative: 0, creditNative: 15000 },
        ],
      },
      actorId,
    );
    expect(posted.status).toBe("posted");

    // Direct UPDATE on posted entry must fail with 23514
    await expect(
      pool.query(
        `update public.management_journal_entries set description = 'Tahrifat' where id = $1`,
        [posted.entryId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Direct DELETE on posted entry must fail with 23514
    await expect(
      pool.query(
        `delete from public.management_journal_entries where id = $1`,
        [posted.entryId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Direct UPDATE on posted line must fail with 23514
    await expect(
      pool.query(
        `update public.management_journal_lines set debit_try = 20000 where entry_id = $1 and line_no = 1`,
        [posted.entryId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // Reversal succeeds and nets 770 balance back to 0.00
    const rev = await reverseManagementEntry(
      pool,
      posted.entryId,
      "Hatalı tahakkuk stornosu",
      actorId,
    );
    expect(rev.reversalEntryId).toBeTruthy();

    const tb770 = await pool.query<{
      debit_total_try: string;
      credit_total_try: string;
      net_balance_try: string;
    }>(
      `select debit_total_try::text, credit_total_try::text, net_balance_try::text
         from public.management_trial_balance_v
        where account_code = '770'`,
    );
    expect(Number(tb770.rows[0].debit_total_try)).toBe(15000);
    expect(Number(tb770.rows[0].credit_total_try)).toBe(15000);
    expect(Number(tb770.rows[0].net_balance_try)).toBe(0);
  });

  it("4) Döviz kuru eksik (BLANK ≠ ZERO) işlemde 1.0 uydurmaz; provisional_fx yazar ve kur geldiğinde otomatik değerler", async () => {
    // Ensure no GBP rate on or before 2020-01-15
    await pool.query(
      `delete from public.fx_rate_snapshots where base_currency = 'GBP' and rate_date <= '2020-01-15'`,
    );

    const prov = await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2020-01-15",
        description: "GBP Danışmanlık Faturası (Kur Bekleyen)",
        currency: "GBP",
        status: "posted",
        idempotencyKey: "test:provisional:gbp:1",
        lines: [
          { accountCode: "632", debitNative: 1000, creditNative: 0 },
          { accountCode: "320", debitNative: 0, creditNative: 1000 },
        ],
      },
      actorId,
    );
    expect(prov.status).toBe("provisional_fx");

    const linesBefore = await pool.query<{ fx_rate: string | null; debit_try: string | null }>(
      `select fx_rate::text, debit_try::text
         from public.management_journal_lines
        where entry_id = $1
        order by line_no asc`,
      [prov.entryId],
    );
    expect(linesBefore.rows[0].fx_rate).toBeNull();
    expect(linesBefore.rows[0].debit_try).toBeNull();

    // Insert TCMB GBP rate for 2020-01-15 = 42.50 TRY
    await pool.query(
      `insert into public.fx_rate_snapshots (rate_date, base_currency, quote_currency, rate, source)
       values ('2020-01-15', 'GBP', 'TRY', 42.500000, 'tcmb')
       on conflict do nothing`,
    );

    const revOut = await revalueProvisionalFxEntries(pool, actorId);
    expect(revOut.revaluedCount).toBeGreaterThanOrEqual(1);

    const entryAfter = await pool.query<{ status: string }>(
      `select status from public.management_journal_entries where id = $1`,
      [prov.entryId],
    );
    expect(entryAfter.rows[0].status).toBe("posted");

    const linesAfter = await pool.query<{ debit_try: string; credit_try: string }>(
      `select debit_try::text, credit_try::text
         from public.management_journal_lines
        where entry_id = $1
        order by line_no asc`,
      [prov.entryId],
    );
    expect(Number(linesAfter.rows[0].debit_try)).toBe(42500);
    expect(Number(linesAfter.rows[1].credit_try)).toBe(42500);

    // Reverse this test entry so subsequent EBITDA assertions start from a clean slate
    await reverseManagementEntry(pool, prov.entryId, "GBP test temizliği", actorId);
  });

  it("5) Fatura, banka, çek bordrosu, kredi anapara/faiz (300/780) ve amortisman (770.99) kayıtlarından Mizan, Bilanço ve Yönetim EBITDA üretir", async () => {
    // 1) Sermaye açılış fişi: Borç 102 Bankalar 500,000 / Alacak 500 Sermaye 500,000
    await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-06-01",
        description: "Açılış Sermaye Fişi",
        currency: "TRY",
        status: "posted",
        idempotencyKey: "e2:opening:capital",
        lines: [
          { accountCode: "102", debitNative: 500000, creditNative: 0 },
          { accountCode: "500", debitNative: 0, creditNative: 500000 },
        ],
      },
      actorId,
    );

    // 2) Satış faturası: Net 200,000 + KDV 40,000 = Brüt 240,000 TRY
    const salesInv = await pool.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, status)
       values ('sales', 'E2-SLS-001', $1, '2026-06-05', '2026-07-05', 'TRY',
               200000.00, 40000.00, 240000.00, 240000.00, 0, 'open')
       returning id::text`,
      [customerPartyId],
    );
    await syncDomainEventToManagementLedger(
      pool,
      { kind: "invoice", invoiceId: salesInv.rows[0].id },
      actorId,
    );

    // 3) Satılan mamul maliyeti alış faturası (620): Net 80,000 + KDV 16,000 = Brüt 96,000 TRY
    const cogsInv = await pool.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, status)
       values ('purchase', 'E2-PUR-001', $1, '2026-06-06', '2026-07-06', 'TRY',
               80000.00, 16000.00, 96000.00, 96000.00, 0, 'open')
       returning id::text`,
      [vendorPartyId],
    );
    await syncDomainEventToManagementLedger(
      pool,
      { kind: "invoice", invoiceId: cogsInv.rows[0].id, expenseAccountCode: "620" },
      actorId,
    );

    // 4) Satırsız basit çalışan harcama fişi (S-6 BLANK ≠ ZERO & S-7 335 Personele Borçlar): Brüt 5,000 TRY (net=NULL, tax=NULL)
    const empBill = await pool.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, payable_amount, paid_amount, status, spender_employee_name)
       values ('purchase', 'E2-EMP-001', $1, '2026-06-07', '2026-06-15', 'TRY',
               null, null, 5000.00, 5000.00, 0, 'open', 'Selim Demir')
       returning id::text`,
      [vendorPartyId],
    );
    const empOut = await syncDomainEventToManagementLedger(
      pool,
      { kind: "invoice", invoiceId: empBill.rows[0].id, expenseAccountCode: "770" },
      actorId,
    );
    expect(empOut?.needsTaxSplitReview).toBe(true);

    // 5) Kredi kullanımı (100,000 TRY: Borç 102 / Alacak 300) ve kredi taksit ödemesi (Anapara 20,000 + Faiz/BSMV 4,500 = 24,500 TRY)
    await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-06-08",
        description: "Banka Kredisi Kullanımı",
        currency: "TRY",
        status: "posted",
        idempotencyKey: "e2:loan:drawdown",
        lines: [
          { accountCode: "102", debitNative: 100000, creditNative: 0 },
          { accountCode: "300", debitNative: 0, creditNative: 100000 },
        ],
      },
      actorId,
    );

    const loanRes = await pool.query<{ id: string }>(
      `insert into public.loans
         (name, principal, total_payment, currency, first_payment_date, installment_count, status)
       values ('E2 İşletme Kredisi', 100000.00, 120000.00, 'TRY', '2026-06-08', 5, 'active')
       returning id::text`,
    );
    const instRes = await pool.query<{ id: string }>(
      `insert into public.loan_installments
         (loan_id, installment_no, due_date, amount, principal_component, interest_component, tax_component, status, paid_at)
       values ($1, 1, '2026-06-15', 24500.00, 20000.00, 4000.00, 500.00, 'paid', '2026-06-15T10:00:00Z')
       returning id::text`,
      [loanRes.rows[0].id],
    );
    await syncDomainEventToManagementLedger(
      pool,
      { kind: "loan_installment", installmentId: instRes.rows[0].id },
      actorId,
    );

    // 6) Çek bordrosu: müşteri çeki alımı (40,000 TRY) ve tedarikçiye ciro (40,000 TRY + 900/901 nazım rücu)
    const bordroIn = await pool.query<{ id: string }>(
      `insert into public.check_bordros
         (bordro_no, bordro_type, bordro_date, target_party_id, currency, total_amount, created_by)
       values ('E2-BRD-IN-01', 'customer_receipt', '2026-06-10', $1, 'TRY', 40000.00, $2)
       returning id::text`,
      [customerPartyId, actorId],
    );
    await syncDomainEventToManagementLedger(
      pool,
      { kind: "check_bordro", bordroId: bordroIn.rows[0].id },
      actorId,
    );

    const bordroEndorse = await pool.query<{ id: string }>(
      `insert into public.check_bordros
         (bordro_no, bordro_type, bordro_date, target_party_id, currency, total_amount, created_by)
       values ('E2-BRD-END-01', 'vendor_endorsement', '2026-06-12', $1, 'TRY', 40000.00, $2)
       returning id::text`,
      [vendorPartyId, actorId],
    );
    await syncDomainEventToManagementLedger(
      pool,
      { kind: "check_bordro", bordroId: bordroEndorse.rows[0].id },
      actorId,
    );

    // 7) Dönem sonu amortisman tahakkuku (770.99 Borç 12,000 / 257 Birikmiş Amortisman Alacak 12,000) — draft -> approve
    const depDraft = await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-06-30",
        description: "Haziran 2026 Amortisman Tahakkuku (D&A)",
        currency: "TRY",
        status: "draft",
        idempotencyKey: "e2:depreciation:2026-06",
        lines: [
          { accountCode: "770.99", debitNative: 12000, creditNative: 0 },
          { accountCode: "257", debitNative: 0, creditNative: 12000 },
        ],
      },
      actorId,
    );
    expect(depDraft.status).toBe("draft");
    await approveDraftManagementEntry(pool, depDraft.entryId, actorId);

    // 8) Idempotency check: re-syncing same events creates 0 duplicate entries
    const secondSalesSync = await syncDomainEventToManagementLedger(
      pool,
      { kind: "invoice", invoiceId: salesInv.rows[0].id },
      actorId,
    );
    expect(secondSalesSync?.created).toBe(false);

    // 9) Verify Trial Balance, Income Statement / Management EBITDA, and Balance Sheet
    const overview = await loadManagementLedgerOverview(pool);

    // Mizan Borç Toplamı == Alacak Toplamı (0.00 kuruş farkı)
    expect(overview.totalDebitTry).toBe(overview.totalCreditTry);
    expect(overview.totalDebitBalanceTry).toBe(overview.totalCreditBalanceTry);

    // Gelir Tablosu & Yönetim EBITDA Şelalesi:
    //   Net Satışlar (600)           = 200,000
    //   Satışların Maliyeti (620)    = -80,000
    //   Brüt Kâr                     = 120,000
    //   Nakit Faaliyet Gideri (770)  =  -5,000
    //   Amortisman (770.99)          = -12,000
    //   Toplam Faaliyet Gideri       = -17,000
    //   EBIT (Faaliyet Kârı)         = 103,000
    //   Yönetim EBITDA (EBIT + D&A)  = 115,000
    //   Finansman Gideri (780)       =  -4,500
    //   Vergi Öncesi Kâr (690/EBT)   =  98,500
    expect(overview.incomeStatement.netSalesTry).toBe(200000);
    expect(overview.incomeStatement.cogsTry).toBe(80000);
    expect(overview.incomeStatement.grossProfitTry).toBe(120000);
    expect(overview.incomeStatement.opexCashTry).toBe(5000);
    expect(overview.incomeStatement.daAddbackTry).toBe(12000);
    expect(overview.incomeStatement.opexTotalTry).toBe(17000);
    expect(overview.incomeStatement.ebitTry).toBe(103000);
    expect(overview.incomeStatement.managementEbitdaTry).toBe(115000);
    expect(overview.incomeStatement.financingExpenseTry).toBe(4500);
    expect(overview.incomeStatement.ebtTry).toBe(98500);
    expect(overview.incomeStatement.netIncomeTry).toBe(98500);

    // Yönetim Bilançosu: Aktif Toplamı == Pasif (Yabancı Kaynak + Özkaynak) Toplamı (0.00 kuruş farkı!)
    expect(overview.totalAssetsTry).toBe(overview.totalLiabilitiesAndEquityTry);
    expect(overview.totalAssetsTry).toBeGreaterThan(0);

    // Bulk idempotent sync check
    const bulk1 = await rebuildOrSyncManagementLedger(pool, actorId);
    const bulk2 = await rebuildOrSyncManagementLedger(pool, actorId);
    expect(bulk1.createdCount).toBeGreaterThanOrEqual(0);
    expect(bulk2.createdCount).toBe(0);
  });

  it("Dalga 3 (F-23..F-30): satır-içi tahsisat birleşimi, tevkifat tam kapanışı, söz kapanışı, ters storno, 102 çift sayım koruması, keşide çek 103/102 ve otomatik kur değerleme", async () => {
    // 1. F-23: Satır-içi kısmi ödeme hem paid_amount hem allocated_amount'u günceller, kalan borç 6.000 TL görünür
    const purch = await createInvoice(
      pool,
      {
        direction: "purchase",
        invoiceNo: "W3-ALIS-001",
        partyId: vendorPartyId,
        issueDate: "2026-06-01",
        dueDate: "2026-06-15",
        currency: "TRY",
        lines: [{ description: "Hammadde alımı", quantity: 1, unitPrice: 10000, taxRate: 0 }],
      },
      actorId,
    );
    await changeInvoiceStatus(pool, { invoiceId: purch.invoiceId, status: "open" }, actorId);

    // F-29: Fatura 'open' olduğunda yönetim defterine anında fiş düşmüş olmalı
    const autoInvJe = await pool.query<{ id: string; status: string }>(
      `select id::text, status from public.management_journal_entries where source_type = 'invoice' and source_id = $1`,
      [purch.invoiceId],
    );
    expect(autoInvJe.rowCount).toBe(1);
    expect(autoInvJe.rows[0].status).toBe("posted");

    await recordInvoicePayment(pool, { invoiceId: purch.invoiceId, amount: 4000 }, actorId);
    const purchCheck = await pool.query<{ paid_amount: string; allocated_amount: string; status: string }>(
      `select paid_amount::text, allocated_amount::text, status from public.invoices where id = $1`,
      [purch.invoiceId],
    );
    expect(Number(purchCheck.rows[0].paid_amount)).toBe(4000);
    expect(Number(purchCheck.rows[0].allocated_amount)).toBe(4000);
    expect(purchCheck.rows[0].status).toBe("partial");

    const listed = await listInvoices(pool, { direction: "purchase", limit: 20 });
    expect(listed.find((i) => i.id === purch.invoiceId)?.remaining).toBe(6000);
    const runCands = await loadPayableRunCandidates(pool, "TRY", 50);
    expect(runCands.find((c) => c.targetId === purch.invoiceId)?.openAmount).toBe(6000);
    const bordroTargets = await loadCheckBordroTargets(pool);
    expect(bordroTargets.openPurchaseInvoices.find((i) => i.id === purch.invoiceId)?.openAmount).toBe(6000);

    // 2. F-24 & F-25: Tevkifatlı satış faturası payable_amount kapanınca 'paid' olur ve bağlı promise_to_pay 'kept' olur
    const withhInv = await pool.query<{ id: string }>(
      `insert into public.invoices
         (direction, invoice_no, party_id, issue_date, due_date, currency,
          net_amount, tax_amount, gross_amount, vat_withholding_amount, payable_amount,
          status, dedupe_hash)
       values
         ('sales', 'W3-TEVKIFAT-001', $1, '2026-06-02', '2026-06-10', 'TRY',
          10000.00, 2000.00, 12000.00, 1000.00, 11000.00,
          'open', 'w3-tevkifat-001')
       returning id::text`,
      [customerPartyId],
    );
    const withhInvId = withhInv.rows[0].id;
    const ptp = await pool.query<{ id: string }>(
      `insert into public.promise_to_pay
         (party_id, invoice_id, promised_date, promised_amount, currency, status, created_by)
       values ($1, $2, '2026-06-10', 11000.00, 'TRY', 'pending', $3)
       returning id::text`,
      [customerPartyId, withhInvId, actorId],
    );

    await recordInvoicePayment(pool, { invoiceId: withhInvId, amount: 11000 }, actorId);
    const withhAfter = await pool.query<{ status: string; allocated_amount: string }>(
      `select status, allocated_amount::text from public.invoices where id = $1`,
      [withhInvId],
    );
    expect(withhAfter.rows[0].status).toBe("paid");
    expect(Number(withhAfter.rows[0].allocated_amount)).toBe(11000);

    const ptpAfter = await pool.query<{ status: string; resolution_source: string }>(
      `select status, resolution_source from public.promise_to_pay where id = $1`,
      [ptp.rows[0].id],
    );
    expect(ptpAfter.rows[0].status).toBe("kept");
    expect(ptpAfter.rows[0].resolution_source).toBe("auto_detection");

    // 3. F-28: Fatura iptali otomatik ters fiş (storno) üretir; F-55: draft fiş silinebilir
    const cancellableInv = await createInvoice(
      pool,
      {
        direction: "sales",
        invoiceNo: "W3-IPTAL-001",
        partyId: customerPartyId,
        issueDate: "2026-06-03",
        currency: "TRY",
        lines: [{ description: "İptal edilecek danışmanlık", quantity: 1, unitPrice: 5000, taxRate: 20 }],
      },
      actorId,
    );
    await changeInvoiceStatus(pool, { invoiceId: cancellableInv.invoiceId, status: "open" }, actorId);
    await cancelInvoice(pool, { invoiceId: cancellableInv.invoiceId, reason: "Müşteri siparişi iptal etti" }, actorId);

    const cancelledJe = await pool.query<{ status: string; reversed_by_entry_id: string | null }>(
      `select status, reversed_by_entry_id::text
         from public.management_journal_entries
        where source_type = 'invoice' and source_id = $1`,
      [cancellableInv.invoiceId],
    );
    expect(cancelledJe.rows[0].status).toBe("reversed");
    expect(cancelledJe.rows[0].reversed_by_entry_id).toBeTruthy();

    const draftJe = await postManualManagementAdjustment(
      pool,
      {
        entryDate: "2026-06-03",
        description: "Silinecek taslak fiş",
        currency: "TRY",
        status: "draft",
        lines: [
          { accountCode: "770", debitNative: 1000 },
          { accountCode: "320", creditNative: 1000 },
        ],
      },
      actorId,
    );
    await discardDraftManagementEntry(pool, draftJe.entryId, actorId);
    const draftCheck = await pool.query(`select 1 from public.management_journal_entries where id = $1`, [draftJe.entryId]);
    expect(draftCheck.rowCount).toBe(0);

    // 4. F-25 & F-28: Banka eşleştirmesiyle tahsilat -> reverseAllocation -> bank_transactions 'unmatched' + ters fiş
    const bankInv = await createInvoice(
      pool,
      {
        direction: "sales",
        invoiceNo: "W3-BANKA-001",
        partyId: customerPartyId,
        issueDate: "2026-06-04",
        currency: "TRY",
        lines: [{ description: "Banka tahsilat testi", quantity: 1, unitPrice: 8000, taxRate: 0 }],
      },
      actorId,
    );
    await changeInvoiceStatus(pool, { invoiceId: bankInv.invoiceId, status: "open" }, actorId);
    const btIn = await pool.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, amount, currency, description, status, dedupe_hash)
       values ($1, '2026-06-04', 8000.00, 'TRY', 'W3-BANKA-001 Tahsilat', 'unmatched', 'w3-bt-in-8000')
       returning id::text`,
      [bankAccountId],
    );
    await acceptMatch(
      pool,
      { transactionId: btIn.rows[0].id, targetTable: "invoices", targetId: bankInv.invoiceId },
      actorId,
    );
    const btMatched = await pool.query<{ status: string; settled_allocation_id: string }>(
      `select status, settled_allocation_id::text from public.bank_transactions where id = $1`,
      [btIn.rows[0].id],
    );
    expect(btMatched.rows[0].status).toBe("matched");

    await reverseAllocation(
      pool,
      { allocationId: btMatched.rows[0].settled_allocation_id, reason: "Hatalı eşleştirme geri alındı" },
      actorId,
    );
    const btUnmatched = await pool.query<{ status: string }>(
      `select status from public.bank_transactions where id = $1`,
      [btIn.rows[0].id],
    );
    expect(btUnmatched.rows[0].status).toBe("unmatched");
    const btJeAfterRev = await pool.query<{ status: string }>(
      `select status from public.management_journal_entries where source_type = 'bank_transaction' and source_id = $1`,
      [btIn.rows[0].id],
    );
    expect(btJeAfterRev.rows[0].status).toBe("reversed");

    // 5. F-26: Ignored banka hareketi deftere sızmaz
    const btIgnored = await pool.query<{ id: string }>(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, amount, currency, description, status, ignored_reason, dedupe_hash)
       values ($1, '2026-06-04', -999.00, 'TRY', 'Test mükerrer satır', 'ignored', 'Mükerrer satır', 'w3-bt-ignored')
       returning id::text`,
      [bankAccountId],
    );
    const ignoredSync = await syncDomainEventToManagementLedger(
      pool,
      { kind: "bank_transaction", bankTransactionId: btIgnored.rows[0].id },
      actorId,
    );
    expect(ignoredSync).toBeNull();

    // 6. F-27: Keşide çek (outflow / own_issue) ödemesi Borç 103 / Alacak 102 keser
    const ownChk = await pool.query<{ id: string }>(
      `insert into public.checks
         (direction, instrument_type, status, amount, currency, maturity_date, serial_no, payee_party_id, counterparty_label)
       values ('outflow', 'check', 'planned', 15000.00, 'TRY', '2026-06-20', 'W3-KESIDE-001', $1, 'E2 Test Satıcı')
       returning id::text`,
      [vendorPartyId],
    );
    const issueBordro = await executeCheckBordroTransition(
      pool,
      {
        operation: "issue_own_check",
        bordroDate: "2026-06-05",
        checkIds: [ownChk.rows[0].id],
        targetPartyId: vendorPartyId,
      },
      actorId,
    );
    expect(issueBordro.nextStatus).toBe("issued_to_vendor");

    const settleOwnBordro = await executeCheckBordroTransition(
      pool,
      {
        operation: "mark_cleared",
        bordroDate: "2026-06-20",
        checkIds: [ownChk.rows[0].id],
      },
      actorId,
    );
    expect(settleOwnBordro.nextStatus).toBe("cleared");

    const settleLines = await pool.query<{ code: string; debit_try: string; credit_try: string }>(
      `select ma.code, jl.debit_try::text, jl.credit_try::text
         from public.management_journal_entries je
         join public.management_journal_lines jl on jl.entry_id = je.id
         join public.management_accounts ma on ma.id = jl.account_id
        where je.source_type = 'check_bordro' and je.source_id = $1
        order by jl.line_no asc`,
      [settleOwnBordro.bordroId],
    );
    expect(settleLines.rows).toEqual([
      { code: "103", debit_try: "15000.00", credit_try: "0.00" },
      { code: "102", debit_try: "0.00", credit_try: "15000.00" },
    ]);

    // 7. F-30: recordRate çağrısı kur bekleyen provisional_fx fişleri otomatik 'posted' durumuna taşır
    const chfInv = await createInvoice(
      pool,
      {
        direction: "sales",
        invoiceNo: "W3-CHF-001",
        partyId: customerPartyId,
        issueDate: "2026-06-25",
        currency: "CHF",
        lines: [{ description: "CHF ihracat danışmanlığı", quantity: 1, unitPrice: 1000, taxRate: 0 }],
      },
      actorId,
    );
    await changeInvoiceStatus(pool, { invoiceId: chfInv.invoiceId, status: "open" }, actorId);
    const chfBefore = await pool.query<{ status: string }>(
      `select status from public.management_journal_entries where source_type = 'invoice' and source_id = $1`,
      [chfInv.invoiceId],
    );
    expect(chfBefore.rows[0].status).toBe("provisional_fx");

    await recordRate(
      pool,
      {
        baseCurrency: "CHF",
        quoteCurrency: "TRY",
        rateDate: "2026-06-25",
        rate: 39.85,
        source: "manual",
      },
      actorId,
    );
    const chfAfter = await pool.query<{ status: string }>(
      `select status from public.management_journal_entries where source_type = 'invoice' and source_id = $1`,
      [chfInv.invoiceId],
    );
    expect(chfAfter.rows[0].status).toBe("posted");

    // Tüm mizan ve bilanço kuruşu kuruşuna dengede kalmalı
    const finalOverview = await loadManagementLedgerOverview(pool);
    expect(finalOverview.totalDebitTry).toBe(finalOverview.totalCreditTry);
    expect(finalOverview.totalAssetsTry).toBe(finalOverview.totalLiabilitiesAndEquityTry);
  });
});
