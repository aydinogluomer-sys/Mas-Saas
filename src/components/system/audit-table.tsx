"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/primitives/data-table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/primitives/tooltip";

export interface AuditRow {
  id: string;
  action: string;
  entity: string;
  created_at: string;
  before: string;
  after: string;
}

function pretty(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

const jsonCell = (value: string) => {
  if (value === "—") return <span className="text-tone-4">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <pre className="max-w-xs cursor-help truncate whitespace-nowrap text-[10px] text-tone-3">{value}</pre>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <pre className="max-h-72 overflow-hidden whitespace-pre-wrap break-words text-[10px] leading-snug">{pretty(value)}</pre>
      </TooltipContent>
    </Tooltip>
  );
};

const columns: ColumnDef<AuditRow>[] = [
  { accessorKey: "created_at", header: "Zaman", meta: { label: "Zaman" }, cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span> },
  { accessorKey: "action", header: "İşlem", meta: { label: "İşlem" } },
  { accessorKey: "entity", header: "Varlık", meta: { label: "Varlık" } },
  { accessorKey: "before", header: "Önce", enableSorting: false, meta: { label: "Önce" }, cell: ({ getValue }) => jsonCell(getValue<string>()) },
  { accessorKey: "after", header: "Sonra", enableSorting: false, meta: { label: "Sonra" }, cell: ({ getValue }) => jsonCell(getValue<string>()) },
];

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="audit"
      searchPlaceholder="Denetim ara (işlem, varlık, tarih…)"
      initialSorting={[{ id: "created_at", desc: true }]}
      pageSize={25}
      exportFileName="denetim-kayitlari"
      emptyLabel="Denetim kaydı yok."
      minWidth={880}
    />
  );
}
