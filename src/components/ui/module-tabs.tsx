"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { prefetchLinkHandlers, useNavigationFeedback } from "@/components/ui/navigation-feedback";

export interface ModuleTab { href: string; label: string; aliases?: string[] }

export function ModuleFrame({ title, description, tabs, action, children }: { title: string; description: string; tabs: ModuleTab[]; action?: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  const { pendingHref, prefetch } = useNavigationFeedback();
  const activePathname = pendingHref ? new URL(pendingHref, "http://local").pathname : pathname;
  return <>
    <div className="module-heading">
      <div><div className="module-eyebrow">Çalışma alanı</div><h1>{title}</h1><p>{description}</p></div>
      {action && <div>{action}</div>}
    </div>
    <nav className="module-tabs" aria-label={`${title} bölümleri`}>
      {tabs.map((tab) => {
        const paths = [tab.href, ...(tab.aliases ?? [])];
        const active = paths.some((path) => {
          if (activePathname === path) return true;
          // Module roots are summary pages, not catch-all tabs. Only a concrete
          // sub-route may remain active for its own nested detail pages.
          const depth = path.split("/").filter(Boolean).length;
          return depth > 1 && activePathname.startsWith(`${path}/`);
        });
        return <Link key={`${tab.href}-${tab.label}`} href={tab.href} {...prefetchLinkHandlers(prefetch, tab.href)} aria-current={active ? "page" : undefined} className={active ? "is-active" : ""}>{tab.label}</Link>;
      })}
    </nav>
    <div className="module-content">{children}</div>
  </>;
}
