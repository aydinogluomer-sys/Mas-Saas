/**
 * MAS Nakit Radar — Domain Cache Tags
 * 
 * 81 adet analitik SQL görünümü ve ana tablolar için etiketleme sözleşmesi.
 * Veritabanında bir mutasyon olduğunda (örn. yeni fatura girildiğinde),
 * sadece ilgili tag'ler invalidate edilerek ilişkili görünümlerin önbelleği tazelenir.
 */

export const CACHE_TAGS = {
  // Nakit Akışı ve Hareketler
  CASHFLOW: "domain:cashflow",
  DAILY_CASH: "domain:daily_cash",
  FORECAST_13W: "domain:forecast_13w",

  // Faturalar ve Cari Bakiyeler
  INVOICES: "domain:invoices",
  RECEIVABLES: "domain:receivables",
  PAYABLES: "domain:payables",
  CURRENT_ACCOUNTS: "domain:current_accounts",

  // Ödemeler ve Çekler
  PAYMENTS: "domain:payments",
  PAYMENT_CALENDAR: "domain:payment_calendar",
  PAYMENT_PRIORITY: "domain:payment_priority",

  // Banka ve Mutabakat
  BANK_ACCOUNTS: "domain:bank_accounts",
  BANK_TRANSACTIONS: "domain:bank_transactions",
  BANK_RECONCILIATION: "domain:bank_reconciliation",

  // Tahsilat ve Karşı Taraf Riski
  COLLECTIONS: "domain:collections",
  COUNTERPARTY_RISK: "domain:counterparty_risk",
  PROMISES: "domain:promises",
  REMINDERS: "domain:reminders",

  // Hazine, Kredi ve Döviz
  TREASURY: "domain:treasury",
  CREDIT_FACILITIES: "domain:credit_facilities",
  FX_EXPOSURE: "domain:fx_exposure",
  FX_RATES: "domain:fx_rates",

  // Bütçe ve Tahminler
  BUDGET: "domain:budget",
  FORECAST: "domain:forecast",

  // İç Kontrol ve Anomaliler
  CONTROLS: "domain:controls",
  ALERTS: "domain:alerts",

  // Yönetici Brifingi ve Raporlar
  CFO_BRIEFING: "domain:cfo_briefing",
  REPORTS: "domain:reports",

  // İş Kuyrukları ve Sistem
  BACKGROUND_JOBS: "domain:background_jobs",
  INTEGRATIONS: "domain:integrations",
  DATA_QUALITY: "domain:data_quality",
  PRODUCTION: "domain:production",
  SCENARIOS: "domain:scenarios",
} as const;

export type CacheTag = (typeof CACHE_TAGS)[keyof typeof CACHE_TAGS];

/**
 * Bir tablo mutasyonuna karşılık hangi cache tag'lerinin invalidate edilmesi gerektiğini haritalar.
 */
export const TABLE_MUTATION_TAG_MAP: Record<string, CacheTag[]> = {
  invoices: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES, CACHE_TAGS.PAYABLES, CACHE_TAGS.CASHFLOW, CACHE_TAGS.CFO_BRIEFING],
  invoice_lines: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES, CACHE_TAGS.PAYABLES],
  invoice_allocations: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES, CACHE_TAGS.PAYABLES, CACHE_TAGS.BANK_RECONCILIATION],
  
  payments: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.PAYMENT_CALENDAR, CACHE_TAGS.PAYMENT_PRIORITY, CACHE_TAGS.CASHFLOW, CACHE_TAGS.CFO_BRIEFING],
  payment_instances: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.PAYMENT_CALENDAR, CACHE_TAGS.CASHFLOW, CACHE_TAGS.DAILY_CASH],
  checks: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.PAYMENT_CALENDAR, CACHE_TAGS.CASHFLOW, CACHE_TAGS.CFO_BRIEFING],

  bank_transactions: [CACHE_TAGS.BANK_TRANSACTIONS, CACHE_TAGS.BANK_ACCOUNTS, CACHE_TAGS.BANK_RECONCILIATION, CACHE_TAGS.DAILY_CASH, CACHE_TAGS.CFO_BRIEFING],
  bank_transaction_matches: [CACHE_TAGS.BANK_RECONCILIATION, CACHE_TAGS.INVOICES, CACHE_TAGS.BANK_ACCOUNTS],

  promise_to_pay: [CACHE_TAGS.PROMISES, CACHE_TAGS.COLLECTIONS, CACHE_TAGS.COUNTERPARTY_RISK, CACHE_TAGS.CASHFLOW],
  control_alerts: [CACHE_TAGS.CONTROLS, CACHE_TAGS.ALERTS, CACHE_TAGS.CFO_BRIEFING],

  credit_facilities: [CACHE_TAGS.CREDIT_FACILITIES, CACHE_TAGS.TREASURY, CACHE_TAGS.CASHFLOW],
  fx_positions_rates: [CACHE_TAGS.FX_EXPOSURE, CACHE_TAGS.FX_RATES, CACHE_TAGS.TREASURY],

  budgets: [CACHE_TAGS.BUDGET, CACHE_TAGS.CFO_BRIEFING],
  forecasts: [CACHE_TAGS.FORECAST, CACHE_TAGS.CASHFLOW],
};
