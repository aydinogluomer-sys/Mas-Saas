export type ExternalAssumptionType =
  | "interest_rate"
  | "fx_rate"
  | "inflation_rate"
  | "personnel_cost"
  | "energy_cost"
  | "loan_rate"
  | "other";

export type ExternalSourceKind = "manual" | "imported" | "internet";
export type ExternalReviewStatus = "pending_review" | "approved" | "rejected";

const TYPES: ExternalAssumptionType[] = [
  "interest_rate",
  "fx_rate",
  "inflation_rate",
  "personnel_cost",
  "energy_cost",
  "loan_rate",
  "other",
];
const SOURCE_KINDS: ExternalSourceKind[] = ["manual", "imported", "internet"];
const REVIEW_STATUSES: ExternalReviewStatus[] = ["pending_review", "approved", "rejected"];

export function normalizeAssumptionType(raw: string): ExternalAssumptionType {
  return TYPES.includes(raw as ExternalAssumptionType) ? (raw as ExternalAssumptionType) : "other";
}

export function normalizeSourceKind(raw: string): ExternalSourceKind {
  return SOURCE_KINDS.includes(raw as ExternalSourceKind) ? (raw as ExternalSourceKind) : "manual";
}

export function normalizeReviewStatus(raw: string): ExternalReviewStatus | null {
  return REVIEW_STATUSES.includes(raw as ExternalReviewStatus) ? (raw as ExternalReviewStatus) : null;
}

export function defaultReviewStatus(sourceKind: ExternalSourceKind): ExternalReviewStatus {
  return sourceKind === "internet" ? "pending_review" : "approved";
}

export function sourceLabel(sourceName: string, sourceDate: string): string {
  return `${sourceName} / ${sourceDate}`;
}
