"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Calendar, Eye, X } from "lucide-react";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import { sumMoney } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import {
  bulkTriagePaymentInstancesAction,
  type BulkTriageInstanceActionKind,
} from "@/app/(dashboard)/payments/bulk-actions";
import {
  PaymentInspectorDrawer,
  type InspectorInstanceItem,
} from "./payment-inspector-drawer";

export type OverdueTriageFilter = "all" | "overdue" | "critical_large";

export interface OverdueTriageRow {
  id: string;
  paymentId: string | null;
  name: string;
  category: string | null;
  provider: string | null;
  owner: string | null;
  costCenter: string | null;
  fromSource: boolean;
  dueDate: string;
  status: string;
  currency: string;
  amount: number | null;
  paidAmount: number | null;
  remaining: number | null;
  daysOverdue: number;
  riskLevel: string | null;
  riskReasons: string[];
  flexibilityClass: "critical" | "flexible" | "optional" | null;
  decisionFlexibility: "critical" | "flexible" | "optional" | "unclassified";
  note: string | null;
}

export interface OverdueTriageTableProps {
  rows: OverdueTriageRow[];
  largeThresholdTry: number;
  canMutateInstances: boolean;
  canCreateRun: boolean;
  canUpdateTemplates: boolean;
  defaultFilter?: OverdueTriageFilter;
}

export function OverdueTriageTable({
  rows,
  largeThresholdTry,
  canMutateInstances,
  canCreateRun,
  canUpdateTemplates,
  defaultFilter = "all",
}: OverdueTriageTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const initialFilter: OverdueTriageFilter =
    defaultFilter === "overdue" && rows.some((r) => r.daysOverdue > 0) ? "overdue" : "all";

  const [filter, setFilter] = useState<OverdueTriageFilter>(initialFilter);
  const [rawSelectedIds, setRawSelectedIds] = useState<string[]>([]);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const canSelect = canMutateInstances || canCreateRun;

  const isCriticalOrLarge = useMemo(
    () => (row: OverdueTriageRow) =>
      row.decisionFlexibility === "critical" ||
      row.riskLevel === "critical" ||
      row.riskLevel === "high" ||
      (row.currency === "TRY" && (row.remaining ?? 0) >= largeThresholdTry),
    [largeThresholdTry],
  );

  const overdueTotalCount = useMemo(
    () => rows.filter((r) => r.daysOverdue > 0).length,
    [rows],
  );
  const criticalLargeCount = useMemo(
    () => rows.filter((r) => isCriticalOrLarge(r)).length,
    [rows, isCriticalOrLarge],
  );

  const filteredRows = useMemo(() => {
    if (filter === "overdue") return rows.filter((r) => r.daysOverdue > 0);
    if (filter === "critical_large") return rows.filter((r) => isCriticalOrLarge(r));
    return rows;
  }, [rows, filter, isCriticalOrLarge]);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const selectedIds = useMemo(
    () => rawSelectedIds.filter((id) => rowById.has(id)),
    [rawSelectedIds, rowById],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const visibleIds = useMemo(() => filteredRows.map((r) => r.id), [filteredRows]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds);
      setRawSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      setRawSelectedIds((prev) => [...new Set([...prev, ...visibleIds])]);
    }
  };

  const toggleOne = (id: string) => {
    setRawSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const openInspector = (id: string) => {
    setInspectedId(id);
    setDrawerOpen(true);
  };

  const selectedRows = useMemo(
    () =>
      selectedIds
        .map((id) => rowById.get(id))
        .filter((r): r is OverdueTriageRow => r !== undefined),
    [selectedIds, rowById],
  );

  const selectionSummary = useMemo(() => {
    const knownTryAmounts: number[] = [];
    let missingCount = 0;
    let foreignCount = 0;
    for (const r of selectedRows) {
      const effAmount = r.remaining ?? r.amount;
      if (effAmount == null) {
        missingCount += 1;
      } else if (r.currency !== "TRY") {
        foreignCount += 1;
      } else {
        knownTryAmounts.push(effAmount);
      }
    }
    return {
      knownTryTotal: sumMoney(knownTryAmounts),
      missingCount,
      foreignCount,
    };
  }, [selectedRows]);

  const inspectorItems: InspectorInstanceItem[] = useMemo(
    () =>
      filteredRows.map((r) => ({
        kind: "instance" as const,
        id: r.id,
        paymentId: r.paymentId,
        name: r.name,
        dueDate: r.dueDate,
        amount: r.amount,
        remaining: r.remaining,
        paidAmount: r.paidAmount,
        currency: r.currency,
        status: r.status,
        daysOverdue: r.daysOverdue,
        riskLevel: r.riskLevel,
        riskReasons: r.riskReasons,
        flexibilityClass: r.flexibilityClass,
        decisionFlexibility: r.decisionFlexibility,
        category: r.category,
        provider: r.provider,
        owner: r.owner,
        costCenter: r.costCenter,
        fromSource: r.fromSource,
        note: r.note,
      })),
    [filteredRows],
  );

  const handleBulkAction = (actionKind: BulkTriageInstanceActionKind) => {
    if (selectedIds.length === 0) return;
    const idsToProcess = [...selectedIds];
    startTransition(async () => {
      const res = await bulkTriagePaymentInstancesAction({
        instanceIds: idsToProcess,
        action: actionKind,
      });
      setFeedback({ ok: res.ok, message: res.message });
      if (res.ok) {
        setRawSelectedIds([]);
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-3">
      {/* Filtre Hapları & Üst Bilgi */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="İzleme listesi filtreleri"
        >
          <button
            type="button"
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
            className={
              filter === "all"
                ? "button-accent px-2.5 py-1 text-xs font-semibold"
                : "button-ghost px-2.5 py-1 text-xs"
            }
          >
            Tümü ({rows.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter("overdue")}
            aria-pressed={filter === "overdue"}
            className={
              filter === "overdue"
                ? "button-accent px-2.5 py-1 text-xs font-semibold"
                : "button-ghost px-2.5 py-1 text-xs"
            }
          >
            Yalnız Gecikenler ({overdueTotalCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter("critical_large")}
            aria-pressed={filter === "critical_large"}
            className={
              filter === "critical_large"
                ? "button-accent px-2.5 py-1 text-xs font-semibold"
                : "button-ghost px-2.5 py-1 text-xs"
            }
          >
            Kritik / Büyük Tutar ({criticalLargeCount})
          </button>
        </div>

        <span className="text-[11px] text-tone-3">
          Satıra veya <strong>İncele</strong> düğmesine tıklayarak sayfadan ayrılmadan yan çekmecede yönetin
        </span>
      </div>

      {/* Geri Bildirim Bandı */}
      {feedback && (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-xs leading-snug"
          style={{
            borderColor: feedback.ok
              ? "color-mix(in srgb, var(--pos) 40%, var(--line))"
              : "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: feedback.ok
              ? "color-mix(in srgb, var(--pos) 8%, var(--surface-2))"
              : "color-mix(in srgb, var(--neg) 8%, var(--surface-2))",
            color: "var(--text-1)",
          }}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="button-ghost shrink-0 p-0.5"
            aria-label="Bildirimi kapat"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      )}

      {/* Triage Tablosu */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-205 text-xs">
          <thead>
            <tr>
              {canSelect && (
                <th className="w-8 py-2 pr-2 text-left">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Görünür tüm ödeme kalemlerini seç"
                  />
                </th>
              )}
              <th>Ödeme</th>
              <th>Kategori</th>
              <th>Vade</th>
              <th>Durum</th>
              <th>Döviz</th>
              <th className="text-right">Kalan</th>
              <th>Esneklik</th>
              <th>Önerilen işlem</th>
              <th className="text-right">İncele</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={canSelect ? 10 : 9}
                  className="py-6 text-center text-xs text-tone-3"
                >
                  Bu filtrede görüntülenecek ödeme kaydı bulunmuyor.
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const isSelected = selectedSet.has(row.id);
                const isInspected = drawerOpen && inspectedId === row.id;
                return (
                  <tr
                    key={row.id}
                    className="row-hover border-t border-line-faint"
                    style={
                      isSelected || isInspected
                        ? { background: "var(--surface-active)" }
                        : undefined
                    }
                  >
                    {canSelect && (
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(row.id)}
                          aria-label={`${row.name} kalemini seç`}
                        />
                      </td>
                    )}
                    <td className="py-2 font-medium">
                      <button
                        type="button"
                        onClick={() => openInspector(row.id)}
                        className="text-left font-medium text-tone-1 underline decoration-dotted underline-offset-2 hover:text-info"
                      >
                        {row.name}
                      </button>
                    </td>
                    <td>{row.category ?? "—"}</td>
                    <td className="font-mono tabular-nums">{row.dueDate}</td>
                    <td>
                      {row.daysOverdue > 0 ? (
                        <Badge tone="red">{row.daysOverdue} gün gecikti</Badge>
                      ) : row.status === "partial" ? (
                        <Badge tone="amber">Kısmi</Badge>
                      ) : (
                        <Badge tone="blue">Planlı</Badge>
                      )}
                    </td>
                    <td className="font-mono">{row.currency}</td>
                    <td className="text-right font-semibold tabular-nums">
                      {row.remaining == null && row.amount == null ? (
                        <Badge tone="amber">TUTAR EKSİK</Badge>
                      ) : (
                        formatMoney(row.remaining ?? row.amount, row.currency)
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          row.decisionFlexibility === "critical"
                            ? "red"
                            : row.decisionFlexibility === "optional"
                              ? "green"
                              : row.decisionFlexibility === "flexible"
                                ? "blue"
                                : "neutral"
                        }
                      >
                        {row.decisionFlexibility === "critical"
                          ? "Kritik"
                          : row.decisionFlexibility === "optional"
                            ? "İsteğe bağlı"
                            : row.decisionFlexibility === "flexible"
                              ? "Esnek"
                              : "Sınıflandırılmadı"}
                      </Badge>
                    </td>
                    <td>
                      {row.daysOverdue > 0
                        ? "Ödeme veya müzakere kararı"
                        : row.decisionFlexibility === "critical"
                          ? "Nakit karşılığını doğrula"
                          : "Vade planını izle"}
                    </td>
                    <td className="py-1.5 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openInspector(row.id)}
                          className="button-ghost inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold"
                        >
                          <Eye size={12} aria-hidden />
                          <span>İncele</span>
                        </button>
                        <Link
                          href={`/payments/calendar?date=${encodeURIComponent(row.dueDate)}`}
                          className="button-ghost inline-flex items-center justify-center p-1 text-tone-3 hover:text-tone-1"
                          title={`Takvimde gör (${row.dueDate})`}
                          aria-label={`${row.name} takvim günü (${row.dueDate})`}
                        >
                          <Calendar size={12} aria-hidden />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Yüzen / Yapışkan Toplu Karar Çubuğu */}
      {canSelect && selectedIds.length > 0 && (
        <div
          role="region"
          aria-label="Seçili ödemeler için toplu karar çubuğu"
          data-testid="payments-floating-bulk-bar"
          className="fixed bottom-4 left-3 right-3 z-40 mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2.5 rounded-[var(--radius-md)] border px-3.5 py-2.5 lg:left-[264px] lg:right-6"
          style={{
            background: "var(--surface-1)",
            borderColor: "var(--line-strong)",
            boxShadow: "var(--shadow-overlay)",
          }}
        >
          <div className="text-xs font-semibold text-tone-1">
            <span>
              Seçili <span className="tnum">{selectedIds.length}</span> Kalem (Toplam Bilinen:{" "}
              <span className="tnum">{fmtTL(selectionSummary.knownTryTotal)}</span>
              {selectionSummary.foreignCount > 0
                ? ` · +${selectionSummary.foreignCount} YP`
                : ""}
              {selectionSummary.missingCount > 0
                ? ` · ${selectionSummary.missingCount} tutar eksik`
                : ""}
              ):
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {canCreateRun && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => handleBulkAction("create_run")}
                className="button-accent px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
              >
                Taslak Ödeme Paketine Al
              </button>
            )}
            {canMutateInstances && (
              <>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => handleBulkAction("shift_7d")}
                  className="button-ghost px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
                >
                  +7G Ertele
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => handleBulkAction("shift_14d")}
                  className="button-ghost px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
                >
                  +14G Ertele
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => handleBulkAction("mark_paid")}
                  className="button-primary px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
                >
                  Ödendi İşaretle
                </button>
              </>
            )}
            <button
              type="button"
              disabled={isPending}
              onClick={() => setRawSelectedIds([])}
              className="button-ghost px-2 py-1.5 text-xs text-tone-3"
            >
              Temizle
            </button>
          </div>
        </div>
      )}

      <PaymentInspectorDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        items={inspectorItems}
        activeId={inspectedId}
        onSelectId={setInspectedId}
        canMutate={canMutateInstances}
        canCreateRun={canCreateRun}
        canUpdateTemplate={canUpdateTemplates}
      />
    </div>
  );
}
