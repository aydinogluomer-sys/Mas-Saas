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
