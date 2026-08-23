// Faz 17-38 denetimi — the server half of the page-level route gate.
//
// Split from route-access.ts on purpose, and the reason is testability rather than tidiness:
// this module reaches `requireSession()`, which reaches `next/headers` and `@node-rs/argon2`.
// Importing any of that into a unit test drags a cookie jar and a native module into a process
// that has neither. The DECISION therefore lives in route-access.ts (pure, synchronous) and is
// proved there across all 75 tier×route combinations; this file only carries it out.

import { requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui/shell";
import { accessDeniedMessage, canAccessRoute } from "./route-access";

/**
 * Page-level authorisation.
 *
 * Returns `null` when the signed-in tier may open `href`, and the refusal SCREEN when it may
 * not. Call it as the first statement of a guarded page:
 *
 *     const denied = await requireRouteAccess("/system/jobs");
 *     if (denied) return denied;
 *
 * WHY IT RETURNS A NODE INSTEAD OF THROWING OR REDIRECTING.
 *
 * `requireAdmin()` (lib/auth) redirects to /overview, and that was the existing pattern — but a
 * silent bounce is indistinguishable from a broken link: the operator lands somewhere else with
 * no statement that a decision was made about them. The brief for this phase is explicit that a
 * refused page must SAY it is refusing, and never render blank. Throwing would surface the
 * app's generic error boundary, which reads as a crash rather than a policy.
 *
 * The `if (denied) return denied` shape is enforced structurally: route-access.test.ts asserts
 * every route in PAGE_GUARDED_ROUTES contains both halves, so a page that calls the guard and
 * forgets to act on it fails the suite rather than shipping.
 */
export async function requireRouteAccess(href: string) {
  const session = await requireSession();
  if (canAccessRoute(session.role, href)) return null;
  return (
    <section className="space-y-4">
      <PageHeader title="Erişim yok" subtitle={href} />
      <div
        className="border px-3 py-3"
        style={{
          borderColor: "var(--warn)",
          background: "color-mix(in srgb, var(--warn) 8%, transparent)",
          borderRadius: "var(--radius)",
        }}
        role="alert"
        data-testid="route-access-denied"
      >
        <p className="font-mono text-[11px] leading-5" style={{ color: "var(--text-1)" }}>
          {accessDeniedMessage(session.role, href)}
        </p>
      </div>
    </section>
  );
}
