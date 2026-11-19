import { RadialMeterSvg } from "@/components/charts/folio-visuals";
import Link from "@/components/ui/app-link";
import { EntityCommentsPanel } from "@/components/ui/entity-comments-panel";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { listEntityComments } from "@/lib/collaboration/comments";
import { getPool } from "@/lib/db";
import { getActiveEntityScope } from "@/lib/entities/engine";
import {
  loadAlerts,
  loadAnomalies,
  loadControlDashboard,
  loadEscalationsDue,
  loadFalsePositiveRates,
} from "@/lib/controls/engine";
import {
  ALERT_STATUS_LABEL,
  ANOMALY_LABEL,
  CHECK_DIRECTION_LABEL,
  CONTROL_EVIDENCE_LABEL,
  IBAN_CHANGE_TYPE_LABEL,
  PAYMENT_RECURRENCE_LABEL,
  SEVERITY_LABEL,
  type AlertStatus,
  type AnomalyRule,
  type Severity,
} from "@/lib/controls/rules";
import { intOrNull, moneyOrNull, rateOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { raiseActionItemAction, setAlertStatusAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, Tone> = {
  PASS: "green",
  INFO: "neutral",
  WARNING: "amber",
  CRITICAL: "red",
};

const STATUS_TONE: Record<AlertStatus, Tone> = {
  open: "red",
  acknowledged: "amber",
  snoozed: "neutral",
  resolved: "green",
  false_positive: "neutral",
};

const RESULT_MESSAGE: Record<string, string> = {
  updated: "Uyarı durumu ve triyaj notu kaydedildi.",
  task_raised: "Uyarı için aksiyon görevi oluşturuldu ve görev kuyruğuna bağlandı.",
};

interface SplitPaymentRow {
  party_id?: string | null;
  party_name: string;
  due_date: string;
  payment_count: number | string;
  total_amount: string | number | null;
  foreign_currency_count?: number | string | null;
}

interface RoundNumberRow {
  payment_instance_id?: string | null;
  payment_name: string;
  amount: string | number | null;
  currency?: string | null;
}

interface NewPayeeRow {
  party_id?: string | null;
  party_name: string;
  first_payment_date: string;
}

interface AboveBaselineRow {
  payment_instance_id?: string | null;
  party_name?: string | null;
  payment_name?: string | null;
  amount?: string | number | null;
  baseline_avg?: string | number | null;
  ratio?: string | number | null;
  currency?: string | null;
}

interface UnusualRecordHourRow {
  txn_id?: string | null;
  txn_date: string;
  recorded_hour: number | string;
  amount: string | number | null;
  currency?: string | null;
}

export default async function ControlsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; result?: string }>;
}) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapısı (canSeeRoute ile tek kaynak).
  const denied = await requireRouteAccess("/system/controls");
  if (denied) return denied;
  const sp = await searchParams;
  const session = await getRequestUser();
  const pool = getPool();

  const [
    dashboard,
    alerts,
    escalations,
    fpRates,
    anomalies,
    sharedIbansRes,
    overpaidRes,
    entityScope,
  ] = await Promise.all([
    loadControlDashboard(pool),
    loadAlerts(pool, 60),
    loadEscalationsDue(pool),
    loadFalsePositiveRates(pool),
    loadAnomalies(pool),
    pool.query<{
      iban_normalized: string;
      party_count: string;
      party_names: string[] | null;
    }>(
      `select iban_normalized,
              party_count::text,
              party_names
         from public.iban_shared_across_parties
        order by party_count desc, iban_normalized
        limit 50`,
    ),
    pool.query<{
      id: string;
      invoice_no: string;
      party_id: string;
      party_name: string;
      gross_amount: string;
      paid_amount: string;
      overpaid_by: string;
      status: string;
      currency: string;
    }>(
      `select io.id::text,
              io.invoice_no,
              io.party_id::text,
              io.party_name,
              io.gross_amount::text,
              io.paid_amount::text,
              io.overpaid_by::text,
              io.status,
              coalesce(inv.currency, 'TRY') as currency
         from public.invoice_overpaid io
         left join public.invoices inv on inv.id = io.id
        order by io.overpaid_by desc
        limit 50`,
    ),
    getActiveEntityScope(pool),
  ]);

  const activeScopeKey = entityScope.legalEntityId ?? "consolidated";
  const reviewComments = await listEntityComments(pool, "control_review", activeScopeKey);
  const canPostComment = session ? can(session.role, "entity_comments", "insert") : false;

  const sharedIbans = sharedIbansRes.rows.map((r) => ({
    ibanNormalized: r.iban_normalized,
    partyCount: intOrNull(r.party_count) ?? 0,
    partyNames: r.party_names ?? [],
  }));

  const overpaidInvoices = overpaidRes.rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_no,
    partyId: r.party_id,
    partyName: r.party_name,
    grossAmount: moneyOrNull(r.gross_amount) ?? 0,
    paidAmount: moneyOrNull(r.paid_amount) ?? 0,
    overpaidBy: moneyOrNull(r.overpaid_by) ?? 0,
    status: r.status,
    currency: r.currency || "TRY",
  }));

  const critical = dashboard.filter((d) => d.state === "CRITICAL");
  const attentionControls = dashboard.filter((d) => d.state !== "PASS");
  const passCount = dashboard.filter((d) => d.state === "PASS").length;
  const openAlerts = alerts.filter((a) => a.status === "open");

  const splitPayments = (anomalies.splitPayments ?? []) as SplitPaymentRow[];
  const roundNumbers = (anomalies.roundNumber ?? []) as RoundNumberRow[];
  const newPayees = (anomalies.newPayees ?? []) as NewPayeeRow[];
  const aboveBaselines = (anomalies.aboveBaseline ?? []) as AboveBaselineRow[];
  const unusualHours = (anomalies.unusualRecordHour ?? []) as UnusualRecordHourRow[];
  const approvalBypasses = anomalies.approvalBypasses ?? [];
  const recentIbanChanges = anomalies.recentIbanChanges ?? [];
  const duplicateChecks = anomalies.duplicateChecks ?? [];
  const duplicatePayments = anomalies.duplicatePayments ?? [];

  const totalEvidenceCount =
    approvalBypasses.length +
    recentIbanChanges.length +
    duplicateChecks.length +
    duplicatePayments.length;

  const totalAnomalyCount =
    splitPayments.length +
    roundNumbers.length +
    newPayees.length +
    aboveBaselines.length +
    unusualHours.length;
  const totalForensicCount = sharedIbans.length + overpaidInvoices.length;
  const resultBanner = sp.result ? (RESULT_MESSAGE[sp.result] ?? sp.result) : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Finansal Kontrol Merkezi"
        subtitle="Değişmez defter kuralları, deterministik anomali radarı ve triyaj iş akışı"
        meta={
          <Badge tone={critical.length > 0 ? "red" : "green"} dot>
            {critical.length > 0 ? `${critical.length} kritik kontrol` : "kritik bulgu yok"}
          </Badge>
        }
      />

      {sp.error ? (
        <div role="alert" className="rounded border border-warn tint-warn px-3.5 py-2.5 text-xs font-medium text-warn">
          {sp.error}
        </div>
      ) : null}

      {resultBanner ? (
        <div role="status" className="rounded border border-pos tint-pos px-3.5 py-2.5 text-xs font-medium text-pos">
          {resultBanner}
        </div>
      ) : null}

      {/* Editorial Parchment Narrative Card — replaces dry data overload with human executive context */}
      <section className="parchment-folio-banner" aria-label="İç kontrol denge özeti">
        <div className="space-y-1.5">
          <div className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-info">
            İÇ DENETİM FOLYOSU · DETERMINİSTİK DEĞİŞMEZLER
          </div>
          <h2 className="text-[16px] font-bold tracking-[-0.015em] text-tone-1">
            {critical.length === 0 && openAlerts.length === 0
              ? `Tüm ${dashboard.length} değişmez kontrol dengede — bekleyen kritik ihlal yok.`
              : `${openAlerts.length} açık uyarı ve ${attentionControls.length} dikkat gerektiren kontrol operatör triyajı bekliyor.`}
          </h2>
          <p className="max-w-2xl text-[12.5px] leading-relaxed text-tone-2">
            Öncelikli triyaj kuyruğu hemen aşağıda açık tutulur; sorunsuz geçen değişmez kurallar,
            anomali taramaları ve BEC/fazla ödeme denetimleri ekran kalabalığını önlemek için katmanlı
            parşömen çekmecelerde sunulur.
          </p>
        </div>
        <div className="parchment-folio-art" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/visuals/internal-controls-hero.jpg"
            alt=""
            loading="eager"
            decoding="async"
          />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-12">
        <div className="folio-corner-mark rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[var(--shadow-xs)] lg:col-span-5">
          <RadialMeterSvg
            percent={dashboard.length > 0 ? (passCount / dashboard.length) * 100 : null}
            label="İç Kontrol Uyum Skoru"
            sublabel={
              dashboard.length > 0
                ? `${passCount} / ${dashboard.length} değişmez kural uyumlu · Hedef %80`
                : "Henüz kontrol sonucu yok"
            }
            targetPercent={80}
          />
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:col-span-7">
          <KeyStat label="Kontrol" value={dashboard.length} tone="info" />
          <KeyStat label="PASS" value={passCount} tone="pos" />
          <KeyStat
            label="Açık uyarı"
            value={openAlerts.length}
            tone={openAlerts.length > 0 ? "warn" : "pos"}
          />
          <KeyStat
            label="Eskalasyon zamanı gelmiş"
            value={escalations.length}
            tone={escalations.length > 0 ? "neg" : "pos"}
          />
        </div>
      </div>

      {escalations.length > 0 ? (
        <Panel
          title="ESKALASYON ZAMANI GELMİŞ"
          subtitle="yalnız AÇIK uyarılar yükselir — yanıt veren operatör cezalandırılmaz"
          accent="neg"
        >
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Bulgu</th>
                  <th>Ciddiyet</th>
                  <th>Kural</th>
                  <th className="text-right">Pencere</th>
                  <th>Kanal</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map((e) => (
                  <tr key={e.alertId} className="border-t border-line-faint">
                    <td className="py-2">{e.title}</td>
                    <td>
                      <Badge tone="red">{SEVERITY_LABEL[e.severity as Severity]}</Badge>
                    </td>
                    <td className="text-xs">{e.escalationRule}</td>
                    <td className="text-right tabular-nums">{e.escalateAfterHours} saat</td>
                    <td className="text-xs">{e.channel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      {/* Primary Actionable Surface: Alert Triage Queue */}
      <Panel
        title={`UYARILAR (${alerts.length})`}
        subtitle="görüldü / ertelendi / çözüldü / yanlış alarm triyajı"
        accent={openAlerts.length > 0 ? "warn" : "pos"}
      >
        {alerts.length === 0 ? (
          <EmptyState>Uyarı yok — tüm kontrol kuralları temiz.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Bulgu</th>
                  <th>Ciddiyet</th>
                  <th className="text-right">Skor</th>
                  <th className="text-right">Tekrar</th>
                  <th>Durum</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => {
                  const alertCurrency = a.currency || "TRY";
                  return (
                    <tr key={a.id} className="border-t border-line-faint align-top">
                      <td className="py-2">
                        <span className="font-medium text-tone-1">{a.title}</span>
                        <span className="block text-xs text-tone-3">
                          {a.checkCode}
                          {a.ruleCodes.length > 0 ? ` · ${a.ruleCodes.join(", ")}` : ""}
                        </span>
                        {a.amount != null ? (
                          <span className="block font-mono text-xs tabular-nums text-tone-2">
                            {formatMoney(a.amount, alertCurrency)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <Badge
                          tone={
                            a.severity === "critical"
                              ? "red"
                              : a.severity === "warning"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {SEVERITY_LABEL[a.severity as Severity]}
                        </Badge>
                      </td>
                      <td className="text-right tabular-nums">
                        {a.anomalyScore == null ? "—" : a.anomalyScore.toFixed(2)}
                      </td>
                      <td className="text-right tabular-nums">{a.occurrenceCount}</td>
                      <td>
                        <Badge tone={STATUS_TONE[a.status]}>{ALERT_STATUS_LABEL[a.status]}</Badge>
                      </td>
                      <td className="py-2">
                        {a.status === "resolved" || a.status === "false_positive" ? (
                          <span className="text-xs text-tone-3">{a.resolutionNote || "Kapatıldı"}</span>
                        ) : (
                          <form action={setAlertStatusAction} className="flex flex-wrap items-center gap-1">
                            <input type="hidden" name="alertId" value={a.id} />
                            <input
                              name="note"
                              placeholder="gerekçe"
                              aria-label="Triyaj gerekçesi"
                              title="Triyaj gerekçesi"
                              className="field-control w-24 px-1.5 py-1 text-[11px]"
                            />
                            <input
                              type="date"
                              name="snoozeUntil"
                              aria-label="Erteleme tarihi"
                              title="Erteleme tarihi"
                              className="field-control w-32 px-1.5 py-1 text-[11px]"
                            />
                            {a.status !== "acknowledged" ? (
                              <button
                                type="submit"
                                name="status"
                                value="acknowledged"
                                className="button-ghost px-2 py-1 text-xs"
                              >
                                Gördüm
                              </button>
                            ) : null}
                            <button
                              type="submit"
                              name="status"
                              value="snoozed"
                              className="button-ghost px-2 py-1 text-xs"
                            >
                              Ertele
                            </button>
                            <button
                              type="submit"
                              name="status"
                              value="resolved"
                              className="rounded border border-pos tint-pos px-2 py-1 text-xs font-semibold text-pos"
                            >
                              Çözüldü
                            </button>
                            <button
                              type="submit"
                              name="status"
                              value="false_positive"
                              className="rounded border border-warn tint-warn px-2 py-1 text-xs font-semibold text-warn"
                            >
                              Yanlış alarm
                            </button>
                          </form>
                        )}
                        {a.actionItemId == null &&
                        a.status !== "resolved" &&
                        a.status !== "false_positive" ? (
                          <form action={raiseActionItemAction} className="mt-1">
                            <input type="hidden" name="alertId" value={a.id} />
                            <button type="submit" className="button-ghost px-2 py-0.5 text-[11px]">
                              görev aç
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {/* Dedicated Live Evidence Panel: Approval Bypass, Recent Unapproved IBAN Changes & Duplicate Records */}
      <Panel
        title="Kritik Onay, IBAN ve Mükerrer Kayıt Bulguları"
        subtitle="Canlı veritabanı denetim görünümlerinden (approval_bypass, iban_changed, duplicate_check, duplicate_payment_template) anlık kanıt satırları"
        accent={
          approvalBypasses.length > 0 || recentIbanChanges.length > 0
            ? "neg"
            : totalEvidenceCount > 0
              ? "warn"
              : "pos"
        }
        right={
          <Badge
            tone={
              approvalBypasses.length > 0 || recentIbanChanges.length > 0
                ? "red"
                : totalEvidenceCount > 0
                  ? "amber"
                  : "green"
            }
          >
            {totalEvidenceCount > 0 ? `${totalEvidenceCount} canlı bulgu` : "bulgu yok"}
          </Badge>
        }
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* 1. Approval Bypass */}
          <div className="rounded border border-line-faint bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-tone-1">
                {CONTROL_EVIDENCE_LABEL.approval_bypass} ({approvalBypasses.length})
              </span>
              <Link href="/payments/items" className="font-mono text-xs text-tone-2 hover:underline">
                Ödeme Kalemleri →
              </Link>
            </div>
            {approvalBypasses.length === 0 ? (
              <EmptyState>Onay atlanmış eşik üstü ödeme bulgusu yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-3">
                      <th className="py-1">Kalem / Kayıt</th>
                      <th>Vade</th>
                      <th className="text-right">Tutar</th>
                      <th className="text-right">Eşik</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approvalBypasses.map((b) => (
                      <tr key={b.paymentInstanceId} className="border-t border-line-faint align-top">
                        <td className="py-1.5">
                          <span className="font-medium text-tone-1">{b.paymentName}</span>
                          <span className="block font-mono text-[11px] text-tone-3">
                            #{b.paymentInstanceId.slice(0, 8)}
                            {b.needsFxReview ? " · Kur incelemesi gerekli" : ""}
                          </span>
                        </td>
                        <td className="py-1.5 font-mono text-tone-2">{b.dueDate ?? "—"}</td>
                        <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-neg">
                          {b.amount == null ? "—" : formatMoney(b.amount, b.currency)}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums text-tone-3">
                          {b.thresholdAmount == null ? "—" : formatMoney(b.thresholdAmount, "TRY")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>

          {/* 2. Recent Unapproved IBAN Changes */}
          <div className="rounded border border-line-faint bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-tone-1">
                {CONTROL_EVIDENCE_LABEL.iban_changed} ({recentIbanChanges.length})
              </span>
              <Link
                href="/finance/counterparties"
                className="font-mono text-xs text-tone-2 hover:underline"
              >
                IBAN Kasası →
              </Link>
            </div>
            {recentIbanChanges.length === 0 ? (
              <EmptyState>Son 30 günde doğrulanmamış aktif IBAN değişimi yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-3">
                      <th className="py-1">Karşı Taraf / IBAN</th>
                      <th>İşlem</th>
                      <th>Tarih</th>
                      <th>Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentIbanChanges.map((ib) => (
                      <tr key={ib.eventId} className="border-t border-line-faint align-top">
                        <td className="py-1.5">
                          <span className="font-medium text-tone-1">
                            {ib.partyName ?? "(Karşı taraf)"}
                          </span>
                          <span className="block font-mono text-[11px] text-tone-2">
                            {ib.ibanNormalized || "—"}
                          </span>
                        </td>
                        <td className="py-1.5 text-tone-2">
                          {IBAN_CHANGE_TYPE_LABEL[ib.changeType] ?? ib.changeType}
                        </td>
                        <td className="py-1.5 font-mono text-tone-3">{ib.changedAt}</td>
                        <td className="py-1.5">
                          <Badge tone="red">{ib.approvalStatus}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>

          {/* 3. Duplicate Checks */}
          <div className="rounded border border-line-faint bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-tone-1">
                {CONTROL_EVIDENCE_LABEL.duplicate_check} ({duplicateChecks.length})
              </span>
              <Link href="/finance/checks" className="font-mono text-xs text-tone-2 hover:underline">
                Çek / Senet →
              </Link>
            </div>
            {duplicateChecks.length === 0 ? (
              <EmptyState>Mükerrer çek / senet bulgusu yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-3">
                      <th className="py-1">Lehtar / Keşideci</th>
                      <th>Vade</th>
                      <th>Yön / Seri</th>
                      <th className="text-right">Tutar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicateChecks.map((chk) => (
                      <tr
                        key={`${chk.checkId}-${chk.duplicateOfCheckId}`}
                        className="border-t border-line-faint align-top"
                      >
                        <td className="py-1.5">
                          <span className="font-medium text-tone-1">{chk.counterpartyLabel}</span>
                          <span className="block font-mono text-[11px] text-tone-3">
                            #{chk.checkId.slice(0, 8)} ↔ #{chk.duplicateOfCheckId.slice(0, 8)}
                          </span>
                        </td>
                        <td className="py-1.5 font-mono text-tone-2">{chk.maturityDate ?? "—"}</td>
                        <td className="py-1.5 text-tone-2">
                          {CHECK_DIRECTION_LABEL[chk.direction] ?? chk.direction}
                          {chk.serialNo ? ` · ${chk.serialNo}` : " · seri yok"}
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-warn">
                          {chk.amount == null ? "—" : formatMoney(chk.amount, chk.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>

          {/* 4. Duplicate Payment Templates */}
          <div className="rounded border border-line-faint bg-surface-2 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase text-tone-1">
                {CONTROL_EVIDENCE_LABEL.duplicate_payment_template} ({duplicatePayments.length})
              </span>
              <Link href="/payments" className="font-mono text-xs text-tone-2 hover:underline">
                Ödeme Şablonları →
              </Link>
            </div>
            {duplicatePayments.length === 0 ? (
              <EmptyState>Mükerrer aktif ödeme şablonu bulgusu yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-3">
                      <th className="py-1">Şablon</th>
                      <th>Sıklık / Gün</th>
                      <th className="text-right">Varsayılan Tutar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicatePayments.map((dp) => (
                      <tr
                        key={`${dp.paymentId}-${dp.duplicateOfPaymentId}`}
                        className="border-t border-line-faint align-top"
                      >
                        <td className="py-1.5">
                          <span className="font-medium text-tone-1">{dp.paymentName}</span>
                          <span className="block font-mono text-[11px] text-tone-3">
                            #{dp.paymentId.slice(0, 8)} ↔ #{dp.duplicateOfPaymentId.slice(0, 8)}
                          </span>
                        </td>
                        <td className="py-1.5 text-tone-2">
                          {PAYMENT_RECURRENCE_LABEL[dp.recurrenceType] ?? dp.recurrenceType}
                          {dp.dueDay != null ? ` · Gün ${dp.dueDay}` : ""}
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-warn">
                          {dp.defaultAmount == null
                            ? "—"
                            : formatMoney(dp.defaultAmount, dp.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>
        </div>
      </Panel>

      {/* Layer 2 (Progressive Disclosure): Invariant Matrix */}
      <details className="parchment-disclosure" open={attentionControls.length > 0}>
        <summary>
          <span className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <span>
              <span className="block text-[13.5px] font-semibold text-tone-1">
                KONTROL PANOSU · Tüm Değişmez Kurallar Matrisi
              </span>
              <span className="block text-[11.5px] text-tone-3">
                Bulgu yokken de listelenir — sessizce kaybolan kontrol fark edilmez
              </span>
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone="green">{passCount} PASS</Badge>
            {attentionControls.length > 0 ? (
              <Badge tone={critical.length > 0 ? "red" : "amber"}>
                {attentionControls.length} İnceleme
              </Badge>
            ) : null}
          </span>
        </summary>
        <div className="parchment-disclosure-body">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Kontrol</th>
                  <th>Durum</th>
                  <th className="text-right">Bulgu</th>
                  <th>Zorlama</th>
                  <th>Gerekçe</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.map((d) => (
                  <tr key={d.checkCode} className="border-t border-line-faint align-top">
                    <td className="py-2">
                      <span className="font-medium text-tone-1">{d.title}</span>
                      <span className="block font-mono text-xs text-tone-3">{d.checkCode}</span>
                    </td>
                    <td>
                      <Badge tone={STATE_TONE[d.state] ?? "neutral"}>{d.state}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{d.findingCount}</td>
                    <td>
                      <Badge tone={d.enforcement === "enforced_elsewhere" ? "green" : "amber"}>
                        {d.enforcement === "enforced_elsewhere" ? "zaten zorlanıyor" : "yalnız tespit"}
                      </Badge>
                    </td>
                    <td className="text-xs text-tone-2">{d.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </div>
      </details>

      {/* Layer 3 (Progressive Disclosure): BEC IBAN & Overpaid Invoices */}
      <details className="parchment-disclosure" open={totalForensicCount > 0}>
        <summary>
          <span className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <span>
              <span className="block text-[13.5px] font-semibold text-tone-1">
                BEC IBAN ÇAKIŞMASI &amp; FAZLA ÖDENMİŞ FATURALAR
              </span>
              <span className="block text-[11.5px] text-tone-3">
                Sahte tedarikçi yönlendirmesi (BEC) erken uyarısı ve brüt tutarı aşan fatura ödemeleri
              </span>
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={sharedIbans.length > 0 ? "red" : "neutral"}>
              Paylaşılan IBAN: {sharedIbans.length}
            </Badge>
            <Badge tone={overpaidInvoices.length > 0 ? "amber" : "neutral"}>
              Fazla Ödeme: {overpaidInvoices.length}
            </Badge>
          </span>
        </summary>
        <div className="parchment-disclosure-body grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel
            title={`PAYLAŞILAN IBAN RİSKİ (BEC KONTROLÜ) — ${sharedIbans.length}`}
            subtitle="Birden fazla aktif karşı tarafa tanımlanmış aynı IBAN kayıtları"
            right={
              <Link
                href="/finance/counterparties"
                className="font-mono text-xs text-tone-2 hover:underline"
              >
                IBAN Kasası →
              </Link>
            }
          >
            {sharedIbans.length === 0 ? (
              <EmptyState>Paylaşılan aktif IBAN riski bulunmuyor.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-2">
                      <th className="py-1.5">IBAN</th>
                      <th className="text-right">Cari Sayısı</th>
                      <th>Paylaşan Karşı Taraflar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sharedIbans.map((row) => (
                      <tr key={row.ibanNormalized} className="border-t border-line text-tone-1">
                        <td className="py-1.5 font-mono">{row.ibanNormalized}</td>
                        <td className="text-right">
                          <Badge tone="red">{row.partyCount} cari</Badge>
                        </td>
                        <td className="text-tone-2">{row.partyNames.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </Panel>

          <Panel
            title={`FAZLA ÖDENMİŞ FATURALAR — ${overpaidInvoices.length}`}
            subtitle="Ödenen tutarı brüt fatura tutarını aşan kayıtlar; iade veya cari mahsup incelemesi"
            right={
              <Link
                href="/finance/invoices"
                className="font-mono text-xs text-tone-2 hover:underline"
              >
                Faturalar →
              </Link>
            }
          >
            {overpaidInvoices.length === 0 ? (
              <EmptyState>Fazla ödenmiş fatura bulgusu bulunmuyor.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase text-tone-2">
                      <th className="py-1.5">Fatura No</th>
                      <th>Karşı Taraf</th>
                      <th className="text-right">Brüt</th>
                      <th className="text-right">Ödenen</th>
                      <th className="text-right">Fazla Tutar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overpaidInvoices.map((op) => (
                      <tr key={op.id} className="border-t border-line text-tone-1">
                        <td className="py-1.5 font-mono">{op.invoiceNo}</td>
                        <td>{op.partyName}</td>
                        <td className="text-right font-mono tabular-nums">
                          {formatMoney(op.grossAmount, op.currency)}
                        </td>
                        <td className="text-right font-mono tabular-nums">
                          {formatMoney(op.paidAmount, op.currency)}
                        </td>
                        <td className="text-right font-mono font-semibold tabular-nums text-neg">
                          +{formatMoney(op.overpaidBy, op.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </Panel>
        </div>
      </details>

      {/* Layer 4 (Progressive Disclosure): All 5 Deterministic Anomaly Detectors + False-Positive Calibration */}
      <details className="parchment-disclosure" open={totalAnomalyCount > 0}>
        <summary>
          <span className="flex items-center gap-2.5">
            <span className="parchment-disclosure-chevron" aria-hidden="true">
              ▸
            </span>
            <span>
              <span className="block text-[13.5px] font-semibold text-tone-1">
                ANOMALİ TESPİTİ &amp; YANLIŞ ALARM KALİBRASYONU (5 Deterministik Kural)
              </span>
              <span className="block text-[11.5px] text-tone-3">
                Bölünmüş ödeme, yuvarlak tutar, ilk kez ödenen cari, geçmiş ortalama aşımı ve olağandışı kayıt saati
              </span>
            </span>
          </span>
          <Badge tone={totalAnomalyCount > 0 ? "amber" : "neutral"}>
            {totalAnomalyCount} anomali sinyali
          </Badge>
        </summary>
        <div className="parchment-disclosure-body space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded border border-line-faint bg-surface-2 p-3">
              <div className="mb-1 text-xs font-semibold uppercase text-tone-3">
                {ANOMALY_LABEL["split_payment" as AnomalyRule]}
              </div>
              {splitPayments.length === 0 ? (
                <p className="text-xs text-tone-3">Bulgu yok.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {splitPayments.slice(0, 6).map((s) => {
                    const foreignCount = intOrNull(s.foreign_currency_count) ?? 0;
                    const rowKey = `${s.party_id ?? s.party_name}-${String(s.due_date).slice(0, 10)}`;
                    return (
                      <li key={rowKey}>
                        {s.party_name} · {intOrNull(s.payment_count) ?? 0} ödeme ·{" "}
                        {fmtTL(moneyOrNull(s.total_amount))}
                        {foreignCount > 0 ? (
                          <span className="ml-1 text-warn">
                            · {foreignCount} TRY-dışı toplamda yok
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="rounded border border-line-faint bg-surface-2 p-3">
              <div className="mb-1 text-xs font-semibold uppercase text-tone-3">
                {ANOMALY_LABEL["round_number" as AnomalyRule]}
              </div>
              {roundNumbers.length === 0 ? (
                <p className="text-xs text-tone-3">Bulgu yok.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {roundNumbers.slice(0, 6).map((r) => {
                    const amt = moneyOrNull(r.amount);
                    const ccy = r.currency || "TRY";
                    const rowKey = `${r.payment_instance_id ?? r.payment_name}-${String(r.amount)}`;
                    return (
                      <li key={rowKey}>
                        {r.payment_name} · {amt == null ? "TUTAR EKSİK" : formatMoney(amt, ccy)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="rounded border border-line-faint bg-surface-2 p-3">
              <div className="mb-1 text-xs font-semibold uppercase text-tone-3">
                {ANOMALY_LABEL["new_payee" as AnomalyRule]}
              </div>
              {newPayees.length === 0 ? (
                <p className="text-xs text-tone-3">Bulgu yok.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {newPayees.slice(0, 6).map((n) => (
                    <li key={`${n.party_id ?? n.party_name}-${String(n.first_payment_date).slice(0, 10)}`}>
                      {n.party_name} · ilk ödeme {String(n.first_payment_date).slice(0, 10)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded border border-line-faint bg-surface-2 p-3">
              <div className="mb-1 text-xs font-semibold uppercase text-tone-3">
                {ANOMALY_LABEL["amount_vs_baseline" as AnomalyRule]}
              </div>
              {aboveBaselines.length === 0 ? (
                <p className="text-xs text-tone-3">Bulgu yok.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {aboveBaselines.slice(0, 6).map((b, idx) => {
                    const amt = moneyOrNull(b.amount);
                    const mult = rateOrNull(b.ratio);
                    const ccy = b.currency || "TRY";
                    const label = b.party_name || b.payment_name || "Ödeme";
                    const rowKey = b.payment_instance_id ?? `${label}-${String(b.amount ?? idx)}`;
                    return (
                      <li key={rowKey}>
                        {label} · {amt == null ? "TUTAR EKSİK" : formatMoney(amt, ccy)}
                        {mult != null ? ` (${mult.toFixed(1)}× ortalama)` : ""}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="rounded border border-line-faint bg-surface-2 p-3 sm:col-span-2">
              <div className="mb-1 text-xs font-semibold uppercase text-tone-3">
                {ANOMALY_LABEL["unusual_record_hour" as AnomalyRule]}
              </div>
              <p className="mb-1 text-[10.5px] text-warn">
                Şemada işlem saati yok — bu, kaydın sisteme girildiği saattir.
              </p>
              {unusualHours.length === 0 ? (
                <p className="text-xs text-tone-3">Bulgu yok.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {unusualHours.slice(0, 6).map((h) => {
                    const amt = moneyOrNull(h.amount);
                    const ccy = h.currency || "TRY";
                    const rowKey = `${h.txn_id ?? String(h.txn_date).slice(0, 10)}-${String(h.recorded_hour)}-${String(h.amount)}`;
                    return (
                      <li key={rowKey}>
                        {String(h.txn_date).slice(0, 10)} · saat {intOrNull(h.recorded_hour) ?? h.recorded_hour} ·{" "}
                        {amt == null ? "TUTAR EKSİK" : formatMoney(amt, ccy)}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {fpRates.length > 0 ? (
            <Panel
              title="YANLIŞ ALARM ORANI"
              subtitle="yalnız KAPANMIŞ uyarılardan — triyaj edilmemiş kontrol kusursuz görünmez"
            >
              <TableShell>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase text-tone-3">
                      <th className="py-1">Kontrol</th>
                      <th className="text-right">Açık</th>
                      <th className="text-right">Çözüldü</th>
                      <th className="text-right">Yanlış alarm</th>
                      <th className="text-right">Oran</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fpRates.map((f) => (
                      <tr key={f.checkCode} className="border-t border-line-faint">
                        <td className="py-2 font-mono text-xs">{f.checkCode}</td>
                        <td className="text-right tabular-nums">{f.openCount}</td>
                        <td className="text-right tabular-nums">{f.resolvedCount}</td>
                        <td className="text-right tabular-nums">{f.falsePositiveCount}</td>
                        <td className="text-right tabular-nums">
                          {f.falsePositiveRate == null ? (
                            <span className="text-tone-3">henüz triyaj yok</span>
                          ) : (
                            `%${(f.falsePositiveRate * 100).toFixed(0)}`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            </Panel>
          ) : null}
        </div>
      </details>

      {/* İç Kontrol Kokpiti @mention İşbirliği ve Denetim Notları */}
      <EntityCommentsPanel
        entityType="control_review"
        entityId={activeScopeKey}
        comments={reviewComments}
        returnTo="/system/controls"
        canComment={canPostComment}
        title="İç Kontrol Denetim & Triyaj Yorumları (@mention)"
        description="Finans yöneticileri ve iç denetçiler aktif tüzel kişilik / konsolide kapsam üzerinde @kullanıcı etiketiyle triyaj kararlarını kayıt altına alabilir."
      />
    </div>
  );
}
