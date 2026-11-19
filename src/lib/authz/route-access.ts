// Faz 17-38 denetimi & Wave 1 (F-09..F-11) — 100% page-level route gate across all 80 dashboard routes.
//
// WHY THIS DELEGATES TO canSeeRoute() INSTEAD OF DECLARING ITS OWN TABLE.
//
// A second policy list would be a second opinion, and the two would drift — the module comment in
// matrix.ts makes this exact argument about visibility, and phase38:verify asserts the assistant
// reuses canSeeRoute() for the same reason. This module therefore adds NO competing policy: it
// closes the distance between what navigation claims and what every `src/app/(dashboard)/**/page.tsx`
// enforces before opening `getPool()`.
//
// RLS STAYS EXACTLY AS IT IS. This is an agreeing server-render layer in front of PostgreSQL RLS,
// never a replacement for it.

import { APP_ROLES, ROLE_LABEL, canSeeRoute, type AppRole } from "./matrix";

/**
 * Every `page.tsx` route under `src/app/(dashboard)` (80/80).
 *
 * Frozen and exported so `route-access.test.ts` can enumerate all 5 × 80 = 400 tier×route
 * decisions AND verify against recursive filesystem discovery on `src/app/(dashboard)` that zero
 * `page.tsx` files exist outside this list or omit `const denied = await requireRouteAccess(...)`.
 */
export const PAGE_GUARDED_ROUTES: readonly string[] = Object.freeze([
  "/",
  "/cashflow",
  "/cashflow/13-week",
  "/cashflow/[monthId]",
  "/cashflow/budget",
  "/cashflow/close",
  "/cashflow/concentration",
  "/cashflow/controls",
  "/cashflow/monthly",
  "/data",
  "/data/approvals",
  "/data/assumptions",
  "/data/documents",
  "/data/imports",
  "/data/imports/[workbookId]",
  "/data/imports/[workbookId]/reviews",
  "/data/imports/[workbookId]/sheets/[sheetId]",
  "/data/imports/v2",
  "/data/integrations",
  "/data/quality",
  "/data/reconciliation",
  "/data/reviews",
  "/data/sources",
  "/data/trial-balance-bridge",
  "/finance",
  "/finance/archive",
  "/finance/bank",
  "/finance/calendar",
  "/finance/checks",
  "/finance/checks/new",
  "/finance/collections",
  "/finance/counterparties",
  "/finance/exposure",
  "/finance/facilities",
  "/finance/fx",
  "/finance/invoices",
  "/finance/ledger",
  "/finance/loans",
  "/finance/loans/[loanId]",
  "/finance/loans/new",
  "/finance/maturities",
  "/finance/profitability",
  "/finance/promises",
  "/finance/receivables",
  "/finance/treasury",
  "/insights",
  "/insights/analysis",
  "/insights/ask",
  "/insights/ask/[responseId]",
  "/insights/briefing",
  "/insights/reminders",
  "/insights/reports",
  "/insights/reports/[reportId]",
  "/insights/tasks",
  "/payments",
  "/payments/[paymentId]/edit",
  "/payments/archive",
  "/payments/calendar",
  "/payments/history",
  "/payments/items",
  "/payments/missing",
  "/payments/new",
  "/production",
  "/production/capacity",
  "/production/costs",
  "/production/kiosk",
  "/production/profitability",
  "/production/roi",
  "/scenarios",
  "/scenarios/[runId]",
  "/scenarios/compare",
  "/scenarios/history",
  "/scenarios/optimization",
  "/system",
  "/system/archive",
  "/system/audit",
  "/system/backup",
  "/system/controls",
  "/system/diagnostics",
  "/system/features",
  "/system/jobs",
  "/system/security",
]);

/**
 * May this tier open this route?
 *
 * Pure, synchronous, and free of `next/headers` on purpose: the 400-combination table test
 * imports THIS, not the server guard, so the decision can be proved without a request, a
 * cookie jar, or a database.
 */
export function canAccessRoute(role: AppRole, href: string): boolean {
  return canSeeRoute(role, href);
}

/** Every tier permitted on a route — for the gate and the report to enumerate. */
export function rolesAllowedOn(href: string): AppRole[] {
  return APP_ROLES.filter((role) => canAccessRoute(role, href));
}

/**
 * The sentence a refused tier is shown.
 *
 * Says WHICH tier is signed in and WHAT it would take, without leaking any page contents or numbers.
 */
export function accessDeniedMessage(role: AppRole, href: string): string {
  const allowed = rolesAllowedOn(href).map((r) => ROLE_LABEL[r]).join(", ");
  return (
    `Bu sayfaya erişim yetkiniz yok. Oturumunuz «${ROLE_LABEL[role]}» katmanında; ` +
    `bu ekran ${allowed || "hiçbir katman"} için ayrılmış. Erişim gerekiyorsa bir yöneticiden isteyin.`
  );
}
