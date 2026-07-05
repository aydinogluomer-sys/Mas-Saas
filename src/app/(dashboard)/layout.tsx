import type { ReactNode } from "react";
import Link from "next/link";

const NAV = [
  { href: "/imports", label: "İÇE AKTARIM", active: true },
  { href: "#", label: "RADAR — Faz 3", active: false },
  { href: "#", label: "NAKİT AKIŞ — Faz 4", active: false },
  { href: "#", label: "ÇEK/KREDİ — Faz 5", active: false },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
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
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 p-4">{children}</main>
    </div>
  );
}
