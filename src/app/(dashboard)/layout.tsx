import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { accessGateEnabled, hasValidSession } from "@/lib/auth";
import { logoutAction } from "@/app/login/actions";

const NAV = [
  { href: "/radar", label: "RADAR", active: true },
  { href: "/calendar", label: "TAKVİM", active: true },
  { href: "/payments", label: "ÖDEMELER", active: true },
  { href: "/imports", label: "İÇE AKTARIM", active: true },
  { href: "/cashflow", label: "NAKİT", active: true },
  { href: "/financing", label: "ÇEK/KREDİ", active: true },
  { href: "/reports", label: "RAPOR", active: true },
  { href: "/reminders", label: "HATIRLATMA", active: true },
  { href: "/production", label: "ÜRETİM", active: true },
  { href: "/scenarios", label: "SENARYO", active: true },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Single-operator access gate: when a password is configured, require a valid session.
  if (accessGateEnabled() && !(await hasValidSession())) redirect("/login");
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div>
            <div className="font-mono text-sm font-bold tracking-[0.2em]">MAS NAKİT RADAR</div>
            <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-500">
              kapalı devre finans operasyon paneli
            </div>
          </div>
          <nav className="flex gap-1">
            {NAV.map((n) =>
              n.active ? (
                <Link key={n.label} href={n.href}
                  className="border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-200">
                  {n.label}
                </Link>
              ) : (
                <span key={n.label}
                  className="border border-zinc-900 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
                  {n.label}
                </span>
              ),
            )}
            {accessGateEnabled() && (
              <form action={logoutAction}>
                <button type="submit" title="çıkış"
                  className="border border-zinc-800 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500 hover:text-red-300">
                  çıkış
                </button>
              </form>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 p-4">{children}</main>
    </div>
  );
}
