import type { ReactNode } from "react";

/* ── PageHeader: title + subtitle + meta + primary action, consistent per route ── */
export function PageHeader({
  title,
  subtitle,
  meta,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-3" style={{ borderColor: "var(--line)" }}>
      <div className="min-w-0">
        <h1 className="font-mono text-base font-semibold tracking-[0.08em]" style={{ color: "var(--text-1)" }}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
            {subtitle}
          </p>
        )}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-2" data-volatile>{meta}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

/* ── KpiCard: label · value · optional delta/badge/note. Financial sign is clear. ── */
export function KpiCard({
  label,
  value,
  tone = "neutral",
  badge,
  note,
  emphasize = false,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn" | "info";
  badge?: ReactNode;
  note?: ReactNode;
  emphasize?: boolean;
}) {
  const valueColor =
    tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : tone === "info" ? "var(--info)" : "var(--text-1)";
  return (
    <div
      className="card-hover border p-2.5"
      style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[9px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>
          {label}
        </span>
        {badge}
      </div>
      <div
        className={`mt-1 font-mono tabular-nums ${emphasize ? "text-lg" : "text-sm"}`}
        style={{ color: valueColor }}
      >
        {value}
      </div>
      {note && <div className="mt-0.5 font-mono text-[9px]" style={{ color: "var(--text-4)" }}>{note}</div>}
    </div>
  );
}

/** Compact key/value stat cell (denser than KpiCard) for grouped rows. */
export function StatBox({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "neg" | "pos" | "warn" }) {
  const color = tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : "var(--text-1)";
  return (
    <div className="border p-2" style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)" }}>
      <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{k}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums" style={{ color }}>{v}</div>
    </div>
  );
}

/* ── ChartShell: title + hint + source + accessible summary + empty state ── */
export function ChartShell({
  title,
  hint,
  source,
  summary,
  empty,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  source?: ReactNode;
  summary?: string; // screen-reader text description of the chart data
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <figure
      className="border p-3"
      style={{ background: "var(--surface-1)", borderColor: "var(--line)", borderRadius: "var(--radius)" }}
    >
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text-2)" }}>{title}</span>
        {hint && <span className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{hint}</span>}
      </figcaption>
      {empty ? (
        <EmptyState>Grafik için yeterli veri yok.</EmptyState>
      ) : (
        <>
          {summary && <span className="sr-only">{summary}</span>}
          {children}
        </>
      )}
      {source && <div className="mt-2 font-mono text-[9px]" style={{ color: "var(--text-4)" }}>{source}</div>}
    </figure>
  );
}

/* ── EmptyState: consistent, calm empty message ── */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      className="flex flex-col items-center gap-2 border border-dashed px-4 py-6 text-center"
      style={{ borderColor: "var(--line)", borderRadius: "var(--radius)" }}
    >
      <p className="font-mono text-xs" style={{ color: "var(--text-3)" }}>{children}</p>
      {action}
    </div>
  );
}

/* ── TableShell: horizontal-scroll wrapper with a clear affordance on overflow ── */
export function TableShell({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-3 overflow-x-auto px-3" role="region" aria-label="veri tablosu" tabIndex={0}>
      {children}
    </div>
  );
}

/* ── KeyStat: large hero number for the Ana Ekran cockpit (decision-first) ── */
export function KeyStat({
  label,
  value,
  tone = "neutral",
  sub,
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn" | "info";
  sub?: ReactNode;
  href?: string;
}) {
  const color =
    tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : tone === "info" ? "var(--info)" : "var(--text-1)";
  const inner = (
    <div
      className="card-hover flex h-full flex-col justify-between border p-3"
      style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius)" }}
    >
      <div className="text-[11px]" style={{ color: "var(--text-3)" }}>{label}</div>
      <div className="mt-2 font-mono text-2xl leading-none tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="mt-1.5 text-[11px]" style={{ color: "var(--text-4)" }}>{sub}</div>}
    </div>
  );
  return href ? <a href={href} className="block">{inner}</a> : inner;
}

/* ── DetailsDisclosure: native, accessible, JS-free collapse for technical detail ── */
export function DetailsDisclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group border" style={{ borderColor: "var(--line-faint)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
      <summary
        className="cursor-pointer list-none px-3 py-2 text-[11px] uppercase tracking-[0.12em] outline-none [&::-webkit-details-marker]:hidden"
        style={{ color: "var(--text-3)" }}
      >
        <span className="mr-1 inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
        {label}
      </summary>
      <div className="border-t p-3" style={{ borderColor: "var(--line-faint)" }}>{children}</div>
    </details>
  );
}

/* ── Disclaimer: analytics/scenario "not accounting truth" banner ── */
export function Disclaimer({ tone = "warn", children }: { tone?: "warn" | "accent"; children: ReactNode }) {
  const color = tone === "accent" ? "var(--accent)" : "var(--warn)";
  return (
    <div
      className="border px-3 py-2"
      style={{ borderColor: color, background: `color-mix(in srgb, ${color} 8%, transparent)`, borderRadius: "var(--radius)" }}
      role="note"
    >
      <span className="font-mono text-[11px] uppercase tracking-wider" style={{ color }}>{children}</span>
    </div>
  );
}
