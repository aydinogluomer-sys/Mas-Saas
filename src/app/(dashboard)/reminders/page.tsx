import { getPool } from "@/lib/db";
import { deliveryCounts, loadDeliveries } from "@/lib/reminders/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import { EmptyState, KpiCard, PageHeader } from "@/components/ui/shell";
import { dispatchRemindersAction, scheduleRemindersAction } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = { pending: "amber", sent: "green", failed: "red", skipped: "neutral" };
const OFFSET_LABEL: Record<number, string> = { 7: "7 gün önce", 3: "3 gün önce", 1: "1 gün önce", 0: "bugün", [-1]: "gecikme" };

export default async function RemindersPage() {
  const pool = getPool();
  const [counts, deliveries] = await Promise.all([deliveryCounts(pool), loadDeliveries(pool)]);
  const today = istanbulDateISO();

  const KTONE: Record<string, "neg" | "pos" | "warn" | "neutral"> = { failed: "neg", sent: "pos", pending: "warn", skipped: "neutral" };
  return (
    <>
      <PageHeader
        title="Hatırlatma"
        subtitle="Teslimat planlama + gönderim kaydı (Europe/Istanbul)"
        meta={
          <>
            <Badge tone="neutral" dot>bugün {today}</Badge>
            {counts.failed > 0 && <Badge tone="red">{counts.failed} başarısız</Badge>}
            {counts.pending > 0 && <Badge tone="amber">{counts.pending} bekleyen</Badge>}
          </>
        }
      />

      <Panel title="DURUM ÖZETİ">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["pending", "sent", "failed", "skipped"] as const).map((k) => (
            <KpiCard key={k} label={k} value={<Num>{counts[k]}</Num>} tone={KTONE[k]} emphasize />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <form action={scheduleRemindersAction}>
            <button type="submit" className="border border-info tint-info px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-info">
              bugünü planla →
            </button>
          </form>
          <form action={dispatchRemindersAction}>
            <button type="submit" className="border border-pos tint-pos px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-pos">
              bekleyenleri gönder (Telegram) →
            </button>
          </form>
        </div>
        <p className="mt-2 font-mono text-[10px] text-tone-3">
          Planlama, ödenmemiş kalemler için aktif kuralları bugüne uygular (aynı kayıt tekrar planlanmaz — DB
          benzersiz anahtar). Gönderim server-only Telegram token ister; tanımlı değilse teslimat &quot;failed&quot;
          olarak <em>loglanır</em> (hiçbir mali kayıt değişmez).
        </p>
      </Panel>

      <Panel title={`TESLİMAT KAYDI — ${deliveries.length}`}>
        {deliveries.length === 0 ? (
          <EmptyState>
            Henüz teslimat yok. &quot;Bugünü planla&quot; aktif kuralları bugüne uygular; aynı kayıt iki kez
            planlanmaz. Gönderim için Telegram token tanımlı olmalıdır.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  <th className="py-1 pr-2">planlanan</th>
                  <th className="py-1 pr-2">kural</th>
                  <th className="py-1 pr-2">kalem</th>
                  <th className="py-1 pr-2">durum</th>
                  <th className="py-1">gönderim / hata</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b border-line-faint align-top">
                    <td className="py-1.5 pr-2 font-mono text-xs">{d.scheduled_for}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px] text-tone-2">{OFFSET_LABEL[d.offset_days] ?? d.rule_name}</td>
                    <td className="py-1.5 pr-2 text-xs">{d.target_name}</td>
                    <td className="py-1.5 pr-2"><Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{d.status}</Badge></td>
                    <td className="py-1.5 font-mono text-[10px] text-tone-3">
                      {d.status === "sent" ? d.sent_at : d.error ? <span className="text-neg">{d.error}</span> : "—"}
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
