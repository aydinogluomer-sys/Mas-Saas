"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "@/components/ui/app-link";
import { Badge, SEVERITY_TONE, STATUS_TONE } from "@/components/ui/badge";
import { Button } from "@/components/ui/primitives/button";
import { setReviewStatusAction } from "@/app/(dashboard)/data/imports/actions";
import { createActionFromReviewAction } from "@/app/(dashboard)/data/quality/actions";
import {
  bulkUpdateReviewStatusAction,
  type BulkReviewDecisionStatus,
} from "@/app/(dashboard)/data/reviews/actions";

export interface Review {
  id: string;
  workbook_id: string;
  workbook_name: string;
  sheet_name: string | null;
  row_index: number | null;
  issue_type: string;
  severity: string;
  message: string;
  status: string;
}

interface ReviewGroup {
  key: string;
  issueType: string;
  sheetName: string;
  topSeverity: string;
  sampleMessage: string;
  rows: Review[];
}

interface TriageBanner {
  tone: "pos" | "neg";
  message: string;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_LABEL_TR: Record<string, string> = {
  open: "Açık",
  accepted: "Kabul",
  resolved: "Çözüldü",
  rejected: "Reddedildi",
};

function parseFilterStatusFromBackTo(backTo: string): string {
  const qIdx = backTo.indexOf("?");
  if (qIdx < 0) return "open";
  const sp = new URLSearchParams(backTo.slice(qIdx + 1));
  return sp.get("status") ?? "open";
}

export function ReviewsTriageDesk({
  initialRows,
  canMutate,
  backTo,
}: {
  initialRows: Review[];
  canMutate: boolean;
  backTo: string;
}) {
  const activeFilterStatus = useMemo(
    () => parseFilterStatusFromBackTo(backTo),
    [backTo],
  );

  const [baselineIds] = useState<ReadonlySet<string>>(
    () => new Set(initialRows.map((r) => r.id)),
  );
  const [statusOverrides, setStatusOverrides] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [isBulkPending, setIsBulkPending] = useState(false);
  const [banner, setBanner] = useState<TriageBanner | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);

  const effectiveRows = useMemo(
    () =>
      initialRows
        .map((r) => ({
          ...r,
          status: statusOverrides[r.id] ?? r.status,
        }))
        .filter((r) =>
          activeFilterStatus === "all" ? true : r.status === activeFilterStatus,
        ),
    [initialRows, statusOverrides, activeFilterStatus],
  );

  const totalSessionCount = Math.max(baselineIds.size, effectiveRows.length);
  const remainingCount = effectiveRows.length;
  const clearedSessionCount =
    activeFilterStatus === "all"
      ? Object.keys(statusOverrides).length
      : Math.max(0, totalSessionCount - remainingCount);

  const groups = useMemo<ReviewGroup[]>(() => {
    const map = new Map<string, ReviewGroup>();
    for (const r of effectiveRows) {
      const sheetName = r.sheet_name ?? "sekme yok";
      const key = `${r.issue_type}::${sheetName}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          issueType: r.issue_type,
          sheetName,
          topSeverity: r.severity,
          sampleMessage: r.message,
          rows: [],
        };
        map.set(key, g);
      }
      g.rows.push(r);
      if (
        (SEVERITY_RANK[r.severity] ?? 9) < (SEVERITY_RANK[g.topSeverity] ?? 9)
      ) {
        g.topSeverity = r.severity;
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
      const sevDiff =
        (SEVERITY_RANK[a.topSeverity] ?? 9) - (SEVERITY_RANK[b.topSeverity] ?? 9);
      if (sevDiff !== 0) return sevDiff;
      return a.issueType.localeCompare(b.issueType, "tr-TR");
    });
  }, [effectiveRows]);

  const activeGroupKey =
    focusedGroupKey && groups.some((g) => g.key === focusedGroupKey)
      ? focusedGroupKey
      : null;

  const displayedRows = useMemo(() => {
    if (!activeGroupKey) return effectiveRows;
    return effectiveRows.filter(
      (r) => `${r.issue_type}::${r.sheet_name ?? "sekme yok"}` === activeGroupKey,
    );
  }, [effectiveRows, activeGroupKey]);

  const visibleIdSet = useMemo(
    () => new Set(displayedRows.map((r) => r.id)),
    [displayedRows],
  );

  const activeSelectedIds = useMemo(
    () => Array.from(selectedIds).filter((id) => visibleIdSet.has(id)),
    [selectedIds, visibleIdSet],
  );

  const allVisibleSelected =
    displayedRows.length > 0 && activeSelectedIds.length === displayedRows.length;

  function handleToggleSelectAll() {
    if (!canMutate) return;
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of displayedRows) next.delete(r.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of displayedRows) next.add(r.id);
        return next;
      });
    }
  }

  function handleToggleRowSelection(
    rowId: string,
    rowIndex: number,
    shiftKey: boolean,
  ) {
    if (!canMutate) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const shouldSelect = !next.has(rowId);
      if (
        shiftKey &&
        lastClickedIndexRef.current !== null &&
        lastClickedIndexRef.current !== rowIndex
      ) {
        const start = Math.min(lastClickedIndexRef.current, rowIndex);
        const end = Math.max(lastClickedIndexRef.current, rowIndex);
        for (let i = start; i <= end; i++) {
          const item = displayedRows[i];
          if (!item) continue;
          if (shouldSelect) next.add(item.id);
          else next.delete(item.id);
        }
      } else {
        if (shouldSelect) next.add(rowId);
        else next.delete(rowId);
      }
      return next;
    });
    lastClickedIndexRef.current = rowIndex;
  }

  async function executeStatusUpdate(
    ids: string[],
    targetStatus: BulkReviewDecisionStatus,
    contextLabel: string,
  ) {
    if (!canMutate || ids.length === 0) return;

    const previousOverrides: Record<string, string | undefined> = {};
    for (const id of ids) {
      previousOverrides[id] = statusOverrides[id];
    }

    // Optimistic zero-reload update
    setStatusOverrides((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = targetStatus;
      return next;
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    if (ids.length > 1) setIsBulkPending(true);

    try {
      const res = await bulkUpdateReviewStatusAction({
        ids,
        status: targetStatus,
      });

      if (!res.ok) {
        setStatusOverrides((prev) => {
          const next = { ...prev };
          for (const id of ids) {
            const old = previousOverrides[id];
            if (old === undefined) delete next[id];
            else next[id] = old;
          }
          return next;
        });
        setBanner({ tone: "neg", message: res.error });
        return;
      }

      setBanner({
        tone: "pos",
        message: `${contextLabel}: ${res.updatedCount} inceleme "${STATUS_LABEL_TR[targetStatus] ?? targetStatus}" olarak güncellendi.`,
      });
    } catch {
      setStatusOverrides((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          const old = previousOverrides[id];
          if (old === undefined) delete next[id];
          else next[id] = old;
        }
        return next;
      });
      setBanner({
        tone: "neg",
        message: "İnceleme durumu güncellenirken sunucu hatası oluştu.",
      });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setIsBulkPending(false);
    }
  }

  function handleSingleRowSubmit(
    e: FormEvent<HTMLFormElement>,
    row: Review,
    targetStatus: BulkReviewDecisionStatus,
  ) {
    e.preventDefault();
    void executeStatusUpdate([row.id], targetStatus, row.issue_type);
  }

  return (
    <div className="grid gap-4">
      {/* Üst Özet İlerleme Şeridi */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tnum text-xs font-semibold text-tone-1">
            Karara Bağlanan: {clearedSessionCount} / Toplam: {totalSessionCount} · Kalan
            İnceleme: {remainingCount}
          </span>
          <Badge
            tone={
              remainingCount === 0
                ? "green"
                : clearedSessionCount > 0
                  ? "blue"
                  : "amber"
            }
            dot
          >
            {groups.length} sorun grubu
          </Badge>
          {!canMutate && <Badge tone="neutral">Salt-okunur yetki</Badge>}
        </div>

        {activeGroupKey && (
          <button
            type="button"
            onClick={() => setFocusedGroupKey(null)}
            className="button-ghost px-2.5 py-1 text-xs"
          >
            Grup filtresini kaldır (Tümünü göster: {effectiveRows.length})
          </button>
        )}
      </div>

      {/* Geri Bildirim Şeridi */}
      {banner && (
        <div
          role="status"
          className={`flex items-center justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs ${
            banner.tone === "pos"
              ? "border-pos tint-pos text-tone-1"
              : "border-neg tint-neg text-neg"
          }`}
        >
          <span>{banner.message}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="button-ghost px-2 py-0.5 text-[11px]"
          >
            Kapat
          </button>
        </div>
      )}

      {/* Üst Grup Özet Kartları (issue_type · sheet_name) */}
      {groups.length > 0 && (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => {
            const isFocused = activeGroupKey === g.key;
            const groupIds = g.rows.map((r) => r.id);
            return (
              <div
                key={g.key}
                className={`flex flex-col justify-between gap-2.5 rounded-[var(--radius-md)] border p-3 transition-colors ${
                  isFocused
                    ? "border-info bg-surface-2"
                    : "border-line bg-surface-1 hover:bg-surface-2/60"
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={SEVERITY_TONE[g.topSeverity] ?? "neutral"}>
                        {g.topSeverity}
                      </Badge>
                      <button
                        type="button"
                        onClick={() =>
                          setFocusedGroupKey(isFocused ? null : g.key)
                        }
                        className="text-left font-mono text-xs font-semibold text-tone-1 hover:underline"
                      >
                        {g.issueType} · {g.sheetName}
                      </button>
                    </div>
                    <Badge tone="amber">{g.rows.length} kayıt</Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs text-tone-3">
                    {g.sampleMessage}
                  </p>
                </div>

                {canMutate && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={isBulkPending}
                      onClick={() =>
                        void executeStatusUpdate(
                          groupIds,
                          "accepted",
                          `${g.issueType} · ${g.sheetName}`,
                        )
                      }
                      className="button-primary px-2.5 py-1 text-xs"
                    >
                      Grubu Kabul Et ({g.rows.length})
                    </button>
                    <button
                      type="button"
                      disabled={isBulkPending}
                      onClick={() =>
                        void executeStatusUpdate(
                          groupIds,
                          "resolved",
                          `${g.issueType} · ${g.sheetName}`,
                        )
                      }
                      className="button-accent px-2.5 py-1 text-xs"
                    >
                      Grubu Çöz ({g.rows.length})
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Etkileşimli Çoklu Seçim İnceleme Tablosu */}
      {displayedRows.length === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-pos tint-pos px-4 py-4 text-sm text-tone-1">
          Bu görünümde bekleyen inceleme kaydı kalmadı.
        </div>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-line bg-surface-1">
          {canMutate && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-tone-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={handleToggleSelectAll}
                  aria-label="Tüm görünür incelemeleri seç"
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span>
                  Tümünü seç ({displayedRows.length} inceleme
                  {activeSelectedIds.length > 0
                    ? ` · ${activeSelectedIds.length} seçili`
                    : ""}
                  )
                </span>
              </label>

              {activeSelectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="button-ghost px-2 py-0.5 text-xs"
                >
                  Seçimi Temizle
                </button>
              )}
            </div>
          )}

          <div>
            {displayedRows.map((r, idx) => {
              const isSelected = selectedIds.has(r.id);
              const isRowPending = pendingIds.has(r.id);

              return (
                <article
                  key={r.id}
                  className={`row-hover border-b border-line-faint px-3 py-3 last:border-b-0 ${
                    isSelected ? "tint-info" : ""
                  }`}
                >
                  <div className="grid gap-2.5 lg:grid-cols-[auto_165px_1fr_auto] lg:items-start">
                    {canMutate ? (
                      <div className="pt-0.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            const shiftKey =
                              e.nativeEvent instanceof MouseEvent
                                ? e.nativeEvent.shiftKey
                                : false;
                            handleToggleRowSelection(r.id, idx, shiftKey);
                          }}
                          aria-label={`${r.issue_type} incelemesini seç`}
                          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
                        />
                      </div>
                    ) : (
                      <div className="hidden lg:block" />
                    )}

                    <div>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge
                          tone={
                            r.severity === "critical"
                              ? "red"
                              : r.severity === "high"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {r.severity}
                        </Badge>
                        {activeFilterStatus === "all" && (
                          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                            {STATUS_LABEL_TR[r.status] ?? r.status}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-tone-2">
                        {r.issue_type}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <b className="text-sm font-semibold text-tone-1">
                        {r.message}
                      </b>
                      <p className="mt-1 text-xs text-tone-3">
                        Etkilenen kaynak: {r.workbook_name} ·{" "}
                        {r.sheet_name ?? "sekme yok"}
                        {r.row_index ? ` · satır ${r.row_index}` : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-start gap-1 lg:justify-end">
                      <Link
                        className="button-ghost px-2 py-1 text-xs"
                        href={`/data/imports/${r.workbook_id}/reviews`}
                      >
                        Kaynağı aç
                      </Link>
                      {canMutate && (
                        <>
                          {(
                            [
                              ["accepted", "Kabul"],
                              ["resolved", "Çöz"],
                              ["rejected", "Reddet"],
                            ] as const
                          ).map(([s, l]) => (
                            <form
                              key={s}
                              action={setReviewStatusAction}
                              onSubmit={(e) => handleSingleRowSubmit(e, r, s)}
                            >
                              <input type="hidden" name="id" value={r.id} />
                              <input type="hidden" name="status" value={s} />
                              <input type="hidden" name="backTo" value={backTo} />
                              <Button type="submit" disabled={isRowPending}>
                                {l}
                              </Button>
                            </form>
                          ))}
                          <form action={createActionFromReviewAction}>
                            <input type="hidden" name="reviewId" value={r.id} />
                            <input type="hidden" name="backTo" value={backTo} />
                            <Button type="submit" variant="accent">
                              Görev oluştur
                            </Button>
                          </form>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {/* Yüzen Toplu Karar Çubuğu (Floating Bulk Action Bar) */}
      {canMutate && activeSelectedIds.length > 0 && (
        <div
          role="region"
          aria-label="Seçili incelemeler için toplu aksiyon çubuğu"
          data-testid="reviews-floating-bulk-bar"
          className="fixed bottom-4 left-3 right-3 z-40 mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-line-strong bg-surface-overlay px-4 py-3 shadow-[var(--shadow-overlay)] lg:left-[264px] lg:right-6"
        >
          <div className="flex items-center gap-2">
            <Badge tone="blue" dot>
              Seçili {activeSelectedIds.length} İnceleme
            </Badge>
            <span className="text-xs text-tone-3">
              Tek tıkla tüm seçili kayıtları karara bağlayın:
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isBulkPending}
              onClick={() =>
                void executeStatusUpdate(
                  activeSelectedIds,
                  "accepted",
                  "Toplu karar",
                )
              }
              className="button-primary px-3 py-1.5 text-xs"
            >
              Toplu Kabul Et
            </button>
            <button
              type="button"
              disabled={isBulkPending}
              onClick={() =>
                void executeStatusUpdate(
                  activeSelectedIds,
                  "resolved",
                  "Toplu karar",
                )
              }
              className="button-accent px-3 py-1.5 text-xs"
            >
              Toplu Çöz
            </button>
            <button
              type="button"
              disabled={isBulkPending}
              onClick={() =>
                void executeStatusUpdate(
                  activeSelectedIds,
                  "rejected",
                  "Toplu karar",
                )
              }
              className="button-ghost px-3 py-1.5 text-xs text-neg"
            >
              Toplu Reddet
            </button>
            <button
              type="button"
              disabled={isBulkPending}
              onClick={() => setSelectedIds(new Set())}
              className="button-ghost px-2.5 py-1.5 text-xs"
            >
              Vazgeç
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
