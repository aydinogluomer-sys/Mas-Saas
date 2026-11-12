"use client";

import Link from "@/components/ui/app-link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useNavigationFeedback } from "@/components/ui/navigation-feedback";
import { resolveModuleFraming } from "@/lib/navigation/module-framing";

export interface ModuleTab {
  href: string;
  label: string;
  aliases?: string[];
  group?: string;
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

  const isTabActive = (tab: ModuleTab) => {
    const paths = [tab.href, ...(tab.aliases ?? [])];
    return paths.some((path) => {
      if (activePathname === path) return true;
      const depth = path.split("/").filter(Boolean).length;
      return depth > 1 && activePathname.startsWith(`${path}/`);
    });
  };

  const hasGroups = tabs.some((tab) => Boolean(tab.group));
  const groupedTabs: Array<{ group: string; items: ModuleTab[] }> = [];
  if (hasGroups) {
    for (const tab of tabs) {
      const groupName = tab.group ?? "Diğer";
      let bucket = groupedTabs.find((g) => g.group === groupName);
      if (!bucket) {
        bucket = { group: groupName, items: [] };
        groupedTabs.push(bucket);
      }
      bucket.items.push(tab);
    }
  }

  const framing = resolveModuleFraming({
    pathname: activePathname,
    primaryTabHref: tabs[0]?.href,
    title,
  });

  return (
    <>
      <div className="module-heading" data-module-key={framing.key}>
        <div className="module-art-vignette" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={framing.artworkSrc}
            alt=""
            aria-hidden="true"
            loading="eager"
            decoding="async"
          />
        </div>
        <div className="module-heading-copy">
          <div className="module-eyebrow">
            {framing.folioCode} · {framing.eyebrow}
          </div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {action && <div className="module-heading-action">{action}</div>}
      </div>
      {hasGroups ? (
        <nav className="module-tabs module-tabs-grouped" aria-label={`${title} bölümleri`}>
          {groupedTabs.map((section) => (
            <div key={section.group} className="module-tab-group" role="group" aria-label={section.group}>
              <span className="module-tab-group-label">{section.group}</span>
              <div className="module-tab-group-links">
                {section.items.map((tab) => {
                  const active = isTabActive(tab);
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
              </div>
            </div>
          ))}
        </nav>
      ) : (
        <nav className="module-tabs" aria-label={`${title} bölümleri`}>
          {tabs.map((tab) => {
            const active = isTabActive(tab);
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
      )}
      <div className="module-content">{children}</div>
    </>
  );
}
