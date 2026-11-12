// Faz 51 (E1) — Paraşüt API v4 Read-Only Connector (S-1..S-10) & Hybrid Bank Pipeline (MT940 / camt.053 / Cross-Channel Dedupe) test suite.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCounterparty } from "@/lib/counterparties/engine";
import {
  importHybridBankStatement,
  parseCamt053Statement,
  parseMt940Statement,
} from "@/lib/importers/bank-formats/mt940-camt053-parasut";
import {
  assertParasutV4GetOnly,
  computeWatermarkOverlapFrom,
} from "@/lib/integrations/parasut/client";
import {
  computeCrossChannelDedupeHash,
  normalizeParasutCurrency,
  parasutConnector,
} from "@/lib/integrations/parasut/mappers";
import {
  acquireParasutAccessToken,
  clearParasutTokenCache,
} from "@/lib/integrations/parasut/oauth";
import { ParasutRateLimiter } from "@/lib/integrations/parasut/rate-limiter";
import { mockHttpClient, type HttpRequest, type HttpResponse } from "@/lib/integrations/types";
import { assertDisposableTargetDb } from "../../scripts/db/disposable-guard";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { ensureSystemActor } from "../../scripts/db/seed-system-actor";

const candidateDbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const hasDisposableDb = isDisposableDatabaseName(databaseNameFromUrl(candidateDbUrl));
const requireDisposableDb = process.env.MAS_REQUIRE_DISPOSABLE_DB_TEST === "1";
const runDbIntegration = hasDisposableDb || requireDisposableDb;

describe("Faz 51 (E1) — Paraşüt API v4 Salt-Okunur Konnektörü ve Hibrit Banka Tekilleştirme Hattı", () => {
  let pool!: Pool;
  let actorId = "";
  let bankAccountAId = "00000000-0000-4000-8000-000000000001";
  let bankAccountBId = "00000000-0000-4000-8000-000000000002";
  let connectionId = "00000000-0000-4000-8000-000000000051";

  beforeAll(async () => {
    if (!runDbIntegration) return;
    const dbTarget = assertDisposableTargetDb(undefined, "parasut-v4-and-hybrid-bank.test");
    pool = new Pool({ connectionString: dbTarget.url, max: 2 });
    actorId = await ensureSystemActor(pool);

    // Clean any prior test fixtures
    await pool.query(`delete from public.integration_entity_links where provider = 'parasut'`);
    await pool.query(`delete from public.integration_account_mappings where provider = 'parasut'`);
    await pool.query(`delete from public.integration_staged_parties where provider = 'parasut'`);

    // Create 2 MAS bank accounts for inter-account transfer (S-8) and hybrid statement tests
    const caA = await pool.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance)
       values ('E1 Garanti TRY', 'bank_account', 'TRY', 100000.00)
       on conflict (name) do update set opening_balance = 100000.00
       returning id::text`,
    );
    bankAccountAId = caA.rows[0].id;
    await pool.query(
      `insert into public.bank_accounts (cash_account_id, bank_name, iban)
       values ($1, 'Garanti BBVA', 'TR330006100519786457841326')
       on conflict (cash_account_id) do update set iban = excluded.iban`,
      [bankAccountAId],
    );

    const caB = await pool.query<{ id: string }>(
      `insert into public.cash_accounts (name, account_type, currency, opening_balance)
       values ('E1 İş Bankası TRY', 'bank_account', 'TRY', 50000.00)
       on conflict (name) do update set opening_balance = 50000.00
       returning id::text`,
    );
    bankAccountBId = caB.rows[0].id;
    await pool.query(
      `insert into public.bank_accounts (cash_account_id, bank_name, iban)
       values ($1, 'İş Bankası', 'TR640006400000112345678901')
       on conflict (cash_account_id) do update set iban = excluded.iban`,
      [bankAccountBId],
    );

    // Create known customer & supplier via canonical createCounterparty gateway
    await createCounterparty(
      pool,
      {
        name: "E1 Bilinen Müşteri A.Ş.",
        partyType: "customer",
        taxNumber: "1234567890",
      },
      actorId,
    );
    await createCounterparty(
      pool,
      {
        name: "E1 Bilinen Tedarikçi Ltd.",
        partyType: "vendor",
        taxNumber: "9876543210",
      },
      actorId,
    );

    const connRes = await pool.query<{ id: string }>(
      `insert into public.integration_connections
         (integration_kind, name, provider, status, config, created_by)
       values ('accounting', 'E1 Paraşüt Ana Bağlantı', 'parasut', 'enabled', '{"companyId":"10500"}'::jsonb, $1)
       on conflict (integration_kind, name) do update set status = 'enabled'
       returning id::text`,
      [actorId],
    );
    connectionId = connRes.rows[0].id;
  });

  afterAll(async () => {
    clearParasutTokenCache();
    if (pool) await pool.end();
  });

  it("salt-okunur v4 güvenlik muhafızı https://api.parasut.com dışındaki adresleri ve GET dışındaki metodları reddeder", () => {
    expect(() =>
      assertParasutV4GetOnly("https://api.parasut.com/v4/10500/sales_invoices?page[number]=1", "GET"),
    ).not.toThrow();
    expect(() =>
      assertParasutV4GetOnly("https://evil.example.com/v4/10500/sales_invoices", "GET"),
    ).toThrow(/yalnız https:\/\/api\.parasut\.com/);
    expect(() =>
      assertParasutV4GetOnly(
        "https://api.parasut.com/v4/10500/sales_invoices",
        "POST" as unknown as "GET",
      ),
    ).toThrow(/yalnız GET/);
    expect(normalizeParasutCurrency("TRL")).toBe("TRY");
    expect(normalizeParasutCurrency("USD")).toBe("USD");
    expect(
      computeWatermarkOverlapFrom("2026-10-16T12:00:00.000Z", "2026-10-16"),
    ).toBe("2026-10-15T12:00:00.000Z");
  });

  it("ParasutRateLimiter 8 istek / 10 sn sınırını ve HTTP 429 Retry-After geri çekilmesini uygular", async () => {
    let fakeNow = 1_000_000;
    const sleeps: number[] = [];
    const limiter = new ParasutRateLimiter({
      maxRequestsPerWindow: 2,
      windowMs: 10_000,
      now: () => fakeNow,
      sleep: async (ms) => {
        sleeps.push(ms);
        fakeNow += ms;
      },
    });

    let calls = 0;
    const http = mockHttpClient((): HttpResponse => {
      calls += 1;
      if (calls === 2) {
        return {
          ok: false,
          status: 429,
          body: "",
          headers: { "retry-after": "3" },
        };
      }
      return { ok: true, status: 200, body: '{"data":[]}', headers: {} };
    });

    const r1 = await limiter.send(http, { url: "https://api.parasut.com/v4/10500/contacts" });
    const r2 = await limiter.send(http, { url: "https://api.parasut.com/v4/10500/accounts" });
    const r3 = await limiter.send(http, { url: "https://api.parasut.com/v4/10500/taxes" });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    // 1st sleep is 3000ms from HTTP 429 Retry-After: 3; 2nd sleep is window wait for >2 reqs/10s
    expect(sleeps[0]).toBe(3000);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("OAuth 2.0 password ve refresh_token akışını tek uçuş kilidiyle yönetir", async () => {
    clearParasutTokenCache();
    let oauthCalls = 0;
    const http = mockHttpClient((req: HttpRequest): HttpResponse => {
      if (req.url === "https://api.parasut.com/oauth/token") {
        oauthCalls += 1;
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            access_token: `tok_${oauthCalls}`,
            refresh_token: `ref_${oauthCalls}`,
            expires_in: 7200,
          }),
        };
      }
      return { ok: false, status: 404, body: "" };
    });

    const credJson = JSON.stringify({
      companyId: "10500",
      clientId: "cid_test",
      clientSecret: "csec_test",
      username: "cfo@mas.local",
      password: "secret_password",
    });

    const ctx = {
      connectionId,
      config: { companyId: "10500" },
      credential: credJson,
      http,
      asOfISO: "2026-10-20",
    };

    const [t1, t2] = await Promise.all([
      acquireParasutAccessToken(ctx),
      acquireParasutAccessToken(ctx),
    ]);
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    expect(t1.accessToken).toBe("tok_1");
    expect(t2.accessToken).toBe("tok_1");
    expect(oauthCalls).toBe(1);
  });

  it.skipIf(!runDbIntegration)(
    "MT940 ve camt.053 banka hareketleri içeri alındıktan sonra Paraşüt API v4 senkronu çalıştığında S-1..S-10 kurallarını ve çapraz-kanal tekilleştirmeyi eksiksiz doğrular",
    async () => {
    clearParasutTokenCache();

    // 1) Önce MT940 ile 15 Ekim 2026 tarihli -1.500,50 TRY banka hareketini içeri al
    const mt940Sample = [
      ":20:STMT20261015",
      ":25:TR330006100519786457841326",
      ":28C:00001/001",
      ":60F:C261001TRY100000,00",
      ":61:2610151015D1500,50NTRFNONREF//BNKREF901",
      ":86:TEDARIKCI ODEMESI BNKREF901",
      ":62F:C261015TRY98499,50",
    ].join("\n");

    const parsedMt = parseMt940Statement(mt940Sample);
    expect(parsedMt.ok).toBe(true);
    if (parsedMt.ok) {
      expect(parsedMt.lines).toHaveLength(1);
      expect(parsedMt.lines[0].amount).toBe(-1500.5);
      expect(parsedMt.lines[0].referenceNo).toBe("BNKREF901");
    }

    const mtImport = await importHybridBankStatement(pool, {
      buf: Buffer.from(mt940Sample, "utf8"),
      filename: "garanti-2026-10-15.mt940",
      bankAccountId: bankAccountAId,
      actorId,
    });
    expect(mtImport.ok).toBe(true);
    expect(mtImport.inserted).toBe(1);

    // 2) ISO 20022 camt.053 XML ile 16 Ekim 2026 tarihli +8.250,00 TRY müşteri tahsilatını içeri al
    const camtXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Acct>
        <Id><IBAN>TR330006100519786457841326</IBAN></Id>
        <Ccy>TRY</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="TRY">8250.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-10-16</Dt></BookgDt>
        <ValDt><Dt>2026-10-16</Dt></ValDt>
        <AcctSvcrRef>CAMTREF777</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Dbtr><Nm>E1 Bilinen Müşteri A.Ş.</Nm></Dbtr>
            </RltdPties>
            <RmtInf><Ustrd>Fatura Tahsilatı</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

    const parsedCamt = parseCamt053Statement(camtXml);
    expect(parsedCamt.ok).toBe(true);
    const camtImport = await importHybridBankStatement(pool, {
      buf: Buffer.from(camtXml, "utf8"),
      filename: "garanti-2026-10-16.xml",
      bankAccountId: bankAccountAId,
      actorId,
    });
    expect(camtImport.ok).toBe(true);
    expect(camtImport.inserted).toBe(1);

    // 3) Şimdi Paraşüt API v4 senkronunu çalıştır (1. Koşu: e-Fatura henüz taslak!)
    let formalizeEInvoice = false;

    const buildParasutHttp = () =>
      mockHttpClient((req: HttpRequest): HttpResponse => {
        if (req.url === "https://api.parasut.com/oauth/token") {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              access_token: "parasut_live_test_token",
              refresh_token: "parasut_refresh_token",
              expires_in: 7200,
            }),
          };
        }

        const u = new URL(req.url);
        const path = u.pathname;

        if (path.endsWith("/contacts")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  id: "c_known_cust",
                  type: "contacts",
                  attributes: {
                    name: "E1 Bilinen Müşteri A.Ş.",
                    tax_number: "1234567890",
                    account_type: "customer",
                    updated_at: "2026-10-18T10:00:00Z",
                  },
                },
                {
                  id: "c_known_supp",
                  type: "contacts",
                  attributes: {
                    name: "E1 Bilinen Tedarikçi Ltd.",
                    tax_number: "9876543210",
                    account_type: "supplier",
                    updated_at: "2026-10-18T10:00:00Z",
                  },
                },
                {
                  // S-10: Tanınmayan yeni cari -> integration_staged_parties tablosuna düşmeli, parties'e yazılmamalı!
                  id: "c_unknown_new",
                  type: "contacts",
                  attributes: {
                    name: "E1 Yepyeni Tanınmayan Tedarikçi A.Ş.",
                    tax_number: "5554443322",
                    account_type: "supplier",
                    updated_at: "2026-10-18T10:05:00Z",
                  },
                },
              ],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/accounts")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  id: "acc_garanti",
                  type: "accounts",
                  attributes: {
                    name: "E1 Garanti TRY",
                    currency: "TRL", // S-2: TRL -> TRY
                    account_type: "bank",
                    iban: "TR330006100519786457841326",
                    updated_at: "2026-10-18T09:00:00Z",
                  },
                },
                {
                  id: "acc_isbank",
                  type: "accounts",
                  attributes: {
                    name: "E1 İş Bankası TRY",
                    currency: "TRL",
                    account_type: "bank",
                    iban: "TR640006400000112345678901",
                    updated_at: "2026-10-18T09:00:00Z",
                  },
                },
              ],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/sales_invoices")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  // S-3: Teklif (estimate) -> kesinlikle atlanmalı!
                  id: "sinv_estimate_1",
                  type: "sales_invoices",
                  attributes: {
                    item_type: "estimate",
                    issue_date: "2026-10-17",
                    gross_total: "50000.00",
                    currency: "TRL",
                    updated_at: "2026-10-18T11:00:00Z",
                  },
                  relationships: {
                    contact: { data: { id: "c_known_cust", type: "contacts" } },
                  },
                },
                {
                  // S-4 & S-5: Tevkifatlı e-Fatura (1. koşuda GİB numarası yok -> 'draft', 2. koşuda GİB numarası var -> 'open')
                  id: "sinv_tevkifat_9002",
                  type: "sales_invoices",
                  attributes: {
                    item_type: "invoice",
                    issue_date: "2026-10-17",
                    due_date: "2026-10-28",
                    currency: "TRL", // S-2: TRL -> TRY
                    net_total_without_tax: "10000.00",
                    total_vat: "2000.00",
                    gross_total: "12000.00",
                    vat_withholding: "1000.00", // S-5: KDV tevkifatı
                    payable_amount: "11000.00", // S-5: Tahsil edilecek gerçek nakit 11.000 TL!
                    total_paid: "0.00",
                    updated_at: "2026-10-18T12:00:00Z",
                  },
                  relationships: {
                    contact: { data: { id: "c_known_cust", type: "contacts" } },
                    ...(formalizeEInvoice
                      ? {
                          active_e_document: {
                            data: { id: "edoc_9002", type: "e_invoices" },
                          },
                        }
                      : {}),
                  },
                },
              ],
              included: formalizeEInvoice
                ? [
                    {
                      id: "edoc_9002",
                      type: "e_invoices",
                      attributes: {
                        legal_number: "GIB2026000009002",
                      },
                    },
                  ]
                : [],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/purchase_bills")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  // S-6 & S-7: Satırsız basit gider fişi (BLANK ≠ ZERO: net_amount=null, tax_amount=null) + çalışan harcaması (spender -> 335)
                  id: "pbill_simple_301",
                  type: "purchase_bills",
                  attributes: {
                    item_type: "purchase_bill",
                    invoice_no: "FIS-2026-301",
                    issue_date: "2026-10-17",
                    due_date: "2026-10-25",
                    currency: "TRL",
                    gross_total: "850.00",
                    total_paid: "0.00",
                    spender_name: "Ahmet Yılmaz",
                    updated_at: "2026-10-18T12:30:00Z",
                  },
                  relationships: {
                    supplier: { data: { id: "c_known_supp", type: "contacts" } },
                  },
                },
              ],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/transactions")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  // MT940 ile zaten içeri alınmış olan -1500.50 TRY hareket! Çift kayıt OLUŞMAMALI!
                  id: "ptx_mt940_dup",
                  type: "transactions",
                  attributes: {
                    date: "2026-10-15",
                    amount: "1500.50",
                    currency: "TRL",
                    description: "Paraşüt Tedarikçi Ödemesi",
                    reference_no: "BNKREF901",
                    updated_at: "2026-10-18T13:00:00Z",
                  },
                  relationships: {
                    credit_account: { data: { id: "acc_garanti", type: "accounts" } },
                  },
                },
                {
                  // S-8: Kendi hesaplarımız arası virman (Garanti -> İş Bankası 25.000 TRY)
                  id: "ptx_virman_500",
                  type: "transactions",
                  attributes: {
                    date: "2026-10-18",
                    amount: "25000.00",
                    currency: "TRL",
                    transaction_type: "account_transfer",
                    description: "Garanti -> İş Bankası Virman",
                    updated_at: "2026-10-18T13:15:00Z",
                  },
                  relationships: {
                    credit_account: { data: { id: "acc_garanti", type: "accounts" } },
                    debit_account: { data: { id: "acc_isbank", type: "accounts" } },
                  },
                },
              ],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/bank_fees")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              data: [
                {
                  id: "bfee_1",
                  type: "bank_fees",
                  attributes: {
                    date: "2026-10-18",
                    amount: "45.00",
                    currency: "TRL",
                    description: "EFT Masrafı",
                    updated_at: "2026-10-18T14:00:00Z",
                  },
                  relationships: {
                    credit_account: { data: { id: "acc_garanti", type: "accounts" } },
                  },
                },
              ],
              meta: { current_page: 1, total_pages: 1 },
            }),
          };
        }

        if (path.endsWith("/taxes") || path.endsWith("/salaries")) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({ data: [], meta: { current_page: 1, total_pages: 1 } }),
          };
        }

        return { ok: false, status: 404, body: "" };
      });

    const credJson = JSON.stringify({
      companyId: "10500",
      clientId: "cid_test",
      clientSecret: "csec_test",
      username: "cfo@mas.local",
      password: "secret_password",
    });

    const connector = parasutConnector();
    const httpRun1 = buildParasutHttp();
    const sync1 = await connector.sync(
      {
        connectionId,
        config: { companyId: "10500", sinceDays: 30 },
        credential: credJson,
        http: httpRun1,
        asOfISO: "2026-10-20",
      },
      pool,
      actorId,
    );

    expect(sync1.ok).toBe(true);
    expect(sync1.stagedParties).toBe(1);

    // Doğrulama 1 (S-3): Teklif (estimate) kesinlikle invoices tablosuna yazılmamış olmalı!
    const estRes = await pool.query(
      `select 1 from public.invoices where external_key = 'parasut:sales_invoices:sinv_estimate_1'`,
    );
    expect(estRes.rowCount).toBe(0);

    // Doğrulama 2 (S-2, S-4, S-5): GİB numarası henüz olmayan e-Fatura 'draft' ve TASLAK-PARASUT-sinv_tevkifat_9002 olarak açılmış olmalı
    const draftInv = await pool.query<{
      invoice_no: string;
      status: string;
      currency: string;
      gross_amount: string;
      vat_withholding_amount: string;
      payable_amount: string;
      external_status: string;
    }>(
      `select invoice_no, status, currency, gross_amount::text, vat_withholding_amount::text, payable_amount::text, external_status
         from public.invoices
        where external_key = 'parasut:sales_invoices:sinv_tevkifat_9002'`,
    );
    expect(draftInv.rowCount).toBe(1);
    expect(draftInv.rows[0]).toEqual({
      invoice_no: "TASLAK-PARASUT-sinv_tevkifat_9002",
      status: "draft",
      currency: "TRY",
      gross_amount: "12000.00",
      vat_withholding_amount: "1000.00",
      payable_amount: "11000.00",
      external_status: "unformalized",
    });

    // Doğrulama 3 (S-6 & S-7): Satırsız basit gider fişinde net_amount=null, tax_amount=null (BLANK ≠ ZERO) ve spender_employee_name dolu olmalı!
    const simpleBill = await pool.query<{
      net_amount: string | null;
      tax_amount: string | null;
      gross_amount: string;
      spender_employee_name: string | null;
    }>(
      `select net_amount::text, tax_amount::text, gross_amount::text, spender_employee_name
         from public.invoices
        where external_key = 'parasut:purchase_bills:pbill_simple_301'`,
    );
    expect(simpleBill.rowCount).toBe(1);
    expect(simpleBill.rows[0]).toEqual({
      net_amount: null,
      tax_amount: null,
      gross_amount: "850.00",
      spender_employee_name: "Ahmet Yılmaz",
    });

    // Doğrulama 4 (S-10): Tanınmayan cari public.parties'e YAZILMAMIŞ, integration_staged_parties'e 'pending' düşmüş olmalı!
    const unknownInParties = await pool.query(
      `select 1 from public.parties where name = 'E1 Yepyeni Tanınmayan Tedarikçi A.Ş.'`,
    );
    expect(unknownInParties.rowCount).toBe(0);
    const stagedParty = await pool.query<{ status: string; tax_id: string }>(
      `select status, tax_id from public.integration_staged_parties
        where provider = 'parasut' and external_contact_id = 'c_unknown_new'`,
    );
    expect(stagedParty.rowCount).toBe(1);
    expect(stagedParty.rows[0]).toEqual({ status: "pending", tax_id: "5554443322" });

    // Doğrulama 5 (Çapraz-Kanal Tekilleştirme): MT940 ile gelen -1500.50 TRY hareket Paraşüt API'den tekrar geldiğinde 2. satır oluşmamalı!
    const mt940TxCount = await pool.query<{ n: number }>(
      `select count(*)::int as n
         from public.bank_transactions
        where bank_account_id = $1 and txn_date = '2026-10-15' and amount = -1500.50`,
      [bankAccountAId],
    );
    expect(mt940TxCount.rows[0].n).toBe(1);

    // Ve integration_entity_links mevcut MT940 satırına bağlanmış olmalı!
    const linkedTx = await pool.query(
      `select 1 from public.integration_entity_links
        where provider = 'parasut' and resource_type = 'transactions' and external_id = 'ptx_mt940_dup'`,
    );
    expect(linkedTx.rowCount).toBe(1);

    // Doğrulama 6 (S-8 own_transfer): Hesaplar arası 25.000 TRY virman daily_cash_movement konsolide inflow/outflow'u şişirmemeli!
    const dailyMove = await pool.query<{ inflow: string; outflow: string }>(
      `select inflow::text, outflow::text
         from public.daily_cash_movement
        where txn_date = '2026-10-18' and currency = 'TRY'`,
    );
    expect(dailyMove.rowCount).toBe(1);
    // 18 Ekim'de yalnız -45.00 TRY banka masrafı (bank_fee) konsolide çıkışta görünmeli, 25.000 TRY virman hariç tutulmalı!
    expect(dailyMove.rows[0].inflow).toBe("0");
    expect(dailyMove.rows[0].outflow).toBe("-45.00");

    // 4) Şimdi 2. Senkron Koşusu: e-Fatura GİB numarası aldı ('GIB2026000009002') -> 'draft'tan 'open'a yükselmeli ve 0 mükerrer kayıt oluşmalı!
    formalizeEInvoice = true;
    const httpRun2 = buildParasutHttp();
    const sync2 = await connector.sync(
      {
        connectionId,
        config: { companyId: "10500", sinceDays: 30 },
        credential: credJson,
        http: httpRun2,
        asOfISO: "2026-10-20",
      },
      pool,
      actorId,
    );
    expect(sync2.ok).toBe(true);
    expect(sync2.stagedParties).toBe(0);

    const formalizedInv = await pool.query<{
      id: string;
      invoice_no: string;
      status: string;
      external_status: string;
    }>(
      `select id::text, invoice_no, status, external_status
         from public.invoices
        where external_key = 'parasut:sales_invoices:sinv_tevkifat_9002'`,
    );
    expect(formalizedInv.rowCount).toBe(1);
    expect(formalizedInv.rows[0].invoice_no).toBe("GIB2026000009002");
    expect(formalizedInv.rows[0].status).toBe("open");
    expect(formalizedInv.rows[0].external_status).toBe("formalized");

    // Doğrulama 7 (S-5 Likidite Projeksiyonu): Tevkifatlı faturanın nakit projeksiyonu gross (12.000) değil payable_amount (11.000) olmalı!
    const liqRow = await pool.query<{ amount_signed: string }>(
      `select amount_signed::text
         from public.liquidity_forecast_daily
        where source_kind = 'invoice' and source_id = $1`,
      [formalizedInv.rows[0].id],
    );
    expect(liqRow.rowCount).toBe(1);
    expect(liqRow.rows[0].amount_signed).toBe("11000.00");

    // Doğrulama 8 (integration_raw_payloads append-only kanıt koruması):
    const rawPayloads = await pool.query<{ id: string }>(
      `select id::text from public.integration_raw_payloads limit 1`,
    );
    expect(rawPayloads.rowCount).toBe(1);
    await expect(
      pool.query(`delete from public.integration_raw_payloads where id = $1`, [rawPayloads.rows[0].id]),
    ).rejects.toThrow(/append-only/);

    // Doğrulama 9: Hiçbir /v4/ isteğinde POST/PUT/PATCH/DELETE kullanılmadı!
    const v4Requests = httpRun2.requests.filter((r) => r.url.includes("/v4/"));
    expect(v4Requests.length).toBeGreaterThan(0);
    expect(v4Requests.every((r) => (r.method ?? "GET") === "GET")).toBe(true);
  });

  it("computeCrossChannelDedupeHash aynı banka hareketinde kanaldan bağımsız deterministik özet üretir", () => {
    const h1 = computeCrossChannelDedupeHash({
      bankAccountId: bankAccountAId,
      txnDate: "2026-10-15",
      amount: -1500.5,
      currency: "TRL",
      reference: "BNK REF 901",
    });
    const h2 = computeCrossChannelDedupeHash({
      bankAccountId: bankAccountAId,
      txnDate: "2026-10-15T00:00:00Z",
      amount: "-1500.50",
      currency: "TRY",
      reference: "bnkref901",
    });
    expect(h1).toBe(h2);
  });
});