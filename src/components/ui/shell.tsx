import type { ReactNode } from "react";
import { AlertTriangle, ChevronRight, Inbox, Info } from "lucide-react";
import Link from "@/components/ui/app-link";
import { ActionSubBar } from "@/components/ui/action-sub-bar";

/**
 * Splits a formatted financial string (e.g. "1.250.000 TL", "₺420.000", "14,2 gün", "%18,4")
 * so the numeric core renders at full KPI weight while the unit suffix/prefix gets subtle separation.
 * Preserves exact DOM textContent for screen readers and automated assertions.
 */
function renderValueWithUnit(value: ReactNode): ReactNode {
  if (typeof value !== "string") return value;
  const suffixMatch = /^([+-]?[\d.,\s]+)\s+(TL|TRY|USD|EUR|GBP|₺|\$|€|gün|hafta|ay|adet|puan)$/i.exec(value.trim());
  if (suffixMatch) {
    return (
      <>
        <span>{suffixMatch[1]}</span>{" "}
        <span className="font-mono text-[0.58em] font-semibold uppercase tracking-[0.04em] opacity-75">
          {suffixMatch[2]}
        </span>
      </>
    );
  }
  const prefixMatch = /^(₺|\$|€)\s*([+-]?[\d.,\s]+)$/.exec(value.trim());
  if (prefixMatch) {
    return (
      <>
        <span className="mr-0.5 font-mono text-[0.62em] font-semibold tracking-normal opacity-75">
          {prefixMatch[1]}
        </span>
        <span>{prefixMatch[2]}</span>
      </>
    );
  }
  return value;
}

/* ── PageHeader: zero-box inline Editorial ActionSubBar across all 82 dashboard routes ── */
export function PageHeader({
  title,
  subtitle,
  meta,
  action,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  actions?: ReactNode;
}) {
  return <ActionSubBar title={title} subtitle={subtitle} meta={meta} action={action ?? actions} />;
}

/* ── KpiCard: Editorial Financial Cockpit — non-truncated 2-line mono label, top semantic accent bar, 24–28px tabular KPI value ── */
export function KpiCard({
  label,
  value,
  tone = "neutral",
  badge,
  note,
  hint,
  emphasize = false,
  trend,
  href,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "neutral" | "pos" | "neg" | "warn" | "info";
  badge?: ReactNode;
  note?: ReactNode;
  hint?: ReactNode;
  emphasize?: boolean;
  trend?: ReactNode;
  href?: string;
}) {
  const effectiveNote = note ?? hint;
  const valueColor =
    tone === "neg"
      ? "var(--neg)"
      : tone === "pos"
        ? "var(--pos)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "info"
            ? "var(--info)"
            : "var(--text-1)";
  const accentBorderColor =
    tone === "neg"
      ? "var(--neg)"
      : tone === "pos"
        ? "var(--pos)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "info"
            ? "var(--info)"
            : "var(--line-strong)";

  const card = (
    <div
      className="card-hover command-surface flex h-full flex-col justify-between border p-3.5"
      style={{
        borderColor: "var(--line-card)",
        borderTop: `2px solid ${accentBorderColor}`,
        borderRadius: "var(--radius-md)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="min-w-0 line-clamp-2 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.06em]"
          style={{ color: "var(--text-3)" }}
        >
          {label}
        </span>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
      <div
        data-kpi-value=""
        className={`mt-2 font-bold leading-[1.1] tracking-[-0.03em] tabular-nums ${
          emphasize ? "text-[26px] sm:text-[28px]" : "text-[24px] sm:text-[26px]"
        }`}
        style={{ color: valueColor }}
      >
        {renderValueWithUnit(value)}
      </div>
      {(effectiveNote || trend) && (
        <div className="mt-2 flex items-end justify-between gap-2">
          {effectiveNote && (
            <div className="min-w-0 text-[11.5px] leading-snug" style={{ color: "var(--text-3)" }}>
              {effectiveNote}
            </div>
          )}
          {trend && <div className="shrink-0">{trend}</div>}
        </div>
      )}
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {card}
    </Link>
  ) : (
    card
  );
}

/** Compact key/value stat cell (denser than KpiCard) for grouped rows. */
export function StatBox({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "neg" | "pos" | "warn" }) {
  const color = tone === "neg" ? "var(--neg)" : tone === "pos" ? "var(--pos)" : tone === "warn" ? "var(--warn)" : "var(--text-1)";
  return (
    <div
      className="command-surface border p-2.5"
      style={{
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div className="line-clamp-2 font-mono text-[10.5px] font-semibold uppercase leading-snug tracking-[0.055em]" style={{ color: "var(--text-3)" }}>
        {k}
      </div>
      <div className="mt-1 text-[16.5px] font-bold tracking-[-0.02em] tabular-nums" style={{ color }}>
        {renderValueWithUnit(v)}
      </div>
    </div>
  );
}

/* ── ChartShell: Editorial serif title + warm flax-linen header band + accessible summary + empty state ── */
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
  summary?: string;
  empty?: boolean;
  children: ReactNode;
}) {
  return (
    <figure
      className="card-hover command-surface overflow-hidden border"
      style={{
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <figcaption
        className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 py-2.5"
        style={{
          background: "var(--panel-head-bg)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <span
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
        </span>
        {hint && (
          <span className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
            {hint}
          </span>
        )}
      </figcaption>
      <div className="p-3.5">
        {empty ? (
          <EmptyState>Grafik için yeterli veri yok.</EmptyState>
        ) : (
          <>
            {summary && <span className="sr-only">{summary}</span>}
            {children}
          </>
        )}
        {source && (
          <div className="mt-2.5 text-[11px]" style={{ color: "var(--text-3)" }}>
            {source}
          </div>
        )}
      </div>
    </figure>
  );
}

/* ── EmptyState: consistent, calm editorial empty message with crisp icon ── */
export function EmptyState({
  children,
  title,
  description,
  action,
}: {
  children?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-2.5 border border-dashed px-4 py-6 text-center"
      style={{
        borderColor: "var(--line-strong)",
        borderRadius: "var(--radius-md)",
        background: "color-mix(in srgb, var(--surface-2) 55%, var(--surface-1))",
      }}
    >
      <span
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border"
        style={{
          background: "var(--surface-1)",
          borderColor: "var(--line)",
          color: "var(--text-3)",
        }}
        aria-hidden
      >
        <Inbox size={16} strokeWidth={1.75} />
      </span>
      <div className="max-w-lg text-[13px] leading-relaxed" style={{ color: "var(--text-2)" }}>
        {title && (
          <div className="font-semibold" style={{ color: "var(--text-1)" }}>
            {title}
          </div>
        )}
        {description && <div className={title ? "mt-1" : undefined}>{description}</div>}
        {children}
      </div>
      {action}
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
    <Link href={href} className={`${tone === "accent" ? "button-accent" : "button-ghost"} px-3 py-1.5`}>
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
      style={{ borderRadius: "var(--radius-md)", borderLeft: "2px solid var(--info)" }}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--info)" }}>
            {eyebrow}
          </div>
          <h2 className="mt-1.5 text-lg font-bold tracking-[-0.02em]" style={{ color: "var(--text-1)" }}>
            {title}
          </h2>
          <p className="mt-1.5 max-w-3xl text-[13.5px] leading-6" style={{ color: "var(--text-2)" }}>
            {body}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <CommandLink href={primaryHref}>{primaryLabel}</CommandLink>
            {secondaryHref && secondaryLabel && (
              <CommandLink href={secondaryHref} tone="ghost">
                {secondaryLabel}
              </CommandLink>
            )}
          </div>
        </div>
        {steps && steps.length > 0 && (
          <div
            className="border-t pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0"
            style={{ borderColor: "var(--line-faint)" }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-3)" }}>
              Sıradaki adımlar
            </div>
            <ol className="mt-2 space-y-2">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-2 text-[13px]" style={{ color: "var(--text-2)" }}>
                  <span className="font-mono text-[11px] font-semibold" style={{ color: "var(--text-3)" }}>
                    {i + 1}.
                  </span>
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
    <div className="-mx-3.5 overflow-x-auto px-3.5" role="region" aria-label="veri tablosu" tabIndex={0}>
      {children}
    </div>
  );
}

/* ── KeyStat: large hero number for the Ana Ekran cockpit (26–29px bold tabular-nums) ── */
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
    tone === "neg"
      ? "var(--neg)"
      : tone === "pos"
        ? "var(--pos)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "info"
            ? "var(--info)"
            : "var(--text-1)";
  const accentBorderColor =
    tone === "neg"
      ? "var(--neg)"
      : tone === "pos"
        ? "var(--pos)"
        : tone === "warn"
          ? "var(--warn)"
          : tone === "info"
            ? "var(--info)"
            : "var(--line-strong)";
  const inner = (
    <div
      className="card-hover command-surface flex h-full flex-col justify-between border p-4"
      style={{
        borderColor: "var(--line-card)",
        borderTop: `2px solid ${accentBorderColor}`,
        borderRadius: "var(--radius-md)",
      }}
    >
      <div
        className="line-clamp-2 font-mono text-[11px] font-semibold uppercase leading-snug tracking-[0.06em]"
        style={{ color: "var(--text-3)" }}
      >
        {label}
      </div>
      <div
        data-kpi-value=""
        className="mt-2 text-[26px] font-bold leading-[1.08] tracking-[-0.03em] tabular-nums sm:text-[29px]"
        style={{ color }}
      >
        {renderValueWithUnit(value)}
      </div>
      {sub && (
        <div className="mt-2 text-[12px] leading-snug" style={{ color: "var(--text-3)" }}>
          {sub}
        </div>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
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
    <details
      open={defaultOpen}
      className="group border"
      style={{
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
        background: "var(--surface-1)",
      }}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[12px] font-semibold tracking-[-0.005em] outline-none [&::-webkit-details-marker]:hidden"
        style={{ color: "var(--text-2)" }}
      >
        <ChevronRight
          size={14}
          strokeWidth={1.75}
          className="shrink-0 transition-transform duration-75 group-open:rotate-90"
          aria-hidden
        />
        <span>{label}</span>
      </summary>
      <div className="border-t p-3" style={{ borderColor: "var(--line-faint)" }}>
        {children}
      </div>
    </details>
  );
}

/* ── Disclaimer: analytics/scenario "not accounting truth" banner ── */
export function Disclaimer({ tone = "warn", children }: { tone?: "warn" | "accent"; children: ReactNode }) {
  const color = tone === "accent" ? "var(--accent)" : "var(--warn)";
  const IconComp = tone === "accent" ? Info : AlertTriangle;
  return (
    <div
      className="flex items-start gap-2 border px-3 py-2"
      style={{
        borderColor: `color-mix(in srgb, ${color} 32%, var(--line))`,
        background: `color-mix(in srgb, ${color} 6%, var(--surface-1))`,
        borderRadius: "var(--radius-md)",
      }}
      role="note"
    >
      <IconComp size={15} strokeWidth={1.75} className="mt-0.5 shrink-0" style={{ color }} aria-hidden />
      <span className="text-[12px] font-medium leading-snug" style={{ color }}>
        {children}
      </span>
    </div>
  );
}
