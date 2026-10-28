// Plan §3.7 — şablon üretimi byte-deterministik olmalı: iki üretim aynı SHA256.
//
// Kanıt geçmişi: 02-template-generation.json → "byteDeterministic": false; sebep ZIP girdi
// başlıklarındaki üretim-anı DOS zaman damgası. Bu testler (1) kanonikleştiricinin doğru
// alanları değiştirdiğini, (2) arşivin ExcelJS + V2 parser ile hâlâ okunabildiğini,
// (3) iki bağımsız üretimin AYNI baytları verdiğini kilitler. (3) sahte geçmesin diye
// üretimler arasında en az 2 saniye beklenir — DOS saat çözünürlüğü 2 sn'dir; bekleme
// olmadan iki üretim aynı saniyeye düşüp "deterministik" görünebilirdi.
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildTemplateBuffer, buildTemplateWorkbook } from "./template";
import { DATA_SHEETS } from "./contract";
import { parseWorkbook } from "./parser";
import {
  canonicalizeZipTimestamps, listZipTimestamps, toDosDateTime, TEMPLATE_ZIP_TIMESTAMP,
} from "./zip-canonical";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("zip-canonical — DOS zaman damgası", () => {
  it("2026-01-01T00:00:00Z → date 0x5C21, time 0", () => {
    // ((2026-1980)<<9) | (1<<5) | 1 = 23585
    expect(TEMPLATE_ZIP_TIMESTAMP).toEqual({ date: 0x5c21, time: 0 });
    expect(toDosDateTime(new Date(Date.UTC(2026, 0, 1)))).toEqual(TEMPLATE_ZIP_TIMESTAMP);
  });

  it("saat/dakika/saniye doğru bitlere gider; saniye 2'ye bölünür", () => {
    const t = toDosDateTime(new Date(Date.UTC(2030, 11, 31, 23, 59, 59)));
    expect(t.date).toBe(((2030 - 1980) << 9) | (12 << 5) | 31);
    expect(t.time).toBe((23 << 11) | (59 << 5) | 29);
  });

  it("1980 öncesi ve 2107 sonrası reddedilir (format sınırı)", () => {
    expect(() => toDosDateTime(new Date(Date.UTC(1979, 11, 31)))).toThrow(/DOS tarih aralığı/);
    expect(() => toDosDateTime(new Date(Date.UTC(2108, 0, 1)))).toThrow(/DOS tarih aralığı/);
  });

  it("geçersiz arşiv (EOCD yok) hata verir, sessiz geçmez", () => {
    expect(() => canonicalizeZipTimestamps(Buffer.from("bu bir zip değil"))).toThrow(/EOCD/);
  });
});

describe("zip-canonical — ExcelJS çıktısı üzerinde", () => {
  it("ham ExcelJS çıktısında damgalar üretim anıdır; kanonik çıktıda TÜM girdiler sabittir", async () => {
    const wb = await buildTemplateWorkbook();
    const raw = Buffer.from(await wb.xlsx.writeBuffer());
    const rawStamps = listZipTimestamps(raw);
    expect(rawStamps.length).toBeGreaterThan(0);
    // Ham çıktı bugünün tarihini taşır — sabit damgadan farklı olmalı (aksi hâlde test anlamsız).
    const today = toDosDateTime(new Date());
    expect(rawStamps.every((s) => s.date === today.date)).toBe(true);
    expect(today.date).not.toBe(TEMPLATE_ZIP_TIMESTAMP.date);

    const { buffer, entries } = canonicalizeZipTimestamps(raw);
    expect(entries).toBe(rawStamps.length);
    expect(buffer.length).toBe(raw.length); // yalnız üzerine yazma; uzunluk değişmez
    const stamps = listZipTimestamps(buffer);
    expect(stamps.map((s) => s.name)).toEqual(rawStamps.map((s) => s.name));
    for (const s of stamps) {
      expect(s.date).toBe(TEMPLATE_ZIP_TIMESTAMP.date);
      expect(s.time).toBe(TEMPLATE_ZIP_TIMESTAMP.time);
    }
    // Girdi buffer'ı değiştirilmedi.
    expect(listZipTimestamps(raw)).toEqual(rawStamps);
  });

  it("kanonik arşiv ExcelJS ile geri okunur ve V2 parser şemayı tanır", async () => {
    const { buffer, workbook } = await buildTemplateBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(back.worksheets.length).toBe(workbook.worksheets.length);
    expect(back.worksheets.length).toBe(DATA_SHEETS.length + 3);

    const parsed = parseWorkbook(back);
    expect(parsed.schemaDetected).toBe(true);
    expect(parsed.rejectionReason).toBeUndefined();
    // Boş şablon: satır yok, ama tüm veri sayfaları tanınmış olmalı.
    expect(parsed.sheets.length).toBe(DATA_SHEETS.length);
    expect(parsed.unknownSheets).toEqual([]);
    expect(parsed.totals.rowsRead).toBe(0);
  });

  it("iki bağımsız üretim (≥2 sn arayla) AYNI SHA256 verir — plan §3.7", async () => {
    const a = await buildTemplateBuffer();
    await sleep(2100);
    const b = await buildTemplateBuffer();
    expect(sha256(a.buffer)).toBe(sha256(b.buffer));
    expect(a.buffer.equals(b.buffer)).toBe(true);
    expect(a.zipEntries).toBe(b.zipEntries);
  }, 30_000);
});
