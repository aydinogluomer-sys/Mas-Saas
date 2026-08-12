"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { fmtTL } from "@/components/ui/panel";
import { DataTable } from "@/components/ui/primitives/data-table";
import { ActionMenu, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/primitives/dropdown-menu";
import { ArchiveForm } from "@/components/system/archive-form";

export interface LoanRow {
  id: string;
  name: string;
  principal: number | null;
  totalPayment: number | null;
  totalFinanceCost: number | null;
  remainingAmount: number | null;
}

const tl = (value: number | null, tone?: "neg") => (
  <span className={tone === "neg" ? "tnum text-neg" : "tnum"}>{fmtTL(value)}</span>
);

const columns: ColumnDef<LoanRow>[] = [
  {
    accessorKey: "name", header: "Kredi", meta: { label: "Kredi" },
    cell: ({ row }) => <a data-hard-nav="true" className="underline underline-offset-2" href={`/finance/loans/${row.original.id}`}>{row.original.name}</a>,
  },
  { accessorKey: "principal", header: "Anapara", meta: { label: "Anapara", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "totalPayment", header: "Toplam ödeme", meta: { label: "Toplam ödeme", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "totalFinanceCost", header: "Finansman maliyeti", meta: { label: "Finansman maliyeti", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>(), "neg") },
  { accessorKey: "remainingAmount", header: "Kalan", meta: { label: "Kalan", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>(), "neg") },
  {
    id: "actions", header: "İşlemler", enableSorting: false, enableHiding: false, meta: { align: "right" },
    cell: ({ row }) => (
      <ActionMenu>
        <DropdownMenuItem asChild>
          <a data-hard-nav="true" href={`/finance/loans/${row.original.id}`}>Taksit planı</a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ArchiveForm asMenuItem entity="loans" id={row.original.id} backTo="/finance/loans?flash=archived" reason="Kredi listesinden arşivlendi" />
      </ActionMenu>
    ),
  },
];

export function LoansTable({ rows }: { rows: LoanRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="loans"
      searchPlaceholder="Kredi ara…"
      initialSorting={[{ id: "remainingAmount", desc: true }]}
      exportFileName="krediler"
      emptyLabel="Kredi kaydı yok."
      minWidth={820}
    />
  );
}
