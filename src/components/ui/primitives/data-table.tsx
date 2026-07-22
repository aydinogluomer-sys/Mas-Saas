"use client";

// Generic data table (TanStack) restyled to MAS dark tokens.
// Client island only: it sorts/filters/paginates in-browser from serializable rows
// passed by an RSC page. It performs NO mutations — row actions live in cell renderers
// as <Link>/<form action={serverAction}> so the instant-nav + financial-safety contracts hold.
import { useEffect, useRef, useState } from "react";
import {
  type ColumnDef,
  type RowData,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/primitives/dropdown-menu";
import { Button } from "@/components/ui/primitives/button";
import { Input } from "@/components/ui/primitives/input";
import { cn } from "@/lib/utils";

// Column meta shared by every DataTable column: a human label (used by the
// column-visibility menu and CSV export) and cell/header alignment.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    label?: string;
    align?: "left" | "right";
  }
}

function columnLabel<TData>(column: { id: string; columnDef: ColumnDef<TData> }): string {
  const label = column.columnDef.meta?.label;
  if (label) return label;
  const header = column.columnDef.header;
  return typeof header === "string" ? header : column.id;
}

export interface DataTableProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  /** Placeholder for the global filter input; when omitted the search box is hidden. */
  searchPlaceholder?: string;
  initialSorting?: SortingState;
  pageSize?: number;
  /** Unique key so several tables can persist state to the URL without colliding. */
  stateKey?: string;
  /** Right-aligned toolbar slot (e.g. a "New record" link). */
  toolbarRight?: React.ReactNode;
  emptyLabel?: string;
  /** Enables the CSV export button when set. */
  exportFileName?: string;
  minWidth?: number;
}

export function DataTable<TData>({
  columns,
  data,
  searchPlaceholder,
  initialSorting = [],
  pageSize = 25,
  stateKey,
  toolbarRight,
  emptyLabel = "Kayıt yok.",
  exportFileName,
  minWidth = 720,
}: DataTableProps<TData>) {
  const prefix = stateKey ? `${stateKey}_` : "";
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [zoom, setZoom] = useState(0); // table density / font zoom (like the chart toolbar)
  const [focus, setFocus] = useState(false); // full-screen focus mode
  const hydrated = useRef(false);
  const fontPx = Math.min(20, Math.max(10, 14 + zoom));

  useEffect(() => {
    if (!focus) return;
    const onEsc = (event: KeyboardEvent) => { if (event.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [focus]);

  // Read persisted state from the URL once (safe: read-only, no navigation).
  useEffect(() => {
    if (!stateKey) {
      hydrated.current = true;
      return;
    }
    const params = new URL(window.location.href).searchParams;
    const q = params.get(`${prefix}q`);
    const sort = params.get(`${prefix}sort`);
    const dir = params.get(`${prefix}dir`);
    if (q) setGlobalFilter(q);
    if (sort) setSorting([{ id: sort, desc: dir === "desc" }]);
    hydrated.current = true;
  }, [prefix, stateKey]);

  // Mirror state back to the URL via replaceState — does NOT trigger a route change,
  // so it cannot interfere with the instant-navigation contract.
  useEffect(() => {
    if (!stateKey || !hydrated.current) return;
    const url = new URL(window.location.href);
    if (globalFilter) url.searchParams.set(`${prefix}q`, globalFilter);
    else url.searchParams.delete(`${prefix}q`);
    if (sorting[0]) {
      url.searchParams.set(`${prefix}sort`, sorting[0].id);
      url.searchParams.set(`${prefix}dir`, sorting[0].desc ? "desc" : "asc");
    } else {
      url.searchParams.delete(`${prefix}sort`);
      url.searchParams.delete(`${prefix}dir`);
    }
    window.history.replaceState(window.history.state, "", url);
  }, [globalFilter, sorting, prefix, stateKey]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());
  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const totalCount = data.length;
  const pageCount = table.getPageCount();

  const exportCsv = () => {
    const cols = table.getVisibleLeafColumns().filter((c) => c.accessorFn != null);
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const header = cols.map((c) => escape(columnLabel(c))).join(",");
    const body = table.getFilteredRowModel().rows
      .map((row) => cols.map((c) => escape(row.getValue(c.id))).join(","))
      .join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportFileName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = async () => {
    const XLSX = await import("xlsx");
    const cols = table.getVisibleLeafColumns().filter((c) => c.accessorFn != null);
    const rows = [
      cols.map((c) => columnLabel(c)),
      ...table.getFilteredRowModel().rows.map((row) => cols.map((c) => row.getValue(c.id) ?? null)),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = cols.map(() => ({ wch: 18 }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Veri");
    XLSX.writeFile(workbook, `${exportFileName}.xlsx`);
  };

  const showToolbar = searchPlaceholder != null || toolbarRight != null || hideableColumns.length > 0 || exportFileName != null;

  return (
    <div
      className={cn("flex flex-col gap-3", focus && "chart-focus-mode")}
      role={focus ? "dialog" : undefined}
      aria-modal={focus || undefined}
      aria-label={focus ? "Tablo odak modu" : undefined}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2">
          {searchPlaceholder != null && (
            <Input
              type="search"
              value={globalFilter}
              onChange={(event) => setGlobalFilter(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 min-w-56 flex-1 sm:flex-none"
            />
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {toolbarRight}
            {hideableColumns.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button aria-label="Kolonları göster/gizle">Kolonlar</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Görünür kolonlar</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {hideableColumns.map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) => column.toggleVisibility(!!value)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      {columnLabel(column)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <span className="mx-1 hidden h-6 border-l border-line sm:block" aria-hidden />
            <Button onClick={() => setZoom((z) => Math.min(6, z + 1))} title="Tablo yazısını büyüt">Yakınlaştır +</Button>
            <Button onClick={() => setZoom((z) => Math.max(-4, z - 1))} title="Tablo yazısını küçült">Uzaklaştır −</Button>
            <Button onClick={() => setZoom(0)}>Sıfırla</Button>
            <Button onClick={() => setFocus((value) => !value)} aria-pressed={focus}>{focus ? "Odak modunu kapat" : "Odak modu"}</Button>
            {exportFileName != null && (
              <>
                <Button onClick={exportCsv}>CSV</Button>
                <Button onClick={exportExcel}>Excel</Button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="overflow-auto" role="region" aria-label="Veri tablosu" tabIndex={0}>
        <table className="w-full" style={{ minWidth, fontSize: `${fontPx}px` }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const align = header.column.columnDef.meta?.align;
                  return (
                    <th
                      key={header.id}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined}
                      className={cn("sticky top-0 z-10", align === "right" && "text-right")}
                      style={{ background: sorted ? "var(--surface-active)" : "var(--surface-1)", boxShadow: "var(--shadow-sticky)" }}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider",
                            align === "right" && "flex-row-reverse",
                          )}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span aria-hidden className={sorted ? "text-info" : "text-tone-4"}>{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}</span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={table.getVisibleLeafColumns().length} className="py-8 text-center text-sm text-tone-3">
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="row-hover">
                  {row.getVisibleCells().map((cell) => {
                    const align = cell.column.columnDef.meta?.align;
                    return (
                      <td key={cell.id} className={cn(align === "right" && "text-right")}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-tone-3">
        <span>
          {filteredCount === totalCount
            ? `${totalCount} kayıt`
            : `${filteredCount} / ${totalCount} kayıt (filtreli)`}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>← Önceki</Button>
            <span className="font-mono tabular-nums">
              {table.getState().pagination.pageIndex + 1} / {pageCount}
            </span>
            <Button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Sonraki →</Button>
          </div>
        )}
      </div>
    </div>
  );
}
