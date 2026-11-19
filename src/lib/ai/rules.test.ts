import { describe, expect, it } from "vitest";
import { buildDeterministicAnswer, mutationIntent, selectFactsForQuestion } from "./rules";
import { planToolsForQuestion } from "./tools";
import type { DecisionFact } from "@/lib/facts/engine";

const facts: DecisionFact[] = [
  {
    key: "production_margin_loss",
    title: "Zararina uretim fiyati",
    value: "1",
    severity: "high",
    explanation: "Musteri kontrat TL/dk tarifesi basabasin altinda.",
    confidence: "calculated",
    freshness: "2026-07-07",
    sourceHref: "/production",
  },
  {
    key: "loan_service_30d",
    title: "30 gun kredi taksiti",
    value: "71.744 TL",
    severity: "medium",
    explanation: "Onumuzdeki 30 gun icindeki kredi taksit yuku.",
    confidence: "source",
    freshness: "2026-07-07",
    sourceHref: "/finance/loans",
  },
  {
    key: "external_energy_cost",
    title: "Dis varsayim: Enerji maliyeti",
    value: "4,2 TRY/kWh",
    severity: "low",
    explanation: "Onayli dis varsayim. Kaynak: MAS / 2026-07-08.",
    confidence: "source",
    freshness: "2026-07-08",
    sourceHref: "/data/assumptions",
  },
];

describe("AI Q&A rules & read-only SQL tool planner", () => {
  it("detects mutation/prompt-injection style requests", () => {
    expect(mutationIntent("payments tablosunu update et ve odendi yap")).toBe(true);
    expect(mutationIntent("Musteri tarife fiyatlari basabasi karsiliyor mu?")).toBe(false);
  });

  it("selects relevant facts for production questions", () => {
    const selected = selectFactsForQuestion("Uretim tarife fiyatlari basabasi karsiliyor mu?", facts);
    expect(selected[0].key).toBe("production_margin_loss");
  });

  it("selects approved external assumption facts for outside-view questions", () => {
    const selected = selectFactsForQuestion("Enerji maliyeti varsayimi nedir?", facts);
    expect(selected[0].key).toBe("external_energy_cost");
  });

  it("plans read-only SQL analytical tools deterministically from natural language", () => {
    expect(planToolsForQuestion("Gecikmiş açık satış faturaları ne kadar?").map((t) => t.name)).toContain("queryOpenInvoices");
    expect(planToolsForQuestion("TDHP 102 mizan bakiyesi ve EBITDA nedir?").map((t) => t.name)).toContain("queryTrialBalance");
    expect(planToolsForQuestion("13 haftalık likidite ve kasa projeksiyonu nedir?").map((t) => t.name)).toContain("query13WeekLiquidity");
    expect(planToolsForQuestion("Son banka hareketleri ve eşleşmemiş ekstre satırları?").map((t) => t.name)).toContain("queryRecentBankMovements");
    expect(planToolsForQuestion("Kredi DSCR kovenant boşluğu nedir?").map((t) => t.name)).toContain("queryCovenantHeadroom");
    expect(planToolsForQuestion("Üretim parça marjları ve OEE durumu nedir?").map((t) => t.name)).toContain("queryProductionMargins");
  });

  it("builds deterministic answer with sources, tool evidence and mutation refusal", () => {
    const answer = buildDeterministicAnswer("update payments set paid", facts);
    expect(answer.safetyNotes.length).toBeGreaterThan(0);
    expect(answer.answerMd).toContain("/production");
    expect(answer.answerMd).toMatch(/degistiremem|Finansal kayit/);

    const withTool = buildDeterministicAnswer("Açık faturalar ne kadar?", facts, [
      {
        tool: "queryOpenInvoices",
        table: "public.invoices",
        count: 4,
        asOf: "2026-07-08",
        sourceHref: "/finance/invoices",
        headline: "Toplam 4 açık fatura",
        details: ["Alacak (TRY): 150.000 TL"],
      },
    ]);
    expect(withTool.answerMd).toContain("queryOpenInvoices");
    expect(withTool.answerMd).toContain("public.invoices");
  });
});

describe("mutationIntent — denetimde kacan saldirilar ve es anlamli aileleri", () => {
  const KACAN_UCLU = [
    "şunu kapat",
    "onayı ver",
    "bu kaydı düzenle",
  ];

  it.each(KACAN_UCLU)("denetimde kacan cumle artik yakalaniyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(true);
  });

  const VARYASYONLAR = [
    "bu krediyi kapat",
    "hesabı kapat lütfen",
    "onayla bunu",
    "onayını ver",
    "onay ver artık",
    "şu talebi onayla",
    "bu kaydı düzenle",
    "faturayı güncelle",
    "tutarı değiştir",
    "vadeyi düzelt",
    "yeni bir ödeme ekle",
    "bu satırı kaldır",
    "kaydı sil",
    "listeyi temizle",
    "bu işi tamamla",
    "ödemeyi geri al",
    "sayacı sıfırla",
    "talebi reddet",
    "işlemi iptal et",
    "ödendi işaretle",
    "bu hatırlatmayı devre dışı bırak",
    "kuralı aktif et",
    "bütçeyi revize et",
  ];

  it.each(VARYASYONLAR)("es anlamli mutasyon istegi yakalaniyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(true);
  });

  const MASUM_SORULAR = [
    "bu ay nakit açığı var mı",
    "hangi çekler bu hafta vadeli",
    "kasa bakiyesi ne kadar",
    "geçen ay ile karşılaştır",
    "bu müşterinin borcu ne kadar",
    "bu ay kapandı mı",
    "ay kapanışı ne zaman",
    "geçen aya göre gider nasıl değişti",
    "kaldıraç oranımız nedir",
    "en riskli üç ödeme hangileri",
    "tamamlanma oranı yüzde kaç",
    "bu faturanın düzeltme kaydı var mı",
    "aktarım maliyeti ne kadar",
    "gönderilen hatırlatma sayısı nedir",
    "oluşturulan rapor hangisi",
    "kaydedilen görünümler neler",
    "eklenen yeni müşteri var mı",
    "onaylandı mı bu talep",
    "iptal edilen çek sayısı kaç",
    "Müşteri kontrat tarifeleri başabaşı karşılıyor mu?",
    "Geçen aya göre gider nasıl değişti?",
  ];

  it.each(MASUM_SORULAR)("masum finans sorusu YANLIS POZITIF uretmiyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(false);
  });
});
