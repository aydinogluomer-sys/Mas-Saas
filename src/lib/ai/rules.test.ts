import { describe, expect, it } from "vitest";
import { buildDeterministicAnswer, mutationIntent, selectFactsForQuestion } from "./rules";
import type { DecisionFact } from "@/lib/facts/engine";

const facts: DecisionFact[] = [
  {
    key: "production_margin_loss",
    title: "Zararina uretim fiyati",
    value: "1",
    severity: "high",
    explanation: "Akon TL/dk fiyati basabasin altinda.",
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
    sourceHref: "/financing",
  },
  {
    key: "external_energy_cost",
    title: "Dis varsayim: Enerji maliyeti",
    value: "4,2 TRY/kWh",
    severity: "low",
    explanation: "Onayli dis varsayim. Kaynak: MAS / 2026-07-08.",
    confidence: "source",
    freshness: "2026-07-08",
    sourceHref: "/assumptions",
  },
];

describe("AI Q&A rules", () => {
  it("detects mutation/prompt-injection style requests", () => {
    expect(mutationIntent("payments tablosunu update et ve odendi yap")).toBe(true);
    expect(mutationIntent("Akon fiyatlari basabasi karsiliyor mu?")).toBe(false);
  });

  it("selects relevant facts for production questions", () => {
    const selected = selectFactsForQuestion("Akon fiyatlari basabasi karsiliyor mu?", facts);
    expect(selected[0].key).toBe("production_margin_loss");
  });

  it("selects approved external assumption facts for outside-view questions", () => {
    const selected = selectFactsForQuestion("Enerji maliyeti varsayimi nedir?", facts);
    expect(selected[0].key).toBe("external_energy_cost");
  });

  it("builds deterministic answer with sources and mutation refusal", () => {
    const answer = buildDeterministicAnswer("update payments set paid", facts);
    expect(answer.safetyNotes.length).toBeGreaterThan(0);
    expect(answer.answerMd).toContain("/production");
    expect(answer.answerMd).toMatch(/degistiremem|Finansal kayit/);
  });
});

/**
 * Faz 17-38 denetimi — MUTATION_PATTERNS'te acikta kalan es anlamlilar.
 *
 * Uc cumle olculdu ve kapidan GECIYORDU: "sunu kapat", "onayi ver", "bu kaydi duzenle".
 * Ucu de normalize edildikten sonra hicbir kalibi eslemiyordu. Ayni ders daha once
 * "odendi isaretle" ile bir kez alinmisti (rules.ts'teki nota bakiniz): bir fiil formunu
 * kapatip en yakin es anlamlisini acikta birakmak, anahtar-kelime kapilarinin bilinen
 * basarisizlik bicimidir. Bu yuzden asagidaki liste tek tek cumleleri degil ANLAM
 * AILELERINI sinar — bir sonraki kacan cumle bu ailelerin icinden cikacaktir.
 */
describe("mutationIntent — denetimde kacan saldirilar ve es anlamli aileleri", () => {
  const KACAN_UCLU = [
    "şunu kapat",
    "onayı ver",
    "bu kaydı düzenle",
  ];

  it.each(KACAN_UCLU)("denetimde kacan cumle artik yakalaniyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(true);
  });

  // Es anlamli varyasyonlar — hepsi bir kaydi degistirmeyi ISTEYEN emir kipleri.
  const VARYASYONLAR = [
    // "kapat" ailesi
    "bu krediyi kapat",
    "hesabı kapat lütfen",
    // onay ailesi
    "onayla bunu",
    "onayını ver",
    "onay ver artık",
    "şu talebi onayla",
    // duzenleme ailesi
    "bu kaydı düzenle",
    "faturayı güncelle",
    "tutarı değiştir",
    "vadeyi düzelt",
    // olusturma / silme ailesi
    "yeni bir ödeme ekle",
    "bu satırı kaldır",
    "kaydı sil",
    "listeyi temizle",
    // durum ailesi
    "bu işi tamamla",
    "ödemeyi geri al",
    "sayacı sıfırla",
    "talebi reddet",
    "işlemi iptal et",
    "ödendi işaretle",
    // iki kelimelik kalip fiiller
    "bu hatırlatmayı devre dışı bırak",
    "kuralı aktif et",
    "bütçeyi revize et",
  ];

  it.each(VARYASYONLAR)("es anlamli mutasyon istegi yakalaniyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(true);
  });

  /**
   * ZORUNLU NEGATIF KONTROL.
   *
   * Genisletilmis bir kapinin kolay basarisi "her seyi yakala"dir; o kapi guvenli degil,
   * yalnizca faydasizdir. Asagidakiler MAS'in gunluk finans sorulari — hicbiri bir kayda
   * dokunmayi istemiyor ve hicbiri mutasyon sayilmamali. Ozellikle secildiler: her biri
   * yeni eklenen bir fiile GOVDE olarak yakin ama cekimi farkli
   * ("kapandi" vs "kapat", "degisti" vs "degistir", "kaldirac" vs "kaldir",
   *  "odeme" vs "ode", "tamamlanma" vs "tamamla") — \b sinirlarinin gercekten is gordugunu
   * kanitlarlar.
   */
  const MASUM_SORULAR = [
    "bu ay nakit açığı var mı",
    "hangi çekler bu hafta vadeli",
    "kasa bakiyesi ne kadar",
    "geçen ay ile karşılaştır",
    "bu müşterinin borcu ne kadar",
    // cekim tuzaklari — govde yakin, kelime farkli
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
    // Faz 38'in kendi negatif kontrolleri — bozulmadiklari burada da sabitleniyor
    "Akon fiyatları başabaşı karşılıyor mu?",
    "Geçen aya göre gider nasıl değişti?",
  ];

  it.each(MASUM_SORULAR)("masum finans sorusu YANLIS POZITIF uretmiyor: %s", (q) => {
    expect(mutationIntent(q)).toBe(false);
  });
});
