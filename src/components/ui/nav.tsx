"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

/** Primary nav with a clear active-route state (matches by path prefix). */
export function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1 lg:justify-end lg:pb-0" aria-label="Ana gezinme">
      {items.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link
            key={n.label}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className="shrink-0 border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors"
            style={{
              color: active ? "var(--text-1)" : "var(--text-3)",
              background: active ? "color-mix(in srgb, var(--info) 14%, var(--surface-3))" : "transparent",
              borderColor: active ? "var(--line-strong)" : "var(--line-faint)",
              borderRadius: "2px",
            }}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
