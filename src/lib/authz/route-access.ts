// Faz 17-38 denetimi — the page-level half of role-based routing.
//
// WHAT WAS MISSING, MEASURED RATHER THAN ASSUMED.
//
// Fifteen routes shipped across Faz 26-38 (finance/bank, finance/invoices, finance/receivables,
// finance/collections, finance/treasury, finance/facilities, finance/fx, finance/profitability,
// cashflow/budget, data/approvals, data/documents, insights/analysis, insights/briefing,
// system/controls, system/jobs). Grepping all fifteen page.tsx files for `requireAdmin`,
// `requireSession`, `canPerform`, `canDecideApprovals` or `canAdministerUsers` returned NOTHING:
// the only thing standing in front of them was `requireSession()` in (dashboard)/layout.tsx,
// which asks "is anybody signed in", not "may THIS tier be here".
//
// So the tier was decided in two places and enforced in one and a half:
//   - navigation      — canSeeRoute()/tabsFor() hid the tab                (a drawn door)
//   - the database    — migration 0058's policies stopped the query        (the real lock)
//   - the page itself — nothing                                           (the gap)
// A hidden tab is a rendering choice. Typing the URL is not an attack, it is a bookmark, and
// /system/jobs answered it for a viewer even though the sidebar never offered it.
//
// WHY THIS DELEGATES TO canSeeRoute() INSTEAD OF DECLARING ITS OWN TABLE.
//
// A second list would be a second opinion, and the two would drift — the module comment in
// matrix.ts makes exactly this argument about visibility, and phase38:verify asserts the
// assistant reuses canSeeRoute() for the same reason. This file therefore adds NO new policy.
// It closes the distance between what navigation already claims and what the page enforces.
//
// WHAT THIS DELIBERATELY DOES NOT DO: TIGHTEN.
//
// Checked against the live catalogue before writing a line. Every table behind these fifteen
// pages grants SELECT to all five tiers — all 27 of them (bank_accounts, bank_transactions,
// invoices, invoice_allocations, promise_to_pay, treasury_policies, credit_facilities,
// facility_drawdowns, collateral_records, fx_positions, fx_rate_snapshots, budgets,
// budget_lines, forecasts, approvals, approval_steps, documents, attachments,
// ai_response_snapshots, control_alerts, background_jobs, settings, saved_views, action_items,
// reports, cost_allocation_rules, part_profitability_runs). That is the "wide read, narrow
// write" shape 0058 was built around, and a page gate that were STRICTER than the data layer
// would be withholding numbers a colleague is entitled to read — a regression wearing a
// security badge. Twelve of the fifteen routes are therefore open to all five tiers, viewer
// included, read-only.
//
// The three that are not were ALREADY decided, by Faz 24B/36, and are honoured here rather
// than invented:
//   /data/approvals   — ROUTE_MIN_TIER: approver/manager/admin. The maker-checker surface; an
//                       operator raises requests but may not decide them.
//   /system/controls   } MODULE_MIN_TIER "/system": manager/admin. Its own comment says "every
//   /system/jobs       } page inside already refuses them" — which was the untrue half. Now true.
//
// RLS STAYS EXACTLY AS IT IS. No policy was read-modified, none was dropped. This is a third
// agreeing layer in front of the database, never a replacement for it.

import { APP_ROLES, ROLE_LABEL, canSeeRoute, type AppRole } from "./matrix";

/**
 * The fifteen routes this phase put a page-level gate on.
 *
 * Frozen and exported so the gate can ENUMERATE rather than trust: route-access.test.ts walks
 * this list against all five tiers (75 combinations) and a structural test asserts each of these
 * page.tsx files actually calls the guard. A sixteenth route added without a gate is then a test
 * failure rather than a silent hole — which is precisely how the first fifteen happened.
 */
export const PAGE_GUARDED_ROUTES: readonly string[] = Object.freeze([
  "/finance/bank",
  "/finance/invoices",
  "/finance/receivables",
  "/finance/collections",
  "/finance/treasury",
  "/finance/facilities",
  "/finance/fx",
  "/finance/profitability",
  "/cashflow/budget",
  "/data/approvals",
  "/data/documents",
  "/insights/analysis",
  "/insights/briefing",
  "/system/controls",
  "/system/jobs",
]);

/**
 * May this tier open this route?
 *
 * Pure, synchronous, and free of `next/headers` on purpose: the 75-combination table test
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
 * Says WHICH tier is signed in and WHAT it would take, because "yetkiniz yok" with no subject
 * is indistinguishable from a bug and generates a support question every time. It deliberately
 * does NOT describe the page's contents — a refusal that leaks what is behind the door is not a
 * refusal.
 */
export function accessDeniedMessage(role: AppRole, href: string): string {
  const allowed = rolesAllowedOn(href).map((r) => ROLE_LABEL[r]).join(", ");
  return (
    `Bu sayfaya erişim yetkiniz yok. Oturumunuz «${ROLE_LABEL[role]}» katmanında; ` +
    `bu ekran ${allowed || "hiçbir katman"} için ayrılmış. Erişim gerekiyorsa bir yöneticiden isteyin.`
  );
}
