import type { DecisionFact } from "@/lib/facts/engine";
import { sortBySeverity } from "@/lib/facts/rules";

export type AiResponseMode = "deterministic" | "openai" | "fallback";

export interface AiAnswerDraft {
  answerMd: string;
  selectedFacts: DecisionFact[];
  safetyNotes: string[];
}

const MUTATION_PATTERNS = [
  /\b(update|delete|insert|drop|truncate|alter)\b/i,
  /\b(odendi yap|sil|guncelle|degistir|kaydi degistir)\b/i,
];

export function sanitizeQuestion(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 800);
}

export function mutationIntent(question: string): boolean {
  const q = norm(question);
  return MUTATION_PATTERNS.some((rx) => rx.test(q));
}

function norm(s: string) {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "i")
    .toLowerCase();
}

export function selectFactsForQuestion(question: string, facts: DecisionFact[], limit = 5): DecisionFact[] {
  const q = norm(question);
  const scored = facts.map((fact) => {
    const hay = norm(`${fact.key} ${fact.title} ${fact.value} ${fact.explanation}`);
    let score = 0;
    if (q.includes("negatif") || q.includes("eksi") || q.includes("kasa")) {
      if (fact.key.includes("negative") || fact.key.includes("cash") || fact.key.includes("debt")) score += 3;
    }
    if (q.includes("cek") || q.includes("kredi") || q.includes("borc")) {
      if (fact.key.includes("check") || fact.key.includes("loan") || fact.key.includes("debt")) score += 3;
    }
    if (q.includes("akon") || q.includes("basabas") || q.includes("uretim")) {
      if (fact.key.includes("production") || fact.key.includes("stale")) score += 3;
    }
    if (q.includes("musteri") || q.includes("gelir")) {
      if (fact.key.includes("customer") || fact.key.includes("concentration")) score += 3;
    }
    if (q.includes("eksik") || q.includes("veri") || q.includes("inceleme")) {
      if (fact.key.includes("missing") || fact.key.includes("review")) score += 3;
    }
    if (hay.includes(q)) score += 2;
    return { fact, score };
  });

  const matches = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.fact);
  const fallback = sortBySeverity(facts).filter((f) => f.severity !== "low");
  const chosen = matches.length > 0 ? matches : fallback.length > 0 ? fallback : facts;
  return chosen.slice(0, limit);
}

export function buildDeterministicAnswer(question: string, facts: DecisionFact[]): AiAnswerDraft {
  const clean = sanitizeQuestion(question);
  const selectedFacts = selectFactsForQuestion(clean, facts);
  const safetyNotes: string[] = [];
  const asksMutation = mutationIntent(clean);
  if (asksMutation) safetyNotes.push("Kullanici istegi finansal kayit mutasyonu iceriyor; cevap yalniz aciklama/oneri verdi.");

  const lead =
    selectedFacts.length === 0
      ? "Bu soruya yanit verecek guvenli fact bulunamadi."
      : asksMutation
        ? "Finansal kayit degistiremem; yalniz mevcut guvenli veriyi aciklayabilirim."
        : "Mevcut guvenli fact katmanina gore kisa cevap:";

  const reasons = selectedFacts
    .map((f) => `- ${f.title}: ${f.value}. ${f.explanation}`)
    .join("\n");
  const sources = [...new Set(selectedFacts.map((f) => f.sourceHref))]
    .map((href) => `- ${href}`)
    .join("\n");

  const action =
    selectedFacts.some((f) => f.severity === "critical" || f.severity === "high")
      ? "Onerilen aksiyon: yuksek/acil sinyal veren kaynak ekranini acip ilgili satirlari dogrula."
      : "Onerilen aksiyon: rutin kontrol yeterli; dusuk guvenli veya eksik alan varsa kaynagi dogrula.";

  return {
    answerMd: [
      lead,
      "",
      "Nedenler:",
      reasons || "- Uygun deterministik sinyal yok.",
      "",
      action,
      "",
      "Kaynaklar:",
      sources || "- /",
    ].join("\n"),
    selectedFacts,
    safetyNotes,
  };
}

export function buildModelPrompt(question: string, facts: DecisionFact[]): string {
  const factLines = facts.map((f) => ({
    key: f.key,
    title: f.title,
    value: f.value,
    severity: f.severity,
    explanation: f.explanation,
    confidence: f.confidence,
    sourceHref: f.sourceHref,
  }));
  return [
    "MAS Nakit Radar icin salt-okunur finans-operasyon yorumcususun.",
    "Kurallar: finansal kayit degistirme; yeni sayi uydurma; sadece verilen facts'i acikla; belirsizi belirt; kisa Turkce cevap ver.",
    "Cevap basliklari: Kisa cevap, Nedenler, Onerilen aksiyon, Kaynaklar.",
    `Soru: ${sanitizeQuestion(question)}`,
    `Facts JSON: ${JSON.stringify(factLines)}`,
  ].join("\n\n");
}
