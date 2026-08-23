import { getPool } from "@/lib/db";
import {
  loadAlerts, loadAnomalies, loadControlDashboard, loadEscalationsDue, loadFalsePositiveRates,
} from "@/lib/controls/engine";
import {
  ALERT_STATUS_LABEL, ANOMALY_LABEL, SEVERITY_LABEL,
  type AlertStatus, type AnomalyRule, type Severity,
} from "@/lib/controls/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { raiseActionItemAction, setAlertStatusAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATE_TONE: Record<string, Tone> = {
  PASS: "green", INFO: "neutral", WARNING: "amber", CRITICAL: "red",
};
const STATUS_TONE: Record<AlertStatus, Tone> = {
  open: "red", acknowledged: "amber", snoozed: "neutral",
  resolved: "green", false_positive: "neutral",
};

export default async function ControlsPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/system/controls");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [dashboard, alerts, escalations, fpRates, anomalies] = await Promise.all([
    loadControlDashboard(pool),
    loadAlerts(pool, 60),
    loadEscalationsDue(pool),
    loadFalsePositiveRates(pool),
    loadAnomalies(pool),
  ]);

  const critical = dashboard.filter((d) => d.state === "CRITICAL");
  const openAlerts = alerts.filter((a) => a.status === "open");

  return (
    <>
      <PageHeader
        title="Finansal Kontrol Merkezi"
        subtitle="Değişmez kontroller, anomali tespiti ve uyarı iş akışı"
        meta={<Badge tone={critical.length > 0 ? "red" : "green"} dot>
          {critical.length > 0 ? `${critical.length} kritik kontrol` : "kritik bulgu yok"}
        </Badge>}
      />

      {sp.error ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{sp.error}</div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Kontrol" value={dashboard.length} tone="info" />
        <KeyStat label="PASS" value={dashboard.filter((d) => d.state === "PASS").length} tone="pos" />
        <KeyStat label="Açık uyarı" value={openAlerts.length} tone={openAlerts.length > 0 ? "warn" : "pos"} />
        <KeyStat label="Eskalasyon zamanı gelmiş" value={escalations.length}
          tone={escalations.length > 0 ? "neg" : "pos"} />
      </div>

      <Panel title="KONTROL PANOSU" subtitle="bulgu yokken de listelenir — sessizce kaybolan kontrol fark edilmez">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">Kontrol</th><th>Durum</th>
                <th className="text-right">Bulgu</th><th>Zorlama</th><th>Gerekçe</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.map((d) => (
                <tr key={d.checkCode} className="border-t border-neutral-800 align-top">
                  <td className="py-2">{d.title}
                    <span className="block text-xs text-neutral-600">{d.checkCode}</span>
                  </td>
                  <td><Badge tone={STATE_TONE[d.state] ?? "neutral"}>{d.state}</Badge></td>
                  <td className="text-right tabular-nums">{d.findingCount}</td>
                  {/* The distinction that keeps this layer honest: is the database already
                      preventing this, or is this view the only thing that notices? */}
                  <td>
                    <Badge tone={d.enforcement === "enforced_elsewhere" ? "green" : "amber"}>
                      {d.enforcement === "enforced_elsewhere" ? "zaten zorlanıyor" : "yalnız tespit"}
                    </Badge>
                  </td>
                  <td className="text-xs text-neutral-500">{d.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>

      <Panel title="UYARILAR" subtitle="görüldü / ertelendi / çözüldü / yanlış alarm">
        {alerts.length === 0 ? (
          <EmptyState>Uyarı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Bulgu</th><th>Ciddiyet</th>
                  <th className="text-right">Skor</th><th className="text-right">Tekrar</th>
                  <th>Durum</th><th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-t border-neutral-800 align-top">
                    <td className="py-2">{a.title}
                      <span className="block text-xs text-neutral-600">
                        {a.checkCode}
                        {a.ruleCodes.length > 0 ? ` · ${a.ruleCodes.join(", ")}` : ""}
                      </span>
                      {a.amount != null ? <span className="block text-xs">{fmtTL(a.amount)}</span> : null}
                    </td>
                    <td><Badge tone={a.severity === "critical" ? "red" : a.severity === "warning" ? "amber" : "neutral"}>
                      {SEVERITY_LABEL[a.severity as Severity]}
                    </Badge></td>
                    <td className="text-right tabular-nums">
                      {a.anomalyScore == null ? "—" : a.anomalyScore.toFixed(2)}
                    </td>
                    <td className="text-right tabular-nums">{a.occurrenceCount}</td>
                    <td><Badge tone={STATUS_TONE[a.status]}>{ALERT_STATUS_LABEL[a.status]}</Badge></td>
                    <td className="py-2">
                      {a.status === "resolved" || a.status === "false_positive" ? (
                        <span className="text-xs text-neutral-600">{a.resolutionNote}</span>
                      ) : (
                        <form action={setAlertStatusAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="alertId" value={a.id} />
                          <input name="note" placeholder="gerekçe"
                            className="w-24 rounded border border-neutral-700 bg-neutral-900 px-1 text-[11px]" />
                          <input type="date" name="snoozeUntil"
                            className="rounded border border-neutral-700 bg-neutral-900 px-1 text-[11px]" />
                          {a.status !== "acknowledged" ? (
                            <button name="status" value="acknowledged" className="rounded bg-neutral-700 px-2 py-1 text-xs">Gördüm</button>
                          ) : null}
                          <button name="status" value="snoozed" className="rounded bg-neutral-700 px-2 py-1 text-xs">Ertele</button>
                          <button name="status" value="resolved" className="rounded bg-emerald-800 px-2 py-1 text-xs">Çözüldü</button>
                          {/* First-class outcome, not a flavour of resolved: this is what makes a
                              per-rule false-positive rate computable. */}
                          <button name="status" value="false_positive" className="rounded bg-amber-800 px-2 py-1 text-xs">Yanlış alarm</button>
                        </form>
                      )}
                      {a.actionItemId == null && a.status !== "resolved" && a.status !== "false_positive" ? (
                        <form action={raiseActionItemAction} className="mt-1">
                          <input type="hidden" name="alertId" value={a.id} />
                          <button className="button-ghost px-2 py-0.5 text-[11px]">görev aç</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {escalations.length > 0 ? (
        <Panel title="ESKALASYON ZAMANI GELMİŞ" subtitle="yalnız AÇIK uyarılar yükselir — yanıt veren operatör cezalandırılmaz">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Bulgu</th><th>Ciddiyet</th><th>Kural</th>
                  <th className="text-right">Pencere</th><th>Kanal</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map((e) => (
                  <tr key={e.alertId} className="border-t border-neutral-800">
                    <td className="py-2">{e.title}</td>
                    <td><Badge tone="red">{SEVERITY_LABEL[e.severity as Severity]}</Badge></td>
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

      {fpRates.length > 0 ? (
        <Panel title="YANLIŞ ALARM ORANI" subtitle="yalnız KAPANMIŞ uyarılardan — triyaj edilmemiş kontrol kusursuz görünmez">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Kontrol</th><th className="text-right">Açık</th>
                  <th className="text-right">Çözüldü</th><th className="text-right">Yanlış alarm</th>
                  <th className="text-right">Oran</th>
                </tr>
              </thead>
              <tbody>
                {fpRates.map((f) => (
                  <tr key={f.checkCode} className="border-t border-neutral-800">
                    <td className="py-2">{f.checkCode}</td>
                    <td className="text-right tabular-nums">{f.openCount}</td>
                    <td className="text-right tabular-nums">{f.resolvedCount}</td>
                    <td className="text-right tabular-nums">{f.falsePositiveCount}</td>
                    <td className="text-right tabular-nums">
                      {f.falsePositiveRate == null
                        ? <span className="text-neutral-600">henüz triyaj yok</span>
                        : `%${(f.falsePositiveRate * 100).toFixed(0)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel title="ANOMALİ TESPİTİ" subtitle="deterministik kurallar — model yok, LLM yok">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs uppercase text-neutral-500">{ANOMALY_LABEL["split_payment" as AnomalyRule]}</div>
            {anomalies.splitPayments.length === 0 ? (
              <p className="text-xs text-neutral-600">Bulgu yok.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {anomalies.splitPayments.slice(0, 6).map((s: { party_name: string; due_date: string; payment_count: number; total_amount: string }, i: number) => (
                  <li key={i}>{s.party_name} · {s.payment_count} ödeme · {fmtTL(Number(s.total_amount))}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs uppercase text-neutral-500">{ANOMALY_LABEL["round_number" as AnomalyRule]}</div>
            {anomalies.roundNumber.length === 0 ? (
              <p className="text-xs text-neutral-600">Bulgu yok.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {anomalies.roundNumber.slice(0, 6).map((r: { payment_name: string; amount: string }, i: number) => (
                  <li key={i}>{r.payment_name} · {fmtTL(Number(r.amount))}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs uppercase text-neutral-500">{ANOMALY_LABEL["new_payee" as AnomalyRule]}</div>
            {anomalies.newPayees.length === 0 ? (
              <p className="text-xs text-neutral-600">Bulgu yok.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {anomalies.newPayees.slice(0, 6).map((n: { party_name: string; first_payment_date: string }, i: number) => (
                  <li key={i}>{n.party_name} · ilk ödeme {String(n.first_payment_date).slice(0, 10)}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs uppercase text-neutral-500">{ANOMALY_LABEL["unusual_record_hour" as AnomalyRule]}</div>
            {/* The caveat is shown, not buried: the schema has no transaction time, only a date. */}
            <p className="mb-1 text-[10px] text-amber-400">
              Şemada işlem saati yok — bu, kaydın girildiği saattir.
            </p>
            {anomalies.unusualRecordHour.length === 0 ? (
              <p className="text-xs text-neutral-600">Bulgu yok.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {anomalies.unusualRecordHour.slice(0, 6).map((h: { txn_date: string; recorded_hour: number; amount: string }, i: number) => (
                  <li key={i}>{String(h.txn_date).slice(0, 10)} · saat {h.recorded_hour} · {fmtTL(Number(h.amount))}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}
