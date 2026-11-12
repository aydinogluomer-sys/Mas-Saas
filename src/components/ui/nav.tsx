"use client";

import Link from "@/components/ui/app-link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigationFeedback } from "@/components/ui/navigation-feedback";

export interface NavItem {
  href: string;
  label: string;
  description?: string;
  aliases?: string[];
  icon: "overview" | "payments" | "cashflow" | "finance" | "production" | "scenarios" | "insights" | "data" | "system";
}

const ICONS: Record<NavItem["icon"], ReactNode> = {
  overview: <path d="M4 13h6V4H4v9Zm10 7h6V11h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" />,
  payments: <path d="M4 6h16v12H4V6Zm0 4h16M8 14h3" />,
  cashflow: <path d="M4 17 9 12l4 3 7-9M16 6h4v4" />,
  finance: <path d="M3 9h18M5 9v9m4-9v9m6-9v9m4-9v9M3 18h18M12 4l9 5H3l9-5Z" />,
  production: <path d="M4 20V9l5 3V8l5 3V4h6v16H4Zm4-4h2m4 0h2" />,
  scenarios: <path d="M5 19V5m0 7h5l3-5 3 10 3-5" />,
  insights: <path d="M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0c-1 .7-1 1.5-1 2H9c0-.5 0-1.3-1-2Z" />,
  data: <path d="M4 6c0-2 16-2 16 0v12c0 2-16 2-16 0V6Zm0 0c0 2 16 2 16 0m-16 6c0 2 16 2 16 0" />,
  system: <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12v2m0 13v2m8.5-8.5h-2m-13 0h-2m15.4-6.4-1.5 1.5M6.6 17.4l-1.5 1.5m13.8 0-1.5-1.5M6.6 6.6 5.1 5.1" />,
};

function Icon({ name }: { name: NavItem["icon"] }) {
  return <svg viewBox="0 0 24 24" aria-hidden className="h-4.5 w-4.5 shrink-0 fill-none stroke-current stroke-[1.6]">{ICONS[name]}</svg>;
}

function isActive(pathname: string, item: NavItem) {
  const paths = [item.href, ...(item.aliases ?? [])];
  return paths.some((href) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)));
}

export function openCanonicalCommandPalette(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("mas:open-command-palette"));
  }
}

export function AppSidebar({ items, gate, logoutAction }: { items: NavItem[]; gate: boolean; logoutAction: () => Promise<void> }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pendingHref } = useNavigationFeedback();
  const activePathname = pendingHref ? new URL(pendingHref, "http://local").pathname : pathname;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    const closeForNavigation = () => setMobileOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mas:navigation-start", closeForNavigation);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mas:navigation-start", closeForNavigation);
    };
  }, []);

  return (
    <>
      <button className="mobile-menu-button" onClick={() => setMobileOpen(true)} aria-label="Ana menüyü aç">☰</button>
      {mobileOpen && <button className="sidebar-scrim" aria-label="Menüyü kapat" onClick={() => setMobileOpen(false)} />}
      <aside className={`app-sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden>MR</div>
          {!collapsed && <div><div className="brand-title">MAS Nakit Radar</div><div className="brand-subtitle">Finans operasyon merkezi</div></div>}
        </div>
        <nav className="sidebar-nav" aria-label="Ana çalışma alanları">
          <div className="sidebar-section-label">{collapsed ? "" : "Çalışma alanları"}</div>
          {items.slice(0, 6).map((item) => <SidebarLink key={item.href} item={item} active={isActive(activePathname, item)} collapsed={collapsed} close={() => setMobileOpen(false)} />)}
          <div className="sidebar-section-label sidebar-section-break">{collapsed ? "" : "Destek ve yönetim"}</div>
          {items.slice(6).map((item) => <SidebarLink key={item.href} item={item} active={isActive(activePathname, item)} collapsed={collapsed} close={() => setMobileOpen(false)} />)}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-command"
            onClick={openCanonicalCommandPalette}
            title="Komut menüsü"
          >
            <span className="command-icon">⌕</span>{!collapsed && <><span>Hızlı erişim</span><kbd>Ctrl K</kbd></>}
          </button>
          {gate && <form action={logoutAction}><button type="submit" className="sidebar-command"><span className="command-icon">↪</span>{!collapsed && <span>Çıkış yap</span>}</button></form>}
          <button className="sidebar-collapse" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? "Menüyü genişlet" : "Menüyü daralt"}>{collapsed ? "›" : "‹"}</button>
        </div>
      </aside>
    </>
  );
}

// No hover/focus prefetch handlers (Wave 0): they called router.prefetch, a FULL server render of
// the target page. <Link>'s own default prefetch is the only one left — see NavigationFeedbackProvider.
function SidebarLink({ item, active, collapsed, close }: { item: NavItem; active: boolean; collapsed: boolean; close: () => void }) {
  return <Link href={item.href} onClick={close} aria-current={active ? "page" : undefined} className={`sidebar-link ${active ? "is-active" : ""}`} title={collapsed ? item.label : undefined}><Icon name={item.icon} />{!collapsed && <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>}{active && <i aria-hidden />}</Link>;
}
