import Link from "next/link";
import { getPool } from "@/lib/db";
import { listScenarioRuns } from "@/lib/scenarios/engine";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Disclaimer, DetailsDisclosure, PageHeader } from "@/components/ui/shell";
import { runScenarioAction } from "./actions";

export const dynamic = "force-dynamic";

const CONF_TONE: Record<string, Tone> = { high: "green", medium: "amber", low: "red" };
const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

export default async function ScenariosPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const sp = await searchParams;
  const pool = getPool();
  const [runs, baseline] = await Promise.all([listScenarioRuns(pool), loadCashMonths(pool)]);
  const hasBaseline = baseline.length > 0;

  return (
    <>
      <PageHeader
        title="Senaryo Motoru"
        subtitle="Salt-okunur what-if: gelir/gider/gecikme/kapasite/verim + borç-servisi overlay"
        meta={
          <>
            <Badge tone="violet" dot>{runs.length} çalışma</Badge>
            {hasBaseline && <Badge tone="neutral">baz {baseline.length} ay</Badge>}
            {sp.from && <Badge tone="neutral">kaynak: {sp.from}</Badge>}
          </>
        }
      />

      <Disclaimer tone="accent">⚠ Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez.</Disclaimer>

      {!hasBaseline ? (
        <Panel title="SENARYO ÇALIŞTIR">
          <p className="text-sm" style={{ color: "var(--text-3)" }}>
            Baz veri yok. Önce{" "}
            <Link className="underline underline-offset-2" href="/cashflow">nakit akışını</Link> aktarın.
          </p>
        </Panel>
      ) : (
        <>
          {/* Hızlı senaryolar: yalnız motorun BİREBİR desteklediği varsayımlar */}
          <Panel title="HIZLI SENARYOLAR"
            subtitle={`Baz: nakit akış ${baseline.length} ay (${baseline[0].monthStart.slice(0, 7)}..${baseline[baseline.length - 1].monthStart.slice(0, 7)})${sp.from ? ` · kaynak: ${sp.from}` : ""}`}>
            <div className="flex flex-wrap gap-2">
              <Preset name="Gelir %10 düşerse" fields={{ revenuePct: "-10" }} />
              <Preset name="Gider %10 artarsa" fields={{ expensePct: "10" }} />
              <Preset name="Borç-servisi dahil edilirse" fields={{ includeDebtService: "on" }} />
              <Preset name="Hpt 1 ay gecikirse" fields={{ targetIncomeLabel: "Hpt", targetIncomeDelayMonths: "1" }} />
              <Preset name="Akon 2 ay kayarsa" fields={{ targetIncomeLabel: "Akon", targetIncomeDelayMonths: "2" }} />
              <Preset name="Cagdas 1 ay otelenirse" fields={{ targetOutflowLabel: "Cagdas", targetOutflowDelayMonths: "1" }} />
            </div>
            <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
              Her preset adı ne diyorsa motor tam onu uygular. Belirsiz tutar sıfır sayılmaz.
            </p>
          </Panel>

          <DetailsDisclosure label="Gelişmiş senaryo — özel varsayımlar">
            <form action={runScenarioAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Senaryo adı" name="name" type="text" placeholder="ör. Gelir %10 düşer + borç servisi" full />
              <Field label="Gelir değişimi %" name="revenuePct" hint="ör. -10 = %10 düşüş" />
              <Field label="Gider değişimi %" name="expensePct" hint="ör. +15 = %15 artış" />
              <Field label="Müşteri gecikmesi (ay)" name="customerDelayMonths" hint="tüm tahsilatı N ay ileri kaydırır" />
              <Field label="Hedef gelir etiketi" name="targetIncomeLabel" type="text" hint="or. Hpt, Akon, musteri adi" />
              <Field label="Hedef gelir gecikmesi (ay)" name="targetIncomeDelayMonths" hint="yalniz eslesen gelir satirlari kayar" />
              <Field label="Hedef gider/odeme etiketi" name="targetOutflowLabel" type="text" hint="or. Cagdas, Garanti, tedarikci" />
              <Field label="Hedef gider ertelemesi (ay)" name="targetOutflowDelayMonths" hint="yalniz eslesen outflow satirlari kayar" />
              <Field label="Faktoring gelir etiketi" name="factoringIncomeLabel" type="text" hint="gelecek tahsilati bugune/aya cek" />
              <Field label="Faktoring advance ay" name="factoringAdvanceMonth" type="text" placeholder="2026-06" hint="YYYY-MM" />
              <Field label="Faktoring/iskonto %" name="factoringFeePct" hint="or. 4 = %4 maliyet" />
              <Field label="Kapasite kullanım %" name="capacityUtilizationPct" hint="gelir vekili (üretim verisine bağlı değil)" />
              <Field label="Verim %" name="efficiencyPct" hint="gider vekili (artış=gider düşer)" />
              <input type="hidden" name="scenarioType" value="combined_custom_scenario" />
              <label className="flex items-center gap-2 text-[12px]" style={{ color: "var(--text-2)" }}>
                <input type="checkbox" name="includeDebtService" className="accent-violet-500" />
                Borç-servisi overlay dahil et (çek + kredi taksiti gidere eklensin)
              </label>
              <div className="sm:col-span-2">
                <button type="submit" className="border px-4 py-2 font-mono text-[11px] uppercase tracking-wider"
                  style={{ color: "var(--accent)", borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)", borderRadius: "var(--radius)" }}>
                  senaryoyu çalıştır →
                </button>
                <span className="ml-2 text-[11px]" style={{ color: "var(--text-4)" }}>boş bırakılan varsayım uygulanmaz</span>
              </div>
            </form>
          </DetailsDisclosure>
        </>
      )}

      <DetailsDisclosure label={`Geçmiş senaryo çalışmaları — ${runs.length}`} defaultOpen={runs.length > 0}>
        {runs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-3)" }}>Henüz senaryo çalıştırılmadı.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">ad</th>
                <th className="py-1 pr-2 text-right">final Δ</th>
                <th className="py-1 pr-2">ilk negatif</th>
                <th className="py-1 pr-2">güven</th>
                <th className="py-1">çalıştırma</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-2">
                    <Link className="underline decoration-zinc-700 underline-offset-2 hover:text-white" href={`/scenarios/${r.id}`}>{r.name}</Link>
                  </td>
                  <td className={`py-1.5 pr-2 text-right font-mono tabular-nums ${r.final_delta != null && r.final_delta < 0 ? "text-red-400" : r.final_delta != null && r.final_delta > 0 ? "text-emerald-400" : ""}`}>
                    {r.final_delta != null ? (r.final_delta > 0 ? "+" : "") + fmt0(r.final_delta) : "—"}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs">{r.scen_first_neg ? r.scen_first_neg.slice(0, 7) : "yok"}</td>
                  <td className="py-1.5 pr-2"><Badge tone={CONF_TONE[r.confidence] ?? "neutral"}>{r.confidence}</Badge></td>
                  <td className="py-1.5 font-mono text-[10px] text-zinc-500">{r.run_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </DetailsDisclosure>
    </>
  );
}

/** Quick preset: a one-click form that reuses the unchanged runScenarioAction. */
function Preset({ name, fields }: { name: string; fields: Record<string, string> }) {
  return (
    <form action={runScenarioAction}>
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="scenarioType" value="combined_custom_scenario" />
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className="card-hover border px-3 py-2 text-[12px]"
        style={{ color: "var(--accent)", borderColor: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", borderRadius: "var(--radius)" }}>
        {name} →
      </button>
    </form>
  );
}

function Field({ label, name, type = "number", hint, placeholder, full }: {
  label: string; name: string; type?: string; hint?: string; placeholder?: string; full?: boolean;
}) {
  return (
    <label className={`block ${full ? "sm:col-span-2" : ""}`}>
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <input
        name={name} type={type} step="any" placeholder={placeholder}
        className="mt-1 w-full border border-zinc-700 bg-black/40 px-2 py-1.5 font-mono text-sm text-zinc-200 outline-none focus:border-zinc-500"
      />
      {hint && <span className="mt-0.5 block font-mono text-[9px] text-zinc-600">{hint}</span>}
    </label>
  );
}
