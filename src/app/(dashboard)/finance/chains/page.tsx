import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { runFinancialNervousSystemCheck } from "@/lib/chains";
import { NervousSystemHub } from "@/components/finance/nervous-system-hub";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Finansal Sinir Sistemi | MAS Nakit Radar",
  description: "8 İhtiyaç Tabanlı Zinciri Birleştiren Bütünleşik Finansal Yönetim ve Denetim Ağı.",
};

export default async function FinancialChainsPage() {
  await requireSession();
  const pool = getPool();
  const initialReport = await runFinancialNervousSystemCheck(pool);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <NervousSystemHub initialReport={initialReport} />
    </div>
  );
}
