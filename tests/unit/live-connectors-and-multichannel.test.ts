import { describe, expect, it } from "vitest";
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  ACCOUNTING_PENDING_REASON,
  accountingConnector,
  connectorFor,
} from "@/lib/integrations/connectors";
import {
  integratorEInvoiceConnector,
  parseIntegratorEInvoicePayload,
} from "@/lib/integrations/einvoice/integrator-connector";
import {
  applyPain002StatusToPaymentRun,
  parsePain002StatusReport,
} from "@/lib/integrations/open-banking/pain002-status-parser";
import {
  parseOpenBankingPayload,
  turkishBankConnector,
} from "@/lib/integrations/open-banking/turkish-bank-connector";
import {
  parsePosSettlementPayload,
  posSettlementConnector,
} from "@/lib/integrations/pos/pos-settlement-connector";
import {
  DEFAULT_ALLOWED_INTEGRATION_HOSTS,
  isAllowedCredentialEnvVar,
  mockHttpClient,
  validateIntegrationEndpointUrl,
} from "@/lib/integrations/types";
import {
  buildFolioEmailHtml,
  emailTransport,
  normalizeEmailRecipients,
  sendCounterpartyReminder,
  sendTransactionalEmail,
  smsTransport,
  transportFor,
  whatsappTransport,
} from "@/lib/reminders/transport";

/* ── Deterministic in-memory pg Pool/Client harness for unit tests ─────────────────────── */

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function createMockPgHarness(
  handler: (sqlNorm: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number } | void,
) {
  const queries: RecordedQuery[] = [];

  const runQuery = async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
    const sqlNorm = sql.replace(/\s+/g, " ").trim().toLowerCase();
    queries.push({ sql: sqlNorm, params });

    if (sqlNorm === "begin" || sqlNorm === "commit" || sqlNorm === "rollback") {
      return { command: sqlNorm.toUpperCase(), rowCount: 0, oid: 0, rows: [], fields: [] };
    }

    const res = handler(sqlNorm, params);
    const rows = res?.rows ?? [];
    const rowCount = res?.rowCount ?? rows.length;
    return {
      command: "SELECT",
      rowCount,
      oid: 0,
      rows: rows as never[],
      fields: [],
    };
  };

  const client = {
    query: runQuery,
    release: () => undefined,
  } as unknown as PoolClient;

  const pool = {
    query: runQuery,
    connect: async () => client,
  } as unknown as Pool;

  return { pool, queries };
}

/* ── 1. Host Allowlist, SSRF Defense & Credential Env Guard (`types.ts`) ───────────────── */

describe("Integration boundary & SSRF allowlist (types.ts)", () => {
  it("allows all official Turkish Open Banking, GİB Special Integrator, and POS HTTPS hosts", () => {
    const expectedHosts = [
      "api.parasut.com",
      "www.tcmb.gov.tr",
      "portal.garantibbva.com.tr",
      "api.garantibbva.com.tr",
      "api.isbank.com.tr",
      "api.yapikredi.com.tr",
      "api.akbank.com",
      "api.qnb.com.tr",
      "earsivportal.efatura.gov.tr",
      "api.fitbulut.com",
      "efatura.uyumsoft.com.tr",
      "api.izibiz.com.tr",
      "connector.qnbefinans.com",
      "api.iyzipay.com",
      "www.paytr.com",
    ];

    for (const host of expectedHosts) {
      expect(DEFAULT_ALLOWED_INTEGRATION_HOSTS).toContain(host);
      expect(
        validateIntegrationEndpointUrl(`https://${host}/v1/ping`, { enforceAllowlist: true }),
      ).toBeNull();
    }
  });

  it("blocks non-HTTPS, loopback/metadata SSRF targets, and unlisted domains", () => {
    expect(
      validateIntegrationEndpointUrl("http://api.garantibbva.com.tr/v1", { enforceAllowlist: true }),
    ).toMatch(/https:\/\//);
    expect(
      validateIntegrationEndpointUrl("https://127.0.0.1/internal", { enforceAllowlist: false }),
    ).toMatch(/yerel\/özel ağ/);
    expect(
      validateIntegrationEndpointUrl("https://169.254.169.254/latest/meta-data", {
        enforceAllowlist: false,
      }),
    ).toMatch(/yerel\/özel ağ/);
    expect(
      validateIntegrationEndpointUrl("https://evil.example.org/steal", { enforceAllowlist: true }),
    ).toMatch(/beyaz listede değil/);
  });

  it("permits OPENBANKING_*, EINVOICE_*, POS_* credential env vars while blocking core secrets", () => {
    expect(isAllowedCredentialEnvVar("OPENBANKING_GARANTI_TOKEN")).toBe(true);
    expect(isAllowedCredentialEnvVar("EINVOICE_FITBULUT_KEY")).toBe(true);
    expect(isAllowedCredentialEnvVar("POS_IYZICO_SECRET")).toBe(true);
    expect(isAllowedCredentialEnvVar("MAS_INTEGRATION_BANK_TOKEN")).toBe(true);
    expect(isAllowedCredentialEnvVar("PARASUT_CLIENT_SECRET")).toBe(true);

    expect(isAllowedCredentialEnvVar("DATABASE_URL")).toBe(false);
    expect(isAllowedCredentialEnvVar("OPENAI_API_KEY")).toBe(false);
    expect(isAllowedCredentialEnvVar("TELEGRAM_BOT_TOKEN")).toBe(false);
  });
});

/* ── 2. Turkish Open Banking JSON & CAMT.053 XML Connector ─────────────────────────────── */

describe("Turkish Open Banking & CAMT.053 connector", () => {
  it("syncs BKM/TÖS hesapHareketleri JSON, maps IBAN, records SHA-256 lineage, deduplicates & audits", async () => {
    const bankAccountUuid = "11111111-1111-4111-8111-111111111111";
    const insertedBankTxHashes = new Set<string>();
    const rawPayloads: Array<{ externalId: string; sha256: string }> = [];
    const audits: Array<{ action: string; entityTable: string }> = [];

    const { pool } = createMockPgHarness((sql, params) => {
      if (sql.includes("from public.integration_connections")) {
        return { rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
      }
      if (sql.includes("insert into public.integration_sync_runs")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
      }
      if (sql.includes("insert into public.integration_raw_payloads")) {
        rawPayloads.push({ externalId: String(params[2]), sha256: String(params[3]) });
        return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }], rowCount: 1 };
      }
      if (sql.includes("from public.integration_account_mappings")) {
        return { rows: [] };
      }
      if (sql.includes("from public.bank_accounts") && sql.includes("iban")) {
        return { rows: [{ cash_account_id: bankAccountUuid }] };
      }
      if (sql.includes("insert into public.integration_account_mappings")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from public.bank_transactions") && sql.includes("cross_channel_dedupe_hash")) {
        return { rows: [] };
      }
      if (sql.includes("insert into public.bank_transactions")) {
        const dedupeHash = String(params[8]);
        if (insertedBankTxHashes.has(dedupeHash)) {
          return { rows: [], rowCount: 0 };
        }
        insertedBankTxHashes.add(dedupeHash);
        return { rows: [{ id: "55555555-5555-4555-8555-555555555555" }], rowCount: 1 };
      }
      if (sql.includes("insert into public.integration_entity_links")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update public.integration_sync_runs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("public.audit_logs")) {
        audits.push({ action: String(params[1]), entityTable: String(params[2]) });
        return { rows: [{ id: "90909090-9090-4090-8090-909090909001" }], rowCount: 1 };
      }
    });

    const bkmPayload = {
      hesapIban: "TR33 0006 1005 1978 6457 8413 26",
      paraBirimi: "TRY",
      hesapHareketleri: [
        {
          hareketId: "GAR-2026-001",
          islemTarihi: "14.11.2026",
          valorTarihi: "14.11.2026",
          tutar: "48.250,75",
          borcAlacak: "A",
          karsiTarafUnvan: "Anadolu Çelik Sanayi A.Ş.",
          aciklama: "Fatura tahsilatı FT-901",
          referansNo: "DEKONT-901",
        },
        {
          hareketId: "GAR-2026-002",
          islemTarihi: "2026-11-15",
          tutar: "45,50",
          borcAlacak: "B",
          aciklama: "FAST EFT komisyon ve BSMV masrafı",
          referansNo: "DEKONT-902",
        },
      ],
    };

    const http = mockHttpClient(() => ({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bkmPayload),
    }));

    const connector = turkishBankConnector("garantibbva");
    const firstSync = await connector.sync(
      {
        config: { baseUrl: "https://api.garantibbva.com.tr/open-banking/v1", sinceDays: 3 },
        credential: "ob-token-xyz",
        http,
        asOfISO: "2026-11-15",
      },
      pool,
      "66666666-6666-4666-8666-666666666666",
    );

    expect(firstSync.ok).toBe(true);
    expect(firstSync.imported).toBe(2);
    expect(firstSync.skipped).toBe(0);
    expect(rawPayloads.length).toBe(3); // 1 envelope + 2 transactions
    expect(rawPayloads[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(audits.some((a) => a.action === "open_banking_sync")).toBe(true);

    // Second run with identical payload must be 100% idempotent
    const secondSync = await connector.sync(
      {
        config: { baseUrl: "https://api.garantibbva.com.tr/open-banking/v1", sinceDays: 3 },
        credential: "ob-token-xyz",
        http,
        asOfISO: "2026-11-15",
      },
      pool,
      "66666666-6666-4666-8666-666666666666",
    );
    expect(secondSync.ok).toBe(true);
    expect(secondSync.imported).toBe(0);
    expect(secondSync.skipped).toBe(2);
  });

  it("parses CAMT.053 XML bank statements and rejects XXE DTD/ENTITY payloads", () => {
    const camtXml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-2026-11</Id>
      <Acct>
        <Id><IBAN>TR330006100519786457841326</IBAN></Id>
        <Ccy>TRY</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="TRY">12500.40</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-11-14</Dt></BookgDt>
        <ValDt><Dt>2026-11-14</Dt></ValDt>
        <AcctSvcrRef>CAMT-REF-01</AcctSvcrRef>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Marmara Lojistik A.S.</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Navlun bedeli</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="TRY">3200.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-11-15</Dt></BookgDt>
        <AcctSvcrRef>CAMT-REF-02</AcctSvcrRef>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>Enerjisa A.S.</Nm></Cdtr></RltdPties>
          <RmtInf><Ustrd>Elektrik faturası</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

    const parsed = parseOpenBankingPayload(camtXml, "application/xml");
    expect(parsed.format).toBe("camt053");
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0].amount).toBe(12500.4);
    expect(parsed.transactions[1].amount).toBe(-3200);
    expect(parsed.transactions[0].accountIban).toBe("TR330006100519786457841326");

    const xxeXml = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><BkToCstmrStmt>&xxe;</BkToCstmrStmt>`;
    expect(() => parseOpenBankingPayload(xxeXml, "application/xml")).toThrow(/XXE|DTD\/ENTITY/);
  });
});

/* ── 3. Host-to-Host ISO 20022 `pain.002.001.03` Payment Status Parser & Reconciler ────── */

describe("ISO 20022 pain.002.001.03 payment status parser & payment_run reconciler", () => {
  const samplePain002 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.03">
  <CstmrPmtStsRpt>
    <GrpHdr>
      <MsgId>STS-20261115-001</MsgId>
      <CreDtTm>2026-11-15T15:30:00Z</CreDtTm>
    </GrpHdr>
    <OrgnlGrpInfAndSts>
      <OrgnlMsgId>PR-2026-0042</OrgnlMsgId>
      <OrgnlMsgNmId>pain.001.001.03</OrgnlMsgNmId>
      <GrpSts>PART</GrpSts>
    </OrgnlGrpInfAndSts>
    <OrgnlPmtInfAndSts>
      <OrgnlPmtInfId>PMT-PR-2026-0042</OrgnlPmtInfId>
      <TxInfAndSts>
        <StsId>S-1</StsId>
        <OrgnlEndToEndId>PR-2026-0042-001</OrgnlEndToEndId>
        <TxSts>ACSC</TxSts>
      </TxInfAndSts>
      <TxInfAndSts>
        <StsId>S-2</StsId>
        <OrgnlEndToEndId>PR-2026-0042-002</OrgnlEndToEndId>
        <TxSts>RJCT</TxSts>
        <StsRsnInf>
          <Rsn><Cd>AC04</Cd></Rsn>
          <AddtlInf>Alıcı IBAN hesabı kapatılmış</AddtlInf>
        </StsRsnInf>
      </TxInfAndSts>
    </OrgnlPmtInfAndSts>
  </CstmrPmtStsRpt>
</Document>`;

  it("parses ACSC and RJCT item statuses with reason codes and rejects XXE", () => {
    const report = parsePain002StatusReport(Buffer.from(samplePain002, "utf8"));
    expect(report.messageId).toBe("STS-20261115-001");
    expect(report.originalMessageId).toBe("PR-2026-0042");
    expect(report.transactions).toHaveLength(2);
    expect(report.transactions[0]).toMatchObject({
      originalEndToEndId: "PR-2026-0042-001",
      txStatus: "ACSC",
    });
    expect(report.transactions[1]).toMatchObject({
      originalEndToEndId: "PR-2026-0042-002",
      txStatus: "RJCT",
      reasonCode: "AC04",
      rejectionReason: "[AC04] Alıcı IBAN hesabı kapatılmış",
    });

    const xxePain = Buffer.from(
      `<?xml version="1.0"?><!DOCTYPE lol [<!ENTITY e "x">]><CstmrPmtStsRpt/>`,
      "utf8",
    );
    expect(() => parsePain002StatusReport(xxePain)).toThrow(/XXE|DTD\/ENTITY/);
  });

  it("updates payment_run_items and transitions payment_runs cleanly with audit()", async () => {
    const runId = "77777777-7777-4777-8777-777777777777";
    const item1Id = "88888888-8888-4888-8888-888888888801";
    const item2Id = "88888888-8888-4888-8888-888888888802";
    const itemUpdates: Array<{ id: string; sql: string }> = [];
    const auditActions: string[] = [];

    const { pool } = createMockPgHarness((sql, params) => {
      if (sql.includes("from public.payment_runs") && sql.includes("for update")) {
        return {
          rows: [
            {
              id: runId,
              run_code: "PR-2026-0042",
              status: "exported",
              notes: null,
            },
          ],
        };
      }
      if (sql.includes("from public.payment_run_items") && sql.includes("for update")) {
        return {
          rows: [
            {
              id: item1Id,
              status: "included",
              beneficiary_name: "Tedarikçi A",
              beneficiary_iban: "TR330006100519786457841326",
              amount: "15000.00",
              currency: "TRY",
            },
            {
              id: item2Id,
              status: "included",
              beneficiary_name: "Tedarikçi B",
              beneficiary_iban: "TR120006200000000001234567",
              amount: "8500.00",
              currency: "TRY",
            },
          ],
        };
      }
      if (sql.startsWith("update public.payment_run_items")) {
        itemUpdates.push({ id: String(params[0]), sql });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("update public.payment_runs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("public.audit_logs")) {
        auditActions.push(String(params[1]));
        return { rows: [{ id: "90909090-9090-4090-8090-909090909002" }], rowCount: 1 };
      }
    });

    const outcome = await applyPain002StatusToPaymentRun(
      pool,
      runId,
      Buffer.from(samplePain002, "utf8"),
      "99999999-9999-4999-8999-999999999999",
    );

    expect(outcome.settledItems).toBe(1);
    expect(outcome.rejectedItems).toBe(1);
    expect(outcome.newRunStatus).toBe("settled");
    expect(outcome.rejections).toHaveLength(1);
    expect(outcome.rejections[0].reasonCode).toBe("AC04");
    expect(itemUpdates).toHaveLength(2);
    expect(itemUpdates[0].sql).toContain("status = 'settled'");
    expect(itemUpdates[1].sql).toContain("status = 'excluded'");
    expect(auditActions).toEqual([
      "pain002_item_settled",
      "pain002_item_rejected",
      "apply_pain002_status_report",
    ]);
  });
});

/* ── 4. GİB Special Integrator e-Invoice Connector (`integrator-connector.ts`) ────────── */

describe("GİB Special Integrator e-Invoice connector", () => {
  function sampleUblXml(opts: {
    uuid: string;
    invoiceNo: string;
    supplierVkn: string;
    supplierName: string;
    net: string;
    vat: string;
    gross: string;
  }) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>${opts.invoiceNo}</cbc:ID>
  <cbc:UUID>${opts.uuid}</cbc:UUID>
  <cbc:IssueDate>2026-11-15</cbc:IssueDate>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${opts.supplierVkn}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${opts.supplierName}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">9999999999</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>MAS Demo A.Ş.</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="TRY">${opts.vat}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="TRY">${opts.net}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">${opts.gross}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="TRY">${opts.gross}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">${opts.net}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">${opts.vat}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:Percent>20</cbc:Percent>
        <cbc:TaxAmount currencyID="TRY">${opts.vat}</cbc:TaxAmount>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>Endüstriyel Pompa Bakımı</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">5000.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
  }

  it("upserts matched VKN invoices with UBL lines and stages unknown VKN in integration_staged_parties", async () => {
    const knownVkn = "1234567890";
    const unknownVkn = "5555566666";
    const stagedInserts: Array<{ vkn: string | null; name: string }> = [];
    const invoiceInserts: Array<{ invoiceNo: string; gross: unknown }> = [];
    let partyTableInserts = 0;

    const { pool } = createMockPgHarness((sql, params) => {
      if (sql.includes("insert into public.parties")) {
        partyTableInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from public.integration_connections")) {
        return { rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
      }
      if (sql.includes("insert into public.integration_sync_runs")) {
        return { rows: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }], rowCount: 1 };
      }
      if (sql.includes("insert into public.integration_raw_payloads")) {
        return { rows: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }], rowCount: 1 };
      }
      if (sql.includes("from public.invoices") && sql.includes("ubl_uuid")) {
        return { rows: [] };
      }
      if (sql.includes("from public.integration_staged_parties")) {
        return { rows: [] };
      }
      if (sql.includes("from public.counterparty_profiles")) {
        if (params[0] === knownVkn) {
          return { rows: [{ party_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] };
        }
        return { rows: [] };
      }
      if (sql.includes("insert into public.integration_staged_parties")) {
        stagedInserts.push({ name: String(params[2]), vkn: (params[3] as string | null) ?? null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into public.invoices")) {
        invoiceInserts.push({ invoiceNo: String(params[1]), gross: params[11] });
        return { rows: [{ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }], rowCount: 1 };
      }
      if (sql.includes("delete from public.invoice_lines")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("insert into public.invoice_lines")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into public.integration_entity_links")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update public.integration_sync_runs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("public.audit_logs")) {
        return { rows: [{ id: "90909090-9090-4090-8090-909090909003" }], rowCount: 1 };
      }
    });

    const knownXml = sampleUblXml({
      uuid: "11111111-aaaa-4bbb-8ccc-111111111111",
      invoiceNo: "FIT2026000000101",
      supplierVkn: knownVkn,
      supplierName: "Kayıtlı Makina San. A.Ş.",
      net: "10000.00",
      vat: "2000.00",
      gross: "12000.00",
    });
    const unknownXml = sampleUblXml({
      uuid: "22222222-aaaa-4bbb-8ccc-222222222222",
      invoiceNo: "FIT2026000000102",
      supplierVkn: unknownVkn,
      supplierName: "Yeni Tedarikçi Ltd. Şti.",
      net: "5000.00",
      vat: "1000.00",
      gross: "6000.00",
    });

    const envelopeJson = {
      envelopeList: [
        { uuid: "11111111-aaaa-4bbb-8ccc-111111111111", ublXml: knownXml },
        {
          uuid: "22222222-aaaa-4bbb-8ccc-222222222222",
          xmlBase64: Buffer.from(unknownXml, "utf8").toString("base64"),
        },
      ],
    };

    const http = mockHttpClient(() => ({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelopeJson),
    }));

    const connector = integratorEInvoiceConnector("fitbulut");
    const syncRes = await connector.sync(
      {
        config: {
          baseUrl: "https://api.fitbulut.com/einvoice/v1",
          ownTaxNumber: "9999999999",
        },
        credential: "einvoice-secret-token",
        http,
        asOfISO: "2026-11-15",
      },
      pool,
      "99999999-9999-4999-8999-999999999999",
    );

    expect(syncRes.ok).toBe(true);
    expect(syncRes.imported).toBe(1);
    expect(syncRes.stagedParties).toBe(1);
    expect(partyTableInserts).toBe(0); // S-10 Shield: NEVER silently creates rows in public.parties!
    expect(invoiceInserts).toEqual([{ invoiceNo: "FIT2026000000101", gross: 12000 }]);
    expect(stagedInserts).toEqual([{ name: "Yeni Tedarikçi Ltd. Şti.", vkn: unknownVkn }]);

    expect(() =>
      parseIntegratorEInvoicePayload(
        `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY bad "1">]><Invoice/>`,
        "application/xml",
      ),
    ).toThrow(/XXE|DTD\/ENTITY/);
  });
});

/* ── 5. POS Settlement Batch Connector (`pos-settlement-connector.ts` — 0117 Schema) ──── */

describe("POS settlement batch connector (iyzico / PayTR JSON & CSV + discrepancy guard)", () => {
  it("reconciles gross - commission - bsmv with @/lib/money, flags discrepancy without mutating net_settlement_amount", async () => {
    const posBatchInserts: Array<{
      terminal: string;
      gross: number;
      commission: number;
      netSettlement: number;
    }> = [];

    const { pool } = createMockPgHarness((sql, params) => {
      if (sql.includes("from public.integration_connections")) {
        return { rows: [{ id: "12121212-1212-4212-8212-121212121212" }] };
      }
      if (sql.includes("insert into public.integration_sync_runs")) {
        return { rows: [{ id: "13131313-1313-4313-8313-131313131313" }], rowCount: 1 };
      }
      if (sql.includes("from public.integration_account_mappings")) {
        return { rows: [{ cash_account_id: "14141414-1414-4414-8414-141414141414", bank_account_id: null }] };
      }
      if (sql.includes("insert into public.integration_raw_payloads")) {
        return { rows: [{ id: "15151515-1515-4515-8515-151515151515" }], rowCount: 1 };
      }
      if (sql.includes("from public.integration_entity_links")) {
        return { rows: [] };
      }
      if (sql.includes("from public.pos_settlement_batches")) {
        return { rows: [] };
      }
      if (sql.includes("insert into public.pos_settlement_batches")) {
        posBatchInserts.push({
          terminal: String(params[1]),
          gross: Number(params[4]),
          commission: Number(params[6]),
          netSettlement: Number(params[7]),
        });
        return { rows: [{ id: "16161616-1616-4616-8616-161616161616" }], rowCount: 1 };
      }
      if (sql.includes("insert into public.integration_entity_links")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("update public.integration_sync_runs")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("public.audit_logs")) {
        return { rows: [{ id: "90909090-9090-4090-8090-909090909003" }], rowCount: 1 };
      }
    });

    const posPayload = {
      settlements: [
        {
          id: "IYZ-BATCH-01",
          settlement_date: "2026-11-14",
          value_date: "2026-11-15",
          gross_amount: "1000.00",
          commission_amount: "22.50",
          bsmv_amount: "1.13",
          net_amount: "976.37",
          currency: "TRY",
          terminal_or_provider: "IYZICO-WEB-01",
        },
        {
          id: "IYZ-BATCH-02",
          settlement_date: "2026-11-14",
          value_date: "2026-11-15",
          gross_amount: "1000.00",
          commission_amount: "20.00",
          bsmv_amount: "1.00",
          // Expected net is 979.00, but acquirer reported 975.00 (-4.00 discrepancy!)
          net_amount: "975.00",
          currency: "TRY",
          terminal_or_provider: "PAYTR-LINK-02",
        },
      ],
    };

    const http = mockHttpClient(() => ({
      ok: true,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(posPayload),
    }));

    const connector = posSettlementConnector("iyzico");
    const outcome = await connector.sync(
      {
        config: { baseUrl: "https://api.iyzipay.com/reporting/v1" },
        credential: "pos-secret-key",
        http,
        asOfISO: "2026-11-15",
      },
      pool,
      "99999999-9999-4999-8999-999999999999",
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.imported).toBe(2);
    expect("discrepancyCount" in outcome ? outcome.discrepancyCount : 0).toBe(1);
    expect(posBatchInserts).toHaveLength(2);
    // CRITICAL: Reported net_settlement_amount (975.00) is stored as-is and NEVER mutated to 979.00!
    expect(posBatchInserts[1]).toEqual({
      terminal: "PAYTR-LINK-02",
      gross: 1000,
      commission: 20,
      netSettlement: 975,
    });

    // Verify Turkish semicolon CSV parsing as well
    const csvBody = [
      "settlement_date;value_date;gross_amount;commission_amount;bsmv_amount;net_amount;currency;terminal_or_provider",
      "15.11.2026;16.11.2026;2.500,00;50,00;2,50;2.447,50;TRY;GARANTI-POS-01",
    ].join("\n");
    const csvRows = parsePosSettlementPayload(csvBody, "BANK_POS", "text/csv");
    expect(csvRows).toHaveLength(1);
    expect(csvRows[0].grossAmount).toBe(2500);
    expect(csvRows[0].netAmount).toBe(2447.5);
    expect(csvRows[0].hasDiscrepancy).toBe(false);
  });
});

/* ── 6. Multi-Channel Notification Transports (`transport.ts`) ────────────────────────── */

describe("Multi-channel notification transports (HTML email, SMS, WhatsApp, Counterparty reminder)", () => {
  it("normalizes multi-recipient email lists and escapes HTML in warm-parchment folio wrapper", () => {
    expect(
      normalizeEmailRecipients("cfo@mas.com, finans@mas.com; Cfo@mas.com , muhasebe@mas.com "),
    ).toEqual(["cfo@mas.com", "finans@mas.com", "muhasebe@mas.com"]);

    const html = buildFolioEmailHtml({
      title: "CFO Günlük Özet <script>alert(1)</script>",
      bodyText: "Net nakit pozisyonu güçlü.\n\nVadesi gelen ödeme bulunmuyor.",
      rows: [{ label: "Net Likidite", value: "1.450.000,00 TRY" }],
    });
    expect(html).toContain("#FFFDF9");
    expect(html).toContain("MAS NAKİT RADAR");
    expect(html).toContain("1.450.000,00 TRY");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("returns honest skippedUnconfigured: true (never throws) when EMAIL / SMS / WhatsApp are unconfigured", async () => {
    const emailUnconf = await sendTransactionalEmail(
      { to: "cari@firma.com", subject: "Test", text: "Merhaba" },
      { apiUrl: "" },
    );
    expect(emailUnconf.ok).toBe(false);
    expect(emailUnconf.skippedUnconfigured).toBe(true);

    const smsUnconf = await smsTransport({ apiUrl: "", to: "" }).send("Test SMS");
    expect(smsUnconf.ok).toBe(false);
    expect(smsUnconf.skippedUnconfigured).toBe(true);

    const waUnconf = await whatsappTransport({ apiUrl: "", to: "" }).send("Test WA");
    expect(waUnconf.ok).toBe(false);
    expect(waUnconf.skippedUnconfigured).toBe(true);

    expect(transportFor("sms").channel).toBe("sms");
    expect(transportFor("whatsapp").channel).toBe("whatsapp");
    expect(transportFor("email").channel).toBe("email");
  });

  it("dispatches multi-recipient HTML email, SMS, and WhatsApp via mock fetchImpl & blocks SSRF URLs", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | undefined }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
        auth: headers.authorization,
      });
      return new Response(JSON.stringify({ id: "msg_1" }), { status: 200 });
    };

    const reminderRes = await sendCounterpartyReminder(
      {
        partyName: "Ege Tekstil San. Tic. A.Ş.",
        email: "muhasebe@egetekstil.com.tr, finans@egetekstil.com.tr",
        phone: "+905321112233",
        whatsappPhone: "+905321112233",
        invoiceNo: "MAS2026000019",
        dueDate: "2026-11-20",
        amountFormatted: "84.500,00",
        currency: "TRY",
        channels: ["email", "sms", "whatsapp"],
      },
      {
        emailApiUrl: "https://api.resend.com/emails",
        emailApiKey: "re_test_key",
        emailFrom: "finans@masnakitradar.com",
        smsApiUrl: "https://sms.netgsm.com.tr/api/v2/send",
        smsApiKey: "sms_test_key",
        whatsappApiUrl: "https://graph.facebook.com/v20.0/10001/messages",
        whatsappApiToken: "wa_test_token",
        fetchImpl: mockFetch,
      },
    );

    expect(reminderRes.anySent).toBe(true);
    expect(reminderRes.results.email?.ok).toBe(true);
    expect(reminderRes.results.sms?.ok).toBe(true);
    expect(reminderRes.results.whatsapp?.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].body.to).toEqual([
      "muhasebe@egetekstil.com.tr",
      "finans@egetekstil.com.tr",
    ]);
    expect(calls[0].body.from).toBe("finans@masnakitradar.com");
    expect(String(calls[0].body.html)).toContain("MAS2026000019");
    expect(calls[1].body).toMatchObject({ to: "+905321112233" });
    expect(calls[2].body).toMatchObject({
      messaging_product: "whatsapp",
      to: "+905321112233",
      type: "text",
    });

    // Verify emailTransport multi-recipient + SSRF rejection on loopback
    const ssrfEmail = await emailTransport({
      apiUrl: "https://127.0.0.1/send",
      to: "a@b.com",
      fetchImpl: mockFetch,
    }).send("Test");
    expect(ssrfEmail.ok).toBe(false);
    expect(ssrfEmail.error).toMatch(/SSRF/);
  });
});

/* ── 7. Connector Registry Routing & Accounting Guard (`connectors.ts`) ───────────────── */

describe("Connector registry & unselected accounting guard (connectors.ts)", () => {
  it("routes live Turkish bank, POS, and GİB integrator providers while keeping unselected accounting guard permanent", async () => {
    expect(connectorFor("bank_api", "garantibbva")?.provider).toBe("garantibbva");
    expect(connectorFor("bank_api", "iyzico")?.provider).toBe("iyzico");
    expect(connectorFor("pos_settlement", "paytr")?.provider).toBe("paytr");
    expect(connectorFor("einvoice", "uyumsoft")?.provider).toBe("uyumsoft");

    const acc = accountingConnector("unselected");
    const authRes = await acc.authenticate({
      config: {},
      credential: null,
      http: mockHttpClient({}),
      asOfISO: "2026-11-15",
    });
    expect(authRes).toEqual({
      ok: false,
      error: ACCOUNTING_PENDING_REASON,
      permanent: true,
    });
  });
});
