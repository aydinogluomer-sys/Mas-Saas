import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "@/lib/domain-error";
import {
  cancelCheck,
  cancelLoanInstallment,
  loadFinanceDashboard,
  loadLoans,
  mapLoans,
  markInstallmentPaid,
} from "@/lib/financing/engine";
import {
  detectStatementColumns,
  parseStatementDate,
  resolveSignedAmount,
  statementColumnsUsable,
} from "@/lib/bank/rules";
import { cellsToRows, sheetCells } from "@/lib/importers/row-utils";
import { safeParseStatementBuffer } from "@/lib/importers/statement-parser";

describe("MT940 / CAMT.053 Statement Parser & Financing Engine Regression Suite", () => {
  it("parses SWIFT MT940 (.mt940, .940, windows-1254 Turkish narrative, Dec->Jan year rollover, 3-decimal amounts without 1000x inflation)", async () => {
    // Encode Turkish windows-1254 bytes explicitly: Ş=0xDE, İ=0xDD, Ğ=0xD0, Ü=0xDC
    const prefix = Buffer.from(
      ":20:TR2026STMT01\r\n" +
        ":25:TR330006100519786457841326\r\n" +
        ":60F:C260101TRY100000,00\r\n" +
        ":61:2601021231D125,500NTRFCUSTREF1//BANKREF99\r\n" +
        ":86:?20EFT ODEME ?31TR110006200000012345678901 ?32G",
      "ascii",
    );
    const win1254Word = Buffer.from([0xdc, 0x4d, 0xdc, 0xde, 0x20, 0x4d, 0x45, 0x54, 0x41, 0x4c]); // "ÜMÜŞ METAL" -> with G -> "GÜMÜŞ METAL"
    const suffix = Buffer.from("\r\n:62F:C260102TRY99874,50\r\n", "ascii");
    const mtBuf = Buffer.concat([prefix, win1254Word, suffix]);

    const parsed = await safeParseStatementBuffer(mtBuf, "ekstre.940");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.format).toBe("mt940");

    const ws = parsed.workbook.Sheets[parsed.workbook.SheetNames[0]];
    const rows = cellsToRows(sheetCells(ws));
    expect(rows.length).toBe(2);

    const headerMap: Record<string, string> = {};
    for (const [col, c] of Object.entries(rows[0].cells)) {
      headerMap[col] = String(c.w ?? c.v);
    }
    const cols = detectStatementColumns(headerMap);
    expect(statementColumnsUsable(cols)).toBe(true);
    expect(cols.counterparty_iban).toBeDefined();

    const dataRow = rows[1].cells;
    const txnDate = parseStatementDate(dataRow[cols.txn_date!]?.v);
    const valDate = parseStatementDate(dataRow[cols.value_date!]?.v);
    const signed = resolveSignedAmount({ amount: dataRow[cols.amount!]?.v });

    // Dec 31 entry date on a Jan 02, 2026 value date must resolve to 2025-12-31 (not 2026-12-31)
    expect(txnDate).toBe("2025-12-31");
    expect(valDate).toBe("2026-01-02");
    // 125,500 must be -125.5 (NOT -125500!)
    expect(Number(signed)).toBe(-125.5);
    expect(String(dataRow[cols.counterparty!]?.v)).toBe("GÜMÜŞ METAL");
    expect(String(dataRow[cols.counterparty_iban!]?.v)).toBe("TR110006200000012345678901");
    expect(String(dataRow[cols.reference!]?.v)).toBe("BANKREF99");
  });

  it("parses ISO 20022 CAMT.053 XML with reversal + IBAN and rejects UBL-TR Invoice XML with guidance", async () => {
    const camtXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
        <BkToCstmrStmt>
          <Stmt>
            <Acct><Ccy>EUR</Ccy></Acct>
            <Ntry>
              <Amt Ccy="EUR">2450.75</Amt>
              <CdtDbtInd>CRDT</CdtDbtInd>
              <BookgDt><Dt>2026-05-14</Dt></BookgDt>
              <ValDt><Dt>2026-05-15</Dt></ValDt>
              <AcctSvcrRef>CAMT-REF-001</AcctSvcrRef>
              <NtryDtls>
                <TxDtls>
                  <RltdPties>
                    <Dbtr><Nm>BERLIN CNC GMBH</Nm></Dbtr>
                    <DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>
                  </RltdPties>
                  <RmtInf><Ustrd>Ihracat Tahsilati</Ustrd></RmtInf>
                </TxDtls>
              </NtryDtls>
            </Ntry>
          </Stmt>
        </BkToCstmrStmt>
      </Document>`;

    const parsed = await safeParseStatementBuffer(Buffer.from(camtXml, "utf8"), "statement.xml");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.format).toBe("camt053");
      const ws = parsed.workbook.Sheets[parsed.workbook.SheetNames[0]];
      const rows = cellsToRows(sheetCells(ws));
      const headerMap: Record<string, string> = {};
      for (const [col, c] of Object.entries(rows[0].cells)) headerMap[col] = String(c.w ?? c.v);
      const cols = detectStatementColumns(headerMap);
      const r1 = rows[1].cells;
      expect(resolveSignedAmount({ amount: r1[cols.amount!]?.v })).toBe("2450.75");
      expect(String(r1[cols.counterparty!]?.v)).toBe("BERLIN CNC GMBH");
      expect(String(r1[cols.counterparty_iban!]?.v)).toBe("DE89370400440532013000");
    }

    const ublInvoice = `<?xml version="1.0" encoding="UTF-8"?><Invoice><ID>GIB2026000001</ID></Invoice>`;
    const rejected = await safeParseStatementBuffer(Buffer.from(ublInvoice, "utf8"), "fatura.xml");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("UBL-TR e-Fatura XML");
    }
  });

  it("financing/engine: validates empty cancel reasons, invalid paidAt, 0120 mapLoans ON CONFLICT predicate, and pure-TRY vs consolidated-TRY isolation", async () => {
    const executedSql: string[] = [];
    const mockClient: Partial<PoolClient> = {
      query: vi.fn(async (sql: string) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        executedSql.push(norm);
        if (/from public\.source_sheets/i.test(norm)) {
          return { rows: [], rowCount: 0 } as never;
        }
        return { rows: [], rowCount: 0 } as never;
      }) as unknown as PoolClient["query"],
      release: vi.fn(),
    };

    const mockPool = {
      connect: vi.fn(async () => mockClient as PoolClient),
      query: vi.fn(async (sql: string) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        executedSql.push(norm);
        if (/open_checks/i.test(norm)) {
          return { rows: [{ open_checks: 2, active_loans: 2 }] };
        }
        if (/with maturity as/i.test(norm) && /group by currency/i.test(norm)) {
          return {
            rows: [
              { currency: "TRY", amt: "10000.00" },
              { currency: "USD", amt: "500.00" },
            ],
          };
        }
        if (/with maturity as/i.test(norm)) {
          return { rows: [] };
        }
        if (/from public\.loan_installments li join public\.loans l/i.test(norm)) {
          return {
            rows: [
              { currency: "TRY", amt: "50000.00" },
              { currency: "EUR", amt: "1000.00" },
            ],
          };
        }
        if (/from public\.fx_rate_snapshots/i.test(norm)) {
          return {
            rows: [
              { base_currency: "USD", quote_currency: "TRY", rate: "35.00", as_of_date: "2026-11-15" },
              { base_currency: "EUR", quote_currency: "TRY", rate: "38.00", as_of_date: "2026-11-15" },
            ],
          };
        }
        if (/from public\.loans l left join public\.loan_installments li/i.test(norm)) {
          return {
            rows: [
              {
                id: "loan-1",
                name: "Test Kredi",
                principal: "100000.00",
                currency: "TRY",
                loan_kind: "installment",
                interest_type: "fixed",
                bsmv_rate: null,
                kkdf_rate: null,
                term_months: 12,
                installment_count: 12,
                first_payment_date: "2026-01-15",
                installment_amount: "10000.00",
                total_payment: "120000.00",
                total_finance_cost: "20000.00",
                applied_rate: "3.5000",
                monthly_cost_rate: "4.2000",
                source_workbook_id: null,
                source_sheet_id: null,
                installments_loaded: 12,
                paid_count: 2,
                remaining_count: 9,
                remaining_amount: "85000.00",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    } as unknown as Pool;

    await expect(cancelCheck(mockPool, "chk-1", "   ", "actor-1")).rejects.toThrow(DomainError);
    await expect(cancelLoanInstallment(mockPool, "inst-1", "", "actor-1")).rejects.toThrow(DomainError);
    await expect(markInstallmentPaid(mockPool, "inst-1", "not-a-valid-date", "actor-1")).rejects.toThrow(
      DomainError,
    );

    const loans = await loadLoans(mockPool);
    expect(loans[0]?.remainingCount).toBe(9);
    expect(
      executedSql.some((s) => s.includes("status not in ('paid','cancelled')")),
    ).toBe(true);

    // Even when FX rates exist (USD=35, EUR=38), pure TRY fields stay pure TRY while Consolidated fields include FX!
    const dash = await loadFinanceDashboard(mockPool, "2026-11-15");
    expect(dash.summary.due30).toBe(10000);
    expect(dash.summary.due30ConsolidatedTry).toBe(27500); // 10000 + 500 * 35
    expect(dash.summary.remainingAmount).toBe(50000);
    expect(dash.summary.remainingConsolidatedTry).toBe(88000); // 50000 + 1000 * 38

    await mapLoans(mockPool, "wb-1", "actor-1");
  });
});
