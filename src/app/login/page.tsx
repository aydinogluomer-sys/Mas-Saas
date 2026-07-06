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
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-4 text-zinc-200">
      <div className="w-full max-w-sm border border-zinc-800 bg-zinc-950 p-6">
        <div className="font-mono text-sm font-bold tracking-[0.2em]">MAS NAKİT RADAR</div>
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
          kapalı devre — erişim parolası gerekli
        </div>
        <form action={loginAction} className="mt-5 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">parola</span>
            <input
              name="password" type="password" autoFocus autoComplete="current-password"
              className="mt-1 w-full border border-zinc-700 bg-black/40 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-zinc-500"
            />
          </label>
          {sp.error && <p className="font-mono text-[11px] text-red-400">Parola hatalı.</p>}
          <button type="submit" className="w-full border border-emerald-700 bg-emerald-950/40 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-emerald-300">
            giriş →
          </button>
        </form>
        <p className="mt-4 font-mono text-[9px] text-zinc-600">
          Tek operatör, yerel özel kullanım. Çok kullanıcılı SaaS kimlik doğrulaması değildir.
        </p>
      </div>
    </div>
  );
}
