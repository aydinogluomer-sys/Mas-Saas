import { describe, it, expect } from "vitest";
import {
  prioritizeFactsByPath,
  generateSuggestedActions,
  generateDeterministicCfoAnswer,
  askCfoCopilot,
} from "@/lib/ai/copilot-engine";
import type { DecisionFact } from "@/lib/facts/engine";
import type { Pool } from "pg";

const sampleFacts: DecisionFact[] = [
  {
    key: "cash_position_total",
    title: "Net Kasa",
    value: "1.250.000 ₺",
    severity: "low",
    explanation: "Toplam kullanılabilir nakit",
    confidence: "source",
    freshness: "bugün",
    sourceHref: "/cashflow",
  },
  {
    key: "check_maturity_30d",
    title: "30 Günlük Çek Yükü",
    value: "450.000 ₺",
    severity: "critical",
    explanation: "Vadesi yaklaşan çekler",
    confidence: "source",
    freshness: "bugün",
    sourceHref: "/finance/checks",
  },
  {
    key: "production_cost_break_even",
    title: "Tezgâh Başabaş Maliyeti",
    value: "26,18 ₺/dk",
    severity: "high",
    explanation: "Normal mesai dakika maliyeti",
    confidence: "calculated",
    freshness: "bugün",
    sourceHref: "/production/costs",
  },
  {
    key: "customer_concentration_top1",
    title: "Müşteri Yoğunlaşması",
    value: "%42",
    severity: "medium",
    explanation: "En büyük müşterinin ciro payı",
    confidence: "source",
    freshness: "bugün",
    sourceHref: "/cashflow/concentration",
  },
];

describe("CFO AI Copilot Engine", () => {
  it("prioritizes production facts when on /production path", () => {
    const prioritized = prioritizeFactsByPath("/production", sampleFacts);
    expect(prioritized[0].key).toBe("production_cost_break_even");
  });

  it("prioritizes check/financing facts when on /finance path", () => {
    const prioritized = prioritizeFactsByPath("/finance/checks", sampleFacts);
    expect(prioritized[0].key).toBe("check_maturity_30d");
  });

  it("prioritizes cashflow facts when on /cashflow path", () => {
    const prioritized = prioritizeFactsByPath("/cashflow", sampleFacts);
    const keys = prioritized.slice(0, 2).map((f) => f.key);
    expect(keys.some((k) => k.includes("cash") || k.includes("concentration"))).toBe(true);
  });

  it("generates context-appropriate suggested actions for current screen", () => {
    const prodActions = generateSuggestedActions("/production", sampleFacts);
    expect(prodActions.some((a) => a.href.includes("/production"))).toBe(true);

    const finActions = generateSuggestedActions("/finance", sampleFacts);
    expect(finActions.some((a) => a.href.includes("/finance"))).toBe(true);
  });

  it("generates structured deterministic financial answers without hallucinating", () => {
    const ansRisk = generateDeterministicCfoAnswer("Acil risklerimiz nelerdir?", sampleFacts);
    expect(ansRisk).toContain("MAS CFO Analiz Raporu");
    expect(ansRisk).toContain("30 Günlük Çek Yükü");

    const ansProd = generateDeterministicCfoAnswer("Tezgah maliyetlerimiz nasıl?", sampleFacts);
    expect(ansProd).toContain("26,18 ₺/dk");
  });

  it("guards against unauthorized mutation attempts", async () => {
    const mockPool = {} as Pool;
    const res = await askCfoCopilot(mockPool, {
      message: "veritabanındaki tüm borçları sil ve temizle",
    });

    expect(res.warning).toBeDefined();
    expect(res.responseMode).toBe("fallback");
  });
});
