import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { logoutAction } from "@/app/login/actions";
import { CommandPaletteTrigger } from "@/components/search/command-palette-trigger";
import { EntitySwitcher } from "@/components/ui/entity-switcher";
import { HeaderCollabBar, type ExecutiveLocale } from "@/components/ui/header-collab-bar";
import { NavigationFeedbackProvider, WorkspaceMainSlot } from "@/components/ui/navigation-feedback";
import { AppSidebar, type NavItem } from "@/components/ui/nav";
import { AppToaster, FlashToaster } from "@/components/ui/primitives/toast";
import { ViewComfortBar } from "@/components/ui/view-comfort-bar";
import { requireSession } from "@/lib/auth";
import { ROLE_LABEL, can, canSeeRoute, navigationFor } from "@/lib/authz/matrix";
import {
  listRecentMentionNotifications,
  resolveCommentTargetHref,
} from "@/lib/collaboration/comments";
import { getPool } from "@/lib/db";
import { getActiveEntityScope } from "@/lib/entities/engine";
import {
  buildCommandPaletteItems,
  type PaletteCommandItem,
} from "@/lib/navigation/intent-index";

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

const WRITE_ONLY_ROUTE_ENTITIES: Partial<Record<string, Parameters<typeof can>[1]>> = {
  "/payments/new": "payments",
  "/finance/checks/new": "checks",
  "/finance/loans/new": "loans",
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const pool = getPool();
  const cookieStore = await cookies();
  const locale: ExecutiveLocale =
    cookieStore.get("mas_locale")?.value === "en" ? "en" : "tr";

  const [entityScope, rawMentions] = await Promise.all([
    getActiveEntityScope(pool),
    listRecentMentionNotifications(pool, session.username, 8),
  ]);

  const mentions = rawMentions.map((m) => ({
    ...m,
    targetHref:
      m.entityTable === "control_review"
        ? "/system/controls"
        : resolveCommentTargetHref(m.entityTable, m.entityId),
  }));

  const nav = navigationFor(session.role, NAV);
  const allowedQuickActions: NavItem[] = QUICK_ACTIONS
    .filter((a) => canSeeRoute(session.role, a.href) && (!a.writeEntity || can(session.role, a.writeEntity, "insert")))
    .map((a) => ({ href: a.href, label: a.label, description: a.description, icon: a.icon }));

  const indexedRoutes = buildCommandPaletteItems(session.role).filter((item) => {
    const writeEntity = WRITE_ONLY_ROUTE_ENTITIES[item.href];
    return !writeEntity || can(session.role, writeEntity, "insert");
  });

  const seenHrefs = new Set<string>();
  const paletteItems: Array<NavItem & Partial<PaletteCommandItem>> = [];
  for (const item of [...indexedRoutes, ...allowedQuickActions, ...nav]) {
    if (seenHrefs.has(item.href)) continue;
    seenHrefs.add(item.href);
    paletteItems.push(item);
  }

  return (
    <NavigationFeedbackProvider>
      <div className="app-shell">
        <AppSidebar
          items={nav}
          gate={true}
          logoutAction={logoutAction}
          user={{ displayName: session.displayName, roleLabel: ROLE_LABEL[session.role] }}
        />
        <div className="workspace-shell">
          <header className="workspace-bar">
            <div className="flex min-w-0 items-center gap-2">
              <EntitySwitcher scope={entityScope} />
            </div>
            <div className="workspace-status">
              <CommandPaletteTrigger items={paletteItems} />
              <ViewComfortBar />
              <HeaderCollabBar mentions={mentions} locale={locale} />
              <span
                className="hidden 2xl:inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-1 px-2.5 py-1 font-mono text-[10.5px] font-medium text-tone-2"
              >
                <span className="status-dot" />
                <span>{locale === "en" ? "Live" : "Canlı"}</span>
              </span>
            </div>
          </header>
          <main className="workspace-content animate-rise">
            <WorkspaceMainSlot>{children}</WorkspaceMainSlot>
          </main>
        </div>
        <AppToaster />
        <FlashToaster />
      </div>
    </NavigationFeedbackProvider>
  );
}
