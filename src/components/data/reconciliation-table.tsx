"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { fmtTL } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/primitives/data-table";

export interface ReconRow {
  month: string; // YYYY-MM
  app_opening: number | null;
  source_opening: number | null;
  app_closing: number | null;
  source_closing: number | null;
}

const tl = (v: number | null) => <span className="tnum">{fmtTL(v)}</span>;

const columns: ColumnDef<ReconRow>[] = [
  { accessorKey: "month", header: "Ay", meta: { label: "Ay" }, cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span> },
  { accessorKey: "app_opening", header: "Uygulama açılış", meta: { label: "Uygulama açılış", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "source_opening", header: "Kaynak açılış", meta: { label: "Kaynak açılış", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "app_closing", header: "Uygulama kapanış", meta: { label: "Uygulama kapanış", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  { accessorKey: "source_closing", header: "Kaynak kapanış", meta: { label: "Kaynak kapanış", align: "right" }, cell: ({ getValue }) => tl(getValue<number | null>()) },
  {
    id: "fark", header: "Fark (kapanış)", meta: { label: "Fark (kapanış)", align: "right" },
    accessorFn: (row) => (row.app_closing != null && row.source_closing != null ? row.app_closing - row.source_closing : null),
    // Sort by magnitude so the biggest reconciliation mismatches float to the top.
    sortingFn: (a, b, id) => {
      const av = a.getValue<number | null>(id);
      const bv = b.getValue<number | null>(id);
      return (av == null ? -1 : Math.abs(av)) - (bv == null ? -1 : Math.abs(bv));
    },
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      if (v == null) return <Badge tone="amber">karşılaştırılamaz</Badge>;
      if (v === 0) return <span className="tnum text-tone-3">0 TL</span>;
      return <span className="tnum text-warn">{fmtTL(v)}</span>;
    },
  },
];

export function ReconciliationTable({ rows }: { rows: ReconRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="recon"
      searchPlaceholder="Ay ara…"
      initialSorting={[{ id: "fark", desc: true }]}
      pageSize={50}
      exportFileName="nakit-mutabakati"
      emptyLabel="Mutabakat verisi yok."
      minWidth={820}
    />
  );
}
