"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { fmtTL } from "@/components/ui/panel";
import { DataTable } from "@/components/ui/primitives/data-table";

export interface ProfitabilityRow {
  part_code: string | null;
  part_name: string;
  revenue: number | null;
  cost: number | null;
  margin: number | null;
  margin_rate: number | null;
  confidence: string | null;
  missing_operation_time: boolean;
}

const tl = (value: number | null, tone?: "neg" | "pos") => (
  <span className={tone === "neg" ? "tnum text-neg" : tone === "pos" ? "tnum text-pos" : "tnum"}>{fmtTL(value)}</span>
);

const columns: ColumnDef<ProfitabilityRow>[] = [
  {
    id: "part", header: "Parça", meta: { label: "Parça" },
    accessorFn: (row) => `${row.part_code ?? "—"} · ${row.part_name}`,
    cell: ({ row, getValue }) => (
      <span>
        {getValue<string>()}
        {row.original.missing_operation_time && <small className="ml-2 text-warn">süre eksik</small>}
      </span>
    ),
  },
  { accessorKey: "revenue", header: "Gelir", meta: { label: "Gelir", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "cost", header: "Maliyet", meta: { label: "Maliyet", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  {
    accessorKey: "margin", header: "Marj", meta: { label: "Marj", align: "right" },
    cell: ({ getValue }) => { const v = getValue<number | null>(); return tl(v, (v ?? 0) < 0 ? "neg" : "pos"); },
  },
  {
    accessorKey: "margin_rate", header: "Marj %", meta: { label: "Marj %", align: "right" },
    cell: ({ getValue }) => { const v = getValue<number | null>(); return <span className="tnum">{v == null ? "—" : `%${(v * 100).toFixed(1)}`}</span>; },
  },
  { accessorKey: "confidence", header: "Güven", meta: { label: "Güven" }, cell: ({ getValue }) => getValue<string | null>() ?? "—" },
];

export function ProfitabilityTable({ rows }: { rows: ProfitabilityRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="profit"
      searchPlaceholder="Parça ara (kod, ad…)"
      initialSorting={[{ id: "margin_rate", desc: false }]}
      pageSize={25}
      exportFileName="parca-karliligi"
      emptyLabel="Parça kaydı yok."
      minWidth={820}
    />
  );
}
