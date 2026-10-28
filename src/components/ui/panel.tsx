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
        borderRadius: "var(--radius-lg)",
        borderLeft: accentColor ? `3px solid ${accentColor}` : undefined,
      }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b px-4 py-3 bg-surface-2/40"
        style={{ borderColor: "var(--line)" }}
      >
        <div className="min-w-0">
          <h2 className="truncate font-sans text-[13px] font-semibold tracking-tight" style={{ color: "var(--text-1)" }}>
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 truncate font-sans text-[11px]" style={{ color: "var(--text-3)" }}>
              {subtitle}
            </p>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className="p-4">{children}</div>
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
