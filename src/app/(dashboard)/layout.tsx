import type { ReactNode } from "react";
import { logoutAction } from "@/app/login/actions";
import { NavigationFeedbackProvider } from "@/components/ui/navigation-feedback";
import { AppSidebar, type NavItem } from "@/components/ui/nav";
import { CommandPaletteTrigger } from "@/components/search/command-palette-trigger";
import { AppToaster, FlashToaster } from "@/components/ui/primitives/toast";
import { requireSession } from "@/lib/auth";
import { ROLE_LABEL, can, canSeeRoute, navigationFor } from "@/lib/authz/matrix";

// Financial workspaces must read current PostgreSQL data at request time.
// This also prevents production builds from opening dozens of DB-backed pages
// concurrently during static generation.
export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/", label: "Genel Bakış", description: "Bugün ve öncelikler", icon: "overview", aliases: ["/overview"] },
  { href: "/payments", label: "Ödemeler", description: "Radar, takvim ve kalemler", icon: "payments", aliases: ["/radar", "/calendar"] },
  { href: "/cashflow", label: "Nakit Akışı", description: "Runway ve projeksiyon", icon: "cashflow" },
  { href: "/finance", label: "Finansman", description: "Çek, kredi ve vadeler", icon: "finance", aliases: ["/financing"] },
  { href: "/production", label: "Üretim", description: "Kapasite ve kârlılık", icon: "production" },
  { href: "/scenarios", label: "Senaryolar", description: "What-if ve optimizasyon", icon: "scenarios" },
  { href: "/insights/ask", label: "İçgörüler", description: "Soru, rapor ve görevler", icon: "insights", aliases: ["/insights", "/ask", "/reports", "/reminders"] },
  { href: "/data/quality", label: "Veri Merkezi", description: "Kalite, Excel ve kaynaklar", icon: "data", aliases: ["/data", "/imports", "/data-quality", "/assumptions"] },
  { href: "/system", label: "Sistem", description: "Durum, güvenlik ve denetim", icon: "system", aliases: ["/admin", "/phases"] },
];

const QUICK_ACTIONS: Array<NavItem & { writeEntity?: Parameters<typeof can>[1] }> = [
  { href: "/payments/new", label: "Yeni ödeme ekle", description: "Ödemeler · hızlı işlem", icon: "payments", writeEntity: "payments" },
  { href: "/insights/reports", label: "Rapor oluştur", description: "İçgörüler · hızlı işlem", icon: "insights", writeEntity: "reports" },
  { href: "/data/imports", label: "Excel yükle", description: "Veri Merkezi · hızlı işlem", icon: "data", writeEntity: "source_workbooks" },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // Faz 24B & Faz 47 (D1): the nav and quick palette actions are filtered server-side, so a module
  // or write shortcut a tier may not use is never sent to the browser at all.
  const nav = navigationFor(session.role, NAV);
  const allowedQuickActions: NavItem[] = QUICK_ACTIONS
    .filter((a) => canSeeRoute(session.role, a.href) && (!a.writeEntity || can(session.role, a.writeEntity, "insert")))
    .map((a) => ({ href: a.href, label: a.label, description: a.description, icon: a.icon }));
  const paletteItems = [...nav, ...allowedQuickActions];
  return <NavigationFeedbackProvider><div className="app-shell">
    <AppSidebar
      items={nav}
      gate={true}
      logoutAction={logoutAction}
      user={{ displayName: session.displayName, roleLabel: ROLE_LABEL[session.role] }}
    />
    <div className="workspace-shell">
      <header className="workspace-bar">
        <div><span className="workspace-product">MAS Nakit Radar</span><span className="workspace-separator">/</span><span className="workspace-context">Finans operasyon merkezi</span></div>
        <div className="workspace-status"><CommandPaletteTrigger items={paletteItems} /><span className="status-dot" /> Veriler bağlı <span className="workspace-date">Europe/Istanbul</span></div>
      </header>
      <main className="workspace-content animate-rise">
        {children}
      </main>
    </div>
    <AppToaster />
    <FlashToaster />
  </div></NavigationFeedbackProvider>;
}
