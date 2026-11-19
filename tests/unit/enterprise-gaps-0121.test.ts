import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { verify as argon2Verify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { validateFileSet } from "../../scripts/db/migration-lib";
import { OWNER_SCOPED_TABLES, TABLE_CLASS, can } from "@/lib/authz/matrix";
import { decimal } from "@/lib/money";
import { mockTransport } from "@/lib/reminders/transport";
import {
  detectIntercompanyPairs,
  normalizeTaxVkn,
  runIntercompanyElimination,
} from "@/lib/ledger/intercompany-elimination";
import {
  extractStructuredDocumentFields,
  parseDocumentMoneyOrNull,
} from "@/lib/documents/smart-extractor";
import {
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_TTL_MS,
  completePasswordReset,
  generatePasswordResetToken,
  hashResetToken,
  isResetTokenUsable,
  requestPasswordReset,
} from "@/lib/auth/password-reset";
import {
  addEntityComment,
  extractMentions,
  resolveCommentTargetHref,
} from "@/lib/collaboration/comments";

const ROOT = process.cwd();

describe("0121 schema, RLS matrix, and documentation invariants", () => {
  it("passes migration-lib validateFileSet and enforces 0121 SQL invariants", () => {
    const fileSet = validateFileSet();
    expect(fileSet.ok, fileSet.errors.join(" | ")).toBe(true);

    const mig0121 = fileSet.files.find((f) => f.version === "0121");
    expect(mig0121).toBeDefined();
    const sql = mig0121!.content;

    expect(/\b(float8|double\s+precision|real)\b/i.test(sql)).toBe(false);
    expect(sql).toContain("intercompany_elimination_runs");
    expect(sql).toContain("intercompany_elimination_lines");
    expect(sql).toContain("password_reset_tokens");
    expect(sql).toContain("sso_identity_providers");
    expect(sql).toContain("entity_comments");
    expect(sql).toContain("last_kiosk_event_at");
    expect(sql).toContain("operator_note");
    expect(sql).toContain("password_reset_tokens_app_runtime");

    const schemaDoc = readFileSync(path.join(ROOT, "docs", "database-schema.md"), "utf8");
    expect(schemaDoc).toContain("0121");
  });

  it("classifies all 0121 tables in authz/matrix.ts with zero viewer write access", () => {
    const newTables = [
      "intercompany_elimination_runs",
      "intercompany_elimination_lines",
      "password_reset_tokens",
      "sso_identity_providers",
      "entity_comments",
    ] as const;

    for (const tbl of newTables) {
      expect(TABLE_CLASS[tbl]).toBeDefined();
      expect(can("viewer", tbl, "select")).toBe(true);
      expect(can("viewer", tbl, "insert")).toBe(false);
      expect(can("viewer", tbl, "update")).toBe(false);
      expect(can("viewer", tbl, "delete")).toBe(false);
    }

    expect(OWNER_SCOPED_TABLES).toContain("entity_comments");
    expect(can("finance_approver", "entity_comments", "insert")).toBe(true);
    expect(can("admin", "sso_identity_providers", "update")).toBe(true);
    expect(can("finance_manager", "sso_identity_providers", "update")).toBe(false);
  });
});

describe("extractStructuredDocumentFields (smart-extractor)", () => {
  it("extracts UBL-TR XML e-Invoice fields with exact decimal precision", () => {
    const ublXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>GIB2026000004812</cbc:ID>
  <cbc:UUID>550e8400-e29b-41d4-a716-446655440000</cbc:UUID>
  <cbc:IssueDate>2026-05-14</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="VKN">6120000001</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>MAS Makina ve Otomasyon A.Ş.</cbc:Name>
      </cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:PaymentMeans>
    <cac:PayeeFinancialAccount>
      <cbc:ID>TR33 0006 1005 1978 6457 8413 26</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:LegalMonetaryTotal>
    <cbc:PayableAmount currencyID="TRY">148250.75</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`;

    const res = extractStructuredDocumentFields(
      Buffer.from(ublXml, "utf8"),
      "fatura_4812.xml",
      "application/xml",
    );

    expect(res.documentClass).toBe("einvoice");
    expect(res.confidence).toBe("high");
    expect(res.documentNumber).toBe("GIB2026000004812");
    expect(res.ublUuid).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(res.vknOrTckn).toBe("6120000001");
    expect(res.supplierName).toBe("MAS Makina ve Otomasyon A.Ş.");
    expect(res.iban).toBe("TR330006100519786457841326");
    expect(res.detectedDateIso).toBe("2026-05-14");
    expect(res.detectedAmount).toBe(148250.75);
    expect(res.currency).toBe("TRY");
  });

  it("extracts TR IBAN, VKN, date, and Turkish money from bank receipt text", () => {
    const receiptText = [
      "EFT / HAVALE İŞLEM DEKONTU",
      "Dekont No: DK-2026-00984",
      "İşlem Tarihi: 18.05.2026",
      "Alıcı VKN: 4980123456",
      "Alıcı IBAN: TR33 0006 1005 1978 6457 8413 26",
      "Toplam Tutar: 1.250.450,75 TL",
    ].join("\n");

    const res = extractStructuredDocumentFields(
      Buffer.from(receiptText, "utf8"),
      "garanti_dekont.txt",
      "text/plain",
    );

    expect(res.documentClass).toBe("bank_receipt");
    expect(res.confidence).toBe("high");
    expect(res.documentNumber).toBe("DK-2026-00984");
    expect(res.detectedDateIso).toBe("2026-05-18");
    expect(res.vknOrTckn).toBe("4980123456");
    expect(res.iban).toBe("TR330006100519786457841326");
    expect(res.detectedAmount).toBe(1250450.75);
    expect(res.currency).toBe("TRY");
  });

  it("extracts fields from both uncompressed and FlateDecode PDF text streams", () => {
    const contentStream = [
      "BT",
      "/F1 12 Tf",
      "(Çek Seri No: CK-884210) Tj",
      "(Keşideci TCKN: 12345678901) Tj",
      "(Vade Tarihi: 2026-07-30) Tj",
      "(Çek Tutarı: 48.900,50 EUR) Tj",
      "(IBAN: TR330006100519786457841326) Tj",
      "ET",
    ].join("\n");

    const compressed = deflateSync(Buffer.from(contentStream, "utf8"));
    const header = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length " +
        compressed.length +
        " >>\nstream\n",
      "latin1",
    );
    const footer = Buffer.from("\nendstream\nendobj\n%%EOF", "latin1");
    const pdfBuf = Buffer.concat([header, compressed, footer]);

    const res = extractStructuredDocumentFields(pdfBuf, "cek_yapragi.pdf", "application/pdf");

    expect(res.documentClass).toBe("check_leaf");
    expect(res.confidence).toBe("high");
    expect(res.documentNumber).toBe("CK-884210");
    expect(res.vknOrTckn).toBe("12345678901");
    expect(res.detectedDateIso).toBe("2026-07-30");
    expect(res.detectedAmount).toBe(48900.5);
    expect(res.currency).toBe("EUR");
    expect(res.iban).toBe("TR330006100519786457841326");
  });

  it("enforces BLANK != ZERO when a document contains no monetary amount", () => {
    const emptyRes = extractStructuredDocumentFields(Buffer.alloc(0), "bos.pdf", "application/pdf");
    expect(emptyRes.detectedAmount).toBeNull();
    expect(emptyRes.currency).toBeNull();
    expect(emptyRes.confidence).toBe("low");

    const noteRes = extractStructuredDocumentFields(
      Buffer.from("Yönetim kurulu bilgi notu — herhangi bir ödeme veya fatura tutarı içermez.", "utf8"),
      "toplanti_notu.txt",
      "text/plain",
    );
    expect(noteRes.detectedAmount).toBeNull();
    expect(noteRes.vknOrTckn).toBeNull();
    expect(noteRes.iban).toBeNull();
    expect(noteRes.confidence).toBe("low");
    expect(parseDocumentMoneyOrNull("")).toBeNull();
    expect(parseDocumentMoneyOrNull(null)).toBeNull();
  });
});

describe("extractMentions & collaboration comments", () => {
  it("parses @username mentions, strips punctuation, and ignores email addresses", () => {
    const text =
      "Lütfen bu faturayı kontrol et @Atilla, onay için @finans_op ve (@denetim.ekibi.) bilgilendirildi. E-posta: muhasebe@masmakina.com.tr ve tekrar @atilla!";
    expect(extractMentions(text)).toEqual(["atilla", "finans_op", "denetim.ekibi"]);
    expect(extractMentions("Hiç etiket olmayan düz açıklama.")).toEqual([]);
    expect(resolveCommentTargetHref("invoices", "inv-1")).toBe("/invoices?focus=inv-1");
    expect(resolveCommentTargetHref("work_orders", "wo-9")).toBe("/production?focus=wo-9");
  });

  it("persists entity comments with mentions and writes canonical audit() trail", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const fakeClient = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (/insert into public\.entity_comments/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "99999999-9999-4999-8999-999999999999",
                entity_table: params[0],
                entity_id: params[1],
                body: params[2],
                mentioned_usernames: params[3],
                author_id: params[4],
                author_username: "atilla",
                author_display_name: "Atilla Yönetici",
                created_at: "2026-05-20T10:00:00.000Z",
              },
            ],
          };
        }
        if (/insert into public\.audit_logs/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const fakePool = { connect: async () => fakeClient } as unknown as Pool;

    const saved = await addEntityComment(fakePool, {
      entityTable: "invoices",
      entityId: "11111111-1111-4111-8111-111111111111",
      body: "Mutabakat teyidi alındı @finans_op @merve.",
      actorId: "22222222-2222-4222-8222-222222222222",
    });

    expect(saved.mentionedUsernames).toEqual(["finans_op", "merve"]);
    expect(queries.some((q) => /insert into public\.entity_comments/i.test(q.sql))).toBe(true);
    expect(queries.some((q) => /insert into public\.audit_logs/i.test(q.sql))).toBe(true);
  });
});

describe("intercompany pair detection & consolidation elimination math", () => {
  const ENT_HQ = "10000000-0000-4000-8000-000000000001";
  const ENT_PROD = "10000000-0000-4000-8000-000000000002";
  const PARTY_PROD_IN_HQ = "20000000-0000-4000-8000-000000000001";
  const PARTY_HQ_IN_PROD = "20000000-0000-4000-8000-000000000002";
  const PARTY_EXTERNAL = "20000000-0000-4000-8000-000000000099";

  it("matches group VKNs, deduplicates bilateral mirrors, preserves decimal balance, and skips unknown FX", () => {
    expect(normalizeTaxVkn("612 000 0001")).toBe("6120000001");
    expect(normalizeTaxVkn("123")).toBeNull();

    const detection = detectIntercompanyPairs({
      legalEntities: [
        { id: ENT_HQ, code: "MAS-HQ", name: "MAS Holding A.Ş.", taxIdVkn: "6120000001" },
        { id: ENT_PROD, code: "MAS-URETIM", name: "MAS Üretim San. A.Ş.", taxIdVkn: "6120000002" },
      ],
      parties: [
        { id: PARTY_PROD_IN_HQ, name: "MAS Üretim Cari", taxNumber: "6120000002" },
        { id: PARTY_HQ_IN_PROD, name: "MAS Holding Cari", taxNumber: "6120000001" },
        { id: PARTY_EXTERNAL, name: "Üçüncü Taraf Çelik A.Ş.", taxNumber: "9998887776" },
      ],
      invoices: [
        // Bilateral mirror pair #1: HQ sells management service to PROD (open, partially paid)
        {
          id: "30000000-0000-4000-8000-000000000001",
          invoiceNo: "GIB2026000000777",
          direction: "sales",
          legalEntityId: ENT_HQ,
          partyId: PARTY_PROD_IN_HQ,
          issueDate: "2026-05-10",
          currency: "TRY",
          netAmount: "100000.33",
          grossAmount: "120000.40",
          payableAmount: "120000.40",
          paidAmount: "20000.10",
          status: "partial",
        },
        {
          id: "30000000-0000-4000-8000-000000000002",
          invoiceNo: "GIB2026000000777",
          direction: "purchase",
          legalEntityId: ENT_PROD,
          partyId: PARTY_HQ_IN_PROD,
          issueDate: "2026-05-10",
          currency: "TRY",
          netAmount: "100000.33",
          grossAmount: "120000.40",
          payableAmount: "120000.40",
          paidAmount: "20000.10",
          status: "partial",
          expenseAccountCode: "770",
        },
        // Unilateral intercompany pair #2: PROD bills subcontract machining to HQ (730 production cost, already paid)
        {
          id: "30000000-0000-4000-8000-000000000003",
          invoiceNo: "GIB2026000000888",
          direction: "purchase",
          legalEntityId: ENT_HQ,
          partyId: PARTY_PROD_IN_HQ,
          issueDate: "2026-05-15",
          currency: "TRY",
          netAmount: "50000.17",
          grossAmount: "60000.20",
          status: "paid",
          expenseAccountCode: "730",
        },
        // External invoice — must NOT be eliminated
        {
          id: "30000000-0000-4000-8000-000000000004",
          invoiceNo: "EXT2026000000111",
          direction: "purchase",
          legalEntityId: ENT_PROD,
          partyId: PARTY_EXTERNAL,
          issueDate: "2026-05-16",
          currency: "TRY",
          netAmount: "999999.00",
          grossAmount: "1199998.80",
          status: "open",
        },
        // Foreign currency intercompany invoice with missing FX rate — BLANK != ZERO: skip, never fabricate 1.0
        {
          id: "30000000-0000-4000-8000-000000000005",
          invoiceNo: "EUR2026000000999",
          direction: "sales",
          legalEntityId: ENT_HQ,
          partyId: PARTY_PROD_IN_HQ,
          issueDate: "2026-05-18",
          currency: "EUR",
          fxRateToTry: null,
          netAmount: "10000.00",
          grossAmount: "12000.00",
          status: "open",
        },
      ],
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
    });

    expect(detection.matchedPairCount).toBe(2);
    expect(detection.skippedUnknownCount).toBe(1);
    expect(detection.isBalanced).toBe(true);
    expect(detection.eliminatedArApTry).toBe(100000.3);
    expect(detection.eliminatedRevExpTry).toBe(150000.5);

    const debitSum = detection.lines.reduce((acc, l) => acc.plus(l.amountTry), decimal(0));
    const creditSum = detection.lines.reduce((acc, l) => acc.plus(l.amountTry), decimal(0));
    expect(debitSum.eq(creditSum)).toBe(true);
    expect(debitSum.toFixed(2)).toBe("250000.80");

    const arApLine = detection.lines.find((l) => l.eliminationKind === "ar_ap_120_320");
    expect(arApLine?.debitAccountCode).toBe("320");
    expect(arApLine?.creditAccountCode).toBe("120");
    expect(arApLine?.amountTry).toBe(100000.3);

    const prodLine = detection.lines.find((l) => l.creditAccountCode === "730");
    expect(prodLine?.debitAccountCode).toBe("600");
    expect(prodLine?.amountTry).toBe(50000.17);
  });

  it("writes intercompany elimination runs & audit without mutating standalone books", async () => {
    const executedSql: string[] = [];
    const fakeClient = {
      async query(sql: string) {
        executedSql.push(sql);
        if (/from public\.legal_entities/i.test(sql)) {
          return {
            rows: [
              { id: ENT_HQ, code: "MAS-HQ", name: "MAS Holding", tax_id_vkn: "6120000001" },
              { id: ENT_PROD, code: "MAS-PROD", name: "MAS Üretim", tax_id_vkn: "6120000002" },
            ],
          };
        }
        if (/from public\.parties/i.test(sql)) {
          return { rows: [{ id: PARTY_PROD_IN_HQ, name: "MAS Üretim", tax_number: "6120000002" }] };
        }
        if (/from public\.invoices/i.test(sql)) {
          return {
            rows: [
              {
                id: "30000000-0000-4000-8000-000000000010",
                invoice_no: "GIB2026000001000",
                direction: "sales",
                legal_entity_id: ENT_HQ,
                party_id: PARTY_PROD_IN_HQ,
                issue_date: "2026-05-12",
                currency: "TRY",
                net_amount: "25000.00",
                gross_amount: "30000.00",
                payable_amount: "30000.00",
                paid_amount: "0.00",
                allocated_amount: "0.00",
                status: "open",
                fx_rate_to_try: "1",
              },
            ],
          };
        }
        if (/insert into public\.intercompany_elimination_runs/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ id: "40000000-0000-4000-8000-000000000001", created_at: "2026-05-31T18:00:00Z" }],
          };
        }
        if (/insert into public\.intercompany_elimination_lines/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: "40000000-0000-4000-8000-000000000002" }] };
        }
        if (/insert into public\.audit_logs/i.test(sql)) {
          return { rowCount: 1, rows: [{ id: "40000000-0000-4000-8000-000000000003" }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release() {},
    };
    const fakePool = { connect: async () => fakeClient } as unknown as Pool;

    const res = await runIntercompanyElimination(fakePool, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      actorId: "50000000-0000-4000-8000-000000000001",
      notes: "Mayıs 2026 konsolidasyon",
    });

    expect(res.run.eliminatedArApTry).toBe(30000);
    expect(res.run.eliminatedRevExpTry).toBe(25000);
    expect(res.run.lines).toHaveLength(2);
    expect(
      executedSql.some((s) => /\b(update|delete|insert\s+into)\s+public\.(invoices|management_journal_entries)\b/i.test(s)),
    ).toBe(false);
    expect(executedSql.some((s) => /insert into public\.audit_logs/i.test(s))).toBe(true);
  });
});

describe("password-reset token hashing, TTL expiry, and anti-enumeration flow", () => {
  it("generates 32-byte CSPRNG hex tokens, hashes with SHA-256, and enforces 30-min TTL + single-use", () => {
    const fixedNow = Date.UTC(2026, 4, 20, 12, 0, 0);
    const minted = generatePasswordResetToken(fixedNow);

    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
    expect(minted.rawToken).toMatch(/^[a-f0-9]{64}$/);
    expect(minted.tokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(minted.tokenSha256).not.toBe(minted.rawToken);
    expect(minted.tokenSha256).toBe(hashResetToken(minted.rawToken));
    expect(new Date(minted.expiresAt).getTime() - fixedNow).toBe(PASSWORD_RESET_TTL_MS);

    expect(isResetTokenUsable({ expiresAt: minted.expiresAt, consumedAt: null }, fixedNow + 29 * 60_000)).toBe(true);
    expect(isResetTokenUsable({ expiresAt: minted.expiresAt, consumedAt: null }, fixedNow + 30 * 60_000)).toBe(false);
    expect(
      isResetTokenUsable(
        { expiresAt: minted.expiresAt, consumedAt: "2026-05-20T12:05:00.000Z" },
        fixedNow + 6 * 60_000,
      ),
    ).toBe(false);
  });

  it("never leaks user existence on requestPasswordReset and stores only sha256(token)", async () => {
    const transport = mockTransport({ channel: "email" });
    const insertedHashes: string[] = [];
    const auditPayloads: string[] = [];

    const makePool = (userFound: boolean): Pool =>
      ({
        connect: async () => ({
          async query(sql: string, params: unknown[] = []) {
            if (/select session_user/i.test(sql)) {
              return { rows: [{ sess_usr: "mas_radar_app", curr_usr: "mas_radar_app" }] };
            }
            if (/from public\.users/i.test(sql)) {
              return userFound
                ? {
                    rowCount: 1,
                    rows: [
                      {
                        id: "60000000-0000-4000-8000-000000000001",
                        username: "atilla",
                        display_name: "Atilla",
                        is_active: true,
                      },
                    ],
                  }
                : { rowCount: 0, rows: [] };
            }
            if (/insert into public\.password_reset_tokens/i.test(sql)) {
              insertedHashes.push(String(params[1]));
              return { rowCount: 1, rows: [{ id: "70000000-0000-4000-8000-000000000001" }] };
            }
            if (/insert into public\.audit_logs/i.test(sql)) {
              auditPayloads.push(String(params[5]));
              return { rowCount: 1, rows: [{ id: "80000000-0000-4000-8000-000000000001" }] };
            }
            return { rowCount: 0, rows: [] };
          },
          release() {},
        }),
      }) as unknown as Pool;

    const unknownRes = await requestPasswordReset(makePool(false), "olmayan@firma.com", "127.0.0.1", {
      transportOverride: transport,
    });
    expect(unknownRes).toEqual({ accepted: true });
    expect(transport.sent).toHaveLength(0);
    expect(insertedHashes).toHaveLength(0);

    const knownRes = await requestPasswordReset(makePool(true), "atilla", "127.0.0.1", {
      transportOverride: transport,
    });
    expect(knownRes).toEqual({ accepted: true });
    expect(transport.sent).toHaveLength(1);
    expect(insertedHashes).toHaveLength(1);

    const sentUrlToken = transport.sent[0].match(/token=([a-f0-9]{64})/)?.[1];
    expect(sentUrlToken).toBeDefined();
    expect(insertedHashes[0]).toBe(hashResetToken(sentUrlToken!));
    expect(auditPayloads[0]).not.toContain(sentUrlToken!);
    expect(auditPayloads[0]).not.toContain(insertedHashes[0]);
  });

  it("enforces 12-char policy, Argon2id hashing, session revocation, and lockout reset on completePasswordReset", async () => {
    const minted = generatePasswordResetToken();
    let storedPasswordHash = "";
    let sessionsRevokedCalled = false;

    const fakePool = {
      connect: async () => ({
        async query(sql: string, params: unknown[] = []) {
          if (/select session_user/i.test(sql)) {
            return { rows: [{ sess_usr: "mas_radar_app", curr_usr: "mas_radar_app" }] };
          }
          if (/update public\.password_reset_tokens/i.test(sql)) {
            expect(params[0]).toBe(minted.tokenSha256);
            return {
              rowCount: 1,
              rows: [
                {
                  id: "70000000-0000-4000-8000-000000000009",
                  user_id: "60000000-0000-4000-8000-000000000009",
                },
              ],
            };
          }
          if (/select id::text, username, is_active/i.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "60000000-0000-4000-8000-000000000009",
                  username: "finans_muduru",
                  is_active: true,
                  failed_login_count: 4,
                  must_change_password: true,
                },
              ],
            };
          }
          if (/update public\.users/i.test(sql)) {
            storedPasswordHash = String(params[1]);
            expect(sql).toContain("failed_login_count = 0");
            expect(sql).toContain("locked_until = null");
            return { rowCount: 1, rows: [] };
          }
          if (/update public\.sessions/i.test(sql)) {
            sessionsRevokedCalled = true;
            return { rowCount: 3, rows: [] };
          }
          if (/insert into public\.audit_logs/i.test(sql)) {
            return { rowCount: 1, rows: [{ id: "80000000-0000-4000-8000-000000000009" }] };
          }
          return { rowCount: 0, rows: [] };
        },
        release() {},
      }),
    } as unknown as Pool;

    await expect(completePasswordReset(fakePool, minted.rawToken, "kisa123")).rejects.toThrow(
      /en az 12 karakter/,
    );

    const newSecret = "GucluKurumsalParola!2026";
    const done = await completePasswordReset(fakePool, minted.rawToken, newSecret);

    expect(done).toEqual({
      ok: true,
      userId: "60000000-0000-4000-8000-000000000009",
      username: "finans_muduru",
      sessionsRevoked: 3,
    });
    expect(sessionsRevokedCalled).toBe(true);
    expect(storedPasswordHash.startsWith("$argon2id$")).toBe(true);
    expect(await argon2Verify(storedPasswordHash, newSecret)).toBe(true);
  });
});
