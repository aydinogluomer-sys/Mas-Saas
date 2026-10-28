"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useNavigationFeedback } from "@/components/ui/navigation-feedback";

export interface ModuleTab {
  href: string;
  label: string;
  category?: string;
  aliases?: string[];
}

export function ModuleFrame({
  title,
  description,
  tabs,
  action,
  children,
}: {
  title: string;
  description: string;
  tabs: ModuleTab[];
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { pendingHref } = useNavigationFeedback();
  const activePathname = pendingHref ? new URL(pendingHref, "http://local").pathname : pathname;

  // Extract unique categories if present
  const categories = useMemo(() => {
    const set = new Set<string>();
    tabs.forEach((t) => {
      if (t.category) set.add(t.category);
    });
    return Array.from(set);
  }, [tabs]);

  // Find active tab based on activePathname
  const activeTab = useMemo(() => {
    return tabs.find((tab) => {
      const paths = [tab.href, ...(tab.aliases ?? [])];
      return paths.some((path) => {
        if (activePathname === path) return true;
        const depth = path.split("/").filter(Boolean).length;
        return depth > 1 && activePathname.startsWith(`${path}/`);
      });
    });
  }, [tabs, activePathname]);

  // Selected category state; automatically syncs with active tab
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab?.category) {
      setSelectedCategory(activeTab.category);
    }
  }, [activePathname, activeTab]);

  const currentCategory = selectedCategory ?? activeTab?.category ?? (categories.length > 0 ? categories[0] : null);

  const visibleTabs = useMemo(() => {
    if (!currentCategory || categories.length === 0 || currentCategory === "all") {
      return tabs;
    }
    return tabs.filter((t) => !t.category || t.category === currentCategory);
  }, [tabs, currentCategory, categories]);

  return (
    <>
      <div className="module-heading">
        <div className="min-w-0">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {categories.length > 1 && (
        <div className="module-categories" role="tablist" aria-label={`${title} kategorileri`}>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={currentCategory === cat}
              onClick={() => setSelectedCategory(cat)}
              className={`category-pill ${currentCategory === cat ? "is-active" : ""}`}
            >
              {cat}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={currentCategory === "all"}
            onClick={() => setSelectedCategory("all")}
            className={`category-pill ${currentCategory === "all" ? "is-active" : ""}`}
          >
            Tümünü Göster
          </button>
        </div>
      )}

      <nav className="module-tabs" aria-label={`${title} bölümleri`}>
        {visibleTabs.map((tab) => {
          const paths = [tab.href, ...(tab.aliases ?? [])];
          const active = paths.some((path) => {
            if (activePathname === path) return true;
            const depth = path.split("/").filter(Boolean).length;
            return depth > 1 && activePathname.startsWith(`${path}/`);
          });
          // No hover/focus prefetch handlers (Wave 0): they called router.prefetch, a FULL
          // server render of the tab's page. <Link>'s default prefetch is the only one left.
          return (
            <Link
              key={`${tab.href}-${tab.label}`}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={active ? "is-active" : ""}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="module-content">{children}</div>
    </>
  );
}
