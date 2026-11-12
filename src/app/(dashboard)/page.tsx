import { Suspense, type ReactNode } from "react";
import Link from "@/components/ui/app-link";
import { createActionFromHomeAction } from "@/app/(dashboard)/data/quality/actions";
import { EvidenceDrawer } from "@/components/facts/evidence-drawer";
import { MiniTrend } from "@/components/home/mini-trends";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { KeyStat } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { foreignNote } from "@/lib/currency-policy";
import { getPool } from "@/lib/db";
import { closingTrend } from "@/lib/home/cockpit";
import {
  getWarmOverviewPair,
  loadOverviewPrimary,
  loadOverviewSecondary,
  type OverviewPrimarySnapshot,
  type OverviewSecondarySnapshot,
} from "@/lib/home/overview-snapshot";
import { MODULE_FRAMING } from "@/lib/navigation/module-framing";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const SEV_TONE: Record<string, Tone> = { critical: "red", high: "red", medium: "amber", low: "neutral" };
const EMPTY_MODULES = [
  { href: "/data/imports", title: "1. Excel yükle", desc: "Çalışma kitabı, sekme ve ham hücre kanıtı korunur." },
  { href: "/data/quality", title: "2. Veri kalitesi", desc: "İnceleme, mutabakat ve karar güveni izlenir." },
  { href: "/payments", title: "3. Ödeme radarı", desc: "Bugün, 7 gün, geciken ve eksik tutarlar." },
  { href: "/cashflow", title: "4. Nakit akışı", desc: "Runway, ilk negatif ay ve en kötü ay." },
  { href: "/insights/ask", title: "5. Sor", desc: "Karar soruları kanıtlı cevaplanır." },
  { href: "/system", title: "Tüm modüller", desc: "Rapor, hatırlatma, üretim, fazlar ve kaynak." },
];

function OverviewSecondaryView({
  primary,
  secondary,
}: {
  primary: OverviewPrimarySnapshot;
  secondary: OverviewSecondarySnapshot;
}) {
  const {
    actions,
    proofByActionKey,
    lastReport,
    reminders,
    marginLoss,
    hasCapacityModel,
    staleProductionRate,
  } = secondary;
  const { weekTrendValues, weekTrendOmitted } = primary;
  const closingSeries = closingTrend(primary.projection.series);

  return (
    <>
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
                    Görev oluştur
                  </button>
                </form>
                <div className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  <div className="text-[11px]" style={{ color: "var(--text-3)" }}>{a.reason}</div>
                  <div className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{a.impact}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <EvidenceDrawer items={proofByActionKey[a.key] ?? []} />
                  {a.scenarioHref && <Link href={a.scenarioHref} className="font-mono text-[10px] underline underline-offset-2" style={{ color: "var(--accent)" }}>senaryo önerisi →</Link>}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Panel><aside className="space-y-3"><MiniTrend title="30 günlük ödeme baskısı" subtitle={`Bilinen açık TRY ödeme tutarları${weekTrendOmitted > 0 ? ` · ${weekTrendOmitted} kalem seride yok (tutar eksik ya da TRY-dışı)` : ""}`} values={weekTrendValues} href="/payments" tone="var(--warn)"/><MiniTrend title="12 aylık kasa eğilimi" subtitle={`Aylık kapanış bakiyesi${closingSeries.unknownCount > 0 ? ` · ${closingSeries.unknownCount} ay seride yok (kapanış bilinmiyor)` : ""}`} values={closingSeries.values} href="/cashflow"/></aside></div>

      {/* 4) Durum şeridi: rapor / hatırlatma / üretim */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Son rapor</div>
          {lastReport ? (
            <Link href={`/insights/reports/${lastReport.id}`} className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--text-1)" }}>
              {lastReport.report_type === "daily" ? "Günlük" : lastReport.report_type === "weekly" ? "Haftalık" : "Aylık"} · {lastReport.created_at}
            </Link>
          ) : (
            <Link href="/insights/reports" className="mt-1 block text-sm" style={{ color: "var(--text-3)" }}>Henüz rapor yok — üret →</Link>
          )}
        </div>
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Hatırlatma durumu</div>
          <Link href="/insights/reminders" className="mt-1 block text-sm" style={{ color: "var(--text-1)" }}>
            <span className="font-mono tabular-nums">{reminders.sent}</span> gönderildi · <span className="font-mono tabular-nums">{reminders.pending}</span> bekliyor
            {reminders.failed > 0 && <span style={{ color: "var(--neg)" }}> · {reminders.failed} başarısız</span>}
          </Link>
        </div>
        <div className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--text-3)" }}>Üretim içgörüsü</div>
          <Link href="/production" className="mt-1 block text-sm" style={{ color: marginLoss ? "var(--neg)" : "var(--text-1)" }}>
            {!hasCapacityModel
              ? "Kapasite modeli yok"
              : marginLoss
                ? "Bazı operasyonlar başabaşın altında — zararına satış"
                : staleProductionRate
                  ? "Oranlar eski tarife — analitik tahmin"
                  : "Kapasite/maliyet güncel"}
          </Link>
        </div>
      </div>
    </>
  );
}

export default async function AnaEkranPage() {
  const denied = await requireRouteAccess("/");
  if (denied) return denied;
  const today = istanbulDateISO();
  const warm = getWarmOverviewPair(getPool(), today);
  if (warm) {
    return <AnaEkranView today={today} primary={warm.primary} secondary={warm.secondary} />;
  }
  return AnaEkranAsync({ today });
}

async function OverviewSecondarySection({ primary }: { primary: OverviewPrimarySnapshot }) {
  const secondary = await loadOverviewSecondary(getPool(), primary);
  return <OverviewSecondaryView primary={primary} secondary={secondary} />;
}

function OverviewHeroHeader({
  subtitle,
  meta,
}: {
  subtitle: string;
  meta?: ReactNode;
}) {
  const spec = MODULE_FRAMING.overview;
  return (
    <header className="module-heading overview-hero-banner" data-module-key={spec.key}>
      <div className="module-art-vignette" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={spec.artworkSrc}
          alt=""
          aria-hidden="true"
          loading="eager"
          decoding="async"
        />
      </div>
      <div className="module-heading-copy">
        <div className="module-eyebrow">
          {spec.folioCode} · {spec.eyebrow}
        </div>
        <h1>{spec.title}</h1>
        <p>{subtitle}</p>
        {meta && (
          <div className="mt-2 flex flex-wrap items-center gap-2" data-volatile>
            {meta}
          </div>
        )}
      </div>
      <div className="module-heading-action flex flex-wrap items-center gap-1.5">
        {spec.quickActions.map((item) => (
          <Link key={item.href} href={item.href} className="editorial-pill-link">
            {item.label}
          </Link>
        ))}
      </div>
    </header>
  );
}

function AnaEkranView({
  today,
  primary,
  secondary,
}: {
  today: string;
  primary: OverviewPrimarySnapshot;
  secondary?: OverviewSecondarySnapshot | null;
}) {
  if (!primary.hasData) {
    return (
      <>
        <OverviewHeroHeader subtitle="MAS Nakit Radar — operatör kokpiti" />
        <Panel title="BAŞLANGIÇ" accent="info">
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            Henüz veri yok. <Link className="underline underline-offset-2" href="/data/imports">İçe aktarım</Link> sayfasından
            çalışma dosyasını yükleyin ve modüllere aktarın; sonra bu ekran bugünkü ödemeleri, nakit riskini ve
            yapılacakları özetler.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {EMPTY_MODULES.map((m) => (
              <Link key={m.href + m.title} href={m.href} className="card-hover border p-3" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <div className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{m.title}</div>
                <div className="mt-1 text-[11px]" style={{ color: "var(--text-4)" }}>{m.desc}</div>
              </Link>
            ))}
          </div>
        </Panel>
      </>
    );
  }

  const {
    headline,
    dataQuality,
    todayOutflow: tOut,
    weekOutflow: wOut,
    overdueOutflow: oOut,
    projection: proj,
    runwayFact,
  } = primary;

  return (
    <>
      <OverviewHeroHeader
        subtitle="Bugün ne ödenecek · 7 günlük çıkış · geciken · nakit riski · ne yapmalıyım"
        meta={<Badge tone="neutral" dot>bugün {today.slice(8)}.{today.slice(5, 7)}</Badge>}
      />

      {/* 1) 20 saniyede cevap: büyük sayılar (1 tekil SQL sorgusu ile anında ilk byte) */}
      <div
        className="border px-3.5 py-3"
        style={{
          borderColor: `color-mix(in srgb, var(--${headline.tone}) 44%, var(--line))`,
          background: `color-mix(in srgb, var(--${headline.tone}) 7%, var(--surface-1))`,
          borderRadius: "var(--radius)",
          boxShadow: "0 1px 2px rgba(24, 22, 20, 0.03)",
        }}
      >
        <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>20 saniyede cevap</div>
        <div className="mt-1 text-lg font-semibold" style={{ color: `var(--${headline.tone})` }}>{headline.text}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Badge tone={dataQuality.decisionConfidence >= 80 ? "green" : dataQuality.decisionConfidence >= 55 ? "amber" : "red"}>
            karar güveni %{dataQuality.decisionConfidence} / {dataQuality.decisionConfidenceLabel}
          </Badge>
          {dataQuality.decisionConfidence < 80 && (
            <Badge tone="amber">{dataQuality.highOpenCount} yüksek/acil inceleme · {dataQuality.missingAmountCount} eksik tutar</Badge>
          )}
        </div>
      </div>

      <div className="stagger grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KeyStat label="Bugün çıkış" value={fmtTL(tOut.total)} tone={tOut.total > 0 ? "warn" : "neutral"} href="/payments"
          sub={`${tOut.count} ödeme${tOut.missing > 0 ? ` · ${tOut.missing} eksik` : ""}${tOut.foreign > 0 ? ` · ${foreignNote(tOut.foreign)}` : ""}`} />
        <KeyStat label="7 günde çıkış" value={fmtTL(wOut.total)} tone={wOut.total > 0 ? "warn" : "neutral"} href="/payments"
          sub={`${wOut.count} ödeme${wOut.foreign > 0 ? ` · ${foreignNote(wOut.foreign)}` : ""}`} />
        <KeyStat label="Geciken" value={oOut.count} tone={oOut.count > 0 ? "neg" : "pos"} href="/payments"
          sub={oOut.count > 0 ? `bilinen ${fmtTL(oOut.total)}${oOut.foreign > 0 ? ` · ${foreignNote(oOut.foreign)}` : ""}` : "yok"} />
        <KeyStat label="Nakit runway" value={runwayFact.value} tone={runwayFact.severity === "critical" || runwayFact.severity === "high" ? "neg" : runwayFact.severity === "medium" ? "warn" : "pos"} href="/cashflow"
          sub={`${runwayFact.explanation} · ilk negatif ${ym(proj.firstNegativeMonth)}`} />
      </div>

      {secondary ? (
        <OverviewSecondaryView primary={primary} secondary={secondary} />
      ) : (
        <Suspense fallback={<PanelSkeleton title="Bugün yapılacaklar" rows={3} />}>
          <OverviewSecondarySection primary={primary} />
        </Suspense>
      )}
    </>
  );
}

async function AnaEkranAsync({ today }: { today: string }) {
  const pool = getPool();
  const primary = await loadOverviewPrimary(pool, today);
  const secondary = primary.hasData ? await loadOverviewSecondary(pool, primary) : null;
  return <AnaEkranView today={today} primary={primary} secondary={secondary} />;
}
