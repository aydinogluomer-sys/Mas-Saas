"use client";

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, CheckSquare, Columns3, Download, FileSpreadsheet, Search, X } from "lucide-react";
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

export interface FinancialGridFilterChip<TData> {
  id: string;
  label: string;
  predicate: (row: TData) => boolean;
}

export interface FinancialGridBatchAction<TData> {
  key: string;
  label: ReactNode;
  tone?: "accent" | "ghost" | "danger";
  onAction: (selectedRows: TData[], clearSelection: () => void) => void;
}

export interface FinancialDataGridProps<TData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  getRowId?: (row: TData, index: number) => string;
  searchPlaceholder?: string;
  filterChips?: FinancialGridFilterChip<TData>[];
  initialSorting?: SortingState;
  selectable?: boolean;
  batchActions?: FinancialGridBatchAction<TData>[];
  renderBatchBar?: (selectedRows: TData[], clearSelection: () => void) => ReactNode;
  onRowActivate?: (row: TData) => void;
  toolbarRight?: ReactNode;
  emptyLabel?: string;
  exportFileName?: string;
  maxHeight?: number;
  rowHeight?: number;
  minWidth?: number;
}

function columnLabel<TData>(column: { id: string; columnDef: ColumnDef<TData> }): string {
  const label = column.columnDef.meta?.label;
  if (label) return label;
  const header = column.columnDef.header;
  return typeof header === "string" ? header : column.id;
}

function toExportScalar(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "boolean") return val ? "Evet" : "Hayır";
  const s = String(val);
  return s.length > 4000 ? s.slice(0, 4000) : s;
}

/**
 * Editorial Precision v2 — Virtualized FinancialDataGrid (M-11).
 * Powered by `@tanstack/react-virtual` + `@tanstack/react-table` for <= 16ms frame budgets
 * across 5,000+ rows, sticky headers, right-aligned tabular-nums, instant filter chips,
 * keyboard ↑/↓ row navigation, and floating batch action bar.
 */
export function FinancialDataGrid<TData>({
  columns,
  data,
  getRowId,
  searchPlaceholder = "Kayıtlarda ara...",
  filterChips,
  initialSorting = [],
  selectable = false,
  batchActions,
  renderBatchBar,
  onRowActivate,
  toolbarRight,
  emptyLabel = "Filtreye uygun finansal kayıt bulunamadı.",
  exportFileName,
  maxHeight = 560,
  rowHeight = 42,
  minWidth = 760,
}: FinancialDataGridProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");
  const [activeChipId, setActiveChipId] = useState<string>("all");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [focusedRowIndex, setFocusedRowIndex] = useState<number>(0);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const chipCounts = useMemo(() => {
    if (!filterChips || filterChips.length === 0) return {};
    const counts: Record<string, number> = {};
    for (const chip of filterChips) {
      let c = 0;
      for (let i = 0; i < data.length; i += 1) {
        if (chip.predicate(data[i])) c += 1;
      }
      counts[chip.id] = c;
    }
    return counts;
  }, [data, filterChips]);

  const chipFilteredData = useMemo(() => {
    if (!filterChips || activeChipId === "all") return data;
    const chip = filterChips.find((c) => c.id === activeChipId);
    return chip ? data.filter(chip.predicate) : data;
  }, [data, filterChips, activeChipId]);

  const table = useReactTable({
    data: chipFilteredData,
    columns,
    getRowId,
    enableRowSelection: selectable,
    state: {
      sorting,
      globalFilter,
      columnVisibility,
      rowSelection,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    globalFilterFn: "includesString",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;
  const hideableColumns = table.getAllLeafColumns().filter((col) => col.getCanHide());
  const selectedRows = useMemo(
    () => table.getSelectedRowModel().rows.map((r) => r.original),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowSelection, chipFilteredData],
  );

  const clearSelection = useCallback(() => {
    setRowSelection({});
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalVirtualSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? Math.max(0, totalVirtualSize - virtualItems[virtualItems.length - 1].end) : 0;

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.min(rows.length - 1, focusedRowIndex + 1);
      setFocusedRowIndex(next);
      rowVirtualizer.scrollToIndex(next, { align: "auto" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = Math.max(0, focusedRowIndex - 1);
      setFocusedRowIndex(prev);
      rowVirtualizer.scrollToIndex(prev, { align: "auto" });
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedRowIndex(0);
      rowVirtualizer.scrollToIndex(0, { align: "start" });
    } else if (event.key === "End") {
      event.preventDefault();
      const last = rows.length - 1;
      setFocusedRowIndex(last);
      rowVirtualizer.scrollToIndex(last, { align: "end" });
    } else if (event.key === "Enter" && onRowActivate) {
      const targetRow = rows[focusedRowIndex];
      if (targetRow) {
        event.preventDefault();
        onRowActivate(targetRow.original);
      }
    } else if (event.key === " " && selectable) {
      const targetRow = rows[focusedRowIndex];
      if (targetRow) {
        event.preventDefault();
        targetRow.toggleSelected();
      }
    }
  };

  const exportCsv = () => {
    if (!exportFileName) return;
    const cols = table.getVisibleLeafColumns().filter((c) => c.accessorFn != null);
    const safeCell = (value: unknown) => {
      const str = String(value ?? "");
      const guarded = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
      return `"${guarded.replaceAll('"', '""')}"`;
    };
    const header = cols.map((c) => safeCell(columnLabel(c))).join(";");
    const body = rows.map((row) => cols.map((c) => safeCell(row.getValue(c.id))).join(";")).join("\n");
    const blob = new Blob([`\ufeff${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportFileName}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = async () => {
    if (!exportFileName) return;
    const cols = table.getVisibleLeafColumns().filter((c) => c.accessorFn != null);
    const sheetRows: (string | number | null)[][] = [
      cols.map((c) => columnLabel(c)),
      ...rows.map((row) => cols.map((c) => toExportScalar(row.getValue(c.id)))),
    ];
    const response = await fetch("/api/analytics/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: exportFileName, sheets: [{ name: "Veri", rows: sheetRows }] }),
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportFileName}.xlsx`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const totalLeafCols = table.getVisibleLeafColumns().length + (selectable ? 1 : 0);

  return (
    <div className="relative flex flex-col gap-3" data-testid="financial-data-grid">
      {/* Top Toolbar: Instant Search + Filter Chips + Column Visibility + Export */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search
              size={14}
              strokeWidth={1.75}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-3)" }}
              aria-hidden
            />
            <Input
              type="search"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 pl-8 pr-3 text-[12.5px]"
            />
          </div>

          {filterChips && filterChips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Hızlı filtreler">
              <button
                type="button"
                onClick={() => setActiveChipId("all")}
                aria-pressed={activeChipId === "all"}
                className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
                style={
                  activeChipId === "all"
                    ? {
                        background: "color-mix(in srgb, var(--info) 11%, var(--surface-1))",
                        borderColor: "color-mix(in srgb, var(--info) 35%, var(--line))",
                        color: "var(--info)",
                      }
                    : {
                        background: "var(--surface-1)",
                        borderColor: "var(--line)",
                        color: "var(--text-2)",
                      }
                }
              >
                <span>Tümü</span>
                <span className="tabular-nums opacity-75">({data.length})</span>
              </button>
              {filterChips.map((chip) => {
                const active = activeChipId === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setActiveChipId(active ? "all" : chip.id)}
                    aria-pressed={active}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
                    style={
                      active
                        ? {
                            background: "color-mix(in srgb, var(--info) 11%, var(--surface-1))",
                            borderColor: "color-mix(in srgb, var(--info) 35%, var(--line))",
                            color: "var(--info)",
                          }
                        : {
                            background: "var(--surface-1)",
                            borderColor: "var(--line)",
                            color: "var(--text-2)",
                          }
                    }
                  >
                    <span>{chip.label}</span>
                    <span className="tabular-nums opacity-75">({chipCounts[chip.id] ?? 0})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {toolbarRight}
          {hideableColumns.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button aria-label="Kolonları göster/gizle" className="gap-1.5">
                  <Columns3 size={13.5} strokeWidth={1.75} aria-hidden />
                  <span>Kolonlar</span>
                </Button>
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
          {exportFileName != null && (
            <>
              <Button onClick={exportCsv} className="gap-1.5">
                <Download size={13.5} strokeWidth={1.75} aria-hidden />
                <span>CSV</span>
              </Button>
              <Button onClick={exportExcel} className="gap-1.5">
                <FileSpreadsheet size={13.5} strokeWidth={1.75} aria-hidden />
                <span>Excel</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Virtualized Table Viewport */}
      <div
        ref={scrollContainerRef}
        onKeyDown={handleGridKeyDown}
        tabIndex={0}
        role="region"
        aria-label="Finansal veri tablosu (Yukarı ve aşağı ok tuşlarıyla satırlar arasında gezinebilirsiniz)"
        className="overflow-auto border outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        style={{
          maxHeight,
          background: "var(--surface-1)",
          borderColor: "var(--line-card)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <table className="w-full border-collapse" style={{ minWidth }}>
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {selectable && (
                  <th
                    className="sticky top-0 z-10 w-10 px-3 py-2.5 text-center"
                    style={{ background: "var(--surface-2)", boxShadow: "var(--shadow-sticky)" }}
                  >
                    <input
                      type="checkbox"
                      aria-label="Tüm görünür satırları seç"
                      checked={table.getIsAllRowsSelected()}
                      onChange={table.getToggleAllRowsSelectedHandler()}
                      className="h-3.5 w-3.5 cursor-pointer accent-[var(--info)]"
                    />
                  </th>
                )}
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const align = header.column.columnDef.meta?.align;
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : canSort ? "none" : undefined
                      }
                      className={cn("sticky top-0 z-10 px-3 py-2.5", align === "right" && "text-right")}
                      style={{
                        background: sorted ? "var(--surface-active)" : "var(--surface-2)",
                        boxShadow: "var(--shadow-sticky)",
                      }}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em]",
                            align === "right" && "flex-row-reverse",
                          )}
                          style={{ color: sorted ? "var(--text-1)" : "var(--text-3)" }}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp size={12} strokeWidth={2} style={{ color: "var(--info)" }} aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown size={12} strokeWidth={2} style={{ color: "var(--info)" }} aria-hidden />
                          ) : (
                            <ArrowUpDown size={11.5} strokeWidth={1.75} className="opacity-55" aria-hidden />
                          )}
                        </button>
                      ) : (
                        <span className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-3)" }}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
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
                <td colSpan={totalLeafCols} className="py-10 text-center text-[13px]" style={{ color: "var(--text-3)" }}>
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 && (
                  <tr aria-hidden>
                    <td colSpan={totalLeafCols} style={{ height: `${paddingTop}px`, padding: 0, border: 0 }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;
                  const isSelected = row.getIsSelected();
                  const isFocused = virtualRow.index === focusedRowIndex;
                  return (
                    <tr
                      key={row.id}
                      data-index={virtualRow.index}
                      onClick={() => {
                        setFocusedRowIndex(virtualRow.index);
                        onRowActivate?.(row.original);
                      }}
                      className={cn("row-hover", onRowActivate && "cursor-pointer")}
                      style={{
                        height: `${rowHeight}px`,
                        background: isSelected
                          ? "color-mix(in srgb, var(--info) 8%, var(--surface-1))"
                          : isFocused
                            ? "var(--surface-hover)"
                            : undefined,
                      }}
                    >
                      {selectable && (
                        <td
                          className="w-10 px-3 text-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Satır ${virtualRow.index + 1} seç`}
                            checked={isSelected}
                            onChange={row.getToggleSelectedHandler()}
                            className="h-3.5 w-3.5 cursor-pointer accent-[var(--info)]"
                          />
                        </td>
                      )}
                      {row.getVisibleCells().map((cell) => {
                        const align = cell.column.columnDef.meta?.align;
                        return (
                          <td
                            key={cell.id}
                            className={cn(
                              "px-3 py-2 text-[13px]",
                              align === "right" && "text-right tabular-nums font-medium",
                            )}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {paddingBottom > 0 && (
                  <tr aria-hidden>
                    <td colSpan={totalLeafCols} style={{ height: `${paddingBottom}px`, padding: 0, border: 0 }} />
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer Summary */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]" style={{ color: "var(--text-3)" }}>
        <span className="tabular-nums">
          {rows.length === data.length ? `${data.length} kayıt` : `${rows.length} / ${data.length} kayıt (filtreli)`}
        </span>
        <span className="hidden sm:inline text-[11.5px]">
          Klavye: <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">↑</kbd>{" "}
          <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">↓</kbd> satır gezintisi
          {onRowActivate ? ", Enter detay" : ""}
        </span>
      </div>

      {/* Floating Batch Action Bar when rows are selected */}
      {selectable && selectedRows.length > 0 && (batchActions?.length || renderBatchBar) && (
        <div
          className="sticky bottom-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-3 rounded-[var(--radius-md)] border px-4 py-2.5 animate-rise"
          style={{
            background: "var(--surface-1)",
            borderColor: "var(--line-strong)",
            boxShadow: "var(--shadow-overlay)",
          }}
          role="region"
          aria-label="Toplu işlem çubuğu"
        >
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: "var(--text-1)" }}>
            <CheckSquare size={14} strokeWidth={1.75} style={{ color: "var(--info)" }} aria-hidden />
            <span className="tabular-nums">{selectedRows.length} kayıt seçildi</span>
          </span>
          {renderBatchBar
            ? renderBatchBar(selectedRows, clearSelection)
            : batchActions?.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => action.onAction(selectedRows, clearSelection)}
                  className={
                    action.tone === "accent"
                      ? "button-accent"
                      : action.tone === "danger"
                        ? "button-danger"
                        : "button-ghost"
                  }
                >
                  {action.label}
                </button>
              ))}
          <button
            type="button"
            onClick={clearSelection}
            className="button-ghost inline-flex items-center gap-1 px-2 py-1 text-[11.5px]"
            aria-label="Seçimi temizle"
          >
            <X size={13} strokeWidth={1.75} aria-hidden />
            <span>Temizle</span>
          </button>
        </div>
      )}
    </div>
  );
}
