import type { ReactNode } from "react";

// Tone → token-based colors. Tuned for WCAG AA text contrast on dark surfaces.
const TONES = {
  neutral: { bg: "#1c1c20", fg: "#c4c4cb", bd: "#33333a" },
  blue: { bg: "#0f2233", fg: "#9ecbec", bd: "#1e4a6b" },
  green: { bg: "#0c2a20", fg: "#4ade80", bd: "#155e45" },
  amber: { bg: "#2a2109", fg: "#fbbf24", bd: "#5a4712" },
  red: { bg: "#2c1315", fg: "#f87171", bd: "#5c1f24" },
  violet: { bg: "#1e1735", fg: "#c4b5fd", bd: "#3b2f66" },
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
      style={{ background: c.bg, color: c.fg, borderColor: c.bd, borderRadius: "2px" }}
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
