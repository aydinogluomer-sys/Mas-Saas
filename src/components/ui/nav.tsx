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
    <nav className="flex flex-wrap gap-1" aria-label="Ana gezinme">
      {items.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link
            key={n.label}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors"
            style={{
              color: active ? "var(--text-1)" : "var(--text-3)",
              background: active ? "var(--surface-3)" : "transparent",
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
