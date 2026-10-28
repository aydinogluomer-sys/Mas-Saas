"use server";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { changeOwnPassword } from "@/lib/users/engine";
import { DomainError } from "@/lib/domain-error";

export async function changePasswordAction(formData: FormData): Promise<void> {
  const user = await requireSession({ allowMustChangePassword: true });
  const oldPassword = String(formData.get("oldPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword !== confirmPassword) {
    redirect("/change-password?error=" + encodeURIComponent("Yeni parolalar birbiriyle eşleşmiyor."));
  }

  try {
    await changeOwnPassword(getPool(), user.id, oldPassword, newPassword);
  } catch (e) {
    if (e instanceof DomainError) {
      redirect("/change-password?error=" + encodeURIComponent(e.message));
    }
    throw e;
  }

  redirect("/overview?flash=password_updated");
}
