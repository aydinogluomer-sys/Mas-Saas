import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadCashRunwayAnalysis } from "@/lib/finance/cash-runway";
import { loadFxHedgingReport } from "@/lib/finance/fx-hedging";
import { runSandboxFromDatabase } from "@/lib/simulations/sandbox";
import {
  optimizePayablesDiscounts,
  type EarlyDiscountOffer,
} from "@/lib/finance/dynamic-discounting";
import {
  calculateCashPoolingArbitrage,
  type GroupEntityBalance,
} from "@/lib/treasury/cash-pooling";
import { verifyDatabaseAuditLogs } from "@/lib/audit/hash-chain";
import { CfoCockpitClient } from "./cockpit-client";

export const dynamic = "force-dynamic";

export default async function CfoCockpitPage() {
  await requireSession();
  const pool = getPool();
  const today = istanbulDateISO();

  // 1. Holding İçi Nakit Havuzlama Verisi (Grup şirketleri temsili dengesi)
  const groupEntities: GroupEntityBalance[] = [
    {
      entityId: "ent-uretim",
      entityName: "MAS Üretim ve Sanayi A.Ş.",
      cashBalanceTRY: 8500000,
      minCashFloorTRY: 2000000, // 6.5M TL serbest nakit fazlası
      externalBorrowingRatePct: 46,
      depositYieldRatePct: 32,
    },
    {
      entityId: "ent-pazarlama",
      entityName: "MAS Dağıtım & Perakende Ltd.",
      cashBalanceTRY: -3500000,
      minCashFloorTRY: 1000000, // 4.5M TL nakit açığı
      externalBorrowingRatePct: 49,
      depositYieldRatePct: 29,
    },
  ];

  // 2. Tüm motorları ve faturaları tek önbellek altında yükle
  const {
    offers,
    runwayReport,
    arbitrageReport,
    fxReport,
    simulationReport,
    auditReport,
  } = await cache.withCache(
    `cfo:cockpit:data:${today}`,
    async () => {
      const payablesRes = await pool.query(`
        select 
          i.id,
          i.invoice_no,
          coalesce(p.name, 'Tedarikçi Firma') as party_name,
          coalesce(i.gross_amount, 100000) as amount,
          to_char(coalesce(i.due_date, current_date + 45), 'YYYY-MM-DD') as due_date
        from public.invoices i
        left join public.parties p on p.id = i.party_id
        where i.direction = 'purchase' and i.status in ('open', 'partial')
        order by i.due_date asc
        limit 5
      `).catch(() => ({ rows: [] }));

      let computedOffers: EarlyDiscountOffer[] = [];
      if (payablesRes.rows.length >= 2) {
        computedOffers = payablesRes.rows.map((r, idx) => ({
          invoiceId: r.id,
          invoiceNo: r.invoice_no,
          counterpartyName: r.party_name,
          invoiceAmount: Number(r.amount),
          originalDueDate: String(r.due_date),
          earlyPaymentDate: today,
          discountPercent: 2.0 + idx * 0.5,
        }));
      } else {
        computedOffers = [
          {
            invoiceId: "inv-demo-1",
            invoiceNo: "FTR-2026-0089",
            counterpartyName: "Global Çelik & Sac Sanayi A.Ş.",
            invoiceAmount: 1850000,
            originalDueDate: "2026-11-25",
            earlyPaymentDate: today,
            discountPercent: 3.5,
          },
          {
            invoiceId: "inv-demo-2",
            invoiceNo: "FTR-2026-0104",
            counterpartyName: "Anadolu Polimer Kimya Ltd.",
            invoiceAmount: 720000,
            originalDueDate: "2026-11-15",
            earlyPaymentDate: today,
            discountPercent: 2.5,
          },
          {
            invoiceId: "inv-demo-3",
            invoiceNo: "FTR-2026-0155",
            counterpartyName: "Ege Lojistik & Antrepo Hizmetleri",
            invoiceAmount: 340000,
            originalDueDate: "2026-12-10",
            earlyPaymentDate: today,
            discountPercent: 1.0,
          },
        ];
      }

      const [runway, arbitrage, fx, simulation, audit] = await Promise.all([
        loadCashRunwayAnalysis(pool, today),
        optimizePayablesDiscounts(pool, computedOffers, 42.0),
        loadFxHedgingReport(pool),
        runSandboxFromDatabase(pool, {}),
        verifyDatabaseAuditLogs(pool, 500),
      ]);

      return {
        offers: computedOffers,
        runwayReport: runway,
        arbitrageReport: arbitrage,
        fxReport: fx,
        simulationReport: simulation,
        auditReport: audit,
      };
    },
    { ttlSeconds: 60, tags: [CACHE_TAGS.CASHFLOW, CACHE_TAGS.TREASURY, CACHE_TAGS.FX_RATES] }
  );

  const poolingReport = calculateCashPoolingArbitrage(groupEntities, today);

  return (
    <CfoCockpitClient
      initialRunway={runwayReport}
      initialArbitrage={arbitrageReport}
      initialFx={fxReport}
      initialSimulation={simulationReport}
      initialPooling={poolingReport}
      initialAudit={auditReport}
      sampleOffers={offers}
    />
  );
}
