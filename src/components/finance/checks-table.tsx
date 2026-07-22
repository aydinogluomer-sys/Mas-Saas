"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";
import { DataTable } from "@/components/ui/primitives/data-table";
import { ArchiveForm } from "@/components/system/archive-form";

export interface CheckRow {
  id: string;
  maturityDate: string;
  direction: string;
  counterparty: string;
  bank: string | null;
  serial: string | null;
  amount: number | null;
  status: string;
}

const columns: ColumnDef<CheckRow>[] = [
  { accessorKey: "maturityDate", header: "Vade", meta: { label: "Vade" }, cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span> },
  {
    accessorKey: "direction", header: "Yön", meta: { label: "Yön" },
    cell: ({ getValue }) => getValue<string>() === "inflow"
      ? <Badge tone="green">Tahsilat</Badge>
      : <Badge tone="amber">Ödeme</Badge>,
  },
  { accessorKey: "counterparty", header: "Karşı taraf", meta: { label: "Karşı taraf" } },
  { accessorKey: "bank", header: "Banka", meta: { label: "Banka" }, cell: ({ getValue }) => getValue<string | null>() ?? "—" },
  { accessorKey: "serial", header: "Seri", meta: { label: "Seri" }, cell: ({ getValue }) => getValue<string | null>() ?? "—" },
  {
    accessorKey: "amount", header: "Tutar", meta: { label: "Tutar", align: "right" },
    cell: ({ getValue }) => {
      const value = getValue<number | null>();
      return value == null ? <Badge tone="amber">Tutar eksik</Badge> : <span className="font-mono tabular-nums">{fmtTL(value)}</span>;
    },
  },
  { accessorKey: "status", header: "Durum", meta: { label: "Durum" } },
  {
    id: "actions", header: "İşlem", enableSorting: false, enableHiding: false, meta: { align: "right" },
    cell: ({ row }) => (
      <ArchiveForm entity="checks" id={row.original.id} backTo="/finance/checks?flash=archived" reason="Çek defterinden arşivlendi" />
    ),
  },
];

export function ChecksTable({ rows }: { rows: CheckRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="checks"
      searchPlaceholder="Çek ara (karşı taraf, banka, seri…)"
      initialSorting={[{ id: "maturityDate", desc: false }]}
      exportFileName="cekler"
      emptyLabel="Çek kaydı yok."
      minWidth={860}
    />
  );
}
