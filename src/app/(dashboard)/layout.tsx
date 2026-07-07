import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { accessGateEnabled, hasValidSession } from "@/lib/auth";
import { logoutAction } from "@/app/login/actions";
import { Nav, type NavItem } from "@/components/ui/nav";

const NAV: NavItem[] = [
  { href: "/radar", label: "RADAR" },
  { href: "/calendar", label: "TAKVİM" },
  { href: "/payments", label: "ÖDEMELER" },
  { href: "/imports", label: "İÇE AKTARIM" },
  { href: "/cashflow", label: "NAKİT" },
  { href: "/financing", label: "ÇEK/KREDİ" },
  { href: "/reports", label: "RAPOR" },
  { href: "/reminders", label: "HATIRLATMA" },
  { href: "/production", label: "ÜRETİM" },
  { href: "/scenarios", label: "SENARYO" },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Single-operator access gate: when a password is configured, require a valid session.
  if (accessGateEnabled() && !(await hasValidSession())) redirect("/login");
  const gate = accessGateEnabled();
  return (
    <div className="min-h-screen" style={{ background: "var(--surface-0)", color: "var(--text-1)" }}>
      {/* thin brand accent rail */}
      <div style={{ height: "2px", background: "linear-gradient(90deg, var(--info), var(--accent))", opacity: 0.5 }} />
      <header
        className="sticky top-0 z-20 border-b px-4 py-3 backdrop-blur"
        style={{ borderColor: "var(--line)", background: "color-mix(in srgb, var(--surface-0) 88%, transparent)" }}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-sm font-bold tracking-[0.2em]" style={{ color: "var(--text-1)" }}>
              MAS NAKİT RADAR
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>
              kapalı devre finans operasyon paneli
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Nav items={NAV} />
            {gate && (
              <form action={logoutAction}>
                <button
                  type="submit"
                  title="çıkış"
                  className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors hover:text-red-300"
                  style={{ color: "var(--text-3)", borderColor: "var(--line-faint)", borderRadius: "2px" }}
                >
                  çıkış
                </button>
              </form>
            )}
          </div>
        </div>
      </header>
      <main className="stagger mx-auto max-w-6xl space-y-4 p-4">{children}</main>
    </div>
  );
}
