// Kaynak satırdan gelir okuma — legacy `I.v` ile V2 `satis_fiyati` aynı sözleşmeyi kullanır.
//
// NEDEN VAR. Kârlılık okuyucusu `row_json->'I'->>'v'` ile yalnız legacy biçimi tanıyordu.
// V2 import'u `row_json`'u sözleşme anahtarıyla yazar; o satırlarda `I` yoktur ve her parçanın
// geliri sessizce NULL'a düşüyordu. Bu test iki biçimden AYNI gelirin çıktığını ölçer.
import { describe, expect, it } from "vitest";
import {
  readSourceRevenue, sourceRevenue, V2_REVENUE_KEY, LEGACY_REVENUE_COLUMN,
} from "./source-revenue";

/** Legacy `workbook-importer` biçimi: kolon harfi → {v,t}. I = adet için TOPLAM fiyat. */
const legacyRow = (totalPrice: unknown) => ({
  A: { v: "MT-100", t: "s" }, B: { v: "Flanş M100", t: "s" }, C: { v: 500, t: "n" },
  D: { v: 4.5, t: "n" }, E: { v: 2, t: "n" },
  [LEGACY_REVENUE_COLUMN]: { v: totalPrice, t: "n" },
});

/** V2 parser biçimi: sözleşme anahtarı → ham hücre. satis_fiyati = BİRİM fiyat. */
const v2Row = (unitPrice: unknown) => ({
  external_id: "KAP-001", parca_kodu: "MT-100", parca_adi: "Flanş M100", adet: 500,
  torna_dk: 4.5, freze_dk: 2, diger_operasyon_dk: 0, [V2_REVENUE_KEY]: unitPrice,
  para_birimi: "TRY", calisma_gunu: 22, vardiya_sayisi: 1, notlar: null,
});

describe("İki ham biçim, tek gelir sözleşmesi", () => {
  it("legacy I.v (toplam) ile V2 satis_fiyati × adet AYNI geliri verir", () => {
    const legacy = readSourceRevenue(legacyRow(130000), 500);
    const v2 = readSourceRevenue(v2Row(260), 500);
    expect(legacy).toEqual({ revenue: 130000, source: "legacy" });
    expect(v2).toEqual({ revenue: 130000, source: "v2" });
    expect(v2.revenue).toBe(legacy.revenue);
  });

  it("V2 anahtarı varsa legacy `I` sütunu OKUNMAZ — biçim tahmin edilmez, anahtardan bilinir", () => {
    const karisik = { ...v2Row(260), [LEGACY_REVENUE_COLUMN]: { v: 999999, t: "n" } };
    expect(readSourceRevenue(karisik, 500)).toEqual({ revenue: 130000, source: "v2" });
  });

  it("hiçbir biçim yoksa gelir BİLİNMİYOR (null), 0 değil", () => {
    expect(readSourceRevenue({ parca_kodu: "X" }, 10)).toEqual({ revenue: null, source: "none" });
    expect(readSourceRevenue({ A: { v: "X", t: "s" } }, 10)).toEqual({ revenue: null, source: "none" });
    expect(readSourceRevenue(null, 10)).toEqual({ revenue: null, source: "none" });
    expect(readSourceRevenue([1, 2], 10)).toEqual({ revenue: null, source: "none" });
    expect(readSourceRevenue("{}", 10)).toEqual({ revenue: null, source: "none" });
  });
});

describe("V2: birim fiyat × adet, ondalık aritmetikle", () => {
  it("71744.12 × 3 float kayması olmadan 215232.36 verir", () => {
    expect(sourceRevenue(v2Row(71744.12), 3)).toBe(215232.36);
  });

  it("adet BİLİNMİYORSA gelir de bilinmiyor — birim fiyat toplam yerine konmaz", () => {
    expect(sourceRevenue(v2Row(260), null)).toBeNull();
  });

  it("adet 0 ise gelir 0'dır (üretilmiyor; gerçek sıfır)", () => {
    expect(sourceRevenue(v2Row(260), 0)).toBe(0);
  });

  it("boş / '-' / null fiyat → bilinmiyor", () => {
    expect(sourceRevenue(v2Row(null), 500)).toBeNull();
    expect(sourceRevenue(v2Row(""), 500)).toBeNull();
    expect(sourceRevenue(v2Row("-"), 500)).toBeNull();
  });
});

describe("V2 ham hücre skaler olmayabilir — hata değil, parser'ın çözücüsü", () => {
  it("formül nesnesi ({formula, result}) → son hesaplanmış değer", () => {
    expect(sourceRevenue(v2Row({ formula: "=B2*2", result: 260 }), 500)).toBe(130000);
  });

  it("hesaplanmamış formül (result yok) → bilinmiyor", () => {
    expect(sourceRevenue(v2Row({ formula: "=B2*2" }), 500)).toBeNull();
  });

  it("zengin metin ({richText}) → düz metin → sayı", () => {
    expect(sourceRevenue(v2Row({ richText: [{ text: "2" }, { text: "60" }] }), 500)).toBe(130000);
  });

  it("Türkçe biçimli metin '1.234,50' → 1234.5 × adet", () => {
    expect(sourceRevenue(v2Row("1.234,50"), 2)).toBe(2469);
  });

  it("para birimi ekli metin '260 TL' → 260", () => {
    expect(sourceRevenue(v2Row("260 TL"), 500)).toBe(130000);
  });

  // Wave 0: kârlılık motorunun parser dışındaki tek parseNumber tüketicisi bu dosya ve
  // 'ambiguous' değeri kabul ediyor. İncelenmemiş katmanda formül hatası 'ambiguous' + 0
  // dönüyordu: kırık bir fiyat formülü parça gelirini 0 diye kârlılığa sokardı.
  it("formül hatası taşıyan fiyat → bilinmiyor (null), ASLA 0", () => {
    expect(sourceRevenue(v2Row({ error: "#REF!" }), 500)).toBeNull();
    expect(sourceRevenue(v2Row({ formula: "=B2*2", result: { error: "#DIV/0!" } }), 500)).toBeNull();
    expect(sourceRevenue(v2Row("#N/A"), 500)).toBeNull();
    expect(readSourceRevenue(v2Row({ error: "#REF!" }), 500)).toEqual({ revenue: null, source: "v2" });
  });

  it("sayı olmayan metin ve ISO tarih metni HATA FIRLATMAZ, bilinmiyor döner", () => {
    expect(() => sourceRevenue(v2Row("abc"), 500)).not.toThrow();
    expect(sourceRevenue(v2Row("abc"), 500)).toBeNull();
    // JSON gidiş-dönüşünden sonra Date hücresi ISO metin olur.
    expect(sourceRevenue(v2Row("2026-05-31T00:00:00.000Z"), 500)).toBeNull();
  });
});

describe("Legacy yol: davranış aynen korunur", () => {
  it("sayısal metin de sayı da okunur", () => {
    expect(sourceRevenue(legacyRow("130000"), 500)).toBe(130000);
    expect(sourceRevenue(legacyRow(130000.456), 500)).toBe(130000.46);   // TL ölçeğinde yuvarlama
  });

  it("adet legacy geliri ETKİLEMEZ — I zaten toplamdır", () => {
    expect(sourceRevenue(legacyRow(130000), null)).toBe(130000);
    expect(sourceRevenue(legacyRow(130000), 1)).toBe(130000);
  });

  it("boş `v` → bilinmiyor (eski `nullif(...,'')` ile aynı)", () => {
    expect(sourceRevenue(legacyRow(""), 500)).toBeNull();
    expect(sourceRevenue(legacyRow(null), 500)).toBeNull();
  });

  it("`I` hücresi `v` taşımıyorsa → bilinmiyor", () => {
    expect(sourceRevenue({ [LEGACY_REVENUE_COLUMN]: { t: "z" } }, 500)).toBeNull();
  });

  it("sayı olmayan legacy metin eskisi gibi HATA verir (`::numeric` davranışı değişmedi)", () => {
    expect(() => sourceRevenue(legacyRow("abc"), 500)).toThrow(TypeError);
  });
});
