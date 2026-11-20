"use client";

import Link from "@/components/ui/app-link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  const activePathname = pendingHref
    ? new URL(pendingHref, "http://local").pathname
    : pathname;

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const drawerRef = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    setSelectedGroup(null);
    if (drawerRef.current?.open) {
      drawerRef.current.open = false;
    }
  }, [activePathname]);

  const matchLength = (tab: ModuleTab) => {
    const paths = [tab.href, ...(tab.aliases ?? [])];
    let best = 0;
    for (const path of paths) {
      if (activePathname === path || activePathname.startsWith(`${path}/`)) {
        if (path.length > best) best = path.length;
      }
    }
    return best;
  };

  const longestMatch = Math.max(0, ...tabs.map((tab) => matchLength(tab)));
  const isTabActive = (tab: ModuleTab) =>
    longestMatch > 0 && matchLength(tab) === longestMatch;

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

  const activeGroup =
    groupedTabs.find((section) => section.items.some((tab) => isTabActive(tab)))
      ?.group ??
    groupedTabs[0]?.group ??
    null;

  const displayedGroup =
    selectedGroup && groupedTabs.some((g) => g.group === selectedGroup)
      ? selectedGroup
      : activeGroup;

  const framing = resolveModuleFraming({
    pathname: activePathname,
    primaryTabHref: tabs[0]?.href,
    title,
  });

  return (
    <>
      <section
        className="module-masthead folio-corner-mark"
        data-module-key={framing.key}
      >
        <div className="module-heading">
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
          <div className="module-stage-shell">
            {/* Tier 1: Segmented workflow stage pills (<= 4 stages) + compact all-routes drawer */}
            <div className="module-stage-toprow">
              <div className="module-stage-track" aria-label={`${title} aşamaları`}>
                {groupedTabs.map((section) => {
                  const isSelected = displayedGroup === section.group;
                  const hasCurrent = activeGroup === section.group;
                  return (
                    <button
                      key={section.group}
                      type="button"
                      onClick={() => setSelectedGroup(section.group)}
                      aria-pressed={isSelected}
                      className={`module-stage-pill ${isSelected ? "is-active" : ""} ${hasCurrent ? "has-current-route" : ""}`}
                    >
                      <span>{section.group}</span>
                      <span className="module-stage-count tnum">
                        {section.items.length}
                      </span>
                    </button>
                  );
                })}
              </div>

              <details
                ref={drawerRef}
                role="region"
                aria-label={`${title} tüm ekranlar dizini`}
                className="module-all-routes-drawer"
              >
                <summary className="module-all-routes-summary tnum">
                  Tüm ekranlar ({tabs.length})
                </summary>
                <div className="module-all-routes-popover">
                  {groupedTabs.map((section) => (
                    <div key={section.group} className="module-all-routes-col">
                      <span className="module-tab-group-label">{section.group}</span>
                      <div className="module-all-routes-links">
                        {section.items.map((tab) => {
                          const active = isTabActive(tab);
                          return (
                            <Link
                              key={`all-${tab.href}-${tab.label}`}
                              href={tab.href}
                              onClick={() => {
                                if (drawerRef.current) drawerRef.current.open = false;
                              }}
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
                </div>
              </details>
            </div>

            {/* Tier 2: Crisp horizontal ledger sub-tabs for the selected stage */}
            <nav
              className="module-tabs module-tabs-grouped module-stage-subnav"
              aria-label={`${title} bölümleri`}
            >
              {groupedTabs.map((section) => {
                const isVisible = displayedGroup === section.group;
                return (
                  <div
                    key={section.group}
                    role="group"
                    aria-label={section.group}
                    className={`module-stage-subtabs ${isVisible ? "is-visible" : "is-collapsed"}`}
                  >
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
                );
              })}
            </nav>
          </div>
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
      </section>

      <div className="module-content">{children}</div>
    </>
  );
}
