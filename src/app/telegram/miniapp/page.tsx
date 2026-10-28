"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import type { MiniAppSnapshot, MiniAppPayment, MiniAppMaturity } from "@/lib/telegram/miniapp";

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        close: () => void;
        initDataUnsafe?: {
          user?: TelegramUser;
        };
        HapticFeedback?: {
          impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
          notificationOccurred: (type: "error" | "success" | "warning") => void;
        };
        themeParams?: Record<string, string>;
      };
    };
  }
}

function triggerHaptic(type: "impact" | "success" | "warning" = "impact") {
  if (typeof window !== "undefined") {
    if (window.Telegram?.WebApp?.HapticFeedback) {
      if (type === "success") {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred("success");
      } else if (type === "warning") {
        window.Telegram.WebApp.HapticFeedback.notificationOccurred("warning");
      } else {
        window.Telegram.WebApp.HapticFeedback.impactOccurred("medium");
      }
    } else if ("vibrate" in navigator) {
      navigator.vibrate(type === "success" ? [20, 30, 20] : 15);
    }
  }
}

export default function TelegramMiniAppPage() {
  const [snapshot, setSnapshot] = useState<MiniAppSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"payments" | "banks" | "cfo">("payments");
  const [tgUser, setTgUser] = useState<TelegramUser | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [cfoMessages, setCfoMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([
    {
      role: "assistant",
      text: "Merhaba! Ben MAS Nakit Radar Mobil Danışmanınız. Kasa durumunuz, yaklaşan çekler ve acil ödemeler hakkında hızlıca soru sorabilirsiniz.",
    },
  ]);
  const [cfoInput, setCfoInput] = useState("");
  const [cfoLoading, setCfoLoading] = useState(false);
  const [, startTransition] = useTransition();

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  const fetchSnapshot = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/telegram/miniapp", {
        headers: { "x-telegram-init-data": "webapp" },
      });
      if (!res.ok) {
        throw new Error(`Veri yüklenemedi: HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.ok && data.snapshot) {
        setSnapshot(data.snapshot);
      } else {
        throw new Error(data.error?.message || "Geçersiz veri yapısı");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sunucuya bağlanılamadı");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 1. Initialize Telegram WebApp
    if (typeof window !== "undefined" && window.Telegram?.WebApp) {
      try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        if (window.Telegram.WebApp.initDataUnsafe?.user) {
          setTgUser(window.Telegram.WebApp.initDataUnsafe.user);
        }
      } catch (e) {
        console.warn("[TMA] Telegram SDK init warning:", e);
      }
    }

    // 2. Fetch live snapshot
    fetchSnapshot();
  }, []);

  const handleMarkPaid = async (item: MiniAppPayment | MiniAppMaturity) => {
    triggerHaptic("impact");
    setActionInProgress(item.id);

    try {
      const isCheck = "kind" in item && item.kind === "check";
      const action = isCheck ? "clear_check" : "mark_paid";
      const res = await fetch("/api/telegram/miniapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          targetId: item.id,
          amount: item.amount,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message || "İşlem kaydedilemedi");
      }

      triggerHaptic("success");
      showToast(isCheck ? "Çek ödendi olarak işaretlendi" : "Ödeme onaylandı");

      // Optimistic state update
      startTransition(() => {
        setSnapshot((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            urgentPayments: prev.urgentPayments.filter((p) => p.id !== item.id),
            urgentMaturities: prev.urgentMaturities.filter((m) => m.id !== item.id),
            next7DaysOutflow: Math.max(0, prev.next7DaysOutflow - (item.amount ?? 0)),
          };
        });
      });
    } catch (err: unknown) {
      triggerHaptic("warning");
      showToast(err instanceof Error ? err.message : "İşlem başarısız");
    } finally {
      setActionInProgress(null);
    }
  };

  const handleAskCfo = async (question: string) => {
    if (!question.trim() || cfoLoading) return;
    triggerHaptic("impact");
    setCfoMessages((prev) => [...prev, { role: "user", text: question }]);
    setCfoInput("");
    setCfoLoading(true);

    try {
      const res = await fetch("/api/ai/cfo-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          pathname: "/telegram/miniapp",
        }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setCfoMessages((prev) => [
          ...prev,
          { role: "assistant", text: data.reply },
        ]);
        triggerHaptic("success");
      } else {
        throw new Error(data.error?.message || "Cevap alınamadı");
      }
    } catch (e: unknown) {
      // Fallback deterministic reply from snapshot data
      const fallback =
        question.includes("açık") || question.includes("risk")
          ? `Nakit Radar Durumu: Net Kasa ₺${Math.round(snapshot?.netKasa ?? 0).toLocaleString("tr-TR")}. 7 günlük çıkış ₺${Math.round(snapshot?.next7DaysOutflow ?? 0).toLocaleString("tr-TR")}. ${snapshot?.runway.statusText}.`
          : `Bu hafta bekleyen ${snapshot?.next7DaysCount ?? 0} adet ödeme ve toplam ₺${Math.round(snapshot?.next7DaysOutflow ?? 0).toLocaleString("tr-TR")} tutarında çıkış bulunmaktadır.`;

      setCfoMessages((prev) => [
        ...prev,
        { role: "assistant", text: fallback },
      ]);
    } finally {
      setCfoLoading(false);
    }
  };

  return (
    <div className="flex flex-col flex-1 px-4 pt-3 space-y-4">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-3 left-4 right-4 z-50 animate-bounce rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-2.5 text-center text-xs font-semibold text-white shadow-xl">
          ✓ {toastMessage}
        </div>
      )}

      {/* Top Header */}
      <header className="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10 border border-sky-400/20 text-sky-400">
            <Image src="/icon.svg" alt="MAS Radar" width={22} height={22} className="drop-shadow" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold tracking-tight text-white">MAS Radar</span>
              <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-400">
                CANLI
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              {tgUser ? `Hoş geldiniz, ${tgUser.first_name}` : "Mobil Kasa Kokpiti"}
            </p>
          </div>
        </div>

        <button
          onClick={() => {
            triggerHaptic("impact");
            fetchSnapshot();
          }}
          disabled={loading}
          aria-label="Yenile"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 bg-slate-900/80 text-slate-400 hover:text-white active:scale-90 transition"
        >
          <svg
            className={`w-4 h-4 ${loading ? "animate-spin text-sky-400" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </header>

      {/* Loading Skeleton */}
      {loading && !snapshot && (
        <div className="space-y-3 animate-pulse">
          <div className="h-28 rounded-2xl bg-slate-900/60 border border-slate-800" />
          <div className="grid grid-cols-2 gap-2">
            <div className="h-20 rounded-xl bg-slate-900/60 border border-slate-800" />
            <div className="h-20 rounded-xl bg-slate-900/60 border border-slate-800" />
          </div>
          <div className="h-48 rounded-2xl bg-slate-900/60 border border-slate-800" />
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-950/40 p-3 text-xs text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={fetchSnapshot}
            className="rounded bg-red-800/60 px-2 py-1 text-[11px] font-medium text-white"
          >
            Tekrar Dene
          </button>
        </div>
      )}

      {/* Main Content */}
      {snapshot && (
        <>
          {/* Hero Metric Card: Net Kasa */}
          <div className="relative overflow-hidden rounded-2xl border border-sky-500/30 bg-gradient-to-br from-slate-900 via-slate-950 to-sky-950/40 p-4 shadow-xl shadow-sky-950/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-sky-400 uppercase">
                Toplam Likit Kasa
              </span>
              <span className="text-[11px] text-slate-400">{snapshot.bankAccounts.length} Hesap</span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="text-3xl font-extrabold tracking-tight text-white">
                ₺{Math.round(snapshot.netKasa).toLocaleString("tr-TR")}
              </span>
            </div>
            <p className="mt-2 text-xs text-slate-400 flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              {snapshot.runway.statusText}
            </p>
          </div>

          {/* Quick 2-Column KPI Cards */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* 7-Day Outflow */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <span className="text-[11px] font-medium text-amber-400">7 Günlük Çıkış</span>
              <p className="mt-1 text-lg font-bold text-slate-100">
                ₺{Math.round(snapshot.next7DaysOutflow).toLocaleString("tr-TR")}
              </p>
              <span className="text-[10px] text-slate-400">
                {snapshot.next7DaysCount} bekleyen ödeme
              </span>
            </div>

            {/* Overdue Items */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <span className="text-[11px] font-medium text-rose-400">Geciken Kalem</span>
              <p className="mt-1 text-lg font-bold text-slate-100">
                ₺{Math.round(snapshot.overdueTotal).toLocaleString("tr-TR")}
              </p>
              <span className="text-[10px] text-slate-400">
                {snapshot.overdueCount} gecikmiş borç
              </span>
            </div>
          </div>

          {/* CFO AI Highlights Alert */}
          {snapshot.cfoHighlights.length > 0 && (
            <div className="rounded-xl border border-sky-500/20 bg-sky-950/20 p-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <span>🤖</span>
                <span>{snapshot.cfoHighlights[0].title}</span>
              </div>
              <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                {snapshot.cfoHighlights[0].detail}
              </p>
            </div>
          )}

          {/* Navigation Segment Tabs */}
          <div className="flex rounded-xl bg-slate-900 p-1 border border-slate-800 text-xs font-medium">
            <button
              onClick={() => {
                triggerHaptic("impact");
                setActiveTab("payments");
              }}
              className={`flex-1 py-1.5 text-center rounded-lg transition-all ${
                activeTab === "payments"
                  ? "bg-sky-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Ödemeler ({snapshot.urgentPayments.length})
            </button>
            <button
              onClick={() => {
                triggerHaptic("impact");
                setActiveTab("banks");
              }}
              className={`flex-1 py-1.5 text-center rounded-lg transition-all ${
                activeTab === "banks"
                  ? "bg-sky-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Bankalar ({snapshot.bankAccounts.length})
            </button>
            <button
              onClick={() => {
                triggerHaptic("impact");
                setActiveTab("cfo");
              }}
              className={`flex-1 py-1.5 text-center rounded-lg transition-all ${
                activeTab === "cfo"
                  ? "bg-sky-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              CFO AI
            </button>
          </div>

          {/* Tab 1: Payments & Checks List */}
          {activeTab === "payments" && (
            <div className="space-y-2.5">
              {/* Upcoming Checks Subheader if available */}
              {snapshot.urgentMaturities.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Vadesi Gelen Çekler (14 Gün)
                  </span>
                  {snapshot.urgentMaturities.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-950/10 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-bold text-amber-300">
                            ÇEK
                          </span>
                          <p className="truncate text-xs font-semibold text-slate-100">
                            {item.label}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-400">
                          Vade: {item.dueDate}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-100">
                          ₺{Math.round(item.amount ?? 0).toLocaleString("tr-TR")}
                        </span>
                        <button
                          onClick={() => handleMarkPaid(item)}
                          disabled={actionInProgress === item.id}
                          className="rounded-lg bg-emerald-600/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 active:scale-95 transition"
                        >
                          {actionInProgress === item.id ? "..." : "Tahsil"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Payments List */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Acil & Bekleyen Ödemeler
                </span>
                {snapshot.urgentPayments.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-400">
                    Bekleyen veya geciken acil ödeme bulunmuyor.
                  </div>
                ) : (
                  snapshot.urgentPayments.map((p) => {
                    const isLate = p.status === "late";
                    return (
                      <div
                        key={p.id}
                        className={`flex items-center justify-between rounded-xl border p-3 transition-all ${
                          isLate
                            ? "border-rose-500/30 bg-rose-950/20"
                            : "border-slate-800 bg-slate-900/60"
                        }`}
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="flex items-center gap-1.5">
                            {isLate && (
                              <span className="rounded bg-rose-500/20 px-1 py-0.5 text-[9px] font-bold text-rose-400">
                                GECİKMİŞ
                              </span>
                            )}
                            <p className="truncate text-xs font-semibold text-slate-100">
                              {p.name}
                            </p>
                          </div>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            Vade: {p.dueDate}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-100">
                            ₺{Math.round(p.amount ?? 0).toLocaleString("tr-TR")}
                          </span>
                          <button
                            onClick={() => handleMarkPaid(p)}
                            disabled={actionInProgress === p.id}
                            className="rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500 active:scale-95 transition"
                          >
                            {actionInProgress === p.id ? "..." : "Ödendi"}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Bank Accounts List */}
          {activeTab === "banks" && (
            <div className="space-y-2">
              <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Banka Hesap Bakiyeleri
              </span>
              {snapshot.bankAccounts.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-400">
                  Kayıtlı aktif banka hesabı bulunmuyor.
                </div>
              ) : (
                snapshot.bankAccounts.map((b) => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-slate-100">{b.name}</p>
                      {b.iban && (
                        <p className="text-[10px] text-slate-400 font-mono truncate">{b.iban}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-bold text-emerald-400">
                        ₺{Math.round(b.balance).toLocaleString("tr-TR")}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Tab 3: Mobile CFO Copilot Chat */}
          {activeTab === "cfo" && (
            <div className="flex flex-col space-y-3">
              {/* Quick Prompt Chips */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Nakit açığı var mı?",
                  "En acil ödeme hangisi?",
                  "Bu haftaki çekler karşılanabilir mi?",
                ].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => handleAskCfo(chip)}
                    className="rounded-full border border-sky-500/30 bg-sky-950/30 px-2.5 py-1 text-[11px] text-sky-300 hover:bg-sky-900/50 active:scale-95 transition"
                  >
                    {chip}
                  </button>
                ))}
              </div>

              {/* Chat Message Stream */}
              <div className="max-h-60 overflow-y-auto space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                {cfoMessages.map((m, idx) => (
                  <div
                    key={idx}
                    className={`flex flex-col text-xs ${
                      m.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-xl px-3 py-2 leading-relaxed ${
                        m.role === "user"
                          ? "bg-sky-600 text-white rounded-br-none"
                          : "bg-slate-800 text-slate-200 border border-slate-700/60 rounded-bl-none"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
                {cfoLoading && (
                  <div className="flex items-center gap-1.5 text-xs text-sky-400">
                    <span className="animate-pulse">●</span>
                    <span className="animate-pulse animation-delay-200">●</span>
                    <span className="animate-pulse animation-delay-400">●</span>
                    <span className="text-[11px] text-slate-400">CFO yanıtlıyor...</span>
                  </div>
                )}
              </div>

              {/* Input Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAskCfo(cfoInput);
                }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={cfoInput}
                  onChange={(e) => setCfoInput(e.target.value)}
                  placeholder="Finansal soru sorun..."
                  className="flex-1 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!cfoInput.trim() || cfoLoading}
                  className="rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 hover:bg-sky-500 active:scale-95 transition"
                >
                  Gönder
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {/* Footer Navigation Back to Desktop Dashboard */}
      <footer className="pt-4 border-t border-slate-800/80 text-center">
        <a
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-sky-400 transition"
        >
          <span>← Masaüstü MAS Radar Paneline Geç</span>
        </a>
      </footer>
    </div>
  );
}
