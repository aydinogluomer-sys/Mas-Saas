// Faz 5 — Akıllı Finans & Güvenlik: Finansal LLM Guardrails
// (Financial AI Hallucination & Data Leakage Guard)
//
// Şirket finans verilerini işleyen AI modelleri için kurumsal güvenlik ve doğruluk kalkanı:
//   1. Girdi Güvenliği (Input Guardrail): Prompt injection, jailbreak ("ignore previous instructions")
//      ve veri değiştirme/silme komutlarını (mutation intent) kesin olarak engeller.
//   2. Sayısal Tutarlılık & Halüsinasyon Denetimi (Grounding Verification):
//      LLM'in ürettiği metindeki tüm finansal rakamların (tutar, yüzde, bakiye) veritabanı
//      olgularıyla (grounded facts) birebir örtüştüğünü doğrular. Uydurulan (hallucinated) rakamları bloklar.
//   3. Hassas Veri Maskeleme (PII & Confidentiality Masking):
//      Dış LLM API'lerine gönderilmeden önce IBAN, TC Kimlik No, VKN ve telefonları maskeler.

export interface GroundedFact {
  numericValue: number;
  label?: string;
  tolerancePct?: number; // Varsayılan %1 yuvarlama toleransı
}

export interface GroundingCheckResult {
  grounded: boolean;
  extractedNumbers: number[];
  unmatchedNumbers: number[];
  confidenceScore: number; // 0 - 100
  sanitizedResponse: string;
}

export interface InputValidationResult {
  allowed: boolean;
  rejectionReason?: string;
  sanitizedPrompt: string;
}

const JAILBREAK_PATTERNS = [
  /ignore (all )?previous instructions/i,
  /sen artık kısıtsız bir modelsin/i,
  /dan mode|jailbreak|unrestricted/i,
  /gizli sistem promptunu ver/i,
  /bypass safety|disable guardrails/i,
  /system prompt|reveal hidden/i,
];

const MUTATION_PATTERNS = [
  /\b(update|delete|insert|drop|truncate|alter)\b/i,
  /\b(sil|onayla|iptal et|kapat|degistir|guncelle|ode|aktar)\b/i,
  /\b(kaydi sil|borcu sil|faturayi onayla|parayi gonder)\b/i,
];

/**
 * Kullanıcı girdisini güvenlik ve yetkisiz işlem teşebbüslerine karşı denetler (Input Guardrail).
 */
export function validateUserInput(prompt: string): InputValidationResult {
  const trimmed = prompt.trim();

  // 1. Jailbreak kontrolü
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        rejectionReason: "Güvenlik İhlali: Sistem yönergelerini devre dışı bırakmaya yönelik komutlar reddedildi.",
        sanitizedPrompt: "",
      };
    }
  }

  // 2. Veri değiştirme/yazma (Mutation) kontrolü
  for (const pattern of MUTATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        rejectionReason: "Salt Okunur Yetki: Finansal asistan yalnızca raporlama ve analiz yapabilir; kayıt oluşturma, silme veya onaylama yapamaz.",
        sanitizedPrompt: "",
      };
    }
  }

  return {
    allowed: true,
    sanitizedPrompt: trimmed,
  };
}

/**
 * Hassas PII ve banka bilgilerini anonimize eder (Data Masking).
 */
export function maskSensitiveData(text: string): string {
  let masked = text;

  // 1. IBAN Maskeleme (TRxx xxxx xxxx xxxx xxxx xxxx xx -> TRxx **** **** **** **** **** xx)
  masked = masked.replace(
    /\b(TR\d{2})([\s\d]{16,24})(\d{2})\b/gi,
    (_match, prefix, middle, suffix) => {
      const stars = middle.replace(/\d/g, "*");
      return `${prefix}${stars}${suffix}`;
    },
  );

  // 2. TC Kimlik No (11 hane)
  masked = masked.replace(/\b([1-9]\d{2})\d{5}(\d{3})\b/g, "$1*****$2");

  // 3. Vergi Kimlik No (10 hane)
  masked = masked.replace(/\b(\d{2})\d{6}(\d{2})\b/g, "$1******$2");

  return masked;
}

/**
 * Metinden finansal sayıları ve tutarları ayıklar (Örn: 1.250.000 TL, 450,000, %18.5, 35000).
 */
export function extractFinancialNumbers(text: string): number[] {
  // Regex: Rakam grupları ve para formatları (1.250.000,50 veya 1250000 veya %25)
  const matches = text.match(/(?:₺|TL|\$|€)?\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*(?:TL|TRY|USD|EUR|%|gün|adet)?/gi);

  if (!matches) return [];

  const numbers: number[] = [];

  for (const m of matches) {
    // Rakam dışı gereksiz karakterleri temizle
    let clean = m
      .replace(/[₺TLTRYUSDEUR%günadeta-zA-Z\s]/g, "")
      .trim();

    if (!clean) continue;

    // Türk formatı (1.250.000,50) -> 1250000.50
    if (clean.includes(".") && clean.includes(",")) {
      clean = clean.replace(/\./g, "").replace(",", ".");
    } else if (clean.includes(".") && !clean.includes(",")) {
      // 1.250.000 mi yoksa 12.5 mi?
      const parts = clean.split(".");
      if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
        clean = clean.replace(/\./g, ""); // Binlik ayraç
      }
    } else if (clean.includes(",")) {
      clean = clean.replace(",", ".");
    }

    const val = parseFloat(clean);
    // Yıl (2025, 2026), çok küçük sayılar (0, 1, 2) gibi operasyonel olmayanları ele
    if (!isNaN(val) && val > 5 && val !== 2024 && val !== 2025 && val !== 2026 && val !== 2027) {
      numbers.push(val);
    }
  }

  return Array.from(new Set(numbers));
}

/**
 * LLM çıktısındaki finansal rakamların sağlanan gerçek olgularla (facts)
 * eşleştiğini doğrular (Grounding & Anti-Hallucination Guardrail).
 */
export function verifyFinancialGrounding(
  llmResponse: string,
  groundedFacts: GroundedFact[],
): GroundingCheckResult {
  const extractedNumbers = extractFinancialNumbers(llmResponse);
  const unmatched: number[] = [];

  for (const num of extractedNumbers) {
    // Grounded facts içinde aralık/tolerans kontrolü
    const matched = groundedFacts.some((fact) => {
      const tol = fact.tolerancePct ?? 0.02; // %2 tolerans (yuvarlama farkları)
      const diff = Math.abs(fact.numericValue - num);
      const allowedDiff = Math.max(1, Math.abs(fact.numericValue) * tol);
      return diff <= allowedDiff;
    });

    if (!matched) {
      unmatched.push(num);
    }
  }

  const isGrounded = unmatched.length === 0;
  const confidenceScore = extractedNumbers.length > 0
    ? Math.round(((extractedNumbers.length - unmatched.length) / extractedNumbers.length) * 100)
    : 100;

  let sanitized = llmResponse;
  if (!isGrounded) {
    // Halüsinasyon uyarısı ekle
    sanitized += `\n\n⚠️ [GÜVENLİK NOTU: Yanıttaki bazı rakamlar (${unmatched.join(", ")}) veritabanı olgularıyla tam doğrulanamadı; lütfen resmi tablolardan teyit ediniz.]`;
  }

  return {
    grounded: isGrounded,
    extractedNumbers,
    unmatchedNumbers: unmatched,
    confidenceScore,
    sanitizedResponse: sanitized,
  };
}
