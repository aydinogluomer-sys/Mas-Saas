import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { apiError, withApiHandler } from "@/lib/api-response";
import { CORRELATION_HEADER } from "@/lib/correlation";
import { istanbulDateISO } from "@/lib/reports/rules";
import { ANALYSES } from "@/lib/analytics/registry";
import {
  runAgeingDistribution, runCashBridge, runParetoConcentration,
  runPeriodOverPeriod, runRollingTrend, runVarianceDecomposition,
  runWorkingCapitalDecomposition,
} from "@/lib/analytics/engine";
import { rowsToCsv, toXlsxBuffer, type SheetSpec } from "@/lib/analytics/export";
import type { ReproducibilityStamp } from "@/lib/analytics/reproducibility";

export const dynamic = "force-dynamic";

// Zod at the boundary: both values come from a query string, which is user input.
const querySchema = z.object({
  analysis: z.enum(Object.keys(ANALYSES) as [string, ...string[]]),
  format: z.enum(["xlsx", "csv"]),
});

type Row = (string | number | null)[];

/**
 * Turn one analysis into sheet rows plus its stamp.
 *
 * Unknown values export as an EMPTY cell, never as 0 — a spreadsheet full of fabricated zeroes is
 * worse than one with gaps, because SUM() adds them up without complaint.
 */
async function buildSheets(analysisId: string, asOf: string): Promise<{ sheets: SheetSpec[]; stamp: ReproducibilityStamp }> {
  const pool = getPool();
  switch (analysisId) {
    case "variance_decomposition": {
      const { result, stamp } = await runVarianceDecomposition(pool, asOf);
      return {
        stamp,
        sheets: [{
          name: "Varyans",
          rows: [["Kalem", "Bütçe", "Gerçekleşen", "Sapma", "Yön", "Pay"],
            ...result.rows.map((r): Row => [r.label, r.budget, r.actual, r.value, r.direction, r.share])],
        }],
      };
    }
    case "pareto_concentration": {
      const { result, stamp, summary } = await runParetoConcentration(pool, asOf);
      return {
        stamp,
        sheets: [{
          name: "Yogunlasma",
          rows: [
            ["Karşı taraf", "Maruziyet", "Pay", "Kümülatif pay", "Kritik azınlıkta"],
            ...result.rows.map((r): Row => [r.label, r.value, r.share, r.cumulativeShare, r.inVitalFew ? "evet" : "hayır"]),
            [],
            ["Eşiğe ulaşan karşı taraf sayısı", summary?.vitalFewCount ?? null],
            ["Toplam karşı taraf", summary?.totalCount ?? null],
          ],
        }],
      };
    }
    case "working_capital_decomposition": {
      const { result, stamp, cycleDays } = await runWorkingCapitalDecomposition(pool, asOf);
      return {
        stamp,
        sheets: [{
          name: "Isletme sermayesi",
          rows: [
            ["Bileşen", "Gün", "İşaret", "Ölçülemeyiş sebebi"],
            ...result.rows.map((r): Row => [r.label, r.days, r.sign, r.unmeasurableReason]),
            [],
            ["Nakit döngüsü (envanter hariç)", cycleDays],
          ],
        }],
      };
    }
    case "cash_bridge": {
      const months = await pool.query(
        `select to_char(min(month_start),'YYYY-MM') a, to_char(max(month_start),'YYYY-MM') b
           from public.cashflow_months`);
      const from = months.rows[0]?.a ?? asOf.slice(0, 7);
      const to = months.rows[0]?.b ?? asOf.slice(0, 7);
      const { result, stamp, computedEnd, reconciles, difference } = await runCashBridge(pool, from, to, asOf);
      return {
        stamp,
        sheets: [{
          name: "Nakit koprusu",
          rows: [
            ["Adım", "Tür", "Değer", "Kümülatif"],
            ...result.rows.map((r): Row => [r.label, r.kind, r.value, r.runningTotal]),
            [],
            ["Hesaplanan kapanış", computedEnd],
            ["Mutabık mı", reconciles == null ? "—" : reconciles ? "evet" : "HAYIR"],
            ["Fark", difference],
          ],
        }],
      };
    }
    case "ageing_distribution": {
      const sales = await runAgeingDistribution(pool, "sales", asOf);
      const purchase = await runAgeingDistribution(pool, "purchase", asOf);
      return {
        stamp: sales.stamp,
        sheets: [{
          name: "Yaslandirma",
          rows: [
            ["Kova", "Alacak", "Alacak adet", "Borç", "Borç adet"],
            ...sales.result.rows.map((r, i): Row => [
              r.bucketLabel, r.amount, r.count,
              purchase.result.rows[i]?.amount ?? null, purchase.result.rows[i]?.count ?? null,
            ]),
          ],
        }],
      };
    }
    case "period_over_period": {
      const { result, stamp } = await runPeriodOverPeriod(pool, "mom", asOf);
      return {
        stamp,
        sheets: [{
          name: "Donemsel",
          rows: [
            ["Dönem", "Bu dönem", "Önceki dönem", "Fark", "Değişim oranı", "Ölçülemeyiş sebebi"],
            ...result.rows.map((r): Row => [r.key, r.current, r.previous, r.delta, r.changeRatio, r.unmeasurableReason]),
          ],
        }],
      };
    }
    case "rolling_trend":
    default: {
      const { result, stamp } = await runRollingTrend(pool, 30, asOf);
      return {
        stamp,
        sheets: [{
          name: "Hareketli pencere",
          rows: [
            ["Gün", "30 günlük toplam", "Bilinen", "Bilinmeyen", "Kısmi pencere"],
            ...result.rows.map((r): Row => [r.key, r.value, r.knownCount, r.unknownCount, r.partial ? "evet" : "hayır"]),
          ],
        }],
      };
    }
  }
}

export async function GET(request: Request) {
  return withApiHandler(request, async ({ requestId }) => {
    const user = await getCurrentUser();
    if (!user) return apiError(401, "Yetkisiz.", { code: "unauthorized", requestId });

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      analysis: url.searchParams.get("analysis") ?? "",
      format: url.searchParams.get("format") ?? "",
    });
    if (!parsed.success) {
      return apiError(400, "Geçersiz analiz veya biçim.", { code: "bad_request", requestId });
    }

    const asOf = istanbulDateISO();
    const { sheets, stamp } = await buildSheets(parsed.data.analysis, asOf);
    const base = `${parsed.data.analysis}-${asOf}`;

    if (parsed.data.format === "csv") {
      // The provenance line rides along as a comment row: a CSV that loses its stamp becomes an
      // anonymous column of numbers the moment it is mailed on.
      const csv = rowsToCsv([
        ...sheets[0].rows,
        [],
        [`# ${stamp.analysisId} · sürüm ${stamp.versionFingerprint} · ${stamp.input.asOf} · özet ${stamp.digest}`],
      ]);
      // BOM so Excel on a Turkish locale opens UTF-8 correctly.
      return new NextResponse("﻿" + csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${base}.csv"`,
          [CORRELATION_HEADER]: requestId,
        },
      });
    }

    const buffer = toXlsxBuffer(sheets, stamp);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${base}.xlsx"`,
        [CORRELATION_HEADER]: requestId,
      },
    });
  });
}
