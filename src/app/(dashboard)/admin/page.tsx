import type { ReactNode } from "react";
import Link from "next/link";
import { promises as fs } from "fs";
import path from "path";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

// Secondary / admin routes, grouped. Everything here used to be primary nav; it stays
// reachable but out of the operator's daily decision path.
type AdminModule = { href: string; label: string; desc: string };
type AdminGroup = { title: string; items: AdminModule[] };

const GROUPS: AdminGroup[] = [
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
const GROUP_COLUMNS = [
  GROUPS.slice(0, 3),
  GROUPS.slice(3),
];

async function latestBackup() {
  try {
    const dir = path.join(process.cwd(), "backups");
    const files = await fs.readdir(dir, { withFileTypes: true });
    const dumps = await Promise.all(files
      .filter((f) => f.isFile() && f.name.endsWith(".dump"))
      .map(async (f) => {
        const full = path.join(dir, f.name);
        const st = await fs.stat(full);
        return { name: f.name, mtime: st.mtime.toISOString().slice(0, 19).replace("T", " "), size: st.size };
      }));
    return dumps.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))[0] ?? null;
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const pool = getPool();
  const [dq, backup, dbProbe] = await Promise.all([
    loadDataQualityCenter(pool),
    latestBackup(),
    pool.query("select 1").then(() => "up" as const).catch(() => "down" as const),
  ]);
  const latestImport = dq.workbookVersions[0];

  return (
    <>
      <PageHeader
        title="Yönetim"
        subtitle="Takvim · ödeme kalemleri · içe aktarım · raporlar · hatırlatmalar · üretim · kaynak kayıt"
      />
      <Panel title="LOCAL PRIVATE PRODUCTION" subtitle="health / version / backup / import / aksiyon durumu" accent={dbProbe === "up" ? "pos" : "neg"}>
        <div className="overflow-hidden border" style={{ borderColor: "var(--line-faint)", borderRadius: "var(--radius)" }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6">
            <OpsCell label="Health">
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge tone="green">app up</Badge>
                <Badge tone={dbProbe === "up" ? "green" : "red"}>db {dbProbe}</Badge>
              </div>
              <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>/health / /version secret yaymaz</div>
            </OpsCell>
            <OpsCell label="Version">
              <div className="mt-1 text-sm" style={{ color: "var(--text-1)" }}>{pkg.name} {pkg.version}</div>
              <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{env.appCommitSha}</div>
            </OpsCell>
            <OpsCell label="Backup">
              <div className="mt-1 text-sm" style={{ color: backup ? "var(--text-1)" : "var(--warn)" }}>{backup ? backup.name : "backup bulunmadi"}</div>
              <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{backup ? `${backup.mtime} / ${backup.size} byte` : "docs/local-production-deploy.md"}</div>
            </OpsCell>
            <OpsCell label="Son import">
              <div className="mt-1 text-sm" style={{ color: latestImport ? "var(--text-1)" : "var(--warn)" }}>{latestImport?.original_filename ?? "import yok"}</div>
              <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{latestImport?.imported_at ?? "once kaynak Excel yukle"}</div>
            </OpsCell>
            <OpsCell label="Karar guveni">
              <div className="mt-1 flex flex-wrap gap-1.5">
                <Badge tone={dq.decisionConfidence >= 80 ? "green" : dq.decisionConfidence >= 55 ? "amber" : "red"}>%{dq.decisionConfidence}</Badge>
                <Badge tone={dq.highOpenCount > 0 ? "red" : "green"}>{dq.highOpenCount} yuksek/acil</Badge>
              </div>
            </OpsCell>
            <OpsCell label="Runbook">
              <Link href="/version" className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--accent)" }}>/version</Link>
              <Link href="/health" className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--accent)" }}>/health</Link>
            </OpsCell>
          </div>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        {GROUP_COLUMNS.map((column, i) => (
          <div key={i} className="space-y-3">
            {column.map((g) => <ModuleGroup key={g.title} group={g} />)}
          </div>
        ))}
      </div>
    </>
  );
}

function OpsCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="min-w-0 border-b p-2.5 last:border-b-0 sm:border-r lg:border-b-0 lg:last:border-r-0"
      style={{ borderColor: "var(--line-faint)" }}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--text-3)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function ModuleGroup({ group }: { group: AdminGroup }) {
  return (
    <section className="command-surface border p-3" style={{ borderRadius: "var(--radius)" }}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--text-3)" }}>
          {group.title}
        </h2>
        <Badge tone="neutral">{group.items.length}</Badge>
      </div>
      <ul className="mt-2">
        {group.items.map((it) => (
          <li key={it.label}>
            <Link
              href={it.href}
              className="block border-b py-2.5 transition-[padding,color] last:border-b-0 hover:pl-1"
              style={{ borderColor: "var(--line-faint)" }}
            >
              <div className="text-sm" style={{ color: "var(--text-1)" }}>{it.label} -&gt;</div>
              <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-4)" }}>{it.desc}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
