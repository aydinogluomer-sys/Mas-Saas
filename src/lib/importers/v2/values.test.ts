// Standart Import V2 — değer normalizasyonu sözleşme testleri.
//
// Bu dosyanın en önemli bloğu "BOŞ ≠ SIFIR". Diğer her şey ondan sonra gelir: bir tarih
// biçimini yanlış okumak tek bir satırı bozar, boş hücreyi 0 saymak bütün finansal tabloyu
// olduğundan iyi gösterir.
import { describe, expect, it } from "vitest";
import {
  isBlank, parseText, parseNumber, parseNumberString, parseInteger,
  parseDate, parseMonth, parseEnum, parseBoolean, parsePercent, excelSerialToISO, unwrapCell,
} from "./values";

describe("BOŞ ≠ SIFIR — sürüm sözleşmesi", () => {
  const blanks = [null, undefined, "", "   ", "-", "—", "–"];

  it.each(blanks)("boş girdi (%p) 'blank' döner ve değeri null'dır — 0 DEĞİL", (raw) => {
    const r = parseNumber(raw);
    expect(r.status).toBe("blank");
    expect(r.value).toBeNull();
    expect(r.value).not.toBe(0);
  });

  it("açıkça yazılmış 0 'ok' döner ve değeri 0'dır", () => {
    const r = parseNumber(0);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(0);
  });

  it("metin '0' da gerçek sıfırdır", () => {
    expect(parseNumber("0")).toMatchObject({ status: "ok", value: 0 });
    expect(parseNumber("0,00")).toMatchObject({ status: "ok", value: 0 });
  });

  it("boş ile sıfır AYNI sonucu vermez", () => {
    const bos = parseNumber("");
    const sifir = parseNumber("0");
    expect(bos.value).toBeNull();
    expect(sifir.value).toBe(0);
    expect(bos.value).not.toBe(sifir.value);
  });

  it("`Number(v) || 0` tuzağı: boş, 0'a çevrilmiyor", () => {
    // Bu satır kasıtlı: yanlış uygulamanın ne üreteceğini gösterir.
    const yanlis = Number("") || 0;
    expect(yanlis).toBe(0);
    // Doğru uygulama aynı girdide null üretir.
    expect(parseNumber("").value).toBeNull();
  });

  it("isBlank yalnız gerçekten boş sayılan işaretleri kabul eder", () => {
    for (const b of blanks) expect(isBlank(b)).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(isBlank("0")).toBe(false);
    expect(isBlank(false)).toBe(false);
  });
});

describe("Türkçe ve İngilizce sayı biçimleri", () => {
  it("ayırıcısız tam sayı", () => {
    expect(parseNumberString("35000")).toMatchObject({ status: "ok", value: 35000 });
  });

  it("iki ayırıcı varsa sonuncusu ondalıktır", () => {
    expect(parseNumberString("35.000,50")).toMatchObject({ status: "ok", value: 35000.5 });
    expect(parseNumberString("35,000.50")).toMatchObject({ status: "ok", value: 35000.5 });
    expect(parseNumberString("1.234.567,89")).toMatchObject({ status: "ok", value: 1234567.89 });
  });

  it("tek ayırıcı birden fazla kez geçerse binliktir", () => {
    expect(parseNumberString("1.234.567")).toMatchObject({ status: "ok", value: 1234567 });
    expect(parseNumberString("1,234,567")).toMatchObject({ status: "ok", value: 1234567 });
  });

  it("ardından 3 hane yoksa ondalıktır", () => {
    expect(parseNumberString("35000,5")).toMatchObject({ status: "ok", value: 35000.5 });
    expect(parseNumberString("35000.50")).toMatchObject({ status: "ok", value: 35000.5 });
    expect(parseNumberString("71744,1162")).toMatchObject({ status: "ok", value: 71744.1162 });
  });

  it("tam 3 hane BELİRSİZDİR: değer üretilir ama işaretlenir", () => {
    const r = parseNumberString("35.000");
    expect(r.status).toBe("ambiguous");
    expect(r.value).toBe(35000);
    expect(r.reason).toContain("binlik");
  });

  it("gerçek sayısal hücrede belirsizlik yoktur", () => {
    // Excel numeric cell → doğrudan kullanılır, metin ayrıştırma yoluna girmez.
    expect(parseNumber(35000)).toMatchObject({ status: "ok", value: 35000 });
    expect(parseNumber(35.0)).toMatchObject({ status: "ok", value: 35 });
  });

  it("para birimi işaretleri temizlenir, işaret korunur", () => {
    expect(parseNumberString("35.000,50 TL")).toMatchObject({ value: 35000.5 });
    expect(parseNumberString("₺1.500.000")).toMatchObject({ value: 1500000 });
    expect(parseNumberString("-45000")).toMatchObject({ status: "ok", value: -45000 });
    expect(parseNumberString("$1,234.56")).toMatchObject({ value: 1234.56 });
  });

  it("parantezli muhasebe negatifi", () => {
    expect(parseNumberString("(1.234,50)")).toMatchObject({ value: -1234.5 });
  });

  it("bozuk binlik gruplaması reddedilir", () => {
    expect(parseNumberString("1.23.456").status).toBe("invalid");
  });

  it("sayı olmayan metin reddedilir — 0'a düşmez", () => {
    const r = parseNumber("yok");
    expect(r.status).toBe("invalid");
    expect(r.value).toBeNull();
  });

  it("tam sayı alanında ondalık reddedilir", () => {
    expect(parseInteger("3,5").status).toBe("invalid");
    expect(parseInteger("3")).toMatchObject({ status: "ok", value: 3 });
  });
});

describe("Tarih", () => {
  it("Excel seri numarası doğru çözülür", () => {
    // TEMİZ.xlsx denetiminde ölçülen gerçek değerler.
    expect(excelSerialToISO(46234)).toBe("2026-07-31");
    expect(excelSerialToISO(46265)).toBe("2026-08-31");
    expect(excelSerialToISO(46284)).toBe("2026-09-19");
    expect(excelSerialToISO(46326)).toBe("2026-10-31");
    expect(excelSerialToISO(45583)).toBe("2024-10-18");
  });

  it("ISO biçimi tek okumadır", () => {
    expect(parseDate("2026-05-31")).toMatchObject({ status: "ok", value: "2026-05-31" });
  });

  it("gerçek Date nesnesi gün kaydırmadan okunur", () => {
    expect(parseDate(new Date(Date.UTC(2026, 6, 31)))).toMatchObject({ value: "2026-07-31" });
  });

  it("gün > 12 ise ayırıcılı biçim tek okumadır", () => {
    expect(parseDate("31.07.2026")).toMatchObject({ status: "ok", value: "2026-07-31" });
    expect(parseDate("31/07/2026")).toMatchObject({ status: "ok", value: "2026-07-31" });
  });

  it("ay > 12 ise sıra aa/gg olarak çözülür", () => {
    expect(parseDate("07/31/2026")).toMatchObject({ status: "ok", value: "2026-07-31" });
  });

  it("hem gün hem ay ≤ 12 ise BELİRSİZDİR — işaretlenir", () => {
    const r = parseDate("05.03.2026");
    expect(r.status).toBe("ambiguous");
    expect(r.value).toBe("2026-03-05");
    // Gerekçe HER İKİ okumayı da söylemeli — kullanıcı hangi varsayımın yapıldığını görsün.
    expect(r.reason).toContain("gg/aa");
    expect(r.reason).toContain("aa/gg");
  });

  it("iki haneli yıl TAHMİN EDİLMEZ", () => {
    const r = parseDate("01/02/03");
    expect(r.status).toBe("invalid");
    expect(r.value).toBeNull();
    expect(r.reason).toContain("belirsiz");
  });

  it("var olmayan tarih reddedilir", () => {
    expect(parseDate("2026-02-30").status).toBe("invalid");
    expect(parseDate("31.02.2026").status).toBe("invalid");
  });

  it("boş tarih null'dır", () => {
    expect(parseDate("")).toMatchObject({ status: "blank", value: null });
  });
});

describe("Dönem", () => {
  it("YYYY-AA kabul edilir", () => {
    expect(parseMonth("2026-05")).toMatchObject({ status: "ok", value: "2026-05" });
    expect(parseMonth("2026-5")).toMatchObject({ status: "ok", value: "2026-05" });
  });
  it("tam tarihten dönem türetilir", () => {
    expect(parseMonth("2026-05-31")).toMatchObject({ status: "ok", value: "2026-05" });
  });
  it("geçersiz ay reddedilir", () => {
    expect(parseMonth("2026-13").status).toBe("invalid");
  });
});

describe("Enum ve mantıksal", () => {
  const allowed = ["monthly", "weekly", "irregular"] as const;

  it("büyük/küçük harf duyarsız eşleşir", () => {
    expect(parseEnum("MONTHLY", allowed)).toMatchObject({ status: "ok", value: "monthly" });
  });
  it("listede olmayan değer reddedilir ve izin verilenleri söyler", () => {
    const r = parseEnum("aylik", allowed);
    expect(r.status).toBe("invalid");
    expect(r.reason).toContain("monthly");
  });
  it("boş enum null'dır", () => {
    expect(parseEnum("", allowed)).toMatchObject({ status: "blank", value: null });
  });
  it("EVET/HAYIR ve TRUE/FALSE", () => {
    expect(parseBoolean("EVET")).toMatchObject({ status: "ok", value: true });
    expect(parseBoolean("hayır")).toMatchObject({ status: "ok", value: false });
    expect(parseBoolean(true)).toMatchObject({ status: "ok", value: true });
    expect(parseBoolean(0)).toMatchObject({ status: "ok", value: false });
  });
  it("anlaşılmayan mantıksal değer reddedilir", () => {
    expect(parseBoolean("belki").status).toBe("invalid");
  });
});

describe("Yüzde", () => {
  it("ham sayı olarak saklanır", () => {
    expect(parsePercent("3,14")).toMatchObject({ status: "ok", value: 3.14 });
    expect(parsePercent(3.14)).toMatchObject({ status: "ok", value: 3.14 });
    expect(parsePercent("%3,14")).toMatchObject({ status: "ok", value: 3.14 });
  });
  it("boş yüzde null'dır — 0 değil", () => {
    expect(parsePercent("")).toMatchObject({ status: "blank", value: null });
  });
});

describe("Formül hücreleri (§32)", () => {
  it("son hesaplanmış değer kullanılır", () => {
    expect(parseNumber({ formula: "B9*B5", result: 3443717.58 })).toMatchObject({
      status: "ok", value: 3443717.58,
    });
  });
  it("hesaplanmamış formül bilinmiyor sayılır — 0 değil", () => {
    const r = parseNumber({ formula: "SUM(A1:A9)" });
    expect(r.status).toBe("blank");
    expect(r.value).toBeNull();
  });
  it("zengin metin düz metne indirgenir", () => {
    expect(unwrapCell({ richText: [{ text: "MAS " }, { text: "ELEKTRİK" }] })).toBe("MAS ELEKTRİK");
    expect(parseText({ richText: [{ text: "AKR" }] })).toMatchObject({ status: "ok", value: "AKR" });
  });
});

describe("Metin", () => {
  it("kırpılır, boş metin null olur", () => {
    expect(parseText("  MAS ELEKTRİK  ")).toMatchObject({ status: "ok", value: "MAS ELEKTRİK" });
    expect(parseText("   ")).toMatchObject({ status: "blank", value: null });
  });
});
