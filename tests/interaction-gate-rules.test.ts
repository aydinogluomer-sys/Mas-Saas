/**
 * Etkileşim kapısının KARAR kuralları — altı senaryo, milisaniyeler içinde.
 *
 * ═══ NEDEN BURADA TEST EDİLİYOR, UÇTAN UCA DEĞİL ═══
 *
 * Kapının iki modu ve altı ayrı kırmızı koşulu var. Bunları yalnız gerçek koşuyla doğrulamak,
 * her senaryo için 2122 kontrollük bir tarama + Playwright turu isterdi — bu makinede saatler,
 * ve "baseline yükseltme girişimi" gibi bir senaryoyu üretmek için repoyu bilerek bozmak
 * gerekirdi. Karar saf bir fonksiyonda olduğu için altısı da deterministik ve anlıktır.
 *
 * Bu test kapının BEYNİNİ doğrular; kapının GÖZÜ (tarama + kanıt) ayrıca uçtan uca koşuyor.
 * İkisi farklı soruları cevaplar ve biri diğerinin yerine geçmez.
 */

import { describe, expect, it } from "vitest";
import { evaluateGate, type GateBaseline, type GateCounts } from "../scripts/qa/interaction-gate-rules";

/** Sağlıklı bir koşu: borç baseline'da, bozuk kontrol yok. */
const HEALTHY: GateCounts = { discovered: 2122, pass: 1561, fail: 0, untested: 561, unmapped: 0 };
const BASELINE: GateBaseline = { untested: 561, pass: 1561 };

describe("interaction gate — ratchet modu", () => {
  it("borç baseline'daysa ve bozuk kontrol yoksa YEŞİL", () => {
    const verdict = evaluateGate(HEALTHY, BASELINE, "ratchet");
    expect(verdict.red, verdict.reasons.join(" | ")).toBe(false);
  });

  it("FAIL varsa KIRMIZI — ratchet borç için vardır, BOZUK için değil", () => {
    const verdict = evaluateGate({ ...HEALTHY, fail: 1 }, BASELINE, "ratchet");
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("FAIL=1");
  });

  it("manifestoda karşılığı olmayan kontrol varsa KIRMIZI", () => {
    // Bunu hoş görmek kapsamın sessizce kaybolmasına izin vermektir — kapının varlık sebebinin tersi.
    const verdict = evaluateGate({ ...HEALTHY, unmapped: 3 }, BASELINE, "ratchet");
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("Manifestoda karşılığı olmayan kontrol=3");
  });

  it("UNTESTED baseline'ın ÜSTÜNDEyse KIRMIZI — test borcu büyütülemez", () => {
    const verdict = evaluateGate({ ...HEALTHY, untested: 562 }, BASELINE, "ratchet");
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("UNTESTED=562 > baseline=561");
  });

  it("UNTESTED baseline'ın ALTINDAysa YEŞİL ve baseline'ı çekmeyi SÖYLER", () => {
    const verdict = evaluateGate({ ...HEALTHY, untested: 500, pass: 1622 }, BASELINE, "ratchet");
    expect(verdict.red, verdict.reasons.join(" | ")).toBe(false);
    // Kazanım kilitlenmezse bir sonraki PR borcu sessizce geri büyütebilir.
    expect(verdict.notes.join(" ")).toContain("Baseline'ı bu değere ÇEKİN");
  });

  it("PASS baseline'ın altına düşerse KIRMIZI — kapsam gerilemesi UNTESTED sabitken de olabilir", () => {
    // Bir kontrol VE onun testi birlikte silinirse UNTESTED değişmez ama kanıt azalır.
    const verdict = evaluateGate({ ...HEALTHY, pass: 1500, discovered: 2061 }, BASELINE, "ratchet");
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("PASS=1500 < baseline=1561");
  });
});

describe("interaction gate — strict modu", () => {
  it("UNTESTED > 0 ise KIRMIZI — kalan borç release'i durdurur", () => {
    const verdict = evaluateGate(HEALTHY, BASELINE, "strict");
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("UNTESTED=561");
    // Mesaj kaçış yollarını ADIYLA kapatmalı; aksi hâlde ilk refleks allowlist olur.
    expect(verdict.reasons.join(" ")).toContain("allowlist");
  });

  it("UNTESTED = 0 ve bozuk yoksa YEŞİL", () => {
    const verdict = evaluateGate({ ...HEALTHY, untested: 0, pass: 2122 }, { untested: 0, pass: 2122 }, "strict");
    expect(verdict.red, verdict.reasons.join(" | ")).toBe(false);
  });

  it("strict modda baseline UNTESTED'ı AFFETMEZ — ratchet'in tavanı burada geçersiz", () => {
    // Aynı sayılar ratchet'te yeşil, strict'te kırmızı. İki modun ayrı sözler vermesi budur.
    expect(evaluateGate(HEALTHY, BASELINE, "ratchet").red).toBe(false);
    expect(evaluateGate(HEALTHY, BASELINE, "strict").red).toBe(true);
  });
});

describe("interaction gate — baseline yükseltme denetimi", () => {
  it("gerekçesiz YÜKSELTME KIRMIZI — yoksa kapı kendi kendini etkisizleştirir", () => {
    const raised: GateBaseline = { untested: 600, pass: 1561 };
    const verdict = evaluateGate({ ...HEALTHY, untested: 600 }, raised, "ratchet", BASELINE);
    expect(verdict.red).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("Baseline YÜKSELTİLMİŞ (561 → 600)");
  });

  it("gerekçeli yükseltme geçer ama kayda GEÇER", () => {
    const raised: GateBaseline = { untested: 600, pass: 1561, raisedBecause: "39 yeni kontrol eklendi (yeni modül)" };
    const verdict = evaluateGate({ ...HEALTHY, untested: 600 }, raised, "ratchet", BASELINE);
    expect(verdict.red, verdict.reasons.join(" | ")).toBe(false);
    expect(verdict.notes.join(" ")).toContain("39 yeni kontrol eklendi");
  });

  it("boşluktan ibaret gerekçe, gerekçe SAYILMAZ", () => {
    const raised: GateBaseline = { untested: 600, pass: 1561, raisedBecause: "   " };
    const verdict = evaluateGate({ ...HEALTHY, untested: 600 }, raised, "ratchet", BASELINE);
    expect(verdict.red).toBe(true);
  });

  it("DÜŞÜRME her zaman serbest — kazanımı kilitlemek engellenmemeli", () => {
    const lowered: GateBaseline = { untested: 400, pass: 1722 };
    const verdict = evaluateGate({ ...HEALTHY, untested: 400, pass: 1722 }, lowered, "ratchet", BASELINE);
    expect(verdict.red, verdict.reasons.join(" | ")).toBe(false);
  });
});
