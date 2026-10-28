import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1. Altyapı & Süreklilik
  { href: "/system", label: "Sistem Durumu", category: "Altyapı" },
  { href: "/system/backup", label: "Yedekleme", category: "Altyapı" },
  { href: "/system/jobs", label: "Arka Plan İşleri", category: "Altyapı" },
  { href: "/system/archive", label: "Arşiv Merkezi", category: "Altyapı" },

  // 2. Güvenlik & Denetim
  { href: "/system/security", label: "Erişim & Roller", category: "Güvenlik & Denetim" },
  { href: "/system/audit", label: "Denetim Kayıtları", category: "Güvenlik & Denetim" },
  { href: "/system/controls", label: "Kontrol Merkezi", category: "Güvenlik & Denetim" },
  { href: "/system/features", label: "Özellik Haritası", category: "Güvenlik & Denetim" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Sistem"
      description="Uygulama durumu, veri sürekliliği, erişim ve özellik görünürlüğü."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
