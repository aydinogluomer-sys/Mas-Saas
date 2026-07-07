import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  loadCashMonths, validateContinuity, writeSnapshots,
} from "@/lib/cashflow/engine";
import { buildProjection, concentration, horizonCards } from "@/lib/radar/rules";
import { loadDebtOverlay } from "@/lib/reports/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";
import { ChartShell, DetailsDisclosure, KpiCard, PageHeader, StatBox, TableShell } from "@/components/ui/shell";
import { CashTrendChart, ConcentrationBars, IncomeExpenseChart } from "@/components/cashflow/charts";

const PRESSURE_TONE: Record<string, Tone> = { high: "red", watch: "amber", none: "neutral" };

export const dynamic = "force-dynamic";

const AYK = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");

export default async function CashflowPage({
  searchParams,
}: { searchParams: Promise<{ months?: string; lines?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const months = await loadCashMonths(pool);

  if (months.length === 0) {
    return (
      <Panel title="NAKİT AKIŞ">
        <p className="text-sm text-zinc-500">
          Henüz nakit akış ayı yok. <Link className="underline underline-offset-2" href="/imports">İçe aktarım</Link> sayfasından
          workbook detayına girip &quot;nakit akışını aktar&quot; ile başlayın. Açık/ret incelemeli aylar aktarılmaz.
        </p>
      </Panel>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const [cont] = await Promise.all([validateContinuity(pool)]);
  await writeSnapshots(pool, today); // gün-idempotent

  const proj = buildProjection(months);
  const cards = horizonCards(months, today.slice(0, 7) + "-01");
  const negMonths = months.filter((m) => m.closing != null && m.closing < 0);
  const openChain = await pool.query(
    `select count(*)::int as n from public.mapping_reviews
     where issue_type in ('continuity_break','month_gap') and status='open'`,
  );

  const [incomeLines, vendorLines] = await Promise.all([
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='customer_income'`),
    pool.query(`select coalesce(p.name, cl.label) as key, cl.amount::float8 as amount
                from public.cashflow_lines cl left join public.parties p on p.id=cl.party_id
                where cl.line_type='vendor_payment'`),
  ]);
  const incomeConc = concentration(incomeLines.rows);
  const vendorConc = concentration(vendorLines.rows);
  const lineCounts = await pool.query(
    `select cashflow_month_id, count(*)::int as n from public.cashflow_lines group by 1`,
  );
  const countOf = new Map(lineCounts.rows.map((r) => [r.cashflow_month_id, r.n]));

  // Phase 6A: debt-service (çek + kredi taksiti) overlay onto projected closing balance
  const overlay = await loadDebtOverlay(pool);
  const overlayOf = new Map(overlay.map((o) => [o.monthStart, o]));
  const highPressure = overlay.filter((o) => o.pressure === "high").length;

  return (
    <>
      <PageHeader
        title="Nakit Akış Radarı"
        subtitle={`${months.length} aylık projeksiyon (${months[0].monthStart.slice(0, 7)}..${months[months.length - 1].monthStart.slice(0, 7)}) · devir → gelir → gider → kasa`}
        meta={
          <>
            {proj.firstNegativeMonth
              ? <Badge tone="red">ilk negatif {AYK(proj.firstNegativeMonth)}</Badge>
              : <Badge tone="green" dot>negatif ay yok</Badge>}
            {highPressure > 0 && <Badge tone="red">{highPressure} ay borç baskısı</Badge>}
            {openChain.rows[0].n > 0
              ? <Badge tone="amber">{openChain.rows[0].n} zincir sorunu</Badge>
              : <Badge tone="neutral" dot>zincir temiz</Badge>}
          </>
        }
        action={
          <Link
            href="/scenarios?from=cashflow"
            className="border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors"
            style={{ color: "var(--accent)", borderColor: "var(--accent)", borderRadius: "var(--radius)", background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}
          >
            senaryo üret →
          </Link>
        }
      />

      {sp.months != null && (
        <Panel title="AKTARIM SONUCU" accent="pos">
          <p className="text-sm" style={{ color: "var(--text-2)" }}><Num>{sp.months}</Num> ay · <Num>{sp.lines}</Num> satır aktarıldı (tekrar güvenli).</p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cards.map((c) => (
          <KpiCard
            key={c.horizonMonths}
            label={`${c.horizonMonths} ay`}
            value={c.endClosing != null ? fmtTL(c.endClosing) : "—"}
            tone={c.endClosing != null && c.endClosing < 0 ? "neg" : "neutral"}
            badge={c.truncated ? <Badge tone="neutral">veri sonu</Badge> : c.firstNegativeInside ? <Badge tone="red">neg {AYK(c.firstNegativeInside)}</Badge> : undefined}
            note={
              <>
                {AYK(c.toMonth)} sonu · min {c.minClosing != null ? fmtTL(c.minClosing) : "—"}
                {c.missingCount > 0 && <span style={{ color: "var(--warn)" }}> · {c.missingCount} eksik ay</span>}
              </>
            }
          />
        ))}
      </div>

      <Panel title="NEGATİF KASA UYARILARI"
        right={openChain.rows[0].n > 0 ? <Badge tone="red">{openChain.rows[0].n} zincir sorunu</Badge> : <Badge tone="green" dot>zincir temiz</Badge>}
        accent={proj.firstNegativeMonth ? "neg" : undefined}>
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <StatBox k="ilk negatif ay" v={proj.firstNegativeMonth ? AYK(proj.firstNegativeMonth) : "yok"} tone={proj.firstNegativeMonth ? "neg" : "pos"} />
          <StatBox k="en kötü ay" v={`${AYK(proj.worstMonth)} · ${proj.worstBalance != null ? fmtTL(proj.worstBalance) : "—"}`} tone="neg" />
          <StatBox k="negatif ay / en uzun seri" v={<><Num>{negMonths.length}</Num> ay · <Num>{proj.longestNegativeRun.length}</Num> ardışık{proj.longestNegativeRun.from ? ` (${AYK(proj.longestNegativeRun.from)}→)` : ""}</>} />
        </div>
        {cont.breaks > 0 && (
          <p className="mt-2 font-mono text-[11px]" style={{ color: "var(--neg)" }}>
            Devir zinciri kırıkları bayraklandı (sessiz düzeltme YAPILMAZ) — İçe Aktarım &gt; incelemelerde.
          </p>
        )}
      </Panel>

      <ChartShell
        title="Kasa Trendi — 35 ay"
        hint="kesikli çizgi sıfır kasa"
        source="Kaynak: nakit akış aylık sekmeleri (kaynak mutabakatı ±0,5 TL)."
        summary={`Kasa ${months[0].monthStart.slice(0, 7)} ile ${months[months.length - 1].monthStart.slice(0, 7)} arası. İlk negatif ay ${AYK(proj.firstNegativeMonth)}, en kötü ay ${AYK(proj.worstMonth)} ${proj.worstBalance != null ? fmtTL(proj.worstBalance) : ""}.`}
      >
        <CashTrendChart months={months} firstNegative={proj.firstNegativeMonth} worstMonth={proj.worstMonth} />
      </ChartShell>

      <ChartShell title="Aylık Gelir vs Gider" hint="gelir üstte, gider altta" source="Bilinmeyen tutarlar çizilmez (0 sayılmaz).">
        <IncomeExpenseChart months={months} />
      </ChartShell>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel title="MÜŞTERİ GELİR YOĞUNLAŞMASI">
          <ConcentrationBars entries={incomeConc.entries} unknownCount={incomeConc.unknownCount} />
        </Panel>
        <Panel title="TEDARİKÇİ / CARİ ÖDEME YOĞUNLAŞMASI">
          <ConcentrationBars entries={vendorConc.entries} unknownCount={vendorConc.unknownCount} />
        </Panel>
      </div>

      <DetailsDisclosure label={`Aylık detay tablosu — ${months.length} ay${highPressure > 0 ? ` · ${highPressure} ayda borç baskısı` : ""}`}>
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">ay</th>
                <th className="py-1 pr-2 text-right">devir</th>
                <th className="py-1 pr-2 text-right">gelir</th>
                <th className="py-1 pr-2 text-right">gider</th>
                <th className="py-1 pr-2 text-right">fark</th>
                <th className="py-1 pr-2 text-right">kasa</th>
                <th className="py-1 pr-2 text-right">borç servisi</th>
                <th className="py-1">satır</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const cell = (v: number | null) => (
                  <td className={`py-1 pr-2 text-right font-mono tabular-nums ${v != null && v < 0 ? "text-red-400" : ""}`}>
                    {v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—"}
                  </td>
                );
                const o = overlayOf.get(m.monthStart);
                return (
                  <tr key={m.id} className="border-b border-zinc-900">
                    <td className="py-1 pr-2 font-mono text-xs">
                      <Link className="underline decoration-zinc-700 underline-offset-2" href={`/cashflow/${m.id}`}>
                        {AYK(m.monthStart)}
                      </Link>
                    </td>
                    {cell(m.opening)}{cell(m.income)}{cell(m.expense)}
                    {cell(m.income != null && m.expense != null ? m.income - m.expense : null)}
                    {cell(m.closing)}
                    <td className="py-1 pr-2 text-right font-mono text-xs tabular-nums">
                      {o && o.debtOutflow > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          {o.pressure !== "none" && <Badge tone={PRESSURE_TONE[o.pressure]}>{o.pressure === "high" ? "baskı" : "izle"}</Badge>}
                          <span className={o.pressure === "high" ? "text-red-400" : "text-zinc-400"}>
                            {new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(o.debtOutflow)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="py-1 font-mono text-xs text-zinc-500">{countOf.get(m.id) ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
          Borç servisi = o ay vadesi gelen çek + kredi taksiti (bilinen). Kırmızı &quot;baskı&quot; = negatif kasa + borç yükü;
          amber &quot;izle&quot; = kasa pozitif ama borç yükü kayda değer.
        </p>
      </DetailsDisclosure>
    </>
  );
}
