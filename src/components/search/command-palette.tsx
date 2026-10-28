"use client";

// Faz 35 + Modern Fintech Enterprise Command Palette (Cmd+K)
// Global Spotlight-style search: Instant Page Navigation + Quick Actions + Live DB Entities.

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Hit {
  entityKey: string;
  entityLabel: string;
  id: string;
  title: string;
  amount: number | null;
  date: string | null;
  href: string;
}

interface Group {
  key: string;
  label: string;
  hits: Hit[];
}

interface QuickCommand {
  id: string;
  category: "Sayfalar & Modüller" | "Hızlı Eylemler";
  title: string;
  subtitle: string;
  href: string;
  badge?: string;
  keywords: string[];
}

const STATIC_COMMANDS: QuickCommand[] = [
  // ── Sayfalar & Modüller ──
  { id: "nav-overview", category: "Sayfalar & Modüller", title: "Genel Bakış (Executive Hub)", subtitle: "Ana özet, runway, KPI kartları ve bekleyen görevler", href: "/overview", keywords: ["ana sayfa", "dashboard", "özet", "kpi", "runway", "genel"] },
  { id: "nav-cashflow", category: "Sayfalar & Modüller", title: "Nakit Akışı (Cash Runway)", subtitle: "13 haftalık dinamik nakit projeksiyonu ve likidite trendi", href: "/cashflow", keywords: ["nakit", "akış", "runway", "likidite", "projeksiyon"] },
  { id: "nav-cashflow-monthly", category: "Sayfalar & Modüller", title: "Aylık Nakit Akışı Takvimi", subtitle: "Ay bazında beklenen girişler, çıkışlar ve net kapanış", href: "/cashflow/monthly", keywords: ["aylık", "takvim", "giriş", "çıkış"] },
  { id: "nav-budget", category: "Sayfalar & Modüller", title: "Bütçe & Fiili Gerçekleşme", subtitle: "Bütçe hedefleri ile gerçekleşen nakit sapmaları", href: "/cashflow/budget", keywords: ["bütçe", "fiili", "sapma", "hedef"] },
  { id: "nav-checks", category: "Sayfalar & Modüller", title: "Çek & Senet Portföyü", subtitle: "Verilen ve alınan çeklerin vadeleri, durumu ve banka takibi", href: "/finance/checks", keywords: ["çek", "senet", "portföy", "vade", "keşideci"] },
  { id: "nav-loans", category: "Sayfalar & Modüller", title: "Krediler & Taksit Planı", subtitle: "Banka kredileri, anapara/faiz taksitleri ve kalan borç", href: "/finance/loans", keywords: ["kredi", "taksit", "borç", "faiz", "banka"] },
  { id: "nav-bank", category: "Sayfalar & Modüller", title: "Banka Hesapları & Bakiyeler", subtitle: "Tüm bankalardaki vadesiz, vadeli ve blokeli mevduatlar", href: "/finance/bank", keywords: ["banka", "hesap", "mevduat", "bakiye", "vadesiz"] },
  { id: "nav-fx", category: "Sayfalar & Modüller", title: "Döviz Pozisyonu & Kur Riski", subtitle: "USD, EUR açık pozisyonlar ve kur şok simülasyonları", href: "/finance/fx", keywords: ["döviz", "kur", "usd", "eur", "hedge", "fx"] },
  { id: "nav-treasury", category: "Sayfalar & Modüller", title: "Hazine & Kredi Limitleri", subtitle: "Banka limit doluluk oranları, teminat mektupları ve headroom", href: "/finance/treasury", keywords: ["hazine", "limit", "facilities", "teminat", "headroom"] },
  { id: "nav-cockpit", category: "Sayfalar & Modüller", title: "CFO Karar Kokpiti", subtitle: "Üst düzey likidite göstergeleri ve stres senaryoları", href: "/finance/cockpit", keywords: ["cfo", "kokpit", "karar", "stres", "yönetim"] },
  { id: "nav-invoices", category: "Sayfalar & Modüller", title: "Faturalar & Cari Hareketler", subtitle: "Satış ve alış faturaları, ödeme koşulları ve durumlar", href: "/finance/invoices", keywords: ["fatura", "alış", "satış", "vade"] },
  { id: "nav-counterparties", category: "Sayfalar & Modüller", title: "Cariler & Karşı Taraflar", subtitle: "Müşteri ve tedarikçi bakiye konsantrasyonu ve risk puanı", href: "/finance/counterparties", keywords: ["cari", "müşteri", "tedarikçi", "firma"] },
  { id: "nav-maturities", category: "Sayfalar & Modüller", title: "Vadeler & Yaşlandırma Analizi", subtitle: "Alacak ve borç yaşlandırma tabloları (Aging analysis)", href: "/finance/maturities", keywords: ["vade", "yaşlandırma", "aging", "geciken"] },
  { id: "nav-payments", category: "Sayfalar & Modüller", title: "Ödeme Radarı & Takvim", subtitle: "Haftalık ve günlük ödeme emirleri ve gerçekleşmeler", href: "/payments", keywords: ["ödeme", "radar", "takvim", "planlanan"] },
  { id: "nav-production-capacity", category: "Sayfalar & Modüller", title: "Üretim Kapasitesi & Vardiya", subtitle: "Makine doluluk oranları ve darboğaz göstergeleri", href: "/production/capacity", keywords: ["üretim", "kapasite", "makine", "vardiya"] },
  { id: "nav-production-profitability", category: "Sayfalar & Modüller", title: "Üretim Kârlılığı & Maliyetler", subtitle: "Sipariş ve ürün bazında marjinal kârlılık oranları", href: "/production/profitability", keywords: ["üretim", "kârlılık", "maliyet", "roi"] },
  { id: "nav-scenarios-compare", category: "Sayfalar & Modüller", title: "Senaryo Simülasyonu & Stres Testi", subtitle: "Normal, Kötümser ve Kara Kuğu nakit projeksiyonları", href: "/scenarios/compare", keywords: ["senaryo", "what-if", "simülasyon", "stres", "karşılaştır"] },
  { id: "nav-insights-briefing", category: "Sayfalar & Modüller", title: "Finansal İçgörüler & Günlük Brifing", subtitle: "Sistem tarafından üretilen otomatik risk özetleri", href: "/insights/briefing", keywords: ["içgörü", "brifing", "günlük", "özet"] },
  { id: "nav-insights-ask", category: "Sayfalar & Modüller", title: "Yapay Zeka Finans Asistanı (AI)", subtitle: "Doğal dilde finansal sorgulama ve raporlama", href: "/insights/ask", keywords: ["ai", "yapay zeka", "soru", "asistan", "copilot"] },
  { id: "nav-data-imports-v2", category: "Sayfalar & Modüller", title: "Standart Excel İçe Aktarımı (V2)", subtitle: "14 finansal tablo şablonu, doğrulama ve atomik yazım", href: "/data/imports/v2", keywords: ["excel", "içe aktar", "import", "v2", "şablon"] },
  { id: "nav-data-imports", category: "Sayfalar & Modüller", title: "İçe Aktarım Dosya Geçmişi", subtitle: "Yüklenen çalışma kitapları, satır sayıları ve denetim kayıtları", href: "/data/imports", keywords: ["dosya", "geçmiş", "workbooks", "yükleme"] },
  { id: "nav-reconciliation", category: "Sayfalar & Modüller", title: "Banka Mutabakatı & Eşleme", subtitle: "Banka ekstreleri ile fatura ve çek otomatik eşleştirme", href: "/data/reconciliation", keywords: ["mutabakat", "banka", "ekstre", "eşleme"] },
  { id: "nav-approvals", category: "Sayfalar & Modüller", title: "Onay Kuyruğu (Governance)", subtitle: "Yönetici onayı bekleyen ödemeler ve veri değişiklikleri", href: "/data/approvals", keywords: ["onay", "kuyruk", "bekleyen", "talep"] },
  { id: "nav-quality", category: "Sayfalar & Modüller", title: "Veri Kalitesi & Sağlık Radarı", subtitle: "Eksik veri, şüpheli mükerrer kayıt ve doğrulama denetimi", href: "/data/quality", keywords: ["kalite", "sağlık", "anomali", "denetim"] },
  { id: "nav-audit", category: "Sayfalar & Modüller", title: "Kriptografik Denetim İzi (Audit Log)", subtitle: "SHA-256 hash zinciriyle korunan işlem kayıtları", href: "/system/audit", keywords: ["denetim", "audit", "güvenlik", "hash", "log"] },
  { id: "nav-security", category: "Sayfalar & Modüller", title: "Sistem Güvenliği & Rol Yönetimi", subtitle: "Kullanıcı hesapları, roller ve erişim matrisi", href: "/system/security", keywords: ["güvenlik", "roller", "kullanıcı", "şifre"] },

  // ── Hızlı Eylemler (Quick Actions) ──
  { id: "act-new-check", category: "Hızlı Eylemler", title: "Yeni Çek Girişi Yap", subtitle: "Portföye yeni vadeli çek veya senet kaydı oluşturun", href: "/finance/checks/new", badge: "Aksiyon", keywords: ["çek ekle", "yeni çek", "senet ekle", "oluştur"] },
  { id: "act-new-loan", category: "Hızlı Eylemler", title: "Yeni Kredi Girişi Yap", subtitle: "Yeni kredi, faiz oranı ve geri ödeme takvimi tanımlayın", href: "/finance/loans/new", badge: "Aksiyon", keywords: ["kredi ekle", "yeni kredi", "borçlanma"] },
  { id: "act-new-payment", category: "Hızlı Eylemler", title: "Yeni Ödeme Planla", subtitle: "Tedarikçi veya operasyonel harcama için ödeme planı oluşturun", href: "/payments/new", badge: "Aksiyon", keywords: ["ödeme ekle", "yeni ödeme", "planla"] },
  { id: "act-template", category: "Hızlı Eylemler", title: "Excel Şablonunu İndir (.xlsx)", subtitle: "Standart V2 içe aktarım şablonunu bilgisayarınıza indirin", href: "/data/imports/v2/template", badge: "İndir", keywords: ["şablon", "excel", "indir", "download"] },
  { id: "act-ask-ai", category: "Hızlı Eylemler", title: "Yapay Zekaya Soru Sor", subtitle: "CFO Copilot'a nakit akışınız ve borçlarınızla ilgili soru sorun", href: "/insights/ask", badge: "AI", keywords: ["sor", "yapay zeka", "ai", "asistan"] },
];

const tl = (n: number | null) =>
  n == null ? "—" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dbGroups, setDbGroups] = useState<Group[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  // Global Keyboard Listener: Cmd+K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Filter Static Navigation & Quick Actions
  const filteredStatic = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // If empty query, show top quick actions and key modules
      return STATIC_COMMANDS.slice(0, 10);
    }
    return STATIC_COMMANDS.filter((cmd) => {
      if (cmd.title.toLowerCase().includes(q)) return true;
      if (cmd.subtitle.toLowerCase().includes(q)) return true;
      if (cmd.keywords.some((k) => k.includes(q))) return true;
      return false;
    });
  }, [query]);

  // Query Backend API for live entities (Checks, Invoices, Loans, Counterparties)
  const searchApi = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setDbGroups([]);
      setRefused(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        if (mine === seq.current) {
          setDbGroups([]);
          setRefused(null);
        }
        return;
      }
      const data = (await res.json()) as { groups: Group[]; refused: boolean; message?: string };
      if (mine !== seq.current) return;
      setDbGroups(data.groups ?? []);
      setRefused(data.refused ? data.message ?? "Arama reddedildi." : null);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void searchApi(query), 180);
    return () => clearTimeout(t);
  }, [query, searchApi]);

  // Combine All Selectable Items for Keyboard Arrow Navigation
  const allSelectable = useMemo(() => {
    const items: Array<{ id: string; href: string }> = [];
    filteredStatic.forEach((item) => items.push({ id: item.id, href: item.href }));
    dbGroups.forEach((group) => {
      group.hits.forEach((hit) => items.push({ id: `${hit.entityKey}-${hit.id}`, href: hit.href }));
    });
    return items;
  }, [filteredStatic, dbGroups]);

  // Arrow Key Navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1 < allSelectable.length ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : allSelectable.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = allSelectable[selectedIndex];
      if (target) {
        setOpen(false);
        router.push(target.href);
      }
    }
  };

  // Scroll active item into view
  useEffect(() => {
    const activeEl = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Header Trigger Button (Matches manifest regex /^ara ⌘K$/)
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-1 text-xs text-tone-3 hover:text-tone-1 hover:border-line-strong hover:bg-surface-2 transition-all shadow-sm group"
        aria-label="Ara (Ctrl+K)"
      >
        <svg className="h-3.5 w-3.5 text-tone-3 group-hover:text-sky-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <span className="font-sans font-medium">ara ⌘K</span>
      </button>
    );
  }

  let currentIndexTracker = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 backdrop-blur-md p-4 pt-[10vh] animate-in fade-in duration-150"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Evrensel arama ve komut menüsü"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-line-strong bg-surface-1 shadow-2xl overflow-hidden flex flex-col max-h-[80vh] border-white/10"
        style={{ boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.08)" }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Header Input */}
        <div className="flex items-center gap-3 border-b border-line px-4 py-3 bg-surface-2/40">
          <svg className="h-5 w-5 text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Modül, işlem veya veri ara… (örn: 'çekler', 'yeni kredi', 'nakit akışı', 'akon fatura')"
            className="w-full bg-transparent text-sm text-tone-1 placeholder:text-tone-3 focus:outline-none font-sans"
          />
          {loading && (
            <svg className="h-4 w-4 animate-spin text-sky-400 shrink-0" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
          <kbd className="hidden sm:inline-flex items-center rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-tone-3 border border-line">
            ESC
          </kbd>
        </div>

        {/* Scrollable Results */}
        <div ref={listRef} className="overflow-y-auto p-2 space-y-4 max-h-[60vh] scrollbar-thin">
          {refused && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
              {refused}
            </div>
          )}

          {/* Quick Actions & Navigation Routes */}
          {filteredStatic.length > 0 && (
            <div>
              <div className="px-3 py-1.5 font-sans text-[11px] font-semibold text-tone-3 uppercase tracking-wider">
                {query.trim() ? "Eşleşen Sayfa & Eylemler" : "Önerilen Hızlı Erişim"}
              </div>
              <div className="space-y-0.5">
                {filteredStatic.map((item) => {
                  const itemIndex = currentIndexTracker++;
                  const isSelected = itemIndex === selectedIndex;
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      data-index={itemIndex}
                      onClick={() => setOpen(false)}
                      className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-all text-xs ${
                        isSelected
                          ? "bg-sky-500/15 text-white border-l-2 border-sky-400 pl-3.5 shadow-sm"
                          : "text-tone-2 hover:bg-surface-2 hover:text-tone-1"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-tone-1">{item.title}</span>
                          {item.badge && (
                            <span className="rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2 py-0.2 text-[10px] font-medium">
                              {item.badge}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-tone-3 truncate mt-0.5">{item.subtitle}</div>
                      </div>
                      <span className="font-mono text-[11px] text-tone-4 shrink-0">→</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {/* Database Entities (Invoices, Checks, Counterparties, Loans) */}
          {dbGroups.map((group) => (
            <div key={group.key}>
              <div className="px-3 py-1.5 font-sans text-[11px] font-semibold text-tone-3 uppercase tracking-wider">
                {group.label} (Canlı Kayıtlar)
              </div>
              <div className="space-y-0.5">
                {group.hits.map((hit) => {
                  const itemIndex = currentIndexTracker++;
                  const isSelected = itemIndex === selectedIndex;
                  return (
                    <Link
                      key={`${hit.entityKey}-${hit.id}`}
                      href={hit.href}
                      data-index={itemIndex}
                      onClick={() => setOpen(false)}
                      className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-all text-xs ${
                        isSelected
                          ? "bg-sky-500/15 text-white border-l-2 border-sky-400 pl-3.5 shadow-sm"
                          : "text-tone-2 hover:bg-surface-2 hover:text-tone-1"
                      }`}
                    >
                      <div className="min-w-0 flex-1 truncate font-medium text-tone-1">{hit.title}</div>
                      <div className="shrink-0 flex items-center gap-2 font-mono text-[11px] text-tone-3">
                        {hit.amount != null && <span className="text-emerald-400 font-semibold">{tl(hit.amount)}</span>}
                        {hit.date && <span>{hit.date}</span>}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Empty state when query gives 0 results */}
          {!loading && query.trim().length >= 2 && filteredStatic.length === 0 && dbGroups.length === 0 && (
            <div className="py-8 text-center">
              <div className="font-sans text-sm text-tone-2 font-medium">Sonuç bulunamadı</div>
              <div className="text-xs text-tone-3 mt-1">
                &ldquo;{query}&rdquo; aramasına uygun sayfa, eylem veya veri kaydı eşleşmedi.
              </div>
            </div>
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="flex items-center justify-between border-t border-line bg-surface-2/30 px-4 py-2 text-[11px] text-tone-3 font-sans">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-tone-2 border border-line">↑↓</kbd> Gezin
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-tone-2 border border-line">↵</kbd> Seç
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-tone-2 border border-line">ESC</kbd> Kapat
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
