"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpRight, CheckCircle2, Lock, Sparkles } from "lucide-react";
import {
  batchSaveOpeningBalancesAction,
  listMissingOpeningAccountsAction,
  type MissingOpeningAccountItem,
} from "@/app/(dashboard)/fin03-quick-actions";
import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { SlideOverDrawer } from "@/components/ui/slide-over-drawer";
import type { CashAccountDbType } from "@/lib/treasury/engine";

const ACCOUNT_KIND_LABELS: Record<CashAccountDbType, string> = {
  cash: "Kasa · 100",
  bank_account: "Banka · 102",
  credit_card: "KMH / Kart · 102",
  loan: "Kredi · 102",
  check_account: "Çek Hesabı · 102",
  other: "Diğer · 102",
  unknown: "Banka / Kasa · 102",
};

interface DraftEntry {
  openingBalance: string;
  openingBalanceDate: string;
}

export interface Fin03OpeningDrawerProps {
  unknownCount: number;
  canMutate: boolean;
}

export function Fin03OpeningDrawer({ unknownCount, canMutate }: Fin03OpeningDrawerProps) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<MissingOpeningAccountItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const balanceInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const loadMissingAccounts = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const rows = await listMissingOpeningAccountsAction();
      setAccounts(rows);
      const initialDrafts: Record<string, DraftEntry> = {};
      for (const row of rows) {
        initialDrafts[row.id] = {
          openingBalance: "",
          openingBalanceDate: row.defaultDate,
        };
      }
      setDrafts(initialDrafts);
    } catch {
      setErrorMessage("Eksik açılışlı hesaplar yüklenemedi. Lütfen tekrar deneyin.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setOpen(nextOpen);
      if (nextOpen) {
        setSuccessMessage(null);
        setErrorMessage(null);
        void loadMissingAccounts();
      }
    },
    [loadMissingAccounts],
  );

  // Auto-focus Row 1's Açılış Bakiyesi input as soon as accounts finish loading
  useEffect(() => {
    if (!open || isLoading || accounts.length === 0 || !canMutate) return;
    const rafId = requestAnimationFrame(() => {
      const firstInput = balanceInputRefs.current[0];
      if (firstInput) {
        firstInput.focus();
        firstInput.select();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [open, isLoading, accounts.length, canMutate]);

  const filledCount = accounts.reduce((acc, row) => {
    const val = drafts[row.id]?.openingBalance ?? "";
    return val.trim() !== "" ? acc + 1 : acc;
  }, 0);

  const updateDraft = (accountId: string, patch: Partial<DraftEntry>) => {
    setErrorMessage(null);
    setDrafts((prev) => {
      const existing = prev[accountId] ?? { openingBalance: "", openingBalanceDate: "" };
      return {
        ...prev,
        [accountId]: { ...existing, ...patch },
      };
    });
  };

  const handleBalanceKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      const next = balanceInputRefs.current[index + 1];
      if (next) {
        e.preventDefault();
        next.focus();
        next.select();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      const prev = balanceInputRefs.current[index - 1];
      if (prev) {
        e.preventDefault();
        prev.focus();
        prev.select();
      }
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && index < accounts.length - 1) {
      const next = balanceInputRefs.current[index + 1];
      if (next) {
        e.preventDefault();
        next.focus();
        next.select();
      }
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canMutate || isPending) return;

    const payload = accounts.map((acc) => ({
      cashAccountId: acc.id,
      openingBalance: drafts[acc.id]?.openingBalance ?? "",
      openingBalanceDate: drafts[acc.id]?.openingBalanceDate ?? acc.defaultDate,
    }));

    const hasAnyValue = payload.some((entry) => entry.openingBalance.trim() !== "");
    if (!hasAnyValue) {
      setErrorMessage(
        "Kaydedilecek en az bir açılış bakiyesi girin. Boş bıraktığınız hesaplar değişmez (0 sayılmaz).",
      );
      balanceInputRefs.current[0]?.focus();
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);

    startTransition(async () => {
      const res = await batchSaveOpeningBalancesAction(payload);
      if (!res.ok) {
        setErrorMessage(res.error);
        return;
      }

      setSuccessMessage(
        `${res.savedCount} hesap açılış bakiyesi kaydedildi — kasa ve 13H projeksiyon güncelleniyor…`,
      );
      router.refresh();
      closeTimerRef.current = setTimeout(() => {
        setOpen(false);
        setSuccessMessage(null);
      }, 650);
    });
  };

  const badgeCount = accounts.length > 0 && open ? accounts.length : unknownCount;

  return (
    <SlideOverDrawer
      open={open}
      onOpenChange={handleOpenChange}
      widthClass="w-[min(640px,95vw)]"
      eyebrow="FIN-03 · HIZLI AÇILIŞ BAKİYESİ MASASI"
      badge={<Badge tone="amber">{badgeCount} Hesap Bekliyor</Badge>}
      title="Açılış Bakiyelerini Tek Seferde Tamamla"
      subtitle="Ana Ekran'dan ayrılmadan Serbest Kasa, 13H Dip Nakit ve Senaryo Başabaş motorlarının kilidini açın."
      trigger={
        <button
          type="button"
          data-testid="fin03-quick-drawer-trigger"
          className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-semibold text-warn underline underline-offset-2 transition-opacity hover:opacity-80"
        >
          Açılış Gir ({unknownCount} Hesap) →
        </button>
      }
      footer={
        <>
          <Link
            href="/finance/bank"
            onClick={() => setOpen(false)}
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent-tone hover:underline"
          >
            Tam Banka Masasını Aç →
          </Link>
          <button
            type="submit"
            form={formId}
            disabled={!canMutate || isPending}
            className="button-primary px-3.5 py-2 text-[12px] disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Sparkles size={13} strokeWidth={1.85} aria-hidden />
            <span>Girilen Bakiyeleri 500.99 Defterine Kaydet</span>
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        {/* R10 Policy & Keyboard Hint Box */}
        <div
          className="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[12px] leading-snug"
          style={{
            borderColor: "var(--info-border)",
            background: "var(--info-bg)",
            color: "var(--text-2)",
          }}
        >
          <p className="max-w-[56ch]">
            Boş bıraktığınız hesaplar değişmez (0 sayılmaz). Girilen bakiyeler otomatik olarak TDHP
            500.99 Açılış Defteri fişiyle mühürlenir.
          </p>
          {accounts.length > 0 && (
            <span className="font-mono text-[11px] font-semibold tabular-nums text-info">
              {filledCount}/{accounts.length} dolu
            </span>
          )}
        </div>

        {/* Read-only RBAC Notice */}
        {!canMutate && (
          <div
            role="note"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[12px] leading-snug"
            style={{
              borderColor: "var(--warn-border)",
              background: "var(--warn-bg)",
              color: "var(--warn)",
            }}
          >
            <Lock size={14} strokeWidth={1.9} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <strong className="font-semibold">Salt okunur görünüm:</strong> Açılış bakiyesi
              kaydetmek için <code className="font-mono text-[11px]">finance_operator</code> /{" "}
              <code className="font-mono text-[11px]">finance_manager</code> /{" "}
              <code className="font-mono text-[11px]">admin</code> yetkisi gereklidir.
            </div>
          </div>
        )}

        {/* Crisp Emerald Confirmation Banner */}
        {successMessage && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[12.5px] font-semibold"
            style={{
              borderColor: "var(--pos-border)",
              background: "var(--pos-bg)",
              color: "var(--pos)",
            }}
          >
            <CheckCircle2 size={15} strokeWidth={2} className="shrink-0" aria-hidden />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Error Banner */}
        {errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2.5 text-[12px] font-medium"
            style={{
              borderColor: "var(--neg-border)",
              background: "var(--neg-bg)",
              color: "var(--neg)",
            }}
          >
            <AlertCircle size={14} strokeWidth={1.9} className="mt-0.5 shrink-0" aria-hidden />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Body: Loading Skeleton / Empty State / Fast Keyboard Table */}
        <form id={formId} onSubmit={handleSubmit} noValidate>
          {isLoading ? (
            <div className="skeleton-table" aria-label="Eksik açılışlı hesaplar yükleniyor">
              <i />
              <i />
              <i />
              <i />
            </div>
          ) : accounts.length === 0 ? (
            <div className="rounded-[var(--radius-md)] border border-line bg-surface-2 px-4 py-6 text-center">
              <CheckCircle2
                size={22}
                strokeWidth={1.85}
                className="mx-auto mb-1.5"
                style={{ color: "var(--pos)" }}
                aria-hidden
              />
              <p className="text-[13.5px] font-semibold text-tone-1">
                Açılış bakiyesi bekleyen aktif hesap kalmadı.
              </p>
              <p className="mt-1 text-[12px] text-tone-3">
                Yeni kasa/banka hesabı eklemek veya mevcut açılışları revize etmek için Banka
                Merkezi&apos;ni kullanabilirsiniz.
              </p>
              <Link
                href="/finance/bank"
                onClick={() => setOpen(false)}
                className="button-ghost mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-[12px]"
              >
                Banka Masasına Git
                <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[var(--radius-md)] border border-line bg-surface-1">
              <table className="data-table w-full text-left">
                <thead>
                  <tr>
                    <th>Hesap Adı &amp; Tür</th>
                    <th className="w-[68px] text-center">Döviz</th>
                    <th className="w-[144px]">Açılış Tarihi</th>
                    <th className="w-[172px] text-right">Açılış Bakiyesi</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc, index) => {
                    const draft = drafts[acc.id] ?? {
                      openingBalance: "",
                      openingBalanceDate: acc.defaultDate,
                    };
                    const kindLabel = ACCOUNT_KIND_LABELS[acc.kind] ?? ACCOUNT_KIND_LABELS.unknown;

                    return (
                      <tr key={acc.id}>
                        <td>
                          <div className="font-semibold leading-snug text-tone-1">{acc.name}</div>
                          <div className="mt-0.5 font-mono text-[10.5px] text-tone-3">
                            {kindLabel}
                          </div>
                        </td>
                        <td className="text-center">
                          <Badge tone={acc.currency === "TRY" ? "green" : "blue"}>
                            {acc.currency}
                          </Badge>
                        </td>
                        <td>
                          <input
                            type="date"
                            value={draft.openingBalanceDate}
                            disabled={!canMutate || isPending || Boolean(successMessage)}
                            onChange={(ev) =>
                              updateDraft(acc.id, { openingBalanceDate: ev.target.value })
                            }
                            aria-label={`${acc.name} açılış tarihi`}
                            className="field-control px-2 py-1.5 font-mono text-[12px] tabular-nums disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </td>
                        <td>
                          <input
                            ref={(el) => {
                              balanceInputRefs.current[index] = el;
                            }}
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="Boş = değişmez"
                            value={draft.openingBalance}
                            disabled={!canMutate || isPending || Boolean(successMessage)}
                            onChange={(ev) =>
                              updateDraft(acc.id, { openingBalance: ev.target.value })
                            }
                            onKeyDown={(ev) => handleBalanceKeyDown(index, ev)}
                            aria-label={`${acc.name} (${acc.currency}) açılış bakiyesi`}
                            className="field-control px-2.5 py-1.5 text-right font-mono text-[12.5px] font-semibold tabular-nums disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </form>

        {accounts.length > 0 && canMutate && (
          <p className="text-[11px] text-tone-3">
            İpucu: <kbd className="font-mono">Enter</kbd> veya <kbd className="font-mono">↓</kbd>{" "}
            ile bir alt hesaba hızla inebilir, son satırda <kbd className="font-mono">Enter</kbd>{" "}
            ile tüm girilen bakiyeleri tek seferde kaydedebilirsiniz.
          </p>
        )}
      </div>
    </SlideOverDrawer>
  );
}
