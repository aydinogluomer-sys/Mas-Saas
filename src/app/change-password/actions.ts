"use server";
// The way out of a forced password change (migration 0095), and the voluntary change for
// everyone else. The work itself is changeOwnPassword in @/lib/auth — it runs on the identity
// connection, audits under the user's own tier and closes every other session; see its comment.
//
// Failures leave as a CODE in the redirect (`?error=invalid_old`), never as text: the page maps
// a known code to a fixed sentence and ignores anything else (@/lib/users/password-policy).
import { redirect } from "next/navigation";
import { changeOwnPassword, requireSession } from "@/lib/auth";
import { PasswordChangeError } from "@/lib/users/password-policy";

export async function changePasswordAction(formData: FormData): Promise<void> {
  const user = await requireSession({ allowMustChangePassword: true });
  const oldPassword = String(formData.get("oldPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirmPassword) redirect("/change-password?error=mismatch");

  try {
    await changeOwnPassword(user, oldPassword, newPassword);
  } catch (e) {
    if (e instanceof PasswordChangeError) redirect(`/change-password?error=${e.code}`);
    throw e;
  }

  // No session cache stands in the way any more (Wave 0 / S2): the next request reads
  // must_change_password from the database and lets the user through.
  redirect("/overview?flash=password_updated");
}
