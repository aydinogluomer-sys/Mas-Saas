import Link from "@/components/ui/app-link";
import {
  AgingBucketsBarSvg,
  EditorialDonutChartSvg,
  type AgingBucketItem,
  type DonutSlice,
} from "@/components/charts/editorial-cockpit-charts";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, type Tone } from "@/components/ui/badge";
import { fmtTL, Num, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { decimal, money } from "@/lib/money";
import { deliveryCounts, loadAllRules, loadDeliveries, loadEscalationRadarSummary } from "@/lib/reminders/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  dispatchRemindersAction,
  scheduleRemindersAction,
  sendMultiChannelCounterpartyReminderAction,
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
  invoice: "Açık Fatura (Satış/Alış)",
  promise_to_pay: "Ödeme Sözü",
  covenant_record: "Kovenant Test Tarihi",
};
const ENTITY_TABLE_LABEL: Record<string, string> = {
  payment_instances: "Ödeme",
  checks: "Çek/Senet",
  loan_installments: "Kredi Taksiti",
  invoices: "Fatura",
  promise_to_pay: "Ödeme Sözü",
  covenant_records: "Kovenant",
};

function formatOffsetLabel(offsetDays: number): string {
  if (offsetDays === 0) return "Vade günü (0)";
  if (offsetDays > 0) return `${offsetDays} gün önce (+${offsetDays})`;
  return `${Math.abs(offsetDays)}+ gün gecikme (≤ ${offsetDays})`;
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
  const today = istanbulDateISO();
  const [counts, deliveries, rules, escalationBuckets] = await Promise.all([
    deliveryCounts(pool),
    loadDeliveries(pool),
    loadAllRules(pool),
    loadEscalationRadarSummary(pool, today),
  ]);
  const selectedRule = sp.editRule ? rules.find((r) => r.id === sp.editRule) ?? null : null;
  const activeRuleCount = rules.filter((r) => r.isActive).length;

  // Teslimat Başarı Halkası & Eskalasyon Kademeleri Sütunları (EditorialDonutChartSvg + AgingBucketsBarSvg)
  const attemptedDeliveries = counts.sent + counts.failed;
  const totalDeliveries = counts.sent + counts.pending + counts.failed + counts.skipped;
  const deliverySuccessPct =
    attemptedDeliveries > 0
      ? Number(decimal(counts.sent).times(100).div(attemptedDeliveries).round(1).toFixed(1))
      : null;

  const deliverySlices: DonutSlice[] = [
    {
      key: "deliv-sent",
      label: "Gönderildi",
      value: counts.sent,
      formattedValue: `${counts.sent} adet`,
      sublabel: "Kanala başarıyla iletildi",
      tone: "pos",
    },
    {
      key: "deliv-pending",
      label: "Bekleyen",
      value: counts.pending,
      formattedValue: `${counts.pending} adet`,
      sublabel: "Gönderim kuyruğunda",
      tone: "warn",
    },
    {
      key: "deliv-failed",
      label: "Başarısız",
      value: counts.failed,
      formattedValue: `${counts.failed} adet`,
      sublabel: "İletim hatası",
      tone: "neg",
    },
    {
      key: "deliv-skipped",
      label: "Atlandı",
      value: counts.skipped,
      formattedValue: `${counts.skipped} adet`,
      sublabel: "Kanal yapılandırılmadı",
      tone: "neutral",
    },
  ];

  const ESCALATION_SHORT_LABEL: Record<string, string> = {
    upcoming: "Vadesi Yaklaşan",
    overdue_1_7: "1–7 Gün Gecikmiş",
    overdue_8_30: "8–30 Gün İhtar",
    overdue_30_plus: "30+ Gün Hukuki Eskalasyon",
  };

  const escalationTotalTry = money(
    escalationBuckets.reduce((acc, b) => acc.plus(b.knownAmountTry), decimal(0)),
  );

  const escalationAgingBuckets: AgingBucketItem[] = escalationBuckets.map((b) => ({
    key: `esc-${b.bucket}`,
    label: ESCALATION_SHORT_LABEL[b.bucket] ?? b.label,
    amount: b.knownAmountTry,
    formattedAmount: fmtTL(b.knownAmountTry),
    count: b.count,
    tone:
      b.bucket === "upcoming"
        ? "info"
        : b.bucket === "overdue_1_7"
          ? "warn"
          : b.bucket === "overdue_8_30"
            ? "accent"
            : "neg",
  }));

  const suggestedItems = escalationBuckets.flatMap((b) => b.items).slice(0, 12);

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
        action={
          canManageRules ? (
            <div className="flex flex-wrap items-center gap-2">
              <form action={scheduleRemindersAction}>
                <button
                  type="submit"
                  className="button-ghost px-3 py-1.5 font-mono text-[11px] font-medium"
                >
                  Vade Taraması Çalıştır →
                </button>
              </form>
              <form action={dispatchRemindersAction}>
                <button
                  type="submit"
                  className="button-accent px-3 py-1.5 font-mono text-[11px] font-semibold"
                >
                  Bekleyenleri Gönder →
                </button>
              </form>
            </div>
          ) : undefined
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

      {/* Compact 4-Card Delivery Status KPI Row */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
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

      {/* Crisp 2-Column Visual Row: Delivery Ring + Escalation Aging Columns */}
      <div className="grid gap-3.5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-6">
          <Panel
            title="Teslimat Durumu & Kanal İletim Halkası"
            subtitle="Gönderildi, bekleyen, başarısız ve atlanan bildirim kuyruğu kompozisyonu"
            right={
              <Badge
                tone={
                  deliverySuccessPct == null
                    ? "neutral"
                    : deliverySuccessPct >= 95
                      ? "green"
                      : "amber"
                }
              >
                {attemptedDeliveries > 0
                  ? `${counts.sent}/${attemptedDeliveries} iletim`
                  : `${totalDeliveries} toplam kayıt`}
              </Badge>
            }
          >
            <EditorialDonutChartSvg
              size={148}
              slices={deliverySlices}
              centerLabel="İLETİM BAŞARISI"
              centerValue={
                deliverySuccessPct != null
                  ? `%${deliverySuccessPct.toFixed(1).replace(".", ",")}`
                  : "—"
              }
              centerSubtext={
                attemptedDeliveries > 0
                  ? `Hedef eşik %95`
                  : `${totalDeliveries} kuyruk kaydı`
              }
              ariaLabel="Bildirim teslimat halkası: gönderildi, bekleyen, başarısız ve atlandı dağılımı"
            />
          </Panel>
        </div>

        <div className="min-w-0 lg:col-span-6">
          <Panel
            title="Vade & Hukuki Eskalasyon Kademeleri"
            subtitle="Yaklaşan, 1–7 gün gecikmiş, 8–30 gün ihtar ve 30+ gün hukuki eskalasyon kovaları (TRY)"
            right={
              <span className="tnum font-mono text-[11px] font-semibold text-tone-2">
                Toplam: {fmtTL(escalationTotalTry)}
              </span>
            }
          >
            <AgingBucketsBarSvg
              buckets={escalationAgingBuckets}
              ariaLabel="Vade ve hukuki eskalasyon kademeleri TRY hacim ve kayıt sayısı sütunları"
            />
          </Panel>
        </div>
      </div>

      {/* Çok Kanallı Bildirim & Karşı Taraf Vade Hatırlatma Merkezi */}
      <Panel
        title="Çok Kanallı Bildirim & Karşı Taraf Vade Hatırlatma Merkezi (Telegram · HTML E-posta · SMS · WhatsApp)"
        subtitle="Cari mutabakat ve vade hatırlatmalarını sıcak-parşömen HTML e-posta, kurumsal SMS, WhatsApp Business ve iç hazine Telegram kanallarına tek adımda iletin."
        right={
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone="blue">Telegram</Badge>
            <Badge tone="green">HTML E-posta</Badge>
            <Badge tone="amber">SMS</Badge>
            <Badge tone="green">WhatsApp</Badge>
          </div>
        }
      >
        {canManageRules ? (
          <form action={sendMultiChannelCounterpartyReminderAction} className="space-y-3 text-xs">
            <datalist id="reminder-counterparty-suggestions">
              {suggestedItems.map((it) => (
                <option
                  key={`${it.entityTable}-${it.entityId}`}
                  value={it.name}
                  label={`${it.dueDate} (${ENTITY_TABLE_LABEL[it.entityTable] ?? it.entityTable})`}
                />
              ))}
            </datalist>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>Cari / Karşı Taraf Ünvanı *</span>
                <input
                  type="text"
                  name="partyName"
                  list="reminder-counterparty-suggestions"
                  required
                  placeholder="Ör. Anadolu Makina San. A.Ş."
                  className="field-control px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>

              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>Belge / Fatura No</span>
                <input
                  type="text"
                  name="invoiceNo"
                  placeholder="Ör. GIB202600000142"
                  className="field-control font-mono px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>

              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>Vade Tarihi</span>
                <input
                  type="date"
                  name="dueDate"
                  defaultValue={today}
                  className="field-control font-mono px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>

              <div className="grid grid-cols-3 gap-1.5">
                <label className="col-span-2 flex flex-col gap-1 font-medium text-tone-2">
                  <span>Açık Tutar</span>
                  <input
                    type="text"
                    name="amountFormatted"
                    placeholder="Ör. 145.000,00"
                    className="field-control font-mono px-2.5 py-1.5 text-base sm:text-xs"
                  />
                </label>
                <label className="flex flex-col gap-1 font-medium text-tone-2">
                  <span>Döviz</span>
                  <select
                    name="currency"
                    defaultValue="TRY"
                    className="field-control font-mono px-2 py-1.5 text-base sm:text-xs"
                  >
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>Alıcı E-posta (HTML Folyo Şablonu)</span>
                <input
                  type="text"
                  name="email"
                  placeholder="finans@karsitaraf.com.tr"
                  className="field-control px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>

              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>SMS Telefon Numarası</span>
                <input
                  type="tel"
                  name="phone"
                  placeholder="+90 5xx xxx xx xx"
                  className="field-control font-mono px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>

              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>WhatsApp Business Numarası</span>
                <input
                  type="tel"
                  name="whatsappPhone"
                  placeholder="+90 5xx xxx xx xx (boşsa SMS no kullanılır)"
                  className="field-control font-mono px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 font-medium text-tone-2">
              <span>Özel Hatırlatma Mesajı (Boş bırakılırsa kurumsal vade metni otomatik üretilir)</span>
              <textarea
                name="customMessage"
                rows={2}
                placeholder="Sayın yetkili, vadesi yaklaşan cari hesap bakiyenize ilişkin ödeme planınızı rica ederiz..."
                className="field-control px-2.5 py-1.5 text-base sm:text-xs"
              />
            </label>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em] text-tone-2">
                  Gönderim Kanalları:
                </span>
                <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-tone-1">
                  <input type="checkbox" name="channels" value="telegram" defaultChecked />
                  <span>Telegram</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-tone-1">
                  <input type="checkbox" name="channels" value="email" defaultChecked />
                  <span>HTML E-posta</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-tone-1">
                  <input type="checkbox" name="channels" value="sms" />
                  <span>SMS</span>
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-tone-1">
                  <input type="checkbox" name="channels" value="whatsapp" />
                  <span>WhatsApp</span>
                </label>
              </div>

              <SubmitButton
                pendingLabel="Kanallara İletiliyor…"
                className="button-accent px-4 py-2 text-xs font-semibold disabled:opacity-60"
              >
                Çok Kanallı Hatırlatma Gönder
              </SubmitButton>
            </div>
          </form>
        ) : (
          <p className="text-xs text-tone-3">
            Çok kanallı hatırlatma gönderimi için finans operatörü veya yönetici yetkisi gerekir.
          </p>
        )}
      </Panel>

      <Panel
        title="KADEMELİ GECİKME VE HUKUKİ ESKALASYON RADARI"
        subtitle="Açık faturalar, çek/senetler, ödeme planları, taksitler ve kovenantlar için canlı eskalasyon kovaları"
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {escalationBuckets.map((b) => {
            const tone: "pos" | "warn" | "neg" | "neutral" =
              b.bucket === "upcoming"
                ? "neutral"
                : b.bucket === "overdue_1_7"
                  ? "warn"
                  : "neg";
            return (
              <div
                key={b.bucket}
                className="rounded border p-3"
                style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                    {b.label}
                  </span>
                  <Badge tone={tone === "neg" ? "red" : tone === "warn" ? "amber" : "blue"}>
                    {b.count} kayıt
                  </Badge>
                </div>
                <div className="mt-1 font-mono text-base font-semibold">
                  {fmtTL(b.knownAmountTry)}
                </div>
                {b.items.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-line pt-1.5 text-[11px] text-tone-2">
                    {b.items.slice(0, 3).map((it) => (
                      <li key={`${it.entityTable}-${it.entityId}`} className="truncate font-mono">
                        {it.dueDate} · {it.name}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 font-mono text-[10px] text-tone-4">Bu kademede açık kayıt yok.</p>
                )}
              </div>
            );
          })}
        </div>
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
                    placeholder="Örn. Fatura 8 gün ihtar"
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
                    <option value="invoice">Açık Fatura — Satış/Alış (invoice)</option>
                    <option value="promise_to_pay">Ödeme Sözü (promise_to_pay)</option>
                    <option value="covenant_record">Kovenant Test Tarihi (covenant_record)</option>
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
