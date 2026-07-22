"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { prefetchLinkHandlers, useNavigationFeedback } from "@/components/ui/navigation-feedback";

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
  return <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] shrink-0 fill-none stroke-current stroke-[1.6]">{ICONS[name]}</svg>;
}

function isActive(pathname: string, item: NavItem) {
  const paths = [item.href, ...(item.aliases ?? [])];
  return paths.some((href) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)));
}

export function AppSidebar({ items, gate, logoutAction }: { items: NavItem[]; gate: boolean; logoutAction: () => Promise<void> }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const { pendingHref, beginNavigation } = useNavigationFeedback();
  const activePathname = pendingHref ? new URL(pendingHref, "http://local").pathname : pathname;
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if (event.key === "Escape") { setPaletteOpen(false); setMobileOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    const closeForNavigation = () => { setPaletteOpen(false); setMobileOpen(false); };
    window.addEventListener("mas:navigation-start", closeForNavigation);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mas:navigation-start", closeForNavigation); };
  }, []);

  // Focus management for the palette: remember the opener, restore it on close.
  useEffect(() => {
    if (paletteOpen) restoreFocusRef.current = document.activeElement as HTMLElement;
    else restoreFocusRef.current?.focus?.();
  }, [paletteOpen]);

  // Keep Tab focus inside the open palette (the one a11y gap of the custom overlay).
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute("disabled"));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const commands = useMemo(() => [
    ...items.map((item) => ({ label: item.label, hint: item.description ?? "Çalışma alanına git", href: item.href })),
    { label: "Yeni ödeme ekle", hint: "Ödemeler", href: "/payments/new" },
    { label: "Finansal soru sor", hint: "İçgörüler", href: "/insights/ask" },
    { label: "Rapor oluştur", hint: "İçgörüler", href: "/insights/reports" },
    { label: "Excel yükle", hint: "Veri Merkezi", href: "/data/imports" },
  ].filter((item) => `${item.label} ${item.hint}`.toLocaleLowerCase("tr-TR").includes(query.toLocaleLowerCase("tr-TR"))), [items, query]);

  const navigate = (href: string) => { setPaletteOpen(false); setMobileOpen(false); setQuery(""); beginNavigation(href); window.requestAnimationFrame(() => router.push(href)); };

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
          <button className="sidebar-command" onClick={() => setPaletteOpen(true)} title="Komut menüsü">
            <span className="command-icon">⌕</span>{!collapsed && <><span>Hızlı erişim</span><kbd>Ctrl K</kbd></>}
          </button>
          {gate && <form action={logoutAction}><button type="submit" className="sidebar-command"><span className="command-icon">↪</span>{!collapsed && <span>Çıkış yap</span>}</button></form>}
          <button className="sidebar-collapse" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? "Menüyü genişlet" : "Menüyü daralt"}>{collapsed ? "›" : "‹"}</button>
        </div>
      </aside>
      {paletteOpen && (
        <div className="command-overlay" role="presentation" onMouseDown={() => setPaletteOpen(false)}>
          <div ref={dialogRef} className="command-dialog" role="dialog" aria-modal="true" aria-label="Hızlı erişim" onMouseDown={(e) => e.stopPropagation()} onKeyDown={trapFocus}>
            <div className="command-input-row"><span>⌕</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sayfa veya işlem ara…" aria-label="Komut ara" /><kbd>ESC</kbd></div>
            <div className="command-results">
              {commands.length ? commands.map((command) => <button key={`${command.href}-${command.label}`} onClick={() => navigate(command.href)}><span>{command.label}<small>{command.hint}</small></span><span aria-hidden>→</span></button>) : <div className="command-empty">Sonuç bulunamadı.</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SidebarLink({ item, active, collapsed, close }: { item: NavItem; active: boolean; collapsed: boolean; close: () => void }) {
  const { prefetch } = useNavigationFeedback();
  return <Link href={item.href} {...prefetchLinkHandlers(prefetch, item.href)} onClick={close} aria-current={active ? "page" : undefined} className={`sidebar-link ${active ? "is-active" : ""}`} title={collapsed ? item.label : undefined}><Icon name={item.icon} />{!collapsed && <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>}{active && <i aria-hidden />}</Link>;
}
