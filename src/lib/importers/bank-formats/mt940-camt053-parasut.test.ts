import { describe, expect, it } from "vitest";
import {
  parseCamt053Statement,
  parseHybridBankBuffer,
  parseMt940Statement,
} from "./mt940-camt053-parasut";

describe("MT940 & ISO 20022 camt.053 hybrid bank statement parsers", () => {
  it("parses SWIFT MT940 :25:, :60F:, :61: (C/D/RC/RD) and :86: narrative + IBAN", () => {
    const sampleMt940 = [
      ":20:STMT20261113",
      ":25:TR33 0006 1005 1978 6457 8413 26",
      ":28C:00012/001",
      ":60F:C261101TRY125000,00",
      ":61:2611051105C45250,75NTRFCUSTREF01//BNKREF9001",
      ":86:GELEN FAST TAHSILAT ACME SANAYI TR120006200000001234567890",
      ":61:2611061106D12000,00NTRFVENREF02//BNKREF9002",
      ":86:EFT ODEME CELIK TEDARIK A.S.",
      ":62F:C261106TRY158250,75",
      "-}",
    ].join("\r\n");

    const parsed = parseMt940Statement(sampleMt940);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.format).toBe("mt940");
    expect(parsed.accountIban).toBe("TR330006100519786457841326");
    expect(parsed.currency).toBe("TRY");
    expect(parsed.lines).toHaveLength(2);

    expect(parsed.lines[0]).toMatchObject({
      txnDate: "2026-11-05",
      valueDate: "2026-11-05",
      amount: 45250.75,
      currency: "TRY",
      counterpartyIban: "TR120006200000001234567890",
      referenceNo: "BNKREF9001",
      channel: "mt940",
    });

    expect(parsed.lines[1]).toMatchObject({
      txnDate: "2026-11-06",
      valueDate: "2026-11-06",
      amount: -12000,
      currency: "TRY",
      referenceNo: "BNKREF9002",
      channel: "mt940",
    });
  });

  it("parses ISO 20022 camt.053 XML entries with CRDT/DBIT signs, currency and related parties", () => {
    const sampleCamt053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <Stmt>
      <Acct>
        <Id><IBAN>TR440001000200030004000506</IBAN></Id>
        <Ccy>EUR</Ccy>
      </Acct>
      <Ntry>
        <Amt Ccy="EUR">18500.50</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-11-10</Dt></BookgDt>
        <ValDt><Dt>2026-11-11</Dt></ValDt>
        <AcctSvcrRef>CAMT-REF-101</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Dbtr><Nm>Musteri GmbH</Nm></Dbtr>
              <DbtrAcct><Id><IBAN>TR880001000200030004000599</IBAN></Id></DbtrAcct>
            </RltdPties>
            <RmtInf><Ustrd>Ihracat Bedeli INV-2026-099</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">3200.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-11-12</Dt></BookgDt>
        <ValDt><Dt>2026-11-12</Dt></ValDt>
        <AcctSvcrRef>CAMT-REF-102</AcctSvcrRef>
        <NtryDtls>
          <TxDtls>
            <RltdPties>
              <Cdtr><Nm>Hammadde Tedarik AG</Nm></Cdtr>
            </RltdPties>
            <RmtInf><Ustrd>Hammadde Ithalat Odemesi</Ustrd></RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

    const parsed = parseCamt053Statement(sampleCamt053);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.format).toBe("camt053");
    expect(parsed.accountIban).toBe("TR440001000200030004000506");
    expect(parsed.currency).toBe("EUR");
    expect(parsed.lines).toHaveLength(2);

    expect(parsed.lines[0]).toMatchObject({
      txnDate: "2026-11-10",
      valueDate: "2026-11-11",
      amount: 18500.5,
      currency: "EUR",
      counterpartyName: "Musteri GmbH",
      counterpartyIban: "TR880001000200030004000599",
      referenceNo: "CAMT-REF-101",
      description: "Ihracat Bedeli INV-2026-099",
    });

    expect(parsed.lines[1]).toMatchObject({
      txnDate: "2026-11-12",
      amount: -3200,
      currency: "EUR",
      counterpartyName: "Hammadde Tedarik AG",
      referenceNo: "CAMT-REF-102",
    });
  });

  it("rejects 0-byte buffers and non-matching payloads cleanly via parseHybridBankBuffer", async () => {
    const emptyRes = await parseHybridBankBuffer(Buffer.alloc(0), "ekstre.sta");
    expect(emptyRes.ok).toBe(false);

    const mtRes = await parseHybridBankBuffer(
      Buffer.from(":25:TR330006100519786457841326\n:60F:C261101USD1000,00\n:61:2611021102C250,00NTRFNONREF//R1\n:86:USD INFLOW\n", "utf8"),
      "ekstre.mt940",
    );
    expect(mtRes.ok).toBe(true);
    if (mtRes.ok) {
      expect(mtRes.currency).toBe("USD");
      expect(mtRes.lines[0]?.amount).toBe(250);
    }
  });
});

