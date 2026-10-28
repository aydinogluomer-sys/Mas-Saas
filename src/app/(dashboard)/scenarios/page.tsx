import { getPool } from "@/lib/db";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { runScenarioAction } from "./actions";
import { ScenarioInteractiveSandbox } from "@/components/scenarios/scenario-interactive-sandbox";

export const dynamic = "force-dynamic";

const presets = [
  { n: "Gelir %10 düşerse", r: "-10", e: "" },
  { n: "Gider %10 artarsa", r: "", e: "10" },
  { n: "Gelir %10 artarsa", r: "10", e: "" },
];

export default async function NewScenarioPage() {
  const months = await loadCashMonths(getPool());
  const field = "mt-1 w-full border border-line bg-transparent p-2 rounded";

  return (
    <>
      <PageHeader
        title="Yeni Senaryo"
        subtitle="Kaynak kayıtlarını değiştirmeyen what-if çalışması"
        meta={<span className="text-xs text-warn">Tahmindir; muhasebe gerçeği değildir.</span>}
      />

      <Panel title="CANLI SİMÜLASYON & WHAT-IF KUM HAVUZU">
        <ScenarioInteractiveSandbox months={months} disabled={!months.length} />
      </Panel>

      <Panel title="Hazır senaryolar">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <form key={p.n} action={runScenarioAction}>
              <input type="hidden" name="name" value={p.n} />
              <input type="hidden" name="revenuePct" value={p.r} />
              <input type="hidden" name="expensePct" value={p.e} />
              <button className="button-ghost px-3 py-2" disabled={!months.length}>
                {p.n}
              </button>
            </form>
          ))}
        </div>
      </Panel>

      <Panel title="Gelişmiş varsayımlar">
        <form action={runScenarioAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs">
            Senaryo adı
            <input required name="name" className={field} />
          </label>
          <label className="text-xs">
            Gelir değişimi %
            <input name="revenuePct" type="number" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Gider değişimi %
            <input name="expensePct" type="number" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Genel müşteri gecikmesi (ay)
            <input name="customerDelayMonths" type="number" min="0" className={field} />
          </label>
          <label className="text-xs">
            Hedef tahsilat etiketi
            <input name="targetIncomeLabel" placeholder="Hpt" className={field} />
          </label>
          <label className="text-xs">
            Tahsilat gecikmesi (ay)
            <input name="targetIncomeDelayMonths" type="number" min="0" className={field} />
          </label>
          <label className="text-xs">
            Hedef ödeme etiketi
            <input name="targetOutflowLabel" placeholder="Çağdaş" className={field} />
          </label>
          <label className="text-xs">
            Ödeme ertelemesi (ay)
            <input name="targetOutflowDelayMonths" type="number" min="0" className={field} />
          </label>
          <label className="text-xs">
            Faktoring tahsilat etiketi
            <input name="factoringIncomeLabel" placeholder="Hpt" className={field} />
          </label>
          <label className="text-xs">
            Faktoring öne çekme ayı
            <input name="factoringAdvanceMonth" type="month" className={field} />
          </label>
          <label className="text-xs">
            Faktoring maliyeti %
            <input name="factoringFeePct" type="number" min="0" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Kapasite kullanımı %
            <input name="capacityUtilizationPct" type="number" min="0" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Verim değişimi %
            <input name="efficiencyPct" type="number" step="0.1" className={field} />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input name="includeDebtService" type="checkbox" />
            Borç servisini giderlere ekle
          </label>
          <div className="lg:col-span-3">
            <button className="button-accent px-3 py-2" disabled={!months.length}>
              Senaryoyu çalıştır
            </button>
            <p className="mt-2 text-xs text-tone-3">
              Bilinmeyen tutarlar sıfır sayılmaz. Onaylı dış varsayımlar bağlam olarak kaydedilir.
            </p>
          </div>
        </form>
      </Panel>
    </>
  );
}
