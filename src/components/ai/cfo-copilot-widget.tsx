"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  suggestedActions?: Array<{ label: string; href: string }>;
  relevantFacts?: Array<{ title: string; value: string; severity: string }>;
  timestamp: string;
}

export function CfoCopilotWidget() {
  const pathname = usePathname();
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [forceDeterministic, setForceDeterministic] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Merhaba! Ben **MAS Baş Finans Danışmanı (CFO AI)**.\n\nCanlı 35 aylık nakit projeksiyonunuz, banka çek/kredi vadeleriniz ve fabrika tezgâh başabaş maliyetleriniz sistemimde günceldir.\n\nNakit durumunuz veya stratejik kararlarınızla ilgili bana dilediğinizi sorabilirsiniz.",
      suggestedActions: [
        { label: "Günün Ödemeleri", href: "/payments" },
        { label: "35 Aylık Nakit Akışı", href: "/cashflow" },
        { label: "Çek Defteri", href: "/finance/checks" },
      ],
      timestamp: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, messages]);

  // Dinamik sayfa bazlı hızlı soru önerileri
  const getQuickPrompts = () => {
    const p = pathname?.toLowerCase() || "";
    if (p.includes("/production")) {
      return [
        "Hangi tezgahımız başabaş maliyetin altında kalıyor?",
        "Akon torna ve freze fiyat marjları nasıl?",
        "Kapasite darboğazı olan makineler hangileri?",
      ];
    }
    if (p.includes("/finance") || p.includes("/financing")) {
      return [
        "Önümüzdeki 30 günde hangi çeklerin vadesi geliyor?",
        "Bankalardaki kredi ve limit riskimiz nedir?",
        "Tahsilatında gecikme riski olan vadeler hangileri?",
      ];
    }
    if (p.includes("/cashflow")) {
      return [
        "Kasa ne zaman negatife düşüyor, ilk açık ayı hangisi?",
        "En yüksek müşteri yoğunlaşması hangi firmada?",
        "Aylık borç servisi baskısı ne kadar?",
      ];
    }
    return [
      "Bugün acil dikkat etmem gereken nakit riski nedir?",
      "Önümüzdeki 7 günde toplam ne kadar nakit çıkışı var?",
      "35 aylık nakit akışında en kritik açık hangi ayda?",
    ];
  };

  const handleSendMessage = (textToSend?: string) => {
    const text = (textToSend || inputMessage).trim();
    if (!text || isPending) return;

    const userMsg: Message = {
      id: "u-" + Date.now(),
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMessage("");

    startTransition(async () => {
      try {
        const historyPayload = messages.slice(-4).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const res = await fetch("/api/ai/cfo-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            history: historyPayload,
            currentPath: pathname,
            forceDeterministic,
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const assistantMsg: Message = {
          id: "a-" + Date.now(),
          role: "assistant",
          content: data.answerMd || "Cevap üretilemedi.",
          suggestedActions: data.suggestedActions,
          relevantFacts: data.relevantFacts,
          timestamp: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
        };

        setMessages((prev) => [...prev, assistantMsg]);
      } catch {
        const errorMsg: Message = {
          id: "err-" + Date.now(),
          role: "assistant",
          content:
            "⚠️ Sunucu bağlantısında geçici bir gecikme yaşandı. Ancak sisteminiz güvenlidir. Lütfen sorunuzu tekrar deneyiniz.",
          timestamp: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleNavigate = (href: string) => {
    router.push(href);
  };

  return (
    <>
      {/* 1. Yüzen Başlatma Butonu (Floating Widget Button) */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-full border border-sky-400/40 bg-slate-950/90 px-4 py-3 text-sm font-semibold text-slate-100 shadow-2xl backdrop-blur-xl transition-all duration-300 hover:scale-105 hover:border-sky-400 hover:shadow-sky-500/20 active:scale-95"
          style={{
            boxShadow: "0 8px 32px -4px rgba(14, 165, 233, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15)",
          }}
          aria-label="CFO AI Danışmanını Aç"
        >
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-sky-500" />
          </span>
          <span className="text-base">✨</span>
          <span className="bg-gradient-to-r from-sky-200 via-white to-sky-300 bg-clip-text font-bold tracking-tight text-transparent">
            CFO AI Danışmanı
          </span>
        </button>
      )}

      {/* 2. Açılır Sohbet Paneli (Drawer / Modal) */}
      {isOpen && (
        <div
          className={`fixed z-50 flex flex-col rounded-2xl border border-slate-700/60 bg-slate-950/95 shadow-2xl backdrop-blur-2xl transition-all duration-300 ${
            isExpanded
              ? "bottom-4 right-4 top-4 w-[92vw] max-w-2xl sm:bottom-6 sm:right-6 sm:top-6"
              : "bottom-4 right-4 h-[580px] w-[92vw] max-w-md sm:bottom-6 sm:right-6 sm:w-[420px]"
          }`}
          style={{
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 40px -5px rgba(14, 165, 233, 0.25)",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 ring-1 ring-sky-500/30">
                ✨
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-100">MAS CFO Copilot</h3>
                  <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                    Canlı
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">Karar & Strateji Danışmanı</p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                title={isExpanded ? "Küçült" : "Genişlet"}
              >
                {isExpanded ? "↙" : "↗"}
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                title="Kapat"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs leading-relaxed text-slate-200">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 shadow-sm ${
                    m.role === "user"
                      ? "rounded-tr-none bg-sky-600 text-white"
                      : "rounded-tl-none border border-slate-800 bg-slate-900/90 text-slate-200"
                  }`}
                >
                  <div className="whitespace-pre-wrap font-sans">{m.content}</div>

                  {/* Önerilen Aksiyon Butonları */}
                  {m.suggestedActions && m.suggestedActions.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-slate-800/80 pt-2">
                      {m.suggestedActions.map((action) => (
                        <button
                          key={action.href}
                          onClick={() => handleNavigate(action.href)}
                          className="flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-300 transition-colors hover:bg-sky-500/20 active:bg-sky-500/30"
                        >
                          <span>{action.label}</span>
                          <span className="text-[10px]">→</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div
                    className={`mt-1.5 text-right text-[10px] ${
                      m.role === "user" ? "text-sky-200/70" : "text-slate-500"
                    }`}
                  >
                    {m.timestamp}
                  </div>
                </div>
              </div>
            ))}

            {isPending && (
              <div className="flex items-center gap-2 text-slate-400">
                <div className="flex space-x-1">
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:0.2s]" />
                  <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:0.4s]" />
                </div>
                <span className="text-[11px]">CFO finans verilerini analiz ediyor...</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompts Bar */}
          <div className="border-t border-slate-800/70 bg-slate-900/40 p-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
              <span className="flex items-center gap-1">
                <span>📍</span>
                <span className="font-medium text-slate-300">
                  {pathname === "/production"
                    ? "Üretim Ekranı Önerileri"
                    : pathname === "/finance" || pathname === "/finance/checks"
                    ? "Finansman & Vade Önerileri"
                    : pathname === "/cashflow"
                    ? "Nakit Akış Önerileri"
                    : "Hızlı Sorular"}
                </span>
              </span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 text-[11px] scrollbar-thin">
              {getQuickPrompts().map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(prompt)}
                  disabled={isPending}
                  className="whitespace-nowrap rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1 text-slate-300 transition-colors hover:border-slate-700 hover:bg-slate-800 active:scale-95 disabled:opacity-50"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>

          {/* Input Box */}
          <div className="border-t border-slate-800/80 bg-slate-950 p-3">
            <div className="relative flex items-center">
              <textarea
                ref={inputRef}
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Nakit, çekler, fabrika kârlılığı veya strateji sorunuz..."
                rows={1}
                disabled={isPending}
                className="w-full resize-none rounded-xl border border-slate-800 bg-slate-900/90 py-2.5 pl-3.5 pr-12 text-xs text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
              />
              <button
                onClick={() => handleSendMessage()}
                disabled={!inputMessage.trim() || isPending}
                className="absolute right-2 rounded-lg bg-sky-600 p-1.5 text-white transition-all hover:bg-sky-500 active:scale-95 disabled:opacity-30"
                title="Gönder"
              >
                <span className="text-xs">➤</span>
              </button>
            </div>

            <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
              <label className="flex cursor-pointer items-center gap-1.5 hover:text-slate-400">
                <input
                  type="checkbox"
                  checked={forceDeterministic}
                  onChange={(e) => setForceDeterministic(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-800 text-sky-600 focus:ring-0"
                />
                <span>Deterministik Mod (Salt Kural Çıkarımı)</span>
              </label>

              <button
                onClick={() =>
                  setMessages([
                    {
                      id: "init",
                      role: "assistant",
                      content: "Sohbet sıfırlandı. Yeni sorunuzu sorabilirsiniz.",
                      timestamp: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
                    },
                  ])
                }
                className="hover:text-slate-400"
              >
                Sohbeti Temizle
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
