import { getPool } from "@/lib/db";
import { loadExposureSummary, loadLatestRates } from "@/lib/fx/engine";
import { STRESS_BANDS } from "@/lib/fx/rules";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { recordRateAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

export default async function FxPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/finance/fx");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [summary, rates, positions] = await Promise.all([
    loadExposureSummary(pool),
    loadLatestRates(pool),
    pool.query(
      `select position_id, currency, position_kind, amount_fx, entry_rate, current_rate,
              book_value_try, current_value_try, unrealized_gain_loss,
              stress_up_5, stress_down_5, stress_up_10, stress_down_10,
              stress_up_20, stress_down_20, worst_case_20_delta
       from public.fx_position_revaluation
       order by currency, position_kind`),
  ]);

  const unpriced = summary.reduce((s, r) => s + r.positionsWithoutRate, 0);
  const netGainLoss = summary.reduce((s, r) => s + (r.netUnrealizedGainLoss ?? 0), 0);
  const worstCase = summary.reduce((s, r) => s + (r.worstCase20Delta ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Kur Riski"
        subtitle="Pozisyonlar, değerleme ve ±%5/10/20 stres testleri"
        meta={<Badge tone={unpriced > 0 ? "amber" : "green"} dot>
          {unpriced > 0 ? `${unpriced} pozisyon kursuz` : "tüm pozisyonlar değerlenmiş"}
        </Badge>}
      />

      {sp.error ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{sp.error}</div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Para birimi" value={summary.length} tone="info" />
        <KeyStat label="Gerçekleşmemiş K/Z" value={fmtTL(netGainLoss)}
          tone={netGainLoss >= 0 ? "pos" : "neg"} />
        {/* Always a loss, in both directions — see worstCaseDelta in fx/rules.ts. */}
        <KeyStat label="En kötü hâl (%20)" value={fmtTL(worstCase)} tone="neg" />
        <KeyStat label="Kuru olmayan pozisyon" value={unpriced} tone={unpriced > 0 ? "warn" : "pos"} />
      </div>

      <Panel title="PARA BİRİMİ BAZINDA MARUZİYET" subtitle="kurlar arası netleştirme YAPILMAZ">
        {summary.length === 0 ? (
          <EmptyState>Kayıtlı kur pozisyonu yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Kur</th><th className="text-right">Net pozisyon</th>
                  <th className="text-right">TL karşılığı</th><th className="text-right">K/Z</th>
                  <th className="text-right">En kötü %20</th><th>Kur tarihi</th><th>Eksik</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.currency} className="border-t border-neutral-800">
                    <td className="py-2">{s.currency}
                      <span className="block text-xs text-neutral-600">{s.positionCount} pozisyon</span>
                    </td>
                    <td className="text-right tabular-nums">{s.netAmountFx?.toLocaleString("tr-TR") ?? "—"}</td>
                    <td className="text-right tabular-nums">{s.netValueTry == null ? "—" : fmtTL(s.netValueTry)}</td>
                    <td className={`text-right tabular-nums ${(s.netUnrealizedGainLoss ?? 0) < 0 ? "text-red-400" : ""}`}>
                      {s.netUnrealizedGainLoss == null ? "—" : fmtTL(s.netUnrealizedGainLoss)}
                    </td>
                    <td className="text-right tabular-nums text-red-400">
                      {s.worstCase20Delta == null ? "—" : fmtTL(s.worstCase20Delta)}
                    </td>
                    <td className="text-xs tabular-nums">{s.rateDate ?? "—"}</td>
                    {/* A summary resting on missing rates must say so rather than look complete. */}
                    <td className="text-xs">
                      {s.positionsWithoutRate > 0
                        ? <span className="text-amber-400">{s.positionsWithoutRate} kursuz</span>
                        : s.positionsWithoutEntryRate > 0
                          ? <span className="text-neutral-500">{s.positionsWithoutEntryRate} giriş kursuz</span>
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="POZİSYON DEĞERLEME VE STRES" subtitle={`bantlar: ±%${STRESS_BANDS.join(" / ±%")}`}>
        {positions.rows.length === 0 ? (
          <EmptyState>Değerlenecek pozisyon yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Kur / tür</th><th className="text-right">Tutar</th>
                  <th className="text-right">Giriş kuru</th><th className="text-right">Güncel kur</th>
                  <th className="text-right">K/Z</th>
                  <th className="text-right">−%10</th><th className="text-right">+%10</th>
                  <th className="text-right">−%20</th><th className="text-right">+%20</th>
                </tr>
              </thead>
              <tbody>
                {positions.rows.map((p) => (
                  <tr key={p.position_id} className="border-t border-neutral-800">
                    <td className="py-2">{p.currency}
                      <span className="block text-xs text-neutral-600">{p.position_kind}</span>
                    </td>
                    <td className="text-right tabular-nums">{Number(p.amount_fx).toLocaleString("tr-TR")}</td>
                    <td className="text-right tabular-nums text-xs">
                      {p.entry_rate == null
                        ? <span className="text-amber-400">yok</span>
                        : Number(p.entry_rate).toFixed(4)}
                    </td>
                    <td className="text-right tabular-nums text-xs">
                      {p.current_rate == null ? "—" : Number(p.current_rate).toFixed(4)}
                    </td>
                    {/* NULL, not zero, when either rate is unknown: we cannot know the gain. */}
                    <td className={`text-right tabular-nums ${Number(p.unrealized_gain_loss ?? 0) < 0 ? "text-red-400" : ""}`}>
                      {p.unrealized_gain_loss == null ? "—" : fmtTL(Number(p.unrealized_gain_loss))}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {p.stress_down_10 == null ? "—" : fmtTL(Number(p.stress_down_10))}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {p.stress_up_10 == null ? "—" : fmtTL(Number(p.stress_up_10))}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {p.stress_down_20 == null ? "—" : fmtTL(Number(p.stress_down_20))}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {p.stress_up_20 == null ? "—" : fmtTL(Number(p.stress_up_20))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="SON KURLAR" subtitle="TCMB bülteni elle/talep üzerine kaydedilir — canlı akış yok">
        <form action={recordRateAction} className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Para birimi</span>
            <input required name="baseCurrency" maxLength={3} placeholder="USD"
              className="field-control px-2 py-1.5 text-xs uppercase" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Tarih</span>
            <input required type="date" name="rateDate" className="field-control px-2 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kur</span>
            <input required type="number" step="0.0001" min="0" name="rate"
              className="field-control px-2 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kaynak</span>
            <select name="source" defaultValue="manual" className="field-control px-2 py-1.5 text-xs">
              <option value="manual">manuel</option>
              <option value="tcmb">TCMB</option>
              <option value="bank">banka</option>
              <option value="other">diğer</option>
            </select>
          </label>
          <div className="flex items-end">
            <button className="button-ghost px-3 py-1.5 text-xs">Kuru kaydet</button>
          </div>
        </form>

        {rates.length === 0 ? (
          <EmptyState>Kayıtlı kur yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Parite</th><th className="text-right">Kur</th>
                  <th>Tarih</th><th>Kaynak</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={`${r.baseCurrency}-${r.quoteCurrency}`} className="border-t border-neutral-800">
                    <td className="py-2">{r.baseCurrency}/{r.quoteCurrency}</td>
                    <td className="text-right tabular-nums">{r.rate?.toFixed(4) ?? "—"}</td>
                    <td className="text-xs tabular-nums">{r.rateDate}</td>
                    <td><Badge tone={r.source === "tcmb" ? "green" : "neutral"}>{r.source}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
