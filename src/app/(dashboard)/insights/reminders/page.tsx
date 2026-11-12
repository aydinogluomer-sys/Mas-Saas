import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, type Tone } from "@/components/ui/badge";
import { fmtTL, Num, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { deliveryCounts, loadAllRules, loadDeliveries } from "@/lib/reminders/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  dispatchRemindersAction,
  scheduleRemindersAction,
  toggleReminderRuleAction,
  upsertReminderRuleAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  pending: "amber",
  sent: "green",
  failed: "red",
  skipped: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "bekleyen",
  sent: "gönderildi",
  failed: "başarısız",
  skipped: "atlandı",
};
const TARGET_KIND_LABEL: Record<string, string> = {
  payment_instance: "Ödeme Planı",
  check: "Çek / Senet",
  loan_installment: "Kredi Taksiti",
  invoice: "Satış Faturası",
  promise_to_pay: "Ödeme Sözü",
};
const ENTITY_TABLE_LABEL: Record<string, string> = {
  payment_instances: "Ödeme",
  checks: "Çek/Senet",
  loan_installments: "Kredi Taksiti",
  invoices: "Fatura",
  promise_to_pay: "Ödeme Sözü",
};

function formatOffsetLabel(offsetDays: number): string {
  if (offsetDays === 0) return "Vade günü (0)";
  if (offsetDays > 0) return `${offsetDays} gün önce (+${offsetDays})`;
  return `${Math.abs(offsetDays)} gün gecikme (${offsetDays})`;
}

export default async function RemindersPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string; editRule?: string }>;
}) {
  const denied = await requireRouteAccess("/insights/reminders");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const canManageRules = can(role, "reminders", "insert") && can(role, "reminders", "update");
  const sp = searchParams ? await searchParams : {};

  const pool = getPool();
  const [counts, deliveries, rules] = await Promise.all([
    deliveryCounts(pool),
    loadDeliveries(pool),
    loadAllRules(pool),
  ]);
  const today = istanbulDateISO();
  const selectedRule = sp.editRule ? rules.find((r) => r.id === sp.editRule) ?? null : null;
  const activeRuleCount = rules.filter((r) => r.isActive).length;

  const KTONE: Record<string, "neg" | "pos" | "warn" | "neutral"> = {
    failed: "neg",
    sent: "pos",
    pending: "warn",
    skipped: "neutral",
  };
  return (
    <>
      <PageHeader
        title="Hatırlatma ve Vade Taraması"
        subtitle="Ödeme planı, satış faturası, ödeme sözü, çek/senet ve kredi taksitleri için idempotent vade taraması (Europe/Istanbul)"
        meta={
          <>
            <Badge tone="neutral" dot>
              bugün {today}
            </Badge>
            <Badge tone="blue">{activeRuleCount} aktif kural</Badge>
            {counts.failed > 0 && <Badge tone="red">{counts.failed} başarısız</Badge>}
            {counts.pending > 0 && <Badge tone="amber">{counts.pending} bekleyen</Badge>}
          </>
        }
      />

      {sp.error ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--pos) 40%, var(--line))",
            background: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
            color: "var(--pos)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      <Panel title="DURUM ÖZETİ & VADE TARAMASI">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["pending", "sent", "failed", "skipped"] as const).map((k) => (
            <KpiCard
              key={k}
              label={STATUS_LABEL[k] ?? k}
              value={<Num>{counts[k]}</Num>}
              tone={KTONE[k]}
              emphasize
            />
          ))}
        </div>
        {canManageRules ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={scheduleRemindersAction}>
              <button
                type="submit"
                className="rounded border px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--surface-2)",
                  color: "var(--text-1)",
                }}
              >
                Vade taraması çalıştır (Ödeme · Fatura · Söz · Çek · Kredi) →
              </button>
            </form>
            <form action={dispatchRemindersAction}>
              <button
                type="submit"
                className="rounded border px-3 py-2 font-mono text-[11px] font-medium uppercase tracking-wider"
                style={{
                  borderColor: "color-mix(in srgb, var(--pos) 45%, var(--line))",
                  background: "var(--surface-2)",
                  color: "var(--pos)",
                }}
              >
                Bekleyenleri gönder (Telegram / E-posta) →
              </button>
            </form>
          </div>
        ) : null}
        <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
          Vade taraması; açık ödeme kalemleri, satış faturaları, bekleyen ödeme sözleri, portföy/tahsil/teminat/tedarikçi
          çek-senetleri ve planlı/ödenmemiş/kısmi/gecikmiş kredi taksitlerini tarar. Aynı (kural × kayıt × tarih) iki kez
          planlanmaz; hiçbir mali kayıt değiştirilmez.
        </p>
      </Panel>

      <Panel
        title="HATIRLATMA KURALLARI (KURAL EKLE / DÜZENLE / AKTİF-PASİF)"
        subtitle="Hedef tablo, vade gün farkı (+gün önce / 0 bugün / -gün gecikme), kanal ve minimum tutar eşiği"
        right={<Badge tone="neutral">{rules.length} kural</Badge>}
      >
        <div className="space-y-3">
          {canManageRules ? (
            <details
              open={Boolean(selectedRule) || rules.length === 0}
              className="rounded border p-3"
              style={{ borderColor: "var(--line-faint)", background: "var(--surface-1)" }}
            >
              <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                {selectedRule ? `Kuralı düzenle: ${selectedRule.name}` : "+ Yeni hatırlatma kuralı ekle"}
              </summary>
              <form
                key={selectedRule?.id ?? "new-rule"}
                action={upsertReminderRuleAction}
                className="mt-3 grid grid-cols-1 gap-2.5 text-xs sm:grid-cols-3 lg:grid-cols-6"
              >
                <input type="hidden" name="id" value={selectedRule?.id ?? ""} />
                <label className="flex flex-col gap-1">
                  <span style={{ color: "var(--text-2)" }}>Kural adı</span>
                  <input
                    name="name"
                    required
                    defaultValue={selectedRule?.name ?? ""}
                    placeholder="Örn. Çek 3 gün önce uyarı"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: "var(--text-2)" }}>Hedef türü</span>
                  <select
                    name="targetKind"
                    defaultValue={selectedRule?.targetKind ?? "check"}
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="payment_instance">Ödeme Planı (payment_instance)</option>
                    <option value="check">Çek / Senet (check)</option>
                    <option value="loan_installment">Kredi Taksiti (loan_installment)</option>
                    <option value="invoice">Satış Faturası (invoice)</option>
                    <option value="promise_to_pay">Ödeme Sözü (promise_to_pay)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: "var(--text-2)" }}>Gün farkı (+önce / -gecikme)</span>
                  <input
                    name="offsetDays"
                    type="number"
                    step="1"
                    min="-365"
                    max="365"
                    required
                    defaultValue={selectedRule?.offsetDays ?? 3}
                    className="rounded border px-2 py-1.5 font-mono"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: "var(--text-2)" }}>Kanal</span>
                  <select
                    name="channel"
                    defaultValue={selectedRule?.channel ?? "telegram"}
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="telegram">Telegram</option>
                    <option value="email">E-posta</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span style={{ color: "var(--text-2)" }}>Min. tutar (TL, ops.)</span>
                  <input
                    name="minAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={selectedRule?.minAmount ?? ""}
                    placeholder="Tümü"
                    className="rounded border px-2 py-1.5 font-mono"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                </label>
                <div className="flex flex-col justify-end gap-1.5">
                  <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-2)" }}>
                    <input type="hidden" name="isActive" value="false" />
                    <input
                      name="isActive"
                      type="checkbox"
                      value="on"
                      defaultChecked={selectedRule ? selectedRule.isActive : true}
                    />
                    Aktif kural
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      className="flex-1 rounded border px-2.5 py-1.5 font-medium"
                      style={{
                        borderColor: "var(--line)",
                        background: "var(--surface-2)",
                        color: "var(--text-1)",
                      }}
                    >
                      {selectedRule ? "Güncelle" : "Kaydet"}
                    </button>
                    {selectedRule ? (
                      <Link
                        href="/insights/reminders"
                        className="rounded border px-2 py-1.5 text-center"
                        style={{
                          borderColor: "var(--line)",
                          background: "var(--surface-1)",
                          color: "var(--text-2)",
                        }}
                      >
                        İptal
                      </Link>
                    ) : null}
                  </div>
                </div>
              </form>
            </details>
          ) : null}

          {rules.length === 0 ? (
            <EmptyState>
              Henüz tanımlı hatırlatma kuralı bulunmuyor. Yukarıdaki formdan yeni kural ekleyebilir veya vade taraması çalıştırarak varsayılan çek/kredi kurallarını oluşturabilirsiniz.
            </EmptyState>
          ) : (
            <TableShell>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr
                    className="border-b font-mono text-[10px] uppercase tracking-wider"
                    style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                  >
                    <th className="py-2 pr-2">Kural Adı</th>
                    <th className="py-2 px-2">Hedef Türü</th>
                    <th className="py-2 px-2">Zamanlama</th>
                    <th className="py-2 px-2">Kanal</th>
                    <th className="py-2 px-2 text-right">Min. Tutar</th>
                    <th className="py-2 px-2">Durum</th>
                    {canManageRules ? <th className="py-2 pl-2 text-right">İşlem</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-1.5 pr-2 font-medium">{r.name}</td>
                      <td className="py-1.5 px-2">
                        <Badge tone="blue">{TARGET_KIND_LABEL[r.targetKind] ?? r.targetKind}</Badge>
                      </td>
                      <td className="py-1.5 px-2 font-mono" style={{ color: "var(--text-2)" }}>
                        {formatOffsetLabel(r.offsetDays)}
                      </td>
                      <td className="py-1.5 px-2 font-mono">{r.channel}</td>
                      <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                        {r.minAmount != null ? fmtTL(r.minAmount) : "—"}
                      </td>
                      <td className="py-1.5 px-2">
                        <Badge tone={r.isActive ? "green" : "neutral"}>
                          {r.isActive ? "Aktif" : "Pasif"}
                        </Badge>
                      </td>
                      {canManageRules ? (
                        <td className="py-1.5 pl-2 text-right">
                          <div className="inline-flex items-center gap-2">
                            <Link
                              href={`/insights/reminders?editRule=${encodeURIComponent(r.id)}`}
                              className="font-mono text-[11px] underline"
                              style={{ color: "var(--text-2)" }}
                            >
                              Düzenle
                            </Link>
                            <form action={toggleReminderRuleAction} className="inline">
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="nextActive" value={r.isActive ? "false" : "true"} />
                              <button
                                type="submit"
                                className="rounded border px-2 py-0.5 font-mono text-[10px]"
                                style={{
                                  borderColor: "var(--line)",
                                  background: "var(--surface-2)",
                                  color: "var(--text-1)",
                                }}
                              >
                                {r.isActive ? "Pasife Al" : "Aktif Yap"}
                              </button>
                            </form>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </div>
      </Panel>

      <Panel title={`TESLİMAT KAYDI — ${deliveries.length}`}>
        {deliveries.length === 0 ? (
          <EmptyState>
            Henüz teslimat yok. &quot;Vade taraması çalıştır&quot; aktif kuralları ödeme, fatura, söz, çek ve kredi
            vadelerine uygular; aynı kayıt iki kez planlanmaz.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="border-b text-left font-mono text-[10px] uppercase tracking-wider"
                  style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                >
                  <th className="py-1.5 pr-2">planlanan</th>
                  <th className="py-1.5 px-2">kaynak</th>
                  <th className="py-1.5 px-2">kural</th>
                  <th className="py-1.5 px-2">kalem</th>
                  <th className="py-1.5 px-2">durum</th>
                  <th className="py-1.5 pl-2">gönderim / hata</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b align-top"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 pr-2 font-mono text-xs">{d.scheduled_for}</td>
                    <td className="py-1.5 px-2 text-xs">
                      <Badge tone="neutral">{ENTITY_TABLE_LABEL[d.entity_table] ?? d.entity_table}</Badge>
                    </td>
                    <td className="py-1.5 px-2 font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
                      {d.rule_name} ({formatOffsetLabel(d.offset_days)})
                    </td>
                    <td className="py-1.5 px-2 text-xs">{d.target_name}</td>
                    <td className="py-1.5 px-2">
                      <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>
                        {STATUS_LABEL[d.status] ?? d.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 pl-2 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
                      {d.status === "sent" ? (
                        d.sent_at
                      ) : d.error ? (
                        <span style={{ color: "var(--neg)" }}>{d.error}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
