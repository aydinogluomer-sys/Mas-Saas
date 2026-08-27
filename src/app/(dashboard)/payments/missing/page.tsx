import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { ensureWindow } from "@/lib/radar/engine";
import { daylessPayments, missingAmountInstances } from "@/lib/radar/queries";
import { InstanceRowView } from "@/components/radar/instance-row";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { ActionFeedback } from "@/components/ui/action-feedback";

export const dynamic = "force-dynamic";
// searchParams EKLENDİ: bu sayfa `radar/actions.ts`'in `backTo` hedeflerinden biridir ve
// reddedilen her mutasyon buraya `?error=` ile döner. Parametreyi okumayan bir hedef, hatayı
// sessizce yutar (ölçüldü: main metni hiç değişmiyordu).
export default async function MissingPaymentsPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const sp = (await searchParams) ?? {};
  const session=await requireSession(); const pool=getPool(); const today=istanbulDateISO(); await ensureWindow(pool,today,session.id);
  const canMutate=can(session.role,"payment_instances","update"); const month=today.slice(0,7)+"-01"; const [missing,dayless]=await Promise.all([missingAmountInstances(pool,month),daylessPayments(pool)]);
  return <><PageHeader title="Eksik ödeme verileri" subtitle="Tutarı veya takvim günü bilinmediği için karar toplamlarına güvenle katılamayan kayıtlar." meta={<Badge tone={missing.length+dayless.length?"amber":"green"} dot>{missing.length+dayless.length} kayıt</Badge>} />
    <ActionFeedback error={sp.error} />
    <Panel title="TUTARI EKSİK ÖDEMELER"><p className="mb-3 text-xs text-tone-3">Bilinmeyen tutarlar sıfır sayılmaz. Buradaki giriş yalnız ilgili ödeme örneğini tamamlar.</p>{missing.length?missing.map(r=><InstanceRowView canMutate={canMutate} key={r.id} r={r} backTo="/payments/missing" showDate/>):<p className="text-sm text-tone-3">Eksik tutarlı ödeme yok.</p>}</Panel>
    <Panel title="TAKVİM GÜNÜ EKSİK KALANLAR">{dayless.length?dayless.map(p=><Link key={p.id} href={`/payments/${p.id}/edit`} className="row-hover block border-b border-line-faint py-2 text-sm underline underline-offset-2">{p.name}</Link>):<p className="text-sm text-tone-3">Takvim günü eksik ödeme yok.</p>}</Panel>
  </>;
}
