import { revalidatePath } from "next/cache";

/**
 * Merkezi çapraz-modül önbellek tazeleme yardımcısı (F-63):
 * Hayalet/var olmayan rotaları (`revalidatePath`) çağırmak yerine fatura, tahsilat, ödeme,
 * banka, çek, kredi, hazine veya yönetim defteri değiştiğinde tüm bağlı özet ekranlarını
 * deterministik olarak geçersiz kılar.
 */
export const CANONICAL_FINANCIAL_VIEWS = [
  "/",
  "/cashflow",
  "/cashflow/13-week",
  "/cashflow/monthly",
  "/cashflow/budget",
  "/cashflow/controls",
  "/finance",
  "/finance/treasury",
  "/finance/bank",
  "/finance/invoices",
  "/finance/receivables",
  "/finance/collections",
  "/finance/checks",
  "/finance/loans",
  "/finance/facilities",
  "/finance/ledger",
  "/finance/maturities",
  "/finance/calendar",
  "/finance/promises",
  "/payments",
  "/payments/items",
  "/payments/calendar",
  "/insights",
  "/insights/briefing",
] as const;

export function revalidateFinancialViews(extraPaths: string[] = []): void {
  const seen = new Set<string>();
  for (const route of [...CANONICAL_FINANCIAL_VIEWS, ...extraPaths]) {
    const clean = route.split("?")[0]?.trim();
    if (!clean || !clean.startsWith("/") || seen.has(clean)) continue;
    seen.add(clean);
    revalidatePath(clean);
  }
}

