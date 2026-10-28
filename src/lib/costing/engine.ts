// Faz 30 — costing engine: allocation-rule configuration and the profitability/working-capital
// read models.
//
// The only mutation is the allocation rule itself, which is configuration: changing it changes how
// overhead is PRESENTED, never a recorded amount. It is still audited, because "who re-based
// allocation the month our worst cost centre suddenly looked profitable" is exactly what an audit
// trail is for.
//
// Does not import @/lib/ai — the one-directional rule, re-proved by the gate's negative control.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull, rateOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { cashCycle, cycleVerdict, profitability, type CostKind } from "./rules";

export const updateAllocationRuleSchema = z.object({
  code: z.string().trim().min(1),
  allocationBasis: z.enum([
    "machine_minutes", "revenue_share", "direct_cost", "equal_split", "fixed_percent",
  ]),
  fixedPercent: z.number().min(0).max(1).nullable().optional(),
  isActive: z.boolean(),
  notes: z.string().trim().max(500).optional(),
});

export interface AllocationRule {
  id: string;
  code: string;
  description: string;
  costKind: CostKind;
  allocationBasis: string;
  fixedPercent: number | null;
  isActive: boolean;
}

export async function loadAllocationRules(pool: Pool): Promise<AllocationRule[]> {
  const r = await pool.query(
    `select id, code, description, cost_kind, allocation_basis, fixed_percent, is_active
     from public.cost_allocation_rules order by cost_kind, code`);
  return r.rows.map((x) => ({
    id: x.id, code: x.code, description: x.description,
    costKind: x.cost_kind as CostKind,
    allocationBasis: x.allocation_basis,
    fixedPercent: rateOrNull(x.fixed_percent),
    isActive: Boolean(x.is_active),
  }));
}

/**
 * Change how a cost kind is allocated.
 *
 * The cost kind and its dimension targets are NOT editable here: they decide which column the
 * scope CHECK requires and which unique index slot the rule occupies. A different kind is a
 * different rule, not an edit to this one.
 */
export async function updateAllocationRule(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(updateAllocationRuleSchema, raw, "Dağıtım kuralı");
  if (input.allocationBasis === "fixed_percent" && input.fixedPercent == null) {
    // Enforced by the CHECK too; saying it here turns a constraint violation into a sentence.
    throw new DomainError("Sabit yüzde tabanı için yüzde değeri zorunlu.");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, allocation_basis, fixed_percent, is_active
       from public.cost_allocation_rules where code=$1 for update`, [input.code]);
    if (before.rowCount === 0) throw new DomainError("Dağıtım kuralı bulunamadı.");
    const row = before.rows[0];

    await client.query(
      `update public.cost_allocation_rules
         set allocation_basis = $2,
             fixed_percent = case when $2='fixed_percent' then $3 else null end,
             is_active = $4,
             notes = coalesce($5, notes)
       where code = $1`,
      [input.code, input.allocationBasis, input.fixedPercent ?? null, input.isActive,
       input.notes ?? null]);

    await audit(client, {
      actor: actorId, action: "update_cost_allocation_rule",
      entityTable: "cost_allocation_rules", entityId: row.id,
      before: {
        allocationBasis: row.allocation_basis,
        fixedPercent: rateOrNull(row.fixed_percent),
        isActive: row.is_active,
      },
      after: {
        allocationBasis: input.allocationBasis,
        fixedPercent: input.fixedPercent ?? null,
        isActive: input.isActive,
        // Recorded explicitly: re-basing changes presentation, never a recorded amount.
        changesRecordedAmounts: false, automated: false,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── reads ────────────────────────────────────────────────────────────────────────────── */

export async function loadCostCenterProfitability(pool: Pool) {
  return cache.withCache(
    "costing:profitability:costCenter",
    async () => {
      const r = await pool.query(
        `select cost_center_id, cost_center_code, cost_center_name, currency,
                revenue, direct_cost, margin, margin_rate,
                sales_invoice_count, purchase_invoice_count, confidence
         from public.profitability_by_cost_center
         order by margin nulls last, cost_center_name`);
      return r.rows.map((x) => ({
        costCenterId: x.cost_center_id,
        code: x.cost_center_code,
        name: x.cost_center_name,
        currency: x.currency,
        revenue: moneyOrNull(x.revenue),
        directCost: moneyOrNull(x.direct_cost),
        margin: moneyOrNull(x.margin),
        marginRate: rateOrNull(x.margin_rate),
        salesInvoiceCount: Number(x.sales_invoice_count),
        purchaseInvoiceCount: Number(x.purchase_invoice_count),
        confidence: x.confidence as string,
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.PRODUCTION] }
  );
}

export async function loadProjectProfitability(pool: Pool) {
  return cache.withCache(
    "costing:profitability:project",
    async () => {
      const r = await pool.query(
        `select project_id, project_code, project_name, currency,
                revenue, direct_cost, margin, margin_rate, invoice_count
         from public.profitability_by_project order by margin nulls last, project_name`);
      return r.rows.map((x) => ({
        projectId: x.project_id, code: x.project_code, name: x.project_name,
        currency: x.currency,
        revenue: moneyOrNull(x.revenue), directCost: moneyOrNull(x.direct_cost),
        margin: moneyOrNull(x.margin), marginRate: rateOrNull(x.margin_rate),
        invoiceCount: Number(x.invoice_count),
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.PRODUCTION] }
  );
}

export async function loadPartyProfitability(pool: Pool, limit = 100) {
  return cache.withCache(
    `costing:profitability:party:${limit}`,
    async () => {
      const r = await pool.query(
        `select party_id, party_name, party_type, currency,
                revenue_from_party, cost_to_party, net_contribution,
                sales_invoice_count, purchase_invoice_count, observed_role
         from public.profitability_by_party
         where observed_role <> 'no_activity'
         order by net_contribution nulls last, party_name
         limit $1`, [limit]);
      return r.rows.map((x) => ({
        partyId: x.party_id, name: x.party_name, partyType: x.party_type,
        currency: x.currency,
        revenue: moneyOrNull(x.revenue_from_party),
        cost: moneyOrNull(x.cost_to_party),
        netContribution: moneyOrNull(x.net_contribution),
        salesInvoiceCount: Number(x.sales_invoice_count),
        purchaseInvoiceCount: Number(x.purchase_invoice_count),
        observedRole: x.observed_role as string,
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.COUNTERPARTY_RISK] }
  );
}

/** Departments, which cannot be measured — the reason travels with the row. */
export async function loadDepartmentProfitability(pool: Pool) {
  const r = await pool.query(
    `select department_id, department_code, department_name,
            revenue, direct_cost, margin, unmeasurable_reason, note
     from public.profitability_by_department order by department_name`);
  return r.rows.map((x) => ({
    departmentId: x.department_id, code: x.department_code, name: x.department_name,
    revenue: moneyOrNull(x.revenue),
    directCost: moneyOrNull(x.direct_cost),
    margin: moneyOrNull(x.margin),
    unmeasurableReason: x.unmeasurable_reason as string | null,
    note: x.note as string | null,
  }));
}

export async function loadMachineProfitability(pool: Pool) {
  return cache.withCache(
    "costing:profitability:machine",
    async () => {
      const r = await pool.query(
        `select machine_id, machine_name, machine_type, purchase_cost, snapshot_year,
                revenue, cost, margin, margin_rate, net_after_tax, roi_rate, confidence
         from public.profitability_by_machine order by machine_name, snapshot_year`);
      return r.rows.map((x) => ({
        machineId: x.machine_id, name: x.machine_name, machineType: x.machine_type,
        purchaseCost: moneyOrNull(x.purchase_cost),
        snapshotYear: x.snapshot_year == null ? null : Number(x.snapshot_year),
        revenue: moneyOrNull(x.revenue), cost: moneyOrNull(x.cost),
        margin: moneyOrNull(x.margin), marginRate: rateOrNull(x.margin_rate),
        netAfterTax: moneyOrNull(x.net_after_tax), roiRate: rateOrNull(x.roi_rate),
        confidence: x.confidence as string,
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.PRODUCTION] }
  );
}

export async function loadCompanyProfitability(pool: Pool) {
  return cache.withCache(
    "costing:profitability:company",
    async () => {
      const r = await pool.query(
        `select currency, to_char(period_start,'YYYY-MM-DD') as period_start,
                revenue, direct_cost, margin, invoice_count, undimensioned_invoice_count
         from public.profitability_company order by period_start`);
      return r.rows.map((x) => ({
        currency: x.currency, periodStart: x.period_start,
        revenue: moneyOrNull(x.revenue), directCost: moneyOrNull(x.direct_cost),
        margin: moneyOrNull(x.margin),
        invoiceCount: Number(x.invoice_count),
        undimensionedInvoiceCount: Number(x.undimensioned_invoice_count),
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES] }
  );
}

export interface WorkingCapital {
  receivablesOpen: number | null;
  payablesOpen: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays: number | null;
  dioUnmeasurableReason: string | null;
  cashConversionCycleDays: number | null;
  cccUnmeasurableReason: string | null;
  cycleExcludingInventory: number | null;
  verdict: ReturnType<typeof cycleVerdict>;
}

/**
 * The working-capital position.
 *
 * The SQL already computes the cycle; this recomputes it through `cashCycle` from the same three
 * terms and returns the APPLICATION's answer. Two independent computations over one set of facts —
 * the pattern Faz 26/27/28 used, and the gate fails if they disagree.
 */
export async function loadWorkingCapital(pool: Pool): Promise<WorkingCapital | null> {
  return cache.withCache(
    "costing:workingCapital",
    async () => {
      const r = await pool.query(
        `select receivables_open, payables_open, dso_days, dpo_days, dio_days,
                dio_unmeasurable_reason, cash_conversion_cycle_days, ccc_unmeasurable_reason,
                cash_cycle_excluding_inventory
         from public.working_capital_metrics limit 1`);
      if (r.rowCount === 0) return null;
      const x = r.rows[0];
      const dsoDays = x.dso_days == null ? null : Number(x.dso_days);
      const dpoDays = x.dpo_days == null ? null : Number(x.dpo_days);
      const dioDays = x.dio_days == null ? null : Number(x.dio_days);
      const cycle = cashCycle(dsoDays, dioDays, dpoDays);
      return {
        receivablesOpen: moneyOrNull(x.receivables_open),
        payablesOpen: moneyOrNull(x.payables_open),
        dsoDays,
        dpoDays,
        dioDays,
        dioUnmeasurableReason: x.dio_unmeasurable_reason as string | null,
        cashConversionCycleDays: cycle.cashConversionCycleDays,
        cccUnmeasurableReason: cycle.unmeasurableReason,
        cycleExcludingInventory: cycle.cycleExcludingInventory,
        verdict: cycleVerdict(cycle.cycleExcludingInventory),
      };
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES, CACHE_TAGS.PAYABLES] }
  );
}

export async function loadWorkingCapitalTrend(pool: Pool) {
  return cache.withCache(
    "costing:workingCapitalTrend",
    async () => {
      const r = await pool.query(
        `select to_char(period_start,'YYYY-MM-DD') as period_start,
                receivables_open, payables_open, dso_days, dpo_days, dio_days,
                cash_cycle_excluding_inventory
         from public.working_capital_trend order by period_start`);
      return r.rows.map((x) => ({
        periodStart: x.period_start,
        receivablesOpen: moneyOrNull(x.receivables_open),
        payablesOpen: moneyOrNull(x.payables_open),
        dsoDays: x.dso_days == null ? null : Number(x.dso_days),
        dpoDays: x.dpo_days == null ? null : Number(x.dpo_days),
        dioDays: x.dio_days == null ? null : Number(x.dio_days),
        cycleExcludingInventory:
          x.cash_cycle_excluding_inventory == null ? null : Number(x.cash_cycle_excluding_inventory),
      }));
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.INVOICES, CACHE_TAGS.RECEIVABLES, CACHE_TAGS.PAYABLES] }
  );
}

/** Profitability recomputed in TypeScript from the same raw figures — the agreement check. */
export async function loadProfitabilityRecomputed(pool: Pool) {
  const rows = await loadCostCenterProfitability(pool);
  return rows.map((r) => ({
    costCenterId: r.costCenterId,
    sql: { margin: r.margin, marginRate: r.marginRate, confidence: r.confidence },
    ts: profitability(r.revenue, r.directCost),
  }));
}
