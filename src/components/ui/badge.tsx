import type { ReactNode } from "react";

/**
 * Eye-Comfort Dual-Theme Semantic Badge — calibrated for Warm Washi (#FDFBF8 / #F4F1EA)
 * and E-Ink Sage-Limestone (#F9FAF7 / #EFF0EB) surfaces with strict WCAG AA (>= 5.5:1)
 * foreground contrast, zero #FFFFFF mixes, and zero violet hue leaks.
 */
const TONES = {
  neutral: {
    bg: "var(--surface-2)",
    fg: "var(--text-2)",
    bd: "var(--line)",
  },
  blue: {
    bg: "color-mix(in srgb, var(--info) 8%, var(--surface-1))",
    fg: "var(--info)",
    bd: "color-mix(in srgb, var(--info) 22%, var(--line))",
  },
  green: {
    bg: "color-mix(in srgb, var(--pos) 8%, var(--surface-1))",
    fg: "var(--pos)",
    bd: "color-mix(in srgb, var(--pos) 24%, var(--line))",
  },
  amber: {
    bg: "color-mix(in srgb, var(--warn) 9%, var(--surface-1))",
    fg: "var(--warn)",
    bd: "color-mix(in srgb, var(--warn) 24%, var(--line))",
  },
  red: {
    bg: "color-mix(in srgb, var(--neg) 8%, var(--surface-1))",
    fg: "var(--neg)",
    bd: "color-mix(in srgb, var(--neg) 24%, var(--line))",
  },
  violet: {
    bg: "color-mix(in srgb, var(--accent) 8%, var(--surface-1))",
    fg: "var(--accent)",
    bd: "color-mix(in srgb, var(--accent) 22%, var(--line))",
  },
} as const;

export type Tone = keyof typeof TONES;

export function Badge({
  tone = "neutral",
  children,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  const c = TONES[tone];
  return (
    <span
      className="tnum inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] font-semibold leading-tight tracking-[0.01em]"
      style={{
        background: c.bg,
        color: c.fg,
        borderColor: c.bd,
        borderRadius: "var(--radius-sm)",
      }}
    >
      {dot && (
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: c.fg }}
          aria-hidden
        />
      )}
      {children}
    </span>
  );
}

export const SHEET_TYPE_TONE: Record<string, Tone> = {
  monthly_cashflow: "blue",
  payment_day_matrix: "green",
  checks: "violet",
  loan_calculation: "amber",
  capacity: "neutral",
  machine_roi: "neutral",
  cost_model_normal: "neutral",
  cost_model_overtime: "neutral",
  unknown: "red",
};

export const SEVERITY_TONE: Record<string, Tone> = {
  low: "neutral",
  medium: "amber",
  high: "red",
  critical: "red",
};

export const STATUS_TONE: Record<string, Tone> = {
  pending: "amber",
  parsed: "green",
  mapped: "blue",
  failed: "red",
  open: "amber",
  accepted: "green",
  rejected: "neutral",
  resolved: "blue",
  planned: "neutral",
  in_portfolio: "blue",
  endorsed_to_vendor: "violet",
  in_bank_collection: "blue",
  in_bank_collateral: "amber",
  issued_to_vendor: "amber",
  cleared: "green",
  bounced: "red",
  returned: "neutral",
  paid: "green",
  late: "amber",
  cancelled: "neutral",
  unknown: "amber",
};
