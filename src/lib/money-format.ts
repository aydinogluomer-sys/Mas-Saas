// Faz 47 (D1) — Döviz-duyarlı tekil para biçimlendirici.
//
// KURAL:
//   1. `amount == null` / boş / geçersiz sayı -> `"—"` (`BLANK ≠ ZERO`, asla 0,00 TL basılmaz).
//   2. `'TRY'` / `'TL'` -> `"12.345,67 TL"`.
//   3. Yabancı para (`'USD'`, `'EUR'`, `'GBP'`, vb.) -> `"12.345,67 USD"` (asla `" TL"` soneki almaz!).
//   4. `currency == null` / boş -> `"12.345,67 (PB?)"` (para birimi bilinmiyorsa TRY varsayılmaz!).

import { moneyOrNull } from "@/lib/money";

export interface FormatMoneyOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export function normalizeCurrencyLabel(currency?: string | null): string {
  if (typeof currency !== "string") return "(PB?)";
  const code = currency.trim().toUpperCase();
  if (!code) return "(PB?)";
  if (code === "TRY" || code === "TL") return "TL";
  return code;
}

export function formatMoney(
  amount: number | string | null | undefined,
  currency?: string | null,
  options?: FormatMoneyOptions,
): string {
  const parsed = moneyOrNull(amount);
  if (parsed == null) return "—";
  const minFrac = options?.minimumFractionDigits ?? 2;
  const maxFrac = options?.maximumFractionDigits ?? 2;
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: minFrac,
    maximumFractionDigits: Math.max(minFrac, maxFrac),
  }).format(parsed);
  return `${formatted} ${normalizeCurrencyLabel(currency)}`;
}

export interface CurrencyAmountBucket {
  currency: string | null;
  total: number | null;
  count: number;
}

export function formatForeignCurrencyBadges(
  buckets: ReadonlyArray<CurrencyAmountBucket>,
): string | undefined {
  if (buckets.length === 0) return undefined;
  const parts = buckets.map((b) => {
    const label = b.total == null
      ? `${b.count} ${normalizeCurrencyLabel(b.currency)} (belirsiz)`
      : `+ ${formatMoney(b.total, b.currency)} (${b.count})`;
    return label;
  });
  return parts.join(" · ");
}

export const formatForeignBucketNote = formatForeignCurrencyBadges;


