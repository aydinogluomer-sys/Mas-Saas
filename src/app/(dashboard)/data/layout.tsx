import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1. İçe Aktarım
  { href: "/data/imports/v2", label: "Standart Aktarım (V2)", category: "İçe Aktarım" },
  { href: "/data/imports", label: "Dosya Geçmişi", category: "İçe Aktarım" },
  { href: "/data/sources", label: "Kaynak Gezgini", category: "İçe Aktarım" },

  // 2. Doğrulama & Onay
  { href: "/data/reviews", label: "İnceleme Kuyruğu", category: "Doğrulama & Onay" },
  { href: "/data/approvals", label: "Onay Kuyruğu", category: "Doğrulama & Onay" },
  { href: "/data/reconciliation", label: "Banka Mutabakatı", category: "Doğrulama & Onay" },

  // 3. Yönetişim & Sağlık
  { href: "/data/quality", label: "Veri Sağlığı", category: "Yönetişim & Sağlık" },
  { href: "/data/assumptions", label: "Dış Varsayımlar", category: "Yönetişim & Sağlık" },
  { href: "/data/documents", label: "Dokümanlar", category: "Yönetişim & Sağlık" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Veri Merkezi"
      description="Excel içe aktarımı, mutabakat, veri kalitesi ve denetim kaynakları."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
