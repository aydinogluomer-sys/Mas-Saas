import { Suspense } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  GitBranch,
  Layers,
  Plus,
  ShieldCheck,
  Upload,
} from "lucide-react";
import Link from "@/components/ui/app-link";
import { createActionFromHomeAction } from "@/app/(dashboard)/data/quality/actions";
import {
  CashflowWaterfallSvg,
  EditorialDonutChartSvg,
  type DonutSlice,
  type WaterfallStep,
} from "@/components/charts/editorial-cockpit-charts";
import { EvidenceDrawer } from "@/components/facts/evidence-drawer";
import { OverviewCashChart } from "@/components/home/overview-cash-chart";
import { HeroBentoRow, renderFormattedMetric } from "@/components/overview/hero-bento-row";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { requireSession } from "@/lib/auth";
import { can, canSeeRoute, type AppRole } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { foreignNote } from "@/lib/currency-policy";
import { getPool } from "@/lib/db";
import { getActiveEntityScope, type ActiveEntityScope } from "@/lib/entities/engine";
import { closingTrend } from "@/lib/home/cockpit";
import {
  loadOverviewPrimary,
  loadOverviewSecondary,
  type OverviewPrimarySnapshot,
  type OverviewSecondarySnapshot,
} from "@/lib/home/overview-snapshot";
import { decimal, money, sumMoney } from "@/lib/money";
import { OPERATIONAL_INTENTS } from "@/lib/navigation/intent-index";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const SEV_TONE: Record<string, Tone> = {
  critical: "red",
  high: "red",
  medium: "amber",
  low: "neutral",
};

const WIDGET_BADGE_TONE: Record<"pos" | "neutral" | "warn" | "neg", Tone> = {
  pos: "green",
  neutral: "neutral",
  warn: "amber",
  neg: "red",
};

const addDaysIso = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

const EMPTY_MODULES = [
  {
    href: "/data/imports",
    title: "1. Excel & Banka Yükle",
    desc: "Çalışma kitabı, banka ekstresi ve ham hücre kanıtı korunur.",
  },
  {
    href: "/finance/treasury",
    title: "2. Kasa & Banka Tanımla",
    desc: "TRY, USD ve EUR hesap açılışlarını ve limitleri girin.",
  },
  {
    href: "/finance/invoices",
    title: "3. Fatura & Cari Kayıtlar",
    desc: "Satış/alış faturaları, e-Fatura XML ve yaşlandırma.",
  },
  {
    href: "/payments",
    title: "4. Ödeme Radarı",
    desc: "Bugün, 7 gün, geciken ve eksik tutarlı yükümlülükler.",
  },
  {
    href: "/cashflow",
    title: "5. 13H Nakit Projeksiyonu",
    desc: "Runway, ilk negatif hafta/ay ve stres senaryoları.",
  },
  {
    href: "/insights/ask",
    title: "6. Kanıtlı CFO Asistanı",
    desc: "Karar soruları kaynak hücre ve tablo kanıtıyla yanıtlanır.",
  },
];

function EntityScopeBadge({ scope }: { scope: ActiveEntityScope }) {
  if (scope.mode === "entity" && scope.activeEntity) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-0.5 text-[11px] font-semibold"
        style={{
          borderColor: "color-mix(in srgb, var(--accent) 26%, var(--line))",
          background: "var(--accent-dim)",
          color: "var(--accent)",
        }}
      >
        <Building2 size={12} strokeWidth={1.75} />
        <span>{scope.activeEntity.code}</span>
        {scope.activeEntity.taxIdVkn && (
          <span className="tnum font-mono text-[10px] font-normal opacity-85">
            VKN {scope.activeEntity.taxIdVkn}
          </span>
        )}
        {scope.activeBranch && (
          <>
            <span aria-hidden="true" className="opacity-45">
              /
            </span>
            <GitBranch size={11} strokeWidth={1.75} />
            <span>{scope.activeBranch.code}</span>
          </>
        )}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-0.5 text-[11px] font-semibold"
      style={{
        borderColor: "color-mix(in srgb, var(--pos) 26%, var(--line))",
        background: "var(--pos-dim)",
        color: "var(--pos)",
      }}
    >
      <Layers size={12} strokeWidth={1.75} />
      <span>Konsolide Grup</span>
      {scope.entities.length > 0 && (
        <span className="tnum font-mono text-[10px] font-normal opacity-85">
          ({scope.entities.length})
        </span>
      )}
    </span>
  );
}

interface ExceptionChip {
  key: string;
  label: string;
  href: string;
  tone: "neg" | "warn";
}

function PriorityActionRibbon({
  today,
  scope,
  primary,
  secondary,
}: {
  today: string;
  scope: ActiveEntityScope;
  primary: OverviewPrimarySnapshot;
  secondary: OverviewSecondarySnapshot | null;
}) {
  const chips: ExceptionChip[] = [];

  if (secondary && primary.hasData) {
    const { overdueOutflow, heroPrimary } = primary;
    const { heroSecondary } = secondary;

    if (overdueOutflow.count > 0) {
      chips.push({
        key: "overdue-pay",
        label: `${overdueOutflow.count} geciken ödeme`,
        href: "/payments?filter=overdue",
        tone: "neg",
      });
    }
    if (heroPrimary.minCash13wTry != null && heroPrimary.minCash13wTry < 0) {
      chips.push({
        key: "neg-13w",
        label: "13H kasa açığı",
        href: "/cashflow",
        tone: "neg",
      });
    }
    if (heroSecondary.covenantBreachedCount > 0) {
      chips.push({
        key: "covenant-breach",
        label: `${heroSecondary.covenantBreachedCount} kovenant ihlali`,
        href: "/finance/facilities",
        tone: "neg",
      });
    }
    if (heroPrimary.checkBouncedCount > 0) {
      chips.push({
        key: "bounced-check",
        label: `${heroPrimary.checkBouncedCount} karşılıksız çek`,
        href: "/finance/checks",
        tone: "neg",
      });
    }
    if (heroSecondary.pendingApprovalsCount > 0) {
      chips.push({
        key: "approvals",
        label: `${heroSecondary.pendingApprovalsCount} bekleyen onay`,
        href: "/data/approvals",
        tone: "warn",
      });
    }
    if (heroSecondary.criticalControlAlertCount > 0) {
      chips.push({
        key: "crit-alert",
        label: `${heroSecondary.criticalControlAlertCount} kritik kontrol`,
        href: "/system/controls",
        tone: "neg",
      });
    }
    if (heroSecondary.overdueReceivablesCount > 0) {
      chips.push({
        key: "overdue-ar",
        label: `${heroSecondary.overdueReceivablesCount} gecikmiş alacak`,
        href: "/finance/receivables",
        tone: "warn",
      });
    }
  }

  const visibleChips = chips.slice(0, 3);
  const extraChipCount = Math.max(0, chips.length - visibleChips.length);
  const confidencePct = primary.dataQuality.decisionConfidence;
  const confidenceTone =
    confidencePct >= 80 ? "var(--pos)" : confidencePct >= 55 ? "var(--warn)" : "var(--neg)";

  return (
    <header
      aria-label="Ana Ekran öncelik ve hızlı aksiyon şeridi"
      className="command-surface flex flex-wrap items-center justify-between gap-2 border px-3 py-1.5"
      style={{
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
      }}
    >
      {/* Left: Masthead H1 + Scope + Urgent Exception Pills + Inline Karar Güveni */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-volatile>
        <h1
          className="shrink-0 text-[16.5px] font-bold tracking-[-0.015em] text-tone-1"
          style={{ fontFamily: "var(--font-editorial)" }}
        >
          Ana Ekran
        </h1>
        <span className="text-tone-4" aria-hidden="true">
          ·
        </span>
        <EntityScopeBadge scope={scope} />
        <span className="hidden font-mono text-[10.5px] tabular-nums text-tone-3 2xl:inline">
          {today.slice(8)}.{today.slice(5, 7)}.{today.slice(0, 4)}
        </span>

        {primary.hasData && secondary && (
          <>
            <span className="mx-0.5 hidden h-3.5 w-px bg-[var(--line)] sm:inline-block" aria-hidden />
            {visibleChips.length === 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-0.5 text-[11px] font-semibold"
                style={{
                  borderColor: "color-mix(in srgb, var(--pos) 28%, var(--line))",
                  background: "var(--pos-dim)",
                  color: "var(--pos)",
                }}
              >
                <CheckCircle2 size={12} strokeWidth={1.85} />
                Acil istisna yok
              </span>
            ) : (
              visibleChips.map((chip) => {
                const cColor = chip.tone === "neg" ? "var(--neg)" : "var(--warn)";
                return (
                  <Link
                    key={chip.key}
                    href={chip.href}
                    className="tnum inline-flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-75 hover:bg-surface-2"
                    style={{
                      borderColor: `color-mix(in srgb, ${cColor} 32%, var(--line))`,
                      background: "var(--surface-1)",
                      color: cColor,
                    }}
                  >
                    <AlertTriangle size={11} strokeWidth={1.9} />
                    <span>{chip.label}</span>
                  </Link>
                );
              })
            )}

            {extraChipCount > 0 && (
              <Link
                href="/system/controls"
                className="tnum rounded-[var(--radius-control)] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-tone-2 hover:bg-surface-3"
              >
                +{extraChipCount}
              </Link>
            )}

            <Link
              href="/data/quality"
              className="tnum inline-flex items-center gap-1 rounded-[var(--radius-control)] border border-line bg-surface-1 px-2 py-0.5 text-[11px] font-semibold transition-colors hover:border-line-strong"
              title={`Karar Güveni: ${primary.dataQuality.decisionConfidenceLabel}`}
            >
              <ShieldCheck size={11.5} strokeWidth={1.8} style={{ color: confidenceTone }} />
              <span className="text-tone-2">Karar Güveni</span>
              <span className="font-mono font-bold" style={{ color: confidenceTone }}>
                %{confidencePct}
              </span>
            </Link>

            {primary.dataQuality.missingAmountCount > 0 && (
              <Link
                href="/payments/missing"
                className="tnum hidden rounded-[var(--radius-control)] border px-2 py-0.5 text-[11px] font-semibold xl:inline-flex"
                style={{
                  borderColor: "color-mix(in srgb, var(--warn) 32%, var(--line))",
                  background: "var(--warn-dim)",
                  color: "var(--warn)",
                }}
              >
                {primary.dataQuality.missingAmountCount} eksik tutar
              </Link>
            )}
          </>
        )}
      </div>

      {/* Right: 3 Crisp Primary Action Buttons */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0">
        <Link
          href="/payments/new"
          className="button-accent inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-semibold"
        >
          <Plus size={12.5} strokeWidth={2} />
          Ödeme Ekle
        </Link>
        <Link
          href="/data/imports"
          className="button-ghost inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-semibold"
        >
          <Upload size={12} strokeWidth={1.85} />
          Excel / Ekstre Yükle
        </Link>
        <Link
          href="/cashflow/13-week"
          className="button-ghost inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-semibold"
        >
          13H Likidite
          <ArrowUpRight size={12} strokeWidth={1.85} />
        </Link>
      </div>
    </header>
  );
}

function QuickWorkflowLauncher({ role }: { role: AppRole }) {
  const workflows = OPERATIONAL_INTENTS.filter((item) => canSeeRoute(role, item.primaryHref));
  if (workflows.length === 0) return null;

  return (
    <section aria-label="Görev Pusulası · Hızlı İş Akışları" className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <h2
          className="text-[14.5px] font-bold tracking-[-0.01em] text-tone-1"
          style={{ fontFamily: "var(--font-editorial)" }}
        >
          Görev Pusulası · 4 Ana İş Akışı
        </h2>
        <span className="text-[11px] text-tone-3">
          Veri girişinden 13H stres testine tek tıkla geçiş
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        {workflows.map((wf) => (
          <article
            key={wf.key}
            className="card-hover command-surface flex min-w-0 flex-col justify-between border p-3"
            style={{
              borderColor: "var(--line-card)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-tone-3">
                  ADIM {wf.stepBadge} · {wf.shortLabel}
                </span>
                <Link
                  href={wf.primaryHref}
                  className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent-tone hover:underline"
                >
                  Aç
                  <ArrowUpRight size={11.5} strokeWidth={1.85} />
                </Link>
              </div>
              <Link href={wf.primaryHref} className="mt-1 block hover:underline">
                <h3
                  className="text-[14.5px] font-bold leading-snug text-tone-1"
                  style={{ fontFamily: "var(--font-editorial)" }}
                >
                  {wf.label}
                </h3>
              </Link>
              <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-tone-3">
                {wf.subtitle}
              </p>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line-faint pt-2">
              {wf.secondaryHrefs
                .filter((sec) => canSeeRoute(role, sec.href))
                .slice(0, 2)
                .map((sec) => (
                  <Link
                    key={sec.href}
                    href={sec.href}
                    className="rounded-[var(--radius-control)] border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-tone-2 transition-colors hover:bg-surface-3"
                  >
                    {sec.label}
                  </Link>
                ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ActionQueueAndRadarDrawer({
  primary,
  secondary,
}: {
  primary: OverviewPrimarySnapshot;
  secondary: OverviewSecondarySnapshot;
}) {
  const { todayOutflow: tOut, weekOutflow: wOut, overdueOutflow: oOut } = primary;
  const { actions, proofByActionKey } = secondary;

  const overdueAmountLabel =
    oOut.count === 0
      ? "0 TL"
      : oOut.total === 0 && oOut.missing > 0
        ? "TUTAR EKSİK"
        : fmtTL(oOut.total);

  return (
    <details className="parchment-disclosure" data-analyst-only="true" open={false}>
      <summary>
        <div className="flex items-center gap-2.5">
          <span className="parchment-disclosure-chevron" aria-hidden="true">
            ▸
          </span>
          <div>
            <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-tone-1">
              Bugün Yapılacaklar · Önceliklendirilmiş Aksiyon Kuyruğu ({actions.length}) &amp; Kısa Vadeli Radar
            </h2>
            <p className="max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
              Deterministik kural motoru görevleri, kaynak kanıt çekmeceleri ve kısa vadeli ödeme listesi
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {oOut.count > 0 && <Badge tone="red">{oOut.count} geciken</Badge>}
          <Badge tone="neutral">{actions.length} aksiyon</Badge>
        </div>
      </summary>

      <div className="parchment-disclosure-body">
        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-8">
            <ol className="space-y-2">
              {actions.map((a, i) => (
                <li key={a.key}>
                  <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-2.5 transition-colors duration-75 hover:bg-surface-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <Link href={a.href} className="flex min-w-0 flex-1 items-start gap-2">
                        <span className="mt-0.5 font-mono text-[11.5px] font-semibold tabular-nums text-tone-3">
                          {i + 1}.
                        </span>
                        <span className="flex-1 text-[13px] font-semibold leading-snug text-tone-1">
                          {a.label}
                        </span>
                      </Link>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge tone={SEV_TONE[a.severity]}>
                          {a.severity === "critical"
                            ? "Acil"
                            : a.severity === "high"
                              ? "Yüksek"
                              : a.severity === "medium"
                                ? "Orta"
                                : "Rutin"}
                        </Badge>
                        <form action={createActionFromHomeAction}>
                          <input type="hidden" name="title" value={a.label} />
                          <input type="hidden" name="severity" value={a.severity} />
                          <input type="hidden" name="sourceFactKey" value={a.key} />
                          <input type="hidden" name="sourceHref" value={a.evidenceHref} />
                          <input type="hidden" name="note" value={`${a.reason} ${a.impact}`} />
                          <input type="hidden" name="backTo" value="/" />
                          <button
                            type="submit"
                            className="rounded-[var(--radius-control)] border border-line bg-surface-1 px-2 py-1 text-[11px] font-semibold text-tone-2 transition-colors duration-75 hover:bg-surface-3"
                          >
                            Görev Oluştur
                          </button>
                        </form>
                      </div>
                    </div>

                    <div className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <div className="max-w-[68ch] text-[12px] leading-[1.45] text-tone-2">
                        {a.reason}
                      </div>
                      <div className="text-[12px] font-medium tabular-nums text-tone-3 sm:text-right">
                        {a.impact}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <EvidenceDrawer items={proofByActionKey[a.key] ?? []} />
                      {a.scenarioHref && (
                        <Link
                          href={a.scenarioHref}
                          className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent-tone underline underline-offset-2"
                        >
                          Stres senaryosunda dene →
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="min-w-0 space-y-2 xl:col-span-4">
            <Link
              href="/payments"
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-line bg-surface-1 px-3 py-2.5 transition-colors hover:bg-surface-2"
            >
              <div>
                <div className="text-[12px] font-semibold text-tone-2">Bugün Çıkış</div>
                <div className="tnum text-[11px] text-tone-3">
                  {tOut.count} ödeme
                  {tOut.missing > 0 ? ` · ${tOut.missing} eksik tutar` : ""}
                  {tOut.foreign > 0 ? ` · ${foreignNote(tOut.foreign)}` : ""}
                </div>
              </div>
              <div
                className="text-right text-[15px] font-bold tabular-nums"
                style={{ color: tOut.total > 0 ? "var(--warn)" : "var(--text-1)" }}
              >
                {fmtTL(tOut.total)}
              </div>
            </Link>

            <Link
              href="/payments"
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-line bg-surface-1 px-3 py-2.5 transition-colors hover:bg-surface-2"
            >
              <div>
                <div className="text-[12px] font-semibold text-tone-2">7 Günde Çıkış</div>
                <div className="tnum text-[11px] text-tone-3">
                  {wOut.count} planlı kalem
                  {wOut.foreign > 0 ? ` · ${foreignNote(wOut.foreign)}` : ""}
                </div>
              </div>
              <div
                className="text-right text-[15px] font-bold tabular-nums"
                style={{ color: wOut.total > 0 ? "var(--warn)" : "var(--text-1)" }}
              >
                {fmtTL(wOut.total)}
              </div>
            </Link>

            <Link
              href="/payments?filter=overdue"
              className="flex items-center justify-between rounded-[var(--radius-md)] border border-line bg-surface-1 px-3 py-2.5 transition-colors hover:bg-surface-2"
            >
              <div>
                <div className="text-[12px] font-semibold text-tone-2">Vadesi Geçmiş Yük</div>
                <div className="tnum text-[11px] text-tone-3">
                  {oOut.count > 0 ? `${oOut.count} geciken kalem` : "Geciken ödeme yok"}
                </div>
              </div>
              <div
                className="text-right text-[15px] font-bold tabular-nums"
                style={{ color: oOut.count > 0 ? "var(--neg)" : "var(--pos)" }}
              >
                {overdueAmountLabel}
              </div>
            </Link>
          </div>
        </div>
      </div>
    </details>
  );
}

function ExecutiveCockpitGrid({ secondary }: { secondary: OverviewSecondarySnapshot }) {
  const { cockpitCards } = secondary;
  if (!cockpitCards.length) return null;

  const urgentCount = cockpitCards.filter((c) => c.tone === "neg" || c.tone === "warn").length;
  const healthyCount = cockpitCards.length - urgentCount;

  return (
    <details className="parchment-disclosure" data-analyst-only="true" open={false}>
      <summary>
        <div className="flex items-center gap-2.5">
          <span className="parchment-disclosure-chevron" aria-hidden="true">
            ▸
          </span>
          <div>
            <h2 className="text-[13.5px] font-semibold tracking-[-0.01em] text-tone-1">
              CFO Yürütme Nabzı · {cockpitCards.length} Kanonik Denetim Göstergesi
            </h2>
            <p className="max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
              Detaylı alt modül metrikleri ve hücre bazlı kaynak kanıt çekmeceleri
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {urgentCount > 0 ? (
            <Badge tone="amber">{urgentCount} dikkat gerektiren</Badge>
          ) : null}
          <Badge tone="green">{healthyCount} dengede</Badge>
        </div>
      </summary>

      <div className="parchment-disclosure-body">
        <div
          aria-label="11 Metrik CFO Yürütme Kokpiti"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {cockpitCards.map((card) => {
            const valueColor =
              card.tone === "neg"
                ? "var(--neg)"
                : card.tone === "warn"
                  ? "var(--warn)"
                  : card.tone === "pos"
                    ? "var(--text-1)"
                    : "var(--text-2)";

            return (
              <article
                key={card.key}
                className="flex min-w-0 flex-col justify-between rounded-[var(--radius-md)] border border-edge bg-surface-1 p-3.5 shadow-[var(--shadow-card)] transition-shadow duration-100 hover:shadow-[var(--shadow-elevated)]"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={card.href}
                      className="text-[13px] font-semibold leading-snug tracking-[-0.01em] text-tone-1 hover:underline"
                    >
                      {card.title}
                    </Link>
                    <Badge tone={WIDGET_BADGE_TONE[card.tone]}>{card.badgeText}</Badge>
                  </div>

                  <div className="mt-2">
                    <Link href={card.href}>
                      {renderFormattedMetric(card.value, "text-[22px]", valueColor)}
                    </Link>
                  </div>

                  <p
                    title={card.sublabel}
                    className="mt-1.5 line-clamp-2 max-w-[68ch] text-[12px] leading-relaxed text-tone-3"
                  >
                    {card.sublabel}
                  </p>
                </div>

                <div className="mt-3 flex items-center justify-between gap-2 border-t border-line-faint pt-2.5">
                  <EvidenceDrawer items={card.proofItems} label="Kaynak & Kanıt" />
                  <Link
                    href={card.href}
                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-accent-tone transition-colors duration-75 hover:underline"
                  >
                    Modülü aç
                    <ArrowUpRight size={13} strokeWidth={1.75} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </details>
  );
}

/**
 * Computes strictly-TRY 90-day / 3-month inflows & planned outflows from `chartsByCurrency.TRY`
 * plus live overdue/receivable/debt buckets using `@/lib/money` (never mixing USD/EUR 1:1 into TRY,
 * never coercing null unknown amounts to zero).
 */
function buildOverviewTryVisuals(
  primary: OverviewPrimarySnapshot,
  secondary: OverviewSecondarySnapshot,
): {
  waterfallSteps: WaterfallStep[];
  donutSlices: DonutSlice[];
  donutTotalTry: number;
} {
  const { today, weekOutflow: wOut, overdueOutflow: oOut, maturities, chartsByCurrency } = primary;
  const { heroSecondary } = secondary;

  const horizon90Iso = addDaysIso(today, 90);
  const horizon3Ym = addDaysIso(today, 90).slice(0, 7);
  const currentYm = today.slice(0, 7);

  const tryPressure = chartsByCurrency.TRY.pressureChart;
  const inWindow = (key: string) =>
    key.length === 7
      ? key >= currentYm && key <= horizon3Ym
      : key >= today && key <= horizon90Iso;

  const inflowPoints =
    tryPressure.series.find((s) => s.id === "expected-inflow")?.points ?? [];
  const confirmedOutPoints =
    tryPressure.series.find((s) => s.id === "confirmed-outflow")?.points ?? [];
  const projectedOutPoints =
    tryPressure.series.find((s) => s.id === "projected-outflow")?.points ?? [];

  const chartInflowTry = sumMoney(
    inflowPoints.filter((p) => inWindow(p.key) && p.value != null).map((p) => p.value),
  );
  const chartPlannedOutTry = sumMoney([
    ...confirmedOutPoints.filter((p) => inWindow(p.key) && p.value != null).map((p) => p.value),
    ...projectedOutPoints.filter((p) => inWindow(p.key) && p.value != null).map((p) => p.value),
  ]);

  const inflowTry = chartInflowTry;
  const plannedOutTry = chartPlannedOutTry > 0 ? chartPlannedOutTry : money(wOut.total);
  const overdueTry = money(oOut.total);
  const netPeriodTry = money(decimal(inflowTry).minus(plannedOutTry).minus(overdueTry));

  const waterfallSteps: WaterfallStep[] = [
    {
      key: "inflow",
      label: "Tahsilat / Girişler",
      amount: inflowTry,
      formattedAmount: fmtTL(inflowTry),
      tone: "pos",
    },
    {
      key: "planned-out",
      label: "Planlı Ödemeler",
      amount: -plannedOutTry,
      formattedAmount: plannedOutTry > 0 ? `−${fmtTL(plannedOutTry)}` : fmtTL(0),
      tone: "warn",
    },
    {
      key: "overdue-load",
      label: "Gecikmiş Yük",
      amount: -overdueTry,
      formattedAmount: overdueTry > 0 ? `−${fmtTL(overdueTry)}` : fmtTL(0),
      tone: "neg",
    },
    {
      key: "net-pos",
      label: "Net Dönem Pozisyonu",
      amount: netPeriodTry,
      formattedAmount: fmtTL(netPeriodTry),
      isTotal: true,
      tone: netPeriodTry < 0 ? "neg" : "info",
    },
  ];

  // Pure TRY 30-day check & loan installment burden
  const next30Iso = addDaysIso(today, 30);
  const debtCheckLoad30Try = sumMoney(
    maturities
      .filter(
        (m) =>
          m.dueDate >= today &&
          m.dueDate <= next30Iso &&
          m.direction === "outflow" &&
          m.amount != null,
      )
      .map((m) => m.amount),
  );

  // Open receivables: explicit TCMB-converted TRY from heroSecondary if present, else pure-TRY inflow horizon
  const openReceivablesTry =
    heroSecondary.receivablesOpenTry != null && heroSecondary.receivablesOpenTry > 0
      ? money(heroSecondary.receivablesOpenTry)
      : inflowTry;

  const donutSlices: DonutSlice[] = [
    {
      key: "overdue-pay",
      label: "Gecikmiş Ödemeler",
      value: overdueTry,
      formattedValue: fmtTL(overdueTry),
      sublabel: `${oOut.count} kalem`,
      tone: "neg",
    },
    {
      key: "outflow-7d",
      label: "7 Günlük Çıkış",
      value: money(wOut.total),
      formattedValue: fmtTL(wOut.total),
      sublabel: `${wOut.count} planlı`,
      tone: "warn",
    },
    {
      key: "open-ar",
      label: "Açık Alacak",
      value: openReceivablesTry,
      formattedValue: fmtTL(openReceivablesTry),
      sublabel:
        heroSecondary.overdueReceivablesCount > 0
          ? `${heroSecondary.overdueReceivablesCount} gecikmiş`
          : "Tahsilat ufku",
      tone: "pos",
    },
    {
      key: "debt-check",
      label: "Kredi/Çek Yükü",
      value: debtCheckLoad30Try,
      formattedValue: fmtTL(debtCheckLoad30Try),
      sublabel: "30G vade",
      tone: "info",
    },
  ];

  const donutTotalTry = sumMoney(donutSlices.map((s) => s.value));

  return {
    waterfallSteps,
    donutSlices,
    donutTotalTry,
  };
}

function AnaEkranView({
  today,
  role,
  canMutateCashAccounts,
  scope,
  primary,
  secondary,
  secondaryPromise,
}: {
  today: string;
  role: AppRole;
  canMutateCashAccounts: boolean;
  scope: ActiveEntityScope;
  primary: OverviewPrimarySnapshot;
  secondary: OverviewSecondarySnapshot | null;
  secondaryPromise?: Promise<OverviewSecondarySnapshot> | null;
}) {
  if (!primary.hasData || !secondary) {
    return (
      <div className="space-y-3.5">
        <PriorityActionRibbon today={today} scope={scope} primary={primary} secondary={null} />
        <Panel title="Başlangıç Kurulumu" accent="info">
          <p className="max-w-[68ch] text-[13.5px] leading-relaxed text-tone-2">
            Henüz finansal hareket bulunmuyor.{" "}
            <Link className="font-semibold underline underline-offset-2" href="/data/imports">
              İçe aktarım
            </Link>{" "}
            ekranından çalışma kitabını veya banka ekstresini yükleyin ya da doğrudan kasa/fatura kaydı oluşturun.
          </p>
          <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {EMPTY_MODULES.map((m) => (
              <Link
                key={m.href + m.title}
                href={m.href}
                className="card-hover rounded-[var(--radius-md)] border border-dashed border-line bg-surface-2 p-3"
              >
                <div className="text-[13px] font-semibold text-tone-1">{m.title}</div>
                <div className="mt-1 max-w-[68ch] text-[11.5px] leading-[1.45] text-tone-3">
                  {m.desc}
                </div>
              </Link>
            ))}
          </div>
        </Panel>
        <QuickWorkflowLauncher role={role} />
      </div>
    );
  }

  const { heroPrimary, weekOutflow: wOut, overdueOutflow: oOut } = primary;
  const monthlyTrend = closingTrend(primary.projection.series.slice(-12));
  const spark13w =
    heroPrimary.trajectory13wValues.length > 1
      ? heroPrimary.trajectory13wValues
      : monthlyTrend.values;

  const { waterfallSteps, donutSlices, donutTotalTry } = buildOverviewTryVisuals(
    primary,
    secondary,
  );
  const foreignOpenCount = oOut.foreign + wOut.foreign;

  return (
    <div className="space-y-3">
      {/* 1. Compact Single-Line Priority & Action Ribbon (~42px) */}
      <PriorityActionRibbon today={today} scope={scope} primary={primary} secondary={secondary} />

      {/* 2. Compact 4-Column Executive Metric Strip (~105px) */}
      <HeroBentoRow
        primary={primary}
        secondary={secondary}
        spark13wValues={spark13w}
        canMutateCashAccounts={canMutateCashAccounts}
      />

      {/* 3. HERO VISUAL COCKPIT RIGHT ABOVE THE FOLD (7 / 5 Asymmetric Split) */}
      <section
        aria-label="Görsel nakit ve portföy kokpiti"
        className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-12"
      >
        <div className="min-w-0 xl:col-span-7">
          <OverviewCashChart
            chartsByCurrency={primary.chartsByCurrency}
            fxRateSummary={heroPrimary.fxRateSummary}
          />
        </div>

        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="Nakit Köprüsü &amp; Portföy Dağılımı"
            subtitle="Giriş, çıkış ve açık yükümlülük kompozisyonu (TRY)"
            right={
              <Link href="/cashflow" className="button-ghost px-2 py-1 text-[11px]">
                Detay →
              </Link>
            }
          >
            <div className="space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                  <span>3 Aylık Nakit Köprüsü Şelalesi (TRY)</span>
                  <span className="font-mono text-[10px] text-tone-4">R10 Kuruş Kesinliği</span>
                </div>
                <CashflowWaterfallSvg
                  steps={waterfallSteps}
                  ariaLabel="3 aylık tahsilat, planlı ödeme ve gecikmiş yük nakit köprüsü şelalesi"
                  height={182}
                />
              </div>

              <div className="border-t border-line-faint pt-2.5">
                <EditorialDonutChartSvg
                  slices={donutSlices}
                  centerLabel="PORTFÖY (TRY)"
                  centerValue={fmtTL(donutTotalTry)}
                  centerSubtext="Bilinen TRY"
                  ariaLabel="Gecikmiş ödemeler, 7 günlük çıkış, açık alacak ve kredi/çek yükü dağılımı"
                  size={142}
                />
              </div>

              {(primary.dataQuality.missingAmountCount > 0 || foreignOpenCount > 0) && (
                <div className="tnum flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line-faint bg-surface-2 px-2.5 py-1.5 text-[11px] text-tone-3">
                  {primary.dataQuality.missingAmountCount > 0 ? (
                    <Link
                      href="/payments/missing"
                      className="font-semibold text-warn underline underline-offset-2"
                    >
                      {primary.dataQuality.missingAmountCount} kalemde TUTAR EKSİK →
                    </Link>
                  ) : (
                    <span>Belirsiz tutar yok</span>
                  )}
                  {foreignOpenCount > 0 && (
                    <span>{foreignNote(foreignOpenCount)} ayrı izlenir</span>
                  )}
                </div>
              )}
            </div>
          </Panel>
        </div>
      </section>

      {/* 4. Clean Single-Row 4-Card Quick Workflow Launcher (Görev Pusulası) */}
      <QuickWorkflowLauncher role={role} />

      {/* 5. Progressive Disclosure Drawers for Secondary Queues & 11 Audit Metrics */}
      <ActionQueueAndRadarDrawer primary={primary} secondary={secondary} />

      {secondaryPromise ? (
        <Suspense
          fallback={
            <PanelSkeleton
              title="CFO Yürütme Nabzı · 11 Kanonik Gösterge"
              subtitle="yükleniyor"
              rows={3}
            />
          }
        >
          <OverviewSecondarySection secondaryPromise={secondaryPromise} />
        </Suspense>
      ) : (
        <OverviewSecondaryContent secondary={secondary} />
      )}
    </div>
  );
}

function OverviewSecondaryContent({ secondary }: { secondary: OverviewSecondarySnapshot }) {
  const {
    lastReport,
    reminders,
    marginLoss,
    hasCapacityModel,
    staleProductionRate,
  } = secondary;

  return (
    <>
      <ExecutiveCockpitGrid secondary={secondary} />

      <section className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <div className="rounded-[var(--radius-md)] border border-line bg-surface-1 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tone-3">
            Son Yönetim Raporu
          </div>
          {lastReport ? (
            <Link
              href={`/insights/reports/${lastReport.id}`}
              className="mt-1 block text-[13px] font-medium text-tone-1 underline underline-offset-2"
            >
              {lastReport.report_type === "daily"
                ? "Günlük"
                : lastReport.report_type === "weekly"
                  ? "Haftalık"
                  : "Aylık"}{" "}
              · <span className="tnum font-mono text-[12px]">{lastReport.created_at}</span>
            </Link>
          ) : (
            <Link href="/insights/reports" className="mt-1 block text-[13px] font-medium text-accent-tone">
              Henüz rapor yok — yönetici özeti üret →
            </Link>
          )}
        </div>

        <div className="rounded-[var(--radius-md)] border border-line bg-surface-1 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tone-3">
            Hatırlatma Teslimatları
          </div>
          <Link href="/insights/reminders" className="mt-1 block text-[13px] font-medium text-tone-1">
            <span className="font-mono tabular-nums">{reminders.sent}</span> gönderildi ·{" "}
            <span className="font-mono tabular-nums">{reminders.pending}</span> bekliyor
            {reminders.failed > 0 && (
              <span className="tabular-nums text-neg"> · {reminders.failed} başarısız</span>
            )}
          </Link>
        </div>

        <div className="rounded-[var(--radius-md)] border border-line bg-surface-1 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tone-3">
            Üretim &amp; Maliyet Nabzı
          </div>
          <Link
            href="/production"
            className="mt-1 block text-[13px] font-medium"
            style={{ color: marginLoss ? "var(--neg)" : "var(--text-1)" }}
          >
            {!hasCapacityModel
              ? "Kapasite modeli tanımlanmadı"
              : marginLoss
                ? "Bazı operasyonlar başabaşın altında — incele →"
                : staleProductionRate
                  ? "Oranlar eski tarife — güncelle →"
                  : "Kapasite ve maliyet oranları güncel"}
          </Link>
        </div>
      </section>
    </>
  );
}

async function OverviewSecondarySection({
  secondaryPromise,
}: {
  secondaryPromise: Promise<OverviewSecondarySnapshot>;
}) {
  const secondary = await secondaryPromise;
  return <OverviewSecondaryContent secondary={secondary} />;
}

export default async function AnaEkranPage() {
  const denied = await requireRouteAccess("/");
  if (denied) return denied;

  const session = await requireSession();
  const canMutateCashAccounts = can(session.role, "cash_accounts", "update");
  const today = istanbulDateISO();
  const pool = getPool();
  const [scope, primary] = await Promise.all([
    getActiveEntityScope(pool),
    loadOverviewPrimary(pool, today),
  ]);
  const secondaryPromise = primary.hasData ? loadOverviewSecondary(pool, primary) : null;
  const secondary = secondaryPromise ? await secondaryPromise : null;

  return (
    <AnaEkranView
      today={today}
      role={session.role}
      canMutateCashAccounts={canMutateCashAccounts}
      scope={scope}
      primary={primary}
      secondary={secondary}
      secondaryPromise={secondaryPromise}
    />
  );
}
