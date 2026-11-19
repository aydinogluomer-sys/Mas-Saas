"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { fmtTL } from "@/components/ui/panel";
import { DataTable } from "@/components/ui/primitives/data-table";

export interface ProfitabilityRow {
  part_code: string | null;
  part_name: string;
  quantity?: number | null;
  currency?: string;
  unit_sale_price?: number | null;
  scenario_type?: string | null;
  revenue: number | null;
  cost: number | null;
  margin: number | null;
  margin_rate: number | null;
  confidence: string | null;
  missing_operation_time: boolean;
}

const tl = (value: number | null, tone?: "neg" | "pos") => (
  <span
    className="tnum"
    style={{
      color:
        tone === "neg"
          ? "var(--neg)"
          : tone === "pos"
            ? "var(--pos)"
            : "var(--text-1)",
    }}
  >
    {fmtTL(value)}
  </span>
);

function fmtNativeUnit(price: number | null | undefined, ccy: string | undefined): string {
  if (price == null) return "—";
  const c = (ccy || "TRY").toUpperCase();
  const numStr = price.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${numStr} ${c}`;
}

const columns: ColumnDef<ProfitabilityRow>[] = [
  {
    id: "part",
    header: "Parça",
    meta: { label: "Parça" },
    accessorFn: (row) => `${row.part_code ?? "—"} · ${row.part_name}`,
    cell: ({ row, getValue }) => (
      <span>
        <span className="font-medium">{getValue<string>()}</span>
        {row.original.missing_operation_time ? (
          <small className="ml-2 font-mono text-[11px]" style={{ color: "var(--warn)" }}>
            süre eksik
          </small>
        ) : null}
      </span>
    ),
  },
  {
    id: "currency_price",
    header: "Döviz / Birim Fiyat",
    meta: { label: "Döviz / Birim Fiyat", align: "right" },
    accessorFn: (row) => row.unit_sale_price ?? -1,
    cell: ({ row }) => {
      const ccy = (row.original.currency || "TRY").toUpperCase();
      return (
        <span className="tnum font-mono text-xs" style={{ color: ccy !== "TRY" ? "var(--info)" : "var(--text-2)" }}>
          {row.original.unit_sale_price != null ? fmtNativeUnit(row.original.unit_sale_price, ccy) : ccy}
        </span>
      );
    },
  },
  {
    accessorKey: "revenue",
    header: "Gelir (TL · TCMB)",
    meta: { label: "Gelir (TL)", align: "right" },
    cell: ({ getValue }) => tl(getValue<number | null>()),
  },
  {
    accessorKey: "cost",
    header: "Maliyet (710 BOM + İşleme)",
    meta: { label: "Maliyet (TL)", align: "right" },
    cell: ({ getValue }) => tl(getValue<number | null>()),
  },
  {
    accessorKey: "margin",
    header: "Net Marj (TL)",
    meta: { label: "Net Marj", align: "right" },
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return tl(v, v == null ? undefined : v < 0 ? "neg" : "pos");
    },
  },
  {
    accessorKey: "margin_rate",
    header: "Marj %",
    meta: { label: "Marj %", align: "right" },
    cell: ({ getValue }) => {
      const v = getValue<number | null>();
      return (
        <span
          className="tnum font-mono"
          style={{ color: v == null ? "var(--text-3)" : v < 0 ? "var(--neg)" : "var(--pos)" }}
        >
          {v == null ? "—" : `%${(v * 100).toFixed(1)}`}
        </span>
      );
    },
  },
  {
    accessorKey: "confidence",
    header: "Güven",
    meta: { label: "Güven" },
    cell: ({ getValue }) => {
      const val = getValue<string | null>();
      if (!val) return "—";
      const isWarn = val === "needs_review";
      return (
        <span
          className="font-mono text-xs"
          style={{ color: isWarn ? "var(--warn)" : "var(--pos)" }}
        >
          {val === "needs_review" ? "inceleme gerekli" : val}
        </span>
      );
    },
  },
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
      minWidth={900}
    />
  );
}
