import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1 · Durum & Süreklilik
  { href: "/system", label: "Durum", group: "1 · Durum & Süreklilik" },
  { href: "/system/backup", label: "Yedekleme", group: "1 · Durum & Süreklilik" },
  { href: "/system/jobs", label: "Arka plan işleri", group: "1 · Durum & Süreklilik" },
  // 2 · İç Kontrol & Denetim
  { href: "/system/controls", label: "Kontrol merkezi", group: "2 · İç Kontrol & Denetim" },
  { href: "/system/audit", label: "Denetim kayıtları", group: "2 · İç Kontrol & Denetim" },
  { href: "/system/archive", label: "Arşiv Merkezi", group: "2 · İç Kontrol & Denetim" },
  // 3 · Güvenlik & Tanılama
  { href: "/system/security", label: "Erişim ve güvenlik", group: "3 · Güvenlik & Tanılama" },
  { href: "/system/diagnostics", label: "Tanılama", group: "3 · Güvenlik & Tanılama" },
  { href: "/system/features", label: "Özellik haritası", group: "3 · Güvenlik & Tanılama" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Sistem"
      description="Uygulama durumu, veri sürekliliği, erişim, tanılama ve özellik görünürlüğü."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
