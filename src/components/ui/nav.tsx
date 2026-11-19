"use client";

import Link from "@/components/ui/app-link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Database,
  Factory,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { useNavigationFeedback } from "@/components/ui/navigation-feedback";

export interface NavItem {
  href: string;
  label: string;
  description?: string;
  aliases?: string[];
  icon: "overview" | "payments" | "cashflow" | "finance" | "production" | "scenarios" | "insights" | "data" | "system";
}

const ICON_COMPONENTS: Record<NavItem["icon"], ComponentType<{ size?: number; strokeWidth?: number; className?: string }>> = {
  overview: LayoutDashboard,
  payments: CreditCard,
  cashflow: TrendingUp,
  finance: Landmark,
  production: Factory,
  scenarios: SlidersHorizontal,
  insights: Sparkles,
  data: Database,
  system: ShieldCheck,
};

function Icon({ name }: { name: NavItem["icon"] }) {
  const LucideIcon = ICON_COMPONENTS[name];
  return <LucideIcon size={16} strokeWidth={1.75} className="shrink-0" aria-hidden />;
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

export interface SidebarUserSummary {
  displayName: string;
  roleLabel: string;
}

export function AppSidebar({
  items,
  gate = true,
  logoutAction,
  user,
}: {
  items: NavItem[];
  gate?: boolean;
  logoutAction: () => Promise<void>;
  user?: SidebarUserSummary;
}) {
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
      <button className="mobile-menu-button" onClick={() => setMobileOpen(true)} aria-label="Ana menüyü aç">
        <Menu size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {mobileOpen && <button className="sidebar-scrim" aria-label="Menüyü kapat" onClick={() => setMobileOpen(false)} />}
      <aside className={`app-sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden>
            MR
          </div>
          {!collapsed && (
            <div>
              <div className="brand-title">MAS Nakit Radar</div>
              <div className="brand-subtitle">Finans operasyon merkezi</div>
            </div>
          )}
        </div>
        <nav className="sidebar-nav" aria-label="Ana çalışma alanları">
          {items.slice(0, 3).length > 0 && (
            <>
              {!collapsed && <div className="sidebar-section-label">01 · Günlük Nakit & İcra</div>}
              {items.slice(0, 3).map((item) => (
                <SidebarLink
                  key={item.href}
                  item={item}
                  active={isActive(activePathname, item)}
                  collapsed={collapsed}
                  close={() => setMobileOpen(false)}
                />
              ))}
            </>
          )}
          {items.slice(3, 6).length > 0 && (
            <>
              {!collapsed && (
                <div className="sidebar-section-label sidebar-section-break">
                  02 · Bilanço, Üretim & Stres
                </div>
              )}
              {items.slice(3, 6).map((item) => (
                <SidebarLink
                  key={item.href}
                  item={item}
                  active={isActive(activePathname, item)}
                  collapsed={collapsed}
                  close={() => setMobileOpen(false)}
                />
              ))}
            </>
          )}
          {items.slice(6).length > 0 && (
            <>
              {!collapsed && (
                <div className="sidebar-section-label sidebar-section-break">
                  03 · Zeka, Veri & Denetim
                </div>
              )}
              {items.slice(6).map((item) => (
                <SidebarLink
                  key={item.href}
                  item={item}
                  active={isActive(activePathname, item)}
                  collapsed={collapsed}
                  close={() => setMobileOpen(false)}
                />
              ))}
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          {user && !collapsed && (
            <div
              className="mb-1 flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11.5px]"
              data-testid="sidebar-active-user"
            >
              <span
                className="truncate font-semibold"
                style={{ color: "var(--sidebar-text)" }}
                title={user.displayName}
              >
                {user.displayName}
              </span>
              <span
                className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium"
                style={{
                  borderColor: "var(--sidebar-border)",
                  background: "var(--sidebar-bg-2)",
                  color: "var(--sidebar-brass)",
                }}
              >
                {user.roleLabel}
              </span>
            </div>
          )}
          <button
            type="button"
            className="sidebar-command"
            onClick={openCanonicalCommandPalette}
            title="Komut menüsü"
          >
            <span className="command-icon">
              <Search size={15} strokeWidth={1.75} aria-hidden />
            </span>
            {!collapsed && (
              <>
                <span>Hızlı erişim</span>
                <kbd>Ctrl K</kbd>
              </>
            )}
          </button>
          {gate && (
            <form action={logoutAction}>
              <button
                type="submit"
                className="sidebar-command"
                title="Çıkış yap"
                aria-label={collapsed ? "Çıkış yap" : undefined}
              >
                <span className="command-icon">
                  <LogOut size={15} strokeWidth={1.75} aria-hidden />
                </span>
                {!collapsed && <span>Çıkış yap</span>}
              </button>
            </form>
          )}
          <button
            className="sidebar-collapse"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Menüyü genişlet" : "Menüyü daralt"}
          >
            {collapsed ? (
              <ChevronRight size={15} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronLeft size={15} strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarLink({
  item,
  active,
  collapsed,
  close,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  close: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={close}
      aria-current={active ? "page" : undefined}
      className={`sidebar-link ${active ? "is-active" : ""}`}
      title={collapsed ? item.label : undefined}
    >
      <Icon name={item.icon} />
      {!collapsed && (
        <span>
          <strong>{item.label}</strong>
          {item.description && <small>{item.description}</small>}
        </span>
      )}
      {active && <i aria-hidden />}
    </Link>
  );
}
