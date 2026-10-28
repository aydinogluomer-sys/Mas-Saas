import Link from "next/link";
import { getPool } from "@/lib/db";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { moneyOrNull } from "@/lib/money";
import { loadThresholds } from "@/lib/radar/engine";
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
import type { ProofItem } from "@/components/facts/source-proof";
import { EvidenceDrawer } from "@/components/facts/evidence-drawer";
import { MiniTrend } from "@/components/home/mini-trends";
import { Panel, fmtTL } from "@/components/ui/panel";
import { foreignNote, isReportingCurrency, sumKnownReporting } from "@/lib/currency-policy";
import { KeyStat, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const OPEN = new Set(["unpaid", "partial", "planned", "late"]);
// PHASE 2.2 (#1): toplam yalnız TRY; TRY-dışı/para birimi bilinmeyen kalem toplamda YOK, sayılır
// (currency-policy.ts). `count` bütün açık kalemleri sayar — "kaç ödeme var" para biriminden bağımsız.
const knownOutflow = (rows: Array<{ amount: number | null; status: string; currency?: string | null }>) => {
  const open = rows.filter((r) => OPEN.has(r.status));
  const k = sumKnownReporting(open, (r) => r.amount, { positiveOnly: true });
  return { total: k.total, count: open.length, missing: k.missing, foreign: k.foreignCount };
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
const EMPTY_MODULES = [
  {
    href: "/imports",
    step: "01",
    title: "Excel İçe Aktarımı",
    desc: "Çalışma kitabı, sekme ve hücre kanıtları %100 ham haliyle korunarak arşivlenir.",
    badge: "İlk Adım",
  },
  {
    href: "/data-quality",
    step: "02",
    title: "Veri Kalitesi & Mutabakat",
    desc: "Eşleme incelemeleri, mutabakat kontrolleri ve karar güven skoru izlenir.",
    badge: "Doğrulama",
  },
  {
    href: "/radar",
    step: "03",
    title: "Ödeme Radarı & Takvim",
    desc: "Bugün, 7 gün, vadesi geçenler ve eksik tutarlı kayıtlar anlık takip edilir.",
    badge: "Operasyon",
  },
  {
    href: "/cashflow",
    step: "04",
    title: "Nakit Akışı & Runway",
    desc: "Nakit yakma hızı (burn rate), kasanın sıfırlanma günü ve What-If senaryoları.",
    badge: "Projeksiyon",
  },
  {
    href: "/finance/cockpit",
    step: "05",
    title: "CFO Karar Konsolu",
    desc: "Kredi limitleri, borç servisi, döviz açık pozisyonu ve arbitraj fırsatları.",
    badge: "Strateji",
  },
  {
    href: "/insights/ask",
    step: "06",
    title: "Yapay Zekâ Finans Asistanı",
    desc: "Şirket nakit akışı ve kararlarıyla ilgili sorularınızı kanıtlı olarak yanıtlar.",
    badge: "İçgörü",
  },
];

export default async function AnaEkranPage() {
  const pool = getPool();
  const today = istanbulDateISO();
  const monthStart = today.slice(0, 7) + "-01";
  const weekEnd = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);
  const [todayRows, weekRows, overdue, summary, months] = await cache.withCache(
    `overview:initial:${today}`,
    () => Promise.all([
      instancesOn(pool, today),
      instancesBetween(pool, today, weekEnd),
      overdueOpen(pool, today),
      monthSummary(pool, monthStart),
      loadCashMonths(pool),
    ]),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.CASHFLOW] }
  );

  // onboarding state: nothing imported yet
  const hasData = summary.total_count > 0 || months.length > 0;
  if (!hasData) {
    return (
      <>
        <PageHeader
          title="Yönetici Kokpiti"
          subtitle="MAS Nakit Radar — Kurumsal finans, likidite ve nakit operasyon merkezi"
          action={
            <Link href="/imports" className="button-primary px-4 py-2 text-xs">
              + Excel Dosyası Yükle
            </Link>
          }
        />
        <div className="rounded-2xl border border-line bg-gradient-to-b from-surface-1 to-surface-0 p-6 shadow-xl">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold text-sky-400">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />
              Sistem Hazır · Veri Bekleniyor
            </span>
            <h2 className="mt-3 font-sans text-xl font-bold tracking-tight text-tone-1 sm:text-2xl">
              Finansal Operasyon Kokpitine Hoş Geldiniz
            </h2>
            <p className="mt-2 font-sans text-xs text-tone-3 leading-relaxed">
              Sistemi aktif hale getirmek için Excel çalışma kitabınızı içe aktarın. Veriler yüklendiğinde
              günlük nakit çıkışları, runway süresi, risk uyarıları ve CFO kararları bu ekranda otomatik özetlenecektir.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/imports" className="button-primary px-4 py-2 text-xs">
                İlk Excel Dosyasını Yükle →
              </Link>
              <Link href="/data/imports/v2/template" className="button-ghost px-4 py-2 text-xs">
                Standart Şablonu İndir
              </Link>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {EMPTY_MODULES.map((m) => (
              <Link
                key={m.href + m.title}
                href={m.href}
                className="group relative flex flex-col justify-between rounded-xl border border-line bg-surface-2/60 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-2 hover:shadow-lg"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-mono text-xs font-bold text-sky-400/80">{m.step}</span>
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[9.5px] font-medium text-tone-3 border border-line">
                      {m.badge}
                    </span>
                  </div>
                  <h3 className="font-sans text-sm font-semibold text-tone-1 group-hover:text-sky-300 transition-colors">
                    {m.title}
                  </h3>
                  <p className="mt-1 font-sans text-xs text-tone-3 leading-relaxed">
                    {m.desc}
                  </p>
                </div>
                <div className="mt-3 flex items-center gap-1 font-sans text-[11px] font-medium text-tone-4 group-hover:text-tone-2 transition-colors">
                  Modüle Git
                  <svg className="h-3 w-3 stroke-current stroke-2 fill-none group-hover:translate-x-0.5 transition-transform" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </>
    );
  }

  const [overlay, reports, reminders, caps, costs, incomeLines, decisionFacts, dataQuality, t] = await cache.withCache(
    `overview:details:${today}`,
    () => Promise.all([
      loadDebtOverlay(pool),
      listReports(pool),
      deliveryCounts(pool),
      loadCapacityModels(pool),
      loadCostModels(pool),
      pool.query(`select coalesce(p.name, cl.label) as key, cl.amount
                  from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                  where cl.line_type='customer_income'`),
      loadDecisionFacts(pool, today),
      loadDataQualityCenter(pool),
      loadThresholds(pool),
    ]),
    { ttlSeconds: 60, tags: [CACHE_TAGS.PAYMENTS, CACHE_TAGS.CASHFLOW, CACHE_TAGS.REPORTS, CACHE_TAGS.PRODUCTION] }
  );
  void t;

  // production margin snapshot: any operation sold below its scenario's own break-even?
  const marginLoss = costs.some(
    (c) => priceMargin(c.breakEven, c.akonFreze).loss || priceMargin(c.breakEven, c.akonTorna).loss,
  );

  const proj = buildProjection(months);
  const tOut = knownOutflow(todayRows);
  const wOut = knownOutflow(weekRows);
  const oOut = knownOutflow(overdue);
  // Sparkline null'ı çizemez; eksik tutar 0 DEĞİLDİR (CLAUDE.md) ve TRY-dışı tutar aynı eksene konmaz.
  // İkisi seriden çıkarılır ve alt yazıda SAYILIR — sessizce sıfır çizilmez.
  const weekTrendValues = weekRows.filter((row) => row.amount != null && isReportingCurrency(row.currency)).map((row) => row.amount as number);
  const weekTrendOmitted = weekRows.length - weekTrendValues.length;
  const conc = concentration(
    incomeLines.rows.map((r) => ({ key: r.key as string | null, amount: moneyOrNull(r.amount) })),
  );
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

      <div className="stagger grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KeyStat label="Bugün çıkış" value={fmtTL(tOut.total)} tone={tOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${tOut.count} ödeme${tOut.missing > 0 ? ` · ${tOut.missing} eksik` : ""}${tOut.foreign > 0 ? ` · ${foreignNote(tOut.foreign)}` : ""}`} />
        <KeyStat label="7 günde çıkış" value={fmtTL(wOut.total)} tone={wOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${wOut.count} ödeme${wOut.foreign > 0 ? ` · ${foreignNote(wOut.foreign)}` : ""}`} />
        <KeyStat label="Geciken" value={oOut.count} tone={oOut.count > 0 ? "neg" : "pos"} href="/radar"
          sub={oOut.count > 0 ? `bilinen ${fmtTL(oOut.total)}${oOut.foreign > 0 ? ` · ${foreignNote(oOut.foreign)}` : ""}` : "yok"} />
        <KeyStat label="Nakit runway" value={runwayFact?.value ?? "—"} tone={runwayFact?.severity === "critical" || runwayFact?.severity === "high" ? "neg" : runwayFact?.severity === "medium" ? "warn" : "pos"} href="/cashflow"
          sub={`${runwayFact?.explanation ?? "projeksiyon"} · ilk negatif ${ym(proj.firstNegativeMonth)}`} />
      </div>

      {/* 3) Ne yapmalıyım? (max 5, deterministik) */}
      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]"><Panel title="Bugün yapılacaklar">
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
                  <EvidenceDrawer items={proofForAction(a.key)} />
                  {a.scenarioHref && <Link href={a.scenarioHref} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>senaryo onerisi -&gt;</Link>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Panel><aside className="space-y-3"><MiniTrend title="30 günlük ödeme baskısı" subtitle={`Bilinen açık TRY ödeme tutarları${weekTrendOmitted > 0 ? ` · ${weekTrendOmitted} kalem seride yok (tutar eksik ya da TRY-dışı)` : ""}`} values={weekTrendValues} href="/payments" tone="var(--warn)"/><MiniTrend title="12 aylık kasa eğilimi" subtitle="Aylık kapanış bakiyesi" values={months.slice(0,12).map(month=>month.closing??0)} href="/cashflow"/></aside></div>

      {/* 4) Durum şeridi: rapor / hatırlatma / üretim */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Son rapor</div>
          {lastReport ? (
            <Link href={`/insights/reports/${lastReport.id}`} className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--text-1)" }}>
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
