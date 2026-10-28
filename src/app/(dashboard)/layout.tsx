import type { ReactNode } from "react";
import { logoutAction } from "@/app/login/actions";
import { NavigationFeedbackProvider } from "@/components/ui/navigation-feedback";
import { AppSidebar, type NavItem } from "@/components/ui/nav";
import { CommandPalette } from "@/components/search/command-palette";
import { AppToaster, FlashToaster } from "@/components/ui/primitives/toast";
import { TooltipProvider } from "@/components/ui/primitives/tooltip";
import { CfoCopilotWidget } from "@/components/ai/cfo-copilot-widget";
import { requireSession } from "@/lib/auth";
import { canSeeRoute, navigationFor } from "@/lib/authz/matrix";
import { WORKSPACE_PRELOAD_ROUTES } from "@/lib/navigation/preload-routes";

// Financial workspaces must read current PostgreSQL data at request time.
// This also prevents production builds from opening dozens of DB-backed pages
// concurrently during static generation.
export const dynamic = "force-dynamic";

const NAV: NavItem[] = [
  { href: "/overview", label: "Genel Bakış", description: "Bugün ve öncelikler", icon: "overview", aliases: ["/"] },
  { href: "/payments", label: "Ödemeler", description: "Radar, takvim ve kalemler", icon: "payments", aliases: ["/radar", "/calendar"] },
  { href: "/cashflow", label: "Nakit Akışı", description: "Runway ve projeksiyon", icon: "cashflow" },
  { href: "/finance", label: "Finansman", description: "Çek, kredi ve vadeler", icon: "finance", aliases: ["/financing"] },
  { href: "/production", label: "Üretim", description: "Kapasite ve kârlılık", icon: "production" },
  { href: "/scenarios", label: "Senaryolar", description: "What-if ve optimizasyon", icon: "scenarios" },
  { href: "/insights/ask", label: "İçgörüler", description: "Soru, rapor ve görevler", icon: "insights", aliases: ["/insights", "/ask", "/reports", "/reminders"] },
  { href: "/data/quality", label: "Veri Merkezi", description: "Kalite, Excel ve kaynaklar", icon: "data", aliases: ["/data", "/imports", "/data-quality", "/assumptions"] },
  { href: "/system", label: "Sistem", description: "Durum, güvenlik ve denetim", icon: "system", aliases: ["/admin", "/phases"] },
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // Faz 24B: the nav is filtered server-side, so a module a tier may not use is never sent to
  // the browser at all. The pages behind it keep their own guards — this removes the dead door,
  // it does not replace the lock.
  const nav = navigationFor(session.role, NAV);
  // AÇILIŞ HAZIRLIĞI İKİYE AYRILDI — ölçülmüş bir kullanıcı engellemesi yüzünden.
  //
  // Önceden 60 rotanın tamamı tam ekran perde ARKASINDA ısıtılıyordu ve perde ~20 sn açık
  // kalıyordu; her tam reload ve her yer imi açılışında kullanıcı hiçbir şeye tıklayamıyordu.
  //
  //   primary    ana sidebar rotaları — perde YALNIZ bunları bekler (en çok 9)
  //   secondary  alt sekmeler — perde kapandıktan SONRA, boşta, tek tek ısıtılır
  //
  // Rol filtresi İKİSİNDE DE korunuyor: `navigationFor` sidebar'ı katmana göre süzer,
  // `canSeeRoute` de alt sekmeleri. Bir katmanın göremediği rota hiçbir fazda ısıtılmaz.
  const primaryRoutes = nav.map((item) => item.href);
  const secondaryRoutes = WORKSPACE_PRELOAD_ROUTES.filter(
    (href) => canSeeRoute(session.role, href) && !primaryRoutes.includes(href),
  );
  return <NavigationFeedbackProvider primaryRoutes={primaryRoutes} secondaryRoutes={secondaryRoutes}><div className="app-shell">
    <AppSidebar items={nav} gate={true} logoutAction={logoutAction} />
    <div className="workspace-shell">
      <header className="workspace-bar">
        <div><span className="workspace-product">MAS Nakit Radar</span><span className="workspace-separator">/</span><span className="workspace-context">Finans operasyon merkezi</span></div>
        <div className="workspace-status"><CommandPalette /><span className="status-dot" /> Veriler bağlı <span className="workspace-date">Europe/Istanbul</span></div>
      </header>
      <main className="workspace-content animate-rise">
        <TooltipProvider delayDuration={150}>{children}</TooltipProvider>
      </main>
    </div>
    <AppToaster />
    <FlashToaster />
    <CfoCopilotWidget />
  </div></NavigationFeedbackProvider>;
}
