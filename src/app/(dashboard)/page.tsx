import Link from "next/link";
import { getPool } from "@/lib/db";
import { ensureWindow, loadThresholds } from "@/lib/radar/engine";
import { instancesBetween, instancesOn, monthSummary, overdueOpen } from "@/lib/radar/queries";
import { buildProjection, concentration } from "@/lib/radar/rules";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadDebtOverlay, listReports } from "@/lib/reports/engine";
import { deliveryCounts } from "@/lib/reminders/engine";
import { loadCapacityModels, loadCostModels } from "@/lib/production/engine";
import { priceMargin } from "@/lib/production/rules";
import { createActionFromHomeAction } from "@/app/(dashboard)/data-quality/actions";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { buildActions, pickHeadlineRisk, type CockpitFacts } from "@/lib/home/cockpit";
import { Badge, type Tone } from "@/components/ui/badge";
import { SourceProofDisclosure, type ProofItem } from "@/components/facts/source-proof";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KeyStat, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const OPEN = new Set(["unpaid", "partial", "planned", "late"]);
const knownOutflow = (rows: Array<{ amount: number | null; status: string }>) => {
  let total = 0, count = 0, missing = 0;
  for (const r of rows) {
    if (!OPEN.has(r.status)) continue;
    count++;
    if (r.amount == null) missing++;
    else if (r.amount > 0) total += r.amount;
  }
  return { total, count, missing };
};
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const SEV_TONE: Record<string, Tone> = { critical: "red", high: "red", medium: "amber", low: "neutral" };
const ACTION_FACT_KEY: Record<string, string> = {
  overdue: "overdue_payment_load",
  first_negative: "first_negative_month",
  debt_pressure: "debt_pressure_months",
  missing: "missing_amount_count",
  concentration: "top_customer_concentration",
  stale_rate: "stale_rate_flags",
};

export default async function AnaEkranPage() {
  const pool = getPool();
  const today = istanbulDateISO();
  const monthStart = today.slice(0, 7) + "-01";
  const weekEnd = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);
  await ensureWindow(pool, today); // idempotent (same call radar makes)

  const [todayRows, weekRows, overdue, summary, months] = await Promise.all([
    instancesOn(pool, today),
    instancesBetween(pool, today, weekEnd),
    overdueOpen(pool, today),
    monthSummary(pool, monthStart),
    loadCashMonths(pool),
  ]);

  // onboarding state: nothing imported yet
  const hasData = summary.total_count > 0 || months.length > 0;
  if (!hasData) {
    return (
      <>
        <PageHeader title="Ana Ekran" subtitle="MAS Nakit Radar — operatör kokpiti" />
        <Panel title="BAŞLANGIÇ" accent="info">
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            Henüz veri yok. <Link className="underline underline-offset-2" href="/imports">İçe aktarım</Link> sayfasından
            çalışma dosyasını yükleyin ve modüllere aktarın; sonra bu ekran bugünkü ödemeleri, nakit riskini ve
            yapılacakları özetler.
          </p>
          <div className="mt-2">
            <Link href="/admin" className="font-mono text-[11px] underline underline-offset-2" style={{ color: "var(--info)" }}>
              Yönetim → içe aktarım, ayarlar →
            </Link>
          </div>
        </Panel>
      </>
    );
  }

  const [overlay, reports, reminders, caps, costs, incomeLines, decisionFacts, dataQuality, t] = await Promise.all([
    loadDebtOverlay(pool),
    listReports(pool),
    deliveryCounts(pool),
    loadCapacityModels(pool),
    loadCostModels(pool),
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='customer_income'`),
    loadDecisionFacts(pool, today),
    loadDataQualityCenter(pool),
    loadThresholds(pool),
  ]);
  void t;

  // production margin snapshot: any operation sold below its scenario's own break-even?
  const marginLoss = costs.some(
    (c) => priceMargin(c.breakEven, c.akonFreze).loss || priceMargin(c.breakEven, c.akonTorna).loss,
  );

  const proj = buildProjection(months);
  const tOut = knownOutflow(todayRows);
  const wOut = knownOutflow(weekRows);
  const oOut = knownOutflow(overdue);
  const conc = concentration(incomeLines.rows);
  const topConc = conc.entries[0] ? { key: conc.entries[0].key, ratio: conc.entries[0].ratio } : null;
  const debtPressureMonths = overlay.filter((o) => o.pressure === "high").length;
  const cap = caps[0] as unknown as { isStaleRate?: boolean } | undefined;

  const facts: CockpitFacts = {
    todayKnownOutflow: tOut.total, todayCount: tOut.count, todayMissing: tOut.missing,
    next7KnownOutflow: wOut.total, next7Count: wOut.count,
    overdueCount: oOut.count, overdueKnownOutflow: oOut.total,
    firstNegativeMonth: proj.firstNegativeMonth, worstMonth: proj.worstMonth, worstBalance: proj.worstBalance,
    monthMissingCount: summary.missing_count,
    topConcentration: topConc,
    debtPressureMonths,
    failedReminders: reminders.failed,
    staleProductionRate: !!cap?.isStaleRate,
  };
  const headline = pickHeadlineRisk(facts);
  const actions = buildActions(facts);
  const topDecisionFacts = (decisionFacts.some((f) => f.severity !== "low")
    ? decisionFacts.filter((f) => f.severity !== "low")
    : decisionFacts
  ).slice(0, 5);
  const runwayFact = decisionFacts.find((f) => f.key === "cash_runway");
  const proofForAction = (key: string): ProofItem[] => {
    const action = actions.find((a) => a.key === key);
    const fact = decisionFacts.find((f) => f.key === ACTION_FACT_KEY[key])
      ?? decisionFacts.find((f) => f.sourceHref === action?.evidenceHref);
    if (!fact) return [];
    return [{
      key: fact.key,
      title: fact.title,
      value: fact.value,
      confidence: fact.confidence,
      freshness: fact.freshness,
      explanation: fact.explanation,
      sourceHref: fact.sourceHref,
    }];
  };
  const lastReport = reports[0];

  return (
    <>
      <PageHeader
        title="Ana Ekran"
        subtitle="Bugün ne ödenecek · 7 günlük çıkış · geciken · nakit riski · ne yapmalıyım"
        meta={<Badge tone="neutral" dot>bugün {today.slice(8)}.{today.slice(5, 7)}</Badge>}
      />

      {/* 1) 20 saniyede cevap: büyük sayılar */}
      <div className="border px-3 py-3" style={{ borderColor: `var(--${headline.tone})`, background: `color-mix(in srgb, var(--${headline.tone}) 8%, transparent)`, borderRadius: "var(--radius)" }}>
        <div className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>20 saniyede cevap</div>
        <div className="mt-1 text-lg font-semibold" style={{ color: `var(--${headline.tone})` }}>{headline.text}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge tone={dataQuality.decisionConfidence >= 80 ? "green" : dataQuality.decisionConfidence >= 55 ? "amber" : "red"}>
            karar guveni %{dataQuality.decisionConfidence} / {dataQuality.decisionConfidenceLabel}
          </Badge>
          {dataQuality.decisionConfidence < 80 && (
            <Badge tone="amber">{dataQuality.highOpenCount} yuksek/acil review · {dataQuality.missingAmountCount} eksik tutar</Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KeyStat label="Bugün çıkış" value={fmtTL(tOut.total)} tone={tOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${tOut.count} ödeme${tOut.missing > 0 ? ` · ${tOut.missing} eksik` : ""}`} />
        <KeyStat label="7 günde çıkış" value={fmtTL(wOut.total)} tone={wOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${wOut.count} ödeme`} />
        <KeyStat label="Geciken" value={oOut.count} tone={oOut.count > 0 ? "neg" : "pos"} href="/radar"
          sub={oOut.count > 0 ? `bilinen ${fmtTL(oOut.total)}` : "yok"} />
        <KeyStat label="Nakit runway" value={runwayFact?.value ?? "â€”"} tone={runwayFact?.severity === "critical" || runwayFact?.severity === "high" ? "neg" : runwayFact?.severity === "medium" ? "warn" : "pos"} href="/cashflow"
          sub={runwayFact?.explanation ?? "projeksiyon"} />
        <KeyStat label="İlk negatif ay" value={ym(proj.firstNegativeMonth)} tone={proj.firstNegativeMonth ? "neg" : "pos"} href="/cashflow"
          sub={proj.firstNegativeMonth ? "kasa eksiye geçiyor" : "negatif ay yok"} />
      </div>

      <Panel title="Karar sinyalleri">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {topDecisionFacts.map((f) => (
            <Link
              key={f.key}
              href={f.sourceHref}
              className="card-hover border px-2.5 py-2"
              style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>{f.title}</div>
                  <div className="mt-0.5 font-mono text-sm tabular-nums" style={{ color: "var(--text-1)" }}>{f.value}</div>
                </div>
                <Badge tone={SEV_TONE[f.severity]}>{f.severity === "critical" ? "acil" : f.severity === "high" ? "yüksek" : f.severity === "medium" ? "orta" : "düşük"}</Badge>
              </div>
              <p className="mt-1 text-[11px]" style={{ color: "var(--text-4)" }}>{f.explanation}</p>
            </Link>
          ))}
        </div>
      </Panel>

      {/* 3) Ne yapmalıyım? (max 5, deterministik) */}
      <Panel title="Ne yapmalıyım?">
        <ol className="space-y-1.5">
          {actions.map((a, i) => (
            <li key={a.key}>
              <div className="card-hover border px-2.5 py-2"
                style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <Link href={a.href} className="flex min-w-0 flex-1 items-start gap-2">
                  <span className="mt-0.5 font-mono text-[11px]" style={{ color: "var(--text-4)" }}>{i + 1}.</span>
                  <span className="flex-1 text-sm" style={{ color: "var(--text-1)" }}>{a.label}</span>
                  <Badge tone={SEV_TONE[a.severity]}>{a.severity === "critical" ? "acil" : a.severity === "high" ? "yüksek" : a.severity === "medium" ? "orta" : "düşük"}</Badge>
                </Link>
                <form action={createActionFromHomeAction} className="shrink-0">
                  <input type="hidden" name="title" value={a.label} />
                  <input type="hidden" name="severity" value={a.severity} />
                  <input type="hidden" name="sourceFactKey" value={a.key} />
                  <input type="hidden" name="sourceHref" value={a.evidenceHref} />
                  <input type="hidden" name="note" value={`${a.reason} ${a.impact}`} />
                  <input type="hidden" name="backTo" value="/" />
                  <button type="submit" className="border px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)" }}>
                    gorev
                  </button>
                </form>
                <div className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <div className="text-[11px]" style={{ color: "var(--text-3)" }}>{a.reason}</div>
                  <div className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{a.impact}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Link href={a.evidenceHref} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>kanit ekrani -&gt;</Link>
                  {a.scenarioHref && <Link href={a.scenarioHref} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>senaryo onerisi -&gt;</Link>}
                </div>
                <div className="mt-2">
                  <SourceProofDisclosure label="kanit paketi" items={proofForAction(a.key)} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      {/* 4) Durum şeridi: rapor / hatırlatma / üretim */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Son rapor</div>
          {lastReport ? (
            <Link href={`/reports/${lastReport.id}`} className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--text-1)" }}>
              {lastReport.report_type === "daily" ? "Günlük" : lastReport.report_type === "weekly" ? "Haftalık" : "Aylık"} · {lastReport.created_at}
            </Link>
          ) : (
            <Link href="/reports" className="mt-1 block text-sm" style={{ color: "var(--text-3)" }}>Henüz rapor yok — üret →</Link>
          )}
        </div>
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Hatırlatma durumu</div>
          <Link href="/reminders" className="mt-1 block text-sm" style={{ color: "var(--text-1)" }}>
            <span className="font-mono tabular-nums">{reminders.sent}</span> gönderildi · <span className="font-mono tabular-nums">{reminders.pending}</span> bekliyor
            {reminders.failed > 0 && <span style={{ color: "var(--neg)" }}> · {reminders.failed} başarısız</span>}
          </Link>
        </div>
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Üretim içgörüsü</div>
          <Link href="/production" className="mt-1 block text-sm" style={{ color: marginLoss ? "var(--neg)" : "var(--text-1)" }}>
            {caps.length === 0
              ? "Kapasite modeli yok"
              : marginLoss
                ? "Bazı operasyonlar başabaşın altında — zararına satış"
                : facts.staleProductionRate
                  ? "Oranlar eski tarife (stale) — analitik tahmin"
                  : "Kapasite/maliyet güncel"}
          </Link>
        </div>
      </div>
    </>
  );
}
