import { getPool } from "@/lib/db";

import { allMissingAmountInstances, daylessPayments } from "@/lib/radar/queries";
import { MissingAmountsDesk } from "@/components/radar/missing-amounts-desk";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import Link from "@/components/ui/app-link";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";
// searchParams EKLENDİ: bu sayfa `radar/actions.ts`'in `backTo` hedeflerinden biridir ve
// reddedilen her mutasyon buraya `?error=` ile döner. Parametreyi okumayan bir hedef, hatayı
// sessizce yutar (ölçüldü: main metni hiç değişmiyordu).
export default async function MissingPaymentsPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const denied = await requireRouteAccess("/payments/missing");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const session = await requireSession();
  const pool = getPool();
  const canMutate = can(session.role, "payment_instances", "update");
  const [missing, dayless] = await Promise.all([allMissingAmountInstances(pool), daylessPayments(pool)]);
  return (
    <>
      <PageHeader
        title="Eksik ödeme verileri"
        subtitle="Geçmiş, cari ve ileri dönemlerde tutarı veya takvim günü bilinmediği için karar toplamlarına güvenle katılamayan tüm açık kayıtlar."
        meta={<Badge tone={missing.length + dayless.length ? "amber" : "green"} dot>{missing.length + dayless.length} kayıt</Badge>}
      />
      <ActionFeedback error={sp.error} />
      <Panel title="TUTARI EKSİK ÖDEMELER (TÜM DÖNEMLER)">
        <p className="mb-3 text-xs text-tone-3">
          Bilinmeyen tutarlar sıfır sayılmaz. Şablon bazlı toplu eritme ile açık dönemleri tek seferde tamamlayabilir veya klavye tablosunda Enter ile alt alta hızlı giriş yapabilirsiniz.
        </p>
        {missing.length ? (
          <MissingAmountsDesk initialRows={missing} canMutate={canMutate} />
        ) : (
          <p className="text-sm text-tone-3">Eksik tutarlı ödeme yok.</p>
        )}
      </Panel>
      <Panel title="TAKVİM GÜNÜ EKSİK KALANLAR">
        {dayless.length ? (
          dayless.map((p) => (
            <Link key={p.id} href={`/payments/${p.id}/edit`} className="row-hover block border-b border-line-faint py-2 text-sm underline underline-offset-2">
              {p.name}
            </Link>
          ))
        ) : (
          <p className="text-sm text-tone-3">Takvim günü eksik ödeme yok.</p>
        )}
      </Panel>
    </>
  );
}
