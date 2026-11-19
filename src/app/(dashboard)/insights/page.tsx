import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KeyStat, PageHeader } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  loadCanonicalKpis,
  loadCanonicalOutflow7dKpi,
} from "@/lib/metrics/canonical-kpis";
import { decimal, money, rateOrNull } from "@/lib/money";
import { formatForeignBucketNote, type CurrencyAmountBucket } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const INSIGHT_SURFACES = [
  {
    href: "/insights/ask",
    title: "Sor (Kanıtlı CFO Asistanı)",
    desc: "Fatura, cari, mizan, 13H likidite, banka, üretim ve kovenant sorularını salt-okunur SQL kanıtıyla yanıtlar.",
  },
  {
    href: "/insights/briefing",
    title: "Sabah CFO Brifingi",
    desc: "TCMB çoklu döviz kasa deltası, likidite açığı, vadesi geçen tahsilat sözleri ve kanal gönderimi.",
  },
  {
    href: "/insights/analysis",
    title: "Analiz & İşletme Sermayesi",
    desc: "8–12 adımlı CFO nakit köprüsü, MoM/QoQ/YoY varyans, 6 aylık rolling trend ve canlı DIO/CCC analizi.",
  },
  {
    href: "/insights/reports",
    title: "Yönetim Kurulu & Banka Raporları",
    desc: "Yönetici özeti, TDHP Gelir Tablosu, Bilanço, 13H Likidite ve Kovenant paketi (.xlsx / yazdırılabilir görünüm).",
  },
  {
    href: "/insights/reminders",
    title: "Hatırlatma Kuralları & Eskalasyon",
    desc: "Vadesi yaklaşan ve kademeli gecikmiş (1-7g, 8-30g, 30+g) fatura, çek, kredi ve kovenant uyarıları.",
  },
  {
    href: "/insights/tasks",
    title: "Aksiyon & Görev Takibi",
    desc: "Kullanıcı atamalı (`owner_user_id`) ve ödeme kapandığında otomatik tamamlanan operasyonel görevler.",
  },
] as const;

function consolidateBucketsTry(
  baseTry: number | null,
  buckets: readonly CurrencyAmountBucket[],
  fxMap: ReadonlyMap<string, number>,
): { consolidatedTry: number | null; unratedCurrencies: string[] } {
  if (baseTry == null) return { consolidatedTry: null, unratedCurrencies: [] };
  let acc = decimal(baseTry);
  const unrated: string[] = [];
  for (const b of buckets) {
    if (!b.currency || b.total == null) {
      if (b.currency) unrated.push(b.currency);
      continue;
    }
    const rate = fxMap.get(b.currency.toUpperCase());
    if (rate != null && rate > 0) {
      acc = acc.plus(decimal(b.total).times(decimal(rate)));
    } else {
      unrated.push(b.currency);
    }
  }
  return { consolidatedTry: money(acc), unratedCurrencies: unrated };
}

export default async function InsightsOverviewPage() {
  const denied = await requireRouteAccess("/insights");
  if (denied) return denied;

  const today = istanbulDateISO();
  const pool = getPool();
  const [canonical, outflow7d, fxRes] = await Promise.all([
    loadCanonicalKpis(pool, today),
    loadCanonicalOutflow7dKpi(pool, today),
    pool
      .query<{ base_currency: string; rate: string }>(
        `select distinct on (base_currency) base_currency, rate::text as rate
           from public.fx_rate_snapshots
          where quote_currency = 'TRY' and rate_date <= $1::date
          order by base_currency, rate_date desc, id desc`,
        [today],
      )
      .catch(() => ({ rows: [] as Array<{ base_currency: string; rate: string }> })),
  ]);

  const fxMap = new Map<string, number>([["TRY", 1]]);
  for (const r of fxRes.rows) {
    const parsed = rateOrNull(r.rate);
    if (parsed != null && parsed > 0) fxMap.set(r.base_currency.toUpperCase(), parsed);
  }

  const cashTry = canonical.treasuryCash.availableNowTry;
  const cashForeignBuckets: CurrencyAmountBucket[] = canonical.treasuryCash.foreignBuckets.map((b) => ({
    currency: b.currency,
    total: b.availableNow,
    count: b.accountCount,
  }));
  const cashCons = consolidateBucketsTry(cashTry, cashForeignBuckets, fxMap);
  const out7Cons = consolidateBucketsTry(outflow7d.tryRemainingTotal, outflow7d.foreignBuckets, fxMap);
  const arCons = consolidateBucketsTry(canonical.openReceivables.tryTotal, canonical.openReceivables.foreignBuckets, fxMap);
  const apCons = consolidateBucketsTry(canonical.openPayables.tryTotal, canonical.openPayables.foreignBuckets, fxMap);

  const arNote = formatForeignBucketNote(canonical.openReceivables.foreignBuckets);
  const apNote = formatForeignBucketNote(canonical.openPayables.foreignBuckets);
  const out7Note = formatForeignBucketNote(outflow7d.foreignBuckets);
  const cashForeignNote = formatForeignBucketNote(cashForeignBuckets);

  return (
    <div className="space-y-4">
      <PageHeader
        title="İçgörüler — Kanonik Finansal Özet & Karar Merkezi"
        subtitle="TCMB spot kurlarıyla konsolide edilmiş çoklu döviz göstergeleri ve kanıtlı karar araçları."
        meta={
          <Badge tone="neutral" dot>
            {today} itibarıyla kanonik doğrulama
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KeyStat
          label="Konsolide Kullanılabilir Nakit"
          value={cashCons.consolidatedTry == null ? "Açılış belirsiz" : fmtTL(cashCons.consolidatedTry)}
          tone={cashCons.consolidatedTry == null ? "warn" : cashCons.consolidatedTry < 0 ? "neg" : "pos"}
          href="/finance/treasury"
          sub={
            cashTry == null
              ? `${canonical.treasuryCash.unknownOpeningCountTry} TRY hesabında açılış bakiyesi eksik`
              : `TRY: ${fmtTL(cashTry)}${cashForeignNote ? ` · Döviz: ${cashForeignNote}` : ""}`
          }
        />
        <KeyStat
          label="7 Günlük Konsolide Çıkış"
          value={fmtTL(out7Cons.consolidatedTry ?? outflow7d.tryRemainingTotal)}
          tone={(out7Cons.consolidatedTry ?? outflow7d.tryRemainingTotal) > 0 ? "warn" : "neutral"}
          href="/payments"
          sub={`TRY: ${fmtTL(outflow7d.tryRemainingTotal)} (${outflow7d.tryOpenCount} kalem)${out7Note ? ` · ${out7Note}` : ""}`}
        />
        <KeyStat
          label="Konsolide Açık Alacak"
          value={fmtTL(arCons.consolidatedTry ?? canonical.openReceivables.tryTotal)}
          tone={canonical.openReceivables.overdueCount > 0 ? "warn" : "pos"}
          href="/finance/invoices?direction=sales"
          sub={`TRY: ${fmtTL(canonical.openReceivables.tryTotal)} · ${canonical.openReceivables.overdueCount} gecikmiş${arNote ? ` · ${arNote}` : ""}`}
        />
        <KeyStat
          label="Konsolide Açık Borç"
          value={fmtTL(apCons.consolidatedTry ?? canonical.openPayables.tryTotal)}
          tone={canonical.openPayables.overdueCount > 0 ? "neg" : "neutral"}
          href="/finance/invoices?direction=purchase"
          sub={`TRY: ${fmtTL(canonical.openPayables.tryTotal)} · ${canonical.openPayables.overdueCount} gecikmiş${apNote ? ` · ${apNote}` : ""}`}
        />
      </div>

      <Panel
        title="İçgörü Yüzeyleri"
        subtitle="Kanıtlı SQL soru-cevap, sabah brifingi, CFO nakit köprüsü ve yönetim kurulu finansal paketleri"
      >
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {INSIGHT_SURFACES.map((surface) => (
            <Link
              key={surface.href}
              href={surface.href}
              className="card-hover border p-3"
              style={{
                borderColor: "var(--line)",
                borderRadius: "var(--radius)",
                background: "var(--surface-2)",
              }}
            >
              <div className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                {surface.title}
              </div>
              <div className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
                {surface.desc}
              </div>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
