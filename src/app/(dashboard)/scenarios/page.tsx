import Link from "next/link";
import { getPool } from "@/lib/db";
import { listScenarioRuns } from "@/lib/scenarios/engine";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
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
      <div className="border border-violet-800 bg-violet-950/25 px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-violet-300">
          ⚠ Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez.
        </span>
      </div>

      <Panel title="SENARYO ÇALIŞTIR">
        {!hasBaseline ? (
          <p className="text-sm text-zinc-500">
            Baz veri yok. Önce{" "}
            <Link className="underline underline-offset-2" href="/cashflow">nakit akışını</Link> aktarın.
          </p>
        ) : (
          <>
            <p className="mb-3 font-mono text-[11px] text-zinc-500">
              Baz senaryo: nakit akış <b>{baseline.length} ay</b> ({baseline[0].monthStart.slice(0, 7)}..{baseline[baseline.length - 1].monthStart.slice(0, 7)})
              {sp.from ? ` · kaynak: ${sp.from}` : ""}
            </p>
            <form action={runScenarioAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Senaryo adı" name="name" type="text" placeholder="ör. Gelir %10 düşer + borç servisi" full />
              <Field label="Gelir değişimi %" name="revenuePct" hint="ör. -10 = %10 düşüş" />
              <Field label="Gider değişimi %" name="expensePct" hint="ör. +15 = %15 artış" />
              <Field label="Müşteri gecikmesi (ay)" name="customerDelayMonths" hint="tahsilatı N ay ileri kaydırır" />
              <Field label="Kapasite kullanım %" name="capacityUtilizationPct" hint="gelir vekili" />
              <Field label="Verim %" name="efficiencyPct" hint="gider vekili (artış=gider düşer)" />
              <input type="hidden" name="scenarioType" value="combined_custom_scenario" />
              <label className="flex items-center gap-2 font-mono text-[11px] text-zinc-300">
                <input type="checkbox" name="includeDebtService" className="accent-violet-500" />
                Borç-servisi overlay dahil et (çek + kredi taksiti gidere eklensin)
              </label>
              <div className="sm:col-span-2">
                <button type="submit" className="border border-violet-700 bg-violet-950/40 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-violet-200">
                  senaryoyu çalıştır →
                </button>
                <span className="ml-2 text-[11px] text-zinc-500">boş bırakılan varsayım uygulanmaz; belirsiz tutar sıfır sayılmaz</span>
              </div>
            </form>
          </>
        )}
      </Panel>

      <Panel title={`SENARYO ÇALIŞMALARI — ${runs.length}`}>
        {runs.length === 0 ? (
          <p className="text-sm text-zinc-500">Henüz senaryo çalıştırılmadı.</p>
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
      </Panel>
    </>
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
