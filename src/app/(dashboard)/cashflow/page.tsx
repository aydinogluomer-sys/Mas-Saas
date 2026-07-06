import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  loadCashMonths, validateContinuity, writeSnapshots,
} from "@/lib/cashflow/engine";
import { buildProjection, concentration, horizonCards } from "@/lib/radar/rules";
import { loadDebtOverlay } from "@/lib/reports/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";
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
      {sp.months != null && (
        <Panel title="AKTARIM SONUCU">
          <p className="text-sm"><Num>{sp.months}</Num> ay · <Num>{sp.lines}</Num> satır aktarıldı (tekrar güvenli).</p>
        </Panel>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cards.map((c) => (
          <div key={c.horizonMonths} className="border border-zinc-800 bg-zinc-950 p-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{c.horizonMonths} AY</span>
              {c.truncated && <Badge tone="neutral">veri sonu</Badge>}
            </div>
            <div className={`mt-1 font-mono text-sm tabular-nums ${c.endClosing != null && c.endClosing < 0 ? "text-red-400" : "text-zinc-200"}`}>
              {c.endClosing != null ? fmtTL(c.endClosing) : "—"}
            </div>
            <div className="font-mono text-[9px] text-zinc-500">{AYK(c.toMonth)} sonu kasa</div>
            <div className="mt-1 font-mono text-[9px] text-zinc-500">
              min {c.minClosing != null ? fmtTL(c.minClosing) : "—"} ({AYK(c.minMonth)})
            </div>
            {c.firstNegativeInside && (
              <div className="mt-1"><Badge tone="red">ilk negatif: {AYK(c.firstNegativeInside)}</Badge></div>
            )}
            {c.missingCount > 0 && <div className="mt-1 font-mono text-[9px] text-amber-400">{c.missingCount} ay eksik veri</div>}
          </div>
        ))}
      </div>

      <Panel title="NEGATİF KASA UYARILARI"
        right={openChain.rows[0].n > 0 ? <Badge tone="red">{openChain.rows[0].n} zincir sorunu</Badge> : <Badge tone="green">zincir temiz</Badge>}>
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div className="border border-zinc-800 bg-black/40 p-2">
            <div className="font-mono text-[9px] uppercase text-zinc-500">ilk negatif ay</div>
            <div className={`font-mono ${proj.firstNegativeMonth ? "text-red-400" : "text-emerald-400"}`}>
              {proj.firstNegativeMonth ? AYK(proj.firstNegativeMonth) : "yok"}
            </div>
          </div>
          <div className="border border-zinc-800 bg-black/40 p-2">
            <div className="font-mono text-[9px] uppercase text-zinc-500">en kötü ay</div>
            <div className="font-mono text-red-400">
              {AYK(proj.worstMonth)} · {proj.worstBalance != null ? fmtTL(proj.worstBalance) : "—"}
            </div>
          </div>
          <div className="border border-zinc-800 bg-black/40 p-2">
            <div className="font-mono text-[9px] uppercase text-zinc-500">negatif ay sayısı / en uzun seri</div>
            <div className="font-mono"><Num>{negMonths.length}</Num> ay · <Num>{proj.longestNegativeRun.length}</Num> ardışık{proj.longestNegativeRun.from ? ` (${AYK(proj.longestNegativeRun.from)}→)` : ""}</div>
          </div>
        </div>
        {cont.breaks > 0 && (
          <p className="mt-2 font-mono text-[11px] text-red-400">
            Devir zinciri kırıkları bayraklandı (sessiz düzeltme YAPILMAZ) — İçe Aktarım &gt; incelemelerde.
          </p>
        )}
      </Panel>

      <div className="flex justify-end">
        <Link href="/scenarios?from=cashflow" className="border border-violet-800 bg-violet-950/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          bu nakit akıştan senaryo üret →
        </Link>
      </div>

      <Panel title="KASA TRENDİ — 35 AY">
        <CashTrendChart months={months} firstNegative={proj.firstNegativeMonth} worstMonth={proj.worstMonth} />
      </Panel>

      <Panel title="AYLIK GELİR vs GİDER">
        <IncomeExpenseChart months={months} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Panel title="MÜŞTERİ GELİR YOĞUNLAŞMASI">
          <ConcentrationBars entries={incomeConc.entries} unknownCount={incomeConc.unknownCount} />
        </Panel>
        <Panel title="TEDARİKÇİ / CARİ ÖDEME YOĞUNLAŞMASI">
          <ConcentrationBars entries={vendorConc.entries} unknownCount={vendorConc.unknownCount} />
        </Panel>
      </div>

      <Panel
        title={`AYLAR — ${months.length}`}
        right={highPressure > 0 ? <Badge tone="red">{highPressure} ayda borç-servisi baskısı</Badge> : undefined}
      >
        <div className="overflow-x-auto">
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
        </div>
        <p className="mt-2 font-mono text-[10px] text-zinc-600">
          Borç servisi = o ay vadesi gelen çek + kredi taksiti (bilinen). Kırmızı &quot;baskı&quot; = negatif kasa + borç yükü;
          amber &quot;izle&quot; = kasa pozitif ama borç yükü kayda değer.
        </p>
      </Panel>
    </>
  );
}
