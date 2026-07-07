import Link from "next/link";
import { getPool } from "@/lib/db";
import { ensureWindow, loadThresholds } from "@/lib/radar/engine";
import { instancesBetween, instancesOn, monthSummary, overdueOpen } from "@/lib/radar/queries";
import { buildProjection, concentration } from "@/lib/radar/rules";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { loadDebtOverlay, listReports } from "@/lib/reports/engine";
import { deliveryCounts } from "@/lib/reminders/engine";
import { loadCapacityModels } from "@/lib/production/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { buildActions, pickHeadlineRisk, type CockpitFacts } from "@/lib/home/cockpit";
import { Badge, type Tone } from "@/components/ui/badge";
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

  const [overlay, reports, reminders, caps, incomeLines, t] = await Promise.all([
    loadDebtOverlay(pool),
    listReports(pool),
    deliveryCounts(pool),
    loadCapacityModels(pool),
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='customer_income'`),
    loadThresholds(pool),
  ]);
  void t;

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
  const lastReport = reports[0];

  return (
    <>
      <PageHeader
        title="Ana Ekran"
        subtitle="Bugün ne ödenecek · 7 günlük çıkış · geciken · nakit riski · ne yapmalıyım"
        meta={<Badge tone="neutral" dot>bugün {today.slice(8)}.{today.slice(5, 7)}</Badge>}
      />

      {/* 1) 20 saniyede cevap: büyük sayılar */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KeyStat label="Bugün çıkış" value={fmtTL(tOut.total)} tone={tOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${tOut.count} ödeme${tOut.missing > 0 ? ` · ${tOut.missing} eksik` : ""}`} />
        <KeyStat label="7 günde çıkış" value={fmtTL(wOut.total)} tone={wOut.total > 0 ? "warn" : "neutral"} href="/radar"
          sub={`${wOut.count} ödeme`} />
        <KeyStat label="Geciken" value={oOut.count} tone={oOut.count > 0 ? "neg" : "pos"} href="/radar"
          sub={oOut.count > 0 ? `bilinen ${fmtTL(oOut.total)}` : "yok"} />
        <KeyStat label="İlk negatif ay" value={ym(proj.firstNegativeMonth)} tone={proj.firstNegativeMonth ? "neg" : "pos"} href="/cashflow"
          sub={proj.firstNegativeMonth ? "kasa eksiye geçiyor" : "negatif ay yok"} />
        <KeyStat label="En kötü ay" value={ym(proj.worstMonth)} tone={proj.worstBalance != null && proj.worstBalance < 0 ? "neg" : "neutral"} href="/cashflow"
          sub={proj.worstBalance != null ? fmtTL(proj.worstBalance) : "—"} />
      </div>

      {/* 2) En büyük risk (tek cümle) */}
      <div className="border px-3 py-2.5" style={{ borderColor: `var(--${headline.tone})`, background: `color-mix(in srgb, var(--${headline.tone}) 8%, transparent)`, borderRadius: "var(--radius)" }}>
        <div className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>En büyük risk</div>
        <div className="mt-0.5 text-sm" style={{ color: `var(--${headline.tone})` }}>{headline.text}</div>
      </div>

      {/* 3) Ne yapmalıyım? (max 5, deterministik) */}
      <Panel title="Ne yapmalıyım?">
        <ol className="space-y-1.5">
          {actions.map((a, i) => (
            <li key={a.key}>
              <Link href={a.href} className="card-hover flex items-start gap-2 border px-2.5 py-2"
                style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <span className="mt-0.5 font-mono text-[11px]" style={{ color: "var(--text-4)" }}>{i + 1}.</span>
                <span className="flex-1 text-sm" style={{ color: "var(--text-1)" }}>{a.label}</span>
                <Badge tone={SEV_TONE[a.severity]}>{a.severity === "critical" ? "acil" : a.severity === "high" ? "yüksek" : a.severity === "medium" ? "orta" : "düşük"}</Badge>
              </Link>
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
          <Link href="/production" className="mt-1 block text-sm" style={{ color: "var(--text-1)" }}>
            {caps.length === 0 ? "Kapasite modeli yok" : facts.staleProductionRate ? "Oranlar eski tarife (stale) — analitik tahmin" : "Kapasite/maliyet güncel"}
          </Link>
        </div>
      </div>
    </>
  );
}
