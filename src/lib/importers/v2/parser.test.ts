// Standart Import V2 — parser sözleşme testleri.
//
// Fixture kodla üretilir (`fixture.ts`), beklenen değerler `FIXTURE_ORACLE` içinde SABİT
// yazılıdır. Oracle üretimden türetilmez — yoksa test yalnız kendi hesabını doğrular.
import { describe, expect, it, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "./fixture";
import {
  parseWorkbook, detectSchema, UNKNOWN_COLUMNS_KEY, PARENT_CHILD_REFS, CURRENCYLESS_DOMAIN_FAMILIES, type WorkbookParseResult,
} from "./parser";
import { DATA_SHEETS, META_SHEET, sheetByName } from "./contract";

let result: WorkbookParseResult;

beforeAll(async () => {
  const wb = await buildFixtureWorkbook();
  result = parseWorkbook(wb);
});

describe("Şema tespiti (§3)", () => {
  it("fixture V2 olarak tanınır", () => {
    expect(result.schemaDetected).toBe(true);
    expect(result.schemaName).toBe(FIXTURE_ORACLE.schema.name);
    expect(result.schemaVersion).toBe(FIXTURE_ORACLE.schema.version);
  });

  it("META sayfası olmayan workbook V2 SAYILMAZ", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("01_ODEMELER").addRow(["Açıklama"]);
    const r = parseWorkbook(wb);
    expect(r.schemaDetected).toBe(false);
    expect(r.rejectionReason).toContain(META_SHEET);
    expect(r.sheets).toHaveLength(0);
  });

  it("doğru sayfa adı YETMEZ — metadata şart", async () => {
    // Legacy bir dosyaya V2 adında sayfa eklenmiş senaryosu.
    const wb = new ExcelJS.Workbook();
    for (const s of DATA_SHEETS) wb.addWorksheet(s.name);
    expect(detectSchema(wb).detected).toBe(false);
  });

  it("yanlış şema sürümü reddedilir", async () => {
    const wb = await buildFixtureWorkbook();
    const meta = wb.getWorksheet(META_SHEET)!;
    meta.getRow(2).getCell(2).value = 99;
    const d = detectSchema(wb);
    expect(d.detected).toBe(false);
    expect(d.reason).toContain("sürüm");
  });
});

describe("Sayfa bazında satır sınıflandırması", () => {
  for (const [sheetName, expected] of Object.entries(FIXTURE_ORACLE.sheets)) {
    it(`${sheetName} — oracle ile birebir`, () => {
      const s = result.sheets.find((x) => x.sheet === sheetName);
      expect(s, `${sheetName} bulunamadı`).toBeDefined();
      expect({
        rowsRead: s!.rowsRead, ready: s!.ready,
        needsReview: s!.needsReview, rejected: s!.rejected,
      }).toEqual(expected);
    });
  }

  it("toplamlar oracle ile birebir", () => {
    expect({
      rowsRead: result.totals.rowsRead, ready: result.totals.ready,
      needsReview: result.totals.needsReview, rejected: result.totals.rejected,
    }).toEqual(FIXTURE_ORACLE.totals);
  });

  // Kanonik fixture'da reddedilen EUR kredinin (KREDI-EUR-01) alt kaydı YOK; engellenen
  // satır sayısı sıfırdır ve oracle'ın dört sayısı toplamı verir.
  it("kanonik fixture'da üst kaydı yüzünden engellenen satır yok", () => {
    expect(result.totals.blockedByParent).toBe(0);
    for (const s of result.sheets) expect(s.blockedByParent, s.sheet).toBe(0);
    expect(result.totals.ready + result.totals.needsReview + result.totals.rejected + result.totals.blockedByParent)
      .toBe(result.totals.rowsRead);
  });
});

describe("SOURCE → PARSED altın zinciri (§42)", () => {
  for (const g of FIXTURE_ORACLE.goldenValues) {
    it(`${g.sheet} satır ${g.row} · ${g.key} → ${JSON.stringify(g.expected)}`, () => {
      const s = result.sheets.find((x) => x.sheet === g.sheet)!;
      const row = s.rows.find((r) => r.rowIndex === g.row);
      expect(row, `${g.sheet}!${g.row} satırı yok`).toBeDefined();
      expect(row!.values[g.key]).toEqual(g.expected);
    });
  }

  it("BOŞ ile 0 parser çıktısında da ayrı kalır", () => {
    const s = result.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    const bilinmeyen = s.rows.find((r) => r.values.external_id === "ODM-ELEKTRIK")!;
    const gercekSifir = s.rows.find((r) => r.values.external_id === "ODM-BEDELSIZ")!;
    expect(bilinmeyen.values.tutar).toBeNull();
    expect(gercekSifir.values.tutar).toBe(0);
    expect(bilinmeyen.values.tutar).not.toBe(gercekSifir.values.tutar);
    // İkisi de KABUL edilir — bilinmeyen tutar reddedilme sebebi değildir.
    expect(bilinmeyen.status).toBe("ready");
    expect(gercekSifir.status).toBe("ready");
  });
});

describe("Doğrulama ve inceleme kayıtları (§29)", () => {
  const typesFound = (): Set<string> => new Set(result.issues.map((i) => i.type));

  for (const t of FIXTURE_ORACLE.expectedIssueTypes) {
    it(`'${t}' incelemesi üretilir`, () => {
      expect(typesFound().has(t)).toBe(true);
    });
  }

  it("bilinmeyen başlık sessizce yok sayılmaz", () => {
    const s = result.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    expect(s.unknownHeaders).toContain("Muhasebe Fişi No");
    const i = result.issues.find((x) => x.type === "unknown_header");
    expect(i?.message).toContain("tahmin edilmez");
  });

  it("aylık tekrar + vade günü yok → REDDEDİLİR", () => {
    const s = result.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    const row = s.rows.find((r) => r.values.external_id === "ODM-GUNSUZ")!;
    expect(row.status).toBe("rejected");
    expect(row.issues.some((i) => i.type === "missing_required_field")).toBe(true);
  });

  it("olmayan krediye referans → REDDEDİLİR", () => {
    const s = result.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const row = s.rows.find((r) => r.values.loan_external_id === "KREDI-YOK-99")!;
    expect(row.status).toBe("rejected");
    expect(row.issues.some((i) => i.type === "missing_reference")).toBe(true);
  });

  it("belirsiz tarih tahmin edilmez → REDDEDİLİR", () => {
    const s = result.sheets.find((x) => x.sheet === "07_BANKA_HAREKETLERI")!;
    const row = s.rows.find((r) => r.values.external_id === "HRK-005")!;
    expect(row.status).toBe("rejected");
    expect(row.issues.some((i) => i.type === "invalid_date")).toBe(true);
  });

  it("geçersiz enum reddedilir ve izin verilenleri söyler", () => {
    const s = result.sheets.find((x) => x.sheet === "12_BUTCE")!;
    const row = s.rows.find((r) => r.values.external_id === "BTC-004")!;
    expect(row.status).toBe("rejected");
    const i = row.issues.find((x) => x.type === "invalid_enum")!;
    expect(i.message).toContain("base_case");
  });
});

describe("Mükerrer politikası (§28) — tespit ≠ silme", () => {
  it("ayırt edici kimliği olmayan aynı çekler ŞÜPHE üretir", () => {
    const s = result.sheets.find((x) => x.sheet === "02_CEKLER")!;
    const dups = s.rows.filter((r) => r.issues.some((i) => i.type === "duplicate_check"));
    expect(dups).toHaveLength(2);
  });

  it("hiçbir satır silinmez veya birleştirilmez — ikisi de korunur", () => {
    const s = result.sheets.find((x) => x.sheet === "02_CEKLER")!;
    const cagdas = s.rows.filter((r) => String(r.values.kime ?? "").toLocaleLowerCase("tr-TR") === "çağdaş");
    expect(cagdas).toHaveLength(2);
    expect(cagdas.every((r) => r.status === "needs_review")).toBe(true);
  });

  it("seri numarası olan aynı tutarlı çekler ŞÜPHE ÜRETMEZ", () => {
    const s = result.sheets.find((x) => x.sheet === "02_CEKLER")!;
    const withSerial = s.rows.filter((r) => typeof r.values.seri_no === "string" && r.values.seri_no);
    expect(withSerial.every((r) => !r.issues.some((i) => i.type === "duplicate_check"))).toBe(true);
  });

  it("aynı dosyada tekrar eden external_id yakalanır", async () => {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("11_PROJELER")!;
    ws.addRow(["PRJ-001", "Kopya proje", null, null, null, "planned", null, null, "TRY", null]);
    const r = parseWorkbook(wb);
    expect(r.issues.some((i) => i.type === "duplicate_external_id")).toBe(true);
  });
});

describe("İşaret sözleşmesi", () => {
  it("negatif çek outflow olarak korunur, mutlak değere çevrilmez", () => {
    const s = result.sheets.find((x) => x.sheet === "02_CEKLER")!;
    const neg = s.rows.filter((r) => typeof r.values.signed_tutar === "number" && (r.values.signed_tutar as number) < 0);
    expect(neg.length).toBeGreaterThan(0);
    for (const r of neg) expect(r.values.signed_tutar as number).toBeLessThan(0);
  });

  it("negatif çek REDDEDİLMEZ — düşük şiddetli nottur", () => {
    const s = result.sheets.find((x) => x.sheet === "02_CEKLER")!;
    const first = s.rows.find((r) => r.values.external_id === "CEK-001")!;
    expect(first.status).toBe("ready");
  });
});

describe("Kapasite: ölçülmemiş ≠ yok", () => {
  it("hepsi boşsa incelemeye düşer", () => {
    const s = result.sheets.find((x) => x.sheet === "14_KAPASITE")!;
    const row = s.rows.find((r) => r.values.external_id === "KAP-003")!;
    expect(row.status).toBe("needs_review");
    expect(row.issues.some((i) => i.type === "missing_operation_time")).toBe(true);
  });

  it("0 yazılmış operasyon süresi geçerlidir ve incelemeye düşmez", () => {
    const s = result.sheets.find((x) => x.sheet === "14_KAPASITE")!;
    const row = s.rows.find((r) => r.values.external_id === "KAP-002")!;
    expect(row.values.freze_dk).toBe(0);
    expect(row.status).toBe("ready");
  });
});

describe("Provenance (§26)", () => {
  it("her satır Excel satır numarasını birebir korur", () => {
    for (const s of result.sheets) {
      for (const r of s.rows) {
        expect(r.rowIndex).toBeGreaterThan(1);   // 1 = başlık
        expect(Number.isInteger(r.rowIndex)).toBe(true);
      }
    }
  });

  it("ham hücre değerleri inceleme için saklanır", () => {
    const s = result.sheets.find((x) => x.sheet === "03_KREDILER")!;
    expect(s.rows[0].raw).toHaveProperty("anapara");
  });

  // `import_rows.row_json` NOT NULL ve HER okunan satır için yazılır. Ham veriyi yalnız
  // sorunlu satırlarda tutmak bir ara denendi ve mapper'ı bloke etti; bu test o gerilemeyi
  // bir daha sessizce geçirmemek için var.
  it("SORUNSUZ satırların ham verisi de saklanır — hiçbir satır boş `raw` ile dönmez", () => {
    const sorunsuz = result.sheets
      .flatMap((s) => s.rows.map((r) => ({ sheet: s.sheet, r })))
      .filter((x) => x.r.issues.length === 0);
    expect(sorunsuz.length).toBeGreaterThan(0);
    const bos = sorunsuz.filter((x) => Object.keys(x.r.raw).length === 0);
    expect(bos.map((x) => `${x.sheet}!${x.r.rowIndex}`)).toEqual([]);
  });

  it("her okunan satırın ham verisi en az bir hücre taşır", () => {
    for (const s of result.sheets) {
      for (const r of s.rows) {
        expect(Object.keys(r.raw).length, `${s.sheet}!${r.rowIndex} ham veri boş`).toBeGreaterThan(0);
      }
    }
  });
});

describe("Sözleşme dışı kolon: hücre değeri KAYBOLMAZ, `values`'a da GEÇMEZ", () => {
  // Fixture'ın 01_ODEMELER sayfasında bilerek eklenmiş bir başlık var: "Muhasebe Fişi No".
  // Fixture satırları o hücreyi boş bırakıyor; burada dolu bir satır eklenir ve hücrenin
  // ham veride durduğu, ama sözleşmeye sızmadığı ölçülür.
  const EXTRA = "Muhasebe Fişi No";
  const FIS = "FIS-2026-0001";

  async function parseWithExtraCell(): Promise<WorkbookParseResult> {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("01_ODEMELER")!;
    const spec = sheetByName("01_ODEMELER")!;
    const satir: Record<string, unknown> = {
      external_id: "ODM-FISLI", aciklama: "Muhasebe fişli ödeme", vade_gunu: 15,
      tutar: 1200, para_birimi: "TRY", tekrar_tipi: "monthly", durum: "active",
    };
    // Sözleşme kolonları sırayla, ardından sözleşme dışı hücre (başlık zaten son sütunda).
    ws.addRow([...spec.columns.map((c) => (c.key in satir ? satir[c.key] : null)), FIS]);
    return parseWorkbook(wb);
  }

  it("tanınmayan kolonun hücresi `raw.__unknown__` altında başlık metniyle saklanır", async () => {
    const r = await parseWithExtraCell();
    const s = r.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    const row = s.rows.find((x) => x.values.external_id === "ODM-FISLI")!;
    expect(row, "eklenen satır okunmadı").toBeDefined();
    expect(row.raw[UNKNOWN_COLUMNS_KEY]).toEqual({ [EXTRA]: FIS });
  });

  it("aynı hücre `values`'a GEÇMEZ — sözleşmenin parçası değildir", async () => {
    const r = await parseWithExtraCell();
    const s = r.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    const row = s.rows.find((x) => x.values.external_id === "ODM-FISLI")!;
    expect(row.values).not.toHaveProperty(EXTRA);
    expect(row.values).not.toHaveProperty(UNKNOWN_COLUMNS_KEY);
    expect(Object.values(row.values)).not.toContain(FIS);
    // Sözleşme kolonlarının hamı KENDİ anahtarında kalır; ad alanı onlara karışmaz.
    expect(row.raw.tutar).toBe(1200);
    expect(Object.keys(row.raw).filter((k) => k.startsWith("__"))).toEqual([UNKNOWN_COLUMNS_KEY]);
  });

  it("`unknown_header` incelemesi yine açılır ve satırın durumunu ETKİLEMEZ", async () => {
    const r = await parseWithExtraCell();
    const s = r.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    expect(s.unknownHeaders).toContain(EXTRA);
    expect(s.issues.some((i) => i.type === "unknown_header" && i.column === EXTRA)).toBe(true);
    const row = s.rows.find((x) => x.values.external_id === "ODM-FISLI")!;
    expect(row.status).toBe("ready");
    expect(row.issues.some((i) => i.type === "unknown_header")).toBe(false);
  });

  it("tanınmayan kolonun hücresi BOŞSA ad alanı hiç açılmaz — gürültü yok", () => {
    // Kanonik fixture: başlık var, hücreler boş.
    const s = result.sheets.find((x) => x.sheet === "01_ODEMELER")!;
    expect(s.unknownHeaders).toContain(EXTRA);
    for (const row of s.rows) expect(row.raw).not.toHaveProperty(UNKNOWN_COLUMNS_KEY);
  });

  it("aynı başlık iki kez geçerse iki hücre de korunur, biri diğerini ezmez", async () => {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("11_PROJELER")!;
    const spec = sheetByName("11_PROJELER")!;
    const n = spec.columns.length;
    ws.getRow(1).getCell(n + 1).value = "Etiket";
    ws.getRow(1).getCell(n + 2).value = "Etiket";
    const satir = new Array<unknown>(n).fill(null);
    satir[spec.columns.findIndex((c) => c.key === "external_id")] = "PRJ-ETIKET";
    satir[spec.columns.findIndex((c) => c.key === "proje_adi")] = "Etiketli proje";
    ws.addRow([...satir, "A", "B"]);
    const r = parseWorkbook(wb);
    const row = r.sheets.find((x) => x.sheet === "11_PROJELER")!.rows
      .find((x) => x.values.external_id === "PRJ-ETIKET")!;
    const unknown = row.raw[UNKNOWN_COLUMNS_KEY] as Record<string, unknown>;
    expect(Object.values(unknown).sort()).toEqual(["A", "B"]);
    expect(Object.keys(unknown)).toHaveLength(2);
  });
});

describe("Üst kayıt kabulü: reddedilen kredinin taksitleri ENGELLENİR (blocked_by_parent)", () => {
  // Kanonik fixture'da KREDI-EUR-01 reddediliyor (EUR — finans toplama kısıtı). Buraya o
  // krediye bağlı üç TEMİZ taksit eklenir. Eski davranışta üçü de "ready" sayılır, eşleyici
  // krediyi defterde bulursa (önceki import) eski kayda bağlayıp yazardı.
  const REJECTED_LOAN = "KREDI-EUR-01";

  async function parseWithOrphanedInstallments(): Promise<WorkbookParseResult> {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("04_KREDI_TAKSITLERI")!;
    const spec = sheetByName("04_KREDI_TAKSITLERI")!;
    const taksitler: Array<Record<string, unknown>> = [1, 2, 3].map((n) => ({
      loan_external_id: REJECTED_LOAN, taksit_no: n, vade_tarihi: `2026-0${n}-15`,
      toplam_tutar: 230, durum: "planned",
    }));
    for (const t of taksitler) ws.addRow(spec.columns.map((c) => (c.key in t ? t[c.key] : null)));
    return parseWorkbook(wb);
  }

  it("üst kayıt reddedilmişse üç taksit de blocked_by_parent olur, sayaçlar tutar", async () => {
    const r = await parseWithOrphanedInstallments();
    const s = r.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const engellenen = s.rows.filter((x) => x.values.loan_external_id === REJECTED_LOAN);
    expect(engellenen).toHaveLength(3);
    expect(engellenen.every((x) => x.status === "blocked_by_parent")).toBe(true);

    // Oracle 04: 3 okunan, 2 hazır, 1 reddedilen — üstüne 3 engellenen.
    const o = FIXTURE_ORACLE.sheets["04_KREDI_TAKSITLERI"];
    expect({ rowsRead: s.rowsRead, ready: s.ready, needsReview: s.needsReview, rejected: s.rejected, blockedByParent: s.blockedByParent })
      .toEqual({ rowsRead: o.rowsRead + 3, ready: o.ready, needsReview: o.needsReview, rejected: o.rejected, blockedByParent: 3 });
    expect(r.totals.blockedByParent).toBe(3);
    expect(r.totals.rowsRead).toBe(FIXTURE_ORACLE.totals.rowsRead + 3);
    expect(r.totals.ready).toBe(FIXTURE_ORACLE.totals.ready);          // hazır sayısı ŞİŞMEZ
    expect(r.totals.rejected).toBe(FIXTURE_ORACLE.totals.rejected);    // reddedilen de değil
  });

  it("sebep satıra yazılır: üst kaydın sayfası, satırı ve durumu", async () => {
    const r = await parseWithOrphanedInstallments();
    const s = r.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const row = s.rows.find((x) => x.values.loan_external_id === REJECTED_LOAN && x.values.taksit_no === 2)!;
    const i = row.issues.find((x) => x.type === "blocked_by_parent")!;
    expect(i).toBeDefined();
    expect(i.severity).toBe("high");
    expect(i.message).toContain(REJECTED_LOAN);
    expect(i.message).toContain("03_KREDILER");
    expect(i.message).toContain("reddedildi");
    expect(i.message).toContain("geçmiş bir import");
    // Satırın KENDİ kusuru yok: tek sorunu üst kaydı.
    expect(row.issues).toHaveLength(1);
  });

  it("kabul edilmiş krediye bağlı taksitler etkilenmez", async () => {
    const r = await parseWithOrphanedInstallments();
    const s = r.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const saglam = s.rows.filter((x) => x.values.loan_external_id === "KREDI-VAKIF-01");
    expect(saglam).toHaveLength(2);
    expect(saglam.every((x) => x.status === "ready")).toBe(true);
  });

  it("olmayan kredi ile reddedilmiş kredi AYRI durumlardır", async () => {
    const r = await parseWithOrphanedInstallments();
    const s = r.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const olmayan = s.rows.find((x) => x.values.loan_external_id === "KREDI-YOK-99")!;
    expect(olmayan.status).toBe("rejected");
    expect(olmayan.issues.some((i) => i.type === "missing_reference")).toBe(true);
    expect(olmayan.issues.some((i) => i.type === "blocked_by_parent")).toBe(false);
  });

  it("alt kaydın KENDİ kusuru varsa 'rejected' kalır, üst kayıt engeli yine kayda geçer", async () => {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("04_KREDI_TAKSITLERI")!;
    const spec = sheetByName("04_KREDI_TAKSITLERI")!;
    // 'paid' ama ödeme tarihi yok → kendi kusuru (missing_required_field, high).
    const t: Record<string, unknown> = {
      loan_external_id: REJECTED_LOAN, taksit_no: 9, vade_tarihi: "2026-09-15", toplam_tutar: 230, durum: "paid",
    };
    ws.addRow(spec.columns.map((c) => (c.key in t ? t[c.key] : null)));
    const r = parseWorkbook(wb);
    const s = r.sheets.find((x) => x.sheet === "04_KREDI_TAKSITLERI")!;
    const row = s.rows.find((x) => x.values.taksit_no === 9)!;
    expect(row.status).toBe("rejected");
    expect(row.issues.map((i) => i.type).sort()).toEqual(["blocked_by_parent", "missing_required_field"]);
    expect(s.blockedByParent).toBe(0);
  });

  // İncelemeye düşmüş üst kayıt da bu turda YAZILMAZ; alt kayıt aynı sebeple bekler.
  // Aksi hâlde yazıcı "defterde yok" diye TÜM import'u düşürürdü (ilk import) ya da eski
  // kayda bağlardı (ikinci import).
  it("üst kayıt incelemeye düşmüşse de alt kayıt engellenir", async () => {
    const wb = await buildFixtureWorkbook();
    // 02_CEKLER değil, 06_BANKA_HESAPLARI → 07: hesap satırını incelemeye düşürmenin en kısa
    // yolu, tanınan ama belirsiz bir sayı ("35.000" → ambiguous, medium).
    const hesaplar = wb.getWorksheet("06_BANKA_HESAPLARI")!;
    const hspec = sheetByName("06_BANKA_HESAPLARI")!;
    const h: Record<string, unknown> = {
      external_id: "BANKA-BELIRSIZ", banka: "Ziraat", hesap_adi: "Belirsiz bakiye",
      para_birimi: "TRY", hesap_tipi: "bank_account", guncel_bakiye: "35.000", aktif: "EVET",
    };
    hesaplar.addRow(hspec.columns.map((c) => (c.key in h ? h[c.key] : null)));
    const hareketler = wb.getWorksheet("07_BANKA_HAREKETLERI")!;
    const tspec = sheetByName("07_BANKA_HAREKETLERI")!;
    const t: Record<string, unknown> = {
      external_id: "HRK-BELIRSIZ", account_external_id: "BANKA-BELIRSIZ", islem_tarihi: "2026-05-20",
      aciklama: "Test", yon: "outflow", tutar: 10, para_birimi: "TRY",
    };
    hareketler.addRow(tspec.columns.map((c) => (c.key in t ? t[c.key] : null)));

    const r = parseWorkbook(wb);
    const hesap = r.sheets.find((x) => x.sheet === "06_BANKA_HESAPLARI")!.rows
      .find((x) => x.values.external_id === "BANKA-BELIRSIZ")!;
    expect(hesap.status).toBe("needs_review");
    const hareket = r.sheets.find((x) => x.sheet === "07_BANKA_HAREKETLERI")!.rows
      .find((x) => x.values.external_id === "HRK-BELIRSIZ")!;
    expect(hareket.status).toBe("blocked_by_parent");
    expect(hareket.issues.find((i) => i.type === "blocked_by_parent")!.message).toContain("incelemeye düştü");
  });

  it("kural dört üst/alt çiftinin hepsini kapsar: 04→03, 07→06, 08→11, 09→11", () => {
    expect(PARENT_CHILD_REFS.map((r) => `${r.from}→${r.to}`).sort()).toEqual([
      "04_KREDI_TAKSITLERI→03_KREDILER",
      "07_BANKA_HAREKETLERI→06_BANKA_HESAPLARI",
      "08_FATURALAR→11_PROJELER",
      "09_SIPARISLER→11_PROJELER",
    ]);
  });
});

describe("Bilinmeyen sayfa", () => {
  it("sözleşmede olmayan sayfa aktarılmaz ve kaydedilir", async () => {
    const wb = await buildFixtureWorkbook();
    wb.addWorksheet("Karalama").addRow(["bir şeyler"]);
    const r = parseWorkbook(wb);
    expect(r.unknownSheets).toContain("Karalama");
    expect(r.issues.some((i) => i.type === "unknown_sheet")).toBe(true);
  });
});

describe("controlled-use v1 — para birimi kolonu olmayan tablolara ortuk TRY YAZILMAZ", () => {
  it("05_NAKIT_AKISI USD satiri reddedilir (kaynakta korunur, inceleme acilir); TRY satir hazir; 16_MAKINE_ROI EUR reddedilir", async () => {
    const wb = await buildFixtureWorkbook();
    const cf = wb.getWorksheet("05_NAKIT_AKISI")!;
    const header = cf.getRow(1).values as Array<string | undefined>;
    const col = (h: string) => header.findIndex((v) => typeof v === "string" && v.trim().toLowerCase() === h.toLowerCase());
    const curCol = col("Para Birimi");
    expect(curCol).toBeGreaterThan(0);
    // 2. satir (fixture'da hazir bir satir) USD yapilir
    const before = parseWorkbook(wb).sheets.find((s) => s.sheet === "05_NAKIT_AKISI")!;
    cf.getRow(2).getCell(curCol).value = "USD";
    const mk = wb.getWorksheet("16_MAKINE_ROI")!;
    const mkHeader = mk.getRow(1).values as Array<string | undefined>;
    const mkCur = mkHeader.findIndex((v) => typeof v === "string" && v.trim().toLowerCase() === "para birimi");
    mk.getRow(2).getCell(mkCur).value = "EUR";

    const r = parseWorkbook(wb);
    const after = r.sheets.find((s) => s.sheet === "05_NAKIT_AKISI")!;
    const row2 = after.rows.find((x) => x.rowIndex === 2)!;
    expect(row2.status).toBe("rejected");
    expect(row2.issues.some((i) => i.type === "unsupported_currency_for_finance_aggregation" && /örtük TRY/.test(i.message))).toBe(true);
    expect(row2.raw.para_birimi).toBe("USD"); // ham deger korunur
    expect(after.ready).toBe(before.ready - 1);
    const mkRow = r.sheets.find((s) => s.sheet === "16_MAKINE_ROI")!.rows.find((x) => x.rowIndex === 2)!;
    expect(mkRow.status).toBe("rejected");
    expect(CURRENCYLESS_DOMAIN_FAMILIES.has("cashflow")).toBe(true);
    expect(CURRENCYLESS_DOMAIN_FAMILIES.has("payments")).toBe(false);
  });
});
