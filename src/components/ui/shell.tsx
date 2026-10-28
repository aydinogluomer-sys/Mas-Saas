import type { ReactNode } from "react";
import Link from "next/link";

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
    <header className="flex flex-wrap items-end justify-between gap-3 border-b pb-4" style={{ borderColor: "var(--line)" }}>
      <div className="min-w-0">
        <h1 className="font-sans text-xl font-bold tracking-tight" style={{ color: "var(--text-1)" }}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 font-sans text-xs leading-relaxed" style={{ color: "var(--text-3)" }}>
            {subtitle}
          </p>
        )}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2" data-volatile>{meta}</div>}
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
      className="card-hover border p-3.5 bg-surface-1"
      style={{ borderColor: "var(--line)", borderRadius: "var(--radius-lg)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-sans text-[11px] font-medium tracking-normal" style={{ color: "var(--text-3)" }}>
          {label}
        </span>
        {badge}
      </div>
      <div
        className={`mt-1.5 font-sans font-bold tabular-nums ${emphasize ? "text-xl" : "text-base"}`}
        style={{ color: valueColor }}
      >
        {value}
      </div>
      {note && <div className="mt-1 font-sans text-[10px]" style={{ color: "var(--text-4)" }}>{note}</div>}
    </div>
  );
}

/** Compact key/value stat cell (denser than KpiCard) for grouped rows. */
export function StatBox({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "neg" | "pos" | "warn" }) {
  const color = tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : "var(--text-1)";
  return (
    <div className="border p-2.5 bg-surface-2/60" style={{ borderColor: "var(--line)", borderRadius: "var(--radius-md)" }}>
      <div className="font-sans text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{k}</div>
      <div className="mt-0.5 font-sans font-semibold text-sm tabular-nums" style={{ color }}>{v}</div>
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
      className="border p-4 bg-surface-1"
      style={{ borderColor: "var(--line)", borderRadius: "var(--radius-lg)" }}
    >
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-sans text-xs font-semibold tracking-tight" style={{ color: "var(--text-2)" }}>{title}</span>
        {hint && <span className="font-sans text-[11px]" style={{ color: "var(--text-4)" }}>{hint}</span>}
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

/* ── EmptyState: consistent, calm modern empty message ── */
export function EmptyState({
  children,
  action,
  title,
}: {
  children: ReactNode;
  action?: ReactNode;
  title?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-xl border border-line bg-surface-2/40 px-6 py-9 text-center"
      style={{ borderRadius: "var(--radius-lg)" }}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3 text-tone-3 mb-2.5 border border-line">
        <svg className="h-5 w-5 stroke-current stroke-1.5 fill-none" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
        </svg>
      </div>
      {title && <h3 className="font-sans text-sm font-semibold text-tone-1">{title}</h3>}
      <p className="max-w-md font-sans text-xs text-tone-3 leading-relaxed mt-0.5">
        {children}
      </p>
      {action && <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function CommandLink({
  href,
  children,
  tone = "accent",
}: {
  href: string;
  children: ReactNode;
  tone?: "accent" | "ghost";
}) {
  return (
    <Link href={href} className={`${tone === "accent" ? "button-accent" : "button-ghost"} px-3 py-2`}>
      {children}
    </Link>
  );
}

export function ModuleEmptyState({
  eyebrow,
  title,
  body,
  primaryHref,
  primaryLabel,
  secondaryHref,
  secondaryLabel,
  steps,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  body: ReactNode;
  primaryHref: string;
  primaryLabel: ReactNode;
  secondaryHref?: string;
  secondaryLabel?: ReactNode;
  steps?: ReactNode[];
}) {
  return (
    <section
      className="command-surface border p-4"
      style={{ borderRadius: "var(--radius)", borderLeft: "2px solid var(--info)" }}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>
            {eyebrow}
          </div>
          <h2 className="mt-2 text-lg font-semibold" style={{ color: "var(--text-1)" }}>
            {title}
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--text-2)" }}>
            {body}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <CommandLink href={primaryHref}>{primaryLabel}</CommandLink>
            {secondaryHref && secondaryLabel && <CommandLink href={secondaryHref} tone="ghost">{secondaryLabel}</CommandLink>}
          </div>
        </div>
        {steps && steps.length > 0 && (
          <div
            className="border-t pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
            style={{ borderColor: "var(--line-faint)" }}
          >
            <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>
              Siradaki adimlar
            </div>
            <ol className="mt-2 space-y-2">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-2 text-sm" style={{ color: "var(--text-2)" }}>
                  <span className="font-mono text-[11px]" style={{ color: "var(--text-4)" }}>{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
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
