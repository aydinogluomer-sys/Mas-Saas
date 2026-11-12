import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  calculatePartProfitability,
  loadCatalogProducts,
  loadProductionParts,
  upsertCatalogProductManual,
  upsertOperationRatesManual,
  upsertProductionPartManual,
} from "@/lib/production/engine";
import {
  applyScenario,
  loadScenarioExternalBaseline,
  resolveAssumptionsWithExternal,
  runScenario,
} from "@/lib/scenarios/engine";
import type { ExternalAssumption } from "@/lib/external-assumptions/engine";
import type { CashMonth } from "@/lib/radar/rules";
import {
  ask,
  listConversations,
  loadConversationDetail,
} from "@/lib/assistant/engine";
import {
  CHECK_REMINDER_STATUSES,
  LOAN_INSTALLMENT_REMINDER_STATUSES,
  eligibleMaturityDeliveries,
  ensureDefaultMaturityRules,
  scheduleReminders,
  toggleReminderRule,
  upsertReminderRule,
} from "@/lib/reminders/engine";
import type { ReminderRule } from "@/lib/reminders/rules";

vi.mock("@/lib/facts/engine", () => ({
  loadDecisionFacts: vi.fn(async () => [
    {
      key: "due_7d",
      category: "upcoming_obligations",
      severity: "warning",
      title: "7 Günlük Ödeme Yükü",
      summary: "Önümüzdeki 7 günde 125.000 TL çıkış planlı.",
      valueNumeric: 125000,
      valueText: "125.000 TL",
      unit: "TRY",
      periodStart: "2026-07-06",
      periodEnd: "2026-07-13",
      confidence: "high",
      sourceTables: ["payment_instances"],
      sourceHref: "/calendar",
      evidenceRefs: ["pi-1"],
    },
  ]),
}));

vi.mock("@/lib/ai/engine", () => ({
  answerQuestion: vi.fn(
    async (
      _pool: Pool,
      input: { question: string; forceDeterministic?: boolean },
    ) => ({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
      question: input.question,
      answerMd: `Deterministik yanıt: ${input.question}`,
      responseMode: input.forceDeterministic ? "deterministic" : "fallback",
      confidence: "high" as const,
      sourceFactKeys: ["due_7d"],
      safetyNotes: [],
    }),
  ),
}));

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

/* ═══════════════════════════════════════════════════════════════════════════
   1) F-49 + F-41: Production Costs ON CONFLICT DO UPDATE, Part/Rate CRUD & Products
   ═══════════════════════════════════════════════════════════════════════════ */

interface FakeProfitRun {
  part_id: string;
  cost_model_id: string;
  estimated_torna_cost: number | null;
  estimated_freze_cost: number | null;
  estimated_total_cost: number | null;
  estimated_revenue: number | null;
  estimated_margin: number | null;
  margin_rate: number | null;
  confidence: string;
  missing_operation_time: boolean;
}

function createProductionFakePool() {
  const costModels = new Map<
    string,
    {
      id: string;
      capacity_model_id: string | null;
      model_name: string;
      scenario_type: string;
      total_fixed_cost: number | null;
      effective_monthly_minutes: number | null;
      break_even_tl_per_min: number | null;
      akon_torna_tl_per_min: number | null;
      akon_freze_tl_per_min: number | null;
    }
  >();
  const capacityModels = new Map<
    string,
    {
      id: string;
      name: string;
      scenario_type: string;
      monthly_minutes: number | null;
      torna_rate_tl_per_min: number | null;
      freze_rate_tl_per_min: number | null;
      rate_year: number | null;
      is_stale_rate: boolean;
    }
  >();
  const parts = new Map<
    string,
    {
      id: string;
      part_code: string | null;
      part_name: string;
      quantity: number | null;
      torna_minutes: number | null;
      freze_minutes: number | null;
      other_operation_minutes: number | null;
      unit_sale_price: number | null;
      currency: string;
      notes: string | null;
      source_row_id: string | null;
    }
  >();
  const profitRuns = new Map<string, FakeProfitRun>();
  const products = new Map<
    string,
    {
      id: string;
      code: string;
      name: string;
      unit: string | null;
      is_active: boolean;
      notes: string | null;
      updated_at: string;
    }
  >();
  const audits: Array<{ action: string; entityTable: string; entityId: string | null }> = [];
  const executedSql: string[] = [];

  let seq = 1;
  const nextUuid = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

  const capId = nextUuid();
  capacityModels.set(capId, {
    id: capId,
    name: "Ana Kapasite",
    scenario_type: "normal",
    monthly_minutes: 10000,
    torna_rate_tl_per_min: 10,
    freze_rate_tl_per_min: 15,
    rate_year: 2026,
    is_stale_rate: false,
  });

  const cmId = nextUuid();
  costModels.set(cmId, {
    id: cmId,
    capacity_model_id: capId,
    model_name: "Normal Maliyet",
    scenario_type: "normal",
    total_fixed_cost: 120000,
    effective_monthly_minutes: 10000,
    break_even_tl_per_min: 12,
    akon_torna_tl_per_min: 14,
    akon_freze_tl_per_min: 18,
  });

  const isSameNum = (a: number | null, b: number | null) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 1e-9;
  };

  const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
    const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
    executedSql.push(sql);

    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("insert into public.audit_logs")) {
      audits.push({
        action: String(params[1] ?? ""),
        entityTable: String(params[2] ?? ""),
        entityId: (params[3] as string | null) ?? null,
      });
      return { rows: [{ id: nextUuid() }], rowCount: 1 };
    }

    if (sql.includes("select distinct cost_model_id from public.part_profitability_runs")) {
      const ids = [...new Set([...profitRuns.values()].map((r) => r.cost_model_id))];
      return { rows: ids.map((id) => ({ cost_model_id: id })), rowCount: ids.length };
    }

    if (sql.includes("from public.cost_models cm left join public.capacity_models cap")) {
      const targetId = params[0] as string | undefined;
      const cm = targetId ? costModels.get(targetId) : [...costModels.values()][0];
      if (!cm) return { rows: [], rowCount: 0 };
      const cap = cm.capacity_model_id ? capacityModels.get(cm.capacity_model_id) : undefined;
      return {
        rows: [
          {
            id: cm.id,
            scenario_type: cm.scenario_type,
            be: cm.break_even_tl_per_min != null ? String(cm.break_even_tl_per_min) : null,
            torna: cap?.torna_rate_tl_per_min != null ? String(cap.torna_rate_tl_per_min) : null,
            freze: cap?.freze_rate_tl_per_min != null ? String(cap.freze_rate_tl_per_min) : null,
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.includes("from public.production_parts") && sql.startsWith("select id, part_code, part_name, quantity")) {
      const rows = [...parts.values()].map((p) => ({
        ...p,
        torna_minutes: p.torna_minutes != null ? String(p.torna_minutes) : null,
        freze_minutes: p.freze_minutes != null ? String(p.freze_minutes) : null,
        other_operation_minutes: p.other_operation_minutes != null ? String(p.other_operation_minutes) : null,
        unit_sale_price: p.unit_sale_price != null ? String(p.unit_sale_price) : null,
      }));
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("from public.import_rows ir join public.production_parts pp")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("insert into public.part_profitability_runs")) {
      const [
        partId,
        modelId,
        tornaCost,
        frezeCost,
        totalCost,
        revenue,
        margin,
        marginRate,
        confidence,
        missingOp,
      ] = params as [
        string,
        string,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string,
        boolean,
      ];
      const key = `${partId}::${modelId}`;
      const existing = profitRuns.get(key);
      const incoming: FakeProfitRun = {
        part_id: partId,
        cost_model_id: modelId,
        estimated_torna_cost: tornaCost,
        estimated_freze_cost: frezeCost,
        estimated_total_cost: totalCost,
        estimated_revenue: revenue,
        estimated_margin: margin,
        margin_rate: marginRate,
        confidence,
        missing_operation_time: missingOp,
      };

      if (!existing) {
        profitRuns.set(key, incoming);
        return { rows: [], rowCount: 1 };
      }

      // Enforce ON CONFLICT DO UPDATE ... WHERE IS DISTINCT FROM semantics
      const changed =
        !isSameNum(existing.estimated_torna_cost, incoming.estimated_torna_cost) ||
        !isSameNum(existing.estimated_freze_cost, incoming.estimated_freze_cost) ||
        !isSameNum(existing.estimated_total_cost, incoming.estimated_total_cost) ||
        !isSameNum(existing.estimated_revenue, incoming.estimated_revenue) ||
        !isSameNum(existing.estimated_margin, incoming.estimated_margin) ||
        !isSameNum(existing.margin_rate, incoming.margin_rate) ||
        existing.confidence !== incoming.confidence ||
        existing.missing_operation_time !== incoming.missing_operation_time;

      if (!changed) {
        return { rows: [], rowCount: 0 };
      }
      profitRuns.set(key, incoming);
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("select id from public.production_parts where lower(part_code)")) {
      const code = String(params[0] ?? "").toLowerCase();
      const found = [...parts.values()].find((p) => (p.part_code ?? "").toLowerCase() === code);
      return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("insert into public.production_parts")) {
      const id = nextUuid();
      parts.set(id, {
        id,
        part_code: (params[0] as string | null) ?? null,
        part_name: String(params[1]),
        quantity: Number(params[2]),
        torna_minutes: params[3] != null ? Number(params[3]) : null,
        freze_minutes: params[4] != null ? Number(params[4]) : null,
        other_operation_minutes: params[5] != null ? Number(params[5]) : null,
        unit_sale_price: params[6] != null ? Number(params[6]) : null,
        currency: String(params[7] ?? "TRY"),
        notes: (params[8] as string | null) ?? null,
        source_row_id: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.startsWith("update public.production_parts")) {
      const id = String(params[0]);
      const existing = parts.get(id);
      if (!existing) return { rows: [], rowCount: 0 };
      parts.set(id, {
        ...existing,
        part_code: (params[1] as string | null) ?? existing.part_code,
        part_name: String(params[2]),
        quantity: Number(params[3]),
        torna_minutes: params[4] != null ? Number(params[4]) : null,
        freze_minutes: params[5] != null ? Number(params[5]) : null,
        other_operation_minutes: params[6] != null ? Number(params[6]) : null,
        unit_sale_price: params[7] != null ? Number(params[7]) : null,
        currency: String(params[8] ?? "TRY"),
        notes: (params[9] as string | null) ?? existing.notes,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes("select id, capacity_model_id, total_fixed_cost, effective_monthly_minutes from public.cost_models")) {
      const scen = String(params[0]);
      const found = [...costModels.values()].find((c) => c.scenario_type === scen);
      if (!found) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: found.id,
            capacity_model_id: found.capacity_model_id,
            total_fixed_cost: found.total_fixed_cost != null ? String(found.total_fixed_cost) : null,
            effective_monthly_minutes:
              found.effective_monthly_minutes != null ? String(found.effective_monthly_minutes) : null,
          },
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith("select id from public.capacity_models")) {
      const first = [...capacityModels.values()][0];
      return first ? { rows: [{ id: first.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.startsWith("update public.capacity_models")) {
      const id = String(params[0]);
      const cap = capacityModels.get(id)!;
      capacityModels.set(id, {
        ...cap,
        torna_rate_tl_per_min: params[1] != null ? Number(params[1]) : cap.torna_rate_tl_per_min,
        freze_rate_tl_per_min: params[2] != null ? Number(params[2]) : cap.freze_rate_tl_per_min,
        monthly_minutes: params[3] != null ? Number(params[3]) : cap.monthly_minutes,
        rate_year: params[4] != null ? Number(params[4]) : cap.rate_year,
        is_stale_rate: params[4] != null ? Boolean(params[5]) : cap.is_stale_rate,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("update public.cost_models")) {
      const id = String(params[0]);
      const cm = costModels.get(id)!;
      costModels.set(id, {
        ...cm,
        capacity_model_id: cm.capacity_model_id ?? (params[1] as string),
        akon_torna_tl_per_min: params[2] != null ? Number(params[2]) : cm.akon_torna_tl_per_min,
        akon_freze_tl_per_min: params[3] != null ? Number(params[3]) : cm.akon_freze_tl_per_min,
        effective_monthly_minutes: params[4] != null ? Number(params[4]) : cm.effective_monthly_minutes,
        break_even_tl_per_min: params[5] != null ? Number(params[5]) : cm.break_even_tl_per_min,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("insert into public.products")) {
      const code = String(params[0]);
      const existing = [...products.values()].find((p) => p.code === code);
      const id = existing?.id ?? nextUuid();
      products.set(id, {
        id,
        code,
        name: String(params[1]),
        unit: (params[2] as string | null) ?? null,
        is_active: Boolean(params[3]),
        notes: (params[4] as string | null) ?? null,
        updated_at: "2026-07-06 12:00",
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes("from public.products")) {
      const rows = [...products.values()];
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Unhandled SQL in production fake pool: ${sql}`);
  });

  const client: Partial<PoolClient> = {
    query: query as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const pool: Partial<Pool> = {
    query: query as unknown as Pool["query"],
    connect: vi.fn(async () => client as PoolClient),
  };

  return {
    pool: pool as Pool,
    parts,
    profitRuns,
    costModels,
    capacityModels,
    products,
    audits,
    executedSql,
    cmId,
  };
}

describe("Wave 5B — F-49 & F-41 Production Profitability ON CONFLICT DO UPDATE + Part/Rate/Products CRUD", () => {
  it("recalculates part_profitability_runs via ON CONFLICT DO UPDATE when part price or machine rates change, while remaining idempotent when unchanged", async () => {
    const ctx = createProductionFakePool();

    // 1. Create a part manually: 10 units, 4 min torna (@10 TL/dk) + 2 min freze (@15 TL/dk) = 70 TL/unit -> 700 TL total cost; unit sale price 100 TL -> 1000 TL revenue -> +300 TL margin
    const partId = await upsertProductionPartManual(
      ctx.pool,
      {
        partCode: "PRT-500",
        partName: "Hidrolik Flanş",
        quantity: 10,
        tornaMinutes: 4,
        frezeMinutes: 2,
        unitSalePrice: 100,
        currency: "TRY",
      },
      ACTOR_ID,
    );

    const runKey = `${partId}::${ctx.cmId}`;
    const initialRun = ctx.profitRuns.get(runKey);
    expect(initialRun).toBeDefined();
    expect(initialRun?.estimated_total_cost).toBe(700);
    expect(initialRun?.estimated_revenue).toBe(1000);
    expect(initialRun?.estimated_margin).toBe(300);
    expect(
      ctx.executedSql.some((s) =>
        s.includes("on conflict (part_id, cost_model_id) do update"),
      ),
    ).toBe(true);

    // 2. Re-running calculatePartProfitability with NO changes returns runsCreated === 0 (strict idempotency)
    const unchanged = await calculatePartProfitability(ctx.pool);
    expect(unchanged.runsCreated).toBe(0);

    // 3. Update machine operation rates (torna 10 -> 20 TL/dk, freze 15 -> 25 TL/dk) -> cost becomes 10*(4*20 + 2*25) = 1300 TL, margin becomes -300 TL immediately!
    await upsertOperationRatesManual(
      ctx.pool,
      {
        scenarioType: "normal",
        tornaRateTLPerMin: 20,
        frezeRateTLPerMin: 25,
        akonTornaTLPerMin: 24,
        akonFrezeTLPerMin: 30,
        rateYear: 2026,
      },
      ACTOR_ID,
    );

    const afterRateChange = ctx.profitRuns.get(runKey);
    expect(afterRateChange?.estimated_total_cost).toBe(1300);
    expect(afterRateChange?.estimated_margin).toBe(-300);

    // 4. Update part unitSalePrice (100 -> 160 TL) -> revenue becomes 1600 TL, margin becomes +300 TL immediately!
    await upsertProductionPartManual(
      ctx.pool,
      {
        id: partId,
        partCode: "PRT-500",
        partName: "Hidrolik Flanş",
        quantity: 10,
        tornaMinutes: 4,
        frezeMinutes: 2,
        unitSalePrice: 160,
      },
      ACTOR_ID,
    );

    const afterPriceChange = ctx.profitRuns.get(runKey);
    expect(afterPriceChange?.estimated_revenue).toBe(1600);
    expect(afterPriceChange?.estimated_margin).toBe(300);

    const loadedParts = await loadProductionParts(ctx.pool);
    expect(loadedParts).toHaveLength(1);
    expect(loadedParts[0]?.unitSalePrice).toBe(160);
  });

  it("loads and upserts catalog products (public.products) for /production/costs (F-41)", async () => {
    const ctx = createProductionFakePool();
    const productId = await upsertCatalogProductManual(
      ctx.pool,
      {
        code: "URN-CNC-01",
        name: "CNC İşlenmiş Gövde",
        unit: "Adet",
        isActive: true,
        notes: "Ana katalog kalemi",
      },
      ACTOR_ID,
    );

    expect(productId).toMatch(/^[0-9a-f-]{36}$/);
    const catalog = await loadCatalogProducts(ctx.pool);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      code: "URN-CNC-01",
      name: "CNC İşlenmiş Gövde",
      unit: "Adet",
      isActive: true,
    });
    expect(ctx.audits.some((a) => a.entityTable === "products" && a.action === "upsert_catalog_product")).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2) F-50: /scenarios <-> /data/assumptions Integration
   ═══════════════════════════════════════════════════════════════════════════ */

function sampleExternalAssumption(
  overrides: Partial<ExternalAssumption> & Pick<ExternalAssumption, "assumption_type" | "label" | "value_numeric" | "unit">,
): ExternalAssumption {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    period_start: "2026-01-01",
    period_end: "2026-12-31",
    currency: "TRY",
    source_kind: "manual",
    source_name: "TCMB / TÜİK",
    source_url: null,
    source_date: "2026-07-01",
    review_status: "approved",
    reviewed_at: "2026-07-01 10:00",
    notes: null,
    created_at: "2026-07-01 09:00",
    updated_at: "2026-07-01 10:00",
    ...overrides,
  };
}

describe("Wave 5B — F-50 Scenarios <-> External Assumptions Integration", () => {
  const baselineMonths: CashMonth[] = [
    {
      monthStart: "2026-07-01",
      opening: 100000,
      income: 200000,
      expense: 150000,
      closing: 150000,
    },
    {
      monthStart: "2026-08-01",
      opening: 150000,
      income: 200000,
      expense: 150000,
      closing: 200000,
    },
  ];

  it("applyScenario applies approved external_assumptions as base inputs unless explicitly overridden by scenario parameters", () => {
    const approvedExternal: ExternalAssumption[] = [
      sampleExternalAssumption({
        id: "22222222-2222-4222-8222-000000000001",
        assumption_type: "inflation_rate",
        label: "TÜFE Beklentisi",
        value_numeric: 20, // 20% -> 0.20 expensePct
        unit: "yüzde",
      }),
      sampleExternalAssumption({
        id: "22222222-2222-4222-8222-000000000002",
        assumption_type: "interest_rate",
        label: "Politika Faizi",
        value_numeric: 48, // 48% annual -> 4%/month factoringFeePct
        unit: "%",
      }),
      sampleExternalAssumption({
        id: "22222222-2222-4222-8222-000000000003",
        assumption_type: "fx_rate",
        label: "USD/TRY Baz Kur",
        value_numeric: 38.5,
        unit: "TRY",
        currency: "USD",
      }),
    ];

    // Without explicit expensePct override, inflation_rate (20%) increases 150,000 -> 180,000
    const withExternalBase = applyScenario(baselineMonths, {}, [], [], approvedExternal);
    expect(withExternalBase[0]?.scenarioExpense).toBe(180000);
    expect(withExternalBase[0]?.scenarioClosing).toBe(120000); // 100k + 200k - 180k

    // Explicit override (expensePct: 0.05) wins over external inflation_rate (0.20): 150,000 * 1.05 = 157,500
    const withExplicitOverride = applyScenario(
      baselineMonths,
      { expensePct: 0.05 },
      [],
      [],
      approvedExternal,
    );
    expect(withExplicitOverride[0]?.scenarioExpense).toBe(157500);

    // Explicit zero override (expensePct: 0) also wins over external inflation_rate
    const resolvedZero = resolveAssumptionsWithExternal({ expensePct: 0 }, approvedExternal);
    expect(resolvedZero.effectiveAssumptions.expensePct).toBe(0);
    expect(resolvedZero.effectiveAssumptions.factoringFeePct).toBe(0.04);
  });

  it("runScenario loads approved public.external_assumptions from DB and persists resolved assumptions", async () => {
    const insertedRunLines: Array<{ scenExp: unknown }> = [];
    const insertedAssumptions: Array<{ key: string; value: unknown }> = [];

    const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("from public.cashflow_months")) {
        return {
          rows: [
            {
              id: "cccccccc-cccc-4ccc-8ccc-000000000001",
              month_start: "2026-07-01",
              opening: "100000",
              income: "200000",
              expense: "100000",
              closing: "200000",
              status: "confirmed",
              sheetId: null,
              workbookId: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.checks") || sql.includes("from public.loan_installments") || sql.includes("from public.cashflow_lines")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select scenario_type from public.scenarios")) {
        return { rows: [{ scenario_type: "combined_custom_scenario" }], rowCount: 1 };
      }
      if (sql.includes("from public.external_assumptions")) {
        return {
          rows: [
            {
              id: "22222222-2222-4222-8222-000000000099",
              assumption_type: "inflation_rate",
              label: "OVP Enflasyon",
              period_start: "2026-01-01",
              period_end: "2026-12-31",
              value_numeric: "0.30",
              unit: "oran",
              currency: "TRY",
              source_kind: "official",
              source_name: "TCMB",
              source_url: null,
              source_date: "2026-07-01",
              review_status: "approved",
              reviewed_at: "2026-07-01 09:00",
              notes: null,
              created_at: "2026-07-01 09:00",
              updated_at: "2026-07-01 09:00",
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.startsWith("insert into public.scenario_runs")) {
        return { rows: [{ id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 };
      }
      if (sql.startsWith("insert into public.scenario_run_lines")) {
        insertedRunLines.push({ scenExp: params[5] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into public.scenario_assumptions")) {
        insertedAssumptions.push({ key: String(params[1]), value: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into public.scenario_comparisons")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into public.audit_logs")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999991" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const fakeClient = { query, release: vi.fn() } as unknown as PoolClient;
    const fakePool = { query, connect: vi.fn(async () => fakeClient) } as unknown as Pool;

    const baselineSummary = await loadScenarioExternalBaseline(fakePool);
    expect(baselineSummary.approved).toHaveLength(1);
    expect(baselineSummary.approved[0]?.sourceHref).toBe("/data/assumptions");
    expect(baselineSummary.defaultAssumptions.expensePct).toBe(0.3);

    const res = await runScenario(
      fakePool,
      "44444444-4444-4444-8444-444444444444",
      {},
      ACTOR_ID,
    );
    expect(res.comparison.scenarioFinalCash).toBe(170000); // 100k + 200k - (100k * 1.30)
    expect(insertedRunLines[0]?.scenExp).toBe(130000);
    expect(insertedAssumptions.some((a) => a.key === "expensePct" && a.value === 0.3)).toBe(true);
    expect(insertedAssumptions.some((a) => a.key === "external:inflation_rate")).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3) F-51: /insights/ask Persistent Conversation History via assistant/engine.ts
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Wave 5B — F-51 Assistant Persistent Conversation History", () => {
  it("creates a persistent conversation on first question and appends subsequent turns with history > 0", async () => {
    const conversations = new Map<string, { id: string; title: string; status: string; updated_at: string }>();
    const snapshots = new Map<
      string,
      {
        id: string;
        question: string;
        answer_md: string;
        response_mode: string;
        source_fact_keys: string[];
        conversation_id: string | null;
        turn_index: number | null;
        created_at: string;
      }
    >();

    let convSeq = 1;
    const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("insert into public.audit_logs")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999992" }], rowCount: 1 };
      }

      if (sql.startsWith("insert into public.assistant_conversations")) {
        const id = `55555555-5555-4555-8555-${String(convSeq++).padStart(12, "0")}`;
        conversations.set(id, {
          id,
          title: String(params[0]),
          status: "active",
          updated_at: "2026-07-06 13:00",
        });
        return { rows: [{ id }], rowCount: 1 };
      }

      if (sql.startsWith("update public.assistant_conversations set updated_at")) {
        const id = String(params[0]);
        const c = conversations.get(id);
        if (c) conversations.set(id, { ...c, updated_at: "2026-07-06 13:05" });
        return { rows: [], rowCount: c ? 1 : 0 };
      }

      if (sql.startsWith("update public.ai_response_snapshots set conversation_id")) {
        const [convId, turnIdx, snapId] = params as [string, number, string];
        const existing = snapshots.get(snapId);
        snapshots.set(snapId, {
          id: snapId,
          question: existing?.question ?? `Soru #${turnIdx}`,
          answer_md: existing?.answer_md ?? `Yanıt #${turnIdx}`,
          response_mode: existing?.response_mode ?? "deterministic",
          source_fact_keys: existing?.source_fact_keys ?? ["due_7d"],
          conversation_id: convId,
          turn_index: turnIdx,
          created_at: "2026-07-06 13:00",
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("from public.ai_response_snapshots where conversation_id = $1")) {
        const convId = String(params[0]);
        const rows = [...snapshots.values()]
          .filter((s) => s.conversation_id === convId && s.turn_index != null)
          .sort((a, b) => (a.turn_index ?? 0) - (b.turn_index ?? 0));
        return { rows, rowCount: rows.length };
      }

      if (sql.includes("from public.assistant_conversations c order by c.updated_at desc")) {
        const rows = [...conversations.values()].map((c) => ({
          ...c,
          turn_count: [...snapshots.values()].filter((s) => s.conversation_id === c.id).length,
        }));
        return { rows, rowCount: rows.length };
      }

      if (sql.includes("from public.assistant_conversations where id = $1")) {
        const convId = String(params[0]);
        const c = conversations.get(convId);
        return c ? { rows: [c], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      throw new Error(`Unhandled SQL in assistant test: ${sql}`);
    });

    const fakeClient = { query, release: vi.fn() } as unknown as PoolClient;
    const fakePool = { query, connect: vi.fn(async () => fakeClient) } as unknown as Pool;

    const first = await ask(
      fakePool,
      { question: "7 günde ne kadar çıkış var?", conversationId: null, forceDeterministic: true },
      ACTOR_ID,
      "finance_manager",
      "2026-07-06",
    );
    expect(first.turnIndex).toBe(1);
    expect(first.conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await ask(
      fakePool,
      { question: "Peki hangi ekranlardan doğrulanır?", conversationId: first.conversationId, forceDeterministic: true },
      ACTOR_ID,
      "finance_manager",
      "2026-07-06",
    );
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.turnIndex).toBe(2);

    const listed = await listConversations(fakePool, 10);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed[0]?.turnCount).toBe(2);

    const detail = await loadConversationDetail(fakePool, first.conversationId);
    expect(detail?.turns).toHaveLength(2);
    expect(detail?.turns[0]?.turnIndex).toBe(1);
    expect(detail?.turns[1]?.turnIndex).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4) F-52: /insights/reminders Rule CRUD + checks & loan_installments Maturity Scanning
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Wave 5B — F-52 Reminders Rule CRUD + Checks & Loan Installments Maturity Scanning", () => {
  it("creates, updates, toggles reminder rules and scans upcoming + overdue checks and loan_installments idempotently", async () => {
    expect([...CHECK_REMINDER_STATUSES].sort()).toEqual([
      "in_bank_collateral",
      "in_bank_collection",
      "in_portfolio",
      "issued_to_vendor",
      "planned",
    ]);
    expect([...LOAN_INSTALLMENT_REMINDER_STATUSES].sort()).toEqual([
      "late",
      "partial",
      "planned",
      "unpaid",
    ]);

    const rules = new Map<string, ReminderRule>();
    const deliveries = new Set<string>();
    let ruleSeq = 1;
    const nextRuleId = () => `66666666-6666-4666-8666-${String(ruleSeq++).padStart(12, "0")}`;

    const query = vi.fn(async (sqlRaw: string, params: unknown[] = []) => {
      const sql = sqlRaw.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("insert into public.audit_logs")) {
        return { rows: [{ id: "99999999-9999-4999-8999-999999999992" }], rowCount: 1 };
      }

      if (sql.includes("select target_kind, count(*)::int as n from public.reminders")) {
        const counts = new Map<string, number>();
        for (const r of rules.values()) {
          if (r.targetKind === "check" || r.targetKind === "loan_installment") {
            counts.set(r.targetKind, (counts.get(r.targetKind) ?? 0) + 1);
          }
        }
        const rows = [...counts.entries()].map(([target_kind, n]) => ({ target_kind, n }));
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith("insert into public.reminders")) {
        const name = String(params[0]);
        const targetKind = params[1] as ReminderRule["targetKind"];
        const offsetDays = Number(params[2]);
        const channel: ReminderRule["channel"] =
          params.length >= 4 && (params[3] === "email" || params[3] === "telegram")
            ? params[3]
            : "telegram";
        const minAmount = params.length >= 5 && params[4] != null ? Number(params[4]) : null;
        const isActive = params.length >= 6 ? Boolean(params[5]) : true;

        const dup = [...rules.values()].find(
          (r) => r.targetKind === targetKind && r.offsetDays === offsetDays && r.channel === channel,
        );
        if (dup) {
          if (sql.includes("do nothing")) return { rows: [], rowCount: 0 };
          rules.set(dup.id, { ...dup, name, minAmount, isActive });
          return { rows: [{ id: dup.id }], rowCount: 1 };
        }
        const id = nextRuleId();
        rules.set(id, { id, name, targetKind, offsetDays, channel, minAmount, isActive });
        return { rows: [{ id }], rowCount: 1 };
      }

      if (sql.startsWith("update public.reminders set is_active")) {
        const id = String(params[0]);
        const desired = params[1] as boolean | null;
        const existing = rules.get(id);
        if (!existing) return { rows: [], rowCount: 0 };
        const updated = { ...existing, isActive: desired ?? !existing.isActive };
        rules.set(id, updated);
        return { rows: [{ id, is_active: updated.isActive }], rowCount: 1 };
      }

      if (sql.includes("from public.reminders where is_active = true")) {
        const active = [...rules.values()]
          .filter((r) => r.isActive)
          .map((r) => ({
            id: r.id,
            name: r.name,
            target_kind: r.targetKind,
            offset_days: r.offsetDays,
            channel: r.channel,
            min_amount: r.minAmount,
            is_active: r.isActive,
          }));
        return { rows: active, rowCount: active.length };
      }

      if (
        sql.includes("from public.payment_instances") ||
        sql.includes("from public.invoices") ||
        sql.includes("from public.promise_to_pay")
      ) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("from public.checks c")) {
        expect(sql).toContain("c.archived_at is null");
        expect(sql).toContain("'in_portfolio'");
        expect(sql).toContain("'issued_to_vendor'");
        return {
          rows: [
            {
              id: "77777777-7777-4777-8777-000000000001",
              name: "Akon Mühendislik Çeki",
              due_date: "2026-07-09", // 3 days upcoming relative to 2026-07-06
              amount: "85000",
              status: "in_portfolio",
              owner: "Akon",
              provider: "Halk",
              risk_flag: null,
            },
            {
              id: "77777777-7777-4777-8777-000000000002",
              name: "Çağdaş Çelik Tedarikçi Çeki",
              due_date: "2026-07-02", // 4 days overdue relative to 2026-07-06!
              amount: "120000",
              status: "issued_to_vendor",
              owner: "Çağdaş",
              provider: "Deniz",
              risk_flag: "gecikme",
            },
          ],
          rowCount: 2,
        };
      }

      if (sql.includes("from public.loan_installments li")) {
        expect(sql).toContain("l.archived_at is null");
        expect(sql).toContain("li.status in ('planned', 'unpaid', 'partial', 'late')");
        return {
          rows: [
            {
              id: "88888888-8888-4888-8888-000000000001",
              name: "Halk CNC Yatırım Kredisi (Taksit #6)",
              due_date: "2026-07-09", // 3 days upcoming
              amount: "64000",
              status: "planned",
              provider: "Halk",
            },
            {
              id: "88888888-8888-4888-8888-000000000002",
              name: "Deniz Rotatif Kredi (Taksit #3)",
              due_date: "2026-07-04", // 2 days overdue
              amount: "45000",
              status: "late",
              provider: "Deniz",
            },
          ],
          rowCount: 2,
        };
      }

      if (sql.startsWith("insert into public.reminder_deliveries")) {
        const [ruleId, entityTable, entityId, scheduledFor] = params as [string, string, string, string];
        const uniqueKey = `${ruleId}|${entityTable}|${entityId}|${scheduledFor}`;
        if (deliveries.has(uniqueKey)) {
          return { rows: [], rowCount: 0 };
        }
        deliveries.add(uniqueKey);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unhandled SQL in reminders test: ${sql}`);
    });

    const fakeClient = { query, release: vi.fn() } as unknown as PoolClient;
    const fakePool = { query, connect: vi.fn(async () => fakeClient) } as unknown as Pool;

    // 1. Seed default check + loan_installment rules & test custom rule CRUD + toggle
    const seeded = await ensureDefaultMaturityRules(fakePool, ACTOR_ID);
    expect(seeded).toBe(10); // 5 check + 5 loan_installment

    const customEmailRuleId = await upsertReminderRule(
      fakePool,
      {
        name: "Yüksek Tutarlı Çek 3 Gün Önce E-posta",
        targetKind: "check",
        offsetDays: 3,
        channel: "email",
        minAmount: 50000,
        isActive: true,
      },
      ACTOR_ID,
    );
    expect(rules.get(customEmailRuleId)?.channel).toBe("email");

    const toggledOff = await toggleReminderRule(fakePool, { id: customEmailRuleId, isActive: false }, ACTOR_ID);
    expect(toggledOff.isActive).toBe(false);

    // 2. Run maturity scan on 2026-07-06:
    //    - Check #1 (due 2026-07-09, in_portfolio) matches check +3d telegram rule (custom email rule is toggled off!)
    //    - Check #2 (due 2026-07-02, issued_to_vendor, overdue) matches check -1d overdue rule
    //    - Loan Installment #1 (due 2026-07-09, planned) matches loan_installment +3d rule
    //    - Loan Installment #2 (due 2026-07-04, late, overdue) matches loan_installment -1d overdue rule
    const s1 = await scheduleReminders(fakePool, "2026-07-06");
    expect(s1.eligible).toBe(4);
    expect(s1.inserted).toBe(4);
    expect(s1.duplicatesSkipped).toBe(0);

    // 3. Re-running maturity scan on same day (and next day for already-overdue items) is strictly idempotent!
    const s2 = await scheduleReminders(fakePool, "2026-07-06");
    expect(s2.eligible).toBe(4);
    expect(s2.inserted).toBe(0);
    expect(s2.duplicatesSkipped).toBe(4);

    // Pure helper sanity check: closed/paid/archived statuses never fire
    const closedCheckEligible = eligibleMaturityDeliveries(
      [...rules.values()],
      [
        {
          entityTable: "checks",
          entityId: "77777777-7777-4777-8777-999999999999",
          name: "Tahsil Edilmiş Çek",
          dueDate: "2026-07-09",
          amount: 90000,
          status: "collected",
          owner: "Akon",
          provider: "Halk",
          riskReasons: [],
        },
      ],
      "2026-07-06",
    );
    expect(closedCheckEligible).toHaveLength(0);
  });
});
