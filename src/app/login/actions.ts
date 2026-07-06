"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accessGateEnabled, passwordMatches, sessionToken, SESSION_COOKIE } from "@/lib/auth";

export async function loginAction(formData: FormData): Promise<void> {
  if (!accessGateEnabled()) redirect("/radar");
  const password = String(formData.get("password") ?? "");
  if (!passwordMatches(password)) {
    // no password value is logged or echoed back
    redirect("/login?error=1");
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sessionToken(process.env.APP_ACCESS_PASSWORD ?? ""), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
  redirect("/radar");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
