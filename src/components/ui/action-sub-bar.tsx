import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ActionSubBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
  headingAs?: "h1" | "h2";
  className?: string;
}

/**
 * Editorial Financial Cockpit — Zero-Box Inline Editorial Section Bar.
 * Eliminates duplicate boxed card headers across all 82 dashboard routes:
 * - Left: editorial serif sub-route title, concise subtitle, and volatile status pills
 * - Right: primary route CTAs & quick controls
 */
export function ActionSubBar({
  title,
  subtitle,
  meta,
  action,
  eyebrow,
  headingAs = "h2",
  className,
}: ActionSubBarProps) {
  const HeadingTag = headingAs;
  return (
    <header
      className={cn(
        "action-sub-bar flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] pb-2 pt-0.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {eyebrow && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{
              background: "var(--surface-2)",
              color: "var(--info)",
              border: "1px solid var(--line)",
            }}
          >
            {eyebrow}
          </span>
        )}
        <HeadingTag
          className="leading-snug tracking-[-0.015em]"
          style={{
            fontFamily: "var(--font-editorial)",
            fontSize: "16px",
            fontWeight: 700,
            color: "var(--text-1)",
          }}
        >
          {title}
        </HeadingTag>
        {subtitle && (
          <>
            <span aria-hidden className="hidden text-xs sm:inline" style={{ color: "var(--line-strong)" }}>
              ·
            </span>
            <div className="min-w-0 text-[12px] leading-snug text-tone-3">
              {subtitle}
            </div>
          </>
        )}
        {meta && (
          <div className="flex flex-wrap items-center gap-1.5 self-center" data-volatile>
            {meta}
          </div>
        )}
      </div>
      {action && <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">{action}</div>}
    </header>
  );
}
