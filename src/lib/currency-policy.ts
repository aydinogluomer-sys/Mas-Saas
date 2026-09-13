// PHASE 2 — Para birimi politikası (plan §2.1): controlled use için TRY-only.
//
// `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` kabul edilmiş borçtur: kur çevirimi YOK ve
// burada yazılmıyor. Bu modülün tek işi, para taşıyan bir satır kümesini TOPLAMADAN ÖNCE ikiye
// ayırmaktır: raporlama para birimindekiler (toplanır) ve diğerleri (toplanmaz, SAYILIR).
//
// Kurallar (CLAUDE.md + phase2-currency-scan.md kapanış stratejisi):
//   · Farklı para birimleri doğrudan toplanmaz/karşılaştırılmaz.
//   · `null`/eksik para birimi = BİLİNMİYOR; TRY varsayılmaz → toplam dışı, sayılır.
//   · Toplam dışı kalan hiçbir satır sessizce düşmez: `foreignCount` ekranda "n kalem TRY-dışı —
//     toplamda yok" olarak görünür (plan §2.3 UI kuralı).
//   · Para birimi kolonu OLMAYAN tablolar (checks, loans, cashflow_*, production…) yapısal olarak
//     tek para birimlidir; onlar için bu süzgeç uygulanmaz — `currency` alanı hiç yoksa satır
//     karşılaştırılabilir sayılır (aşağıda `hasCurrencyField`).
//
// radar/rules.ts'teki `THRESHOLD_CURRENCY`/`isThresholdCurrency` aynı sabiti kullanır; eşik
// kararı (Tier 1) ile toplam kararı (Tier 2) tek kaynaktan beslenir.
import { decimal, money, zero } from "@/lib/money";

export const REPORTING_CURRENCY = "TRY";

export function isReportingCurrency(currency: string | null | undefined): boolean {
  return currency === REPORTING_CURRENCY;
}

/**
 * Satır toplanabilir mi? `undefined` = alan hiç yok (yapısal TRY) → evet; `null` = bilinmiyor →
 * hayır; TRY → evet; başka → hayır. `partitionByCurrency` ile aynı kural, tek satır için.
 */
export function isComparableCurrency(currency: string | null | undefined): boolean {
  return currency === undefined || currency === REPORTING_CURRENCY;
}

export interface CurrencyPartition<T> {
  /** Raporlama para birimindeki satırlar — toplanabilir. */
  comparable: T[];
  /** TRY-dışı ya da para birimi bilinmeyen satırlar — toplanmaz, sayılır. */
  foreign: T[];
  foreignCount: number;
}

/**
 * Satırları toplanabilir / toplanamaz diye ayırır.
 *
 * `currency` alanı satırda HİÇ YOKSA (`undefined`, örn. checks/loans) satır yapısal TRY sayılır ve
 * toplanabilir. Alan varsa ve `null`/TRY-dışı ise toplanamaz. Ayrım bilerek "alan yok" ile
 * "alan null" arasında: ilki şema bilgisi, ikincisi veri eksikliğidir.
 */
export function partitionByCurrency<T extends { currency?: string | null }>(rows: readonly T[]): CurrencyPartition<T> {
  const comparable: T[] = [];
  const foreign: T[] = [];
  for (const r of rows) {
    if (!("currency" in r) || r.currency === undefined || isReportingCurrency(r.currency)) comparable.push(r);
    else foreign.push(r);
  }
  return { comparable, foreign, foreignCount: foreign.length };
}

export interface KnownSum {
  /** Bilinen (null olmayan) TRY tutarların toplamı — money ölçeğinde. */
  total: number;
  /** Tutarı null olan (bilinmeyen) karşılaştırılabilir satır sayısı. */
  missing: number;
  /** TRY-dışı/para birimi bilinmeyen satır sayısı — toplamda YOK. */
  foreignCount: number;
  /** Karşılaştırılabilir satır sayısı (missing dahil). */
  count: number;
}

/**
 * "Bilinen TRY toplamı": null tutarlar 0 sayılmaz (sayılır), TRY-dışı satırlar toplanmaz (sayılır).
 * Ondalık toplanır; float birikimi yok (money.ts).
 */
export function sumKnownReporting<T extends { currency?: string | null }>(
  rows: readonly T[], amountOf: (row: T) => number | null | undefined, opts: { positiveOnly?: boolean } = {},
): KnownSum {
  const { comparable, foreignCount } = partitionByCurrency(rows);
  let acc = zero();
  let missing = 0;
  for (const r of comparable) {
    const a = amountOf(r);
    if (a === null || a === undefined) { missing++; continue; }
    if (opts.positiveOnly && a <= 0) continue;
    acc = acc.plus(decimal(a));
  }
  return { total: money(acc), missing, foreignCount, count: comparable.length };
}

/** Ekran cümlesi — tek yerde, aynı sözlerle. `null` = gösterilecek bir şey yok. */
export function foreignNote(foreignCount: number, what = "kalem"): string | null {
  return foreignCount > 0 ? `${foreignCount} ${what} TRY-dışı — toplamda yok` : null;
}
