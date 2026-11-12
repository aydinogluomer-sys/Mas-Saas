import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { inspectZipSafety, MAX_UNCOMPRESSED_BYTES } from "@/lib/importers/zip-guard";
import {
  decodeTurkishCsvBuffer,
  detectCsvDelimiter,
  parseCsvStatementBuffer,
} from "@/lib/importers/csv-parser";
import {
  asNumber,
  asText,
  cellsToMap,
  cellsToRows,
  excelJsValueToCellVal,
  sheetCells,
} from "@/lib/importers/row-utils";
import { safeParseWorkbookBuffer } from "@/lib/importers/workbook-parser";
import { safeParseStatementBuffer } from "@/lib/importers/statement-parser";
import {
  extractChecks,
  extractLoan,
  extractMonthlyCashflow,
  extractPaymentMatrix,
} from "@/lib/importers/extractors";
import { toXlsxBuffer } from "@/lib/analytics/export";
import { parseNormalizedSourceCellNumeric } from "@/lib/data-quality/engine";
import { parseDate, parseMonth } from "@/lib/importers/v2/values";
import { buildFixtureWorkbook } from "@/lib/importers/v2/fixture";
import { sheetByName } from "@/lib/importers/v2/contract";
import { parseWorkbook } from "@/lib/importers/v2/parser";
import { mapWorkbook, transactionFingerprint } from "@/lib/importers/v2/mapper";

/** Minimal valid single-entry ZIP builder with configurable declared uncompressed sizes for ZIP-bomb tests. */
function buildSyntheticZip(opts: {
  localUncompressedSize: number;
  cdUncompressedSize: number;
  entryCount?: number;
}): Buffer {
  const count = opts.entryCount ?? 1;
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let localOffset = 0;

  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`xl/sheet${i + 1}.xml`, "utf8");
    const payload = Buffer.from("<worksheet/>", "utf8");

    const local = Buffer.alloc(30 + name.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(0, 14); // crc32
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(opts.localUncompressedSize, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    payload.copy(local, 30 + name.length);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(payload.length, 20); // compressed size
    cd.writeUInt32LE(opts.cdUncompressedSize, 24); // uncompressed size
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(localOffset, 42);
    name.copy(cd, 46);

    localParts.push(local);
    cdParts.push(cd);
    localOffset += local.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe("Faz 41 (B1) — ExcelJS tekilleştirme, ZIP bombası kalkanı, CSV ve V1/V2/DQ doğruluğu", () => {
  describe("1. ZIP bombası ve eski .xls güvenlik bekçisi (zip-guard.ts)", () => {
    it("eski ikili .xls (CFB 0xd0cf11e0) dosyasını açık Türkçe mesajla reddeder", async () => {
      const legacyXls = Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(128, 0),
      ]);
      const guard = inspectZipSafety(legacyXls);
      expect(guard.ok).toBe(false);
      if (!guard.ok) {
        expect(guard.code).toBe("LEGACY_XLS");
        expect(guard.error).toContain("Eski .xls biçimi güvenlik nedeniyle desteklenmiyor");
      }

      const stmt = await safeParseStatementBuffer(legacyXls, "banka.xls");
      expect(stmt.ok).toBe(false);
      if (!stmt.ok) {
        expect(stmt.error).toContain("Eski .xls biçimi güvenlik nedeniyle desteklenmiyor");
      }
    });

    it("100 MB açılmış boyutu aşan ZIP bombasını (hem CD hem sahte yerel başlıkta) ExcelJS'ten önce reddeder", async () => {
      const cdBomb = buildSyntheticZip({
        localUncompressedSize: 1024,
        cdUncompressedSize: MAX_UNCOMPRESSED_BYTES + 1024,
      });
      const r1 = inspectZipSafety(cdBomb);
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.code).toBe("UNCOMPRESSED_TOO_LARGE");

      // CD küçük gösterip yerel başlıkta 105 MB bildiren sahte ZIP de yakalanmalı
      const spoofedLocalBomb = buildSyntheticZip({
        localUncompressedSize: MAX_UNCOMPRESSED_BYTES + 5 * 1024 * 1024,
        cdUncompressedSize: 12,
      });
      const r2 = inspectZipSafety(spoofedLocalBomb);
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.code).toBe("UNCOMPRESSED_TOO_LARGE");

      const parsed = await safeParseWorkbookBuffer(spoofedLocalBomb);
      expect(parsed.ok).toBe(false);
    });

    it("512 iç dosya sınırını aşan ZIP arşivini reddeder", () => {
      const tooMany = buildSyntheticZip({
        localUncompressedSize: 12,
        cdUncompressedSize: 12,
        entryCount: 513,
      });
      const r = inspectZipSafety(tooMany);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("TOO_MANY_ENTRIES");
    });

    it("toXlsxBuffer ile üretilen gerçek ExcelJS çıktısı zip-guard ve safeParseWorkbookBuffer'dan geçer", async () => {
      const buf = await toXlsxBuffer([
        {
          name: "Nakit Özeti",
          rows: [
            ["Kalem", "Tutar"],
            ["Kasa", 125000.5],
            ["=KOMUT_ENJEKSIYONU()", null],
          ],
        },
      ]);
      const guard = inspectZipSafety(buf);
      expect(guard.ok).toBe(true);

      const parsed = await safeParseWorkbookBuffer(buf);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const ws = parsed.workbook.Sheets["Nakit Özeti"]!;
        // Formül enjeksiyonu tek tırnak ile etkisizleştirilmeli, null hücre boş kalmalı (0 değil!)
        expect(ws["A3"]).toMatchObject({ v: "'=KOMUT_ENJEKSIYONU()", t: "s" });
        expect(ws["B3"]).toBeUndefined();
      }
    });
  });

  describe("2. V1 formül hataları (#REF!, #DIV/0!, #VALUE!, #N/A) — asla 23 TL veya 1900-01-22 olmaz", () => {
    const ERROR_TOKENS = ["#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NUM!"] as const;

    it.each(ERROR_TOKENS)("excelJsValueToCellVal(%s) t='e' üretir; asNumber ve asText null döner", (token) => {
      const directErr = excelJsValueToCellVal({ error: token });
      expect(directErr).toEqual({ v: token, t: "e", w: token });
      expect(asNumber(directErr ?? undefined)).toBeNull();
      expect(asText(directErr ?? undefined)).toBeNull();

      const formulaErr = excelJsValueToCellVal({ formula: "A1/B1", result: { error: token } });
      expect(formulaErr).toEqual({ v: token, t: "e", w: token, f: "A1/B1" });
      expect(asNumber(formulaErr ?? undefined)).toBeNull();
      expect(asText(formulaErr ?? undefined)).toBeNull();
    });

    it("gerçek .xlsx içindeki #REF! hücresi ÇEKLER, aylık nakit akışı, ödeme tablosu ve kredide formula_error incelemesi açar", async () => {
      const wb = new ExcelJS.Workbook();

      const checksWs = wb.addWorksheet("ÇEKLER");
      checksWs.addRow(["TARİH", "KİME", "TUTAR"]);
      checksWs.getCell("A2").value = { formula: "Sheet99!A1", result: { error: "#REF!" } } as unknown as ExcelJS.CellValue;
      checksWs.getCell("B2").value = "TEDARİKÇİ A.Ş.";
      checksWs.getCell("C2").value = { formula: "Sheet99!C1", result: { error: "#REF!" } } as unknown as ExcelJS.CellValue;

      const cfWs = wb.addWorksheet("mayıs 2026");
      cfWs.getCell("A1").value = "devir";
      cfWs.getCell("B1").value = { formula: "1/0", result: { error: "#DIV/0!" } } as unknown as ExcelJS.CellValue;
      cfWs.getCell("I1").value = "kasa";
      cfWs.getCell("J1").value = 50000;
      cfWs.getCell("A5").value = "MÜŞTERİ X";
      cfWs.getCell("B5").value = { formula: "A5+1", result: { error: "#VALUE!" } } as unknown as ExcelJS.CellValue;

      const payWs = wb.addWorksheet("ödeme tablosu");
      payWs.getCell("A6").value = "KİRA";
      payWs.getCell("B6").value = "x";
      payWs.getCell("AG6").value = { formula: "VLOOKUP(1,A1:B2,5,0)", result: { error: "#N/A" } } as unknown as ExcelJS.CellValue;

      const loanWs = wb.addWorksheet("faiz hesaplama");
      loanWs.getCell("B4").value = { error: "#REF!" } as unknown as ExcelJS.CellValue;

      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const parsed = await safeParseWorkbookBuffer(buf);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // 1) ÇEKLER: #REF! asla 23 TL veya 1900-01-22 olmaz!
      const checkRows = cellsToRows(sheetCells(parsed.workbook.Sheets["ÇEKLER"]!));
      const checksOut = extractChecks(checkRows);
      expect(checksOut.candidates[0]?.maturityDate).toBeNull();
      expect(checksOut.candidates[0]?.signedAmount).toBeNull();
      expect(checksOut.issues.some((r) => r.issue_type === "formula_error")).toBe(true);

      // 2) Aylık nakit akışı
      const cfCells = sheetCells(parsed.workbook.Sheets["mayıs 2026"]!);
      const cfOut = extractMonthlyCashflow("mayıs 2026", cellsToMap(cfCells));
      expect(cfOut.opening).toBeNull();
      expect(cfOut.issues.filter((r) => r.issue_type === "formula_error").length).toBeGreaterThanOrEqual(2);

      // 3) Ödeme tablosu
      const payRows = cellsToRows(sheetCells(parsed.workbook.Sheets["ödeme tablosu"]!));
      const payOut = extractPaymentMatrix(payRows);
      expect(payOut.candidates[0]?.amountCandidate).toBeNull();
      expect(payOut.issues.some((r) => r.issue_type === "formula_error")).toBe(true);

      // 4) Kredi hesaplama
      const loanCells = sheetCells(parsed.workbook.Sheets["faiz hesaplama"]!);
      const loanOut = extractLoan(cellsToMap(loanCells));
      expect(loanOut.loan.principal).toBeNull();
      expect(loanOut.issues.some((r) => r.issue_type === "formula_error")).toBe(true);
    });
  });

  describe("3. Deterministik Türkçe CSV ayrıştırıcısı (csv-parser.ts)", () => {
    it("tırnak içi kuruş virgülünü ('\"1.234,56\"') sütun ayırıcısı sanmaz ve açık '0,00' değerini korur", async () => {
      const csvText = '\ufeffİşlem Tarihi;Açıklama;Borç;Alacak;Bakiye\r\n02.05.2026;"EFT, HAVALE MASRAFI";"0,00";"1.234,56";"10.000,00"\r\n';
      expect(detectCsvDelimiter(csvText)).toBe(";");

      const parsed = await safeParseStatementBuffer(Buffer.from(csvText, "utf8"), "ekstre.csv");
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const ws = parsed.workbook.Sheets[parsed.workbook.SheetNames[0]!]!;
        expect(ws["A1"]).toMatchObject({ v: "İşlem Tarihi" });
        expect(ws["C2"]).toMatchObject({ v: "0,00" }); // açık 0,00 asla null olmaz!
        expect(ws["D2"]).toMatchObject({ v: "1.234,56" });
      }
    });

    it("virgül ayırıcılı CSV'de bile tırnak içi Türkçe tutarları tek hücrede tutar", () => {
      const csv = Buffer.from('Tarih,Aciklama,Tutar\n2026-05-02,"Kira, Mayıs","35.000,75"\n', "utf8");
      const res = parseCsvStatementBuffer(csv);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.delimiter).toBe(",");
        expect(res.rows[1]).toEqual(["2026-05-02", "Kira, Mayıs", "35.000,75"]);
      }
    });

    it("Türkçe windows-1254 (ISO-8859-9) kodlu banka ekstresini bozulmadan çözer", () => {
      // windows-1254: 0xdd = 'İ', 0xfe = 'ş', 0xd0 = 'Ğ', 0xfc = 'ü'
      const win1254Bytes = Buffer.from([
        0xdd, 0xfe, 0x6c, 0x65, 0x6d, 0x3b, // "İşlem;"
        0x54, 0x75, 0x74, 0x61, 0x72, 0x0a, // "Tutar\n"
        0x4d, 0x41, 0x53, 0xd0, 0xfc, 0x3b, // "MASĞü;"
        0x31, 0x35, 0x2c, 0x30, 0x30, 0x0a, // "15,00\n"
      ]);
      const decoded = decodeTurkishCsvBuffer(win1254Bytes);
      expect(decoded.encoding).toBe("windows-1254");
      expect(decoded.text).toContain("İşlem;Tutar");
      expect(decoded.text).toContain("MASĞü;15,00");
    });
  });

  describe("4. Veri Kalitesi (data-quality) 100x ondalık nokta mutabakatı", () => {
    it("standart JS ondalık metninde ('123456.78') noktayı silmez; Türkçe biçimi ('123.456,78') doğru çevirir", () => {
      expect(parseNormalizedSourceCellNumeric("123456.78", "number")).toBe("123456.78");
      expect(parseNormalizedSourceCellNumeric("-9876.50", "number")).toBe("-9876.50");
      expect(parseNormalizedSourceCellNumeric("123.456,78", "string")).toBe("123456.78");
      expect(parseNormalizedSourceCellNumeric("1.500.000", "string")).toBe("1500000");
      expect(parseNormalizedSourceCellNumeric("45,90", "string")).toBe("45.90");
      expect(parseNormalizedSourceCellNumeric("#REF!", "error")).toBeNull();
      expect(parseNormalizedSourceCellNumeric("123456.78", "error")).toBeNull();
      expect(parseNormalizedSourceCellNumeric("belirsiz metin", "string")).toBeNull();
    });
  });

  describe("5. Standart Import V2 doğruluk düzeltmeleri (values.ts, parser.ts, mapper.ts)", () => {
    it("saat bileşenli Excel seri numarasını (45583.75 = 18:00) ertesi güne yuvarlamaz", () => {
      const d = parseDate(45583.75);
      expect(d.status).toBe("ok");
      expect(d.value).toBe("2024-10-18");
    });

    it("parseMonth '01.05.2026' (GG.AA.YYYY, gün=01) değerini '2026-05' olarak kabul eder; imkânsız tarihi ('31.02.2026') reddeder", () => {
      const ok = parseMonth("01.05.2026");
      expect(ok.status).toBe("ok");
      expect(ok.value).toBe("2026-05");

      const impossible = parseMonth("31.02.2026");
      expect(impossible.status).toBe("invalid");
    });

    it("3 ondalıklı KDV yuvarlama uyuşmazlığını (100.004 + 20.004 vs 120.008) invoices_gross_check patlamadan satır bazında yakalar", async () => {
      const wb = await buildFixtureWorkbook();
      const ws = wb.getWorksheet("08_FATURALAR")!;
      const spec = sheetByName("08_FATURALAR")!;
      const badVatRow: Record<string, unknown> = {
        external_id: "FTR-3DEC-MISMATCH",
        fatura_tipi: "purchase",
        fatura_no: "FTR-2026-999",
        karsi_taraf: "Test Tedarikçi A.Ş.",
        duzenleme_tarihi: "2026-05-01",
        vade_tarihi: "2026-05-31",
        net_tutar: 100.004,
        vergi_tutari: 20.004,
        toplam_tutar: 120.008, // round(2): 100.00 + 20.00 = 120.00 !== 120.01
        para_birimi: "TRY",
        durum: "open",
      };
      ws.addRow(spec.columns.map((c) => (c.key in badVatRow ? badVatRow[c.key] : null)));

      const parsed = parseWorkbook(wb);
      const sheet = parsed.sheets.find((s) => s.sheet === "08_FATURALAR")!;
      const target = sheet.rows.find((r) => r.values.external_id === "FTR-3DEC-MISMATCH")!;
      expect(target.status).toBe("rejected");
      expect(target.issues.some((i) => i.type === "amount_mismatch")).toBe(true);
    });

    it("V2 yeniden aktarımda mevcut faturanın paid_amount > 0 ve status='partial' durumunu sıfırlamaz; aynı gün iki EFT masrafını ezmez", async () => {
      const wb = await buildFixtureWorkbook();

      // 1) Fatura sayfasına mevcut ödenmiş/kısmi ödenmiş bir fatura satırı ekle
      const invWs = wb.getWorksheet("08_FATURALAR")!;
      const invSpec = sheetByName("08_FATURALAR")!;
      const invRow: Record<string, unknown> = {
        external_id: "FTR-PARTIAL-KEEP",
        fatura_tipi: "purchase",
        fatura_no: "FTR-KEEP-01",
        karsi_taraf: "Çelik Tedarik A.Ş.",
        duzenleme_tarihi: "2026-05-02",
        vade_tarihi: "2026-06-02",
        net_tutar: 1000,
        vergi_tutari: 200,
        toplam_tutar: 1200,
        para_birimi: "TRY",
        durum: "open",
      };
      invWs.addRow(invSpec.columns.map((c) => (c.key in invRow ? invRow[c.key] : null)));

      // 2) Banka hareketleri sayfasına aynı hesapta (BANKA-VAKIF-TL) aynı gün aynı tutarlı İKİ özdeş EFT masrafı ekle (kodsuz)
      const btWs = wb.getWorksheet("07_BANKA_HAREKETLERI")!;
      const btSpec = sheetByName("07_BANKA_HAREKETLERI")!;
      const feeRow: Record<string, unknown> = {
        account_external_id: "BANKA-VAKIF-TL",
        islem_tarihi: "2026-05-10",
        tutar: 15,
        yon: "outflow",
        para_birimi: "TRY",
        aciklama: "EFT ÜCRETİ",
      };
      btWs.addRow(btSpec.columns.map((c) => (c.key in feeRow ? feeRow[c.key] : null)));
      btWs.addRow(btSpec.columns.map((c) => (c.key in feeRow ? feeRow[c.key] : null)));

      expect(transactionFingerprint(feeRow, null, 1)).not.toBe(transactionFingerprint(feeRow, null, 2));
      expect(transactionFingerprint(feeRow, null, 2)).toContain("|ord:2");

      const parsed = parseWorkbook(wb);

      // Sahte istemci: FTR-PARTIAL-KEEP defterde 'inv-existing-1' kaydına bağlı ve paid_amount=450, status='partial'
      const ledger = new Map<string, string>([
        ["invoices/FTR-PARTIAL-KEEP", "inv-existing-1"],
      ]);
      const invoiceUpdates: Array<{ sql: string; values: unknown[] }> = [];
      const bankInserts: Array<{ sql: string; values: unknown[] }> = [];
      let seq = 0;

      const fakeClient = {
        async query(text: string, values: unknown[] = []) {
          const t = text.trim().toLowerCase();
          if (t.startsWith("select entity_id from public.import_external_keys")) {
            const id = ledger.get(`${String(values[0])}/${String(values[1])}`);
            return id ? { rows: [{ entity_id: id }], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          if (t.startsWith("insert into public.import_external_keys")) {
            const key = `${String(values[0])}/${String(values[1])}`;
            const bound = ledger.get(key) ?? String(values[2]);
            ledger.set(key, bound);
            return { rows: [{ entity_id: bound }], rowCount: 1 };
          }
          if (t === "select paid_amount, status from public.invoices where id = $1" && values[0] === "inv-existing-1") {
            return { rows: [{ paid_amount: "450.00", status: "partial" }], rowCount: 1 };
          }
          if (t.startsWith("update public.invoices set")) {
            invoiceUpdates.push({ sql: text, values });
            return { rows: [], rowCount: 1 };
          }
          if (t.startsWith("insert into public.bank_transactions")) {
            bankInserts.push({ sql: text, values });
            return { rows: [{ id: `bt-${++seq}` }], rowCount: 1 };
          }
          if (t.startsWith("select 1 from public.bank_accounts where cash_account_id")) {
            return { rows: [], rowCount: 0 };
          }
          if (t.startsWith("select 1 from public.")) {
            return { rows: [{ "?column?": 1 }], rowCount: 1 };
          }
          if (t.startsWith("select")) {
            return { rows: [], rowCount: 0 };
          }
          if (t.startsWith("insert") && /returning\s+id\b/.test(t)) {
            return { rows: [{ id: `id-${++seq}` }], rowCount: 1 };
          }
          return { rows: [], rowCount: 1 };
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await mapWorkbook(fakeClient as any, parsed, {
        filename: "faz41-reimport.xlsx",
        actorId: "00000000-0000-0000-0000-000000000001",
      });

      // Fatura UPDATE parametrelerinde paid_amount=450 ve status='partial' korundu (0 ve 'open'/'draft' ezmedi!)
      expect(invoiceUpdates).toHaveLength(1);
      expect(invoiceUpdates[0]!.values).toContain(450);
      expect(invoiceUpdates[0]!.values).toContain("partial");

      // Aynı gün iki özdeş EFT ÜCRETİ satırı iki ayrı dedupe_hash ile eklendi
      const eftInserts = bankInserts.filter((q) => q.values.includes("EFT ÜCRETİ"));
      expect(eftInserts).toHaveLength(2);
      const hashes = eftInserts.map((q) =>
        q.values.find((v) => typeof v === "string" && v.startsWith("date:2026-05-10|amt:15")),
      );
      expect(hashes[0]).toBe("date:2026-05-10|amt:15|dir:outflow|desc:eft ücreti");
      expect(hashes[1]).toBe("date:2026-05-10|amt:15|dir:outflow|desc:eft ücreti|ord:2");
    });
  });
});
