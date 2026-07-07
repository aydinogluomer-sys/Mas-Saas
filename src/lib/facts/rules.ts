export type FactSeverity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<FactSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function countSeverity(count: number, highAt: number, criticalAt: number): FactSeverity {
  if (count >= criticalAt) return "critical";
  if (count >= highAt) return "high";
  if (count > 0) return "medium";
  return "low";
}

export function ratioSeverity(ratio: number | null, highAt: number, criticalAt: number): FactSeverity {
  if (ratio == null) return "low";
  if (ratio >= criticalAt) return "critical";
  if (ratio >= highAt) return "high";
  if (ratio > 0) return "medium";
  return "low";
}

export function hasRiskSeverity(hasRisk: boolean, severity: FactSeverity = "high"): FactSeverity {
  return hasRisk ? severity : "low";
}

export function sortBySeverity<T extends { severity: FactSeverity }>(items: T[]): T[] {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
