"use client";

import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import { DataTable } from "@/components/ui/primitives/data-table";
import { ActionMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/primitives/tooltip";
import { ArchiveForm } from "@/components/system/archive-form";

export interface PaymentItemRow {
  id: string;
  name: string;
  recurrence_type: string;
  due_day: number | null;
  default_amount: number | null;
  amount_confidence: string | null;
  status: string;
  flexibility_class: string | null;
  category: string | null;
  provider: string | null;
  owner: string | null;
  from_source: boolean;
}

const FLEX_HINT: Record<string, string> = {
  critical: "Ertelenemez · kritik öncelik. Nakit sıkışıklığında bile önce bu ödenir.",
  flexible: "Vadesi gerekirse kaydırılabilir; kısa süreli erteleme kabul edilebilir.",
  optional: "Zorunlu değil; nakit yetmezse atlanabilir veya ertelenebilir.",
};

function FlexibilityBadge({ value, id }: { value: string | null; id: string }) {
  const badge = value === "critical" ? <Badge tone="red">Kritik</Badge>
    : value === "flexible" ? <Badge tone="blue">Esnek</Badge>
    : value === "optional" ? <Badge tone="green">İsteğe bağlı</Badge>
    : <Link href={`/payments/${id}/edit`}><Badge tone="amber">Sınıflandır</Badge></Link>;
  const hint = value ? FLEX_HINT[value] : "Henüz sınıflandırılmadı — tıklayıp esneklik seviyesini belirleyin.";
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="cursor-help">{badge}</span></TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

const columns: ColumnDef<PaymentItemRow>[] = [
  {
    accessorKey: "name", header: "Ödeme", meta: { label: "Ödeme" },
    cell: ({ row }) => (
      <span className="flex items-center gap-1">
        <Link className="underline underline-offset-2" href={`/payments/${row.original.id}/edit`}>{row.original.name}</Link>
        {row.original.status === "paused" && <Badge tone="neutral">duraklatıldı</Badge>}
      </span>
    ),
  },
  {
    accessorKey: "due_day", header: "Vade", meta: { label: "Vade" },
    cell: ({ row }) => row.original.recurrence_type === "monthly"
      ? <span className="tnum">{row.original.due_day}. gün</span>
      : <Badge tone="amber">günsüz</Badge>,
  },
  {
    accessorKey: "default_amount", header: "Varsayılan tutar", meta: { label: "Varsayılan tutar", align: "right" },
    cell: ({ getValue }) => {
      const value = getValue<number | null>();
      return value == null ? <Badge tone="amber">Tutar eksik</Badge> : <span className="tnum">{fmtTL(value)}</span>;
    },
  },
  {
    accessorKey: "flexibility_class", header: "Esneklik", meta: { label: "Esneklik" },
    cell: ({ row }) => <FlexibilityBadge value={row.original.flexibility_class} id={row.original.id} />,
  },
  { accessorKey: "amount_confidence", header: "Güven", meta: { label: "Güven" }, cell: ({ getValue }) => getValue<string | null>() ?? "—" },
  {
    id: "tags", header: "Etiketler", meta: { label: "Etiketler" },
    accessorFn: (row) => [row.category, row.provider, row.owner].filter(Boolean).join(" · ") || "—",
  },
  {
    accessorKey: "from_source", header: "Kaynak", meta: { label: "Kaynak" },
    cell: ({ getValue }) => getValue<boolean>() ? <Badge tone="blue">Excel</Badge> : <Badge tone="neutral">Manuel</Badge>,
  },
  {
    id: "actions", header: "İşlemler", enableSorting: false, enableHiding: false, meta: { align: "right" },
    cell: ({ row }) => (
      <ActionMenu>
        <DropdownMenuItem asChild>
          <Link href={`/payments/${row.original.id}/edit`}>Düzenle</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ArchiveForm asMenuItem entity="payments" id={row.original.id} backTo="/payments/items?flash=archived" reason="Ödeme kalemlerinden arşivlendi" />
      </ActionMenu>
    ),
  },
];

export function PaymentItemsTable({ rows }: { rows: PaymentItemRow[] }) {
  return (
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
  );
}
