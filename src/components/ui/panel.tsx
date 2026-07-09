import type { ReactNode } from "react";

/**
 * Section panel — the primary content container. Backward-compatible API
 * ({title, right, children}) plus optional subtitle/accent for hierarchy.
 */
export function Panel({
  title,
  right,
  subtitle,
  accent,
  children,
  className = "",
}: {
  title: ReactNode;
  right?: ReactNode;
  subtitle?: ReactNode;
  accent?: "pos" | "neg" | "warn" | "info" | "accent";
  children: ReactNode;
  className?: string;
}) {
  const accentColor = accent ? `var(--${accent === "accent" ? "accent" : accent})` : undefined;
  return (
    <section
      className={`card-hover command-surface overflow-hidden border ${className}`}
      style={{
        borderColor: "var(--line)",
        borderRadius: "var(--radius)",
        borderLeft: accentColor ? `2px solid ${accentColor}` : undefined,
      }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--line-faint)" }}
      >
        <div className="min-w-0">
          <h2 className="truncate font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text-2)" }}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 truncate font-mono text-[10px]" style={{ color: "var(--text-4)" }}>
              {subtitle}
            </p>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono tabular-nums">{children}</span>;
}

/** Turkish-locale currency; null is disclosed as "TUTAR EKSİK", never rendered as 0. */
export function fmtTL(n: number | null | undefined): string {
  if (n == null) return "TUTAR EKSİK";
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";
}
