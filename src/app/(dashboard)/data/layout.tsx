import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1 · Aktarım & Bağlantı
  { href: "/data/imports", label: "İçe aktarımlar", group: "1 · Aktarım & Bağlantı" },
  { href: "/data/imports/v2", label: "Standart aktarım (V2)", group: "1 · Aktarım & Bağlantı" },
  { href: "/data/integrations", label: "Entegrasyonlar", group: "1 · Aktarım & Bağlantı" },
  { href: "/data/documents", label: "Dokümanlar", group: "1 · Aktarım & Bağlantı" },
  // 2 · Mutabakat & Mizan
  { href: "/data/quality", label: "Veri sağlığı", group: "2 · Mutabakat & Mizan" },
  { href: "/data/reconciliation", label: "Mutabakat", group: "2 · Mutabakat & Mizan" },
  { href: "/data/trial-balance-bridge", label: "Mizan köprüsü", group: "2 · Mutabakat & Mizan" },
  // 3 · İnceleme & Onay
  { href: "/data/reviews", label: "İnceleme kuyruğu", group: "3 · İnceleme & Onay" },
  { href: "/data/approvals", label: "Onay kuyruğu", group: "3 · İnceleme & Onay" },
  // 4 · Kaynak & Varsayım
  { href: "/data/assumptions", label: "Dış varsayımlar", group: "4 · Kaynak & Varsayım" },
  { href: "/data/sources", label: "Kaynak gezgini", group: "4 · Kaynak & Varsayım" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Veri Merkezi"
      description="Excel aktarımı, karar güveni, mutabakat ve kaynak kanıtları."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
