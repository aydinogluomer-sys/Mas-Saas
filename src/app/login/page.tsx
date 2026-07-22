import { redirect } from "next/navigation";
import { accessGateEnabled, hasValidSession } from "@/lib/auth";
import { loginAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  // gate off, or already signed in → go straight to the app
  if (!accessGateEnabled() || (await hasValidSession())) redirect("/radar");

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0 p-4 text-tone-1">
      <div className="command-surface animate-rise w-full max-w-sm border p-6" style={{ borderRadius: "var(--radius-md)" }}>
        <div className="font-mono text-sm font-bold tracking-[0.2em]">MAS NAKİT RADAR</div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-tone-3">
          kapalı devre — erişim parolası gerekli
        </div>
        <form action={loginAction} className="mt-5 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">parola</span>
            <input
              name="password" type="password" autoFocus autoComplete="current-password"
              className="field-control mt-1 px-2 py-1.5 font-mono text-sm"
            />
          </label>
          {sp.error && <p className="font-mono text-[11px] text-neg">Parola hatalı.</p>}
          <button type="submit"
            className="w-full border border-pos tint-pos px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-pos transition-colors"
            style={{ borderRadius: "var(--radius-sm)" }}>
            giriş →
          </button>
        </form>
        <p className="mt-4 font-mono text-[9px] text-tone-4">
          Tek operatör, yerel özel kullanım. Çok kullanıcılı SaaS kimlik doğrulaması değildir.
        </p>
      </div>
    </div>
  );
}
