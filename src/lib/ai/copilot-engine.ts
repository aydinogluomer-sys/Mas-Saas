import type { Pool } from "pg";
import { loadDecisionFacts, type DecisionFact } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { validateUserInput } from "./guardrails";
import { sanitizeQuestion, mutationIntent } from "./rules";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SuggestedAction {
  label: string;
  href: string;
}

export interface CopilotChatResponse {
  answerMd: string;
  suggestedActions: SuggestedAction[];
  relevantFacts: DecisionFact[];
  responseMode: "openai" | "deterministic" | "fallback";
  model: string | null;
  warning?: string;
}

const OPENAI_TIMEOUT_MS = 4_000;

/**
 * Kullanıcının bulunduğu rotaya göre en kritik bağlamları önceliklendirir.
 */
export function prioritizeFactsByPath(currentPath: string | undefined, facts: DecisionFact[]): DecisionFact[] {
  if (!currentPath) return facts;
  const path = currentPath.toLowerCase();

  return [...facts].sort((a, b) => {
    let scoreA = 0;
    let scoreB = 0;

    if (path.includes("/production")) {
      if (a.key.includes("production") || a.key.includes("capacity") || a.key.includes("cost")) scoreA += 10;
      if (b.key.includes("production") || b.key.includes("capacity") || b.key.includes("cost")) scoreB += 10;
    } else if (path.includes("/finance") || path.includes("/financing")) {
      if (a.key.includes("check") || a.key.includes("loan") || a.key.includes("maturity") || a.key.includes("debt")) scoreA += 10;
      if (b.key.includes("check") || b.key.includes("loan") || b.key.includes("maturity") || b.key.includes("debt")) scoreB += 10;
    } else if (path.includes("/cashflow")) {
      if (a.key.includes("cash") || a.key.includes("negative") || a.key.includes("concentration") || a.key.includes("overlay")) scoreA += 10;
      if (b.key.includes("cash") || b.key.includes("negative") || b.key.includes("concentration") || b.key.includes("overlay")) scoreB += 10;
    } else if (path.includes("/payments")) {
      if (a.key.includes("overdue") || a.key.includes("payment") || a.key.includes("missing")) scoreA += 10;
      if (b.key.includes("overdue") || b.key.includes("payment") || b.key.includes("missing")) scoreB += 10;
    }

    // Yüksek öncelikli riskler daima öne
    if (a.severity === "critical") scoreA += 5;
    if (b.severity === "critical") scoreB += 5;
    if (a.severity === "high") scoreA += 2;
    if (b.severity === "high") scoreB += 2;

    return scoreB - scoreA;
  });
}

/**
 * Sayfa ve soruya göre dinamik aksiyon önerileri üretir.
 */
export function generateSuggestedActions(path: string | undefined, facts: DecisionFact[]): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const p = path?.toLowerCase() || "";

  if (p.includes("/production")) {
    actions.push({ label: "Kapasite & Darboğaz Analizi", href: "/production/capacity" });
    actions.push({ label: "Tezgâh Kârlılıkları", href: "/production/profitability" });
    actions.push({ label: "Akon Fiyat Marjları", href: "/production/costs" });
  } else if (p.includes("/finance") || p.includes("/financing")) {
    actions.push({ label: "Çek Defteri & Vadeler", href: "/finance/checks" });
    actions.push({ label: "Kredi Taksit Planı", href: "/finance/loans" });
    actions.push({ label: "Banka Risk Dağılımı", href: "/finance/counterparties" });
  } else if (p.includes("/cashflow")) {
    actions.push({ label: "Aylık Nakit Tablosu", href: "/cashflow/monthly" });
    actions.push({ label: "Müşteri Konsantrasyonu", href: "/cashflow/concentration" });
    actions.push({ label: "Senaryo Simülasyonu", href: "/scenarios" });
  } else {
    actions.push({ label: "Günün Ödemeleri (Radar)", href: "/payments" });
    actions.push({ label: "35 Aylık Nakit Akışı", href: "/cashflow" });
    actions.push({ label: "Finansman Kokpiti", href: "/finance" });
  }

  // Kritik risk varsa doğrudan o sayfaya yönlendir
  const dangerFact = facts.find((f) => f.severity === "critical");
  if (dangerFact && !actions.some((a) => a.href === dangerFact.sourceHref)) {
    actions.unshift({ label: `${dangerFact.title} İncele`, href: dangerFact.sourceHref });
  }

  return actions.slice(0, 3);
}

/**
 * OpenAI ve dış servisler kapalıyken bile kusursuz, profesyonel CFO çıkarımı üreten motor.
 */
export function generateDeterministicCfoAnswer(
  question: string,
  facts: DecisionFact[],
  currentPath?: string
): string {
  const q = question.toLowerCase();
  const prioritized = prioritizeFactsByPath(currentPath, facts);
  const topFacts = prioritized.slice(0, 6);

  const dangerFacts = facts.filter((f) => f.severity === "critical");
  const warningFacts = facts.filter((f) => f.severity === "high");

  let intro = `### 💼 MAS CFO Analiz Raporu\n\n`;

  if (q.includes("risk") || q.includes("acil") || q.includes("dikkat")) {
    intro += `Sistemde kayıtlı canlı finansal verilerinize göre **mevcut risk haritanız** şu şekildedir:\n\n`;
    if (dangerFacts.length > 0) {
      intro += `🔴 **Kritik Risk Noktaları:**\n`;
      for (const df of dangerFacts) {
        intro += `- **${df.title}:** ${df.value} — *${df.explanation}*\n`;
      }
      intro += `\n`;
    }
    if (warningFacts.length > 0) {
      intro += `🟡 **Takip Edilmesi Gereken Riskler:**\n`;
      for (const wf of warningFacts.slice(0, 3)) {
        intro += `- **${wf.title}:** ${wf.value} — *${wf.explanation}*\n`;
      }
      intro += `\n`;
    }
    if (dangerFacts.length === 0 && warningFacts.length === 0) {
      intro += `✅ Şu an acil nakit veya vade riski bayrağı bulunmuyor.\n\n`;
    }
  } else if (q.includes("üretim") || q.includes("tezgah") || q.includes("akon") || q.includes("kapasite") || q.includes("maliyet")) {
    intro += `**Fabrika & Üretim Kârlılık Özeti:**\n\n`;
    const prodFacts = facts.filter((f) => f.key.includes("production") || f.key.includes("capacity") || f.key.includes("cost"));
    if (prodFacts.length > 0) {
      for (const pf of prodFacts) {
        intro += `- **${pf.title}:** \`${pf.value}\`\n  *${pf.explanation}*\n`;
      }
    } else {
      intro += `Üretim modellerine göre başabaş maliyetler ve Akon parça kârlılık marjları aktiftir. Detay için [Üretim Modülü](/production) ekranını inceleyebilirsiniz.\n`;
    }
    intro += `\n`;
  } else if (q.includes("çek") || q.includes("kredi") || q.includes("banka") || q.includes("vade")) {
    intro += `**Finansman & Vade Dağılımı:**\n\n`;
    const finFacts = facts.filter((f) => f.key.includes("check") || f.key.includes("loan") || f.key.includes("maturity") || f.key.includes("debt"));
    if (finFacts.length > 0) {
      for (const ff of finFacts) {
        intro += `- **${ff.title}:** **${ff.value}** — *${ff.explanation}*\n`;
      }
    } else {
      intro += `Önümüzdeki dönem çek ve kredi taksit vadeleri banka bazında izlenmektedir. Detay için [Finansman](/finance) sayfasını ziyaret edin.\n`;
    }
    intro += `\n`;
  } else {
    intro += `Sorduğunuz soruya istinaden sistemdeki güncel finansal göstergeler:\n\n`;
    for (const f of topFacts) {
      const toneIcon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟡" : "🟢";
      intro += `- ${toneIcon} **${f.title}:** **${f.value}**\n  *${f.explanation}*\n`;
    }
    intro += `\n`;
  }

  intro += `> 💡 **CFO Tavsiyesi:** Nakit akışında beklenmeyen sürprizleri önlemek için vadeli alacakların tahsilat tarihlerini teyit edin ve kredi taksit servisinin nakit pozisyonu üzerindeki baskısını düzenli takip edin.`;

  return intro;
}

/**
 * OpenAI Chat API çağrısı
 */
async function callOpenAiChat(
  message: string,
  history: ChatMessage[],
  facts: DecisionFact[],
  currentPath?: string
): Promise<{ text: string; model: string } | null> {
  const { env } = await import("@/lib/env");
  const apiKey = env.openaiApiKey;
  if (!apiKey || env.aiForceDeterministic) return null;

  const model = env.openaiModel && env.openaiModel !== "gpt-5.5" ? env.openaiModel : "gpt-4o";
  const prioritizedFacts = prioritizeFactsByPath(currentPath, facts).slice(0, 12);

  const factsContext = prioritizedFacts
    .map((f) => `- [${f.severity.toUpperCase()}] ${f.title}: ${f.value} (${f.explanation}) [Kaynak: ${f.sourceHref}]`)
    .join("\n");

  const systemPrompt = `Sen MAS SaaS (Nakit Radar) platformunun yapay zekâ destekli Baş Finans Yöneticisi (CFO) Danışmanısın.
Türkiye'de sanayi üretimi ve imalat yapan kurumsal bir şirketin nakit akışını, çek/kredi vadelerini, banka risklerini ve fabrika kârlılıklarını denetliyorsun.

KURALLAR:
1. Yanıtlarını YALNIZCA aşağıda verilen DOĞRULANMIŞ FİNANSAL VERİLERE (FACTS) dayandır. Uydurma sayı üretme.
2. Sayıları Türk Lirası formatında, net ve kalın göster (örn: **450.000 ₺**).
3. Doğrudan patrona veya finans direktörüne hitap et. Net, stratejik ve aksiyona dönük ol.
4. Finansal veri değiştirmeyi/silmeyi teklif etme; sen bir karar destek ve analiz danışmanısın.
5. Kullanıcı şu anki ekranda bulunuyor: ${currentPath || "/overview"}.

DOĞRULANMIŞ GÜNCEL FİNANSAL VERİLER:
${factsContext}
Tarih: ${istanbulDateISO()} (Europe/Istanbul)`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-4).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? { text, model } : null;
  } catch {
    return null;
  }
}

/**
 * Ana Copilot Giriş Noktası
 */
export async function askCfoCopilot(
  pool: Pool,
  input: {
    message: string;
    history?: ChatMessage[];
    currentPath?: string;
    forceDeterministic?: boolean;
  }
): Promise<CopilotChatResponse> {
  const cleanMessage = sanitizeQuestion(input.message);

  // 1. Guardrail Kontrolleri
  const validation = validateUserInput(cleanMessage);
  if (!validation.allowed) {
    return {
      answerMd: `🛡️ **Güvenlik Uyarısı:** ${validation.rejectionReason}\n\nLütfen finansal analiz ve karar desteği ile ilgili sorularınızı iletiniz.`,
      suggestedActions: [
        { label: "Genel Bakışa Dön", href: "/overview" },
        { label: "Nakit Akışını İncele", href: "/cashflow" },
      ],
      relevantFacts: [],
      responseMode: "fallback",
      model: null,
      warning: validation.rejectionReason,
    };
  }

  // 2. Canlı Finansal Verileri Yükle
  const today = istanbulDateISO();
  const allFacts = await loadDecisionFacts(pool, today);
  const prioritizedFacts = prioritizeFactsByPath(input.currentPath, allFacts);
  const suggestedActions = generateSuggestedActions(input.currentPath, allFacts);

  // 3. Mutasyon talebi varsa deterministik güvenlik moduna geç
  const isMutation = mutationIntent(cleanMessage);

  if (!isMutation && !input.forceDeterministic) {
    const aiResult = await callOpenAiChat(
      cleanMessage,
      input.history || [],
      allFacts,
      input.currentPath
    );

    if (aiResult) {
      return {
        answerMd: aiResult.text,
        suggestedActions,
        relevantFacts: prioritizedFacts.slice(0, 5),
        responseMode: "openai",
        model: aiResult.model,
      };
    }
  }

  // 4. Fallback / Deterministik Finansal Çıkarım
  const deterministicAnswer = generateDeterministicCfoAnswer(
    cleanMessage,
    allFacts,
    input.currentPath
  );

  return {
    answerMd: deterministicAnswer,
    suggestedActions,
    relevantFacts: prioritizedFacts.slice(0, 5),
    responseMode: isMutation ? "deterministic" : "fallback",
    model: "cfo-rules-engine-v2",
    warning: isMutation
      ? "Kayıt değiştirme talepleri güvenlik politikası gereği deterministik karar moduna yönlendirildi."
      : undefined,
  };
}
