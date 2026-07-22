import type { ReactNode } from "react";

// Tone → token-derived colors (color-mix over the global palette), so badge
// tints track the design tokens. Tuned for WCAG AA text contrast on dark surfaces.
const mix = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
const TONES = {
  neutral: { bg: mix("--surface-3", 85), fg: "var(--text-2)", bd: "var(--line-strong)" },
  blue: { bg: mix("--info", 12), fg: "color-mix(in srgb, var(--info) 82%, white)", bd: mix("--info", 40) },
  green: { bg: mix("--pos", 11), fg: "var(--pos)", bd: mix("--pos", 38) },
  amber: { bg: mix("--warn", 10), fg: "var(--warn)", bd: mix("--warn", 38) },
  red: { bg: mix("--neg", 11), fg: "var(--neg)", bd: mix("--neg", 38) },
  violet: { bg: mix("--accent", 13), fg: "color-mix(in srgb, var(--accent) 82%, white)", bd: mix("--accent", 40) },
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
      className="inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none tracking-wider"
      style={{ background: c.bg, color: c.fg, borderColor: c.bd, borderRadius: "var(--radius-sm)" }}
    >
      {dot && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: c.fg }} aria-hidden />}
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
  low: "neutral", medium: "amber", high: "red", critical: "red",
};
export const STATUS_TONE: Record<string, Tone> = {
  pending: "amber", parsed: "green", mapped: "blue", failed: "red",
  open: "amber", accepted: "green", rejected: "neutral", resolved: "blue",
};
