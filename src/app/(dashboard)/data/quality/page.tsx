import { BulletBarSvg } from "@/components/charts/folio-visuals";
import {
  AgingBucketsBarSvg,
  EditorialDonutChartSvg,
  type AgingBucketItem,
  type DonutSlice,
} from "@/components/charts/editorial-cockpit-charts";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import { getPool } from "@/lib/db";
import { decimal, money } from "@/lib/money";
import { loadFourWaySubledgerHealth } from "@/lib/reconciliation/four-way-health";

export const dynamic = "force-dynamic";

const PILLAR_SHORT_LABEL: Record<string, string> = {
  bank_102: "102 Banka",
  ar_ap_120_320: "120/320 Alacak·Borç",
  checks_101_103: "101/103 Çek",
  loans_300_400: "300/400 Kredi",
};

export default async function QualityPage() {
  const denied = await requireRouteAccess("/data/quality");
  if (denied) return denied;

  const pool = getPool();
  const [d, fourWay] = await Promise.all([
    loadDataQualityCenter(pool),
    loadFourWaySubledgerHealth(pool),
  ]);

  const totalIssueCount = d.issueCounts.reduce((acc, r) => acc + r.n, 0);
  const resolvedIssueCount = Math.max(0, totalIssueCount - d.openReviewCount);
  const normalOpenCount = Math.max(0, d.openReviewCount - d.highOpenCount);
  const verifiedTotal = resolvedIssueCount + fourWay.alignedCount;
  const urgentAndReconCount = d.highOpenCount + d.reconciliationSignalCount;
  const missingFieldsTotal = d.missingAmountCount + d.externalPendingCount + d.staleProductionRateCount;

  const qualitySlices: DonutSlice[] = [
    {
      key: "verified",
      label: "Doğrulanan Kayıt & Sütun",
      value: verifiedTotal,
      formattedValue: `${verifiedTotal} kalem`,
      sublabel: `${fourWay.alignedCount}/4 TDHP sütunu · ${resolvedIssueCount} çözülen`,
      tone: "pos",
    },
    {
      key: "needs-review",
      label: "İnceleme Bekleyen",
      value: normalOpenCount,
      formattedValue: `${normalOpenCount} kalem`,
      sublabel: "Operatör doğrulaması bekliyor",
      tone: "warn",
    },
    {
      key: "missing-fields",
      label: "Eksik Tutar & Alan (R10)",
      value: missingFieldsTotal,
      formattedValue: `${missingFieldsTotal} kalem`,
      sublabel: `${d.missingAmountCount} tutar · ${d.externalPendingCount} dış varsayım`,
      tone: "accent",
    },
    {
      key: "open-critical",
      label: "Acil Sorun & Sapma",
      value: urgentAndReconCount,
      formattedValue: `${urgentAndReconCount} kalem`,
      sublabel: `${d.highOpenCount} yüksek · ${d.reconciliationSignalCount} mutabakat`,
      tone: "neg",
    },
  ];

  const hasSubledgerVariance = fourWay.divergentCount > 0;
  const totalAbsVarianceTry = money(
    fourWay.pillars.reduce(
      (acc, p) => (p.deltaTry == null ? acc : acc.plus(decimal(p.deltaTry).abs())),
      decimal(0),
    ),
  );

  const subledgerBuckets: AgingBucketItem[] = fourWay.pillars.map((p) => {
    const isUnknown = p.deltaTry == null || p.subledgerTry == null;
    const absDelta = p.deltaTry == null ? 0 : money(decimal(p.deltaTry).abs());
    const absSubledger = p.subledgerTry == null ? 0 : money(decimal(p.subledgerTry).abs());
    const metricAmount = hasSubledgerVariance ? absDelta : absSubledger;
    return {
      key: `tdhp-${p.key}`,
      label: PILLAR_SHORT_LABEL[p.key] ?? p.tdhpCodes,
      amount: metricAmount,
      formattedAmount: isUnknown ? "Bilinmiyor · FIN-03" : fmtTL(metricAmount),
      tone: isUnknown
        ? "warn"
        : hasSubledgerVariance
          ? p.aligned
            ? "pos"
            : "neg"
          : p.key === "bank_102"
            ? "pos"
            : p.key === "ar_ap_120_320"
              ? "info"
              : p.key === "checks_101_103"
                ? "accent"
                : "neutral",
    };
  });

  return (
    <>
      <PageHeader
        title="MODÜL 08 · Veri Sağlığı & Karar Güveni"
        subtitle="Karar güveni skoru, 4 yönlü TDHP alt-defter mutabakatı (102 · 120/320 · 101/103 · 300/400), eksik tutarlar ve dış veri incelemeleri"
        meta={
          <Badge
            tone={
              d.decisionConfidence >= 80
                ? "green"
                : d.decisionConfidence >= 55
                  ? "amber"
                  : "red"
            }
          >
            {d.decisionConfidenceLabel}
          </Badge>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link className="button-ghost px-3 py-1.5 text-xs" href="/payments/missing">
              Eksik Tutarlar ({d.missingAmountCount})
            </Link>
            <Link className="button-accent px-3 py-1.5 text-xs" href="/data/reconciliation">
              Mutabakat Masası →
            </Link>
          </div>
        }
      />

      {/* Row 1: Compact 4-Card KPI Row */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <KpiCard
          label="Karar Güveni Skoru"
          value={`%${d.decisionConfidence}`}
          note={`${d.decisionConfidenceLabel} · Kurumsal eşik %80`}
          tone={
            d.decisionConfidence >= 80
              ? "pos"
              : d.decisionConfidence >= 55
                ? "warn"
                : "neg"
          }
          emphasize
        />
        <KpiCard
          label="4 Yönlü TDHP Uyum"
          value={`${fourWay.alignedCount} / ${fourWay.pillars.length}`}
          note={
            hasSubledgerVariance
              ? `Toplam mutlak fark: ${fmtTL(totalAbsVarianceTry)}`
              : "Alt-defter ve yönetim defteri tam mutabık"
          }
          tone={hasSubledgerVariance ? "warn" : "pos"}
          href="/data/reconciliation"
        />
        <KpiCard
          label="Açık İnceleme"
          value={d.openReviewCount}
          note={`Yüksek / acil: ${d.highOpenCount} · Mutabakat sinyali: ${d.reconciliationSignalCount}`}
          tone={d.highOpenCount > 0 ? "neg" : d.openReviewCount > 0 ? "warn" : "pos"}
          href="/data/reviews"
        />
        <KpiCard
          label="Eksik Tutar (R10)"
          value={d.missingAmountCount}
          note="Belirsiz tutarlar 0 TL sayılmaz; ayrı izlenir"
          tone={d.missingAmountCount > 0 ? "warn" : "pos"}
          href="/payments/missing"
        />
      </div>

      {/* Row 2: 2-Column Visual Cockpit — Data Confidence Donut + TDHP Subledger Columns */}
      <div className="grid gap-3.5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-6">
          <Panel
            title="Veri Güveni & Doğrulama Kompozisyonu"
            subtitle="Doğrulanan kontroller, inceleme bekleyen kayıtlar, R10 eksik alanlar ve acil sinyaller"
            right={
              <span className="font-mono text-[11px] text-tone-3">
                Tarife uyarısı: {d.staleProductionRateCount}
              </span>
            }
          >
            <EditorialDonutChartSvg
              size={150}
              slices={qualitySlices}
              centerLabel="KARAR GÜVENİ"
              centerValue={`%${d.decisionConfidence}`}
              centerSubtext={d.decisionConfidenceLabel}
              ariaLabel="Veri kalitesi dağılımı: doğrulanan kayıtlar, açık incelemeler, eksik tutarlar ve acil sorunlar"
            />
          </Panel>
        </div>

        <div className="min-w-0 lg:col-span-6">
          <Panel
            title="4 Yönlü TDHP Alt-Defter & Yönetim Defteri Sütunları"
            subtitle={
              hasSubledgerVariance
                ? "Operasyonel alt-defter ile TDHP yönetim defteri arasındaki mutlak sapma tutarları (TRY)"
                : "4/4 TDHP sütunu mutabık (Sapma: 0 TL) — doğrulanan alt-defter bakiye büyüklükleri (TRY)"
            }
            right={
              <Badge tone={hasSubledgerVariance ? "amber" : "green"}>
                {hasSubledgerVariance
                  ? `${fourWay.divergentCount} sütunda sapma`
                  : "4/4 Mutabık · 0 TL Fark"}
              </Badge>
            }
          >
            <AgingBucketsBarSvg
              buckets={subledgerBuckets}
              ariaLabel="4 yönlü TDHP alt-defter ve yönetim defteri bakiye/sapma karşılaştırma sütunları"
            />
          </Panel>
        </div>
      </div>

      <Panel
        title="4 YÖNLÜ ALT-DEFTER ↔ TDHP YÖNETİM DEFTERİ SAĞLIK MATRİSİ"
        subtitle="Operasyonel alt tablolar ile çift taraflı yönetim defteri (management_journal_lines) arasındaki canlı mutabakat ve sapma ölçeği"
        right={
          <Link className="text-xs text-info hover:underline" href="/data/reconciliation">
            Dönem İmzalama &amp; Mutabakat Masası →
          </Link>
        }
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1.5 pr-2">Alt-Defter Sütunu</th>
                <th className="py-1.5 pr-2">TDHP Hesapları</th>
                <th className="py-1.5 pr-2 text-right">Operasyonel Bakiye (TRY)</th>
                <th className="py-1.5 pr-2 text-right">Yönetim Defteri (TRY)</th>
                <th className="py-1.5 pr-2">Alt-Defter vs Defter Ölçeği</th>
                <th className="py-1.5 pr-2 text-right">Fark (TRY)</th>
                <th className="py-1.5">Durum</th>
              </tr>
            </thead>
            <tbody>
              {fourWay.pillars.map((p) => (
                <tr key={p.key} className="border-b border-line-faint">
                  <td className="py-2 pr-2">
                    <div className="font-medium text-tone-1">{p.title}</div>
                    <div className="text-[11px] text-tone-3">{p.detail}</div>
                  </td>
                  <td className="py-2 pr-2 font-mono text-tone-2">{p.tdhpCodes}</td>
                  <td className="py-2 pr-2 text-right font-mono tabular-nums">
                    {p.subledgerTry == null ? "—" : fmtTL(p.subledgerTry)}
                  </td>
                  <td className="py-2 pr-2 text-right font-mono tabular-nums">
                    {p.glLedgerTry == null ? "—" : fmtTL(p.glLedgerTry)}
                  </td>
                  <td className="py-2 pr-2">
                    {p.subledgerTry == null || p.glLedgerTry == null ? (
                      <span className="text-xs text-tone-3">Ölçülemez (FIN-03 / eksik kaynak)</span>
                    ) : (
                      <BulletBarSvg
                        actual={Math.abs(p.subledgerTry)}
                        target={Math.abs(p.glLedgerTry)}
                        label={`${p.title}: alt-defter vs yönetim defteri`}
                        status={p.aligned ? "pos" : "warn"}
                      />
                    )}
                  </td>
                  <td
                    className={`py-2 pr-2 text-right font-mono font-semibold tabular-nums ${
                      p.aligned ? "text-pos" : "text-warn"
                    }`}
                  >
                    {p.deltaTry == null ? "—" : fmtTL(p.deltaTry)}
                  </td>
                  <td className="py-2">
                    <Badge tone={p.aligned ? "green" : "amber"}>
                      {p.aligned
                        ? "Mutabık"
                        : p.subledgerTry == null || p.glLedgerTry == null
                          ? "Bilinmiyor"
                          : "Fark İncele"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Öncelikli beş problem"
          right={
            <Link className="text-xs text-info hover:underline" href="/data/reviews">
              Tüm incelemeler →
            </Link>
          }
        >
          {d.blockers.map((r) => (
            <div key={r.id} className="border-b border-line-faint py-2">
              <Link href={r.source_href} className="text-sm">
                <b>
                  {r.severity} · {r.issue_type}
                </b>
                <p className="text-tone-3">{r.message}</p>
              </Link>
            </div>
          ))}
        </Panel>

        <Panel title="Sorun dağılımı">
          {d.issueCounts.map((r) => (
            <div
              key={r.issue_type}
              className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-line-faint py-2 text-sm"
            >
              <span>{r.issue_type}</span>
              <span>{r.open_n} açık</span>
              <span>{r.n} toplam</span>
            </div>
          ))}
        </Panel>

        <Panel
          title="Çalışma kitabı farkı"
          right={
            <Link className="text-xs text-info hover:underline" href="/data/reconciliation">
              Mutabakatı aç →
            </Link>
          }
        >
          <p className="text-sm">
            {d.workbookDiff.ready
              ? `${d.workbookDiff.changedSheets.length} sekme farkı bulundu.`
              : "Karşılaştırma için en az iki çalışma kitabı gerekli."}
          </p>
          {d.workbookDiff.changedSheets.slice(0, 6).map((s) => (
            <div key={`${s.sheet_name}-${s.side}`} className="border-t border-line-faint py-1 text-xs">
              {s.sheet_name} · {s.side} · {s.impact}
            </div>
          ))}
        </Panel>

        <Panel title="Özel Excel sekmeleri">
          {d.specialSheets.length ? (
            d.specialSheets.map((s, i) => (
              <div
                key={`${s.workbook_name}-${s.sheet_name}-${i}`}
                className="border-b border-line-faint py-2 text-sm"
              >
                <b>{s.sheet_name}</b>
                <p className="text-xs text-tone-3">
                  {s.workbook_name} · {s.detected_type ?? "bilinmiyor"} · {s.parse_confidence}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-tone-3">Özel dashboard veya rehber sekmesi bulunmadı.</p>
          )}
        </Panel>
      </div>

      <Panel
        title="Son veri kalite denetimleri"
        right={
          <Link className="text-xs text-info hover:underline" href="/system/audit">
            Tüm denetim kayıtları →
          </Link>
        }
      >
        {d.auditTrail.map((a, i) => (
          <div
            key={`${a.action}-${a.entity_id}-${i}`}
            className="grid grid-cols-[150px_1fr_auto] gap-3 border-b border-line-faint py-2 text-sm"
          >
            <span className="font-mono text-xs text-tone-2">{a.created_at}</span>
            <span>{a.action}</span>
            <Badge tone="neutral">{a.entity_table}</Badge>
          </div>
        ))}
      </Panel>
    </>
  );
}
