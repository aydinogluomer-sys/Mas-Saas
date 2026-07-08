import Link from "next/link";
import { PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

// Secondary / admin routes, grouped. Everything here used to be primary nav; it stays
// reachable but out of the operator's daily decision path.
const GROUPS: Array<{ title: string; items: Array<{ href: string; label: string; desc: string }> }> = [
  {
    title: "OPERASYON",
    items: [
      { href: "/calendar", label: "Takvim", desc: "Aylık ödeme takvimi, gün detayı ve risk kenarlıkları." },
      { href: "/payments", label: "Ödeme kalemleri", desc: "Ödeme şablonlarını ekle / düzenle / arşivle (CRUD)." },
    ],
  },
  {
    title: "RAPOR & HATIRLATMA",
    items: [
      { href: "/ask", label: "Soru-Cevap", desc: "Facts ve rapor kaynaklı salt-okunur finans yanıtları." },
      { href: "/reports", label: "Raporlar", desc: "Günlük / haftalık / aylık salt-okunur özetler." },
      { href: "/reminders", label: "Hatırlatmalar", desc: "Teslimat planlama ve gönderim kaydı (Telegram)." },
    ],
  },
  {
    title: "ANALİTİK",
    items: [
      { href: "/production", label: "Üretim", desc: "Kapasite, başabaş TL/dk, parça kârlılığı (analitik tahmin)." },
    ],
  },
  {
    title: "VERİ & KAYNAK",
    items: [
      { href: "/phases", label: "Faz görünürlüğü", desc: "Hangi faz hangi ekranda görünür: tek sayfada kontrol tablosu." },
      { href: "/data-quality#ab-diff", label: "Excel A/B farkı", desc: "Son iki workbook arasında sekme/satır/hücre/formül farkları." },
      { href: "/data-quality#dashboard-mutabakat", label: "Dashboard mutabakatı", desc: "Cashflow başlık değerleri (devir/kasa) kaynak hücre mutabakatı." },
      { href: "/data-quality", label: "Veri kalite merkezi", desc: "Karari engelleyen veri sorunlari, gorevler ve kaynak izleri." },
      { href: "/assumptions", label: "Dis varsayimlar", desc: "Faiz, kur, enflasyon, personel, enerji ve kredi oranlari icin kaynakli varsayimlar." },
      { href: "/imports", label: "İçe aktarım", desc: "Çalışma dosyası yükleme, sekme sınıflandırma, aktarım." },
      { href: "/imports", label: "İncelemeler / kaynak kayıt", desc: "Mapping incelemeleri ve ham sekme/satır izlenebilirliği (içe aktarım içinden)." },
    ],
  },
];

export default function AdminPage() {
  return (
    <>
      <PageHeader
        title="Yönetim"
        subtitle="Takvim · ödeme kalemleri · içe aktarım · raporlar · hatırlatmalar · üretim · kaynak kayıt"
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} className="border p-3" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
            <h2 className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>{g.title}</h2>
            <ul className="mt-2 space-y-2">
              {g.items.map((it) => (
                <li key={it.label}>
                  <Link href={it.href} className="card-hover block border p-2.5"
                    style={{ borderColor: "var(--line-faint)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                    <div className="text-sm" style={{ color: "var(--text-1)" }}>{it.label} →</div>
                    <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-4)" }}>{it.desc}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
