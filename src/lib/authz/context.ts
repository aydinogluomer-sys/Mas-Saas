// Faz 24B — resolving "who is asking" once per request, for the database to act on.
//
// @/lib/db calls this on every connection checkout, so it has to be both cheap and impossible
// to get wrong. React's `cache()` gives the first property: the session is read once per
// request no matter how many queries a page runs. The second comes from having exactly one
// source for the answer — `getCurrentUser()` in @/lib/auth, the same function the pages
// themselves use. Re-implementing the session lookup here would have created a second opinion
// about who is signed in, and the two would eventually disagree.

import { cache } from "react";
import { getRequestUser } from "@/lib/auth";
import { readActiveLegalEntityCookie } from "@/lib/entities/engine";
import { APP_ROLES, DB_ROLE, type AppRole } from "./matrix";

export interface DbContext {
  /** The PostgreSQL role to switch into, or null when nobody is signed in. */
  dbRole: string | null;
  /** The application user id, published as `app.user_id` for row-level policies. */
  userId: string | null;
  /** The application tier, for code that wants to explain itself rather than query. */
  role: AppRole | null;
  /** Active group legal entity id (`null` = Consolidated Group view). */
  legalEntityId: string | null;
}

const EMPTY: DbContext = { dbRole: null, userId: null, role: null, legalEntityId: null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Pure membership resolver for `mas_active_legal_entity` cookie vs `user_legal_entities`:
 * - Invalid cookie format is always coerced to `null`.
 * - `admin` and `finance_manager` may inspect any active entity or consolidated group scope (`null`).
 * - When `user_legal_entities` has assignments for a non-manager user (`viewer`, `finance_operator`,
 *   `finance_approver`), the user is pinned to their assigned entities (falling back to `assignedEntityIds[0]`
 *   instead of honoring an arbitrary cookie UUID or unauthorized consolidated view).
 */
export function resolveAllowedLegalEntityId(
  role: AppRole,
  rawCookieValue: string | null | undefined,
  assignedEntityIds: readonly string[],
): string | null {
  const trimmed = rawCookieValue?.trim() ?? "";
  const requested = UUID_RE.test(trimmed) ? trimmed : null;
  if (role === "admin" || role === "finance_manager") {
    return requested;
  }
  if (assignedEntityIds.length > 0) {
    if (requested !== null && assignedEntityIds.includes(requested)) {
      return requested;
    }
    return assignedEntityIds[0] ?? null;
  }
  return requested;
}

async function loadAssignedUserEntityIds(userId: string): Promise<string[]> {
  if (!UUID_RE.test(userId)) return [];
  const { env } = await import("@/lib/env");
  if (!env.databaseUrl || env.databaseUrl.includes("unit_test_no_connect")) {
    return [];
  }
  try {
    const { getPool, runAsReadOnlySystem } = await import("@/lib/db");
    return await runAsReadOnlySystem(async () => {
      const res = await getPool().query<{ legal_entity_id: string }>(
        `select ule.legal_entity_id::text as legal_entity_id
           from public.user_legal_entities ule
           join public.legal_entities le on le.id = ule.legal_entity_id
          where ule.user_id = $1::uuid
            and le.is_active = true
          order by le.is_default desc, ule.created_at asc, ule.legal_entity_id asc`,
        [userId],
      );
      return res.rows.map((r) => r.legal_entity_id).filter((id) => UUID_RE.test(id));
    });
  } catch {
    return [];
  }
}

/**
 * The current request's database context, memoised per request.
 *
 * Returns EMPTY rather than throwing when there is no session, and EMPTY means "no tier",
 * which after migration 0058 means no access to any business table. Every failure mode of
 * this function therefore denies rather than grants — including the case that worried me
 * most, a role string that is not one of the five (a hand-edited row, a future value added to
 * the CHECK constraint but not to the code). That is treated as unknown, not as a role name to
 * hand to SET ROLE.
 */
export const getDbContext = cache(async (): Promise<DbContext> => {
  const user = await getRequestUser();
  if (!user) return EMPTY;
  // Wave 0 / Dalga 1 #1: sessions under forced password change (migration 0095) receive NO
  // business DB tier. /change-password and changeOwnPassword operate exclusively on getRawPool().
  if (user.mustChangePassword) return EMPTY;
  if (!isAppRole(user.role)) return EMPTY;
  const rawCookieEntityId = await readActiveLegalEntityCookie();
  const assignedEntityIds =
    user.role === "admin" || user.role === "finance_manager"
      ? []
      : await loadAssignedUserEntityIds(user.id);
  const legalEntityId = resolveAllowedLegalEntityId(
    user.role,
    rawCookieEntityId,
    assignedEntityIds,
  );
  return { dbRole: DB_ROLE[user.role], userId: user.id, role: user.role, legalEntityId };
});
