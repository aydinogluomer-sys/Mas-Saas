// Faz 34 — the metric / dimension / analysis registry.
//
// ═══ WHY THE REGISTRY IS CODE AND NOT A TABLE ═══
//
// A registry needs three things to be real rather than decorative: every entry must declare what
// it DEPENDS on, what VERSION of the calculation produced it, and where its numbers CAME FROM.
// All three are properties of the calculation, not of a row — and the calculation lives in git,
// which is already a versioned, auditable, diffable store with better provenance than any table
// this phase could add.
//
// A `metric_definitions` table would have to be kept in step with the functions it describes, by
// hand, forever. The first time someone changed a formula without updating the row, the registry
// would be lying about the system it exists to describe — and nothing would notice. Here the
// dependency graph is checked by the gate against the actual module graph.
//
// What DOES belong in the database is the metric's VALUE over time, and Faz 17 already stores
// that: `metric_snapshots` carries snapshot_date, value, unknown_count, confidence, a
// `source_cutoff` timestamp and a `meta` jsonb. This phase writes its reproducibility stamp into
// that existing `meta` rather than opening a parallel store — the Faz 32 decision, again.
//
// Consequence, stated so the gate can check it: this phase adds NO migration, NO table and
// therefore NO lifecycle column, so the CHECK+transition-guard discipline is structurally N/A
// here rather than skipped. phase34:verify proves that structurally instead of asserting it.
//
// ═══ NO LLM, EVER, IN THIS SUBTREE ═══
//
// Nothing under src/lib/analytics may import @/lib/ai. A number a reader cannot reproduce from
// the same inputs is not an analysis. From this phase on the gate enforces that across the whole
// subtree rather than file by file.

export type MetricFormat = "currency" | "percent" | "count" | "days" | "ratio";

/** Where a number comes from, in the sense Faz 2 established: real tables, named. */
export interface MetricLineage {
  /** Tables or views actually read. Used by the gate and shown to the reader. */
  sources: readonly string[];
  /** The phase that owns the underlying calculation, so a question has an address. */
  owningPhase: string;
}

export interface MetricDefinition {
  id: string;
  label: string;
  description: string;
  format: MetricFormat;
  /** Other registry ids this metric is computed FROM. Empty means it reads sources directly. */
  dependsOn: readonly string[];
  /**
   * Bumped whenever the arithmetic changes.
   *
   * Not cosmetic: a stored snapshot carries the version that produced it, so a value computed
   * under v1 is never silently compared against one computed under v2. Comparing two numbers that
   * were produced by different formulas is the quiet way a trend becomes fiction.
   */
  calculationVersion: number;
  lineage: MetricLineage;
  /** True when the metric can legitimately be null (unknown), which is not zero. */
  nullable: boolean;
}

export interface DimensionDefinition {
  id: string;
  label: string;
  description: string;
  /** The column or expression that carries this dimension, for traceability. */
  lineage: MetricLineage;
}

export type AnalysisKind =
  | "decomposition"    // splits a total into named contributions
  | "distribution"     // shows how a population spreads across buckets
  | "concentration"    // how much of a total sits in the top N
  | "trend"            // behaviour over time
  | "comparison";      // one period against another

export interface AnalysisDefinition {
  id: string;
  label: string;
  description: string;
  kind: AnalysisKind;
  /** Registry metric ids this analysis consumes. */
  inputs: readonly string[];
  calculationVersion: number;
  /** Chart type this analysis is normally rendered as. */
  preferredChart: "waterfall" | "heatmap" | "treemap" | "bar" | "line";
  /** Stated limitation, where one exists. Written down rather than discovered later. */
  caveat?: string;
}

/* ── metrics ────────────────────────────────────────────────────────────────────────────── */

export const METRICS: Readonly<Record<string, MetricDefinition>> = Object.freeze({
  receivables_open: {
    id: "receivables_open",
    label: "Açık alacak",
    description: "Kesilmiş ve henüz tahsil edilmemiş satış faturalarının kalan tutarı.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["invoices", "payment_allocations"], owningPhase: "Faz 21/22" },
    nullable: false,
  },
  payables_open: {
    id: "payables_open",
    label: "Açık borç",
    description: "Alınmış ve henüz ödenmemiş alış faturalarının kalan tutarı.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["invoices", "payment_allocations"], owningPhase: "Faz 21/22" },
    nullable: false,
  },
  sales_365: {
    id: "sales_365",
    label: "365 günlük satış",
    description: "Son 365 günde kesilen, iptal edilmemiş satış faturalarının brüt toplamı.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["invoices"], owningPhase: "Faz 30" },
    nullable: false,
  },
  purchases_365: {
    id: "purchases_365",
    label: "365 günlük alış",
    description: "Son 365 günde alınan, iptal edilmemiş alış faturalarının brüt toplamı.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["invoices"], owningPhase: "Faz 30" },
    nullable: false,
  },
  dso_days: {
    id: "dso_days",
    label: "DSO (gün)",
    description: "Açık alacak ÷ günlük ortalama satış. Satış yoksa hesaplanamaz — 0 değil, boş.",
    format: "days",
    dependsOn: ["receivables_open", "sales_365"],
    calculationVersion: 1,
    lineage: { sources: ["working_capital_metrics"], owningPhase: "Faz 30" },
    nullable: true,
  },
  dpo_days: {
    id: "dpo_days",
    label: "DPO (gün)",
    description: "Açık borç ÷ günlük ortalama alış. Alış yoksa hesaplanamaz.",
    format: "days",
    dependsOn: ["payables_open", "purchases_365"],
    calculationVersion: 1,
    lineage: { sources: ["working_capital_metrics"], owningPhase: "Faz 30" },
    nullable: true,
  },
  dio_days: {
    id: "dio_days",
    label: "DIO (gün)",
    description:
      "Stokta geçen gün. Bu sistemde envanter verisi YOKTUR, dolayısıyla her zaman boştur — " +
      "sıfır değil, ölçülemez. Kayıtta tutuluyor ki eksikliği açıkça görünsün.",
    format: "days",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: [], owningPhase: "Faz 30 (ölçülemez)" },
    nullable: true,
  },
  cash_cycle_days: {
    id: "cash_cycle_days",
    label: "Nakit döngüsü (envanter hariç)",
    description: "DSO − DPO. DIO ölçülemediği için tam nakit döngüsü değildir; adı bunu söylüyor.",
    format: "days",
    dependsOn: ["dso_days", "dpo_days"],
    calculationVersion: 1,
    lineage: { sources: ["working_capital_metrics"], owningPhase: "Faz 30" },
    nullable: true,
  },
  budget_variance: {
    id: "budget_variance",
    label: "Bütçe varyansı",
    description: "Gerçekleşen − bütçe. Pozitif değer bütçe aşımıdır.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["budget_vs_actual"], owningPhase: "Faz 28" },
    nullable: true,
  },
  counterparty_exposure: {
    id: "counterparty_exposure",
    label: "Karşı taraf maruziyeti",
    description: "Tek bir karşı tarafta duran açık alacak tutarı.",
    format: "currency",
    dependsOn: ["receivables_open"],
    calculationVersion: 1,
    lineage: { sources: ["invoices", "parties"], owningPhase: "Faz 23" },
    nullable: false,
  },
  net_cash_movement: {
    id: "net_cash_movement",
    label: "Net nakit hareketi",
    description: "Bir dönemdeki gelir − gider. Devir/kasa ile karıştırılmamalı.",
    format: "currency",
    dependsOn: [],
    calculationVersion: 1,
    lineage: { sources: ["cashflow_months"], owningPhase: "Faz 5" },
    nullable: true,
  },
});

/* ── dimensions ─────────────────────────────────────────────────────────────────────────── */

export const DIMENSIONS: Readonly<Record<string, DimensionDefinition>> = Object.freeze({
  counterparty: {
    id: "counterparty",
    label: "Karşı taraf",
    description: "Müşteri veya tedarikçi.",
    lineage: { sources: ["parties"], owningPhase: "Faz 19" },
  },
  period_month: {
    id: "period_month",
    label: "Ay",
    description: "Takvim ayı (YYYY-MM), Europe/Istanbul.",
    lineage: { sources: ["invoices", "cashflow_months"], owningPhase: "Faz 5" },
  },
  ageing_bucket: {
    id: "ageing_bucket",
    label: "Yaşlandırma kovası",
    description: "Vadeye göre 0-30 / 31-60 / 61-90 / 90+ gün.",
    lineage: { sources: ["invoices"], owningPhase: "Faz 22" },
  },
  cost_center: {
    id: "cost_center",
    label: "Masraf merkezi",
    description: "Faz 19'un organizasyonel boyutu.",
    lineage: { sources: ["cost_centers"], owningPhase: "Faz 19" },
  },
  category: {
    id: "category",
    label: "Kategori",
    description: "Ödeme/gider kategorisi.",
    lineage: { sources: ["categories"], owningPhase: "Faz 3" },
  },
});

/* ── analyses: the deliberately small first slice ────────────────────────────────────────── */
//
// SEVEN, not forty. The wishlist names ~40 analysis types; shipping forty shallow ones would mean
// forty screens nobody trusts and forty things to keep correct. These seven were chosen because
// each one has REAL DATA behind it in this system today — verified against the schema before
// being written down, not picked from the wishlist because the name sounded impressive:
//
//   variance_decomposition   <- budget_vs_actual exists (Faz 28)
//   pareto_concentration     <- invoices + parties exist (Faz 21/23)
//   working_capital_decomp   <- working_capital_metrics exists (Faz 30)
//   cash_bridge              <- cashflow_months exists (Faz 5)
//   ageing_distribution      <- invoices carry due_date (Faz 21/22)
//   period_over_period       <- any metric series
//   rolling_trend            <- any metric series
//
// An eighth candidate, inventory turnover, was REJECTED: there is no inventory data, so it could
// only have been built by inventing one. The registry records that absence as dio_days instead.

export const ANALYSES: Readonly<Record<string, AnalysisDefinition>> = Object.freeze({
  variance_decomposition: {
    id: "variance_decomposition",
    label: "Varyans ayrıştırma",
    description: "Toplam bütçe sapmasını, ona en çok katkı veren kalemlere ayırır.",
    kind: "decomposition",
    inputs: ["budget_variance"],
    calculationVersion: 1,
    preferredChart: "waterfall",
    caveat: "Yalnız onaylı bütçe satırları sayılır; taslak bütçe bir taahhüt değildir.",
  },
  pareto_concentration: {
    id: "pareto_concentration",
    label: "Yoğunlaşma (Pareto)",
    description: "Açık alacağın ne kadarının kaç karşı tarafta durduğunu gösterir.",
    kind: "concentration",
    inputs: ["counterparty_exposure"],
    calculationVersion: 1,
    preferredChart: "treemap",
  },
  working_capital_decomposition: {
    id: "working_capital_decomposition",
    label: "İşletme sermayesi ayrıştırma",
    description: "Nakit döngüsünü DSO ve DPO bileşenlerine ayırır.",
    kind: "decomposition",
    inputs: ["dso_days", "dpo_days", "dio_days", "cash_cycle_days"],
    calculationVersion: 1,
    preferredChart: "waterfall",
    caveat: "DIO ölçülemez (envanter verisi yok), bu yüzden sonuç TAM nakit döngüsü değildir.",
  },
  cash_bridge: {
    id: "cash_bridge",
    label: "Nakit köprüsü",
    description: "İki dönem arasındaki nakit değişimini artı ve eksi kalemlere ayırır.",
    kind: "decomposition",
    inputs: ["net_cash_movement"],
    calculationVersion: 1,
    preferredChart: "waterfall",
  },
  ageing_distribution: {
    id: "ageing_distribution",
    label: "Yaşlandırma dağılımı",
    description: "Açık alacak ve borcun vade kovalarına dağılımı.",
    kind: "distribution",
    inputs: ["receivables_open", "payables_open"],
    calculationVersion: 1,
    preferredChart: "heatmap",
  },
  period_over_period: {
    id: "period_over_period",
    label: "Dönemsel karşılaştırma (MoM/QoQ/YoY)",
    description: "Bir seriyi önceki ay, çeyrek veya yıl ile karşılaştırır.",
    kind: "comparison",
    inputs: [],
    calculationVersion: 1,
    preferredChart: "bar",
    caveat: "Eksik dönem sıfır sayılmaz; karşılaştırma 'hesaplanamadı' döner.",
  },
  rolling_trend: {
    id: "rolling_trend",
    label: "Hareketli pencere (7/30/90/365)",
    description: "Bir seriyi hareketli toplam veya ortalama olarak gösterir.",
    kind: "trend",
    inputs: [],
    calculationVersion: 1,
    preferredChart: "line",
    caveat: "Penceresi tam dolmayan noktalar kısmi olarak işaretlenir, gizlenmez.",
  },
});

/* ── the dependency graph ────────────────────────────────────────────────────────────────── */

export class RegistryError extends Error {}

/**
 * Every metric this one needs, transitively, in dependency-first order.
 *
 * Throws on an unknown id and on a cycle. Both are programming errors that must surface loudly:
 * a registry that silently tolerates a dangling dependency is describing a system that does not
 * exist, and one that tolerates a cycle will hang or produce a value that depends on itself.
 */
export function resolveDependencies(metricId: string): string[] {
  const out: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string, path: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new RegistryError(`Bağımlılık döngüsü: ${[...path, id].join(" -> ")}`);
    }
    const def = METRICS[id];
    if (!def) throw new RegistryError(`Bilinmeyen metrik: ${id}`);
    visiting.add(id);
    for (const dep of def.dependsOn) visit(dep, [...path, id]);
    visiting.delete(id);
    done.add(id);
    out.push(id);
  };

  visit(metricId, []);
  return out;
}

/** All metrics in an order where every dependency precedes its dependents. */
export function topologicalOrder(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(METRICS).sort()) {
    for (const dep of resolveDependencies(id)) {
      if (!seen.has(dep)) { seen.add(dep); out.push(dep); }
    }
  }
  return out;
}

/** Metrics that depend on this one, directly or transitively — the blast radius of a change. */
export function dependentsOf(metricId: string): string[] {
  if (!METRICS[metricId]) throw new RegistryError(`Bilinmeyen metrik: ${metricId}`);
  return Object.keys(METRICS)
    .filter((id) => id !== metricId && resolveDependencies(id).includes(metricId))
    .sort();
}

/** Every source table an analysis ultimately reads, deduplicated. The lineage answer. */
export function lineageOf(analysisId: string): string[] {
  const analysis = ANALYSES[analysisId];
  if (!analysis) throw new RegistryError(`Bilinmeyen analiz: ${analysisId}`);
  const sources = new Set<string>();
  for (const input of analysis.inputs) {
    for (const metricId of resolveDependencies(input)) {
      for (const source of METRICS[metricId].lineage.sources) sources.add(source);
    }
  }
  return [...sources].sort();
}

/**
 * A single number that changes whenever any calculation in an analysis's dependency tree changes.
 *
 * This is what makes "same version, same inputs, same answer" checkable. It is deliberately a
 * sum of declared versions and not a hash of the source: a comment change must not invalidate
 * every stored snapshot, while a formula change is expected to come with a version bump.
 */
export function analysisVersionFingerprint(analysisId: string): string {
  const analysis = ANALYSES[analysisId];
  if (!analysis) throw new RegistryError(`Bilinmeyen analiz: ${analysisId}`);
  const parts = [`${analysis.id}@${analysis.calculationVersion}`];
  const metricIds = new Set<string>();
  for (const input of analysis.inputs) {
    for (const id of resolveDependencies(input)) metricIds.add(id);
  }
  for (const id of [...metricIds].sort()) {
    parts.push(`${id}@${METRICS[id].calculationVersion}`);
  }
  return parts.join("|");
}
