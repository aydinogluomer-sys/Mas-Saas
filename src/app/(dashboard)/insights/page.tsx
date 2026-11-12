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
import { formatForeignBucketNote } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const INSIGHT_SURFACES = [
  {
    href: "/insights/ask",
    title: "Sor (Kanıtlı CFO Asistanı)",
    desc: "Nakit, vade, kredi, çek ve tahsilat sorularını SQL kanıtı ve kaynak bağlantılarıyla yanıtlar.",
  },
  {
    href: "/insights/briefing",
    title: "Sabah CFO Brifingi",
    desc: "Likidite açığı, vadesi geçen tahsilat sözleri, kontrol alarmları ve kanal gönderimi.",
  },
  {
    href: "/insights/analysis",
    title: "Analiz & İşletme Sermayesi",
    desc: "Nakit köprüsü, yaşlandırma ısı haritası, DSO/DPO/CCC trendi ve tarihsel metrik snapshot'ları.",
  },
  {
    href: "/insights/reports",
    title: "Yönetim Raporları",
    desc: "Günlük, haftalık ve aylık donmuş yönetim raporları ve brifing dağıtımı.",
  },
  {
    href: "/insights/reminders",
    title: "Hatırlatma Kuralları & Teslimat",
    desc: "Ödeme, çek ve kredi taksit vadeleri için e-posta / Telegram hatırlatma motoru.",
  },
  {
    href: "/insights/tasks",
    title: "Aksiyon & Görev Takibi",
    desc: "Kokpit ve veri kalitesi bulgularından açılan operasyonel görevlerin takibi.",
  },
] as const;

export default async function InsightsOverviewPage() {
  const denied = await requireRouteAccess("/insights");
  if (denied) return denied;

  const today = istanbulDateISO();
  const pool = getPool();
  const [canonical, outflow7d] = await Promise.all([
    loadCanonicalKpis(pool, today),
    loadCanonicalOutflow7dKpi(pool, today),
  ]);

  const cashTry = canonical.treasuryCash.availableNowTry;
  const cashForeignNote =
    canonical.treasuryCash.foreignBuckets.length > 0
      ? `${canonical.treasuryCash.foreignBuckets.length} döviz kovası ayrı izlenir`
      : null;
  const arNote = formatForeignBucketNote(canonical.openReceivables.foreignBuckets);
  const apNote = formatForeignBucketNote(canonical.openPayables.foreignBuckets);
  const out7Note = formatForeignBucketNote(outflow7d.foreignBuckets);

  return (
    <div className="space-y-4">
      <PageHeader
        title="İçgörüler — Kanonik Finansal Özet & Karar Merkezi"
        subtitle="Sayfalanmamış tam defter ve hazine görünümlerinden (FIN-03 uyumlu) doğrulanan anlık göstergeler."
        meta={
          <Badge tone="neutral" dot>
            {today} itibarıyla kanonik doğrulama
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KeyStat
          label="Kullanılabilir TRY Nakit"
          value={cashTry == null ? "Açılış belirsiz" : fmtTL(cashTry)}
          tone={cashTry == null ? "warn" : cashTry < 0 ? "neg" : "pos"}
          href="/finance/treasury"
          sub={
            cashTry == null
              ? `${canonical.treasuryCash.unknownOpeningCountTry} TRY hesabında açılış bakiyesi eksik`
              : `${canonical.treasuryCash.accountCountTry} aktif TRY hesabı${cashForeignNote ? ` · ${cashForeignNote}` : ""}`
          }
        />
        <KeyStat
          label="7 Günlük Kalan Çıkış"
          value={fmtTL(outflow7d.tryRemainingTotal)}
          tone={outflow7d.tryRemainingTotal > 0 ? "warn" : "neutral"}
          href="/payments"
          sub={`${outflow7d.tryOpenCount} TRY açık ödeme${outflow7d.missingAmountCount > 0 ? ` · ${outflow7d.missingAmountCount} tutar eksik` : ""}${out7Note ? ` · ${out7Note}` : ""}`}
        />
        <KeyStat
          label="Açık Alacak (TRY)"
          value={fmtTL(canonical.openReceivables.tryTotal)}
          tone={canonical.openReceivables.overdueCount > 0 ? "warn" : "pos"}
          href="/finance/invoices?direction=sales"
          sub={`${canonical.openReceivables.tryCount} TRY fatura · ${canonical.openReceivables.overdueCount} gecikmiş${arNote ? ` · ${arNote}` : ""}`}
        />
        <KeyStat
          label="Açık Borç (TRY)"
          value={fmtTL(canonical.openPayables.tryTotal)}
          tone={canonical.openPayables.overdueCount > 0 ? "neg" : "neutral"}
          href="/finance/invoices?direction=purchase"
          sub={`${canonical.openPayables.tryCount} TRY fatura · ${canonical.openPayables.overdueCount} gecikmiş${apNote ? ` · ${apNote}` : ""}`}
        />
      </div>

      <Panel
        title="İÇGÖRÜ YÜZEYLERİ"
        subtitle="Soru-cevap, sabah brifingi, işletme sermayesi analizi ve yönetim raporları"
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
