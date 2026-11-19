"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, X } from "lucide-react";
import Link from "@/components/ui/app-link";
import { type ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money-format";
import { DataTable } from "@/components/ui/primitives/data-table";
import {
  ActionMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/primitives/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/primitives/tooltip";
import { ArchiveForm } from "@/components/system/archive-form";
import {
  bulkSetFlexibilityClassAction,
  type FlexibilityClassValue,
} from "@/app/(dashboard)/payments/bulk-actions";
import {
  PaymentInspectorDrawer,
  type InspectorTemplateItem,
} from "./payment-inspector-drawer";

export interface PaymentItemRow {
  id: string;
  name: string;
  recurrence_type: string;
  due_day: number | null;
  default_amount: number | null;
  currency: string;
  amount_confidence: string | null;
  status: string;
  flexibility_class: string | null;
  category: string | null;
  provider: string | null;
  owner: string | null;
  cost_center: string | null;
  from_source: boolean;
}

const FLEX_HINT: Record<string, string> = {
  critical: "Ertelenemez · kritik öncelik. Nakit sıkışıklığında bile önce bu ödenir.",
  flexible: "Vadesi gerekirse kaydırılabilir; kısa süreli erteleme kabul edilebilir.",
  optional: "Zorunlu değil; nakit yetmezse atlanabilir veya ertelenebilir.",
};

function FlexibilityBadge({ value, id }: { value: string | null; id: string }) {
  const badge =
    value === "critical" ? (
      <Badge tone="red">Kritik</Badge>
    ) : value === "flexible" ? (
      <Badge tone="blue">Esnek</Badge>
    ) : value === "optional" ? (
      <Badge tone="green">İsteğe bağlı</Badge>
    ) : (
      <Link href={`/payments/${id}/edit`}>
        <Badge tone="amber">Sınıflandır</Badge>
      </Link>
    );
  const hint = value
    ? FLEX_HINT[value]
    : "Henüz sınıflandırılmadı — tıklayıp esneklik seviyesini belirleyin.";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export function PaymentItemsTable({
  rows,
  canMutate = false,
}: {
  rows: PaymentItemRow[];
  canMutate?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rawSelectedIds, setRawSelectedIds] = useState<string[]>([]);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  const rowIdSet = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedIds = useMemo(
    () => rawSelectedIds.filter((id) => rowIdSet.has(id)),
    [rawSelectedIds, rowIdSet],
  );
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const openInspector = (id: string) => {
    setInspectedId(id);
    setDrawerOpen(true);
  };

  const columns = useMemo<ColumnDef<PaymentItemRow>[]>(() => {
    const baseCols: ColumnDef<PaymentItemRow>[] = [
      {
        accessorKey: "name",
        header: "Ödeme",
        meta: { label: "Ödeme" },
        cell: ({ row }) => (
          <span className="flex items-center gap-1">
            <Link
              className="underline underline-offset-2"
              href={`/payments/${row.original.id}/edit`}
            >
              {row.original.name}
            </Link>
            {row.original.status === "paused" && <Badge tone="neutral">duraklatıldı</Badge>}
          </span>
        ),
      },
      {
        accessorKey: "due_day",
        header: "Vade / Sıklık",
        meta: { label: "Vade / Sıklık" },
        cell: ({ row }) => {
          const rec = row.original.recurrence_type;
          if (rec === "monthly" && row.original.due_day != null) {
            return <span className="tnum">Aylık · {row.original.due_day}. gün</span>;
          }
          if (rec === "weekly") {
            return <Badge tone="blue">Haftalık (4/5×)</Badge>;
          }
          if (rec === "quarterly") {
            return (
              <Badge tone="blue">
                Çeyreklik{row.original.due_day ? ` · ${row.original.due_day}. gün` : ""}
              </Badge>
            );
          }
          if (rec === "yearly") {
            return (
              <Badge tone="blue">
                Yıllık{row.original.due_day ? ` · ${row.original.due_day}. gün` : ""}
              </Badge>
            );
          }
          if (rec === "one_off") {
            return <Badge tone="neutral">Tek seferlik</Badge>;
          }
          return <Badge tone="amber">günsüz</Badge>;
        },
      },
      {
        accessorKey: "currency",
        header: "Döviz",
        meta: { label: "Döviz" },
        cell: ({ row }) => (
          <Badge tone={row.original.currency === "TRY" ? "neutral" : "blue"}>
            {row.original.currency}
          </Badge>
        ),
      },
      {
        accessorKey: "default_amount",
        header: "Varsayılan tutar",
        meta: { label: "Varsayılan tutar", align: "right" },
        cell: ({ row, getValue }) => {
          const value = getValue<number | null>();
          return value == null ? (
            <Badge tone="amber">Tutar eksik</Badge>
          ) : (
            <span className="tnum">{formatMoney(value, row.original.currency)}</span>
          );
        },
      },
      {
        accessorKey: "flexibility_class",
        header: "Esneklik",
        meta: { label: "Esneklik" },
        cell: ({ row }) => (
          <FlexibilityBadge value={row.original.flexibility_class} id={row.original.id} />
        ),
      },
      {
        accessorKey: "amount_confidence",
        header: "Güven",
        meta: { label: "Güven" },
        cell: ({ getValue }) => getValue<string | null>() ?? "—",
      },
      {
        id: "tags",
        header: "Etiketler / Masraf Mrk.",
        meta: { label: "Etiketler / Masraf Mrk." },
        accessorFn: (row) =>
          [row.category, row.cost_center, row.provider, row.owner]
            .filter(Boolean)
            .join(" · ") || "—",
      },
      {
        accessorKey: "from_source",
        header: "Kaynak",
        meta: { label: "Kaynak" },
        cell: ({ getValue }) =>
          getValue<boolean>() ? (
            <Badge tone="blue">Excel</Badge>
          ) : (
            <Badge tone="neutral">Manuel</Badge>
          ),
      },
      {
        id: "actions",
        header: "İşlemler",
        enableSorting: false,
        enableHiding: false,
        meta: { align: "right" },
        cell: ({ row }) => (
          <div className="inline-flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => openInspector(row.original.id)}
              className="button-ghost inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold"
            >
              <Eye size={12.5} aria-hidden />
              <span>İncele</span>
            </button>
            <ActionMenu>
              <DropdownMenuItem asChild>
                <Link href={`/payments/${row.original.id}/edit`}>Düzenle</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <ArchiveForm
                asMenuItem
                entity="payments"
                id={row.original.id}
                backTo="/payments/items?flash=archived"
                reason="Ödeme kalemlerinden arşivlendi"
              />
            </ActionMenu>
          </div>
        ),
      },
    ];

    if (!canMutate) return baseCols;

    const selectColumn: ColumnDef<PaymentItemRow> = {
      id: "select",
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => {
        const filteredIds = table.getFilteredRowModel().rows.map((r) => r.original.id);
        const allFilteredSelected =
          filteredIds.length > 0 && filteredIds.every((id) => selectedSet.has(id));
        return (
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={() => {
              if (allFilteredSelected) {
                const filteredSet = new Set(filteredIds);
                setRawSelectedIds((prev) => prev.filter((id) => !filteredSet.has(id)));
              } else {
                setRawSelectedIds((prev) => [...new Set([...prev, ...filteredIds])]);
              }
            }}
            aria-label="Filtrelenen tüm ödeme kalemlerini seç"
          />
        );
      },
      cell: ({ row }) => {
        const id = row.original.id;
        const checked = selectedSet.has(id);
        return (
          <input
            type="checkbox"
            checked={checked}
            onChange={() =>
              setRawSelectedIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              )
            }
            aria-label={`${row.original.name} kalemini seç`}
          />
        );
      },
    };

    return [selectColumn, ...baseCols];
  }, [canMutate, selectedSet]);

  const inspectorItems: InspectorTemplateItem[] = useMemo(
    () =>
      rows.map((r) => ({
        kind: "template" as const,
        id: r.id,
        name: r.name,
        recurrenceType: r.recurrence_type,
        dueDay: r.due_day,
        defaultAmount: r.default_amount,
        currency: r.currency,
        amountConfidence: r.amount_confidence,
        status: r.status,
        flexibilityClass: r.flexibility_class,
        category: r.category,
        provider: r.provider,
        owner: r.owner,
        costCenter: r.cost_center,
        fromSource: r.from_source,
      })),
    [rows],
  );

  const handleBulkFlexibility = (flexibilityClass: FlexibilityClassValue) => {
    if (selectedIds.length === 0) return;
    const targetIds = [...selectedIds];
    startTransition(async () => {
      const res = await bulkSetFlexibilityClassAction({
        paymentIds: targetIds,
        flexibilityClass,
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

      <DataTable
        columns={columns}
        data={rows}
        stateKey="pitems"
        searchPlaceholder="Ödeme ara (ad, etiket…)"
        initialSorting={[{ id: "name", desc: false }]}
        exportFileName="odeme-kalemleri"
        emptyLabel="Henüz ödeme kalemi yok."
        minWidth={980}
      />

      {canMutate && selectedIds.length > 0 && (
        <div
          role="region"
          aria-label="Seçili ödeme kalemleri için toplu esneklik çubuğu"
          data-testid="payment-items-floating-bulk-bar"
          className="fixed bottom-4 left-3 right-3 z-40 mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2.5 rounded-[var(--radius-md)] border px-3.5 py-2.5 lg:left-[264px] lg:right-6"
          style={{
            background: "var(--surface-1)",
            borderColor: "var(--line-strong)",
            boxShadow: "var(--shadow-overlay)",
          }}
        >
          <div className="text-xs font-semibold text-tone-1">
            Seçili <span className="tnum">{selectedIds.length}</span> Ödeme Kalemi → Esneklik Ata:
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleBulkFlexibility("critical")}
              className="button-ghost px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
            >
              Kritik
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleBulkFlexibility("flexible")}
              className="button-ghost px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
            >
              Esnek
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleBulkFlexibility("optional")}
              className="button-ghost px-2.5 py-1.5 text-xs font-semibold disabled:opacity-45"
            >
              İsteğe Bağlı
            </button>
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
        canMutate={canMutate}
        canUpdateTemplate={canMutate}
      />
    </div>
  );
}
