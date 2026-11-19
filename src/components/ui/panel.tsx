import type { ReactNode } from "react";

/**
 * Section panel — Editorial Precision v2 primary paper container.
 * Backward-compatible API ({title, right, children}) plus optional subtitle/accent.
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
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
        borderLeft: accentColor ? `2px solid ${accentColor}` : undefined,
      }}
    >
      <header
        className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
        style={{
          background: "var(--panel-head-bg)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="min-w-0 flex-1">
          <h2
            className="leading-snug"
            style={{
              fontFamily: "var(--font-editorial)",
              fontSize: "15.5px",
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: "var(--text-1)",
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <div className="mt-0.5 text-[11.5px] leading-snug" style={{ color: "var(--text-3)" }}>
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function Num({ children }: { children: ReactNode }) {
  return <span className="tabular-nums font-medium">{children}</span>;
}

/** Turkish-locale currency; null is disclosed as "TUTAR EKSİK", never rendered as 0. */
export function fmtTL(n: number | null | undefined): string {
  if (n == null) return "TUTAR EKSİK";
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";
}
