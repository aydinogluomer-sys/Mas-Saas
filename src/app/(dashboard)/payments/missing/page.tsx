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

export default async function MissingPaymentsPage({ searchParams }: { searchParams?: Promise<{ error?: string }> }) {
  const sp = (await searchParams) ?? {};
  const session = await requireSession();
  const pool = getPool();
  const today = istanbulDateISO();
  await ensureWindow(pool, today, session.id);
  const canMutate = can(session.role, "payment_instances", "update");
  const month = today.slice(0, 7) + "-01";
  const [missing, dayless] = await Promise.all([
    missingAmountInstances(pool, month),
    daylessPayments(pool),
  ]);

  const totalIssues = missing.length + dayless.length;

  return (
    <>
      <PageHeader
        title="Eksik Ödeme Verileri"
        subtitle="Tutarı veya takvim günü bilinmediği için karar toplamlarına güvenle katılamayan kayıtlar."
        meta={<Badge tone={totalIssues > 0 ? "amber" : "green"} dot>{totalIssues} eksik kayıt</Badge>}
      />
      <ActionFeedback error={sp.error} />

      {totalIssues === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-line bg-surface-1 py-14 px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 mb-3 border border-emerald-500/20">
            <svg className="h-6 w-6 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-tone-1">Tüm Ödeme Kayıtları Eksiksiz</h3>
          <p className="mt-1.5 max-w-md text-xs text-tone-3 leading-relaxed">
            Aktif dönemde tutarı belirsiz veya takvim günü girilmemiş hiçbir ödeme örneği bulunmuyor.
            Tüm nakit çıkışları takvime ve nakit projeksiyonuna %100 güvenle dahil edilmiştir.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Link href="/payments/calendar" className="button-accent px-4 py-2 text-xs">
              Ödeme Takvimini İncele
            </Link>
            <Link href="/payments/new" className="button-ghost px-4 py-2 text-xs">
              + Yeni Ödeme Ekle
            </Link>
          </div>
        </div>
      ) : (
        <>
          <Panel title="Tutarı Eksik Ödemeler">
            <p className="mb-3 text-xs text-tone-3">
              Bilinmeyen tutarlar sıfır sayılmaz. Buradaki giriş yalnız ilgili ödeme örneğini tamamlar.
            </p>
            {missing.length ? (
              missing.map((r) => (
                <InstanceRowView canMutate={canMutate} key={r.id} r={r} backTo="/payments/missing" showDate />
              ))
            ) : (
              <p className="text-xs text-tone-3">Eksik tutarlı ödeme kaydı yok.</p>
            )}
          </Panel>

          <Panel title="Takvim Günü Eksik Kalanlar">
            {dayless.length ? (
              dayless.map((p) => (
                <Link
                  key={p.id}
                  href={`/payments/${p.id}/edit`}
                  className="row-hover block border-b border-line-faint py-2 text-xs underline underline-offset-2"
                >
                  {p.name}
                </Link>
              ))
            ) : (
              <p className="text-xs text-tone-3">Takvim günü eksik ödeme kaydı yok.</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
