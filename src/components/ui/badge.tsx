import type { ReactNode } from "react";

const TONES = {
  neutral: "bg-zinc-800 text-zinc-300 border-zinc-700",
  blue: "bg-sky-950 text-sky-300 border-sky-800",
  green: "bg-emerald-950 text-emerald-300 border-emerald-800",
  amber: "bg-amber-950 text-amber-300 border-amber-800",
  red: "bg-red-950 text-red-300 border-red-800",
  violet: "bg-violet-950 text-violet-300 border-violet-800",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-block border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${TONES[tone]}`}>
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
