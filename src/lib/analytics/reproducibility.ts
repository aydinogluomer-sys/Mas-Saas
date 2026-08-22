// Faz 34 — the reproducibility stamp.
//
// Every analysis result carries one. It answers the only question that matters when somebody
// disputes a number six months later: WHAT exactly was this computed from, and BY WHICH version
// of the formula?
//
// The stamp is data, not prose, so it can be stored in `metric_snapshots.meta` (Faz 17) and
// compared mechanically. It does NOT get its own table — see registry.ts for why.
//
// Pure: no database, no clock of its own (the timestamp is passed in), no LLM. A stamp that read
// the clock itself could not be reproduced by a test, which would defeat its purpose.

import { analysisVersionFingerprint, lineageOf } from "./registry";

export interface InputSnapshot {
  /** Row counts per source table at the moment of the calculation. */
  rowCounts: Readonly<Record<string, number>>;
  /** The business date the analysis was run "as of". */
  asOf: string;
  /**
   * Latest source timestamp included, when the caller knows it.
   *
   * This is the honest cutoff: two runs at different wall-clock times over the same frozen data
   * must produce the same answer, and this is what lets a reader tell those apart from two runs
   * over different data.
   */
  sourceCutoff: string | null;
}

export interface ReproducibilityStamp {
  analysisId: string;
  /** Concatenated `id@version` of the analysis and every metric it transitively consumes. */
  versionFingerprint: string;
  /** Source tables actually behind this analysis, from the registry's dependency graph. */
  lineage: readonly string[];
  input: InputSnapshot;
  /** ISO timestamp, passed in by the caller so tests are deterministic. */
  computedAt: string;
  /** Stable digest of fingerprint + input snapshot — one value to compare two runs by. */
  digest: string;
}

/**
 * A small, dependency-free, stable string digest (FNV-1a, 32-bit, hex).
 *
 * Deliberately not a cryptographic hash: this identifies a computation, it does not protect one.
 * Pulling in a crypto dependency (or node:crypto, which would stop this module working in a
 * browser bundle) to compare two short strings would be the wrong trade.
 */
export function stableDigest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Canonical JSON: keys sorted, so two equal snapshots always digest identically. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function buildStamp(
  analysisId: string, input: InputSnapshot, computedAt: string,
): ReproducibilityStamp {
  const versionFingerprint = analysisVersionFingerprint(analysisId);
  const lineage = lineageOf(analysisId);
  // computedAt is deliberately NOT in the digest: the same calculation over the same data is the
  // same result whether it ran this morning or last week. Including the clock would make every
  // digest unique and the comparison worthless.
  const digest = stableDigest(canonical({ analysisId, versionFingerprint, lineage, input }));
  return { analysisId, versionFingerprint, lineage, input, computedAt, digest };
}

/**
 * Whether two runs are expected to have produced the same numbers.
 *
 * Same digest means same formula version over the same input snapshot — so a difference in the
 * RESULTS would be a bug worth chasing rather than a data change.
 */
export function sameComputation(a: ReproducibilityStamp, b: ReproducibilityStamp): boolean {
  return a.digest === b.digest;
}

/** Human-readable one-liner for the UI footer, so provenance is visible without a click. */
export function describeStamp(stamp: ReproducibilityStamp): string {
  const tables = stamp.lineage.length ? stamp.lineage.join(", ") : "kaynak yok";
  const rows = Object.entries(stamp.input.rowCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}=${n}`)
    .join(" · ");
  return `${stamp.analysisId} · sürüm ${stamp.versionFingerprint} · kaynak: ${tables}`
    + (rows ? ` · girdi: ${rows}` : "")
    + ` · ${stamp.input.asOf} itibarıyla · özet ${stamp.digest}`;
}
