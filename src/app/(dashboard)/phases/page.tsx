import Link from "next/link";
import { PageHeader } from "@/components/ui/shell";
import { Badge } from "@/components/ui/badge";

type PhaseRow = {
  id: string;
  title: string;
  status: "done" | "in-progress";
  href: string;
  uiLabel: string;
};

const PHASES: PhaseRow[] = [
  { id: "1", title: "Kaynak veri haritasi ve parser", status: "done", href: "/imports", uiLabel: "Içe aktarım" },
  { id: "2", title: "Veritabani foundation", status: "done", href: "/admin", uiLabel: "Yönetim" },
  { id: "3", title: "Import ve mapping review UI", status: "done", href: "/imports", uiLabel: "Içe aktarım" },
  { id: "4", title: "Odeme radari MVP", status: "done", href: "/radar", uiLabel: "Ödemeler" },
  { id: "5", title: "Nakit akis radari", status: "done", href: "/cashflow", uiLabel: "Nakit Akış" },
  { id: "6", title: "Cek/kredi finansman radari", status: "done", href: "/financing", uiLabel: "Finansman" },
  { id: "7", title: "Raporlar ve hatirlatmalar", status: "done", href: "/reports", uiLabel: "Raporlar" },
  { id: "8", title: "Uretim kapasite/maliyet", status: "done", href: "/production", uiLabel: "Üretim" },
  { id: "9", title: "Salt-okunur senaryo motoru", status: "done", href: "/scenarios", uiLabel: "Senaryolar" },
  { id: "10", title: "Excel coverage close-out", status: "done", href: "/production", uiLabel: "Üretim / Nakit Akış" },
  { id: "11", title: "Decision facts / metrics", status: "done", href: "/", uiLabel: "Ana Ekran" },
  { id: "12", title: "AI soru-cevap / yorum", status: "in-progress", href: "/ask", uiLabel: "Sor" },
  { id: "13", title: "Senaryo v2 optimizasyon", status: "in-progress", href: "/scenarios", uiLabel: "Senaryolar" },
  { id: "14", title: "Veri kalite + dis varsayim + aksiyon", status: "in-progress", href: "/data-quality", uiLabel: "Veri Kalite" },
];

export default function PhasesPage() {
  return (
    <>
      <PageHeader
        title="Faz Gorunurlugu"
        subtitle="Her fazin arayüzdeki karşılığı ve erişim noktası"
        meta={<Badge tone="neutral" dot>tek ekran kontrol</Badge>}
      />

      <section className="border p-3" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)" }}>
        <div className="mb-2 text-[11px]" style={{ color: "var(--text-3)" }}>
          Faz yapildi ama görünmüyor hissi için hızlı kontrol tablosu. Her satır ilgili ekrana doğrudan gider.
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr style={{ color: "var(--text-3)" }}>
                <th className="border-b px-2 py-1 text-left" style={{ borderColor: "var(--line-faint)" }}>Faz</th>
                <th className="border-b px-2 py-1 text-left" style={{ borderColor: "var(--line-faint)" }}>Kapsam</th>
                <th className="border-b px-2 py-1 text-left" style={{ borderColor: "var(--line-faint)" }}>Durum</th>
                <th className="border-b px-2 py-1 text-left" style={{ borderColor: "var(--line-faint)" }}>Arayüz</th>
              </tr>
            </thead>
            <tbody>
              {PHASES.map((p) => (
                <tr key={p.id}>
                  <td className="border-b px-2 py-1 font-mono" style={{ borderColor: "var(--line-faint)", color: "var(--text-2)" }}>
                    {p.id}
                  </td>
                  <td className="border-b px-2 py-1" style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}>
                    {p.title}
                  </td>
                  <td className="border-b px-2 py-1" style={{ borderColor: "var(--line-faint)" }}>
                    <Badge tone={p.status === "done" ? "green" : "amber"}>{p.status === "done" ? "DONE" : "IN PROGRESS"}</Badge>
                  </td>
                  <td className="border-b px-2 py-1" style={{ borderColor: "var(--line-faint)" }}>
                    <Link href={p.href} className="underline underline-offset-2" style={{ color: "var(--info)" }}>
                      {p.uiLabel} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Link href="/admin" className="border p-2.5 text-sm" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)", color: "var(--text-1)" }}>
          Yönetim merkezi → ikincil modüller
        </Link>
        <Link href="/assumptions" className="border p-2.5 text-sm" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-1)", color: "var(--text-1)" }}>
          Dış varsayımlar (14B/14D) →
        </Link>
      </div>
    </>
  );
}
