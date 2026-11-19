"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { RiskBadges } from "@/components/radar/instance-row";
import { formatMoney, normalizeCurrencyLabel } from "@/lib/money-format";
import type { InstanceRow } from "@/lib/radar/queries";
import {
  cancelInstanceAction,
  markPaidAction,
  setAmountAction,
} from "@/app/(dashboard)/payments/actions";
import {
  bulkSetInstancesByIdsAction,
  bulkSetTemplateMissingAmountsAction,
  inlineSetMissingAmountAction,
} from "@/app/(dashboard)/payments/missing/actions";

const PAYABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);
const CANCELLABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);
const INITIAL_TABLE_LIMIT = 80;

type DeskMode = "grouped" | "table";

interface TemplateGroup {
  key: string;
  paymentId: string | null;
  name: string;
  currency: string;
  category: string | null;
  flexibility: InstanceRow["flexibility"];
  rows: InstanceRow[];
  firstDueDate: string;
  lastDueDate: string;
}

interface StatusBanner {
  tone: "pos" | "warn" | "neg";
  message: string;
}

function formatShortDateTR(iso: string): string {
  if (!iso || iso.length < 10) return iso || "—";
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

export function MissingAmountsDesk({
  initialRows,
  canMutate,
}: {
  initialRows: InstanceRow[];
  canMutate: boolean;
}) {
  const [baselineIds] = useState<ReadonlySet<string>>(
    () => new Set(initialRows.map((r) => r.id)),
  );
  const [clearedIds, setClearedIds] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<DeskMode>(() =>
    initialRows.length > 8 ? "grouped" : "table",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState<string>("ALL");
  const [tableLimit, setTableLimit] = useState<number>(INITIAL_TABLE_LIMIT);

  const [rowDrafts, setRowDrafts] = useState<Record<string, string>>({});
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [savingRowIds, setSavingRowIds] = useState<Set<string>>(() => new Set());
  const [savingGroupKeys, setSavingGroupKeys] = useState<Set<string>>(() => new Set());
  const [banner, setBanner] = useState<StatusBanner | null>(null);

  const rowInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const groupInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const remainingRows = useMemo(
    () => initialRows.filter((r) => !clearedIds.has(r.id)),
    [initialRows, clearedIds],
  );

  const totalCount = Math.max(baselineIds.size, remainingRows.length);
  const remainingCount = remainingRows.length;
  const completedCount = Math.max(0, totalCount - remainingCount);
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 100;

  const availableCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const r of remainingRows) {
      set.add((r.currency ?? "TRY").toUpperCase());
    }
    return Array.from(set).sort((a, b) => (a === "TRY" ? -1 : b === "TRY" ? 1 : a.localeCompare(b)));
  }, [remainingRows]);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("tr-TR");

  const filteredRows = useMemo(() => {
    return remainingRows.filter((r) => {
      const ccy = (r.currency ?? "TRY").toUpperCase();
      if (currencyFilter !== "ALL" && ccy !== currencyFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = `${r.name} ${r.category ?? ""} ${r.due_date} ${ccy}`.toLocaleLowerCase(
        "tr-TR",
      );
      return haystack.includes(normalizedQuery);
    });
  }, [remainingRows, currencyFilter, normalizedQuery]);

  const allGroups = useMemo<TemplateGroup[]>(() => {
    const map = new Map<string, TemplateGroup>();
    for (const r of filteredRows) {
      const ccy = (r.currency ?? "TRY").toUpperCase();
      const key = r.payment_id
        ? `pay:${r.payment_id}:${ccy}`
        : `name:${r.name.trim().toLocaleLowerCase("tr-TR")}:${ccy}`;
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          paymentId: r.payment_id,
          name: r.name,
          currency: ccy,
          category: r.category ?? null,
          flexibility: r.flexibility ?? null,
          rows: [],
          firstDueDate: r.due_date,
          lastDueDate: r.due_date,
        };
        map.set(key, group);
      }
      group.rows.push(r);
      if (r.due_date && (!group.firstDueDate || r.due_date < group.firstDueDate)) {
        group.firstDueDate = r.due_date;
      }
      if (r.due_date && (!group.lastDueDate || r.due_date > group.lastDueDate)) {
        group.lastDueDate = r.due_date;
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
      if (a.firstDueDate !== b.firstDueDate) return a.firstDueDate.localeCompare(b.firstDueDate);
      return a.name.localeCompare(b.name, "tr-TR");
    });
  }, [filteredRows]);

  const multiPeriodGroups = useMemo(
    () => allGroups.filter((g) => g.rows.length > 1),
    [allGroups],
  );

  const singleQuickRows = useMemo(() => {
    const singles = allGroups.filter((g) => g.rows.length === 1).map((g) => g.rows[0]);
    if (singles.length > 0) return singles;
    return filteredRows.slice(0, 3);
  }, [allGroups, filteredRows]);

  const visibleTableRows = useMemo(
    () => filteredRows.slice(0, tableLimit),
    [filteredRows, tableLimit],
  );

  function registerRowRef(id: string, el: HTMLInputElement | null) {
    if (el) rowInputRefs.current.set(id, el);
    else rowInputRefs.current.delete(id);
  }

  function registerGroupRef(key: string, el: HTMLInputElement | null) {
    if (el) groupInputRefs.current.set(key, el);
    else groupInputRefs.current.delete(key);
  }

  async function handleInlineRowSubmit(
    e: FormEvent<HTMLFormElement>,
    row: InstanceRow,
    orderedList: InstanceRow[],
    indexInList: number,
  ) {
    e.preventDefault();
    if (!canMutate) return;

    const formData = new FormData(e.currentTarget);
    const rawAmount = String(rowDrafts[row.id] ?? formData.get("amount") ?? "").trim();
    if (!rawAmount) {
      setBanner({ tone: "neg", message: "Geçerli bir tutar girin." });
      return;
    }

    const nextTarget =
      orderedList[indexInList + 1] ?? orderedList[indexInList - 1] ?? null;

    // Optimistic clear + instant focus advance to next row input
    setClearedIds((prev) => {
      const next = new Set(prev);
      next.add(row.id);
      return next;
    });
    setSavingRowIds((prev) => {
      const next = new Set(prev);
      next.add(row.id);
      return next;
    });

    if (nextTarget) {
      requestAnimationFrame(() => {
        const nextEl = rowInputRefs.current.get(nextTarget.id);
        if (nextEl) {
          nextEl.focus();
          nextEl.select();
        }
      });
    }

    try {
      const res = await inlineSetMissingAmountAction({
        instanceId: row.id,
        rawAmount,
      });
      if (!res.ok) {
        setClearedIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
        setBanner({ tone: "neg", message: `${row.name}: ${res.error}` });
        requestAnimationFrame(() => {
          rowInputRefs.current.get(row.id)?.focus();
        });
        return;
      }

      setRowDrafts((prev) => {
        const copy = { ...prev };
        delete copy[row.id];
        return copy;
      });
      setBanner({
        tone: "pos",
        message: `${row.name} (${formatShortDateTR(row.due_date)}) → ${formatMoney(res.amount, row.currency)} kaydedildi.`,
      });
    } catch {
      setClearedIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      setBanner({
        tone: "neg",
        message: `${row.name}: Sunucu bağlantısı sırasında tutar kaydedilemedi.`,
      });
    } finally {
      setSavingRowIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  }

  async function handleGroupBulkSubmit(
    e: FormEvent<HTMLFormElement>,
    group: TemplateGroup,
    groupIndex: number,
    orderedGroups: TemplateGroup[],
  ) {
    e.preventDefault();
    if (!canMutate) return;

    const rawAmount = String(groupDrafts[group.key] ?? "").trim();
    if (!rawAmount) {
      setBanner({ tone: "neg", message: `"${group.name}" için geçerli bir tutar girin.` });
      return;
    }

    const nextGroup =
      orderedGroups[groupIndex + 1] ?? orderedGroups[groupIndex - 1] ?? null;
    const optimisticIds = group.rows.map((r) => r.id);

    setClearedIds((prev) => {
      const next = new Set(prev);
      for (const id of optimisticIds) next.add(id);
      return next;
    });
    setSavingGroupKeys((prev) => {
      const next = new Set(prev);
      next.add(group.key);
      return next;
    });

    if (nextGroup) {
      requestAnimationFrame(() => {
        const nextEl = groupInputRefs.current.get(nextGroup.key);
        if (nextEl) {
          nextEl.focus();
          nextEl.select();
        }
      });
    }

    try {
      const res = group.paymentId
        ? await bulkSetTemplateMissingAmountsAction({
            paymentId: group.paymentId,
            rawAmount,
          })
        : await bulkSetInstancesByIdsAction({
            instanceIds: optimisticIds,
            rawAmount,
          });

      if (!res.ok) {
        setClearedIds((prev) => {
          const next = new Set(prev);
          for (const id of optimisticIds) next.delete(id);
          return next;
        });
        setBanner({ tone: "neg", message: `${group.name}: ${res.error}` });
        requestAnimationFrame(() => {
          groupInputRefs.current.get(group.key)?.focus();
        });
        return;
      }

      const persistedSet = new Set(res.updatedIds);
      setClearedIds((prev) => {
        const next = new Set(prev);
        for (const id of optimisticIds) {
          if (persistedSet.has(id)) next.add(id);
          else next.delete(id);
        }
        return next;
      });

      if (res.updatedCount > 0) {
        setGroupDrafts((prev) => {
          const copy = { ...prev };
          delete copy[group.key];
          return copy;
        });
      }

      if (res.skippedLockedCount > 0) {
        setBanner({
          tone: "warn",
          message: `${group.name}: ${res.updatedCount} dönem ${formatMoney(res.amount, group.currency)} olarak güncellendi; kilitli dönemdeki ${res.skippedLockedCount} kayıt atlandı.`,
        });
      } else {
        setBanner({
          tone: "pos",
          message: `${group.name}: ${res.updatedCount} açık dönem tek seferde ${formatMoney(res.amount, group.currency)} olarak tamamlandı.`,
        });
      }
    } catch {
      setClearedIds((prev) => {
        const next = new Set(prev);
        for (const id of optimisticIds) next.delete(id);
        return next;
      });
      setBanner({
        tone: "neg",
        message: `${group.name}: Toplu tutar kaydı sırasında beklenmeyen bir hata oluştu.`,
      });
    } finally {
      setSavingGroupKeys((prev) => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
    }
  }

  function renderCompactInstanceRow(
    r: InstanceRow,
    listContext: InstanceRow[],
    idx: number,
  ) {
    const ccy = r.currency ?? "TRY";
    const payable = canMutate && PAYABLE_FROM.has(r.status);
    const cancellable = canMutate && CANCELLABLE_FROM.has(r.status);
    const isSaving = savingRowIds.has(r.id);

    return (
      <div
        key={r.id}
        className="payment-instance-row row-hover grid grid-cols-1 gap-2 border-b border-line-faint px-2 py-2 lg:grid-cols-[minmax(200px,1.4fr)_110px_68px_minmax(210px,auto)_auto] lg:items-center"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {r.payment_id ? (
              <Link
                href={`/payments/${r.payment_id}/edit`}
                className="truncate text-[13px] font-medium text-tone-1 hover:underline"
              >
                {r.name}
              </Link>
            ) : (
              <span className="truncate text-[13px] font-medium text-tone-1">{r.name}</span>
            )}
            {r.category && <Badge tone="neutral">{r.category}</Badge>}
            {r.note === "short_month_adjustment" && <Badge tone="neutral">ay-sonu kırpma</Badge>}
            {r.note?.startsWith("weekly_x") && (
              <Badge tone="neutral">{r.note.replace("weekly_x", "")} hf</Badge>
            )}
            {r.linked_invoice_id && <Badge tone="blue">fatura bağlı</Badge>}
            <RiskBadges reasons={r.risk_reasons} />
          </div>
        </div>

        <div className="font-mono text-xs tabular-nums text-tone-2">
          {formatShortDateTR(r.due_date)}
        </div>

        <div>
          <Badge tone={ccy === "TRY" ? "neutral" : "blue"}>
            {normalizeCurrencyLabel(ccy)}
          </Badge>
        </div>

        <div>
          {canMutate ? (
            <form
              action={setAmountAction}
              onSubmit={(e) => void handleInlineRowSubmit(e, r, listContext, idx)}
              className="flex items-center gap-1.5"
            >
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="backTo" value="/payments/missing" />
              <input
                ref={(el) => registerRowRef(r.id, el)}
                name="amount"
                inputMode="decimal"
                required
                value={rowDrafts[r.id] ?? ""}
                onChange={(e) =>
                  setRowDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))
                }
                placeholder="tutar (Enter)"
                aria-label={`${r.name} ${r.due_date} tutarı`}
                disabled={isSaving}
                className="field-control w-32 px-2 py-1 font-mono text-xs tabular-nums sm:w-36"
              />
              <button
                type="submit"
                disabled={isSaving}
                className="button-accent shrink-0 px-2.5 py-1 text-xs"
              >
                kaydet
              </button>
            </form>
          ) : (
            <span className="font-mono text-xs text-tone-3">— (Salt okunur)</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          {payable && (
            <form action={markPaidAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="backTo" value="/payments/missing" />
              <input
                name="paidAmount"
                inputMode="decimal"
                placeholder="ödenen?"
                className="field-control w-20 px-2 py-1 font-mono text-xs tabular-nums"
              />
              <button type="submit" className="button-primary px-2 py-1 text-xs">
                ödendi
              </button>
            </form>
          )}
          {cancellable && (
            <form action={cancelInstanceAction} className="flex items-center gap-1">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="backTo" value="/payments/missing" />
              <input
                required
                name="reason"
                placeholder="iptal nedeni"
                className="field-control w-24 px-2 py-1 font-mono text-xs"
              />
              <button type="submit" className="button-ghost px-2 py-1 text-xs text-neg">
                iptal
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {/* Canlı Eritme İlerleme Çubuğu ve Mod Seçici */}
      <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tnum text-xs font-semibold text-tone-1">
              Tamamlanan: {completedCount} / Toplam: {totalCount} · Kalan Eksik Kayıt:{" "}
              {remainingCount}
            </span>
            <Badge tone={remainingCount === 0 ? "green" : completedCount > 0 ? "blue" : "amber"} dot>
              %{progressPct} tamamlandı
            </Badge>
            {!canMutate && <Badge tone="neutral">Salt-okunur yetki</Badge>}
          </div>

          {/* İki Entegre Mod — Segmented Pill Switcher */}
          <div
            role="tablist"
            aria-label="Eksik tutar eritme görünümü"
            className="inline-flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-line bg-surface-1 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "grouped"}
              onClick={() => setMode("grouped")}
              className={
                mode === "grouped"
                  ? "button-accent px-2.5 py-1 text-xs"
                  : "button-ghost border-transparent px-2.5 py-1 text-xs"
              }
            >
              Şablon Bazlı Toplu Eritme ({allGroups.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "table"}
              onClick={() => setMode("table")}
              className={
                mode === "table"
                  ? "button-accent px-2.5 py-1 text-xs"
                  : "button-ghost border-transparent px-2.5 py-1 text-xs"
              }
            >
              Klavye Hızlı Giriş Tablosu ({filteredRows.length})
            </button>
          </div>
        </div>

        {/* Görsel ilerleme çubuğu */}
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full bg-pos transition-[width] duration-150 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
          />
        </div>

        {/* Arama ve döviz filtresi */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-[220px] flex-1 items-center gap-2">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setTableLimit(INITIAL_TABLE_LIMIT);
              }}
              placeholder="Ödeme adı, kategori veya YYYY-MM vade ara..."
              aria-label="Eksik tutarlı ödemelerde ara"
              className="field-control max-w-md px-2.5 py-1.5 text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="button-ghost px-2 py-1 text-xs"
              >
                Temizle
              </button>
            )}
          </div>

          {availableCurrencies.length > 1 && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => setCurrencyFilter("ALL")}
                className={
                  currencyFilter === "ALL"
                    ? "button-primary px-2 py-1 text-xs"
                    : "button-ghost px-2 py-1 text-xs"
                }
              >
                Tümü
              </button>
              {availableCurrencies.map((ccy) => (
                <button
                  key={ccy}
                  type="button"
                  onClick={() => setCurrencyFilter(ccy)}
                  className={
                    currencyFilter === ccy
                      ? "button-primary px-2 py-1 text-xs"
                      : "button-ghost px-2 py-1 text-xs"
                  }
                >
                  {normalizeCurrencyLabel(ccy)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Anlık işlem geri bildirimi */}
      {banner && (
        <div
          role="status"
          className={`flex items-center justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs ${
            banner.tone === "pos"
              ? "border-pos tint-pos text-tone-1"
              : banner.tone === "warn"
                ? "border-warn tint-warn text-tone-1"
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

      {remainingCount === 0 ? (
        <div className="rounded-[var(--radius-md)] border border-pos tint-pos px-4 py-4 text-sm text-tone-1">
          <b className="font-semibold">
            Tüm eksik tutarlar tamamlandı ({totalCount} / {totalCount}).
          </b>{" "}
          Karar toplamları artık tüm dönemler için eksiksiz hesaplanıyor.
        </div>
      ) : filteredRows.length === 0 ? (
        <p className="py-3 text-sm text-tone-3">
          Arama kriterine uyan eksik tutarlı ödeme bulunamadı.
        </p>
      ) : mode === "grouped" ? (
        <div className="grid gap-4">
          {/* MOD 1: Şablon Bazlı Toplu Eritme */}
          {multiPeriodGroups.length > 0 && (
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-line bg-surface-1">
              <div className="border-b border-line bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-3">
                Çok Dönemli Şablonlar — Tek Tutar Girişi + Enter ile Toplu Tamamlama (
                {multiPeriodGroups.length} şablon)
              </div>

              <div className="hidden border-b border-line-faint bg-surface-2/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-3 md:grid md:grid-cols-[minmax(200px,1.5fr)_76px_minmax(190px,1fr)_minmax(280px,auto)] md:items-center md:gap-3">
                <span>Ödeme Adı</span>
                <span>Döviz</span>
                <span>Açık Dönem Aralığı</span>
                <span>Tek Tutar Girişi · Toplu Uygula</span>
              </div>

              {multiPeriodGroups.map((group, idx) => {
                const isSaving = savingGroupKeys.has(group.key);
                return (
                  <div
                    key={group.key}
                    className="row-hover grid grid-cols-1 gap-2 border-b border-line-faint px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(200px,1.5fr)_76px_minmax(190px,1fr)_minmax(280px,auto)] md:items-center md:gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {group.paymentId ? (
                          <Link
                            href={`/payments/${group.paymentId}/edit`}
                            className="truncate text-sm font-semibold text-tone-1 hover:underline"
                          >
                            {group.name}
                          </Link>
                        ) : (
                          <span className="truncate text-sm font-semibold text-tone-1">
                            {group.name}
                          </span>
                        )}
                        {group.category && <Badge tone="neutral">{group.category}</Badge>}
                        {group.flexibility === "critical" && <Badge tone="red">kritik</Badge>}
                      </div>
                    </div>

                    <div>
                      <Badge tone={group.currency === "TRY" ? "neutral" : "blue"}>
                        {normalizeCurrencyLabel(group.currency)}
                      </Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-tone-2">
                      <Badge tone="amber">{group.rows.length} Açık Dönem</Badge>
                      <span className="font-mono text-[11px] tabular-nums text-tone-3">
                        {formatShortDateTR(group.firstDueDate)} →{" "}
                        {formatShortDateTR(group.lastDueDate)}
                      </span>
                    </div>

                    <div>
                      {canMutate ? (
                        <form
                          onSubmit={(e) =>
                            void handleGroupBulkSubmit(e, group, idx, multiPeriodGroups)
                          }
                          className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap"
                        >
                          <input
                            ref={(el) => registerGroupRef(group.key, el)}
                            type="text"
                            inputMode="decimal"
                            value={groupDrafts[group.key] ?? ""}
                            onChange={(e) =>
                              setGroupDrafts((prev) => ({
                                ...prev,
                                [group.key]: e.target.value,
                              }))
                            }
                            placeholder={`Örn: 45.000 (${normalizeCurrencyLabel(group.currency)})`}
                            aria-label={`${group.name} şablonu için dönem tutarı`}
                            disabled={isSaving}
                            className="field-control w-36 px-2.5 py-1.5 font-mono text-xs tabular-nums sm:w-40"
                          />
                          <button
                            type="submit"
                            disabled={isSaving}
                            className="button-accent shrink-0 px-3 py-1.5 text-xs"
                          >
                            {isSaving
                              ? "Uygulanıyor..."
                              : `${group.rows.length} Döneme Uygula`}
                          </button>
                        </form>
                      ) : (
                        <span className="text-xs text-tone-3">Yetki gerekli</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Tek dönemlik kalemler veya en yakın vadeli hızlı tekil satırlar */}
          {singleQuickRows.length > 0 && (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface-1">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-3">
                  {allGroups.some((g) => g.rows.length === 1)
                    ? `Tek Dönemlik Eksik Kayıtlar (${singleQuickRows.length})`
                    : `En Yakın Vadeli Hızlı Tekil İşlem (${singleQuickRows.length})`}
                </span>
                {filteredRows.length > singleQuickRows.length && (
                  <button
                    type="button"
                    onClick={() => setMode("table")}
                    className="button-ghost px-2 py-0.5 text-[11px]"
                  >
                    Tüm {filteredRows.length} satırı klavye tablosunda aç →
                  </button>
                )}
              </div>
              <div>
                {singleQuickRows.map((r, idx) =>
                  renderCompactInstanceRow(r, singleQuickRows, idx),
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* MOD 2: Klavye Hızlı Giriş Tablosu (Tab / Enter) */
        <div className="rounded-[var(--radius-md)] border border-line bg-surface-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-3">
              Klavye Hızlı Giriş Tablosu — Tutar Yazıp Enter&apos;a Basınca Kaydeder ve Alt Satıra
              Geçer
            </span>
            <span className="tnum text-xs text-tone-3">
              Gösterilen: {visibleTableRows.length} / {filteredRows.length}
            </span>
          </div>

          <div className="hidden border-b border-line-faint bg-surface-2/60 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-tone-3 lg:grid lg:grid-cols-[minmax(200px,1.4fr)_110px_68px_minmax(210px,auto)_auto] lg:items-center lg:gap-2">
            <span>Ödeme Adı</span>
            <span>Vade Tarihi</span>
            <span>Döviz</span>
            <span>Tutar Girişi (Enter)</span>
            <span className="text-right">Hızlı Durum / İptal</span>
          </div>

          <div>
            {visibleTableRows.map((r, idx) =>
              renderCompactInstanceRow(r, visibleTableRows, idx),
            )}
          </div>

          {filteredRows.length > visibleTableRows.length && (
            <div className="flex items-center justify-center border-t border-line-faint bg-surface-2/40 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setTableLimit((prev) => prev + 100)}
                className="button-ghost px-3 py-1.5 text-xs"
              >
                Daha Fazla Göster (+{filteredRows.length - visibleTableRows.length} kayıt)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
