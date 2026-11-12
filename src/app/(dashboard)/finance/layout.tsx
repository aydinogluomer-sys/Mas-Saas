import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1) Hazine & Banka
  { href: "/finance", label: "Özet", group: "Hazine & Banka" },
  { href: "/finance/treasury", label: "Hazine", group: "Hazine & Banka" },
  { href: "/finance/bank", label: "Banka", group: "Hazine & Banka" },
  { href: "/finance/fx", label: "Kur riski", group: "Hazine & Banka" },
  { href: "/finance/calendar", label: "Finansal takvim", group: "Hazine & Banka" },
  // 2) Alacak & Tahsilat
  { href: "/finance/invoices", label: "Faturalar", group: "Alacak & Tahsilat" },
  { href: "/finance/receivables", label: "Alacak/Borç", group: "Alacak & Tahsilat" },
  { href: "/finance/collections", label: "Tahsilat riski", group: "Alacak & Tahsilat" },
  { href: "/finance/promises", label: "Ödeme sözleri", group: "Alacak & Tahsilat" },
  { href: "/finance/counterparties", label: "Karşı taraflar", group: "Alacak & Tahsilat" },
  // 3) Borç, Çek & Kredi
  { href: "/finance/checks", label: "Çekler", group: "Borç, Çek & Kredi" },
  { href: "/finance/loans", label: "Krediler", group: "Borç, Çek & Kredi" },
  { href: "/finance/facilities", label: "Kredi limitleri", group: "Borç, Çek & Kredi" },
  { href: "/finance/maturities", label: "Vade takvimi", group: "Borç, Çek & Kredi" },
  { href: "/finance/exposure", label: "Maruziyet", group: "Borç, Çek & Kredi" },
  // 4) Defter & Kârlılık
  { href: "/finance/ledger", label: "Yönetim defteri", group: "Defter & Kârlılık" },
  { href: "/finance/profitability", label: "Kârlılık", group: "Defter & Kârlılık" },
  { href: "/finance/archive", label: "Arşiv", group: "Defter & Kârlılık" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Finansman"
      description="Hazine, alacak/tahsilat, çek/kredi portföyü ve kârlılık merkezi."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
