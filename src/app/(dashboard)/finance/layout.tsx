import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { tabsFor } from "@/lib/authz/matrix";
import { ModuleFrame, type ModuleTab } from "@/components/ui/module-tabs";

const tabs: ModuleTab[] = [
  // 1. Likidite & Kokpit
  { href: "/finance/cockpit", label: "CFO Kokpiti", category: "Likidite & Kokpit" },
  { href: "/finance/chains", label: "Finansal Sinir Sistemi", category: "Likidite & Kokpit" },
  { href: "/finance", label: "Genel Özet", category: "Likidite & Kokpit" },
  { href: "/finance/bank", label: "Banka", category: "Likidite & Kokpit" },
  { href: "/finance/treasury", label: "Hazine", category: "Likidite & Kokpit" },

  // 2. Krediler & Borçlar
  { href: "/finance/loans", label: "Krediler", category: "Krediler & Borçlar" },
  { href: "/finance/facilities", label: "Kredi Limitleri", category: "Krediler & Borçlar" },
  { href: "/finance/maturities", label: "Vade Takvimi", category: "Krediler & Borçlar" },
  { href: "/finance/calendar", label: "Finansal Takvim", category: "Krediler & Borçlar" },

  // 3. Ticari İşlemler
  { href: "/finance/invoices", label: "Faturalar", category: "Ticari İşlemler" },
  { href: "/finance/receivables", label: "Alacak/Borç", category: "Ticari İşlemler" },
  { href: "/finance/checks", label: "Çekler", category: "Ticari İşlemler" },
  { href: "/finance/collections", label: "Tahsilat Riski", category: "Ticari İşlemler" },
  { href: "/finance/promises", label: "Ödeme Sözleri", category: "Ticari İşlemler" },

  // 4. Piyasa Riski & Kârlılık
  { href: "/finance/fx", label: "Kur Riski", category: "Piyasa & Risk" },
  { href: "/finance/exposure", label: "Net Maruziyet", category: "Piyasa & Risk" },
  { href: "/finance/counterparties", label: "Karşı Taraflar", category: "Piyasa & Risk" },
  { href: "/finance/profitability", label: "Kârlılık", category: "Piyasa & Risk" },
  { href: "/finance/archive", label: "Arşiv", category: "Piyasa & Risk" },
];

export default async function Layout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <ModuleFrame
      title="Finansman"
      description="Likidite, borç servisi, krediler ve hazine operasyonları."
      tabs={tabsFor(session.role, tabs)}
    >
      {children}
    </ModuleFrame>
  );
}
