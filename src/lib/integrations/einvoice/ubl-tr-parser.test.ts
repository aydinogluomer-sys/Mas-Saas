import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractXmlEntriesFromZip, parseUblTrInvoiceXml } from "./ubl-tr-parser";

const SAMPLE_UBL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>GIB2026000001453</cbc:ID>
  <cbc:UUID>a1b2c3d4-e5f6-4789-abcd-1234567890ef</cbc:UUID>
  <cbc:IssueDate>2026-06-15</cbc:IssueDate>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="VKN">1234567890</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>Anadolu Çelik Sanayi A.Ş.</cbc:Name>
      </cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="VKN">9876543210</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName>
        <cbc:Name>MAS Üretim A.Ş.</cbc:Name>
      </cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="TRY">2000.00</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">10000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="TRY">10000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">12000.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="TRY">12000.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="KGM">250</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">10000.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">2000.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:Percent>20</cbc:Percent>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>ST-52 Çelik Mil</cbc:Name>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="TRY">40.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

function buildSingleEntryZip(filename: string, contentUtf8: string): Buffer {
  const nameBuf = Buffer.from(filename, "utf8");
  const rawBuf = Buffer.from(contentUtf8, "utf8");
  const compressed = deflateRawSync(rawBuf);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header sig
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(8, 8); // method=8 deflate
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(rawBuf.length, 22);
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuf, compressed]);
}

describe("GİB UBL-TR 1.2 Parser (M-64)", () => {
  it("parses header, VKNs, LegalMonetaryTotal, and InvoiceLine accurately", () => {
    const parsed = parseUblTrInvoiceXml(SAMPLE_UBL_XML);
    expect(parsed.invoiceNo).toBe("GIB2026000001453");
    expect(parsed.ublUuid).toBe("a1b2c3d4-e5f6-4789-abcd-1234567890ef");
    expect(parsed.issueDate).toBe("2026-06-15");
    expect(parsed.currency).toBe("TRY");
    expect(parsed.supplierVkn).toBe("1234567890");
    expect(parsed.supplierName).toBe("Anadolu Çelik Sanayi A.Ş.");
    expect(parsed.customerVkn).toBe("9876543210");
    expect(parsed.netAmount).toBe(10000);
    expect(parsed.vatAmount).toBe(2000);
    expect(parsed.grossAmount).toBe(12000);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0].itemName).toBe("ST-52 Çelik Mil");
    expect(parsed.lines[0].quantity).toBe(250);
    expect(parsed.lines[0].unitCode).toBe("KGM");
    expect(parsed.lines[0].vatRate).toBe(0.2);
  });

  it("extracts deflated XML entries from a ZIP archive", () => {
    const zip = buildSingleEntryZip("fatura-1453.xml", SAMPLE_UBL_XML);
    const entries = extractXmlEntriesFromZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe("fatura-1453.xml");
    const parsed = parseUblTrInvoiceXml(entries[0].xml);
    expect(parsed.invoiceNo).toBe("GIB2026000001453");
  });
});

