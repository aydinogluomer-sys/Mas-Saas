/** Authenticated workspace pages reachable from the sidebar and module tabs. */
export const WORKSPACE_PRELOAD_ROUTES = [
  "/overview",
  "/payments", "/payments/calendar", "/payments/items", "/payments/missing", "/payments/history", "/payments/archive",
  "/cashflow", "/cashflow/monthly", "/cashflow/budget", "/cashflow/concentration", "/cashflow/controls",
  "/finance", "/finance/checks", "/finance/loans", "/finance/facilities", "/finance/fx", "/finance/exposure",
  "/finance/counterparties", "/finance/profitability", "/finance/bank", "/finance/treasury", "/finance/invoices",
  "/finance/receivables", "/finance/collections", "/finance/promises", "/finance/maturities", "/finance/calendar", "/finance/archive",
  "/production", "/production/capacity", "/production/costs", "/production/profitability", "/production/roi",
  "/scenarios", "/scenarios/compare", "/scenarios/history", "/scenarios/optimization",
  "/insights/ask", "/insights/briefing", "/insights/analysis", "/insights/reports", "/insights/reminders", "/insights/tasks",
  "/data/quality", "/data/imports", "/data/reviews", "/data/approvals", "/data/reconciliation", "/data/assumptions", "/data/documents", "/data/sources",
  "/system", "/system/backup", "/system/audit", "/system/controls", "/system/jobs", "/system/archive", "/system/security", "/system/features",
] as const;
