"use server";
import { redirect } from "next/navigation";
import { attemptLogin, createSessionCookie, revokeCurrentSession, safeRedirectPath } from "@/lib/auth";

export async function loginAction(formData: FormData): Promise<void> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeRedirectPath(String(formData.get("next") ?? ""), "/overview");
  const result = await attemptLogin(username, password);
  if (!result.ok || !result.userId) {
    // Same generic message regardless of unknown-username, wrong-password, or
    // locked-account — no case reveals whether the username exists.
    redirect(`/login?error=1&next=${encodeURIComponent(next)}`);
  }
  await createSessionCookie(result.userId);
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  await revokeCurrentSession();
  redirect("/login");
}
