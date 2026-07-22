import Link from "next/link";
import { getPool } from "@/lib/db";
import { listArchive } from "@/lib/archive/engine";
import { ArchiveList } from "@/components/archive/archive-list";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";
export default async function PaymentArchive() {
  const rows = await listArchive(getPool(), "payments");
  return <>
    <PageHeader title="Ödeme Arşivi" subtitle="Arşivlenen kalemler yeni vade üretmez; geçmiş ödeme ve denetim kayıtları korunur." action={<Link href="/payments/items" className="button-accent px-3 py-2">Ödeme kalemlerine git</Link>} />
    <Panel title={`${rows.length} arşivlenmiş kalem`}><ArchiveList rows={rows} backTo="/payments/archive" /></Panel>
  </>;
}
