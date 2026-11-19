"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Calendar, CheckCircle2, Clock3, ExternalLink, PackagePlus } from "lucide-react";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { SlideOverDrawer } from "@/components/ui/slide-over-drawer";
import { formatMoney } from "@/lib/money-format";
import {
  bulkSetFlexibilityClassAction,
  bulkTriagePaymentInstancesAction,
  type BulkTriageInstanceActionKind,
  type FlexibilityClassValue,
} from "@/app/(dashboard)/payments/bulk-actions";

export interface InspectorInstanceItem {
  kind: "instance";
  id: string;
  paymentId: string | null;
  name: string;
  dueDate: string;
  amount: number | null;
  remaining: number | null;
  paidAmount: number | null;
  currency: string;
  status: string;
  daysOverdue: number;
  riskLevel: string | null;
  riskReasons?: string[];
  flexibilityClass: "critical" | "flexible" | "optional" | null;
  decisionFlexibility?: "critical" | "flexible" | "optional" | "unclassified";
  category: string | null;
  provider: string | null;
  owner: string | null;
  costCenter: string | null;
  fromSource: boolean;
  note?: string | null;
}

export interface InspectorTemplateItem {
  kind: "template";
  id: string;
  name: string;
  recurrenceType: string;
  dueDay: number | null;
  defaultAmount: number | null;
  currency: string;
  amountConfidence: string | null;
  status: string;
  flexibilityClass: string | null;
  category: string | null;
  provider: string | null;
  owner: string | null;
  costCenter: string | null;
  fromSource: boolean;
}

export type PaymentInspectorTarget = InspectorInstanceItem | InspectorTemplateItem;

export interface PaymentInspectorDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaymentInspectorTarget[];
  activeId: string | null;
  onSelectId: (id: string) => void;
  canMutate: boolean;
  canCreateRun?: boolean;
  canUpdateTemplate?: boolean;
}

const FLEX_OPTIONS: ReadonlyArray<{
  value: FlexibilityClassValue;
  label: string;
  hint: string;
}> = [
  { value: "critical", label: "Kritik", hint: "Ertelenemez öncelikli yükümlülük" },
  { value: "flexible", label: "Esnek", hint: "Kısa vadede kaydırılabilir" },
  { value: "optional", label: "İsteğe Bağlı", hint: "Nakit sıkışıklığında ertelenebilir" },
];

function formatRecurrenceSummary(recurrenceType: string, dueDay: number | null): string {
  if (recurrenceType === "monthly") {
    return dueDay != null ? `Aylık · Her ayın ${dueDay}. günü` : "Aylık · Gün belirtilmemiş";
  }
  if (recurrenceType === "weekly") return "Haftalık (4/5× dönemlik)";
  if (recurrenceType === "quarterly") {
    return dueDay != null ? `Çeyreklik · ${dueDay}. gün` : "Çeyreklik";
  }
  if (recurrenceType === "yearly") {
    return dueDay != null ? `Yıllık · ${dueDay}. gün` : "Yıllık";
  }
  if (recurrenceType === "one_off") return "Tek seferlik ödeme";
  return "Düzensiz / Günsüz";
}

function renderFlexibilityBadge(value: string | null | undefined) {
  if (value === "critical") return <Badge tone="red">Kritik</Badge>;
  if (value === "flexible") return <Badge tone="blue">Esnek</Badge>;
  if (value === "optional") return <Badge tone="green">İsteğe Bağlı</Badge>;
  return <Badge tone="neutral">Sınıflandırılmadı</Badge>;
}

export function PaymentInspectorDrawer({
  open,
  onOpenChange,
  items,
  activeId,
  onSelectId,
  canMutate,
  canCreateRun,
  canUpdateTemplate,
}: PaymentInspectorDrawerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{
    targetId: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const activeIndex = activeId ? items.findIndex((it) => it.id === activeId) : -1;
  const item = activeIndex >= 0 ? items[activeIndex] ?? null : null;
  const prevItem = activeIndex > 0 ? items[activeIndex - 1] ?? null : null;
  const nextItem =
    activeIndex >= 0 && activeIndex < items.length - 1 ? items[activeIndex + 1] ?? null : null;

  const allowRun = canCreateRun ?? canMutate;
  const allowTemplateFlex = canUpdateTemplate ?? canMutate;

  useEffect(() => {
    if (!open || items.length <= 1 || activeIndex < 0) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (
        tagName === "INPUT" ||
        tagName === "TEXTAREA" ||
        tagName === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      if (event.key === "ArrowUp" && prevItem) {
        event.preventDefault();
        onSelectId(prevItem.id);
      } else if (event.key === "ArrowDown" && nextItem) {
        event.preventDefault();
        onSelectId(nextItem.id);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, items.length, activeIndex, prevItem, nextItem, onSelectId]);

  const currentFeedback = item && feedback?.targetId === item.id ? feedback : null;

  const runInstanceAction = (actionKind: BulkTriageInstanceActionKind) => {
    if (!item || item.kind !== "instance") return;
    const targetId = item.id;
    startTransition(async () => {
      const res = await bulkTriagePaymentInstancesAction({
        instanceIds: [targetId],
        action: actionKind,
      });
      setFeedback({ targetId, ok: res.ok, message: res.message });
      if (res.ok) {
        router.refresh();
      }
    });
  };

  const runFlexibilityAction = (flexibilityClass: FlexibilityClassValue) => {
    if (!item) return;
    const paymentId = item.kind === "template" ? item.id : item.paymentId;
    if (!paymentId) return;
    const targetId = item.id;
    startTransition(async () => {
      const res = await bulkSetFlexibilityClassAction({
        paymentIds: [paymentId],
        flexibilityClass,
      });
      setFeedback({ targetId, ok: res.ok, message: res.message });
      if (res.ok) {
        router.refresh();
      }
    });
  };

  const eyebrow =
    item?.kind === "instance"
      ? "BAĞLAMSAL ÖDEME İNCELEME · VADE ÖRNEĞİ"
      : "BAĞLAMSAL ÖDEME İNCELEME · ŞABLON TANIMI";

  const subtitle =
    item == null
      ? undefined
      : item.kind === "instance"
        ? `Vade: ${item.dueDate} · ↑ / ↓ tuşlarıyla listedeki diğer kayıtlara geçebilirsiniz`
        : `${formatRecurrenceSummary(item.recurrenceType, item.dueDay)} · ↑ / ↓ ile hızlı geçiş`;

  const headerBadge =
    items.length > 0 && activeIndex >= 0 ? (
      <Badge tone="neutral">
        {activeIndex + 1} / {items.length}
      </Badge>
    ) : undefined;

  const editHref =
    item == null
      ? "/payments"
      : item.kind === "template"
        ? `/payments/${item.id}/edit`
        : item.paymentId
          ? `/payments/${item.paymentId}/edit`
          : `/payments/calendar?date=${encodeURIComponent(item.dueDate)}`;

  const templateIdForFlex =
    item == null ? null : item.kind === "template" ? item.id : item.paymentId;
  const activeFlexValue =
    item == null
      ? null
      : item.flexibilityClass ??
        (item.kind === "instance" &&
        item.decisionFlexibility &&
        item.decisionFlexibility !== "unclassified"
          ? item.decisionFlexibility
          : null);

  return (
    <SlideOverDrawer
      open={open && item !== null}
      onOpenChange={onOpenChange}
      widthClass="w-[min(480px,94vw)]"
      eyebrow={eyebrow}
      title={item?.name ?? "Ödeme İnceleme"}
      subtitle={subtitle}
      badge={headerBadge}
      footer={
        item ? (
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!prevItem}
                onClick={() => prevItem && onSelectId(prevItem.id)}
                className="button-ghost inline-flex items-center gap-1 px-2.5 py-1.5 text-xs disabled:opacity-40"
                title="Önceki satır (↑)"
              >
                <ArrowUp size={13} aria-hidden />
                <span>← Önceki</span>
              </button>
              <button
                type="button"
                disabled={!nextItem}
                onClick={() => nextItem && onSelectId(nextItem.id)}
                className="button-ghost inline-flex items-center gap-1 px-2.5 py-1.5 text-xs disabled:opacity-40"
                title="Sonraki satır (↓)"
              >
                <span>Sonraki →</span>
                <ArrowDown size={13} aria-hidden />
              </button>
            </div>
            <Link
              href={editHref}
              className="button-accent inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold"
            >
              <span>Tam Düzenleme &amp; Belge Ekranı →</span>
            </Link>
          </div>
        ) : undefined
      }
    >
      {item && (
        <div className="space-y-4">
          {/* 1. Üst Özet Kartı */}
          <section
            className="rounded-[var(--radius-md)] border p-3.5"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line)",
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-tone-3">
                  {item.kind === "instance" ? "Açık Kalan Yükümlülük" : "Varsayılan Tutar"}
                </div>
                <div className="mt-1">
                  {item.kind === "instance" ? (
                    item.remaining == null && item.amount == null ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="amber">TUTAR EKSİK</Badge>
                        <span className="text-[11px] text-tone-3">Asla 0 TL varsayılmaz</span>
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        <div className="tnum text-xl font-bold tracking-[-0.02em] text-tone-1">
                          {formatMoney(item.remaining ?? item.amount, item.currency)}
                        </div>
                        {item.paidAmount != null && item.paidAmount > 0 && (
                          <div className="tnum text-[11px] text-tone-3">
                            Toplam: {formatMoney(item.amount, item.currency)} · Ödenen:{" "}
                            {formatMoney(item.paidAmount, item.currency)}
                          </div>
                        )}
                      </div>
                    )
                  ) : item.defaultAmount == null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="amber">TUTAR EKSİK</Badge>
                      <span className="text-[11px] text-tone-3">Asla 0 TL varsayılmaz</span>
                    </div>
                  ) : (
                    <div className="tnum text-xl font-bold tracking-[-0.02em] text-tone-1">
                      {formatMoney(item.defaultAmount, item.currency)}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <Badge tone={item.currency === "TRY" ? "neutral" : "blue"}>{item.currency}</Badge>
                {item.kind === "instance" ? (
                  item.daysOverdue > 0 ? (
                    <Badge tone="red">{item.daysOverdue} gün gecikti</Badge>
                  ) : item.status === "partial" ? (
                    <Badge tone="amber">Kısmi Ödendi</Badge>
                  ) : (
                    <Badge tone="blue">Planlı</Badge>
                  )
                ) : item.status === "paused" ? (
                  <Badge tone="amber">Duraklatıldı</Badge>
                ) : (
                  <Badge tone="green">Aktif Şablon</Badge>
                )}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5 border-t border-line-faint pt-3 text-xs">
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">
                  Vade / Sıklık
                </div>
                <div className="mt-0.5 font-mono text-[12px] font-medium tabular-nums text-tone-1">
                  {item.kind === "instance"
                    ? item.dueDate
                    : formatRecurrenceSummary(item.recurrenceType, item.dueDay)}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">
                  Esneklik &amp; Risk
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {renderFlexibilityBadge(activeFlexValue)}
                  {item.kind === "instance" && item.riskLevel === "critical" && (
                    <Badge tone="red">Kritik Eşik</Badge>
                  )}
                  {item.kind === "instance" && item.riskLevel === "high" && (
                    <Badge tone="amber">Yüksek Risk</Badge>
                  )}
                  {item.kind === "template" && item.amountConfidence && (
                    <Badge tone="neutral">{item.amountConfidence}</Badge>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Geri Bildirim Bandı */}
          {currentFeedback && (
            <div
              role="status"
              className="rounded-[var(--radius-control)] border px-3 py-2 text-xs leading-snug"
              style={{
                borderColor: currentFeedback.ok
                  ? "color-mix(in srgb, var(--pos) 40%, var(--line))"
                  : "color-mix(in srgb, var(--neg) 40%, var(--line))",
                background: currentFeedback.ok
                  ? "color-mix(in srgb, var(--pos) 8%, var(--surface-2))"
                  : "color-mix(in srgb, var(--neg) 8%, var(--surface-2))",
                color: "var(--text-1)",
              }}
            >
              {currentFeedback.message}
            </div>
          )}

          {/* 2. Hızlı Karar Kontrolleri */}
          {(canMutate || allowRun || allowTemplateFlex) && (
            <section
              className="space-y-3 rounded-[var(--radius-md)] border p-3.5"
              style={{ borderColor: "var(--line-card)", background: "var(--surface-1)" }}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                Hızlı Karar Kontrolleri
              </div>

              {item.kind === "instance" && (canMutate || allowRun) && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    {canMutate && (
                      <button
                        type="button"
                        disabled={
                          isPending || (item.amount == null && item.remaining == null)
                        }
                        onClick={() => runInstanceAction("mark_paid")}
                        className="button-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-45"
                        title={
                          item.amount == null
                            ? "Tutarı eksik kayıt doğrudan ödendi işaretlenemez"
                            : "Bu vade örneğini ödendi olarak kapat"
                        }
                      >
                        <CheckCircle2 size={13.5} aria-hidden />
                        <span>Ödendi İşaretle</span>
                      </button>
                    )}

                    {canMutate && (
                      <button
                        type="button"
                        disabled={isPending || item.status === "partial"}
                        onClick={() => runInstanceAction("shift_7d")}
                        className="button-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-45"
                        title={
                          item.status === "partial"
                            ? "Kısmi ödenmiş kalemin vadesi toplu kaydırılamaz"
                            : "Vadeyi 7 gün ileri kaydır"
                        }
                      >
                        <Clock3 size={13.5} aria-hidden />
                        <span>+7 Gün Ertele</span>
                      </button>
                    )}

                    {allowRun && (
                      <button
                        type="button"
                        disabled={
                          isPending || (item.amount == null && item.remaining == null)
                        }
                        onClick={() => runInstanceAction("create_run")}
                        className="button-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-45"
                        title="Bu kalem için taslak ödeme çalıştırma paketi oluştur"
                      >
                        <PackagePlus size={13.5} aria-hidden />
                        <span>Taslak Pakete Al</span>
                      </button>
                    )}
                  </div>

                  {item.amount == null && item.remaining == null && (
                    <p className="text-[11px] text-warn">
                      Bu kalemde tutar eksik (R10). Ödendi işaretlemek veya pakete almak için{" "}
                      <Link
                        href="/payments/missing"
                        className="font-semibold underline underline-offset-2"
                      >
                        Eksik Tutar Masası →
                      </Link>{" "}
                      üzerinden tutar girin.
                    </p>
                  )}
                </div>
              )}

              {allowTemplateFlex && templateIdForFlex && (
                <div className="space-y-1.5 border-t border-line-faint pt-2.5 first:border-t-0 first:pt-0">
                  <div className="text-[11px] font-medium text-tone-2">
                    Esneklik Sınıfı Ata (Şablon Genelinde)
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {FLEX_OPTIONS.map((opt) => {
                      const isActive = item.flexibilityClass === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={isPending}
                          onClick={() => runFlexibilityAction(opt.value)}
                          title={opt.hint}
                          className={
                            isActive
                              ? "button-accent px-2.5 py-1.5 text-center text-xs font-semibold"
                              : "button-ghost px-2.5 py-1.5 text-center text-xs"
                          }
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 3. Kaynak & Bağlam Kanıtı */}
          <section
            className="space-y-3 rounded-[var(--radius-md)] border p-3.5"
            style={{ borderColor: "var(--line-card)", background: "var(--surface-1)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                Kaynak &amp; Bağlam Kanıtı
              </span>
              <Badge tone={item.fromSource ? "blue" : "neutral"}>
                {item.fromSource ? "Excel Kaynağı" : "Manuel"}
              </Badge>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-xs">
              <div>
                <dt className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">
                  Tedarikçi / Karşı Taraf
                </dt>
                <dd className="mt-0.5 font-medium text-tone-1">
                  {item.provider ?? "Belirtilmemiş"}
                </dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">Kategori</dt>
                <dd className="mt-0.5 font-medium text-tone-1">
                  {item.category ?? "Belirtilmemiş"}
                </dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">
                  Masraf Merkezi
                </dt>
                <dd className="mt-0.5 font-medium text-tone-1">
                  {item.costCenter ?? "Belirtilmemiş"}
                </dd>
              </div>
              <div>
                <dt className="text-[10.5px] uppercase tracking-[0.05em] text-tone-3">Sorumlu</dt>
                <dd className="mt-0.5 font-medium text-tone-1">{item.owner ?? "Belirtilmemiş"}</dd>
              </div>
            </dl>

            {item.kind === "instance" && item.note && (
              <div className="border-t border-line-faint pt-2 text-xs text-tone-2">
                <span className="font-semibold text-tone-3">Not: </span>
                {item.note}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-faint pt-2.5 text-xs">
              <Link
                href={editHref}
                className="inline-flex items-center gap-1 font-semibold text-info underline underline-offset-2"
              >
                <span>Tam Düzenleme &amp; Belge Ekranı →</span>
                <ExternalLink size={12} aria-hidden />
              </Link>

              {item.kind === "instance" && (
                <Link
                  href={`/payments/calendar?date=${encodeURIComponent(item.dueDate)}`}
                  className="inline-flex items-center gap-1 text-tone-3 underline underline-offset-2 hover:text-tone-1"
                >
                  <Calendar size={12} aria-hidden />
                  <span>Takvim Günü ({item.dueDate})</span>
                </Link>
              )}
            </div>
          </section>
        </div>
      )}
    </SlideOverDrawer>
  );
}
