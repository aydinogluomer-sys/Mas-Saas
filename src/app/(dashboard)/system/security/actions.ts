"use server";
// Every action here is admin-only. requireAdmin() is called FIRST in each one — before any
// form value is read — so an operator hitting these directly is redirected before a single
// mutation is considered. The DB's own "at least one active admin" constraint trigger (0031)
// is the real backstop for the last-admin case; the checks here only produce nicer messages.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { DomainError } from "@/lib/domain-error";
import { createUser, resetUserPassword, forcePasswordChange, setUserActive, setUserRole, unlockUser } from "@/lib/users/engine";
import { APP_ROLES, type AppRole } from "@/lib/authz/matrix";

const PAGE = "/system/security";

/** Curated flash keys only (see src/components/ui/primitives/toast.tsx) — a raw error message
 * is never echoed into the URL, so neither a Postgres string nor user input can reach the page. */
function done(flash: string): never {
  revalidatePath(PAGE);
  redirect(`${PAGE}?flash=${flash}`);
}

/** DomainError carries a message written for the user; anything else is an unexpected system
 * fault and must propagate untouched rather than being flattened into a friendly flash. */
function fail(e: unknown): never {
  if (e instanceof DomainError) redirect(`${PAGE}?flash=user_error`);
  throw e;
}


/** Narrow untrusted form input to a known tier, defaulting to the least privileged one. */
function asAppRole(raw: FormDataEntryValue | null, fallback: AppRole): AppRole {
  const value = String(raw ?? "");
  return (APP_ROLES as readonly string[]).includes(value) ? (value as AppRole) : fallback;
}

export async function createUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  // Faz 24B: the tier arrives as free text from a form, so it is narrowed against the matrix's
  // own list. An unrecognised value becomes `viewer` — the least privileged tier — rather than
  // the most convenient one, so a malformed request can never mint an approver.
  const role = asAppRole(formData.get("role"), "viewer");
  try {
    await createUser(
      getPool(),
      {
        username: String(formData.get("username") ?? ""),
        displayName: String(formData.get("displayName") ?? ""),
        role,
        password: String(formData.get("password") ?? ""),
      },
      admin.id,
    );
  } catch (e) {
    fail(e);
  }
  done("user_created");
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  try {
    await resetUserPassword(getPool(), id, String(formData.get("password") ?? ""), admin.id);
  } catch (e) {
    fail(e);
  }
  done("password_reset");
}

export async function forcePasswordChangeAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  try {
    await forcePasswordChange(getPool(), id, admin.id);
  } catch (e) {
    fail(e);
  }
  done("password_force_change");
}

export async function deactivateUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  // Locking yourself out is never the intent behind clicking "pasifleştir" on your own row.
  // The last-admin case is separately (and authoritatively) blocked by the DB trigger.
  if (id === admin.id) redirect(`${PAGE}?flash=user_self`);
  try {
    await setUserActive(getPool(), id, false, admin.id);
  } catch (e) {
    fail(e);
  }
  done("user_deactivated");
}

export async function activateUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  try {
    await setUserActive(getPool(), String(formData.get("id") ?? ""), true, admin.id);
  } catch (e) {
    fail(e);
  }
  done("user_activated");
}

export async function setRoleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = asAppRole(formData.get("role"), "viewer");
  // An admin must not be able to demote themselves out of the only tier that can promote
  // anyone back — that is how a system ends up with no administrator at all.
  if (id === admin.id && role !== "admin") redirect(`${PAGE}?flash=user_self`);
  try {
    await setUserRole(getPool(), id, role, admin.id);
  } catch (e) {
    fail(e);
  }
  done("role_changed");
}

export async function unlockUserAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  try {
    await unlockUser(getPool(), String(formData.get("id") ?? ""), admin.id);
  } catch (e) {
    fail(e);
  }
  done("user_unlocked");
}
