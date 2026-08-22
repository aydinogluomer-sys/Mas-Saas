// Faz 24B — resolving "who is asking" once per request, for the database to act on.
//
// @/lib/db calls this on every connection checkout, so it has to be both cheap and impossible
// to get wrong. React's `cache()` gives the first property: the session is read once per
// request no matter how many queries a page runs. The second comes from having exactly one
// source for the answer — `getCurrentUser()` in @/lib/auth, the same function the pages
// themselves use. Re-implementing the session lookup here would have created a second opinion
// about who is signed in, and the two would eventually disagree.

import { cache } from "react";
import { getCurrentUser } from "@/lib/auth";
import { APP_ROLES, DB_ROLE, type AppRole } from "./matrix";

export interface DbContext {
  /** The PostgreSQL role to switch into, or null when nobody is signed in. */
  dbRole: string | null;
  /** The application user id, published as `app.user_id` for row-level policies. */
  userId: string | null;
  /** The application tier, for code that wants to explain itself rather than query. */
  role: AppRole | null;
}

const EMPTY: DbContext = { dbRole: null, userId: null, role: null };

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
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
  const user = await getCurrentUser();
  if (!user) return EMPTY;
  if (!isAppRole(user.role)) return EMPTY;
  return { dbRole: DB_ROLE[user.role], userId: user.id, role: user.role };
});
