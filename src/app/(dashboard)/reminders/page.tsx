import { getPool } from "@/lib/db";
import { deliveryCounts, loadDeliveries } from "@/lib/reminders/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { dispatchRemindersAction, scheduleRemindersAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = { pending: "amber", sent: "green", failed: "red", skipped: "neutral" };
const OFFSET_LABEL: Record<number, string> = { 7: "7 gün önce", 3: "3 gün önce", 1: "1 gün önce", 0: "bugün", [-1]: "gecikme" };

export default async function RemindersPage() {
  const pool = getPool();
  const [counts, deliveries] = await Promise.all([deliveryCounts(pool), loadDeliveries(pool)]);
  const today = istanbulDateISO();

  return (
    <>
      <Panel title={`HATIRLATMA — bugün ${today} (Europe/Istanbul)`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["pending", "sent", "failed", "skipped"] as const).map((k) => (
            <div key={k} className="border border-zinc-800 bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{k}</div>
              <div className={`font-mono text-lg tabular-nums ${k === "failed" ? "text-red-400" : k === "sent" ? "text-emerald-400" : "text-zinc-200"}`}>
                <Num>{counts[k]}</Num>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={scheduleRemindersAction}>
            <button type="submit" className="border border-sky-700 bg-sky-950/40 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-sky-300">
              bugünü planla →
            </button>
          </form>
          <form action={dispatchRemindersAction}>
            <button type="submit" className="border border-emerald-700 bg-emerald-950/40 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-emerald-300">
              bekleyenleri gönder (Telegram) →
            </button>
          </form>
        </div>
        <p className="mt-2 font-mono text-[10px] text-zinc-500">
          Planlama, ödenmemiş kalemler için aktif kuralları bugüne uygular (aynı kayıt tekrar planlanmaz — DB
          benzersiz anahtar). Gönderim server-only Telegram token ister; tanımlı değilse teslimat &quot;failed&quot;
          olarak <em>loglanır</em> (hiçbir mali kayıt değişmez).
        </p>
      </Panel>

      <Panel title={`TESLİMAT KAYDI — ${deliveries.length}`}>
        {deliveries.length === 0 ? (
          <p className="text-sm text-zinc-500">Henüz teslimat yok. &quot;Bugünü planla&quot; ile başlayın.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">planlanan</th>
                  <th className="py-1 pr-2">kural</th>
                  <th className="py-1 pr-2">kalem</th>
                  <th className="py-1 pr-2">durum</th>
                  <th className="py-1">gönderim / hata</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-zinc-900 align-top">
                    <td className="py-1.5 pr-2 font-mono text-xs">{d.scheduled_for}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px] text-zinc-400">{OFFSET_LABEL[d.offset_days] ?? d.rule_name}</td>
                    <td className="py-1.5 pr-2 text-xs">{d.target_name}</td>
                    <td className="py-1.5 pr-2"><Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Badge></td>
                    <td className="py-1.5 font-mono text-[10px] text-zinc-500">
                      {d.status === "sent" ? d.sent_at : d.error ? <span className="text-red-400">{d.error}</span> : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
