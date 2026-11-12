import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  COUNTERPARTY_SCORECARD_MODEL_CONSTANTS,
  COUNTERPARTY_TIER_LABEL,
  computeCounterpartyScorecard,
  loadCounterpartyScorecards,
} from "./scorecard";

describe("computeCounterpartyScorecard — BLANK != ZERO invariants", () => {
  it("keeps medianDbtDays, p75DbtDays, lateRatio, and promiseKeptRatio null on empty history and assigns insufficient_history", () => {
    const res = computeCounterpartyScorecard({
      partyId: "00000000-0000-4000-8000-000000000001",
      partyName: "Yeni Açılan Cari A.Ş.",
      partyType: "customer",
    });

    expect(res.settledInvoiceCount).toBe(0);
    expect(res.medianDbtDays).toBeNull();
    expect(res.p75DbtDays).toBeNull();
    expect(res.lateRatio).toBeNull();
    expect(res.promiseKeptCount).toBe(0);
    expect(res.promiseBrokenCount).toBe(0);
    expect(res.promisePendingCount).toBe(0);
    expect(res.promiseKeptRatio).toBeNull();
    expect(res.tier).toBe("insufficient_history");
    expect(res.tierLabel).toBe(COUNTERPARTY_TIER_LABEL.insufficient_history);
    expect(res.signals).toEqual(["insufficient_behavioral_history"]);
    expect(res.recommendedTermsAction).toContain("Yetersiz geçmiş");
  });

  it("refuses to compute DBT percentiles or Tier A when settledInvoiceCount < 3 (1 or 2 settled invoices)", () => {
    const oneInvoice = computeCounterpartyScorecard({
      partyId: "p-1",
      partyName: "Tek Faturalı Müşteri",
      dbtSamples: [-4],
      fallbackAvgDbtDays: -4,
    });
    expect(oneInvoice.settledInvoiceCount).toBe(1);
    expect(oneInvoice.medianDbtDays).toBeNull();
    expect(oneInvoice.p75DbtDays).toBeNull();
    expect(oneInvoice.lateRatio).toBe(0);
    expect(oneInvoice.tier).toBe("insufficient_history");

    const twoInvoices = computeCounterpartyScorecard({
      partyId: "p-2",
      partyName: "İki Faturalı Müşteri",
      dbtSamples: [0, -2],
      fallbackAvgDbtDays: -1,
    });
    expect(twoInvoices.settledInvoiceCount).toBe(2);
    expect(twoInvoices.medianDbtDays).toBeNull();
    expect(twoInvoices.p75DbtDays).toBeNull();
    expect(twoInvoices.lateRatio).toBe(0);
    expect(twoInvoices.tier).toBe("insufficient_history");
  });

  it("keeps promiseKeptRatio null when closed promises === 0 even if pending promises exist", () => {
    const res = computeCounterpartyScorecard({
      partyId: "p-pending",
      partyName: "Açık Sözlü Cari",
      promiseKeptCount: 0,
      promiseBrokenCount: 0,
      promisePendingCount: 2,
    });

    expect(res.promiseKeptRatio).toBeNull();
    expect(res.tier).toBe("tier_b_watch");
    expect(res.signals).toContain("promise_pending_open");
  });

  it("does not fabricate Tier A from a single kept promise (< 2 kept promises and < 3 settled invoices)", () => {
    const res = computeCounterpartyScorecard({
      partyId: "p-1kept",
      partyName: "Tek Söz Tutan Cari",
      promiseKeptCount: 1,
      promiseBrokenCount: 0,
    });

    expect(res.promiseKeptRatio).toBe(1);
    expect(res.tier).toBe("insufficient_history");
  });
});

describe("computeCounterpartyScorecard — Tier D, C, B, A deterministic boundaries", () => {
  it("escalates immediately to Tier D on a single bounced check even with stellar DBT and PTP history", () => {
    const res = computeCounterpartyScorecard({
      partyId: "p-bounced",
      partyName: "Karşılıksız Çekli Müşteri",
      dbtSamples: [-5, -3, -2, 0, 0],
      promiseKeptCount: 6,
      promiseBrokenCount: 0,
      bouncedCheckCount: 1,
      bouncedByCurrency: { TRY: "75000.00" },
    });

    expect(res.tier).toBe("tier_d_critical");
    expect(res.signals).toContain("bounced_check_recorded");
    expect(res.bouncedCheckCount).toBe(1);
    expect(res.bouncedByCurrency).toEqual({ TRY: 75000 });
    expect(res.recommendedTermsAction).toContain("Karşılıksız çek");
  });

  it("enforces exact P75 DBT > 30 boundary between Tier C (30d) and Tier D (31d)", () => {
    expect(COUNTERPARTY_SCORECARD_MODEL_CONSTANTS.isModelConstant).toBe(true);
    expect(COUNTERPARTY_SCORECARD_MODEL_CONSTANTS.criticalP75DbtDays).toBe(30);

    // [15, 20, 30, 30] -> median = 25, P75 = 30 (not > 30 => Tier C)
    const atBoundary = computeCounterpartyScorecard({
      partyId: "p-p75-30",
      partyName: "Sınırda Cari",
      dbtSamples: [15, 20, 30, 30],
    });
    expect(atBoundary.p75DbtDays).toBe(30);
    expect(atBoundary.tier).toBe("tier_c_strained");

    // [15, 20, 30, 34] -> P75 pos = 2.25 => 30 + 0.25 * 4 = 31 (> 30 => Tier D)
    const aboveBoundary = computeCounterpartyScorecard({
      partyId: "p-p75-31",
      partyName: "Kritik Gecikmeli Cari",
      dbtSamples: [15, 20, 30, 34],
    });
    expect(aboveBoundary.p75DbtDays).toBe(31);
    expect(aboveBoundary.tier).toBe("tier_d_critical");
    expect(aboveBoundary.signals).toContain("p75_dbt_exceeds_critical_cutoff");
  });

  it("enforces repeated broken promises boundary: >= 2 broken AND keptRatio < 0.50 => Tier D, keptRatio === 0.50 => Tier C", () => {
    const tierD = computeCounterpartyScorecard({
      partyId: "p-ptp-d",
      partyName: "Söz Kırımı Ağır Cari",
      promiseKeptCount: 1,
      promiseBrokenCount: 2,
    });
    expect(tierD.promiseKeptRatio).toBeCloseTo(1 / 3, 8);
    expect(tierD.tier).toBe("tier_d_critical");
    expect(tierD.signals).toContain("repeated_broken_promises_low_ratio");

    const tierCAtHalf = computeCounterpartyScorecard({
      partyId: "p-ptp-c",
      partyName: "Yarı Yarıya Söz Cari",
      promiseKeptCount: 2,
      promiseBrokenCount: 2,
    });
    expect(tierCAtHalf.promiseKeptRatio).toBe(0.5);
    expect(tierCAtHalf.tier).toBe("tier_c_strained");
    expect(tierCAtHalf.signals).toContain("promise_broken_recorded");
  });

  it("enforces Tier C vs Tier B median DBT boundary (10d vs 11d) and lateRatio >= 0.40 boundary", () => {
    const watchAt10 = computeCounterpartyScorecard({
      partyId: "p-med-10",
      partyName: "Medyan 10g Cari",
      settledInvoiceCount: 5,
      fallbackAvgDbtDays: 10,
      lateRatio: 0.2,
    });
    expect(watchAt10.medianDbtDays).toBe(10);
    expect(watchAt10.tier).toBe("tier_b_watch");
    expect(watchAt10.signals).toContain("median_dbt_positive");

    const strainedAt11 = computeCounterpartyScorecard({
      partyId: "p-med-11",
      partyName: "Medyan 11g Cari",
      settledInvoiceCount: 5,
      fallbackAvgDbtDays: 11,
      lateRatio: 0.2,
    });
    expect(strainedAt11.medianDbtDays).toBe(11);
    expect(strainedAt11.tier).toBe("tier_c_strained");
    expect(strainedAt11.signals).toContain("median_dbt_exceeds_watch_cutoff");

    // 2 of 5 late => exact 0.40 => Tier C
    const lateRatioHit = computeCounterpartyScorecard({
      partyId: "p-late-40",
      partyName: "Geç Oran %40 Cari",
      dbtSamples: [-5, -2, 0, 3, 6],
    });
    expect(lateRatioHit.medianDbtDays).toBe(0);
    expect(lateRatioHit.lateRatio).toBe(0.4);
    expect(lateRatioHit.tier).toBe("tier_c_strained");
    expect(lateRatioHit.signals).toContain("late_settlement_ratio_high");
  });

  it("places an on-time customer into Tier B Watch when endorsed checks create contingent recourse risk", () => {
    const res = computeCounterpartyScorecard({
      partyId: "p-recourse",
      partyName: "Ciro Rücu Riski Taşıyan Müşteri",
      dbtSamples: [-3, -1, 0, 0],
      contingentRecourseByCurrency: { TRY: "85000.00" },
    });

    expect(res.medianDbtDays).toBe(0);
    expect(res.tier).toBe("tier_b_watch");
    expect(res.signals).toContain("contingent_endorsement_recourse_open");
    expect(res.recommendedTermsAction).toContain("Ciro rücu");
  });

  it("awards Tier A to punctual counterparties (>=3 on-time invoices or >=2 kept promises with 0 broken)", () => {
    const byInvoices = computeCounterpartyScorecard({
      partyId: "p-tier-a-inv",
      partyName: "Disiplinli Sanayi A.Ş.",
      dbtSamples: [-4, -2, 0, 0, 2],
      activeCheckPortfolioByCurrency: { TRY: "40000.00" },
    });
    expect(byInvoices.settledInvoiceCount).toBe(5);
    expect(byInvoices.medianDbtDays).toBe(0);
    expect(byInvoices.lateRatio).toBe(0.2);
    expect(byInvoices.tier).toBe("tier_a_reliable");
    expect(byInvoices.signals).toContain("settled_invoices_on_time");

    const byPromises = computeCounterpartyScorecard({
      partyId: "p-tier-a-ptp",
      partyName: "Sözüne Sadık Ticaret Ltd.",
      promiseKeptCount: 3,
      promiseBrokenCount: 0,
    });
    expect(byPromises.promiseKeptRatio).toBe(1);
    expect(byPromises.tier).toBe("tier_a_reliable");
    expect(byPromises.signals).toContain("promises_kept_reliably");
  });
});

describe("computeCounterpartyScorecard — native multi-currency Big.js check & recourse buckets", () => {
  it("keeps TRY, USD, and EUR strictly separated with exact half-up Big.js rounding and counts unpriced checks", () => {
    // 20 items of "0.07" in float64 += would drift to 1.3999999999999997; Big.js yields exact 1.4
    // "1262.145" in JS toFixed(2) is "1262.14", whereas Postgres / MoneyBig half-up is 1262.15
    const driftChecks = Array.from({ length: 20 }, () => ({
      bucket: "active_portfolio" as const,
      currency: "USD",
      amount: "0.07",
    }));

    const res = computeCounterpartyScorecard({
      partyId: "p-fx",
      partyName: "Çok Dövizli İhracat Müşterisi",
      dbtSamples: [-2, 0, 0, -1],
      checks: [
        ...driftChecks,
        { bucket: "active_portfolio", currency: "TRY", amount: "1262.145" },
        { bucket: "active_portfolio", currency: "EUR", amount: "4500.50" },
        { bucket: "contingent_recourse", currency: "TRY", amount: "50000.25" },
        { bucket: "contingent_recourse", currency: "TRY", amount: "24999.75" },
        { bucket: "contingent_recourse", currency: "EUR", amount: "12000.00" },
        { bucket: "contingent_recourse", currency: "USD", amount: null },
        { bucket: "endorsed_received", currency: "USD", amount: "8200.00" },
      ],
    });

    expect(res.activeCheckPortfolioByCurrency).toEqual({
      TRY: 1262.15,
      EUR: 4500.5,
      USD: 1.4,
    });
    expect(res.contingentRecourseByCurrency).toEqual({
      TRY: 75000,
      EUR: 12000,
    });
    expect(res.endorsedReceivedByCurrency).toEqual({
      USD: 8200,
    });
    expect(res.bouncedByCurrency).toEqual({});
    expect(res.activeCheckCount).toBe(22);
    expect(res.contingentRecourseCount).toBe(4);
    expect(res.endorsedReceivedCount).toBe(1);
    expect(res.unknownCheckAmountCount).toBe(1);
    expect(res.tier).toBe("tier_b_watch");
  });
});

describe("loadCounterpartyScorecards — SQL decoding, 42P01/42703 fallback, and 42501 rethrow", () => {
  const P_CRIT = "00000000-0000-4000-8000-000000000011";
  const P_REL = "00000000-0000-4000-8000-000000000022";
  const P_NEW = "00000000-0000-4000-8000-000000000033";

  it("decodes Postgres numeric strings via @/lib/money and orders scorecards by behavioral urgency", async () => {
    const queryMock = vi.fn(async (sql: string) => {
      if (sql.includes("from public.parties p")) {
        return {
          rows: [
            { party_id: P_NEW, party_name: "Yeni Cari", party_type: "customer", is_active: true },
            { party_id: P_REL, party_name: "Sağlam Makina A.Ş.", party_type: "customer", is_active: true },
            { party_id: P_CRIT, party_name: "Riskli Metal Ltd.", party_type: "customer", is_active: true },
          ],
        };
      }
      if (sql.includes("party_dbt")) {
        return {
          rows: [
            {
              party_id: P_REL,
              settled_invoice_count: "4",
              late_invoice_count: "0",
              dbt_samples: [-4, -2, -1, 0],
              profile_late_ratio: "0.0000",
            },
            {
              party_id: P_CRIT,
              settled_invoice_count: "2",
              late_invoice_count: "1",
              dbt_samples: [0, 8],
              profile_late_ratio: "0.5000",
            },
          ],
        };
      }
      if (sql.includes("from public.promise_to_pay")) {
        return {
          rows: [
            {
              party_id: P_REL,
              promise_kept_count: "3",
              promise_broken_count: "0",
              promise_pending_count: "0",
            },
            {
              party_id: P_CRIT,
              promise_kept_count: "0",
              promise_broken_count: "1",
              promise_pending_count: "0",
            },
          ],
        };
      }
      if (sql.includes("from public.checks c")) {
        return {
          rows: [
            {
              party_id: P_REL,
              bucket: "active_portfolio",
              currency: "TRY",
              item_count: "2",
              unknown_amount_count: "0",
              known_amount: "125000.55",
            },
            {
              party_id: P_REL,
              bucket: "active_portfolio",
              currency: "USD",
              item_count: "1",
              unknown_amount_count: "0",
              known_amount: "8400.45",
            },
            {
              party_id: P_CRIT,
              bucket: "bounced",
              currency: "TRY",
              item_count: "1",
              unknown_amount_count: "0",
              known_amount: "42000.00",
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL in mock: ${sql}`);
    });

    const pool = { query: queryMock } as unknown as Pool;
    const rows = await loadCounterpartyScorecards(pool, { limit: 50 });

    expect(rows.map((r) => r.partyId)).toEqual([P_CRIT, P_REL, P_NEW]);

    const crit = rows[0];
    expect(crit.tier).toBe("tier_d_critical");
    expect(crit.medianDbtDays).toBeNull(); // 2 settled invoices < 3 => BLANK != ZERO
    expect(crit.p75DbtDays).toBeNull();
    expect(crit.bouncedCheckCount).toBe(1);
    expect(crit.bouncedByCurrency).toEqual({ TRY: 42000 });

    const rel = rows[1];
    expect(rel.tier).toBe("tier_a_reliable");
    expect(rel.medianDbtDays).toBe(-1);
    expect(rel.activeCheckPortfolioByCurrency).toEqual({
      TRY: 125000.55,
      USD: 8400.45,
    });

    const fresh = rows[2];
    expect(fresh.tier).toBe("insufficient_history");
    expect(fresh.medianDbtDays).toBeNull();
    expect(fresh.promiseKeptRatio).toBeNull();
  });

  it("degrades gracefully when optional views/tables return 42P01 / 42703 without 500ing", async () => {
    const missingRelError = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const missingColError = Object.assign(new Error("column does not exist"), { code: "42703" });

    let partiesAttempts = 0;
    let checksAttempts = 0;

    const queryMock = vi.fn(async (sql: string) => {
      if (sql.includes("from public.parties p")) {
        partiesAttempts++;
        if (sql.includes("counterparty_exposure")) throw missingRelError;
        return {
          rows: [{ party_id: P_NEW, party_name: "Pre-Migration Cari", party_type: "vendor", is_active: true }],
        };
      }
      if (sql.includes("public.invoices")) {
        throw missingRelError;
      }
      if (sql.includes("promise_to_pay") || sql.includes("customer_collection_score")) {
        throw missingRelError;
      }
      if (sql.includes("from public.checks c")) {
        checksAttempts++;
        if (sql.includes("endorsed_to_party_id")) throw missingColError;
        return {
          rows: [
            {
              party_id: P_NEW,
              bucket: "active_portfolio",
              currency: "TRY",
              item_count: "1",
              unknown_amount_count: "0",
              known_amount: "15000.00",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const pool = { query: queryMock } as unknown as Pool;
    const rows = await loadCounterpartyScorecards(pool, { limit: 20 });

    expect(partiesAttempts).toBe(2);
    expect(checksAttempts).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].partyId).toBe(P_NEW);
    expect(rows[0].activeCheckPortfolioByCurrency).toEqual({ TRY: 15000 });
    expect(rows[0].tier).toBe("tier_b_watch");
  });

  it("rethrows 42501 permission denied instead of masking authorization failures", async () => {
    const permDenied = Object.assign(new Error("permission denied for relation promise_to_pay"), {
      code: "42501",
    });

    const queryMock = vi.fn(async (sql: string) => {
      if (sql.includes("from public.parties p")) {
        return {
          rows: [{ party_id: P_REL, party_name: "Yetki Testi Cari", party_type: "customer", is_active: true }],
        };
      }
      if (sql.includes("public.invoices")) {
        return { rows: [] };
      }
      if (sql.includes("promise_to_pay")) {
        throw permDenied;
      }
      return { rows: [] };
    });

    const pool = { query: queryMock } as unknown as Pool;
    await expect(loadCounterpartyScorecards(pool)).rejects.toMatchObject({ code: "42501" });
  });
});
